import { expect, it, vi } from "vitest";
import type { AnnReleaseSnapshot } from "./ann";
import * as moderation from "./moderation";
import { internal } from "./_generated/api";
import { collectionProducts, collectionParent } from "./test.collectionProducts";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import {
  insertObservation,
  insertPublisher,
  insertSeries,
  insertVolume,
  insertSourceRevision,
} from "./test.factories";

async function seed(t: TestT, fixture = collectionProducts[0]!) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const rootId = await insertSeries(ctx, { title: "Parasyte" });
    const seriesId = await insertSeries(ctx, { title: fixture.seriesTitle });
    const volumeId = await insertVolume(ctx, { seriesId, label: fixture.snapshot.label });
    const book = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      release: {
        isbn13: fixture.isbn13,
        ...(fixture.isbn10 ? { isbn10: fixture.isbn10 } : {}),
        binding: fixture.binding,
      },
    });
    await insertSourceRevision(ctx, {
      sourceKey: "kodansha",
      ref: { type: "release", id: book.releaseId },
      changes: [],
    });
    await insertSourceRevision(ctx, {
      sourceKey: "kodansha",
      ref: { type: "edition", id: book.editionId },
      changes: [],
    });
    await ctx.db.insert("collectionEntries", { userId, releaseId: book.releaseId, state: "owned" });
    await ctx.db.insert("volumeProgress", { userId, volumeId, readCount: 2 });
    await ctx.db.insert("releaseProgress", {
      userId,
      releaseId: book.releaseId,
      seriesId,
      percent: 42,
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:1570",
      snapshot: collectionParent,
      recordRef: { type: "series", id: rootId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${fixture.snapshot.annId}`,
      snapshot: fixture.snapshot,
      conflicts: fixture.conflicts,
    });
    await ctx.db.insert("observationSnapshots", {
      observationId,
      snapshot: { retained: "previous raw capture" },
      supersededAt: 1,
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      heldAt: 40,
    });
    const reviewed = {
      isbn13: fixture.isbn13,
      seriesId,
      publisherId,
      volumeIds: [volumeId],
      evidenceUrls: fixture.evidenceUrls,
      sourceTitle: fixture.snapshot.title,
      collectionRouting: {
        sourceTitle: fixture.snapshot.title,
        productTitle: fixture.productTitle,
        productEvidence: fixture.productEvidence,
        productVolumeLabel: fixture.snapshot.label!,
        parentSeriesId: rootId,
        parentObservationId: parentId,
        binding: fixture.binding === "hardcover" ? ("hardcover" as const) : ("paperback" as const),
      },
    };
    return {
      ...book,
      publisherId,
      rootId,
      seriesId,
      volumeId,
      parentId,
      observationId,
      holdId,
      reviewed,
      target: { type: "release" as const, id: book.releaseId },
    };
  });
}
const preview = (t: TestT, s: Awaited<ReturnType<typeof seed>>) =>
  t.query(internal.heldBooks.previewSeriesReviewInternal, {
    observationId: s.observationId,
    target: s.target,
    reviewed: s.reviewed,
  });
async function apply(
  t: TestT,
  s: Awaited<ReturnType<typeof seed>>,
  expected: string,
  operation: "reviewSeries" | "link" = "reviewSeries",
) {
  return t.mutation(internal.heldBooks.executeInternal, {
    observationId: s.observationId,
    target: s.target,
    reviewed: s.reviewed,
    seriesId: s.seriesId,
    actor: "ari",
    operation,
    expected,
    reason: "Reviewed own ISBN publisher collection product and ANN membership.",
    evidenceUrls: s.reviewed.evidenceUrls,
  });
}
async function rows(t: TestT) {
  return t.run(async (ctx) => ({
    observations: await ctx.db.query("sourceObservations").collect(),
    holds: await ctx.db.query("placementHolds").collect(),
    ledger: await ctx.db.query("heldRepairLedger").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    versions: await ctx.db.query("proposalVersions").collect(),
    revisions: await ctx.db.query("revisions").collect(),
    printings: await ctx.db.query("releaseIsbns").collect(),
    collection: await ctx.db.query("collectionEntries").collect(),
    progress: await ctx.db.query("volumeProgress").collect(),
    releaseProgress: await ctx.db.query("releaseProgress").collect(),
    history: await ctx.db.query("observationSnapshots").collect(),
  }));
}
for (const fixture of collectionProducts) {
  it(`routes and links exact archived product ${fixture.isbn13}, preserving its root and raw history`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t, fixture);
    const before = await rows(t);
    const catalog = await t.run(async (ctx) => ({
      release: await ctx.db.get(s.releaseId),
      edition: await ctx.db.get(s.editionId),
      volume: await ctx.db.get(s.volumeId),
      series: await ctx.db.get(s.seriesId),
      root: await ctx.db.get(s.rootId),
    }));
    const p = await preview(t, s);
    expect(p.refusal).toBeNull();
    expect(p.ready).toBe(true);
    expect((await apply(t, s, p.expected!)).status).toBe("applied");
    const link = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
      target: s.target,
      reviewed: s.reviewed,
    });
    expect(link.classification).toBe("linkReady");
    expect((await apply(t, s, link.expected!, "link")).status).toBe("applied");
    const after = await rows(t);
    const obs = after.observations.find((o) => o._id === s.observationId)!;
    expect(obs.recordRef).toEqual(s.target);
    expect(obs.snapshot).toEqual(fixture.snapshot);
    expect(obs.conflicts).toEqual(fixture.conflicts.filter((c) => c.field !== "placement"));
    for (const conflict of fixture.conflicts)
      expect(JSON.stringify(after.versions)).toContain(conflict.reason);
    expect(after.observations.find((o) => o._id === s.parentId)).toEqual(
      before.observations.find((o) => o._id === s.parentId),
    );
    expect(after.holds).toHaveLength(0);
    expect(after.ledger).toHaveLength(2);
    expect(after.proposals).toHaveLength(before.proposals.length + 2);
    expect(after.history).toEqual(before.history);
    expect(after.collection).toEqual(before.collection);
    expect(after.progress).toEqual(before.progress);
    expect(after.releaseProgress).toEqual(before.releaseProgress);
    expect(after.revisions).toEqual(before.revisions);
    expect(JSON.stringify(after.versions)).toContain("collectionRouting");
    expect(
      await t.run(async (ctx) => ({
        release: await ctx.db.get(s.releaseId),
        edition: await ctx.db.get(s.editionId),
        volume: await ctx.db.get(s.volumeId),
        series: await ctx.db.get(s.seriesId),
        root: await ctx.db.get(s.rootId),
      })),
    ).toEqual(catalog);
  });
}

const negativeCases = [
  "wrong full name",
  "wrong root",
  "spinoff",
  "novel",
  "part",
  "ambiguous title",
  "wrong publisher",
  "wrong label",
  "wrong binding proof",
  "cross binding target",
  "missing target binding",
  "digital source",
  "digital target",
  "partial coverage",
  "unmapped coverage",
  "multi coverage",
  "package",
  "edition line hint",
  "gapped",
  "range",
  "edition line",
  "wrong parent membership",
  "wrong parent recordRef",
  "wrong parent snapshot id",
  "wrong parent observation",
  "withdrawn parent",
  "wrong record id",
  "source page isbn",
  "source ISBN",
  "alternate printing ISBN",
  "source isbn10",
  "source page title",
  "source page GN",
  "source page distributor",
  "source page parent",
  "competing isbn owner",
  "unknown scope",
  "wrong capture hash",
  "wrong product URL",
  "missing evidence URL",
  "wrong target work",
  "wrong target publisher",
  "duplicate parent membership",
  "missing successful page",
] as const;
for (const problem of negativeCases) {
  it(`refuses ${problem} without any incidental writes`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.get(s.observationId))!;
      const snapshot: AnnReleaseSnapshot = { ...collectionProducts[0]!.snapshot };
      const page = { ...snapshot.page! };
      switch (problem) {
        case "wrong full name":
          s.reviewed.collectionRouting.productTitle = "Parasyte Full Color Collection Extra 6";
          break;
        case "wrong root":
          await ctx.db.patch(s.rootId, { title: "Parasite" });
          break;
        case "spinoff":
          snapshot.title = "Neo Parasyte Full Color Collection [Hardcover]";
          break;
        case "novel":
          snapshot.title = "Parasyte Novel Full Color Collection [Hardcover]";
          break;
        case "part":
          snapshot.title = "Parasyte Part 1 Full Color Collection [Hardcover]";
          break;
        case "ambiguous title":
          snapshot.title = "Parasyte Full Color Collection / Parasyte Paperback Collection";
          break;
        case "wrong publisher":
          s.reviewed.publisherId = await insertPublisher(ctx, { name: "Vertical" });
          break;
        case "wrong label":
          s.reviewed.collectionRouting.productVolumeLabel = "7";
          break;
        case "wrong binding proof":
          s.reviewed.collectionRouting.binding = "paperback";
          break;
        case "cross binding target":
          await ctx.db.patch(s.releaseId, { binding: "paperback" });
          break;
        case "missing target binding":
          await ctx.db.patch(s.releaseId, { binding: undefined });
          break;
        case "digital source":
          snapshot.format = "digital";
          break;
        case "digital target":
          await ctx.db.patch(s.releaseId, { format: "digital" });
          break;
        case "partial coverage": {
          const row = (await ctx.db
            .query("volumeCoverages")
            .withIndex("by_edition", (q) => q.eq("editionId", s.editionId))
            .first())!;
          await ctx.db.patch(row._id, { extent: "partial" });
          break;
        }
        case "unmapped coverage":
          await ctx.db.patch(s.editionId, { coverageUnmapped: true });
          break;
        case "multi coverage": {
          const volumeId = await insertVolume(ctx, { seriesId: s.seriesId, label: "7" });
          await ctx.db.insert("volumeCoverages", {
            editionId: s.editionId,
            volumeId,
            order: 2,
            extent: "complete",
          });
          break;
        }
        case "package":
          snapshot.multi = true;
          break;
        case "edition line hint":
          snapshot.editionLineHint = true;
          break;
        case "gapped":
          snapshot.coverageGapped = true;
          break;
        case "range":
          snapshot.coverRange = { from: "6", to: "7" };
          break;
        case "edition line": {
          const editionLineId = await ctx.db.insert("editionLines", {
            seriesId: s.seriesId,
            publisherId: s.publisherId,
            status: "active",
            name: "Full Color",
          });
          await ctx.db.patch(s.editionId, { editionLineId });
          break;
        }
        case "wrong parent membership":
        case "duplicate parent membership": {
          const releases = collectionParent.releases.filter((r) => r.annId !== snapshot.annId);
          if (problem === "duplicate parent membership")
            releases.push(
              ...collectionParent.releases.filter((r) => r.annId === snapshot.annId),
              ...collectionParent.releases.filter((r) => r.annId === snapshot.annId),
            );
          await ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, releases } });
          break;
        }
        case "wrong parent recordRef":
          await ctx.db.patch(s.parentId, { recordRef: { type: "series", id: s.seriesId } });
          break;
        case "wrong parent snapshot id":
          await ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, id: "42" } });
          break;
        case "wrong parent observation":
          s.reviewed.collectionRouting.parentObservationId = s.observationId;
          break;
        case "withdrawn parent":
          await ctx.db.patch(s.parentId, { withdrawn: true });
          break;
        case "wrong record id":
          await ctx.db.patch(s.observationId, { sourceRecordId: "release:42" });
          break;
        case "source ISBN":
          snapshot.isbn13 = "9781646516452";
          break;
        case "alternate printing ISBN":
          await ctx.db.insert("releaseIsbns", {
            releaseId: s.releaseId,
            isbn13: s.reviewed.isbn13,
            reason: "Retained reviewed printing",
            sourceKey: "ann",
          });
          await ctx.db.patch(s.releaseId, {
            isbn13: "9781646516452",
            isbn10: undefined,
          });
          break;
        case "source page isbn":
          page.isbn13 = "9781646516452";
          break;
        case "source isbn10":
          page.isbn10 = "1646516451";
          break;
        case "source page title":
          page.title = "Parasyte Paperback Collection";
          break;
        case "source page GN":
          page.volume = "GN 7";
          break;
        case "source page distributor":
          page.distributor = "Vertical";
          break;
        case "source page parent":
          page.mangaId = "42";
          break;
        case "competing isbn owner":
          await insertBook(ctx, {
            publisherId: s.publisherId,
            seriesId: s.seriesId,
            volumeId: s.volumeId,
            release: { isbn13: s.reviewed.isbn13, binding: "hardcover" },
          });
          break;
        case "unknown scope":
          page.title = "Parasyte [Novel]";
          break;
        case "wrong capture hash":
          s.reviewed.collectionRouting.productEvidence = {
            ...s.reviewed.collectionRouting.productEvidence,
            sha256: "unknown",
          };
          break;
        case "wrong product URL":
          s.reviewed.collectionRouting.productEvidence = {
            ...s.reviewed.collectionRouting.productEvidence,
            url: "https://www.penguinrandomhouse.com/books/1/9781646516452",
          };
          break;
        case "missing evidence URL":
          s.reviewed.evidenceUrls = [snapshot.url];
          break;
        case "wrong target work":
          await ctx.db.patch(s.seriesId, { title: "Neo Parasyte Full Color Collection" });
          break;
        case "wrong target publisher": {
          const publisherId = await insertPublisher(ctx, { name: "Vertical" });
          await ctx.db.patch(s.releaseId, { publisherId });
          await ctx.db.patch(s.editionId, { publisherId });
          s.reviewed.publisherId = publisherId;
          break;
        }
        case "missing successful page":
          snapshot.page = { status: "error", fetchedAt: 1 };
          break;
      }
      if (problem !== "missing successful page") snapshot.page = page;
      // Preserve the original metadata not being varied by this counterexample.
      await ctx.db.patch(obs._id, { snapshot });
    });
    const before = await rows(t);
    const p = await preview(t, s);
    expect(p.ready).toBe(false);
    expect(p.expected).toBeNull();
    expect(p.refusal).toBeTruthy();
    expect((await apply(t, s, "invalid guard")).status).toBe("refused");
    expect(await rows(t)).toEqual(before);
  });
}

for (const drift of [
  "hold",
  "edition revision",
  "parent membership",
  "parent recordRef",
  "source page",
  "isbn owner",
  "proof",
] as const) {
  it(`invalidates the reviewed guard after ${drift} drift`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    const p = await preview(t, s);
    expect(p.ready).toBe(true);
    await t.run(async (ctx) => {
      switch (drift) {
        case "hold":
          await ctx.db.patch(s.holdId, { heldAt: 41 });
          break;
        case "edition revision":
          await insertSourceRevision(ctx, {
            sourceKey: "kodansha",
            ref: { type: "edition", id: s.editionId },
            changes: [],
          });
          break;
        case "parent membership":
          await ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, releases: [] } });
          break;
        case "parent recordRef":
          await ctx.db.patch(s.parentId, { recordRef: { type: "series", id: s.seriesId } });
          break;
        case "source page":
          await ctx.db.patch(s.observationId, {
            snapshot: {
              ...collectionProducts[0]!.snapshot,
              page: { ...collectionProducts[0]!.snapshot.page, priceCents: 1 },
            },
          });
          break;
        case "isbn owner":
          await insertBook(ctx, {
            publisherId: s.publisherId,
            seriesId: s.seriesId,
            volumeId: s.volumeId,
            release: { isbn13: s.reviewed.isbn13 },
          });
          break;
        case "proof":
          s.reviewed.collectionRouting.productEvidence = {
            ...s.reviewed.collectionRouting.productEvidence,
            sha256: "1".repeat(64),
          };
          break;
      }
    });
    const before = await rows(t);
    expect((await apply(t, s, p.expected!)).status).toBe("refused");
    expect(await rows(t)).toEqual(before);
  });
}

for (const operation of ["reviewSeries", "link"] as const) {
  it(`rolls back ${operation} when the audit fails after its writes`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    const p = await preview(t, s);
    let expected = p.expected;
    if (operation === "link") {
      expect((await apply(t, s, p.expected!)).status).toBe("applied");
      const link = await t.query(internal.heldBooks.previewInternal, {
        observationId: s.observationId,
        target: s.target,
        reviewed: s.reviewed,
      });
      expect(link.classification).toBe("linkReady");
      expected = link.expected;
    }
    const before = await rows(t);
    const spy = vi
      .spyOn(moderation, "insertFirstVersion")
      .mockRejectedValueOnce(new Error("Injected audit failure"));
    try {
      expect((await apply(t, s, expected!, operation)).status).toBe("refused");
    } finally {
      spy.mockRestore();
    }
    expect(await rows(t)).toEqual(before);
  });
}

it("requires a fresh link guard after routing and still refuses later parent drift", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await seed(t);
  const p = await preview(t, s);
  expect((await apply(t, s, p.expected!)).status).toBe("applied");
  const before = await rows(t);
  expect((await apply(t, s, p.expected!, "link")).status).toBe("refused");
  expect(await rows(t)).toEqual(before);
  const link = await t.query(internal.heldBooks.previewInternal, {
    observationId: s.observationId,
    target: s.target,
    reviewed: s.reviewed,
  });
  expect(link.classification).toBe("linkReady");
  await t.run((ctx) =>
    ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, releases: [] } }),
  );
  const drifted = await rows(t);
  expect((await apply(t, s, link.expected!, "link")).status).toBe("refused");
  expect(await rows(t)).toEqual(drifted);
});

// Stored parent rows can contradict a valid child page. Never erase or reinterpret those facts.
const parentCounterfacts = [
  { name: "range", facts: { coverRange: { from: "6", to: "7" } } },
  { name: "single-label range", facts: { coverRange: { from: "6", to: "6" } } },
  { name: "gap", facts: { coverageGapped: true } },
  { name: "package", facts: { multi: true } },
  { name: "edition line", facts: { editionLineHint: true } },
  { name: "digital format", facts: { format: "digital" } },
] as const;

async function contradictParent(
  t: TestT,
  s: Awaited<ReturnType<typeof seed>>,
  facts: (typeof parentCounterfacts)[number]["facts"],
) {
  await t.run(async (ctx) => {
    const releases = collectionParent.releases.map((row) =>
      row.annId === collectionProducts[0]!.snapshot.annId ? { ...row, ...facts } : row,
    );
    await ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, releases } });
  });
}

for (const operation of ["reviewSeries", "link"] as const) {
  for (const { name, facts } of parentCounterfacts) {
    it(`${operation} refuses a fresh parent ${name} counterfact without writes`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      if (operation === "link") {
        const route = await preview(t, s);
        expect(route.ready).toBe(true);
        expect((await apply(t, s, route.expected!)).status).toBe("applied");
      }
      await contradictParent(t, s, facts);
      const before = await rows(t);
      const route = await preview(t, s);
      expect(route.ready).toBe(false);
      expect(route.expected).toBeNull();
      expect(route.refusal).toContain("Collection parent");
      const link = await t.query(internal.heldBooks.previewInternal, {
        observationId: s.observationId,
        target: s.target,
        reviewed: s.reviewed,
      });
      expect(link.classification).toBe("incomplete");
      expect(link.expected).toBeNull();
      expect(link.refusal).toContain("Collection parent");
      // No guard is issued. Execution must independently refuse the facts before comparing a token.
      const result = await apply(t, s, "no guard issued for contradictory parent", operation);
      expect(result.status).toBe("refused");
      expect(JSON.stringify(result)).toContain("Collection parent");
      expect(await rows(t)).toEqual(before);
      expect(await t.run((ctx) => ctx.db.get(s.holdId))).not.toBeNull();
    });

    it(`${operation} refuses stale parent ${name} drift without writes`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      const route = await preview(t, s);
      expect(route.ready).toBe(true);
      let expected = route.expected!;
      if (operation === "link") {
        expect((await apply(t, s, expected)).status).toBe("applied");
        const link = await t.query(internal.heldBooks.previewInternal, {
          observationId: s.observationId,
          target: s.target,
          reviewed: s.reviewed,
        });
        expect(link.classification).toBe("linkReady");
        expected = link.expected!;
      }
      await contradictParent(t, s, facts);
      const before = await rows(t);
      expect((await apply(t, s, expected, operation)).status).toBe("refused");
      expect(await rows(t)).toEqual(before);
      expect(await t.run((ctx) => ctx.db.get(s.holdId))).not.toBeNull();
    });
  }
}
