// Shared setup for the user-feature suites (collection, reading, sharing,
// follows, ratings, reviews, favorites, comments): the catalogs several of
// them track against, target refs, merge and split as a Data Team member,
// and the two callers who have no viewer. Two dots in the name keep Convex
// from deploying it (see test.helpers.ts).

import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  insertBundle,
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVariant,
  insertVolume,
  type Overrides,
} from "./test.factories";
import { signedIn, type Accessor, type TestT } from "./test.helpers";

// ---------- callers without a viewer ----------

/** Signs in but never claims a username: the pending-claim state. */
export const UNCLAIMED = { subject: "user_unclaimed" };

/**
 * The two callers with no viewer (lib/auth.ts), and the code requireUser
 * refuses each with. Personal queries answer both with null.
 */
export const NO_VIEWER = [
  { caller: "signed out", as: (t: TestT): Accessor => t, refusal: "unauthenticated" },
  { caller: "pending claim", as: (t: TestT) => signedIn(t, UNCLAIMED), refusal: "usernameRequired" },
] as const;

/** A named call of one public function, made by `as` against a suite's setup. */
export type Call<Setup> = [name: string, call: (as: Accessor, setup: Setup) => Promise<unknown>];

/**
 * One case per caller in NO_VIEWER and per function of a personal module:
 * every query answers null, every mutation refuses with the caller's code.
 * `setup` builds a fresh backend with the suite's data.
 */
export function describeNoViewer<Setup extends { t: TestT }>(
  setup: () => Promise<Setup>,
  { queries, mutations }: { queries: Array<Call<Setup>>; mutations: Array<Call<Setup>> },
) {
  describe.each(NO_VIEWER)("with no viewer ($caller)", ({ as, refusal }) => {
    it.each(queries)("%s answers null", async (_, call) => {
      const s = await setup();
      expect(await call(as(s.t), s)).toBeNull();
    });
    it.each(mutations)(`%s refuses with ${refusal}`, async (_, call) => {
      const s = await setup();
      await expect(call(as(s.t), s)).rejects.toMatchObject({ data: { code: refusal } });
    });
  });
}

// ---------- target refs ----------

// Public-id refs, as pages pass them to the Rating, Review, Favorite and Comment queries.
export const series = (publicId: number) => ({ kind: "series" as const, publicId });
export const volume = (publicId: number) => ({ kind: "volume" as const, publicId });
export const edition = (publicId: number) => ({ kind: "edition" as const, publicId });

// ---------- merge and split ----------

type RecordRef = FunctionArgs<typeof api.sensitiveOps.mergeRecords>["survivor"];

/** Merges `loser` into `survivor` as `as` (a Moderator or Administrator), impact confirmed. */
export async function merge(as: Accessor, survivor: RecordRef, loser: RecordRef) {
  return await as.mutation(api.sensitiveOps.mergeRecords, {
    survivor,
    loser,
    reason: "Duplicate.",
    confirmImpact: true,
  });
}

/** Splits a merged `ref` back out as `as`, impact confirmed. */
export async function split(as: Accessor, ref: RecordRef) {
  return await as.mutation(api.sensitiveOps.splitRecord, {
    ref,
    reason: "Not a duplicate after all.",
    confirmImpact: true,
  });
}

// ---------- catalogs ----------

/** A Series and its Volume 1, whose publicId is the Series' times ten plus one. */
export async function seriesWithVolume(
  ctx: MutationCtx,
  publicId: number,
  title: string,
  fields: Overrides<"series"> = {},
) {
  const seriesId = await insertSeries(ctx, { publicId, title, ...fields });
  const volumeId = await insertVolume(ctx, { seriesId, publicId: publicId * 10 + 1 });
  return { seriesId, volumeId };
}

/**
 * The Ratings family's pair: Series 1 "Frieren" and its duplicate, Series 2
 * "Frieren (duplicate)", with Volumes 11 and 21 — one to merge into the other.
 */
export async function frierenTwins(ctx: MutationCtx) {
  return {
    one: await seriesWithVolume(ctx, 1, "Frieren"),
    two: await seriesWithVolume(ctx, 2, "Frieren (duplicate)"),
  };
}

/**
 * Books over Series `seriesId`, whose Volume 1 is `volumeId`; it gains Vol 2
 * (publicId 12). Publisher VIZ prints two omnibuses of Vols 1-2 (901 and its
 * twin 904), a single-volume book of Vol 1 (902), and an Unmapped Packaging
 * member of a "3-in-1" line (903). None has a Release.
 */
export async function omnibusEditions(
  ctx: MutationCtx,
  { seriesId, volumeId }: { seriesId: Id<"series">; volumeId: Id<"volumes"> },
) {
  const publisherId = await insertPublisher(ctx, { name: "VIZ", slug: "viz" });
  const vol2 = await insertVolume(ctx, { seriesId, publicId: 12, position: 2 });
  const book = async (publicId: number, volumes: Array<Id<"volumes">>) => {
    const editionId = await insertEdition(ctx, { publicId, publisherId });
    for (const [order, coveredId] of volumes.entries()) {
      await insertCoverage(ctx, { editionId, volumeId: coveredId, order });
    }
    return editionId;
  };
  const omnibus = await book(901, [volumeId, vol2]);
  const single = await book(902, [volumeId]);
  const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "3-in-1" });
  const unmapped = await insertEdition(ctx, {
    publicId: 903,
    publisherId,
    editionLineId: lineId,
    coverageUnmapped: true,
  });
  const twin = await book(904, [volumeId, vol2]);
  return { publisherId, vol2, omnibus, single, unmapped, twin };
}

/**
 * The shelf the collection and sharing suites track: Seven Seas' "Witch Hat
 * Atelier" (Series 1) with Volumes 11 and 12, a paperback Edition and
 * Release of each (Editions 21 and 22), a "Bookstore exclusive" Variant of
 * the first Release, and box set 41, "Witch Hat Atelier Box Set", bundling
 * both Releases and pinning that Variant on the first.
 */
export async function witchHatShelf(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });
  const seriesId = await insertSeries(ctx, { publicId: 1, title: "Witch Hat Atelier" });
  const book = async (position: number) => {
    const volumeId = await insertVolume(ctx, { seriesId, publicId: 10 + position, position });
    const editionId = await insertEdition(ctx, { publicId: 20 + position, publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      binding: "paperback",
      publisherId,
      seriesIds: [seriesId],
    });
    return { volumeId, releaseId };
  };
  const { volumeId: v1, releaseId: r1 } = await book(1);
  const { volumeId: v2, releaseId: r2 } = await book(2);

  const variantId = await insertVariant(ctx, { releaseId: r1, name: "Bookstore exclusive" });
  const bundleId = await insertBundle(ctx, {
    publicId: 41,
    name: "Witch Hat Atelier Box Set",
    publisherId,
    format: "physical",
  });
  // The box set ships the exclusive cover.
  await insertBundleMember(ctx, { bundleId, releaseId: r1, variantId, order: 1 });
  await insertBundleMember(ctx, { bundleId, releaseId: r2, order: 2 });

  return { publisherId, seriesId, v1, v2, r1, r2, variantId, bundleId };
}
