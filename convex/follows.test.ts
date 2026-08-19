import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const SUBJECT = "user_2follower";

// The fixed "today" every test computes against: Aug 19, 2026 (yyyymmdd).
const TODAY = 20260819;

/**
 * A catalog exercising ticket #29's corners around TODAY: a followed-able
 * Series A with physical/digital future Releases, a dated-earlier-this-month
 * Release, and a day-TBA Release of the current month; an unrelated Series B
 * with a future digital Release; and a future box set bundling Series A's
 * physical Release — so the preference clause, the Wanted/Ordered clause,
 * dedup, and both Owned exclusions (direct and derived) are all reachable.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });

    let nextPublicId = 1;
    const makeSeries = async (title: string) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: nextPublicId++,
        title,
        altTitles: [],
        searchText: title,
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 100 + nextPublicId,
        seriesId,
        position: 1,
        label: "1",
      });
      return { seriesId, volumeId };
    };
    const a = await makeSeries("Witch Hat Atelier");
    const b = await makeSeries("Dungeon Meshi");

    const makeRelease = async (
      series: { seriesId: Id<"series">; volumeId: Id<"volumes"> },
      format: "physical" | "digital",
      pubDate: { year: number; month?: number; day?: number; sort: number },
    ) => {
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 200 + nextPublicId++,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: series.volumeId,
        order: 1,
        extent: "complete",
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format,
        language: "en",
        pubDate,
        publisherId,
        seriesIds: [series.seriesId],
      });
    };

    const aFuturePhysical = await makeRelease(a, "physical", {
      year: 2026,
      month: 9,
      day: 15,
      sort: 20260915,
    });
    const aFutureDigital = await makeRelease(a, "digital", {
      year: 2026,
      month: 9,
      day: 20,
      sort: 20260920,
    });
    const aPastThisMonth = await makeRelease(a, "physical", {
      year: 2026,
      month: 8,
      day: 10,
      sort: 20260810,
    });
    const aTbaThisMonth = await makeRelease(a, "physical", {
      year: 2026,
      month: 8,
      sort: 20260800,
    });
    const bFutureDigital = await makeRelease(b, "digital", {
      year: 2026,
      month: 10,
      day: 1,
      sort: 20261001,
    });

    const bundleId = await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 41,
      name: "Witch Hat Atelier Box Set",
      publisherId,
      format: "physical",
      pubDate: { year: 2026, month: 11, day: 5, sort: 20261105 },
    });
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId: aFuturePhysical,
      order: 1,
    });
    const undatedBundleId = await ctx.db.insert("releaseBundles", {
      status: "active",
      publicId: 42,
      name: "Unannounced Box Set",
      publisherId,
    });

    return {
      seriesA: a.seriesId,
      seriesB: b.seriesId,
      aFuturePhysical,
      aFutureDigital,
      aPastThisMonth,
      aTbaThisMonth,
      bFutureDigital,
      bundleId,
      undatedBundleId,
    };
  });
}

function signedIn(t: ReturnType<typeof convexTest>, subject = SUBJECT) {
  return t.withIdentity({ subject });
}

async function withUser(t: ReturnType<typeof convexTest>, username = "follower") {
  const as = signedIn(t);
  await as.mutation(api.users.claimUsername, { username });
  return as;
}

async function stateRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("userSeriesStates").collect());
}

describe("follows.seriesFollow & setSeriesFollow", () => {
  it("is null signed out — the public page just omits the toggle", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.follows.seriesFollow, { seriesPublicId: 1 })).toBeNull();
  });

  it("toggles the explicit follow on and off", async () => {
    const t = convexTest(schema);
    const { seriesA } = await seed(t);
    const as = await withUser(t);

    let state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(false);

    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(true);

    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: false,
    });
    state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(false);
  });

  it("unfollowing never touches the prompt-dismissal flag", async () => {
    const t = convexTest(schema);
    const { seriesA } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesA });
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: false,
    });
    const rows = await stateRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.followPromptDismissed).toBe(true);
  });
});

describe("follows.followedSeries", () => {
  it("lists only followed series, for the browser marker + filter", async () => {
    const t = convexTest(schema);
    const { seriesA, seriesB } = await seed(t);
    const as = await withUser(t);

    expect(await t.query(api.follows.followedSeries, {})).toBeNull();
    expect(
      (await as.query(api.follows.followedSeries, {}))?.seriesPublicIds,
    ).toEqual([]);

    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    // A dismissed-prompt row without a follow must not appear.
    await as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesB });

    expect(
      (await as.query(api.follows.followedSeries, {}))?.seriesPublicIds,
    ).toEqual([1]);
  });
});

describe("follows.myUpcoming", () => {
  it("is null signed out", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.follows.myUpcoming, { todaySort: TODAY })).toBeNull();
  });

  it("followed series contribute future releases matching the preference; past and unfollowed drop", async () => {
    const t = convexTest(schema);
    const { seriesA } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });

    // Default preference is "both": all of A's upcoming, chronologically —
    // the current-month day-TBA release first, dated ones after; the release
    // dated earlier this month and unfollowed Series B never appear.
    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming?.items.map((item) => item.sort)).toEqual([
      20260800, 20260915, 20260920,
    ]);
    expect(
      upcoming?.items.every((item) => item.kind === "release" && item.followed),
    ).toBe(true);
  });

  it("the Physical/Digital preference scopes only the followed clause", async () => {
    const t = convexTest(schema);
    const { seriesA, bFutureDigital } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    await as.mutation(api.users.setFormatPreference, { preference: "physical" });
    // A future Wanted digital release appears regardless of the preference.
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: bFutureDigital,
      state: "wanted",
    });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    const items = upcoming?.items ?? [];
    // A's digital release (20260920) is gone; B's wanted digital one is in.
    expect(items.map((item) => item.sort)).toEqual([20260800, 20260915, 20261001]);
    const wanted = items.find((item) => item.sort === 20261001);
    expect(wanted?.kind === "release" && wanted.state).toBe("wanted");
    expect(wanted?.kind === "release" && wanted.followed).toBe(false);
  });

  it("deduplicates: a followed release that is also Wanted appears once, with both facts", async () => {
    const t = convexTest(schema);
    const { seriesA, aFuturePhysical } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: aFuturePhysical,
      state: "wanted",
    });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    const matches = (upcoming?.items ?? []).filter((item) => item.sort === 20260915);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind === "release" && matches[0].state).toBe("wanted");
    expect(matches[0]?.kind === "release" && matches[0].followed).toBe(true);
  });

  it("excludes Owned — a followed release the user owns never appears", async () => {
    const t = convexTest(schema);
    const { seriesA, aFuturePhysical } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: aFuturePhysical,
      state: "owned",
    });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming?.items.map((item) => item.sort)).toEqual([20260800, 20260920]);
  });

  it("excludes Derived Ownership — an owned box set removes its members too", async () => {
    const t = convexTest(schema);
    const { seriesA, bundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.follows.setSeriesFollow, {
      seriesId: seriesA,
      following: true,
    });
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    // aFuturePhysical (20260915) is derived-owned; the owned Bundle itself is
    // excluded as well.
    expect(upcoming?.items.map((item) => item.sort)).toEqual([20260800, 20260920]);
    expect(upcoming?.items.every((item) => item.kind === "release")).toBe(true);
  });

  it("includes future Wanted/Ordered Bundles; an undated bundle is not announced", async () => {
    const t = convexTest(schema);
    const { bundleId, undatedBundleId } = await seed(t);
    const as = await withUser(t);
    await as.mutation(api.collection.setBundleEntry, {
      bundleId,
      state: "ordered",
    });
    await as.mutation(api.collection.setBundleEntry, {
      bundleId: undatedBundleId,
      state: "wanted",
    });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming?.items).toHaveLength(1);
    const item = upcoming?.items[0];
    expect(item?.kind).toBe("bundle");
    expect(item?.kind === "bundle" && item.state).toBe("ordered");
    expect(item?.sort).toBe(20261105);
  });

  it("is empty with nothing followed and nothing wanted", async () => {
    const t = convexTest(schema);
    await seed(t);
    const as = await withUser(t);
    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming).toEqual({ items: [], capped: false });
  });
});
