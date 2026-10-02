// Observation bookkeeping (lib/observations.ts) and the possible-
// cancellation review it supports: a relisted Release retires the hide
// review its withdrawal queued (B17), whether the relist arrives through
// upsertObservation or an adapter's own last-seen bump followed by
// reconcileFields.

import { describe, expect, it } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertEdition, insertObservation, insertPublisher, insertRelease, insertSeries } from "../test.factories";
import { makeT, seedRegistry, type TestT } from "../test.helpers";
import { upsertObservation } from "./observations";
import { reconcileFields } from "./reconcile";

const FUTURE = { year: 2100, month: 1, day: 6, sort: 21000106 };
const SNAPSHOT = { title: "Alpha Adventures Vol. 1" };

/** A future-dated Release linked to a Seven Seas observation. */
async function linkedRelease(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
  const seriesId = await insertSeries(ctx, { title: "Alpha Adventures" });
  const editionId = await insertEdition(ctx, { publisherId });
  const releaseId = await insertRelease(ctx, {
    editionId,
    isbn13: "9781999000103",
    pubDate: FUTURE,
    publisherId,
    seriesIds: [seriesId],
  });
  const observationId = await insertObservation(ctx, {
    sourceKey: "sevenseas",
    sourceRecordId: "book:101",
    recordRef: { type: "release", id: releaseId },
    snapshot: SNAPSHOT,
    lastSeenAt: 1_000,
  });
  return { releaseId, observationId };
}

/** Seed the registry and a linked Release, then withdraw it from a sweep. */
async function withdrawnWithReview(t: TestT) {
  await seedRegistry(t);
  const ids = await t.run(linkedRelease);
  const swept = await t.mutation(internal.imports.markWithdrawn, {
    sourceKey: "sevenseas",
    notSeenSince: Date.now(),
  });
  expect(swept.reviewsQueued).toBe(1);
  const proposalId = (await t.run((ctx) => ctx.db.get(ids.observationId)))!.queuedProposalId!;
  return { ...ids, proposalId };
}

const stateOf = (t: TestT, id: Id<"proposals">) =>
  t.run(async (ctx) => (await ctx.db.get(id))!.state);

describe("relisting retires the possible-cancellation review (B17)", () => {
  it("an unchanged relist through upsertObservation withdraws the open hide review", async () => {
    const t = makeT();
    const { observationId, proposalId } = await withdrawnWithReview(t);
    await t.run(async (ctx) => {
      const { observation } = await upsertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "book:101",
        snapshot: SNAPSHOT,
        now: 5_000,
      });
      expect(observation.withdrawn).toBe(false);
    });
    expect(await stateOf(t, proposalId)).toBe("withdrawn");
    // Dropped again later, the book queues a fresh review.
    const again = await t.mutation(internal.imports.markWithdrawn, {
      sourceKey: "sevenseas",
      notSeenSince: Date.now(),
    });
    expect(again.reviewsQueued).toBe(1);
    const next = (await t.run((ctx) => ctx.db.get(observationId)))!.queuedProposalId;
    expect(next).not.toBe(proposalId);
  });

  it("a changed relist withdraws it too", async () => {
    const t = makeT();
    const { proposalId } = await withdrawnWithReview(t);
    await t.run((ctx) =>
      upsertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "book:101",
        snapshot: { ...SNAPSHOT, price: 1399 },
        now: 5_000,
      }),
    );
    expect(await stateOf(t, proposalId)).toBe("withdrawn");
  });

  it("reconciling a relisted observation withdraws a review the relist skipped", async () => {
    const t = makeT();
    const { releaseId, observationId, proposalId } = await withdrawnWithReview(t);
    await t.run(async (ctx) => {
      // An adapter's listing hit bumps last-seen without upsertObservation.
      await ctx.db.patch(observationId, { withdrawn: false, lastSeenAt: 5_000 });
      const release = (await ctx.db.get(releaseId))!;
      await reconcileFields(ctx, {
        sourceKey: "sevenseas",
        ref: { type: "release", id: releaseId },
        doc: release,
        offered: { isbn13: release.isbn13 },
        observation: (await ctx.db.get(observationId))!,
        citation: { sourceName: "Seven Seas", url: "https://example.org/book" },
        now: 5_000,
      });
    });
    expect(await stateOf(t, proposalId)).toBe("withdrawn");
  });

  it("keeps the review while the observation stays withdrawn, and leaves other queue items alone", async () => {
    const t = makeT();
    const { releaseId, observationId, proposalId } = await withdrawnWithReview(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(releaseId))!;
      await reconcileFields(ctx, {
        sourceKey: "sevenseas",
        ref: { type: "release", id: releaseId },
        doc: release,
        offered: { isbn13: release.isbn13 },
        observation: (await ctx.db.get(observationId))!,
        citation: { sourceName: "Seven Seas", url: "https://example.org/book" },
        now: 5_000,
      });
    });
    expect(await stateOf(t, proposalId)).toBe("inReview");

    // A creation guess queued on an observation is not a cancellation review.
    const creation = await t.run(async (ctx) => {
      const id = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "sevenseas" },
        state: "inReview",
        currentVersionNo: 1,
        submittedAt: 1,
      });
      await ctx.db.insert("proposalVersions", {
        proposalId: id,
        versionNo: 1,
        ops: [{ kind: "create", table: "series", tempId: "series", fields: { title: "X" } }],
        evidence: [],
        changeComment: "guess",
      });
      await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "book:202",
        snapshot: { title: "X" },
        lastSeenAt: 1_000,
        withdrawn: true,
        queuedProposalId: id,
      });
      await upsertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "book:202",
        snapshot: { title: "X" },
        now: 5_000,
      });
      return id;
    });
    expect(await stateOf(t, creation)).toBe("inReview");
  });
});
