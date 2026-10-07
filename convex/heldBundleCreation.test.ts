import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { insertBook } from "./test.moderation";
import { insertObservation, insertPublisher, insertSeries, insertVolume } from "./test.factories";
import { alice, makeT, seedTeam } from "./test.helpers";

async function fixture() {
  const t = makeT();
  await seedTeam(t, [alice]);
  const args = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, { title: "Naruto" });
    const volumeIds = [],
      memberIds = [];
    const memberIsbn13s = ["9781569319000", "9781591161783"];
    for (const [i, isbn13] of memberIsbn13s.entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(i + 1), position: i + 1 });
      const book = await insertBook(ctx, {
        seriesId,
        publisherId,
        volumeId,
        release: { isbn13, format: "physical", binding: "paperback" },
      });
      volumeIds.push(volumeId);
      memberIds.push(book.releaseId);
    }
    await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:11",
      snapshot: { kind: "annManga", id: "11", title: "Naruto" },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:22",
      snapshot: {
        kind: "annRelease",
        annId: "22",
        mangaId: "11",
        title: "Naruto Box Set 1",
        isbn13: "9781421525822",
        format: "physical",
        multi: true,
        editionLineHint: true,
        coverRange: { from: "1", to: "2" },
        page: {
          status: "ok",
          title: "Naruto Box Set 1",
          isbn13: "9781421525822",
          mangaId: "11",
          volume: "GN 1-2",
          distributor: "VIZ Media",
        },
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "packaging",
      seriesId,
      heldAt: 1,
    });
    return {
      observationId,
      publisherId,
      seriesId,
      memberIds,
      memberIsbn13s,
      volumeIds,
      name: "Naruto Box Set 1",
      isbn13: "9781421525822",
      evidenceUrls: ["https://www.viz.com/naruto-box-set"],
    };
  });
  return { t, args };
}

it("dry runs roll back bundle, memberships, allocator and audit; stale dependencies refuse", async () => {
  const { t, args } = await fixture();
  const before = await t.run(async (ctx) => ({
    bundles: await ctx.db.query("releaseBundles").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    ids: await ctx.db.query("counters").collect(),
  }));
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  const execution = {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Reviewed exact ordered print members",
    dryRun: true,
  };
  expect(await t.mutation(internal.heldBundleCreation.createInternal, execution)).toEqual({
    status: "dryRun",
  });
  const after = await t.run(async (ctx) => ({
    bundles: await ctx.db.query("releaseBundles").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    ids: await ctx.db.query("counters").collect(),
  }));
  expect(after).toEqual(before);
  expect(await t.run((ctx) => ctx.db.query("bundleMemberships").collect())).toEqual([]);
  await t.run((ctx) => ctx.db.patch(args.memberIds[0]!, { binding: "hardcover" }));
  const drift = await t.mutation(internal.heldBundleCreation.createInternal, {
    ...execution,
    dryRun: false,
  });
  expect(drift).toMatchObject({ status: "refused" });
  expect(await t.run((ctx) => ctx.db.query("releaseBundles").collect())).toEqual([]);
});

it("rejects duplicate members, incomplete contents and claimed package ISBNs", async () => {
  const { t, args } = await fixture();
  expect(
    (
      await t.query(internal.heldBundleCreation.previewInternal, {
        ...args,
        memberIds: [args.memberIds[0]!, args.memberIds[0]!],
      })
    ).refusal,
  ).toMatch(/distinct/);
  await t.run(async (ctx) => {
    const release = await ctx.db.get(args.memberIds[0]!);
    await ctx.db.patch(release!.editionId, { coverageUnmapped: true });
  });
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toMatch(
    /unmapped/,
  );
});

it("bounds repeated large work facts while refusing a changed dependency", async () => {
  const { t, args } = await fixture();
  await t.run((ctx) => ctx.db.patch(args.seriesId, { synopsis: "a".repeat(40_000) }));
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  expect(new TextEncoder().encode(preview.expected!).length).toBeLessThan(256 * 1024);
  const execution = {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Reviewed large work dependencies",
    dryRun: true,
  };
  expect(await t.mutation(internal.heldBundleCreation.createInternal, execution)).toEqual({
    status: "dryRun",
  });
  await t.run((ctx) => ctx.db.patch(args.seriesId, { synopsis: "b".repeat(40_000) }));
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, { ...execution, dryRun: false }),
  ).toMatchObject({ status: "refused", reason: expect.stringMatching(/dependencies changed/) });
  expect(await t.run((ctx) => ctx.db.query("releaseBundles").collect())).toEqual([]);
});

it("creates audited ordered members without clearing the hold, then refuses the occupied package ISBN", async () => {
  const { t, args } = await fixture();
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  const result = await t.mutation(internal.heldBundleCreation.createInternal, {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Primary exact package and member ISBN review",
    dryRun: false,
  });
  expect(result.status).toBe("created");
  const members = await t.run((ctx) => ctx.db.query("bundleMemberships").collect());
  expect(members.map((m) => ({ releaseId: m.releaseId, order: m.order }))).toEqual(
    args.memberIds.map((releaseId, i) => ({ releaseId, order: i + 1 })),
  );
  expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(1);
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toMatch(
    /unowned/,
  );
});

it("compares a new box position with the package, not the individual member Edition Lines", async () => {
  const { t, args } = await fixture();
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toBeNull();
  expect(
    (
      await t.query(internal.heldBundleCreation.previewInternal, {
        ...args,
        name: "Naruto Box Set 2",
      })
    ).refusal,
  ).toMatch(/position differs/);
});

it("reviews a Complete Box Set qualifier only with resolved source work and full member contents", async () => {
  const { t, args } = await fixture();
  const snapshot = {
    kind: "olEdition",
    key: "/books/OL1M",
    url: "https://openlibrary.org/books/OL1M",
    title: "Naruto Complete Box Set",
    seriesTitle: "Naruto",
    isbn13: args.isbn13,
    format: "physical",
    multiVolume: false,
    publishers: ["VIZ Media"],
    packaging: { lineName: "Box Set", linePosition: null, coverRange: null },
  };
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      sourceKey: "openlibrary",
      sourceRecordId: snapshot.key,
      snapshot,
    }),
  );
  const product = { ...args, name: "Naruto Complete Box Set" };
  const preview = await t.query(internal.heldBundleCreation.previewInternal, product);
  expect(preview.refusal).toBeNull();
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, {
      ...product,
      expected: preview.expected!,
      actor: "alice",
      reason: "Publisher exact package and complete member review",
      dryRun: true,
    }),
  ).toEqual({ status: "dryRun" });
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      snapshot: { ...snapshot, title: "Bleach Complete Box Set" },
    }),
  );
  expect((await t.query(internal.heldBundleCreation.previewInternal, product)).refusal).toMatch(
    /contradict/,
  );
});
