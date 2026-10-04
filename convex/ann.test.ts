// ANN adapter tests (ticket #36): the weekly mirror and the release-page
// pass, run against a stubbed ANN serving fixture XML/HTML in the live wire
// shapes — no network. Covers the series-structured Series/Volume backbone
// (the mirror itself never creates Editions/Releases), ISBN- and
// label-based release-line linking with date reconciliation at standard
// authority, the release-page pass's leaf creation and hold rules, the
// steady-state new-Series gate, chained continuation, withdrawal, and the
// 1 req/s etiquette default.

import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  type CatalogOverrides,
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
  seedCatalog,
} from "./test.factories";
import { linkObservation } from "./lib/observations";
import { drain, expectStampedAtHandOff, makeT, seedRegistry, type TestT } from "./test.helpers";

type FixtureRelease = {
  annId: number;
  date: string;
  designator: string;
  ean?: string;
  /** The line title when it differs from the manga title (variants). */
  title?: string;
};
type FixtureManga = {
  id: number;
  title: string;
  /** The report row's type; defaults to "manga". */
  type?: string;
  altTitles?: Array<{ lang: string; text: string }>;
  /** The Plot Summary's XML text (already escaped, as ANN serves it). */
  plot?: string;
  releases: FixtureRelease[];
  /** Staff rows; defaults to one "Story & Art" person. */
  staff?: Array<{ id: number; name: string; task?: string }>;
};

function reportXml(manga: FixtureManga[], nskip: number, nlist: number) {
  const page = manga.slice(nskip, nskip + nlist);
  const items = page
    .map(
      (m) =>
        `<item><id>${m.id}</id><gid>1</gid><type>${m.type ?? "manga"}</type><name>${m.title}</name><precision>manga</precision></item>`,
    )
    .join("\n");
  return `<report skipped="${nskip}" listed="${page.length}"><args><type>manga</type></args>\n${items}</report>`;
}

function apiXml(manga: FixtureManga[], ids: string[]) {
  const blocks = ids
    .map((id) => {
      const m = manga.find((entry) => String(entry.id) === id);
      if (!m) return `<warning>no result for manga=${id}</warning>`;
      const alts = (m.altTitles ?? [])
        .map(
          (alt) => `<info gid="2" type="Alternative title" lang="${alt.lang}">${alt.text}</info>`,
        )
        .join("\n");
      const releases = m.releases
        .map(
          (r) =>
            `<release date="${r.date}" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${r.annId}"${r.ean ? ` ean="${r.ean}"` : ""}>${r.title ?? m.title} (${r.designator})</release>`,
        )
        .join("\n");
      const plot = m.plot !== undefined ? `<info gid="4" type="Plot Summary">${m.plot}</info>` : "";
      return `<manga id="${m.id}" gid="1" type="manga" name="${m.title}" precision="manga">
<info gid="1" type="Main title" lang="EN">${m.title}</info>
${alts}
${plot}
${releases}
${(m.staff ?? [{ id: 1, name: "Some One" }])
  .map((p) => `<staff gid="3"><task>${p.task ?? "Story &amp; Art"}</task><person id="${p.id}">${p.name}</person></staff>`)
  .join("\n")}</manga>`;
    })
    .join("\n");
  return `<ann>${blocks}</ann>`;
}

const pageRequests: string[] = [];
const reportRequests: string[] = [];

/** Serves the report + API for `manga`, and release pages from `pages`. */
function stubAnn(manga: FixtureManga[], pages: Record<number, string> = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.includes("/encyclopedia/releases.php")) {
      const id = Number(new URL(url).searchParams.get("id"));
      pageRequests.push(String(id));
      const html = pages[id];
      return html !== undefined
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    }
    if (url.includes("/encyclopedia/reports.xml")) {
      reportRequests.push(url);
      const params = new URL(url).searchParams;
      const nskip = Number(params.get("nskip") ?? 0);
      const nlist = Number(params.get("nlist") ?? 50);
      return new Response(reportXml(manga, nskip, nlist), {
        headers: { "content-type": "text/xml" },
      });
    }
    if (url.includes("/encyclopedia/api.xml")) {
      const ids = new URL(url).searchParams.get("manga")?.split("/") ?? [];
      return new Response(apiXml(manga, ids), {
        headers: { "content-type": "text/xml" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  // A failed test must not leak a mocked clock or console into the next.
  vi.restoreAllMocks();
  vi.useRealTimers();
  pageRequests.length = 0;
  reportRequests.length = 0;
});

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.ann.sync, { politeDelayMs: 0, ...args });

/**
 * A publisher's book of Volumes the mirror built, as another source leaves
 * it: an Edition of its own under `publisherId` covering the mirrored
 * Series' Volumes `labels` in order, and its one Release.
 */
async function insertBook(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
  labels: string[],
  { release, extent = "complete" }: { release?: CatalogOverrides["release"]; extent?: Doc<"volumeCoverages">["extent"] } = {},
) {
  const series = (await ctx.db.query("series").collect())[0]!;
  const volumes = await ctx.db.query("volumes").collect();
  const editionId = await insertEdition(ctx, { publisherId });
  for (const [i, label] of labels.entries()) {
    const volumeId = volumes.find((v) => v.label === label)!._id;
    await insertCoverage(ctx, { editionId, volumeId, order: i + 1, extent });
  }
  return await insertRelease(ctx, { editionId, publisherId, seriesIds: [series._id], ...release });
}

const ALPHA: FixtureManga = {
  id: 100,
  title: "Alpha Saga",
  altTitles: [
    { lang: "JA", text: "アルファ・サーガ" },
    { lang: "IT", text: "La Saga Alfa" },
  ],
  releases: [
    { annId: 9001, date: "2026-01-06", designator: "GN 1" },
    { annId: 9002, date: "2026-05-12", designator: "GN 2" },
    { annId: 9003, date: "2026-01-06", designator: "eBook 1" },
    { annId: 9004, date: "2026-09-00", designator: "GN 3" },
  ],
};

const BETA: FixtureManga = {
  id: 200,
  title: "Beta Blade",
  releases: [{ annId: 9101, date: "2027", designator: "GN 1" }],
};

// A manga with no English book releases contributes nothing.
const GAMMA: FixtureManga = { id: 300, title: "Gamma (JP only)", releases: [] };

describe("ann.sync — the series-structured backbone (Bootstrap Mode)", () => {
  it("creates Series + Volumes with EN/JA alt titles, never Editions or Releases", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA, BETA, GAMMA]);

    const result = await sync(t);
    expect(result).toMatchObject({
      recordsSeen: 2,
      continued: false,
      errorCount: 0,
    });

    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title).sort()).toEqual(["Alpha Saga", "Beta Blade"]);
      const alpha = series.find((s) => s.title === "Alpha Saga")!;
      expect(alpha.bootstrapUnreviewed).toBe(true);
      expect(alpha.altTitles).toEqual(["アルファ・サーガ"]); // IT dropped
      // Volumes 1..3 (labels from GN and eBook lines, deduplicated).
      const volumes = (await ctx.db.query("volumes").collect()).filter(
        (v) => v.seriesId === alpha._id,
      );
      expect(volumes.map((v) => v.label).sort()).toEqual(["1", "2", "3"]);
      // The publisher-less source never fabricates packaging.
      expect(await ctx.db.query("editions").collect()).toHaveLength(0);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("publishers").collect()).toHaveLength(0);
      // Series observation linked; release observations retained unlinked.
      const observations = await ctx.db.query("sourceObservations").collect();
      const mangaObs = observations.find((o) => o.sourceRecordId === "manga:100")!;
      expect(mangaObs.recordRef?.type).toBe("series");
      const releaseObs = observations.filter((o) => o.sourceRecordId.startsWith("release:"));
      expect(releaseObs).toHaveLength(5);
      expect(releaseObs.every((o) => o.recordRef === undefined)).toBe(true);
      // Creation Revisions cite the Encyclopedia entry (ANN's license).
      const revisions = await ctx.db.query("revisions").collect();
      expect(revisions.length).toBeGreaterThan(0);
      for (const revision of revisions) {
        expect(revision.citation?.url).toContain("animenewsnetwork.com/encyclopedia/manga.php?id=");
      }
      // The mirror's run, plus the release-page pass it opened and queued.
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs.map((run) => run.status)).toEqual(["succeeded", "running"]);
    });
  });

  it("links release observations to canonical Releases and reconciles dates at standard authority", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA]);
    await sync(t);

    // Another source's records arrive: a publisher release of volume 1 with
    // no date, and a volume-2 release whose date an authoritative source set.
    const { releaseNoDate, releaseAuthDate } = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const pubDate = { year: 2026, month: 5, day: 19, sort: 20260519 };
      const releaseNoDate = await insertBook(ctx, publisherId, ["1"]);
      const releaseAuthDate = await insertBook(ctx, publisherId, ["2"], { release: { pubDate } });
      // Provenance: an authoritative source set volume 2's date.
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseAuthDate },
        sourceKey: "sevenseas",
        changes: [{ field: "pubDate", after: pubDate }],
        comment: "Imported from Seven Seas Entertainment.",
      });
      return { releaseNoDate, releaseAuthDate };
    });

    await sync(t);

    await t.run(async (ctx) => {
      // Volume 1's release: linked, empty date filled at standard rank.
      const filled = (await ctx.db.get(releaseNoDate))!;
      expect(filled.pubDate).toEqual({
        year: 2026,
        month: 1,
        day: 6,
        sort: 20260106,
      });
      const obs9001 = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", "release:9001"),
        )
        .unique();
      expect(obs9001!.recordRef).toEqual({
        type: "release",
        id: releaseNoDate,
      });
      // Volume 2's release: ANN (standard) disagrees with an authoritative
      // date → recorded on the observation only, canonical untouched.
      const kept = (await ctx.db.get(releaseAuthDate))!;
      expect(kept.pubDate!.sort).toBe(20260519);
      const obs9002 = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", "release:9002"),
        )
        .unique();
      expect(obs9002!.conflicts).toHaveLength(1);
      expect(obs9002!.conflicts![0]!.reason).toContain("lower authority");
    });
  });

  it("mirrors in chained links and withdraws entries a complete mirror stopped seeing", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // A full 500-row report page, then a short second page. Paging counts
    // every row but only manga rows are mirrored, so anime rows fill the
    // first page around 51 manga (two detail batches); 2 manga follow on the
    // second. Budget is page-aligned, so with maxBatches 1 the first link
    // still finishes both batches of its page, stops at the page boundary
    // and hands the run to a continuation.
    const manga = (i: number): FixtureManga => ({
      id: 1000 + i,
      title: `Chain Series ${i}`,
      releases: [{ annId: 20000 + i, date: "2026-03-03", designator: "GN 1" }],
    });
    const anime = (i: number): FixtureManga => ({ id: 5000 + i, title: `Chain Anime ${i}`, type: "anime", releases: [] });
    const many: FixtureManga[] = [
      ...Array.from({ length: 51 }, (_, i) => manga(i)),
      ...Array.from({ length: 449 }, (_, i) => anime(i)),
      manga(51),
      manga(52),
    ];
    stubAnn(many);
    const first = await sync(t, { maxBatches: 1 });
    expect(first).toMatchObject({ continued: true, recordsSeen: 51 });
    // The run stays open across the chain.
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("running");
    });
    // The scheduled continuation link finishes the mirror, paging on by
    // the report's raw row count (anime rows included), not its manga.
    await drain(t);
    expect(reportRequests.map((url) => new URL(url).searchParams.get("nskip"))).toEqual(["0", "500"]);
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs[0]!).toMatchObject({ status: "succeeded", recordsSeen: 53 });
      expect(await ctx.db.query("series").collect()).toHaveLength(53);
      // The continuation kept the run's start: what the first link saw is
      // not withdrawn as unseen.
      expect((await ctx.db.query("sourceObservations").collect()).filter((o) => o.withdrawn)).toEqual([]);
    });

    // Now drop one entry from ANN and mirror again: it withdraws.
    vi.unstubAllGlobals();
    stubAnn(many.slice(1));
    await sync(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      const gone = observations.find((o) => o.sourceRecordId === "manga:1000")!;
      expect(gone.withdrawn).toBe(true);
      const kept = observations.find((o) => o.sourceRecordId === "manga:1001")!;
      expect(kept.withdrawn).toBe(false);
    });
  });

  it.each(["html report", "missing detail", "failed detail", "malformed report item"])(
    "preserves observations and fails an incomplete sweep: %s",
    async (failure) => {
      const t = makeT();
      await seedRegistry(t, true);
      stubAnn([ALPHA]);
      await sync(t, { releasePages: false });
      await t.run(async (ctx) => {
        for (const obs of await ctx.db.query("sourceObservations").collect()) {
          await ctx.db.patch(obs._id, { lastSeenAt: 1 });
        }
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("reports.xml")) {
          return new Response(
            failure === "html report"
              ? "<html>Temporarily unavailable</html>"
              : failure === "malformed report item"
                ? '<report listed="1"><item><name>Missing id</name></item></report>'
                : reportXml([ALPHA], 0, 500),
          );
        }
        return failure === "failed detail"
          ? new Response("forbidden", { status: 403 })
          : new Response("<ann><warning>no result for manga=100</warning></ann>");
      });
      expect(await sync(t, { releasePages: false })).toMatchObject({
        failed: true,
      });
      await t.run(async (ctx) => {
        const observations = await ctx.db.query("sourceObservations").collect();
        expect(observations.every((obs) => !obs.withdrawn)).toBe(true);
        const runs = await ctx.db.query("importRuns").collect();
        expect(runs.at(-1)?.status).toBe("failed");
      });
    },
  );

  it("skips a malformed report row but enumerates the rest", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("reports.xml")) {
        return new Response(
          `<report skipped="0" listed="2"><item><name>Missing id</name></item>
<item><id>200</id><type>manga</type><name>Beta Blade</name></item></report>`,
        );
      }
      return new Response(apiXml([BETA], ["200"]));
    });
    expect(await sync(t, { releasePages: false })).toMatchObject({
      failed: true,
      recordsSeen: 1,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      const run = (await ctx.db.query("importRuns").collect()).at(-1)!;
      expect(run.status).toBe("failed");
      expect(run.errors).toContain("report @0: item without id/name");
    });
  });

  it("fails an empty first report page and withdraws nothing", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA]);
    await sync(t, { releasePages: false });
    await t.run(async (ctx) => {
      for (const obs of await ctx.db.query("sourceObservations").collect()) {
        await ctx.db.patch(obs._id, { lastSeenAt: 1 });
      }
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('<report skipped="0" listed="0"><args><type>manga</type></args></report>'),
    );
    expect(await sync(t)).toMatchObject({ failed: true, recordsSeen: 0 });
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.every((obs) => !obs.withdrawn)).toBe(true);
      const runs = await ctx.db.query("importRuns").collect();
      // The aborted enumeration chains no page pass.
      expect(runs).toHaveLength(2);
      expect(runs.at(-1)).toMatchObject({ status: "failed" });
      expect(runs.at(-1)!.errors).toContain("ANN report enumeration was empty");
    });
  });

  it("an incomplete mirror skips withdrawal, fails the run, and still chains the page pass", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA, BETA]);
    await sync(t, { releasePages: false });
    await t.run(async (ctx) => {
      for (const obs of await ctx.db.query("sourceObservations").collect()) {
        await ctx.db.patch(obs._id, { lastSeenAt: 1 });
      }
    });
    // ALPHA's details go missing, which rejects its whole batch (BETA is in
    // it too); release pages are gone.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("reports.xml")) return new Response(reportXml([ALPHA, BETA], 0, 500));
      if (url.includes("api.xml")) return new Response(apiXml([BETA], ["100", "200"]));
      return new Response("not found", { status: 404 });
    });
    expect(await sync(t)).toMatchObject({ failed: true, recordsSeen: 0 });
    await drain(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.every((obs) => !obs.withdrawn)).toBe(true);
      const runs = await ctx.db.query("importRuns").collect();
      // First mirror, the failed mirror, then the page pass it chained.
      expect(runs).toHaveLength(3);
      expect(runs[1]).toMatchObject({ status: "failed", automatic: true });
      expect(runs[1]!.errors).toEqual([
        "batch @0: ANN detail response is missing manga 100",
        "ANN mirror was incomplete; withdrawal skipped",
      ]);
      expect(runs[2]).toMatchObject({ status: "succeeded", automatic: true });
      // Every line's page was fetched (404 → notFound, not a failure).
      const pages = observations.flatMap((obs) =>
        obs.sourceRecordId.startsWith("release:")
          ? [(obs.snapshot as { page?: { status: string } }).page?.status]
          : [],
      );
      expect(pages).toHaveLength(5);
      expect(pages.every((status) => status === "notFound")).toBe(true);
      // The chained pass's success does not hide the mirror's failure from
      // the health streak: a weekly-failing mirror still reaches "unhealthy".
      const source = (await ctx.db.query("approvedSources").collect()).find(
        (row) => row.key === "ann",
      )!;
      expect(source.consecutiveFailures).toBe(1);
    });
  });

  it("a mirror whose every detail batch failed chains no page pass", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA, BETA]);
    await sync(t, { releasePages: false });
    // The report answers; the detail API serves an error page for the
    // whole sweep (a 200 that is no <ann> document).
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("reports.xml")) return new Response(reportXml([ALPHA, BETA], 0, 500));
      return new Response("<html>Service unavailable</html>");
    });
    expect(await sync(t)).toMatchObject({ failed: true, recordsSeen: 0 });
    await drain(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.every((obs) => !obs.withdrawn)).toBe(true);
      const runs = await ctx.db.query("importRuns").collect();
      // The first mirror and the failed one; nothing chained.
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ status: "failed" });
      expect(runs[1]!.errors).toContain("ANN detail API unreachable; release-page pass skipped");
    });
  });

  it("defaults to ANN's 1 req/s etiquette", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const waits: number[] = [];
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    stubAnn([BETA]);
    await sync(t, { politeDelayMs: undefined });
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.min(...waits.filter((w) => w > 0))).toBeGreaterThanOrEqual(1000);
  });
});

// The releases audit: ANN lists every North American printing of a volume,
// and linking them all to one Release made dates flip-flop by decades.
describe("ann.sync — printings, packaging-only entries, labels", () => {
  async function releaseFor(
    t: TestT,
    label: string,
    pubDate: { year: number; month: number; day: number; sort: number },
  ) {
    return await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      return await insertBook(ctx, publisherId, [label], { release: { pubDate } });
    });
  }

  const linkOf = (t: TestT, annId: number) =>
    t.run(async (ctx) => {
      const obs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", `release:${annId}`),
        )
        .unique();
      // t.run results cross a serialization boundary: absent reads as null.
      return obs?.recordRef ?? null;
    });

  it("links no line when the entry lists several printings of one volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const NANA: FixtureManga = {
      id: 300,
      title: "NANA",
      releases: [
        { annId: 9101, date: "2005-12-06", designator: "GN 1" },
        { annId: 9102, date: "2025-10-21", designator: "GN 1" },
      ],
    };
    stubAnn([NANA]);
    await sync(t);
    const release = await releaseFor(t, "1", {
      year: 2005,
      month: 12,
      day: 6,
      sort: 20051206,
    });
    await sync(t);
    expect(await linkOf(t, 9101)).toBeNull();
    expect(await linkOf(t, 9102)).toBeNull();
    await t.run(async (ctx) => {
      expect((await ctx.db.get(release))!.pubDate!.year).toBe(2005);
    });
  });

  it("never links a line years away from the Release's own date", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const TRIGUN: FixtureManga = {
      id: 301,
      title: "Trigun",
      releases: [{ annId: 9201, date: "2025-06-17", designator: "GN 5" }],
    };
    stubAnn([TRIGUN]);
    await sync(t);
    await releaseFor(t, "5", { year: 2005, month: 3, day: 1, sort: 20050301 });
    await sync(t);
    expect(await linkOf(t, 9201)).toBeNull();
  });

  it("builds no placeholder Volume for an omnibus-only entry and dedupes labels", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([
      {
        id: 302,
        title: "Homunculus",
        releases: [
          { annId: 9301, date: "2023-01-10", designator: "GN 1-2" },
          { annId: 9302, date: "2023-05-10", designator: "GN 3-4" },
        ],
      },
      {
        id: 303,
        title: "Sand Land",
        releases: [
          { annId: 9401, date: "2008-02-05", designator: "GN 1" },
          { annId: 9402, date: "2020-07-07", designator: "GN 01" },
        ],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      const byTitle = (title: string) => series.find((s) => s.title === title)!._id;
      const volumesOf = async (title: string) =>
        await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", byTitle(title)))
          .collect();
      expect(await volumesOf("Homunculus")).toHaveLength(0);
      expect((await volumesOf("Sand Land")).map((v) => [v.label, v.position])).toEqual([["1", 1]]);
    });
  });
});

describe("ann.sync — steady state", () => {
  it("queues a Series+Volumes proposal for a brand-new series, once, with no release ops", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    stubAnn([BETA]);
    await sync(t);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.state).toBe("inReview");
      const versions = await ctx.db.query("proposalVersions").collect();
      const tables = versions[0]!.ops.map((op) => (op.kind === "create" ? op.table : op.kind));
      expect(tables).toEqual(["series", "volumes"]);
    });
  });
});

// A release page in the live layout (see lib/ann.test.ts for real copies).
function releasePage(args: {
  title: string;
  volume: string;
  distributor: string;
  date: string;
  isbn13: string;
  mangaId: number;
  description?: string;
}) {
  const description =
    args.description !== undefined
      ? `<p class="easyread-width"><b>Description:</b><br>${args.description}</p><p><small>(added on 2008-01-04, modified on 2008-01-04)</small></p>`
      : "";
  return `<html><body><hr><b>Title:</b> ${args.title}<br><b>Volume:</b>  ${args.volume}<br><b>Distributor:</b> <a href="company.php?id=4552">${args.distributor}</a><p><b>Release date:</b> ${args.date}<br><b>Suggested retail price:</b> $11.99<br></p><p><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">${args.isbn13.slice(0, 3)}</span><span>${args.isbn13.slice(3)}</span></span><span style="visibility:hidden"> ${args.isbn13}</span><br></p>${description}<ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=${args.mangaId}">x</a></b></li></ul></body></html>`;
}

const syncPages = (t: TestT, args: object = {}) =>
  t.action(internal.ann.syncReleasePages, { politeDelayMs: 0, ...args });

const obsFor = (t: TestT, annId: number) =>
  t.run(async (ctx) =>
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "ann").eq("sourceRecordId", `release:${annId}`),
      )
      .unique(),
  );

async function seedPublisher(t: TestT, name: string, slug: string) {
  return await t.run((ctx) => insertPublisher(ctx, { name, slug }));
}

describe("ann — ISBN-linked release lines", () => {
  it("links a line to the Release carrying its ISBN, even among several printings", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const NANA: FixtureManga = {
      id: 310,
      title: "NANA",
      releases: [
        {
          annId: 9111,
          date: "2005-12-06",
          designator: "GN 1",
          ean: "9781421501086",
        },
        {
          annId: 9112,
          date: "2025-10-21",
          designator: "GN 1",
          ean: "9781974757282",
        },
      ],
    };
    stubAnn([NANA]);
    await sync(t, { releasePages: false });
    const releaseId = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      return await insertBook(ctx, publisherId, ["1"], { release: { isbn13: "9781974757282" } });
    });
    await sync(t, { releasePages: false });
    expect((await obsFor(t, 9112))!.recordRef).toEqual({
      type: "release",
      id: releaseId,
    });
    // The 2005 printing (another ISBN) never links to the 2025 book.
    expect((await obsFor(t, 9111))!.recordRef).toBeUndefined();
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId))!.pubDate).toMatchObject({
        year: 2025,
        month: 10,
      });
    });
  });
});

describe("ann.syncReleasePages — leaf Releases from release pages", () => {
  it.each(["http error", "unparsed page"])(
    "marks page pass failures unhealthy: %s",
    async (failure) => {
      const t = makeT();
      await seedRegistry(t, true);
      stubAnn([BETA]);
      await sync(t, { releasePages: false });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response("<html>Unavailable</html>", {
            status: failure === "http error" ? 403 : 200,
          }),
      );
      expect(await syncPages(t)).toMatchObject({ failed: true });
      await t.run(async (ctx) => {
        expect((await ctx.db.query("importRuns").collect()).at(-1)?.status).toBe("failed");
        const observation = (await ctx.db.query("sourceObservations").collect()).find(
          (obs) => obs.sourceRecordId === "release:9101",
        );
        expect(observation?.snapshot).toMatchObject({
          page: { status: failure === "http error" ? "error" : "unparsed" },
        });
      });
    },
  );

  const ONE: FixtureManga = {
    id: 1223,
    title: "One Piece",
    releases: [
      {
        annId: 57439,
        date: "2026-11-10",
        designator: "GN 113",
        ean: "9781974766703",
      },
      {
        annId: 57440,
        date: "2026-12-08",
        designator: "GN 114",
        ean: "9781974766710",
      },
      {
        annId: 57441,
        date: "2026-11-10",
        designator: "GN 113",
        ean: "9781974799992",
        title: "One Piece - [Walmart Exclusive Cover]",
      },
      {
        annId: 24124,
        date: "2013-11-05",
        designator: "GN 1-23",
        ean: "9781421560748",
      },
    ],
  };
  const PAGES = {
    57439: releasePage({
      title: "One Piece",
      volume: "GN 113",
      distributor: "Viz Media",
      date: "2026-11-10",
      isbn13: "9781974766703",
      mangaId: 1223,
    }),
    57440: releasePage({
      title: "One Piece",
      volume: "GN 114",
      distributor: "Defunct Comics",
      date: "2026-12-08",
      isbn13: "9781974766710",
      mangaId: 1223,
    }),
    57441: releasePage({
      title: "One Piece - [Walmart Exclusive Cover]",
      volume: "GN 113",
      distributor: "Viz Media",
      date: "2026-11-10",
      isbn13: "9781974799992",
      mangaId: 1223,
    }),
  };

  it("creates a leaf under the existing Volume for a resolvable distributor and holds the rest", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ONE], PAGES);
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");

    const result = await syncPages(t);
    expect(result).toMatchObject({
      continued: false,
      fetched: 4,
      recordsSeen: 4,
    });

    const created = (await obsFor(t, 57439))!;
    expect(created.recordRef?.type).toBe("release");
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(created.recordRef!.id as Id<"releases">))!;
      expect(release).toMatchObject({
        format: "physical",
        isbn13: "9781974766703",
        publisherId: vizId,
        pubDate: { year: 2026, month: 11, day: 10 },
        price: { amountCents: 1199, currency: "USD" },
      });
      // Leaf only: the Release hangs off the backbone's Volume 113.
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      const cover = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", release.editionId))
        .collect();
      const volume = (await ctx.db.get(cover[0]!.volumeId))!;
      expect(volume.label).toBe("113");
    });
    const held = async (annId: number) =>
      (await obsFor(t, annId))!.conflicts?.find((c) => c.field === "placement")?.reason;
    expect(await held(57440)).toContain('"Defunct Comics" resolves to no publisher');
    expect(await held(57441)).toContain("variant");
    // The box set's page 404s: stored as notFound, nothing placed.
    const box = (await obsFor(t, 24124))!;
    expect((box.snapshot as { page?: { status: string } }).page?.status).toBe("notFound");
    expect(box.recordRef).toBeUndefined();
  });

  it("is incremental: stored pages are re-placed without refetching, and the mirror keeps them", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ONE], PAGES);
    await sync(t, { releasePages: false });
    await seedPublisher(t, "VIZ Media", "viz-media");
    await syncPages(t);
    pageRequests.length = 0;

    // A new publisher row unblocks the held line on the next pass — with no
    // new page fetches (57440's page is stored; 24124's 404 is fresh).
    await seedPublisher(t, "Defunct Comics", "defunct-comics");
    await sync(t, { releasePages: false });
    const again = await syncPages(t);
    expect(pageRequests).toEqual([]);
    expect(again).toMatchObject({ fetched: 0 });
    expect((await obsFor(t, 57440))!.recordRef?.type).toBe("release");
    const page = ((await obsFor(t, 57441))!.snapshot as { page?: { status: string } }).page;
    expect(page?.status).toBe("ok");
  });

  it("links instead of creating when the Volume already has that publisher's Release without an ISBN", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ONE], PAGES);
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    const existing = await t.run((ctx) => insertBook(ctx, vizId, ["113"]));
    await syncPages(t);
    expect((await obsFor(t, 57439))!.recordRef).toEqual({
      type: "release",
      id: existing,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      // The page's ISBN fills the linked Release, which had none.
      expect((await ctx.db.get(existing))?.isbn13).toBe("9781974766703");
    });
  });

  it("the completed mirror chains the page pass", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ONE], PAGES);
    await seedPublisher(t, "VIZ Media", "viz-media");
    await sync(t);
    await drain(t);
    expect((await obsFor(t, 57439))!.recordRef?.type).toBe("release");
  });

  it("a mirror forced on the disabled source chains a forced page pass", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "ann",
      enabled: false,
    });
    stubAnn([ONE], PAGES);
    await seedPublisher(t, "VIZ Media", "viz-media");
    const runId = await t.mutation(internal.imports.startRun, {
      sourceKey: "ann",
    });
    await sync(t, { runId });
    await drain(t);
    // The page pass ran under its own (forced) run and placed the release.
    expect((await obsFor(t, 57439))!.recordRef?.type).toBe("release");
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === "succeeded" && run.automatic === undefined)).toBe(
        true,
      );
    });
  });
});

describe("ann — disabling the source mid-run", () => {
  const disableAnn = (t: TestT) =>
    t.mutation(internal.importSources.setEnabledInternal, { key: "ann", enabled: false });

  /** Wrap the stub stubAnn installed: disable ANN on the first request `when` picks. */
  function disableOn(t: TestT, when: (url: string) => boolean) {
    const inner = globalThis.fetch;
    let done = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!done && when(String(input))) {
        done = true;
        await disableAnn(t);
      }
      return await inner(input);
    });
  }

  it("finishes the report page under way and stops before the next", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // A first report page of 500 anime rows (read, none mirrored), then Alpha.
    const anime = Array.from({ length: 500 }, (_, i) => ({ id: 5000 + i, title: `Anime ${i}`, type: "anime", releases: [] }));
    stubAnn([...anime, ALPHA]);
    disableOn(t, (url) => url.includes("reports.xml"));
    expect(await sync(t)).toMatchObject({ stopped: true, recordsSeen: 0, continued: false });
    expect(reportRequests).toHaveLength(1);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", automatic: true });
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
    });
  });

  it("withdraws nothing and chains no page pass when disabled during a clean mirror's last report page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // An entry an earlier mirror saw, which this sweep no longer lists.
    await t.run((ctx) => insertObservation(ctx, { sourceKey: "ann", sourceRecordId: "manga:999" }));
    stubAnn([ALPHA]);
    disableOn(t, (url) => url.includes("reports.xml"));
    expect(await sync(t)).toMatchObject({ stopped: true, recordsSeen: 1 });
    await drain(t);
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "stopped", automatic: true, recordsSeen: 1 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.find((o) => o.sourceRecordId === "manga:999")?.withdrawn).toBe(false);
      expect(observations.find((o) => o.sourceRecordId === "manga:100")?.withdrawn).toBe(false);
    });
    expect(pageRequests).toHaveLength(0);
  });

  it("finishes the batch of release pages under way and stops before the next", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // 26 unlinked lines: a candidate page of 25, then one more.
    const long: FixtureManga = {
      id: 400,
      title: "Long Saga",
      releases: Array.from({ length: 26 }, (_, i) => ({
        annId: 30000 + i,
        date: "2026-01-06",
        designator: `GN ${i + 1}`,
      })),
    };
    stubAnn([long]);
    await sync(t, { releasePages: false });
    disableOn(t, (url) => url.includes("releases.php"));
    expect(await syncPages(t)).toMatchObject({ stopped: true, fetched: 25, continued: false });
    expect(pageRequests).toHaveLength(25);
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs.at(-1)).toMatchObject({ status: "stopped", automatic: true, recordsSeen: 25 });
    });
  });
});

describe("ann — a slow chain is not stranded", () => {
  it("stamps at hand-off, so a slow last page and a delayed continuation do not strand the run", async () => {
    // Fake timers: the clock moves only when the test moves it, and the
    // continuation stays queued.
    vi.useFakeTimers();
    const t = makeT();
    await seedRegistry(t, true);
    // A full report page of entries with no English release: ten detail
    // batches, after which a one-batch budget hands off.
    const quiet = Array.from({ length: 500 }, (_, i) => ({ id: 6000 + i, title: `Quiet ${i}`, releases: [] }));
    stubAnn(quiet);
    const inner = globalThis.fetch;
    const minute = 60_000;
    const opened = Date.now();
    // The report page takes 28 minutes after the gate stamped before it.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("reports.xml")) vi.setSystemTime(Date.now() + 28 * minute);
      return await inner(input);
    });
    expect(await sync(t, { maxBatches: 1, releasePages: false })).toMatchObject({ continued: true });
    const [run] = await t.run((ctx) => ctx.db.query("importRuns").collect());
    expect(run).toMatchObject({ status: "running", lastActivityAt: opened + 28 * minute });
    // The continuation waits 35 minutes: 63 since the stamp before the page.
    vi.setSystemTime(opened + 63 * minute);
    expect(await t.mutation(internal.imports.closeStrandedRun, { runId: run!._id })).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(run!._id))).toMatchObject({ status: "running" });
  });
});

// Catalog repairs hide and merge records; the next weekly mirror must not
// undo them (stage 13: hidden Series recreated; Summer Ghost / Qualia the
// Purple regained an empty unlabeled placeholder after a merge).
describe("ann — repairs stand across mirrors", () => {
  const seriesTitled = (t: TestT, title: string) =>
    t.run(async (ctx) => (await ctx.db.query("series").collect()).filter((s) => s.title === title));
  const volumesOf = (t: TestT, seriesId: Id<"series">) =>
    t.run((ctx) =>
      ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .collect(),
    );

  it("never recreates a linked Series an Editor hid, and keeps its lines on record", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA]);
    await sync(t);
    const [alpha] = await seriesTitled(t, "Alpha Saga");
    await t.run((ctx) => ctx.db.patch(alpha!._id, { status: "hidden" }));

    await sync(t);
    const all = await seriesTitled(t, "Alpha Saga");
    expect(all.map((s) => s.status)).toEqual(["hidden"]);
    expect(await volumesOf(t, alpha!._id)).toHaveLength(3);
    expect((await obsFor(t, 9004))?.recordRef).toBeUndefined();
  });

  it("never creates a Series whose title names a hidden one", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) => insertSeries(ctx, { status: "hidden", publicId: 77, title: "Alpha Saga" }));
    stubAnn([ALPHA]);
    await sync(t);
    expect((await seriesTitled(t, "Alpha Saga")).map((s) => s.status)).toEqual(["hidden"]);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
      const mangaObs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:100"),
        )
        .unique();
      expect(mangaObs?.recordRef).toBeUndefined();
      expect(mangaObs?.conflicts?.find((c) => c.field === "placement")?.reason).toContain(
        "Series 77",
      );
    });
  });

  it("follows a merged Series to its survivor and builds the backbone there", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA]);
    await sync(t);
    const [loser] = await seriesTitled(t, "Alpha Saga");
    const survivorId = await t.run(async (ctx) => {
      const survivorId = await insertSeries(ctx, { title: "Alpha Saga: Complete", altTitles: ["Alpha Saga"] });
      await ctx.db.patch(loser!._id, {
        status: "merged",
        mergedIntoId: survivorId,
      });
      for (const volume of await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", loser!._id))
        .collect()) {
        await ctx.db.patch(volume._id, { seriesId: survivorId });
      }
      return survivorId;
    });

    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s.status).sort()).toEqual([
        "active",
        "merged",
      ]);
      const mangaObs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:100"),
        )
        .unique();
      expect(mangaObs?.recordRef?.id).toBe(survivorId);
    });
    expect((await volumesOf(t, survivorId)).map((v) => v.label).sort()).toEqual(["1", "2", "3"]);
  });

  const GHOST: FixtureManga = {
    id: 27108,
    title: "Summer Ghost",
    releases: [{ annId: 54594, date: "2023-06-20", designator: "GN" }],
  };

  it("adds no unlabeled placeholder next to numbered Volumes or a removed placeholder", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([GHOST]);
    await sync(t);
    const [ghost] = await seriesTitled(t, "Summer Ghost");
    const [placeholder] = await volumesOf(t, ghost!._id);
    expect(placeholder?.label).toBeUndefined();

    // Stage 8: the empty placeholder was hidden; the manga's real volumes
    // arrived from a publisher feed.
    await t.run(async (ctx) => {
      await ctx.db.patch(placeholder!._id, { status: "hidden" });
    });
    await sync(t);
    expect((await volumesOf(t, ghost!._id)).map((v) => v.status)).toEqual(["hidden"]);

    await t.run(async (ctx) => {
      for (const position of [1, 2]) await insertVolume(ctx, { seriesId: ghost!._id, position });
      await ctx.db.delete(placeholder!._id);
    });
    await sync(t);
    expect((await volumesOf(t, ghost!._id)).map((v) => v.label)).toEqual(["1", "2"]);
  });

  it("never recreates a numbered Volume a repair merged or hid", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA]);
    await sync(t);
    const [alpha] = await seriesTitled(t, "Alpha Saga");
    await t.run(async (ctx) => {
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", alpha!._id))
        .collect();
      const byLabel = (label: string) => volumes.find((v) => v.label === label)!;
      await ctx.db.patch(byLabel("3")._id, { status: "hidden" });
      await ctx.db.patch(byLabel("2")._id, {
        status: "merged",
        mergedIntoId: byLabel("1")._id,
      });
    });
    await sync(t);
    expect((await volumesOf(t, alpha!._id)).map((v) => [v.label, v.status]).sort()).toEqual([
      ["1", "active"],
      ["2", "merged"],
      ["3", "hidden"],
    ]);
  });

  it("never places a release line whose ISBN is on a Release an Editor hid", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const ONE_LINE: FixtureManga = {
      id: 1223,
      title: "One Piece",
      releases: [
        {
          annId: 57439,
          date: "2026-11-10",
          designator: "GN 113",
          ean: "9781974766703",
        },
      ],
    };
    stubAnn([ONE_LINE], {
      57439: releasePage({
        title: "One Piece",
        volume: "GN 113",
        distributor: "Viz Media",
        date: "2026-11-10",
        isbn13: "9781974766703",
        mangaId: 1223,
      }),
    });
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    await t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect())[0]!;
      const editionId = await insertEdition(ctx, { status: "hidden", publisherId: vizId });
      await insertRelease(ctx, {
        status: "hidden",
        editionId,
        isbn13: "9781974766703",
        publisherId: vizId,
        seriesIds: [series._id],
      });
    });

    await syncPages(t);
    const line = (await obsFor(t, 57439))!;
    expect(line.recordRef).toBeUndefined();
    expect(line.conflicts?.find((c) => c.field === "placement")?.reason).toContain("hid");
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.status)).toEqual(["hidden"]);
    });
  });
});

describe("ann.sync — the Plot Summary as the Series synopsis", () => {
  it("fills a blank synopsis, and only records its text against a publisher's", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([{ ...ALPHA, plot: "Alpha&amp;#039;s &quot;saga&quot;\nbegins." }]);
    await sync(t, { releasePages: false });
    const series = async () => await t.run(async (ctx) => (await ctx.db.query("series").first())!);
    expect((await series()).synopsis).toBe('Alpha\'s "saga" begins.');

    // Kodansha's own series text (authoritative) replaced ANN's since.
    await t.run(async (ctx) => {
      const current = (await ctx.db.query("series").first())!;
      await insertSourceRevision(ctx, {
        ref: { type: "series", id: current._id },
        sourceKey: "kodansha",
        seq: 2,
        changes: [{ field: "synopsis", before: current.synopsis, after: "The publisher's text." }],
      });
      await ctx.db.patch(current._id, { synopsis: "The publisher's text." });
    });

    // A new ANN summary is lower authority: on the observation only.
    stubAnn([{ ...ALPHA, plot: "A rewritten summary." }]);
    await sync(t, { releasePages: false });
    expect((await series()).synopsis).toBe("The publisher's text.");
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "manga:100",
      )!;
      expect(obs.snapshot).toMatchObject({ synopsis: "A rewritten summary." });
      expect(obs.conflicts?.find((c) => c.field === "synopsis")).toMatchObject({
        offered: "A rewritten summary.",
        reason: expect.stringContaining("lower authority"),
      });
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals.filter((p) => p.state === "inReview")).toHaveLength(0);
    });
  });
});

describe("ann.sync — a publisher's Series under the full title", () => {
  it("links the entry through an alternative title instead of building a bookless twin", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // A publisher feed (PRH) already created the Series under the full title.
    const seriesId = await t.run((ctx) =>
      insertSeries(ctx, { title: "7th Time Loop: The Villainess Enjoys a Carefree Life Married to Her Worst Enemy!" }),
    );
    stubAnn([
      {
        id: 26068,
        title: "7th Time Loop: The Villainess Enjoys a Carefree Life",
        altTitles: [
          { lang: "EN", text: "7th Time Loop: The Villainess Enjoys a Carefree Life Married to Her Worst Enemy!" },
          { lang: "JA", text: "ループ7回目の悪役令嬢は" },
        ],
        releases: [{ annId: 43861, date: "2022-03-08", designator: "GN 1" }],
      },
    ]);
    await sync(t, { releasePages: false });
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s._id)).toEqual([seriesId]);
      const link = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "manga:26068",
      );
      expect(link?.recordRef).toEqual({ type: "series", id: seriesId });
      // The backbone Volume lands under the publisher's Series.
      expect((await ctx.db.query("volumes").collect()).map((v) => [v.seriesId, v.label])).toEqual([[seriesId, "1"]]);
    });
  });
});

describe("ann.syncReleasePages — packaging lines (#47)", () => {
  const NARUTO: FixtureManga = {
    id: 1825,
    title: "Naruto",
    releases: [
      { annId: 9001, date: "2003-08-16", designator: "GN 1" },
      { annId: 9002, date: "2003-12-16", designator: "GN 2" },
      { annId: 9003, date: "2004-04-06", designator: "GN 3" },
      { annId: 9004, date: "2004-08-03", designator: "GN 4" },
      { annId: 9005, date: "2004-12-07", designator: "GN 5" },
      { annId: 9006, date: "2005-04-05", designator: "GN 6" },
      // VIZ's omnibus line: the designator number is the line position.
      { annId: 9101, date: "2011-05-03", designator: "GN 1", title: "Naruto [3-in-1 Edition]" },
      { annId: 9102, date: "2011-08-02", designator: "GN 2", title: "Naruto [3-in-1 Edition]" },
      // A line whose size no rule knows.
      { annId: 9201, date: "2020-01-07", designator: "GN 1", title: "Naruto [Omnibus]" },
      // Would reach past the backbone: held, not invented.
      { annId: 9103, date: "2012-02-07", designator: "GN 9", title: "Naruto [3-in-1 Edition]" },
    ],
  };
  const pages = {
    9101: releasePage({ title: "Naruto [3-in-1 Edition]", volume: "1", distributor: "Viz Media", date: "2011-05-03", isbn13: "9781421539898", mangaId: 1825 }),
    9102: releasePage({ title: "Naruto [3-in-1 Edition]", volume: "2", distributor: "Viz Media", date: "2011-08-02", isbn13: "9781421539904", mangaId: 1825 }),
    9201: releasePage({ title: "Naruto [Omnibus]", volume: "1", distributor: "Viz Media", date: "2020-01-07", isbn13: "9781974700004", mangaId: 1825 }),
    9103: releasePage({ title: "Naruto [3-in-1 Edition]", volume: "9", distributor: "Viz Media", date: "2012-02-07", isbn13: "9781421554891", mangaId: 1825 }),
  };

  it("places a line by the range its designator states — One Piece's omnibus shape", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    const ONE_PIECE: FixtureManga = {
      id: 1223,
      title: "One Piece",
      releases: [
        { annId: 8097, date: "2020-11-03", designator: "GN 97" },
        { annId: 8098, date: "2021-02-02", designator: "GN 98" },
        { annId: 8099, date: "2021-05-04", designator: "GN 99" },
        { annId: 8833, date: "2022-01-04", designator: "GN 97-99", title: "One Piece - [Omnibus] 33 - Wano" },
      ],
    };
    stubAnn([ONE_PIECE], {
      8833: releasePage({ title: "One Piece - [Omnibus] 33 - Wano", volume: "33", distributor: "Viz Media", date: "2022-01-04", isbn13: "9781974726585", mangaId: 1223 }),
    });
    await sync(t, { releasePages: false });
    await syncPages(t);
    await t.run(async (ctx) => {
      const [line] = await ctx.db.query("editionLines").collect();
      expect(line).toMatchObject({ name: "Omnibus" });
      const [edition] = (await ctx.db.query("editions").collect()).filter((e) => e.editionLineId === line!._id);
      expect(edition).toMatchObject({ linePosition: "33" });
      expect(edition!.coverageUnmapped).toBeUndefined();
      const volumes = new Map((await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]));
      const covered = (await ctx.db.query("volumeCoverages").collect())
        .filter((c) => c.editionId === edition!._id)
        .sort((a, b) => a.order - b.order)
        .map((c) => volumes.get(c.volumeId));
      expect(covered).toEqual(["97", "98", "99"]);
      expect([...volumes.values()].sort()).toEqual(["97", "98", "99"]);
    });
  });

  it("places N-in-1 books by their declared size, leaves unknown sizes unmapped, and never invents Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    stubAnn([NARUTO], pages);
    await sync(t, { releasePages: false });
    await syncPages(t);
    await t.run(async (ctx) => {
      const volumes = new Map((await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]));
      expect([...volumes.values()].sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines.map((l) => l.name).sort()).toEqual(["3-in-1 Edition", "Omnibus"]);
      const threeIn1 = lines.find((l) => l.name === "3-in-1 Edition")!;
      const members = (await ctx.db.query("editions").collect()).filter((e) => e.editionLineId === threeIn1._id);
      expect(members.map((e) => e.linePosition).sort()).toEqual(["1", "2"]);
      const coverage = await ctx.db.query("volumeCoverages").collect();
      const covered = (position: string) =>
        coverage
          .filter((c) => c.editionId === members.find((e) => e.linePosition === position)!._id)
          .sort((a, b) => a.order - b.order)
          .map((c) => volumes.get(c.volumeId));
      expect(covered("1")).toEqual(["1", "2", "3"]);
      expect(covered("2")).toEqual(["4", "5", "6"]);
      // The size-less "[Omnibus]" line is an Unmapped Packaging member.
      const omnibus = lines.find((l) => l.name === "Omnibus")!;
      const unmapped = (await ctx.db.query("editions").collect()).find((e) => e.editionLineId === omnibus._id)!;
      expect(unmapped).toMatchObject({ coverageUnmapped: true, linePosition: "1" });
      // Position 9 would cover 25–27; the backbone stops at 6.
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13).sort()).toEqual(["9781421539898", "9781421539904", "9781974700004"]);
    });
    const held = await obsFor(t, 9103);
    expect(held?.recordRef).toBeUndefined();
    expect(held?.conflicts?.[0]?.reason).toMatch(/would cover Volumes 25–27/);
  });
});

// A designator listing Volumes no range holds ("(GN 1, 3)") states the
// book's coverage in a way no Edition can hold: the page pass holds it, and
// the line's name ("3-in-1") never sizes it. A contiguous list places as the
// range it spans.
describe("ann.syncReleasePages — Volume lists (C5)", () => {
  const KAPPA: FixtureManga = {
    id: 1900,
    title: "Kappa",
    releases: [
      ...["1", "2", "3", "4", "5", "6"].map((n) => ({ annId: 9300 + Number(n), date: "2010-01-05", designator: `GN ${n}` })),
      { annId: 9401, date: "2012-03-06", designator: "GN 1, 3", title: "Kappa [3-in-1 Edition]" },
      { annId: 9402, date: "2012-06-05", designator: "GN 4, 5, 6", title: "Kappa [3-in-1 Edition]" },
    ],
  };
  const GAPPED_ISBN = "9781421500010";
  const pages = (gapped = "GN 1, 3") => ({
    9401: releasePage({ title: "Kappa [3-in-1 Edition]", volume: gapped, distributor: "Viz Media", date: "2012-03-06", isbn13: GAPPED_ISBN, mangaId: 1900 }),
    9402: releasePage({ title: "Kappa [3-in-1 Edition]", volume: "GN 4, 5, 6", distributor: "Viz Media", date: "2012-06-05", isbn13: "9781421500027", mangaId: 1900 }),
  });

  /** The Volume labels an Edition covers, in order. */
  const coveredBy = (t: TestT, editionId: Id<"editions">) =>
    t.run(async (ctx) => {
      const coverages = (await ctx.db.query("volumeCoverages").collect())
        .filter((c) => c.editionId === editionId)
        .sort((a, b) => a.order - b.order);
      return await Promise.all(coverages.map(async (c) => (await ctx.db.get(c.volumeId))!.label));
    });
  const holdFor = (t: TestT, observationId: Id<"sourceObservations">) =>
    t.run((ctx) =>
      ctx.db
        .query("placementHolds")
        .withIndex("by_observation", (q) => q.eq("observationId", observationId))
        .unique(),
    );

  async function mirrorAndPlace(t: TestT, gapped = "GN 1, 3") {
    stubAnn(
      [{ ...KAPPA, releases: KAPPA.releases.map((r) => (r.annId === 9401 ? { ...r, designator: gapped } : r)) }],
      pages(gapped),
    );
    await sync(t, { releasePages: false });
    return await syncPages(t);
  }

  /** The held line is noted and listed as packaging, and nothing was made for it. */
  async function expectHeldUnplaced(t: TestT, designator: string) {
    const held = (await obsFor(t, 9401))!;
    expect(held.snapshot).toMatchObject({ multi: true, coverageGapped: true });
    expect(held.snapshot.label).toBeUndefined();
    expect(held.snapshot.coverRange).toBeUndefined();
    expect(held.recordRef).toBeUndefined();
    expect(held.conflicts?.find((c) => c.field === "placement")?.reason).toBe(
      `"Kappa [3-in-1 Edition]" (${designator}) is packaging whose Volume list no range holds — an Editor maps it.`,
    );
    const series = await t.run(async (ctx) => (await ctx.db.query("series").collect())[0]!);
    expect(await holdFor(t, held._id)).toMatchObject({ kind: "packaging", sourceKey: "ann", seriesId: series._id });
    await t.run(async (ctx) => {
      // Only the plain lines' Volumes: none from the held list.
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
      expect((await ctx.db.query("releases").collect()).map((r) => r.isbn13)).not.toContain(GAPPED_ISBN);
      // The one 3-in-1 member is the contiguous list's.
      expect((await ctx.db.query("editions").collect()).filter((e) => e.editionLineId !== undefined)).toHaveLength(1);
      // No Proposal, approved or queued, cites the held line.
      const cited = (await ctx.db.query("proposalVersions").collect()).flatMap((version) =>
        version.evidence.flatMap((e) => (e.kind === "observation" ? [e.observationId] : [])),
      );
      expect(cited).not.toContain(held._id);
    });
  }

  it("holds a gapped list on a 3-in-1 line, creating no Volume, Edition, Release or Proposal for it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    // Volumes no plain line supplies, so a Volume made for the list would show.
    await mirrorAndPlace(t, "GN 7, 9");
    await expectHeldUnplaced(t, "GN 7, 9");
  });

  // Each reads as a shorter list or a single Volume if only its first
  // numbers are taken: "1, 2" (Volumes 1–2), "1" (sized 1–3 by "3-in-1").
  it.each(["GN 1, 2, and 4", "GN 1, and 3", "GN 1-2 + 3"])(
    "holds %s whole: no prefix of the list is placed",
    async (designator) => {
      const t = makeT();
      await seedRegistry(t, true);
      await seedPublisher(t, "VIZ Media", "viz-media");
      await mirrorAndPlace(t, designator);
      await expectHeldUnplaced(t, designator);
    },
  );

  it("never reads a number before the format marker as a Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    const lambda: FixtureManga = {
      id: 1901,
      title: "Lambda",
      releases: [
        { annId: 9501, date: "2010-01-05", designator: "GN 1" },
        { annId: 9503, date: "2010-03-05", designator: "GN 3" },
        { annId: 9510, date: "2012-03-06", designator: "2nd Edition GN 1-3" },
      ],
    };
    stubAnn([lambda], {
      9510: releasePage({ title: "Lambda", volume: "2nd Edition GN 1-3", distributor: "Viz Media", date: "2012-03-06", isbn13: GAPPED_ISBN, mangaId: 1901 }),
    });
    await sync(t, { releasePages: false });
    await syncPages(t);
    expect((await obsFor(t, 9510))!.snapshot).toMatchObject({ multi: true, coverRange: { from: "1", to: "3" } });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label).sort()).toEqual(["1", "3"]);
    });
  });

  it("places a contiguous list as the range it spans", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    await mirrorAndPlace(t);
    const placed = (await obsFor(t, 9402))!;
    expect(placed.snapshot).toMatchObject({ multi: true, coverRange: { from: "4", to: "6" } });
    expect(placed.recordRef?.type).toBe("release");
    const release = await t.run(async (ctx) => (await ctx.db.get(placed.recordRef!.id as Id<"releases">))!);
    expect(await coveredBy(t, release.editionId)).toEqual(["4", "5", "6"]);
  });

  it("releases the hold when ANN corrects the designator", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    await mirrorAndPlace(t);
    const held = (await obsFor(t, 9401))!;
    expect(await holdFor(t, held._id)).not.toBeNull();
    // ANN corrects the line to a range: the next mirror stores it and the
    // page pass places it from the stored page.
    await mirrorAndPlace(t, "GN 1-3");
    const placed = (await obsFor(t, 9401))!;
    expect(placed.snapshot.coverageGapped).toBeUndefined();
    expect(placed.recordRef?.type).toBe("release");
    expect(placed.conflicts?.find((c) => c.field === "placement")).toBeUndefined();
    expect(await holdFor(t, placed._id)).toBeNull();
    const release = await t.run(async (ctx) => (await ctx.db.get(placed.recordRef!.id as Id<"releases">))!);
    expect(await coveredBy(t, release.editionId)).toEqual(["1", "2", "3"]);
  });

  it("an Editor placing a held line clears its hold, and later syncs keep the link", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const viz = await seedPublisher(t, "VIZ Media", "viz-media");
    await mirrorAndPlace(t);
    const held = (await obsFor(t, 9401))!;
    const releaseId = await t.run(async (ctx) => {
      const id = await insertBook(ctx, viz, ["1", "3"], { release: { isbn13: GAPPED_ISBN } });
      await linkObservation(ctx, held._id, { type: "release", id });
      return id;
    });
    expect(await holdFor(t, held._id)).toBeNull();
    // A line linked before this rule (placed by its line's size) is the
    // same: an import never moves an existing link.
    await mirrorAndPlace(t);
    const linked = (await obsFor(t, 9401))!;
    expect(linked.recordRef).toEqual({ type: "release", id: releaseId });
    expect(linked.snapshot.coverageGapped).toBe(true);
    expect(linked.conflicts?.find((c) => c.field === "placement")).toBeUndefined();
    expect(await holdFor(t, held._id)).toBeNull();
    expect(await coveredBy(t, (await t.run((ctx) => ctx.db.get(releaseId)))!.editionId)).toEqual(["1", "3"]);
  });

  it("a second unchanged sync rewrites neither the held line nor its hold", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seedPublisher(t, "VIZ Media", "viz-media");
    await mirrorAndPlace(t);
    const before = (await obsFor(t, 9401))!;
    const hold = (await holdFor(t, before._id))!;
    expect(hold).not.toBeNull();
    const history = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("observationSnapshots").collect()).filter((s) => s.observationId === before._id),
      );
    const stored = await history();
    const second = await mirrorAndPlace(t);
    const after = (await obsFor(t, 9401))!;
    // The mirror bumps last-seen only; the page pass writes nothing.
    expect({ ...after, lastSeenAt: 0 }).toEqual({ ...before, lastSeenAt: 0 });
    expect(await holdFor(t, before._id)).toEqual(hold);
    expect(second).toMatchObject({ recordsChanged: 0 });
    expect(await history()).toEqual(stored);
  });
});

describe("ann.sync — onlyManga (operator-targeted refresh)", () => {
  it("refreshes just the named entries through the detail API, never reads the report, and never withdraws", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([ALPHA, BETA]);
    // A full mirror first, so ALPHA has observations that a subset run must not withdraw.
    await sync(t, { releasePages: false });
    expect(await t.run((ctx) => ctx.db.query("series").collect())).toHaveLength(2);
    reportRequests.length = 0;
    const result = await sync(t, { releasePages: false, onlyManga: [String(BETA.id)] });
    expect(result).toMatchObject({ recordsSeen: 1, continued: false });
    expect(reportRequests).toHaveLength(0);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.every((o) => o.withdrawn !== true)).toBe(true);
      expect(await ctx.db.query("series").collect()).toHaveLength(2);
    });
  });
});

describe("ann.syncReleasePages — non-English distributors (#48)", () => {
  it("skips a French or German house as out of English scope instead of reporting a missing publisher", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const KANA: FixtureManga = {
      id: 777,
      title: "Some Manga",
      releases: [
        { annId: 7001, date: "2010-01-01", designator: "GN 1" },
        { annId: 7002, date: "2011-01-01", designator: "GN 1", title: "Some Manga (Kana)" },
      ],
    };
    stubAnn([KANA], {
      7002: releasePage({ title: "Some Manga", volume: "1", distributor: "Kana", date: "2011-01-01", isbn13: "9782505000013", mangaId: 777 }),
      7001: releasePage({ title: "Some Manga", volume: "1", distributor: "Toyspress, Inc.", date: "2010-01-01", isbn13: "9784900000001", mangaId: 777 }),
    });
    await sync(t, { releasePages: false });
    // Without the publisher rows, nothing places; seed them as the cadence tick would.
    await t.mutation(internal.launch.seedPublishers, {});
    await syncPages(t);
    expect((await obsFor(t, 7002))?.conflicts?.[0]?.reason).toMatch(/another language: out of English scope/);
    // The Toyspress line places now that the row exists.
    expect((await obsFor(t, 7001))?.recordRef?.type).toBe("release");
  });
});

describe("ann.sync — a title match that is another work", () => {
  /** A publisher-fed Series with one Release carrying `isbn13`. */
  async function seedSeriesWithBook(
    t: TestT,
    title: string,
    altTitles: string[],
    isbn13: string,
  ) {
    const { seriesId } = await t.run((ctx) =>
      seedCatalog(ctx, {
        publisher: { name: "Seven Seas Entertainment", slug: "seven-seas" },
        series: { title, altTitles },
        release: { isbn13 },
      }),
    );
    return seriesId;
  }

  const linkOf = (t: TestT, mangaId: number) =>
    t.run(async (ctx) =>
      (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === `manga:${mangaId}`,
      )?.recordRef,
    );

  it("never links a parent work to its spinoff through an alt title when their books differ", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Seven Seas' Citrus+ carries ANN's "Citrus Plus" as an alt title.
    const spinoff = await seedSeriesWithBook(t, "Citrus+", ["Citrus Plus"], "9781645052722");
    stubAnn([
      {
        id: 15835,
        title: "Citrus",
        altTitles: [{ lang: "EN", text: "Citrus Plus" }],
        releases: [{ annId: 50001, date: "2016-01-12", designator: "GN 1", ean: "9781626922617" }],
      },
    ]);
    await sync(t, { releasePages: false });
    const link = await linkOf(t, 15835);
    expect(link?.type).toBe("series");
    expect(link?.id).not.toBe(spinoff);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(link!.id as Id<"series">))?.title).toBe("Citrus");
      // The spinoff keeps only its own Volume.
      const spinoffVolumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", spinoff))
        .collect();
      expect(spinoffVolumes.map((v) => v.label)).toEqual(["1"]);
    });
  });

  it("never links two same-titled works by different creators", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Tonogai's Doubt, already credited from its own ANN entry.
    const tonogai = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Doubt" });
      const personId = await ctx.db.insert("people", {
        publicId: 711,
        name: "Yoshiki Tonogai",
        annId: "4001",
        seriesCount: 1,
        coverUrl: null,
        coverIsbn: null,
      });
      await ctx.db.insert("seriesCredits", { seriesId, personId, role: "story_art", rebuiltAt: 0 });
      return seriesId;
    });
    stubAnn([
      {
        id: 3337,
        title: "Doubt!!",
        staff: [{ id: 4002, name: "Kaneyoshi Izumi" }],
        releases: [{ annId: 50002, date: "2005-04-05", designator: "GN 1" }],
      },
    ]);
    await sync(t, { releasePages: false });
    const link = await linkOf(t, 3337);
    expect(link?.id).not.toBe(tonogai);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(link!.id as Id<"series">))?.title).toBe("Doubt!!");
    });
  });

  it("still links when one of the entry's ISBNs is already a book of the Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const series = await seedSeriesWithBook(t, "Citrus", [], "9781626922617");
    stubAnn([
      {
        id: 15835,
        title: "Citrus",
        releases: [
          { annId: 50001, date: "2016-01-12", designator: "GN 1", ean: "9781626922617" },
          { annId: 50003, date: "2016-05-10", designator: "GN 2", ean: "9781626922990" },
        ],
      },
    ]);
    await sync(t, { releasePages: false });
    expect(await linkOf(t, 15835)).toEqual({ type: "series", id: series });
  });

  /** An ANN entry with one GN 1 line. */
  const entry = (id: number, title: string, ean?: string, altTitles: string[] = []): FixtureManga => ({
    id,
    title,
    altTitles: altTitles.map((text) => ({ lang: "EN", text })),
    releases: [{ annId: id + 1, date: "2016-01-12", designator: "GN 1", ...(ean ? { ean } : {}) }],
  });

  it("links a second ANN entry of the title when one of its ISBNs is already a book of the Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const series = await seedSeriesWithBook(t, "Citrus", [], "9781626922617");
    stubAnn([entry(15835, "Citrus", "9781626922617"), entry(15837, "Citrus", "9781626922617")]);
    await sync(t, { releasePages: false });
    expect(await linkOf(t, 15835)).toEqual({ type: "series", id: series });
    expect(await linkOf(t, 15837)).toEqual({ type: "series", id: series });
  });

  it("links by title a Series whose other ANN entry is withdrawn", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([entry(15835, "Citrus")]);
    await sync(t, { releasePages: false });
    const held = await linkOf(t, 15835);
    // ANN drops the entry; a complete mirror withdraws it.
    stubAnn([BETA]);
    await sync(t, { releasePages: false });
    stubAnn([BETA, entry(15837, "Citrus")]);
    await sync(t, { releasePages: false });
    expect(await linkOf(t, 15837)).toEqual(held);
  });

  it("links by title a Series nobody holds whose only ISBN is digital, for a print-only entry", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const { seriesId } = await t.run((ctx) =>
      seedCatalog(ctx, {
        publisher: { name: "Seven Seas Entertainment", slug: "seven-seas" },
        series: { title: "Citrus", altTitles: [] },
        release: { isbn13: "9781626922617", format: "digital" },
      }),
    );
    // workMatch compares books of a format both list; a digital book says
    // nothing about a print-only entry, so the title links.
    stubAnn([entry(15835, "Citrus", "9781626922600")]);
    await sync(t, { releasePages: false });
    expect(await linkOf(t, 15835)).toEqual({ type: "series", id: seriesId });
  });

  it("never links through an alt title a Series another live ANN entry holds", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([entry(20001, "Citrus Plus")]);
    await sync(t, { releasePages: false });
    const held = await linkOf(t, 20001);
    stubAnn([entry(20001, "Citrus Plus"), entry(15835, "Citrus", undefined, ["Citrus Plus"])]);
    await sync(t, { releasePages: false });
    const link = await linkOf(t, 15835);
    expect(link?.id).not.toBe(held?.id);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(link!.id as Id<"series">))?.title).toBe("Citrus");
      // The title names no Series, so nothing is flagged.
      expect(await ctx.db.query("duplicateCandidates").collect()).toEqual([]);
    });
  });

  describe("two entries of one title by one creator (the Alchemist)", () => {
    // ANN's two entries as they stand: the first manga and its sequel,
    // which has an entry of its own under the same main title. Both credit
    // Usata Nonohara as the original creator, so only their books tell them
    // apart. Line ids, dates and person ids are stand-ins.
    const TITLE = "The Alchemist Who Survived Now Dreams of a Quiet City Life";
    const SEQUEL_LINE = `${TITLE} II: Cycle of the Elixir`;
    const FIRST: FixtureManga = {
      id: 22380,
      title: TITLE,
      altTitles: [
        { lang: "JA", text: "Ikinokori Renkinjutsushi wa Machi de Shizuka ni Karashitai" },
        { lang: "EN", text: "The Survived Alchemist With a Dream of Quiet Town Life" },
        { lang: "JA", text: "生き残り錬金術師は街で静かに暮らしたい" },
      ],
      staff: [
        { id: 5001, name: "Usata Nonohara", task: "Original creator" },
        { id: 5002, name: "Guru Mizoguchi", task: "Art" },
      ],
      releases: [
        { annId: 60001, date: "2021-01-19", designator: "eBook 1", ean: "9781975331306" },
        { annId: 60002, date: "2021-03-23", designator: "GN 1", ean: "9781975384272" },
        { annId: 60003, date: "2021-09-21", designator: "GN 2", ean: "9781975308537" },
      ],
    };
    const SEQUEL: FixtureManga = {
      id: 30340,
      title: TITLE,
      altTitles: [
        { lang: "JA", text: "Ikinokori Renkinjutsushi wa Machi de Shizuka ni Kurashitai: Rinkan no Mahōyaku" },
        { lang: "JA", text: "生き残り錬金術師は街で静かに暮らしたい ～輪環の魔法薬～" },
      ],
      staff: [
        { id: 5001, name: "Usata Nonohara", task: "Original creator" },
        { id: 5003, name: "Aya Obara", task: "Art" },
      ],
      releases: [
        { annId: 60011, date: "2024-03-26", designator: "GN 1", ean: "9781975393489", title: SEQUEL_LINE },
        { annId: 60012, date: "2024-12-10", designator: "GN 2", ean: "9781975396923", title: SEQUEL_LINE },
        { annId: 60013, date: "2025-08-19", designator: "GN 3", ean: "9798855416176", title: SEQUEL_LINE },
      ],
    };
    const FIRST_ISBNS = FIRST.releases.map((r) => r.ean!);
    const SEQUEL_ISBNS = SEQUEL.releases.map((r) => r.ean!);
    const PAGES = Object.fromEntries(
      [FIRST, SEQUEL].flatMap((entry) =>
        entry.releases.map((r) => [
          r.annId,
          releasePage({
            title: r.title ?? entry.title,
            volume: r.designator,
            distributor: "Yen Press",
            date: r.date,
            isbn13: r.ean!,
            mangaId: entry.id,
          }),
        ]),
      ),
    );

    /** Import `entries` (the ones already imported stay listed), then its page pass and credits. */
    async function importEntries(t: TestT, entries: FixtureManga[]) {
      stubAnn(entries, PAGES);
      await sync(t, { releasePages: false });
      await syncPages(t);
      await t.action(internal.people.rebuild, {});
    }

    /** Each entry's Series, and the ISBNs on the Volumes of that Series. */
    const placement = (t: TestT) =>
      t.run(async (ctx) => {
        const seriesOf = async (entry: FixtureManga) => {
          const ref = (await ctx.db.query("sourceObservations").collect()).find(
            (o) => o.sourceRecordId === `manga:${entry.id}`,
          )?.recordRef;
          return ref?.type === "series" ? ref.id : null;
        };
        const isbnsOn = async (seriesId: Id<"series"> | null) => {
          const isbns: string[] = [];
          for (const release of await ctx.db.query("releases").collect()) {
            const coverage = await ctx.db
              .query("volumeCoverages")
              .withIndex("by_edition", (q) => q.eq("editionId", release.editionId))
              .collect();
            for (const row of coverage) {
              const volume = await ctx.db.get(row.volumeId);
              if (volume?.seriesId === seriesId && release.isbn13) isbns.push(release.isbn13);
            }
          }
          return isbns.sort();
        };
        const first = await seriesOf(FIRST);
        const sequel = await seriesOf(SEQUEL);
        return {
          series: (await ctx.db.query("series").collect()).length,
          first,
          sequel,
          onFirst: await isbnsOn(first),
          onSequel: await isbnsOn(sequel),
        };
      });

    it.each([
      ["the first work, then the sequel", [FIRST, SEQUEL]],
      ["the sequel, then the first work", [SEQUEL, FIRST]],
    ] as const)("keeps them apart when %s arrives with its books placed", async (_, [earlier, later]) => {
      const t = makeT();
      await seedRegistry(t, true);
      await seedPublisher(t, "Yen Press", "yen-press");
      await importEntries(t, [earlier]);
      await importEntries(t, [earlier, later]);

      // workMatch: one creator in common decides nothing, and the two
      // entries' print ISBNs share none, so the later one is another work.
      const placed = await placement(t);
      expect(placed.series).toBe(2);
      expect(placed.sequel).not.toBe(placed.first);
      expect(placed.onFirst).toEqual([...FIRST_ISBNS].sort());
      expect(placed.onSequel).toEqual([...SEQUEL_ISBNS].sort());
      // The pair is on the Data Team's duplicate list.
      expect(await t.run((ctx) => ctx.db.query("duplicateCandidates").collect())).toHaveLength(1);
    });

    // A fresh seed: ANN's Series has no book until the page pass after the
    // mirror, so the later entry finds the earlier one's Series by title
    // with nothing on it. Only the ANN entry already holding that Series
    // keeps them apart.
    it.each([
      ["the first work, then the sequel", [FIRST, SEQUEL]],
      ["the sequel, then the first work", [SEQUEL, FIRST]],
    ] as const)("keeps them apart on an empty catalog when one mirror lists %s", async (_, [earlier, later]) => {
      const t = makeT();
      await seedRegistry(t, true);
      await seedPublisher(t, "Yen Press", "yen-press");
      await importEntries(t, [earlier, later]);

      const placed = await placement(t);
      expect(placed.series).toBe(2);
      expect(placed.sequel).not.toBe(placed.first);
      expect(placed.onFirst).toEqual([...FIRST_ISBNS].sort());
      expect(placed.onSequel).toEqual([...SEQUEL_ISBNS].sort());
      const held = earlier === FIRST ? placed.first : placed.sequel;
      await t.run(async (ctx) => {
        const { publicId } = (await ctx.db.get(held!))!;
        expect(await ctx.db.query("duplicateCandidates").collect()).toEqual([
          expect.objectContaining({
            aId: held,
            reason: `ANN entry ${later.id} has this title, but ANN entry ${earlier.id} already holds Series ${publicId}, so the import created a Series of its own. Merge them if ANN lists one work twice.`,
          }),
        ]);
      });
    });
  });
});

describe("ann — a single-volume line never lands on packaging or a split part (B07)", () => {
  const DELTA: FixtureManga = {
    id: 1500,
    title: "Delta Drift",
    releases: [
      { annId: 71001, date: "2024-03-05", designator: "GN 1", ean: "9781974700011" },
      { annId: 71002, date: "2024-06-04", designator: "GN 2", ean: "9781974700028" },
    ],
  };
  const PAGES = {
    71001: releasePage({
      title: "Delta Drift",
      volume: "GN 1",
      distributor: "Viz Media",
      date: "2024-03-05",
      isbn13: "9781974700011",
      mangaId: 1500,
    }),
  };

  /** A VIZ Edition over the given Volumes with one physical Release. */
  async function seedEdition(
    t: TestT,
    labels: string[],
    opts: { extent?: "complete" | "partial"; isbn13?: string } = {},
  ) {
    return await t.run(async (ctx) => {
      const publisher = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "viz-media"))
        .unique();
      const publisherId = publisher?._id ?? (await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" }));
      return await insertBook(ctx, publisherId, labels, { extent: opts.extent, release: { isbn13: opts.isbn13 } });
    });
  }

  it("creates Volume 1's own Release instead of giving its ISBN to an ISBN-less omnibus", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([DELTA], PAGES);
    await sync(t, { releasePages: false });
    const omnibus = await seedEdition(t, ["1", "2"]);
    await syncPages(t);
    const placed = (await obsFor(t, 71001))!.recordRef;
    expect(placed?.type).toBe("release");
    expect(placed?.id).not.toBe(omnibus);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(omnibus))!.isbn13).toBeUndefined();
      const release = (await ctx.db.get(placed!.id as Id<"releases">))!;
      expect(release.isbn13).toBe("9781974700011");
    });
  });

  it("an omnibus carrying its own ISBN never blocks the ordinary Release", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([DELTA], PAGES);
    await sync(t, { releasePages: false });
    await seedEdition(t, ["1", "2"], { isbn13: "9781974799909" });
    await syncPages(t);
    const observation = (await obsFor(t, 71001))!;
    expect(observation.conflicts?.find((c) => c.field === "placement")).toBeUndefined();
    expect(observation.recordRef?.type).toBe("release");
  });

  it("neither the page pass nor the mirror links a whole Volume onto a split part", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([DELTA], PAGES);
    await sync(t, { releasePages: false });
    const part = await seedEdition(t, ["1"], { extent: "partial" });
    // The mirror's label link (matchReleaseInSeries) skips the part...
    await sync(t, { releasePages: false });
    expect((await obsFor(t, 71001))!.recordRef).toBeUndefined();
    // ...and so does the page pass, which creates the whole Volume's book.
    await syncPages(t);
    const placed = (await obsFor(t, 71001))!.recordRef;
    expect(placed?.type).toBe("release");
    expect(placed?.id).not.toBe(part);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(part))!.isbn13).toBeUndefined();
    });
  });
});

// ANN release pages carry a Description (publisher copy entered by ANN
// contributors): the Release Description at ANN's weak rank, filling blanks
// only — on create, on link, and by a one-time refetch of lines linked
// before their page was read for one.
describe("ann — release-page descriptions", () => {
  const BLURB = "In a world of pirates, one man wants to become the greatest of them all.";
  const LINES: FixtureManga = {
    id: 1223,
    title: "One Piece",
    releases: [
      { annId: 10948, date: "2003-06-01", designator: "GN 1", ean: "9781569319017" },
      { annId: 10949, date: "2003-09-01", designator: "GN 2", ean: "9781569319024" },
      { annId: 10950, date: "2003-12-01", designator: "GN 3", ean: "9781569319031" },
    ],
  };
  const pageFor = (annId: number, description?: string) => {
    const line = LINES.releases.find((r) => r.annId === annId)!;
    return releasePage({
      title: "One Piece",
      volume: line.designator,
      distributor: "Viz Media",
      date: line.date,
      isbn13: line.ean!,
      mangaId: 1223,
      description,
    });
  };
  const describedPages = {
    10948: pageFor(10948, `${BLURB}<br>\n<br>\nStory and art by Eiichiro Oda.`),
    10949: pageFor(10949, "Volume two."),
    10950: pageFor(10950, "Volume three."),
  };
  /** Each Volume's Release Description once describedPages filled it (the cleaner drops the trailing credit). */
  const FILLED: Record<string, string> = {
    "1": BLURB,
    "2": "Volume two.",
    "3": "Volume three.",
  };

  /**
   * Mirror LINES, then give each listed volume a VIZ Release carrying its
   * line's ISBN (as a publisher feed would) and mirror again so the lines
   * link by ISBN — with no page fetched yet.
   */
  async function linkedCatalog(
    t: TestT,
    pages: Record<number, string>,
    books: Array<{ label: string; description?: string; overridden?: true; sevenSeas?: true }>,
  ) {
    await seedRegistry(t, true);
    stubAnn([LINES], pages);
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    const ids = await t.run(async (ctx) => {
      const made: Record<string, Id<"releases">> = {};
      for (const book of books) {
        const id = await insertBook(ctx, vizId, [book.label], {
          release: {
            isbn13: LINES.releases.find((r) => r.designator === `GN ${book.label}`)!.ean,
            ...(book.description !== undefined ? { description: book.description } : {}),
            ...(book.overridden ? { overriddenFields: ["description"] } : {}),
          },
        });
        if (book.sevenSeas) {
          await insertSourceRevision(ctx, {
            ref: { type: "release", id },
            sourceKey: "sevenseas",
            changes: [{ field: "description", after: book.description }],
            comment: "Imported from Seven Seas Entertainment.",
          });
        }
        made[book.label] = id;
      }
      return made;
    });
    await sync(t, { releasePages: false });
    for (const r of LINES.releases.filter((line) => books.some((b) => `GN ${b.label}` === line.designator))) {
      expect((await obsFor(t, r.annId))!.recordRef?.type).toBe("release");
    }
    pageRequests.length = 0;
    return ids;
  }

  // null when blank (t.run returns undefined as null).
  const descriptionOf = (t: TestT, id: Id<"releases">) =>
    t.run(async (ctx) => (await ctx.db.get(id))!.description ?? null);

  it("a Release created from a release page carries its Description", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([LINES], describedPages);
    await sync(t, { releasePages: false });
    await seedPublisher(t, "VIZ Media", "viz-media");
    await syncPages(t);
    const obs = (await obsFor(t, 10948))!;
    expect(obs.snapshot).toMatchObject({
      page: { status: "ok", descriptionChecked: true, description: BLURB },
    });
    // ANN's credit sentence is dropped: the byline shows it.
    expect(await descriptionOf(t, obs.recordRef!.id as Id<"releases">)).toBe(BLURB);
  });

  it("a Release the page pass links fills a blank description", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([LINES], describedPages);
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    // VIZ's GN 2 without an ISBN: the page pass links it rather than creating.
    const existing = await t.run((ctx) => insertBook(ctx, vizId, ["2"]));
    await syncPages(t);
    expect((await obsFor(t, 10949))!.recordRef).toEqual({ type: "release", id: existing });
    expect(await descriptionOf(t, existing)).toBe("Volume two.");
  });

  it("fills a linked Release with none, and keeps a publisher's text and a Human Override", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [
      { label: "1" },
      { label: "2", description: "The publisher's copy.", sevenSeas: true },
      { label: "3", overridden: true },
    ]);
    const result = await syncPages(t);
    expect(result).toMatchObject({ fetched: 1, continued: false, errorCount: 0 });
    // Only the blank, override-free Release's page is worth a fetch.
    expect(pageRequests).toEqual(["10948"]);
    expect(await descriptionOf(t, ids["1"]!)).toBe(BLURB);
    expect(await descriptionOf(t, ids["2"]!)).toBe("The publisher's copy.");
    expect(await descriptionOf(t, ids["3"]!)).toBeNull();
    await t.run(async (ctx) => {
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", ids["1"]!))
        .collect();
      expect(revisions.at(-1)).toMatchObject({
        author: { kind: "source", sourceKey: "ann" },
        changes: [{ field: "description" }],
        citation: { url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=10948" },
      });
    });
    // Filled: the next pass leaves the line alone.
    pageRequests.length = 0;
    await syncPages(t);
    expect(pageRequests).toEqual([]);
  });

  it("refetches a linked line's page exactly once, and not again after a page with no Description", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, { 10948: pageFor(10948) }, [{ label: "1" }]);
    // GN 2 and 3 are unlinked: the pass fetches their (404) pages to place them.
    const linkedFetches = () => pageRequests.filter((id) => id === "10948");
    await syncPages(t);
    expect(linkedFetches()).toEqual(["10948"]);
    expect(await descriptionOf(t, ids["1"]!)).toBeNull();
    const page = () =>
      obsFor(t, 10948).then((obs) => (obs!.snapshot as { page?: Record<string, unknown> }).page);
    expect(await page()).toMatchObject({ status: "ok", descriptionChecked: true });
    expect((await page())!.description).toBeUndefined();

    pageRequests.length = 0;
    await syncPages(t);
    expect(linkedFetches()).toEqual([]);

    // A page stored before descriptions were read is fetched once more.
    const obs = (await obsFor(t, 10948))!;
    await t.run(async (ctx) => {
      const snapshot = obs.snapshot as { page: Record<string, unknown> };
      const { descriptionChecked: _, ...older } = snapshot.page;
      await ctx.db.patch(obs._id, { snapshot: { ...snapshot, page: older } });
    });
    await syncPages(t);
    expect(linkedFetches()).toEqual(["10948"]);
    pageRequests.length = 0;
    await syncPages(t);
    expect(linkedFetches()).toEqual([]);
  });

  const backfill = (t: TestT, args: object = {}) =>
    t.action(internal.ann.backfillDescriptions, { politeDelayMs: 0, ...args });

  it("the backfill fetches up to its limit, finishes on rerun, and targets given ids", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    // An operator command: it runs on a disabled source too.
    await t.mutation(internal.importSources.setEnabledInternal, { key: "ann", enabled: false });

    expect(await backfill(t, { limit: 2 })).toEqual({
      fetched: 2,
      filled: 2,
      errors: [],
      continued: false,
    });
    expect(pageRequests).toHaveLength(2);
    const blanks = async () =>
      (await Promise.all(Object.values(ids).map((id) => descriptionOf(t, id)))).filter(
        (d) => d === null,
      ).length;
    expect(await blanks()).toBe(1);

    pageRequests.length = 0;
    expect(await backfill(t)).toMatchObject({ fetched: 1, filled: 1 });
    expect(await blanks()).toBe(0);
    pageRequests.length = 0;
    expect(await backfill(t)).toMatchObject({ fetched: 0, filled: 0 });
    expect(pageRequests).toEqual([]);

    // Targeted: exactly the named pages, checked or not; the fill rule holds.
    expect(await backfill(t, { annIds: ["10949", "x", "10949"] })).toMatchObject({
      fetched: 1,
      filled: 0,
    });
    expect(pageRequests).toEqual(["10949"]);
    expect(await descriptionOf(t, ids["2"]!)).toBe("Volume two.");
  });

  /** Advance the clock a minute per read, so a link's time budget runs out. */
  function slowClock() {
    let now = Date.now();
    return vi.spyOn(Date, "now").mockImplementation(() => (now += 61_000));
  }
  async function runScheduled(t: TestT) {
    vi.restoreAllMocks();
    await drain(t);
  }
  const pageOf = async (t: TestT, annId: number) =>
    ((await obsFor(t, annId))!.snapshot as { page?: Record<string, unknown> }).page;

  it("a Description stored while the line was unlinked reaches the Release linked later", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([LINES], describedPages);
    await sync(t, { releasePages: false });
    // No publisher row yet: the pages are read and held, text stored.
    await syncPages(t);
    expect(await pageOf(t, 10949)).toMatchObject({ description: "Volume two.", descriptionChecked: true });
    expect((await obsFor(t, 10949))!.recordRef).toBeUndefined();

    // Another source creates the book; the next mirror links it by ISBN.
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    const releaseId = await t.run((ctx) => insertBook(ctx, vizId, ["2"], { release: { isbn13: "9781569319024" } }));
    pageRequests.length = 0;
    await sync(t, { releasePages: false });
    expect((await obsFor(t, 10949))!.recordRef).toEqual({ type: "release", id: releaseId });
    expect(await descriptionOf(t, releaseId)).toBe("Volume two.");

    // Blank again (an override cleared, say): the backfill offers the
    // stored text without a fetch.
    await t.run(async (ctx) => ctx.db.patch(releaseId, { description: undefined }));
    expect(await backfill(t)).toMatchObject({ fetched: 0, filled: 1 });
    expect(pageRequests).toEqual([]);
    expect(await descriptionOf(t, releaseId)).toBe("Volume two.");
  });

  it("caps description refetches per page-pass run", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    await syncPages(t, { maxRefetches: 2, maxFetches: 1 });
    await drain(t);
    // Across the run's links: two refetches, the third waits for the next run.
    expect(pageRequests).toHaveLength(2);
    const blank = async () =>
      (await Promise.all(Object.values(ids).map((id) => descriptionOf(t, id)))).filter((d) => d === null);
    expect(await blank()).toHaveLength(1);
    pageRequests.length = 0;
    await syncPages(t, { maxRefetches: 2 });
    expect(pageRequests).toHaveLength(1);
    expect(await blank()).toHaveLength(0);
  });

  it("the page pass hands off when a link runs out of time", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    slowClock();
    expect(await syncPages(t)).toMatchObject({ continued: true, fetched: 1 });
    await expectStampedAtHandOff(t);
    await runScheduled(t);
    // Each of this test's pages exactly once (a late timer from an earlier
    // test can add another fixture's id to the shared log).
    expect(pageRequests.filter((id) => id.startsWith("1094") || id === "10950").sort()).toEqual([
      "10948",
      "10949",
      "10950",
    ]);
    for (const [label, id] of Object.entries(ids)) expect(await descriptionOf(t, id), label).toBe(FILLED[label]);
  });

  it("the backfill continues after its time budget without repeating a page", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    slowClock();
    expect(await backfill(t)).toMatchObject({ fetched: 1, filled: 1, continued: true });
    await runScheduled(t);
    // Each of this test's pages exactly once (a late timer from an earlier
    // test can add another fixture's id to the shared log).
    expect(pageRequests.filter((id) => id.startsWith("1094") || id === "10950").sort()).toEqual([
      "10948",
      "10949",
      "10950",
    ]);
    for (const [label, id] of Object.entries(ids)) expect(await descriptionOf(t, id), label).toBe(FILLED[label]);
  });

  it("the backfill refuses to run beside an ANN Import Run", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    const result = await backfill(t);
    expect(result).toMatchObject({ fetched: 0, filled: 0, continued: false });
    expect(result.stopped).toMatch(/ANN Import Run .*last active \d+ min ago\) is running/);
    expect(pageRequests).toEqual([]);
  });

  // The shared policy (lib/importRuns.ts isStranded): quiet time since the
  // run's last gate pass, not its age.
  it("the backfill holds off for an hours-old run that passed the gate recently", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    const later = Date.now() + 13 * 60 * 60 * 1000;
    await t.run((ctx) => ctx.db.patch(runId, { lastActivityAt: later - 5 * 60_000 }));
    vi.spyOn(Date, "now").mockImplementation(() => later);
    const result = await backfill(t);
    expect(result.stopped).toMatch(/ANN Import Run .*last active 5 min ago\) is running/);
    expect(pageRequests).toEqual([]);
    vi.restoreAllMocks();
  });

  it("the backfill treats a run quiet for over 60 minutes as stranded", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    const later = Date.now() + 61 * 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await backfill(t);
    expect(result).toMatchObject({ fetched: 1, filled: 1 });
    expect(result.stopped).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignoring stranded ANN Import Run .* \(last active 1 h 1 min ago\)/));
    vi.restoreAllMocks();
  });

  // A backfill action deployed before heartbeats passes `now` and holds off
  // while `ageMs` is at most 12 hours.
  it("answers a backfill deployed before heartbeats with the time since the run was last active", async () => {
    const t = makeT();
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    const opened = Date.now();
    await t.run((ctx) => ctx.db.patch(runId, { lastActivityAt: opened + 20 * 60 * 60_000 }));
    const now = opened + 20 * 60 * 60_000 + 5 * 60_000;
    expect(await t.query(internal.ann.annRunInProgress, { now })).toMatchObject({ runId, ageMs: 5 * 60_000 });
    expect(await t.query(internal.ann.annRunInProgress, {})).not.toHaveProperty("ageMs");
  });

  it("the backfill treats a run opened before heartbeats as stranded only past 12 hours", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    const opened = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("importRuns", { sourceKey: "ann", status: "running", recordsSeen: 0, recordsChanged: 0, errors: [] }),
    );
    const clock = vi.spyOn(Date, "now").mockImplementation(() => opened + 11 * 60 * 60 * 1000);
    expect((await backfill(t)).stopped).toMatch(/last active 11 h 0 min ago\) is running/);
    clock.mockImplementation(() => opened + 13 * 60 * 60 * 1000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await backfill(t)).toMatchObject({ fetched: 1, filled: 1 });
    vi.restoreAllMocks();
  });

  it("the backfill's breaker counts failures across hand-offs and logs its stop", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      pageRequests.push(String(input));
      return new Response("Forbidden", { status: 403 });
    });
    const clock = slowClock();
    expect(await backfill(t, { annIds: ["1", "2", "3", "4", "5", "6", "7"] })).toMatchObject({
      fetched: 1,
      continued: true,
    });
    clock.mockRestore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await drain(t);
    // One failure in the first link, four in the next: five in a row, stop.
    expect(pageRequests).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/backfillDescriptions\] stopped: ANN looks down: 5 page fetches/),
    );
    warn.mockRestore();
  });

  it("the backfill keeps stored pages on failed fetches and stops when ANN is down", async () => {
    const t = makeT();
    const plain = { 10948: pageFor(10948), 10949: pageFor(10949), 10950: pageFor(10950) };
    await linkedCatalog(t, plain, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    // Pages read before descriptions were: ok, never checked.
    await syncPages(t);
    for (const annId of [10948, 10949, 10950]) {
      const obs = (await obsFor(t, annId))!;
      const snapshot = obs.snapshot as { page: Record<string, unknown> };
      const { descriptionChecked: _, ...older } = snapshot.page;
      await t.run(async (ctx) => ctx.db.patch(obs._id, { snapshot: { ...snapshot, page: older } }));
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      pageRequests.push(String(input));
      return new Response("Forbidden", { status: 403 });
    });
    pageRequests.length = 0;
    const walk = await backfill(t);
    expect(walk).toMatchObject({ fetched: 3, filled: 0 });
    expect(walk.stopped).toBeUndefined();
    expect(await pageOf(t, 10948)).toMatchObject({
      status: "ok",
      isbn13: "9781569319017",
      refetchFailed: { status: "error" },
    });
    // The failed refetch waits out its retry window.
    expect(await backfill(t)).toMatchObject({ fetched: 0 });

    const many = ["10948", "10949", "10950", "1", "2", "3", "4"];
    const result = await backfill(t, { annIds: many });
    expect(result).toMatchObject({ fetched: 5, continued: false });
    expect(result.stopped).toMatch(/ANN looks down/);
  });

  it("the backfill never un-withdraws a line", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    const obs = (await obsFor(t, 10948))!;
    await t.run(async (ctx) => ctx.db.patch(obs._id, { withdrawn: true }));
    await backfill(t, { annIds: ["10948"] });
    const after = (await obsFor(t, 10948))!;
    expect(after.withdrawn).toBe(true);
    expect(after.snapshot).toEqual(obs.snapshot);
  });

  /** Put a page Description written by an older cleaner back on a line and its Release. */
  async function storeOldText(t: TestT, annId: number, text: string, release?: Id<"releases">) {
    const obs = (await obsFor(t, annId))!;
    const snapshot = obs.snapshot as { page?: Record<string, unknown> };
    await t.run(async (ctx) => {
      await ctx.db.patch(obs._id, {
        snapshot: {
          ...snapshot,
          page: { status: "ok", fetchedAt: 1, descriptionChecked: true, ...snapshot.page, description: text },
        },
      });
      if (release !== undefined) await ctx.db.patch(release, { description: text });
    });
  }
  const repair = (t: TestT) => t.action(internal.ann.repairDescriptions, {});
  const inReview = (t: TestT) =>
    t.run(async (ctx) => (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview").length);

  it("a stale stored Description is cleaned before the link path writes it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([LINES], describedPages);
    await sync(t, { releasePages: false });
    await syncPages(t);
    // Stored before the cleaner dropped credit sentences.
    await storeOldText(t, 10949, "Volume two. Story and art by Someone Else.");
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    const releaseId = await t.run((ctx) => insertBook(ctx, vizId, ["2"], { release: { isbn13: "9781569319024" } }));
    await sync(t, { releasePages: false });
    expect(await descriptionOf(t, releaseId)).toBe("Volume two.");
  });

  it("the repair re-cleans stored text and fixes Releases still showing ANN's old text", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [
      { label: "1" },
      { label: "2" },
      { label: "3", overridden: true },
    ]);
    await syncPages(t);
    // What production stored before this cleaner.
    await storeOldText(t, 10948, `${BLURB} Story and art by Eiichiro Oda.`, ids["1"]);
    await storeOldText(t, 10949, "Submit your own review of this item.", ids["2"]);
    await storeOldText(t, 10950, "Story and art by Yonezou Nekota.");
    await t.run(async (ctx) => ctx.db.patch(ids["3"]!, { description: "Story and art by Yonezou Nekota." }));
    const proposalsBefore = await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length);

    expect(await repair(t)).toEqual({
      scanned: 3,
      snapshotFixed: 3,
      releaseUpdated: 1,
      releaseCleared: 1,
      errors: 0,
      continued: false,
    });
    expect(await descriptionOf(t, ids["1"]!)).toBe(BLURB);
    expect(await descriptionOf(t, ids["2"]!)).toBeNull();
    // A Human Override keeps its text; only the snapshot is re-read.
    expect(await descriptionOf(t, ids["3"]!)).toBe("Story and art by Yonezou Nekota.");
    expect(await pageOf(t, 10950)).not.toHaveProperty("description");
    expect(await pageOf(t, 10948)).toMatchObject({ description: BLURB, descriptionChecked: true });
    expect(await inReview(t)).toBe(0);
    await t.run(async (ctx) => {
      // One approved ANN Proposal per repaired Release, nothing else.
      expect((await ctx.db.query("proposals").collect()).length).toBe(proposalsBefore + 2);
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", ids["2"]!))
        .collect();
      expect(revisions.at(-1)).toMatchObject({
        author: { kind: "source", sourceKey: "ann" },
        changes: [{ field: "description", before: "Submit your own review of this item." }],
        citation: { url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=10949" },
      });
    });

    // Rerun: clean text cleans to itself.
    expect(await repair(t)).toMatchObject({ snapshotFixed: 0, releaseUpdated: 0, releaseCleared: 0 });
    // A publisher's text (its own Revision), even one ending in a credit
    // the cleaner would drop, is never ANN's to repair.
    const publisherCopy = "The publisher's copy. Story and art by Eiichiro Oda.";
    await storeOldText(t, 10948, `${BLURB} Story and art by Eiichiro Oda.`);
    await sourceWrote(t, ids["1"]!, "sevenseas", publisherCopy);
    expect(await repair(t)).toMatchObject({ snapshotFixed: 1, releaseUpdated: 0, errors: 0 });
    expect(await descriptionOf(t, ids["1"]!)).toBe(publisherCopy);
  });

  /** A Revision by `sourceKey` setting the Release's description, as an import would. */
  async function sourceWrote(t: TestT, releaseId: Id<"releases">, sourceKey: string, text: string) {
    await t.run(async (ctx) => {
      await insertSourceRevision(ctx, {
        sourceKey,
        ref: { type: "release", id: releaseId },
        changes: [{ field: "description", after: text }],
      });
      await ctx.db.patch(releaseId, { description: text });
    });
  }

  it("a Release skipped while locked is repaired by a rerun once unlocked", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }]);
    await syncPages(t);
    await storeOldText(t, 10948, `${BLURB} Story and art by Eiichiro Oda.`, ids["1"]);
    await t.run(async (ctx) => ctx.db.patch(ids["1"]!, { locked: true }));
    expect(await repair(t)).toMatchObject({ snapshotFixed: 1, releaseUpdated: 0 });
    await t.run(async (ctx) => ctx.db.patch(ids["1"]!, { locked: false }));
    // The snapshot is clean now; the Release's own text still needs it.
    expect(await repair(t)).toMatchObject({ snapshotFixed: 0, releaseUpdated: 1 });
    expect(await descriptionOf(t, ids["1"]!)).toBe(BLURB);
  });

  it("only the line ANN's text came from repairs a Release two lines share", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }]);
    await syncPages(t);
    // 10949 wrote Release 2; 10948 (sorting first) also links to it and
    // its own stored text cleans to nothing.
    await storeOldText(t, 10949, "Volume two. Story and art by Someone Else.", ids["2"]);
    const shared = (await obsFor(t, 10948))!;
    await t.run(async (ctx) => ctx.db.patch(shared._id, { recordRef: { type: "release", id: ids["2"]! } }));
    await storeOldText(t, 10948, "Story and art by Yonezou Nekota.");
    expect(await repair(t)).toMatchObject({ releaseUpdated: 1, releaseCleared: 0, errors: 0 });
    expect(await descriptionOf(t, ids["2"]!)).toBe("Volume two.");
    // No conflict note left on the line that did not write the text.
    expect((await obsFor(t, 10948))!.conflicts ?? []).toEqual([]);
    expect(await inReview(t)).toBe(0);
  });

  it("one malformed line is counted and logged, and the walk goes on", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }]);
    await syncPages(t);
    const broken = (await obsFor(t, 10948))!;
    await t.run(async (ctx) =>
      ctx.db.patch(broken._id, {
        snapshot: { ...(broken.snapshot as object), page: { status: "ok", fetchedAt: 1, description: 42 } },
      }),
    );
    await storeOldText(t, 10949, "Volume two. Story and art by Someone Else.", ids["2"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await repair(t)).toMatchObject({ errors: 1, releaseUpdated: 1 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("[ann.repairDescriptions] line"));
    expect(await descriptionOf(t, ids["2"]!)).toBe("Volume two.");
  });

  it("the repair continues after its time budget", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }]);
    await syncPages(t);
    await storeOldText(t, 10948, `${BLURB} Story and art by Eiichiro Oda.`, ids["1"]);
    // More lines than one repair batch, sorting before release:10948.
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:0${String(i).padStart(4, "0")}`,
          snapshot: { kind: "annRelease", annId: `0${i}` },
        });
      }
    });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 6 * 60_000));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => void logs.push(message));
    expect(await repair(t)).toMatchObject({ scanned: 100, continued: true });
    clock.mockRestore();
    await drain(t);
    expect(await descriptionOf(t, ids["1"]!)).toBe(BLURB);
    // The chain's final counts reach the logs, not just the first link's CLI.
    const done = logs.at(-1)!;
    expect(done).toMatch(/^\[ann\.repairDescriptions\] done: /);
    expect(JSON.parse(done.slice(done.indexOf("{")))).toMatchObject({ scanned: 123, releaseUpdated: 1, errors: 0 });
  });

  describe("refresh, page bytes and refresh candidates", () => {
    it("refresh replaces ANN's own text, clears only with allowClear, and never touches anyone else's", async () => {
      const t = makeT();
      const ids = await linkedCatalog(t, describedPages, [
        { label: "1" },
        { label: "2", description: "The publisher's copy.", sevenSeas: true },
        { label: "3" },
      ]);
      await syncPages(t);
      // Cut by the old credit rule, as production stored it.
      await storeOldText(t, 10948, `${BLURB} Based on the series`, ids["1"]);
      stubAnn([LINES], {
        10948: pageFor(10948, `${BLURB} Based on the series created by Jon Favreau and written by Dave Filoni.`),
        10949: pageFor(10949, "ANN's text for two."),
        10950: pageFor(10950),
      });
      expect(await backfill(t, { annIds: ["10948", "10949", "10950"], refresh: true })).toMatchObject({
        fetched: 3,
        refreshed: 1,
        cleared: 0,
        held: 1,
        errors: [],
      });
      expect(await descriptionOf(t, ids["1"]!)).toBe(
        `${BLURB} Based on the series created by Jon Favreau and written by Dave Filoni.`,
      );
      // The publisher's text stays; a page with no description is held:
      // ANN's text stays until an operator allows clearing.
      expect(await descriptionOf(t, ids["2"]!)).toBe("The publisher's copy.");
      expect(await descriptionOf(t, ids["3"]!)).toBe("Volume three.");
      expect(await backfill(t, { annIds: ["10950"], refresh: true, allowClear: true })).toMatchObject({
        cleared: 1,
        refreshed: 0,
      });
      expect(await descriptionOf(t, ids["3"]!)).toBeNull();
      expect(await inReview(t)).toBe(0);

      // A Human Override is never refreshed.
      await t.run(async (ctx) => ctx.db.patch(ids["1"]!, { overriddenFields: ["description"] }));
      stubAnn([LINES], { 10948: pageFor(10948, "Newer text.") });
      expect(await backfill(t, { annIds: ["10948"], refresh: true })).toMatchObject({ refreshed: 0 });
      expect(await descriptionOf(t, ids["1"]!)).toContain("Jon Favreau");
    });

    it("refresh needs explicit annIds, and allowClear needs refresh", async () => {
      const t = makeT();
      await seedRegistry(t, true);
      await expect(backfill(t, { refresh: true })).rejects.toThrow(/refresh needs annIds/);
      await expect(backfill(t, { annIds: ["1"], allowClear: true })).rejects.toThrow(/only applies with refresh/);
    });

    it("refresh holds much shorter text, and skips locks, other lines, failed and missing pages", async () => {
      const t = makeT();
      const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
      await syncPages(t);
      // 10948: a degraded page with a stub of the text.
      // 10949: its Release is locked.
      // 10950: its Release's text came from another line (10948).
      await t.run(async (ctx) => ctx.db.patch(ids["2"]!, { locked: true }));
      const other = (await obsFor(t, 10950))!;
      await t.run(async (ctx) => ctx.db.patch(other._id, { recordRef: { type: "release", id: ids["1"]! } }));
      stubAnn([LINES], {
        10948: pageFor(10948, "In a world."),
        10949: pageFor(10949, "A newer text for volume two."),
        10950: pageFor(10950, "A newer text for volume three, from the other line."),
      });
      expect(await backfill(t, { annIds: ["10948", "10949", "10950"], refresh: true })).toMatchObject({
        refreshed: 0,
        cleared: 0,
        held: 1,
      });
      expect(await descriptionOf(t, ids["1"]!)).toBe(FILLED["1"]);
      expect(await descriptionOf(t, ids["2"]!)).toBe(FILLED["2"]);
      expect(await descriptionOf(t, ids["3"]!)).toBe(FILLED["3"]);

      // A failed fetch keeps the stored page and the text; a 404 too.
      await t.run(async (ctx) => ctx.db.patch(ids["2"]!, { locked: false }));
      const storedPage = await pageOf(t, 10949);
      vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));
      expect(await backfill(t, { annIds: ["10949"], refresh: true, allowClear: true })).toMatchObject({
        refreshed: 0,
        cleared: 0,
      });
      expect(await pageOf(t, 10949)).toMatchObject({
        status: "ok",
        description: storedPage!.description,
        refetchFailed: { status: "error" },
      });
      stubAnn([LINES], {});
      expect(await backfill(t, { annIds: ["10949"], refresh: true, allowClear: true })).toMatchObject({
        refreshed: 0,
        cleared: 0,
      });
      expect(await descriptionOf(t, ids["2"]!)).toBe(FILLED["2"]);
    });

    it("decodes a legacy Windows-1252 byte in ANN's UTF-8 page instead of storing U+FFFD", async () => {
      const t = makeT();
      await linkedCatalog(t, describedPages, [{ label: "1" }]);
      const encode = (text: string) => [...new TextEncoder().encode(text)];
      const [head, tail] = pageFor(10948, "Against Ber@hren.").split("@");
      vi.stubGlobal("fetch", async () => new Response(new Uint8Array([...encode(head!), 0xfc, ...encode(tail!)])));
      await backfill(t, { annIds: ["10948"] });
      expect(await pageOf(t, 10948)).toMatchObject({ description: "Against Berühren." });
    });

    it("lists the ANN ids whose Release text a refresh could fix, by reason", async () => {
      const t = makeT();
      const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
      await syncPages(t);
      await storeOldText(t, 10948, "To defeat his father! Created by Masashi Kishimoto and features", ids["1"]);
      await storeOldText(t, 10950, "Their love cannot be fulfilled. Or will it? Originally", ids["3"]);
      await storeOldText(t, 10949, "Pok\uFFFDmon game characters jump out.", ids["2"]);
      expect(await t.action(internal.ann.listRefreshCandidates, {})).toMatchObject({
        danglingEnd: ["10948", "10950"],
      });
      // Text ANN did not write is never listed.
      await sourceWrote(t, ids["3"]!, "sevenseas", "A cut publisher text and");
      expect(await t.action(internal.ann.listRefreshCandidates, {})).toEqual({
        danglingEnd: ["10948"],
        replacementChar: ["10949"],
        c1Control: [],
      });
    });

    it("the repair applies the new rules to stored text with no network", async () => {
      const t = makeT();
      const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }]);
      await syncPages(t);
      await storeOldText(t, 10948, "Book by Buronson", ids["1"]);
      await storeOldText(t, 10949, 'Dark Schneider\u0092s foe. Notes: Published in left-to-right "flipped" format.', ids["2"]);
      vi.stubGlobal("fetch", async () => {
        throw new Error("the repair never touches the network");
      });
      expect(await repair(t)).toMatchObject({ releaseUpdated: 1, releaseCleared: 1, errors: 0 });
      expect(await descriptionOf(t, ids["1"]!)).toBeNull();
      expect(await descriptionOf(t, ids["2"]!)).toBe("Dark Schneider’s foe.");
    });
  });
});

describe("ann — a title match set aside is flagged", () => {
  const ISBN = (n: number) => `97819753000${String(n).padStart(2, "0")}`;
  // ANN's entry lists only Volumes 1 to 9.
  const ENTRY: FixtureManga = {
    id: 41000,
    title: "Echo Garden",
    releases: Array.from({ length: 9 }, (_, i) => ({
      annId: 41001 + i,
      date: "2020-01-07",
      designator: `GN ${i + 1}`,
      ean: ISBN(i + 1),
    })),
  };

  /** A publisher feed's Series of the same title, built from its newest books, Volumes 10 to 12. */
  async function seedNewest(t: TestT, bootstrap: boolean) {
    await seedRegistry(t, bootstrap);
    return await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
      const seriesId = await insertSeries(ctx, { title: "Echo Garden" });
      for (const position of [10, 11, 12]) {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], isbn13: ISBN(position) });
      }
      return await ctx.db.get(seriesId);
    });
  }

  it("creates the entry's Series and one duplicate candidate naming both, and a rerun adds none", async () => {
    const t = makeT();
    const existing = (await seedNewest(t, true))!;
    stubAnn([ENTRY]);
    await sync(t, { releasePages: false });

    const state = () =>
      t.run(async (ctx) => ({
        series: await ctx.db.query("series").collect(),
        candidates: await ctx.db.query("duplicateCandidates").collect(),
      }));
    const first = await state();
    expect(first.series).toHaveLength(2);
    const created = first.series.find((s) => s._id !== existing._id)!;
    expect(first.candidates).toEqual([
      expect.objectContaining({
        aId: existing._id,
        bId: created._id,
        aTitle: "Echo Garden",
        bTitle: "Echo Garden",
        status: "open",
      }),
    ]);

    await sync(t, { releasePages: false });
    const second = await state();
    expect(second.series).toHaveLength(2);
    expect(second.candidates).toHaveLength(1);
  });

  it("names the set-aside Series on the creation Proposal it queues in steady state", async () => {
    const t = makeT();
    const existing = (await seedNewest(t, false))!;
    stubAnn([ENTRY]);
    await sync(t, { releasePages: false });
    await t.run(async (ctx) => {
      const [version] = await ctx.db.query("proposalVersions").collect();
      expect(version?.changeComment).toContain(
        `Series ${existing.publicId} ("Echo Garden") has this title, but its books share no ISBN with this entry's`,
      );
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("duplicateCandidates").collect()).toEqual([]);
    });
  });

  it("names the Series another ANN entry holds on the creation Proposal it queues in steady state", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const first: FixtureManga = {
      id: 15835,
      title: "Citrus",
      releases: [{ annId: 15836, date: "2016-01-12", designator: "GN 1" }],
    };
    const second: FixtureManga = { ...first, id: 15837, releases: [{ ...first.releases[0]!, annId: 15838 }] };
    stubAnn([first]);
    await sync(t, { releasePages: false });
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubAnn([first, second]);
    await sync(t, { releasePages: false });

    const state = () =>
      t.run(async (ctx) => ({
        series: await ctx.db.query("series").collect(),
        link: (await ctx.db.query("sourceObservations").collect()).find((o) => o.sourceRecordId === "manga:15837")
          ?.recordRef,
        comments: (await ctx.db.query("proposalVersions").collect()).map((v) => v.changeComment),
        candidates: await ctx.db.query("duplicateCandidates").collect(),
      }));
    const queued = await state();
    expect(queued.series).toHaveLength(1);
    expect(queued.link).toBeUndefined();
    const { publicId } = queued.series[0]!;
    expect(
      queued.comments.filter((c) =>
        c.includes(
          ` Series ${publicId} ("Citrus") has this title, but ANN entry 15835 already holds it, so the import did not link it: it may be one work ANN lists twice.`,
        ),
      ),
    ).toHaveLength(1);
    expect(queued.candidates).toEqual([]);

    await sync(t, { releasePages: false });
    expect((await state()).comments).toHaveLength(queued.comments.length);
  });
});
