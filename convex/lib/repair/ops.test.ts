// Personal tracking follows the catalog repair's moves (lib/repair/ops.ts):
// a Series split re-files the moved work's Volume and Release Progress,
// Favorites and Comments under the split-off Series without widening the
// reader's Tracking Visibility (B10), and a box-set Release converted to a
// Release Bundle hands its Collection Entries to the bundle (B11). Neither
// lands in a public Revision; the Proposal's ops keep the trail.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import type { RepairEntry } from "./entries";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

const READER = "reader";
const OTHER = "other";
const asReader = (t: T) => t.withIdentity({ subject: READER });

async function run(t: T, entries: RepairEntry[]) {
  return await t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: "ari" });
}

/**
 * The repair's Administrator, a reader whose Reading default is public (but
 * private for the Series being split), another reader, a publisher, and a
 * Series "Doubt!!" holding two works: vol 1 stays, an unlabeled Volume is
 * wholly the second work's vol 1, and the shared vol "2" carries the second
 * work's Edition. The reader is mid-way through both of the second work's
 * books and has read its vol 1.
 */
async function seed(t: T) {
  return await t.run(async (ctx) => {
    const user = (clerkSubject: string, username: string, readingVisibility: "public" | "private", role?: "administrator") =>
      ctx.db.insert("users", {
        clerkSubject,
        username,
        usernameNormalized: username.toLowerCase(),
        role,
        formatPreference: "both",
        ownershipVisibility: "private",
        readingVisibility,
      });
    await user("admin", "Ari", "private", "administrator");
    const reader = await user(READER, "dave", "public");
    const other = await user(OTHER, "erin", "private");
    const publisherId = await ctx.db.insert("publishers", { status: "active", name: "Yen Press", slug: "yen-press" });
    const source = await ctx.db.insert("series", {
      status: "active",
      publicId: 500,
      title: "Doubt!!",
      altTitles: [],
      searchText: "Doubt!!",
    });
    const vol = (label: string | undefined, position: number, publicId: number) =>
      ctx.db.insert("volumes", { status: "active", publicId, seriesId: source, label, position });
    const edition = async (volumeId: Id<"volumes">, publicId: number, isbn13: string) => {
      const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13,
        publisherId,
        seriesIds: [source],
      });
      return { editionId, releaseId };
    };
    const a1 = await vol("1", 1, 501);
    const shared2 = await vol("2", 2, 502);
    const unlabeled = await vol(undefined, 3, 503);
    await edition(a1, 511, "9781591169086");
    const b2 = await edition(shared2, 512, "9780316335164");
    const b1 = await edition(unlabeled, 513, "9780316335157");

    await ctx.db.insert("userSeriesStates", {
      userId: reader,
      seriesId: source,
      following: false,
      followPromptDismissed: false,
      readingVisibility: "private",
    });
    await ctx.db.insert("volumeProgress", { userId: reader, volumeId: unlabeled, seriesId: source, readCount: 1 });
    await ctx.db.insert("releaseProgress", { userId: reader, releaseId: b1.releaseId, seriesId: source, percent: 40 });
    await ctx.db.insert("releaseProgress", { userId: reader, releaseId: b2.releaseId, seriesId: source, percent: 10 });
    await ctx.db.insert("favorites", { userId: reader, seriesId: source, volumeId: unlabeled });
    await ctx.db.insert("comments", {
      userId: other,
      seriesId: source,
      volumeId: unlabeled,
      body: "Great twist.",
      spoiler: false,
      status: "approved",
      reportCount: 0,
      createdAt: 0,
    });

    const entry: RepairEntry = {
      kind: "splitSeries",
      key: "split:doubt",
      reason: "two works",
      sourceSeriesId: source,
      sourceTitle: "Doubt!!",
      title: "Doubt",
      altTitles: [],
      volumes: [{ volumeId: unlabeled, label: null, newLabel: "1", editionIds: [b1.editionId] }],
      editions: [{ editionId: b2.editionId, fromVolumeIds: [shared2], labels: ["2"], releaseIds: [b2.releaseId] }],
      placeholderLabels: [],
      observationIds: [],
    };
    return { reader, other, publisherId, source, unlabeled, b1, b2, entry };
  });
}

const splitOff = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("series").collect()).find((row) => row.title === "Doubt")!);

/** Every personal row the split should have re-filed, with the Series it now sits under. */
const personalSeries = (t: T, s: Awaited<ReturnType<typeof seed>>) =>
  t.run(async (ctx) => ({
    volumeProgress: (await ctx.db.query("volumeProgress").collect()).map((row) => row.seriesId),
    b1Pass: (await ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", s.b1.releaseId)).unique())?.seriesId,
    b2Pass: (await ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", s.b2.releaseId)).unique())?.seriesId,
    favorites: (await ctx.db.query("favorites").collect()).map((row) => row.seriesId),
    comments: (await ctx.db.query("comments").collect()).map((row) => row.seriesId),
  }));

describe("series split (B10)", () => {
  it("re-files the moved work's personal tracking under the split-off Series", async () => {
    const t = makeT();
    const s = await seed(t);
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = await splitOff(t);

    expect(await personalSeries(t, s)).toEqual({
      volumeProgress: [target._id],
      b1Pass: target._id,
      b2Pass: target._id,
      favorites: [target._id],
      comments: [target._id],
    });

    // myReading groups both passes and the read Volume under the new Series.
    const reading = await asReader(t).query(api.reading.myReading, {});
    const rows = reading!.series.map((row) => ({ title: row.title, read: row.volumesRead, passes: row.passes.length }));
    expect(rows).toEqual([{ title: "Doubt", read: 1, passes: 2 }]);

    // The reader's Reading of "Doubt!!" was private; the moved work stays so.
    const visibility = await asReader(t).query(api.sharing.seriesVisibility, { seriesPublicId: target.publicId });
    expect(visibility?.overrides.reading).toBe("private");

    // Personal rows stay out of the public Revisions; the Proposal records them.
    const trail = await t.run(async (ctx) => ({
      revisions: (await ctx.db.query("revisions").collect()).flatMap((r) => r.changes.map((c) => c.field)),
      ops: (await ctx.db.query("proposalVersions").collect()).flatMap((v) => v.ops),
    }));
    expect(trail.revisions).not.toContain("personalTracking");
    const recorded = trail.ops.flatMap((op) => (op.kind === "update" ? op.changes : [])).filter((c) => c.field === "personalTracking");
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(s.reader);

    expect((await run(t, [s.entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("heals a split that ran before personal tracking followed the move", async () => {
    const t = makeT();
    const s = await seed(t);
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = await splitOff(t);
    // Put the rows back where the old split left them.
    await t.run(async (ctx) => {
      for (const table of ["volumeProgress", "releaseProgress", "favorites", "comments"] as const) {
        for (const row of await ctx.db.query(table).collect()) await ctx.db.patch(row._id, { seriesId: s.source });
      }
    });
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    expect(await personalSeries(t, s)).toEqual({
      volumeProgress: [target._id],
      b1Pass: target._id,
      b2Pass: target._id,
      favorites: [target._id],
      comments: [target._id],
    });
  });
});

describe("box set to bundle (B11)", () => {
  /** A box-set Release on its own Edition, the reader owning it, and two member Releases. */
  async function seedBox(t: T) {
    const s = await seed(t);
    return await t.run(async (ctx) => {
      const series = await ctx.db.insert("series", { status: "active", publicId: 700, title: "Noragami", altTitles: [], searchText: "Noragami" });
      const volume = (label: string, publicId: number) =>
        ctx.db.insert("volumes", { status: "active", publicId, seriesId: series, label, position: Number(label) || 9 });
      const release = async (volumeId: Id<"volumes">, publicId: number, isbn13: string) => {
        const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId: s.publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
        const releaseId = await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          language: "en",
          isbn13,
          publisherId: s.publisherId,
          seriesIds: [series],
        });
        return { editionId, releaseId };
      };
      const v1 = await volume("1", 701);
      const v2 = await volume("2", 702);
      const boxVol = await volume("Box", 703);
      await release(v1, 711, "9780000000011");
      await release(v2, 712, "9780000000028");
      const box = await release(boxVol, 713, "9780000000059");
      const variantId = await ctx.db.insert("releaseVariants", { status: "active", releaseId: box.releaseId, name: "Exclusive" });
      await ctx.db.insert("collectionEntries", { userId: s.reader, releaseId: box.releaseId, state: "owned", variantId });
      await ctx.db.insert("collectionEntries", { userId: s.other, releaseId: box.releaseId, state: "owned" });
      return { ...s, series, v1, boxVol, box };
    });
  }

  const entriesOf = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query("collectionEntries").collect()).map(({ userId, releaseId, bundleId, state, variantId }) => ({
        userId,
        releaseId,
        bundleId,
        state,
        variantId,
      })),
    );

  it("hands the box set's Collection Entries to the new bundle (releaseBundle)", async () => {
    const t = makeT();
    const s = await seedBox(t);
    // The other reader already marked the bundle Wanted: Owned wins the clash.
    const existing = await t.run(async (ctx) => {
      const bundleId = await ctx.db.insert("releaseBundles", {
        status: "active",
        publicId: 900,
        name: "Noragami Box Set",
        publisherId: s.publisherId,
        format: "physical",
        isbn13: "9780000000059",
      });
      await ctx.db.insert("collectionEntries", { userId: s.other, bundleId, state: "wanted" });
      return bundleId;
    });
    const entry: RepairEntry = {
      kind: "releaseBundle",
      key: "b",
      reason: "box set",
      bundleId: null,
      box: { releaseId: s.box.releaseId, name: "Noragami Box Set" },
      members: [
        { isbn13: "9780000000011", order: 1 },
        { isbn13: "9780000000028", order: 2 },
      ],
      retireVolumeIds: [],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");

    const entries = await entriesOf(t);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ userId: s.reader, releaseId: undefined, bundleId: existing, state: "owned", variantId: undefined });
    expect(entries).toContainEqual({ userId: s.other, releaseId: undefined, bundleId: existing, state: "owned", variantId: undefined });

    // myLibrary shows the owned bundle, and its members by Derived Ownership.
    const library = await asReader(t).query(api.collection.myLibrary, {});
    expect(library?.bundles.map((b) => [b.title, b.state])).toEqual([["Noragami Box Set", "owned"]]);
    const shelved = library!.series.flatMap((shelf) => shelf.paths.flatMap((path) => path.books.map((book) => book.via?.bundleName)));
    expect(shelved).toEqual(["Noragami Box Set", "Noragami Box Set"]);

    const recorded = await t.run(async (ctx) =>
      (await ctx.db.query("proposalVersions").collect())
        .flatMap((v) => v.ops)
        .flatMap((op) => (op.kind === "update" ? op.changes : []))
        .filter((c) => c.field === "personalTracking"),
    );
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(s.reader);

    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("hands the box set's Collection Entries to the new bundle (remodelEdition)", async () => {
    const t = makeT();
    const s = await seedBox(t);
    const entry: RepairEntry = {
      kind: "remodelEdition",
      key: "b",
      reason: "box set",
      editionId: s.box.editionId,
      volumeId: s.boxVol,
      targetSeriesId: s.series,
      line: null,
      bundle: { name: "Noragami Box Set 1" },
      groups: [
        { releaseIds: null, coverage: ["1", "2"].map((label) => ({ label, volumeId: null, extent: "complete" as const })), linePosition: null },
      ],
      retireVolumeIds: [s.boxVol],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const bundle = await t.run(async (ctx) => (await ctx.db.query("releaseBundles").unique())!);
    const entries = await entriesOf(t);
    expect(entries).toEqual([
      { userId: s.reader, releaseId: undefined, bundleId: bundle._id, state: "owned", variantId: undefined },
      { userId: s.other, releaseId: undefined, bundleId: bundle._id, state: "owned", variantId: undefined },
    ]);
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });
});
