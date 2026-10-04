// Mature Series (lib/mature.ts): what the parsers read from each source's
// age rating, how the Series library rebuild derives `series.mature`, and
// how public discovery leaves Mature Series out unless the viewer opted in.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import { isMatureEntry } from "./lib/ann";
import { isMatureRating as kodanshaMature } from "./lib/kodansha";
import { linkSeriesObservation } from "./lib/pipeline";
import { normalizeBook, parseBookPage } from "./lib/sevenSeas";
import { parseTitlePage, toSnapshots } from "./lib/yenPress";
import { pubDate } from "./test.catalog";
import { insertObservation, insertPublisher, seedCatalog } from "./test.factories";
import { alice, makeT, seedTeam, signedIn } from "./test.helpers";

const yenFixture = (name: string) =>
  readFileSync(new URL(`./lib/__fixtures__/yenPress/${name}.html`, import.meta.url), "utf8");

describe("source age ratings", () => {
  it("reads Kodansha's age_rating in both feed shapes", () => {
    expect(kodanshaMature({ rating: 18, label: "Mature" })).toBe(true);
    expect(kodanshaMature(18)).toBe(true);
    expect(kodanshaMature({ rating: 16, label: "Teen" })).toBe(false);
    expect(kodanshaMature(undefined)).toBe(false);
  });

  it("reads Seven Seas' age-rating badge", () => {
    const page = (id: string) =>
      `<div id="volume-module"><img src="https://sevenseasentertainment.com/wp-content/uploads/c.jpg"></br><div class="age-rating" id="${id}"></div></div><div id="volume-meta"><p><b>Format:</b> Manga</p></div>`;
    const listing = {
      sourceRecordId: "1",
      slug: "book-vol-1",
      url: "https://sevenseasentertainment.com/books/book-vol-1/",
      title: "Book Vol. 1",
      modifiedGmt: "2026-01-01T00:00:00",
    };
    expect(parseBookPage(page("mature")).ageRating).toBe("mature");
    expect(normalizeBook(listing, parseBookPage(page("mature"))).mature).toBe(true);
    expect(normalizeBook(listing, parseBookPage(page("olderteen17"))).mature).toBe(false);
    // A page without the badge was still read: false, not "unread".
    expect(
      normalizeBook(
        listing,
        parseBookPage(page("x").replace(/<div class="age-rating"[^>]*><\/div>/, "")),
      ).mature,
    ).toBe(false);
  });

  it("reads Yen Press's Age Rating detail per format", () => {
    const url = "https://yenpress.com/titles/9798855427691-interspecies-reviewers-vol-11";
    const mature = toSnapshots(parseTitlePage(yenFixture("interspecies-reviewers-11"))!, url);
    expect(mature.length).toBeGreaterThan(0);
    expect(mature.every((snapshot) => snapshot.mature === true)).toBe(true);
    const allAges = toSnapshots(
      parseTitlePage(yenFixture("little-witch-academia"))!,
      "https://yenpress.com/titles/9780316360234-little-witch-academia-vol-1-manga",
    );
    expect(allAges.every((snapshot) => snapshot.mature === false)).toBe(true);
  });

  it("reads ANN's rating and genres, and treats no rating as no evidence", () => {
    const info = (type: string, value: string) => `<info gid="1" type="${type}">${value}</info>`;
    expect(isMatureEntry(info("Objectionable content", "AO"))).toBe(true);
    expect(isMatureEntry(info("Objectionable content", "MA"))).toBe(true);
    expect(isMatureEntry(info("Objectionable content", "TA"))).toBe(false);
    expect(isMatureEntry(info("Genres", "erotica"))).toBe(true);
    expect(isMatureEntry(info("Themes", "hentai"))).toBe(true);
    expect(isMatureEntry(info("Genres", "romance"))).toBe(false);
  });
});

// Two one-volume Series under one publisher, rebuilt: "Quiet" stays
// general; "Heat" is what each test makes mature.
async function seeded() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const publisher = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });
    const adult = await insertPublisher(ctx, { name: "Ghost Ship", slug: "ghost-ship" });
    const mk = async (publicId: number, title: string) => {
      const { seriesId, editionId, releaseId } = await seedCatalog(ctx, {
        publisher,
        series: { publicId, title },
        volume: { publicId },
        edition: { publicId },
        coverage: { order: 0 },
        release: { isbn13: `979888000000${publicId}`, pubDate: pubDate(20260915) },
      });
      return { seriesId, editionId, releaseId };
    };
    return {
      publisher,
      adult,
      quiet: await mk(1, "Quiet Garden"),
      heat: await mk(2, "Heat Garden"),
    };
  });
  const rebuild = () => t.action(internal.seriesBrowse.rebuild, {});
  const heat = () => t.run((ctx) => ctx.db.get(ids.heat.seriesId));
  return { t, ids, rebuild, heat };
}

describe("deriving series.mature (seriesBrowse.rebuild)", () => {
  it("follows a source that rates one of the Series' books 18+", async () => {
    const { t, ids, rebuild, heat } = await seeded();
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "42",
        recordRef: { type: "release", id: ids.heat.releaseId },
        snapshot: { kind: "book", mature: true },
      }),
    );
    await rebuild();
    expect((await heat())?.mature).toBe(true);
    const row = await t.run((ctx) =>
      ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.heat.seriesId))
        .unique(),
    );
    expect(row?.mature).toBe(true);
    // A withdrawn observation is no longer evidence.
    await t.run(async (ctx) => {
      const obs = await ctx.db.query("sourceObservations").first();
      await ctx.db.patch(obs!._id, { withdrawn: true });
    });
    await rebuild();
    expect((await heat())?.mature).toBeUndefined();
  });

  it("follows a rating on the Series' own link observation (Kodansha)", async () => {
    const { t, ids, rebuild, heat } = await seeded();
    await t.run((ctx) =>
      linkSeriesObservation(ctx, {
        sourceKey: "kodansha",
        seriesKey: "heat-garden",
        title: "Heat Garden",
        seriesId: ids.heat.seriesId,
        now: 0,
      }),
    );
    await t.mutation(internal.kodansha.recordListingRatings, {
      entries: [
        { slug: "heat-garden", mature: true },
        { slug: "never-linked", mature: true },
      ],
    });
    await rebuild();
    expect((await heat())?.mature).toBe(true);
    // Relinking (another feed's apply) keeps the stored rating.
    await t.run((ctx) =>
      linkSeriesObservation(ctx, {
        sourceKey: "kodansha",
        seriesKey: "heat-garden",
        title: "Heat Garden",
        seriesId: ids.heat.seriesId,
        now: 1,
      }),
    );
    await rebuild();
    expect((await heat())?.mature).toBe(true);
  });

  it("makes every Series of an adult-only publisher mature", async () => {
    const { t, ids, rebuild, heat } = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.adult, { contentRating: "mature" });
      await ctx.db.patch(ids.heat.editionId, { publisherId: ids.adult });
    });
    await rebuild();
    expect((await heat())?.mature).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(ids.quiet.seriesId)))?.mature).toBeUndefined();
  });

  it("lets the Data Team's content rating win over the evidence, at once", async () => {
    const { t, ids, rebuild, heat } = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.adult, { contentRating: "mature" });
      await ctx.db.patch(ids.heat.editionId, { publisherId: ids.adult });
    });
    await rebuild();
    expect((await heat())?.mature).toBe(true);

    await seedTeam(t, [alice]);
    const admin = signedIn(t, alice);
    const edit = (value: string) =>
      admin.mutation(api.moderation.submitDirectEdit, {
        ref: { type: "series", id: ids.heat.seriesId },
        baseRevisionId: undefined,
        changes: [{ field: "contentRating", value }],
        comment: "Rating check",
      });
    await edit("general");
    expect((await heat())?.mature).toBeUndefined();
    // The library's packed projections follow the edit at once: the filtered
    // path and the facets see it before any rebuild.
    const filtered = await t.query(api.seriesBrowse.browse, { sort: "title", q: "heat" });
    expect(filtered.items.map((item) => item.title)).toEqual(["Heat Garden"]);
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(2);
    await rebuild();
    expect((await heat())?.mature).toBeUndefined();

    // Clearing it hands the call back to the evidence at the next rebuild.
    const revision = await t.run((ctx) => ctx.db.query("revisions").first());
    await admin.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: ids.heat.seriesId },
      baseRevisionId: revision!._id,
      // The edit form clears a select with "".
      changes: [{ field: "contentRating", value: "" }],
      comment: "Back to the publisher's rating",
    });
    await rebuild();
    expect((await heat())?.mature).toBe(true);
  });
});

describe("public discovery without and with showMature", () => {
  async function matureHeat() {
    const seed = await seeded();
    await seed.t.run((ctx) => ctx.db.patch(seed.ids.heat.seriesId, { contentRating: "mature" }));
    await seed.rebuild();
    return seed;
  }
  const titles = (items: Array<{ title: string }>) => items.map((item) => item.title).sort();

  it("leaves Mature Series out of the library, its facets, and search", async () => {
    const { t } = await matureHeat();
    const browse = (showMature?: boolean) =>
      t.query(api.seriesBrowse.browse, { sort: "title", showMature });
    expect(titles((await browse()).items)).toEqual(["Quiet Garden"]);
    expect(titles((await browse(true)).items)).toEqual(["Heat Garden", "Quiet Garden"]);
    // The filtered path reads the packs, which carry the flag too.
    const filtered = await t.query(api.seriesBrowse.browse, { sort: "title", q: "garden" });
    expect(filtered).toMatchObject({ total: 1 });
    expect((await t.query(api.seriesBrowse.facets, {})).total).toBe(1);
    expect((await t.query(api.seriesBrowse.facets, { showMature: true })).total).toBe(2);

    const search = (showMature?: boolean) =>
      t.query(api.catalog.search, { query: "garden", showMature });
    expect(titles((await search()).series)).toEqual(["Quiet Garden"]);
    expect(titles((await search(true)).series)).toEqual(["Heat Garden", "Quiet Garden"]);
  });

  it("leaves Mature Series out of the newest Series shelf", async () => {
    const { t } = await matureHeat();
    const newest = async (showMature?: boolean) =>
      titles(await t.query(api.catalog.recentSeries, { limit: 10, showMature }));
    expect(await newest(false)).toEqual(["Quiet Garden"]);
    expect(await newest(true)).toEqual(["Heat Garden", "Quiet Garden"]);
  });

  it("leaves a Mature Series' books out of the calendar and the Publishers board", async () => {
    const { t } = await matureHeat();
    const month = { year: 2026, month: 9 };
    const calendar = async (showMature?: boolean) =>
      (await t.query(api.releases.monthBrowse, { ...month, showMature })).releases.map(
        (row) => row.series[0]!.title,
      );
    expect(await calendar()).toEqual(["Quiet Garden"]);
    expect((await calendar(true)).sort()).toEqual(["Heat Garden", "Quiet Garden"]);

    const board = async (showMature?: boolean) =>
      (await t.query(api.publisher.monthBoard, { ...month, showMature })).board[0]!.releases;
    expect(await board()).toBe(1);
    expect(await board(true)).toBe(2);
  });

  it("still serves a Mature Series' own page, flagged", async () => {
    const { t } = await matureHeat();
    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.series.mature).toBe(true);
    const edition = await t.query(api.catalogPages.editionPage, { publicId: 2 });
    expect(edition?.mature).toBe(true);
  });
});
