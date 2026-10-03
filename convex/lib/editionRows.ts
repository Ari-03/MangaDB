// An Edition's own rows, the Coverage rows that tie Editions to a Volume,
// and the Series an Edition's Releases carry. Pages, importers and the write
// paths that re-derive them (merge and Split, proposal approval, the data
// repair) all read them through here, so every full read is the same query.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** An Edition's Volume Coverage rows, in `order` (the index sorts them). */
export async function coverageOf(ctx: QueryCtx, editionId: Id<"editions">) {
  return await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

/** The Volume Coverage rows of every Edition covering a Volume, in the order the rows were written. */
export async function coveringOf(ctx: QueryCtx, volumeId: Id<"volumes">) {
  return await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
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
