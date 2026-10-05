// A record of another printing never changes its Release's cover or blurb
// (sevenSeas.noteListing, imports.attachCover): the listing asks for
// neither, a download lands only while its record still offers that art to
// that Release, and a refused download never deletes art anyone shows.

import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BOOK_PAGE_VERSION } from "./lib/sevenSeas";
import { insertBundle, insertObservation } from "./test.factories";
import { makeT, seedRegistry, type TestT } from "./test.helpers";
import { ALPHA_1, imageRequests, SEVEN_SEAS, stubSite } from "./test.imports";
import { another, OLDER, vagabond, type Vagabond } from "./test.printings";

afterEach(() => {
  vi.unstubAllGlobals();
  imageRequests.length = 0;
});

const ART = "https://img.example/vagabond.jpg";
const blob = () => new Blob([new Uint8Array(4096)], { type: "image/jpeg" });

/** Vagabond's Release, and a Seven Seas record of it offering ART, marked or not. */
async function offered(t: TestT, mark?: string) {
  return await t.run(async (ctx) => {
    const book = await vagabond(ctx);
    const observationId = await insertObservation(ctx, {
      sourceKey: "sevenseas",
      sourceRecordId: "1",
      recordRef: { type: "release", id: book.releaseId },
      ...(mark !== undefined ? { printingIsbn13: mark } : {}),
      snapshot: { coverUrl: ART, modifiedGmt: "stamp", parserVersion: BOOK_PAGE_VERSION },
    });
    return { ...book, observationId };
  });
}

const attach = (
  t: TestT,
  args: {
    releaseId: Id<"releases">;
    observationId?: Id<"sourceObservations">;
    editionId?: Id<"editions">;
    storageId?: Id<"_storage">;
    sourceUrl?: string;
  },
) =>
  t.mutation(internal.imports.attachCover, {
    sourceUrl: ART,
    attribution: "Seven Seas",
    ...args,
  });

const stored = (t: TestT, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
const coverOf = (t: TestT, releaseId: Id<"releases">) =>
  t.run(async (ctx) => (await ctx.db.get(releaseId))?.coverImage ?? null);

describe("the Seven Seas listing", () => {
  it("asks a marked record for neither art nor blurb, but still notes it was seen", async () => {
    const t = makeT();
    const book = await offered(t, OLDER);
    const note = await t.mutation(internal.sevenSeas.noteListing, {
      sourceRecordId: "1",
      modifiedGmt: "stamp",
      force: false,
      offersBlurb: true,
    });
    expect(note).toEqual({ needsDetail: false });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(book.observationId))!.lastSeenAt),
    ).toBeGreaterThan(0);
    // A changed page is read again, and the read still offers the Release nothing.
    expect(
      await t.mutation(internal.sevenSeas.noteListing, {
        sourceRecordId: "1",
        modifiedGmt: "later",
        force: false,
        offersBlurb: true,
      }),
    ).toEqual({ needsDetail: true });
  });

  it("never lets a re-read page of a marked record change the Release", async () => {
    const t = makeT();
    await seedRegistry(t);
    const book = await offered(t, OLDER);
    const before = await t.run((ctx) => ctx.db.get(book.releaseId));
    const result = await t.mutation(internal.sevenSeas.applyBook, {
      sourceRecordId: "1",
      snapshot: {
        kind: "book",
        url: "https://sevenseasentertainment.com/books/vagabond-vol-1/",
        title: "Vagabond Vol. 1",
        seriesTitle: "Vagabond",
        seriesSlug: "vagabond",
        seriesUrl: "https://sevenseasentertainment.com/series/vagabond/",
        volumeLabel: "1",
        isbn13: OLDER,
        releaseDate: { year: 2002, month: 6, day: 5 },
        priceCents: 999,
        description: "The 2002 printing's blurb.",
        coverUrl: "https://img.example/2002.jpg",
        modifiedGmt: "later",
        parserVersion: BOOK_PAGE_VERSION,
        creators: [],
      },
    });
    expect(result).toEqual({ status: "recordOnly", changed: false, releaseId: book.releaseId });
    expect(await t.run((ctx) => ctx.db.get(book.releaseId))).toEqual(before);
  });

  it("still retries an unmarked record's missing art", async () => {
    const t = makeT();
    const book = await offered(t);
    expect(
      await t.mutation(internal.sevenSeas.noteListing, {
        sourceRecordId: "1",
        modifiedGmt: "stamp",
        force: false,
        offersBlurb: false,
      }),
    ).toEqual({
      needsDetail: false,
      cover: {
        releaseId: book.releaseId,
        editionId: book.editionId,
        sourceUrl: ART,
        observationId: book.observationId,
      },
    });
  });
});

describe("attaching a cover", () => {
  it("attaches only while the request's record still offers that art to that Release", async () => {
    const cases: Array<
      [
        string,
        (
          t: TestT,
          book: Vagabond & { observationId: Id<"sourceObservations"> },
        ) => Promise<unknown>,
        RegExp,
      ]
    > = [
      [
        "marked since",
        (t, b) => t.run((ctx) => ctx.db.patch(b.observationId, { printingIsbn13: OLDER })),
        /another printing's/,
      ],
      [
        "relinked since",
        (t, b) =>
          t.run(async (ctx) =>
            ctx.db.patch(b.observationId, {
              recordRef: { type: "release", id: await another(ctx, b) },
            }),
          ),
        /links another record now/,
      ],
      [
        "art changed since",
        (t, b) =>
          t.run((ctx) =>
            ctx.db.patch(b.observationId, {
              snapshot: { coverUrl: "https://img.example/new.jpg" },
            }),
          ),
        /no longer offers that art/,
      ],
      [
        "withdrawn since",
        (t, b) => t.run((ctx) => ctx.db.patch(b.observationId, { withdrawn: true })),
        /no longer offers that art/,
      ],
      [
        "record gone",
        (t, b) => t.run((ctx) => ctx.db.delete(b.observationId)),
        /its record is gone/,
      ],
      [
        "Release moved Edition",
        (t, b) =>
          t.run(async (ctx) =>
            ctx.db.patch(b.releaseId, {
              editionId: (await ctx.db.get(await another(ctx, b)))!.editionId,
            }),
          ),
        /in another Edition now/,
      ],
    ];
    for (const [, change, reason] of cases) {
      const t = makeT();
      const book = await offered(t);
      await change(t, book);
      const incoming = await t.run((ctx) => ctx.storage.store(blob()));
      expect(
        await attach(t, {
          releaseId: book.releaseId,
          observationId: book.observationId,
          editionId: book.editionId,
          storageId: incoming,
        }),
      ).toEqual({ attached: false, held: null, refused: expect.stringMatching(reason) });
      expect(await coverOf(t, book.releaseId)).toBeNull();
      expect(await stored(t, incoming)).toBe(false);
    }
    const t = makeT();
    const book = await offered(t);
    const incoming = await t.run((ctx) => ctx.storage.store(blob()));
    expect(
      await attach(t, {
        releaseId: book.releaseId,
        observationId: book.observationId,
        editionId: book.editionId,
        storageId: incoming,
      }),
    ).toEqual({ attached: true, held: incoming });
  });

  it("holds a request naming no record to an unmarked offer and no marked one", async () => {
    for (const [records, attached] of [
      [[undefined], true],
      [[OLDER], false],
      [[undefined, OLDER], false],
      [[], false],
    ] as const) {
      const t = makeT();
      const book = await t.run((ctx) => vagabond(ctx));
      await t.run(async (ctx) => {
        for (const [i, mark] of records.entries()) {
          await insertObservation(ctx, {
            sourceKey: "sevenseas",
            sourceRecordId: String(i),
            recordRef: { type: "release", id: book.releaseId },
            ...(mark !== undefined ? { printingIsbn13: mark } : {}),
            snapshot: { coverUrl: ART },
          });
        }
      });
      const result = await attach(t, { releaseId: book.releaseId });
      expect(result.attached).toBe(attached);
      expect(await coverOf(t, book.releaseId)).toEqual(
        attached ? { sourceUrl: ART, attribution: "Seven Seas" } : null,
      );
    }
  });

  it("never deletes art someone shows when it refuses a download", async () => {
    for (const shownBy of ["target", "release", "bundle", "nobody"] as const) {
      const t = makeT();
      const book = await offered(t, OLDER);
      const incoming = await t.run(async (ctx) => {
        const id = await ctx.storage.store(blob());
        const cover = {
          storageId: id,
          sourceUrl: "https://img.example/old.jpg",
          attribution: "Seven Seas",
        };
        if (shownBy === "target") await ctx.db.patch(book.releaseId, { coverImage: cover });
        if (shownBy === "release")
          await ctx.db.patch(await another(ctx, book), { coverImage: cover });
        if (shownBy === "bundle")
          await insertBundle(ctx, { publisherId: book.publisherId, coverImage: { storageId: id } });
        return id;
      });
      const before = await coverOf(t, book.releaseId);
      expect(
        await attach(t, {
          releaseId: book.releaseId,
          observationId: book.observationId,
          storageId: incoming,
        }),
      ).toMatchObject({ attached: false, held: null, refused: expect.any(String) });
      expect(await stored(t, incoming)).toBe(shownBy !== "nobody");
      expect(await coverOf(t, book.releaseId)).toEqual(before);
    }
    // A placeholder stores nothing to delete; a blob already gone is stale.
    const t = makeT();
    const book = await offered(t, OLDER);
    expect(
      await attach(t, { releaseId: book.releaseId, observationId: book.observationId }),
    ).toMatchObject({ attached: false, held: null });
    const gone = await t.run(async (ctx) => {
      const id = await ctx.storage.store(blob());
      await ctx.storage.delete(id);
      return id;
    });
    expect(
      await attach(t, {
        releaseId: book.releaseId,
        observationId: book.observationId,
        storageId: gone,
      }),
    ).toEqual({
      attached: false,
      held: null,
      stale: true,
    });
  });
});

describe("a download racing a decision", () => {
  /** Serve the stubbed site; while art downloads, run `during` first. */
  function artDownload(during: (() => Promise<unknown>) | null, broken = false) {
    const site = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "object" && "url" in input ? input.url : String(input);
      if (url.includes("/wp-content/uploads/")) {
        if (broken) return new Response("not found", { status: 404 });
        if (during) await during();
      }
      return site(input);
    });
  }

  it("lands nothing when the record is marked or relinked while its art downloads", async () => {
    for (const [change, reason] of [
      ["mark", "its record is another printing's"],
      ["relink", "its record links another record now"],
    ] as const) {
      const t = makeT();
      await seedRegistry(t, true);
      const sync = () => t.action(internal.sevenSeas.sync, { politeDelayMs: 0 });
      // The book applies; its art fails, so the next listing retries it.
      stubSite([ALPHA_1]);
      artDownload(null, true);
      await sync();
      const { observationId, releaseId } = await t.run(async (ctx) => {
        const observation = (await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "sevenseas").eq("sourceRecordId", String(ALPHA_1.id)),
          )
          .unique())!;
        return {
          observationId: observation._id,
          releaseId: observation.recordRef!.id as Id<"releases">,
        };
      });
      imageRequests.length = 0;
      stubSite([ALPHA_1]);
      artDownload(() =>
        t.run(async (ctx) => {
          if (change === "mark") await ctx.db.patch(observationId, { printingIsbn13: OLDER });
          else {
            const release = (await ctx.db.get(releaseId))!;
            const other = await ctx.db.insert("releases", {
              ...release,
              _id: undefined,
              _creationTime: undefined,
            } as never);
            await ctx.db.patch(observationId, { recordRef: { type: "release", id: other } });
          }
        }),
      );
      await sync();
      expect(await coverOf(t, releaseId)).toBeNull();
      await t.run(async (ctx) => {
        expect(await ctx.db.system.query("_storage").collect()).toEqual([]);
        const run = (await ctx.db.query("importRuns").order("desc").first())!;
        expect(run.errors).toContainEqual(expect.stringContaining(`not attached (${reason})`));
      });
      expect(imageRequests).toEqual([
        `${SEVEN_SEAS}/wp-content/uploads/covers/${ALPHA_1.slug}.jpg`,
      ]);
    }
  });
});
