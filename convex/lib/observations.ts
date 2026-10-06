// Source Observation bookkeeping (spec §6): identity is
// (source, source-record-id); `snapshot` holds the latest normalized form —
// what reconciliation reads — and every superseded snapshot is retained
// append-only in observationSnapshots. Unchanged fetches bump last-seen
// only. Retention is indefinite in v1; withdrawal marks, never deletes.
// A record seen again stops being withdrawn, and the possible-cancellation
// review its withdrawal queued is retired with it.
//
// A record an import cannot place is held (recordUnplaced): its reason is
// the observation's `placement` note, and one a person could act on is
// listed as a Held Book (`placementHolds`) while it is unlinked, not
// withdrawn, and no import's Proposal of it is in review. Linking it
// (linkObservation), withdrawing it, or an import queuing a creation
// Proposal for it clears both (clearHold). A member's placement Proposal
// (placement.ts) leaves the book listed, marked by that Proposal's state.
//
// Linking an observation, a new snapshot on a linked one, and a withdrawn
// linked one seen again make its Series mature at once when it is 18+
// evidence (lib/mature.ts applyMatureEvidence), for every importer.

import { isbnScope } from "./scope";
import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { holdKind, recordRef } from "../schema";
import { applyMatureEvidence } from "./mature";
import { observedIsbn13, printingIsbnOf } from "./releaseIsbns";
import { sameValue } from "./values";

export type HoldKind = Infer<typeof holdKind>;

/**
 * Why an import holds a record, and the active Series it resolved, if any.
 * A null `kind` is a record no one can place or that is out of scope (no
 * ISBN, a variant cover, a prose or foreign-language imprint): its note is
 * kept for the record, but it is never listed.
 */
export type Hold = { kind: HoldKind | null; reason: string; seriesId?: Id<"series"> };

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
  const ops = await currentOps(ctx, proposal);
  const op = ops.length === 1 ? ops[0] : undefined;
  if (op?.kind !== "hide" || op.ref.type !== "release" || op.ref.id !== linked.id) return false;
  await ctx.db.patch(proposal._id, { state: "withdrawn", decidedAt: now });
  return true;
}

/**
 * Note a record present at its source (a listing hit, an unchanged fetch):
 * bump last-seen, clear a withdrawn mark, retire the possible-cancellation
 * review that withdrawal queued, and apply the relisted record's 18+
 * evidence (applyMatureEvidence). Every presence path goes through here, so
 * no adapter clears withdrawal while leaving its review approvable. An
 * ordinary sighting writes last-seen only. Returns the observation as now
 * stored.
 */
export async function markSeen(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  now: number,
): Promise<Doc<"sourceObservations">> {
  await ctx.db.patch(observation._id, { lastSeenAt: now, withdrawn: false });
  const seen = { ...observation, lastSeenAt: now, withdrawn: false };
  if (observation.withdrawn) {
    await retireLapsedCancellation(ctx, seen, now);
    await applyMatureEvidence(ctx, seen);
  }
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
  await applyMatureEvidence(ctx, observation);
  return { observation, changed: true };
}

/**
 * Whether the Proposal the observation points to is an import's and in
 * review, so the review queue has the book. `queuedProposalId` is a dedup
 * pointer that outlives its Proposal's decision, and conflict and
 * cancellation reviews set it too: only the Proposal's state says whether
 * anyone will act on it. A Data Team member's placement Proposal does not
 * count: its book stays a Held Book, shown as awaiting review, so a
 * rejection leaves it listed without waiting for its source to list it again.
 */
export async function proposalInReview(
  ctx: QueryCtx | MutationCtx,
  observation: Doc<"sourceObservations">,
): Promise<boolean> {
  if (observation.queuedProposalId === undefined) return false;
  const proposal = await ctx.db.get(observation.queuedProposalId);
  return proposal?.state === "inReview" && proposal.author.kind === "source";
}

/** The ops of the Proposal's current version. */
export async function currentOps(
  ctx: QueryCtx | MutationCtx,
  proposal: Doc<"proposals">,
): Promise<Doc<"proposalVersions">["ops"]> {
  const version = await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) =>
      q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
    )
    .unique();
  return version?.ops ?? [];
}

/**
 * Whether the op changes `ref` against its base Revision: an `update` (an
 * import's field conflict) or a `clearOverride`. Any Revision on the record
 * leaves such an op stale (proposals.ts staleRecordsOf); a `hide`, such as a
 * cancellation review, is not.
 */
export function anchoredOn(
  op: Doc<"proposalVersions">["ops"][number] | undefined,
  ref: { type: string; id: string },
): boolean {
  return (
    (op?.kind === "update" || op?.kind === "clearOverride") &&
    op.ref.type === ref.type &&
    op.ref.id === ref.id
  );
}

/** The observation's Held Book row, if it is listed. */
export async function holdOf(
  ctx: QueryCtx | MutationCtx,
  observationId: Id<"sourceObservations">,
): Promise<Doc<"placementHolds"> | null> {
  return await ctx.db
    .query("placementHolds")
    .withIndex("by_observation", (q) => q.eq("observationId", observationId))
    .unique();
}

/**
 * Leave a record the importer cannot place on its observation (spec §6:
 * record, never guess): the reason becomes its `placement` note, and an
 * unlinked, non-withdrawn observation is listed as a Held Book of
 * `hold.kind` unless an import's Proposal it points to is in review
 * (proposalInReview). A re-sighting of the same hold keeps its place in
 * the list (`heldAt`); a new kind moves it to the top. An unlisted hold
 * (null kind), a linked observation (a box set placed as a Release Bundle
 * that now names another Series), and one whose import Proposal is in
 * review (the review queue has it) carry the note only, and any row they
 * had is removed. Once that Proposal is decided, the next hold lists the
 * book again. Returns whether anything was written.
 */
export async function recordUnplaced(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  hold: Hold,
  now: number,
  keepHeldAt = false,
): Promise<boolean> {
  // The caller's copy may predate a write earlier in this mutation.
  const current = (await ctx.db.get(observation._id)) ?? observation;
  let changed = false;
  if (current.conflicts?.find((c) => c.field === "placement")?.reason !== hold.reason) {
    const kept = (current.conflicts ?? []).filter((c) => c.field !== "placement");
    await ctx.db.patch(current._id, {
      conflicts: [...kept, { field: "placement", offered: null, at: now, reason: hold.reason }],
    });
    changed = true;
  }
  const row = await holdOf(ctx, current._id);
  const listed =
    current.recordRef === undefined &&
    !current.withdrawn &&
    !(await proposalInReview(ctx, current));
  const kind = listed ? hold.kind : null;
  if (kind === null) {
    if (row === null) return changed;
    await ctx.db.delete(row._id);
    return true;
  }
  if (row === null) {
    await ctx.db.insert("placementHolds", {
      observationId: current._id,
      sourceKey: current.sourceKey,
      kind,
      heldAt: now,
      ...(hold.seriesId !== undefined ? { seriesId: hold.seriesId } : {}),
    });
    return true;
  }
  if (row.kind !== kind) {
    await ctx.db.patch(row._id, {
      kind,
      heldAt: keepHeldAt ? row.heldAt : now,
      seriesId: hold.seriesId,
    });
    return true;
  }
  if (row.seriesId !== hold.seriesId) {
    await ctx.db.patch(row._id, { seriesId: hold.seriesId });
    return true;
  }
  return changed;
}

/**
 * Take the observation off the Held Books list and drop its `placement`
 * note: it was placed, withdrawn, queued for review, or no longer held.
 * Returns whether anything was written.
 */
export async function clearHold(
  ctx: MutationCtx,
  observationId: Id<"sourceObservations">,
): Promise<boolean> {
  let changed = false;
  const row = await holdOf(ctx, observationId);
  if (row !== null) {
    await ctx.db.delete(row._id);
    changed = true;
  }
  const conflicts = (await ctx.db.get(observationId))?.conflicts;
  if (conflicts?.some((c) => c.field === "placement")) {
    await ctx.db.patch(observationId, {
      conflicts: conflicts.filter((c) => c.field !== "placement"),
    });
    changed = true;
  }
  return changed;
}

/**
 * Link the observation to a canonical record (matching rung ①), the one way
 * every importer and repair writes the link (a merge or Split repoints
 * links directly, lib/sensitiveOps.ts). A linked record is placed, so
 * its hold and `placement` note go (clearHold), and its Series becomes
 * mature at once if the link is 18+ evidence (applyMatureEvidence). A
 * record of one of a Release's Other Printings, linked to that Release, is
 * marked with the printing's ISBN (`printingIsbn13`); any other link
 * clears the mark.
 */
export async function linkObservation(
  ctx: MutationCtx,
  observationId: Id<"sourceObservations">,
  ref: Infer<typeof recordRef>,
): Promise<void> {
  const previous = await ctx.db.get(observationId);
  if (ref.type === "release" || ref.type === "releaseBundle") {
    const scope = await isbnScope(ctx, observedIsbn13(previous?.snapshot));
    if (scope && !sameValue(previous?.recordRef, ref)) throw new ConvexError(scope);
  }
  await ctx.db.patch(observationId, { recordRef: ref });
  await clearHold(ctx, observationId);
  const observation = await ctx.db.get(observationId);
  if (!observation) return;
  const printingIsbn13 =
    ref.type === "release"
      ? await printingIsbnOf(ctx, ref.id, observedIsbn13(observation.snapshot))
      : undefined;
  if (printingIsbn13 !== observation.printingIsbn13) {
    await ctx.db.patch(observationId, { printingIsbn13 });
  }
  await applyMatureEvidence(ctx, { ...observation, printingIsbn13 });
}
