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
 * Art an apply mutation asks its action to store: the Release, its Edition,
 * and the URL the source names for it. The mutation decides the URL (a
 * Kodansha calendar item defers to the volume page's) so the action never
 * downloads one the Release already has.
 */
export type CoverRequest = {
  releaseId: Id<"releases">;
  editionId: Id<"editions">;
  sourceUrl: string;
};

/**
 * The cover to store on `release` from `coverUrl`, or undefined when there
 * is none to fetch or the Release's cover already came from that URL (art,
 * or a placeholder it recorded).
 */
export function coverRequest(
  release: Pick<Doc<"releases">, "_id" | "editionId" | "coverImage">,
  coverUrl: string | undefined,
): CoverRequest | undefined {
  if (coverUrl === undefined || release.coverImage?.sourceUrl === coverUrl) return undefined;
  return { releaseId: release._id, editionId: release.editionId, sourceUrl: coverUrl };
}

/**
 * What one action invocation found at each cover, by `coverKey`: the blob it
 * stored, or "placeholder", so a second format of the same Edition neither
 * downloads nor reports it again. Keyed per Edition, not per URL alone:
 * `imports.attachCover` only knows about sharing within an Edition, so a
 * blob must never be handed to another one.
 */
export type StoredCovers = Map<string, Id<"_storage"> | "placeholder">;

export function coverKey(cover: Pick<CoverRequest, "editionId" | "sourceUrl">): string {
  return `${cover.editionId} ${cover.sourceUrl}`;
}

/** The raster format a jacket comes in, from the file's leading bytes; null for anything else. */
function rasterType(bytes: Uint8Array): string | null {
  const ascii = (offset: number, text: string) =>
    [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * Download publisher art (Kodansha, Seven Seas) into file storage and attach
 * it to a Release through `imports.attachCover`, which keeps one blob per
 * Edition and URL. A cover this invocation already handled for the Edition
 * is not fetched again: callers charging downloads to a budget check
 * `stored.has(coverKey(cover))` first. A placeholder image (an SVG, or
 * under MIN_COVER_BYTES) is recorded on the Release without storing
 * anything, and returns a notice the first time this invocation meets it;
 * art is stored and returns null. A failed download, or a body that is no
 * image at all by header or, failing a usable header, by its bytes (a
 * challenge page behind a 200), throws: nothing is recorded and the cover
 * is tried again next run.
 */
export async function storeCover(
  ctx: ActionCtx,
  stored: StoredCovers,
  args: CoverRequest & { attribution: string; delayMs: number },
): Promise<string | null> {
  const key = coverKey(args);
  const cached = stored.get(key);
  let held = cached;
  let notice: string | null = null;
  if (held === undefined) {
    const res = await politeFetch(args.sourceUrl, args.delayMs);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const header = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const type = header.startsWith("image/") ? header : rasterType(bytes);
    if (type === null) {
      throw new Error(`not an image (${header || "no type"}, ${bytes.length} bytes)`);
    }
    if (type === "image/svg+xml" || bytes.length < MIN_COVER_BYTES) {
      notice = `placeholder, not stored (${type}, ${bytes.length} bytes)`;
      held = "placeholder";
    } else {
      held = await ctx.storage.store(new Blob([bytes], { type }));
    }
  }
  const result: { held: Id<"_storage"> | "placeholder" | null; stale?: true } =
    await ctx.runMutation(internal.imports.attachCover, {
      releaseId: args.releaseId,
      storageId: held === "placeholder" ? undefined : held,
      sourceUrl: args.sourceUrl,
      attribution: args.attribution,
    });
  if (result.stale) {
    // An overlapping run replaced the blob this one remembered: forget it and fetch afresh.
    stored.delete(key);
    return cached === undefined ? notice : await storeCover(ctx, stored, args);
  }
  if (result.held === null) stored.delete(key);
  else stored.set(key, result.held);
  return notice;
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
