import { describe, expect, it } from "vitest";
import { coverageFromLine, coverageFromText, inferCoverage } from "./coverage";

describe("coverageFromText — publisher blurbs that state the collected volumes", () => {
  it("reads PRH flap copy and keynotes (live Berserk Deluxe text, 2026-09-27)", () => {
    expect(
      coverageFromText(
        "A stunning deluxe edition collecting volumes 1&ndash;3 of the <i>New York Times</i> bestselling adult fantasy horror manga",
      ),
    ).toEqual({ from: "1", to: "3" });
    expect(
      coverageFromText("Collects <i>Berserk</i> Volumes 40, 41, and <i>Berserk Official Guidebook</i>."),
    ).toEqual({ from: "40", to: "41" });
    expect(coverageFromText("This omnibus contains volumes 4 through 6.")).toEqual({
      from: "4",
      to: "6",
    });
    expect(coverageFromText("Includes Vol. 7-9 plus bonus art.")).toEqual({ from: "7", to: "9" });
  });

  it("falls back to a bare range, and stays null when nothing is stated", () => {
    expect(coverageFromText("Volumes 10–12 of the acclaimed series, in hardcover.")).toEqual({
      from: "10",
      to: "12",
    });
    expect(coverageFromText("The first three volumes of a fantasy epic.")).toBeNull();
    expect(coverageFromText("Volume 5 continues the saga.")).toBeNull();
    expect(coverageFromText(undefined)).toBeNull();
  });

  it("rejects impossible ranges", () => {
    expect(coverageFromText("collects volumes 9-3")).toBeNull();
    expect(coverageFromText("collects volumes 1-80")).toBeNull();
  });
});

describe("coverageFromText — explicit lists (B18)", () => {
  it("never turns a gapped list into a range over the skipped Volumes", () => {
    expect(coverageFromText("Collects volumes 1 and 3.")).toBeNull();
    expect(coverageFromText("Collects Berserk Volumes 40, 42, and the Guidebook.")).toBeNull();
    expect(coverageFromText("Collects volumes 1, 2, and 3.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volume 5 in hardcover.")).toEqual({ from: "5", to: "5" });
  });
});

describe("coverageFromLine — line names that declare their size", () => {
  it("maps N-in-1 and VIZBIG positions onto volume ranges", () => {
    expect(coverageFromLine("3-in-1 Edition", "1")).toEqual({ from: "1", to: "3" });
    expect(coverageFromLine("3-in-1 Edition", "5")).toEqual({ from: "13", to: "15" });
    expect(coverageFromLine("2-in-1", "4")).toEqual({ from: "7", to: "8" });
    expect(coverageFromLine("VIZBIG Edition", "2")).toEqual({ from: "4", to: "6" });
    expect(coverageFromLine("Colossal Edition", "2")).toEqual({ from: "6", to: "10" });
    expect(coverageFromLine("Master's Edition", "3")).toEqual({ from: "11", to: "15" });
    expect(coverageFromLine("Grimoire Edition", "2")).toEqual({ from: "4", to: "6" });
    expect(coverageFromLine("Black Edition", "6")).toEqual({ from: "11", to: "12" });
    expect(coverageFromLine("Legendary Edition", "1")).toEqual({ from: "1", to: "2" });
    expect(coverageFromLine("Definitive Edition", "4")).toEqual({ from: "10", to: "12" });
    // Series-dependent names never guess.
    expect(coverageFromLine("Master Edition", "1")).toBeNull();
    expect(coverageFromLine("Collector's Edition", "1")).toBeNull();
    expect(coverageFromLine("Perfect Edition", "1")).toBeNull();
    expect(coverageFromLine("Fullmetal Edition", "1")).toBeNull();
  });

  it("never guesses for an undeclared size or a non-numeric position", () => {
    expect(coverageFromLine("Omnibus", "7")).toBeNull();
    expect(coverageFromLine("Deluxe Edition", "14")).toBeNull();
    expect(coverageFromLine("3-in-1 Edition", "IV")).toBeNull();
    expect(coverageFromLine(null, "1")).toBeNull();
  });
});

describe("inferCoverage — precedence", () => {
  it("prefers the title, then the blurbs in order, then the line size", () => {
    const stated = { lineName: "Omnibus", linePosition: "2", coverRange: { from: "4", to: "6" } };
    expect(inferCoverage(stated, ["collects volumes 1-3"])).toEqual({ from: "4", to: "6" });
    const deluxe = { lineName: "Deluxe Edition", linePosition: "14", coverRange: null };
    expect(inferCoverage(deluxe, [undefined, "Collects Berserk Volumes 40, 41."])).toEqual({
      from: "40",
      to: "41",
    });
    expect(inferCoverage(deluxe, [undefined])).toBeNull();
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "3", coverRange: null };
    expect(inferCoverage(threeIn1, [])).toEqual({ from: "7", to: "9" });
  });

  // R12: a statement no range can hold is evidence, not silence.
  it("never lets the line size override a gapped or impossible statement", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    expect(inferCoverage({ ...threeIn1, coverageGapped: true }, [])).toBeNull();
    expect(inferCoverage({ ...threeIn1, coverageGapped: true }, ["Collects volumes 1-3."])).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1 and 3."])).toBeNull();
    expect(inferCoverage(threeIn1, [undefined, "A giant edition.", "Collects volumes 1 & 3."])).toBeNull();
    expect(inferCoverage(threeIn1, ["collects volumes 9-3"])).toBeNull();
    // The first blurb that states a usable range still decides.
    expect(inferCoverage(threeIn1, ["Collects volumes 4-6.", "Collects volumes 1 and 3."])).toEqual({
      from: "4",
      to: "6",
    });
    // An unusable bare range states nothing, so the size still applies.
    expect(inferCoverage(threeIn1, ["Volumes 1-80 of the saga."])).toEqual({ from: "1", to: "3" });
  });

  // R12: a gapped list needs no collect-verb to count. Without one it was
  // read as silence and the 3-in-1 size invented Volume 2.
  it("reads a bare, numbered-word, or ranged gapped list as a gap", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Volumes 1 and 3 in one book!",
      "Features volumes 1 and 3.",
      "This edition brings together volumes 1 and 3.",
      "Collects volumes #1 and #3.",
      "Collects volumes one and three.",
      "Collecting volume 1 and volume 3.",
      "Collects volumes 1-2 and 4.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toBeNull();
    }
    // Contiguous lists, bare or in words, still state a range.
    expect(coverageFromText("Volumes 1, 2, and 3 together at last.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes one through three.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes #4, #5 and #6.")).toEqual({ from: "4", to: "6" });
    // A single bare Volume still says nothing about the book.
    expect(inferCoverage(threeIn1, ["Volume One of the hit series."])).toEqual({ from: "1", to: "3" });
    // An unusable bare range does not hide a later gapped list.
    expect(
      inferCoverage(threeIn1, ["Volumes 1-80 of the saga are out. Volumes 1 and 3 in one book!"]),
    ).toBeNull();
    // "+", "plus", and encoded ampersands separate listed Volumes too.
    for (const blurb of [
      "Collects volumes 1 + 3.",
      "Collects volumes 1 plus 3.",
      "Collects volumes 1 &amp;amp; 3.",
      "Collects volumes 1 &#38; 3.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toBeNull();
    }
  });

  // R12: a number that counts something else never extends the list.
  it("never reads a counted noun after the list as a Volume", () => {
    for (const blurb of [
      "Collects volumes 1–3 and 4 bonus stories.",
      "Collects volumes 1-3 and 16 pages of color art.",
      "Collects volumes 1-3, and 2 new short stories.",
      "Collects volumes 1-3 and volume 4's bonus chapter.",
      "Collects volumes 1-3 and volume 4&#8217;s bonus chapter.",
      "Collects volumes 1-3 and 4-6 new stories.",
      "Collects volumes 1-3 plus 16 pages of color art.",
    ]) {
      expect(coverageFromText(blurb), blurb).toEqual({ from: "1", to: "3" });
    }
    // "two bonus stories" is no Volume 2.
    expect(coverageFromText("Includes volume one and two bonus stories.")).toEqual({ from: "1", to: "1" });
    // Lists that end in punctuation or a function word keep every item.
    expect(coverageFromText("Collects volumes 1, 2, and 3—the complete arc.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes 1, 2, and 3 of the hit.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes 1-3 and 4 in one book.")).toEqual({ from: "1", to: "4" });
    // "1and" is no separator.
    expect(coverageFromText("Collects vols 1and 3")).toEqual({ from: "1", to: "1" });
  });
});
