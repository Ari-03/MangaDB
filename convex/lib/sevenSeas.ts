// Seven Seas parsing & normalization (ticket #34, spec §6/§7): pure
// functions from the source's wire formats to the normalized snapshot the
// import pipeline stores on Source Observations. Two formats feed one book:
//
// - The WP REST catalog, `GET /wp-json/wp/v2/books?per_page=100&page=N`
//   (verified live 2026-08-19, 6,461 records): identity (post id), slug,
//   canonical link, title, and `modified_gmt` — the cheap change signal.
//   The ACF fields (release date, ISBN, price…) are NOT exposed in REST.
// - The book page HTML (`link`), whose `#volume-meta` block carries
//   "Series:", "Story & Art by:", "Release Date:", "Price:", "Format:",
//   "ISBN:" lines plus the cover image.
//
// Keeping this module pure (no Convex imports beyond values) lets the
// parsers be unit-tested against saved fixture responses without a backend.

import { v, type Infer } from "convex/values";

// ---------- the normalized snapshot ----------

// What reconciliation reads (spec §6): the latest normalized form of one
// source record. `description` stays observation-only — marketing copy is
// never imported into canonical description fields in v1 (#13).
export const bookSnapshotValidator = v.object({
  kind: v.literal("book"),
  url: v.string(),
  title: v.string(),
  modifiedGmt: v.string(),
  seriesTitle: v.string(),
  seriesSlug: v.string(),
  seriesUrl: v.optional(v.string()),
  volumeLabel: v.optional(v.string()),
  creators: v.array(v.string()),
  /** Seven Seas' own category line ("Manga", "Light Novel", …). */
  category: v.optional(v.string()),
  binding: v.optional(v.string()),
  releaseDate: v.optional(
    v.object({ year: v.number(), month: v.number(), day: v.number() }),
  ),
  priceCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  isbn13: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
  description: v.optional(v.string()),
});

export type BookSnapshot = Infer<typeof bookSnapshotValidator>;

// ---------- small text plumbing ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities WordPress emits in titles and rendered HTML. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

/** Strip tags and collapse whitespace — for blurbs kept on the observation. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- WP REST listing ----------

export type BookListing = {
  /** The WP post id — the stable source-record-id half of observation identity. */
  sourceRecordId: string;
  slug: string;
  url: string;
  title: string;
  modifiedGmt: string;
  description?: string;
};

/**
 * One item of the `wp/v2/books` collection → listing identity, or null when
 * the item is malformed/unpublished. Tolerant by design: the registry is
 * data and the source is external — a bad item is skipped, never fatal.
 */
export function parseBookListing(raw: unknown): BookListing | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "number") return null;
  if (item.status !== undefined && item.status !== "publish") return null;
  const link = item.link;
  const slug = item.slug;
  if (typeof link !== "string" || typeof slug !== "string") return null;
  const title =
    typeof item.title === "object" && item.title !== null
      ? (item.title as Record<string, unknown>).rendered
      : undefined;
  if (typeof title !== "string" || title.trim() === "") return null;
  const modified = item.modified_gmt;
  const content =
    typeof item.content === "object" && item.content !== null
      ? (item.content as Record<string, unknown>).rendered
      : undefined;
  const description =
    typeof content === "string" && content.trim() !== ""
      ? stripHtml(content)
      : undefined;
  return {
    sourceRecordId: String(item.id),
    slug,
    url: link,
    title: decodeEntities(title).trim(),
    modifiedGmt: typeof modified === "string" ? modified : "",
    description,
  };
}

// ---------- book page HTML ----------

export type BookPageDetails = {
  seriesTitle?: string;
  seriesSlug?: string;
  seriesUrl?: string;
  creators: string[];
  releaseDate?: { year: number; month: number; day: number };
  priceCents?: number;
  currency?: string;
  category?: string;
  isbn13?: string;
  coverUrl?: string;
};

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** "April 13, 2027" → a full-precision date, or undefined. */
export function parseUsDate(
  text: string,
): { year: number; month: number; day: number } | undefined {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!m) return undefined;
  const month = MONTHS[m[1]!.toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

/** A `<b>Label:</b> value` line out of the volume-meta block. */
function metaLine(html: string, label: string): string | undefined {
  const re = new RegExp(`<b>\\s*${label}\\s*:\\s*</b>\\s*([^<]+)`, "i");
  const m = re.exec(html);
  const value = m ? decodeEntities(m[1]!).trim() : "";
  return value === "" ? undefined : value;
}

/**
 * Extract the volume-meta facts from a Seven Seas book page. Verified
 * against the live page shape on 2026-08-19; every field is optional so a
 * partial page yields a partial (but usable) snapshot.
 */
export function parseBookPage(html: string): BookPageDetails {
  const details: BookPageDetails = { creators: [] };

  const series =
    /<b>\s*Series:\s*<\/b>.*?<a\s+href="([^"]*\/series\/([^/"]+)\/?)"[^>]*>(.*?)<\/a>/is.exec(
      html,
    );
  if (series) {
    details.seriesUrl = series[1];
    details.seriesSlug = series[2]!;
    details.seriesTitle = stripHtml(series[3]!);
  }

  for (const m of html.matchAll(
    /<span class="creator"><a[^>]*>(.*?)<\/a><\/span>/gis,
  )) {
    const name = stripHtml(m[1]!);
    if (name !== "") details.creators.push(name);
  }

  const dateText = metaLine(html, "Release Date");
  if (dateText) details.releaseDate = parseUsDate(dateText);

  const priceText = metaLine(html, "Price");
  if (priceText) {
    const m = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(priceText);
    if (m) {
      details.priceCents = Math.round(Number(m[1]) * 100);
      details.currency = "USD";
    }
  }

  details.category = metaLine(html, "Format");

  const isbnText = metaLine(html, "ISBN");
  if (isbnText) {
    const digits = isbnText.replace(/[^0-9Xx]/g, "");
    if (/^\d{13}$/.test(digits)) details.isbn13 = digits;
  }

  // The cover is the last uploads image before the volume-meta block.
  const metaIdx = html.indexOf('id="volume-meta"');
  const head = metaIdx >= 0 ? html.slice(0, metaIdx) : html;
  let coverUrl: string | undefined;
  for (const m of head.matchAll(
    /<img[^>]+src="([^"]*\/wp-content\/uploads\/[^"]+)"/gi,
  )) {
    coverUrl = m[1]!;
  }
  details.coverUrl = coverUrl;

  return details;
}

// ---------- title & scope rules ----------

/**
 * Split a Seven Seas book title into its series part and volume label:
 * "Betrothed to My Sister's Ex (Manga) Vol. 6" → series title with the
 * publisher's own "(Manga)" discriminator kept verbatim (imports record the
 * source's facts; curation may retitle), label "6". A title without a
 * volume marker (a oneshot) yields no label.
 */
export function splitBookTitle(title: string): {
  seriesTitle: string;
  volumeLabel?: string;
} {
  const m = /^(.*?)\s+Vols?\.?\s+([0-9]+(?:\.[0-9]+)?(?:\s*[-–]\s*[0-9]+(?:\.[0-9]+)?)?)\s*$/i.exec(
    title,
  );
  if (!m) return { seriesTitle: title.trim() };
  return {
    seriesTitle: m[1]!.trim(),
    volumeLabel: m[2]!.replace(/\s*[-–]\s*/, "–"),
  };
}

// MangaDB's catalog is manga (spec §1); Seven Seas also publishes prose
// novels and audiobooks. The page's own Format line decides; the title's
// parenthesized discriminator is the fallback when the line is missing.
const NON_MANGA = /light novel|audiobook|audio book|^novel$|prose/i;

export function isMangaBook(args: {
  category?: string;
  title: string;
}): boolean {
  if (args.category !== undefined) return !NON_MANGA.test(args.category);
  const disc = /\(([^)]+)\)\s*(?:Vols?\.?\s|$)/i.exec(args.title);
  return disc ? !NON_MANGA.test(disc[1]!) : true;
}

/**
 * Merge listing + page into the normalized snapshot stored on the
 * observation. Binding: Seven Seas' standard print books are paperbacks;
 * hardcover editions say so in the title or category.
 */
export function normalizeBook(
  listing: BookListing,
  page: BookPageDetails,
): BookSnapshot {
  const split = splitBookTitle(listing.title);
  const seriesTitle = page.seriesTitle ?? split.seriesTitle;
  const hardcover = /hardcover/i.test(`${listing.title} ${page.category ?? ""}`);
  return {
    kind: "book",
    url: listing.url,
    title: listing.title,
    modifiedGmt: listing.modifiedGmt,
    seriesTitle,
    seriesSlug: page.seriesSlug ?? listing.slug,
    seriesUrl: page.seriesUrl,
    volumeLabel: split.volumeLabel,
    creators: page.creators,
    category: page.category,
    binding: hardcover ? "hardcover" : "paperback",
    releaseDate: page.releaseDate,
    priceCents: page.priceCents,
    currency: page.currency,
    isbn13: page.isbn13,
    coverUrl: page.coverUrl,
    description: listing.description,
  };
}
