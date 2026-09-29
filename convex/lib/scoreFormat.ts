// Rating Format (CONTEXT.md): how a User enters and reads scores. Every
// Rating is stored as one canonical whole-number `score` from 1 to 100; the
// format only changes the control and the display, AniList style. Pure and
// dependency-free apart from the validator, so the client imports it too
// (src/lib/ratings.tsx) and both sides convert the same way.

import { v } from "convex/values";

export const SCORE_MIN = 1;
export const SCORE_MAX = 100;

export const SCORE_FORMATS = ["point10", "star5", "point100", "smiley3"] as const;
export type ScoreFormat = (typeof SCORE_FORMATS)[number];
/** A User without a stored choice reads and rates in this format. */
export const DEFAULT_SCORE_FORMAT: ScoreFormat = "point10";

export const scoreFormatValidator = v.union(
  v.literal("point10"),
  v.literal("star5"),
  v.literal("point100"),
  v.literal("smiley3"),
);

export const SMILEYS = ["negative", "neutral", "positive"] as const;
export type Smiley = (typeof SMILEYS)[number];
/** The score each smiley stores (AniList's mapping). */
export const SMILEY_SCORES: Record<Smiley, number> = { negative: 35, neutral: 60, positive: 85 };
export const SMILEY_LABELS: Record<Smiley, string> = {
  negative: "Negative",
  neutral: "Neutral",
  positive: "Positive",
};

/** How many steps a format's control offers: 1..steps. */
export const FORMAT_STEPS: Record<ScoreFormat, number> = {
  point10: 10,
  star5: 5,
  point100: 100,
  smiley3: 3,
};

/** A whole number from SCORE_MIN to SCORE_MAX. */
export function isValidScore(score: number): boolean {
  return Number.isInteger(score) && score >= SCORE_MIN && score <= SCORE_MAX;
}

/** Which smiley a stored score reads as: up to 49 negative, 50-74 neutral, 75 up positive. */
export function smileyOf(score: number): Smiley {
  if (score <= 49) return "negative";
  if (score <= 74) return "neutral";
  return "positive";
}

/**
 * A stored score as the step a format's control shows: 1-10, 1-5, 1-100,
 * or 1-3 (negative, neutral, positive).
 */
export function toFormat(score: number, format: ScoreFormat): number {
  switch (format) {
    case "point10":
      return Math.max(1, Math.round(score / 10));
    case "star5":
      return Math.max(1, Math.round(score / 20));
    case "point100":
      return score;
    case "smiley3":
      return SMILEYS.indexOf(smileyOf(score)) + 1;
  }
}

/** A step picked in a format's control as the score to store. */
export function fromFormat(step: number, format: ScoreFormat): number {
  switch (format) {
    case "point10":
      return step * 10;
    case "star5":
      return step * 20;
    case "point100":
      return step;
    case "smiley3":
      return SMILEY_SCORES[SMILEYS[step - 1] ?? "neutral"];
  }
}

/** One stored score in a format, for a single Rating: "8/10", "4 ★", "84", "Positive". */
export function formatScore(score: number, format: ScoreFormat): string {
  switch (format) {
    case "point10":
      return `${toFormat(score, format)}/10`;
    case "star5":
      return `${toFormat(score, format)} ★`;
    case "point100":
      return String(score);
    case "smiley3":
      return SMILEY_LABELS[smileyOf(score)];
  }
}

/**
 * A target's average (on the 1-100 scale) as the public sees it: in the
 * viewer's format when it has a numeric form ("8.4", "4.2 ★", "84"), and
 * the point10 form otherwise (smiley3 viewers and signed-out visitors).
 */
export function formatAverage(average: number, format: ScoreFormat | null): string {
  switch (format) {
    case "star5":
      return `${(average / 20).toFixed(1)} ★`;
    case "point100":
      return String(Math.round(average));
    default:
      return (average / 10).toFixed(1);
  }
}
