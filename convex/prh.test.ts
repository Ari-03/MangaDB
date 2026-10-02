// PRH adapter tests (ticket #36): the overlay run against a stubbed
// Enhanced API — no network, no key. Covers the acceptance criterion: PRH
// values apply per the authority table on PRH-distributed records only —
// authoritative ISBN/date/price overlay onto records other sources created,
// equal-authority disagreement queueing, creation boundaries, and the
// unconfigured/graceful-skip behavior.

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import * as catalogTitle from "./lib/catalogTitle";
import { parseTitle } from "./lib/prh";

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
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
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
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            recordCount: 1,
            data: { titles: [{ isbn: "9781646519828", title: null, onsale: "2099-01-05" }] },
          }),
        ),
    );
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
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            recordCount: 1,
            data: { titles: [{ isbn: "9781646519828", title: null, onsale: "2099-01-05" }] },
          }),
        ),
    );
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
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ recordCount: 1, data: { titles: [{ isbn: null, title: null }] } }),
        ),
    );
    expect(await sync(t)).toMatchObject({ completeSweep: false, errorCount: 1 });
    await t.run(async (ctx) => {
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.withdrawn).toBe(false);
    });
  });

  it("does not call a prematurely empty upstream page a complete sweep", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            recordCount: 201,
            data: { titles: [] },
          }),
        ),
    );
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
    stubApi([]);
    const result = await sync(t, { mode: "full", imprints: ["XO"] });
    expect(requestedUrls.every((u) => u.includes("/imprints/XO/titles"))).toBe(true);
    expect(result).toMatchObject({ completeSweep: false });
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
  async function backbone(t: TestT, title: string, labels: string[]) {
    return await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title,
        altTitles: [],
        searchText: title,
      });
      for (const label of labels) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: Number(label),
          seriesId,
          position: Number(label),
          label,
        });
      }
      return seriesId;
    });
  }

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
    await t.run((ctx) =>
      ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      }),
    );
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
    await t.run((ctx) =>
      ctx.db.insert("series", {
        status: "hidden",
        publicId: 15853,
        title: "Emma & Capucine",
        altTitles: [],
        searchText: "Emma & Capucine",
      }),
    );
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

describe("prh.sync — continuation links", () => {
  it("hands off between imprints too, carrying the effective imprint list", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    // Two one-page imprints and a zero budget: the first link must hand off
    // after imprint one even though no page boundary triggered a check.
    const first = await sync(t, { imprints: ["AA", "BB"], linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true });
    expect(requestedUrls).toHaveLength(1);
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain("/imprints/BB/");
    await t.run(async (ctx) => {
      if (!("runId" in first)) throw new Error("Expected an import run");
      expect((await ctx.db.get(first.runId))?.status).toBe("succeeded");
    });
  });

  // The shared gate (lib/importRuns.ts runToContinue): a scheduled run stops
  // without counting against the source's health, as the other sources do.
  it('closes a scheduled run as "stopped" when the source was disabled between links', async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      ...Array.from({ length: 200 }, () => ({ isbn: "9781646519811", title: "Excluded Story (Light Novel) Vol. 1" })),
      { isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 },
    ]);
    const first = await sync(t, { linkBudgetMs: 0 });
    expect(first).toMatchObject({ continued: true });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      if (!("runId" in first)) throw new Error("Expected an import run");
      const run = await ctx.db.get(first.runId);
      expect(run).toMatchObject({ status: "stopped", automatic: true });
      expect(run!.errors.at(-1)).toMatch(/disabled mid-run/);
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "prh"))
        .unique();
      expect(source?.consecutiveFailures ?? 0).toBe(0);
    });
  });

  it("finishes an operator-forced run on a disabled source", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.mutation(internal.importSources.setEnabledInternal, { key: "prh", enabled: false });
    expect(await sync(t)).toEqual({ skipped: "disabled" });
    stubApi([{ isbn: "9781646519828", title: "Included Manga 1", seriesNumber: 1 }]);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "prh" });
    const result = await sync(t, { runId });
    expect(result).toMatchObject({ runId, recordsSeen: 1 });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(runId))?.status).toBe("succeeded");
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

    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

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
    const hardcoverId = await t.run(async (ctx) => {
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
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 1, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "hardcover",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
    });
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

/** An active Series with the given Volumes, as a backbone source leaves it. */
async function insertSeries(t: TestT, title: string, labels: string[]) {
  return await t.run(async (ctx) => {
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title,
      altTitles: [],
      searchText: title,
    });
    for (const label of labels) {
      await ctx.db.insert("volumes", {
        status: "active",
        publicId: Number(label),
        seriesId,
        position: Number(label),
        label,
      });
    }
    return seriesId;
  });
}

// R08: the shared catalog-title queue carries a packaged guess's Edition
// Line, so approving the reviewed proposal files the Edition under it.
describe("prh.sync — queued packaging keeps its Edition Line (B16)", () => {
  it("approving a steady-state omnibus creates its Edition Line and files the Edition under it", async () => {
    const t = makeT();
    rateLimiterTest.register(t, "rateLimiter");
    const admin = t.withIdentity({ subject: "catalogmod_subject" });
    await admin.mutation(api.users.claimUsername, { username: "catalogmod" });
    await t.mutation(internal.roles.bootstrapAdministrator, { username: "catalogmod" });
    await seedRegistry(t, false);
    const seriesId = await insertSeries(t, "Noragami", ["19", "20"]);
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
    await insertSeries(t, "Fire Force", []);
    const box = { isbn: "9798888772584", title: "Fire Force Manga Box Set 1 (Vol. 1-2)", seriesNumber: 1 };
    stubApi([box]);
    await sync(t);
    const members = () =>
      t.run(async (ctx) => {
        const [bundle, ...more] = await ctx.db.query("releaseBundles").collect();
        expect(more).toHaveLength(0);
        const rows = await ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id))
          .collect();
        return await Promise.all(rows.map(async (row) => (await ctx.db.get(row.releaseId))!.isbn13));
      });
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
// never stands in and invents the Volume it skips.
describe("prh.sync — a gapped coverage statement is never widened (R12)", () => {
  /** The Volume labels, and each Edition's covered labels, after a sync. */
  async function placed(t: TestT) {
    return await t.run(async (ctx) => {
      const labels = new Map(
        (await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]),
      );
      const editions = await ctx.db.query("editions").collect();
      return {
        volumes: [...labels.values()].sort(),
        covered: (await ctx.db.query("volumeCoverages").collect()).map((c) => labels.get(c.volumeId)),
        unmapped: editions.map((e) => e.coverageUnmapped ?? false),
        releases: (await ctx.db.query("releases").collect()).length,
      };
    });
  }

  it("a title listing Volumes 1 & 3 never falls back to the 3-in-1 size", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1 (Vol. 1 & 3)" }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  it("a blurb collecting Volumes 1 and 3 never falls back to the 3-in-1 size", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([
      { isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy: "<p>Collects volumes 1 and 3.</p>" },
    ]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  it("a later hint's gapped list blocks the size too, while silence before it does not decide", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 3-in-1 Edition 1",
        flapcopy: "<p>The saga begins in a giant edition.</p>",
        keynote: "<p>Collects <i>Alpha</i> Volumes 1, 3, and a bonus story.</p>",
      },
    ]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // A gapped list with no collect-verb in front of it is still a statement.
  it.each([
    "<p>Volumes 1 and 3 in one book!</p>",
    "<p>This edition brings together volumes 1 and 3.</p>",
    "<p>Collects volumes #1 and #3.</p>",
    "<p>Collects volumes one and three.</p>",
  ])("a bare gapped list (%s) never falls back to the 3-in-1 size", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // A title may repeat the marker or number each listed Volume with "#".
  it.each([
    "Alpha 3-in-1 Edition 1 (Vol. 1 and Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1 & Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Vol. #1 & #3)",
    "Alpha 3-in-1 Edition 1 (Includes Vols. 1 and 3)",
  ])("a title listing Volumes with a gap (%s) never falls back to the 3-in-1 size", async (title) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([{ isbn: "9781646519828", title }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // An unusable bare range earlier in the blurb does not hide the gapped list.
  it("a gapped list after an unusable bare range still blocks the size", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 3-in-1 Edition 1",
        flapcopy: "<p>Volumes 1-80 of the saga are out. Volumes 1 and 3 in one book!</p>",
      },
    ]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // A number that counts something else ("4 bonus stories") is no Volume:
  // the stated range stays 1–3 and no Volume 4 is created.
  it.each([
    "<p>Collects volumes 1–3 and 4 bonus stories.</p>",
    "<p>Collects volumes 1-3 and 16 pages of color art.</p>",
    "<p>Collects volumes 1-3, and 2 new short stories.</p>",
    "<p>Collects volumes 1-3 and volume 4&#8217;s bonus chapter.</p>",
  ])("a counted noun after the list (%s) never widens the stated range", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  it("a counted number word after a Volume is never read as a Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 3-in-1 Edition 1",
        flapcopy: "<p>Includes volume one and two bonus stories.</p>",
      },
    ]);
    await sync(t);
    // Volume 1 alone, or 1–2: neither agrees with the 3-in-1 size (1–3),
    // so the book waits for a Moderator rather than taking either guess.
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // A bare last number after "and" followed by anything but a statement end
  // may count something else, so the blurb reads two ways: with it and
  // without it. The 3-in-1 size (1–3) agrees with exactly one reading, so
  // that one places the book. No Volume 4 is ever invented.
  it.each([
    "<p>Collects volumes 1-3 and 4 all-new bonus stories.</p>",
    "<p>Collects volumes 1-3 plus 4 all-new bonus stories.</p>",
    "<p>Collects volumes 1-3 and 4-page bonus comic.</p>",
    "<p>Collects volumes 1-3 and 4 of the author's short stories.</p>",
    "<p>Collects volumes 1-3 and 4 “bonus” stories.</p>",
    "<p>Collects volumes 1-3 and 4 as-yet-unpublished stories.</p>",
    "<p>Collects volumes 1-3 and 4 for the first time.</p>",
    "<p>Collects volumes 1-3 and 4 on-model sketches.</p>",
    "<p>Collects volumes 1-3 and 4 (four!) bonus stories.</p>",
    "<p>Collects volumes 1-3 and 4.5 bonus pages.</p>",
    "<p>Volumes 1-3 and 4 all-new stories in one book.</p>",
  ])("a count after the list (%s) places the 3-in-1 at 1–3, never 1–4", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  // A range after "and" is a Volume range: 1–6, which the 3-in-1 size
  // contradicts. The book waits for a Moderator; no Volume 4–6 is created.
  it("a range item after the list leaves the 3-in-1 Unmapped", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 3-in-1 Edition 1",
        flapcopy: "<p>Collects volumes 1-3 and 4 to 6 new pages.</p>",
      },
    ]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // The last Volume of a contiguous list is never quietly dropped: a block
  // end closes the list, and a following word leaves two readings, of which
  // the 3-in-1 size agrees with the full one.
  it.each([
    "<ul><li>Collects volumes 1, 2, and 3</li><li>Hardcover</li></ul>",
    "<p>Collects volumes 1, 2, and 3 featuring new cover art.</p>",
    "<p>Collects volumes 1, 2, and 3 remastered.</p>",
  ])("a contiguous list before other copy (%s) places the 3-in-1 at 1–3", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  // A gapped list stays gapped whatever follows it: neither reading ("1 and
  // 3", or "1" alone) agrees with the 3-in-1 size, so nothing is placed.
  it.each([
    "<p>Collects volumes 1 and 3</p><p>Remastered</p>",
    "<p>Collects volumes 1 and 3 remastered.</p>",
    "<p>Collects volumes 1-3 and 4.5.</p>",
  ])("a gapped list before other copy (%s) leaves the 3-in-1 Unmapped", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // A list the reader cannot finish ("volumes 1 as well as 3", "1-2; 4")
  // is never cut short to the part it could read.
  it.each([
    "<p>Collects volumes 1 as well as 3.</p>",
    "<p>Collects volumes 1 along with 3.</p>",
    "<p>Collects volumes 1; 3.</p>",
    "<p>Collects volumes 1/3.</p>",
    "<p>Collects volumes 1-2; 4.</p>",
    "<p>Collects vols. 1and 3.</p>",
    "<p>Volumes 1 as well as 3 in one book!</p>",
    "<p>Collects volume 1 as well as volume 3.</p>",
  ])("an unfinished list (%s) leaves the 3-in-1 Unmapped", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // With no line size to agree with, two readings stay unresolved.
  it.each([
    "<p>Collects volumes 1-3 and 4 all-new bonus stories.</p>",
    "<p>Collects volumes 1 and 2 featuring new cover art.</p>",
    "<p>Collects volumes 1-3 as well as 5.</p>",
  ])("an ambiguous list (%s) leaves a Deluxe book Unmapped", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // The last number of a serial list ("1, 2, and 3") is one of the list.
  it("a serial list before other copy places a Deluxe book at 1–3", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha Deluxe Edition 1",
        flapcopy: "<p>Collects volumes 1, 2, and 3 featuring new cover art.</p>",
      },
    ]);
    await sync(t);
    const result = await placed(t);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  it("the line size at the book's position picks the reading that agrees with it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3", "4"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 2-in-1 Edition 2",
        flapcopy: "<p>Collects volumes 3 and 4 featuring new cover art.</p>",
      },
    ]);
    await sync(t);
    const result = await placed(t);
    expect(result.covered.sort()).toEqual(["3", "4"]);
    expect(result.unmapped).toEqual([false]);
  });

  // The title path: a bracket or subtitle that lists Volumes with a gap, in
  // any of its phrasings, blocks the 3-in-1 size as "(Vol. 1 & 3)" does.
  it.each([
    "Alpha 3-in-1 Edition 1 (Collecting Vols. 1 and 3)",
    "Alpha 3-in-1 Edition 1 (Including Vols. 1 and 3)",
    "Alpha 3-in-1 Edition 1 (Containing Vols. 1 and 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1 + Vol. 3)",
    "Alpha 3-in-1 Edition 1 (Includes Vol. 1 + 3)",
    "Alpha 3-in-1 Edition 1 (Vol. 1, 2, and 4)",
    "Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1 & 3",
  ])("a title stating a gapped list (%s) leaves the 3-in-1 Unmapped", async (title) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "3"]);
    stubApi([{ isbn: "9781646519828", title }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    expect(await placed(t)).toEqual({ volumes: ["1", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  it("a stated range no book can hold blocks the size as well", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      { isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy: "<p>Collects volumes 3-1.</p>" },
    ]);
    await sync(t);
    expect(await placed(t)).toMatchObject({ covered: [], unmapped: [true] });
  });

  it("a stated contiguous list still places the book", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      { isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy: "<p>Collects volumes 1, 2, and 3.</p>" },
    ]);
    await sync(t);
    const result = await placed(t);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  // A later number the list never joined counts something else: the one
  // stated range places a Deluxe book (no declared size) at 1–3.
  it.each([
    "<p>Collects volumes 1–3 (chapters 1–27).</p>",
    "<p>Collects volumes 1-3 (chapters 1-27).</p>",
    "<p>Collects volumes 1-3 of Mob Psycho 100.</p>",
    "<p>Collects volumes 1-3 of Eyeshield 21!</p>",
    "<p>Collects volumes 1-3 of Kaiju No. 8.</p>",
    "<p>Collects volumes 1-3 of 10.</p>",
    "<p>Collects volumes 1-3, chapters 1 to 27.</p>",
    "<p>Collects volumes 1-3, rated 16.</p>",
    "<p>Collects <i>Negima!</i> Volumes 1-3.</p>",
  ])("a stated range before other numbers (%s) places a Deluxe book at 1–3", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  // A list with no collect-verb in front of it names Volumes without saying
  // the book holds them. It never overrides the 3-in-1 size (1–3) and never
  // creates a Volume.
  it.each([
    "<p>The story continues in volumes 4 and 5.</p>",
    "<p>Catch up before volumes 4 and 5, coming soon.</p>",
    "<p>Don't miss volumes 2 and 3!</p>",
    "<p>Volumes 5 and 6 pick up where volume 4 left off.</p>",
    "<p>The story continues in volumes 4–6.</p>",
    "<p>Collects bonus art. The story continues in volumes 4 and 5.</p>",
  ])("a bare narrative list (%s) places the 3-in-1 at 1–3 from its size", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3", "4", "5"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  // With no declared size to agree with, a bare list places nothing.
  it.each([
    "<p>The story continues in volumes 4 and 5.</p>",
    "<p>The story continues in volumes 4–6.</p>",
  ])("a bare narrative list (%s) leaves a Deluxe book Unmapped", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // "/" and ";" join only weakly: "1-3 / 4-6" may name two books. The
  // 3-in-1 size agrees with 1–3 alone; no Volume 4–6 is created.
  it.each(["<p>Collects volumes 1-3 / 4-6.</p>", "<p>Collects volumes 1-3; 4-6.</p>"])(
    "a slash- or semicolon-joined range (%s) places the 3-in-1 at 1–3",
    async (flapcopy) => {
      const t = makeT();
      await seedRegistry(t, true);
      await insertSeries(t, "Alpha", ["1", "2", "3"]);
      stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
      await sync(t);
      const result = await placed(t);
      expect(result.volumes).toEqual(["1", "2", "3"]);
      expect(result.covered.sort()).toEqual(["1", "2", "3"]);
      expect(result.unmapped).toEqual([false]);
    },
  );

  it("a slash-joined range leaves a Deluxe book Unmapped", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy: "<p>Collects volumes 1-3 / 4-6.</p>" }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // "Part N, Vol. M" is Volume M of the Part's Series: no packaging, and no
  // Volume N is created.
  it.each([
    ["Alpha, Part 1, Vol. 2", "Alpha, Part 1", "2"],
    ["Alpha Book 2, Vol. 3", "Alpha Book 2", "3"],
    ["Alpha: Part 5, Vol. 6", "Alpha: Part 5", "6"],
  ])("a title %s is one Volume of its Part, never packaging", async (title, seriesTitle, label) => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s.title)).toEqual([seriesTitle]);
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label)).toEqual([label]);
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(0);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.coverageUnmapped ?? false)).toEqual([false]);
    });
  });

  // A collect-verb collects the phrase an article or preposition opens, not
  // the list inside it ("a preview of volumes 4 and 5", or the next block,
  // which cleanBlurb joins on with a space: "Collects bonus art</p><p>The
  // story continues in volumes 4 and 5"), and a verb in another sentence
  // governs nothing.
  const UNGOVERNED = [
    "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5</p>",
    "<p>Includes a preview of volumes 4 and 5.</p>",
    "<p>Includes a preview of volume 4.</p>",
    "<p>Includes a letter from Oda. Volumes 4 and 5 are out now.</p>",
    "<p>Collects chapters 1-27 and a preview of volumes 4-6.</p>",
  ];

  it.each(UNGOVERNED)("a list the verb does not govern (%s) places the 3-in-1 at 1–3 from its size", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha 3-in-1 Edition 1", flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
    expect(result.unmapped).toEqual([false]);
  });

  it.each(UNGOVERNED)("a list the verb does not govern (%s) leaves a Deluxe book Unmapped", async (flapcopy) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // Any other words between verb and list leave the verb governing it. The
  // size never overrides the statement: one it contradicts leaves the book
  // Unmapped rather than letting either win.
  it.each([
    ["Alpha 3-in-1 Edition 1", "<p>Collects the hit series volumes 1-3.</p>", ["1", "2", "3"]],
    ["Alpha 3-in-1 Edition 2", "<p>Collects the hit series volumes 1-3.</p>", []],
    ["Alpha 3-in-1 Edition 1", "<p>Collects both volumes 1 and 2.</p>", []],
    ["Alpha Deluxe Edition 1", "<p>Collects the hit series volumes 1-3.</p>", ["1", "2", "3"]],
    ["Alpha Deluxe Edition 1", "<p>Collects Attack on Titan volumes 1-3.</p>", ["1", "2", "3"]],
    // A block boundary cleanBlurb spaced over leaves the verb governing the
    // next block's list: the 3-in-1 size (1–3) contradicts 4–6.
    ["Alpha 3-in-1 Edition 1", "<h3>Collects the hit series</h3><p>Volumes 4-6 on sale now.</p>", []],
  ])("%s with %s covers %j", async (title, flapcopy, covered) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title, flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(covered);
    expect(result.unmapped).toEqual([covered.length === 0]);
  });

  // The first statement the verb governs decides; a bare mention before it
  // is silence, a gap before it blocks.
  it("a narrative flap copy leaves the keynote to place a Deluxe book", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha Deluxe Edition 1",
        flapcopy: "<p>The story continues in volumes 4 and 5.</p>",
        keynote: "<p>Collects volumes 1-3.</p>",
      },
    ]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(["1", "2", "3"]);
  });

  it("a gapped flap copy blocks a later keynote's range", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([
      {
        isbn: "9781646519828",
        title: "Alpha 3-in-1 Edition 1",
        flapcopy: "<p>Volumes 1 and 3 in one book!</p>",
        keynote: "<p>Collects volumes 1-3.</p>",
      },
    ]);
    await sync(t);
    expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
  });

  // The title's own statement outranks every blurb, a range or a gap.
  it.each([
    ["Alpha Omnibus 1 (Vol. 1-3)", "<p>Collects volumes 1 and 3.</p>", ["1", "2", "3"]],
    ["Alpha Omnibus 1 (Vol. 1 & 3)", "<p>Collects volumes 1-3.</p>", []],
  ])("the title %s decides over the blurb %s", async (title, flapcopy, covered) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title, flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3"]);
    expect(result.covered.sort()).toEqual(covered);
    expect(result.unmapped).toEqual([covered.length === 0]);
  });

  it.each([
    ["Alpha 3-in-1 Edition 2", "<p>Catch up with volumes 1-3 first!</p>", ["4", "5", "6"]],
    ["Alpha VIZBIG Edition 1", "<p>Contains volumes 1, 2 and 3 of Alpha!</p>", ["1", "2", "3"]],
  ])("%s with %s is placed by its size", async (title, flapcopy, covered) => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3", "4", "5", "6"]);
    stubApi([{ isbn: "9781646519828", title, flapcopy }]);
    await sync(t);
    const result = await placed(t);
    expect(result.volumes).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(result.covered.sort()).toEqual(covered);
    expect(result.unmapped).toEqual([false]);
  });

  it.each(["<p>Collects volumes 1-3 and 4 bonus stories.</p>", "<p>Collects volumes one and three.</p>"])(
    "a Deluxe book with %s stays Unmapped",
    async (flapcopy) => {
      const t = makeT();
      await seedRegistry(t, true);
      await insertSeries(t, "Alpha", ["1", "2", "3"]);
      stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy }]);
      await sync(t);
      expect(await placed(t)).toEqual({ volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 });
    },
  );

  it("a minus-sign range places a Deluxe book", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title: "Alpha Deluxe Edition 1", flapcopy: "<p>Collects volumes 1−3.</p>" }]);
    await sync(t);
    expect((await placed(t)).covered.sort()).toEqual(["1", "2", "3"]);
  });

  // Re-syncing a placed book with each kind of blurb never invents a Volume
  // or drops a covered one.
  it("re-applying a placed Deluxe book's changing blurb keeps its Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
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
    expect((await placed(t)).covered.sort()).toEqual(["1", "2", "3"]);
  });

  /** Syncs one PRH title over a Series holding Volumes 1–3. */
  async function syncOne(title: string, flapcopy: string) {
    const t = makeT();
    await seedRegistry(t, true);
    await insertSeries(t, "Alpha", ["1", "2", "3"]);
    stubApi([{ isbn: "9781646519828", title, flapcopy }]);
    await sync(t);
    return await placed(t);
  }
  const PLACED_1_3 = { volumes: ["1", "2", "3"], covered: ["1", "2", "3"], unmapped: [false], releases: 1 };
  const UNMAPPED = { volumes: ["1", "2", "3"], covered: [], unmapped: [true], releases: 1 };
  const sorted = (result: Awaited<ReturnType<typeof placed>>) => ({ ...result, covered: result.covered.sort() });

  // The collect-verb nearest the list governs it: an earlier verb in the
  // same sentence never turns the words between into a lead-in.
  it.each([
    "<p>This collected edition includes volumes 1-3.</p>",
    "<p>Includes a new afterword and collects volumes 1-3.</p>",
    "<p>Includes all-new bonus material and collects volumes 1-3 of the original series.</p>",
    "<p>Collecting the acclaimed manga, this omnibus contains volumes 1-3.</p>",
  ])("the verb nearest the list (%s) places a Deluxe book at 1–3", async (flapcopy) => {
    expect(sorted(await syncOne("Alpha Deluxe Edition 1", flapcopy))).toEqual(PLACED_1_3);
  });

  // A capital "Volumes" is no sign of a mention. The governed 1–3
  // contradicts the size at position 2 (4–6), so neither wins.
  it("a governed capital-Volumes statement that contradicts the 3-in-1 size leaves it Unmapped", async () => {
    const flapcopy = "<p>This collected edition contains Volumes 1–3 of the series.</p>";
    expect(await syncOne("Alpha 3-in-1 Edition 2", flapcopy)).toEqual(UNMAPPED);
  });

  // A dash range is never ambiguous by what follows it.
  it.each(["<p>Collects volumes 1-3 plus 16 pages of color art.</p>", "<p>Collects volumes 1-3 of Alpha!</p>"])(
    "a dash range (%s) places a Deluxe book at 1–3",
    async (flapcopy) => {
      expect(sorted(await syncOne("Alpha Deluxe Edition 1", flapcopy))).toEqual(PLACED_1_3);
    },
  );

  // A bare last item that agrees with no size is unplaceable: never the
  // shortened 1–3, never the size's 4–6.
  it("an ambiguous last item agreeing with no size leaves the 3-in-1 Unmapped", async () => {
    const flapcopy = "<p>Collects volumes 1-3 and 4 bonus stories.</p>";
    expect(await syncOne("Alpha 3-in-1 Edition 2", flapcopy)).toEqual(UNMAPPED);
  });

  // A sentence-initial list with no verb governs on a line with no size.
  it.each(["<p>Volumes 1–3 of the acclaimed series, in hardcover.</p>", "<p>Volumes 1, 2, and 3 together at last.</p>"])(
    "a sentence-initial list (%s) places a Deluxe book at 1–3",
    async (flapcopy) => {
      expect(sorted(await syncOne("Alpha Deluxe Edition 1", flapcopy))).toEqual(PLACED_1_3);
    },
  );

  // "1-2-3" runs on past what was read: no shortened 1–2, no size.
  it.each(["Alpha Deluxe Edition 1", "Alpha 3-in-1 Edition 1"])(
    "a run-on range leaves %s Unmapped",
    async (title) => {
      expect(await syncOne(title, "<p>Collects volumes 1-2-3.</p>")).toEqual(UNMAPPED);
    },
  );

  /** Syncs one PRH title into an empty catalog: every Volume after it is one the import created. */
  async function syncFresh(title: string, flapcopy?: string) {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title, flapcopy }]);
    await sync(t);
    const { volumes, covered, unmapped } = await placed(t);
    return { volumes, covered: covered.sort(), unmapped };
  }
  const FRESH_UNMAPPED = { volumes: [], covered: [], unmapped: [true] };
  const onlyCovering = (labels: string[]) => ({ volumes: labels, covered: labels, unmapped: [false] });

  // W02: a title statement reads its Volume designation only. "16 pages of
  // art" is prose: no Volumes 2–16, and the 3-in-1 size never widens it.
  it.each([
    "Alpha Deluxe Edition 1 (Collecting Vol. 1 plus 16 pages of art)",
    "Alpha 3-in-1 Edition 1 (Collecting Vol. 1 plus 16 pages of art)",
  ])("a page count in a title statement (%s) creates Volume 1 alone", async (title) => {
    expect(await syncFresh(title)).toEqual(onlyCovering(["1"]));
  });

  // W02: a bare last number with copy after it may count the copy, and a
  // title has no size to settle it.
  it("a title statement whose last number may count its copy leaves the book Unmapped", async () => {
    expect(await syncFresh("Alpha Deluxe Edition 1 (Collecting Vol. 1 and 2 bonus stories)")).toEqual(
      FRESH_UNMAPPED,
    );
  });

  // W02: a marked Volume joined by "plus" is read, never dropped as prose:
  // the title covers both Volumes; a gap after the join blocks.
  it.each([
    ["Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vol. 2)", onlyCovering(["1", "2"])],
    ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vols. 4-6)", onlyCovering(["1", "2", "3", "4", "5", "6"])],
    ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 5)", FRESH_UNMAPPED],
  ])("a title statement joining a marked Volume (%s) is read whole", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // W03: "volume 4" carries its own marker, so it is a fourth Volume, never
  // a count the 3-in-1 size may drop.
  it.each([
    ["Alpha 3-in-1 Edition 1", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition 1", onlyCovering(["1", "2", "3", "4"])],
  ])("a marked last Volume places %s by all four Volumes or not at all", async (title, expected) => {
    expect(await syncFresh(title, "<p>Collects volumes 1-3 and volume 4 in one book.</p>")).toEqual(expected);
  });

  // W04: a range joined by "plus" is read before the copy after it: a gap
  // blocks on every line, a contiguous range widens the statement.
  it.each([
    ["Alpha Deluxe Edition 1", "<p>Collects volumes 1-3 plus 5-6 in one book.</p>", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1", "<p>Collects volumes 1-3 plus 5-6 in one book.</p>", FRESH_UNMAPPED],
    [
      "Alpha Deluxe Edition 1",
      "<p>Collects volumes 1-3 plus 4-6 in one book.</p>",
      onlyCovering(["1", "2", "3", "4", "5", "6"]),
    ],
  ])("a joined range places %s by the whole list (%s)", async (title, flapcopy, expected) => {
    expect(await syncFresh(title, flapcopy)).toEqual(expected);
  });

  // N01: a title statement reads its list as a blurb does. Every item after
  // a joined range is read and beats the size; a gap or a possessive blocks.
  const ONE_TO_NINE = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  it.each([
    ["Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 4-6 and 7-9 in one book)", onlyCovering(ONE_TO_NINE)],
    ["Alpha 3-in-1 Edition 1 (Collecting Vols. 1-3 plus 4-6 and 7-9 in one book)", onlyCovering(ONE_TO_NINE)],
    ["Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 4-6 and 8-9 in one book)", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1 (Collecting Vols. 1-3 plus 4-6 and 8-9 in one book)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 4)", onlyCovering(["1", "2", "3", "4"])],
  ])("a title statement continuing past a joined range (%s) is read whole or not at all", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // N02: an uppercase possessive still reads two ways: the 3-in-1 size
  // settles it to 1–3, and a Deluxe with no size stays Unmapped.
  it.each([
    ["Alpha Deluxe Edition 1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4'S BONUS CHAPTER.</p>", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition 1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4’S BONUS CHAPTER.</p>", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4'S BONUS CHAPTER.</p>", onlyCovering(["1", "2", "3"])],
    ["Alpha 3-in-1 Edition 1", "<p>COLLECTS VOLUMES 1-3 AND VOLUME 4’S BONUS CHAPTER.</p>", onlyCovering(["1", "2", "3"])],
  ])("an uppercase possessive places %s by the size or not at all (%s)", async (title, flapcopy, expected) => {
    expect(await syncFresh(title, flapcopy)).toEqual(expected);
  });

  // N04: a range outside the brackets never stands in for a bracket
  // statement no range holds, and two ranges that disagree place nothing:
  // no Volume 4–9 is invented. Only an agreeing pair maps the book.
  it.each([
    ["Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3)", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 7-9 in one book)", onlyCovering(ONE_TO_NINE)],
    ["Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1 and 3)", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-6)", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition Vol. 1-3 (Collects Vols. 1-3)", onlyCovering(["1", "2", "3"])],
    // The reverse: a gapped designation outside, a range in the bracket.
    ["Alpha Deluxe Edition Vol. 1 & 3 (Collects Vols. 1-3)", FRESH_UNMAPPED],
  ])("a title stating its coverage twice (%s) maps only when both agree", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // N04: with no Edition Line to wait under, a bare range whose bracket
  // disagrees places nothing at all; the observation waits for an Editor.
  it.each([
    "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)",
    "Alpha, Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)",
  ])("a bare range beside a rejected bracket statement (%s) creates no Volume", async (title) => {
    expect(await syncFresh(title)).toEqual({ volumes: [], covered: [], unmapped: [] });
  });

  // N04: the rejected title is evidence, so a readable blurb never stands in.
  it("a blurb never stands in for a title statement the outer range contradicts", async () => {
    const title = "Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)";
    expect(await syncFresh(title, "<p>Collects volumes 1-9.</p>")).toEqual(FRESH_UNMAPPED);
  });

  // N04 siblings: a list after the packaging phrase meets the marker's
  // designation in `agreed`, so the 3-in-1 size never places a gapped book.
  // A lone number after the phrase is a line position and still maps.
  it.each([
    ["Alpha 3-in-1 Edition 1 & 3, Vol. 1", FRESH_UNMAPPED],
    ["Alpha Omnibus 1-3 Vol. 4-6", FRESH_UNMAPPED],
    ["Alpha Omnibus 1-3 Vol. 1-3", onlyCovering(["1", "2", "3"])],
    ["Alpha Omnibus 2 (Vol. 4-6)", onlyCovering(["4", "5", "6"])],
    ["Alpha Omnibus 2 Vol. 4-6", onlyCovering(["4", "5", "6"])],
  ])("a list before a marker (%s) maps only when both agree", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // N04 siblings: a line-less book's subtitle statement meets its range in
  // `agreed`; a disagreeing one places nothing.
  it.each([
    ["Alpha, Vol. 1-3: Includes Vols. 1 & 3", { volumes: [], covered: [], unmapped: [] }],
    ["Alpha, Vol. 1-3: Includes Vols. 1-6", { volumes: [], covered: [], unmapped: [] }],
    ["Alpha, Vol. 1-3: Includes Vols. 1-3", onlyCovering(["1", "2", "3"])],
  ])("a line-less subtitle statement (%s) maps only when it agrees", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // N04 follow-up: a packaging bracket's own Volume list, a subtitle
  // statement after a phrase's own number or list, and a subtitle that is
  // only a list are statements too. A Volume list or a phrase's list the
  // grammar cannot read (left in the Series title or a subtitle) stands
  // against the rest. A gapped or disagreeing one places nothing, and the
  // line size never stands in for it.
  it.each([
    ["Alpha (3-in-1 Edition 1 & 3), Vol. 1", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1 (Omnibus Vol. 1 & 3)", FRESH_UNMAPPED],
    ["Alpha (Omnibus 1-3) Vol. 4-6", FRESH_UNMAPPED],
    ["Alpha (Omnibus Vol. 1-3) Vol. 2", onlyCovering(["1", "2", "3"])],
    ["Alpha Vol. 1 & 3 3-in-1 Edition 1", FRESH_UNMAPPED],
    ["Alpha Vol. 4-6 Omnibus 1-3", FRESH_UNMAPPED],
    ["Alpha Omnibus 1 & 3 Deluxe Edition 2 Vol. 4-6", FRESH_UNMAPPED],
    ["Alpha Deluxe Edition 1-3: Includes Vols. 4-6", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1 & 3: Includes Vols. 1-3", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition 1: Includes Vols. 1-3", onlyCovering(["1", "2", "3"])],
    ["Alpha 3-in-1 Edition, Vol. 1: Vols. 1 & 3", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition, Vol. 1: Volumes 1 & 3", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition, Vol. 1: Vols. 1-3", onlyCovering(["1", "2", "3"])],
    // A phrase's list in a marker's subtitle, or before a later phrase.
    ["Alpha Vol. 1-3 Omnibus 1 & 3 Deluxe Edition 1", FRESH_UNMAPPED],
    ["Alpha Omnibus 1 & 3 Vol. 1-3 Deluxe Edition 1", FRESH_UNMAPPED],
    ["Alpha Vol. 4-6 Omnibus 1-3 Deluxe Edition 2", FRESH_UNMAPPED],
    ["Alpha, Vol. 1-3 Omnibus 1 & 3: Cloud Dragon", { volumes: [], covered: [], unmapped: [] }],
    ["Alpha Vol. 1-3 Omnibus 4-6 Hardcover", { volumes: [], covered: [], unmapped: [] }],
    // A dash chain where the title read no list before: no Volumes 2–6 or 4–8.
    ["Alpha Omnibus, Vol. 2: Vol. 2 - 4-6", FRESH_UNMAPPED],
    ["Alpha (Omnibus) Vol. 2: Vols. 4-6-8", FRESH_UNMAPPED],
    ["Alpha 3-in-1 Edition, Vol. 1: Vols. 1-2-5", FRESH_UNMAPPED],
    ["Alpha (Omnibus Vol. 4-6-8)", FRESH_UNMAPPED],
  ])("a statement or an unread list in the title (%s) maps only when all agree", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // N04 follow-up: an unmarked list, a Part or Book list, and a phrase's
  // range beside a lone number belong to the name or the position, never
  // to the coverage: the book places as it always did.
  it.each([
    ["Persona 3 & 4 Omnibus 1", FRESH_UNMAPPED],
    ["Persona 3 & 4 3-in-1 Edition 1", onlyCovering(["1", "2", "3"])],
    ["Alpha Book 1-2 Omnibus 1", FRESH_UNMAPPED],
    ["Alpha Part 1-2 Omnibus 1 (Vol. 1-3)", onlyCovering(["1", "2", "3"])],
    ["Alpha Part 1-2, Vol. 1-3", onlyCovering(["1", "2", "3"])],
    ["Alpha 1, 2 & 3 Omnibus 2", FRESH_UNMAPPED],
    ["Alpha Omnibus 1-3 Vol. 2", FRESH_UNMAPPED],
    // An earlier marker designates the book; the trailing statement is its subtitle.
    ["Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3", onlyCovering(["2"])],
    ["Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1 & 3", onlyCovering(["2"])],
    ["Alpha, Vol. 2: Omnibus 1 - Includes Vols. 4-6", onlyCovering(["2"])],
    ["Alpha Part 2: Omnibus 1: Includes Vols. 1-3", onlyCovering(["2"])],
    ["Alpha Vol. 3: Box Set 1: Includes Vols. 1-3", onlyCovering(["3"])],
    ["Alpha Omnibus Omnibus Vol. 1-3: Includes Vols. 1-3", onlyCovering(["1", "2", "3"])],
    ["Alpha Box Set Omnibus Vol. 1-3: Includes Vols. 1-3", onlyCovering(["1", "2", "3"])],
  ])("a list that is no statement (%s) places the book as before", async (title, expected) => {
    expect(await syncFresh(title)).toEqual(expected);
  });

  // A trailing statement split off only where the marker grammar would read
  // it: an earlier marker keeps the Series the title always named.
  it.each([
    ["Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3", "Alpha"],
    ["Alpha: Part 4 - Diamond Deluxe Edition 1: Includes Vols. 1-3", "Alpha"],
    ["Alpha Omnibus Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha Omnibus"],
    ["Alpha 3-in-1 Edition Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha 3-in-1 Edition"],
    ["Alpha Box Set Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha Box Set"],
  ])("a trailing statement after an earlier marker (%s) keeps Series %s", async (title, seriesTitle) => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([{ isbn: "9781646519828", title }]);
    await sync(t);
    const series = await t.run(async (ctx) => (await ctx.db.query("series").collect()).map((s) => s.title));
    expect(series).toEqual([seriesTitle]);
  });

  // N04 follow-up: a box whose subtitle lists other Volumes links no
  // members; one whose title agrees links them.
  it.each([
    ["Alpha Vol. 4-6 Omnibus 1-3 Box Set", 0],
    ["Alpha Vol. 4-6 Box Set", 3],
  ])("a box set (%s) links only the members its title agrees on", async (title, members) => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781646519040", title: "Alpha 4", seriesNumber: 4 },
      { isbn: "9781646519057", title: "Alpha 5", seriesNumber: 5 },
      { isbn: "9781646519064", title: "Alpha 6", seriesNumber: 6 },
      { isbn: "9798888772607", title },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releaseBundles").collect()).toHaveLength(1);
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(members);
    });
  });

  // A Series name's thousands-separated number is no list left unread.
  const SAVING = "Saving 80,000 Gold in Another World for My Retirement";
  it.each([
    [`${SAVING} Omnibus 1 (Vol. 1-3)`, undefined, onlyCovering(["1", "2", "3"])],
    [`${SAVING}, Vol. 1-3`, undefined, onlyCovering(["1", "2", "3"])],
    [`${SAVING} 3-in-1 Edition 1`, undefined, onlyCovering(["1", "2", "3"])],
    [`${SAVING} Deluxe Edition 1`, "<p>Collects volumes 1-3.</p>", onlyCovering(["1", "2", "3"])],
    ["I'm Standing on 1,000,000 Lives Omnibus 1 (Vol. 1-2)", undefined, onlyCovering(["1", "2"])],
  ])("a thousands-separated number in the Series name (%s) still maps", async (title, flapcopy, expected) => {
    expect(await syncFresh(title, flapcopy)).toEqual(expected);
  });

  // W05: "Negima!" is the Series' name, not a sentence end. The verb governs
  // 37–38, which the 3-in-1 size at position 13 (37–39) contradicts: no
  // Volume 39 is invented. With no size the statement places the book.
  it.each([
    ["Negima! 3-in-1 Edition Vol. 13", FRESH_UNMAPPED],
    ["Negima! Deluxe Edition 1", onlyCovering(["37", "38"])],
  ])("a Series title's own '!' before its Volumes places %s by the statement", async (title, expected) => {
    expect(await syncFresh(title, "<p>Collects Negima! Volumes 37-38.</p>")).toEqual(expected);
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
  /** The one bundle's member ISBNs in page order, and the bundle itself. */
  const bundleState = (t: TestT) =>
    t.run(async (ctx) => {
      const [bundle, ...more] = await ctx.db.query("releaseBundles").collect();
      expect(more).toHaveLength(0);
      const rows = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id))
        .collect();
      const releases = await Promise.all(rows.map((row) => ctx.db.get(row.releaseId)));
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
        members: releases.map((r) => `${r!.isbn13}:${r!.format}`),
        orders: rows.map((row) => row.order),
        revisions: revisions.length,
        conflicts: observation!.conflicts?.map((c) => c.field) ?? [],
      };
    });

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
