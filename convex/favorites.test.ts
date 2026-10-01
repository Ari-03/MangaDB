// Favorites (CONTEXT.md: Favorite): one private mark per user per Series,
// Volume, or omnibus Edition, toggled on and off; the library list; and upkeep through hidden
// and merged targets, account purge, and merge / split.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { TargetId } from "./lib/ratings";
import schema from "./schema";

const ADMIN = "user_admin";
const READER = "user_a";
const OTHER = "user_b";

const series = (publicId: number) => ({ kind: "series" as const, publicId });
const volume = (publicId: number) => ({ kind: "volume" as const, publicId });

/** Two Series (publicIds 1 and 2), each with one Volume (11 and 21), an admin, and two readers. */
async function seed() {
  const t = convexTest(schema);
  for (const [subject, username] of [
    [ADMIN, "alice"],
    [READER, "carol"],
    [OTHER, "dave"],
  ] as const) {
    await t.withIdentity({ subject }).mutation(api.users.claimUsername, { username });
  }
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  const ids = await t.run(async (ctx) => {
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
  return { t, ids };
}
type T = Awaited<ReturnType<typeof seed>>["t"];
type Target = TargetId;

const toggle = (t: T, subject: string, target: Target) =>
  t.withIdentity({ subject }).mutation(api.favorites.toggle, { target });
const rows = (t: T) => t.run((ctx) => ctx.db.query("favorites").collect());

describe("favorites.isFavorite", () => {
  it("is null signed out and for unknown targets; false before any toggle", async () => {
    const { t, ids } = await seed();
    expect(await t.query(api.favorites.isFavorite, { target: series(1) })).toBeNull();
    expect(await t.query(api.favorites.mine, {})).toBeNull();
    const reader = t.withIdentity({ subject: READER });
    expect(await reader.query(api.favorites.isFavorite, { target: series(999) })).toBeNull();
    expect(await reader.query(api.favorites.isFavorite, { target: series(1) })).toEqual({
      target: { kind: "series", id: ids.one.seriesId },
      favorite: false,
    });
  });
});

describe("favorites.toggle", () => {
  it("turns a Favorite on and off, one per user per target, Series and Volume apart", async () => {
    const { t, ids } = await seed();
    const reader = t.withIdentity({ subject: READER });
    const seriesTarget = { kind: "series" as const, id: ids.one.seriesId };
    const volumeTarget = { kind: "volume" as const, id: ids.one.volumeId };

    expect(await toggle(t, READER, seriesTarget)).toEqual({ favorite: true });
    expect(await toggle(t, READER, volumeTarget)).toEqual({ favorite: true });
    expect(await toggle(t, OTHER, seriesTarget)).toEqual({ favorite: true });
    expect(await reader.query(api.favorites.isFavorite, { target: series(1) })).toMatchObject({ favorite: true });
    expect(await reader.query(api.favorites.isFavorite, { target: volume(11) })).toMatchObject({ favorite: true });
    // A Volume row carries its Series; it is not the Series' Favorite.
    const stored = await rows(t);
    expect(stored).toHaveLength(3);
    expect(stored.find((r) => r.volumeId)).toMatchObject({ seriesId: ids.one.seriesId, volumeId: ids.one.volumeId });

    expect(await toggle(t, READER, seriesTarget)).toEqual({ favorite: false });
    expect(await reader.query(api.favorites.isFavorite, { target: series(1) })).toMatchObject({ favorite: false });
    expect(await reader.query(api.favorites.isFavorite, { target: volume(11) })).toMatchObject({ favorite: true });
    expect(await rows(t)).toHaveLength(2);
  });

  it("needs a signed-in user", async () => {
    const { t, ids } = await seed();
    await expect(
      t.mutation(api.favorites.toggle, { target: { kind: "series", id: ids.one.seriesId } }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });

  it("refuses a hidden target and follows a merged one to its survivor", async () => {
    const { t, ids } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.one.volumeId, { status: "hidden" });
      await ctx.db.patch(ids.two.seriesId, { status: "merged", mergedIntoId: ids.one.seriesId });
    });
    await expect(toggle(t, READER, { kind: "volume", id: ids.one.volumeId })).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    expect(await toggle(t, READER, { kind: "series", id: ids.two.seriesId })).toEqual({ favorite: true });
    expect((await rows(t)).map((r) => r.seriesId)).toEqual([ids.one.seriesId]);
  });
});

describe("favorites.mine", () => {
  it("lists active Favorites newest first and skips hidden ones", async () => {
    const { t, ids } = await seed();
    await toggle(t, READER, { kind: "series", id: ids.one.seriesId });
    await toggle(t, READER, { kind: "volume", id: ids.two.volumeId });
    await toggle(t, READER, { kind: "series", id: ids.two.seriesId });
    const reader = t.withIdentity({ subject: READER });
    const mine = await reader.query(api.favorites.mine, {});
    expect(mine!.items.map((i) => [i.kind, i.publicId, i.title])).toEqual([
      ["series", 2, "Frieren (duplicate)"],
      ["volume", 21, "Frieren (duplicate) Vol 1"],
      ["series", 1, "Frieren"],
    ]);
    expect(mine!.items[0]).toMatchObject({ mature: false, coverUrl: null, coverIsbn: null });

    await t.run((ctx) => ctx.db.patch(ids.two.seriesId, { status: "hidden" }));
    expect((await reader.query(api.favorites.mine, {}))!.items.map((i) => i.publicId)).toEqual([1]);
    // The rows stay, so a restore brings them back.
    expect(await rows(t)).toHaveLength(3);
    // Nobody else sees them.
    expect((await t.withIdentity({ subject: OTHER }).query(api.favorites.mine, {}))!.items).toEqual([]);
  });
});

describe("favorite upkeep", () => {
  it("purging a user deletes their Favorites only", async () => {
    const { t, ids } = await seed();
    await toggle(t, READER, { kind: "series", id: ids.one.seriesId });
    await toggle(t, READER, { kind: "volume", id: ids.one.volumeId });
    await toggle(t, OTHER, { kind: "series", id: ids.one.seriesId });
    await t.mutation(internal.users.purgeUser, { clerkSubject: READER });
    expect(await rows(t)).toHaveLength(1);
  });

  it("a Series merge repoints Favorites, keeps the survivor's on a clash, and a split undoes it", async () => {
    const { t, ids } = await seed();
    await toggle(t, READER, { kind: "series", id: ids.one.seriesId }); // favorited both: survivor's wins
    await toggle(t, READER, { kind: "series", id: ids.two.seriesId });
    await toggle(t, OTHER, { kind: "series", id: ids.two.seriesId }); // only the loser: moves over
    await toggle(t, OTHER, { kind: "volume", id: ids.two.volumeId }); // follows its Volume to the survivor

    const admin = t.withIdentity({ subject: ADMIN });
    await admin.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.one.seriesId },
      loser: { type: "series", id: ids.two.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    const merged = await rows(t);
    expect(merged).toHaveLength(3);
    expect(merged.every((r) => r.seriesId === ids.one.seriesId)).toBe(true);
    const other = t.withIdentity({ subject: OTHER });
    expect(await other.query(api.favorites.isFavorite, { target: series(1) })).toMatchObject({ favorite: true });
    expect(await other.query(api.favorites.isFavorite, { target: volume(21) })).toMatchObject({ favorite: true });

    await admin.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "series", id: ids.two.seriesId },
      reason: "Not a duplicate after all.",
      confirmImpact: true,
    });
    const split = await rows(t);
    expect(split).toHaveLength(4);
    expect(split.filter((r) => r.seriesId === ids.two.seriesId)).toHaveLength(3);
  });

  it("a Volume merge repoints its Favorites with their Series", async () => {
    const { t, ids } = await seed();
    await toggle(t, READER, { kind: "volume", id: ids.one.volumeId });
    await toggle(t, READER, { kind: "volume", id: ids.two.volumeId });
    await toggle(t, OTHER, { kind: "volume", id: ids.two.volumeId });
    await t.withIdentity({ subject: ADMIN }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "volume", id: ids.one.volumeId },
      loser: { type: "volume", id: ids.two.volumeId },
      reason: "Same book.",
      confirmImpact: true,
    });
    const merged = await rows(t);
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.volumeId === ids.one.volumeId && r.seriesId === ids.one.seriesId)).toBe(true);
  });
});

/**
 * Books over Series 1 (which gains Vol 2, publicId 12): two omnibuses of
 * Vol 1-2 (901, with a Release, and 904), a single-volume book of Vol 1
 * (902), and an Unmapped Packaging line member (903).
 */
async function seedEditions(t: T, ids: Awaited<ReturnType<typeof seed>>["ids"]) {
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
    const omnibus = await book(901, [ids.one.volumeId, vol2]);
    await ctx.db.insert("releases", {
      status: "active",
      editionId: omnibus,
      publisherId,
      seriesIds: [seriesId],
      format: "physical",
      language: "en",
      isbn13: "9781974700001",
    });
    const lineId = await ctx.db.insert("editionLines", { status: "active", seriesId, publisherId, name: "3-in-1" });
    return {
      omnibus,
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

const edition = (publicId: number) => ({ kind: "edition" as const, publicId });

describe("Favorites of an omnibus Edition", () => {
  it("favorites a multi-volume Edition apart from its Series, carrying the Series", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    const reader = t.withIdentity({ subject: READER });
    const target = { kind: "edition" as const, id: books.omnibus };

    expect(await reader.query(api.favorites.isFavorite, { target: edition(901) })).toEqual({ target, favorite: false });
    expect(await toggle(t, READER, target)).toEqual({ favorite: true });
    expect(await rows(t)).toEqual([expect.objectContaining({ seriesId: ids.one.seriesId, editionId: books.omnibus })]);
    // Not the Series' Favorite, and the Series' own toggles on and off beside it.
    expect(await reader.query(api.favorites.isFavorite, { target: series(1) })).toMatchObject({ favorite: false });
    expect(await toggle(t, READER, { kind: "series", id: ids.one.seriesId })).toEqual({ favorite: true });
    expect(await toggle(t, READER, { kind: "series", id: ids.one.seriesId })).toEqual({ favorite: false });
    expect(await reader.query(api.favorites.isFavorite, { target: edition(901) })).toMatchObject({ favorite: true });

    expect(await toggle(t, READER, target)).toEqual({ favorite: false });
    expect(await rows(t)).toEqual([]);
  });

  it("refuses a single-volume Edition and Unmapped Packaging", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await expect(toggle(t, READER, { kind: "edition", id: books.single })).rejects.toMatchObject({
      data: { code: "rateVolume" },
    });
    await expect(toggle(t, READER, { kind: "edition", id: books.unmapped })).rejects.toMatchObject({
      data: { code: "unmapped" },
    });
    const reader = t.withIdentity({ subject: READER });
    expect(await reader.query(api.favorites.isFavorite, { target: edition(902) })).toBeNull();
  });

  it("lists an Edition Favorite in the library with its title, cover and link kind", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await toggle(t, READER, { kind: "edition", id: books.omnibus });
    const mine = await t.withIdentity({ subject: READER }).query(api.favorites.mine, {});
    expect(mine!.items).toEqual([
      {
        kind: "edition",
        target: { kind: "edition", id: books.omnibus },
        publicId: 901,
        title: "Frieren Vol 1–2",
        seriesTitle: "Frieren",
        label: null,
        mature: false,
        coverUrl: null,
        coverIsbn: "9781974700001",
      },
    ]);
    // A hidden Edition drops out while hidden.
    await t.run((ctx) => ctx.db.patch(books.omnibus, { status: "hidden" }));
    expect((await t.withIdentity({ subject: READER }).query(api.favorites.mine, {}))!.items).toEqual([]);
  });

  // B36: a Volume Favorite's art follows the Volume page, which lists only active Editions.
  it("takes a Volume Favorite's cover only from active Editions", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await toggle(t, READER, { kind: "volume", id: ids.one.volumeId });
    const reader = t.withIdentity({ subject: READER });
    const cover = async () => (await reader.query(api.favorites.mine, {}))!.items[0];
    expect(await cover()).toMatchObject({ publicId: 11, coverIsbn: "9781974700001" });
    await t.run((ctx) => ctx.db.patch(books.omnibus, { status: "hidden" }));
    expect(await cover()).toMatchObject({ publicId: 11, coverUrl: null, coverIsbn: null });
  });

  // An ebook ISBN rarely has art upstream; the print one usually does.
  it("looks a favorited Edition's jacket up by its print ISBN, though the ebook came first", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await t.run(async (ctx) => {
      const twin = (await ctx.db.get(books.twin))!;
      const release = (format: "physical" | "digital", isbn13: string, sort: number) =>
        ctx.db.insert("releases", {
          status: "active",
          editionId: books.twin,
          publisherId: twin.publisherId,
          seriesIds: [ids.one.seriesId],
          format,
          language: "en",
          isbn13,
          pubDate: { year: Math.floor(sort / 10000), sort },
        });
      await release("digital", "9781974700902", 20240101);
      await release("physical", "9781974700901", 20240601);
    });
    await toggle(t, READER, { kind: "edition", id: books.twin });
    const mine = await t.withIdentity({ subject: READER }).query(api.favorites.mine, {});
    expect(mine!.items[0]).toMatchObject({ publicId: 904, coverUrl: null, coverIsbn: "9781974700901" });
  });

  it("looks a favorited Volume's jacket up by a print ISBN before an ebook one", async () => {
    const { t, ids } = await seed();
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", { status: "active", name: "VIZ", slug: "viz" });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 905, publisherId });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: ids.two.volumeId,
        order: 0,
        extent: "complete",
      });
      for (const [format, isbn13] of [
        ["digital", "9781974700952"],
        ["physical", "9781974700951"],
      ] as const) {
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          publisherId,
          seriesIds: [ids.two.seriesId],
          format,
          language: "en",
          isbn13,
        });
      }
    });
    await toggle(t, READER, { kind: "volume", id: ids.two.volumeId });
    const mine = await t.withIdentity({ subject: READER }).query(api.favorites.mine, {});
    expect(mine!.items[0]).toMatchObject({ publicId: 21, coverUrl: null, coverIsbn: "9781974700951" });
  });

  it("purging a user deletes their Edition Favorites", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await toggle(t, READER, { kind: "edition", id: books.omnibus });
    await toggle(t, OTHER, { kind: "edition", id: books.omnibus });
    await t.mutation(internal.users.purgeUser, { clerkSubject: READER });
    expect(await rows(t)).toEqual([expect.objectContaining({ editionId: books.omnibus })]);
  });

  it("an Edition merge repoints Favorites, keeps the survivor's on a clash, and a split undoes it", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await toggle(t, READER, { kind: "edition", id: books.omnibus }); // both: survivor's wins
    await toggle(t, READER, { kind: "edition", id: books.twin });
    await toggle(t, OTHER, { kind: "edition", id: books.twin }); // only the loser: moves over
    const admin = t.withIdentity({ subject: ADMIN });
    await admin.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "edition", id: books.omnibus },
      loser: { type: "edition", id: books.twin },
      reason: "Same book.",
      confirmImpact: true,
    });
    const merged = await rows(t);
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.editionId === books.omnibus)).toBe(true);

    await admin.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "edition", id: books.twin },
      reason: "Different printings after all.",
      confirmImpact: true,
    });
    const split = await rows(t);
    expect(split).toHaveLength(3);
    expect(split.filter((r) => r.editionId === books.twin)).toHaveLength(2);
  });

  it("a Series merge keeps an Edition Favorite beside the user's Favorite of the survivor", async () => {
    const { t, ids } = await seed();
    const books = await seedEditions(t, ids);
    await toggle(t, READER, { kind: "series", id: ids.two.seriesId });
    await toggle(t, READER, { kind: "edition", id: books.omnibus });
    await t.withIdentity({ subject: ADMIN }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.two.seriesId },
      loser: { type: "series", id: ids.one.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    const merged = await rows(t);
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.seriesId === ids.two.seriesId)).toBe(true);
    expect(merged.find((r) => r.editionId)).toMatchObject({ editionId: books.omnibus });
  });
});
