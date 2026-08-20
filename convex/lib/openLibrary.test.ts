// OpenLibrary dump parser tests (ticket #36) against the documented dump
// line format (type\tkey\trevision\tlast_modified\tjson) and the messy
// publish_date / title styles OL actually contains.

import { describe, expect, it } from "vitest";
import {
  parseDumpLine,
  parseEditionJson,
  parseOlDate,
  splitOlTitle,
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
  it("parses OL's date styles at their own precision", () => {
    expect(parseOlDate("Oct 13, 2026")).toEqual({ year: 2026, month: 10, day: 13 });
    expect(parseOlDate("October 2026")).toEqual({ year: 2026, month: 10 });
    expect(parseOlDate("2026-10-13")).toEqual({ year: 2026, month: 10, day: 13 });
    expect(parseOlDate("2026-10")).toEqual({ year: 2026, month: 10 });
    expect(parseOlDate("2026")).toEqual({ year: 2026 });
    expect(parseOlDate("n.d.")).toBeUndefined();
  });
});

describe("splitOlTitle", () => {
  it("handles the common OL title styles", () => {
    expect(splitOlTitle("Chainsaw Man, Vol. 22")).toMatchObject({
      seriesTitle: "Chainsaw Man",
      volumeLabel: "22",
    });
    expect(splitOlTitle("Berserk Volume 41")).toMatchObject({
      seriesTitle: "Berserk",
      volumeLabel: "41",
    });
    expect(splitOlTitle("One Piece #3")).toMatchObject({
      seriesTitle: "One Piece",
      volumeLabel: "3",
    });
    expect(splitOlTitle("Frieren", "Vol. 5")).toMatchObject({
      seriesTitle: "Frieren",
      volumeLabel: "5",
    });
    // Bare trailing numbers are NOT labels for OL ("1984" is a title).
    expect(splitOlTitle("1984")).toEqual({ seriesTitle: "1984", multiVolume: false });
    expect(splitOlTitle("Naruto, Vol. 1-3")).toMatchObject({ multiVolume: true });
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
    expect(
      parseEditionJson({ ...EDITION, languages: [{ key: "/languages/jpn" }] }),
    ).toBeNull();
    expect(parseDumpLine("/type/author\t/authors/OL1A\t1\t2026\t{}")).toBeNull();
    expect(parseDumpLine("garbage")).toBeNull();
  });

  it("classifies e-book physical_format as digital", () => {
    expect(
      parseEditionJson({ ...EDITION, physical_format: "E-book" }),
    ).toMatchObject({ format: "digital", binding: undefined });
  });
});
