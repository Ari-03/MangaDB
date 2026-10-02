import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { pubDate } from "./test.catalog";
import {
  insertBundle,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

const PAGE = { cursor: null, numItems: 100 };

/**
 * A small catalog exercising the sitemap corners (ticket #39): active,
 * hidden, and merged records of each entity; a Volume under a hidden Series;
 * an Edition Line member (composed titles); and a Revision that must drive
 * `lastmod` over the record's creation time.
 */
async function seed(t: TestT) {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    await insertPublisher(ctx, { status: "hidden", name: "Hidden Press", slug: "hidden-press" });

    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Berserk" });
    const hiddenSeries = await insertSeries(ctx, { status: "hidden", publicId: 2, title: "Hidden Series" });
    await insertSeries(ctx, { status: "merged", publicId: 3, title: "Duplicate", mergedIntoId: seriesId });

    const volumeId = await insertVolume(ctx, { publicId: 11, seriesId, label: "1" });
    // Volume of a hidden Series: hidden from the public site → no URL.
    await insertVolume(ctx, { publicId: 12, seriesId: hiddenSeries, label: "1" });

    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "Deluxe Edition" });
    const editionId = await insertEdition(ctx, {
      publicId: 21,
      publisherId,
      editionLineId: lineId,
      linePosition: "1",
    });
    await insertCoverage(ctx, { editionId, volumeId });

    await insertBundle(ctx, { publicId: 31, name: "Berserk Box Set", publisherId });

    // A Revision on the Series: its creation time is the sitemap lastmod.
    const { revisionId } = await insertSourceRevision(ctx, {
      sourceKey: "test",
      ref: { type: "series", id: seriesId },
      changes: [],
      comment: "retitle",
    });

    return { seriesId, revisionId };
  });
}

describe("seo.sitemapPage", () => {
  it("lists only active Series, lastmod from the latest Revision", async () => {
    const t = makeT();
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
    const t = makeT();
    await seed(t);
    const createdAt = await t.run(async (ctx) => {
      const volume = await ctx.db
        .query("volumes")
        .withIndex("by_publicId", (q) => q.eq("publicId", 11))
        .unique();
      return volume!._creationTime;
    });

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
    const t = makeT();
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
    const t = makeT();
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
  it("returns null with no dated Releases", async () => {
    const t = makeT();
    expect(await t.query(api.seo.sitemapMonthRange, {})).toBeNull();
  });

  it("spans earliest to latest dated Release, clamping year-only dates", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx);
      const editionId = await insertEdition(ctx, { publisherId });
      // Year-precision (sort yyyy0000) clamps to January / December.
      for (const sort of [20250000, 20260815]) {
        await insertRelease(ctx, { editionId, publisherId, seriesIds: [], pubDate: pubDate(sort) });
      }
    });
    expect(await t.query(api.seo.sitemapMonthRange, {})).toEqual({
      from: { year: 2025, month: 1 },
      to: { year: 2026, month: 8 },
    });
  });
});
