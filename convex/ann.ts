// The ANN Encyclopedia adapter (spec §6/§7): the weekly full
// mirror that builds the all-publisher, series-structured Series/Volume
// backbone — including the publishers whose sites are never scraped (VIZ,
// Square Enix) — and, through the per-release page pass, the Releases of
// publishers no other source covers.
//
// Etiquette: ANN allows 1 request per second; every fetch waits ≥1.1 s and
// details are batched 50 manga per request, so a ~24k-entry mirror is ~500
// detail requests. One action invocation processes a bounded number of
// batches (Convex actions are time-limited) and schedules itself to
// continue, carrying the Import Run and counters; the run closes — and the
// post-sweep withdrawal pass fires — only when the final link of the chain
// reaches the end of the report. A finished mirror — error-free or not —
// then chains the release-page pass (below); only an aborted one does not.
//
// What the mirror writes:
// - one manga entry = one Series (linked via the manga observation itself;
//   a title change at ANN is a rung-① field conflict at standard authority,
//   and its Plot Summary is offered as the synopsis at weak authority)
// - "(GN n)" / "(eBook n)" designators define the Volume backbone; missing
//   Volumes are created under the linked Series (spec §6 allows creating
//   the Volume of a single-volume release under a linked Series); brand-new
//   Series queue in steady state and create tagged in Bootstrap Mode
// - each release line is an observation keyed on ANN's own release id. It
//   links to the canonical Release carrying its ISBN (the line's `ean`), or
//   — for a line without one — the single same-label, same-format Release
//   under the linked Series; from then on ANN's dates reconcile in at
//   standard authority (how VIZ dates keep fresh). Ambiguity is left
//   unlinked for the record — the importer never guesses.
// - repairs stand: a link to a merged Series follows it to the survivor; an
//   entry whose Series (linked, or same-titled) an Editor hid only records
//   its lines; the backbone never recreates a Volume a repair hid or merged
//   away, and unlabeled lines add a placeholder Volume only to a Series with
//   no Volume at all; a hidden Release's ISBN is never placed again
//
// The release-page pass (`syncReleasePages`): the API has no publisher, so
// for every still-unlinked line it fetches the line's Encyclopedia page
// once (Distributor, ISBNs, date, SRP, Description — stored on the
// observation as `page`, the fetch state that keeps the pass incremental)
// and places it through the pipeline: an existing Release with the ISBN
// links; otherwise a LEAF Release (Edition + Release) is created under the
// linked Series' existing Volume when the Distributor resolves to an
// existing publisher row — the OpenLibrary rung-⑤ boundary. ANN never creates a Series or
// Volume this way, never a publisher, never packaging (omnibus/box-set
// lines link by ISBN only), and never a second same-format Release of one
// Volume from one publisher (reprints/variants stay on the observation).
// Authority is unchanged: PRH and publisher feeds stay authoritative for
// ISBN and date and overwrite what ANN created.
//
// The page's Description (publisher copy an ANN contributor entered) is the
// Release Description at ANN's weak rank: it fills a Release created or
// linked with none, and never touches one with text or a Human Override.
// A stored page's Description reaches a Release the mirror links later. A
// line linked before its page was read for one is refetched once by the
// page pass (at most DESCRIPTION_REFETCHES_PER_RUN a run), or in bulk by
// the operator's `backfillDescriptions`. A failed refetch never replaces a
// stored page.

import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import {
  annMangaValidator,
  annReleasePageValidator,
  cleanAnnDescription,
  namesEditionLine,
  parseApiResponse,
  parseReleasePage,
  parseReport,
  readAnnLineTitle,
  releaseUrl,
  titleVolumeList,
  toSnapshot,
  type AnnMangaSnapshot,
} from "./lib/ann";
import { errorMessage, politeFetch } from "./lib/http";
import { decodeUtf8OrWindows1252 } from "./lib/text";
import { applyRetrying } from "./lib/occ";
import {
  closeRun,
  isStranded,
  lastActiveAt,
  MAX_CARRIED_ERRORS,
  openFollowOnRun,
  registryRow,
  runToContinue,
  stampHandOff,
  stopAtGate,
} from "./lib/importRuns";
import { canonicalLabel, isNovelTitle, parseBookTitle, rangeLabels } from "./lib/bookTitle";
import { coverageFromLine } from "./lib/coverage";
import { coveringOf, releasesOf } from "./lib/editionRows";
import {
  candidateSeries,
  isbnHolders,
  isWholeSingleVolume,
  labelsEqual,
  sameWorkTitle,
  survivorOf,
  workMatch,
  type WorkEvidence,
} from "./lib/matching";
import {
  getObservation,
  type HoldKind,
  linkObservation,
  recordUnplaced,
  upsertObservation,
} from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  blurbWanted,
  descriptionEvidence,
  descriptionRepairWork,
  findPublisherByName,
  recleaned,
  repairCountsValidator,
  repairLinkedDescription,
  rewriteOwnDescription,
  queueCreationProposal,
  removedSeriesFor,
  runDescriptionRepair,
  REPAIR_SCAN,
  toPartialDate,
  type DescriptionRepair,
} from "./lib/pipeline";
import { reconcileFields } from "./lib/reconcile";
import { withExceptionCapture } from "./lib/posthog";
import { pairKeyOf } from "./lib/qa";

export const SOURCE_KEY = "ann";
/** The source's name in a citation when the registry row has none. */
const SOURCE_NAME = "Anime News Network Encyclopedia";
const REPORT_URL = "https://www.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=manga";
const API_URL = "https://cdn.animenewsnetwork.com/encyclopedia/api.xml";
const IMPORT_COMMENT = "Imported from the Anime News Network Encyclopedia.";

/** ANN's rate limit is 1 req/s; stay comfortably under it. */
const ANN_DELAY_MS = 1100;
/** Manga ids per api.xml request (ANN's documented batch maximum). */
const BATCH_SIZE = 50;
/** Report page size — one report fetch covers several detail batches. */
const REPORT_PAGE = 500;

// ---------- the mirror action ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      /** True when this link scheduled a continuation instead of finishing. */
      continued: boolean;
      errorCount: number;
      failed?: boolean;
      stopped?: true;
    };

/**
 * One link of the weekly mirror chain. Called with no args by the cadence
 * dispatcher; continuation links carry the run state. Each report page, and
 * the withdrawal pass, starts at the import gate (lib/importRuns.ts); a run
 * it stops chains no page pass.
 *
 *   npx convex run ann:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. Defaults to ANN's 1 req/s. */
    politeDelayMs: v.optional(v.number()),
    /** Detail batches (50 manga each) per invocation before continuing. */
    maxBatches: v.optional(v.number()),
    /** Chain the release-page pass after a finished mirror (default true). */
    releasePages: v.optional(v.boolean()),
    /**
     * Operator-targeted run: refresh only these ANN manga ids (detail API
     * only, no report walk, no withdrawal — a subset proves no absence),
     * then chain the page pass. Minutes instead of a full mirror:
     *
     *   npx convex run ann:sync '{"onlyManga":["1223","1825"]}'
     */
    onlyManga: v.optional(v.array(v.string())),
    // ----- continuation state (never passed by callers) -----
    nskip: v.optional(v.number()),
    runId: v.optional(v.id("importRuns")),
    runStartedAt: v.optional(v.number()),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    /** An earlier link got a real detail document: the detail API is up. */
    detailsReached: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("ann.sync", ctx, async () => {
      const source = await registryRow(ctx, SOURCE_KEY);
      const runId = await runToContinue(ctx, source, args);
      if (runId === null) return { skipped: "disabled" as const };
      const runStartedAt = args.runStartedAt ?? Date.now();
      const delay = args.politeDelayMs ?? ANN_DELAY_MS;
      const maxBatches = args.maxBatches ?? 40;
      const errors = [...(args.errors ?? [])];
      let seen = args.seen ?? 0;
      let changed = args.changed ?? 0;
      let nskip = args.nskip ?? 0;
      let detailsReached = args.detailsReached ?? false;
      const targeted = args.onlyManga !== undefined;

      try {
        let batchesDone = 0;
        let reachedEnd = false;

        while (batchesDone < maxBatches && !reachedEnd) {
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, continued: false };
          let ids: string[];
          let rawCount: number;
          if (targeted) {
            // One pass over the named entries; the report is never read.
            ids = [
              ...new Set(args.onlyManga!.map((id) => id.trim()).filter((id) => /^\d+$/.test(id))),
            ];
            rawCount = ids.length;
            reachedEnd = true;
            if (ids.length === 0) break;
          } else {
            const reportRes = await politeFetch(
              `${REPORT_URL}&nlist=${REPORT_PAGE}&nskip=${nskip}`,
              delay,
            );
            const reportXml = await reportRes.text();
            // Paging and the end-of-enumeration signal follow the page's RAW
            // <item> count: parseReport filters non-manga and malformed rows, so
            // its item count under-counts the page and would end the mirror at
            // the first page containing any filtered row (and desync nskip).
            const report = parseReport(reportXml);
            rawCount = report.rawCount;
            // A row without id/name is an entry this sweep cannot see: skipped
            // so the enumeration goes on, reported so withdrawal stays off.
            for (const at of report.malformed) {
              errors.push(`report @${nskip + at}: item without id/name`);
            }
            ids = report.items.map((item) => item.id);
            if (rawCount === 0) {
              // A well-formed but empty FIRST page is not an empty catalog: the
              // clean sweep would otherwise withdraw every ANN observation.
              if (nskip === 0) throw new Error("ANN report enumeration was empty");
              reachedEnd = true;
              break;
            }
          }

          // Budget is checked per page (a page is ≤10 batches), so nskip stays
          // page-aligned and continuations never resume mid-page.
          for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
            const batch = ids.slice(offset, offset + BATCH_SIZE);
            try {
              const apiRes = await politeFetch(`${API_URL}?manga=${batch.join("/")}`, delay);
              const apiXml = await apiRes.text();
              if (!/^\s*(?:<\?xml[^>]*>\s*)?<ann\b[^>]*>[\s\S]*<\/ann>\s*$/.test(apiXml)) {
                throw new Error("ANN returned an invalid detail document");
              }
              // A real detail document, whatever it lists: the API is up.
              detailsReached = true;
              const records = parseApiResponse(apiXml);
              const returnedIds = new Set(records.map((record) => record.id));
              const missing = batch.filter((id) => !returnedIds.has(id));
              if (missing.length > 0) {
                throw new Error(`ANN detail response is missing manga ${missing.join(", ")}`);
              }
              if (records.length !== batch.length) {
                throw new Error(
                  `ANN detail response has ${records.length} manga for ${batch.length} requested`,
                );
              }
              for (const manga of records) {
                // Entries with no English book release contribute nothing to
                // the backbone (scope: all ENGLISH releases).
                if (manga.releases.length === 0) continue;
                seen++;
                try {
                  const result = await applyRetrying(ctx, internal.ann.applyManga, {
                    snapshot: toSnapshot(manga),
                  });
                  if (result.changed) changed++;
                } catch (e) {
                  errors.push(`manga ${manga.id}: ${errorMessage(e)}`);
                }
              }
            } catch (e) {
              errors.push(`batch @${nskip + offset}: ${errorMessage(e)}`);
            }
            batchesDone++;
          }
          nskip += rawCount;

          // A short raw page = the end of the enumeration; a full page loops
          // for the next one.
          if (rawCount < REPORT_PAGE) reachedEnd = true;
        }

        if (!reachedEnd) {
          // Budget spent mid-mirror: hand the run to the next link.
          await stampHandOff(ctx, runId, { seen, changed, errors });
          await ctx.scheduler.runAfter(0, internal.ann.sync, {
            politeDelayMs: args.politeDelayMs,
            maxBatches: args.maxBatches,
            releasePages: args.releasePages,
            nskip,
            runId,
            runStartedAt,
            seen,
            changed,
            errors: errors.slice(0, MAX_CARRIED_ERRORS),
            detailsReached,
          });
          return {
            runId,
            recordsSeen: seen,
            recordsChanged: changed,
            continued: true,
            errorCount: errors.length,
          };
        }

        // Missing details or a rejected observation make disappearance unknowable.
        // Preserve prior observations until a complete, error-free sweep succeeds;
        // an errored sweep finishes failed (visible on the dashboard) but is
        // still a finished sweep, so the page pass below chains either way.
        // No detail document at all: ANN's detail API is down (or the report
        // listed nothing this sweep could fetch), so the sweep saw no entry
        // and the page pass would only park lines for ERROR_RETRY_MS.
        if (!detailsReached) {
          errors.push("ANN detail API unreachable; release-page pass skipped");
        }
        const complete = errors.length === 0;
        if (complete && !targeted) {
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, continued: false };
          // The full mirror completed: entries the sweep no longer lists have
          // disappeared at ANN → withdrawn (spec §6; retained, never deleted).
          await ctx.runMutation(internal.imports.markWithdrawn, {
            sourceKey: SOURCE_KEY,
            notSeenSince: runStartedAt,
          });
        } else if (!complete) {
          errors.push("ANN mirror was incomplete; withdrawal skipped");
        }
        const closed = await closeRun(ctx, runId, complete ? "succeeded" : "failed", {
          seen,
          changed,
          errors,
        });
        // The mirror refreshed the lines it could: now place the unlinked
        // ones. The page pass walks unlinked lines on its own and must not
        // wait on a mirror one persistently failing entry would never let
        // complete. It does not chain when ANN itself looks down: an aborted
        // enumeration (the catch below) or no detail document at all.
        if (detailsReached && args.releasePages !== false) {
          await ctx.runMutation(internal.ann.chainReleasePages, {
            afterRunId: runId,
            politeDelayMs: args.politeDelayMs,
            ...(complete ? {} : { afterFailedMirror: true }),
          });
        }
        return { ...closed, continued: false };
      } catch (e) {
        errors.push(errorMessage(e));
        return {
          ...(await closeRun(ctx, runId, "failed", { seen, changed, errors })),
          continued: false,
        };
      }
    }),
});

// ---------- release-line snapshots ----------

/** Fetch state of a line's Encyclopedia page, stored on its observation. */
const pageStateValidator = annReleasePageValidator.extend({
  status: v.union(
    v.literal("ok"),
    // 404: the release was removed at ANN.
    v.literal("notFound"),
    // Served, but not a release page (layout change, login wall).
    v.literal("unparsed"),
    // Transient failure — retried after ERROR_RETRY_MS.
    v.literal("error"),
  ),
  fetchedAt: v.number(),
  error: v.optional(v.string()),
  /**
   * The page was parsed by a reader that looks for its Description, so a
   * page without one is not refetched for it again. Ok pages stored before
   * that reader lack it.
   */
  descriptionChecked: v.optional(v.literal(true)),
  /**
   * A refetch of this ok page failed: the page is kept (a failure never
   * replaces a good page) and the refetch waits out the usual retry window.
   */
  refetchFailed: v.optional(
    v.object({
      status: v.union(v.literal("notFound"), v.literal("unparsed"), v.literal("error")),
      at: v.number(),
    }),
  ),
});

type PageState = Infer<typeof pageStateValidator>;

/**
 * The page state to store after a fetch: the fresh one, except that a
 * failed refetch of an ok page keeps the ok page and notes the failure.
 */
function keptPage(prior: PageState | undefined, fetched: PageState): PageState {
  if (fetched.status === "ok" || prior?.status !== "ok") return fetched;
  return { ...prior, refetchFailed: { status: fetched.status, at: fetched.fetchedAt } };
}

/** One release line's observation snapshot (`release:NNN`). */
export type AnnReleaseSnapshot = AnnMangaSnapshot["releases"][number] & {
  kind: "annRelease";
  mangaId: string;
  url: string;
  page?: PageState;
};

/**
 * The Release carrying this ISBN, merged rows answered by their survivor:
 * `active` to link, else `hidden` when an Editor hid that book — which the
 * importer must never create again.
 */
async function releaseByIsbn(
  ctx: MutationCtx,
  isbn13: string,
): Promise<{ active: Doc<"releases"> | null; hidden: boolean }> {
  const resolved = await isbnHolders(ctx, isbn13);
  return {
    active: resolved.find((release) => release?.status === "active") ?? null,
    hidden: resolved.some((release) => release?.status === "hidden"),
  };
}

/** Whether any Release, active or hidden, already carries this ISBN. */
async function isbnTaken(ctx: MutationCtx, isbn13: string): Promise<boolean> {
  const { active, hidden } = await releaseByIsbn(ctx, isbn13);
  return active !== null || hidden;
}

// ---------- applying one manga entry ----------

type ApplyResult = {
  status: "created" | "linked" | "queued" | "alreadyQueued" | "ambiguous" | "recordOnly";
  changed: boolean;
  seriesId?: Id<"series">;
  releasesLinked: number;
};

/** Volume labels this entry evidences: plain GN/eBook numbers, no ranges or
 * omnibus/box-set packaging (those describe Editions, not source Volumes).
 * Canonical and deduplicated numerically ("1" and "01" are one Volume). */
function backboneLabels(snapshot: AnnMangaSnapshot): Array<string | undefined> {
  const labels: Array<string | undefined> = [];
  for (const release of snapshot.releases) {
    if (release.multi || release.editionLineHint) continue;
    const label = release.label !== undefined ? canonicalLabel(release.label) : undefined;
    if (!labels.some((l) => labelsEqual(l, label ?? null))) labels.push(label);
  }
  return labels;
}

/** Every release line is packaging: the entry evidences no single Volume. */
function packagingOnly(snapshot: AnnMangaSnapshot): boolean {
  return (
    snapshot.releases.length > 0 &&
    snapshot.releases.every((release) => release.multi || release.editionLineHint)
  );
}

type AnnLine = AnnMangaSnapshot["releases"][number];

/** How many of the entry's lines share this line's label and format. */
function printingsOf(snapshot: AnnMangaSnapshot, line: AnnLine): number {
  return snapshot.releases.filter(
    (other) =>
      !other.multi &&
      !other.editionLineHint &&
      other.format === line.format &&
      labelsEqual(other.label, line.label ?? null),
  ).length;
}

/**
 * A title-matched Series the entry was not linked to: its books and the
 * entry's share no ISBN (`heldBy` null), or another live ANN entry, id
 * `heldBy`, already holds it and nothing tells the two works apart.
 */
type SetAside = { series: Doc<"series">; heldBy: string | null };

// Bound on the observations annEntryHolding reads for one Series. A Series
// carries one link per ANN entry and per publisher series feed naming it
// (at most five in production on 2026-10-02); an ANN link past the bound
// is not seen, and the title links as it did before the rule.
const SERIES_LINK_SCAN = 20;

/**
 * The id of a live ANN entry linked to the Series, or null. Asked only for
 * an entry that has no Series link, so the holder is always another entry.
 */
async function annEntryHolding(ctx: MutationCtx, seriesId: Id<"series">): Promise<string | null> {
  const links = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", "series").eq("recordRef.id", seriesId))
    .take(SERIES_LINK_SCAN);
  const holder = links.find(
    (link) =>
      link.sourceKey === SOURCE_KEY && !link.withdrawn && link.sourceRecordId.startsWith("manga:"),
  );
  return holder?.sourceRecordId.slice("manga:".length) ?? null;
}

/**
 * Flag the Series ANN created for an entry beside the one Series of the
 * entry's title that it set aside, for sharing no ISBN with the entry's
 * books or for being held by another live ANN entry: a duplicate candidate
 * for the Data Team (/mod/launch), whose reason says which. The created
 * Series is new, so the pair is too.
 */
async function flagSetAsideTwin(
  ctx: MutationCtx,
  createdId: Id<"series">,
  { series, heldBy }: SetAside,
  snapshot: AnnMangaSnapshot,
) {
  await ctx.db.insert("duplicateCandidates", {
    pairKey: pairKeyOf(series._id, createdId),
    aId: series._id,
    bId: createdId,
    aTitle: series.title,
    bTitle: snapshot.title,
    reason:
      heldBy === null
        ? `ANN entry ${snapshot.id} has this title, but its books share no ISBN with Series ${series.publicId}'s, so the import created a Series of its own. Merge them if they are one work under other ISBNs.`
        : `ANN entry ${snapshot.id} has this title, but ANN entry ${heldBy} already holds Series ${series.publicId}, so the import created a Series of its own. Merge them if ANN lists one work twice.`,
    status: "open",
  });
}

// An ANN line and a canonical Release more than this many years apart are
// different printings (Tokyopop 2004 vs a 2025 reissue), never one book.
const PRINTING_YEAR_TOLERANCE = 1;

/**
 * The series-scoped release match: under a rung-①-linked Series, a volume
 * label + format is the full key (the ladder's publisher+title key exists
 * to disambiguate same-titled series; a stored series link is strictly
 * stronger) — but only for a line that is the entry's ONLY printing of that
 * label and format, only onto an ordinary whole-Volume Edition (never a
 * split part or packaging), and only onto a Release dated within a year of
 * it. ANN lists every North American printing of a volume; linking them all
 * to one Release made their dates overwrite each other. Exactly one clean
 * candidate links; anything else stays unlinked — the importer never guesses.
 */
async function matchReleaseInSeries(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  snapshot: AnnMangaSnapshot,
  line: AnnLine,
): Promise<{ kind: "one"; release: Doc<"releases"> } | { kind: "none" | "many" }> {
  if (printingsOf(snapshot, line) !== 1) return { kind: "many" };
  const { label, format } = line;
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const candidates = new Map<string, Doc<"releases">>();
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    if (!labelsEqual(volume.label, label ?? null)) continue;
    const coverages = await coveringOf(ctx, volume._id);
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      if (!(await isWholeSingleVolume(ctx, edition))) continue;
      const releases = await releasesOf(ctx, edition._id);
      for (const release of releases) {
        if (release.status !== "active" || release.locked) continue;
        if (release.format !== format) continue;
        // A different ISBN-13 is a different book (another printing).
        if (
          line.isbn13 !== undefined &&
          release.isbn13 !== undefined &&
          release.isbn13 !== line.isbn13
        ) {
          continue;
        }
        if (
          line.date !== undefined &&
          release.pubDate !== undefined &&
          Math.abs(release.pubDate.year - line.date.year) > PRINTING_YEAR_TOLERANCE
        ) {
          continue;
        }
        candidates.set(release._id, release);
      }
    }
  }
  const hits = [...candidates.values()];
  if (hits.length === 1) return { kind: "one", release: hits[0]! };
  return { kind: hits.length === 0 ? "none" : "many" };
}

/**
 * Upsert one release line's observation (`release:NNN`), carrying over the
 * release-page pass's stored fetch state — or every mirror would forget the
 * pages it fetched.
 */
async function upsertLine(
  ctx: MutationCtx,
  snapshot: AnnMangaSnapshot,
  release: AnnLine,
  now: number,
): Promise<{ observation: Doc<"sourceObservations">; url: string }> {
  const url = /^\d+$/.test(release.annId) ? releaseUrl(release.annId) : snapshot.url;
  const sourceRecordId = `release:${release.annId}`;
  const prior = await getObservation(ctx, SOURCE_KEY, sourceRecordId);
  const page = (prior?.snapshot as AnnReleaseSnapshot | undefined)?.page;
  const lineSnapshot: AnnReleaseSnapshot = {
    kind: "annRelease",
    mangaId: snapshot.id,
    ...release,
    url,
    ...(page !== undefined ? { page } : {}),
  };
  const { observation } = await upsertObservation(ctx, {
    sourceKey: SOURCE_KEY,
    sourceRecordId,
    snapshot: lineSnapshot,
    now,
  });
  return { observation, url };
}

/** Whether the Series has any Volume row at all — active, hidden, or merged. */
async function hasAnyVolume(ctx: MutationCtx, seriesId: Id<"series">): Promise<boolean> {
  const volume = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .first();
  return volume !== null;
}

/**
 * Reconcile one manga entry: series link/creation, the Volume backbone, and
 * per-release observations with date reconciliation. One atomic mutation
 * per manga entry (its records must change together).
 */
export const applyManga = internalMutation({
  args: { snapshot: annMangaValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? SOURCE_NAME;
    const citation = { sourceName, url: snapshot.url };

    const { observation } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: `manga:${snapshot.id}`,
      snapshot,
      now,
    });

    let changed = false;

    // ----- the Series: rung ① stored link, else resolve/create -----
    let seriesId: Id<"series"> | null = null;
    // The one Series of the entry's title, when it was set aside: flagged
    // beside whatever Series the entry gets created or queued.
    let setAside: SetAside | null = null;
    if (observation.recordRef?.type === "series") {
      // Repairs stand: a merged Series is followed to its survivor (and the
      // link repointed); a hidden one keeps its lines on record only.
      const linkedId = observation.recordRef.id;
      const series = await survivorOf<"series">(ctx, await ctx.db.get(linkedId));
      if (series?.status === "hidden") {
        for (const release of snapshot.releases) await upsertLine(ctx, snapshot, release, now);
        return { status: "recordOnly", changed, releasesLinked: 0 };
      }
      if (series && series.status === "active") {
        seriesId = series._id;
        if (series._id !== linkedId) {
          await linkObservation(ctx, observation._id, { type: "series", id: series._id });
          changed = true;
        }
        if (!series.locked) {
          const result = await reconcileFields(ctx, {
            sourceKey: SOURCE_KEY,
            ref: { type: "series", id: series._id },
            doc: series,
            // The Plot Summary fills a blank synopsis (weak authority): any
            // publisher's text outranks it and stays.
            offered: {
              title: snapshot.title,
              ...(snapshot.synopsis !== undefined ? { synopsis: snapshot.synopsis } : {}),
            },
            observation,
            citation,
            now,
          });
          changed = changed || result.changed;
        }
      }
    } else {
      // A title names candidates; the entry's staff and ISBNs rule out the
      // ones that are another work (Doubt vs Doubt!!, Citrus vs Citrus+).
      // With nothing to tell them apart, a Series another live ANN entry
      // already holds is another work too: in production no two ANN entries
      // of one title share a Series, and a Series ANN created has no book
      // until the page pass, so the title alone put the Alchemist's sequel
      // on the first work's Series. A shared ISBN still links.
      const evidence: WorkEvidence = {
        books: snapshot.releases.flatMap((r) =>
          r.isbn13 ? [{ isbn13: r.isbn13, format: r.format }] : [],
        ),
        annPersonIds: (snapshot.credits ?? []).map((c) => c.personId),
      };
      const sameWork = async (found: Doc<"series">[]) => {
        const kept: Doc<"series">[] = [];
        const disjoint: SetAside[] = [];
        for (const series of found) {
          const verdict = await workMatch(ctx, series._id, evidence);
          if (verdict === "disjointBooks") disjoint.push({ series, heldBy: null });
          else if (verdict === "unknown") {
            const heldBy = await annEntryHolding(ctx, series._id);
            if (heldBy === null) kept.push(series);
            else disjoint.push({ series, heldBy });
          } else if (verdict === "same") kept.push(series);
        }
        return { kept, disjoint };
      };
      const titled = await candidateSeries(ctx, snapshot.title);
      const byTitle = await sameWork(titled);
      let candidates = byTitle.kept;
      if (titled.length === 1 && byTitle.disjoint.length === 1) setAside = byTitle.disjoint[0]!;
      if (candidates.length === 0) {
        // ANN often names a work by a short title and carries the
        // publisher's full title only as an alternative ("7th Time Loop:
        // The Villainess Enjoys a Carefree Life" vs "… Married to Her Worst
        // Enemy!"). A Series a publisher feed created under that full title
        // is the same work; missing it built 123 bookless twins on the
        // first staging import. Any alternative title that names exactly
        // one active Series links it.
        const byAlt = new Map<string, Doc<"series">>();
        for (const alt of snapshot.altTitles) {
          for (const series of await candidateSeries(ctx, alt)) byAlt.set(series._id, series);
        }
        candidates = (await sameWork([...byAlt.values()])).kept;
      }
      if (candidates.length === 1) {
        seriesId = candidates[0]!._id;
        await linkObservation(ctx, observation._id, { type: "series", id: seriesId });
        changed = true;
      } else if (candidates.length > 1) {
        // Two same-titled Series: linking either would be a guess.
        return { status: "ambiguous", changed, releasesLinked: 0 };
      }
    }

    const labels = backboneLabels(snapshot);

    if (seriesId === null) {
      // Brand-new Series: the steady-state always-review gate, lifted in
      // Bootstrap Mode (spec §7) — where the whole backbone gets built.
      const bootstrap = await getBootstrapMode(ctx);
      if (!bootstrap) {
        if (await alreadyHandled(ctx, observation)) {
          return { status: "alreadyQueued", changed, releasesLinked: 0 };
        }
        // An Editor hid this very work: never queue it back. (Bootstrap's
        // creation path below makes the same check itself.)
        const removed = await removedSeriesFor(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          seriesTitle: snapshot.title,
          publisherId: null,
        });
        if (removed?.kind === "hidden") {
          await recordUnplaced(ctx, observation, { kind: "series", reason: removed.reason }, now);
          return { status: "recordOnly", changed: true, releasesLinked: 0 };
        }
        await queueCreationProposal(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          seriesId: null,
          seriesTitle: snapshot.title,
          seriesAltTitles: snapshot.altTitles,
          labels: labels.filter((l): l is string => l !== undefined),
          seriesOnly: packagingOnly(snapshot),
          now,
          comment: `"${snapshot.title}" observed at ${sourceName} needs a brand-new Series — steady-state creation gate. Series + Volume backbone only; ANN carries no publisher, so Releases arrive from other sources.${
            setAside === null
              ? ""
              : setAside.heldBy === null
                ? ` Series ${setAside.series.publicId} ("${setAside.series.title}") has this title, but its books share no ISBN with this entry's, so the import did not link it: it may be the same work under other ISBNs.`
                : ` Series ${setAside.series.publicId} ("${setAside.series.title}") has this title, but ANN entry ${setAside.heldBy} already holds it, so the import did not link it: it may be one work ANN lists twice.`
          }`,
        });
        return { status: "queued", changed: true, releasesLinked: 0 };
      }
      const creation = await createCanonicalRecords(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        seriesId: null,
        seriesTitle: snapshot.title,
        seriesAltTitles: snapshot.altTitles,
        seriesSynopsis: snapshot.synopsis,
        labels: labels.filter((l): l is string => l !== undefined),
        // Omnibus-only entries evidence no single Volume: no placeholder.
        seriesOnly: packagingOnly(snapshot),
        tagBootstrapUnreviewed: true,
        now,
      });
      if (creation.blocked !== undefined) {
        return { status: "recordOnly", changed: true, releasesLinked: 0 };
      }
      seriesId = creation.seriesId;
      await linkObservation(ctx, observation._id, { type: "series", id: seriesId });
      if (setAside !== null) await flagSetAsideTwin(ctx, seriesId, setAside, snapshot);
      changed = true;
    } else if (labels.length > 0) {
      // The Volume backbone under a linked Series — within the spec §6
      // auto-create boundary; a no-op when every Volume already exists, and
      // never recreating a Volume a repair hid or merged away. Unlabeled
      // lines alone evidence one placeholder Volume only while the Series
      // has no Volume row at all: next to numbered Volumes (or a removed
      // placeholder) it would be a stray empty Volume.
      const numbered = labels.filter((l): l is string => l !== undefined);
      if (numbered.length > 0 || !(await hasAnyVolume(ctx, seriesId))) {
        const creation = await createCanonicalRecords(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          citation,
          importComment: IMPORT_COMMENT,
          seriesId,
          seriesTitle: snapshot.title,
          labels: numbered,
          tagBootstrapUnreviewed: false,
          now,
        });
        changed = changed || creation.changed;
      }
    }

    // ----- release lines: observations + linking + date reconciliation -----
    let releasesLinked = 0;
    for (const release of snapshot.releases) {
      const { observation: releaseObs, url } = await upsertLine(ctx, snapshot, release, now);

      let canonical: Doc<"releases"> | null = null;
      if (releaseObs.recordRef?.type === "release") {
        const linked = await ctx.db.get(releaseObs.recordRef.id);
        if (linked && linked.status === "active" && !linked.locked) {
          canonical = linked;
        }
      } else {
        // An ISBN names exactly one book: it links whatever the packaging,
        // but only onto a Release of this Series (elsewhere it is a
        // duplicate-Series question for a human, not a link).
        const byIsbn =
          release.isbn13 !== undefined ? (await releaseByIsbn(ctx, release.isbn13)).active : null;
        const match = byIsbn
          ? byIsbn.seriesIds.includes(seriesId) && !byIsbn.locked
            ? ({ kind: "one", release: byIsbn } as const)
            : ({ kind: "none" } as const)
          : !release.multi && !release.editionLineHint
            ? await matchReleaseInSeries(ctx, seriesId, snapshot, release)
            : ({ kind: "none" } as const);
        if (match.kind === "one") {
          canonical = match.release;
          await linkObservation(ctx, releaseObs._id, { type: "release", id: canonical._id });
          releasesLinked++;
          changed = true;
        }
      }

      // The line's date, and its ISBN when the linked Release has none yet
      // (a volume+format link made before ANN lines carried ISBNs) and no
      // other Release already holds that ISBN. A page read while the line
      // was unlinked offers its stored Description to a blank Release.
      const storedPage = (releaseObs.snapshot as AnnReleaseSnapshot).page;
      const offered: Record<string, unknown> = canonical
        ? { ...descriptionOffer(storedPage, canonical) }
        : {};
      if (release.date) offered.pubDate = toPartialDate(release.date);
      if (canonical && canonical.isbn13 === undefined && release.isbn13 !== undefined) {
        if (!(await isbnTaken(ctx, release.isbn13))) offered.isbn13 = release.isbn13;
      }
      if (canonical && Object.keys(offered).length > 0) {
        const result = await reconcileFields(ctx, {
          sourceKey: SOURCE_KEY,
          ref: { type: "release", id: canonical._id },
          doc: canonical,
          offered,
          observation: releaseObs,
          citation: { sourceName, url },
          now,
        });
        changed = changed || result.changed;
      }
    }

    return {
      status: releasesLinked > 0 ? "linked" : changed ? "created" : "recordOnly",
      changed,
      seriesId,
      releasesLinked,
    };
  },
});

// ---------- the release-page pass ----------

/** A transient page failure is retried after this long. */
const ERROR_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** A missing/unparsable page is re-checked after this long. */
const GONE_RETRY_MS = 90 * 24 * 60 * 60 * 1000;
/** Candidate lines per registry query page. */
const CANDIDATE_PAGE = 25;
/** Page fetches per action link before it hands off (~1.1 s each). */
const DEFAULT_MAX_FETCHES = 300;
/**
 * Description refetches of linked lines per page-pass RUN: the weekly pass
 * works the backlog down over a couple of months; `backfillDescriptions`
 * does the bulk by hand.
 */
const DESCRIPTION_REFETCHES_PER_RUN = 2000;
/**
 * Wall-clock work per action link before it hands off (actions run ≤10
 * min): during an ANN outage one rate-limited fetch can back off for up to
 * ~4 minutes, so the fetch count alone cannot keep a link under the
 * ceiling, and the budget leaves room for one such fetch after it.
 */
const LINK_BUDGET_MS = 5 * 60 * 1000;

// Distributor strings that are prose imprints: their lines never create
// manga Releases, whatever their designator says.
const NOVEL_DISTRIBUTORS = /^(?:yen on|j-novel club novels?|seven seas airship|airship)$/i;
// ANN's encyclopedia is worldwide: a release line under a French or German
// house is a real book, just not an English one. Out of this catalog's scope,
// so it is skipped rather than reported as a missing publisher row.
const FOREIGN_DISTRIBUTORS =
  /^(?:kana|panini(?: comics| manga)?|bruno gm[üu]nder(?: verlag)?|glénat|glenat|carlsen(?: manga)?|egmont(?: manga)?|pika(?: [ée]dition)?|ki-oon|tokyopop gmbh|star comics|planeta(?: c[oó]mic)?|norma editorial|ivrea)$/i;

// A store-exclusive or variant cover is a second ISBN of the same volume
// ("Jujutsu Kaisen - [Walmart Exclusive Cover] (GN 30)"): never a leaf.
const VARIANT_LINE = /\b(?:exclusive|variant)\b/i;

/**
 * Why a release line is out of scope, from its title and stored page, or
 * null: a store-exclusive or variant cover, packaging its title marks a
 * novel ("Alpha (Light Novel) [VIZBIG Edition]"), a prose imprint, or a
 * foreign-language distributor. No one places such a line, so it is noted
 * and never a Held Book (applyReleasePage; imports.backfillHolds reads the
 * stored line the same way).
 */
export function lineOutOfScope(line: AnnReleaseSnapshot): string | null {
  if (VARIANT_LINE.test(line.title))
    return "A store-exclusive or variant cover: never a Release of its own.";
  if ((line.multi || line.editionLineHint) && isNovelTitle(line.title))
    return "Packaging its title marks a novel: out of manga scope.";
  const distributor = line.page?.distributor;
  if (distributor === undefined) return null;
  if (NOVEL_DISTRIBUTORS.test(distributor))
    return `"${distributor}" is a prose imprint: out of manga scope.`;
  if (FOREIGN_DISTRIBUTORS.test(distributor.trim())) {
    return `"${distributor}" publishes in another language: out of English scope.`;
  }
  return null;
}

/**
 * ANN's packaged line titles come in three shapes: "Naruto [3-in-1 Edition]"
 * (the designator number is the line position), "One Piece - [Omnibus] 33 -
 * Wano" (the position follows the tag; the designator holds the volume
 * range) and "Rurouni Kenshin - VIZBIG Edition [13-15]" (an untagged line
 * name, its covered Volumes in brackets, the position in the designator).
 * All yield the line name and position; a bare "(GN 1-3)" range with no tag
 * is an Omnibus. Box sets are bundles, never lines: null.
 *
 * `names`, the work's known titles, keep a line word of the work's own
 * name from naming its line: "Makunouchi Deluxe [VIZBIG Edition]" is a
 * VIZBIG book, and "Makunouchi Deluxe (GN 1-3)" an Omnibus. The line is
 * read from the title's own line name on (lib/ann.ts readAnnLineTitle),
 * the work's name standing aside.
 */
export function packagingOf(
  line: {
    title: string;
    label?: string;
    multi: boolean;
    coverRange?: { from: string; to: string };
  },
  names: readonly string[] = [],
): { name: string; position: string | null } | null {
  const read = readAnnLineTitle(line.title, { names });
  const { parsed, tagPosition } = readLineTitle(
    read.kind === "line" ? `${WORK_STAND_IN} ${read.tail}` : line.title,
  );
  if (parsed.isBox) return null;
  const parsedName = parsed.packaging?.lineName ?? null;
  const ownWord = read.kind === "single" && parsedName !== null && namesEditionLine(parsedName);
  const name = (ownWord ? null : parsedName) ?? (line.multi && line.coverRange ? "Omnibus" : null);
  if (name === null) return null;
  const position = tagPosition ?? line.label ?? null;
  return { name, position: position === null ? null : canonicalLabel(position) };
}

/** A plain word standing in for a work's name, so the parser reads only the line after it. */
const WORK_STAND_IN = "Work";

/**
 * A packaged line title read by the shared parser (`packagingOf`): the tag
 * beside the work's name ("One Piece [Omnibus]"), and a position after the
 * tag. The bracketed Volume statement is coverage (lib/ann.ts
 * splitReleaseTitle), never a tag.
 */
function readLineTitle(raw: string) {
  const title = titleVolumeList(raw)?.rest ?? raw;
  const tagged = /^(.+?)\s*(?:[-–—:]\s*)?\[([^\]]+)\]\s*(\d+(?:\.\d+)?)?(?:\s*[-–—:]\s*.*)?$/.exec(
    title,
  );
  const probe = tagged ? `${tagged[1]!.trim()} [${tagged[2]!.trim()}]` : title;
  return { parsed: parseBookTitle(probe), tagPosition: tagged?.[3] };
}

/** Whether a line needs (another) page fetch, per its stored fetch state. */
function needsFetch(page: PageState | undefined, now: number): boolean {
  if (page === undefined) return true;
  if (page.status === "ok") return false;
  const retry = page.status === "error" ? ERROR_RETRY_MS : GONE_RETRY_MS;
  return now - page.fetchedAt > retry;
}

/**
 * Whether a LINKED line's page is worth a fetch for its Release's missing
 * description (`blurbWanted`): an ok page never read for a Description (the
 * mirror linked the line by ISBN before any fetch stored one, or it was
 * fetched before descriptions were imported), or a missing/failed page —
 * or a failed refetch — once its retry window has passed. A page checked
 * and found without a Description is never refetched for it.
 */
function descriptionRefetch(
  page: PageState | undefined,
  release: Doc<"releases"> | null,
  now: number,
): boolean {
  if (release === null || !blurbWanted(release)) return false;
  if (page?.status !== "ok") return needsFetch(page, now);
  if (page.descriptionChecked) return false;
  const failed = page.refetchFailed;
  return failed === undefined || needsFetch({ status: failed.status, fetchedAt: failed.at }, now);
}

/**
 * One page of unlinked release lines, in source-record-id order. Linked
 * lines drop out, so a later pass only touches new or still-unplaced ones —
 * except a linked line whose Release still lacks a description and whose
 * page has never been read for one (`descriptionRefetch`), which comes
 * back once for a fetch.
 */
export const releasePageCandidates = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    now: v.number(),
    /** False once the run has spent its description refetches. */
    refetches: v.boolean(),
  },
  handler: async (ctx, { cursor, numItems, now, refetches }) => {
    const result = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gte("sourceRecordId", "release:")
          .lt("sourceRecordId", "release;"),
      )
      .paginate({ cursor, numItems });
    const candidates: Array<{ annId: string; fetch: boolean; refetch?: true }> = [];
    for (const obs of result.page) {
      if (obs.withdrawn) continue;
      const snapshot = obs.snapshot as AnnReleaseSnapshot;
      // Content-derived ids (a line without an href) have no page.
      if (!/^\d+$/.test(snapshot.annId)) continue;
      if (obs.recordRef === undefined) {
        candidates.push({ annId: snapshot.annId, fetch: needsFetch(snapshot.page, now) });
      } else if (refetches && obs.recordRef.type === "release") {
        const release = await ctx.db.get(obs.recordRef.id);
        if (descriptionRefetch(snapshot.page, release, now)) {
          candidates.push({ annId: snapshot.annId, fetch: true, refetch: true });
        }
      }
    }
    return {
      candidates,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

type PageSyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      fetched: number;
      continued: boolean;
      errorCount: number;
      failed?: boolean;
      stopped?: true;
    };

/**
 * Open the release-page pass's run and schedule its first link in one
 * transaction: if scheduling fails, no run is left "running" (which would
 * make the dispatcher skip ANN until it counted as stranded).
 */
export const chainReleasePages = internalMutation({
  args: {
    afterRunId: v.id("importRuns"),
    politeDelayMs: v.optional(v.number()),
    /** The mirror finished failed: the page pass's success must not reset source health. */
    afterFailedMirror: v.optional(v.boolean()),
  },
  handler: async (ctx, { afterRunId, politeDelayMs, afterFailedMirror }) => {
    const runId = await openFollowOnRun(ctx, afterRunId, SOURCE_KEY);
    await ctx.scheduler.runAfter(0, internal.ann.syncReleasePages, {
      politeDelayMs,
      runId,
      ...(afterFailedMirror ? { afterFailedMirror: true } : {}),
    });
  },
});

/**
 * The release-page pass: walks every unlinked release line, fetches its
 * Encyclopedia page once (1 req/s), and places it (`applyReleasePage`).
 * Lines whose page is already stored are re-placed without a fetch — a
 * newly seeded publisher or Volume can unblock them. A linked line whose
 * Release lacks a description is fetched once more to offer the page's
 * (`descriptionRefetch`), at most DESCRIPTION_REFETCHES_PER_RUN per run.
 * Chained after each finished mirror, complete or errored; self-continues
 * after `maxFetches` fetches or LINK_BUDGET_MS, whichever comes first. Each
 * candidate page starts at the import gate (lib/importRuns.ts).
 *
 *   npx convex run ann:syncReleasePages '{}'
 */
export const syncReleasePages = internalAction({
  args: {
    politeDelayMs: v.optional(v.number()),
    /** Page fetches per invocation before continuing. */
    maxFetches: v.optional(v.number()),
    /** Description refetches per run (default DESCRIPTION_REFETCHES_PER_RUN). */
    maxRefetches: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    cursor: v.optional(v.union(v.string(), v.null())),
    refetched: v.optional(v.number()),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    fetched: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    /** Set by chainReleasePages after a failed mirror (see imports.finishRun). */
    afterFailedMirror: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<PageSyncResult> =>
    withExceptionCapture("ann.syncReleasePages", ctx, async () => {
      const source: Doc<"approvedSources"> | null = await ctx.runQuery(
        internal.importSources.getByKey,
        { key: SOURCE_KEY },
      );
      if (!source) return { skipped: "disabled" as const };
      const runId = await runToContinue(ctx, source, args);
      if (runId === null) return { skipped: "disabled" as const };
      const started = Date.now();
      const delay = args.politeDelayMs ?? ANN_DELAY_MS;
      const maxFetches = args.maxFetches ?? DEFAULT_MAX_FETCHES;
      const maxRefetches = args.maxRefetches ?? DESCRIPTION_REFETCHES_PER_RUN;
      const errors = [...(args.errors ?? [])];
      let seen = args.seen ?? 0;
      let changed = args.changed ?? 0;
      let fetchedTotal = args.fetched ?? 0;
      let refetched = args.refetched ?? 0;
      let cursor: string | null = args.cursor ?? null;
      let fetchedHere = 0;
      let done = false;

      try {
        pages: while (!done && fetchedHere < maxFetches) {
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, fetched: fetchedTotal, continued: false };
          const page: {
            candidates: Array<{ annId: string; fetch: boolean; refetch?: true }>;
            continueCursor: string;
            isDone: boolean;
          } = await ctx.runQuery(internal.ann.releasePageCandidates, {
            cursor,
            numItems: CANDIDATE_PAGE,
            now: Date.now(),
            refetches: refetched < maxRefetches,
          });
          for (const candidate of page.candidates) {
            if (candidate.refetch && refetched >= maxRefetches) continue;
            // Out of time (after at least one fetch, so every link makes
            // progress): hand off from this page's start. Its lines already
            // fetched are stored now and come back without a fetch.
            if (candidate.fetch && fetchedHere > 0 && Date.now() - started > LINK_BUDGET_MS) {
              break pages;
            }
            seen++;
            let state: PageState | undefined;
            if (candidate.fetch) {
              state = await fetchReleasePage(candidate.annId, delay);
              if (state.status === "error" || state.status === "unparsed") {
                errors.push(
                  `release ${candidate.annId}: ${state.error ?? "unrecognized release page"}`,
                );
              }
              fetchedHere++;
              fetchedTotal++;
              if (candidate.refetch) refetched++;
            }
            try {
              const result = await applyRetrying(ctx, internal.ann.applyReleasePage, {
                annId: candidate.annId,
                page: state,
              });
              if (result.changed) changed++;
            } catch (e) {
              errors.push(`release ${candidate.annId}: ${errorMessage(e)}`);
            }
          }
          cursor = page.continueCursor;
          done = page.isDone;
        }

        if (!done) {
          await stampHandOff(ctx, runId, { seen, changed, errors });
          await ctx.scheduler.runAfter(0, internal.ann.syncReleasePages, {
            politeDelayMs: args.politeDelayMs,
            maxFetches: args.maxFetches,
            maxRefetches: args.maxRefetches,
            cursor,
            refetched,
            runId,
            seen,
            changed,
            fetched: fetchedTotal,
            errors: errors.slice(0, MAX_CARRIED_ERRORS),
            afterFailedMirror: args.afterFailedMirror,
          });
          return {
            runId,
            recordsSeen: seen,
            recordsChanged: changed,
            fetched: fetchedTotal,
            continued: true,
            errorCount: errors.length,
          };
        }
        if (errors.length > 0) throw new Error("ANN release-page pass was incomplete");
        const totals = { seen, changed, errors, healthNeutral: args.afterFailedMirror };
        return {
          ...(await closeRun(ctx, runId, "succeeded", totals)),
          fetched: fetchedTotal,
          continued: false,
        };
      } catch (e) {
        errors.push(errorMessage(e));
        return {
          ...(await closeRun(ctx, runId, "failed", { seen, changed, errors })),
          fetched: fetchedTotal,
          continued: false,
        };
      }
    }),
});

/**
 * Fetch + parse one release page into its stored fetch state. The bytes
 * are decoded here (`decodeUtf8OrWindows1252`), not by `Response.text()`:
 * a legacy Windows-1252 byte inside ANN's UTF-8 page becomes its character
 * instead of an unrecoverable U+FFFD.
 */
async function fetchReleasePage(annId: string, delay: number): Promise<PageState> {
  const fetchedAt = Date.now();
  try {
    const res = await politeFetch(releaseUrl(annId), delay);
    const parsed = parseReleasePage(
      decodeUtf8OrWindows1252(new Uint8Array(await res.arrayBuffer())),
    );
    return parsed
      ? { status: "ok", fetchedAt, ...parsed, descriptionChecked: true }
      : { status: "unparsed", fetchedAt };
  } catch (e) {
    const message = errorMessage(e);
    return /HTTP 404\b/.test(message)
      ? { status: "notFound", fetchedAt }
      : { status: "error", fetchedAt, error: message.slice(0, 200) };
  }
}

type PlaceResult = {
  status:
    | "skipped"
    | "stored"
    | "filled"
    | "refreshed"
    | "cleared"
    | "held"
    | "linked"
    | "created"
    | "recordOnly";
  changed: boolean;
  reason?: string;
  releaseId?: Id<"releases">;
};

/**
 * The page's Description for a Release that has none (`blurbWanted`), as an
 * offer for reconcileFields at ANN's registry rank (weak): it only ever
 * fills a blank. A Release that has text (a publisher's, Open Library's, a
 * human's) or a Human Override on the field is offered nothing: weak text
 * could only be recorded or, against a human's, queue a review nobody needs.
 */
function descriptionOffer(
  page: PageState | undefined,
  release: Doc<"releases">,
): { description?: string } {
  const description = pageDescriptionText(page);
  return description !== undefined && blurbWanted(release) ? { description } : {};
}

/**
 * A page's Description as it may be written to a Release: the stored text
 * through `cleanAnnDescription`, so a page stored before the cleaner last
 * changed never writes stale text (credit tails, chrome, mojibake).
 */
export function pageDescriptionText(page: PageState | undefined): string | undefined {
  return page?.description !== undefined ? cleanAnnDescription(page.description) : undefined;
}

/** The citation a fact read from a release page carries. */
async function pageCitation(ctx: QueryCtx, annId: string) {
  const source = await getSourceByKey(ctx, SOURCE_KEY);
  return { sourceName: source?.name ?? SOURCE_NAME, url: releaseUrl(annId) };
}

/**
 * Place one release line from its page (freshly fetched, or the stored
 * one): link the Release carrying its ISBN, else create a leaf Release
 * under the linked Series' existing Volume when the Distributor resolves
 * to an existing publisher row. Everything the importer will not decide
 * stays on the observation as a placement note. A freshly fetched page of
 * an already LINKED line (the description refetch) is stored, and its
 * Description offered to the linked Release. One atomic mutation.
 */
export const applyReleasePage = internalMutation({
  args: {
    annId: v.string(),
    page: v.optional(pageStateValidator),
    /** Replace ANN's own text on the linked Release too (`fillLinked`). */
    refresh: v.optional(v.boolean()),
    /** With `refresh`: also clear it, or replace it with much shorter text. */
    allowClear: v.optional(v.boolean()),
  },
  handler: async (ctx, { annId, page: fetched, refresh, allowClear }): Promise<PlaceResult> => {
    const now = Date.now();
    let observation = await getObservation(ctx, SOURCE_KEY, `release:${annId}`);
    // A line ANN no longer lists stays withdrawn: storing a page would
    // mark it seen (upsertObservation) and retire its cancellation review.
    if (!observation || observation.withdrawn) return { status: "skipped", changed: false };
    if (observation.recordRef?.type === "release") {
      return await fillLinked(ctx, observation, observation.recordRef.id, fetched, now, {
        refresh: refresh === true,
        allowClear: allowClear === true,
      });
    }
    if (observation.recordRef !== undefined) return { status: "skipped", changed: false };
    let line = observation.snapshot as AnnReleaseSnapshot;
    let changed = false;
    if (fetched !== undefined) {
      line = { ...line, page: keptPage(line.page, fetched) };
      ({ observation } = await upsertObservation(ctx, {
        sourceKey: SOURCE_KEY,
        sourceRecordId: observation.sourceRecordId,
        snapshot: line,
        now,
      }));
      changed = true;
    }
    const page = line.page;
    if (page === undefined || page.status !== "ok") {
      return { status: fetched ? "stored" : "skipped", changed };
    }
    const citation = await pageCitation(ctx, annId);
    // `seriesId`: the line's active Series, once it is known. A null kind
    // keeps the reason for a line no one can place or that is out of scope,
    // off the Held Books list.
    const hold = async (
      kind: HoldKind | null,
      reason: string,
      seriesId?: Id<"series">,
    ): Promise<PlaceResult> => {
      const held = await recordUnplaced(
        ctx,
        observation!,
        { kind, reason, ...(seriesId !== undefined ? { seriesId } : {}) },
        now,
      );
      return { status: "recordOnly", changed: changed || held, reason };
    };

    const isbn13 = page.isbn13 ?? line.isbn13;
    if (isbn13 === undefined) return await hold(null, "ANN lists no ISBN for this release.");

    // The Series: the manga entry's rung-① link, through any repair merge.
    const mangaObs = await getObservation(ctx, SOURCE_KEY, `manga:${line.mangaId}`);
    const seriesRef = mangaObs?.recordRef;
    const series =
      seriesRef?.type === "series"
        ? await survivorOf<"series">(ctx, await ctx.db.get(seriesRef.id))
        : null;

    // An existing Release with the ISBN: link it (same Series only).
    const { active: byIsbn, hidden: isbnHidden } = await releaseByIsbn(ctx, isbn13);
    if (byIsbn && series && byIsbn.seriesIds.includes(series._id)) return await link(byIsbn);

    // A line out of scope is noted only, whatever else would hold it.
    const outOfScope = lineOutOfScope(line);
    if (outOfScope !== null) return await hold(null, outOfScope);

    // One an Editor hid is never recreated.
    if (!byIsbn && isbnHidden) {
      return await hold("isbn", `ISBN ${isbn13} is on a Release an Editor hid — not recreated.`);
    }
    if (byIsbn) {
      return await hold(
        "isbn",
        `ISBN ${isbn13} is already on a Release of another Series — a duplicate-Series question for an Editor.`,
      );
    }

    // A designator listing Volumes no range holds ("(GN 1, 3)") states its
    // coverage, so the line's name never sizes it and no Volume is guessed:
    // an Editor maps it.
    if (line.coverageGapped) {
      return await hold(
        "packaging",
        `"${line.title}" (${page.volume ?? "its designator"}) is packaging whose Volume list no range holds — an Editor maps it.`,
        series?.status === "active" ? series._id : undefined,
      );
    }

    // Packaging: an Edition Line member, never a Volume. A packaged line is
    // placed below by the best signal it carries: its stated range, from the
    // designator ("One Piece - [Omnibus] 33 - Wano (GN 97-99)" → volumes
    // 97–99) or the title ("Rurouni Kenshin - VIZBIG Edition [13-15]"), else
    // the line name's declared size (lib/coverage.ts: "[3-in-1 Edition]" or
    // "[VIZBIG Edition]" at GN 5 → 13–15, an implied size like VIZBIG's only
    // short of the line's end), else as Unmapped Packaging. A line titled
    // for another work or for no clear one, or a last book stating less
    // than the Series holds, is held. Box sets and variant covers still only
    // link by ISBN. The work's known titles keep its own name's line words
    // ("Makunouchi Deluxe") from naming its line.
    const entryTitle = (mangaObs?.snapshot as AnnMangaSnapshot | undefined)?.title ?? "";
    const workNames = series ? [series.title, entryTitle] : [entryTitle];
    const packaging = line.editionLineHint || line.multi ? packagingOf(line, workNames) : null;
    if ((line.multi || line.editionLineHint) && packaging === null) {
      return await hold(
        "packaging",
        "Packaging (omnibus/box set/deluxe) links by ISBN only; none matched.",
      );
    }
    if (!series || series.status !== "active") {
      return await hold("series", "The manga entry has no linked active Series.");
    }
    if (series.locked) return await hold("series", "The Series is locked.", series._id);

    const distributor = page.distributor;
    if (distributor === undefined)
      return await hold("other", "The release page names no distributor.", series._id);
    const publisher = await findPublisherByName(ctx, distributor);
    if (!publisher) {
      return await hold(
        "other",
        `Distributor "${distributor}" resolves to no publisher row.`,
        series._id,
      );
    }

    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    if (packaging !== null) {
      // A line titled for another work numbers that work's Volumes, stated
      // or not: ANN's Dragon Ball entry lists "Dragon Ball Z [VIZBIG
      // Edition]" too. The work is the title before its line's name, every
      // number and mark kept (lib/ann.ts readAnnLineTitle), and it must be
      // the Series' own title (lib/matching.ts sameWorkTitle): Citrus+ is
      // not Citrus, Kingdom Hearts II not Kingdom Hearts. The entry's title
      // proves nothing more: its Series link may be an old one, and where
      // it is the Series' title by the same rule it adds no spelling.
      const read = readAnnLineTitle(line.title, {
        names: workNames,
        packaged: line.editionLineHint,
      });
      if (read.kind === "ambiguous") {
        return await hold(
          "packaging",
          `"${line.title}" is packaging whose title ${read.reason}, so its work is unclear — an Editor places it.`,
          series._id,
        );
      }
      if (!sameWorkTitle(read.work, series.title)) {
        return await hold(
          "packaging",
          `"${line.title}" is packaging titled for another work than Series ${series.publicId} ("${series.title}"), or a spelling of it this check cannot confirm: its Volume numbers may be that work's — an Editor places it.`,
          series._id,
        );
      }
      // The end of the Series and of the line: the Series' highest Volume,
      // and ANN's own count of the line's books ("GN 9 / 9").
      const lastVolume = Math.max(
        0,
        ...volumes.filter((vol) => vol.status === "active").map((vol) => Number(vol.label) || 0),
      );
      const lastPosition = Number(/\/\s*(\d+)\s*$/.exec(page.volume ?? "")?.[1]) || undefined;
      // The line's last book takes what is left of the Series: one whose
      // stated range stops short of the Series' last Volume misstates it
      // ("Rurouni Kenshin - VIZBIG Edition [25-27]", GN 9 / 9, collects
      // 25–28). Never extended: an Editor maps it.
      const stated = line.coverRange;
      if (
        stated !== undefined &&
        Number(packaging.position) === lastPosition &&
        Number(stated.to) < lastVolume
      ) {
        return await hold(
          "packaging",
          `"${line.title}" (${page.volume}) is packaging, its line's last book, but the Volumes it states end at ${stated.to}, before the Series' ${lastVolume} — an Editor maps it.`,
          series._id,
        );
      }
      // A size the line's name only implies stops short of both ends, where
      // a book may hold more (lib/coverage.ts coverageFromLine).
      const range =
        stated ??
        coverageFromLine(packaging.name, packaging.position, { lastVolume, lastPosition });
      const labels = range ? rangeLabels(range) : [];
      // Leaf boundary holds for packaging too: every collected Volume must
      // already exist under the Series (the backbone the mirror built).
      const covered = labels.filter((label) =>
        volumes.some((vol) => vol.status === "active" && labelsEqual(vol.label, label)),
      );
      if (labels.length > 0 && covered.length !== labels.length) {
        return await hold(
          "volumeMissing",
          `${packaging.name} ${packaging.position ?? ""} would cover Volumes ${range!.from}–${range!.to}, but the Series lacks ${labels.filter((l) => !covered.includes(l)).join(", ")}.`,
          series._id,
        );
      }
      const unmapped = labels.length === 0;
      // An Edition-Line-shaped creation is a steady-state review gate
      // (pipeline.ts creationGates, as catalogTitle applies it); Bootstrap
      // Mode creates it and tags it for the post-launch backlog.
      if (!(await getBootstrapMode(ctx))) {
        return await hold(
          "packaging",
          unmapped
            ? `${packaging.name} of unknown size: steady state leaves unmapped packaging to review.`
            : `${packaging.name} ${packaging.position ?? ""}: steady state leaves Edition Line creation to review.`,
          series._id,
        );
      }
      const packagedDate = page.date ?? line.date;
      const creation = await createCanonicalRecords(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        seriesId: series._id,
        seriesTitle: series.title,
        labels,
        editionLine: { name: packaging.name, position: packaging.position },
        ...(unmapped ? { coverageUnmapped: true as const } : {}),
        release: {
          format: line.format,
          isbn13,
          isbn10: page.isbn10,
          pubDate: packagedDate ? toPartialDate(packagedDate) : undefined,
          price:
            page.priceCents !== undefined
              ? { amountCents: page.priceCents, currency: "USD" }
              : undefined,
          description: pageDescriptionText(page),
          publisher: { name: publisher.name, slug: publisher.slug },
        },
        tagBootstrapUnreviewed: true,
        now,
      });
      return { status: "created", changed: true, releaseId: creation.releaseId };
    }
    // Leaf boundary: the Volume must already exist under the Series.
    const volume = volumes.find(
      (vol) => vol.status === "active" && labelsEqual(vol.label, line.label ?? null),
    );
    if (!volume) {
      return await hold(
        "volumeMissing",
        `No Volume ${line.label ?? "(unlabeled)"} under the Series.`,
        series._id,
      );
    }

    // One Release per (Volume, publisher, format): a same-format sibling
    // without an ISBN is this book (link); one with another ISBN is a
    // reprint or variant — held, never a second Release. Only ordinary
    // whole-Volume Editions count: an omnibus, a split part, or a line's
    // packaging covering this Volume is another book, neither this line's
    // Release nor a reason to hold it.
    const coverages = await coveringOf(ctx, volume._id);
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active" || edition.publisherId !== publisher._id) {
        continue;
      }
      if (!(await isWholeSingleVolume(ctx, edition))) continue;
      const releases = await releasesOf(ctx, edition._id);
      for (const release of releases) {
        if (release.status !== "active" || release.format !== line.format) continue;
        if (release.isbn13 === undefined && !release.locked) return await link(release);
        return await hold(
          "isbn",
          `Volume ${line.label ?? "(unlabeled)"} already has a ${line.format} ${publisher.name} Release (ISBN ${release.isbn13 ?? "none"}): a reprint or variant, not created.`,
          series._id,
        );
      }
    }

    const date = page.date ?? line.date;
    const creation = await createCanonicalRecords(ctx, {
      sourceKey: SOURCE_KEY,
      observation,
      citation,
      importComment: IMPORT_COMMENT,
      seriesId: series._id,
      seriesTitle: series.title,
      labels: line.label !== undefined ? [line.label] : [],
      release: {
        format: line.format,
        isbn13,
        isbn10: page.isbn10,
        pubDate: date ? toPartialDate(date) : undefined,
        price:
          page.priceCents !== undefined
            ? { amountCents: page.priceCents, currency: "USD" }
            : undefined,
        description: pageDescriptionText(page),
        publisher: { name: publisher.name, slug: publisher.slug },
      },
      tagBootstrapUnreviewed: false,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };

    async function link(release: Doc<"releases">): Promise<PlaceResult> {
      await linkObservation(ctx, observation!._id, { type: "release", id: release._id });
      const date = page!.date ?? line.date;
      const offered: Record<string, unknown> = { ...descriptionOffer(page, release) };
      if (date) offered.pubDate = toPartialDate(date);
      // The page's ISBN fills a linked Release that has none (never another's).
      if (release.isbn13 === undefined && isbn13 !== undefined && !(await isbnTaken(ctx, isbn13))) {
        offered.isbn13 = isbn13;
      }
      if (Object.keys(offered).length > 0 && !release.locked) {
        await reconcileFields(ctx, {
          sourceKey: SOURCE_KEY,
          ref: { type: "release", id: release._id },
          doc: release,
          offered,
          observation: observation!,
          citation,
          now,
        });
      }
      return { status: "linked", changed: true, releaseId: release._id };
    }
  },
});

/**
 * Offer a linked line's page Description to its Release
 * (`descriptionOffer`): a refetched page is stored first (`keptPage`);
 * without one, the stored page's text is offered (read while the line was
 * unlinked, or before an override was cleared). Nothing else is reconciled
 * here: the line's date and ISBN reach the Release through the mirror.
 * With `refresh` and a freshly fetched ok page, a Release whose current
 * text ANN wrote from this line gets the page's cleaned text instead
 * (`rewriteOwnDescription`: never a publisher's, Open Library's or a
 * human's text). A page with no description, or one that would leave
 * less than half of the current text, is held (a degraded page must not
 * blank a good blurb) unless `allowClear`, which clears or shrinks it.
 */
async function fillLinked(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  releaseId: Id<"releases">,
  fetched: PageState | undefined,
  now: number,
  { refresh, allowClear }: { refresh: boolean; allowClear: boolean },
): Promise<PlaceResult> {
  const line = observation.snapshot as AnnReleaseSnapshot;
  let stored = observation;
  let page = line.page;
  if (fetched !== undefined) {
    page = keptPage(line.page, fetched);
    ({ observation: stored } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: observation.sourceRecordId,
      snapshot: { ...line, page },
      now,
    }));
  }
  const changed = fetched !== undefined;
  const release = await ctx.db.get(releaseId);
  if (
    refresh &&
    fetched?.status === "ok" &&
    release !== null &&
    release.description !== undefined
  ) {
    const text = pageDescriptionText(page);
    const shrinks = text === undefined || text.length < release.description.length / 2;
    if (shrinks && !allowClear && text !== release.description) {
      return { status: "held", changed, releaseId };
    }
    const rewritten = await rewriteOwnDescription(ctx, {
      sourceKey: SOURCE_KEY,
      observation: stored,
      release,
      text,
      citation: await pageCitation(ctx, line.annId),
      now,
    });
    const status =
      rewritten === "cleared" ? "cleared" : rewritten === "updated" ? "refreshed" : "stored";
    return { status, changed, releaseId };
  }
  const offered = release !== null ? descriptionOffer(page, release) : {};
  if (release === null || offered.description === undefined) {
    return { status: changed ? "stored" : "skipped", changed, releaseId };
  }
  const result = await reconcileFields(ctx, {
    sourceKey: SOURCE_KEY,
    ref: { type: "release", id: release._id },
    doc: release,
    offered,
    observation: stored,
    citation: await pageCitation(ctx, line.annId),
    now,
  });
  return {
    status: result.applied.includes("description") ? "filled" : "stored",
    changed: true,
    releaseId,
  };
}

// ---------- the description backfill ----------

/** Release lines scanned per lookup for linked ones still missing a description. */
const BACKFILL_SCAN = 200;
/** Lines handed to the action per lookup. */
const BACKFILL_BATCH = 25;
/** Consecutive failed fetches that mean ANN is down: the backfill stops. */
const BACKFILL_MAX_FAILURES = 5;

/**
 * Up to BACKFILL_BATCH linked, unwithdrawn release lines after `after`
 * whose Release wants a description (`blurbWanted`), in source-record-id
 * order, and where to look next (null once the range is exhausted). A line
 * whose stored page already holds a Description needs no fetch (`fetch:
 * false`); otherwise it is listed when its page is worth one
 * (`descriptionRefetch`).
 */
export const descriptionlessLines = internalQuery({
  args: { after: v.union(v.string(), v.null()), now: v.number() },
  handler: async (ctx, { after, now }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gt("sourceRecordId", after ?? "release:")
          .lt("sourceRecordId", "release;"),
      )
      .take(BACKFILL_SCAN);
    const lines: Array<{ annId: string; sourceRecordId: string; fetch: boolean }> = [];
    let next: string | null = null;
    for (const doc of docs) {
      next = doc.sourceRecordId;
      if (doc.withdrawn || doc.recordRef?.type !== "release") continue;
      const line = doc.snapshot as AnnReleaseSnapshot;
      if (!/^\d+$/.test(line.annId)) continue;
      const release = await ctx.db.get(doc.recordRef.id);
      if (release === null || !blurbWanted(release)) continue;
      const stored = pageDescriptionText(line.page) !== undefined;
      if (!stored && !descriptionRefetch(line.page, release, now)) continue;
      lines.push({ annId: line.annId, sourceRecordId: doc.sourceRecordId, fetch: !stored });
      if (lines.length === BACKFILL_BATCH) break;
    }
    const exhausted = docs.length < BACKFILL_SCAN && next === docs.at(-1)?.sourceRecordId;
    return { lines, next: exhausted ? null : next };
  },
});

/**
 * The latest ANN Import Run when it is still "running": its id and when it
 * opened and was last active. The backfill decides whether it blocks
 * (lib/importRuns.ts isStranded).
 *
 * A backfill action deployed before heartbeats passes `now` and reads
 * `ageMs`, holding off while it is at most 12 hours. It gets the time since
 * the run was last active, so it holds off while the chain is alive. The
 * argument and the field can go once no such action can still be running.
 */
export const annRunInProgress = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now }) => {
    const latest = await ctx.db
      .query("importRuns")
      .withIndex("by_source", (q) => q.eq("sourceKey", SOURCE_KEY))
      .order("desc")
      .first();
    if (latest?.status !== "running") return null;
    return {
      runId: latest._id,
      _creationTime: latest._creationTime,
      lastActivityAt: latest.lastActivityAt,
      ...(now === undefined ? {} : { ageMs: now - lastActiveAt(latest) }),
    };
  },
});

/** "3 h 12 min" for a refusal message. */
function age(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

type BackfillResult = {
  /** Pages fetched so far, across every link of the chain. */
  fetched: number;
  /** Releases that received a description, across every link. */
  filled: number;
  /** With `refresh`: Releases whose ANN text was replaced. */
  refreshed?: number;
  /** With `refresh` + `allowClear`: Releases whose ANN text was cleared. */
  cleared?: number;
  /** With `refresh`: pages with no or much shorter text, left alone (see `allowClear`). */
  held?: number;
  /** This link's failures (fetch failures are stored on the line, not here). */
  errors: string[];
  continued: boolean;
  /** Why the backfill stopped before finishing (a running sync, ANN down). */
  stopped?: string;
};

/**
 * Give Releases linked to ANN release lines the page Description they never
 * got, instead of waiting for the weekly page pass to reach them: walk the
 * linked lines whose Release has no description (`descriptionlessLines`),
 * offer a Description the line's stored page already holds without a
 * fetch, else fetch the page at ANN's 1 req/s, store it on the line, and
 * offer its Description (`applyReleasePage`, at ANN's weak rank: it only
 * fills blanks). `limit` caps the pages fetched in total; `annIds` fetches
 * exactly those release pages instead of walking (even ones already
 * checked; the fill rule still applies, and an unlinked line is placed as
 * the page pass would). Continues itself in fresh actions until done or
 * the limit is spent; safe to rerun.
 *
 * Polite by construction: it refuses to run while an ANN Import Run is
 * running (the two would double the request rate) unless that run is
 * stranded (lib/importRuns.ts isStranded: a dead chain, not a live crawl;
 * the hourly tick closes it), stops after
 * BACKFILL_MAX_FAILURES consecutive failed fetches across its links (ANN
 * is down; a failed refetch never replaces a stored page), and never
 * touches a withdrawn line. A stop is logged with its reason, since a
 * continuation link's return value is seen by nobody. Like
 * people.backfillAnnCredits this is an explicit operator command: it runs
 * whatever the source's enabled flag says and opens no Import Run.
 * `refresh` replaces text ANN already wrote on the named pages
 * (`fillLinked`); `ann:listRefreshCandidates` names the pages worth it.
 *
 *   npx convex run ann:backfillDescriptions '{"limit": 300}'
 *   npx convex run ann:backfillDescriptions '{"annIds": ["10948", "23227"]}'
 *   npx convex run ann:backfillDescriptions '{"annIds": ["49313"], "refresh": true}'
 */
export const backfillDescriptions = internalAction({
  args: {
    limit: v.optional(v.number()),
    annIds: v.optional(v.array(v.string())),
    /**
     * With `annIds`: also replace text ANN already wrote on those Releases
     * with the freshly fetched, cleaned page text (or clear it when the
     * page has none). Never touches anyone else's text.
     */
    refresh: v.optional(v.boolean()),
    /**
     * With `refresh`: also clear a Release whose page now has no
     * description, or replace its text with one under half as long.
     * Without it such pages are held and counted, never applied.
     */
    allowClear: v.optional(v.boolean()),
    /** Pause before every request; tests pass 0. Defaults to ANN's 1 req/s. */
    politeDelayMs: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    fetched: v.optional(v.number()),
    filled: v.optional(v.number()),
    refreshed: v.optional(v.number()),
    cleared: v.optional(v.number()),
    held: v.optional(v.number()),
    /** Consecutive failed fetches so far, so the breaker spans hand-offs. */
    failures: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BackfillResult> => {
    const started = Date.now();
    const delay = args.politeDelayMs ?? ANN_DELAY_MS;
    const limit = args.limit ?? Number.POSITIVE_INFINITY;
    let fetched = args.fetched ?? 0;
    let filled = args.filled ?? 0;
    let refreshed = args.refreshed ?? 0;
    let cleared = args.cleared ?? 0;
    let held = args.held ?? 0;
    let failures = args.failures ?? 0;
    if (args.allowClear && !args.refresh) throw new Error("allowClear only applies with refresh.");
    if (args.refresh && args.annIds === undefined) {
      throw new Error(
        "refresh needs annIds: it rewrites only the pages you name (see ann:listRefreshCandidates).",
      );
    }
    let handled = 0;
    const errors: string[] = [];
    const result = (extra: { continued: boolean; stopped?: string }) => ({
      fetched,
      filled,
      ...(args.refresh ? { refreshed, cleared, held } : {}),
      errors,
      ...extra,
    });
    const stop = (stopped: string) => {
      console.warn(`[ann.backfillDescriptions] stopped: ${stopped}`);
      return result({ continued: false, stopped });
    };

    const running = await ctx.runQuery(internal.ann.annRunInProgress, {});
    const now = Date.now();
    if (running !== null && !isStranded(running, now)) {
      return stop(
        `An ANN Import Run (${running.runId}, last active ${age(now - lastActiveAt(running))} ago) is running; the backfill would double the request rate to ANN. Rerun it once the run finishes.`,
      );
    }
    if (running !== null) {
      console.warn(
        `[ann.backfillDescriptions] ignoring stranded ANN Import Run ${running.runId} (last active ${age(now - lastActiveAt(running))} ago)`,
      );
    }

    // Offer a line's Description: from a fresh fetch, or (`fetch` false)
    // from its stored page.
    const fill = async (annId: string, fetch: boolean) => {
      handled++;
      let page: PageState | undefined;
      if (fetch) {
        page = await fetchReleasePage(annId, delay);
        fetched++;
        failures = page.status === "error" || page.status === "unparsed" ? failures + 1 : 0;
      }
      try {
        const applied = await applyRetrying(ctx, internal.ann.applyReleasePage, {
          annId,
          page,
          ...(args.refresh ? { refresh: true } : {}),
          ...(args.allowClear ? { allowClear: true } : {}),
        });
        if (applied.status === "filled") filled++;
        if (applied.status === "refreshed") refreshed++;
        if (applied.status === "cleared") cleared++;
        if (applied.status === "held") held++;
      } catch (e) {
        errors.push(`release ${annId}: ${errorMessage(e)}`);
      }
    };
    const down = () =>
      failures >= BACKFILL_MAX_FAILURES
        ? `ANN looks down: ${failures} page fetches in a row failed. Rerun the backfill later.`
        : null;
    // Every link handles at least one line before it may hand off.
    const outOfTime = () => handled > 0 && Date.now() - started > LINK_BUDGET_MS;
    const continueWith = async (rest: { after?: string; annIds?: string[] }) => {
      await ctx.scheduler.runAfter(0, internal.ann.backfillDescriptions, {
        limit: args.limit,
        politeDelayMs: args.politeDelayMs,
        ...(args.refresh ? { refresh: true, refreshed, cleared, held } : {}),
        ...(args.allowClear ? { allowClear: true } : {}),
        fetched,
        filled,
        failures,
        ...rest,
      });
      return result({ continued: true });
    };

    if (args.annIds !== undefined) {
      const ids = [...new Set(args.annIds.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
      for (let i = 0; i < ids.length && fetched < limit; i++) {
        if (outOfTime()) return await continueWith({ annIds: ids.slice(i) });
        await fill(ids[i]!, true);
        const stopped = down();
        if (stopped) return stop(stopped);
      }
      return result({ continued: false });
    }

    // `cursor` trails the last line handled, so a continuation resumes
    // right after it.
    let cursor: string | null = args.after ?? null;
    while (fetched < limit) {
      const batch: {
        lines: Array<{ annId: string; sourceRecordId: string; fetch: boolean }>;
        next: string | null;
      } = await ctx.runQuery(internal.ann.descriptionlessLines, { after: cursor, now: Date.now() });
      for (const line of batch.lines) {
        if (line.fetch && fetched >= limit) break;
        if (outOfTime()) return await continueWith({ after: cursor ?? undefined });
        await fill(line.annId, line.fetch);
        cursor = line.sourceRecordId;
        const stopped = down();
        if (stopped) return stop(stopped);
      }
      if (batch.next === null) break;
      cursor = batch.next;
    }
    return result({ continued: false });
  },
});

// ---------- the description repair ----------

/**
 * Up to REPAIR_SCAN release lines after `after`, and the ones whose stored
 * page Description or linked Release text the cleaner would change.
 */
export const repairCandidates = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gt("sourceRecordId", after ?? "release:")
          .lt("sourceRecordId", "release;"),
      )
      .take(REPAIR_SCAN);
    return await descriptionRepairWork(
      ctx,
      docs,
      (doc) => (doc.snapshot as AnnReleaseSnapshot).page?.description,
      cleanAnnDescription,
    );
  },
});

/**
 * Repair one release line: its stored page Description re-cleaned, and its
 * linked Release's text rewritten or cleared when ANN wrote it from this
 * line (`repairLinkedDescription`). The Release is judged by its own text,
 * whatever the snapshot says, so one skipped while locked is fixed on a
 * rerun.
 */
export const repairDescriptionLine = internalMutation({
  args: { observationId: v.id("sourceObservations") },
  handler: async (ctx, { observationId }): Promise<DescriptionRepair> => {
    const observation = await ctx.db.get(observationId);
    if (observation === null) return { snapshotFixed: false, release: null };
    const line = observation.snapshot as AnnReleaseSnapshot;
    const page = line.page ? recleaned(line.page, cleanAnnDescription) : null;
    if (page !== null) await ctx.db.patch(observation._id, { snapshot: { ...line, page } });
    const release = await repairLinkedDescription(ctx, observation, {
      sourceKey: SOURCE_KEY,
      clean: cleanAnnDescription,
      sourceName: SOURCE_NAME,
      url: releaseUrl(line.annId),
    });
    return { snapshotFixed: page !== null, release };
  },
});

/**
 * Re-clean every stored ANN release-page Description with today's
 * `cleanAnnDescription` and repair the Releases still showing ANN's text
 * (`repairDescriptionLine`), with no network. A refetch never replaces weak
 * text that filled a blank, so this is how already-written descriptions
 * get fixed. Safe beside a running `backfillDescriptions` and safe to
 * rerun: clean text cleans to itself.
 *
 *   npx convex run ann:repairDescriptions '{}'
 */
export const repairDescriptions = internalAction({
  args: {
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    counts: v.optional(repairCountsValidator),
  },
  handler: (ctx, args): ReturnType<typeof runDescriptionRepair> =>
    runDescriptionRepair(ctx, args, {
      label: "ann.repairDescriptions",
      noun: "line",
      budgetMs: LINK_BUDGET_MS,
      candidates: internal.ann.repairCandidates,
      repair: internal.ann.repairDescriptionLine,
      self: internal.ann.repairDescriptions,
    }),
});

// ---------- refresh candidates ----------

/** Why a line's Release text is worth a refresh (`ann:listRefreshCandidates`). */
type RefreshReason = "danglingEnd" | "replacementChar" | "c1Control";
type RefreshLine = { annId: string; reason: RefreshReason };

/**
 * Text cut mid-phrase, the endings an earlier credit rule left ("…save the
 * Child and himself. Based on the series", "Created by Masashi Kishimoto
 * and features", "Or will it? Originally"). It also matches text ANN itself
 * truncated, which a refresh leaves as it is.
 */
const DANGLING_END =
  /(?:\bBased on the (?:series|manga|novel|anime|game|film|movie)|\band features|\bfeaturing|\b(?:and|with|by|of|the|from|a|an|to)|[.!?…]\s+(?:Originally|Based|Created|Written|Story|Art|Adapted))$/i;

/** What a refresh could fix in a Release text ANN wrote, if anything. */
function refreshReason(text: string): RefreshReason | null {
  if (DANGLING_END.test(text)) return "danglingEnd";
  if (text.includes("\uFFFD")) return "replacementChar";
  if (/[\u0080-\u009F]/.test(text)) return "c1Control";
  return null;
}

/**
 * Up to REPAIR_SCAN release lines after `after` whose linked Release shows
 * text ANN wrote from that line with a `refreshReason`, and where to look
 * next (null once exhausted).
 */
export const refreshCandidates = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gt("sourceRecordId", after ?? "release:")
          .lt("sourceRecordId", "release;"),
      )
      .take(REPAIR_SCAN);
    const lines: RefreshLine[] = [];
    for (const doc of docs) {
      if (doc.withdrawn || doc.recordRef?.type !== "release") continue;
      const line = doc.snapshot as AnnReleaseSnapshot;
      if (!/^\d+$/.test(line.annId)) continue;
      const release = await ctx.db.get(doc.recordRef.id);
      if (release === null || typeof release.description !== "string") continue;
      const reason = refreshReason(release.description);
      if (reason === null) continue;
      const evidence = await descriptionEvidence(ctx, release, SOURCE_KEY);
      if (evidence?.includes(doc._id)) lines.push({ annId: line.annId, reason });
    }
    const last = docs.at(-1);
    return { lines, next: docs.length < REPAIR_SCAN || !last ? null : last.sourceRecordId };
  },
});

/**
 * The ANN release ids whose Release text is worth a refresh, by reason, so
 * an operator refreshes those pages and not the whole catalog. Read-only,
 * no network. `danglingEnd`: cut mid-phrase (`DANGLING_END`).
 * `replacementChar`: U+FFFD, which ANN often serves itself; a refresh helps
 * only where the page has legacy bytes `decodeUtf8OrWindows1252` reads.
 * `c1Control`: `ann:repairDescriptions` fixes these offline. Then:
 *
 *   npx convex run ann:listRefreshCandidates '{}'
 *   npx convex run ann:backfillDescriptions '{"annIds": [...], "refresh": true}'
 */
export const listRefreshCandidates = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<RefreshReason, string[]>> => {
    const found: Record<RefreshReason, string[]> = {
      danglingEnd: [],
      replacementChar: [],
      c1Control: [],
    };
    let cursor: string | null = null;
    do {
      const batch: { lines: RefreshLine[]; next: string | null } = await ctx.runQuery(
        internal.ann.refreshCandidates,
        { after: cursor },
      );
      for (const { annId, reason } of batch.lines) found[reason].push(annId);
      cursor = batch.next;
    } while (cursor !== null);
    console.log(
      `[ann.listRefreshCandidates] ${JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, ids]) => [k, ids.length])))}`,
    );
    return found;
  },
});
