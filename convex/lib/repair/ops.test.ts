// Personal tracking follows the catalog repair's moves (lib/repair/ops.ts):
// a Series split re-files the moved work's Volume and Release Progress,
// Favorites and Comments under the split-off Series (B10), and a box-set
// Release converted to a Release Bundle hands its Collection Entries to the
// bundle (B11). No repair that moves tracking between Series widens what a
// User's public profile shows, whoever tracks it and however (R03, R05),
// and a re-run leaves overrides the User set since alone (R16). Neither
// lands in a public Revision; bounded repairTrails records on the Proposal
// keep the trail, and large populations move in bounded legs (Standards 1).

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { TRAIL_CHUNK } from "./audit";
import type { RepairEntry } from "./entries";
import { SWEEP_BUDGET } from "./ops";

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

  it("keeps an explicit private source override when the reader's defaults later go public", async () => {
    const t = makeT();
    const s = await seed(t);
    // Private default as well as the explicit private override on the source.
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "private" });
    const profile = () => t.query(api.sharing.publicProfile, { username: "dave" });
    expect((await profile())?.reading).toEqual([]);

    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    expect((await profile())?.reading).toEqual([]);
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    expect((await profile())?.reading).toEqual([]);
    expect((await run(t, [s.entry]))[0]?.status).toBe("alreadyApplied");
  });

  const asOther = (t: T) => t.withIdentity({ subject: OTHER });

  /**
   * The other reader tracks nothing of "Doubt!!" but one of the moved books,
   * owned only through a Bundle holding it, and shares Ownership by default
   * while keeping "Doubt!!" private (R03).
   */
  async function seedBundleOwner(t: T, member: "b1" | "b2") {
    const s = await seed(t);
    await asOther(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    await asOther(t).mutation(api.sharing.setSeriesVisibility, { seriesId: s.source, kind: "ownership", visibility: "private" });
    await t.run(async (ctx) => {
      const bundleId = await ctx.db.insert("releaseBundles", {
        status: "active",
        publicId: 950,
        name: "Doubt Box",
        publisherId: s.publisherId,
        format: "physical",
      });
      await ctx.db.insert("bundleMemberships", { bundleId, releaseId: s[member].releaseId, order: 1 });
      await ctx.db.insert("collectionEntries", { userId: s.other, bundleId, state: "owned" });
    });
    return s;
  }
  const ownedBundles = async (t: T) =>
    (await t.query(api.sharing.publicProfile, { username: "erin" }))?.ownership.bundles.map((b) => b.name);

  for (const member of ["b1", "b2"] as const) {
    it(`keeps a Bundle owned privately through a moved book (${member === "b1" ? "whole Volume" : "shared label"}) off the profile`, async () => {
      const t = makeT();
      const s = await seedBundleOwner(t, member);
      expect(await ownedBundles(t)).toEqual([]);

      expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
      expect(await ownedBundles(t)).toEqual([]);
      // The private choice is explicit on the split-off Series, so it survives
      // a later change of the owner's defaults.
      const target = await splitOff(t);
      const visibility = await asOther(t).query(api.sharing.seriesVisibility, { seriesPublicId: target.publicId });
      expect(visibility?.overrides.ownership).toBe("private");
      // The Proposal's trail records the new override row, naming no User.
      const trail = await t.run(async (ctx) => (await ctx.db.query("repairTrails").collect()).flatMap((record) => record.rows));
      expect(trail).toContainEqual(
        expect.objectContaining({ table: "userSeriesStates", field: "(inserted)", after: expect.objectContaining({ seriesId: target._id, ownershipVisibility: "private" }) }),
      );
      expect(JSON.stringify(trail)).not.toContain(s.other);
      await asOther(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "private" });
      await asOther(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
      expect(await ownedBundles(t)).toEqual([]);
      expect((await run(t, [s.entry]))[0]?.status).toBe("alreadyApplied");
      expect(await ownedBundles(t)).toEqual([]);
    });
  }

  it("leaves a public choice made on the split-off Series alone on a re-run (R16)", async () => {
    const t = makeT();
    const s = await seed(t);
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = await splitOff(t);
    const overrides = async () =>
      (await asReader(t).query(api.sharing.seriesVisibility, { seriesPublicId: target.publicId }))?.overrides;
    expect((await overrides())?.reading).toBe("private");

    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: target._id, kind: "reading", visibility: "public" });
    expect((await run(t, [s.entry]))[0]?.status).toBe("alreadyApplied");
    expect((await overrides())?.reading).toBe("public");
    const reading = (await t.query(api.sharing.publicProfile, { username: "dave" }))?.reading;
    expect(reading?.map((row) => [row.title, row.passes.length])).toEqual([["Doubt", 2]]);
  });

  it("still narrows the split-off Series for stale rows a re-run heals (R16)", async () => {
    const t = makeT();
    const s = await seed(t);
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = await splitOff(t);
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: target._id, kind: "reading", visibility: "public" });
    // A pass the old split left filed under the private source: the profile
    // hides it, as it answers to "Doubt!!" as well.
    await t.run(async (ctx) => {
      const pass = await ctx.db
        .query("releaseProgress")
        .withIndex("by_release", (q) => q.eq("releaseId", s.b1.releaseId))
        .unique();
      await ctx.db.patch(pass!._id, { seriesId: s.source });
    });
    const passes = async () =>
      (await t.query(api.sharing.publicProfile, { username: "dave" }))?.reading.flatMap((row) => row.passes);
    expect(await passes()).toHaveLength(1);

    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const visibility = await asReader(t).query(api.sharing.seriesVisibility, { seriesPublicId: target.publicId });
    expect(visibility?.overrides.reading).toBe("private");
    expect(await passes()).toHaveLength(0);
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

  /**
   * R05: the box set sits on "Doubt!!", whose Ownership the reader keeps
   * private while sharing it by default; its members sit on "Noragami",
   * which follows that public default.
   */
  async function seedPrivateBox(t: T) {
    const s = await seedBox(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.boxVol, { seriesId: s.source });
      await ctx.db.patch(s.box.releaseId, { seriesIds: [s.source] });
    });
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: s.source, kind: "ownership", visibility: "private" });
    return s;
  }
  const shown = async (t: T) => {
    const profile = await t.query(api.sharing.publicProfile, { username: "dave" });
    return [...(profile?.ownership.releases.map((r) => r.editionTitle) ?? []), ...(profile?.ownership.bundles.map((b) => b.name) ?? [])];
  };
  /** The profile stays as private after the conversion, a change of defaults, and a re-run. */
  async function expectStaysPrivate(t: T, entry: RepairEntry) {
    expect(await shown(t)).toEqual([]);
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await shown(t)).toEqual([]);
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "private" });
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    expect(await shown(t)).toEqual([]);
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
    expect(await shown(t)).toEqual([]);
  }

  it("keeps a privately owned box set private as a Bundle of public-Series members (releaseBundle)", async () => {
    const t = makeT();
    const s = await seedPrivateBox(t);
    await expectStaysPrivate(t, {
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
    });
  });

  it("keeps a privately owned box set private as a Bundle of public-Series members (remodelEdition)", async () => {
    const t = makeT();
    const s = await seedPrivateBox(t);
    await expectStaysPrivate(t, {
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
      retireVolumeIds: [],
    });
  });

  it("keeps an existing memberless Bundle's owner private when members join it", async () => {
    const t = makeT();
    const s = await seedBox(t);
    // The reader owns a Bundle with no members yet, so only their (private)
    // Ownership default governs it; "Noragami" is explicitly public.
    const bundleId = await t.run(async (ctx) => {
      const boxEntry = await ctx.db
        .query("collectionEntries")
        .withIndex("by_user_release", (q) => q.eq("userId", s.reader).eq("releaseId", s.box.releaseId))
        .unique();
      await ctx.db.delete(boxEntry!._id);
      const id = await ctx.db.insert("releaseBundles", { status: "active", publicId: 901, name: "Empty Box", publisherId: s.publisherId, format: "physical" });
      await ctx.db.insert("collectionEntries", { userId: s.reader, bundleId: id, state: "owned" });
      return id;
    });
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: s.series, kind: "ownership", visibility: "public" });
    const entry: RepairEntry = {
      kind: "releaseBundle",
      key: "fill",
      reason: "box contents",
      bundleId,
      box: null,
      members: [{ isbn13: "9780000000011", order: 1 }],
      retireVolumeIds: [],
    };
    expect(await shown(t)).toEqual([]);
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await shown(t)).toEqual([]);
  });
});

/**
 * Standards 1: a repair entry's personal work runs in bounded legs. Each
 * call examines at most SWEEP_BUDGET personal rows, reports "partial" while
 * more remain (the runner calls it again), and keeps its trail in bounded
 * repairTrails records rather than one Proposal document. No leg widens a
 * public profile.
 */
describe("bounded personal repair work (Standards 1)", () => {
  /** Run one entry the way scripts/repair.ts does: again while it reports "partial", checking after every leg. */
  async function runLegs(t: T, entry: RepairEntry, afterLeg: () => Promise<void>) {
    const statuses: string[] = [];
    for (let leg = 0; leg < 20; leg++) {
      const status = (await run(t, [entry]))[0]!.status;
      statuses.push(status);
      await afterLeg();
      if (status !== "partial") break;
    }
    return statuses;
  }

  /** `count` more readers, each with private Reading of the source, a read Volume and a pass on the moved book. */
  const addReaders = (t: T, s: Awaited<ReturnType<typeof seed>>, count: number) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        const userId = await ctx.db.insert("users", {
          clerkSubject: `bulk${i}`,
          username: `bulk${i}`,
          usernameNormalized: `bulk${i}`,
          formatPreference: "both",
          ownershipVisibility: "public",
          readingVisibility: "public",
        });
        await ctx.db.insert("userSeriesStates", {
          userId,
          seriesId: s.source,
          following: false,
          followPromptDismissed: false,
          readingVisibility: "private",
        });
        await ctx.db.insert("volumeProgress", { userId, volumeId: s.unlabeled, seriesId: s.source, readCount: 1 });
        await ctx.db.insert("releaseProgress", { userId, releaseId: s.b1.releaseId, seriesId: s.source, percent: 5 });
      }
    });

  const trailOf = (t: T) =>
    t.run(async (ctx) => ({
      changes: (await ctx.db.query("proposalVersions").collect())
        .flatMap((v) => v.ops)
        .flatMap((op) => (op.kind === "update" ? op.changes : []))
        .filter((c) => c.field === "personalTracking"),
      records: await ctx.db.query("repairTrails").collect(),
      sweeps: await ctx.db.query("repairSweeps").collect(),
    }));

  it("re-files a large split's personal rows over several legs, never widening a profile", async () => {
    const t = makeT();
    const s = await seed(t);
    await addReaders(t, s, SWEEP_BUDGET + 10);
    const privateReading = async () => {
      for (const username of ["dave", "bulk0", `bulk${SWEEP_BUDGET + 9}`]) {
        expect((await t.query(api.sharing.publicProfile, { username }))?.reading).toEqual([]);
      }
    };
    await privateReading();
    const onSource = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("volumeProgress").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect()).length +
          (await ctx.db.query("releaseProgress").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect()).length,
      );
    const before = await onSource();
    const remaining: number[] = [];
    const statuses = await runLegs(t, s.entry, async () => {
      await privateReading();
      remaining.push(await onSource());
    });

    // Several legs, each moving at most one budget's worth of rows.
    expect(statuses[0]).toBe("partial");
    expect(statuses.at(-1)).not.toBe("partial");
    expect(statuses.length).toBeGreaterThan(2);
    for (const [i, left] of remaining.entries()) {
      expect((i === 0 ? before : remaining[i - 1]!) - left).toBeLessThanOrEqual(SWEEP_BUDGET);
    }
    expect(remaining.at(-1)).toBe(0);
    const target = await splitOff(t);
    const passes = await t.run(async (ctx) => (await ctx.db.query("releaseProgress").collect()).map((row) => row.seriesId));
    expect(new Set(passes)).toEqual(new Set([target._id]));

    // The trail sits in bounded records, the Proposals name only its size,
    // and no sweep cursor outlives the finished entry.
    const trail = await trailOf(t);
    for (const change of trail.changes) expect(typeof change.after).toBe("number");
    const rows = trail.records.flatMap((record) => record.rows);
    expect(rows.length).toBe(trail.changes.reduce((sum, change) => sum + Number(change.after), 0));
    expect(rows.filter((row) => row.table === "releaseProgress" && row.field === "seriesId")).toHaveLength(SWEEP_BUDGET + 12);
    for (const record of trail.records) expect(record.rows.length).toBeLessThanOrEqual(TRAIL_CHUNK);
    expect(JSON.stringify(trail.records)).not.toContain(s.reader);
    expect(trail.sweeps).toEqual([]);

    // A re-run examines the same rows in bounded legs, changes nothing, and
    // still never widens anything.
    const rerun = await runLegs(t, s.entry, privateReading);
    expect(rerun.at(-1)).toBe("alreadyApplied");
    expect((await trailOf(t)).records).toHaveLength(trail.records.length);
  });

  for (const kind of ["releaseBundle", "remodelEdition"] as const) {
    it(`hands a large box set's Collection Entries to its Bundle over several legs, keeping private owners private (${kind})`, async () => {
      const t = makeT();
      const s = await seed(t);
      const box = await t.run(async (ctx) => {
        const series = await ctx.db.insert("series", { status: "active", publicId: 700, title: "Noragami", altTitles: [], searchText: "Noragami" });
        const release = async (seriesId: Id<"series">, label: string, publicId: number, isbn13: string) => {
          const volumeId = await ctx.db.insert("volumes", { status: "active", publicId, seriesId, label, position: 1 });
          const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId: s.publisherId });
          await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
          const releaseId = await ctx.db.insert("releases", {
            status: "active",
            editionId,
            format: "physical",
            language: "en",
            isbn13,
            publisherId: s.publisherId,
            seriesIds: [seriesId],
          });
          return { series, volumeId, editionId, releaseId };
        };
        await release(series, "1", 701, "9780000000011");
        // The box set sits on "Doubt!!", which every owner keeps private.
        const made = await release(s.source, "Box", 713, "9780000000059");
        for (let i = 0; i < SWEEP_BUDGET + 10; i++) {
          const userId = await ctx.db.insert("users", {
            clerkSubject: `owner${i}`,
            username: `owner${i}`,
            usernameNormalized: `owner${i}`,
            formatPreference: "both",
            ownershipVisibility: "public",
            readingVisibility: "private",
          });
          await ctx.db.insert("userSeriesStates", {
            userId,
            seriesId: s.source,
            following: false,
            followPromptDismissed: false,
            ownershipVisibility: "private",
          });
          await ctx.db.insert("collectionEntries", { userId, releaseId: made.releaseId, state: "owned" });
        }
        return made;
      });
      const privateOwnership = async () => {
        for (const username of ["owner0", `owner${SWEEP_BUDGET + 9}`]) {
          const profile = await t.query(api.sharing.publicProfile, { username });
          expect([...(profile?.ownership.releases ?? []), ...(profile?.ownership.bundles ?? [])]).toEqual([]);
        }
      };
      await privateOwnership();
      const entry: RepairEntry =
        kind === "releaseBundle"
          ? {
              kind,
              key: "big-box",
              reason: "box set",
              bundleId: null,
              box: { releaseId: box.releaseId, name: "Noragami Box Set" },
              members: [{ isbn13: "9780000000011", order: 1 }],
              retireVolumeIds: [],
            }
          : {
              kind,
              key: "big-box",
              reason: "box set",
              editionId: box.editionId,
              volumeId: box.volumeId,
              targetSeriesId: box.series,
              line: null,
              bundle: { name: "Noragami Box Set" },
              groups: [{ releaseIds: null, coverage: [{ label: "1", volumeId: null, extent: "complete" }], linePosition: null }],
              retireVolumeIds: [],
            };
      const boxState = () =>
        t.run(async (ctx) => ({
          release: (await ctx.db.get(box.releaseId))?.status,
          edition: (await ctx.db.get(box.editionId))?.status,
          onBox: (await ctx.db.query("collectionEntries").withIndex("by_release", (q) => q.eq("releaseId", box.releaseId)).collect()).length,
        }));
      const legs: Array<Awaited<ReturnType<typeof boxState>>> = [];
      const statuses = await runLegs(t, entry, async () => {
        await privateOwnership();
        legs.push(await boxState());
      });

      expect(statuses[0]).toBe("partial");
      expect(statuses.at(-1)).toBe("applied");
      // The box set stays up, holding its remaining owners, until the last leg.
      expect(legs[0]).toEqual({ release: "active", edition: "active", onBox: 10 });
      expect(legs.at(-1)).toEqual({ release: "hidden", edition: "hidden", onBox: 0 });
      const moved = await t.run(async (ctx) => (await ctx.db.query("collectionEntries").collect()).filter((e) => e.bundleId));
      expect(moved).toHaveLength(SWEEP_BUDGET + 10);
      const trail = await trailOf(t);
      for (const record of trail.records) expect(record.rows.length).toBeLessThanOrEqual(TRAIL_CHUNK);
      expect(trail.records.flatMap((record) => record.rows).filter((row) => row.field === "bundleId")).toHaveLength(SWEEP_BUDGET + 10);
      expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
    });
  }

  /** A Series "Else" with a vol 1, and the rows under the moved book still filed elsewhere. */
  const addElse = (t: T) =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert("series", { status: "active", publicId: 600, title: "Else", altTitles: [], searchText: "Else" });
      await ctx.db.insert("volumes", { status: "active", publicId: 601, seriesId: id, label: "1", position: 1 });
      return id;
    });
  const staleUnder = (t: T, s: Awaited<ReturnType<typeof seed>>, seriesId: Id<"series">, volumes: boolean) =>
    t.run(async (ctx) => {
      const passes = await ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", s.b1.releaseId)).collect();
      const reads = volumes
        ? await ctx.db.query("volumeProgress").withIndex("by_volume", (q) => q.eq("volumeId", s.unlabeled)).collect()
        : [];
      return [...passes, ...reads].filter((row) => row.seriesId !== seriesId).length;
    });
  const bulkPrivate = async (t: T) => {
    for (const username of ["dave", "bulk0", `bulk${SWEEP_BUDGET + 9}`]) {
      expect((await t.query(api.sharing.publicProfile, { username }))?.reading).toEqual([]);
    }
  };

  it("re-files a large Edition's passes after setCoverage over several legs", async () => {
    const t = makeT();
    const s = await seed(t);
    await addReaders(t, s, SWEEP_BUDGET + 10);
    const elseId = await addElse(t);
    const entry: RepairEntry = {
      kind: "setCoverage",
      key: "big-cover",
      reason: "belongs to Else",
      editionId: s.b1.editionId,
      before: [s.unlabeled],
      coverage: [{ seriesId: elseId, label: "1", extent: "complete" }],
      line: null,
      retireVolumeIds: [],
    };
    expect(await runLegs(t, entry, () => bulkPrivate(t))).toEqual(["partial", "applied"]);
    expect(await staleUnder(t, s, elseId, false)).toBe(0);
    expect((await trailOf(t)).sweeps).toEqual([]);
    // A re-run examines the same rows in bounded legs and changes nothing.
    expect(await runLegs(t, entry, () => bulkPrivate(t))).toEqual(["partial", "alreadyApplied"]);
  });

  it("re-files a large placed Volume's tracking over several legs while a Series merge waits", async () => {
    const t = makeT();
    const s = await seed(t);
    await addReaders(t, s, SWEEP_BUDGET + 10);
    const elseId = await addElse(t);
    const packaging = await t.run(async (ctx) =>
      (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect())
        .filter((v) => v._id !== s.unlabeled)
        .map((v) => v._id),
    );
    const entry: RepairEntry = {
      kind: "mergeSeries",
      key: "big-merge",
      reason: "same work",
      loserId: s.source,
      survivorId: elseId,
      placements: [{ volumeId: s.unlabeled, label: "2", intoVolumeId: null }],
      packagingVolumeIds: packaging,
      retitle: null,
    };
    const legs = await runLegs(t, entry, () => bulkPrivate(t));
    expect(legs[0]).toBe("partial");
    expect(legs.at(-1)).toBe("deferred");
    expect(await staleUnder(t, s, elseId, true)).toBe(0);
    expect((await t.run(async (ctx) => await ctx.db.get(s.source)))?.status).toBe("active");

    // Stage 4 deals with the packaging Volumes; the merge then completes.
    await t.run(async (ctx) => {
      for (const id of packaging) await ctx.db.patch(id, { status: "hidden" });
    });
    expect((await runLegs(t, entry, () => bulkPrivate(t))).at(-1)).toBe("applied");
    expect((await t.run(async (ctx) => await ctx.db.get(s.source)))?.status).toBe("merged");
    expect(await staleUnder(t, s, elseId, true)).toBe(0);
  });
});

describe("other repairs that move tracking between Series", () => {
  /**
   * The other reader owns the second work's vol 1 book outright and shares
   * Ownership by default, keeping "Doubt!!" private; the reader's Reading of
   * "Doubt!!" is private too. A second Series, "Else", follows the defaults.
   */
  async function seedMover(t: T) {
    const s = await seed(t);
    const asOther = t.withIdentity({ subject: OTHER });
    await asOther.mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    await asOther.mutation(api.sharing.setSeriesVisibility, { seriesId: s.source, kind: "ownership", visibility: "private" });
    await asOther.mutation(api.collection.setReleaseEntry, { releaseId: s.b1.releaseId, state: "owned" });
    const other = await t.run(async (ctx) => {
      const id = await ctx.db.insert("series", { status: "active", publicId: 600, title: "Else", altTitles: [], searchText: "Else" });
      const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: 601, seriesId: id, label: "1", position: 1 });
      return { id, volumeId };
    });
    return { ...s, else: other.id, elseVol: other.volumeId, asOther };
  }
  const profileOf = async (t: T, username: string) => {
    const profile = await t.query(api.sharing.publicProfile, { username });
    return {
      owned: profile?.ownership.releases.length,
      reading: profile?.reading.map((row) => row.title),
    };
  };
  /** The title of the Series the reader's own Reading page groups each pass under. */
  const passTitles = async (t: T) => {
    const reading = await asReader(t).query(api.reading.myReading, {});
    return Object.fromEntries((reading?.series ?? []).flatMap((row) => row.passes.map((pass) => [pass.releaseId, row.title])));
  };
  const coverElse = (s: Awaited<ReturnType<typeof seedMover>>): RepairEntry => ({
    kind: "setCoverage",
    key: "cover",
    reason: "belongs to Else",
    editionId: s.b1.editionId,
    before: [s.unlabeled],
    coverage: [{ seriesId: s.else, label: "1", extent: "complete" }],
    line: null,
    retireVolumeIds: [],
  });
  /** A Series merge into "Else" placing the unlabeled Volume and waiting on the other two. */
  const waitingMerge = async (
    t: T,
    s: Awaited<ReturnType<typeof seedMover>>,
    placement: { label: string; intoVolumeId: Id<"volumes"> | null },
  ): Promise<RepairEntry> => {
    const volumes = await t.run(async (ctx) =>
      (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect()).map((v) => v._id),
    );
    return {
      kind: "mergeSeries",
      key: "merge",
      reason: "same work",
      loserId: s.source,
      survivorId: s.else,
      placements: [{ volumeId: s.unlabeled, ...placement }],
      packagingVolumeIds: volumes.filter((id) => id !== s.unlabeled),
      retitle: null,
    };
  };

  it("keeps an Edition's owners private when setCoverage moves it to another Series", async () => {
    const t = makeT();
    const s = await seedMover(t);
    const entry = coverElse(s);
    expect((await profileOf(t, "erin")).owned).toBe(0);
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect((await profileOf(t, "erin")).owned).toBe(0);
    await s.asOther.mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "private" });
    await s.asOther.mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    expect((await profileOf(t, "erin")).owned).toBe(0);
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("keeps placed Volumes' readers and owners private while a Series merge waits", async () => {
    const t = makeT();
    const s = await seedMover(t);
    const entry = await waitingMerge(t, s, { label: "2", intoVolumeId: null });
    expect(await profileOf(t, "erin")).toEqual({ owned: 0, reading: [] });
    expect(await profileOf(t, "dave")).toEqual({ owned: 0, reading: [] });
    expect((await run(t, [entry]))[0]?.status).toBe("deferred");
    expect(await profileOf(t, "erin")).toEqual({ owned: 0, reading: [] });
    expect(await profileOf(t, "dave")).toEqual({ owned: 0, reading: [] });
  });

  it("files the reader's pass under the Series setCoverage moves its Edition to (B10)", async () => {
    const t = makeT();
    const s = await seedMover(t);
    const entry = coverElse(s);
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await passTitles(t)).toEqual({ [s.b1.releaseId]: "Else", [s.b2.releaseId]: "Doubt!!" });
    expect((await personalSeries(t, s)).b1Pass).toBe(s.else);
    // "Else" absorbed the reader's private "Doubt!!" Reading.
    expect((await profileOf(t, "dave")).reading).toEqual([]);
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: s.else, kind: "reading", visibility: "public" });
    expect((await profileOf(t, "dave")).reading).toEqual(["Else"]);
    // A re-run leaves the reader's later choice alone (R16).
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
    expect((await profileOf(t, "dave")).reading).toEqual(["Else"]);
  });

  it("re-files an omnibus Favorite under the first Series setCoverage covers", async () => {
    const t = makeT();
    const s = await seedMover(t);
    const omnibus = await t.run(async (ctx) => {
      const labelled = (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect())
        .filter((v) => v.label !== undefined)
        .sort((a, b) => a.position - b.position)
        .map((v) => v._id);
      await ctx.db.insert("volumes", { status: "active", publicId: 602, seriesId: s.else, label: "2", position: 2 });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 514, publisherId: s.publisherId });
      for (const [i, volumeId] of labelled.entries()) {
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: i + 1, extent: "complete" });
      }
      await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: "9780316335140",
        publisherId: s.publisherId,
        seriesIds: [s.source],
      });
      const favoriteId = await ctx.db.insert("favorites", { userId: s.reader, seriesId: s.source, editionId });
      return { editionId, labelled, favoriteId };
    });
    const entry: RepairEntry = {
      kind: "setCoverage",
      key: "cover-omnibus",
      reason: "belongs to Else",
      editionId: omnibus.editionId,
      before: omnibus.labelled,
      coverage: ["1", "2"].map((label) => ({ seriesId: s.else, label, extent: "complete" as const })),
      line: null,
      retireVolumeIds: [],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect((await t.run(async (ctx) => await ctx.db.get(omnibus.favoriteId)))?.seriesId).toBe(s.else);
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("files a placed Volume's tracking under the survivor while a Series merge waits (B10)", async () => {
    const t = makeT();
    const s = await seedMover(t);
    expect((await run(t, [await waitingMerge(t, s, { label: "2", intoVolumeId: null })]))[0]?.status).toBe("deferred");
    expect(await personalSeries(t, s)).toEqual({
      volumeProgress: [s.else],
      b1Pass: s.else,
      b2Pass: s.source,
      favorites: [s.else],
      comments: [s.else],
    });
    expect(await passTitles(t)).toEqual({ [s.b1.releaseId]: "Else", [s.b2.releaseId]: "Doubt!!" });
  });

  it("files a pass under the survivor when a waiting Series merge merges its Volume into one there (B10)", async () => {
    const t = makeT();
    const s = await seedMover(t);
    expect((await run(t, [await waitingMerge(t, s, { label: "1", intoVolumeId: s.elseVol })]))[0]?.status).toBe("deferred");
    expect(await t.run(async (ctx) => (await ctx.db.get(s.unlabeled))?.mergedIntoId)).toBe(s.elseVol);
    expect(await personalSeries(t, s)).toEqual({
      volumeProgress: [s.else],
      b1Pass: s.else,
      b2Pass: s.source,
      favorites: [s.else],
      comments: [s.else],
    });
    expect(await passTitles(t)).toEqual({ [s.b1.releaseId]: "Else", [s.b2.releaseId]: "Doubt!!" });
    expect(await profileOf(t, "dave")).toEqual({ owned: 0, reading: [] });
  });

  // A public Split of the Volume merge a placement made reverses the pass it
  // moved: the Volume merge files the pass in its own manifest, never on the
  // repair's trail, and Split re-files passes from the coverage it restores.
  describe("Split of a placement's Volume merge", () => {
    const asAdmin = (t: T) => t.withIdentity({ subject: "admin" });
    const splitPlacement = (t: T, s: Awaited<ReturnType<typeof seedMover>>) =>
      asAdmin(t).mutation(api.sensitiveOps.splitRecord, {
        ref: { type: "volume", id: s.unlabeled },
        reason: "wrong placement",
        confirmImpact: true,
      });
    const placeIntoElse = async (t: T, s: Awaited<ReturnType<typeof seedMover>>) =>
      expect((await run(t, [await waitingMerge(t, s, { label: "1", intoVolumeId: s.elseVol })]))[0]?.status).toBe("deferred");
    const b1Pass = (t: T, s: Awaited<ReturnType<typeof seedMover>>) =>
      t.run(async (ctx) => await ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", s.b1.releaseId)).unique());

    it("Split reverses a waiting merge's placement into an existing Volume, passes included", async () => {
      const t = makeT();
      const s = await seedMover(t);
      await placeIntoElse(t, s);
      await splitPlacement(t, s);
      const { volume, release, trails, manifest } = await t.run(async (ctx) => ({
        volume: await ctx.db.get(s.unlabeled),
        release: await ctx.db.get(s.b1.releaseId),
        trails: (await ctx.db.query("repairTrails").collect()).flatMap((trail) => trail.rows),
        manifest: await ctx.db
          .query("mergeManifests")
          .withIndex("by_loser", (q) => q.eq("loserRef.type", "volume").eq("loserRef.id", s.unlabeled))
          .unique(),
      }));
      expect(volume?.status).toBe("active");
      expect(release?.seriesIds).toEqual([s.source]);
      expect((await personalSeries(t, s)).b1Pass).toBe(s.source);
      expect((await passTitles(t))[s.b1.releaseId]).toBe("Doubt!!");
      expect((await profileOf(t, "dave")).reading).toEqual([]);
      expect(trails.filter((row) => row.table === "releaseProgress")).toEqual([]);
      expect(manifest?.repointed).toContainEqual(
        expect.objectContaining({ table: "releaseProgress", field: "seriesId", before: s.source, after: s.else }),
      );
    });

    it("a pass edit after the placement survives the Split", async () => {
      const t = makeT();
      const s = await seedMover(t);
      await placeIntoElse(t, s);
      await asReader(t).mutation(api.reading.setPassPercent, { releaseId: s.b1.releaseId, percent: 55 });
      await splitPlacement(t, s);
      expect(await b1Pass(t, s)).toMatchObject({ seriesId: s.source, percent: 55 });
      const reading = await asReader(t).query(api.reading.myReading, {});
      const row = reading?.series.find((series) => series.passes.some((pass) => pass.releaseId === s.b1.releaseId));
      expect(row?.title).toBe("Doubt!!");
      expect(row?.passes.find((pass) => pass.releaseId === s.b1.releaseId)).toMatchObject({ percent: 55 });
    });

    it("a later setCoverage is not undone by the Split of the placement", async () => {
      const t = makeT();
      const s = await seedMover(t);
      await placeIntoElse(t, s);
      const gamma = await t.run(async (ctx) => {
        const id = await ctx.db.insert("series", { status: "active", publicId: 700, title: "Gamma", altTitles: [], searchText: "Gamma" });
        await ctx.db.insert("volumes", { status: "active", publicId: 701, seriesId: id, label: "1", position: 1 });
        return id;
      });
      const cover: RepairEntry = {
        kind: "setCoverage",
        key: "cover-gamma",
        reason: "belongs to Gamma",
        editionId: s.b1.editionId,
        before: [s.elseVol],
        coverage: [{ seriesId: gamma, label: "1", extent: "complete" }],
        line: null,
        retireVolumeIds: [],
      };
      expect((await run(t, [cover]))[0]?.status).toBe("applied");
      expect((await personalSeries(t, s)).b1Pass).toBe(gamma);
      await splitPlacement(t, s);
      const { volume, release } = await t.run(async (ctx) => ({
        volume: await ctx.db.get(s.unlabeled),
        release: await ctx.db.get(s.b1.releaseId),
      }));
      expect(volume?.status).toBe("active");
      expect(release?.seriesIds).toEqual([gamma]);
      expect((await personalSeries(t, s)).b1Pass).toBe(gamma);
    });
  });

  it("files every group's passes under the Series remodelEdition moves an Edition to (B10)", async () => {
    const t = makeT();
    const s = await seedMover(t);
    const second = await t.run(async (ctx) => {
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId: s.b1.editionId,
        format: "digital",
        language: "en",
        isbn13: "9780316335133",
        publisherId: s.publisherId,
        seriesIds: [s.source],
      });
      await ctx.db.insert("releaseProgress", { userId: s.reader, releaseId, seriesId: s.source, percent: 70 });
      return releaseId;
    });
    const entry: RepairEntry = {
      kind: "remodelEdition",
      key: "remodel",
      reason: "belongs to Else",
      editionId: s.b1.editionId,
      volumeId: s.unlabeled,
      targetSeriesId: s.else,
      line: null,
      bundle: null,
      groups: [
        { releaseIds: null, coverage: [{ label: "1", volumeId: null, extent: "complete" }], linePosition: null },
        { releaseIds: [second], coverage: [{ label: "2", volumeId: null, extent: "complete" }], linePosition: null },
      ],
      retireVolumeIds: [],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const moved = await t.run(async (ctx) => (await ctx.db.get(second))?.editionId);
    expect(moved).not.toBe(s.b1.editionId);
    const passes = await t.run(async (ctx) => (await ctx.db.query("releaseProgress").collect()).map((row) => [row.releaseId, row.seriesId]));
    expect(Object.fromEntries(passes)).toEqual({ [s.b1.releaseId]: s.else, [second]: s.else, [s.b2.releaseId]: s.source });
    expect(await passTitles(t)).toEqual({ [s.b1.releaseId]: "Else", [second]: "Else", [s.b2.releaseId]: "Doubt!!" });
    expect((await profileOf(t, "dave")).reading).toEqual([]);
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");

    // A remodel made before passes followed is healed by a re-run, the new
    // Edition's Release included.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("releaseProgress").collect()) await ctx.db.patch(row._id, { seriesId: s.source });
    });
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await passTitles(t)).toEqual({ [s.b1.releaseId]: "Else", [second]: "Else", [s.b2.releaseId]: "Doubt!!" });
    expect((await profileOf(t, "dave")).reading).toEqual([]);
  });
});
