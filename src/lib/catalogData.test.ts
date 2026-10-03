// The home page's catalog reads (fetchHomeCatalog), with the Convex HTTP
// client replaced by one that records each query and its arguments.

import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

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

describe("fetchHomeCatalog", () => {
  test.each([
    ["has not opted in", false],
    ["opted in", true],
  ])("asks for the non-mature pool when the viewer %s", async (_, mature) => {
    fakes.mature = mature;
    await fetchHomeCatalog({ year: 2026, month: 12 }, 28);
    expect(fakes.calls).toEqual([
      { name: "catalog:stats", args: {} },
      { name: "catalog:recentSeries", args: { limit: 28, showMature: false } },
      { name: "releases:monthBrowse", args: { year: 2026, month: 12, showMature: false } },
      { name: "releases:monthBrowse", args: { year: 2027, month: 1, showMature: false } },
    ]);
  });
});
