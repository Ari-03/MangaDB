// The OpenLibrary adapter (spec §6/§7): the monthly bulk-dump
// pass — seeding stage ④ and the steady-state ISBN fill. OpenLibrary's flat
// records only match *into* the existing skeleton and never define Series
// structure:
//
// - a matched record (stored link, ISBN, or the full publisher+title+label+
//   format key) reconciles in what the authority table allows — ISBN fill
//   at standard rank, dates at weak, format/binding at standard, and the
//   edition's description blurb at weak (fills a blank; publisher text outranks it)
// - an unmatched record may create at most a LEAF: a Release (+ its Edition
//   packaging) under a Series, Volume, and Publisher that all already exist
//   — how VIZ releases (whose site is never scraped and who is not
//   PRH-distributed) materialize under the ANN-built backbone. The
//   publisher is the first listed name that resolves (records often lead
//   with an imprint label: ["SHONEN JUMP", "viz media"]); library rebinds
//   never count; and a Volume gets at most one OpenLibrary leaf per
//   (publisher, format) — another ISBN there is a reprint or duplicate
// - it never creates a Series, Volume, or Publisher, and never queues a
//   match or creation review — OpenLibrary is crowd-sourced and
//   weak-titled, so an ambiguous or structure-shaped record is simply
//   recorded on its observation and waits for stronger sources. Its blurb
//   never queues against weak text another record wrote (ANN's, another
//   edition's) either: the first text stays (lib/authority.ts)
// - no withdrawal pass: the streamed file is an operator-filtered slice of
//   the dump, so absence from it is never evidence
//
// The raw editions dump is ~10 GB; scripts/filter-openlibrary-dump.mjs
// narrows it offline to manga-relevant publishers, and the operator hosts
// the filtered file at OPENLIBRARY_DUMP_URL (see README). The sync action
// streams it line by line and self-continues across Convex's action time
// budget, carrying the Import Run.
//
// `replayDescriptions` re-applies stored editions, with no network: an
// edition observed before its Release existed (ANN created most VIZ books
// later) stayed unlinked, so its description never reached the Release.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { errorMessage, USER_AGENT } from "./lib/http";
import { applyRetrying } from "./lib/occ";
import { runToContinue } from "./lib/importRuns";
import { resolveBaseSeries } from "./lib/catalogTitle";
import { isbnHolders, labelsEqual, matchRelease, type ReleaseFact } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  createCanonicalRecords,
  findPublisherByName,
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  needsEditionLine,
  recordUnplaced,
  rewriteOwnDescription,
  toPartialDate,
} from "./lib/pipeline";
import {
  cleanOlDescription,
  olEditionValidator,
  parseDumpLine,
  type OlEditionSnapshot,
} from "./lib/openLibrary";
import { reconcileFields } from "./lib/reconcile";
import { withExceptionCapture } from "./lib/posthog";

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
    // ----- continuation state (never passed by callers) -----
    startLine: v.optional(v.number()),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("openLibrary.sync", ctx, async () => {
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
            const result = await applyRetrying(ctx, internal.openLibrary.applyEdition, {
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

        if (!done) {
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
    }),
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

/** The fields this source offers on a linked Release, per its authority row. */
function offeredReleaseFields(snapshot: OlEditionSnapshot): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  if (snapshot.isbn13 !== undefined) offered.isbn13 = snapshot.isbn13;
  if (snapshot.isbn10 !== undefined) offered.isbn10 = snapshot.isbn10;
  if (snapshot.publishDate) offered.pubDate = toPartialDate(snapshot.publishDate);
  if (snapshot.binding !== undefined) offered.binding = snapshot.binding;
  if (snapshot.description !== undefined) offered.description = snapshot.description;
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
      // An ISBN another Release holds is that book's: none of the record's
      // facts are filled onto this link; the pair stays on the observation.
      if (await isbnHeldElsewhere(ctx, observation, release, snapshot.isbn13, now)) {
        return { status: "recordOnly", changed: false, releaseId: release._id };
      }
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
    // Omnibus 4 is never Volume 4. A bare trailing number or roman numeral
    // resolves against the existing Series first, exactly as the catalog
    // feeds do ("Chainsaw Man 22" → Chainsaw Man Vol. 22 only when that
    // Series exists and no "Chainsaw Man 22" does).
    const packaged = snapshot.multiVolume || snapshot.packaging !== undefined;
    const { seriesTitle, volumeLabel, candidates } = await resolveBaseSeries(ctx, snapshot);
    const fact: ReleaseFact = {
      seriesTitle,
      volumeLabel: packaged ? null : volumeLabel,
      multiVolume: packaged,
      format: snapshot.format,
      binding: snapshot.binding,
      language: IMPORT_LANGUAGE,
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
    if (candidates.length !== 1) return { status: "recordOnly", changed: false };
    const series = candidates[0]!;
    if (series.locked) return { status: "recordOnly", changed: false };
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    const volume = volumes.find(
      (vol) => vol.status === "active" && labelsEqual(vol.label, volumeLabel),
    );
    if (!volume) return { status: "recordOnly", changed: false };

    // One OpenLibrary leaf per (Volume, publisher, format): the ladder
    // already linked a same-format sibling without an ISBN unless its known
    // Binding differs, so one found here carries ANOTHER ISBN or Binding — a
    // reprint, a library binding, a hardcover, or an OL duplicate. Never a
    // second Release; the record stays on its observation.
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
      seriesTitle,
      labels: volumeLabel !== null ? [volumeLabel] : [],
      release: {
        format: snapshot.format,
        binding: snapshot.binding,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        pubDate: snapshot.publishDate ? toPartialDate(snapshot.publishDate) : undefined,
        description: snapshot.description,
        publisher: { name: publisher.name, slug: publisher.slug },
      },
      tagBootstrapUnreviewed: false,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };
  },
});

// ---------- the description replay ----------

/** OpenLibrary observations scanned per lookup. */
const REPLAY_SCAN = 200;
/** Editions handed to the action per lookup. */
const REPLAY_BATCH = 25;
/** Work per action before it continues in a fresh one (actions run ≤10 min). */
const REPLAY_BUDGET_MS = 5 * 60 * 1000;

/** The matcher's own note on an edition its ISBN rung declined (applyEdition). */
const ISBN_RUNG_DECLINED = "unmatched (rung 2):";

/**
 * Up to REPLAY_BATCH stored snapshots after `after`, by edition key, that
 * are unlinked, carry a description, and carry an ISBN some active Release
 * (merged rows answered by their survivor) holds — and where to look next
 * (null once exhausted). The ISBN condition keeps the replay to its
 * purpose: applyEdition's rung ② then links or flags that Release and never
 * reaches the rung-⑤ leaf creation. An edition whose latest apply already
 * declined that ISBN (`match` note: shared ISBN, dissimilar title, hidden
 * Release) is skipped: replaying it would decline again.
 */
export const unlinkedDescribedEditions = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        after === null
          ? q.eq("sourceKey", SOURCE_KEY)
          : q.eq("sourceKey", SOURCE_KEY).gt("sourceRecordId", after),
      )
      .take(REPLAY_SCAN);
    const snapshots: OlEditionSnapshot[] = [];
    let next: string | null = null;
    for (const doc of docs) {
      next = doc.sourceRecordId;
      if (doc.recordRef !== undefined) continue;
      const snapshot = doc.snapshot as OlEditionSnapshot;
      if (snapshot.description === undefined || snapshot.isbn13 === undefined) continue;
      const declined = doc.conflicts?.some(
        (c) => c.field === "match" && c.reason.startsWith(ISBN_RUNG_DECLINED),
      );
      if (declined) continue;
      const resolved = await isbnHolders(ctx, snapshot.isbn13);
      if (!resolved.some((release) => release?.status === "active")) continue;
      snapshots.push(snapshot);
      if (snapshots.length === REPLAY_BATCH) break;
    }
    const exhausted = docs.length < REPLAY_SCAN && next === docs.at(-1)?.sourceRecordId;
    return { snapshots, next: exhausted ? null : next };
  },
});

type ReplayResult = {
  /** Editions replayed so far, across every link of the chain. */
  replayed: number;
  /** Replays that linked their edition to a Release. */
  linked: number;
  /** This link's failures (a stored snapshot the validator now rejects, …). */
  errors: string[];
  continued: boolean;
};

/**
 * Replay stored, unlinked OpenLibrary editions that carry a description
 * through `applyEdition`, exactly as the next dump pass would apply them,
 * but without the dump: the matching ladder links each to the Release that
 * now holds its ISBN and fills at OpenLibrary's weak rank (a blank
 * description fills; existing text, any source's or a human's, stays, and
 * text ANN wrote first is never queued against). No
 * new write path: only editions whose ISBN an active Release holds are
 * replayed (`unlinkedDescribedEditions`), so nothing is created. One
 * mutation per edition; `limit` caps the editions replayed in total.
 * Continues itself until done (the budget is checked while scanning too,
 * since most observations do not qualify); safe to rerun. An edition the
 * matcher declines (a shared ISBN, a dissimilar title) stays unlinked with
 * its `match` note, and a rerun skips it rather than replaying it again;
 * each replay bumps the observation's `lastSeenAt`, as a dump pass would.
 * The monthly dump pass still retries declined editions. An explicit
 * operator command: it runs whatever the source's enabled flag says and
 * opens no Import Run.
 *
 *   npx convex run openLibrary:replayDescriptions '{"limit": 500}'
 */
export const replayDescriptions = internalAction({
  args: {
    limit: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    replayed: v.optional(v.number()),
    linked: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ReplayResult> => {
    const started = Date.now();
    const limit = args.limit ?? Number.POSITIVE_INFINITY;
    let replayed = args.replayed ?? 0;
    let linked = args.linked ?? 0;
    const errors: string[] = [];
    // `cursor` trails the last edition handled, so a continuation resumes
    // right after it.
    let cursor: string | null = args.after ?? null;
    let scanned = false;
    const outOfTime = () => Date.now() - started > REPLAY_BUDGET_MS;
    const handOff = async (): Promise<ReplayResult> => {
      await ctx.scheduler.runAfter(0, internal.openLibrary.replayDescriptions, {
        limit: args.limit,
        after: cursor ?? undefined,
        replayed,
        linked,
      });
      return { replayed, linked, errors, continued: true };
    };
    while (replayed < limit) {
      // A long scan finding nothing hands off too: each lookup advances the
      // cursor, so every link makes progress.
      if (scanned && outOfTime()) return await handOff();
      scanned = true;
      const batch: { snapshots: OlEditionSnapshot[]; next: string | null } = await ctx.runQuery(
        internal.openLibrary.unlinkedDescribedEditions,
        { after: cursor },
      );
      for (const snapshot of batch.snapshots) {
        if (replayed >= limit) break;
        // Every link replays at least one edition before it may hand off.
        if (replayed > (args.replayed ?? 0) && outOfTime()) return await handOff();
        replayed++;
        try {
          const result = await applyRetrying(ctx, internal.openLibrary.applyEdition, { snapshot });
          if (result.status === "linked") linked++;
        } catch (e) {
          errors.push(`${snapshot.key}: ${errorMessage(e)}`);
        }
        cursor = snapshot.key;
      }
      if (batch.next === null) break;
      cursor = batch.next;
    }
    return { replayed, linked, errors, continued: false };
  },
});

// ---------- the description repair ----------

/** OpenLibrary observations scanned per repair lookup. */
const REPAIR_SCAN = 100;
/** Failed observations whose message a repair link logs (the count is complete). */
const REPAIR_ERROR_SAMPLES = 20;

const repairCounts = v.object({
  scanned: v.number(),
  snapshotFixed: v.number(),
  releaseUpdated: v.number(),
  releaseCleared: v.number(),
  errors: v.number(),
});
type RepairCounts = typeof repairCounts.type;

/** Text `cleanOlDescription` would change (a non-string is listed so it fails loudly). */
function stale(text: unknown): boolean {
  return text !== undefined && (typeof text !== "string" || cleanOlDescription(text) !== text);
}

/**
 * Up to REPAIR_SCAN OpenLibrary observations after `after` and the ones
 * with work: a stored description the cleaner would change, or a linked
 * Release whose current text it would change (the mutation decides whose
 * text that is). Where to look next is null once exhausted.
 */
export const repairCandidates = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        after === null
          ? q.eq("sourceKey", SOURCE_KEY)
          : q.eq("sourceKey", SOURCE_KEY).gt("sourceRecordId", after),
      )
      .take(REPAIR_SCAN);
    const ids: Id<"sourceObservations">[] = [];
    for (const doc of docs) {
      const snapshot = doc.snapshot as Partial<OlEditionSnapshot> | null;
      const release = doc.recordRef?.type === "release" ? await ctx.db.get(doc.recordRef.id) : null;
      if (stale(snapshot?.description) || stale(release?.description)) ids.push(doc._id);
    }
    const last = docs.at(-1);
    return {
      ids,
      scanned: docs.length,
      next: docs.length < REPAIR_SCAN || !last ? null : last.sourceRecordId,
    };
  },
});

/**
 * Repair one OpenLibrary observation: its stored description re-cleaned
 * (`cleanOlDescription`; patched in place, no history row), and its linked
 * Release's text replaced or cleared when OpenLibrary wrote that text from
 * this edition (`rewriteOwnDescription`: no Human Override, no lock, never
 * anyone else's text).
 */
export const repairDescriptionLine = internalMutation({
  args: { observationId: v.id("sourceObservations") },
  handler: async (
    ctx,
    { observationId },
  ): Promise<{ snapshotFixed: boolean; release: "updated" | "cleared" | null }> => {
    const observation = await ctx.db.get(observationId);
    if (observation === null) return { snapshotFixed: false, release: null };
    const snapshot = observation.snapshot as OlEditionSnapshot;
    let snapshotFixed = false;
    if (stale(snapshot.description)) {
      const fixed = cleanOlDescription(snapshot.description!);
      const { description: _, ...rest } = snapshot;
      await ctx.db.patch(observation._id, {
        snapshot: fixed === undefined ? rest : { ...rest, description: fixed },
      });
      snapshotFixed = true;
    }
    if (observation.recordRef?.type !== "release") return { snapshotFixed, release: null };
    const release = await ctx.db.get(observation.recordRef.id);
    if (release === null || typeof release.description !== "string" || !stale(release.description)) {
      return { snapshotFixed, release: null };
    }
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const rewritten = await rewriteOwnDescription(ctx, {
      sourceKey: SOURCE_KEY,
      observation,
      release,
      text: cleanOlDescription(release.description),
      citation: { sourceName: source?.name ?? "OpenLibrary", url: snapshot.url },
      now: Date.now(),
    });
    return { snapshotFixed, release: rewritten };
  },
});

/**
 * Re-clean every stored OpenLibrary description with today's
 * `cleanOlDescription` (a physical description is no blurb; a trailing
 * "--P. [4] of cover." citation goes) and fix the Releases still showing
 * OpenLibrary's text (`repairDescriptionLine`). No network. A small
 * action of its own rather than a mode of `ann:repairDescriptions`: the
 * two walk different observations with different cleaners and share only
 * the guarded write (`rewriteOwnDescription`). Each observation is its own
 * mutation: one that fails is counted and logged and the walk goes on.
 * Safe to rerun; continues itself across the action time limit and logs
 * its counts at every hand-off and at the end. An operator command: it
 * runs whatever the source's enabled flag says and opens no Import Run.
 *
 *   npx convex run openLibrary:repairDescriptions '{}'
 */
export const repairDescriptions = internalAction({
  args: {
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    counts: v.optional(repairCounts),
  },
  handler: async (ctx, args): Promise<RepairCounts & { continued: boolean }> => {
    const started = Date.now();
    const counts: RepairCounts = args.counts ?? {
      scanned: 0,
      snapshotFixed: 0,
      releaseUpdated: 0,
      releaseCleared: 0,
      errors: 0,
    };
    let logged = 0;
    let cursor: string | null = args.after ?? null;
    for (;;) {
      const batch: { ids: Id<"sourceObservations">[]; scanned: number; next: string | null } =
        await ctx.runQuery(internal.openLibrary.repairCandidates, { after: cursor });
      counts.scanned += batch.scanned;
      for (const observationId of batch.ids) {
        try {
          const done = await applyRetrying(ctx, internal.openLibrary.repairDescriptionLine, {
            observationId,
          });
          if (done.snapshotFixed) counts.snapshotFixed++;
          if (done.release === "updated") counts.releaseUpdated++;
          if (done.release === "cleared") counts.releaseCleared++;
        } catch (e) {
          counts.errors++;
          if (logged++ < REPAIR_ERROR_SAMPLES) {
            console.error(`[openLibrary.repairDescriptions] observation ${observationId}: ${errorMessage(e)}`);
          }
        }
      }
      cursor = batch.next;
      if (cursor === null) {
        console.log(`[openLibrary.repairDescriptions] done: ${JSON.stringify(counts)}`);
        return { ...counts, continued: false };
      }
      if (Date.now() - started > REPLAY_BUDGET_MS) {
        await ctx.scheduler.runAfter(0, internal.openLibrary.repairDescriptions, { after: cursor, counts });
        console.log(`[openLibrary.repairDescriptions] continuing after ${cursor}: ${JSON.stringify(counts)}`);
        return { ...counts, continued: true };
      }
    }
  },
});
