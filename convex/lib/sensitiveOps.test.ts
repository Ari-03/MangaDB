// Merge and Split (lib/sensitiveOps.ts): no merge may widen a User's
// Tracking Visibility, for every User it moves tracking of (state rows,
// read counts, passes, Owned Releases and Bundles, Ratings), including where
// an Edition or Edition Line merge re-derives a Release's Series, now or after
// a later change of defaults; Split never widens either (not an override a
// merge narrowed, nor tracking it moves back, whatever other merges or the
// User did in between); merges between some Series and none are refused for
// tracked Releases and Bundles; Split must never resurrect
// personal rows of a User whose account was deleted; merges carry the
// denormalized references that follow the moved rows (Unmapped Packaging
// Series, a pass's Series, imprint parents); and Split reverses every chunk
// of the data repair's chunked publisher merge.

import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { recountRatings } from "./ratings";
import { IMPRINT_PREVIEW_CAP, stricterVisibility } from "./sensitiveOps";

const ADMIN = "user_admin";
const MOD = "user_mod";
const READER = "user_reader";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

const asMod = (t: T) => t.withIdentity({ subject: MOD });
const asReader = (t: T) => t.withIdentity({ subject: READER });

/**
 * An Administrator, a Moderator, and a reader ("dave"), plus two duplicate
 * Series: the survivor "Alpha" and the loser "Alpha (dupe)", each with one
 * Volume, Edition, and Release.
 */
async function setup(t: T) {
  await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
  await asMod(t).mutation(api.users.claimUsername, { username: "bob" });
  await asReader(t).mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "bob", role: "moderator" });

  return await t.run(async (ctx) => {
    const dave = (await ctx.db.query("users").collect()).find((u) => u.username === "dave")!;
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });
    const makeSeries = async (publicId: number, title: string) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title,
        altTitles: [],
        searchText: title,
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: publicId * 10,
        seriesId,
        position: 1,
        label: "1",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: publicId * 10 + 1,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
      return { seriesId, volumeId, releaseId };
    };
    const survivor = await makeSeries(1, "Alpha");
    const loser = await makeSeries(2, "Alpha (dupe)");
    return { daveId: dave._id, survivor, loser };
  });
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function mergeSeries(t: T, f: Fixture) {
  await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
    survivor: { type: "series", id: f.survivor.seriesId },
    loser: { type: "series", id: f.loser.seriesId },
    reason: "Duplicate created by the import sweep.",
    confirmImpact: true,
  });
}

async function splitSeries(t: T, f: Fixture) {
  await asMod(t).mutation(api.sensitiveOps.splitRecord, {
    ref: { type: "series", id: f.loser.seriesId },
    reason: "The two series are actually different works.",
    confirmImpact: true,
  });
}

const profile = (t: T) => t.query(api.sharing.publicProfile, { username: "dave" });

describe("merge — Tracking Visibility", () => {
  it("keeps a private loser override when the survivor state already exists (public defaults)", async () => {
    const t = makeT();
    const f = await setup(t);
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    await t.run(async (ctx) => {
      await ctx.db.insert("userSeriesStates", {
        userId: f.daveId,
        seriesId: f.survivor.seriesId,
        readingStatus: "reading",
        following: false,
        followPromptDismissed: false,
      });
      await ctx.db.insert("userSeriesStates", {
        userId: f.daveId,
        seriesId: f.loser.seriesId,
        readingStatus: "completed",
        following: false,
        followPromptDismissed: false,
        readingVisibility: "private",
        ownershipVisibility: "private",
      });
      await ctx.db.insert("volumeProgress", {
        userId: f.daveId,
        volumeId: f.loser.volumeId,
        seriesId: f.loser.seriesId,
        readCount: 3,
      });
      await ctx.db.insert("collectionEntries", {
        userId: f.daveId,
        releaseId: f.loser.releaseId,
        state: "owned",
      });
    });

    const before = await profile(t);
    expect(before?.reading.flatMap((row) => row.readVolumes)).toEqual([]);
    expect(before?.ownership.releases).toEqual([]);

    await mergeSeries(t, f);

    // The private loser data moved onto the survivor and stays private.
    const after = await profile(t);
    expect(after?.reading.some((row) => row.readVolumes.some((v) => v.readCount === 3))).toBe(false);
    expect(after?.ownership.releases).toEqual([]);
    const state = await t.run((ctx) =>
      ctx.db
        .query("userSeriesStates")
        .withIndex("by_user_series", (q) =>
          q.eq("userId", f.daveId).eq("seriesId", f.survivor.seriesId),
        )
        .unique(),
    );
    expect(state).toMatchObject({ readingVisibility: "private", ownershipVisibility: "private" });

    // Split brings the loser row back with its exclusion. The survivor keeps
    // the private overrides the merge set: Split never widens, since its own
    // tracking was private just before.
    await splitSeries(t, f);
    const states = await t.run((ctx) => ctx.db.query("userSeriesStates").collect());
    const survivorState = states.find((s) => s.seriesId === f.survivor.seriesId);
    const loserState = states.find((s) => s.seriesId === f.loser.seriesId);
    expect(survivorState).toMatchObject({ readingVisibility: "private", ownershipVisibility: "private" });
    expect(loserState).toMatchObject({ readingVisibility: "private", ownershipVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("does not let a moved public override expose the survivor under a private default", async () => {
    const t = makeT();
    const f = await setup(t);
    // Defaults stay private; only the loser was explicitly shared.
    await t.run(async (ctx) => {
      await ctx.db.insert("userSeriesStates", {
        userId: f.daveId,
        seriesId: f.loser.seriesId,
        readingStatus: "completed",
        following: false,
        followPromptDismissed: false,
        readingVisibility: "public",
      });
      // Private reading of the survivor, which has no state row of its own.
      await ctx.db.insert("volumeProgress", {
        userId: f.daveId,
        volumeId: f.survivor.volumeId,
        seriesId: f.survivor.seriesId,
        readCount: 5,
      });
    });

    await mergeSeries(t, f);

    const after = await profile(t);
    expect(after?.reading.some((row) => row.readVolumes.some((v) => v.readCount === 5))).toBe(false);

    // The row goes back to the loser without the public override the merge
    // cleared: its status was private just before the Split.
    await splitSeries(t, f);
    const loserState = await t.run((ctx) =>
      ctx.db
        .query("userSeriesStates")
        .withIndex("by_user_series", (q) =>
          q.eq("userId", f.daveId).eq("seriesId", f.loser.seriesId),
        )
        .unique(),
    );
    expect(loserState).toMatchObject({ readingStatus: "completed" });
    expect(loserState?.readingVisibility).toBeUndefined();
    expect(await shared(t)).toEqual(NOTHING);
  });
});

/** Everything the public profile shares, reduced to what a leak would show. */
async function shared(t: T) {
  const p = await profile(t);
  return {
    reading: p!.reading.map((row) => ({
      title: row.title,
      status: row.readingStatus,
      read: row.readVolumes.map((v) => v.readCount),
      passes: row.passes.length,
    })),
    releases: p!.ownership.releases.length,
    bundles: p!.ownership.bundles.map((b) => b.name),
    ratings: p!.ratings.map((r) => r.title),
  };
}

const NOTHING = { reading: [], releases: 0, bundles: [], ratings: [] };

/** A Bundle ("Dupe Box") whose only member is the loser Release. */
const loserBox = (t: T, f: Fixture) =>
  t.run(async (ctx) => {
    const publisherId = (await ctx.db.query("publishers").first())!._id;
    const bundleId = await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 900,
      name: "Dupe Box",
      publisherId,
      format: "physical",
    });
    await ctx.db.insert("bundleMemberships", { bundleId, releaseId: f.loser.releaseId, order: 1 });
    return bundleId;
  });

const stateOf = (t: T, f: Fixture, seriesId: Id<"series">) =>
  t.run((ctx) =>
    ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", f.daveId).eq("seriesId", seriesId))
      .unique(),
  );

describe("stricterVisibility", () => {
  // Every override pair, judged under both account defaults: the result may
  // never show where either side hid.
  const values = ["public", "private", undefined] as const;
  it.each(values.flatMap((kept) => values.map((other) => [kept, other] as const)))(
    "never shows more than %s ∧ %s under any default",
    (kept, other) => {
      const patch = stricterVisibility({ readingVisibility: kept }, [{ readingVisibility: other }], ["readingVisibility"]);
      const combined = "readingVisibility" in patch ? patch.readingVisibility : kept;
      for (const fallback of ["public", "private"] as const) {
        const shown = (combined ?? fallback) === "public";
        const before = (kept ?? fallback) === "public" && (other ?? fallback) === "public";
        expect(shown).toBe(before);
      }
    },
  );

  it("treats a missing row as following the default", () => {
    expect(stricterVisibility(null, [null])).toEqual({});
    expect(stricterVisibility({ ownershipVisibility: "public" }, [null])).toEqual({ ownershipVisibility: undefined });
    expect(stricterVisibility(null, [{ readingVisibility: "private" }])).toEqual({ readingVisibility: "private" });
  });
});

describe("merge — Tracking Visibility of every affected User", () => {
  // Each way dave can track the loser without ever touching its state row.
  const loserTracking: Array<[string, (t: T, f: Fixture) => Promise<unknown>, "ownershipVisibility" | "readingVisibility"]> = [
    [
      "a Volume read count",
      (t, f) => asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 3 }),
      "readingVisibility",
    ],
    ["an active pass", (t, f) => asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId }), "readingVisibility"],
    [
      "an Owned Release",
      (t, f) => asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" }),
      "ownershipVisibility",
    ],
    [
      "an Owned Bundle",
      async (t, f) => asReader(t).mutation(api.collection.setBundleEntry, { bundleId: await loserBox(t, f), state: "owned" }),
      "ownershipVisibility",
    ],
    [
      "a Series Rating",
      (t, f) => asReader(t).mutation(api.ratings.set, { target: { kind: "series", id: f.loser.seriesId }, score: 70 }),
      "readingVisibility",
    ],
  ];

  it.each(loserTracking)(
    "keeps %s on a loser without a state row private behind a public survivor override",
    async (_, track, surface) => {
      const t = makeT();
      const f = await setup(t);
      // Private defaults; only the survivor is shared, explicitly.
      for (const kind of ["ownership", "reading"] as const) {
        await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: f.survivor.seriesId, kind, visibility: "public" });
      }
      await track(t, f);
      expect(await stateOf(t, f, f.loser.seriesId)).toBeNull();
      expect(await shared(t)).toEqual(NOTHING);

      await mergeSeries(t, f);
      expect(await shared(t)).toEqual(NOTHING);

      // The loser's tracking is private under the default again. Split does
      // not bring back the public choice the merge cleared on the surface
      // it guarded (Split never widens); the other surface keeps its own.
      await splitSeries(t, f);
      expect(await shared(t)).toEqual(NOTHING);
      const survivor = await stateOf(t, f, f.survivor.seriesId);
      expect(survivor?.[surface]).toBeUndefined();
      const other = surface === "readingVisibility" ? "ownershipVisibility" : "readingVisibility";
      expect(survivor?.[other]).toBe("public");

      await mergeSeries(t, f);
      expect(await shared(t)).toEqual(NOTHING);
    },
  );

  it("leaves a public survivor override alone when the User tracks nothing on the loser", async () => {
    const t = makeT();
    const f = await setup(t);
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.survivor.seriesId,
      kind: "reading",
      visibility: "public",
    });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.survivor.volumeId, readCount: 2 });
    // Owning the loser touches Ownership only; Reading has nothing to guard.
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    const before = await shared(t);
    expect(before.reading).toEqual([{ title: "Alpha", status: null, read: [2], passes: 0 }]);

    await mergeSeries(t, f);
    expect(await shared(t)).toEqual(before);
    expect((await stateOf(t, f, f.survivor.seriesId))?.readingVisibility).toBe("public");
  });

  it("keeps an explicit private loser override through a later change of defaults", async () => {
    const t = makeT();
    const f = await setup(t);
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: f.loser.seriesId, kind, visibility: "private" });
    }
    // The survivor's state row exists but has no overrides of its own.
    await asReader(t).mutation(api.reading.setSeriesReadingStatus, { seriesId: f.survivor.seriesId, status: "reading" });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 4 });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });

    await mergeSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
    }
    expect(await shared(t)).toEqual(NOTHING);

    // Split puts the exclusion back on the loser; the survivor keeps the one
    // the merge gave it, since its status was hidden just before the Split.
    await splitSeries(t, f);
    for (const seriesId of [f.loser.seriesId, f.survivor.seriesId]) {
      expect(await stateOf(t, f, seriesId)).toMatchObject({
        ownershipVisibility: "private",
        readingVisibility: "private",
      });
    }
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps two explicitly public sides public", async () => {
    const t = makeT();
    const f = await setup(t);
    for (const seriesId of [f.survivor.seriesId, f.loser.seriesId]) {
      await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind: "reading", visibility: "public" });
    }
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 1 });
    await mergeSeries(t, f);
    expect((await shared(t)).reading).toEqual([{ title: "Alpha", status: null, read: [1], passes: 0 }]);
  });
});

describe("merge — cross-Series moves keep Tracking Visibility", () => {
  /** Public defaults, with the loser Series explicitly private for one surface. */
  async function privateLoser(t: T, f: Fixture, kind: "ownership" | "reading") {
    for (const k of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: k, visibility: "public" });
    }
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: f.loser.seriesId, kind, visibility: "private" });
  }

  const releaseMerge = (t: T, f: Fixture) =>
    mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });
  const volumeMerge = (t: T, f: Fixture) =>
    mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId });

  it("keeps a moved pass private on a cross-Series Release merge, through Split and re-merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    expect(await shared(t)).toEqual(NOTHING);

    await releaseMerge(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    // A later change of defaults cannot reveal it either: the survivor
    // Series now carries the loser's explicit exclusion.
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "private" });
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    expect(await shared(t)).toEqual(NOTHING);

    // Split moves the pass back; the synthesized override stays, as Split
    // never widens.
    await splitAs(t, { type: "release", id: f.loser.releaseId });
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ readingVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);

    await releaseMerge(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a moved Owned Release private on a cross-Series Release merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "ownership");
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);
    await releaseMerge(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps an Owned Bundle private when its member Release merges across Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "ownership");
    await asReader(t).mutation(api.collection.setBundleEntry, { bundleId: await loserBox(t, f), state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);
    await releaseMerge(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "release", id: f.loser.releaseId });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps read counts and ownership private on a cross-Series Volume merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.loser.seriesId,
      kind: "ownership",
      visibility: "private",
    });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 2 });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);

    await volumeMerge(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    expect(await shared(t)).toEqual(NOTHING);
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({
      readingVisibility: "private",
      ownershipVisibility: "private",
    });
  });

  it("keeps a moved omnibus Rating private on an Edition merge across Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    // Two omnibuses: the loser's leads with the loser Series, the survivor's
    // with the survivor Series; both also collect the other's Volume.
    const [survivorOmnibus, loserOmnibus] = await t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").first())!._id;
      const omnibus = async (publicId: number, first: Id<"volumes">, second: Id<"volumes">) => {
        const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId: first, order: 1, extent: "complete" });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId: second, order: 2, extent: "complete" });
        return editionId;
      };
      return [
        await omnibus(700, f.survivor.volumeId, f.loser.volumeId),
        await omnibus(701, f.loser.volumeId, f.survivor.volumeId),
      ];
    });
    await asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: loserOmnibus }, score: 90 });
    expect(await shared(t)).toEqual(NOTHING);

    await mergeAs(t, { type: "edition", id: survivorOmnibus }, { type: "edition", id: loserOmnibus });
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "edition", id: loserOmnibus });
    expect(await shared(t)).toEqual(NOTHING);
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ readingVisibility: "private" });
  });

  it("leaves other Users' public tracking of the survivor untouched", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    // dave's own survivor tracking was public and he never read the loser.
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.survivor.releaseId });
    const before = await shared(t);
    expect(before.reading).toEqual([{ title: "Alpha", status: null, read: [], passes: 1 }]);
    await releaseMerge(t, f);
    expect(await shared(t)).toEqual(before);
  });
});

describe("merge — re-derived Release Series keep Tracking Visibility", () => {
  /** Public defaults, with one Series explicitly private for Ownership. */
  async function privateOwnership(t: T, seriesId: Id<"series">) {
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
    }
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind: "ownership", visibility: "private" });
  }

  /** The Edition behind one of the fixture's Releases. */
  const editionOf = (t: T, releaseId: Id<"releases">) =>
    t.run(async (ctx) => (await ctx.db.get(releaseId))!.editionId);

  /**
   * An Edition with one Release: Unmapped Packaging on a new line of
   * `lineSeriesId`, or (null) an Edition with neither coverage nor line.
   */
  const bareEdition = (t: T, publicId: number, lineSeriesId: Id<"series"> | null) =>
    t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").first())!._id;
      const editionLineId = lineSeriesId
        ? await ctx.db.insert("editionLines", {
            status: "active",
            seriesId: lineSeriesId,
            publisherId,
            name: `Line ${publicId}`,
          })
        : undefined;
      const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId, editionLineId });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "hardcover",
        language: "en",
        publisherId,
        seriesIds: lineSeriesId ? [lineSeriesId] : [],
      });
      return { editionId, editionLineId, releaseId };
    });

  const own = (t: T, releaseId: Id<"releases">) =>
    asReader(t).mutation(api.collection.setReleaseEntry, { releaseId, state: "owned" });

  /** Toggle both defaults away and back; nothing merged may show either way. */
  async function toggleDefaults(t: T) {
    for (const visibility of ["private", "public"] as const) {
      for (const kind of ["ownership", "reading"] as const) {
        await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility });
      }
    }
  }

  /** Clearing the one private choice shows the Owned Release: the checks above were not vacuous. */
  async function expectShownWithout(t: T, seriesId: Id<"series">) {
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind: "ownership", visibility: "default" });
    expect((await shared(t)).releases).toBe(1);
  }

  it("keeps an Unmapped Packaging loser's Owned Release private when an Edition merge maps it to another Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.loser.seriesId);
    const packaging = await bareEdition(t, 50, f.loser.seriesId);
    await own(t, packaging.releaseId);
    expect(await shared(t)).toEqual(NOTHING);
    const survivorEdition = await editionOf(t, f.survivor.releaseId);
    const merge = () =>
      mergeAs(t, { type: "edition", id: survivorEdition }, { type: "edition", id: packaging.editionId });

    await merge();
    expect((await t.run((ctx) => ctx.db.get(packaging.releaseId)))?.seriesIds).toEqual([f.survivor.seriesId]);
    expect(await shared(t)).toEqual(NOTHING);
    await toggleDefaults(t);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "edition", id: packaging.editionId });
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ ownershipVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);

    await merge();
    expect(await shared(t)).toEqual(NOTHING);
    await expectShownWithout(t, f.survivor.seriesId);
  });

  it("keeps an Unmapped Packaging survivor's Owned Release private when the loser's coverage maps it to another Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.survivor.seriesId);
    const packaging = await bareEdition(t, 51, f.survivor.seriesId);
    await own(t, packaging.releaseId);
    expect(await shared(t)).toEqual(NOTHING);
    const loserEdition = await editionOf(t, f.loser.releaseId);
    const merge = () =>
      mergeAs(t, { type: "edition", id: packaging.editionId }, { type: "edition", id: loserEdition });

    await merge();
    expect((await t.run((ctx) => ctx.db.get(packaging.releaseId)))?.seriesIds).toEqual([f.loser.seriesId]);
    expect(await shared(t)).toEqual(NOTHING);
    await toggleDefaults(t);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "edition", id: loserEdition });
    expect(await stateOf(t, f, f.loser.seriesId)).toMatchObject({ ownershipVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);

    await merge();
    expect(await shared(t)).toEqual(NOTHING);
    await expectShownWithout(t, f.loser.seriesId);
  });

  it("keeps an Unmapped Packaging Release private when its Edition Line merges across Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.loser.seriesId);
    const packaging = await bareEdition(t, 52, f.loser.seriesId);
    const target = await bareEdition(t, 53, f.survivor.seriesId);
    await own(t, packaging.releaseId);
    expect(await shared(t)).toEqual(NOTHING);
    const merge = () =>
      mergeAs(t, { type: "editionLine", id: target.editionLineId! }, { type: "editionLine", id: packaging.editionLineId! });

    await merge();
    expect((await t.run((ctx) => ctx.db.get(packaging.releaseId)))?.seriesIds).toEqual([f.survivor.seriesId]);
    expect(await shared(t)).toEqual(NOTHING);
    await toggleDefaults(t);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "editionLine", id: packaging.editionLineId! });
    expect((await t.run((ctx) => ctx.db.get(packaging.releaseId)))?.seriesIds).toEqual([f.loser.seriesId]);
    expect(await shared(t)).toEqual(NOTHING);

    await merge();
    expect(await shared(t)).toEqual(NOTHING);
    await expectShownWithout(t, f.survivor.seriesId);
  });

  it("refuses a Release merge into a survivor with no Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.loser.seriesId);
    const seriesless = await bareEdition(t, 54, null);
    await own(t, f.loser.releaseId);
    expect(await shared(t)).toEqual(NOTHING);

    await expect(
      mergeAs(t, { type: "release", id: seriesless.releaseId }, { type: "release", id: f.loser.releaseId }),
    ).rejects.toThrow(/no Series/);
    expect(await shared(t)).toEqual(NOTHING);
    expect((await t.run((ctx) => ctx.db.get(f.loser.releaseId)))?.status).toBe("active");
  });

  it("refuses an Edition merge that would leave Unmapped Packaging with no Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.loser.seriesId);
    const packaging = await bareEdition(t, 55, f.loser.seriesId);
    const seriesless = await bareEdition(t, 56, null);
    await own(t, packaging.releaseId);

    await expect(
      mergeAs(t, { type: "edition", id: seriesless.editionId }, { type: "edition", id: packaging.editionId }),
    ).rejects.toThrow(/no Series/);
    expect(await shared(t)).toEqual(NOTHING);
    expect((await t.run((ctx) => ctx.db.get(packaging.releaseId)))?.seriesIds).toEqual([f.loser.seriesId]);
  });

  it("refuses to give a tracked Release with no Series one, by Release or Edition merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateOwnership(t, f.survivor.seriesId);
    const seriesless = await bareEdition(t, 57, null);
    await own(t, seriesless.releaseId);
    const survivorEdition = await editionOf(t, f.survivor.releaseId);

    await expect(
      mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: seriesless.releaseId }),
    ).rejects.toThrow(/no Series/);
    await expect(
      mergeAs(t, { type: "edition", id: survivorEdition }, { type: "edition", id: seriesless.editionId }),
    ).rejects.toThrow(/no Series/);
    expect((await t.run((ctx) => ctx.db.get(seriesless.releaseId)))?.status).toBe("active");

    // An untracked one merges.
    const untracked = await bareEdition(t, 58, null);
    await mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: untracked.releaseId });
  });
});

describe("split — state rows a merge synthesized", () => {
  it("keeps a synthesized row, its override and one the User set since through Split", async () => {
    const t = makeT();
    const f = await setup(t);
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
    }
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.loser.seriesId,
      kind: "reading",
      visibility: "private",
    });
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    const releaseMerge = () =>
      mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });

    // The merge synthesizes dave's survivor-Series row to keep the pass private.
    await releaseMerge();
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ readingVisibility: "private" });
    // dave then hides his survivor-Series Ownership on that same row and owns the survivor Release.
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.survivor.seriesId,
      kind: "ownership",
      visibility: "private",
    });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.survivor.releaseId, state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "release", id: f.loser.releaseId });
    const state = await stateOf(t, f, f.survivor.seriesId);
    expect(state?.ownershipVisibility).toBe("private");
    expect(state?.readingVisibility).toBe("private");
    expect(await shared(t)).toEqual(NOTHING);

    await releaseMerge();
    expect(await shared(t)).toEqual(NOTHING);
  });
});

/** Another Series with one Volume, Edition and Release, like setup's. */
const addSeries = (t: T, publicId: number, title: string) =>
  t.run(async (ctx) => {
    const publisherId = (await ctx.db.query("publishers").first())!._id;
    const seriesId = await ctx.db.insert("series", { status: "active", publicId, title, altTitles: [], searchText: title });
    const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: publicId * 10, seriesId, position: 1, label: "1" });
    const releaseId = await addRelease(ctx, publisherId, publicId * 10 + 1, volumeId, seriesId);
    return { seriesId, volumeId, releaseId };
  });

/** A Release on its own Edition covering one Volume. */
async function addRelease(
  ctx: Parameters<Parameters<T["run"]>[0]>[0],
  publisherId: Id<"publishers">,
  editionPublicId: number,
  volumeId: Id<"volumes">,
  seriesId: Id<"series">,
) {
  const editionId = await ctx.db.insert("editions", { status: "active", publicId: editionPublicId, publisherId });
  await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
  return await ctx.db.insert("releases", {
    status: "active",
    editionId,
    format: "physical",
    binding: "paperback",
    language: "en",
    publisherId,
    seriesIds: [seriesId],
  });
}

describe("split — never widens Tracking Visibility", () => {
  async function publicDefaults(t: T) {
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
    }
  }

  async function hide(t: T, seriesId: Id<"series">) {
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind, visibility: "private" });
    }
  }

  it("keeps a third Series merged into the same survivor private when an earlier merge is split", async () => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    // Private defaults; only the survivor is shared, explicitly.
    for (const kind of ["ownership", "reading"] as const) {
      await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId: f.survivor.seriesId, kind, visibility: "public" });
    }
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 3 });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: gamma.volumeId, readCount: 7 });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: gamma.releaseId, state: "owned" });
    expect(await stateOf(t, f, gamma.seriesId)).toBeNull();
    expect(await shared(t)).toEqual(NOTHING);

    await mergeSeries(t, f);
    await mergeAs(t, { type: "series", id: f.survivor.seriesId }, { type: "series", id: gamma.seriesId });
    expect(await shared(t)).toEqual(NOTHING);

    // Gamma's merge found the survivor already narrowed and wrote nothing;
    // splitting the first merge must not put the public choice back.
    await splitSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    await mergeSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps tracking logged under an override a merge narrowed private through Split", async () => {
    const t = makeT();
    const f = await setup(t);
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.survivor.seriesId,
      kind: "reading",
      visibility: "public",
    });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 3 });
    await mergeSeries(t, f);
    // Alpha now follows dave's private default, and he reads it that way.
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.survivor.volumeId, readCount: 2 });
    expect(await shared(t)).toEqual(NOTHING);

    await splitSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps two Releases' passes private when one of their merges into the same Series is split", async () => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    const secondAlpha = await t.run(async (ctx) =>
      addRelease(ctx, (await ctx.db.query("publishers").first())!._id, 12, f.survivor.volumeId, f.survivor.seriesId),
    );
    await publicDefaults(t);
    for (const seriesId of [f.loser.seriesId, gamma.seriesId]) {
      await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind: "reading", visibility: "private" });
    }
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    await asReader(t).mutation(api.reading.startPass, { releaseId: gamma.releaseId });
    expect(await shared(t)).toEqual(NOTHING);

    await mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });
    // Alpha is already private for Reading: this merge logs no patch of its own.
    await mergeAs(t, { type: "release", id: secondAlpha }, { type: "release", id: gamma.releaseId });
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "release", id: f.loser.releaseId });
    expect(await shared(t)).toEqual(NOTHING);
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "private" });
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a survivor hidden after the merge private when Split takes the state row back to the loser", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    // The loser's row carries a status only; the survivor has no row.
    await asReader(t).mutation(api.reading.setSeriesReadingStatus, { seriesId: f.loser.seriesId, status: "reading" });
    await t.run(async (ctx) => {
      await ctx.db.insert("volumeProgress", {
        userId: f.daveId,
        volumeId: f.survivor.volumeId,
        seriesId: f.survivor.seriesId,
        readCount: 5,
      });
    });
    expect((await shared(t)).reading).toHaveLength(2);

    await mergeSeries(t, f);
    // dave hides the merged Series on the row the merge moved onto it.
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitSeries(t, f);
    expect(await stateOf(t, f, f.loser.seriesId)).toMatchObject({ readingStatus: "reading", readingVisibility: "private" });
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    expect(await shared(t)).toEqual(NOTHING);
    await mergeSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps the loser's tracking private when the survivor was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    await asReader(t).mutation(api.reading.setSeriesReadingStatus, { seriesId: f.survivor.seriesId, status: "reading" });
    await asReader(t).mutation(api.reading.setSeriesReadingStatus, { seriesId: f.loser.seriesId, status: "completed" });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 4 });

    await mergeSeries(t, f);
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    // The loser's row comes back from the manifest without overrides.
    await splitSeries(t, f);
    expect(await stateOf(t, f, f.loser.seriesId)).toMatchObject({
      readingStatus: "completed",
      readingVisibility: "private",
      ownershipVisibility: "private",
    });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a pass private when its Release merge is split after the survivor Series was hidden", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    await mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "release", id: f.loser.releaseId });
    expect(await stateOf(t, f, f.loser.seriesId)).toMatchObject({ readingVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);
  });
});

describe("merge — Bundles without a Series signal", () => {
  /** A Bundle with the given member Releases. */
  const box = (t: T, publicId: number, name: string, members: Array<Id<"releases">>) =>
    t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").first())!._id;
      const bundleId = await ctx.db.insert("releaseBundles", { status: "active", publicId, name, publisherId, format: "physical" });
      for (const [index, releaseId] of members.entries()) {
        await ctx.db.insert("bundleMemberships", { bundleId, releaseId, order: index + 1 });
      }
      return bundleId;
    });

  it("refuses to publish a memberless Owned Bundle by merging it with one whose Series is public", async () => {
    const t = makeT();
    const f = await setup(t);
    // Private defaults; Alpha's Ownership is explicitly public.
    await asReader(t).mutation(api.sharing.setSeriesVisibility, {
      seriesId: f.survivor.seriesId,
      kind: "ownership",
      visibility: "public",
    });
    const fullBox = await box(t, 901, "Full Box", []);
    const alphaBox = await box(t, 902, "Alpha Box", [f.survivor.releaseId]);
    await asReader(t).mutation(api.collection.setBundleEntry, { bundleId: fullBox, state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);

    await expect(mergeAs(t, { type: "releaseBundle", id: alphaBox }, { type: "releaseBundle", id: fullBox })).rejects.toThrow(
      /no Series/,
    );
    await expect(mergeAs(t, { type: "releaseBundle", id: fullBox }, { type: "releaseBundle", id: alphaBox })).rejects.toThrow(
      /no Series/,
    );
    expect(await shared(t)).toEqual(NOTHING);

    // Nobody tracks an empty duplicate, so it merges.
    const emptyBox = await box(t, 903, "Empty Box", []);
    await mergeAs(t, { type: "releaseBundle", id: alphaBox }, { type: "releaseBundle", id: emptyBox });
    expect(await shared(t)).toEqual(NOTHING);
  });
});

describe("split — deleted Users", () => {
  /** dave rates and reviews both duplicates, so the merge removes his loser rows. */
  async function rateAndReviewBoth(t: T, f: Fixture) {
    await t.run(async (ctx) => {
      for (const [seriesId, score] of [
        [f.survivor.seriesId, 80],
        [f.loser.seriesId, 20],
      ] as const) {
        await ctx.db.insert("ratings", { userId: f.daveId, seriesId, score, updatedAt: 1 });
        await ctx.db.insert("reviews", {
          userId: f.daveId,
          seriesId,
          body: `A private review body for ${seriesId}.`,
          spoiler: false,
          status: "visible",
          createdAt: 1,
        });
        await recountRatings(ctx, { kind: "series", id: seriesId });
      }
    });
  }

  it("never restores a deleted User's Ratings or Reviews", async () => {
    const t = makeT();
    const f = await setup(t);
    await rateAndReviewBoth(t, f);
    await mergeSeries(t, f);
    await t.mutation(internal.users.purgeUser, { clerkSubject: READER });
    await splitSeries(t, f);

    const left = await t.run(async (ctx) => ({
      user: await ctx.db.get(f.daveId),
      ratings: await ctx.db.query("ratings").collect(),
      reviews: await ctx.db.query("reviews").collect(),
      stats: await ctx.db.query("ratingStats").collect(),
    }));
    expect(left.user).toBeNull();
    expect(left.ratings).toEqual([]);
    expect(left.reviews).toEqual([]);
    expect(left.stats.reduce((n, row) => n + row.count, 0)).toBe(0);
  });

  it("redacts the deleted User's rows from open merge manifests", async () => {
    const t = makeT();
    const f = await setup(t);
    await rateAndReviewBoth(t, f);
    await mergeSeries(t, f);
    const personal = (removed: Array<{ table: string; doc: unknown }>) =>
      removed.filter((row) => (row.doc as { userId?: Id<"users"> }).userId === f.daveId);
    const [before] = await t.run((ctx) => ctx.db.query("mergeManifests").collect());
    expect(personal(before!.removed)).toHaveLength(2);

    // Redaction runs as a scheduled, paginated follow-up of the purge.
    vi.useFakeTimers();
    await t.mutation(internal.users.purgeUser, { clerkSubject: READER });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const [after] = await t.run((ctx) => ctx.db.query("mergeManifests").collect());
    expect(personal(after!.removed)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("private review body");
  });

  it("walks every manifest page and leaves other Users' snapshots alone", async () => {
    const t = makeT();
    const f = await setup(t);
    // A real merge supplies the Proposal the synthetic manifests hang off.
    await mergeSeries(t, f);
    const aliceId = await t.run(async (ctx) => {
      const alice = (await ctx.db.query("users").collect()).find((u) => u.username === "alice")!;
      const [merged] = await ctx.db.query("mergeManifests").collect();
      await ctx.db.delete(merged!._id);
      const proposalId = merged!.proposalId;
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("mergeManifests", {
          loserRef: { type: "series", id: f.loser.seriesId },
          survivorRef: { type: "series", id: f.survivor.seriesId },
          proposalId,
          repointed: [],
          removed: [
            { table: "favorites", doc: { userId: f.daveId, seriesId: f.loser.seriesId } },
            { table: "favorites", doc: { userId: alice._id, seriesId: f.loser.seriesId } },
          ],
          inserted: [],
        });
      }
      return alice._id;
    });

    vi.useFakeTimers();
    await t.mutation(internal.users.purgeUser, { clerkSubject: READER });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const manifests = await t.run((ctx) => ctx.db.query("mergeManifests").collect());
    expect(manifests).toHaveLength(20);
    for (const manifest of manifests) {
      expect(manifest.removed.map((row) => (row.doc as { userId: Id<"users"> }).userId)).toEqual([
        aliceId,
      ]);
    }
  });
});

/** Merge one record into another as the Moderator, then (optionally) split it back out. */
async function mergeAs(t: T, survivor: { type: string; id: string }, loser: { type: string; id: string }) {
  await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
    survivor: survivor as never,
    loser: loser as never,
    reason: "Duplicate created by the import sweep.",
    confirmImpact: true,
  });
}

async function splitAs(t: T, ref: { type: string; id: string }) {
  await asMod(t).mutation(api.sensitiveOps.splitRecord, {
    ref: ref as never,
    reason: "The merge was a mistake.",
    confirmImpact: true,
  });
}

describe("merge — denormalized references", () => {
  it("moves an Unmapped Packaging Release's Series denorm with its Edition Line", async () => {
    const t = makeT();
    const f = await setup(t);
    // A line on the loser holding one member with no Volume Coverage yet.
    const releaseId = await t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").first())!._id;
      const editionLineId = await ctx.db.insert("editionLines", {
        status: "active",
        seriesId: f.loser.seriesId,
        publisherId,
        name: "Deluxe Edition",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 99,
        publisherId,
        editionLineId,
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "hardcover",
        language: "en",
        publisherId,
        seriesIds: [f.loser.seriesId],
      });
    });

    await mergeSeries(t, f);
    const merged = await t.run((ctx) => ctx.db.get(releaseId));
    expect(merged?.seriesIds).toEqual([f.survivor.seriesId]);

    await splitSeries(t, f);
    const split = await t.run((ctx) => ctx.db.get(releaseId));
    expect(split?.seriesIds).toEqual([f.loser.seriesId]);
  });

  it("moves an active pass to the surviving Release's Series on a cross-Series Release merge", async () => {
    const t = makeT();
    const f = await setup(t);
    const passId = await t.run((ctx) =>
      ctx.db.insert("releaseProgress", {
        userId: f.daveId,
        releaseId: f.loser.releaseId,
        seriesId: f.loser.seriesId,
        percent: 40,
      }),
    );

    await mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });
    const merged = await t.run((ctx) => ctx.db.get(passId));
    expect(merged).toMatchObject({ releaseId: f.survivor.releaseId, seriesId: f.survivor.seriesId });

    await splitAs(t, { type: "release", id: f.loser.releaseId });
    const split = await t.run((ctx) => ctx.db.get(passId));
    expect(split).toMatchObject({ releaseId: f.loser.releaseId, seriesId: f.loser.seriesId });
  });
});

describe("merge — publisher imprints", () => {
  /** Two duplicate company rows; the loser has an imprint. */
  async function companies(t: T) {
    return await t.run(async (ctx) => {
      const survivorId = await ctx.db.insert("publishers", { status: "active", name: "Kodansha", slug: "kodansha" });
      const loserId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha Comics",
        slug: "kodansha-comics",
      });
      const imprintId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Vertical",
        slug: "vertical",
        parentPublisherId: loserId,
      });
      return { survivorId, loserId, imprintId };
    });
  }

  it("moves the loser's imprints to the survivor, and Split moves them back", async () => {
    const t = makeT();
    await setup(t);
    const p = await companies(t);

    await mergeAs(t, { type: "publisher", id: p.survivorId }, { type: "publisher", id: p.loserId });
    const merged = await t.run((ctx) =>
      ctx.db
        .query("publishers")
        .withIndex("by_parent", (q) => q.eq("parentPublisherId", p.survivorId))
        .collect(),
    );
    expect(merged.map((row) => row._id)).toEqual([p.imprintId]);

    await splitAs(t, { type: "publisher", id: p.loserId });
    const split = await t.run((ctx) => ctx.db.get(p.imprintId));
    expect(split?.parentPublisherId).toBe(p.loserId);
  });

  it("makes a survivor that was the loser's own imprint top-level", async () => {
    const t = makeT();
    await setup(t);
    const p = await companies(t);

    await mergeAs(t, { type: "publisher", id: p.imprintId }, { type: "publisher", id: p.loserId });
    const survivor = await t.run((ctx) => ctx.db.get(p.imprintId));
    expect(survivor?.parentPublisherId).toBeUndefined();

    await splitAs(t, { type: "publisher", id: p.loserId });
    const split = await t.run((ctx) => ctx.db.get(p.imprintId));
    expect(split?.parentPublisherId).toBe(p.loserId);
  });

  it("previews the imprint count with a bounded read", async () => {
    const t = makeT();
    await setup(t);
    const p = await companies(t);
    const imprintsOf = async () => {
      const form = await asMod(t).query(api.sensitiveOps.manageForm, { type: "publisher", key: "kodansha-comics" });
      return form!.impact.find((row) => row.label.startsWith("Imprints"));
    };
    expect(await imprintsOf()).toEqual({ label: "Imprints (follow the survivor on a merge)", count: 1 });

    await t.run(async (ctx) => {
      for (let i = 0; i < IMPRINT_PREVIEW_CAP; i++) {
        await ctx.db.insert("publishers", {
          status: i === 0 ? "merged" : "active",
          name: `Imprint ${i}`,
          slug: `imprint-${i}`,
          parentPublisherId: p.loserId,
        });
      }
    });
    const capped = await imprintsOf();
    expect(capped?.label).toMatch(/— more than 100 child rows, first 100 counted$/);
    expect(capped?.count).toBe(IMPRINT_PREVIEW_CAP - 1);
  });

  it("refuses to nest the loser's imprints under a survivor that is itself an imprint", async () => {
    const t = makeT();
    await setup(t);
    const p = await companies(t);
    const nestedSurvivor = await t.run(async (ctx) => {
      const parentId = await ctx.db.insert("publishers", { status: "active", name: "Penguin", slug: "penguin" });
      return await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha USA",
        slug: "kodansha-usa",
        parentPublisherId: parentId,
      });
    });

    await expect(
      mergeAs(t, { type: "publisher", id: nestedSurvivor }, { type: "publisher", id: p.loserId }),
    ).rejects.toThrow(/imprint/i);
    const loser = await t.run((ctx) => ctx.db.get(p.loserId));
    expect(loser?.status).toBe("active");
  });
});

describe("split — chunked repair merges", () => {
  it("reverses every chunk of the data repair's publisher merge", async () => {
    const t = makeT();
    await setup(t);
    const p = await t.run(async (ctx) => {
      const survivorId = await ctx.db.insert("publishers", { status: "active", name: "Kodansha", slug: "kodansha" });
      const loserId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha Comics",
        slug: "kodansha-comics",
      });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 500, publisherId: loserId });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId: loserId,
        seriesIds: [],
      });
      return { survivorId, loserId, editionId, releaseId };
    });
    const entry = {
      kind: "publisherMerge" as const,
      key: "publisherMerge:kodansha-comics",
      reason: "Duplicate company row.",
      loserId: p.loserId,
      survivorId: p.survivorId,
      expectEditions: 1,
    };
    // The first call repoints the Edition as a chunk; the second finishes
    // with the stock merge. Each call is its own repair Proposal.
    const run = () => t.mutation(internal.repair.runBatch, { entries: [entry], dryRun: false, actor: "alice" });
    expect((await run())[0]?.status).toBe("partial");
    expect((await run())[0]?.status).toBe("applied");

    await splitAs(t, { type: "publisher", id: p.loserId });
    const after = await t.run(async (ctx) => ({
      loser: await ctx.db.get(p.loserId),
      edition: await ctx.db.get(p.editionId),
      release: await ctx.db.get(p.releaseId),
      open: (await ctx.db.query("mergeManifests").collect()).filter((m) => m.reversedAt === undefined),
    }));
    expect(after.loser?.status).toBe("active");
    expect(after.edition?.publisherId).toBe(p.loserId);
    expect(after.release?.publisherId).toBe(p.loserId);
    expect(after.open).toEqual([]);
  });
});
