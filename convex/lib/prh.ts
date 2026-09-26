// PRH Enhanced API parsing (ticket #36, spec §6/§7): pure functions from
// the Penguin Random House title-list JSON to normalized snapshots. PRH
// distributes 50+ publishers including Kodansha, Seven Seas, Dark Horse,
// Square Enix, Denpa, and Vertical (VIZ is NOT PRH-distributed); the
// adapter overlays authoritative onsale dates and ISBNs on those records.
//
// Endpoint (requires an api_key; docs at developer.penguinrandomhouse.com):
//   GET /resources/v2/title/domains/PRH.US/imprints/{code}/titles
//       ?api_key=…&rows=200&start=N&sort=onsale&dir=asc|desc
// The imprint-scoped path is mandatory: the flat /titles endpoint silently
// ignores its `imprint` and `onsaleFrom` query params (verified live
// 2026-08 and 2026-09), so date filtering happens client-side in the sync.
// The sync adds the content zoom
// (`zoom=https://api.penguinrandomhouse.com/title/titles/content/definition`),
// which embeds each title's marketing copy in the same response
// (`_embeds[].content`: `flapcopy`, `positioning`, `jacketquotes`… as HTML
// with entities and `<br>`; verified live 2026-09-26,
// __fixtures__/prh/titles-page-zoom.json). The flap copy (else the one-line
// positioning) is the snapshot's `description` — PRH's Release Description.
//
// The parser is deliberately tolerant of shape drift (nested vs flat
// imprint/format fields, string vs number ISBNs) — verified against the
// live API 2026-08.
//
// Scope: a distributed imprint can still publish prose, merchandise, or
// other languages, so titles are gated here — PRH's prose "Vertical"
// imprint and Seven Seas' coloring-book "Waves of Color" imprint are denied
// outright (only "Vertical Comics" is manga), and novels, merchandise,
// samplers, and non-English editions are dropped by title. PRH's own
// classification adds what titles miss (prhScopeReason): `graphicCategory`
// "Light Novel", prose-only BISAC `subjects`, and the general TOKYOPOP
// imprint's "Graphic Novel" category (its art books, card decks, album-style
// GNs). Scope is "does it look like manga", not origin: OEL/global manga,
// manhwa, manhua and manga-styled originals stay in. A non-manga-looking
// comic PRH still files as "Manga" (e.g. a US-style issue) has no PRH
// signal and is left to Editors.

import { v, type Infer } from "convex/values";
import { outOfScopeReason, parseBookTitle } from "./bookTitle";
import { catalogTitleFields } from "./catalogTitle";
import { cleanBlurb } from "./text";

// ---------- the normalized snapshot ----------

export const prhTitleValidator = v.object({
  kind: v.literal("prhTitle"),
  ...catalogTitleFields,
});

export type PrhTitleSnapshot = Infer<typeof prhTitleValidator>;

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
  const chars = String(raw ?? "")
    .replace(/[^0-9Xx]/g, "")
    .toUpperCase();
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

/**
 * The title's blurb from the content zoom (`_embeds[].content`): the flap
 * copy, else the one-line positioning. An embed naming another EAN is
 * ignored.
 */
function flapCopy(entry: Record<string, unknown>, isbn13: string): string | undefined {
  const contents = (Array.isArray(entry._embeds) ? entry._embeds : []).flatMap((embed) => {
    const content = (embed as { content?: unknown } | null)?.content;
    if (typeof content !== "object" || content === null) return [];
    const fields = content as Record<string, unknown>;
    return fields.ean === undefined || String(fields.ean) === isbn13 ? [fields] : [];
  });
  for (const key of ["flapcopy", "positioning"]) {
    for (const content of contents) {
      const text = cleanBlurb(content[key]);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

// ---------- title records ----------

const DIGITAL = /\be-?book\b|\bdigital\b|\bDN\b/i;
const AUDIO = /audio/i;

// Imprints that are never manga: Vertical Inc.'s prose line (its manga
// arrives as "Vertical Comics") and Seven Seas' coloring books.
const DENIED_IMPRINTS = /^(?:vertical|waves of color)$/i;

// PRH classification signals, calibrated on live imprint listings
// (2026-09-25: 209, 210, 206, 140, KN, KM, V4, XO, XP, 123, 334):
// - graphicCategory "Light Novel" is prose everywhere ("Berserk: The Flame
//   Dragon Knight" carries no novel word in its title).
// - Every BISAC subject a FIC (fiction) code: prose ("Six: Paths of Horror").
//   Juvenile-only (JUV) subjects are NOT a signal — real kids' manga ("The
//   Fox & Little Tanuki", Tokyopop's "Agent Boo") carry only those.
// - "Graphic Novel" is not a signal in general (Titan Manga and Vertical
//   Comics file real manga under it), but in the general TOKYOPOP imprint
//   it marks only non-manga: art books, card decks, advent calendars,
//   sticker books, the album-style "Ballad of The Broken Heart".
const PROSE_CATEGORY = /^light novel$/i;
const NON_MANGA_GN_IMPRINT = /^tokyopop$/i;

/**
 * Why PRH's own classification puts a title outside the manga catalog, or
 * null when it does not: see the signals above. `imprint` is the parsed
 * imprint description.
 */
export function prhScopeReason(
  entry: Record<string, unknown>,
  imprint: string | undefined,
): "novel" | "prose" | "notManga" | null {
  const category = typeof entry.graphicCategory === "string" ? entry.graphicCategory.trim() : "";
  if (PROSE_CATEGORY.test(category)) return "novel";
  const codes = Array.isArray(entry.subjects)
    ? entry.subjects.flatMap((subject) =>
        typeof subject === "object" &&
        subject !== null &&
        "code" in subject &&
        typeof subject.code === "string"
          ? [subject.code]
          : [],
      )
    : [];
  if (codes.length > 0 && codes.every((code) => code.startsWith("FIC"))) return "prose";
  if (
    imprint !== undefined &&
    NON_MANGA_GN_IMPRINT.test(imprint) &&
    /^graphic novel$/i.test(category)
  ) {
    return "notManga";
  }
  return null;
}

/** One title entry → a snapshot, or null when malformed / out of scope. */
export function parseTitle(raw: unknown): PrhTitleSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const isbn13 = asIsbn13(entry.isbn ?? entry.isbnHyphenated);
  if (isbn13 === undefined) return null;
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title === "") return null;

  // Scope (spec §1): prose imprints, novels, merchandise, samplers, and
  // non-English editions never enter the catalog.
  const imprint = described(entry.imprint) ?? described(entry.publisher);
  if (imprint !== undefined && DENIED_IMPRINTS.test(imprint)) return null;
  if (outOfScopeReason(title) !== null) return null;
  if (prhScopeReason(entry, imprint) !== null) return null;
  const language = described(entry.language);
  if (language !== undefined && !/^(?:e|en|eng|english)$/i.test(language)) return null;

  // Format family: audio is out of catalog scope entirely (spec §1).
  const formatText = described(entry.format) ?? described(entry.formatFamily) ?? "";
  if (AUDIO.test(formatText)) return null;
  const digital = DIGITAL.test(formatText);
  const binding = !digital
    ? /hardcover/i.test(formatText)
      ? "hardcover"
      : /paperback|trade/i.test(formatText)
        ? "paperback"
        : undefined
    : undefined;

  const seriesNumber =
    typeof entry.seriesNumber === "number" || typeof entry.seriesNumber === "string"
      ? entry.seriesNumber
      : undefined;
  const parsed = parseBookTitle(title, { seriesNumber });
  const coverRange = parsed.packaging?.coverRange ?? null;

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
    seriesTitle: parsed.seriesTitle,
    volumeLabel: parsed.volumeLabel ?? undefined,
    multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
    packaging: parsed.packaging ?? undefined,
    isBox: parsed.isBox || undefined,
    bareNumber: parsed.bareNumber || undefined,
    author: typeof entry.author === "string" ? entry.author.trim() : undefined,
    onsale: parseOnsale(entry.onsale ?? entry.onSaleDate),
    format: digital ? "digital" : "physical",
    binding,
    imprint,
    priceCents: priceCents(entry),
    description: flapCopy(entry, isbn13),
  };
}

/**
 * The title-list envelope → its parsed titles + the total record count.
 * Verified live 2026-09-26 (__fixtures__/prh/titles-page.json): every page
 * carries `status` ("ok", or "warning" with the data intact), a root
 * `recordCount`, and `data.titles`; a page past the end or an unknown
 * imprint is an HTTP 404, never an empty page. So the count is required —
 * without it an empty page is no evidence the imprint is empty, and a
 * missing `titles` array is tolerated only with an explicit recordCount 0.
 */
export function parseTitleList(raw: unknown): {
  titles: PrhTitleSnapshot[];
  recordCount: number;
  /** Upstream page size, before scope filtering. */
  rawCount: number;
} {
  const root = raw as Record<string, unknown> | null;
  const envelope = typeof root?.data === "object" && root.data !== null;
  const data = (envelope ? root.data : root) as Record<string, unknown> | null;
  const status = root?.status;
  if (typeof status === "string" && status !== "ok" && status !== "warning") {
    throw new Error(`PRH response status is ${status}`);
  }
  const count = root?.recordCount ?? data?.recordCount;
  if (typeof count !== "number") throw new Error("PRH response is missing its recordCount");
  const recordCount = count;
  const list = data?.titles;
  if (!Array.isArray(list)) {
    if (list == null && recordCount === 0) {
      return { titles: [], rawCount: 0, recordCount };
    }
    throw new Error("PRH response is missing its titles array");
  }
  const titles: PrhTitleSnapshot[] = [];
  for (const entry of list) {
    const parsed = parseTitle(entry);
    if (parsed) titles.push(parsed);
  }
  return { titles, rawCount: list.length, recordCount };
}
