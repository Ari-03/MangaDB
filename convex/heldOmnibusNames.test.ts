import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { makeT } from "./test.helpers";
import {
  insertPublisher,
  insertSeries,
  insertVolume,
  insertEdition,
  insertEditionLine,
  insertCoverage,
  insertRelease,
  insertObservation,
} from "./test.factories";

it("reviews ANN's 3-in-1 name without changing position, contents or source", async () => {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz" });
    const seriesId = await insertSeries(ctx, { title: "Skip Beat!" });
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "Omnibus" });
    const editionId = await insertEdition(ctx, {
      publisherId,
      editionLineId: lineId,
      linePosition: "15",
    });
    const volumeIds = [];
    const coverageIds = [];
    for (const position of [43, 44, 45]) {
      const volumeId = await insertVolume(ctx, { seriesId, position, label: String(position) });
      volumeIds.push(volumeId);
      coverageIds.push(await insertCoverage(ctx, { editionId, volumeId, order: position - 42 }));
    }
    const releaseId = await insertRelease(ctx, {
      publisherId,
      seriesIds: [seriesId],
      editionId,
      isbn13: "9781974736744",
      binding: "paperback",
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:1863",
      recordRef: { type: "series", id: seriesId },
      snapshot: { kind: "annManga", id: "1863", title: "Skip Beat!" },
    });
    const title = "Skip Beat! 3 in 1 Edition";
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:45078",
      snapshot: {
        kind: "annRelease",
        annId: "45078",
        mangaId: "1863",
        title,
        format: "physical",
        label: "15",
        isbn13: "9781974736744",
        multi: false,
        editionLineHint: false,
        url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=45078",
        page: {
          status: "ok",
          fetchedAt: 1,
          mangaId: "1863",
          title,
          volume: "GN 15",
          isbn13: "9781974736744",
          distributor: "Viz Media",
          distributorId: "4552",
        },
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      seriesId,
      sourceKey: "ann",
      kind: "isbn",
      heldAt: 1,
    });
    return {
      publisherId,
      seriesId,
      lineId,
      editionId,
      volumeIds,
      coverageIds,
      releaseId,
      parentId,
      observationId,
      title,
    };
  });
  const args = {
    observationId: ids.observationId,
    target: { type: "release" as const, id: ids.releaseId },
    reviewed: {
      isbn13: "9781974736744",
      seriesId: ids.seriesId,
      publisherId: ids.publisherId,
      volumeIds: ids.volumeIds,
      sourceTitle: ids.title,
      evidenceUrls: ["https://www.simonandschuster.com/books/9781974736744"],
    },
  };
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  expect((await t.query(internal.heldBooks.previewInternal, args)).classification).toBe(
    "linkReady",
  );
  expect(
    (
      await t.query(internal.heldBooks.previewInternal, {
        observationId: args.observationId,
        target: args.target,
      })
    ).refusal,
  ).toBeTruthy();
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, {
      snapshot: { kind: "annManga", id: "1863", title: "Another Work" },
    }),
  );
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, {
      snapshot: { kind: "annManga", id: "1863", title: "Skip Beat!" },
    }),
  );
  const observation = await t.run((ctx) => ctx.db.get(ids.observationId));
  for (const pageChanges of [{ volume: "GN 14" }, { isbn13: "9781974743902" }]) {
    await t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: {
          ...observation!.snapshot,
          page: {
            ...(observation!.snapshot as { page: Record<string, unknown> }).page,
            ...pageChanges,
          },
        },
      }),
    );
    expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  }
  await t.run((ctx) => ctx.db.patch(ids.observationId, { snapshot: observation!.snapshot }));
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "14" }));
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "15" }));
  await t.run((ctx) => ctx.db.patch(ids.lineId, { name: "Collector's Edition" }));
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) => ctx.db.patch(ids.lineId, { name: "Omnibus" }));
  await t.run((ctx) => ctx.db.patch(ids.coverageIds[2]!, { extent: "partial" }));
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) => ctx.db.delete(ids.coverageIds[2]!));
  expect(
    (
      await t.query(internal.heldBooks.previewInternal, {
        ...args,
        reviewed: { ...args.reviewed, volumeIds: ids.volumeIds.slice(0, 2) },
      })
    ).refusal,
  ).toBeTruthy();
});
