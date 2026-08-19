import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const SUBJECT = "user_2reader";

/**
 * One catalog exercising ticket #28's corners: a Series of 3 Volumes with a
 * standard Edition of Vol 1 (one release), an omnibus Edition covering Vols
 * 1–3 completely, and a split digital Edition covering Vol 3 *partially* —
 * completing that split release must not touch any read count.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Kodansha",
      slug: "kodansha",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Vinland Saga",
      altTitles: [],
      searchText: "Vinland Saga",
    });
    const volumes: Array<Id<"volumes">> = [];
    for (const position of [1, 2, 3]) {
      volumes.push(
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: 10 + position,
          seriesId,
          position,
          label: String(position),
        }),
      );
    }
    const [v1, v2, v3] = volumes as [Id<"volumes">, Id<"volumes">, Id<"volumes">];

    const standard = await ctx.db.insert("editions", {
      status: "active",
      publicId: 21,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: standard,
      volumeId: v1,
      order: 1,
      extent: "complete",
    });
    const standardRelease = await ctx.db.insert("releases", {
      status: "active",
      editionId: standard,
      format: "physical",
      binding: "paperback",
      language: "en",
      publisherId,
      seriesIds: [seriesId],
    });

    const omnibus = await ctx.db.insert("editions", {
      status: "active",
      publicId: 22,
      publisherId,
    });
    for (const [order, volumeId] of [v1, v2, v3].entries()) {
      await ctx.db.insert("volumeCoverages", {
        editionId: omnibus,
        volumeId,
        order: order + 1,
        extent: "complete",
      });
    }
    const omnibusRelease = await ctx.db.insert("releases", {
      status: "active",
      editionId: omnibus,
      format: "physical",
      binding: "hardcover",
      language: "en",
      publisherId,
      seriesIds: [seriesId],
    });

    // Split digital edition: only *part* of Vol 3.
    const split = await ctx.db.insert("editions", {
      status: "active",
      publicId: 23,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: split,
      volumeId: v3,
      order: 1,
      extent: "partial",
      note: "First half of volume 3",
    });
    const splitRelease = await ctx.db.insert("releases", {
      status: "active",
      editionId: split,
      format: "digital",
      language: "en",
      publisherId,
      seriesIds: [seriesId],
    });

    return {
      seriesId,
      v1,
      v2,
      v3,
      standardRelease,
      omnibusRelease,
      splitRelease,
    };
  });
}

function signedIn(t: ReturnType<typeof convexTest>, subject = SUBJECT) {
  return t.withIdentity({ subject });
}

async function withUser(t: ReturnType<typeof convexTest>, username = "reader") {
  const as = signedIn(t);
  await as.mutation(api.users.claimUsername, { username });
  return as;
}

async function readCount(
  t: ReturnType<typeof convexTest>,
  volumeId: Id<"volumes">,
): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("volumeProgress").collect();
    return rows.find((row) => row.volumeId === volumeId)?.readCount ?? 0;
  });
}

describe("reading.seriesTracking", () => {
  it("is null signed out — public pages just omit the overlay", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.reading.seriesTracking, { seriesPublicId: 1 })).toBeNull();
  });

  it("is null while the username claim is pending", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(
      await signedIn(t).query(api.reading.seriesTracking, { seriesPublicId: 1 }),
    ).toBeNull();
  });

  it("returns every active volume with zero counts before any tracking", async () => {
    const t = convexTest(schema);
    await seed(t);
    const as = await withUser(t);
    const tracking = await as.query(api.reading.seriesTracking, { seriesPublicId: 1 });
    expect(tracking?.readingStatus).toBeNull();
    expect(tracking?.passes).toEqual([]);
    expect(tracking?.volumes.map((v) => v.readCount)).toEqual([0, 0, 0]);
  });
});

describe("reading.setSeriesReadingStatus", () => {
  it("sets and clears the status by explicit choice", async () => {
    const t = convexTest(schema);
    const { seriesId } = await seed(t);
    const as = await withUser(t);

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

  it("requires a signed-in user with a claimed username", async () => {
    const t = convexTest(schema);
    const { seriesId } = await seed(t);
    await expect(
      t.mutation(api.reading.setSeriesReadingStatus, { seriesId, status: "reading" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      signedIn(t).mutation(api.reading.setSeriesReadingStatus, {
        seriesId,
        status: "reading",
      }),
    ).rejects.toThrow(/username/i);
  });
});

describe("reading.startPass", () => {
  it("creates at most one pass per release and suggests Reading without setting it", async () => {
    const t = convexTest(schema);
    const { standardRelease, seriesId } = await seed(t);
    const as = await withUser(t);

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
    const t = convexTest(schema);
    const { standardRelease, seriesId } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { standardRelease, v1 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { standardRelease, omnibusRelease } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { omnibusRelease, v1, v2, v3 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { splitRelease, v3 } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.reading.startPass, { releaseId: splitRelease });
    const result = await as.mutation(api.reading.completePass, {
      releaseId: splitRelease,
    });
    expect(await readCount(t, v3)).toBe(0);
    expect(result.suggestCompleted).toEqual([]);
  });

  it("does not suggest completing the series while volumes remain unread", async () => {
    const t = convexTest(schema);
    const { standardRelease } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.reading.startPass, { releaseId: standardRelease });
    const result = await as.mutation(api.reading.completePass, {
      releaseId: standardRelease,
    });
    // Only Vol 1 of 3 is read.
    expect(result.suggestCompleted).toEqual([]);
  });

  it("requires an active pass — completion is always a confirmed pass", async () => {
    const t = convexTest(schema);
    const { standardRelease } = await seed(t);
    const as = await withUser(t);
    await expect(
      as.mutation(api.reading.completePass, { releaseId: standardRelease }),
    ).rejects.toThrow(/pass/i);
  });

  it("records a reread on another completed pass", async () => {
    const t = convexTest(schema);
    const { standardRelease, v1 } = await seed(t);
    const as = await withUser(t);
    for (let i = 0; i < 2; i++) {
      await as.mutation(api.reading.startPass, { releaseId: standardRelease });
      await as.mutation(api.reading.completePass, { releaseId: standardRelease });
    }
    expect(await readCount(t, v1)).toBe(2);
  });
});

describe("reading.undoCompletion", () => {
  it("decrements the most recent completion and restores the pass at 100%", async () => {
    const t = convexTest(schema);
    const { omnibusRelease, v1, v2, v3 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { standardRelease, v1 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { standardRelease, v1 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { standardRelease, v1 } = await seed(t);
    const as = await withUser(t);
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
    const t = convexTest(schema);
    const { v2 } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 2 });
    expect(await readCount(t, v2)).toBe(2);
    await as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 0 });
    const rows = await t.run(
      async (ctx) => await ctx.db.query("volumeProgress").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects negative and fractional counts", async () => {
    const t = convexTest(schema);
    const { v2 } = await seed(t);
    const as = await withUser(t);
    await expect(
      as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: -1 }),
    ).rejects.toThrow(/whole number/);
    await expect(
      as.mutation(api.reading.setVolumeReadCount, { volumeId: v2, readCount: 1.5 }),
    ).rejects.toThrow(/whole number/);
  });
});

describe("reading.passForRelease", () => {
  it("distinguishes signed out (null) from signed in without a pass", async () => {
    const t = convexTest(schema);
    const { standardRelease } = await seed(t);
    expect(
      await t.query(api.reading.passForRelease, { releaseId: standardRelease }),
    ).toBeNull();
    const as = await withUser(t);
    expect(
      await as.query(api.reading.passForRelease, { releaseId: standardRelease }),
    ).toEqual({ pass: null });
  });
});

describe("reading.myReading", () => {
  it("lists chosen statuses with volume progress and active passes", async () => {
    const t = convexTest(schema);
    const { seriesId, standardRelease, omnibusRelease } = await seed(t);
    const as = await withUser(t);
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
    expect(overview?.statuses).toEqual([
      {
        seriesPublicId: 1,
        title: "Vinland Saga",
        readingStatus: "reading",
        volumesRead: 1,
        totalVolumes: 3,
      },
    ]);
    expect(overview?.passes).toHaveLength(1);
    expect(overview?.passes[0]).toMatchObject({
      releaseId: omnibusRelease,
      percent: 40,
      format: "physical",
      binding: "hardcover",
      editionPublicId: 22,
    });
  });

  it("is null signed out", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.reading.myReading, {})).toBeNull();
  });
});
