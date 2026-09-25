// OpenLibrary dump parsing (ticket #36, spec §6/§7): pure functions from
// the monthly editions bulk-dump format to normalized snapshots. Dump lines
// are five tab-separated columns — type, key, revision, last_modified, and
// the edition JSON (https://openlibrary.org/developers/dumps); the raw dump
// is ~10 GB, so an offline filter (scripts/filter-openlibrary-dump.mjs)
// first narrows it to manga-relevant publishers and the adapter streams the
// filtered file.
//
// OpenLibrary's role is ISBN fill (spec §7 stage ④): flat records match
// *into* the existing skeleton and never define Series structure. The
// parser accordingly normalizes exactly the fields the authority table lets
// OpenLibrary offer — ISBNs (standard), dates (weak), format/binding
// (standard) — plus the title/publisher keys matching needs.

import { v, type Infer } from "convex/values";
import { outOfScopeReason, packagingValidator, parseBookTitle } from "./bookTitle";

// ---------- the normalized snapshot ----------

export const olEditionValidator = v.object({
  kind: v.literal("olEdition"),
  /** The stable OpenLibrary edition key ("/books/OL…M") — observation identity. */
  key: v.string(),
  url: v.string(),
  title: v.string(),
  /** The base Series title (lib/bookTitle.ts), never the book title. */
  seriesTitle: v.string(),
  /** The single covered Volume; absent for oneshots and all packaging. */
  volumeLabel: v.optional(v.string()),
  multiVolume: v.boolean(),
  /** Omnibus / deluxe / box-set / range shape, when the title has one. */
  packaging: v.optional(packagingValidator),
  publishers: v.array(v.string()),
  publishDate: v.optional(
    v.object({
      year: v.number(),
      month: v.optional(v.number()),
      day: v.optional(v.number()),
    }),
  ),
  isbn13: v.optional(v.string()),
  isbn10: v.optional(v.string()),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.string()),
});

export type OlEditionSnapshot = Infer<typeof olEditionValidator>;

// ---------- dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * OpenLibrary publish_date styles → a partial-precision date: "Oct 13,
 * 2026", "October 2026", "2026-10-13", "2026". Precision is preserved —
 * a year-only date stays year-only (the refinement rule needs it).
 */
export function parseOlDate(
  raw: string,
): { year: number; month?: number; day?: number } | undefined {
  const text = raw.trim();
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = m[3] !== undefined ? Number(m[3]) : undefined;
    if (month < 1 || month > 12) return { year };
    if (day === undefined) return { year, month };
    return day >= 1 && day <= 31 ? { year, month, day } : { year, month };
  }
  m = /^([A-Za-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    const year = Number(m[3]);
    if (month === undefined) return { year };
    const day = m[2] !== undefined ? Number(m[2]) : undefined;
    if (day === undefined) return { year, month };
    return day >= 1 && day <= 31 ? { year, month, day } : { year, month };
  }
  m = /^(\d{4})$/.exec(text);
  if (m) return { year: Number(m[1]) };
  return undefined;
}

// ---------- edition records ----------

function isbn13s(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => String(value).replace(/[^0-9]/g, ""))
    .filter((digits) => /^\d{13}$/.test(digits) && isbn13CheckOk(digits));
}

function isbn10s(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => String(value).replace(/[^0-9Xx]/g, "").toUpperCase())
    .filter((chars) => /^\d{9}[\dX]$/.test(chars));
}

function isbn13CheckOk(isbn13: string): boolean {
  const sum = [...isbn13].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0;
}

/** ISBN-10 → its ISBN-13 (978 prefix, recomputed check digit). */
export function isbn10To13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/**
 * Any ISBN spelling → a checksum-valid ISBN-13: a 13-digit form as is, a
 * 10-character form converted. Hyphens and spaces are ignored; anything
 * else (an SKU, a UPC, a bad check digit) is undefined. Shared by every
 * adapter that reads bare ISBN strings (ANN, Yen Press).
 */
export function toIsbn13(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const chars = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(chars)) return isbn13CheckOk(chars) ? chars : undefined;
  if (/^\d{9}[\dX]$/.test(chars)) {
    const sum = [...chars].reduce(
      (acc, c, i) => acc + (c === "X" ? 10 : Number(c)) * (10 - i),
      0,
    );
    return sum % 11 === 0 ? isbn10To13(chars) : undefined;
  }
  return undefined;
}

/**
 * The record's ISBN pair, naming ONE book: the first valid ISBN-13 (or one
 * derived from an ISBN-10), plus an ISBN-10 only when it is that same book —
 * OpenLibrary arrays can mix printings, and a 979 ISBN has no ISBN-10.
 */
export function isbnPair(
  raw13: unknown,
  raw10: unknown,
): { isbn13?: string; isbn10?: string } {
  const tens = isbn10s(raw10);
  const isbn13 = isbn13s(raw13)[0] ?? (tens[0] !== undefined ? isbn10To13(tens[0]) : undefined);
  if (isbn13 === undefined) return {};
  const isbn10 = tens.find((ten) => isbn10To13(ten) === isbn13);
  return isbn10 !== undefined ? { isbn13, isbn10 } : { isbn13 };
}

// ISBN registration groups of the English-language market, and groups that
// are never English editions (Japan, France, Germany, Spain, Italy, Korea,
// Taiwan). An edition declaring no language must carry an English-market
// ISBN; a non-English group is out of scope whatever the record declares.
const ENGLISH_ISBN = /^(?:9780|9781|9798)/;
const NON_ENGLISH_ISBN = /^(?:9784|9782|9783|97884|97888|97889|978957|978986|97910|97911|97912)/;

/** Is this an English-language edition, by declared language and ISBN group? */
export function isEnglishEdition(languages: unknown, isbn13: string | undefined): boolean {
  if (isbn13 !== undefined && NON_ENGLISH_ISBN.test(isbn13)) return false;
  const declared = Array.isArray(languages)
    ? languages.flatMap((lang) => {
        const key =
          typeof lang === "object" && lang !== null
            ? (lang as Record<string, unknown>).key
            : undefined;
        return typeof key === "string" ? [key] : [];
      })
    : [];
  if (declared.length > 0) return declared.includes("/languages/eng");
  return isbn13 !== undefined && ENGLISH_ISBN.test(isbn13);
}

const DIGITAL_FORMAT = /e-?book|electronic|kindle|digital/i;

/** One edition JSON object → a snapshot, or null when out of scope. */
export function parseEditionJson(raw: unknown): OlEditionSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const edition = raw as Record<string, unknown>;
  const key = edition.key;
  if (typeof key !== "string" || !key.startsWith("/books/")) return null;
  const title = typeof edition.title === "string" ? edition.title.trim() : "";
  if (title === "") return null;
  const subtitle =
    typeof edition.subtitle === "string" ? edition.subtitle : undefined;

  // English-only scope (spec §1): a declared non-English language, a
  // non-English ISBN group, or no language and no English-market ISBN.
  const isbns = isbnPair(edition.isbn_13, edition.isbn_10);
  if (!isEnglishEdition(edition.languages, isbns.isbn13)) return null;
  // Manga-only scope: novels, merchandise, samplers, other-language editions.
  if (outOfScopeReason(`${title}${subtitle ? ` (${subtitle})` : ""}`) !== null) return null;

  const physicalFormat =
    typeof edition.physical_format === "string"
      ? edition.physical_format.trim()
      : "";
  const digital = DIGITAL_FORMAT.test(physicalFormat);
  const binding = !digital
    ? /hardcover/i.test(physicalFormat)
      ? "hardcover"
      : /paperback/i.test(physicalFormat)
        ? "paperback"
        : undefined
    : undefined;

  // OpenLibrary often splits a volume title across title + subtitle
  // ("Mashle" + "Magic and Muscles, Vol. 3", "Mission" + "Yozakura Family,
  // Vol. 12"). A subtitle the parser can't read as a bare volume marker is
  // re-read joined to the title; the joined reading wins only when it finds
  // the volume (or packaging) the split one missed.
  let parsed = parseBookTitle(title, { subtitle });
  if (subtitle !== undefined && parsed.volumeLabel === null && parsed.packaging === null) {
    const joined = parseBookTitle(`${title}: ${subtitle}`);
    if (joined.volumeLabel !== null || joined.packaging !== null) parsed = joined;
  }
  const coverRange = parsed.packaging?.coverRange ?? null;
  const publishers = Array.isArray(edition.publishers)
    ? edition.publishers.filter((p): p is string => typeof p === "string")
    : [];

  return {
    kind: "olEdition",
    key,
    url: `https://openlibrary.org${key}`,
    title,
    seriesTitle: parsed.seriesTitle,
    volumeLabel: parsed.volumeLabel ?? undefined,
    multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
    packaging: parsed.packaging ?? undefined,
    publishers,
    publishDate:
      typeof edition.publish_date === "string"
        ? parseOlDate(edition.publish_date)
        : undefined,
    ...isbns,
    format: digital ? "digital" : "physical",
    binding,
  };
}

/** One dump line (type\tkey\trevision\tlast_modified\tjson) → a snapshot. */
export function parseDumpLine(line: string): OlEditionSnapshot | null {
  const columns = line.split("\t");
  if (columns.length < 5) return null;
  if (columns[0] !== "/type/edition") return null;
  try {
    return parseEditionJson(JSON.parse(columns.slice(4).join("\t")));
  } catch {
    return null;
  }
}
