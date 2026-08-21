// ANN adapter tests (ticket #36): the weekly mirror run against a stubbed
// ANN serving fixture XML in the live wire shapes — no network. Covers the
// acceptance criteria: the series-structured Series/Volume backbone (never
// Editions/Releases — ANN carries no publisher), release-observation
// linking with date reconciliation at standard authority, the steady-state
// new-Series gate, chained continuation, withdrawal, and the 1 req/s
// etiquette default.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

type FixtureRelease = { annId: number; date: string; designator: string };
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
          (alt) =>
            `<info gid="2" type="Alternative title" lang="${alt.lang}">${alt.text}</info>`,
        )
        .join("\n");
      const releases = m.releases
        .map(
          (r) =>
            `<release date="${r.date}" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${r.annId}">${m.title} (${r.designator})</release>`,
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

function stubAnn(manga: FixtureManga[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
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
      expect(series.map((s) => s.title).sort()).toEqual([
        "Alpha Saga",
        "Beta Blade",
      ]);
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
      const mangaObs = observations.find(
        (o) => o.sourceRecordId === "manga:100",
      )!;
      expect(mangaObs.recordRef?.type).toBe("series");
      const releaseObs = observations.filter((o) =>
        o.sourceRecordId.startsWith("release:"),
      );
      expect(releaseObs).toHaveLength(5);
      expect(releaseObs.every((o) => o.recordRef === undefined)).toBe(true);
      // Creation Revisions cite the Encyclopedia entry (ANN's license).
      const revisions = await ctx.db.query("revisions").collect();
      expect(revisions.length).toBeGreaterThan(0);
      for (const revision of revisions) {
        expect(revision.citation?.url).toContain(
          "animenewsnetwork.com/encyclopedia/manga.php?id=",
        );
      }
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
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
      const vol = (label: string) =>
        volumes.find((v) => v.label === label)!._id;
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
  }, 30000); // 510 fixture records across three mirror passes

  it("defaults to ANN's 1 req/s etiquette", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const waits: number[] = [];
    vi.stubGlobal(
      "setTimeout",
      ((fn: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        fn();
        return 0;
      }) as unknown as typeof setTimeout,
    );
    stubAnn([BETA]);
    await sync(t, { politeDelayMs: undefined });
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.min(...waits.filter((w) => w > 0))).toBeGreaterThanOrEqual(1000);
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
      const tables = versions[0]!.ops.map((op) =>
        op.kind === "create" ? op.table : op.kind,
      );
      expect(tables).toEqual(["series", "volumes"]);
    });
  });
});
