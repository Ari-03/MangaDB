// Seven Seas parser tests (ticket #34): fixtures are trimmed copies of the
// live wire formats captured 2026-08-19 — one `wp/v2/books` item and the
// `#volume-meta` block of a book page — so the parsers are exercised against
// exactly what the site serves, without touching the network.

import { describe, expect, it } from "vitest";

import {
  decodeEntities,
  isMangaBook,
  normalizeBook,
  parseBookListing,
  parseBookPage,
  parseUsDate,
  stripHtml,
} from "./sevenSeas";

// Verbatim (trimmed) item from GET /wp-json/wp/v2/books?per_page=2.
const LISTING_FIXTURE = {
  id: 32817,
  date_gmt: "2026-08-14T05:38:51",
  modified_gmt: "2026-08-18T00:31:08",
  slug: "betrothed-to-my-sisters-ex-manga-vol-6",
  status: "publish",
  type: "books",
  link: "https://sevenseasentertainment.com/books/betrothed-to-my-sisters-ex-manga-vol-6/",
  title: { rendered: "Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6" },
  content: {
    rendered:
      '\n<p class="wp-block-paragraph"><strong>WALKING NEW PATHS</strong></p>\n<p class="wp-block-paragraph">Through a series of twists and turns, Marie and her sister Anastasia have been reunited.</p>\n',
    protected: false,
  },
};

// Verbatim (trimmed) fragment of the same book's page.
const PAGE_FIXTURE = `
<div id="volume-module"><img src="https://sevenseasentertainment.com/wp-content/uploads/2026/08/betrothed_sisters_ex_M6_site.jpg" title="Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6" alt="Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6"> </br><div class="age-rating" id="teen"></div></div><div id="volume-meta"> <b>Series: </b><span style="font-size: 16px; font-weight: bold;"> <a href="https://sevenseasentertainment.com/series/betrothed-to-my-sisters-ex-manga/">Betrothed to My Sister&#8217;s Ex (Manga)</a></span><p><b>Story & Art by:</b> <span class="creator"><a href="https://sevenseasentertainment.com/creator/tobirano/">Tobirano</a></span> <span class="creator"><a href="https://sevenseasentertainment.com/creator/chikage-nakakura/">Chikage Nakakura</a></span></p> </br><p><b>Release Date:</b> April 13, 2027</p><p><b>Price:</b> $13.99</p><p><b>Format:</b> Manga</p><p><b>Trim:</b> 5 x 7.125in</p><p><b>Page Count:</b> 160</p><p><b>ISBN:</b> 979-8-89765-592-2</p></div>`;

describe("text plumbing", () => {
  it("decodes WordPress entities", () => {
    expect(decodeEntities("Marie&#8217;s Ex &amp; Co &#038; more")).toBe("Marie’s Ex & Co & more");
  });

  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p><strong>A</strong>\n  B</p>")).toBe("A B");
  });
});

describe("parseBookListing", () => {
  it("parses the live listing shape", () => {
    const listing = parseBookListing(LISTING_FIXTURE);
    expect(listing).toMatchObject({
      sourceRecordId: "32817",
      slug: "betrothed-to-my-sisters-ex-manga-vol-6",
      url: "https://sevenseasentertainment.com/books/betrothed-to-my-sisters-ex-manga-vol-6/",
      title: "Betrothed to My Sister’s Ex (Manga) Vol. 6",
      modifiedGmt: "2026-08-18T00:31:08",
    });
    expect(listing?.description).toContain("WALKING NEW PATHS");
  });

  it("rejects malformed and unpublished items", () => {
    expect(parseBookListing(null)).toBeNull();
    expect(parseBookListing({})).toBeNull();
    expect(parseBookListing({ ...LISTING_FIXTURE, status: "draft" })).toBeNull();
    expect(parseBookListing({ ...LISTING_FIXTURE, title: {} })).toBeNull();
  });
});

describe("parseBookPage", () => {
  it("extracts the volume-meta facts from the live page shape", () => {
    const page = parseBookPage(PAGE_FIXTURE);
    expect(page).toMatchObject({
      seriesTitle: "Betrothed to My Sister’s Ex (Manga)",
      seriesSlug: "betrothed-to-my-sisters-ex-manga",
      seriesUrl: "https://sevenseasentertainment.com/series/betrothed-to-my-sisters-ex-manga/",
      creators: ["Tobirano", "Chikage Nakakura"],
      releaseDate: { year: 2027, month: 4, day: 13 },
      priceCents: 1399,
      currency: "USD",
      category: "Manga",
      isbn13: "9798897655922",
      coverUrl:
        "https://sevenseasentertainment.com/wp-content/uploads/2026/08/betrothed_sisters_ex_M6_site.jpg",
    });
  });

  it("yields a partial result for a recognized partial book page", () => {
    const page = parseBookPage('<div id="volume-meta"></div>');
    expect(page.seriesTitle).toBeUndefined();
    expect(page.releaseDate).toBeUndefined();
    expect(page.isbn13).toBeUndefined();
    expect(page.creators).toEqual([]);
  });

  it("rejects successful HTTP error pages instead of importing empty facts", () => {
    expect(() => parseBookPage("<html>Just a moment...</html>")).toThrow("volume-meta");
    expect(() => parseBookPage("<html>Page not found</html>")).toThrow("volume-meta");
  });
});

describe("parseUsDate", () => {
  it("parses month-name dates", () => {
    expect(parseUsDate("April 13, 2027")).toEqual({
      year: 2027,
      month: 4,
      day: 13,
    });
    expect(parseUsDate("nonsense")).toBeUndefined();
    expect(parseUsDate("Smarch 3, 2027")).toBeUndefined();
  });

  it("rejects impossible dates without losing leap days", () => {
    expect(parseUsDate("February 29, 2027")).toBeUndefined();
    expect(parseUsDate("April 31, 2027")).toBeUndefined();
    expect(parseUsDate("February 29, 2028")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });
});

// Title splitting is the shared parser (lib/bookTitle.ts); these pin what
// normalizeBook stores for Seven Seas' own title styles.
function snapshotFor(title: string) {
  const listing = parseBookListing({
    ...LISTING_FIXTURE,
    title: { rendered: title },
  })!;
  return normalizeBook(listing, { creators: [] });
}

describe("normalizeBook — title splitting", () => {
  it("drops the publisher's (Manga) discriminator from the series title", () => {
    expect(snapshotFor("Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6")).toMatchObject({
      seriesTitle: "Betrothed to My Sister’s Ex",
      volumeLabel: "6",
    });
    expect(snapshotFor("A Story Vol. 7.5")).toMatchObject({
      seriesTitle: "A Story",
      volumeLabel: "7.5",
    });
  });

  it("maps omnibus ranges to packaging and passes oneshots through", () => {
    expect(snapshotFor("Tokyo Revengers (Omnibus) Vol. 23-24")).toMatchObject({
      seriesTitle: "Tokyo Revengers",
      volumeLabel: undefined,
      packaging: { lineName: "Omnibus", coverRange: { from: "23", to: "24" } },
    });
    expect(
      snapshotFor("Monster Musume: Deluxe Edition 1 (Vol. 1-3 Hardcover Omnibus)"),
    ).toMatchObject({
      seriesTitle: "Monster Musume",
      packaging: { lineName: "Deluxe Edition", linePosition: "1" },
    });
    expect(snapshotFor("One Rainy Evening")).toMatchObject({
      seriesTitle: "One Rainy Evening",
      volumeLabel: undefined,
      packaging: undefined,
    });
  });
});

describe("isMangaBook", () => {
  it("decides on the Format line when present", () => {
    expect(isMangaBook({ category: "Manga", title: "X (Light Novel) Vol. 1" })).toBe(true);
    expect(isMangaBook({ category: "Light Novel", title: "X Vol. 1" })).toBe(false);
    expect(isMangaBook({ category: "Audiobook", title: "X Vol. 1" })).toBe(false);
  });

  it("treats every novel category as prose, but not graphic novels", () => {
    expect(isMangaBook({ category: "Novel", title: "X Vol. 1" })).toBe(false);
    expect(isMangaBook({ category: "Deluxe Hardcover Novel", title: "X Vol. 1" })).toBe(false);
    expect(isMangaBook({ category: "Graphic Novel", title: "X Vol. 1" })).toBe(true);
  });

  it("falls back to the title discriminator", () => {
    expect(isMangaBook({ title: "X (Light Novel) Vol. 10" })).toBe(false);
    expect(isMangaBook({ title: "Little Mushroom (Deluxe Hardcover Novel) Vol. 2" })).toBe(false);
    expect(isMangaBook({ title: "Anne of Green Gables (Illustrated Novel)" })).toBe(false);
    expect(isMangaBook({ title: "X (Manga) Vol. 10" })).toBe(true);
    expect(isMangaBook({ title: "A Novel Concept (Manga) Vol. 1" })).toBe(true);
    expect(isMangaBook({ title: "Plain Title Vol. 2" })).toBe(true);
  });
});

describe("normalizeBook", () => {
  it("merges listing + page into the observation snapshot", () => {
    const listing = parseBookListing(LISTING_FIXTURE)!;
    const snapshot = normalizeBook(listing, parseBookPage(PAGE_FIXTURE));
    expect(snapshot).toMatchObject({
      kind: "book",
      url: listing.url,
      title: "Betrothed to My Sister’s Ex (Manga) Vol. 6",
      modifiedGmt: "2026-08-18T00:31:08",
      seriesTitle: "Betrothed to My Sister’s Ex",
      seriesSlug: "betrothed-to-my-sisters-ex-manga",
      volumeLabel: "6",
      binding: "paperback",
      releaseDate: { year: 2027, month: 4, day: 13 },
      priceCents: 1399,
      isbn13: "9798897655922",
    });
  });

  it("detects hardcover editions and survives a missing page", () => {
    const listing = parseBookListing({
      ...LISTING_FIXTURE,
      title: { rendered: "Big Series Deluxe Hardcover Vol. 1" },
    })!;
    const snapshot = normalizeBook(listing, { creators: [] });
    expect(snapshot.binding).toBe("hardcover");
    // No series block on the page → the title-derived series and the book
    // slug stand in, so the snapshot still has a usable identity.
    expect(snapshot.seriesTitle).toBe("Big Series");
    expect(snapshot.packaging).toMatchObject({
      lineName: "Deluxe",
      linePosition: "1",
    });
    expect(snapshot.seriesSlug).toBe(listing.slug);
  });
});
