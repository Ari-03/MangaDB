import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { politeFetch } from "./http";

// Some publishers serve a generic "no cover yet" SVG where the artwork would
// be, and the importers once stored those as cover images. Real cover art is
// always a raster image, so an SVG (or a tiny file) is treated as no cover:
// the site draws its cloth placeholder instead of a blank white rectangle.
// `storeCover` applies the same rule before storing anything.
export const MIN_COVER_BYTES = 2048;

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
 * Whether a source's art at `coverUrl` should be (re)stored on a Release:
 * none on file yet, or the publisher now serves it from a different URL.
 */
export function coverOutdated(
  coverImage: Doc<"releases">["coverImage"],
  coverUrl: string | undefined,
): boolean {
  return coverUrl !== undefined && coverImage?.sourceUrl !== coverUrl;
}

/** Blobs one action invocation stored, by source URL, so a second format reuses the first. */
export type StoredCovers = Map<string, Id<"_storage">>;

/**
 * Download publisher art (Kodansha, Seven Seas) into file storage and attach
 * it to a Release through `imports.attachCover`, which keeps one blob per
 * Edition and URL. A URL this invocation already stored is not fetched
 * again: callers charging downloads to a budget check `stored.has(url)`
 * first. Throws on a failed download or on a placeholder (not a raster
 * image, or under MIN_COVER_BYTES), which then never reaches storage.
 */
export async function storeCover(
  ctx: ActionCtx,
  stored: StoredCovers,
  args: { releaseId: Id<"releases">; sourceUrl: string; attribution: string; delayMs: number },
): Promise<void> {
  let storageId = stored.get(args.sourceUrl);
  if (storageId === undefined) {
    const blob = await (await politeFetch(args.sourceUrl, args.delayMs)).blob();
    const type = blob.type.split(";")[0]!.trim().toLowerCase();
    if (!type.startsWith("image/") || type === "image/svg+xml" || blob.size < MIN_COVER_BYTES) {
      throw new Error(`placeholder, not stored (${type || "no type"}, ${blob.size} bytes)`);
    }
    storageId = await ctx.storage.store(blob);
  }
  const result: { storageId: Id<"_storage"> | null } = await ctx.runMutation(
    internal.imports.attachCover,
    {
      releaseId: args.releaseId,
      storageId,
      sourceUrl: args.sourceUrl,
      attribution: args.attribution,
    },
  );
  if (result.storageId) stored.set(args.sourceUrl, result.storageId);
  else stored.delete(args.sourceUrl);
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

/** What picking a Series' jacket needs to know about one of its Releases. */
export type SeriesCoverCandidate = Pick<Doc<"releases">, "isbn13" | "format" | "pubDate"> & {
  /** Its Edition is in an Edition Line (omnibus, deluxe…), not the standard run. */
  inLine: boolean;
  /** Position of the first Volume its Edition covers. */
  position: number;
};

/**
 * The ISBN-13 a Series' jacket is looked up by (library shelf, home shelf):
 * physical before digital, published before forthcoming (unannounced books
 * have no art yet), then the earliest Volume, the standard run before an
 * Edition Line covering the same Volume, and the earliest release — so a
 * standard-edition Volume 1 in print when one is on file, else the earliest
 * book that is. Only one ISBN is stored per Series, so the pick favours the
 * Releases the cover upstreams know best.
 */
export function seriesCoverIsbn(
  candidates: ReadonlyArray<SeriesCoverCandidate>,
  now: Date = new Date(),
): string | null {
  const today = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const published = (c: SeriesCoverCandidate) => {
    const sort = c.pubDate?.sort ?? 0;
    return sort > 0 && sort <= today;
  };
  const rank = (c: SeriesCoverCandidate) => [
    c.format === "physical" ? 0 : 1,
    published(c) ? 0 : 1,
    c.position,
    c.inLine ? 1 : 0,
    c.pubDate?.sort || Number.MAX_SAFE_INTEGER,
  ];
  const ranked = candidates
    .flatMap((c) => (c.isbn13 ? [{ isbn13: c.isbn13, key: rank(c) }] : []))
    .sort((a, b) => {
      const n = a.key.findIndex((k, i) => k !== b.key[i]);
      return n < 0 ? 0 : a.key[n]! - b.key[n]!;
    });
  return ranked[0]?.isbn13 ?? null;
}

/**
 * A jacket for a whole Series from its first few Volumes: the first stored
 * cover, else the `seriesCoverIsbn` pick. Cheap enough for a home-page shelf.
 */
export async function seriesCover(
  ctx: QueryCtx,
  seriesId: Id<"series">,
): Promise<{ coverUrl: string | null; coverIsbn: string | null }> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .take(3);
  const candidates: SeriesCoverCandidate[] = [];
  const seen = new Set<Id<"editions">>();
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    const covering = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const row of covering) {
      if (seen.has(row.editionId)) continue;
      seen.add(row.editionId);
      const edition = await ctx.db.get(row.editionId);
      if (!edition || edition.status !== "active") continue;
      const releases = (
        await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", row.editionId))
          .collect()
      ).filter((r) => r.status === "active");
      for (const release of releases) {
        const url = await coverUrl(ctx, release.coverImage?.storageId);
        if (url) return { coverUrl: url, coverIsbn: release.isbn13 ?? null };
        candidates.push({
          ...release,
          inLine: edition.editionLineId !== undefined,
          position: volume.position,
        });
      }
    }
  }
  return { coverUrl: null, coverIsbn: seriesCoverIsbn(candidates) };
}
