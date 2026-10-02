// Sensitive catalog operations — the Moderator surface (ticket #33, spec §5):
// Hide, Restore, Merge, Split, and temporary Locks. Every mutation demands a
// reason and explicit confirmation of the impact preview (`manageForm`
// computes it; `confirmImpact` asserts the human saw it), and each applies as
// an immediately approved Proposal through the same apply functions the
// review queue uses (lib/sensitiveOps.ts) — the single write path.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  displayInfo,
  getCanonical,
  insertApprovedProposal,
  insertFirstVersion,
  resolveEditTarget,
  revisionsOf,
  type RecordRef,
} from "./moderation";
import {
  applyMerge,
  impactOf,
  reversibleManifestOf,
  SINGLE_RECORD_OPS,
  type OpMeta,
  type SingleRecordOp,
} from "./lib/sensitiveOps";
import { fail } from "./lib/errors";
import { requireModerator } from "./lib/roles";
import { recordRef, recordType } from "./schema";

// ---------- the manage panel query ----------

/**
 * Everything the sensitive-operations panel needs (Moderators only): the
 * record's title, status, and lock state, the impact preview the operations
 * must show before confirmation, and — for merged records — the survivor
 * pointer and whether an un-reversed manifest makes a Split possible. The
 * merge form reuses this same query to preview its survivor target.
 */
export const manageForm = query({
  args: { type: recordType, key: v.string() },
  handler: async (ctx, { type, key }) => {
    await requireModerator(ctx);
    const doc = await resolveEditTarget(ctx, type, key);
    if (!doc) return null;
    const ref = { type, id: doc._id } as RecordRef;
    const { title, backLink } = await displayInfo(ctx, type, doc);

    let mergedInto: { id: string; title: string } | null = null;
    if (doc.status === "merged" && doc.mergedIntoId) {
      const survivor = await getCanonical(ctx, {
        type,
        id: doc.mergedIntoId,
      } as RecordRef);
      if (survivor) {
        mergedInto = {
          id: doc.mergedIntoId as string,
          title: (await displayInfo(ctx, type, survivor)).title,
        };
      }
    }

    return {
      ref: { type, id: doc._id as string },
      title,
      status: doc.status,
      locked: doc.locked ?? false,
      impact: await impactOf(ctx, ref),
      mergedInto,
      splitAvailable:
        doc.status === "merged" && (await reversibleManifestOf(ctx, ref)) !== null,
      backLink,
    };
  },
});

// ---------- shared mutation plumbing ----------

type StoredOp = Doc<"proposalVersions">["ops"][number];

/**
 * Gate + wrap: require the Moderator role, a non-empty reason, and explicit
 * confirmation of the impact preview; then record the operation as an
 * immediately approved Proposal Version (the single write path) and hand
 * back the meta every apply function stamps on its Revisions.
 */
async function beginOperation(
  ctx: MutationCtx,
  args: { reason: string; confirmImpact: boolean },
  op: (baseOf: (ref: RecordRef) => Promise<Id<"revisions"> | undefined>) => Promise<StoredOp>,
): Promise<OpMeta> {
  const user = await requireModerator(ctx);
  const reason = args.reason.trim();
  if (reason === "") {
    fail("reasonRequired", "Every sensitive operation needs a reason.");
  }
  if (!args.confirmImpact) {
    fail("confirmRequired", "Review the impact preview and confirm the operation explicitly.");
  }
  const baseOf = async (ref: RecordRef) => (await revisionsOf(ctx, ref))[0]?._id;
  const storedOp = await op(baseOf);

  const author = {
    kind: "user" as const,
    userId: user._id,
    roleAtAuthorship: user.role,
  };
  const proposalId = await insertApprovedProposal(ctx, author, user._id);
  await insertFirstVersion(ctx, proposalId, { ops: [storedOp], evidence: [], changeComment: reason });
  return { proposalId, author, approvedBy: user._id, comment: reason };
}

const singleRefArgs = {
  ref: recordRef,
  reason: v.string(),
  confirmImpact: v.boolean(),
};

/**
 * The mutation for one single-record operation: recorded as its Proposal op
 * (hide, restore and split name the record's base Revision; locks do not),
 * then applied through the same function as the review queue.
 */
function singleRecordMutation(kind: SingleRecordOp) {
  return mutation({
    args: singleRefArgs,
    handler: async (ctx, args) => {
      const ref = args.ref;
      const meta = await beginOperation(ctx, args, async (baseOf): Promise<StoredOp> => {
        if (kind === "lock" || kind === "unlock") return { kind, ref };
        const baseRevisionId = await baseOf(ref);
        return kind === "split" ? { kind, ref, baseRevisionId, details: {} } : { kind, ref, baseRevisionId };
      });
      const revisionIds = await SINGLE_RECORD_OPS[kind](ctx, ref, meta);
      return { proposalId: meta.proposalId, revisionIds };
    },
  });
}

// ---------- the operations ----------

/** Hide: remove from public discovery, preserving identity/history/tracking. */
export const hideRecord = singleRecordMutation("hide");

/** Restore: reactivate a hidden record. Never reverses a merge. */
export const restoreRecord = singleRecordMutation("restore");

/** Temporarily lock an active record against ordinary edits (disputes). */
export const lockRecord = singleRecordMutation("lock");

export const unlockRecord = singleRecordMutation("unlock");

/**
 * Merge: pick the survivor, transfer observations, compatible relationships,
 * and user tracking, mark the loser Merged, and 301 its URLs permanently via
 * the merged-doc pointer. Reversed only by an explicit Split.
 */
export const mergeRecords = mutation({
  args: {
    survivor: recordRef,
    loser: recordRef,
    reason: v.string(),
    confirmImpact: v.boolean(),
  },
  handler: async (ctx, args) => {
    const survivor = args.survivor;
    const loser = args.loser;
    const meta = await beginOperation(ctx, args, async (baseOf) => {
      const bases: Id<"revisions">[] = [];
      const survivorBase = await baseOf(survivor);
      if (survivorBase) bases.push(survivorBase);
      const loserBase = await baseOf(loser);
      if (loserBase) bases.push(loserBase);
      return {
        kind: "merge",
        survivor,
        merged: loser,
        baseRevisionIds: bases,
      };
    });
    const revisionIds = await applyMerge(ctx, survivor, loser, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

/** Split: the explicit reversal of a mistaken merge. */
export const splitRecord = singleRecordMutation("split");
