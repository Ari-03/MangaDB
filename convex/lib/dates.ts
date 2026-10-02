import { v, type Infer } from "convex/values";

/**
 * A date at the precision a source states it: a year, a month, or a day.
 * A Release's pubDate is this plus its sort key (pipeline.ts toPartialDate).
 */
export const datePartsValidator = v.object({
  year: v.number(),
  month: v.optional(v.number()),
  day: v.optional(v.number()),
});
export type DateParts = Infer<typeof datePartsValidator>;

/** A date known to the day. */
export const fullDateValidator = v.object({ year: v.number(), month: v.number(), day: v.number() });
export type FullDate = Infer<typeof fullDateValidator>;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "April" → 4. Only a full English month name counts, in any case. */
export function monthFromName(name: string): number | undefined {
  const index = MONTH_NAMES.indexOf(name.toLowerCase());
  return index >= 0 ? index + 1 : undefined;
}

/** "Sept", "Oct.", "October" → by their first three letters; "Ma" → undefined. */
export function monthFromAbbreviation(name: string): number | undefined {
  const prefix = name.slice(0, 3).toLowerCase();
  const index = prefix.length === 3 ? MONTH_NAMES.findIndex((m) => m.startsWith(prefix)) : -1;
  return index >= 0 ? index + 1 : undefined;
}

/** The date, when that day exists in the Gregorian calendar (month 1-based). */
export function calendarDay(year: number, month: number, day: number): FullDate | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]! ? { year, month, day } : undefined;
}

/**
 * The yyyymmdd key of `now`'s UTC calendar day, the shape of a Release's
 * pubDate.sort (spec §8), so "today" compares directly against release
 * dates. The one implementation for Convex and the app (src/lib/month.ts
 * re-exports it); cached queries take it as an argument rather than read
 * the clock.
 */
export function todaySortKey(now: Date = new Date()): number {
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/**
 * Whether a Series library timing filter counts back from today, so a
 * browse needs todaySort: every timing but "upcoming", which reads announced
 * dates. The one rule for convex/seriesBrowse.ts and the app's loader shim
 * (src/lib/catalogData.ts), which sends todaySort only when it is read.
 */
export function timingNeedsToday<T extends string>(timing: T): timing is Exclude<T, "upcoming"> {
  return timing !== "upcoming";
}
