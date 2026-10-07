import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { alice, makeT, seedTeam } from "./test.helpers";
import { sameWorkTitle } from "./lib/matching";
import {
  insertPublisher,
  insertSeries,
  insertVolume,
  insertEdition,
  insertCoverage,
  insertRelease,
  insertBundle,
  insertObservation,
} from "./test.factories";

// Actual retained Chi ISBNs and canonical whole-collected-book model. Test IDs are isolated.
async function chi() {
  const t = makeT();
  await seedTeam(t, [alice]);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Vertical", slug: "vertical" });
    const seriesId = await insertSeries(ctx, {
      title: "The Complete Chi's Sweet Home",
      searchText: "The Complete Chi's Sweet Home completechissweethome ccsh",
      altTitles: ["チーズスイートホーム"],
    });
    const memberIds = [];
    const volumeIds = [];
    for (const [i, isbn13] of [
      "9781942993162",
      "9781942993179",
      "9781942993483",
      "9781942993575",
    ].entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, position: i + 1 });
      volumeIds.push(volumeId);
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      memberIds.push(
        await insertRelease(ctx, {
          publisherId,
          seriesIds: [seriesId],
          editionId,
          isbn13,
          binding: "paperback",
        }),
      );
    }
    const bundleId = await insertBundle(ctx, {
      publisherId,
      name: "The Complete Chi's Sweet Home Box Set",
      isbn13: "9781949980387",
      format: "physical",
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: "/books/OL29482324M",
      withdrawn: false,
      lastSeenAt: 1791124683073,
      conflicts: [
        {
          at: 1791115071179,
          field: "placement",
          offered: null,
          reason:
            '"Complete Chi\'s Sweet Home Box Set" is packaging of Series 3987 whose covered Volumes Open Library cannot state \u2014 an Editor maps it.',
        },
      ],
      snapshot: {
        format: "physical",
        isbn13: "9781949980387",
        key: "/books/OL29482324M",
        kind: "olEdition",
        multiVolume: false,
        packaging: { coverRange: null, lineName: "Box Set", linePosition: null },
        publishDate: { year: 2020 },
        publishers: ["Vertical, Incorporated"],
        seriesTitle: "Complete Chi's Sweet Home",
        title: "Complete Chi's Sweet Home Box Set",
        url: "https://openlibrary.org/books/OL29482324M",
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      kind: "packaging",
      seriesId,
      sourceKey: "openlibrary",
      heldAt: 1,
    });
    return { bundleId, observationId, memberIds, seriesId, publisherId, volumeIds };
  });
  return { t, ...ids };
}
it("completes actual Chi whole books with ledger and unchanged source, coverage, member IDs and histories", async () => {
  const { t, seriesId, publisherId, volumeIds, ...args } = await chi();
  const frozen = () =>
    t.run(async (ctx) => ({
      observation: await ctx.db.get(args.observationId),
      holds: await ctx.db.query("placementHolds").collect(),
      releases: await ctx.db.query("releases").collect(),
      editions: await ctx.db.query("editions").collect(),
      coverage: await ctx.db.query("volumeCoverages").collect(),
      volumes: await ctx.db.query("volumes").collect(),
      archives: await ctx.db.query("observationSnapshots").collect(),
      collectionEntries: await ctx.db.query("collectionEntries").collect(),
      revisions: (await ctx.db.query("revisions").collect()).filter(
        (row) => row.ref.type !== "releaseBundle" || row.ref.id !== args.bundleId,
      ),
    }));
  const before = await frozen();
  const preview = await t.query(internal.heldRepair.heldBundleContentsStateInternal, args);
  expect(preview.refusal).toBeNull();
  expect(preview.expected).not.toBeNull();
  const result = await t.mutation(internal.heldRepair.completeHeldBundleContentsInternal, {
    ...args,
    actor: "alice",
    expected: preview.expected!,
    reason: "Exact ISBN publisher lists all four whole collected books, preserve existing model.",
    evidenceUrls: [
      "https://www.penguinrandomhouse.com/books/634458/the-complete-chis-sweet-home-box-set-by-konami-kanata/",
    ],
  });
  expect(result.status).toBe("applied");
  expect(await frozen()).toEqual(before);
  const after = await t.run(async (ctx) => ({
    members: await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", args.bundleId))
      .collect(),
    ledger: await ctx.db.get(result.ledgerId!),
    proposal: await ctx.db.get(result.proposalId!),
    versions: await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", result.proposalId!))
      .collect(),
    revisions: await ctx.db.query("revisions").collect(),
  }));
  expect(after.members.map((m) => m.releaseId)).toEqual(args.memberIds);
  expect(after.members.map((m) => m.order)).toEqual([1, 2, 3, 4]);
  expect(after.ledger?.operation).toBe("completeBundleContents");
  expect(JSON.parse(after.ledger!.before).members).toEqual([]);
  expect(JSON.parse(after.ledger!.after).members).toEqual(after.members);
  expect(after.proposal?.currentVersionNo).toBe(1);
  expect(after.versions[0]?.versionNo).toBe(1);
  expect(
    after.revisions.some((r) => r.ref.type === "releaseBundle" && r.ref.id === args.bundleId),
  ).toBe(true);
  const target = { type: "bundle" as const, id: args.bundleId };
  const reviewed = {
    isbn13: "9781949980387",
    seriesId,
    publisherId,
    volumeIds,
    evidenceUrls: [
      "https://www.penguinrandomhouse.com/books/634458/the-complete-chis-sweet-home-box-set-by-konami-kanata/",
    ],
    sourceTitle: "Complete Chi's Sweet Home Box Set",
  };
  expect(sameWorkTitle("Complete Chi's Sweet Home", "The Complete Chi's Sweet Home")).toBe(false);
  const ordinary = await t.query(internal.heldBooks.previewInternal, {
    observationId: args.observationId,
    target,
  });
  expect(ordinary.classification).not.toBe("linkReady");
  const withoutTitle = await t.query(internal.heldBooks.previewInternal, {
    observationId: args.observationId,
    target,
    reviewed: { ...reviewed, sourceTitle: undefined },
  });
  expect(withoutTitle.refusal).toContain("Known source work");
  const linkPreview = await t.query(internal.heldBooks.previewInternal, {
    observationId: args.observationId,
    target,
    reviewed,
  });
  expect(linkPreview.refusal).toBeNull();
  expect(linkPreview.classification).toBe("linkReady");
  const link = await t.mutation(internal.heldBooks.executeInternal, {
    observationId: args.observationId,
    target,
    reviewed,
    actor: "alice",
    operation: "link",
    expected: linkPreview.expected!,
    reason: "Exact publisher ISBN proves this box contains the four collected books.",
    evidenceUrls: reviewed.evidenceUrls,
  });
  expect(link.status).toBe("applied");
  const linked = await frozen();
  const { observation: oldSource, holds: oldHolds, ...oldCanonical } = before;
  const { observation: newSource, holds: newHolds, ...newCanonical } = linked;
  expect(newCanonical).toEqual(oldCanonical);
  expect(newSource).toEqual({
    ...oldSource,
    recordRef: { type: "releaseBundle", id: args.bundleId },
    conflicts: [],
  });
  expect(newHolds).toEqual([]);
  const linkLedger = await t.run((ctx) => ctx.db.get(link.ledgerId!));
  expect(JSON.parse(linkLedger!.before)).toEqual({ observation: oldSource, hold: oldHolds[0] });
  expect(JSON.parse(linkLedger!.after)).toEqual({ observation: newSource, hold: null });
});
it("refuses changed source before writing", async () => {
  const {
    t,
    seriesId: _series,
    publisherId: _publisher,
    volumeIds: _volumes,
    ...args
  } = await chi();
  const p = await t.query(internal.heldRepair.heldBundleContentsStateInternal, args);
  await t.run(async (ctx) => {
    await ctx.db.patch(args.observationId, { lastSeenAt: 200 });
  });
  const result = await t.mutation(internal.heldRepair.completeHeldBundleContentsInternal, {
    ...args,
    actor: "alice",
    expected: p.expected!,
    reason: "Reviewed contents",
    evidenceUrls: [],
  });
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("Contents or source state changed");
  expect(await t.run((ctx) => ctx.db.query("bundleMemberships").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("proposalVersions").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("revisions").collect())).toEqual([]);
});
