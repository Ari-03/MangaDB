// Kodansha adapter tests (ticket #36): the whole import path run against a
// stubbed kodansha.us serving fixture responses in the live wire shapes —
// no network. Covers the ticket's acceptance criterion for this source:
// fetch → observations → reconciliation → canonical records/Proposals, with
// the per-format split sharing one Edition, steady-state gates, and covers.

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
