import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { seedCatalog } from "./test.factories";
import {
  alice,
  makeT,
  seedTeam,
  signedIn,
  withUser,
  type Accessor,
  type TestT,
} from "./test.helpers";
import { describeNoViewer, witchHatShelf } from "./test.tracking";

/**
 * A catalog exercising ticket #30's corners: the Witch Hat Atelier shelf
 * (Series A: two Volumes, an Edition + Release per Volume, a cover Variant,
 * and a box set bundling both Releases, pinning the Variant), plus a
 * separate Series B with its own digital Release, so per-Series overrides
 * can differ between the two. `as` is the sharer, username claimed.
 */
async function setup(username = "sharer") {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const shelf = await witchHatShelf(ctx);
    const b = await seedCatalog(ctx, {
      publisher: shelf.publisherId,
      series: { publicId: 2, title: "Yokohama Kaidashi Kikou" },
      volume: { publicId: 31 },
      edition: { publicId: 32 },
      release: { format: "digital" },
    });
    return { ...shelf, seriesA: shelf.seriesId, seriesB: b.seriesId, rB: b.releaseId };
  });
  const as = await withUser(t, { subject: "user_2sharer", username });
  return { t, as, ...ids };
}

/** Everything the sharer tracks, exercising every profile surface at once. */
async function trackEverything() {
  const s = await setup();
  const { as } = s;
  // Ownership: r1 owned with the Variant, r2 merely wanted, rB ordered,
  // and the box set owned (derived member ownership).
  await as.mutation(api.collection.setReleaseEntry, {
    releaseId: s.r1,
    state: "owned",
    variantId: s.variantId,
  });
  await as.mutation(api.collection.setReleaseEntry, { releaseId: s.r2, state: "wanted" });
  await as.mutation(api.collection.setReleaseEntry, { releaseId: s.rB, state: "ordered" });
  await as.mutation(api.collection.setBundleEntry, { bundleId: s.bundleId, state: "owned" });
  // Reading: status on A, read count on v1, an active pass on rB at 40%.
  await as.mutation(api.reading.setSeriesReadingStatus, { seriesId: s.seriesA, status: "reading" });
  await as.mutation(api.reading.setVolumeReadCount, { volumeId: s.v1, readCount: 2 });
  await as.mutation(api.reading.startPass, { releaseId: s.rB });
  await as.mutation(api.reading.setPassPercent, { releaseId: s.rB, percent: 40 });
  // A Follow, which must never surface anywhere (v1).
  await as.mutation(api.follows.setSeriesFollow, { seriesId: s.seriesA, following: true });
  return s;
}

/** Opens one of the sharer's two defaults to the public. */
async function makePublic(as: Accessor, kind: "ownership" | "reading") {
  await as.mutation(api.sharing.setDefaultVisibility, { kind, visibility: "public" });
}

/** The sharer's profile as an anonymous visitor sees it. */
async function profileOf(t: TestT, username = "sharer") {
  return await t.query(api.sharing.publicProfile, { username });
}

describeNoViewer(setup, {
  queries: [
    ["seriesVisibility", (as) => as.query(api.sharing.seriesVisibility, { seriesPublicId: 1 })],
  ],
  mutations: [
    [
      "setDefaultVisibility",
      (as) =>
        as.mutation(api.sharing.setDefaultVisibility, { kind: "ownership", visibility: "public" }),
    ],
    [
      "setSeriesVisibility",
      (as, { seriesA }) =>
        as.mutation(api.sharing.setSeriesVisibility, {
          seriesId: seriesA,
          kind: "reading",
          visibility: "public",
        }),
    ],
  ],
});

describe("sharing.publicProfile", () => {
  it("is null for an unknown username", async () => {
    expect(await profileOf(makeT(), "nobody_here")).toBeNull();
  });

  it("shares nothing while both defaults are private (the default)", async () => {
    const { t } = await trackEverything();

    const profile = await profileOf(t);
    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("sharer");
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
    expect(profile!.reading).toEqual([]);
  });

  it("is null while its owner is suspended, and back unchanged on reinstatement", async () => {
    const { t, as } = await trackEverything();
    await makePublic(as, "ownership");
    await seedTeam(t, [alice]);
    const asAlice = signedIn(t, alice);
    const shown = await profileOf(t);
    expect(shown!.ownership.releases).toHaveLength(1);

    await asAlice.mutation(api.roles.suspend, { username: "sharer", reason: "Testing." });
    expect(await profileOf(t)).toBeNull();
    expect(await asAlice.query(api.sharing.publicProfile, { username: "sharer" })).toBeNull();

    await asAlice.mutation(api.roles.reinstate, { username: "sharer" });
    expect(await profileOf(t)).toEqual(shown);
  });

  it("resolves the username case-insensitively", async () => {
    const { t } = await setup("Sharer");
    const profile = await profileOf(t, "sHaReR");
    expect(profile!.username).toBe("Sharer");
  });

  it("public Ownership shows Owned only — never Wanted/Ordered — with the selected Variant and derived member ownership", async () => {
    const { t, as } = await trackEverything();
    await makePublic(as, "ownership");

    const profile = await profileOf(t);
    // r1 owned with the Variant; the Wanted r2 and Ordered rB never appear.
    expect(profile!.ownership.releases).toHaveLength(1);
    expect(profile!.ownership.releases[0]!.variantName).toBe("Bookstore exclusive");
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
    const { t, as } = await trackEverything();
    await makePublic(as, "reading");

    const profile = await profileOf(t);
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
    expect(profile!.reading).toHaveLength(2);
    const [a, b] = profile!.reading;
    expect(a!.title).toBe("Witch Hat Atelier");
    expect(a!.readingStatus).toBe("reading");
    expect(a!.readVolumes).toEqual([{ volumePublicId: 11, label: "1", position: 1, readCount: 2 }]);
    expect(a!.totalVolumes).toBe(2);
    expect(b!.title).toBe("Yokohama Kaidashi Kikou");
    expect(b!.readingStatus).toBeNull();
    expect(b!.passes).toEqual([expect.objectContaining({ percent: 40, format: "digital" })]);
  });

  it("never exposes Follows at any visibility", async () => {
    const { t, as } = await trackEverything();
    await makePublic(as, "ownership");
    await makePublic(as, "reading");
    const profile = await profileOf(t);
    // The profile payload carries no follow fields anywhere, even though the
    // user follows Series A.
    expect(JSON.stringify(profile)).not.toMatch(/follow/i);
  });

  it("a private per-Series override hides that Series from a public default — including the box set that contains it", async () => {
    const { t, as, seriesA } = await trackEverything();
    await makePublic(as, "ownership");
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "ownership",
      visibility: "private",
    });

    const profile = await profileOf(t);
    // r1 (Series A) and the box set (members cover Series A) both disappear.
    expect(profile!.ownership.releases).toEqual([]);
    expect(profile!.ownership.bundles).toEqual([]);
  });

  it("a hidden bundle member still carries its private Series — the box set stays off the profile", async () => {
    const { t, as, seriesA, r1, r2 } = await trackEverything();
    await makePublic(as, "ownership");
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "ownership",
      visibility: "private",
    });
    // A Moderator hides every member Release; they leave the display but
    // not the privacy decision.
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { status: "hidden" });
      await ctx.db.patch(r2, { status: "hidden" });
    });

    const profile = await profileOf(t);
    expect(profile!.ownership.bundles).toEqual([]);
  });

  it("a box set of hidden members on a public Series shows with no members listed", async () => {
    const { t, as, r1, r2 } = await trackEverything();
    await makePublic(as, "ownership");
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { status: "hidden" });
      await ctx.db.patch(r2, { status: "hidden" });
    });

    const profile = await profileOf(t);
    expect(profile!.ownership.bundles).toEqual([
      { bundlePublicId: 41, name: "Witch Hat Atelier Box Set", members: [] },
    ]);
  });

  it("a public per-Series override opens exactly that Series against a private default", async () => {
    const { t, as, seriesA } = await trackEverything();
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "reading",
      visibility: "public",
    });

    const profile = await profileOf(t);
    // Series A's status + read counts show; Series B's pass stays private.
    expect(profile!.reading).toHaveLength(1);
    expect(profile!.reading[0]!.title).toBe("Witch Hat Atelier");
    expect(profile!.reading[0]!.readingStatus).toBe("reading");
    // Ownership override untouched → private default still governs it.
    expect(profile!.ownership.releases).toEqual([]);
  });

  it('clearing an override with "default" falls back to the default again', async () => {
    const { t, as, seriesA } = await trackEverything();
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "reading",
      visibility: "public",
    });
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "reading",
      visibility: "default",
    });
    const profile = await profileOf(t);
    expect(profile!.reading).toEqual([]);
  });
});

describe("sharing.setDefaultVisibility", () => {
  it("updates exactly the named default; accounts start private on both", async () => {
    const { as } = await setup();
    const before = await as.query(api.users.viewer, {});
    expect(before).toMatchObject({
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    await makePublic(as, "ownership");
    const after = await as.query(api.users.viewer, {});
    expect(after).toMatchObject({
      ownershipVisibility: "public",
      readingVisibility: "private",
    });
  });
});

describe("sharing.seriesVisibility", () => {
  it("reports defaults and overrides", async () => {
    const { as, seriesA } = await setup();
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
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
    const { as, seriesA } = await setup();
    // Override first: the state row is created carrying only the override…
    await as.mutation(api.sharing.setSeriesVisibility, {
      seriesId: seriesA,
      kind: "reading",
      visibility: "public",
    });
    // …then a status lands on the same row.
    await as.mutation(api.reading.setSeriesReadingStatus, {
      seriesId: seriesA,
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
