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
import { joinBrowseRows, WINDOW_CAP } from "./releases";

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

/**
 * One month's visible Canonical Releases grouped by Publisher, in window
 * (date) order. Same window and visibility as the Releases browser
 * (monthBrowse + joinBrowseRows): active Releases dated inside the month,
 * whose Edition is active and which keep at least one active Series. The
 * Edition and Series lookups ride along so callers don't re-fetch them.
 * A null month (malformed input) is an empty window.
 */
async function visibleMonth(
  ctx: QueryCtx,
  yearMonth: { year: number; month: number } | null,
) {
  // yyyymm00 (month-precision) … yyyymm99 covers every day of the month.
  const fromSort = yearMonth ? yearMonth.year * 10000 + yearMonth.month * 100 : 0;
  const windowDocs = yearMonth
    ? await ctx.db
        .query("releases")
        .withIndex("by_date", (q) =>
          q.gte("pubDate.sort", fromSort).lte("pubDate.sort", fromSort + 99),
        )
        .take(WINDOW_CAP)
    : [];

  const editions = new Map<Id<"editions">, Doc<"editions"> | null>();
  const seriesActive = new Map<Id<"series">, boolean>();
  const byPublisher = new Map<Id<"publishers">, Array<Doc<"releases">>>();
  for (const release of windowDocs) {
    if (release.status !== "active") continue;
    if (!editions.has(release.editionId)) {
      editions.set(release.editionId, await ctx.db.get(release.editionId));
    }
    const edition = editions.get(release.editionId);
    if (!edition || edition.status !== "active") continue;
    let anySeries = false;
    for (const seriesId of release.seriesIds) {
      if (!seriesActive.has(seriesId)) {
        const series = await ctx.db.get(seriesId);
        seriesActive.set(seriesId, series?.status === "active");
      }
      anySeries ||= seriesActive.get(seriesId) === true;
    }
    if (!anySeries) continue;
    const list = byPublisher.get(release.publisherId);
    if (list) list.push(release);
    else byPublisher.set(release.publisherId, [release]);
  }
  return { byPublisher, editions, seriesActive };
}

/**
 * The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): what each
 * Publisher is releasing in one month, plus the A–Z directory of every
 * active Publisher.
 *
 * `board` has one entry per Publisher with visible Releases that month,
 * busiest first: counts by Format, distinct Series, how many of those are
 * new series (a standard Edition — not an Edition Line repackaging —
 * covering the Series' Volume 1 publishes this month), last month's count
 * for a delta, and a few joined rows (joinBrowseRows) for the cover strip.
 * Imprints are Publishers of their own, so they get their own cards and
 * name their parent.
 *
 * `directory` lists every active Publisher A–Z with its month count;
 * imprints nest under an active parent (one level, spec'd on the schema),
 * defunct ones are flagged. A malformed month reads as an empty board.
 */
export const monthBoard = query({
  args: { year: v.number(), month: v.number() },
  handler: async (ctx, { year, month }) => {
    const publisherDocs = await ctx.db
      .query("publishers")
      .take(PUBLISHER_SCAN_CAP);
    const active = new Map(
      publisherDocs
        .filter((doc) => doc.status === "active")
        .map((doc) => [doc._id, doc]),
    );
    const parentOf = (doc: Doc<"publishers">) =>
      doc.parentPublisherId ? (active.get(doc.parentPublisherId) ?? null) : null;

    const monthOk =
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      year >= 1000 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12;
    const current = await visibleMonth(ctx, monthOk ? { year, month } : null);
    const previous = await visibleMonth(
      ctx,
      !monthOk
        ? null
        : month === 1
          ? { year: year - 1, month: 12 }
          : { year, month: month - 1 },
    );

    // Whether an Edition starts its Series: a standard Edition (no Edition
    // Line) whose coverage includes an active Volume at Position 1. Memoized
    // per Edition; returns that Series' ID or null.
    const debutCache = new Map<Id<"editions">, Id<"series"> | null>();
    const debutSeries = async (edition: Doc<"editions">) => {
      const hit = debutCache.get(edition._id);
      if (hit !== undefined) return hit;
      let seriesId: Id<"series"> | null = null;
      if (!edition.editionLineId) {
        const coverage = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .take(50);
        for (const row of coverage) {
          const volume = await ctx.db.get(row.volumeId);
          if (volume?.status === "active" && volume.position === 1) {
            seriesId = volume.seriesId;
            break;
          }
        }
      }
      debutCache.set(edition._id, seriesId);
      return seriesId;
    };

    const board = [];
    for (const [publisherId, releases] of current.byPublisher) {
      const publisher = active.get(publisherId);
      // Rows of an inactive Publisher show unattributed in the browser;
      // there is no card to hang them on.
      if (!publisher) continue;

      const series = new Set<Id<"series">>();
      const newSeries = new Set<Id<"series">>();
      const debutReleases = new Set<Id<"releases">>();
      let physical = 0;
      for (const release of releases) {
        if (release.format === "physical") physical++;
        for (const seriesId of release.seriesIds) {
          if (current.seriesActive.get(seriesId)) series.add(seriesId);
        }
        const edition = current.editions.get(release.editionId);
        const debut = edition ? await debutSeries(edition) : null;
        if (debut && series.has(debut)) {
          newSeries.add(debut);
          debutReleases.add(release._id);
        }
      }

      // The cover strip: one Release per Series, preferring ones with art
      // (stored, or an ISBN to fetch it by), then new series, then physical
      // over digital (a shelf shows the jacket), else window (date) order.
      // Rows are joined exactly as the browser joins them.
      const rows = await joinBrowseRows(ctx, releases);
      const rank = (row: (typeof rows)[number]) =>
        (row.coverUrl || row.coverIsbn ? 0 : 4) +
        (debutReleases.has(row.id) ? 0 : 2) +
        (row.format === "physical" ? 0 : 1);
      const covers: typeof rows = [];
      const coverSeries = new Set<number>();
      for (const row of [...rows].sort((a, b) => rank(a) - rank(b))) {
        const key = row.series[0]?.publicId;
        if (key === undefined || coverSeries.has(key)) continue;
        coverSeries.add(key);
        covers.push(row);
        if (covers.length === BOARD_COVER_CAP) break;
      }

      const parent = parentOf(publisher);
      board.push({
        publisher: {
          name: publisher.name,
          slug: publisher.slug,
          parent: parent ? { name: parent.name, slug: parent.slug } : null,
        },
        releases: releases.length,
        physical,
        digital: releases.length - physical,
        series: series.size,
        newSeries: newSeries.size,
        previousReleases: previous.byPublisher.get(publisherId)?.length ?? 0,
        covers,
      });
    }
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
      releases: current.byPublisher.get(doc._id)?.length ?? 0,
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
