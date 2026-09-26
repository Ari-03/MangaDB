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
 * dates. The one rule for convex/seriesBrowse.ts and the app's server shim
 * (src/server/seriesBrowse.ts), which sends todaySort only when it is read.
 */
export function timingNeedsToday<T extends string>(timing: T): timing is Exclude<T, "upcoming"> {
  return timing !== "upcoming";
}
