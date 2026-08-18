import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Shared fixture: two publishers, two series, releases spread across July,
// August, and September 2026 — including a month-precision date (day TBA), a
// hidden release, and an omnibus — so one seed exercises the window scan,
// both filters, and the label composition.
async function seeded() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const viz = await ctx.db.insert("publishers", {
      status: "active",
      name: "VIZ Media",
      slug: "viz-media",
    });
    const seas = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    await ctx.db.insert("publishers", {
      status: "hidden",
      name: "Hidden Press",
      slug: "hidden-press",
    });

    const ghoul = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Tokyo Ghoul",
      altTitles: [],
      searchText: "Tokyo Ghoul",
    });
    const quiet = await ctx.db.insert("series", {
      status: "active",
      publicId: 2,
      title: "The Quiet Cartographer",
      altTitles: [],
      searchText: "The Quiet Cartographer",
    });

    const volume = async (
      seriesId: Id<"series">,
      position: number,
      label?: string,
    ) =>
      await ctx.db.insert("volumes", {
        status: "active",
        publicId: position,
        seriesId,
        position,
        label,
      });
    const g1 = await volume(ghoul, 1, "1");
    const g2 = await volume(ghoul, 2, "2");
    const g3 = await volume(ghoul, 3, "3");
    const q1 = await volume(quiet, 1, "1");

    let editionPublicId = 0;
    const edition = async (
      publisherId: Id<"publishers">,
      coverage: Array<{ volumeId: Id<"volumes">; extent: "complete" | "partial" }>,
    ) => {
      const id = await ctx.db.insert("editions", {
        status: "active",
        publicId: ++editionPublicId,
        publisherId,
      });
      let order = 1;
      for (const row of coverage) {
        await ctx.db.insert("volumeCoverages", {
          editionId: id,
          volumeId: row.volumeId,
          order: order++,
          extent: row.extent,
        });
      }
      return id;
    };
    const ghoulEd1 = await edition(viz, [{ volumeId: g1, extent: "complete" }]);
    const omnibusEd = await edition(viz, [
      { volumeId: g1, extent: "complete" },
      { volumeId: g2, extent: "complete" },
      { volumeId: g3, extent: "complete" },
    ]);
    const quietEd = await edition(seas, [{ volumeId: q1, extent: "complete" }]);

    const release = async (args: {
      editionId: Id<"editions">;
      publisherId: Id<"publishers">;
      seriesIds: Array<Id<"series">>;
      format: "physical" | "digital";
      status?: "active" | "hidden";
      date: { year: number; month?: number; day?: number };
    }) => {
      const { year, month, day } = args.date;
      await ctx.db.insert("releases", {
        status: args.status ?? "active",
        editionId: args.editionId,
        format: args.format,
        language: "en",
        pubDate: {
          year,
          month,
          day,
          sort: year * 10000 + (month ?? 0) * 100 + (day ?? 0),
        },
        publisherId: args.publisherId,
        seriesIds: args.seriesIds,
      });
    };

    // August 2026 window contents:
    await release({
      editionId: ghoulEd1,
      publisherId: viz,
      seriesIds: [ghoul],
      format: "physical",
      date: { year: 2026, month: 8, day: 18 },
    });
    await release({
      editionId: omnibusEd,
      publisherId: viz,
      seriesIds: [ghoul],
      format: "physical",
      date: { year: 2026, month: 8, day: 4 },
    });
    await release({
      editionId: quietEd,
      publisherId: seas,
      seriesIds: [quiet],
      format: "digital",
      // Month precision: known to publish in August, day TBA (sort 20260800).
      date: { year: 2026, month: 8 },
    });
    await release({
      editionId: quietEd,
      publisherId: seas,
      seriesIds: [quiet],
      format: "physical",
      status: "hidden",
      date: { year: 2026, month: 8, day: 11 },
    });
    // Neighbors that must stay outside the August window:
    await release({
      editionId: quietEd,
      publisherId: seas,
      seriesIds: [quiet],
      format: "physical",
      date: { year: 2026, month: 7, day: 31 },
    });
    await release({
      editionId: ghoulEd1,
      publisherId: viz,
      seriesIds: [ghoul],
      format: "digital",
      date: { year: 2026, month: 9, day: 1 },
    });
    // Year-only precision falls in no month window.
    await release({
      editionId: ghoulEd1,
      publisherId: viz,
      seriesIds: [ghoul],
      format: "digital",
      date: { year: 2026 },
    });

    return { viz, seas };
  });
  return { t, ids };
}

describe("releases.monthBrowse", () => {
  it("scans exactly the month's date window, month-precision included", async () => {
    const { t } = await seeded();
    const result = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
    });
    // The hidden release, both neighbors, and the year-only date are absent.
    expect(result.releases).toHaveLength(3);
    // Chronological: day-TBA (sort yyyymm00) first, then the dated rows.
    expect(result.releases.map((r) => [r.day, r.volumeLabel])).toEqual([
      [null, "Vol. 1"],
      [4, "Vol. 1–3"],
      [18, "Vol. 1"],
    ]);
  });

  it("applies the Format filter in memory after the window scan", async () => {
    const { t } = await seeded();
    const physical = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      format: "physical",
    });
    expect(physical.releases.map((r) => r.format)).toEqual([
      "physical",
      "physical",
    ]);
    const digital = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      format: "digital",
    });
    expect(digital.releases.map((r) => r.publisher?.slug)).toEqual([
      "seven-seas",
    ]);
  });

  it("narrows by Publisher through by_publisher_date, composing with Format", async () => {
    const { t } = await seeded();
    const viz = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      publisher: "viz-media",
    });
    expect(viz.releases.map((r) => r.publisher?.name)).toEqual([
      "VIZ Media",
      "VIZ Media",
    ]);
    const both = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      publisher: "viz-media",
      format: "digital",
    });
    expect(both.releases).toEqual([]);
  });

  it("resolves a renamed Publisher's old slug and ignores unknown slugs", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherSlugRedirects", {
        fromSlug: "viz",
        publisherId: ids.viz,
      });
    });
    const redirected = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      publisher: "viz",
    });
    expect(redirected.releases).toHaveLength(2);
    const unknown = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
      publisher: "no-such-publisher",
    });
    expect(unknown.releases).toEqual([]);
    // The filter dropdown still renders on an empty result.
    expect(unknown.publishers.length).toBeGreaterThan(0);
  });

  it("labels rows from Coverage: single volume, omnibus range, partial", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const series = await ctx.db.insert("series", {
        status: "active",
        publicId: 3,
        title: "Split Story",
        altTitles: [],
        searchText: "Split Story",
      });
      const vol = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 99,
        seriesId: series,
        position: 1,
        label: "3.5",
      });
      const edition = await ctx.db.insert("editions", {
        status: "active",
        publicId: 99,
        publisherId: ids.viz,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId: edition,
        volumeId: vol,
        order: 1,
        extent: "partial",
      });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: edition,
        format: "digital",
        language: "en",
        pubDate: { year: 2026, month: 8, day: 27, sort: 20260827 },
        publisherId: ids.viz,
        seriesIds: [series],
      });
    });
    const result = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
    });
    const partial = result.releases.find((r) => r.day === 27);
    expect(partial?.volumeLabel).toBe("Vol. 3.5 (partial)");
    expect(result.releases.find((r) => r.day === 4)?.volumeLabel).toBe(
      "Vol. 1–3",
    );
  });

  it("lists active Publishers alphabetically for the shared filter", async () => {
    const { t } = await seeded();
    const result = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
    });
    expect(result.publishers).toEqual([
      { name: "Seven Seas Entertainment", slug: "seven-seas" },
      { name: "VIZ Media", slug: "viz-media" },
    ]);
  });

  it("hides releases of hidden Editions and hidden Series", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const hiddenSeries = await ctx.db.insert("series", {
        status: "hidden",
        publicId: 4,
        title: "Gone",
        altTitles: [],
        searchText: "Gone",
      });
      const hiddenEdition = await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 98,
        publisherId: ids.viz,
      });
      await ctx.db.insert("releases", {
        status: "active",
        editionId: hiddenEdition,
        format: "physical",
        language: "en",
        pubDate: { year: 2026, month: 8, day: 20, sort: 20260820 },
        publisherId: ids.viz,
        seriesIds: [hiddenSeries],
      });
    });
    const result = await t.query(api.releases.monthBrowse, {
      year: 2026,
      month: 8,
    });
    expect(result.releases.some((r) => r.day === 20)).toBe(false);
  });

  it("returns an empty window for out-of-range months", async () => {
    const { t } = await seeded();
    for (const args of [
      { year: 2026, month: 0 },
      { year: 2026, month: 13 },
      { year: 26, month: 8 },
    ]) {
      const result = await t.query(api.releases.monthBrowse, args);
      expect(result.releases).toEqual([]);
    }
  });
});
