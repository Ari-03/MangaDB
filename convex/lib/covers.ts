import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Some publishers serve a generic "no cover yet" SVG where the artwork would
// be, and the importers stored those as cover images. Real cover art is
// always a raster image, so an SVG (or a tiny file) is treated as no cover:
// the site draws its cloth placeholder instead of a blank white rectangle.
const MIN_COVER_BYTES = 2048;

/** Public URL for a stored cover, or null when the file is only a placeholder. */
export async function coverUrl(
  ctx: QueryCtx,
  storageId: Id<"_storage"> | null | undefined,
): Promise<string | null> {
  if (!storageId) return null;
  const meta = await ctx.db.system.get(storageId);
  if (!meta) return null;
  if (meta.contentType === "image/svg+xml" || meta.size < MIN_COVER_BYTES) {
    return null;
  }
  return await ctx.storage.getUrl(storageId);
}

/**
 * The ISBN-13 the site should look cover art up by for a Release: its own,
 * else a sibling Release of the same Edition, else any active Release of
 * another Edition covering the same Volume. The same book is often on file
 * twice — once from a publisher's own site without an ISBN, once from the
 * distribution catalog with one — and the jacket is the same either way.
 */
export async function coverIsbnForRelease(
  ctx: QueryCtx,
  release: {
    _id: Id<"releases">;
    editionId: Id<"editions">;
    isbn13?: string;
    format: "physical" | "digital";
  },
): Promise<string | null> {
  if (release.isbn13) return release.isbn13;
  const own = await isbnInEdition(ctx, release.editionId, release._id);
  if (own) return own;
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", release.editionId))
    .first();
  if (!coverage) return null;
  const covering = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", coverage.volumeId))
    .collect();
  for (const row of covering) {
    if (row.editionId === release.editionId) continue;
    const isbn = await isbnInEdition(ctx, row.editionId, release._id);
    if (isbn) return isbn;
  }
  return null;
}

// Physical first: that jacket is the one a shelf should show.
async function isbnInEdition(
  ctx: QueryCtx,
  editionId: Id<"editions">,
  except: Id<"releases">,
): Promise<string | null> {
  const releases = (
    await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .collect()
  ).filter((r) => r._id !== except && r.status === "active" && r.isbn13);
  return (
    releases.find((r) => r.format === "physical")?.isbn13 ??
    releases[0]?.isbn13 ??
    null
  );
}

/**
 * A jacket for a whole Series: the first Volume in reading order that has a
 * Release with an ISBN (or stored art). Cheap enough for a home-page shelf.
 */
export async function seriesCover(
  ctx: QueryCtx,
  seriesId: Id<"series">,
): Promise<{ coverUrl: string | null; coverIsbn: string | null }> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .take(3);
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    const covering = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const row of covering) {
      const releases = (
        await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", row.editionId))
          .collect()
      ).filter((r) => r.status === "active");
      for (const release of releases) {
        const url = await coverUrl(ctx, release.coverImage?.storageId);
        if (url) return { coverUrl: url, coverIsbn: release.isbn13 ?? null };
      }
      const isbn =
        releases.find((r) => r.format === "physical" && r.isbn13)?.isbn13 ??
        releases.find((r) => r.isbn13)?.isbn13;
      if (isbn) return { coverUrl: null, coverIsbn: isbn };
    }
  }
  return { coverUrl: null, coverIsbn: null };
}
