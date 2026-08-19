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
  splitBookTitle,
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
    expect(decodeEntities("Marie&#8217;s Ex &amp; Co &#038; more")).toBe(
      "Marie’s Ex & Co & more",
    );
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
      seriesUrl:
        "https://sevenseasentertainment.com/series/betrothed-to-my-sisters-ex-manga/",
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

  it("yields a partial result for a partial page", () => {
    const page = parseBookPage("<div>nothing useful</div>");
    expect(page.seriesTitle).toBeUndefined();
    expect(page.releaseDate).toBeUndefined();
    expect(page.isbn13).toBeUndefined();
    expect(page.creators).toEqual([]);
  });
});

describe("parseUsDate", () => {
  it("parses month-name dates", () => {
    expect(parseUsDate("April 13, 2027")).toEqual({ year: 2027, month: 4, day: 13 });
    expect(parseUsDate("nonsense")).toBeUndefined();
    expect(parseUsDate("Smarch 3, 2027")).toBeUndefined();
  });
});

describe("splitBookTitle", () => {
  it("splits series and label, keeping the publisher's discriminator", () => {
    expect(splitBookTitle("Betrothed to My Sister’s Ex (Manga) Vol. 6")).toEqual({
      seriesTitle: "Betrothed to My Sister’s Ex (Manga)",
      volumeLabel: "6",
    });
    expect(splitBookTitle("A Story Vol. 7.5")).toEqual({
      seriesTitle: "A Story",
      volumeLabel: "7.5",
    });
  });

  it("normalizes omnibus ranges and passes oneshots through", () => {
    expect(splitBookTitle("Big Series (Omnibus) Vols. 1-3")).toEqual({
      seriesTitle: "Big Series (Omnibus)",
      volumeLabel: "1–3",
    });
    expect(splitBookTitle("One Rainy Evening")).toEqual({
      seriesTitle: "One Rainy Evening",
    });
  });
});

describe("isMangaBook", () => {
  it("decides on the Format line when present", () => {
    expect(isMangaBook({ category: "Manga", title: "X (Light Novel) Vol. 1" })).toBe(
      true,
    );
    expect(isMangaBook({ category: "Light Novel", title: "X Vol. 1" })).toBe(false);
    expect(isMangaBook({ category: "Audiobook", title: "X Vol. 1" })).toBe(false);
  });

  it("falls back to the title discriminator", () => {
    expect(isMangaBook({ title: "X (Light Novel) Vol. 10" })).toBe(false);
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
      seriesTitle: "Betrothed to My Sister’s Ex (Manga)",
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
    const snapshot = normalizeBook(listing, parseBookPage(""));
    expect(snapshot.binding).toBe("hardcover");
    // No series block on the page → the title-derived series and the book
    // slug stand in, so the snapshot still has a usable identity.
    expect(snapshot.seriesTitle).toBe("Big Series Deluxe Hardcover");
    expect(snapshot.seriesSlug).toBe(listing.slug);
  });
});
