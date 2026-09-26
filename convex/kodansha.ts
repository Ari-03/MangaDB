// The Kodansha adapter (ticket #36, spec §6/§7): Kodansha's own catalog
// through the shared pipeline, from two feeds that share one observation
// per (volume, format) and one apply path (`applyVolume`: observation →
// matching ladder → authority reconciliation → creation/queue, as in
// sevenSeas.ts; the shared halves live in lib/pipeline.ts):
//
// - `sync` (daily, registry row "kodansha"): the first-party JSON window —
//   the release calendar (~8 weekly buckets of upcoming volumes) plus this
//   week's new-releases list. No ISBNs or prices; covers are stored.
// - `backlistSync` (weekly, registry row "kodansha-backlist"): the back
//   catalog. Enumerates every comic series from `search-series`, reads each
//   series page's volume list and each volume page's JSON-LD — print and
//   digital ISBNs, per-format dates, list prices — at 1 req/s. The ISBN
//   drives the ladder (rung ② first), so the crawl links PRH/ANN records
//   and fills ISBNs on calendar-created Releases; unmatched volumes follow
//   the standard creation boundaries. It never downloads covers: with an
//   ISBN, the site's cover lookup finds the art (README "Covers"). The
//   series blurb (series page, else listing) rides on each volume snapshot
//   and is offered as the Series synopsis; the calendar keeps it.
//
// The backlist is incremental and resumable. Each series' crawl state is an
// observation of its own under "kodansha-backlist" (lib/kodansha.ts
// `seriesCrawlValidator`): a series is re-crawled whole when new, when its
// listing `last_updated_at` changes, or after 180 days, and only its
// upcoming/recent/undated volumes (plus new ones) on the weekly check. A
// run spends a bounded number of fetches per action invocation and chains
// itself under one Import Run (cursor = the last series handled).
//
// Both feeds share one scope gate: a novel, children's picture book, or
// other non-manga volume (lib/kodansha.ts `outOfScope`) is observed and
// never placed. The crawl never even fetches Kodansha's ~310 novel-type series.
//
// Neither feed is a withdrawal sweep: the calendar is a rolling window, and
// the crawl skips fresh series, so absence proves nothing.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import { errorMessage, politeFetch } from "./lib/http";
import { runToContinue } from "./lib/importRuns";
import {
  crawlMode,
  kodanshaSnapshotValidator,
  LISTING_PAGE_SIZE,
  needsRecheck,
  parseCalendar,
  parseNewReleases,
  parseSeriesListing,
  parseSeriesPage,
  parseSeriesSynopsis,
  parseVolumePage,
  seriesCrawlValidator,
  sourceRecordId,
  toBacklistSnapshots,
  toSnapshots,
  volumesToFetch,
  type KodanshaItem,
  type KodanshaSnapshot,
  type SeriesCrawl,
  type SeriesListingEntry,
} from "./lib/kodansha";
import { candidateSeries, matchRelease, type ReleaseFact } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  creationGates,
  linkSeriesObservation,
  publisherBySlug,
  queueCreationProposal,
  reconcileLinkedSeries,
  removedSeriesFor,
  recordUnplaced,
  toPartialDate,
} from "./lib/pipeline";
import type { CanonicalPublisher } from "./lib/publishers";
import { reconcileFields } from "./lib/reconcile";
import { sameValue } from "./lib/values";

export const SOURCE_KEY = "kodansha";
/** The backlist crawl's registry row: its runs, cadence, health, and crawl state. */
export const BACKLIST_KEY = "kodansha-backlist";
const BASE_URL = "https://kodansha.us";
const PUBLISHER: CanonicalPublisher = { name: "Kodansha", slug: "kodansha" };
const VERTICAL: CanonicalPublisher = {
  name: "Vertical",
  slug: "vertical",
  parentSlug: "kodansha",
};
const IMPORT_COMMENT = "Imported from Kodansha.";

/** One request per second, like ANN and Yen Press. */
const BACKLIST_DELAY_MS = 1100;
/** Page fetches per action invocation before it hands off (~1.1 s each). */
const DEFAULT_MAX_FETCHES = 200;
/** Series whose crawl state one planning query reads. */
const PLAN_CHUNK = 100;
/** Listing pages read before giving up (1,170 series = 12 pages). */
const MAX_LISTING_PAGES = 40;
/** Errors carried across continuation links. */
const MAX_CARRIED_ERRORS = 50;

// ---------- the daily window ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One Kodansha window run: two JSON fetches, then one apply mutation per
 * (volume, format). Runs daily per the registry cadence.
 *
 *   npx convex run kodansha:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        "The approved-source registry has no \"kodansha\" row. Run: npx convex run importSources:seedRegistry '{}'",
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const runId: Id<"importRuns"> = await ctx.runMutation(internal.imports.startRun, {
      sourceKey: SOURCE_KEY,
    });
    const delay = args.politeDelayMs ?? 350;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;
    let failures = 0;

    try {
      // Merge the two endpoints keyed by (volume, format): the calendar has
      // the ~8-week window; new-releases refines this week with per-format
      // flags and an exact ISO date, so it wins on overlap.
      const items = new Map<string, { item: KodanshaItem; snapshot: KodanshaSnapshot }>();
      const ingest = (list: KodanshaItem[]) => {
        for (const item of list) {
          for (const snapshot of toSnapshots(item)) {
            items.set(sourceRecordId(item, snapshot.format), {
              item,
              snapshot,
            });
          }
        }
      };
      const calendarRes = await politeFetch(
        `${BASE_URL}/wp-json/kodansha/v1/release-calendar`,
        delay,
      );
      ingest(parseCalendar(await calendarRes.json()));
      const newRes = await politeFetch(`${BASE_URL}/wp-json/kodansha/v1/new-releases`, delay);
      ingest(parseNewReleases(await newRes.json()));

      for (const [recordId, { snapshot }] of items) {
        seen++;
        try {
          const result = await ctx.runMutation(internal.kodansha.applyVolume, {
            sourceRecordId: recordId,
            snapshot,
          });
          if (result.changed) changed++;
          if (result.status === "needsReview") {
            errors.push(`review ${recordId}: ${result.reason ?? "conflict"}`);
          }
          if (result.coverNeeded && result.releaseId && snapshot.coverUrl) {
            try {
              const imgRes = await politeFetch(snapshot.coverUrl, delay);
              const storageId = await ctx.storage.store(await imgRes.blob());
              await ctx.runMutation(internal.imports.attachCover, {
                releaseId: result.releaseId,
                storageId,
                sourceUrl: snapshot.coverUrl,
                attribution: source.attribution ?? PUBLISHER.name,
              });
            } catch (e) {
              errors.push(`cover ${recordId}: ${errorMessage(e)}`);
            }
          }
        } catch (e) {
          failures++;
          errors.push(`volume ${recordId}: ${errorMessage(e)}`);
        }
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: failures > 0 ? "failed" : "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        errorCount: errors.length,
        ...(failures > 0 ? { failed: true } : {}),
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
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- the backlist crawl ----------

/**
 * Which of these series are due, and how much of each (lib/kodansha.ts
 * `crawlMode`), with the stored crawl state the volume selection needs.
 */
export const backlistPlan = internalQuery({
  args: {
    entries: v.array(v.object({ slug: v.string(), lastUpdatedAt: v.string() })),
    now: v.number(),
  },
  handler: async (ctx, { entries, now }) => {
    const due: Array<{
      slug: string;
      mode: "full" | "recheck";
      state: SeriesCrawl | null;
    }> = [];
    for (const entry of entries) {
      const obs = await getObservation(ctx, BACKLIST_KEY, entry.slug);
      const state = obs
        ? { snapshot: obs.snapshot as SeriesCrawl, crawledAt: obs.lastSeenAt }
        : null;
      const mode = crawlMode(entry, state, now);
      if (mode !== null) {
        due.push({
          slug: entry.slug,
          mode,
          state: state
            ? {
                ...state.snapshot,
                fullCrawledAt: state.snapshot.fullCrawledAt ?? state.crawledAt,
              }
            : null,
        });
      }
    }
    return due;
  },
});

/**
 * Remember one finished series crawl; the observation's lastSeenAt is the
 * crawl time. `fullCrawledAt` is bookkeeping, not a fact about the series:
 * a crawl that found nothing else changed patches it in place, so a routine
 * full refresh never writes a snapshot-history row.
 */
export const recordSeriesCrawl = internalMutation({
  args: { slug: v.string(), crawl: seriesCrawlValidator },
  handler: async (ctx, { slug, crawl }) => {
    const now = Date.now();
    const existing = await getObservation(ctx, BACKLIST_KEY, slug);
    const stored = existing?.snapshot as SeriesCrawl | undefined;
    if (existing && sameValue({ ...stored, fullCrawledAt: crawl.fullCrawledAt }, crawl)) {
      await ctx.db.patch(existing._id, { snapshot: crawl, lastSeenAt: now, withdrawn: false });
      return;
    }
    await upsertObservation(ctx, {
      sourceKey: BACKLIST_KEY,
      sourceRecordId: slug,
      snapshot: crawl,
      now,
    });
  },
});

/** Every in-scope comic series, alphabetical by slug (~12 requests). */
async function fetchListing(delay: number): Promise<SeriesListingEntry[]> {
  const bySlug = new Map<string, SeriesListingEntry>();
  let offset = 0;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const res = await politeFetch(
      `${BASE_URL}/wp-json/kodansha/v1/search-series?offset=${offset}&count=${LISTING_PAGE_SIZE}`,
      delay,
    );
    const { entries, pageLength, total } = parseSeriesListing(await res.json());
    if (page === 0 && pageLength === 0) {
      throw new Error("search-series returned no series — listing shape changed?");
    }
    for (const entry of entries) bySlug.set(entry.slug, entry);
    offset += pageLength;
    if ((total !== undefined && offset >= total) || (total === undefined && pageLength === 0)) {
      return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    }
    if (pageLength === 0) {
      throw new Error(`search-series ended at ${offset} before its total ${total}`);
    }
  }
  throw new Error(`search-series exceeded ${MAX_LISTING_PAGES} pages; listing is incomplete`);
}

type BacklistResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      seriesCrawled: number;
      fetched: number;
      continued: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One link of a Kodansha backlist run. Called with no args by the cadence
 * dispatcher (weekly); continuation links carry the run state. The first
 * run crawls every series (~860 series pages + ~5.3k volume pages, ~2 h at
 * 1 req/s); later runs touch only changed or still-moving series.
 *
 *   npx convex run kodansha:backlistSync '{}'
 */
export const backlistSync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** Page fetches per invocation before continuing (a series in progress finishes). */
    maxFetches: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    afterSlug: v.optional(v.string()),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    seriesCrawled: v.optional(v.number()),
    fetched: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    failures: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BacklistResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: BACKLIST_KEY },
    );
    if (!source) {
      throw new Error(
        "The approved-source registry has no \"kodansha-backlist\" row. Run: npx convex run importSources:seedRegistry '{}'",
      );
    }
    // The shared gate: disabling the row stops a scheduled crawl at its next
    // link (the run closes as "stopped"); an operator-forced run finishes.
    const runId = await runToContinue(ctx, source, args);
    if (runId === null) return { skipped: "disabled" as const };
    const delay = args.politeDelayMs ?? BACKLIST_DELAY_MS;
    const maxFetches = args.maxFetches ?? DEFAULT_MAX_FETCHES;
    const errors = [...(args.errors ?? [])];
    let failures = args.failures ?? 0;
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;
    let seriesCrawled = args.seriesCrawled ?? 0;
    let fetchedTotal = args.fetched ?? 0;
    let fetchedHere = 0;
    let lastSlug = args.afterSlug;

    const finish = async (status: "succeeded" | "failed"): Promise<BacklistResult> => {
      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status,
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        seriesCrawled,
        fetched: fetchedTotal,
        continued: false,
        errorCount: errors.length,
        ...(status === "failed" ? { failed: true } : {}),
      };
    };

    try {
      const listing = (await fetchListing(delay)).filter(
        (entry) => args.afterSlug === undefined || entry.slug > args.afterSlug,
      );

      let budgetSpent = false;
      for (let offset = 0; offset < listing.length && !budgetSpent; offset += PLAN_CHUNK) {
        const chunk = listing.slice(offset, offset + PLAN_CHUNK);
        const due: Array<{
          slug: string;
          mode: "full" | "recheck";
          state: SeriesCrawl | null;
        }> = await ctx.runQuery(internal.kodansha.backlistPlan, {
          entries: chunk.map(({ slug, lastUpdatedAt }) => ({
            slug,
            lastUpdatedAt,
          })),
          now: Date.now(),
        });
        const plans = new Map(due.map((plan) => [plan.slug, plan]));

        for (const entry of chunk) {
          const plan = plans.get(entry.slug);
          if (!plan) {
            lastSlug = entry.slug;
            continue;
          }
          if (fetchedHere >= maxFetches) {
            budgetSpent = true;
            break;
          }

          // The series page: its volume list and blurb.
          const seriesUrl = `${BASE_URL}/series/${entry.slug}/`;
          fetchedHere++;
          fetchedTotal++;
          let volumes: string[];
          let synopsis: string | undefined;
          try {
            const html = await (await politeFetch(seriesUrl, delay)).text();
            volumes = parseSeriesPage(html, entry.slug);
            synopsis = parseSeriesSynopsis(html) ?? entry.synopsis;
          } catch (e) {
            // Unrecorded, so the series stays due and is retried next run.
            failures++;
            errors.push(`series ${entry.slug}: ${errorMessage(e)}`);
            lastSlug = entry.slug;
            continue;
          }

          // Its volume pages: one apply per (volume, format).
          const recheck: string[] = [];
          for (const volumeSlug of volumesToFetch(plan.mode, plan.state, volumes)) {
            const url = `${seriesUrl}${volumeSlug}/`;
            fetchedHere++;
            fetchedTotal++;
            try {
              const page = parseVolumePage(await (await politeFetch(url, delay)).text(), url);
              if (page === null || needsRecheck(page.offers, Date.now())) recheck.push(volumeSlug);
              if (page === null) continue;
              for (const { sourceRecordId: recordId, snapshot } of toBacklistSnapshots(
                page,
                synopsis,
              )) {
                seen++;
                try {
                  const result = await ctx.runMutation(internal.kodansha.applyVolume, {
                    sourceRecordId: recordId,
                    snapshot,
                  });
                  if (result.changed) changed++;
                  if (result.status === "needsReview") {
                    errors.push(`review ${recordId}: ${result.reason ?? "conflict"}`);
                  }
                } catch (e) {
                  // Retried at the next weekly check, not the 180-day refresh.
                  if (!recheck.includes(volumeSlug)) recheck.push(volumeSlug);
                  failures++;
                  errors.push(`volume ${recordId}: ${errorMessage(e)}`);
                }
              }
            } catch (e) {
              const message = errorMessage(e);
              // A dead link (404) waits for the next full crawl; anything
              // else is retried at the next weekly check.
              if (!message.startsWith("HTTP 404")) recheck.push(volumeSlug);
              failures++;
              errors.push(`page ${url}: ${message}`);
            }
          }

          await ctx.runMutation(internal.kodansha.recordSeriesCrawl, {
            slug: entry.slug,
            crawl: {
              kind: "kodanshaSeriesCrawl",
              name: entry.name,
              url: seriesUrl,
              lastUpdatedAt: entry.lastUpdatedAt,
              volumes,
              recheck,
              fullCrawledAt: plan.mode === "full" ? Date.now() : plan.state?.fullCrawledAt,
            },
          });
          seriesCrawled++;
          lastSlug = entry.slug;
        }
      }

      if (budgetSpent) {
        await ctx.scheduler.runAfter(0, internal.kodansha.backlistSync, {
          politeDelayMs: args.politeDelayMs,
          maxFetches: args.maxFetches,
          afterSlug: lastSlug,
          runId,
          seen,
          changed,
          seriesCrawled,
          fetched: fetchedTotal,
          errors: errors.slice(0, MAX_CARRIED_ERRORS),
          failures,
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          seriesCrawled,
          fetched: fetchedTotal,
          continued: true,
          errorCount: errors.length,
          ...(failures > 0 ? { failed: true } : {}),
        };
      }
      return await finish(failures > 0 ? "failed" : "succeeded");
    } catch (e) {
      errors.push(errorMessage(e));
      return await finish("failed");
    }
  },
});

// ---------- applying one (volume, format) ----------

type ApplyResult = {
  status:
    | "unchanged"
    | "created"
    | "updated"
    | "linked"
    | "queued"
    | "alreadyQueued"
    | "needsReview"
    | "recordOnly";
  changed: boolean;
  releaseId?: Id<"releases">;
  coverNeeded?: boolean;
  reason?: string;
};

/** The fields this source offers on a linked Release, in canonical form. */
function offeredReleaseFields(snapshot: KodanshaSnapshot): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  if (snapshot.releaseDate) offered.pubDate = toPartialDate(snapshot.releaseDate);
  if (snapshot.isbn13 !== undefined) offered.isbn13 = snapshot.isbn13;
  if (snapshot.priceCents !== undefined) {
    offered.price = { amountCents: snapshot.priceCents, currency: "USD" };
  }
  if (snapshot.binding !== undefined) offered.binding = snapshot.binding;
  return offered;
}

/**
 * The calendar never carries ISBNs, prices, or series blurbs, and its date
 * is the calendar bucket's: when a volume page already gave this record its
 * ISBN, a calendar snapshot keeps the page's facts (title, ISBN, binding,
 * price, per-format date, series synopsis) instead of erasing them, so the
 * two feeds never flip-flop.
 */
async function withPageFacts(
  ctx: MutationCtx,
  recordId: string,
  snapshot: KodanshaSnapshot,
): Promise<KodanshaSnapshot> {
  if (snapshot.isbn13 !== undefined) return snapshot;
  const stored = (await getObservation(ctx, SOURCE_KEY, recordId))?.snapshot as
    KodanshaSnapshot | undefined;
  if (stored?.isbn13 === undefined) return snapshot;
  return {
    ...snapshot,
    title: stored.title,
    isbn13: stored.isbn13,
    binding: stored.binding,
    priceCents: stored.priceCents,
    releaseDate: stored.releaseDate ?? snapshot.releaseDate,
    seriesSynopsis: snapshot.seriesSynopsis ?? stored.seriesSynopsis,
  };
}

/**
 * Reconcile one normalized (volume, format) snapshot into the canonical
 * catalog — one atomic mutation per record (spec §6). Mirrors
 * sevenSeas.applyBook on the shared pipeline; a snapshot with an ISBN
 * (volume pages) matches by ISBN first. Each feed gates itself on its own
 * registry row ("kodansha" / "kodansha-backlist"); authority is always the
 * "kodansha" row's.
 */
export const applyVolume = internalMutation({
  args: { sourceRecordId: v.string(), snapshot: kodanshaSnapshotValidator },
  handler: async (ctx, args): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? PUBLISHER.name;
    const snapshot = await withPageFacts(ctx, args.sourceRecordId, args.snapshot);
    const citation = { sourceName, url: snapshot.url };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: args.sourceRecordId,
      snapshot,
      now,
    });

    // Scope gate (spec §1): novels, picture books, and other non-manga are
    // observed only — never a Series or Release, and never reconciled onto
    // a record an earlier, looser run linked (a scope repair hides those).
    if (snapshot.outOfScope !== undefined) {
      return { status: "recordOnly", changed, reason: snapshot.outOfScope };
    }

    // Rung ①: stored source-id link — a rename or date shift at the source
    // is then a field conflict under the authority rules.
    if (observation.recordRef?.type === "release") {
      const release = await ctx.db.get(observation.recordRef.id);
      if (!release || release.status !== "active" || release.locked) {
        return { status: "recordOnly", changed: false };
      }
      if (!changed && release.coverImage) {
        return { status: "unchanged", changed: false };
      }
      const seriesResult = await reconcileLinkedSeries(ctx, {
        sourceKey: SOURCE_KEY,
        seriesKey: snapshot.seriesSlug,
        offeredTitle: snapshot.seriesTitle,
        offeredSynopsis: snapshot.seriesSynopsis,
        citation,
        now,
      });
      const offered = offeredReleaseFields(snapshot);
      if (await isbnHeldElsewhere(ctx, observation, release, snapshot, now)) {
        delete offered.isbn13;
      }
      const result = await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered,
        observation,
        citation,
        now,
      });
      return {
        status:
          result.applied.length > 0
            ? "updated"
            : result.queued.length > 0
              ? "queued"
              : "recordOnly",
        changed: result.changed || seriesResult.changed,
        releaseId: release._id,
        coverNeeded: !release.coverImage && snapshot.coverUrl !== undefined,
      };
    }

    let { seriesId } = await reconcileLinkedSeries(ctx, {
      sourceKey: SOURCE_KEY,
      seriesKey: snapshot.seriesSlug,
      offeredTitle: snapshot.seriesTitle,
      offeredSynopsis: snapshot.seriesSynopsis,
      citation,
      now,
    });

    // No stored series link yet: resolve the base Series by title before
    // ever creating one (the ANN backbone usually has it already).
    let ambiguousSeries = 0;
    if (seriesId === null) {
      const candidates = await candidateSeries(ctx, snapshot.seriesTitle);
      if (candidates.length === 1) {
        seriesId = candidates[0]!._id;
        await linkSeriesObservation(ctx, {
          sourceKey: SOURCE_KEY,
          seriesKey: snapshot.seriesSlug,
          title: snapshot.seriesTitle,
          url: snapshot.seriesUrl,
          synopsis: snapshot.seriesSynopsis,
          seriesId,
          now,
        });
      }
      ambiguousSeries = candidates.length > 1 ? candidates.length : 0;
    }

    // A packaging line's volume (omnibus, box set, collector's edition) is
    // an Edition Line member whose covered Volumes Kodansha never states: it
    // links by ISBN (multiVolume skips the label rungs) or is left for an
    // Editor — never a Volume, never a Series of its own.
    const packaging = snapshot.packaging ?? null;
    const publisherRef = packaging ? PUBLISHER : await publisherForSeries(ctx, seriesId);
    const publisher = packaging ? null : await publisherBySlug(ctx, publisherRef.slug);
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: packaging ? null : (snapshot.volumeLabel ?? null),
      multiVolume: packaging !== null,
      format: snapshot.format,
      isbn13: snapshot.isbn13,
      publisherId: publisher && publisher.status === "active" ? publisher._id : null,
    };
    const match = await matchRelease(ctx, fact);

    if (match.kind === "match") {
      const release = match.release;
      await ctx.db.patch(observation._id, {
        recordRef: { type: "release", id: release._id },
      });
      const firstSeriesId = release.seriesIds[0];
      if (firstSeriesId !== undefined) {
        await linkSeriesObservation(ctx, {
          sourceKey: SOURCE_KEY,
          seriesKey: snapshot.seriesSlug,
          title: snapshot.seriesTitle,
          url: snapshot.seriesUrl,
          synopsis: snapshot.seriesSynopsis,
          seriesId: firstSeriesId,
          now,
        });
      }
      await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return {
        status: "linked",
        changed: true,
        releaseId: release._id,
        coverNeeded: !release.coverImage && snapshot.coverUrl !== undefined,
      };
    }

    if (packaging) {
      await recordUnplaced(
        ctx,
        observation,
        `"${snapshot.title}" is ${packaging.lineName ?? "packaging"} of "${snapshot.seriesTitle}" with no stated coverage — an Editor maps it.`,
        now,
      );
      return {
        status: "recordOnly",
        changed: false,
        reason: "packaging without coverage",
      };
    }

    const releasePayload = {
      format: snapshot.format,
      binding: snapshot.binding,
      isbn13: snapshot.isbn13,
      pubDate: snapshot.releaseDate ? toPartialDate(snapshot.releaseDate) : undefined,
      price:
        snapshot.priceCents !== undefined
          ? { amountCents: snapshot.priceCents, currency: "USD" }
          : undefined,
    };
    const labels = snapshot.volumeLabel !== undefined ? [snapshot.volumeLabel] : [];

    if (match.kind === "review" || ambiguousSeries > 0) {
      const reason =
        match.kind === "review" ? match.reason : `${ambiguousSeries} same-titled Series`;
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false, reason };
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRef.slug },
        now,
        comment:
          match.kind === "review"
            ? `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`
            : `"${snapshot.seriesTitle}" matches ${ambiguousSeries} same-titled Series — the importer never guesses.`,
      });
      return { status: "needsReview", changed: true, reason };
    }

    const bootstrap = await getBootstrapMode(ctx);
    const gates = creationGates({
      seriesId,
      multiVolume: false,
      editionLineHint: false,
    });
    if (gates.length > 0 && !bootstrap) {
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false };
      }
      if (seriesId === null) {
        // A brand-new Series for a work an Editor hid would undo the repair:
        // the volume stays on its observation instead of the queue. (The
        // creation path below makes the same check itself.)
        const removed = await removedSeriesFor(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          seriesKey: snapshot.seriesSlug,
          seriesTitle: snapshot.seriesTitle,
          publisherId: publisher?._id ?? null,
        });
        if (removed?.kind === "hidden") {
          await recordUnplaced(ctx, observation, removed.reason, now);
          return {
            status: "recordOnly",
            changed: false,
            reason: "hidden series",
          };
        }
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRef.slug },
        now,
        comment: `"${snapshot.title}" observed at ${sourceName} needs ${gates.join(" and ")} — steady-state creation gate.`,
      });
      return { status: "queued", changed: true };
    }

    const creation = await createCanonicalRecords(ctx, {
      sourceKey: SOURCE_KEY,
      observation,
      citation,
      importComment: IMPORT_COMMENT,
      seriesId,
      seriesTitle: snapshot.seriesTitle,
      seriesKey: snapshot.seriesSlug,
      seriesUrl: snapshot.seriesUrl,
      seriesSynopsis: snapshot.seriesSynopsis,
      labels,
      release: { ...releasePayload, publisher: publisherRef },
      tagBootstrapUnreviewed: bootstrap && gates.length > 0,
      now,
    });
    if (creation.blocked !== undefined) {
      return { status: "recordOnly", changed: false, reason: "hidden series" };
    }
    return {
      status: "created",
      changed: true,
      releaseId: creation.releaseId,
      coverNeeded: snapshot.coverUrl !== undefined,
    };
  },
});

/**
 * A calendar-created Release (linked by slug, no ISBN) may duplicate one
 * PRH or ANN already created under the ISBN the volume page now states.
 * Then the ISBN is never copied onto it — two Releases would share one —
 * and the observation records the pair for an Editor to merge.
 */
async function isbnHeldElsewhere(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
  snapshot: KodanshaSnapshot,
  now: number,
): Promise<boolean> {
  const isbn13 = snapshot.isbn13;
  if (isbn13 === undefined || release.isbn13 === isbn13) return false;
  const holder = await ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .first();
  if (!holder || holder._id === release._id || holder.status !== "active") return false;
  const kept = (observation.conflicts ?? []).filter((c) => c.field !== "isbn13");
  await ctx.db.patch(observation._id, {
    conflicts: [
      ...kept,
      {
        field: "isbn13",
        offered: isbn13,
        at: now,
        reason: `ISBN ${isbn13} is already on Release ${holder._id}; the Release this record links to (${release._id}) looks like its duplicate — an Editor merges them.`,
      },
    ],
  });
  return true;
}

/**
 * The publisher a Kodansha record belongs to. kodansha.us also lists its
 * Vertical imprint's books and neither feed names an imprint, so a Series
 * whose existing Editions are Vertical's (and none Kodansha's) is
 * Vertical's — never hard-coded Kodansha. A new or Kodansha Series stays
 * Kodansha.
 */
async function publisherForSeries(
  ctx: MutationCtx,
  seriesId: Id<"series"> | null,
): Promise<CanonicalPublisher> {
  if (seriesId === null) return PUBLISHER;
  const slugs = new Set<string>();
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  for (const volume of volumes) {
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      if (publisher) slugs.add(publisher.slug);
    }
  }
  const vertical = (slug: string) => slug === "vertical" || slug === "vertical-comics";
  const kodansha = (slug: string) => slug === "kodansha" || slug === "kodansha-comics";
  return [...slugs].some(vertical) && ![...slugs].some(kodansha) ? VERTICAL : PUBLISHER;
}
