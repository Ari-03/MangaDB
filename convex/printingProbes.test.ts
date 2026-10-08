// The review probes of PR #67 (GPT rounds one and two, and the original
// reproductions), each on its original fixture, now asserting the fixed
// behaviour. Probes whose fix has its own focused case elsewhere name it.

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import { BOOK_PAGE_VERSION } from "./lib/sevenSeas";
import { linkObservation, recordUnplaced } from "./lib/observations";
import {
  claimResolver,
  otherPrintingsOf,
  printingIsbnOf,
  printingReleases,
} from "./lib/releaseIsbns";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, signedIn } from "./test.helpers";
import { mergeAs, splitAs } from "./test.moderation";

const old = "9781591160342";
const current = "9781421519111";

/** The probes' shared fixture: Vagabond vol 1's Release `current`, and a held record of `old`. */
async function setup(sourceKey = "openlibrary", snapshotExtra: Record<string, unknown> = {}) {
  const t = makeT();
  await seedRegistry(t);
  await seedTeam(t, [alice, bob]);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, { title: "Vagabond" });
    const volumeId = await insertVolume(ctx, { seriesId });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: current,
    });
    const observationId = await insertObservation(ctx, {
      sourceKey,
      sourceRecordId: sourceKey === "ann" ? "release:1" : "OL1",
      snapshot: {
        title: "Vagabond, Vol. 1",
        isbn13: old,
        publishers: ["VIZ Media"],
        format: "physical",
        url: "https://example.com/book",
        ...snapshotExtra,
      },
    });
    await recordUnplaced(
      ctx,
      (await ctx.db.get(observationId))!,
      { kind: "isbn", seriesId, reason: "Review" },
      Date.now(),
    );
    return { publisherId, seriesId, volumeId, editionId, releaseId, observationId };
  });
  const decide = (releaseId = ids.releaseId) =>
    t.mutation(internal.printings.recordDecidedInternal, {
      observationId: ids.observationId,
      releaseId,
      reason: "Reviewed",
    });
  return { t, decide, ...ids };
}

describe("round-one probes, fixed", () => {
  it("a Seven Seas listing retry asks a recorded printing's record for no art, and an old attach is refused", async () => {
    const sourceUrl = "https://example.com/older-printing.jpg";
    const { t, decide, ...s } = await setup("sevenseas", {
      modifiedGmt: "stamp",
      parserVersion: BOOK_PAGE_VERSION,
      coverUrl: sourceUrl,
    });
    await t.run((ctx) =>
      ctx.db.patch(s.publisherId, {
        name: "Seven Seas Entertainment",
        slug: "seven-seas-entertainment",
      }),
    );
    expect(await decide()).toMatchObject({ status: "recorded" });
    expect(
      await t.mutation(internal.sevenSeas.noteListing, {
        sourceRecordId: "OL1",
        modifiedGmt: "stamp",
        force: false,
        offersBlurb: false,
      }),
    ).toEqual({ needsDetail: false });
    expect(
      await t.mutation(internal.imports.attachCover, {
        releaseId: s.releaseId,
        sourceUrl,
        attribution: "Seven Seas",
      }),
    ).toMatchObject({
      attached: false,
      refused: "a record of another printing offers that art",
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(s.releaseId))?.coverImage ?? null),
    ).toBeNull();
  });

  it("a novel's packaged line is refused, though its parsed work name lost the marker", async () => {
    const { decide } = await setup("openlibrary", {
      title: "Vagabond (Light Novel) [VIZBIG Edition]",
    });
    expect(await decide()).toEqual({
      status: "refused",
      reason: expect.stringMatching(/outside the catalog: .*novel/),
    });
  });

  it("an unchanged unlinked Open Library snapshot still reruns matching when applied (control)", async () => {
    const { t, ...s } = await setup();
    const snapshot = {
      kind: "olEdition" as const,
      key: "/books/OL2M",
      url: "https://openlibrary.org/books/OL2M",
      title: "Vagabond, Vol. 1",
      seriesTitle: "Vagabond",
      volumeLabel: "1",
      multiVolume: false,
      publishers: ["VIZ Media LLC"],
      publishDate: { year: 2002 },
      format: "physical" as const,
      isbn13: old,
    };
    await t.mutation(internal.openLibrary.applyEdition, { snapshot });
    await t.run((ctx) =>
      ctx.db.insert("releaseIsbns", {
        releaseId: s.releaseId,
        isbn13: old,
        reason: "Reviewed",
        sourceKey: "ann",
      }),
    );
    expect(await t.mutation(internal.openLibrary.applyEdition, { snapshot })).toMatchObject({
      status: "linked",
      releaseId: s.releaseId,
    });
  });

  it("a merged record with no survivor is an unresolved claim, never nobody's", async () => {
    const { t, ...s } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(s.releaseId, { status: "merged" });
      expect(await claimResolver(ctx).release(s.releaseId)).toEqual({
        unresolved: expect.stringContaining("merged into nothing"),
      });
    });
  });

  it("recording the merged loser's own ISBN on the survivor is refused, so Split never meets two owners", async () => {
    const { t, decide, ...s } = await setup();
    const loserId = await t.run((ctx) =>
      insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.publisherId,
        seriesIds: [s.seriesId],
        isbn13: old,
      }),
    );
    await mergeAs(t, { type: "release", id: s.releaseId }, { type: "release", id: loserId });
    expect(await decide()).toEqual({
      status: "refused",
      reason: expect.stringContaining(`as the ISBN of Release ${loserId} merged into it`),
    });
    await splitAs(t, { type: "release", id: loserId });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(loserId)).toMatchObject({ status: "active", isbn13: old });
      expect(await ctx.db.query("releaseIsbns").collect()).toEqual([]);
    });
  });

  it("a Release's own ISBN-10 is not another printing of it", async () => {
    const { t, ...s } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(s.releaseId, { isbn13: undefined, isbn10: "1591160340" });
      await ctx.db.insert("releaseIsbns", {
        releaseId: s.releaseId,
        isbn13: old,
        reason: "Promotion",
        sourceKey: "ann",
        observationId: s.observationId,
      });
      expect(await printingIsbnOf(ctx, s.releaseId, old)).toBeUndefined();
    });
  });

  it("an ISBN a Release Bundle holds is refused, and still finds the Bundle", async () => {
    const { t, decide, ...s } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("releaseBundles", {
        publicId: 123,
        status: "active",
        publisherId: s.publisherId,
        name: "Box",
        format: "physical",
        isbn13: old,
      }),
    );
    expect(await decide()).toEqual({
      status: "refused",
      reason: expect.stringContaining("Release Bundle 123's"),
    });
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: old })).toMatchObject({
      kind: "bundle",
    });
  });

  it("a legacy ANN VIZBIG line is refused against a one-Volume Release", async () => {
    const { decide } = await setup("ann", {
      kind: "annRelease",
      annId: "1",
      mangaId: "1",
      title: "Vagabond [VIZBIG Edition]",
      label: "1",
      multi: false,
      editionLineHint: false,
      page: { status: "ok", fetchedAt: 1, volume: "GN 1", distributor: "VIZ Media", isbn13: old },
    });
    expect(await decide()).toEqual({
      status: "refused",
      reason: expect.stringMatching(/reads as packaging|now reads packaging true/),
    });
  });
});

describe("the original reproductions, fixed", () => {
  it("a hyphenated ISBN-10 finds its printing", async () => {
    const { t, ...s } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("releaseIsbns", {
        releaseId: s.releaseId,
        isbn13: old,
        reason: "Reviewed",
        sourceKey: "ann",
      });
      expect(await printingReleases(ctx, "1-59116-034-0")).toHaveLength(1);
    });
  });

  it("past twenty printings, the row says others may not be shown", async () => {
    const { t, ...s } = await setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 21; i++) {
        await ctx.db.insert("releaseIsbns", {
          releaseId: s.releaseId,
          isbn13: `test-${i}`,
          reason: "Reviewed",
          sourceKey: "ann",
          pubDate: {
            year: i === 20 ? 1900 : 2000 + i,
            sort: i === 20 ? 19000000 : 20000000 + i * 10000,
          },
        });
      }
      const { printings, more } = await otherPrintingsOf(ctx, (await ctx.db.get(s.releaseId))!);
      expect(printings).toHaveLength(20);
      expect(more).toBe(true);
    });
  });

  it("a hidden Release's own ISBN is refused", async () => {
    const { t, ...s } = await setup();
    await t.run((ctx) =>
      insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.publisherId,
        seriesIds: [s.seriesId],
        isbn13: old,
        status: "hidden",
      }),
    );
    expect(
      await t.mutation(internal.printings.recordDecidedInternal, {
        observationId: s.observationId,
        releaseId: s.releaseId,
        reason: "Reviewed same book",
      }),
    ).toEqual({ status: "refused", reason: expect.stringContaining("belongs to hidden Release") });
  });

  it("a second record of a recorded printing is linked with its own audit", async () => {
    const { t, ...s } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("releaseIsbns", {
        releaseId: s.releaseId,
        isbn13: old,
        reason: "Existing decision",
        sourceKey: "ann",
      }),
    );
    expect(
      await t.mutation(internal.printings.recordDecidedInternal, {
        observationId: s.observationId,
        releaseId: s.releaseId,
        reason: "New reviewed decision",
        evidenceUrl: "https://example.com/review",
      }),
    ).toMatchObject({ status: "linked" });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("revisions").collect()).toHaveLength(1);
      expect(await ctx.db.query("proposals").collect()).toHaveLength(1);
    });
  });

  it("Split keeps a record with its printing on the survivor that took it", async () => {
    const { t, ...s } = await setup();
    const loserId = await t.run(async (ctx) => {
      const loserId = await insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.publisherId,
        seriesIds: [s.seriesId],
        isbn13: "9781421599991",
      });
      await ctx.db.insert("releaseIsbns", {
        releaseId: loserId,
        isbn13: old,
        reason: "Existing decision",
        sourceKey: "openlibrary",
      });
      await linkObservation(ctx, s.observationId, { type: "release", id: loserId });
      return loserId;
    });
    await mergeAs(t, { type: "release", id: s.releaseId }, { type: "release", id: loserId });
    const asAdmin = signedIn(t, alice);
    const { proposalId } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: { type: "release", id: s.releaseId },
          changes: [{ field: "isbn13", value: old }],
        },
      ],
      evidence: [{ kind: "url", url: "https://example.com" }],
      comment: "Change ISBN",
    });
    await asAdmin.mutation(api.proposals.submitProposal, { proposalId });
    await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });
    await splitAs(t, { type: "release", id: loserId });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseIsbns").first()).toMatchObject({
        releaseId: s.releaseId,
        isbn13: old,
      });
      expect(await ctx.db.get(s.observationId)).toMatchObject({
        recordRef: { type: "release", id: s.releaseId },
        printingIsbn13: old,
      });
    });
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: old })).toMatchObject({
      anchor: old,
    });
  });
});

describe("round-two controls that stay as they were", () => {
  it("a stored version mixing Split with an update still fails as stale on approval", async () => {
    const { t, decide, ...s } = await setup();
    const loserId = await t.run((ctx) =>
      insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.publisherId,
        seriesIds: [s.seriesId],
        isbn13: "9781421599991",
      }),
    );
    expect(await decide(loserId)).toMatchObject({ status: "recorded" });
    await mergeAs(t, { type: "release", id: s.releaseId }, { type: "release", id: loserId });
    const base = await t.run((ctx) =>
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", s.releaseId))
        .order("desc")
        .first(),
    );
    const proposalId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "openlibrary" },
        state: "inReview",
        currentVersionNo: 1,
      });
      await ctx.db.insert("proposalVersions", {
        proposalId: id,
        versionNo: 1,
        ops: [
          { kind: "split", ref: { type: "release", id: loserId }, details: {} },
          {
            kind: "update",
            ref: { type: "release", id: s.releaseId },
            baseRevisionId: base!._id,
            changes: [{ field: "isbn13", before: current, after: old }],
          },
        ],
        evidence: [{ kind: "url", url: "https://example.com/decision" }],
        changeComment: "Stored mixed ops",
      });
      return id;
    });
    await expect(
      signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "stale" } });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.releaseId))?.isbn13).toBe(current);
      expect((await ctx.db.get(loserId))?.status).toBe("merged");
    });
  });

  it("transaction metrics are there for a query or mutation to read", async () => {
    const t = makeT({ transactionLimits: true });
    await t.run(async (ctx) => {
      const metrics = await ctx.meta.getTransactionMetrics();
      expect(metrics.bytesRead).toMatchObject({ used: 0, remaining: 16 * 1024 * 1024 });
      expect(metrics.documentsWritten.remaining).toBe(16_000);
    });
  });
});
