// The dev seed (seed.ts): it allocates public ids from the counters, refuses
// any catalog that is not empty, dates a live month window from the clock,
// and leaves a browsable catalog. These tests pin what the app, the
// dev workflow and docs/operations.md rely on, not every row the seed holds.

import { describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { makeT } from "./test.helpers";

async function seeded() {
  const t = makeT();
  const ids = await t.mutation(internal.seed.run, {});
  return { t, ids };
}

describe("seed.run", () => {
  it("allocates per-entity sequential public IDs from the counters table and builds the documented corners", async () => {
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

      // The corners docs/operations.md promises: a box set of four with its
      // Volume 1 member pinned to the one Variant, which belongs to that
      // member's Release, a partial Coverage with its note, a oneshot whose
      // Volume has no Label, and a plain Series with no family or line.
      const variants = await ctx.db.query("releaseVariants").collect();
      expect(variants).toHaveLength(1);
      const memberships = await ctx.db.query("bundleMemberships").collect();
      expect(memberships.map((m) => m.variantId)).toEqual([variants[0]!._id, undefined, undefined, undefined]);
      expect(variants[0]!.releaseId).toBe(memberships[0]!.releaseId);
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(1);
      const series = await ctx.db.query("series").collect();
      expect(series.filter((s) => s.familyId === undefined).map((s) => s.title)).toEqual([
        "The Quiet Cartographer",
        "One Rainy Evening",
      ]);
      const coverages = await ctx.db.query("volumeCoverages").collect();
      expect(coverages.filter((c) => c.extent === "partial").map((c) => Boolean(c.note))).toEqual([true]);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.filter((v) => v.label === undefined)).toHaveLength(1);
    });
  });

  it("refuses a second run and leaves the seeded catalog as it was", async () => {
    const { t } = await seeded();
    const snapshot = () =>
      t.run(async (ctx) => ({
        series: await ctx.db.query("series").collect(),
        releases: await ctx.db.query("releases").collect(),
        counters: await ctx.db.query("counters").collect(),
      }));
    const before = await snapshot();
    await expect(t.mutation(internal.seed.run, {})).rejects.toThrow(/already has data/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a partly populated catalog with no Series and writes nothing", async () => {
    const t = makeT();
    await t.run((ctx) =>
      ctx.db.insert("publishers", { status: "active", name: "VIZ Media", slug: "viz-media" }),
    );
    await expect(t.mutation(internal.seed.run, {})).rejects.toThrow(/publishers is not empty/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("publishers").collect()).toHaveLength(1);
      expect(await ctx.db.query("series").collect()).toEqual([]);
      expect(await ctx.db.query("counters").collect()).toEqual([]);
    });
  });

  it("has no wipe option", async () => {
    const { t } = await seeded();
    // @ts-expect-error The validator accepts no arguments.
    await expect(t.mutation(internal.seed.run, { wipe: true })).rejects.toThrow(/Unexpected field `wipe`/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(4);
    });
  });
});

describe("releases.monthBrowse over the seed", () => {
  it("dates a live window around the current month, day-TBA included", async () => {
    // A pinned January clock: the previous month falls in the year before,
    // and a month boundary cannot pass between the seed and the queries.
    // Only Date is faked, so convex-test keeps its real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
    try {
      const { t } = await seeded();
      const month = (year: number, month: number) => t.query(api.releases.monthBrowse, { year, month });
      const current = await month(2027, 1);
      // Quiet Cartographer Vol. 4 in both formats, Tokyo Ghoul:re Vol. 3
      // in print and with a day-TBA digital date.
      expect(current.releases).toHaveLength(4);
      expect(current.releases.filter((r) => r.day === null)).toHaveLength(1);
      // Neighbours for the browser's prev/next navigation.
      expect((await month(2026, 12)).releases.length).toBeGreaterThan(0);
      expect((await month(2027, 2)).releases.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("catalog.seriesPage over the seed", () => {
  // The only Series page with a rendered family edge and an Edition Line
  // path side by side; catalog.test.ts builds neither.
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
