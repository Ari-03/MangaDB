// The shared import pipeline (lib/pipeline.ts) below the adapters: Volume
// Position rules, publisher resolution (duplicates, imprints, merges), and
// the packaging creation paths — Edition Line members covering real
// Volumes and box sets as Release Bundles.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import schema from "../schema";
import { upsertObservation } from "./observations";
import {
  createCanonicalRecords,
  createReleaseBundle,
  ensurePublisher,
  findPublisherByName,
  volumePositionFor,
} from "./pipeline";

const makeT = () => convexTest(schema);

const CITATION = {
  sourceName: "Test Source",
  url: "https://example.org/record",
};

async function observation(ctx: MutationCtx, sourceRecordId: string) {
  const { observation } = await upsertObservation(ctx, {
    sourceKey: "prh",
    sourceRecordId,
    snapshot: { kind: "test", id: sourceRecordId },
    now: 1,
  });
  return observation;
}

async function publisher(
  ctx: MutationCtx,
  name: string,
  slug: string,
  extra: { status?: "active" | "merged"; mergedIntoId?: Id<"publishers"> } = {},
) {
  return await ctx.db.insert("publishers", {
    status: "active",
    name,
    slug,
    ...extra,
  });
}

async function series(ctx: MutationCtx, title: string, labels: string[]) {
  const seriesId = await ctx.db.insert("series", {
    status: "active",
    publicId: 1,
    title,
    altTitles: [],
    searchText: title,
  });
  for (const [i, label] of labels.entries()) {
    await ctx.db.insert("volumes", {
      status: "active",
      publicId: i + 1,
      seriesId,
      position: Number(label),
      label,
    });
  }
  return seriesId;
}

describe("volumePositionFor", () => {
  it("uses the volume number itself, so gaps show missing volumes", () => {
    expect(volumePositionFor("7", new Set([1, 2]))).toBe(7);
    expect(volumePositionFor("0", new Set([1, 2]))).toBe(0);
    expect(volumePositionFor("7.5", new Set([7, 8]))).toBe(7.5);
  });

  it("sorts an unnumbered volume after the last whole number, never on the next one", () => {
    expect(volumePositionFor(undefined, new Set())).toBe(1);
    expect(volumePositionFor(undefined, new Set([1, 2, 5]))).toBe(5.5);
    expect(volumePositionFor("Side Story", new Set([1, 2, 5, 5.5]))).toBe(5.75);
    // A taken number lands just after itself.
    expect(volumePositionFor("3", new Set([3]))).toBe(3.5);
  });
});

describe("createCanonicalRecords — Volumes", () => {
  it("stores canonical labels at their number and dedupes within one call", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const obs = await observation(ctx, "a");
      const result = await createCanonicalRecords(ctx, {
        sourceKey: "prh",
        observation: obs,
        citation: CITATION,
        importComment: "test",
        seriesId: null,
        seriesTitle: "Otherside Picnic",
        labels: ["05", "0", "5", "7.5"],
        tagBootstrapUnreviewed: false,
        now: 1,
      });
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", result.seriesId))
        .collect();
      expect(volumes.map((v) => [v.label, v.position])).toEqual([
        ["0", 0],
        ["5", 5],
        ["7.5", 7.5],
      ]);
      // "05" and "5" are one Volume.
      expect(result.volumeIds[0]).toBe(result.volumeIds[2]);
    });
  });

  it("creates a Series with no placeholder Volume when asked for the Series only", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const result = await createCanonicalRecords(ctx, {
        sourceKey: "ann",
        observation: await observation(ctx, "omnibus-only"),
        citation: CITATION,
        importComment: "test",
        seriesId: null,
        seriesTitle: "Homunculus",
        labels: [],
        seriesOnly: true,
        tagBootstrapUnreviewed: true,
        now: 1,
      });
      expect(result.volumeIds).toEqual([]);
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
    });
  });
});

describe("publisher resolution", () => {
  it("resolves duplicates exactly before any prefix, and imprints to their own row", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      // The historical PRH duplicate row, not yet merged.
      await publisher(ctx, "Kodansha Comics", "kodansha-comics");
      const sevenSeas = await publisher(
        ctx,
        "Seven Seas Entertainment",
        "seven-seas",
      );
      const ghostShip = await publisher(ctx, "Ghost Ship", "ghost-ship");
      const squareEnix = await publisher(ctx, "Square Enix", "square-enix");
      await publisher(ctx, "Square Enix Manga", "square-enix-manga");

      expect((await findPublisherByName(ctx, "Kodansha Comics"))?._id).toBe(
        kodansha,
      );
      expect((await findPublisherByName(ctx, "Kodansha"))?._id).toBe(kodansha);
      expect((await findPublisherByName(ctx, "Square Enix Manga"))?._id).toBe(
        squareEnix,
      );
      expect((await findPublisherByName(ctx, "Ghost Ship"))?._id).toBe(
        ghostShip,
      );
      expect((await findPublisherByName(ctx, "Seven Seas"))?._id).toBe(
        sevenSeas,
      );
      expect(
        (await findPublisherByName(ctx, "Seven Seas Entertainment, LLC"))?._id,
      ).toBe(sevenSeas);
      expect(
        (await findPublisherByName(ctx, "Kodansha USA Publishing"))?._id,
      ).toBe(kodansha);
      expect(await findPublisherByName(ctx, "NASA")).toBeNull();
    });
  });

  it("follows a merged row to its survivor", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const darkHorse = await publisher(ctx, "Dark Horse", "dark-horse");
      await publisher(ctx, "Dark Horse Manga", "dark-horse-manga", {
        status: "merged",
        mergedIntoId: darkHorse,
      });
      const oddball = await publisher(ctx, "Oddball", "oddball");
      await publisher(ctx, "Oddball Press", "oddball-press", {
        status: "merged",
        mergedIntoId: oddball,
      });
      expect((await findPublisherByName(ctx, "Dark Horse Manga"))?._id).toBe(
        darkHorse,
      );
      expect((await findPublisherByName(ctx, "Oddball Press"))?._id).toBe(
        oddball,
      );
      // Creation never lands on the merged row either.
      expect(
        (
          await ensurePublisher(ctx, {
            name: "Oddball Press",
            slug: "oddball-press",
          })
        ).id,
      ).toBe(oddball);
      expect(
        (
          await ensurePublisher(ctx, {
            name: "Dark Horse Manga",
            slug: "dark-horse-manga",
          })
        ).id,
      ).toBe(darkHorse);
    });
  });

  it("creates an imprint row under its existing parent", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const tokyopop = await publisher(ctx, "Tokyopop", "tokyopop");
      const created = await ensurePublisher(ctx, {
        name: "TOKYOPOP LoveLove",
        slug: "tokyopop-lovelove",
        parentSlug: "tokyopop",
      });
      expect(created.created).toBe(true);
      expect((await ctx.db.get(created.id))?.parentPublisherId).toBe(tokyopop);
    });
  });
});

describe("createCanonicalRecords — Edition Lines", () => {
  it("puts an omnibus in the base Series' line, covering the real Volumes", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Noragami", ["19", "20"]);
      const physical = await createCanonicalRecords(ctx, {
        sourceKey: "prh",
        observation: await observation(ctx, "9781646519026"),
        citation: CITATION,
        importComment: "test",
        seriesId,
        seriesTitle: "Noragami",
        labels: ["19", "20", "21"],
        editionLine: { name: "Omnibus", position: "7" },
        release: {
          format: "physical",
          isbn13: "9781646519026",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
        tagBootstrapUnreviewed: true,
        now: 1,
      });
      // The digital release of the same omnibus joins its Edition.
      const digital = await createCanonicalRecords(ctx, {
        sourceKey: "prh",
        observation: await observation(ctx, "9781646519033"),
        citation: CITATION,
        importComment: "test",
        seriesId,
        seriesTitle: "Noragami",
        labels: ["19", "20", "21"],
        editionLine: { name: "Omnibus", position: "7" },
        release: {
          format: "digital",
          isbn13: "9781646519033",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
        tagBootstrapUnreviewed: true,
        now: 1,
      });
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ seriesId, name: "Omnibus" }]);
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      expect(editions[0]).toMatchObject({
        editionLineId: lines[0]!._id,
        linePosition: "7",
      });
      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", editions[0]!._id))
        .collect();
      const labels = await Promise.all(
        coverage.map(async (row) => (await ctx.db.get(row.volumeId))?.label),
      );
      expect(labels).toEqual(["19", "20", "21"]);
      // Only Volume 21 was missing; the omnibus never became a Volume "7".
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["19", "20", "21"]);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.editionId)).toEqual([
        editions[0]!._id,
        editions[0]!._id,
      ]);
      expect(physical.releaseId).not.toBe(digital.releaseId);
    });
  });

  it("never files a single volume and an omnibus under one Edition", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Ichi the Killer", []);
      const release = (isbn13: string) => ({
        format: "physical" as const,
        isbn13,
        publisher: { name: "Kodansha", slug: "kodansha" },
      });
      const base = {
        sourceKey: "prh",
        citation: CITATION,
        importComment: "test",
        seriesId,
        seriesTitle: "Ichi the Killer",
        tagBootstrapUnreviewed: false,
        now: 1,
      };
      await createCanonicalRecords(ctx, {
        ...base,
        observation: await observation(ctx, "single"),
        labels: ["1"],
        release: release("9780000000002"),
      });
      await createCanonicalRecords(ctx, {
        ...base,
        observation: await observation(ctx, "omnibus"),
        labels: ["1", "2"],
        editionLine: { name: "Omnibus", position: "1" },
        release: release("9780000000019"),
      });
      expect(await ctx.db.query("editions").collect()).toHaveLength(2);
    });
  });

  it("refuses packaging without covered Volumes", async () => {
    const t = makeT();
    await expect(
      t.run(async (ctx) => {
        await createCanonicalRecords(ctx, {
          sourceKey: "prh",
          observation: await observation(ctx, "negima-omnibus-4"),
          citation: CITATION,
          importComment: "test",
          seriesId: null,
          seriesTitle: "Negima!",
          labels: [],
          editionLine: { name: "Omnibus", position: "4" },
          tagBootstrapUnreviewed: true,
          now: 1,
        });
      }),
    ).rejects.toThrow(/packaging never becomes a Volume/);
  });
});

describe("createReleaseBundle", () => {
  it("bundles the existing member Releases and is idempotent by ISBN", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      for (const label of ["1", "2"]) {
        await createCanonicalRecords(ctx, {
          sourceKey: "prh",
          observation: await observation(ctx, `vol-${label}`),
          citation: CITATION,
          importComment: "test",
          seriesId,
          seriesTitle: "Fire Force",
          labels: [label],
          release: {
            format: "physical",
            isbn13: `97800000000${label === "1" ? "02" : "19"}`,
            publisher: { name: "Kodansha", slug: "kodansha" },
          },
          tagBootstrapUnreviewed: false,
          now: 1,
        });
      }
      const box = {
        sourceKey: "prh",
        citation: CITATION,
        importComment: "test",
        seriesId,
        name: "Fire Force Manga Box Set 1 (Vol. 1-6)",
        labels: ["1", "2", "3", "4", "5", "6"],
        publisher: { name: "Kodansha", slug: "kodansha" },
        release: { format: "physical" as const, isbn13: "9798888772584" },
        tagBootstrapUnreviewed: true,
        now: 1,
      };
      const first = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "9798888772584"),
      });
      expect(first).toMatchObject({ created: true, members: 2 });
      const bundle = await ctx.db.get(first.bundleId);
      expect(bundle).toMatchObject({
        publisherId: kodansha,
        isbn13: "9798888772584",
      });
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(2);
      // The box never became a Release, a Volume, or a Series.
      expect(await ctx.db.query("releases").collect()).toHaveLength(2);
      expect(await ctx.db.query("series").collect()).toHaveLength(1);

      const again = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "9798888772584"),
      });
      expect(again).toMatchObject({ created: false, bundleId: first.bundleId });
      expect(await ctx.db.query("releaseBundles").collect()).toHaveLength(1);
    });
  });
});
