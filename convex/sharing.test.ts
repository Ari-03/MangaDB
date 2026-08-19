import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const SUBJECT = "user_2sharer";

/**
 * A catalog exercising ticket #30's corners: Series A with two Volumes, an
 * Edition + Release per Volume, a cover Variant, and a box set bundling both
 * Releases (pinning the Variant) — plus a separate Series B with its own
 * Release, so per-Series overrides can differ between the two.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });
    const seriesA = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Witch Hat Atelier",
      altTitles: [],
      searchText: "Witch Hat Atelier",
    });
    const seriesB = await ctx.db.insert("series", {
      status: "active",
      publicId: 2,
      title: "Yokohama Kaidashi Kikou",
      altTitles: [],
      searchText: "Yokohama Kaidashi Kikou",
    });

    const volumes: Array<Id<"volumes">> = [];
    const releasesA: Array<Id<"releases">> = [];
    for (const position of [1, 2]) {
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 10 + position,
        seriesId: seriesA,
        position,
        label: String(position),
      });
      volumes.push(volumeId);
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 20 + position,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      releasesA.push(
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          binding: "paperback",
          language: "en",
          publisherId,
          seriesIds: [seriesA],
        }),
      );
    }
    const [v1, v2] = volumes as [Id<"volumes">, Id<"volumes">];
    const [r1, r2] = releasesA as [Id<"releases">, Id<"releases">];

    const variantId = await ctx.db.insert("releaseVariants", {
      status: "active",
      releaseId: r1,
      name: "Bookstore exclusive",
    });
    const bundleId = await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 41,
      name: "Witch Hat Atelier Box Set",
      publisherId,
      format: "physical",
    });
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId: r1,
      variantId,
      order: 1,
    });
    await ctx.db.insert("bundleMemberships", { bundleId, releaseId: r2, order: 2 });

    // Series B: one Volume, one Release.
    const vB = await ctx.db.insert("volumes", {
      status: "active",
      publicId: 31,
      seriesId: seriesB,
      position: 1,
      label: "1",
    });
    const editionB = await ctx.db.insert("editions", {
      status: "active",
      publicId: 32,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: editionB,
      volumeId: vB,
      order: 1,
      extent: "complete",
    });
    const rB = await ctx.db.insert("releases", {
      status: "active",
      editionId: editionB,
      format: "digital",
      language: "en",
      publisherId,
      seriesIds: [seriesB],
    });

    return { seriesA, seriesB, v1, v2, vB, r1, r2, rB, variantId, bundleId };
  });
}

function signedIn(t: ReturnType<typeof convexTest>, subject = SUBJECT) {
  return t.withIdentity({ subject });
}

async function withUser(t: ReturnType<typeof convexTest>, username = "sharer") {
  const as = signedIn(t);
  await as.mutation(api.users.claimUsername, { username });
  return as;
}

/** Everything the user tracks, exercising every profile surface at once. */
async function trackEverything(
  t: ReturnType<typeof convexTest>,
  seeded: Awaited<ReturnType<typeof seed>>,
) {
  const as = await withUser(t);
  // Ownership: r1 owned with the Variant, r2 merely wanted, rB ordered,
  // and the box set owned (derived member ownership).
  await as.mutation(api.collection.setReleaseEntry, {
    releaseId: seeded.r1,
    state: "owned",
    variantId: seeded.variantId,
  });
  await as.mutation(api.collection.setReleaseEntry, {
    releaseId: seeded.r2,
    state: "wanted",
  });
  await as.mutation(api.collection.setReleaseEntry, {
    releaseId: seeded.rB,
    state: "ordered",
  });
  await as.mutation(api.collection.setBundleEntry, {
    bundleId: seeded.bundleId,
    state: "owned",
  });
  // Reading: status on A, read count on v1, an active pass on rB at 40%.
  await as.mutation(api.reading.setSeriesReadingStatus, {
    seriesId: seeded.seriesA,
    status: "reading",
  });
  await as.mutation(api.reading.setVolumeReadCount, {
    volumeId: seeded.v1,
    readCount: 2,
  });
  await as.mutation(api.reading.startPass, { releaseId: seeded.rB });
  await as.mutation(api.reading.setPassPercent, {
    releaseId: seeded.rB,
    percent: 40,
  });
  // A Follow, which must never surface anywhere (v1). (ReturnType<typeof
  // convexTest> erases the schema generic, so plain collect + find here.)
  await t.run(async (ctx) => {
    const states = await ctx.db.query("userSeriesStates").collect();
    const state = states.find((row) => row.seriesId === seeded.seriesA);
    await ctx.db.patch(state!._id, { following: true });
  });
  return as;
}

describe("sharing.publicProfile", () => {
  it("is null for an unknown username", async () => {
    const t = convexTest(schema);
    expect(
      await t.query(api.sharing.publicProfile, { username: "nobody_here" }),
    ).toBeNull();
  });

  it("shares nothing while both defaults are private (the default)", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    await trackEverything(t, seeded);

    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("sharer");
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
    expect(profile!.reading).toEqual([]);
  });

  it("resolves the username case-insensitively", async () => {
    const t = convexTest(schema);
    await seed(t);
    await withUser(t, "Sharer");
    const profile = await t.query(api.sharing.publicProfile, {
      username: "sHaReR",
    });
    expect(profile!.username).toBe("Sharer");
  });

  it("public Ownership shows Owned only — never Wanted/Ordered — with the selected Variant and derived member ownership", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    await as.mutation(api.sharing.setDefaultVisibility, {
      kind: "ownership",
      visibility: "public",
    });

    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    // r1 owned with the Variant; the Wanted r2 and Ordered rB never appear.
    expect(profile!.ownership.releases).toHaveLength(1);
    expect(profile!.ownership.releases[0]!.variantName).toBe(
      "Bookstore exclusive",
    );
    // The Owned box set with derived member ownership (bundle-pinned Variant).
    expect(profile!.ownership.bundles).toHaveLength(1);
    const bundle = profile!.ownership.bundles[0]!;
    expect(bundle.name).toBe("Witch Hat Atelier Box Set");
    expect(bundle.members).toHaveLength(2);
    expect(bundle.members[0]!.variantName).toBe("Bookstore exclusive");
    // Reading stays private: its default was never opened.
    expect(profile!.reading).toEqual([]);
  });

  it("public Reading shows status, volume read counts, and active pass percentage — Ownership stays private", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    await as.mutation(api.sharing.setDefaultVisibility, {
      kind: "reading",
      visibility: "public",
    });

    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
    expect(profile!.reading).toHaveLength(2);
    const [a, b] = profile!.reading;
    expect(a!.title).toBe("Witch Hat Atelier");
    expect(a!.readingStatus).toBe("reading");
    expect(a!.readVolumes).toEqual([
      { volumePublicId: 11, label: "1", position: 1, readCount: 2 },
    ]);
    expect(a!.totalVolumes).toBe(2);
    expect(b!.title).toBe("Yokohama Kaidashi Kikou");
    expect(b!.readingStatus).toBeNull();
    expect(b!.passes).toEqual([
      expect.objectContaining({ percent: 40, format: "digital" }),
    ]);
  });

  it("never exposes Follows at any visibility", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    for (const kind of ["ownership", "reading"] as const) {
      await as.mutation(api.sharing.setDefaultVisibility, {
        kind,
        visibility: "public",
      });
    }
    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    // The profile payload carries no follow fields anywhere, even though the
    // user follows Series A.
    expect(JSON.stringify(profile)).not.toMatch(/follow/i);
  });

  it("a private per-Series override hides that Series from a public default — including the box set that contains it", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    await as.mutation(api.sharing.setDefaultVisibility, {
      kind: "ownership",
      visibility: "public",
    });
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "ownership",
      visibility: "private",
    });

    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    // r1 (Series A) and the box set (members cover Series A) both disappear.
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
  });

  it("a public per-Series override opens exactly that Series against a private default", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "reading",
      visibility: "public",
    });

    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    // Series A's status + read counts show; Series B's pass stays private.
    expect(profile!.reading).toHaveLength(1);
    expect(profile!.reading[0]!.title).toBe("Witch Hat Atelier");
    expect(profile!.reading[0]!.readingStatus).toBe("reading");
    // Ownership override untouched → private default still governs it.
    expect(profile!.ownership.releases).toEqual([]);
  });

  it("clearing an override with \"default\" falls back to the default again", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await trackEverything(t, seeded);
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "reading",
      visibility: "public",
    });
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "reading",
      visibility: "default",
    });
    const profile = await t.query(api.sharing.publicProfile, {
      username: "sharer",
    });
    expect(profile!.reading).toEqual([]);
  });
});

describe("sharing.setDefaultVisibility", () => {
  it("updates exactly the named default; accounts start private on both", async () => {
    const t = convexTest(schema);
    await seed(t);
    const as = await withUser(t);
    const before = await as.query(api.users.viewer, {});
    expect(before).toMatchObject({
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    await as.mutation(api.sharing.setDefaultVisibility, {
      kind: "ownership",
      visibility: "public",
    });
    const after = await as.query(api.users.viewer, {});
    expect(after).toMatchObject({
      ownershipVisibility: "public",
      readingVisibility: "private",
    });
  });
});

describe("sharing.seriesVisibility", () => {
  it("is null signed out; signed in it reports defaults and overrides", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    expect(
      await t.query(api.sharing.seriesVisibility, { seriesPublicId: 1 }),
    ).toBeNull();

    const as = await withUser(t);
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "ownership",
      visibility: "public",
    });
    const state = await as.query(api.sharing.seriesVisibility, {
      seriesPublicId: 1,
    });
    expect(state).toMatchObject({
      username: "sharer",
      defaults: { ownership: "private", reading: "private" },
      overrides: { ownership: "public", reading: null },
    });
  });

  it("an override row created before any other tracking never disturbs it later", async () => {
    const t = convexTest(schema);
    const seeded = await seed(t);
    const as = await withUser(t);
    // Override first: the state row is created carrying only the override…
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seeded.seriesA,
      kind: "reading",
      visibility: "public",
    });
    // …then a status lands on the same row.
    await as.mutation(api.reading.setSeriesReadingStatus, {
      seriesId: seeded.seriesA,
      status: "paused",
    });
    const state = await as.query(api.sharing.seriesVisibility, {
      seriesPublicId: 1,
    });
    expect(state!.overrides.reading).toBe("public");
    const tracking = await as.query(api.reading.seriesTracking, {
      seriesPublicId: 1,
    });
    expect(tracking!.readingStatus).toBe("paused");
  });
});
