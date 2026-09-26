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
