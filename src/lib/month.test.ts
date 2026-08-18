import { describe, expect, it } from "vitest";

import {
  addMonths,
  daysInMonth,
  firstWeekday,
  monthParam,
  monthTitle,
  parseMonthParam,
} from "./month";

describe("parseMonthParam", () => {
  it("accepts exactly the canonical yyyy-mm form", () => {
    expect(parseMonthParam("2026-08")).toEqual({ year: 2026, month: 8 });
    expect(parseMonthParam("2026-12")).toEqual({ year: 2026, month: 12 });
  });

  it("rejects malformed and out-of-range segments", () => {
    for (const raw of [
      "2026-8", // month must be two digits — one canonical URL per month
      "2026-13",
      "2026-00",
      "26-08",
      "2026-08-01",
      "august-2026",
      "",
    ]) {
      expect(parseMonthParam(raw)).toBeNull();
    }
  });

  it("round-trips through monthParam", () => {
    expect(monthParam({ year: 2026, month: 8 })).toBe("2026-08");
    expect(parseMonthParam(monthParam({ year: 2027, month: 1 }))).toEqual({
      year: 2027,
      month: 1,
    });
  });
});

describe("addMonths", () => {
  it("crosses year boundaries in both directions", () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 8 }, -20)).toEqual({ year: 2024, month: 12 });
  });
});

describe("calendar shape", () => {
  it("knows month lengths, February leap years included", () => {
    expect(daysInMonth({ year: 2026, month: 8 })).toBe(31);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2100, month: 2 })).toBe(28);
  });

  it("anchors the grid on the first day's weekday", () => {
    // August 1, 2026 is a Saturday.
    expect(firstWeekday({ year: 2026, month: 8 })).toBe(6);
    expect(firstWeekday({ year: 2026, month: 11 })).toBe(0);
  });

  it("titles months for the heading", () => {
    expect(monthTitle({ year: 2026, month: 8 })).toBe("August 2026");
  });
});
