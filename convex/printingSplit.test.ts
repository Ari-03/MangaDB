// Split with Other Printings (lib/sensitiveOps.ts planPrintingSplit): a
// Release's Split decides every printing and every record of one before it
// writes, so each printing ISBN ends with one owner and each record of it
// with that owner; it refuses, writing nothing, when it cannot, when a
// record was relinked by a decision since the merge, or past its bounds.
// Every case runs real Merge, Split, Proposal and decision paths and reads
// the stored rows, links, marks, lookups and Revisions.

import type { TransactionMetrics } from "convex/server";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { recordUnplaced } from "./lib/observations";
import { budgetShortfall } from "./lib/releaseIsbns";
import { SPLIT_LIMITS } from "./lib/sensitiveOps";
import {
  insertBundle,
  insertBundleMember,
  insertObservation,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";
import { mergeAs, splitAs } from "./test.moderation";
import {
  another,
  catalogState,
  CURRENT,
  decide,
  heldRecord,
  insertPrinting,
  isbn13For,
  lookup,
  OLDER,
  OLDER_10,
  promote,
  rowsOf,
  vagabond,
  X,
  X_10,
  Y,
  Z,
} from "./test.printings";

const LOSER = "9781421599991";
const FIRST = "openlibrary /books/OL1M";

/**
 * Vagabond vol 1 twice: the survivor S (CURRENT) and the loser L (LOSER),
 * with OLDER decided as L's other printing from record /books/OL1M.
 */
async function world(t: TestT, loser: { seriesTitle?: string } = {}) {
  await seedRegistry(t);
  await seedTeam(t, [alice, bob]);
  const ids = await t.run(async (ctx) => {
    const book = await vagabond(ctx);
    let l: Id<"releases">;
    if (loser.seriesTitle === undefined) l = await another(ctx, book, { isbn13: LOSER });
    else {
      // L in a Series of its own (a cross-Series merge).
      const seriesId = await insertSeries(ctx, { title: loser.seriesTitle });
      const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
      l = await another(ctx, { ...book, seriesId, volumeId }, { isbn13: LOSER });
    }
    const title = `${loser.seriesTitle ?? "Vagabond"}, Vol. 1`;
    const first = await heldRecord(
      ctx,
      (await ctx.db.get(l))!.seriesIds[0]!,
      OLDER,
      { title },
      "/books/OL1M",
    );
    return { ...book, s: book.releaseId, l, first };
  });
  expect(await decide(t, ids.first, ids.l)).toMatchObject({ status: "recorded" });
  return ids;
}
type World = Awaited<ReturnType<typeof world>>;

const merge = (t: TestT, w: World) =>
  mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
const split = (t: TestT, w: World) => splitAs(t, { type: "release", id: w.l });

/** A record's link and mark, as stored. */
const linkOf = (t: TestT, observationId: Id<"sourceObservations">) =>
  t.run(async (ctx) => {
    const observation = (await ctx.db.get(observationId))!;
    return { to: observation.recordRef?.id ?? null, mark: observation.printingIsbn13 ?? null };
  });

/** A Release's newest Revision's changes. */
const latestChanges = (t: TestT, releaseId: Id<"releases">) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
        .order("desc")
        .first())!.changes,
  );

/** Split refused: nothing written, the loser still merged, its manifest still open. */
async function refusedSplit(t: TestT, w: World, reason: RegExp) {
  const before = await catalogState(t);
  await expect(split(t, w)).rejects.toThrow(reason);
  const after = await catalogState(t);
  expect(after).toEqual(before);
  expect(after.releases.find((r) => r._id === w.l)?.status).toBe("merged");
  expect(after.manifests.every((m) => m.reversedAt === undefined)).toBe(true);
}

describe("a Release's Split and its Other Printings", () => {
  it("brings a printing and its record back to the loser, and says so on both Revisions", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    expect(await rowsOf(t, w.s)).toEqual([OLDER]);
    expect(await linkOf(t, w.first)).toEqual({ to: w.s, mark: OLDER });
    await split(t, w);
    expect(await rowsOf(t, w.l)).toEqual([OLDER]);
    expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
    expect(await lookup(t, OLDER_10)).toMatchObject({ anchor: LOSER });
    const audit = [
      {
        field: "otherPrintings",
        after: [
          {
            isbn13: OLDER,
            outcome: "restored",
            reason: "Back with the Release it was recorded on.",
          },
        ],
      },
      {
        field: "sourceObservations",
        after: [{ record: FIRST, from: w.s, to: w.l, markBefore: OLDER, markAfter: OLDER }],
      },
    ];
    expect(await latestChanges(t, w.l)).toEqual([
      { field: "status", before: "merged", after: "active" },
      { field: "mergedInto", before: expect.any(String) },
      ...audit,
    ]);
    expect(await latestChanges(t, w.s)).toEqual([
      { field: "splitOut", after: expect.any(String) },
      ...audit,
    ]);
  });

  it("keeps a printing the survivor took as its own, with its record (R3)", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await promote(t, w.s, "isbn13", OLDER);
    await split(t, w);
    expect(await rowsOf(t, w.s)).toEqual([OLDER]);
    expect(await rowsOf(t, w.l)).toEqual([]);
    // Stays on the survivor, its mark untouched (L4: sticky suppression).
    expect(await linkOf(t, w.first)).toEqual({ to: w.s, mark: OLDER });
    expect(await lookup(t, OLDER)).toMatchObject({ anchor: OLDER });
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "sourceObservations",
      after: [{ record: FIRST, stays: w.s, mark: OLDER }],
    });
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "otherPrintings",
      after: [{ isbn13: OLDER, outcome: "keptOnSurvivor", reason: expect.any(String) }],
    });
  });

  it("leaves a merge's duplicate row removed while the survivor claims it, and brings it back once freed", async () => {
    for (const freed of [false, true]) {
      const t = makeT();
      const w = await world(t);
      // A survivor that already had the ISBN as its own (a legacy duplicate).
      await t.run((ctx) => ctx.db.patch(w.s, { isbn13: OLDER }));
      await merge(t, w);
      expect(await rowsOf(t, w.s)).toEqual([]);
      if (freed) await promote(t, w.s, "isbn13", CURRENT);
      await split(t, w);
      expect(await rowsOf(t, w.l)).toEqual(freed ? [OLDER] : []);
      expect(await linkOf(t, w.first)).toEqual({ to: freed ? w.l : w.s, mark: OLDER });
    }
  });

  it("restores a row the loser took as its own before the merge, clearing the record's mark", async () => {
    for (const field of ["isbn13", "isbn10"] as const) {
      const t = makeT();
      const w = await world(t);
      await promote(t, w.l, field, field === "isbn13" ? OLDER : OLDER_10);
      await merge(t, w);
      await split(t, w);
      expect(await rowsOf(t, w.l)).toEqual([OLDER]);
      expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: null });
      expect(await latestChanges(t, w.l)).toContainEqual({
        field: "sourceObservations",
        after: [{ record: FIRST, from: w.s, to: w.l, markBefore: OLDER, markAfter: null }],
      });
    }
  });

  it("moves nothing once the survivor has merged on, and the loser comes back", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const u = await t.run((ctx) => another(ctx, w, { isbn13: Y }));
    await mergeAs(t, { type: "release", id: u }, { type: "release", id: w.s });
    await split(t, w);
    expect(await rowsOf(t, u)).toEqual([OLDER]);
    expect(await linkOf(t, w.first)).toEqual({ to: u, mark: OLDER });
    expect(await t.run(async (ctx) => (await ctx.db.get(w.l))?.status)).toBe("active");
  });

  it("refuses, writing nothing, when a third Release claims the printing since", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await t.run((ctx) => another(ctx, w, { isbn13: OLDER, status: "hidden" }));
    await refusedSplit(
      t,
      w,
      /ISBN 9781591160342 is now claimed by Release .*: correct that before splitting/,
    );
  });

  it("refuses when a primary coming back with the loser would collide with a survivor's row (R2-02)", async () => {
    for (const viaTen of [false, true]) {
      const t = makeT();
      const w = await world(t);
      // K merged into L: K's ISBN is L's again after the Split.
      const k = await t.run((ctx) => another(ctx, w, viaTen ? { isbn10: X_10 } : { isbn13: X }));
      await mergeAs(t, { type: "release", id: w.l }, { type: "release", id: k });
      await merge(t, w);
      // A row of X on the survivor, as an older recording could leave one.
      await t.run(async (ctx) => {
        await insertPrinting(ctx, w.s, X);
        const record = await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: "/books/OL9M",
          recordRef: { type: "release", id: w.s },
          printingIsbn13: X,
          snapshot: { isbn13: X },
        });
        return record;
      });
      await refusedSplit(
        t,
        w,
        new RegExp(`ISBN ${X} would be claimed by Release .* and Release .*`),
      );
    }
  });

  it("brings back a row a Release merged into the loser brought with it", async () => {
    const t = makeT();
    const w = await world(t);
    const k = await t.run(async (ctx) => {
      const k = await another(ctx, w, { isbn13: Y });
      await insertPrinting(ctx, k, Z);
      return k;
    });
    await mergeAs(t, { type: "release", id: w.l }, { type: "release", id: k });
    await merge(t, w);
    expect(await rowsOf(t, w.s)).toEqual([OLDER, Z].sort());
    await split(t, w);
    expect(await rowsOf(t, w.l)).toEqual([OLDER, Z].sort());
    expect(await lookup(t, Z)).toMatchObject({ anchor: LOSER });
  });

  it("still splits duplicate primaries with no printing rows, as before (R2-03)", async () => {
    const t = makeT();
    const w = await world(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("releaseIsbns").collect()) await ctx.db.delete(row._id);
      await ctx.db.patch(w.first, { recordRef: undefined, printingIsbn13: undefined });
      await ctx.db.patch(w.l, { isbn13: CURRENT });
    });
    await merge(t, w);
    await split(t, w);
    const owners = await t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).filter(
        (r) => r.isbn13 === CURRENT && r.status === "active",
      ),
    );
    expect(owners).toHaveLength(2);
  });
});

describe("records linked since the merge", () => {
  it("moves a record first linked to the printing since the merge, with its maturity (R2-04)", async () => {
    const t = makeT();
    const w = await world(t, { seriesTitle: "Vagabond Side Stories" });
    await merge(t, w);
    const second = await t.run((ctx) =>
      heldRecord(ctx, w.seriesId, OLDER, { mature: true }, "/books/OL2M"),
    );
    expect(await decide(t, second, w.s)).toMatchObject({ status: "linked" });
    const loserSeries = await t.run(async (ctx) => (await ctx.db.get(w.l))!.seriesIds[0]!);
    expect(await t.run(async (ctx) => (await ctx.db.get(loserSeries))?.mature ?? null)).toBeNull();
    await split(t, w);
    expect(await linkOf(t, second)).toEqual({ to: w.l, mark: OLDER });
    expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
    expect(await t.run(async (ctx) => (await ctx.db.get(loserSeries))?.mature)).toBe(true);
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "sourceObservations",
      after: expect.arrayContaining([
        {
          record: "openlibrary /books/OL2M",
          from: w.s,
          to: w.l,
          markBefore: OLDER,
          markAfter: OLDER,
        },
      ]),
    });
  });

  /** Repair's audited unlink of a record from `from` (S by default), then held again for a decision. */
  async function unlinkAndHold(
    t: TestT,
    w: World,
    observationId: Id<"sourceObservations">,
    from: Id<"releases"> = w.s,
  ) {
    const [outcome] = await t.mutation(internal.repair.runBatch, {
      entries: [
        {
          kind: "unlinkObservation",
          key: `unlink-${observationId}-${from}`,
          reason: "Recheck the record.",
          observationId,
          recordType: "release",
          recordId: from,
        },
      ],
      dryRun: false,
      actor: alice.username,
    });
    expect(outcome).toMatchObject({ status: "applied" });
    await t.run(async (ctx) =>
      recordUnplaced(
        ctx,
        (await ctx.db.get(observationId))!,
        { kind: "isbn", reason: "Held again.", seriesId: w.seriesId },
        Date.now(),
      ),
    );
  }

  it("refuses when a record the merge moved was relinked by a decision since", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await unlinkAndHold(t, w, w.first);
    expect(await decide(t, w.first, w.s)).toMatchObject({ status: "linked" });
    await refusedSplit(
      t,
      w,
      /Record openlibrary \/books\/OL1M was unlinked or relinked by Revision \d+ of Release/,
    );
  });

  it("refuses when a record first linked since the merge was unlinked and linked again", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const second = await t.run((ctx) => heldRecord(ctx, w.seriesId, OLDER, {}, "/books/OL2M"));
    expect(await decide(t, second, w.s)).toMatchObject({ status: "linked" });
    await unlinkAndHold(t, w, second);
    expect(await decide(t, second, w.s)).toMatchObject({ status: "linked" });
    await refusedSplit(t, w, /Record openlibrary \/books\/OL2M was unlinked or relinked/);
  });

  it("is not misled by another record whose name starts the same", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const tenth = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL1M0",
        recordRef: { type: "release", id: w.s },
        snapshot: {},
      }),
    );
    await unlinkAndHold(t, w, tenth);
    await split(t, w);
    expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
  });

  /** A third Release T of Vagabond vol 1, with a record of OLDER linked to it as an import would. */
  async function linkedElsewhere(t: TestT, w: World, recordId: string) {
    return await t.run(async (ctx) => {
      const third = await another(ctx, w, {});
      const observationId = await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: recordId,
        recordRef: { type: "release", id: third },
        snapshot: {
          kind: "olEdition",
          url: `https://openlibrary.org${recordId}`,
          title: "Vagabond, Vol. 1",
          publishers: ["VIZ Media"],
          format: "physical",
          isbn13: OLDER,
        },
      });
      return { third, observationId };
    });
  }

  it("refuses when a record linked to another Release before the merge was unlinked there since, then linked to the printing (C67-11)", async () => {
    const t = makeT();
    const w = await world(t);
    const { third, observationId } = await linkedElsewhere(t, w, "/books/OL5M");
    await merge(t, w);
    await unlinkAndHold(t, w, observationId, third);
    expect(await decide(t, observationId, w.s)).toMatchObject({ status: "linked" });
    await refusedSplit(
      t,
      w,
      new RegExp(
        `Record openlibrary /books/OL5M was unlinked or relinked by Revision \\d+ of Release ${third}`,
      ),
    );
    expect(await linkOf(t, observationId)).toEqual({ to: w.s, mark: OLDER });
  });

  it("refuses the same for a record first seen after the merge and linked elsewhere meanwhile", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const { third, observationId } = await linkedElsewhere(t, w, "/books/OL6M");
    await unlinkAndHold(t, w, observationId, third);
    expect(await decide(t, observationId, w.s)).toMatchObject({ status: "linked" });
    await refusedSplit(t, w, /Record openlibrary \/books\/OL6M was unlinked or relinked/);
  });

  it("moves a record whose unlink elsewhere came before the merge: that is not a relink since", async () => {
    const t = makeT();
    const w = await world(t);
    const { third, observationId } = await linkedElsewhere(t, w, "/books/OL7M");
    await unlinkAndHold(t, w, observationId, third);
    await merge(t, w);
    expect(await decide(t, observationId, w.s)).toMatchObject({ status: "linked" });
    await split(t, w);
    expect(await linkOf(t, observationId)).toEqual({ to: w.l, mark: OLDER });
  });

  it("is not misled by another Release's audit of a record whose name starts the same", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const tenth = await linkedElsewhere(t, w, "/books/OL10M");
    await unlinkAndHold(t, w, tenth.observationId, tenth.third);
    const first = await t.run((ctx) => heldRecord(ctx, w.seriesId, OLDER, {}, "/books/OL1M0"));
    expect(await decide(t, first, w.s)).toMatchObject({ status: "linked" });
    await split(t, w);
    expect(await linkOf(t, first)).toEqual({ to: w.l, mark: OLDER });
  });

  it("leaves the survivor's own printings and their records alone", async () => {
    const t = makeT();
    const w = await world(t);
    const own = await t.run((ctx) => heldRecord(ctx, w.seriesId, Y, {}, "/books/OL3M"));
    expect(await decide(t, own, w.s)).toMatchObject({ status: "recorded" });
    await merge(t, w);
    await split(t, w);
    expect(await rowsOf(t, w.s)).toEqual([Y]);
    expect(await linkOf(t, own)).toEqual({ to: w.s, mark: Y });
  });
});

describe("a printing row changed since the merge (C67-12)", () => {
  /** The moved row of L's printing OLDER. */
  const rowOf = (t: TestT) =>
    t.run(
      async (ctx) =>
        (await ctx.db
          .query("releaseIsbns")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", OLDER))
          .unique())!,
    );

  it("leaves a row whose ISBN was corrected since on the survivor, and says so", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const row = await rowOf(t);
    await t.run((ctx) =>
      ctx.db.patch(row._id, { isbn13: Y, reason: "Corrected: the printing is ISBN Y." }),
    );
    await split(t, w);
    expect(await t.run(async (ctx) => (await ctx.db.get(row._id))!.releaseId)).toBe(w.s);
    expect(await rowsOf(t, w.l)).toEqual([]);
    expect(await rowsOf(t, w.s)).toEqual([Y]);
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "otherPrintings",
      after: [
        {
          isbn13: OLDER,
          outcome: "changedSinceMerge",
          reason: expect.stringMatching(new RegExp(`carries ISBN ${Y} now, not the ${OLDER}`)),
        },
      ],
    });
  });

  it("replays a row whose ISBN was only respelled, or whose reason was edited", async () => {
    for (const patch of [{ isbn13: "978-1-59116-034-2" }, { reason: "A clearer reason." }]) {
      const t = makeT();
      const w = await world(t);
      await merge(t, w);
      const row = await rowOf(t);
      await t.run((ctx) => ctx.db.patch(row._id, patch));
      await split(t, w);
      expect(await t.run(async (ctx) => (await ctx.db.get(row._id))!.releaseId)).toBe(w.l);
      expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
    }
  });

  it("leaves a row removed and recorded again on the survivor where it is, with its record", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    const row = await rowOf(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(row._id);
      await insertPrinting(ctx, w.s, OLDER);
    });
    await split(t, w);
    expect(await rowsOf(t, w.s)).toEqual([OLDER]);
    expect(await rowsOf(t, w.l)).toEqual([]);
    expect(await linkOf(t, w.first)).toEqual({ to: w.s, mark: OLDER });
  });

  it("keeps a record whose mark changed since with that printing's owner", async () => {
    const t = makeT();
    const w = await world(t);
    await t.run((ctx) => insertPrinting(ctx, w.s, Y));
    await merge(t, w);
    await t.run((ctx) => ctx.db.patch(w.first, { printingIsbn13: Y }));
    await split(t, w);
    expect(await linkOf(t, w.first)).toEqual({ to: w.s, mark: Y });
    expect(await rowsOf(t, w.l)).toEqual([OLDER]);
  });

  it("refuses a merge recorded before manifests kept the ISBN a row carried, writing nothing", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await t.run(async (ctx) => {
      const manifest = (await ctx.db.query("mergeManifests").first())!;
      await ctx.db.patch(manifest._id, {
        repointed: manifest.repointed.map(({ isbn13, ...entry }) => {
          void isbn13;
          return entry;
        }),
      });
    });
    await refusedSplit(t, w, /recorded before merges kept the ISBN they moved/);
  });
});

describe("a record linked as its Release's own printing (C67-R2-01)", () => {
  /** Open Library's second record of OLDER, applied by the real importer. */
  const SECOND = "/books/OL_SECOND_M";
  const secondRecord = (t: TestT) =>
    t.run(
      async (ctx) =>
        (await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "openlibrary").eq("sourceRecordId", SECOND),
          )
          .unique())!._id,
    );

  /**
   * world(), then OLDER promoted to L's own ISBN, a second Open Library
   * record of OLDER imported (it links to L as L's own printing, unmarked),
   * L's ISBN corrected back to LOSER (OLDER is L's printing again, its row
   * kept), and L merged into S. With `survivorTakes`, S then takes OLDER as
   * its own through an approved Proposal.
   */
  async function promotedThenMerged(t: TestT, survivorTakes: boolean) {
    const w = await world(t);
    await promote(t, w.l, "isbn13", OLDER);
    await t.mutation(internal.openLibrary.applyEdition, {
      snapshot: {
        kind: "olEdition",
        key: SECOND,
        url: `https://openlibrary.org${SECOND}`,
        title: "Vagabond, Vol. 1",
        seriesTitle: "Vagabond",
        volumeLabel: "1",
        multiVolume: false,
        isbn13: OLDER,
        format: "physical",
        publishers: ["VIZ Media"],
      },
    });
    const second = await secondRecord(t);
    expect(await linkOf(t, second)).toEqual({ to: w.l, mark: null });
    await promote(t, w.l, "isbn13", LOSER);
    await merge(t, w);
    if (survivorTakes) await promote(t, w.s, "isbn13", OLDER);
    return { ...w, second };
  }

  /** All four passes of the consistency check, each read to its end. */
  const checks = async (t: TestT) => {
    const out = [];
    for (const pass of ["releases", "bundles", "rows", "observations"] as const) {
      out.push(
        await t.query(internal.printings.consistencyInternal, {
          pass,
          paginationOpts: { numItems: 100, cursor: null },
        }),
      );
    }
    return out;
  };

  it("keeps the unmarked record with its printing on the survivor that took it", async () => {
    const t = makeT();
    const w = await promotedThenMerged(t, true);
    await split(t, w);
    expect(await rowsOf(t, w.s)).toEqual([OLDER]);
    expect(await linkOf(t, w.first)).toEqual({ to: w.s, mark: OLDER });
    expect(await linkOf(t, w.second)).toEqual({ to: w.s, mark: null });
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "sourceObservations",
      after: expect.arrayContaining([
        { record: `openlibrary ${SECOND}`, stays: w.s, mark: null },
        { record: FIRST, stays: w.s, mark: OLDER },
      ]),
    });
    for (const page of await checks(t)) expect(page).toMatchObject({ findings: [], isDone: true });
  });

  it("brings the unmarked record back with its printing, marked as the loser's printing now", async () => {
    const t = makeT();
    const w = await promotedThenMerged(t, false);
    await split(t, w);
    expect(await rowsOf(t, w.l)).toEqual([OLDER]);
    expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
    expect(await linkOf(t, w.second)).toEqual({ to: w.l, mark: OLDER });
    expect(await latestChanges(t, w.l)).toContainEqual({
      field: "sourceObservations",
      after: expect.arrayContaining([
        {
          record: `openlibrary ${SECOND}`,
          from: w.s,
          to: w.l,
          markBefore: null,
          markAfter: OLDER,
        },
      ]),
    });
    for (const page of await checks(t)) expect(page).toMatchObject({ findings: [], isDone: true });
  });

  it("leaves an unmarked record unlinked since the merge where it is, and refuses one relinked since", async () => {
    for (const relinked of [false, true]) {
      const t = makeT();
      const w = await promotedThenMerged(t, false);
      const [outcome] = await t.mutation(internal.repair.runBatch, {
        entries: [
          {
            kind: "unlinkObservation",
            key: "unlink-second",
            reason: "Recheck the record.",
            observationId: w.second,
            recordType: "release",
            recordId: w.s,
          },
        ],
        dryRun: false,
        actor: alice.username,
      });
      expect(outcome).toMatchObject({ status: "applied" });
      if (!relinked) {
        await split(t, w);
        expect(await linkOf(t, w.second)).toEqual({ to: null, mark: null });
        expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
        continue;
      }
      await t.run(async (ctx) =>
        recordUnplaced(
          ctx,
          (await ctx.db.get(w.second))!,
          { kind: "isbn", reason: "Held again.", seriesId: w.seriesId },
          Date.now(),
        ),
      );
      expect(await decide(t, w.second, w.s)).toMatchObject({ status: "linked" });
      await refusedSplit(
        t,
        w,
        /Record openlibrary \/books\/OL_SECOND_M was unlinked or relinked by Revision \d+/,
      );
    }
  });

  it("replays an unmarked record whose ISBN has no printing row, as before", async () => {
    const t = makeT();
    const w = await world(t);
    const own = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL_OWN_M",
        recordRef: { type: "release", id: w.l },
        snapshot: { isbn13: LOSER },
      }),
    );
    await merge(t, w);
    await promote(t, w.s, "isbn13", LOSER);
    await split(t, w);
    expect(await linkOf(t, own)).toEqual({ to: w.l, mark: null });
  });
});

describe("a removed printing row comes back under its ISBN-13 (C67-R2-08)", () => {
  /**
   * S owning OLDER, and L (ISBN X) with a legacy row spelling OLDER
   * `spelling`; the real correction Merge removes it as S's duplicate (its
   * manifest keeps the spelling), then an approved Proposal gives S CURRENT.
   */
  async function removedThenFreed(t: TestT, spelling: string) {
    await seedRegistry(t);
    await seedTeam(t, [alice, bob]);
    const w = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      await ctx.db.patch(book.releaseId, { isbn13: OLDER });
      const l = await another(ctx, book, { isbn13: X });
      await insertPrinting(ctx, l, spelling);
      return { ...book, s: book.releaseId, l };
    });
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    expect(await t.run((ctx) => ctx.db.query("releaseIsbns").collect())).toEqual([]);
    await promote(t, w.s, "isbn13", CURRENT);
    for (const pass of ["releases", "bundles", "rows", "observations"] as const) {
      expect(
        await t.query(internal.printings.consistencyInternal, {
          pass,
          paginationOpts: { numItems: 100, cursor: null },
        }),
      ).toMatchObject({ findings: [], isDone: true });
    }
    return w;
  }

  it("stores it so the barcode lookup and every check find it, whatever spelling the merge kept", async () => {
    for (const spelling of ["978-1-59116-034-2", "1591160340", "1-59116-034-0"]) {
      const t = makeT({ transactionLimits: true });
      const w = await removedThenFreed(t, spelling);
      await splitAs(t, { type: "release", id: w.l });
      expect(await t.run((ctx) => ctx.db.query("releaseIsbns").collect())).toEqual([
        expect.objectContaining({ isbn13: OLDER, releaseId: w.l }),
      ]);
      expect(await lookup(t, OLDER)).toMatchObject({ kind: "release", anchor: X });
      expect(
        await t.query(internal.printings.consistencyInternal, {
          pass: "rows",
          paginationOpts: { numItems: 100, cursor: null },
        }),
      ).toMatchObject({ findings: [], isDone: true });
      expect(await latestChanges(t, w.l)).toContainEqual({
        field: "otherPrintings",
        after: [
          {
            isbn13: OLDER,
            outcome: "restored",
            reason: `Back with the Release it was recorded on. Stored as ${OLDER}; the merge kept "${spelling}".`,
          },
        ],
      });
      // The manifest's own record of the row is left as it was.
      const manifest = (await t.run((ctx) => ctx.db.query("mergeManifests").first()))!;
      expect(manifest.removed).toContainEqual(
        expect.objectContaining({
          table: "releaseIsbns",
          doc: expect.objectContaining({ isbn13: spelling }),
        }),
      );
    }
  });

  it("refuses, writing nothing, when another Release holds that ISBN's row now", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await removedThenFreed(t, "1591160340");
    const third = await t.run(async (ctx) => {
      const third = await another(ctx, w, { isbn13: Y });
      await insertPrinting(ctx, third, OLDER);
      return third;
    });
    const before = await catalogState(t);
    await expect(splitAs(t, { type: "release", id: w.l })).rejects.toThrow(
      new RegExp(`ISBN ${OLDER} is now claimed by Release ${third}`),
    );
    expect(await catalogState(t)).toEqual(before);
  });

  it("respells a returning row the same way", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("releaseIsbns").first())!;
      await ctx.db.patch(row._id, { isbn13: "978-1-59116-034-2" });
    });
    await split(t, w);
    expect(await rowsOf(t, w.l)).toEqual([OLDER]);
  });
});

describe("a Split's bounds", () => {
  it("names each metric a plan would overrun", () => {
    const metrics = Object.fromEntries(
      [
        "bytesRead",
        "bytesWritten",
        "databaseQueries",
        "documentsRead",
        "documentsWritten",
        "functionsScheduled",
        "scheduledFunctionArgsBytes",
      ].map((name, i) => [name, { used: 0, remaining: 10 + i }]),
    ) as TransactionMetrics;
    expect(budgetShortfall(metrics, {})).toEqual([]);
    expect(budgetShortfall(metrics, { bytesRead: 10, documentsWritten: 14 })).toEqual([]);
    expect(
      budgetShortfall(metrics, {
        bytesRead: 11,
        bytesWritten: 12,
        databaseQueries: 13,
        documentsRead: 14,
        documentsWritten: 15,
        functionsScheduled: 16,
        scheduledFunctionArgsBytes: 17,
      }),
    ).toEqual([
      "bytesRead (needs 11, 10 left)",
      "bytesWritten (needs 12, 11 left)",
      "databaseQueries (needs 13, 12 left)",
      "documentsRead (needs 14, 13 left)",
      "documentsWritten (needs 15, 14 left)",
      "functionsScheduled (needs 16, 15 left)",
      "scheduledFunctionArgsBytes (needs 17, 16 left)",
    ]);
  });

  it("refuses more ISBNs than it decides at once", async () => {
    const t = makeT();
    const w = await world(t);
    // With OLDER, 40 rows on the survivor after the merge, and the loser's own ISBN.
    await t.run(async (ctx) => {
      for (let n = 1; n < SPLIT_LIMITS.isbns; n++) await insertPrinting(ctx, w.s, isbn13For(n));
    });
    await merge(t, w);
    await refusedSplit(t, w, /would decide 41 ISBNs, more than 40 at once/);
    // One more row, and the survivor alone has more than a Split reads.
    await t.run((ctx) => insertPrinting(ctx, w.s, isbn13For(0)));
    await refusedSplit(t, w, /Release \S+ has more than 40 other printings/);
  });

  it("refuses more records of the survivor than it reads, and more moves than it makes", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await t.run(async (ctx) => {
      for (let i = 0; i <= SPLIT_LIMITS.scan; i++) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${i}`,
          recordRef: { type: "release", id: w.s },
          ...(i <= SPLIT_LIMITS.moves ? { printingIsbn13: OLDER } : {}),
        });
      }
    });
    await refusedSplit(t, w, /has more than 400 records/);
    await t.run(async (ctx) => {
      const extra = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann"))
        .collect();
      for (const o of extra) if (o.printingIsbn13 === undefined) await ctx.db.delete(o._id);
    });
    await refusedSplit(t, w, /would move 10[2-9] records of printings, more than 100/);
  });

  it("refuses an audit larger than a Revision may carry", async () => {
    const t = makeT();
    const w = await world(t);
    await merge(t, w);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${i}:${"x".repeat(1200)}`,
          recordRef: { type: "release", id: w.s },
          printingIsbn13: OLDER,
        });
      }
    });
    await refusedSplit(t, w, /printing audit would exceed 65536 bytes/);
  });

  it("refuses, before the platform would, when large records would spend the transaction", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await world(t);
    await merge(t, w);
    for (let i = 0; i < 30; i++) {
      await t.run((ctx) =>
        insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${i}`,
          recordRef: { type: "release", id: w.s },
          snapshot: { payload: "x".repeat(500_000) },
        }),
      );
    }
    await refusedSplit(
      t,
      w,
      /needs more than one transaction allows to read the survivor's records \(bytesRead/,
    );
  });

  it("splits a Release with a long history, reading only its newest Revisions", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await world(t);
    // About 20 MB of old Revisions on the survivor: more than one read may take.
    for (let batch = 0; batch < 20; batch++) {
      await t.run(async (ctx) => {
        const author = { kind: "source" as const, sourceKey: "openlibrary" };
        const proposalId = await ctx.db.insert("proposals", {
          author,
          state: "approved",
          currentVersionNo: 1,
        });
        for (let i = 0; i < 50; i++) {
          await ctx.db.insert("revisions", {
            ref: { type: "release", id: w.s },
            seq: batch * 50 + i + 1,
            proposalId,
            author,
            changes: [{ field: "description", after: "x".repeat(20_000) }],
            comment: "An old edit.",
          });
        }
      });
    }
    await merge(t, w);
    await split(t, w);
    expect(await linkOf(t, w.first)).toEqual({ to: w.l, mark: OLDER });
  });
});

describe("a Split under the platform's own limits (C67-02, C67-03)", () => {
  // These run with convex-test's default transaction limits (16 MiB read,
  // 4,096 queries, ...): a Split ends in its own refusal, writing nothing,
  // or completes; never the platform's abort.
  const big = (n: number) => "x".repeat(n);

  /** L merged into S (its own ISBN only); `setUp` adds what each case needs. */
  async function merged(t: TestT) {
    await seedRegistry(t);
    await seedTeam(t, [alice, bob]);
    const ids = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      return { ...book, s: book.releaseId, l: await another(ctx, book, { isbn13: LOSER }) };
    });
    return ids;
  }
  /** What a refusal must leave as it was, read without loading the large documents. */
  const smallState = (t: TestT, l: Id<"releases">, rowId?: Id<"releaseIsbns">) =>
    t.run(async (ctx) => ({
      loser: await ctx.db.get(l),
      row: rowId ? await ctx.db.get(rowId) : null,
      manifest: await ctx.db
        .query("mergeManifests")
        .withIndex("by_loser", (q) => q.eq("loserRef.type", "release").eq("loserRef.id", l))
        .order("desc")
        .first(),
      revisions: (await ctx.db.query("revisions").collect()).length,
    }));
  async function refusedUnderLimits(
    t: TestT,
    l: Id<"releases">,
    reason: RegExp,
    rowId?: Id<"releaseIsbns">,
  ) {
    const before = await smallState(t, l, rowId);
    await expect(splitAs(t, { type: "release", id: l })).rejects.toThrow(reason);
    expect(await smallState(t, l, rowId)).toEqual(before);
    expect(before.loser?.status).toBe("merged");
  }

  it("refuses when the survivor's printing rows are too large to read", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await merged(t);
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    for (let i = 0; i < 20; i++)
      await t.run((ctx) => insertPrinting(ctx, w.s, isbn13For(i), { reason: big(850_000) }));
    await refusedUnderLimits(
      t,
      w.l,
      /needs more than one transaction allows to read its printings and who claims them \(bytesRead/,
    );
  });

  it("refuses when a printing's claims are too large to read", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await merged(t);
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    const rowId = await t.run((ctx) => insertPrinting(ctx, w.s, OLDER));
    for (let i = 0; i < 20; i++)
      await t.run((ctx) =>
        another(ctx, w, {
          isbn13: OLDER,
          status: "merged",
          mergedIntoId: w.s,
          description: big(850_000),
        }),
      );
    await refusedUnderLimits(
      t,
      w.l,
      /needs more than one transaction allows to read its printings and who claims them \(bytesRead/,
      rowId,
    );
  });

  it("never reads an earlier merge's reversed manifests, however large", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await merged(t);
    const rowId = await t.run((ctx) => insertPrinting(ctx, w.l, OLDER));
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    await splitAs(t, { type: "release", id: w.l });
    const exemplar = (await t.run((ctx) => ctx.db.query("mergeManifests").first()))!;
    for (let i = 0; i < 20; i++)
      await t.run(async (ctx) => {
        const { _id, _creationTime, ...fields } = exemplar;
        void _id;
        void _creationTime;
        await ctx.db.insert("mergeManifests", {
          ...fields,
          removed: [
            {
              table: "releaseIsbns",
              doc: {
                releaseId: w.l,
                isbn13: OLDER,
                reason: big(850_000),
                sourceKey: "openlibrary",
              },
            },
          ],
          reversedAt: 1,
        });
      });
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    await splitAs(t, { type: "release", id: w.l });
    const after = await smallState(t, w.l, rowId);
    expect(after.loser?.status).toBe("active");
    expect(after.row?.releaseId).toBe(w.l);
    expect(after.manifest?.reversedAt).toBeDefined();
  });

  /**
   * L with printing OLDER, merged into S, then `n` Releases (each a
   * 950,000-character description) carrying OLDER merged into L: Split
   * returns the row to L and must re-read all of their claims afterwards.
   */
  async function largeClaims(t: TestT, n: number) {
    await seedRegistry(t);
    await seedTeam(t, [alice, bob]);
    const ids = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const l = await another(ctx, book, { isbn13: LOSER });
      return { ...book, s: book.releaseId, l, row: await insertPrinting(ctx, l, OLDER) };
    });
    await mergeAs(t, { type: "release", id: ids.s }, { type: "release", id: ids.l });
    for (let i = 0; i < n; i++)
      await t.run((ctx) =>
        another(ctx, ids, {
          isbn13: OLDER,
          status: "merged",
          mergedIntoId: ids.l,
          description: big(950_000),
        }),
      );
    return ids;
  }

  it("reserves the fresh ownership check after its writes, and completes when it fits", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await largeClaims(t, 3);
    await splitAs(t, { type: "release", id: w.l });
    const after = await smallState(t, w.l, w.row);
    expect(after.loser?.status).toBe("active");
    expect(after.row?.releaseId).toBe(w.l);
    expect(await lookup(t, OLDER)).toMatchObject({ kind: "release" });
  });

  it("refuses before writing when that check would not fit, under tighter limits or larger claims", async () => {
    const tight = makeT({ transactionLimits: { bytesRead: 8 * 1024 * 1024 } });
    const small = await largeClaims(tight, 3);
    await refusedUnderLimits(
      tight,
      small.l,
      /needs more than one transaction allows (to write it and check its printings afterwards|to read its printings and who claims them) \(bytesRead/,
      small.row,
    );
    const t = makeT({ transactionLimits: true });
    const large = await largeClaims(t, 9);
    await refusedUnderLimits(
      t,
      large.l,
      /needs more than one transaction allows to write it and check its printings afterwards \(bytesRead/,
      large.row,
    );
  });

  it("refuses, writing nothing, when the Series and tracking it must keep are too large to read (C67-R2-03)", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await merged(t);
    for (let i = 0; i < 20; i++)
      await t.run(async (ctx) => {
        const bundleId = await insertBundle(ctx, {
          publisherId: w.publisherId,
          description: big(850_000),
        });
        await insertBundleMember(ctx, { bundleId, releaseId: w.l });
      });
    await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
    const before = await catalogState(t);
    await expect(splitAs(t, { type: "release", id: w.l })).rejects.toThrow(
      /This Split needs more than one transaction allows \(.*\); nothing was split/,
    );
    expect(await catalogState(t)).toEqual(before);
  });

  /**
   * world() with L in a Series of its own, `count` small Bundles holding
   * L, then the Merge; since, alice owns the first Bundle and keeps her
   * ownership of Vagabond (where the Bundle answers now) private, with a
   * public default.
   */
  async function trackedBundles(t: TestT, count: number) {
    const w = await world(t, { seriesTitle: "Vagabond Side Stories" });
    const bundles = await t.run(async (ctx) => {
      const ids: Array<Id<"releaseBundles">> = [];
      for (let i = 0; i < count; i++) {
        const bundleId = await insertBundle(ctx, { publisherId: w.publisherId });
        await insertBundleMember(ctx, { bundleId, releaseId: w.l });
        ids.push(bundleId);
      }
      return ids;
    });
    await merge(t, w);
    const asAlice = signedIn(t, alice);
    await asAlice.mutation(api.sharing.setDefaultVisibility, {
      kind: "ownership",
      visibility: "public",
    });
    await asAlice.mutation(api.sharing.setSeriesVisibility, {
      seriesId: w.seriesId,
      kind: "ownership",
      visibility: "private",
    });
    await asAlice.mutation(api.collection.setBundleEntry, {
      bundleId: bundles[0]!,
      state: "owned",
    });
    return { ...w, bundles };
  }

  it("keeps a private tracker private across many Bundles, or refuses whole (C67-R2-04)", async () => {
    for (const count of [350, 400, 450]) {
      const t = makeT({ transactionLimits: true });
      const w = await trackedBundles(t, count);
      const loserSeries = await t.run(async (ctx) => (await ctx.db.get(w.l))!.seriesIds[0]!);
      const before = await catalogState(t);
      const outcome = await splitAs(t, { type: "release", id: w.l }).then(
        () => null,
        (error: unknown) => String(error),
      );
      if (outcome !== null) {
        expect(outcome).toMatch(/badSplit/);
        expect(await catalogState(t)).toEqual(before);
        continue;
      }
      // Done: the Bundles answer to L's Series again, which keeps alice's
      // ownership as private as Vagabond did.
      const state = await t.run(async (ctx) => {
        const user = (await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("usernameNormalized", alice.username))
          .unique())!;
        return await ctx.db
          .query("userSeriesStates")
          .withIndex("by_user_series", (q) => q.eq("userId", user._id).eq("seriesId", loserSeries))
          .unique();
      });
      expect(state?.ownershipVisibility).toBe("private");
      expect(await t.run(async (ctx) => (await ctx.db.get(w.l))?.status)).toBe("active");
    }
  });

  it("reads a shared Series once for every mature record it moves (C67-R2-04)", async () => {
    const t = makeT({ transactionLimits: true });
    const w = await world(t);
    await merge(t, w);
    const records = [];
    for (let i = 0; i < 20; i++) {
      const record = await t.run((ctx) =>
        heldRecord(ctx, w.seriesId, OLDER, { mature: true }, `/books/OL_NEW_${i}M`),
      );
      expect(await decide(t, record, w.s)).toMatchObject({ status: "linked" });
      records.push(record);
    }
    await t.run((ctx) => ctx.db.patch(w.seriesId, { synopsis: big(850_000), mature: undefined }));
    await split(t, w);
    for (const record of [w.first, ...records]) {
      expect(await linkOf(t, record)).toEqual({ to: w.l, mark: OLDER });
    }
    expect(await t.run(async (ctx) => (await ctx.db.get(w.seriesId))?.mature)).toBe(true);
  });

  it("checks every real metric before writing, under each tightened limit", async () => {
    const limits = {
      bytesRead: 5_000_000,
      bytesWritten: 1_000_000,
      databaseQueries: 500,
      documentsRead: 2000,
      documentsWritten: 1000,
      functionsScheduled: 25,
      scheduledFunctionArgsBytes: 100_000,
    } as const;
    for (const [metric, limit] of Object.entries(limits)) {
      const t = makeT({ transactionLimits: { [metric]: limit } });
      const w = await merged(t);
      await mergeAs(t, { type: "release", id: w.s }, { type: "release", id: w.l });
      await refusedUnderLimits(t, w.l, new RegExp(`${metric} \\(needs`));
    }
  });
});
