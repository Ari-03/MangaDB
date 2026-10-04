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
  type Input = Parameters<typeof editionTitle>[0];
  const vol = (label: string | null, position: number) => ({ label, position });
  // [case, the Edition (no line unless given), expected title]
  const cases: Array<[string, Partial<Input> & Pick<Input, "covered">, string]> = [
    [
      // Line numbering wins over the covered Volumes' canonical numbers.
      "titles an Edition Line member by line + Edition Line Position",
      {
        seriesTitle: "Tokyo Ghoul",
        lineName: "Monster Edition",
        linePosition: "1",
        covered: [vol("1", 1), vol("2", 2), vol("3", 3)],
      },
      "Tokyo Ghoul Monster Edition 1",
    ],
    [
      "omits the position when the line has none",
      { seriesTitle: "S", lineName: "Deluxe", covered: [vol("1", 1)] },
      "S Deluxe",
    ],
    [
      "titles a lineless single-volume Edition by the Volume Label",
      { seriesTitle: "Tokyo Ghoul", covered: [vol("3.5", 4)] },
      "Tokyo Ghoul Vol 3.5",
    ],
    [
      "is just the series title for an unlabeled lone Volume (oneshot)",
      { seriesTitle: "One Rainy Evening", covered: [vol(null, 1)] },
      "One Rainy Evening",
    ],
    [
      "ranges a lineless multi-volume Edition, positions as label fallback",
      { seriesTitle: "S", covered: [vol("1", 1), vol(null, 3)] },
      "S Vol 1–3",
    ],
    ["falls back gracefully with no coverage and no series", { covered: [] }, "Edition"],
  ];

  it.each(cases)("%s", (_, edition, expected) => {
    expect(
      editionTitle({ seriesTitle: null, lineName: null, linePosition: null, ...edition }),
    ).toBe(expected);
  });
});

describe("releaseAnchor", () => {
  it("prefers ISBN-13, then ISBN-10, then the document ID (spec §8)", () => {
    expect(releaseAnchor({ isbn13: "9781999000103", isbn10: "1999000101", _id: "d" })).toBe(
      "9781999000103",
    );
    expect(releaseAnchor({ isbn10: "1999000101", _id: "d" })).toBe("1999000101");
    expect(releaseAnchor({ _id: "doc123" })).toBe("doc123");
  });
});
