// The ANN Encyclopedia adapter (ticket #36, spec §6/§7): the weekly full
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

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import {
  annMangaValidator,
  parseApiResponse,
  parseReleasePage,
  parseReport,
  releaseUrl,
  toSnapshot,
  type AnnMangaSnapshot,
  type AnnReleasePage,
} from "./lib/ann";
import { errorMessage, politeFetch } from "./lib/http";
import { applyRetrying } from "./lib/occ";
import { openFollowOnRun, runToContinue } from "./lib/importRuns";
import { canonicalLabel, parseBookTitle, rangeLabels } from "./lib/bookTitle";
import { coverageFromLine } from "./lib/coverage";
import {
  candidateSeries,
  isWholeSingleVolume,
  labelsEqual,
  survivorOf,
  workMatch,
  type WorkEvidence,
} from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  blurbWanted,
  findPublisherByName,
  queueCreationProposal,
  recordUnplaced,
  removedSeriesFor,
  toPartialDate,
} from "./lib/pipeline";
import { reconcileFields } from "./lib/reconcile";
import { withExceptionCapture } from "./lib/posthog";

export const SOURCE_KEY = "ann";
const REPORT_URL = "https://www.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=manga";
const API_URL = "https://cdn.animenewsnetwork.com/encyclopedia/api.xml";
const IMPORT_COMMENT = "Imported from the Anime News Network Encyclopedia.";

/** ANN's rate limit is 1 req/s; stay comfortably under it. */
const ANN_DELAY_MS = 1100;
/** Manga ids per api.xml request (ANN's documented batch maximum). */
const BATCH_SIZE = 50;
/** Report page size — one report fetch covers several detail batches. */
const REPORT_PAGE = 500;
/** Errors carried across continuation links (finishRun caps at 50 anyway). */
const MAX_CARRIED_ERRORS = 50;

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
    };

/**
 * One link of the weekly mirror chain. Called with no args by the cadence
 * dispatcher; continuation links carry the run state.
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
      // Explicit annotations break the type cycle with imports.ts's adapter map.
      const source: Doc<"approvedSources"> | null = await ctx.runQuery(
        internal.importSources.getByKey,
        { key: SOURCE_KEY },
      );
      if (!source) {
        throw new Error(
          "The approved-source registry has no \"ann\" row. Run: npx convex run importSources:seedRegistry '{}'",
        );
      }
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
          let ids: string[];
          let rawCount: number;
          if (targeted) {
            // One pass over the named entries; the report is never read.
            ids = [...new Set(args.onlyManga!.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
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
          // The full mirror completed: entries the sweep no longer lists have
          // disappeared at ANN → withdrawn (spec §6; retained, never deleted).
          await ctx.runMutation(internal.imports.markWithdrawn, {
            sourceKey: SOURCE_KEY,
            notSeenSince: runStartedAt,
          });
        } else if (!complete) {
          errors.push("ANN mirror was incomplete; withdrawal skipped");
        }
        await ctx.runMutation(internal.imports.finishRun, {
          runId,
          status: complete ? "succeeded" : "failed",
          recordsSeen: seen,
          recordsChanged: changed,
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
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          continued: false,
          errorCount: errors.length,
          ...(complete ? {} : { failed: true }),
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

// ---------- release-line snapshots ----------

/** Fetch state of a line's Encyclopedia page, stored on its observation. */
const pageStateValidator = v.object({
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
  title: v.optional(v.string()),
  volume: v.optional(v.string()),
  distributor: v.optional(v.string()),
  distributorId: v.optional(v.string()),
  date: v.optional(
    v.object({
      year: v.number(),
      month: v.optional(v.number()),
      day: v.optional(v.number()),
    }),
  ),
  isbn13: v.optional(v.string()),
  isbn10: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  mangaId: v.optional(v.string()),
  description: v.optional(v.string()),
  /**
   * The page was parsed by a reader that looks for its Description: set on
   * every ok fetch since descriptions were imported, so a page without one
   * is not refetched for it again. Older ok pages lack it.
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

type FailedStatus = "notFound" | "unparsed" | "error";

type PageState = AnnReleasePage & {
  status: "ok" | FailedStatus;
  fetchedAt: number;
  error?: string;
  descriptionChecked?: true;
  refetchFailed?: { status: FailedStatus; at: number };
};

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
  const hits = await ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .collect();
  const resolved = await Promise.all(hits.map((hit) => survivorOf<"releases">(ctx, hit)));
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
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      if (!(await isWholeSingleVolume(ctx, edition))) continue;
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
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
    const sourceName = source?.name ?? "Anime News Network Encyclopedia";
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
          await ctx.db.patch(observation._id, {
            recordRef: { type: "series", id: series._id },
          });
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
      const evidence: WorkEvidence = {
        books: snapshot.releases.flatMap((r) =>
          r.isbn13 ? [{ isbn13: r.isbn13, format: r.format }] : [],
        ),
        annPersonIds: (snapshot.credits ?? []).map((c) => c.personId),
      };
      const sameWork = async (found: Doc<"series">[]) => {
        const kept: Doc<"series">[] = [];
        for (const series of found) {
          if ((await workMatch(ctx, series._id, evidence)) !== "different") kept.push(series);
        }
        return kept;
      };
      let candidates = await sameWork(await candidateSeries(ctx, snapshot.title));
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
        candidates = await sameWork([...byAlt.values()]);
      }
      if (candidates.length === 1) {
        seriesId = candidates[0]!._id;
        await ctx.db.patch(observation._id, {
          recordRef: { type: "series", id: seriesId },
        });
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
          await recordUnplaced(ctx, observation, removed.reason, now);
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
          comment: `"${snapshot.title}" observed at ${sourceName} needs a brand-new Series — steady-state creation gate. Series + Volume backbone only; ANN carries no publisher, so Releases arrive from other sources.`,
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
      await ctx.db.patch(observation._id, {
        recordRef: { type: "series", id: seriesId },
      });
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
          await ctx.db.patch(releaseObs._id, {
            recordRef: { type: "release", id: canonical._id },
          });
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
// so it is skipped rather than reported as a missing publisher row (#48).
const FOREIGN_DISTRIBUTORS =
  /^(?:kana|panini(?: comics| manga)?|bruno gm[üu]nder(?: verlag)?|glénat|glenat|carlsen(?: manga)?|egmont(?: manga)?|pika(?: [ée]dition)?|ki-oon|tokyopop gmbh|star comics|planeta(?: c[oó]mic)?|norma editorial|ivrea)$/i;

// A store-exclusive or variant cover is a second ISBN of the same volume
// ("Jujutsu Kaisen - [Walmart Exclusive Cover] (GN 30)"): never a leaf.
const VARIANT_LINE = /\b(?:exclusive|variant)\b/i;

/**
 * ANN's packaged line titles come in two shapes: "Naruto [3-in-1 Edition]"
 * (the designator number is the line position) and "One Piece - [Omnibus]
 * 33 - Wano" (the position follows the tag; the designator holds the volume
 * range). Both yield the line name and position; a bare "(GN 1-3)" range
 * with no tag is an Omnibus. Box sets are bundles, never lines: null.
 */
function packagingOf(line: {
  title: string;
  label?: string;
  multi: boolean;
  coverRange?: { from: string; to: string };
}): { name: string; position: string | null } | null {
  const tagged =
    /^(.+?)\s*(?:[-–—:]\s*)?\[([^\]]+)\]\s*(\d+(?:\.\d+)?)?(?:\s*[-–—:]\s*.*)?$/.exec(line.title);
  const probe = tagged ? `${tagged[1]!.trim()} [${tagged[2]!.trim()}]` : line.title;
  const parsed = parseBookTitle(probe);
  if (parsed.isBox) return null;
  const name = parsed.packaging?.lineName ?? (line.multi && line.coverRange ? "Omnibus" : null);
  if (name === null) return null;
  const position = tagged?.[3] ?? line.label ?? null;
  return { name, position: position === null ? null : canonicalLabel(position) };
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
    };

/**
 * Open the release-page pass's run and schedule its first link in one
 * transaction: if scheduling fails, no run is left "running" (which would
 * make the dispatcher skip ANN until someone repaired it).
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
 * after `maxFetches` fetches or LINK_BUDGET_MS, whichever comes first.
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
        await ctx.runMutation(internal.imports.finishRun, {
          runId,
          status: "succeeded",
          recordsSeen: seen,
          recordsChanged: changed,
          errors,
          healthNeutral: args.afterFailedMirror,
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          fetched: fetchedTotal,
          continued: false,
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
          fetched: fetchedTotal,
          continued: false,
          errorCount: errors.length,
          failed: true,
        };
      }
    }),
});

/** Fetch + parse one release page into its stored fetch state. */
async function fetchReleasePage(annId: string, delay: number): Promise<PageState> {
  const fetchedAt = Date.now();
  try {
    const res = await politeFetch(releaseUrl(annId), delay);
    const parsed = parseReleasePage(await res.text());
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
  status: "skipped" | "stored" | "filled" | "linked" | "created" | "recordOnly";
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
  return page?.description !== undefined && blurbWanted(release)
    ? { description: page.description }
    : {};
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
  args: { annId: v.string(), page: v.optional(pageStateValidator) },
  handler: async (ctx, { annId, page: fetched }): Promise<PlaceResult> => {
    const now = Date.now();
    let observation = await getObservation(ctx, SOURCE_KEY, `release:${annId}`);
    // A line ANN no longer lists stays withdrawn: storing a page would
    // mark it seen (upsertObservation) and retire its cancellation review.
    if (!observation || observation.withdrawn) return { status: "skipped", changed: false };
    if (observation.recordRef?.type === "release") {
      return await fillLinked(ctx, observation, observation.recordRef.id, fetched, now);
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
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const citation = {
      sourceName: source?.name ?? "Anime News Network Encyclopedia",
      url: releaseUrl(annId),
    };
    const hold = async (reason: string): Promise<PlaceResult> => {
      const current = (observation!.conflicts ?? []).find((c) => c.field === "placement");
      if (current?.reason !== reason) {
        await recordUnplaced(ctx, observation!, reason, now);
        changed = true;
      }
      return { status: "recordOnly", changed, reason };
    };

    const isbn13 = page.isbn13 ?? line.isbn13;
    if (isbn13 === undefined) return await hold("ANN lists no ISBN for this release.");

    // The Series: the manga entry's rung-① link, through any repair merge.
    const mangaObs = await getObservation(ctx, SOURCE_KEY, `manga:${line.mangaId}`);
    const seriesRef = mangaObs?.recordRef;
    const series =
      seriesRef?.type === "series"
        ? await survivorOf<"series">(ctx, await ctx.db.get(seriesRef.id))
        : null;

    // An existing Release with the ISBN: link it (same Series only). One an
    // Editor hid is never recreated.
    const { active: byIsbn, hidden: isbnHidden } = await releaseByIsbn(ctx, isbn13);
    if (!byIsbn && isbnHidden) {
      return await hold(`ISBN ${isbn13} is on a Release an Editor hid — not recreated.`);
    }
    if (byIsbn) {
      if (!series || !byIsbn.seriesIds.includes(series._id)) {
        return await hold(
          `ISBN ${isbn13} is already on a Release of another Series — a duplicate-Series question for an Editor.`,
        );
      }
      return await link(byIsbn);
    }

    // Packaging: an Edition Line member, never a Volume. A packaged line is
    // placed below by the best signal it carries: the designator's stated
    // range ("One Piece - [Omnibus] 33 - Wano (GN 97-99)" → volumes 97–99),
    // else the line name's declared size (lib/coverage.ts: "[3-in-1
    // Edition]" at GN 5 → 13–15), else as Unmapped Packaging. Box sets and
    // variant covers still only link by ISBN.
    const packaging = line.editionLineHint || line.multi ? packagingOf(line) : null;
    if ((line.multi || line.editionLineHint) && packaging === null) {
      return await hold("Packaging (omnibus/box set/deluxe) links by ISBN only; none matched.");
    }
    if (VARIANT_LINE.test(line.title)) {
      return await hold("A store-exclusive or variant cover: never a Release of its own.");
    }
    if (!series || series.status !== "active") {
      return await hold("The manga entry has no linked active Series.");
    }
    if (series.locked) return await hold("The Series is locked.");

    const distributor = page.distributor;
    if (distributor === undefined) return await hold("The release page names no distributor.");
    if (NOVEL_DISTRIBUTORS.test(distributor)) {
      return await hold(`"${distributor}" is a prose imprint: out of manga scope.`);
    }
    if (FOREIGN_DISTRIBUTORS.test(distributor.trim())) {
      return await hold(`"${distributor}" publishes in another language: out of English scope.`);
    }
    const publisher = await findPublisherByName(ctx, distributor);
    if (!publisher) {
      return await hold(`Distributor "${distributor}" resolves to no publisher row.`);
    }

    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    if (packaging !== null) {
      const range = line.coverRange ?? coverageFromLine(packaging.name, packaging.position);
      const labels = range ? rangeLabels(range) : [];
      // Leaf boundary holds for packaging too: every collected Volume must
      // already exist under the Series (the backbone the mirror built).
      const covered = labels.filter((label) =>
        volumes.some((vol) => vol.status === "active" && labelsEqual(vol.label, label)),
      );
      if (labels.length > 0 && covered.length !== labels.length) {
        return await hold(
          `${packaging.name} ${packaging.position ?? ""} would cover Volumes ${range!.from}–${range!.to}, but the Series lacks ${labels.filter((l) => !covered.includes(l)).join(", ")}.`,
        );
      }
      const unmapped = labels.length === 0;
      // An Edition-Line-shaped creation is a steady-state review gate
      // (pipeline.ts creationGates, as catalogTitle applies it); Bootstrap
      // Mode creates it and tags it for the post-launch backlog.
      if (!(await getBootstrapMode(ctx))) {
        return await hold(
          unmapped
            ? `${packaging.name} of unknown size: steady state leaves unmapped packaging to review.`
            : `${packaging.name} ${packaging.position ?? ""}: steady state leaves Edition Line creation to review.`,
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
          description: page.description,
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
      return await hold(`No Volume ${line.label ?? "(unlabeled)"} under the Series.`);
    }

    // One Release per (Volume, publisher, format): a same-format sibling
    // without an ISBN is this book (link); one with another ISBN is a
    // reprint or variant — held, never a second Release. Only ordinary
    // whole-Volume Editions count: an omnibus, a split part, or a line's
    // packaging covering this Volume is another book, neither this line's
    // Release nor a reason to hold it.
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active" || edition.publisherId !== publisher._id) {
        continue;
      }
      if (!(await isWholeSingleVolume(ctx, edition))) continue;
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      for (const release of releases) {
        if (release.status !== "active" || release.format !== line.format) continue;
        if (release.isbn13 === undefined && !release.locked) return await link(release);
        return await hold(
          `Volume ${line.label ?? "(unlabeled)"} already has a ${line.format} ${publisher.name} Release (ISBN ${release.isbn13 ?? "none"}): a reprint or variant, not created.`,
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
        description: page.description,
        publisher: { name: publisher.name, slug: publisher.slug },
      },
      tagBootstrapUnreviewed: false,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };

    async function link(release: Doc<"releases">): Promise<PlaceResult> {
      await ctx.db.patch(observation!._id, {
        recordRef: { type: "release", id: release._id },
      });
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
 */
async function fillLinked(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  releaseId: Id<"releases">,
  fetched: PageState | undefined,
  now: number,
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
  const offered = release !== null ? descriptionOffer(page, release) : {};
  if (release === null || offered.description === undefined) {
    return { status: changed ? "stored" : "skipped", changed, releaseId };
  }
  const source = await getSourceByKey(ctx, SOURCE_KEY);
  const result = await reconcileFields(ctx, {
    sourceKey: SOURCE_KEY,
    ref: { type: "release", id: release._id },
    doc: release,
    offered,
    observation: stored,
    citation: {
      sourceName: source?.name ?? "Anime News Network Encyclopedia",
      url: releaseUrl(line.annId),
    },
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
      const stored = line.page?.description !== undefined;
      if (!stored && !descriptionRefetch(line.page, release, now)) continue;
      lines.push({ annId: line.annId, sourceRecordId: doc.sourceRecordId, fetch: !stored });
      if (lines.length === BACKFILL_BATCH) break;
    }
    const exhausted = docs.length < BACKFILL_SCAN && next === docs.at(-1)?.sourceRecordId;
    return { lines, next: exhausted ? null : next };
  },
});

/**
 * A "running" ANN Import Run older than this is stranded (its chain died
 * without closing it), not live: a full mirror plus page pass takes hours.
 */
const STRANDED_RUN_MS = 12 * 60 * 60 * 1000;

/**
 * The latest ANN Import Run when it is still "running": its id and age.
 * The backfill decides whether it blocks (`STRANDED_RUN_MS`).
 */
export const annRunInProgress = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const latest = await ctx.db
      .query("importRuns")
      .withIndex("by_source", (q) => q.eq("sourceKey", SOURCE_KEY))
      .order("desc")
      .first();
    return latest?.status === "running"
      ? { runId: latest._id, ageMs: now - latest._creationTime }
      : null;
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
 * running (the two would double the request rate) unless that run is older
 * than STRANDED_RUN_MS (a dead chain, not a live crawl), stops after
 * BACKFILL_MAX_FAILURES consecutive failed fetches across its links (ANN
 * is down; a failed refetch never replaces a stored page), and never
 * touches a withdrawn line. A stop is logged with its reason, since a
 * continuation link's return value is seen by nobody. Like people.backfillAnnCredits this is an explicit operator
 * command: it runs whatever the source's enabled flag says and opens no
 * Import Run.
 *
 *   npx convex run ann:backfillDescriptions '{"limit": 300}'
 *   npx convex run ann:backfillDescriptions '{"annIds": ["10948", "23227"]}'
 */
export const backfillDescriptions = internalAction({
  args: {
    limit: v.optional(v.number()),
    annIds: v.optional(v.array(v.string())),
    /** Pause before every request; tests pass 0. Defaults to ANN's 1 req/s. */
    politeDelayMs: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    after: v.optional(v.string()),
    fetched: v.optional(v.number()),
    filled: v.optional(v.number()),
    /** Consecutive failed fetches so far, so the breaker spans hand-offs. */
    failures: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BackfillResult> => {
    const started = Date.now();
    const delay = args.politeDelayMs ?? ANN_DELAY_MS;
    const limit = args.limit ?? Number.POSITIVE_INFINITY;
    let fetched = args.fetched ?? 0;
    let filled = args.filled ?? 0;
    let failures = args.failures ?? 0;
    let handled = 0;
    const errors: string[] = [];
    const result = (extra: { continued: boolean; stopped?: string }) => ({
      fetched,
      filled,
      errors,
      ...extra,
    });
    const stop = (stopped: string) => {
      console.warn(`[ann.backfillDescriptions] stopped: ${stopped}`);
      return result({ continued: false, stopped });
    };

    const running: { runId: Id<"importRuns">; ageMs: number } | null = await ctx.runQuery(
      internal.ann.annRunInProgress,
      { now: Date.now() },
    );
    if (running !== null && running.ageMs <= STRANDED_RUN_MS) {
      return stop(
        `An ANN Import Run (${running.runId}, started ${age(running.ageMs)} ago) is running; the backfill would double the request rate to ANN. Rerun it once the run finishes.`,
      );
    }
    if (running !== null) {
      console.warn(
        `[ann.backfillDescriptions] ignoring stranded ANN Import Run ${running.runId} (started ${age(running.ageMs)} ago)`,
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
        const applied = await applyRetrying(ctx, internal.ann.applyReleasePage, { annId, page });
        if (applied.status === "filled") filled++;
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
