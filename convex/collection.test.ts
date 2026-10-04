import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
} from "./test.factories";
import { makeT, withUser, type TestT } from "./test.helpers";
import { describeNoViewer, witchHatShelf } from "./test.tracking";

const COLLECTOR = { subject: "user_2collector", username: "collector" };
const OTHER = { subject: "user_2other", username: "other" };

/**
 * One catalog exercising ticket #27's corners (witchHatShelf): a Series of 2
 * Volumes, an Edition + Release per Volume, a cover Variant on the first
 * Release, and a box set bundling both Releases while pinning that Variant —
 * so Derived Ownership, variant pinning (direct and bundle-pinned), and
 * coexistence with direct entries are all reachable. `as` is the collector,
 * signed in with their username claimed.
 */
async function setup() {
  const t = makeT();
  const shelf = await t.run(witchHatShelf);
  const as = await withUser(t, COLLECTOR);
  return { t, as, ...shelf };
}

async function entryRows(t: TestT) {
  return await t.run(async (ctx) => await ctx.db.query("collectionEntries").collect());
}

describeNoViewer(setup, {
  queries: [
    [
      "entryForRelease",
      (as, { r1 }) => as.query(api.collection.entryForRelease, { releaseId: r1 }),
    ],
    ["entryForBundle", (as, { bundleId }) => as.query(api.collection.entryForBundle, { bundleId })],
    ["volumeOwnership", (as) => as.query(api.collection.volumeOwnership, { volumePublicId: 11 })],
    ["seriesEntries", (as) => as.query(api.collection.seriesEntries, { seriesPublicId: 1 })],
    ["myLibrary", (as) => as.query(api.collection.myLibrary, {})],
  ],
  mutations: [
    [
      "setReleaseEntry",
      (as, { r1 }) =>
        as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "wanted" }),
    ],
    [
      "setManyReleaseEntries",
      (as, { r1, r2 }) =>
        as.mutation(api.collection.setManyReleaseEntries, { releaseIds: [r1, r2], state: "owned" }),
    ],
    [
      "setBundleEntry",
      (as, { bundleId }) =>
        as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" }),
    ],
  ],
});

describe("collection.entryForRelease", () => {
  it("lists the release's active variants for the picker", async () => {
    const { as, r1, r2, variantId } = await setup();
    const forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.entry).toBeNull();
    expect(forR1?.variants).toEqual([{ variantId, name: "Bookstore exclusive" }]);
    const forR2 = await as.query(api.collection.entryForRelease, { releaseId: r2 });
    expect(forR2?.variants).toEqual([]);
  });
});

describe("collection.setReleaseEntry", () => {
  it("holds exactly one state — each transition replaces, never accumulates", async () => {
    const { t, as, r1 } = await setup();

    for (const state of ["wanted", "ordered", "owned"] as const) {
      await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state });
      const data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
      expect(data?.entry?.state).toBe(state);
      expect(await entryRows(t)).toHaveLength(1);
    }
  });

  it("omitting state removes the entry", async () => {
    const { t, as, r1 } = await setup();
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned" });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1 });
    const data = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(data?.entry).toBeNull();
    expect(await entryRows(t)).toHaveLength(0);
  });

  it("pins and clears an owned variant", async () => {
    const { as, r1, variantId } = await setup();

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
    const { as, r2, variantId } = await setup();
    await expect(
      as.mutation(api.collection.setReleaseEntry, {
        releaseId: r2,
        state: "owned",
        variantId,
      }),
    ).rejects.toMatchObject({ data: { code: "badVariant" } });
  });
});

describe("collection.setBundleEntry & derived ownership", () => {
  it("an owned bundle derives ownership on members, with the pinned variant", async () => {
    const { t, as, r1, r2, bundleId } = await setup();

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
    const { as, r1, bundleId } = await setup();
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "ordered" });
    const forR1 = await as.query(api.collection.entryForRelease, { releaseId: r1 });
    expect(forR1?.derived).toEqual([]);
  });

  it("derived ownership coexists with a direct entry; removing the bundle never erases it", async () => {
    const { t, as, r1, bundleId } = await setup();

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
    const { as, r1, bundleId } = await setup();

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
    const { as, seriesId, r1 } = await setup();

    const result = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([{ seriesId, title: "Witch Hat Atelier" }]);
    // Nothing followed until the explicit confirmation.
    const follow = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(follow?.following).toBe(false);
  });

  it("appears once per series: later entries and state changes never suggest", async () => {
    const { as, r1, r2 } = await setup();

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
    const { as, seriesId, r1 } = await setup();

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
    const { as, seriesId, r1 } = await setup();
    await as.mutation(api.follows.setSeriesFollow, { seriesId, following: true });
    const result = await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([]);
  });

  it("a bundle entry suggests through its member releases' series", async () => {
    const { as, seriesId, bundleId } = await setup();
    const result = await as.mutation(api.collection.setBundleEntry, {
      bundleId,
      state: "wanted",
    });
    expect(result.suggestFollow).toEqual([{ seriesId, title: "Witch Hat Atelier" }]);
  });
});

describe("collection.myLibrary", () => {
  it("shelves every entry under its series and reading path", async () => {
    const { as, r1, r2, variantId, bundleId } = await setup();

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
    const { as, bundleId } = await setup();
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
    const { as, bundleId } = await setup();
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "ordered" });
    const library = await as.query(api.collection.myLibrary, {});
    expect(library?.series).toEqual([]);
    expect(library?.bundles[0]?.state).toBe("ordered");
  });

  it("sizes an edition line by its active editions", async () => {
    const { t, as, seriesId, publisherId, v1, r1 } = await setup();
    // Move r1's edition into a line of three editions (one hidden).
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(r1))!;
      const lineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId,
        name: "Deluxe Edition",
      });
      await ctx.db.patch(release.editionId, { editionLineId: lineId, linePosition: "1" });
      for (const [i, status] of (["active", "hidden"] as const).entries()) {
        const editionId = await insertEdition(ctx, {
          status,
          publicId: 31 + i,
          publisherId,
          editionLineId: lineId,
          linePosition: String(2 + i),
        });
        await insertCoverage(ctx, { editionId, volumeId: v1 });
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
});

describe("collection.seriesEntries", () => {
  it("returns the viewer's entries and derived ownership within one series", async () => {
    const { as, r1, r2, variantId, bundleId } = await setup();
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

  it("is null for an unknown series", async () => {
    const { as } = await setup();
    expect(await as.query(api.collection.seriesEntries, { seriesPublicId: 9 })).toBeNull();
  });
});

describe("collection.setManyReleaseEntries", () => {
  it("sets one state on every release, keeping pinned variants, prompting once", async () => {
    const { t, as, r1, r2, variantId } = await setup();
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
    const { as, r1, r2 } = await setup();
    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: [r1, r2],
      state: "owned",
    });
    expect(result.suggestFollow).toEqual([
      { seriesId: expect.anything(), title: "Witch Hat Atelier" },
    ]);
  });

  it("omitting the state removes every entry, and the cap holds", async () => {
    const { t, as, r1, r2 } = await setup();
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
    ).rejects.toMatchObject({ data: { code: "tooMany" } });
  });
});

describe("collection pinned variants that were hidden later (B27)", () => {
  async function pinThenHide() {
    const s = await setup();
    await s.as.mutation(api.collection.setReleaseEntry, {
      releaseId: s.r1,
      state: "wanted",
      variantId: s.variantId,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.variantId, { status: "hidden" });
    });
    return s;
  }

  it("a batch state change keeps the hidden pin instead of aborting the batch", async () => {
    const { t, r1, r2, variantId, as } = await pinThenHide();
    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: [r1, r2],
      state: "owned",
    });
    expect(result.changed).toBe(2);
    const rows = await entryRows(t);
    expect(rows.map((row) => [row.releaseId, row.state, row.variantId ?? null])).toEqual(
      expect.arrayContaining([
        [r1, "owned", variantId],
        [r2, "owned", null],
      ]),
    );
  });

  it("a single state change resending the unchanged pin keeps it", async () => {
    const { t, r1, variantId, as } = await pinThenHide();
    // The release row resends the current pin with every state change.
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: r1,
      state: "owned",
      variantId,
    });
    const rows = await entryRows(t);
    expect(rows.map((row) => [row.state, row.variantId ?? null])).toEqual([["owned", variantId]]);
  });

  it("selecting a hidden variant as a new pin is still refused", async () => {
    const { r1, r2, variantId, as } = await pinThenHide();
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1 });
    await expect(
      as.mutation(api.collection.setReleaseEntry, {
        releaseId: r1,
        state: "owned",
        variantId,
      }),
    ).rejects.toThrow(/does not belong/);
    // Nor may another Release's entry carry it.
    await expect(
      as.mutation(api.collection.setReleaseEntry, {
        releaseId: r2,
        state: "owned",
        variantId,
      }),
    ).rejects.toThrow(/does not belong/);
  });
});

describe("collection entries belong to one user", () => {
  it("another user neither sees the collector's entries nor changes them", async () => {
    const { t, as, r1, r2, variantId, bundleId } = await setup();
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "owned", variantId });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: r2, state: "wanted" });
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });
    const collectorRows = await entryRows(t);
    const collectorLibrary = await as.query(api.collection.myLibrary, {});

    const other = await withUser(t, OTHER);
    // Every overlay reads as an empty collection: no entries, nothing derived.
    expect(await other.query(api.collection.entryForRelease, { releaseId: r1 })).toMatchObject({
      entry: null,
      derived: [],
    });
    expect(await other.query(api.collection.entryForBundle, { bundleId })).toMatchObject({
      entry: null,
    });
    expect(
      (await other.query(api.collection.volumeOwnership, { volumePublicId: 11 }))?.owned,
    ).toEqual([]);
    expect(await other.query(api.collection.seriesEntries, { seriesPublicId: 1 })).toMatchObject({
      entries: [],
      derivedOwned: [],
    });
    expect(await other.query(api.collection.myLibrary, {})).toEqual({ series: [], bundles: [] });

    // Removing "their" entries removes nothing of the collector's.
    await other.mutation(api.collection.setReleaseEntry, { releaseId: r1 });
    await other.mutation(api.collection.setManyReleaseEntries, { releaseIds: [r1, r2] });
    await other.mutation(api.collection.setBundleEntry, { bundleId });
    expect(await entryRows(t)).toEqual(collectorRows);
    // Their own entry on the same Release is a row of their own.
    await other.mutation(api.collection.setReleaseEntry, { releaseId: r1, state: "wanted" });
    expect(await entryRows(t)).toHaveLength(collectorRows.length + 1);
    expect(await as.query(api.collection.myLibrary, {})).toEqual(collectorLibrary);
    expect(await as.query(api.collection.entryForRelease, { releaseId: r1 })).toMatchObject({
      entry: { state: "owned", variantId },
    });
  });
});

describe("collection batch cost (E01)", () => {
  /** One Series with `count` Editions, each with one active Release. */
  async function seedShelf(t: TestT, count: number) {
    return await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
      const seriesId = await insertSeries(ctx, { publicId: 1, title: "Long Runner" });
      const releaseIds: Array<Id<"releases">> = [];
      for (let i = 0; i < count; i++) {
        const editionId = await insertEdition(ctx, { publicId: 100 + i, publisherId });
        releaseIds.push(
          await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] }),
        );
      }
      return releaseIds;
    });
  }

  it("marks a full batch of new books within the deployed transaction limits", async () => {
    // Enforce Convex's real per-transaction limits (32,000 documents read).
    const t = makeT({ transactionLimits: true });
    const releaseIds = await seedShelf(t, 200);
    const as = await withUser(t, COLLECTOR);
    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds,
      state: "owned",
    });
    expect(result.changed).toBe(200);
    expect(result.suggestFollow).toEqual([{ seriesId: expect.anything(), title: "Long Runner" }]);
    expect(await entryRows(t)).toHaveLength(200);
  });

  it("reads a batch in time linear in the collection, not quadratic", async () => {
    // The same batch against a budget a per-insert collection rescan blows
    // through (tens of thousands of reads for 200 books) but one final pass
    // over the collection fits easily.
    const t = makeT({ transactionLimits: { documentsRead: 3_000 } });
    const releaseIds = await seedShelf(t, 200);
    const as = await withUser(t, COLLECTOR);
    // A collection already on the shelf joins the final pass exactly once.
    await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds: releaseIds.slice(0, 100),
      state: "wanted",
    });
    const result = await as.mutation(api.collection.setManyReleaseEntries, {
      releaseIds,
      state: "owned",
    });
    expect(result.changed).toBe(200);
    // The Series was already covered before this batch: no prompt.
    expect(result.suggestFollow).toEqual([]);
  });
});
