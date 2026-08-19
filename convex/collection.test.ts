import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const SUBJECT = "user_2collector";

/**
 * One catalog exercising ticket #27's corners: a Series of 2 Volumes, an
 * Edition + Release per Volume, a cover Variant on the first Release, and a
 * box set bundling both Releases while pinning that Variant — so Derived
 * Ownership, variant pinning (direct and bundle-pinned), and coexistence
 * with direct entries are all reachable.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Witch Hat Atelier",
      altTitles: [],
      searchText: "Witch Hat Atelier",
    });
    const volumes: Array<Id<"volumes">> = [];
    for (const position of [1, 2]) {
      volumes.push(
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: 10 + position,
          seriesId,
          position,
          label: String(position),
        }),
      );
    }
    const [v1, v2] = volumes as [Id<"volumes">, Id<"volumes">];

    const releases: Array<Id<"releases">> = [];
    for (const [i, volumeId] of [v1, v2].entries()) {
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 21 + i,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      releases.push(
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          binding: "paperback",
          language: "en",
          publisherId,
          seriesIds: [seriesId],
        }),
      );
    }
    const [r1, r2] = releases as [Id<"releases">, Id<"releases">];

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
      variantId, // the box set ships the exclusive cover
      order: 1,
    });
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId: r2,
      order: 2,
    });

    return { seriesId, v1, v2, r1, r2, variantId, bundleId };
  });
}

function signedIn(t: ReturnType<typeof convexTest>, subject = SUBJECT) {
  return t.withIdentity({ subject });
}

async function withUser(t: ReturnType<typeof convexTest>, username = "collector") {
  const as = signedIn(t);
  await as.mutation(api.users.claimUsername, { username });
  return as;
}

async function entryRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("collectionEntries").collect());
}

describe("collection.entryForRelease", () => {
  it("is null signed out — public rows just omit the controls", async () => {
    const t = convexTest(schema);
    const { r1 } = await seed(t);
    expect(await t.query(api.collection.entryForRelease, { releaseId: r1 })).toBeNull();
  });

  it("is null while the username claim is pending", async () => {
    const t = convexTest(schema);
    const { r1 } = await seed(t);
    expect(
      await signedIn(t).query(api.collection.entryForRelease, { releaseId: r1 }),
    ).toBeNull();
  });

  it("lists the release's active variants for the picker", async () => {
    const t = convexTest(schema);
    const { r1, r2, variantId } = await seed(t);
    const as = await withUser(t);
    const forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.entry).toBeNull();
    expect(forR1?.variants).toEqual([
      { variantId, name: "Bookstore exclusive" },
    ]);
    const forR2 = await as.query(api.collection.entryForRelease, { releaseId: r2 });
    expect(forR2?.variants).toEqual([]);
  });
});

describe("collection.setReleaseEntry", () => {
  it("holds exactly one state — each transition replaces, never accumulates", async () => {
    const t = convexTest(schema);
    const { r1 } = await seed(t);
    const as = await withUser(t);

    for (const state of ["wanted", "ordered", "owned"] as const) {
      await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state });
      const data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
      expect(data?.entry?.state).toBe(state);
      expect(await entryRows(t)).toHaveLength(1);
    }
  });

  it("omitting state removes the entry", async () => {
    const t = convexTest(schema);
    const { r1 } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1 });
    const data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(data?.entry).toBeNull();
    expect(await entryRows(t)).toHaveLength(0);
  });

  it("pins and clears an owned variant", async () => {
    const t = convexTest(schema);
    const { r1, variantId } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "owned",
      variantId,
    });
    let data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(data?.entry).toEqual({ state: "owned", variantId });

    // Re-setting without variantId clears the pin.
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(data?.entry).toEqual({ state: "owned", variantId: null });
  });

  it("rejects a variant that belongs to another release", async () => {
    const t = convexTest(schema);
    const { r2, variantId } = await seed(t);
    const as = await withUser(t);
    await expect(
      as.mutation(api.collection.setReleaseEntry, {
        releaseId: r2,
        state: "owned",
        variantId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  it("requires a signed-in user with a claimed username", async () => {
    const t = convexTest(schema);
    const { r1 } = await seed(t);
    await expect(
      t.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "wanted" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      signedIn(t).mutation(api.collection.setReleaseEntry, {
        releaseId: r1,
        state: "wanted",
      }),
    ).rejects.toThrow(/username/i);
  });
});

describe("collection.setBundleEntry & derived ownership", () => {
  it("an owned bundle derives ownership on members, with the pinned variant", async () => {
    const t = convexTest(schema);
    const { r1, r2, bundleId } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    const forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.entry).toBeNull(); // derived, not stored — no direct entry
    expect(forR1?.derived).toEqual([
      {
        bundlePublicId: 41,
        bundleName: "Witch Hat Atelier Box Set",
        pinnedVariantName: "Bookstore exclusive",
      },
    ]);
    const forR2 = await as.query(api.collection.entryForRelease, { releaseId: r2 });
    expect(forR2?.derived[0]?.pinnedVariantName).toBeNull();

    // Exactly one stored row: the bundle entry. Derived Ownership is computed.
    expect(await entryRows(t)).toHaveLength(1);
  });

  it("a wanted/ordered bundle derives nothing", async () => {
    const t = convexTest(schema);
    const { r1, bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "ordered" });
    const forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.derived).toEqual([]);
  });

  it("derived ownership coexists with a direct entry; removing the bundle never erases it", async () => {
    const t = convexTest(schema);
    const { r1, bundleId } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    let forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.entry?.state).toBe("owned"); // both at once
    expect(forR1?.derived).toHaveLength(1);

    // Removing the bundle entry drops the derived layer only.
    await as.mutation(api.collection.setBundleEntry, { bundleId });
    forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.entry?.state).toBe("owned");
    expect(forR1?.derived).toEqual([]);
    expect(await entryRows(t)).toHaveLength(1);
  });
});

describe("collection.volumeOwnership", () => {
  it("shows a volume as owned only through owned covering releases", async () => {
    const t = convexTest(schema);
    const { r1, bundleId } = await seed(t);
    const as = await withUser(t);

    // Nothing owned yet.
    let v1Own = await as.query(api.collection.volumeOwnership, { volumePublicId: 11 });
    expect(v1Own?.owned).toEqual([]);

    // Direct ownership of the covering release.
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    v1Own = await as.query(api.collection.volumeOwnership, { volumePublicId: 11 });
    expect(v1Own?.owned).toHaveLength(1);
    expect(v1Own?.owned[0]?.via).toBeNull();

    // A wanted entry is not ownership.
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "wanted" });
    v1Own = await as.query(api.collection.volumeOwnership, { volumePublicId: 11 });
    expect(v1Own?.owned).toEqual([]);

    // Derived ownership through the owned box set — routes coexist.
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });
    v1Own = await as.query(api.collection.volumeOwnership, { volumePublicId: 11 });
    expect(v1Own?.owned).toHaveLength(1);
    expect(v1Own?.owned[0]?.via).toEqual({
      bundlePublicId: 41,
      bundleName: "Witch Hat Atelier Box Set",
    });
    expect(v1Own?.owned[0]?.variantName).toBe("Bookstore exclusive");

    const v2Own = await as.query(api.collection.volumeOwnership, { volumePublicId: 12 });
    expect(v2Own?.owned).toHaveLength(1);
  });
});

describe("collection.myCollection", () => {
  it("returns every entry with its state, joined for linking", async () => {
    const t = convexTest(schema);
    const { r1, r2, variantId, bundleId } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "owned",
      variantId,
    });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r2, state: "wanted" });
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    const overview = await as.query(api.collection.myCollection, {});
    expect(overview?.entries).toHaveLength(3);

    const release = overview?.entries.find(
      (entry) => entry.kind === "release" && entry.state === "owned",
    );
    expect(release?.kind === "release" && release.variantName).toBe(
      "Bookstore exclusive",
    );

    const bundle = overview?.entries.find((entry) => entry.kind === "bundle");
    expect(bundle?.state).toBe("owned");
    // The owned box set lists its derived members, bundle-pinned variant named.
    expect(bundle?.kind === "bundle" && bundle.members).toHaveLength(2);
    expect(
      bundle?.kind === "bundle" ? bundle.members[0]?.variantName : null,
    ).toBe("Bookstore exclusive");
  });

  it("an ordered bundle carries no derived member listing", async () => {
    const t = convexTest(schema);
    const { bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "ordered" });
    const overview = await as.query(api.collection.myCollection, {});
    const bundle = overview?.entries[0];
    expect(bundle?.kind === "bundle" && bundle.members).toEqual([]);
  });
});
