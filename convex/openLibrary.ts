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
//   PRH-distributed) materialize under the ANN-built backbone. The
//   publisher is the first listed name that resolves (records often lead
//   with an imprint label: ["SHONEN JUMP", "viz media"]); library rebinds
//   never count; and a Volume gets at most one OpenLibrary leaf per
//   (publisher, format) — another ISBN there is a reprint or duplicate
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
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { errorMessage, USER_AGENT } from "./lib/http";
import { runToContinue } from "./lib/importRuns";
import { candidateSeries, labelsEqual, matchRelease, type ReleaseFact } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  createCanonicalRecords,
  findPublisherByName,
  needsEditionLine,
  recordUnplaced,
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
        "The approved-source registry has no \"openlibrary\" row. Run: npx convex run importSources:seedRegistry '{}'",
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

    const maxLines = args.maxLines ?? DEFAULT_MAX_LINES;
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > DEFAULT_MAX_LINES) {
      throw new Error(`maxLines must be an integer between 1 and ${DEFAULT_MAX_LINES}`);
    }
    const runId = await runToContinue(ctx, source, args);
    if (runId === null) return { skipped: "disabled" as const };
    const startLine = args.startLine ?? 0;
    const errors = [...(args.errors ?? [])];
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;

    try {
      const res = await fetch(dumpUrl, {
        headers: { "User-Agent": USER_AGENT },
      });
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
        // 0-based, like startLine/nextLine: an error's line number is the
        // startLine an operator passes to reprocess it.
        const index = lineNo++;
        if (index < startLine) return;
        processed++;
        try {
          const snapshot = parseDumpLine(line);
          if (!snapshot) return;
          seen++;
          const result = await ctx.runMutation(internal.openLibrary.applyEdition, {
            snapshot,
          });
          if (result.changed) changed++;
        } catch (e) {
          errors.push(`dump line ${index}: ${errorMessage(e)}`);
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
        status: errors.length > 0 ? "failed" : "succeeded",
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
        failed: errors.length > 0 ? true : undefined,
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

// Library rebinders (Turtleback, Perfection Learning, …) re-issue a
// publisher's book under their own ISBN.
const REBINDER =
  /^(?:turtleback|perfection learning|selbite|paw prints|demco|topeka bindery|san val|bound to stay bound|findaway|library binding)\b/i;

/** An active Release of this format under the Volume from this publisher. */
async function sameFormatRelease(
  ctx: MutationCtx,
  volumeId: Id<"volumes">,
  publisherId: Id<"publishers">,
  format: "physical" | "digital",
): Promise<Doc<"releases"> | null> {
  const coverages = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
    .collect();
  for (const coverage of coverages) {
    const edition = await ctx.db.get(coverage.editionId);
    if (!edition || edition.status !== "active" || edition.publisherId !== publisherId) continue;
    const releases = await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
      .collect();
    const hit = releases.find((r) => r.status === "active" && r.format === format);
    if (hit) return hit;
  }
  return null;
}

type ApplyResult = {
  status: "unchanged" | "filled" | "linked" | "created" | "recordOnly";
  changed: boolean;
  releaseId?: Id<"releases">;
};

/** The fields this source offers on a linked Release, per its authority row. */
/**
 * Why another source that keys its records by ISBN (Yen Press) holds this
 * book out of scope, or null. PRH drops such titles before observing them,
 * and Kodansha keys by slug, so Yen Press is the one to ask.
 */
async function outOfScopeElsewhere(ctx: MutationCtx, isbn13: string): Promise<string | null> {
  const yen = await getObservation(ctx, "yenpress", isbn13);
  const reason = (yen?.snapshot as { outOfScope?: string } | undefined)?.outOfScope;
  return reason !== undefined ? `Yen Press (${reason})` : null;
}

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
    // EXISTING rows only (OpenLibrary never creates publishers). Any listed
    // publisher that resolves counts — records often lead with an imprint
    // label or a distributor (["SHONEN JUMP", "viz media"]) — but a library
    // rebinder's record is another book (its own ISBN), never the
    // publisher's edition.
    if (snapshot.publishers.some((name) => REBINDER.test(name))) {
      return { status: "recordOnly", changed: false };
    }
    let publisher: Doc<"publishers"> | null = null;
    for (const name of snapshot.publishers) {
      publisher = await findPublisherByName(ctx, name);
      if (publisher) break;
    }
    // Packaging (omnibus, deluxe, box sets) matches by ISBN only — an
    // Omnibus 4 is never Volume 4.
    const packaged = snapshot.multiVolume || snapshot.packaging !== undefined;
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: packaged ? null : (snapshot.volumeLabel ?? null),
      multiVolume: packaged,
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
    if (publisher === null || packaged || needsEditionLine(snapshot.title)) {
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
      (vol) => vol.status === "active" && labelsEqual(vol.label, snapshot.volumeLabel ?? null),
    );
    if (!volume) return { status: "recordOnly", changed: false };

    // One OpenLibrary leaf per (Volume, publisher, format): the ladder
    // already linked a same-format sibling without an ISBN, so one found
    // here carries ANOTHER ISBN — a reprint, a library binding, or an OL
    // duplicate. Never a second Release; the record stays on its
    // observation.
    const sibling = await sameFormatRelease(ctx, volume._id, publisher._id, snapshot.format);
    if (sibling) {
      await recordUnplaced(
        ctx,
        observation,
        `Volume ${volume.label ?? "(unlabeled)"} already has a ${snapshot.format} ${publisher.name} Release (ISBN ${sibling.isbn13 ?? "none"}).`,
        now,
      );
      return { status: "recordOnly", changed: false };
    }

    // A publisher feed that knows this ISBN outranks OpenLibrary's scope
    // guess: Yen Press records its light novels and audio (by ISBN) as out of
    // scope, and OpenLibrary titles rarely say "light novel".
    const scopedOut =
      snapshot.isbn13 !== undefined ? await outOfScopeElsewhere(ctx, snapshot.isbn13) : null;
    if (scopedOut) {
      await recordUnplaced(ctx, observation, `Out of scope per ${scopedOut}.`, now);
      return { status: "recordOnly", changed: false };
    }

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
        pubDate: snapshot.publishDate ? toPartialDate(snapshot.publishDate) : undefined,
        publisher: { name: publisher.name, slug: publisher.slug },
      },
      tagBootstrapUnreviewed: false,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };
  },
});
