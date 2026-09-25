// Kodansha parsing & normalization (ticket #36, spec §6/§7): pure functions
// from kodansha.us to the normalized snapshots the import pipeline stores on
// Source Observations. Two feeds share them:
//
// The daily window (JSON, verified live 2026-08-20):
// - `GET /wp-json/kodansha/v1/release-calendar` — weekly buckets keyed by
//   Tuesday (`tue_key: "2026-08-04"`), one past + ~7 future weeks; each item
//   carries the volume title, series name, creators, cover, volume URL, and
//   `formats: ["digital","print"]`. The bucket date is the release date.
// - `GET /wp-json/kodansha/v1/new-releases` — this week's releases with an
//   ISO `release_date`, `series_slug`, per-format flags, and `series_type`
//   ("comic" = manga; novels are out of catalog scope).
// Neither exposes ISBNs or prices.
//
// The backlist crawl (verified live 2026-09-25; robots.txt allows both):
// - `GET /wp-json/kodansha/v1/search-series?offset=N&count=100` — every
//   series (~1,170: ~860 comic, ~310 novel), alphabetical, with its `type`
//   and a `last_updated_at` stamp. `count` tops out at 100.
// - `GET /series/{slug}/` — the series page: JSON-LD `ComicSeries.hasPart`
//   lists the volume pages (packaging pages omit it, so the page's own
//   volume links count too).
// - `GET /series/{slug}/{volume}/` — the volume page: a JSON-LD `Book` whose
//   `workExample` has one entry per format (EBook / Paperback / Hardcover)
//   with its ISBN, `datePublished`, and USD list price.
//
// One volume yields one snapshot PER FORMAT: print and digital are distinct
// Releases of one Edition (spec §2), so each gets its own observation
// identity (`{series}/{volume}#{format}`), shared by both feeds.
//
// Scope (spec §1): Kodansha USA also sells novels, children's picture books
// ("Cells at Work! Picture Book"), and other non-manga. Such a volume keeps
// its snapshot with `outOfScope` set — observed, never placed.

import { v, type Infer } from "convex/values";
import {
  canonicalLabel,
  isNovelTitle,
  outOfScopeReason,
  packagingValidator,
  parseBookTitle,
  type Packaging,
} from "./bookTitle";
import { toIsbn13 } from "./openLibrary";

// ---------- the normalized snapshot ----------

// Kodansha publishes its packaging lines as series pages of their own
// ("Blue Lock Omnibus", "Gachiakuta Dumpster Manga Box Set", "MARS 30th
// Anniversary Edition"). The snapshot's seriesTitle is always the BASE
// series (lib/bookTitle.ts); such a line's "Volume N" is its Edition Line
// Position, carried in `packaging`, never a Volume label.
export const kodanshaSnapshotValidator = v.object({
  kind: v.literal("kodanshaVolume"),
  url: v.string(),
  title: v.string(),
  seriesTitle: v.string(),
  seriesSlug: v.string(),
  seriesUrl: v.string(),
  volumeLabel: v.optional(v.string()),
  /** The Edition Line shape when Kodansha's series page is a packaging line. */
  packaging: v.optional(packagingValidator),
  format: v.union(v.literal("physical"), v.literal("digital")),
  creators: v.array(v.string()),
  releaseDate: v.optional(
    v.object({ year: v.number(), month: v.number(), day: v.number() }),
  ),
  coverUrl: v.optional(v.string()),
  // Volume pages only (the backlist crawl): this format's ISBN-13, binding,
  // and USD list price. The calendar never carries them.
  isbn13: v.optional(v.string()),
  binding: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  /** Why the volume is outside the manga catalog (bookTitle ScopeReason); absent = in scope. */
  outOfScope: v.optional(v.string()),
});

export type KodanshaSnapshot = Infer<typeof kodanshaSnapshotValidator>;

type Ymd = { year: number; month: number; day: number };

/** One catalog item before the per-format split. */
export type KodanshaItem = {
  /** Kodansha's own series name, verbatim. */
  seriesName: string;
  /** The base series (packaging stripped). */
  seriesTitle: string;
  seriesSlug: string;
  volumeSlug: string;
  url: string;
  volumeLabel?: string;
  packaging?: Packaging;
  creators: string[];
  formats: Array<"physical" | "digital">;
  releaseDate?: Ymd;
  coverUrl?: string;
  /** Out of catalog scope: observed only, never placed. */
  outOfScope?: string;
};

// ---------- small parsers ----------

/** "https://kodansha.us/series/{seriesSlug}/{volumeSlug}/" → its two slugs. */
export function parseVolumeUrl(
  url: string,
): { seriesSlug: string; volumeSlug: string } | null {
  const m = /\/series\/([^/]+)\/([^/]+)\/?$/.exec(url);
  if (!m) return null;
  return { seriesSlug: m[1]!, volumeSlug: m[2]! };
}

/**
 * "Volume 21" (incl. the API's non-breaking space) → "21"; failing that, the
 * volume slug ("volume-3" → "3"); else no label. `volume-0` is Kodansha's
 * slug for an unnumbered oneshot ("Mermaid Prince"), so it never labels.
 */
export function parseVolumeLabel(title: string, volumeSlug = ""): string | undefined {
  const m =
    /volume\s+([0-9]+(?:\.[0-9]+)?)\s*$/i.exec(title.replace(/ /g, " ")) ??
    /^volume-([1-9][0-9]*)$/i.exec(volumeSlug);
  return m ? canonicalLabel(m[1]!) : undefined;
}

/** "By Osamu Nishi, Masashi Asaki" → the creator names. */
export function parseCreators(byline: unknown): string[] {
  if (typeof byline !== "string") return [];
  return byline
    .replace(/^by\s+/i, "")
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** "2026-08-04" or "2026-08-18T04:00:00+00:00" → a full-precision date. */
export function parseIsoDate(text: unknown): Ymd | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

// Packaging lines only Kodansha names this way; everything else is the
// shared parser's (lib/bookTitle.ts). "Ajin: Demi-Human Complete" and
// "The Flowers of Evil - Complete" are omnibus reissues of the base series.
const KODANSHA_LINE =
  /^(.+?)\s+(?:[-–—]\s+)?(Complete|Full Color Collection|Paperback Collection|Complete Color Edition)$/i;

/**
 * A Kodansha series name → the base Series title and, for a packaging
 * line, its Edition Line shape. A number in a series NAME belongs to the
 * name ("Beast #6"), never a Volume; "(Print)" marks the print run of a
 * webtoon, not a separate Series.
 */
export function parseSeriesName(raw: string): {
  seriesTitle: string;
  packaging: Packaging | null;
  isNovel: boolean;
} {
  const name = raw
    .replace(/[\s ]+/g, " ")
    .replace(/\s*\(print\)$/i, "")
    .trim();
  const parsed = parseBookTitle(name);
  if (parsed.isNovel || parsed.packaging) {
    return {
      seriesTitle: parsed.seriesTitle,
      packaging: parsed.packaging,
      isNovel: parsed.isNovel,
    };
  }
  const line = KODANSHA_LINE.exec(name);
  if (line) {
    return {
      seriesTitle: parseBookTitle(line[1]!).seriesTitle,
      packaging: { lineName: line[2]!, linePosition: null, coverRange: null },
      isNovel: false,
    };
  }
  return {
    seriesTitle: parsed.volumeLabel !== null ? name : parsed.seriesTitle,
    packaging: null,
    isNovel: false,
  };
}

// ---------- the two window endpoints ----------

function itemFrom(args: {
  seriesTitle: unknown;
  volumeTitle: unknown;
  url: unknown;
  creators: string[];
  formats: Array<"physical" | "digital">;
  releaseDate?: Ymd;
  coverUrl: unknown;
  /** A scope verdict the feed itself gives (new-releases' `series_type`). */
  outOfScope?: string;
}): KodanshaItem | null {
  if (typeof args.seriesTitle !== "string" || args.seriesTitle.trim() === "") {
    return null;
  }
  if (typeof args.url !== "string") return null;
  const slugs = parseVolumeUrl(args.url);
  if (!slugs) return null;
  if (args.formats.length === 0) return null;
  const volumeTitle =
    typeof args.volumeTitle === "string"
      ? args.volumeTitle.replace(/ /g, " ").trim()
      : "";
  const seriesName = args.seriesTitle.trim();
  const series = parseSeriesName(seriesName);
  // Novels, picture books, and other non-manga are out of catalog scope
  // (spec §1); the calendar carries no type, so the names decide.
  const outOfScope =
    args.outOfScope ??
    (series.isNovel ? "novel" : undefined) ??
    outOfScopeReason(seriesName) ??
    outOfScopeReason(volumeTitle) ??
    undefined;
  const label = parseVolumeLabel(volumeTitle, slugs.volumeSlug);
  return {
    seriesName,
    seriesTitle: series.seriesTitle,
    seriesSlug: slugs.seriesSlug,
    volumeSlug: slugs.volumeSlug,
    url: args.url,
    ...(series.packaging
      ? { packaging: { ...series.packaging, linePosition: label ?? null } }
      : { volumeLabel: label }),
    creators: args.creators,
    formats: args.formats,
    releaseDate: args.releaseDate,
    coverUrl: typeof args.coverUrl === "string" ? args.coverUrl : undefined,
    ...(outOfScope !== undefined ? { outOfScope } : {}),
  };
}

function parseFormats(raw: unknown): Array<"physical" | "digital"> {
  if (!Array.isArray(raw)) return [];
  const formats: Array<"physical" | "digital"> = [];
  if (raw.includes("print")) formats.push("physical");
  if (raw.includes("digital")) formats.push("digital");
  return formats;
}

/**
 * The release-calendar payload → items, tolerant of malformed entries (a bad
 * item is skipped, never fatal). Each weekly bucket's `tue_key` is the
 * release date of every item in it.
 */
export function parseCalendar(raw: unknown): KodanshaItem[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: KodanshaItem[] = [];
  for (const bucket of data) {
    if (typeof bucket !== "object" || bucket === null) continue;
    const b = bucket as Record<string, unknown>;
    const releaseDate = parseIsoDate(b.tue_key);
    if (!Array.isArray(b.items)) continue;
    for (const entry of b.items) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const item = itemFrom({
        seriesTitle: e.series_name,
        volumeTitle: e.title,
        url: e.volume_url,
        creators: parseCreators(e.creators),
        formats: parseFormats(e.formats),
        releaseDate,
        coverUrl: e.image,
      });
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * The new-releases payload → items. `series_type` scopes to manga
 * ("comic"); other types (novels) are kept out of catalog scope (spec §1).
 * Formats come from the per-format flags: `has_print` and `is_purchasable`
 * (the digital storefront flag).
 */
export function parseNewReleases(raw: unknown): KodanshaItem[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: KodanshaItem[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const formats: Array<"physical" | "digital"> = [];
    if (e.has_print === true) formats.push("physical");
    if (e.is_purchasable === true) formats.push("digital");
    const item = itemFrom({
      seriesTitle: e.series_name,
      volumeTitle: e.volume_title,
      url: e.volume_url,
      creators: parseCreators(e.creators),
      formats,
      releaseDate: parseIsoDate(e.release_date),
      coverUrl: e.image,
      outOfScope:
        typeof e.series_type === "string" && e.series_type !== "comic"
          ? e.series_type
          : undefined,
    });
    if (item) items.push(item);
  }
  return items;
}

// ---------- per-format snapshots ----------

/** Observation identity: one per (volume URL path, format). */
export function sourceRecordId(
  item: Pick<KodanshaItem, "seriesSlug" | "volumeSlug">,
  format: "physical" | "digital",
): string {
  return `${item.seriesSlug}/${item.volumeSlug}#${format}`;
}

/** One format of an item as a snapshot; `title` defaults to "{series} Volume N". */
function snapshotFor(
  item: KodanshaItem,
  format: "physical" | "digital",
  title?: string,
): KodanshaSnapshot {
  const position = item.volumeLabel ?? item.packaging?.linePosition ?? null;
  return {
    kind: "kodanshaVolume" as const,
    url: item.url,
    title:
      title ??
      `${item.seriesName} ${position !== null ? `Volume ${position}` : item.volumeSlug}`,
    seriesTitle: item.seriesTitle,
    seriesSlug: item.seriesSlug,
    seriesUrl: `https://kodansha.us/series/${item.seriesSlug}/`,
    volumeLabel: item.volumeLabel,
    packaging: item.packaging,
    format,
    creators: item.creators,
    releaseDate: item.releaseDate,
    coverUrl: item.coverUrl,
    outOfScope: item.outOfScope,
  };
}

/** Split one catalog item into its per-format normalized snapshots. */
export function toSnapshots(item: KodanshaItem): KodanshaSnapshot[] {
  return item.formats.map((format) => snapshotFor(item, format));
}

// ---------- the backlist: series listing ----------

export type SeriesListingEntry = {
  slug: string;
  name: string;
  /** Kodansha's `last_updated_at` stamp — the crawl's change signal. */
  lastUpdatedAt: string;
};

/** Series per search-series request; the endpoint caps `count` at 100. */
export const LISTING_PAGE_SIZE = 100;

/**
 * One search-series page → its in-scope entries (comics whose name is not
 * a novel's) plus the raw page length and total, for paging.
 */
export function parseSeriesListing(raw: unknown): {
  entries: SeriesListingEntry[];
  pageLength: number;
  total: number | undefined;
} {
  const body = (raw ?? {}) as { data?: unknown; total_count?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  const entries: SeriesListingEntry[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "comic") continue;
    if (typeof r.slug !== "string" || !/^[a-z0-9-]+$/.test(r.slug)) continue;
    if (typeof r.name !== "string" || r.name.trim() === "") continue;
    if (isNovelTitle(r.name)) continue;
    entries.push({
      slug: r.slug,
      name: r.name.trim(),
      lastUpdatedAt: typeof r.last_updated_at === "string" ? r.last_updated_at : "",
    });
  }
  return {
    entries,
    pageLength: data.length,
    total: typeof body.total_count === "number" ? body.total_count : undefined,
  };
}

// ---------- the backlist: series and volume pages ----------

/** Every JSON-LD object on a page (`@graph`s flattened); bad blocks skipped. */
export function jsonLdObjects(html: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) add(obj["@graph"]);
      else objects.push(obj);
    }
  };
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      add(JSON.parse(m[1]!));
    } catch {
      // A malformed block never hides the others.
    }
  }
  return objects;
}

/** Volume-page slugs in reading order: volume-N by number, then the rest. */
function volumeOrder(a: string, b: string): number {
  const na = /^volume-(\d+)$/.exec(a)?.[1];
  const nb = /^volume-(\d+)$/.exec(b)?.[1];
  if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
  if (na !== undefined) return -1;
  if (nb !== undefined) return 1;
  return a.localeCompare(b);
}

/**
 * A series page → its volume-page slugs: the JSON-LD `hasPart` list plus
 * the page's own links under `/series/{slug}/` (packaging pages have no
 * `hasPart`). Links to other series are ignored.
 */
export function parseSeriesPage(html: string, seriesSlug: string): string[] {
  const slugs = new Set<string>();
  const own = (url: unknown) => {
    if (typeof url !== "string") return;
    const parts = parseVolumeUrl(url.replace(/[?#].*$/, ""));
    if (parts && parts.seriesSlug === seriesSlug) slugs.add(parts.volumeSlug);
  };
  for (const obj of jsonLdObjects(html)) {
    if (obj["@type"] !== "ComicSeries" || !Array.isArray(obj.hasPart)) continue;
    for (const part of obj.hasPart) own((part as { url?: unknown } | null)?.url);
  }
  for (const m of html.matchAll(/href="((?:https:\/\/kodansha\.us)?\/series\/[^"]+)"/g)) {
    own(m[1]);
  }
  return [...slugs].sort(volumeOrder);
}

/** One format of a volume page: its own ISBN, date, and list price. */
export type VolumeOffer = {
  format: "physical" | "digital";
  binding?: string;
  isbn13: string;
  releaseDate?: Ymd;
  priceCents?: number;
};

export type KodanshaVolumePage = {
  item: KodanshaItem;
  /** The page's own book title ("Blue Lock Volume 1"). */
  title: string;
  offers: VolumeOffer[];
};

function formatOf(
  bookFormat: unknown,
): { format: "physical" | "digital"; binding?: string } | null {
  const kind = typeof bookFormat === "string" ? bookFormat.split("/").pop() : "";
  if (kind === "EBook") return { format: "digital" };
  if (kind === "Paperback") return { format: "physical", binding: "paperback" };
  if (kind === "Hardcover") return { format: "physical", binding: "hardcover" };
  if (kind === "GraphicNovel") return { format: "physical" };
  return null;
}

function namesOf(author: unknown): string[] {
  const list = Array.isArray(author) ? author : [author];
  return list
    .map((a) => (a as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
}

/**
 * A volume page → its book and one offer per format with a valid ISBN, or
 * null when the page has no JSON-LD Book or no ISBN'd format. An
 * out-of-scope book (novel, picture book, merchandise) parses with
 * `item.outOfScope` set, so it is observed but never placed.
 */
export function parseVolumePage(html: string, pageUrl: string): KodanshaVolumePage | null {
  const book = jsonLdObjects(html).find(
    (obj) => obj["@type"] === "Book" && obj.workExample !== undefined,
  );
  if (!book || typeof book.name !== "string") return null;
  const title = book.name.replace(/[\s ]+/g, " ").trim();
  if (title === "") return null;

  const examples = Array.isArray(book.workExample) ? book.workExample : [book.workExample];
  const offers: VolumeOffer[] = [];
  const isbns = new Set<string>();
  for (const example of examples) {
    if (typeof example !== "object" || example === null) continue;
    const e = example as Record<string, unknown>;
    const format = formatOf(e.bookFormat);
    const isbn13 = toIsbn13(typeof e.isbn === "string" ? e.isbn : undefined);
    if (!format || isbn13 === undefined || isbns.has(isbn13)) continue;
    isbns.add(isbn13);
    const offer = (e.offers ?? {}) as { price?: unknown; priceCurrency?: unknown };
    const price = typeof offer.price === "number" ? offer.price : Number(offer.price);
    offers.push({
      ...format,
      isbn13,
      releaseDate: parseIsoDate(e.datePublished),
      priceCents:
        offer.priceCurrency === "USD" && Number.isFinite(price) && price > 0
          ? Math.round(price * 100)
          : undefined,
    });
  }

  const url = typeof book.url === "string" ? book.url : pageUrl;
  const item = itemFrom({
    seriesTitle: (book.isPartOf as { name?: unknown } | undefined)?.name,
    volumeTitle: title,
    url,
    creators: namesOf(book.author),
    formats: [...new Set(offers.map((o) => o.format))],
    coverUrl: book.image,
  });
  return item ? { item, title, offers } : null;
}

/**
 * A parsed volume page → one (record id, snapshot) per format. A second
 * ISBN of the same format (a paperback and a hardcover) is a Release of its
 * own, keyed by its ISBN.
 */
export function toBacklistSnapshots(
  page: KodanshaVolumePage,
): Array<{ sourceRecordId: string; snapshot: KodanshaSnapshot }> {
  const taken = new Set<string>();
  return page.offers.map((offer) => {
    const base = sourceRecordId(page.item, offer.format);
    const id = taken.has(base) ? `${base}:${offer.isbn13}` : base;
    taken.add(base);
    return {
      sourceRecordId: id,
      snapshot: {
        ...snapshotFor(page.item, offer.format, page.title),
        releaseDate: offer.releaseDate,
        isbn13: offer.isbn13,
        binding: offer.binding,
        priceCents: offer.priceCents,
      },
    };
  });
}

// ---------- the backlist: per-series crawl state ----------

const DAY_MS = 24 * 60 * 60 * 1000;
/** A series with moving dates is re-checked at most this often (weekly runs). */
export const RECHECK_MS = 6 * DAY_MS;
/** Every series is re-crawled whole after this long. */
export const FULL_REFRESH_MS = 180 * DAY_MS;
/** A date this recent (or later) may still move. */
const RECENT_MS = 60 * DAY_MS;

/**
 * What the crawler remembers per series (its own observation, keyed by the
 * series slug): the listing stamp it crawled under, the volume pages it saw,
 * and the pages worth re-fetching on the next weekly check. The observation's
 * lastSeenAt is the crawl time.
 */
export const seriesCrawlValidator = v.object({
  kind: v.literal("kodanshaSeriesCrawl"),
  name: v.string(),
  url: v.string(),
  lastUpdatedAt: v.string(),
  volumes: v.array(v.string()),
  /** Upcoming, recent, or undated volumes, and pages whose fetch failed. */
  recheck: v.array(v.string()),
});

export type SeriesCrawl = Infer<typeof seriesCrawlValidator>;

export type CrawlMode = "full" | "recheck";

/**
 * Is this series due, and how much of it? Never crawled, a changed listing
 * stamp (rare: ~20 series a month), or a crawl older than FULL_REFRESH_MS →
 * every volume page; volumes still worth re-checking a week on → only those
 * and any new ones; else not due.
 */
export function crawlMode(
  entry: Pick<SeriesListingEntry, "lastUpdatedAt">,
  state: { snapshot: SeriesCrawl; crawledAt: number } | null,
  now: number,
): CrawlMode | null {
  if (state === null) return "full";
  const age = now - state.crawledAt;
  if (age > FULL_REFRESH_MS || state.snapshot.lastUpdatedAt !== entry.lastUpdatedAt) {
    return "full";
  }
  if (state.snapshot.recheck.length > 0 && age > RECHECK_MS) return "recheck";
  return null;
}

/** The volume pages a crawl of this mode fetches. */
export function volumesToFetch(
  mode: CrawlMode,
  state: SeriesCrawl | null,
  current: string[],
): string[] {
  if (mode === "full" || state === null) return current;
  const known = new Set(state.volumes);
  const recheck = new Set(state.recheck);
  return current.filter((slug) => !known.has(slug) || recheck.has(slug));
}

/** Could this page's facts still move? Upcoming, recent, or undated formats. */
export function needsRecheck(offers: VolumeOffer[], now: number): boolean {
  if (offers.length === 0) return true;
  return offers.some(
    (o) =>
      o.releaseDate === undefined ||
      Date.UTC(o.releaseDate.year, o.releaseDate.month - 1, o.releaseDate.day) >=
        now - RECENT_MS,
  );
}
