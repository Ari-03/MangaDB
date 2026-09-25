// ANN Encyclopedia parsing (ticket #36, spec §6/§7): pure functions from
// ANN's XML wire formats to normalized snapshots. Two endpoints feed the
// mirror (both verified live 2026-08-20):
//
// - `reports.xml?id=155&type=manga&nlist=N&nskip=M` — the enumeration of
//   every manga entry (`<item><id>…</id><name>…</name></item>`), paged.
// - `api.xml?manga=ID1/ID2/…` — batch details, up to 50 ids per request
//   (ANN etiquette: 1 request per second). Each `<manga>` carries the Main
//   title, Alternative titles, staff, and one `<release date="YYYY-MM-DD"
//   href="…releases.php?id=NNN">Title (GN 14)</release>` per North American
//   release — future dates included, month precision possible
//   ("2024-11-00"), eBook lines for digital.
//
// ANN is series-structured: one manga entry = one Series; the "(GN n)"
// suffixes define the Volume backbone. Each release line also carries the
// book's ISBN (`ean="978…"` — present on >99.9% of lines, verified live
// 2026-09-25), which links lines to canonical Releases exactly. The API has
// no publisher, so creating a Release needs the per-release Encyclopedia
// page — `releases.php?id=NNN` — whose Distributor, ISBN-10/13, release
// date, and suggested retail price `parseReleasePage` reads (see ann.ts's
// release-page pass).

import { v, type Infer } from "convex/values";
import { toIsbn13 } from "./openLibrary";
import { cleanTitleText, decodeEntities, stripHtml } from "./text";

// ---------- the normalized snapshot ----------

// What reconciliation reads (spec §6): one observation per manga entry, its
// releases embedded (they also get per-release observations keyed on ANN's
// own release ids — see ann.ts).
export const annMangaValidator = v.object({
  kind: v.literal("annManga"),
  id: v.string(),
  url: v.string(),
  title: v.string(),
  altTitles: v.array(v.string()),
  staff: v.array(v.string()),
  releases: v.array(
    v.object({
      annId: v.string(),
      date: v.optional(
        v.object({
          year: v.number(),
          month: v.optional(v.number()),
          day: v.optional(v.number()),
        }),
      ),
      title: v.string(),
      label: v.optional(v.string()),
      multi: v.boolean(),
      format: v.union(v.literal("physical"), v.literal("digital")),
      editionLineHint: v.boolean(),
      /** The line's ISBN-13 (from ANN's `ean` attribute), when valid. */
      isbn13: v.optional(v.string()),
    }),
  ),
});

export type AnnMangaSnapshot = Infer<typeof annMangaValidator>;

// ---------- report enumeration ----------

export type AnnReportItem = { id: string; name: string };

/** One reports.xml page → its manga items (id + name). */
export function parseReport(xml: string): AnnReportItem[] {
  const items: AnnReportItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1]!;
    const id = /<id>(\d+)<\/id>/.exec(body)?.[1];
    const type = /<type>([^<]*)<\/type>/.exec(body)?.[1];
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1];
    if (id === undefined || name === undefined) continue;
    if (type !== undefined && type !== "manga") continue;
    items.push({ id, name: cleanTitleText(name) });
  }
  return items;
}

// ---------- release lines ----------

export type AnnRelease = {
  /** ANN's stable release id (releases.php?id=NNN) — observation identity. */
  annId: string;
  date?: { year: number; month?: number; day?: number };
  /** The English release title before the "(GN n)" designator. */
  title: string;
  /** Volume label ("14", "7.5"); absent = an unnumbered oneshot. */
  label?: string;
  /** A "(GN 1-3)" range or omnibus/box-set designator (multi-volume). */
  multi: boolean;
  format: "physical" | "digital";
  /** Omnibus/box-set/deluxe packaging — an Edition Line shape. */
  editionLineHint: boolean;
  /** The book's ISBN-13, from the line's `ean` attribute. */
  isbn13?: string;
};

// Before 2010 ANN recorded month-only dates as the 1st (day 1 is a third of
// its 2000-04 dates against ~3% elsewhere): such a day is a placeholder.
const MONTH_PLACEHOLDER_BEFORE = 2010;

/**
 * "2026-02-10" | "2024-11-00" | "2024-00-00" → a partial-precision date.
 * A pre-2010 "day 01" reads as month precision, so a real day from another
 * source can refine it (spec §6) instead of losing to false precision.
 */
export function parseAnnDate(
  text: string,
): { year: number; month?: number; day?: number } | undefined {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  if (year < 1900 || year > 2200) return undefined;
  const month = Number(m[2] ?? 0);
  const day = Number(m[3] ?? 0);
  if (month < 1 || month > 12) return { year };
  if (day < 1 || day > 31) return { year, month };
  if (day === 1 && year < MONTH_PLACEHOLDER_BEFORE) return { year, month };
  return { year, month, day };
}

// Packaging words. In the designator ("Omnibus GN 1-3", "GN box 2") they
// always mean packaging; in the line's own title ("Berserk Deluxe Edition
// (GN 1)", "Summer Ghost: The Complete Manga Collection (GN)") only when
// the entry's name does not itself contain them.
const DESIGNATOR_PACKAGING =
  /\b(omnibus|box(?:ed)?(?: set)?|deluxe|collector'?s|hardcover)\b/i;
const TITLE_PACKAGING =
  /\b(omnibus|box(?:ed)? set|deluxe|collector['’]?s|perfect edition|\d-in-1|complete (?:manga )?collection)\b/i;

/**
 * Split one release line's text: "Frieren: Beyond Journey's End (GN 14)" →
 * title + label + format. GN/OGN designators are print, eBook digital;
 * omnibus/box-set designators flag Edition Line packaging; "1-3" ranges are
 * multi-volume. Returns null for lines that are not book releases (DVDs and
 * other designators ANN mixes into other media types) and for single
 * chapters ("eBook ch 17") — chapters are never Volumes. `entryName` (the
 * manga's own title) lets packaging words in the line title count only when
 * they are not part of the series name.
 */
export function splitReleaseTitle(text: string, entryName = ""): {
  title: string;
  label?: string;
  multi: boolean;
  format: "physical" | "digital";
  editionLineHint: boolean;
} | null {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text.trim());
  if (!m) return null;
  const title = m[1]!.trim();
  const designator = m[2]!.trim();
  if (title === "") return null;
  const isEbook = /\be-?book\b/i.test(designator);
  const isPrint = /\bO?GN\b/.test(designator) || /graphic novel/i.test(designator);
  if (!isEbook && !isPrint) return null;
  if (/\bch(?:apter)?\.?\s*\d/i.test(designator)) return null;
  const titleWord = TITLE_PACKAGING.exec(title)?.[1];
  const editionLineHint =
    DESIGNATOR_PACKAGING.test(designator) ||
    (titleWord !== undefined && !entryName.toLowerCase().includes(titleWord.toLowerCase()));
  const range =
    /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(designator) ?? undefined;
  const single = /(\d+(?:\.\d+)?)/.exec(designator) ?? undefined;
  return {
    title,
    label: range ? undefined : single?.[1],
    multi: range !== undefined,
    format: isEbook ? "digital" : "physical",
    editionLineHint,
  };
}

// ---------- manga records ----------

export type AnnManga = {
  id: string;
  title: string;
  altTitles: string[];
  staff: string[];
  releases: AnnRelease[];
};

function parseReleases(body: string, entryName: string): AnnRelease[] {
  const releases: AnnRelease[] = [];
  for (const m of body.matchAll(
    /<release\s+([^>]*)>([\s\S]*?)<\/release>/g,
  )) {
    const attrs = m[1]!;
    const text = decodeEntities(m[2]!).trim();
    const split = splitReleaseTitle(text, entryName);
    if (!split) continue;
    const dateAttr = /date="([^"]*)"/.exec(attrs)?.[1];
    const href = /href="([^"]*)"/.exec(attrs)?.[1];
    const annId = href !== undefined ? /[?&]id=(\d+)/.exec(href)?.[1] : undefined;
    const isbn13 = toIsbn13(/\bean="([^"]*)"/.exec(attrs)?.[1]);
    releases.push({
      // A missing href falls back to a content-derived identity.
      annId:
        annId ??
        `${split.format}:${split.label ?? (split.multi ? "multi" : "oneshot")}:${dateAttr ?? ""}`,
      date: dateAttr !== undefined ? parseAnnDate(dateAttr) : undefined,
      title: split.title,
      label: split.label,
      multi: split.multi,
      format: split.format,
      editionLineHint: split.editionLineHint,
      ...(isbn13 !== undefined ? { isbn13 } : {}),
    });
  }
  return releases;
}

/** Alt-title languages worth keeping for search (English + Japanese forms). */
const ALT_TITLE_LANGS = /^(EN|JA)/i;
const MAX_ALT_TITLES = 12;

/**
 * One api.xml batch response → its manga records. Tolerant: `<warning>`
 * elements ("no result for manga=…") and malformed blocks are skipped.
 */
export function parseApiResponse(xml: string): AnnManga[] {
  const records: AnnManga[] = [];
  for (const m of xml.matchAll(
    /<manga\s+([^>]*)>([\s\S]*?)<\/manga>/g,
  )) {
    const attrs = m[1]!;
    const body = m[2]!;
    const id = /\bid="(\d+)"/.exec(attrs)?.[1];
    if (id === undefined) continue;

    const mainTitle = /<info[^>]*type="Main title"[^>]*>([\s\S]*?)<\/info>/.exec(
      body,
    )?.[1];
    const nameAttr = /\bname="([^"]*)"/.exec(attrs)?.[1];
    const title = cleanTitleText(mainTitle ?? nameAttr ?? "");
    if (title === "") continue;

    const altTitles: string[] = [];
    for (const alt of body.matchAll(
      /<info[^>]*type="Alternative title"[^>]*lang="([^"]*)"[^>]*>([\s\S]*?)<\/info>/g,
    )) {
      if (!ALT_TITLE_LANGS.test(alt[1]!)) continue;
      const value = cleanTitleText(alt[2]!);
      if (value !== "" && value !== title && !altTitles.includes(value)) {
        altTitles.push(value);
      }
      if (altTitles.length >= MAX_ALT_TITLES) break;
    }

    const staff: string[] = [];
    for (const person of body.matchAll(/<person[^>]*>([\s\S]*?)<\/person>/g)) {
      const name = cleanTitleText(person[1]!);
      if (name !== "" && !staff.includes(name)) staff.push(name);
    }

    records.push({ id, title, altTitles, staff, releases: parseReleases(body, title) });
  }
  return records;
}

// ---------- release pages ----------

/**
 * What one Encyclopedia release page (`releases.php?id=NNN`) adds to its
 * API line: the Distributor — the publisher a Release needs — plus the
 * page's own ISBNs, date, and suggested retail price. Stored on the line's
 * observation as `page` (the fetch state that keeps the pass incremental).
 */
export type AnnReleasePage = {
  title?: string;
  /** The designator as the page shows it ("GN 2 / 2", "eBook 1"). */
  volume?: string;
  distributor?: string;
  /** ANN's company id for the distributor (company.php?id=N). */
  distributorId?: string;
  date?: { year: number; month?: number; day?: number };
  isbn13?: string;
  isbn10?: string;
  priceCents?: number;
  /** The manga entry the page belongs to. */
  mangaId?: string;
};

/** One labelled field's raw HTML: `<b>Label:</b> …` up to the next break. */
function pageField(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<b>${escaped}:</b>([\\s\\S]*?)(?:<br\\s*/?>|</p>|<p\\b)`, "i").exec(
    html,
  )?.[1];
}

/**
 * One release page's HTML → its fields, or null when the page is not a
 * release (no "Title:" field — ANN's not-found page, a login wall).
 */
export function parseReleasePage(html: string): AnnReleasePage | null {
  const titleHtml = pageField(html, "Title");
  if (titleHtml === undefined) return null;
  const text = (raw: string | undefined) =>
    raw !== undefined ? cleanTitleText(stripHtml(raw)) || undefined : undefined;

  const distributorHtml = pageField(html, "Distributor");
  const distributorId =
    distributorHtml !== undefined
      ? /company\.php\?id=(\d+)/.exec(distributorHtml)?.[1]
      : undefined;
  const dateText = text(pageField(html, "Release date"));
  const price = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(
    pageField(html, "Suggested retail price") ?? "",
  )?.[1];
  // The ISBN spans spell the number out in parts, then repeat it whole in
  // a hidden span: the first valid 13/10-digit run is the ISBN.
  const isbnIn = (label: string, width: 10 | 13) => {
    const raw = stripHtml(pageField(html, label) ?? "").replace(/\s+/g, " ");
    const runs = raw.match(width === 13 ? /\d{13}/g : /\d{9}[\dX]/g) ?? [];
    return runs.find((run) => toIsbn13(run) !== undefined);
  };
  const isbn13 = toIsbn13(isbnIn("ISBN-13", 13));
  const isbn10 = isbnIn("ISBN-10", 10);

  return {
    title: text(titleHtml),
    volume: text(pageField(html, "Volume")),
    distributor: text(distributorHtml),
    distributorId,
    date: dateText !== undefined ? parseAnnDate(dateText) : undefined,
    isbn13,
    isbn10: isbn10 !== undefined && toIsbn13(isbn10) === isbn13 ? isbn10 : undefined,
    priceCents: price !== undefined ? Math.round(Number(price) * 100) : undefined,
    // The entry link under the release ("Encyclopedia information about"),
    // not whatever manga the site chrome happens to link.
    mangaId: /Encyclopedia information about[\s\S]{0,200}?manga\.php\?id=(\d+)/.exec(html)?.[1],
  };
}

// ---------- URLs & snapshots ----------

/** The Encyclopedia entry URL — ANN's license asks for exactly this linkback. */
export function mangaUrl(id: string): string {
  return `https://www.animenewsnetwork.com/encyclopedia/manga.php?id=${id}`;
}

/** The per-release Encyclopedia URL for release-level citations. */
export function releaseUrl(annId: string): string {
  return `https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${annId}`;
}

export function toSnapshot(manga: AnnManga): AnnMangaSnapshot {
  return {
    kind: "annManga",
    id: manga.id,
    url: mangaUrl(manga.id),
    title: manga.title,
    altTitles: manga.altTitles,
    staff: manga.staff,
    releases: manga.releases,
  };
}
