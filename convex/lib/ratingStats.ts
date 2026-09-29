// The per-target rating aggregate (ratingStats) as readers see it, and the
// "Top rated" rank derived from it. A leaf module: lib/ratings.ts (which
// writes the aggregate) and seriesBrowse.ts (which projects it into the
// library) both import from here, so neither has to import the other's
// half back.

import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Ratings a Series needs before "Top rated" ranks it; fewer sort last. */
export const RATING_RANK_MIN = 3;

/** A target as mutations take it: the document ID a query returned. */
export const targetIdArg = v.union(
  v.object({ kind: v.literal("series"), id: v.id("series") }),
  v.object({ kind: v.literal("volume"), id: v.id("volumes") }),
);
export type TargetId = Infer<typeof targetIdArg>;

/** `average` is on the 1-100 score scale; clients render it in a Rating Format. */
export type RatingSummary = { average: number | null; count: number };

/** A target's ratingStats row, or null when nobody has rated it. */
export async function statsRow(ctx: QueryCtx, target: TargetId): Promise<Doc<"ratingStats"> | null> {
  return target.kind === "series"
    ? await ctx.db
        .query("ratingStats")
        .withIndex("by_series", (q) => q.eq("seriesId", target.id))
        .unique()
    : await ctx.db
        .query("ratingStats")
        .withIndex("by_volume", (q) => q.eq("volumeId", target.id))
        .unique();
}

/** The public summary of a stored (or about-to-be-stored) sum and count. */
export function summaryOf(row: { sum: number; count: number } | null): RatingSummary {
  if (!row || row.count <= 0) return { average: null, count: 0 };
  return { average: row.sum / row.count, count: row.count };
}

/** A target's public rating aggregate: the unrounded average (null when unrated) and count. */
export async function ratingSummary(ctx: QueryCtx, target: TargetId): Promise<RatingSummary> {
  return summaryOf(await statsRow(ctx, target));
}

/** A Series' "Top rated" sort key: its 1-100 average once RATING_RANK_MIN ratings are in, else 0. */
export function ratingRankOf(summary: RatingSummary): number {
  return summary.count >= RATING_RANK_MIN && summary.average !== null ? summary.average : 0;
}
