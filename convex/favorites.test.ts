// Favorites (CONTEXT.md: Favorite): one private mark per user per Series or
// Volume, toggled on and off; the library list; and upkeep through hidden
// and merged targets, account purge, and merge / split.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
type Target = { kind: "series"; id: Id<"series"> } | { kind: "volume"; id: Id<"volumes"> };

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
