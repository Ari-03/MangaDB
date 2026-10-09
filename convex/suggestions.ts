// The viewer's own Suggestions, for the Suggestions tab of /me and its
// detail page (CONTEXT.md: a Suggestion is a reader's Proposal). Writing
// goes through proposals.ts (saveDraft, submitProposal, withdrawProposal,
// rebaseProposal), which any signed-in author may call on their own
// Proposal. These queries read only Proposals the viewer wrote while
// holding no data-team role (Suggestions, and reports filed as a reader;
// what they wrote on the Data Team stays on /mod/proposals), and only the
// author's side of review: the ops with before and after, evidence, the
// change comment, the decision time, and what a reviewer said to the
// author (why it was rejected, or what to change). Never the Data Team's
// internal discussion, who claimed or decided it, or anyone else's
// Proposal: the review queue and its pending work stay the Data Team's.
// A record the public catalog no longer shows (hidden, merged, or under a
// hidden parent: lib/publicRecords.ts publiclyVisible) is named NOT_PUBLIC, and
// only what the author wrote of it is shown; so is a cited observation of
// such a record, and cover art only such records hold is not drawn.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { viewerOrNull } from "./lib/auth";
import { summarizeVersion } from "./lib/queueSummary";
import { editKeyOf, getCanonical } from "./moderation";
import { publiclyVisible } from "./lib/publicRecords";
import { coverBlobsOf, ownUpload, publicArt } from "./lib/coverRefs";
import { coverUrl } from "./lib/covers";
import {
  currentVersionOf,
  observationFacts,
  recordFacts,
  recordSubjectOf,
  renderEvidence,
  renderOps,
  staleRecordsOf,
} from "./proposals";

/** The most rows the Suggestions list shows, newest first. */
export const MINE_MAX = 50;

/** The most decisions one Proposal's page shows, the newest. */
const NOTES_READ = 100;

/** The most versions one Proposal's page shows, the newest. */
const VERSIONS_READ = 50;

const STATES = ["draft", "inReview", "approved", "rejected", "withdrawn"] as const;

const DECISION_KINDS = ["reject", "requestChanges"] as const;

/**
 * Whether `user` wrote `proposal` as a reader: a person holding no
 * data-team role then, the queue's `suggestion` kind (lib/queueSummary.ts).
 */
function readerAuthored(proposal: Doc<"proposals">, user: Doc<"users">) {
  return (
    proposal.author.kind === "user" &&
    proposal.author.userId === user._id &&
    proposal.author.roleAtAuthorship === undefined
  );
}

/**
 * What reviewers told the author, the newest `limit`, oldest first: each
 * rejection's reason and each request for changes, read by kind so the
 * internal discussion (`comment` notes) is never read at all.
 */
async function decisionsOf(ctx: QueryCtx, proposalId: Id<"proposals">, limit = NOTES_READ) {
  const decisions = [];
  for (const kind of DECISION_KINDS) {
    const notes = await ctx.db
      .query("proposalNotes")
      .withIndex("by_proposal_and_kind", (q) => q.eq("proposalId", proposalId).eq("kind", kind))
      .order("desc")
      .take(limit);
    for (const note of notes) {
      decisions.push({ kind, text: note.text, versionNo: note.versionNo, at: note._creationTime });
    }
  }
  return decisions.sort((a, b) => a.at - b.at).slice(-limit);
}

type Decision = Awaited<ReturnType<typeof decisionsOf>>[number];

/**
 * The decision that stands now, from `decisions` ending on the newest: a
 * Rejected Proposal's reason, or the changes a Draft was sent back for.
 * Null once the author has resubmitted or rebased past it, and for every
 * other state.
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

/**
 * Whether an open Proposal's working ops (`contentOf`) can no longer be
 * applied as written: a record they change has moved on or left ordinary
 * editing (proposals.ts staleRecordsOf), as each rendered op reports. The
 * author rebases it then; a decided one is never stale.
 */
async function openStale(
  ctx: QueryCtx,
  proposal: Doc<"proposals">,
  ops: Doc<"proposalVersions">["ops"],
) {
  if (proposal.state !== "draft" && proposal.state !== "inReview") return false;
  return (await staleRecordsOf(ctx, ops)).length > 0;
}

/**
 * Whether the record a Proposal's first update changes is one the public
 * catalog no longer shows, so its before-values are not shown either.
 */
async function firstRecordWithheld(ctx: QueryCtx, ops: Doc<"proposalVersions">["ops"]) {
  const update = ops.find((op) => op.kind === "update");
  if (!update) return false;
  const doc = await getCanonical(ctx, update.ref);
  return !doc || !(await publiclyVisible(ctx, update.ref.type, doc));
}

/**
 * The viewer's own Suggestions, newest first, at most MINE_MAX; null
 * without a viewer. Read from each state's newest MINE_MAX of the viewer's
 * Proposals, so a long run of newer ones written on the Data Team can
 * crowd older Suggestions out.
 */
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
      proposals.push(...rows.filter((proposal) => readerAuthored(proposal, user)));
    }
    proposals.sort((a, b) => b._creationTime - a._creationTime);

    const rows = [];
    for (const proposal of proposals.slice(0, MINE_MAX)) {
      const content = await contentOf(ctx, proposal);
      const summary = summarizeVersion(
        content.ops,
        proposal.author,
        content.comment,
        content.evidence,
      );
      // The summary's fields are the first update's, of the subject's record.
      const withheld = await firstRecordWithheld(ctx, content.ops);
      rows.push({
        proposalId: proposal._id,
        state: proposal.state,
        stale: await openStale(ctx, proposal, content.ops),
        comment: content.comment,
        subject: await recordSubjectOf(ctx, content, true),
        withheld,
        summary: withheld
          ? { ...summary, fields: summary.fields.map((field) => ({ ...field, before: undefined })) }
          : summary,
        decision: standingDecision(proposal, await decisionsOf(ctx, proposal._id, 1)),
        updatedAt: proposal.decidedAt ?? proposal.submittedAt ?? proposal._creationTime,
      });
    }
    return rows;
  },
});

/**
 * One of the viewer's own Suggestions: its newest VERSIONS_READ submitted
 * versions with their ops (before and after per record) and evidence, the
 * Draft working copy, the reviewers' newest decisions, and, while it is a
 * Draft the suggest form can show whole, the record it revises it on
 * (`target`). Null when it is not one of the viewer's Suggestions, so
 * another person's Proposal, or one the viewer wrote on the Data Team,
 * reads the same as one that does not exist, and for an id that names no
 * Proposal (the id comes from a page's address).
 */
export const detail = query({
  args: { proposalId: v.string() },
  handler: async (ctx, args) => {
    const user = await viewerOrNull(ctx);
    const proposalId = ctx.db.normalizeId("proposals", args.proposalId);
    if (!user || !proposalId) return null;
    const proposal = await ctx.db.get(proposalId);
    if (!proposal || !readerAuthored(proposal, user)) return null;

    const versions = (
      await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .order("desc")
        .take(VERSIONS_READ)
    ).reverse();
    const undecided = proposal.state === "draft" || proposal.state === "inReview";
    // One read of each record and source however many versions name it.
    const facts = recordFacts(ctx, true);
    const sources = observationFacts(ctx, true);
    const renderedVersions = [];
    for (const version of versions) {
      const current = version.versionNo === proposal.currentVersionNo;
      renderedVersions.push({
        versionNo: version.versionNo,
        current,
        changeComment: version.changeComment,
        ops: await renderOps(ctx, version.ops, undecided && current, facts),
        evidence: await renderEvidence(ctx, version.evidence, sources),
        submittedAt: version._creationTime,
      });
    }
    const draft = proposal.draft
      ? {
          ops: await renderOps(ctx, proposal.draft.ops, undecided, facts),
          evidence: await renderEvidence(ctx, proposal.draft.evidence, sources),
          comment: proposal.draft.comment,
        }
      : null;

    const content = await contentOf(ctx, proposal);
    const decisions = await decisionsOf(ctx, proposalId);
    return {
      proposalId: proposal._id,
      state: proposal.state,
      stale: await openStale(ctx, proposal, content.ops),
      submittedAt: proposal.submittedAt ?? null,
      decidedAt: proposal.decidedAt ?? null,
      subject: await recordSubjectOf(ctx, content, true),
      target: proposal.state === "draft" ? await targetOf(ctx, content.ops) : null,
      versions: renderedVersions,
      draft,
      decisions,
      decision: standingDecision(proposal, decisions),
      // From the rendered changes, which keep no before-value of a record
      // no longer public, and only art the reader may see.
      coverArt: await readerArt(
        ctx,
        user._id,
        [...renderedVersions.flatMap((version) => version.ops), ...(draft?.ops ?? [])].flatMap(
          (op) => (op.kind === "update" ? op.changes : []),
        ),
      ),
    };
  },
});

/**
 * The art behind the covers `changes` name, as moderation.ts coverArtOf
 * draws it, with `url` null unless the reader uploaded it or a record the
 * public catalog shows holds it (lib/coverRefs.ts publicArt): art only a
 * hidden record holds is not shown, though the change still names it.
 */
async function readerArt(
  ctx: QueryCtx,
  userId: Id<"users">,
  changes: ReadonlyArray<{ field: string; before?: unknown; after?: unknown }>,
) {
  const art = [];
  for (const storageId of coverBlobsOf(changes)) {
    const open = (await ownUpload(ctx, storageId, userId)) || (await publicArt(ctx, storageId));
    art.push({ storageId, url: open ? await coverUrl(ctx, storageId) : null });
  }
  return art;
}

/**
 * The record a Draft revises, as the suggest form's route names it, when
 * the form can show the whole Draft there: one update of one record the
 * public catalog shows. Null otherwise; the Draft can still be submitted
 * or withdrawn from its page.
 */
async function targetOf(ctx: QueryCtx, ops: Doc<"proposalVersions">["ops"]) {
  const [update, ...rest] = ops;
  if (update?.kind !== "update" || rest.length > 0) return null;
  const doc = await getCanonical(ctx, update.ref);
  if (!doc || !(await publiclyVisible(ctx, update.ref.type, doc))) return null;
  return { type: update.ref.type, key: editKeyOf(doc) };
}
