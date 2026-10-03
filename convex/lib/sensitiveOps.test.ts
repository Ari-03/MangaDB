// Merge and Split (lib/sensitiveOps.ts): no merge may widen a User's
// Tracking Visibility, for every User it moves tracking of (state rows,
// read counts, passes, Owned Releases and Bundles, Ratings), including where
// an Edition or Edition Line merge re-derives a Release's Series, now or after
// a later change of defaults; Split shows nothing the profile did not show
// just before (not an override a merge narrowed, nor tracking it moves back,
// whether logged with the merge or since, on either side, whatever other
// merges, their Splits or the User did in between), while a catalog record
// the User does not track (an unowned Bundle) narrows nothing; omnibus
// Ratings keep their governance when their Series or Volumes are hidden;
// merges and Splits between some Series and none are refused for tracked
// Releases and Bundles; Split must never resurrect personal rows of a User whose account
// was deleted; merges carry the denormalized references that follow the
// moved rows (Unmapped Packaging Series, a pass's Series, imprint parents);
// and Split reverses every chunk of the data repair's chunked publisher
// merge.

import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { RecordRef } from "../moderation";
import {
  insertBundle,
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "../test.factories";
import { alice, bob, dave, makeT, purgeAccount, seedTeam, signedIn, type TestT as T } from "../test.helpers";
import { hideRecord, insertBook, mergeAs, splitAs } from "../test.moderation";
import { recountRatings } from "./ratings";
import { IMPRINT_PREVIEW_CAP, stricterVisibility } from "./sensitiveOps";

const asMod = (t: T) => signedIn(t, bob);
const asReader = (t: T) => signedIn(t, dave);

/** The first (here, the only catalog) Publisher, which every fixture book uses. */
const firstPublisher = async (ctx: MutationCtx) => (await ctx.db.query("publishers").first())!._id;

/** A Series with one Volume and a book on it, from the first Publisher. */
async function insertSeriesWithBook(ctx: MutationCtx, publicId: number, title: string) {
  const seriesId = await insertSeries(ctx, { publicId, title });
  const volumeId = await insertVolume(ctx, { seriesId });
  const { releaseId } = await insertBook(ctx, { publisherId: await firstPublisher(ctx), seriesId, volumeId });
  return { seriesId, volumeId, releaseId };
}

/**
 * An Administrator, a Moderator, and a reader ("dave"), plus two duplicate
 * Series: the survivor "Alpha" and the loser "Alpha (dupe)", each with one
 * Volume, Edition, and Release.
 */
async function setup(t: T) {
  await seedTeam(t, [alice, bob, dave]);
  return await t.run(async (ctx) => {
    const daveRow = (await ctx.db.query("users").collect()).find((u) => u.username === "dave")!;
    await insertPublisher(ctx, { name: "Seven Seas" });
    const survivor = await insertSeriesWithBook(ctx, 1, "Alpha");
    const loser = await insertSeriesWithBook(ctx, 2, "Alpha (dupe)");
    return { daveId: daveRow._id, survivor, loser };
  });
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function mergeSeries(t: T, f: Fixture) {
  await mergeAs(t, { type: "series", id: f.survivor.seriesId }, { type: "series", id: f.loser.seriesId });
}

async function splitSeries(t: T, f: Fixture) {
  await splitAs(t, { type: "series", id: f.loser.seriesId }, "The two series are actually different works.");
}

const profile = (t: T) => t.query(api.sharing.publicProfile, { username: "dave" });

describe("merge — Tracking Visibility", () => {
  it("keeps a private loser override when the survivor state already exists (public defaults)", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
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
    // The survivor's public status shows: the profile is not empty by accident.
    expect(before?.reading.map((row) => row.title)).toEqual(["Alpha"]);
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
const loserBox = (t: T, f: Fixture) => box(t, 900, "Dupe Box", [f.loser.releaseId]);

const stateOf = (t: T, f: Fixture, seriesId: Id<"series">) =>
  t.run((ctx) =>
    ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", f.daveId).eq("seriesId", seriesId))
      .unique(),
  );

async function publicDefaults(t: T) {
  for (const kind of ["ownership", "reading"] as const) {
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
  }
}

type Surface = "ownership" | "reading";

/** dave's explicit private override on a Series, for both surfaces unless `kinds` says otherwise. */
async function hide(t: T, seriesId: Id<"series">, kinds: Surface[] = ["ownership", "reading"]) {
  for (const kind of kinds) {
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind, visibility: "private" });
  }
}

/** dave's explicit public override on a Series, for both surfaces unless `kinds` says otherwise. */
async function share(t: T, seriesId: Id<"series">, kinds: Surface[] = ["ownership", "reading"]) {
  for (const kind of kinds) {
    await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind, visibility: "public" });
  }
}

/** Clearing dave's one private Ownership choice shows his Owned Release: the checks before it were not vacuous. */
async function expectShownWithout(t: T, seriesId: Id<"series">) {
  await asReader(t).mutation(api.sharing.setSeriesVisibility, { seriesId, kind: "ownership", visibility: "default" });
  expect((await shared(t)).releases).toBe(1);
}

/** A Bundle with the given member Releases. */
const box = (t: T, publicId: number, name: string, members: Array<Id<"releases">>) =>
  t.run(async (ctx) => {
    const bundleId = await insertBundle(ctx, { publicId, name, publisherId: await firstPublisher(ctx), format: "physical" });
    for (const releaseId of members) await insertBundleMember(ctx, { bundleId, releaseId });
    return bundleId;
  });

/** The Edition behind one of the fixture's Releases. */
const editionOf = (t: T, releaseId: Id<"releases">) =>
  t.run(async (ctx) => (await ctx.db.get(releaseId))!.editionId);

/**
 * An Edition with one Release: Unmapped Packaging on a new line of
 * `lineSeriesId`, or (null) an Edition with neither coverage nor line.
 */
const bareEdition = (t: T, publicId: number, lineSeriesId: Id<"series"> | null) =>
  t.run(async (ctx) => {
    const publisherId = await firstPublisher(ctx);
    const editionLineId = lineSeriesId
      ? await insertEditionLine(ctx, { seriesId: lineSeriesId, publisherId, name: `Line ${publicId}` })
      : undefined;
    const editionId = await insertEdition(ctx, { publicId, publisherId, editionLineId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: lineSeriesId ? [lineSeriesId] : [],
    });
    return { editionId, editionLineId, releaseId };
  });

/** An omnibus Edition covering the given Volumes in order, with no Release. */
const omnibus = (t: T, publicId: number, volumeIds: Array<Id<"volumes">>) =>
  t.run(async (ctx) => {
    const editionId = await insertEdition(ctx, { publicId, publisherId: await firstPublisher(ctx) });
    for (const [index, volumeId] of volumeIds.entries()) {
      await insertCoverage(ctx, { editionId, volumeId, order: index + 1 });
    }
    return editionId;
  });

/** A second Volume of the loser Series, after its first. */
const secondLoserVolume = (t: T, f: Fixture) =>
  t.run((ctx) => insertVolume(ctx, { seriesId: f.loser.seriesId, position: 2 }));

/** A merge that moves a Release to another Series, its Split, and the Release. */
type MergeCase = { merge: () => Promise<unknown>; split: () => Promise<unknown>; releaseId: Id<"releases"> };

// Merges that move a Release off the loser Series, shared by the Split tables below.
const volumeMove = async (t: T, f: Fixture): Promise<MergeCase> => ({
  merge: () => mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId }),
  split: () => splitAs(t, { type: "volume", id: f.loser.volumeId }),
  releaseId: f.loser.releaseId,
});

const editionMove = async (t: T, f: Fixture): Promise<MergeCase> => {
  const loserEdition = await editionOf(t, f.loser.releaseId);
  const survivorEdition = await editionOf(t, f.survivor.releaseId);
  return {
    merge: () => mergeAs(t, { type: "edition", id: survivorEdition }, { type: "edition", id: loserEdition }),
    split: () => splitAs(t, { type: "edition", id: loserEdition }),
    releaseId: f.loser.releaseId,
  };
};

/** Unmapped Packaging on a loser line, merged into a survivor line. */
const editionLineMove = async (t: T, f: Fixture): Promise<MergeCase> => {
  const packaging = await bareEdition(t, 52, f.loser.seriesId);
  const target = await bareEdition(t, 53, f.survivor.seriesId);
  return {
    merge: () => mergeAs(t, { type: "editionLine", id: target.editionLineId! }, { type: "editionLine", id: packaging.editionLineId! }),
    split: () => splitAs(t, { type: "editionLine", id: packaging.editionLineId! }),
    releaseId: packaging.releaseId,
  };
};

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
      await share(t, f.survivor.seriesId);
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
    await share(t, f.survivor.seriesId, ["reading"]);
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
    await hide(t, f.loser.seriesId);
    // The survivor's state row exists but has no overrides of its own.
    await asReader(t).mutation(api.reading.setSeriesReadingStatus, { seriesId: f.survivor.seriesId, status: "reading" });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 4 });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });

    await mergeSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    await publicDefaults(t);
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
    for (const seriesId of [f.survivor.seriesId, f.loser.seriesId]) await share(t, seriesId, ["reading"]);
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 1 });
    await mergeSeries(t, f);
    expect((await shared(t)).reading).toEqual([{ title: "Alpha", status: null, read: [1], passes: 0 }]);
  });
});

describe("merge — cross-Series moves keep Tracking Visibility", () => {
  /** Public defaults, with the loser Series explicitly private for one surface. */
  async function privateLoser(t: T, f: Fixture, kind: Surface) {
    await publicDefaults(t);
    await hide(t, f.loser.seriesId, [kind]);
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
    await hide(t, f.loser.seriesId, ["ownership"]);
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

  /** The Series dave's pass on a Release is filed under. */
  const passSeries = (t: T, releaseId: Id<"releases">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", releaseId)).unique())?.seriesId,
    );

  it("moves an active pass to the survivor's Series on a cross-Series Volume merge, and Split takes it back", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    expect(await shared(t)).toEqual(NOTHING);

    await volumeMerge(t, f);
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ readingVisibility: "private" });
  });

  it("files a pass started after a cross-Series Volume merge under the loser on Split", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    await volumeMerge(t, f);
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.survivor.seriesId);
    // Started under the public survivor, the pass shows; Split takes it back
    // to the loser's private Reading.
    expect((await shared(t)).reading.map((row) => row.title)).toEqual(["Alpha"]);

    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("moves an active pass with its Release's Series on a cross-Series Edition merge, and Split takes it back", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    const loserEdition = await editionOf(t, f.loser.releaseId);

    await mergeAs(t, { type: "edition", id: await editionOf(t, f.survivor.releaseId) }, { type: "edition", id: loserEdition });
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "edition", id: loserEdition });
    expect(await passSeries(t, f.loser.releaseId)).toBe(f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("moves an Unmapped Packaging pass with its Edition Line across Series, and Split takes it back", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    const packaging = await bareEdition(t, 54, f.loser.seriesId);
    const target = await bareEdition(t, 55, f.survivor.seriesId);
    await asReader(t).mutation(api.reading.startPass, { releaseId: packaging.releaseId });
    expect(await passSeries(t, packaging.releaseId)).toBe(f.loser.seriesId);

    await mergeAs(t, { type: "editionLine", id: target.editionLineId! }, { type: "editionLine", id: packaging.editionLineId! });
    expect(await passSeries(t, packaging.releaseId)).toBe(f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "editionLine", id: packaging.editionLineId! });
    expect(await passSeries(t, packaging.releaseId)).toBe(f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a moved omnibus Rating private on an Edition merge across Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await privateLoser(t, f, "reading");
    // Two omnibuses: the loser's leads with the loser Series, the survivor's
    // with the survivor Series; both also collect the other's Volume.
    const survivorOmnibus = await omnibus(t, 700, [f.survivor.volumeId, f.loser.volumeId]);
    const loserOmnibus = await omnibus(t, 701, [f.loser.volumeId, f.survivor.volumeId]);
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
    await publicDefaults(t);
    await hide(t, seriesId, ["ownership"]);
  }

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

  // An Unmapped Packaging Release under the private Series, and the merge
  // that maps it to the other one: [case, private side, prepare].
  const remapping: Array<[string, "loser" | "survivor", (t: T, f: Fixture) => Promise<MergeCase>]> = [
    [
      "a loser's, when an Edition merge maps it to another Series",
      "loser",
      async (t, f) => {
        const packaging = await bareEdition(t, 50, f.loser.seriesId);
        const survivorEdition = await editionOf(t, f.survivor.releaseId);
        return {
          merge: () => mergeAs(t, { type: "edition", id: survivorEdition }, { type: "edition", id: packaging.editionId }),
          split: () => splitAs(t, { type: "edition", id: packaging.editionId }),
          releaseId: packaging.releaseId,
        };
      },
    ],
    [
      "a survivor's, when the loser's coverage maps it to another Series",
      "survivor",
      async (t, f) => {
        const packaging = await bareEdition(t, 51, f.survivor.seriesId);
        const loserEdition = await editionOf(t, f.loser.releaseId);
        return {
          merge: () => mergeAs(t, { type: "edition", id: packaging.editionId }, { type: "edition", id: loserEdition }),
          split: () => splitAs(t, { type: "edition", id: loserEdition }),
          releaseId: packaging.releaseId,
        };
      },
    ],
    ["one whose Edition Line merges across Series", "loser", editionLineMove],
  ];

  it.each(remapping)("keeps an Unmapped Packaging Release's ownership private: %s", async (_, side, prepare) => {
    const t = makeT();
    const f = await setup(t);
    const hidden = f[side].seriesId;
    const mapped = f[side === "loser" ? "survivor" : "loser"].seriesId;
    const seriesOf = async () => (await t.run((ctx) => ctx.db.get(releaseId)))?.seriesIds;
    await privateOwnership(t, hidden);
    const { merge, split, releaseId } = await prepare(t, f);
    await own(t, releaseId);
    expect(await shared(t)).toEqual(NOTHING);

    await merge();
    expect(await seriesOf()).toEqual([mapped]);
    expect(await shared(t)).toEqual(NOTHING);
    await toggleDefaults(t);
    expect(await shared(t)).toEqual(NOTHING);

    await split();
    expect(await seriesOf()).toEqual([hidden]);
    expect(await stateOf(t, f, mapped)).toMatchObject({ ownershipVisibility: "private" });
    expect(await shared(t)).toEqual(NOTHING);

    await merge();
    expect(await shared(t)).toEqual(NOTHING);
    await expectShownWithout(t, mapped);
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
    await publicDefaults(t);
    await hide(t, f.loser.seriesId, ["reading"]);
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    const releaseMerge = () =>
      mergeAs(t, { type: "release", id: f.survivor.releaseId }, { type: "release", id: f.loser.releaseId });

    // The merge synthesizes dave's survivor-Series row to keep the pass private.
    await releaseMerge();
    expect(await stateOf(t, f, f.survivor.seriesId)).toMatchObject({ readingVisibility: "private" });
    // dave then hides his survivor-Series Ownership on that same row and owns the survivor Release.
    await hide(t, f.survivor.seriesId, ["ownership"]);
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.survivor.releaseId, state: "owned" });
    expect(await shared(t)).toEqual(NOTHING);

    await splitAs(t, { type: "release", id: f.loser.releaseId });
    const state = await stateOf(t, f, f.survivor.seriesId);
    expect(state?.ownershipVisibility).toBe("private");
    expect(state?.readingVisibility).toBe("private");
    expect(await shared(t)).toEqual(NOTHING);

    await releaseMerge();
    expect(await shared(t)).toEqual(NOTHING);
    await expectShownWithout(t, f.survivor.seriesId);
  });
});

/** Another Series with one Volume, Edition and Release, like setup's. */
const addSeries = (t: T, publicId: number, title: string) => t.run((ctx) => insertSeriesWithBook(ctx, publicId, title));

describe("split — never widens Tracking Visibility", () => {
  it("keeps a third Series merged into the same survivor private when an earlier merge is split", async () => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    // Private defaults; only the survivor is shared, explicitly.
    await share(t, f.survivor.seriesId);
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
    await share(t, f.survivor.seriesId, ["reading"]);
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
    const secondAlpha = await t.run(async (ctx) => {
      const { seriesId, volumeId } = f.survivor;
      return (await insertBook(ctx, { publisherId: await firstPublisher(ctx), seriesId, volumeId })).releaseId;
    });
    await publicDefaults(t);
    for (const seriesId of [f.loser.seriesId, gamma.seriesId]) await hide(t, seriesId, ["reading"]);
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

// Public defaults throughout: whatever the merged record hid, only an
// override hid it. dave hides a Series after the merge; Split must then show
// nothing the profile did not show just before, however the tracking reached
// the moved records (with the merge, or logged since) and whichever side of
// the merge the hidden Series was on.
describe("split — shows nothing it did not show just before", () => {
  // Each way to track what a Series merge moves (the fixture's loser Volume
  // and Release, the loser's "Dupe Box", an omnibus of two loser Volumes).
  const movedTracking: Array<[string, (t: T, f: Fixture) => Promise<unknown>]> = [
    ["a read count on a moved Volume", (t, f) => asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 9 })],
    ["a pass on a moved Release", (t, f) => asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId })],
    [
      "an Owned moved Release",
      (t, f) => asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" }),
    ],
    [
      "an Owned Bundle holding a moved Release",
      async (t) => {
        const bundle = await t.run(async (ctx) => (await ctx.db.query("releaseBundles").first())!._id);
        return asReader(t).mutation(api.collection.setBundleEntry, { bundleId: bundle, state: "owned" });
      },
    ],
    [
      "a Rating of an omnibus collecting moved Volumes",
      async (t) => {
        const edition = await t.run(async (ctx) => (await ctx.db.query("editions").withIndex("by_publicId", (q) => q.eq("publicId", 800)).unique())!._id);
        return asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: edition }, score: 90 });
      },
    ],
  ];

  describe.each(["before", "after"] as const)("tracking logged %s the merge", (when) => {
    it.each(movedTracking)("keeps %s private when the survivor was hidden after a Series merge", async (_, track) => {
      const t = makeT();
      const f = await setup(t);
      await loserBox(t, f);
      await omnibus(t, 800, [f.loser.volumeId, await secondLoserVolume(t, f)]);
      await publicDefaults(t);
      if (when === "before") {
        await track(t, f);
        expect(await shared(t)).not.toEqual(NOTHING);
      }
      await mergeSeries(t, f);
      await hide(t, f.survivor.seriesId);
      if (when === "after") await track(t, f);
      expect(await shared(t)).toEqual(NOTHING);

      await splitSeries(t, f);
      expect(await shared(t)).toEqual(NOTHING);
      await mergeSeries(t, f);
      expect(await shared(t)).toEqual(NOTHING);
    });
  });

  // Other merges whose Split re-derives the loser Release's Series: [kind, prepare].
  const reDeriving: Array<[string, (t: T, f: Fixture) => Promise<MergeCase>]> = [
    ["Volume", volumeMove],
    ["Edition", editionMove],
    ["Edition Line", editionLineMove],
  ];

  it.each(reDeriving)("keeps a Release owned and read since a %s merge private when the survivor was hidden", async (_, prepare) => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const { merge, split, releaseId } = await prepare(t, f);
    await merge();
    await hide(t, f.survivor.seriesId);
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId, state: "owned" });
    await asReader(t).mutation(api.reading.startPass, { releaseId });
    expect(await shared(t)).toEqual(NOTHING);

    await split();
    expect(await shared(t)).toEqual(NOTHING);
    await merge();
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps reads on both sides private when only the survivor's Reading was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    await mergeSeries(t, f);
    await hide(t, f.survivor.seriesId, ["reading"]);
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.survivor.volumeId, readCount: 2 });
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 9 });
    expect(await shared(t)).toEqual(NOTHING);

    await splitSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a merged Bundle's owner private when the survivor's Series was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const loser = await box(t, 910, "Loser Box", [f.loser.releaseId]);
    const survivor = await box(t, 911, "Survivor Box", [f.survivor.releaseId]);
    await asReader(t).mutation(api.collection.setBundleEntry, { bundleId: loser, state: "owned" });
    expect((await shared(t)).bundles).toEqual(["Loser Box"]);

    await mergeAs(t, { type: "releaseBundle", id: survivor }, { type: "releaseBundle", id: loser });
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "releaseBundle", id: loser });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps the surviving Bundle's owner private when the loser's Series was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const loser = await box(t, 910, "Loser Box", [f.loser.releaseId]);
    const survivor = await box(t, 911, "Survivor Box", [f.survivor.releaseId]);
    await asReader(t).mutation(api.collection.setBundleEntry, { bundleId: survivor, state: "owned" });

    await mergeAs(t, { type: "releaseBundle", id: survivor }, { type: "releaseBundle", id: loser });
    await hide(t, f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "releaseBundle", id: loser });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps the loser Edition's pass and Owned Release private when the survivor's Series was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    const loserEdition = await editionOf(t, f.loser.releaseId);

    await mergeAs(t, { type: "edition", id: await editionOf(t, f.survivor.releaseId) }, { type: "edition", id: loserEdition });
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "edition", id: loserEdition });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps the surviving Edition's Owned Release private when the loser's Series was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.survivor.releaseId, state: "owned" });
    const loserEdition = await editionOf(t, f.loser.releaseId);

    await mergeAs(t, { type: "edition", id: await editionOf(t, f.survivor.releaseId) }, { type: "edition", id: loserEdition });
    await hide(t, f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "edition", id: loserEdition });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a Release merged into an omnibus Release of both Series private when one was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const editionId = await omnibus(t, 801, [f.survivor.volumeId, f.loser.volumeId]);
    const both = await t.run(async (ctx) =>
      insertRelease(ctx, {
        editionId,
        publisherId: await firstPublisher(ctx),
        seriesIds: [f.survivor.seriesId, f.loser.seriesId],
      }),
    );
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });

    await mergeAs(t, { type: "release", id: both }, { type: "release", id: f.loser.releaseId });
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "release", id: f.loser.releaseId });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps an omnibus Rating private through a Volume merge's Split when the survivor was hidden after the merge", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const collected = await omnibus(t, 800, [f.loser.volumeId, await secondLoserVolume(t, f)]);
    const volumeMerge = () => mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId });

    await volumeMerge();
    await hide(t, f.survivor.seriesId);
    await asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: collected }, score: 90 });
    expect(await shared(t)).toEqual(NOTHING);
    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    expect(await shared(t)).toEqual(NOTHING);
    await volumeMerge();
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("refuses a Split that would leave a Release tracked since the merge with no Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const seriesless = await bareEdition(t, 60, null);
    // Nobody tracks the Series-less Edition's Release, so it merges and gains Alpha.
    await mergeAs(t, { type: "edition", id: await editionOf(t, f.survivor.releaseId) }, { type: "edition", id: seriesless.editionId });
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: seriesless.releaseId, state: "owned" });
    await hide(t, f.survivor.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await expect(splitAs(t, { type: "edition", id: seriesless.editionId })).rejects.toThrow(/no Series/);
    expect(await shared(t)).toEqual(NOTHING);
    // Once nobody tracks it, the Split goes through.
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: seriesless.releaseId });
    await splitAs(t, { type: "edition", id: seriesless.editionId });
    expect((await t.run((ctx) => ctx.db.get(seriesless.releaseId)))?.seriesIds).toEqual([]);
  });

  it("refuses a Split that would leave a Bundle owned since the merge with no Series", async () => {
    const t = makeT();
    const f = await setup(t);
    await publicDefaults(t);
    const loser = await box(t, 910, "Loser Box", [f.loser.releaseId]);
    const empty = await box(t, 912, "Empty Box", []);
    await mergeAs(t, { type: "releaseBundle", id: empty }, { type: "releaseBundle", id: loser });
    await asReader(t).mutation(api.collection.setBundleEntry, { bundleId: empty, state: "owned" });
    await hide(t, f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await expect(splitAs(t, { type: "releaseBundle", id: loser })).rejects.toThrow(/no Series/);
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a read logged during a split merge private when its Volume is merged again elsewhere", async () => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    // Private defaults; Alpha, then Gamma, are shared for Reading explicitly.
    await share(t, f.survivor.seriesId, ["reading"]);
    await mergeSeries(t, f);
    await asReader(t).mutation(api.reading.setVolumeReadCount, { volumeId: f.loser.volumeId, readCount: 9 });
    expect((await shared(t)).reading).toEqual([{ title: "Alpha", status: null, read: [9], passes: 0 }]);
    await splitSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);

    await share(t, gamma.seriesId, ["reading"]);
    await mergeAs(t, { type: "series", id: gamma.seriesId }, { type: "series", id: f.loser.seriesId });
    expect(await shared(t)).toEqual(NOTHING);
  });
});

// Public defaults. Another merge's Split files tracking back under a Series
// that has been merged into Gamma since, which dave hid: the Series' own
// Split must keep it hidden although its manifest never moved that tracking.
describe("split — tracking filed under a Series merged since", () => {
  // Merges that move the loser Release off the loser Series: [kind, prepare].
  const movingOff: Array<[string, (t: T, f: Fixture) => Promise<MergeCase>]> = [
    ["Volume", volumeMove],
    ["Edition Line", editionLineMove],
  ];

  it.each(movingOff)("keeps a Release owned and read since a %s merge private through the Splits", async (_, prepare) => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    await publicDefaults(t);
    const { merge, split, releaseId } = await prepare(t, f);
    await merge();
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId, state: "owned" });
    await asReader(t).mutation(api.reading.startPass, { releaseId });
    // The Series merge leaves the Release alone: it answers to Alpha now.
    await mergeAs(t, { type: "series", id: gamma.seriesId }, { type: "series", id: f.loser.seriesId });
    // Shown before dave hides Gamma: the checks below are not vacuous.
    expect((await shared(t)).releases).toBe(1);
    await hide(t, gamma.seriesId);

    await split();
    expect(await shared(t)).toEqual(NOTHING);
    await splitSeries(t, f);
    expect(await shared(t)).toEqual(NOTHING);
    // Back under the Series its coverage or line names, and hidden there.
    expect((await t.run((ctx) => ctx.db.get(releaseId)))?.seriesIds).toEqual([f.loser.seriesId]);
    await mergeAs(t, { type: "series", id: gamma.seriesId }, { type: "series", id: f.loser.seriesId });
    expect(await shared(t)).toEqual(NOTHING);
  });

  it("keeps a Release private when a Split re-derives it while its Series is merged, through a re-merge and Split", async () => {
    const t = makeT();
    const f = await setup(t);
    const gamma = await addSeries(t, 3, "Gamma");
    await publicDefaults(t);
    const alphaIntoGamma = () => mergeAs(t, { type: "series", id: gamma.seriesId }, { type: "series", id: f.survivor.seriesId });
    const splitAlpha = () => splitAs(t, { type: "series", id: f.survivor.seriesId });
    // The loser Release follows its Volume into Alpha, then Alpha into Gamma.
    await mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId });
    await alphaIntoGamma();
    // Its coverage goes back to the loser Volume while Alpha is merged; then Alpha comes back.
    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    await splitAlpha();
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    await alphaIntoGamma();
    await hide(t, gamma.seriesId);
    await hide(t, f.loser.seriesId);
    expect(await shared(t)).toEqual(NOTHING);

    await splitAlpha();
    expect(await shared(t)).toEqual(NOTHING);
    // It is filed under the Series its coverage names, whatever the order of Splits.
    expect((await t.run((ctx) => ctx.db.get(f.loser.releaseId)))?.seriesIds).toEqual([f.loser.seriesId]);
  });
});

describe("merge — Bundles without a Series signal", () => {
  it("refuses to publish a memberless Owned Bundle by merging it with one whose Series is public", async () => {
    const t = makeT();
    const f = await setup(t);
    // Private defaults; Alpha's Ownership is explicitly public.
    await share(t, f.survivor.seriesId, ["ownership"]);
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
    // A public default shows the owned Bundle: the checks above were not vacuous.
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" });
    expect((await shared(t)).bundles).toEqual(["Full Box"]);
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
    await purgeAccount(t, dave.subject);
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

  it("never restores the rows of a User whose deletion is under way", async () => {
    const t = makeT();
    const f = await setup(t);
    await rateAndReviewBoth(t, f);
    await mergeSeries(t, f);
    const daves = () =>
      t.run(async (ctx) => {
        const theirs = async (table: "ratings" | "reviews" | "userSeriesStates") =>
          (await ctx.db.query(table).collect()).filter((row) => row.userId === f.daveId);
        return { ratings: await theirs("ratings"), reviews: await theirs("reviews"), states: await theirs("userSeriesStates") };
      });
    const before = await daves();
    // The merge kept the survivor's rows and logged the loser's for Split.
    expect(before.ratings).toHaveLength(1);
    expect(before.reviews).toHaveLength(1);

    // Marked, with the purge not yet run.
    await t.run((ctx) => ctx.db.patch(f.daveId, { deletingSince: Date.now() }));
    await splitSeries(t, f);

    expect(await daves()).toEqual(before);
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
    await purgeAccount(t, dave.subject);
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
      const aliceRow = (await ctx.db.query("users").collect()).find((u) => u.username === alice.username)!;
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
            { table: "favorites", doc: { userId: aliceRow._id, seriesId: f.loser.seriesId } },
          ],
          inserted: [],
        });
      }
      return aliceRow._id;
    });

    vi.useFakeTimers();
    await purgeAccount(t, dave.subject);
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

describe("merge — denormalized references", () => {
  it("moves an Unmapped Packaging Release's Series denorm with its Edition Line", async () => {
    const t = makeT();
    const f = await setup(t);
    // A line on the loser holding one member with no Volume Coverage yet.
    const { releaseId } = await bareEdition(t, 99, f.loser.seriesId);

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
      const survivorId = await insertPublisher(ctx, { name: "Kodansha" });
      const loserId = await insertPublisher(ctx, { name: "Kodansha Comics" });
      const imprintId = await insertPublisher(ctx, { name: "Vertical", parentPublisherId: loserId });
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
        await insertPublisher(ctx, { status: i === 0 ? "merged" : "active", name: `Imprint ${i}`, parentPublisherId: p.loserId });
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
      const parentId = await insertPublisher(ctx, { name: "Penguin" });
      return await insertPublisher(ctx, { name: "Kodansha USA", parentPublisherId: parentId });
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
      const survivorId = await insertPublisher(ctx, { name: "Kodansha" });
      const loserId = await insertPublisher(ctx, { name: "Kodansha Comics" });
      const editionId = await insertEdition(ctx, { publisherId: loserId });
      const releaseId = await insertRelease(ctx, { editionId, publisherId: loserId, seriesIds: [] });
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

describe("split — a catalog dependency alone narrows nothing", () => {
  /**
   * Public defaults, the loser and survivor explicitly public for Ownership,
   * and Gamma private for `kinds`; a "Mixed Box" holds the loser's Release
   * and Gamma's, which dave owns only when `ownBox` says so.
   */
  async function mixedBox(t: T, f: Fixture, kinds: Surface[], ownBox: boolean) {
    await publicDefaults(t);
    for (const seriesId of [f.loser.seriesId, f.survivor.seriesId]) await share(t, seriesId, ["ownership"]);
    const gamma = await addSeries(t, 3, "Gamma");
    await hide(t, gamma.seriesId, kinds);
    const bundleId = await box(t, 901, "Mixed Box", [f.loser.releaseId, gamma.releaseId]);
    if (ownBox) await asReader(t).mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });
    return gamma;
  }

  const volumeMerge = (t: T, f: Fixture) =>
    mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId });
  const volumeSplit = (t: T, f: Fixture) => splitAs(t, { type: "volume", id: f.loser.volumeId });

  it.each([
    ["Volume", volumeMerge, volumeSplit],
    ["Series", mergeSeries, splitSeries],
  ] as const)("keeps a directly owned Release public through a %s Split when an unowned Bundle holds a private Series", async (_, merge, split) => {
    const t = makeT();
    const f = await setup(t);
    await mixedBox(t, f, ["ownership"], false);
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    expect((await shared(t)).releases).toBe(1);

    await merge(t, f);
    expect((await shared(t)).releases).toBe(1);
    await split(t, f);
    expect((await shared(t)).releases).toBe(1);
    // Gamma's override reached neither side: the Bundle is nothing dave tracks.
    for (const seriesId of [f.loser.seriesId, f.survivor.seriesId]) {
      expect(await stateOf(t, f, seriesId)).toMatchObject({ ownershipVisibility: "public" });
    }
  });

  it("keeps an owned Release public and its owned Bundle private through a Split", async () => {
    const t = makeT();
    const f = await setup(t);
    await mixedBox(t, f, ["ownership"], true);
    await asReader(t).mutation(api.collection.setReleaseEntry, { releaseId: f.loser.releaseId, state: "owned" });
    const owned = { releases: 1, bundles: [] };
    expect(await shared(t)).toMatchObject(owned);

    await volumeMerge(t, f);
    expect(await shared(t)).toMatchObject(owned);
    await volumeSplit(t, f);
    expect(await shared(t)).toMatchObject(owned);
  });

  it("does not let an owned Bundle's Ownership narrow a pass's Reading through a Split", async () => {
    const t = makeT();
    const f = await setup(t);
    await mixedBox(t, f, ["ownership", "reading"], true);
    for (const seriesId of [f.loser.seriesId, f.survivor.seriesId]) await share(t, seriesId, ["reading"]);
    await asReader(t).mutation(api.reading.startPass, { releaseId: f.loser.releaseId });
    const passes = async () => (await shared(t)).reading.reduce((sum, row) => sum + row.passes, 0);
    expect(await passes()).toBe(1);

    await volumeMerge(t, f);
    expect(await passes()).toBe(1);
    await volumeSplit(t, f);
    expect(await passes()).toBe(1);
    expect((await shared(t)).bundles).toEqual([]);
  });
});

describe("merge — omnibus Ratings of hidden records keep Tracking Visibility", () => {
  /** A second Volume of the survivor Series, after its first. */
  const secondSurvivorVolume = (t: T, f: Fixture) =>
    t.run((ctx) => insertVolume(ctx, { seriesId: f.survivor.seriesId, position: 2 }));

  /** Public Reading default with one Series explicitly private for Reading. */
  async function privateReading(t: T, seriesId: Id<"series">) {
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    await hide(t, seriesId, ["reading"]);
  }

  /** Two omnibuses: the loser's of both loser Volumes, the survivor's of two survivor Volumes. */
  async function omnibuses(t: T, f: Fixture) {
    const loserSecond = await secondLoserVolume(t, f);
    return {
      loserOmnibus: await omnibus(t, 700, [f.loser.volumeId, loserSecond]),
      survivorOmnibus: await omnibus(t, 701, [f.survivor.volumeId, await secondSurvivorVolume(t, f)]),
      loserSecond,
    };
  }

  const ratings = async (t: T) => (await profile(t))!.ratings;

  it.each([
    ["its Series", (f: Fixture): RecordRef[] => [{ type: "series", id: f.loser.seriesId }]],
    ["its covered Volumes", (f: Fixture, loserSecond: Id<"volumes">): RecordRef[] => [
      { type: "volume", id: f.loser.volumeId },
      { type: "volume", id: loserSecond },
    ]],
  ] as const)("keeps a loser omnibus Rating private through an Edition merge and Split when its covered records are hidden (%s)", async (_, hidden) => {
    const t = makeT();
    const f = await setup(t);
    const { loserOmnibus, survivorOmnibus, loserSecond } = await omnibuses(t, f);
    await privateReading(t, f.loser.seriesId);
    await asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: loserOmnibus }, score: 37 });
    expect(await ratings(t)).toEqual([]);
    for (const ref of hidden(f, loserSecond)) await hideRecord(t, ref);
    expect(await ratings(t)).toEqual([]);

    await mergeAs(t, { type: "edition", id: survivorOmnibus }, { type: "edition", id: loserOmnibus });
    expect(await ratings(t)).toEqual([]);
    await splitAs(t, { type: "edition", id: loserOmnibus });
    expect(await ratings(t)).toEqual([]);
  });

  it("keeps a survivor omnibus Rating private through an Edition merge when the survivor Series is hidden", async () => {
    const t = makeT();
    const f = await setup(t);
    const { loserOmnibus, survivorOmnibus } = await omnibuses(t, f);
    await privateReading(t, f.survivor.seriesId);
    await share(t, f.loser.seriesId, ["reading"]);
    await asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: survivorOmnibus }, score: 37 });
    await hideRecord(t, { type: "series", id: f.survivor.seriesId });
    expect(await ratings(t)).toEqual([]);

    await mergeAs(t, { type: "edition", id: survivorOmnibus }, { type: "edition", id: loserOmnibus });
    expect(await ratings(t)).toEqual([]);
    await splitAs(t, { type: "edition", id: loserOmnibus });
    expect(await ratings(t)).toEqual([]);
  });

  it("keeps an omnibus Rating private through a cross-Series Volume merge and Split when its Series is hidden", async () => {
    const t = makeT();
    const f = await setup(t);
    const { loserOmnibus } = await omnibuses(t, f);
    await asReader(t).mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    await asReader(t).mutation(api.ratings.set, { target: { kind: "edition", id: loserOmnibus }, score: 37 });
    // Shown under the public default: the checks below are not vacuous.
    expect(await ratings(t)).toHaveLength(1);
    await hide(t, f.loser.seriesId, ["reading"]);
    await hideRecord(t, { type: "series", id: f.loser.seriesId });
    expect(await ratings(t)).toEqual([]);

    await mergeAs(t, { type: "volume", id: f.survivor.volumeId }, { type: "volume", id: f.loser.volumeId });
    expect(await ratings(t)).toEqual([]);
    await splitAs(t, { type: "volume", id: f.loser.volumeId });
    expect(await ratings(t)).toEqual([]);
  });
});
