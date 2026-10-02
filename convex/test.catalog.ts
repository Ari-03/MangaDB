// Helpers the public-catalog suites share on top of test.factories.ts.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import type { Doc } from "./_generated/dataModel";

/**
 * A Release's `pubDate` from its yyyymmdd sort key, at the precision the key
 * states: 20260800 is August 2026 with the day unknown, 20260000 the year
 * alone (the inverse of lib/dates.ts partialDateSort).
 */
export function pubDate(sort: number): NonNullable<Doc<"releases">["pubDate"]> {
  const year = Math.floor(sort / 10000);
  const month = Math.floor(sort / 100) % 100;
  const day = sort % 100;
  return {
    year,
    ...(month ? { month } : {}),
    ...(day ? { day } : {}),
    sort,
  };
}
