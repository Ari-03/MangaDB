import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { boardWindow, LANE_CAP, nearMonths } from "./publisher";
import { WINDOW_CAP } from "./releases";
import { pubDate } from "./test.catalog";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  seedCatalog,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

// Lane bounds for every test: "today" is Aug 19 2026, horizon end of Nov 2026
// (~3 months), matching what the route computes.
const TODAY = 20260819;
const HORIZON = 20261199;
const bounds = { todaySort: TODAY, horizonSort: HORIZON };

// Fixture: one active Publisher with releases spread around the lane window —
// a this-month day-TBA row, a dated row today, later months, and rows that
// must stay out (already published, past the horizon, hidden, year-only).
async function seeded() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const viz = await insertPublisher(ctx, {
      name: "VIZ Media",
      slug: "viz-media",
      description: "Publisher profile blurb.",
    });
    await insertPublisher(ctx, { status: "hidden", name: "Hidden Press", slug: "hidden-press" });
    // In the lane: this month, day TBA.
    const { seriesId: series, editionId: edition } = await seedCatalog(ctx, {
      publisher: viz,
      series: { title: "Tokyo Ghoul" },
      release: { pubDate: pubDate(20260800) },
    });
    const release = (sort: number, status: "active" | "hidden" = "active") =>
      insertRelease(ctx, {
        status,
        editionId: edition,
        publisherId: viz,
        seriesIds: [series],
        pubDate: pubDate(sort),
      });

    // In the lane:
    await release(20260819); // today
    await release(20260901);
    await release(20261130); // horizon edge
    // Out of the lane:
    await release(20260804); // already out
    await release(20260731); // last month
    await release(20261205); // past horizon
    await release(20260000); // year-only: no month window
    await release(20260915, "hidden");

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
      mature: false,
    });
    expect(page.editionCount).toEqual({ count: 1, capped: false });
    // This month is every active August release, out already or still to
    // come; the fixture's one Edition makes them one book, dated by its
    // earliest (the day-TBA row, which sorts first).
    expect(page.thisMonth).toMatchObject({ releases: 3, capped: false });
    expect(page.thisMonth.books.map((b) => [b.sort, b.day])).toEqual([[20260800, null]]);
    // After this month: hidden, out-of-horizon, and year-only rows are absent.
    expect(page.upcoming.map((r) => [r.sort, r.day])).toEqual([
      [20260901, 1],
      [20261130, 30],
    ]);
    expect(page.upcomingCapped).toBe(false);
    expect(page.nextSort).toBe(20260800);
  });

  it("folds an Edition's formats in one month into one book, physical first", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      for (const format of ["digital", "physical"] as const) {
        await insertRelease(ctx, {
          editionId: ids.edition,
          format,
          ...(format === "physical" ? { binding: "hardcover" as const } : {}),
          pubDate: pubDate(20261006),
          publisherId: ids.viz,
          seriesIds: [ids.series],
        });
      }
    });
    const page = await t.query(api.publisher.publisherPage, { slug: "viz-media", ...bounds });
    if (!page || "redirectTo" in page) throw new Error("expected page data");
    const october = page.upcoming.filter((b) => Math.floor(b.sort / 100) === 202610);
    expect(october).toHaveLength(1);
    expect(october[0]!.formats).toEqual([
      { format: "physical", binding: "hardcover" },
      { format: "digital", binding: null },
    ]);
  });

  it("caps the lane at LANE_CAP and flags that more exist", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      for (let day = 1; day <= LANE_CAP; day++) {
        // A book each: one Edition's releases in a month would fold into one.
        const editionId = await insertEdition(ctx, { publisherId: ids.viz });
        await insertRelease(ctx, {
          editionId,
          format: "digital",
          pubDate: pubDate(20261000 + day),
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
    expect(await t.query(api.publisher.publisherPage, { slug: "viz", ...bounds })).toEqual({
      redirectTo: "viz-media",
    });
  });

  it("301s a merged Publisher's slug to its survivor's", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const loser = await insertPublisher(ctx, {
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
    expect(await t.query(api.publisher.publisherPage, { slug: "viz-llc", ...bounds })).toEqual({
      redirectTo: "viz-media",
    });
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
      const hiddenSeries = await insertSeries(ctx, { status: "hidden", title: "Gone" });
      const hiddenEdition = await insertEdition(ctx, { status: "hidden", publisherId: ids.viz });
      await insertRelease(ctx, {
        editionId: hiddenEdition,
        pubDate: pubDate(20260908),
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
    expect(page.thisMonth.books).toEqual([]);
  });
});

describe("publisherPage — imprint family", () => {
  async function family() {
    const t = makeT();
    await t.run(async (ctx) => {
      const sevenSeas = await insertPublisher(ctx, {
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      await insertPublisher(ctx, {
        name: "Steamship",
        slug: "steamship",
        parentPublisherId: sevenSeas,
      });
      await insertPublisher(ctx, {
        name: "Ghost Ship",
        slug: "ghost-ship",
        parentPublisherId: sevenSeas,
      });
      await insertPublisher(ctx, {
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
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const sevenSeas = await insertPublisher(ctx, {
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      const ghostShip = await insertPublisher(ctx, {
        name: "Ghost Ship",
        slug: "ghost-ship",
        parentPublisherId: sevenSeas,
      });
      const tokyopop = await insertPublisher(ctx, { name: "Tokyopop", slug: "tokyopop" });
      const cmx = await insertPublisher(ctx, { name: "CMX", slug: "cmx", defunct: true });
      await insertPublisher(ctx, { status: "hidden", name: "Hidden Press", slug: "hidden-press" });

      // One Series with the given Volume positions; returns Volume IDs.
      const seriesWith = async (title: string, positions: number[]) => {
        const seriesId = await insertSeries(ctx, { title });
        const volumes = [];
        for (const position of positions)
          volumes.push(await insertVolume(ctx, { seriesId, position }));
        return { seriesId, volumes };
      };
      // An Edition covering one Volume, with one Release on the given date.
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
        const { seriesId } = args.series;
        const editionLineId = args.lineName
          ? await insertEditionLine(ctx, {
              seriesId,
              publisherId: args.publisherId,
              name: args.lineName,
            })
          : undefined;
        const editionId = await insertEdition(ctx, {
          publisherId: args.publisherId,
          editionLineId,
        });
        await insertCoverage(ctx, { editionId, volumeId: args.series.volumes[args.volume]! });
        await insertRelease(ctx, {
          status: args.status ?? "active",
          editionId,
          format: args.format ?? "physical",
          isbn13: args.isbn13,
          pubDate: pubDate(args.sort),
          publisherId: args.publisherId,
          seriesIds: [seriesId],
        });
      };

      const debut = await seriesWith("New Thing", [1]);
      const ongoing = await seriesWith("Long Runner", [1, 2, 3, 4, 5]);
      const classic = await seriesWith("Old Classic", [1]);
      const ghostly = await seriesWith("Ghostly", [3]);
      const august = await seriesWith("August Only", [2]);

      // Seven Seas, September: a debut in two Formats (one Series), a
      // continuing Volume, and a Deluxe-line Vol. 1 of an old Series.
      await release({
        publisherId: sevenSeas,
        series: debut,
        volume: 0,
        sort: 20260908,
        isbn13: "9780000000001",
      });
      await release({
        publisherId: sevenSeas,
        series: debut,
        volume: 0,
        sort: 20260908,
        format: "digital",
      });
      await release({ publisherId: sevenSeas, series: ongoing, volume: 4, sort: 20260915 });
      await release({
        publisherId: sevenSeas,
        series: classic,
        volume: 0,
        sort: 20260900,
        lineName: "Deluxe Edition",
      });
      // Out of September's counts: hidden, and another month.
      await release({
        publisherId: sevenSeas,
        series: ongoing,
        volume: 3,
        sort: 20260920,
        status: "hidden",
      });
      await release({ publisherId: sevenSeas, series: ongoing, volume: 3, sort: 20261001 });
      // August, for the delta.
      await release({ publisherId: sevenSeas, series: ongoing, volume: 3, sort: 20260811 });
      await release({ publisherId: tokyopop, series: august, volume: 0, sort: 20260804 });
      // Ghost Ship, September.
      await release({
        publisherId: ghostShip,
        series: ghostly,
        volume: 0,
        sort: 20260922,
        format: "digital",
      });
      return { tokyopop, cmx };
    });
    return { t, ids };
  }

  it("groups the month by Publisher, busiest first, with counts and a delta", async () => {
    const { t } = await board();
    const { board: cards } = await t.query(api.publisher.monthBoard, {
      year: 2026,
      month: 9,
    });
    expect(cards.map(({ covers, ...card }) => ({ ...card, covers: covers.length }))).toEqual([
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
      coverIsbns: ["9780000000001"],
    });
  });

  it("lists every active Publisher A–Z, imprints nested, defunct flagged", async () => {
    const { t } = await board();
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
        imprints: [{ name: "Ghost Ship", slug: "ghost-ship", defunct: false, releases: 1 }],
      },
      // Quiet this month, still listed.
      { name: "Tokyopop", slug: "tokyopop", defunct: false, releases: 0, imprints: [] },
    ]);
  });

  it("wraps January's delta to the previous December", async () => {
    const { t } = await board();
    await t.run(async (ctx) => {
      // Copies of an existing (visible) Seven Seas Release, re-dated.
      const [template] = await ctx.db.query("releases").take(1);
      if (!template) throw new Error("fixture has releases");
      const { _id, _creationTime, ...fields } = template;
      for (const sort of [20251210, 20260105]) {
        await ctx.db.insert("releases", { ...fields, pubDate: pubDate(sort) });
      }
    });
    const { board: cards } = await t.query(api.publisher.monthBoard, {
      year: 2026,
      month: 1,
    });
    expect(cards.map((card) => [card.releases, card.previousReleases])).toEqual([[1, 1]]);
  });

  it("counts a digital Release of an old Vol. 1 as a backfill, not a new series", async () => {
    const { t, ids } = await board();
    await t.run(async (ctx) => {
      // Tokyopop: Vol. 1 in print in 2019, its digital Release this month.
      const { editionId, seriesId } = await seedCatalog(ctx, {
        publisher: ids.tokyopop,
        series: { title: "Backfilled" },
        release: { pubDate: pubDate(20190305) },
      });
      await insertRelease(ctx, {
        editionId,
        format: "digital",
        pubDate: pubDate(20260910),
        publisherId: ids.tokyopop,
        seriesIds: [seriesId],
      });
    });
    const { board: cards } = await t.query(api.publisher.monthBoard, { year: 2026, month: 9 });
    const card = cards.find((c) => c.publisher.slug === "tokyopop");
    expect(card).toMatchObject({ releases: 1, series: 1, newSeries: 0 });
    // Seven Seas' debut (print and digital the same month) still counts.
    expect(cards.find((c) => c.publisher.slug === "seven-seas")?.newSeries).toBe(1);
  });

  it("does not read a year-only date this year as an earlier Release", async () => {
    const { t, ids } = await board();
    await t.run(async (ctx) => {
      // Two Vol. 1 Editions printing this September, each with a digital
      // sibling dated less precisely: "2026" (could be September) and
      // "July 2026" (genuinely earlier).
      for (const sibling of [20260000, 20260700]) {
        const { editionId, seriesId } = await seedCatalog(ctx, {
          publisher: ids.tokyopop,
          release: { pubDate: pubDate(20260916) },
        });
        await insertRelease(ctx, {
          editionId,
          format: "digital",
          pubDate: pubDate(sibling),
          publisherId: ids.tokyopop,
          seriesIds: [seriesId],
        });
      }
    });
    const { board: cards } = await t.query(api.publisher.monthBoard, { year: 2026, month: 9 });
    // Only the "2026" sibling's Series debuts; the July one is a backfill.
    expect(cards.find((c) => c.publisher.slug === "tokyopop")).toMatchObject({
      releases: 2,
      series: 2,
      newSeries: 1,
    });
  });

  it("does not count a relaunched Vol. 1 of an established Series as new", async () => {
    const { t, ids } = await board();
    await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Rescued" });
      const volumeId = await insertVolume(ctx, { seriesId });
      // CMX's Vol. 1 in 2005, and Tokyopop's new standard Vol. 1 this month.
      for (const [publisherId, sort] of [
        [ids.cmx, 20050412],
        [ids.tokyopop, 20260915],
      ] as const) {
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          pubDate: pubDate(sort),
          publisherId,
          seriesIds: [seriesId],
        });
      }
    });
    const tokyopopCard = async () =>
      (await t.query(api.publisher.monthBoard, { year: 2026, month: 9 })).board.find(
        (c) => c.publisher.slug === "tokyopop",
      );
    // Until the stats rebuild sees the Series, nothing earlier is known.
    expect(await tokyopopCard()).toMatchObject({ releases: 1, newSeries: 1 });
    await t.action(internal.seriesBrowse.rebuild, {});
    expect(await tokyopopCard()).toMatchObject({ releases: 1, series: 1, newSeries: 0 });
  });

  it("reads only active Releases, so hidden ones never crowd out the month", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { publisherId, seriesId, editionId } = await seedCatalog(ctx, {
        publisher: { name: "Tokyopop", slug: "tokyopop" },
        series: { title: "Survivor" },
        release: { pubDate: pubDate(20260930) },
      });
      // A full cap of hidden Releases dated before the one active Release.
      for (let n = 0; n < WINDOW_CAP; n++) {
        await insertRelease(ctx, {
          status: "hidden",
          editionId,
          publisherId,
          seriesIds: [seriesId],
          pubDate: pubDate(20260901),
        });
      }
    });
    const { board, directory } = await t.query(api.publisher.monthBoard, { year: 2026, month: 9 });
    expect(board.map((card) => [card.publisher.slug, card.releases])).toEqual([["tokyopop", 1]]);
    expect(directory).toMatchObject([{ slug: "tokyopop", releases: 1 }]);
  });

  it("reads a malformed month as an empty board, directory intact", async () => {
    const { t } = await board();
    const result = await t.query(api.publisher.monthBoard, { year: 2026, month: 13 });
    expect(result.board).toEqual([]);
    expect(result.directory).toHaveLength(3);
  });
});

describe("publisher precomputed boards", () => {
  afterEach(() => vi.useRealTimers());

  // A Publisher with one September 2026 release; `more` adds another.
  async function catalog() {
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
      const seriesId = await insertSeries(ctx, { title: "Spice and Wolf" });
      return { publisherId, seriesId };
    });
    const more = (sort: number) =>
      t.run(async (ctx) => {
        const editionId = await insertEdition(ctx, { publisherId: ids.publisherId });
        await insertRelease(ctx, {
          editionId,
          pubDate: pubDate(sort),
          publisherId: ids.publisherId,
          seriesIds: [ids.seriesId],
        });
      });
    await more(20260910);
    return { t, more };
  }

  const september = { year: 2026, month: 9 };
  const releasesIn = async (t: TestT) =>
    (await t.query(api.publisher.monthBoard, september)).board[0]?.releases ?? 0;

  it("keeps January of last year through December two years out", () => {
    expect(boardWindow(new Date("2026-09-28T12:00:00Z"))).toEqual({ from: 202501, to: 202812 });
    expect(boardWindow(new Date("2027-01-01T00:00:00Z"))).toEqual({ from: 202601, to: 202912 });
  });

  it("rebuilds last month through three months out hourly, across year ends", () => {
    expect(nearMonths(new Date("2026-09-28T12:00:00Z"))).toEqual({ from: 202608, to: 202612 });
    expect(nearMonths(new Date("2026-11-30T23:00:00Z"))).toEqual({ from: 202610, to: 202702 });
    expect(nearMonths(new Date("2027-01-01T00:00:00Z"))).toEqual({ from: 202612, to: 202704 });
  });

  it("serves stored months until the next rebuild, which rewrites only what changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
    const { t, more } = await catalog();

    // Only September has cards; empty months are left to compute live.
    // Each month is stored in both views, with and without Mature Series.
    const first = await t.action(internal.publisher.rebuildBoards, {});
    expect(first).toMatchObject({ changed: 2, failed: 0 });
    const stored = await t.run((ctx) => ctx.db.query("publisherBoards").collect());
    expect(stored.map((row) => [row.month, row.mature])).toEqual([
      [202609, undefined],
      [202609, true],
    ]);
    const computed = await t.query(internal.publisher.computeBoard, september);
    expect(await t.query(api.publisher.monthBoard, september)).toEqual(computed.general);
    expect(await t.query(api.publisher.monthBoard, { ...september, showMature: true })).toEqual(
      computed.mature,
    );
    expect(await releasesIn(t)).toBe(1);

    // A new release shows once the rebuild runs, not before, and only
    // September's board changes (October has no card to carry a delta).
    await more(20260920);
    expect(await releasesIn(t)).toBe(1);
    expect((await t.action(internal.publisher.rebuildBoards, { scope: "near" })).changed).toBe(2);
    expect(await releasesIn(t)).toBe(2);
    expect((await t.action(internal.publisher.rebuildBoards, {})).changed).toBe(0);
  });

  it("ignores a stored board written in an older shape", async () => {
    const { t } = await catalog();
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherBoards", {
        month: 202609,
        version: 0,
        payload: JSON.stringify({ board: [], directory: [] }),
        builtAt: 0,
      });
    });
    expect(await releasesIn(t)).toBe(1);
  });

  it("computes months outside the window live and drops their stored copies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-06-01T00:00:00Z"));
    const { t } = await catalog();
    await t.run(async (ctx) => {
      // A board stored back when 2026 was inside the window, now stale.
      await ctx.db.insert("publisherBoards", {
        month: 202609,
        version: 1,
        payload: JSON.stringify({ board: [], directory: [] }),
        builtAt: 0,
      });
    });
    const result = await t.action(internal.publisher.rebuildBoards, {});
    expect(result.dropped).toBe(1);
    expect(await releasesIn(t)).toBe(1);
  });
});
