// Kodansha adapter tests (ticket #36): the whole import path run against a
// stubbed kodansha.us serving fixture responses in the live wire shapes —
// no network. Covers the ticket's acceptance criterion for this source:
// fetch → observations → reconciliation → canonical records/Proposals, with
// the per-format split sharing one Edition, steady-state gates, and covers.
// The backlist crawl runs against trimmed live pages (lib/__fixtures__).

import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const BASE = "https://kodansha.us";

type FixtureVolume = {
  series: string;
  seriesSlug: string;
  volume: number;
  date: string;
  formats: string[];
};

function calendarPayload(volumes: FixtureVolume[]) {
  const buckets = new Map<string, FixtureVolume[]>();
  for (const vol of volumes) {
    buckets.set(vol.date, [...(buckets.get(vol.date) ?? []), vol]);
  }
  return {
    success: true,
    data: [...buckets.entries()].map(([date, items]) => ({
      tue_key: date,
      date_label: `Published on ${date}`,
      is_past: false,
      items: items.map((vol) => ({
        title: `Volume ${vol.volume}`,
        series_name: vol.series,
        creators: "By Someone",
        image: `https://production.image.azuki.co/${vol.seriesSlug}-${vol.volume}/800.webp`,
        volume_url: `${BASE}/series/${vol.seriesSlug}/volume-${vol.volume}/`,
        formats: vol.formats,
      })),
    })),
  };
}

function stubSite(volumes: FixtureVolume[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.startsWith(`${BASE}/wp-json/kodansha/v1/release-calendar`)) {
      return new Response(JSON.stringify(calendarPayload(volumes)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(`${BASE}/wp-json/kodansha/v1/new-releases`)) {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("azuki.co")) {
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

function makeT() {
  return convexTest(schema);
}
type TestT = ReturnType<typeof makeT>;

async function seedRegistry(t: TestT, bootstrap: boolean) {
  await t.mutation(internal.importSources.seedRegistry, {});
  await t.mutation(internal.importSources.setBootstrapModeInternal, {
    on: bootstrap,
  });
}

const sync = (t: TestT) =>
  t.action(internal.kodansha.sync, { politeDelayMs: 0 });

const IRUMA: FixtureVolume = {
  series: "Welcome to Demon School! Iruma-kun",
  seriesSlug: "welcome-to-demon-school-iruma-kun",
  volume: 21,
  date: "2026-08-04",
  formats: ["digital", "print"],
};

describe("kodansha.sync — Bootstrap Mode creation path", () => {
  it("creates one Edition with sibling print+digital Releases, cited and covered", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([IRUMA]);

    const result = await sync(t);
    expect(result).toMatchObject({
      recordsSeen: 2, // one per format
      recordsChanged: 2,
      errorCount: 0,
    });

    await t.run(async (ctx) => {
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["kodansha"]);
      const series = await ctx.db.query("series").collect();
      expect(series).toHaveLength(1);
      expect(series[0]!).toMatchObject({
        title: "Welcome to Demon School! Iruma-kun",
        bootstrapUnreviewed: true,
      });
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes).toHaveLength(1);
      expect(volumes[0]!).toMatchObject({ label: "21", position: 21 });
      // The format sibling shares the first release's Edition (spec §2).
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      expect(new Set(releases.map((r) => r.format))).toEqual(
        new Set(["physical", "digital"]),
      );
      for (const release of releases) {
        expect(release.editionId).toBe(editions[0]!._id);
        expect(release.pubDate).toEqual({
          year: 2026,
          month: 8,
          day: 4,
          sort: 20260804,
        });
        expect(release.coverImage).toBeDefined();
        expect(release.coverImage!.attribution).toContain("Kodansha");
      }
      // Importer-authored public Revisions cite source name + record URL.
      const revisions = await ctx.db.query("revisions").collect();
      const releaseRevisions = revisions.filter((r) => r.ref.type === "release");
      expect(releaseRevisions.length).toBe(2);
      for (const revision of releaseRevisions) {
        expect(revision.author).toEqual({ kind: "source", sourceKey: "kodansha" });
        expect(revision.citation).toMatchObject({
          sourceName: "Kodansha USA",
          url: `${BASE}/series/welcome-to-demon-school-iruma-kun/volume-21/`,
        });
      }
      // Observations linked per (volume, format).
      const observations = await ctx.db.query("sourceObservations").collect();
      const volumeObs = observations.filter((o) =>
        o.sourceRecordId.includes("#"),
      );
      expect(volumeObs).toHaveLength(2);
      expect(volumeObs.every((o) => o.recordRef?.type === "release")).toBe(true);
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs[0]!).toMatchObject({ status: "succeeded", recordsSeen: 2 });
    });
  });

  it("bumps last-seen only on an unchanged second run", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([IRUMA]);
    await sync(t);
    const before = await t.run((ctx) => ctx.db.query("revisions").collect());
    await sync(t);
    await t.run(async (ctx) => {
      const after = await ctx.db.query("revisions").collect();
      expect(after).toHaveLength(before.length);
      expect(await ctx.db.query("observationSnapshots").collect()).toHaveLength(0);
      expect(await ctx.db.query("releases").collect()).toHaveLength(2);
    });
  });

  it("reconciles a shifted date on a linked release at authoritative rank", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([IRUMA]);
    await sync(t);
    vi.unstubAllGlobals();
    stubSite([{ ...IRUMA, date: "2026-08-11" }]);
    await sync(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      for (const release of releases) {
        expect(release.pubDate!.sort).toBe(20260811);
      }
      // The prior snapshot is retained append-only (one per format).
      expect(
        await ctx.db.query("observationSnapshots").collect(),
      ).toHaveLength(2);
    });
  });
});

describe("kodansha.sync — steady state", () => {
  it("queues a pre-filled In-Review proposal for a brand-new series, once", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    stubSite([{ ...IRUMA, formats: ["print"] }]);
    await sync(t);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!).toMatchObject({
        state: "inReview",
        author: { kind: "source", sourceKey: "kodansha" },
      });
      const versions = await ctx.db.query("proposalVersions").collect();
      expect(versions).toHaveLength(1);
      const tables = versions[0]!.ops.map((op) =>
        op.kind === "create" ? op.table : op.kind,
      );
      expect(tables).toEqual(["series", "volumes", "editions", "releases"]);
    });
  });
});

// A work an Editor hid never comes back through the calendar: neither as a
// queued proposal (steady state) nor as a created Series (Bootstrap Mode).
describe("kodansha.sync — hidden Series stay hidden", () => {
  for (const bootstrap of [false, true]) {
    it(`records the volume on its observation only (${bootstrap ? "Bootstrap Mode" : "steady state"})`, async () => {
      const t = makeT();
      await seedRegistry(t, bootstrap);
      await t.run((ctx) =>
        ctx.db.insert("series", {
          status: "hidden",
          publicId: 14761,
          title: IRUMA.series,
          altTitles: [],
          searchText: IRUMA.series,
        }),
      );
      stubSite([{ ...IRUMA, formats: ["print"] }]);
      await sync(t);
      await sync(t);
      await t.run(async (ctx) => {
        expect((await ctx.db.query("series").collect()).map((s) => s.status)).toEqual(["hidden"]);
        expect(await ctx.db.query("proposals").collect()).toHaveLength(0);
        expect(await ctx.db.query("releases").collect()).toHaveLength(0);
        const volumeObs = (await ctx.db.query("sourceObservations").collect()).filter(
          (o) => !o.sourceRecordId.startsWith("series:"),
        );
        expect(volumeObs.length).toBeGreaterThan(0);
        for (const obs of volumeObs) {
          expect(obs.recordRef).toBeUndefined();
          expect(obs.conflicts?.find((c) => c.field === "placement")?.reason).toContain(
            "Series 14761",
          );
        }
      });
    });
  }
});

// The Kodansha-created duplicates of the audit: an unlinked slug resolves
// the base Series by title before ever creating one, packaging series pages
// map onto their base Series, and Vertical's books stay Vertical's.
describe("kodansha.sync — series resolution and publishers", () => {
  async function backbone(
    t: TestT,
    title: string,
    labels: string[],
    publisher?: { name: string; slug: string },
  ) {
    return await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title,
        altTitles: [],
        searchText: title,
      });
      const publisherId = publisher
        ? await ctx.db.insert("publishers", { status: "active", ...publisher })
        : null;
      for (const label of labels) {
        const volumeId = await ctx.db.insert("volumes", {
          status: "active",
          publicId: Number(label),
          seriesId,
          position: Number(label),
          label,
        });
        if (publisherId === null) continue;
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: Number(label),
          publisherId,
        });
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId,
          order: 1,
          extent: "complete",
        });
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          language: "en",
          publisherId,
          seriesIds: [seriesId],
        });
      }
      return seriesId;
    });
  }

  it("adds a volume to the existing same-titled Series instead of creating one", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const spaceBrothers = await backbone(t, "Space Brothers", ["1", "28"]);
    stubSite([
      {
        series: "Space Brothers",
        seriesSlug: "space-brothers",
        volume: 46,
        date: "2026-08-04",
        formats: ["print"],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id)).toEqual([spaceBrothers]);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.find((v) => v.label === "46")).toMatchObject({ position: 46 });
    });
  });

  it("strips the (Manga) discriminator before resolving the Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const strongest = await backbone(t, "Am I Actually the Strongest?", ["1"]);
    stubSite([
      {
        series: "Am I Actually the Strongest? (Manga)",
        seriesSlug: "am-i-actually-the-strongest-manga",
        volume: 19,
        date: "2026-08-04",
        formats: ["print"],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id)).toEqual([strongest]);
    });
  });

  it("maps a packaging series page onto its base Series, never a Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const blueLock = await backbone(t, "Blue Lock", ["4"]);
    stubSite([
      {
        series: "Blue Lock Omnibus",
        seriesSlug: "blue-lock-omnibus",
        volume: 4,
        date: "2026-08-04",
        formats: ["print"],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id)).toEqual([blueLock]);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock-omnibus/volume-4#physical",
      );
      expect(obs?.conflicts?.[0]).toMatchObject({ field: "placement" });
      // The packaging slug now links to the base Series for future runs.
      const link = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "series:blue-lock-omnibus",
      );
      expect(link?.recordRef).toEqual({ type: "series", id: blueLock });
    });
  });

  it("files a Vertical Series' new volume under Vertical, not Kodansha", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Kirio Fan Club", ["1", "2"], { name: "Vertical", slug: "vertical" });
    stubSite([
      {
        series: "Kirio Fan Club",
        seriesSlug: "kirio-fan-club",
        volume: 3,
        date: "2026-08-04",
        formats: ["print"],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const vertical = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "vertical"))
        .unique();
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(3);
      expect(releases.every((r) => r.publisherId === vertical!._id)).toBe(true);
      const kodansha = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "kodansha"))
        .unique();
      expect(kodansha).toBeNull();
    });
  });
});

// ---------- the backlist crawl ----------

const fixture = (name: string) =>
  readFileSync(new URL(`./lib/__fixtures__/kodansha/${name}`, import.meta.url), "utf8");

type ListedSeries = { slug: string; name: string; type?: string; stamp?: string };

const BLUE_LOCK: ListedSeries = { slug: "blue-lock", name: "Blue Lock" };
const NEEDLES: ListedSeries = { slug: "7-billion-needles", name: "7 Billion Needles" };
const OMNIBUS: ListedSeries = { slug: "blue-lock-omnibus", name: "Blue Lock Omnibus" };
const NOVEL: ListedSeries = { slug: "a-cops-eyes", name: "A Cop's Eyes", type: "novel" };

/** A series page in the live shape: JSON-LD hasPart only. */
function seriesPage(slug: string, name: string, volumes: string[]): string {
  const hasPart = volumes.map((volume) => ({
    "@type": "Book",
    url: `${BASE}/series/${slug}/${volume}/`,
  }));
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ComicSeries",
    name,
    hasPart,
  })}</script></head><body></body></html>`;
}

const requested: string[] = [];

/**
 * A stubbed kodansha.us for the crawl: the paged search-series listing,
 * series pages, and volume pages; everything else 404s. `pages` maps a
 * path ("series/blue-lock/volume-1/") to its HTML.
 */
function stubBacklist(listed: ListedSeries[], pages: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    requested.push(url);
    if (url.startsWith(`${BASE}/wp-json/kodansha/v1/search-series`)) {
      const params = new URL(url).searchParams;
      const offset = Number(params.get("offset") ?? 0);
      const count = Number(params.get("count") ?? 24);
      const rows = [...listed]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .slice(offset, offset + count)
        .map((row) => ({
          slug: row.slug,
          name: row.name,
          type: row.type ?? "comic",
          last_updated_at: row.stamp ?? "2026-02-06T09:53:10+00:00",
        }));
      return Response.json({ success: true, data: rows, count: rows.length, total_count: listed.length });
    }
    const html = pages[url.slice(`${BASE}/`.length)];
    return html !== undefined
      ? new Response(html, { headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 });
  });
}

const BACKLIST_PAGES: Record<string, string> = {
  "series/blue-lock/": seriesPage("blue-lock", "Blue Lock", ["volume-1", "volume-40"]),
  "series/blue-lock/volume-1/": fixture("blue-lock-volume-1.html"),
  "series/blue-lock/volume-40/": fixture("blue-lock-volume-40.html"),
  // The real page lists volumes 1–4; 2–4 are 404s here (a dead link).
  "series/7-billion-needles/": fixture("series-7-billion-needles.html"),
  "series/7-billion-needles/volume-1/": fixture("7-billion-needles-volume-1.html"),
  "series/blue-lock-omnibus/": seriesPage("blue-lock-omnibus", "Blue Lock Omnibus", ["volume-1"]),
  "series/blue-lock-omnibus/volume-1/": fixture("blue-lock-omnibus-volume-1.html"),
};

async function seedBacklist(t: TestT, bootstrap: boolean) {
  await seedRegistry(t, bootstrap);
  await t.mutation(internal.launch.seedPublishers, {});
}

const backlist = (t: TestT, args: object = {}) =>
  t.action(internal.kodansha.backlistSync, { politeDelayMs: 0, ...args });

afterEach(() => {
  requested.length = 0;
});

describe("kodansha.backlistSync — the crawl", () => {
  it("creates ISBN'd print + digital Releases from volume pages, never novels or covers", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    stubBacklist([BLUE_LOCK, NEEDLES, NOVEL], BACKLIST_PAGES);

    const result = await backlist(t);
    expect(result).toMatchObject({
      continued: false,
      seriesCrawled: 2,
      // 2 series pages + Blue Lock 1, 40 + Needles 1–4.
      fetched: 8,
      recordsSeen: 4,
    });
    expect(requested.some((u) => u.includes("a-cops-eyes"))).toBe(false);
    expect(requested.some((u) => u.includes("azuki.co"))).toBe(false);

    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      const byIsbn = new Map(releases.map((r) => [r.isbn13, r]));
      expect([...byIsbn.keys()].sort()).toEqual([
        "9781636990033", // Blue Lock 1 digital
        "9781646516544", // Blue Lock 1 paperback
        "9781939130242", // 7 Billion Needles 1 digital
        "9798898303303", // Blue Lock 40 digital
      ]);
      const print = byIsbn.get("9781646516544")!;
      expect(print).toMatchObject({
        format: "physical",
        binding: "paperback",
        pubDate: { year: 2022, month: 6, day: 21, sort: 20220621 },
        price: { amountCents: 1299, currency: "USD" },
      });
      // Print and digital of one volume share one Edition (spec §2).
      expect(byIsbn.get("9781636990033")!.editionId).toBe(print.editionId);
      expect(releases.every((r) => r.coverImage === undefined)).toBe(true);
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title).sort()).toEqual(["7 Billion Needles", "Blue Lock"]);

      // Crawl state per series, under the backlist's own registry key.
      const crawl = (await ctx.db.query("sourceObservations").collect()).filter(
        (o) => o.sourceKey === "kodansha-backlist",
      );
      const bySlug = new Map(crawl.map((o) => [o.sourceRecordId, o.snapshot]));
      expect(bySlug.get("blue-lock")).toMatchObject({
        kind: "kodanshaSeriesCrawl",
        volumes: ["volume-1", "volume-40"],
        recheck: ["volume-40"], // upcoming: dates may still move
      });
      // 404s are not re-checked weekly; they wait for the next full crawl.
      expect(bySlug.get("7-billion-needles")).toMatchObject({ recheck: [] });

      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ sourceKey: "kodansha-backlist", status: "succeeded" });
      expect(run!.errors.filter((e) => e.includes("HTTP 404"))).toHaveLength(3);
    });
  });

  it("links an existing Release by ISBN and files its digital sibling under the same Edition", async () => {
    const t = makeT();
    await seedBacklist(t, false);
    // A PRH-created paperback of Blue Lock 1 (no Kodansha observation yet).
    const printId = await t.run(async (ctx) => {
      const kodansha = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "kodansha"))
        .unique();
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Blue Lock",
        altTitles: [],
        searchText: "Blue Lock",
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
        publisherId: kodansha!._id,
      });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: "9781646516544",
        publisherId: kodansha!._id,
        seriesIds: [seriesId],
      });
    });
    stubBacklist([BLUE_LOCK], {
      ...BACKLIST_PAGES,
      "series/blue-lock/": seriesPage("blue-lock", "Blue Lock", ["volume-1"]),
    });

    await backlist(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      const print = releases.find((r) => r._id === printId)!;
      // Linked, and Kodansha's own facts reconciled in at authoritative rank.
      expect(print).toMatchObject({
        pubDate: { year: 2022, month: 6, day: 21, sort: 20220621 },
        price: { amountCents: 1299, currency: "USD" },
      });
      const digital = releases.find((r) => r._id !== printId)!;
      expect(digital).toMatchObject({ format: "digital", isbn13: "9781636990033" });
      expect(digital.editionId).toBe(print.editionId);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock/volume-1#physical",
      );
      expect(obs?.recordRef).toEqual({ type: "release", id: printId });
      // Steady state: the sibling needed no gate, so nothing queued.
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals.filter((p) => p.state === "inReview")).toHaveLength(0);
    });
  });

  it("fills the ISBN on a calendar-created Release, and the calendar never erases it", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    const volume40: FixtureVolume = {
      series: "Blue Lock",
      seriesSlug: "blue-lock",
      volume: 40,
      date: "2026-11-24",
      formats: ["digital"],
    };
    stubSite([volume40]);
    await sync(t);
    vi.unstubAllGlobals();
    stubBacklist([BLUE_LOCK], BACKLIST_PAGES);
    await backlist(t);
    vi.unstubAllGlobals();
    stubSite([volume40]);
    await sync(t);

    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      const forty = releases.filter((r) => r.pubDate?.sort === 20261124);
      // One Release, not a second one from the crawl, now carrying its ISBN.
      expect(forty).toHaveLength(1);
      expect(forty[0]).toMatchObject({
        format: "digital",
        isbn13: "9798898303303",
        price: { amountCents: 799, currency: "USD" },
      });
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock/volume-40#digital",
      );
      expect(obs?.snapshot).toMatchObject({ isbn13: "9798898303303", title: "Blue Lock Volume 40" });
    });
  });

  it("keeps the volume page's date when the calendar's bucket date differs", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    const onCalendar = (date: string): FixtureVolume => ({
      series: "Blue Lock",
      seriesSlug: "blue-lock",
      volume: 40,
      date,
      formats: ["digital"],
    });
    stubSite([onCalendar("2026-11-24")]);
    await sync(t);
    vi.unstubAllGlobals();
    stubBacklist([BLUE_LOCK], BACKLIST_PAGES);
    await backlist(t);
    vi.unstubAllGlobals();
    const pageDate = await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock/volume-40#digital",
      );
      return (obs?.snapshot as { releaseDate?: unknown }).releaseDate;
    });
    expect(pageDate).toBeDefined();
    // The calendar files the book under another day; the page's date stands.
    stubSite([onCalendar("2026-11-30")]);
    await sync(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock/volume-40#digital",
      );
      expect((obs?.snapshot as { releaseDate?: unknown }).releaseDate).toEqual(pageDate);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.some((r) => r.pubDate?.sort === 20261130)).toBe(false);
    });
  });

  it("never copies an ISBN another Release holds onto a calendar duplicate", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    const volume40: FixtureVolume = {
      series: "Blue Lock",
      seriesSlug: "blue-lock",
      volume: 40,
      date: "2026-11-24",
      formats: ["digital"],
    };
    stubSite([volume40]);
    await sync(t);
    // Meanwhile another source created the same book under its ISBN.
    const otherId = await t.run(async (ctx) => {
      const { _id, _creationTime, ...calendarRelease } = (await ctx.db.query("releases").collect())[0]!;
      return await ctx.db.insert("releases", { ...calendarRelease, isbn13: "9798898303303" });
    });
    vi.unstubAllGlobals();
    stubBacklist([BLUE_LOCK], BACKLIST_PAGES);
    await backlist(t);

    await t.run(async (ctx) => {
      const holders = (await ctx.db.query("releases").collect()).filter(
        (r) => r.isbn13 === "9798898303303",
      );
      expect(holders.map((r) => r._id)).toEqual([otherId]);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock/volume-40#digital",
      );
      expect(obs?.conflicts?.find((c) => c.field === "isbn13")?.reason).toContain(otherId);
    });
  });

  it("links a packaging volume by ISBN, else leaves it for an Editor", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    stubBacklist([OMNIBUS], BACKLIST_PAGES);
    await backlist(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock-omnibus/volume-1#physical",
      );
      expect(obs?.conflicts?.[0]).toMatchObject({ field: "placement" });
    });

    // Once the omnibus exists (an Editor placed it, or PRH), the ISBN links it.
    const omnibusId = await t.run(async (ctx) => {
      const kodansha = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "kodansha"))
        .unique();
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Blue Lock",
        altTitles: [],
        searchText: "Blue Lock",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId: kodansha!._id,
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: "9798888778210",
        publisherId: kodansha!._id,
        seriesIds: [seriesId],
      });
    });
    // A changed listing stamp re-crawls the series whole.
    vi.unstubAllGlobals();
    stubBacklist([{ ...OMNIBUS, stamp: "2026-09-20T00:00:00+00:00" }], BACKLIST_PAGES);
    await backlist(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "blue-lock-omnibus/volume-1#physical",
      );
      expect(obs?.recordRef).toEqual({ type: "release", id: omnibusId });
      expect((await ctx.db.get(omnibusId))!.pubDate?.sort).toBe(20260224);
    });
  });
});

describe("Kodansha scope gate — both feeds", () => {
  // A picture-book volume page in the live shape (the Cells at Work! picture
  // books a scope repair had to hide).
  const PICTURE_BOOK = fixture("blue-lock-volume-1.html")
    .replaceAll("blue-lock/volume-1", "cells-at-work-picture-book/volume-5")
    .replaceAll("blue-lock", "cells-at-work-picture-book")
    .replace('"name": "Blue Lock Volume 1"', '"name": "Cells at Work! Picture Book 5"')
    .replace('"name": "Blue Lock"', '"name": "Cells at Work! Picture Book"');

  it("the calendar observes novels and picture books but never places them", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([
      {
        series: "Cells at Work! Picture Book",
        seriesSlug: "cells-at-work-picture-book",
        volume: 5,
        date: "2026-08-04",
        formats: ["print"],
      },
      {
        series: "The Seven Deadly Sins (Novel)",
        seriesSlug: "the-seven-deadly-sins-novel",
        volume: 3,
        date: "2026-08-04",
        formats: ["digital"],
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 2, errorCount: 0 });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("proposals").collect()).toHaveLength(0);
      const observed = (await ctx.db.query("sourceObservations").collect()).map((o) => [
        o.sourceRecordId,
        (o.snapshot as { outOfScope?: string }).outOfScope,
        o.recordRef,
      ]);
      expect(observed.sort()).toEqual([
        ["cells-at-work-picture-book/volume-5#physical", "childrensBook", undefined],
        ["the-seven-deadly-sins-novel/volume-3#digital", "novel", undefined],
      ]);
    });
  });

  it("the crawl observes a picture book, even one a scope repair hid, and never recreates it", async () => {
    const t = makeT();
    await seedBacklist(t, false);
    // The scope repair hid the earlier picture-book Series.
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 9,
        title: "Cells at Work! Picture Book",
        altTitles: [],
        searchText: "Cells at Work! Picture Book",
      });
    });
    const listed = { slug: "cells-at-work-picture-book", name: "Cells at Work! Picture Book" };
    stubBacklist([listed], {
      "series/cells-at-work-picture-book/": seriesPage(listed.slug, listed.name, ["volume-5"]),
      "series/cells-at-work-picture-book/volume-5/": PICTURE_BOOK,
    });
    expect(await backlist(t)).toMatchObject({ recordsSeen: 2, seriesCrawled: 1 });
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.status)).toEqual(["hidden"]);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("proposals").collect()).toHaveLength(0);
      const volumeObs = (await ctx.db.query("sourceObservations").collect()).filter(
        (o) => o.sourceKey === "kodansha",
      );
      expect(volumeObs.map((o) => (o.snapshot as { outOfScope?: string }).outOfScope)).toEqual([
        "childrensBook",
        "childrensBook",
      ]);
    });
  });

  it("an out-of-scope snapshot never reconciles onto a Release an earlier run linked", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const cells: FixtureVolume = {
      series: "Cells at Work! Picture Book",
      seriesSlug: "cells-at-work-picture-book",
      volume: 4,
      date: "2026-08-04",
      formats: ["print"],
    };
    // Simulate the pre-gate import: the observation already links a Release.
    const releaseId = await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha",
        slug: "kodansha",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "hidden",
        publicId: 1,
        title: "Cells at Work! Picture Book",
        altTitles: [],
        searchText: "Cells at Work! Picture Book",
      });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 1, publisherId });
      const id = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("sourceObservations", {
        sourceKey: "kodansha",
        sourceRecordId: "cells-at-work-picture-book/volume-4#physical",
        snapshot: {},
        recordRef: { type: "release", id },
        lastSeenAt: 0,
        withdrawn: false,
      });
      return id;
    });
    stubSite([cells]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId))!.pubDate).toBeUndefined();
      expect((await ctx.db.get(releaseId))!.coverImage).toBeUndefined();
      expect(await ctx.db.query("revisions").collect()).toHaveLength(0);
    });
  });
});

describe("kodansha.backlistSync — incremental and resumable", () => {
  it("skips fresh series, re-checks moving volumes a week on, and chains under one run", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    stubBacklist([BLUE_LOCK, NEEDLES, NOVEL], BACKLIST_PAGES);

    // A one-fetch budget: each link finishes the series it started, then chains.
    const first = await backlist(t, { maxFetches: 1 });
    expect(first).toMatchObject({ continued: true, seriesCrawled: 1 });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "succeeded", recordsSeen: 4 });
      expect(await ctx.db.query("releases").collect()).toHaveLength(4);
    });

    // Nothing is due right after: only the listing is read.
    requested.length = 0;
    const again = await backlist(t);
    expect(again).toMatchObject({ fetched: 0, seriesCrawled: 0 });
    expect(requested.every((u) => u.includes("/wp-json/kodansha/v1/search-series"))).toBe(true);

    // A week on, only Blue Lock's upcoming volume is re-checked.
    await t.run(async (ctx) => {
      for (const obs of await ctx.db.query("sourceObservations").collect()) {
        if (obs.sourceKey === "kodansha-backlist") {
          await ctx.db.patch(obs._id, { lastSeenAt: obs.lastSeenAt - 7 * 24 * 60 * 60 * 1000 });
        }
      }
    });
    requested.length = 0;
    const week = await backlist(t);
    expect(week).toMatchObject({ fetched: 2, seriesCrawled: 1 });
    expect(requested.filter((u) => !u.includes("search-series"))).toEqual([
      `${BASE}/series/blue-lock/`,
      `${BASE}/series/blue-lock/volume-40/`,
    ]);
  });

  it("does nothing while its registry row is disabled", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "kodansha-backlist",
      enabled: false,
    });
    stubBacklist([BLUE_LOCK], BACKLIST_PAGES);
    expect(await backlist(t)).toEqual({ skipped: "disabled" });
    expect(requested).toHaveLength(0);
  });

  it("runs on its own row: a disabled daily window does not stop the crawl", async () => {
    const t = makeT();
    await seedBacklist(t, true);
    await t.mutation(internal.importSources.setEnabledInternal, { key: "kodansha", enabled: false });
    stubBacklist([NEEDLES], BACKLIST_PAGES);
    expect(await backlist(t)).toMatchObject({ recordsSeen: 1, recordsChanged: 1 });
    expect(await sync(t)).toEqual({ skipped: "disabled" });
  });
});
