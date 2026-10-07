import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { makeT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import {
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertSeries,
  insertVolume,
} from "./test.factories";

it("reviews an exact second-edition tag while refusing changed work, edition and volume facts", async () => {
  const t = makeT();
  const snapshot = {
    kind: "annRelease",
    annId: "503",
    mangaId: "1214",
    title: "Bastard!! - [2nd Ed]",
    isbn13: "9781591163268",
    format: "physical",
    label: "4",
    multi: false,
    editionLineHint: false,
    page: {
      status: "ok",
      title: "Bastard!! - [2nd Ed]",
      isbn13: "9781591163268",
      mangaId: "1214",
      volume: "GN 4",
      distributor: "VIZ Media",
    },
  };
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz" });
    const seriesId = await insertSeries(ctx, { title: "Bastard!!" });
    const volumeId = await insertVolume(ctx, { seriesId, label: "4", position: 4 });
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "Second Edition" });
    const book = await insertBook(ctx, {
      seriesId,
      publisherId,
      volumeId,
      release: { isbn13: snapshot.isbn13, binding: "paperback" },
    });
    await ctx.db.patch(book.editionId, { editionLineId: lineId, linePosition: "4" });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:1214",
      snapshot: { kind: "annManga", id: "1214", title: "Bastard!!" },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:503",
      snapshot,
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 1,
    });
    return { ...book, publisherId, seriesId, volumeId, lineId, observationId, parentId };
  });
  const args = {
    observationId: ids.observationId,
    target: { type: "release" as const, id: ids.releaseId },
    reviewed: {
      isbn13: snapshot.isbn13,
      seriesId: ids.seriesId,
      publisherId: ids.publisherId,
      volumeIds: [ids.volumeId],
      sourceTitle: snapshot.title,
      evidenceUrls: ["https://openlibrary.org/books/OL8852743M"],
    },
  };
  expect(
    (
      await t.query(internal.heldBooks.previewInternal, {
        observationId: ids.observationId,
        target: args.target,
      })
    ).refusal,
  ).toBeTruthy();
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  await t.run((ctx) => ctx.db.patch(ids.lineId, { name: "First Edition" }));
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) => ctx.db.patch(ids.lineId, { name: "Second Edition" }));
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "5" }));
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "4" }));
  for (const title of [
    "Other Work - [2nd Ed]",
    "Bastard!! - [1st Ed]",
    "Bastard!! - [2nd Ed] [1-3]",
    "Bastard!! - [2nd Ed] [Hardcover]",
  ]) {
    await t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: { ...snapshot, title, page: { ...snapshot.page, title } },
      }),
    );
    expect(
      (
        await t.query(internal.heldBooks.previewInternal, {
          ...args,
          reviewed: { ...args.reviewed, sourceTitle: title },
        })
      ).refusal,
      title,
    ).toBeTruthy();
  }
  await t.run((ctx) => ctx.db.patch(ids.observationId, { snapshot }));
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, { snapshot: { kind: "annManga", id: "1214", title: "Other Work" } }),
  );
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
});
