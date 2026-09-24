import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
    // Nothing announced never leads the upcoming shelf.
    expect(upcoming.items.map((i) => i.title)).toEqual(["Tokyo Ghoul"]);
  });

  it("filters by publisher, status, format, and letter", async () => {
    const { t } = await seeded();
    const seas = await t.query(api.seriesBrowse.browse, { sort: "title", publisher: "seven-seas" });
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
    expect(f.publishers.map((p) => p.slug)).toEqual(["seven-seas", "viz-media"]);
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
