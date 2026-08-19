// On-demand sitemaps + robots.txt (ticket #39, spec §11), served from the
// custom Workers entry (src/server.ts) alongside the canonical-host redirect:
// `/sitemap.xml` is an index of per-entity child sitemaps (series, volumes,
// editions, publishers, bundles, months) containing exactly the indexable
// canonical URLs, `lastmod` from each record's latest Revision, generated on
// demand with cache headers — no cron (fits Workers + Convex).
//
// Never-indexed surfaces are deliberately absent: filtered browser views,
// `/search`, `/me/…`, auth pages, `/u/{username}`, and any `?page=N` form
// (no sitemap URL ever carries a query string). Releases have no URL of
// their own — they are rows on their Edition page.

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api";
import { addMonths, monthParam, type YearMonth } from "~/lib/month";
import { siteOrigin } from "~/lib/seo";
import { bundlePath, editionPath, seriesPath, volumePath } from "~/lib/slug";

// Sitemap-protocol ceiling per file; v1 stays far below it. If a child ever
// approaches the cap, split it into numbered chunks in this module.
const MAX_URLS = 50_000;
const PAGE_SIZE = 200;
const MAX_MONTHS = 1200; // a century of month pages; sanity bound

const CACHE_CONTROL = "public, max-age=3600, s-maxage=21600";

/** The child sitemaps under `/sitemaps/{child}.xml`, in index order. */
export const SITEMAP_CHILDREN = [
  "series",
  "volumes",
  "editions",
  "publishers",
  "bundles",
  "months",
] as const;
export type SitemapChild = (typeof SITEMAP_CHILDREN)[number];

// The record-backed children, mapped to convex/seo.ts's entity argument.
const ENTITY_FOR_CHILD = {
  series: "series",
  volumes: "volume",
  editions: "edition",
  publishers: "publisher",
  bundles: "bundle",
} as const;

type SitemapEntry = {
  publicId: number | null;
  slug: string | null;
  title: string;
  lastmod: number;
};

/**
 * The data the sitemap routes read, injected so tests exercise the XML
 * composition without a Convex deployment. `sitemapPage` mirrors Convex
 * pagination; `monthRange` is the dated-Release month span.
 */
export type SitemapData = {
  sitemapPage: (
    entity: (typeof ENTITY_FOR_CHILD)[keyof typeof ENTITY_FOR_CHILD],
    cursor: string | null,
  ) => Promise<{ entries: SitemapEntry[]; isDone: boolean; continueCursor: string }>;
  monthRange: () => Promise<{ from: YearMonth; to: YearMonth } | null>;
};

/** SitemapData backed by the Convex deployment; null when unconfigured. */
export function convexSitemapData(): SitemapData | null {
  const url =
    import.meta.env.VITE_CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? null;
  if (!url) return null;
  const convex = new ConvexHttpClient(url);
  return {
    sitemapPage: (entity, cursor) =>
      convex.query(api.seo.sitemapPage, {
        entity,
        paginationOpts: { cursor, numItems: PAGE_SIZE },
      }),
    monthRange: () => convex.query(api.seo.sitemapMonthRange, {}),
  };
}

// ---------- XML composition (pure, unit-tested) ----------

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** W3C date (yyyy-mm-dd, UTC) for `lastmod`. */
export function lastmodDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function sitemapIndexXml(locs: string[]): string {
  const body = locs
    .map((loc) => `  <sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

export function urlsetXml(
  urls: Array<{ loc: string; lastmod?: string }>,
): string {
  const body = urls
    .map(
      (url) =>
        `  <url><loc>${xmlEscape(url.loc)}</loc>${
          url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""
        }</url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** The canonical path for one record-backed sitemap entry. */
export function entryPath(child: Exclude<SitemapChild, "months">, entry: SitemapEntry) {
  switch (child) {
    case "series":
      return seriesPath(entry.publicId ?? 0, entry.title);
    case "volumes":
      return volumePath(entry.publicId ?? 0, entry.title);
    case "editions":
      return editionPath(entry.publicId ?? 0, entry.title);
    case "bundles":
      return bundlePath(entry.publicId ?? 0, entry.title);
    case "publishers":
      return `/publisher/${entry.slug ?? ""}`;
  }
}

/** Every `/releases/{yyyy-mm}` between `from` and `to`, inclusive. */
export function monthPaths(range: { from: YearMonth; to: YearMonth } | null): string[] {
  if (!range) return [];
  const paths: string[] = [];
  let cursor = range.from;
  while (
    paths.length < MAX_MONTHS &&
    (cursor.year < range.to.year ||
      (cursor.year === range.to.year && cursor.month <= range.to.month))
  ) {
    paths.push(`/releases/${monthParam(cursor)}`);
    cursor = addMonths(cursor, 1);
  }
  return paths;
}

// ---------- responses ----------

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
    },
  });
}

/**
 * robots.txt: the catalog is fully crawlable — never-indexed pages carry
 * meta robots noindex, which crawlers must be able to fetch to honor
 * (`/u/{username}` included, once profiles exist). Only the pure-app,
 * auth-gated surfaces are disallowed outright.
 */
export function robotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Disallow: /me",
    "Disallow: /mod",
    "Disallow: /claim-username",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

async function childSitemapXml(
  child: SitemapChild,
  origin: string,
  data: SitemapData | null,
): Promise<string> {
  // No Convex deployment configured: valid, empty sitemaps keep local and
  // preview builds serving 200s.
  if (!data) return urlsetXml([]);

  if (child === "months") {
    const paths = monthPaths(await data.monthRange());
    return urlsetXml(paths.map((path) => ({ loc: `${origin}${path}` })));
  }

  const entity = ENTITY_FOR_CHILD[child];
  const urls: Array<{ loc: string; lastmod: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await data.sitemapPage(entity, cursor);
    for (const entry of page.entries) {
      if (urls.length >= MAX_URLS) break;
      urls.push({
        loc: `${origin}${entryPath(child, entry)}`,
        lastmod: lastmodDate(entry.lastmod),
      });
    }
    if (page.isDone || urls.length >= MAX_URLS) break;
    cursor = page.continueCursor;
  }
  return urlsetXml(urls);
}

/**
 * Serve `/robots.txt`, `/sitemap.xml`, and `/sitemaps/{child}.xml`; null for
 * every other request so the Start handler takes over. All URLs are emitted
 * against the canonical origin (spec §11) regardless of the request host.
 */
export async function seoResponse(
  request: Request,
  data: SitemapData | null = convexSitemapData(),
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  const origin = siteOrigin();

  if (pathname === "/robots.txt") {
    return new Response(robotsTxt(origin), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": CACHE_CONTROL,
      },
    });
  }

  if (pathname === "/sitemap.xml") {
    return xmlResponse(
      sitemapIndexXml(
        SITEMAP_CHILDREN.map((child) => `${origin}/sitemaps/${child}.xml`),
      ),
    );
  }

  const match = /^\/sitemaps\/([a-z]+)\.xml$/.exec(pathname);
  const child = match && SITEMAP_CHILDREN.find((name) => name === match[1]);
  if (child) return xmlResponse(await childSitemapXml(child, origin, data));

  return null;
}
