// A Series' library row (`seriesStats`) and its entry in the packs
// (`seriesStatsPacks`): the rebuild writes both (seriesBrowse.ts), and the
// projections that cannot wait for it (a rating, the mature flag) patch them
// in place. A leaf module, so import paths can reach them without a cycle
// through seriesBrowse.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Series per pack: block k covers publicIds [k * PACK_SPAN, (k + 1) * PACK_SPAN). */
export const PACK_SPAN = 1000;

/** One Series' filter-and-sort facts, as packed in seriesStatsPacks. */
export type PackEntry = Doc<"seriesStatsPacks">["entries"][number];

/**
 * A Series' library row, or null before the rebuild has written one (or
 * while it is bookless). The rebuild keeps one row per Series.
 */
export async function seriesStatsRow(ctx: QueryCtx, seriesId: Id<"series">) {
  return await ctx.db
    .query("seriesStats")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .unique();
}

/**
 * Rewrite one Series' entry in its pack with `change`, unless the pack or
 * the entry is missing or `holds` says the entry already has it: a pack is
 * a large document many Series share.
 */
export async function patchPackEntry(
  ctx: MutationCtx,
  publicId: number,
  holds: (entry: PackEntry) => boolean,
  change: Partial<PackEntry>,
) {
  const pack = await ctx.db
    .query("seriesStatsPacks")
    .withIndex("by_block", (q) => q.eq("block", Math.floor(publicId / PACK_SPAN)))
    .unique();
  const at = pack?.entries.findIndex((entry) => entry.publicId === publicId) ?? -1;
  if (!pack || at < 0 || holds(pack.entries[at]!)) return;
  const entries = pack.entries.map((entry, i) => (i === at ? { ...entry, ...change } : entry));
  await ctx.db.patch(pack._id, { entries });
}
