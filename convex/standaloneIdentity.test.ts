import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { ReviewedIdentity } from "./lib/heldBooks";
import type { AnnReleaseSnapshot } from "./ann";
import type { MutationCtx } from "./_generated/server";
import * as moderation from "./moderation";
import { standaloneFixtures } from "./test.standaloneIdentity";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertSourceRevision,
} from "./test.factories";
import { makeT, seedTeam, alice, type TestT } from "./test.helpers";

async function seed(t: TestT, index = 1) {
  await seedTeam(t, [alice]);
  const f = structuredClone(standaloneFixtures[index]!);
  return t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: index >= 3 ? "Dark Horse" : "Yen Press",
      slug: index >= 3 ? "dark-horse" : "yen-press",
    });
    const seriesId = await insertSeries(ctx, { ...f.series, altTitles: [...f.series.altTitles] });
    const volumeId = await insertVolume(ctx, { seriesId, label: index === 4 ? "1" : undefined });
    const editionId = await insertEdition(ctx, { publisherId });
    const coverageId = await insertCoverage(ctx, { editionId, volumeId });
    if (index === 4) {
      const second = await insertVolume(ctx, { seriesId, label: "2", position: 2 });
      await insertCoverage(ctx, { editionId, volumeId: second, order: 2 });
    }
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: f.snapshot.isbn13,
      binding: "paperback",
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `manga:${f.snapshot.mangaId}`,
      snapshot: f.parentSnapshot,
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${f.snapshot.annId}`,
      snapshot: f.snapshot,
      conflicts: [{ field: "placement", offered: null, reason: "held ISBN", at: 1 }],
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 1,
    });
    await ctx.db.insert("observationSnapshots", {
      observationId,
      snapshot: f.snapshot,
      supersededAt: 1,
    });
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("usernameNormalized", "alice"))
      .unique();
    await ctx.db.insert("collectionEntries", { userId: user!._id, releaseId, state: "owned" });
    await ctx.db.insert("userSeriesStates", {
      userId: user!._id,
      seriesId,
      readingStatus: "reading",
      following: true,
      followPromptDismissed: true,
    });
    // Real Not Love graph has a merged historical duplicate, not two active units.
    if (index < 4)
      await insertVolume(ctx, {
        seriesId,
        label: undefined,
        status: "merged",
        mergedIntoId: volumeId,
        position: 2,
      });
    const reviewed: ReviewedIdentity & { standalone: NonNullable<ReviewedIdentity["standalone"]> } =
      {
        isbn13: f.snapshot.isbn13,
        seriesId,
        publisherId,
        volumeIds: [volumeId],
        sourceTitle: f.snapshot.title,
        evidenceUrls: [f.evidenceUrl],
        standalone: {
          kind: "completeStandaloneManga" as const,
          isbn13: f.snapshot.isbn13,
          parentObservationId: parentId,
          releaseId,
          volumeId,
          productTitle: f.productTitle,
          publisherName: index >= 3 ? "Dark Horse" : "Yen Press",
          format: "physical" as const,
          binding: "paperback" as const,
          extent: "complete-single-book" as const,
          evidenceUrl: f.evidenceUrl,
          extentStatement: f.extentStatement,
          capture: f.capture,
        },
      };
    return {
      publisherId,
      seriesId,
      volumeId,
      editionId,
      coverageId,
      releaseId,
      parentId,
      observationId,
      holdId,
      args: { observationId, target: { type: "release" as const, id: releaseId }, reviewed },
    };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const tables = [
  "sourceObservations",
  "observationSnapshots",
  "placementHolds",
  "proposals",
  "proposalVersions",
  "heldRepairLedger",
  "revisions",
  "series",
  "volumes",
  "editions",
  "volumeCoverages",
  "releases",
  "releaseIsbns",
  "releaseBundles",
  "bundleMemberships",
  "publishers",
  "editionLines",
  "collectionEntries",
  "userSeriesStates",
] as const;
async function state(t: TestT) {
  return t.run(async (ctx) =>
    Object.fromEntries(
      await Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).collect()])),
    ),
  );
}
async function execute(t: TestT, s: Seed, expected: string) {
  return t.mutation(internal.heldBooks.executeInternal, {
    ...s.args,
    actor: "alice",
    operation: "link",
    expected,
    reason:
      "Inspected own-ISBN publisher title and whole-book extent against the independently linked source work.",
    evidenceUrls: s.args.reviewed.evidenceUrls,
  });
}
async function refusal(t: TestT, s: Seed) {
  const before = await state(t);
  const preview = await t.query(internal.heldBooks.previewInternal, s.args);
  expect(["blocked", "incomplete"]).toContain(preview.classification);
  expect(preview.refusal).toBeTruthy();
  expect((await execute(t, s, preview.expected ?? "no guard")).status).toBe("refused");
  expect(await state(t)).toEqual(before);
}

describe("reviewed ANN standalone identity", () => {
  it.each([0, 1, 2, 3])(
    "links retained snapshot %s only with reviewed whole-product proof",
    async (index) => {
      const t = makeT();
      const s = await seed(t, index);
      expect(
        (await t.query(internal.heldBooks.previewInternal, { ...s.args, reviewed: undefined }))
          .refusal,
      ).toBeTruthy();
      const plain = { ...s.args, reviewed: { ...s.args.reviewed, standalone: undefined } };
      expect((await t.query(internal.heldBooks.previewInternal, plain)).refusal).toMatch(
        /no Volume/,
      );
      const before = await state(t);
      const preview = await t.query(internal.heldBooks.previewInternal, s.args);
      expect(preview.refusal).toBeNull();
      expect(preview.classification).toBe("linkReady");
      expect((await execute(t, s, preview.expected!)).status).toBe("applied");
      const after = await state(t);
      for (const table of [
        "observationSnapshots",
        "revisions",
        "series",
        "volumes",
        "editions",
        "volumeCoverages",
        "releases",
        "collectionEntries",
        "userSeriesStates",
      ])
        expect(after[table]).toEqual(before[table]);
      await t.run(async (ctx) => {
        const observation = await ctx.db.get(s.observationId);
        expect(observation?.snapshot).toEqual(standaloneFixtures[index]!.snapshot);
        expect(observation?.recordRef).toEqual({ type: "release", id: s.releaseId });
        expect(await ctx.db.get(s.holdId)).toBeNull();
        const versions = await ctx.db.query("proposalVersions").collect();
        expect(JSON.stringify(versions)).toContain(s.args.reviewed.standalone.capture.bodySha256);
        expect(JSON.stringify(versions)).toContain(s.args.reviewed.standalone.extentStatement);
        const ledger = await ctx.db.query("heldRepairLedger").unique();
        expect(ledger?.target).toEqual(s.args.target);
      });
      const linked = await state(t);
      expect((await execute(t, s, preview.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(linked);
    },
  );

  it("isolates the actual Shadow Out of Time GN 1-2 product from standalone repairs", async () => {
    const t = makeT();
    const s = await seed(t, 4);
    s.args.reviewed.volumeIds.push(
      await t.run(async (ctx) => {
        const volumes = await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", s.seriesId))
          .collect();
        return volumes.find((v) => v.label === "2")!._id;
      }),
    );
    const ordinaryReview = { ...s.args, reviewed: { ...s.args.reviewed, standalone: undefined } };
    expect((await t.query(internal.heldBooks.previewInternal, ordinaryReview)).refusal).toMatch(
      /Edition Line/,
    );
    await refusal(t, s);
  });

  const negatives: Array<[string, (ctx: MutationCtx, s: Seed) => Promise<unknown>]> = [
    ["ISBN mismatch", (ctx, s) => ctx.db.patch(s.releaseId, { isbn13: "9781975321260" })],
    [
      "other source parent",
      async (ctx, s) => {
        const id = await insertSeries(ctx, { title: "Other Work" });
        await ctx.db.patch(s.parentId, { recordRef: { type: "series", id } });
      },
    ],
    [
      "parent manga identity",
      async (ctx, s) => {
        const p = (await ctx.db.get(s.parentId))!;
        await ctx.db.patch(s.parentId, { snapshot: { ...p.snapshot, id: "other" } });
      },
    ],
    ["unlinked parent", (ctx, s) => ctx.db.patch(s.parentId, { recordRef: undefined })],
    [
      "publisher",
      async (ctx, s) => {
        const id = await insertPublisher(ctx, { name: "Other Publisher", slug: "other" });
        await ctx.db.patch(s.releaseId, { publisherId: id });
      },
    ],
    ["format", (ctx, s) => ctx.db.patch(s.releaseId, { format: "digital" })],
    ["binding", (ctx, s) => ctx.db.patch(s.releaseId, { binding: "hardcover" })],
    ["numbered target", (ctx, s) => ctx.db.patch(s.volumeId, { label: "1" })],
    [
      "multiple active units",
      (ctx, s) => insertVolume(ctx, { seriesId: s.seriesId, label: undefined, position: 2 }),
    ],
    [
      "partial coverage",
      (ctx, s) => ctx.db.patch(s.coverageId, { extent: "partial", note: "excerpt" }),
    ],
    ["empty stored edition position", (ctx, s) => ctx.db.patch(s.editionId, { linePosition: "" })],
    ["unmapped coverage", (ctx, s) => ctx.db.patch(s.editionId, { coverageUnmapped: true })],
    ["locked volume", (ctx, s) => ctx.db.patch(s.volumeId, { locked: true })],
    [
      "edition line",
      async (ctx, s) => {
        const id = await insertEditionLine(ctx, {
          seriesId: s.seriesId,
          publisherId: s.publisherId,
          name: "Special",
        });
        await ctx.db.patch(s.editionId, { editionLineId: id });
      },
    ],
    [
      "duplicate ISBN owner",
      (ctx, s) =>
        insertRelease(ctx, {
          editionId: s.editionId,
          publisherId: s.publisherId,
          seriesIds: [s.seriesId],
          isbn13: s.args.reviewed.isbn13,
        }),
    ],
  ];
  it.each(negatives)("refuses %s without writes", async (_, change) => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) => change(ctx, s));
    await refusal(t, s);
  });

  it.each([
    "GN 1",
    "GN 1-2",
    "GN 1,3",
    "GN II",
    "GN n/a",
    "GN 1-2+EX",
    "GN (Omnibus)",
    "chapter",
    "novel",
    "unknownScope",
    "pageWork",
    "parentEntry",
    "pageISBN",
    "sourcePublisher",
    "packageTitle",
    "failedPage",
  ])("keeps raw %s contradictions", async (kind) => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const o = (await ctx.db.get(s.observationId))!;
      const original = standaloneFixtures[1]!.snapshot;
      const snapshot: AnnReleaseSnapshot & {
        page: NonNullable<AnnReleaseSnapshot["page"]>;
      } = { ...original, page: { ...original.page } };
      if (kind.startsWith("GN")) snapshot.page.volume = kind;
      if (kind === "chapter" || kind === "novel")
        snapshot.page.title = `${snapshot.title} ${kind} 2`;
      if (kind === "pageWork") snapshot.page.title = "Unrelated Work" as typeof snapshot.page.title;
      if (kind === "pageISBN") snapshot.page.isbn13 = "9781975321260";
      if (kind === "sourcePublisher") snapshot.page.distributor = "Unmapped Publisher";
      if (kind === "packageTitle") snapshot.page.title = `${snapshot.title} Complete Edition`;
      if (kind === "failedPage") snapshot.page.status = "error";
      if (kind === "unknownScope")
        await insertObservation(ctx, {
          sourceKey: "yenpress",
          sourceRecordId: original.isbn13,
          snapshot: { outOfScope: "category unknown" },
        });
      if (kind === "parentEntry") {
        const p = (await ctx.db.get(s.parentId))!;
        await ctx.db.patch(s.parentId, {
          snapshot: { ...p.snapshot, releases: [{ ...original, label: "2" }] },
        });
      }
      await ctx.db.patch(o._id, { snapshot });
    });
    await refusal(t, s);
  });

  it.each([
    "isbn",
    "parent",
    "release",
    "volume",
    "product",
    "publisher",
    "binding",
    "format",
    "extent",
    "url",
    "capture",
  ])("refuses mismatched reviewed %s proof", async (field) => {
    const t = makeT();
    const s = await seed(t);
    const proof = s.args.reviewed.standalone;
    if (field === "isbn") proof.isbn13 = "9781975321260";
    if (field === "parent") proof.parentObservationId = s.observationId;
    if (field === "release")
      proof.releaseId = await t.run((ctx) =>
        insertRelease(ctx, {
          editionId: s.editionId,
          publisherId: s.publisherId,
          seriesIds: [s.seriesId],
        }),
      );
    if (field === "volume")
      proof.volumeId = await t.run((ctx) =>
        insertVolume(ctx, { seriesId: s.seriesId, status: "hidden", label: undefined }),
      );
    if (field === "product") proof.productTitle = "Unrelated Work";
    if (field === "publisher") proof.publisherName = "Unknown Publisher";
    if (field === "binding") proof.binding = "hardcover";
    if (field === "format") proof.format = "digital";
    if (field === "extent") proof.extentStatement = "";
    if (field === "url") proof.evidenceUrl = "https://example.org/unreviewed";
    if (field === "capture") proof.capture.excerpt = proof.productTitle;
    await refusal(t, s);
  });

  it.each([
    { isbn10: "197532126X" },
    { isbn10: "1975321250" },
    { isbn10: "" },
    { isbn13: "9781975321250", isbn10: "1975321251" },
  ])(
    "refuses contradictory or invalid target primary keys %j with fresh and stale guards",
    async (keys) => {
      const t = makeT();
      const s = await seed(t);
      const valid = await t.query(internal.heldBooks.previewInternal, s.args);
      expect(valid.classification).toBe("linkReady");
      await t.run((ctx) => ctx.db.patch(s.releaseId, keys));
      const before = await state(t);
      expect((await execute(t, s, valid.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(before);
      await refusal(t, s);
    },
  );

  it.each(["pair", "isbn13", "isbn10"])("accepts the matching own target ISBN %s", async (kind) => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.releaseId, {
        isbn13: kind === "isbn10" ? undefined : "9781975321253",
        isbn10: kind === "isbn13" ? undefined : "1975321251",
      }),
    );
    const p = await t.query(internal.heldBooks.previewInternal, s.args);
    expect(p.classification).toBe("linkReady");
    expect((await execute(t, s, p.expected!)).status).toBe("applied");
  });

  const contradictoryPassages = [
    "Volume 2 of this ongoing manga series.",
    "Contains Volume 2 only",
    "Complete story in one volume, Vol. 2",
    "The first five chapters of the work, with the remaining stories in Volume 2.",
    "This digital-only ebook contains the complete story.",
    "The complete story in hardcover format.",
    "The complete story. Volume n/a.",
    "This product is Volume ?. Complete collection.",
    "The complete story. Volumes 1-2.",
    "Only the first five stories are included.",
    "An abridged collection of short stories.",
    "The complete story. Binding: unknown.",
    "The complete story. Format: n/a.",
    "The complete story. Binding: paperback or unknown.",
    "Book n/a contains this story.",
    "The complete story. GN n/a.",
    "Contents #1 #2 Copyright. Volume 2.",
    "Contents #1 #3 Copyright",
    "Contains #2 of this ongoing manga series.",
    "Contents #1 #2 Copyright. This digital-only ebook contains the complete story.",
  ];
  it.each(contradictoryPassages)(
    "refuses contradictory passage %s with fresh and stale guards",
    async (passage) => {
      const t = makeT();
      const s = await seed(t);
      const ordinary = { ...s.args, reviewed: { ...s.args.reviewed, standalone: undefined } };
      const ordinaryBefore = await state(t);
      const plain = await t.query(internal.heldBooks.previewInternal, ordinary);
      expect(plain.refusal).toMatch(/no Volume/);
      expect(
        (
          await t.mutation(internal.heldBooks.executeInternal, {
            ...ordinary,
            actor: "alice",
            operation: "link",
            expected: plain.expected!,
            reason: "Ordinary reviewed placement cannot infer standalone extent.",
            evidenceUrls: s.args.reviewed.evidenceUrls,
          })
        ).status,
      ).toBe("refused");
      expect(await state(t)).toEqual(ordinaryBefore);
      const valid = await t.query(internal.heldBooks.previewInternal, s.args);
      expect(valid.classification).toBe("linkReady");
      const proof = s.args.reviewed.standalone;
      proof.extentStatement = passage;
      proof.capture.excerpt = `${proof.productTitle}\n${proof.isbn13}\n${passage}`;
      const before = await state(t);
      expect((await execute(t, s, valid.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(before);
      await refusal(t, s);
    },
  );

  it("accepts matching paperback statements and keeps contents numbers separate", async () => {
    for (const index of [0, 1, 2, 3]) {
      const t = makeT();
      const s = await seed(t, index);
      const proof = s.args.reviewed.standalone;
      const original = proof.extentStatement;
      proof.extentStatement += " Paperback format.";
      proof.capture.excerpt = proof.capture.excerpt.replace(original, proof.extentStatement);
      const p = await t.query(internal.heldBooks.previewInternal, s.args);
      expect(p.classification).toBe("linkReady");
      expect((await execute(t, s, p.expected!)).status).toBe("applied");
    }
  });

  it("links a synthetic ebook sibling only under its own exact ISBN and keeps all raw facts", async () => {
    // Protocol test using the publisher's real ebook SKU for the same anthology.
    // The ANN ebook line is synthetic; this test does not claim a staging hold exists.
    const t = makeT();
    const s = await seed(t);
    const isbn = "9781975321260";
    await t.run(async (ctx) => {
      const o = (await ctx.db.get(s.observationId))!;
      const raw = standaloneFixtures[1]!.snapshot;
      const snapshot = {
        ...raw,
        isbn13: isbn,
        format: "digital",
        page: { ...raw.page, isbn13: isbn, isbn10: "197532126X", volume: "eBook" },
      };
      await ctx.db.patch(o._id, { snapshot });
      await ctx.db.patch(s.releaseId, { isbn13: isbn, binding: undefined, format: "digital" });
      const p = (await ctx.db.get(s.parentId))!;
      await ctx.db.patch(p._id, { snapshot: { ...p.snapshot, releases: [snapshot] } });
    });
    const proof = s.args.reviewed.standalone;
    proof.isbn13 = isbn;
    proof.format = "digital";
    proof.binding = undefined;
    s.args.reviewed.isbn13 = isbn;
    let p = await t.query(internal.heldBooks.previewInternal, s.args);
    expect(p.refusal).toBeNull();
    proof.isbn13 = "9781975321253";
    await refusal(t, s);
    proof.isbn13 = isbn;
    p = await t.query(internal.heldBooks.previewInternal, s.args);
    expect(p.refusal).toBeNull();
    const originalPassage = proof.extentStatement;
    const originalExcerpt = proof.capture.excerpt;
    for (const passage of [
      "The complete story in paperback format.",
      "The complete story in a physical edition.",
      "The complete story. Format: unknown.",
    ]) {
      const valid = await t.query(internal.heldBooks.previewInternal, s.args);
      proof.extentStatement = passage;
      proof.capture.excerpt = `${proof.productTitle}\n${isbn}\n${passage}`;
      const before = await state(t);
      expect((await execute(t, s, valid.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(before);
      await refusal(t, s);
      proof.extentStatement = originalPassage;
      proof.capture.excerpt = originalExcerpt;
    }
    proof.extentStatement = "This ebook contains the complete story.";
    proof.capture.excerpt = `${proof.productTitle}\n${isbn}\n${proof.extentStatement}`;
    p = await t.query(internal.heldBooks.previewInternal, s.args);
    expect(p.classification).toBe("linkReady");
    const raw = await t.run(async (ctx) => (await ctx.db.get(s.observationId))!.snapshot);
    expect((await execute(t, s, p.expected!)).status).toBe("applied");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))!.snapshot).toEqual(raw);
      expect((await ctx.db.get(s.releaseId))!.isbn13).toBe(isbn);
      expect((await ctx.db.get(s.releaseId))!.binding).toBeUndefined();
    });
  });

  it("pins proof, every work Volume and source parent in the expected guard", async () => {
    for (const change of ["proof", "newVolume", "parent", "revision"]) {
      const t = makeT();
      const s = await seed(t);
      const p = await t.query(internal.heldBooks.previewInternal, s.args);
      expect(p.refusal).toBeNull();
      if (change === "proof") s.args.reviewed.standalone.extentStatement += " ";
      else
        await t.run(async (ctx) => {
          if (change === "newVolume")
            await insertVolume(ctx, { seriesId: s.seriesId, status: "hidden", label: undefined });
          if (change === "parent") await ctx.db.patch(s.parentId, { lastSeenAt: 999 });
          if (change === "revision")
            await insertSourceRevision(ctx, {
              sourceKey: "ann",
              ref: { type: "volume", id: s.volumeId },
              seq: 1,
              changes: [],
              comment: "review changed",
            });
        });
      const before = await state(t);
      expect((await execute(t, s, p.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(before);
    }
  });

  it("rolls back the source link and hold removal when audit insertion fails", async () => {
    const t = makeT();
    const s = await seed(t);
    const p = await t.query(internal.heldBooks.previewInternal, s.args);
    expect(p.refusal).toBeNull();
    const before = await state(t);
    const spy = vi.spyOn(moderation, "insertFirstVersion").mockImplementationOnce(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
        type: "release",
        id: s.releaseId,
      });
      expect(await ctx.db.get(s.holdId)).toBeNull();
      throw new Error("injected audit failure");
    });
    try {
      expect((await execute(t, s, p.expected!)).status).toBe("refused");
      expect(await state(t)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});
