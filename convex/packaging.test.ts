import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import {
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { EDITOR, MOD, PLAIN, alice, bob, carol, dave, makeT, seedTeam } from "./test.helpers";

async function setup() {
  const t = makeT();
  await seedTeam(t, [alice, bob, carol, dave]);

  // Berserk with Volumes 1–6 and an unmapped "Deluxe 2" from Dark Horse.
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Dark Horse" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Berserk" });
    const volumeIds = [];
    for (let position = 1; position <= 6; position++) volumeIds.push(await insertVolume(ctx, { seriesId, position }));
    const editionLineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "Deluxe" });
    const editionId = await insertEdition(ctx, { publisherId, editionLineId, linePosition: "2", coverageUnmapped: true });
    const releaseId = await insertRelease(ctx, {
      editionId,
      binding: "hardcover",
      isbn13: "9781506711998",
      publisherId,
      seriesIds: [seriesId],
    });
    return { seriesId, editionId, releaseId, volumeIds };
  });
  return { t, ...ids };
}

describe("packaging — Unmapped Packaging queue and mapping", () => {
  it("lists unmapped line members to the Data Team with the Series' Volume labels", async () => {
    const { t, editionId } = await setup();
    const queue = await t.withIdentity({ subject: EDITOR }).query(api.packaging.unmappedQueue, {});
    expect(queue.hasMore).toBe(false);
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      editionId,
      title: "Berserk Deluxe 2",
      lineName: "Deluxe",
      linePosition: "2",
      publisher: "Dark Horse",
      series: { publicId: 1, title: "Berserk" },
      isbns: ["9781506711998"],
      volumeLabels: ["1", "2", "3", "4", "5", "6"],
    });
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.packaging.unmappedQueue, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  it("maps the Edition onto Volumes from..to, clears the flag, and records the Revision", async () => {
    const { t, editionId, releaseId, seriesId, volumeIds } = await setup();
    const result = await t
      .withIdentity({ subject: MOD })
      .mutation(api.packaging.mapEditionCoverage, {
        editionId,
        from: "4",
        to: "6",
        comment: "Dark Horse flap copy: collects volumes 4–6.",
      });
    expect(result.covered).toBe(3);
    await t.run(async (ctx) => {
      const rows = (
        await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", editionId))
          .collect()
      ).sort((a, b) => a.order - b.order);
      expect(rows.map((r) => r.volumeId)).toEqual(volumeIds.slice(3, 6));
      expect(rows.every((r) => r.extent === "complete")).toBe(true);
      expect((await ctx.db.get(editionId))?.coverageUnmapped).toBeUndefined();
      expect((await ctx.db.get(releaseId))?.seriesIds).toEqual([seriesId]);
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "edition").eq("ref.id", editionId))
        .collect();
      expect(revisions.map((r) => r.changes.map((c) => c.field)).flat().sort()).toEqual([
        "coverageUnmapped",
        "volumeCoverage",
      ]);
      expect(revisions.every((r) => r.author.kind === "user")).toBe(true);
    });
    // Gone from the queue.
    const queue = await t.withIdentity({ subject: MOD }).query(api.packaging.unmappedQueue, {});
    expect(queue.rows).toHaveLength(0);
  });

  it("refuses Editors, empty comments, unknown Volumes and backwards ranges", async () => {
    const { t, editionId } = await setup();
    const map = (subject: string, args: { from: string; to: string; comment: string }) =>
      t.withIdentity({ subject }).mutation(api.packaging.mapEditionCoverage, { editionId, ...args });
    await expect(map(EDITOR, { from: "1", to: "3", comment: "x" })).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    await expect(map(MOD, { from: "1", to: "3", comment: "  " })).rejects.toThrow(/commentRequired/);
    await expect(map(MOD, { from: "1", to: "9", comment: "x" })).rejects.toThrow(/unknownVolume/);
    await expect(map(MOD, { from: "3", to: "1", comment: "x" })).rejects.toThrow(/badRange/);
  });
});

describe("packaging — Bookless Series queue", () => {
  it("lists flagged series with their volume count and the ANN entry that built them", async () => {
    const { t, seriesId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(seriesId, { bookless: true });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:2298",
        snapshot: { kind: "annManga" },
        recordRef: { type: "series", id: seriesId },
      });
    });
    const queue = await t.withIdentity({ subject: EDITOR }).query(api.packaging.booklessQueue, {});
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      publicId: 1,
      title: "Berserk",
      volumeCount: 6,
      sources: [{ sourceKey: "ann", recordId: "manga:2298" }],
    });
    await expect(t.withIdentity({ subject: PLAIN }).query(api.packaging.booklessQueue, {})).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
  });
});
