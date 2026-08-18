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

describe("catalog.listSeries", () => {
  it("lists active series in public-ID order, skipping hidden/merged", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "active",
        publicId: 2,
        title: "B",
        altTitles: [],
        searchText: "B",
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 3,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "A",
        altTitles: [],
        searchText: "A",
      });
    });
    expect(await t.query(api.catalog.listSeries, {})).toEqual([
      { publicId: 1, title: "A" },
      { publicId: 2, title: "B" },
    ]);
  });
});

describe("catalog.seriesPage", () => {
  it("orders volumes by hidden Position, never by the display Label", async () => {
    const t = convexTest(schema);
    const publicId = 1;
    await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title: "Disorderly Labels",
        altTitles: [],
        searchText: "Disorderly Labels",
      });
      // Labels sort the wrong way alphabetically and numerically; Position
      // must win. Inserted shuffled so creation order can't mask a bug.
      const rows: Array<[number, string]> = [
        [2, "10"],
        [1, "9"],
        [3, "Side Story"],
      ];
      let volPublicId = 1;
      for (const [position, label] of rows) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: volPublicId++,
          seriesId,
          position,
          label,
        });
      }
    });

    const page = await t.query(api.catalog.seriesPage, { publicId });
    expect(page?.volumes.map((v) => [v.position, v.label])).toEqual([
      [1, "9"],
      [2, "10"],
      [3, "Side Story"],
    ]);
  });

  it("resolves a merged Series to its survivor so the route can 301", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const winner = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Survivor",
        altTitles: [],
        searchText: "Survivor",
      });
      await ctx.db.insert("series", {
        status: "merged",
        mergedIntoId: winner,
        publicId: 2,
        title: "Duplicate",
        altTitles: [],
        searchText: "Duplicate",
      });
    });

    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.series.publicId).toBe(1);
    expect(page?.series.title).toBe("Survivor");
  });

  it("returns null for unknown and hidden Series", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 5,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      });
    });
    expect(await t.query(api.catalog.seriesPage, { publicId: 5 })).toBeNull();
    expect(await t.query(api.catalog.seriesPage, { publicId: 99 })).toBeNull();
  });

  it("shows no family when the umbrella has fewer than two active members", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const familyId = await ctx.db.insert("seriesFamilies", {
        status: "active",
        name: "Lonely Family",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Only Child",
        altTitles: [],
        searchText: "Only Child",
        familyId,
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 2,
        title: "Hidden Sibling",
        altTitles: [],
        searchText: "Hidden Sibling",
        familyId,
      });
    });
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.family).toBeNull();
  });

  it("excludes hidden editions and releases from the reading path", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Pub",
        slug: "pub",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "S",
        altTitles: [],
        searchText: "S",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 1,
        label: "1",
      });
      const hiddenEdition = await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 1,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId: hiddenEdition,
        volumeId,
        order: 1,
        extent: "complete",
      });
      const activeEdition = await ctx.db.insert("editions", {
        status: "active",
        publicId: 2,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId: activeEdition,
        volumeId,
        order: 1,
        extent: "complete",
      });
      await ctx.db.insert("releases", {
        status: "hidden",
        editionId: activeEdition,
        format: "digital",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
    });
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.volumes[0]?.editions).toHaveLength(1);
    expect(page?.volumes[0]?.editions[0]?.publicId).toBe(2);
    expect(page?.volumes[0]?.editions[0]?.releases).toEqual([]);
  });
});
