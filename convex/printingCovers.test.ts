// A record of another printing never changes its Release's cover or blurb
// (sevenSeas.noteListing, imports.attachCover): the listing asks for
// neither, a download lands only while its record still offers that art to
// that Release, and a refused download never deletes art anyone shows. A
// record is another printing's when marked, or when a correction made the
// ISBN it states one of the Release's printings (lib/releaseIsbns.ts
// ofOtherPrinting).

import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { coverRequest } from "./lib/covers";
import { BOOK_PAGE_VERSION } from "./lib/sevenSeas";
import { insertBundle, insertObservation } from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, type TestT } from "./test.helpers";
import { hideRecord, mergeAs, moderate } from "./test.moderation";
import { ALPHA_1, imageRequests, SEVEN_SEAS, stubSite } from "./test.imports";
import { linkObservation } from "./lib/observations";
import {
  another,
  CURRENT,
  decide,
  heldRecord,
  OLDER,
  promote,
  rowsOf,
  vagabond,
  type Vagabond,
} from "./test.printings";

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

describe("a download queued before its Edition was frozen (C67-10)", () => {
  const OLD = "https://img.example/old.jpg";
  const NEW = "https://img.example/new.jpg";

  /**
   * Vagabond's Release showing art OLD (a stored blob), a record offering
   * NEW, the cover request a sync makes for it, and the downloaded blob.
   */
  async function queued(t: TestT) {
    await seedRegistry(t);
    await seedTeam(t, [alice, bob]);
    return await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const old = await ctx.storage.store(blob());
      await ctx.db.patch(book.releaseId, {
        coverImage: { storageId: old, sourceUrl: OLD, attribution: "Seven Seas" },
      });
      const observationId = await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "queued",
        recordRef: { type: "release", id: book.releaseId },
        snapshot: { coverUrl: NEW },
      });
      const request = coverRequest((await ctx.db.get(book.releaseId))!, NEW, observationId)!;
      return { ...book, old, request, incoming: await ctx.storage.store(blob()) };
    });
  }
  const freeze: Array<
    [string, (t: TestT, b: Awaited<ReturnType<typeof queued>>) => Promise<unknown>, RegExp]
  > = [
    ["hidden", (t, b) => hideRecord(t, { type: "edition", id: b.editionId }), /Edition is hidden/],
    [
      "locked",
      (t, b) => moderate(t, "lockRecord", { type: "edition", id: b.editionId }, "A dispute."),
      /Edition is locked/,
    ],
    [
      "merged away",
      async (t, b) => {
        const survivor = await t.run(
          async (ctx) => (await ctx.db.get(await another(ctx, b)))!.editionId,
        );
        await mergeAs(t, { type: "edition", id: survivor }, { type: "edition", id: b.editionId });
      },
      /in another Edition now/,
    ],
    ["removed", (t, b) => t.run((ctx) => ctx.db.delete(b.editionId)), /Edition is gone/],
  ];

  it("refuses it, keeping the Release's art and deleting only the unshown download", async () => {
    for (const [, change, reason] of freeze) {
      const t = makeT();
      const b = await queued(t);
      await change(t, b);
      const before = await coverOf(t, b.releaseId);
      expect(
        await t.mutation(internal.imports.attachCover, {
          ...b.request,
          storageId: b.incoming,
          attribution: "Seven Seas",
        }),
      ).toEqual({ attached: false, held: null, refused: expect.stringMatching(reason) });
      expect(await coverOf(t, b.releaseId)).toEqual(before);
      expect(await stored(t, b.old)).toBe(true);
      expect(await stored(t, b.incoming)).toBe(false);
    }
  });

  it("keeps a download another Release or a Bundle already shows, and refuses an old-shape request too", async () => {
    for (const sharer of ["release", "bundle"] as const) {
      const t = makeT();
      const b = await queued(t);
      await t.run(async (ctx) => {
        if (sharer === "release")
          await ctx.db.patch(await another(ctx, b), {
            coverImage: { storageId: b.incoming, sourceUrl: NEW, attribution: "Seven Seas" },
          });
        else
          await insertBundle(ctx, {
            publisherId: b.publisherId,
            coverImage: { storageId: b.incoming },
          });
      });
      await hideRecord(t, { type: "edition", id: b.editionId });
      expect(
        await t.mutation(internal.imports.attachCover, {
          ...b.request,
          storageId: b.incoming,
          attribution: "Seven Seas",
        }),
      ).toMatchObject({ attached: false, refused: expect.stringMatching(/Edition is hidden/) });
      expect(await stored(t, b.incoming)).toBe(true);
      expect(await stored(t, b.old)).toBe(true);
    }
    // A request from an action that started before requests named their record and Edition.
    const t = makeT();
    const b = await queued(t);
    await moderate(t, "lockRecord", { type: "edition", id: b.editionId }, "A dispute.");
    expect(
      await attach(t, { releaseId: b.releaseId, storageId: b.incoming, sourceUrl: NEW }),
    ).toMatchObject({ attached: false, refused: expect.stringMatching(/Edition is locked/) });
    expect(await stored(t, b.old)).toBe(true);
  });

  it("refuses a placeholder the same way, and a marked record still linked to a merged-away Release", async () => {
    for (const parent of [{ status: "hidden" as const }, { locked: true }]) {
      const t = makeT();
      const book = await offered(t);
      await t.run((ctx) => ctx.db.patch(book.editionId, parent));
      expect(
        await attach(t, {
          releaseId: book.releaseId,
          editionId: book.editionId,
          observationId: book.observationId,
        }),
      ).toMatchObject({
        attached: false,
        held: null,
        refused: expect.stringMatching(/Edition is/),
      });
      expect(await coverOf(t, book.releaseId)).toBeNull();
    }
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const merged = await another(ctx, book, { status: "merged", mergedIntoId: book.releaseId });
      const observationId = await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "old-link",
        recordRef: { type: "release", id: merged },
        printingIsbn13: OLDER,
        snapshot: { coverUrl: ART },
      });
      return { ...book, observationId };
    });
    expect(
      await attach(t, {
        releaseId: ids.releaseId,
        editionId: ids.editionId,
        observationId: ids.observationId,
      }),
    ).toMatchObject({
      attached: false,
      refused: expect.stringMatching(/links another record now/),
    });
  });

  it("attaches it while the Edition stays active and unlocked (control)", async () => {
    const t = makeT();
    const b = await queued(t);
    expect(
      await t.mutation(internal.imports.attachCover, {
        ...b.request,
        storageId: b.incoming,
        attribution: "Seven Seas",
      }),
    ).toEqual({ attached: true, held: b.incoming });
    expect(await coverOf(t, b.releaseId)).toMatchObject({ storageId: b.incoming, sourceUrl: NEW });
    expect(await stored(t, b.old)).toBe(false);
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

describe("a record a primary correction made another printing's (C67-R2-02)", () => {
  const SHOWN = "https://img.example/current.jpg";
  const PRINTING_ART = "https://img.example/2002.jpg";
  /** Seven Seas' page of the 2002 printing, as applyBook receives it. */
  const page = {
    kind: "book" as const,
    url: "https://sevenseasentertainment.com/books/vagabond-vol-1/",
    title: "Vagabond Vol. 1",
    seriesTitle: "Vagabond",
    seriesSlug: "vagabond",
    seriesUrl: "https://sevenseasentertainment.com/series/vagabond/",
    volumeLabel: "1",
    isbn13: OLDER,
    releaseDate: { year: 2002, month: 6, day: 5 },
    priceCents: 999,
    coverUrl: PRINTING_ART,
    modifiedGmt: "stamp",
    parserVersion: BOOK_PAGE_VERSION,
    creators: [],
  };

  /**
   * OLDER recorded as a printing of Vagabond's Release and promoted to its
   * own ISBN; a Seven Seas record of OLDER then linked through the real
   * link as the Release's own (so unmarked), offering PRINTING_ART while the
   * Release shows SHOWN (a stored blob); the cover request its sync makes;
   * the downloaded blob. With `corrected`, an approved Proposal then gives
   * the Release its own ISBN back (CURRENT), keeping OLDER's row.
   */
  async function promoted(t: TestT, corrected: boolean) {
    await seedRegistry(t);
    await seedTeam(t, [alice, bob]);
    const book = await t.run(vagabond);
    const first = await t.run((ctx) => heldRecord(ctx, book.seriesId, OLDER));
    expect(await decide(t, first, book.releaseId)).toMatchObject({ status: "recorded" });
    await promote(t, book.releaseId, "isbn13", OLDER);
    const ids = await t.run(async (ctx) => {
      const old = await ctx.storage.store(blob());
      await ctx.db.patch(book.releaseId, {
        coverImage: { storageId: old, sourceUrl: SHOWN, attribution: "Seven Seas" },
      });
      const observationId = await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "own-printing",
        snapshot: page,
      });
      await linkObservation(ctx, observationId, { type: "release", id: book.releaseId });
      const request = coverRequest(
        (await ctx.db.get(book.releaseId))!,
        PRINTING_ART,
        observationId,
      )!;
      return { old, observationId, request, incoming: await ctx.storage.store(blob()) };
    });
    expect((await t.run((ctx) => ctx.db.get(ids.observationId)))?.printingIsbn13).toBeUndefined();
    if (corrected) await promote(t, book.releaseId, "isbn13", CURRENT);
    expect(await rowsOf(t, book.releaseId)).toEqual([OLDER]);
    return { ...book, ...ids };
  }

  it("refuses the queued download, keeping the Release's art and deleting the unshown one", async () => {
    const t = makeT();
    const b = await promoted(t, true);
    expect(
      await t.mutation(internal.imports.attachCover, {
        ...b.request,
        storageId: b.incoming,
        attribution: "Seven Seas",
      }),
    ).toEqual({ attached: false, held: null, refused: "its record is another printing's" });
    expect(await coverOf(t, b.releaseId)).toMatchObject({ storageId: b.old, sourceUrl: SHOWN });
    expect(await stored(t, b.old)).toBe(true);
    expect(await stored(t, b.incoming)).toBe(false);
    // An old-shape request (no record, no Edition) is held to the same reading.
    const incoming = await t.run((ctx) => ctx.storage.store(blob()));
    expect(
      await attach(t, {
        releaseId: b.releaseId,
        storageId: incoming,
        sourceUrl: PRINTING_ART,
      }),
    ).toMatchObject({ attached: false, refused: "a record of another printing offers that art" });
    expect(await stored(t, incoming)).toBe(false);
    expect(await stored(t, b.old)).toBe(true);
  });

  it("keeps a refused download a Bundle shows", async () => {
    const t = makeT();
    const b = await promoted(t, true);
    await t.run((ctx) =>
      insertBundle(ctx, { publisherId: b.publisherId, coverImage: { storageId: b.incoming } }),
    );
    expect(
      await t.mutation(internal.imports.attachCover, {
        ...b.request,
        storageId: b.incoming,
        attribution: "Seven Seas",
      }),
    ).toMatchObject({ attached: false, refused: "its record is another printing's" });
    expect(await stored(t, b.incoming)).toBe(true);
    expect(await stored(t, b.old)).toBe(true);
  });

  it("offers no new art: neither the listing nor the re-read page", async () => {
    const t = makeT();
    const b = await promoted(t, true);
    expect(
      await t.mutation(internal.sevenSeas.noteListing, {
        sourceRecordId: "own-printing",
        modifiedGmt: "stamp",
        force: false,
        offersBlurb: true,
      }),
    ).toEqual({ needsDetail: false });
    const before = await t.run((ctx) => ctx.db.get(b.releaseId));
    expect(
      await t.mutation(internal.sevenSeas.applyBook, {
        sourceRecordId: "own-printing",
        snapshot: { ...page, modifiedGmt: "later", description: "The 2002 printing's blurb." },
      }),
    ).toEqual({ status: "recordOnly", changed: false, releaseId: b.releaseId });
    expect(await t.run((ctx) => ctx.db.get(b.releaseId))).toEqual(before);
  });

  it("still attaches the art of a record of the Release's own printing (control)", async () => {
    const t = makeT();
    const b = await promoted(t, false);
    expect(
      await t.mutation(internal.sevenSeas.noteListing, {
        sourceRecordId: "own-printing",
        modifiedGmt: "stamp",
        force: false,
        offersBlurb: false,
      }),
    ).toEqual({ needsDetail: false, cover: b.request });
    expect(
      await t.mutation(internal.imports.attachCover, {
        ...b.request,
        storageId: b.incoming,
        attribution: "Seven Seas",
      }),
    ).toEqual({ attached: true, held: b.incoming });
    expect(await coverOf(t, b.releaseId)).toMatchObject({
      storageId: b.incoming,
      sourceUrl: PRINTING_ART,
    });
    expect(await stored(t, b.old)).toBe(false);
  });
});
