import { getDocumentSize } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { purgeUserComments } from "./comments";
import { applyRatingDelta } from "./lib/ratings";
import { insertSeries, seedCatalog } from "./test.factories";
import { alice, bob, makeT, purgeAccount, seedTeam, signedIn, type TestT } from "./test.helpers";
import { CLERK_RETRY_DELAYS, PURGE_BATCH, PURGED_ROW_GRACE } from "./users";

const SUBJECT_A = "user_2abc";
const SUBJECT_B = "user_2xyz";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("users.viewer", () => {
  it("returns null signed out", async () => {
    const t = makeT();
    expect(await t.query(api.users.viewer, {})).toBeNull();
  });

  it("reports a pending username claim on first sign-in", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    expect(await asA.query(api.users.viewer, {})).toEqual({
      needsUsername: true,
    });
  });
});

describe("users.setScoreFormat", () => {
  it("defaults to point10, stores the choice, and needs a signed-in user", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "alice" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ scoreFormat: "point10" });

    await asA.mutation(api.users.setScoreFormat, { format: "smiley3" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ scoreFormat: "smiley3" });

    await expect(t.mutation(api.users.setScoreFormat, { format: "star5" })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });
});

describe("users.setAnalyticsOptOut", () => {
  it("is null until chosen, stores either choice, and needs a User", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await expect(
      asA.mutation(api.users.setAnalyticsOptOut, { optOut: true }),
    ).rejects.toMatchObject({
      data: { code: "usernameRequired" },
    });
    await asA.mutation(api.users.claimUsername, { username: "alice" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: null });

    expect(await asA.mutation(api.users.setAnalyticsOptOut, { optOut: true })).toEqual({
      optOut: true,
    });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: true });
    await asA.mutation(api.users.setAnalyticsOptOut, { optOut: false });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: false });

    await expect(t.mutation(api.users.setAnalyticsOptOut, { optOut: true })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  it("writes the User row only when the choice changes", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "alice" });
    // Documents the call wrote, so a repeat of the stored choice (Do Not
    // Track on every mount, lib/analytics.tsx) is seen to leave the row alone.
    const written = (optOut: boolean) =>
      asA.run(async (ctx) => {
        await ctx.runMutation(api.users.setAnalyticsOptOut, { optOut });
        return (await ctx.meta.getTransactionMetrics()).documentsWritten.used;
      });
    expect(await written(true)).toBe(1); // a first choice is stored
    expect(await written(true)).toBe(0);
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: true });
    expect(await written(false)).toBe(1);
    expect(await written(false)).toBe(0);
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: false });
  });

  it("stores an explicit On over a never-made choice", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "alice" });
    await asA.mutation(api.users.setAnalyticsOptOut, { optOut: false });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: false });
  });

  it("stays open to a suspended User", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    await signedIn(t, alice).mutation(api.roles.suspend, {
      username: bob.username,
      reason: "Spam.",
    });
    const asBob = signedIn(t, bob);
    await expect(
      asBob.mutation(api.users.setScoreFormat, { format: "star5" }),
    ).rejects.toMatchObject({
      data: { code: "suspended" },
    });
    await asBob.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    expect(await asBob.query(api.users.viewer, {})).toMatchObject({ analyticsOptOut: true });
  });
});

describe("users.claimUsername", () => {
  it("rejects unauthenticated claims", async () => {
    const t = makeT();
    await expect(
      t.mutation(api.users.claimUsername, { username: "somebody" }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });

  it("creates the User just in time, keyed by the Clerk subject", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A, email: "a@example.com" });
    await asA.mutation(api.users.claimUsername, { username: "Reader_One" });

    const user = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", SUBJECT_A))
        .unique(),
    );
    expect(user).toMatchObject({
      clerkSubject: SUBJECT_A,
      username: "Reader_One",
      usernameNormalized: "reader_one",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
  });

  it("keeps the same User when the email changes (identity is the subject)", async () => {
    const t = makeT();
    const before = t.withIdentity({ subject: SUBJECT_A, email: "old@example.com" });
    await before.mutation(api.users.claimUsername, { username: "stable" });

    const after = t.withIdentity({ subject: SUBJECT_A, email: "new@example.com" });
    expect(await after.query(api.users.viewer, {})).toMatchObject({
      needsUsername: false,
      username: "stable",
    });
    const count = await t.run(async (ctx) => (await ctx.db.query("users").collect()).length);
    expect(count).toBe(1);
  });

  it("enforces case-insensitive uniqueness via the normalized copy", async () => {
    const t = makeT();
    await t
      .withIdentity({ subject: SUBJECT_A })
      .mutation(api.users.claimUsername, { username: "Kaguya" });
    await expect(
      t
        .withIdentity({ subject: SUBJECT_B })
        .mutation(api.users.claimUsername, { username: "kAGUYA" }),
    ).rejects.toThrow(/taken/);
  });

  it("lets the holder re-case their own name", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "chihiro" });
    await asA.mutation(api.users.claimUsername, { username: "Chihiro" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({
      username: "Chihiro",
    });
  });

  it("rejects reserved and malformed names", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await expect(asA.mutation(api.users.claimUsername, { username: "admin" })).rejects.toThrow(
      /reserved/,
    );
    await expect(asA.mutation(api.users.claimUsername, { username: "Admin" })).rejects.toThrow(
      /reserved/,
    );
    await expect(asA.mutation(api.users.claimUsername, { username: "ab" })).rejects.toThrow(
      /invalid/,
    );
    await expect(asA.mutation(api.users.claimUsername, { username: "has spaces" })).rejects.toThrow(
      /invalid/,
    );
    await expect(asA.mutation(api.users.claimUsername, { username: "_leading" })).rejects.toThrow(
      /invalid/,
    );
  });

  it("refuses a suspended user's rename and keeps their old name", async () => {
    const t = makeT();
    await seedTeam(t, [alice]);
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "original" });
    const asAlice = signedIn(t, alice);
    await asAlice.mutation(api.roles.suspend, { username: "original", reason: "Testing." });

    await expect(
      asA.mutation(api.users.claimUsername, { username: "renamed" }),
    ).rejects.toMatchObject({
      data: { code: "suspended" },
    });
    // A new identity's first claim is unaffected, and the old name still resolves.
    await t
      .withIdentity({ subject: SUBJECT_B })
      .mutation(api.users.claimUsername, { username: "renamed" });
    await asAlice.mutation(api.roles.reinstate, { username: "original" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({
      username: "original",
      suspended: false,
    });
  });

  it("releases the old name immediately on change", async () => {
    const t = makeT();
    const asA = t.withIdentity({ subject: SUBJECT_A });
    const asB = t.withIdentity({ subject: SUBJECT_B });
    await asA.mutation(api.users.claimUsername, { username: "original" });
    await asA.mutation(api.users.claimUsername, { username: "renamed" });
    // The freed name is claimable by someone else in the very next mutation.
    await asB.mutation(api.users.claimUsername, { username: "original" });
    expect(await asB.query(api.users.viewer, {})).toMatchObject({
      username: "original",
    });
  });
});

/**
 * Two users, "leaving" (SUBJECT_A) and "staying" (SUBJECT_B), each with a
 * collection entry, a follow, a reading pass, a read Volume, and a Comment
 * they reported themselves, all on one Series. Returns both User ids.
 */
async function seedTwoUsers(t: TestT) {
  for (const [subject, username] of [
    [SUBJECT_A, "leaving"],
    [SUBJECT_B, "staying"],
  ] as const) {
    await t.withIdentity({ subject }).mutation(api.users.claimUsername, { username });
  }
  return await t.run(async (ctx) => {
    const { seriesId, volumeId, releaseId } = await seedCatalog(ctx);
    const userIds: Array<Id<"users">> = [];
    for (const subject of [SUBJECT_A, SUBJECT_B]) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", subject))
        .unique();
      const userId = user!._id;
      userIds.push(userId);
      await ctx.db.insert("collectionEntries", { userId, releaseId, state: "owned" });
      await ctx.db.insert("userSeriesStates", {
        userId,
        seriesId,
        following: true,
        followPromptDismissed: false,
      });
      await ctx.db.insert("releaseProgress", { userId, releaseId, seriesId });
      await ctx.db.insert("volumeProgress", { userId, volumeId, readCount: 1 });
      const commentId = await ctx.db.insert("comments", {
        userId,
        seriesId,
        volumeId,
        body: `A comment by ${subject}`,
        spoiler: false,
        status: "approved",
        reportCount: 1,
        createdAt: 0,
      });
      await ctx.db.insert("commentReports", {
        commentId,
        reporterId: userId,
        reason: "spam",
        createdAt: 0,
      });
    }
    const [leaving, staying] = userIds as [Id<"users">, Id<"users">];
    return { leaving, staying };
  });
}

/** Every User and every row purgeUser may delete. */
async function personalRows(t: TestT) {
  return await t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    collectionEntries: await ctx.db.query("collectionEntries").collect(),
    userSeriesStates: await ctx.db.query("userSeriesStates").collect(),
    releaseProgress: await ctx.db.query("releaseProgress").collect(),
    volumeProgress: await ctx.db.query("volumeProgress").collect(),
    comments: await ctx.db.query("comments").collect(),
    commentReports: await ctx.db.query("commentReports").collect(),
  }));
}
type PersonalRows = Awaited<ReturnType<typeof personalRows>>;

/** What purging `userId` must leave: every row not theirs, unchanged. */
function without(rows: PersonalRows, userId: Id<"users">): PersonalRows {
  const notTheirs = <Row extends { userId: Id<"users"> }>(list: Row[]) =>
    list.filter((row) => row.userId !== userId);
  return {
    users: rows.users.filter((row) => row._id !== userId),
    collectionEntries: notTheirs(rows.collectionEntries),
    userSeriesStates: notTheirs(rows.userSeriesStates),
    releaseProgress: notTheirs(rows.releaseProgress),
    volumeProgress: notTheirs(rows.volumeProgress),
    comments: notTheirs(rows.comments),
    commentReports: rows.commentReports.filter((row) => row.reporterId !== userId),
  };
}

describe("users.purgeUser", () => {
  // Fake timers: the Clerk deletion a finished purge schedules never fires
  // into a later test's stubs.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the User and every personal record, and nobody else's", async () => {
    const t = makeT();
    const { leaving, staying } = await seedTwoUsers(t);
    const before = await personalRows(t);

    await purgeAccount(t, SUBJECT_A);

    const after = await personalRows(t);
    expect(after).toEqual(without(before, leaving));
    // Which leaves the staying user's row in every table.
    expect(after).toMatchObject({
      users: [{ _id: staying }],
      collectionEntries: [{ userId: staying }],
      userSeriesStates: [{ userId: staying }],
      releaseProgress: [{ userId: staying }],
      volumeProgress: [{ userId: staying }],
      comments: [{ userId: staying }],
      commentReports: [{ reporterId: staying }],
    });

    // The catalog is untouched and the subject is back to first-sign-in state.
    expect(await t.withIdentity({ subject: SUBJECT_A }).query(api.users.viewer, {})).toEqual({
      needsUsername: true,
    });
    expect(await t.withIdentity({ subject: SUBJECT_B }).query(api.users.viewer, {})).toMatchObject({
      username: "staying",
    });
  });

  it("does nothing to a User not marked deleting, or a subject with no User", async () => {
    const t = makeT();
    const { staying } = await seedTwoUsers(t);
    const before = await personalRows(t);
    await t.mutation(internal.users.purgeUser, { userId: staying });
    await purgeAccount(t, "user_none");
    expect(await personalRows(t)).toEqual(before);
  });

  it("purges more rows than one run holds across several runs, PURGE_BATCH a run, keeping the row", async () => {
    const t = makeT({ transactionLimits: true });
    const { leaving, staying, seriesId } = await t.run(async (ctx) => {
      const { seriesId, volumeId, releaseId } = await seedCatalog(ctx);
      const user = (username: string, clerkSubject: string) =>
        ctx.db.insert("users", {
          clerkSubject,
          username,
          usernameNormalized: username,
          formatPreference: "both",
          ownershipVisibility: "private",
          readingVisibility: "private",
        });
      const leaving = await user("leaving", SUBJECT_A);
      const staying = await user("staying", SUBJECT_B);
      const target = { kind: "series" as const, id: seriesId };
      // Duplicate rows stand in for a large library: only the count matters here.
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("ratings", { userId: leaving, seriesId, score: 40, updatedAt: 0 });
        await applyRatingDelta(ctx, target, null, 40);
      }
      for (let i = 0; i < PURGE_BATCH + 50; i++) {
        await ctx.db.insert("collectionEntries", { userId: leaving, releaseId, state: "owned" });
      }
      for (let i = 0; i < 80; i++) {
        await ctx.db.insert("volumeProgress", { userId: leaving, volumeId, readCount: 1 });
        await ctx.db.insert("favorites", { userId: leaving, seriesId });
      }
      await ctx.db.insert("ratings", { userId: staying, seriesId, score: 90, updatedAt: 0 });
      await applyRatingDelta(ctx, target, null, 90);
      await ctx.db.insert("collectionEntries", { userId: staying, releaseId, state: "owned" });
      await ctx.db.patch(leaving, { deletingSince: Date.now() });
      return { leaving, staying, seriesId };
    });
    const state = () =>
      t.run(async (ctx) => {
        const theirs = async (
          table: "ratings" | "collectionEntries" | "volumeProgress" | "favorites",
        ) => (await ctx.db.query(table).collect()).filter((row) => row.userId === leaving).length;
        return {
          user: await ctx.db.get(leaving),
          ratings: await theirs("ratings"),
          left:
            (await theirs("ratings")) +
            (await theirs("collectionEntries")) +
            (await theirs("volumeProgress")) +
            (await theirs("favorites")),
          stats: await ctx.db
            .query("ratingStats")
            .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
            .unique(),
          jobs: (await ctx.db.system.query("_scheduled_functions").collect()).map(
            (job) => job.name,
          ),
        };
      });

    // 460 small rows, PURGE_BATCH a run: the run that reads every table to
    // its end marks the row purged and hands it to the Clerk deletion.
    let runs = 0;
    for (;;) {
      await t.mutation(internal.users.purgeUser, { userId: leaving });
      runs += 1;
      const now = await state();
      expect(now.user).not.toBeNull();
      if (now.user?.purgedAt !== undefined) {
        expect(now.left).toBe(0);
        break;
      }
      expect(now.left).toBeGreaterThan(0);
      if (runs === 1) {
        // A full batch: all 50 Ratings, each moving the aggregate, then the rest of PURGE_BATCH.
        expect(now.left).toBe(460 - PURGE_BATCH);
        expect(now.ratings).toBe(0);
        expect(now.stats).toMatchObject({ count: 1, sum: 90 });
      }
    }
    expect(runs).toBe(Math.ceil(460 / PURGE_BATCH));
    const end = await state();
    expect(end.stats).toMatchObject({ count: 1, sum: 90 });
    expect(end.jobs.filter((name) => name.endsWith("deleteClerkIdentity"))).toHaveLength(1);
    expect(end.jobs.filter((name) => name.endsWith("redactMergeManifests"))).toHaveLength(1);

    // Purged rows are not purged again: another run schedules nothing.
    await t.mutation(internal.users.purgeUser, { userId: leaving });
    expect((await state()).jobs).toEqual(end.jobs);

    const kept = await t.run(async (ctx) => ({
      user: await ctx.db.get(staying),
      entries: await ctx.db.query("collectionEntries").collect(),
    }));
    expect(kept.user).not.toBeNull();
    expect(kept.entries).toMatchObject([{ userId: staying }]);
  });

  it("purges Ratings that rewrite a ~1 MB library pack beside maximum-length Reviews within transaction limits", async () => {
    const t = makeT({ transactionLimits: true });
    const SERIES = 40;
    const REVIEWS = 190;
    const leaving = await t.run(async (ctx) => {
      const user = (username: string) =>
        ctx.db.insert("users", {
          clerkSubject: `user_${username}`,
          username,
          usernameNormalized: username,
          formatPreference: "both",
          ownershipVisibility: "private",
          readingVisibility: "private",
        });
      const leaving = await user("leaving");
      const others = [await user("other1"), await user("other2"), await user("other3")];
      // A pack near the 1 MiB document limit: long search keys on all 1,000 entries.
      const entries = Array.from({ length: 1000 }, (_, publicId) => ({
        publicId,
        titleSort: `a reasonably long series title ${publicId}`,
        searchKey: `${publicId} `.padEnd(680, "x"),
        sourceStatus: "ongoing" as const,
        publishers: [{ name: "Publisher", slug: "publisher" }],
        hasPhysical: true,
        hasDigital: true,
        volumeCount: 10,
        latestReleaseSort: 20260901,
        nextReleaseSort: 20261010,
        lastReleasedSort: 20260901,
        followers: 0,
        collectors: 0,
        ratingRank: publicId >= 1 && publicId <= SERIES ? 70 : 0,
      }));
      await ctx.db.insert("seriesStatsPacks", { block: 0, entries });
      for (let publicId = 1; publicId <= SERIES; publicId++) {
        const seriesId = await insertSeries(ctx, { publicId });
        const entry = entries[publicId]!;
        // Three others at 60 and this user at 100: 70 over four ratings, so
        // removing this one moves every Series' rank and rewrites the pack.
        await ctx.db.insert("seriesStats", {
          ...entry,
          seriesId,
          title: entry.titleSort,
          letter: "a",
          releaseCount: 10,
          firstReleaseSort: 20200101,
          coverUrl: null,
          coverIsbn: null,
          rebuiltAt: 0,
          ratingCount: 4,
          ratingAverage: 70,
        });
        await ctx.db.insert("ratings", { userId: leaving, seriesId, score: 100, updatedAt: 0 });
        for (const userId of others)
          await ctx.db.insert("ratings", { userId, seriesId, score: 60, updatedAt: 0 });
        await ctx.db.insert("ratingStats", { seriesId, sum: 280, count: 4 });
      }
      // Maximum-length Reviews of three-byte characters: 15,000 bytes of body each.
      for (let n = 0; n < REVIEWS; n++) {
        const seriesId = await insertSeries(ctx, { publicId: 1000 + n });
        await ctx.db.insert("reviews", {
          userId: leaving,
          seriesId,
          body: "界".repeat(5000),
          status: "visible",
          spoiler: false,
          createdAt: 0,
        });
      }
      await ctx.db.patch(leaving, { deletingSince: Date.now() });
      return leaving;
    });
    const packBytes = await t.run(
      async (ctx) => JSON.stringify(await ctx.db.query("seriesStatsPacks").first()).length,
    );
    expect(packBytes).toBeGreaterThan(1_000_000);
    expect(packBytes).toBeLessThan(1_048_576);

    // The first run takes every Review, then stops for budget, not count:
    // fewer Ratings than PURGE_BATCH leaves room for.
    await t.mutation(internal.users.purgeUser, { userId: leaving });
    const left = await t.run(async (ctx) => ({
      reviews: await ctx.db.query("reviews").collect(),
      ratings: (await ctx.db.query("ratings").collect()).filter((row) => row.userId === leaving)
        .length,
    }));
    expect(left.reviews).toEqual([]);
    expect(left.ratings).toBeGreaterThan(SERIES - (PURGE_BATCH - REVIEWS));
    expect(left.ratings).toBeLessThan(SERIES);
    while ((await t.run((ctx) => ctx.db.get(leaving)))?.purgedAt === undefined) {
      await t.mutation(internal.users.purgeUser, { userId: leaving });
    }

    const end = await t.run(async (ctx) => ({
      series: await ctx.db.query("series").collect(),
      stats: await ctx.db.query("ratingStats").collect(),
      library: await ctx.db.query("seriesStats").collect(),
      pack: (await ctx.db.query("seriesStatsPacks").first())!.entries,
      reviews: await ctx.db.query("reviews").collect(),
      theirs: (await ctx.db.query("ratings").collect()).filter((row) => row.userId === leaving),
    }));
    expect(end.theirs).toEqual([]);
    expect(end.reviews).toEqual([]);
    for (const series of end.series.filter((row) => row.publicId <= SERIES)) {
      expect(end.stats.find((row) => row.seriesId === series._id)).toMatchObject({
        sum: 180,
        count: 3,
      });
      expect(end.library.find((row) => row.seriesId === series._id)).toMatchObject({
        ratingCount: 3,
        ratingAverage: 60,
        ratingRank: 60,
      });
      expect(end.pack.find((entry) => entry.publicId === series.publicId)?.ratingRank).toBe(60);
    }
    // 2 to 5 s alone, and it has run past the 15 s default beside other heavy jobs.
  }, 60_000);

  it("purges Ratings whose library row and pack both near the 1 MiB document limit", async () => {
    const t = makeT({ transactionLimits: true });
    const SERIES = 5;
    const REVIEWS = 190;
    const leaving = await t.run(async (ctx) => {
      const leaving = await ctx.db.insert("users", {
        clerkSubject: SUBJECT_A,
        username: "leaving",
        usernameNormalized: "leaving",
        formatPreference: "both",
        ownershipVisibility: "private",
        readingVisibility: "private",
      });
      // One Series per pack: a library row of about 900 KB (three
      // 300,000-character fields) beside a pack of about 980 KB.
      for (let block = 0; block < SERIES; block++) {
        const publicId = block * 1000;
        const seriesId = await insertSeries(ctx, { publicId });
        const title = "x".repeat(300_000);
        const entry = {
          publicId,
          titleSort: title,
          searchKey: title,
          sourceStatus: "ongoing" as const,
          publishers: [],
          hasPhysical: true,
          hasDigital: false,
          volumeCount: 10,
          latestReleaseSort: 0,
          nextReleaseSort: 0,
          lastReleasedSort: 0,
          followers: 0,
          collectors: 0,
          ratingRank: 70,
        };
        await ctx.db.insert("seriesStats", {
          ...entry,
          seriesId,
          title,
          letter: "x",
          releaseCount: 10,
          firstReleaseSort: 0,
          coverUrl: null,
          coverIsbn: null,
          rebuiltAt: 0,
          ratingCount: 4,
          ratingAverage: 70,
        });
        const filler = {
          ...entry,
          publicId: publicId + 1,
          titleSort: "filler",
          searchKey: "y".repeat(380_000),
        };
        await ctx.db.insert("seriesStatsPacks", { block, entries: [entry, filler] });
        // This user's 100 among four Ratings averaging 70: removing it moves the rank.
        await ctx.db.insert("ratings", { userId: leaving, seriesId, score: 100, updatedAt: 0 });
        await ctx.db.insert("ratingStats", { seriesId, sum: 280, count: 4 });
      }
      for (let n = 0; n < REVIEWS; n++) {
        const seriesId = await insertSeries(ctx, { publicId: 10_000 + n });
        await ctx.db.insert("reviews", {
          userId: leaving,
          seriesId,
          body: "界".repeat(5000),
          status: "visible",
          spoiler: false,
          createdAt: 0,
        });
      }
      await ctx.db.patch(leaving, { deletingSince: Date.now() });
      return leaving;
    });
    const sizes = await t.run(async (ctx) =>
      [
        ...(await ctx.db.query("seriesStats").collect()),
        ...(await ctx.db.query("seriesStatsPacks").collect()),
      ].map(getDocumentSize),
    );
    expect(Math.min(...sizes)).toBeGreaterThan(900_000);
    expect(Math.max(...sizes)).toBeLessThan(1_048_576);

    // Each such Rating reads about 3.8 MB: the first run stops for budget among them.
    await t.mutation(internal.users.purgeUser, { userId: leaving });
    const left = await t.run(async (ctx) => ({
      reviews: await ctx.db.query("reviews").collect(),
      ratings: (await ctx.db.query("ratings").collect()).length,
    }));
    expect(left.reviews).toEqual([]);
    expect(left.ratings).toBeGreaterThan(0);
    expect(left.ratings).toBeLessThan(SERIES);
    while ((await t.run((ctx) => ctx.db.get(leaving)))?.purgedAt === undefined) {
      await t.mutation(internal.users.purgeUser, { userId: leaving });
    }

    const end = await t.run(async (ctx) => ({
      ratings: await ctx.db.query("ratings").collect(),
      library: await ctx.db.query("seriesStats").collect(),
      packs: await ctx.db.query("seriesStatsPacks").collect(),
    }));
    expect(end.ratings).toEqual([]);
    expect(end.library.map((row) => row.ratingRank)).toEqual(Array(SERIES).fill(60));
    expect(end.packs.map((pack) => pack.entries[0]?.ratingRank)).toEqual(Array(SERIES).fill(60));
  });

  it("drains Comments a bounded amount at a time, keeping other authors' rows and counts", async () => {
    const t = makeT();
    const { leaving, staying } = await seedTwoUsers(t);
    const ids = await t.run(async (ctx) => {
      const seriesId = (await ctx.db.query("series").first())!._id;
      const third = await ctx.db.insert("users", {
        clerkSubject: "user_third",
        username: "third",
        usernameNormalized: "third",
        formatPreference: "both",
        ownershipVisibility: "private",
        readingVisibility: "private",
      });
      const post = (userId: Id<"users">, parentId?: Id<"comments">) =>
        ctx.db.insert("comments", {
          userId,
          seriesId,
          parentId,
          body: "text",
          spoiler: false,
          status: "approved",
          reportCount: 0,
          createdAt: 0,
        });
      // Their thread: a reply from staying, one of their own, two reports on it.
      const head = await post(leaving);
      const otherReply = await post(staying, head);
      await post(leaving, head);
      await ctx.db.patch(head, { replyCount: 2, reportCount: 2 });
      for (const reporterId of [staying, third]) {
        await ctx.db.insert("commentReports", {
          commentId: head,
          reporterId,
          reason: "spam",
          createdAt: 0,
        });
      }
      // Staying's thread: their reply in it, and their report on it beside third's.
      const otherHead = await post(staying);
      await post(leaving, otherHead);
      await ctx.db.patch(otherHead, { replyCount: 1, reportCount: 2 });
      await ctx.db.insert("commentReports", {
        commentId: otherHead,
        reporterId: leaving,
        reason: "spam",
        createdAt: 0,
      });
      const thirdReport = await ctx.db.insert("commentReports", {
        commentId: otherHead,
        reporterId: third,
        reason: "spam",
        createdAt: 0,
      });
      return { otherReply, otherHead, thirdReport };
    });

    // One row a call: each call stops wherever its single unit runs out.
    const oneUnit = () => {
      let taken = false;
      return async () => {
        if (taken) return false;
        taken = true;
        return true;
      };
    };
    let calls = 0;
    while (!(await t.run((ctx) => purgeUserComments(ctx, leaving, oneUnit())))) calls += 1;
    expect(calls).toBeGreaterThan(5);

    const after = await t.run(async (ctx) => ({
      comments: await ctx.db.query("comments").collect(),
      reports: await ctx.db.query("commentReports").collect(),
      otherReply: await ctx.db.get(ids.otherReply),
      otherHead: await ctx.db.get(ids.otherHead),
    }));
    expect(after.comments.filter((row) => row.userId === leaving)).toEqual([]);
    expect(after.reports.filter((row) => row.reporterId === leaving)).toEqual([]);
    // The reply in their thread stands alone now.
    expect(after.otherReply?.parentId).toBeUndefined();
    expect(after.otherReply?.replyCount).toBe(0);
    // Staying's thread lost their reply and their report, and keeps third's.
    expect(after.otherHead).toMatchObject({ replyCount: 0, reportCount: 1 });
    expect(after.reports.map((row) => row._id)).toContain(ids.thirdReport);
    // seedTwoUsers' own Comment of staying's, and its self-report, are untouched.
    expect(after.comments.filter((row) => row.userId === staying)).toHaveLength(3);
    expect(after.reports.filter((row) => row.reporterId === staying)).toHaveLength(1);
  });
});

describe("users.deleteAccount", () => {
  /**
   * Stubs Clerk's Backend API, recording each request. Each call answers the
   * next of `answers` (an HTTP status, or "down" for a network error); the
   * last repeats.
   */
  function stubClerk(...answers: Array<number | "down">) {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_secret");
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        const answer = answers[Math.min(requests.length, answers.length) - 1];
        if (answer === "down") throw new TypeError("fetch failed");
        return new Response(null, { status: answer });
      },
    );
    return requests;
  }
  const quiet = () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return vi.spyOn(console, "error").mockImplementation(() => {});
  };
  const scheduled = (t: TestT) =>
    t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  /** Runs every scheduled function already due, and what they schedule at once; later retries wait. */
  const runDue = async (t: TestT) => {
    for (;;) {
      const due = (await scheduled(t)).filter(
        (job) => job.state.kind === "pending" && job.scheduledTime <= Date.now(),
      );
      if (due.length === 0) return;
      vi.advanceTimersByTime(0);
      await t.finishInProgressScheduledFunctions();
    }
  };
  const deletingSince = (t: TestT, userId: Id<"users">) =>
    t.run(async (ctx) => (await ctx.db.get(userId))?.deletingSince ?? null);
  // Fake timers from the start: scheduled work runs only when a test
  // finishes it, never firing into a later test's stubs.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the User, then purges only the caller's data and deletes the Clerk identity", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(200);

    expect(
      await t.withIdentity({ subject: SUBJECT_A }).mutation(api.users.deleteAccount, {}),
    ).toBeNull();
    // Nothing external has happened yet; the mark and the scheduled work committed together.
    expect(requests).toEqual([]);
    expect(await deletingSince(t, leaving)).toEqual(expect.any(Number));

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toEqual([
      {
        url: `https://api.clerk.com/v1/users/${SUBJECT_A}`,
        method: "DELETE",
        authorization: "Bearer sk_test_secret",
      },
    ]);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("treats the User as gone while the deletion is under way", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    stubClerk(200);
    const asA = t.withIdentity({ subject: SUBJECT_A });
    expect(await t.query(api.sharing.publicProfile, { username: "leaving" })).not.toBeNull();

    await asA.mutation(api.users.deleteAccount, {});

    await expect(asA.mutation(api.users.setScoreFormat, { format: "star5" })).rejects.toMatchObject(
      {
        data: { code: "unauthenticated" },
      },
    );
    expect(await asA.query(api.users.viewer, {})).toBeNull();
    // Only deletionPending tells this session from a signed-out one.
    expect(await asA.query(api.users.deletionPending, {})).toBe(true);
    expect(await t.query(api.users.deletionPending, {})).toBe(false);
    expect(await t.withIdentity({ subject: SUBJECT_B }).query(api.users.deletionPending, {})).toBe(
      false,
    );
    // Overlay queries read the viewer as signed out.
    expect(await asA.query(api.collection.myLibrary, {})).toBeNull();
    expect(await t.query(api.sharing.publicProfile, { username: "leaving" })).toBeNull();
    for (const username of ["leaving", "comeback"]) {
      await expect(asA.mutation(api.users.claimUsername, { username })).rejects.toMatchObject({
        data: { code: "unauthenticated" },
      });
    }
    // The name stays taken until the row goes.
    await expect(
      t
        .withIdentity({ subject: "user_new" })
        .mutation(api.users.claimUsername, { username: "leaving" }),
    ).rejects.toThrow(/taken/);
    expect((await personalRows(t)).users.map((row) => row._id)).toContain(leaving);

    // A day after the purge is done and Clerk has confirmed, the name is free.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t
      .withIdentity({ subject: "user_new" })
      .mutation(api.users.claimUsername, { username: "leaving" });
  });

  it("completes the purge when Clerk fails once, and deletes the identity on the retry", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(500, "down", 200);
    quiet();

    await t.withIdentity({ subject: SUBJECT_A }).mutation(api.users.deleteAccount, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(requests).toHaveLength(3);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("counts Clerk's 404 as done", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(404);

    await t.withIdentity({ subject: SUBJECT_A }).mutation(api.users.deleteAccount, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(requests).toHaveLength(1);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("keeps the marked row until a Clerk retry succeeds, so the identity cannot start a new account meanwhile", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(503, 200);
    quiet();
    const asA = t.withIdentity({ subject: SUBJECT_A });

    await asA.mutation(api.users.deleteAccount, {});
    await runDue(t);

    // The purge finished and Clerk failed once: the row stays, marked and empty-handed.
    expect(requests).toHaveLength(1);
    const rows = await personalRows(t);
    expect(rows).toEqual({ ...without(before, leaving), users: rows.users });
    expect(rows.users.find((row) => row._id === leaving)).toMatchObject({
      deletingSince: expect.any(Number),
      purgedAt: expect.any(Number),
    });
    // The identity, still valid at Clerk, can neither use it nor claim another.
    expect(await asA.query(api.users.viewer, {})).toBeNull();
    expect(await asA.query(api.users.deletionPending, {})).toBe(true);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "after" }),
    ).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(2);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("holds the purged row when Clerk keeps failing, logs the retry command, and the manual retry finishes it", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(503);
    const errors = quiet();
    const asA = t.withIdentity({ subject: SUBJECT_A });

    await asA.mutation(api.users.deleteAccount, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(requests).toHaveLength(CLERK_RETRY_DELAYS.length + 1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(
        /Gave up deleting Clerk identity user_2abc .*npx convex run users:deleteClerkIdentity/,
      ),
    );
    // Every personal table is empty; only the marked row is left.
    const rows = await personalRows(t);
    expect(rows).toEqual({ ...without(before, leaving), users: rows.users });
    expect(rows.users.find((row) => row._id === leaving)?.purgedAt).toEqual(expect.any(Number));

    // Asking again schedules nothing, and neither does another purge run.
    const queued = (await scheduled(t)).length;
    expect(await asA.mutation(api.users.deleteAccount, {})).toBeNull();
    await t.mutation(internal.users.purgeUser, { userId: leaving });
    expect(await scheduled(t)).toHaveLength(queued);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "comeback" }),
    ).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });

    // The operator's retry, once Clerk answers.
    const retried = stubClerk(200);
    await t.action(internal.users.deleteClerkIdentity, { clerkSubject: SUBJECT_A, attempt: 0 });
    expect(retried).toHaveLength(1);
    // The row goes PURGED_ROW_GRACE later.
    expect((await personalRows(t)).users.map((row) => row._id)).toContain(leaving);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("contacts Clerk on a manual retry only for a subject whose row is marked deleting and purged", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const requests = stubClerk(200);
    const errors = quiet();
    const retry = (clerkSubject: string) =>
      t.action(internal.users.deleteClerkIdentity, { clerkSubject, attempt: 0 });

    // SUBJECT_A's purge is scheduled but has not run.
    await t.withIdentity({ subject: SUBJECT_A }).mutation(api.users.deleteAccount, {});
    const queued = await scheduled(t);
    await retry(SUBJECT_B);
    await retry("user_none");
    await retry(SUBJECT_A);
    expect(requests).toEqual([]);
    expect(await scheduled(t)).toEqual(queued);
    expect(errors.mock.calls.map(([message]) => message)).toEqual([
      `Not deleting Clerk identity ${SUBJECT_B}: its User is not being deleted.`,
      "Not deleting Clerk identity user_none: no User row has that subject.",
      `Not deleting Clerk identity ${SUBJECT_A}: its User's purge has not finished.`,
    ]);

    // Once the purge has finished, the same retry deletes the identity.
    await t.mutation(internal.users.purgeUser, { userId: leaving });
    await retry(SUBJECT_A);
    expect(requests).toEqual([
      expect.objectContaining({ url: `https://api.clerk.com/v1/users/${SUBJECT_A}` }),
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(leaving))).toBeNull();
    expect(await personalRows(t)).toMatchObject({ users: [{ clerkSubject: SUBJECT_B }] });
  });

  it("refuses an identity with no account, and schedules nothing", async () => {
    const t = makeT();
    await seedTwoUsers(t);
    const requests = stubClerk(200);
    const asNew = t.withIdentity({ subject: "user_unclaimed" });

    await expect(asNew.mutation(api.users.deleteAccount, {})).rejects.toMatchObject({
      data: { code: "noAccount" },
    });
    expect(await scheduled(t)).toEqual([]);
    // A username claimed afterwards is an ordinary new account.
    await asNew.mutation(api.users.claimUsername, { username: "fresh" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toEqual([]);
    expect(await asNew.query(api.users.viewer, {})).toMatchObject({ username: "fresh" });
  });

  it("keeps the purged row for PURGED_ROW_GRACE after Clerk confirms, refusing a still-valid token's claim", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(200);
    const asA = t.withIdentity({ subject: SUBJECT_A });

    await asA.mutation(api.users.deleteAccount, {});
    await runDue(t);

    // Clerk has confirmed; the row stays, marked and purged, and holds the name.
    expect(requests).toHaveLength(1);
    expect((await personalRows(t)).users.find((row) => row._id === leaving)).toMatchObject({
      deletingSince: expect.any(Number),
      purgedAt: expect.any(Number),
    });
    await expect(
      asA.mutation(api.users.claimUsername, { username: "after" }),
    ).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await expect(
      t
        .withIdentity({ subject: "user_new" })
        .mutation(api.users.claimUsername, { username: "leaving" }),
    ).rejects.toThrow(/taken/);

    // A repeated Clerk success, by the operator's retry, schedules a second removal; both are harmless.
    await t.action(internal.users.deleteClerkIdentity, { clerkSubject: SUBJECT_A, attempt: 0 });
    const removals = (await scheduled(t)).filter((job) => job.name.endsWith("removePurgedUser"));
    expect(removals).toHaveLength(2);
    expect(removals.every((job) => job.scheduledTime >= Date.now() + PURGED_ROW_GRACE - 1000)).toBe(
      true,
    );

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await personalRows(t)).toEqual(without(before, leaving));
    await t
      .withIdentity({ subject: "user_new" })
      .mutation(api.users.claimUsername, { username: "leaving" });
  });

  it("answers a second request with the same result and schedules nothing more", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const requests = stubClerk(200);
    const asA = t.withIdentity({ subject: SUBJECT_A });

    expect(await asA.mutation(api.users.deleteAccount, {})).toBeNull();
    const marked = await deletingSince(t, leaving);
    const queued = (await scheduled(t)).length;
    expect(await asA.mutation(api.users.deleteAccount, {})).toBeNull();
    expect(await deletingSince(t, leaving)).toBe(marked);
    expect(await scheduled(t)).toHaveLength(queued);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(1);
  });

  it("refuses when signed out, or when the deployment has no Clerk secret", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    quiet();
    await expect(t.mutation(api.users.deleteAccount, {})).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await expect(
      t.withIdentity({ subject: SUBJECT_A }).mutation(api.users.deleteAccount, {}),
    ).rejects.toMatchObject({
      data: { code: "unconfigured" },
    });
    expect(await deletingSince(t, leaving)).toBeNull();
    expect(await scheduled(t)).toEqual([]);
  });

  it("refuses the last active Administrator until another is appointed", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    const requests = stubClerk(200);
    const asAlice = signedIn(t, alice);
    const aliceId = await t.run(
      async (ctx) =>
        (await ctx.db.query("users").collect()).find((u) => u.username === "alice")!._id,
    );
    const queued = (await scheduled(t)).length;

    await expect(asAlice.mutation(api.users.deleteAccount, {})).rejects.toMatchObject({
      data: {
        code: "lastAdministrator",
        message: expect.stringMatching(/Appoint another Administrator/),
      },
    });
    expect(await deletingSince(t, aliceId)).toBeNull();
    expect(await scheduled(t)).toHaveLength(queued);

    await asAlice.mutation(api.roles.appoint, { username: "bob", role: "administrator" });
    await asAlice.mutation(api.users.deleteAccount, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(aliceId))).toBeNull();
  });

  it("stops counting a deleting Administrator as active", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    stubClerk(200);
    const asAlice = signedIn(t, alice);
    await asAlice.mutation(api.roles.appoint, { username: "bob", role: "administrator" });

    await signedIn(t, bob).mutation(api.users.deleteAccount, {});

    // Bob's deletion is pending: alice is the last active Administrator.
    await expect(asAlice.mutation(api.roles.revoke, { username: "alice" })).rejects.toMatchObject({
      data: { code: "lastAdministrator" },
    });
    await expect(asAlice.mutation(api.users.deleteAccount, {})).rejects.toMatchObject({
      data: { code: "lastAdministrator" },
    });
    expect(await asAlice.query(api.roles.roster, {})).toEqual([
      { username: "alice", role: "administrator", suspended: false },
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
