import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { joinBrowseRows } from "./releases";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { MIN_COVER_BYTES } from "./lib/covers";
import { pubDate } from "./test.catalog";
import {
  insertCoverage,
  insertEdition,
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
