// The matching ladder (ticket #35, spec §6): pure text rules, then the
// database rungs against a hand-built catalog. Rung ① (the stored link) is
// the adapter's fast path and is covered by the reconcile tests.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  labelsEqual,
  matchRelease,
  normalizeTitle,
  titlesSimilar,
  type ReleaseFact,
} from "./matching";

describe("normalizeTitle", () => {
  it("strips discriminators, case, and punctuation", () => {
    expect(normalizeTitle("Alpha Adventures (Manga)")).toBe("alpha adventures");
    expect(normalizeTitle("ALPHA — Adventures!")).toBe("alpha adventures");
    expect(normalizeTitle("  Alpha   Adventures ")).toBe("alpha adventures");
    expect(normalizeTitle("Björk & Ödipus, Vol")).toBe("björk ödipus vol");
  });
});

describe("titlesSimilar", () => {
  it("accepts titles sharing most tokens, rejects disjoint ones", () => {
    expect(titlesSimilar("Alpha Adventures", "Alpha Adventures (Manga)")).toBe(true);
    expect(titlesSimilar("Alpha Adventures", "Completely Different Zeta")).toBe(false);
  });
});

describe("labelsEqual", () => {
  it("compares trimmed strings and numeric forms", () => {
    expect(labelsEqual("7", "7")).toBe(true);
    expect(labelsEqual("07", "7")).toBe(true);
    expect(labelsEqual("7.5", "7.5")).toBe(true);
    expect(labelsEqual("7", "8")).toBe(false);
    expect(labelsEqual(undefined, null)).toBe(true);
    expect(labelsEqual("Side Story", null)).toBe(false);
  });
});

// ---------- the database rungs ----------

// Named factory so helper params keep the schema-typed TestConvex.
const makeT = () => convexTest(schema);
type TestT = ReturnType<typeof makeT>;

type Catalog = {
  publisherId: Id<"publishers">;
  seriesId: Id<"series">;
  releaseId: Id<"releases">;
};

/** publisher → series → volume "1" → single-coverage edition → release. */
async function buildCatalog(
  t: TestT,
  overrides: Partial<{
    seriesTitle: string;
    label: string;
    format: "physical" | "digital";
    isbn13: string;
    locked: boolean;
    overriddenFields: string[];
    publisherSlug: string;
  }> = {},
): Promise<Catalog> {
  return await t.run(async (ctx) => {
    const slug = overrides.publisherSlug ?? "seven-seas";
    const existing = await ctx.db
      .query("publishers")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    const publisherId =
      existing?._id ??
      (await ctx.db.insert("publishers", {
        status: "active",
        name: slug,
        slug,
      }));
    const title = overrides.seriesTitle ?? "Alpha Adventures";
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: Math.floor(Math.random() * 1e9),
      title,
      altTitles: [],
      searchText: title,
    });
    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      publicId: Math.floor(Math.random() * 1e9),
      seriesId,
      position: 1,
      label: overrides.label ?? "1",
    });
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: Math.floor(Math.random() * 1e9),
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId,
      volumeId,
      order: 1,
      extent: "complete",
    });
    const releaseId = await ctx.db.insert("releases", {
      status: "active",
      editionId,
      format: overrides.format ?? "physical",
      language: "en",
      isbn13: overrides.isbn13,
      locked: overrides.locked,
      overriddenFields: overrides.overriddenFields,
      publisherId,
      seriesIds: [seriesId],
    });
    return { publisherId, seriesId, releaseId };
  });
}

const fact = (
  publisherId: Id<"publishers"> | null,
  overrides: Partial<ReleaseFact> = {},
): ReleaseFact => ({
  seriesTitle: "Alpha Adventures (Manga)",
  volumeLabel: "1",
  multiVolume: false,
  format: "physical",
  publisherId,
  ...overrides,
});

const match = (t: TestT, f: ReleaseFact) =>
  t.run((ctx) => matchRelease(ctx, f));

describe("matchRelease — rung ② (ISBN-13 + title sanity)", () => {
  it("matches on ISBN when titles agree, outranking rung ③", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { isbn13: "9781999000103" });
    const outcome = await match(
      t,
      fact(catalog.publisherId, { isbn13: "9781999000103" }),
    );
    expect(outcome).toMatchObject({ kind: "match", rung: 2 });
  });

  it("flags an ISBN hit with a dissimilar title for review — never merges", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, {
      seriesTitle: "Completely Different Zeta",
      isbn13: "9781999000103",
    });
    const outcome = await match(
      t,
      fact(catalog.publisherId, { isbn13: "9781999000103" }),
    );
    expect(outcome).toMatchObject({ kind: "review", rung: 2 });
  });
});

describe("matchRelease — rung ③ (publisher + title + label + format)", () => {
  it("auto-matches exactly one full-key candidate", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t);
    const outcome = await match(t, fact(catalog.publisherId));
    expect(outcome).toMatchObject({
      kind: "match",
      rung: 3,
      release: { _id: catalog.releaseId },
    });
  });

  it("matches numerically equal labels and normalized titles", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { label: "01" });
    const outcome = await match(t, fact(catalog.publisherId, { volumeLabel: "1" }));
    expect(outcome).toMatchObject({ kind: "match", rung: 3 });
  });

  it("two plausible candidates always queue — the importer never merges", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t);
    await buildCatalog(t); // a second identical-key candidate
    const outcome = await match(t, fact(catalog.publisherId));
    expect(outcome).toMatchObject({ kind: "review", rung: 3 });
  });

  it("a single candidate under an override or lock still reviews", async () => {
    const t = makeT();
    const overridden = await buildCatalog(t, { overriddenFields: ["pubDate"] });
    expect(await match(t, fact(overridden.publisherId))).toMatchObject({
      kind: "review",
      rung: 3,
    });

    const t2 = makeT();
    const locked = await buildCatalog(t2, { locked: true });
    expect(await match(t2, fact(locked.publisherId))).toMatchObject({
      kind: "review",
      rung: 3,
    });
  });
});

describe("matchRelease — rungs ④ and ⑤", () => {
  it("a title-only candidate (wrong publisher) always reviews", async () => {
    const t = makeT();
    await buildCatalog(t, { publisherSlug: "other-pub" });
    const sevenSeas = await t.run((ctx) =>
      ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas",
        slug: "seven-seas",
      }),
    );
    const outcome = await match(t, fact(sevenSeas));
    expect(outcome).toMatchObject({ kind: "review", rung: 4 });
  });

  it("a same-edition candidate differing only in format is a sibling — creation, not review", async () => {
    // Releases of one Edition differ exactly in Format/Binding (spec §2): a
    // publisher's digital counterpart of an existing print volume is a new
    // sibling Release, not ambiguity for a human to untangle.
    const t = makeT();
    const catalog = await buildCatalog(t, { format: "digital" });
    const outcome = await match(t, fact(catalog.publisherId));
    expect(outcome).toMatchObject({ kind: "create", rung: 5 });
  });

  it("no plausible candidate at all goes to the creation path", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t);
    // Same series, but volume 2 does not exist yet: create.
    expect(
      await match(t, fact(catalog.publisherId, { volumeLabel: "2" })),
    ).toMatchObject({ kind: "create", rung: 5 });
    // A wholly unknown series: create.
    expect(
      await match(t, fact(catalog.publisherId, { seriesTitle: "Brand New Thing" })),
    ).toMatchObject({ kind: "create", rung: 5 });
  });

  it("multi-volume facts skip rungs ③/④ — ISBN or the creation path", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t);
    const outcome = await match(
      t,
      fact(catalog.publisherId, { volumeLabel: null, multiVolume: true }),
    );
    expect(outcome).toMatchObject({ kind: "create", rung: 5 });
  });
});
