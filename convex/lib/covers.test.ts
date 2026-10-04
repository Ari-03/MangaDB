import { describe, expect, test } from "vitest";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  type Overrides,
} from "../test.factories";
import { makeT } from "../test.helpers";
import {
  jacketCache,
  MIN_COVER_BYTES,
  releaseCover,
  seriesCoverIsbns,
  type SeriesCoverCandidate,
} from "./covers";

const TODAY = 20260925;
const release = (
  isbn13: string | undefined,
  over: Partial<SeriesCoverCandidate> = {},
): SeriesCoverCandidate => ({
  isbn13,
  format: "physical",
  pubDate: { year: 2020, sort: 20200101 },
  inLine: false,
  position: 1,
  ...over,
});

describe("seriesCoverIsbns", () => {
  test("no ISBN anywhere is no pick", () => {
    expect(seriesCoverIsbns([], TODAY)).toEqual([]);
    expect(seriesCoverIsbns([release(undefined)], TODAY)).toEqual([]);
  });

  test("the standard run's Volume 1 in print leads", () => {
    const picked = seriesCoverIsbns(
      [
        // omnibus 1, older than the standard Volume 1
        release("9780000000001", { inLine: true, pubDate: { year: 2010, sort: 20100101 } }),
        release("9780000000002", { format: "digital" }), // vol 1 ebook
        release("9780000000004", { position: 2 }), // vol 2 print
        release("9780000000003"), // vol 1 print
      ],
      TODAY,
    );
    // Best first, capped at three: the ebook ranks last of all.
    expect(picked).toEqual(["9780000000003", "9780000000001", "9780000000004"]);
  });

  test("an Edition Line's earlier Volume beats a later standard one", () => {
    // Kanokon: omnibuses from Volume 5, the standard run only from Volume 10.
    const picked = seriesCoverIsbns(
      [
        release("9780000000010", { position: 10 }),
        release("9780000000005", { inLine: true, position: 5 }),
      ],
      TODAY,
    );
    expect(picked[0]).toBe("9780000000005");
  });

  test("a published book beats an earlier-placed forthcoming one", () => {
    const picked = seriesCoverIsbns(
      [
        release("9780000000001", { pubDate: { year: 2027, sort: 20270101 } }),
        release("9780000000002", { pubDate: undefined }),
        release("9780000000003", { position: 3 }),
      ],
      TODAY,
    );
    expect(picked[0]).toBe("9780000000003");
  });

  test("a book counts as published from its release day, by the day passed in", () => {
    const candidates = [
      release("9780000000001", { pubDate: { year: 2026, sort: 20261010 } }),
      release("9780000000003", { position: 3 }),
    ];
    expect(seriesCoverIsbns(candidates, 20261009)[0]).toBe("9780000000003");
    expect(seriesCoverIsbns(candidates, 20261010)[0]).toBe("9780000000001");
  });

  test("digital and Edition Lines still stand in when nothing better exists", () => {
    expect(
      seriesCoverIsbns([release("9780000000001", { format: "digital", inLine: true })], TODAY),
    ).toEqual(["9780000000001"]);
  });

  test("an ISBN on file twice is offered once", () => {
    expect(
      seriesCoverIsbns(
        [release("9780000000001"), release("9780000000001", { position: 2 })],
        TODAY,
      ),
    ).toEqual(["9780000000001"]);
  });
});

/**
 * One Series with one Volume, and builders for its Editions (each covering
 * the Volume unless `covers` is false) and their Releases (returned as docs).
 */
async function oneVolume(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx);
  const seriesId = await insertSeries(ctx);
  const volumeId = await insertVolume(ctx, { seriesId });
  const edition = async ({
    status = "active",
    covers = true,
  }: {
    status?: "active" | "hidden";
    covers?: boolean;
  } = {}) => {
    const editionId = await insertEdition(ctx, { status, publisherId });
    if (covers) await insertCoverage(ctx, { editionId, volumeId });
    return editionId;
  };
  const release = async (
    editionId: Id<"editions">,
    format: "physical" | "digital",
    over: Overrides<"releases"> = {},
  ) => {
    const id = await insertRelease(ctx, {
      editionId,
      format,
      publisherId,
      seriesIds: [seriesId],
      ...over,
    });
    return (await ctx.db.get(id))!;
  };
  return { edition, release };
}

describe("releaseCover", () => {
  test("every Release of an Edition shares its ISBNs (physical first); an ISBN-less Edition borrows another's of its Volume", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { edition, release } = await oneVolume(ctx);
      const standard = await edition();
      const ebook = await release(standard, "digital", { isbn13: "9780000000001" });
      await release(standard, "physical", { isbn13: "9780000000009", status: "hidden" });
      const print = await release(standard, "physical", { isbn13: "9780000000002" });
      const bare = await release(standard, "physical");
      const otherBare = await release(await edition(), "digital");
      const lonely = await release(await edition({ covers: false }), "physical");

      const cache = jacketCache(ctx);
      const isbns = async (r: Doc<"releases">, c = cache) =>
        (await releaseCover(ctx, r, c)).coverIsbns;
      // The ebook looks art up by its print sibling's ISBN first, then its own.
      expect(await isbns(ebook)).toEqual(["9780000000002", "9780000000001"]);
      expect(await isbns(bare)).toEqual(["9780000000002", "9780000000001"]);
      expect(await isbns(print, jacketCache(ctx))).toEqual(["9780000000002", "9780000000001"]);
      expect(await isbns(otherBare)).toEqual(["9780000000002"]);
      expect(await isbns(lonely)).toEqual([]);
    });
  });

  test("never borrows from a hidden Edition, even one whose Release is active", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { edition, release } = await oneVolume(ctx);
      const bare = await release(await edition(), "physical");
      await release(await edition({ status: "hidden" }), "physical", { isbn13: "9780000000005" });
      expect((await releaseCover(ctx, bare)).coverIsbns).toEqual([]);

      // An active Edition of the same Volume still lends, past the hidden one.
      await release(await edition(), "physical", { isbn13: "9780000000006" });
      expect((await releaseCover(ctx, bare)).coverIsbns).toEqual(["9780000000006"]);
    });
  });
});

/** One active Edition with no Coverage, and a way to add Releases to it. */
async function oneEdition(ctx: MutationCtx) {
  const { edition, release } = await oneVolume(ctx);
  const editionId = await edition({ covers: false });
  return {
    editionId,
    release: (format: "physical" | "digital", over: Overrides<"releases"> = {}) =>
      release(editionId, format, over),
  };
}

const dated = (sort: number) => ({ year: Math.floor(sort / 10000), sort });

describe("jacketCache", () => {
  test("a digital Release and its print sibling look art up by the same ISBNs, print first", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId, release } = await oneEdition(ctx);
      const digital = await release("digital", {
        isbn13: "9798898302498",
        pubDate: dated(20261007),
      });
      const print = await release("physical", {
        isbn13: "9798888778661",
        pubDate: dated(20261104),
      });
      const cache = jacketCache(ctx);
      const both = ["9798888778661", "9798898302498"];
      expect((await releaseCover(ctx, digital, cache)).coverIsbns).toEqual(both);
      expect((await releaseCover(ctx, print, cache)).coverIsbns).toEqual(both);
      expect(await cache.jacket(editionId)).toEqual({ coverUrl: null, coverIsbns: both });
    });
  });

  test("date order within a format, each ISBN once, at most three, hidden Releases left out", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId, release } = await oneEdition(ctx);
      await release("physical", { isbn13: "9780000000003", pubDate: dated(20260301) });
      await release("digital", { isbn13: "9780000000001", pubDate: dated(20260101) });
      await release("physical", {
        isbn13: "9780000000009",
        pubDate: dated(20250101),
        status: "hidden",
      });
      await release("physical", { isbn13: "9780000000002", pubDate: dated(20260201) });
      await release("physical", { isbn13: "9780000000002", pubDate: dated(20260501) });
      await release("digital", { isbn13: "9780000000004" });
      expect((await jacketCache(ctx).jacket(editionId)).coverIsbns).toEqual([
        "9780000000002",
        "9780000000003",
        "9780000000001",
      ]);
    });
  });

  test("a Release without art wears its Edition's first stored cover; one with its own keeps it", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId, release } = await oneEdition(ctx);
      const store = (bytes: number, type = "image/jpeg") =>
        ctx.storage.store(new Blob([new Uint8Array(bytes)], { type }));
      const art = await store(MIN_COVER_BYTES + 1);
      const ownArt = await store(MIN_COVER_BYTES + 1);
      // A tiny file and an SVG are placeholders, never a cover.
      const tiny = await store(16);
      const svg = await store(MIN_COVER_BYTES + 1, "image/svg+xml");
      const placeholder = await release("digital", {
        pubDate: dated(20260101),
        coverImage: { storageId: tiny },
      });
      await release("physical", { pubDate: dated(20260115), coverImage: { storageId: svg } });
      await release("physical", { pubDate: dated(20260201), coverImage: { storageId: art } });
      const own = await release("physical", {
        pubDate: dated(20260301),
        coverImage: { storageId: ownArt },
      });
      const bare = await release("digital");

      const artUrl = await ctx.storage.getUrl(art);
      const cache = jacketCache(ctx);
      expect((await cache.jacket(editionId)).coverUrl).toBe(artUrl);
      expect((await releaseCover(ctx, placeholder, cache)).coverUrl).toBe(artUrl);
      expect((await releaseCover(ctx, bare, cache)).coverUrl).toBe(artUrl);
      expect((await releaseCover(ctx, own, cache)).coverUrl).toBe(await ctx.storage.getUrl(ownArt));
    });
  });

  test("an Edition holding only placeholders has no stored cover", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId, release } = await oneEdition(ctx);
      const tiny = await ctx.storage.store(new Blob([new Uint8Array(16)], { type: "image/jpeg" }));
      const placeholder = await release("physical", {
        isbn13: "9780000000001",
        coverImage: { storageId: tiny },
      });
      expect(await releaseCover(ctx, placeholder)).toEqual({
        coverUrl: null,
        coverIsbns: ["9780000000001"],
      });
      expect((await jacketCache(ctx).jacket(editionId)).coverUrl).toBeNull();
    });
  });
});
