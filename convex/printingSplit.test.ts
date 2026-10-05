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
import { insertObservation, insertSeries, insertVolume } from "./test.factories";
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
  rowsOf,
  vagabond,
  VIZ_URL,
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

const promote = async (
  t: TestT,
  releaseId: Id<"releases">,
  field: "isbn13" | "isbn10",
  value: string,
) => {
  const asAdmin = signedIn(t, alice);
  const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
    ops: [{ kind: "update", ref: { type: "release", id: releaseId }, changes: [{ field, value }] }],
    evidence: [{ kind: "url", url: VIZ_URL }],
    comment: "Use this ISBN as the Release's own.",
  });
  await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
  await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });
};

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

  /** Repair's audited unlink of a record from S, then held again for a decision. */
  async function unlinkAndHold(t: TestT, w: World, observationId: Id<"sourceObservations">) {
    const [outcome] = await t.mutation(internal.repair.runBatch, {
      entries: [
        {
          kind: "unlinkObservation",
          key: `unlink-${observationId}`,
          reason: "Recheck the record.",
          observationId,
          recordType: "release",
          recordId: w.s,
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
