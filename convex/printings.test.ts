// Other Printings (CONTEXT.md, printings.ts, lib/releaseIsbns.ts): an older
// or later printing's ISBN finds its Release on /isbn, on the Edition page
// and on the importers' ISBN lookups, and a record of it links marked as
// that printing's and never writes the Release's own fields; hiding the
// Release hides its printings; a merge carries them to a physical survivor
// and Split brings them back unless another owner now holds the ISBN;
// a printing's withdrawal queues no cancellation review; every ISBN
// spelling reads as its ISBN-13 and a Release's ISBN-10 counts as its own;
// and a decided printing is recorded only when the invariants hold, once,
// citing a usable URL, with a refusal writing nothing.

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { matchRelease } from "./lib/matching";
import { holdOf, linkObservation, recordUnplaced } from "./lib/observations";
import { linkRecordedPrinting, recordPrinting } from "./lib/printings";
import { reconcileFields } from "./lib/reconcile";
import {
  observedIsbn13,
  primaryIsbnsOf,
  printingIsbnOf,
  printingReleases,
} from "./lib/releaseIsbns";
import { impactOf } from "./lib/sensitiveOps";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";
import { hideRecord, mergeAs, splitAs } from "./test.moderation";

// VIZ's Vagabond vol 1: the 2007 printing is the Release, the 2002 one
// another printing of it.
const CURRENT = "9781421519111";
const OLDER = "9781591160342";
const OLDER_10 = "1591160340";

const year = (y: number, month?: number) => ({
  year: y,
  ...(month !== undefined ? { month } : {}),
  sort: y * 10000 + (month ?? 0) * 100,
});

/** VIZ, the Series "Vagabond" (88), its Volume 1, and Edition 880 with the 2007 Release. */
async function vagabond(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
  const seriesId = await insertSeries(ctx, { publicId: 88, title: "Vagabond" });
  const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
  const editionId = await insertEdition(ctx, { publicId: 880, publisherId });
  await insertCoverage(ctx, { editionId, volumeId });
  const releaseId = await insertRelease(ctx, {
    editionId,
    publisherId,
    seriesIds: [seriesId],
    isbn13: CURRENT,
    pubDate: year(2007, 7),
  });
  return { publisherId, seriesId, volumeId, editionId, releaseId };
}

/** An ANN release line's snapshot, its page read, as the page pass stores it. */
function annLine(
  annId: string,
  title: string,
  label: string,
  isbn13: string,
  y: number,
  fields: {
    distributor?: string;
    format?: "physical" | "digital";
    mangaId?: string;
    volume?: string;
  } = {},
) {
  return {
    kind: "annRelease",
    annId,
    mangaId: fields.mangaId ?? "88",
    url: `https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${annId}`,
    title,
    label,
    multi: false,
    format: fields.format ?? "physical",
    editionLineHint: false,
    isbn13,
    date: { year: y, month: 6 },
    page: {
      status: "ok",
      fetchedAt: 1,
      distributor: fields.distributor ?? "VIZ Media",
      ...(fields.volume !== undefined ? { volume: fields.volume } : {}),
      isbn13,
      date: { year: y, month: 6, day: 5 },
    },
  };
}

/** Record `isbn13` as another printing of `releaseId`, as recordPrinting leaves it. */
async function insertPrinting(
  ctx: MutationCtx,
  releaseId: Id<"releases">,
  isbn13: string,
  fields: Partial<Doc<"releaseIsbns">> = {},
) {
  return await ctx.db.insert("releaseIsbns", {
    releaseId,
    isbn13,
    reason: "Another printing: published 2002, the Release 2007.",
    sourceKey: "ann",
    ...fields,
  });
}

const lookup = (t: TestT, isbn: string) => t.query(api.catalogPages.isbnLookup, { isbn });

describe("lookups by another printing's ISBN", () => {
  it("lands /isbn on the Release's own row, by ISBN-13 or ISBN-10 (read as its ISBN-13)", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER, { pubDate: year(2002) });
    });
    const target = { kind: "release", edition: { publicId: 880 }, anchor: CURRENT };
    expect(await lookup(t, OLDER)).toMatchObject(target);
    expect(await lookup(t, OLDER_10)).toMatchObject(target);
    expect(await lookup(t, CURRENT)).toMatchObject(target);
    expect(await lookup(t, "9781591160359")).toBeNull();
  });

  it("lists the other printings on the Release's row, oldest first, never its own ISBN", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, "9781569318546", { pubDate: year(2003) });
      await insertPrinting(ctx, releaseId, OLDER, { pubDate: year(2002) });
      await insertPrinting(ctx, releaseId, "9781974700011");
      // A row a correction made the Release's own ISBN is not "also" printed.
      await insertPrinting(ctx, releaseId, CURRENT, { pubDate: year(2007) });
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 880 });
    expect(page?.releases[0]?.otherPrintings).toEqual([
      { isbn13: OLDER, year: 2002 },
      { isbn13: "9781569318546", year: 2003 },
      { isbn13: "9781974700011", year: null },
    ]);
  });

  it("finds nothing once the Release is hidden", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    const releaseId = await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER);
      return releaseId;
    });
    await hideRecord(t, { type: "release", id: releaseId });
    expect(await lookup(t, OLDER)).toBeNull();
    // The importers treat it as the hidden Release's ISBN, never a new book.
    await t.run(async (ctx) => {
      const match = await matchRelease(ctx, {
        seriesTitle: "Vagabond",
        volumeLabel: "1",
        multiVolume: false,
        format: "physical",
        isbn13: OLDER,
        publisherId: null,
      });
      expect(match).toMatchObject({ kind: "review", rung: 2 });
    });
  });

  it("links on the ladder's ISBN rung, and the record offers the Release nothing", async () => {
    const t = makeT();
    await seedRegistry(t);
    const releaseId = await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER);
      return releaseId;
    });
    await t.run(async (ctx) => {
      const match = await matchRelease(ctx, {
        seriesTitle: "Vagabond",
        volumeLabel: "1",
        multiVolume: false,
        format: "physical",
        isbn13: OLDER,
        publisherId: null,
      });
      expect(match).toMatchObject({ kind: "match", rung: 2, release: { _id: releaseId } });

      const observationId = await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL1M",
        snapshot: { title: "Vagabond, Vol. 1", isbn13: OLDER },
      });
      await linkObservation(ctx, observationId, { type: "release", id: releaseId });
      const release = (await ctx.db.get(releaseId))!;
      const result = await reconcileFields(ctx, {
        sourceKey: "openlibrary",
        ref: { type: "release", id: releaseId },
        doc: release,
        offered: {
          isbn13: OLDER,
          pubDate: year(2002),
          binding: "paperback",
          description: "The 2002 printing's blurb.",
        },
        observation: (await ctx.db.get(observationId))!,
        citation: { sourceName: "OpenLibrary", url: "https://openlibrary.org/books/OL1M" },
        now: Date.now(),
      });
      expect(result).toEqual({ changed: false, applied: [], queued: [] });
      expect(await ctx.db.get(releaseId)).toEqual(release);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
    });
  });
});

describe("a printing's withdrawal", () => {
  it("queues no cancellation review of a future-dated Release", async () => {
    const t = makeT();
    await seedRegistry(t);
    await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await ctx.db.patch(releaseId, { pubDate: year(2099, 1) });
      await insertPrinting(ctx, releaseId, OLDER);
      for (const [id, isbn13] of [
        ["vagabond-1-2002", OLDER],
        ["vagabond-1", CURRENT],
      ] as const) {
        const observationId = await insertObservation(ctx, {
          sourceKey: "sevenseas",
          sourceRecordId: id,
          snapshot: { title: "Vagabond", isbn13 },
        });
        await linkObservation(ctx, observationId, { type: "release", id: releaseId });
      }
    });
    // Only the Release's own printing's record speaks for it.
    expect(
      await t.mutation(internal.imports.markWithdrawn, {
        sourceKey: "sevenseas",
        notSeenSince: Date.now() + 1,
      }),
    ).toEqual({ marked: 2, reviewsQueued: 1 });
  });
});

describe("a record linked as another printing", () => {
  it("is marked, and offers the Release nothing after its snapshot drops the ISBN", async () => {
    const t = makeT();
    await seedRegistry(t);
    const releaseId = await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER);
      return releaseId;
    });
    const edition = {
      kind: "olEdition" as const,
      key: "/books/OL1M",
      url: "https://openlibrary.org/books/OL1M",
      title: "Vagabond, Vol. 1",
      seriesTitle: "Vagabond",
      volumeLabel: "1",
      multiVolume: false,
      publishers: ["VIZ Media LLC"],
      publishDate: { year: 2002 },
      format: "physical" as const,
    };
    // The ladder links the edition through the printing's ISBN.
    await t.mutation(internal.openLibrary.applyEdition, {
      snapshot: { ...edition, isbn13: OLDER },
    });
    const before = await t.run(async (ctx) => {
      const record = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "/books/OL1M",
      )!;
      expect(record).toMatchObject({
        recordRef: { type: "release", id: releaseId },
        printingIsbn13: OLDER,
      });
      return await ctx.db.get(releaseId);
    });
    // Open Library loses the ISBN and gains a blurb: still that printing's.
    await t.mutation(internal.openLibrary.applyEdition, {
      snapshot: { ...edition, description: "The 2002 printing's blurb.", binding: "paperback" },
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(releaseId)).toEqual(before);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
    });
  });

  it("is how ANN's page pass links a line of the printing, changing nothing", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, before } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER);
      // ANN's manga entry, linked to the Series, as the mirror leaves it.
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:88",
        recordRef: { type: "series", id: seriesId },
        snapshot: { releases: [] },
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:5000",
        snapshot: annLine("5000", "Vagabond", "1", OLDER, 2002),
      });
      return { releaseId, before: await ctx.db.get(releaseId) };
    });
    expect(await t.mutation(internal.ann.applyReleasePage, { annId: "5000" })).toMatchObject({
      status: "linked",
      releaseId,
    });
    await t.run(async (ctx) => {
      const line = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "release:5000",
      );
      expect(line).toMatchObject({
        recordRef: { type: "release", id: releaseId },
        printingIsbn13: OLDER,
      });
      expect(await ctx.db.get(releaseId)).toEqual(before);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
    });
  });
});

describe("merge and Split", () => {
  /** Two Releases of Vagabond vol 1 a merge folds together: the survivor, and a duplicate. */
  async function duplicates(t: TestT) {
    await seedTeam(t, [alice, bob]);
    return await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const editionId = await insertEdition(ctx, { publicId: 881, publisherId: book.publisherId });
      await insertCoverage(ctx, { editionId, volumeId: book.volumeId });
      const loserId = await insertRelease(ctx, {
        editionId,
        publisherId: book.publisherId,
        seriesIds: [book.seriesId],
        isbn13: "9781421599990",
        pubDate: year(2007),
      });
      await insertPrinting(ctx, loserId, OLDER, { pubDate: year(2002) });
      // The survivor's own ISBN, recorded on the duplicate: the survivor's stays.
      await insertPrinting(ctx, loserId, CURRENT);
      return { ...book, loserId };
    });
  }

  const printingsOf = (t: TestT, releaseId: Id<"releases">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("releaseIsbns")
          .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
          .collect()
      )
        .map((row) => row.isbn13)
        .sort(),
    );

  it("carries a Release's printings to the survivor and Split brings them back", async () => {
    const t = makeT();
    const { releaseId, loserId } = await duplicates(t);
    await mergeAs(t, { type: "release", id: releaseId }, { type: "release", id: loserId });
    expect(await printingsOf(t, releaseId)).toEqual([OLDER]);
    expect(await printingsOf(t, loserId)).toEqual([]);
    expect(await lookup(t, OLDER)).toMatchObject({ anchor: CURRENT, edition: { publicId: 880 } });

    await splitAs(t, { type: "release", id: loserId });
    expect(await printingsOf(t, releaseId)).toEqual([]);
    // CURRENT remains the survivor's own ISBN, so Split cannot restore that duplicate row.
    expect(await printingsOf(t, loserId)).toEqual([OLDER]);
    expect(await lookup(t, OLDER)).toMatchObject({
      anchor: "9781421599990",
      edition: { publicId: 881 },
    });
  });

  it.each(["isbn13", "isbn10"] as const)(
    "keeps a moved printing on the survivor after a Proposal makes it the survivor's own %s",
    async (field) => {
      const t = makeT();
      const { releaseId, loserId } = await duplicates(t);
      await mergeAs(t, { type: "release", id: releaseId }, { type: "release", id: loserId });
      const asAdmin = signedIn(t, alice);
      const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "update",
            ref: { type: "release", id: releaseId },
            changes: [{ field, value: field === "isbn13" ? OLDER : OLDER_10 }],
          },
        ],
        evidence: [{ kind: "url", url: "https://www.viz.com/vagabond" }],
        comment: "Use the earlier printing's ISBN as the Release's own.",
      });
      await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
      await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });

      await splitAs(t, { type: "release", id: loserId });
      expect(await printingsOf(t, releaseId)).toEqual([OLDER]);
      expect(await printingsOf(t, loserId)).toEqual(field === "isbn13" ? [CURRENT] : []);
      await t.run(async (ctx) => {
        expect(await ctx.db.get(loserId)).toMatchObject({ status: "active" });
        const owners = new Set(
          (await ctx.db.query("releases").collect())
            .filter((r) => r.status === "active" && (r.isbn13 === OLDER || r.isbn10 === OLDER_10))
            .map((r) => r._id),
        );
        for (const row of await ctx.db.query("releaseIsbns").collect()) {
          if (row.isbn13 === OLDER) owners.add(row.releaseId);
        }
        expect([...owners]).toEqual([releaseId]);
      });
      for (const isbn of [OLDER, OLDER_10]) {
        expect(await lookup(t, isbn)).toMatchObject({
          edition: { publicId: 880 },
          anchor: field === "isbn13" ? OLDER : CURRENT,
        });
      }
    },
  );

  it("does not reinsert a removed printing while the survivor still owns that printing", async () => {
    const t = makeT();
    const { releaseId, loserId } = await duplicates(t);
    await t.run((ctx) => insertPrinting(ctx, releaseId, OLDER));
    await mergeAs(t, { type: "release", id: releaseId }, { type: "release", id: loserId });
    await splitAs(t, { type: "release", id: loserId });
    expect(await printingsOf(t, releaseId)).toEqual([OLDER]);
    expect(await printingsOf(t, loserId)).toEqual([]);
    expect(await lookup(t, OLDER)).toMatchObject({ edition: { publicId: 880 } });
  });

  it("keeps a moved printing the survivor has only as its own ISBN-10, so its ISBN-13 still finds it", async () => {
    const t = makeT();
    const { releaseId, loserId } = await duplicates(t);
    await t.run((ctx) => ctx.db.patch(releaseId, { isbn13: undefined, isbn10: OLDER_10 }));
    await mergeAs(t, { type: "release", id: releaseId }, { type: "release", id: loserId });
    expect(await printingsOf(t, releaseId)).toEqual([CURRENT, OLDER]);
    // The Release lookup reads an ISBN-13 against `isbn13` only, so the row is the way there.
    expect(await lookup(t, OLDER)).toMatchObject({ edition: { publicId: 880 } });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 880 });
    expect(page?.releases[0]?.otherPrintings).toEqual([{ isbn13: CURRENT, year: null }]);
  });

  it("counts them in the merge's impact preview", async () => {
    const t = makeT();
    const { loserId } = await duplicates(t);
    const impact = await t.run((ctx) => impactOf(ctx, { type: "release", id: loserId }));
    expect(impact).toContainEqual({
      label: "Other printings (ISBNs that also find it; they follow it on a merge)",
      count: 2,
    });
  });

  it("moves them only to a physical survivor, and the merge form says why", async () => {
    const t = makeT();
    const { releaseId, loserId } = await duplicates(t);
    const form = () =>
      signedIn(t, bob).query(api.sensitiveOps.manageForm, {
        type: "release",
        key: releaseId,
        mergeFrom: { type: "release", id: loserId },
      });
    expect((await form())?.mergeRefusal).toBeNull();
    await t.run((ctx) => ctx.db.patch(releaseId, { format: "digital" }));
    const refusal = /only a physical Release has other printings/;
    expect((await form())?.mergeRefusal).toMatch(refusal);
    await expect(
      mergeAs(t, { type: "release", id: releaseId }, { type: "release", id: loserId }),
    ).rejects.toThrow(refusal);
    expect(await printingsOf(t, loserId)).toEqual([CURRENT, OLDER]);
  });

  it("keeps them on their Release when its Edition merges", async () => {
    const t = makeT();
    const { editionId, loserId } = await duplicates(t);
    const loserEdition = await t.run(async (ctx) => (await ctx.db.get(loserId))!.editionId);
    await mergeAs(t, { type: "edition", id: editionId }, { type: "edition", id: loserEdition });
    expect(await printingsOf(t, loserId)).toEqual([CURRENT, OLDER]);
    expect(await lookup(t, OLDER)).toMatchObject({
      anchor: "9781421599990",
      edition: { publicId: 880 },
    });
  });
});

describe("a Release's format in ordinary Proposals", () => {
  it("refuses format edits both when drafting and when approving stored changes", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    const { releaseId, before } = await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await insertPrinting(ctx, releaseId, OLDER);
      return { releaseId, before: await ctx.db.get(releaseId) };
    });
    const asAdmin = signedIn(t, alice);
    const edit = (field: string, value: string) => ({
      kind: "update" as const,
      ref: { type: "release" as const, id: releaseId },
      changes: [{ field, value }],
    });
    const evidence = [{ kind: "url" as const, url: "https://www.viz.com/vagabond" }];
    await expect(
      asAdmin.mutation(api.proposals.saveDraft, {
        ops: [edit("format", "digital")],
        evidence,
        comment: "Correct the format.",
      }),
    ).rejects.toMatchObject({
      data: { code: "unknownField", message: '"format" is not an editable field of a release.' },
    });

    const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops: [edit("language", "ja")],
      evidence,
      comment: "Correct the language.",
    });
    await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
    // Even a legacy or malformed stored version must pass the current whitelist on approval.
    await t.run(async (ctx) => {
      const version = (await ctx.db.query("proposalVersions").collect())[0]!;
      await ctx.db.patch(version._id, {
        ops: [
          {
            kind: "update",
            ref: { type: "release", id: releaseId },
            changes: [{ field: "format", before: "physical", after: "digital" }],
          },
        ],
      });
    });
    await expect(
      signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({
      data: { code: "unknownField", message: '"format" is not an editable field of a release.' },
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(releaseId)).toEqual(before);
      expect(await ctx.db.get(proposalId)).toMatchObject({ state: "inReview" });
      expect(await ctx.db.query("revisions").collect()).toEqual([]);
    });
    expect(await lookup(t, OLDER)).toMatchObject({ anchor: CURRENT });
  });
});

describe("printings.recordDecidedInternal", () => {
  /**
   * ANN's line of a Vagabond vol 1 printing, held for the Release's slot
   * under `seriesId` as the page pass holds it (under no Series for null).
   */
  async function holdLine(
    ctx: MutationCtx,
    seriesId: Id<"series"> | null,
    annId: string,
    isbn13: string,
    fields: Parameters<typeof annLine>[5] = {},
  ) {
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${annId}`,
      snapshot: annLine(annId, "Vagabond", "1", isbn13, 2002, { volume: "GN 1", ...fields }),
    });
    await recordUnplaced(
      ctx,
      (await ctx.db.get(observationId))!,
      {
        kind: "isbn",
        reason: "Volume 1 already has a physical VIZ Media Release.",
        ...(seriesId !== null ? { seriesId } : {}),
      },
      Date.now(),
    );
    return observationId;
  }

  const decide = (
    t: TestT,
    observationId: Id<"sourceObservations">,
    releaseId: Id<"releases">,
    reason = "VIZ's 2002 first printing of Vagabond vol 1; same contents as the 2007 printing.",
  ) =>
    t.mutation(internal.printings.recordDecidedInternal, {
      observationId,
      releaseId,
      reason,
      evidenceUrl: "https://www.viz.com/vagabond",
    });

  it("records a held book through the shared write", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, observationId, before } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await vagabond(ctx);
      // Held under a duplicate Series since merged into Vagabond.
      const duplicate = await insertSeries(ctx, {
        title: "Vagabond (VIZBIG)",
        status: "merged",
        mergedIntoId: seriesId,
      });
      const observationId = await holdLine(ctx, duplicate, "5001", OLDER);
      return { releaseId, observationId, before: await ctx.db.get(releaseId) };
    });

    expect(await decide(t, observationId, releaseId)).toEqual({
      status: "recorded",
      isbn13: OLDER,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseIsbns").collect()).toEqual([
        expect.objectContaining({
          releaseId,
          isbn13: OLDER,
          pubDate: { year: 2002, month: 6, day: 5, sort: 20020605 },
          reason:
            "VIZ's 2002 first printing of Vagabond vol 1; same contents as the 2007 printing.",
          sourceKey: "ann",
          observationId,
        }),
      ]);
      expect(await ctx.db.get(observationId)).toMatchObject({
        recordRef: { type: "release", id: releaseId },
        printingIsbn13: OLDER,
      });
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect(await ctx.db.get(releaseId)).toEqual(before);
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
        .collect();
      expect(revisions).toEqual([
        expect.objectContaining({
          changes: [{ field: "otherPrinting", after: `ISBN ${OLDER}, 2002` }],
          comment: expect.stringContaining("same contents as the 2007 printing"),
          citation: {
            sourceName: expect.stringContaining("(decided by review)"),
            url: "https://www.viz.com/vagabond",
          },
        }),
      ]);
      const proposal = await ctx.db.get(revisions[0]!.proposalId);
      expect(proposal?.state).toBe("approved");
    });
    expect(await lookup(t, OLDER)).toMatchObject({ anchor: CURRENT });
  });

  it("refuses, without throwing, whatever would break an invariant", async () => {
    const t = makeT();
    await seedRegistry(t);
    const ids = await t.run(async (ctx) => {
      const { releaseId, seriesId, publisherId, volumeId } = await vagabond(ctx);
      const another = async (fields: Partial<Doc<"releases">>) => {
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        return await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          ...fields,
        });
      };
      const withdrawn = await holdLine(ctx, seriesId, "6001", "9781569318546");
      await ctx.db.patch(withdrawn, { withdrawn: true });
      const linked = await holdLine(ctx, seriesId, "6002", "9781591160359");
      await linkObservation(ctx, linked, { type: "release", id: releaseId });
      const badIsbn = await holdLine(ctx, seriesId, "6003", "9781591160343");
      const ownIsbn = await holdLine(ctx, seriesId, "6004", CURRENT);
      // An ISBN-10-only Release holds 9781591160496's ISBN-10.
      await another({ isbn10: "1591160499" });
      const tenHeld = await holdLine(ctx, seriesId, "6005", "9781591160496");
      const printed = await holdLine(ctx, seriesId, "6006", "9781421506555");
      await insertPrinting(ctx, await another({ isbn13: "9781421599990" }), "9781421506555");
      // The book's own record calls it an ebook, by format or designator.
      const ebook = await holdLine(ctx, seriesId, "6007", "9781421599953", { format: "digital" });
      const ebookLabel = await holdLine(ctx, seriesId, "6008", "9781421599946", {
        volume: "eBook 1",
      });
      // Held under no Series, or under another one (Dragon Ball's slot).
      const unplaced = await holdLine(ctx, null, "6009", "9781421599939");
      const dragonBall = await insertSeries(ctx, { title: "Dragon Ball" });
      const otherSeries = await holdLine(ctx, dragonBall, "6010", "9781421599922");
      // Dark Horse's book, and a distributor no publisher row answers.
      await insertPublisher(ctx, { name: "Dark Horse Comics", slug: "dark-horse" });
      const otherPublisher = await holdLine(ctx, seriesId, "6011", "9781421599915", {
        distributor: "Dark Horse Comics",
      });
      const unknownPublisher = await holdLine(ctx, seriesId, "6012", "9781421599908", {
        distributor: "Nobody Press",
      });
      const fine = await holdLine(ctx, seriesId, OLDER, OLDER);
      const hidden = await another({ isbn13: "9781421599983", status: "hidden" });
      const digital = await another({ isbn13: "9781421599976", format: "digital" });
      const locked = await another({ isbn13: "9781421599969", locked: true });
      return {
        releaseId,
        withdrawn,
        linked,
        badIsbn,
        ownIsbn,
        tenHeld,
        printed,
        ebook,
        ebookLabel,
        unplaced,
        otherSeries,
        otherPublisher,
        unknownPublisher,
        fine,
        hidden,
        digital,
        locked,
      };
    });
    const refused = async (
      observationId: Id<"sourceObservations">,
      releaseId: Id<"releases">,
      reason?: string,
    ) => {
      const result = await decide(t, observationId, releaseId, reason);
      expect(result.status).toBe("refused");
      return result.status === "refused" ? result.reason : "";
    };
    expect(await refused(ids.fine, ids.releaseId, " ")).toBe("A decided printing needs a reason.");
    expect(await refused(ids.withdrawn, ids.releaseId)).toBe(
      "Its source no longer lists the book.",
    );
    expect(await refused(ids.linked, ids.releaseId)).toBe(
      "The book's record is already linked to a record.",
    );
    expect(await refused(ids.badIsbn, ids.releaseId)).toBe(
      "The record gives an invalid ISBN (9781591160343).",
    );
    expect(await refused(ids.ownIsbn, ids.releaseId)).toBe(
      `ISBN ${CURRENT} is the Release's own: a record of its own printing is linked to it, not recorded as another printing.`,
    );
    expect(await refused(ids.tenHeld, ids.releaseId)).toMatch(
      /^ISBN 9781591160496 belongs to Release \S+ \(Release \S+'s isbn10\)\.$/,
    );
    expect(await refused(ids.printed, ids.releaseId)).toMatch(
      /^ISBN 9781421506555 belongs to Release \S+ \(a printing row of Release \S+\)\.$/,
    );
    for (const ebook of [ids.ebook, ids.ebookLabel]) {
      expect(await refused(ebook, ids.releaseId)).toBe("The record calls the book digital.");
    }
    expect(await refused(ids.unplaced, ids.releaseId)).toBe("The book is not held under a Series.");
    expect(await refused(ids.otherSeries, ids.releaseId)).toBe(
      `The book is held under "Dragon Ball", which is not the Release's Series.`,
    );
    expect(await refused(ids.otherPublisher, ids.releaseId)).toBe(
      "The record's publisher is Dark Horse Comics; the Release's is VIZ Media.",
    );
    expect(await refused(ids.unknownPublisher, ids.releaseId)).toBe(
      "The record's publisher (Nobody Press) resolves to no publisher row.",
    );
    expect(await refused(ids.fine, ids.hidden)).toBe("The Release is hidden.");
    expect(await refused(ids.fine, ids.digital)).toBe("The Release is not physical.");
    expect(await refused(ids.fine, ids.locked)).toBe("The Release is locked.");
    await t.run(async (ctx) => {
      expect((await ctx.db.query("releaseIsbns").collect()).map((row) => row.isbn13)).toEqual([
        "9781421506555",
      ]);
      expect(await ctx.db.query("revisions").collect()).toEqual([]);
    });
    // The same book, once nothing stands in the way, records.
    expect(await decide(t, ids.fine, ids.releaseId)).toMatchObject({ status: "recorded" });
  });

  /** Everything a refused decision must leave as it was. */
  const writes = (t: TestT, observationId: Id<"sourceObservations">) =>
    t.run(async (ctx) => ({
      rows: (await ctx.db.query("releaseIsbns").collect()).map((row) => row.isbn13),
      proposals: (await ctx.db.query("proposals").collect()).length,
      revisions: (await ctx.db.query("revisions").collect()).length,
      observation: await ctx.db.get(observationId),
      hold: await holdOf(ctx, observationId),
    }));

  it("refuses the Release's own ISBN, as its ISBN-13 or ISBN-10, before a retained row", async () => {
    const t = makeT();
    await seedRegistry(t);
    const ids = await t.run(async (ctx) => {
      const { releaseId, seriesId, publisherId, volumeId } = await vagabond(ctx);
      // A row from before a correction made CURRENT the Release's own.
      await insertPrinting(ctx, releaseId, CURRENT);
      const editionId = await insertEdition(ctx, { publicId: 882, publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const tenOnly = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn10: "1591160499",
      });
      const openLibrary = async (id: string, isbns: object) => {
        const observationId = await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: id,
          snapshot: {
            url: `https://openlibrary.org${id}`,
            title: "Vagabond, Vol. 1",
            publishers: ["VIZ Media"],
            ...isbns,
          },
        });
        await recordUnplaced(
          ctx,
          (await ctx.db.get(observationId))!,
          { kind: "isbn", reason: "Volume 1 is taken.", seriesId },
          Date.now(),
        );
        return observationId;
      };
      return {
        releaseId,
        tenOnly,
        own13: await holdLine(ctx, seriesId, "7001", CURRENT),
        own10: await openLibrary("/books/OL7M", { isbn10: "1-42151-911-9" }),
        tenOnly13: await holdLine(ctx, seriesId, "7002", "9781591160496"),
        tenOnly10: await openLibrary("/books/OL8M", { isbn10: "1 59116 049 9" }),
      };
    });
    const own = (isbn13: string) =>
      `ISBN ${isbn13} is the Release's own: a record of its own printing is linked to it, not recorded as another printing.`;
    for (const [observationId, releaseId, isbn13] of [
      [ids.own13, ids.releaseId, CURRENT],
      [ids.own10, ids.releaseId, CURRENT],
      [ids.tenOnly13, ids.tenOnly, "9781591160496"],
      [ids.tenOnly10, ids.tenOnly, "9781591160496"],
    ] as const) {
      const before = await writes(t, observationId);
      expect(before.hold).not.toBeNull();
      expect(await decide(t, observationId, releaseId)).toEqual({
        status: "refused",
        reason: own(isbn13),
      });
      expect(await writes(t, observationId)).toEqual(before);
    }
  });

  it("links a further record of a recorded printing, with an audit of its own", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, first, second, hyphenated } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await vagabond(ctx);
      return {
        releaseId,
        first: await holdLine(ctx, seriesId, "5001", OLDER),
        second: await holdLine(ctx, seriesId, "5002", OLDER),
        hyphenated: await holdLine(ctx, seriesId, "5003", "978-1-59116-034-2"),
      };
    });
    expect(await decide(t, first, releaseId)).toEqual({ status: "recorded", isbn13: OLDER });
    const before = await t.run((ctx) => ctx.db.get(releaseId));
    for (const [n, observationId, annId] of [
      [2, second, "5002"],
      [3, hyphenated, "5003"],
    ] as const) {
      const result = await decide(
        t,
        observationId,
        releaseId,
        `Record ${annId} is the 2002 printing.`,
      );
      expect(result).toMatchObject({ status: "linked", isbn13: OLDER, releaseId });
      const after = await writes(t, observationId);
      // No second row; the record is linked and marked, its hold gone, and
      // the decision has its own approved Proposal and Revision.
      expect(after).toMatchObject({ rows: [OLDER], proposals: n, revisions: n, hold: null });
      expect(after.observation).toMatchObject({
        recordRef: { type: "release", id: releaseId },
        printingIsbn13: OLDER,
      });
      await t.run(async (ctx) => {
        const revision = await ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
          .order("desc")
          .first();
        expect(revision).toMatchObject({
          seq: n,
          changes: [
            {
              field: "sourceObservation",
              after: `ann release:${annId} — a record of Other Printing ISBN ${OLDER}`,
            },
          ],
          comment: expect.stringContaining(`Record ${annId} is the 2002 printing.`),
          citation: { url: "https://www.viz.com/vagabond" },
        });
        expect(
          result.status === "linked" ? (await ctx.db.get(result.proposalId))?.state : null,
        ).toBe("approved");
        // A later sync of the record offers the Release nothing.
        await reconcileFields(ctx, {
          sourceKey: "ann",
          ref: { type: "release", id: releaseId },
          doc: (await ctx.db.get(releaseId))!,
          offered: { isbn13: OLDER, pubDate: year(2002, 6) },
          observation: (await ctx.db.get(observationId))!,
          citation: { sourceName: "ANN", url: "https://www.animenewsnetwork.com" },
          now: Date.now(),
        });
      });
    }
    expect(await t.run((ctx) => ctx.db.get(releaseId))).toEqual(before);

    // The shared writes refuse too, before writing or linking anything.
    const third = await t.run(async (ctx) =>
      holdLine(ctx, (await ctx.db.get(releaseId))!.seriesIds[0]!, "5004", OLDER),
    );
    const held = await writes(t, third);
    await t.run(async (ctx) => {
      const decision = {
        release: (await ctx.db.get(releaseId))!,
        isbn13: OLDER,
        reason: "A further record of the 2002 printing.",
        sourceKey: "ann",
        citation: { sourceName: "ANN", url: "https://www.viz.com/vagabond" },
        now: Date.now(),
      };
      await expect(
        recordPrinting(ctx, { ...decision, observationId: third }),
      ).rejects.toMatchObject({ data: { code: "conflict" } });
      // Linking an already-linked record, or a printing the Release has no row for.
      await expect(
        linkRecordedPrinting(ctx, { ...decision, observationId: second }),
      ).rejects.toMatchObject({ data: { code: "conflict" } });
      await expect(
        linkRecordedPrinting(ctx, { ...decision, isbn13: "9781569318546", observationId: third }),
      ).rejects.toMatchObject({ data: { code: "conflict" } });
    });
    expect(await writes(t, third)).toEqual(held);
  });

  const viz = "https://www.viz.com/vagabond";
  const annUrl = "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5001";
  const malformed = (url: string) => `The evidence URL (${url}) is not an absolute http(s) URL.`;
  const uncited = "The decision cites no evidence URL, and the record has no http(s) URL.";
  it.each([
    ["no evidence URL: the record's", undefined, annUrl, { url: annUrl }],
    ["an empty one: the record's", "", annUrl, { url: annUrl }],
    ["a blank one: the record's", " \t ", annUrl, { url: annUrl }],
    ["a padded one, trimmed", `  ${viz}  `, annUrl, { url: viz }],
    ["a bare host", "www.viz.com/vagabond", annUrl, { refusal: malformed("www.viz.com/vagabond") }],
    ["a relative path", "/vagabond", annUrl, { refusal: malformed("/vagabond") }],
    [
      "another scheme",
      "ftp://viz.com/vagabond",
      annUrl,
      { refusal: malformed("ftp://viz.com/vagabond") },
    ],
    ["a script URL", "javascript:alert(1)", annUrl, { refusal: malformed("javascript:alert(1)") }],
    ["no host", "https://", annUrl, { refusal: malformed("https://") }],
    ["no evidence URL and none on the record", undefined, undefined, { refusal: uncited }],
    ["a blank one and a relative record URL", " ", "/releases.php?id=5001", { refusal: uncited }],
  ] as const)("cites %s", async (_, evidenceUrl, recordUrl, expected) => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, observationId } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await vagabond(ctx);
      const observationId = await holdLine(ctx, seriesId, "5001", OLDER);
      const { url: _, ...snapshot } = annLine("5001", "Vagabond", "1", OLDER, 2002);
      await ctx.db.patch(observationId, {
        snapshot: recordUrl !== undefined ? { ...snapshot, url: recordUrl } : snapshot,
      });
      return { releaseId, observationId };
    });
    const before = await writes(t, observationId);
    const result = await t.mutation(internal.printings.recordDecidedInternal, {
      observationId,
      releaseId,
      reason: "VIZ's 2002 first printing of Vagabond vol 1.",
      ...(evidenceUrl !== undefined ? { evidenceUrl } : {}),
    });
    if ("refusal" in expected) {
      expect(result).toEqual({ status: "refused", reason: expected.refusal });
      expect(await writes(t, observationId)).toEqual(before);
      return;
    }
    expect(result).toEqual({ status: "recorded", isbn13: OLDER });
    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    expect(revisions.map((revision) => revision.citation?.url)).toEqual([expected.url]);
  });
});

describe("ISBN spellings", () => {
  // 142159000X's check character is X; a 979 ISBN has no ISBN-10.
  const X_13 = "9781421590004";
  const NEW_979 = "9798888430019";

  it("reads every helper input as its ISBN-13, and a bad check digit as none", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      for (const isbn13 of [OLDER, X_13, NEW_979]) await insertPrinting(ctx, releaseId, isbn13);
      const spellings = [
        [OLDER, [OLDER, "978-1-59116-034-2", "978 1 59116 034 2", OLDER_10, "1-59116-034-0"]],
        [X_13, [X_13, "142159000X", "142159000x", "1-42159-000-x"]],
        [NEW_979, [NEW_979, "979-8-88843-001-9"]],
      ] as const;
      for (const [isbn13, forms] of spellings) {
        for (const form of forms) {
          expect((await printingReleases(ctx, form)).map((r) => r?._id)).toEqual([releaseId]);
          expect(await printingIsbnOf(ctx, releaseId, form)).toBe(isbn13);
        }
      }
      for (const bad of ["9781591160343", "1591160341", "1-59116-034-1", "15911603400", "x", ""]) {
        expect(await printingReleases(ctx, bad)).toEqual([]);
        expect(await printingIsbnOf(ctx, releaseId, bad)).toBeUndefined();
      }
    });
  });

  it("reads a record's ISBN from its first valid statement, the ANN page first", () => {
    expect(observedIsbn13({ isbn13: "978-1-59116-034-2" })).toBe(OLDER);
    expect(observedIsbn13({ isbn10: "1-59116-034-0" })).toBe(OLDER);
    expect(observedIsbn13({ isbn13: CURRENT, page: { isbn13: OLDER } })).toBe(OLDER);
    expect(observedIsbn13({ isbn13: OLDER, page: { isbn13: "9781591160343" } })).toBe(OLDER);
    expect(observedIsbn13({ isbn13: "9781591160343" })).toBeUndefined();
    expect(observedIsbn13(null)).toBeUndefined();
  });

  it("reads both of a Release's own ISBN fields as its own", () => {
    expect(primaryIsbnsOf({ isbn13: CURRENT, isbn10: "1-59116-034-0" })).toEqual(
      new Set([CURRENT, OLDER]),
    );
    expect(primaryIsbnsOf({ isbn10: "142159000x" })).toEqual(new Set([X_13]));
    expect(primaryIsbnsOf({ isbn13: "9781591160343" })).toEqual(new Set());
  });

  it("never marks or lists an ISBN-10-only Release's own ISBN as another printing", async () => {
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const { releaseId } = await vagabond(ctx);
      await ctx.db.patch(releaseId, { isbn13: undefined, isbn10: OLDER_10 });
      // A row from before a correction made OLDER the Release's own, and a real printing.
      await insertPrinting(ctx, releaseId, OLDER, { pubDate: year(2002) });
      await insertPrinting(ctx, releaseId, "9781569318546", { pubDate: year(2003) });
      const linked = async (id: string, snapshot: object) => {
        const observationId = await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: id,
          snapshot,
        });
        await linkObservation(ctx, observationId, { type: "release", id: releaseId });
        return observationId;
      };
      return {
        own: await linked("/books/OL1M", { isbn13: OLDER }),
        printing: await linked("/books/OL2M", { isbn10: "1569318549" }),
      };
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(ids.own))?.printingIsbn13).toBeUndefined();
      expect((await ctx.db.get(ids.printing))?.printingIsbn13).toBe("9781569318546");
    });
    const page = await t.query(api.catalogPages.editionPage, { publicId: 880 });
    expect(page?.releases[0]?.otherPrintings).toEqual([{ isbn13: "9781569318546", year: 2003 }]);
  });
});
