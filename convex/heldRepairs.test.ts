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
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertVariant,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";

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

describe("guarded held-book workflows", () => {
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
      "releases",
      "editions",
      "volumes",
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
  "packaged Hardcover identity is enforced through %s and matching Hardcover still links",
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
      for (let n = 1; n <= 2; n++) {
        const volumeId = await insertVolume(ctx, { seriesId, label: String(n), position: n });
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
      return { releaseId, observationId };
    });
    const args = {
      observationId: s.observationId,
      target: { type: "release" as const, id: s.releaseId },
    };
    if (route === "heldBooks") {
      await refusedLink(t, args, /binding/i);
    } else {
      const before = await repairState(t);
      const preview = await t.query(internal.printings.linkHeldStateInternal, s);
      expect(preview.refusal).toMatch(/binding/i);
      expect(preview.guard).not.toBeNull();
      const result = await t.mutation(internal.printings.linkHeldInternal, {
        ...s,
        actor: "ari",
        expected: preview.guard!,
        reason,
        evidenceUrls: [lovecraftRecord.url],
      });
      expect(result.status).toBe("refused");
      expect(await repairState(t)).toEqual(before);
    }
    await t.run((ctx) => ctx.db.patch(s.releaseId, { binding: "hardcover" }));
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
      const preview = await t.query(internal.printings.linkHeldStateInternal, s);
      expect(preview.refusal).toBeNull();
      expect(
        (
          await t.mutation(internal.printings.linkHeldInternal, {
            ...s,
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
      expect(await ctx.db.query("proposals").collect()).toHaveLength(1);
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
