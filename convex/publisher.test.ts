import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { LANE_CAP } from "./publisher";

// Lane bounds for every test: "today" is Aug 19 2026, horizon end of Nov 2026
// (~3 months), matching what the route computes.
const TODAY = 20260819;
const HORIZON = 20261199;
const bounds = { todaySort: TODAY, horizonSort: HORIZON };

// Fixture: one active Publisher with releases spread around the lane window —
// a this-month day-TBA row, a dated row today, later months, and rows that
// must stay out (already published, past the horizon, hidden, year-only).
async function seeded() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const viz = await ctx.db.insert("publishers", {
      status: "active",
      name: "VIZ Media",
      slug: "viz-media",
      description: "Publisher profile blurb.",
    });
    await ctx.db.insert("publishers", {
      status: "hidden",
      name: "Hidden Press",
      slug: "hidden-press",
    });

    const series = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Tokyo Ghoul",
      altTitles: [],
      searchText: "Tokyo Ghoul",
    });
    const volume = await ctx.db.insert("volumes", {
      status: "active",
      publicId: 1,
      seriesId: series,
      position: 1,
      label: "1",
    });
    const edition = await ctx.db.insert("editions", {
      status: "active",
      publicId: 1,
      publisherId: viz,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId: edition,
      volumeId: volume,
      order: 1,
      extent: "complete",
    });

    const release = async (args: {
      date: { year: number; month?: number; day?: number };
      status?: "active" | "hidden";
      publisherId?: Id<"publishers">;
    }) => {
      const { year, month, day } = args.date;
      await ctx.db.insert("releases", {
        status: args.status ?? "active",
        editionId: edition,
        format: "physical",
        language: "en",
        pubDate: {
          year,
          month,
          day,
          sort: year * 10000 + (month ?? 0) * 100 + (day ?? 0),
        },
        publisherId: args.publisherId ?? viz,
        seriesIds: [series],
      });
    };

    // In the lane:
    await release({ date: { year: 2026, month: 8 } }); // this month, day TBA
    await release({ date: { year: 2026, month: 8, day: 19 } }); // today
    await release({ date: { year: 2026, month: 9, day: 1 } });
    await release({ date: { year: 2026, month: 11, day: 30 } }); // horizon edge
    // Out of the lane:
    await release({ date: { year: 2026, month: 8, day: 4 } }); // already out
    await release({ date: { year: 2026, month: 7, day: 31 } }); // last month
    await release({ date: { year: 2026, month: 12, day: 5 } }); // past horizon
    await release({ date: { year: 2026 } }); // year-only: no month window
    await release({
      date: { year: 2026, month: 9, day: 15 },
      status: "hidden",
    });

    return { viz, edition, series };
  });
  return { t, ids };
}

describe("publisher.publisherPage", () => {
  it("serves the profile with a bounded upcoming lane in date order", async () => {
    const { t } = await seeded();
    const page = await t.query(api.publisher.publisherPage, {
      slug: "viz-media",
      ...bounds,
    });
    if (!page || "redirectTo" in page) throw new Error("expected page data");
    expect(page.publisher).toEqual({
      name: "VIZ Media",
      slug: "viz-media",
      description: "Publisher profile blurb.",
    });
    expect(page.editionCount).toEqual({ count: 1, capped: false });
    // Day-TBA (sort yyyymm00) leads its month; already-published, hidden,
    // out-of-horizon, and year-only rows are absent.
    expect(page.upcoming.map((r) => [r.sort, r.day])).toEqual([
      [20260800, null],
      [20260819, 19],
      [20260901, 1],
      [20261130, 30],
    ]);
    expect(page.upcomingCapped).toBe(false);
  });

  it("caps the lane at LANE_CAP and flags that more exist", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      for (let day = 1; day <= LANE_CAP; day++) {
        await ctx.db.insert("releases", {
          status: "active",
          editionId: ids.edition,
          format: "digital",
          language: "en",
          pubDate: { year: 2026, month: 10, day, sort: 20261000 + day },
          publisherId: ids.viz,
          seriesIds: [ids.series],
        });
      }
    });
    const page = await t.query(api.publisher.publisherPage, {
      slug: "viz-media",
      ...bounds,
    });
    if (!page || "redirectTo" in page) throw new Error("expected page data");
    expect(page.upcoming).toHaveLength(LANE_CAP);
    expect(page.upcomingCapped).toBe(true);
  });

  it("301s a renamed Publisher's old slug via publisherSlugRedirects", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherSlugRedirects", {
        fromSlug: "viz",
        publisherId: ids.viz,
      });
    });
    expect(
      await t.query(api.publisher.publisherPage, { slug: "viz", ...bounds }),
    ).toEqual({ redirectTo: "viz-media" });
  });

  it("301s a merged Publisher's slug to its survivor's", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const loser = await ctx.db.insert("publishers", {
        status: "merged",
        mergedIntoId: ids.viz,
        name: "VIZ LLC",
        slug: "viz-llc",
      });
      // An old slug of the merged loser follows through to the survivor.
      await ctx.db.insert("publisherSlugRedirects", {
        fromSlug: "viz-llc-old",
        publisherId: loser,
      });
    });
    expect(
      await t.query(api.publisher.publisherPage, { slug: "viz-llc", ...bounds }),
    ).toEqual({ redirectTo: "viz-media" });
    expect(
      await t.query(api.publisher.publisherPage, {
        slug: "viz-llc-old",
        ...bounds,
      }),
    ).toEqual({ redirectTo: "viz-media" });
  });

  it("reads hidden and unknown Publishers as absent", async () => {
    const { t } = await seeded();
    expect(
      await t.query(api.publisher.publisherPage, {
        slug: "hidden-press",
        ...bounds,
      }),
    ).toBeNull();
    expect(
      await t.query(api.publisher.publisherPage, {
        slug: "no-such-publisher",
        ...bounds,
      }),
    ).toBeNull();
  });

  it("drops lane rows whose Edition or Series is hidden", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const hiddenSeries = await ctx.db.insert("series", {
        status: "hidden",
        publicId: 9,
        title: "Gone",
        altTitles: [],
        searchText: "Gone",
      });
      const hiddenEdition = await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 9,
        publisherId: ids.viz,
      });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: hiddenEdition,
        format: "physical",
        language: "en",
        pubDate: { year: 2026, month: 9, day: 8, sort: 20260908 },
        publisherId: ids.viz,
        seriesIds: [hiddenSeries],
      });
    });
    const page = await t.query(api.publisher.publisherPage, {
      slug: "viz-media",
      ...bounds,
    });
    if (!page || "redirectTo" in page) throw new Error("expected page data");
    expect(page.upcoming.some((r) => r.sort === 20260908)).toBe(false);
  });

  it("treats malformed lane bounds as an empty lane, not an error", async () => {
    const { t } = await seeded();
    const page = await t.query(api.publisher.publisherPage, {
      slug: "viz-media",
      todaySort: TODAY,
      horizonSort: TODAY - 1,
    });
    if (!page || "redirectTo" in page) throw new Error("expected page data");
    expect(page.upcoming).toEqual([]);
    expect(page.upcomingCapped).toBe(false);
  });
});
