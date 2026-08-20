// Sensitive catalog operations — the Moderator surface (ticket #33, spec §5):
// Hide, Restore, Merge, Split, and temporary Locks. Every mutation demands a
// reason and explicit confirmation of the impact preview (`manageForm`
// computes it; `confirmImpact` asserts the human saw it), and each applies as
// an immediately approved Proposal through the same apply functions the
// review queue uses (lib/sensitiveOps.ts) — the single write path.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  displayInfo,
  getCanonical,
  recordTypeArg,
  resolveEditTarget,
  revisionsOf,
  type RecordRef,
} from "./moderation";
import {
  applyHide,
  applyLock,
  applyMerge,
  applyRestore,
  applySplit,
  applyUnlock,
  impactOf,
  reversibleManifestOf,
  type OpMeta,
} from "./lib/sensitiveOps";
import { requireModerator } from "./lib/roles";
import { recordRef } from "./schema";

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

// ---------- the manage panel query ----------

/**
 * Everything the sensitive-operations panel needs (Moderators only): the
 * record's title, status, and lock state, the impact preview the operations
 * must show before confirmation, and — for merged records — the survivor
 * pointer and whether an un-reversed manifest makes a Split possible. The
 * merge form reuses this same query to preview its survivor target.
 */
export const manageForm = query({
  args: { type: recordTypeArg, key: v.string() },
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
  const now = Date.now();
  const proposalId = await ctx.db.insert("proposals", {
    author,
    state: "approved",
    currentVersionNo: 1,
    submittedAt: now,
    decidedBy: user._id,
    decidedAt: now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: [storedOp],
    evidence: [],
    changeComment: reason,
  });
  return { proposalId, author, approvedBy: user._id, comment: reason };
}

const singleRefArgs = {
  ref: recordRef,
  reason: v.string(),
  confirmImpact: v.boolean(),
};

// ---------- the operations ----------

/** Hide: remove from public discovery, preserving identity/history/tracking. */
export const hideRecord = mutation({
  args: singleRefArgs,
  handler: async (ctx, args) => {
    const ref = args.ref as RecordRef;
    const meta = await beginOperation(ctx, args, async (baseOf) => ({
      kind: "hide",
      ref: ref as never,
      baseRevisionId: await baseOf(ref),
    }));
    const revisionIds = await applyHide(ctx, ref, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

/** Restore: reactivate a hidden record. Never reverses a merge. */
export const restoreRecord = mutation({
  args: singleRefArgs,
  handler: async (ctx, args) => {
    const ref = args.ref as RecordRef;
    const meta = await beginOperation(ctx, args, async (baseOf) => ({
      kind: "restore",
      ref: ref as never,
      baseRevisionId: await baseOf(ref),
    }));
    const revisionIds = await applyRestore(ctx, ref, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

/** Temporarily lock an active record against ordinary edits (disputes). */
export const lockRecord = mutation({
  args: singleRefArgs,
  handler: async (ctx, args) => {
    const ref = args.ref as RecordRef;
    const meta = await beginOperation(ctx, args, async () => ({
      kind: "lock",
      ref: ref as never,
    }));
    const revisionIds = await applyLock(ctx, ref, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

export const unlockRecord = mutation({
  args: singleRefArgs,
  handler: async (ctx, args) => {
    const ref = args.ref as RecordRef;
    const meta = await beginOperation(ctx, args, async () => ({
      kind: "unlock",
      ref: ref as never,
    }));
    const revisionIds = await applyUnlock(ctx, ref, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

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
    const survivor = args.survivor as RecordRef;
    const loser = args.loser as RecordRef;
    const meta = await beginOperation(ctx, args, async (baseOf) => {
      const bases: Id<"revisions">[] = [];
      const survivorBase = await baseOf(survivor);
      if (survivorBase) bases.push(survivorBase);
      const loserBase = await baseOf(loser);
      if (loserBase) bases.push(loserBase);
      return {
        kind: "merge",
        survivor: survivor as never,
        merged: loser as never,
        baseRevisionIds: bases,
      };
    });
    const revisionIds = await applyMerge(ctx, survivor, loser, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});

/** Split: the explicit reversal of a mistaken merge. */
export const splitRecord = mutation({
  args: singleRefArgs,
  handler: async (ctx, args) => {
    const ref = args.ref as RecordRef;
    const meta = await beginOperation(ctx, args, async (baseOf) => ({
      kind: "split",
      ref: ref as never,
      baseRevisionId: await baseOf(ref),
      details: {},
    }));
    const revisionIds = await applySplit(ctx, ref, meta);
    return { proposalId: meta.proposalId, revisionIds };
  },
});
