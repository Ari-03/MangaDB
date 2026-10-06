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

it("routes one Bookworm Part 2 observation using exact product evidence without changing its multi-Part ANN parent", async () => {
  const t = makeT();
  await admin(t);
  const sourceTitle = "Ascendance of a Bookworm - Part 2: I'll even join the temple to read books!";
  const s = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "J-Novel Club", slug: "j-novel-club" });
    const genericId = await insertSeries(ctx, { title: "Ascendance of a Bookworm" });
    const seriesId = await insertSeries(ctx, { title: "Ascendance of a Bookworm (Manga) Part 2" });
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
          { annId: "39627", title: sourceTitle, isbn13: "9781718372573" },
          { annId: "other", title: "Ascendance of a Bookworm - Part 1" },
        ],
      },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:39627",
      snapshot: {
        kind: "annRelease",
        annId: "39627",
        mangaId: "20892",
        title: sourceTitle,
        isbn13: "9781718372573",
        format: "physical",
        multi: false,
        editionLineHint: false,
        label: "1",
        page: { status: "ok", volume: "GN 1", distributor: "J-Novel Club" },
      },
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
