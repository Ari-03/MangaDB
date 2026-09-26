import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

describe("catalog.stats", () => {
  it("returns zero counts on an empty deployment", async () => {
    const t = convexTest(schema);
    const stats = await t.query(api.catalog.stats, {});
    expect(stats.series).toEqual({ count: 0, capped: false });
    expect(stats.releases).toEqual({ count: 0, capped: false });
  });

  it("counts active records and skips hidden/merged ones", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      const hidden = await ctx.db.insert("publishers", {
        status: "hidden",
        name: "Hidden Press",
        slug: "hidden-press",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "A Certain Series",
        altTitles: [],
        searchText: "A Certain Series",
      });
      await ctx.db.insert("series", {
        status: "merged",
        publicId: 2,
        title: "Duplicate Series",
        altTitles: [],
        searchText: "Duplicate Series",
      });
      void hidden;
    });

    const stats = await t.query(api.catalog.stats, {});
    expect(stats.publishers).toEqual({ count: 1, capped: false });
    expect(stats.series).toEqual({ count: 1, capped: false });
    expect(stats.volumes).toEqual({ count: 0, capped: false });
  });
});

describe("catalog.listSeries", () => {
  it("lists active series in public-ID order, skipping hidden/merged", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "active",
        publicId: 2,
        title: "B",
        altTitles: [],
        searchText: "B",
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 3,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "A",
        altTitles: [],
        searchText: "A",
      });
    });
    expect(await t.query(api.catalog.listSeries, {})).toEqual([
      { publicId: 1, title: "A" },
      { publicId: 2, title: "B" },
    ]);
  });
});

describe("catalog.search", () => {
  const seed = async (t: ReturnType<typeof convexTest>) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Tokyo Ghoul",
        altTitles: ["Toukyou Kushu"],
        searchText: "Tokyo Ghoul Toukyou Kushu",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 2,
        title: "Witch Hat Atelier",
        altTitles: [],
        searchText: "Witch Hat Atelier",
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 3,
        title: "Tokyo Hidden",
        altTitles: [],
        searchText: "Tokyo Hidden",
      });
      await ctx.db.insert("series", {
        status: "merged",
        publicId: 4,
        title: "Tokyo Duplicate",
        altTitles: [],
        searchText: "Tokyo Duplicate",
      });
      await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      await ctx.db.insert("publishers", {
        status: "hidden",
        name: "Seven Hidden Press",
        slug: "seven-hidden",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 5,
        title: "Seven Seeds",
        altTitles: [],
        searchText: "Seven Seeds",
      });
    });
  };

  it("matches Series by title, skipping hidden and merged records", async () => {
    const t = convexTest(schema);
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
    const t = convexTest(schema);
    await seed(t);
    await t.run(async (ctx) => {
      const series = await ctx.db
        .query("series")
        .withIndex("by_publicId", (q) => q.eq("publicId", 2))
        .unique();
      await ctx.db.insert("seriesStats", {
        seriesId: series!._id,
        publicId: 2,
        title: "Witch Hat Atelier",
        titleSort: "witch hat atelier",
        letter: "w",
        sourceStatus: "ongoing",
        publishers: [{ name: "Kodansha", slug: "kodansha" }],
        hasPhysical: true,
        hasDigital: true,
        volumeCount: 13,
        releaseCount: 26,
        firstReleaseSort: 20190409,
        latestReleaseSort: 20250101,
        nextReleaseSort: 0,
        followers: 0,
        collectors: 0,
        coverUrl: null,
        coverIsbn: "9781632367709",
        rebuiltAt: 0,
      });
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
    const t = convexTest(schema);
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "tokyo ghool" });
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Tokyo Ghoul"]);
  });

  it("matches Series by alt title through the searchText index", async () => {
    const t = convexTest(schema);
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "Kushu" });
    expect(results.series.map((s) => s.publicId)).toEqual([1]);
  });

  it("resolves Publisher names case-insensitively, active only", async () => {
    const t = convexTest(schema);
    await seed(t);
    const results = await t.query(api.catalog.search, { query: "seven" });
    expect(results.publishers).toEqual([
      { name: "Seven Seas Entertainment", slug: "seven-seas" },
    ]);
  });

  it("offers no typo help when the query names a Publisher", async () => {
    const t = convexTest(schema);
    await seed(t);
    // "Seven Seas" is one edit-pair from Seven Seeds, but it names a Publisher.
    const results = await t.query(api.catalog.search, { query: "Seven Seas" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["seven-seas"]);
    expect(results.didYouMean).toEqual([]);
    // Without the Publisher, the same query is a typo for Seven Seeds.
    const typo = await t.query(api.catalog.search, { query: "Seven Seaz" });
    expect(typo.didYouMean.map((s) => s.title)).toEqual(["Seven Seeds"]);
  });

  it("resolves a canonical alias to its Publisher", async () => {
    const t = convexTest(schema);
    await seed(t);
    for (const [query, slug] of [
      ["Shonen Jump", "viz-media"],
      ["viz signature", "viz-media"],
      ["Seven Seas Siren", "seven-seas"],
    ]) {
      const results = await t.query(api.catalog.search, { query });
      expect(results.publishers.map((p) => p.slug)).toEqual([slug]);
      expect(results.didYouMean).toEqual([]);
    }
  });

  it("keeps typo help when the query only starts a word of a Publisher's name", async () => {
    const t = convexTest(schema);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", { status: "active", name: "Witchery Press", slug: "witchery-press" });
    });
    // "witche" is a fragment of Witchery, not its name: listed, suppresses nothing.
    const results = await t.query(api.catalog.search, { query: "witche" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["witchery-press"]);
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Witch Hat Atelier"]);
  });

  it("keeps typo help when the query is only a word inside a Publisher's name", async () => {
    const t = convexTest(schema);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", { status: "active", name: "Titan Manga", slug: "titan-manga" });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 6,
        title: "Mango Days",
        altTitles: [],
        searchText: "Mango Days",
      });
    });
    const results = await t.query(api.catalog.search, { query: "manga" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["titan-manga"]);
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Mango Days"]);
  });

  it("returns nothing for an empty or whitespace query", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.catalog.search, { query: "   " })).toEqual({
      series: [],
      publishers: [],
      didYouMean: [],
    });
  });
});

describe("catalog.suggest", () => {
  const seed = async (t: ReturnType<typeof convexTest>) => {
    await t.run(async (ctx) => {
      const rows: Array<[number, string, string[], "active" | "merged"]> = [
        [1, "Berserk of Gluttony", [], "active"],
        [2, "Berserk", ["Berserk Max"], "active"],
        [3, "Chainsaw Man", ["Chensoman"], "active"],
        [4, "Berserk Duplicate", [], "merged"],
        [5, "Seven Seeds", [], "active"],
      ];
      for (const [publicId, title, altTitles, status] of rows) {
        await ctx.db.insert("series", {
          status,
          publicId,
          title,
          altTitles,
          searchText: [title, ...altTitles].join(" "),
        });
      }
      await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      const kodansha = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha",
        slug: "kodansha",
      });
      await ctx.db.insert("publishers", {
        status: "merged",
        mergedIntoId: kodansha,
        name: "Kodansha Comics",
        slug: "kodansha-comics",
      });
    });
  };

  it("lists whole-query matches, the exact title first, active only", async () => {
    const t = convexTest(schema);
    await seed(t);
    const results = await t.query(api.catalog.suggest, { query: "berserk" });
    expect(results.series.map((s) => s.title)).toEqual([
      "Berserk",
      "Berserk of Gluttony",
    ]);
    expect(results.didYouMean).toEqual([]);
  });

  it("names the alt title a Series matched through", async () => {
    const t = convexTest(schema);
    await seed(t);
    const [hit] = (await t.query(api.catalog.suggest, { query: "chensoman" })).series;
    expect(hit).toMatchObject({ title: "Chainsaw Man", altMatch: "Chensoman" });
  });

  it("suggests near misses for a typo instead of loose matches", async () => {
    const t = convexTest(schema);
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
    const t = convexTest(schema);
    await seed(t);
    const seven = [{ name: "Seven Seas Entertainment", slug: "seven-seas" }];
    for (const query of ["Seven", "seas", "Seven Seas Entertainment"]) {
      expect((await t.query(api.catalog.suggest, { query })).publishers).toEqual(seven);
    }
  });

  it("finds a merged Publisher's survivor by the old name", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(
      (await t.query(api.catalog.suggest, { query: "kodansha comics" })).publishers,
    ).toEqual([{ name: "Kodansha", slug: "kodansha" }]);
    // The survivor is listed once, though both rows match "kodansha".
    expect(
      (await t.query(api.catalog.suggest, { query: "kodansha" })).publishers,
    ).toEqual([{ name: "Kodansha", slug: "kodansha" }]);
  });

  it("offers no typo help or loose matches when the query names a Publisher", async () => {
    const t = convexTest(schema);
    await seed(t);
    const results = await t.query(api.catalog.suggest, { query: "Seven Seas" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["seven-seas"]);
    expect(results.didYouMean).toEqual([]);
    expect(results.series).toEqual([]);
  });

  it("does not match a Publisher mid-word", async () => {
    const t = convexTest(schema);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", { status: "active", name: "ComicsOne", slug: "comicsone" });
      await ctx.db.insert("publishers", {
        status: "active",
        name: "One Peace Books",
        slug: "one-peace-books",
      });
    });
    const results = await t.query(api.catalog.suggest, { query: "one" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["one-peace-books"]);
  });

  it("keeps typo help beside a Publisher the query only shares a word with", async () => {
    const t = convexTest(schema);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", { status: "active", name: "Titan Manga", slug: "titan-manga" });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 6,
        title: "Mango Days",
        altTitles: [],
        searchText: "Mango Days",
      });
    });
    const results = await t.query(api.catalog.suggest, { query: "manga" });
    expect(results.publishers.map((p) => p.slug)).toEqual(["titan-manga"]);
    expect(results.didYouMean.map((s) => s.title)).toEqual(["Mango Days"]);
  });

  it("finds a Publisher through its canonical alias", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(
      (await t.query(api.catalog.suggest, { query: "shonen jump" })).publishers,
    ).toEqual([{ name: "VIZ Media", slug: "viz-media" }]);
  });

  it("returns nothing for a blank query", async () => {
    const t = convexTest(schema);
    await seed(t);
    expect(await t.query(api.catalog.suggest, { query: " " })).toEqual({
      series: [],
      didYouMean: [],
      publishers: [],
    });
  });
});

describe("catalog.seriesPage", () => {
  it("orders volumes by Position, never by the display Label", async () => {
    const t = convexTest(schema);
    const publicId = 1;
    await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title: "Disorderly Labels",
        altTitles: [],
        searchText: "Disorderly Labels",
      });
      // Labels sort the wrong way alphabetically and numerically; Position
      // must win. Inserted shuffled so creation order can't mask a bug.
      const rows: Array<[number, string]> = [
        [2, "10"],
        [1, "9"],
        [3, "Side Story"],
      ];
      let volPublicId = 1;
      for (const [position, label] of rows) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: volPublicId++,
          seriesId,
          position,
          label,
        });
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
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const winner = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Survivor",
        altTitles: [],
        searchText: "Survivor",
      });
      await ctx.db.insert("series", {
        status: "merged",
        mergedIntoId: winner,
        publicId: 2,
        title: "Duplicate",
        altTitles: [],
        searchText: "Duplicate",
      });
    });

    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.series.publicId).toBe(1);
    expect(page?.series.title).toBe("Survivor");
  });

  it("returns null for unknown and hidden Series", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 5,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      });
    });
    expect(await t.query(api.catalog.seriesPage, { publicId: 5 })).toBeNull();
    expect(await t.query(api.catalog.seriesPage, { publicId: 99 })).toBeNull();
  });

  it("shows no family when the umbrella has fewer than two active members", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const familyId = await ctx.db.insert("seriesFamilies", {
        status: "active",
        name: "Lonely Family",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Only Child",
        altTitles: [],
        searchText: "Only Child",
        familyId,
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 2,
        title: "Hidden Sibling",
        altTitles: [],
        searchText: "Hidden Sibling",
        familyId,
      });
    });
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.family).toBeNull();
  });

  it("excludes hidden editions and releases from the reading path", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Pub",
        slug: "pub",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "S",
        altTitles: [],
        searchText: "S",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 1,
        label: "1",
      });
      const hiddenEdition = await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 1,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId: hiddenEdition,
        volumeId,
        order: 1,
        extent: "complete",
      });
      const activeEdition = await ctx.db.insert("editions", {
        status: "active",
        publicId: 2,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId: activeEdition,
        volumeId,
        order: 1,
        extent: "complete",
      });
      await ctx.db.insert("releases", {
        status: "hidden",
        editionId: activeEdition,
        format: "digital",
        language: "en",
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
