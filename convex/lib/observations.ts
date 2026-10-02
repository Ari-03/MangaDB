// Source Observation bookkeeping (spec §6): identity is
// (source, source-record-id); `snapshot` holds the latest normalized form —
// what reconciliation reads — and every superseded snapshot is retained
// append-only in observationSnapshots. Unchanged fetches bump last-seen
// only. Retention is indefinite in v1; withdrawal marks, never deletes.
// A record seen again stops being withdrawn, and the possible-cancellation
// review its withdrawal queued is retired with it.

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sameValue } from "./values";

export async function getObservation(
  ctx: QueryCtx | MutationCtx,
  sourceKey: string,
  sourceRecordId: string,
): Promise<Doc<"sourceObservations"> | null> {
  return await ctx.db
    .query("sourceObservations")
    .withIndex("by_source_record", (q) =>
      q.eq("sourceKey", sourceKey).eq("sourceRecordId", sourceRecordId),
    )
    .unique();
}

export type UpsertResult = {
  observation: Doc<"sourceObservations">;
  /** False exactly when the snapshot equals the stored one (last-seen bump). */
  changed: boolean;
};

/**
 * Retire a possible-cancellation review whose evidence has lapsed: the
 * observation is no longer withdrawn, yet its queued item is still the
 * In-Review `hide` of its linked Release that the withdrawal queued
 * (imports.ts queueWithdrawalReview). Withdrawal was the only evidence, so
 * the review is withdrawn instead of staying approvable against a book the
 * source lists again. Any other queued item is left alone. Call after a
 * relist clears `withdrawn` (`markSeen` does); returns whether a review was
 * retired.
 */
export async function retireLapsedCancellation(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  now: number,
): Promise<boolean> {
  const linked = observation.recordRef;
  if (observation.withdrawn || !observation.queuedProposalId || linked?.type !== "release") {
    return false;
  }
  const proposal = await ctx.db.get(observation.queuedProposalId);
  if (
    proposal?.state !== "inReview" ||
    proposal.author.kind !== "source" ||
    proposal.author.sourceKey !== observation.sourceKey
  ) {
    return false;
  }
  const version = await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) =>
      q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
    )
    .unique();
  const op = version?.ops.length === 1 ? version.ops[0] : undefined;
  if (op?.kind !== "hide" || op.ref.type !== "release" || op.ref.id !== linked.id) return false;
  await ctx.db.patch(proposal._id, { state: "withdrawn", decidedAt: now });
  return true;
}

/**
 * Note a record present at its source (a listing hit, an unchanged fetch):
 * bump last-seen, clear a withdrawn mark, and retire the possible-
 * cancellation review that withdrawal queued. Every presence path goes
 * through here, so no adapter clears withdrawal while leaving its review
 * approvable. Returns the observation as now stored.
 */
export async function markSeen(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  now: number,
): Promise<Doc<"sourceObservations">> {
  await ctx.db.patch(observation._id, { lastSeenAt: now, withdrawn: false });
  const seen = { ...observation, lastSeenAt: now, withdrawn: false };
  if (observation.withdrawn) await retireLapsedCancellation(ctx, seen, now);
  return seen;
}

/**
 * Record one fetch of a source record. New identity → new observation;
 * same snapshot → bump lastSeenAt (and clear a stale withdrawn mark — the
 * record is demonstrably back); changed snapshot → move the prior snapshot
 * into the append-only history, then store the new one. Either way a
 * relisted record retires its lapsed possible-cancellation review.
 */
export async function upsertObservation(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    sourceRecordId: string;
    snapshot: unknown;
    now: number;
  },
): Promise<UpsertResult> {
  const existing = await getObservation(ctx, args.sourceKey, args.sourceRecordId);
  if (!existing) {
    const id = await ctx.db.insert("sourceObservations", {
      sourceKey: args.sourceKey,
      sourceRecordId: args.sourceRecordId,
      snapshot: args.snapshot,
      lastSeenAt: args.now,
      withdrawn: false,
    });
    const observation = (await ctx.db.get(id))!;
    return { observation, changed: true };
  }

  if (sameValue(existing.snapshot, args.snapshot)) {
    const observation = await markSeen(ctx, existing, args.now);
    return { observation, changed: false };
  }

  await ctx.db.insert("observationSnapshots", {
    observationId: existing._id,
    snapshot: existing.snapshot,
    supersededAt: args.now,
  });
  await ctx.db.patch(existing._id, {
    snapshot: args.snapshot,
    lastSeenAt: args.now,
    withdrawn: false,
  });
  const observation = {
    ...existing,
    snapshot: args.snapshot,
    lastSeenAt: args.now,
    withdrawn: false,
  };
  if (existing.withdrawn) await retireLapsedCancellation(ctx, observation, args.now);
  return { observation, changed: true };
}
