import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

// Mature content is judged from what a book holds, through merges and before
// display hiding (B34/B35, review R14/R15): hiding a member, a covered
// Volume, an Edition Line or its Series never makes a book or box set general
// on its page (cover concealment) or on the sitemap.

const PAGE = { cursor: null, numItems: 100 };

/**
 * A general Publisher's Edition (3) of a Mature Series' Volume, one Release
 * of it, and a box set (4) holding that Release as its sole member.
 */
async function seed() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", { status: "active", name: "General", slug: "general" });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Adult Story",
      altTitles: [],
      searchText: "Adult Story",
      mature: true,
    });
    const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: 2, seriesId, position: 1, label: "1" });
    const editionId = await ctx.db.insert("editions", { status: "active", publicId: 3, publisherId });
    await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
    const releaseId = await ctx.db.insert("releases", {
      status: "active",
      editionId,
      publisherId,
      seriesIds: [seriesId],
      format: "physical",
      language: "en",
    });
    const bundleId = await ctx.db.insert("releaseBundles", { status: "active", publicId: 4, publisherId, name: "Adult Box" });
    await ctx.db.insert("bundleMemberships", { bundleId, releaseId, order: 1 });
    return { publisherId, seriesId, volumeId, editionId, releaseId, bundleId };
  });
  return { t, ids };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** A general Series (publicId 10) with one Volume (11), for merge targets. */
async function generalSeries({ t }: Seeded) {
  return await t.run(async (ctx) => {
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 10,
      title: "Gentle Story",
      altTitles: [],
      searchText: "Gentle Story",
    });
    const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: 11, seriesId, position: 1, label: "1" });
    return { seriesId, volumeId };
  });
}

const bundlePage = ({ t }: Seeded) => t.query(api.catalogPages.bundlePage, { publicId: 4 });
const editionPage = ({ t }: Seeded, publicId: number) => t.query(api.catalogPages.editionPage, { publicId });
const sitemapIds = async ({ t }: Seeded, entity: "edition" | "bundle") =>
  (await t.query(api.seo.sitemapPage, { entity, paginationOpts: PAGE })).entries.map((entry) => entry.publicId);

describe("Bundle maturity from hidden members (R14)", () => {
  for (const hidden of ["release", "edition"] as const) {
    it(`stays mature, and off the sitemap, when its sole member's ${hidden} is hidden`, async () => {
      const seeded = await seed();
      expect((await bundlePage(seeded))?.mature).toBe(true);
      await seeded.t.run((ctx) =>
        ctx.db.patch(hidden === "release" ? seeded.ids.releaseId : seeded.ids.editionId, { status: "hidden" }),
      );
      const page = await bundlePage(seeded);
      expect(page?.members).toEqual([]);
      expect(page?.mature).toBe(true);
      expect(await sitemapIds(seeded, "bundle")).toEqual([]);
    });
  }

  it("stays mature when its member Release merged into a hidden survivor", async () => {
    const seeded = await seed();
    const { ids } = seeded;
    await seeded.t.run(async (ctx) => {
      const survivor = await ctx.db.insert("releases", {
        status: "hidden",
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "physical",
        language: "en",
      });
      await ctx.db.patch(ids.releaseId, { status: "merged", mergedIntoId: survivor });
    });
    const page = await bundlePage(seeded);
    expect(page?.members).toEqual([]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "bundle")).toEqual([]);
  });

  it("stays mature when its member Edition merged into a hidden survivor", async () => {
    const seeded = await seed();
    const { ids } = seeded;
    await seeded.t.run(async (ctx) => {
      const survivor = await ctx.db.insert("editions", { status: "hidden", publicId: 5, publisherId: ids.publisherId });
      await ctx.db.insert("volumeCoverages", { editionId: survivor, volumeId: ids.volumeId, order: 1, extent: "complete" });
      await ctx.db.patch(ids.editionId, { status: "merged", mergedIntoId: survivor });
    });
    const page = await bundlePage(seeded);
    expect(page?.members).toEqual([]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "bundle")).toEqual([]);
  });

  it("judges a merged member by its survivor's content", async () => {
    const seeded = await seed();
    const { ids } = seeded;
    const general = await generalSeries(seeded);
    // The box set's member merged away from a general book into the mature one.
    await seeded.t.run(async (ctx) => {
      const generalEdition = await ctx.db.insert("editions", { status: "active", publicId: 6, publisherId: ids.publisherId });
      await ctx.db.insert("volumeCoverages", { editionId: generalEdition, volumeId: general.volumeId, order: 1, extent: "complete" });
      const loser = await ctx.db.insert("releases", {
        status: "merged",
        mergedIntoId: ids.releaseId,
        editionId: generalEdition,
        publisherId: ids.publisherId,
        seriesIds: [general.seriesId],
        format: "physical",
        language: "en",
      });
      const membership = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", ids.bundleId))
        .unique();
      await ctx.db.patch(membership!._id, { releaseId: loser });
      await ctx.db.patch(ids.releaseId, { status: "hidden" });
    });
    const page = await bundlePage(seeded);
    expect(page?.members).toEqual([]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "bundle")).toEqual([]);
  });

  it("still lists a member merged into an active survivor under the survivor", async () => {
    const seeded = await seed();
    const { ids } = seeded;
    await seeded.t.run(async (ctx) => {
      const survivor = await ctx.db.insert("releases", {
        status: "active",
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "physical",
        language: "en",
        isbn13: "9780000000001",
      });
      await ctx.db.patch(ids.releaseId, { status: "merged", mergedIntoId: survivor });
    });
    const page = await bundlePage(seeded);
    expect(page?.members.map((member) => member.anchor)).toEqual(["9780000000001"]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "bundle")).toEqual([]);
  });

  it("still lists a general box set with a hidden general member", async () => {
    const seeded = await seed();
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(seeded.ids.seriesId, { mature: undefined });
      await ctx.db.patch(seeded.ids.releaseId, { status: "hidden" });
    });
    expect((await bundlePage(seeded))?.mature).toBe(false);
    expect(await sitemapIds(seeded, "bundle")).toEqual([4]);
  });
});

describe("Edition maturity from its line and covered content (R15)", () => {
  /** An active Unmapped Packaging Edition (7) in the Mature Series' Deluxe line, with a Release. */
  async function unmapped(seeded: Seeded) {
    const { ids } = seeded;
    return await seeded.t.run(async (ctx) => {
      const lineId = await ctx.db.insert("editionLines", {
        status: "active",
        seriesId: ids.seriesId,
        publisherId: ids.publisherId,
        name: "Deluxe",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 7,
        publisherId: ids.publisherId,
        editionLineId: lineId,
        linePosition: "1",
        coverageUnmapped: true,
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "physical",
        language: "en",
      });
      return { lineId, editionId, releaseId };
    });
  }

  it("keeps Unmapped Packaging mature, and off the sitemap, when its line's Series is hidden", async () => {
    const seeded = await seed();
    const { releaseId } = await unmapped(seeded);
    expect((await editionPage(seeded, 7))?.mature).toBe(true);
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(seeded.ids.seriesId, { status: "hidden" });
      // A box set holding the packaging is mature through it too.
      await ctx.db.insert("bundleMemberships", { bundleId: seeded.ids.bundleId, releaseId, order: 2 });
      await ctx.db.patch(seeded.ids.releaseId, { status: "hidden" });
    });
    const page = await editionPage(seeded, 7);
    expect(page?.series).toEqual([]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "edition")).not.toContain(7);
    const bundle = await bundlePage(seeded);
    expect(bundle?.members.map((member) => member.edition.publicId)).toEqual([7]);
    expect(bundle?.mature).toBe(true);
    expect(await sitemapIds(seeded, "bundle")).toEqual([]);
  });

  it("keeps Unmapped Packaging mature when its Edition Line is hidden", async () => {
    const seeded = await seed();
    const { lineId } = await unmapped(seeded);
    await seeded.t.run((ctx) => ctx.db.patch(lineId, { status: "hidden" }));
    const page = await editionPage(seeded, 7);
    expect(page?.edition.lineName).toBeNull();
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "edition")).not.toContain(7);
  });

  it("judges Unmapped Packaging by its line Series' survivor", async () => {
    const seeded = await seed();
    const general = await generalSeries(seeded);
    const { lineId } = await unmapped(seeded);
    // The line still names a general Series merged into the mature one,
    // which is itself hidden.
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(general.seriesId, { status: "merged", mergedIntoId: seeded.ids.seriesId });
      await ctx.db.patch(lineId, { seriesId: general.seriesId });
      await ctx.db.patch(seeded.ids.seriesId, { status: "hidden" });
    });
    expect((await editionPage(seeded, 7))?.mature).toBe(true);
    expect(await sitemapIds(seeded, "edition")).not.toContain(7);
  });

  it("judges a covered Volume merged away by its survivor's Series", async () => {
    const seeded = await seed();
    const general = await generalSeries(seeded);
    // Edition 3 now names a general Volume merged into the mature Series' one.
    await seeded.t.run(async (ctx) => {
      const row = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", seeded.ids.editionId))
        .unique();
      await ctx.db.patch(row!._id, { volumeId: general.volumeId });
      await ctx.db.patch(general.volumeId, { status: "merged", mergedIntoId: seeded.ids.volumeId });
    });
    const page = await editionPage(seeded, 3);
    expect(page?.coverage).toEqual([]);
    expect(page?.mature).toBe(true);
    expect(await sitemapIds(seeded, "edition")).not.toContain(3);
  });

  it("leaves a general Unmapped Packaging on the sitemap", async () => {
    const seeded = await seed();
    await unmapped(seeded);
    await seeded.t.run((ctx) => ctx.db.patch(seeded.ids.seriesId, { mature: undefined, status: "hidden" }));
    expect((await editionPage(seeded, 7))?.mature).toBe(false);
    expect(await sitemapIds(seeded, "edition")).toContain(7);
  });
});
