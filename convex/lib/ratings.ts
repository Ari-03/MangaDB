// Ratings, Reviews and Favorites share one notion of a target (CONTEXT.md:
// Rating, Review, Favorite): a Series, a Volume, or an omnibus Edition. An
// Edition that collects more than one Volume is rated as one book; a
// single-volume Edition rates its Volume instead, so it is never a target.
// This module holds what the slices and the catalog operations need: the
// target validators and lookups, and the per-target rating aggregate
// (ratingStats) writes with their Series library projection. Reading the
// aggregate lives in lib/ratingStats.ts, a leaf both this module and
// seriesBrowse.ts import, so the dependency runs one way.
//
// The aggregate sums canonical 1-100 scores (lib/scoreFormat.ts) and moves
// in the same transaction as the Rating that changes it
// (`applyRatingDelta`), so "8.4 · 12 ratings" is exact the moment a rating
// lands; merges and splits, which move many rows at once, recount instead
// (`recountRatings`). Only a Series' aggregate is copied into its library
// row and pack entry (seriesBrowse.syncRatingProjection) for "Top rated";
// Volume and Edition aggregates never feed it.

import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveActiveSeries } from "../catalog";
import { editionCoverage } from "../catalogPages";
import { followMerges, getActive } from "./merges";
import { syncRatingProjection } from "../seriesBrowse";
import { statsRow, summaryOf, type TargetId } from "./ratingStats";

export {
  RATING_RANK_MIN,
  pageTargetIdArg,
  ratingRankOf,
  ratingSummary,
  targetIdArg,
  type RatingSummary,
  type TargetId,
  type TargetKind,
} from "./ratingStats";

/** A target as public pages know it: its kind and public ID. */
export const targetRefArg = v.object({
  kind: v.union(v.literal("series"), v.literal("volume"), v.literal("edition")),
  publicId: v.number(),
});
export type TargetRef = Infer<typeof targetRefArg>;

/** A page target as Comments take it: a Series or a Volume, never an Edition. */
export const pageTargetRefArg = v.object({
  kind: v.union(v.literal("series"), v.literal("volume")),
  publicId: v.number(),
});
export type PageTargetRef = Infer<typeof pageTargetRefArg>;
export type PageTargetId = Extract<TargetId, { kind: PageTargetRef["kind"] }>;

/**
 * The target's key on a ratings / reviews / ratingStats row. Exactly one of
 * seriesId / volumeId / editionId is ever set: every write builds the key
 * here, and `targetOfRow` reads a row back only when it holds exactly one.
 */
export function targetFields(target: TargetId) {
  switch (target.kind) {
    case "series":
      return { seriesId: target.id };
    case "volume":
      return { volumeId: target.id };
    case "edition":
      return { editionId: target.id };
  }
}

/** The target a stored row points at, or null unless exactly one key is set. */
export function targetOfRow(row: {
  seriesId?: Id<"series">;
  volumeId?: Id<"volumes">;
  editionId?: Id<"editions">;
}): TargetId | null {
  const targets: TargetId[] = [];
  if (row.seriesId) targets.push({ kind: "series", id: row.seriesId });
  if (row.volumeId) targets.push({ kind: "volume", id: row.volumeId });
  if (row.editionId) targets.push({ kind: "edition", id: row.editionId });
  return targets.length === 1 ? targets[0]! : null;
}

/** A target that exists and is active, with the Series it belongs to. */
type Active<Target extends TargetId> = { target: Target; series: Doc<"series"> };
/** Why a target cannot be rated, as the ConvexError a mutation throws. */
type Refusal = { code: "notFound" | "unmapped" | "rateVolume"; message?: string };
/** An omnibus Edition as a target, with the Edition and its coverage read on the way. */
type OmnibusEdition = Active<Extract<TargetId, { kind: "edition" }>> & {
  edition: Doc<"editions">;
  info: Awaited<ReturnType<typeof editionCoverage>>;
};

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
 * An active Edition through merges that is rated as one book: its Volume
 * Coverage is mapped and names more than one Volume. Its Series is the
 * Edition's own (editionCoverage: the first covered Volume's). A
 * single-volume Edition is refused with `rateVolume`, naming the Volume to
 * rate instead. Whether it is an omnibus counts every covered Volume, hidden
 * ones too (`volumeCount`), so hiding a Volume or Series never turns an
 * omnibus into a book "rated through its Volume": while too little of it is
 * visible to be one book it is `notFound`, like any hidden target. Exported
 * for the library's Favorites, which list the Edition's title and art from
 * the same read.
 */
export async function omnibusEdition(
  ctx: QueryCtx,
  doc: Doc<"editions"> | null,
): Promise<OmnibusEdition | Refusal> {
  const edition = await followMerges(ctx, "editions", doc);
  if (!edition) return { code: "notFound" };
  const info = await editionCoverage(ctx, edition);
  if (info.coverageUnmapped) {
    return {
      code: "unmapped",
      message: "Which volumes this book collects is not mapped yet, so it cannot be rated.",
    };
  }
  const visible = new Map(info.coverage.map((row) => [row.volumePublicId, row]));
  if (info.volumeCount <= 1) {
    const [only] = visible.values();
    return {
      code: "rateVolume",
      message: only
        ? `This book collects one volume: rate ${only.volumeTitle} on its own page.`
        : "This book is rated through the volumes it collects.",
    };
  }
  if (visible.size <= 1) return { code: "notFound" };
  const series = info.series ? await resolveActiveSeries(ctx, info.series.publicId) : null;
  if (!series) return { code: "notFound" };
  return { target: { kind: "edition", id: edition._id }, series, edition, info };
}

/** A stored target's surviving active record with its Series, or why not. */
async function activeTarget(ctx: QueryCtx, target: TargetId): Promise<Active<TargetId> | Refusal> {
  switch (target.kind) {
    case "series": {
      const series = await getActive(ctx, "series", target.id);
      return series ? { target: { kind: "series", id: series._id }, series } : { code: "notFound" };
    }
    case "volume": {
      const found = await activeVolume(ctx, await ctx.db.get(target.id));
      return found
        ? { target: { kind: "volume", id: found.volume._id }, series: found.series }
        : { code: "notFound" };
    }
    case "edition":
      return await omnibusEdition(ctx, await ctx.db.get(target.id));
  }
}

/** The stored record a public target names, before merges and status. */
async function targetByPublicId(ctx: QueryCtx, ref: TargetRef): Promise<TargetId | null> {
  switch (ref.kind) {
    case "series": {
      const series = await resolveActiveSeries(ctx, ref.publicId);
      return series ? { kind: "series", id: series._id } : null;
    }
    case "volume": {
      const volume = await ctx.db
        .query("volumes")
        .withIndex("by_publicId", (q) => q.eq("publicId", ref.publicId))
        .unique();
      return volume ? { kind: "volume", id: volume._id } : null;
    }
    case "edition": {
      const edition = await ctx.db
        .query("editions")
        .withIndex("by_publicId", (q) => q.eq("publicId", ref.publicId))
        .unique();
      return edition ? { kind: "edition", id: edition._id } : null;
    }
  }
}

/**
 * Resolve a public target to its surviving active record, with the Series
 * it belongs to (for a Volume or Edition, its Series). Null when unknown,
 * hidden, or not a target (a single-volume or unmapped Edition).
 */
export async function resolveTarget(
  ctx: QueryCtx,
  ref: PageTargetRef,
): Promise<Active<PageTargetId> | null>;
export async function resolveTarget(
  ctx: QueryCtx,
  ref: TargetRef,
): Promise<Active<TargetId> | null>;
export async function resolveTarget(
  ctx: QueryCtx,
  ref: TargetRef,
): Promise<Active<TargetId> | null> {
  const stored = await targetByPublicId(ctx, ref);
  if (!stored) return null;
  const found = await activeTarget(ctx, stored);
  return "target" in found ? found : null;
}

/**
 * The mutation-side twin of resolveTarget: follows merges, throws when gone
 * (`notFound`, with `goneMessage`) or when an Edition is no target
 * (`unmapped`, `rateVolume`).
 */
export async function requireActiveTarget(
  ctx: QueryCtx,
  target: PageTargetId,
  goneMessage?: string,
): Promise<Active<PageTargetId>>;
export async function requireActiveTarget(
  ctx: QueryCtx,
  target: TargetId,
  goneMessage?: string,
): Promise<Active<TargetId>>;
export async function requireActiveTarget(
  ctx: QueryCtx,
  target: TargetId,
  goneMessage = "Nothing to rate here any more.",
): Promise<Active<TargetId>> {
  const found = await activeTarget(ctx, target);
  if ("target" in found) return found;
  throw new ConvexError({ code: found.code, message: found.message ?? goneMessage });
}

/** One user's Rating of one target, or null. */
export async function ratingRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: TargetId,
): Promise<Doc<"ratings"> | null> {
  const ratings = ctx.db.query("ratings");
  switch (target.kind) {
    case "series":
      return await ratings
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", target.id))
        .unique();
    case "volume":
      return await ratings
        .withIndex("by_user_volume", (q) => q.eq("userId", userId).eq("volumeId", target.id))
        .unique();
    case "edition":
      return await ratings
        .withIndex("by_user_edition", (q) => q.eq("userId", userId).eq("editionId", target.id))
        .unique();
  }
}

/** One user's Review of one target, or null. */
export async function reviewRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: TargetId,
): Promise<Doc<"reviews"> | null> {
  const reviews = ctx.db.query("reviews");
  switch (target.kind) {
    case "series":
      return await reviews
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", target.id))
        .unique();
    case "volume":
      return await reviews
        .withIndex("by_user_volume", (q) => q.eq("userId", userId).eq("volumeId", target.id))
        .unique();
    case "edition":
      return await reviews
        .withIndex("by_user_edition", (q) => q.eq("userId", userId).eq("editionId", target.id))
        .unique();
  }
}

/** Every Rating of one target. */
export async function ratingsOf(ctx: QueryCtx, target: TargetId): Promise<Array<Doc<"ratings">>> {
  const ratings = ctx.db.query("ratings");
  switch (target.kind) {
    case "series":
      return await ratings.withIndex("by_series", (q) => q.eq("seriesId", target.id)).collect();
    case "volume":
      return await ratings.withIndex("by_volume", (q) => q.eq("volumeId", target.id)).collect();
    case "edition":
      return await ratings.withIndex("by_edition", (q) => q.eq("editionId", target.id)).collect();
  }
}

/** Every Review of one target, any status. */
export async function reviewsOf(ctx: QueryCtx, target: TargetId): Promise<Array<Doc<"reviews">>> {
  const reviews = ctx.db.query("reviews");
  switch (target.kind) {
    case "series":
      return await reviews.withIndex("by_series", (q) => q.eq("seriesId", target.id)).collect();
    case "volume":
      return await reviews.withIndex("by_volume", (q) => q.eq("volumeId", target.id)).collect();
    case "edition":
      return await reviews.withIndex("by_edition", (q) => q.eq("editionId", target.id)).collect();
  }
}

// ---------- the aggregate ----------

/**
 * Write a target's aggregate and carry a Series' (only a Series': Volume and
 * Edition aggregates never rank in "Top rated") into the library projection.
 */
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
 * Move a target's aggregate by one Rating's score changing from `before` to
 * `after` (null is "no rating"): set, change, and clear are all this one step.
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
    rows.reduce((sum, row) => sum + row.score, 0),
    rows.length,
  );
}
