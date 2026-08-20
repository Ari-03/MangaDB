// PRH Enhanced API parsing (ticket #36, spec §6/§7): pure functions from
// the Penguin Random House title-list JSON to normalized snapshots. PRH
// distributes 50+ publishers including Kodansha, Seven Seas, Dark Horse,
// Square Enix, Denpa, and Vertical (VIZ is NOT PRH-distributed); the
// adapter overlays authoritative onsale dates and ISBNs on those records.
//
// Endpoint (requires an api_key; docs at developer.penguinrandomhouse.com):
//   GET /resources/v2/title/domains/PRH.US/titles
//       ?api_key=…&imprint={code}&rows=200&start=N[&onsaleFrom=YYYY-MM-DD]
//
// The parser is deliberately tolerant of shape drift (nested vs flat
// imprint/format fields, string vs number ISBNs) — the exact live shape
// can only be re-verified once a key is activated.

import { v, type Infer } from "convex/values";

// ---------- the normalized snapshot ----------

export const prhTitleValidator = v.object({
  kind: v.literal("prhTitle"),
  url: v.string(),
  isbn13: v.string(),
  isbn10: v.optional(v.string()),
  title: v.string(),
  seriesTitle: v.string(),
  volumeLabel: v.optional(v.string()),
  multiVolume: v.boolean(),
  author: v.optional(v.string()),
  onsale: v.optional(
    v.object({ year: v.number(), month: v.number(), day: v.number() }),
  ),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.string()),
  /** The imprint = the publisher brand (e.g. "Kodansha Comics"). */
  imprint: v.optional(v.string()),
  priceCents: v.optional(v.number()),
});

export type PrhTitleSnapshot = Infer<typeof prhTitleValidator>;

// ---------- title splitting ----------

/**
 * Split a PRH title into series title + volume label. PRH styles vary by
 * publisher: "Witch Hat Atelier 15", "Chainsaw Man, Vol. 22", "Berserk
 * Volume 41", "The Way of the Househusband, Vol. 1-3 (Omnibus)". A supplied
 * seriesNumber (a PRH title field) wins over text parsing.
 */
export function splitPrhTitle(
  title: string,
  seriesNumber?: number | string,
): { seriesTitle: string; volumeLabel?: string; multiVolume: boolean } {
  const trimmed = title.trim();
  const range =
    /^(.*?)(?:[,:]?\s+(?:Vols?\.?|Volumes?)\s+)(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:\(.*\))?$/i.exec(
      trimmed,
    );
  if (range) {
    return { seriesTitle: range[1]!.trim(), multiVolume: true };
  }
  const marked =
    /^(.*?)(?:[,:]?\s+(?:Vols?\.?|Volumes?)\s+)(\d+(?:\.\d+)?)\s*(?:\(.*\))?$/i.exec(
      trimmed,
    );
  if (marked) {
    return {
      seriesTitle: marked[1]!.trim(),
      volumeLabel: marked[2],
      multiVolume: false,
    };
  }
  // Kodansha-style bare trailing number: "Witch Hat Atelier 15".
  const bare = /^(.*[^\d\s])\s+(\d{1,3}(?:\.\d+)?)$/.exec(trimmed);
  if (bare) {
    return {
      seriesTitle: bare[1]!.trim(),
      volumeLabel: bare[2],
      multiVolume: false,
    };
  }
  const numbered =
    seriesNumber !== undefined && seriesNumber !== null && `${seriesNumber}` !== ""
      ? `${seriesNumber}`
      : undefined;
  return { seriesTitle: trimmed, volumeLabel: numbered, multiVolume: false };
}

// ---------- field plumbing ----------

/** "2026-12-08" or "2026-12-08T00:00:00-05:00" → a full-precision date. */
export function parseOnsale(
  raw: unknown,
): { year: number; month: number; day: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

function asIsbn13(raw: unknown): string | undefined {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return /^\d{13}$/.test(digits) ? digits : undefined;
}

function asIsbn10(raw: unknown): string | undefined {
  const chars = String(raw ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^\d{9}[\dX]$/.test(chars) ? chars : undefined;
}

/** Nested `{code, description}` or flat string → the description text. */
function described(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (typeof raw === "object" && raw !== null) {
    const desc = (raw as Record<string, unknown>).description;
    if (typeof desc === "string" && desc.trim() !== "") return desc.trim();
  }
  return undefined;
}

function priceCents(entry: Record<string, unknown>): number | undefined {
  const flat = entry.priceUsd ?? entry.priceUSD;
  if (typeof flat === "number" && flat > 0) return Math.round(flat * 100);
  if (Array.isArray(entry.price)) {
    for (const row of entry.price) {
      if (typeof row !== "object" || row === null) continue;
      const p = row as Record<string, unknown>;
      if (p.currencyCode === "USD" && typeof p.amount === "number" && p.amount > 0) {
        return Math.round(p.amount * 100);
      }
    }
  }
  return undefined;
}

// ---------- title records ----------

const DIGITAL = /\be-?book\b|\bdigital\b|\bDN\b/i;
const AUDIO = /audio/i;

/** One title entry → a snapshot, or null when malformed / out of scope. */
export function parseTitle(raw: unknown): PrhTitleSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const isbn13 = asIsbn13(entry.isbn ?? entry.isbnHyphenated);
  if (isbn13 === undefined) return null;
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title === "") return null;

  // Format family: audio is out of catalog scope entirely (spec §1).
  const formatText =
    described(entry.format) ?? described(entry.formatFamily) ?? "";
  if (AUDIO.test(formatText)) return null;
  const digital = DIGITAL.test(formatText);
  const binding = !digital
    ? /hardcover/i.test(formatText)
      ? "hardcover"
      : /paperback|trade/i.test(formatText)
        ? "paperback"
        : undefined
    : undefined;

  const seriesNumber = entry.seriesNumber as number | string | undefined;
  const split = splitPrhTitle(title, seriesNumber);

  const seo = entry.seoFriendlyUrl;
  const url =
    typeof seo === "string" && seo.startsWith("/")
      ? `https://www.penguinrandomhouse.com${seo}`
      : `https://www.penguinrandomhouse.com/search/site-search?q=${isbn13}`;

  return {
    kind: "prhTitle",
    url,
    isbn13,
    isbn10: asIsbn10(entry.isbn10),
    title,
    seriesTitle: split.seriesTitle,
    volumeLabel: split.volumeLabel,
    multiVolume: split.multiVolume,
    author: typeof entry.author === "string" ? entry.author.trim() : undefined,
    onsale: parseOnsale(entry.onsale ?? entry.onSaleDate),
    format: digital ? "digital" : "physical",
    binding,
    imprint: described(entry.imprint) ?? described(entry.publisher),
    priceCents: priceCents(entry),
  };
}

/** The title-list envelope → its parsed titles + the total record count. */
export function parseTitleList(raw: unknown): {
  titles: PrhTitleSnapshot[];
  recordCount?: number;
} {
  const root = raw as Record<string, unknown> | null;
  const data = (root?.data ?? root) as Record<string, unknown> | null;
  const list = data?.titles;
  const titles: PrhTitleSnapshot[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const parsed = parseTitle(entry);
      if (parsed) titles.push(parsed);
    }
  }
  const count = root?.recordCount ?? data?.recordCount;
  return {
    titles,
    recordCount: typeof count === "number" ? count : undefined,
  };
}

/** "Kodansha Comics" → the publisher row shape {name, slug}. */
export function imprintPublisher(imprint: string): { name: string; slug: string } {
  const name = imprint.trim();
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { name, slug: slug === "" ? "prh-imprint" : slug };
}
