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
});
