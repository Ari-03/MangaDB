import { describe, expect, it } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertVariant,
  insertBundle,
} from "../../test.factories";
import { makeT, type TestT } from "../../test.helpers";
import type { EntryOf, RepairEntry } from "./entries";

const ISBN = "9781974749874";
const BASE = "9781974725984";
const BOX = "9781421550053";
const SOURCES = ["https://publisher.example/books/cover"];

/** A moderator and a mapped book, plus a held exclusive-cover observation. */
async function seed(t: TestT) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media" });
    const seriesId = await insertSeries(ctx, { title: "Kaiju No. 8" });
    const volumeId = await insertVolume(ctx, { seriesId });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      publisherId,
      editionId,
      seriesIds: [seriesId],
      isbn13: BASE,
      binding: "paperback",
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: "OL1M",
      snapshot: { isbn13: ISBN, title: "Wrongly routed work", format: "physical" },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "isbn",
      seriesId,
      heldAt: 1,
    });
    return { userId, publisherId, seriesId, volumeId, editionId, releaseId, observationId };
  });
}

async function run(t: TestT, entry: RepairEntry, dryRun = false) {
  return (
    await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun, entries: [entry] })
  )[0]!;
}

async function variant(
  t: TestT,
  s: Awaited<ReturnType<typeof seed>>,
): Promise<EntryOf<"releaseVariant">> {
  const preview = await t.query(internal.repairTools.variantStateInternal, {
    observationId: s.observationId,
    releaseId: s.releaseId,
  });
  return {
    kind: "releaseVariant",
    key: "cover",
    reason: "Store confirms exclusive cover and unchanged contents",
    name: "Crunchyroll exclusive cover",
    observationId: s.observationId,
    releaseId: s.releaseId,
    expected: preview.expected,
    publisherId: preview.publisherId,
    binding: preview.binding,
    coverage: preview.coverage,
    printingRowId: null,
    sources: SOURCES,
  };
}

async function printing(
  t: TestT,
  s: Awaited<ReturnType<typeof seed>>,
): Promise<EntryOf<"otherPrinting">> {
  const { name: _name, printingRowId: _row, ...entry } = await variant(t, s);
  return { ...entry, kind: "otherPrinting", sourceReleaseId: null, expectedSource: null };
}

describe("researched repair gaps", () => {
  it("creates a publisher with evidence, actor, dry run and keyed receipt", async () => {
    const t = makeT();
    await seed(t);
    const entry: EntryOf<"createPublisher"> = {
      kind: "createPublisher",
      key: "idw",
      reason: "Publisher evidence",
      name: "IDW",
      slug: "idw",
      parentPublisherId: null,
      sources: SOURCES,
    };
    expect((await run(t, entry, true)).status).toBe("applied");
    expect(await t.run((ctx) => ctx.db.query("repairToolReceipts").collect())).toEqual([]);
    expect((await run(t, entry)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("alreadyApplied");
    expect((await run(t, { ...entry, name: "Pushkin Press" })).status).toBe("skipped");
    const receipt = await t.run((ctx) => ctx.db.query("repairToolReceipts").first());
    const version = await t.run((ctx) =>
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", receipt!.proposalId))
        .first(),
    );
    expect(version?.evidence).toContainEqual({ kind: "url", url: SOURCES[0] });
    expect((await t.run((ctx) => ctx.db.get(receipt!.proposalId)))?.author).toMatchObject({
      kind: "user",
    });
  });

  it.each(["VIZ MEDIA", "VIZ, Media", "Viz Communications"])(
    "refuses duplicate publisher %s",
    async (name) => {
      const t = makeT();
      await seed(t);
      expect(
        (
          await run(t, {
            kind: "createPublisher",
            key: "duplicate",
            reason: "Proof",
            name,
            slug: "different",
            parentPublisherId: null,
            sources: SOURCES,
          })
        ).status,
      ).toBe("skipped");
    },
  );

  it("creates an imprint and refuses nested, missing or locked parents", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry: EntryOf<"createPublisher"> = {
      kind: "createPublisher",
      key: "imprint",
      reason: "Proof",
      name: "New Imprint",
      slug: "new-imprint",
      parentPublisherId: s.publisherId,
      sources: SOURCES,
    };
    expect((await run(t, entry)).status).toBe("applied");
    const imprint = await t.run((ctx) =>
      ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "new-imprint"))
        .unique(),
    );
    expect(
      (
        await run(t, {
          ...entry,
          key: "nested",
          name: "Nested",
          slug: "nested",
          parentPublisherId: imprint!._id,
        })
      ).status,
    ).toBe("skipped");
    await t.run((ctx) => ctx.db.patch(s.publisherId, { locked: true }));
    expect(
      (await run(t, { ...entry, key: "locked", name: "Another", slug: "another" })).status,
    ).toBe("skipped");
  });

  it("refuses hidden publisher duplicates, redirect slugs and invalid evidence", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.publisherId, { status: "hidden" });
      await ctx.db.insert("publisherSlugRedirects", {
        fromSlug: "old",
        publisherId: s.publisherId,
      });
    });
    const entry: EntryOf<"createPublisher"> = {
      kind: "createPublisher",
      key: "pub",
      reason: "Proof",
      name: "VIZ Media",
      slug: "new",
      parentPublisherId: null,
      sources: SOURCES,
    };
    expect((await run(t, entry)).status).toBe("skipped");
    expect((await run(t, { ...entry, name: "New", slug: "old" })).status).toBe("skipped");
    expect((await run(t, { ...entry, name: "New", sources: ["file:///tmp/proof"] })).status).toBe(
      "skipped",
    );
  });

  it("records a held store cover as a variant without changing Release facts", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry = await variant(t, s);
    const before = await t.run((ctx) => ctx.db.get(s.releaseId));
    expect((await run(t, entry, true)).status).toBe("applied");
    expect(await t.run((ctx) => ctx.db.query("releaseVariants").collect())).toEqual([]);
    expect((await run(t, entry)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("alreadyApplied");
    expect(await t.run((ctx) => ctx.db.get(s.releaseId))).toEqual(before);
    const obs = await t.run((ctx) => ctx.db.get(s.observationId));
    expect(obs).toMatchObject({
      recordRef: { type: "release", id: s.releaseId },
      printingIsbn13: ISBN,
    });
    expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toEqual([]);
    const row = await t.run((ctx) => ctx.db.query("releaseIsbns").first());
    expect(row?.variantId).toBeDefined();
    const publicId = (await t.run((ctx) => ctx.db.get(s.volumeId)))!.publicId;
    const page = await t.query(api.catalogPages.volumePage, { publicId });
    expect(page?.editions[0]?.releases[0]).toMatchObject({
      otherPrintings: [],
      variants: [{ name: entry.name, isbn13: ISBN }],
    });
  });

  it("converts a decided Other Printing into a variant and preserves every marked record", async () => {
    const t = makeT();
    const s = await seed(t);
    const rowId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("releaseIsbns", {
        releaseId: s.releaseId,
        isbn13: ISBN,
        reason: "Wrong decision",
        sourceKey: "openlibrary",
        observationId: s.observationId,
      });
      await ctx.db.patch(s.observationId, {
        recordRef: { type: "release", id: s.releaseId },
        printingIsbn13: ISBN,
      });
      const other = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:1",
        snapshot: { isbn13: ISBN },
        recordRef: { type: "release", id: s.releaseId },
        printingIsbn13: ISBN,
      });
      return { id, other };
    });
    const entry = { ...(await variant(t, s)), printingRowId: rowId.id };
    expect((await run(t, entry)).status).toBe("applied");
    expect((await t.run((ctx) => ctx.db.get(rowId.other)))?.printingIsbn13).toBe(ISBN);
    expect((await t.run((ctx) => ctx.db.get(rowId.id)))?.variantId).toBeDefined();
    const undo = await t.mutation(internal.printings.undoDecidedInternal, {
      actor: "ari",
      observationId: s.observationId,
      reason: "Should refuse variant",
      hold: { kind: "isbn", reason: "Needs review", seriesId: s.seriesId },
    });
    expect(undo.status).toBe("refused");
  });

  it.each(["source", "target", "hold"])("refuses drift in %s", async (change) => {
    const t = makeT();
    const s = await seed(t);
    const entry = await variant(t, s);
    await t.run(async (ctx) => {
      if (change === "source")
        await ctx.db.patch(s.observationId, { snapshot: { isbn13: ISBN, title: "Changed" } });
      if (change === "target") await ctx.db.patch(s.releaseId, { binding: "hardcover" });
      if (change === "hold") {
        const hold = await ctx.db.query("placementHolds").first();
        await ctx.db.patch(hold!._id, { kind: "series" });
      }
    });
    expect((await run(t, entry)).status).toBe("skipped");
    expect(await t.run((ctx) => ctx.db.query("releaseVariants").collect())).toEqual([]);
  });

  it.each([
    "coverage",
    "publisher",
    "binding",
    "claim",
    "queued",
    "withdrawn",
    "linked",
    "evidence",
  ])("refuses invalid variant %s", async (change) => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      if (change === "claim") await insertBundle(ctx, { publisherId: s.publisherId, isbn13: ISBN });
      if (change === "queued") {
        const id = await ctx.db.insert("proposals", {
          author: { kind: "source", sourceKey: "ann" },
          state: "inReview",
          currentVersionNo: 1,
        });
        await ctx.db.patch(s.observationId, { queuedProposalId: id });
      }
      if (change === "withdrawn") await ctx.db.patch(s.observationId, { withdrawn: true });
      if (change === "linked")
        await ctx.db.patch(s.observationId, { recordRef: { type: "release", id: s.releaseId } });
    });
    const entry = await variant(t, s);
    if (change === "coverage") entry.coverage = [];
    if (change === "publisher") entry.publisherId = await t.run((ctx) => insertPublisher(ctx));
    if (change === "binding") entry.binding = "hardcover";
    if (change === "evidence") entry.sources = [];
    expect((await run(t, entry)).status).toBe("skipped");
  });

  it("moves variant ISBN pins on Merge and restores them on Split", async () => {
    const t = makeT();
    const s = await seed(t);
    await run(t, await variant(t, s));
    const loser = (await t.run((ctx) => ctx.db.query("releaseVariants").first()))!;
    const survivorId = await t.run((ctx) =>
      insertVariant(ctx, { releaseId: s.releaseId, name: "Same cover" }),
    );
    const admin = t.withIdentity({ subject: "admin" });
    await admin.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "releaseVariant", id: survivorId },
      loser: { type: "releaseVariant", id: loser._id },
      reason: "Duplicate cover",
      confirmImpact: true,
    });
    expect((await t.run((ctx) => ctx.db.query("releaseIsbns").first()))?.variantId).toBe(
      survivorId,
    );
    await admin.mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "releaseVariant", id: loser._id },
      reason: "Separate covers",
      confirmImpact: true,
    });
    expect((await t.run((ctx) => ctx.db.query("releaseIsbns").first()))?.variantId).toBe(loser._id);
  });

  it("reports corrupt variant ISBN pins in the consistency check", async () => {
    const t = makeT();
    const s = await seed(t);
    await run(t, await variant(t, s));
    const check = () =>
      t.query(internal.printings.consistencyInternal, {
        pass: "rows",
        paginationOpts: { numItems: 10, cursor: null },
      });
    expect((await check()).findings).toEqual([]);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("releaseIsbns").first())!;
      await ctx.db.delete(row.variantId!);
    });
    expect((await check()).findings).toContainEqual(
      expect.objectContaining({ severity: "violation", isbn13: ISBN }),
    );
  });

  it.each(["digital source", "digital target", "wrong binding", "partial contents"])(
    "refuses Other Printing with %s",
    async (invalid) => {
      const t = makeT();
      const s = await seed(t);
      await t.run(async (ctx) => {
        if (invalid === "digital source")
          await ctx.db.patch(s.observationId, { snapshot: { isbn13: ISBN, format: "digital" } });
        if (invalid === "digital target") await ctx.db.patch(s.releaseId, { format: "digital" });
        if (invalid === "partial contents") {
          const c = (await ctx.db.query("volumeCoverages").first())!;
          await ctx.db.patch(c._id, { extent: "partial" });
        }
      });
      const entry = await printing(t, s);
      if (invalid === "wrong binding") entry.binding = "hardcover";
      expect((await run(t, entry)).status).toBe("skipped");
      expect(await t.run((ctx) => ctx.db.query("releaseIsbns").collect())).toEqual([]);
    },
  );

  it("appends corrected proposal evidence without editing historical versions or approved ops", async () => {
    const t = makeT();
    await seed(t);
    const publisher: EntryOf<"createPublisher"> = {
      kind: "createPublisher",
      key: "first",
      reason: "Proof",
      name: "IDW",
      slug: "idw",
      parentPublisherId: null,
      sources: SOURCES,
    };
    await run(t, publisher);
    const receipt = await t.run((ctx) => ctx.db.query("repairToolReceipts").first());
    const entry: EntryOf<"amendProposalEvidence"> = {
      kind: "amendProposalEvidence",
      key: "evidence",
      reason: "Old URL was dead",
      proposalId: receipt!.proposalId,
      expectedVersionNo: 1,
      replacements: [{ before: SOURCES[0]!, after: "https://publisher.example/new" }],
    };
    const original = await t.run((ctx) => ctx.db.query("proposalVersions").first());
    expect((await run(t, entry, true)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("alreadyApplied");
    const versions = await t.run((ctx) =>
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", receipt!.proposalId))
        .collect(),
    );
    expect(versions[0]).toEqual(original);
    expect(versions[1]?.ops).toEqual(original?.ops);
    expect(versions[1]?.evidence).toContainEqual({
      kind: "url",
      url: "https://publisher.example/new",
    });
    expect((await run(t, { ...entry, key: "stale" })).status).toBe("skipped");
    expect(
      (
        await run(t, {
          ...entry,
          key: "absent",
          expectedVersionNo: 2,
          replacements: [{ before: "https://absent.example", after: SOURCES[0]! }],
        })
      ).status,
    ).toBe("skipped");
  });

  it("records an omnibus Other Printing with reviewed exact coverage", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const v = await insertVolume(ctx, { seriesId: s.seriesId, position: 2 });
      await insertCoverage(ctx, { editionId: s.editionId, volumeId: v, order: 2 });
    });
    const entry = await printing(t, s);
    expect((await run(t, entry, true)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("applied");
    expect((await t.run((ctx) => ctx.db.query("releaseIsbns").first()))?.variantId).toBeUndefined();
  });

  it("converts an isolated mistaken Release into an Other Printing, with audited ISBN removal", async () => {
    const t = makeT();
    const s = await seed(t);
    const source = await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId: s.publisherId });
      await insertCoverage(ctx, { editionId, volumeId: s.volumeId });
      const releaseId = await insertRelease(ctx, {
        publisherId: s.publisherId,
        editionId,
        seriesIds: [s.seriesId],
        isbn13: ISBN,
        binding: "paperback",
      });
      return { releaseId, editionId };
    });
    const entry = {
      ...(await printing(t, s)),
      sourceReleaseId: source.releaseId,
      expectedSource: (
        await t.query(internal.repairTools.printingSourceStateInternal, {
          sourceReleaseId: source.releaseId,
        })
      ).expected,
    };
    expect((await run(t, entry)).status).toBe("applied");
    expect(await t.run((ctx) => ctx.db.get(source.releaseId))).toMatchObject({ status: "hidden" });
    expect((await t.run((ctx) => ctx.db.get(source.releaseId)))?.isbn13).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(source.editionId)))?.status).toBe("hidden");
    expect((await t.run((ctx) => ctx.db.get(s.observationId)))?.recordRef).toEqual({
      type: "release",
      id: s.releaseId,
    });
  });

  it("refuses retiring a printing Release with ownership references", async () => {
    const t = makeT();
    const s = await seed(t);
    const source = await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId: s.publisherId });
      await insertCoverage(ctx, { editionId, volumeId: s.volumeId });
      const releaseId = await insertRelease(ctx, {
        publisherId: s.publisherId,
        editionId,
        seriesIds: [s.seriesId],
        isbn13: ISBN,
        binding: "paperback",
      });
      await ctx.db.insert("collectionEntries", {
        userId: s.userId,
        releaseId,
        state: "owned",
      });
      return releaseId;
    });
    const entry = {
      ...(await printing(t, s)),
      sourceReleaseId: source,
      expectedSource: (
        await t.query(internal.repairTools.printingSourceStateInternal, { sourceReleaseId: source })
      ).expected,
    };
    expect((await run(t, entry)).status).toBe("skipped");
    expect((await t.run((ctx) => ctx.db.get(source)))?.status).toBe("active");
  });
});

/** Bundle plans use exact member ISBNs and leave publication facts on the package. */
function boxEntry(
  publisherId: Awaited<ReturnType<typeof seed>>["publisherId"],
): EntryOf<"releaseBundle"> {
  return {
    kind: "releaseBundle",
    key: "box",
    reason: "Box evidence",
    bundleId: null,
    box: null,
    members: [{ isbn13: BASE, order: 1 }],
    retireVolumeIds: [],
    create: {
      name: "Box",
      isbn13: BOX,
      isbn10: null,
      publisherId,
      format: "physical",
      pubDate: null,
      price: null,
    },
  };
}

describe("bundle publisher and unmapped restore guards", () => {
  it.each(["parent", "imprint"])("accepts direct %s relationship", async (direction) => {
    const t = makeT();
    const s = await seed(t);
    const imprint = await t.run((ctx) =>
      insertPublisher(ctx, { name: "Imprint", parentPublisherId: s.publisherId }),
    );
    if (direction === "parent")
      await t.run(async (ctx) => {
        await ctx.db.patch(s.editionId, { publisherId: imprint });
        await ctx.db.patch(s.releaseId, { publisherId: imprint });
      });
    expect(
      (await run(t, boxEntry(direction === "parent" ? s.publisherId : imprint), true)).status,
    ).toBe("applied");
    expect((await run(t, boxEntry(direction === "parent" ? s.publisherId : imprint))).status).toBe(
      "applied",
    );
  });
  it.each(["unrelated", "sibling", "format"])("refuses %s members", async (relation) => {
    const t = makeT();
    const s = await seed(t);
    const pub = await t.run((ctx) =>
      insertPublisher(ctx, {
        name: "Other",
        ...(relation === "sibling" ? { parentPublisherId: s.publisherId } : {}),
      }),
    );
    if (relation === "sibling")
      await t.run(async (ctx) => {
        const member = await insertPublisher(ctx, {
          name: "Sibling",
          parentPublisherId: s.publisherId,
        });
        await ctx.db.patch(s.editionId, { publisherId: member });
        await ctx.db.patch(s.releaseId, { publisherId: member });
      });
    if (relation === "format")
      await t.run((ctx) => ctx.db.patch(s.releaseId, { format: "digital" }));
    expect((await run(t, boxEntry(relation === "format" ? s.publisherId : pub))).status).toBe(
      "skipped",
    );
  });
  it("restores the unmapped BW box and converts it without discarding its ISBN claim", async () => {
    const t = makeT();
    const s = await seed(t);
    const box = await t.run(async (ctx) => {
      const lineId = await insertEditionLine(ctx, {
        publisherId: s.publisherId,
        seriesId: s.seriesId,
        name: "BW minis",
      });
      const editionId = await insertEdition(ctx, {
        publisherId: s.publisherId,
        status: "hidden",
        coverageUnmapped: true,
        editionLineId: lineId,
      });
      const releaseId = await insertRelease(ctx, {
        publisherId: s.publisherId,
        editionId,
        seriesIds: [s.seriesId],
        status: "hidden",
        isbn13: BOX,
      });
      await ctx.db.patch(s.editionId, { coverageUnmapped: true, editionLineId: lineId });
      const coverage = await ctx.db.query("volumeCoverages").first();
      await ctx.db.delete(coverage!._id);
      return { releaseId, editionId, lineId };
    });
    const entry: EntryOf<"restoreRecord"> = {
      kind: "restoreRecord",
      key: "restore",
      reason: "BW box",
      target: { type: "release", id: box.releaseId },
      editionIds: [box.editionId],
      volumeIds: [],
      releaseIds: [],
    };
    expect((await run(t, entry, true)).status).toBe("applied");
    expect((await run(t, entry)).status).toBe("applied");
    const plan = boxEntry(s.publisherId);
    delete plan.create;
    plan.box = { releaseId: box.releaseId, name: "BW box" };
    expect((await run(t, plan)).status).toBe("applied");
    expect((await t.run((ctx) => ctx.db.query("bundleConversions").first()))?.releaseId).toBe(
      box.releaseId,
    );
  });
  it.each(["empty", "hiddenLine", "hiddenSeries", "wrongPublisher"])(
    "refuses invalid unmapped restore %s",
    async (invalid) => {
      const t = makeT();
      const s = await seed(t);
      const editionId = await t.run(async (ctx) => {
        const lineId = await insertEditionLine(ctx, {
          publisherId: s.publisherId,
          seriesId: s.seriesId,
          name: "Mini",
          ...(invalid === "hiddenLine" ? { status: "hidden" } : {}),
        });
        if (invalid === "hiddenSeries") await ctx.db.patch(s.seriesId, { status: "hidden" });
        return await insertEdition(ctx, {
          publisherId: invalid === "wrongPublisher" ? await insertPublisher(ctx) : s.publisherId,
          status: "hidden",
          ...(invalid !== "empty" ? { coverageUnmapped: true } : {}),
          editionLineId: lineId,
        });
      });
      expect(
        (
          await run(t, {
            kind: "restoreRecord",
            key: "restore",
            reason: "Proof",
            target: { type: "edition", id: editionId },
            volumeIds: [],
            editionIds: [],
            releaseIds: [],
          })
        ).status,
      ).toBe("skipped");
    },
  );
  it("pins Format when a held source misstates an ebook as physical", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.observationId, { snapshot: { isbn13: BASE, format: "physical" } });
      await ctx.db.patch(s.releaseId, { format: "digital", binding: undefined });
    });
    const result = await t.mutation(internal.heldBooks.linkByIsbnInternal, {
      actor: "ari",
      observationId: s.observationId,
      expectedKind: "isbn",
      reason: "Publisher confirms ebook",
      evidenceUrls: SOURCES,
      protectFields: ["format"],
    });
    expect(result.status).toBe("applied");
    expect(await t.run((ctx) => ctx.db.get(s.releaseId))).toMatchObject({
      format: "digital",
      overriddenFields: ["format"],
    });
  });
});
