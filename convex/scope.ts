import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { insertApprovedProposal, insertFirstVersion } from "./moderation";
import { resolveActor } from "./lib/repair/audit";
import { evidenceUrls, scopeState } from "./lib/scope";
import { valueHash } from "./lib/values";

const reason = v.union(
  v.literal("novel"),
  v.literal("merchandise"),
  v.literal("sampler"),
  v.literal("nonEnglish"),
  v.literal("childrensBook"),
  v.literal("audio"),
  v.literal("libraryRebind"),
);
export const stateInternal = internalQuery({
  args: { isbn: v.string() },
  handler: async (ctx, { isbn }) => {
    const state = await scopeState(ctx, isbn);
    return { ...state, expected: valueHash(state) };
  },
});

/**
 * Exact ISBN only. childrensBook means picture/board books, never children's manga.
 * Library rebinds require reviewed product evidence, never a publisher-prefix ban.
 */
export const decideInternal = internalMutation({
  args: {
    actor: v.string(),
    isbn13: v.string(),
    reason,
    evidenceUrls: v.array(v.string()),
    expected: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.actor);
    const urls = evidenceUrls(args.evidenceUrls);
    const state = await scopeState(ctx, args.isbn13);
    if (args.expected !== valueHash(state))
      throw new ConvexError("Scope state changed; preview again.");
    if (
      state.active?.reason === args.reason &&
      valueHash(state.active.evidenceUrls) === valueHash(urls)
    )
      return { status: "alreadyApplied" as const, decisionId: state.active._id };
    if (state.active)
      throw new ConvexError(
        "Revoke the active decision with its reviewed state before replacing it.",
      );
    const author = { kind: "user" as const, userId: actor.userId, roleAtAuthorship: actor.role };
    const proposalId = await insertApprovedProposal(ctx, author, actor.userId);
    await insertFirstVersion(ctx, proposalId, {
      ops: [],
      evidence: urls.map((url) => ({ kind: "url" as const, url })),
      changeComment: `Exact ISBN ${state.isbn13} outside catalog: ${args.reason}`,
    });
    const decisionId = await ctx.db.insert("scopeDecisions", {
      isbn13: state.isbn13,
      reason: args.reason,
      evidenceUrls: urls,
      decidedBy: actor.userId,
      decidedAt: Date.now(),
      proposalId,
    });
    return { status: "applied" as const, decisionId, proposalId };
  },
});

/** Revocation preserves evidence/history. Requeue uses the separate expected-after hold restoration. */
export const revokeInternal = internalMutation({
  args: {
    actor: v.string(),
    decisionId: v.id("scopeDecisions"),
    reason: v.string(),
    expected: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.actor);
    if (!args.reason.trim() || args.reason.length > 4000)
      throw new ConvexError("Give a short reason for revocation.");
    const decision = await ctx.db.get(args.decisionId);
    if (!decision) throw new ConvexError("No such decision.");
    const state = await scopeState(ctx, decision.isbn13);
    if (args.expected !== valueHash(state))
      throw new ConvexError("Scope state changed; preview again.");
    if (decision.revokedAt !== undefined) return { status: "alreadyApplied" as const };
    const author = { kind: "user" as const, userId: actor.userId, roleAtAuthorship: actor.role };
    const proposalId = await insertApprovedProposal(ctx, author, actor.userId);
    await insertFirstVersion(ctx, proposalId, {
      ops: [],
      evidence: [
        {
          kind: "note",
          text: `Revoke scope decision ${decision._id}; original evidence stays immutable.`,
        },
      ],
      changeComment: args.reason.trim(),
    });
    await ctx.db.patch(decision._id, { revokedAt: Date.now(), revokedByProposalId: proposalId });
    return { status: "applied" as const, proposalId };
  },
});
