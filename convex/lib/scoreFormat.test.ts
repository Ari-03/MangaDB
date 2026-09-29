// Rating Format conversions (lib/scoreFormat.ts): one canonical 1-100 score,
// read and entered in four formats; averages in the viewer's numeric format.

import { describe, expect, it } from "vitest";

import {
  FORMAT_STEPS,
  SCORE_FORMATS,
  clampStep,
  formatAverage,
  formatScore,
  fromFormat,
  isValidScore,
  smileyOf,
  toFormat,
} from "./scoreFormat";

describe("isValidScore", () => {
  it("takes whole numbers from 1 to 100 only", () => {
    for (const good of [1, 35, 100]) expect(isValidScore(good)).toBe(true);
    for (const bad of [0, 101, 7.5, -3, Number.NaN]) expect(isValidScore(bad)).toBe(false);
  });
});

describe("clampStep", () => {
  it("holds a value to 1..steps of its format", () => {
    expect(clampStep(0, "point10")).toBe(1);
    expect(clampStep(11, "point10")).toBe(10);
    expect(clampStep(7, "point10")).toBe(7);
    expect(clampStep(9, "star5")).toBe(5);
    expect(clampStep(-4, "star5")).toBe(1);
    expect(clampStep(250, "point100")).toBe(100);
    expect(clampStep(4, "smiley3")).toBe(3);
  });

  it("rounds a fraction to the nearest step", () => {
    expect(clampStep(7.4, "point10")).toBe(7);
    expect(clampStep(3.5, "star5")).toBe(4);
  });

  it("round-trips every step of every format through fromFormat and toFormat", () => {
    for (const format of SCORE_FORMATS) {
      for (let step = 1; step <= FORMAT_STEPS[format]; step++) {
        expect(toFormat(fromFormat(clampStep(step, format), format), format)).toBe(step);
      }
    }
  });
});

describe("fromFormat", () => {
  it("stores n x 10, n x 20, n, and AniList's smiley scores", () => {
    expect(fromFormat(8, "point10")).toBe(80);
    expect(fromFormat(1, "point10")).toBe(10);
    expect(fromFormat(4, "star5")).toBe(80);
    expect(fromFormat(5, "star5")).toBe(100);
    expect(fromFormat(73, "point100")).toBe(73);
    expect([1, 2, 3].map((n) => fromFormat(n, "smiley3"))).toEqual([35, 60, 85]);
  });
});

describe("toFormat", () => {
  it("rounds to the nearest step, never below 1", () => {
    expect(toFormat(84, "point10")).toBe(8);
    expect(toFormat(85, "point10")).toBe(9);
    expect(toFormat(4, "point10")).toBe(1);
    expect(toFormat(84, "star5")).toBe(4);
    expect(toFormat(90, "star5")).toBe(5);
    expect(toFormat(5, "star5")).toBe(1);
    expect(toFormat(84, "point100")).toBe(84);
  });

  it("reads smileys at 49 / 50 and 74 / 75", () => {
    expect([1, 49, 50, 74, 75, 100].map(smileyOf)).toEqual([
      "negative",
      "negative",
      "neutral",
      "neutral",
      "positive",
      "positive",
    ]);
    expect([49, 50, 75].map((s) => toFormat(s, "smiley3"))).toEqual([1, 2, 3]);
  });

  it("round-trips every step of every format", () => {
    for (const format of SCORE_FORMATS) {
      for (let step = 1; step <= FORMAT_STEPS[format]; step++) {
        const score = fromFormat(step, format);
        expect(isValidScore(score)).toBe(true);
        expect(toFormat(score, format)).toBe(step);
      }
    }
  });
});

describe("formatScore", () => {
  it("renders one Rating in each format", () => {
    expect(formatScore(84, "point10")).toBe("8/10");
    expect(formatScore(84, "star5")).toBe("4 ★");
    expect(formatScore(84, "point100")).toBe("84");
    expect(formatScore(84, "smiley3")).toBe("Positive");
    expect(formatScore(35, "smiley3")).toBe("Negative");
  });
});

describe("formatAverage", () => {
  it("uses the viewer's numeric format, and point10 for smiley3 and signed-out viewers", () => {
    expect(formatAverage(84, "point10")).toBe("8.4");
    expect(formatAverage(84, "star5")).toBe("4.2 ★");
    expect(formatAverage(84.4, "point100")).toBe("84");
    expect(formatAverage(84, "smiley3")).toBe("8.4");
    expect(formatAverage(84, null)).toBe("8.4");
  });
});
