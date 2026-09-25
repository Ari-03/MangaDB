import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

async function seeded() {
  const t = convexTest(schema);
  const ids = await t.mutation(internal.seed.run, {});
  return { t, ids };
}

describe("seed.run", () => {
  it("allocates per-entity sequential public IDs from the counters table", async () => {
    const { t } = await seeded();
    await t.run(async (ctx) => {
      const tablesByEntity = {
        series: "series",
        volume: "volumes",
        edition: "editions",
      } as const;
      for (const [entity, table] of Object.entries(tablesByEntity) as Array<
        [keyof typeof tablesByEntity, (typeof tablesByEntity)[keyof typeof tablesByEntity]]
      >) {
        const docs = await ctx.db.query(table).collect();
        const ids = docs.map((doc) => doc.publicId).sort((a, b) => a - b);
        // Consecutive 1..N with no gaps or duplicates.
        expect(ids).toEqual(ids.map((_, i) => i + 1));
        const counter = await ctx.db
          .query("counters")
          .withIndex("by_entity", (q) => q.eq("entity", entity))
          .unique();
        expect(counter?.next).toBe(ids.length + 1);
      }
      const bundles = await ctx.db.query("releaseBundles").collect();
      expect(bundles.map((b) => b.publicId)).toEqual([1]);
    });
  });

  it("creates the representative corners: family, omnibus, partial coverage, variant, bundle", async () => {
    const { t } = await seeded();
    await t.run(async (ctx) => {
      // Series Family with a typed relationship edge.
      const relationships = await ctx.db.query("seriesRelationships").collect();
      expect(relationships).toHaveLength(1);
      expect(relationships[0]?.type).toBe("sequel");

      // An omnibus Edition: one Edition covering three Volumes completely,
      // in an Edition Line with a line position.
      const coverages = await ctx.db.query("volumeCoverages").collect();
      const byEdition = new Map<Id<"editions">, number>();
      for (const cov of coverages) {
        byEdition.set(cov.editionId, (byEdition.get(cov.editionId) ?? 0) + 1);
      }
      const omnibusEditionId = [...byEdition.entries()].find(([, n]) => n === 3)?.[0];
      expect(omnibusEditionId).toBeDefined();
      const omnibus = omnibusEditionId ? await ctx.db.get(omnibusEditionId) : null;
      expect(omnibus?.editionLineId).toBeDefined();
      expect(omnibus?.linePosition).toBe("1");

      // A partial Coverage with its note.
      const partial = coverages.filter((cov) => cov.extent === "partial");
      expect(partial).toHaveLength(1);
      expect(partial[0]?.note).toBeTruthy();

      // A Release Variant and a Release Bundle pinning it.
      const variants = await ctx.db.query("releaseVariants").collect();
      expect(variants).toHaveLength(1);
      const memberships = await ctx.db.query("bundleMemberships").collect();
      expect(memberships).toHaveLength(4);
      expect(memberships.filter((m) => m.variantId)).toHaveLength(1);
    });
  });

  it("refuses to run on a non-empty catalog unless wiping, and reseeds from 1 after a wipe", async () => {
    const { t } = await seeded();
    await expect(t.mutation(internal.seed.run, {})).rejects.toThrow(/wipe/);
    const ids = await t.mutation(internal.seed.run, { wipe: true });
    expect(ids.seriesPublicIds.tokyoGhoul).toBe(1);
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.filter((s) => s.publicId === 1)).toHaveLength(1);
    });
  });
});

describe("releases.monthBrowse over the seed", () => {
  it("populates the current month's browser window, day-TBA included", async () => {
    const { t } = await seeded();
    const now = new Date();
    const result = await t.query(api.releases.monthBrowse, {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    });
    // Quiet Cartographer Vol 4 (physical + digital), Tokyo Ghoul:re Vol 3
    // (physical + a month-precision digital date).
    expect(result.releases).toHaveLength(4);
    expect(result.releases.filter((r) => r.day === null)).toHaveLength(1);
    expect(
      result.releases.map((r) => [r.series[0]?.title, r.volumeLabel, r.format]),
    ).toEqual(
      expect.arrayContaining([
        ["The Quiet Cartographer", "Vol. 4", "physical"],
        ["The Quiet Cartographer", "Vol. 4", "digital"],
        ["Tokyo Ghoul:re", "Vol. 3", "physical"],
        ["Tokyo Ghoul:re", "Vol. 3", "digital"],
      ]),
    );
    // Both filters over the same window (spec §10: shared in both views).
    const filtered = await t.query(api.releases.monthBrowse, {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      format: "physical",
      publisher: "seven-seas",
    });
    expect(
      filtered.releases.map((r) => [r.volumeLabel, r.publisher?.slug]),
    ).toEqual([["Vol. 4", "seven-seas"]]);
  });
});

describe("catalog.seriesPage over the seed", () => {
  it("renders Tokyo Ghoul as the Reading Path: canonical order, distinct label, family", async () => {
    const { t, ids } = await seeded();
    const page = await t.query(api.catalog.seriesPage, {
      publicId: ids.seriesPublicIds.tokyoGhoul,
    });
    expect(page).not.toBeNull();
    if (!page) return;

    // Canonical Volume sequence in Position order; Position 4 wears the
    // display-only Label "3.5".
    expect(page.volumes.map((v) => v.position)).toEqual([1, 2, 3, 4]);
    expect(page.volumes.map((v) => v.label)).toEqual(["1", "2", "3", "3.5"]);

    // Family with both member Series and the rendered sequel edge.
    expect(page.family?.name).toBe("Tokyo Ghoul");
    expect(page.family?.members.map((m) => m.title)).toEqual([
      "Tokyo Ghoul",
      "Tokyo Ghoul:re",
    ]);
    expect(page.family?.relationships).toEqual([
      expect.objectContaining({
        type: "sequel",
        from: expect.objectContaining({ title: "Tokyo Ghoul:re" }),
        to: expect.objectContaining({ title: "Tokyo Ghoul" }),
      }),
    ]);

    // Two reading paths: the standard run leads, the "Monster Edition"
    // omnibus line follows with its coverage of Volumes 1-3.
    expect(page.editionGroups.map((g) => [g.kind, g.name])).toEqual([
      ["standard", "Standard edition"],
      ["line", "Monster Edition"],
    ]);
    const omnibus = page.editionGroups[1]?.books[0];
    expect(omnibus?.linePosition).toBe("1");
    expect(omnibus?.coverage.map((c) => c.position)).toEqual([1, 2, 3]);

    // The split digital edition sits in the standard path, covering Volume
    // 3.5 partially.
    const split = page.editionGroups[0]?.books.find((b) =>
      b.coverage.some((c) => c.extent === "partial"),
    );
    expect(split?.coverage.map((c) => c.position)).toEqual([4]);
    // The first standard book fronts the Series.
    expect(page.editionGroups[0]?.books[0]?.coverage[0]?.position).toBe(1);
  });

  it("keeps a simple Series free of family, line, variant, and bundle concepts", async () => {
    const { t, ids } = await seeded();
    const page = await t.query(api.catalog.seriesPage, {
      publicId: ids.seriesPublicIds.quietCartographer,
    });
    expect(page).not.toBeNull();
    if (!page) return;
    expect(page.family).toBeNull();
    // One standard path, no Edition Line.
    expect(page.editionGroups.map((g) => g.kind)).toEqual(["standard"]);
    for (const book of page.editionGroups[0]?.books ?? []) {
      expect(book.lineName).toBeNull();
      expect(book.linePosition).toBeNull();
    }
  });

  it("serves the oneshot as one unnumbered Volume", async () => {
    const { t, ids } = await seeded();
    const page = await t.query(api.catalog.seriesPage, {
      publicId: ids.seriesPublicIds.oneRainyEvening,
    });
    expect(page?.volumes).toHaveLength(1);
    expect(page?.volumes[0]?.label).toBeNull();
    expect(page?.family).toBeNull();
  });
});
