// Yen Press parsing (spec §6 post-v1 candidate, now built): pure functions
// from yenpress.com's public sitemap and title pages to normalized
// snapshots. Both verified live 2026-09-25; robots.txt disallows only
// /admin.
//
// - `GET /sitemap.xml` — one flat urlset listing every title page as
//   `/titles/{isbn13}-{slug}` (~15.7k URLs: the print and the digital ISBN
//   of one book often share a page, but some expose only one format), plus
//   series/news/genre pages the adapter ignores. No lastmod.
// - `GET /titles/{isbn13}-{slug}` — the book page: an `<h1>` title, one
//   format tab per edition ("Paperback", "Hardback", "Digital"), a price
//   block per tab, and a "full details" block per tab in the same order
//   (Series, Page Count, ISBN, Release Date, Imprint), plus the category
//   of its genre labels (manga, comics, light-novels, audio-books).
//
// Scope (spec §1): Yen On (light novels) and Yen Audio never enter;
// JY manga is allowed. Neither do the light-novel/audio
// categories (which is how J-Novel Club's novels, distributed by Yen, stay
// out while its print manga comes in), single digital chapters
// ("…, Chapter 22 (v-scroll)"), or Yen's western "comics" — except Ize
// Press, whose manhwa Yen files under comics. Everything fetched is
// still observed (the fetch state that keeps the adapter incremental); an
// out-of-scope snapshot carries its reason and is never placed.

import { v, type Infer } from "convex/values";
import { outOfScopeReason, parseBookTitle, type ParsedBookTitle } from "./bookTitle";
import { catalogTitleFields } from "./catalogTitle";
import { toIsbn13 } from "./openLibrary";
import { cleanTitleText, stripHtml } from "./text";

export const yenTitleValidator = v.object({
  kind: v.literal("yenTitle"),
  ...catalogTitleFields,
  /** Yen's own series name ("… (manga)"), verbatim. */
  seriesName: v.optional(v.string()),
  /** The page's genre category: manga, comics, light-novels, … */
  category: v.optional(v.string()),
  /** Why the book is out of catalog scope; absent = in scope. */
  outOfScope: v.optional(v.string()),
});

export type YenTitleSnapshot = Infer<typeof yenTitleValidator>;

// ---------- the sitemap ----------

export type YenTitleUrl = { url: string; isbn13: string; slug: string };

// English-market ISBN groups; Yen's sitemap also lists Korean (978-89)
// originals of Ize Press books.
const ENGLISH_ISBN = /^(?:9780|9781|9798)/;

/** The sitemap → its English-market title pages (other URLs ignored). */
export function parseSitemap(xml: string): YenTitleUrl[] {
  const titles: YenTitleUrl[] = [];
  for (const m of xml.matchAll(
    /<loc>\s*(https:\/\/yenpress\.com\/titles\/(\d{13})-([^<\s]+))\s*<\/loc>/g,
  )) {
    const isbn13 = toIsbn13(m[2]!);
    if (isbn13 === undefined || !ENGLISH_ISBN.test(isbn13)) continue;
    titles.push({ url: m[1]!, isbn13, slug: m[3]! });
  }
  return titles;
}

/**
 * A slug that names prose, audio, or a single digital chapter outright
 * ("…-volume-2-light-novel", "…-audio", "toilet-bound-hanako-kun-chapter-134")
 * — skipped without a fetch. Anything else is fetched and scoped on the
 * page itself.
 */
export function skipsWithoutFetch(slug: string): boolean {
  if (/(?:^|-)(?:light-novel|novel|audio|audiobook|v-scroll)(?:-|$)/.test(slug)) return true;
  return /-chapter-\d+(?:-manga)?$/.test(slug) && !/-vol(?:ume)?-\d/.test(slug);
}

// ---------- the title page ----------

export type YenFormat = {
  /** The format tab's label ("Paperback", "Hardback", "Digital"). */
  tab: string;
  isbn13?: string;
  onsale?: { year: number; month: number; day: number };
  priceCents?: number;
  imprint?: string;
  seriesName?: string;
};

export type YenTitlePage = {
  title: string;
  category?: string;
  formats: YenFormat[];
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** "Jan 26, 2027" → a full date; anything vaguer → undefined. */
export function parseYenDate(
  text: string,
): { year: number; month: number; day: number } | undefined {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS[m[1]!.toLowerCase()];
  const day = Number(m[2]);
  if (month === undefined || day < 1 || day > 31) return undefined;
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return { year, month, day };
}

/** One "full details" block's labelled fields ("ISBN" → "979…"). */
function detailFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of block.matchAll(/<span[^>]*>([^<]*)<\/span>\s*<p class="info">([\s\S]*?)<\/p>/g)) {
    const label = m[1]!.trim();
    if (label !== "" && fields[label] === undefined)
      fields[label] = cleanTitleText(stripHtml(m[2]!));
  }
  return fields;
}

/**
 * One title page → its title, category, and per-format facts, or null when
 * the page is not a book page (no `<h1>` or no details). Format tabs,
 * price blocks, and detail blocks line up by position.
 */
export function parseTitlePage(html: string): YenTitlePage | null {
  const h1 = /<h1 class="heading[^"]*desktop-only[^"]*"[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
  const title = h1 !== undefined ? cleanTitleText(stripHtml(h1)) : "";
  if (title === "") return null;

  const tabs = [...html.matchAll(/<span class="deliver[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) =>
    m[1]!.trim(),
  );
  const prices = [...html.matchAll(/<p class="book-price">([^<]*)<\/p>/g)].map((m) => {
    const usd = /\$\s*(\d+(?:\.\d{1,2})?)\s*US/.exec(m[1]!)?.[1];
    return usd !== undefined ? Math.round(Number(usd) * 100) : undefined;
  });
  const blocks = html.split('<div class="detail-info').slice(1);
  if (blocks.length === 0) return null;

  const labels = /<div class="detail-labels[^"]*">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const category = /category=([a-z-]+)/.exec(labels)?.[1];

  const formats = blocks.map((block, i): YenFormat => {
    const fields = detailFields(block);
    return {
      tab: tabs[i] ?? (i === 0 ? "Paperback" : "Digital"),
      isbn13: toIsbn13(fields.ISBN),
      onsale:
        fields["Release Date"] !== undefined ? parseYenDate(fields["Release Date"]) : undefined,
      priceCents: prices[i],
      imprint: fields.Imprint,
      seriesName: fields.Series,
    };
  });
  return { title, category, formats };
}

// ---------- snapshots ----------

// Prose/audio imprints. J-Novel Club is not here: Yen distributes its
// print manga too, and the page category tells them from its novels.
const DENIED_IMPRINTS = /^(?:yen on|yen audio)$/i;

// Yen titles append a volume subtitle after the designator: "A Misanthrope
// Teaches a Class for Demi-Humans, Vol. 4 (manga): Mr. Hitoma, …". The
// subtitle names the volume, not the Series, so it is cut before parsing.
const VOLUME_THEN_SUBTITLE =
  /^(.*?\bVol(?:ume)?\.?\s*\d+(?:\.\d+)?(?:\s*\([^()]*\))?)\s*:\s+\S[\s\S]*$/i;

function formatOf(tab: string): { format: "physical" | "digital"; binding?: string } | null {
  if (/digital|e-?book/i.test(tab)) return { format: "digital" };
  if (/hard(?:back|cover)/i.test(tab)) return { format: "physical", binding: "hardcover" };
  if (/paperback/i.test(tab)) return { format: "physical", binding: "paperback" };
  return null;
}

/** Why a page's book is out of catalog scope, or null when it is manga. */
function scopeReason(
  page: YenTitlePage,
  imprint: string | undefined,
  parsed: ParsedBookTitle,
): string | null {
  if (imprint !== undefined && DENIED_IMPRINTS.test(imprint)) return `imprint ${imprint}`;
  // Single digital chapters ("…, Chapter 22 (v-scroll)") are never
  // Volumes; an arc name with a volume ("Re:ZERO, Chapter 5: …, Vol. 2") is.
  if (
    /\(v-scroll\)/i.test(page.title) ||
    (/\bChapter\s+\d+/i.test(page.title) &&
      parsed.volumeLabel === null &&
      parsed.packaging === null)
  ) {
    return "single chapter";
  }
  const category = page.category;
  if (/^jy$/i.test(imprint ?? "") && category !== "manga") return "JY non-manga";
  if (category === "light-novels" || category === "audio-books") return `category ${category}`;
  if (category === "comics" && !/^ize press$/i.test(imprint ?? "")) return "western comics";
  return outOfScopeReason(page.title);
}

/**
 * A parsed page → one snapshot per format with a usable ISBN. Every
 * snapshot is kept (it is the adapter's fetch state); out-of-scope ones
 * carry `outOfScope` and are never placed.
 */
export function toSnapshots(page: YenTitlePage, url: string): YenTitleSnapshot[] {
  const cut = VOLUME_THEN_SUBTITLE.exec(page.title)?.[1] ?? page.title;
  const parsed = parseBookTitle(cut);
  const boxed = parsed.isBox || /\bbox(?:ed)? set\b/i.test(page.title);
  const coverRange = parsed.packaging?.coverRange ?? null;
  const snapshots: YenTitleSnapshot[] = [];
  for (const entry of page.formats) {
    if (entry.isbn13 === undefined || !ENGLISH_ISBN.test(entry.isbn13)) continue;
    const format = formatOf(entry.tab);
    const reason =
      format === null ? `format ${entry.tab}` : scopeReason(page, entry.imprint, parsed);
    snapshots.push({
      kind: "yenTitle",
      url,
      isbn13: entry.isbn13,
      title: page.title,
      seriesTitle: parsed.seriesTitle,
      volumeLabel: parsed.volumeLabel ?? undefined,
      multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
      packaging:
        parsed.packaging ??
        (boxed ? { lineName: "Box Set", linePosition: null, coverRange: null } : undefined),
      isBox: boxed || undefined,
      bareNumber: parsed.bareNumber || undefined,
      onsale: entry.onsale,
      format: format?.format ?? "physical",
      binding: format?.binding,
      imprint: entry.imprint,
      priceCents: entry.priceCents,
      seriesName: entry.seriesName,
      category: page.category,
      outOfScope: reason ?? undefined,
    });
  }
  return snapshots;
}
