// The SEO layer (ticket #39, spec §11): formula-generated titles and meta
// descriptions per page type, cover-led OG/Twitter cards, canonical URLs, and
// JSON-LD builders. All metadata is generated — no hand-written metadata in
// v1 — so retitling under the branding item is a template edit here, never a
// structural change.
//
// Isomorphic on purpose: route `head()` functions run on the server for SSR
// and on the client for navigations, so everything here must be pure and
// dependency-free (mirroring convex/lib/titles.ts).

export const SITE_NAME = "MangaDB";

/**
 * The canonical public origin (spec §11–12: apex `mangadb.org`). Baked at
 * build time because canonical links and OG URLs render on both server and
 * client; `VITE_SITE_URL` overrides for previews. No trailing slash.
 */
export function siteOrigin(): string {
  const configured = import.meta.env.VITE_SITE_URL as string | undefined;
  return (configured || "https://mangadb.org").replace(/\/+$/, "");
}

/** Absolute canonical URL for a site path. */
export function absoluteUrl(path: string): string {
  return `${siteOrigin()}${path}`;
}

/**
 * Truncate free text (Volume Synopsis, Release Description) to meta-
 * description length at a word boundary, with an ellipsis when cut.
 */
export function truncateDescription(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max / 2 ? lastSpace : max - 1).trimEnd()}…`;
}

// ---------- title templates (issue #19's formulas, verbatim) ----------

export function seriesTitleTag(title: string): string {
  return `${title} – English Manga Volumes & Release Dates | ${SITE_NAME}`;
}

/** An unlabeled Volume is a oneshot (spec §2): no "Vol." segment. */
export function volumeTitleTag(seriesTitle: string, label: string | null): string {
  const name = label === null ? seriesTitle : `${seriesTitle} Vol. ${label}`;
  return `${name} – English Editions & Release Dates | ${SITE_NAME}`;
}

/**
 * Edition template "{Series} {Line} Vol. {Pos} ({Publisher})": the composed
 * Edition title (convex/lib/titles.ts) already carries series + line +
 * position; the Publisher is appended when known.
 */
export function editionTitleTag(
  composedTitle: string,
  publisherName: string | null,
): string {
  const name = publisherName ? `${composedTitle} (${publisherName})` : composedTitle;
  return `${name} – ISBN & Release Date | ${SITE_NAME}`;
}

/** Bundles follow the Edition formula: they are purchasable packages too. */
export function bundleTitleTag(name: string, publisherName: string | null): string {
  const full = publisherName ? `${name} (${publisherName})` : name;
  return `${full} – Box Set ISBN & Release Date | ${SITE_NAME}`;
}

export function publisherTitleTag(name: string): string {
  return `${name} – Manga Releases & Upcoming Books | ${SITE_NAME}`;
}

/** `monthYear` is "August 2026" (lib/month.ts monthTitle). */
export function monthTitleTag(monthYear: string): string {
  return `English Manga Releases – ${monthYear} | ${SITE_NAME}`;
}

export function browserTitleTag(): string {
  return `English Manga Release Calendar | ${SITE_NAME}`;
}

// ---------- per-page head assembly ----------

export type PageHeadArgs = {
  title: string;
  description: string;
  /** Canonical site path ("/series/12/berserk"). Always emitted (spec §11:
   * filtered/paged variants canonicalize here; no `?page=N` is ever
   * indexable because the canonical never carries query params). */
  path: string;
  /** Cover-led social card (spec §11): the representative cover URL. */
  image?: string | null;
  /** Robots directive; omit for indexable pages. Filtered browser views pass
   * "noindex, follow" (spec §11). */
  robots?: string;
  /** OG object type; "book" for book detail pages, default "website". */
  ogType?: "website" | "book";
};

/**
 * The `meta` + `links` a route's `head()` returns for one page: title +
 * description templates, canonical link, robots policy, and the cover-led
 * OG/Twitter card. Cover present → large-image card; absent → plain summary.
 */
export function pageHead({
  title,
  description,
  path,
  image,
  robots,
  ogType = "website",
}: PageHeadArgs) {
  const url = absoluteUrl(path);
  const meta: Array<Record<string, string>> = [
    { title },
    { name: "description", content: description },
    ...(robots ? [{ name: "robots", content: robots }] : []),
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: ogType },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    ...(image ? [{ property: "og:image", content: image }] : []),
    { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    ...(image ? [{ name: "twitter:image", content: image }] : []),
  ];
  return {
    meta,
    links: [{ rel: "canonical", href: url }],
  };
}

// ---------- JSON-LD (spec §11: no ratings markup in v1) ----------

/** One `<script type="application/ld+json">` head entry. */
export function jsonLdScript(data: object) {
  return { type: "application/ld+json", children: JSON.stringify(data) };
}

/**
 * BreadcrumbList — on every catalog page. The last crumb may omit `path`
 * (the current page names itself).
 */
export function breadcrumbListJsonLd(
  crumbs: Array<{ name: string; path?: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      ...(crumb.path ? { item: absoluteUrl(crumb.path) } : {}),
    })),
  };
}

/** BookSeries — on Series pages. */
export function bookSeriesJsonLd(args: {
  title: string;
  altTitles: string[];
  path: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "BookSeries",
    name: args.title,
    ...(args.altTitles.length > 0 ? { alternateName: args.altTitles } : {}),
    url: absoluteUrl(args.path),
  };
}

/** Organization — on Publisher pages. */
export function organizationJsonLd(args: {
  name: string;
  path: string;
  description?: string | null;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: args.name,
    url: absoluteUrl(args.path),
    ...(args.description ? { description: args.description } : {}),
  };
}

/** ISO-8601 rendering of a partial-precision date (spec §8). */
export function isoPartialDate(
  date: { year: number; month?: number | null; day?: number | null } | null,
): string | null {
  if (!date) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!date.month) return String(date.year);
  if (!date.day) return `${date.year}-${pad(date.month)}`;
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** schema.org BookFormatType for a Release's Format/Binding. */
export function schemaBookFormat(
  format: "physical" | "digital",
  binding: string | null,
): string {
  if (format === "digital") return "https://schema.org/EBook";
  return /hard\s*cover|hardback/i.test(binding ?? "")
    ? "https://schema.org/Hardcover"
    : "https://schema.org/Paperback";
}

/**
 * Book — one per Release row on Edition pages (a Release has no page of its
 * own; its URL is the Edition page anchored at the row, spec §11).
 */
export function bookJsonLd(args: {
  name: string;
  editionPath: string;
  anchor: string;
  format: "physical" | "digital";
  binding: string | null;
  isbn13: string | null;
  isbn10: string | null;
  pubDate: { year: number; month?: number | null; day?: number | null } | null;
  language: string;
  publisherName: string | null;
  coverUrl?: string | null;
}) {
  const datePublished = isoPartialDate(args.pubDate);
  const isbn = args.isbn13 ?? args.isbn10;
  return {
    "@context": "https://schema.org",
    "@type": "Book",
    name: args.name,
    url: `${absoluteUrl(args.editionPath)}#${args.anchor}`,
    bookFormat: schemaBookFormat(args.format, args.binding),
    inLanguage: args.language,
    ...(isbn ? { isbn } : {}),
    ...(datePublished ? { datePublished } : {}),
    ...(args.publisherName
      ? { publisher: { "@type": "Organization", name: args.publisherName } }
      : {}),
    ...(args.coverUrl ? { image: args.coverUrl } : {}),
  };
}

/** ItemList — on month pages, one entry per Release linking its Edition. */
export function itemListJsonLd(
  items: Array<{ name: string; path: string; anchor?: string | null }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: `${absoluteUrl(item.path)}${item.anchor ? `#${item.anchor}` : ""}`,
    })),
  };
}
