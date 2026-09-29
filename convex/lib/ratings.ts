// Ratings and Reviews share one notion of a target (CONTEXT.md: Rating,
// Review): a Series or a Volume. This module holds what both slices and the
// catalog operations need: the target validators and lookups, and the
// per-target rating aggregate (ratingStats) with its Series library
// projection.
//
// The aggregate moves in the same transaction as the Rating that changes it
// (`applyRatingDelta`), so "8.4 · 12 ratings" is exact the moment a rating
// lands; merges and splits, which move many rows at once, recount instead
// (`recountRatings`). A Series' aggregate is also copied into its library
// row and pack entry (seriesBrowse.syncRatingProjection) for "Top rated".

import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveActiveSeries } from "../catalog";
import { followMerges } from "../catalogPages";
import { syncRatingProjection } from "../seriesBrowse";

export const RATING_MIN = 1;
export const RATING_MAX = 10;
/** Ratings a Series needs before "Top rated" ranks it; fewer sort last. */
export const RATING_RANK_MIN = 3;

/** A target as public pages know it: its kind and public ID. */
export const targetRefArg = v.object({
  kind: v.union(v.literal("series"), v.literal("volume")),
  publicId: v.number(),
});
export type TargetRef = Infer<typeof targetRefArg>;

/** A target as mutations take it: the document ID a query returned. */
export const targetIdArg = v.union(
  v.object({ kind: v.literal("series"), id: v.id("series") }),
  v.object({ kind: v.literal("volume"), id: v.id("volumes") }),
);
export type TargetId = Infer<typeof targetIdArg>;

/** The target's key on a ratings / reviews / ratingStats row (exactly one is set). */
export function targetFields(target: TargetId) {
  return target.kind === "series" ? { seriesId: target.id } : { volumeId: target.id };
}

/** The target a stored row points at, from whichever key it carries. */
export function targetOfRow(row: {
  seriesId?: Id<"series">;
  volumeId?: Id<"volumes">;
}): TargetId | null {
  if (row.seriesId) return { kind: "series", id: row.seriesId };
  if (row.volumeId) return { kind: "volume", id: row.volumeId };
  return null;
}

/**
 * An active Volume through merges whose Series is active too (a hidden
 * Series hides its Volumes, as on the Volume page), or null.
 */
async function activeVolume(
  ctx: QueryCtx,
  doc: Doc<"volumes"> | null,
): Promise<{ volume: Doc<"volumes">; series: Doc<"series"> } | null> {
  const volume = await followMerges(ctx, "volumes", doc);
  if (!volume) return null;
  const series = await ctx.db.get(volume.seriesId);
  return series && series.status === "active" ? { volume, series } : null;
}

/**
 * Resolve a public target to its surviving active record, with the Series
 * it belongs to (for a Volume, its Series). Null when unknown or hidden.
 */
export async function resolveTarget(
  ctx: QueryCtx,
  ref: TargetRef,
): Promise<{ target: TargetId; series: Doc<"series"> } | null> {
  if (ref.kind === "series") {
    const series = await resolveActiveSeries(ctx, ref.publicId);
    return series ? { target: { kind: "series", id: series._id }, series } : null;
  }
  const stored = await ctx.db
    .query("volumes")
    .withIndex("by_publicId", (q) => q.eq("publicId", ref.publicId))
    .unique();
  const found = await activeVolume(ctx, stored);
  return found ? { target: { kind: "volume", id: found.volume._id }, series: found.series } : null;
}

/** The mutation-side twin of resolveTarget: follows merges, throws when gone. */
export async function requireActiveTarget(ctx: QueryCtx, target: TargetId): Promise<TargetId> {
  if (target.kind === "series") {
    const series = await followMerges(ctx, "series", await ctx.db.get(target.id));
    if (series) return { kind: "series", id: series._id };
  } else {
    const found = await activeVolume(ctx, await ctx.db.get(target.id));
    if (found) return { kind: "volume", id: found.volume._id };
  }
  throw new ConvexError({ code: "notFound", message: "Nothing to rate here any more." });
}

/** One user's Rating of one target, or null. */
export async function ratingRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: TargetId,
): Promise<Doc<"ratings"> | null> {
  return target.kind === "series"
    ? await ctx.db
        .query("ratings")
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", target.id))
        .unique()
    : await ctx.db
        .query("ratings")
        .withIndex("by_user_volume", (q) => q.eq("userId", userId).eq("volumeId", target.id))
        .unique();
}

/** One user's Review of one target, or null. */
export async function reviewRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: TargetId,
): Promise<Doc<"reviews"> | null> {
  return target.kind === "series"
    ? await ctx.db
        .query("reviews")
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", target.id))
        .unique()
    : await ctx.db
        .query("reviews")
        .withIndex("by_user_volume", (q) => q.eq("userId", userId).eq("volumeId", target.id))
        .unique();
}

/** Every Rating of one target. */
export async function ratingsOf(ctx: QueryCtx, target: TargetId): Promise<Array<Doc<"ratings">>> {
  return target.kind === "series"
    ? await ctx.db
        .query("ratings")
        .withIndex("by_series", (q) => q.eq("seriesId", target.id))
        .collect()
    : await ctx.db
        .query("ratings")
        .withIndex("by_volume", (q) => q.eq("volumeId", target.id))
        .collect();
}

/** Every Review of one target, any status. */
export async function reviewsOf(ctx: QueryCtx, target: TargetId): Promise<Array<Doc<"reviews">>> {
  return target.kind === "series"
    ? await ctx.db
        .query("reviews")
        .withIndex("by_series", (q) => q.eq("seriesId", target.id))
        .collect()
    : await ctx.db
        .query("reviews")
        .withIndex("by_volume", (q) => q.eq("volumeId", target.id))
        .collect();
}

// ---------- the aggregate ----------

export type RatingSummary = { average: number | null; count: number };

async function statsRow(ctx: QueryCtx, target: TargetId): Promise<Doc<"ratingStats"> | null> {
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

function summaryOf(row: { sum: number; count: number } | null): RatingSummary {
  if (!row || row.count <= 0) return { average: null, count: 0 };
  return { average: row.sum / row.count, count: row.count };
}

/** A target's public rating aggregate: the unrounded average (null when unrated) and count. */
export async function ratingSummary(ctx: QueryCtx, target: TargetId): Promise<RatingSummary> {
  return summaryOf(await statsRow(ctx, target));
}

/** A Series' "Top rated" sort key: its average once RATING_RANK_MIN ratings are in, else 0. */
export function ratingRankOf(summary: RatingSummary): number {
  return summary.count >= RATING_RANK_MIN && summary.average !== null ? summary.average : 0;
}

/** Write a target's aggregate and carry a Series' into the library projection. */
async function writeStats(ctx: MutationCtx, target: TargetId, sum: number, count: number) {
  const existing = await statsRow(ctx, target);
  if (count <= 0) {
    if (existing) await ctx.db.delete(existing._id);
  } else if (existing) {
    await ctx.db.patch(existing._id, { sum, count });
  } else {
    await ctx.db.insert("ratingStats", { ...targetFields(target), sum, count });
  }
  if (target.kind === "series") {
    await syncRatingProjection(ctx, target.id, summaryOf(count > 0 ? { sum, count } : null));
  }
}

/**
 * Move a target's aggregate by one Rating changing from `before` to `after`
 * (null is "no rating"): set, change, and clear are all this one step.
 */
export async function applyRatingDelta(
  ctx: MutationCtx,
  target: TargetId,
  before: number | null,
  after: number | null,
) {
  const row = await statsRow(ctx, target);
  const sum = (row?.sum ?? 0) + (after ?? 0) - (before ?? 0);
  const count = (row?.count ?? 0) + (after !== null ? 1 : 0) - (before !== null ? 1 : 0);
  await writeStats(ctx, target, sum, count);
}

/** Recount a target's aggregate from its Ratings (after a merge or split moved them). */
export async function recountRatings(ctx: MutationCtx, target: TargetId) {
  const rows = await ratingsOf(ctx, target);
  await writeStats(
    ctx,
    target,
    rows.reduce((sum, row) => sum + row.rating, 0),
    rows.length,
  );
}
