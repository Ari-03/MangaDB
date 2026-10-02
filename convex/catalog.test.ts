import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { seriesSearchText } from "./lib/searchMatch";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
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
      await insertPublisher(ctx, { status: "hidden", name: "Seven Hidden Press", slug: "seven-hidden" });
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
        coverIsbn: null,
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
      coverIsbn: "9781632367709",
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
    expect(results.publishers).toEqual([
      { name: "Seven Seas Entertainment", slug: "seven-seas" },
    ]);
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
    expect(results.series.map((s) => s.title)).toEqual([
      "Berserk",
      "Berserk of Gluttony",
    ]);
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
    expect(berzerk.didYouMean.map((s) => s.title)).toEqual([
      "Berserk",
      "Berserk of Gluttony",
    ]);
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
    expect(
      (await t.query(api.catalog.suggest, { query: "kodansha comics" })).publishers,
    ).toEqual([{ name: "Kodansha", slug: "kodansha" }]);
    // The survivor is listed once, though both rows match "kodansha".
    expect(
      (await t.query(api.catalog.suggest, { query: "kodansha" })).publishers,
    ).toEqual([{ name: "Kodansha", slug: "kodansha" }]);
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
      await insertSeries(ctx, { status: "merged", mergedIntoId: winner, publicId: 2, title: "Duplicate" });
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
      const hiddenEdition = await insertEdition(ctx, { status: "hidden", publicId: 1, publisherId });
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
