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
// once (Distributor, ISBNs, date, SRP — stored on the observation as
// `page`, the fetch state that keeps the pass incremental) and places it
// through the pipeline: an existing Release with the ISBN links; otherwise
// a LEAF Release (Edition + Release) is created under the linked Series'
// existing Volume when the Distributor resolves to an existing publisher
// row — the OpenLibrary rung-⑤ boundary. ANN never creates a Series or
// Volume this way, never a publisher, never packaging (omnibus/box-set
// lines link by ISBN only), and never a second same-format Release of one
// Volume from one publisher (reprints/variants stay on the observation).
// Authority is unchanged: PRH and publisher feeds stay authoritative for
// ISBN and date and overwrite what ANN created.

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
import { openFollowOnRun, runToContinue } from "./lib/importRuns";
import { canonicalLabel } from "./lib/bookTitle";
import { candidateSeries, labelsEqual, survivorOf } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  findPublisherByName,
  queueCreationProposal,
  recordUnplaced,
  removedSeriesFor,
  toPartialDate,
} from "./lib/pipeline";
import { reconcileFields } from "./lib/reconcile";

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
  handler: async (ctx, args): Promise<SyncResult> => {
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

    try {
      let batchesDone = 0;
      let reachedEnd = false;

      while (batchesDone < maxBatches && !reachedEnd) {
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
        const rawCount = report.rawCount;
        // A row without id/name is an entry this sweep cannot see: skipped
        // so the enumeration goes on, reported so withdrawal stays off.
        for (const at of report.malformed) {
          errors.push(`report @${nskip + at}: item without id/name`);
        }
        const ids = report.items.map((item) => item.id);
        if (rawCount === 0) {
          // A well-formed but empty FIRST page is not an empty catalog: the
          // clean sweep would otherwise withdraw every ANN observation.
          if (nskip === 0) throw new Error("ANN report enumeration was empty");
          reachedEnd = true;
          break;
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
                const result = await ctx.runMutation(internal.ann.applyManga, {
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
      if (complete) {
        // The full mirror completed: entries the sweep no longer lists have
        // disappeared at ANN → withdrawn (spec §6; retained, never deleted).
        await ctx.runMutation(internal.imports.markWithdrawn, {
          sourceKey: SOURCE_KEY,
          notSeenSince: runStartedAt,
        });
      } else {
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
  },
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
});

type PageState = AnnReleasePage & {
  status: "ok" | "notFound" | "unparsed" | "error";
  fetchedAt: number;
  error?: string;
};

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
 * label and format, and only onto a Release dated within a year of it. ANN
 * lists every North American printing of a volume; linking them all to one
 * Release made their dates overwrite each other. Exactly one clean
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
      const editionCoverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      if (editionCoverage.length !== 1) continue;
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
      const candidates = await candidateSeries(ctx, snapshot.title);
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
      // other Release already holds that ISBN.
      const offered: Record<string, unknown> = {};
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

// Distributor strings that are prose imprints: their lines never create
// manga Releases, whatever their designator says.
const NOVEL_DISTRIBUTORS = /^(?:yen on|j-novel club novels?|seven seas airship|airship)$/i;

// A store-exclusive or variant cover is a second ISBN of the same volume
// ("Jujutsu Kaisen - [Walmart Exclusive Cover] (GN 30)"): never a leaf.
const VARIANT_LINE = /\b(?:exclusive|variant)\b/i;

/** Whether a line needs (another) page fetch, per its stored fetch state. */
function needsFetch(page: PageState | undefined, now: number): boolean {
  if (page === undefined) return true;
  if (page.status === "ok") return false;
  const retry = page.status === "error" ? ERROR_RETRY_MS : GONE_RETRY_MS;
  return now - page.fetchedAt > retry;
}

/**
 * One page of unlinked release lines, in source-record-id order. Linked
 * lines drop out, so a later pass only touches new or still-unplaced ones.
 */
export const releasePageCandidates = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    now: v.number(),
  },
  handler: async (ctx, { cursor, numItems, now }) => {
    const result = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gte("sourceRecordId", "release:")
          .lt("sourceRecordId", "release;"),
      )
      .paginate({ cursor, numItems });
    const candidates = result.page.flatMap((obs) => {
      if (obs.recordRef !== undefined || obs.withdrawn) return [];
      const snapshot = obs.snapshot as AnnReleaseSnapshot;
      // Content-derived ids (a line without an href) have no page.
      if (!/^\d+$/.test(snapshot.annId)) return [];
      return [{ annId: snapshot.annId, fetch: needsFetch(snapshot.page, now) }];
    });
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
 * newly seeded publisher or Volume can unblock them. Chained after each
 * finished mirror, complete or errored; self-continues across the action
 * time limit.
 *
 *   npx convex run ann:syncReleasePages '{}'
 */
export const syncReleasePages = internalAction({
  args: {
    politeDelayMs: v.optional(v.number()),
    /** Page fetches per invocation before continuing. */
    maxFetches: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    cursor: v.optional(v.union(v.string(), v.null())),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    fetched: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    /** Set by chainReleasePages after a failed mirror (see imports.finishRun). */
    afterFailedMirror: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<PageSyncResult> => {
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) return { skipped: "disabled" as const };
    const runId = await runToContinue(ctx, source, args);
    if (runId === null) return { skipped: "disabled" as const };
    const delay = args.politeDelayMs ?? ANN_DELAY_MS;
    const maxFetches = args.maxFetches ?? DEFAULT_MAX_FETCHES;
    const errors = [...(args.errors ?? [])];
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;
    let fetchedTotal = args.fetched ?? 0;
    let cursor: string | null = args.cursor ?? null;
    let fetchedHere = 0;
    let done = false;

    try {
      while (!done && fetchedHere < maxFetches) {
        const page: {
          candidates: Array<{ annId: string; fetch: boolean }>;
          continueCursor: string;
          isDone: boolean;
        } = await ctx.runQuery(internal.ann.releasePageCandidates, {
          cursor,
          numItems: CANDIDATE_PAGE,
          now: Date.now(),
        });
        for (const candidate of page.candidates) {
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
          }
          try {
            const result = await ctx.runMutation(internal.ann.applyReleasePage, {
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
          cursor,
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
  },
});

/** Fetch + parse one release page into its stored fetch state. */
async function fetchReleasePage(annId: string, delay: number): Promise<PageState> {
  const fetchedAt = Date.now();
  try {
    const res = await politeFetch(releaseUrl(annId), delay);
    const parsed = parseReleasePage(await res.text());
    return parsed ? { status: "ok", fetchedAt, ...parsed } : { status: "unparsed", fetchedAt };
  } catch (e) {
    const message = errorMessage(e);
    return /HTTP 404\b/.test(message)
      ? { status: "notFound", fetchedAt }
      : { status: "error", fetchedAt, error: message.slice(0, 200) };
  }
}

type PlaceResult = {
  status: "skipped" | "stored" | "linked" | "created" | "recordOnly";
  changed: boolean;
  reason?: string;
  releaseId?: Id<"releases">;
};

/**
 * Place one release line from its page (freshly fetched, or the stored
 * one): link the Release carrying its ISBN, else create a leaf Release
 * under the linked Series' existing Volume when the Distributor resolves
 * to an existing publisher row. Everything the importer will not decide
 * stays on the observation as a placement note. One atomic mutation.
 */
export const applyReleasePage = internalMutation({
  args: { annId: v.string(), page: v.optional(pageStateValidator) },
  handler: async (ctx, { annId, page: fetched }): Promise<PlaceResult> => {
    const now = Date.now();
    let observation = await getObservation(ctx, SOURCE_KEY, `release:${annId}`);
    if (!observation || observation.recordRef !== undefined) {
      return { status: "skipped", changed: false };
    }
    let line = observation.snapshot as AnnReleaseSnapshot;
    let changed = false;
    if (fetched !== undefined) {
      line = { ...line, page: fetched };
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

    if (line.multi || line.editionLineHint) {
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
    const publisher = await findPublisherByName(ctx, distributor);
    if (!publisher) {
      return await hold(`Distributor "${distributor}" resolves to no publisher row.`);
    }

    // Leaf boundary: the Volume must already exist under the Series.
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    const volume = volumes.find(
      (vol) => vol.status === "active" && labelsEqual(vol.label, line.label ?? null),
    );
    if (!volume) {
      return await hold(`No Volume ${line.label ?? "(unlabeled)"} under the Series.`);
    }

    // One Release per (Volume, publisher, format): a same-format sibling
    // without an ISBN is this book (link); one with another ISBN is a
    // reprint or variant — held, never a second Release.
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active" || edition.publisherId !== publisher._id) {
        continue;
      }
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
      const offered: Record<string, unknown> = {};
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
