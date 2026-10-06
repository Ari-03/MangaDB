// Who may hold an ISBN with Other Printings (lib/releaseIsbns.ts): every
// stored claim is read, merges followed, hidden owners and Bundles counted,
// and a write that cannot read or follow every claim refuses. Each writer is
// driven through its real entry point and judged by the stored rows, links,
// holds and audits it leaves.

import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { createCanonicalRecords, isbnHeldElsewhere } from "./lib/pipeline";
import type { RepairEntry } from "./lib/repair/entries";
import {
  CLAIM_SCAN,
  claimResolver,
  isbnClaims,
  MERGE_HOPS,
  printedClaimRefusal,
} from "./lib/releaseIsbns";
import { insertBundle, insertObservation, insertRelease, insertVolume } from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";
import { mergeAs, moderate } from "./test.moderation";
import {
  another,
  catalogState,
  CURRENT,
  decide,
  heldRecord,
  holdFor,
  insertPrinting,
  lookup,
  OLDER,
  OLDER_10,
  rowsOf,
  vagabond,
  VIZ_URL,
  W979,
  X,
  X_10,
  Y,
  Z,
} from "./test.printings";

async function world(t: TestT) {
  await seedRegistry(t);
  await seedTeam(t, [alice, bob]);
  return await t.run(async (ctx) => vagabond(ctx));
}

/** Decide, expect a refusal matching `reason`, and that nothing changed. */
async function refused(
  t: TestT,
  observationId: Id<"sourceObservations">,
  releaseId: Id<"releases">,
  reason: RegExp,
) {
  const before = await catalogState(t);
  const result = await decide(t, observationId, releaseId);
  expect(result).toEqual({ status: "refused", reason: expect.stringMatching(reason) });
  expect(await catalogState(t)).toEqual(before);
  expect(await holdFor(t, observationId)).not.toBeNull();
}

describe("isbnClaims", () => {
  it("keeps every claim with its kind and stored record, grouped by where its merges end", async () => {
    const t = makeT();
    const book = await world(t);
    await t.run(async (ctx) => {
      const a = await another(ctx, book, { isbn13: X });
      const merged = await another(ctx, book, { status: "merged", mergedIntoId: a });
      const rowA = await insertPrinting(ctx, a, X);
      const rowMerged = await insertPrinting(ctx, merged, X);
      const resolver = claimResolver(ctx);
      const claims = (await isbnClaims(ctx, X_10, { resolver }))!;
      expect(claims).toMatchObject({ isbn13: X, complete: true, printed: true, unresolved: [] });
      expect([...claims.owners.keys()]).toEqual([a]);
      expect(claims.owners.get(a)?.claims).toEqual([
        { on: "release", via: "isbn13", storedId: a },
        { on: "release", via: "printing", storedId: a, rowId: rowA },
        { on: "release", via: "printing", storedId: merged, rowId: rowMerged },
      ]);
      // Leaving out one row keeps the other, and the primary.
      const kept = (await isbnClaims(ctx, X, {
        resolver,
        keep: (claim) => claim.on !== "release" || claim.rowId !== rowA,
      }))!;
      expect(kept.owners.get(a)?.claims.map((claim) => claim.via)).toEqual(["isbn13", "printing"]);
      expect(kept.printed).toBe(true);
      expect(printedClaimRefusal(claims, a)).toBeNull();
      expect(printedClaimRefusal(claims, book.releaseId)).toMatch(
        `ISBN ${X} belongs to Release ${a}`,
      );
      expect(await isbnClaims(ctx, "9781421506554", { resolver })).toBeNull();
    });
  });

  it("says when it could not read every claim, even if the first ones agree", async () => {
    const t = makeT();
    const book = await world(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < CLAIM_SCAN; i++) await insertPrinting(ctx, book.releaseId, X);
      const resolver = claimResolver(ctx);
      expect((await isbnClaims(ctx, X, { resolver }))?.complete).toBe(true);
      // The twenty-first row is someone else's.
      await insertPrinting(ctx, await another(ctx, book), X);
      const claims = (await isbnClaims(ctx, X, { resolver }))!;
      expect(claims.complete).toBe(false);
      expect(printedClaimRefusal(claims, book.releaseId)).toMatch(/more stored claims/);
    });
  });

  it("never reads a claim it cannot follow as nobody's", async () => {
    const t = makeT();
    const book = await world(t);
    await t.run(async (ctx) => {
      const gone = await another(ctx, book);
      await ctx.db.delete(gone);
      const pointerless = await another(ctx, book, { status: "merged" });
      const a = await another(ctx, book, { status: "merged" });
      const b = await another(ctx, book, { status: "merged", mergedIntoId: a });
      await ctx.db.patch(a, { mergedIntoId: b });
      // A chain of exactly MERGE_HOPS merges resolves; one more does not.
      const chain = [await another(ctx, book)];
      for (let i = 0; i <= MERGE_HOPS; i++) {
        chain.unshift(await another(ctx, book, { status: "merged", mergedIntoId: chain[0] }));
      }
      const resolver = claimResolver(ctx);
      for (const [releaseId, reason] of [
        [gone, /no longer exists/],
        [pointerless, /merged into nothing/],
        [a, /merge cycle/],
        [chain[0]!, /merged more than 8 times/],
      ] as const) {
        expect(await resolver.release(releaseId)).toEqual({
          unresolved: expect.stringMatching(reason),
        });
      }
      expect(await resolver.release(chain[1]!)).toEqual({
        doc: expect.objectContaining({ _id: chain.at(-1) }),
      });
      // A Split's view: the loser is its own again, and so is what merged into it.
      const virtual = claimResolver(ctx, { terminal: chain[3]! });
      expect(await virtual.release(chain[1]!)).toEqual({
        doc: expect.objectContaining({ _id: chain[3] }),
      });
    });
  });
});

describe("a decided printing and the ISBN's other claims", () => {
  it("refuses an ISBN a hidden Release owns, as its own or as a printing", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => {
      await another(ctx, book, { isbn13: OLDER, status: "hidden" });
      const hiddenPrinter = await another(ctx, book, { isbn13: Y, status: "hidden" });
      await insertPrinting(ctx, hiddenPrinter, X);
      return {
        primary: await heldRecord(ctx, book.seriesId, OLDER),
        row: await heldRecord(ctx, book.seriesId, X),
      };
    });
    await refused(t, ids.primary, book.releaseId, /belongs to hidden Release .*isbn13/);
    await refused(t, ids.row, book.releaseId, /belongs to hidden Release .*printing row/);
    // Hidden owners find nothing at /isbn.
    expect(await lookup(t, OLDER)).toBeNull();
  });

  it("refuses an ISBN that is the Release's own through a Release merged into it", async () => {
    const t = makeT();
    const book = await world(t);
    const { loser, record } = await t.run(async (ctx) => ({
      loser: await another(ctx, book, { isbn13: OLDER }),
      record: await heldRecord(ctx, book.seriesId, OLDER),
    }));
    await mergeAs(t, { type: "release", id: book.releaseId }, { type: "release", id: loser });
    await refused(
      t,
      record,
      book.releaseId,
      new RegExp(`the Release's own, as the ISBN of Release ${loser} merged into it`),
    );
  });

  it("refuses an ISBN a merged Release left to another survivor, or a Bundle holds", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => {
      const survivor = await another(ctx, book, { isbn13: Y });
      await another(ctx, book, { isbn13: OLDER, status: "merged", mergedIntoId: survivor });
      const box = await insertBundle(ctx, { publisherId: book.publisherId, status: "hidden" });
      const bigBox = await insertBundle(ctx, { publisherId: book.publisherId });
      await ctx.db.patch(box, { status: "merged", mergedIntoId: bigBox, isbn10: X_10 });
      await insertBundle(ctx, { publisherId: book.publisherId, isbn13: Z });
      return {
        survivor,
        merged: await heldRecord(ctx, book.seriesId, OLDER),
        mergedBox: await heldRecord(ctx, book.seriesId, X),
        activeBox: await heldRecord(ctx, book.seriesId, Z),
      };
    });
    await refused(t, ids.merged, book.releaseId, new RegExp(`belongs to Release ${ids.survivor}`));
    await refused(t, ids.mergedBox, book.releaseId, /Release Bundle \d+'s/);
    await refused(t, ids.activeBox, book.releaseId, /Release Bundle \d+'s/);
  });

  it("refuses an ISBN whose claims it cannot read whole or follow", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => {
      const orphanOwner = await another(ctx, book);
      await insertPrinting(ctx, orphanOwner, OLDER);
      await ctx.db.delete(orphanOwner);
      const crowd = await another(ctx, book, { isbn13: Y });
      for (let i = 0; i <= CLAIM_SCAN; i++) await insertPrinting(ctx, crowd, X);
      return {
        orphan: await heldRecord(ctx, book.seriesId, OLDER),
        crowded: await heldRecord(ctx, book.seriesId, X),
      };
    });
    await refused(t, ids.orphan, book.releaseId, /no longer exists: an administrator corrects it/);
    await refused(t, ids.crowded, book.releaseId, /more stored claims than one check reads/);
  });

  it("never links to the Release's own row while another record also claims the ISBN", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => {
      await insertPrinting(ctx, book.releaseId, OLDER);
      await insertPrinting(ctx, book.releaseId, X);
      await another(ctx, book, { isbn13: OLDER, status: "hidden" });
      await insertBundle(ctx, { publisherId: book.publisherId, isbn10: X_10 });
      return {
        hidden: await heldRecord(ctx, book.seriesId, OLDER),
        boxed: await heldRecord(ctx, book.seriesId, X),
      };
    });
    await refused(t, ids.hidden, book.releaseId, /belongs to hidden Release/);
    await refused(t, ids.boxed, book.releaseId, /Release Bundle \d+'s/);
  });

  it("records past an unrelated hidden Release and an unrelated Bundle", async () => {
    const t = makeT();
    const book = await world(t);
    const record = await t.run(async (ctx) => {
      await another(ctx, book, { isbn13: Y, status: "hidden" });
      await insertBundle(ctx, { publisherId: book.publisherId, isbn13: X });
      return await heldRecord(ctx, book.seriesId, OLDER);
    });
    expect(await decide(t, record, book.releaseId)).toEqual({ status: "recorded", isbn13: OLDER });
    expect(await rowsOf(t, book.releaseId)).toEqual([OLDER]);
    expect(await lookup(t, OLDER_10)).toMatchObject({ kind: "release", anchor: CURRENT });
  });
});

describe("other writers keep an ISBN with printings to its one owner", () => {
  /** A hidden Release whose printing is X, and the Release Y-primary that might take X. */
  async function hiddenPrinter(t: TestT) {
    const book = await world(t);
    const hidden = await t.run(async (ctx) => {
      const hidden = await another(ctx, book, { isbn13: Y, status: "hidden" });
      await insertPrinting(ctx, hidden, X);
      return hidden;
    });
    return { ...book, hidden };
  }

  const proposal = async (t: TestT, ops: FunctionArgs<typeof api.proposals.saveDraft>["ops"]) => {
    const asAdmin = signedIn(t, alice);
    const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops,
      evidence: [{ kind: "url", url: VIZ_URL }],
      comment: "Correct the ISBNs.",
    });
    await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
    return await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });
  };
  const releaseUpdate = (id: Id<"releases">, field: "isbn13" | "isbn10", value: string) => ({
    kind: "update" as const,
    ref: { type: "release" as const, id },
    changes: [{ field, value }],
  });

  it("refuses a Proposal giving another Release a hidden Release's printing, in either form", async () => {
    const t = makeT();
    const book = await hiddenPrinter(t);
    const before = await catalogState(t);
    for (const [field, value] of [
      ["isbn13", X],
      ["isbn10", X_10],
    ] as const) {
      await expect(
        proposal(t, [releaseUpdate(book.releaseId, field, value)]),
      ).rejects.toMatchObject({
        data: {
          code: "invalidField",
          message: expect.stringContaining(`belongs to hidden Release ${book.hidden}`),
        },
      });
    }
    expect((await catalogState(t)).releases).toEqual(before.releases);
  });

  it("lets a Release take its own printing's ISBN, which then still finds it and is not listed", async () => {
    const t = makeT();
    const book = await world(t);
    await t.run((ctx) => insertPrinting(ctx, book.releaseId, OLDER));
    await proposal(t, [releaseUpdate(book.releaseId, "isbn13", OLDER)]);
    expect(await rowsOf(t, book.releaseId)).toEqual([OLDER]);
    expect(await lookup(t, OLDER)).toMatchObject({ anchor: OLDER });
    const row = await t.query(api.catalogPages.editionPage, {
      publicId: (await t.run((ctx) => ctx.db.get(book.editionId)))!.publicId,
    });
    expect(row?.releases[0]).toMatchObject({ otherPrintings: [], morePrintings: false });
  });

  it("still swaps two primaries without rows, and refuses a swap onto a third Release's printing", async () => {
    const t = makeT();
    const book = await world(t);
    const other = await t.run((ctx) => another(ctx, book, { isbn13: Y }));
    await proposal(t, [
      releaseUpdate(book.releaseId, "isbn13", Y),
      releaseUpdate(other, "isbn13", CURRENT),
    ]);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(book.releaseId))?.isbn13).toBe(Y);
      expect((await ctx.db.get(other))?.isbn13).toBe(CURRENT);
      await insertPrinting(ctx, await another(ctx, book), X);
    });
    await expect(
      proposal(t, [releaseUpdate(book.releaseId, "isbn13", X), releaseUpdate(other, "isbn13", Y)]),
    ).rejects.toMatchObject({
      data: { message: expect.stringContaining(`ISBN ${X} belongs to Release`) },
    });
  });

  it("checks a queued Proposal again when it is approved", async () => {
    const t = makeT();
    const book = await world(t);
    const asAdmin = signedIn(t, alice);
    const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops: [releaseUpdate(book.releaseId, "isbn10", X_10)],
      evidence: [{ kind: "url", url: VIZ_URL }],
      comment: "Add the ISBN-10.",
    });
    await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
    // While it waits, X becomes a hidden Release's printing.
    await t.run(async (ctx) =>
      insertPrinting(ctx, await another(ctx, book, { status: "hidden" }), X),
    );
    await expect(
      signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({
      data: { message: expect.stringContaining(`ISBN ${X} belongs to hidden Release`) },
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(book.releaseId))?.isbn10 ?? null),
    ).toBeNull();
  });

  it("refuses a Proposal giving a Bundle a printing's ISBN", async () => {
    const t = makeT();
    const book = await hiddenPrinter(t);
    const box = await t.run((ctx) => insertBundle(ctx, { publisherId: book.publisherId }));
    for (const [field, value] of [
      ["isbn13", X],
      ["isbn10", X_10],
    ] as const) {
      await expect(
        proposal(t, [
          {
            kind: "update",
            ref: { type: "releaseBundle" as const, id: box },
            changes: [{ field, value }],
          },
        ]),
      ).rejects.toMatchObject({
        data: {
          code: "invalidField",
          message: expect.stringContaining(`ISBN ${X} belongs to hidden Release`),
        },
      });
    }
    expect(await t.run(async (ctx) => (await ctx.db.get(box))?.isbn13 ?? null)).toBeNull();
  });

  it("refuses repair edits and creations onto a hidden Release's printing", async () => {
    const t = makeT();
    const book = await hiddenPrinter(t);
    const run = (entries: RepairEntry[]) =>
      t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: alice.username });
    const [update, create] = await run([
      {
        kind: "updateFields",
        key: "assign",
        reason: "isbn",
        table: "releases",
        id: book.releaseId,
        changes: [{ field: "isbn10", before: null, after: X_10 }],
        evidenceObservationId: null,
      },
      {
        kind: "createRelease",
        key: "create",
        reason: "missing",
        isbn13: X,
        isbn10: null,
        format: "physical",
        binding: null,
        pubDate: null,
        price: null,
        publisherId: book.publisherId,
        coverage: [{ volumeId: book.volumeId, extent: "complete" }],
        line: null,
        sources: [],
      },
    ]);
    const owned = expect.stringContaining(`ISBN ${X} belongs to hidden Release ${book.hidden}`);
    expect(update).toMatchObject({ status: "skipped", reason: owned });
    expect(create).toMatchObject({ status: "skipped", reason: owned });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(book.releaseId))?.isbn10 ?? null),
    ).toBeNull();
  });

  it("refuses Restore when a Release's ISBN is another owner's now, by Moderator or repair", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => {
      // Hidden H's printing OLDER is also another hidden Release's printing;
      // hidden P's own Y is an active Release's own; hidden Q is free.
      const h = await another(ctx, book, { isbn13: W979, status: "hidden" });
      await insertPrinting(ctx, h, OLDER);
      await insertPrinting(ctx, await another(ctx, book, { status: "hidden" }), OLDER);
      const p = await another(ctx, book, { isbn13: Y, status: "hidden" });
      await another(ctx, book, { isbn13: Y });
      const q = await another(ctx, book, { isbn13: X, status: "hidden" });
      return { h, p, q };
    });
    const restore = (id: Id<"releases">) =>
      moderate(t, "restoreRecord", { type: "release", id }, "Restore it.");
    await expect(restore(ids.h)).rejects.toThrow(/ISBN 9781591160342 belongs to hidden Release/);
    await expect(restore(ids.p)).rejects.toThrow(
      /ISBN 9781569318546 now belongs to another active Release/,
    );
    const [repaired] = await t.mutation(internal.repair.runBatch, {
      entries: [
        {
          kind: "restoreRecord",
          key: "r",
          reason: "restore",
          target: { type: "release", id: ids.h },
          volumeIds: [],
          editionIds: [],
          releaseIds: [],
        },
      ],
      dryRun: false,
      actor: alice.username,
    });
    expect(repaired).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("belongs to hidden Release"),
    });
    await restore(ids.q);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(ids.h))?.status).toBe("hidden");
      expect((await ctx.db.get(ids.p))?.status).toBe("hidden");
      expect((await ctx.db.get(ids.q))?.status).toBe("active");
    });
  });

  it("refuses restoring a Bundle whose ISBN is a printing now", async () => {
    const t = makeT();
    const book = await world(t);
    const box = await t.run(async (ctx) => {
      await insertPrinting(ctx, book.releaseId, OLDER);
      return await insertBundle(ctx, {
        publisherId: book.publisherId,
        isbn10: OLDER_10,
        status: "hidden",
      });
    });
    await expect(
      moderate(t, "restoreRecord", { type: "releaseBundle", id: box }, "Restore it."),
    ).rejects.toThrow(/ISBN 9781591160342 is now another printing of a Release/);
  });

  it("refuses a merge whose Releases have more printings than it moves at once", async () => {
    const t = makeT();
    const book = await world(t);
    const loser = await t.run(async (ctx) => {
      const loser = await another(ctx, book, { isbn13: Y });
      for (let i = 0; i <= 100; i++) await insertPrinting(ctx, loser, X);
      return loser;
    });
    const before = await catalogState(t);
    await expect(
      mergeAs(t, { type: "release", id: book.releaseId }, { type: "release", id: loser }),
    ).rejects.toThrow(/more than 100 other printings/);
    expect(await catalogState(t)).toEqual(before);
  });
});

describe("imports never create over a printing claim", () => {
  it("holds an ANN line whose ISBN is a printing of a Release that no longer exists", async () => {
    const t = makeT();
    const book = await world(t);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    await t.run(async (ctx) => {
      const gone = await another(ctx, book);
      await insertPrinting(ctx, gone, OLDER);
      await ctx.db.delete(gone);
      await insertVolume(ctx, { seriesId: book.seriesId, label: "2", position: 2 });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:123",
        recordRef: { type: "series", id: book.seriesId },
        snapshot: { kind: "annManga", id: "123", title: "Vagabond" },
      });
      for (const [annId, isbn13] of [
        ["999", OLDER],
        ["998", X],
      ] as const) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${annId}`,
          snapshot: {
            kind: "annRelease",
            annId,
            mangaId: "123",
            title: "Vagabond",
            label: "2",
            multi: false,
            editionLineHint: false,
            format: "physical",
            url: "https://example.com/ann",
            isbn13,
          },
        });
      }
    });
    const before = await catalogState(t);
    const page = (isbn13: string) => ({
      status: "ok" as const,
      fetchedAt: 1,
      title: "Vagabond",
      volume: "GN 2",
      distributor: "VIZ Media",
      isbn13,
    });
    expect(
      await t.mutation(internal.ann.applyReleasePage, { annId: "999", page: page(OLDER) }),
    ).toMatchObject({
      status: "recordOnly",
      reason: expect.stringContaining("no longer exists"),
    });
    const after = await catalogState(t);
    expect(after.releases).toEqual(before.releases);
    expect(after.revisions).toBe(before.revisions);
    const record = after.observations.find((o) => o.sourceRecordId === "release:999")!;
    expect(await holdFor(t, record._id)).toMatchObject({ kind: "isbn", seriesId: book.seriesId });
    // The same line with a free ISBN is created as before.
    expect(
      await t.mutation(internal.ann.applyReleasePage, { annId: "998", page: page(X) }),
    ).toMatchObject({
      status: "created",
    });
  });

  it("records a conflict instead of reconciling an ISBN a hidden Release has as a printing", async () => {
    const t = makeT();
    const book = await world(t);
    const linked = await t.run(async (ctx) => {
      const hidden = await another(ctx, book, { status: "hidden" });
      await insertPrinting(ctx, hidden, OLDER);
      const release = await insertRelease(ctx, {
        editionId: book.editionId,
        publisherId: book.publisherId,
        seriesIds: [book.seriesId],
        format: "digital",
      });
      return await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL5M",
        recordRef: { type: "release", id: release },
        snapshot: {},
      });
    });
    const { isbnHeldElsewhere } = await import("./lib/pipeline");
    await t.run(async (ctx) => {
      const observation = (await ctx.db.get(linked))!;
      const release = (await ctx.db.get(observation.recordRef!.id as Id<"releases">))!;
      // Offered as an ISBN-13, or only as an ISBN-10 (Open Library, PRH and Yen Press offer both).
      for (const offered of [{ isbn13: OLDER }, { isbn10: OLDER_10 }]) {
        await ctx.db.patch(linked, { conflicts: undefined });
        expect(await isbnHeldElsewhere(ctx, observation, release, offered, 1)).toBe(true);
        expect((await ctx.db.get(linked))?.conflicts).toEqual([
          expect.objectContaining({
            field: "isbn13",
            offered: OLDER,
            reason: expect.stringContaining("belongs to hidden Release"),
          }),
        ]);
      }
      expect(
        await isbnHeldElsewhere(ctx, observation, release, { isbn13: X, isbn10: X_10 }, 1),
      ).toBe(false);
    });
  });
});

describe("an ordinary ISBN costs one empty read (C67-01)", () => {
  /** The seven metrics `run` used, from the installed `ctx.meta.getTransactionMetrics()`. */
  async function used<T>(
    ctx: MutationCtx,
    run: () => Promise<T>,
  ): Promise<{ result: T; metrics: Record<string, number> }> {
    const before = await ctx.meta.getTransactionMetrics();
    const result = await run();
    const after = await ctx.meta.getTransactionMetrics();
    const metrics = Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v.used - before[k as keyof typeof before].used]),
    );
    return { result, metrics };
  }
  const nothing = {
    bytesRead: 0,
    bytesWritten: 0,
    databaseQueries: 1,
    documentsRead: 0,
    documentsWritten: 0,
    functionsScheduled: 0,
    scheduledFunctionArgsBytes: 0,
  };

  it("reads one empty index range for a linked Release's own ISBN with no printing, in both forms", async () => {
    for (const large of [false, true]) {
      for (const unrelatedRow of [false, true]) {
        const t = makeT({ transactionLimits: true });
        const ids = await t.run(async (ctx) => {
          const book = await vagabond(ctx);
          await ctx.db.patch(book.releaseId, {
            isbn10: "1421519119",
            ...(large ? { description: "x".repeat(100_000) } : {}),
          });
          if (unrelatedRow) await insertPrinting(ctx, book.releaseId, OLDER);
          return { ...book, observationId: await heldRecord(ctx, book.seriesId, CURRENT) };
        });
        for (const offered of [
          { isbn13: CURRENT },
          { isbn13: CURRENT, isbn10: "1421519119" },
          { isbn10: "1-4215-1911-9" },
        ]) {
          await t.run(async (ctx) => {
            const release = (await ctx.db.get(ids.releaseId))!;
            const observation = (await ctx.db.get(ids.observationId))!;
            const { result, metrics } = await used(ctx, () =>
              isbnHeldElsewhere(ctx, observation, release, offered, 1),
            );
            expect(result).toBe(false);
            expect(metrics).toEqual(nothing);
          });
        }
      }
    }
  });

  it("still reads every claim once where a printing row exists, in either form, with the same outcomes", async () => {
    const cases: Array<
      [
        string,
        (ctx: MutationCtx, book: Awaited<ReturnType<typeof vagabond>>) => Promise<unknown>,
        boolean,
      ]
    > = [
      ["its own row", (ctx, b) => insertPrinting(ctx, b.releaseId, OLDER), false],
      [
        "another Release's row",
        async (ctx, b) => insertPrinting(ctx, await another(ctx, b), OLDER),
        true,
      ],
      [
        "a hidden Release's row",
        async (ctx, b) => insertPrinting(ctx, await another(ctx, b, { status: "hidden" }), OLDER),
        true,
      ],
      [
        "its own row and a Bundle",
        async (ctx, b) => {
          await insertPrinting(ctx, b.releaseId, OLDER);
          await insertBundle(ctx, { publisherId: b.publisherId, isbn10: OLDER_10 });
        },
        true,
      ],
      [
        "a row of a Release that is gone",
        async (ctx, b) => {
          const gone = await another(ctx, b);
          await insertPrinting(ctx, gone, OLDER);
          await ctx.db.delete(gone);
        },
        true,
      ],
      [
        "more rows than one read takes, all its own",
        async (ctx, b) => {
          for (let i = 0; i <= CLAIM_SCAN; i++) await insertPrinting(ctx, b.releaseId, OLDER);
        },
        true,
      ],
    ];
    for (const [, claims, blocked] of cases) {
      const t = makeT({ transactionLimits: true });
      const ids = await t.run(async (ctx) => {
        const book = await vagabond(ctx);
        await claims(ctx, book);
        return { ...book, observationId: await heldRecord(ctx, book.seriesId, OLDER) };
      });
      const queries: number[] = [];
      for (const offered of [
        { isbn13: OLDER },
        { isbn13: OLDER, isbn10: OLDER_10 },
        { isbn13: "978-1-59116-034-2", isbn10: "1-59116-034-0" },
      ]) {
        await t.run(async (ctx) => {
          await ctx.db.patch(ids.observationId, { conflicts: undefined });
          const release = (await ctx.db.get(ids.releaseId))!;
          const observation = (await ctx.db.get(ids.observationId))!;
          const { result, metrics } = await used(ctx, () =>
            isbnHeldElsewhere(ctx, observation, release, offered, 1),
          );
          expect(result).toBe(blocked);
          queries.push(metrics.databaseQueries!);
        });
      }
      // Equivalent forms are one ISBN, its claims read once.
      expect(new Set(queries).size).toBe(1);
    }
  });

  it("creates a Release with the same reads whichever forms its ISBN comes in", async () => {
    const reads: Array<Record<string, number>> = [];
    for (const both of [false, true]) {
      const t = makeT({ transactionLimits: true });
      const ids = await t.run(async (ctx) => {
        const book = await vagabond(ctx);
        return { ...book, observationId: await heldRecord(ctx, book.seriesId, OLDER) };
      });
      await t.run(async (ctx) => {
        const observation = (await ctx.db.get(ids.observationId))!;
        const { result, metrics } = await used(ctx, () =>
          createCanonicalRecords(ctx, {
            sourceKey: "prh",
            observation,
            seriesId: ids.seriesId,
            seriesTitle: "Vagabond",
            labels: ["2"],
            release: {
              format: "physical",
              isbn13: OLDER,
              ...(both ? { isbn10: OLDER_10 } : {}),
              publisher: { name: "VIZ Media", slug: "viz-media" },
            },
            citation: { sourceName: "PRH", url: "https://example.com/book" },
            importComment: "Fixture",
            tagBootstrapUnreviewed: false,
            now: 1,
          }),
        );
        expect(result.blocked).toBeUndefined();
        reads.push(metrics);
      });
    }
    expect(reads[0]!.databaseQueries).toBe(reads[1]!.databaseQueries);
    expect(reads[0]!.documentsRead).toBe(reads[1]!.documentsRead);
  });
});

describe("a repair stores an ISBN as its field's index finds it (C67-14)", () => {
  const update = (
    id: Id<"releases">,
    field: "isbn13" | "isbn10",
    before: string | null,
    after: string,
    key = `${field}-${after}`,
  ): RepairEntry => ({
    kind: "updateFields",
    key,
    reason: "Correct the ISBN.",
    table: "releases",
    id,
    changes: [{ field, before, after }],
    evidenceObservationId: null,
  });
  const run = (t: TestT, entries: RepairEntry[]) =>
    t.mutation(internal.repair.runBatch, { entries, dryRun: false, actor: alice.username });

  it("refuses a printing a repaired, hyphenated primary claims, and every pass of the check agrees", async () => {
    const t = makeT();
    const book = await world(t);
    const ids = await t.run(async (ctx) => ({
      owner: await another(ctx, book, { isbn13: X }),
      observationId: await heldRecord(ctx, book.seriesId, OLDER),
    }));
    const [repair] = await run(t, [update(ids.owner, "isbn13", X, "978-1-59116-034-2")]);
    expect(repair).toMatchObject({ status: "applied" });
    expect(await t.run(async (ctx) => (await ctx.db.get(ids.owner))?.isbn13)).toBe(OLDER);
    const revision = await t.run((ctx) =>
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", ids.owner))
        .order("desc")
        .first(),
    );
    expect(revision?.changes).toContainEqual({ field: "isbn13", before: X, after: OLDER });
    await refused(
      t,
      ids.observationId,
      book.releaseId,
      new RegExp(`is Release ${ids.owner}'s own|belongs to Release ${ids.owner}`),
    );
    for (const pass of ["rows", "observations", "releases", "bundles"] as const) {
      const page = await t.query(internal.printings.consistencyInternal, {
        pass,
        paginationOpts: { numItems: 100, cursor: null },
      });
      expect(page).toMatchObject({ findings: [], isDone: true });
    }
  });

  it("writes each spelling as its field stores it, and skips what is no ISBN of that kind", async () => {
    const t = makeT();
    const book = await world(t);
    const results = await run(t, [update(book.releaseId, "isbn10", null, "0-8044-2957-x")]);
    expect(results).toMatchObject([{ status: "applied" }]);
    expect(await t.run(async (ctx) => (await ctx.db.get(book.releaseId))?.isbn10)).toBe(
      "080442957X",
    );
    const other = await t.run((ctx) => another(ctx, book));
    for (const [field, after, stored] of [
      ["isbn13", " 1-59116-034-0 ", OLDER],
      ["isbn10", "9781591160342", OLDER_10],
    ] as const) {
      await t.run((ctx) => ctx.db.patch(other, { isbn13: undefined, isbn10: undefined }));
      expect(
        await run(t, [update(other, field, null, after, `${field}-to-${stored}`)]),
      ).toMatchObject([{ status: "applied" }]);
      expect(await t.run(async (ctx) => (await ctx.db.get(other))?.[field])).toBe(stored);
    }
    for (const [field, after] of [
      ["isbn10", W979],
      ["isbn13", "ISBN 978"],
    ] as const) {
      expect(await run(t, [update(other, field, null, after, `bad-${field}`)])).toMatchObject([
        { status: "skipped", reason: expect.stringContaining(`"${after}" is not an`) },
      ]);
    }
  });

  it("creates a Release whose 979 ISBN, hyphenated, is stored whole with no ISBN-10", async () => {
    const t = makeT();
    const book = await world(t);
    const create: RepairEntry = {
      kind: "createRelease",
      key: "create-979",
      reason: "missing",
      isbn13: "979-8-8887-7258-4",
      isbn10: null,
      format: "physical",
      binding: null,
      pubDate: null,
      price: null,
      publisherId: book.publisherId,
      coverage: [{ volumeId: book.volumeId, extent: "complete" }],
      line: null,
      sources: [],
    };
    expect(await run(t, [create])).toMatchObject([{ status: "applied" }]);
    const made = await t.run((ctx) =>
      ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", W979))
        .unique(),
    );
    expect(made).toMatchObject({ isbn13: W979 });
    expect(made?.isbn10).toBeUndefined();
    // Run again, it finds what it made; another entry for that ISBN, spelled any way, is refused.
    expect(await run(t, [create])).toMatchObject([{ status: "alreadyApplied" }]);
    expect(await run(t, [{ ...create, key: "again", isbn13: W979 }])).toMatchObject([
      { status: "skipped", reason: expect.stringContaining("already exists") },
    ]);
  });

  it("still takes Proposal ISBNs in any spacing, and a Release its own printing's (control)", async () => {
    const t = makeT();
    const book = await world(t);
    await t.run((ctx) => insertPrinting(ctx, book.releaseId, OLDER));
    const asAdmin = signedIn(t, alice);
    const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: { type: "release", id: book.releaseId },
          changes: [
            { field: "isbn13", value: "978 1 59116 034 2" },
            { field: "isbn10", value: "1-59116-034-0" },
          ],
        },
      ],
      evidence: [{ kind: "url", url: VIZ_URL }],
      comment: "Its own printing's ISBN.",
    });
    await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
    await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });
    expect(await t.run((ctx) => ctx.db.get(book.releaseId))).toMatchObject({
      isbn13: OLDER,
      isbn10: OLDER_10,
    });
    expect(await lookup(t, OLDER_10)).toMatchObject({ anchor: OLDER });
  });
});
