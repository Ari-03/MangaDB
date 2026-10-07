// Held Books: what an import could not place, listed for the Data Team
// (imports.heldBooks). Covers the hold lifecycle (held, re-sighted, linked,
// withdrawn, in review and decided), Open Library's held editions against
// the ones it still skips and its `match` note, ANN lines no one can place
// or that are out of scope, the list's gate, pages and filters, and the
// backfill of stored rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { storedHoldKind } from "./imports";
import { insertSourceProposal } from "./lib/reconcile";
import { type Hold, type HoldKind, linkObservation, recordUnplaced } from "./lib/observations";
import type { BookSnapshot } from "./lib/sevenSeas";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import {
  alice,
  carol,
  dave,
  drain,
  makeT,
  seedRegistry,
  seedTeam,
  signedIn,
  type TestT,
} from "./test.helpers";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

/** Serve these Open Library editions as the filtered dump. */
function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions
    .map((e) => `/type/edition\t${String(e.key)}\t1\t2026-08-01T00:00:00\t${JSON.stringify(e)}`)
    .join("\n");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input) === DUMP_URL
      ? new Response(`${body}\n`)
      : new Response("not found", { status: 404 }),
  );
}

/** A VIZ book of "Alice in Borderland" as Open Library lists it. */
const alice1 = {
  key: "/books/OL1M",
  title: "Alice in Borderland, Vol. 1",
  publishers: ["Viz Media"],
  isbn_13: ["9781974728374"],
  physical_format: "paperback",
  languages: [{ key: "/languages/eng" }],
};
const alice2 = {
  ...alice1,
  key: "/books/OL2M",
  title: "Alice in Borderland, Vol. 2",
  isbn_13: ["9781974728381"],
};

beforeEach(() => {
  vi.stubEnv("OPENLIBRARY_DUMP_URL", DUMP_URL);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** VIZ and the ANN-built "Alice in Borderland" with only its Volume 4. */
async function aliceSkeleton(t: TestT) {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, { publicId: 7, title: "Alice in Borderland" });
    await insertVolume(ctx, { seriesId, position: 4 });
    return { publisherId, seriesId };
  });
}

const openLibrarySync = (t: TestT) => t.action(internal.openLibrary.sync, {});

const asEditor = (t: TestT) => signedIn(t, carol);
const list = (
  t: TestT,
  args: { kind?: HoldKind; sourceKey?: string; numItems?: number; cursor?: string | null } = {},
) =>
  asEditor(t).query(api.imports.heldBooks, {
    paginationOpts: { numItems: args.numItems ?? 25, cursor: args.cursor ?? null },
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.sourceKey !== undefined ? { sourceKey: args.sourceKey } : {}),
  });

const observationOf = (t: TestT, sourceRecordId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "openlibrary").eq("sourceRecordId", sourceRecordId),
      )
      .unique(),
  );

describe("Open Library holds", () => {
  it("holds an edition whose Volume is missing under a known Series and Publisher, and lists it", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId } = await aliceSkeleton(t);
    stubDump([alice1]);
    await openLibrarySync(t);

    const { page, isDone } = await list(t);
    expect(isDone).toBe(true);
    expect(page).toEqual([
      expect.objectContaining({
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL1M",
        kind: "volumeMissing",
        reason: 'Series 7 ("Alice in Borderland") has no Volume 1; VIZ Media publishes it.',
        title: "Alice in Borderland, Vol. 1",
        url: "https://openlibrary.org/books/OL1M",
        isbn13: "9781974728374",
        seriesTitle: "Alice in Borderland",
        volumeLabel: "1",
        series: { publicId: 7, title: "Alice in Borderland" },
      }),
    ]);
    const observation = await observationOf(t, "/books/OL1M");
    expect(page[0]!.lastSeenAt).toBe(observation!.lastSeenAt);
    expect(page[0]!.heldAt).toBeGreaterThan(0);
    // Holding writes no canonical record.
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(
        await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
          .collect(),
      ).toHaveLength(1);
    });
  });

  it("still records nothing for an edition with no Series match or an unknown publisher", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    await aliceSkeleton(t);
    stubDump([
      { ...alice1, key: "/books/OL3M", title: "Nobody's Saga, Vol. 1", isbn_13: ["9781974700011"] },
      {
        ...alice1,
        key: "/books/OL4M",
        publishers: ["Unheard Of Press"],
        isbn_13: ["9781974700028"],
      },
    ]);
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([]);
    for (const key of ["/books/OL3M", "/books/OL4M"]) {
      expect((await observationOf(t, key))?.conflicts ?? []).toEqual([]);
    }
  });

  it("does not hold a book Yen Press holds out of scope", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    await aliceSkeleton(t);
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "yenpress",
        sourceRecordId: "9781974728374",
        snapshot: { outOfScope: "category light-novels" },
      }),
    );
    stubDump([alice1]);
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([]);
  });

  it("clears the hold and its note when the book is placed", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId } = await aliceSkeleton(t);
    stubDump([alice1]);
    await openLibrarySync(t);
    expect((await list(t)).page).toHaveLength(1);
    // The Volume arrives (from ANN, say): the next run creates the leaf.
    await t.run((ctx) => insertVolume(ctx, { seriesId, position: 1 }));
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([]);
    const observation = await observationOf(t, "/books/OL1M");
    expect(observation?.recordRef?.type).toBe("release");
    expect(observation?.conflicts ?? []).toEqual([]);
  });

  it("does not bring the note back when the link's own reconcile records a conflict", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId, publisherId } = await aliceSkeleton(t);
    const dated = { ...alice1, publish_date: "Jan 5, 2021" };
    stubDump([dated]);
    await openLibrarySync(t);
    expect((await list(t)).page).toHaveLength(1);
    // ANN builds Volume 1 and a Release with this ISBN under a standard-
    // authority date that disagrees with Open Library's weak one.
    await t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const pubDate = { year: 2021, month: 1, day: 19, sort: 20210119 };
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: "9781974728374",
        pubDate,
      });
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId },
        sourceKey: "ann",
        changes: [{ field: "pubDate", after: pubDate }],
      });
    });
    stubDump([dated]);
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([]);
    const observation = await observationOf(t, "/books/OL1M");
    expect(observation?.recordRef?.type).toBe("release");
    expect(observation?.conflicts?.map((c) => c.field)).toEqual(["pubDate"]);
  });

  it("keeps a re-sighted hold in place and moves one whose kind changed to the top", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId, publisherId } = await aliceSkeleton(t);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    stubDump([alice1]);
    await openLibrarySync(t);
    vi.setSystemTime(2_000_000);
    stubDump([alice2]);
    await openLibrarySync(t);
    vi.setSystemTime(3_000_000);
    stubDump([alice1, alice2]);
    await openLibrarySync(t);
    expect((await list(t)).page.map((row) => [row.sourceRecordId, row.heldAt])).toEqual([
      ["/books/OL2M", 2_000_000],
      ["/books/OL1M", 1_000_000],
    ]);

    // Volume 1 appears with VIZ's own Release under another ISBN: the slot
    // is taken, a new kind of hold.
    await t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: "9781974799990",
      });
    });
    vi.setSystemTime(4_000_000);
    stubDump([alice1, alice2]);
    await openLibrarySync(t);
    expect((await list(t)).page.map((row) => [row.sourceRecordId, row.kind, row.heldAt])).toEqual([
      ["/books/OL1M", "isbn", 4_000_000],
      ["/books/OL2M", "volumeMissing", 2_000_000],
    ]);
  });

  it("keeps an edition held when another Series' Release takes its ISBN, and the backfill agrees", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { publisherId } = await aliceSkeleton(t);
    stubDump([alice1]);
    await openLibrarySync(t);
    expect((await list(t)).page.map((row) => row.kind)).toEqual(["volumeMissing"]);
    await t.run(async (ctx) => {
      const other = await insertSeries(ctx, { publicId: 8, title: "Unrelated Story" });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [other],
        isbn13: "9781974728374",
      });
    });
    stubDump([alice1]);
    await openLibrarySync(t);

    const held = [
      expect.objectContaining({
        sourceRecordId: "/books/OL1M",
        kind: "isbn",
        reason: "ISBN 9781974728374 matches an existing release with a dissimilar title.",
        series: { publicId: 7, title: "Alice in Borderland" },
      }),
    ];
    expect((await list(t)).page).toEqual(held);
    const observation = await observationOf(t, "/books/OL1M");
    expect(observation?.recordRef).toBeUndefined();
    expect(observation?.conflicts?.map((c) => [c.field, c.reason])).toEqual([
      [
        "match",
        "unmatched (rung 2): ISBN 9781974728374 matches an existing release with a dissimilar title",
      ],
      ["placement", "ISBN 9781974728374 matches an existing release with a dissimilar title."],
    ]);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
    });

    // Classified afresh, the stored edition is held the same way.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("placementHolds").collect())
        await ctx.db.delete(row._id);
    });
    await t.mutation(internal.imports.backfillHolds, {});
    await drain(t);
    expect((await list(t)).page).toEqual(held);
  });

  it("keeps the `match` note only while the ladder flags the edition, beside the other notes", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { publisherId } = await aliceSkeleton(t);
    const takenBy = await t.run(async (ctx) => {
      const other = await insertSeries(ctx, { publicId: 8, title: "Unrelated Story" });
      const editionId = await insertEdition(ctx, { publisherId });
      return await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [other],
        isbn13: "9781974728374",
      });
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    stubDump([alice1]);
    await openLibrarySync(t);
    const isbn10 = {
      field: "isbn10",
      offered: "1974728370",
      at: 1_500_000,
      reason: "Another field's note.",
    };
    await t.run(async (ctx) => {
      const observation = (await ctx.db.query("sourceObservations").first())!;
      await ctx.db.patch(observation._id, {
        conflicts: [...(observation.conflicts ?? []), isbn10],
      });
    });
    const notes = async () =>
      ((await observationOf(t, "/books/OL1M"))?.conflicts ?? []).map((c) => [c.field, c.at]);

    // Flagged twice: each note keeps its time, and the other field's stays.
    vi.setSystemTime(2_000_000);
    stubDump([alice1]);
    await openLibrarySync(t);
    expect(await notes()).toEqual([
      ["match", 1_000_000],
      ["placement", 1_000_000],
      ["isbn10", 1_500_000],
    ]);

    // The other Series' Release goes: no flag, so no `match` note.
    await t.run((ctx) => ctx.db.delete(takenBy));
    vi.setSystemTime(3_000_000);
    stubDump([alice1]);
    await openLibrarySync(t);
    expect(await notes()).toEqual([
      ["isbn10", 1_500_000],
      ["placement", 3_000_000],
    ]);
    expect((await list(t)).page.map((row) => row.kind)).toEqual(["volumeMissing"]);
  });

  it("lists an unlinked edition whose conflict Proposal was decided, and the backfill agrees", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId, publisherId } = await aliceSkeleton(t);
    const releaseId = await t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      return await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: "9781974728374",
      });
    });
    stubDump([alice1]);
    await openLibrarySync(t);
    const linked = await observationOf(t, "/books/OL1M");
    expect(linked?.recordRef).toEqual({ type: "release", id: releaseId });

    // A field conflict is queued from the link, then rejected.
    const proposalId = await t.run(async (ctx) => {
      const { proposalId } = await insertSourceProposal(ctx, {
        sourceKey: "openlibrary",
        state: "inReview",
        ops: [
          {
            kind: "update",
            ref: { type: "release", id: releaseId },
            changes: [{ field: "binding", before: undefined, after: "hardcover" }],
          },
        ],
        evidence: [linked!._id],
        comment: "Import conflict.",
        now: Date.now(),
      });
      await ctx.db.patch(linked!._id, { queuedProposalId: proposalId });
      return proposalId;
    });
    await signedIn(t, alice).mutation(api.proposals.rejectProposal, {
      proposalId,
      note: "Paperback.",
    });
    // A repair finds the Release is another printing and unlinks the edition.
    await t.run(async (ctx) => {
      await ctx.db.patch(releaseId, { isbn13: "9781974799990" });
      await ctx.db.patch(linked!._id, { recordRef: undefined });
    });

    stubDump([alice1]);
    await openLibrarySync(t);
    const held = [
      expect.objectContaining({
        sourceRecordId: "/books/OL1M",
        kind: "isbn",
        reason: "Volume 1 already has a physical VIZ Media Release (ISBN 9781974799990).",
      }),
    ];
    expect((await list(t)).page).toEqual(held);
    expect((await observationOf(t, "/books/OL1M"))?.queuedProposalId).toBe(proposalId);

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("placementHolds").collect())
        await ctx.db.delete(row._id);
    });
    await t.mutation(internal.imports.backfillHolds, {});
    await drain(t);
    expect((await list(t)).page).toEqual(held);
  });
});

describe("the hold lifecycle", () => {
  /** An unlinked observation held now as `hold`. */
  async function held(ctx: MutationCtx, sourceKey: string, id: string, hold: Hold, now: number) {
    const observationId = await insertObservation(ctx, {
      sourceKey,
      sourceRecordId: id,
      snapshot: { title: id },
    });
    await recordUnplaced(ctx, (await ctx.db.get(observationId))!, hold, now);
    return observationId;
  }

  it("takes a withdrawn observation off the list with its note", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const observationId = await t.run((ctx) =>
      held(ctx, "prh", "9780000000001", { kind: "packaging", reason: "Packaging." }, 1),
    );
    expect((await list(t)).page).toHaveLength(1);
    await t.mutation(internal.imports.markWithdrawn, {
      sourceKey: "prh",
      notSeenSince: Date.now(),
    });
    expect((await list(t)).page).toEqual([]);
    const observation = await t.run((ctx) => ctx.db.get(observationId));
    expect(observation).toMatchObject({ withdrawn: true, conflicts: [] });
  });

  it("links through one helper that clears the hold and the stale note, and never holds a linked record", async () => {
    const t = makeT();
    await seedTeam(t, [alice, carol]);
    await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, {});
      const id = await held(
        ctx,
        "ann",
        "release:1",
        { kind: "other", reason: "ANN lists no ISBN for this release." },
        1,
      );
      await linkObservation(ctx, id, { type: "series", id: seriesId });
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect((await ctx.db.get(id))?.conflicts).toEqual([]);
      // A linked record keeps the note only.
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind: "series", reason: "Box set conflict." },
        2,
      );
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect((await ctx.db.get(id))?.conflicts).toEqual([
        { field: "placement", offered: null, at: 2, reason: "Box set conflict." },
      ]);
    });
  });

  it("refuses a reader outside the Data Team, pages newest first, and filters by kind and source", async () => {
    const t = makeT();
    await seedTeam(t, [alice, carol, dave]);
    await t.run(async (ctx) => {
      await held(
        ctx,
        "ann",
        "release:1",
        { kind: "volumeMissing", reason: "No Volume 3 under the Series." },
        10,
      );
      await held(
        ctx,
        "openlibrary",
        "/books/OL9M",
        { kind: "volumeMissing", reason: "Missing." },
        20,
      );
      await held(
        ctx,
        "ann",
        "release:2",
        { kind: "other", reason: 'Distributor "Unheard Of Press" resolves to no publisher row.' },
        30,
      );
    });
    await expect(
      signedIn(t, dave).query(api.imports.heldBooks, {
        paginationOpts: { numItems: 5, cursor: null },
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const first = await list(t, { numItems: 2 });
    expect(first.page.map((row) => row.sourceRecordId)).toEqual(["release:2", "/books/OL9M"]);
    expect(first.isDone).toBe(false);
    const second = await list(t, { numItems: 2, cursor: first.continueCursor });
    expect(second.page.map((row) => row.sourceRecordId)).toEqual(["release:1"]);

    const ids = async (args: Parameters<typeof list>[1]) =>
      (await list(t, args)).page.map((row) => row.sourceRecordId);
    expect(await ids({ kind: "volumeMissing" })).toEqual(["/books/OL9M", "release:1"]);
    expect(await ids({ sourceKey: "ann" })).toEqual(["release:2", "release:1"]);
    expect(await ids({ sourceKey: "ann", kind: "volumeMissing" })).toEqual(["release:1"]);
    expect(await ids({ sourceKey: "prh" })).toEqual([]);
  });
});

/** A Seven Seas Deluxe Edition whose listing states no coverage. */
const deluxe: BookSnapshot = {
  kind: "book",
  url: "https://sevenseasentertainment.com/books/alpha-deluxe-1/",
  title: "Alpha Deluxe Edition 1",
  modifiedGmt: "2026-01-01",
  seriesTitle: "Alpha",
  seriesSlug: "alpha",
  creators: [],
  isbn13: "9781999000417",
  packaging: { lineName: "Deluxe Edition", linePosition: "1", coverRange: null },
};

const applySevenSeas = (t: TestT, snapshot: BookSnapshot) =>
  t.mutation(internal.sevenSeas.applyBook, { sourceRecordId: "101", snapshot });

/**
 * Hold the Deluxe Edition for packaging, then let a later sync find its
 * coverage, which queues a creation Proposal outside Bootstrap Mode.
 * Returns the observation as queued.
 */
async function heldThenQueued(t: TestT) {
  await seedRegistry(t, false);
  await seedTeam(t, [alice, carol]);
  await t.run((ctx) =>
    insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" }),
  );
  await applySevenSeas(t, deluxe);
  expect((await list(t)).page.map((row) => [row.kind, row.reason])).toEqual([
    ["packaging", expect.stringContaining("an Editor maps it.")],
  ]);
  await applySevenSeas(t, { ...deluxe, description: "Collects volumes 1-3 in hardcover." });
  const observation = await t.run((ctx) => ctx.db.query("sourceObservations").first());
  expect(observation?.queuedProposalId).toBeDefined();
  expect(observation?.conflicts?.find((c) => c.field === "placement")).toBeUndefined();
  expect((await list(t)).page).toEqual([]);
  return observation!;
}

describe("a Proposal in review takes the book off the list", () => {
  it("held, queued, then approved: the Release exists and the book stays off the list", async () => {
    const t = makeT();
    const observation = await heldThenQueued(t);
    const result = await signedIn(t, alice).mutation(api.proposals.approveProposal, {
      proposalId: observation.queuedProposalId!,
    });
    expect(result.status).toBe("approved");
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(1);
    expect((await list(t)).page).toEqual([]);
    // Approval does not link the observation.
    expect((await t.run((ctx) => ctx.db.get(observation._id)))?.recordRef).toBeUndefined();
  });

  it("held, queued, then rejected: off the list, and a later hold is listed", async () => {
    const t = makeT();
    const observation = await heldThenQueued(t);
    await signedIn(t, alice).mutation(api.proposals.rejectProposal, {
      proposalId: observation.queuedProposalId!,
      note: "Not a Deluxe Edition.",
    });
    expect((await list(t)).page).toEqual([]);
    // The listing drops its coverage again: the rejected Proposal is in no
    // queue, so the book is held.
    await applySevenSeas(t, deluxe);
    expect((await list(t)).page.map((row) => [row.sourceRecordId, row.kind])).toEqual([
      ["101", "packaging"],
    ]);
    const conflicts = (await t.run((ctx) => ctx.db.get(observation._id)))?.conflicts;
    expect(conflicts?.find((c) => c.field === "placement")?.reason).toContain("an Editor maps it.");
  });

  it("refuses Request Changes on an import's Proposal, which stays in the review queue", async () => {
    const t = makeT();
    const observation = await heldThenQueued(t);
    const proposalId = observation.queuedProposalId!;
    await expect(
      signedIn(t, alice).mutation(api.proposals.requestChanges, {
        proposalId,
        note: "Correct the coverage.",
      }),
    ).rejects.toMatchObject({ data: { code: "importAuthored" } });
    expect((await t.run((ctx) => ctx.db.get(proposalId)))?.state).toBe("inReview");
    const queue = await signedIn(t, alice).query(api.proposals.reviewQueue, {});
    expect(queue.map((row) => row.proposalId)).toEqual([proposalId]);
  });
});

describe("ANN lines", () => {
  /** An unlinked ANN line of manga 10 ("Alpha" vol. 1, unless `line` says otherwise). */
  const insertLine = (
    ctx: MutationCtx,
    annId: string,
    line: { title?: string; multi?: boolean } = {},
  ) =>
    insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${annId}`,
      snapshot: {
        kind: "annRelease",
        annId,
        mangaId: "10",
        url: `https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${annId}`,
        title: line.title ?? "Alpha",
        label: "1",
        multi: line.multi ?? false,
        format: "physical",
        editionLineHint: false,
      },
    });

  const placePage = (t: TestT, annId: string, page: { isbn13?: string; distributor?: string }) =>
    t.mutation(internal.ann.applyReleasePage, {
      annId,
      page: { status: "ok", fetchedAt: Date.now(), ...page },
    });

  it("notes a line no one can place without listing it, and lists one someone can act on", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { publicId: 3, title: "Alpha" });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:10",
        recordRef: { type: "series", id: seriesId },
      });
      // Line 1 was listed before lines like it were left off.
      const id = await insertLine(ctx, "1");
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind: "other", reason: "ANN lists no ISBN for this release." },
        1,
      );
      await insertLine(ctx, "2");
      await insertLine(ctx, "3");
    });
    expect((await list(t)).page).toHaveLength(1);
    await placePage(t, "1", {});
    await placePage(t, "2", { isbn13: "9781999000424", distributor: "Yen On" });
    await placePage(t, "3", { isbn13: "9781999000431", distributor: "Unheard Of Press" });

    expect(
      (await list(t)).page.map((row) => [row.sourceRecordId, row.kind, row.series?.publicId]),
    ).toEqual([["release:3", "other", 3]]);
    const notes = await t.run(async (ctx) =>
      (await ctx.db.query("sourceObservations").collect())
        .filter((o) => o.sourceRecordId.startsWith("release:"))
        .map((o) => [o.sourceRecordId, o.conflicts?.find((c) => c.field === "placement")?.reason]),
    );
    expect(notes).toEqual([
      ["release:1", "ANN lists no ISBN for this release."],
      ["release:2", '"Yen On" is a prose imprint: out of manga scope.'],
      ["release:3", 'Distributor "Unheard Of Press" resolves to no publisher row.'],
    ]);
  });

  it.each([
    {
      name: "a prose imprint's line with no linked Series",
      line: {},
      distributor: "Yen On",
      before: "The manga entry has no linked active Series.",
      reason: '"Yen On" is a prose imprint: out of manga scope.',
    },
    {
      name: "a foreign-language distributor's line with no linked Series",
      line: {},
      distributor: "Kana",
      before: "The manga entry has no linked active Series.",
      reason: '"Kana" publishes in another language: out of English scope.',
    },
    {
      name: "a box set's variant cover",
      line: { title: "Alpha Box Set Exclusive Cover", multi: true },
      distributor: "Seven Seas Entertainment",
      before: "Packaging (omnibus/box set/deluxe) links by ISBN only; none matched.",
      reason: "A store-exclusive or variant cover: never a Release of its own.",
    },
  ])(
    "notes $name as out of scope, and the backfill takes its old row away",
    async ({ line, distributor, before, reason }) => {
      const t = makeT();
      await seedRegistry(t);
      await seedTeam(t, [alice, carol]);
      const id = await t.run((ctx) => insertLine(ctx, "1", line));
      await placePage(t, "1", { isbn13: "9781999000417", distributor });
      expect((await list(t)).page).toEqual([]);
      const placement = async () =>
        (await t.run((ctx) => ctx.db.get(id)))?.conflicts?.find((c) => c.field === "placement")
          ?.reason;
      expect(await placement()).toBe(reason);

      // As held before scope came first: the backfill removes the row and
      // notes the line as the page pass now does.
      await t.run(async (ctx) => {
        await ctx.db.patch(id, {
          conflicts: [{ field: "placement", offered: null, at: 1, reason: before }],
        });
        await ctx.db.insert("placementHolds", {
          observationId: id,
          sourceKey: "ann",
          kind: storedHoldKind(before)!,
          heldAt: 1,
        });
      });
      expect((await list(t)).page).toHaveLength(1);
      await t.mutation(internal.imports.backfillHolds, {});
      await drain(t);
      expect((await list(t)).page).toEqual([]);
      expect(await placement()).toBe(reason);
    },
  );
});

describe("imports.backfillHolds", () => {
  it("holds stored notes, clears stale ones, classifies Open Library editions, resumes across pages, and changes no canonical record", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    const { seriesId, publisherId } = await aliceSkeleton(t);
    const ids = await t.run(async (ctx) => {
      const releaseId = await insertRelease(ctx, {
        editionId: await insertEdition(ctx, { publisherId }),
        publisherId,
        seriesIds: [seriesId],
      });
      const note = (reason: string, at: number) => [
        { field: "placement", offered: null, at, reason },
      ];
      // Filler first, so the interesting rows sit past the first page.
      for (let i = 0; i < 30; i++) {
        await insertObservation(ctx, { sourceKey: "prh", sourceRecordId: `filler:${i}` });
      }
      return {
        annLine: await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "release:5",
          conflicts: note("No Volume 5 under the Series.", 111),
        }),
        hiddenSeries: await insertObservation(ctx, {
          sourceKey: "prh",
          sourceRecordId: "9780000000002",
          conflicts: note(
            '"X" is Series 9 ("X"), which an Editor hid — not recreated by an import.',
            222,
          ),
        }),
        linked: await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "release:6",
          recordRef: { type: "release", id: releaseId },
          conflicts: note("ANN lists no ISBN for this release.", 333),
        }),
        withdrawn: await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "release:7",
          withdrawn: true,
          conflicts: note("ANN lists no ISBN for this release.", 444),
        }),
        // Stored before holds: Open Library skipped it without a note.
        edition: await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: "/books/OL1M",
          snapshot: {
            kind: "olEdition",
            key: "/books/OL1M",
            url: "https://openlibrary.org/books/OL1M",
            title: "Alice in Borderland, Vol. 1",
            seriesTitle: "Alice in Borderland",
            volumeLabel: "1",
            multiVolume: false,
            publishers: ["Viz Media"],
            isbn13: "9781974728374",
            format: "physical",
          },
        }),
        unknownPublisher: await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: "/books/OL4M",
          snapshot: {
            kind: "olEdition",
            key: "/books/OL4M",
            url: "https://openlibrary.org/books/OL4M",
            title: "Alice in Borderland, Vol. 2",
            seriesTitle: "Alice in Borderland",
            volumeLabel: "2",
            multiVolume: false,
            publishers: ["Unheard Of Press"],
            format: "physical",
          },
        }),
      };
    });
    const canonical = () =>
      t.run(async (ctx) => ({
        series: await ctx.db.query("series").collect(),
        volumes: await ctx.db.query("volumes").collect(),
        editions: await ctx.db.query("editions").collect(),
        releases: await ctx.db.query("releases").collect(),
        coverage: await ctx.db.query("volumeCoverages").collect(),
      }));
    const before = await canonical();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("", { status: 503 });
    });

    expect(await t.mutation(internal.imports.backfillHolds, {})).toMatchObject({ done: false });
    await drain(t);

    expect(requested).toEqual([]);
    expect(await canonical()).toEqual(before);
    const rows = (await list(t)).page;
    expect(rows.map((row) => [row.sourceRecordId, row.kind, row.heldAt])).toEqual([
      ["/books/OL1M", "volumeMissing", expect.any(Number)],
      ["9780000000002", "series", 222],
      ["release:5", "volumeMissing", 111],
    ]);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(ids.linked))?.conflicts).toEqual([]);
      expect((await ctx.db.get(ids.withdrawn))?.conflicts).toHaveLength(1);
      expect((await ctx.db.get(ids.unknownPublisher))?.conflicts ?? []).toEqual([]);
      expect((await ctx.db.get(ids.edition))?.recordRef).toBeUndefined();
    });

    // A second pass finds nothing new and moves nothing.
    await t.mutation(internal.imports.backfillHolds, {});
    await drain(t);
    expect((await list(t)).page).toEqual(rows);
  });

  it("keeps every hold an importer wrote, so a rerun after a live sighting changes nothing", async () => {
    const t = makeT();
    await seedTeam(t, [alice, carol]);
    const kodanshaReason =
      '"Alpha Omnibus 1" is Omnibus of "Alpha" with no stated coverage — an Editor maps it.';
    const { seriesId, kodansha } = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { publicId: 3, title: "Alpha" });
      // ANN's page pass held this line under its Series.
      const annLine = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:1",
      });
      const missing = {
        kind: "volumeMissing",
        reason: "No Volume 1 under the Series.",
        seriesId,
      } as const;
      await recordUnplaced(ctx, (await ctx.db.get(annLine))!, missing, 100);
      // A kind its reason alone does not name.
      const prh = await insertObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: "9780000000003",
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(prh))!,
        { kind: "series", reason: "A reason only its importer reads." },
        200,
      );
      // Noted before holds existed.
      const kodansha = await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "alpha-omnibus-1",
        conflicts: [{ field: "placement", offered: null, at: 300, reason: kodanshaReason }],
      });
      return { seriesId, kodansha };
    });
    const holds = () => t.run((ctx) => ctx.db.query("placementHolds").collect());
    const backfill = async () => {
      await t.mutation(internal.imports.backfillHolds, {});
      await drain(t);
    };
    const before = await holds();
    await backfill();
    const after = await holds();
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toMatchObject({ observationId: kodansha, kind: "packaging", heldAt: 300 });

    // Kodansha sees the book again, now with its Series.
    await t.run(async (ctx) =>
      recordUnplaced(
        ctx,
        (await ctx.db.get(kodansha))!,
        { kind: "packaging", reason: kodanshaReason, seriesId },
        400,
      ),
    );
    const sighted = await holds();
    expect(sighted[2]).toMatchObject({ kind: "packaging", heldAt: 300, seriesId });
    await backfill();
    expect(await holds()).toEqual(sighted);
  });

  it("removes a hold no longer held: queued for review, unplaceable, or out of scope elsewhere", async () => {
    const t = makeT();
    const queued = await heldThenQueued(t);
    await aliceSkeleton(t);
    stubDump([alice1]);
    await openLibrarySync(t);
    const annLine = await t.run(async (ctx) => {
      // Rows written before such books were left off the list.
      await ctx.db.insert("placementHolds", {
        observationId: queued._id,
        sourceKey: queued.sourceKey,
        kind: "packaging",
        heldAt: 1,
      });
      const annLine = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:1",
        conflicts: [
          {
            field: "placement",
            offered: null,
            at: 2,
            reason: "ANN lists no ISBN for this release.",
          },
        ],
      });
      await ctx.db.insert("placementHolds", {
        observationId: annLine,
        sourceKey: "ann",
        kind: "other",
        heldAt: 2,
      });
      // Yen Press has since filed the Open Library edition's ISBN out of scope.
      await insertObservation(ctx, {
        sourceKey: "yenpress",
        sourceRecordId: "9781974728374",
        snapshot: { outOfScope: "category light-novels" },
      });
      return annLine;
    });
    expect((await list(t)).page).toHaveLength(3);

    await t.mutation(internal.imports.backfillHolds, {});
    await drain(t);
    expect((await list(t)).page).toEqual([]);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(annLine))?.conflicts).toHaveLength(1);
    });
    expect((await observationOf(t, "/books/OL1M"))?.conflicts ?? []).toEqual([]);
  });
});

describe("imports.backfillHolds on its first run", () => {
  it("clears a source review note and retains an unresolved skipped Open Library edition", async () => {
    const t = makeT();
    const queued = await heldThenQueued(t);
    const note = {
      field: "placement",
      offered: null,
      at: 1,
      reason: "Packaging (omnibus/box set/deluxe) links by ISBN only; none matched.",
    };
    const skipped = await t.run(async (ctx) => {
      await ctx.db.patch(queued._id, { conflicts: [note] });
      return await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL4M",
        snapshot: {
          kind: "olEdition",
          key: "/books/OL4M",
          url: "https://openlibrary.org/books/OL4M",
          title: "Alice in Borderland, Vol. 2",
          seriesTitle: "Alice in Borderland",
          volumeLabel: "2",
          multiVolume: false,
          publishers: ["Unheard Of Press"],
          format: "physical",
        },
        conflicts: [{ ...note, reason: "No Volume 2 under the Series." }],
      });
    });
    expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toEqual([]);

    const result = await t.mutation(internal.imports.backfillHolds, {});
    expect(result).toMatchObject({ cleared: 1, done: true });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(queued._id))?.conflicts).toEqual([]);
      expect((await ctx.db.get(skipped))?.conflicts).toHaveLength(1);
    });
    expect((await list(t)).page).toEqual([]);
  });
});

describe("storedHoldKind", () => {
  it("reads each importer's reason as the kind that importer assigns, or as unlisted", () => {
    const reasons: Array<[string, HoldKind | null]> = [
      // ann.ts applyReleasePage
      ["ANN lists no ISBN for this release.", null],
      ["ISBN 9781974728374 is on a Release an Editor hid — not recreated.", "isbn"],
      [
        "ISBN 9781974728374 is already on a Release of another Series — a duplicate-Series question for an Editor.",
        "isbn",
      ],
      [
        '"Kappa [3-in-1 Edition]" (GN 1, 3) is packaging whose Volume list no range holds — an Editor maps it.',
        "packaging",
      ],
      ["Packaging (omnibus/box set/deluxe) links by ISBN only; none matched.", "packaging"],
      ["A store-exclusive or variant cover: never a Release of its own.", null],
      ["Packaging its title marks a novel: out of manga scope.", null],
      [
        '"Citrus+ [VIZBIG Edition]" is packaging titled for another work than Series 3 ("Citrus"), or a spelling of it this check cannot confirm: its Volume numbers may be that work\'s — an Editor places it.',
        "packaging",
      ],
      [
        '"Alpha Deluxe [VIZBIG Edition]" is packaging whose title names more than one Edition Line, so its work is unclear — an Editor places it.',
        "packaging",
      ],
      [
        `"Rurouni Kenshin - VIZBIG Edition [25-27]" (GN 9 / 9) is packaging, its line's last book, but the Volumes it states end at 27, before the Series' 28 — an Editor maps it.`,
        "packaging",
      ],
      ["The manga entry has no linked active Series.", "series"],
      ["The Series is locked.", "series"],
      ["The release page names no distributor.", "other"],
      ['"Yen On" is a prose imprint: out of manga scope.', null],
      ['"Kana" publishes in another language: out of English scope.', null],
      ['Distributor "Unheard Of Press" resolves to no publisher row.', "other"],
      ["Omnibus 3 would cover Volumes 7–9, but the Series lacks 9.", "volumeMissing"],
      ["Omnibus of unknown size: steady state leaves unmapped packaging to review.", "packaging"],
      ["Omnibus 3: steady state leaves Edition Line creation to review.", "packaging"],
      ["No Volume 4 under the Series.", "volumeMissing"],
      [
        "Volume 4 already has a physical VIZ Media Release (ISBN 9781974700011): a reprint or variant, not created.",
        "isbn",
      ],
      // lib/catalogTitle.ts (PRH, Yen Press)
      ['Box set "Alpha Box Set" has no unique base Series.', "series"],
      [
        'Box set "Alpha Box Set" is a Release Bundle — steady state leaves bundles to review.',
        "packaging",
      ],
      [
        `Box set "Alpha Box Set": the import reads no range of Volumes it collects from its title, its blurbs or its line's size — an Editor places it.`,
        "packaging",
      ],
      [
        '"Alpha Omnibus 1" is packaging (Omnibus) whose covered Volumes the title does not state — an Editor maps it.',
        "packaging",
      ],
      // sevenSeas.ts
      [
        'Box set "Alpha Box Set" becomes a Release Bundle only in Bootstrap Mode, under one base Series, covering the Volumes its title or blurb states — otherwise an Editor places it.',
        "packaging",
      ],
      [
        '"Alpha Deluxe Edition 1" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.',
        "packaging",
      ],
      // kodansha.ts, before and since its note quotes stated coverage
      [
        '"Alpha Omnibus 1" is Omnibus of "Alpha" with no stated coverage — an Editor maps it.',
        "packaging",
      ],
      [
        '"Alpha Omnibus 1" is Omnibus of "Alpha", stating Volumes 1-3 in its title. The Kodansha importer does not place packaging — an Editor maps it.',
        "packaging",
      ],
      // lib/pipeline.ts removedSeriesFor, for every importer
      [
        '"Alpha" is Series 3 ("Alpha"), which an Editor hid — not recreated by an import.',
        "series",
      ],
      // lib/unmatched.ts, a locked Series (Seven Seas, Kodansha, PRH, Yen Press)
      ["Series 3 is locked.", "series"],
    ];
    expect(reasons.map(([reason]) => [reason, storedHoldKind(reason)])).toEqual(reasons);
  });
});

describe("heldBooks.dismissInternal", () => {
  it("keeps a dismissed book off the list until its source changes it, and restores it", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    await aliceSkeleton(t);
    stubDump([alice1]);
    await openLibrarySync(t);
    const observation = await observationOf(t, "/books/OL1M");
    const dismiss = (expectedKind: HoldKind) =>
      t.mutation(internal.heldBooks.dismissInternal, {
        actor: "alice",
        observationId: observation!._id,
        expectedKind,
        reason: "An ISBN no publisher lists.",
        evidenceUrls: ["https://openlibrary.org/books/OL1M"],
      });

    // A hold that moved since the caller looked is refused.
    await expect(dismiss("isbn")).rejects.toThrow("held as volumeMissing");
    const { ledgerId } = await dismiss("volumeMissing");
    expect((await list(t)).page).toEqual([]);

    // The same book, seen again, stays off the list.
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([]);

    // Undone from the ledger, it is listed again.
    const ledger = await t.run((ctx) => ctx.db.get(ledgerId));
    await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "alice",
      ledgerId,
      expectedAfter: ledger!.after,
      reason: "Dismissed in error.",
    });
    expect((await list(t)).page).toEqual([
      expect.objectContaining({ sourceRecordId: "/books/OL1M", kind: "volumeMissing" }),
    ]);
    expect((await observationOf(t, "/books/OL1M"))?.dismissedHold).toBeUndefined();

    // Dismissed again, a source that changes the book lists it again.
    await dismiss("volumeMissing");
    stubDump([{ ...alice1, title: "Alice in Borderland, Vol. 1 (Special Edition)" }]);
    await openLibrarySync(t);
    expect((await list(t)).page).toEqual([
      expect.objectContaining({ sourceRecordId: "/books/OL1M" }),
    ]);
  });
});
