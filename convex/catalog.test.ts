import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

describe("catalog.stats", () => {
  it("returns zero counts on an empty deployment", async () => {
    const t = convexTest(schema);
    const stats = await t.query(api.catalog.stats, {});
    expect(stats.series).toEqual({ count: 0, capped: false });
    expect(stats.releases).toEqual({ count: 0, capped: false });
  });

  it("counts active records and skips hidden/merged ones", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      const hidden = await ctx.db.insert("publishers", {
        status: "hidden",
        name: "Hidden Press",
        slug: "hidden-press",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "A Certain Series",
        altTitles: [],
        searchText: "A Certain Series",
      });
      await ctx.db.insert("series", {
        status: "merged",
        publicId: 2,
        title: "Duplicate Series",
        altTitles: [],
        searchText: "Duplicate Series",
      });
      void hidden;
    });

    const stats = await t.query(api.catalog.stats, {});
    expect(stats.publishers).toEqual({ count: 1, capped: false });
    expect(stats.series).toEqual({ count: 1, capped: false });
    expect(stats.volumes).toEqual({ count: 0, capped: false });
  });
});
