// Source Observation bookkeeping (ticket #34, spec §6): identity is
// (source, source-record-id); `snapshot` holds the latest normalized form —
// what reconciliation reads — and every superseded snapshot is retained
// append-only in observationSnapshots. Unchanged fetches bump last-seen
// only. Retention is indefinite in v1; withdrawal marks, never deletes.

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
  isNew: boolean;
};

/**
 * Record one fetch of a source record. New identity → new observation;
 * same snapshot → bump lastSeenAt (and clear a stale withdrawn mark — the
 * record is demonstrably back); changed snapshot → move the prior snapshot
 * into the append-only history, then store the new one.
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
    return { observation, changed: true, isNew: true };
  }

  if (sameValue(existing.snapshot, args.snapshot)) {
    await ctx.db.patch(existing._id, { lastSeenAt: args.now, withdrawn: false });
    return {
      observation: { ...existing, lastSeenAt: args.now, withdrawn: false },
      changed: false,
      isNew: false,
    };
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
  return {
    observation: {
      ...existing,
      snapshot: args.snapshot,
      lastSeenAt: args.now,
      withdrawn: false,
    },
    changed: true,
    isNew: false,
  };
}
