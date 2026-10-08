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
import { type DigitalSiblingArgs, digest } from "./lib/digitalSibling";
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
      versions: await ctx.db.query("proposalVersions").collect(),
      publishers: await ctx.db.query("publishers").collect(),
      config: await ctx.db.query("appConfig").collect(),
      proposals: await ctx.db.query("proposals").collect(),
      revisions: await ctx.db.query("revisions").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
      tracking: await ctx.db.query("collectionEntries").collect(),
    }));
  return { t, ids, args, freeze };
}

it.each([
  "releaseKey",
  "coherentUrl",
  "parentTitle",
  "parentOwnId",
  "pageIsbn10",
  "pageFileFormat",
  "distributorId",
])("independent fresh semantic refusal: %s", async (change) => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    const obs = (await ctx.db.get(ids.observationId))!;
    const raw: Record<string, unknown> = structuredClone(originalAnnSnapshots[0]!);
    const page: Record<string, unknown> = { ...originalAnnSnapshots[0]!.page };
    if (change === "releaseKey")
      await ctx.db.patch(ids.observationId, { sourceRecordId: "release:99999" });
    if (change === "coherentUrl") {
      raw.annId = "99999";
      raw.url = "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=99999";
      await ctx.db.patch(ids.observationId, { sourceRecordId: "release:99999" });
    }
    if (change === "pageIsbn10") page.isbn10 = "1427867658";
    if (change === "pageFileFormat") page.digitalFileFormat = "epub";
    if (change === "distributorId") page.distributorId = "99999";
    if (["parentTitle", "parentOwnId"].includes(change)) {
      const parent = (await ctx.db.get(ids.parentId))!;
      await ctx.db.patch(ids.parentId, {
        snapshot: {
          ...(parent.snapshot as Record<string, unknown>),
          ...(change === "parentTitle" ? { title: "Naruto" } : { id: "99999" }),
        },
      });
    }
    if (!["releaseKey", "parentTitle", "parentOwnId"].includes(change))
      await ctx.db.patch(ids.observationId, { snapshot: { ...raw, page } });
    expect(obs.snapshot).toBeDefined();
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected ?? (await digest(valueHash(before))),
  });
  expect(result.status, JSON.stringify({ preview, result })).toBe("refused");
  expect(preview.expected).toBeNull();
  expect(await freeze()).toEqual(before);
});
it.each([
  "linkLedgerMissing",
  "linkVersionMissing",
  "linkVersionComment",
  "linkVersionOps",
  "linkProposalAuthor",
  "linkLedgerStructure",
  "creationLedgerStructure",
  "creationLedgerMissingStructure",
  "creationLedgerReplaced",
  "creationLedgerProposal",
  "creationRevisionMissing",
])("independent retry drift refusal: %s", async (change) => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(applied.status).toBe("applied");
  await t.run(async (ctx) => {
    const ledgers = await ctx.db.query("heldRepairLedger").collect();
    const link = ledgers.find((l) => l.operation === "link")!;
    const creation = ledgers.find((l) => l.operation === "createDigitalSibling")!;
    if (change === "linkLedgerMissing") await ctx.db.delete(link._id);
    if (change === "linkVersionMissing" || change === "linkVersionComment") {
      const version = (await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId))
        .unique())!;
      if (change === "linkVersionMissing") await ctx.db.delete(version._id);
      else await ctx.db.patch(version._id, { changeComment: "independent altered source audit" });
    }
    if (change === "linkVersionOps") {
      const v = (await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId))
        .unique())!;
      await ctx.db.patch(v._id, {
        ops: (await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", creation.proposalId))
          .unique())!.ops,
      });
    }
    if (change === "linkProposalAuthor")
      await ctx.db.patch(link.proposalId, {
        author: {
          kind: "user",
          userId: (await ctx.db.query("users").unique())!._id,
          roleAtAuthorship: "moderator",
        },
      });
    if (change === "linkLedgerStructure")
      await ctx.db.patch(link._id, { createdStructure: creation.createdStructure });
    if (change === "creationLedgerMissingStructure")
      await ctx.db.patch(creation._id, { createdStructure: undefined });
    if (change === "creationLedgerReplaced") {
      const { _id, _creationTime, ...fields } = creation;
      await ctx.db.delete(_id);
      await ctx.db.insert("heldRepairLedger", fields);
    }
    if (change === "creationLedgerStructure")
      await ctx.db.patch(creation._id, {
        createdStructure: {
          ...creation.createdStructure!,
          newEdition: true,
          newVolumeIds: [args.reviewed.volumeIds[0]],
        },
      });
    if (change === "creationLedgerProposal")
      await ctx.db.patch(creation._id, { proposalId: link.proposalId });
    if (change === "creationRevisionMissing") {
      for (const row of await ctx.db.query("revisions").collect())
        if (row.ref.id === applied.releaseId) await ctx.db.delete(row._id);
    }
  });
  const before = await freeze();
  const retry = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(await freeze()).toEqual(before);
  expect(retry.status, JSON.stringify(retry)).toBe("refused");
});
it("independent bounded publisher resolver reproduction", async () => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 81; i++)
      await insertPublisher(ctx, { name: `Unrelated ${i}`, slug: `unrelated-${i}` });
    const raw = originalAnnSnapshots[0]!;
    await ctx.db.patch(ids.observationId, {
      snapshot: { ...raw, page: { ...raw.page, distributor: "Tokyopop Unknownsuffix" } },
    });
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("incomplete");
  expect(await freeze()).toEqual(before);
});

for (const index of [0, 1, 2]) {
  it(`independent own-product ${index + 1} creation and preserved tracking`, async () => {
    const { t, args, ids, freeze } = await fixture(index);
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.refusal).toBeNull();
    const request = { ...args, actor: "ari", expected: preview.expected! };
    const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
    expect(applied.status).toBe("applied");
    const after = await freeze();
    const created = after.releases.find((r) => r._id === applied.releaseId)!;
    expect(created).toMatchObject({
      editionId: ids.editionId,
      format: "digital",
      digitalFileFormat: "pdf",
      isbn13: args.reviewed.isbn13,
      language: "en",
      pubDate: { year: 2020, month: 8, day: 6, sort: 20200806 },
    });
    expect(after.releases).toHaveLength(before.releases.length + 1);
    for (const key of ["editions", "volumes", "coverage", "history", "tracking"] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.releases.find((r) => r._id === ids.occupiedReleaseId)).toEqual(before.releases[0]);
    expect(after.holds).toEqual([]);
    expect(after.observations.find((o) => o._id === ids.observationId)?.snapshot).toEqual(
      before.observations.find((o) => o._id === ids.observationId)?.snapshot,
    );
    expect(await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request)).toEqual({
      ...applied,
      status: "alreadyApplied",
    });
    expect(await freeze()).toEqual(after);
  });
}
