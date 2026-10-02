import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MIN_COVER_BYTES } from "./lib/covers";
import schema from "./schema";

// Fixture ISBNs (fake but distinct); checksum validity is the route's
// concern — the Convex queries take any normalized string.
const R1_ISBN13 = "9781999000103";
const R1_ISBN10 = "1999000102";
const OMNIBUS_ISBN13 = "9781999000608";
const SPLIT_ISBN13 = "9781999000318";
const BUNDLE_ISBN13 = "9781999000400";

/**
 * One catalog exercising ticket #23's corners: a standard Edition of Vol 1
 * (physical release with both ISBNs + a digital one with none, a Variant, a
 * Bundle membership pinning it), an omnibus Edition Line member covering
 * Vols 1–3 completely, and a split digital Edition partially covering Vol 3.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "VIZ Media",
      slug: "viz-media",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "S",
      altTitles: [],
      searchText: "S",
    });
    const volumes: Array<Id<"volumes">> = [];
    for (const position of [1, 2, 3]) {
      volumes.push(
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: 10 + position,
          seriesId,
          position,
          label: String(position),
        }),
      );
    }
    const [v1, v2, v3] = volumes as [Id<"volumes">, Id<"volumes">, Id<"volumes">];

    // Standard Edition of Vol 1.
    const standard = await ctx.db.insert("editions", {
      status: "active",
      publicId: 21,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: standard,
      volumeId: v1,
      order: 1,
      extent: "complete",
    });
    const r1 = await ctx.db.insert("releases", {
      status: "active",
      editionId: standard,
      format: "physical",
      binding: "paperback",
      language: "en",
      isbn13: R1_ISBN13,
      isbn10: R1_ISBN10,
      pubDate: { year: 2015, month: 6, day: 16, sort: 20150616 },
      description: "Back-cover blurb.",
      publisherId,
      seriesIds: [seriesId],
    });
    const r2 = await ctx.db.insert("releases", {
      status: "active",
      editionId: standard,
      format: "digital",
      language: "en",
      pubDate: { year: 2016, month: 1, day: 5, sort: 20160105 },
      publisherId,
      seriesIds: [seriesId],
    });
    const variantId = await ctx.db.insert("releaseVariants", {
      status: "active",
      releaseId: r1,
      name: "Box-set exclusive cover",
    });

    // Omnibus Edition: "Monster Edition 1" covering Vols 1–3 completely.
    const lineId = await ctx.db.insert("editionLines", {
      status: "active",
      seriesId,
      publisherId,
      name: "Monster Edition",
    });
    const omnibus = await ctx.db.insert("editions", {
      status: "active",
      publicId: 22,
      publisherId,
      editionLineId: lineId,
      linePosition: "1",
    });
    for (const [order, volumeId] of [v1, v2, v3].entries()) {
      await ctx.db.insert("volumeCoverages", {
        editionId: omnibus,
        volumeId,
        order: order + 1,
        extent: "complete",
      });
    }
    const r3 = await ctx.db.insert("releases", {
      status: "active",
      editionId: omnibus,
      format: "physical",
      binding: "hardcover",
      language: "en",
      isbn13: OMNIBUS_ISBN13,
      pubDate: { year: 2022, month: 10, day: 25, sort: 20221025 },
      publisherId,
      seriesIds: [seriesId],
    });

    // Split digital Edition partially covering Vol 3.
    const split = await ctx.db.insert("editions", {
      status: "active",
      publicId: 23,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: split,
      volumeId: v3,
      order: 1,
      extent: "partial",
      note: "First half only.",
    });
    const r4 = await ctx.db.insert("releases", {
      status: "active",
      editionId: split,
      format: "digital",
      language: "en",
      isbn13: SPLIT_ISBN13,
      publisherId,
      seriesIds: [seriesId],
    });

    // Box set of the standard paperback + the omnibus, pinning r1's Variant.
    const bundleId = await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 31,
      name: "S Complete Box Set",
      publisherId,
      format: "physical",
      isbn13: BUNDLE_ISBN13,
      pubDate: { year: 2023, month: 9, day: 19, sort: 20230919 },
    });
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId: r1,
      variantId,
      order: 1,
    });
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId: r3,
      order: 2,
    });

    return { publisherId, seriesId, v1, v2, v3, standard, omnibus, split, r1, r2, r3, r4, bundleId };
  });
}

describe("catalogPages.volumePage", () => {
  it("lists complete and partial covering Editions distinctly, omnibus included", async () => {
    const t = convexTest(schema);
    await seed(t);

    const page = await t.query(api.catalogPages.volumePage, { publicId: 13 });
    expect(page?.volume).toMatchObject({
      publicId: 13,
      position: 3,
      label: "3",
      title: "S Vol 3",
    });
    expect(page?.series).toEqual({ publicId: 1, title: "S" });

    // Vol 3 is covered completely by the omnibus and partially by the split.
    const byId = new Map(page!.editions.map((e) => [e.publicId, e]));
    expect(byId.get(22)?.extentForVolume).toBe("complete");
    expect(byId.get(23)?.extentForVolume).toBe("partial");
    expect(byId.get(23)?.extentNote).toBe("First half only.");

    // The omnibus case: full ordered Coverage spans Vols 1–3, and its
    // composed title carries Edition Line numbering, not Volume numbering.
    const omnibus = byId.get(22)!;
    expect(omnibus.title).toBe("S Monster Edition 1");
    expect(omnibus.linePosition).toBe("1");
    expect(omnibus.coverage.map((c) => c.label)).toEqual(["1", "2", "3"]);
  });

  it("anchors Release rows by ISBN else doc ID and links containing Bundles", async () => {
    const t = convexTest(schema);
    const { r2 } = await seed(t);

    const page = await t.query(api.catalogPages.volumePage, { publicId: 11 });
    const standard = page!.editions.find((e) => e.publicId === 21)!;
    // Date-sorted rows: r1 (2015) before r2 (2016).
    expect(standard.releases.map((r) => r.anchor)).toEqual([R1_ISBN13, r2]);
    expect(standard.releases[0]).toMatchObject({
      isbn13: R1_ISBN13,
      isbn10: R1_ISBN10,
      binding: "paperback",
      variants: [{ name: "Box-set exclusive cover" }],
      bundles: [{ publicId: 31, name: "S Complete Box Set" }],
    });
  });

  it("resolves a merged Volume to its survivor so the route can 301", async () => {
    const t = convexTest(schema);
    const { seriesId, v1 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("volumes", {
        status: "merged",
        mergedIntoId: v1,
        publicId: 19,
        seriesId,
        position: 99,
      });
    });
    const page = await t.query(api.catalogPages.volumePage, { publicId: 19 });
    expect(page?.volume.publicId).toBe(11);
  });

  it("returns null for unknown/hidden Volumes and hidden Series", async () => {
    const t = convexTest(schema);
    const { seriesId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("volumes", {
        status: "hidden",
        publicId: 18,
        seriesId,
        position: 4,
      });
      const hiddenSeries = await ctx.db.insert("series", {
        status: "hidden",
        publicId: 2,
        title: "H",
        altTitles: [],
        searchText: "H",
      });
      await ctx.db.insert("volumes", {
        status: "active",
        publicId: 17,
        seriesId: hiddenSeries,
        position: 1,
      });
    });
    expect(await t.query(api.catalogPages.volumePage, { publicId: 18 })).toBeNull();
    expect(await t.query(api.catalogPages.volumePage, { publicId: 17 })).toBeNull();
    expect(await t.query(api.catalogPages.volumePage, { publicId: 99 })).toBeNull();
  });
});

describe("catalogPages.editionPage", () => {
  it("shows Release rows with ISBNs, dates, Format/Binding, Variants beneath", async () => {
    const t = convexTest(schema);
    await seed(t);

    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.edition).toMatchObject({
      publicId: 21,
      title: "S Vol 1",
      lineName: null,
      publisher: { name: "VIZ Media", slug: "viz-media" },
    });
    expect(page?.series).toEqual([{ publicId: 1, title: "S", mature: false }]);
    expect(page?.releases).toHaveLength(2);
    const [physical, digital] = page!.releases;
    expect(physical).toMatchObject({
      format: "physical",
      binding: "paperback",
      isbn13: R1_ISBN13,
      isbn10: R1_ISBN10,
      pubDate: { year: 2015, month: 6, day: 16, sort: 20150616 },
      variants: [{ name: "Box-set exclusive cover" }],
      bundles: [{ publicId: 31, name: "S Complete Box Set" }],
    });
    expect(digital).toMatchObject({ format: "digital", isbn13: null, variants: [] });
    // One description for the book, none per row.
    expect(page?.description).toEqual({ source: "release", text: "Back-cover blurb." });
    for (const row of page!.releases) expect(row).not.toHaveProperty("description");
  });

  it("composes the omnibus title from the Edition Line and lists full Coverage", async () => {
    const t = convexTest(schema);
    await seed(t);
    const page = await t.query(api.catalogPages.editionPage, { publicId: 22 });
    expect(page?.edition.title).toBe("S Monster Edition 1");
    expect(page?.edition.lineName).toBe("Monster Edition");
    expect(page?.edition.linePosition).toBe("1");
    expect(page?.coverage.map((c) => [c.label, c.extent])).toEqual([
      ["1", "complete"],
      ["2", "complete"],
      ["3", "complete"],
    ]);
  });

  it("resolves a merged Edition to its survivor and hides hidden ones", async () => {
    const t = convexTest(schema);
    const { publisherId, standard } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("editions", {
        status: "merged",
        mergedIntoId: standard,
        publicId: 29,
        publisherId,
      });
      await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 28,
        publisherId,
      });
    });
    const merged = await t.query(api.catalogPages.editionPage, { publicId: 29 });
    expect(merged?.edition.publicId).toBe(21);
    expect(await t.query(api.catalogPages.editionPage, { publicId: 28 })).toBeNull();
  });

  it("wears the jacket its Release rows wear in the browser", async () => {
    const t = convexTest(schema);
    const { publisherId, seriesId, v1, r2 } = await seed(t);
    const { artUrl } = await t.run(async (ctx) => {
      // Art stored on the digital Release only.
      const art = await ctx.storage.store(
        new Blob([new Uint8Array(MIN_COVER_BYTES + 1)], { type: "image/jpeg" }),
      );
      await ctx.db.patch(r2, { coverImage: { storageId: art } });
      // An ISBN-less Edition of Vol 1, as a publisher's own site lists it.
      const bare = await ctx.db.insert("editions", { status: "active", publicId: 24, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId: bare, volumeId: v1, order: 1, extent: "complete" });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: bare,
        format: "physical",
        language: "en",
        pubDate: { year: 2015, month: 6, day: 20, sort: 20150620 },
        publisherId,
        seriesIds: [seriesId],
      });
      return { artUrl: await ctx.storage.getUrl(art) };
    });

    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page).toMatchObject({ coverUrl: artUrl, coverIsbns: [R1_ISBN13] });
    const june = await t.query(api.releases.monthBrowse, { year: 2015, month: 6 });
    const january = await t.query(api.releases.monthBrowse, { year: 2016, month: 1 });
    const rows = [...june.releases, ...january.releases].filter((r) => r.edition.publicId === 21);
    expect(rows.map((r) => [r.format, r.coverUrl, r.coverIsbns])).toEqual([
      ["physical", page!.coverUrl, page!.coverIsbns],
      ["digital", page!.coverUrl, page!.coverIsbns],
    ]);

    // The ISBN-less Edition borrows the same Volume's ISBN on its page as on its row.
    const barePage = await t.query(api.catalogPages.editionPage, { publicId: 24 });
    expect(barePage).toMatchObject({ coverUrl: null, coverIsbns: [R1_ISBN13] });
    const bareRow = june.releases.find((r) => r.edition.publicId === 24);
    expect(bareRow).toMatchObject({ coverUrl: null, coverIsbns: [R1_ISBN13] });
  });
});

/** The seed Series' synopsis as a page's flagged, named fallback. */
const SERIES_FALLBACK = {
  source: "series",
  text: "Series synopsis.",
  series: { publicId: 1, title: "S" },
};

describe("Edition Description", () => {
  // The seed's standard Edition 21: r1 (physical) carries "Back-cover
  // blurb.", r2 (digital) is blank.
  it("collapses identical physical and digital blurbs to one", async () => {
    const t = convexTest(schema);
    const { r2 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r2, { description: "Back-cover blurb." });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.description).toEqual({ source: "release", text: "Back-cover blurb." });
    for (const row of page!.releases) expect(row).not.toHaveProperty("description");
  });

  it("fills an Edition from its one described Release", async () => {
    const t = convexTest(schema);
    const { r1, r2 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { description: undefined });
      await ctx.db.patch(r2, { description: "Digital blurb." });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.description).toEqual({ source: "release", text: "Digital blurb." });
  });

  it("lets a Human Override of a description win over the physical default", async () => {
    const t = convexTest(schema);
    const { r2 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r2, { description: "Corrected.", overriddenFields: ["description"] });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.description).toEqual({ source: "release", text: "Corrected." });
  });

  it("borrows the Volume Synopsis only for one whole Volume, else the flagged Series synopsis", async () => {
    const t = convexTest(schema);
    const { seriesId, v1, v3, r1 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { description: undefined });
      await ctx.db.patch(v1, { synopsis: "Vol 1 synopsis." });
      await ctx.db.patch(v3, { synopsis: "Vol 3 synopsis." });
      await ctx.db.patch(seriesId, { synopsis: "Series synopsis." });
    });
    const page = (publicId: number) => t.query(api.catalogPages.editionPage, { publicId });
    // The blurbless standard Edition of Vol 1 borrows its Volume's.
    expect((await page(21))?.description).toEqual({ source: "volume", text: "Vol 1 synopsis." });
    // The omnibus (Vols 1–3) never borrows one Volume's, nor does the split
    // part of Vol 3: both fall to the Series synopsis, flagged as such.
    expect((await page(22))?.description).toEqual(SERIES_FALLBACK);
    expect((await page(23))?.description).toEqual(SERIES_FALLBACK);
  });

  it("never uses a hidden or merged Release's blurb", async () => {
    const t = convexTest(schema);
    const { publisherId, seriesId, standard, r1 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { description: undefined });
      await ctx.db.insert("releases", {
        status: "hidden",
        editionId: standard,
        format: "physical",
        language: "en",
        description: "Hidden blurb.",
        publisherId,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("releases", {
        status: "merged",
        mergedIntoId: r1,
        editionId: standard,
        format: "physical",
        language: "en",
        description: "Merged blurb.",
        publisherId,
        seriesIds: [seriesId],
      });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.description).toBeNull();
  });

  it("does not borrow the remaining Volume's synopsis when one of two is hidden", async () => {
    const t = convexTest(schema);
    const { publisherId, seriesId, v1, v2 } = await seed(t);
    await t.run(async (ctx) => {
      const pair = await ctx.db.insert("editions", { status: "active", publicId: 27, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId: pair, volumeId: v1, order: 1, extent: "complete" });
      await ctx.db.insert("volumeCoverages", { editionId: pair, volumeId: v2, order: 2, extent: "complete" });
      await ctx.db.patch(v2, { status: "hidden" });
      await ctx.db.patch(v1, { synopsis: "Vol 1 synopsis." });
      await ctx.db.patch(seriesId, { synopsis: "Series synopsis." });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 27 });
    expect(page?.coverage.map((c) => c.volumePublicId)).toEqual([11]);
    expect(page?.description).toEqual(SERIES_FALLBACK);
  });

  it("falls back to its line's Series synopsis for Unmapped Packaging", async () => {
    const t = convexTest(schema);
    const { publisherId, seriesId } = await seed(t);
    await t.run(async (ctx) => {
      const line = await ctx.db.query("editionLines").first();
      await ctx.db.insert("editions", {
        status: "active",
        publicId: 28,
        publisherId,
        editionLineId: line!._id,
        linePosition: "9",
        coverageUnmapped: true,
      });
      await ctx.db.patch(seriesId, { synopsis: "Series synopsis." });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 28 });
    expect(page?.coverage).toEqual([]);
    expect(page?.description).toEqual(SERIES_FALLBACK);
  });

  it("is null when nothing at all describes the book", async () => {
    const t = convexTest(schema);
    await seed(t);
    const page = await t.query(api.catalogPages.editionPage, { publicId: 22 });
    expect(page?.description).toBeNull();
  });
});

describe("Volume page description", () => {
  /**
   * Beside the seed: a deluxe Edition Line member covering Vol 2 alone and
   * completely, and an earlier Kodansha paperback of Vol 1; the omnibus and
   * the split part carry blurbs of their own.
   */
  async function seedLenders(t: ReturnType<typeof convexTest>) {
    const ids = await seed(t);
    const lenders = await t.run(async (ctx) => {
      const { publisherId, seriesId, v1, v2, r3, r4 } = ids;
      await ctx.db.patch(r3, { description: "Omnibus blurb." });
      await ctx.db.patch(r4, { description: "Split blurb." });

      const deluxeLine = await ctx.db.insert("editionLines", {
        status: "active",
        seriesId,
        publisherId,
        name: "Deluxe Edition",
      });
      const deluxe = await ctx.db.insert("editions", {
        status: "active",
        publicId: 25,
        publisherId,
        editionLineId: deluxeLine,
        linePosition: "2",
      });
      await ctx.db.insert("volumeCoverages", { editionId: deluxe, volumeId: v2, order: 1, extent: "complete" });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: deluxe,
        format: "physical",
        language: "en",
        description: "Deluxe blurb.",
        publisherId,
        seriesIds: [seriesId],
      });

      const kodansha = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha",
        slug: "kodansha",
      });
      const early = await ctx.db.insert("editions", { status: "active", publicId: 26, publisherId: kodansha });
      await ctx.db.insert("volumeCoverages", { editionId: early, volumeId: v1, order: 1, extent: "complete" });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: early,
        format: "physical",
        language: "en",
        pubDate: { year: 2010, sort: 20100000 },
        description: "Kodansha blurb.",
        publisherId: kodansha,
        seriesIds: [seriesId],
      });
      return { kodansha, early };
    });
    return { ...ids, ...lenders };
  }

  const volume = (t: ReturnType<typeof convexTest>, publicId: number) =>
    t.query(api.catalogPages.volumePage, { publicId });

  it("borrows the representative blurb of whole single-volume, line-less Editions, naming the Edition", async () => {
    const t = convexTest(schema);
    await seedLenders(t);
    const page = await volume(t, 11);
    // Kodansha's 2010 paperback outranks VIZ's 2015 one; the omnibus never lends.
    expect(page?.description).toEqual({
      source: "edition",
      text: "Kodansha blurb.",
      edition: { publicId: 26, title: "S Vol 1", publisherName: "Kodansha" },
    });
    for (const edition of page!.editions) {
      for (const row of edition.releases) expect(row).not.toHaveProperty("description");
    }
  });

  it("never borrows from an omnibus, a split part, or a line's packaging", async () => {
    const t = convexTest(schema);
    const { seriesId } = await seedLenders(t);
    // Vol 2: only the omnibus and the deluxe line member cover it. Vol 3: the
    // omnibus and the split part.
    expect((await volume(t, 12))?.description).toBeNull();
    expect((await volume(t, 13))?.description).toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.patch(seriesId, { synopsis: "Series synopsis." });
    });
    expect((await volume(t, 12))?.description).toEqual(SERIES_FALLBACK);
  });

  it("skips a hidden lender Edition", async () => {
    const t = convexTest(schema);
    const { early } = await seedLenders(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(early, { status: "hidden" });
    });
    expect((await volume(t, 11))?.description).toEqual({
      source: "edition",
      text: "Back-cover blurb.",
      edition: { publicId: 21, title: "S Vol 1", publisherName: "VIZ Media" },
    });
  });

  it("names no Publisher for a lender whose Publisher is hidden", async () => {
    const t = convexTest(schema);
    const { kodansha } = await seedLenders(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(kodansha, { status: "hidden" });
    });
    expect((await volume(t, 11))?.description).toMatchObject({
      source: "edition",
      edition: { publicId: 26, publisherName: null },
    });
  });

  it("ranks a publishing Publisher's blurb ahead of a defunct one's earlier book", async () => {
    const t = convexTest(schema);
    const { kodansha } = await seedLenders(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(kodansha, { defunct: true });
    });
    expect((await volume(t, 11))?.description).toMatchObject({
      source: "edition",
      text: "Back-cover blurb.",
      edition: { publicId: 21 },
    });
  });

  it("shows the Volume Synopsis ahead of any borrowed blurb", async () => {
    const t = convexTest(schema);
    const { v1 } = await seedLenders(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(v1, { synopsis: "Curated synopsis." });
    });
    expect((await volume(t, 11))?.description).toEqual({ source: "volume", text: "Curated synopsis." });
  });
});

describe("Edition maturity", () => {
  // B34: maturity is the content's, not what the page may display of it.
  it("stays mature after its only covered Volume is hidden", async () => {
    const t = convexTest(schema);
    const { seriesId, v1 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seriesId, { mature: true });
      await ctx.db.patch(v1, { status: "hidden" });
    });
    // The lineless standard Edition of Vol 1 now lists no coverage.
    const page = await t.query(api.catalogPages.editionPage, { publicId: 21 });
    expect(page?.coverage).toEqual([]);
    expect(page?.mature).toBe(true);
    const sitemap = await t.query(api.seo.sitemapPage, {
      entity: "edition",
      paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(sitemap.entries).toEqual([]);
  });
});

describe("catalogPages.bundlePage", () => {
  it("lists members in order with pinned Variants and Edition backlinks", async () => {
    const t = convexTest(schema);
    await seed(t);

    const page = await t.query(api.catalogPages.bundlePage, { publicId: 31 });
    expect(page?.bundle).toMatchObject({
      publicId: 31,
      name: "S Complete Box Set",
      format: "physical",
      isbn13: BUNDLE_ISBN13,
      publisher: { name: "VIZ Media", slug: "viz-media" },
    });
    expect(page?.members).toEqual([
      expect.objectContaining({
        order: 1,
        edition: { publicId: 21, title: "S Vol 1" },
        anchor: R1_ISBN13,
        pinnedVariant: { name: "Box-set exclusive cover" },
      }),
      expect.objectContaining({
        order: 2,
        edition: { publicId: 22, title: "S Monster Edition 1" },
        anchor: OMNIBUS_ISBN13,
        pinnedVariant: null,
      }),
    ]);
  });

  it("drops members whose Release is hidden and returns null for hidden Bundles", async () => {
    const t = convexTest(schema);
    const { publisherId, bundleId, r1 } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { status: "hidden" });
      await ctx.db.insert("releaseBundles", {
        status: "hidden",
        publicId: 39,
        name: "Hidden Set",
        publisherId,
      });
      void bundleId;
    });
    const page = await t.query(api.catalogPages.bundlePage, { publicId: 31 });
    expect(page?.members.map((m) => m.edition.publicId)).toEqual([22]);
    expect(await t.query(api.catalogPages.bundlePage, { publicId: 39 })).toBeNull();
  });
});

describe("catalogPages.isbnLookup", () => {
  it("resolves a Release ISBN-13 to its Edition anchored at the Release", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: R1_ISBN13 })).toEqual({
      kind: "release",
      edition: { publicId: 21, title: "S Vol 1" },
      anchor: R1_ISBN13,
    });
  });

  it("resolves a Release ISBN-10, anchoring by the row's own rule", async () => {
    const t = convexTest(schema);
    await seed(t);
    // Matched by ISBN-10, but the row anchors by ISBN-13 when it has one.
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: R1_ISBN10 })).toEqual({
      kind: "release",
      edition: { publicId: 21, title: "S Vol 1" },
      anchor: R1_ISBN13,
    });
  });

  it("resolves a box-set ISBN to its Bundle page", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(
      await t.query(api.catalogPages.isbnLookup, { isbn: BUNDLE_ISBN13 }),
    ).toEqual({
      kind: "bundle",
      bundle: { publicId: 31, name: "S Complete Box Set" },
    });
  });

  it("lets a Release match win a Release/Bundle conflict", async () => {
    const t = convexTest(schema);
    const { publisherId } = await seed(t);
    await t.run(async (ctx) => {
      // A (data-error) Bundle carrying a Release's ISBN: the Release wins.
      await ctx.db.insert("releaseBundles", {
        status: "active",
        publicId: 32,
        name: "Conflicting Set",
        publisherId,
        isbn13: R1_ISBN13,
      });
    });
    const target = await t.query(api.catalogPages.isbnLookup, { isbn: R1_ISBN13 });
    expect(target?.kind).toBe("release");
  });

  it("skips hidden Releases (falling through to a Bundle match) and follows merges", async () => {
    const t = convexTest(schema);
    const { publisherId, seriesId, standard, r1 } = await seed(t);
    const hiddenIsbn = "9781999000998";
    const mergedIsbn = "9781999000999";
    await t.run(async (ctx) => {
      await ctx.db.insert("releases", {
        status: "hidden",
        editionId: standard,
        format: "physical",
        language: "en",
        isbn13: hiddenIsbn,
        publisherId,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("releaseBundles", {
        status: "active",
        publicId: 33,
        name: "Fallback Set",
        publisherId,
        isbn13: hiddenIsbn,
      });
      // A merged Release resolves to its survivor; the anchor is the
      // survivor's.
      await ctx.db.insert("releases", {
        status: "merged",
        mergedIntoId: r1,
        editionId: standard,
        format: "physical",
        language: "en",
        isbn13: mergedIsbn,
        publisherId,
        seriesIds: [seriesId],
      });
    });

    expect(await t.query(api.catalogPages.isbnLookup, { isbn: hiddenIsbn })).toEqual({
      kind: "bundle",
      bundle: { publicId: 33, name: "Fallback Set" },
    });
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: mergedIsbn })).toEqual({
      kind: "release",
      edition: { publicId: 21, title: "S Vol 1" },
      anchor: R1_ISBN13,
    });
  });

  it("returns null for an unknown ISBN", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(
      await t.query(api.catalogPages.isbnLookup, { isbn: "9780000000000" }),
    ).toBeNull();
  });
});
