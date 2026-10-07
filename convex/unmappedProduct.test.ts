import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { makeT, type TestT } from "./test.helpers";
import {
  insertPublisher,
  insertSeries,
  insertObservation,
  insertVolume,
  insertEdition,
  insertEditionLine,
  insertRelease,
  insertCoverage,
} from "./test.factories";
import { unmappedProductPackets, unmappedWorkSnapshot } from "./lib/unmappedProductProofs";
import { valueHash } from "./lib/values";
import * as observations from "./lib/observations";

// convex-test allocates local IDs. Remap only those IDs, preserving every actual
// batch-051 source byte, publisher fact, ISBN and parent snapshot in the tests.
const assignedIds = vi.hoisted(() => new Map<string, string>());
vi.mock("./lib/unmappedProductProofs", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/unmappedProductProofs")>();
  return {
    ...original,
    unmappedProductPackets: original.unmappedProductPackets.map((packet) => ({
      ...packet,
      get observationId() {
        return assignedIds.get(packet.sourceRecordId) ?? packet.observationId;
      },
    })),
    get unmappedParentObservationId() {
      return assignedIds.get("manga:7781") ?? original.unmappedParentObservationId;
    },
  };
});

async function fixture(t = makeT()) {
  const ids = await t.run(async (ctx) => {
    const actorId = await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, {
      title: "Pokémon Adventures",
      publicId: 4290,
      altTitles: [...unmappedWorkSnapshot.altTitles],
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:7781",
      snapshot: unmappedWorkSnapshot,
      recordRef: { type: "series", id: seriesId },
    });
    assignedIds.set("manga:7781", parentId);
    const observationIds = [];
    for (const packet of unmappedProductPackets) {
      const observationId = await insertObservation(ctx, {
        sourceKey: packet.sourceKey,
        sourceRecordId: packet.sourceRecordId,
        snapshot: packet.snapshot,
        conflicts: [
          { field: "placement", at: 1, reason: "Occupied ordinary global slot", offered: null },
          { field: "description", at: 1, reason: "Retained lower authority", offered: "retained" },
        ],
      });
      await ctx.db.insert("observationSnapshots", {
        observationId,
        snapshot: { retained: packet.sourceRecordId },
        supersededAt: 1,
      });
      await ctx.db.insert("placementHolds", {
        observationId,
        sourceKey: packet.sourceKey,
        seriesId,
        kind: "isbn",
        heldAt: 1,
      });
      assignedIds.set(packet.sourceRecordId, observationId);
      observationIds.push(observationId);
    }
    // Old ordinary books and hidden library products are separate legitimate records.
    const oldIsbns = [
      "9781421530581",
      "9781421530598",
      "9781421530604",
      "9781484403815",
      "9781421530628",
      "9781484423721",
    ];
    const oldReleaseIds = [];
    for (const [i, isbn13] of oldIsbns.entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, position: i + 5 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const releaseId = await insertRelease(ctx, {
        publisherId,
        editionId,
        seriesIds: [seriesId],
        isbn13,
        status: i === 3 || i === 5 ? "hidden" : "active",
      });
      await ctx.db.insert("collectionEntries", {
        userId: actorId,
        releaseId,
        state: "owned",
      });
      oldReleaseIds.push(releaseId);
    }
    return { actorId, publisherId, seriesId, parentId, observationIds, oldReleaseIds };
  });
  return { t, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function args(f: Fixture, index = 0) {
  return {
    observationId: f.observationIds[index]!,
    proof: {
      ...unmappedProductPackets[index]!.proof,
      pubDate: { ...unmappedProductPackets[index]!.proof.pubDate },
      seriesId: f.seriesId,
      publisherId: f.publisherId,
    },
  };
}
async function preview(f: Fixture, index = 0) {
  return await f.t.query(internal.heldRepair.previewUnmappedProductInternal, args(f, index));
}
async function apply(f: Fixture, index = 0) {
  const p = await preview(f, index);
  expect(p.refusal).toBeNull();
  expect(p.expected).toBeTruthy();
  return await f.t.mutation(internal.heldRepair.placeUnmappedProductInternal, {
    ...args(f, index),
    actor: "ari",
    expected: p.expected!,
  });
}
async function dump(t: TestT) {
  return await t.run(async (ctx) => {
    const tables = [
      "sourceObservations",
      "observationSnapshots",
      "placementHolds",
      "editionLines",
      "editions",
      "volumeCoverages",
      "volumes",
      "releases",
      "releaseIsbns",
      "proposals",
      "proposalVersions",
      "revisions",
      "heldRepairLedger",
      "collectionEntries",
      "volumeProgress",
      "releaseProgress",
      "counters",
    ] as const;
    return valueHash(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
  });
}
async function refuseWithoutWrites(f: Fixture, index = 0, expected?: string) {
  const before = await dump(f.t);
  const p = await preview(f, index);
  if (!expected) expect(p.expected).toBeNull();
  const result = await f.t.mutation(internal.heldRepair.placeUnmappedProductInternal, {
    ...args(f, index),
    actor: "ari",
    expected: expected ?? "refused",
  });
  expect(result.status).toBe("refused");
  expect(await dump(f.t)).toBe(before);
  return result;
}
async function newLine(ctx: MutationCtx, f: Fixture, overrides: Partial<Doc<"editionLines">> = {}) {
  return await insertEditionLine(ctx, {
    publisherId: f.publisherId,
    seriesId: f.seriesId,
    name: "Diamond and Pearl/Platinum",
    ...overrides,
  });
}

describe("batch-051 exact unmapped products", () => {
  it("rejects replacement observations even with the same assigned source key and raw packet", async () => {
    const f = await fixture();
    const replacement = await f.t.run(async (ctx) => {
      const packet = unmappedProductPackets[0]!;
      await ctx.db.delete(f.observationIds[0]!);
      return await insertObservation(ctx, {
        sourceKey: packet.sourceKey,
        sourceRecordId: packet.sourceRecordId,
        snapshot: packet.snapshot,
      });
    });
    const before = await dump(f.t);
    const result = await f.t.mutation(internal.heldRepair.placeUnmappedProductInternal, {
      ...args(f),
      observationId: replacement,
      actor: "ari",
      expected: "replacement",
    });
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("not assigned");
    expect(await dump(f.t)).toBe(before);
  });

  it("refuses a bounded-incomplete Edition Line closure", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const editionLineId = await newLine(ctx, f);
      for (let i = 0; i < 81; i++)
        await insertEdition(ctx, {
          publisherId: f.publisherId,
          editionLineId,
          linePosition: String(i + 100),
        });
    });
    const result = await refuseWithoutWrites(f);
    expect(result.reason).toContain("incomplete");
  });

  for (const mode of ["seriesLock", "publisherLock", "holdDrift", "queuedReview"] as const) {
    it(`rejects ${mode} after preview without incidental writes`, async () => {
      const f = await fixture();
      const p = await preview(f);
      await f.t.run(async (ctx) => {
        if (mode === "seriesLock") await ctx.db.patch(f.seriesId, { locked: true });
        else if (mode === "publisherLock") await ctx.db.patch(f.publisherId, { locked: true });
        else if (mode === "holdDrift") {
          const hold = (await ctx.db
            .query("placementHolds")
            .withIndex("by_observation", (q) => q.eq("observationId", f.observationIds[0]!))
            .unique())!;
          await ctx.db.patch(hold._id, { heldAt: 2 });
        } else {
          const proposalId = await ctx.db.insert("proposals", {
            state: "inReview",
            currentVersionNo: 1,
            author: { kind: "user", userId: f.actorId, roleAtAuthorship: "administrator" },
          });
          await ctx.db.patch(f.observationIds[0]!, { queuedProposalId: proposalId });
        }
      });
      await refuseWithoutWrites(f, 0, p.expected!);
    });
  }

  it("creates six actual SKUs and four dependent links, preserves raw history/old books/tracking, verifies retries and public policy", async () => {
    const f = await fixture();
    const old = await f.t.run(async (ctx) => ({
      releases: await Promise.all(f.oldReleaseIds.map((id) => ctx.db.get(id))),
      tracking: await ctx.db.query("collectionEntries").collect(),
      coverage: await ctx.db.query("volumeCoverages").collect(),
      volumes: await ctx.db.query("volumes").collect(),
      histories: await ctx.db.query("observationSnapshots").collect(),
    }));
    const created = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      const isbn = unmappedProductPackets[i]!.proof.isbn13;
      const result = await apply(f, i);
      expect(result.status).toBe(created.has(isbn) ? "linked" : "created");
      if (created.has(isbn)) expect(result.releaseId).toBe(created.get(isbn));
      created.set(isbn, result.releaseId!);
      expect(result.ledgerId).toBeTruthy();
    }
    expect(created.size).toBe(6);
    const state = await f.t.run(async (ctx) => ({
      old: {
        releases: await Promise.all(f.oldReleaseIds.map((id) => ctx.db.get(id))),
        tracking: await ctx.db.query("collectionEntries").collect(),
        coverage: await ctx.db.query("volumeCoverages").collect(),
        volumes: await ctx.db.query("volumes").collect(),
        histories: await ctx.db.query("observationSnapshots").collect(),
      },
      lines: await ctx.db.query("editionLines").collect(),
      editions: await ctx.db
        .query("editions")
        .withIndex("by_coverageUnmapped", (q) => q.eq("coverageUnmapped", true))
        .collect(),
      sources: await Promise.all(f.observationIds.map((id) => ctx.db.get(id))),
      holds: await ctx.db.query("placementHolds").collect(),
      ledgers: await ctx.db.query("heldRepairLedger").collect(),
      printings: await ctx.db.query("releaseIsbns").collect(),
    }));
    expect(state.old).toEqual(old);
    expect(state.lines).toHaveLength(1);
    expect(state.editions).toHaveLength(6);
    expect(state.holds).toHaveLength(0);
    expect(state.ledgers).toHaveLength(10);
    expect(state.printings).toHaveLength(0);
    for (const [i, source] of state.sources.entries()) {
      expect(source?.snapshot).toEqual(unmappedProductPackets[i]!.snapshot);
      expect(source?.printingIsbn13).toBeUndefined();
      expect(source?.conflicts).toHaveLength(1);
    }
    const beforeRetry = await dump(f.t);
    for (let i = 0; i < 10; i++) expect((await apply(f, i)).status).toBe("alreadyApplied");
    expect(await dump(f.t)).toBe(beforeRetry);
    const page = await f.t.query(api.catalogPages.editionPage, {
      publicId: state.editions[0]!.publicId,
    });
    expect(page?.edition.coverageUnmapped).toBe(true);
    expect(page?.coverage).toEqual([]);
    expect(page?.series[0]?.publicId).toBe(4290);
    const edition = state.editions[0]!;
    const release = await f.t.run((ctx) =>
      ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .unique(),
    );
    const ordinary = await f.t.query(internal.heldBooks.previewInternal, {
      observationId: f.observationIds[0]!,
      target: { type: "release", id: release!._id },
    });
    expect(ordinary.refusal).toContain("unmapped");
    const asAdmin = f.t.withIdentity({ subject: "admin" });
    await asAdmin.mutation(api.reading.startPass, { releaseId: release!._id });
    await asAdmin.mutation(api.reading.completePass, { releaseId: release!._id });
    expect(await f.t.run((ctx) => ctx.db.query("volumeProgress").collect())).toEqual([]);
  });

  it("rejects stale expected closure after competing source changes", async () => {
    const f = await fixture();
    const p = await preview(f);
    await f.t.run((ctx) => ctx.db.patch(f.observationIds[0]!, { lastSeenAt: 2 }));
    await refuseWithoutWrites(f, 0, p.expected!);
  });

  for (const mode of [
    "work",
    "format",
    "binding",
    "publisher",
    "position",
    "doubleISBN",
    "sourceParent",
    "unknownContents",
  ] as const) {
    it(`rejects ${mode} contradictions before writes`, async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        if (mode === "work")
          await ctx.db.patch(f.seriesId, { title: "Pokémon Diamond and Pearl Adventure!" });
        else if (mode === "sourceParent")
          await ctx.db.patch(f.parentId, {
            snapshot: { ...unmappedWorkSnapshot, title: "Another work" },
          });
        else {
          const original = unmappedProductPackets[0]!.snapshot;
          const patch =
            mode === "format"
              ? { format: "digital" }
              : mode === "binding"
                ? { binding: "hardcover" }
                : mode === "publisher"
                  ? { publishers: ["Kodansha"] }
                  : mode === "position"
                    ? { volumeLabel: "6" }
                    : mode === "doubleISBN"
                      ? { isbn10: "1421530597" }
                      : { coverRange: { from: "34", to: "35" } };
          await ctx.db.patch(f.observationIds[0]!, { snapshot: { ...original, ...patch } });
        }
      });
      await refuseWithoutWrites(f);
    });
  }

  for (const mode of [
    "unknownPublisherLine",
    "hiddenLine",
    "duplicateLine",
    "occupiedPosition",
    "hiddenISBN",
    "ISBN10Collision",
    "twoOwners",
    "printingISBN",
    "bundleISBN",
  ] as const) {
    it(`rejects ${mode} reservations with zero incidental writes`, async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        if (mode === "unknownPublisherLine") {
          const other = await insertPublisher(ctx, { name: "Other" });
          await newLine(ctx, f, { publisherId: other });
        } else if (mode === "hiddenLine") await newLine(ctx, f, { status: "hidden" });
        else if (mode === "duplicateLine") {
          await newLine(ctx, f);
          await newLine(ctx, f);
        } else if (mode === "occupiedPosition") {
          const lineId = await newLine(ctx, f);
          const editionId = await insertEdition(ctx, {
            publisherId: f.publisherId,
            editionLineId: lineId,
            linePosition: "5",
            coverageUnmapped: true,
          });
          await insertRelease(ctx, {
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            editionId,
            isbn13: "9781421530598",
          });
        } else if (mode === "printingISBN") {
          await ctx.db.insert("releaseIsbns", {
            releaseId: f.oldReleaseIds[0]!,
            isbn13: "9781421539133",
            sourceKey: "ann",
            reason: "Reserved",
          });
        } else if (mode === "bundleISBN") {
          await ctx.db.insert("releaseBundles", {
            status: "active",
            publicId: 900,
            publisherId: f.publisherId,
            name: "Unknown Bundle",
            isbn13: "9781421539133",
          });
        } else {
          const old = (await ctx.db.get(f.oldReleaseIds[0]!))!;
          await ctx.db.patch(
            old._id,
            mode === "ISBN10Collision"
              ? { isbn10: "1421539136" }
              : { isbn13: "9781421539133", status: mode === "hiddenISBN" ? "hidden" : "active" },
          );
          if (mode === "twoOwners")
            await ctx.db.patch(f.oldReleaseIds[1]!, { isbn10: "1421539136" });
        }
      });
      await refuseWithoutWrites(f);
    });
  }

  it("rejects position collision arriving after preview", async () => {
    const f = await fixture();
    const p = await preview(f);
    await f.t.run(async (ctx) => {
      const editionLineId = await newLine(ctx, f);
      await insertEdition(ctx, { publisherId: f.publisherId, editionLineId, linePosition: "5" });
    });
    await refuseWithoutWrites(f, 0, p.expected!);
  });

  for (const mode of [
    "coverage",
    "status",
    "missingLedger",
    "ledgerAfter",
    "proposal",
    "version",
    "linkRevision",
    "creationRevision",
    "link",
  ] as const) {
    it(`rejects retry ${mode} drift or missing native audit`, async () => {
      const f = await fixture();
      const created = await apply(f, 1);
      await f.t.run(async (ctx) => {
        const release = (await ctx.db.get(created.releaseId!))!;
        if (mode === "coverage") {
          const volumeId = await insertVolume(ctx, { seriesId: f.seriesId, position: 35 });
          await insertCoverage(ctx, { editionId: release.editionId, volumeId });
        } else if (mode === "status") await ctx.db.patch(release._id, { status: "hidden" });
        else if (mode === "missingLedger") await ctx.db.delete(created.ledgerId!);
        else if (mode === "ledgerAfter") await ctx.db.patch(created.ledgerId!, { after: "{}" });
        else if (mode === "proposal")
          await ctx.db.patch(created.proposalId!, { state: "rejected" });
        else if (mode === "version") {
          const v = (await ctx.db
            .query("proposalVersions")
            .withIndex("by_proposal", (q) => q.eq("proposalId", created.proposalId!))
            .unique())!;
          await ctx.db.delete(v._id);
        } else if (mode === "link")
          await ctx.db.patch(f.observationIds[1]!, { recordRef: undefined });
        else {
          const rows = await ctx.db
            .query("revisions")
            .withIndex("by_proposal", (q) => q.eq("proposalId", created.proposalId!))
            .collect();
          const row = rows.find((row) =>
            row.changes.some(
              (c) =>
                c.field ===
                (mode === "linkRevision" ? "sourceObservation" : "unmappedProductProof"),
            ),
          )!;
          await ctx.db.delete(row._id);
        }
      });
      await refuseWithoutWrites(f, 1);
      // The complementary OL packet must also refuse to trust a damaged creation.
      await refuseWithoutWrites(f, 2);
    });
  }

  it("rolls back canonical creation and hold cleanup on a failure after native linking", async () => {
    const f = await fixture();
    const p = await preview(f);
    const before = await dump(f.t);
    const original = observations.linkObservation;
    const spy = vi
      .spyOn(observations, "linkObservation")
      .mockImplementation(async (...callArgs) => {
        await original(...callArgs);
        throw new Error("Injected after native link");
      });
    try {
      const result = await f.t.mutation(internal.heldRepair.placeUnmappedProductInternal, {
        ...args(f),
        expected: p.expected!,
        actor: "ari",
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("Injected");
      expect(await dump(f.t)).toBe(before);
    } finally {
      spy.mockRestore();
    }
    expect((await apply(f)).status).toBe("created");
  });
});
