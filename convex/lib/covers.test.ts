import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  coverIsbnCache,
  coverIsbnForRelease,
  seriesCoverIsbn,
  type SeriesCoverCandidate,
} from "./covers";

const NOW = new Date(Date.UTC(2026, 8, 25));
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

describe("seriesCoverIsbn", () => {
  test("no ISBN anywhere is no pick", () => {
    expect(seriesCoverIsbn([], NOW)).toBeNull();
    expect(seriesCoverIsbn([release(undefined)], NOW)).toBeNull();
  });

  test("the standard run's Volume 1 in print leads", () => {
    const picked = seriesCoverIsbn(
      [
        // omnibus 1, older than the standard Volume 1
        release("9780000000001", { inLine: true, pubDate: { year: 2010, sort: 20100101 } }),
        release("9780000000002", { format: "digital" }), // vol 1 ebook
        release("9780000000004", { position: 2 }), // vol 2 print
        release("9780000000003"), // vol 1 print
      ],
      NOW,
    );
    expect(picked).toBe("9780000000003");
  });

  test("an Edition Line's earlier Volume beats a later standard one", () => {
    // Kanokon: omnibuses from Volume 5, the standard run only from Volume 10.
    const picked = seriesCoverIsbn(
      [
        release("9780000000010", { position: 10 }),
        release("9780000000005", { inLine: true, position: 5 }),
      ],
      NOW,
    );
    expect(picked).toBe("9780000000005");
  });

  test("a published book beats an earlier-placed forthcoming one", () => {
    const picked = seriesCoverIsbn(
      [
        release("9780000000001", { pubDate: { year: 2027, sort: 20270101 } }),
        release("9780000000002", { pubDate: undefined }),
        release("9780000000003", { position: 3 }),
      ],
      NOW,
    );
    expect(picked).toBe("9780000000003");
  });

  test("digital and Edition Lines still stand in when nothing better exists", () => {
    expect(
      seriesCoverIsbn([release("9780000000001", { format: "digital", inLine: true })], NOW),
    ).toBe("9780000000001");
  });
});

describe("coverIsbnForRelease", () => {
  test("own ISBN, else an active sibling (physical first), else another Edition of the Volume", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "VIZ Media",
        slug: "viz-media",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Tokyo Ghoul",
        altTitles: [],
        searchText: "Tokyo Ghoul",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 1,
      });
      const edition = async (publicId: number, covers = true) => {
        const id = await ctx.db.insert("editions", { status: "active", publicId, publisherId });
        if (covers) {
          await ctx.db.insert("volumeCoverages", {
            editionId: id,
            volumeId,
            order: 1,
            extent: "complete",
          });
        }
        return id;
      };
      const release = async (
        editionId: Id<"editions">,
        format: "physical" | "digital",
        isbn13?: string,
        status: "active" | "hidden" = "active",
      ) => {
        const id = await ctx.db.insert("releases", {
          status,
          editionId,
          format,
          language: "en",
          isbn13,
          publisherId,
          seriesIds: [seriesId],
        });
        return (await ctx.db.get(id))!;
      };

      const standard = await edition(1);
      const ebook = await release(standard, "digital", "9780000000001");
      await release(standard, "physical", "9780000000009", "hidden");
      const print = await release(standard, "physical", "9780000000002");
      const bare = await release(standard, "physical");
      const other = await edition(2);
      const otherBare = await release(other, "digital");
      const lonely = await release(await edition(3, false), "physical");

      const cache = coverIsbnCache(ctx);
      expect(await coverIsbnForRelease(ctx, ebook, cache)).toBe("9780000000001");
      expect(await coverIsbnForRelease(ctx, bare, cache)).toBe("9780000000002");
      expect(await coverIsbnForRelease(ctx, print)).toBe("9780000000002");
      expect(await coverIsbnForRelease(ctx, otherBare, cache)).toBe("9780000000002");
      expect(await coverIsbnForRelease(ctx, lonely, cache)).toBeNull();
    });
  });
});
