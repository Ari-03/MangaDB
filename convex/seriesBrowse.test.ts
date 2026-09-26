import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { todaySortKey } from "./lib/dates";
import schema from "./schema";
import { letterFor, sortKeyFor } from "./seriesBrowse";

// Three Series with different shapes — a long-running one with a follower
// and a collector, a short completed one, and a hidden one that must never
// surface — so one seed exercises sort keys, filters, and the sweep.
async function seeded() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const viz = await ctx.db.insert("publishers", { status: "active", name: "VIZ Media", slug: "viz-media" });
    const seas = await ctx.db.insert("publishers", { status: "active", name: "Seven Seas", slug: "seven-seas" });
    const user = await ctx.db.insert("users", {
      clerkSubject: "user_1",
      username: "reader",
      usernameNormalized: "reader",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const mk = async (
      publicId: number,
      title: string,
      publisher: Id<"publishers">,
      volumes: number,
      dates: Array<number>,
      status: "active" | "hidden" = "active",
      sourceStatus: "ongoing" | "completed" = "ongoing",
    ) => {
      const seriesId = await ctx.db.insert("series", {
        status,
        publicId,
        title,
        altTitles: [],
        searchText: title,
        sourceStatus,
      });
      const releaseIds: Array<Id<"releases">> = [];
      for (let i = 0; i < volumes; i++) {
        const volumeId = await ctx.db.insert("volumes", {
          status: "active",
          publicId: publicId * 100 + i,
          seriesId,
          position: i + 1,
          label: String(i + 1),
        });
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: publicId * 100 + i,
          publisherId: publisher,
        });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
        const sort = dates[i] ?? 0;
        releaseIds.push(
          await ctx.db.insert("releases", {
            status: "active",
            editionId,
            publisherId: publisher,
            seriesIds: [seriesId],
            format: i % 2 === 0 ? "physical" : "digital",
            language: "en",
            isbn13: `978199900${String(publicId * 10 + i).padStart(4, "0")}`,
            pubDate: sort ? { year: Math.floor(sort / 10000), month: Math.floor(sort / 100) % 100, day: sort % 100, sort } : undefined,
          }),
        );
      }
      return { seriesId, releaseIds };
    };
    const ghoul = await mk(1, "Tokyo Ghoul", viz, 4, [20150616, 20160101, 20170101, 20991231]);
    const quiet = await mk(2, "The Quiet Cartographer", seas, 1, [20240101], "active", "completed");
    await mk(3, "Hidden Series", viz, 1, [20240101], "hidden");
    await ctx.db.insert("userSeriesStates", { userId: user, seriesId: ghoul.seriesId, following: true, followPromptDismissed: false });
    await ctx.db.insert("collectionEntries", { userId: user, releaseId: ghoul.releaseIds[0]!, state: "owned" });
    return { ghoul, quiet };
  });
  await t.action(internal.seriesBrowse.rebuild, {});
  return { t, ids };
}

describe("seriesBrowse.rebuild", () => {
  it("writes one row per active Series with derived facts", async () => {
    const { t } = await seeded();
    const rows = await t.run((ctx) => ctx.db.query("seriesStats").collect());
    expect(rows.map((r) => r.title).sort()).toEqual(["The Quiet Cartographer", "Tokyo Ghoul"]);
    const ghoul = rows.find((r) => r.title === "Tokyo Ghoul")!;
    expect(ghoul).toMatchObject({
      titleSort: "tokyo ghoul",
      letter: "t",
      volumeCount: 4,
      releaseCount: 4,
      hasPhysical: true,
      hasDigital: true,
      firstReleaseSort: 20150616,
      latestReleaseSort: 20991231,
      nextReleaseSort: 20991231,
      lastReleasedSort: 20170101,
      searchKey: "tokyo ghoul",
      followers: 1,
      collectors: 1,
      publishers: [{ name: "VIZ Media", slug: "viz-media" }],
    });
    expect(ghoul.coverIsbn).toBe("9781999000010");
    const quiet = rows.find((r) => r.title === "The Quiet Cartographer")!;
    expect(quiet).toMatchObject({ titleSort: "quiet cartographer", letter: "q", nextReleaseSort: 0, followers: 0 });
  });

  it("sweeps rows whose Series was hidden since", async () => {
    const { t, ids } = await seeded();
    await t.run((ctx) => ctx.db.patch(ids.quiet.seriesId, { status: "hidden" }));
    await t.action(internal.seriesBrowse.rebuild, {});
    const rows = await t.run((ctx) => ctx.db.query("seriesStats").collect());
    expect(rows.map((r) => r.title)).toEqual(["Tokyo Ghoul"]);
  });
});

describe("seriesBrowse.browse", () => {
  it("sorts by title with articles ignored, and pages with an exact cursor", async () => {
    const { t } = await seeded();
    const first = await t.query(api.seriesBrowse.browse, { sort: "title", pageSize: 1 });
    expect(first.items.map((i) => i.title)).toEqual(["The Quiet Cartographer"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await t.query(api.seriesBrowse.browse, { sort: "title", pageSize: 1, cursor: first.nextCursor });
    expect(second.items.map((i) => i.title)).toEqual(["Tokyo Ghoul"]);
    expect(second.nextCursor).toBeNull();
  });

  it("orders popularity and upcoming sorts the way a shelf expects", async () => {
    const { t } = await seeded();
    const followers = await t.query(api.seriesBrowse.browse, { sort: "followers" });
    expect(followers.items.map((i) => i.title)).toEqual(["Tokyo Ghoul", "The Quiet Cartographer"]);
    const upcoming = await t.query(api.seriesBrowse.browse, { sort: "upcoming" });
    // Nothing announced never leads the upcoming shelf; a sort never drops rows.
    expect(upcoming.items.map((i) => i.title)).toEqual(["Tokyo Ghoul", "The Quiet Cartographer"]);
    expect(upcoming.total).toBeNull();
  });

  it("filters by publisher, status, format, and letter", async () => {
    const { t } = await seeded();
    const seas = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["seven-seas"] });
    expect(seas.items.map((i) => i.title)).toEqual(["The Quiet Cartographer"]);
    const done = await t.query(api.seriesBrowse.browse, { sort: "title", status: "completed" });
    expect(done.items.map((i) => i.title)).toEqual(["The Quiet Cartographer"]);
    const digital = await t.query(api.seriesBrowse.browse, { sort: "title", format: "digital" });
    expect(digital.items.map((i) => i.title)).toEqual(["Tokyo Ghoul"]);
    const q = await t.query(api.seriesBrowse.browse, { sort: "title", letter: "q" });
    expect(q.items.map((i) => i.title)).toEqual(["The Quiet Cartographer"]);
  });

  it("searches titles and never surfaces hidden Series", async () => {
    const { t } = await seeded();
    const hits = await t.query(api.seriesBrowse.browse, { sort: "title", q: "ghoul" });
    expect(hits.items.map((i) => i.title)).toEqual(["Tokyo Ghoul"]);
    const hidden = await t.query(api.seriesBrowse.browse, { sort: "title", q: "hidden" });
    expect(hidden.items).toEqual([]);
  });

  it("reports facets", async () => {
    const { t } = await seeded();
    const f = await t.query(api.seriesBrowse.facets, {});
    expect(f.total).toBe(2);
    // From the rows: the hidden Series' VIZ book counts for nothing.
    expect(f.publishers).toEqual([
      { name: "Seven Seas", slug: "seven-seas", count: 1 },
      { name: "VIZ Media", slug: "viz-media", count: 1 },
    ]);
    expect(f.statuses).toEqual([
      { status: "ongoing", count: 1 },
      { status: "completed", count: 1 },
    ]);
  });
});

describe("sort keys", () => {
  it("drops articles and non-letters", () => {
    expect(sortKeyFor("The Apothecary Diaries")).toBe("apothecary diaries");
    expect(sortKeyFor("A Sign of Affection")).toBe("sign of affection");
    expect(sortKeyFor("86--EIGHTY-SIX")).toBe("86 eighty six");
    expect(letterFor("86 eighty six")).toBe("#");
    expect(letterFor("zom 100")).toBe("z");
  });
});

describe("seriesBrowse review follow-ups", () => {
  it("drops a Series hidden since the last rebuild from browse and search", async () => {
    const { t, ids } = await seeded();
    await t.run((ctx) => ctx.db.patch(ids.quiet.seriesId, { status: "hidden" }));
    const all = await t.query(api.seriesBrowse.browse, { sort: "title" });
    expect(all.items.map((i) => i.title)).toEqual(["Tokyo Ghoul"]);
    const hits = await t.query(api.seriesBrowse.browse, { sort: "title", q: "cartographer" });
    expect(hits.items).toEqual([]);
  });

  it("keeps an active Series when an older overlapping run sweeps", async () => {
    const { t, ids } = await seeded();
    // A row rewritten by an earlier-started run carries an older stamp.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.ghoul.seriesId))
        .unique();
      await ctx.db.patch(row!._id, { rebuiltAt: 1 });
    });
    await t.mutation(internal.seriesBrowse.sweepStale, { before: Date.now() });
    const rows = await t.run((ctx) => ctx.db.query("seriesStats").collect());
    expect(rows.map((r) => r.title).sort()).toEqual(["The Quiet Cartographer", "Tokyo Ghoul"]);
  });

  it("counts a month-precision date in the current month as upcoming", async () => {
    const t = convexTest(schema);
    const ym = Math.floor(todaySortKey() / 100) * 100;
    await t.run(async (ctx) => {
      const pub = await ctx.db.insert("publishers", { status: "active", name: "P", slug: "p" });
      const seriesId = await ctx.db.insert("series", { status: "active", publicId: 9, title: "Soon", altTitles: [], searchText: "Soon" });
      const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: 900, seriesId, position: 1 });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 900, publisherId: pub });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
      await ctx.db.insert("releases", {
        status: "active", editionId, publisherId: pub, seriesIds: [seriesId], format: "physical", language: "en",
        pubDate: { year: Math.floor(ym / 10000), month: Math.floor(ym / 100) % 100, sort: ym },
      });
    });
    await t.action(internal.seriesBrowse.rebuild, {});
    const upcoming = await t.query(api.seriesBrowse.browse, { sort: "upcoming" });
    expect(upcoming.items.map((i) => [i.title, i.nextReleaseSort])).toEqual([["Soon", ym]]);
  });

  it("pages search results", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const pub = await ctx.db.insert("publishers", { status: "active", name: "P", slug: "p" });
      for (let i = 1; i <= 3; i++) {
        const seriesId = await ctx.db.insert("series", { status: "active", publicId: i, title: `Echo ${i}`, altTitles: [], searchText: `Echo ${i}` });
        const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: i, seriesId, position: 1 });
        const editionId = await ctx.db.insert("editions", { status: "active", publicId: i, publisherId: pub });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
      }
    });
    await t.action(internal.seriesBrowse.rebuild, {});
    const p1 = await t.query(api.seriesBrowse.browse, { sort: "title", q: "echo", pageSize: 2 });
    expect(p1.items.map((i) => i.title)).toEqual(["Echo 1", "Echo 2"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await t.query(api.seriesBrowse.browse, { sort: "title", q: "echo", pageSize: 2, cursor: p1.nextCursor });
    expect(p2.items.map((i) => i.title)).toEqual(["Echo 3"]);
    expect(p2.nextCursor).toBeNull();
  });
});

/** A yyyymmdd key for the 15th of the month `n` months before now (UTC). */
function monthsAgo(n: number): number {
  const now = new Date();
  return todaySortKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15)));
}

type ShelfSpec = {
  title: string;
  publishers: Array<string>;
  volumes: number;
  /** Release dates, one per Volume in order; missing ones are undated. */
  dates: Array<number>;
  sourceStatus?: "ongoing" | "completed";
  altTitles?: Array<string>;
};

/**
 * A library shaped for the filters: each Series' Volumes cycle through its
 * Publishers, one physical Release each. publicIds follow the spec order.
 */
async function library(specs: Array<ShelfSpec>) {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const publishers = new Map<string, Id<"publishers">>();
    for (const slug of new Set(specs.flatMap((s) => s.publishers))) {
      publishers.set(slug, await ctx.db.insert("publishers", { status: "active", name: slug.toUpperCase(), slug }));
    }
    for (const [n, spec] of specs.entries()) {
      const publicId = n + 1;
      const altTitles = spec.altTitles ?? [];
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title: spec.title,
        altTitles,
        searchText: [spec.title, ...altTitles].join(" "),
        sourceStatus: spec.sourceStatus,
      });
      for (let i = 0; i < spec.volumes; i++) {
        const publisherId = publishers.get(spec.publishers[i % spec.publishers.length]!)!;
        const volumeId = await ctx.db.insert("volumes", { status: "active", publicId: publicId * 100 + i, seriesId, position: i + 1 });
        const editionId = await ctx.db.insert("editions", { status: "active", publicId: publicId * 100 + i, publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 0, extent: "complete" });
        const sort = spec.dates[i] ?? 0;
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          publisherId,
          seriesIds: [seriesId],
          format: "physical",
          language: "en",
          pubDate: sort ? { year: Math.floor(sort / 10000), month: Math.floor(sort / 100) % 100, day: sort % 100, sort } : undefined,
        });
      }
    }
  });
  await t.action(internal.seriesBrowse.rebuild, {});
  return t;
}

describe("seriesBrowse filters first, then the sort", () => {
  const shelf = () =>
    library([
      { title: "Alpha", publishers: ["viz"], volumes: 1, dates: [monthsAgo(1)] },
      { title: "Bravo", publishers: ["yen"], volumes: 3, dates: [monthsAgo(7), monthsAgo(5), 20991231] },
      { title: "Charlie", publishers: ["seas"], volumes: 8, dates: [monthsAgo(30), monthsAgo(24)] },
      { title: "Delta", publishers: ["viz", "yen"], volumes: 20, dates: [monthsAgo(10)], altTitles: ["Dérapage Contrôlé"] },
      { title: "Echo", publishers: ["kodansha"], volumes: 2, dates: [] },
      { title: "Foxtrot", publishers: ["seas"], volumes: 1, dates: [monthsAgo(30)], sourceStatus: "ongoing" },
    ]);
  const titles = (page: { items: Array<{ title: string }> }) => page.items.map((i) => i.title);

  it("records the last release already out beside the next one", async () => {
    const t = await shelf();
    const bravo = await t.run((ctx) => ctx.db.query("seriesStats").withIndex("by_publicId", (q) => q.eq("publicId", 2)).unique());
    expect(bravo).toMatchObject({ lastReleasedSort: monthsAgo(5), nextReleaseSort: 20991231, latestReleaseSort: 20991231 });
  });

  it("matches any of several publishers, with an exact total", async () => {
    const t = await shelf();
    const page = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["viz", "yen"] });
    expect(titles(page)).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(page.total).toBe(3);
    const one = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["kodansha"] });
    expect(titles(one)).toEqual(["Echo"]);
    expect(one.total).toBe(1);
  });

  it("buckets volume counts", async () => {
    const t = await shelf();
    const bucket = async (volumes: "one" | "2-5" | "6-15" | "16-plus") =>
      titles(await t.query(api.seriesBrowse.browse, { sort: "title", volumes }));
    expect(await bucket("one")).toEqual(["Alpha", "Foxtrot"]);
    expect(await bucket("2-5")).toEqual(["Bravo", "Echo"]);
    expect(await bucket("6-15")).toEqual(["Charlie"]);
    expect(await bucket("16-plus")).toEqual(["Delta"]);
  });

  type Timing = "upcoming" | "past-3m" | "past-6m" | "past-12m" | "finished";

  it("filters by release timing", async () => {
    const t = await shelf();
    const timing = async (timing: Timing) =>
      titles(await t.query(api.seriesBrowse.browse, { sort: "title", timing, todaySort: todaySortKey() }));
    expect(await timing("upcoming")).toEqual(["Bravo"]);
    expect(await timing("past-3m")).toEqual(["Alpha"]);
    expect(await timing("past-6m")).toEqual(["Alpha", "Bravo"]);
    expect(await timing("past-12m")).toEqual(["Alpha", "Bravo", "Delta"]);
    // Quiet for a year with nothing announced; Foxtrot's source is still
    // ongoing and Echo has never had a dated release.
    expect(await timing("finished")).toEqual(["Charlie"]);
  });

  it("counts timing back from the caller's todaySort, which it requires", async () => {
    const t = await shelf();
    const timing = async (timing: Timing, todaySort?: number) =>
      titles(await t.query(api.seriesBrowse.browse, { sort: "title", timing, todaySort }));
    // Three months on, Alpha's release (a month ago) has aged out of the
    // last three months; the cutoff follows the date passed, not the clock.
    expect(await timing("past-3m", monthsAgo(-3))).toEqual([]);
    expect(await timing("past-12m", monthsAgo(-3))).toEqual(["Alpha", "Bravo"]);
    // Upcoming reads no date; the others refuse to guess one.
    expect(await timing("upcoming")).toEqual(["Bravo"]);
    await expect(timing("past-3m")).rejects.toThrow(/todaySort/);
    await expect(timing("finished", 20261300)).rejects.toThrow(/todaySort/);
  });

  it("keeps paging a timing view from its first page's day", async () => {
    const t = await shelf();
    const args = { sort: "title" as const, timing: "past-6m" as const, pageSize: 1 };
    const p1 = await t.query(api.seriesBrowse.browse, { ...args, todaySort: todaySortKey() });
    expect([titles(p1), p1.total]).toEqual([["Alpha"], 2]);
    // The next page is asked for after the day turned, three months on:
    // Bravo (five months ago) would have aged out, but the cursor keeps the
    // first page's cutoff, so the view ends as it began.
    const p2 = await t.query(api.seriesBrowse.browse, { ...args, todaySort: monthsAgo(-3), cursor: p1.nextCursor });
    expect([titles(p2), p2.total, p2.nextCursor]).toEqual([["Bravo"], 2, null]);
    // A cursor from before this field existed falls back to todaySort.
    const bare = await t.query(api.seriesBrowse.browse, { ...args, todaySort: monthsAgo(-3), cursor: btoa(JSON.stringify({ v: "alpha", id: 1 })) });
    expect([titles(bare), bare.total]).toEqual([[], 1]);
  });

  it("sorts and pages a combined filter to the end, keeping the total", async () => {
    const t = await shelf();
    const args = { sort: "volumes" as const, publishers: ["viz", "yen", "seas"], pageSize: 2 };
    const p1 = await t.query(api.seriesBrowse.browse, args);
    const p2 = await t.query(api.seriesBrowse.browse, { ...args, cursor: p1.nextCursor });
    const p3 = await t.query(api.seriesBrowse.browse, { ...args, cursor: p2.nextCursor });
    // Most volumes first; the one-volume tie breaks by newest publicId.
    expect([titles(p1), titles(p2), titles(p3)]).toEqual([["Delta", "Charlie"], ["Bravo", "Foxtrot"], ["Alpha"]]);
    expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
    expect(p3.nextCursor).toBeNull();

    const narrow = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["seas"], volumes: "one", timing: "past-12m", todaySort: todaySortKey() });
    expect(narrow).toMatchObject({ items: [], total: 0, nextCursor: null });
  });

  it("keeps nothing-announced last on a filtered upcoming sort", async () => {
    const t = await shelf();
    const page = await t.query(api.seriesBrowse.browse, { sort: "upcoming", publishers: ["yen", "kodansha"] });
    expect(titles(page)).toEqual(["Bravo", "Delta", "Echo"]);
  });

  it("searches titles and alt titles by word prefix as you type", async () => {
    const t = await shelf();
    const q = async (q: string, extra: { publishers?: Array<string> } = {}) =>
      titles(await t.query(api.seriesBrowse.browse, { sort: "title", q, ...extra }));
    expect(await q("del")).toEqual(["Delta"]);
    expect(await q("derapage contr")).toEqual(["Delta"]);
    expect(await q("elta")).toEqual([]);
    expect(await q("a", { publishers: ["viz"] })).toEqual(["Alpha"]);
    // Only a real word counts: punctuation alone filters nothing.
    const all = await t.query(api.seriesBrowse.browse, { sort: "title", q: " - " });
    expect(all.total).toBeNull();
  });

  it("packs every row once, by publicId block, and drops emptied packs", async () => {
    const t = await shelf();
    const packs = await t.run((ctx) => ctx.db.query("seriesStatsPacks").collect());
    expect(packs.map((p) => [p.block, p.entries.map((e) => e.publicId)])).toEqual([[0, [1, 2, 3, 4, 5, 6]]]);
    expect(packs[0]!.entries[3]).toMatchObject({ titleSort: "delta", searchKey: "delta derapage controle", volumeCount: 20 });
    // A stale pack past the catalog's last block goes on the next rebuild.
    await t.run((ctx) => ctx.db.insert("seriesStatsPacks", { block: 7, entries: [] }));
    await t.action(internal.seriesBrowse.rebuild, {});
    const blocks = await t.run(async (ctx) => (await ctx.db.query("seriesStatsPacks").collect()).map((p) => p.block));
    expect(blocks).toEqual([0]);
  });

  it("filters from the rows themselves before any pack is written", async () => {
    const t = await shelf();
    await t.run(async (ctx) => {
      for (const pack of await ctx.db.query("seriesStatsPacks").collect()) await ctx.db.delete(pack._id);
      for (const config of await ctx.db.query("appConfig").collect()) await ctx.db.delete(config._id);
    });
    const page = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["viz", "yen"] });
    expect(titles(page)).toEqual(["Alpha", "Bravo", "Delta"]);
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(6);
  });

  it("falls back to the row scan while a first build's packs are partial", async () => {
    const t = await shelf();
    // Mid first rebuild: a pack holds only some Series, nothing published yet.
    const truncate = () =>
      t.run(async (ctx) => {
        const [pack] = await ctx.db.query("seriesStatsPacks").collect();
        await ctx.db.patch(pack!._id, { entries: pack!.entries.slice(0, 2) });
      });
    await t.run(async (ctx) => {
      for (const config of await ctx.db.query("appConfig").collect()) await ctx.db.delete(config._id);
    });
    await truncate();
    const page = await t.query(api.seriesBrowse.browse, { sort: "title", publishers: ["viz", "yen"] });
    expect([titles(page), page.total]).toEqual([["Alpha", "Bravo", "Delta"], 3]);
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(6);
    // The last pack of a run publishes the set; from then on readers trust it.
    await t.mutation(internal.seriesBrowse.repackBlock, { block: 0 });
    const config = await t.run((ctx) => ctx.db.query("appConfig").first());
    expect(config).toMatchObject({ bootstrapMode: false, seriesPacksReady: true });
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(6);
    await truncate();
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(2);
  });

  it("counts Series per publisher in the facets", async () => {
    const t = await shelf();
    const f = await t.query(api.seriesBrowse.facets, {});
    expect(f.total).toBe(6);
    expect(f.publishers.map((p) => [p.slug, p.count])).toEqual([
      ["kodansha", 1],
      ["seas", 2],
      ["viz", 2],
      ["yen", 2],
    ]);
  });
});
