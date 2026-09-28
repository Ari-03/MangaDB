import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AnnCredit } from "./lib/ann";
import { roleFor } from "./people";
import schema from "./schema";

describe("roleFor", () => {
  it("keeps the makers and the source, drops other tasks", () => {
    expect(roleFor("Story & Art")).toBe("story_art");
    expect(roleFor("Story")).toBe("story");
    expect(roleFor("Art")).toBe("art");
    expect(roleFor("Original creator")).toBe("original");
    expect(roleFor("Original Concept")).toBe("original");
    expect(roleFor("Original Character Design")).toBeNull();
  });
});

// Isayama writes and draws Attack on Titan and created No Regrets, which
// Gan Sunaaku writes and Hikaru Suruga draws; Suruga's credit comes from a
// second ANN entry on a Series later merged into No Regrets.
async function catalog() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    let publicId = 0;
    const series = (title: string, extra: { bookless?: true } = {}) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: ++publicId,
        title,
        altTitles: [],
        searchText: title,
        ...extra,
      });
    const aot = await series("Attack on Titan");
    const regrets = await series("Attack on Titan: No Regrets");
    const duplicate = await series("No Regrets (duplicate)");
    await ctx.db.patch(duplicate, { status: "merged", mergedIntoId: regrets });
    const bookless = await series("Attack on Titan: Lost Girls", { bookless: true });
    const observe = (mangaId: string, seriesId: Id<"series">, credits?: AnnCredit[]) =>
      ctx.db.insert("sourceObservations", {
        sourceKey: "ann",
        sourceRecordId: `manga:${mangaId}`,
        recordRef: { type: "series", id: seriesId },
        snapshot: { kind: "annManga", id: mangaId, staff: [], ...(credits ? { credits } : {}) },
        lastSeenAt: 0,
        withdrawn: false,
      });
    const isayama = { personId: "97559", name: "Hajime Isayama" };
    await observe("12308", aot, [{ ...isayama, task: "Story & Art" }]);
    await observe("15904", regrets, [
      { personId: "127179", name: "Gan Sunaaku", task: "Story" },
      { ...isayama, task: "Original creator" },
      { personId: "1", name: "Designer", task: "Original Character Design" },
    ]);
    await observe("99999", duplicate, [{ personId: "127178", name: "Hikaru Suruga", task: "Art" }]);
    await observe("20000", bookless, [{ ...isayama, task: "Original creator" }]);
    // Stored before the importer kept credits: names only, nothing to credit.
    await observe("30000", aot);
    await ctx.db.insert("seriesStats", {
      seriesId: aot,
      publicId: 1,
      title: "Attack on Titan",
      titleSort: "attack on titan",
      letter: "a",
      sourceStatus: "completed",
      publishers: [{ name: "Kodansha", slug: "kodansha" }],
      hasPhysical: true,
      hasDigital: true,
      volumeCount: 34,
      releaseCount: 68,
      firstReleaseSort: 20120619,
      latestReleaseSort: 20210000,
      nextReleaseSort: 0,
      followers: 0,
      collectors: 0,
      coverUrl: null,
      coverIsbn: "9781612620244",
      rebuiltAt: 0,
    });
    return { aot, regrets, bookless };
  });
  await t.action(internal.people.rebuild, {});
  return { t, ids };
}

describe("people.rebuild", () => {
  it("credits each Series from ANN staff, merged Series via their survivor", async () => {
    const { t, ids } = await catalog();
    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.credits.map((c) => [c.name, c.role])).toEqual([
      ["Gan Sunaaku", "story"],
      ["Hikaru Suruga", "art"],
      ["Hajime Isayama", "original"],
    ]);
    const people = await t.run((ctx) => ctx.db.query("people").collect());
    // One row per ANN person; character design credits no one.
    expect(people.map((p) => p.name).sort()).toEqual([
      "Gan Sunaaku",
      "Hajime Isayama",
      "Hikaru Suruga",
    ]);
    const isayama = people.find((p) => p.name === "Hajime Isayama")!;
    // The bookless Series is credited but not counted or shown.
    expect(isayama).toMatchObject({ seriesCount: 2, coverIsbn: "9781612620244" });
    const credits = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.bookless))
        .collect(),
    );
    expect(credits).toHaveLength(1);
  });

  it("drops credits no observation gives any more", async () => {
    const { t, ids } = await catalog();
    await t.run(async (ctx) => {
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:12308"))
        .unique();
      await ctx.db.patch(observation!._id, { withdrawn: true });
    });
    await t.action(internal.people.rebuild, {});
    const credits = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.aot))
        .collect(),
    );
    expect(credits).toEqual([]);
  });
});

describe("people.authorPage and people.authors", () => {
  it("lists an author's visible Series with roles, latest release first", async () => {
    const { t } = await catalog();
    const isayama = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_annId", (q) => q.eq("annId", "97559"))
        .unique(),
    );
    const page = await t.query(api.people.authorPage, { publicId: isayama!.publicId });
    expect(page?.author).toMatchObject({
      name: "Hajime Isayama",
      annUrl: "https://www.animenewsnetwork.com/encyclopedia/people.php?id=97559",
    });
    expect(page?.series.map((s) => [s.title, s.roles])).toEqual([
      ["Attack on Titan", ["story_art"]],
      ["Attack on Titan: No Regrets", ["original"]],
    ]);
    expect(await t.query(api.people.authorPage, { publicId: 999 })).toBeNull();
  });

  it("pages authors most prolific first", async () => {
    const { t } = await catalog();
    const first = await t.query(api.people.authors, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.page.map((a) => [a.name, a.seriesCount])).toEqual([["Hajime Isayama", 2]]);
    const rest = await t.query(api.people.authors, {
      paginationOpts: { numItems: 10, cursor: first.continueCursor },
    });
    expect(rest.page.map((a) => a.seriesCount)).toEqual([1, 1]);
  });
});

describe("author search", () => {
  it("finds authors by name in search and suggestions", async () => {
    const { t } = await catalog();
    const search = await t.query(api.catalog.search, { query: "isayama" });
    expect(search.authors.map((a) => [a.name, a.seriesCount])).toEqual([["Hajime Isayama", 2]]);
    const suggest = await t.query(api.catalog.suggest, { query: "hajime isa" });
    expect(suggest.authors.map((a) => a.name)).toEqual(["Hajime Isayama"]);
  });
});
