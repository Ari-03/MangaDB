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
  insertBundle,
} from "./test.factories";
import { digitalSiblingFixtures, originalAnnSnapshots } from "./digitalSibling.fixtures";
import { createDigitalSibling, type DigitalSiblingArgs, digest } from "./lib/digitalSibling";
import { valueHash } from "./lib/values";
import { isbn13To10 } from "./lib/isbn";
import * as pipeline from "./lib/pipeline";
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
      publisherRedirects: await ctx.db.query("publisherSlugRedirects").collect(),
      config: await ctx.db.query("appConfig").collect(),
      proposals: await ctx.db.query("proposals").collect(),
      revisions: await ctx.db.query("revisions").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
      tracking: await ctx.db.query("collectionEntries").collect(),
    }));
  return { t, ids, args, freeze };
}
for (const [index, original] of digitalSiblingFixtures.entries()) {
  it(`creates actual own PDF ${original.reviewed.isbn13} on existing Edition, links atomically and preserves IDs on audited retry`, async () => {
    const { t, args, ids, freeze } = await fixture(index);
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.refusal).toBeNull();
    const request = { ...args, expected: preview.expected!, actor: "ari" };
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
    expect(result.status, result.reason).toBe("applied");
    const after = await freeze();
    expect(after.releases).toHaveLength(before.releases.length + 1);
    expect(after.releases.find((r) => r._id === ids.occupiedReleaseId)).toEqual(before.releases[0]);
    for (const key of ["editions", "volumes", "coverage", "history", "tracking"] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.holds).toHaveLength(0);
    expect(after.observations.find((o) => o._id === ids.observationId)).toMatchObject({
      snapshot: before.observations.find((o) => o._id === ids.observationId)!.snapshot,
      recordRef: { type: "release", id: result.releaseId },
      conflicts: [
        { field: "description", offered: "source text", at: 1, reason: "Retain history" },
      ],
    });
    expect(
      after.revisions.some(
        (r) =>
          r.ref.id === result.releaseId &&
          r.changes.some((c) => c.field === "digitalFileFormat" && c.after === "pdf"),
      ),
    ).toBe(true);
    const retry = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
    expect(retry).toEqual({ ...result, status: "alreadyApplied" });
    expect(await freeze()).toEqual(after);
  });
}
it("rolls back creation and audit if failure occurs after insert before native link", async () => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const before = await freeze();
  await expect(
    t.run((ctx) =>
      createDigitalSibling(ctx, { ...args, actor: "ari", expected: preview.expected! }, () => {
        throw new Error("injected after creation");
      }),
    ),
  ).rejects.toThrow("injected");
  expect(await freeze()).toEqual(before);
});
it.each(["primary", "isbn10", "printing", "bundle"] as const)(
  "refuses a fresh %s owner after preview without any writes",
  async (kind) => {
    const { t, args, ids, freeze } = await fixture();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    await t.run(async (ctx) => {
      if (kind === "bundle")
        await insertBundle(ctx, { publisherId: ids.publisherId, isbn13: args.reviewed.isbn13 });
      else if (kind === "printing")
        await ctx.db.insert("releaseIsbns", {
          releaseId: ids.occupiedReleaseId,
          isbn13: args.reviewed.isbn13,
          reason: "Test independently reviewed printing",
          sourceKey: "ann",
        });
      else
        await insertRelease(ctx, {
          editionId: ids.editionId,
          publisherId: ids.publisherId,
          seriesIds: [ids.seriesId],
          ...(kind === "primary"
            ? { isbn13: args.reviewed.isbn13 }
            : { isbn10: isbn13To10(args.reviewed.isbn13) }),
        });
    });
    const before = await freeze();
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
      ...args,
      expected: preview.expected!,
      actor: "ari",
    });
    expect(result.status).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);
it.each([
  "raw",
  "parent",
  "coverage",
  "locked",
  "unknown",
  "hiddenPdf",
  "mergedPdf",
  "otherEdition",
  "chapter",
  "package",
  "novel",
  "epubDrift",
])("refuses %s source/canonical/slot drift", async (change) => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  await t.run(async (ctx) => {
    const obs = (await ctx.db.get(ids.observationId))!;
    const raw = structuredClone(originalAnnSnapshots[0]!);
    if (change === "raw") await ctx.db.patch(ids.observationId, { lastSeenAt: obs.lastSeenAt + 1 });
    if (change === "parent") await ctx.db.patch(ids.parentId, { withdrawn: true });
    if (change === "coverage") {
      const row = (await ctx.db.query("volumeCoverages").collect())[0]!;
      await ctx.db.patch(row._id, { extent: "partial" });
    }
    if (change === "locked") await ctx.db.patch(ids.editionId, { locked: true });
    if (change === "epubDrift")
      await ctx.db.patch(ids.occupiedReleaseId, { digitalFileFormat: "pdf" });
    if (["unknown", "hiddenPdf", "mergedPdf", "otherEdition"].includes(change)) {
      const editionId =
        change === "otherEdition"
          ? await insertEdition(ctx, { publisherId: ids.publisherId })
          : ids.editionId;
      if (editionId !== ids.editionId)
        await insertCoverage(ctx, { editionId, volumeId: ids.volumeId });
      await insertRelease(ctx, {
        editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        ...(change === "unknown" ? {} : { digitalFileFormat: "pdf" }),
        status: change === "hiddenPdf" ? "hidden" : change === "mergedPdf" ? "merged" : "active",
        ...(change === "mergedPdf" ? { mergedIntoId: ids.occupiedReleaseId } : {}),
      });
    }
    if (change === "chapter")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, page: { ...raw.page, volume: "eBook Chapter 1" } },
      });
    if (change === "package")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, editionLineHint: true, multi: true },
      });
    if (change === "novel")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, title: "Yuri Bear Storm (light novel)" },
      });
  });
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    expected: preview.expected!,
    actor: "ari",
  });
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});
it.each(["bodySha", "sectionSha", "bytes", "malformed", "sku", "volume", "oversized"])(
  "refuses %s literal proof",
  async (change) => {
    const { t, args } = await fixture();
    const proof = args.reviewed.publisherProof;
    if (change === "bodySha") proof.bodySha256 = "0".repeat(64);
    if (change === "sectionSha") proof.sectionSha256 = "0".repeat(64);
    if (change === "bytes") proof.byteStart = 1;
    if (change === "malformed") proof.excerpt = "{";
    if (change === "sku")
      proof.excerpt = proof.excerpt.replace('"sku":"9781427863539"', '"sku":"9781427863515"');
    if (change === "volume") args.reviewed.productVolumeLabel = "2";
    if (change === "oversized") proof.excerpt = "x".repeat(70 * 1024);
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(preview.refusal).not.toBeNull();
  },
);
it("fails closed on incomplete bounded sibling reads", async () => {
  const { t, args, ids } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 81; i++)
      await insertRelease(ctx, {
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
      });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("incomplete");
});
it("refuses altered expected hash and actor", async () => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const before = await freeze();
  for (const request of [
    { actor: "ari", expected: "stale" },
    { actor: "alice", expected: preview.expected! },
  ]) {
    expect(
      (await t.mutation(internal.heldRepair.createDigitalSiblingInternal, { ...args, ...request }))
        .status,
    ).toBe("refused");
    expect(valueHash(await freeze())).toBe(valueHash(before));
  }
});

it("native link guard failure after catalog insertion rolls back all creation writes", async () => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const before = await freeze();
  await expect(
    t.run((ctx) =>
      createDigitalSibling(
        ctx,
        { ...args, actor: "ari", expected: preview.expected! },
        async () => {
          const obs = (await ctx.db.get(ids.observationId))!;
          const snapshot = obs.snapshot as Record<string, unknown>;
          await ctx.db.patch(ids.observationId, { snapshot: { ...snapshot, format: "physical" } });
        },
      ),
    ),
  ).rejects.toThrow();
  expect(await freeze()).toEqual(before);
});
it("retry refuses creation proposal version drift without new writes", async () => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(applied.status).toBe("applied");
  await t.run(async (ctx) => {
    const version = await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", applied.proposalId!))
      .unique();
    await ctx.db.patch(version!._id, { changeComment: "Changed audit evidence" });
  });
  const before = await freeze();
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request)).status).toBe(
    "refused",
  );
  expect(await freeze()).toEqual(before);
});
it("contradictory source file-format fact blocks preview", async () => {
  const { t, args, ids } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(ids.observationId, {
      snapshot: { ...originalAnnSnapshots[0], digitalFileFormat: "epub" },
    }),
  );
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("contradicts");
});

it("refuses sibling denormalization repair as an incidental creation write", async () => {
  const { t, args, ids } = await fixture();
  await t.run(async (ctx) => {
    await insertRelease(ctx, {
      editionId: ids.editionId,
      publisherId: ids.publisherId,
      seriesIds: [],
    });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("denormalizations");
});
it("refuses duplicate active canonical Volume labels", async () => {
  const { t, args, ids } = await fixture();
  await t.run((ctx) => insertVolume(ctx, { seriesId: ids.seriesId, position: 1 }));
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("ambiguous");
});
it("refuses human in-review placement without clearing its hold", async () => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").unique())!;
    const proposalId = await ctx.db.insert("proposals", {
      state: "inReview",
      author: { kind: "user", userId: user._id, roleAtAuthorship: user.role },
      currentVersionNo: 1,
    });
    await ctx.db.patch(ids.observationId, { queuedProposalId: proposalId });
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(await freeze()).toEqual(before);
});

it.each([
  "releaseKind",
  "releaseId",
  "nonNumericId",
  "zeroId",
  "leadingZeroId",
  "numericId",
  "sourceRecord",
  "releaseUrl",
  "releaseUrlHost",
  "coherentOtherRelease",
  "releaseParentId",
  "pageParentId",
  "parentKind",
  "parentId",
  "parentIdType",
  "parentAnnId",
  "parentUrl",
  "parentTitle",
  "parentMissingId",
  "label",
  "sourceKey",
])("fresh malformed %s cannot become valid through a new digest", async (change) => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    const obs = (await ctx.db.get(ids.observationId))!;
    const parent = (await ctx.db.get(ids.parentId))!;
    const line: Record<string, unknown> = { ...originalAnnSnapshots[0]! };
    const page: Record<string, unknown> = { ...originalAnnSnapshots[0]!.page };
    const parentSnapshot = { ...(parent.snapshot as Record<string, unknown>) };
    if (change === "releaseKind") line.kind = "NOT_ANN_RELEASE";
    if (change === "releaseId") line.annId = "40821";
    if (change === "nonNumericId") line.annId = "NOT_ANN_ID";
    if (change === "zeroId") line.annId = "0";
    if (change === "leadingZeroId") line.annId = "040824";
    if (change === "numericId") line.annId = 40824;
    if (change === "releaseUrl")
      line.url = "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=40821";
    if (change === "releaseUrlHost")
      line.url = "https://example.com/encyclopedia/releases.php?id=40824";
    if (change === "releaseParentId") line.mangaId = "1";
    if (change === "pageParentId") page.mangaId = "1";
    if (change === "parentKind") parentSnapshot.kind = "NOT_ANN_MANGA";
    if (change === "parentId") parentSnapshot.id = "1";
    if (change === "parentIdType") parentSnapshot.id = 15868;
    if (change === "parentAnnId") parentSnapshot.annId = "1";
    if (change === "parentUrl")
      parentSnapshot.url = "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=1";
    if (change === "parentTitle") parentSnapshot.title = "Naruto";
    if (change === "parentMissingId") delete parentSnapshot.id;
    if (change === "label") line.label = "2";
    let sourceRecordId = obs.sourceRecordId;
    if (change === "sourceRecord") sourceRecordId = "release:NOT_THE_REVIEWED_SOURCE";
    if (change === "coherentOtherRelease") {
      sourceRecordId = "release:40821";
      line.annId = "40821";
      line.url = "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=40821";
    }
    await ctx.db.patch(ids.observationId, {
      snapshot: { ...line, page },
      sourceRecordId,
      ...(change === "sourceKey" ? { sourceKey: "openlibrary" } : {}),
    });
    await ctx.db.patch(ids.parentId, { snapshot: parentSnapshot });
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected, change).toBeNull();
  expect(preview.refusal, change).not.toBeNull();
  // A malformed state has no executable preview digest. Even a freshly computed
  // SHA256 of today's raw state must fail semantic checks before digest comparison.
  const freshDigest = await digest(valueHash({ args, before }));
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: freshDigest,
  });
  expect(result.status, result.reason).toBe("refused");
  expect(result.reason).not.toContain("preview again");
  expect(await freeze()).toEqual(before);
});

it.each([
  "ledgerMissing",
  "ledgerReplaced",
  "ledgerDuplicate",
  "ledgerBefore",
  "ledgerAfter",
  "ledgerTarget",
  "ledgerProposal",
  "proposalMissing",
  "proposalState",
  "versionMissing",
  "versionComment",
  "versionEvidence",
  "versionDuplicate",
])("audited retry refuses native link %s with zero writes", async (change) => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(applied.status, applied.reason).toBe("applied");
  await t.run(async (ctx) => {
    const link = (
      await ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", args.observationId))
        .collect()
    ).find((l) => l.operation === "link")!;
    const version = (await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId))
      .unique())!;
    if (change === "ledgerMissing" || change === "ledgerReplaced") await ctx.db.delete(link._id);
    if (change === "ledgerDuplicate" || change === "ledgerReplaced") {
      const { _id, _creationTime, ...fields } = link;
      await ctx.db.insert("heldRepairLedger", fields);
    }
    if (change === "ledgerBefore") {
      const before = JSON.parse(link.before);
      before.hold.heldAt += 1;
      await ctx.db.patch(link._id, { before: valueHash(before) });
    }
    if (change === "ledgerAfter") await ctx.db.patch(link._id, { after: "{}" });
    if (change === "ledgerTarget")
      await ctx.db.patch(link._id, { target: { type: "release", id: ids.occupiedReleaseId } });
    if (change === "ledgerProposal")
      await ctx.db.patch(link._id, { proposalId: applied.proposalId! });
    if (change === "proposalMissing") await ctx.db.delete(link.proposalId);
    if (change === "proposalState") await ctx.db.patch(link.proposalId, { state: "rejected" });
    if (change === "versionMissing") await ctx.db.delete(version._id);
    if (change === "versionComment")
      await ctx.db.patch(version._id, { changeComment: "Changed native link proof" });
    if (change === "versionEvidence") await ctx.db.patch(version._id, { evidence: [] });
    if (change === "versionDuplicate") {
      const { _id, _creationTime, ...fields } = version;
      await ctx.db.insert("proposalVersions", { ...fields, versionNo: 2 });
    }
  });
  const before = await freeze();
  const retry = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(retry.status, retry.reason).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("complete bounded publisher fallback refuses 81 extra candidates without writes", async () => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 81; i++)
      await insertPublisher(ctx, { name: `Other publisher ${i}`, slug: `other-${i}` });
    const raw = originalAnnSnapshots[0]!;
    await ctx.db.patch(ids.observationId, {
      snapshot: { ...raw, page: { ...raw.page, distributor: "Tokyopop Unknownsuffix" } },
    });
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("incomplete");
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: await digest(valueHash(before)),
  });
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("bounded publisher fallback cannot certify a nonreviewed distributor", async () => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    const raw = originalAnnSnapshots[0]!;
    await ctx.db.patch(ids.observationId, {
      snapshot: { ...raw, page: { ...raw.page, distributor: "Tokyopop Unknownsuffix" } },
    });
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.expected).toBeNull();
  expect(preview.refusal).toContain("reviewed ANN distributor");
  expect(await freeze()).toEqual(before);
});

it("publisher resolver dependencies participate in stale-state refusal", async () => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  await t.run((ctx) => ctx.db.patch(ids.publisherId, { name: "Changed publisher name" }));
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("native ANN replay keeps the linked PDF and original history without recreating a hold", async () => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const applied = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(applied.status).toBe("applied");
  const before = await freeze();
  await t.mutation(internal.ann.applyReleasePage, { annId: originalAnnSnapshots[0]!.annId });
  const after = await freeze();
  expect(after.holds).toEqual([]);
  for (const key of ["releases", "editions", "volumes", "coverage", "history", "tracking"] as const)
    expect(after[key]).toEqual(before[key]);
  expect(after.observations.find((o) => o._id === ids.observationId)?.recordRef).toEqual({
    type: "release",
    id: applied.releaseId,
  });
});

it("low query budget refuses atomic creation without writes", async () => {
  const { t, args, freeze } = await fixture(0, { transactionLimits: { databaseQueries: 100 } });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("a parent's name must be a current canonical declaration", async () => {
  const { t, args, ids } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.seriesId, { altTitles: ["Yurikuma Arashi"] });
    const parent = (await ctx.db.get(ids.parentId))!;
    await ctx.db.patch(ids.parentId, {
      snapshot: { ...(parent.snapshot as Record<string, unknown>), title: "Yurikuma Arashi" },
    });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
  });
  expect(result.status, result.reason).toBe("applied");
});

it.each(["9780316435918", "9780316435932", "9780316435956", "9781975357290"])(
  "deferred batch003 ISBN %s is outside the exact proof pins",
  async (isbn13) => {
    const { t, args, freeze } = await fixture();
    args.reviewed.isbn13 = isbn13;
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toContain("independently reviewed capture");
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
      ...args,
      actor: "ari",
      expected: await digest(valueHash(before)),
    });
    expect(result.status).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);

// Retained independent Astra r2 probes.
it.each([
  "parentContradiction",
  "releaseKey",
  "releaseUrl",
  "isbn10Contradiction",
  "pageIsbn10Contradiction",
  "parentDuplicate",
  "coverageOrder",
  "unknownEpub",
  "publisherFallback",
  "publisherMergedSlot",
  "publisherDenormSlot",
])("astra r2 independently refuses fresh %s", async (change) => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    const observation = (await ctx.db.get(ids.observationId))!;
    const raw = structuredClone(originalAnnSnapshots[0]);
    if (change === "parentContradiction") {
      const parent = (await ctx.db.get(ids.parentId))!;
      await ctx.db.patch(ids.parentId, {
        snapshot: { ...(parent.snapshot as Record<string, unknown>), title: "Naruto" },
      });
    }
    if (change === "releaseKey")
      await ctx.db.patch(ids.observationId, { sourceRecordId: "release:40821" });
    if (change === "releaseUrl")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, url: "https://example.com/?id=40824" },
      });
    if (change === "isbn10Contradiction")
      await ctx.db.patch(ids.observationId, { snapshot: { ...raw, isbn10: "1427867658" } });
    if (change === "pageIsbn10Contradiction")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, page: { ...raw.page, isbn10: "1427867658" } },
      });
    if (change === "parentDuplicate") {
      const parent = (await ctx.db.get(ids.parentId))!;
      const { _id, _creationTime, ...fields } = parent;
      await ctx.db.insert("sourceObservations", fields);
    }
    if (change === "coverageOrder") {
      const row = (await ctx.db.query("volumeCoverages").unique())!;
      await ctx.db.patch(row._id, { order: 2 });
    }
    if (change === "unknownEpub")
      await ctx.db.patch(ids.occupiedReleaseId, { digitalFileFormat: undefined });
    if (change === "publisherFallback") {
      for (let i = 0; i < 81; i++)
        await insertPublisher(ctx, { name: `Publisher ${i}`, slug: `pub-${i}` });
      await ctx.db.patch(observation._id, {
        snapshot: { ...raw, page: { ...raw.page, distributor: "Tokyopop Unknownsuffix" } },
      });
    }
    if (change === "publisherMergedSlot" || change === "publisherDenormSlot") {
      const otherPublisher = await insertPublisher(ctx, {
        name: "Former Tokyopop",
        slug: "former-tokyopop",
        ...(change === "publisherMergedSlot"
          ? { status: "merged" as const, mergedIntoId: ids.publisherId }
          : {}),
      });
      const otherEdition = await insertEdition(ctx, { publisherId: otherPublisher });
      await insertCoverage(ctx, { editionId: otherEdition, volumeId: ids.volumeId });
      await insertRelease(ctx, {
        editionId: otherEdition,
        publisherId: change === "publisherDenormSlot" ? ids.publisherId : otherPublisher,
        seriesIds: [ids.seriesId],
        format: "digital",
        digitalFileFormat: "pdf",
        status: "hidden",
      });
    }
  });
  const before = await freeze();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected ?? (await digest(valueHash(before))),
  });
  expect.soft(preview.expected, `${change}: ${JSON.stringify(result)}`).toBeNull();
  expect.soft(result.status, change).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it.each([
  "linkLedgerDeleted",
  "linkVersionOps",
  "linkVersionReplaced",
  "linkProposalVersion",
  "creationRevisionDeleted",
  "createdReleaseDate",
])("astra r2 retry refuses %s", async (change) => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(result.status).toBe("applied");
  await t.run(async (ctx) => {
    const link = (await ctx.db.query("heldRepairLedger").collect()).find(
      (l) => l.operation === "link",
    )!;
    const version = (await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId))
      .unique())!;
    if (change === "linkLedgerDeleted") await ctx.db.delete(link._id);
    if (change === "linkVersionOps")
      await ctx.db.patch(version._id, {
        ops: [{ kind: "create", table: "releases", tempId: "review-tamper", fields: {} }],
      });
    if (change === "linkVersionReplaced") {
      const { _id, _creationTime, ...fields } = version;
      await ctx.db.delete(_id);
      await ctx.db.insert("proposalVersions", fields);
    }
    if (change === "linkProposalVersion")
      await ctx.db.patch(link.proposalId, { currentVersionNo: 2 });
    if (change === "creationRevisionDeleted") {
      for (const revision of await ctx.db.query("revisions").collect())
        if (revision.ref.id === result.releaseId) await ctx.db.delete(revision._id);
    }
    if (change === "createdReleaseDate")
      await ctx.db.patch(result.releaseId!, { pubDate: { year: 2025, sort: 20250101 } });
  });
  const before = await freeze();
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request)).status).toBe(
    "refused",
  );
  expect(await freeze()).toEqual(before);
});

it("astra r2 refuses publisher merge drift that fills the PDF slot", async () => {
  const { t, args, ids, freeze } = await fixture();
  const publisherId = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: "Other Publisher",
      slug: "other-publisher",
    });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId: ids.volumeId });
    await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [ids.seriesId],
      format: "digital",
      digitalFileFormat: "pdf",
      status: "hidden",
    });
    return publisherId;
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  await t.run((ctx) =>
    ctx.db.patch(publisherId, { status: "merged", mergedIntoId: ids.publisherId }),
  );
  const changedPreview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    expected: preview.expected!,
    actor: "ari",
  });
  expect
    .soft(changedPreview.expected, "Publisher merge must affect the digest or block preview")
    .not.toEqual(preview.expected);
  expect.soft(result.status, JSON.stringify(result)).toBe("refused");
  expect(await freeze()).toEqual(before);
});

// Retained independent Astra r1 probes, with the real ANN parent schema.
it.each([
  "missingLabel",
  "range",
  "unlabeledPage",
  "wrongPublisher",
  "wrongParentWork",
  "unknownSibling",
  "extraEpub",
  "hiddenUnknown",
  "wrongEdition",
  "wrongLanguage",
  "unmapped",
  "lockedVolume",
  "mergedVolume",
  "hiddenEdition",
  "sourcePhysical",
] as const)("review fresh preview semantic rejection: %s", async (kind) => {
  const { t, args, ids } = await fixture();
  await t.run(async (ctx) => {
    const raw = structuredClone(originalAnnSnapshots[0]!);
    if (kind === "missingLabel")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, label: undefined, page: { ...raw.page, volume: "eBook" } },
      });
    if (kind === "range")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, label: "1-3", coverRange: [1, 3] },
      });
    if (kind === "unlabeledPage")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, page: { ...raw.page, volume: "eBook" } },
      });
    if (kind === "wrongPublisher")
      await ctx.db.patch(ids.observationId, {
        snapshot: { ...raw, page: { ...raw.page, distributor: "VIZ Media" } },
      });
    if (kind === "wrongParentWork")
      await ctx.db.patch(ids.parentId, {
        snapshot: {
          kind: "annManga",
          id: "15868",
          url: "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=15868",
          title: "Naruto",
        },
      });
    if (kind === "unknownSibling" || kind === "hiddenUnknown" || kind === "extraEpub")
      await insertRelease(ctx, {
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        ...(kind === "extraEpub" ? { digitalFileFormat: "epub" } : {}),
        status: kind === "hiddenUnknown" ? "hidden" : "active",
      });
    if (kind === "wrongEdition")
      await ctx.db.patch(ids.occupiedReleaseId, {
        editionId: await insertEdition(ctx, { publisherId: ids.publisherId }),
      });
    if (kind === "wrongLanguage") await ctx.db.patch(ids.occupiedReleaseId, { language: "ja" });
    if (kind === "unmapped") await ctx.db.patch(ids.editionId, { coverageUnmapped: true });
    if (kind === "lockedVolume") await ctx.db.patch(ids.volumeId, { locked: true });
    if (kind === "mergedVolume")
      await ctx.db.patch(ids.volumeId, {
        status: "merged",
        mergedIntoId: await insertVolume(ctx, { seriesId: ids.seriesId, position: 2 }),
      });
    if (kind === "hiddenEdition") await ctx.db.patch(ids.editionId, { status: "hidden" });
    if (kind === "sourcePhysical")
      await ctx.db.patch(ids.observationId, { snapshot: { ...raw, format: "physical" } });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal, kind).not.toBeNull();
  expect(preview.expected, kind).toBeNull();
});

it("review regeneration keeps PDF source linked without recreating hold", async () => {
  const { t, args, ids, freeze } = await fixture();
  const p = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const created = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: p.expected!,
  });
  expect(created.status).toBe("applied");
  const before = await freeze();
  await t.mutation(internal.ann.applyReleasePage, { annId: originalAnnSnapshots[0]!.annId });
  const after = await freeze();
  expect(after.holds).toEqual([]);
  expect(after.releases).toEqual(before.releases);
  expect(after.history).toEqual(before.history);
  expect(after.tracking).toEqual(before.tracking);
  expect(after.observations.find((x) => x._id === ids.observationId)?.recordRef).toEqual({
    type: "release",
    id: created.releaseId,
  });
});

it("review stale bootstrap digest refuses without any writes", async () => {
  const { t, args, freeze } = await fixture();
  const p = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  await t.run((ctx) => ctx.db.insert("appConfig", { bootstrapMode: false }));
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
    ...args,
    actor: "ari",
    expected: p.expected!,
  });
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("review retry requires retained native link audit", async () => {
  const { t, args, freeze } = await fixture();
  const p = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const req = { ...args, actor: "ari", expected: p.expected! };
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, req)).status).toBe(
    "applied",
  );
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("heldRepairLedger").collect())
      if (row.operation === "link") await ctx.db.delete(row._id);
  });
  const before = await freeze();
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, req);
  expect(result.status).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it("review wrong parent title must block catalog writes", async () => {
  const { t, args, ids } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, {
      snapshot: {
        kind: "annManga",
        id: "15868",
        url: "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=15868",
        title: "Naruto",
      },
    }),
  );
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  if (preview.expected) {
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
      ...args,
      actor: "ari",
      expected: preview.expected,
    });
    expect(result.status).toBe("refused");
  } else expect(preview.refusal).not.toBeNull();
});

it("review retry must reject deleted native link proposal and version", async () => {
  const { t, args } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const req = { ...args, actor: "ari", expected: preview.expected! };
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, req)).status).toBe(
    "applied",
  );
  await t.run(async (ctx) => {
    const ledger = (await ctx.db.query("heldRepairLedger").collect()).find(
      (x) => x.operation === "link",
    )!;
    for (const v of await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", ledger.proposalId))
      .collect())
      await ctx.db.delete(v._id);
    await ctx.db.delete(ledger.proposalId);
  });
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, req)).status).toBe(
    "refused",
  );
});

it("review publisher fallback must retain the complete bounded reader", async () => {
  const { t, args, ids } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 81; i++)
      await insertPublisher(ctx, { name: `Unrelated publisher ${i}`, slug: `unrelated-pub-${i}` });
    const raw = structuredClone(originalAnnSnapshots[0]!);
    await ctx.db.patch(ids.observationId, {
      snapshot: { ...raw, page: { ...raw.page, distributor: "Tokyopop Unknownsuffix" } },
    });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).not.toBeNull();
});

it.each(["99999", "011", "", 11, null])(
  "r3 refuses contradictory or malformed present distributor ID %s before certification",
  async (distributorId) => {
    const { t, args, ids, freeze } = await fixture();
    await t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: {
          ...originalAnnSnapshots[0]!,
          page: { ...originalAnnSnapshots[0]!.page, distributorId },
        },
      }),
    );
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toContain("company 11");
    const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
      ...args,
      actor: "ari",
      expected: await digest(valueHash(before)),
    });
    expect(result.status).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);

it("r3 permits absent optional distributor ID with all other independent identities intact", async () => {
  const { t, args, ids } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(ids.observationId, {
      snapshot: {
        ...originalAnnSnapshots[0]!,
        page: { ...originalAnnSnapshots[0]!.page, distributorId: undefined },
      },
    }),
  );
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  expect(
    (
      await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
        ...args,
        actor: "ari",
        expected: preview.expected!,
      })
    ).status,
  ).toBe("applied");
});

it.each(["pdf", "epub", undefined] as const)(
  "r3 refuses reserved other-Edition %s through a two-hop publisher alias",
  async (digitalFileFormat) => {
    const { t, args, ids, freeze } = await fixture();
    await t.run(async (ctx) => {
      const intermediate = await insertPublisher(ctx, {
        name: "Earlier Tokyopop",
        slug: "earlier",
        status: "merged",
        mergedIntoId: ids.publisherId,
      });
      const publisherId = await insertPublisher(ctx, {
        name: "Old Tokyopop",
        slug: "old",
        status: "merged",
        mergedIntoId: intermediate,
      });
      const editionId = await insertEdition(ctx, { publisherId, status: "hidden" });
      await insertCoverage(ctx, { editionId, volumeId: ids.volumeId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        digitalFileFormat,
        status: "hidden",
      });
    });
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toContain("reserved digital sibling");
    expect(
      (
        await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
          ...args,
          actor: "ari",
          expected: await digest(valueHash(before)),
        })
      ).status,
    ).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);

it.each(["missing", "cycle", "hidden", "danglingMerge"])(
  "r3 refuses unresolved other-Edition publisher %s instead of skipping the slot",
  async (change) => {
    const { t, args, ids, freeze } = await fixture();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Other", slug: "other" });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId: ids.volumeId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        digitalFileFormat: "pdf",
        status: "hidden",
      });
      if (change === "missing") await ctx.db.delete(publisherId);
      if (change === "cycle")
        await ctx.db.patch(publisherId, { status: "merged", mergedIntoId: publisherId });
      if (change === "hidden") await ctx.db.patch(publisherId, { status: "hidden" });
      if (change === "danglingMerge") await ctx.db.patch(publisherId, { status: "merged" });
    });
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(
      (
        await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
          ...args,
          actor: "ari",
          expected: await digest(valueHash(before)),
        })
      ).status,
    ).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);

it("r3 resolves a renamed publisher slug through the captured product identity and retries unchanged", async () => {
  const { t, args, ids, freeze } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.publisherId, { slug: "tokyopop-renamed" });
    await ctx.db.insert("publisherSlugRedirects", {
      fromSlug: "tokyopop",
      publisherId: ids.publisherId,
    });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(result.status, result.reason).toBe("applied");
  const before = await freeze();
  expect(await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request)).toEqual({
    ...result,
    status: "alreadyApplied",
  });
  expect(await freeze()).toEqual(before);
});

it.each(["name", "redirect"])(
  "r3 refuses fresh misleading publisher %s despite a matching slug resolver",
  async (change) => {
    const { t, args, ids, freeze } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.publisherId, {
        name: "Unrelated Publisher",
        ...(change === "redirect" ? { slug: "unrelated" } : {}),
      });
      if (change === "redirect")
        await ctx.db.insert("publisherSlugRedirects", {
          fromSlug: "tokyopop",
          publisherId: ids.publisherId,
        });
    });
    const before = await freeze();
    const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toContain("publisher identity disagree");
    expect(
      (
        await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
          ...args,
          actor: "ari",
          expected: await digest(valueHash(before)),
        })
      ).status,
    ).toBe("refused");
    expect(await freeze()).toEqual(before);
  },
);

it("r3 captures publisher redirect drift between preview and mutation", async () => {
  const { t, args, ids, freeze } = await fixture();
  const redirectId = await t.run(async (ctx) => {
    await ctx.db.patch(ids.publisherId, { slug: "tokyopop-renamed" });
    return ctx.db.insert("publisherSlugRedirects", {
      fromSlug: "tokyopop",
      publisherId: ids.publisherId,
    });
  });
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  await t.run(async (ctx) => {
    const other = await insertPublisher(ctx, { name: "Other", slug: "other" });
    await ctx.db.patch(redirectId, { publisherId: other });
  });
  const before = await freeze();
  expect(
    (
      await t.mutation(internal.heldRepair.createDigitalSiblingInternal, {
        ...args,
        actor: "ari",
        expected: preview.expected!,
      })
    ).status,
  ).toBe("refused");
  expect(await freeze()).toEqual(before);
});

it.each([
  "duplicate",
  "missing",
  "operation",
  "before",
  "after",
  "extraMetadata",
  "creationAnchorMissing",
  "creationAnchorChanged",
  "creationVersionReplaced",
  "creationVersionDuplicate",
])("r3 refuses original creation audit %s with zero writes", async (change) => {
  const { t, args, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  const request = { ...args, actor: "ari", expected: preview.expected! };
  const result = await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request);
  expect(result.status).toBe("applied");
  await t.run(async (ctx) => {
    const creation = (await ctx.db.query("heldRepairLedger").collect()).find(
      (l) => l.operation === "createDigitalSibling",
    )!;
    const version = (await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", creation.proposalId))
      .unique())!;
    if (change === "duplicate") {
      const { _id, _creationTime, ...fields } = creation;
      await ctx.db.insert("heldRepairLedger", fields);
    }
    if (change === "missing") await ctx.db.delete(creation._id);
    if (change === "operation")
      await ctx.db.patch(creation._id, { operation: "differentOperation" });
    if (change === "before") await ctx.db.patch(creation._id, { before: "{}" });
    if (change === "after") await ctx.db.patch(creation._id, { after: "{}" });
    if (change === "extraMetadata")
      await ctx.db.patch(creation._id, { replayedReleaseId: result.releaseId! });
    if (change === "creationAnchorMissing")
      await ctx.db.patch(version._id, {
        evidence: version.evidence.filter(
          (e) => e.kind !== "note" || !e.text.startsWith("digitalSiblingCreationLedger:"),
        ),
      });
    if (change === "creationAnchorChanged")
      await ctx.db.patch(version._id, {
        evidence: [
          ...version.evidence.filter(
            (e) => e.kind !== "note" || !e.text.startsWith("digitalSiblingCreationLedger:"),
          ),
          { kind: "note", text: `digitalSiblingCreationLedger:${"0".repeat(64)}` },
        ],
      });
    if (change === "creationVersionReplaced" || change === "creationVersionDuplicate") {
      const { _id, _creationTime, ...fields } = version;
      if (change === "creationVersionReplaced") await ctx.db.delete(_id);
      await ctx.db.insert("proposalVersions", {
        ...fields,
        versionNo: change === "creationVersionDuplicate" ? 2 : fields.versionNo,
      });
    }
  });
  const before = await freeze();
  expect((await t.mutation(internal.heldRepair.createDigitalSiblingInternal, request)).status).toBe(
    "refused",
  );
  expect(await freeze()).toEqual(before);
});

it("r3 rolls back the source link and both audits when final validation fails after the ledger anchor", async () => {
  const { t, args, ids, freeze } = await fixture();
  const preview = await t.query(internal.heldRepair.previewDigitalSiblingInternal, args);
  expect(preview.refusal).toBeNull();
  const before = await freeze();
  const original = pipeline.findPublisherByName;
  await expect(
    t.run((ctx) =>
      createDigitalSibling(
        ctx,
        {
          ...args,
          actor: "ari",
          expected: preview.expected!,
        },
        () => {
          vi.spyOn(pipeline, "findPublisherByName").mockImplementation(
            async (resolverCtx, name) => {
              const obs = await resolverCtx.db.get(ids.observationId);
              if (obs?.recordRef) {
                const ledgers = await resolverCtx.db
                  .query("heldRepairLedger")
                  .withIndex("by_observation", (q) => q.eq("observationId", ids.observationId))
                  .take(3);
                expect(ledgers.map((l) => l.operation).sort()).toEqual([
                  "createDigitalSibling",
                  "link",
                ]);
                const creation = ledgers.find((l) => l.operation === "createDigitalSibling")!;
                const version = (await resolverCtx.db
                  .query("proposalVersions")
                  .withIndex("by_proposal", (q) => q.eq("proposalId", creation.proposalId))
                  .unique())!;
                expect(
                  version.evidence.some(
                    (e) => e.kind === "note" && e.text.startsWith("digitalSiblingCreationLedger:"),
                  ),
                ).toBe(true);
                throw new Error("Injected final guard failure after both audits");
              }
              return original(resolverCtx, name);
            },
          );
        },
      ),
    ),
  ).rejects.toThrow("Injected final guard failure after both audits");
  expect(await freeze()).toEqual(before);
});
