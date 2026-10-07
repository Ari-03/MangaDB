// Splitting a franchise into Series (the held-book category pass,
// 2026-10): a split that only adds a Part's backbone Volumes, a Series
// Family grouping the Parts, an Edition Line member no source maps
// (created, or moved off its Volume), two books of one Edition split
// apart, and ANN's one manga entry for the
// franchise linking a Part's line by ISBN once the Parts share a Family.

import { describe, expect, it } from "vitest";

import { api, internal } from "../../_generated/api";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "../../test.factories";
import { makeT, seedRegistry, type TestT as T } from "../../test.helpers";
import type { Id } from "../../_generated/dataModel";
import { familiesTogether } from "../../catalog";
import type { RepairEntry } from "./entries";

async function run(t: T, entries: RepairEntry[]) {
  return await t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: "ari" });
}

/** An administrator, VIZ, and "JoJo's Bizarre Adventure" with one Volume and its Release. */
async function seed(t: T) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "Ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media" });
    const seriesId = await insertSeries(ctx, { title: "JoJo's Bizarre Adventure" });
    const volumeId = await insertVolume(ctx, { seriesId, label: "5", position: 5 });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781421591711",
      format: "physical",
      binding: "hardcover",
    });
    return { publisherId, seriesId, volumeId, editionId, releaseId };
  });
}

const PART_4 = "JoJo's Bizarre Adventure: Part 4--Diamond Is Unbreakable";

describe("franchise repairs", () => {
  it("splits off a Part that only has backbone Volumes, and groups the Parts in a Family", async () => {
    const t = makeT();
    const { seriesId } = await seed(t);
    const split: RepairEntry = {
      kind: "splitSeries",
      key: "jojo-part-4",
      reason: "VIZ numbers Part 4 on its own.",
      sourceSeriesId: seriesId,
      sourceTitle: "JoJo's Bizarre Adventure",
      title: PART_4,
      altTitles: [],
      volumes: [],
      editions: [],
      placeholderLabels: ["1", "2"],
      observationIds: [],
    };
    expect((await run(t, [split]))[0]).toMatchObject({ status: "applied" });
    const part4 = await t.run(async (ctx) => {
      const series = await ctx.db
        .query("series")
        .collect()
        .then((all) => all.find((one) => one.title === PART_4)!);
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["1", "2"]);
      return series._id;
    });

    const family: RepairEntry = {
      kind: "seriesFamily",
      key: "jojo-family",
      reason: "The Parts of one franchise.",
      name: "JoJo's Bizarre Adventure",
      series: [
        { seriesId, title: "JoJo's Bizarre Adventure" },
        { seriesId: part4, title: PART_4 },
      ],
    };
    expect((await run(t, [family]))[0]).toMatchObject({ status: "applied" });
    expect((await run(t, [family]))[0]).toMatchObject({ status: "alreadyApplied" });
    await t.run(async (ctx) => {
      const [one] = await ctx.db.query("seriesFamilies").collect();
      expect(one?.name).toBe("JoJo's Bizarre Adventure");
      expect(await ctx.db.get(seriesId)).toMatchObject({ familyId: one?._id, familyPosition: 1 });
      expect(await ctx.db.get(part4)).toMatchObject({ familyId: one?._id, familyPosition: 2 });
    });

    // Listed in another order, the Parts take their new places on the shelf.
    const reordered: RepairEntry = {
      ...family,
      key: "jojo-family-order",
      series: [...family.series].reverse(),
    };
    expect((await run(t, [reordered]))[0]).toMatchObject({ status: "applied" });
    const publicId = await t.run(async (ctx) => (await ctx.db.get(seriesId))!.publicId);
    const page = await t.query(api.catalog.seriesPage, { publicId });
    expect(page?.family?.members.map((m) => m.title)).toEqual([PART_4, "JoJo's Bizarre Adventure"]);
  });

  it("creates an unmapped line member, and moves an Edition off its Volume into one", async () => {
    const t = makeT();
    const { publisherId, seriesId, volumeId, editionId, releaseId } = await seed(t);
    const line = { name: "Hardcover Edition", position: "1" };
    const create: RepairEntry = {
      kind: "createRelease",
      key: "jojo-sc-hc-1",
      reason: "VIZ's Stardust Crusaders hardcover 1.",
      isbn13: "9781421590653",
      isbn10: null,
      format: "physical",
      binding: "hardcover",
      pubDate: { year: 2016, month: 11, day: 1, sort: 20161101 },
      price: null,
      publisherId,
      coverage: [],
      line,
      sources: ["https://www.viz.com/"],
      unmappedSeriesId: seriesId,
    };
    const unmap: RepairEntry = {
      kind: "setCoverage",
      key: "jojo-sc-hc-5",
      reason: "VIZ's Stardust Crusaders hardcover 5 splits the content otherwise.",
      editionId,
      before: [volumeId],
      coverage: [],
      line: { seriesId, name: "Hardcover Edition", position: "5" },
      retireVolumeIds: [],
      unmapped: true,
    };
    const outcomes = await run(t, [create, unmap]);
    expect(outcomes.map((o: { status: string }) => o.status)).toEqual(["applied", "applied"]);
    expect((await run(t, [create, unmap])).map((o: { status: string }) => o.status)).toEqual([
      "alreadyApplied",
      "alreadyApplied",
    ]);
    await t.run(async (ctx) => {
      const editions = await ctx.db.query("editions").collect();
      const members = editions.filter((e) => e.editionLineId !== undefined);
      expect(members.map((e) => [e.linePosition, e.coverageUnmapped]).sort()).toEqual([
        ["1", true],
        ["5", true],
      ]);
      expect(await ctx.db.query("volumeCoverages").collect()).toEqual([]);
      const created = await ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", "9781421590653"))
        .unique();
      expect(created?.seriesIds).toEqual([seriesId]);
      expect((await ctx.db.get(releaseId))?.seriesIds).toEqual([seriesId]);
    });
  });

  it("moves one book out of a shared Edition onto another Series' Volume", async () => {
    const t = makeT();
    const { publisherId, seriesId, editionId, releaseId } = await seed(t);
    const { part1, ebookId } = await t.run(async (ctx) => ({
      part1: await insertSeries(ctx, { title: "JoJo's Bizarre Adventure: Part 1--Phantom Blood" }),
      // The Part 3 ebook of vol 5, imported into the hardcover's Edition.
      ebookId: await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: "9781421578873",
        format: "digital",
      }),
    }));
    const entry: RepairEntry = {
      kind: "splitEdition",
      key: "jojo-split-5",
      reason: "The hardcover is another Part's book.",
      editionId,
      releaseIds: [releaseId],
      keepReleaseIds: [ebookId],
      coverage: [{ seriesId: part1, label: "1", extent: "complete" }],
      line: null,
    };
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "applied" });
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "alreadyApplied" });
    await t.run(async (ctx) => {
      const moved = await ctx.db.get(releaseId);
      expect(moved?.editionId).not.toBe(editionId);
      expect(moved?.seriesIds).toEqual([part1]);
      expect((await ctx.db.get(ebookId))?.editionId).toBe(editionId);
      const [cover] = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", moved!.editionId))
        .collect();
      expect(await ctx.db.get(cover!.volumeId)).toMatchObject({ seriesId: part1, label: "1" });
    });
  });

  it("links ANN's line on a sibling Part by ISBN only when the Parts share a Family", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { publisherId, seriesId } = await seed(t);
    const { part4, releaseId } = await t.run(async (ctx) => {
      const part4 = await insertSeries(ctx, { title: PART_4 });
      const volumeId = await insertVolume(ctx, { seriesId: part4, label: "2", position: 2 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [part4],
        isbn13: "9781974708086",
        format: "physical",
        binding: "hardcover",
      });
      // ANN's one entry for every Part, linked to the Series it was built as.
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:1900",
        recordRef: { type: "series", id: seriesId },
        snapshot: { releases: [] },
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:47619",
        snapshot: {
          kind: "annRelease",
          annId: "47619",
          mangaId: "1900",
          url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=47619",
          title: PART_4,
          label: "2",
          multi: false,
          format: "physical",
          editionLineHint: false,
          isbn13: "9781974708086",
          date: { year: 2019, month: 8, day: 6 },
          page: {
            status: "ok",
            fetchedAt: 1,
            distributor: "VIZ Media",
            volume: "GN 2",
            isbn13: "9781974708086",
            date: { year: 2019, month: 8, day: 6 },
          },
        },
      });
      return { part4, releaseId };
    });
    const apply = () => t.mutation(internal.ann.applyReleasePage, { annId: "47619" });
    expect(await apply()).toMatchObject({ status: "recordOnly" });

    await t.run(async (ctx) => {
      const familyId = await ctx.db.insert("seriesFamilies", {
        status: "active",
        name: "JoJo's Bizarre Adventure",
      });
      await ctx.db.patch(seriesId, { familyId });
      await ctx.db.patch(part4, { familyId });
    });
    expect(await apply()).toMatchObject({ status: "linked", releaseId });
    expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toEqual([]);
  });
});

describe("familiesTogether", () => {
  it("keeps a Family together in reading order where its best hit ranks", () => {
    const hit = (id: string, familyId?: string, familyPosition?: number) => ({
      id,
      ...(familyId ? { familyId: familyId as Id<"seriesFamilies"> } : {}),
      ...(familyPosition ? { familyPosition } : {}),
    });
    const ranked = [hit("p3", "jojo", 3), hit("other"), hit("p1", "jojo", 1), hit("p2", "jojo", 2)];
    expect(familiesTogether(ranked).map((h) => h.id)).toEqual(["p1", "p2", "p3", "other"]);
  });
});
