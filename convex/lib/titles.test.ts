import { describe, expect, it } from "vitest";

import { editionTitle, releaseAnchor, volumeTitle } from "./titles";

describe("volumeTitle", () => {
  it("composes series title + Label", () => {
    expect(volumeTitle("Tokyo Ghoul", "3.5")).toBe("Tokyo Ghoul Vol 3.5");
  });

  it("is just the series title for an unlabeled Volume (oneshot)", () => {
    expect(volumeTitle("One Rainy Evening", null)).toBe("One Rainy Evening");
  });
});

describe("editionTitle", () => {
  it("titles an Edition Line member by line + Edition Line Position", () => {
    expect(
      editionTitle({
        seriesTitle: "Tokyo Ghoul",
        lineName: "Monster Edition",
        linePosition: "1",
        // Line numbering wins over the covered Volumes' canonical numbers.
        covered: [
          { label: "1", position: 1 },
          { label: "2", position: 2 },
          { label: "3", position: 3 },
        ],
      }),
    ).toBe("Tokyo Ghoul Monster Edition 1");
  });

  it("omits the position when the line has none", () => {
    expect(
      editionTitle({
        seriesTitle: "S",
        lineName: "Deluxe",
        linePosition: null,
        covered: [{ label: "1", position: 1 }],
      }),
    ).toBe("S Deluxe");
  });

  it("titles a lineless single-volume Edition by the Volume Label", () => {
    expect(
      editionTitle({
        seriesTitle: "Tokyo Ghoul",
        lineName: null,
        linePosition: null,
        covered: [{ label: "3.5", position: 4 }],
      }),
    ).toBe("Tokyo Ghoul Vol 3.5");
  });

  it("is just the series title for an unlabeled lone Volume (oneshot)", () => {
    expect(
      editionTitle({
        seriesTitle: "One Rainy Evening",
        lineName: null,
        linePosition: null,
        covered: [{ label: null, position: 1 }],
      }),
    ).toBe("One Rainy Evening");
  });

  it("ranges a lineless multi-volume Edition, positions as label fallback", () => {
    expect(
      editionTitle({
        seriesTitle: "S",
        lineName: null,
        linePosition: null,
        covered: [
          { label: "1", position: 1 },
          { label: null, position: 3 },
        ],
      }),
    ).toBe("S Vol 1–3");
  });

  it("falls back gracefully with no coverage and no series", () => {
    expect(
      editionTitle({
        seriesTitle: null,
        lineName: null,
        linePosition: null,
        covered: [],
      }),
    ).toBe("Edition");
  });
});

describe("releaseAnchor", () => {
  it("prefers ISBN-13, then ISBN-10, then the document ID (spec §8)", () => {
    expect(
      releaseAnchor({ isbn13: "9781999000103", isbn10: "1999000101", _id: "d" }),
    ).toBe("9781999000103");
    expect(releaseAnchor({ isbn10: "1999000101", _id: "d" })).toBe("1999000101");
    expect(releaseAnchor({ _id: "doc123" })).toBe("doc123");
  });
});
