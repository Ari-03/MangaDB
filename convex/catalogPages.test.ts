import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
    await ctx.db.insert("releases", {
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

    return { publisherId, seriesId, v1, v2, v3, standard, omnibus, split, r1, r2, r3, bundleId };
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
    expect(page?.series).toEqual([{ publicId: 1, title: "S" }]);
    expect(page?.releases).toHaveLength(2);
    const [physical, digital] = page!.releases;
    expect(physical).toMatchObject({
      format: "physical",
      binding: "paperback",
      isbn13: R1_ISBN13,
      isbn10: R1_ISBN10,
      pubDate: { year: 2015, month: 6, day: 16, sort: 20150616 },
      description: "Back-cover blurb.",
      variants: [{ name: "Box-set exclusive cover" }],
      bundles: [{ publicId: 31, name: "S Complete Box Set" }],
    });
    expect(digital).toMatchObject({ format: "digital", isbn13: null, variants: [] });
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
