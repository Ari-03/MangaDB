import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SitemapData } from "./seoRoutes";
import { stubBrokenEdgeCache, stubEdgeCache } from "./test.cache";

// `waitUntil` collects the background cache writes.
const background = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => void background.push(promise),
}));
const { lastmodDate, monthPaths, robotsTxt, seoResponse, sitemapIndexXml, urlsetXml, xmlEscape } =
  await import("./seoRoutes");

let cached: Map<string, Response>;
beforeEach(() => {
  cached = stubEdgeCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  background.length = 0;
});

const ORIGIN = "https://mangadb.org";

/** Two pages of series entries + a three-month release range. */
function fakeData(): SitemapData {
  const pages = new Map<
    string | null,
    {
      entries: Array<{
        publicId: number | null;
        slug: string | null;
        title: string;
        lastmod: number;
      }>;
      isDone: boolean;
      continueCursor: string;
    }
  >([
    [
      null,
      {
        entries: [{ publicId: 1, slug: null, title: "Berserk", lastmod: Date.UTC(2026, 7, 1) }],
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
    expect(monthPaths({ from: { year: 2026, month: 11 }, to: { year: 2027, month: 1 } })).toEqual([
      "/releases/2026-11",
      "/releases/2026-12",
      "/releases/2027-01",
    ]);
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
    const res = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), fakeData());
    const xml = await res!.text();
    expect(xml).toContain(
      `<url><loc>${ORIGIN}/series/1/berserk</loc><lastmod>2026-08-01</lastmod></url>`,
    );
    expect(xml).toContain(
      `<url><loc>${ORIGIN}/series/2/fullmetal-alchemist</loc><lastmod>2026-08-02</lastmod></url>`,
    );
  });

  it("serves the month child from the dated-Release range, without lastmod", async () => {
    const res = await seoResponse(new Request(`${ORIGIN}/sitemaps/months.xml`), fakeData());
    const xml = await res!.text();
    expect(xml).toContain(`<url><loc>${ORIGIN}/releases/2026-12</loc></url>`);
    expect(xml).not.toContain("lastmod");
  });

  it("serves robots.txt", async () => {
    const res = await seoResponse(new Request(`${ORIGIN}/robots.txt`), fakeData());
    expect(res?.headers.get("Content-Type")).toContain("text/plain");
    expect(await res!.text()).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("passes every other request through to the app", async () => {
    expect(await seoResponse(new Request(`${ORIGIN}/series/1/berserk`), fakeData())).toBeNull();
    expect(await seoResponse(new Request(`${ORIGIN}/sitemaps/nope.xml`), fakeData())).toBeNull();
    expect(
      await seoResponse(new Request(`${ORIGIN}/sitemap.xml`, { method: "POST" }), fakeData()),
    ).toBeNull();
  });

  it("needs the Convex URL only for a child sitemap", async () => {
    vi.stubEnv("VITE_CONVEX_URL", undefined);
    expect(await seoResponse(new Request(`${ORIGIN}/series/1/berserk`))).toBeNull();
    expect((await seoResponse(new Request(`${ORIGIN}/robots.txt`)))?.status).toBe(200);
    expect((await seoResponse(new Request(`${ORIGIN}/sitemap.xml`)))?.status).toBe(200);
    await expect(seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`))).rejects.toThrow(
      "VITE_CONVEX_URL is not set",
    );
  });

  it("generates a child sitemap once and serves repeats from the edge cache", async () => {
    const data = fakeData();
    const sitemapPage = vi.spyOn(data, "sitemapPage");
    const first = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), data);
    await Promise.all(background);
    // A HEAD and a query-string variant hit the same GET-keyed entry.
    const head = await seoResponse(
      new Request(`${ORIGIN}/sitemaps/series.xml`, { method: "HEAD" }),
      data,
    );
    const again = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml?x=1`), data);
    expect(sitemapPage).toHaveBeenCalledTimes(2); // the two pages, read once
    expect(head?.status).toBe(200);
    expect(await again!.text()).toBe(await first!.text());
    expect([...cached.keys()]).toEqual([`${ORIGIN}/sitemaps/series.xml`]);
  });

  it("caches a sitemap generated for a HEAD request under the GET key", async () => {
    const data = fakeData();
    const sitemapPage = vi.spyOn(data, "sitemapPage");
    await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`, { method: "HEAD" }), data);
    await Promise.all(background);
    await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), data);
    expect(sitemapPage).toHaveBeenCalledTimes(2);
  });

  it("still serves the sitemap when the cache read fails", async () => {
    stubBrokenEdgeCache("read");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), fakeData());
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain("<urlset");
    errors.mockRestore();
    await Promise.all(background);
  });

  it("still serves the sitemap when the cache write fails", async () => {
    stubBrokenEdgeCache("write");
    const res = await seoResponse(new Request(`${ORIGIN}/sitemaps/series.xml`), fakeData());
    expect(res?.status).toBe(200);
    await Promise.all(background);
  });
});
