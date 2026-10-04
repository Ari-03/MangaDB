import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { coveringOf, releasesOf } from "./editionRows";
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

/** Whether a body is markup (HTML, XML, SVG) whatever its header claims: the first non-blank byte is `<`. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || (bytes[i]! >= 0x09 && bytes[i]! <= 0x0d))) i++;
  return bytes[i] === 0x3c;
}

/**
 * Whether a cover may be fetched from `url`: publisher pages are untrusted
 * input, so only a public https host, never a loopback, private or IP-literal
 * destination, may be asked for art.
 */
function publicHttps(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || host === "" || host.startsWith("[")) return false;
  if (/^[\d.]+$/.test(host)) return false;
  return !["localhost", "local", "internal", "localdomain"].some(
    (tld) => host === tld || host.endsWith(`.${tld}`),
  );
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
 * art is stored and returns null. A URL off the public https web, a failed
 * download, or a body that is no image at all (markup behind a 200 or even
 * behind an image header; otherwise judged by header, or by its bytes when
 * the header is unusable) throws: nothing is recorded and the cover is
 * tried again next run.
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
    if (!publicHttps(args.sourceUrl)) {
      throw new Error(`refused URL, not a public https host (${args.sourceUrl})`);
    }
    const res = await politeFetch(args.sourceUrl, args.delayMs);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const header = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const image =
      header.startsWith("image/") && (header === "image/svg+xml" || !looksLikeMarkup(bytes));
    const type = image ? header : rasterType(bytes);
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

// How many ISBNs a jacket offers `<Cover>`, best first (src/lib/cover.tsx
// MAX_CANDIDATES applies the same cap): enough to step past a physical ISBN
// nobody has art for to its digital twin, without a long chain of misses per
// cover. Each miss is a request, and may spend a rate-limited OpenLibrary
// lookup (src/server/covers.ts).
export const COVER_CANDIDATES = 3;

/**
 * An Edition's jacket, shared by its page and every row of its Releases:
 * the first stored cover among its active Releases in date order, and the
 * ISBN-13s to look art up by when there is none.
 */
export type Jacket = { coverUrl: string | null; coverIsbns: string[] };

/**
 * The art a Release row shows: its own stored cover, else its Edition's
 * jacket. Every Release of an Edition looks art up by the same ISBNs (the
 * jacket's), physical first, because the jacket is the same book's and an
 * ebook ISBN rarely has art upstream. Pass one `jacketCache` to every call
 * a query makes so each Edition's jacket is read once.
 */
export async function releaseCover(
  ctx: QueryCtx,
  release: Pick<Doc<"releases">, "editionId" | "coverImage">,
  cache: JacketCache = jacketCache(ctx),
): Promise<Jacket> {
  const [own, jacket] = await Promise.all([
    coverUrl(ctx, release.coverImage?.storageId),
    cache.jacket(release.editionId),
  ]);
  return { coverUrl: own ?? jacket.coverUrl, coverIsbns: jacket.coverIsbns };
}

/**
 * Per-query memo of Edition jackets, keyed by Edition. A jacket reads its
 * Edition's Releases once (active ones, date-sorted with undated last, as
 * the Edition page lists them): `coverUrl` is the first usable stored
 * cover, and `coverIsbns` their ISBNs, physical Releases first, each group
 * in date order, deduped, at most COVER_CANDIDATES. An Edition with no ISBN
 * at all borrows one: the same book is often on file twice, once from a
 * publisher's own site without an ISBN and once from the distribution
 * catalog with one. It takes the preferred ISBN (physical first) of the
 * first other Edition covering its first covered Volume that has one; a
 * hidden or merged Edition never lends. The Editions covering a Volume are
 * scanned once for all its borrowers. `coverage` loads an Edition's
 * Coverage in order and `edition` an Edition; a caller that already
 * memoizes them (`browseCache`) passes its own so the borrow shares those
 * reads.
 */
export function jacketCache(
  ctx: QueryCtx,
  coverage: (editionId: Id<"editions">) => Promise<Array<Doc<"volumeCoverages">>> = (editionId) =>
    ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .take(1),
  edition: (editionId: Id<"editions">) => Promise<Doc<"editions"> | null> = (editionId) =>
    ctx.db.get(editionId),
) {
  // Promises are memoized so concurrent callers share one in-flight read.
  const once = <K, V>(memo: Map<K, Promise<V>>, key: K, load: () => Promise<V>) => {
    let hit = memo.get(key);
    if (!hit) {
      hit = load();
      memo.set(key, hit);
    }
    return hit;
  };
  const releasesMemo = new Map<Id<"editions">, Promise<Array<Doc<"releases">>>>();
  const jacketMemo = new Map<Id<"editions">, Promise<Jacket>>();
  const coveringMemo = new Map<Id<"volumes">, Promise<Array<Doc<"volumeCoverages">>>>();
  const lendsMemo = new Map<Id<"editions">, Promise<boolean>>();
  const releases = (editionId: Id<"editions">) =>
    once(releasesMemo, editionId, async () =>
      (await releasesOf(ctx, editionId))
        .filter((r) => r.status === "active")
        .sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity)),
    );
  // Only an active Edition lends: a hidden or merged one is off the public
  // catalog, and so is its art (the rule favorites.ts and volumePage apply).
  const lends = (editionId: Id<"editions">) =>
    once(lendsMemo, editionId, async () => (await edition(editionId))?.status === "active");
  const covering = (volumeId: Id<"volumes">) =>
    once(coveringMemo, volumeId, () => coveringOf(ctx, volumeId));
  // The ISBN an ISBN-less Edition borrows from another Edition of its first Volume.
  const borrowed = async (editionId: Id<"editions">) => {
    const first = (await coverage(editionId))[0];
    if (!first) return null;
    for (const row of await covering(first.volumeId)) {
      if (row.editionId === editionId || !(await lends(row.editionId))) continue;
      const isbn = jacketIsbns(await releases(row.editionId))[0];
      if (isbn) return isbn;
    }
    return null;
  };
  return {
    /** The jacket of this Edition (see above). */
    jacket: (editionId: Id<"editions">) =>
      once(jacketMemo, editionId, async (): Promise<Jacket> => {
        const docs = await releases(editionId);
        let url: string | null = null;
        for (const release of docs) {
          url = await coverUrl(ctx, release.coverImage?.storageId);
          if (url) break;
        }
        const own = jacketIsbns(docs);
        if (own.length > 0) return { coverUrl: url, coverIsbns: own };
        const lent = await borrowed(editionId);
        return { coverUrl: url, coverIsbns: lent ? [lent] : [] };
      }),
  };
}
export type JacketCache = ReturnType<typeof jacketCache>;

// The ISBNs of an Edition's date-sorted Releases to look its jacket up by:
// physical first (the upstreams know print best), deduped, capped.
function jacketIsbns(releases: ReadonlyArray<Doc<"releases">>): string[] {
  const ordered = [
    ...releases.filter((r) => r.format === "physical"),
    ...releases.filter((r) => r.format !== "physical"),
  ].flatMap((r) => (r.isbn13 ? [r.isbn13] : []));
  return [...new Set(ordered)].slice(0, COVER_CANDIDATES);
}

/** What picking a Series' jacket needs to know about one of its Releases. */
export type SeriesCoverCandidate = Pick<Doc<"releases">, "isbn13" | "format" | "pubDate"> & {
  /** Its Edition is in an Edition Line (omnibus, deluxe…), not the standard run. */
  inLine: boolean;
  /** Position of the first Volume its Edition covers. */
  position: number;
};

/**
 * The ISBN-13s a Series' jacket is looked up by (library shelf, home shelf),
 * best first, at most COVER_CANDIDATES: physical before digital, published
 * before forthcoming (unannounced books have no art yet), then the earliest
 * Volume, the standard run before an Edition Line covering the same Volume,
 * and the earliest release — so a standard-edition Volume 1 in print when
 * one is on file, else the earliest book that is. Stored per Series
 * (`seriesStats.coverIsbns`) and tried in turn by its cards, so the order
 * favours the Releases the cover upstreams know best.
 *
 * `today` is today's yyyymmdd (lib/dates.ts `todaySortKey`), the line
 * between published and forthcoming. It has no default: a query that read
 * the clock here would have its cached result expire within seconds, so
 * queries take the day as an argument and only the rebuild reads a clock.
 */
export function seriesCoverIsbns(
  candidates: ReadonlyArray<SeriesCoverCandidate>,
  today: number,
): string[] {
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
  return [...new Set(ranked.map((c) => c.isbn13))].slice(0, COVER_CANDIDATES);
}

/**
 * The ISBNs a Series card built from its `seriesStats` row looks its jacket
 * up by, best first: the stored candidates, or the lone `coverIsbn` of a row
 * written before they were stored. Empty for a Series with no row yet.
 */
export function statsCoverIsbns(
  row: Pick<Doc<"seriesStats">, "coverIsbn" | "coverIsbns"> | null | undefined,
): string[] {
  if (!row) return [];
  return row.coverIsbns ?? (row.coverIsbn ? [row.coverIsbn] : []);
}

/**
 * A jacket for a whole Series from its first few Volumes: the first stored
 * cover, else the `seriesCoverIsbns` candidates ranked as of `today`
 * (yyyymmdd). Cheap enough for a home-page shelf.
 */
export async function seriesCover(
  ctx: QueryCtx,
  seriesId: Id<"series">,
  today: number,
): Promise<Jacket> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .take(3);
  const candidates: SeriesCoverCandidate[] = [];
  const seen = new Set<Id<"editions">>();
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    const covering = await coveringOf(ctx, volume._id);
    for (const row of covering) {
      if (seen.has(row.editionId)) continue;
      seen.add(row.editionId);
      const edition = await ctx.db.get(row.editionId);
      if (!edition || edition.status !== "active") continue;
      const releases = (await releasesOf(ctx, row.editionId)).filter((r) => r.status === "active");
      for (const release of releases) {
        const url = await coverUrl(ctx, release.coverImage?.storageId);
        if (url) return { coverUrl: url, coverIsbns: release.isbn13 ? [release.isbn13] : [] };
        candidates.push({
          ...release,
          inLine: edition.editionLineId !== undefined,
          position: volume.position,
        });
      }
    }
  }
  return { coverUrl: null, coverIsbns: seriesCoverIsbns(candidates, today) };
}
