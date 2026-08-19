import { describe, expect, it } from "vitest";

import {
  bookJsonLd,
  bookSeriesJsonLd,
  breadcrumbListJsonLd,
  bundleTitleTag,
  editionTitleTag,
  isoPartialDate,
  itemListJsonLd,
  jsonLdScript,
  monthTitleTag,
  organizationJsonLd,
  pageHead,
  publisherTitleTag,
  schemaBookFormat,
  seriesTitleTag,
  truncateDescription,
  volumeTitleTag,
} from "./seo";

// VITE_SITE_URL is unset in tests, so every absolute URL uses the canonical
// apex (spec §11).
const ORIGIN = "https://mangadb.org";

describe("title templates (issue #19 formulas)", () => {
  it("renders each page type's template", () => {
    expect(seriesTitleTag("Berserk")).toBe(
      "Berserk – English Manga Volumes & Release Dates | MangaDB",
    );
    expect(volumeTitleTag("Berserk", "12")).toBe(
      "Berserk Vol. 12 – English Editions & Release Dates | MangaDB",
    );
    expect(editionTitleTag("Berserk Deluxe Edition 1", "Dark Horse")).toBe(
      "Berserk Deluxe Edition 1 (Dark Horse) – ISBN & Release Date | MangaDB",
    );
    expect(bundleTitleTag("Berserk Box Set", "Dark Horse")).toBe(
      "Berserk Box Set (Dark Horse) – Box Set ISBN & Release Date | MangaDB",
    );
    expect(publisherTitleTag("VIZ Media")).toBe(
      "VIZ Media – Manga Releases & Upcoming Books | MangaDB",
    );
    expect(monthTitleTag("August 2026")).toBe(
      "English Manga Releases – August 2026 | MangaDB",
    );
  });

  it("titles an unlabeled oneshot Volume without a Vol. segment", () => {
    expect(volumeTitleTag("Goodbye, Eri", null)).toBe(
      "Goodbye, Eri – English Editions & Release Dates | MangaDB",
    );
  });

  it("omits the publisher parenthetical when unknown", () => {
    expect(editionTitleTag("Berserk Vol 1", null)).toBe(
      "Berserk Vol 1 – ISBN & Release Date | MangaDB",
    );
  });
});

describe("truncateDescription", () => {
  it("returns short text unchanged", () => {
    expect(truncateDescription("A short synopsis.")).toBe("A short synopsis.");
  });

  it("cuts at a word boundary with an ellipsis and collapses whitespace", () => {
    const long = `${"word ".repeat(60)}end`;
    const cut = truncateDescription(long);
    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("  ");
    expect(truncateDescription("a\n b\t c")).toBe("a b c");
  });
});

describe("pageHead", () => {
  it("emits title, description, canonical, and the OG/Twitter card", () => {
    const head = pageHead({
      title: "T",
      description: "D",
      path: "/series/1/berserk",
      image: "https://files.example/cover.jpg",
    });
    expect(head.links).toEqual([
      { rel: "canonical", href: `${ORIGIN}/series/1/berserk` },
    ]);
    const byKey = new Map(
      head.meta.map((m) => [m.name ?? m.property ?? "title", m]),
    );
    expect(head.meta[0]).toEqual({ title: "T" });
    expect(byKey.get("og:url")?.content).toBe(`${ORIGIN}/series/1/berserk`);
    expect(byKey.get("og:image")?.content).toBe("https://files.example/cover.jpg");
    // Cover-led card (spec §11): a cover upgrades to the large-image card.
    expect(byKey.get("twitter:card")?.content).toBe("summary_large_image");
    expect(byKey.get("twitter:image")?.content).toBe(
      "https://files.example/cover.jpg",
    );
    expect(byKey.get("robots")).toBeUndefined();
  });

  it("falls back to a plain summary card without a cover and emits robots", () => {
    const head = pageHead({
      title: "T",
      description: "D",
      path: "/releases",
      robots: "noindex, follow",
    });
    const byKey = new Map(head.meta.map((m) => [m.name ?? m.property, m]));
    expect(byKey.get("twitter:card")?.content).toBe("summary");
    expect(byKey.get("og:image")).toBeUndefined();
    expect(byKey.get("robots")?.content).toBe("noindex, follow");
    // The canonical still points at the unfiltered URL (spec §11).
    expect(head.links[0]?.href).toBe(`${ORIGIN}/releases`);
  });
});

describe("JSON-LD builders", () => {
  it("jsonLdScript serializes into a ld+json script entry", () => {
    const script = jsonLdScript({ "@type": "Thing" });
    expect(script.type).toBe("application/ld+json");
    expect(JSON.parse(script.children)).toEqual({ "@type": "Thing" });
  });

  it("BreadcrumbList numbers positions and links all but the last crumb", () => {
    const data = breadcrumbListJsonLd([
      { name: "MangaDB", path: "/" },
      { name: "Berserk", path: "/series/1/berserk" },
      { name: "Berserk Vol 12" },
    ]);
    expect(data["@type"]).toBe("BreadcrumbList");
    expect(data.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "MangaDB", item: `${ORIGIN}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: "Berserk",
        item: `${ORIGIN}/series/1/berserk`,
      },
      { "@type": "ListItem", position: 3, name: "Berserk Vol 12" },
    ]);
  });

  it("BookSeries carries alternate titles only when present", () => {
    expect(
      bookSeriesJsonLd({ title: "Berserk", altTitles: ["Beruseruku"], path: "/series/1/berserk" }),
    ).toMatchObject({
      "@type": "BookSeries",
      name: "Berserk",
      alternateName: ["Beruseruku"],
      url: `${ORIGIN}/series/1/berserk`,
    });
    expect(
      bookSeriesJsonLd({ title: "Berserk", altTitles: [], path: "/series/1/berserk" }),
    ).not.toHaveProperty("alternateName");
  });

  it("Organization names the publisher at its canonical URL", () => {
    expect(
      organizationJsonLd({ name: "VIZ Media", path: "/publisher/viz-media" }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "VIZ Media",
      url: `${ORIGIN}/publisher/viz-media`,
    });
  });

  it("isoPartialDate renders every precision (spec §8 partial dates)", () => {
    expect(isoPartialDate({ year: 2026, month: 8, day: 4 })).toBe("2026-08-04");
    expect(isoPartialDate({ year: 2026, month: 8 })).toBe("2026-08");
    expect(isoPartialDate({ year: 2026 })).toBe("2026");
    expect(isoPartialDate(null)).toBeNull();
  });

  it("schemaBookFormat maps Format/Binding to schema.org types", () => {
    expect(schemaBookFormat("digital", null)).toBe("https://schema.org/EBook");
    expect(schemaBookFormat("physical", "hardcover")).toBe(
      "https://schema.org/Hardcover",
    );
    expect(schemaBookFormat("physical", "paperback")).toBe(
      "https://schema.org/Paperback",
    );
    expect(schemaBookFormat("physical", null)).toBe("https://schema.org/Paperback");
  });

  it("Book anchors on the Edition page and prefers ISBN-13", () => {
    const book = bookJsonLd({
      name: "Berserk Deluxe Edition 1",
      editionPath: "/edition/7/berserk-deluxe-edition-1",
      anchor: "9781506711980",
      format: "physical",
      binding: "hardcover",
      isbn13: "9781506711980",
      isbn10: "1506711987",
      pubDate: { year: 2019, month: 2, day: 26 },
      language: "en",
      publisherName: "Dark Horse",
      coverUrl: "https://files.example/cover.jpg",
    });
    expect(book).toEqual({
      "@context": "https://schema.org",
      "@type": "Book",
      name: "Berserk Deluxe Edition 1",
      url: `${ORIGIN}/edition/7/berserk-deluxe-edition-1#9781506711980`,
      bookFormat: "https://schema.org/Hardcover",
      inLanguage: "en",
      isbn: "9781506711980",
      datePublished: "2019-02-26",
      publisher: { "@type": "Organization", name: "Dark Horse" },
      image: "https://files.example/cover.jpg",
    });
  });

  it("Book omits absent facts entirely", () => {
    const book = bookJsonLd({
      name: "X",
      editionPath: "/edition/1/x",
      anchor: "abc",
      format: "digital",
      binding: null,
      isbn13: null,
      isbn10: null,
      pubDate: null,
      language: "en",
      publisherName: null,
    });
    expect(book).not.toHaveProperty("isbn");
    expect(book).not.toHaveProperty("datePublished");
    expect(book).not.toHaveProperty("publisher");
    expect(book).not.toHaveProperty("image");
  });

  it("ItemList numbers the month's releases at their Edition anchors", () => {
    const data = itemListJsonLd([
      { name: "Berserk Vol. 42", path: "/edition/7/berserk-vol-42", anchor: "9781234567890" },
      { name: "Frieren Vol. 12", path: "/edition/9/frieren-vol-12" },
    ]);
    expect(data.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Berserk Vol. 42",
        url: `${ORIGIN}/edition/7/berserk-vol-42#9781234567890`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Frieren Vol. 12",
        url: `${ORIGIN}/edition/9/frieren-vol-12`,
      },
    ]);
  });
});
