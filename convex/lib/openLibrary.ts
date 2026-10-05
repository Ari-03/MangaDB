// OpenLibrary dump parsing (spec §6/§7): pure functions from
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
// (standard), the edition's `description` blurb (weak) — plus the
// title/publisher keys matching needs.

import { v, type Infer } from "convex/values";
import { outOfScopeReason, packagingValidator, parseBookTitle } from "./bookTitle";
import { parsedTitleFields } from "./catalogTitle";
import { calendarDay, datePartsValidator, monthFromAbbreviation, type DateParts } from "./dates";
import { isbn10To13, isbn13CheckOk, toIsbn13 } from "./isbn";
import { cleanBlurb } from "./text";

// ---------- the normalized snapshot ----------

export const olEditionValidator = v.object({
  kind: v.literal("olEdition"),
  /** The stable OpenLibrary edition key ("/books/OL…M") — observation identity. */
  key: v.string(),
  url: v.string(),
  /** The book title: OpenLibrary's title, joined with its subtitle when the
   * subtitle completes the volume title. */
  title: v.string(),
  /**
   * OpenLibrary's subtitle as given, when it is not joined into `title`:
   * the parser read it beside the title ("Mashle" + "Vol. 3" is Vol. 3), so
   * a later reading needs both. Snapshots stored before this field lack it;
   * their seriesTitle and volumeLabel stand as first read.
   */
  subtitle: v.optional(v.string()),
  /** The base Series title (lib/bookTitle.ts), never the book title. */
  seriesTitle: v.string(),
  /** The single covered Volume; absent for oneshots and all packaging. */
  volumeLabel: v.optional(v.string()),
  multiVolume: v.boolean(),
  /** Omnibus / deluxe / box-set / range shape, when the title has one. */
  packaging: v.optional(packagingValidator),
  /**
   * The parser's provisional readings (lib/bookTitle.ts), resolved against
   * the existing catalog at apply time (lib/catalogTitle.ts
   * resolveBaseSeries): "Chainsaw Man 22" is Vol. 22 only if an existing
   * "Chainsaw Man" claims it.
   */
  bareNumber: v.optional(v.boolean()),
  bareRoman: v.optional(v.boolean()),
  bareSplit: v.optional(v.object({ seriesTitle: v.string(), volumeLabel: v.string() })),
  publishers: v.array(v.string()),
  publishDate: v.optional(datePartsValidator),
  isbn13: v.optional(v.string()),
  isbn10: v.optional(v.string()),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.string()),
  /** The edition's blurb, cleaned to one paragraph. */
  description: v.optional(v.string()),
});

export type OlEditionSnapshot = Infer<typeof olEditionValidator>;

// ---------- dates ----------

/** The most precise date the parts name: an impossible day keeps the month. */
function calendarDate(year: number, month: number, day?: number): DateParts {
  if (month < 1 || month > 12) return { year };
  return (day !== undefined ? calendarDay(year, month, day) : undefined) ?? { year, month };
}

/**
 * OpenLibrary publish_date styles → a partial-precision date: "Oct 13,
 * 2026", "October 2026", "2026-10-13", "2026". Precision is preserved —
 * a year-only date stays year-only (the refinement rule needs it).
 */
export function parseOlDate(raw: string): DateParts | undefined {
  const text = raw.trim();
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = m[3] !== undefined ? Number(m[3]) : undefined;
    return calendarDate(year, month, day);
  }
  m = /^([A-Za-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(text);
  if (m) {
    const month = monthFromAbbreviation(m[1]!);
    const year = Number(m[3]);
    if (month === undefined) return { year };
    const day = m[2] !== undefined ? Number(m[2]) : undefined;
    return calendarDate(year, month, day);
  }
  m = /^(\d{4})$/.exec(text);
  if (m) return { year: Number(m[1]) };
  return undefined;
}

// ---------- edition records ----------

function isbn13s(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/[\s-]/g, ""))
    .filter((digits) => /^(?:978|979)\d{10}$/.test(digits) && isbn13CheckOk(digits));
}

function isbn10s(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/[\s-]/g, "").toUpperCase())
    .filter((chars) => /^\d{9}[\dX]$/.test(chars) && toIsbn13(chars) !== undefined);
}

/**
 * The record's ISBN pair, naming ONE book: the first valid ISBN-13 (or one
 * derived from an ISBN-10), plus an ISBN-10 only when it is that same book —
 * OpenLibrary arrays can mix printings, and a 979 ISBN has no ISBN-10.
 */
export function isbnPair(raw13: unknown, raw10: unknown): { isbn13?: string; isbn10?: string } {
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

// A library catalogue's physical description standing in for a blurb
// ("1 volume (unpaged) : 19 cm", "146 p. : 19 cm", "v. : 19 cm").
const COLLATION =
  /^(?:\d+\s*(?:volumes?|v\.|p\.|pages)|v\.)[^a-z]*(?:[a-z.]+[^a-z]*)?\b\d+\s*cm\.?$/i;
// The source a cataloguer cites after quoting the blurb: `"…"--P. [4] of
// cover.`, `"…"--Back cover.`, `"…" -- from publisher's web site.`, or a
// bare `"--`. After a closing quote any of these; after a sentence's
// closing stop a named source ("…Yukihime?--Amazon.com"); otherwise only a
// page-of-cover reference ("… -- p.4 of cover."), so prose dashes stay
// ("and then--", "They ran for--cover.").
const PAGE_OF_COVER =
  "(?:vol\\.\\s*\\d+,\\s*)?(?:p\\.|pg\\.|page)\\s*\\[?\\d+\\]?\\s*of\\s*(?:cover|jacket)(?:,\\s*v(?:ol)?\\.\\s*\\d+)?";
const QUOTED_SOURCE =
  "(?:back\\s+)?cover(?:,\\s*v\\.\\s*\\d+,\\s*p\\.\\s*\\[\\d+\\])?|jacket|container|provided by (?:the )?publisher|(?:from )?publisher'?s web ?site|publisher'?s description|amazon\\.com";
const CITATION = new RegExp(
  `(?:\\s*["”]\\s*--\\s*(?:${PAGE_OF_COVER}|${QUOTED_SOURCE})?|(?<=[.!?])\\s*--\\s*(?:${PAGE_OF_COVER}|${QUOTED_SOURCE})|\\s*--\\s*${PAGE_OF_COVER})\\.?\\s*$`,
  "i",
);

/**
 * An Open Library description as a Release Description: a cataloguer's
 * physical description is no blurb (undefined), and a trailing citation of
 * where the quoted blurb came from goes, with the quote it opened. Pure
 * and idempotent: `openLibrary:repairDescriptions` re-runs it on stored text.
 */
export function cleanOlDescription(text: string): string | undefined {
  let out = text.trim();
  if (out.length <= 80 && COLLATION.test(out)) return undefined;
  // Stacked citations ("…"--Back cover."--P. [4] of cover.) go in one call.
  let cited = out;
  for (let pass = 0; pass < 3; pass++) cited = cited.replace(CITATION, "").trim();
  if (cited !== out) {
    out = cited;
    // The quote the citation closed: unwrap `"…"`, or drop a lone opener.
    const quotes = (out.match(/["“”]/g) ?? []).length;
    if (quotes === 1 && /^["“]/.test(out)) out = out.slice(1).trim();
  }
  return out === "" ? undefined : out;
}

/** An edition `description`: a bare string or a `{type: "/type/text", value}` object. */
function descriptionOf(raw: unknown): string | undefined {
  const text = typeof raw === "object" && raw !== null ? (raw as { value?: unknown }).value : raw;
  const cleaned = cleanBlurb(text);
  return cleaned !== undefined ? cleanOlDescription(cleaned) : undefined;
}

/** One edition JSON object → a snapshot, or null when out of scope. */
export function parseEditionJson(raw: unknown): OlEditionSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const edition = raw as Record<string, unknown>;
  const key = edition.key;
  if (typeof key !== "string" || !key.startsWith("/books/")) return null;
  const title = typeof edition.title === "string" ? edition.title.trim() : "";
  if (title === "") return null;
  const subtitle = typeof edition.subtitle === "string" ? edition.subtitle : undefined;

  // English-only scope (spec §1): a declared non-English language, a
  // non-English ISBN group, or no language and no English-market ISBN.
  const isbns = isbnPair(edition.isbn_13, edition.isbn_10);
  if (!isEnglishEdition(edition.languages, isbns.isbn13)) return null;
  // Manga-only scope: novels, merchandise, samplers, other-language editions.
  if (outOfScopeReason(`${title}${subtitle ? ` (${subtitle})` : ""}`) !== null) return null;

  const physicalFormat =
    typeof edition.physical_format === "string" ? edition.physical_format.trim() : "";
  // Audio metadata often lives only in physical_format, not the title.
  // An audiobook must never become a physical manga Release.
  if (/audio|cassette|mp3/i.test(physicalFormat)) return null;
  const digital = DIGITAL_FORMAT.test(physicalFormat);
  const binding = !digital
    ? /hardcover/i.test(physicalFormat)
      ? "hardcover"
      : /paperback/i.test(physicalFormat)
        ? "paperback"
        : undefined
    : undefined;

  // OpenLibrary often splits a volume title across title + subtitle
  // ("Mashle" + "Magic and Muscles, Vol. 3", "Kingdom" + "Hearts II"). A
  // subtitle the parser can't read as a bare volume marker is re-read
  // joined to the title; the joined reading wins when it finds the volume,
  // packaging, or bare split the split one missed. The joined text then
  // becomes the book title, so its provisional readings resolve against the
  // whole name in resolveBaseSeries ("Kingdom: Hearts II" is the sequel
  // when that Series exists, not "Kingdom Hearts" Vol. 2).
  let parsed = parseBookTitle(title, { subtitle });
  let bookTitle = title;
  if (subtitle !== undefined && parsed.volumeLabel === null && parsed.packaging === null) {
    const joinedTitle = `${title}: ${subtitle}`;
    const joined = parseBookTitle(joinedTitle);
    if (joined.volumeLabel !== null || joined.packaging !== null || joined.bareSplit !== null) {
      parsed = joined;
      bookTitle = joinedTitle;
    }
  }
  const publishers = Array.isArray(edition.publishers)
    ? edition.publishers.filter((p): p is string => typeof p === "string")
    : [];

  return {
    kind: "olEdition",
    key,
    url: `https://openlibrary.org${key}`,
    title: bookTitle,
    ...(subtitle !== undefined && subtitle.trim() !== "" && bookTitle === title
      ? { subtitle }
      : {}),
    ...parsedTitleFields(parsed),
    publishers,
    publishDate:
      typeof edition.publish_date === "string" ? parseOlDate(edition.publish_date) : undefined,
    ...isbns,
    format: digital ? "digital" : "physical",
    binding,
    description: descriptionOf(edition.description),
  };
}

/**
 * One dump line (type\tkey\trevision\tlast_modified\tjson) → a snapshot.
 * A malformed envelope (column count, JSON, or an edition key that is not
 * the line's key) throws; a sparse edition — no title, say, which the
 * offline filter keeps since it selects by publisher and ISBN only — is
 * simply skipped by parseEditionJson.
 */
export function parseDumpLine(line: string): OlEditionSnapshot | null {
  const columns = line.split("\t");
  if (columns.length !== 5) throw new Error("Invalid Open Library dump envelope");
  if (columns[0] !== "/type/edition") return null;
  const edition: unknown = JSON.parse(columns[4]!);
  if (
    typeof edition !== "object" ||
    edition === null ||
    !("key" in edition) ||
    typeof edition.key !== "string" ||
    !/^\/books\/OL\d+M$/.test(edition.key) ||
    edition.key !== columns[1]
  ) {
    throw new Error("Invalid Open Library edition identity");
  }
  return parseEditionJson(edition);
}
