// The home page's catalog reads (fetchHomeCatalog), with the Convex HTTP
// client replaced by one that records each query and its arguments.

import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  mature: false,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    async query(ref: FunctionReference<"query">, args: Record<string, unknown>) {
      fakes.calls.push({ name: getFunctionName(ref), args });
      return null;
    }
  },
}));
vi.mock("~/lib/convexUrl", () => ({ convexUrl: () => "https://convex.example" }));
vi.mock("~/lib/mature", () => ({ showMature: () => fakes.mature }));

const { fetchHomeCatalog } = await import("./catalogData");

beforeEach(() => {
  fakes.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fetchHomeCatalog", () => {
  test.each([
    ["has not opted in", false],
    ["opted in", true],
  ])("asks for the non-mature pool when the viewer %s", async (_, mature) => {
    fakes.mature = mature;
    await fetchHomeCatalog({ year: 2026, month: 12 }, 28);
    expect(fakes.calls).toEqual([
      { name: "catalog:stats", args: {} },
      {
        name: "catalog:recentSeries",
        args: { limit: 28, todaySort: expect.any(Number), showMature: false },
      },
      { name: "releases:monthBrowse", args: { year: 2026, month: 12, showMature: false } },
      { name: "releases:monthBrowse", args: { year: 2027, month: 1, showMature: false } },
    ]);
  });

  // The Convex query must not read a clock (its cached result would expire
  // within seconds), so the day comes from here, in UTC.
  test("sends the newest Series' cover pick today's UTC date", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 4, 23, 30) });
    await fetchHomeCatalog({ year: 2026, month: 10 }, 28);
    expect(fakes.calls.find((call) => call.name === "catalog:recentSeries")?.args.todaySort).toBe(
      20261004,
    );
  });
});
