// Ratings (CONTEXT.md: Rating): one private 1-10 score per user per Series
// or Volume, an aggregate that moves in the same transaction, the "Top
// rated" projection, and the aggregate's upkeep through purge and merge.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const MOD = "user_mod";
const ADMIN = "user_admin";
const READERS = ["user_a", "user_b", "user_c", "user_d"] as const;

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

const series = (publicId: number) => ({ kind: "series" as const, publicId });
const volume = (publicId: number) => ({ kind: "volume" as const, publicId });

/** Two Series (publicIds 1 and 2), each with one Volume (11 and 21), and four readers. */
async function seed(t: T) {
  for (const [i, subject] of READERS.entries()) {
    await t.withIdentity({ subject }).mutation(api.users.claimUsername, { username: `reader${i}` });
  }
  return await t.run(async (ctx) => {
    const mk = async (publicId: number, title: string) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title,
        altTitles: [],
        searchText: title,
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: publicId * 10 + 1,
        seriesId,
        position: 1,
        label: "1",
      });
      return { seriesId, volumeId };
    };
    return { one: await mk(1, "Frieren"), two: await mk(2, "Frieren (duplicate)") };
  });
}

async function rate(t: T, subject: string, target: { kind: "series"; id: Id<"series"> } | { kind: "volume"; id: Id<"volumes"> }, rating: number | null) {
  return await t.withIdentity({ subject }).mutation(api.ratings.set, { target, rating });
}

describe("ratings queries", () => {
  it("mine is null signed out; summary is public", async () => {
    const t = makeT();
    const ids = await seed(t);
    expect(await t.query(api.ratings.mine, { target: series(1) })).toBeNull();
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: null, count: 0 });
    expect(await t.query(api.ratings.summary, { target: series(999) })).toBeNull();

    const mine = await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) });
    expect(mine).toEqual({ target: { kind: "series", id: ids.one.seriesId }, rating: null });
  });
});

describe("ratings.set", () => {
  it("sets, changes, and clears, keeping the aggregate exact", async () => {
    const t = makeT();
    const ids = await seed(t);
    const target = { kind: "series" as const, id: ids.one.seriesId };

    await rate(t, "user_a", target, 8);
    await rate(t, "user_b", target, 6);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 7, count: 2 });

    await rate(t, "user_a", target, 10); // change
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 8, count: 2 });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ rating: 10 });

    await rate(t, "user_b", target, null); // clear
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 10, count: 1 });
    await rate(t, "user_a", target, null);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: null, count: 0 });
    // An emptied aggregate leaves no row behind; clearing twice is a no-op.
    await rate(t, "user_a", target, null);
    expect(await t.run((ctx) => ctx.db.query("ratingStats").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toEqual([]);
  });

  it("keeps one Rating per user per target, Series and Volume apart", async () => {
    const t = makeT();
    const ids = await seed(t);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 7);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 9);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 4);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows).toHaveLength(2);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 9, count: 1 });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: 4, count: 1 });
  });

  it("rejects anything but a whole number from 1 to 10, and signed-out callers", async () => {
    const t = makeT();
    const ids = await seed(t);
    const target = { kind: "series" as const, id: ids.one.seriesId };
    for (const bad of [0, 11, 7.5, -3, Number.NaN]) {
      await expect(rate(t, "user_a", target, bad)).rejects.toMatchObject({ data: { code: "invalidRating" } });
    }
    await expect(t.mutation(api.ratings.set, { target, rating: 5 })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await rate(t, "user_a", target, 1);
    await rate(t, "user_a", target, 10);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 10, count: 1 });
  });

  it("refuses a hidden target", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 5)).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    await expect(rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 5)).rejects.toMatchObject({
      data: { code: "notFound" },
    });
  });

  it("is rate limited per user", async () => {
    const t = makeT();
    const ids = await seed(t);
    const target = { kind: "series" as const, id: ids.one.seriesId };
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      try {
        await rate(t, "user_a", target, (i % 10) + 1);
      } catch (err) {
        expect(err).toMatchObject({ data: { kind: "RateLimited" } });
        limited = true;
      }
    }
    expect(limited).toBe(true);
    // Someone else's bucket is untouched.
    await rate(t, "user_b", target, 5);
  });
});

describe("the Top rated projection", () => {
  it("copies the aggregate into the library row and pack at once, ranking from 3 ratings", async () => {
    const t = makeT();
    const ids = await seed(t);
    // The library needs a book to list a Series.
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", { status: "active", name: "VIZ", slug: "viz" });
      for (const { seriesId, volumeId } of [ids.one, ids.two]) {
        const editionId = await ctx.db.insert("editions", { status: "active", publicId: 900 + (await ctx.db.query("editions").collect()).length, publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
        await ctx.db.insert("releases", { status: "active", editionId, publisherId, seriesIds: [seriesId], format: "physical", language: "en" });
      }
    });
    await t.action(internal.seriesBrowse.rebuild, {});
    const target = { kind: "series" as const, id: ids.one.seriesId };
    const row = () =>
      t.run((ctx) => ctx.db.query("seriesStats").withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId)).unique());
    const packRank = () =>
      t.run(async (ctx) => (await ctx.db.query("seriesStatsPacks").first())?.entries.find((e) => e.publicId === 1)?.ratingRank);

    await rate(t, "user_a", target, 9);
    await rate(t, "user_b", target, 7);
    expect(await row()).toMatchObject({ ratingAverage: 8, ratingCount: 2, ratingRank: 0 });
    expect(await packRank()).toBe(0);

    await rate(t, "user_c", target, 8);
    expect(await row()).toMatchObject({ ratingAverage: 8, ratingCount: 3, ratingRank: 8 });
    expect(await packRank()).toBe(8);

    // Both paths of "Top rated": ranked first, the thinly rated last.
    const titles = (page: { items: Array<{ title: string }> }) => page.items.map((i) => i.title);
    const unfiltered = await t.query(api.seriesBrowse.browse, { sort: "rating" });
    expect(titles(unfiltered)).toEqual(["Frieren", "Frieren (duplicate)"]);
    expect(unfiltered.items[0]).toMatchObject({ ratingAverage: 8, ratingCount: 3 });
    const ascending = await t.query(api.seriesBrowse.browse, { sort: "rating", order: "asc" });
    expect(titles(ascending)).toEqual(["Frieren", "Frieren (duplicate)"]);
    const filtered = await t.query(api.seriesBrowse.browse, { sort: "rating", publishers: ["viz"] });
    expect(titles(filtered)).toEqual(["Frieren", "Frieren (duplicate)"]);

    // A rebuild derives the same numbers from ratingStats.
    await t.action(internal.seriesBrowse.rebuild, {});
    expect(await row()).toMatchObject({ ratingAverage: 8, ratingCount: 3, ratingRank: 8 });

    await rate(t, "user_c", target, null);
    expect(await row()).toMatchObject({ ratingCount: 2, ratingRank: 0 });
    expect(await packRank()).toBe(0);
  });
});

describe("rating upkeep", () => {
  it("purging a user deletes their Ratings and takes them out of the aggregates", async () => {
    const t = makeT();
    const ids = await seed(t);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 10);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 2);
    await rate(t, "user_b", { kind: "series", id: ids.one.seriesId }, 6);

    await t.mutation(internal.users.purgeUser, { clerkSubject: "user_a" });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 6, count: 1 });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: null, count: 0 });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(1);
  });

  it("a merge repoints Ratings, keeps the survivor's on a clash, recounts, and a split undoes it", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
    await t.withIdentity({ subject: MOD }).mutation(api.users.claimUsername, { username: "bob" });
    await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
    await t.withIdentity({ subject: ADMIN }).mutation(api.roles.appoint, { username: "bob", role: "moderator" });

    const survivor = { kind: "series" as const, id: ids.one.seriesId };
    const loser = { kind: "series" as const, id: ids.two.seriesId };
    await rate(t, "user_a", survivor, 9); // user_a rated both: survivor's 9 wins
    await rate(t, "user_a", loser, 3);
    await rate(t, "user_b", loser, 5); // only the loser: moves over
    await rate(t, "user_c", { kind: "volume", id: ids.two.volumeId }, 7); // Volume ratings stay on their Volume

    const mod = t.withIdentity({ subject: MOD });
    await mod.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.one.seriesId },
      loser: { type: "series", id: ids.two.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 7, count: 2 });
    // The loser's public ID resolves to the survivor now.
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({ average: 7, count: 2 });
    expect(await t.query(api.ratings.summary, { target: volume(21) })).toEqual({ average: 7, count: 1 });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ rating: 9 });
    const loserStats = await t.run((ctx) =>
      ctx.db.query("ratingStats").withIndex("by_series", (q) => q.eq("seriesId", ids.two.seriesId)).unique(),
    );
    expect(loserStats).toBeNull();

    await mod.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "series", id: ids.two.seriesId },
      reason: "Not a duplicate after all.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 9, count: 1 });
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({ average: 4, count: 2 });
  });

  it("a Volume merge repoints its Ratings the same way", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
    await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 8);
    await rate(t, "user_a", { kind: "volume", id: ids.two.volumeId }, 2);
    await rate(t, "user_b", { kind: "volume", id: ids.two.volumeId }, 6);
    await t.withIdentity({ subject: ADMIN }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "volume", id: ids.one.volumeId },
      loser: { type: "volume", id: ids.two.volumeId },
      reason: "Same book.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: 7, count: 2 });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(2);
  });
});
