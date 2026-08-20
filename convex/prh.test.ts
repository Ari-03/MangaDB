// PRH adapter tests (ticket #36): the overlay run against a stubbed
// Enhanced API — no network, no key. Covers the acceptance criterion: PRH
// values apply per the authority table on PRH-distributed records only —
// authoritative ISBN/date/price overlay onto records other sources created,
// equal-authority disagreement queueing, creation boundaries, and the
// unconfigured/graceful-skip behavior.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

type FixtureTitle = {
  isbn: string;
  title: string;
  onsale?: string;
  format?: string;
  imprint?: string;
  priceUsd?: number;
};

const requestedUrls: string[] = [];

function stubApi(titles: FixtureTitle[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    requestedUrls.push(url);
    if (url.includes("api.penguinrandomhouse.com")) {
      const params = new URL(url).searchParams;
      const start = Number(params.get("start") ?? 0);
      const page = titles.slice(start, start + 200).map((t) => ({
        isbn: t.isbn,
        title: t.title,
        onsale: t.onsale,
        format: { code: "TR", description: t.format ?? "Trade Paperback" },
        imprint: { code: "IMPR", description: t.imprint ?? "Kodansha Comics" },
        priceUsd: t.priceUsd,
      }));
      return new Response(
        JSON.stringify({ recordCount: titles.length, data: { titles: page } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  requestedUrls.length = 0;
  vi.stubEnv("PRH_API_KEY", "test-key");
  vi.stubEnv("PRH_IMPRINT_CODES", "KODCM");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  t.action(internal.prh.sync, { politeDelayMs: 0, mode: "full", ...args });

describe("prh.sync — configuration", () => {
  it("skips as unconfigured without a key, logging no run", async () => {
    vi.stubEnv("PRH_API_KEY", "");
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    const result = await sync(t);
    expect(result).toEqual({ skipped: "unconfigured" });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("importRuns").collect()).toHaveLength(0);
    });
  });

  it("future mode bounds the query by onsaleFrom; full mode does not", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    await sync(t, { mode: "future" });
    expect(requestedUrls.some((u) => u.includes("onsaleFrom="))).toBe(true);
    requestedUrls.length = 0;
    await sync(t, { mode: "full" });
    expect(requestedUrls.some((u) => u.includes("onsaleFrom="))).toBe(false);
    expect(requestedUrls.some((u) => u.includes("imprint=KODCM"))).toBe(true);
  });
});

describe("prh.sync — the authoritative overlay", () => {
  it("links a publisher-created release by full key, fills its ISBN/price, and queues an equal-authority date conflict", async () => {
    const t = makeT();
    await seedRegistry(t, true);

    // The skeleton record: a Kodansha-created release (authoritative date),
    // no ISBN — exactly what seeding stages ① leave behind.
    stubApi([]);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha",
        slug: "kodansha",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Witch Hat Atelier",
        altTitles: [],
        searchText: "Witch Hat Atelier",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 15,
        label: "15",
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
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        pubDate: { year: 2026, month: 12, day: 1, sort: 20261201 },
        publisherId,
        seriesIds: [seriesId],
      });
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "kodansha" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: releaseId } as never,
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "kodansha" },
        changes: [
          {
            field: "pubDate",
            after: { year: 2026, month: 12, day: 1, sort: 20261201 },
          },
        ],
        comment: "Imported from Kodansha.",
      });
    });

    vi.unstubAllGlobals();
    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        onsale: "2026-12-08", // disagrees with Kodansha's equally-auth date
        imprint: "Kodansha Comics", // resolves to the "Kodansha" row
        priceUsd: 12.99,
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 1, completeSweep: true });

    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      // Authoritative fills apply...
      expect(release.isbn13).toBe("9781646094356");
      expect(release.price).toEqual({ amountCents: 1299, currency: "USD" });
      // ...but the equal-authority date disagreement queues, never overwrites.
      expect(release.pubDate!.sort).toBe(20261201);
      const proposals = (await ctx.db.query("proposals").collect()).filter(
        (p) => p.state === "inReview",
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.author).toEqual({ kind: "source", sourceKey: "prh" });
      // The observation is linked (rung ③ full key) for future runs.
      const obs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "prh").eq("sourceRecordId", "9781646094356"),
        )
        .unique();
      expect(obs!.recordRef).toEqual({ type: "release", id: release._id });
      // No duplicate structure was created.
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("editions").collect()).toHaveLength(1);
    });
  });

  it("creates records under the imprint's publisher in Bootstrap Mode and withdraws on a later full sweep", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      {
        isbn: "9781634429457",
        title: "Yotsuba&!, Vol. 16",
        onsale: "2026-10-20",
        imprint: "Denpa",
        priceUsd: 13.95,
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["denpa"]);
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(1);
      expect(releases[0]!).toMatchObject({
        isbn13: "9781634429457",
        format: "physical",
        binding: "paperback",
      });
      const series = (await ctx.db.query("series").collect())[0]!;
      expect(series).toMatchObject({
        title: "Yotsuba&!",
        bootstrapUnreviewed: true,
      });
    });

    // The title disappears from a complete full sweep → withdrawn.
    vi.unstubAllGlobals();
    stubApi([]);
    await sync(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "9781634429457",
      )!;
      expect(obs.withdrawn).toBe(true);
    });
  });
});

describe("prh.sync — steady state", () => {
  it("queues a pre-filled proposal for a brand-new series, ensuring the imprint's publisher row", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        onsale: "2026-12-08",
        imprint: "Kodansha Comics",
      },
    ]);
    await sync(t);
    await sync(t); // dedup: an open queue item never re-queues
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals).toHaveLength(1);
      const versions = await ctx.db.query("proposalVersions").collect();
      const editionOp = versions[0]!.ops.find(
        (op) => op.kind === "create" && op.table === "editions",
      );
      expect(
        (editionOp as { fields: { publisherSlug: string } }).fields
          .publisherSlug,
      ).toBe("kodansha-comics");
      // The row exists, so approving the guess is one click.
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["kodansha-comics"]);
    });
  });
});
