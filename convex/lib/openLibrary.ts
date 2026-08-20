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

// ---------- the normalized snapshot ----------

export const olEditionValidator = v.object({
  kind: v.literal("olEdition"),
  /** The stable OpenLibrary edition key ("/books/OL…M") — observation identity. */
  key: v.string(),
  url: v.string(),
  title: v.string(),
  seriesTitle: v.string(),
  volumeLabel: v.optional(v.string()),
  multiVolume: v.boolean(),
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

// ---------- titles ----------

/**
 * Split an OpenLibrary edition title into series title + volume label:
 * "Chainsaw Man, Vol. 22", "Berserk Volume 41", "One Piece #3", with the
 * volume number sometimes in the subtitle. No trailing-bare-number rule —
 * OL titles are too messy for it ("1984", "Akira 2019 art book").
 */
export function splitOlTitle(
  title: string,
  subtitle?: string,
): { seriesTitle: string; volumeLabel?: string; multiVolume: boolean } {
  const text = title.trim();
  const range =
    /^(.*?)[,:]?\s+(?:Vols?\.?|Volumes?)\s+(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$/i.exec(
      text,
    );
  if (range) return { seriesTitle: range[1]!.trim(), multiVolume: true };
  const marked =
    /^(.*?)[,:]?\s+(?:Vols?\.?|Volumes?|#)\s*(\d+(?:\.\d+)?)\s*$/i.exec(text);
  if (marked) {
    return {
      seriesTitle: marked[1]!.trim(),
      volumeLabel: marked[2],
      multiVolume: false,
    };
  }
  if (subtitle !== undefined) {
    const sub = /^(?:Vols?\.?|Volumes?)\s*(\d+(?:\.\d+)?)$/i.exec(subtitle.trim());
    if (sub) {
      return { seriesTitle: text, volumeLabel: sub[1], multiVolume: false };
    }
  }
  return { seriesTitle: text, multiVolume: false };
}

// ---------- edition records ----------

function firstIsbn13(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const value of raw) {
    const digits = String(value).replace(/[^0-9]/g, "");
    if (/^\d{13}$/.test(digits)) return digits;
  }
  return undefined;
}

function firstIsbn10(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const value of raw) {
    const chars = String(value).replace(/[^0-9Xx]/g, "").toUpperCase();
    if (/^\d{9}[\dX]$/.test(chars)) return chars;
  }
  return undefined;
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

  // English-only scope (spec §1): skip editions declaring other languages.
  if (Array.isArray(edition.languages) && edition.languages.length > 0) {
    const eng = edition.languages.some(
      (lang) =>
        typeof lang === "object" &&
        lang !== null &&
        (lang as Record<string, unknown>).key === "/languages/eng",
    );
    if (!eng) return null;
  }

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

  const subtitle =
    typeof edition.subtitle === "string" ? edition.subtitle : undefined;
  const split = splitOlTitle(title, subtitle);
  const publishers = Array.isArray(edition.publishers)
    ? edition.publishers.filter((p): p is string => typeof p === "string")
    : [];

  return {
    kind: "olEdition",
    key,
    url: `https://openlibrary.org${key}`,
    title,
    seriesTitle: split.seriesTitle,
    volumeLabel: split.volumeLabel,
    multiVolume: split.multiVolume,
    publishers,
    publishDate:
      typeof edition.publish_date === "string"
        ? parseOlDate(edition.publish_date)
        : undefined,
    isbn13: firstIsbn13(edition.isbn_13),
    isbn10: firstIsbn10(edition.isbn_10),
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
