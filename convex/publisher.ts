// The Publisher Spotlight page (ticket #25, spec §10/§11): `/publisher/{slug}`
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
import { query, type QueryCtx } from "./_generated/server";
import { COUNT_CAP, PUBLISHER_SCAN_CAP } from "./catalog";
import { followMerges } from "./catalogPages";
import {
  browseCache,
  joinBrowseRows,
  memoize,
  WINDOW_CAP,
  type BrowseCache,
} from "./releases";

// The Spotlight lane is bounded (prototype #17): at most LANE_CAP rows within
// the horizon the route requests (~3 months); the full calendar lives in the
// Releases browser. The scan cap covers hidden-row attrition before the slice.
export const LANE_CAP = 12;
const LANE_SCAN_CAP = 100;

/**
 * Find the Publisher a requested slug means: the current slug first, then the
 * rename-redirect table (spec §11), then merged docs to their survivor.
 * Returns the surviving active Publisher — the caller compares its slug to
 * the requested one to decide whether to 301 — or null for unknown/hidden.
 */
async function resolveBySlug(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"publishers"> | null> {
  let doc = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!doc) {
    const redirect = await ctx.db
      .query("publisherSlugRedirects")
      .withIndex("by_fromSlug", (q) => q.eq("fromSlug", slug))
      .unique();
    doc = redirect ? await ctx.db.get(redirect.publisherId) : null;
  }
  return await followMerges(ctx, "publishers", doc);
}

/**
 * Everything the Publisher Spotlight renders. `todaySort`/`horizonSort` are
 * yyyymmdd sort keys the route computes (spec §8 partial dates), bounding the
 * upcoming lane. The scan starts at the current month's yyyymm00 so a
 * this-month day-TBA Release still counts as upcoming; dated rows earlier in
 * the month are already out and drop in memory.
 *
 * Returns `{ redirectTo }` when the requested slug is a renamed Publisher's
 * old slug or a merged Publisher's (the route 301s), null for unknown/hidden.
 */
export const publisherPage = query({
  args: {
    slug: v.string(),
    todaySort: v.number(),
    horizonSort: v.number(),
  },
  handler: async (ctx, { slug, todaySort, horizonSort }) => {
    const publisher = await resolveBySlug(ctx, slug);
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

    let upcoming: Awaited<ReturnType<typeof joinBrowseRows>> = [];
    let scanFull = false;
    if (boundsOk) {
      const monthStart = Math.floor(todaySort / 100) * 100;
      const windowDocs = await ctx.db
        .query("releases")
        .withIndex("by_publisher_date", (q) =>
          q
            .eq("publisherId", publisher._id)
            .gte("pubDate.sort", monthStart)
            .lte("pubDate.sort", horizonSort),
        )
        .take(LANE_SCAN_CAP);
      scanFull = windowDocs.length === LANE_SCAN_CAP;
      const refined = windowDocs.filter(
        (doc) =>
          doc.status === "active" &&
          doc.pubDate !== undefined &&
          // Still upcoming: dated today-or-later, or day-TBA (month/year
          // precision) — past-month TBA rows sit below the index range.
          (doc.pubDate.sort >= todaySort || doc.pubDate.day === undefined),
      );
      upcoming = await joinBrowseRows(ctx, refined);
    }

    // Imprint family, one level deep: the parent company, or the imprints.
    const parentDoc = publisher.parentPublisherId
      ? await followMerges(
          ctx,
          "publishers",
          await ctx.db.get(publisher.parentPublisherId),
        )
      : null;
    const imprintDocs = await ctx.db
      .query("publishers")
      .withIndex("by_parent", (q) => q.eq("parentPublisherId", publisher._id))
      .collect();
    const imprints = imprintDocs
      .filter((doc) => doc.status === "active")
      .map((doc) => ({ name: doc.name, slug: doc.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Profile fact: active Editions in the catalog, capped like catalog.stats.
    const editionDocs = await ctx.db
      .query("editions")
      .withIndex("by_publisher", (q) => q.eq("publisherId", publisher._id))
      .take(COUNT_CAP + 1);
    const activeEditions = editionDocs.filter(
      (doc) => doc.status === "active",
    ).length;

    return {
      publisher: {
        name: publisher.name,
        slug: publisher.slug,
        description: publisher.description ?? null,
      },
      parent: parentDoc ? { name: parentDoc.name, slug: parentDoc.slug } : null,
      imprints,
      upcoming: upcoming.slice(0, LANE_CAP),
      // More upcoming Releases exist beyond the lane (the browser shows all).
      upcomingCapped: upcoming.length > LANE_CAP || scanFull,
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
 * at least one active Series, each with those Series. Lookups go through
 * the caller's `cache`, in parallel. A null month (malformed input) is an
 * empty window.
 */
async function visibleMonth(ctx: QueryCtx, cache: BrowseCache, fromSort: number | null) {
  // yyyymm00 (month-precision) … yyyymm99 covers every day of the month.
  const windowDocs =
    fromSort === null
      ? []
      : await ctx.db
          .query("releases")
          .withIndex("by_date", (q) =>
            q.gte("pubDate.sort", fromSort).lte("pubDate.sort", fromSort + 99),
          )
          .take(WINDOW_CAP);

  const rows = await Promise.all(
    windowDocs.map(async (release): Promise<BoardRow | null> => {
      if (release.status !== "active") return null;
      const edition = await cache.edition(release.editionId);
      if (!edition || edition.status !== "active") return null;
      const series = (await Promise.all(release.seriesIds.map(cache.series))).flatMap(
        (doc) => (doc?.status === "active" ? [doc] : []),
      );
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
 * The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): what each
 * Publisher is releasing in one month, plus the A–Z directory of every
 * active Publisher.
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
 */
export const monthBoard = query({
  args: { year: v.number(), month: v.number() },
  handler: async (ctx, { year, month }) => {
    const monthOk =
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      year >= 1000 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12;
    const fromSort = monthOk ? year * 10000 + month * 100 : null;
    const previousSort =
      fromSort === null ? null : month === 1 ? fromSort - 10000 + 1100 : fromSort - 100;

    const cache = browseCache(ctx);
    const [publisherDocs, current, previous] = await Promise.all([
      ctx.db.query("publishers").take(PUBLISHER_SCAN_CAP),
      visibleMonth(ctx, cache, fromSort),
      visibleMonth(ctx, cache, previousSort),
    ]);
    const active = new Map(
      publisherDocs
        .filter((doc) => doc.status === "active")
        .map((doc) => [doc._id, doc]),
    );
    const parentOf = (doc: Doc<"publishers">) =>
      doc.parentPublisherId ? (active.get(doc.parentPublisherId) ?? null) : null;

    // The Series an Edition debuts, or null. A debut is a standard Edition
    // (no Edition Line, so not a Deluxe Vol. 1 repackaging) whose coverage
    // includes an active Volume at Position 1, and which has no active
    // Release dated before this month: a digital Release of a 2019 print
    // Vol. 1 is a backfill, not a new series. A year-only date this year
    // (yyyy0000) may well be this month, so it is no evidence of an earlier
    // Release; an earlier month of this year is. Memoized per Edition; the
    // Release check reads only the few Vol. 1 Editions.
    const debutSeries = memoize(async (editionId: Id<"editions">) => {
      const edition = await cache.edition(editionId);
      if (!edition || edition.editionLineId || fromSort === null) return null;
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
      const earlier = siblings.some(
        (doc) =>
          doc.status === "active" &&
          doc.pubDate !== undefined &&
          doc.pubDate.sort < fromSort &&
          !(doc.pubDate.month === undefined && doc.pubDate.year === year),
      );
      return earlier ? null : seriesId;
    });

    // Whether a Release has jacket art the strip can show: a stored cover,
    // or an ISBN to fetch it by. Read through the cache, so joinBrowseRows
    // reuses the lookup for the picks.
    const hasArt = async (release: Doc<"releases">) => {
      const cover = await cache.cover(release);
      return cover.coverUrl !== null || cover.coverIsbn !== null;
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
        // Format) order in batches tested for art in parallel. A batch holds
        // only candidates that can still change the picks (a lead Series
        // with no art found yet), as many as there are open slots, so no
        // lookup is spent past the cap. Stop at BOARD_COVER_CAP Series with
        // art and fill from the best artless ones; only the picks get joined.
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
          while (batch.length < BOARD_COVER_CAP - withArt.length && next < ranked.length) {
            const { release, series: [lead] } = ranked[next++]!;
            if (lead && !artSeries.has(lead._id)) batch.push({ release, lead: lead._id });
          }
          const art = await Promise.all(batch.map(({ release }) => hasArt(release)));
          for (const [i, { release, lead }] of batch.entries()) {
            // An earlier candidate in this batch may have found its art.
            if (artSeries.has(lead)) continue;
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
        const joined = new Map(
          (await joinBrowseRows(ctx, picks, cache)).map((row) => [row.id, row]),
        );
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
    board.sort(
      (a, b) =>
        b.releases - a.releases ||
        a.publisher.name.localeCompare(b.publisher.name),
    );

    // The directory: top-level Publishers A–Z, each with its imprints.
    const entry = (doc: Doc<"publishers">) => ({
      name: doc.name,
      slug: doc.slug,
      defunct: doc.defunct === true,
      releases: current.get(doc._id)?.length ?? 0,
    });
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);
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
  },
});
