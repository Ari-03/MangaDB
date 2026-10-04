import type { StorageActionWriter } from "convex/server";
import { describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { seriesEditions } from "./catalog";
import { MIN_COVER_BYTES } from "./lib/covers";
import { seriesSearchText } from "./lib/searchMatch";
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
  seriesStatsRow,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

describe("catalog.stats", () => {
  it("returns zero counts on an empty deployment", async () => {
    const t = makeT();
    const stats = await t.query(api.catalog.stats, {});
    expect(stats.series).toEqual({ count: 0, capped: false });
    expect(stats.releases).toEqual({ count: 0, capped: false });
  });

  it("counts active records and skips hidden/merged ones", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      await insertPublisher(ctx, { status: "hidden", name: "Hidden Press", slug: "hidden-press" });
      await insertSeries(ctx, { publicId: 1, title: "A Certain Series" });
      await insertSeries(ctx, { status: "merged", publicId: 2, title: "Duplicate Series" });
    });

    const stats = await t.query(api.catalog.stats, {});
    expect(stats.publishers).toEqual({ count: 1, capped: false });
    expect(stats.series).toEqual({ count: 1, capped: false });
    expect(stats.volumes).toEqual({ count: 0, capped: false });
  });
});

describe("catalog.search", () => {
  const seed = async (t: TestT) => {
    await t.run(async (ctx) => {
      await insertSeries(ctx, { publicId: 1, title: "Tokyo Ghoul", altTitles: ["Toukyou Kushu"] });
      await insertSeries(ctx, { publicId: 2, title: "Witch Hat Atelier" });
      await insertSeries(ctx, { status: "hidden", publicId: 3, title: "Tokyo Hidden" });
      await insertSeries(ctx, { status: "merged", publicId: 4, title: "Tokyo Duplicate" });
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      await insertPublisher(ctx, {
        status: "hidden",
        name: "Seven Hidden Press",
        slug: "seven-hidden",
      });
      await insertSeries(ctx, { publicId: 5, title: "Seven Seeds" });
    });
  };

  it("finds Series by initials, run-together names, and nickname alt titles", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      let publicId = 100;
      for (const [title, altTitles] of [
        ["Ao Haru Ride", []],
        ["Attack on Titan: No Regrets", []],
        ["Attack on Titan", ["Shingeki no Kyojin", "SnK"]],
        ["Chainsaw Man", []],
        ["Jujutsu Kaisen", ["JJK"]],
        ["Four Lives Remain", ["Four Lives Remain: Tatsuya Endo Before Spy x Family"]],
        ["SPY×FAMILY", []],
      ] as const) {
        await insertSeries(ctx, {
          publicId: ++publicId,
          title,
          altTitles: [...altTitles],
          searchText: seriesSearchText(title, altTitles),
        });
      }
    });
    const titles = async (query: string) =>
      (await t.query(api.catalog.search, { query })).series.map((s) => s.title);
    expect(await titles("aot")).toEqual(["Attack on Titan", "Attack on Titan: No Regrets"]);
    expect((await titles("snk"))[0]).toBe("Attack on Titan");
    expect((await titles("chainsawman"))[0]).toBe("Chainsaw Man");
    expect(await titles("jjk")).toEqual(["Jujutsu Kaisen"]);
    // "×" reads as "x": the title itself leads, not the one that names it.
    expect((await titles("spy x family"))[0]).toBe("SPY×FAMILY");
    expect(await titles("sxf")).toEqual(["SPY×FAMILY"]);
    const suggested = await t.query(api.catalog.suggest, { query: "jk" });
    expect(suggested.series.map((s) => s.title)).toEqual(["Jujutsu Kaisen"]);
  });

  it("matches Series by title, skipping hidden and merged records", async () => {
    const t = makeT();
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "Tokyo" });
    expect(results.series).toEqual([
      {
        publicId: 1,
        title: "Tokyo Ghoul",
        altTitles: ["Toukyou Kushu"],
        altMatch: null,
        coverUrl: null,
        coverIsbn: [],
        volumeCount: null,
        publisher: null,
      },
    ]);
    expect(results.didYouMean).toEqual([]);
  });

  it("carries the Series library's jacket, count, and publisher", async () => {
    const t = makeT();
    await seed(t);
    await t.run(async (ctx) => {
      const series = await ctx.db
        .query("series")
        .withIndex("by_publicId", (q) => q.eq("publicId", 2))
        .unique();
      await ctx.db.insert(
        "seriesStats",
        seriesStatsRow({
          seriesId: series!._id,
          publicId: 2,
          title: "Witch Hat Atelier",
          sourceStatus: "ongoing",
          publishers: [{ name: "Kodansha", slug: "kodansha" }],
          hasPhysical: true,
          hasDigital: true,
          volumeCount: 13,
          releaseCount: 26,
          firstReleaseSort: 20190409,
          latestReleaseSort: 20250101,
          coverIsbn: "9781632367709",
        }),
      );
    });
    const [hit] = (await t.query(api.catalog.search, { query: "witch" })).series;
    expect(hit).toMatchObject({
      title: "Witch Hat Atelier",
      coverIsbn: ["9781632367709"],
      volumeCount: 13,
      publisher: "Kodansha",
    });
  });

  it("offers near-miss titles when nothing contains the query", async () => {
    const t = makeT();
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "tokyo ghool" });
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Tokyo Ghoul"]);
  });

  it("matches Series by alt title through the searchText index", async () => {
    const t = makeT();
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "Kushu" });
    expect(results.series.map((s) => s.publicId)).toEqual([1]);
  });

  it("resolves Publisher names case-insensitively, active only", async () => {
    const t = makeT();
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "seven" });
    expect(results.publishers).toEqual([{ name: "Seven Seas Entertainment", slug: "seven-seas" }]);
  });

  it("keeps typo help when the query only starts a word of a Publisher's name", async () => {
    const t = makeT();
    await seed(t);
    await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "Witchery Press", slug: "witchery-press" });
    });
    // "witche" is a fragment of Witchery, not its name: listed, suppresses nothing.
    const results = await t.query(api.catalog.search, { query: "witche" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["witchery-press"]);
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Witch Hat Atelier"]);
  });
});

describe("catalog.suggest", () => {
  const seed = async (t: TestT) => {
    await t.run(async (ctx) => {
      const rows: Array<[number, string, string[], "active" | "merged"]> = [
        [1, "Berserk of Gluttony", [], "active"],
        [2, "Berserk", ["Berserk Max"], "active"],
        [3, "Chainsaw Man", ["Chensoman"], "active"],
        [4, "Berserk Duplicate", [], "merged"],
        [5, "Seven Seeds", [], "active"],
      ];
      for (const [publicId, title, altTitles, status] of rows) {
        await insertSeries(ctx, { status, publicId, title, altTitles });
      }
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const kodansha = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
      await insertPublisher(ctx, {
        status: "merged",
        mergedIntoId: kodansha,
        name: "Kodansha Comics",
        slug: "kodansha-comics",
      });
    });
  };

  it("lists whole-query matches, the exact title first, active only", async () => {
    const t = makeT();
    await seed(t);
    const results = await t.query(api.catalog.suggest, { query: "berserk" });
    expect(results.series.map((s) => s.title)).toEqual(["Berserk", "Berserk of Gluttony"]);
    expect(results.didYouMean).toEqual([]);
  });

  it("names the alt title a Series matched through", async () => {
    const t = makeT();
    await seed(t);
    const [hit] = (await t.query(api.catalog.suggest, { query: "chensoman" })).series;
    expect(hit).toMatchObject({ title: "Chainsaw Man", altMatch: "Chensoman" });
  });

  it("suggests near misses for a typo instead of loose matches", async () => {
    const t = makeT();
    await seed(t);
    const berzerk = await t.query(api.catalog.suggest, { query: "berzerk" });
    expect(berzerk.series).toEqual([]);
    expect(berzerk.didYouMean.map((s) => s.title)).toEqual(["Berserk", "Berserk of Gluttony"]);
    const chainsawman = await t.query(api.catalog.suggest, { query: "chainsawman" });
    expect(chainsawman.didYouMean.map((s) => s.title)).toEqual(["Chainsaw Man"]);
  });

  it("finds publishers by the start of any word of their name, as search does", async () => {
    const t = makeT();
    await seed(t);
    const seven = [{ name: "Seven Seas Entertainment", slug: "seven-seas" }];
    for (const query of ["Seven", "seas", "Seven Seas Entertainment"]) {
      expect((await t.query(api.catalog.suggest, { query })).publishers).toEqual(seven);
    }
  });

  it("finds a merged Publisher's survivor by the old name", async () => {
    const t = makeT();
    await seed(t);
    expect((await t.query(api.catalog.suggest, { query: "kodansha comics" })).publishers).toEqual([
      { name: "Kodansha", slug: "kodansha" },
    ]);
    // The survivor is listed once, though both rows match "kodansha".
    expect((await t.query(api.catalog.suggest, { query: "kodansha" })).publishers).toEqual([
      { name: "Kodansha", slug: "kodansha" },
    ]);
  });

  it("does not match a Publisher mid-word", async () => {
    const t = makeT();
    await seed(t);
    await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "ComicsOne", slug: "comicsone" });
      await insertPublisher(ctx, { name: "One Peace Books", slug: "one-peace-books" });
    });
    const results = await t.query(api.catalog.suggest, { query: "one" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["one-peace-books"]);
  });
});

// The rules search and suggest share, each case run against both queries.
// Beside a named Publisher, search still lists the Series its words match;
// suggest, a dropdown, lists none.
describe.each([
  { name: "search", endpoint: api.catalog.search, beside: ["Seven Seeds"] },
  { name: "suggest", endpoint: api.catalog.suggest, beside: [] },
])("catalog.$name and Publisher names", ({ endpoint, beside }) => {
  const sevenSeas = { name: "Seven Seas Entertainment", slug: "seven-seas" };
  const viz = { name: "VIZ Media", slug: "viz-media" };

  /** Publishers whose names sit a typo away from Series titles; returns a way to ask `endpoint`. */
  const seeded = async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      for (const publisher of [sevenSeas, viz, { name: "Titan Manga", slug: "titan-manga" }]) {
        await insertPublisher(ctx, publisher);
      }
      await insertSeries(ctx, { publicId: 5, title: "Seven Seeds" });
      await insertSeries(ctx, { publicId: 6, title: "Mango Days" });
    });
    return (query: string) => t.query(endpoint, { query });
  };

  it("offers no typo help when the query names a Publisher", async () => {
    const ask = await seeded();
    // "Seven Seas" is one edit-pair from Seven Seeds, but it names a Publisher.
    const results = await ask("Seven Seas");
    expect(results.publishers.map((p) => p.slug)).toEqual(["seven-seas"]);
    expect(results.didYouMean).toEqual([]);
    expect(results.series.map((s) => s.title)).toEqual(beside);
    // Without the Publisher, the same query is a typo for Seven Seeds.
    const typo = await ask("Seven Seaz");
    expect(typo.didYouMean.map((s) => s.title)).toEqual(["Seven Seeds"]);
  });

  it("keeps typo help when the query is only a word inside a Publisher's name", async () => {
    const ask = await seeded();
    const results = await ask("manga");
    expect(results.publishers.map((p) => p.slug)).toEqual(["titan-manga"]);
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Mango Days"]);
  });

  it.each([
    ["Shonen Jump", viz],
    ["viz signature", viz],
    ["Seven Seas Siren", sevenSeas],
  ])("resolves the canonical alias %j to its Publisher", async (query, publisher) => {
    const ask = await seeded();
    const results = await ask(query);
    expect(results.publishers).toEqual([publisher]);
    expect(results.didYouMean).toEqual([]);
  });

  it.each([" ", "   "])("returns nothing for the blank query %j", async (query) => {
    const ask = await seeded();
    expect(await ask(query)).toEqual({ series: [], authors: [], publishers: [], didYouMean: [] });
  });
});

describe("catalog.seriesPage", () => {
  it("orders volumes by Position, never by the display Label", async () => {
    const t = makeT();
    const publicId = 1;
    await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { publicId, title: "Disorderly Labels" });
      // Labels sort the wrong way alphabetically and numerically; Position
      // must win. Inserted shuffled so creation order can't mask a bug.
      const rows: Array<[number, string]> = [
        [2, "10"],
        [1, "9"],
        [3, "Side Story"],
      ];
      let volPublicId = 1;
      for (const [position, label] of rows) {
        await insertVolume(ctx, { publicId: volPublicId++, seriesId, position, label });
      }
    });

    const page = await t.query(api.catalog.seriesPage, { publicId });
    expect(page?.volumes.map((v) => [v.position, v.label])).toEqual([
      [1, "9"],
      [2, "10"],
      [3, "Side Story"],
    ]);
  });

  it("resolves a merged Series to its survivor so the route can 301", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const winner = await insertSeries(ctx, { publicId: 1, title: "Survivor" });
      await insertSeries(ctx, {
        status: "merged",
        mergedIntoId: winner,
        publicId: 2,
        title: "Duplicate",
      });
    });

    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.series.publicId).toBe(1);
    expect(page?.series.title).toBe("Survivor");
  });

  it("returns null for unknown and hidden Series", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await insertSeries(ctx, { status: "hidden", publicId: 5, title: "Hidden" });
    });
    expect(await t.query(api.catalog.seriesPage, { publicId: 5 })).toBeNull();
    expect(await t.query(api.catalog.seriesPage, { publicId: 99 })).toBeNull();
  });

  it("shows no family when the umbrella has fewer than two active members", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const familyId = await ctx.db.insert("seriesFamilies", {
        status: "active",
        name: "Lonely Family",
      });
      await insertSeries(ctx, { publicId: 1, title: "Only Child", familyId });
      await insertSeries(ctx, { status: "hidden", publicId: 2, title: "Hidden Sibling", familyId });
    });
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.family).toBeNull();
  });

  it("excludes hidden editions and releases from the reading path", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Pub", slug: "pub" });
      const seriesId = await insertSeries(ctx, { publicId: 1, title: "S" });
      const volumeId = await insertVolume(ctx, { publicId: 1, seriesId });
      const hiddenEdition = await insertEdition(ctx, {
        status: "hidden",
        publicId: 1,
        publisherId,
      });
      await insertCoverage(ctx, { editionId: hiddenEdition, volumeId });
      const activeEdition = await insertEdition(ctx, { publicId: 2, publisherId });
      await insertCoverage(ctx, { editionId: activeEdition, volumeId });
      await insertRelease(ctx, {
        status: "hidden",
        editionId: activeEdition,
        format: "digital",
        publisherId,
        seriesIds: [seriesId],
      });
    });
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.editionGroups).toHaveLength(1);
    expect(page?.editionGroups[0]?.books.map((b) => b.publicId)).toEqual([2]);
    expect(page?.editionGroups[0]?.books[0]?.releases).toEqual([]);
  });
});

/**
 * Series 50, where the order Editions are met in matters: Volumes 1–4 (3
 * hidden), two standard runs of two books each that tie on length and first
 * release, so the run met first (Dark Horse, at Volume 1) leads though Seven
 * Seas' Edition was created first; a Deluxe line with a mapped and an
 * unmapped member; a hidden Edition met first at Volume 1; a hidden line's
 * member; and Dark Horse's Volume 1 jacket behind a placeholder.
 */
async function readingOrderSeries(ctx: MutationCtx & { storage: StorageActionWriter }) {
  const dh = await insertPublisher(ctx, { name: "Dark Horse", slug: "dark-horse" });
  const ss = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });
  const seriesId = await insertSeries(ctx, { publicId: 50, title: "Order Matters" });
  const volume = (position: number, status: "active" | "hidden" = "active") =>
    insertVolume(ctx, { publicId: 500 + position, seriesId, position, status });
  const [v1, v2, v3, v4] = [
    await volume(1),
    await volume(2),
    await volume(3, "hidden"),
    await volume(4),
  ];
  const deluxe = await insertEditionLine(ctx, { seriesId, publisherId: dh, name: "Deluxe" });
  const oldLine = await insertEditionLine(ctx, {
    seriesId,
    publisherId: dh,
    name: "Old",
    status: "hidden",
  });
  const edition = async (
    publicId: number,
    publisherId: Id<"publishers">,
    volumeIds: Array<Id<"volumes">>,
    fields: { status?: "hidden"; editionLineId?: Id<"editionLines">; linePosition?: string } = {},
  ) => {
    const editionId = await insertEdition(ctx, { publicId, publisherId, ...fields });
    for (const [index, volumeId] of volumeIds.entries()) {
      await insertCoverage(ctx, { editionId, volumeId, order: index + 1 });
    }
    return editionId;
  };
  const release = (
    editionId: Id<"editions">,
    publisherId: Id<"publishers">,
    sort: number,
    fields = {},
  ) =>
    insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      pubDate: pubDate(sort),
      ...fields,
    });
  const art = (bytes: number, type: string) =>
    ctx.storage.store(new Blob([new Uint8Array(bytes)], { type }));

  await edition(1, dh, [v1], { status: "hidden" });
  const ss2 = await edition(2, ss, [v2]);
  const dh1 = await edition(3, dh, [v1]);
  const deluxe1 = await edition(4, dh, [v1, v2], { editionLineId: deluxe, linePosition: "1" });
  const dh4 = await edition(5, dh, [v4]);
  const ss4 = await edition(6, ss, [v4, v3]);
  const deluxe2 = await edition(7, dh, [], { editionLineId: deluxe, linePosition: "2" });
  const old = await edition(8, dh, [], { editionLineId: oldLine });
  await edition(9, ss, [v3]);

  const placeholder = await art(100, "image/svg+xml");
  const jacket = await art(MIN_COVER_BYTES + 1, "image/jpeg");
  await release(dh1, dh, 20200101, { coverImage: { storageId: placeholder } });
  await release(dh1, dh, 20200201, { coverImage: { storageId: jacket } });
  await release(dh1, dh, 20200101, { format: "digital", status: "hidden" });
  await release(ss2, ss, 20200101);
  await release(dh4, dh, 20210101);
  await release(ss4, ss, 20210101);
  await release(deluxe1, dh, 20220101);
  await release(deluxe2, dh, 20220601);
  await release(old, dh, 20230101);
  return { seriesId, jacketUrl: await ctx.storage.getUrl(jacket) };
}

describe("catalog.seriesPage reads concurrently", () => {
  it("keeps the order Editions are met in, their reading paths and the cover", async () => {
    const t = makeT();
    const { jacketUrl } = await t.run(readingOrderSeries);
    const page = await t.query(api.catalog.seriesPage, { publicId: 50 });
    expect(
      page?.editionGroups.map((group) => [
        group.key,
        group.books.map((book) => [
          book.publicId,
          book.coverage.map((c) => c.position),
          book.releases.length,
        ]),
      ]),
    ).toEqual([
      [
        "dark-horse",
        [
          [3, [1], 2],
          [5, [4], 1],
        ],
      ],
      [
        "seven-seas",
        [
          [2, [2], 1],
          [6, [4], 1],
        ],
      ],
      [
        "dark-horse-deluxe",
        [
          [4, [1, 2], 1],
          [7, [], 1],
        ],
      ],
    ]);
    // The first stored cover that is not a placeholder, among Releases in stored order.
    expect(page?.editionGroups[0]?.books[0]?.coverUrl).toBe(jacketUrl);
    expect(page?.coverUrl).toBe(jacketUrl);
  });

  it("meets each Edition once, at its first active Volume, then unmapped line members", async () => {
    const t = makeT();
    const met = await t.run(async (ctx) => {
      const { seriesId } = await readingOrderSeries(ctx);
      const volumes = (
        await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
          .collect()
      ).filter((volume) => volume.status === "active");
      const { editions, firstPosition } = await seriesEditions(ctx, seriesId, volumes);
      return [...editions.values()].map((edition) => [
        edition.publicId,
        firstPosition.get(edition._id) ?? null,
      ]);
    });
    expect(met).toEqual([
      [3, 1],
      [4, 1],
      [2, 2],
      [5, 4],
      [6, 4],
      [7, null],
    ]);
  });

  it("waits on as many round trips for thirty Volumes as for three", async () => {
    const roundsFor = async (count: number) => {
      const t = makeT();
      return await t.run(async (ctx) => {
        const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
        const seriesId = await insertSeries(ctx, { title: "Long Run" });
        const line = await insertEditionLine(ctx, { seriesId, publisherId });
        for (let position = 1; position <= count; position++) {
          const volumeId = await insertVolume(ctx, { seriesId, position });
          const editionId = await insertEdition(ctx, { publisherId });
          await insertCoverage(ctx, { editionId, volumeId });
          await insertEdition(ctx, { publisherId, editionLineId: line });
        }
        const volumes = await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
          .collect();
        const counting = roundTrips(ctx);
        const { editions } = await seriesEditions(counting.ctx, seriesId, volumes);
        return { editions: editions.size, rounds: counting.rounds() };
      });
    };
    const few = await roundsFor(3);
    const many = await roundsFor(30);
    expect([few.editions, many.editions]).toEqual([6, 60]);
    // Coverage and lines together, then the Editions and line members;
    // one Volume at a time was two per Volume. Both rounds fit under
    // READ_CONCURRENCY; a wider one is split.
    expect(many.rounds).toBe(2);
    expect(few.rounds).toBe(2);
  });

  it("keeps a long Series' reads in flight under Convex's limit", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const seriesId = await insertSeries(ctx, { publicId: 1, title: "Long Run" });
      // 110 Volumes in three runs: 330 Editions, four reads each to hydrate,
      // more than 1,300 in flight if they all started at once.
      const lines = [];
      for (let run = 1; run <= 3; run++) {
        lines.push(await insertEditionLine(ctx, { seriesId, publisherId, name: `Run ${run}` }));
      }
      for (let position = 1; position <= 110; position++) {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        for (const editionLineId of lines) {
          const editionId = await insertEdition(ctx, {
            publisherId,
            editionLineId,
            linePosition: String(position),
          });
          await insertCoverage(ctx, { editionId, volumeId });
          await insertRelease(ctx, {
            editionId,
            publisherId,
            seriesIds: [seriesId],
            pubDate: pubDate(20260101),
          });
        }
      }
    });
    let books = 0;
    const load = await syscallLoad(async () => {
      const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
      books = page?.editionGroups.flatMap((group) => group.books).length ?? 0;
    });
    expect(books).toBe(330);
    // The queue is full at its widest, and never past it.
    expect(load.peak).toBe(READ_CONCURRENCY);
  });
});

describe("catalog.recentSeries", () => {
  // Newest first, publicIds 110 down to 101: hidden, Bookless, Mature, then
  // cloth (no ISBN) and jacketed Series mixed.
  async function shelf() {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const kinds = {
        110: "hidden",
        109: "bookless",
        108: "mature",
        107: "cloth",
        106: "jacket",
        105: "cloth",
        104: "jacket",
        103: "jacket",
        102: "jacket",
        101: "cloth",
      } as const;
      for (const [publicId, kind] of Object.entries(kinds)) {
        const seriesId = await insertSeries(ctx, {
          publicId: Number(publicId),
          title: `Series ${publicId}`,
          ...(kind === "hidden" ? { status: "hidden" as const } : {}),
          ...(kind === "bookless" ? { bookless: true } : {}),
          ...(kind === "mature" ? { mature: true } : {}),
        });
        const volumeId = await insertVolume(ctx, { seriesId });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          pubDate: pubDate(20260101),
          ...(kind === "cloth" ? {} : { isbn13: String(9780000000000 + Number(publicId)) }),
        });
      }
    });
    return async (limit: number, showMature: boolean) =>
      (await t.query(api.catalog.recentSeries, { limit, todaySort: 20261004, showMature })).map(
        (series) => [series.publicId, series.coverIsbns.length > 0],
      );
  }

  it("seats jacketed Series first, fills with cloth, and lists newest first", async () => {
    const ask = await shelf();
    expect(await ask(3, false)).toEqual([
      [106, true],
      [104, true],
      [103, true],
    ]);
    expect(await ask(3, true)).toEqual([
      [108, true],
      [106, true],
      [104, true],
    ]);
    // Only four jackets within reach: the newest cloth fills the fifth place.
    expect(await ask(5, false)).toEqual([
      [107, false],
      [106, true],
      [104, true],
      [103, true],
      [102, true],
    ]);
  });

  it("ranks the cover by the day it is given: a book counts as published from its release day", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const seriesId = await insertSeries(ctx, { publicId: 120, title: "Coming Soon" });
      for (const [position, isbn13, sort] of [
        [1, "9780000000001", 20261010],
        [2, "9780000000002", 20260101],
      ] as const) {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          isbn13,
          pubDate: pubDate(sort),
        });
      }
    });
    const isbns = async (todaySort?: number) =>
      (await t.query(api.catalog.recentSeries, { limit: 1, todaySort }))[0]?.coverIsbns;
    // Volume 1 is forthcoming the day before, so the published Volume 2 leads.
    expect(await isbns(20261009)).toEqual(["9780000000002", "9780000000001"]);
    expect(await isbns(20261010)).toEqual(["9780000000001", "9780000000002"]);
    // A client from before the argument gets the clock's day, as it always did.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T23:00:00Z"));
      expect(await isbns(undefined)).toEqual(["9780000000002", "9780000000001"]);
      vi.setSystemTime(new Date("2026-10-10T01:00:00Z"));
      expect(await isbns(undefined)).toEqual(["9780000000001", "9780000000002"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reads the clock when given the day", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      await seedCatalog(ctx, {
        publisher: publisherId,
        series: { publicId: 1 },
        release: { isbn13: "9780000000001", pubDate: pubDate(20261010) },
      });
    });
    // Record every Date built from the clock (no arguments) while the query runs.
    const NativeDate = Date;
    const clockReads: Array<string> = [];
    const clock = new Proxy(NativeDate, {
      construct(target, args, newTarget) {
        if (args.length === 0) clockReads.push(new Error().stack ?? "new Date()");
        return Reflect.construct(target, args, newTarget);
      },
    });
    const now = vi.spyOn(NativeDate, "now");
    vi.stubGlobal("Date", clock);
    try {
      await t.query(api.catalog.recentSeries, { limit: 3, todaySort: 20261004 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(clockReads).toEqual([]);
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
