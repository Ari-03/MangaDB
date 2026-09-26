// PRH parser tests (ticket #36). No live key exists, so the fixtures follow
// the documented Enhanced-API title shape (developer.penguinrandomhouse.com,
// Title resource: isbn, onsale, format, imprint, price…) with both the
// nested and flat field variants the parser tolerates.

import { describe, expect, it } from "vitest";
import { imprintPublisher } from "./catalogTitle";
import { parseOnsale, parseTitle, parseTitleList, prhScopeReason } from "./prh";

const TITLE = {
  isbn: 9781646094356,
  isbn10: "1646094350",
  title: "Witch Hat Atelier 15",
  seriesNumber: 15,
  author: "Kamome Shirahama",
  onsale: "2026-12-08",
  format: { code: "TR", description: "Trade Paperback" },
  imprint: { code: "KODCM", description: "Kodansha Comics" },
  price: [{ amount: 12.99, currencyCode: "USD" }],
  seoFriendlyUrl: "/books/830758/witch-hat-atelier-15-by-kamome-shirahama/",
};

// Real titles from the PRH snapshot; the shared parser (lib/bookTitle.ts)
// has its own exhaustive tests — these pin what the snapshot carries.
function parsed(title: string, seriesNumber?: number) {
  return parseTitle({
    isbn: "9781646094356",
    title,
    seriesNumber,
    imprint: "Kodansha Comics",
  });
}

describe("parseTitle — title splitting", () => {
  it("splits the publisher title styles into base series + label", () => {
    expect(parsed("Witch Hat Atelier 15", 15)).toMatchObject({
      seriesTitle: "Witch Hat Atelier",
      volumeLabel: "15",
      multiVolume: false,
    });
    expect(parsed("Chainsaw Man, Vol. 22", 22)).toMatchObject({
      seriesTitle: "Chainsaw Man",
      volumeLabel: "22",
    });
    expect(parsed("Alpi the Soul Sender Vol.5", 5)).toMatchObject({
      seriesTitle: "Alpi the Soul Sender",
      volumeLabel: "5",
    });
    expect(parsed("Otherside Picnic 05 (Manga)", 5)).toMatchObject({
      seriesTitle: "Otherside Picnic",
      volumeLabel: "5",
      bareNumber: true,
    });
  });

  it("carries packaging with its range and never a volume label", () => {
    expect(parsed("Noragami Omnibus 7 (Vol. 19-21)", 7)).toMatchObject({
      seriesTitle: "Noragami",
      volumeLabel: undefined,
      multiVolume: true,
      packaging: {
        lineName: "Omnibus",
        linePosition: "7",
        coverRange: { from: "19", to: "21" },
      },
    });
    expect(parsed("The Way of the Househusband, Vol. 1-3 (Omnibus)")).toMatchObject({
      seriesTitle: "The Way of the Househusband",
      multiVolume: true,
    });
    expect(parsed("Fire Force Manga Box Set 1 (Vol. 1-6)", 1)).toMatchObject({
      seriesTitle: "Fire Force",
      isBox: true,
    });
  });

  it("ignores a seriesNumber the title never shows (franchise ordinals)", () => {
    expect(parsed("orange -future-", 3)).toMatchObject({
      seriesTitle: "orange -future-",
      volumeLabel: undefined,
    });
  });
});

describe("parseTitle — scope gates", () => {
  it("denies the prose Vertical and coloring-book imprints but keeps Vertical Comics", () => {
    const entry = {
      isbn: "9781945054853",
      title: "The Seven Deadly Sins (Novel)",
    };
    expect(parseTitle({ ...entry, title: "Ring", imprint: "Vertical" })).toBeNull();
    expect(
      parseTitle({
        ...entry,
        title: "Attack on Titan Coloring Book",
        imprint: "Waves of Color",
      }),
    ).toBeNull();
    expect(
      parseTitle({
        ...entry,
        title: "Ajin: Demi-Human 1",
        seriesNumber: 1,
        imprint: "Vertical Comics",
      }),
    ).toMatchObject({
      seriesTitle: "Ajin: Demi-Human",
      imprint: "Vertical Comics",
    });
  });

  it("drops novels, merchandise, samplers, and non-English editions by title", () => {
    for (const title of [
      "Grandmaster of Demonic Cultivation: Mo Dao Zu Shi (Novel) Vol. 4",
      "Her Royal Highness Seems to Be Angry, Volume 3 (Light Novel)",
      "Cowboy Bebop - Playing Cards",
      "Official Frieren Advent Calendar",
      "Kodansha Manga Showcase 2024",
      "Lullaby of the Dawn, Booklet #2 (Convention Exclusive)",
      "La Bendición Del Oficial Del Cielo, Volumen 1 (Manhua) – Versión en Español",
    ]) {
      expect(parseTitle({ isbn: "9781646094356", title, imprint: "Seven Seas" }), title).toBeNull();
    }
  });

  // Live classification fields (imprint listings fetched 2026-09-25).
  const subjects = (...codes: string[]) => codes.map((code) => ({ code, description: code }));

  it("drops what PRH itself classifies as prose or, at TOKYOPOP, as a non-manga graphic novel", () => {
    const entry = {
      isbn: "9781506709390",
      imprint: { code: "KN", description: "Dark Horse Manga" },
    };
    expect(prhScopeReason({ ...entry, graphicCategory: "Light Novel" }, "Dark Horse Manga")).toBe(
      "novel",
    );
    expect(
      parseTitle({
        ...entry,
        title: "Berserk: The Flame Dragon Knight",
        graphicCategory: "Light Novel",
      }),
    ).toBeNull();
    expect(prhScopeReason({ subjects: subjects("FIC015000", "FIC108000") }, "TOKYOPOP")).toBe(
      "prose",
    );
    for (const title of ["Ballad of The Broken Heart, Volume 1", "ALIEN STAGE: The Art Book"]) {
      expect(
        parseTitle({
          isbn: "9781427884800",
          title,
          imprint: "TOKYOPOP",
          graphicCategory: "Graphic Novel",
        }),
        title,
      ).toBeNull();
    }
  });

  it("keeps manga whatever its origin or audience, and Graphic Novel outside TOKYOPOP", () => {
    // Titan Manga and Vertical Comics file real manga as "Graphic Novel".
    expect(
      parseTitle({
        isbn: "9781787744424",
        title: "Yan Vol.1",
        imprint: "Titan Manga",
        graphicCategory: "Graphic Novel",
      }),
    ).not.toBeNull();
    // Juvenile-only subjects are kids' manga, not a scope signal.
    expect(
      parseTitle({
        isbn: "9781427866783",
        title: "The Fox & Little Tanuki, Volume 1",
        imprint: "TOKYOPOP",
        graphicCategory: "Manga",
        subjects: subjects("JUV008050", "JUV008080"),
      }),
    ).not.toBeNull();
    // Manga-styled originals are manga (owner's scope rule): no origin gate.
    for (const title of [
      "Masters of the Universe: Legends of Eternia, Issue #2",
      "Emma & Capucine, Volume 3",
    ]) {
      expect(
        parseTitle({
          isbn: "9781427892331",
          title,
          imprint: "TOKYOPOP",
          graphicCategory: "Manga",
        }),
        title,
      ).not.toBeNull();
    }
  });
});

describe("parseTitle", () => {
  it("normalizes a nested-shape title", () => {
    const parsed = parseTitle(TITLE);
    expect(parsed).toMatchObject({
      kind: "prhTitle",
      isbn13: "9781646094356",
      isbn10: "1646094350",
      seriesTitle: "Witch Hat Atelier",
      volumeLabel: "15",
      onsale: { year: 2026, month: 12, day: 8 },
      format: "physical",
      binding: "paperback",
      imprint: "Kodansha Comics",
      priceCents: 1299,
      url: "https://www.penguinrandomhouse.com/books/830758/witch-hat-atelier-15-by-kamome-shirahama/",
    });
  });

  it("normalizes flat-shape fields, digital formats, and skips audio", () => {
    expect(
      parseTitle({
        isbn: "9781646094363",
        title: "Witch Hat Atelier 15",
        seriesNumber: 15,
        formatFamily: "Ebook",
        imprint: "Kodansha Comics",
        priceUsd: 10.99,
      }),
    ).toMatchObject({
      format: "digital",
      binding: undefined,
      priceCents: 1099,
    });
    expect(
      parseTitle({
        isbn: "9781646094370",
        title: "Witch Hat Atelier 15",
        format: { description: "Audiobook Download" },
      }),
    ).toBeNull();
    expect(parseTitle({ title: "No ISBN" })).toBeNull();
  });
});

describe("parseTitleList", () => {
  it("keeps the upstream page size when all entries are excluded", () => {
    expect(
      parseTitleList({
        data: { titles: [{ ...TITLE, title: "A Light Novel" }] },
      }),
    ).toMatchObject({ titles: [], rawCount: 1 });
  });

  it.each([
    null,
    {},
    { error: "unauthorized" },
    { recordCount: 5, data: {} },
    { recordCount: 3, data: { titles: null } },
    { data: { titles: "nope" } },
  ])("rejects malformed and truncated envelopes: %j", (raw) =>
    expect(() => parseTitleList(raw)).toThrow("titles array"),
  );

  // The real empty-imprint envelope is unverified (live probe was a 403), so
  // a missing titles array reads as an empty page whenever no records are
  // reported.
  it.each([
    { recordCount: 0 },
    { recordCount: 0, data: {} },
    { data: { recordCount: 0, titles: null } },
    { data: {} },
    { data: { titles: null } },
  ])("tolerates a zero-record envelope without titles: %j", (raw) =>
    expect(parseTitleList(raw)).toMatchObject({ titles: [], rawCount: 0 }),
  );

  it("reads the data.titles envelope with recordCount", () => {
    const { titles, recordCount } = parseTitleList({
      recordCount: 812,
      data: { titles: [TITLE, { junk: true }] },
    });
    expect(titles).toHaveLength(1);
    expect(recordCount).toBe(812);
  });
});

describe("imprintPublisher", () => {
  it("resolves duplicate strings to the company and imprints to their own row", () => {
    expect(imprintPublisher("Kodansha Comics")).toEqual({
      name: "Kodansha",
      slug: "kodansha",
    });
    expect(imprintPublisher("Square Enix Manga")).toMatchObject({
      slug: "square-enix",
    });
    expect(imprintPublisher("Ghost Ship")).toEqual({
      name: "Ghost Ship",
      slug: "ghost-ship",
      parentSlug: "seven-seas",
    });
    expect(imprintPublisher("Vertical Comics")).toMatchObject({
      slug: "vertical",
    });
  });

  it("slugs an unknown imprint description", () => {
    expect(imprintPublisher("Brand New Manga")).toEqual({
      name: "Brand New Manga",
      slug: "brand-new-manga",
    });
  });
});

describe("parseOnsale", () => {
  it("reads bare and timestamped dates", () => {
    expect(parseOnsale("2026-12-08")).toEqual({
      year: 2026,
      month: 12,
      day: 8,
    });
    expect(parseOnsale("2026-12-08T00:00:00-05:00")).toEqual({
      year: 2026,
      month: 12,
      day: 8,
    });
    expect(parseOnsale(null)).toBeUndefined();
  });
});
