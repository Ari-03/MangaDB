import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { makeT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import { insertPublisher, insertSeries, insertVolume, insertObservation } from "./test.factories";
import { readObservationBook } from "./printings";
const cases = [
  {
    name: "barefoot",
    snapshot: {
      annId: "47095",
      date: {
        day: 1,
        month: 7,
        year: 2018,
      },
      editionLineHint: false,
      format: "physical",
      isbn13: "9780867198379",
      kind: "annRelease",
      label: "7",
      mangaId: "2713",
      multi: false,
      page: {
        date: {
          day: 1,
          month: 7,
          year: 2018,
        },
        distributor: "Last Gasp Publishing",
        distributorId: "1746",
        fetchedAt: 1790501866305,
        isbn10: "0867198370",
        isbn13: "9780867198379",
        mangaId: "2713",
        priceCents: 2500,
        status: "ok",
        title: "Barefoot Gen - Bones Into Dust [Hardcover]",
        volume: "GN 7 / 10",
      },
      title: "Barefoot Gen - Bones Into Dust [Hardcover]",
      url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=47095",
    },
    parent: {
      kind: "annManga",
      id: "2713",
      title: "Barefoot Gen",
    },
    seriesTitle: "Barefoot Gen",
    altTitles: ["Hadashi no Gen", "はだしのゲン"],
    publisher: "Last Gasp",
    binding: "hardcover",
    evidenceUrls: ["https://lastgasp.com/products/barefoot-gen-vol-7"],
  },
  {
    name: "fushigi",
    snapshot: {
      annId: "20384",
      date: {
        day: 11,
        month: 3,
        year: 2004,
      },
      editionLineHint: false,
      format: "physical",
      isbn13: "9781591161387",
      kind: "annRelease",
      label: "10",
      mangaId: "1539",
      multi: false,
      page: {
        date: {
          day: 11,
          month: 3,
          year: 2004,
        },
        distributor: "Viz Media",
        distributorId: "4552",
        fetchedAt: 1790490960746,
        isbn10: "159116138X",
        isbn13: "9781591161387",
        mangaId: "1539",
        priceCents: 995,
        status: "ok",
        title: "Fushigi Yûgi - Enemy",
        volume: "GN 10 / 18",
      },
      title: "Fushigi Yûgi - Enemy",
      url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=20384",
    },
    parent: {
      kind: "annManga",
      id: "1539",
      title: "Fushigi Yûgi",
    },
    seriesTitle: "Fushigi Yûgi",
    altTitles: ["Quyển sách kỳ bí (Vietnamese)", "The Mysterious Play", "ふしぎ遊戯"],
    publisher: "VIZ Media",
    binding: "paperback",
    evidenceUrls: [
      "https://www.viz.com/manga-books/manga/fushigi-yugi-volume-10-0/product/64/paperback",
    ],
  },
] as const;
describe("reviewed ANN book subtitles from retained staging records", () => {
  for (const row of cases)
    it(row.name, async () => {
      const t = makeT();
      const ids = await t.run(async (ctx) => {
        const publisherId = await insertPublisher(ctx, { name: row.publisher, slug: row.name });
        const seriesId = await insertSeries(ctx, {
          title: row.seriesTitle,
          altTitles: [...row.altTitles],
        });
        const volumeId = await insertVolume(ctx, {
          seriesId,
          label: row.snapshot.label,
          position: Number(row.snapshot.label),
        });
        const { releaseId, editionId } = await insertBook(ctx, {
          publisherId,
          seriesId,
          volumeId,
          release: { isbn13: row.snapshot.isbn13, binding: row.binding },
        });
        const parentId = await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `manga:${row.snapshot.mangaId}`,
          snapshot: row.parent,
          recordRef: { type: "series", id: seriesId },
        });
        const observationId = await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${row.snapshot.annId}`,
          snapshot: row.snapshot,
        });
        await ctx.db.insert("placementHolds", {
          observationId,
          sourceKey: "ann",
          kind: "isbn",
          seriesId,
          heldAt: 1,
        });
        return { publisherId, seriesId, volumeId, releaseId, editionId, parentId, observationId };
      });
      const args = {
        observationId: ids.observationId,
        target: { type: "release" as const, id: ids.releaseId },
        reviewed: {
          isbn13: row.snapshot.isbn13,
          seriesId: ids.seriesId,
          publisherId: ids.publisherId,
          volumeIds: [ids.volumeId],
          evidenceUrls: [...row.evidenceUrls],
          sourceTitle: row.snapshot.title,
        },
      };
      const raw = await t.run(async (ctx) =>
        readObservationBook(ctx, (await ctx.db.get(ids.observationId))!, [
          (await ctx.db.get(ids.seriesId))!,
        ]),
      );
      expect(raw.work).toContain(row.name === "barefoot" ? "Bones Into Dust" : "Enemy");
      const ordinary = await t.query(internal.heldBooks.previewInternal, {
        observationId: ids.observationId,
        target: args.target,
      });
      expect(ordinary.refusal).toBeTruthy();
      const reviewed = await t.query(internal.heldBooks.previewInternal, args);
      expect(reviewed.refusal).toBeNull();
      expect(reviewed.classification).toBe("linkReady");
      expect(reviewed.expected).toBeTruthy();
      expect(
        (
          await t.query(internal.heldBooks.previewInternal, {
            ...args,
            reviewed: { ...args.reviewed, sourceTitle: undefined },
          })
        ).refusal,
      ).toBeTruthy();
      if (row.name === "barefoot") {
        await t.run((ctx) =>
          ctx.db.patch(ids.releaseId, {
            binding: row.binding === "hardcover" ? "paperback" : "hardcover",
          }),
        );
        expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toContain(
          "binding",
        );
        await t.run((ctx) => ctx.db.patch(ids.releaseId, { binding: row.binding }));
      }
      expect(
        (
          await t.query(internal.heldBooks.previewInternal, {
            ...args,
            reviewed: { ...args.reviewed, evidenceUrls: [] },
          })
        ).refusal,
      ).toBeTruthy();
      await t.run((ctx) => ctx.db.patch(ids.releaseId, { format: "digital" }));
      expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toContain("format");
      await t.run((ctx) => ctx.db.patch(ids.releaseId, { format: "physical" }));
      for (const suffix of ["Part 2", "Episode 2", "Novel", "Vol. 99", "[1-3]"]) {
        const title = `${row.seriesTitle} - ${suffix}`;
        await t.run((ctx) =>
          ctx.db.patch(ids.observationId, {
            snapshot: { ...row.snapshot, title, page: { ...row.snapshot.page, title } },
          }),
        );
        expect(
          (
            await t.query(internal.heldBooks.previewInternal, {
              ...args,
              reviewed: { ...args.reviewed, sourceTitle: title },
            })
          ).refusal,
          suffix,
        ).toBeTruthy();
      }
      await t.run((ctx) => ctx.db.patch(ids.observationId, { snapshot: row.snapshot }));
      const differentTitle = "Other Work - Enemy";
      await t.run((ctx) =>
        ctx.db.patch(ids.observationId, {
          snapshot: {
            ...row.snapshot,
            title: differentTitle,
            page: { ...row.snapshot.page, title: differentTitle },
          },
        }),
      );
      expect(
        (
          await t.query(internal.heldBooks.previewInternal, {
            ...args,
            reviewed: { ...args.reviewed, sourceTitle: differentTitle },
          })
        ).refusal,
      ).toBeTruthy();
      await t.run((ctx) => ctx.db.patch(ids.observationId, { snapshot: row.snapshot }));
      await t.run((ctx) => ctx.db.patch(ids.parentId, { withdrawn: true }));
      expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toContain("parent");
    });
});
