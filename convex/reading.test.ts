import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { makeT, reader, withUser, type TestT } from "./test.helpers";
import { describeNoViewer } from "./test.tracking";

const OTHER = { subject: "user_2other", username: "other" };

/**
 * One catalog exercising ticket #28's corners: a Series of 3 Volumes with a
 * standard Edition of Vol 1 (one release), an omnibus Edition covering Vols
 * 1–3 completely, and a split digital Edition covering Vol 3 *partially* —
 * completing that split release must not touch any read count. `as` is the
 * reader, signed in with their username claimed.
 */
async function setup() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Vinland Saga" });
    const volumes: Array<Id<"volumes">> = [];
    for (const position of [1, 2, 3]) {
      volumes.push(await insertVolume(ctx, { seriesId, publicId: 10 + position, position }));
    }
    const [v1, v2, v3] = volumes as [Id<"volumes">, Id<"volumes">, Id<"volumes">];
    const release = { publisherId, seriesIds: [seriesId] };

    const standard = await insertEdition(ctx, { publicId: 21, publisherId });
    await insertCoverage(ctx, { editionId: standard, volumeId: v1 });
    const standardRelease = await insertRelease(ctx, { ...release, editionId: standard, binding: "paperback" });

    const omnibus = await insertEdition(ctx, { publicId: 22, publisherId });
    for (const [order, volumeId] of [v1, v2, v3].entries()) {
      await insertCoverage(ctx, { editionId: omnibus, volumeId, order: order + 1 });
    }
    const omnibusRelease = await insertRelease(ctx, { ...release, editionId: omnibus, binding: "hardcover" });

    // Split digital edition: only *part* of Vol 3.
    const split = await insertEdition(ctx, { publicId: 23, publisherId });
    await insertCoverage(ctx, {
      editionId: split,
      volumeId: v3,
      extent: "partial",
      note: "First half of volume 3",
    });
    const splitRelease = await insertRelease(ctx, { ...release, editionId: split, format: "digital" });

    return { seriesId, v1, v2, v3, omnibus, standardRelease, omnibusRelease, splitRelease };
  });
  const as = await withUser(t, reader);
  return { t, as, ...ids };
}

async function readCount(t: TestT, volumeId: Id<"volumes">): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("volumeProgress").collect();
    return rows.find((row) => row.volumeId === volumeId)?.readCount ?? 0;
  });
}

describeNoViewer(setup, {
  queries: [
    ["seriesTracking", (as) => as.query(api.reading.seriesTracking, { seriesPublicId: 1 })],
    ["passForRelease", (as, { standardRelease }) => as.query(api.reading.passForRelease, { releaseId: standardRelease })],
    ["myReading", (as) => as.query(api.reading.myReading, {})],
  ],
  mutations: [
    [
      "setSeriesReadingStatus",
      (as, { seriesId }) => as.mutation(api.reading.setSeriesReadingStatus, { seriesId, status: "reading" }),
    ],
    ["startPass", (as, { standardRelease }) => as.mutation(api.reading.startPass, { releaseId: standardRelease })],
    [
      "setPassPercent",
      (as, { standardRelease }) => as.mutation(api.reading.setPassPercent, { releaseId: standardRelease, percent: 50 }),
    ],
    ["completePass", (as, { standardRelease }) => as.mutation(api.reading.completePass, { releaseId: standardRelease })],
    [
      "undoCompletion",
      (as, { standardRelease }) =>
        as.mutation(api.reading.undoCompletion, { releaseId: standardRelease, completedAt: 1 }),
    ],
    ["cancelPass", (as, { standardRelease }) => as.mutation(api.reading.cancelPass, { releaseId: standardRelease })],
    ["setVolumeReadCount", (as, { v1 }) => as.mutation(api.reading.setVolumeReadCount, { volumeId: v1, readCount: 1 })],
    ["adjustVolumeReadCount", (as, { v1 }) => as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v1, delta: 1 })],
    ["setEditionRead", (as) => as.mutation(api.reading.setEditionRead, { editionPublicId: 22, read: true })],
    ["setEditionsRead", (as) => as.mutation(api.reading.setEditionsRead, { editionPublicIds: [21, 22], read: true })],
  ],
});

describe("reading.seriesTracking", () => {
  it("returns every active volume with zero counts before any tracking", async () => {
    const { as } = await setup();
    const tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBeNull();
    expect(tracking?.passes).toEqual([]);
    expect(tracking?.volumes.map((v) => v.readCount)).toEqual([0, 0, 0]);
  });

  it("counts the viewer's reads per volume, never another user's", async () => {
    const { t, as, v1, v2 } = await setup();
    const other = await withUser(t, OTHER);
    await other.mutation(api.reading.adjustVolumeReadCount, { volumeId: v1, delta: 2 });
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 });
    const tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.volumes.map((v) => v.readCount)).toEqual([0, 1, 0]);
  });
});

describe("reading.setSeriesReadingStatus", () => {
  it("sets and clears the status by explicit choice", async () => {
    const { as, seriesId } = await setup();

    await as.mutation(api.reading.setSeriesReadingStatus, {
      seriesId,
      status: "planToRead",
    });
    let tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBe("planToRead");

    await as.mutation(api.reading.setSeriesReadingStatus, { seriesId });
    tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBeNull();
  });
});

describe("reading.startPass", () => {
  it("creates at most one pass per release and suggests Reading without setting it", async () => {
    const { as, standardRelease, seriesId } = await setup();

    const first = await as.mutation(api.reading.startPass, {
      releaseId: standardRelease,
    });
    // The prompt material: this series is not in "Reading".
    expect(first.suggestReading).toEqual([
      { seriesId, title: "Vinland Saga" },
    ]);

    // Declining the prompt changes nothing: the status stays unchosen.
    const tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBeNull();
    expect(tracking?.passes).toEqual([
      { releaseId: standardRelease, percent: null },
    ]);

    // Starting again is a no-op, not a second pass.
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const after = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(after?.passes).toHaveLength(1);
  });

  it("does not suggest Reading when the series is already being read", async () => {
    const { as, standardRelease, seriesId } = await setup();
    await as.mutation(api.reading.setSeriesReadingStatus, {
      seriesId,
      status: "reading",
    });
    const result = await as.mutation(api.reading.startPass, {
      releaseId: standardRelease,
    });
    expect(result.suggestReading).toEqual([]);
  });
});

describe("reading.setPassPercent", () => {
  it("stores the estimate and 100% never completes by itself", async () => {
    const { t, as, standardRelease, v1 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });

    await as.mutation(api.reading.setPassPercent, {
      releaseId: standardRelease,
      percent: 100,
    });
    const state = await as.query(api.reading.passForRelease, {
      releaseId: standardRelease,
    });
    // The pass is still active and no count changed: only confirmation
    // (completePass) completes.
    expect(state?.pass).toEqual({ percent: 100 });
    expect(await readCount(t, v1)).toBe(0);
  });

  it("rejects out-of-range estimates and percent without a pass", async () => {
    const { as, standardRelease, omnibusRelease } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    await expect(
      as.mutation(api.reading.setPassPercent, {
        releaseId: standardRelease,
        percent: 101,
      }),
    ).rejects.toThrow(/0 and 100/);
    await expect(
      as.mutation(api.reading.setPassPercent, {
        releaseId: omnibusRelease,
        percent: 50,
      }),
    ).rejects.toThrow(/pass/i);
  });
});

describe("reading.completePass", () => {
  it("increments every completely covered volume and removes the pass", async () => {
    const { t, as, omnibusRelease, v1, v2, v3 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: omnibusRelease });

    const result = await as.mutation(api.reading.completePass, {
      releaseId: omnibusRelease,
    });
    expect(await readCount(t, v1)).toBe(1);
    expect(await readCount(t, v2)).toBe(1);
    expect(await readCount(t, v3)).toBe(1);
    // All three volumes read → the completed-series prompt is suggested…
    expect(result.suggestCompleted.map((s) => s.title)).toEqual(["Vinland Saga"]);
    // …but nothing set the status: declining leaves it untouched.
    const tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBeNull();
    expect(tracking?.passes).toEqual([]);
  });

  it("leaves partially covered volumes untouched", async () => {
    const { t, as, splitRelease, v3 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: splitRelease });
    const result = await as.mutation(api.reading.completePass, {
      releaseId: splitRelease,
    });
    expect(await readCount(t, v3)).toBe(0);
    expect(result.suggestCompleted).toEqual([]);
  });

  it("does not suggest completing the series while volumes remain unread", async () => {
    const { as, standardRelease } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const result = await as.mutation(api.reading.completePass, {
      releaseId: standardRelease,
    });
    // Only Vol 1 of 3 is read.
    expect(result.suggestCompleted).toEqual([]);
  });

  it("requires an active pass — completion is always a confirmed pass", async () => {
    const { as, standardRelease } = await setup();
    await expect(
      as.mutation(api.reading.completePass, { releaseId: standardRelease }),
    ).rejects.toThrow(/pass/i);
  });

  it("records a reread on another completed pass", async () => {
    const { t, as, standardRelease, v1 } = await setup();
    for (let i = 0; i < 2; i++) {
      await as.mutation(api.reading.startPass, { releaseId: standardRelease });
      await as.mutation(api.reading.completePass, { releaseId: standardRelease });
    }
    expect(await readCount(t, v1)).toBe(2);
  });
});

describe("reading.undoCompletion", () => {
  it("decrements the most recent completion and restores the pass at 100%", async () => {
    const { t, as, omnibusRelease, v1, v2, v3 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: omnibusRelease });
    const { completedAt } = await as.mutation(api.reading.completePass, {
      releaseId: omnibusRelease,
    });

    const undo = await as.mutation(api.reading.undoCompletion, {
      releaseId: omnibusRelease,
      completedAt,
    });
    expect(undo.decremented).toBe(3);
    expect(await readCount(t, v1)).toBe(0);
    expect(await readCount(t, v2)).toBe(0);
    expect(await readCount(t, v3)).toBe(0);
    const state = await as.query(api.reading.passForRelease, {
      releaseId: omnibusRelease,
    });
    expect(state?.pass).toEqual({ percent: 100 });
  });

  it("decrements a reread back down without erasing earlier reads", async () => {
    const { t, as, standardRelease, v1 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    await as.mutation(api.reading.completePass, { releaseId: standardRelease });
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const second = await as.mutation(api.reading.completePass, {
      releaseId: standardRelease,
    });

    await as.mutation(api.reading.undoCompletion, {
      releaseId: standardRelease,
      completedAt: second.completedAt,
    });
    expect(await readCount(t, v1)).toBe(1);
  });

  it("is a no-op for a stale undo once a newer completion superseded it", async () => {
    const { t, as, standardRelease, v1 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const first = await as.mutation(api.reading.completePass, {
      releaseId: standardRelease,
    });
    // A reread completes later; ensure a distinct timestamp.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const second = await as.mutation(api.reading.completePass, {
      releaseId: standardRelease,
    });
    expect(second.completedAt).not.toBe(first.completedAt);

    // Undoing the *older* completion touches nothing and restores no pass.
    const undo = await as.mutation(api.reading.undoCompletion, {
      releaseId: standardRelease,
      completedAt: first.completedAt,
    });
    expect(undo.decremented).toBe(0);
    expect(await readCount(t, v1)).toBe(2);
    const state = await as.query(api.reading.passForRelease, {
      releaseId: standardRelease,
    });
    expect(state?.pass).toBeNull();
  });
});

describe("reading.cancelPass", () => {
  it("abandons the pass without touching any read count", async () => {
    const { t, as, standardRelease, v1 } = await setup();
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    await as.mutation(api.reading.setPassPercent, {
      releaseId: standardRelease,
      percent: 80,
    });
    await as.mutation(api.reading.cancelPass, { releaseId: standardRelease });
    const state = await as.query(api.reading.passForRelease, {
      releaseId: standardRelease,
    });
    expect(state?.pass).toBeNull();
    expect(await readCount(t, v1)).toBe(0);
  });
});

describe("reading.setVolumeReadCount", () => {
  it("edits the count directly and zero removes the row", async () => {
    const { t, as, v2 } = await setup();
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 2 });
    expect(await readCount(t, v2)).toBe(2);
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 0 });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("volumeProgress").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects negative and fractional counts", async () => {
    const { as, v2 } = await setup();
    await expect(
      as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: -1 }),
    ).rejects.toThrow(/whole number/);
    await expect(
      as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 1.5 }),
    ).rejects.toThrow(/whole number/);
  });
});

describe("reading.adjustVolumeReadCount", () => {
  it("applies each delta to the stored count, so concurrent clicks all land", async () => {
    const { t, as, v2 } = await setup();
    await Promise.all([
      as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 }),
      as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 }),
      as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 }),
    ]);
    expect(await readCount(t, v2)).toBe(3);
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: -1 });
    expect(await readCount(t, v2)).toBe(2);
  });

  it("keeps the completion time on a take-back and stamps it on a read", async () => {
    const { t, as, v2 } = await setup();
    const completedAt = async () =>
      await t.run(async (ctx) => (await ctx.db.query("volumeProgress").first())?.lastCompletedAt);
    await t.run(async (ctx) => {
      const volume = (await ctx.db.get(v2))!;
      await ctx.db.insert("volumeProgress", {
        userId: (await ctx.db.query("users").first())!._id,
        volumeId: v2,
        seriesId: volume.seriesId,
        readCount: 2,
        lastCompletedAt: 1,
      });
    });
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: -1 });
    expect(await completedAt()).toBe(1);
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 });
    expect(await completedAt()).toBeGreaterThan(1);
  });

  it("stops at zero, removing the row", async () => {
    const { t, as, v2 } = await setup();
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 });
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: -1 });
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: -1 });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("volumeProgress").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a Volume of a hidden Series, keeping reads recorded before", async () => {
    const { t, as, seriesId, v2 } = await setup();
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 });
    await t.run(async (ctx) => await ctx.db.patch(seriesId, { status: "hidden" }));
    await expect(
      as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 1 }),
    ).rejects.toThrow(/Volume not found/);
    expect(await readCount(t, v2)).toBe(1);
  });

  it("rejects fractional deltas", async () => {
    const { as, v2 } = await setup();
    await expect(
      as.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: 0.5 }),
    ).rejects.toThrow(/whole number/);
  });
});

describe("reading.passForRelease", () => {
  it("distinguishes signed out (null) from signed in without a pass", async () => {
    const { t, as, standardRelease } = await setup();
    expect(
      await t.query(api.reading.passForRelease, { releaseId: standardRelease }),
    ).toBeNull();
    expect(
      await as.query(api.reading.passForRelease, { releaseId: standardRelease }),
    ).toEqual({ pass: null });
  });
});

describe("reading.myReading", () => {
  it("lists chosen statuses with volume progress and active passes", async () => {
    const { as, seriesId, standardRelease, omnibusRelease } = await setup();
    await as.mutation(api.reading.setSeriesReadingStatus, {
      seriesId,
      status: "reading",
    });
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    await as.mutation(api.reading.completePass, { releaseId: standardRelease });
    await as.mutation(api.reading.startPass, { releaseId: omnibusRelease });
    await as.mutation(api.reading.setPassPercent, {
      releaseId: omnibusRelease,
      percent: 40,
    });

    const overview = await as.query(api.reading.myReading, {});
    expect(overview?.series).toHaveLength(1);
    expect(overview?.series[0]).toMatchObject({
      seriesId,
      seriesPublicId: 1,
      title: "Vinland Saga",
      readingStatus: "reading",
      volumesRead: 1,
      totalVolumes: 3,
      coverUrl: null,
      coverIsbn: null,
    });
    expect(overview?.series[0]?.passes).toHaveLength(1);
    expect(overview?.series[0]?.passes[0]).toMatchObject({
      releaseId: omnibusRelease,
      percent: 40,
      format: "physical",
      binding: "hardcover",
      editionPublicId: 22,
    });
  });

  it("a series with only a read volume still appears, with no status", async () => {
    const { as, v2 } = await setup();
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 1 });
    const overview = await as.query(api.reading.myReading, {});
    expect(overview?.series).toHaveLength(1);
    expect(overview?.series[0]).toMatchObject({
      readingStatus: null,
      volumesRead: 1,
      totalVolumes: 3,
      passes: [],
    });
  });
});

describe("reading.setEditionRead", () => {
  it("marks every completely covered volume read once, keeping rereads", async () => {
    const { t, as, v1, v2, v3 } = await setup();
    // Vol 2 was already read twice; marking the omnibus read must not touch it.
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 2 });

    const result = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 22,
      read: true,
    });
    expect(result.changed).toBe(2);
    expect(await readCount(t, v1)).toBe(1);
    expect(await readCount(t, v2)).toBe(2);
    expect(await readCount(t, v3)).toBe(1);
    // Every volume now read and no status yet: the completed prompt fires.
    expect(result.suggestCompleted).toEqual([
      { seriesId: expect.anything(), title: "Vinland Saga" },
    ]);

    // Idempotent: nothing left to mark.
    const again = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 22,
      read: true,
    });
    expect(again.changed).toBe(0);
  });

  it("unmarking clears the read history of the covered volumes only", async () => {
    const { t, as, v1, v2, v3 } = await setup();
    await as.mutation(api.reading.setEditionRead, { editionPublicId: 22, read: true });
    const result = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 21,
      read: false,
    });
    expect(result.changed).toBe(1);
    expect(result.suggestCompleted).toEqual([]);
    expect(await readCount(t, v1)).toBe(0);
    expect(await readCount(t, v2)).toBe(1);
    expect(await readCount(t, v3)).toBe(1);
  });

  it("partial coverage is never touched", async () => {
    const { t, as, v3 } = await setup();
    const result = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 23,
      read: true,
    });
    expect(result.changed).toBe(0);
    expect(await readCount(t, v3)).toBe(0);
  });

  it("leaves a hidden Series' Volumes alone, and the library's read flag agrees", async () => {
    const { t, as, v1, omnibus, omnibusRelease } = await setup();
    // The omnibus also collects a Volume of a second Series.
    const { otherSeries, other } = await t.run(async (ctx) => {
      const otherSeries = await insertSeries(ctx, { publicId: 2, title: "Planetes" });
      const other = await insertVolume(ctx, { seriesId: otherSeries, publicId: 31 });
      await insertCoverage(ctx, { editionId: omnibus, volumeId: other, order: 4 });
      return { otherSeries, other };
    });
    await as.mutation(api.reading.adjustVolumeReadCount, { volumeId: other, delta: 1 });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: omnibusRelease, state: "owned" });
    await t.run(async (ctx) => await ctx.db.patch(otherSeries, { status: "hidden" }));

    // Unmarking clears the visible Volumes only: the hidden one's read stays.
    await as.mutation(api.reading.setEditionRead, { editionPublicId: 22, read: true });
    const unread = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 22,
      read: false,
    });
    expect(unread.changed).toBe(3);
    expect(await readCount(t, v1)).toBe(0);
    expect(await readCount(t, other)).toBe(1);

    // Marking writes the visible Volumes only, and the shelf reads it as read.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("volumeProgress")
        .withIndex("by_volume", (q) => q.eq("volumeId", other))
        .unique();
      await ctx.db.delete(row!._id);
    });
    const read = await as.mutation(api.reading.setEditionRead, {
      editionPublicId: 22,
      read: true,
    });
    expect(read.changed).toBe(3);
    expect(await readCount(t, other)).toBe(0);
    const library = await as.query(api.collection.myLibrary, {});
    const book = library?.series[0]?.paths[0]?.books.find((b) => b.editionPublicId === 22);
    expect(book?.read).toBe(true);
  });

  it("rejects an unknown edition", async () => {
    const { as } = await setup();
    await expect(
      as.mutation(api.reading.setEditionRead, { editionPublicId: 99, read: true }),
    ).rejects.toMatchObject({ data: { code: "notFound" } });
  });
});

describe("reading.setEditionsRead", () => {
  it("marks a whole run, prompting once, and honours the cap", async () => {
    const { t, as, v1, v2, v3 } = await setup();
    const result = await as.mutation(api.reading.setEditionsRead, {
      editionPublicIds: [21, 22, 22, 23],
      read: true,
    });
    // Vol 1 through the standard edition, Vols 2–3 through the omnibus (Vol 1
    // already read by then); the partial split touches nothing.
    expect(result.changed).toBe(3);
    expect(await readCount(t, v1)).toBe(1);
    expect(await readCount(t, v2)).toBe(1);
    expect(await readCount(t, v3)).toBe(1);
    expect(result.suggestCompleted).toEqual([
      { seriesId: expect.anything(), title: "Vinland Saga" },
    ]);

    const cleared = await as.mutation(api.reading.setEditionsRead, {
      editionPublicIds: [21],
      read: false,
    });
    expect(cleared).toEqual({ changed: 1, suggestCompleted: [] });
    expect(await readCount(t, v1)).toBe(0);

    await expect(
      as.mutation(api.reading.setEditionsRead, {
        editionPublicIds: Array.from({ length: 201 }, (_, i) => i),
        read: true,
      }),
    ).rejects.toMatchObject({ data: { code: "tooMany" } });
  });
});

describe("reading progress belongs to one user", () => {
  it("another user neither sees the reader's progress nor changes it", async () => {
    const { t, as, seriesId, v2, standardRelease, omnibusRelease } = await setup();
    await as.mutation(api.reading.setSeriesReadingStatus, { seriesId, status: "reading" });
    await as.mutation(api.reading.startPass, { releaseId: omnibusRelease });
    const { completedAt } = await as.mutation(api.reading.completePass, { releaseId: omnibusRelease });
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 2 });
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    await as.mutation(api.reading.setPassPercent, { releaseId: standardRelease, percent: 40 });
    const readerTracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    const readerOverview = await as.query(api.reading.myReading, {});
    expect(readerTracking?.volumes.map((v) => v.readCount)).toEqual([1, 2, 1]);

    const other = await withUser(t, OTHER);
    // Their overlays read as untracked.
    expect(await other.query(api.reading.seriesTracking, { seriesPublicId: 1 })).toMatchObject({
      readingStatus: null,
      passes: [],
    });
    expect(
      (await other.query(api.reading.seriesTracking, { seriesPublicId: 1 }))?.volumes.map((v) => v.readCount),
    ).toEqual([0, 0, 0]);
    expect(await other.query(api.reading.passForRelease, { releaseId: standardRelease })).toEqual({ pass: null });
    expect(await other.query(api.reading.myReading, {})).toMatchObject({ series: [] });

    // The reader's pass is not theirs to move, complete or cancel.
    await expect(
      other.mutation(api.reading.setPassPercent, { releaseId: standardRelease, percent: 90 }),
    ).rejects.toMatchObject({ data: { code: "noPass" } });
    await expect(
      other.mutation(api.reading.completePass, { releaseId: standardRelease }),
    ).rejects.toMatchObject({ data: { code: "noPass" } });
    await other.mutation(api.reading.cancelPass, { releaseId: standardRelease });
    // Nor are the reader's completion, read counts or status theirs to undo.
    expect(
      await other.mutation(api.reading.undoCompletion, { releaseId: omnibusRelease, completedAt }),
    ).toEqual({ decremented: 0 });
    expect(await other.mutation(api.reading.setEditionRead, { editionPublicId: 22, read: false })).toMatchObject({
      changed: 0,
    });
    await other.mutation(api.reading.adjustVolumeReadCount, { volumeId: v2, delta: -1 });
    await other.mutation(api.reading.setSeriesReadingStatus, { seriesId });

    expect(await as.query(api.reading.seriesTracking, { seriesPublicId: 1 })).toEqual(readerTracking);
    expect(await as.query(api.reading.myReading, {})).toEqual(readerOverview);
    expect(await as.query(api.reading.passForRelease, { releaseId: standardRelease })).toEqual({
      pass: { percent: 40 },
    });
  });
});
