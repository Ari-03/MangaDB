import { expect, it, vi } from "vitest";
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
for (const contradiction of ["coverRange", "coverageGapped"] as const) {
  it(`astra: refuses parent member ${contradiction} counterfact`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    await t.run(async (ctx) => {
      const releases = collectionParent.releases.map((r) =>
        r.annId === collectionProducts[0]!.snapshot.annId
          ? {
              ...r,
              ...(contradiction === "coverRange"
                ? { coverRange: { from: "6", to: "7" } }
                : { coverageGapped: true }),
            }
          : r,
      );
      await ctx.db.patch(s.parentId, { snapshot: { ...collectionParent, releases } });
    });
    const p = await preview(t, s);
    expect.soft(p.ready).toBe(false);
    if (p.expected) {
      const routed = await apply(t, s, p.expected);
      expect.soft(routed.status).toBe("refused");
      const link = await t.query(internal.heldBooks.previewInternal, {
        observationId: s.observationId,
        target: s.target,
        reviewed: s.reviewed,
      });
      expect.soft(link.classification).toBe("blocked");
      if (link.expected) {
        expect.soft((await apply(t, s, link.expected, "link")).status).toBe("refused");
        expect.soft(await t.run((ctx) => ctx.db.get(s.holdId))).not.toBeNull();
      }
    }
  });
}

for (const operation of ["reviewSeries", "link"] as const) {
  for (const drift of [
    "source title",
    "parent title",
    "parent order",
    "coverage order",
    "release revision",
    "proof url",
    "parent proposal",
  ] as const) {
    it(`astra: ${operation} rejects ${drift} drift without writes`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      const p = await preview(t, s);
      expect(p.ready).toBe(true);
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
      await t.run(async (ctx) => {
        switch (drift) {
          case "source title":
            await ctx.db.patch(s.observationId, {
              snapshot: {
                ...collectionProducts[0]!.snapshot,
                title: "Parasyte Paperback Collection",
              },
            });
            break;
          case "parent title":
            await ctx.db.patch(s.parentId, {
              snapshot: { ...collectionParent, title: "Parasite" },
            });
            break;
          case "parent order":
            await ctx.db.patch(s.parentId, {
              snapshot: { ...collectionParent, releases: [...collectionParent.releases].reverse() },
            });
            break;
          case "coverage order": {
            const row = (await ctx.db
              .query("volumeCoverages")
              .withIndex("by_edition", (q) => q.eq("editionId", s.editionId))
              .first())!;
            await ctx.db.patch(row._id, { order: 17 });
            break;
          }
          case "release revision":
            await insertSourceRevision(ctx, {
              sourceKey: "kodansha",
              ref: { type: "release", id: s.releaseId },
              changes: [],
            });
            break;
          case "proof url": {
            const url = s.reviewed.collectionRouting.productEvidence.url + "?review=changed";
            s.reviewed.collectionRouting.productEvidence = {
              ...s.reviewed.collectionRouting.productEvidence,
              url,
            };
            s.reviewed.evidenceUrls = [url];
            break;
          }
          case "parent proposal": {
            const user = (await ctx.db.query("users").first())!;
            const id = await ctx.db.insert("proposals", {
              author: { kind: "user", userId: user._id, roleAtAuthorship: "administrator" },
              state: "inReview",
              currentVersionNo: 1,
            });
            await ctx.db.patch(s.parentId, { queuedProposalId: id });
            break;
          }
        }
      });
      const before = await rows(t);
      expect((await apply(t, s, expected!, operation)).status).toBe("refused");
      expect(await rows(t)).toEqual(before);
    });
  }
  it(`astra: ${operation} audit failure permits one clean retry`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    let expected = (await preview(t, s)).expected!;
    if (operation === "link") {
      expect((await apply(t, s, expected)).status).toBe("applied");
      expected = (
        await t.query(internal.heldBooks.previewInternal, {
          observationId: s.observationId,
          target: s.target,
          reviewed: s.reviewed,
        })
      ).expected!;
    }
    const before = await rows(t);
    const spy = vi
      .spyOn(moderation, "insertFirstVersion")
      .mockRejectedValueOnce(new Error("astra audit failure"));
    try {
      expect((await apply(t, s, expected, operation)).status).toBe("refused");
    } finally {
      spy.mockRestore();
    }
    expect(await rows(t)).toEqual(before);
    expect((await apply(t, s, expected, operation)).status).toBe("applied");
    const after = await rows(t);
    expect(after.ledger).toHaveLength(before.ledger.length + 1);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect((await apply(t, s, expected, operation)).status).toBe("refused");
    expect(await rows(t)).toEqual(after);
  });
}
