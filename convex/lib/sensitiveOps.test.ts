// Merge and Split (lib/sensitiveOps.ts): a Series merge must never widen a
// user's Tracking Visibility (the more restrictive per-Series choice
// survives, and Split puts the originals back); Split must never resurrect
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

    // Split restores both rows exactly as they were.
    await splitSeries(t, f);
    const states = await t.run((ctx) => ctx.db.query("userSeriesStates").collect());
    const survivorState = states.find((s) => s.seriesId === f.survivor.seriesId);
    const loserState = states.find((s) => s.seriesId === f.loser.seriesId);
    expect(survivorState?.readingVisibility).toBeUndefined();
    expect(survivorState?.ownershipVisibility).toBeUndefined();
    expect(loserState).toMatchObject({ readingVisibility: "private", ownershipVisibility: "private" });
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

    await splitSeries(t, f);
    const loserState = await t.run((ctx) =>
      ctx.db
        .query("userSeriesStates")
        .withIndex("by_user_series", (q) =>
          q.eq("userId", f.daveId).eq("seriesId", f.loser.seriesId),
        )
        .unique(),
    );
    expect(loserState?.readingVisibility).toBe("public");
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
