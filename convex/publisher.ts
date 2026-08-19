// The Publisher Spotlight page (ticket #25, spec §10/§11): `/publisher/{slug}`
// is a publisher-led profile with a bounded upcoming-Releases lane and a clear
// route into the main Releases browser — no separate cross-publisher overview.
//
// Publishers are the slug-only URL exception (spec §8): the slug is identity,
// so a rename 301s through publisherSlugRedirects instead of a public-ID URL.
// The query resolves old slugs (and merged Publishers) to `redirectTo` so the
// route can issue the 301 itself.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { COUNT_CAP } from "./catalog";
import { followMerges } from "./catalogPages";
import { joinBrowseRows } from "./releases";

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
