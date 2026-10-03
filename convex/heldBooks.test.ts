// Held Books: what an import could not place, listed for the Data Team
// (imports.heldBooks). Covers the hold lifecycle (held, re-sighted, linked,
// withdrawn), Open Library's held editions against the ones it still skips,
// the list's gate, pages and filters, and the backfill of stored rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { type Hold, linkObservation, recordUnplaced } from "./lib/observations";
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
import { alice, carol, dave, drain, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

/** Serve these Open Library editions as the filtered dump. */
function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions
    .map((e) => `/type/edition\t${String(e.key)}\t1\t2026-08-01T00:00:00\t${JSON.stringify(e)}`)
    .join("\n");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input) === DUMP_URL ? new Response(`${body}\n`) : new Response("not found", { status: 404 }),
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
const alice2 = { ...alice1, key: "/books/OL2M", title: "Alice in Borderland, Vol. 2", isbn_13: ["9781974728381"] };

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
const list = (t: TestT, args: { kind?: Hold["kind"]; sourceKey?: string; numItems?: number; cursor?: string | null } = {}) =>
  asEditor(t).query(api.imports.heldBooks, {
    paginationOpts: { numItems: args.numItems ?? 25, cursor: args.cursor ?? null },
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.sourceKey !== undefined ? { sourceKey: args.sourceKey } : {}),
  });

const observationOf = (t: TestT, sourceRecordId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) => q.eq("sourceKey", "openlibrary").eq("sourceRecordId", sourceRecordId))
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
        proposal: null,
      }),
    ]);
    const observation = await observationOf(t, "/books/OL1M");
    expect(page[0]!.lastSeenAt).toBe(observation!.lastSeenAt);
    expect(page[0]!.heldAt).toBeGreaterThan(0);
    // Holding writes no canonical record.
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", seriesId)).collect()).toHaveLength(1);
    });
  });

  it("still records nothing for an edition with no Series match or an unknown publisher", async () => {
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, carol]);
    await aliceSkeleton(t);
    stubDump([
      { ...alice1, key: "/books/OL3M", title: "Nobody's Saga, Vol. 1", isbn_13: ["9781974700011"] },
      { ...alice1, key: "/books/OL4M", publishers: ["Unheard Of Press"], isbn_13: ["9781974700028"] },
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
      await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], isbn13: "9781974799990" });
    });
    vi.setSystemTime(4_000_000);
    stubDump([alice1, alice2]);
    await openLibrarySync(t);
    expect((await list(t)).page.map((row) => [row.sourceRecordId, row.kind, row.heldAt])).toEqual([
      ["/books/OL1M", "isbn", 4_000_000],
      ["/books/OL2M", "volumeMissing", 2_000_000],
    ]);
  });
});

describe("the hold lifecycle", () => {
  /** An unlinked observation held now as `hold`. */
  async function held(ctx: MutationCtx, sourceKey: string, id: string, hold: Hold, now: number) {
    const observationId = await insertObservation(ctx, { sourceKey, sourceRecordId: id, snapshot: { title: id } });
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
    await t.mutation(internal.imports.markWithdrawn, { sourceKey: "prh", notSeenSince: Date.now() });
    expect((await list(t)).page).toEqual([]);
    const observation = await t.run((ctx) => ctx.db.get(observationId));
    expect(observation).toMatchObject({ withdrawn: true, conflicts: [] });
  });

  it("links through one helper that clears the hold and the stale note, and never holds a linked record", async () => {
    const t = makeT();
    await seedTeam(t, [alice, carol]);
    await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, {});
      const id = await held(ctx, "ann", "release:1", { kind: "other", reason: "ANN lists no ISBN for this release." }, 1);
      await linkObservation(ctx, id, { type: "series", id: seriesId });
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect((await ctx.db.get(id))?.conflicts).toEqual([]);
      // A linked record keeps the note only.
      await recordUnplaced(ctx, (await ctx.db.get(id))!, { kind: "series", reason: "Box set conflict." }, 2);
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
      await held(ctx, "ann", "release:1", { kind: "volumeMissing", reason: "No Volume 3 under the Series." }, 10);
      await held(ctx, "openlibrary", "/books/OL9M", { kind: "volumeMissing", reason: "Missing." }, 20);
      await held(ctx, "ann", "release:2", { kind: "other", reason: "ANN lists no ISBN for this release." }, 30);
    });
    await expect(
      signedIn(t, dave).query(api.imports.heldBooks, { paginationOpts: { numItems: 5, cursor: null } }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const first = await list(t, { numItems: 2 });
    expect(first.page.map((row) => row.sourceRecordId)).toEqual(["release:2", "/books/OL9M"]);
    expect(first.isDone).toBe(false);
    const second = await list(t, { numItems: 2, cursor: first.continueCursor });
    expect(second.page.map((row) => row.sourceRecordId)).toEqual(["release:1"]);

    const ids = async (args: Parameters<typeof list>[1]) => (await list(t, args)).page.map((row) => row.sourceRecordId);
    expect(await ids({ kind: "volumeMissing" })).toEqual(["/books/OL9M", "release:1"]);
    expect(await ids({ sourceKey: "ann" })).toEqual(["release:2", "release:1"]);
    expect(await ids({ sourceKey: "ann", kind: "volumeMissing" })).toEqual(["release:1"]);
    expect(await ids({ sourceKey: "prh" })).toEqual([]);
  });
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
      const note = (reason: string, at: number) => [{ field: "placement", offered: null, at, reason }];
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
          conflicts: note('"X" is Series 9 ("X"), which an Editor hid — not recreated by an import.', 222),
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
});
