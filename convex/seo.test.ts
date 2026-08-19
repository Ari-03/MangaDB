import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const PAGE = { cursor: null, numItems: 100 };

/**
 * A small catalog exercising the sitemap corners (ticket #39): active,
 * hidden, and merged records of each entity; a Volume under a hidden Series;
 * an Edition Line member (composed titles); and a Revision that must drive
 * `lastmod` over the record's creation time.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "VIZ Media",
      slug: "viz-media",
    });
    await ctx.db.insert("publishers", {
      status: "hidden",
      name: "Hidden Press",
      slug: "hidden-press",
    });

    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Berserk",
      altTitles: [],
      searchText: "Berserk",
    });
    const hiddenSeries = await ctx.db.insert("series", {
      status: "hidden",
      publicId: 2,
      title: "Hidden Series",
      altTitles: [],
      searchText: "Hidden Series",
    });
    await ctx.db.insert("series", {
      status: "merged",
      publicId: 3,
      title: "Duplicate",
      altTitles: [],
      searchText: "Duplicate",
      mergedIntoId: seriesId,
    });

    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      publicId: 11,
      seriesId,
      position: 1,
      label: "1",
    });
    // Volume of a hidden Series: hidden from the public site → no URL.
    await ctx.db.insert("volumes", {
      status: "active",
      publicId: 12,
      seriesId: hiddenSeries,
      position: 1,
      label: "1",
    });

    const lineId = await ctx.db.insert("editionLines", {
      status: "active",
      seriesId,
      publisherId,
      name: "Deluxe Edition",
    });
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: 21,
      publisherId,
      editionLineId: lineId,
      linePosition: "1",
    });
    await ctx.db.insert("volumeCoverages", {
      editionId,
      volumeId,
      order: 1,
      extent: "complete",
    });

    await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 31,
      name: "Berserk Box Set",
      publisherId,
    });

    // A Revision on the Series: its creation time is the sitemap lastmod.
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "source", sourceKey: "test" },
      state: "approved",
      currentVersionNo: 1,
    });
    const revisionId = await ctx.db.insert("revisions", {
      ref: { type: "series", id: seriesId },
      seq: 1,
      proposalId,
      author: { kind: "source", sourceKey: "test" },
      changes: [],
      comment: "retitle",
    });

    return { seriesId, revisionId };
  });
}

describe("seo.sitemapPage", () => {
  it("lists only active Series, lastmod from the latest Revision", async () => {
    const t = convexTest(schema);
    const { revisionId } = await seed(t);
    const revisionTime = await t.run(
      async (ctx) => (await ctx.db.get(revisionId))!._creationTime,
    );

    const result = await t.query(api.seo.sitemapPage, {
      entity: "series",
      paginationOpts: PAGE,
    });
    expect(result.isDone).toBe(true);
    expect(result.entries).toEqual([
      { publicId: 1, slug: null, title: "Berserk", lastmod: revisionTime },
    ]);
  });

  it("falls back to creation time for records without Revisions", async () => {
    const t = convexTest(schema);
    const { seriesId } = await seed(t);
    const createdAt = await t.run(async (ctx) => {
      const volume = await ctx.db
        .query("volumes")
        .withIndex("by_publicId", (q) => q.eq("publicId", 11))
        .unique();
      return volume!._creationTime;
    });
    void seriesId;

    const result = await t.query(api.seo.sitemapPage, {
      entity: "volume",
      paginationOpts: PAGE,
    });
    // The hidden Series' Volume is absent; the title is composed (spec §8).
    expect(result.entries).toEqual([
      { publicId: 11, slug: null, title: "Berserk Vol 1", lastmod: createdAt },
    ]);
  });

  it("composes Edition titles from line + position", async () => {
    const t = convexTest(schema);
    await seed(t);
    const result = await t.query(api.seo.sitemapPage, {
      entity: "edition",
      paginationOpts: PAGE,
    });
    expect(result.entries.map((e) => [e.publicId, e.title])).toEqual([
      [21, "Berserk Deluxe Edition 1"],
    ]);
  });

  it("lists Publishers by slug and Bundles by name, active only", async () => {
    const t = convexTest(schema);
    await seed(t);
    const publishers = await t.query(api.seo.sitemapPage, {
      entity: "publisher",
      paginationOpts: PAGE,
    });
    expect(publishers.entries.map((e) => e.slug)).toEqual(["viz-media"]);
    const bundles = await t.query(api.seo.sitemapPage, {
      entity: "bundle",
      paginationOpts: PAGE,
    });
    expect(bundles.entries.map((e) => [e.publicId, e.title])).toEqual([
      [31, "Berserk Box Set"],
    ]);
  });
});

describe("seo.sitemapMonthRange", () => {
  async function insertRelease(
    t: ReturnType<typeof convexTest>,
    sort: number,
    pubDate: { year: number; month?: number; day?: number },
  ) {
    await t.run(async (ctx) => {
      const publisherId =
        (await ctx.db.query("publishers").first())?._id ??
        (await ctx.db.insert("publishers", {
          status: "active",
          name: "P",
          slug: "p",
        }));
      const editionId =
        (await ctx.db.query("editions").first())?._id ??
        (await ctx.db.insert("editions", {
          status: "active",
          publicId: 90,
          publisherId: publisherId as Id<"publishers">,
        }));
      await ctx.db.insert("releases", {
        status: "active",
        editionId: editionId as Id<"editions">,
        format: "physical",
        language: "en",
        pubDate: { ...pubDate, sort },
        publisherId: publisherId as Id<"publishers">,
        seriesIds: [],
      });
    });
  }

  it("returns null with no dated Releases", async () => {
    const t = convexTest(schema);
    expect(await t.query(api.seo.sitemapMonthRange, {})).toBeNull();
  });

  it("spans earliest to latest dated Release, clamping year-only dates", async () => {
    const t = convexTest(schema);
    // Year-precision (sort yyyy0000) clamps to January / December.
    await insertRelease(t, 20250000, { year: 2025 });
    await insertRelease(t, 20260815, { year: 2026, month: 8, day: 15 });
    expect(await t.query(api.seo.sitemapMonthRange, {})).toEqual({
      from: { year: 2025, month: 1 },
      to: { year: 2026, month: 8 },
    });
  });
});
