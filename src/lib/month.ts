// Month arithmetic for the Releases browser (ticket #24): `/releases/{yyyy-mm}`
// is the month-anchored URL form (spec §11 — the browser paginates by month
// URL, never `?page=N`). All calendar math is UTC so SSR and hydration agree.

export type YearMonth = { year: number; month: number };

/** Parse the `{yyyy-mm}` URL segment; strict two-digit month, 1–12 only. */
export function parseMonthParam(raw: string): YearMonth | null {
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1000 || month < 1 || month > 12) return null;
  return { year, month };
}

/** Canonical `{yyyy-mm}` URL segment for a month. */
export function monthParam({ year, month }: YearMonth): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function addMonths({ year, month }: YearMonth, delta: number): YearMonth {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 };
}

export function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "August 2026" — the browser's month heading. */
export function monthTitle({ year, month }: YearMonth): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** The month containing `now`, in UTC — the Agenda's first-visit anchor. */
export function currentMonth(now: Date = new Date()): YearMonth {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/**
 * yyyymmdd sort key for `now` (UTC) — the same shape as pubDate.sort (spec
 * §8), lower-bounding the Publisher Spotlight's upcoming lane (ticket #25).
 */
export function todaySortKey(now: Date = new Date()): number {
  return (
    now.getUTCFullYear() * 10000 +
    (now.getUTCMonth() + 1) * 100 +
    now.getUTCDate()
  );
}

/** yyyymm99 sort key covering every day of a month — an upper window bound. */
export function monthEndSortKey({ year, month }: YearMonth): number {
  return year * 10000 + month * 100 + 99;
}

export function daysInMonth({ year, month }: YearMonth): number {
  // Day 0 of the next month is this month's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday of the month's first day; 0 = Sunday, matching the grid header. */
export function firstWeekday({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

/** Short weekday name for a day of the month; the Agenda's date rail. */
export function weekdayName({ year, month }: YearMonth, day: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  ]!;
}
