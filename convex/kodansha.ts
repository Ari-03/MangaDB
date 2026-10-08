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
//
// kodansha.us lists Vertical's books too and names no imprint, so a new
// book's publisher (`publisherForRecord`) comes from its own ISBN's PRH
// record, else its Volume's existing Edition, else its Series; never from
// the ISBN's prefix. A creation that would have to guess between Editions
// (the Volume's Edition is the other house's, or both houses hold it) goes
// to an Editor. A Release already in the catalog keeps its publisher.

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
import { parseBookTitle, type CoverRange, type Packaging } from "./lib/bookTitle";
import { coverageFromLine } from "./lib/coverage";
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
import { coveringOf } from "./lib/editionRows";
import {
  candidateSeries,
  isWholeSingleVolume,
  labelsEqual,
  type MatchOutcome,
  matchRelease,
  type ReleaseFact,
} from "./lib/matching";
import { mergeSurvivor } from "./lib/merges";
import { getObservation, linkObservation, markSeen, upsertObservation } from "./lib/observations";
import {
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  isbnHolderBesides,
  joinableEdition,
  linkSeriesObservation,
  publisherBySlug,
  reconcileLinkedSeries,
  recordIsbnConflict,
  toPartialDate,
} from "./lib/pipeline";
import type { PrhTitleSnapshot } from "./lib/prh";
import {
  canonicalPublisherBySlug,
  canonicalPublisherFor,
  publisherNameKey,
  type CanonicalPublisher,
} from "./lib/publishers";
import { reconcileFields } from "./lib/reconcile";
import { ofOtherPrinting, printingIsbnOf } from "./lib/releaseIsbns";
import { sameValue } from "./lib/values";
import { withExceptionCapture } from "./lib/posthog";
import { placeUnmatched, type ApplyResult } from "./lib/unmatched";

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
            if (stopped)
              return { ...stopped, seriesCrawled, fetched: fetchedTotal, continued: false };

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
                if (page === null || needsRecheck(page.offers, Date.now()))
                  recheck.push(volumeSlug);
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
    | KodanshaSnapshot
    | undefined;
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
 * The note an unmatched packaging volume is held with. This importer never
 * places packaging (it passes the tail no labels for it), so the note says
 * so, and quotes the coverage the book states, if any: the range its own
 * title states, read with the shared title parser, else, when neither the
 * title nor the series name states any Volumes (no range, no gapped list),
 * the size its line's name declares (lib/coverage.ts). The snapshot's
 * `packaging` comes from the series name, which every member of the line
 * shares, so its range is never quoted. The calendar titles each book
 * "{series name} Volume N", so a title range equal to the series name's is
 * taken for the series name's, also on a volume page whose own title
 * repeats it, and the note then quotes no coverage. The line's size is not
 * quoted under a series name that states Volumes either: some spellings of
 * the series name's range do not survive into the composed title's parse,
 * and the size could contradict the range the quoted title shows.
 */
function packagingHold(snapshot: KodanshaSnapshot, packaging: Packaging): string {
  const own = parseBookTitle(snapshot.title).packaging;
  const named = packaging.coverRange;
  const fromLine = coverageFromLine(packaging.lineName, packaging.linePosition);
  const stated = own?.coverRange
    ? own.coverRange.from === named?.from && own.coverRange.to === named?.to
      ? null
      : { range: own.coverRange, by: "in its title" }
    : fromLine && !own?.coverageGapped && !named && !packaging.coverageGapped
      ? { range: fromLine, by: "by its line's size" }
      : null;
  const volumes = (range: CoverRange) =>
    range.from === range.to ? `Volume ${range.from}` : `Volumes ${range.from}-${range.to}`;
  return `"${snapshot.title}" is ${packaging.lineName ?? "packaging"} of "${snapshot.seriesTitle}"${stated ? `, stating ${volumes(stated.range)} ${stated.by}` : ""}. The Kodansha importer does not place packaging — an Editor maps it.`;
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
      // A record of one of the Release's Other Printings offers it nothing,
      // its art included, and its other ISBN is no conflict (lib/releaseIsbns.ts
      // ofOtherPrinting).
      if (await ofOtherPrinting(ctx, release, observation)) {
        return { status: "recordOnly", changed: false, releaseId: release._id };
      }
      // An unchanged snapshot is done unless its art moved to a new URL.
      const cover = coverRequest(release, snapshot.coverUrl, observation._id);
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
      if (await isbnHeldElsewhere(ctx, observation, release, { isbn13: snapshot.isbn13 }, now)) {
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
    // an Edition Line member whose covered Volumes this importer does not
    // read: it links by ISBN (multiVolume skips the label rungs) or is left
    // for an Editor — never a Volume, never a Series of its own.
    const packaging = snapshot.packaging ?? null;
    // Its publisher (publisherForRecord) files a created or queued book;
    // packaging still matches by ISBN alone (no publisher in the fact).
    const {
      publisher: publisherRef,
      row: publisher,
      hold,
    } = await publisherForRecord(ctx, seriesId, snapshot);
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
    const matched = await matchRelease(ctx, fact);
    // A creation the house evidence cannot place without guessing an
    // Edition (publisherForRecord's hold) goes to an Editor instead.
    const match: MatchOutcome =
      matched.kind === "create" && hold !== null
        ? { kind: "review", rung: 4, reason: hold }
        : matched;

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
      // Linked through one of its Other Printings, the book's art is that printing's.
      const printing = (await printingIsbnOf(ctx, release._id, snapshot.isbn13)) !== undefined;
      return {
        status: "linked",
        changed: true,
        releaseId: release._id,
        cover: printing ? undefined : coverRequest(release, snapshot.coverUrl, observation._id),
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
    // A packaging line's volume covers no Volume the tail could place, even
    // when its title states a range (its note quotes it), so it is held.
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
        packaging: packaging && { ...packaging, hold: packagingHold(snapshot, packaging) },
        labels,
        publisher: publisherRef,
        publisherId: publisher?._id ?? null,
        release: releasePayload,
        now,
      },
      {
        unmappedPackaging: false,
        ambiguityQuotesBook: false,
      },
    );
    // A created Release's art is the action's to store.
    if (result.status !== "created" || result.releaseId === undefined) return result;
    const created = await ctx.db.get(result.releaseId);
    return {
      ...result,
      cover: created ? coverRequest(created, snapshot.coverUrl, observation._id) : undefined,
    };
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
 * The publisher a new Kodansha record is placed under. kodansha.us also
 * lists its Vertical imprint's books and neither feed names an imprint, so
 * the first rule that applies decides (never the ISBN's prefix):
 *
 * 1. its own ISBN's PRH record (ownPrhImprint): "Vertical Comics" is
 *    Vertical's, "Kodansha Comics" Kodansha's, even inside a Series of the
 *    other house;
 * 2. the one Kodansha-family publisher of the whole single-Volume Editions
 *    of its Volume in its Series (houseEvidence), so a new ebook of a
 *    reviewed Vertical paperback joins that Edition in a mixed Series;
 * 3. a Series whose active Editions are Vertical's (and none Kodansha's);
 * 4. else Kodansha: the feed's silence is no evidence.
 *
 * `row` is the house's publisher row (null for packaging, which matches by
 * ISBN alone and is otherwise held, so it spends no Series reads). `hold`
 * is set when creating the book would guess an Edition: rule 1 names a
 * house the Volume's whole Editions lack (a second Edition beside an
 * unrepaired one), both houses hold the Volume and the book has no PRH
 * record of its own, or the chosen house's whole Edition of the Volume is
 * one the book cannot join (locked, or filed under another publisher row).
 * Only placement reads it (matching ladder rungs ③/④ and the unmatched
 * tail); a linked or ISBN-matched Release never has its publisher rewritten.
 */
async function publisherForRecord(
  ctx: MutationCtx,
  seriesId: Id<"series"> | null,
  snapshot: KodanshaSnapshot,
): Promise<{
  publisher: CanonicalPublisher;
  row: Doc<"publishers"> | null;
  hold: string | null;
}> {
  const own = await ownPrhImprint(ctx, snapshot.isbn13);
  if (snapshot.packaging !== undefined) {
    return { publisher: own ?? PUBLISHER, row: null, hold: null };
  }
  const label = snapshot.volumeLabel;
  const volumeName = label ?? "(unlabeled)";
  const evidence = seriesId === null ? null : await houseEvidence(ctx, seriesId, label);
  const volume = evidence?.volume ?? new Map<string, HouseEditions>();
  let publisher = PUBLISHER;
  let hold: string | null = null;
  if (own !== null) {
    publisher = own;
    if (volume.size > 0 && !volume.has(own.slug)) {
      hold = `its ISBN's PRH record names ${own.name}, but Volume ${volumeName}'s Editions are another house's`;
    }
  } else if (volume.size > 1) {
    hold = `both Kodansha and Vertical hold a whole Edition of Volume ${volumeName}`;
  } else if (volume.size === 1) {
    publisher = [...volume.values()][0]!.house;
  } else if (evidence?.series.has(VERTICAL.slug) && !evidence.series.has(PUBLISHER.slug)) {
    publisher = VERTICAL;
  }
  const row = await publisherBySlug(ctx, publisher.slug);
  const siblings = volume.get(publisher.slug)?.editions ?? [];
  if (
    hold === null &&
    siblings.length > 0 &&
    !siblings.some((edition) => edition.publisherId === row?._id && joinableEdition(edition))
  ) {
    hold = `Volume ${volumeName}'s ${publisher.name} Edition is locked or under another publisher row, so the book would get a second one`;
  }
  return { publisher, row, hold };
}

const PRH_KEY = "prh";

/**
 * The Kodansha-family imprint PRH states for this very ISBN, or null. Only a
 * current PRH record of the ISBN itself counts: not withdrawn, not one of an
 * Other Printing's ISBNs, its snapshot naming the same ISBN, and not linked
 * to a Release (merges followed) that holds another ISBN. PRH's plain
 * "Vertical" is Vertical's prose imprint (lib/prh.ts DENIED_IMPRINTS), and
 * any imprint outside the family is no statement about this house.
 */
async function ownPrhImprint(
  ctx: MutationCtx,
  isbn13: string | undefined,
): Promise<CanonicalPublisher | null> {
  if (isbn13 === undefined) return null;
  const observation = await getObservation(ctx, PRH_KEY, isbn13);
  if (!observation || observation.withdrawn || observation.printingIsbn13 !== undefined) {
    return null;
  }
  const stated = observation.snapshot as Partial<PrhTitleSnapshot>;
  if (stated.isbn13 !== isbn13 || typeof stated.imprint !== "string") return null;
  if (publisherNameKey(stated.imprint) === "vertical") return null;
  const imprint = canonicalPublisherFor(stated.imprint);
  const house =
    imprint?.slug === VERTICAL.slug
      ? VERTICAL
      : imprint?.slug === PUBLISHER.slug
        ? PUBLISHER
        : null;
  if (house === null) return null;
  const ref = observation.recordRef;
  if (ref !== undefined) {
    const linked =
      ref.type === "release"
        ? await mergeSurvivor(ctx, "releases", await ctx.db.get(ref.id))
        : null;
    if (linked?.isbn13 !== isbn13) return null;
  }
  return house;
}

/** One house's active whole single-Volume Editions of a Volume. */
type HouseEditions = { house: CanonicalPublisher; editions: Doc<"editions">[] };

/**
 * What the Series' Editions say about a new book's house, in one pass over
 * its Volumes: `series`, the Kodansha-family houses of its active Editions;
 * `volume`, by house, the active whole single-Volume Editions
 * (isWholeSingleVolume: no Edition Line, no Unmapped Packaging) of the
 * Volume with this label (a oneshot's unlabeled Volume when it has none).
 * A publisher row counts as the house of its merge survivor's slug
 * (duplicate slugs folded).
 */
async function houseEvidence(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  label: string | undefined,
): Promise<{ series: Set<string>; volume: Map<string, HouseEditions> }> {
  const series = new Set<string>();
  const volume = new Map<string, HouseEditions>();
  const seen = new Set<Id<"editions">>();
  const houses = new Map<Id<"publishers">, CanonicalPublisher | null>();
  const houseOf = async (publisherId: Id<"publishers">) => {
    if (!houses.has(publisherId)) houses.set(publisherId, await kodanshaFamilyOf(ctx, publisherId));
    return houses.get(publisherId) ?? null;
  };
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  for (const each of volumes) {
    // An unlabeled record is a oneshot's: the matcher and creation both take
    // the Series' unlabeled Volume for it.
    const ours = each.status === "active" && labelsEqual(each.label, label ?? null);
    for (const coverage of await coveringOf(ctx, each._id)) {
      // A whole single-Volume Edition has one coverage row, so an Edition
      // already seen through another Volume is never the label's.
      if (seen.has(coverage.editionId)) continue;
      seen.add(coverage.editionId);
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      const house = await houseOf(edition.publisherId);
      if (house === null) continue;
      series.add(house.slug);
      if (!ours || !(await isWholeSingleVolume(ctx, edition))) continue;
      const entry = volume.get(house.slug) ?? { house, editions: [] };
      entry.editions.push(edition);
      volume.set(house.slug, entry);
    }
  }
  return { series, volume };
}

/** Kodansha or Vertical for a publisher row of either (merges followed, duplicate slugs folded), else null. */
async function kodanshaFamilyOf(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
): Promise<CanonicalPublisher | null> {
  const row = await mergeSurvivor(ctx, "publishers", await ctx.db.get(publisherId));
  const slug = row ? canonicalPublisherBySlug(row.slug)?.slug : undefined;
  return slug === VERTICAL.slug ? VERTICAL : slug === PUBLISHER.slug ? PUBLISHER : null;
}
