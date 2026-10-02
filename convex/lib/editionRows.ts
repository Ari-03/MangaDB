// An Edition's own rows and the Series its Releases carry, read the same way
// by every write path that re-derives them (merge and Split, proposal
// approval, the data repair).

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** An Edition's Volume Coverage rows, in `order` (the index sorts them). */
export async function coverageOf(ctx: QueryCtx, editionId: Id<"editions">) {
  return await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

/** An Edition's Releases, whatever their status. */
export async function releasesOf(ctx: QueryCtx, editionId: Id<"editions">) {
  return await ctx.db
    .query("releases")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

/**
 * The Series an Edition's Releases carry (`seriesIds`, spec §8): those of
 * its covered Volumes in coverage order, hidden ones included, or, for
 * Unmapped Packaging that covers nothing yet, its Edition Line's.
 */
export async function editionSeriesIds(
  ctx: QueryCtx,
  edition: Doc<"editions">,
): Promise<Id<"series">[]> {
  const seriesIds: Id<"series">[] = [];
  for (const row of await coverageOf(ctx, edition._id)) {
    const volume = await ctx.db.get(row.volumeId);
    if (volume && !seriesIds.includes(volume.seriesId)) seriesIds.push(volume.seriesId);
  }
  if (seriesIds.length === 0 && edition.editionLineId) {
    const line = await ctx.db.get(edition.editionLineId);
    if (line) seriesIds.push(line.seriesId);
  }
  return seriesIds;
}
