// Authority-gated field reconciliation (ticket #35, spec §6): what happens
// after the matching ladder links an observation to a canonical record and
// the source's offered values disagree with the canonical ones. Pure
// decisions live in lib/authority.ts; this module resolves each field's
// incumbent (the latest Revision that touched it) against the live
// registry and applies the outcome:
//
// - auto     → one immediately approved system Proposal + patch + a public
//              importer-authored Revision citing the source
// - queue    → one In-Review conflict Proposal per observation, pre-filled
//              with the offered values; suppressed offers (rejected before,
//              same value) never re-queue; a stale or outdated open
//              conflict Proposal is withdrawn and replaced
// - recordOnly → the disagreement is recorded on the observation only
//
// With nothing left to queue, the observation's open field correction for
// this record is retired, and so is a possible-cancellation review whose
// withdrawal no longer applies (the source lists the record again).
//
// Source-agnostic: every adapter (Seven Seas today; Kodansha, PRH, ANN,
// OpenLibrary later) funnels linked updates through reconcileFields.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getSourceByKey } from "../importSources";
import { retireLapsedCancellation } from "./observations";
import {
  authorityRank,
  decideField,
  latestTouch,
  type FieldDecision,
  type Incumbent,
} from "./authority";
import { seriesSearchText } from "./searchMatch";
import { sameValue, valueHash } from "./values";

/** The record types imports reconcile field-level today. */
export type ReconcileRef =
  { type: "release"; id: Id<"releases"> } | { type: "series"; id: Id<"series"> };

type FieldChange = { field: string; before: unknown; after: unknown };

export type ReconcileResult = {
  /** Did reconciliation write anything a run counter should count? */
  changed: boolean;
  applied: string[];
  queued: string[];
};

// The same query as moderation.ts revisionsOf. Importing that one would pull
// the moderation module graph into every importer, and its cycle back
// through people.ts → lib/prh.ts reads catalogTitleFields before
// lib/catalogTitle.ts has initialized.
async function revisionsOf(ctx: MutationCtx, ref: ReconcileRef): Promise<Doc<"revisions">[]> {
  return await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id as never))
    .order("desc")
    .collect();
}

/** A source-authored Proposal: in review, or approved with its Revisions. */
export type SourceProposal = {
  sourceKey: string;
  ops: Doc<"proposalVersions">["ops"];
  /** The observations it cites (deduplicated). */
  evidence: Id<"sourceObservations">[];
  comment: string;
  now: number;
} & (
  | { state: "inReview" }
  | {
      state: "approved";
      citation: { sourceName: string; url: string };
      /** One public Revision per changed record, in insertion order. */
      revisions: Array<Pick<Doc<"revisions">, "ref" | "seq" | "changes">>;
    }
);

/**
 * Insert a source-authored Proposal with its single version, and for an
 * approved one the Revisions citing the source. Every importer write to
 * the moderation history goes through here; callers do their own patches.
 * Returns the Proposal and the inserted Revisions' ids.
 */
export async function insertSourceProposal(
  ctx: MutationCtx,
  args: SourceProposal,
): Promise<{ proposalId: Id<"proposals">; revisionIds: Id<"revisions">[] }> {
  const author = { kind: "source" as const, sourceKey: args.sourceKey };
  const proposalId = await ctx.db.insert("proposals", {
    author,
    state: args.state,
    currentVersionNo: 1,
    submittedAt: args.now,
    ...(args.state === "approved" ? { decidedAt: args.now } : {}),
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: args.ops,
    evidence: [...new Set(args.evidence)].map((observationId) => ({
      kind: "observation" as const,
      observationId,
    })),
    changeComment: args.comment,
  });
  const revisionIds: Id<"revisions">[] = [];
  if (args.state === "approved") {
    for (const revision of args.revisions) {
      revisionIds.push(
        await ctx.db.insert("revisions", {
          ...revision,
          proposalId,
          author,
          comment: args.comment,
          citation: args.citation,
        }),
      );
    }
  }
  return { proposalId, revisionIds };
}

/** Is this exact offer suppressed — rejected before, value unchanged? */
async function isSuppressed(
  ctx: MutationCtx,
  ref: ReconcileRef,
  field: string,
  sourceKey: string,
  offered: unknown,
): Promise<boolean> {
  const row = await ctx.db
    .query("conflictSuppressions")
    .withIndex("by_key", (q) =>
      q
        .eq("ref.type", ref.type)
        .eq("ref.id", ref.id as never)
        .eq("field", field)
        .eq("sourceKey", sourceKey)
        .eq("valueHash", valueHash(offered)),
    )
    .first();
  return row !== null;
}

/** Does the open In-Review proposal already carry exactly this conflict? */
async function openProposalMatches(
  ctx: MutationCtx,
  proposal: Doc<"proposals">,
  ref: ReconcileRef,
  changes: FieldChange[],
  latestRevisionId: Id<"revisions"> | null,
): Promise<boolean> {
  const version = await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) =>
      q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
    )
    .unique();
  if (!version || version.ops.length !== 1) return false;
  const op = version.ops[0]!;
  if (op.kind !== "update") return false;
  const opRef = op.ref as { type: string; id: string };
  if (opRef.type !== ref.type || opRef.id !== (ref.id as string)) return false;
  // A moved base means the reviewed diff is stale — replace it.
  if ((op.baseRevisionId ?? null) !== latestRevisionId) return false;
  if (op.changes.length !== changes.length) return false;
  const want = new Map(changes.map((c) => [c.field, c.after]));
  return op.changes.every((c) => want.has(c.field) && sameValue(c.after, want.get(c.field)));
}

/**
 * Reconcile a source's offered field values into one linked canonical
 * record, per the spec §6 conflict table. One call = one record; the
 * caller's mutation makes the whole thing atomic.
 */
export async function reconcileFields(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    ref: ReconcileRef;
    doc: Doc<"releases"> | Doc<"series">;
    /** Canonical field name → the source's offered value. */
    offered: Record<string, unknown>;
    observation: Doc<"sourceObservations">;
    citation: { sourceName: string; url: string };
    now: number;
  },
): Promise<ReconcileResult> {
  const { ref, doc, observation, now } = args;
  const result: ReconcileResult = {
    changed: false,
    applied: [],
    queued: [],
  };

  const registryCache = new Map<string, Doc<"approvedSources"> | null>();
  const registryRow = async (key: string) => {
    if (!registryCache.has(key)) {
      registryCache.set(key, await getSourceByKey(ctx, key));
    }
    return registryCache.get(key) ?? null;
  };
  const incoming = await registryRow(args.sourceKey);

  const history = await revisionsOf(ctx, ref);
  const overridden = new Set(doc.overriddenFields ?? []);

  // The observations a Revision's value came from: its Proposal's evidence.
  const evidenceCache = new Map<string, string[]>();
  const evidenceOf = async (revision: Doc<"revisions">): Promise<string[]> => {
    if (!revision.proposalId) return [];
    const cached = evidenceCache.get(revision.proposalId);
    if (cached) return cached;
    const proposal = await ctx.db.get(revision.proposalId);
    const version = proposal
      ? await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) =>
            q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
          )
          .unique()
      : null;
    const ids = (version?.evidence ?? []).flatMap((row) =>
      row.kind === "observation" ? [row.observationId as string] : [],
    );
    evidenceCache.set(revision.proposalId, ids);
    return ids;
  };

  // Bucket every offered field by its authority decision.
  const auto: Array<FieldChange & { decision: FieldDecision }> = [];
  const queue: Array<FieldChange & { decision: FieldDecision }> = [];
  const recordOnly: Array<{ field: string; offered: unknown; reason: string }> = [];
  for (const [field, offeredValue] of Object.entries(args.offered)) {
    const current = (doc as Record<string, unknown>)[field];
    const touch = latestTouch(history, field);
    let incumbent: Incumbent;
    if (!touch) {
      incumbent = current === undefined ? { kind: "none" } : { kind: "unattributed" };
    } else if (touch.author.kind === "user") {
      incumbent = { kind: "human" };
    } else {
      const key = touch.author.sourceKey;
      incumbent = {
        kind: "source",
        sourceKey: key,
        rank: authorityRank((await registryRow(key))?.fieldAuthority, field),
        observationIds: await evidenceOf(touch),
      };
    }
    const decision = decideField({
      field,
      current,
      offered: offeredValue,
      overridden: overridden.has(field),
      incomingSourceKey: args.sourceKey,
      incomingObservationId: observation._id,
      incomingRank: authorityRank(incoming?.fieldAuthority, field),
      incumbent,
    });
    const change = { field, before: current, after: offeredValue, decision };
    if (decision.action === "auto") auto.push(change);
    else if (decision.action === "queue") queue.push(change);
    else if (decision.action === "recordOnly") {
      recordOnly.push({
        field,
        offered: offeredValue,
        reason: decision.reason,
      });
    }
  }

  let latestRevisionId: Id<"revisions"> | null = history[0]?._id ?? null;
  let nextSeq = (history[0]?.seq ?? 0) + 1;

  // ----- auto bucket: one immediately approved system Proposal -----
  if (auto.length > 0) {
    const changes = auto.map(({ field, before, after }) => ({
      field,
      before,
      after,
    }));
    const { revisionIds } = await insertSourceProposal(ctx, {
      sourceKey: args.sourceKey,
      state: "approved",
      ops: [{ kind: "update", ref, baseRevisionId: latestRevisionId ?? undefined, changes }],
      evidence: [observation._id],
      comment: `Imported from ${args.citation.sourceName}.`,
      now,
      citation: args.citation,
      revisions: [{ ref, seq: nextSeq, changes }],
    });
    latestRevisionId = revisionIds[0]!;
    nextSeq++;

    const patch: Record<string, unknown> = {};
    for (const change of changes) patch[change.field] = change.after;
    // Derived field maintained by every write path (spec §8).
    if (ref.type === "series" && "title" in patch) {
      const series = doc as Doc<"series">;
      patch.searchText = seriesSearchText(patch.title as string, series.altTitles);
    }
    await ctx.db.patch(ref.id as Id<"releases">, patch as never);
    result.applied = changes.map((c) => c.field);
    result.changed = true;
  }

  // ----- queue bucket: one open In-Review conflict Proposal -----
  const unsuppressed: typeof queue = [];
  for (const change of queue) {
    if (!(await isSuppressed(ctx, ref, change.field, args.sourceKey, change.after))) {
      unsuppressed.push(change);
    }
  }
  if (unsuppressed.length > 0) {
    const changes = unsuppressed.map(({ field, before, after }) => ({
      field,
      before,
      after,
    }));
    const open = observation.queuedProposalId
      ? await ctx.db.get(observation.queuedProposalId)
      : null;
    if (
      open?.state === "inReview" &&
      (await openProposalMatches(ctx, open, ref, changes, latestRevisionId))
    ) {
      // The identical conflict already awaits review — nothing to add.
      result.queued = changes.map((c) => c.field);
    } else {
      // An outdated or stale open conflict from this observation is the
      // importer's own — withdraw and replace it with the current diff.
      if (open?.state === "inReview") {
        await ctx.db.patch(open._id, { state: "withdrawn", decidedAt: now });
      }
      const reasons = unsuppressed.map((c) => `${c.field} (${c.decision.reason})`).join("; ");
      const { proposalId } = await insertSourceProposal(ctx, {
        sourceKey: args.sourceKey,
        state: "inReview",
        ops: [{ kind: "update", ref, baseRevisionId: latestRevisionId ?? undefined, changes }],
        evidence: [observation._id],
        comment: `Import conflict from ${args.citation.sourceName}: ${reasons}. The importer never overwrites — approve to accept the source's value, reject to suppress this exact offer.`,
        now,
      });
      await ctx.db.patch(observation._id, { queuedProposalId: proposalId });
      result.queued = changes.map((c) => c.field);
      result.changed = true;
    }
  } else if (observation.queuedProposalId) {
    const open = await ctx.db.get(observation.queuedProposalId);
    if (
      open?.state === "inReview" &&
      open.author.kind === "source" &&
      open.author.sourceKey === args.sourceKey
    ) {
      const version = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) =>
          q.eq("proposalId", open._id).eq("versionNo", open.currentVersionNo),
        )
        .unique();
      const op = version?.ops.length === 1 ? version.ops[0] : undefined;
      // Only retire this record's field correction, or a cancellation review
      // the relisted observation no longer supports. Creation proposals may
      // share the observation and have their own review rules.
      if (op?.kind === "update" && op.ref.type === ref.type && op.ref.id === ref.id) {
        await ctx.db.patch(open._id, { state: "withdrawn", decidedAt: now });
        result.changed = true;
      } else if (await retireLapsedCancellation(ctx, observation, now)) {
        result.changed = true;
      }
    }
  }

  // ----- recordOnly bucket: on the observation, nothing canonical -----
  if (recordOnly.length > 0) {
    const replaced = new Set(recordOnly.map((c) => c.field));
    const kept = (observation.conflicts ?? []).filter((c) => !replaced.has(c.field));
    await ctx.db.patch(observation._id, {
      conflicts: [
        ...kept,
        ...recordOnly.map((c) => ({
          field: c.field,
          offered: c.offered,
          at: now,
          reason: c.reason,
        })),
      ],
    });
  }

  return result;
}
