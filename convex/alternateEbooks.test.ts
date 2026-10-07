// Alternate ebook ISBNs (alternateEbooks.ts): a held ebook ISBN that ANN or a
// cited retailer lists for a digital Release's same ebook is recorded as a
// row that finds the Release, clears the hold and leaves the Release as it
// was; anything that breaks an invariant refuses and writes nothing, and the
// consistency check and merges keep the row on a digital Release.

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { recordUnplaced } from "./lib/observations";
import { releaseMergeRefusal } from "./lib/sensitiveOps";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { makeT, seedRegistry, type TestT } from "./test.helpers";

// Log Horizon: The West Wind Brigade vol 11 (ANN 36229): Yen Press's ebook
// is 9781975384081; ANN lists the same ebook under 9781975384098.
const OWN = "9781975384081";
const HELD = "9781975384098";

/** Yen Press, the Series, its Volume 11, and the Edition's digital (and physical) Release. */
async function logHorizon(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
  const seriesId = await insertSeries(ctx, { title: "Log Horizon: The West Wind Brigade" });
  const volumeId = await insertVolume(ctx, { seriesId, position: 11 });
  const editionId = await insertEdition(ctx, { publisherId });
  await insertCoverage(ctx, { editionId, volumeId });
  const releaseId = await insertRelease(ctx, {
    editionId,
    publisherId,
    seriesIds: [seriesId],
    format: "digital",
    isbn13: OWN,
    pubDate: { year: 2019, month: 3, sort: 20190300 },
  });
  const physicalId = await insertRelease(ctx, {
    editionId,
    publisherId,
    seriesIds: [seriesId],
    isbn13: "9781975383220",
  });
  return { publisherId, seriesId, volumeId, editionId, releaseId, physicalId };
}

/** ANN's digital line of `isbn13`, held under `seriesId` as the page pass holds it. */
async function holdAnnLine(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  isbn13: string,
  fields: { format?: "physical" | "digital"; label?: string; distributor?: string } = {},
) {
  const label = fields.label ?? "11";
  const observationId = await insertObservation(ctx, {
    sourceKey: "ann",
    sourceRecordId: `release:${isbn13}`,
    snapshot: {
      kind: "annRelease",
      annId: "36229",
      mangaId: "17302",
      url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=36229",
      title: "Log Horizon: The West Wind Brigade",
      label,
      multi: false,
      format: fields.format ?? "digital",
      editionLineHint: false,
      isbn13,
      date: { year: 2019, month: 3, day: 26 },
      page: {
        status: "ok",
        fetchedAt: 1,
        distributor: fields.distributor ?? "Yen Press",
        volume: `eBook ${label} / 11`,
        isbn13,
        date: { year: 2019, month: 3, day: 26 },
      },
    },
  });
  await recordUnplaced(
    ctx,
    (await ctx.db.get(observationId))!,
    { kind: "isbn", reason: "Volume 11 already has a digital Yen Press Release.", seriesId },
    Date.now(),
  );
  return observationId;
}

const annListing = { kind: "annListing" as const };
const record = (
  t: TestT,
  observationId: Id<"sourceObservations">,
  releaseId: Id<"releases">,
  evidence:
    | typeof annListing
    | { kind: "retailerListing"; sourceName: string; url: string } = annListing,
) => t.mutation(internal.alternateEbooks.recordInternal, { observationId, releaseId, evidence });

describe("alternateEbooks.recordInternal", () => {
  it("records ANN's alternate ebook ISBN on the digital Release and clears the hold", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, observationId, before } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await logHorizon(ctx);
      const observationId = await holdAnnLine(ctx, seriesId, HELD);
      return { releaseId, observationId, before: await ctx.db.get(releaseId) };
    });

    const args = { observationId, releaseId, evidence: annListing };
    expect(await t.query(internal.alternateEbooks.previewInternal, args)).toEqual({
      status: "ready",
      isbn13: HELD,
      reason: "ANN-listed alternate ebook ISBN",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseIsbns").collect()).toEqual([]);
    });

    expect(await record(t, observationId, releaseId)).toEqual({
      status: "recorded",
      isbn13: HELD,
      reason: "ANN-listed alternate ebook ISBN",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseIsbns").collect()).toEqual([
        expect.objectContaining({
          releaseId,
          isbn13: HELD,
          kind: "alternateEbook",
          reason: "ANN-listed alternate ebook ISBN",
          sourceKey: "ann",
          observationId,
        }),
      ]);
      expect(await ctx.db.get(observationId)).toMatchObject({
        recordRef: { type: "release", id: releaseId },
        printingIsbn13: HELD,
      });
      expect(await ctx.db.query("placementHolds").collect()).toEqual([]);
      expect(await ctx.db.get(releaseId)).toEqual(before);
      const [revision] = await ctx.db.query("revisions").collect();
      expect(revision).toMatchObject({
        changes: [{ field: "alternateEbookIsbn", after: `ISBN ${HELD}, 2019` }],
      });
      expect((await ctx.db.get(revision!.proposalId))?.state).toBe("approved");
    });
    expect(await t.query(api.catalogPages.isbnLookup, { isbn: HELD })).toMatchObject({
      anchor: OWN,
    });
    // The consistency check expects the row's owner to be digital.
    const page = await t.query(internal.printings.consistencyInternal, {
      pass: "rows",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.findings.filter((f: { severity: string }) => f.severity === "violation")).toEqual(
      [],
    );
    // A second run finds the record linked and refuses.
    expect(await record(t, observationId, releaseId)).toMatchObject({ status: "refused" });
  });

  it("records a retailer-store ISBN from a record that calls the book physical", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId, observationId } = await t.run(async (ctx) => {
      const { releaseId, seriesId } = await logHorizon(ctx);
      const observationId = await holdAnnLine(ctx, seriesId, HELD, { format: "physical" });
      return { releaseId, observationId };
    });
    // ANN calls it physical: an ANN listing is no evidence of an ebook.
    expect(await record(t, observationId, releaseId)).toEqual({
      status: "refused",
      reason: "ANN does not list the book as digital.",
    });
    const nook = {
      kind: "retailerListing" as const,
      sourceName: "Barnes & Noble NOOK",
      url: "https://www.barnesandnoble.com/w/log-horizon/1?ean=9781975384098",
    };
    expect(await record(t, observationId, releaseId, nook)).toEqual({
      status: "recorded",
      isbn13: HELD,
      reason: "Alternate ebook ISBN listed by Barnes & Noble NOOK",
    });
    await t.run(async (ctx) => {
      const [revision] = await ctx.db.query("revisions").collect();
      expect(revision?.citation).toEqual({
        sourceName:
          "Barnes & Noble NOOK (alternate ebook ISBN), from Anime News Network Encyclopedia",
        url: nook.url,
      });
    });
  });

  it("refuses, writing nothing, whatever breaks an invariant", async () => {
    const t = makeT();
    await seedRegistry(t);
    const ids = await t.run(async (ctx) => {
      const base = await logHorizon(ctx);
      const held = await holdAnnLine(ctx, base.seriesId, HELD);
      const wrongVolume = await holdAnnLine(ctx, base.seriesId, "9781975384104", { label: "10" });
      const outsideBlock = await holdAnnLine(ctx, base.seriesId, "9781421519111");
      const otherPublisher = await holdAnnLine(ctx, base.seriesId, "9781975384111", {
        distributor: "VIZ Media",
      });
      await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const claimedIsbn = "9781975384128";
      const claimed = await holdAnnLine(ctx, base.seriesId, claimedIsbn);
      const otherEdition = await insertEdition(ctx, { publisherId: base.publisherId });
      await insertCoverage(ctx, { editionId: otherEdition, volumeId: base.volumeId });
      await insertRelease(ctx, {
        editionId: otherEdition,
        publisherId: base.publisherId,
        seriesIds: [base.seriesId],
        format: "digital",
        isbn13: claimedIsbn,
      });
      return { ...base, held, wrongVolume, outsideBlock, otherPublisher, claimed };
    });
    const refusal = async (
      observationId: Id<"sourceObservations">,
      releaseId: Id<"releases">,
      pattern: RegExp,
    ) => {
      const result = await record(t, observationId, releaseId);
      expect(result.status).toBe("refused");
      expect("reason" in result ? result.reason : "").toMatch(pattern);
    };

    await refusal(ids.held, ids.physicalId, /not digital/);
    await refusal(ids.wrongVolume, ids.releaseId, /Volume 10; the Release is Volume 11/);
    await refusal(ids.outsideBlock, ids.releaseId, /not both in Yen Press's own ISBN blocks/);
    await refusal(ids.otherPublisher, ids.releaseId, /publisher is VIZ Media/);
    await refusal(ids.claimed, ids.releaseId, /belongs to/);
    expect(
      await record(t, ids.held, ids.releaseId, {
        kind: "retailerListing",
        sourceName: "Kobo",
        url: "not a url",
      }),
    ).toMatchObject({ status: "refused", reason: expect.stringMatching(/not an absolute/) });

    // A PDF sibling in the Edition leaves which ebook the ISBN names unknown.
    await t.run(async (ctx) => {
      await insertRelease(ctx, {
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        digitalFileFormat: "pdf",
        isbn13: "9781975384135",
      });
    });
    await refusal(ids.held, ids.releaseId, /another active digital Release/);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseIsbns").collect()).toEqual([]);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
      expect((await ctx.db.query("placementHolds").collect()).length).toBe(5);
    });
  });

  it("moves an alternate ebook ISBN in a merge only onto a digital Release", async () => {
    const t = makeT();
    await seedRegistry(t);
    await t.run(async (ctx) => {
      const { releaseId, seriesId, physicalId, editionId, publisherId } = await logHorizon(ctx);
      const observationId = await holdAnnLine(ctx, seriesId, HELD);
      const digitalTwin = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        format: "digital",
        status: "hidden",
      });
      await ctx.db.insert("releaseIsbns", {
        releaseId,
        isbn13: HELD,
        kind: "alternateEbook",
        reason: "ANN-listed alternate ebook ISBN",
        sourceKey: "ann",
        observationId,
      });
      expect(await releaseMergeRefusal(ctx, physicalId, releaseId)).toMatch(
        /only a digital Release has alternate ebook ISBNs/,
      );
      expect(await releaseMergeRefusal(ctx, digitalTwin, releaseId)).toBeNull();
    });
  });
});
