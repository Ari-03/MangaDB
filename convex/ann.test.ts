// ANN adapter tests (ticket #36): the weekly mirror and the release-page
// pass, run against a stubbed ANN serving fixture XML/HTML in the live wire
// shapes — no network. Covers the series-structured Series/Volume backbone
// (the mirror itself never creates Editions/Releases), ISBN- and
// label-based release-line linking with date reconciliation at standard
// authority, the release-page pass's leaf creation and hold rules, the
// steady-state new-Series gate, chained continuation, withdrawal, and the
// 1 req/s etiquette default.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
  altTitles?: Array<{ lang: string; text: string }>;
  /** The Plot Summary's XML text (already escaped, as ANN serves it). */
  plot?: string;
  releases: FixtureRelease[];
  /** Staff rows; defaults to one "Story & Art" person. */
  staff?: Array<{ id: number; name: string }>;
};

function reportXml(manga: FixtureManga[], nskip: number, nlist: number) {
  const page = manga.slice(nskip, nskip + nlist);
  const items = page
    .map(
      (m) =>
        `<item><id>${m.id}</id><gid>1</gid><type>manga</type><name>${m.title}</name><precision>manga</precision></item>`,
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
  .map((p) => `<staff gid="3"><task>Story &amp; Art</task><person id="${p.id}">${p.name}</person></staff>`)
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
  pageRequests.length = 0;
  reportRequests.length = 0;
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

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.ann.sync, { politeDelayMs: 0, ...args });

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
      const series = (await ctx.db.query("series").collect())[0]!;
      const volumes = await ctx.db.query("volumes").collect();
      const vol = (label: string) => volumes.find((v) => v.label === label)!._id;
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      const makeRelease = async (
        volumeId: Id<"volumes">,
        pubDate?: { year: number; month: number; day: number; sort: number },
      ) => {
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: Math.floor(Math.random() * 100000),
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
          pubDate,
          publisherId,
          seriesIds: [series._id],
        });
      };
      const releaseNoDate = await makeRelease(vol("1"));
      const releaseAuthDate = await makeRelease(vol("2"), {
        year: 2026,
        month: 5,
        day: 19,
        sort: 20260519,
      });
      // Provenance: an authoritative source set volume 2's date.
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "sevenseas" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: releaseAuthDate } as never,
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "sevenseas" },
        changes: [
          {
            field: "pubDate",
            after: { year: 2026, month: 5, day: 19, sort: 20260519 },
          },
        ],
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
    // 510 entries: a full 500-item report page (10 batches) + a short second
    // page. Budget is page-aligned, so with maxBatches 10 the first link
    // stops at the page boundary and hands the run to a continuation.
    const many: FixtureManga[] = Array.from({ length: 510 }, (_, i) => ({
      id: 1000 + i,
      title: `Chain Series ${i}`,
      releases: [{ annId: 20000 + i, date: "2026-03-03", designator: "GN 1" }],
    }));
    stubAnn(many);
    const first = await sync(t, { maxBatches: 10 });
    expect(first).toMatchObject({ continued: true, recordsSeen: 500 });
    // The run stays open across the chain.
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("running");
    });
    // The scheduled continuation link finishes the mirror.
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs[0]!).toMatchObject({ status: "succeeded", recordsSeen: 510 });
      expect(await ctx.db.query("series").collect()).toHaveLength(510);
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
    // 510 fixture records across three mirror passes; each new Series costs
    // two title searches (candidates, then the hidden-Series check), which
    // convex-test simulates by scanning the table.
  }, 60000);

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
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
      const series = (await ctx.db.query("series").collect())[0]!;
      const volume = (await ctx.db.query("volumes").collect()).find((v) => v.label === label)!;
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 77,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: volume._id,
        order: 1,
        extent: "complete",
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        pubDate,
        publisherId,
        seriesIds: [series._id],
      });
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
  return await t.run(async (ctx) => ctx.db.insert("publishers", { status: "active", name, slug }));
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
      const series = (await ctx.db.query("series").collect())[0]!;
      const volume = (await ctx.db.query("volumes").collect())[0]!;
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 5,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: volume._id,
        order: 1,
        extent: "complete",
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: "9781974757282",
        publisherId,
        seriesIds: [series._id],
      });
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
    const existing = await t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect())[0]!;
      const volume = (await ctx.db.query("volumes").collect()).find((v) => v.label === "113")!;
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 9,
        publisherId: vizId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: volume._id,
        order: 1,
        extent: "complete",
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId: vizId,
        seriesIds: [series._id],
      });
    });
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
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
    await t.run((ctx) =>
      ctx.db.insert("series", {
        status: "hidden",
        publicId: 77,
        title: "Alpha Saga",
        altTitles: [],
        searchText: "Alpha Saga",
      }),
    );
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
      const survivorId = await ctx.db.insert("series", {
        status: "active",
        publicId: 88,
        title: "Alpha Saga: Complete",
        altTitles: ["Alpha Saga"],
        searchText: "Alpha Saga: Complete Alpha Saga",
      });
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
      for (const label of ["1", "2"]) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: Number(label) + 500,
          seriesId: ghost!._id,
          position: Number(label),
          label,
        });
      }
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
      const editionId = await ctx.db.insert("editions", {
        status: "hidden",
        publicId: 9,
        publisherId: vizId,
      });
      await ctx.db.insert("releases", {
        status: "hidden",
        editionId,
        format: "physical",
        language: "en",
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
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "kodansha" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "series", id: current._id } as never,
        seq: 2,
        proposalId,
        author: { kind: "source", sourceKey: "kodansha" },
        changes: [{ field: "synopsis", before: current.synopsis, after: "The publisher's text." }],
        comment: "Imported from kodansha.",
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
      ctx.db.insert("series", {
        status: "active",
        publicId: 264,
        title: "7th Time Loop: The Villainess Enjoys a Carefree Life Married to Her Worst Enemy!",
        altTitles: [],
        searchText: "7th Time Loop: The Villainess Enjoys a Carefree Life Married to Her Worst Enemy!",
      }),
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
    return await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 700,
        title,
        altTitles,
        searchText: [title, ...altTitles].join(" "),
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 701,
        seriesId,
        position: 1,
        label: "1",
      });
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 702, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13,
        publisherId,
        seriesIds: [seriesId],
      });
      return seriesId;
    });
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
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 710,
        title: "Doubt",
        altTitles: [],
        searchText: "Doubt",
      });
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
      const series = (await ctx.db.query("series").collect())[0]!;
      const volumes = await ctx.db.query("volumes").collect();
      const publisher = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "viz-media"))
        .unique();
      const publisherId =
        publisher?._id ??
        (await ctx.db.insert("publishers", { status: "active", name: "VIZ Media", slug: "viz-media" }));
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 4242,
        publisherId,
      });
      for (const [order, label] of labels.entries()) {
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId: volumes.find((v) => v.label === label)!._id,
          order,
          extent: opts.extent ?? "complete",
        });
      }
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: opts.isbn13,
        publisherId,
        seriesIds: [series._id],
      });
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
      const series = (await ctx.db.query("series").collect())[0]!;
      const volumes = await ctx.db.query("volumes").collect();
      const made: Record<string, Id<"releases">> = {};
      for (const [i, book] of books.entries()) {
        const volume = volumes.find((vol) => vol.label === book.label)!;
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: 100 + i,
          publisherId: vizId,
        });
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId: volume._id,
          order: 1,
          extent: "complete",
        });
        const id = await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          language: "en",
          isbn13: LINES.releases.find((r) => r.designator === `GN ${book.label}`)!.ean,
          publisherId: vizId,
          seriesIds: [series._id],
          ...(book.description !== undefined ? { description: book.description } : {}),
          ...(book.overridden ? { overriddenFields: ["description"] } : {}),
        });
        if (book.sevenSeas) {
          const proposalId = await ctx.db.insert("proposals", {
            author: { kind: "source", sourceKey: "sevenseas" },
            state: "approved",
            currentVersionNo: 1,
          });
          await ctx.db.insert("revisions", {
            ref: { type: "release", id } as never,
            seq: 1,
            proposalId,
            author: { kind: "source", sourceKey: "sevenseas" },
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
      page: { status: "ok", descriptionChecked: true, description: `${BLURB} Story and art by Eiichiro Oda.` },
    });
    expect(await descriptionOf(t, obs.recordRef!.id as Id<"releases">)).toBe(
      `${BLURB} Story and art by Eiichiro Oda.`,
    );
  });

  it("a Release the page pass links fills a blank description", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubAnn([LINES], describedPages);
    await sync(t, { releasePages: false });
    const vizId = await seedPublisher(t, "VIZ Media", "viz-media");
    // VIZ's GN 2 without an ISBN: the page pass links it rather than creating.
    const existing = await t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect())[0]!;
      const volume = (await ctx.db.query("volumes").collect()).find((v) => v.label === "2")!;
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 9, publisherId: vizId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId: volume._id, order: 1, extent: "complete" });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId: vizId,
        seriesIds: [series._id],
      });
    });
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
    expect(await descriptionOf(t, ids["1"]!)).toBe(`${BLURB} Story and art by Eiichiro Oda.`);
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
    vi.spyOn(Date, "now").mockImplementation(() => (now += 61_000));
  }
  async function runScheduled(t: TestT) {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
    const releaseId = await t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect())[0]!;
      const volume = (await ctx.db.query("volumes").collect()).find((v) => v.label === "2")!;
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 9, publisherId: vizId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId: volume._id, order: 1, extent: "complete" });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        isbn13: "9781569319024",
        publisherId: vizId,
        seriesIds: [series._id],
      });
    });
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
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
    await runScheduled(t);
    expect([...pageRequests].sort()).toEqual(["10948", "10949", "10950"]);
    for (const id of Object.values(ids)) expect(await descriptionOf(t, id)).not.toBeNull();
  });

  it("the backfill continues after its time budget without repeating a page", async () => {
    const t = makeT();
    const ids = await linkedCatalog(t, describedPages, [{ label: "1" }, { label: "2" }, { label: "3" }]);
    slowClock();
    expect(await backfill(t)).toMatchObject({ fetched: 1, filled: 1, continued: true });
    await runScheduled(t);
    expect([...pageRequests].sort()).toEqual(["10948", "10949", "10950"]);
    for (const id of Object.values(ids)) expect(await descriptionOf(t, id)).not.toBeNull();
  });

  it("the backfill refuses to run beside an ANN Import Run", async () => {
    const t = makeT();
    await linkedCatalog(t, describedPages, [{ label: "1" }]);
    await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    const result = await backfill(t);
    expect(result).toMatchObject({ fetched: 0, filled: 0, continued: false });
    expect(result.stopped).toMatch(/ANN Import Run .* is running/);
    expect(pageRequests).toEqual([]);
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
});
