// Ratings (CONTEXT.md: Rating): one private 1-100 score per user per Series,
// Volume, or omnibus Edition, an aggregate that moves in the same transaction, the "Top
// rated" projection, and the aggregate's upkeep through purge and merge.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { TargetId } from "./lib/ratings";
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
const edition = (publicId: number) => ({ kind: "edition" as const, publicId });

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

async function rate(t: T, subject: string, target: TargetId, score: number | null) {
  return await t.withIdentity({ subject }).mutation(api.ratings.set, { target, score });
}

describe("ratings queries", () => {
  it("mine is null signed out; summary is public", async () => {
    const t = makeT();
    const ids = await seed(t);
    expect(await t.query(api.ratings.mine, { target: series(1) })).toBeNull();
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: null, count: 0 });
    expect(await t.query(api.ratings.summary, { target: series(999) })).toBeNull();

    const mine = await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) });
    expect(mine).toEqual({ target: { kind: "series", id: ids.one.seriesId }, score: null });
  });
});

describe("ratings.set", () => {
  it("sets, changes, and clears, keeping the aggregate exact", async () => {
    const t = makeT();
    const ids = await seed(t);
    const target = { kind: "series" as const, id: ids.one.seriesId };

    await rate(t, "user_a", target, 80);
    await rate(t, "user_b", target, 60);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 70, count: 2 });

    await rate(t, "user_a", target, 100); // change
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 80, count: 2 });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ score: 100 });

    await rate(t, "user_b", target, null); // clear
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 100, count: 1 });
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
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 70);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 90);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 40);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows).toHaveLength(2);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 90, count: 1 });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: 40, count: 1 });
  });

  it("rejects anything but a whole number from 1 to 100, and signed-out callers", async () => {
    const t = makeT();
    const ids = await seed(t);
    const target = { kind: "series" as const, id: ids.one.seriesId };
    for (const bad of [0, 101, 7.5, -3, Number.NaN]) {
      await expect(rate(t, "user_a", target, bad)).rejects.toMatchObject({ data: { code: "invalidScore" } });
    }
    await expect(t.mutation(api.ratings.set, { target, score: 50 })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await rate(t, "user_a", target, 1);
    await rate(t, "user_a", target, 100);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 100, count: 1 });
  });

  it("refuses a hidden target", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 50)).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    await expect(rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 50)).rejects.toMatchObject({
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
        await rate(t, "user_a", target, ((i % 10) + 1) * 10);
      } catch (err) {
        expect(err).toMatchObject({ data: { kind: "RateLimited" } });
        limited = true;
      }
    }
    expect(limited).toBe(true);
    // Someone else's bucket is untouched.
    await rate(t, "user_b", target, 50);
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

    await rate(t, "user_a", target, 90);
    await rate(t, "user_b", target, 70);
    expect(await row()).toMatchObject({ ratingAverage: 80, ratingCount: 2, ratingRank: 0 });
    expect(await packRank()).toBe(0);

    await rate(t, "user_c", target, 80);
    expect(await row()).toMatchObject({ ratingAverage: 80, ratingCount: 3, ratingRank: 80 });
    expect(await packRank()).toBe(80);

    // Both paths of "Top rated": ranked first, the thinly rated last.
    const titles = (page: { items: Array<{ title: string }> }) => page.items.map((i) => i.title);
    const unfiltered = await t.query(api.seriesBrowse.browse, { sort: "rating" });
    expect(titles(unfiltered)).toEqual(["Frieren", "Frieren (duplicate)"]);
    expect(unfiltered.items[0]).toMatchObject({ ratingAverage: 80, ratingCount: 3 });
    const ascending = await t.query(api.seriesBrowse.browse, { sort: "rating", order: "asc" });
    expect(titles(ascending)).toEqual(["Frieren", "Frieren (duplicate)"]);
    const filtered = await t.query(api.seriesBrowse.browse, { sort: "rating", publishers: ["viz"] });
    expect(titles(filtered)).toEqual(["Frieren", "Frieren (duplicate)"]);

    // A rebuild derives the same numbers from ratingStats.
    await t.action(internal.seriesBrowse.rebuild, {});
    expect(await row()).toMatchObject({ ratingAverage: 80, ratingCount: 3, ratingRank: 80 });

    await rate(t, "user_c", target, null);
    expect(await row()).toMatchObject({ ratingCount: 2, ratingRank: 0 });
    expect(await packRank()).toBe(0);
  });
});

describe("rating upkeep", () => {
  it("purging a user deletes their Ratings and takes them out of the aggregates", async () => {
    const t = makeT();
    const ids = await seed(t);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 100);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 20);
    await rate(t, "user_b", { kind: "series", id: ids.one.seriesId }, 60);

    await t.mutation(internal.users.purgeUser, { clerkSubject: "user_a" });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 60, count: 1 });
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
    await rate(t, "user_a", survivor, 90); // user_a rated both: survivor's 90 wins
    await rate(t, "user_a", loser, 30);
    await rate(t, "user_b", loser, 50); // only the loser: moves over
    await rate(t, "user_c", { kind: "volume", id: ids.two.volumeId }, 70); // Volume ratings stay on their Volume

    const mod = t.withIdentity({ subject: MOD });
    await mod.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.one.seriesId },
      loser: { type: "series", id: ids.two.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 70, count: 2 });
    // The loser's public ID resolves to the survivor now.
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({ average: 70, count: 2 });
    expect(await t.query(api.ratings.summary, { target: volume(21) })).toEqual({ average: 70, count: 1 });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ score: 90 });
    const loserStats = await t.run((ctx) =>
      ctx.db.query("ratingStats").withIndex("by_series", (q) => q.eq("seriesId", ids.two.seriesId)).unique(),
    );
    expect(loserStats).toBeNull();

    await mod.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "series", id: ids.two.seriesId },
      reason: "Not a duplicate after all.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 90, count: 1 });
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({ average: 40, count: 2 });
  });

  it("a Volume merge repoints its Ratings the same way", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
    await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 80);
    await rate(t, "user_a", { kind: "volume", id: ids.two.volumeId }, 20);
    await rate(t, "user_b", { kind: "volume", id: ids.two.volumeId }, 60);
    await t.withIdentity({ subject: ADMIN }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "volume", id: ids.one.volumeId },
      loser: { type: "volume", id: ids.two.volumeId },
      reason: "Same book.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: 70, count: 2 });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(2);
  });
});

describe("ratings.set on merged and hidden targets", () => {
  it("follows the merge loser's id to the survivor, Series and Volume", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.two.seriesId, { status: "merged", mergedIntoId: ids.one.seriesId });
      await ctx.db.patch(ids.two.volumeId, { status: "merged", mergedIntoId: ids.one.volumeId });
    });
    await rate(t, "user_a", { kind: "series", id: ids.two.seriesId }, 60);
    await rate(t, "user_a", { kind: "volume", id: ids.two.volumeId }, 30);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows.map((r) => r.seriesId ?? r.volumeId).sort()).toEqual([ids.one.seriesId, ids.one.volumeId].sort());
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: 60, count: 1 });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: 30, count: 1 });
    const stats = await t.run((ctx) => ctx.db.query("ratingStats").collect());
    expect(stats.every((s) => s.seriesId !== ids.two.seriesId && s.volumeId !== ids.two.volumeId)).toBe(true);
  });

  it("refuses a hidden Volume of an active Series", async () => {
    const t = makeT();
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.patch(ids.one.volumeId, { status: "hidden" }));
    await expect(rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 50)).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    // The Series itself is still rateable.
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 50);
  });
});

describe("syncRatingProjection with a partial library", () => {
  /** A rebuilt library for both seeded Series, then `damage` applied to its packs. */
  async function library(damage: "no pack" | "no entry") {
    const t = makeT();
    const ids = await seed(t);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", { status: "active", name: "VIZ", slug: "viz" });
      for (const [n, { seriesId, volumeId }] of [ids.one, ids.two].entries()) {
        const editionId = await ctx.db.insert("editions", { status: "active", publicId: 900 + n, publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
        await ctx.db.insert("releases", { status: "active", editionId, publisherId, seriesIds: [seriesId], format: "physical", language: "en" });
      }
    });
    await t.action(internal.seriesBrowse.rebuild, {});
    await t.run(async (ctx) => {
      for (const pack of await ctx.db.query("seriesStatsPacks").collect()) {
        if (damage === "no pack") await ctx.db.delete(pack._id);
        else await ctx.db.patch(pack._id, { entries: pack.entries.filter((e) => e.publicId !== 1) });
      }
    });
    return { t, ids };
  }

  for (const damage of ["no pack", "no entry"] as const) {
    it(`updates the row and leaves the packs alone when there is ${damage}`, async () => {
      const { t, ids } = await library(damage);
      const packsBefore = await t.run((ctx) => ctx.db.query("seriesStatsPacks").collect());
      for (const reader of ["user_a", "user_b", "user_c"]) {
        await rate(t, reader, { kind: "series", id: ids.one.seriesId }, 80);
      }
      const row = await t.run((ctx) =>
        ctx.db.query("seriesStats").withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId)).unique(),
      );
      expect(row).toMatchObject({ ratingAverage: 80, ratingCount: 3, ratingRank: 80 });
      expect(await t.run((ctx) => ctx.db.query("seriesStatsPacks").collect())).toEqual(packsBefore);
    });
  }
});

/**
 * Books over the seeded Series 1: two omnibuses of Vol 1-2 (901, 904), a
 * single-volume book of Vol 1 (902), and an Unmapped Packaging line member
 * (903). Series 1 gains Vol 2 (publicId 12).
 */
async function seedEditions(t: T, ids: Awaited<ReturnType<typeof seed>>) {
  return await t.run(async (ctx) => {
    const seriesId = ids.one.seriesId;
    const publisherId = await ctx.db.insert("publishers", { status: "active", name: "VIZ", slug: "viz" });
    const vol2 = await ctx.db.insert("volumes", { status: "active", publicId: 12, seriesId, position: 2, label: "2" });
    const book = async (publicId: number, volumes: Array<Id<"volumes">>) => {
      const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId });
      for (const [order, volumeId] of volumes.entries()) {
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order, extent: "complete" });
      }
      return editionId;
    };
    const lineId = await ctx.db.insert("editionLines", { status: "active", seriesId, publisherId, name: "3-in-1" });
    return {
      omnibus: await book(901, [ids.one.volumeId, vol2]),
      single: await book(902, [ids.one.volumeId]),
      unmapped: await ctx.db.insert("editions", {
        status: "active",
        publicId: 903,
        publisherId,
        editionLineId: lineId,
        coverageUnmapped: true,
      }),
      twin: await book(904, [ids.one.volumeId, vol2]),
    };
  });
}

describe("omnibus Editions", () => {
  it("rates a multi-volume Edition as one book, apart from its Volumes and Series", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    const target = { kind: "edition" as const, id: books.omnibus };

    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({ average: null, count: 0 });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: edition(901) }),
    ).toEqual({ target, score: null });

    await rate(t, "user_a", target, 90);
    await rate(t, "user_b", target, 70);
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({ average: 80, count: 2 });
    // Its Volumes and Series are untouched.
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({ average: null, count: 0 });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({ average: null, count: 0 });
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows.every((row) => row.editionId === books.omnibus && !row.seriesId && !row.volumeId)).toBe(true);
  });

  it("does not feed the Series' Top rated projection", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await t.run(async (ctx) => {
      const edition = (await ctx.db.get(books.omnibus))!;
      await ctx.db.insert("releases", {
        status: "active",
        editionId: books.omnibus,
        publisherId: edition.publisherId,
        seriesIds: [ids.one.seriesId],
        format: "physical",
        language: "en",
      });
    });
    await t.action(internal.seriesBrowse.rebuild, {});
    for (const reader of READERS) await rate(t, reader, { kind: "edition", id: books.omnibus }, 90);
    const row = await t.run((ctx) =>
      ctx.db.query("seriesStats").withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId)).unique(),
    );
    expect(row?.ratingCount ?? 0).toBe(0);
    expect(row?.ratingRank ?? 0).toBe(0);
  });

  it("refuses a single-volume Edition with rateVolume, naming the Volume", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await expect(rate(t, "user_a", { kind: "edition", id: books.single }, 50)).rejects.toMatchObject({
      data: { code: "rateVolume", message: expect.stringContaining("Frieren Vol 1") },
    });
    expect(await t.query(api.ratings.summary, { target: edition(902) })).toBeNull();
  });

  it("refuses Unmapped Packaging and a hidden Edition", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await expect(rate(t, "user_a", { kind: "edition", id: books.unmapped }, 50)).rejects.toMatchObject({
      data: { code: "unmapped" },
    });
    expect(await t.query(api.ratings.summary, { target: edition(903) })).toBeNull();

    await t.run((ctx) => ctx.db.patch(books.omnibus, { status: "hidden" }));
    await expect(rate(t, "user_a", { kind: "edition", id: books.omnibus }, 50)).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toBeNull();
  });

  it("purging a user takes their Edition Ratings out of the aggregate", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await rate(t, "user_a", { kind: "edition", id: books.omnibus }, 100);
    await rate(t, "user_b", { kind: "edition", id: books.omnibus }, 60);
    await t.mutation(internal.users.purgeUser, { clerkSubject: "user_a" });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({ average: 60, count: 1 });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(1);
  });

  it("an Edition merge repoints Ratings, keeps the survivor's on a clash, recounts, and a split undoes it", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
    await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
    await rate(t, "user_a", { kind: "edition", id: books.omnibus }, 90);
    await rate(t, "user_a", { kind: "edition", id: books.twin }, 30); // clash: survivor's 90 wins
    await rate(t, "user_b", { kind: "edition", id: books.twin }, 50); // moves over

    const admin = t.withIdentity({ subject: ADMIN });
    await admin.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "edition", id: books.omnibus },
      loser: { type: "edition", id: books.twin },
      reason: "Same book.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({ average: 70, count: 2 });
    expect(await t.query(api.ratings.summary, { target: edition(904) })).toEqual({ average: 70, count: 2 });
    const loserStats = await t.run((ctx) =>
      ctx.db.query("ratingStats").withIndex("by_edition", (q) => q.eq("editionId", books.twin)).unique(),
    );
    expect(loserStats).toBeNull();

    await admin.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "edition", id: books.twin },
      reason: "Different printings after all.",
      confirmImpact: true,
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({ average: 90, count: 1 });
    expect(await t.query(api.ratings.summary, { target: edition(904) })).toEqual({ average: 40, count: 2 });
  });

  it("a merged Edition's id rates its survivor", async () => {
    const t = makeT();
    const ids = await seed(t);
    const books = await seedEditions(t, ids);
    await t.run((ctx) => ctx.db.patch(books.twin, { status: "merged", mergedIntoId: books.omnibus }));
    await rate(t, "user_a", { kind: "edition", id: books.twin }, 60);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows.map((r) => r.editionId)).toEqual([books.omnibus]);
  });
});
