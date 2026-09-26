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

describe("publisherPage — imprint family", () => {
  async function family() {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const sevenSeas = await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      for (const [name, slug] of [
        ["Steamship", "steamship"],
        ["Ghost Ship", "ghost-ship"],
      ] as const) {
        await ctx.db.insert("publishers", {
          status: "active",
          name,
          slug,
          parentPublisherId: sevenSeas,
        });
      }
      await ctx.db.insert("publishers", {
        status: "hidden",
        name: "Waves of Color",
        slug: "waves-of-color",
        parentPublisherId: sevenSeas,
      });
    });
    return t;
  }

  it("an imprint's page names its parent company", async () => {
    const t = await family();
    const page = await t.query(api.publisher.publisherPage, { slug: "ghost-ship", ...bounds });
    expect(page).toMatchObject({
      publisher: { name: "Ghost Ship" },
      parent: { name: "Seven Seas Entertainment", slug: "seven-seas" },
      imprints: [],
    });
  });

  it("a parent's page lists its active imprints, alphabetically", async () => {
    const t = await family();
    const page = await t.query(api.publisher.publisherPage, { slug: "seven-seas", ...bounds });
    expect(page).toMatchObject({
      parent: null,
      imprints: [
        { name: "Ghost Ship", slug: "ghost-ship" },
        { name: "Steamship", slug: "steamship" },
      ],
    });
  });
});

describe("publisher.monthBoard", () => {
  // Fixture for September 2026: Seven Seas (parent) debuts one series and
  // continues another, plus a Deluxe-line Vol. 1 that is a repackaging, not
  // a debut; its imprint Ghost Ship has one release; a defunct Publisher and
  // one with only August activity round out the directory. Hidden rows and
  // other months stay out of the counts.
  async function board() {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const sevenSeas = await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      const ghostShip = await ctx.db.insert("publishers", {
        status: "active",
        name: "Ghost Ship",
        slug: "ghost-ship",
        parentPublisherId: sevenSeas,
      });
      const tokyopop = await ctx.db.insert("publishers", {
        status: "active",
        name: "Tokyopop",
        slug: "tokyopop",
      });
      await ctx.db.insert("publishers", {
        status: "active",
        name: "CMX",
        slug: "cmx",
        defunct: true,
      });
      await ctx.db.insert("publishers", {
        status: "hidden",
        name: "Hidden Press",
        slug: "hidden-press",
      });

      let publicId = 0;
      // One Series with the given Volume positions; returns Volume IDs.
      const seriesWith = async (title: string, positions: number[]) => {
        const seriesId = await ctx.db.insert("series", {
          status: "active",
          publicId: ++publicId,
          title,
          altTitles: [],
          searchText: title,
        });
        const volumes = [];
        for (const position of positions) {
          volumes.push(
            await ctx.db.insert("volumes", {
              status: "active",
              publicId: ++publicId,
              seriesId,
              position,
              label: String(position),
            }),
          );
        }
        return { seriesId, volumes };
      };
      // An Edition covering one Volume, with one Release per date given.
      const release = async (args: {
        publisherId: Id<"publishers">;
        series: { seriesId: Id<"series">; volumes: Array<Id<"volumes">> };
        volume: number;
        sort: number;
        format?: "physical" | "digital";
        lineName?: string;
        status?: "active" | "hidden";
        isbn13?: string;
      }) => {
        const editionLineId = args.lineName
          ? await ctx.db.insert("editionLines", {
              status: "active",
              seriesId: args.series.seriesId,
              publisherId: args.publisherId,
              name: args.lineName,
            })
          : undefined;
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: ++publicId,
          publisherId: args.publisherId,
          editionLineId,
        });
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId: args.series.volumes[args.volume]!,
          order: 1,
          extent: "complete",
        });
        const year = Math.floor(args.sort / 10000);
        const month = Math.floor(args.sort / 100) % 100;
        await ctx.db.insert("releases", {
          status: args.status ?? "active",
          editionId,
          format: args.format ?? "physical",
          language: "en",
          isbn13: args.isbn13,
          pubDate: { year, month, day: args.sort % 100, sort: args.sort },
          publisherId: args.publisherId,
          seriesIds: [args.series.seriesId],
        });
      };

      const debut = await seriesWith("New Thing", [1]);
      const ongoing = await seriesWith("Long Runner", [1, 2, 3, 4, 5]);
      const classic = await seriesWith("Old Classic", [1]);
      const ghostly = await seriesWith("Ghostly", [3]);
      const august = await seriesWith("August Only", [2]);

      // Seven Seas, September: a debut in two Formats (one Series), a
      // continuing Volume, and a Deluxe-line Vol. 1 of an old Series.
      await release({ publisherId: sevenSeas, series: debut, volume: 0, sort: 20260908, isbn13: "9780000000001" });
      await release({ publisherId: sevenSeas, series: debut, volume: 0, sort: 20260908, format: "digital" });
      await release({ publisherId: sevenSeas, series: ongoing, volume: 4, sort: 20260915 });
      await release({ publisherId: sevenSeas, series: classic, volume: 0, sort: 20260900, lineName: "Deluxe Edition" });
      // Out of September's counts: hidden, and another month.
      await release({ publisherId: sevenSeas, series: ongoing, volume: 3, sort: 20260920, status: "hidden" });
      await release({ publisherId: sevenSeas, series: ongoing, volume: 3, sort: 20261001 });
      // August, for the delta.
      await release({ publisherId: sevenSeas, series: ongoing, volume: 3, sort: 20260811 });
      await release({ publisherId: tokyopop, series: august, volume: 0, sort: 20260804 });
      // Ghost Ship, September.
      await release({ publisherId: ghostShip, series: ghostly, volume: 0, sort: 20260922, format: "digital" });
    });
    return t;
  }

  it("groups the month by Publisher, busiest first, with counts and a delta", async () => {
    const t = await board();
    const { board: cards } = await t.query(api.publisher.monthBoard, {
      year: 2026,
      month: 9,
    });
    expect(
      cards.map(({ covers, ...card }) => ({ ...card, covers: covers.length })),
    ).toEqual([
      {
        publisher: { name: "Seven Seas Entertainment", slug: "seven-seas", parent: null },
        releases: 4,
        physical: 3,
        digital: 1,
        series: 3,
        // The Deluxe-line Vol. 1 repackages an old Series: not a debut.
        newSeries: 1,
        previousReleases: 1,
        // One cover per Series.
        covers: 3,
      },
      {
        publisher: {
          name: "Ghost Ship",
          slug: "ghost-ship",
          parent: { name: "Seven Seas Entertainment", slug: "seven-seas" },
        },
        releases: 1,
        physical: 0,
        digital: 1,
        series: 1,
        // Its only Volume is Vol. 3: continuing.
        newSeries: 0,
        previousReleases: 0,
        covers: 1,
      },
    ]);
    // The debut with an ISBN leads the cover strip.
    expect(cards[0]!.covers[0]).toMatchObject({
      series: [{ title: "New Thing" }],
      coverIsbn: "9780000000001",
    });
  });

  it("lists every active Publisher A–Z, imprints nested, defunct flagged", async () => {
    const t = await board();
    const { directory } = await t.query(api.publisher.monthBoard, {
      year: 2026,
      month: 9,
    });
    expect(directory).toEqual([
      { name: "CMX", slug: "cmx", defunct: true, releases: 0, imprints: [] },
      {
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
        defunct: false,
        releases: 4,
        imprints: [
          { name: "Ghost Ship", slug: "ghost-ship", defunct: false, releases: 1 },
        ],
      },
      // Quiet this month, still listed.
      { name: "Tokyopop", slug: "tokyopop", defunct: false, releases: 0, imprints: [] },
    ]);
  });

  it("wraps January's delta to the previous December", async () => {
    const t = await board();
    await t.run(async (ctx) => {
      // Copies of an existing (visible) Seven Seas Release, re-dated.
      const [template] = await ctx.db.query("releases").take(1);
      if (!template) throw new Error("fixture has releases");
      const { _id, _creationTime, ...fields } = template;
      for (const [month, sort] of [
        [12, 20251210],
        [1, 20260105],
      ] as const) {
        await ctx.db.insert("releases", {
          ...fields,
          pubDate: { year: Math.floor(sort / 10000), month, day: sort % 100, sort },
        });
      }
    });
    const { board: cards } = await t.query(api.publisher.monthBoard, {
      year: 2026,
      month: 1,
    });
    expect(cards.map((card) => [card.releases, card.previousReleases])).toEqual([[1, 1]]);
  });

  it("counts a digital Release of an old Vol. 1 as a backfill, not a new series", async () => {
    const t = await board();
    await t.run(async (ctx) => {
      // Tokyopop: Vol. 1 in print in 2019, its digital Release this month.
      const [tokyopop] = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "tokyopop"))
        .take(1);
      if (!tokyopop) throw new Error("fixture has Tokyopop");
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 900,
        title: "Backfilled",
        altTitles: [],
        searchText: "Backfilled",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 901,
        seriesId,
        position: 1,
        label: "1",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 902,
        publisherId: tokyopop._id,
      });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      for (const [format, sort] of [
        ["physical", 20190305],
        ["digital", 20260910],
      ] as const) {
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format,
          language: "en",
          pubDate: { year: Math.floor(sort / 10000), month: Math.floor(sort / 100) % 100, day: sort % 100, sort },
          publisherId: tokyopop._id,
          seriesIds: [seriesId],
        });
      }
    });
    const { board: cards } = await t.query(api.publisher.monthBoard, { year: 2026, month: 9 });
    const card = cards.find((c) => c.publisher.slug === "tokyopop");
    expect(card).toMatchObject({ releases: 1, series: 1, newSeries: 0 });
    // Seven Seas' debut (print and digital the same month) still counts.
    expect(cards.find((c) => c.publisher.slug === "seven-seas")?.newSeries).toBe(1);
  });

  it("reads a malformed month as an empty board, directory intact", async () => {
    const t = await board();
    const result = await t.query(api.publisher.monthBoard, { year: 2026, month: 13 });
    expect(result.board).toEqual([]);
    expect(result.directory).toHaveLength(3);
  });
});
