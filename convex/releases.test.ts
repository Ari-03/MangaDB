import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { joinBrowseRows, WINDOW_CAP } from "./releases";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { MIN_COVER_BYTES } from "./lib/covers";
import { READ_CONCURRENCY } from "./lib/boundedReads";
import { pubDate, roundTrips, syscallLoad } from "./test.catalog";
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
import { makeT } from "./test.helpers";

const august = { year: 2026, month: 8 };

// Shared fixture: two publishers, two series, releases spread across July,
// August, and September 2026 — including a month-precision date (day TBA), a
// hidden release, and an omnibus — so one seed exercises the window scan,
// both filters, and the label composition.
async function seeded() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const viz = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seas = await insertPublisher(ctx, {
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    await insertPublisher(ctx, { status: "hidden", name: "Hidden Press", slug: "hidden-press" });

    const ghoul = await insertSeries(ctx, { title: "Tokyo Ghoul" });
    const quiet = await insertSeries(ctx, { title: "The Quiet Cartographer" });
    const g1 = await insertVolume(ctx, { seriesId: ghoul, position: 1 });
    const g2 = await insertVolume(ctx, { seriesId: ghoul, position: 2 });
    const g3 = await insertVolume(ctx, { seriesId: ghoul, position: 3 });
    const q1 = await insertVolume(ctx, { seriesId: quiet, position: 1 });

    // An Edition covering `volumeIds` completely, in order.
    const edition = async (publisherId: Id<"publishers">, volumeIds: Array<Id<"volumes">>) => {
      const editionId = await insertEdition(ctx, { publisherId });
      for (const [index, volumeId] of volumeIds.entries()) {
        await insertCoverage(ctx, { editionId, volumeId, order: index + 1 });
      }
      return editionId;
    };
    const ghoulEd1 = await edition(viz, [g1]);
    const omnibusEd = await edition(viz, [g1, g2, g3]);
    const quietEd = await edition(seas, [q1]);
    const ghoulRelease = { publisherId: viz, seriesIds: [ghoul] };
    const quietRelease = { editionId: quietEd, publisherId: seas, seriesIds: [quiet] };

    // August 2026 window contents:
    await insertRelease(ctx, { ...ghoulRelease, editionId: ghoulEd1, pubDate: pubDate(20260818) });
    await insertRelease(ctx, { ...ghoulRelease, editionId: omnibusEd, pubDate: pubDate(20260804) });
    // Month precision: known to publish in August, day TBA (sort 20260800).
    await insertRelease(ctx, { ...quietRelease, format: "digital", pubDate: pubDate(20260800) });
    await insertRelease(ctx, { ...quietRelease, status: "hidden", pubDate: pubDate(20260811) });
    // Neighbors that must stay outside the August window:
    await insertRelease(ctx, { ...quietRelease, pubDate: pubDate(20260731) });
    await insertRelease(ctx, {
      ...ghoulRelease,
      editionId: ghoulEd1,
      format: "digital",
      pubDate: pubDate(20260901),
    });
    // Year-only precision falls in no month window.
    await insertRelease(ctx, {
      ...ghoulRelease,
      editionId: ghoulEd1,
      format: "digital",
      pubDate: pubDate(20260000),
    });

    return { viz, seas };
  });
  return { t, ids };
}

describe("releases.monthBrowse", () => {
  it("scans exactly the month's date window, month-precision included", async () => {
    const { t } = await seeded();
    const result = await t.query(api.releases.monthBrowse, august);
    // The hidden release, both neighbors, and the year-only date are absent.
    expect(result.releases).toHaveLength(3);
    // Chronological: day-TBA (sort yyyymm00) first, then the dated rows.
    expect(result.releases.map((r) => [r.day, r.volumeLabel])).toEqual([
      [null, "Vol. 1"],
      [4, "Vol. 1–3"],
      [18, "Vol. 1"],
    ]);
  });

  it("names the current slug for an old one, for the pages' in-memory filter", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherSlugRedirects", { fromSlug: "viz", publisherId: ids.viz });
    });
    const slug = (s: string) => t.query(api.releases.canonicalPublisherSlug, { slug: s });
    expect(await slug("viz")).toBe("viz-media");
    expect(await slug("viz-media")).toBe("viz-media");
    expect(await slug("no-such-publisher")).toBeNull();
  });

  it("labels rows from Coverage: single volume, omnibus range, partial", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      await seedCatalog(ctx, {
        publisher: ids.viz,
        series: { title: "Split Story" },
        volume: { label: "3.5" },
        coverage: { extent: "partial" },
        release: { format: "digital", pubDate: pubDate(20260827) },
      });
    });
    const result = await t.query(api.releases.monthBrowse, august);
    const partial = result.releases.find((r) => r.day === 27);
    expect(partial?.volumeLabel).toBe("Vol. 3.5 (partial)");
    expect(result.releases.find((r) => r.day === 4)?.volumeLabel).toBe("Vol. 1–3");
  });

  it("lists active Publishers alphabetically for the shared filter", async () => {
    const { t } = await seeded();
    const result = await t.query(api.releases.monthBrowse, august);
    expect(result.publishers).toEqual([
      { name: "Seven Seas Entertainment", slug: "seven-seas" },
      { name: "VIZ Media", slug: "viz-media" },
    ]);
  });

  it("hides releases of hidden Editions and hidden Series", async () => {
    const { t, ids } = await seeded();
    await t.run(async (ctx) => {
      const hiddenSeries = await insertSeries(ctx, { status: "hidden", title: "Gone" });
      const hiddenEdition = await insertEdition(ctx, { status: "hidden", publisherId: ids.viz });
      await insertRelease(ctx, {
        editionId: hiddenEdition,
        pubDate: pubDate(20260820),
        publisherId: ids.viz,
        seriesIds: [hiddenSeries],
      });
    });
    const result = await t.query(api.releases.monthBrowse, august);
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

describe("releases.monthBrowse jackets", () => {
  // To Your Eternity Vol 25: the ebook's own ISBN has no art upstream, its
  // print sibling's does. Every row of the Edition tries print first.
  it("gives a digital row and its print sibling the same ISBNs, print first, across months", async () => {
    const t = makeT();
    const { artUrl } = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
      const seriesId = await insertSeries(ctx, { title: "To Your Eternity" });
      const edition = async (position: number) => {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        return editionId;
      };
      const release = async (
        editionId: Id<"editions">,
        format: "physical" | "digital",
        isbn13: string,
        sort: number,
        storageId?: Id<"_storage">,
      ) =>
        await insertRelease(ctx, {
          editionId,
          format,
          isbn13,
          pubDate: pubDate(sort),
          ...(storageId ? { coverImage: { storageId } } : {}),
          publisherId,
          seriesIds: [seriesId],
        });
      // Vol 25: both formats in October.
      const v25 = await edition(25);
      await release(v25, "digital", "9798898302498", 20261007);
      await release(v25, "physical", "9798888778661", 20261007);
      // Vol 26: the ebook in October, print (with stored art) in November.
      const art = await ctx.storage.store(
        new Blob([new Uint8Array(MIN_COVER_BYTES + 1)], { type: "image/jpeg" }),
      );
      const v26 = await edition(26);
      await release(v26, "digital", "9780000000026", 20261007);
      await release(v26, "physical", "9780000000126", 20261107, art);
      return { artUrl: await ctx.storage.getUrl(art) };
    });

    const october = await t.query(api.releases.monthBrowse, { year: 2026, month: 10 });
    const covers = october.releases.map((r) => [r.volumeLabel, r.format, r.coverUrl, r.coverIsbns]);
    expect(covers).toEqual([
      ["Vol. 25", "digital", null, ["9798888778661", "9798898302498"]],
      ["Vol. 25", "physical", null, ["9798888778661", "9798898302498"]],
      // The ebook wears its print sibling's stored cover and ISBN though
      // print is a month later.
      ["Vol. 26", "digital", artUrl, ["9780000000126", "9780000000026"]],
    ]);
    const november = await t.query(api.releases.monthBrowse, { year: 2026, month: 11 });
    expect(november.releases.map((r) => [r.coverUrl, r.coverIsbns])).toEqual([
      [artUrl, ["9780000000126", "9780000000026"]],
    ]);
  });
});

/** `ctx` with a db whose `query` tallies each table it scans, and the tally. */
function countingQueries(ctx: MutationCtx) {
  const counts = new Map<string, number>();
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      if (prop === "query") {
        return (table: Parameters<typeof target.query>[0]) => {
          counts.set(table, (counts.get(table) ?? 0) + 1);
          return target.query(table);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db }, counts };
}

// Audit E05: a Release without an ISBN borrows one from a sibling Release or
// an alternative Edition. The borrowed ISBN depends only on the Edition, so a
// window of ISBN-less rows must read each Edition's Releases and Coverage
// once, never once per row. The bounds below are the scans per Edition
// consulted; a read per row would exceed them.
describe("joinBrowseRows cover fallback", () => {
  it("reads each Edition's Releases and Coverage once per query", async () => {
    const t = makeT();
    const { counts, rows } = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const seriesId = await insertSeries(ctx, { title: "Tokyo Ghoul" });
      const edition = async (volumeId: Id<"volumes">) => {
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        return editionId;
      };
      const release = async (editionId: Id<"editions">, day: number, isbn13?: string) =>
        await insertRelease(ctx, {
          editionId,
          isbn13,
          pubDate: pubDate(20260800 + day),
          publisherId,
          seriesIds: [seriesId],
        });

      // Eleven Releases in one Edition, ten of them without an ISBN.
      const crowded = await edition(await insertVolume(ctx, { seriesId, position: 1 }));
      await release(crowded, 1, "9780000000001");
      for (let day = 2; day <= 11; day++) await release(crowded, day);
      // An Edition with no ISBN at all, whose Volume another Edition covers.
      const v2 = await insertVolume(ctx, { seriesId, position: 2 });
      const bare = await edition(v2);
      const other = await edition(v2);
      await insertRelease(ctx, {
        editionId: other,
        isbn13: "9780000000002",
        publisherId,
        seriesIds: [seriesId],
      });
      for (let day = 12; day <= 14; day++) await release(bare, day);

      const counting = countingQueries(ctx);
      const docs = await ctx.db.query("releases").collect();
      const dated = docs.filter((r) => r.pubDate !== undefined);
      const rows = await joinBrowseRows(counting.ctx, dated);
      return { counts: Object.fromEntries(counting.counts), rows };
    });

    expect(rows).toHaveLength(14);
    expect(rows.filter((r) => r.coverIsbns.join() === "9780000000001")).toHaveLength(11);
    expect(rows.filter((r) => r.coverIsbns.join() === "9780000000002")).toHaveLength(3);
    // At most one Releases scan per Edition consulted: the crowded one, the
    // bare one, and the alternative Edition the bare one borrows from.
    expect(counts.releases ?? 0).toBeLessThanOrEqual(3);
    // Coverage by Edition (shared with the Volume label) for the two Editions
    // with rows, plus one by-Volume scan for the bare Edition's fallback.
    expect(counts.volumeCoverages ?? 0).toBeLessThanOrEqual(3);
  });

  // Review wave 2, Efficiency P3: the by-Volume scan was repeated per borrowing Edition.
  it("scans a shared Volume's Coverage once for every Edition borrowing from it", async () => {
    const t = makeT();
    const { counts, rows } = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const seriesId = await insertSeries(ctx, { title: "Tokyo Ghoul" });
      const volumeId = await insertVolume(ctx, { seriesId });
      const edition = async (day: number, isbn13?: string) => {
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          isbn13,
          pubDate: pubDate(20260800 + day),
          publisherId,
          seriesIds: [seriesId],
        });
      };
      // One donor Edition with an ISBN, twelve ISBN-less borrowers of the same Volume.
      await edition(1, "9780000000001");
      for (let n = 2; n <= 13; n++) await edition(n);

      const counting = countingQueries(ctx);
      const dated = await ctx.db.query("releases").collect();
      const rows = await joinBrowseRows(counting.ctx, dated);
      return { counts: Object.fromEntries(counting.counts), rows };
    });

    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.coverIsbns.join() === "9780000000001")).toBe(true);
    // At most one Releases scan per Edition consulted.
    expect(counts.releases ?? 0).toBeLessThanOrEqual(13);
    // Thirteen by-Edition Coverage reads, plus one by-Volume scan shared by
    // all twelve borrowers (one each would make 25).
    expect(counts.volumeCoverages ?? 0).toBeLessThanOrEqual(14);
  });
});

// A month that mixes everything the join decides on, inserted out of date
// order: print and digital of one Edition on one day, an omnibus in an
// Edition Line (month precision) covering a hidden Volume, a crossover
// whose first Series is hidden, a Mature Series, and rows that drop out (a
// merged Edition, a hidden Series alone). Two Series share 15 August, so
// the day sorts by title, then Volume label.
async function mixedMonth() {
  const t = makeT();
  await t.run(async (ctx) => {
    const kodansha = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const yen = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
    const zeta = await insertSeries(ctx, { title: "Zeta Blade" });
    const adult = await insertSeries(ctx, { title: "After Dark", mature: true });
    const gone = await insertSeries(ctx, { status: "hidden", title: "Gone" });
    const z1 = await insertVolume(ctx, { seriesId: zeta, position: 1 });
    const z2 = await insertVolume(ctx, { seriesId: zeta, position: 2 });
    const z3 = await insertVolume(ctx, { seriesId: zeta, position: 3, status: "hidden" });
    const a1 = await insertVolume(ctx, { seriesId: adult, position: 1 });
    const g1 = await insertVolume(ctx, { seriesId: gone, position: 1 });
    const edition = async (
      publisherId: Id<"publishers">,
      volumeIds: Array<Id<"volumes">>,
      fields = {},
    ) => {
      const editionId = await insertEdition(ctx, { publisherId, ...fields });
      for (const [index, volumeId] of volumeIds.entries()) {
        await insertCoverage(ctx, { editionId, volumeId, order: index + 1 });
      }
      return editionId;
    };
    const line = await insertEditionLine(ctx, {
      seriesId: zeta,
      publisherId: kodansha,
      name: "Omnibus",
    });
    const zetaVol1 = await edition(kodansha, [z1]);
    const zetaVol2 = await edition(kodansha, [z2]);
    const omnibus = await edition(kodansha, [z1, z2, z3], {
      editionLineId: line,
      linePosition: "1",
    });
    const merged = await edition(kodansha, [z2], { status: "merged" });
    const afterDark = await edition(yen, [a1]);
    const goneEd = await edition(yen, [g1]);
    const zetaRow = { publisherId: kodansha, seriesIds: [zeta] };
    const yenRow = { publisherId: yen };
    const release = (fields: Parameters<typeof insertRelease>[1], sort: number) =>
      insertRelease(ctx, { ...fields, pubDate: pubDate(sort) });
    await release({ ...zetaRow, editionId: zetaVol2, isbn13: "9780000000020" }, 20260815);
    await release(
      { ...yenRow, editionId: afterDark, seriesIds: [adult], isbn13: "9780000000090" },
      20260815,
    );
    await release(
      { ...zetaRow, editionId: zetaVol1, format: "digital", isbn13: "9780000000011" },
      20260815,
    );
    await release({ ...zetaRow, editionId: omnibus, isbn13: "9780000000100" }, 20260800);
    await release({ ...zetaRow, editionId: merged, isbn13: "9780000000030" }, 20260810);
    await release({ ...yenRow, editionId: goneEd, seriesIds: [gone] }, 20260812);
    await release({ ...zetaRow, editionId: zetaVol1, isbn13: "9780000000010" }, 20260815);
    await release(
      { ...yenRow, editionId: zetaVol2, seriesIds: [gone, zeta], format: "digital" },
      20260803,
    );
  });
  return t;
}

describe("releases.monthBrowse joins every Release at once", () => {
  // What one-Release-at-a-time joining returned for this month (checked
  // against that implementation): the same rows, in the same order.
  const rows = [
    [0, "Zeta Blade", "Vol. 1–2", "physical", ["9780000000100"], false],
    [3, "Zeta Blade", "Vol. 2", "digital", ["9780000000020"], false],
    [15, "After Dark", "Vol. 1", "physical", ["9780000000090"], true],
    [15, "Zeta Blade", "Vol. 1", "digital", ["9780000000010", "9780000000011"], false],
    [15, "Zeta Blade", "Vol. 1", "physical", ["9780000000010", "9780000000011"], false],
    [15, "Zeta Blade", "Vol. 2", "physical", ["9780000000020"], false],
  ];
  const shape = (result: FunctionReturnType<typeof api.releases.monthBrowse>) =>
    result.releases.map((r) => [
      r.day ?? 0,
      r.series.map((s) => s.title).join(" × "),
      r.volumeLabel,
      r.format,
      r.coverIsbns,
      r.mature,
    ]);

  it("keeps the rows, their order and the Mature filter exactly", async () => {
    const t = await mixedMonth();
    expect(shape(await t.query(api.releases.monthBrowse, { ...august, showMature: true }))).toEqual(
      rows,
    );
    expect(
      shape(await t.query(api.releases.monthBrowse, { ...august, showMature: false })),
    ).toEqual(rows.filter((row) => row[5] === false));
    const omnibus = (await t.query(api.releases.monthBrowse, august)).releases[0];
    expect([omnibus?.lineName, omnibus?.linePosition, omnibus?.edition.title]).toEqual([
      "Omnibus",
      "1",
      "Zeta Blade Omnibus 1",
    ]);
  });

  it("reads each document once, however many rows share it", async () => {
    const t = await mixedMonth();
    const gets = await t.run(async (ctx) => {
      const counting = roundTrips(ctx);
      await joinBrowseRows(counting.ctx, await ctx.db.query("releases").collect());
      return [...counting.gets.values()];
    });
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((n) => n === 1)).toBe(true);
  });

  it("waits on as many round trips for forty Releases as for four", async () => {
    const roundsFor = async (count: number) => {
      const t = makeT();
      return await t.run(async (ctx) => {
        const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
        for (let n = 1; n <= count; n++) {
          await seedCatalog(ctx, {
            publisher: publisherId,
            series: { title: `Series ${n}` },
            release: { isbn13: String(9780000000000 + n), pubDate: pubDate(20260801 + (n % 28)) },
          });
        }
        const counting = roundTrips(ctx);
        const rows = await joinBrowseRows(counting.ctx, await ctx.db.query("releases").collect());
        return { rows: rows.length, rounds: counting.rounds() };
      });
    };
    const few = await roundsFor(4);
    const many = await roundsFor(40);
    expect([few.rows, many.rows]).toEqual([4, 40]);
    // Edition, then Series, then Coverage, Publisher and the jacket's
    // Releases, then the covered Volumes; one at a time was ~6 per Release.
    // Every round here fits under READ_CONCURRENCY; a wider one is split.
    expect(many.rounds).toBe(few.rounds);
    expect(many.rounds).toBeLessThanOrEqual(4);
  });

  it("keeps a busy month's reads in flight under Convex's limit", async () => {
    const t = makeT();
    const joined = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const art = await ctx.storage.store(
        new Blob([new Uint8Array(MIN_COVER_BYTES + 1)], { type: "image/jpeg" }),
      );
      // 300 Releases, each its own Series, line and stored cover: joined all
      // at once, more than 1,200 reads would be in flight.
      for (let n = 0; n < 300; n++) {
        const seriesId = await insertSeries(ctx, { title: `Series ${n}` });
        const volumeId = await insertVolume(ctx, { seriesId });
        const editionLineId = await insertEditionLine(ctx, { seriesId, publisherId });
        const editionId = await insertEdition(ctx, { publisherId, editionLineId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          isbn13: String(9780000000000 + n),
          pubDate: pubDate(20260818),
          coverImage: { storageId: art },
        });
      }
      const counting = roundTrips(ctx);
      await joinBrowseRows(counting.ctx, await ctx.db.query("releases").collect());
      return { rounds: counting.rounds(), peak: counting.peak() };
    });
    let rows = 0;
    const load = await syscallLoad(async () => {
      rows = (await t.query(api.releases.monthBrowse, august)).releases.length;
    });
    expect(rows).toBe(300);
    // The queue is full at its widest, and never past it.
    expect(load.peak).toBe(READ_CONCURRENCY);
    // The wide rounds split in the queue: ten round trips, where every read
    // at once was four and one Release at a time ~2,100.
    expect(joined.peak).toBe(READ_CONCURRENCY);
    expect(joined.rounds).toBeLessThanOrEqual(12);
  });

  it("reads only active Releases, so hidden ones never crowd out the month", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { publisherId, seriesId, editionId } = await seedCatalog(ctx, {
        series: { title: "Survivor" },
        release: { pubDate: pubDate(20260830) },
      });
      // A full cap of hidden Releases dated before the one active Release.
      for (let n = 0; n < WINDOW_CAP; n++) {
        await insertRelease(ctx, {
          status: "hidden",
          editionId,
          publisherId,
          seriesIds: [seriesId],
          pubDate: pubDate(20260801),
        });
      }
    });
    const result = await t.query(api.releases.monthBrowse, august);
    expect(result.releases.map((r) => r.series[0]?.title)).toEqual(["Survivor"]);
    expect(result.capped).toBe(false);
  });
});
