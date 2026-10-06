// Practical held repairs using the 2026-10-06 staging source records and
// ordinary operator workflows. Canonical IDs are local fixtures, never live IDs.
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { evidenceUrls } from "./lib/scope";
import {
  insertBundle,
  insertBundleMember,
  insertEditionLine,
  insertEdition,
  insertCoverage,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertVariant,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import { sailorMoon, cirque } from "./test.heldAliases";
import { nonAnnAliasCases } from "./test.heldNonAnnAliases";
import { annContentFacts } from "./lib/ann";
import { parseEditionJson } from "./lib/openLibrary";
import {
  projectSourceFormat,
  reviewedFormatRefusal,
  type ReviewedFormat,
} from "./lib/sourceFormat";
import { valueHash } from "./lib/values";
import { sourceFormatEvidence, gachaPhysicalGraph } from "./test.sourceFormats";
import { placementChanged, placementView } from "./placement";
import { reader, sourceSeries } from "./lib/heldBooks";

const reason = "Exact source/product and complete canonical contents reviewed.";
const urls = ["https://www.animenewsnetwork.com/encyclopedia/releases.php?id=43552"];
async function admin(t: TestT) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    }),
  );
}
/** Real held ANN 43552, ISBN 9781645057345, source GN 3. */
async function dance(t: TestT) {
  await admin(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    const seriesId = await insertSeries(ctx, {
      title: "Dance in the Vampire Bund: Age of Scarlet Order",
    });
    const volumeId = await insertVolume(ctx, { seriesId, label: "3", position: 3 });
    const editionLineId = await insertEditionLine(ctx, {
      seriesId,
      publisherId,
      name: "Paperback",
    });
    const { editionId, releaseId } = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      edition: { editionLineId, linePosition: "3" },
      release: { isbn13: "9781645057345", binding: "paperback" },
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:22820",
      snapshot: { kind: "annManga", title: "Dance in the Vampire Bund: Age of Scarlet Order" },
      recordRef: { type: "series", id: seriesId },
    });
    const snapshot = {
      kind: "annRelease",
      annId: "43552",
      mangaId: "22820",
      title: "Dance in the Vampire Bund: Age of Scarlet Order",
      isbn13: "9781645057345",
      label: "3",
      format: "physical",
      multi: false,
      editionLineHint: false,
      url: urls[0],
      page: {
        status: "ok",
        volume: "GN 3",
        distributor: "Seven Seas Entertainment",
        isbn13: "9781645057345",
        fetchedAt: 1790500926477,
      },
    };
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:43552",
      snapshot,
      lastSeenAt: 1791147316483,
      conflicts: [{ field: "placement", reason: "Held under source Series", offered: null, at: 1 }],
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 10,
    });
    return {
      publisherId,
      seriesId,
      volumeId,
      editionId,
      releaseId,
      parentId,
      observationId,
      holdId,
    };
  });
}
const linkArgs = (s: Awaited<ReturnType<typeof dance>>) => ({
  observationId: s.observationId,
  target: { type: "release" as const, id: s.releaseId },
});

async function nonAnnAlias(t: TestT, row: (typeof nonAnnAliasCases)[number]) {
  await admin(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, row.publisher);
    const seriesId = await insertSeries(ctx, row.series);
    const heldSeriesId = row.heldSeries ? await insertSeries(ctx, row.heldSeries) : seriesId;
    const volumeIds = [];
    for (const fields of row.volumes)
      volumeIds.push(await insertVolume(ctx, { ...fields, seriesId }));
    const editionId = await insertEdition(ctx, { publisherId });
    for (const [i, volumeId] of volumeIds.entries())
      await insertCoverage(ctx, { editionId, volumeId, order: i + 1 });
    const releaseId = await insertRelease(ctx, {
      ...row.release,
      publisherId,
      editionId,
      seriesIds: [seriesId],
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: row.source.key,
      snapshot: row.source,
      lastSeenAt: row.lastSeenAt,
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: row.holdKind,
      seriesId: heldSeriesId,
      heldAt: row.heldAt,
    });
    return { publisherId, seriesId, volumeIds, editionId, releaseId, observationId, holdId };
  });
}

describe("reviewed non-ANN canonical work aliases", () => {
  it.each(nonAnnAliasCases)(
    "checks captured $source.title without replacing source text",
    async (row) => {
      const t = makeT();
      const s = await nonAnnAlias(t, row);
      const args = {
        observationId: s.observationId,
        target: { type: "release" as const, id: s.releaseId },
        reviewed: {
          isbn13: row.source.isbn13!,
          seriesId: s.seriesId,
          publisherId: s.publisherId,
          volumeIds: s.volumeIds,
          evidenceUrls: [row.source.url],
        },
      };
      const preview = await t.query(internal.heldBooks.previewInternal, args);
      if (row.ready) expect(preview.refusal).toBeNull();
      else expect(preview.refusal).not.toBeNull();
      const before = await repairState(t);
      const applied = await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        expected: preview.expected ?? "incomplete",
        operation: "link",
        reason,
        evidenceUrls: [row.source.url],
      });
      if (!row.ready) {
        expect(applied.status).toBe("refused");
        expect(await repairState(t)).toEqual(before);
        return;
      }
      expect(applied.status).toBe("applied");
      await t.run(async (ctx) => {
        const observation = (await ctx.db.get(s.observationId))!;
        expect(observation.snapshot).toEqual(row.source);
        expect(observation.lastSeenAt).toBe(row.lastSeenAt);
        expect(observation.recordRef).toEqual({ type: "release", id: s.releaseId });
        expect(await ctx.db.get(s.holdId)).toBeNull();
      });
      const after = await repairState(t);
      expect(after.releases).toEqual(before.releases);
      expect(after.editions).toEqual(before.editions);
      expect(after.volumes).toEqual(before.volumes);
    },
  );

  it("requires current independent aliases, pins their changes and rejects unrelated Part or reviewed-title substitutions", async () => {
    const row = nonAnnAliasCases[0]!;
    const t = makeT();
    const s = await nonAnnAlias(t, row);
    const args = {
      observationId: s.observationId,
      target: { type: "release" as const, id: s.releaseId },
      reviewed: {
        isbn13: row.source.isbn13!,
        seriesId: s.seriesId,
        publisherId: s.publisherId,
        volumeIds: s.volumeIds,
        evidenceUrls: [row.source.url],
      },
    };
    const preview = await t.query(internal.heldBooks.previewInternal, args);
    expect(preview.refusal).toBeNull();
    await t.run((ctx) => ctx.db.patch(s.seriesId, { altTitles: [] }));
    const changed = await repairState(t);
    expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).not.toBeNull();
    expect(
      (
        await t.mutation(internal.heldBooks.executeInternal, {
          ...args,
          actor: "ari",
          expected: preview.expected!,
          operation: "link",
          reason,
          evidenceUrls: [row.source.url],
        })
      ).status,
    ).toBe("refused");
    expect(await repairState(t)).toEqual(changed);
    await t.run((ctx) => ctx.db.patch(s.seriesId, { altTitles: row.series.altTitles }));
    await t.run((ctx) => insertSeries(ctx, { title: "7thGARDEN Part 2" }));
    const title = "7thGARDEN Part 2, Vol. 3";
    await t.run((ctx) =>
      ctx.db.patch(s.observationId, {
        snapshot: { ...row.source, title, seriesTitle: "7thGARDEN Part 2" },
      }),
    );
    const wrongPart = await t.query(internal.heldBooks.previewInternal, {
      ...args,
      reviewed: { ...args.reviewed, sourceTitle: title },
    });
    expect(wrongPart.refusal).toMatch(/parent Series disagrees/);
  });
});

describe("guarded held-book workflows", () => {
  it("links real Sailor Moon through its current declared alias and independent parent, with stale atomic refusal and restoration", async () => {
    const t = makeT();
    await admin(t);
    const s = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: sailorMoon.source.page.distributor });
      const seriesId = await insertSeries(ctx, sailorMoon.series);
      const volumeId = await insertVolume(ctx, { seriesId, label: "6", position: 6 });
      const editionLineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId,
        name: "Paperback",
      });
      const book = await insertBook(ctx, {
        seriesId,
        publisherId,
        volumeId,
        edition: { editionLineId, linePosition: "6" },
        release: { isbn13: sailorMoon.release.isbn13, binding: sailorMoon.release.binding },
      });
      const parentId = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:1578",
        snapshot: sailorMoon.parent,
        recordRef: { type: "series", id: seriesId },
      });
      const observationId = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:19983",
        snapshot: sailorMoon.source,
        lastSeenAt: 1791147316483,
      });
      const holdId = await ctx.db.insert("placementHolds", {
        observationId,
        sourceKey: "ann",
        kind: "isbn",
        seriesId,
        heldAt: 10,
      });
      return { ...book, seriesId, parentId, observationId, holdId };
    });
    const args = {
      observationId: s.observationId,
      target: { type: "release" as const, id: s.releaseId },
    };
    const evidenceUrls = [sailorMoon.source.url];
    const preview = await t.query(internal.heldBooks.previewInternal, args);
    const old = await t.query(internal.printings.linkHeldStateInternal, {
      observationId: s.observationId,
      releaseId: s.releaseId,
    });
    expect(preview.refusal).toBeNull();
    expect(old.refusal).toBeNull();
    await t.run((ctx) => ctx.db.patch(s.seriesId, { altTitles: [] }));
    const withoutAlias = await repairState(t);
    expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toMatch(
      /work identity/,
    );
    expect(
      (
        await t.mutation(internal.heldBooks.executeInternal, {
          ...args,
          actor: "ari",
          operation: "link",
          expected: preview.expected!,
          reason,
          evidenceUrls,
        })
      ).status,
    ).toBe("refused");
    expect(await repairState(t)).toEqual(withoutAlias);
    await t.run((ctx) => ctx.db.patch(s.seriesId, { altTitles: sailorMoon.series.altTitles }));
    const otherId = await t.run((ctx) => insertSeries(ctx, sailorMoon.series));
    await t.run((ctx) => ctx.db.patch(s.parentId, { recordRef: { type: "series", id: otherId } }));
    const wrongParent = await repairState(t);
    expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toMatch(
      /parent Series disagrees/,
    );
    expect(
      (
        await t.mutation(internal.printings.linkHeldInternal, {
          actor: "ari",
          observationId: s.observationId,
          releaseId: s.releaseId,
          expected: old.guard!,
          reason,
          evidenceUrls,
        })
      ).status,
    ).toBe("refused");
    expect(await repairState(t)).toEqual(wrongParent);
    await t.run((ctx) =>
      ctx.db.patch(s.parentId, { recordRef: { type: "series", id: s.seriesId } }),
    );
    const beforeLink = await t.run(async (ctx) => ({
      observation: await ctx.db.get(s.observationId),
      hold: await ctx.db.get(s.holdId),
    }));
    const fresh = await t.query(internal.heldBooks.previewInternal, args);
    expect(fresh.refusal).toBeNull();
    const linked = await t.mutation(internal.heldBooks.executeInternal, {
      ...args,
      actor: "ari",
      operation: "link",
      expected: fresh.expected!,
      reason,
      evidenceUrls,
    });
    expect(linked.status).toBe("applied");
    const ledger = await t.run((ctx) => ctx.db.get(linked.ledgerId!));
    expect(
      (
        await t.mutation(internal.heldBooks.restoreInternal, {
          actor: "ari",
          ledgerId: linked.ledgerId!,
          expectedAfter: ledger!.after,
          reason: "Restore alias workflow fixture.",
        })
      ).status,
    ).toBe("applied");
    await t.run(async (ctx) => {
      const observation = await ctx.db.get(s.observationId);
      const hold = await ctx.db.query("placementHolds").unique();
      expect(observation).toEqual(beforeLink.observation);
      const { _id, _creationTime, ...holdFacts } = hold!;
      const { _id: originalId, _creationTime: originalTime, ...originalFacts } = beforeLink.hold!;
      expect(holdFacts).toEqual(originalFacts);
    });
    const freshOld = await t.query(internal.printings.linkHeldStateInternal, {
      observationId: s.observationId,
      releaseId: s.releaseId,
    });
    expect(freshOld.refusal).toBeNull();
    expect(
      (
        await t.mutation(internal.printings.linkHeldInternal, {
          actor: "ari",
          observationId: s.observationId,
          releaseId: s.releaseId,
          expected: freshOld.guard!,
          reason,
          evidenceUrls,
        })
      ).status,
    ).toBe("linked");
  });

  it("keeps real Cirque du Freak omnibus held when its full source states no contents and the public fixture supplies no canonical coverage", async () => {
    const t = makeT();
    await admin(t);
    const s = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: cirque.source.page.distributor });
      const seriesId = await insertSeries(ctx, cirque.series);
      const editionLineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId,
        name: "Omnibus Edition",
      });
      // The supplied public record has no Edition/coverage snapshot. Do not invent its contents.
      const editionId = await insertEdition(ctx, {
        publisherId,
        editionLineId,
        linePosition: "5",
        coverageUnmapped: true,
      });
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: cirque.release.isbn13,
        binding: cirque.release.binding,
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:8436",
        snapshot: cirque.parent,
        recordRef: { type: "series", id: seriesId },
      });
      const observationId = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:57382",
        snapshot: cirque.source,
      });
      await ctx.db.insert("placementHolds", {
        observationId,
        sourceKey: "ann",
        kind: "isbn",
        seriesId,
        heldAt: 10,
      });
      return { releaseId, observationId, seriesId };
    });
    const facts = annContentFacts(cirque.source, [cirque.series.title, ...cirque.series.altTitles]);
    expect(facts.title).toMatchObject({ work: "Cirque Du Freak" });
    expect(facts.coverRange).toBeNull();
    expect(facts.position).toBe("5");
    const unselected = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
    });
    expect(unselected.sourceSeriesId).toBe(s.seriesId);
    expect(unselected.classification).toBe("needsDisposition");
    await refusedLink(
      t,
      { observationId: s.observationId, target: { type: "release", id: s.releaseId } },
      /contents are unmapped/,
    );
    expect((await t.run((ctx) => ctx.db.get(s.observationId)))?.snapshot).toEqual(cirque.source);
  });

  it("refuses a draft that assigns the real box ISBN to a new Release and a Bundle together", async () => {
    const t = makeT();
    const s = await dance(t);
    const bundleId = await t.run((ctx) =>
      insertBundle(ctx, { publisherId: s.publisherId, format: "physical", name: "Box set" }),
    );
    await expect(
      t.withIdentity({ subject: "admin" }).mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "create",
            table: "releases",
            tempId: "box-release",
            fields: {
              editionId: s.editionId,
              format: "physical",
              language: "en",
              isbn13: "9781632367006",
            },
          },
          {
            kind: "update",
            ref: { type: "releaseBundle", id: bundleId },
            changes: [{ field: "isbn13", value: "9781632367006" }],
          },
        ],
        evidence: [{ kind: "url", url: "https://kodansha.us/" }],
        comment: "Review the exact box ISBN namespace.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(bundleId))?.isbn13).toBeUndefined();
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
      expect((await ctx.db.query("releases").collect()).length).toBe(1);
    });
  });

  it("hides the proved Grimgar novel Release while retaining its manga Volume, Edition, comment and historical source IDs", async () => {
    const t = makeT();
    const userId = await admin(t);
    const s = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Seven Seas Entertainment" });
      const seriesId = await insertSeries(ctx, { title: "Grimgar of Fantasy and Ash" });
      const volumeId = await insertVolume(ctx, { seriesId, label: "2", position: 2 });
      const book = await insertBook(ctx, {
        publisherId,
        seriesId,
        volumeId,
        release: { isbn13: "9781626926608", isbn10: "1626926603", binding: "paperback" },
      });
      const sourceId = await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL27387937M",
        recordRef: { type: "release", id: book.releaseId },
        snapshot: {
          kind: "olEdition",
          title: "Grimgar of Fantasy and Ash  Vol. 2",
          isbn13: "9781626926608",
        },
      });
      const commentId = await ctx.db.insert("comments", {
        userId,
        seriesId,
        volumeId,
        body: "Private comment body",
        spoiler: true,
        status: "approved",
        reportCount: 0,
        createdAt: 0,
      });
      const commentAuditId = await ctx.db.insert("commentAudit", {
        commentId,
        action: "approve",
        actor: { kind: "user", userId },
        reason: "Private moderation reason",
      });
      const commentReportId = await ctx.db.insert("commentReports", {
        commentId,
        reporterId: userId,
        reason: "other",
        note: "Private report detail",
        createdAt: 0,
      });
      return { ...book, seriesId, volumeId, sourceId, commentId, commentAuditId, commentReportId };
    });
    expect(
      (await t.query(internal.heldRepair.scopedReleaseStateInternal, { releaseId: s.releaseId }))
        .refusal,
    ).toMatch(/scope decision/);
    const scope = await t.query(internal.scope.stateInternal, { isbn: "9781626926608" });
    const evidenceUrls = ["https://penguinrandomhouselibrary.com/book/?isbn=9781626926608"];
    await t.mutation(internal.scope.decideInternal, {
      actor: "ari",
      isbn13: "9781626926608",
      reason: "novel",
      evidenceUrls,
      expected: scope.expected,
    });
    const preview = await t.query(internal.heldRepair.scopedReleaseStateInternal, {
      releaseId: s.releaseId,
    });
    expect(preview.refusal).toBeNull();
    expect(JSON.stringify(preview)).not.toContain("Private comment body");
    expect(JSON.stringify(preview)).not.toContain("Private moderation reason");
    expect(JSON.stringify(preview)).not.toContain("Private report detail");
    expect(preview.privateCounts?.commentAudit).toBe(1);
    expect(preview.privateCounts?.commentReports).toBe(1);
    const progressId = await t.run((ctx) =>
      ctx.db.insert("releaseProgress", {
        userId,
        releaseId: s.releaseId,
        seriesId: s.seriesId,
        percent: 50,
      }),
    );
    const args = {
      actor: "ari",
      releaseId: s.releaseId,
      expected: preview.expected!,
      reason: "Exact publisher identifies this ISBN as Light Novel; retain the manga structure.",
      evidenceUrls,
    };
    expect((await t.mutation(internal.heldRepair.hideScopedReleaseInternal, args)).status).toBe(
      "refused",
    );
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.releaseId))?.status).toBe("active");
      await ctx.db.delete(progressId);
    });
    const fresh = await t.query(internal.heldRepair.scopedReleaseStateInternal, {
      releaseId: s.releaseId,
    });
    expect(
      (
        await t.mutation(internal.heldRepair.hideScopedReleaseInternal, {
          ...args,
          expected: fresh.expected!,
        })
      ).status,
    ).toBe("applied");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.releaseId))?.status).toBe("hidden");
      expect((await ctx.db.get(s.editionId))?.status).toBe("active");
      expect((await ctx.db.get(s.volumeId))?.status).toBe("active");
      expect((await ctx.db.get(s.commentId))?.body).toBe("Private comment body");
      expect((await ctx.db.get(s.commentAuditId))?.commentId).toBe(s.commentId);
      expect((await ctx.db.get(s.commentReportId))?.commentId).toBe(s.commentId);
      expect((await ctx.db.get(s.sourceId))?.recordRef).toEqual({
        type: "release",
        id: s.releaseId,
      });
      expect(JSON.stringify(await ctx.db.query("revisions").collect())).not.toContain(
        "Private comment body",
      );
    });
  });

  it("pins the current canonical slot before replaying a stored ANN observation", async () => {
    const t = makeT();
    const s = await dance(t);
    await t.run((ctx) => ctx.db.patch(s.releaseId, { isbn13: undefined }));
    const args = { observationId: s.observationId, replay: true };
    const preview = await t.query(internal.heldBooks.previewInternal, args);
    expect(preview.expected).toBeTruthy();
    await t.run((ctx) => ctx.db.patch(s.volumeId, { locked: true }));
    const result = await t.mutation(internal.heldBooks.executeInternal, {
      ...args,
      actor: "ari",
      operation: "replay",
      expected: preview.expected!,
      reason,
      evidenceUrls: urls,
    });
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/changed/);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.recordRef).toBeUndefined();
      expect((await ctx.db.get(s.holdId))?.heldAt).toBe(10);
      expect(await ctx.db.query("heldRepairLedger").collect()).toEqual([]);
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
    });
    await t.run((ctx) => ctx.db.patch(s.volumeId, { locked: false }));
    const fresh = await t.query(internal.heldBooks.previewInternal, args);
    const applied = await t.mutation(internal.heldBooks.executeInternal, {
      ...args,
      actor: "ari",
      operation: "replay",
      expected: fresh.expected!,
      reason,
      evidenceUrls: urls,
    });
    expect(applied.status).toBe("applied");
    expect(applied.releaseId).toBeTruthy();
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.lastSeenAt).toBe(1791147316483);
      expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
        type: "release",
        id: applied.releaseId,
      });
      const ledger = await ctx.db.get(applied.ledgerId!);
      expect(ledger?.createdStructure?.newVolumeIds).toEqual([]);
      expect(ledger?.createdStructure?.volumeIds).toEqual([s.volumeId]);
      expect((await ctx.db.get(s.editionId))?.status).toBe("active");
    });
  });

  it("preserves the explicit existing-Edition move without changing the source coverage or Series", async () => {
    const t = makeT();
    const s = await dance(t);
    const into = await t.run(async (ctx) => {
      const editionLineId = await insertEditionLine(ctx, {
        seriesId: s.seriesId,
        publisherId: s.publisherId,
        name: "Reviewed omnibus",
      });
      const editionId = await insertEdition(ctx, {
        publisherId: s.publisherId,
        editionLineId,
        linePosition: "1",
        coverageUnmapped: true,
      });
      return { editionId, editionLineId, linePosition: "1" };
    });
    const entry = {
      kind: "remodelEdition" as const,
      key: "held-existing-edition-move",
      reason,
      editionId: s.editionId,
      volumeId: s.volumeId,
      targetSeriesId: s.seriesId,
      line: null,
      bundle: null,
      retireVolumeIds: [],
      groups: [
        {
          coverage: [{ volumeId: s.volumeId, label: "3", extent: "complete" as const }],
          linePosition: null,
          releaseIds: [],
        },
        { coverage: [], linePosition: null, releaseIds: [s.releaseId], into },
      ],
    };
    await t.run((ctx) => ctx.db.patch(s.publisherId, { locked: true }));
    expect(
      (
        await t.mutation(internal.repair.runBatch, {
          entries: [entry],
          dryRun: false,
          actor: "ari",
        })
      )[0]?.status,
    ).toBe("skipped");
    await t.run((ctx) => ctx.db.patch(s.publisherId, { locked: false }));
    expect(
      (
        await t.mutation(internal.repair.runBatch, {
          entries: [entry],
          dryRun: false,
          actor: "ari",
        })
      )[0]?.status,
    ).toBe("applied");
    await t.run(async (ctx) => {
      const release = await ctx.db.get(s.releaseId);
      expect(release?.editionId).toBe(into.editionId);
      expect(release?.seriesIds).toEqual([s.seriesId]);
      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", s.editionId))
        .collect();
      expect(coverage.map((row) => row.volumeId)).toEqual([s.volumeId]);
      expect((await ctx.db.get(into.editionId))?.coverageUnmapped).toBe(true);
      expect((await ctx.db.get(s.parentId))?.recordRef).toEqual({ type: "series", id: s.seriesId });
    });
    expect(
      (
        await t.mutation(internal.repair.runBatch, {
          entries: [entry],
          dryRun: false,
          actor: "ari",
        })
      )[0]?.status,
    ).toBe("alreadyApplied");
  });

  it("links a single book on a Line with one complete Volume, refuses drift, and restores exact hold facts/age", async () => {
    const t = makeT();
    const s = await dance(t);
    const old = await t.query(internal.printings.linkHeldStateInternal, {
      observationId: s.observationId,
      releaseId: s.releaseId,
    });
    expect(old.refusal).toBeNull();
    expect(old.guard).not.toBeNull();
    const { context, ...legacy } = old.guard!;
    expect(
      (
        await t.mutation(internal.printings.linkHeldInternal, {
          actor: "ari",
          observationId: s.observationId,
          releaseId: s.releaseId,
          reason,
          evidenceUrls: urls,
          expected: legacy,
        })
      ).status,
    ).toBe("refused");
    const preview = await t.query(internal.heldBooks.previewInternal, linkArgs(s));
    expect(preview.refusal).toBeNull();
    await t.run((ctx) => ctx.db.patch(s.holdId, { heldAt: 11 }));
    const stale = await t.mutation(internal.heldBooks.executeInternal, {
      ...linkArgs(s),
      actor: "ari",
      operation: "link",
      expected: preview.expected!,
      reason,
      evidenceUrls: urls,
    });
    expect(stale.status).toBe("refused");
    expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toEqual([]);
    const fresh = await t.query(internal.heldBooks.previewInternal, linkArgs(s));
    const result = await t.mutation(internal.heldBooks.executeInternal, {
      ...linkArgs(s),
      actor: "ari",
      operation: "link",
      expected: fresh.expected!,
      reason,
      evidenceUrls: urls,
    });
    expect(result.status).toBe("applied");
    const ledger = await t.run((ctx) => ctx.db.get(result.ledgerId!));
    const restored = await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: result.ledgerId!,
      expectedAfter: ledger!.after,
      reason: "Undo reviewed metadata link.",
    });
    expect(restored.status).toBe("applied");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.lastSeenAt).toBe(1791147316483);
      expect((await ctx.db.query("placementHolds").unique())?.heldAt).toBe(11);
      expect((await ctx.db.get(s.releaseId))?.status).toBe("active");
    });
  });
  it("refuses a partial Edition and a changed source parent without writing", async () => {
    const t = makeT();
    const s = await dance(t);
    const preview = await t.query(internal.heldBooks.previewInternal, linkArgs(s));
    await t.run((ctx) => ctx.db.patch(s.parentId, { withdrawn: true }));
    expect(
      (
        await t.mutation(internal.heldBooks.executeInternal, {
          ...linkArgs(s),
          actor: "ari",
          operation: "link",
          expected: preview.expected!,
          reason,
          evidenceUrls: urls,
        })
      ).status,
    ).toBe("refused");
    await t.run(async (ctx) => {
      await ctx.db.patch(s.parentId, { withdrawn: false });
      const row = await ctx.db.query("volumeCoverages").unique();
      await ctx.db.patch(row!._id, { extent: "partial" });
    });
    expect((await t.query(internal.heldBooks.previewInternal, linkArgs(s))).expected).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toEqual([]);
  });
  it("clears a proven Grimgar novel hold, preserves freshness, requires revoke before restoration, and makes repeated decisions no-ops", async () => {
    const t = makeT();
    await admin(t);
    const observationId = await t.run(async (ctx) => {
      const id = await insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL30542716M",
        snapshot: {
          kind: "olEdition",
          key: "/books/OL30542716M",
          title: "Grimgar of Fantasy and Ash  Vol. 14.5",
          seriesTitle: "Grimgar of Fantasy and Ash",
          volumeLabel: "14.5",
          publishers: ["Seven Seas", "Airship"],
          format: "physical",
          isbn13: "9781645057697",
          url: "https://openlibrary.org/books/OL30542716M",
          multiVolume: false,
        },
        lastSeenAt: 1791144451259,
      });
      await ctx.db.insert("placementHolds", {
        observationId: id,
        sourceKey: "openlibrary",
        kind: "volumeMissing",
        heldAt: 20,
      });
      return id;
    });
    const state = await t.query(internal.scope.stateInternal, { isbn: "9781645057697" });
    const decision = await t.mutation(internal.scope.decideInternal, {
      actor: "ari",
      isbn13: "9781645057697",
      reason: "novel",
      evidenceUrls: [
        "https://sevenseasentertainment.com/books/grimgar-of-fantasy-and-ash-light-novel-vol-14-5/",
      ],
      expected: state.expected,
    });
    const current = await t.query(internal.scope.stateInternal, { isbn: "1645057690" });
    expect(
      (
        await t.mutation(internal.scope.decideInternal, {
          actor: "ari",
          isbn13: "9781645057697",
          reason: "novel",
          evidenceUrls: current.active!.evidenceUrls,
          expected: current.expected,
        })
      ).status,
    ).toBe("alreadyApplied");
    const preview = await t.query(internal.heldBooks.previewInternal, { observationId });
    const cleared = await t.mutation(internal.heldBooks.executeInternal, {
      actor: "ari",
      observationId,
      operation: "refreshSource",
      expected: preview.expected!,
      reason,
      evidenceUrls: current.active!.evidenceUrls,
    });
    expect(cleared.status).toBe("applied");
    const ledger = await t.run((ctx) => ctx.db.get(cleared.ledgerId!));
    await expect(
      t.mutation(internal.heldBooks.restoreInternal, {
        actor: "ari",
        ledgerId: cleared.ledgerId!,
        expectedAfter: ledger!.after,
        reason: "Requeue",
      }),
    ).rejects.toThrow(/Revoke/);
    await t.mutation(internal.scope.revokeInternal, {
      actor: "ari",
      decisionId: decision.decisionId,
      expected: current.expected,
      reason: "Research corrected; retain original history.",
    });
    await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: cleared.ledgerId!,
      expectedAfter: ledger!.after,
      reason: "Requeue after scope revocation",
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(observationId))?.lastSeenAt).toBe(1791144451259);
      expect((await ctx.db.query("placementHolds").unique())?.heldAt).toBe(20);
    });
  });
  it("refreshes only ANN parser facts without fabricating source sightings and writes nothing on equality", async () => {
    const t = makeT();
    const s = await dance(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.seriesId, { title: "Hot Gimmick", searchText: "Hot Gimmick" });
      await ctx.db.patch(s.parentId, {
        sourceRecordId: "manga:2686",
        snapshot: { kind: "annManga", title: "Hot Gimmick" },
      });
      await ctx.db.patch(s.observationId, {
        sourceRecordId: "release:13654",
        snapshot: {
          kind: "annRelease",
          annId: "13654",
          mangaId: "2686",
          title: "Hot Gimmick [VIZBIG Edition]",
          isbn13: "9781421523491",
          label: "2",
          format: "physical",
          multi: false,
          editionLineHint: false,
          page: {
            status: "ok",
            volume: "GN 2 / 4",
            title: "Hot Gimmick [VIZBIG Edition]",
            distributor: "Viz Media",
            fetchedAt: 1790487506271,
          },
        },
      });
    });
    const preview = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
    });
    const args = {
      actor: "ari",
      observationId: s.observationId,
      operation: "refreshAnn" as const,
      expected: preview.expected!,
      reason,
      evidenceUrls: urls,
    };
    const result = await t.mutation(internal.heldBooks.executeInternal, args);
    expect(result.status).toBe("applied");
    const fresh = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
    });
    expect(
      (await t.mutation(internal.heldBooks.executeInternal, { ...args, expected: fresh.expected! }))
        .status,
    ).toBe("alreadyApplied");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.lastSeenAt).toBe(1791147316483);
      expect(await ctx.db.query("observationSnapshots").collect()).toHaveLength(1);
    });
  });
  it("validates citation syntax while retaining the explicit evidence requirement", () => {
    expect(evidenceUrls(["  https://yenpress.com/titles/9781718372573  "])).toEqual([
      "https://yenpress.com/titles/9781718372573",
    ]);
    expect(() => evidenceUrls(["javascript:alert(1)"])).toThrow(/HTTP/);
  });
});

/** The real 9781632367006 conflict: Season 1 Part 2, Vols 5–8. */
async function titan(t: TestT) {
  const userId = await admin(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { title: "Attack on Titan" });
    const placeholderSeries = await insertSeries(ctx, { title: "Attack on Titan Manga Box Sets" });
    const placeholderVolume = await insertVolume(ctx, {
      seriesId: placeholderSeries,
      label: "2",
      position: 2,
    });
    const box = await insertBook(ctx, {
      publisherId,
      seriesId: placeholderSeries,
      volumeId: placeholderVolume,
      release: { isbn13: "9781632367006" },
    });
    const bundleId = await insertBundle(ctx, {
      publisherId,
      format: "physical",
      name: "Attack on Titan Season 1 Part 2 Manga Box Set",
      isbn13: "9781632367006",
    });
    const memberIds: Id<"releases">[] = [];
    const volumeIds: Id<"volumes">[] = [];
    for (const [i, isbn13] of [
      "9781612622545",
      "9781612622552",
      "9781612622569",
      "9781612622576",
    ].entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(i + 5), position: i + 5 });
      volumeIds.push(volumeId);
      const member = await insertBook(ctx, {
        publisherId,
        seriesId,
        volumeId,
        release: { isbn13 },
      });
      memberIds.push(member.releaseId);
      if (i === 1) {
        const wrongId = await insertRelease(ctx, {
          editionId: member.editionId,
          publisherId,
          seriesIds: [seriesId],
          isbn13: "9781612626208",
          format: "physical",
        });
        await insertBundleMember(ctx, { bundleId, releaseId: wrongId, order: 2 });
      } else await insertBundleMember(ctx, { bundleId, releaseId: member.releaseId, order: i + 1 });
    }
    await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:12308",
      recordRef: { type: "series", id: seriesId },
      snapshot: { kind: "annManga", title: "Attack on Titan" },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:43974",
      lastSeenAt: 1791148051971,
      snapshot: {
        kind: "annRelease",
        annId: "43974",
        mangaId: "12308",
        title: "Attack on Titan - Season 1 Part 2",
        isbn13: "9781632367006",
        format: "physical",
        multi: true,
        editionLineHint: false,
        coverRange: { from: "5", to: "8" },
        page: {
          status: "ok",
          distributor: "Kodansha Comics",
          volume: "GN 5-8 / 34",
          isbn13: "9781632367006",
        },
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 30,
    });
    await ctx.db.insert("comments", {
      userId,
      seriesId: placeholderSeries,
      body: "Private moderation detail must stay off repair reports.",
      spoiler: false,
      status: "hidden",
      reportCount: 0,
      createdAt: 0,
    });
    const wrong = await ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", "9781612626208"))
      .unique();
    return {
      userId,
      publisherId,
      seriesId,
      placeholderSeries,
      box,
      bundleId,
      memberIds,
      volumeIds,
      observationId,
      wrongId: wrong!._id,
    };
  });
}

describe("real box collision and personal-reference workflow", () => {
  it("corrects the official eBook format, replaces the wrong member atomically, converts with exact audit proof and links held ANN contents", async () => {
    const t = makeT();
    const s = await titan(t);
    const corrections = [
      { releaseId: s.wrongId, from: "physical" as const, to: "digital" as const },
    ];
    const plan = { bundleId: s.bundleId, memberIds: s.memberIds, corrections };
    const preview = await t.query(internal.heldRepair.bundleContentsStateInternal, plan);
    expect(preview.refusal).toBeNull();
    const fix = await t.mutation(internal.heldRepair.repairBundleContentsInternal, {
      ...plan,
      actor: "ari",
      expected: preview.expected!,
      reason:
        "Publisher identifies 9781612626208 as eBook; use the existing physical 9781612622552 of the same Edition/Volume.",
      evidenceUrls: ["https://kodansha.us/product/attack-on-titan-6/"],
    });
    expect(fix.status).toBe("applied");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.wrongId))?.format).toBe("digital");
      expect((await ctx.db.get(s.wrongId))?.status).toBe("active");
      expect(
        (
          await ctx.db
            .query("bundleMemberships")
            .withIndex("by_bundle", (q) => q.eq("bundleId", s.bundleId))
            .collect()
        ).map((m) => m.releaseId),
      ).not.toContain(s.wrongId);
    });
    const conversion = await t.query(internal.heldRepair.conversionStateInternal, {
      releaseId: s.box.releaseId,
      bundleId: s.bundleId,
    });
    expect(conversion.refusal).toBeNull();
    const audit = await t.query(internal.heldRepair.referenceAuditInternal, {
      releaseId: s.box.releaseId,
      bundleId: s.bundleId,
    });
    expect(audit.complete).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("Private moderation detail");
    expect(JSON.stringify(audit)).not.toContain(s.userId);
    const result = await t.mutation(internal.heldRepair.convertInternal, {
      actor: "ari",
      releaseId: s.box.releaseId,
      bundleId: s.bundleId,
      expected: conversion.expected!,
      reason: "Exact publisher box contents 5–8 and corrected member graph reviewed.",
      evidenceUrls: [
        "https://www.penguinrandomhouse.com/books/580369/attack-on-titan-season-1-part-2-manga-box-set-by-hajime-isayama/",
      ],
    });
    expect(result.status).toBe("applied");
    const proposalCount = await t.run((ctx) =>
      ctx.db
        .query("proposals")
        .collect()
        .then((rows) => rows.length),
    );
    const repeated = await t.query(internal.heldRepair.conversionStateInternal, {
      releaseId: s.box.releaseId,
      bundleId: s.bundleId,
    });
    expect(repeated.alreadyConverted).toBe(true);
    expect(
      await t.mutation(internal.heldRepair.convertInternal, {
        actor: "ari",
        releaseId: s.box.releaseId,
        bundleId: s.bundleId,
        expected: repeated.expected!,
        reason: "Reviewed conversion is already complete.",
        evidenceUrls: ["https://kodansha.us/"],
      }),
    ).toEqual({ status: "alreadyApplied" });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("proposals")
          .collect()
          .then((rows) => rows.length),
      ),
    ).toBe(proposalCount);
    const reviewed = {
      isbn13: "9781632367006",
      sourceTitle: "Attack on Titan - Season 1 Part 2",
      publisherId: s.publisherId,
      seriesId: s.seriesId,
      volumeIds: s.volumeIds,
      evidenceUrls: [
        "https://www.penguinrandomhouse.com/books/580369/attack-on-titan-season-1-part-2-manga-box-set-by-hajime-isayama/",
      ],
    };
    const target = { type: "bundle" as const, id: s.bundleId };
    const link = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
      target,
      reviewed,
    });
    expect(link.refusal).toBeNull();
    expect(
      (
        await t.mutation(internal.heldBooks.executeInternal, {
          actor: "ari",
          observationId: s.observationId,
          target,
          reviewed,
          operation: "link",
          expected: link.expected!,
          reason,
          evidenceUrls: reviewed.evidenceUrls,
        })
      ).status,
    ).toBe("applied");
    await t.run(async (ctx) => {
      expect((await ctx.db.query("comments").unique())?.seriesId).toBe(s.placeholderSeries);
      expect((await ctx.db.get(s.box.releaseId))?.status).toBe("hidden");
      expect((await ctx.db.get(s.observationId))?.lastSeenAt).toBe(1791148051971);
    });
  });
  it("refuses empty contents, private pass loss, or state drift and leaves all writes/audits atomic", async () => {
    const t = makeT();
    const s = await titan(t);
    const passId = await t.run((ctx) =>
      ctx.db.insert("releaseProgress", {
        userId: s.userId,
        releaseId: s.box.releaseId,
        seriesId: s.placeholderSeries,
        percent: 40,
      }),
    );
    const privateAudit = await t.query(internal.heldRepair.referenceAuditInternal, {
      releaseId: s.box.releaseId,
      bundleId: s.bundleId,
    });
    expect(privateAudit.eligible).toBe(false);
    expect(privateAudit.counts.releaseProgress).toBe(1);
    expect(
      (
        await t.query(internal.heldRepair.conversionStateInternal, {
          releaseId: s.box.releaseId,
          bundleId: s.bundleId,
        })
      ).expected,
    ).toBeNull();
    await t.run((ctx) => ctx.db.delete(passId));
    const plan = { bundleId: s.bundleId, memberIds: s.memberIds, corrections: [] };
    const preview = await t.query(internal.heldRepair.bundleContentsStateInternal, plan);
    await t.run((ctx) => ctx.db.patch(s.memberIds[0]!, { locked: true }));
    expect(
      (
        await t.mutation(internal.heldRepair.repairBundleContentsInternal, {
          ...plan,
          actor: "ari",
          expected: preview.expected!,
          reason,
          evidenceUrls: urls,
        })
      ).status,
    ).toBe("refused");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("proposals").collect()).toEqual([]);
      await ctx.db.patch(s.memberIds[0]!, { locked: false });
      for (const m of await ctx.db.query("bundleMemberships").collect()) await ctx.db.delete(m._id);
    });
    expect(
      (
        await t.query(internal.heldRepair.conversionStateInternal, {
          releaseId: s.box.releaseId,
          bundleId: s.bundleId,
        })
      ).refusal,
    ).toMatch(/empty/);
  });
});

// Full stored public snapshots from the R2 provenance; canonical targets stay local.
const bookwormRecord = {
  annId: "39627",
  date: {
    day: 7.0,
    month: 12.0,
    year: 2021.0,
  },
  editionLineHint: false,
  format: "physical",
  isbn13: "9781718372573",
  kind: "annRelease",
  label: "1",
  mangaId: "20892",
  multi: false,
  page: {
    date: {
      day: 7.0,
      month: 12.0,
      year: 2021.0,
    },
    distributor: "J-Novel Club",
    distributorId: "15174",
    fetchedAt: 1790499628004.0,
    isbn10: "1718372574",
    isbn13: "9781718372573",
    mangaId: "20892",
    priceCents: 1499.0,
    status: "ok",
    title: "Ascendance of a Bookworm - Part 2: I'll even join the temple to read books!",
    volume: "GN 1",
  },
  title: "Ascendance of a Bookworm - Part 2: I'll even join the temple to read books!",
  url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=39627",
};
const fireForceBoxRecord = {
  annId: "51151",
  coverRange: {
    from: "1",
    to: "6",
  },
  date: {
    day: 27.0,
    month: 8.0,
    year: 2024.0,
  },
  editionLineHint: true,
  format: "physical",
  isbn13: "9798888772584",
  kind: "annRelease",
  mangaId: "18530",
  multi: true,
  page: {
    date: {
      day: 27.0,
      month: 8.0,
      year: 2024.0,
    },
    distributor: "Kodansha Comics",
    distributorId: "8388",
    fetchedAt: 1790503448766.0,
    isbn13: "9798888772584",
    mangaId: "18530",
    priceCents: 6594.0,
    status: "ok",
    title: "Fire Force - [Box Set] 1",
    volume: "GN 1-6",
  },
  title: "Fire Force - [Box Set] 1",
  url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51151",
};

async function bookworm(t: TestT, targetTitle = "Ascendance of a Bookworm (Manga) Part 2") {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "J-Novel Club", slug: "j-novel-club" });
    const genericId = await insertSeries(ctx, { title: "Ascendance of a Bookworm" });
    const seriesId = await insertSeries(ctx, { title: targetTitle });
    const volumeId = await insertVolume(ctx, { seriesId, label: "1" });
    const book = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      release: { isbn13: "9781718372573" },
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:20892",
      recordRef: { type: "series", id: genericId },
      snapshot: {
        kind: "annManga",
        title: "Ascendance of a Bookworm",
        releases: [
          {
            annId: "39610",
            title: "Ascendance of a Bookworm - Part 1: If there aren't any books, I'll make some!",
            isbn13: "9781718372504",
          },
          {
            annId: "39627",
            title: "Ascendance of a Bookworm - Part 2: I'll even join the temple to read books!",
            isbn13: "9781718372573",
          },
          {
            annId: "54271",
            title: "Ascendance of a Bookworm - Part 3: let’s spread books through the duchy!",
            isbn13: "9781718372696",
          },
          {
            annId: "56050",
            title: "Ascendance of a Bookworm - Part 4: I want to save the Royal Academy’s library!",
            isbn13: "9781718373105",
          },
        ],
      },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:39627",
      snapshot: bookwormRecord,
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId: genericId,
      heldAt: 40,
    });
    return { publisherId, genericId, seriesId, volumeId, parentId, observationId, ...book };
  });
}

it("routes one Bookworm Part 2 observation using exact product evidence without changing its multi-Part ANN parent", async () => {
  const t = makeT({ transactionLimits: true });
  await admin(t);
  const sourceTitle = bookwormRecord.title;
  const s = await bookworm(t);
  const reviewed = {
    isbn13: "9781718372573",
    publisherId: s.publisherId,
    seriesId: s.seriesId,
    volumeIds: [s.volumeId],
    evidenceUrls: [
      "https://yenpress.com/titles/9781718372573-ascendance-of-a-bookworm-manga-part-2-volume-1",
    ],
    umbrellaRouting: {
      sourceTitle,
      productTitle: "Ascendance of a Bookworm (Manga) Part 2 Volume 1",
      productVolumeLabel: "1",
    },
  };
  const preview = await t.query(internal.heldBooks.previewInternal, {
    observationId: s.observationId,
    reviewed,
  });
  const route = await t.mutation(internal.heldBooks.executeInternal, {
    actor: "ari",
    observationId: s.observationId,
    operation: "reviewSeries",
    reviewed,
    seriesId: s.seriesId,
    expected: preview.expected!,
    reason,
    evidenceUrls: reviewed.evidenceUrls,
  });
  expect(route.status).toBe("applied");
  const target = { type: "release" as const, id: s.releaseId };
  const link = await t.query(internal.heldBooks.previewInternal, {
    observationId: s.observationId,
    target,
    reviewed,
  });
  expect(link.refusal).toBeNull();
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        actor: "ari",
        observationId: s.observationId,
        target,
        reviewed,
        operation: "link",
        expected: link.expected!,
        reason,
        evidenceUrls: reviewed.evidenceUrls,
      })
    ).status,
  ).toBe("applied");
  expect((await t.run((ctx) => ctx.db.get(s.parentId)))?.recordRef).toEqual({
    type: "series",
    id: s.genericId,
  });
});

// R2 uses the actual R1 source records and local canonical counterfacts.
// The assertions require refusal and atomicity, not the earlier unsafe outcomes.
async function repairState(t: TestT) {
  return await t.run(async (ctx) => {
    const tables = [
      "sourceObservations",
      "placementHolds",
      "proposals",
      "proposalVersions",
      "revisions",
      "heldRepairLedger",
      "series",
      "editionLines",
      "publishers",
      "releases",
      "editions",
      "volumes",
      "volumeCoverages",
      "releaseBundles",
      "bundleMemberships",
      "bundleConversions",
      "repairBundleOrigins",
      "releaseProgress",
      "collectionEntries",
      "repairTrails",
      "userSeriesStates",
      "releaseVariants",
      "ratings",
      "comments",
    ] as const;
    return Object.fromEntries(
      await Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).collect()])),
    );
  });
}

async function refusedLink(
  t: TestT,
  args: import("convex/server").FunctionArgs<typeof internal.heldBooks.previewInternal>,
  refusal: RegExp,
) {
  const before = await repairState(t);
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(preview.refusal).toMatch(refusal);
  const result = await t.mutation(internal.heldBooks.executeInternal, {
    ...args,
    actor: "ari",
    operation: "link",
    expected: preview.expected ?? "No executable guard",
    reason,
    evidenceUrls: urls,
  });
  expect(result.status).toBe("refused");
  expect(await repairState(t)).toEqual(before);
}

const titanReview = (s: Awaited<ReturnType<typeof titan>>) => ({
  isbn13: "9781632367006",
  seriesId: s.seriesId,
  publisherId: s.publisherId,
  volumeIds: s.volumeIds,
  sourceTitle: "Attack on Titan - Season 1 Part 2",
  evidenceUrls: urls,
});
const titanMembers = ["9781612622545", "9781612622552", "9781612622569", "9781612622576"].map(
  (isbn13, i) => ({ isbn13, order: i + 1 }),
);

async function prepareNewTitanBox(t: TestT, s: Awaited<ReturnType<typeof titan>>) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("bundleMemberships").collect())
      await ctx.db.delete(row._id);
    await ctx.db.delete(s.bundleId);
    await ctx.db.patch(s.wrongId, { format: "digital" });
  });
}
const titanConversion = (s: Awaited<ReturnType<typeof titan>>) => ({
  kind: "releaseBundle" as const,
  key: "titan-new-box-r2",
  reason,
  bundleId: null,
  box: { releaseId: s.box.releaseId, name: "Attack on Titan Season 1 Part 2 Manga Box Set" },
  members: titanMembers,
  retireVolumeIds: [],
});
async function titanRemodel(t: TestT, s: Awaited<ReturnType<typeof titan>>) {
  const placeholder = await t.run(
    async (ctx) =>
      (await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", s.box.editionId))
        .unique())!.volumeId,
  );
  return {
    kind: "remodelEdition" as const,
    key: "titan-remodel-box-r2",
    reason,
    editionId: s.box.editionId,
    volumeId: placeholder,
    targetSeriesId: s.seriesId,
    bundle: { name: "Attack on Titan Season 1 Part 2 Manga Box Set" },
    line: null,
    retireVolumeIds: [],
    groups: [
      {
        releaseIds: [s.box.releaseId],
        linePosition: null,
        coverage: s.volumeIds.map((volumeId, i) => ({
          volumeId,
          label: String(i + 5),
          extent: "complete" as const,
        })),
      },
    ],
  };
}

async function recognizedConversion(
  t: TestT,
  s: Awaited<ReturnType<typeof titan>>,
  bundleId: Id<"releaseBundles">,
) {
  const conversion = await t.query(internal.heldRepair.conversionStateInternal, {
    releaseId: s.box.releaseId,
    bundleId,
  });
  expect(conversion.refusal).toBeNull();
  expect(conversion.alreadyConverted).toBe(true);
  const namespace = await t.query(internal.heldBooks.isbnNamespaceAuditInternal, {
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(namespace.page[0]?.claims[0]?.classification).toBe("converted");
  const link = await t.query(internal.heldBooks.previewInternal, {
    observationId: s.observationId,
    target: { type: "bundle", id: bundleId },
    reviewed: titanReview(s),
  });
  expect(link.refusal).toBeNull();
  await t.run(async (ctx) => {
    const proof = (await ctx.db.query("bundleConversions").unique())!;
    const revision = (await ctx.db.get(proof.revisionId))!;
    expect(proof.bundleId).toBe(bundleId);
    expect(revision.proposalId).toBe(proof.proposalId);
    expect((await ctx.db.get(proof.proposalId))?.state).toBe("approved");
    expect(revision.changes.some((change) => change.field === "convertedToBundle")).toBe(true);
  });
}

it("R2 ANN reviewed identity keeps GN Volume and Binding facts, with the complete-Line positive", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await dance(t);
  const args = {
    ...linkArgs(s),
    reviewed: {
      isbn13: "9781645057345",
      seriesId: s.seriesId,
      publisherId: s.publisherId,
      volumeIds: [s.volumeId],
      evidenceUrls: urls,
    },
  };
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  await t.run((ctx) => ctx.db.patch(s.volumeId, { label: "9", position: 9 }));
  await refusedLink(t, args, /single-Volume extent/);
  await t.run(async (ctx) => {
    await ctx.db.patch(s.volumeId, { label: "3", position: 3 });
    const observation = (await ctx.db.get(s.observationId))!;
    await ctx.db.patch(s.observationId, {
      snapshot: {
        ...observation.snapshot,
        title: "Dance in the Vampire Bund: Age of Scarlet Order (Hardcover)",
      },
    });
  });
  await refusedLink(t, args, /binding/);
  await t.run(async (ctx) => {
    const observation = (await ctx.db.get(s.observationId))!;
    await ctx.db.patch(s.observationId, {
      snapshot: { ...observation.snapshot, title: "Fire Force" },
    });
  });
  await refusedLink(
    t,
    { ...args, reviewed: { ...args.reviewed, sourceTitle: "Fire Force" } },
    /Known ANN work/,
  );
  await t.run(async (ctx) => {
    const observation = (await ctx.db.get(s.observationId))!;
    await ctx.db.patch(s.observationId, {
      snapshot: {
        ...observation.snapshot,
        title: "Dance in the Vampire Bund: Age of Scarlet Order",
      },
    });
  });
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        operation: "link",
        expected: preview.expected!,
        reason,
        evidenceUrls: urls,
      })
    ).status,
  ).toBe("applied");
});

it("R2 importer refuses ambiguous or newly locked late box members, then adds the unlocked book", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(s.box.releaseId, { isbn13: undefined });
    for (const row of await ctx.db.query("bundleMemberships").collect())
      await ctx.db.delete(row._id);
  });
  const apply = async () =>
    await t.run(async (ctx) => {
      const { createReleaseBundle } = await import("./lib/pipeline");
      const observation = (await ctx.db.get(s.observationId))!;
      return await createReleaseBundle(ctx, {
        sourceKey: "ann",
        observation,
        citation: { sourceName: "ANN", url: urls[0]! },
        importComment: reason,
        seriesId: s.seriesId,
        name: "Attack on Titan Season 1 Part 2 Manga Box Set",
        labels: ["5", "6", "7", "8"],
        publisher: { name: "Kodansha", slug: "kodansha" },
        release: { format: "physical", isbn13: "9781632367006" },
        tagBootstrapUnreviewed: false,
        now: 1,
      });
    });
  expect(await apply()).toMatchObject({ held: expect.stringMatching(/ambiguous/) });
  await t.run(async (ctx) => {
    await ctx.db.patch(s.wrongId, { format: "digital" });
    await ctx.db.patch(s.memberIds[0]!, { locked: true });
  });
  expect(await apply()).toHaveProperty("held");
  await t.run(async (ctx) => {
    expect(await ctx.db.query("bundleMemberships").collect()).toEqual([]);
    expect((await ctx.db.get(s.observationId))?.recordRef).toBeUndefined();
    expect(await ctx.db.query("proposals").collect()).toEqual([]);
    expect(await ctx.db.query("revisions").collect()).toEqual([]);
    await ctx.db.patch(s.memberIds[0]!, { locked: false });
  });
  expect(await apply()).toMatchObject({ bundleId: s.bundleId, created: false, members: 4 });
  await t.run(async (ctx) => {
    expect((await ctx.db.query("bundleMemberships").collect()).map((m) => m.releaseId)).toEqual(
      s.memberIds,
    );
    expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
      type: "releaseBundle",
      id: s.bundleId,
    });
  });
});

it("R2 both new box conversion APIs atomically refuse an active pass; supported collection transfer stays usable", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  await prepareNewTitanBox(t, s);
  const remodel = await titanRemodel(t, s);
  const progressId = await t.run((ctx) =>
    ctx.db.insert("releaseProgress", {
      userId: s.userId,
      releaseId: s.box.releaseId,
      seriesId: s.placeholderSeries,
      percent: 40,
    }),
  );
  for (const entry of [titanConversion(s), remodel]) {
    const before = await repairState(t);
    const result = await t.mutation(internal.repair.runBatch, {
      actor: "ari",
      dryRun: false,
      entries: [entry],
    });
    expect(result[0]).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/Personal-data preservation/),
    });
    expect(await repairState(t)).toEqual(before);
  }
  await t.run(async (ctx) => {
    await ctx.db.delete(progressId);
    await ctx.db.insert("collectionEntries", {
      userId: s.userId,
      releaseId: s.box.releaseId,
      state: "owned",
    });
  });
  const entry = titanConversion(s);
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0]?.status,
  ).toBe("applied");
  const bundleId = await t.run(async (ctx) => (await ctx.db.query("releaseBundles").unique())!._id);
  await recognizedConversion(t, s, bundleId);
  const beforeRepeat = await repairState(t);
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0]?.status,
  ).toBe("alreadyApplied");
  expect(await repairState(t)).toEqual(beforeRepeat);
  await t.run(async (ctx) => {
    expect((await ctx.db.query("collectionEntries").unique())?.bundleId).toBe(bundleId);
    expect((await ctx.db.query("collectionEntries").unique())?.releaseId).toBeUndefined();
    expect((await ctx.db.get(s.box.releaseId))?.status).toBe("hidden");
  });
});

it("R2 ANN scope disposition survives a canonical ISBN hit and lets ordinary manga lines complete", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await dance(t);
  const scope = await t.query(internal.scope.stateInternal, { isbn: "9781645057345" });
  await t.mutation(internal.scope.decideInternal, {
    actor: "ari",
    isbn13: "9781645057345",
    reason: "novel",
    evidenceUrls: urls,
    expected: scope.expected,
  });
  const ordinary = await t.run(async (ctx) => {
    const volumeId = await insertVolume(ctx, { seriesId: s.seriesId, label: "4", position: 4 });
    return await insertBook(ctx, { publisherId: s.publisherId, seriesId: s.seriesId, volumeId });
  });
  const snapshot = {
    kind: "annManga" as const,
    id: "22820",
    staff: [],
    title: "Dance in the Vampire Bund: Age of Scarlet Order",
    altTitles: [],
    url: "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=22820",
    releases: [
      {
        annId: "43552",
        title: "Dance in the Vampire Bund: Age of Scarlet Order",
        format: "physical" as const,
        isbn13: "9781645057345",
        label: "3",
        multi: false,
        editionLineHint: false,
      },
      {
        annId: "ordinary-local",
        title: "Dance in the Vampire Bund: Age of Scarlet Order",
        format: "physical" as const,
        label: "4",
        multi: false,
        editionLineHint: false,
      },
    ],
  };
  const result = await t.mutation(internal.ann.applyManga, { snapshot });
  expect(result.releasesLinked).toBe(1);
  await t.run(async (ctx) => {
    const excluded = (await ctx.db.get(s.observationId))!;
    expect(excluded.recordRef).toBeUndefined();
    expect(excluded.conflicts?.find((c) => c.field === "placement")?.reason).toMatch(
      /Reviewed exact ISBN/,
    );
    expect(excluded.snapshot.page.fetchedAt).toBe(1790500926477);
    expect(
      (
        await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "ann").eq("sourceRecordId", "release:ordinary-local"),
          )
          .unique()
      )?.recordRef,
    ).toEqual({ type: "release", id: ordinary.releaseId });
    expect((await ctx.db.query("volumes").collect()).map((v) => v.label).sort()).toEqual([
      "3",
      "4",
    ]);
    // A historical contaminated link is retained, and its fields are not reconciled.
    await ctx.db.patch(s.observationId, { recordRef: { type: "release", id: s.releaseId } });
    await ctx.db.patch(s.releaseId, { pubDate: { year: 2020, sort: 20200000 } });
  });
  await t.mutation(internal.ann.applyManga, {
    snapshot: {
      ...snapshot,
      releases: snapshot.releases.map((r) =>
        r.annId === "43552" ? { ...r, date: { year: 2025 } } : r,
      ),
    },
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
      type: "release",
      id: s.releaseId,
    });
    expect((await ctx.db.get(s.releaseId))?.status).toBe("active");
    expect((await ctx.db.get(s.releaseId))?.pubDate).toEqual({ year: 2020, sort: 20200000 });
  });
});

it("R2 remodel conversion emits the same exact proof, is recognized by held linking and repeats without writes", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  await prepareNewTitanBox(t, s);
  const entry = await titanRemodel(t, s);
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0]?.status,
  ).toBe("applied");
  const bundleId = await t.run(async (ctx) => (await ctx.db.query("releaseBundles").unique())!._id);
  await recognizedConversion(t, s, bundleId);
  const before = await repairState(t);
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0]?.status,
  ).toBe("alreadyApplied");
  expect(await repairState(t)).toEqual(before);
});

it("R2 the physical AoT box requires its own coherent publisher and format, beyond valid members", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  await t.run((ctx) => ctx.db.patch(s.box.releaseId, { isbn13: undefined }));
  const args = {
    observationId: s.observationId,
    target: { type: "bundle" as const, id: s.bundleId },
    reviewed: titanReview(s),
  };
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  await t.run((ctx) => ctx.db.patch(s.bundleId, { format: "digital" }));
  await refusedLink(t, args, /formats differ/);
  await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    await ctx.db.patch(s.bundleId, { format: "physical", publisherId });
  });
  await refusedLink(t, args, /publishers differ/);
  await t.run((ctx) => ctx.db.patch(s.bundleId, { publisherId: s.publisherId }));
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        operation: "link",
        expected: preview.expected!,
        reason,
        evidenceUrls: urls,
      })
    ).status,
  ).toBe("applied");
});

it("R2 actual OL Fire Force nested 7–11 contents accept 7–11 and atomically refuse 12–16", async () => {
  const t = makeT({ transactionLimits: true });
  await admin(t);
  const s = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { title: "Fire Force" });
    const bundleId = await insertBundle(ctx, {
      publisherId,
      format: "physical",
      name: "Fire Force Manga Box Set 2",
      isbn13: "9798888772591",
    });
    const volumeIds: Id<"volumes">[] = [];
    for (let label = 7; label <= 11; label++) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(label), position: label });
      volumeIds.push(volumeId);
      const book = await insertBook(ctx, { publisherId, seriesId, volumeId });
      await insertBundleMember(ctx, { bundleId, releaseId: book.releaseId, order: label - 6 });
    }
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: "/books/OL51622423M",
      snapshot: {
        format: "physical",
        isbn13: "9798888772591",
        key: "/books/OL51622423M",
        kind: "olEdition",
        multiVolume: true,
        packaging: { coverRange: { from: "7", to: "11" }, lineName: "Box Set", linePosition: "2" },
        publishDate: { year: 2024 },
        publishers: ["Kodansha America, Incorporated"],
        seriesTitle: "Fire Force",
        title: "Fire Force Manga Box Set 2 (Vol. 7-11)",
        url: "https://openlibrary.org/books/OL51622423M",
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "isbn",
      seriesId,
      heldAt: 10,
    });
    return { publisherId, seriesId, bundleId, volumeIds, observationId };
  });
  const args = {
    observationId: s.observationId,
    target: { type: "bundle" as const, id: s.bundleId },
    reviewed: {
      isbn13: "9798888772591",
      seriesId: s.seriesId,
      publisherId: s.publisherId,
      volumeIds: s.volumeIds,
      evidenceUrls: ["https://openlibrary.org/books/OL51622423M"],
    },
  };
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  await t.run(async (ctx) => {
    for (const [i, id] of s.volumeIds.entries())
      await ctx.db.patch(id, { label: String(i + 12), position: i + 12 });
  });
  await refusedLink(t, args, /ordered source contents/);
  await t.run(async (ctx) => {
    for (const [i, id] of s.volumeIds.entries())
      await ctx.db.patch(id, { label: String(i + 7), position: i + 7 });
    await ctx.db.patch(s.bundleId, { name: "Fire Force Manga Box Set 3" });
  });
  await refusedLink(t, args, /Bundle position/);
  await t.run((ctx) => ctx.db.patch(s.bundleId, { name: "Fire Force Manga Box Set 2" }));
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        operation: "link",
        expected: preview.expected!,
        reason,
        evidenceUrls: args.reviewed.evidenceUrls,
      })
    ).status,
  ).toBe("applied");
});

it("R2 a repair origin does not bypass pinned-variant and Edition-tracking preflight", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  const entry = titanConversion(s);
  await t.run(async (ctx) => {
    await ctx.db.patch(s.wrongId, { format: "digital" });
    const wrong = (await ctx.db
      .query("bundleMemberships")
      .withIndex("by_release", (q) => q.eq("releaseId", s.wrongId))
      .unique())!;
    await ctx.db.patch(wrong._id, { releaseId: s.memberIds[1]! });
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "user", userId: s.userId, roleAtAuthorship: "administrator" },
      state: "approved",
      currentVersionNo: 1,
      decidedBy: s.userId,
    });
    await ctx.db.insert("repairBundleOrigins", {
      bundleId: s.bundleId,
      releaseId: s.box.releaseId,
      entryKey: entry.key,
      proposalId,
    });
    const variantId = await insertVariant(ctx, { releaseId: s.box.releaseId, name: "Box cover" });
    await ctx.db.insert("collectionEntries", {
      userId: s.userId,
      releaseId: s.box.releaseId,
      variantId,
      state: "owned",
    });
    await ctx.db.insert("ratings", {
      userId: s.userId,
      editionId: s.box.editionId,
      score: 80,
      updatedAt: 1,
    });
  });
  const audit = await t.query(internal.heldRepair.referenceAuditInternal, {
    releaseId: s.box.releaseId,
    bundleId: s.bundleId,
  });
  expect(audit.eligible).toBe(false);
  expect(audit.counts["ratings.edition"]).toBe(1);
  expect(
    Object.entries(audit.counts).some(
      ([name, count]) => name.startsWith("collectionEntries.variant.") && count === 1,
    ),
  ).toBe(true);
  const before = await repairState(t);
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0],
  ).toMatchObject({
    status: "skipped",
    reason: expect.stringMatching(/Personal-data preservation/),
  });
  expect(await repairState(t)).toEqual(before);
});

it("R2 conversion cannot retire a placeholder with personal comments", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await titan(t);
  await prepareNewTitanBox(t, s);
  const remodel = await titanRemodel(t, s);
  await t.run((ctx) =>
    ctx.db.insert("comments", {
      userId: s.userId,
      seriesId: s.placeholderSeries,
      volumeId: remodel.volumeId,
      body: "Keep this Volume's discussion",
      spoiler: false,
      status: "approved",
      reportCount: 0,
      createdAt: 1,
    }),
  );
  const before = await repairState(t);
  const entry = { ...titanConversion(s), retireVolumeIds: [remodel.volumeId] };
  expect(
    (
      await t.mutation(internal.repair.runBatch, { actor: "ari", dryRun: false, entries: [entry] })
    )[0],
  ).toMatchObject({
    status: "skipped",
    reason: expect.stringMatching(/Placeholder has personal references/),
  });
  expect(await repairState(t)).toEqual(before);
});

it("R3 refuses actual Bookworm Part 2 routing into an unrelated Part 2 work at review and link", async () => {
  const t = makeT({ transactionLimits: true });
  await admin(t);
  const s = await bookworm(t, "Fire Force Part 2");
  const reviewed = {
    isbn13: bookwormRecord.isbn13,
    publisherId: s.publisherId,
    seriesId: s.seriesId,
    volumeIds: [s.volumeId],
    evidenceUrls: [bookwormRecord.url],
    umbrellaRouting: {
      sourceTitle: bookwormRecord.title,
      productTitle: "Fire Force Part 2 Volume 1",
      productVolumeLabel: "1",
    },
  };
  const args = { observationId: s.observationId, reviewed };
  const before = await repairState(t);
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        operation: "reviewSeries",
        seriesId: s.seriesId,
        expected: preview.expected!,
        reason,
        evidenceUrls: reviewed.evidenceUrls,
      })
    ).status,
  ).toBe("refused");
  expect(await repairState(t)).toEqual(before);
  // A preexisting wrong hold must not turn the independently fresh link into permission.
  await t.run(async (ctx) => {
    const hold = (await ctx.db
      .query("placementHolds")
      .withIndex("by_observation", (q) => q.eq("observationId", s.observationId))
      .unique())!;
    await ctx.db.patch(hold._id, { seriesId: s.seriesId });
  });
  await refusedLink(t, { ...args, target: { type: "release", id: s.releaseId } }, /root work/);
  expect((await t.run((ctx) => ctx.db.get(s.parentId)))?.recordRef).toEqual({
    type: "series",
    id: s.genericId,
  });
});

async function fireForceBox(t: TestT) {
  await admin(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { title: "Fire Force" });
    const bundleId = await insertBundle(ctx, {
      publisherId,
      format: "physical",
      name: "Fire Force Manga Box Set 1",
      isbn13: fireForceBoxRecord.isbn13,
    });
    const volumeIds: Id<"volumes">[] = [];
    for (let n = 1; n <= 6; n++) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(n), position: n });
      volumeIds.push(volumeId);
      const book = await insertBook(ctx, { seriesId, volumeId, publisherId });
      await insertBundleMember(ctx, { bundleId, releaseId: book.releaseId, order: n });
    }
    await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `manga:${fireForceBoxRecord.mangaId}`,
      recordRef: { type: "series", id: seriesId },
      snapshot: { kind: "annManga", title: "Fire Force" },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:51151",
      snapshot: fireForceBoxRecord,
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 10,
    });
    return { seriesId, publisherId, bundleId, observationId, volumeIds };
  });
}

const fireForceReview = (s: Awaited<ReturnType<typeof fireForceBox>>) => ({
  isbn13: fireForceBoxRecord.isbn13,
  seriesId: s.seriesId,
  publisherId: s.publisherId,
  volumeIds: s.volumeIds,
  evidenceUrls: [fireForceBoxRecord.url],
});

it("R3 ordinary Fire Force box linking keeps independent PAGE contents and the complete 1–6 positive", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await fireForceBox(t);
  const args = {
    observationId: s.observationId,
    target: { type: "bundle" as const, id: s.bundleId },
  };
  expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeNull();
  await t.run((ctx) =>
    ctx.db.patch(s.observationId, {
      snapshot: { ...fireForceBoxRecord, page: { ...fireForceBoxRecord.page, volume: "GN 7-12" } },
    }),
  );
  await refusedLink(t, args, /Known ANN/);
  await refusedLink(t, { ...args, reviewed: fireForceReview(s) }, /Known ANN/);
  await t.run((ctx) => ctx.db.patch(s.observationId, { snapshot: fireForceBoxRecord }));
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(preview.refusal).toBeNull();
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "ari",
        operation: "link",
        expected: preview.expected!,
        reason,
        evidenceUrls: [fireForceBoxRecord.url],
      })
    ).status,
  ).toBe("applied");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
      type: "releaseBundle",
      id: s.bundleId,
    });
    expect(await ctx.db.query("placementHolds").collect()).toHaveLength(0);
  });
});

it("R3 a genuinely unstated box range requires exact contents review without overriding known facts", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await fireForceBox(t);
  // Omit range statements rather than substitute unknown designator grammar.
  const { coverRange: _range, ...record } = fireForceBoxRecord;
  const { volume: _volume, ...page } = record.page;
  await t.run((ctx) => ctx.db.patch(s.observationId, { snapshot: { ...record, page } }));
  const args = {
    observationId: s.observationId,
    target: { type: "bundle" as const, id: s.bundleId },
  };
  await refusedLink(t, args, /no complete box contents/);
  const reviewedArgs = { ...args, reviewed: fireForceReview(s) };
  const preview = await t.query(internal.heldBooks.previewInternal, reviewedArgs);
  expect(preview.refusal).toBeNull();
  expect(
    (
      await t.mutation(internal.heldBooks.executeInternal, {
        ...reviewedArgs,
        actor: "ari",
        operation: "link",
        expected: preview.expected!,
        reason,
        evidenceUrls: [fireForceBoxRecord.url],
      })
    ).status,
  ).toBe("applied");
});

it.each(["heldBooks", "printings"] as const)(
  "packaged binding and covered work are enforced through %s and matching contents still link",
  async (route) => {
    const t = makeT({ transactionLimits: true });
    await admin(t);
    const s = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, {
        name: "Dark Horse Comics",
        slug: "dark-horse",
      });
      const seriesId = await insertSeries(ctx, {
        title: "H.P. Lovecraft's At the Mountains of Madness",
      });
      const editionLineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId,
        name: "Deluxe Edition",
      });
      const editionId = await insertEdition(ctx, { publisherId, editionLineId });
      const volumeIds: Id<"volumes">[] = [];
      for (let n = 1; n <= 2; n++) {
        const volumeId = await insertVolume(ctx, { seriesId, label: String(n), position: n });
        volumeIds.push(volumeId);
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId,
          extent: "complete",
          order: n,
        });
      }
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [seriesId],
        isbn13: lovecraftRecord.isbn13,
        format: "physical",
        binding: "paperback",
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:21831",
        recordRef: { type: "series", id: seriesId },
        snapshot: lovecraftParent,
      });
      const observationId = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:49486",
        snapshot: lovecraftRecord,
      });
      await ctx.db.insert("placementHolds", {
        observationId,
        sourceKey: "ann",
        kind: "isbn",
        seriesId,
        heldAt: 10,
      });
      return { releaseId, observationId, seriesId, editionId, volumeIds };
    });
    const args = {
      observationId: s.observationId,
      target: { type: "release" as const, id: s.releaseId },
    };
    if (route === "heldBooks") {
      await refusedLink(t, args, /binding/i);
    } else {
      const before = await repairState(t);
      const oldArgs = { observationId: s.observationId, releaseId: s.releaseId };
      const preview = await t.query(internal.printings.linkHeldStateInternal, oldArgs);
      expect(preview.refusal).toMatch(/binding/i);
      expect(preview.guard).not.toBeNull();
      const result = await t.mutation(internal.printings.linkHeldInternal, {
        ...oldArgs,
        actor: "ari",
        expected: preview.guard!,
        reason,
        evidenceUrls: [lovecraftRecord.url],
      });
      expect(result.status).toBe("refused");
      expect(await repairState(t)).toEqual(before);
    }
    await t.run((ctx) => ctx.db.patch(s.releaseId, { binding: "hardcover" }));
    const foreign = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Fire Force" });
      const volumeId = await insertVolume(ctx, { seriesId, label: "2", position: 2 });
      return { seriesId, volumeId };
    });
    // Supported coverage repair can preserve labels while changing the actual work.
    const remapped = await t.mutation(internal.repair.runBatch, {
      actor: "ari",
      dryRun: false,
      entries: [
        {
          kind: "setCoverage",
          key: "lovecraft-wrong-covered-work",
          reason,
          editionId: s.editionId,
          before: s.volumeIds,
          coverage: [
            { seriesId: s.seriesId, label: "1", extent: "complete" },
            { seriesId: foreign.seriesId, label: "2", extent: "complete" },
          ],
          line: null,
          retireVolumeIds: [],
        },
      ],
    });
    expect(remapped[0]!.status).toBe("applied");
    if (route === "heldBooks") {
      await refusedLink(t, args, /another work/i);
    } else {
      const before = await repairState(t);
      const oldArgs = { observationId: s.observationId, releaseId: s.releaseId };
      const preview = await t.query(internal.printings.linkHeldStateInternal, oldArgs);
      expect(preview.refusal).toMatch(/another work/i);
      const result = await t.mutation(internal.printings.linkHeldInternal, {
        ...oldArgs,
        actor: "ari",
        expected: preview.guard!,
        reason,
        evidenceUrls: [lovecraftRecord.url],
      });
      expect(result.status).toBe("refused");
      expect(await repairState(t)).toEqual(before);
    }
    const restored = await t.mutation(internal.repair.runBatch, {
      actor: "ari",
      dryRun: false,
      entries: [
        {
          kind: "setCoverage",
          key: "lovecraft-correct-covered-work",
          reason,
          editionId: s.editionId,
          before: [s.volumeIds[0]!, foreign.volumeId],
          coverage: s.volumeIds.map((_, i) => ({
            seriesId: s.seriesId,
            label: String(i + 1),
            extent: "complete" as const,
          })),
          line: null,
          retireVolumeIds: [],
        },
      ],
    });
    expect(restored[0]!.status).toBe("applied");
    const proposalsBeforeLink = await t.run((ctx) => ctx.db.query("proposals").collect());
    if (route === "heldBooks") {
      const preview = await t.query(internal.heldBooks.previewInternal, args);
      expect(preview.refusal).toBeNull();
      expect(
        (
          await t.mutation(internal.heldBooks.executeInternal, {
            ...args,
            actor: "ari",
            operation: "link",
            expected: preview.expected!,
            reason,
            evidenceUrls: [lovecraftRecord.url],
          })
        ).status,
      ).toBe("applied");
    } else {
      const oldArgs = { observationId: s.observationId, releaseId: s.releaseId };
      const preview = await t.query(internal.printings.linkHeldStateInternal, oldArgs);
      expect(preview.refusal).toBeNull();
      expect(
        (
          await t.mutation(internal.printings.linkHeldInternal, {
            ...oldArgs,
            actor: "ari",
            expected: preview.guard!,
            reason,
            evidenceUrls: [lovecraftRecord.url],
          })
        ).status,
      ).toBe("linked");
    }
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.observationId))?.recordRef).toEqual({
        type: "release",
        id: s.releaseId,
      });
      expect(await ctx.db.query("placementHolds").collect()).toHaveLength(0);
      expect((await ctx.db.get(s.releaseId))?.binding).toBe("hardcover");
      expect(await ctx.db.query("heldRepairLedger").collect()).toHaveLength(1);
      expect(await ctx.db.query("proposals").collect()).toHaveLength(
        proposalsBeforeLink.length + 1,
      );
    });
  },
);

// Full public ANN snapshots from the October 6 staging inventory.
const lovecraftRecord = {
  annId: "49486",
  coverRange: {
    from: "1",
    to: "2",
  },
  date: {
    day: 9.0,
    month: 7.0,
    year: 2024.0,
  },
  editionLineHint: true,
  format: "physical",
  isbn13: "9781506740690",
  kind: "annRelease",
  mangaId: "21831",
  multi: true,
  page: {
    date: {
      day: 9.0,
      month: 7.0,
      year: 2024.0,
    },
    distributor: "Dark Horse Comics",
    distributorId: "26",
    fetchedAt: 1790502902600.0,
    isbn10: "1506740693",
    isbn13: "9781506740690",
    mangaId: "21831",
    priceCents: 4999.0,
    status: "ok",
    title: "H.P. Lovecraft's At the Mountains of Madness Deluxe Edition [Hardcover]",
    volume: "GN 1-2",
  },
  title: "H.P. Lovecraft's At the Mountains of Madness Deluxe Edition [Hardcover]",
  url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=49486",
};
const lovecraftParent = {
  altTitles: ["Kyōki no Sanmyaku ni te", "狂気の山脈にて"],
  credits: [
    {
      name: "Gou Tanabe",
      personId: "73966",
      task: "Story & Art",
    },
  ],
  id: "21831",
  kind: "annManga",
  releases: [
    {
      annId: "40804",
      date: {
        day: 9.0,
        month: 7.0,
        year: 2019.0,
      },
      editionLineHint: false,
      format: "digital",
      isbn13: "9781506710242",
      label: "1",
      multi: false,
      title: "At the Mountains of Madness",
    },
    {
      annId: "40805",
      date: {
        day: 3.0,
        month: 12.0,
        year: 2019.0,
      },
      editionLineHint: false,
      format: "digital",
      isbn13: "9781506710259",
      label: "2",
      multi: false,
      title: "At the Mountains of Madness",
    },
    {
      annId: "36043",
      date: {
        day: 25.0,
        month: 6.0,
        year: 2019.0,
      },
      editionLineHint: false,
      format: "physical",
      isbn13: "9781506710228",
      label: "1",
      multi: false,
      title: "At the Mountains of Madness",
    },
    {
      annId: "36044",
      date: {
        day: 3.0,
        month: 12.0,
        year: 2019.0,
      },
      editionLineHint: false,
      format: "physical",
      isbn13: "9781506710235",
      label: "2",
      multi: false,
      title: "At the Mountains of Madness",
    },
    {
      annId: "49486",
      coverRange: {
        from: "1",
        to: "2",
      },
      date: {
        day: 9.0,
        month: 7.0,
        year: 2024.0,
      },
      editionLineHint: true,
      format: "physical",
      isbn13: "9781506740690",
      multi: true,
      title: "H.P. Lovecraft's At the Mountains of Madness Deluxe Edition [Hardcover]",
    },
  ],
  staff: ["Gou Tanabe"],
  synopsis:
    "At the Mountains of Madness is a journey into the core of Lovecraft’s mythos—the deep caverns and even deeper time of the inhospitable continent where the secret history of our planet is preserved—amidst the ruins of its first civilization, built by the alien Elder Things with the help of their bioengineered monstrosities, the shoggoths.",
  title: "At the Mountains of Madness",
  url: "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=21831",
};

const gachaEvidence = sourceFormatEvidence.find((row) => row.reviewed.isbn13 === "9781952241567")!;
const gachaReviewed: ReviewedFormat = gachaEvidence.reviewed;
function parsedGacha(paperback = false) {
  const wire: Record<string, unknown> = JSON.parse(gachaEvidence.wire);
  if (paperback) wire.physical_format = "Paperback";
  const parsed = parseEditionJson(wire);
  if (!parsed) throw new Error("Saved Gacha 5 wire must parse.");
  return parsed;
}
async function gachaFormat(t: TestT) {
  await admin(t);
  return await t.run(async (ctx) => {
    const graph = gachaPhysicalGraph;
    const publisherId = await insertPublisher(ctx, graph.publisher);
    const seriesId = await insertSeries(ctx, {
      ...graph.series,
      altTitles: [...graph.series.altTitles],
    });
    const volumeId = await insertVolume(ctx, { ...graph.volume, seriesId, position: 5 });
    const book = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      edition: graph.edition,
      release: graph.release,
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: gachaReviewed.key,
      snapshot: parsedGacha(),
      lastSeenAt: graph.sourceLastSeenAt,
      conflicts: [
        { field: "placement", reason: graph.holdReason, offered: null, at: graph.sourceLastSeenAt },
      ],
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "volumeMissing",
      seriesId,
      heldAt: graph.sourceLastSeenAt,
    });
    return { observationId, holdId, publisherId, seriesId, volumeId, ...book };
  });
}
async function formatState(t: TestT, s: Awaited<ReturnType<typeof gachaFormat>>) {
  return await t.run(async (ctx) => ({
    observation: (await ctx.db.get(s.observationId))!,
    hold: await ctx.db.get(s.holdId),
    releases: await ctx.db.query("releases").collect(),
    editions: await ctx.db.query("editions").collect(),
    volumes: await ctx.db.query("volumes").collect(),
    series: await ctx.db.query("series").collect(),
    coverages: await ctx.db.query("volumeCoverages").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    versions: await ctx.db.query("proposalVersions").collect(),
    ledgers: await ctx.db.query("heldRepairLedger").collect(),
    history: await ctx.db.query("observationSnapshots").collect(),
    printings: await ctx.db.query("releaseIsbns").collect(),
  }));
}
async function correctGacha(
  t: TestT,
  s: Awaited<ReturnType<typeof gachaFormat>>,
  reviewed: ReviewedFormat = gachaReviewed,
) {
  const args = { observationId: s.observationId, reviewed };
  const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, args);
  expect(preview.refusal).toBeNull();
  expect(preview.correctionReady).toBe(true);
  expect(preview.placementNeedsFreshPreview).toBe(true);
  const result = await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
    ...args,
    expected: preview.expected!,
    actor: "ari",
  });
  expect(result.status).toBe("applied");
  return result;
}
async function replayGacha(t: TestT, s: Awaited<ReturnType<typeof gachaFormat>>) {
  const args = { observationId: s.observationId, replay: true };
  const preview = await t.query(internal.heldBooks.previewInternal, args);
  expect(preview.refusal).toBeNull();
  expect(preview.placement).toBe("create");
  const result = await t.mutation(internal.heldBooks.executeInternal, {
    ...args,
    actor: "ari",
    expected: preview.expected!,
    operation: "replay",
    reason: "Fresh guarded ebook placement after exact Format review.",
    evidenceUrls: [gachaReviewed.publisher.url],
  });
  expect(result.status).toBe("applied");
  return result;
}

describe("reviewed OL inferred physical-to-digital workflows", () => {
  it("checks all five saved public bodies and exact own-ISBN excerpts with the actual parser", async () => {
    const sha = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    expect(sourceFormatEvidence).toHaveLength(5);
    for (const row of sourceFormatEvidence) {
      const wire: Record<string, unknown> = JSON.parse(row.wire);
      expect(wire.physical_format).toBeUndefined();
      expect(await sha(row.wire)).toBe(row.reviewed.ol.bodySha256);
      expect(await sha(row.reviewed.publisher.excerpt)).toBe(row.reviewed.publisher.sectionSha256);
      const snapshot = parseEditionJson(wire)!;
      expect(valueHash(snapshot)).toBe(row.frozen);
      expect(snapshot.format).toBe("physical");
      expect(
        reviewedFormatRefusal(
          { sourceKey: "openlibrary", sourceRecordId: snapshot.key, snapshot },
          row.reviewed,
        ),
      ).toBeNull();
    }
  });
  it("audits correction without changing raw facts or the hold, retains equal refetch/backfill, then creates a distinct digital Release", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    const before = await formatState(t, s);
    const correction = await correctGacha(t, s);
    const corrected = await formatState(t, s);
    const { reviewedSourceFormat: decision, ...raw } = corrected.observation;
    expect(raw).toEqual(before.observation);
    expect(corrected.hold).toEqual(before.hold);
    expect(corrected.releases).toEqual(before.releases);
    expect(corrected.editions).toEqual(before.editions);
    expect(corrected.coverages).toEqual(before.coverages);
    expect(corrected.history).toEqual([]);
    expect(corrected.proposals).toHaveLength(1);
    expect(corrected.proposals[0]).toMatchObject({
      state: "approved",
      author: { kind: "user", roleAtAuthorship: "administrator" },
    });
    expect(corrected.versions).toHaveLength(1);
    expect(corrected.versions[0]!.evidence).toContainEqual({
      kind: "note",
      text: valueHash(gachaReviewed),
    });
    expect(corrected.ledgers).toHaveLength(1);
    expect(corrected.ledgers[0]!.before).toBe(
      valueHash({ observation: before.observation, hold: before.hold }),
    );
    expect(corrected.ledgers[0]!.after).toBe(
      valueHash({ observation: corrected.observation, hold: corrected.hold }),
    );
    expect(decision?.proposalId).toBe(correction.proposalId);
    expect(projectSourceFormat(corrected.observation)).toMatchObject({
      status: "corrected",
      snapshot: { ...corrected.observation.snapshot, format: "digital" },
    });
    const repeatArgs = { observationId: s.observationId, reviewed: gachaReviewed };
    const repeat = await t.query(internal.heldBooks.previewSourceFormatInternal, repeatArgs);
    expect(
      (
        await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
          ...repeatArgs,
          expected: repeat.expected!,
          actor: "ari",
        })
      ).status,
    ).toBe("alreadyApplied");
    expect(await formatState(t, s)).toEqual(corrected);
    expect(
      (await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha() })).status,
    ).toBe("recordOnly");
    const fetched = await formatState(t, s);
    expect(fetched.observation.snapshot).toEqual(before.observation.snapshot);
    expect(fetched.observation.lastSeenAt).not.toBe(before.observation.lastSeenAt);
    expect(fetched.hold).toEqual(before.hold);
    expect(fetched.observation.reviewedSourceFormat).toEqual(decision);
    await t.mutation(internal.imports.backfillHolds, {});
    const backfilled = await formatState(t, s);
    expect(backfilled.hold).toEqual(before.hold);
    expect(backfilled.releases).toEqual(before.releases);
    const replay = await replayGacha(t, s);
    const placed = await formatState(t, s);
    expect(placed.hold).toBeNull();
    expect(placed.releases).toHaveLength(2);
    expect(placed.releases.find((r) => r._id === s.releaseId)).toEqual(before.releases[0]);
    expect(placed.releases.find((r) => r._id === replay.releaseId)).toMatchObject({
      format: "digital",
      isbn13: "9781952241567",
    });
    expect(placed.series).toEqual(before.series);
    expect(placed.volumes).toEqual(before.volumes);
    expect(placed.observation.snapshot).toEqual(before.observation.snapshot);
    expect(placed.observation.lastSeenAt).toBe(fetched.observation.lastSeenAt);
    await expect(
      t.mutation(internal.heldBooks.restoreInternal, {
        actor: "ari",
        ledgerId: correction.ledgerId!,
        expectedAfter: corrected.ledgers[0]!.after,
        reason: "Old correction undo must refuse after placement.",
      }),
    ).rejects.toThrow(/after-state changed/);
    expect(await formatState(t, s)).toEqual(placed);
    const releaseBeforeDrift = placed.releases;
    await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha(true) });
    const linkedDrift = await formatState(t, s);
    expect(linkedDrift.releases).toEqual(releaseBeforeDrift);
    expect(linkedDrift.observation.reviewedSourceFormat?.invalidatedAt).toBeDefined();
    expect(linkedDrift.history).toHaveLength(1);
    await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha() });
    expect((await formatState(t, s)).releases).toEqual(releaseBeforeDrift);
  });
  it("latches actual-parser Paperback drift, retains history and hold after old wire returns, and exposes stale placement context", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    await correctGacha(t, s);
    const draft = await t
      .withIdentity({ subject: "admin" })
      .mutation(api.placement.preparePlacement, { observationId: s.observationId });
    expect(draft.status).toBe("prepared");
    if (!("proposalId" in draft)) throw new Error("Expected a placement draft.");
    const draftId = draft.proposalId;
    const before = await formatState(t, s);
    expect(before.proposals.find((p) => p._id === draftId)?.draft).toBeDefined();
    const ops = before.proposals.find((p) => p._id === draftId)!.draft!.ops;
    await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha(true) });
    const drift = await formatState(t, s);
    const invalidatedAt = drift.observation.reviewedSourceFormat!.invalidatedAt;
    expect(invalidatedAt).toBeDefined();
    expect(drift.observation.snapshot).toEqual(parsedGacha(true));
    expect(drift.history[0]!.snapshot).toEqual(parsedGacha());
    expect(drift.hold).toEqual(before.hold);
    expect(drift.releases).toEqual(before.releases);
    expect(drift.proposals).toEqual(before.proposals);
    expect(projectSourceFormat(drift.observation).status).toBe("stale");
    expect(await t.run((ctx) => placementChanged(ctx, ops))).toBe(true);
    const view = await t.run((ctx) => placementView(ctx, ops));
    expect(view?.refusal).toMatch(/stale/);
    expect(view?.sourceFormat).toMatchObject({
      status: "stale",
      effectiveFormat: null,
      rawFormat: "physical",
    });
    await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha() });
    const returned = await formatState(t, s);
    expect(returned.observation.reviewedSourceFormat!.invalidatedAt).toBe(invalidatedAt);
    expect(returned.history).toHaveLength(2);
    expect(projectSourceFormat(returned.observation).status).toBe("stale");
    const preview = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
    });
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toMatch(/stale/);
    const refused = await t.mutation(internal.heldBooks.executeInternal, {
      observationId: s.observationId,
      actor: "ari",
      operation: "refreshSource",
      expected: "stale",
      reason,
      evidenceUrls: [gachaReviewed.publisher.url],
    });
    expect(refused.status).toBe("refused");
    const printing = await t.mutation(internal.printings.recordDecidedInternal, {
      observationId: s.observationId,
      releaseId: s.releaseId,
      reason,
      evidenceUrl: gachaReviewed.publisher.url,
    });
    expect(printing.status).toBe("refused");
    expect(printing).toMatchObject({ reason: expect.stringMatching(/stale/) });
    await t.mutation(internal.imports.backfillHolds, {});
    expect((await formatState(t, s)).hold).toEqual(before.hold);
    expect((await formatState(t, s)).printings).toEqual([]);
    expect(
      (
        await t.query(internal.heldBooks.previewInternal, {
          observationId: s.observationId,
          target: { type: "release", id: s.releaseId },
        })
      ).expected,
    ).toBeNull();
  });
  it("removes the optional decision on immediate audited undo, and refuses the original undo after a genuine refetch", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    const before = await formatState(t, s);
    const correction = await correctGacha(t, s);
    const corrected = await formatState(t, s);
    await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: correction.ledgerId!,
      expectedAfter: corrected.ledgers[0]!.after,
      reason: "Undo exact source interpretation before placement.",
    });
    const restored = await formatState(t, s);
    expect(restored.observation).toEqual(before.observation);
    expect(Object.hasOwn(restored.observation, "reviewedSourceFormat")).toBe(false);
    expect(restored.hold).toEqual(before.hold);
    expect(restored.ledgers).toHaveLength(2);
    expect(restored.ledgers[0]).toEqual(corrected.ledgers[0]);
    expect(restored.ledgers[1]).toMatchObject({
      operation: "undoSourceFormat",
      before: corrected.ledgers[0]!.after,
      after: corrected.ledgers[0]!.before,
    });
    expect(restored.versions[1]!.evidence).toContainEqual({
      kind: "note",
      text: expect.stringContaining(correction.ledgerId!),
    });
    expect(projectSourceFormat(restored.observation).status).toBe("raw");
    const reapplied = await correctGacha(t, s);
    const after = await formatState(t, s);
    const ledger = after.ledgers.find((row) => row._id === reapplied.ledgerId)!;
    await t.mutation(internal.openLibrary.applyEdition, { snapshot: parsedGacha() });
    const fetched = await formatState(t, s);
    await expect(
      t.mutation(internal.heldBooks.restoreInternal, {
        actor: "ari",
        ledgerId: ledger._id,
        expectedAfter: ledger.after,
        reason: "Refetch consumed immediate undo.",
      }),
    ).rejects.toThrow(/after-state changed/);
    expect(await formatState(t, s)).toEqual(fetched);
  });
  it.each(["active", "hidden", "merged"] as const)(
    "refuses Other Printing and fresh replay of an occupied %s digital slot while allowing correction",
    async (status) => {
      const t = makeT();
      const s = await gachaFormat(t);
      // An existing alternate-ISBN digital slot is a catalog conflict, not permission to relabel the paperback.
      await t.run((ctx) =>
        insertRelease(ctx, {
          editionId: s.editionId,
          publisherId: s.publisherId,
          seriesIds: [s.seriesId],
          format: "digital",
          isbn13: "9781952241680",
          status,
        }),
      );
      await correctGacha(t, s);
      const before = await formatState(t, s);
      const printing = await t.mutation(internal.printings.recordDecidedInternal, {
        observationId: s.observationId,
        releaseId: s.releaseId,
        reason,
        evidenceUrl: gachaReviewed.publisher.url,
      });
      expect(printing).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/digital/),
      });
      expect(await formatState(t, s)).toEqual(before);
      const preview = await t.query(internal.heldBooks.previewInternal, {
        observationId: s.observationId,
        replay: true,
      });
      expect(preview.placement).not.toBe("create");
      const replay = await t.mutation(internal.heldBooks.executeInternal, {
        observationId: s.observationId,
        replay: true,
        actor: "ari",
        expected: preview.expected ?? "incomplete",
        operation: "replay",
        reason,
        evidenceUrls: [gachaReviewed.publisher.url],
      });
      expect(replay.status).toBe("refused");
      expect(await formatState(t, s)).toEqual(before);
    },
  );
  it("allows correction before a selected Volume lock but refuses later placement without writes", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    await t.run((ctx) => ctx.db.patch(s.volumeId, { locked: true }));
    await correctGacha(t, s);
    const before = await formatState(t, s);
    const preview = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
      replay: true,
    });
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toMatch(/active and unlocked/);
    const replay = await t.mutation(internal.heldBooks.executeInternal, {
      observationId: s.observationId,
      replay: true,
      actor: "ari",
      expected: preview.expected ?? "incomplete",
      operation: "replay",
      reason,
      evidenceUrls: [gachaReviewed.publisher.url],
    });
    expect(replay.status).toBe("refused");
    expect(await formatState(t, s)).toEqual(before);
  });
  it("keeps correction ready while unresolved ordinary Edition ownership blocks replay", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    // Two independent whole-Volume Editions are the same unresolved slot
    // member placement refuses, even when neither has a digital Release.
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId: s.publisherId });
      await insertCoverage(ctx, { editionId, volumeId: s.volumeId });
    });
    await correctGacha(t, s);
    const before = await formatState(t, s);
    const preview = await t.query(internal.heldBooks.previewInternal, {
      observationId: s.observationId,
      replay: true,
    });
    expect(preview.expected).toBeNull();
    expect(preview.refusal).toMatch(/Edition ownership is ambiguous/);
    const replay = await t.mutation(internal.heldBooks.executeInternal, {
      observationId: s.observationId,
      replay: true,
      actor: "ari",
      expected: "incomplete",
      operation: "replay",
      reason,
      evidenceUrls: [gachaReviewed.publisher.url],
    });
    expect(replay.status).toBe("refused");
    expect(await formatState(t, s)).toEqual(before);
  });
  it("places Gacha 5 when only an unrelated Volume is locked", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    const unrelatedId = await t.run((ctx) =>
      insertVolume(ctx, { seriesId: s.seriesId, label: "6", position: 6, locked: true }),
    );
    await correctGacha(t, s);
    const unrelated = await t.run((ctx) => ctx.db.get(unrelatedId));
    await replayGacha(t, s);
    expect(await t.run((ctx) => ctx.db.get(unrelatedId))).toEqual(unrelated);
  });
  it("skips reviewed stored descriptions in selection and mutation, retaining immediate correction undo", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    // The five captured bodies lack descriptions. This described counterpart
    // exercises the maintenance lifecycle without claiming new publisher evidence.
    const snapshot = { ...parsedGacha(), description: "Stored description for maintenance." };
    await t.run(async (ctx) => {
      await ctx.db.patch(s.observationId, { snapshot });
      await insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.publisherId,
        seriesIds: [s.seriesId],
        format: "digital",
        isbn13: snapshot.isbn13,
      });
    });
    const selected = await t.query(internal.openLibrary.unlinkedDescribedEditions, { after: null });
    expect(selected.snapshots).toEqual([snapshot]);
    const baseSnapshot = valueHash(snapshot);
    const correction = await correctGacha(t, s, {
      ...gachaReviewed,
      baseSnapshot,
      ol: { ...gachaReviewed.ol, normalizedSnapshot: baseSnapshot },
    });
    const before = await formatState(t, s);
    expect(
      (await t.query(internal.openLibrary.unlinkedDescribedEditions, { after: null })).snapshots,
    ).toEqual([]);
    expect(await t.action(internal.openLibrary.replayDescriptions, { limit: 1 })).toMatchObject({
      replayed: 0,
      linked: 0,
      errors: [],
    });
    // A batch selected before correction must be skipped by the mutation too.
    expect(
      await t.mutation(internal.openLibrary.applyEdition, {
        snapshot: selected.snapshots[0]!,
        storedDescriptionReplay: true,
      }),
    ).toEqual({ status: "recordOnly", changed: false });
    expect(
      await t.mutation(internal.openLibrary.applyEdition, {
        snapshot: { ...snapshot, description: "Older selected description." },
        storedDescriptionReplay: true,
      }),
    ).toEqual({ status: "recordOnly", changed: false });
    expect(await formatState(t, s)).toEqual(before);
    const ledger = before.ledgers.find((row) => row._id === correction.ledgerId)!;
    await t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: ledger._id,
      expectedAfter: ledger.after,
      reason: "Stored maintenance must preserve immediate correction undo.",
    });
    const restored = await formatState(t, s);
    expect(restored.observation.reviewedSourceFormat).toBeUndefined();
    expect(restored.observation.snapshot).toEqual(snapshot);
    expect(restored.observation.lastSeenAt).toBe(before.observation.lastSeenAt);
    expect(restored.hold).toEqual(before.hold);
  });
  it("refuses changed reviewed payload, known Paperback counterfacts and member review without incidental audit writes", async () => {
    const t = makeT();
    const s = await gachaFormat(t);
    const args = { observationId: s.observationId, reviewed: gachaReviewed };
    const preview = await t.query(internal.heldBooks.previewSourceFormatInternal, args);
    const before = await formatState(t, s);
    const changed = await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
      ...args,
      reviewed: { ...gachaReviewed, reason: "Changed evidence reason" },
      expected: preview.expected!,
      actor: "ari",
    });
    expect(changed.status).toBe("refused");
    expect(await formatState(t, s)).toEqual(before);
    const mismatch = await t.query(internal.heldBooks.previewSourceFormatInternal, {
      ...args,
      reviewed: { ...gachaReviewed, isbn13: "9781952241574" },
    });
    expect(mismatch.expected).toBeNull();
    await t.run(async (ctx) => {
      const proposalId = await ctx.db.insert("proposals", {
        state: "inReview",
        author: {
          kind: "user",
          userId: (await ctx.db.query("users").unique())!._id,
          roleAtAuthorship: "administrator",
        },
        currentVersionNo: 1,
      });
      await ctx.db.patch(s.observationId, { queuedProposalId: proposalId });
    });
    expect(
      (
        await t.mutation(internal.heldBooks.correctSourceFormatInternal, {
          ...args,
          expected: preview.expected!,
          actor: "ari",
        })
      ).status,
    ).toBe("refused");
    expect((await formatState(t, s)).ledgers).toEqual([]);
    await t.run((ctx) =>
      ctx.db.patch(s.observationId, { queuedProposalId: undefined, snapshot: parsedGacha(true) }),
    );
    const paperbackBase = valueHash(parsedGacha(true));
    const counterfact = await t.query(internal.heldBooks.previewSourceFormatInternal, {
      ...args,
      reviewed: {
        ...gachaReviewed,
        baseSnapshot: paperbackBase,
        ol: { ...gachaReviewed.ol, normalizedSnapshot: paperbackBase },
      },
    });
    expect(counterfact.expected).toBeNull();
    expect(counterfact.refusal).toMatch(/physical-format/);
    expect((await formatState(t, s)).ledgers).toEqual([]);
    // OL accepts this retained subtitle; the narrow correction must still preserve its audio counterfact.
    const audio = parseEditionJson({ ...JSON.parse(gachaEvidence.wire), subtitle: "Audiobook" })!;
    const audioBase = valueHash(audio);
    expect(
      reviewedFormatRefusal(
        { sourceKey: "openlibrary", sourceRecordId: audio.key, snapshot: audio },
        {
          ...gachaReviewed,
          baseSnapshot: audioBase,
          ol: { ...gachaReviewed.ol, normalizedSnapshot: audioBase },
        },
      ),
    ).toMatch(/scope facts contradict/);
  });
});

describe("complete by-title work provenance", () => {
  // Real staging Open Library boxes. On 2026-10-06, 589 staging Series held the
  // word "in" and 348 held "and", so neither whole title's search can finish
  // within the held-book bound; their distinctive words hold 1 to 28 Series.
  const abyssBox = {
    format: "physical",
    isbn13: "9798888433256",
    key: "/books/OL48776855M",
    kind: "olEdition",
    multiVolume: true,
    packaging: {
      coverRange: { from: "1", to: "5" },
      lineName: "Box Set",
      linePosition: "Season 1",
    },
    publishDate: { year: 2023 },
    publishers: ["Seven Seas Entertainment, LLC"],
    seriesTitle: "Made in Abyss",
    title: "Made in Abyss - Season 1 Box Set (Vol. 1-5)",
    url: "https://openlibrary.org/books/OL48776855M",
  };
  const soapBox = {
    format: "physical",
    isbn13: "9781646518302",
    key: "/books/OL39767840M",
    kind: "olEdition",
    multiVolume: false,
    packaging: { coverRange: null, lineName: "Box Set", linePosition: "2" },
    publishDate: { year: 2023 },
    publishers: ["Kodansha America, Incorporated"],
    seriesTitle: "Sweat and Soap",
    title: "Sweat and Soap Manga Box Set 2",
    url: "https://openlibrary.org/books/OL39767840M",
  };

  it("resolves real Made in Abyss and Sweat and Soap boxes past their common words, and refuses when every word overflows", async () => {
    const t = makeT();
    const { abyss, soap, observations } = await t.run(async (ctx) => {
      for (let i = 0; i < 81; i++) await insertSeries(ctx, { title: `Shelf ${i} in and` });
      const abyss = await insertSeries(ctx, { title: "Made in Abyss" });
      for (const title of [
        "Made in Abyss Official Anthology - Layer 1: Irredeemable Cave Raiders",
        "Made in Abyss Official Anthology - Layer 2: A Dangerous Hole",
      ])
        await insertSeries(ctx, { title });
      const soap = await insertSeries(ctx, {
        title: "Sweat and Soap",
        altTitles: ["Ase to Sekken", "あせとせっけん"],
      });
      const observations = [];
      for (const snapshot of [abyssBox, soapBox, { ...soapBox, seriesTitle: "In and" }])
        observations.push(
          await insertObservation(ctx, {
            sourceKey: "openlibrary",
            sourceRecordId: snapshot.key,
            snapshot,
          }),
        );
      return { abyss, soap, observations };
    });
    const resolve = (id: Id<"sourceObservations">) =>
      t.run(async (ctx) => {
        const source = await sourceSeries(ctx, (await ctx.db.get(id))!, reader(ctx));
        return source.series?._id ?? null;
      });
    expect(await resolve(observations[0]!)).toBe(abyss);
    expect(await resolve(observations[1]!)).toBe(soap);
    await expect(resolve(observations[2]!)).rejects.toThrow(
      "Resolver candidates exceed the complete bounded scan; incomplete.",
    );
  });
});
