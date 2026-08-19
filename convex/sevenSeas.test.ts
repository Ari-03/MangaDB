// Seven Seas adapter tests (ticket #34): the whole import path run against
// a stubbed site serving fixture responses in the live wire shapes — no
// network. Covers the acceptance criteria end to end: canonical records
// with cited public Revisions, observation identity + latest snapshot +
// append-only history, last-seen-only bumps, Bootstrap Mode tagging, the
// steady-state review queue, covers in file storage, and withdrawal.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
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
};

function bookPageHtml(b: FixtureBook): string {
  const cover =
    b.cover === false
      ? ""
      : `<img src="${BASE}/wp-content/uploads/covers/${b.slug}.jpg" title="${b.title}" alt="${b.title}">`;
  const series = b.seriesSlug
    ? `<b>Series: </b><span> <a href="${BASE}/series/${b.seriesSlug}/">${b.seriesTitle ?? b.title}</a></span>`
    : "";
  return `<html><body><div id="volume-module">${cover}</div><div id="volume-meta"> ${series}<p><b>Story & Art by:</b> <span class="creator"><a href="${BASE}/creator/someone/">Someone</a></span></p>${
    b.date ? `<p><b>Release Date:</b> ${b.date}</p>` : ""
  }${b.price ? `<p><b>Price:</b> ${b.price}</p>` : ""}<p><b>Format:</b> ${
    b.category ?? "Manga"
  }</p>${b.isbn ? `<p><b>ISBN:</b> ${b.isbn}</p>` : ""}</div></body></html>`;
}

/** Stub global fetch with a fixture site serving the live wire shapes. */
function stubSite(books: FixtureBook[]) {
  const listing = books.map((b) => ({
    id: b.id,
    status: "publish",
    slug: b.slug,
    link: `${BASE}/books/${b.slug}/`,
    title: { rendered: b.title },
    modified_gmt: b.modified ?? "2026-08-01T00:00:00",
    content: { rendered: "" },
  }));
  const pages = new Map(
    books.map((b) => [`${BASE}/books/${b.slug}/`, bookPageHtml(b)]),
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.startsWith(`${BASE}/wp-json/wp/v2/books`)) {
      return new Response(JSON.stringify(listing), {
        headers: {
          "x-wp-totalpages": "1",
          "content-type": "application/json",
        },
      });
    }
    const page = pages.get(url);
    if (page !== undefined) {
      return new Response(page, { headers: { "content-type": "text/html" } });
    }
    if (url.includes("/wp-content/uploads/")) {
      return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedRegistry(
  t: ReturnType<typeof convexTest>,
  bootstrap: boolean,
) {
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
      expect(series[0]).toMatchObject({
        title: "Alpha Adventures (Manga)",
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
      // Marketing copy is never imported into canonical records (spec §6).
      expect(vol1Release.description).toBeUndefined();

      // Vol. 2 landed under an already-linked Series — steady state would
      // have auto-created it, so it carries no bootstrap tag.
      const vol2Release = releases.find((r) => r.isbn13 === "9781999000110")!;
      expect(vol2Release.bootstrapUnreviewed).toBeUndefined();

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
      expect(
        revisions[0]!.changes.map((c) => c.field).sort(),
      ).toContain("pubDate");

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
      expect(seriesObs?.recordRef).toEqual({ type: "series", id: series[0]!._id });

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

describe("sevenSeas.sync — observations over repeated runs", () => {
  it("bumps last-seen only on an unchanged fetch", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      ),
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

  it("keeps append-only history and auto-updates authoritative fields on change", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);

    // The source moves the date: modified_gmt bumps, the page changes.
    stubSite([
      { ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsChanged: 1 });

    await t.run(async (ctx) => {
      const history = await ctx.db.query("observationSnapshots").collect();
      expect(history).toHaveLength(1);
      expect(
        (history[0]!.snapshot as { releaseDate: { month: number } }).releaseDate
          .month,
      ).toBe(1); // the superseded snapshot, retained append-only

      const release = (await ctx.db.query("releases").collect())[0]!;
      expect(release.pubDate).toMatchObject({ month: 2, day: 3, sort: 20260203 });

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

    stubSite([
      { ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      // The canonical value stands; the conflicting value is still recorded
      // on the observation's latest snapshot.
      expect(release.pubDate?.sort).toBe(20260106);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(
        (obs.snapshot as { releaseDate: { month: number } }).releaseDate.month,
      ).toBe(2);
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
        expect(version.ops.map((op) => op.kind)).toEqual([
          "create",
          "create",
          "create",
          "create",
        ]);
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
        (await ctx.db.query("proposals").collect()).filter(
          (p) => p.state === "inReview",
        ),
      ).toHaveLength(0);
    });
  });
});

describe("sevenSeas.sync — ISBN matching rung", () => {
  const insertCatalogRelease = async (
    t: ReturnType<typeof convexTest>,
    seriesTitle: string,
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
        isbn13: "9781999000103",
        publisherId,
        seriesIds: [seriesId],
      });
    });

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

describe("sevenSeas.sync — failure handling", () => {
  it("logs a failed run and counts toward source health", async () => {
    const t = convexTest(schema);
    await seedRegistry(t, true);
    vi.stubGlobal(
      "fetch",
      async () => new Response("gone", { status: 404 }),
    );
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
