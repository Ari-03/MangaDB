// The Kodansha adapter (spec §6/§7): Kodansha's own catalog
// through the shared pipeline, from two feeds that share one observation
// per (volume, format) and one apply path (`applyVolume`: observation →
// matching ladder → authority reconciliation, or for a volume that matched
// no Release the placement tail Seven Seas, PRH and Yen Press share,
// lib/unmatched.ts, which holds every unmatched packaging volume of
// Kodansha's; the shared halves live in lib/pipeline.ts):
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
//   the standard creation boundaries. The JSON-LD `image` is stored as the
//   cover like the calendar's, each download charged to the fetch budget. The
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
// Both feeds store Kodansha's art (lib/covers.ts `storeCover`): one blob per
// Edition and image URL, shared by print and digital, and replaced when the
// URL changes. A placeholder image is recorded on the Release instead, keeping
// any art already shown, and not fetched again until its URL changes.
//
// Both feeds share one scope gate: a novel, children's picture book, or
// other non-manga volume (lib/kodansha.ts `outOfScope`) is observed and
// never placed. The crawl never even fetches Kodansha's ~310 novel-type series.
//
// Each feed is gated on its own registry row (lib/importRuns.ts): the window
// before each batch of applies, the crawl at each link and before each
// series. Disabling "kodansha" stops the window, not the crawl.
//
// Neither feed is a withdrawal sweep: the calendar is a rolling window, and
// the crawl skips fresh series, so absence proves nothing.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import type { ApplyResult } from "./lib/catalogTitle";
import { coverKey, coverRequest, type StoredCovers } from "./lib/covers";
import { errorMessage, politeFetch } from "./lib/http";
import { applyRetrying } from "./lib/occ";
import {
  closeRun,
  MAX_CARRIED_ERRORS,
  registryRow,
  runToContinue,
  stampHandOff,
  stopAtGate,
  storeRunCover,
} from "./lib/importRuns";
import {
  baseRecordId,
  crawlMode,
  isbnRecordId,
  isSeriesPage,
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
  volumePageAwaitsIsbn,
  volumesToFetch,
  type KodanshaItem,
  type KodanshaSnapshot,
  type SeriesCrawl,
  type SeriesListingEntry,
} from "./lib/kodansha";
import { candidateSeries, matchRelease, type ReleaseFact } from "./lib/matching";
import { getObservation, linkObservation, markSeen, upsertObservation } from "./lib/observations";
import {
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  isbnHolderBesides,
  linkSeriesObservation,
  publisherBySlug,
  reconcileLinkedSeries,
  recordIsbnConflict,
  seriesEditions,
  toPartialDate,
} from "./lib/pipeline";
import type { CanonicalPublisher } from "./lib/publishers";
import { reconcileFields } from "./lib/reconcile";
import { sameValue } from "./lib/values";
import { withExceptionCapture } from "./lib/posthog";
import { placeUnmatched } from "./lib/unmatched";

export const SOURCE_KEY = "kodansha";
/** The backlist crawl's registry row: its runs, cadence, health, and crawl state. */
export const BACKLIST_KEY = "kodansha-backlist";
const BASE_URL = "https://kodansha.us";
export const PUBLISHER: CanonicalPublisher = { name: "Kodansha", slug: "kodansha" };
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
/** The daily window's applies between two checks of the import gate. */
const WINDOW_BATCH = 50;

// ---------- the daily window ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      errorCount: number;
      failed?: boolean;
      stopped?: true;
    };

/**
 * One Kodansha window run: two JSON fetches, then one apply mutation per
 * (volume, format), with the import gate before each WINDOW_BATCH of them.
 * Runs daily per the registry cadence.
 *
 *   npx convex run kodansha:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** A run an operator opened with imports:startRun (forced). */
    runId: v.optional(v.id("importRuns")),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("kodansha.sync", ctx, async () => {
      const source = await registryRow(ctx, SOURCE_KEY);
      const runId = await runToContinue(ctx, source, args);
      if (runId === null) return { skipped: "disabled" as const };
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

        const covers: StoredCovers = new Map();
        let applied = 0;
        for (const [recordId, { snapshot }] of items) {
          if (applied++ % WINDOW_BATCH === 0) {
            const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
            if (stopped) return stopped;
          }
          seen++;
          try {
            const result = await applyRetrying(ctx, internal.kodansha.applyVolume, {
              sourceRecordId: recordId,
              snapshot,
            });
            if (result.changed) changed++;
            if (result.status === "needsReview") {
              errors.push(`review ${recordId}: ${result.reason ?? "conflict"}`);
            }
            if (result.cover) {
              await storeRunCover(
                ctx,
                covers,
                {
                  ...result.cover,
                  attribution: source.attribution ?? PUBLISHER.name,
                  delayMs: delay,
                },
                { label: recordId, errors },
              );
            }
          } catch (e) {
            failures++;
            errors.push(`volume ${recordId}: ${errorMessage(e)}`);
          }
        }

        const status = failures > 0 ? "failed" : "succeeded";
        return await closeRun(ctx, runId, status, { seen, changed, errors });
      } catch (e) {
        errors.push(errorMessage(e));
        return await closeRun(ctx, runId, "failed", { seen, changed, errors });
      }
    }),
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
    /** Ignore cadence: a known series rechecks its pending volumes now, an unknown one crawls in full. */
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { entries, now, force }) => {
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
      const mode = force ? (state ? "recheck" : "full") : crawlMode(entry, state, now);
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
      await ctx.db.patch(existing._id, { snapshot: crawl });
      await markSeen(ctx, existing, now);
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

/**
 * Write the listing's age ratings onto the series-link observations
 * (`series:{slug}`) of series already linked to the catalog, where the
 * Mature Series rebuild reads them; a new 18+ rating also makes its Series
 * mature at once (lib/mature.ts). Kodansha rates series,
 * not books, and the listing is fetched in full every run, so this costs no
 * page fetches. A series linked later this run gets its rating next run.
 */
export const recordListingRatings = internalMutation({
  args: { entries: v.array(v.object({ slug: v.string(), mature: v.boolean() })) },
  handler: async (ctx, { entries }) => {
    const now = Date.now();
    for (const { slug, mature } of entries) {
      const link = await getObservation(ctx, SOURCE_KEY, `series:${slug}`);
      if (!link) continue;
      const snapshot = link.snapshot as { mature?: boolean };
      if (snapshot.mature === mature) continue;
      await upsertObservation(ctx, {
        sourceKey: SOURCE_KEY,
        sourceRecordId: link.sourceRecordId,
        snapshot: { ...snapshot, mature },
        now,
      });
    }
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
      stopped?: true;
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
    /**
     * Operator-targeted run: crawl only these listing slugs, ignoring cadence
     * (known series recheck their pending volumes, unknown ones crawl in full).
     * Recovers records a previous run failed to apply without a full crawl:
     *
     *   npx convex run kodansha:backlistSync '{"onlySeries":["blue-lock"]}'
     */
    onlySeries: v.optional(v.array(v.string())),
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
  handler: async (ctx, args): Promise<BacklistResult> =>
    withExceptionCapture("kodansha.backlistSync", ctx, async () => {
      const source = await registryRow(ctx, BACKLIST_KEY);
      // Disabling the row stops a scheduled crawl at its next link or series
      // (the run closes as "stopped"); an operator-forced run finishes.
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
      const covers: StoredCovers = new Map();

      const finish = async (status: "succeeded" | "failed"): Promise<BacklistResult> => ({
        ...(await closeRun(ctx, runId, status, { seen, changed, errors })),
        seriesCrawled,
        fetched: fetchedTotal,
        continued: false,
      });

      try {
        const only = args.onlySeries === undefined ? null : new Set(args.onlySeries);
        const listing = (await fetchListing(delay)).filter(
          (entry) =>
            (args.afterSlug === undefined || entry.slug > args.afterSlug) &&
            (only === null || only.has(entry.slug)),
        );

        let budgetSpent = false;
        for (let offset = 0; offset < listing.length && !budgetSpent; offset += PLAN_CHUNK) {
          const chunk = listing.slice(offset, offset + PLAN_CHUNK);
          await ctx.runMutation(internal.kodansha.recordListingRatings, {
            entries: chunk.map(({ slug, mature }) => ({ slug, mature })),
          });
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
            force: only !== null,
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
            const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
            if (stopped) return { ...stopped, seriesCrawled, fetched: fetchedTotal, continued: false };

            // The series page: its volume list and blurb.
            const seriesUrl = `${BASE_URL}/series/${entry.slug}/`;
            fetchedHere++;
            fetchedTotal++;
            let volumes: string[];
            let synopsis: string | undefined;
            try {
              const html = await (await politeFetch(seriesUrl, delay)).text();
              volumes = parseSeriesPage(html, entry.slug);
              // A 200 that is no series page (a challenge, changed markup) is
              // a failure, never an empty series remembered until its refresh.
              if (volumes.length === 0 && !isSeriesPage(html)) {
                throw new Error("unrecognized series page: no ComicSeries JSON-LD or volume links");
              }
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
                const html = await (await politeFetch(url, delay)).text();
                const page = parseVolumePage(html, url);
                // A Book with no ISBN yet is re-checked quietly; any other
                // unparsed page (a challenge, changed markup) fails below.
                if (page === null && !volumePageAwaitsIsbn(html)) {
                  throw new Error("unrecognized volume page: no JSON-LD Book");
                }
                if (page === null || needsRecheck(page.offers, Date.now())) recheck.push(volumeSlug);
                if (page === null) continue;
                for (const { sourceRecordId: recordId, snapshot } of toBacklistSnapshots(
                  page,
                  synopsis,
                )) {
                  seen++;
                  try {
                    const result = await applyRetrying(ctx, internal.kodansha.applyVolume, {
                      sourceRecordId: recordId,
                      snapshot,
                    });
                    if (result.changed) changed++;
                    if (result.status === "needsReview") {
                      errors.push(`review ${recordId}: ${result.reason ?? "conflict"}`);
                    }
                    if (result.cover) {
                      // A download counts against the budget. A failed one is a
                      // notice, and its volume is re-checked at the next weekly
                      // run so the art is retried there, not at the 180-day refresh.
                      if (!covers.has(coverKey(result.cover))) {
                        fetchedHere++;
                        fetchedTotal++;
                      }
                      const stored = await storeRunCover(
                        ctx,
                        covers,
                        {
                          ...result.cover,
                          attribution: source.attribution ?? PUBLISHER.name,
                          delayMs: delay,
                        },
                        { label: recordId, errors },
                      );
                      if (!stored && !recheck.includes(volumeSlug)) recheck.push(volumeSlug);
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
          await stampHandOff(ctx, runId, { seen, changed, errors });
          await ctx.scheduler.runAfter(0, internal.kodansha.backlistSync, {
            politeDelayMs: args.politeDelayMs,
            maxFetches: args.maxFetches,
            onlySeries: args.onlySeries,
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
    }),
});

// ---------- applying one (volume, format) ----------

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
    // The page's art stays too: the calendar can name the same jacket at
    // another size, and alternating URLs would re-store the cover each day.
    coverUrl: stored.coverUrl ?? snapshot.coverUrl,
  };
}

/**
 * Reconcile one normalized (volume, format) snapshot into the canonical
 * catalog — one atomic mutation per record (spec §6). Mirrors
 * sevenSeas.applyBook and shares its unmatched tail (lib/unmatched.ts); a
 * snapshot with an ISBN (volume pages) matches by ISBN first, and is stored
 * under the identity its ISBN owns (`offerRecordId`), whatever id the page
 * order proposed. It applies whatever either registry row's enabled flag
 * says (each feed's sync gates its own run); authority is always the
 * "kodansha" row's.
 */
export const applyVolume = internalMutation({
  args: { sourceRecordId: v.string(), snapshot: kodanshaSnapshotValidator },
  handler: async (ctx, args): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? PUBLISHER.name;
    const recordId = await offerRecordId(ctx, args.sourceRecordId, args.snapshot);
    const snapshot = await withPageFacts(ctx, recordId, args.snapshot);
    const citation = { sourceName, url: snapshot.url };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: recordId,
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
      // An unchanged snapshot is done unless its art moved to a new URL.
      const cover = coverRequest(release, snapshot.coverUrl);
      if (!changed && cover === undefined) {
        return { status: "unchanged", changed: false };
      }
      // Another ISBN than the linked Release's is another book (a record an
      // old order-keyed crawl rewrote): an Editor decides, and none of its
      // binding, date, or price is reconciled onto this Release.
      if (
        release.isbn13 !== undefined &&
        snapshot.isbn13 !== undefined &&
        release.isbn13 !== snapshot.isbn13
      ) {
        await recordIsbnConflict(
          ctx,
          observation,
          snapshot.isbn13,
          `This record now offers ISBN ${snapshot.isbn13}, but the Release it links (${release._id}) is ISBN ${release.isbn13}; its facts are not applied until an Editor resolves which book it is.`,
          now,
        );
        return {
          status: "needsReview",
          changed,
          releaseId: release._id,
          reason: "ISBN differs from the linked Release's",
        };
      }
      // So is an ISBN another Release holds, whatever this link lacks: a
      // calendar duplicate awaiting a merge, or a legacy record's facts.
      if (await isbnHeldElsewhere(ctx, observation, release, snapshot.isbn13, now)) {
        return {
          status: "needsReview",
          changed,
          releaseId: release._id,
          reason: "ISBN held by another Release",
        };
      }
      const seriesResult = await reconcileLinkedSeries(ctx, {
        sourceKey: SOURCE_KEY,
        seriesKey: snapshot.seriesSlug,
        offeredTitle: snapshot.seriesTitle,
        offeredSynopsis: snapshot.seriesSynopsis,
        citation,
        now,
      });
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
        status:
          result.applied.length > 0
            ? "updated"
            : result.queued.length > 0
              ? "queued"
              : "recordOnly",
        changed: result.changed || seriesResult.changed,
        releaseId: release._id,
        cover,
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
      binding: snapshot.binding,
      language: IMPORT_LANGUAGE,
      isbn13: snapshot.isbn13,
      publisherId: publisher && publisher.status === "active" ? publisher._id : null,
    };
    const match = await matchRelease(ctx, fact);

    if (match.kind === "match") {
      const release = match.release;
      await linkObservation(ctx, observation._id, { type: "release", id: release._id });
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
        cover: coverRequest(release, snapshot.coverUrl),
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
    // Kodansha never states which Volumes a packaging line's volume
    // collects: it covers none the tail could place, so it is held.
    const labels = !packaging && snapshot.volumeLabel !== undefined ? [snapshot.volumeLabel] : [];

    // No Release matched: the shared tail holds, queues, or creates it
    // (lib/unmatched.ts), under the source's series link.
    const result = await placeUnmatched(
      ctx,
      {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        title: snapshot.title,
        match,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        ambiguousSeries,
        seriesKey: snapshot.seriesSlug,
        seriesUrl: snapshot.seriesUrl,
        seriesSynopsis: snapshot.seriesSynopsis,
        packaging,
        labels,
        packagingHold: `"${snapshot.title}" is ${packaging?.lineName ?? "packaging"} of "${snapshot.seriesTitle}" with no stated coverage — an Editor maps it.`,
        publisher: publisherRef,
        publisherId: publisher?._id ?? null,
        release: releasePayload,
        bootstrap: await getBootstrapMode(ctx),
        now,
      },
      {
        unmappedPackaging: false,
        ambiguityQuotesBook: false,
        ensurePublisherToQueue: false,
        hiddenWorkBeforeQueued: false,
      },
    );
    // A created Release's art is the action's to store.
    if (result.status !== "created" || result.releaseId === undefined) return result;
    const created = await ctx.db.get(result.releaseId);
    return { ...result, cover: created ? coverRequest(created, snapshot.coverUrl) : undefined };
  },
});

/**
 * The identity a volume-page offer is stored under. Page order only proposes
 * one (lib/kodansha.ts `toBacklistSnapshots`): the base key
 * `{series}/{volume}#{format}` belongs to the ISBN it already holds (its
 * linked Release's, else its stored snapshot's), and every other ISBN of that
 * format takes `…:{isbn}`, so reordered bindings never trade records. A base
 * key an older order-keyed crawl rewrote is reclaimed by its linked Release's
 * ISBN, so stored observations need no migration. A base linked to an
 * ISBN-less Release is not the offer's when that Release's known Binding
 * differs, nor by its stored snapshot's ISBN alone while another Release
 * holds that ISBN (an older crawl may have stored another binding's facts
 * there): the offer takes its ISBN key. With no ISBN on the base yet (none
 * stored, or calendar-only), an existing ISBN key wins, else the proposal
 * stands.
 */
async function offerRecordId(
  ctx: MutationCtx,
  proposed: string,
  snapshot: KodanshaSnapshot,
): Promise<string> {
  const isbn13 = snapshot.isbn13;
  if (isbn13 === undefined) return proposed;
  const base = baseRecordId(proposed);
  const keyed = isbnRecordId(base, isbn13);
  const stored = await getObservation(ctx, SOURCE_KEY, base);
  const ref = stored?.recordRef;
  const linked = ref?.type === "release" ? await ctx.db.get(ref.id) : null;
  if (linked?.isbn13 !== undefined) return linked.isbn13 === isbn13 ? base : keyed;
  if (
    linked?.binding !== undefined &&
    snapshot.binding !== undefined &&
    linked.binding.toLowerCase() !== snapshot.binding.toLowerCase()
  ) {
    return keyed;
  }
  const claimed = (stored?.snapshot as KodanshaSnapshot | undefined)?.isbn13;
  if (claimed !== undefined) {
    if (claimed !== isbn13) return keyed;
    const holder = linked === null ? null : await isbnHolderBesides(ctx, linked, isbn13);
    return holder === null ? base : keyed;
  }
  return (await getObservation(ctx, SOURCE_KEY, keyed)) ? keyed : proposed;
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
  for (const edition of await seriesEditions(ctx, seriesId)) {
    if (edition.status !== "active") continue;
    const publisher = await ctx.db.get(edition.publisherId);
    if (publisher) slugs.add(publisher.slug);
  }
  const vertical = (slug: string) => slug === "vertical" || slug === "vertical-comics";
  const kodansha = (slug: string) => slug === "kodansha" || slug === "kodansha-comics";
  return [...slugs].some(vertical) && ![...slugs].some(kodansha) ? VERTICAL : PUBLISHER;
}
