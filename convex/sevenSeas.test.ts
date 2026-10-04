// Seven Seas adapter tests (ticket #34): the whole import path run against
// a stubbed site serving fixture responses in the live wire shapes — no
// network. Covers the acceptance criteria end to end: canonical records
// with cited public Revisions, observation identity + latest snapshot +
// append-only history, last-seen-only bumps, Bootstrap Mode tagging, the
// steady-state review queue, covers in file storage, and withdrawal.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { normalizeBook, parseBookListing, parseBookPage, type BookSnapshot } from "./lib/sevenSeas";
import {
  type CatalogOverrides,
  insertObservation,
  insertPublisher,
  insertSeries,
  insertSourceRevision,
  seedCatalog,
} from "./test.factories";
import { alice, bundleMembers, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";
import { pubDate } from "./test.catalog";
import {
  ALPHA_1,
  bookPageHtml,
  type FixtureBook,
  imageRequests,
  listingItem,
  SEVEN_SEAS as BASE,
  stubSite,
} from "./test.imports";

afterEach(() => {
  vi.unstubAllGlobals();
  imageRequests.length = 0;
});

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.sevenSeas.sync, { politeDelayMs: 0, ...args });

/** The one observation of a fixture book. */
const observationOf = (t: TestT, b: FixtureBook) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", String(b.id)),
        )
        .unique())!,
  );

/** Age every observation's last sighting, so a later sweep that sees a book again shows it. */
const ageObservations = (t: TestT) =>
  t.run(async (ctx) => {
    for (const observation of await ctx.db.query("sourceObservations").collect()) {
      await ctx.db.patch(observation._id, { lastSeenAt: 1 });
    }
  });

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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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

  it("never queues a brand-new Series for a work an Editor hid", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    await t.run((ctx) => insertSeries(ctx, { status: "hidden", title: "Alpha Adventures (Manga)" }));
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("proposals").collect()).toHaveLength(0);
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs?.queuedProposalId).toBeUndefined();
      expect(obs?.conflicts?.some((c) => c.reason.includes("an Editor hid"))).toBe(true);
    });
  });

  it("keeps uncovered packaging on its observation outside Bootstrap Mode", async () => {
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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

  it("replaces an aggregator's description with its own blurb, even with the listing unchanged", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    // The Release lost its text, then ANN's release page filled it (weak)
    // before Seven Seas re-read the book.
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: release._id },
        sourceKey: "ann",
        seq: 99,
        changes: [{ field: "description", before: undefined, after: "ANN's summary." }],
        comment: "Imported from Anime News Network Encyclopedia.",
      });
      await ctx.db.patch(release._id, { description: "ANN's summary." });
    });
    expect(await sync(t)).toMatchObject({ recordsChanged: 1 });
    const description = () =>
      t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!.description);
    expect(await description()).toBe("Alpha’s first adventure.");
    // Its own text now: the unchanged short-circuit is back.
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });

    // A human's text is never re-read for.
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      const userId = await ctx.db.insert("users", {
        clerkSubject: "editor",
        username: "Editor",
        usernameNormalized: "editor",
        role: "editor",
        formatPreference: "both",
        ownershipVisibility: "private",
        readingVisibility: "private",
      });
      const editorProposal = await ctx.db.insert("proposals", {
        author: { kind: "user", userId },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: release._id },
        seq: 200,
        proposalId: editorProposal,
        author: { kind: "user", userId },
        changes: [{ field: "description", before: undefined, after: "An Editor's text." }],
        comment: "Edited.",
      });
      await ctx.db.patch(release._id, { description: "An Editor's text." });
    });
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    expect(await description()).toBe("An Editor's text.");
  });

  it("keeps append-only history and auto-updates authoritative fields on change", async () => {
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
  const cover = (t: TestT) =>
    t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!.coverImage ?? null);

  it("keeps a current cover and replaces one whose URL changed, deleting its blob", async () => {
    const t = makeT();
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
      expect(await ctx.storage.getUrl(first.storageId!)).toBeNull();
    });
  });

  it("records an SVG placeholder on the Release instead of storing or refetching it", async () => {
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
  t: TestT,
  seriesTitle: string,
  release: CatalogOverrides["release"] = { isbn13: "9781999000103" },
) => {
  const { releaseId } = await t.run((ctx) =>
    seedCatalog(ctx, {
      publisher: { name: "Seven Seas Entertainment", slug: "seven-seas" },
      series: { title: seriesTitle },
      release,
    }),
  );
  return releaseId;
};

describe("sevenSeas.sync — ISBN matching rung", () => {
  it("links to an existing release by ISBN when titles agree", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const releaseId = await insertCatalogRelease(t, "Alpha Adventures");
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
    expect((await observationOf(t, ALPHA_1)).recordRef).toEqual({ type: "release", id: releaseId });
  });

  it("flags an ISBN match with a dissimilar title for review instead of linking", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertCatalogRelease(t, "Completely Different Zeta");
    stubSite([ALPHA_1]);
    const result = (await sync(t)) as { errorCount: number };
    expect(result.errorCount).toBe(1);
    expect((await observationOf(t, ALPHA_1)).recordRef).toBeUndefined();
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      const run = (await ctx.db.query("importRuns").collect())[0]!;
      expect(run.errors[0]).toContain("review");
    });
  });
});

describe("sevenSeas.sync — Binding reaches the matching ladder (B14)", () => {
  it("a hardcover never links an ISBN-less paperback of its Volume; it becomes its sibling", async () => {
    const t = makeT();
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
    const t = makeT();
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
    });
    expect((await observationOf(t, ALPHA_1)).conflicts).toEqual([
      expect.objectContaining({ field: "isbn13", offered: heldIsbn }),
    ]);
  });
});

describe("sevenSeas.sync — failure handling", () => {
  it("does not withdraw a listed book when its title becomes out of scope", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await ageObservations(t);
    stubSite([{ ...ALPHA_1, title: "Alpha Adventures (Light Novel) Vol. 1" }]);
    await sync(t);
    expect((await observationOf(t, ALPHA_1)).withdrawn).toBe(false);
  });

  it.each(["missing pagination", "malformed book", "unexpected empty page"])(
    "does not withdraw existing observations after %s",
    async (failure) => {
      const t = makeT();
      await seedRegistry(t, true);
      stubSite([ALPHA_1]);
      await sync(t);
      await ageObservations(t);
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
      expect((await observationOf(t, ALPHA_1)).withdrawn).toBe(false);
    },
  );

  it("skips an invalid listing item, imports the rest, and fails without withdrawing", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    await ageObservations(t);

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
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await ageObservations(t);
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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

  // The flag gates runs, never applies (lib/importRuns.ts): an operator's
  // direct call to the apply mutation writes on a disabled source.
  it("applies a direct applyBook call while the source is disabled", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    const sourceRecordId = String(ALPHA_1.id);
    await t.run(async (ctx) => {
      const source = (await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique())!;
      await ctx.db.patch(source._id, { enabled: false });
    });
    const stored = await observationOf(t, ALPHA_1);
    const snapshot = { ...(stored.snapshot as BookSnapshot), title: "Alpha Manga Vol. 1 (Renamed)" };
    await t.mutation(internal.sevenSeas.applyBook, { sourceRecordId, snapshot });
    expect((await observationOf(t, ALPHA_1)).snapshot).toEqual(snapshot);
  });

  it("finishes the listing page under way and stops before the next once the source is disabled", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // A book an earlier sweep saw: only a complete sweep may withdraw it.
    await t.run((ctx) => insertObservation(ctx, { sourceKey: "sevenseas", sourceRecordId: "999" }));
    stubSite([ALPHA_1, ALPHA_2]);
    const site = globalThis.fetch;
    const listingPages: string[] = [];
    // Two listing pages, one book each; the source is disabled while page 1 loads.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(`${BASE}/wp-json/wp/v2/books`)) return await site(input);
      const page = new URL(url).searchParams.get("page")!;
      listingPages.push(page);
      if (page === "1") {
        await t.mutation(internal.importSources.setEnabledInternal, { key: "sevenseas", enabled: false });
      }
      return new Response(JSON.stringify([listingItem(page === "1" ? ALPHA_1 : ALPHA_2)]), {
        headers: { "x-wp-totalpages": "2", "content-type": "application/json" },
      });
    });
    expect(await sync(t)).toMatchObject({ stopped: true, recordsSeen: 1, completeSweep: false });
    expect(listingPages).toEqual(["1"]);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", automatic: true, recordsSeen: 1, recordsChanged: 1 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.find((o) => o.sourceRecordId === "999")?.withdrawn).toBe(false);
      expect(observations.some((o) => o.sourceRecordId === String(ALPHA_2.id))).toBe(false);
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique();
      expect(source?.consecutiveFailures).toBe(0);
    });
    expect((await observationOf(t, ALPHA_1)).recordRef?.type).toBe("release");
  });

  it("withdraws nothing when the source is disabled during the last listing page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) => insertObservation(ctx, { sourceKey: "sevenseas", sourceRecordId: "999" }));
    stubSite([ALPHA_1]);
    const site = globalThis.fetch;
    // One listing page: the sweep is complete once it applies, and the
    // source is disabled while it loads.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith(`${BASE}/wp-json/wp/v2/books`)) {
        await t.mutation(internal.importSources.setEnabledInternal, { key: "sevenseas", enabled: false });
      }
      return await site(input);
    });
    expect(await sync(t)).toMatchObject({ stopped: true, recordsSeen: 1, completeSweep: false });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", recordsSeen: 1 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.find((o) => o.sourceRecordId === "999")?.withdrawn).toBe(false);
    });
    expect((await observationOf(t, ALPHA_1)).recordRef?.type).toBe("release");
  });

  // The scheduler closed the run as stranded while this link still ran: the
  // gate before the withdrawal pass refuses it.
  it("never withdraws for a run closed during its last listing page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) => insertObservation(ctx, { sourceKey: "sevenseas", sourceRecordId: "999" }));
    stubSite([ALPHA_1]);
    const site = globalThis.fetch;
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "sevenseas" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith(`${BASE}/wp-json/wp/v2/books`)) {
        await t.run((ctx) => ctx.db.patch(runId, { status: "failed", finishedAt: Date.now() }));
      }
      return await site(input);
    });
    expect(await sync(t, { runId })).toMatchObject({ stopped: true, completeSweep: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(runId)).toMatchObject({ status: "failed", recordsSeen: 0 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.find((o) => o.sourceRecordId === "999")?.withdrawn).toBe(false);
    });
  });

  it("imports through a run an operator forced on the disabled source", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.mutation(internal.importSources.setEnabledInternal, { key: "sevenseas", enabled: false });
    stubSite([ALPHA_1]);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "sevenseas" });
    expect(await sync(t, { runId })).toMatchObject({ runId, recordsSeen: 1, completeSweep: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(runId)).toMatchObject({ status: "succeeded" });
    });
    expect((await observationOf(t, ALPHA_1)).recordRef?.type).toBe("release");
  });
});

/** An Administrator who can approve queued proposals. */
async function withAdmin(t: TestT) {
  await seedTeam(t, [alice]);
  return signedIn(t, alice);
}

/** Approve the one In-Review proposal the importer queued. */
async function approveQueued(t: TestT, admin: Awaited<ReturnType<typeof withAdmin>>) {
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
    const admin = await withAdmin(t);
    await seedRegistry(t, true);
    await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      // Two Series of the same name: the omnibus's base Series is ambiguous.
      for (let i = 0; i < 2; i++) await insertSeries(ctx, { title: "Alpha Adventures" });
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
    const t = makeT();
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

/** The one box's members, by their Releases' ISBNs in bundle order. */
const boxMembers = async (t: TestT) => (await bundleMembers(t)).map((member) => member.release.isbn13);

// R09: a box imported before some of its books picks those books up once
// they exist, whether its listing is unchanged (no detail fetch) or its
// page is re-read.
describe("sevenSeas.sync — a box set gains members that arrive after it (B15)", () => {
  it("an unchanged box listing reconciles its members without a detail fetch, in steady state", async () => {
    const t = makeT();
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
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1, BOX_1]);
    await sync(t);
    // Volume 2 arrives after the box's listing was noted this run.
    stubSite([BOX_1, ALPHA_1, ALPHA_2]);
    await sync(t);
    expect(await boxMembers(t)).toEqual(["9781999000103"]);

    const box = { sourceRecordId: String(BOX_1.id) };
    const { snapshot } = await observationOf(t, BOX_1);
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
const boxRows = async (t: TestT) =>
  (await bundleMembers(t)).map((member) => `${member.release.isbn13}@${member.order}`);

/** The newest Import Run's errors. */
const lastRunErrors = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("importRuns").order("desc").first())!.errors);

// W08: a linked box fills only from its canonical identity. Its listing
// repointed at another series goes to review — on the re-read page and on
// the unchanged listing after it — and never adds that series' books.
describe("sevenSeas.sync — a linked box keeps its canonical identity (W08)", () => {
  it("a box listed under another series adds nothing and reports review", async () => {
    const t = makeT();
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
    const t = makeT();
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
  async function withdrawnFuture(t: TestT) {
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
    const t = makeT();
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
    const t = makeT();
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
  t: TestT,
  b: FixtureBook,
  verdict: string,
) {
  const snapshot = normalizeBook(parseBookListing(listingItem(b))!, parseBookPage(bookPageHtml(b)));
  const at = Date.now() - 86_400_000;
  await t.run((ctx) =>
    insertObservation(ctx, {
      sourceKey: "sevenseas",
      sourceRecordId: String(b.id),
      snapshot,
      lastSeenAt: at,
      conflicts: [{ field: "placement", offered: null, at, reason: verdict }],
    }),
  );
}

/** An Editor hid the base Series a book's snapshot names. */
async function hideSeriesOf(t: TestT, b: FixtureBook) {
  const { seriesTitle } = normalizeBook(
    parseBookListing(listingItem(b))!,
    parseBookPage(bookPageHtml(b)),
  );
  await t.run((ctx) => insertSeries(ctx, { status: "hidden", title: seriesTitle }));
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
    const t = makeT();
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
// stands in for it, so no skipped Volume is created or covered. The grammar
// is pinned by lib/coverage.test.ts and lib/bookTitle.test.ts; these cases
// prove Seven Seas' own wiring (the title and the listing blurb, its one
// coverage text) for each outcome: placed, Unmapped, nothing created.
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
  const THREE_IN_1_2: FixtureBook = {
    ...THREE_IN_1,
    id: 313,
    slug: "alpha-3-in-1-edition-2",
    title: "Alpha 3-in-1 Edition 2",
    isbn: "978-1-9990004-3-1",
  };
  const OMNIBUS: FixtureBook = {
    ...THREE_IN_1,
    id: 312,
    slug: "alpha-omnibus-1",
    title: "Alpha Omnibus 1",
    seriesSlug: "alpha-omnibus",
    seriesTitle: "Alpha Omnibus",
  };
  const DELUXE: FixtureBook = {
    ...THREE_IN_1,
    id: 314,
    slug: "alpha-deluxe-edition-1",
    title: "Alpha Deluxe Edition 1",
    seriesSlug: "alpha-deluxe",
    seriesTitle: "Alpha Deluxe Edition",
  };
  /** A book the listing files under the plain "Alpha" series: no Edition Line in its series link. */
  const lineless = (title: string): FixtureBook => ({ ...DELUXE, title, seriesSlug: "alpha", seriesTitle: "Alpha" });

  async function placed(t: TestT) {
    return await t.run(async (ctx) => ({
      volumes: (await ctx.db.query("volumes").collect()).map((v) => v.label).sort(),
      coverages: (await ctx.db.query("volumeCoverages").collect()).length,
      unmapped: (await ctx.db.query("editions").collect()).map((e) => e.coverageUnmapped ?? false),
    }));
  }
  const onlyCovering = (volumes: string[]) => ({ volumes, coverages: volumes.length, unmapped: [false] });
  const PLACED_1_3 = onlyCovering(["1", "2", "3"]);
  const UNMAPPED = { volumes: [], coverages: 0, unmapped: [true] };
  const NOTHING = { volumes: [], coverages: 0, unmapped: [] };

  const WIRING = [
    // The title.
    {
      name: "a title listing Volumes 1 & 3 never falls back to the 3-in-1 size",
      book: { ...THREE_IN_1, title: "Alpha 3-in-1 Edition 1 (Vol. 1 & 3)" },
      expected: UNMAPPED,
    },
    { name: "without any statement the declared size still places a 3-in-1", book: THREE_IN_1, expected: PLACED_1_3 },
    {
      name: "a title's own range (Alpha Omnibus 2 (Vol. 4-6)) creates and covers its Volumes",
      book: { ...OMNIBUS, title: "Alpha Omnibus 2 (Vol. 4-6)" },
      expected: onlyCovering(["4", "5", "6"]),
    },
    {
      name: "a bare range beside a rejected bracket statement creates nothing",
      book: lineless("Alpha, Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)"),
      expected: NOTHING,
    },
    {
      name: "an earlier marker makes a trailing statement a plain Volume's subtitle",
      book: { ...DELUXE, title: "Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3" },
      expected: onlyCovering(["2"]),
    },
    {
      name: "a blurb never stands in for a title statement the outer range contradicts",
      book: { ...DELUXE, title: "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)" },
      blurb: "<p>Collects volumes 1-9.</p>",
      expected: UNMAPPED,
    },
    // The listing blurb.
    {
      name: "a blurb collecting Volumes 1 and 3 never falls back to the 3-in-1 size",
      book: THREE_IN_1,
      blurb: "<p>Collects volumes 1 and 3.</p>",
      expected: UNMAPPED,
    },
    {
      name: "an entity-encoded bare gapped list never falls back to the 3-in-1 size",
      book: THREE_IN_1,
      blurb: "<p>Volumes 1 &amp; 3 in one book!</p>",
      expected: UNMAPPED,
    },
    {
      name: "a stated range before other numbers places an Omnibus at 1–3",
      book: OMNIBUS,
      blurb: "<p>Collects volumes 1-3 of Mob Psycho 100.</p>",
      expected: PLACED_1_3,
    },
    {
      name: "a count after the listed range places the 3-in-1 at 1–3",
      book: THREE_IN_1,
      blurb: "<p>Collects volumes 1-3 and 4 (four!) bonus stories.</p>",
      expected: PLACED_1_3,
    },
    {
      name: "a bare narrative list leaves an Omnibus Unmapped, creating no Volume",
      book: OMNIBUS,
      blurb: "<p>The story continues in volumes 4 and 5.</p>",
      expected: UNMAPPED,
    },
    {
      name: "a governed statement that contradicts the 3-in-1 size creates no Volume",
      book: THREE_IN_1_2,
      blurb: "<p>This collected edition contains Volumes 1–3 of the series.</p>",
      expected: UNMAPPED,
    },
    {
      name: "a joined range places a Deluxe book by the whole list",
      book: DELUXE,
      blurb: "<p>Collects volumes 1-3 plus 4-6 in one book.</p>",
      expected: onlyCovering(["1", "2", "3", "4", "5", "6"]),
    },
    {
      name: "a list the verb in another block does not govern places the 3-in-1 at 1–3",
      book: THREE_IN_1,
      blurb: "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5</p>",
      expected: PLACED_1_3,
    },
    {
      name: "a Series title's own '!' before its Volumes places a Deluxe book by the statement",
      book: {
        ...DELUXE,
        slug: "negima-deluxe-edition-1",
        title: "Negima! Deluxe Edition 1",
        seriesSlug: "negima-deluxe",
        seriesTitle: "Negima! Deluxe Edition",
      },
      blurb: "<p>Collects Negima! Volumes 37-38.</p>",
      expected: onlyCovering(["37", "38"]),
    },
  ];

  it.each(WIRING.map((row) => [`${row.name}: ${row.book.title}`, row] as const))("%s", async (_, row) => {
    const { book, blurb, expected } = row;
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([{ ...book, blurb }]);
    await sync(t);
    expect(await placed(t)).toEqual(expected);
  });

  // An observation stored before the parser marked gapped lists, left
  // unplaced by an older planner, replays (R13) from its stored snapshot:
  // the replay reads its packaging from today's parse, never the stale one.
  it("a replayed snapshot stored before the gap was marked still never widens", async () => {
    const t = makeT();
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
    expect(await placed(t)).toEqual(UNMAPPED);
  });

  // "Part N, Vol. M" is Volume M of the Part: no packaging, no Volume N.
  it("a title Alpha: Part 5, Vol. 6 is one Volume of its Part, never packaging", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const title = "Alpha: Part 5, Vol. 6";
    stubSite([{ ...THREE_IN_1, slug: "alpha-part", seriesSlug: "alpha-part", seriesTitle: undefined, title }]);
    await sync(t);
    expect(await placed(t)).toEqual(onlyCovering(["6"]));
    await t.run(async (ctx) => {
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(0);
    });
  });
});

// Mature evidence (lib/mature.ts) from the book page: its age rating and its
// imprint, read on real pages (lib/__fixtures__/sevenSeas), reaching the
// Series and what the home page and the library show at once.
describe("sevenSeas.sync — mature evidence from the book page", () => {
  const savedPage = (name: string) =>
    readFileSync(new URL(`./lib/__fixtures__/sevenSeas/${name}.html`, import.meta.url), "utf8");

  /** Steamship's "His Sensual Whisper" Vol. 1: its page names the imprint and the Mature badge. */
  const WHISPER_1: FixtureBook = {
    id: 201,
    slug: "his-sensual-whisper-the-voice-that-sets-me-on-fire-vol-1",
    title: "His Sensual Whisper: The Voice That Sets Me On Fire Vol. 1",
    modified: "2025-08-01T00:00:00",
    page: savedPage("his-sensual-whisper-vol-1"),
  };
  /** Ghost Ship's "Peter Grill" Vol. 15: its page names the imprint and a 17+ badge. */
  const PETER_GRILL_15: FixtureBook = {
    id: 202,
    slug: "peter-grill-and-the-philosophers-time-vol-15",
    title: "Peter Grill and the Philosopher&#8217;s Time Vol. 15",
    modified: "2025-10-01T00:00:00",
    page: savedPage("peter-grill-vol-15"),
  };
  const ALPHA_3: FixtureBook = {
    ...ALPHA_2,
    id: 104,
    slug: "alpha-manga-vol-3",
    title: "Alpha Adventures (Manga) Vol. 3",
    isbn: "978-1-9990001-2-7",
  };

  /** The Series of the Release a book's observation is linked to. */
  const seriesOf = (t: TestT, b: FixtureBook) =>
    t.run(async (ctx) => {
      const { recordRef } = (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", String(b.id)),
        )
        .unique())!;
      if (recordRef?.type !== "release") throw new Error("not linked to a Release");
      const release = (await ctx.db.get(recordRef.id))!;
      return { release, series: (await ctx.db.get(release.seriesIds[0]!))! };
    });

  /**
   * Turn a book's stored snapshot into one an older parser took: no parser
   * version, rating or imprint, and `mature` from the badge alone.
   */
  const ageSnapshot = (t: TestT, b: FixtureBook, mature: boolean) =>
    t.run(async (ctx) => {
      const observation = (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "sevenseas").eq("sourceRecordId", String(b.id)),
        )
        .unique())!;
      const stored: BookSnapshot = observation.snapshot;
      const { parserVersion, ageRating, imprint, ...older } = stored;
      expect(parserVersion).toBe(1);
      expect(imprint !== undefined || ageRating !== undefined).toBe(b.page !== undefined);
      await ctx.db.patch(observation._id, { snapshot: { ...older, mature } });
    });

  const rebuild = (t: TestT) => t.action(internal.seriesBrowse.rebuild, {});

  /**
   * Where a viewer who has not opted in sees the Series: the library (both
   * paths), its facets, and the home page's pools.
   */
  async function shownTo(t: TestT, title: string, month: { year: number; month: number }) {
    const titles = (items: Array<{ title: string }>) => items.some((item) => item.title === title);
    const word = title.split(" ")[0]!.toLowerCase();
    return {
      library: titles(
        (await t.query(api.seriesBrowse.browse, { sort: "title", showMature: false })).items,
      ),
      filtered: titles(
        (await t.query(api.seriesBrowse.browse, { sort: "title", q: word, showMature: false }))
          .items,
      ),
      facets: (await t.query(api.seriesBrowse.facets, { showMature: false })).total,
      newest: titles(await t.query(api.catalog.recentSeries, { limit: 28, showMature: false })),
      month: (
        await t.query(api.releases.monthBrowse, { ...month, showMature: false })
      ).releases.some((row) => row.series.some((series) => series.title === title)),
    };
  }

  it("a Steamship book filed under Seven Seas makes its Series mature at once", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // The page without its Mature badge: the imprint alone is the evidence.
    const page = WHISPER_1.page!.replace('<div class="age-rating" id="mature"></div>', "");
    expect(page).not.toBe(WHISPER_1.page);
    stubSite([{ ...WHISPER_1, page }]);
    await sync(t);

    const { release, series } = await seriesOf(t, WHISPER_1);
    const sevenSeas = await t.run((ctx) =>
      ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "seven-seas"))
        .unique(),
    );
    expect(release.publisherId).toBe(sevenSeas!._id);
    expect(series.mature).toBe(true);
    expect((await observationOf(t, WHISPER_1)).snapshot).toMatchObject({
      mature: true,
      imprint: "Steamship",
      parserVersion: 1,
    });
    expect((await observationOf(t, WHISPER_1)).snapshot.ageRating).toBeUndefined();
    await rebuild(t);
    expect((await seriesOf(t, WHISPER_1)).series.mature).toBe(true);
  });

  it("a mature page linking a listed Series' Release hides it from home and the library at once", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const title = "His Sensual Whisper: The Voice That Sets Me On Fire";
    await insertCatalogRelease(t, title, { isbn13: "9798893739404", pubDate: pubDate(20250909) });
    await rebuild(t);
    const month = { year: 2025, month: 9 };
    expect(await shownTo(t, title, month)).toEqual({
      library: true,
      filtered: true,
      facets: 1,
      newest: true,
      month: true,
    });

    stubSite([WHISPER_1]);
    await sync(t);
    const { series } = await seriesOf(t, WHISPER_1);
    expect(series.title).toBe(title);
    expect(series.mature).toBe(true);
    // No rebuild in between.
    expect(await shownTo(t, title, month)).toEqual({
      library: false,
      filtered: false,
      facets: 0,
      newest: false,
      month: false,
    });
  });

  it("re-reads a page an older parser rated false, corrects it, and then leaves it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([PETER_GRILL_15]);
    await sync(t);
    // The older parser read only the 17+ badge: not mature. The rebuild
    // derives the Series from that, and it is listed.
    await ageSnapshot(t, PETER_GRILL_15, false);
    await rebuild(t);
    const title = "Peter Grill and the Philosopher’s Time";
    const month = { year: 2025, month: 10 };
    expect((await seriesOf(t, PETER_GRILL_15)).series.mature).toBeUndefined();
    expect(await shownTo(t, title, month)).toMatchObject({
      library: true,
      newest: true,
      month: true,
    });

    // The listing is unchanged; the stored snapshot's parser is not.
    stubSite([PETER_GRILL_15]);
    let pages = countBookPages();
    expect(await sync(t)).toMatchObject({ completeSweep: true, errorCount: 0 });
    expect(pages.count).toBe(1);
    expect((await observationOf(t, PETER_GRILL_15)).snapshot).toMatchObject({
      mature: true,
      ageRating: "olderteen17",
      imprint: "Ghost Ship",
      parserVersion: 1,
    });
    expect((await seriesOf(t, PETER_GRILL_15)).series.mature).toBe(true);
    expect(await shownTo(t, title, month)).toEqual({
      library: false,
      filtered: false,
      facets: 0,
      newest: false,
      month: false,
    });

    // Read with the current parser: the next sync fetches nothing and writes nothing.
    const history = () =>
      t.run(async (ctx) => (await ctx.db.query("observationSnapshots").collect()).length);
    const before = await history();
    stubSite([PETER_GRILL_15]);
    pages = countBookPages();
    expect(await sync(t)).toMatchObject({ recordsChanged: 0, completeSweep: true });
    expect(pages.count).toBe(0);
    expect(await history()).toBe(before);
  });

  it("re-reads old pages within the detail budget, new books first, until none is left", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1, ALPHA_2]);
    await sync(t);
    await ageSnapshot(t, ALPHA_1, false);
    await ageSnapshot(t, ALPHA_2, false);

    // Listed newest-modified first, as the site lists them.
    const listed = [ALPHA_3, ALPHA_1, ALPHA_2];
    const read = async () => {
      stubSite(listed);
      const requests: string[] = [];
      const site = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith(`${BASE}/books/`)) requests.push(String(input));
        return site(input, init);
      });
      const result = await sync(t, { maxDetailFetches: 2 });
      return { result, pages: requests.map((url) => url.split("/")[4]) };
    };
    expect(await read()).toMatchObject({
      result: { completeSweep: false },
      pages: [ALPHA_3.slug, ALPHA_1.slug],
    });
    expect(await read()).toMatchObject({ result: { completeSweep: true }, pages: [ALPHA_2.slug] });
    expect(await read()).toMatchObject({ result: { completeSweep: true }, pages: [] });
    for (const b of listed) {
      expect((await observationOf(t, b)).snapshot.parserVersion).toBe(1);
    }
  });

  it("never overrides the Data Team's call, in either direction", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Rated general, then a page that rates the book Mature.
    const general = { ...ALPHA_1, modified: "2026-08-01T00:00:00" };
    stubSite([general]);
    await sync(t);
    const quiet = (await seriesOf(t, general)).series;
    await t.run((ctx) => ctx.db.patch(quiet._id, { contentRating: "general" }));
    const rated = bookPageHtml(general).replace(
      '<div id="volume-meta">',
      '<div class="age-rating" id="mature"></div><div id="volume-meta">',
    );
    stubSite([{ ...general, modified: "2026-08-02T00:00:00", page: rated }]);
    await sync(t);
    expect((await observationOf(t, general)).snapshot.mature).toBe(true);
    expect((await seriesOf(t, general)).series.mature).toBeUndefined();
    await rebuild(t);
    expect((await seriesOf(t, general)).series.mature).toBeUndefined();

    // Rated mature, then a page that rates the book Teen.
    await t.run((ctx) => ctx.db.patch(quiet._id, { contentRating: "mature", mature: true }));
    const teen = rated.replace('id="mature"', 'id="teen"');
    stubSite([{ ...general, modified: "2026-08-03T00:00:00", page: teen }]);
    await sync(t);
    expect((await observationOf(t, general)).snapshot).toMatchObject({
      mature: false,
      ageRating: "teen",
    });
    expect((await seriesOf(t, general)).series.mature).toBe(true);
    await rebuild(t);
    expect((await seriesOf(t, general)).series.mature).toBe(true);
  });
});
