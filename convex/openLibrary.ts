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
//   weak-titled, so an ambiguous or structure-shaped record stays on its
//   observation and waits for stronger sources. One a person could place
//   (a known publisher, and an active Series of its title or one an Editor
//   hid) is a Held Book; the rest are recorded nowhere (placeEdition). Its
//   blurb never queues against weak text another record wrote (ANN's,
//   another edition's) either: the first text stays (lib/authority.ts)
// - no withdrawal pass: the streamed file is an operator-filtered slice of
//   the dump, so absence from it is never evidence
//
// The raw editions dump is ~10 GB; scripts/filter-openlibrary-dump.mjs
// narrows it offline to manga-relevant publishers, and the operator hosts
// the filtered file at OPENLIBRARY_DUMP_URL (docs/imports.md). The sync action
// streams it line by line and hands off to a continuation after
// LINK_BUDGET_MS or maxLines lines, whichever comes first, carrying the
// Import Run.
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
  type QueryCtx,
} from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { errorMessage, USER_AGENT } from "./lib/http";
import { applyRetrying } from "./lib/occ";
import {
  closeRun,
  MAX_CARRIED_ERRORS,
  registryRow,
  runToContinue,
  stampHandOff,
  stopAtGate,
} from "./lib/importRuns";
import { resolveBaseSeries } from "./lib/catalogTitle";
import { coveringOf, releasesOf } from "./lib/editionRows";
import { isbnHolders, labelsEqual, matchRelease, type ReleaseFact } from "./lib/matching";
import {
  clearHold,
  getObservation,
  type Hold,
  linkObservation,
  recordUnplaced,
  upsertObservation,
} from "./lib/observations";
import {
  createCanonicalRecords,
  descriptionRepairWork,
  findPublisherByName,
  hiddenWorkTitled,
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  needsEditionLine,
  recleaned,
  repairCountsValidator,
  repairLinkedDescription,
  runDescriptionRepair,
  REPAIR_SCAN,
  toPartialDate,
  type DescriptionRepair,
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
/**
 * Wall-clock time per link, from its start, before scheduling a
 * continuation; it covers the download of the lines earlier links
 * processed. Checked before each line, so a link overruns it by at most
 * one line's apply (applyRetrying: four tries, about 2.5 s of backoff) and
 * one gate check, leaving 20 of Convex's 30 action minutes spare.
 */
const LINK_BUDGET_MS = 10 * 60 * 1000;
/** Lines between two checks of the import gate inside a link. */
const GATE_LINES = 1000;

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
      stopped?: true;
    };

/**
 * One link of a dump pass. Called with no args by the monthly cadence tick
 * (requires OPENLIBRARY_DUMP_URL); continuation links carry the run state.
 * The import gate (lib/importRuns.ts) is checked at each link and every
 * GATE_LINES lines. A link applies at least one line, then stops before
 * the next once it has run for LINK_BUDGET_MS or processed maxLines lines;
 * a gate stop on that line comes first.
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
    /** Wall-clock budget per link, at most LINK_BUDGET_MS; tests pass 0 to force a hand-off. */
    linkBudgetMs: v.optional(v.number()),
    /** First dump line (0-based) to process: where a continuation resumes, or an operator's reprocess. */
    startLine: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("openLibrary.sync", ctx, async () => {
      const linkStartedAt = Date.now();
      const source = await registryRow(ctx, SOURCE_KEY);
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
      const linkBudgetMs = args.linkBudgetMs ?? LINK_BUDGET_MS;
      if (!(linkBudgetMs >= 0 && linkBudgetMs <= LINK_BUDGET_MS)) {
        throw new Error(`linkBudgetMs must be between 0 and ${LINK_BUDGET_MS}`);
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
        let outOfTime = false;
        let stopped: Awaited<ReturnType<typeof stopAtGate>> = null;

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

        // Every line goes through here, newline-terminated or the dump's
        // unterminated last one, so the gate before each GATE_LINES-th line
        // and the time check before each line apply to both. Returns the
        // gate's stop, with the line unapplied; out of time, the line is
        // left unapplied too, for the continuation.
        const processLine = async (line: string) => {
          if (line.trim() === "") return null;
          if (processed > 0 && processed % GATE_LINES === 0) {
            const stop = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
            if (stop) return stop;
          }
          if (processed > 0 && Date.now() - linkStartedAt >= linkBudgetMs) {
            outOfTime = true;
            return null;
          }
          await handleLine(line);
          return null;
        };

        while (!done && !outOfTime && processed < maxLines && !stopped) {
          const chunk = await reader.read();
          if (chunk.done) {
            stopped = await processLine(buffer);
            done = !outOfTime;
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0 && !outOfTime && processed < maxLines && !stopped) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            stopped = await processLine(line);
            newline = buffer.indexOf("\n");
          }
        }
        await reader.cancel().catch(() => undefined);
        if (stopped) return { ...stopped, continued: false, nextLine: startLine + processed };

        if (!done && args.noContinue !== true) {
          await stampHandOff(ctx, runId, { seen, changed, errors });
          await ctx.scheduler.runAfter(0, internal.openLibrary.sync, {
            dumpUrl,
            maxLines: args.maxLines,
            linkBudgetMs: args.linkBudgetMs,
            startLine: startLine + processed,
            runId,
            seen,
            changed,
            errors: errors.slice(0, MAX_CARRIED_ERRORS),
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

        const status = errors.length > 0 ? "failed" : "succeeded";
        return {
          ...(await closeRun(ctx, runId, status, { seen, changed, errors })),
          continued: false,
          nextLine: done ? undefined : startLine + processed,
        };
      } catch (e) {
        errors.push(errorMessage(e));
        return { ...(await closeRun(ctx, runId, "failed", { seen, changed, errors })), continued: false };
      }
    }),
});

// ---------- applying one edition ----------

// Library rebinders (Turtleback, Perfection Learning, …) re-issue a
// publisher's book under their own ISBN.
export const REBINDER =
  /^(?:turtleback|perfection learning|selbite|paw prints|demco|topeka bindery|san val|bound to stay bound|findaway|library binding)\b/i;

/** An active Release of this format under the Volume from this publisher. */
async function sameFormatRelease(
  ctx: MutationCtx,
  volumeId: Id<"volumes">,
  publisherId: Id<"publishers">,
  format: "physical" | "digital",
): Promise<Doc<"releases"> | null> {
  const coverages = await coveringOf(ctx, volumeId);
  for (const coverage of coverages) {
    const edition = await ctx.db.get(coverage.editionId);
    if (!edition || edition.status !== "active" || edition.publisherId !== publisherId) continue;
    const releases = await releasesOf(ctx, edition._id);
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
export async function outOfScopeElsewhere(ctx: QueryCtx, isbn13: string): Promise<string | null> {
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
 * Where an unlinked edition goes, decided without writing anything, so a
 * stored edition can be classified too (imports.backfillHolds):
 *
 * - `match`: the ladder found its Release (rungs ②–④); applyEdition links it.
 * - `review`: the ladder flagged a book no one could place (an unknown
 *   publisher, no Series match, out of scope elsewhere); the reason stays on
 *   the observation.
 * - `create`: a leaf Release under a Series, Volume and Publisher that all
 *   exist (rung ⑤).
 * - `hold`: a book a person could place, held for the Data Team: a known
 *   Publisher and at least one active Series, but the ladder flagged its
 *   ISBN or the Volume's Release in its format (`isbn`, rungs ②–③) or a
 *   same-titled Series (`series`, rung ④), with the flag in `review` for
 *   the observation; or it names one Series whose Volume does not exist
 *   (`volumeMissing`), its packaging cannot be mapped (`packaging`), the
 *   Series is locked or the title names several (`series`), or the Volume
 *   already has this publisher's Release in its format (`isbn`); or its
 *   title names no active Series but one an Editor hid (`series`).
 * - `skip`: nothing to act on, recorded nowhere: a library rebind, an
 *   unknown publisher, no Series match, an unlabeled edition with no
 *   unlabeled Volume, or a book another source holds out of scope.
 */
export async function placeEdition(
  ctx: MutationCtx,
  snapshot: OlEditionSnapshot,
): Promise<
  | { kind: "match"; release: Doc<"releases"> }
  | { kind: "review"; reason: string }
  | {
      kind: "create";
      series: Doc<"series">;
      seriesTitle: string;
      volumeLabel: string | null;
      publisher: Doc<"publishers">;
    }
  | { kind: "hold"; hold: Hold; review?: string }
  | { kind: "skip" }
> {
  // Rungs ②–④ via the shared ladder; the publisher key resolves against
  // EXISTING rows only (OpenLibrary never creates publishers). Any listed
  // publisher that resolves counts — records often lead with an imprint
  // label or a distributor (["SHONEN JUMP", "viz media"]) — but a library
  // rebinder's record is another book (its own ISBN), never the
  // publisher's edition.
  if (snapshot.publishers.some((name) => REBINDER.test(name))) return { kind: "skip" };
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
  if (match.kind === "match") return { kind: "match", release: match.release };
  // The ladder's flag, and the note it leaves on the observation.
  const flag =
    match.kind === "review"
      ? { rung: match.rung, reason: match.reason, note: `unmatched (rung ${match.rung}): ${match.reason}` }
      : null;

  // Rung ⑤ — the leaf-creation boundary: a single-volume Release whose
  // Series (unique title match), Volume (exact label), and Publisher all
  // already exist, with no Edition-Line shape. Anything else would define
  // structure, which OpenLibrary never does; what a person could place is
  // held, the rest is skipped. A publisher feed that knows this ISBN
  // outranks OpenLibrary's scope guess: Yen Press records its light novels
  // and audio (by ISBN) as out of scope, and OpenLibrary titles rarely say
  // "light novel".
  const outOfScope =
    snapshot.isbn13 !== undefined && (await outOfScopeElsewhere(ctx, snapshot.isbn13)) !== null;
  // A title naming no active Series but one an Editor hid is that work's
  // book: held, as the catalog feeds hold it (removedSeriesFor).
  if (publisher !== null && candidates.length === 0 && flag === null && !outOfScope) {
    const hidden = await hiddenWorkTitled(ctx, seriesTitle, publisher._id);
    if (hidden !== null) return { kind: "hold", hold: { kind: "series", reason: hidden.reason } };
  }
  if (publisher === null || candidates.length === 0 || outOfScope) {
    return flag !== null ? { kind: "review", reason: flag.note } : { kind: "skip" };
  }
  if (flag !== null) {
    return {
      kind: "hold",
      review: flag.note,
      hold: {
        kind: flag.rung === 4 ? "series" : "isbn",
        reason: `${flag.reason.charAt(0).toUpperCase()}${flag.reason.slice(1)}.`,
        ...(candidates.length === 1 ? { seriesId: candidates[0]!._id } : {}),
      },
    };
  }
  if (candidates.length > 1) {
    return {
      kind: "hold",
      hold: {
        kind: "series",
        reason: `"${seriesTitle}" names ${candidates.length} Series (${candidates.map((c) => c.publicId).join(", ")}).`,
      },
    };
  }
  const series = candidates[0]!;
  if (packaged || needsEditionLine(snapshot.title)) {
    return {
      kind: "hold",
      hold: {
        kind: "packaging",
        reason: `"${snapshot.title}" is packaging of Series ${series.publicId} whose covered Volumes Open Library cannot state — an Editor maps it.`,
        seriesId: series._id,
      },
    };
  }
  if (series.locked) {
    return {
      kind: "hold",
      hold: { kind: "series", reason: `Series ${series.publicId} is locked.`, seriesId: series._id },
    };
  }
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", series._id))
    .collect();
  const volume = volumes.find(
    (vol) => vol.status === "active" && labelsEqual(vol.label, volumeLabel),
  );
  if (!volume) {
    if (volumeLabel === null) return { kind: "skip" };
    return {
      kind: "hold",
      hold: {
        kind: "volumeMissing",
        reason: `Series ${series.publicId} ("${series.title}") has no Volume ${volumeLabel}; ${publisher.name} publishes it.`,
        seriesId: series._id,
      },
    };
  }

  // One OpenLibrary leaf per (Volume, publisher, format): the ladder
  // already linked a same-format sibling without an ISBN unless its known
  // Binding differs, so one found here carries ANOTHER ISBN or Binding — a
  // reprint, a library binding, a hardcover, or an OL duplicate. Never a
  // second Release; the record is held.
  const sibling = await sameFormatRelease(ctx, volume._id, publisher._id, snapshot.format);
  if (sibling) {
    return {
      kind: "hold",
      hold: {
        kind: "isbn",
        reason: `Volume ${volume.label ?? "(unlabeled)"} already has a ${snapshot.format} ${publisher.name} Release (ISBN ${sibling.isbn13 ?? "none"}).`,
        seriesId: series._id,
      },
    };
  }

  return { kind: "create", series, seriesTitle, volumeLabel, publisher };
}

/**
 * Keep the edition's `match` note in step with the ladder's flag (spec §6:
 * a flat crowd-sourced record is never worth a human's review slot on its
 * own, so the flag stays on the observation): written while the ladder
 * flags the edition, its time kept while the flag is unchanged, and removed
 * once it does not. The observation's other notes stay.
 */
async function noteFlag(
  ctx: MutationCtx,
  observationId: Id<"sourceObservations">,
  offered: string,
  reason: string | undefined,
  now: number,
): Promise<void> {
  const conflicts = (await ctx.db.get(observationId))?.conflicts ?? [];
  const prior = conflicts.find((c) => c.field === "match");
  if (reason === undefined ? prior === undefined : prior?.reason === reason && prior.offered === offered) return;
  const kept = conflicts.filter((c) => c.field !== "match");
  await ctx.db.patch(observationId, {
    conflicts: reason === undefined ? kept : [...kept, { field: "match", offered, at: now, reason }],
  });
}

/**
 * Reconcile one OpenLibrary edition into the catalog. Match → fill; no
 * match → at most a leaf Release under fully pre-existing structure
 * (placeEdition); never a queue item, never new structure. A book a person
 * could place is held, and a hold the edition no longer earns is cleared.
 * One atomic mutation per record.
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

    const placement = await placeEdition(ctx, snapshot);
    const flag =
      placement.kind === "review" ? placement.reason : placement.kind === "hold" ? placement.review : undefined;
    await noteFlag(ctx, observation._id, snapshot.title, flag, now);

    if (placement.kind === "match") {
      const release = placement.release;
      await linkObservation(ctx, observation._id, { type: "release", id: release._id });
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

    if (placement.kind === "review") {
      await clearHold(ctx, observation._id);
      return { status: "recordOnly", changed: false };
    }

    if (placement.kind === "hold") {
      await recordUnplaced(ctx, observation, placement.hold, now);
      return { status: "recordOnly", changed: false };
    }

    if (placement.kind === "skip") {
      await clearHold(ctx, observation._id);
      return { status: "recordOnly", changed: false };
    }

    const { series, seriesTitle, volumeLabel, publisher } = placement;
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
/** Work per action before it continues in a fresh one (actions run ≤30 min). */
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

/**
 * Up to REPAIR_SCAN OpenLibrary observations after `after`, and the ones
 * whose stored description or linked Release text the cleaner would change.
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
    return await descriptionRepairWork(
      ctx,
      docs,
      (doc) => (doc.snapshot as Partial<OlEditionSnapshot> | null)?.description,
      cleanOlDescription,
    );
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
  handler: async (ctx, { observationId }): Promise<DescriptionRepair> => {
    const observation = await ctx.db.get(observationId);
    if (observation === null) return { snapshotFixed: false, release: null };
    const snapshot = observation.snapshot as OlEditionSnapshot;
    const fixed = recleaned(snapshot, cleanOlDescription);
    if (fixed !== null) await ctx.db.patch(observation._id, { snapshot: fixed });
    const release = await repairLinkedDescription(ctx, observation, {
      sourceKey: SOURCE_KEY,
      clean: cleanOlDescription,
      sourceName: "OpenLibrary",
      url: snapshot.url,
    });
    return { snapshotFixed: fixed !== null, release };
  },
});

/**
 * Re-clean every stored OpenLibrary description with today's
 * `cleanOlDescription` (a physical description is no blurb; a trailing
 * "--P. [4] of cover." citation goes) and fix the Releases still showing
 * OpenLibrary's text (`repairDescriptionLine`). No network; the walk is
 * `ann:repairDescriptions`' own (`runDescriptionRepair`) over different
 * observations with a different cleaner. Safe to rerun. An operator
 * command: it runs whatever the source's enabled flag says and opens no
 * Import Run.
 *
 *   npx convex run openLibrary:repairDescriptions '{}'
 */
export const repairDescriptions = internalAction({
  args: {
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    counts: v.optional(repairCountsValidator),
  },
  handler: (ctx, args): ReturnType<typeof runDescriptionRepair> =>
    runDescriptionRepair(ctx, args, {
      label: "openLibrary.repairDescriptions",
      noun: "observation",
      budgetMs: REPLAY_BUDGET_MS,
      candidates: internal.openLibrary.repairCandidates,
      repair: internal.openLibrary.repairDescriptionLine,
      self: internal.openLibrary.repairDescriptions,
    }),
});
