// OpenLibrary dump parser tests (ticket #36) against the documented dump
// line format (type\tkey\trevision\tlast_modified\tjson) and the messy
// publish_date / title styles OL actually contains.

import { describe, expect, it } from "vitest";
import {
  isbn10To13,
  isbnPair,
  isEnglishEdition,
  parseDumpLine,
  parseEditionJson,
  parseOlDate,
  toIsbn13,
} from "./openLibrary";

const EDITION = {
  key: "/books/OL51694024M",
  title: "Chainsaw Man, Vol. 22",
  publishers: ["VIZ Media LLC"],
  publish_date: "Oct 13, 2026",
  isbn_13: ["9781974766512"],
  isbn_10: ["1974766519"],
  physical_format: "paperback",
  languages: [{ key: "/languages/eng" }],
  works: [{ key: "/works/OL20086330W" }],
};

const dumpLine = (json: unknown) =>
  `/type/edition\t/books/OL51694024M\t3\t2026-08-01T00:00:00\t${JSON.stringify(json)}`;

describe("parseOlDate — precision preserved", () => {
  it("drops impossible days while retaining the valid month", () => {
    expect(parseOlDate("2026-02-31")).toEqual({ year: 2026, month: 2 });
    expect(parseOlDate("April 31, 2026")).toEqual({ year: 2026, month: 4 });
    expect(parseOlDate("Feb 29, 2024")).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    expect(parseOlDate("1900-02-29")).toEqual({ year: 1900, month: 2 });
    expect(parseOlDate("2000-02-29")).toEqual({
      year: 2000,
      month: 2,
      day: 29,
    });
  });
  it("parses OL's date styles at their own precision", () => {
    expect(parseOlDate("Oct 13, 2026")).toEqual({
      year: 2026,
      month: 10,
      day: 13,
    });
    expect(parseOlDate("October 2026")).toEqual({ year: 2026, month: 10 });
    expect(parseOlDate("2026-10-13")).toEqual({
      year: 2026,
      month: 10,
      day: 13,
    });
    expect(parseOlDate("2026-10")).toEqual({ year: 2026, month: 10 });
    expect(parseOlDate("2026")).toEqual({ year: 2026 });
    expect(parseOlDate("n.d.")).toBeUndefined();
  });
});

// Title splitting is the shared parser (lib/bookTitle.ts); these pin the
// OpenLibrary shapes it sees, including the separate subtitle field.
const titled = (title: string, subtitle?: string) =>
  parseEditionJson({ ...EDITION, title, subtitle });

describe("parseEditionJson — title splitting", () => {
  it("handles the common OL title styles", () => {
    expect(titled("Chainsaw Man, Vol. 22")).toMatchObject({
      seriesTitle: "Chainsaw Man",
      volumeLabel: "22",
    });
    expect(titled("Berserk Volume 41")).toMatchObject({
      seriesTitle: "Berserk",
      volumeLabel: "41",
    });
    expect(titled("One Piece #3")).toMatchObject({
      seriesTitle: "One Piece",
      volumeLabel: "3",
    });
    expect(titled("Frieren", "Vol. 5")).toMatchObject({
      seriesTitle: "Frieren",
      volumeLabel: "5",
    });
    expect(titled("Rising of the Shield Hero Volume 08")).toMatchObject({
      seriesTitle: "Rising of the Shield Hero",
      volumeLabel: "8",
    });
    // Bare trailing numbers are NOT labels for OL ("1984" is a title).
    expect(titled("1984")).toMatchObject({
      seriesTitle: "1984",
      multiVolume: false,
    });
    expect(titled("Naruto, Vol. 1-3")).toMatchObject({ multiVolume: true });
  });

  it("maps packaging onto the base series, never onto a volume", () => {
    expect(titled("Fullmetal Alchemist: 3-in-1 Edition, Vol. 4")).toMatchObject({
      seriesTitle: "Fullmetal Alchemist",
      volumeLabel: undefined,
      packaging: { lineName: "3-in-1 Edition", linePosition: "4" },
    });
    expect(titled("Berserk Deluxe Volume 1")).toMatchObject({
      seriesTitle: "Berserk",
      volumeLabel: undefined,
    });
  });
});

describe("OpenLibrary scope", () => {
  it("rejects Japanese ISBNs, undeclared non-English-market ISBNs, and Spanish", () => {
    // Real OL records: a Kodansha JP tankōbon and a declared-Japanese edition.
    expect(
      parseEditionJson({
        ...EDITION,
        languages: undefined,
        isbn_13: ["9784065116173"],
        isbn_10: [],
      }),
    ).toBeNull();
    expect(parseEditionJson({ ...EDITION, isbn_13: ["9784065116173"], isbn_10: [] })).toBeNull();
    expect(
      parseEditionJson({
        ...EDITION,
        languages: undefined,
        isbn_13: [],
        isbn_10: [],
      }),
    ).toBeNull();
    expect(parseEditionJson({ ...EDITION, languages: undefined })).toMatchObject({
      isbn13: "9781974766512",
    });
    expect(isEnglishEdition(undefined, "9798888772584")).toBe(true);
    expect(isEnglishEdition(undefined, "9788419412287")).toBe(false);
  });

  it("drops light novels and merchandise", () => {
    expect(titled("Accel World, Vol. 18 (light Novel)")).toBeNull();
    expect(titled("Street Fighter : The Novel")).toBeNull();
    expect(titled("Hansel and Gretel: A Grimm Fable Coloring Book")).toBeNull();
  });

  it.each(["Audio CD", "Audiobook", "MP3 CD", "Audio Cassette"])(
    "excludes audio identified only by physical_format: %s",
    (physical_format) => {
      expect(parseEditionJson({ ...EDITION, physical_format })).toBeNull();
    },
  );
});

describe("isbnPair", () => {
  it("does not manufacture valid identifiers from corrupt ISBNs", () => {
    expect(isbnPair([], ["1974709931"])).toEqual({});
    expect(isbnPair(["9781974709939"], ["1974709931"])).toEqual({
      isbn13: "9781974709939",
    });
    expect(isbnPair(["4006381333931"], [])).toEqual({});
    expect(isbnPair(["SKU9781974709939"], ["SKU1974709930"])).toEqual({});
    expect(isbnPair([], ["1974709931", "1-9747-0993-0"])).toEqual({
      isbn13: "9781974709939",
      isbn10: "1974709930",
    });
  });
  it("keeps an ISBN-10 only when it is the same book as the ISBN-13", () => {
    expect(isbnPair(["9781974766512"], ["1974766519"])).toEqual({
      isbn13: "9781974766512",
      isbn10: "1974766519",
    });
    // Rurouni Kenshin v2: the 2017 3-in-1 ISBN-13 next to the 2003 single's ISBN-10.
    expect(isbnPair(["9781421592466"], ["1591162491"])).toEqual({
      isbn13: "9781421592466",
    });
    expect(isbnPair([], ["1591162491"])).toEqual({
      isbn13: isbn10To13("1591162491"),
      isbn10: "1591162491",
    });
    // A bad check digit is no ISBN at all.
    expect(isbnPair(["9781637867317"], [])).toEqual({});
  });
});

describe("parseEditionJson / parseDumpLine", () => {
  it("normalizes a VIZ edition", () => {
    const parsed = parseDumpLine(dumpLine(EDITION));
    expect(parsed).toMatchObject({
      kind: "olEdition",
      key: "/books/OL51694024M",
      url: "https://openlibrary.org/books/OL51694024M",
      seriesTitle: "Chainsaw Man",
      volumeLabel: "22",
      publishers: ["VIZ Media LLC"],
      publishDate: { year: 2026, month: 10, day: 13 },
      isbn13: "9781974766512",
      isbn10: "1974766519",
      format: "physical",
      binding: "paperback",
    });
  });

  it("skips non-English editions and non-edition lines", () => {
    expect(parseEditionJson({ ...EDITION, languages: [{ key: "/languages/jpn" }] })).toBeNull();
    expect(parseDumpLine("/type/author\t/authors/OL1A\t1\t2026\t{}")).toBeNull();
    expect(() => parseDumpLine("garbage")).toThrow("dump envelope");
    expect(() => parseDumpLine("/type/edition\t/books/OL1M\t1\t2026\t{")).toThrow();
    expect(() => parseDumpLine(dumpLine({ ...EDITION, key: "/books/OL2M" }))).toThrow("identity");
  });

  it("skips a sparse edition without a title rather than failing the line", () => {
    // The offline filter keeps editions by publisher + ISBN only, so
    // title-less records legitimately reach the parser.
    const { title: _title, ...untitled } = EDITION;
    expect(parseDumpLine(dumpLine(untitled))).toBeNull();
    expect(parseDumpLine(dumpLine({ ...EDITION, title: "" }))).toBeNull();
    expect(parseDumpLine(dumpLine({ ...EDITION, title: 42 }))).toBeNull();
  });

  it("classifies e-book physical_format as digital", () => {
    expect(parseEditionJson({ ...EDITION, physical_format: "E-book" })).toMatchObject({
      format: "digital",
      binding: undefined,
    });
  });
});

describe("title + subtitle split across fields", () => {
  it("re-reads a subtitle that is the rest of the title plus the volume", () => {
    expect(
      parseEditionJson({
        ...EDITION,
        title: "Mashle",
        subtitle: "Magic and Muscles, Vol. 3",
      }),
    ).toMatchObject({
      seriesTitle: "Mashle: Magic and Muscles",
      volumeLabel: "3",
    });
    expect(
      parseEditionJson({
        ...EDITION,
        title: "Mission",
        subtitle: "Yozakura Family, Vol. 12",
      }),
    ).toMatchObject({
      seriesTitle: "Mission: Yozakura Family",
      volumeLabel: "12",
    });
  });

  it("keeps the split reading when the joined one finds nothing more", () => {
    expect(
      parseEditionJson({
        ...EDITION,
        title: "Chainsaw Man, Vol. 22",
        subtitle: "Something Sinister",
      }),
    ).toMatchObject({ seriesTitle: "Chainsaw Man", volumeLabel: "22" });
    expect(
      parseEditionJson({
        ...EDITION,
        title: "Honey Hunt",
        subtitle: "Shojo Beat edition",
      }),
    ).toMatchObject({ seriesTitle: "Honey Hunt", volumeLabel: undefined });
  });
});

describe("toIsbn13", () => {
  it("accepts checksum-valid 13- and 10-character ISBNs and nothing else", () => {
    expect(toIsbn13("978-1-9747-6670-3")).toBe("9781974766703");
    expect(toIsbn13("1591163269")).toBe("9781591163268");
    expect(toIsbn13("9781974766704")).toBeUndefined();
    expect(toIsbn13("CTFL-02")).toBeUndefined();
    expect(toIsbn13("4006381333931")).toBeUndefined();
    expect(toIsbn13(undefined)).toBeUndefined();
  });
});
