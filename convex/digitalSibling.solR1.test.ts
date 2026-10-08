import { expect, it, vi, afterEach } from "vitest";
import { internal } from "./_generated/api";
import { makeT, seedTeam } from "./test.helpers";
import {
  insertPublisher,
  insertSeries,
  insertVolume,
  insertEdition,
  insertCoverage,
  insertRelease,
  insertObservation,
} from "./test.factories";
import { digitalSiblingFixtures, originalAnnSnapshots } from "./digitalSibling.fixtures";
import { digest, type DigitalSiblingArgs } from "./lib/digitalSibling";
import { valueHash } from "./lib/values";
const ari = { subject: "repair_ari", username: "ari", role: "administrator" } as const;
afterEach(() => vi.restoreAllMocks());
async function fixture(index = 0, options: Parameters<typeof makeT>[0] = {}) {
  const t = makeT(options);
  await seedTeam(t, [ari]);
  const proof = structuredClone(digitalSiblingFixtures[index]!);
  const snapshot = structuredClone(originalAnnSnapshots[index]!);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Tokyopop", slug: "tokyopop" });
    const seriesId = await insertSeries(ctx, { title: "Yuri Bear Storm" });
    const volumeId = await insertVolume(ctx, { seriesId, position: index + 1 });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const occupiedReleaseId = await insertRelease(ctx, {
      publisherId,
      seriesIds: [seriesId],
      editionId,
      isbn13: proof.reviewed.occupiedIsbn13,
      format: "digital",
      digitalFileFormat: "epub",
    });
    const userId = (await ctx.db.query("users").unique())!._id;
    await ctx.db.insert("collectionEntries", {
      userId,
      releaseId: occupiedReleaseId,
      state: "owned",
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:15868",
      snapshot: {
        kind: "annManga",
        id: "15868",
        url: "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=15868",
        title: "Yuri Bear Storm",
      },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${snapshot.annId}`,
      snapshot,
      conflicts: [
        { field: "placement", offered: null, at: 1, reason: "Occupied slot" },
        { field: "description", offered: "source text", at: 1, reason: "Retain history" },
      ],
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      heldAt: 1,
      kind: "isbn",
      seriesId,
    });
    await ctx.db.insert("observationSnapshots", {
      observationId,
      snapshot: { previous: "original raw history" },
      supersededAt: 1,
    });
    return {
      publisherId,
      seriesId,
      volumeId,
      editionId,
      occupiedReleaseId,
      observationId,
      parentId,
    };
  });
  const args: DigitalSiblingArgs = {
    observationId: ids.observationId,
    editionId: ids.editionId,
    occupiedReleaseId: ids.occupiedReleaseId,
    reviewed: {
      ...proof.reviewed,
      evidenceUrls: [...proof.reviewed.evidenceUrls],
      publisherId: ids.publisherId,
      seriesId: ids.seriesId,
      volumeIds: [ids.volumeId],
    },
  };
  const freeze = () =>
    t.run(async (ctx) => ({
      releases: await ctx.db.query("releases").collect(),
      editions: await ctx.db.query("editions").collect(),
      volumes: await ctx.db.query("volumes").collect(),
      coverage: await ctx.db.query("volumeCoverages").collect(),
      history: await ctx.db.query("observationSnapshots").collect(),
      observations: await ctx.db.query("sourceObservations").collect(),
      holds: await ctx.db.query("placementHolds").collect(),
      proposals: await ctx.db.query("proposals").collect(),
      revisions: await ctx.db.query("revisions").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
      tracking: await ctx.db.query("collectionEntries").collect(),
    }));
  return { t, ids, args, freeze };
}
it.each(["linkLedger", "linkProposalVersion"])(
  "review: retry must refuse missing or changed %s",
  async (change) => {
    const { t, args, freeze } = await fixture();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    const request = { ...args, actor: "ari", expected: preview.expected! };
    const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
    expect(applied.status).toBe("applied");
    await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", args.observationId))
        .collect();
      const link = ledger.find((l) => l.operation === "link")!;
      expect(link).toBeDefined();
      if (change === "linkLedger") await ctx.db.delete(link._id);
      else {
        const version = await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId))
          .unique();
        await ctx.db.patch(version!._id, { changeComment: "review: changed native link proof" });
      }
    });
    const before = await freeze();
    const retry = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
    expect(await freeze()).toEqual(before);
    expect(retry.status, JSON.stringify(retry)).toBe("refused");
  },
);
it("review: native ANN adapter replay keeps linked PDF out of held queue", async () => {
  const { t, args, ids } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(applied.status).toBe("applied");
  await t.mutation(internal.ann.applyReleasePage, { annId: originalAnnSnapshots[0]!.annId });
  const result = await t.run(async (ctx) => ({
    obs: await ctx.db.get(ids.observationId),
    holds: await ctx.db.query("placementHolds").collect(),
    releases: await ctx.db.query("releases").collect(),
  }));
  expect(result.obs!.recordRef).toEqual({ type: "release", id: applied.releaseId });
  expect(result.holds).toHaveLength(0);
  expect(result.releases).toHaveLength(2);
});

it("review: low query budget refuses atomically", async () => {
  const { t, args, freeze } = await fixture(0, { transactionLimits: { databaseQueries: 100 } });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(result.status, result.reason).toBe("refused");
  expect(await freeze()).toEqual(before);
});
it.each(["range", "unlabelled", "wrongWorkParent", "publisher", "sourceRecord", "sourceKind"])(
  "review: fresh preview rejects %s",
  async (change) => {
    const { t, args, ids } = await fixture();
    await t.run(async (ctx) => {
      const raw = structuredClone(originalAnnSnapshots[0]!);
      if (change === "range")
        await ctx.db.patch(ids.observationId, {
          snapshot: { ...raw, coverRange: { from: "1", to: "3" } },
        });
      if (change === "unlabelled") await ctx.db.patch(ids.volumeId, { label: undefined });
      if (change === "wrongWorkParent") {
        const seriesId = await insertSeries(ctx, { title: "Wrong manga" });
        await ctx.db.patch(ids.parentId, { recordRef: { type: "series", id: seriesId } });
      }
      if (change === "publisher")
        await ctx.db.patch(ids.observationId, {
          snapshot: { ...raw, page: { ...raw.page, distributor: "Yen Press" } },
        });
      if (change === "sourceRecord")
        await ctx.db.patch(ids.observationId, {
          sourceRecordId: "release:NOT_THE_REVIEWED_SOURCE",
        });
      if (change === "sourceKind")
        await ctx.db.patch(ids.observationId, { snapshot: { ...raw, kind: "NOT_ANN_RELEASE" } });
    });
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected, JSON.stringify(preview)).toBeNull();
  },
);

it.each(["sourceRecord", "sourceKind"])(
  "review: creation must refuse malformed %s with fresh digest",
  async (change) => {
    const { t, args, ids, freeze } = await fixture();
    await t.run(async (ctx) => {
      if (change === "sourceRecord")
        await ctx.db.patch(ids.observationId, {
          sourceRecordId: "release:NOT_THE_REVIEWED_SOURCE",
        });
      else
        await ctx.db.patch(ids.observationId, {
          snapshot: { ...originalAnnSnapshots[0]!, kind: "NOT_ANN_RELEASE" },
        });
    });
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    const before = await freeze();
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
      ...args,
      actor: "ari",
      expected: preview.expected ?? (await digest(valueHash(before))),
    });
    expect(result.status, JSON.stringify(result)).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);
