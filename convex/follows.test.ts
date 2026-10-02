import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  insertBundle,
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  seriesStatsRow,
} from "./test.factories";
import { makeT, withUser, type Accessor, type TestT } from "./test.helpers";
import { describeNoViewer } from "./test.tracking";

const FOLLOWER = { subject: "user_2follower", username: "follower" };
const OTHER = { subject: "user_2other", username: "other" };

// The fixed "today" every test computes against: Aug 19, 2026 (yyyymmdd).
const TODAY = 20260819;

/**
 * A catalog exercising ticket #29's corners around TODAY: a followed-able
 * Series A with physical/digital future Releases, a dated-earlier-this-month
 * Release, and a day-TBA Release of the current month; an unrelated Series B
 * with a future digital Release; and a future box set bundling Series A's
 * physical Release — so the preference clause, the Wanted/Ordered clause,
 * dedup, and both Owned exclusions (direct and derived) are all reachable.
 * `as` is the follower, username claimed.
 */
async function setup() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });

    const makeSeries = async (publicId: number, title: string) => {
      const seriesId = await insertSeries(ctx, { publicId, title });
      return { seriesId, volumeId: await insertVolume(ctx, { seriesId }) };
    };
    const a = await makeSeries(1, "Witch Hat Atelier");
    const b = await makeSeries(2, "Dungeon Meshi");

    const makeRelease = async (
      series: { seriesId: Id<"series">; volumeId: Id<"volumes"> },
      format: "physical" | "digital",
      pubDate: Doc<"releases">["pubDate"],
    ) => {
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId: series.volumeId });
      return await insertRelease(ctx, { editionId, format, pubDate, publisherId, seriesIds: [series.seriesId] });
    };

    const aFuturePhysical = await makeRelease(a, "physical", { year: 2026, month: 9, day: 15, sort: 20260915 });
    const aFutureDigital = await makeRelease(a, "digital", { year: 2026, month: 9, day: 20, sort: 20260920 });
    const aPastThisMonth = await makeRelease(a, "physical", { year: 2026, month: 8, day: 10, sort: 20260810 });
    const aTbaThisMonth = await makeRelease(a, "physical", { year: 2026, month: 8, sort: 20260800 });
    const bFutureDigital = await makeRelease(b, "digital", { year: 2026, month: 10, day: 1, sort: 20261001 });

    const bundleId = await insertBundle(ctx, {
      publicId: 41,
      name: "Witch Hat Atelier Box Set",
      publisherId,
      format: "physical",
      pubDate: { year: 2026, month: 11, day: 5, sort: 20261105 },
    });
    await insertBundleMember(ctx, { bundleId, releaseId: aFuturePhysical, order: 1 });
    const undatedBundleId = await insertBundle(ctx, {
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
  const as = await withUser(t, FOLLOWER);
  return { t, as, ...ids };
}

/** Follows (or, with `following: false`, unfollows) a Series as `as`. */
async function follow(as: Accessor, seriesId: Id<"series">, following = true) {
  await as.mutation(api.follows.setSeriesFollow, { seriesId, following });
}

async function stateRows(t: TestT) {
  return await t.run(async (ctx) => await ctx.db.query("userSeriesStates").collect());
}

describeNoViewer(setup, {
  queries: [
    ["seriesFollow", (as) => as.query(api.follows.seriesFollow, { seriesPublicId: 1 })],
    ["followedSeries", (as) => as.query(api.follows.followedSeries, {})],
    ["myFollowing", (as) => as.query(api.follows.myFollowing, {})],
    ["myUpcoming", (as) => as.query(api.follows.myUpcoming, { todaySort: TODAY })],
  ],
  mutations: [
    ["setSeriesFollow", (as, { seriesA }) => as.mutation(api.follows.setSeriesFollow, { seriesId: seriesA, following: true })],
    ["dismissFollowPrompt", (as, { seriesA }) => as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesA })],
  ],
});

describe("follows.seriesFollow & setSeriesFollow", () => {
  it("toggles the explicit follow on and off", async () => {
    const { as, seriesA } = await setup();

    let state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(false);

    await follow(as, seriesA);
    state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(true);

    await follow(as, seriesA, false);
    state = await as.query(api.follows.seriesFollow, { seriesPublicId: 1 });
    expect(state?.following).toBe(false);
  });

  it("unfollowing never touches the prompt-dismissal flag", async () => {
    const { t, as, seriesA } = await setup();
    await as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesA });
    await follow(as, seriesA);
    await follow(as, seriesA, false);
    const rows = await stateRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.followPromptDismissed).toBe(true);
  });
});

describe("follows.followedSeries", () => {
  it("lists only followed series, for the browser marker + filter", async () => {
    const { as, seriesA, seriesB } = await setup();

    expect(
      (await as.query(api.follows.followedSeries, {}))?.seriesPublicIds,
    ).toEqual([]);

    await follow(as, seriesA);
    // A dismissed-prompt row without a follow must not appear.
    await as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesB });

    expect(
      (await as.query(api.follows.followedSeries, {}))?.seriesPublicIds,
    ).toEqual([1]);
  });
});

describe("follows.myFollowing", () => {
  it("lists followed series with covers and next dates, announced first", async () => {
    const { t, as, seriesA, seriesB } = await setup();
    await follow(as, seriesA);
    await follow(as, seriesB);
    // A stats row for B only: A falls back to the Series document.
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "seriesStats",
        seriesStatsRow({
          seriesId: seriesB,
          publicId: 2,
          title: "Dungeon Meshi",
          volumeCount: 1,
          nextReleaseSort: 20261001,
          coverIsbn: "9781234567897",
        }),
      );
    });

    const following = await as.query(api.follows.myFollowing, {});
    expect(following?.series.map((row) => row.title)).toEqual([
      "Dungeon Meshi",
      "Witch Hat Atelier",
    ]);
    expect(following?.series[0]).toMatchObject({
      seriesId: seriesB,
      seriesPublicId: 2,
      coverIsbn: "9781234567897",
      nextReleaseSort: 20261001,
      volumeCount: 1,
    });
    expect(following?.series[1]).toMatchObject({
      seriesId: seriesA,
      nextReleaseSort: 0,
      coverIsbn: null,
      volumeCount: null,
    });
  });

  it("omits unfollowed series", async () => {
    const { as, seriesA } = await setup();
    await follow(as, seriesA);
    await follow(as, seriesA, false);
    expect((await as.query(api.follows.myFollowing, {}))?.series).toEqual([]);
  });
});

describe("follows.myUpcoming", () => {
  it("followed series contribute future releases matching the preference; past and unfollowed drop", async () => {
    const { as, seriesA } = await setup();
    await follow(as, seriesA);

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
    const { as, seriesA, bFutureDigital } = await setup();
    await follow(as, seriesA);
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
    const { as, seriesA, aFuturePhysical } = await setup();
    await follow(as, seriesA);
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
    const { as, seriesA, aFuturePhysical } = await setup();
    await follow(as, seriesA);
    await as.mutation(api.collection.setReleaseEntry, {
      releaseId: aFuturePhysical,
      state: "owned",
    });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming?.items.map((item) => item.sort)).toEqual([20260800, 20260920]);
  });

  it("excludes Derived Ownership — an owned box set removes its members too", async () => {
    const { as, seriesA, bundleId } = await setup();
    await follow(as, seriesA);
    await as.mutation(api.collection.setBundleEntry, { bundleId, state: "owned" });

    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    // aFuturePhysical (20260915) is derived-owned; the owned Bundle itself is
    // excluded as well.
    expect(upcoming?.items.map((item) => item.sort)).toEqual([20260800, 20260920]);
    expect(upcoming?.items.every((item) => item.kind === "release")).toBe(true);
  });

  it("includes future Wanted/Ordered Bundles; an undated bundle is not announced", async () => {
    const { as, bundleId, undatedBundleId } = await setup();
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
    const { as } = await setup();
    const upcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(upcoming).toEqual({ items: [], capped: false });
  });
});

describe("follows belong to one user", () => {
  it("another user neither sees the follower's follows nor changes them", async () => {
    const { t, as, seriesA, seriesB, bFutureDigital } = await setup();
    await follow(as, seriesA);
    await as.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesB });
    await as.mutation(api.collection.setReleaseEntry, { releaseId: bFutureDigital, state: "wanted" });
    const followerRows = await stateRows(t);
    const followerUpcoming = await as.query(api.follows.myUpcoming, { todaySort: TODAY });
    expect(followerUpcoming?.items.length).toBeGreaterThan(0);

    const other = await withUser(t, OTHER);
    expect(await other.query(api.follows.seriesFollow, { seriesPublicId: 1 })).toMatchObject({ following: false });
    expect(await other.query(api.follows.followedSeries, {})).toEqual({ seriesPublicIds: [] });
    expect(await other.query(api.follows.myFollowing, {})).toEqual({ series: [] });
    expect(await other.query(api.follows.myUpcoming, { todaySort: TODAY })).toEqual({ items: [], capped: false });

    // Their unfollow and dismissal write rows of their own, never the follower's.
    await follow(other, seriesA, false);
    await other.mutation(api.follows.dismissFollowPrompt, { seriesId: seriesA });
    const rows = await stateRows(t);
    expect(rows.filter((row) => followerRows.some((mine) => mine._id === row._id))).toEqual(followerRows);
    expect(rows).toHaveLength(followerRows.length + 1);
    expect(await as.query(api.follows.followedSeries, {})).toEqual({ seriesPublicIds: [1] });
    expect(await as.query(api.follows.myUpcoming, { todaySort: TODAY })).toEqual(followerUpcoming);
  });
});
