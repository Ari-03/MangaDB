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
// Source-agnostic: every adapter (Seven Seas today; Kodansha, PRH, ANN,
// OpenLibrary later) funnels linked updates through reconcileFields.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getSourceByKey } from "../importSources";
import {
  authorityRank,
  decideField,
  type FieldDecision,
  type Incumbent,
} from "./authority";
import { sameValue, valueHash } from "./values";

/** The record types imports reconcile field-level today. */
export type ReconcileRef =
  | { type: "release"; id: Id<"releases"> }
  | { type: "series"; id: Id<"series"> };

type FieldChange = { field: string; before: unknown; after: unknown };

export type ReconcileResult = {
  /** Did reconciliation write anything a run counter should count? */
  changed: boolean;
  applied: string[];
  queued: string[];
  recorded: string[];
  suppressed: string[];
};

async function revisionsOf(
  ctx: MutationCtx,
  ref: ReconcileRef,
): Promise<Doc<"revisions">[]> {
  return await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) =>
      q.eq("ref.type", ref.type).eq("ref.id", ref.id as never),
    )
    .order("desc")
    .collect();
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
  return op.changes.every(
    (c) => want.has(c.field) && sameValue(c.after, want.get(c.field)),
  );
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
    recorded: [],
    suppressed: [],
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

  // Bucket every offered field by its authority decision.
  const auto: Array<FieldChange & { decision: FieldDecision }> = [];
  const queue: Array<FieldChange & { decision: FieldDecision }> = [];
  const recordOnly: Array<{ field: string; offered: unknown; reason: string }> = [];
  for (const [field, offeredValue] of Object.entries(args.offered)) {
    const current = (doc as Record<string, unknown>)[field];
    const latestTouch = history.find((rev) =>
      rev.changes.some((change) => change.field === field),
    );
    let incumbent: Incumbent;
    if (!latestTouch) {
      incumbent = current === undefined ? { kind: "none" } : { kind: "unattributed" };
    } else if (latestTouch.author.kind === "user") {
      incumbent = { kind: "human" };
    } else {
      const key = latestTouch.author.sourceKey;
      incumbent = {
        kind: "source",
        sourceKey: key,
        rank: authorityRank((await registryRow(key))?.fieldAuthority, field),
      };
    }
    const decision = decideField({
      field,
      current,
      offered: offeredValue,
      overridden: overridden.has(field),
      incomingSourceKey: args.sourceKey,
      incomingRank: authorityRank(incoming?.fieldAuthority, field),
      incumbent,
    });
    const change = { field, before: current, after: offeredValue, decision };
    if (decision.action === "auto") auto.push(change);
    else if (decision.action === "queue") queue.push(change);
    else if (decision.action === "recordOnly") {
      recordOnly.push({ field, offered: offeredValue, reason: decision.reason });
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
    const comment = `Imported from ${args.citation.sourceName}.`;
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "source", sourceKey: args.sourceKey },
      state: "approved",
      currentVersionNo: 1,
      submittedAt: now,
      decidedAt: now,
    });
    await ctx.db.insert("proposalVersions", {
      proposalId,
      versionNo: 1,
      ops: [
        {
          kind: "update" as const,
          ref: ref as never,
          baseRevisionId: latestRevisionId ?? undefined,
          changes,
        },
      ],
      evidence: [{ kind: "observation" as const, observationId: observation._id }],
      changeComment: comment,
    });

    const patch: Record<string, unknown> = {};
    for (const change of changes) patch[change.field] = change.after;
    // Derived field maintained by every write path (spec §8).
    if (ref.type === "series" && "title" in patch) {
      const series = doc as Doc<"series">;
      patch.searchText = [patch.title as string, ...series.altTitles].join(" ");
    }
    await ctx.db.patch(ref.id as Id<"releases">, patch as never);

    latestRevisionId = await ctx.db.insert("revisions", {
      ref: ref as never,
      seq: nextSeq,
      proposalId,
      author: { kind: "source", sourceKey: args.sourceKey },
      changes,
      comment,
      citation: args.citation,
    });
    nextSeq++;
    result.applied = changes.map((c) => c.field);
    result.changed = true;
  }

  // ----- queue bucket: one open In-Review conflict Proposal -----
  const unsuppressed: typeof queue = [];
  for (const change of queue) {
    if (await isSuppressed(ctx, ref, change.field, args.sourceKey, change.after)) {
      result.suppressed.push(change.field);
    } else {
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
      const reasons = unsuppressed
        .map((c) => `${c.field} (${c.decision.reason})`)
        .join("; ");
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: args.sourceKey },
        state: "inReview",
        currentVersionNo: 1,
        submittedAt: now,
      });
      await ctx.db.insert("proposalVersions", {
        proposalId,
        versionNo: 1,
        ops: [
          {
            kind: "update" as const,
            ref: ref as never,
            baseRevisionId: latestRevisionId ?? undefined,
            changes,
          },
        ],
        evidence: [
          { kind: "observation" as const, observationId: observation._id },
        ],
        changeComment: `Import conflict from ${args.citation.sourceName}: ${reasons}. The importer never overwrites — approve to accept the source's value, reject to suppress this exact offer.`,
      });
      await ctx.db.patch(observation._id, { queuedProposalId: proposalId });
      result.queued = changes.map((c) => c.field);
      result.changed = true;
    }
  }

  // ----- recordOnly bucket: on the observation, nothing canonical -----
  if (recordOnly.length > 0) {
    const replaced = new Set(recordOnly.map((c) => c.field));
    const kept = (observation.conflicts ?? []).filter(
      (c) => !replaced.has(c.field),
    );
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
    result.recorded = recordOnly.map((c) => c.field);
  }

  return result;
}
