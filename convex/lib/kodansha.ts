// Kodansha parsing & normalization (ticket #36, spec §6/§7): pure functions
// from Kodansha's first-party JSON endpoints to the normalized snapshots the
// import pipeline stores on Source Observations. Two endpoints feed the
// adapter (both verified live 2026-08-20):
//
// - `GET /wp-json/kodansha/v1/release-calendar` — weekly buckets keyed by
//   Tuesday (`tue_key: "2026-08-04"`), one past + ~7 future weeks; each item
//   carries the volume title, series name, creators, cover, volume URL, and
//   `formats: ["digital","print"]`. The bucket date is the release date.
// - `GET /wp-json/kodansha/v1/new-releases` — this week's releases with an
//   ISO `release_date`, `series_slug`, per-format flags, and `series_type`
//   ("comic" = manga; novels are out of catalog scope).
//
// Neither endpoint exposes ISBNs or prices — those overlay later from the
// PRH API (Kodansha is PRH-distributed) at authoritative ISBN/date rank.
// One catalog item announcing both formats yields one snapshot PER FORMAT:
// print and digital are distinct Releases of one Edition (spec §2), so each
// gets its own observation identity.

import { v, type Infer } from "convex/values";

// ---------- the normalized snapshot ----------

export const kodanshaSnapshotValidator = v.object({
  kind: v.literal("kodanshaVolume"),
  url: v.string(),
  title: v.string(),
  seriesTitle: v.string(),
  seriesSlug: v.string(),
  seriesUrl: v.string(),
  volumeLabel: v.optional(v.string()),
  format: v.union(v.literal("physical"), v.literal("digital")),
  creators: v.array(v.string()),
  releaseDate: v.optional(
    v.object({ year: v.number(), month: v.number(), day: v.number() }),
  ),
  coverUrl: v.optional(v.string()),
});

export type KodanshaSnapshot = Infer<typeof kodanshaSnapshotValidator>;

/** One catalog item before the per-format split. */
export type KodanshaItem = {
  seriesTitle: string;
  seriesSlug: string;
  volumeSlug: string;
  url: string;
  volumeLabel?: string;
  creators: string[];
  formats: Array<"physical" | "digital">;
  releaseDate?: { year: number; month: number; day: number };
  coverUrl?: string;
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

/** "Volume 21" (incl. the API's non-breaking space) → "21"; else no label. */
export function parseVolumeLabel(title: string): string | undefined {
  const m = /volume\s+([0-9]+(?:\.[0-9]+)?)\s*$/i.exec(
    title.replace(/ /g, " "),
  );
  return m ? m[1] : undefined;
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
export function parseIsoDate(
  text: unknown,
): { year: number; month: number; day: number } | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

// ---------- the two endpoint payloads ----------

function itemFrom(args: {
  seriesTitle: unknown;
  volumeTitle: unknown;
  url: unknown;
  creators: unknown;
  formats: Array<"physical" | "digital">;
  releaseDate?: { year: number; month: number; day: number };
  coverUrl: unknown;
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
  return {
    seriesTitle: args.seriesTitle.trim(),
    seriesSlug: slugs.seriesSlug,
    volumeSlug: slugs.volumeSlug,
    url: args.url,
    volumeLabel: parseVolumeLabel(volumeTitle),
    creators: parseCreators(args.creators),
    formats: args.formats,
    releaseDate: args.releaseDate,
    coverUrl: typeof args.coverUrl === "string" ? args.coverUrl : undefined,
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
        creators: e.creators,
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
 * ("comic"); other types (novels) are out of catalog scope (spec §1).
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
    if (typeof e.series_type === "string" && e.series_type !== "comic") continue;
    const formats: Array<"physical" | "digital"> = [];
    if (e.has_print === true) formats.push("physical");
    if (e.is_purchasable === true) formats.push("digital");
    const item = itemFrom({
      seriesTitle: e.series_name,
      volumeTitle: e.volume_title,
      url: e.volume_url,
      creators: e.creators,
      formats,
      releaseDate: parseIsoDate(e.release_date),
      coverUrl: e.image,
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

/** Split one catalog item into its per-format normalized snapshots. */
export function toSnapshots(item: KodanshaItem): KodanshaSnapshot[] {
  return item.formats.map((format) => ({
    kind: "kodanshaVolume" as const,
    url: item.url,
    title: `${item.seriesTitle} ${item.volumeLabel !== undefined ? `Volume ${item.volumeLabel}` : item.volumeSlug}`,
    seriesTitle: item.seriesTitle,
    seriesSlug: item.seriesSlug,
    seriesUrl: `https://kodansha.us/series/${item.seriesSlug}/`,
    volumeLabel: item.volumeLabel,
    format,
    creators: item.creators,
    releaseDate: item.releaseDate,
    coverUrl: item.coverUrl,
  }));
}
