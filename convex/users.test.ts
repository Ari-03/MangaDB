import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const SUBJECT_A = "user_2abc";
const SUBJECT_B = "user_2xyz";

describe("users.viewer", () => {
  it("returns null signed out", async () => {
    const t = convexTest(schema);
    expect(await t.query(api.users.viewer, {})).toBeNull();
  });

  it("reports a pending username claim on first sign-in", async () => {
    const t = convexTest(schema);
    const asA = t.withIdentity({ subject: SUBJECT_A });
    expect(await asA.query(api.users.viewer, {})).toEqual({
      needsUsername: true,
    });
  });
});

describe("users.claimUsername", () => {
  it("rejects unauthenticated claims", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(api.users.claimUsername, { username: "somebody" }),
    ).rejects.toThrow(ConvexError);
  });

  it("creates the User just in time, keyed by the Clerk subject", async () => {
    const t = convexTest(schema);
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
    const t = convexTest(schema);
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
    const t = convexTest(schema);
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
    const t = convexTest(schema);
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "chihiro" });
    await asA.mutation(api.users.claimUsername, { username: "Chihiro" });
    expect(await asA.query(api.users.viewer, {})).toMatchObject({
      username: "Chihiro",
    });
  });

  it("rejects reserved and malformed names", async () => {
    const t = convexTest(schema);
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
    const t = convexTest(schema);
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

describe("users.purgeUser", () => {
  it("removes the User and every personal record", async () => {
    const t = convexTest(schema);
    const asA = t.withIdentity({ subject: SUBJECT_A });
    await asA.mutation(api.users.claimUsername, { username: "leaving" });

    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", SUBJECT_A))
        .unique();
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "A Series",
        altTitles: [],
        searchText: "A Series",
      });
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Pub",
        slug: "pub",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId,
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 1,
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("collectionEntries", {
        userId: user!._id,
        releaseId,
        state: "owned",
      });
      await ctx.db.insert("userSeriesStates", {
        userId: user!._id,
        seriesId,
        following: true,
        followPromptDismissed: false,
      });
      await ctx.db.insert("releaseProgress", {
        userId: user!._id,
        releaseId,
        seriesId,
      });
      await ctx.db.insert("volumeProgress", {
        userId: user!._id,
        volumeId,
        seriesId,
        readCount: 1,
      });
    });

    await t.mutation(internal.users.purgeUser, { clerkSubject: SUBJECT_A });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("users").collect()).toHaveLength(0);
      expect(await ctx.db.query("collectionEntries").collect()).toHaveLength(0);
      expect(await ctx.db.query("userSeriesStates").collect()).toHaveLength(0);
      expect(await ctx.db.query("releaseProgress").collect()).toHaveLength(0);
      expect(await ctx.db.query("volumeProgress").collect()).toHaveLength(0);
    });

    // The catalog is untouched and the subject is back to first-sign-in state.
    expect(await asA.query(api.users.viewer, {})).toEqual({
      needsUsername: true,
    });
  });

  it("is a no-op for unknown subjects", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.users.purgeUser, { clerkSubject: "user_none" });
  });
});
