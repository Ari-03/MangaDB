// Seven Seas adapter tests (ticket #34): the whole import path run against
// a stubbed site serving fixture responses in the live wire shapes — no
// network. Covers the acceptance criteria end to end: canonical records
// with cited public Revisions, observation identity + latest snapshot +
// append-only history, last-seen-only bumps, Bootstrap Mode tagging, the
// steady-state review queue, covers in file storage, and withdrawal.

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { MIN_COVER_BYTES } from "./lib/covers";
import { normalizeBook, parseBookListing, parseBookPage } from "./lib/sevenSeas";
import schema from "./schema";

const BASE = "https://sevenseasentertainment.com";

type FixtureBook = {
  id: number;
  slug: string;
  title: string;
  modified?: string;
  seriesSlug?: string;
  seriesTitle?: string;
  date?: string;
  price?: string;
  category?: string;
  isbn?: string;
  cover?: boolean;
  /** The cover's file under uploads/covers (default `{slug}.jpg`); an .svg is a placeholder. */
  coverFile?: string;
  /** The listing's `content.rendered` blurb HTML. */
  blurb?: string;
};

function bookPageHtml(b: FixtureBook): string {
  const file = b.coverFile ?? `${b.slug}.jpg`;
  const cover =
    b.cover === false
      ? ""
      : `<img src="${BASE}/wp-content/uploads/covers/${file}" title="${b.title}" alt="${b.title}">`;
  const series = b.seriesSlug
    ? `<b>Series: </b><span> <a href="${BASE}/series/${b.seriesSlug}/">${b.seriesTitle ?? b.title}</a></span>`
    : "";
  return `<html><body><div id="volume-module">${cover}</div><div id="volume-meta"> ${series}<p><b>Story & Art by:</b> <span class="creator"><a href="${BASE}/creator/someone/">Someone</a></span></p>${
    b.date ? `<p><b>Release Date:</b> ${b.date}</p>` : ""
  }${b.price ? `<p><b>Price:</b> ${b.price}</p>` : ""}<p><b>Format:</b> ${
    b.category ?? "Manga"
  }</p>${b.isbn ? `<p><b>ISBN:</b> ${b.isbn}</p>` : ""}</div></body></html>`;
}

/** Cover-image URLs the stubbed site served, cleared after each test. */
const imageRequests: string[] = [];

/** One book's item in the listing (`wp-json/wp/v2/books`) wire shape. */
function listingItem(b: FixtureBook) {
  return {
    id: b.id,
    status: "publish",
    slug: b.slug,
    link: `${BASE}/books/${b.slug}/`,
    title: { rendered: b.title },
    modified_gmt: b.modified ?? "2026-08-01T00:00:00",
    content: { rendered: b.blurb ?? "" },
  };
}

/** Stub global fetch with a fixture site serving the live wire shapes. */
function stubSite(books: FixtureBook[]) {
  const listing = books.map(listingItem);
  const pages = new Map(books.map((b) => [`${BASE}/books/${b.slug}/`, bookPageHtml(b)]));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.startsWith(`${BASE}/wp-json/wp/v2/books`)) {
      return new Response(JSON.stringify(listing), {
        headers: {
          "x-wp-totalpages": books.length === 0 ? "0" : "1",
          "content-type": "application/json",
        },
      });
    }
    const page = pages.get(url);
    if (page !== undefined) {
      return new Response(page, { headers: { "content-type": "text/html" } });
    }
    if (url.includes("/wp-content/uploads/")) {
      imageRequests.push(url);
      return url.endsWith(".svg")
        ? new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
            headers: { "content-type": "image/svg+xml" },
          })
        : new Response(new Blob([new Uint8Array(MIN_COVER_BYTES + 1).fill(0xff)]), {
            headers: { "content-type": "image/jpeg" },
          });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  imageRequests.length = 0;
});

async function seedRegistry(t: ReturnType<typeof convexTest>, bootstrap: boolean) {
  await t.mutation(internal.importSources.seedRegistry, {});
  await t.mutation(internal.importSources.setBootstrapModeInternal, {
    on: bootstrap,
  });
}

const sync = (t: ReturnType<typeof convexTest>, args: object = {}) =>
  t.action(internal.sevenSeas.sync, { politeDelayMs: 0, ...args });

const ALPHA_1: FixtureBook = {
  id: 101,
  slug: "alpha-manga-vol-1",
  title: "Alpha Adventures (Manga) Vol. 1",
  modified: "2026-08-01T00:00:00",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "January 6, 2026",
  price: "$14.99",
  isbn: "978-1-9990001-0-3",
  blurb: "<p>Alpha&#8217;s <em>first</em>\n adventure.</p>\n",
};

const ALPHA_2: FixtureBook = {
  id: 102,
  slug: "alpha-manga-vol-2",
  title: "Alpha Adventures (Manga) Vol. 2",
  modified: "2026-08-02T00:00:00",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "May 12, 2026",
  price: "$14.99",
  isbn: "978-1-9990001-1-0",
};

const LIGHT_NOVEL: FixtureBook = {
  id: 103,
  slug: "alpha-light-novel-vol-1",
  title: "Alpha Adventures (Light Novel) Vol. 1",
  category: "Light Novel",
};

describe("sevenSeas.sync — Bootstrap Mode creation path", () => {
  it("creates canonical records with cited Revisions, tags, covers, and a run log", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2, LIGHT_NOVEL]);

    const result = await sync(t);
    expect(result).toMatchObject({
      recordsSeen: 2, // the light novel is out of catalog scope
      recordsChanged: 2,
      completeSweep: true,
      errorCount: 0,
    });

    await t.run(async (ctx) => {
      // Publisher, series, volumes, editions, coverage, releases.
      const publisher = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "seven-seas"))
        .unique();
      expect(publisher?.name).toBe("Seven Seas Entertainment");

      const series = await ctx.db.query("series").collect();
      expect(series).toHaveLength(1);
      // The publisher's "(Manga)" discriminator never reaches the Series title.
      expect(series[0]).toMatchObject({
        title: "Alpha Adventures",
        bootstrapUnreviewed: true,
        publicId: 1,
      });

      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => [v.label, v.position]).sort()).toEqual([
        ["1", 1],
        ["2", 2],
      ]);

      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      const vol1Release = releases.find((r) => r.isbn13 === "9781999000103")!;
      expect(vol1Release).toMatchObject({
        format: "physical",
        binding: "paperback",
        language: "en",
        pubDate: { year: 2026, month: 1, day: 6, sort: 20260106 },
        price: { amountCents: 1499, currency: "USD" },
        publisherId: publisher!._id,
        seriesIds: [series[0]!._id],
        // Vol. 1 created the Series → steady state would have queued it.
        bootstrapUnreviewed: true,
      });
      // The listing blurb becomes the Release Description, cleaned to text;
      // a book without one gets none (never "").
      expect(vol1Release.description).toBe("Alpha’s first adventure.");

      // Vol. 2 landed under an already-linked Series — steady state would
      // have auto-created it, so it carries no bootstrap tag.
      const vol2Release = releases.find((r) => r.isbn13 === "9781999000110")!;
      expect(vol2Release.bootstrapUnreviewed).toBeUndefined();
      expect(vol2Release.description).toBeUndefined();

      // Covers in file storage with source URL + attribution.
      expect(vol1Release.coverImage).toMatchObject({
        sourceUrl: `${BASE}/wp-content/uploads/covers/alpha-manga-vol-1.jpg`,
      });
      expect(vol1Release.coverImage?.storageId).toBeDefined();
      expect(vol1Release.coverImage?.attribution).toContain("Seven Seas");

      // Public importer-authored Revisions citing source name + record URL.
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) =>
          q.eq("ref.type", "release").eq("ref.id", vol1Release._id as never),
        )
        .collect();
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        seq: 1,
        author: { kind: "source", sourceKey: "sevenseas" },
        citation: {
          sourceName: "Seven Seas Entertainment",
          url: `${BASE}/books/alpha-manga-vol-1/`,
        },
      });
      expect(revisions[0]!.approvedBy).toBeUndefined();
      expect(revisions[0]!.changes.map((c) => c.field)).toEqual(
        expect.arrayContaining(["pubDate", "description"]),
      );

      // The immediately approved system Proposal behind Vol. 1's creation.
      const proposal = await ctx.db.get(revisions[0]!.proposalId);
      expect(proposal).toMatchObject({
        state: "approved",
        author: { kind: "source", sourceKey: "sevenseas" },
      });

      // Observation identity + link; the series rung-① link observation.
      const bookObs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", "101"),
        )
        .unique();
      expect(bookObs?.recordRef).toEqual({
        type: "release",
        id: vol1Release._id,
      });
      expect(bookObs?.withdrawn).toBe(false);
      const seriesObs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", "series:alpha-manga"),
        )
        .unique();
      expect(seriesObs?.recordRef).toEqual({
        type: "series",
        id: series[0]!._id,
      });

      // The Import Run log.
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        sourceKey: "sevenseas",
        status: "succeeded",
        recordsSeen: 2,
        recordsChanged: 2,
      });
    });
  });

  it("expands an omnibus range into multi-volume coverage and tags it", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([
      {
        id: 201,
        slug: "big-omnibus-vol-1-3",
        title: "Big Series (Omnibus) Vols. 1-3",
        seriesSlug: "big-omnibus",
        seriesTitle: "Big Series (Omnibus)",
        date: "March 3, 2026",
        isbn: "978-1-9990003-1-8",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => [v.label, v.position]).sort()).toEqual([
        ["1", 1],
        ["2", 2],
        ["3", 3],
      ]);
      const coverage = await ctx.db.query("volumeCoverages").collect();
      expect(coverage).toHaveLength(3);
      expect(coverage.every((c) => c.extent === "complete")).toBe(true);
      const releases = await ctx.db.query("releases").collect();
      expect(releases[0]!.bootstrapUnreviewed).toBe(true);
    });
  });
});

// B19: a title that never states its coverage ("Deluxe Edition 1") is
// placed by the shared inference: the listing blurb, else the line's
// declared size, else Unmapped Packaging under its line (Bootstrap Mode).
describe("sevenSeas.sync — packaging coverage inference", () => {
  const DELUXE: FixtureBook = {
    id: 301,
    slug: "alpha-deluxe-edition-1",
    title: "Alpha Deluxe Edition 1",
    seriesSlug: "alpha-deluxe",
    seriesTitle: "Alpha Deluxe Edition",
    date: "March 3, 2026",
    isbn: "978-1-9990004-1-7",
  };

  it("reads the covered Volumes from the listing blurb", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...DELUXE, blurb: "<p>Collects volumes 1-3 in hardcover.</p>" }]);
    await sync(t);
    await t.run(async (ctx) => {
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["1", "2", "3"]);
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(3);
      const [edition] = await ctx.db.query("editions").collect();
      expect(edition).toMatchObject({ linePosition: "1" });
      expect(edition!.coverageUnmapped).toBeUndefined();
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
  });

  it("creates Unmapped Packaging under its line when no signal states coverage", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([DELUXE]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
      const [edition, ...more] = await ctx.db.query("editions").collect();
      expect(more).toHaveLength(0);
      expect(edition).toMatchObject({ coverageUnmapped: true, linePosition: "1" });
      const line = await ctx.db.get(edition!.editionLineId!);
      expect(line).toMatchObject({ name: "Deluxe Edition" });
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
  });

  it("keeps uncovered packaging on its observation outside Bootstrap Mode", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, false);
    stubSite([DELUXE]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("editions").collect()).toHaveLength(0);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
    });
  });
});

describe("sevenSeas.sync — observations over repeated runs", () => {
  it("bumps last-seen only on an unchanged fetch", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("sourceObservations").collect()).find((o) => o.sourceRecordId === "101"),
    );
    await new Promise((r) => setTimeout(r, 5));

    const second = await sync(t);
    expect(second).toMatchObject({ recordsSeen: 1, recordsChanged: 0 });
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.lastSeenAt).toBeGreaterThan(before!.lastSeenAt);
      // No history rows, no extra revisions: nothing changed.
      expect(await ctx.db.query("observationSnapshots").collect()).toHaveLength(0);
      const revisions = await ctx.db.query("revisions").collect();
      expect(revisions.filter((r) => r.ref.type === "release")).toHaveLength(1);
    });
  });

  it("the next sync fills a blurb the Release predates, even with the listing unchanged", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    // A Release imported before descriptions existed: no text, same listing.
    const clear = () =>
      t.run(async (ctx) => {
        const release = (await ctx.db.query("releases").collect())[0]!;
        await ctx.db.patch(release._id, { description: undefined });
      });
    await clear();
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, recordsChanged: 1 });
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      expect(release.description).toBe("Alpha’s first adventure.");
    });
    // With the text in place the unchanged short-circuit is back.
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    // A description a human cleared stays cleared: no re-read for it.
    await clear();
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.patch(release._id, { overriddenFields: ["description"] });
    });
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("releases").collect())[0]!.description).toBeUndefined();
    });
  });

  it("keeps append-only history and auto-updates authoritative fields on change", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);

    // The source moves the date: modified_gmt bumps, the page changes.
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" }]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsChanged: 1 });

    await t.run(async (ctx) => {
      const history = await ctx.db.query("observationSnapshots").collect();
      expect(history).toHaveLength(1);
      expect((history[0]!.snapshot as { releaseDate: { month: number } }).releaseDate.month).toBe(
        1,
      ); // the superseded snapshot, retained append-only

      const release = (await ctx.db.query("releases").collect())[0]!;
      expect(release.pubDate).toMatchObject({
        month: 2,
        day: 3,
        sort: 20260203,
      });

      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) =>
          q.eq("ref.type", "release").eq("ref.id", release._id as never),
        )
        .collect();
      expect(revisions).toHaveLength(2);
      const update = revisions.find((r) => r.seq === 2)!;
      expect(update.citation?.url).toBe(`${BASE}/books/alpha-manga-vol-1/`);
      expect(update.changes).toEqual([
        {
          field: "pubDate",
          before: { year: 2026, month: 1, day: 6, sort: 20260106 },
          after: { year: 2026, month: 2, day: 3, sort: 20260203 },
        },
      ]);
    });
  });

  it("never overwrites a sticky Human Override", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.patch(release._id, { overriddenFields: ["pubDate"] });
    });

    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" }]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      // The canonical value stands; the conflicting value is still recorded
      // on the observation's latest snapshot.
      expect(release.pubDate?.sort).toBe(20260106);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect((obs.snapshot as { releaseDate: { month: number } }).releaseDate.month).toBe(2);
      const revisions = await ctx.db.query("revisions").collect();
      expect(revisions.filter((r) => r.ref.type === "release")).toHaveLength(1);
    });
  });

  it("marks observations withdrawn only after a complete sweep stops seeing them", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    await new Promise((r) => setTimeout(r, 5));

    stubSite([ALPHA_1]); // Vol. 2 disappears from the source
    await sync(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      const byId = new Map(observations.map((o) => [o.sourceRecordId, o]));
      expect(byId.get("101")?.withdrawn).toBe(false);
      expect(byId.get("102")?.withdrawn).toBe(true);
      // Synthetic series links are never withdrawn by the sweep.
      expect(byId.get("series:alpha-manga")?.withdrawn).toBe(false);
      // Withdrawal retains everything — the canonical release stays.
      expect(await ctx.db.query("releases").collect()).toHaveLength(2);
    });
  });
});

describe("sevenSeas.sync — covers", () => {
  const cover = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!.coverImage ?? null);

  it("keeps a current cover and replaces one whose URL changed, deleting its blob", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    const first = (await cover(t))!;

    // Re-read with the same art: nothing is downloaded or replaced.
    imageRequests.length = 0;
    await sync(t, { force: true });
    expect(imageRequests).toEqual([]);
    expect(await cover(t)).toEqual(first);

    // New art under a new URL replaces the stored cover.
    const moved = `${BASE}/wp-content/uploads/covers/alpha-manga-vol-1-new.jpg`;
    stubSite([
      { ...ALPHA_1, modified: "2026-08-10T00:00:00", coverFile: "alpha-manga-vol-1-new.jpg" },
    ]);
    expect(await sync(t)).toMatchObject({ errorCount: 0 });
    expect(imageRequests).toEqual([moved]);
    const second = (await cover(t))!;
    expect(second.sourceUrl).toBe(moved);
    expect(second.storageId).not.toBe(first.storageId);
    await t.run(async (ctx) => {
      expect(await ctx.storage.getUrl(first.storageId)).toBeNull();
    });
  });

  it("records an SVG placeholder on the Release instead of storing or refetching it", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...ALPHA_1, coverFile: "no-cover.svg" }]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsChanged: 1, errorCount: 1 });
    expect((result as { failed?: boolean }).failed).toBeUndefined();
    expect(await cover(t)).toEqual({
      sourceUrl: expect.stringContaining("no-cover.svg"),
      attribution: expect.any(String),
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.system.query("_storage").collect()).toHaveLength(0);
      const run = (await ctx.db.query("importRuns").collect())[0]!;
      expect(run.errors[0]).toContain("placeholder, not stored (image/svg+xml");
    });
    // A forced re-read fetches nothing for it until the URL changes.
    imageRequests.length = 0;
    expect(await sync(t, { force: true })).toMatchObject({ errorCount: 0 });
    expect(imageRequests).toEqual([]);
  });
});

// B22: a cover that failed after its book applied is retried by the next
// ordinary run, straight from the stored snapshot's URL: the unchanged book
// page is not fetched again.
describe("sevenSeas.sync — failed cover retries", () => {
  /** Serve the stubbed site, but fail cover art with a 404 and log every URL asked for. */
  function withBrokenArt(requests: string[], broken: boolean) {
    const site = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "object" && "url" in input ? input.url : String(input);
      requests.push(url);
      if (broken && url.includes("/wp-content/uploads/")) {
        return new Response("not found", { status: 404 });
      }
      return site(input);
    });
  }

  it("retries the art next run without refetching the unchanged book page", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    const requests: string[] = [];
    stubSite([ALPHA_1]);
    withBrokenArt(requests, true);
    const first = await sync(t);
    expect(first).toMatchObject({ recordsChanged: 1, errorCount: 1 });
    const art = await t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!);
    expect(art.coverImage).toBeUndefined();

    // The art is back; the listing has not changed.
    requests.length = 0;
    stubSite([ALPHA_1]);
    withBrokenArt(requests, false);
    expect(await sync(t)).toMatchObject({ recordsChanged: 0, errorCount: 0 });
    expect(requests.some((url) => url === `${BASE}/books/${ALPHA_1.slug}/`)).toBe(false);
    expect(imageRequests).toEqual([`${BASE}/wp-content/uploads/covers/${ALPHA_1.slug}.jpg`]);
    const stored = await t.run(async (ctx) => (await ctx.db.get(art._id))!.coverImage);
    expect(stored).toMatchObject({
      sourceUrl: `${BASE}/wp-content/uploads/covers/${ALPHA_1.slug}.jpg`,
      storageId: expect.any(String),
    });

    // Stored art is not asked for again.
    imageRequests.length = 0;
    expect(await sync(t)).toMatchObject({ errorCount: 0 });
    expect(imageRequests).toEqual([]);
  });

  it("paces retries with maxCoverRetries", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    const requests: string[] = [];
    stubSite([ALPHA_1, ALPHA_2]);
    withBrokenArt(requests, true);
    await sync(t);

    stubSite([ALPHA_1, ALPHA_2]);
    withBrokenArt(requests, false);
    await sync(t, { maxCoverRetries: 1 });
    expect(imageRequests).toHaveLength(1);
    imageRequests.length = 0;
    await sync(t, { maxCoverRetries: 1 });
    expect(imageRequests).toHaveLength(1);
    const covered = await t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).filter((r) => r.coverImage?.storageId),
    );
    expect(covered).toHaveLength(2);
  });
});

describe("sevenSeas.sync — steady-state gates (Bootstrap Mode off)", () => {
  it("queues a pre-filled In-Review proposal for a brand-new series, once", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, false);
    stubSite([ALPHA_1]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsChanged: 1 });

    const check = async () =>
      await t.run(async (ctx) => {
        expect(await ctx.db.query("series").collect()).toHaveLength(0);
        expect(await ctx.db.query("releases").collect()).toHaveLength(0);
        const proposals = await ctx.db.query("proposals").collect();
        expect(proposals).toHaveLength(1);
        expect(proposals[0]).toMatchObject({
          state: "inReview",
          author: { kind: "source", sourceKey: "sevenseas" },
        });
        const version = (await ctx.db.query("proposalVersions").collect())[0]!;
        expect(version.ops.map((op) => op.kind)).toEqual(["create", "create", "create", "create"]);
        expect(version.evidence[0]?.kind).toBe("observation");
        const obs = (await ctx.db.query("sourceObservations").collect()).find(
          (o) => o.sourceRecordId === "101",
        )!;
        expect(obs.recordRef).toBeUndefined();
      });
    await check();

    // A re-run (forced re-parse) must not duplicate the queued proposal.
    await sync(t, { force: true });
    await check();
  });

  it("auto-creates a single-volume release under an already-linked series", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t); // bootstrap run links the series

    await t.mutation(internal.importSources.setBootstrapModeInternal, {
      on: false,
    });
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      const vol2 = releases.find((r) => r.isbn13 === "9781999000110")!;
      expect(vol2.bootstrapUnreviewed).toBeUndefined();
      expect(
        (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview"),
      ).toHaveLength(0);
    });
  });
});

/** A Seven Seas Series with Volume 1 and one whole-Volume Release of it (by default ALPHA_1's ISBN). */
const insertCatalogRelease = async (
  t: ReturnType<typeof convexTest>,
  seriesTitle: string,
  release: { isbn13?: string; binding?: string } = { isbn13: "9781999000103" },
) =>
  await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: seriesTitle,
      altTitles: [],
      searchText: seriesTitle,
    });
    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      publicId: 1,
      seriesId,
      position: 1,
      label: "1",
    });
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: 1,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId,
      volumeId,
      order: 1,
      extent: "complete",
    });
    return await ctx.db.insert("releases", {
      status: "active",
      editionId,
      format: "physical",
      language: "en",
      ...release,
      publisherId,
      seriesIds: [seriesId],
    });
  });

describe("sevenSeas.sync — ISBN matching rung", () => {
  it("links to an existing release by ISBN when titles agree", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    const releaseId = await insertCatalogRelease(t, "Alpha Adventures");
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.recordRef).toEqual({ type: "release", id: releaseId });
    });
  });

  it("flags an ISBN match with a dissimilar title for review instead of linking", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await insertCatalogRelease(t, "Completely Different Zeta");
    stubSite([ALPHA_1]);
    const result = (await sync(t)) as { errorCount: number };
    expect(result.errorCount).toBe(1);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.recordRef).toBeUndefined();
      const run = (await ctx.db.query("importRuns").collect())[0]!;
      expect(run.errors[0]).toContain("review");
    });
  });
});

describe("sevenSeas.sync — Binding reaches the matching ladder (B14)", () => {
  it("a hardcover never links an ISBN-less paperback of its Volume; it becomes its sibling", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    const paperbackId = await insertCatalogRelease(t, "Alpha Adventures", {
      binding: "paperback",
    });
    stubSite([{ ...ALPHA_1, category: "Manga Hardcover" }]);
    await sync(t);

    await t.run(async (ctx) => {
      const paperback = (await ctx.db.get(paperbackId))!;
      expect(paperback.isbn13).toBeUndefined();
      expect(paperback.binding).toBe("paperback");
      const hardcover = (await ctx.db.query("releases").collect()).find(
        (r) => r.isbn13 === "9781999000103",
      );
      expect(hardcover).toMatchObject({ binding: "hardcover", editionId: paperback.editionId });
    });
  });
});

describe("sevenSeas.sync — a linked book never takes another Release's ISBN (B08)", () => {
  it("a changed ISBN another Release holds is a conflict, and none of the book's facts apply", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    const heldIsbn = "9781999000110";
    const { linkedId, holderId } = await t.run(async (ctx) => {
      const linked = (await ctx.db.query("releases").collect())[0]!;
      const { _id, _creationTime, ...fields } = linked;
      const holderId = await ctx.db.insert("releases", {
        ...fields,
        binding: "hardcover",
        isbn13: heldIsbn,
      });
      return { linkedId: _id, holderId };
    });

    stubSite([
      { ...ALPHA_1, modified: "2026-08-05T00:00:00", isbn: heldIsbn, price: "$24.99" },
    ]);
    await sync(t);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(linkedId)).toMatchObject({
        isbn13: "9781999000103",
        price: { amountCents: 1499 },
      });
      const holders = (await ctx.db.query("releases").collect()).filter(
        (r) => r.isbn13 === heldIsbn,
      );
      expect(holders.map((r) => r._id)).toEqual([holderId]);
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", "101"),
        )
        .unique();
      expect(observation!.conflicts).toEqual([
        expect.objectContaining({ field: "isbn13", offered: heldIsbn }),
      ]);
    });
  });
});

describe("sevenSeas.sync — failure handling", () => {
  it("does not withdraw a listed book when its title becomes out of scope", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      for (const observation of await ctx.db.query("sourceObservations").collect()) {
        await ctx.db.patch(observation._id, { lastSeenAt: 1 });
      }
    });
    stubSite([{ ...ALPHA_1, title: "Alpha Adventures (Light Novel) Vol. 1" }]);
    await sync(t);
    await t.run(async (ctx) => {
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", "101"),
        )
        .unique();
      expect(observation?.withdrawn).toBe(false);
    });
  });

  it.each(["missing pagination", "malformed book", "unexpected empty page"])(
    "does not withdraw existing observations after %s",
    async (failure) => {
      const t = convexTest(schema);
      await seedRegistry(t, true);
      stubSite([ALPHA_1]);
      await sync(t);
      await t.run(async (ctx) => {
        for (const observation of await ctx.db.query("sourceObservations").collect()) {
          await ctx.db.patch(observation._id, { lastSeenAt: 1 });
        }
      });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify(failure === "malformed book" ? [{ id: 101 }] : []), {
            headers: failure === "missing pagination" ? {} : { "x-wp-totalpages": "1" },
          }),
      );
      expect(await sync(t)).toMatchObject({
        failed: true,
        completeSweep: false,
      });
      await t.run(async (ctx) => {
        const observation = await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "sevenseas").eq("sourceRecordId", "101"),
          )
          .unique();
        expect(observation?.withdrawn).toBe(false);
      });
    },
  );

  it("skips an invalid listing item, imports the rest, and fails without withdrawing", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    await t.run(async (ctx) => {
      for (const observation of await ctx.db.query("sourceObservations").collect()) {
        await ctx.db.patch(observation._id, { lastSeenAt: 1 });
      }
    });

    // Vol. 2's rendered title comes back empty; Vol. 1 is still listed after it.
    stubSite([ALPHA_1]);
    const siteFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const res = await siteFetch(input);
      if (!String(input).includes("/wp-json/")) return res;
      const items = (await res.json()) as unknown[];
      const blank = { id: 102, status: "publish", slug: "x", link: "x", title: { rendered: "" } };
      return new Response(JSON.stringify([blank, ...items]), { headers: res.headers });
    });
    expect(await sync(t)).toMatchObject({
      failed: true,
      completeSweep: false,
      recordsSeen: 1,
      errorCount: 1,
    });
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("importRuns").collect())[1]!;
      expect(run.status).toBe("failed");
      expect(run.errors).toEqual(["listing page 1: invalid book item"]);
      const observations = await ctx.db.query("sourceObservations").collect();
      const byId = new Map(observations.map((o) => [o.sourceRecordId, o]));
      // Vol. 1 was processed after the bad item; Vol. 2 was not withdrawn.
      expect(byId.get("101")?.lastSeenAt).toBeGreaterThan(1);
      expect(byId.get("102")?.withdrawn).toBe(false);
    });
  });

  it("fails an empty listing and withdraws nothing", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      for (const observation of await ctx.db.query("sourceObservations").collect()) {
        await ctx.db.patch(observation._id, { lastSeenAt: 1 });
      }
    });
    stubSite([]); // X-WP-TotalPages: 0 and an empty first page
    expect(await sync(t)).toMatchObject({ failed: true, completeSweep: false });
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("importRuns").collect())[1]!;
      expect(run.errors[0]).toContain("listing was empty");
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.every((o) => o.withdrawn === false)).toBe(true);
    });
  });

  it("notes a removed book page (HTTP 404) without failing the run", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    const siteFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/books/alpha-manga-vol-2/")) {
        return new Response("gone", { status: 404 });
      }
      return siteFetch(input);
    });
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 2, recordsChanged: 1, errorCount: 1 });
    expect((result as { failed?: boolean }).failed).toBeUndefined();
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("importRuns").collect())[0]!;
      expect(run.status).toBe("succeeded");
      expect(run.errors[0]).toContain("HTTP 404");
      // The missing book stays unobserved (retried while listed); Vol. 1 imported.
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId).sort()).toEqual([
        "101",
        "series:alpha-manga",
      ]);
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique();
      expect(source?.consecutiveFailures).toBe(0);
    });
  });

  it("records a failed detail run without creating a book from an HTTP 200 error page", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    const siteFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/books/")) {
        return new Response("<html>Just a moment...</html>");
      }
      return siteFetch(input);
    });
    expect(await sync(t)).toMatchObject({
      failed: true,
      recordsChanged: 0,
      errorCount: 1,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("sourceObservations").collect()).toHaveLength(0);
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique();
      expect(source?.consecutiveFailures).toBe(1);
    });
  });

  it("logs a failed run and counts toward source health", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    const result = (await sync(t)) as { failed?: boolean };
    expect(result.failed).toBe(true);
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("importRuns").collect())[0]!;
      expect(run.status).toBe("failed");
      expect(run.errors[0]).toContain("HTTP 404");
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique();
      expect(source?.consecutiveFailures).toBe(1);
    });
  });

  it("skips cleanly when the registry row is disabled", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await t.run(async (ctx) => {
      const source = (await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique())!;
      await ctx.db.patch(source._id, { enabled: false });
    });
    const result = await sync(t);
    expect(result).toEqual({ skipped: "disabled" });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("importRuns").collect()).toHaveLength(0);
    });
  });
});

/** An Administrator (username "catalogmod") who can approve queued proposals. */
async function withAdmin(t: ReturnType<typeof convexTest>) {
  rateLimiterTest.register(t, "rateLimiter");
  const admin = t.withIdentity({ subject: "admin_subject" });
  await admin.mutation(api.users.claimUsername, { username: "catalogmod" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "catalogmod" });
  return admin;
}

/** Approve the one In-Review proposal the importer queued. */
async function approveQueued(t: ReturnType<typeof convexTest>, admin: Awaited<ReturnType<typeof withAdmin>>) {
  const queued = await t.run(async (ctx) =>
    (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview"),
  );
  expect(queued).toHaveLength(1);
  expect(
    await admin.mutation(api.proposals.approveProposal, { proposalId: queued[0]!._id }),
  ).toMatchObject({ status: "approved" });
}

const OMNIBUS_1: FixtureBook = {
  id: 401,
  slug: "alpha-manga-omnibus-1",
  title: "Alpha Adventures (Manga) Omnibus 1 (Vol. 1-2)",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "March 3, 2026",
  isbn: "978-1-9990005-1-6",
};

const OMNIBUS_2: FixtureBook = {
  ...OMNIBUS_1,
  id: 402,
  slug: "alpha-manga-omnibus-2",
  title: "Alpha Adventures (Manga) Omnibus 2 (Vol. 3-4)",
  isbn: "978-1-9990005-2-3",
};

// R08: a steady-state packaging guess carries its Edition Line, so the
// reviewed proposal files the Edition under that line when approved.
describe("sevenSeas.sync — queued packaging keeps its Edition Line (B16)", () => {
  it("approving a steady-state omnibus creates its Edition Line and files the Edition under it", async () => {
    const t = convexTest(schema);
    const admin = await withAdmin(t);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t); // links the Series
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubSite([OMNIBUS_1, ALPHA_1]);
    await sync(t);
    await approveQueued(t, admin);
    await t.run(async (ctx) => {
      const [series] = await ctx.db.query("series").collect();
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ seriesId: series!._id, name: "Omnibus" }]);
      const omnibus = (await ctx.db.query("editions").collect()).find(
        (edition) => edition.editionLineId !== undefined,
      );
      expect(omnibus).toMatchObject({ editionLineId: lines[0]!._id, linePosition: "1" });
    });
  });

  it("a later steady-state member joins the line an earlier import created", async () => {
    const t = convexTest(schema);
    const admin = await withAdmin(t);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, OMNIBUS_1]);
    await sync(t); // Bootstrap Mode creates Omnibus 1 and its line
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubSite([OMNIBUS_2, ALPHA_1, OMNIBUS_1]);
    await sync(t);
    const [version] = await t.run((ctx) => ctx.db.query("proposalVersions").collect());
    expect(version!.ops.some((op) => op.kind === "create" && op.table === "editionLines")).toBe(
      false,
    );
    await approveQueued(t, admin);
    await t.run(async (ctx) => {
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toHaveLength(1);
      const members = (await ctx.db.query("editions").collect()).filter(
        (edition) => edition.editionLineId === lines[0]!._id,
      );
      expect(members.map((edition) => edition.linePosition).sort()).toEqual(["1", "2"]);
    });
  });

  it("a flagged packaging guess (ambiguous Series) also carries its line", async () => {
    const t = convexTest(schema);
    const admin = await withAdmin(t);
    await seedRegistry(t, true);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      for (const publicId of [1, 2]) {
        await ctx.db.insert("series", {
          status: "active",
          publicId,
          title: "Alpha Adventures",
          altTitles: [],
          searchText: "Alpha Adventures",
        });
      }
    });
    stubSite([OMNIBUS_1]);
    expect(await sync(t)).toMatchObject({ errorCount: 1 });
    await approveQueued(t, admin);
    await t.run(async (ctx) => {
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ name: "Omnibus" }]);
      const [edition] = await ctx.db.query("editions").collect();
      expect(edition).toMatchObject({ editionLineId: lines[0]!._id, linePosition: "1" });
    });
  });

  it("two members of a new line queued together both approve into that one line", async () => {
    const t = convexTest(schema);
    const admin = await withAdmin(t);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t); // links the Series
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubSite([OMNIBUS_2, OMNIBUS_1, ALPHA_1]);
    await sync(t);
    const queued = await t.run(async (ctx) =>
      (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview"),
    );
    expect(queued).toHaveLength(2);
    for (const proposal of queued) {
      expect(
        await admin.mutation(api.proposals.approveProposal, { proposalId: proposal._id }),
      ).toMatchObject({ status: "approved" });
    }
    await t.run(async (ctx) => {
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toHaveLength(1);
      const members = (await ctx.db.query("editions").collect()).filter(
        (edition) => edition.editionLineId === lines[0]!._id,
      );
      expect(members.map((edition) => edition.linePosition).sort()).toEqual(["1", "2"]);
      // The line has one creation Revision, from the proposal that created it.
      const lineRevisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "editionLine").eq("ref.id", lines[0]!._id))
        .collect();
      expect(lineRevisions).toHaveLength(1);
    });
  });
});

const BOX_1: FixtureBook = {
  id: 501,
  slug: "alpha-manga-box-set-1",
  title: "Alpha Adventures (Manga) Box Set 1 (Vol. 1-2)",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "June 2, 2026",
  isbn: "978-1-9990005-3-0",
};

/** The box's members, by their Releases' ISBNs in bundle order. */
const boxMembers = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    const [bundle, ...more] = await ctx.db.query("releaseBundles").collect();
    expect(more).toHaveLength(0);
    const rows = (await ctx.db.query("bundleMemberships").collect())
      .filter((row) => row.bundleId === bundle!._id)
      .sort((a, b) => a.order - b.order);
    return await Promise.all(rows.map(async (row) => (await ctx.db.get(row.releaseId))!.isbn13));
  });

// R09: a box imported before some of its books picks those books up once
// they exist, whether its listing is unchanged (no detail fetch) or its
// page is re-read.
describe("sevenSeas.sync — a box set gains members that arrive after it (B15)", () => {
  it("an unchanged box listing reconciles its members without a detail fetch, in steady state", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, BOX_1]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);

    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubSite([ALPHA_2, ALPHA_1, BOX_1]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103", "9781999000110"]);
    await t.run(async (ctx) => {
      const [bundle] = await ctx.db.query("releaseBundles").collect();
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "releaseBundle").eq("ref.id", bundle!._id))
        .collect();
      // Its creation, then the late member.
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!.changes.map((c) => c.field)).toEqual(["members"]);
      expect(revisions[1]!.citation?.url).toBe(`${BASE}/books/${BOX_1.slug}/`);
    });

    // Nothing left to add: a further run writes no Revision.
    await sync(t);
    await t.run(async (ctx) => {
      expect(
        (await ctx.db.query("revisions").collect()).filter((r) => r.ref.type === "releaseBundle"),
      ).toHaveLength(2);
    });
  });

  it("a re-read box page (changed or forced) reconciles its members too", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, BOX_1]);
    await sync(t);
    // Volume 2 arrives after the box's listing was noted this run.
    stubSite([BOX_1, ALPHA_1, ALPHA_2]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);

    const box = { sourceRecordId: String(BOX_1.id) };
    const snapshot = await t.run(
      async (ctx) =>
        (await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "sevenseas").eq("sourceRecordId", box.sourceRecordId),
          )
          .unique())!.snapshot,
    );
    // The unchanged snapshot, as a forced re-read applies it.
    expect(await t.mutation(internal.sevenSeas.applyBook, { ...box, snapshot })).toMatchObject({
      status: "updated",
      changed: true,
    });
    expect(await boxMembers(t)).toEqual(["9781999000103", "9781999000110"]);
    expect(await t.mutation(internal.sevenSeas.applyBook, { ...box, snapshot })).toMatchObject({
      status: "unchanged",
      changed: false,
    });
  });
});

const BETA_1: FixtureBook = {
  id: 201,
  slug: "beta-manga-vol-1",
  title: "Beta Adventures (Manga) Vol. 1",
  seriesSlug: "beta-manga",
  seriesTitle: "Beta Adventures (Manga)",
  date: "January 6, 2026",
  isbn: "978-1-9990002-0-2",
};

/** The one box's members as `isbn@order`, in page order (by order, then creation). */
const boxRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => {
    const [bundle] = await ctx.db.query("releaseBundles").collect();
    const rows = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id))
      .collect();
    return await Promise.all(
      rows.map(async (row) => `${(await ctx.db.get(row.releaseId))!.isbn13}@${row.order}`),
    );
  });

/** The newest Import Run's errors. */
const lastRunErrors = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => (await ctx.db.query("importRuns").order("desc").first())!.errors);

// W08: a linked box fills only from its canonical identity. Its listing
// repointed at another series goes to review — on the re-read page and on
// the unchanged listing after it — and never adds that series' books.
describe("sevenSeas.sync — a linked box keeps its canonical identity (W08)", () => {
  it("a box listed under another series adds nothing and reports review", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, BETA_1, BOX_1]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);

    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    const moved = {
      ...BOX_1,
      title: "Beta Adventures (Manga) Box Set 1 (Vol. 1-2)",
      seriesSlug: "beta-manga",
      seriesTitle: "Beta Adventures (Manga)",
      modified: "2026-08-10T00:00:00",
    };
    stubSite([ALPHA_1, BETA_1, moved]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);
    expect((await lastRunErrors(t)).some((e) => e.startsWith(`review ${BOX_1.slug}:`))).toBe(true);
    expect((await observationOf(t, BOX_1)).conflicts?.map((c) => c.field)).toEqual(["placement"]);

    // The unchanged listing (no page fetch) reports it again.
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);
    expect((await lastRunErrors(t)).some((e) => e.startsWith(`review ${BOX_1.slug}:`))).toBe(true);
  });
});

// W09: a legacy box made when only Vol. 2 existed stored it at compact
// order 1; the unchanged listing that fills Vol. 1 renumbers by position.
describe("sevenSeas.sync — a legacy box's compact order is renumbered (W09)", () => {
  it("an unchanged box listing fills Vol. 1 ahead of a legacy Vol. 2", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_2, BOX_1]);
    await sync(t);
    await t.run(async (ctx) => {
      const [member] = await ctx.db.query("bundleMemberships").collect();
      await ctx.db.patch(member!._id, { order: 1 });
    });
    stubSite([ALPHA_1, ALPHA_2, BOX_1]);
    await sync(t);
    expect(await boxRows(t)).toEqual(["9781999000103@1", "9781999000110@2"]);
  });
});

/** Count the book-page fetches the stubbed site serves from here on. */
function countBookPages(): { count: number } {
  const counter = { count: 0 };
  const site = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(`${BASE}/books/`)) counter.count++;
    return site(input, init);
  });
  return counter;
}

/** The one observation of a fixture book. */
const observationOf = (t: TestConvex<typeof schema>, b: FixtureBook) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", String(b.id)),
        )
        .unique())!,
  );

const FUTURE_3: FixtureBook = {
  id: 103,
  slug: "alpha-manga-vol-3",
  title: "Alpha Adventures (Manga) Vol. 3",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "January 6, 2100",
};

// R10: a future Release the listing drops queues a possible-cancellation
// review; the listing naming it again retires that review, whether the book
// is unchanged (no page fetch) or re-read.
describe("sevenSeas.sync — a relisted book retires its cancellation review (B17)", () => {
  async function withdrawnFuture(t: ReturnType<typeof convexTest>) {
    await seedRegistry(t, true);
    stubSite([ALPHA_1, FUTURE_3]);
    await sync(t);
    await new Promise((r) => setTimeout(r, 5));
    stubSite([ALPHA_1]);
    await sync(t);
    const observation = await observationOf(t, FUTURE_3);
    expect(observation.withdrawn).toBe(true);
    const review = await t.run(async (ctx) => ctx.db.get(observation.queuedProposalId!));
    expect(review?.state).toBe("inReview");
    return review!._id;
  }

  it("an unchanged relisting withdraws the review without a page fetch", async () => {
    const t = convexTest(schema);
    const reviewId = await withdrawnFuture(t);

    stubSite([ALPHA_1, FUTURE_3]);
    const pages = countBookPages();
    await sync(t);
    expect(pages.count).toBe(0);
    expect((await observationOf(t, FUTURE_3)).withdrawn).toBe(false);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(reviewId)).toMatchObject({ state: "withdrawn" });
      // The Release stays exactly as it was.
      expect((await ctx.db.query("releases").collect()).every((r) => r.status === "active")).toBe(
        true,
      );
    });
  });

  it("a changed relisting withdraws the review too", async () => {
    const t = convexTest(schema);
    const reviewId = await withdrawnFuture(t);

    stubSite([ALPHA_1, { ...FUTURE_3, modified: "2026-09-01T00:00:00" }]);
    await sync(t);
    expect((await observationOf(t, FUTURE_3)).withdrawn).toBe(false);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(reviewId)).toMatchObject({ state: "withdrawn" });
    });
  });
});

/**
 * Store a book's observation as an older planner left it: unplaced, under
 * that planner's verdict, the snapshot parsed from the same wire shapes the
 * stubbed site serves (so the listing reads it as unchanged).
 */
async function seedLegacyUnplaced(
  t: ReturnType<typeof convexTest>,
  b: FixtureBook,
  verdict: string,
) {
  const snapshot = normalizeBook(parseBookListing(listingItem(b))!, parseBookPage(bookPageHtml(b)));
  const at = Date.now() - 86_400_000;
  await t.run(async (ctx) => {
    await ctx.db.insert("sourceObservations", {
      sourceKey: "sevenseas",
      sourceRecordId: String(b.id),
      snapshot,
      lastSeenAt: at,
      withdrawn: false,
      conflicts: [{ field: "placement", offered: null, at, reason: verdict }],
    });
  });
}

/** An Editor hid the base Series a book's snapshot names. */
async function hideSeriesOf(t: ReturnType<typeof convexTest>, b: FixtureBook) {
  const { seriesTitle } = normalizeBook(
    parseBookListing(listingItem(b))!,
    parseBookPage(bookPageHtml(b)),
  );
  await t.run((ctx) =>
    ctx.db.insert("series", {
      status: "hidden",
      publicId: 99,
      title: seriesTitle,
      altTitles: [],
      searchText: seriesTitle,
    }),
  );
}

const LEGACY_PACKAGING = (b: FixtureBook) =>
  `"${b.title}" is packaging whose covered Volumes the title does not state — an Editor maps it.`;

const DELUXE_1: FixtureBook = {
  id: 701,
  slug: "beta-deluxe-edition-1",
  title: "Beta Deluxe Edition 1",
  seriesSlug: "beta-deluxe",
  seriesTitle: "Beta Deluxe Edition",
  date: "March 3, 2026",
  blurb: "<p>Collects volumes 1-3 in hardcover.</p>",
};

const DELUXE_2: FixtureBook = {
  ...DELUXE_1,
  id: 702,
  slug: "beta-deluxe-edition-2",
  title: "Beta Deluxe Edition 2",
  blurb: "<p>Collects volumes 4-6 in hardcover.</p>",
};

// R13: packaging an older planner left unplaced (before the blurb and line
// signals placed it) is replayed from its stored snapshot on an unchanged
// listing: no page fetch, one detail-budget unit each, and never twice.
describe("sevenSeas.sync — replays packaging an older planner left unplaced (B19)", () => {
  it("places a blurb-covered Deluxe book in Bootstrap Mode, once", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await seedLegacyUnplaced(t, DELUXE_1, LEGACY_PACKAGING(DELUXE_1));
    stubSite([DELUXE_1]);
    const pages = countBookPages();

    expect(await sync(t)).toMatchObject({ recordsChanged: 1, errorCount: 0 });
    expect(pages.count).toBe(0);
    await t.run(async (ctx) => {
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["1", "2", "3"]);
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(3);
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
    expect((await observationOf(t, DELUXE_1)).recordRef?.type).toBe("release");

    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    expect(pages.count).toBe(0);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
  });

  it("queues its pre-filled guess once in steady state", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, false);
    await seedLegacyUnplaced(t, DELUXE_1, LEGACY_PACKAGING(DELUXE_1));
    stubSite([DELUXE_1]);
    await sync(t);
    await sync(t);
    await t.run(async (ctx) => {
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals.map((p) => p.state)).toEqual(["inReview"]);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
    });
    expect((await observationOf(t, DELUXE_1)).queuedProposalId).toBeDefined();
  });

  it("spends the detail budget, leaving the rest for the next run", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await seedLegacyUnplaced(t, DELUXE_1, LEGACY_PACKAGING(DELUXE_1));
    await seedLegacyUnplaced(t, DELUXE_2, LEGACY_PACKAGING(DELUXE_2));
    stubSite([DELUXE_2, DELUXE_1]);

    expect(await sync(t, { maxDetailFetches: 1 })).toMatchObject({
      recordsChanged: 1,
      completeSweep: false,
    });
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(1);
    expect(await sync(t, { maxDetailFetches: 1 })).toMatchObject({ recordsChanged: 1 });
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(2);
  });

  it("records the current verdict when the snapshot still places nothing, then leaves it", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, false);
    const bare = { ...DELUXE_1, blurb: undefined };
    await seedLegacyUnplaced(t, bare, LEGACY_PACKAGING(bare));
    stubSite([bare]);

    await sync(t);
    const first = (await observationOf(t, bare)).conflicts!.find((c) => c.field === "placement")!;
    expect(first.reason).not.toBe(LEGACY_PACKAGING(bare));
    await new Promise((r) => setTimeout(r, 5));
    await sync(t);
    const second = (await observationOf(t, bare)).conflicts!.find((c) => c.field === "placement")!;
    expect(second).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(0);
  });

  it("under a Series an Editor hid, notes the block once and stays a complete sweep", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await hideSeriesOf(t, DELUXE_1);
    await seedLegacyUnplaced(t, DELUXE_1, LEGACY_PACKAGING(DELUXE_1));
    stubSite([DELUXE_1]);
    const pages = countBookPages();

    expect(await sync(t)).toMatchObject({ recordsChanged: 0, completeSweep: true });
    const first = (await observationOf(t, DELUXE_1)).conflicts!.find((c) => c.field === "placement")!;
    expect(first.reason).toContain("which an Editor hid");
    await new Promise((r) => setTimeout(r, 5));
    expect(await sync(t, { maxDetailFetches: 0 })).toMatchObject({
      recordsChanged: 0,
      completeSweep: true,
    });
    const second = (await observationOf(t, DELUXE_1)).conflicts!.find((c) => c.field === "placement")!;
    expect(second).toEqual(first);
    expect(pages.count).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(0);
  });

  it("a new packaging book under a hidden Series is never replayed", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await hideSeriesOf(t, DELUXE_1);
    stubSite([DELUXE_1]);
    const pages = countBookPages();

    expect(await sync(t)).toMatchObject({ recordsChanged: 0, completeSweep: true });
    expect(pages.count).toBe(1);
    const first = (await observationOf(t, DELUXE_1)).conflicts!.find((c) => c.field === "placement")!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    expect(await sync(t, { maxDetailFetches: 0 })).toMatchObject({ completeSweep: true });
    expect(pages.count).toBe(1);
    const second = (await observationOf(t, DELUXE_1)).conflicts!.find((c) => c.field === "placement")!;
    expect(second).toEqual(first);
  });

  it("leaves an unplaced book with no verdict (an Editor's unlink) until its page changes", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    await seedLegacyUnplaced(t, DELUXE_1, LEGACY_PACKAGING(DELUXE_1));
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      await ctx.db.patch(obs._id, { conflicts: [] });
    });
    stubSite([DELUXE_1]);
    const pages = countBookPages();

    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    expect(pages.count).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(0);
  });

  it("bundles a box set whose blurb states its coverage", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    const box: FixtureBook = {
      ...BOX_1,
      title: "Alpha Adventures (Manga) Box Set 1",
      blurb: "<p>Collects volumes 1-2.</p>",
    };
    await seedLegacyUnplaced(
      t,
      box,
      `Box set "${box.title}" needs a unique base Series and stated coverage, and outside Bootstrap Mode a review.`,
    );
    stubSite([box, ALPHA_1, ALPHA_2]);
    const pages = countBookPages();
    await sync(t);
    expect(pages.count).toBe(0);
    expect(await boxMembers(t)).toEqual(["9781999000103", "9781999000110"]);
  });
});

// R12: a gapped list of Volumes, in the title or the listing blurb, is
// evidence no range can hold. The line's declared size (3-in-1 → 1–3) never
// stands in for it, so no skipped Volume is created or covered.
describe("sevenSeas.sync — a gapped coverage statement is never widened (R12)", () => {
  const THREE_IN_1: FixtureBook = {
    id: 311,
    slug: "alpha-3-in-1-edition-1",
    title: "Alpha 3-in-1 Edition 1",
    seriesSlug: "alpha-3-in-1",
    seriesTitle: "Alpha 3-in-1 Edition",
    date: "March 3, 2026",
    isbn: "978-1-9990004-2-4",
  };

  async function placed(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => ({
      volumes: (await ctx.db.query("volumes").collect()).map((v) => v.label).sort(),
      coverages: (await ctx.db.query("volumeCoverages").collect()).length,
      unmapped: (await ctx.db.query("editions").collect()).map((e) => e.coverageUnmapped ?? false),
    }));
  }

  it("a blurb collecting Volumes 1 and 3 never falls back to the 3-in-1 size", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb: "<p>Collects volumes 1 and 3.</p>" }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  // A gapped list with no collect-verb in front of it is still a statement.
  it.each([
    "<p>Volumes 1 &amp; 3 in one book!</p>",
    "<p>Features volumes 1 and 3.</p>",
    "<p>Collects volumes #1 and #3.</p>",
  ])("a bare gapped list (%s) never falls back to the 3-in-1 size", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  it.each([
    "Alpha 3-in-1 Edition 1 (Vol. 1 & 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1 and Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1 & Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Vol. #1 & #3)",
  ])("a title listing Volumes with a gap (%s) never falls back to the 3-in-1 size", async (title) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, title }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  // "4 bonus stories" counts something else: the blurb reads 1–4 or 1–3,
  // and the 3-in-1 size agrees with 1–3 alone. No Volume 4 is invented.
  it.each([
    "<p>Collects volumes 1–3 and 4 bonus stories.</p>",
    "<p>Collects volumes 1-3 and 4 all-new bonus stories.</p>",
    "<p>Collects volumes 1-3 plus 4 all-new bonus stories.</p>",
    "<p>Collects volumes 1-3 and 4-page bonus comic.</p>",
    "<p>Collects volumes 1-3 and 4 of the author's short stories.</p>",
    "<p>Collects volumes 1-3 and 4 “bonus” stories.</p>",
    "<p>Collects volumes 1-3 and 4 as-yet-unpublished stories.</p>",
    "<p>Collects volumes 1-3 and 4 for the first time.</p>",
    "<p>Collects volumes 1-3 and 4 on-model sketches.</p>",
    "<p>Collects volumes 1-3 and 4 (four!) bonus stories.</p>",
    "<p>Collects volumes 1-3 and 4.5 bonus pages.</p>",
    "<p>Volumes 1-3 and 4 all-new stories in one book.</p>",
  ])("a count after the listed range (%s) places the 3-in-1 at 1–3", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  // The last Volume of a contiguous list is never quietly dropped.
  it.each([
    "<ul><li>Collects volumes 1, 2, and 3</li><li>Hardcover</li></ul>",
    "<p>Collects volumes 1, 2, and 3 featuring new cover art.</p>",
  ])("a contiguous list before other copy (%s) places the 3-in-1 at 1–3", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  // A gapped or unfinished list, whatever follows it, places nothing.
  it.each([
    "<p>Collects volumes 1 and 3</p><p>Remastered</p>",
    "<p>Collects volumes 1 and 3 remastered.</p>",
    "<p>Collects volumes 1-3 and 4.5.</p>",
    "<p>Collects volumes 1 as well as 3.</p>",
    "<p>Collects volumes 1-2; 4.</p>",
  ])("a gapped or unfinished list (%s) leaves the 3-in-1 Unmapped", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  it.each([
    "Alpha 3-in-1 Edition 1 (Collecting Vols. 1 and 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1 + Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Includes Vol. 1 + 3)",
  ])("a title stating a gapped list (%s) leaves the 3-in-1 Unmapped", async (title) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, title }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  // An observation stored before the parser marked gapped lists, left
  // unplaced by an older planner, replays (R13) from its stored snapshot:
  // the replay reads its packaging from today's parse, never the stale one.
  it("a replayed snapshot stored before the gap was marked still never widens", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    const gapped = { ...THREE_IN_1, title: "Alpha 3-in-1 Edition 1 (Vol. 1 & 3)" };
    await seedLegacyUnplaced(t, gapped, LEGACY_PACKAGING(gapped));
    await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      const { coverageGapped, ...packaging } = obs!.snapshot.packaging;
      expect(coverageGapped).toBe(true);
      await ctx.db.patch(obs!._id, { snapshot: { ...obs!.snapshot, packaging } });
    });
    stubSite([gapped]);
    const pages = countBookPages();
    await sync(t);
    expect(pages.count).toBe(0);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  it("without any statement the declared size still places it", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([THREE_IN_1]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  const OMNIBUS: FixtureBook = {
    ...THREE_IN_1,
    id: 312,
    slug: "alpha-omnibus-1",
    title: "Alpha Omnibus 1",
    seriesSlug: "alpha-omnibus",
    seriesTitle: "Alpha Omnibus",
  };

  // A later number the list never joined counts something else: the one
  // stated range places an Omnibus (no declared size) at 1–3.
  it.each([
    "<p>Collects volumes 1–3 (chapters 1–27).</p>",
    "<p>Collects volumes 1-3 of Mob Psycho 100.</p>",
    "<p>Collects volumes 1-3 of Kaiju No. 8.</p>",
    "<p>Collects volumes 1-3 of 10.</p>",
    "<p>Collects volumes 1-3, chapters 1 to 27.</p>",
  ])("a stated range before other numbers (%s) places an Omnibus at 1–3", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...OMNIBUS, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  // A list with no collect-verb in front of it never overrides the 3-in-1
  // size, and never creates the Volumes it names.
  it.each([
    "<p>The story continues in volumes 4 and 5.</p>",
    "<p>Catch up before volumes 4 and 5, coming soon.</p>",
    "<p>Don't miss volumes 2 and 3!</p>",
    "<p>The story continues in volumes 4–6.</p>",
  ])("a bare narrative list (%s) places the 3-in-1 at 1–3 from its size", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  // A collect-verb collects the phrase an article or preposition opens, not
  // the list inside it, and a verb in another sentence governs nothing.
  const UNGOVERNED = [
    "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5</p>",
    "<p>Includes a preview of volumes 4 and 5.</p>",
    "<p>Includes a preview of volume 4.</p>",
    "<p>Includes a letter from Oda. Volumes 4 and 5 are out now.</p>",
    "<p>Collects chapters 1-27 and a preview of volumes 4-6.</p>",
  ];

  it.each(UNGOVERNED)("a list the verb does not govern (%s) places the 3-in-1 at 1–3", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  it.each(UNGOVERNED)("a list the verb does not govern (%s) leaves an Omnibus Unmapped", async (blurb) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...OMNIBUS, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  it.each([
    ["<p>Collects volumes 1-3 / 4-6.</p>", { volumes: [], coverages: 0, unmapped: [true] }],
    // The statement the verb governs decides; the bare gap before it is silence.
    [
      "<p>Volumes 1 and 3 are here. Collects volumes 1-3.</p>",
      { volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] },
    ],
  ])("an Omnibus with %s", async (blurb, expected) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...OMNIBUS, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual(expected);
  });

  it("a bare narrative list leaves an Omnibus Unmapped, creating no Volume", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...OMNIBUS, blurb: "<p>The story continues in volumes 4 and 5.</p>" }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [], coverages: 0, unmapped: [true] });
  });

  // "/" joins only weakly: the 3-in-1 size agrees with 1–3 alone.
  it("a slash-joined range places the 3-in-1 at 1–3, creating no Volume 4–6", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, blurb: "<p>Collects volumes 1-3 / 4-6.</p>" }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] });
  });

  // "Part N, Vol. M" is Volume M of the Part: no packaging, no Volume N.
  it.each([
    ["Alpha, Part 1, Vol. 2", "2"],
    ["Alpha Book 2, Vol. 3", "3"],
    ["Alpha: Part 5, Vol. 6", "6"],
  ])("a title %s is one Volume of its Part, never packaging", async (title, label) => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...THREE_IN_1, slug: "alpha-part", seriesSlug: "alpha-part", seriesTitle: undefined, title }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: [label], coverages: 1, unmapped: [false] });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(0);
    });
  });

  const THREE_IN_1_2: FixtureBook = {
    ...THREE_IN_1,
    id: 313,
    slug: "alpha-3-in-1-edition-2",
    title: "Alpha 3-in-1 Edition 2",
    isbn: "978-1-9990004-3-1",
  };
  const PLACED_1_3 = { volumes: ["1", "2", "3"], coverages: 3, unmapped: [false] };
  const UNMAPPED = { volumes: [], coverages: 0, unmapped: [true] };

  async function syncOne(book: FixtureBook, blurb: string) {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([{ ...book, blurb }]);
    await sync(t);
    return await placed(t);
  }

  // The collect-verb nearest the list governs it.
  it.each([
    "<p>This collected edition includes volumes 1-3.</p>",
    "<p>Includes a new afterword and collects volumes 1-3.</p>",
    "<p>Includes all-new bonus material and collects volumes 1-3 of the original series.</p>",
    "<p>Collecting the acclaimed manga, this omnibus contains volumes 1-3.</p>",
  ])("the verb nearest the list (%s) places an Omnibus at 1–3", async (blurb) => {
    expect(await syncOne(OMNIBUS, blurb)).toEqual(PLACED_1_3);
  });

  // A governed capital-Volumes 1–3 contradicts the size at position 2
  // (4–6): the book stays Unmapped and no Volume 4–6 is created.
  it("a governed statement that contradicts the 3-in-1 size creates no Volume", async () => {
    const blurb = "<p>This collected edition contains Volumes 1–3 of the series.</p>";
    expect(await syncOne(THREE_IN_1_2, blurb)).toEqual(UNMAPPED);
  });

  it.each(["<p>Collects volumes 1-3 plus 16 pages of color art.</p>", "<p>Collects volumes 1-3 of Alpha!</p>"])(
    "a dash range (%s) places an Omnibus at 1–3",
    async (blurb) => {
      expect(await syncOne(OMNIBUS, blurb)).toEqual(PLACED_1_3);
    },
  );

  // A range after "and" ("4 to 6") is a Volume range: 1–6, which the 3-in-1
  // size contradicts. So does a list across a block boundary cleanBlurb
  // spaced over, which the verb governs. Neither creates a Volume.
  it.each([
    "<p>Collects volumes 1-3 and 4 to 6 new pages.</p>",
    "<h3>Collects the hit series</h3><p>Volumes 4-6 on sale now.</p>",
  ])("a statement the 3-in-1 size contradicts (%s) leaves it Unmapped", async (blurb) => {
    expect(await syncOne(THREE_IN_1, blurb)).toEqual(UNMAPPED);
  });

  it("an ambiguous last item agreeing with no size leaves the 3-in-1 Unmapped", async () => {
    expect(await syncOne(THREE_IN_1_2, "<p>Collects volumes 1-3 and 4 bonus stories.</p>")).toEqual(UNMAPPED);
  });

  it.each(["<p>Volumes 1–3 of the acclaimed series, in hardcover.</p>", "<p>Volumes 1, 2, and 3 together at last.</p>"])(
    "a sentence-initial list (%s) places an Omnibus at 1–3",
    async (blurb) => {
      expect(await syncOne(OMNIBUS, blurb)).toEqual(PLACED_1_3);
    },
  );

  it.each([
    ["an Omnibus", OMNIBUS],
    ["a 3-in-1", THREE_IN_1],
  ])("a run-on range leaves %s Unmapped", async (_, book) => {
    expect(await syncOne(book, "<p>Collects volumes 1-2-3.</p>")).toEqual(UNMAPPED);
  });

  const DELUXE: FixtureBook = {
    ...THREE_IN_1,
    id: 314,
    slug: "alpha-deluxe-edition-1",
    title: "Alpha Deluxe Edition 1",
    seriesSlug: "alpha-deluxe",
    seriesTitle: "Alpha Deluxe Edition",
  };
  const onlyCovering = (volumes: string[]) => ({ volumes, coverages: volumes.length, unmapped: [false] });

  // W02: a title statement reads its Volume designation only. "16 pages of
  // art" is prose: no Volumes 2–16, and the 3-in-1 size never widens it.
  it.each([
    ["a Deluxe", DELUXE],
    ["a 3-in-1", THREE_IN_1],
  ])("a page count in a title statement on %s creates Volume 1 alone", async (_, book) => {
    const title = book.title + " (Collecting Vol. 1 plus 16 pages of art)";
    expect(await syncOne({ ...book, title }, "")).toEqual(onlyCovering(["1"]));
  });

  // W02: a bare last number with copy after it may count the copy, and a
  // title has no size to settle it.
  it("a title statement whose last number may count its copy leaves the book Unmapped", async () => {
    const title = "Alpha Deluxe Edition 1 (Collecting Vol. 1 and 2 bonus stories)";
    expect(await syncOne({ ...DELUXE, title }, "")).toEqual(UNMAPPED);
  });

  // W02: a marked Volume joined by "plus" is read, never dropped as prose:
  // the title covers both Volumes; a gap after the join blocks.
  it.each([
    ["Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vol. 2)", onlyCovering(["1", "2"])],
    ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vols. 4-6)", onlyCovering(["1", "2", "3", "4", "5", "6"])],
    ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 5)", UNMAPPED],
  ])("a title statement joining a marked Volume (%s) is read whole", async (title, expected) => {
    expect(await syncOne({ ...DELUXE, title }, "")).toEqual(expected);
  });

  // W03: "volume 4" carries its own marker, so it is a fourth Volume, never
  // a count the 3-in-1 size may drop.
  it.each([
    ["a 3-in-1", THREE_IN_1, UNMAPPED],
    ["a Deluxe", DELUXE, onlyCovering(["1", "2", "3", "4"])],
  ])("a marked last Volume places %s by all four Volumes or not at all", async (_, book, expected) => {
    expect(await syncOne(book, "<p>Collects volumes 1-3 and volume 4 in one book.</p>")).toEqual(expected);
  });

  // W04: a range joined by "plus" is read before the copy after it: a gap
  // blocks on every line, a contiguous range widens the statement.
  it.each([
    ["a Deluxe", "<p>Collects volumes 1-3 plus 5-6 in one book.</p>", DELUXE, UNMAPPED],
    ["a 3-in-1", "<p>Collects volumes 1-3 plus 5-6 in one book.</p>", THREE_IN_1, UNMAPPED],
    [
      "a Deluxe",
      "<p>Collects volumes 1-3 plus 4-6 in one book.</p>",
      DELUXE,
      onlyCovering(["1", "2", "3", "4", "5", "6"]),
    ],
  ])("a joined range places %s by the whole list (%s)", async (_, blurb, book, expected) => {
    expect(await syncOne(book, blurb)).toEqual(expected);
  });

  // N01: a title statement reads its list as a blurb does. Every item after
  // a joined range is read and beats the size; a gap or a possessive blocks.
  const ONE_TO_NINE = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  it.each([
    [DELUXE, " (Collecting Vols. 1-3 plus 4-6 and 7-9 in one book)", onlyCovering(ONE_TO_NINE)],
    [THREE_IN_1, " (Collecting Vols. 1-3 plus 4-6 and 7-9 in one book)", onlyCovering(ONE_TO_NINE)],
    [DELUXE, " (Collecting Vols. 1-3 plus 4-6 and 8-9 in one book)", UNMAPPED],
    [THREE_IN_1, " (Collecting Vols. 1-3 plus 4-6 and 8-9 in one book)", UNMAPPED],
    [DELUXE, " (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", UNMAPPED],
    [DELUXE, " (Collecting Vols. 1-3 plus 4)", onlyCovering(["1", "2", "3", "4"])],
  ])("a title statement continuing past a joined range (%#) is read whole or not at all", async (book, statement, expected) => {
    expect(await syncOne({ ...book, title: book.title + statement }, "")).toEqual(expected);
  });

  // N02: an uppercase possessive still reads two ways: the 3-in-1 size
  // settles it to 1–3, and a Deluxe with no size stays Unmapped.
  it.each([
    ["a Deluxe", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4'S BONUS CHAPTER.</p>", DELUXE, UNMAPPED],
    ["a Deluxe", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4’S BONUS CHAPTER.</p>", DELUXE, UNMAPPED],
    ["a 3-in-1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4'S BONUS CHAPTER.</p>", THREE_IN_1, PLACED_1_3],
    ["a 3-in-1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4’S BONUS CHAPTER.</p>", THREE_IN_1, PLACED_1_3],
  ])("an uppercase possessive places %s by the size or not at all (%s)", async (_, blurb, book, expected) => {
    expect(await syncOne(book, blurb)).toEqual(expected);
  });

  // W05: "Negima!" is the Series' name, not a sentence end. The verb governs
  // 37–38, which the 3-in-1 size at position 13 (37–39) contradicts: no
  // Volume 39 is invented. With no size the statement places the book.
  it.each([
    [
      "a 3-in-1",
      {
        ...THREE_IN_1,
        slug: "negima-3-in-1-edition-13",
        title: "Negima! 3-in-1 Edition Vol. 13",
        seriesSlug: "negima-3-in-1",
        seriesTitle: "Negima! 3-in-1 Edition",
      },
      UNMAPPED,
    ],
    [
      "a Deluxe",
      {
        ...DELUXE,
        slug: "negima-deluxe-edition-1",
        title: "Negima! Deluxe Edition 1",
        seriesSlug: "negima-deluxe",
        seriesTitle: "Negima! Deluxe Edition",
      },
      onlyCovering(["37", "38"]),
    ],
  ])("a Series title's own '!' before its Volumes places %s by the statement", async (_, book, expected) => {
    expect(await syncOne(book, "<p>Collects Negima! Volumes 37-38.</p>")).toEqual(expected);
  });
});
