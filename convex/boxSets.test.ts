// Box sets (the held-book category pass, 2026-10): what a box set holds in
// words (lib/boxSets.ts) on the Series and Bundle pages; a Bundle made from a
// box set's stated facts, holding an Unmapped Packaging member; a held book
// linked by its own ISBN onto its Bundle or Release, pinning a field its
// source misstates; and the two repair steps the franchise pass lacked
// (setCoverage `clearLine`, addVolume).

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { boxSetContents, labelRanges } from "./lib/boxSets";
import { recordUnplaced } from "./lib/observations";
import type { RepairEntry } from "./lib/repair/entries";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import { makeT, seedRegistry, type TestT as T } from "./test.helpers";

const run = (t: T, entries: RepairEntry[]) =>
  t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: "ari" });

/** An administrator, VIZ, and Dragon Ball Volumes 1-3 with a book each, plus a 3-in-1 #2 nobody mapped. */
async function seed(t: T) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "Ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media" });
    const seriesId = await insertSeries(ctx, { publicId: 41, title: "Dragon Ball" });
    const isbns = ["9781569319208", "9781569319215", "9781569319222"];
    const volumeIds: Array<Id<"volumes">> = [];
    for (const [i, isbn13] of isbns.entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(i + 1), position: i + 1 });
      volumeIds.push(volumeId);
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13,
        format: "physical",
        binding: "paperback",
      });
    }
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "3-in-1 Edition" });
    const omnibus = await insertEdition(ctx, {
      publisherId,
      editionLineId: lineId,
      linePosition: "2",
      coverageUnmapped: true,
    });
    await insertRelease(ctx, {
      editionId: omnibus,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781421555652",
      format: "physical",
      binding: "paperback",
    });
    return { publisherId, seriesId, volumeIds, isbns, lineId };
  });
}

/** A held record of `isbn13`, as an import leaves it. */
async function held(ctx: MutationCtx, isbn13: string, kind: "packaging" | "isbn") {
  const observationId = await insertObservation(ctx, {
    sourceKey: "openlibrary",
    sourceRecordId: `/books/${isbn13}`,
    snapshot: { kind: "olEdition", title: "Dragon Ball box", isbn13, format: "physical" },
  });
  await recordUnplaced(ctx, (await ctx.db.get(observationId))!, { kind, reason: "Held." }, 1);
  return observationId;
}

const BOX = "9781421526140";

describe("what a box set holds", () => {
  it("reads labels as ranges and members as Volumes or line positions", () => {
    expect(labelRanges(["3", "1", "2", "5", "Extra"])).toBe("1–3, 5, Extra");
    const parts = [
      { seriesTitle: "Dragon Ball", labels: ["1", "2"], line: null },
      { seriesTitle: "Dragon Ball", labels: [], line: { name: "3-in-1", position: "2" } },
      { seriesTitle: "Dragon Ball Z", labels: ["1"], line: null },
    ];
    expect(boxSetContents(parts, true)).toBe(
      "Dragon Ball Vols. 1–2, 3-in-1 #2; Dragon Ball Z Vol. 1",
    );
    expect(boxSetContents(parts.slice(0, 2), false)).toBe("Vols. 1–2, 3-in-1 #2");
  });
});

describe("a box set made a Bundle from its stated facts", () => {
  it("creates it once, with an unmapped member, and shows it on the Series and Bundle pages", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { publisherId, isbns } = await seed(t);
    const entry: RepairEntry = {
      kind: "releaseBundle",
      key: "db-box",
      reason: "VIZ's box set of Vols. 1-2 and 3-in-1 #2.",
      bundleId: null,
      box: null,
      members: [
        { isbn13: isbns[0]!, order: 1 },
        { isbn13: isbns[1]!, order: 2 },
        { isbn13: "9781421555652", order: 3 },
      ],
      retireVolumeIds: [],
      create: {
        name: "Dragon Ball Box Set",
        isbn13: BOX,
        isbn10: null,
        publisherId,
        format: "physical",
        pubDate: { year: 2009, month: 4, sort: 20090400 },
        price: null,
      },
    };
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "applied" });
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "alreadyApplied" });

    const page = await t.query(api.catalog.seriesPage, { publicId: 41 });
    expect(page?.boxSets).toEqual([
      expect.objectContaining({
        name: "Dragon Ball Box Set",
        isbn13: BOX,
        contents: "Vols. 1–2, 3-in-1 Edition #2",
      }),
    ]);
    const bundle = await t.query(api.catalogPages.bundlePage, {
      publicId: page!.boxSets[0]!.publicId,
    });
    expect(bundle?.bundle.contents).toBe("Dragon Ball Vols. 1–2, 3-in-1 Edition #2");
    expect(bundle?.members).toHaveLength(3);
  });
});

describe("heldBooks.linkByIsbnInternal", () => {
  it("links a held box set onto its Bundle, and a misstated book onto its Release with the field pinned", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { publisherId, isbns } = await seed(t);
    const { boxRecord, bookRecord, bundleId } = await t.run(async (ctx) => {
      const bundleId = await ctx.db.insert("releaseBundles", {
        status: "active",
        publicId: 9,
        name: "Dragon Ball Box Set",
        publisherId,
        isbn13: BOX,
      });
      return {
        bundleId,
        boxRecord: await held(ctx, BOX, "packaging"),
        bookRecord: await held(ctx, isbns[2]!, "isbn"),
      };
    });
    const link = (observationId: Id<"sourceObservations">, extra = {}) =>
      t.mutation(internal.heldBooks.linkByIsbnInternal, {
        actor: "ari",
        observationId,
        expectedKind: "packaging",
        reason: "Its own ISBN.",
        evidenceUrls: ["https://www.viz.com/"],
        ...extra,
      });

    // The box Release the Bundle was converted from, hidden, still holds the ISBN.
    await t.run(async (ctx) => {
      const box = await ctx.db.query("releases").first();
      const releaseId = await insertRelease(ctx, {
        editionId: box!.editionId,
        publisherId,
        seriesIds: box!.seriesIds,
        isbn13: BOX,
        format: "physical",
        status: "hidden",
      });
      const { proposalId, revisionId } = await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId },
        changes: [],
        sourceKey: "repair",
      });
      await ctx.db.insert("bundleConversions", {
        releaseId,
        bundleId,
        proposalId,
        revisionId,
        isbnKeys: BOX,
      });
    });
    expect(await link(boxRecord)).toMatchObject({
      status: "applied",
      target: { type: "releaseBundle", id: bundleId },
    });
    // The hold moved since the caller looked: refused.
    await expect(link(bookRecord)).rejects.toThrow("held as isbn");
    await link(bookRecord, { expectedKind: "isbn", protectFields: ["binding"] });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect((await ctx.db.get(boxRecord))?.recordRef).toEqual({
        type: "releaseBundle",
        id: bundleId,
      });
      const release = await ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", isbns[2]))
        .unique();
      expect(release?.isbn13).toBe(isbns[2]);
      expect(release?.overriddenFields).toEqual(["binding"]);
      expect(release?.binding).toBe("paperback");
    });
  });
});

describe("repair steps for the franchise pass", () => {
  it("takes an Edition out of its line, and adds a named extra Volume once", async () => {
    const t = makeT();
    const { seriesId, lineId } = await seed(t);
    const omnibus = await t.run(
      async (ctx) =>
        (await ctx.db.query("editions").collect()).find((e) => e.editionLineId === lineId)!,
    );
    const outcomes = await run(t, [
      {
        kind: "setCoverage",
        key: "db-unline",
        reason: "Its own book, not a line member.",
        editionId: omnibus._id,
        before: [],
        coverage: [{ seriesId, label: "1", extent: "complete" }],
        line: null,
        retireVolumeIds: [],
        clearLine: true,
      },
      {
        kind: "addVolume",
        key: "db-extra",
        reason: "A published extra.",
        seriesId,
        seriesTitle: "Dragon Ball",
        label: "Dragon Ball Extra",
      },
    ]);
    expect(outcomes.map((o: { status: string }) => o.status)).toEqual(["applied", "applied"]);
    await t.run(async (ctx) => {
      const edition = await ctx.db.get(omnibus._id);
      expect(edition?.editionLineId).toBeUndefined();
      expect(edition?.coverageUnmapped).toBeUndefined();
      const extra = (await ctx.db.query("volumes").collect()).find(
        (v) => v.label === "Dragon Ball Extra",
      );
      expect(extra?.position).toBe(4);
    });
    const again = await run(t, [
      {
        kind: "addVolume",
        key: "db-extra",
        reason: "A published extra.",
        seriesId,
        seriesTitle: "Dragon Ball",
        label: "Dragon Ball Extra",
      },
    ]);
    expect(again[0]).toMatchObject({ status: "alreadyApplied" });
  });
});
