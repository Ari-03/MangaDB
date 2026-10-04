// The Publisher Spotlight page (spec §10/§11): `/publisher/{slug}`
// is a publisher-led profile with a bounded upcoming-Releases lane and a clear
// route into the main Releases browser. The cross-publisher overview is the
// Publishers board (`/publishers`, monthBoard below): one month of the
// browser's window grouped by Publisher, plus the A–Z directory.
//
// Publishers are the slug-only URL exception (spec §8): the slug is identity,
// so a rename 301s through publisherSlugRedirects instead of a public-ID URL.
// The query resolves old slugs (and merged Publishers) to `redirectTo` so the
// route can issue the 301 itself.
//
// An imprint is a Publisher of its own that names its parent company
// (publishers.parentPublisherId, one level deep): its page links up to the
// parent ("An imprint of Seven Seas Entertainment"), and a parent's page
// lists its imprints.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { COUNT_CAP, PUBLISHER_SCAN_CAP } from "./catalog";
import { boundedReads } from "./lib/boundedReads";
import { getActive } from "./lib/merges";
import {
  browseCache,
  joinBrowseRows,
  memoize,
  resolvePublisher,
  WINDOW_CAP,
  type BrowseCache,
} from "./releases";
import { showMatureArg, visibleTo } from "./lib/mature";
import { withExceptionCapture } from "./lib/posthog";
import { seriesStatsRow } from "./lib/seriesStats";

// The Spotlight's months after this one are bounded: at most
// LANE_CAP books within the horizon the route requests (~3 months), enough
// for a busy publisher's next three months, which the page previews a dozen
// at a time; the full calendar lives in the Releases browser. The scan cap
// covers hidden-row attrition and formats folding into one book.
export const LANE_CAP = 72;
const LANE_SCAN_CAP = 300;

type BrowseRow = Awaited<ReturnType<typeof joinBrowseRows>>[number];

/** A book on the Spotlight: an Edition's Releases in one month, folded together. */
export type SpotlightBook = BrowseRow & {
  /** Every Format (and Binding) the book comes in that month, physical first. */
  formats: Array<{ format: BrowseRow["format"]; binding: BrowseRow["binding"] }>;
};

/**
 * Fold joined rows into one book per Edition per month: a volume out in
 * paperback and digital is one book with two formats, not two cards. The
 * book keeps its earliest date and, among same-day rows, the physical one's
 * jacket. Input and output are in date order.
 */
export function foldFormats(rows: ReadonlyArray<BrowseRow>): SpotlightBook[] {
  const ordered = [...rows].sort(
    (a, b) =>
      a.sort - b.sort || (a.format === "physical" ? 0 : 1) - (b.format === "physical" ? 0 : 1),
  );
  const books = new Map<string, SpotlightBook>();
  for (const row of ordered) {
    const key = `${row.edition.publicId}:${Math.floor(row.sort / 100)}`;
    const format = { format: row.format, binding: row.binding };
    const book = books.get(key);
    if (!book) books.set(key, { ...row, formats: [format] });
    else if (
      !book.formats.some((f) => f.format === format.format && f.binding === format.binding)
    ) {
      book.formats.push(format);
      book.formats.sort(
        (a, b) => (a.format === "physical" ? 0 : 1) - (b.format === "physical" ? 0 : 1),
      );
    }
  }
  return [...books.values()];
}

// This month's Releases read for the Spotlight: a busy Publisher puts out a
// couple of hundred a month across formats.
const MONTH_SCAN_CAP = 400;

/**
 * Everything the Publisher Spotlight renders. `todaySort`/`horizonSort` are
 * yyyymmdd sort keys the route computes (spec §8 partial dates).
 *
 * - `thisMonth`: every active Release dated in the current month, already
 *   out or still to come (day-TBA rows sort first at yyyymm00), folded into
 *   books (`foldFormats`), with the Release count.
 * - `upcoming`: the months after this one up to the horizon, as books,
 *   bounded to LANE_CAP; the Releases browser has the rest.
 * - `nextSort`: the next publication date from today on, if any.
 *
 * Books of Mature Series, and adult-only imprints, are left out unless
 * `showMature` (lib/mature.ts).
 *
 * Returns `{ redirectTo }` when the requested slug is a renamed Publisher's
 * old slug or a merged Publisher's (the route 301s), null for unknown/hidden.
 */
export const publisherPage = query({
  args: {
    slug: v.string(),
    todaySort: v.number(),
    horizonSort: v.number(),
    ...showMatureArg,
  },
  handler: async (unbounded, { slug, todaySort, horizonSort, showMature }) => {
    // Both windows join at once and share one read queue (lib/boundedReads.ts).
    const ctx = boundedReads(unbounded);
    const publisher = await resolvePublisher(ctx, slug);
    if (!publisher) return null;
    if (publisher.slug !== slug) {
      return { redirectTo: publisher.slug } as const;
    }

    // Malformed bounds read as an empty lane rather than erroring.
    const boundsOk =
      Number.isInteger(todaySort) &&
      Number.isInteger(horizonSort) &&
      todaySort > 0 &&
      horizonSort >= todaySort;

    const monthStart = Math.floor(todaySort / 100) * 100;
    const window = async (from: number, to: number, cap: number) => {
      const docs = await ctx.db
        .query("releases")
        .withIndex("by_publisher_date", (q) =>
          q.eq("publisherId", publisher._id).gte("pubDate.sort", from).lte("pubDate.sort", to),
        )
        .take(cap);
      const active = docs.filter((doc) => doc.status === "active");
      const rows = (await joinBrowseRows(ctx, active)).filter((row) =>
        visibleTo(showMature, row.mature),
      );
      return { rows, full: docs.length === cap };
    };
    const [month, later] = boundsOk
      ? await Promise.all([
          window(monthStart, monthStart + 99, MONTH_SCAN_CAP),
          window(monthStart + 100, horizonSort, LANE_SCAN_CAP),
        ])
      : [
          { rows: [], full: false },
          { rows: [], full: false },
        ];
    const upcoming = foldFormats(later.rows);
    const next = [...month.rows, ...later.rows].find(
      (row) => row.sort >= todaySort || row.day === null,
    );

    // Imprint family, one level deep: the parent company, or the imprints.
    const parentDoc = publisher.parentPublisherId
      ? await getActive(ctx, "publishers", publisher.parentPublisherId)
      : null;
    const imprintDocs = await ctx.db
      .query("publishers")
      .withIndex("by_parent", (q) => q.eq("parentPublisherId", publisher._id))
      .collect();
    const imprints = imprintDocs
      .filter(
        (doc) => doc.status === "active" && visibleTo(showMature, doc.contentRating === "mature"),
      )
      .map((doc) => ({ name: doc.name, slug: doc.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Profile fact: active Editions in the catalog, capped like catalog.stats.
    const editionDocs = await ctx.db
      .query("editions")
      .withIndex("by_publisher", (q) => q.eq("publisherId", publisher._id))
      .take(COUNT_CAP + 1);
    const activeEditions = editionDocs.filter((doc) => doc.status === "active").length;

    return {
      publisher: {
        name: publisher.name,
        slug: publisher.slug,
        description: publisher.description ?? null,
        /** An adult-only publisher (lib/mature.ts): the page says why its lanes may be empty. */
        mature: publisher.contentRating === "mature",
      },
      parent: parentDoc ? { name: parentDoc.name, slug: parentDoc.slug } : null,
      imprints,
      thisMonth: {
        books: foldFormats(month.rows),
        releases: month.rows.length,
        // The month holds more than the scan read (the browser shows all).
        capped: month.full,
      },
      upcoming: upcoming.slice(0, LANE_CAP),
      // More upcoming Releases exist beyond the lane (the browser shows all).
      upcomingCapped: upcoming.length > LANE_CAP || later.full,
      nextSort: next?.sort ?? null,
      editionCount: {
        count: Math.min(activeEditions, COUNT_CAP),
        capped: editionDocs.length > COUNT_CAP,
      },
    };
  },
});

// ---------- Publishers board (`/publishers`) ----------

// Covers shown on each board card: a handful, the browser has the rest.
export const BOARD_COVER_CAP = 5;
// Stored boards dropped per rebuild: a year leaves the window at a time, so
// twelve at most in normal running.
const BOARD_DROP_CAP = 100;
// Releases of one Edition read to tell a debut from a backfill (an Edition
// has a Release per Format and Binding: a few, rarely more).
const EDITION_RELEASE_CAP = 50;

/** A Release on the board with the active Series it keeps. */
type BoardRow = { release: Doc<"releases">; series: Array<Doc<"series">> };

/**
 * One month's visible Canonical Releases grouped by Publisher, in window
 * (date) order. Same window and visibility as the Releases browser
 * (monthBrowse + joinBrowseRows): active Releases dated inside the month
 * (`fromSort` is its yyyymm00 key), whose Edition is active and which keep
 * at least one active Series, each with those Series; books of a Mature
 * Series only with `showMature`. Lookups go through the caller's `cache`,
 * in parallel. A null month (malformed input) is an empty window.
 */
async function visibleMonth(
  ctx: QueryCtx,
  cache: BrowseCache,
  fromSort: number | null,
  showMature: boolean,
) {
  // yyyymm00 (month-precision) … yyyymm99 covers every day of the month.
  // Active rows only, off the status-led index like monthBrowse: hidden and
  // merged Releases neither cost reads nor push active ones past the cap.
  const windowDocs =
    fromSort === null
      ? []
      : await ctx.db
          .query("releases")
          .withIndex("by_status_date", (q) =>
            q
              .eq("status", "active")
              .gte("pubDate.sort", fromSort)
              .lte("pubDate.sort", fromSort + 99),
          )
          .take(WINDOW_CAP);

  const rows = await Promise.all(
    windowDocs.map(async (release): Promise<BoardRow | null> => {
      const edition = await cache.edition(release.editionId);
      if (!edition || edition.status !== "active") return null;
      const series = (await Promise.all(release.seriesIds.map(cache.series))).flatMap((doc) =>
        doc?.status === "active" ? [doc] : [],
      );
      if (!showMature && series.some((doc) => doc.mature)) return null;
      return series.length > 0 ? { release, series } : null;
    }),
  );
  const byPublisher = new Map<Id<"publishers">, Array<BoardRow>>();
  for (const row of rows) {
    if (!row) continue;
    const list = byPublisher.get(row.release.publisherId);
    if (list) list.push(row);
    else byPublisher.set(row.release.publisherId, [row]);
  }
  return byPublisher;
}

/**
 * What each Publisher is releasing in one month, plus the A–Z directory of
 * every active Publisher: the Publishers board's data (`monthBoard` below).
 *
 * `board` has one entry per Publisher with visible Releases that month,
 * busiest first: counts by Format, distinct Series, how many of those are
 * new series (see `debutSeries`), last month's count for a delta, and a few
 * joined rows (joinBrowseRows) for the cover strip. Imprints are Publishers
 * of their own, so they get their own cards and name their parent. Every
 * lookup shares one memo cache (`browseCache`).
 *
 * `directory` lists every active Publisher A–Z with its month count;
 * imprints nest under an active parent (one level, spec'd on the schema),
 * defunct ones are flagged. A malformed month reads as an empty board.
 *
 * Without `showMature`, books of Mature Series and adult-only Publishers
 * are left out of every count, strip, and directory entry (lib/mature.ts).
 * Pass one `cache` to build both views of a month from the same reads, made
 * from the same bounded ctx (lib/boundedReads.ts) so its reads and the
 * board's own share one queue.
 */
async function buildMonthBoard(
  unbounded: QueryCtx,
  year: number,
  month: number,
  showMature: boolean,
  cache?: BrowseCache,
) {
  // A busy month's rows join at once; every read waits its turn in one queue.
  const ctx = boundedReads(unbounded);
  cache ??= browseCache(ctx);
  const fromSort = monthOk(year, month) ? year * 10000 + month * 100 : null;
  const previousSort =
    fromSort === null ? null : month === 1 ? fromSort - 10000 + 1100 : fromSort - 100;

  const [publisherDocs, current, previous] = await Promise.all([
    ctx.db.query("publishers").take(PUBLISHER_SCAN_CAP),
    visibleMonth(ctx, cache, fromSort, showMature),
    visibleMonth(ctx, cache, previousSort, showMature),
  ]);
  const active = new Map(
    publisherDocs
      .filter(
        (doc) => doc.status === "active" && visibleTo(showMature, doc.contentRating === "mature"),
      )
      .map((doc) => [doc._id, doc]),
  );
  const parentOf = (doc: Doc<"publishers">) =>
    doc.parentPublisherId ? (active.get(doc.parentPublisherId) ?? null) : null;

  // The Series an Edition debuts, or null. A debut is a standard Edition
  // (no Edition Line, so not a Deluxe Vol. 1 repackaging) whose coverage
  // includes an active Volume at Position 1, with no active Release dated
  // before this month in that Edition (a digital Release of a 2019 print
  // Vol. 1 is a backfill) nor anywhere in the Series (a relaunch of a 2005
  // Series is not new). The Series-wide check reads the rebuilt
  // `seriesStats.firstReleaseSort`, so it lags by up to a rebuild; a Series
  // without a stats row yet has no known earlier Release. A year-only date
  // this year (yyyy0000) may well be this month, so it is no evidence of
  // an earlier Release; an earlier month of this year is. Memoized per
  // Edition; the Release checks read only the few Vol. 1 Editions.
  const debutSeries = memoize(async (editionId: Id<"editions">) => {
    const edition = await cache.edition(editionId);
    if (!edition || edition.editionLineId || fromSort === null) return null;
    const earlier = (sort: number) => sort > 0 && sort < fromSort && sort !== year * 10000;
    let seriesId: Id<"series"> | null = null;
    for (const row of await cache.coverage(edition._id)) {
      const volume = await cache.volume(row.volumeId);
      if (volume?.status === "active" && volume.position === 1) {
        seriesId = volume.seriesId;
        break;
      }
    }
    if (!seriesId) return null;
    const siblings = await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
      .take(EDITION_RELEASE_CAP);
    if (siblings.some((doc) => doc.status === "active" && earlier(doc.pubDate?.sort ?? 0))) {
      return null;
    }
    const stats = await seriesStatsRow(ctx, seriesId);
    return earlier(stats?.firstReleaseSort ?? 0) ? null : seriesId;
  });

  // Whether a Release has jacket art the strip can show: a stored cover,
  // or an ISBN to fetch it by. Read through the cache, so joinBrowseRows
  // reuses the lookup for the picks.
  const hasArt = async (release: Doc<"releases">) => {
    const cover = await cache.cover(release);
    return cover.coverUrl !== null || cover.coverIsbns.length > 0;
  };

  const cards = await Promise.all(
    [...current].map(async ([publisherId, rows]) => {
      const publisher = active.get(publisherId);
      // Rows of an inactive Publisher show unattributed in the browser;
      // there is no card to hang them on.
      if (!publisher) return null;

      const series = new Set(rows.flatMap((row) => row.series.map((doc) => doc._id)));
      const debuts = await Promise.all(
        rows.map(async ({ release }) => {
          const debut = await debutSeries(release.editionId);
          return debut !== null && series.has(debut) ? debut : null;
        }),
      );
      const newSeries = new Set(debuts.flatMap((debut) => (debut ? [debut] : [])));
      const physical = rows.filter((row) => row.release.format === "physical").length;

      // The cover strip: one Release per Series, preferring ones with art
      // (stored, or an ISBN to fetch it by), then new series, then physical
      // over digital (a shelf shows the jacket), else date then title order.
      // Candidates are ranked before any join, then walked in (new series,
      // Format) order in batches of BOARD_COVER_CAP tested for art in
      // parallel. A batch holds only candidates that can still change the
      // picks (a lead Series with no art found yet) and at most one per
      // Series; a second one waits for the next batch, in case the first
      // has no art. Stop at BOARD_COVER_CAP Series with art and fill from
      // the best artless ones; only the picks get joined.
      const ranked = rows
        .map((row, index) => ({
          ...row,
          rank: (debuts[index] ? 0 : 2) + (row.release.format === "physical" ? 0 : 1),
        }))
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            (a.release.pubDate?.sort ?? 0) - (b.release.pubDate?.sort ?? 0) ||
            (a.series[0]?.title ?? "").localeCompare(b.series[0]?.title ?? ""),
        );
      const withArt: Array<Doc<"releases">> = [];
      const artless = new Map<Id<"series">, Doc<"releases">>();
      const artSeries = new Set<Id<"series">>();
      let next = 0;
      while (withArt.length < BOARD_COVER_CAP && next < ranked.length) {
        const batch: Array<{ release: Doc<"releases">; lead: Id<"series"> }> = [];
        while (batch.length < BOARD_COVER_CAP && next < ranked.length) {
          const {
            release,
            series: [lead],
          } = ranked[next]!;
          if (lead && batch.some((entry) => entry.lead === lead._id)) break;
          next++;
          if (lead && !artSeries.has(lead._id)) batch.push({ release, lead: lead._id });
        }
        const art = await Promise.all(batch.map(({ release }) => hasArt(release)));
        for (const [i, { release, lead }] of batch.entries()) {
          if (withArt.length === BOARD_COVER_CAP) break;
          if (art[i]) {
            artSeries.add(lead);
            withArt.push(release);
          } else if (!artless.has(lead)) {
            artless.set(lead, release);
          }
        }
      }
      const picks = [
        ...withArt,
        ...[...artless].flatMap(([seriesId, release]) =>
          artSeries.has(seriesId) ? [] : [release],
        ),
      ].slice(0, BOARD_COVER_CAP);
      // Joined exactly as the browser joins them, kept in pick order.
      const joined = new Map((await joinBrowseRows(ctx, picks, cache)).map((row) => [row.id, row]));
      const covers = picks.flatMap((release) => joined.get(release._id) ?? []);

      const parent = parentOf(publisher);
      return {
        publisher: {
          name: publisher.name,
          slug: publisher.slug,
          parent: parent ? { name: parent.name, slug: parent.slug } : null,
        },
        releases: rows.length,
        physical,
        digital: rows.length - physical,
        series: series.size,
        newSeries: newSeries.size,
        previousReleases: previous.get(publisherId)?.length ?? 0,
        covers,
      };
    }),
  );
  const board = cards.flatMap((card) => (card ? [card] : []));
  board.sort((a, b) => b.releases - a.releases || a.publisher.name.localeCompare(b.publisher.name));

  // The directory: top-level Publishers A–Z, each with its imprints.
  const entry = (doc: Doc<"publishers">) => ({
    name: doc.name,
    slug: doc.slug,
    defunct: doc.defunct === true,
    releases: current.get(doc._id)?.length ?? 0,
  });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const docs = [...active.values()];
  const directory = docs
    .filter((doc) => parentOf(doc) === null)
    .map((doc) => ({
      ...entry(doc),
      imprints: docs
        .filter((imprint) => parentOf(imprint)?._id === doc._id)
        .map(entry)
        .sort(byName),
    }))
    .sort(byName);

  return { board, directory };
}

type MonthBoard = Awaited<ReturnType<typeof buildMonthBoard>>;

/** A real calendar month; anything else reads as an empty board. */
function monthOk(year: number, month: number) {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= 1000 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12
  );
}

/**
 * The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): one month's
 * `buildMonthBoard`. A month inside the rolling window (`boardWindow`) is
 * served from its precomputed copy in `publisherBoards`, one document read,
 * so paging months is quick and the query cache holds until a rebuild
 * actually changes the month. Any other month, an empty one, or one not
 * built yet (or built in an older shape) is computed live. Each month is
 * kept in both views, with and without Mature Series (`showMature`).
 */
export const monthBoard = query({
  args: { year: v.number(), month: v.number(), ...showMatureArg },
  handler: async (ctx, { year, month, showMature = false }): Promise<MonthBoard> => {
    if (monthOk(year, month)) {
      const stored = await ctx.db
        .query("publisherBoards")
        .withIndex("by_month_and_mature", (q) =>
          q.eq("month", year * 100 + month).eq("mature", showMature ? true : undefined),
        )
        .unique();
      // Written by storeBoard from buildMonthBoard's result, in this shape
      // as long as the version matches.
      if (stored?.version === BOARD_VERSION) return JSON.parse(stored.payload) as MonthBoard;
    }
    return await buildMonthBoard(ctx, year, month, showMature);
  },
});

// ---------- Precomputed boards (scheduled) ----------

/**
 * The months kept precomputed: January of last year through December two
 * years out (2025-01 … 2028-12 during 2026), so recent history and every
 * announced month page from storage. Keys are yyyymm.
 */
export function boardWindow(now: Date): { from: number; to: number } {
  const year = now.getUTCFullYear();
  return { from: (year - 1) * 100 + 1, to: (year + 2) * 100 + 12 };
}

/**
 * The months around today that change most (last month through three months
 * out), rebuilt every hour; the rest of the window is rebuilt every six.
 */
export function nearMonths(now: Date): { from: number; to: number } {
  const key = (offset: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
  };
  return { from: key(-1), to: key(3) };
}

/** Largest board stored, in UTF-16 units: well under the 1 MiB value limit. */
const MAX_BOARD_PAYLOAD = 700_000;

/** Bump when `buildMonthBoard`'s result changes shape: older rows are then ignored. */
const BOARD_VERSION = 3;

/**
 * Recompute the months in `boardWindow` (only `nearMonths` for scope "near")
 * and store the ones that changed, then drop stored months that have left
 * the window. crons.ts runs "near" hourly and the whole window every six
 * hours. Each month is computed by a query and written by a small mutation,
 * so imports never contend with the board's large read set. A month with no
 * cards is not stored (its live board reads only the publisher list), and a
 * month that fails to compute loses its stored copy rather than going stale,
 * so it falls back to live. Idempotent; safe to run by hand:
 * `npx convex run publisher:rebuildBoards`.
 */
export const rebuildBoards = internalAction({
  args: { scope: v.optional(v.literal("near")) },
  handler: async (ctx, { scope }) =>
    withExceptionCapture("publisher.rebuildBoards", ctx, async () => {
      const startedAt = Date.now();
      const window = boardWindow(new Date(startedAt));
      const { from, to } = scope === "near" ? nearMonths(new Date(startedAt)) : window;
      let changed = 0;
      let failed = 0;
      for (let key = from; key <= to; key = key % 100 === 12 ? key + 89 : key + 1) {
        let boards: { general: MonthBoard; mature: MonthBoard } | null = null;
        try {
          boards = await ctx.runQuery(internal.publisher.computeBoard, {
            year: Math.floor(key / 100),
            month: key % 100,
          });
        } catch (error) {
          failed++;
          console.error(`publisher board ${key} failed to build`, error);
        }
        for (const mature of [false, true]) {
          const board = boards && (mature ? boards.mature : boards.general);
          const json = board ? JSON.stringify(board) : "";
          // A payload near Convex's 1 MiB value limit can't be stored; that
          // month computes live instead (today's boards are ~40 KB).
          const payload =
            board && board.board.length > 0 && json.length < MAX_BOARD_PAYLOAD ? json : null;
          const wrote: boolean = await ctx.runMutation(internal.publisher.storeBoard, {
            month: key,
            ...(mature ? { mature: true as const } : {}),
            payload,
            builtAt: startedAt,
          });
          if (wrote) changed++;
        }
      }
      const dropped: number = await ctx.runMutation(internal.publisher.dropBoardsOutside, window);
      return { changed, failed, dropped, ms: Date.now() - startedAt };
    }),
});

/**
 * One month's board in both views, computed live from one shared set of
 * reads, bypassing the stored copies.
 */
export const computeBoard = internalQuery({
  args: { year: v.number(), month: v.number() },
  handler: async (
    unbounded,
    { year, month },
  ): Promise<{ general: MonthBoard; mature: MonthBoard }> => {
    const ctx = boundedReads(unbounded);
    const cache = browseCache(ctx);
    return {
      general: await buildMonthBoard(ctx, year, month, false, cache),
      mature: await buildMonthBoard(ctx, year, month, true, cache),
    };
  },
});

/**
 * Store a month's board, or delete it for a null payload, writing only when
 * that changes something so monthBoard's cached result survives a rebuild
 * that changed nothing. Returns whether it wrote.
 */
export const storeBoard = internalMutation({
  args: {
    month: v.number(),
    mature: v.optional(v.literal(true)),
    payload: v.union(v.string(), v.null()),
    builtAt: v.number(),
  },
  handler: async (ctx, { month, mature, payload, builtAt }) => {
    const stored = await ctx.db
      .query("publisherBoards")
      .withIndex("by_month_and_mature", (q) => q.eq("month", month).eq("mature", mature))
      .unique();
    if (payload === null) {
      if (stored) await ctx.db.delete(stored._id);
      return stored !== null;
    }
    if (stored?.payload === payload && stored.version === BOARD_VERSION) return false;
    const row = { month, ...(mature ? { mature } : {}), version: BOARD_VERSION, payload, builtAt };
    if (stored) await ctx.db.replace(stored._id, row);
    else await ctx.db.insert("publisherBoards", row);
    return true;
  },
});

/** Months outside `boardWindow` would go stale unseen; they compute live instead. */
export const dropBoardsOutside = internalMutation({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const [before, after] = await Promise.all([
      ctx.db
        .query("publisherBoards")
        .withIndex("by_month_and_mature", (q) => q.lt("month", from))
        .take(BOARD_DROP_CAP),
      ctx.db
        .query("publisherBoards")
        .withIndex("by_month_and_mature", (q) => q.gt("month", to))
        .take(BOARD_DROP_CAP),
    ]);
    for (const doc of [...before, ...after]) await ctx.db.delete(doc._id);
    return before.length + after.length;
  },
});
