// Ratings (CONTEXT.md: Rating): one private 1-100 score per user per Series,
// Volume, or omnibus Edition, an aggregate that moves in the same transaction, the "Top
// rated" projection, and the aggregate's upkeep through purge and merge.

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { targetOfRow, type TargetId } from "./lib/ratings";
import { createAudit, replaceCoverage, resolveActor } from "./lib/repair/audit";
import { insertCoverage, insertEdition, insertPublisher, insertRelease } from "./test.factories";
import { alice, bob, makeT, purgeAccount, seedTeam, signedIn, type TestT } from "./test.helpers";
import {
  edition,
  frierenTwins,
  merge,
  omnibusEditions,
  series,
  split,
  volume,
} from "./test.tracking";

const READERS = ["user_a", "user_b", "user_c", "user_d"] as const;

/**
 * The Frieren pair (Series 1 and 2, Volumes 11 and 21), four readers
 * (reader0-3), Administrator alice and Moderator bob.
 */
async function seed() {
  const t = makeT();
  await seedTeam(t, [
    alice,
    bob,
    ...READERS.map((subject, i) => ({ subject, username: `reader${i}` })),
  ]);
  const ids = await t.run(frierenTwins);
  return { t, ids };
}

/** seed() plus the omnibus Editions over Series 1 (901-904; omnibusEditions). */
async function seedBooks() {
  const seeded = await seed();
  const books = await seeded.t.run((ctx) => omnibusEditions(ctx, seeded.ids.one));
  return { ...seeded, books };
}
type Ids = Awaited<ReturnType<typeof seed>>["ids"];

async function rate(t: TestT, subject: string, target: TargetId, score: number | null) {
  return await t.withIdentity({ subject }).mutation(api.ratings.set, { target, score });
}

/** Gives both Series a VIZ book (Editions 900 and 901), so the library lists them, and rebuilds it. */
async function rebuildLibrary(t: TestT, ids: Ids) {
  await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ", slug: "viz" });
    for (const [n, { seriesId, volumeId }] of [ids.one, ids.two].entries()) {
      const editionId = await insertEdition(ctx, { publicId: 900 + n, publisherId });
      await insertCoverage(ctx, { editionId, volumeId, order: 0 });
      await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] });
    }
  });
  await t.action(internal.seriesBrowse.rebuild, {});
}

describe("ratings queries", () => {
  it("mine is null signed out; summary is public", async () => {
    const { t, ids } = await seed();
    expect(await t.query(api.ratings.mine, { target: series(1) })).toBeNull();
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: null,
      count: 0,
    });
    expect(await t.query(api.ratings.summary, { target: series(999) })).toBeNull();

    const mine = await t
      .withIdentity({ subject: "user_a" })
      .query(api.ratings.mine, { target: series(1) });
    expect(mine).toEqual({ target: { kind: "series", id: ids.one.seriesId }, score: null });
  });
});

describe("ratings.set", () => {
  it("sets, changes, and clears, keeping the aggregate exact", async () => {
    const { t, ids } = await seed();
    const target = { kind: "series" as const, id: ids.one.seriesId };

    await rate(t, "user_a", target, 80);
    await rate(t, "user_b", target, 60);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 70,
      count: 2,
    });

    await rate(t, "user_a", target, 100); // change
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 80,
      count: 2,
    });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ score: 100 });

    await rate(t, "user_b", target, null); // clear
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 100,
      count: 1,
    });
    await rate(t, "user_a", target, null);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: null,
      count: 0,
    });
    // An emptied aggregate leaves no row behind; clearing twice is a no-op.
    await rate(t, "user_a", target, null);
    expect(await t.run((ctx) => ctx.db.query("ratingStats").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toEqual([]);
  });

  it("keeps one Rating per user per target, Series and Volume apart", async () => {
    const { t, ids } = await seed();
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 70);
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 90);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 40);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows).toHaveLength(2);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 90,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 40,
      count: 1,
    });
  });

  it("rejects anything but a whole number from 1 to 100, and signed-out callers", async () => {
    const { t, ids } = await seed();
    const target = { kind: "series" as const, id: ids.one.seriesId };
    for (const bad of [0, 101, 7.5, -3, Number.NaN]) {
      await expect(rate(t, "user_a", target, bad)).rejects.toMatchObject({
        data: { code: "invalidScore" },
      });
    }
    await expect(t.mutation(api.ratings.set, { target, score: 50 })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await rate(t, "user_a", target, 1);
    await rate(t, "user_a", target, 100);
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 100,
      count: 1,
    });
  });

  it("refuses a hidden target", async () => {
    const { t, ids } = await seed();
    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(
      rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 50),
    ).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    await expect(
      rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 50),
    ).rejects.toMatchObject({
      data: { code: "notFound" },
    });
  });

  it("is rate limited per user", async () => {
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
    // The library needs a book to list a Series.
    await rebuildLibrary(t, ids);
    const target = { kind: "series" as const, id: ids.one.seriesId };
    const row = () =>
      t.run((ctx) =>
        ctx.db
          .query("seriesStats")
          .withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId))
          .unique(),
      );
    const packRank = () =>
      t.run(
        async (ctx) =>
          (await ctx.db.query("seriesStatsPacks").first())?.entries.find((e) => e.publicId === 1)
            ?.ratingRank,
      );

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
    const filtered = await t.query(api.seriesBrowse.browse, {
      sort: "rating",
      publishers: ["viz"],
    });
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
    const { t, ids } = await seed();
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 100);
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 20);
    await rate(t, "user_b", { kind: "series", id: ids.one.seriesId }, 60);

    await purgeAccount(t, "user_a");
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 60,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: null,
      count: 0,
    });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(1);
  });

  it("a merge repoints Ratings, keeps the survivor's on a clash, recounts, and a split undoes it", async () => {
    const { t, ids } = await seed();
    const survivor = { kind: "series" as const, id: ids.one.seriesId };
    const loser = { kind: "series" as const, id: ids.two.seriesId };
    await rate(t, "user_a", survivor, 90); // user_a rated both: survivor's 90 wins
    await rate(t, "user_a", loser, 30);
    await rate(t, "user_b", loser, 50); // only the loser: moves over
    await rate(t, "user_c", { kind: "volume", id: ids.two.volumeId }, 70); // Volume ratings stay on their Volume

    const mod = signedIn(t, bob);
    await merge(
      mod,
      { type: "series", id: ids.one.seriesId },
      { type: "series", id: ids.two.seriesId },
    );
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 70,
      count: 2,
    });
    // The loser's public ID resolves to the survivor now.
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({
      average: 70,
      count: 2,
    });
    expect(await t.query(api.ratings.summary, { target: volume(21) })).toEqual({
      average: 70,
      count: 1,
    });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: series(1) }),
    ).toMatchObject({ score: 90 });
    const loserStats = await t.run((ctx) =>
      ctx.db
        .query("ratingStats")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.two.seriesId))
        .unique(),
    );
    expect(loserStats).toBeNull();

    await split(mod, { type: "series", id: ids.two.seriesId });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 90,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: series(2) })).toEqual({
      average: 40,
      count: 2,
    });
  });

  it("a Volume merge repoints its Ratings the same way", async () => {
    const { t, ids } = await seed();
    await rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 80);
    await rate(t, "user_a", { kind: "volume", id: ids.two.volumeId }, 20);
    await rate(t, "user_b", { kind: "volume", id: ids.two.volumeId }, 60);
    await merge(
      signedIn(t, alice),
      { type: "volume", id: ids.one.volumeId },
      { type: "volume", id: ids.two.volumeId },
    );
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 70,
      count: 2,
    });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(2);
  });
});

describe("ratings.set on merged and hidden targets", () => {
  it("follows the merge loser's id to the survivor, Series and Volume", async () => {
    const { t, ids } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.two.seriesId, { status: "merged", mergedIntoId: ids.one.seriesId });
      await ctx.db.patch(ids.two.volumeId, { status: "merged", mergedIntoId: ids.one.volumeId });
    });
    await rate(t, "user_a", { kind: "series", id: ids.two.seriesId }, 60);
    await rate(t, "user_a", { kind: "volume", id: ids.two.volumeId }, 30);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows.map((r) => r.seriesId ?? r.volumeId).sort()).toEqual(
      [ids.one.seriesId, ids.one.volumeId].sort(),
    );
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: 60,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 30,
      count: 1,
    });
    const stats = await t.run((ctx) => ctx.db.query("ratingStats").collect());
    expect(
      stats.every((s) => s.seriesId !== ids.two.seriesId && s.volumeId !== ids.two.volumeId),
    ).toBe(true);
  });

  it("refuses a hidden Volume of an active Series", async () => {
    const { t, ids } = await seed();
    await t.run((ctx) => ctx.db.patch(ids.one.volumeId, { status: "hidden" }));
    await expect(
      rate(t, "user_a", { kind: "volume", id: ids.one.volumeId }, 50),
    ).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    // The Series itself is still rateable.
    await rate(t, "user_a", { kind: "series", id: ids.one.seriesId }, 50);
  });
});

describe("syncRatingProjection with a partial library", () => {
  /** A rebuilt library for both seeded Series, then `damage` applied to its packs. */
  async function library(damage: "no pack" | "no entry") {
    const { t, ids } = await seed();
    await rebuildLibrary(t, ids);
    await t.run(async (ctx) => {
      for (const pack of await ctx.db.query("seriesStatsPacks").collect()) {
        if (damage === "no pack") await ctx.db.delete(pack._id);
        else
          await ctx.db.patch(pack._id, { entries: pack.entries.filter((e) => e.publicId !== 1) });
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
        ctx.db
          .query("seriesStats")
          .withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId))
          .unique(),
      );
      expect(row).toMatchObject({ ratingAverage: 80, ratingCount: 3, ratingRank: 80 });
      expect(await t.run((ctx) => ctx.db.query("seriesStatsPacks").collect())).toEqual(packsBefore);
    });
  }
});

describe("omnibus Editions", () => {
  it("rates a multi-volume Edition as one book, apart from its Volumes and Series", async () => {
    const { t, books } = await seedBooks();
    const target = { kind: "edition" as const, id: books.omnibus };

    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: null,
      count: 0,
    });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: edition(901) }),
    ).toEqual({ target, score: null });

    await rate(t, "user_a", target, 90);
    await rate(t, "user_b", target, 70);
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 80,
      count: 2,
    });
    // Its Volumes and Series are untouched.
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: null,
      count: 0,
    });
    expect(await t.query(api.ratings.summary, { target: series(1) })).toEqual({
      average: null,
      count: 0,
    });
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(
      rows.every((row) => row.editionId === books.omnibus && !row.seriesId && !row.volumeId),
    ).toBe(true);
  });

  it("does not feed the Series' Top rated projection", async () => {
    const { t, ids, books } = await seedBooks();
    await t.run((ctx) =>
      insertRelease(ctx, {
        editionId: books.omnibus,
        publisherId: books.publisherId,
        seriesIds: [ids.one.seriesId],
      }),
    );
    await t.action(internal.seriesBrowse.rebuild, {});
    for (const reader of READERS) await rate(t, reader, { kind: "edition", id: books.omnibus }, 90);
    const row = await t.run((ctx) =>
      ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.one.seriesId))
        .unique(),
    );
    expect(row?.ratingCount ?? 0).toBe(0);
    expect(row?.ratingRank ?? 0).toBe(0);
  });

  it("refuses a single-volume Edition with rateVolume, naming the Volume", async () => {
    const { t, books } = await seedBooks();
    await expect(
      rate(t, "user_a", { kind: "edition", id: books.single }, 50),
    ).rejects.toMatchObject({
      data: { code: "rateVolume", message: expect.stringContaining("Frieren Vol 1") },
    });
    expect(await t.query(api.ratings.summary, { target: edition(902) })).toBeNull();
  });

  it("refuses Unmapped Packaging and a hidden Edition", async () => {
    const { t, books } = await seedBooks();
    await expect(
      rate(t, "user_a", { kind: "edition", id: books.unmapped }, 50),
    ).rejects.toMatchObject({
      data: { code: "unmapped" },
    });
    expect(await t.query(api.ratings.summary, { target: edition(903) })).toBeNull();

    await t.run((ctx) => ctx.db.patch(books.omnibus, { status: "hidden" }));
    await expect(
      rate(t, "user_a", { kind: "edition", id: books.omnibus }, 50),
    ).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toBeNull();
  });

  it("purging a user takes their Edition Ratings out of the aggregate", async () => {
    const { t, books } = await seedBooks();
    await rate(t, "user_a", { kind: "edition", id: books.omnibus }, 100);
    await rate(t, "user_b", { kind: "edition", id: books.omnibus }, 60);
    await purgeAccount(t, "user_a");
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 60,
      count: 1,
    });
    expect(await t.run((ctx) => ctx.db.query("ratings").collect())).toHaveLength(1);
  });

  it("an Edition merge repoints Ratings, keeps the survivor's on a clash, recounts, and a split undoes it", async () => {
    const { t, books } = await seedBooks();
    await rate(t, "user_a", { kind: "edition", id: books.omnibus }, 90);
    await rate(t, "user_a", { kind: "edition", id: books.twin }, 30); // clash: survivor's 90 wins
    await rate(t, "user_b", { kind: "edition", id: books.twin }, 50); // moves over

    const admin = signedIn(t, alice);
    await merge(admin, { type: "edition", id: books.omnibus }, { type: "edition", id: books.twin });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 70,
      count: 2,
    });
    expect(await t.query(api.ratings.summary, { target: edition(904) })).toEqual({
      average: 70,
      count: 2,
    });
    const loserStats = await t.run((ctx) =>
      ctx.db
        .query("ratingStats")
        .withIndex("by_edition", (q) => q.eq("editionId", books.twin))
        .unique(),
    );
    expect(loserStats).toBeNull();

    await split(admin, { type: "edition", id: books.twin });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 90,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: edition(904) })).toEqual({
      average: 40,
      count: 2,
    });
  });

  it("a merged Edition's id rates its survivor", async () => {
    const { t, books } = await seedBooks();
    await t.run((ctx) =>
      ctx.db.patch(books.twin, { status: "merged", mergedIntoId: books.omnibus }),
    );
    await rate(t, "user_a", { kind: "edition", id: books.twin }, 60);
    const rows = await t.run((ctx) => ctx.db.query("ratings").collect());
    expect(rows.map((r) => r.editionId)).toEqual([books.omnibus]);
  });
});

describe("targetOfRow", () => {
  it("reads a row back only when exactly one target key is set", () => {
    const seriesId = "s1" as Id<"series">;
    const volumeId = "v1" as Id<"volumes">;
    const editionId = "e1" as Id<"editions">;
    expect(targetOfRow({ volumeId })).toEqual({ kind: "volume", id: volumeId });
    expect(targetOfRow({ seriesId, volumeId })).toBeNull();
    expect(targetOfRow({ volumeId, editionId })).toBeNull();
    expect(targetOfRow({})).toBeNull();
  });
});

const REVIEW = "Three books in one, and the middle one drags.";

describe("omnibus Editions under hidden coverage", () => {
  it("reads as hidden, not single-volume, while its Series or one of its two Volumes is hidden", async () => {
    const { t, ids, books } = await seedBooks();
    const target = { kind: "edition" as const, id: books.omnibus };
    await rate(t, "user_a", target, 80);

    for (const [table, id] of [
      ["series", ids.one.seriesId],
      ["volumes", books.vol2],
    ] as const) {
      await t.run((ctx) => ctx.db.patch(id, { status: "hidden" }));
      expect(await t.query(api.ratings.summary, { target: edition(901) }), table).toBeNull();
      await expect(rate(t, "user_b", target, 50), table).rejects.toMatchObject({
        data: { code: "notFound", message: "Nothing to rate here any more." },
      });
      await t.run((ctx) => ctx.db.patch(id, { status: "active" }));
      expect(await t.query(api.ratings.summary, { target: edition(901) }), table).toEqual({
        average: 80,
        count: 1,
      });
    }
  });
});

describe("omnibus collapse", () => {
  it("a Volume merge that leaves an omnibus one Volume moves its takes there, and a split moves them back", async () => {
    const { t, ids, books } = await seedBooks();
    const admin = signedIn(t, alice);
    const vol1 = ids.one.volumeId;
    const vol2 = books.vol2;
    const omnibus = { kind: "edition" as const, id: books.omnibus };

    await rate(t, "user_a", omnibus, 90);
    await rate(t, "user_b", omnibus, 70);
    await rate(t, "user_a", { kind: "volume", id: vol1 }, 40); // clash: the Volume's own wins
    await t
      .withIdentity({ subject: "user_c" })
      .mutation(api.reviews.save, { target: omnibus, body: REVIEW, spoiler: false });
    await t.withIdentity({ subject: "user_c" }).mutation(api.favorites.toggle, { target: omnibus });
    await t.withIdentity({ subject: "user_a" }).mutation(api.favorites.toggle, { target: omnibus });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.favorites.toggle, { target: { kind: "volume", id: vol1 } });

    // The preview counts what would move: 2 Ratings, 1 Review, 2 Favorites.
    const form = await admin.query(api.sensitiveOps.manageForm, { type: "volume", key: "12" });
    const counts = Object.fromEntries(form!.impact.map((r) => [r.label, r.count]));
    expect(
      counts[
        "Ratings, reviews and favorites of two-volume omnibuses (move to the survivor if the other Volume is merged)"
      ],
    ).toBe(5);

    await merge(admin, { type: "volume", id: vol1 }, { type: "volume", id: vol2 });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 55,
      count: 2,
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toBeNull();
    const state = await t.run(async (ctx) => ({
      editionStats: await ctx.db
        .query("ratingStats")
        .withIndex("by_edition", (q) => q.eq("editionId", books.omnibus))
        .unique(),
      ratings: await ctx.db.query("ratings").collect(),
      reviews: await ctx.db.query("reviews").collect(),
      favorites: await ctx.db.query("favorites").collect(),
    }));
    expect(state.editionStats).toBeNull();
    expect(state.ratings.map(targetOfRow)).toEqual([
      { kind: "volume", id: vol1 },
      { kind: "volume", id: vol1 },
    ]);
    expect(state.reviews.map(targetOfRow)).toEqual([{ kind: "volume", id: vol1 }]);
    expect(state.favorites).toHaveLength(2);
    expect(
      state.favorites.every(
        (row) => row.volumeId === vol1 && !row.editionId && row.seriesId === ids.one.seriesId,
      ),
    ).toBe(true);

    await split(admin, { type: "volume", id: vol2 });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 80,
      count: 2,
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 40,
      count: 1,
    });
    const after = await t.run(async (ctx) => ({
      reviews: await ctx.db.query("reviews").collect(),
      favorites: await ctx.db.query("favorites").collect(),
    }));
    expect(after.reviews.map(targetOfRow)).toEqual([omnibus]);
    expect(after.favorites.filter((row) => row.editionId === books.omnibus)).toHaveLength(2);
    expect(after.favorites.filter((row) => row.volumeId === vol1)).toHaveLength(1);
  });

  it("a coverage remap onto one Volume moves the omnibus' takes to it", async () => {
    const { t, ids, books } = await seedBooks();
    const omnibus = { kind: "edition" as const, id: books.omnibus };
    await rate(t, "user_a", omnibus, 90);
    await t.withIdentity({ subject: "user_b" }).mutation(api.favorites.toggle, { target: omnibus });

    await t.run(async (ctx) => {
      const audit = createAudit(ctx, await resolveActor(ctx, "alice"), "Only Vol 1 inside.", []);
      await replaceCoverage(ctx, audit, books.omnibus, [
        { volumeId: ids.one.volumeId, extent: "complete" },
      ]);
      await audit.finish();
    });
    expect(await t.query(api.ratings.summary, { target: volume(11) })).toEqual({
      average: 90,
      count: 1,
    });
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toBeNull();
    const favorites = await t.run((ctx) => ctx.db.query("favorites").collect());
    expect(favorites).toEqual([
      expect.objectContaining({ volumeId: ids.one.volumeId, seriesId: ids.one.seriesId }),
    ]);
    expect(favorites[0]!.editionId).toBeUndefined();
  });

  it("a Series merge leaves an omnibus' Ratings on it", async () => {
    const { t, ids, books } = await seedBooks();
    await rate(t, "user_a", { kind: "edition", id: books.omnibus }, 90);
    await merge(
      signedIn(t, alice),
      { type: "series", id: ids.two.seriesId },
      { type: "series", id: ids.one.seriesId },
    );
    expect(await t.query(api.ratings.summary, { target: edition(901) })).toEqual({
      average: 90,
      count: 1,
    });
    expect(
      await t.withIdentity({ subject: "user_a" }).query(api.ratings.mine, { target: edition(901) }),
    ).toMatchObject({ score: 90 });
  });

  it("an Edition's impact preview counts its Ratings, Reviews and Favorites", async () => {
    const { t, books } = await seedBooks();
    const omnibus = { kind: "edition" as const, id: books.omnibus };
    await rate(t, "user_a", omnibus, 90);
    await rate(t, "user_b", omnibus, 70);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.reviews.save, { target: omnibus, body: REVIEW, spoiler: false });
    for (const subject of ["user_a", "user_b", "user_c"]) {
      await t.withIdentity({ subject }).mutation(api.favorites.toggle, { target: omnibus });
    }
    const form = await signedIn(t, alice).query(api.sensitiveOps.manageForm, {
      type: "edition",
      key: "901",
    });
    const counts = Object.fromEntries(form!.impact.map((r) => [r.label, r.count]));
    expect(counts).toMatchObject({ Ratings: 2, Reviews: 1, Favorites: 3 });
  });
});
