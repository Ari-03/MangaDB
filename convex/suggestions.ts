// The viewer's own Proposals, for the Suggestions tab of /me and its
// detail page (CONTEXT.md: a Suggestion is a reader's Proposal). Writing
// goes through proposals.ts (saveDraft, submitProposal, withdrawProposal,
// rebaseProposal), which any signed-in author may call on their own
// Proposal. These queries read only Proposals the viewer wrote, and only
// the author's side of review: the ops with before and after, evidence,
// the change comment, the decision time, and what a reviewer said to the
// author (why it was rejected, or what to change). Never the Data Team's
// internal discussion, who claimed or decided it, or anyone else's
// Proposal: the review queue and its pending work stay the Data Team's.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { viewerOrNull } from "./lib/auth";
import { summarizeVersion } from "./lib/queueSummary";
import { coverArtOf, editKeyOf, getCanonical } from "./moderation";
import {
  currentVersionOf,
  recordSubjectOf,
  renderEvidence,
  renderOps,
  staleRecordsOf,
} from "./proposals";

/** The most rows the Suggestions list shows, newest first. */
export const MINE_MAX = 50;

/** The most notes one Proposal's decisions are read from. */
const NOTES_READ = 100;

/** The most versions one Proposal's page shows. */
const VERSIONS_READ = 50;

const STATES = ["draft", "inReview", "approved", "rejected", "withdrawn"] as const;

/**
 * What reviewers told the author, oldest first: each rejection's reason
 * and each request for changes. The internal discussion (`comment` notes)
 * is left out.
 */
async function decisionsOf(ctx: QueryCtx, proposalId: Id<"proposals">) {
  const notes = await ctx.db
    .query("proposalNotes")
    .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
    .take(NOTES_READ);
  return notes.flatMap((note) =>
    note.kind === "reject" || note.kind === "requestChanges"
      ? [{ kind: note.kind, text: note.text, versionNo: note.versionNo, at: note._creationTime }]
      : [],
  );
}

type Decision = Awaited<ReturnType<typeof decisionsOf>>[number];

/**
 * The decision that stands now: a Rejected Proposal's reason, or the
 * changes a Draft was sent back for. Null once the author has resubmitted
 * or rebased past it, and for every other state.
 */
function standingDecision(proposal: Doc<"proposals">, decisions: Decision[]): Decision | null {
  const last = decisions.at(-1);
  if (!last || last.versionNo !== proposal.currentVersionNo) return null;
  if (proposal.state === "rejected" && last.kind === "reject") return last;
  if (proposal.state === "draft" && last.kind === "requestChanges") return last;
  return null;
}

/**
 * What a Proposal holds now: its Draft working copy while it has one, else
 * its submitted version.
 */
async function contentOf(ctx: QueryCtx, proposal: Doc<"proposals">) {
  if (proposal.draft) return proposal.draft;
  const version = await currentVersionOf(ctx, proposal);
  return version
    ? { ops: version.ops, evidence: version.evidence, comment: version.changeComment }
    : { ops: [], evidence: [], comment: "" };
}

/** The viewer's own Proposals, newest first, at most MINE_MAX; null without a viewer. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    // Newest of each state, so the newest MINE_MAX overall are among them.
    const proposals: Doc<"proposals">[] = [];
    for (const state of STATES) {
      const rows = await ctx.db
        .query("proposals")
        .withIndex("by_author", (q) => q.eq("author.userId", user._id).eq("state", state))
        .order("desc")
        .take(MINE_MAX);
      proposals.push(...rows);
    }
    proposals.sort((a, b) => b._creationTime - a._creationTime);

    const rows = [];
    for (const proposal of proposals.slice(0, MINE_MAX)) {
      const content = await contentOf(ctx, proposal);
      const decisions = await decisionsOf(ctx, proposal._id);
      rows.push({
        proposalId: proposal._id,
        state: proposal.state,
        stale: Boolean(proposal.stale),
        comment: content.comment,
        subject: await recordSubjectOf(ctx, content),
        summary: summarizeVersion(content.ops, proposal.author, content.comment, content.evidence),
        decision: standingDecision(proposal, decisions),
        updatedAt: proposal.decidedAt ?? proposal.submittedAt ?? proposal._creationTime,
      });
    }
    return rows;
  },
});

/**
 * One of the viewer's own Proposals: every submitted version with its ops
 * (before and after per record) and evidence, the Draft working copy, the
 * reviewers' decisions, and, while it is a Draft, the record the suggest
 * form revises it on (`target`). Null when it is not the viewer's, so
 * another person's Proposal reads the same as one that does not exist.
 */
export const detail = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const proposal = await ctx.db.get(proposalId);
    if (!proposal || proposal.author.kind !== "user" || proposal.author.userId !== user._id) {
      return null;
    }

    const versions = await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
      .take(VERSIONS_READ);
    const undecided = proposal.state === "draft" || proposal.state === "inReview";
    const renderedVersions = [];
    for (const version of versions) {
      const current = version.versionNo === proposal.currentVersionNo;
      renderedVersions.push({
        versionNo: version.versionNo,
        current,
        changeComment: version.changeComment,
        ops: await renderOps(ctx, version.ops, undecided && current),
        evidence: await renderEvidence(ctx, version.evidence),
        submittedAt: version._creationTime,
      });
    }

    const current = versions.find((version) => version.versionNo === proposal.currentVersionNo);
    const content = await contentOf(ctx, proposal);
    const decisions = await decisionsOf(ctx, proposalId);
    return {
      proposalId: proposal._id,
      state: proposal.state,
      stale:
        proposal.state === "inReview" && current
          ? (await staleRecordsOf(ctx, current.ops)).length > 0
          : Boolean(proposal.stale),
      submittedAt: proposal.submittedAt ?? null,
      decidedAt: proposal.decidedAt ?? null,
      subject: await recordSubjectOf(ctx, content),
      target: proposal.state === "draft" ? await targetOf(ctx, content.ops) : null,
      versions: renderedVersions,
      draft: proposal.draft
        ? {
            ops: await renderOps(ctx, proposal.draft.ops, undecided),
            evidence: await renderEvidence(ctx, proposal.draft.evidence),
            comment: proposal.draft.comment,
          }
        : null,
      decisions,
      decision: standingDecision(proposal, decisions),
      coverArt: await coverArtOf(
        ctx,
        [...versions.flatMap((version) => version.ops), ...(proposal.draft?.ops ?? [])].flatMap(
          (op) => (op.kind === "update" ? op.changes : []),
        ),
      ),
    };
  },
});

/**
 * The record a Draft's first update changes, as the suggest form's route
 * names it, when it can still be edited there; null otherwise.
 */
async function targetOf(ctx: QueryCtx, ops: Doc<"proposalVersions">["ops"]) {
  const update = ops.find((op) => op.kind === "update");
  if (!update) return null;
  const doc = await getCanonical(ctx, update.ref);
  if (!doc || doc.status !== "active") return null;
  return { type: update.ref.type, key: editKeyOf(doc) };
}
