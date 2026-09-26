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

describe("collection follow suggestions (#29)", () => {
  it("a first entry in a series suggests a follow — a suggestion only", async () => {
    const t = convexTest(schema);
    const { seriesId, r1 } = await seed(t);
    const as = await withUser(t);

    const result = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([
      { seriesId, title: "Witch Hat Atelier" },
    ]);
    // Nothing followed until the explicit confirmation.
    const follow = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(follow?.following).toBe(false);
  });

  it("appears once per series: later entries and state changes never suggest", async () => {
    const t = convexTest(schema);
    const { r1, r2 } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "wanted" });
    // State change on the existing entry: not a first entry.
    const changed = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "owned",
    });
    expect(changed.suggestFollow).toEqual([]);
    // Another release of the same series: the series is already covered.
    const second = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r2,
      state: "wanted",
    });
    expect(second.suggestFollow).toEqual([]);
  });

  it("dismissal suppresses the prompt permanently", async () => {
    const t = convexTest(schema);
    const { seriesId, r1 } = await seed(t);
    const as = await withUser(t);

    await as.mutation(api.follows.dismissFollowPrompt, { seriesId });
    // Even a genuine first entry stays quiet after dismissal…
    const first = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
    });
    expect(first.suggestFollow).toEqual([]);
    // …and so does re-adding after removing everything.
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1 });
    const again = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "ordered",
    });
    expect(again.suggestFollow).toEqual([]);
  });

  it("an already-followed series never prompts", async () => {
    const t = convexTest(schema);
    const { seriesId, r1 } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, { seriesId, following: true });
    const result = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([]);
  });

  it("a bundle entry suggests through its member releases' series", async () => {
    const t = convexTest(schema);
    const { seriesId, bundleId } = await seed(t);
    const as = await withUser(t);
    const result = await as.mutation(api.collection.setBundleEntry, {
      bundleId,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([
      { seriesId, title: "Witch Hat Atelier" },
    ]);
  });
});

describe("collection.myLibrary", () => {
  it("shelves every entry under its series and reading path", async () => {
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

    const library = await as.query(api.collection.myLibrary, {});
    expect(library?.series).toHaveLength(1);
    const shelf = library!.series[0]!;
    expect(shelf).toMatchObject({ seriesPublicId: 1, title: "Witch Hat Atelier" });
    expect(shelf.paths).toHaveLength(1);
    const path = shelf.paths[0]!;
    // No stats row and no line: the standard run is sized by the Series'
    // volumes, and keyed like the Series page's reading path.
    expect(path).toMatchObject({
      key: "seven-seas",
      name: "Standard edition",
      kind: "standard",
      bookCount: 2,
    });
    expect(path.books.map((book) => [book.editionPublicId, book.state, book.direct])).toEqual([
      [21, "owned", true],
      [22, "wanted", true],
    ]);
    // Vol 1: the direct entry wins, the box set is named alongside.
    expect(path.books[0]).toMatchObject({
      variantName: "Bookstore exclusive",
      via: { bundlePublicId: 41, bundleName: "Witch Hat Atelier Box Set" },
      read: false,
    });
    // Vol 2 is wanted directly, and also owned through the box set: the
    // direct entry's state holds and the box set is still named.
    expect(path.books[1]?.via?.bundlePublicId).toBe(41);

    expect(library?.bundles).toEqual([
      expect.objectContaining({
        state: "owned",
        bundlePublicId: 41,
        title: "Witch Hat Atelier Box Set",
        memberCount: 2,
      }),
    ]);
  });

  it("an owned box set alone shelves its members as derived ownership", async () => {
    const t = convexTest(schema);
    const { bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });
    const library = await as.query(api.collection.myLibrary, {});
    const books = library!.series[0]!.paths[0]!.books;
    expect(books.map((book) => [book.state, book.direct, book.via?.bundlePublicId])).toEqual([
      ["owned", false, 41],
      ["owned", false, 41],
    ]);
    // The box set pins the exclusive cover for its first member.
    expect(books[0]?.variantName).toBe("Bookstore exclusive");
  });

  it("an ordered box set is listed but shelves nothing", async () => {
    const t = convexTest(schema);
    const { bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "ordered" });
    const library = await as.query(api.collection.myLibrary, {});
    expect(library?.series).toEqual([]);
    expect(library?.bundles[0]?.state).toBe("ordered");
  });

  it("sizes an edition line by its active editions", async () => {
    const t = convexTest(schema);
    const { seriesId, v1, r1 } = await seed(t);
    const as = await withUser(t);
    // Move r1's edition into a line of three editions (one hidden).
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(r1))!;
      const lineId = await ctx.db.insert("editionLines", {
        status: "active",
        seriesId,
        publisherId: release.publisherId,
        name: "Deluxe Edition",
      });
      await ctx.db.patch(release.editionId, { editionLineId: lineId, linePosition: "1" });
      for (const [i, status] of (["active", "hidden"] as const).entries()) {
        const editionId = await ctx.db.insert("editions", {
          status,
          publicId: 31 + i,
          publisherId: release.publisherId,
          editionLineId: lineId,
          linePosition: String(2 + i),
        });
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId: v1,
          order: 1,
          extent: "complete",
        });
      }
    });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    const path = (await as.query(api.collection.myLibrary, {}))!.series[0]!.paths[0]!;
    expect(path).toMatchObject({
      key: "seven-seas-deluxe-edition",
      name: "Deluxe Edition",
      kind: "line",
      bookCount: 2,
    });
    expect(path.books[0]).toMatchObject({ lineName: "Deluxe Edition", linePosition: "1" });
  });

  it("is null signed out", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.collection.myLibrary, {})).toBeNull();
  });
});

describe("collection.seriesEntries", () => {
  it("returns the viewer's entries and derived ownership within one series", async () => {
    const t = convexTest(schema);
    const { r1, r2, variantId, bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
      variantId,
    });
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    const overlay = await as.query(api.collection.seriesEntries, { seriesPublicId: 1 });
    expect(overlay?.formatPreference).toBe("both");
    expect(overlay?.entries).toEqual([{ releaseId: r1, state: "wanted", variantId }]);
    expect(new Set(overlay?.derivedOwned)).toEqual(new Set([r1, r2]));
  });

  it("is null signed out or for an unknown series", async () => {
    const t = convexTest(schema);
    await seed(t);
    const as = await withUser(t);
    expect(await t.query(api.collection.seriesEntries, { seriesPublicId: 1 })).toBeNull();
    expect(await as.query(api.collection.seriesEntries, { seriesPublicId: 9 })).toBeNull();
  });
});

describe("collection.setManyReleaseEntries", () => {
  it("sets one state on every release, keeping pinned variants, prompting once", async () => {
    const t = convexTest(schema);
    const { r1, r2, variantId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
      variantId,
    });

    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: [r1, r2, r2],
      state: "owned",
    });
    expect(result.changed).toBe(2);
    // r1 was already an entry in the Series, so r2 is not a first entry: no prompt.
    expect(result.suggestFollow).toEqual([]);
    const rows = await entryRows(t);
    expect(rows.map((row) => [row.releaseId, row.state, row.variantId ?? null])).toEqual(
      expect.arrayContaining([
        [r1, "owned", variantId],
        [r2, "owned", null],
      ]),
    );
  });

  it("a first entry in a series prompts once for the batch", async () => {
    const t = convexTest(schema);
    const { r1, r2 } = await seed(t);
    const as = await withUser(t);
    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: [r1, r2],
      state: "owned",
    });
    expect(result.suggestFollow).toEqual([
      { seriesId: expect.anything(), title: "Witch Hat Atelier" },
    ]);
  });

  it("omitting the state removes every entry, and the cap holds", async () => {
    const t = convexTest(schema);
    const { r1, r2 } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: [r1, r2],
      state: "ordered",
    });
    await as.mutation(api.collection.setManyReleaseEntries, { releaseIds: [r1, r2] });
    expect(await entryRows(t)).toEqual([]);
    await expect(
      as.mutation(api.collection.setManyReleaseEntries, {
        releaseIds: Array.from({ length: 201 }, () => r1),
        state: "owned",
      }),
    ).rejects.toThrow(ConvexError);
  });
});
