// OpenLibrary adapter tests (ticket #36): the dump pass run against a
// stubbed filtered-dump URL — no network. Covers the acceptance criterion:
// OpenLibrary records fill ISBNs/fields on matches but never create Series
// structure — plus the leaf-Release boundary (how VIZ releases materialize
// under the ANN backbone), weak-date handling, and chained streaming.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import { drain, expectStampedAtHandOff, makeT, seedRegistry, tickingClock, type TestT } from "./test.helpers";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

function dumpLine(edition: Record<string, unknown>): string {
  return `/type/edition\t${edition.key}\t1\t2026-08-01T00:00:00\t${JSON.stringify(edition)}`;
}

function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions.map(dumpLine).join("\n") + "\n";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (url === DUMP_URL) {
      return new Response(body, {
        headers: { "content-type": "text/plain" },
      });
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

const sync = (t: TestT, args: object = {}) => t.action(internal.openLibrary.sync, { ...args });

/** The ANN-built skeleton + a VIZ publisher row: series, volumes 1-2, and
 * (optionally) an existing ISBN-less release covering volume 1. */
async function buildSkeleton(t: TestT, opts: { withRelease: boolean }) {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Chainsaw Man" });
    const volumeIds: Id<"volumes">[] = [];
    for (const label of ["21", "22"]) {
      volumeIds.push(await insertVolume(ctx, { publicId: Number(label), seriesId, position: Number(label) }));
    }
    let releaseId: Id<"releases"> | null = null;
    if (opts.withRelease) {
      const editionId = await insertEdition(ctx, { publicId: 1, publisherId });
      await insertCoverage(ctx, { editionId, volumeId: volumeIds[1]! });
      releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] });
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
  it.each([0, -1, 1.5, 20001])(
    "rejects unsafe line limit %s before starting a run",
    async (maxLines) => {
      const t = makeT();
      await seedRegistry(t);
      await expect(sync(t, { maxLines })).rejects.toThrow("maxLines must be an integer");
      await t.run(async (ctx) => {
        expect(await ctx.db.query("importRuns").collect()).toHaveLength(0);
      });
    },
  );

  it("records malformed lines as a failed run while processing valid records", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    vi.stubGlobal("fetch", async () => new Response(`not a dump\n${dumpLine(CHAINSAW_22)}\n`));
    expect(await sync(t)).toMatchObject({
      recordsSeen: 1,
      recordsChanged: 1,
      failed: true,
      errorCount: 1,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))?.isbn13).toBe("9781974766512");
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run?.status).toBe("failed");
      // 0-based, matching the startLine an operator would resume from.
      expect(run?.errors?.[0]).toContain("dump line 0");
    });
  });

  it("skips a title-less edition line without failing the run", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: true });
    const { title: _title, ...untitled } = CHAINSAW_22;
    stubDump([untitled, CHAINSAW_22]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, errorCount: 0 });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run?.status).toBe("succeeded");
    });
  });

  it("skips as unconfigured without a dump URL", async () => {
    vi.stubEnv("OPENLIBRARY_DUMP_URL", "");
    const t = makeT();
    await seedRegistry(t);
    stubDump([]);
    expect(await sync(t)).toEqual({ skipped: "unconfigured" });
  });
});

describe("openLibrary.sync — disabling the source mid-run", () => {
  // The gate is checked before every 1,000th line, the dump's unterminated
  // last line included.
  it.each([
    ["ends with a newline", "\n"],
    ["ends without a newline", ""],
  ])("stops before line 1,000 when the dump %s", async (_, end) => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    // 1,000 lines with no title (each processed, none seen), then a record.
    const { title: _title, ...untitled } = CHAINSAW_22;
    const body = [...Array.from({ length: 1000 }, () => dumpLine(untitled)), dumpLine(CHAINSAW_22)].join("\n") + end;
    vi.stubGlobal("fetch", async () => {
      await t.mutation(internal.importSources.setEnabledInternal, { key: "openlibrary", enabled: false });
      return new Response(body);
    });
    expect(await sync(t)).toMatchObject({ stopped: true, recordsSeen: 0, nextLine: 1000 });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", automatic: true });
      expect((await ctx.db.get(releaseId!))?.isbn13).toBeUndefined();
    });
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

  // B20: an unmarked trailing number ("Chainsaw Man 22") is a provisional
  // split — an existing base Series claims it as that Volume.
  it("fills an ISBN-less Release from a bare trailing volume number the existing Series claims", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    stubDump([{ ...CHAINSAW_22, title: "Chainsaw Man 22" }]);
    expect(await sync(t)).toMatchObject({ recordsSeen: 1, recordsChanged: 1 });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))!.isbn13).toBe("9781974766512");
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.recordRef).toEqual({ type: "release", id: releaseId });
    });
  });

  it("keeps a trailing number that is part of an existing Series' name", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: false });
    // "Chainsaw Man 21" is its own Series here (no Volume split), so the
    // bare split onto "Chainsaw Man" Vol. 21 must never happen.
    await t.run((ctx) => insertSeries(ctx, { publicId: 2, title: "Chainsaw Man 21" }));
    stubDump([{ ...CHAINSAW_22, title: "Chainsaw Man 21", isbn_13: ["9781974700035"] }]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
    });
  });

  it("offers a bare split only to an existing Series, never as new structure", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: false });
    stubDump([{ ...CHAINSAW_22, title: "Omega Nobody 6", isbn_13: ["9781974700042"] }]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
    });
  });

  it("a weak date never displaces a standard-authority one — recorded on the observation only", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    // ANN (standard) already set the date.
    await t.run(async (ctx) => {
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId! },
        sourceKey: "ann",
        changes: [{ field: "pubDate", after: { year: 2026, month: 10, day: 6, sort: 20261006 } }],
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

  it("fills a blank description from the edition's blurb, never over a publisher's", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    const blurb = { type: "/type/text", value: "Denji&#39;s <b>back</b>." };
    stubDump([{ ...CHAINSAW_22, description: blurb }]);
    await sync(t);
    const description = async () =>
      await t.run(async (ctx) => (await ctx.db.get(releaseId!))!.description);
    expect(await description()).toBe("Denji's back.");

    // A publisher feed (authoritative) replaced it; OL's rewrite stays on
    // its observation.
    await t.run(async (ctx) => {
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId! },
        sourceKey: "sevenseas",
        seq: 10,
        changes: [{ field: "description", after: "The publisher's copy." }],
      });
      await ctx.db.patch(releaseId!, { description: "The publisher's copy." });
    });
    stubDump([{ ...CHAINSAW_22, description: "A rewritten OL blurb." }]);
    await sync(t);
    expect(await description()).toBe("The publisher's copy.");
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.conflicts?.find((c) => c.field === "description")).toMatchObject({
        offered: "A rewritten OL blurb.",
        reason: expect.stringContaining("lower authority"),
      });
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

  it("creates nothing for an ISBN Yen Press holds out of scope", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: false });
    // Yen Press recorded this ISBN as a light novel (its own category).
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "yenpress",
        sourceRecordId: "9781974766512",
        snapshot: { outOfScope: "category light-novels" },
        lastSeenAt: 1,
      }),
    );
    stubDump([CHAINSAW_22]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
    });
  });

  it("resolves any listed publisher, reads a volume split into the subtitle, and skips rebinders", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: false });
    stubDump([
      {
        // Imprint label first, the resolvable company second; the volume
        // only in the subtitle ("Chainsaw" + "Man, Vol. 21" is contrived,
        // the live shape is "Mashle" + "Magic and Muscles, Vol. 3").
        key: "/books/OL1M",
        title: "Chainsaw",
        subtitle: "Man, Vol. 21",
        publishers: ["Some Imprint Label", "viz media"],
        isbn_13: ["9781974727094"],
        languages: [{ key: "/languages/eng" }],
      },
      {
        // A library rebind of volume 22: another ISBN, never the edition.
        key: "/books/OL2M",
        title: "Chainsaw Man, Vol. 22",
        publishers: ["Turtleback Books", "VIZ Media"],
        isbn_13: ["9781435299990"],
        languages: [{ key: "/languages/eng" }],
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13)).toEqual(["9781974727094"]);
    });
  });

  it("never gives a Volume a second same-format Release from one publisher", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: false });
    stubDump([
      CHAINSAW_22,
      // A reprint / OL duplicate of volume 22 with another ISBN.
      { ...CHAINSAW_22, key: "/books/OL51694099M", isbn_13: ["9781974799985"] },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13)).toEqual(["9781974766512"]);
      const held = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "/books/OL51694099M",
      )!;
      expect(held.recordRef).toBeUndefined();
      expect(held.conflicts?.[0]?.reason).toContain("already has a physical VIZ Media Release");
    });
  });

  it("streams in chained links across the action budget", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: true });
    // English editions that match nothing (an unrelated ISBN'd book each).
    const english = { languages: [{ key: "/languages/eng" }] };
    stubDump([
      {
        key: "/books/OL1M",
        title: "Nothing Interesting 1",
        isbn_13: ["9780000000002"],
        ...english,
      },
      {
        key: "/books/OL2M",
        title: "Nothing Interesting 2",
        isbn_13: ["9780000000019"],
        ...english,
      },
      CHAINSAW_22,
    ]);
    const clock = tickingClock();
    const first = await sync(t, { maxLines: 2 });
    expect(first).toMatchObject({ continued: true, nextLine: 2 });
    await expectStampedAtHandOff(t);
    clock.mockRestore();
    await drain(t);
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("importRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]!).toMatchObject({ status: "succeeded", recordsSeen: 3 });
      const releases = await ctx.db.query("releases").collect();
      expect(releases[0]!.isbn13).toBe("9781974766512");
    });
  });

  it("runs one bounded link with noContinue and reports where it stopped", async () => {
    const t = makeT();
    await seedRegistry(t);
    await buildSkeleton(t, { withRelease: true });
    const english = { languages: [{ key: "/languages/eng" }] };
    stubDump([
      { key: "/books/OL1M", title: "Nothing Interesting 1", isbn_13: ["9780000000002"], ...english },
      { key: "/books/OL2M", title: "Nothing Interesting 2", isbn_13: ["9780000000019"], ...english },
      CHAINSAW_22,
    ]);
    const result = await sync(t, { maxLines: 2, noContinue: true });
    expect(result).toMatchObject({ continued: false, nextLine: 2, recordsSeen: 2 });
    await t.run(async (ctx) => {
      expect(await ctx.db.system.query("_scheduled_functions").collect()).toHaveLength(0);
      const releases = await ctx.db.query("releases").collect();
      expect(releases[0]!.isbn13).toBeUndefined();
    });
  });
});

describe("openLibrary.sync — Binding reaches the matching ladder (B14)", () => {
  it("a paperback record never fills an ISBN-less hardcover", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    await t.run((ctx) => ctx.db.patch(releaseId!, { binding: "hardcover" }));
    stubDump([CHAINSAW_22]);
    await sync(t);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))!.isbn13).toBeUndefined();
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.recordRef).toBeUndefined();
    });
  });
});

describe("openLibrary.sync — a linked record never gives its Release another's ISBN (B08)", () => {
  it("a changed ISBN another Release holds leaves the linked Release as it was", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    stubDump([CHAINSAW_22]);
    await sync(t);
    const heldIsbn = "9781974766529";
    const holderId = await t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(releaseId!))!;
      return await ctx.db.insert("releases", { ...fields, isbn13: heldIsbn, binding: "hardcover" });
    });

    vi.unstubAllGlobals();
    stubDump([{ ...CHAINSAW_22, isbn_13: [heldIsbn], publish_date: "Oct 20, 2026" }]);
    await sync(t);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(releaseId!)).toMatchObject({
        isbn13: "9781974766512",
        pubDate: { sort: 20261013 },
      });
      const holders = (await ctx.db.query("releases").collect()).filter(
        (r) => r.isbn13 === heldIsbn,
      );
      expect(holders.map((r) => r._id)).toEqual([holderId]);
      const [obs] = await ctx.db.query("sourceObservations").collect();
      expect(obs!.conflicts).toEqual([
        expect.objectContaining({ field: "isbn13", offered: heldIsbn }),
      ]);
    });
  });
});

describe("openLibrary.sync — a volume title split across title + subtitle keeps its identity (W10)", () => {
  const SEQUEL_ISBN = "9781646516544";

  /** Kodansha with the parent "Kingdom Hearts" (Volume 2) and/or its sequel
   * "Kingdom Hearts II" (one unlabeled Volume), each with an ISBN-less
   * physical paperback Release. */
  async function buildKingdomHearts(t: TestT, opts: { parent: boolean; sequel: boolean }) {
    return await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
      const addSeries = async (publicId: number, title: string, label?: string) => {
        const seriesId = await insertSeries(ctx, { publicId, title });
        const volumeId = await insertVolume(ctx, {
          publicId,
          seriesId,
          position: label !== undefined ? Number(label) : 1,
          label,
        });
        const editionId = await insertEdition(ctx, { publicId, publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        return await insertRelease(ctx, {
          editionId,
          binding: "paperback",
          publisherId,
          seriesIds: [seriesId],
        });
      };
      return {
        parentReleaseId: opts.parent ? await addSeries(101, "Kingdom Hearts", "2") : null,
        sequelReleaseId: opts.sequel ? await addSeries(102, "Kingdom Hearts II") : null,
      };
    });
  }

  const record = {
    key: "/books/OL999M",
    isbn_13: [SEQUEL_ISBN],
    languages: [{ key: "/languages/eng" }],
    publishers: ["Kodansha"],
    physical_format: "Paperback",
  };
  const splits = [
    { title: "Kingdom", subtitle: "Hearts II" },
    { title: "Kingdom Hearts", subtitle: "II" },
  ];

  it.each(splits)(
    "$title + $subtitle: the sequel claims the book over the parent's Volume 2",
    async (split) => {
      const t = makeT();
      await seedRegistry(t);
      const { parentReleaseId, sequelReleaseId } = await buildKingdomHearts(t, {
        parent: true,
        sequel: true,
      });
      stubDump([{ ...record, ...split }]);
      await sync(t);

      await t.run(async (ctx) => {
        expect((await ctx.db.get(parentReleaseId!))!.isbn13).toBeUndefined();
        expect((await ctx.db.get(sequelReleaseId!))!.isbn13).toBe(SEQUEL_ISBN);
        const observations = await ctx.db.query("sourceObservations").collect();
        expect(observations).toHaveLength(1);
        expect(observations[0]!.recordRef).toEqual({
          type: "release",
          id: sequelReleaseId,
        });
        expect(await ctx.db.query("releases").collect()).toHaveLength(2);
        expect(await ctx.db.query("series").collect()).toHaveLength(2);
      });
    },
  );

  it.each(splits)(
    "$title + $subtitle: with only the parent, the roman split stands",
    async (split) => {
      const t = makeT();
      await seedRegistry(t);
      const { parentReleaseId } = await buildKingdomHearts(t, {
        parent: true,
        sequel: false,
      });
      stubDump([{ ...record, ...split }]);
      await sync(t);

      await t.run(async (ctx) => {
        expect((await ctx.db.get(parentReleaseId!))!.isbn13).toBe(SEQUEL_ISBN);
        const series = await ctx.db.query("series").collect();
        expect(series.map((s) => s.title)).toEqual(["Kingdom Hearts"]);
      });
    },
  );

  it.each(splits)(
    "$title + $subtitle: with the sequel hidden, the parent gains no ISBN and the book is held",
    async (split) => {
      const t = makeT();
      await seedRegistry(t);
      const { parentReleaseId, sequelReleaseId } = await buildKingdomHearts(t, {
        parent: true,
        sequel: true,
      });
      await t.run(async (ctx) => {
        const sequel = (await ctx.db.query("series").collect()).find((s) => s.title === "Kingdom Hearts II")!;
        await ctx.db.patch(sequel._id, { status: "hidden" });
      });
      stubDump([{ ...record, ...split }]);
      await sync(t);

      await t.run(async (ctx) => {
        expect((await ctx.db.get(parentReleaseId!))!.isbn13).toBeUndefined();
        expect((await ctx.db.get(sequelReleaseId!))!.isbn13).toBeUndefined();
        expect(await ctx.db.query("releases").collect()).toHaveLength(2);
        const [obs] = await ctx.db.query("sourceObservations").collect();
        expect(obs!.recordRef).toBeUndefined();
        const hold = await ctx.db
          .query("placementHolds")
          .withIndex("by_observation", (q) => q.eq("observationId", obs!._id))
          .unique();
        expect(hold?.kind).toBe("series");
        expect(obs!.conflicts?.find((c) => c.field === "placement")?.reason).toContain("which an Editor hid");
      });
    },
  );

  it.each(splits)(
    "$title + $subtitle: with only the sequel, the sequel claims the book",
    async (split) => {
      const t = makeT();
      await seedRegistry(t);
      const { sequelReleaseId } = await buildKingdomHearts(t, {
        parent: false,
        sequel: true,
      });
      stubDump([{ ...record, ...split }]);
      await sync(t);

      await t.run(async (ctx) => {
        expect((await ctx.db.get(sequelReleaseId!))!.isbn13).toBe(SEQUEL_ISBN);
        const series = await ctx.db.query("series").collect();
        expect(series.map((s) => s.title)).toEqual(["Kingdom Hearts II"]);
        expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      });
    },
  );

  it("a bare volume number split across fields fills only an existing Series' Release", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    stubDump([
      { ...CHAINSAW_22, title: "Chainsaw", subtitle: "Man 22" },
      {
        ...CHAINSAW_22,
        key: "/books/OL51694025M",
        title: "Omega",
        subtitle: "Nobody 6",
        isbn_13: ["9781974700042"],
      },
    ]);
    await sync(t);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))!.isbn13).toBe("9781974766512");
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
  });
});

describe("openLibrary.replayDescriptions — stored editions, no dump", () => {
  const proposalsInReview = (t: TestT) =>
    t.run(async (ctx) => (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview").length);

  /** Unlinked editions first, then ANN's Releases carrying their ISBNs. */
  async function lateReleases(t: TestT, editions: Array<Record<string, unknown>>) {
    await seedRegistry(t);
    stubDump(editions);
    await sync(t);
    const { releaseId, publisherId, seriesId } = await buildSkeleton(t, { withRelease: true });
    const isbns = editions.map((e) => (e.isbn_13 as string[])[0]!);
    const ids: Id<"releases">[] = [releaseId!];
    await t.run(async (ctx) => {
      const first = (await ctx.db.get(releaseId!))!;
      await ctx.db.patch(first._id, { isbn13: isbns[0] });
      for (const isbn13 of isbns.slice(1)) {
        ids.push(
          await insertRelease(ctx, {
            editionId: first.editionId,
            format: "digital",
            isbn13,
            publisherId,
            seriesIds: [seriesId],
          }),
        );
      }
    });
    return ids;
  }

  it("never queues a review against text another weak source (ANN) wrote first", async () => {
    const t = makeT();
    const [releaseId] = await lateReleases(t, [{ ...CHAINSAW_22, description: "OL's blurb." }]);
    // ANN's release page described the book first (weak, like OL).
    await t.run(async (ctx) => {
      await insertSourceRevision(ctx, {
        ref: { type: "release", id: releaseId! },
        sourceKey: "ann",
        changes: [{ field: "description", before: undefined, after: "ANN's text." }],
      });
      await ctx.db.patch(releaseId!, { description: "ANN's text." });
    });
    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toMatchObject({ linked: 1 });
    expect(await proposalsInReview(t)).toBe(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))!.description).toBe("ANN's text.");
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.conflicts?.find((c) => c.field === "description")).toMatchObject({
        offered: "OL's blurb.",
        reason: expect.stringContaining("another weak record"),
      });
    });
  });

  it("hands off during a long scan that finds nothing", async () => {
    const t = makeT();
    const ids = await lateReleases(t, [{ ...CHAINSAW_22, description: "Late." }]);
    // 200+ observations sorting before the edition, none worth a replay.
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: `/books/OL0${String(i).padStart(4, "0")}M`,
          snapshot: { kind: "olEdition", key: `/books/OL0${i}M` },
        });
      }
    });
    // Each clock read is past the budget: the first scan alone ends the link.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 6 * 60_000));
    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toMatchObject({
      replayed: 0,
      continued: true,
    });
    vi.restoreAllMocks();
    await drain(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(ids[0]!))!.description).toBe("Late.");
    });
  });

  it("skips an edition whose ISBN the matcher already declined", async () => {
    const t = makeT();
    const [releaseId] = await lateReleases(t, [
      { ...CHAINSAW_22, title: "Something Else Entirely, Vol. 22", description: "Elsewhere." },
    ]);
    const replay = () => t.action(internal.openLibrary.replayDescriptions, {});
    expect(await replay()).toMatchObject({ replayed: 1, linked: 0 });
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.recordRef).toBeUndefined();
      expect(obs.conflicts?.[0]?.reason).toContain("unmatched (rung 2)");
      expect((await ctx.db.get(releaseId!))!.description).toBeUndefined();
    });
    expect(await replay()).toMatchObject({ replayed: 0 });
  });

  it("two editions of one ISBN never queue over their blurbs; an edition updates its own", async () => {
    const t = makeT();
    await seedRegistry(t);
    const { releaseId } = await buildSkeleton(t, { withRelease: true });
    const OTHER = { ...CHAINSAW_22, key: "/books/OL2M", description: "Edition two's blurb." };
    stubDump([{ ...CHAINSAW_22, description: "Edition one's blurb." }, OTHER]);
    await sync(t);
    const description = () => t.run(async (ctx) => (await ctx.db.get(releaseId!))!.description);
    expect(await description()).toBe("Edition one's blurb.");
    expect(await proposalsInReview(t)).toBe(0);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find((o) => o.sourceRecordId === OTHER.key)!;
      expect(obs.conflicts?.find((c) => c.field === "description")?.reason).toContain("another weak record");
    });
    // The edition that wrote the text revises it: an own fact, applied.
    stubDump([{ ...CHAINSAW_22, description: "Edition one, revised." }]);
    await sync(t);
    expect(await description()).toBe("Edition one, revised.");
    expect(await proposalsInReview(t)).toBe(0);
  });

  it("continues in a fresh action after its time budget", async () => {
    const t = makeT();
    const ids = await lateReleases(t, [
      { ...CHAINSAW_22, description: "One." },
      { ...CHAINSAW_22, key: "/books/OL2M", isbn_13: ["9781974766529"], description: "Two." },
      { ...CHAINSAW_22, key: "/books/OL3M", isbn_13: ["9781974766536"], description: "Three." },
    ]);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 61_000));
    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toMatchObject({
      replayed: 1,
      continued: true,
    });
    vi.restoreAllMocks();
    await drain(t);
    await t.run(async (ctx) => {
      const texts = await Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.description));
      expect(texts.sort()).toEqual(["One.", "Three.", "Two."]);
    });
    expect(await proposalsInReview(t)).toBe(0);
  });

  it("fills a Release created after its edition was observed, keeps existing text, creates nothing", async () => {
    const t = makeT();
    await seedRegistry(t);
    // Observed before the catalog had this Series: all three stay unlinked.
    const LATE = { ...CHAINSAW_22, description: "Denji's back." };
    const COPY = {
      ...CHAINSAW_22,
      key: "/books/OL2M",
      isbn_13: ["9781974766529"],
      description: "An OL blurb.",
    };
    // No Release holds its ISBN; a dump pass would now create a leaf for it.
    const LEAF = {
      ...CHAINSAW_22,
      key: "/books/OL3M",
      title: "Chainsaw Man, Vol. 21",
      isbn_13: ["9781974766505"],
      description: "Volume 21.",
    };
    stubDump([LATE, COPY, LEAF]);
    await sync(t);
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", async () => {
      throw new Error("the replay never touches the network");
    });

    // ANN later created the books: one blank, one a publisher already described.
    const { releaseId, publisherId, seriesId } = await buildSkeleton(t, { withRelease: true });
    const described = await t.run(async (ctx) => {
      const late = (await ctx.db.get(releaseId!))!;
      await ctx.db.patch(late._id, { isbn13: "9781974766512" });
      const id = await insertRelease(ctx, {
        editionId: late.editionId,
        format: "digital",
        isbn13: "9781974766529",
        description: "The publisher's copy.",
        publisherId,
        seriesIds: [seriesId],
      });
      await insertSourceRevision(ctx, {
        ref: { type: "release", id },
        sourceKey: "sevenseas",
        changes: [{ field: "description", after: "The publisher's copy." }],
      });
      return id;
    });
    const counts = () =>
      t.run(async (ctx) => ({
        series: (await ctx.db.query("series").collect()).length,
        editions: (await ctx.db.query("editions").collect()).length,
        releases: (await ctx.db.query("releases").collect()).length,
      }));
    const before = await counts();

    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toEqual({
      replayed: 2,
      linked: 2,
      errors: [],
      continued: false,
    });
    expect(await counts()).toEqual(before);
    expect(await proposalsInReview(t)).toBe(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(releaseId!))!.description).toBe("Denji's back.");
      expect((await ctx.db.get(described))!.description).toBe("The publisher's copy.");
      const obs = await ctx.db.query("sourceObservations").collect();
      const byKey = new Map(obs.map((o) => [o.sourceRecordId, o]));
      expect(byKey.get(LATE.key)!.recordRef).toEqual({ type: "release", id: releaseId });
      expect(byKey.get(COPY.key)!.recordRef).toEqual({ type: "release", id: described });
      expect(byKey.get(LEAF.key)!.recordRef).toBeUndefined();
    });

    // Linked now: a rerun has nothing left to replay.
    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toMatchObject({
      replayed: 0,
    });
  });

  it("stops at its limit", async () => {
    const t = makeT();
    await seedRegistry(t);
    stubDump([
      { ...CHAINSAW_22, description: "One." },
      { ...CHAINSAW_22, key: "/books/OL2M", isbn_13: ["9781974766529"], description: "Two." },
    ]);
    await sync(t);
    const { releaseId, publisherId, seriesId } = await buildSkeleton(t, { withRelease: true });
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(releaseId!))!;
      await ctx.db.patch(release._id, { isbn13: "9781974766512" });
      await insertRelease(ctx, {
        editionId: release.editionId,
        format: "digital",
        isbn13: "9781974766529",
        publisherId,
        seriesIds: [seriesId],
      });
    });
    expect(await t.action(internal.openLibrary.replayDescriptions, { limit: 1 })).toMatchObject({
      replayed: 1,
      linked: 1,
    });
    expect(await t.action(internal.openLibrary.replayDescriptions, {})).toMatchObject({
      replayed: 1,
      linked: 1,
    });
  });
});

describe("openLibrary.repairDescriptions — stored catalogue text, no network", () => {
  it("re-cleans stored descriptions and fixes the Releases Open Library wrote", async () => {
    const t = makeT();
    await seedRegistry(t);
    stubDump([
      { ...CHAINSAW_22, description: "Denji is back." },
      { ...CHAINSAW_22, key: "/books/OL2M", isbn_13: ["9781974766529"], description: "Edition two." },
    ]);
    await sync(t);
    const { releaseId, publisherId, seriesId } = await buildSkeleton(t, { withRelease: true });
    const second = await t.run(async (ctx) => {
      const first = (await ctx.db.get(releaseId!))!;
      await ctx.db.patch(first._id, { isbn13: "9781974766512" });
      return await insertRelease(ctx, {
        editionId: first.editionId,
        format: "digital",
        isbn13: "9781974766529",
        publisherId,
        seriesIds: [seriesId],
      });
    });
    await t.action(internal.openLibrary.replayDescriptions, {});
    // What production stored before the cleaner: a citation and a collation.
    const storeOld = (key: string, release: Id<"releases">, text: string) =>
      t.run(async (ctx) => {
        const obs = (await ctx.db.query("sourceObservations").collect()).find((o) => o.sourceRecordId === key)!;
        await ctx.db.patch(obs._id, { snapshot: { ...(obs.snapshot as object), description: text } });
        await ctx.db.patch(release, { description: text });
      });
    await storeOld(CHAINSAW_22.key, releaseId!, '"Denji is back."--P. [4] of cover.');
    await storeOld("/books/OL2M", second, "1 volume (unpaged) : 19 cm");
    vi.stubGlobal("fetch", async () => {
      throw new Error("the repair never touches the network");
    });

    const repair = () => t.action(internal.openLibrary.repairDescriptions, {});
    expect(await repair()).toEqual({
      scanned: 2,
      snapshotFixed: 2,
      releaseUpdated: 1,
      releaseCleared: 1,
      errors: 0,
      continued: false,
    });
    const description = (id: Id<"releases">) =>
      t.run(async (ctx) => (await ctx.db.get(id))!.description ?? null);
    expect(await description(releaseId!)).toBe("Denji is back.");
    expect(await description(second)).toBeNull();
    // Rerun: nothing left.
    expect(await repair()).toMatchObject({ snapshotFixed: 0, releaseUpdated: 0, releaseCleared: 0 });

    // A publisher's text is never Open Library's to repair.
    await t.run(async (ctx) => {
      await insertSourceRevision(ctx, {
        sourceKey: "sevenseas",
        ref: { type: "release", id: releaseId! },
        changes: [{ field: "description", after: '"Ours."--Back cover.' }],
      });
      await ctx.db.patch(releaseId!, { description: '"Ours."--Back cover.' });
    });
    expect(await repair()).toMatchObject({ releaseUpdated: 0 });
    expect(await description(releaseId!)).toBe('"Ours."--Back cover.');
  });
});
