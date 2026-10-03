import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { seedCatalog } from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

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
    const count = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
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
    await expect(
      asA.mutation(api.users.claimUsername, { username: "admin" }),
    ).rejects.toThrow(/reserved/);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "Admin" }),
    ).rejects.toThrow(/reserved/);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "ab" }),
    ).rejects.toThrow(/invalid/);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "has spaces" }),
    ).rejects.toThrow(/invalid/);
    await expect(
      asA.mutation(api.users.claimUsername, { username: "_leading" }),
    ).rejects.toThrow(/invalid/);
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
      await ctx.db.insert("userSeriesStates", { userId, seriesId, following: true, followPromptDismissed: false });
      await ctx.db.insert("releaseProgress", { userId, releaseId, seriesId });
      await ctx.db.insert("volumeProgress", { userId, volumeId, seriesId, readCount: 1 });
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
      await ctx.db.insert("commentReports", { commentId, reporterId: userId, reason: "spam", createdAt: 0 });
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
  const notTheirs = <Row extends { userId: Id<"users"> }>(list: Row[]) => list.filter((row) => row.userId !== userId);
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
  it("removes the User and every personal record, and nobody else's", async () => {
    const t = makeT();
    const { leaving, staying } = await seedTwoUsers(t);
    const before = await personalRows(t);

    await t.mutation(internal.users.purgeUser, { clerkSubject: SUBJECT_A });

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

  it("is a no-op for unknown subjects", async () => {
    const t = makeT();
    await seedTwoUsers(t);
    const before = await personalRows(t);
    await t.mutation(internal.users.purgeUser, { clerkSubject: "user_none" });
    expect(await personalRows(t)).toEqual(before);
  });
});

describe("users.deleteAccount", () => {
  /** Stubs Clerk's Backend API to answer `status`, recording each request. */
  function stubClerk(status: number) {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_secret");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(null, { status });
    });
    return requests;
  }

  it("deletes the Clerk identity, then purges only the caller's data", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(200);

    await t.withIdentity({ subject: SUBJECT_A }).action(api.users.deleteAccount, {});

    expect(requests).toEqual([
      {
        url: `https://api.clerk.com/v1/users/${SUBJECT_A}`,
        method: "DELETE",
        authorization: "Bearer sk_test_secret",
      },
    ]);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("still purges when Clerk says the identity is already gone (404)", async () => {
    const t = makeT();
    const { leaving } = await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(404);

    await t.withIdentity({ subject: SUBJECT_A }).action(api.users.deleteAccount, {});

    expect(requests).toHaveLength(1);
    expect(await personalRows(t)).toEqual(without(before, leaving));
  });

  it("touches nothing when Clerk refuses, or when signed out", async () => {
    const t = makeT();
    await seedTwoUsers(t);
    const before = await personalRows(t);
    const requests = stubClerk(500);

    await expect(t.withIdentity({ subject: SUBJECT_A }).action(api.users.deleteAccount, {})).rejects.toThrow(
      /HTTP 500/,
    );
    await expect(t.action(api.users.deleteAccount, {})).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    // Only the signed-in call reached Clerk.
    expect(requests).toHaveLength(1);
    expect(await personalRows(t)).toEqual(before);
  });
});
