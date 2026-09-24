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
