// PRH adapter tests (ticket #36): the overlay run against a stubbed
// Enhanced API — no network, no key. Covers the acceptance criterion: PRH
// values apply per the authority table on PRH-distributed records only —
// authoritative ISBN/date/price overlay onto records other sources created,
// equal-authority disagreement queueing, creation boundaries, and the
// unconfigured/graceful-skip behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import * as catalogTitle from "./lib/catalogTitle";
import { MATURE_PROJECTIONS_PER_JOB } from "./lib/mature";
import { parseTitle } from "./lib/prh";
import { PACK_SPAN } from "./lib/seriesStats";
import {
  type CatalogOverrides,
  insertCoverage,
  insertEdition,
  insertFullPack,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
  seedCatalog,
} from "./test.factories";
import {
  alice,
  bundleMembers,
  drain,
  expectStampedAtHandOff,
  makeT,
  matureFlags,
  projectionJobs,
  seedRegistry,
  seedTeam,
  signedIn,
  tickingClock,
  type TestT,
} from "./test.helpers";

type FixtureTitle = {
  isbn: string;
  title: string;
  /** PRH's own volume number for the book, as the live API carries it. */
  seriesNumber?: number;
  onsale?: string;
  format?: string;
  imprint?: string;
  priceUsd?: number;
  /** The content zoom's flap copy (HTML), embedded as the live API does. */
  flapcopy?: string;
  /** The content zoom's keynote (HTML). */
  keynote?: string;
};

const requestedUrls: string[] = [];

function stubApi(titles: FixtureTitle[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    requestedUrls.push(url);
    if (url.includes("api.penguinrandomhouse.com")) {
      const params = new URL(url).searchParams;
      const start = Number(params.get("start") ?? 0);
      const page = titles.slice(start, start + 200).map((t) => ({
        isbn: t.isbn,
        title: t.title,
        seriesNumber: t.seriesNumber,
        onsale: t.onsale,
        format: { code: "TR", description: t.format ?? "Trade Paperback" },
        imprint: {
          code: "IMPR",
          description: t.imprint ?? "Kodansha Comics",
        },
        priceUsd: t.priceUsd,
        _embeds:
          t.flapcopy !== undefined || t.keynote !== undefined
            ? [{ content: { ean: t.isbn, flapcopy: t.flapcopy, keynote: t.keynote } }]
            : null,
      }));
      return new Response(
        JSON.stringify({
          recordCount: titles.length,
          data: { titles: page },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

/** Answer every request with this JSON body: a list response the API should never send. */
function stubBody(body: object) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
}

beforeEach(() => {
  requestedUrls.length = 0;
  vi.stubEnv("PRH_API_KEY", "test-key");
  vi.stubEnv("PRH_IMPRINT_CODES", "KODCM");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** An active Series with the given Volumes and no Releases, as a backbone source (ANN) leaves it. */
async function backbone(t: TestT, title: string, labels: string[]) {
  return await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { title });
    for (const label of labels) await insertVolume(ctx, { seriesId, position: Number(label) });
    return seriesId;
  });
}

/** Kodansha's Witch Hat Atelier Volume 15 with one ISBN-less Release, as the publisher's own import leaves it. */
const seedWitchHat15 = (t: TestT, release: CatalogOverrides["release"]) =>
  t.run((ctx) =>
    seedCatalog(ctx, {
      publisher: { name: "Kodansha", slug: "kodansha" },
      series: { title: "Witch Hat Atelier" },
      volume: { position: 15 },
      release,
    }),
  );

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

  it("sweeps the imprint-scoped path, newest-first in future mode", async () => {
    // PRH ignores `imprint`/`onsaleFrom` on the flat /titles endpoint, so
    // the sync must use /imprints/{code}/titles and sort by onsale itself.
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    await sync(t, { mode: "future" });
    expect(requestedUrls.some((u) => u.includes("/imprints/KODCM/titles"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("dir=desc"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("imprint=") || u.includes("onsaleFrom="))).toBe(
      false,
    );
    requestedUrls.length = 0;
    await sync(t, { mode: "full" });
    expect(requestedUrls.some((u) => u.includes("/imprints/KODCM/titles"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("sort=onsale") && u.includes("dir=asc"))).toBe(
      true,
    );
  });

  it("future mode applies only future-dated titles and stops at the first past page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Newest-first fixture: one future title, then a past one — the past
    // title must end the imprint without being applied.
    stubApi([
      { isbn: "9781646519811", title: "Future Manga 1", onsale: "2099-01-01" },
      { isbn: "9781646519828", title: "Past Manga 1", onsale: "2001-01-01" },
    ]);
    const result = await sync(t, { mode: "future" });
    expect(result).toMatchObject({ recordsSeen: 1 });
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519811"]);
    });
  });

  it("continues past a page containing only out-of-scope titles", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      ...Array.from({ length: 200 }, () => ({
        isbn: "9781646519811",
        title: "Excluded Story (Light Novel) Vol. 1",
      })),
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 1, completeSweep: true });
    expect(requestedUrls).toHaveLength(2);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519828"]);
    });
  });

  it.each([
    { error: "upstream error" },
    { data: {} },
    { data: { titles: null } },
    { data: { error: "upstream unavailable" } },
  ])(
    "fails malformed list responses without withdrawing existing observations: %j",
    async (body) => {
      const t = makeT();
      await seedRegistry(t, true);
      stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
      await sync(t);
      stubBody(body);
      const result = await sync(t);
      expect(result).toMatchObject({ failed: true, completeSweep: false });
      await t.run(async (ctx) => {
        if (!("runId" in result)) throw new Error("Expected an import run");
        expect((await ctx.db.get(result.runId))?.status).toBe("failed");
        const observations = await ctx.db.query("sourceObservations").collect();
        expect(observations).toHaveLength(1);
        expect(observations[0]!.withdrawn).not.toBe(true);
      });
    },
  );

  // B09: a record PRH still lists but the parser cannot normalize (here a
  // null title) is still present at the source — never a withdrawal.
  it("keeps a still-listed but malformed record present instead of withdrawing it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1, onsale: "2099-01-05" },
    ]);
    await sync(t);
    const proposalsBefore = await t.run(
      async (ctx) => (await ctx.db.query("proposals").collect()).length,
    );
    stubBody({
      recordCount: 1,
      data: { titles: [{ isbn: "9781646519828", title: null, onsale: "2099-01-05" }] },
    });
    const result = await sync(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations).toHaveLength(1);
      expect(observations[0]!.withdrawn).toBe(false);
      // No possible-cancellation review for a Release PRH still lists.
      expect(await ctx.db.query("proposals").collect()).toHaveLength(proposalsBefore);
      const runs = await ctx.db.query("importRuns").order("desc").collect();
      expect(runs[0]!.errors).toEqual(["malformed 9781646519828: dropped by the parser"]);
    });
    expect(result).toMatchObject({ recordsSeen: 0, errorCount: 1 });
  });

  // B09: a withdrawn record that PRH relists as a malformed row is present
  // again, so the possible-cancellation review its withdrawal queued retires.
  it("retires the withdrawal's cancellation review when the record returns malformed", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1, onsale: "2099-01-05" },
    ]);
    await sync(t);
    vi.unstubAllGlobals();
    stubApi([]);
    await sync(t);
    const proposalId = await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.withdrawn).toBe(true);
      expect(obs!.queuedProposalId).toBeDefined();
      expect((await ctx.db.get(obs!.queuedProposalId!))?.state).toBe("inReview");
      return obs!.queuedProposalId!;
    });
    stubBody({
      recordCount: 1,
      data: { titles: [{ isbn: "9781646519828", title: null, onsale: "2099-01-05" }] },
    });
    await sync(t);
    await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.withdrawn).toBe(false);
      expect((await ctx.db.get(proposalId))?.state).toBe("withdrawn");
    });
  });

  it("never calls a sweep complete when a listed record has no readable ISBN", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    await sync(t);
    stubBody({ recordCount: 1, data: { titles: [{ isbn: null, title: null }] } });
    expect(await sync(t)).toMatchObject({ completeSweep: false, errorCount: 1 });
    await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.withdrawn).toBe(false);
    });
  });

  it("does not call a prematurely empty upstream page a complete sweep", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubBody({ recordCount: 201, data: { titles: [] } });
    expect(await sync(t)).toMatchObject({ failed: true, completeSweep: false });
  });

  it("records individual write failures as a failed run and continues other titles", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781646519811", title: "Failed Manga 1", seriesNumber: 1 },
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
    ]);
    vi.spyOn(catalogTitle, "applyCatalogTitle").mockRejectedValueOnce(new Error("write failed"));
    expect(await sync(t)).toMatchObject({
      failed: true,
      completeSweep: false,
      recordsSeen: 2,
      errorCount: 1,
    });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.status).toBe("failed");
      expect(run!.errors).toEqual(["title 9781646519811: write failed"]);
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519828"]);
    });
  });

  it("an imprint override sweeps only those codes and never withdraws", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // A title a full sweep observed, which the override's imprint never lists.
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    await sync(t);
    stubApi([]);
    requestedUrls.length = 0;
    const result = await sync(t, { mode: "full", imprints: ["XO"] });
    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(requestedUrls.every((u) => u.includes("/imprints/XO/titles"))).toBe(true);
    expect(result).toMatchObject({ completeSweep: false });
    await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.withdrawn).toBe(false);
    });
  });

  it("never writes the api key into run errors", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 404 }));
    const result = await sync(t, { mode: "full" });
    expect(result).toMatchObject({ failed: true });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.errors.join(" ")).toContain("api_key=…");
      expect(run!.errors.join(" ")).not.toContain("test-key");
    });
  });
});

describe("prh.sync — the authoritative overlay", () => {
  it("links a publisher-created release by full key, fills its ISBN/price, and queues an equal-authority date conflict", async () => {
    const t = makeT();
    await seedRegistry(t, true);

    // The skeleton record: a Kodansha-created release (authoritative date),
    // no ISBN — exactly what seeding stages ① leave behind.
    const pubDate = { year: 2026, month: 12, day: 1, sort: 20261201 };
    const { releaseId } = await seedWitchHat15(t, { binding: "paperback", pubDate });
    await t.run((ctx) =>
      insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId },
        sourceKey: "kodansha",
        changes: [{ field: "pubDate", after: pubDate }],
        comment: "Imported from Kodansha.",
      }),
    );

    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        seriesNumber: 15,
        onsale: "2026-12-08", // disagrees with Kodansha's equally-auth date
        imprint: "Kodansha Comics", // resolves to the "Kodansha" row
        priceUsd: 12.99,
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 1, completeSweep: true });
    expect(result).not.toHaveProperty("failed", true);

    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.status).toBe("succeeded");
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
      expect(proposals[0]!.author).toEqual({
        kind: "source",
        sourceKey: "prh",
      });
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
    // Every list request asks for the content zoom (the flap copy).
    expect(
      requestedUrls.every(
        (u) =>
          new URL(u).searchParams.get("zoom") ===
          "https://api.penguinrandomhouse.com/title/titles/content/definition",
      ),
    ).toBe(true);
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

    // The flap copy arrives later: it fills the linked Release's description.
    vi.unstubAllGlobals();
    stubApi([
      {
        isbn: "9781634429457",
        title: "Yotsuba&!, Vol. 16",
        onsale: "2026-10-20",
        imprint: "Denpa",
        priceUsd: 13.95,
        flapcopy: "Yotsuba&#8217;s back!<br><br>More everyday adventures.",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const [release] = await ctx.db.query("releases").collect();
      expect(release!.description).toBe("Yotsuba’s back! More everyday adventures.");
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
  it("queues a pre-filled proposal for a brand-new series, ensuring the company's publisher row", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        seriesNumber: 15,
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
      expect((editionOp as { fields: { publisherSlug: string } }).fields.publisherSlug).toBe(
        "kodansha",
      );
      // "Kodansha Comics" is Kodansha under another string: one company row,
      // which exists, so approving the guess is one click.
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["kodansha"]);
    });
  });
});

// Real PRH titles that used to become one Series per book (series-titles
// and volume-numbering audits); the ANN backbone Series has no Releases yet.
describe("prh.sync — packaging and title shapes (Bootstrap Mode)", () => {
  it("files an omnibus under the base Series as an Edition Line member covering its Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const seriesId = await backbone(t, "Noragami: Stray God", ["19", "20"]);
    await t.run((ctx) =>
      ctx.db.patch(seriesId, {
        altTitles: ["Noragami"],
        searchText: "Noragami: Stray God Noragami",
      }),
    );
    stubApi([
      {
        isbn: "9781646519026",
        title: "Noragami Omnibus 7 (Vol. 19-21)",
        seriesNumber: 7,
      },
      {
        isbn: "9781646519033",
        title: "Noragami Omnibus 7 (Vol. 19-21)",
        seriesNumber: 7,
        format: "Ebook",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["19", "20", "21"]);
      const [line] = await ctx.db.query("editionLines").collect();
      expect(line).toMatchObject({ seriesId, name: "Omnibus" });
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      expect(editions[0]).toMatchObject({
        editionLineId: line!._id,
        linePosition: "7",
      });
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.format).sort()).toEqual(["digital", "physical"]);
    });
  });

  it("places deluxe/omnibus books by the coverage their blurb states", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Berserk", ["1", "2", "3", "40", "41"]);
    stubApi([
      {
        isbn: "9781506711980",
        title: "Berserk Deluxe Volume 1",
        imprint: "Dark Horse Manga",
        flapcopy:
          "<p>A stunning deluxe edition collecting volumes 1&ndash;3 of the <i>New York Times</i> bestselling manga.</p>",
      },
      {
        isbn: "9781506741062",
        title: "Berserk Deluxe Volume 14",
        imprint: "Dark Horse Manga",
        flapcopy: "<p>Guts' greatest creation lives on in this final deluxe volume.</p>",
        keynote: "<p>Collects <i>Berserk</i> Volumes 40, 41, and <i>Berserk Official Guidebook</i>.</p>",
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 2, recordsChanged: 2 });
    await t.run(async (ctx) => {
      // "Berserk Deluxe Volume N" names the line "Deluxe" (lib/bookTitle.ts tidyLineName).
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines.map((l) => l.name)).toEqual(["Deluxe"]);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.linePosition).sort()).toEqual(["1", "14"]);
      const volumes = new Map(
        (await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]),
      );
      const coverage = await ctx.db.query("volumeCoverages").collect();
      const byEdition = new Map<string, string[]>();
      for (const c of coverage) {
        byEdition.set(c.editionId, [...(byEdition.get(c.editionId) ?? []), volumes.get(c.volumeId)!]);
      }
      const first = editions.find((e) => e.linePosition === "1")!;
      const last = editions.find((e) => e.linePosition === "14")!;
      expect(byEdition.get(first._id)?.sort()).toEqual(["1", "2", "3"]);
      expect(byEdition.get(last._id)?.sort()).toEqual(["40", "41"]);
    });
  });

  it("places N-in-1 books by their declared size when nothing states the coverage", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "One Piece", ["4", "5", "6"]);
    stubApi([{ isbn: "9781421536262", title: "One Piece 3-in-1 Edition Vol. 2", imprint: "VIZ Media" }]);
    await sync(t);
    await t.run(async (ctx) => {
      const [line] = await ctx.db.query("editionLines").collect();
      expect(line).toMatchObject({ name: "3-in-1 Edition" });
      const volumes = new Map(
        (await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]),
      );
      const covered = (await ctx.db.query("volumeCoverages").collect()).map((c) => volumes.get(c.volumeId));
      expect(covered.sort()).toEqual(["4", "5", "6"]);
    });
  });

  it("creates packaging of unknown coverage as an Unmapped line member, never as a Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Negima!", ["4"]);
    stubApi([
      { isbn: "9781612620015", title: "Negima! Omnibus 4", seriesNumber: 4 },
      { isbn: "9781612620016", title: "Negima! Omnibus 4", seriesNumber: 4, format: "eBook" },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      // "Omnibus 4" is not Volume 4: nothing covers the backbone's Volume,
      // and no Volume was created for the omnibus number.
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(0);
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label)).toEqual(["4"]);
      // One unmapped Edition under the "Omnibus" line, shared by print + digital.
      const [edition, ...more] = await ctx.db.query("editions").collect();
      expect(more).toHaveLength(0);
      expect(edition).toMatchObject({ coverageUnmapped: true, linePosition: "4" });
      const line = await ctx.db.get(edition!.editionLineId!);
      expect(line).toMatchObject({ name: "Omnibus" });
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.format).sort()).toEqual(["digital", "physical"]);
      // The Series is still known through the line, so calendars and the library keep the book.
      expect(releases.every((r) => r.seriesIds.length === 1 && r.seriesIds[0] === line!.seriesId)).toBe(true);
    });
  });

  it("treats a bare multi-volume range as stated coverage and creates the missing Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Negima!", ["4"]);
    stubApi([{ isbn: "9781612620015", title: "Negima! Vols. 4-5", seriesNumber: 4 }]);
    await sync(t);
    await t.run(async (ctx) => {
      // A stated range is coverage — it creates normally (Volume 5 joins the backbone).
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label).sort()).toEqual(["4", "5"]);
    });
  });

  it("gives a multi-volume title range coverage, never an unlabeled placeholder", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      {
        isbn: "9781645058472",
        title: "Tokyo Revengers (Omnibus) Vol. 11-12",
        imprint: "Seven Seas",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title)).toEqual(["Tokyo Revengers"]);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => [v.label, v.position])).toEqual([
        ["11", 11],
        ["12", 12],
      ]);
    });
  });

  it("splits Vol.N and (Manga) titles onto the existing backbone Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const alpi = await backbone(t, "Alpi the Soul Sender", ["5"]);
    const picnic = await backbone(t, "Otherside Picnic", ["5"]);
    stubApi([
      {
        isbn: "9781787741348",
        title: "Alpi the Soul Sender Vol.5",
        seriesNumber: 5,
        imprint: "Titan Manga",
      },
      {
        isbn: "9781646091300",
        title: "Otherside Picnic 05 (Manga)",
        seriesNumber: 5,
        imprint: "Square Enix Manga",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(2);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.seriesIds[0]).sort()).toEqual([alpi, picnic].sort());
      // "Square Enix Manga" is Square Enix under another string.
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug).sort()).toEqual(["square-enix", "titan-manga"]);
    });
  });

  it("keeps a trailing number that belongs to an existing Series' name", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const omega = await backbone(t, "Omega 6", []);
    stubApi([
      {
        isbn: "9781506731780",
        title: "Omega 6",
        seriesNumber: 6,
        imprint: "Dark Horse Manga",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id)).toEqual([omega]);
    });
  });

  it("splits a trailing number without seriesNumber only onto an existing base Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // The catalog knows the work; PRH's row for its next book has no seriesNumber.
    const tower = await backbone(t, "Tower Dungeon", ["6"]);
    stubApi([
      { isbn: "9781647297091", title: "Tower Dungeon 7", imprint: "Vertical Comics" },
      // No base Series "Omega": a new work keeps its whole name.
      { isbn: "9781506731780", title: "Omega 6", imprint: "Dark Horse Manga" },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title).sort()).toEqual(["Omega 6", "Tower Dungeon"]);
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", tower))
        .collect();
      expect(volumes.map((v) => [v.label, v.position])).toEqual([
        ["6", 6],
        ["7", 7],
      ]);
      const release = (await ctx.db.query("releases").collect()).find((r) => r.isbn13 === "9781647297091");
      expect(release?.seriesIds).toEqual([tower]);
    });
  });

  it("splits a trailing roman numeral only onto an existing base Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // ANN's backbone for the work; PRH names its books "BARBARITIES I" etc.
    const barbarities = await backbone(t, "Barbarities", []);
    // A sequel whose name ends in a numeral, and no base to split onto.
    const hearts = await backbone(t, "Kingdom Hearts II", []);
    stubApi([
      { isbn: "9781685795009", title: "BARBARITIES II", imprint: "Seven Seas" },
      { isbn: "9781975300000", title: "Kingdom Hearts II", imprint: "Yen Press" },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id).sort()).toEqual(
        [barbarities, hearts].sort(),
      );
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.seriesIds[0]).sort()).toEqual([barbarities, hearts].sort());
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", barbarities))
        .collect();
      expect(volumes.map((v) => v.label)).toEqual(["2"]);
    });
  });

  it("holds a roman-numeral title whose whole name is a hidden Series, off the base's Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const base = await backbone(t, "Kingdom Hearts", ["2"]);
    const sequel = await backbone(t, "Kingdom Hearts II", []);
    await t.run((ctx) => ctx.db.patch(sequel, { status: "hidden" }));
    stubApi([{ isbn: "9781975300000", title: "Kingdom Hearts II", imprint: "Yen Press" }]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toEqual([]);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => [v.seriesId, v.label])).toEqual([[base, "2"]]);
      const obs = (await ctx.db.query("sourceObservations").collect()).find((o) => o.sourceRecordId === "9781975300000")!;
      const hold = await ctx.db
        .query("placementHolds")
        .withIndex("by_observation", (q) => q.eq("observationId", obs._id))
        .unique();
      expect(hold?.kind).toBe("series");
    });
  });

  it("asks for a roman-numeral name without the groups the raw title carries", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Both the base and the sequel exist: the sequel's own book must not
    // become the base's Volume 2 because its title ends in "(Manga)".
    const base = await backbone(t, "Kingdom Hearts", []);
    const sequel = await backbone(t, "Kingdom Hearts II", []);
    stubApi([
      { isbn: "9781975300000", title: "Kingdom Hearts II (Manga)", imprint: "Yen Press" },
      // No Series by either name: the new work is named without the group.
      { isbn: "9781685795009", title: "Barbarities II (Manga)", imprint: "Seven Seas" },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases.find((r) => r.isbn13 === "9781975300000")?.seriesIds).toEqual([sequel]);
      expect(
        await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", base))
          .collect(),
      ).toEqual([]);
      const titles = (await ctx.db.query("series").collect()).map((s) => s.title).sort();
      expect(titles).toEqual(["Barbarities II", "Kingdom Hearts", "Kingdom Hearts II"]);
    });
  });

  it("makes a box set a Release Bundle of the base Series' Releases", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Fire Force", []);
    stubApi([
      { isbn: "9781632364425", title: "Fire Force 1", seriesNumber: 1 },
      {
        isbn: "9798888772584",
        title: "Fire Force Manga Box Set 1 (Vol. 1-6)",
        seriesNumber: 1,
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const bundles = await ctx.db.query("releaseBundles").collect();
      expect(bundles).toMatchObject([
        {
          isbn13: "9798888772584",
          name: "Fire Force Manga Box Set 1 (Vol. 1-6)",
        },
      ]);
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(1);
      // The box is not a Release, and it made no Volume.
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13)).toEqual(["9781632364425"]);
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label)).toEqual(["1"]);
    });
  });

  it("creates an imprint's own row under its parent company", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) => insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" }));
    stubApi([
      {
        isbn: "9798891600836",
        title: "ENNEAD Vol. 4 [Mature Hardcover]",
        seriesNumber: 4,
        imprint: "Ghost Ship",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const ghostShip = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "ghost-ship"))
        .unique();
      const sevenSeas = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "seven-seas"))
        .unique();
      expect(ghostShip?.parentPublisherId).toBe(sevenSeas!._id);
      expect((await ctx.db.query("series").collect()).map((s) => s.title)).toEqual(["ENNEAD"]);
    });
  });

  it("never stores out-of-scope titles", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      {
        isbn: "9781945054853",
        title: "The Seven Deadly Sins (Novel)",
        imprint: "Kodansha Comics",
      },
      {
        isbn: "9781935654100",
        title: "Number Place: Blue",
        imprint: "Vertical",
      },
      {
        isbn: "9781427880024",
        title: "Her Royal Highness Seems to Be Angry, Volume 1 (Light Novel)",
        imprint: "TOKYOPOP",
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 0 });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("sourceObservations").collect()).toHaveLength(0);
    });
  });
});

// Stage 13 hid Series whose next book the TOKYOPOP feed still lists: a
// sync must neither recreate nor re-queue them.
describe("prh.sync — hidden Series stay hidden", () => {
  const EMMA_3 = {
    isbn: "9781427880666",
    title: "Emma & Capucine, Volume 3",
    seriesNumber: 3,
    onsale: "2026-10-06",
    imprint: "TOKYOPOP",
  };

  async function hideEmma(t: TestT) {
    await t.run((ctx) => insertSeries(ctx, { status: "hidden", publicId: 15853, title: "Emma & Capucine" }));
  }

  for (const bootstrap of [true, false]) {
    it(`records the book on its observation only (${bootstrap ? "Bootstrap Mode" : "steady state"})`, async () => {
      const t = makeT();
      await seedRegistry(t, bootstrap);
      await hideEmma(t);
      stubApi([EMMA_3]);
      await sync(t);
      await t.run(async (ctx) => {
        const series = await ctx.db.query("series").collect();
        expect(series.map((s) => s.status)).toEqual(["hidden"]);
        expect(await ctx.db.query("releases").collect()).toHaveLength(0);
        expect(await ctx.db.query("proposals").collect()).toHaveLength(0);
        const [obs] = await ctx.db.query("sourceObservations").collect();
        expect(obs?.recordRef).toBeUndefined();
        expect(obs?.conflicts?.find((c) => c.field === "placement")?.reason).toContain(
          "Series 15853",
        );
      });
    });
  }
});

/** PRH's registry row. */
const prhSource = (ctx: MutationCtx) =>
  ctx.db
    .query("approvedSources")
    .withIndex("by_key", (q) => q.eq("key", "prh"))
    .unique();

/** Queued reviews; in these runs, only withdrawal's possible-cancellation hides. */
const reviews = async (ctx: MutationCtx) =>
  (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview");

/** A listed entry the parser drops as out of scope: it fills a page without applying. */
const LIGHT_NOVEL: FixtureTitle = { isbn: "9781646519811", title: "Excluded Story (Light Novel) Vol. 1" };

/** Two list pages, one manga each: 199 light novels and a manga, then another manga. */
const TWO_PAGES: FixtureTitle[] = [
  ...Array.from({ length: 199 }, () => LIGHT_NOVEL),
  { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
  { isbn: "9781646519835", title: "Included Manga 2", seriesNumber: 2 },
];

/** The listed title of `seedListedAndGone`, as a full sweep still lists it. */
const LISTED_TITLE: FixtureTitle = {
  isbn: "9781646094356",
  title: "Witch Hat Atelier 15",
  seriesNumber: 15,
  onsale: "2099-01-15",
};

/**
 * Two future-dated Releases PRH observed on an earlier sweep: `listed` is
 * still listed (LISTED_TITLE), `gone` no longer is, so only a complete sweep
 * may withdraw it, queueing one possible-cancellation review.
 */
async function seedListedAndGone(t: TestT) {
  return await t.run(async (ctx) => {
    const pubDate = { year: 2099, month: 1, day: 15, sort: 20990115 };
    const listedRelease = await seedCatalog(ctx, {
      series: { title: "Witch Hat Atelier" },
      volume: { position: 15 },
      release: { isbn13: LISTED_TITLE.isbn, pubDate },
    });
    const goneRelease = await seedCatalog(ctx, {
      series: { title: "Gone Manga" },
      volume: { position: 1 },
      release: { isbn13: "9781646519842", pubDate },
    });
    const listed = await insertObservation(ctx, {
      sourceKey: "prh",
      sourceRecordId: LISTED_TITLE.isbn,
      recordRef: { type: "release", id: listedRelease.releaseId },
    });
    const gone = await insertObservation(ctx, {
      sourceKey: "prh",
      sourceRecordId: "9781646519842",
      recordRef: { type: "release", id: goneRelease.releaseId },
    });
    return { listed, gone };
  });
}

/**
 * Disable PRH while the action reads the list page at `start` (and turn it
 * back on before the page arrives, with `reenable`), wrapping the stub
 * stubApi installed.
 */
function disableOnPage(t: TestT, start: number, { reenable = false } = {}) {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (new URL(url).searchParams.get("start") === String(start)) {
      await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
      if (reenable) await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: true });
    }
    return await inner(input);
  });
}

describe("prh.sync — continuation links", () => {
  it("hands off between imprints too, carrying the effective imprint list", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    // Two one-page imprints and a zero budget: the first link must hand off
    // after imprint one even though no page boundary triggered a check.
    const clock = tickingClock();
    const first = await sync(t, { imprints: ["AA", "BB"], linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true });
    expect(requestedUrls).toHaveLength(1);
    await expectStampedAtHandOff(t);
    clock.mockRestore();
    await drain(t);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain("/imprints/BB/");
    await t.run(async (ctx) => {
      if (!("runId" in first)) throw new Error("Expected an import run");
      expect((await ctx.db.get(first.runId))?.status).toBe("succeeded");
    });
  });

  // The shared gate (lib/importRuns.ts): a scheduled run whose source was
  // disabled between links closes as stopped, which leaves source health alone.
  it("stops a scheduled run at its next link once the source is disabled", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      ...Array.from({ length: 200 }, () => ({ isbn: "9781646519811", title: "Excluded Story (Light Novel) Vol. 1" })),
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
    ]);
    const first = await sync(t, { linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    await drain(t);
    await t.run(async (ctx) => {
      if (!("runId" in first)) throw new Error("Expected an import run");
      const run = await ctx.db.get(first.runId);
      expect(run).toMatchObject({ status: "stopped", automatic: true });
      expect(run?.errors.at(-1)).toBe("Stopped: the source was disabled mid-run.");
      expect(await prhSource(ctx)).toMatchObject({ consecutiveFailures: 0, healthState: "healthy" });
    });
  });

  // The gate is checked before the configuration, so a scheduled run that
  // lost both stops rather than fails.
  it("stops a scheduled continuation that finds the source disabled and unconfigured", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh", automatic: true });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    vi.stubEnv("PRH_API_KEY", "");
    expect(await sync(t, { runId, seen: 3, changed: 1, errors: ["carried"] })).toEqual({ skipped: "disabled" });
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run).toMatchObject({ status: "stopped", recordsSeen: 3, recordsChanged: 1 });
      expect(run?.errors).toEqual(["carried", "Stopped: the source was disabled mid-run."]);
      expect(await prhSource(ctx)).toMatchObject({ consecutiveFailures: 0 });
    });
  });

  // A fresh call without a key only skips (see "prh.sync — configuration");
  // a continuation that loses its key closes its run as failed, a forced run
  // on a disabled source included: a missing key is a configuration failure.
  it("closes a resumed run when the key was removed between links", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    vi.stubEnv("PRH_API_KEY", "");
    expect(await sync(t, { runId, errors: ["carried"] })).toEqual({ skipped: "unconfigured" });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    const forcedId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    expect(await sync(t, { runId: forcedId })).toEqual({ skipped: "unconfigured" });
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errors).toEqual([
        "carried",
        "Stopped mid-run: PRH_API_KEY / PRH_IMPRINT_CODES were removed.",
      ]);
      expect((await ctx.db.get(forcedId))?.status).toBe("failed");
      expect(await prhSource(ctx)).toMatchObject({ consecutiveFailures: 2 });
    });
  });

  it("finishes an operator-forced run on an enabled source", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    expect(await sync(t, { runId })).toMatchObject({ runId, recordsSeen: 1 });
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run).toMatchObject({ status: "succeeded" });
      expect(run?.automatic).toBeUndefined();
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519828"]);
    });
  });

  // A forced run means the same for every source: it imports while the
  // source is disabled, and its complete full sweep withdraws only what PRH
  // no longer lists.
  it("imports and withdraws through an operator-forced run on a disabled source", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const { listed, gone } = await seedListedAndGone(t);
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    expect(await sync(t)).toEqual({ skipped: "disabled" });

    // A full sweep that still lists the imported title, and one new title.
    stubApi([LISTED_TITLE, { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    expect(await sync(t, { runId })).toMatchObject({ runId, recordsSeen: 2, completeSweep: true });
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run?.status).toBe("succeeded");
      expect(run?.automatic).toBeUndefined();
      expect(await ctx.db.get(listed)).toMatchObject({ withdrawn: false });
      expect(await ctx.db.get(gone)).toMatchObject({ withdrawn: true });
      const fresh = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "9781646519828",
      );
      expect(fresh?.recordRef?.type).toBe("release");
      // One possible-cancellation review: the future-dated Release PRH dropped.
      const queued = await reviews(ctx);
      expect(queued).toHaveLength(1);
      expect((await ctx.db.get(gone))?.queuedProposalId).toBe(queued[0]?._id);
    });
  });

  it("withdraws nothing when the source is disabled inside the final link of a full sweep", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const { listed, gone } = await seedListedAndGone(t);
    // Two list pages, one per link: the source is disabled while the second
    // link reads its page.
    stubApi([...Array.from({ length: 200 }, () => LIGHT_NOVEL), LISTED_TITLE]);
    disableOnPage(t, 200);
    const first = await sync(t, { linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true });
    await drain(t);
    expect(requestedUrls).toHaveLength(2);
    if (!("runId" in first)) throw new Error("Expected an import run");
    await t.run(async (ctx) => {
      const run = await ctx.db.get(first.runId);
      expect(run).toMatchObject({ status: "stopped", automatic: true, recordsSeen: 1 });
      // The page already under way finished: the listed title was seen.
      expect((await ctx.db.get(listed))?.lastSeenAt).toBeGreaterThan(0);
      expect(await ctx.db.get(listed)).toMatchObject({ withdrawn: false });
      expect(await ctx.db.get(gone)).toMatchObject({ withdrawn: false });
      expect(await reviews(ctx)).toHaveLength(0);
      expect(await prhSource(ctx)).toMatchObject({ consecutiveFailures: 0 });
    });

    // Re-enabled, the next complete sweep withdraws what is really gone.
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: true });
    vi.unstubAllGlobals();
    stubApi([LISTED_TITLE]);
    expect(await sync(t)).toMatchObject({ completeSweep: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(listed)).toMatchObject({ withdrawn: false });
      expect(await ctx.db.get(gone)).toMatchObject({ withdrawn: true });
      const queued = await reviews(ctx);
      expect(queued).toHaveLength(1);
      expect((await ctx.db.get(gone))?.queuedProposalId).toBe(queued[0]?._id);
    });
  });

  // A chain scheduled before `observedEveryPage` existed refused applies once
  // its source was disabled, yet handed on completeSweep: true. Its run has
  // no automatic flag, so it carries on; its sweep must not withdraw.
  it("never withdraws through a continuation scheduled without observedEveryPage", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const { listed, gone } = await seedListedAndGone(t);
    // Page 0 listed LISTED_TITLE, whose apply was refused; the link handed
    // page 200 on as a complete sweep.
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    stubApi([LISTED_TITLE, ...Array.from({ length: 200 }, () => LIGHT_NOVEL)]);
    const continuation = {
      imprints: ["KODCM"],
      runStartedAt: Date.now(),
      imprintIndex: 0,
      start: 200,
      pages: 1,
      seen: 1,
      changed: 0,
      recordFailures: 0,
      completeSweep: true,
      errors: [],
    };
    expect(await sync(t, { ...continuation, runId })).toMatchObject({ completeSweep: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(runId)).toMatchObject({ status: "succeeded" });
      expect(await ctx.db.get(listed)).toMatchObject({ withdrawn: false });
      expect(await ctx.db.get(gone)).toMatchObject({ withdrawn: false });
      expect(await reviews(ctx)).toHaveLength(0);
    });

    // The same continuation with the marker completes the sweep: page 200
    // now lists LISTED_TITLE, and only the gone title is withdrawn.
    vi.unstubAllGlobals();
    stubApi([...Array.from({ length: 200 }, () => LIGHT_NOVEL), LISTED_TITLE]);
    const markedId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    expect(
      await sync(t, { ...continuation, runStartedAt: Date.now(), runId: markedId, observedEveryPage: true }),
    ).toMatchObject({ completeSweep: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(listed)).toMatchObject({ withdrawn: false });
      expect(await ctx.db.get(gone)).toMatchObject({ withdrawn: true });
    });
  });

  it("finishes the page under way and stops before the next when the source is disabled", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi(TWO_PAGES);
    disableOnPage(t, 0);
    const result = await sync(t);
    expect(result).toMatchObject({ stopped: true, recordsSeen: 1, recordsChanged: 1, completeSweep: false });
    expect(requestedUrls).toHaveLength(1);
    await t.run(async (ctx) => {
      if (!("runId" in result)) throw new Error("Expected an import run");
      const run = await ctx.db.get(result.runId);
      expect(run).toMatchObject({ status: "stopped", automatic: true, recordsSeen: 1, recordsChanged: 1 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519828"]);
    });
  });

  it("does not interrupt a run whose source is disabled and re-enabled within one page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi(TWO_PAGES);
    disableOnPage(t, 0, { reenable: true });
    expect(await sync(t)).toMatchObject({ recordsSeen: 2, completeSweep: true });
    expect(requestedUrls).toHaveLength(2);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("importRuns").first())?.status).toBe("succeeded");
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId).sort()).toEqual(["9781646519828", "9781646519835"]);
    });
  });

  it("leaves source health alone through repeated disables", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    for (let i = 0; i < 3; i++) {
      vi.unstubAllGlobals();
      requestedUrls.length = 0;
      stubApi(TWO_PAGES);
      disableOnPage(t, 0);
      expect(await sync(t)).toMatchObject({ stopped: true });
      await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: true });
    }
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs.map((run) => run.status)).toEqual(["stopped", "stopped", "stopped"]);
      expect(await prhSource(ctx)).toMatchObject({ consecutiveFailures: 0, healthState: "healthy" });
    });
  });

  it("hands off at a page boundary when the link budget is spent and finishes the sweep in the next link", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Two list pages: 200 out-of-scope titles, then one manga.
    stubApi([
      ...Array.from({ length: 200 }, () => ({
        isbn: "9781646519811",
        title: "Excluded Story (Light Novel) Vol. 1",
      })),
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
    ]);
    // A zero budget hands off after the first page instead of fetching the second.
    const first = await sync(t, { linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true, recordsSeen: 0, completeSweep: false });
    expect(requestedUrls).toHaveLength(1);
    if (!("runId" in first)) throw new Error("Expected an import run");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(first.runId))?.status).toBe("running");
    });

    await drain(t);

    // The second link resumed at page two under the same run: one more
    // fetch, the manga applied, and the complete sweep's withdrawal pass ran.
    expect(requestedUrls).toHaveLength(2);
    await t.run(async (ctx) => {
      const run = await ctx.db.get(first.runId);
      expect(run).toMatchObject({ status: "succeeded", recordsSeen: 1 });
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519828"]);
      expect(await ctx.db.query("importRuns").collect()).toHaveLength(1);
    });
  });
});

const WITCH_HAT_15: FixtureTitle = {
  isbn: "9781646094356",
  title: "Witch Hat Atelier 15",
  seriesNumber: 15,
  onsale: "2026-12-08",
  imprint: "Kodansha Comics",
  priceUsd: 12.99,
};

describe("prh.sync — Binding reaches the matching ladder (B14)", () => {
  it("a paperback never links an ISBN-less hardcover of its Volume; it becomes its sibling", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const { releaseId: hardcoverId } = await seedWitchHat15(t, { binding: "hardcover" });
    stubApi([WITCH_HAT_15]);
    await sync(t);

    await t.run(async (ctx) => {
      const hardcover = (await ctx.db.get(hardcoverId))!;
      expect(hardcover.isbn13).toBeUndefined();
      const paperback = (await ctx.db.query("releases").collect()).find(
        (r) => r.isbn13 === WITCH_HAT_15.isbn,
      );
      expect(paperback).toMatchObject({ binding: "paperback", editionId: hardcover.editionId });
    });
  });
});

describe("prh.sync — a linked title never gives its ISBN to a second Release (B08)", () => {
  it("while another Release holds the ISBN, none of the title's facts reach its ISBN-less link", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([WITCH_HAT_15]);
    await sync(t);
    // An Editor moved the ISBN from the linked Release onto another one.
    const { linkedId, holderId } = await t.run(async (ctx) => {
      const linked = (await ctx.db.query("releases").collect())[0]!;
      const { _id, _creationTime, ...fields } = linked;
      await ctx.db.patch(_id, { isbn13: undefined });
      const holderId = await ctx.db.insert("releases", { ...fields, binding: "hardcover" });
      return { linkedId: _id, holderId };
    });

    vi.unstubAllGlobals();
    stubApi([{ ...WITCH_HAT_15, priceUsd: 14.99 }]);
    const result = await sync(t);

    await t.run(async (ctx) => {
      const linked = (await ctx.db.get(linkedId))!;
      expect(linked.isbn13).toBeUndefined();
      expect(linked.price).toEqual({ amountCents: 1299, currency: "USD" });
      const holders = (await ctx.db.query("releases").collect()).filter(
        (r) => r.isbn13 === WITCH_HAT_15.isbn,
      );
      expect(holders.map((r) => r._id)).toEqual([holderId]);
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "prh").eq("sourceRecordId", WITCH_HAT_15.isbn),
        )
        .unique();
      expect(observation!.conflicts).toEqual([
        expect.objectContaining({ field: "isbn13", offered: WITCH_HAT_15.isbn }),
      ]);
    });
    expect(result).toMatchObject({ errorCount: 1 });
  });
});

// R08: the shared catalog-title queue carries a packaged guess's Edition
// Line, so approving the reviewed proposal files the Edition under it.
describe("prh.sync — queued packaging keeps its Edition Line (B16)", () => {
  it("approving a steady-state omnibus creates its Edition Line and files the Edition under it", async () => {
    const t = makeT();
    await seedTeam(t, [alice]);
    const admin = signedIn(t, alice);
    await seedRegistry(t, false);
    const seriesId = await backbone(t, "Noragami", ["19", "20"]);
    stubApi([{ isbn: "9781646519026", title: "Noragami Omnibus 7 (Vol. 19-21)", seriesNumber: 7 }]);
    await sync(t);
    const [proposal] = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(proposal).toMatchObject({ state: "inReview" });
    expect(
      await admin.mutation(api.proposals.approveProposal, { proposalId: proposal!._id }),
    ).toMatchObject({ status: "approved" });
    await t.run(async (ctx) => {
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ seriesId, name: "Omnibus" }]);
      const [edition] = await ctx.db.query("editions").collect();
      expect(edition).toMatchObject({ editionLineId: lines[0]!._id, linePosition: "7" });
      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition!._id))
        .collect();
      expect(coverage).toHaveLength(3);
    });
  });
});

// R09: a box set imported before its books picks them up when a later
// sweep applies it again, unchanged, in steady state too.
describe("prh.sync — a box set gains members that arrive after it (B15)", () => {
  it("an unchanged box re-applied after its books arrive links them", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Fire Force", []);
    const box = { isbn: "9798888772584", title: "Fire Force Manga Box Set 1 (Vol. 1-2)", seriesNumber: 1 };
    stubApi([box]);
    await sync(t);
    const members = async () => (await bundleMembers(t)).map((member) => member.release.isbn13);
    expect(await members()).toEqual([]);

    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    stubApi([
      { isbn: "9781632364425", title: "Fire Force 1", seriesNumber: 1 },
      { isbn: "9781632364432", title: "Fire Force 2", seriesNumber: 2 },
      box,
    ]);
    await sync(t);
    expect(await members()).toEqual(["9781632364425", "9781632364432"]);
    await t.run(async (ctx) => {
      const revisions = (await ctx.db.query("revisions").collect()).filter(
        (r) => r.ref.type === "releaseBundle",
      );
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!.changes.map((c) => c.field)).toEqual(["members"]);
    });
  });
});

// R12: a statement that lists Volumes with a gap ("Vol. 1 & 3", "Collects
// volumes 1 and 3") is evidence, not silence. No range can hold it, so the
// book stays Unmapped Packaging; the line's declared size (3-in-1 → 1–3)
// never stands in and invents the Volume it skips. The grammar is pinned by
// lib/coverage.test.ts and lib/bookTitle.test.ts; these cases prove PRH's
// wiring: each input (title, flap copy, keynote) reaches it, and each
// outcome (placed, Unmapped, nothing created) lands in the catalog.
describe("prh.sync — a gapped coverage statement is never widened (R12)", () => {
  /** The Volume labels, the labels covered, each Edition's Unmapped flag, and the Release count, after a sync. */
  async function placed(t: TestT) {
    return await t.run(async (ctx) => {
      const labels = new Map(
        (await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]),
      );
      const editions = await ctx.db.query("editions").collect();
      return {
        volumes: [...labels.values()].sort(),
        covered: (await ctx.db.query("volumeCoverages").collect()).map((c) => labels.get(c.volumeId)).sort(),
        unmapped: editions.map((e) => e.coverageUnmapped ?? false),
        releases: (await ctx.db.query("releases").collect()).length,
      };
    });
  }

  const ONE_TO_THREE = ["1", "2", "3"];
  /** Placed: covering `covered` (by default every Volume there is). */
  const covering = (volumes: string[], covered = volumes) => ({ volumes, covered, unmapped: [false], releases: 1 });
  /** Unmapped Packaging under its line, covering nothing. */
  const unmapped = (volumes: string[]) => ({ volumes, covered: [], unmapped: [true], releases: 1 });
  /** No Edition and no Release: the observation waits for an Editor. */
  const NOTHING = { volumes: [], covered: [], unmapped: [], releases: 0 };

  // `backbone`: the Volumes of an existing "Alpha" Series; without it the
  // catalog is empty, so every Volume after the sync is one the import made.
  const WIRING = [
    // The title.
    {
      name: "a title listing Volumes 1 & 3 never falls back to the 3-in-1 size",
      title: "Alpha 3-in-1 Edition 1 (Vol. 1 & 3)",
      backbone: ["1", "3"],
      expected: unmapped(["1", "3"]),
    },
    {
      name: "a title's own range creates and covers its Volumes",
      title: "Alpha Omnibus 2 (Vol. 4-6)",
      expected: covering(["4", "5", "6"]),
    },
    {
      name: "a title stating nothing is placed by its line's size",
      title: "Persona 3 & 4 3-in-1 Edition 1",
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "a page count in a title statement creates Volume 1 alone",
      title: "Alpha Deluxe Edition 1 (Collecting Vol. 1 plus 16 pages of art)",
      expected: covering(["1"]),
    },
    {
      name: "a bare range beside a rejected bracket statement creates nothing",
      title: "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)",
      expected: NOTHING,
    },
    {
      name: "an earlier marker makes a trailing statement a plain Volume's subtitle",
      title: "Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3",
      expected: covering(["2"]),
    },
    // The title over the flap copy.
    {
      name: "the title's range decides over a gapped blurb",
      title: "Alpha Omnibus 1 (Vol. 1-3)",
      flapcopy: "<p>Collects volumes 1 and 3.</p>",
      backbone: ONE_TO_THREE,
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "the title's gap decides over a blurb's range",
      title: "Alpha Omnibus 1 (Vol. 1 & 3)",
      flapcopy: "<p>Collects volumes 1-3.</p>",
      backbone: ONE_TO_THREE,
      expected: unmapped(ONE_TO_THREE),
    },
    {
      name: "a blurb never stands in for a title statement the outer range contradicts",
      title: "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)",
      flapcopy: "<p>Collects volumes 1-9.</p>",
      expected: unmapped([]),
    },
    // The flap copy.
    {
      name: "a blurb collecting Volumes 1 and 3 never falls back to the 3-in-1 size",
      title: "Alpha 3-in-1 Edition 1",
      flapcopy: "<p>Collects volumes 1 and 3.</p>",
      backbone: ["1", "3"],
      expected: unmapped(["1", "3"]),
    },
    {
      name: "a stated range before other numbers places a Deluxe book at 1–3",
      title: "Alpha Deluxe Edition 1",
      flapcopy: "<p>Collects volumes 1-3 of Mob Psycho 100.</p>",
      backbone: ONE_TO_THREE,
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "a count after the list places the 3-in-1 at 1–3, never 1–4",
      title: "Alpha 3-in-1 Edition 1",
      flapcopy: "<p>Collects volumes 1-3 and 4 (four!) bonus stories.</p>",
      backbone: ONE_TO_THREE,
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "a bare narrative list leaves a Deluxe book Unmapped",
      title: "Alpha Deluxe Edition 1",
      flapcopy: "<p>The story continues in volumes 4 and 5.</p>",
      backbone: ONE_TO_THREE,
      expected: unmapped(ONE_TO_THREE),
    },
    {
      name: "a governed statement the size at position 2 contradicts leaves the 3-in-1 Unmapped",
      title: "Alpha 3-in-1 Edition 2",
      flapcopy: "<p>Collects the hit series volumes 1-3.</p>",
      backbone: ONE_TO_THREE,
      expected: unmapped(ONE_TO_THREE),
    },
    {
      name: "a joined range creates and covers every Volume it names",
      title: "Alpha Deluxe Edition 1",
      flapcopy: "<p>Collects volumes 1-3 plus 4-6 in one book.</p>",
      expected: covering(["1", "2", "3", "4", "5", "6"]),
    },
    {
      name: "a list the verb in another block does not govern places the 3-in-1 by its size",
      title: "Alpha 3-in-1 Edition 1",
      flapcopy: "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5</p>",
      backbone: ONE_TO_THREE,
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "a Series title's own '!' before its Volumes places a Deluxe book by the statement",
      title: "Negima! Deluxe Edition 1",
      flapcopy: "<p>Collects Negima! Volumes 37-38.</p>",
      expected: covering(["37", "38"]),
    },
    // The keynote, after the flap copy.
    {
      name: "a narrative flap copy leaves the keynote to place a Deluxe book",
      title: "Alpha Deluxe Edition 1",
      flapcopy: "<p>The story continues in volumes 4 and 5.</p>",
      keynote: "<p>Collects volumes 1-3.</p>",
      backbone: ONE_TO_THREE,
      expected: covering(ONE_TO_THREE),
    },
    {
      name: "a later hint's gapped list blocks the size too, while silence before it does not decide",
      title: "Alpha 3-in-1 Edition 1",
      flapcopy: "<p>The saga begins in a giant edition.</p>",
      keynote: "<p>Collects <i>Alpha</i> Volumes 1, 3, and a bonus story.</p>",
      backbone: ["1", "3"],
      expected: unmapped(["1", "3"]),
    },
    {
      name: "a gapped flap copy blocks a later keynote's range",
      title: "Alpha 3-in-1 Edition 1",
      flapcopy: "<p>Volumes 1 and 3 in one book!</p>",
      keynote: "<p>Collects volumes 1-3.</p>",
      backbone: ONE_TO_THREE,
      expected: unmapped(ONE_TO_THREE),
    },
  ];

  it.each(WIRING.map((row) => [`${row.name}: ${row.title}`, row] as const))("%s", async (_, row) => {
    const { title, flapcopy, keynote, backbone: volumes, expected } = row;
    const t = makeT();
    await seedRegistry(t, true);
    if (volumes) await backbone(t, "Alpha", volumes);
    stubApi([{ isbn: "9781646519828", title, flapcopy, keynote }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    expect(await placed(t)).toEqual(expected);
  });

  // "Part N, Vol. M" is Volume M of the Part's Series: no packaging, and no
  // Volume N is created.
  it("a title Alpha: Part 5, Vol. 6 is one Volume of its Part, never packaging", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title: "Alpha: Part 5, Vol. 6" }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s.title)).toEqual(["Alpha: Part 5"]);
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label)).toEqual(["6"]);
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(0);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.coverageUnmapped ?? false)).toEqual([false]);
    });
  });

  // Re-syncing a placed book with each kind of blurb never invents a Volume
  // or drops a covered one.
  it("re-applying a placed Deluxe book's changing blurb keeps its Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Alpha", ["1", "2", "3"]);
    for (const flapcopy of [
      "<p>Collects volumes 1-3.</p>",
      "<p>Collects volumes 1-3 and 4 bonus stories.</p>",
      "<p>Collects volumes 1 and 3.</p>",
      "<p>Collects volumes 1-3.</p>",
    ]) {
      stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
      await sync(t);
      expect((await placed(t)).volumes, flapcopy).toEqual(["1", "2", "3"]);
    }
    expect((await placed(t)).covered).toEqual(["1", "2", "3"]);
  });

  // N04 follow-up: a box whose title agrees links its members; one whose
  // subtitle lists other Volumes states no coverage, so it is held rather
  // than made an empty bundle.
  const syncBox = async (title: string) => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781646519040", title: "Alpha 4", seriesNumber: 4 },
      { isbn: "9781646519057", title: "Alpha 5", seriesNumber: 5 },
      { isbn: "9781646519064", title: "Alpha 6", seriesNumber: 6 },
      { isbn: "9798888772607", title },
    ]);
    await sync(t);
    return t;
  };

  it("a box set (Alpha Vol. 4-6 Box Set) links the members its title states", async () => {
    expect(await bundleMembers(await syncBox("Alpha Vol. 4-6 Box Set"))).toHaveLength(3);
  });

  it("a box set (Alpha Vol. 4-6 Omnibus 1-3 Box Set) whose title disagrees with itself is held, not bundled", async () => {
    const t = await syncBox("Alpha Vol. 4-6 Omnibus 1-3 Box Set");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseBundles").collect()).toHaveLength(0);
      expect((await ctx.db.query("placementHolds").collect()).map((hold) => hold.kind)).toEqual(["packaging"]);
    });
  });
});

// W08: a linked box is filled only from its canonical identity — the
// Bundle's Format and the Series its members already belong to. A source
// that later names another Series or Format goes to review (a placement
// conflict on the observation, a `review` run error), never auto-inserted.
describe("prh.applyTitle — a linked box keeps its canonical identity (W08)", () => {
  const book = (title: string, isbn: string, format = "Trade Paperback") =>
    parseTitle({
      isbn,
      title,
      seriesNumber: 1,
      format: { description: format },
      imprint: { description: "Kodansha Comics" },
    })!;
  const apply = (t: TestT, snapshot: ReturnType<typeof book>) =>
    t.mutation(internal.prh.applyTitle, { snapshot });
  const BOX_ISBN = "9798888772584";
  /** The one bundle, its members (`isbn:format`) and orders in page order, its Revision count, and the box's conflicts. */
  const bundleState = async (t: TestT) => {
    const members = await bundleMembers(t);
    return await t.run(async (ctx) => {
      const [bundle] = await ctx.db.query("releaseBundles").collect();
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "releaseBundle").eq("ref.id", bundle!._id))
        .collect();
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "prh").eq("sourceRecordId", BOX_ISBN),
        )
        .unique();
      return {
        bundle: bundle!,
        members: members.map(({ release }) => `${release.isbn13}:${release.format}`),
        orders: members.map((member) => member.order),
        revisions: revisions.length,
        conflicts: observation!.conflicts?.map((c) => c.field) ?? [],
      };
    });
  };

  it("a box re-observed under another Series adds nothing and goes to review", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await apply(t, book("Alpha Vol. 1", "9781646519026"));
    await apply(t, book("Beta Vol. 1", "9781646519033"));
    await apply(t, book("Alpha Box Set 1 (Vol. 1-2)", BOX_ISBN));
    const before = await bundleState(t);
    expect(before.members).toEqual(["9781646519026:physical"]);

    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    const result = await apply(t, book("Beta Box Set 1 (Vol. 1-2)", BOX_ISBN));
    expect(result).toMatchObject({ status: "needsReview", changed: false });
    expect(result.reason).toMatch(/Series/);
    const after = await bundleState(t);
    expect(after.members).toEqual(["9781646519026:physical"]);
    expect(after.bundle.name).toBe("Alpha Box Set 1 (Vol. 1-2)");
    expect(after.revisions).toBe(before.revisions);
    expect(after.conflicts).toEqual(["placement"]);
  });

  it("a physical box re-observed as digital adds no digital member", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await apply(t, book("Alpha Vol. 1", "9781646519026"));
    await apply(t, book("Alpha Vol. 1", "9781646519033", "E-Book"));
    const box = book("Alpha Box Set 1 (Vol. 1-2)", BOX_ISBN);
    await apply(t, box);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });

    const result = await apply(t, { ...box, format: "digital", binding: undefined });
    expect(result).toMatchObject({ status: "needsReview" });
    expect(result.reason).toMatch(/Format/);
    const after = await bundleState(t);
    expect(after.bundle.format).toBe("physical");
    expect(after.members).toEqual(["9781646519026:physical"]);
    expect(after.conflicts).toEqual(["placement"]);
  });

  it("an unchanged box still fills the Volume that arrives later", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await apply(t, book("Alpha Vol. 1", "9781646519026"));
    const box = book("Alpha Box Set 1 (Vol. 1-2)", BOX_ISBN);
    await apply(t, box);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });
    await apply(t, book("Alpha Vol. 2", "9781646519040"));
    expect(await apply(t, box)).toMatchObject({ status: "updated", changed: true });
    const after = await bundleState(t);
    expect(after.members).toEqual(["9781646519026:physical", "9781646519040:physical"]);
    expect(after.conflicts).toEqual([]);
  });

  // W09: a legacy bundle made when only Vol. 2 existed stored it at the
  // compact order 1; Vol. 1 arriving later must sort first, not collide.
  it("a legacy compact order is renumbered when the missing Volume arrives", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await apply(t, book("Alpha Vol. 2", "9781646519040"));
    const box = book("Alpha Box Set 1 (Vol. 1-2)", BOX_ISBN);
    await apply(t, box);
    await t.run(async (ctx) => {
      const [member] = await ctx.db.query("bundleMemberships").collect();
      await ctx.db.patch(member!._id, { order: 1 });
    });
    await apply(t, book("Alpha Vol. 1", "9781646519026"));
    await apply(t, box);
    const after = await bundleState(t);
    expect(after.members).toEqual(["9781646519026:physical", "9781646519040:physical"]);
    expect(after.orders).toEqual([1, 2]);
  });
});

// Mature Series (lib/mature.ts) from PRH's books of an adult-only imprint:
// "His Sensual Whisper" as production holds it (Series 622: three Steamship
// Editions, PRH titles naming the imprint, ANN's entry, no Seven Seas
// page), and the same imprint on new imports, read where a viewer who has
// not opted in looks: the home page's two shelves and the library.
describe("prh — a book of an adult-only imprint makes its Series mature", () => {
  const TITLE = "His Sensual Whisper: The Voice That Sets Me On Fire";
  const ISBNS = ["9798893739404", "9798893739411", "9798893739428"];
  const SEPTEMBER = { year: 2025, month: 9, day: 9, sort: 20250909 };

  /** Volume `n` as PRH lists it, under the Steamship imprint. */
  const steamshipBook = (n: number) =>
    parseTitle({
      isbn: ISBNS[n - 1],
      title: `${TITLE}, Vol. ${n}`,
      seriesNumber: n,
      onsale: "2025-09-09",
      format: { description: "Trade Paperback" },
      imprint: { description: "Steamship" },
    })!;
  const apply = (t: TestT, n: number) =>
    t.mutation(internal.prh.applyTitle, { snapshot: steamshipBook(n) });
  const seed = (t: TestT) => t.mutation(internal.launch.seedPublishers, {});
  const rebuild = (t: TestT) => t.action(internal.seriesBrowse.rebuild, {});

  // The library projection job waits until the test runs it.
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * Three Editions under the publisher row `slug` (unmarked), each Release
   * linked to its PRH title, and ANN's entry on the Series rating nothing.
   */
  const fileUnder = (
    t: TestT,
    slug: "steamship" | "seven-seas",
    series: { contentRating?: "general" } = {},
  ) =>
    t.run(async (ctx) => {
      const name = slug === "steamship" ? "Steamship" : "Seven Seas";
      const publisherId = await insertPublisher(ctx, { name, slug });
      const seriesId = await insertSeries(ctx, { title: TITLE, ...series });
      for (const n of [1, 2, 3]) {
        const volumeId = await insertVolume(ctx, { seriesId, position: n });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        const book = steamshipBook(n);
        const releaseId = await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          isbn13: book.isbn13,
          pubDate: SEPTEMBER,
        });
        await insertObservation(ctx, {
          sourceKey: "prh",
          sourceRecordId: book.isbn13,
          snapshot: book,
          recordRef: { type: "release", id: releaseId },
        });
      }
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:31234",
        snapshot: { title: TITLE },
        recordRef: { type: "series", id: seriesId },
      });
    });

  /** The Series' flag, and whether each place shows it to a viewer who has not opted in. */
  async function shownTo(t: TestT) {
    const titled = (items: Array<{ title: string }>) => items.some((item) => item.title === TITLE);
    const series = await t.run(async (ctx) =>
      (await ctx.db.query("series").collect()).find((s) => s.title === TITLE),
    );
    return {
      mature: series?.mature,
      newest: titled(await t.query(api.catalog.recentSeries, { limit: 28, showMature: false })),
      month: (
        await t.query(api.releases.monthBrowse, { year: 2025, month: 9, showMature: false })
      ).releases.some((row) => titled(row.series)),
      library: titled(
        (await t.query(api.seriesBrowse.browse, { sort: "title", showMature: false })).items,
      ),
    };
  }
  const LISTED = { mature: undefined, newest: true, month: true };
  const HIDDEN = { mature: true, newest: false, month: false, library: false };
  /**
   * Whether the Series' library row and pack entry carry the flag: the
   * projection the filtered library's totals and facets count from, which
   * follows the import in a scheduled job (seriesBrowse.projectMature).
   */
  const projected = (t: TestT) =>
    t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect()).find((s) => s.title === TITLE)!;
      const row = await ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .unique();
      const pack = await ctx.db
        .query("seriesStatsPacks")
        .withIndex("by_block", (q) => q.eq("block", Math.floor(series.publicId / PACK_SPAN)))
        .unique();
      const entry = pack?.entries.find((e) => e.publicId === series.publicId);
      return { row: row?.mature === true, pack: entry?.mature === true };
    });
  /** Whether the library has a row for the Series at all (a viewer who opted in sees it). */
  const inLibrary = async (t: TestT) =>
    (await t.query(api.seriesBrowse.browse, { sort: "title", showMature: true })).items.some(
      (item) => item.title === TITLE,
    );

  it("production's Series under an unmarked Steamship row: the seed and a rebuild flag it, the seed alone does not", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await fileUnder(t, "steamship");
    expect(await shownTo(t)).toMatchObject(LISTED);

    const seeded = await seed(t);
    expect(seeded.markedAdultOnly).toContain("steamship");
    expect(await shownTo(t)).toMatchObject(LISTED);

    await rebuild(t);
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await inLibrary(t)).toBe(true);
  });

  it("a Steamship title PRH imports after the seed is mature in the import's own transaction", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await seed(t);
    expect(await apply(t, 1)).toMatchObject({ status: "created" });
    const publisher = await t.run(async (ctx) => {
      const [release] = await ctx.db.query("releases").collect();
      return (await ctx.db.get(release!.publisherId))!;
    });
    expect(publisher).toMatchObject({ slug: "steamship", contentRating: "mature" });
    // No rebuild: the Series has no library row yet.
    expect(await shownTo(t)).toEqual(HIDDEN);
    await rebuild(t);
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await inLibrary(t)).toBe(true);
  });

  it("a Steamship title matching a Release filed under Seven Seas is mature in the import's own transaction", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) =>
      seedCatalog(ctx, {
        publisher: { name: "Seven Seas", slug: "seven-seas" },
        series: { title: TITLE },
        volume: { position: 1 },
        release: { isbn13: ISBNS[0], pubDate: SEPTEMBER },
      }),
    );
    await rebuild(t);
    expect(await shownTo(t)).toEqual({ ...LISTED, library: true });

    expect(await apply(t, 1)).toMatchObject({ status: "linked" });
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await projected(t)).toEqual({ row: false, pack: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await projected(t)).toEqual({ row: true, pack: true });
    expect(await inLibrary(t)).toBe(true);
  });

  it("a Series filed under Seven Seas whose PRH titles name Steamship is mature at a rebuild alone", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await fileUnder(t, "seven-seas");
    expect(await shownTo(t)).toMatchObject(LISTED);
    await rebuild(t);
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await inLibrary(t)).toBe(true);
  });

  it("a withdrawn Steamship title PRH lists again unchanged flags its Series again, before any rebuild", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await fileUnder(t, "seven-seas");
    await t.run(async (ctx) => {
      for (const obs of await ctx.db.query("sourceObservations").collect()) {
        if (obs.sourceKey === "prh") await ctx.db.patch(obs._id, { withdrawn: true });
      }
    });
    await rebuild(t);
    expect(await shownTo(t)).toEqual({ ...LISTED, library: true });

    expect(await apply(t, 1)).toMatchObject({ changed: false });
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await projected(t)).toEqual({ row: false, pack: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await shownTo(t)).toEqual(HIDDEN);
    expect(await projected(t)).toEqual({ row: true, pack: true });
    expect(await inLibrary(t)).toBe(true);
  });

  it("a Data Team general rating keeps the Series listed in each case", async () => {
    const general = { mature: undefined, newest: true, month: true, library: true };

    // Under Steamship, after the seed and a rebuild.
    let t = makeT();
    await seedRegistry(t, true);
    await fileUnder(t, "steamship", { contentRating: "general" });
    await seed(t);
    await rebuild(t);
    expect(await shownTo(t)).toEqual(general);

    // A new Steamship title placed in the Series.
    t = makeT();
    await seedRegistry(t, true);
    await seed(t);
    await backbone(t, TITLE, ["1"]);
    await t.run(async (ctx) => {
      const series = (await ctx.db.query("series").collect())[0]!;
      await ctx.db.patch(series._id, { contentRating: "general" });
    });
    expect(await apply(t, 1)).toMatchObject({ status: "created" });
    await rebuild(t);
    expect(await shownTo(t)).toEqual(general);

    // A Steamship title linking a Release under Seven Seas.
    t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) =>
      seedCatalog(ctx, {
        publisher: { name: "Seven Seas", slug: "seven-seas" },
        series: { title: TITLE, contentRating: "general" },
        volume: { position: 1 },
        release: { isbn13: ISBNS[0], pubDate: SEPTEMBER },
      }),
    );
    await rebuild(t);
    expect(await apply(t, 1)).toMatchObject({ status: "linked" });
    expect(await shownTo(t)).toEqual(general);

    // Under Seven Seas, at a rebuild.
    t = makeT();
    await seedRegistry(t, true);
    await fileUnder(t, "seven-seas", { contentRating: "general" });
    await rebuild(t);
    expect(await shownTo(t)).toEqual(general);
  });
});

// A presence batch relisting withdrawn titles of an adult-only imprint flags
// their Series in its own transaction and leaves the library packs to
// seriesBrowse.projectMature, a few Series per job (lib/mature.ts), so no
// Release's fan-out or page of ISBNs makes one transaction rewrite many
// packs near 1 MiB.
describe("prh.notePresent — relisted Steamship titles and the library projection", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * `releases` PRH titles naming Steamship, each on a Release covering
   * `perRelease` Series (publicIds from 1), every Series in a library pack
   * of 1.02 MB. Written without reads, so a test can cap the reads of what
   * follows. Returns the titles' ISBNs.
   */
  const steamshipTitles = (t: TestT, releases: number, perRelease: number, withdrawn = true) =>
    t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });
      const isbns: string[] = [];
      let publicId = 0;
      for (let r = 0; r < releases; r++) {
        const seriesIds = [];
        for (let k = 0; k < perRelease; k++) seriesIds.push(await insertSeries(ctx, { publicId: ++publicId }));
        const editionId = await insertEdition(ctx, { publisherId });
        const isbn13 = `97800000${String(r).padStart(5, "0")}`;
        const releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds, isbn13 });
        await insertObservation(ctx, {
          sourceKey: "prh",
          sourceRecordId: isbn13,
          snapshot: { isbn13, imprint: "Steamship" },
          recordRef: { type: "release", id: releaseId },
          withdrawn,
        });
        isbns.push(isbn13);
      }
      await insertFullPack(ctx);
      return isbns;
    });
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("five relisted titles, each on a Release of four Series, flag all 20 in one mutation and their pack entries after", async () => {
    const t = makeT({ transactionLimits: true });
    const isbns = await steamshipTitles(t, 5, 4);

    await t.mutation(internal.prh.notePresent, { isbns });
    expect(await matureFlags(t)).toEqual({ series: upTo(20), pack: [] });
    expect(await projectionJobs(t)).toEqual(Array(5).fill("pending"));

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await matureFlags(t)).toEqual({ series: upTo(20), pack: upTo(20) });
    expect(await projectionJobs(t)).toEqual(Array(5).fill("success"));
  });

  it("a Release covering more Series than one job projects is finished by the job's own continuations", async () => {
    // 20 rewrites of a 1.02 MB pack would pass the 16 MiB read limit.
    const t = makeT({ transactionLimits: true });
    const isbns = await steamshipTitles(t, 1, 20);

    await t.mutation(internal.prh.notePresent, { isbns });
    expect(await matureFlags(t)).toEqual({ series: upTo(20), pack: [] });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await matureFlags(t)).toEqual({ series: upTo(20), pack: upTo(20) });
    expect(await projectionJobs(t)).toEqual(Array(20 / MATURE_PROJECTIONS_PER_JOB).fill("success"));
  });

  it("the job skips a Series hidden, rated general, or deleted since the flip, and running it again changes nothing", async () => {
    const t = makeT();
    const isbns = await steamshipTitles(t, 1, 4);
    await t.mutation(internal.prh.notePresent, { isbns });
    const seriesIds = await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      const [hidden, general, deleted] = series;
      await ctx.db.patch(hidden!._id, { status: "hidden" });
      // As moderation.applyUpdate leaves a Data Team "general" rating.
      await ctx.db.patch(general!._id, { contentRating: "general", mature: undefined });
      await ctx.db.delete(deleted!._id);
      return series.map((s) => s._id);
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await matureFlags(t)).toEqual({ series: [1, 4], pack: [4] });
    expect(await projectionJobs(t)).toEqual(["success"]);

    await t.mutation(internal.seriesBrowse.projectMature, { seriesIds });
    expect(await matureFlags(t)).toEqual({ series: [1, 4], pack: [4] });
  });

  it("an ordinary page of 200 present titles reads only their observations and schedules nothing", async () => {
    // Two reads per ISBN, its observation and the last-seen patch: a title's
    // evidence applied again would read its Release and Series too.
    const t = makeT({ transactionLimits: { documentsRead: 400 } });
    const isbns = await steamshipTitles(t, 200, 1, false);

    await t.mutation(internal.prh.notePresent, { isbns });
    expect(await projectionJobs(t)).toEqual([]);
  });
});
