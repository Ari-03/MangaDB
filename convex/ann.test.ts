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
  releases: FixtureRelease[];
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
      return `<manga id="${m.id}" gid="1" type="manga" name="${m.title}" precision="manga">
<info gid="1" type="Main title" lang="EN">${m.title}</info>
${alts}
${releases}
<staff gid="3"><task>Story &amp; Art</task><person id="1">Some One</person></staff></manga>`;
    })
    .join("\n");
  return `<ann>${blocks}</ann>`;
}

const pageRequests: string[] = [];

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
}) {
  return `<html><body><hr><b>Title:</b> ${args.title}<br><b>Volume:</b>  ${args.volume}<br><b>Distributor:</b> <a href="company.php?id=4552">${args.distributor}</a><p><b>Release date:</b> ${args.date}<br><b>Suggested retail price:</b> $11.99<br></p><p><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">${args.isbn13.slice(0, 3)}</span><span>${args.isbn13.slice(3)}</span></span><span style="visibility:hidden"> ${args.isbn13}</span><br></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=${args.mangaId}">x</a></b></li></ul></body></html>`;
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
