// PRH parser tests (ticket #36). No live key exists, so the fixtures follow
// the documented Enhanced-API title shape (developer.penguinrandomhouse.com,
// Title resource: isbn, onsale, format, imprint, price…) with both the
// nested and flat field variants the parser tolerates.

import { describe, expect, it } from "vitest";
import {
  imprintPublisher,
  parseOnsale,
  parseTitle,
  parseTitleList,
  splitPrhTitle,
} from "./prh";

const TITLE = {
  isbn: 9781646094356,
  isbn10: "1646094350",
  title: "Witch Hat Atelier 15",
  author: "Kamome Shirahama",
  onsale: "2026-12-08",
  format: { code: "TR", description: "Trade Paperback" },
  imprint: { code: "KODCM", description: "Kodansha Comics" },
  price: [{ amount: 12.99, currencyCode: "USD" }],
  seoFriendlyUrl: "/books/830758/witch-hat-atelier-15-by-kamome-shirahama/",
};

describe("splitPrhTitle", () => {
  it("handles the publisher title styles", () => {
    expect(splitPrhTitle("Witch Hat Atelier 15")).toEqual({
      seriesTitle: "Witch Hat Atelier",
      volumeLabel: "15",
      multiVolume: false,
    });
    expect(splitPrhTitle("Chainsaw Man, Vol. 22")).toEqual({
      seriesTitle: "Chainsaw Man",
      volumeLabel: "22",
      multiVolume: false,
    });
    expect(splitPrhTitle("Berserk Volume 41")).toMatchObject({
      seriesTitle: "Berserk",
      volumeLabel: "41",
    });
    expect(
      splitPrhTitle("The Way of the Househusband, Vol. 1-3 (Omnibus)"),
    ).toMatchObject({ seriesTitle: "The Way of the Househusband", multiVolume: true });
  });

  it("prefers an explicit seriesNumber and leaves plain titles whole", () => {
    expect(splitPrhTitle("A Standalone Book", 4)).toMatchObject({
      seriesTitle: "A Standalone Book",
      volumeLabel: "4",
    });
    expect(splitPrhTitle("A Standalone Book")).toEqual({
      seriesTitle: "A Standalone Book",
      multiVolume: false,
      volumeLabel: undefined,
    });
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
        formatFamily: "Ebook",
        imprint: "Kodansha Comics",
        priceUsd: 10.99,
      }),
    ).toMatchObject({ format: "digital", binding: undefined, priceCents: 1099 });
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
  it("slugs the imprint description", () => {
    expect(imprintPublisher("Kodansha Comics")).toEqual({
      name: "Kodansha Comics",
      slug: "kodansha-comics",
    });
  });
});

describe("parseOnsale", () => {
  it("reads bare and timestamped dates", () => {
    expect(parseOnsale("2026-12-08")).toEqual({ year: 2026, month: 12, day: 8 });
    expect(parseOnsale("2026-12-08T00:00:00-05:00")).toEqual({
      year: 2026,
      month: 12,
      day: 8,
    });
    expect(parseOnsale(null)).toBeUndefined();
  });
});
