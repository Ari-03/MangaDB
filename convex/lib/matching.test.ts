// The matching ladder (ticket #35, spec §6): pure text rules, then the
// database rungs against a hand-built catalog. Rung ① (the stored link) is
// the adapter's fast path and is covered by the reconcile tests.

import { describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import {
  insertPublisher,
  insertSeries,
  seedCatalog,
  type CatalogOverrides,
} from "../test.factories";
import { makeT, type TestT } from "../test.helpers";
import {
  candidateSeries,
  hiddenSeriesTitled,
  labelsEqual,
  matchRelease,
  normalizeTitle,
  sameWorkTitle,
  titlesSimilar,
  type ReleaseFact,
} from "./matching";

describe("normalizeTitle", () => {
  it("strips discriminators, case, and punctuation", () => {
    expect(normalizeTitle("Alpha Adventures (Manga)")).toBe("alpha adventures");
    expect(normalizeTitle("ALPHA — Adventures!")).toBe("alpha adventures");
    expect(normalizeTitle("  Alpha   Adventures ")).toBe("alpha adventures");
    expect(normalizeTitle("Björk & Ödipus, Vol")).toBe("bjork and odipus vol");
  });

  // Real clean-title twins from the catalog audit.
  it("folds &/and, accents, apostrophes, a leading The, and entities", () => {
    const same = (a: string, b: string) => expect(normalizeTitle(a)).toBe(normalizeTitle(b));
    same("CANDY AND CIGARETTES", "Candy & Cigarettes");
    same("Pompo: The Cinephile", "Pompo: The Cinéphile");
    same("Saint Seiya: Saintia Sho", "Saint Seiya: Saintia Shō");
    same("The Skull Dragon's Precious Daughter", "Skull Dragon’s Precious Daughter");
    same("The Daily Lives of High School Boys", "Daily Lives of High School Boys");
    same(
      "Marrying the Dark Knight &amp;#40;For Her Money&amp;#41;",
      "Marrying the Dark Knight (For Her Money)",
    );
    same(
      "Let's Run an Inn on Dungeon Island! &lpar;In a World Ruled by Women&rpar;",
      "Let's Run an Inn on Dungeon Island!",
    );
  });

  it("keeps brackets inside a title: a spinoff is not its parent", () => {
    expect(normalizeTitle("Rent-A-(Really Shy!)-Girlfriend")).toBe("rent a really shy girlfriend");
    expect(normalizeTitle("Rent-A-(Really Shy!)-Girlfriend")).not.toBe(
      normalizeTitle("Rent-A-Girlfriend"),
    );
    expect(normalizeTitle("Dekoboko Sugar Days [Mou Ikkai!] (Manga)")).toBe("dekoboko sugar days");
  });

  it("keeps a title that is all brackets instead of emptying it", () => {
    expect(normalizeTitle("[Oshi No Ko]")).toBe("oshi no ko");
    expect(normalizeTitle("[Oshi No Ko] (Manga)")).toBe("oshi no ko");
  });

  it("keeps a novel distinct from its manga", () => {
    expect(normalizeTitle("Seraph of the End (Novel)")).not.toBe(
      normalizeTitle("Seraph of the End"),
    );
    expect(normalizeTitle("Her Royal Highness Seems to Be Angry (Light Novel)")).not.toBe(
      normalizeTitle("Her Royal Highness Seems to Be Angry (Manga)"),
    );
    expect(normalizeTitle("Bizenghast: The Novel")).not.toBe(normalizeTitle("Bizenghast"));
    // "Graphic novel" is a comics format, not prose.
    expect(normalizeTitle("Afro Samurai (Graphic Novel)")).toBe(normalizeTitle("Afro Samurai"));
  });
});

describe("titlesSimilar", () => {
  it("accepts titles sharing most tokens, rejects disjoint ones", () => {
    expect(titlesSimilar("Alpha Adventures", "Alpha Adventures (Manga)")).toBe(true);
    expect(titlesSimilar("Alpha Adventures", "Completely Different Zeta")).toBe(false);
    expect(titlesSimilar("Candy & Cigarettes", "CANDY AND CIGARETTES")).toBe(true);
  });

  it("never finds a novel similar to its manga", () => {
    expect(titlesSimilar("The Seven Deadly Sins", "The Seven Deadly Sins (Novel)")).toBe(false);
  });
});

describe("sameWorkTitle", () => {
  it.each([
    ["Citrus", "Citrus+"],
    ["E'S", "ES"],
    ["Bastard", "Bastard!!"],
    ["Doubt", "Doubt!!"],
    ["Dragon Ball", "Dragon Ball Z"],
    ["Kingdom Hearts", "Kingdom Hearts II"],
    ["Alpha", "Alpha 2"],
    ["Alpha", "Alpha (Light Novel)"],
    ["Alpha", "Alpha (Manga)"],
    ["Title", "Title (Side Story)"],
    ["Alpha", "The Alpha"],
    ["Alpha-Beta", "Alpha Beta"],
    ["Alpha-Beta", "AlphaBeta"],
    ["Alpha Beta", "AlphaBeta"],
    ["Alpha–Beta", "Alpha - Beta"],
    ["Alpha- Beta", "Alpha-Beta"],
    // The acute is an apostrophe, never a space or nothing.
    ["E´S", "ES"],
    ["E´S", "E S"],
    ["E&#180;S", "E S"],
    ["", ""],
    ["", "Alpha"],
  ])("keeps %s and %s apart", (a, b) => {
    expect(sameWorkTitle(a, b)).toBe(false);
    expect(sameWorkTitle(b, a)).toBe(false);
  });

  it.each([
    ["ALPHA", "alpha"],
    [" Alpha   Beta ", "Alpha Beta"],
    ["Candy &amp; Cigarettes", "Candy & Cigarettes"],
    ["Candy & Cigarettes", "Candy and Cigarettes"],
    ["E’S", "E'S"],
    ["E‘S", "E'S"],
    ["E`S", "E'S"],
    ["E´S", "E'S"],
    ["E&#180;S", "E'S"],
    ["E&#xB4;S", "E'S"],
    ["E&amp;apos;S", "E'S"],
    ["Fushigi Yûgi", "Fushigi Yugi"],
    ["Ａｌｐｈａ＋", "Alpha+"],
    ["Alpha–Beta", "Alpha-Beta"],
    ["Alpha—Beta", "Alpha-Beta"],
    ["Alpha – Beta", "Alpha - Beta"],
    ["Citrus+", "Citrus+"],
  ])("reads %s and %s as one work", (a, b) => {
    expect(sameWorkTitle(a, b)).toBe(true);
    expect(sameWorkTitle(b, a)).toBe(true);
  });

  it("leaves the looser search key as it was", () => {
    expect(normalizeTitle("E'S")).toBe(normalizeTitle("ES"));
    expect(normalizeTitle("Citrus+")).toBe(normalizeTitle("Citrus"));
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

/**
 * publisher → series "Alpha Adventures" → volume "1" → single-coverage
 * edition → release, under the "seven-seas" publisher unless another slug is
 * given; every chain in one test shares the publisher of its slug.
 */
const buildCatalog = (
  t: TestT,
  overrides: Omit<CatalogOverrides, "publisher"> & { publisher?: { slug: string } } = {},
) =>
  t.run((ctx) =>
    seedCatalog(ctx, {
      ...overrides,
      publisher: overrides.publisher ?? { slug: "seven-seas" },
      series: { title: "Alpha Adventures", ...overrides.series },
    }),
  );

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

const match = (t: TestT, f: ReleaseFact) => t.run((ctx) => matchRelease(ctx, f));

describe("matchRelease — rung ② (ISBN-13 + title sanity)", () => {
  it("matches on ISBN when titles agree, outranking rung ③", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { isbn13: "9781999000103" } });
    const outcome = await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }));
    expect(outcome).toMatchObject({ kind: "match", rung: 2 });
  });

  it("reviews an ISBN an Editor hid, and follows a merged Release to its survivor", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { isbn13: "9781999000103" } });
    await t.run((ctx) => ctx.db.patch(catalog.releaseId, { status: "hidden" }));
    expect(await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }))).toMatchObject({
      kind: "review",
      rung: 2,
      reason: expect.stringContaining("hid"),
    });

    const other = await buildCatalog(t, { release: { isbn13: "9781999000110" } });
    await t.run(async (ctx) => {
      await ctx.db.patch(catalog.releaseId, {
        status: "merged",
        mergedIntoId: other.releaseId,
      });
    });
    const outcome = await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }));
    expect(outcome).toMatchObject({ kind: "match", rung: 2 });
    expect(outcome.kind === "match" && outcome.release._id).toBe(other.releaseId);
  });

  it("reviews duplicate ISBNs even when only one candidate has a similar title", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { isbn13: "9781999000103" } });
    await buildCatalog(t, {
      release: { isbn13: "9781999000103" },
      series: { title: "Completely Different Zeta" },
    });

    expect(await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }))).toMatchObject({
      kind: "review",
      rung: 2,
      reason: expect.stringContaining("2 distinct active Releases"),
    });
  });

  it("deduplicates ISBN rows merged into the same active survivor", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { isbn13: "9781999000103" } });
    const duplicate = await buildCatalog(t, { release: { isbn13: "9781999000103" } });
    await t.run((ctx) =>
      ctx.db.patch(duplicate.releaseId, {
        status: "merged",
        mergedIntoId: catalog.releaseId,
      }),
    );

    const outcome = await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }));
    expect(outcome).toMatchObject({ kind: "match", rung: 2 });
    expect(outcome.kind === "match" && outcome.release._id).toBe(catalog.releaseId);
  });

  it("flags an ISBN hit with a dissimilar title for review — never merges", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t, {
      series: { title: "Completely Different Zeta" },
      release: { isbn13: "9781999000103" },
    });
    const outcome = await match(t, fact(catalog.publisherId, { isbn13: "9781999000103" }));
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
    const catalog = await buildCatalog(t, { volume: { label: "01" } });
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

  it("never accepts a candidate that already carries a different ISBN-13", async () => {
    // Citrus v4 vs Citrus Plus v4: a different ISBN is a different Release,
    // so the full key alone must not link — nor overwrite — the other book.
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { isbn13: "9781626922174" } });
    const outcome = await match(t, fact(catalog.publisherId, { isbn13: "9781638585268" }));
    expect(outcome).toMatchObject({ kind: "create", rung: 5 });
    // Without an ISBN on the fact, the full key still links.
    expect(await match(t, fact(catalog.publisherId))).toMatchObject({
      kind: "match",
      rung: 3,
    });
  });

  it("never auto-links a whole Volume onto a split part or a line's packaging (B06)", async () => {
    // An ISBN-less Part 1 of a split Volume 1 is not the full Volume 1:
    // linking it would hand the part the full book's ISBN, date and cover.
    const t = makeT();
    const split = await buildCatalog(t, { coverage: { extent: "partial" } });
    const outcome = await match(t, fact(split.publisherId, { isbn13: "9781999000103" }));
    expect(outcome).toMatchObject({ kind: "review", rung: 4 });

    // A single-volume book of an Edition Line (a Collector's Edition) is
    // packaging, never the ordinary Volume 1.
    const t2 = makeT();
    const collectors = await buildCatalog(t2, { line: { name: "Collector's Edition" } });
    expect(await match(t2, fact(collectors.publisherId))).toMatchObject({
      kind: "review",
      rung: 4,
    });
  });

  it("never auto-links onto Unmapped Packaging that kept a complete coverage row (HB-13)", async () => {
    // The flag says no source stated what the Edition collects, so a row
    // left on it is no proof it is the ordinary Volume 1.
    const t = makeT();
    const unmapped = await buildCatalog(t, { edition: { coverageUnmapped: true } });
    expect(await match(t, fact(unmapped.publisherId))).toMatchObject({ kind: "review", rung: 4 });
  });

  it("a hardcover or another language is another Release, never the paperback (B14)", async () => {
    const t = makeT();
    const paperback = await buildCatalog(t, { release: { binding: "paperback" } });
    // Another Binding of the same Edition is a sibling: the creation path.
    expect(await match(t, fact(paperback.publisherId, { binding: "Hardcover" }))).toMatchObject({
      kind: "create",
      rung: 5,
    });
    // Same Binding (any case), or a fact that does not know it, still links.
    expect(await match(t, fact(paperback.publisherId, { binding: "Paperback" }))).toMatchObject({
      kind: "match",
      rung: 3,
      release: { _id: paperback.releaseId },
    });
    expect(await match(t, fact(paperback.publisherId))).toMatchObject({ kind: "match", rung: 3 });

    // Another language is another Release by definition.
    const t2 = makeT();
    const french = await buildCatalog(t2, { release: { language: "fr" } });
    expect(await match(t2, fact(french.publisherId, { language: "en" }))).toMatchObject({
      kind: "create",
      rung: 5,
    });
    expect(await match(t2, fact(french.publisherId, { language: "fr" }))).toMatchObject({
      kind: "match",
      rung: 3,
    });
  });

  it("a single candidate under an override or lock still reviews", async () => {
    const t = makeT();
    const overridden = await buildCatalog(t, { release: { overriddenFields: ["pubDate"] } });
    expect(await match(t, fact(overridden.publisherId))).toMatchObject({
      kind: "review",
      rung: 3,
    });

    // An edited blurb is editorial, not identity: the link still happens.
    const t3 = makeT();
    const prose = await buildCatalog(t3, { release: { overriddenFields: ["description"] } });
    expect(await match(t3, fact(prose.publisherId))).toMatchObject({
      kind: "match",
      rung: 3,
    });

    const t2 = makeT();
    const locked = await buildCatalog(t2, { release: { locked: true } });
    expect(await match(t2, fact(locked.publisherId))).toMatchObject({
      kind: "review",
      rung: 3,
    });
  });
});

describe("matchRelease — rungs ④ and ⑤", () => {
  it("a title-only candidate (wrong publisher) always reviews", async () => {
    const t = makeT();
    await buildCatalog(t, { publisher: { slug: "other-pub" } });
    const sevenSeas = await t.run((ctx) =>
      insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" }),
    );
    const outcome = await match(t, fact(sevenSeas));
    expect(outcome).toMatchObject({ kind: "review", rung: 4 });
  });

  it("a same-edition candidate differing only in format is a sibling — creation, not review", async () => {
    // Releases of one Edition differ exactly in Format/Binding (spec §2): a
    // publisher's digital counterpart of an existing print volume is a new
    // sibling Release, not ambiguity for a human to untangle.
    const t = makeT();
    const catalog = await buildCatalog(t, { release: { format: "digital" } });
    const outcome = await match(t, fact(catalog.publisherId));
    expect(outcome).toMatchObject({ kind: "create", rung: 5 });
  });

  it("no plausible candidate at all goes to the creation path", async () => {
    const t = makeT();
    const catalog = await buildCatalog(t);
    // Same series, but volume 2 does not exist yet: create.
    expect(await match(t, fact(catalog.publisherId, { volumeLabel: "2" }))).toMatchObject({
      kind: "create",
      rung: 5,
    });
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

describe("candidateSeries", () => {
  const series = (t: TestT, title: string, altTitles: string[] = []) =>
    t.run((ctx) => insertSeries(ctx, { title, altTitles }));

  it("finds a release-less backbone Series buried under many near-namesakes", async () => {
    const t = makeT();
    // The polluted shards the old PRH splitter created, crowding the search.
    for (let n = 1; n <= 30; n++) {
      await series(t, `Otherside Picnic ${String(n).padStart(2, "0")} (Manga)`);
    }
    const ann = await series(t, "Otherside Picnic");
    const hits = await t.run((ctx) => candidateSeries(ctx, "Otherside Picnic"));
    expect(hits.map((s) => s._id)).toEqual([ann]);
  });

  it("folds &/and and accents, and prefers primary titles over alt titles", async () => {
    const t = makeT();
    const candy = await series(t, "Candy & Cigarettes");
    expect(
      (await t.run((ctx) => candidateSeries(ctx, "CANDY AND CIGARETTES"))).map((s) => s._id),
    ).toEqual([candy]);

    // ANN lists "Citrus Plus" as an alt title of Citrus: the real Citrus
    // Plus Series wins, and the alt title counts only as a fallback.
    await series(t, "Citrus", ["Citrus Plus"]);
    const plus = await series(t, "Citrus Plus");
    expect((await t.run((ctx) => candidateSeries(ctx, "Citrus Plus"))).map((s) => s._id)).toEqual([
      plus,
    ]);
    const tenken = await series(t, "Reincarnated as a Sword", ["Tenken"]);
    expect((await t.run((ctx) => candidateSeries(ctx, "Tenken"))).map((s) => s._id)).toEqual([
      tenken,
    ]);
  });

  it("picks the namesake whose title matches with punctuation kept", async () => {
    const t = makeT();
    // Two works that key to "bastard": the WEBTOON and Hagiwara's BASTARD!!.
    const webtoon = await series(t, "Bastard");
    const hagiwara = await series(t, "Bastard!!");
    const ids = async (title: string) =>
      (await t.run((ctx) => candidateSeries(ctx, title))).map((s) => s._id);
    expect(await ids("Bastard")).toEqual([webtoon]);
    expect(await ids("Bastard!!")).toEqual([hagiwara]);
    // Neither spelled exactly: still both, for review.
    expect((await ids("BASTARD?")).sort()).toEqual([webtoon, hagiwara].sort());
  });

  it("answers a merged Series' title with its survivor, and reports hidden namesakes apart", async () => {
    const t = makeT();
    const survivor = await series(t, "Summer Ghost: Complete");
    const loser = await series(t, "Summer Ghost");
    await t.run((ctx) => ctx.db.patch(loser, { status: "merged", mergedIntoId: survivor }));
    expect((await t.run((ctx) => candidateSeries(ctx, "Summer Ghost"))).map((s) => s._id)).toEqual([
      survivor,
    ]);

    const hidden = await series(t, "Emma & Capucine");
    await t.run((ctx) => ctx.db.patch(hidden, { status: "hidden" }));
    expect(await t.run((ctx) => candidateSeries(ctx, "Emma and Capucine"))).toEqual([]);
    expect(
      (await t.run((ctx) => hiddenSeriesTitled(ctx, "Emma and Capucine"))).map((s) => s._id),
    ).toEqual([hidden]);

    // A hidden Series with the primary title outranks an active Series'
    // alt title, and a hidden Series' alt title never counts.
    const paradise = await series(t, "Paradise");
    await t.run((ctx) => ctx.db.patch(paradise, { status: "hidden" }));
    await series(t, "Paradise Residence", ["Paradise"]);
    expect(await t.run((ctx) => candidateSeries(ctx, "Paradise"))).toEqual([]);
    expect((await t.run((ctx) => hiddenSeriesTitled(ctx, "Paradise"))).map((s) => s._id)).toEqual([
      paradise,
    ]);
    await series(t, "Mo Dao Zu Shi (Novel)", ["Grandmaster"]).then((id) =>
      t.run((ctx) => ctx.db.patch(id, { status: "hidden" })),
    );
    expect(await t.run((ctx) => hiddenSeriesTitled(ctx, "Grandmaster"))).toEqual([]);
  });

  it("never offers a manga Series for a novel title", async () => {
    const t = makeT();
    await series(t, "The Seven Deadly Sins");
    expect(await t.run((ctx) => candidateSeries(ctx, "The Seven Deadly Sins (Novel)"))).toEqual([]);
  });
});
