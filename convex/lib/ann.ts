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
// suffixes define the Volume backbone. The API carries no publishers and no
// ISBNs (spec §6 authority table: ANN has no ISBN cell), which shapes the
// adapter: it builds Series/Volumes and reconciles dates into releases
// other sources created, keyed through its own stable release ids.

import { v, type Infer } from "convex/values";
import { decodeEntities } from "./text";

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
    items.push({ id, name: decodeEntities(name).trim() });
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
};

/** "2026-02-10" | "2024-11-00" | "2024-00-00" → a partial-precision date. */
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
  return { year, month, day };
}

/**
 * Split one release line's text: "Frieren: Beyond Journey's End (GN 14)" →
 * title + label + format. GN/OGN designators are print, eBook digital;
 * omnibus/box-set designators flag Edition Line packaging; "1-3" ranges are
 * multi-volume. Returns null for lines that are not book releases (DVDs and
 * other designators ANN mixes into other media types).
 */
export function splitReleaseTitle(text: string): {
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
  const editionLineHint = /\b(omnibus|box(?:ed)? set|deluxe|collector'?s|hardcover)\b/i.test(
    designator,
  );
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

function parseReleases(body: string): AnnRelease[] {
  const releases: AnnRelease[] = [];
  for (const m of body.matchAll(
    /<release\s+([^>]*)>([\s\S]*?)<\/release>/g,
  )) {
    const attrs = m[1]!;
    const text = decodeEntities(m[2]!).trim();
    const split = splitReleaseTitle(text);
    if (!split) continue;
    const dateAttr = /date="([^"]*)"/.exec(attrs)?.[1];
    const href = /href="([^"]*)"/.exec(attrs)?.[1];
    const annId = href !== undefined ? /[?&]id=(\d+)/.exec(href)?.[1] : undefined;
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
    const title = decodeEntities(mainTitle ?? nameAttr ?? "").trim();
    if (title === "") continue;

    const altTitles: string[] = [];
    for (const alt of body.matchAll(
      /<info[^>]*type="Alternative title"[^>]*lang="([^"]*)"[^>]*>([\s\S]*?)<\/info>/g,
    )) {
      if (!ALT_TITLE_LANGS.test(alt[1]!)) continue;
      const value = decodeEntities(alt[2]!).trim();
      if (value !== "" && value !== title && !altTitles.includes(value)) {
        altTitles.push(value);
      }
      if (altTitles.length >= MAX_ALT_TITLES) break;
    }

    const staff: string[] = [];
    for (const person of body.matchAll(/<person[^>]*>([\s\S]*?)<\/person>/g)) {
      const name = decodeEntities(person[1]!).trim();
      if (name !== "" && !staff.includes(name)) staff.push(name);
    }

    records.push({ id, title, altTitles, staff, releases: parseReleases(body) });
  }
  return records;
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
