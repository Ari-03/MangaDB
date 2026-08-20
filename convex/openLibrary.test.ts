// OpenLibrary adapter tests (ticket #36): the dump pass run against a
// stubbed filtered-dump URL — no network. Covers the acceptance criterion:
// OpenLibrary records fill ISBNs/fields on matches but never create Series
// structure — plus the leaf-Release boundary (how VIZ releases materialize
// under the ANN backbone), weak-date handling, and chained streaming.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

function dumpLine(edition: Record<string, unknown>): string {
  return `/type/edition\t${edition.key}\t1\t2026-08-01T00:00:00\t${JSON.stringify(edition)}`;
}

function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions.map(dumpLine).join("\n") + "\n";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    if (url === DUMP_URL) {
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  vi.stubEnv("OPENLIBRARY_DUMP_URL", DUMP_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeT() {
  return convexTest(schema);
}
type TestT = ReturnType<typeof makeT>;

async function seedRegistry(t: TestT) {
  await t.mutation(internal.importSources.seedRegistry, {});
}

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.openLibrary.sync, { ...args });

/** The ANN-built skeleton + a VIZ publisher row: series, volumes 1-2, and
 * (optionally) an existing ISBN-less release covering volume 1. */
async function buildSkeleton(t: TestT, opts: { withRelease: boolean }) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "VIZ Media",
      slug: "viz-media",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Chainsaw Man",
      altTitles: [],
      searchText: "Chainsaw Man",
    });
    const volumeIds: Id<"volumes">[] = [];
    for (const label of ["21", "22"]) {
      volumeIds.push(
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: Number(label),
          seriesId,
          position: Number(label),
          label,
        }),
      );
    }
    let releaseId: Id<"releases"> | null = null;
    if (opts.withRelease) {
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId: volumeIds[1]!,
        order: 1,
        extent: "complete",
      });
      releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
    }
    return { publisherId, seriesId, volumeIds, releaseId };
  });
}

const CHAINSAW_22 = {
  key: "/books/OL51694024M",
  title: "Chainsaw Man, Vol. 22",
  publishers: ["VIZ Media LLC"],
  publish_date: "Oct 13, 2026",
  isbn_13: ["9781974766512"],
  physical_format: "paperback",
  languages: [{ key: "/languages/eng" }],
};

describe("openLibrary.sync — configuration", () => {
  it("skips as unconfigured without a dump URL", async () => {
    vi.stubEnv("OPENLIBRARY_DUMP_URL", "");
    const t = makeT();
    await seedRegistry(t);
    stubDump([]);
    expect(await sync(t)).toEqual({ skipped: "unconfigured" });
  });
});

describe("openLibrary.sync — ISBN fill, never structure", () => {
  it("fills ISBN and empty date on a full-key match into the skeleton", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    stubDump([CHAINSAW_22]);

    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 1, recordsChanged: 1 });

    await t.run(async (ctx) => {
      const release = (await ctx.db.get(releaseId!))!;
      expect(release.isbn13).toBe("9781974766512"); // the fill
      expect(release.pubDate).toEqual({
        year: 2026,
        month: 10,
        day: 13,
        sort: 20261013,
      });
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.recordRef).toEqual({ type: "release", id: releaseId });
      // Revisions cite OpenLibrary.
      const revisions = await ctx.db.query("revisions").collect();
      expect(revisions.at(-1)!.citation).toMatchObject({
        url: "https://openlibrary.org/books/OL51694024M",
      });
    });
  });

  it("a weak date never displaces a standard-authority one — recorded on the observation only", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    // ANN (standard) already set the date.
    await t.run(async (ctx) => {
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "ann" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: releaseId! } as never,
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "ann" },
        changes: [
          {
            field: "pubDate",
            after: { year: 2026, month: 10, day: 6, sort: 20261006 },
          },
        ],
        comment: "Imported from the Anime News Network Encyclopedia.",
      });
      await ctx.db.patch(releaseId!, {
        pubDate: { year: 2026, month: 10, day: 6, sort: 20261006 },
      });
    });
    stubDump([CHAINSAW_22]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(releaseId!))!;
      expect(release.pubDate!.sort).toBe(20261006); // untouched
      expect(release.isbn13).toBe("9781974766512"); // the fill still applies
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.conflicts![0]!).toMatchObject({ field: "pubDate" });
      expect(obs.conflicts![0]!.reason).toContain("lower authority");
    });
  });

  it("creates a leaf Release under fully pre-existing structure — and nothing else, ever", async () => {
    const t = makeT();
    await seedRegistry(t);
    // Skeleton without any release: series, volumes, publisher exist.
    const { seriesId } = await buildSkeleton(t, { withRelease: false });
    stubDump([
      CHAINSAW_22,
      {
        // No matching Series anywhere: must create NOTHING.
        key: "/books/OL999M",
        title: "Some Unknown Manga, Vol. 1",
        publishers: ["VIZ Media LLC"],
        isbn_13: ["9781974700011"],
        languages: [{ key: "/languages/eng" }],
      },
      {
        // Matching series but no volume 30: must create NOTHING.
        key: "/books/OL998M",
        title: "Chainsaw Man, Vol. 30",
        publishers: ["VIZ Media LLC"],
        isbn_13: ["9781974700028"],
        languages: [{ key: "/languages/eng" }],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      // Exactly one leaf Release for vol 22 under the existing structure.
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(1);
      expect(releases[0]!).toMatchObject({
        isbn13: "9781974766512",
        format: "physical",
        binding: "paperback",
      });
      expect(releases[0]!.seriesIds).toEqual([seriesId]);
      // Never Series structure, never publishers.
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("volumes").collect()).toHaveLength(2);
      expect(await ctx.db.query("publishers").collect()).toHaveLength(1);
      // The unmatched records are retained on their observations only, and
      // no review proposals were queued (OpenLibrary never queues).
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations).toHaveLength(3);
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals.every((p) => p.state === "approved")).toBe(true);
    });
  });

  it("streams in chained links across the action budget", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: true });
    stubDump([
      { key: "/books/OL1M", title: "Nothing Interesting 1" },
      { key: "/books/OL2M", title: "Nothing Interesting 2" },
      CHAINSAW_22,
    ]);
    const first = await sync(t, { maxLines: 2 });
    expect(first).toMatchObject({ continued: true, nextLine: 2 });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]!).toMatchObject({ status: "succeeded", recordsSeen: 3 });
      const releases = await ctx.db.query("releases").collect();
      expect(releases[0]!.isbn13).toBe("9781974766512");
    });
  });
});
