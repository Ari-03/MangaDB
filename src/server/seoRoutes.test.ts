import { describe, expect, it } from "vitest";

import {
  lastmodDate,
  monthPaths,
  robotsTxt,
  seoResponse,
  sitemapIndexXml,
  urlsetXml,
  xmlEscape,
  type SitemapData,
} from "./seoRoutes";

const ORIGIN = "https://mangadb.org";

/** Two pages of series entries + a three-month release range. */
function fakeData(): SitemapData {
  const pages = new Map<string | null, {
    entries: Array<{ publicId: number | null; slug: string | null; title: string; lastmod: number }>;
    isDone: boolean;
    continueCursor: string;
  }>([
    [
      null,
      {
        entries: [
          { publicId: 1, slug: null, title: "Berserk", lastmod: Date.UTC(2026, 7, 1) },
        ],
        isDone: false,
        continueCursor: "page2",
      },
    ],
    [
      "page2",
      {
        entries: [
          { publicId: 2, slug: null, title: "Fullmetal Alchemist", lastmod: Date.UTC(2026, 7, 2) },
        ],
        isDone: true,
        continueCursor: "",
      },
    ],
  ]);
  return {
    sitemapPage: async (_entity, cursor) => pages.get(cursor)!,
    monthRange: async () => ({
      from: { year: 2026, month: 11 },
      to: { year: 2027, month: 1 },
    }),
  };
}

describe("XML builders", () => {
  it("escapes XML-significant characters", () => {
    expect(xmlEscape(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
  });

  it("renders a sitemap index of child locs", () => {
    const xml = sitemapIndexXml([`${ORIGIN}/sitemaps/series.xml`]);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain(`<sitemap><loc>${ORIGIN}/sitemaps/series.xml</loc></sitemap>`);
  });

  it("renders a urlset with optional lastmod", () => {
    const xml = urlsetXml([
      { loc: `${ORIGIN}/series/1/berserk`, lastmod: "2026-08-01" },
      { loc: `${ORIGIN}/releases/2026-08` },
    ]);
    expect(xml).toContain(
      `<url><loc>${ORIGIN}/series/1/berserk</loc><lastmod>2026-08-01</lastmod></url>`,
    );
    expect(xml).toContain(`<url><loc>${ORIGIN}/releases/2026-08</loc></url>`);
  });

  it("formats lastmod as a UTC W3C date", () => {
    expect(lastmodDate(Date.UTC(2026, 7, 19, 23, 59))).toBe("2026-08-19");
  });

  it("enumerates month paths across a year boundary, inclusive", () => {
    expect(
      monthPaths({ from: { year: 2026, month: 11 }, to: { year: 2027, month: 1 } }),
    ).toEqual(["/releases/2026-11", "/releases/2026-12", "/releases/2027-01"]);
    expect(monthPaths(null)).toEqual([]);
  });
});

describe("robotsTxt", () => {
  it("keeps the catalog crawlable, blocks app surfaces, and links the sitemap", () => {
    const txt = robotsTxt(ORIGIN);
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Disallow: /me");
    expect(txt).toContain("Disallow: /mod");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    // Catalog pages and noindex-carrying pages stay fetchable.
    expect(txt).not.toContain("Disallow: /series");
    expect(txt).not.toContain("Disallow: /search");
  });
});

describe("seoResponse", () => {
  it("serves the sitemap index listing every per-entity child (spec §11)", async () => {
    const res = await seoResponse(new Request(`${ORIGIN}/sitemap.xml`), fakeData());
    expect(res?.headers.get("Content-Type")).toContain("application/xml");
    expect(res?.headers.get("Cache-Control")).toContain("max-age");
    const xml = await res!.text();
    for (const child of ["series", "volumes", "editions", "publishers", "bundles", "months"]) {
      expect(xml).toContain(`${ORIGIN}/sitemaps/${child}.xml`);
    }
  });

  it("serves a child sitemap of canonical URLs with Revision-driven lastmod, following pagination", async () => {
    const res = await seoResponse(
      new Request(`${ORIGIN}/sitemaps/series.xml`),
      fakeData(),
    );
    const xml = await res!.text();
    expect(xml).toContain(
      `<url><loc>${ORIGIN}/series/1/berserk</loc><lastmod>2026-08-01</lastmod></url>`,
    );
    expect(xml).toContain(
      `<url><loc>${ORIGIN}/series/2/fullmetal-alchemist</loc><lastmod>2026-08-02</lastmod></url>`,
    );
  });

  it("serves the month child from the dated-Release range, without lastmod", async () => {
    const res = await seoResponse(
      new Request(`${ORIGIN}/sitemaps/months.xml`),
      fakeData(),
    );
    const xml = await res!.text();
    expect(xml).toContain(`<url><loc>${ORIGIN}/releases/2026-12</loc></url>`);
    expect(xml).not.toContain("lastmod");
  });

  it("serves robots.txt", async () => {
    const res = await seoResponse(new Request(`${ORIGIN}/robots.txt`), fakeData());
    expect(res?.headers.get("Content-Type")).toContain("text/plain");
    expect(await res!.text()).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("serves valid empty sitemaps when Convex is not configured", async () => {
    const res = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), null);
    expect(await res!.text()).toContain("<urlset");
  });

  it("passes every other request through to the app", async () => {
    expect(await seoResponse(new Request(`${ORIGIN}/series/1/berserk`), fakeData())).toBeNull();
    expect(await seoResponse(new Request(`${ORIGIN}/sitemaps/nope.xml`), fakeData())).toBeNull();
    expect(
      await seoResponse(new Request(`${ORIGIN}/sitemap.xml`, { method: "POST" }), fakeData()),
    ).toBeNull();
  });
});
