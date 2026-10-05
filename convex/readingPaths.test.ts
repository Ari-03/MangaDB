import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { insertEditionLine, insertPublisher, insertSeries, insertVolume } from "./test.factories";
import { alice, bob, carol, dave, makeT, seedTeam, signedIn } from "./test.helpers";
import { insertBook, mergeAs } from "./test.moderation";

async function setup() {
  const t = makeT();
  await seedTeam(t, [alice, bob, carol, dave]);
  const catalog = await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { publicId: 100, title: "The 100 Girlfriends" });
    const sevenSeas = await insertPublisher(ctx, {
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    const ghostShip = await insertPublisher(ctx, { name: "Ghost Ship", slug: "ghost-ship" });
    const books = [];
    for (let position = 1; position <= 22; position++) {
      const volumeId = await insertVolume(ctx, { seriesId, position });
      const publisherId = position <= 11 || position === 16 ? sevenSeas : ghostShip;
      books.push({
        ...(await insertBook(ctx, { publisherId, seriesId, volumeId })),
        volumeId,
        publisherId,
      });
    }
    return { seriesId, sevenSeas, ghostShip, books };
  });
  const mod = signedIn(t, bob);
  const args = {
    seriesId: catalog.seriesId,
    publisherIds: [catalog.sevenSeas, catalog.ghostShip],
    expected: [],
    comment: "The imprint change continues the same standard run.",
    confirmImpact: true,
  };
  return { t, mod, args, ...catalog };
}

describe("combined standard reading paths", () => {
  it("combines all 22 books and the library, audits the choice, and undoes it", async () => {
    const { t, mod, args, books, sevenSeas, ghostShip } = await setup();
    const collector = signedIn(t, dave);
    for (const book of [books[0]!, books[11]!]) {
      await collector.mutation(api.collection.setReleaseEntry, {
        releaseId: book.releaseId,
        state: "owned",
      });
    }
    expect((await collector.query(api.collection.myLibrary, {}))?.series[0]?.paths).toHaveLength(2);
    expect((await t.query(api.catalog.seriesPage, { publicId: 100 }))?.editionGroups).toHaveLength(
      2,
    );
    await mod.mutation(api.readingPaths.setCombinedPath, args);
    const page = await t.query(api.catalog.seriesPage, { publicId: 100 });
    expect(page?.editionGroups).toHaveLength(1);
    const group = page!.editionGroups[0]!;
    expect(group.key).toBe("seven-seas");
    expect(group.aliases).toContain("ghost-ship");
    expect(group.books.map((book) => book.coverage[0]?.position)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    const library = await collector.query(api.collection.myLibrary, {});
    expect(library?.series[0]?.paths).toHaveLength(1);
    expect(library?.series[0]?.paths[0]).toMatchObject({ key: group.key, bookCount: 22 });
    expect(library?.series[0]?.paths[0]?.books).toHaveLength(2);
    const history = await t.query(api.moderation.recordHistory, { type: "series", publicId: 100 });
    expect(history?.revisions[0]).toMatchObject({
      comment: args.comment,
      changes: [{ field: "combinedPathPublisherIds", after: [sevenSeas, ghostShip] }],
    });
    const preserved = await t.run(async (ctx) =>
      Promise.all(books.map((book) => ctx.db.get(book.editionId))),
    );
    expect(preserved.map((book) => book?.publisherId)).toEqual(
      books.map((book) => book.publisherId),
    );
    await mod.mutation(api.readingPaths.setCombinedPath, {
      ...args,
      publisherIds: [],
      expected: args.publisherIds,
      comment: "Restore the original display.",
    });
    expect((await t.query(api.catalog.seriesPage, { publicId: 100 }))?.editionGroups).toHaveLength(
      2,
    );
    expect((await collector.query(api.collection.myLibrary, {}))?.series[0]?.paths).toHaveLength(2);
    expect(
      (await t.query(api.moderation.recordHistory, { type: "series", publicId: 100 }))?.revisions,
    ).toHaveLength(2);
  });

  it("refuses signed-out, reader, and editor callers", async () => {
    const { t, args } = await setup();
    await expect(t.mutation(api.readingPaths.setCombinedPath, args)).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    for (const user of [carol, dave]) {
      await expect(
        signedIn(t, user).mutation(api.readingPaths.setCombinedPath, args),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
      await expect(
        signedIn(t, user).query(api.readingPaths.combineForm, { seriesPublicId: 100 }),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });

  it("requires a reason and confirmation, and refuses stale or unchanged saves", async () => {
    const { mod, args } = await setup();
    await expect(
      mod.mutation(api.readingPaths.setCombinedPath, { ...args, comment: " " }),
    ).rejects.toMatchObject({ data: { code: "commentRequired" } });
    await expect(
      mod.mutation(api.readingPaths.setCombinedPath, { ...args, confirmImpact: false }),
    ).rejects.toMatchObject({ data: { code: "confirmRequired" } });
    await mod.mutation(api.readingPaths.setCombinedPath, args);
    await expect(mod.mutation(api.readingPaths.setCombinedPath, args)).rejects.toMatchObject({
      data: { code: "stale" },
    });
    await expect(
      mod.mutation(api.readingPaths.setCombinedPath, { ...args, expected: args.publisherIds }),
    ).rejects.toMatchObject({ data: { code: "noChanges" } });
  });

  it("rejects single, repeated, too many, foreign, and line-only publishers", async () => {
    const { t, mod, args, sevenSeas, seriesId } = await setup();
    const outsider = await t.run((ctx) => insertPublisher(ctx, { name: "Other Press" }));
    const lineOnly = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Deluxe Press" });
      const lineId = await insertEditionLine(ctx, { publisherId, seriesId, name: "Deluxe" });
      const volumeId = await insertVolume(ctx, { seriesId, position: 23 });
      await insertBook(ctx, {
        publisherId,
        seriesId,
        volumeId,
        edition: { editionLineId: lineId },
      });
      return publisherId;
    });
    for (const publisherIds of [
      [sevenSeas],
      [sevenSeas, sevenSeas],
      [sevenSeas, outsider],
      [sevenSeas, lineOnly],
      Array.from({ length: 9 }, () => sevenSeas),
    ]) {
      await expect(
        mod.mutation(api.readingPaths.setCombinedPath, { ...args, publisherIds }),
      ).rejects.toMatchObject({ data: { code: "invalidPublishers" } });
    }
    expect(
      (await t.query(api.moderation.recordHistory, { type: "series", publicId: 100 }))?.revisions,
    ).toHaveLength(0);
  });

  it("refuses overlapping coverage with the volume named", async () => {
    const { t, mod, args, seriesId, sevenSeas, books } = await setup();
    await t.run((ctx) =>
      insertBook(ctx, { publisherId: sevenSeas, seriesId, volumeId: books[11]!.volumeId }),
    );
    await expect(mod.mutation(api.readingPaths.setCombinedPath, args)).rejects.toMatchObject({
      data: { code: "overlappingCoverage", message: expect.stringContaining("Vol. 12") },
    });
  });

  it("counts books on hidden lines in the preview and overlap check, as the catalog does", async () => {
    const { t, mod, args, seriesId, sevenSeas, books } = await setup();
    await t.run(async (ctx) => {
      const lineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId: sevenSeas,
        name: "Hidden line",
        status: "hidden",
      });
      await insertBook(ctx, {
        publisherId: sevenSeas,
        seriesId,
        volumeId: books[11]!.volumeId,
        edition: { editionLineId: lineId },
      });
    });
    const form = await mod.query(api.readingPaths.combineForm, { seriesPublicId: 100 });
    expect(form?.runs.find((run) => run.publisher.id === sevenSeas)?.books).toHaveLength(13);
    await expect(mod.mutation(api.readingPaths.setCombinedPath, args)).rejects.toMatchObject({
      data: { code: "overlappingCoverage", message: expect.stringContaining("Vol. 12") },
    });
  });

  it("drops unavailable run members from the choices while retaining raw IDs for stale checks", async () => {
    const { t, mod, args, ghostShip, sevenSeas, books } = await setup();
    await mod.mutation(api.readingPaths.setCombinedPath, args);
    await t.run(async (ctx) => {
      for (const book of books.filter((book) => book.publisherId === ghostShip)) {
        await ctx.db.patch(book.editionId, { status: "hidden" });
      }
    });
    const form = await mod.query(api.readingPaths.combineForm, { seriesPublicId: 100 });
    expect(form?.currentPublisherIds).toEqual(args.publisherIds);
    expect(form?.selectedPublisherIds).toEqual([sevenSeas]);
    expect(form?.runs.map((run) => run.publisher.id)).toEqual([sevenSeas]);
    await mod.mutation(api.readingPaths.setCombinedPath, {
      ...args,
      expected: form!.currentPublisherIds,
      publisherIds: [],
    });
    expect(
      (await mod.query(api.readingPaths.combineForm, { seriesPublicId: 100 }))?.currentPublisherIds,
    ).toEqual([]);
  });

  it("keeps later imported overlap visible and still allows undo", async () => {
    const { t, mod, args, seriesId, sevenSeas, books } = await setup();
    await mod.mutation(api.readingPaths.setCombinedPath, args);
    await t.run((ctx) =>
      insertBook(ctx, { publisherId: sevenSeas, seriesId, volumeId: books[11]!.volumeId }),
    );
    expect(
      (await t.query(api.catalog.seriesPage, { publicId: 100 }))?.editionGroups[0]?.books,
    ).toHaveLength(23);
    await mod.mutation(api.readingPaths.setCombinedPath, {
      ...args,
      expected: args.publisherIds,
      publisherIds: [],
    });
    expect((await t.query(api.catalog.seriesPage, { publicId: 100 }))?.editionGroups).toHaveLength(
      2,
    );
  });

  it.each([{ locked: true }, { status: "hidden" as const }, { status: "merged" as const }])(
    "refuses an unavailable series %j",
    async (patch) => {
      const { t, mod, args, seriesId } = await setup();
      await t.run((ctx) => ctx.db.patch(seriesId, patch));
      await expect(mod.mutation(api.readingPaths.setCombinedPath, args)).rejects.toMatchObject({
        data: { code: "locked" },
      });
    },
  );

  it("follows publisher merges and permits undo after a member is hidden", async () => {
    const { t, mod, args, ghostShip } = await setup();
    await mod.mutation(api.readingPaths.setCombinedPath, args);
    const successor = await t.run((ctx) =>
      insertPublisher(ctx, { name: "New Imprint", slug: "new-imprint" }),
    );
    await mergeAs(t, { type: "publisher", id: successor }, { type: "publisher", id: ghostShip });
    const group = (await t.query(api.catalog.seriesPage, { publicId: 100 }))?.editionGroups[0];
    expect(group?.books).toHaveLength(22);
    expect(group?.aliases).toContain("ghost-ship");
    expect(group?.publishers.map((publisher) => publisher.slug)).toEqual([
      "seven-seas",
      "new-imprint",
    ]);
    await t.run((ctx) => ctx.db.patch(successor, { status: "hidden" }));
    await mod.mutation(api.readingPaths.setCombinedPath, {
      ...args,
      expected: args.publisherIds,
      publisherIds: [],
    });
    expect(
      (await mod.query(api.readingPaths.combineForm, { seriesPublicId: 100 }))?.currentPublisherIds,
    ).toEqual([]);
  });
});
