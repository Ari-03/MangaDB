// The OpenLibrary adapter (ticket #36, spec §6/§7): the monthly bulk-dump
// pass — seeding stage ④ and the steady-state ISBN fill. OpenLibrary's flat
// records only match *into* the existing skeleton and never define Series
// structure:
//
// - a matched record (stored link, ISBN, or the full publisher+title+label+
//   format key) reconciles in what the authority table allows — ISBN fill
//   at standard rank, dates at weak, format/binding at standard
// - an unmatched record may create at most a LEAF: a Release (+ its Edition
//   packaging) under a Series, Volume, and Publisher that all already exist
//   — how VIZ releases (whose site is never scraped and who is not
//   PRH-distributed) materialize under the ANN-built backbone
// - it never creates a Series, Volume, or Publisher, and never queues
//   review proposals — OpenLibrary is crowd-sourced and weak-titled, so an
//   ambiguous or structure-shaped record is simply recorded on its
//   observation and waits for stronger sources
// - no withdrawal pass: the streamed file is an operator-filtered slice of
//   the dump, so absence from it is never evidence
//
// The raw editions dump is ~10 GB; scripts/filter-openlibrary-dump.mjs
// narrows it offline to manga-relevant publishers, and the operator hosts
// the filtered file at OPENLIBRARY_DUMP_URL (see README). The sync action
// streams it line by line and self-continues across Convex's action time
// budget, carrying the Import Run.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { errorMessage, USER_AGENT } from "./lib/http";
import { candidateSeries, labelsEqual, matchRelease, type ReleaseFact } from "./lib/matching";
import { upsertObservation } from "./lib/observations";
import {
  createCanonicalRecords,
  findPublisherByName,
  needsEditionLine,
  toPartialDate,
} from "./lib/pipeline";
import { olEditionValidator, parseDumpLine, type OlEditionSnapshot } from "./lib/openLibrary";
import { reconcileFields } from "./lib/reconcile";

export const SOURCE_KEY = "openlibrary";
const IMPORT_COMMENT = "Imported from OpenLibrary (CC0).";

/** Lines per invocation before scheduling a continuation. */
const DEFAULT_MAX_LINES = 20000;

// ---------- the sync action ----------

type SyncResult =
  | { skipped: "disabled" | "unconfigured" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      /** True when this link scheduled a continuation instead of finishing. */
      continued: boolean;
      nextLine?: number;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One link of a dump pass. Called with no args by the monthly cadence tick
 * (requires OPENLIBRARY_DUMP_URL); continuation links carry the run state.
 *
 *   npx convex run openLibrary:sync '{"dumpUrl":"https://…/filtered.txt"}'
 */
export const sync = internalAction({
  args: {
    /** The filtered dump's URL; defaults to env OPENLIBRARY_DUMP_URL. */
    dumpUrl: v.optional(v.string()),
    /** Dump lines to process per invocation before continuing. */
    maxLines: v.optional(v.number()),
    /** Never schedule a continuation (tests and bounded manual runs). */
    noContinue: v.optional(v.boolean()),
    // ----- continuation state (never passed by callers) -----
    startLine: v.optional(v.number()),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        'The approved-source registry has no "openlibrary" row. Run: npx convex run importSources:seedRegistry \'{}\'',
      );
    }
    if (!source.enabled && args.runId === undefined) {
      return { skipped: "disabled" as const };
    }
    const dumpUrl = args.dumpUrl ?? process.env.OPENLIBRARY_DUMP_URL;
    if (!dumpUrl) {
      console.warn(
        "[imports] OpenLibrary adapter is unconfigured (set OPENLIBRARY_DUMP_URL to the filtered dump) — skipping",
      );
      return { skipped: "unconfigured" as const };
    }

    const runId: Id<"importRuns"> =
      args.runId ??
      (await ctx.runMutation(internal.imports.startRun, {
        sourceKey: SOURCE_KEY,
      }));
    const startLine = args.startLine ?? 0;
    const maxLines = args.maxLines ?? DEFAULT_MAX_LINES;
    const errors = [...(args.errors ?? [])];
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;

    try {
      const res = await fetch(dumpUrl, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for the dump at ${dumpUrl}`);
      }
      // Transparent gzip support where the runtime provides it.
      let stream: ReadableStream<Uint8Array> = res.body;
      if (/\.gz($|\?)/.test(dumpUrl) && typeof DecompressionStream !== "undefined") {
        stream = stream.pipeThrough(
          new DecompressionStream("gzip") as unknown as ReadableWritablePair<
            Uint8Array,
            Uint8Array
          >,
        );
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lineNo = 0;
      let processed = 0;
      let done = false;

      const handleLine = async (line: string) => {
        const isTarget = lineNo >= startLine;
        lineNo++;
        if (!isTarget) return;
        processed++;
        const snapshot = parseDumpLine(line);
        if (!snapshot) return;
        seen++;
        try {
          const result = await ctx.runMutation(internal.openLibrary.applyEdition, {
            snapshot,
          });
          if (result.changed) changed++;
        } catch (e) {
          errors.push(`edition ${snapshot.key}: ${errorMessage(e)}`);
        }
      };

      while (!done && processed < maxLines) {
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          if (buffer.trim() !== "") await handleLine(buffer);
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && processed < maxLines) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() !== "") await handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      await reader.cancel().catch(() => undefined);

      if (!done && args.noContinue !== true) {
        await ctx.scheduler.runAfter(0, internal.openLibrary.sync, {
          dumpUrl,
          maxLines: args.maxLines,
          startLine: startLine + processed,
          runId,
          seen,
          changed,
          errors: errors.slice(0, 50),
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          continued: true,
          nextLine: startLine + processed,
          errorCount: errors.length,
        };
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        continued: false,
        nextLine: done ? undefined : startLine + processed,
        errorCount: errors.length,
      };
    } catch (e) {
      errors.push(errorMessage(e));
      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "failed",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        continued: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one edition ----------

type ApplyResult = {
  status: "unchanged" | "filled" | "linked" | "created" | "recordOnly";
  changed: boolean;
  releaseId?: Id<"releases">;
};

/** The fields this source offers on a linked Release, per its authority row. */
function offeredReleaseFields(snapshot: OlEditionSnapshot): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  if (snapshot.isbn13 !== undefined) offered.isbn13 = snapshot.isbn13;
  if (snapshot.isbn10 !== undefined) offered.isbn10 = snapshot.isbn10;
  if (snapshot.publishDate) offered.pubDate = toPartialDate(snapshot.publishDate);
  if (snapshot.binding !== undefined) offered.binding = snapshot.binding;
  return offered;
}

/**
 * Reconcile one OpenLibrary edition into the catalog. Match → fill; no
 * match → at most a leaf Release under fully pre-existing structure; never
 * a queue item, never new structure. One atomic mutation per record.
 */
export const applyEdition = internalMutation({
  args: { snapshot: olEditionValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const citation = {
      sourceName: source?.name ?? "OpenLibrary",
      url: snapshot.url,
    };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: snapshot.key,
      snapshot,
      now,
    });

    // Rung ①: stored source-id link.
    if (observation.recordRef?.type === "release") {
      const release = await ctx.db.get(observation.recordRef.id);
      if (!release || release.status !== "active" || release.locked) {
        return { status: "recordOnly", changed: false };
      }
      if (!changed) return { status: "unchanged", changed: false };
      const result = await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return {
        status: result.changed ? "filled" : "recordOnly",
        changed: result.changed,
        releaseId: release._id,
      };
    }

    // Rungs ②–④ via the shared ladder; the publisher key resolves against
    // EXISTING rows only (OpenLibrary never creates publishers).
    const publisher =
      snapshot.publishers[0] !== undefined
        ? await findPublisherByName(ctx, snapshot.publishers[0])
        : null;
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: snapshot.multiVolume ? null : (snapshot.volumeLabel ?? null),
      multiVolume: snapshot.multiVolume,
      format: snapshot.format,
      isbn13: snapshot.isbn13,
      publisherId: publisher?._id ?? null,
    };
    const match = await matchRelease(ctx, fact);

    if (match.kind === "match") {
      const release = match.release;
      await ctx.db.patch(observation._id, {
        recordRef: { type: "release", id: release._id },
      });
      await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return { status: "linked", changed: true, releaseId: release._id };
    }

    if (match.kind === "review") {
      // A flat crowd-sourced record is never worth a human's review slot on
      // its own; the ambiguity stays on the observation for the record.
      await ctx.db.patch(observation._id, {
        conflicts: [
          {
            field: "match",
            offered: snapshot.title,
            at: now,
            reason: `unmatched (rung ${match.rung}): ${match.reason}`,
          },
        ],
      });
      return { status: "recordOnly", changed: false };
    }

    // Rung ⑤ — the leaf-creation boundary: a single-volume Release whose
    // Series (unique title match), Volume (exact label), and Publisher all
    // already exist, with no Edition-Line shape. Anything else would define
    // structure, which OpenLibrary never does.
    if (
      publisher === null ||
      snapshot.multiVolume ||
      needsEditionLine(snapshot.title)
    ) {
      return { status: "recordOnly", changed: false };
    }
    const candidates = await candidateSeries(ctx, snapshot.seriesTitle);
    if (candidates.length !== 1) return { status: "recordOnly", changed: false };
    const series = candidates[0]!;
    if (series.locked) return { status: "recordOnly", changed: false };
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    const volume = volumes.find(
      (vol) =>
        vol.status === "active" &&
        labelsEqual(vol.label, snapshot.volumeLabel ?? null),
    );
    if (!volume) return { status: "recordOnly", changed: false };

    const creation = await createCanonicalRecords(ctx, {
      sourceKey: SOURCE_KEY,
      observation,
      citation,
      importComment: IMPORT_COMMENT,
      seriesId: series._id,
      seriesTitle: snapshot.seriesTitle,
      labels: snapshot.volumeLabel !== undefined ? [snapshot.volumeLabel] : [],
      release: {
        format: snapshot.format,
        binding: snapshot.binding,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        pubDate: snapshot.publishDate
          ? toPartialDate(snapshot.publishDate)
          : undefined,
        publisher: { name: publisher.name, slug: publisher.slug },
      },
      tagBootstrapUnreviewed: false,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };
  },
});
