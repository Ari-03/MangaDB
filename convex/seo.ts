// Sitemap data (ticket #39, spec §11): per-entity pages of exactly the
// indexable canonical records — Series, Volumes, Editions, Publishers, and
// Bundles — plus the month range for the month-view sitemap. The server
// route (src/server/sitemaps.ts) composes the canonical URLs from the titles
// returned here (slugs are computed, never stored, spec §8) and renders the
// XML on demand with cache headers; there is no cron.
//
// `lastmod` is each record's latest Revision (spec §11); records that
// predate revision history fall back to their creation time. Hidden and
// merged records never appear — the surviving record carries the URL.

import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { editionCoverage } from "./catalogPages";
import { volumeTitle } from "./lib/titles";

export type SitemapEntity = "series" | "volume" | "edition" | "publisher" | "bundle";

/** yyyymmdd-keyed months only: a year-only date (yyyy0000) has month 0. */
const monthOf = (sort: number) => ({
  year: Math.floor(sort / 10000),
  month: Math.floor(sort / 100) % 100,
});

/** Latest Revision timestamp of one record, else its creation time. */
async function lastmodOf(
  ctx: QueryCtx,
  type: Doc<"revisions">["ref"]["type"],
  id: Id<"publishers" | "series" | "volumes" | "editions" | "releaseBundles">,
  fallback: number,
): Promise<number> {
  const latest = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", type).eq("ref.id", id as never))
    .order("desc")
    .first();
  return latest?._creationTime ?? fallback;
}

/** One sitemap URL's ingredients; the server route computes path + slug. */
type SitemapEntry = {
  publicId: number | null;
  slug: string | null;
  title: string;
  lastmod: number;
};

/**
 * One page of a per-entity child sitemap. Paginated so a child sitemap of
 * any size streams out of Convex in bounded queries; the server route loops
 * `continueCursor` until `isDone`.
 */
export const sitemapPage = query({
  args: {
    entity: v.union(
      v.literal("series"),
      v.literal("volume"),
      v.literal("edition"),
      v.literal("publisher"),
      v.literal("bundle"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { entity, paginationOpts }) => {
    const entries: SitemapEntry[] = [];

    switch (entity) {
      case "series": {
        const result = await ctx.db.query("series").paginate(paginationOpts);
        for (const doc of result.page) {
          if (doc.status !== "active") continue;
          entries.push({
            publicId: doc.publicId,
            slug: null,
            title: doc.title,
            lastmod: await lastmodOf(ctx, "series", doc._id, doc._creationTime),
          });
        }
        return { entries, isDone: result.isDone, continueCursor: result.continueCursor };
      }
      case "volume": {
        const result = await ctx.db.query("volumes").paginate(paginationOpts);
        for (const doc of result.page) {
          if (doc.status !== "active") continue;
          const series = await ctx.db.get(doc.seriesId);
          // A hidden Series hides its Volumes from the public site.
          if (!series || series.status !== "active") continue;
          entries.push({
            publicId: doc.publicId,
            slug: null,
            title: volumeTitle(series.title, doc.label ?? null),
            lastmod: await lastmodOf(ctx, "volume", doc._id, doc._creationTime),
          });
        }
        return { entries, isDone: result.isDone, continueCursor: result.continueCursor };
      }
      case "edition": {
        const result = await ctx.db.query("editions").paginate(paginationOpts);
        for (const doc of result.page) {
          if (doc.status !== "active") continue;
          const { title } = await editionCoverage(ctx, doc);
          entries.push({
            publicId: doc.publicId,
            slug: null,
            title,
            lastmod: await lastmodOf(ctx, "edition", doc._id, doc._creationTime),
          });
        }
        return { entries, isDone: result.isDone, continueCursor: result.continueCursor };
      }
      case "publisher": {
        const result = await ctx.db.query("publishers").paginate(paginationOpts);
        for (const doc of result.page) {
          if (doc.status !== "active") continue;
          entries.push({
            publicId: null,
            // Publishers are the slug-only URL exception (spec §11).
            slug: doc.slug,
            title: doc.name,
            lastmod: await lastmodOf(ctx, "publisher", doc._id, doc._creationTime),
          });
        }
        return { entries, isDone: result.isDone, continueCursor: result.continueCursor };
      }
      case "bundle": {
        const result = await ctx.db.query("releaseBundles").paginate(paginationOpts);
        for (const doc of result.page) {
          if (doc.status !== "active") continue;
          entries.push({
            publicId: doc.publicId,
            slug: null,
            title: doc.name,
            lastmod: await lastmodOf(ctx, "releaseBundle", doc._id, doc._creationTime),
          });
        }
        return { entries, isDone: result.isDone, continueCursor: result.continueCursor };
      }
    }
  },
});

/**
 * The dated Release range, as {year, month} bounds for the month-view child
 * sitemap: every `/releases/{yyyy-mm}` between the earliest and latest dated
 * Release is an indexable canonical (the evergreen month landing pages,
 * spec §11). Year-only dates (sort yyyy0000) clamp into that year. Null when
 * no dated Releases exist yet.
 */
export const sitemapMonthRange = query({
  args: {},
  handler: async (ctx) => {
    // `gt 0` skips releases without a pubDate (undefined sorts first).
    const first = await ctx.db
      .query("releases")
      .withIndex("by_date", (q) => q.gt("pubDate.sort", 0))
      .order("asc")
      .first();
    const last = await ctx.db
      .query("releases")
      .withIndex("by_date", (q) => q.gt("pubDate.sort", 0))
      .order("desc")
      .first();
    if (!first?.pubDate || !last?.pubDate) return null;

    const from = monthOf(first.pubDate.sort);
    const to = monthOf(last.pubDate.sort);
    return {
      from: { year: from.year, month: from.month || 1 },
      to: { year: to.year, month: to.month || 12 },
    };
  },
});
