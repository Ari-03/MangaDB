// Editor Proposals and the review queue (ticket #32, spec §5). The full
// Proposal lifecycle: an Editor drafts a change (mutable working copy),
// submits it (validation, required change comment, source evidence for
// factual changes, warning acknowledgment) and it lands In Review in the
// shared queue as an immutable Proposal Version. A Moderator reviews the
// exact version and approves (creating the public Revisions via the same
// write path as direct edits), rejects, or requests changes (back to Draft;
// resubmission is a new immutable version). If any affected record's base
// Revision changes first the Proposal goes stale and must be explicitly
// rebased — never silently. Temp-IDs let one Proposal atomically create a
// Volume + Edition + coverage (lib/proposalCreates.ts). Per-user rate
// limits and bulk caps ride the Convex rate-limiter component.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  applyUpdate,
  displayInfo,
  getCanonical,
  revisionsOf,
  validateChanges,
  type FieldChange,
  type RecordRef,
} from "./moderation";
import { evidence, recordRef } from "./schema";
import {
  applyCreatePlan,
  planCreateOps,
  CREATABLE_TABLES,
  type CreateOpInput,
} from "./lib/proposalCreates";
import { fieldDescriptor } from "./lib/moderationFields";
import { requireDataTeam, requireModerator } from "./lib/roles";
import { sameValue, valueHash } from "./lib/values";

// ---------- abuse controls (spec §5: rate limits + bulk caps) ----------

/** Bulk-operation cap: one coherent intent, not a mass migration. */
export const MAX_OPS_PER_PROPOSAL = 25;

// Token buckets per user (Convex rate-limiter component): steady editing
// never hits these; scripted abuse does.
export const RATE_LIMITS = {
  proposalSubmit: { kind: "token bucket", rate: 30, period: HOUR, capacity: 5 },
  proposalDraftSave: {
    kind: "token bucket",
    rate: 120,
    period: HOUR,
    capacity: 20,
  },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, RATE_LIMITS);

// ---------- shared shapes ----------

type StoredOp = Doc<"proposalVersions">["ops"][number];
type Evidence = Doc<"proposalVersions">["evidence"][number];
type Draft = NonNullable<Doc<"proposals">["draft"]>;

// What clients submit when drafting: creates carry raw fields (validated by
// the creation registry); updates carry field/value pairs — the server
// computes before/after and captures the base Revision.
const opInput = v.union(
  v.object({
    kind: v.literal("create"),
    table: v.string(),
    tempId: v.string(),
    fields: v.any(),
  }),
  v.object({
    kind: v.literal("update"),
    ref: recordRef,
    changes: v.array(v.object({ field: v.string(), value: v.any() })),
  }),
);

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

function requireAuthor(proposal: Doc<"proposals">, user: Doc<"users">) {
  if (proposal.author.kind !== "user" || proposal.author.userId !== user._id) {
    fail("forbidden", "Only the proposal's author may do this.");
  }
}

// ---------- draft building ----------

type OpInput =
  | CreateOpInput
  | {
      kind: "update";
      ref: RecordRef;
      changes: Array<{ field: string; value: unknown }>;
    };

/**
 * Validate submitted draft ops against the current database and return the
 * stored form: update ops get normalized before/after changes and the
 * record's current base Revision (the staleness anchor); create ops keep
 * their validated raw fields so temp-ID references survive verbatim.
 */
async function buildDraftOps(
  ctx: MutationCtx,
  submitted: OpInput[],
): Promise<StoredOp[]> {
  if (submitted.length === 0) {
    fail("noOps", "A proposal needs at least one operation.");
  }
  if (submitted.length > MAX_OPS_PER_PROPOSAL) {
    fail(
      "bulkCap",
      `One proposal carries at most ${MAX_OPS_PER_PROPOSAL} operations — split unrelated work.`,
    );
  }
  await planCreateOps(
    ctx,
    submitted.filter((op): op is CreateOpInput => op.kind === "create"),
  );

  const ops: StoredOp[] = [];
  const updatedRecords = new Set<string>();
  for (const op of submitted) {
    if (op.kind === "create") {
      ops.push({
        kind: "create",
        table: op.table,
        tempId: op.tempId,
        fields: op.fields,
      });
      continue;
    }
    const ref = op.ref;
    if (updatedRecords.has(ref.id as string)) {
      fail("duplicateRecord", "One proposal may update each record only once.");
    }
    updatedRecords.add(ref.id as string);
    const doc = await getCanonical(ctx, ref);
    if (!doc) fail("notFound", "A record this proposal updates does not exist.");
    if (doc!.status !== "active" || doc!.locked) {
      fail(
        "locked",
        `A record this proposal updates is ${doc!.locked ? "locked" : doc!.status}.`,
      );
    }
    const changes = validateChanges(ref.type, doc!, op.changes);
    const latest = (await revisionsOf(ctx, ref))[0];
    ops.push({
      kind: "update",
      ref: ref as never,
      baseRevisionId: latest?._id,
      changes,
    });
  }
  return ops;
}

/** Malformed evidence never reaches a version: check each row now. */
async function checkEvidence(ctx: MutationCtx, rows: Evidence[]): Promise<void> {
  for (const row of rows) {
    if (row.kind === "url") {
      if (!/^https?:\/\/\S+$/.test(row.url)) {
        fail("invalidEvidence", "Evidence URLs must be http(s) links.");
      }
    } else if (row.kind === "note") {
      if (row.text.trim() === "") {
        fail("invalidEvidence", "Evidence notes cannot be empty.");
      }
    } else if (!(await ctx.db.get(row.observationId))) {
      fail("invalidEvidence", "Evidence references a missing observation.");
    }
  }
}

// ---------- warnings (surfaced at submit, acknowledged explicitly) ----------

export const PROPOSAL_WARNINGS = {
  newSeries: "Creates a brand-new Series",
  bulk: "Bulk change: more than 10 operations",
  partialCoverage: "Declares partial Volume Coverage",
} as const;

export type ProposalWarning = keyof typeof PROPOSAL_WARNINGS;

function computeWarnings(ops: StoredOp[]): ProposalWarning[] {
  const warnings = new Set<ProposalWarning>();
  if (ops.length > 10) warnings.add("bulk");
  for (const op of ops) {
    if (op.kind !== "create") continue;
    if (op.table === "series") warnings.add("newSeries");
    const coverage = (op.fields as { volumeCoverage?: unknown })?.volumeCoverage;
    if (
      Array.isArray(coverage) &&
      coverage.some((row) => (row as { extent?: string })?.extent === "partial")
    ) {
      warnings.add("partialCoverage");
    }
  }
  return [...warnings];
}

/** Does any op assert a checkable fact (vs editorial prose)? */
function needsSourceEvidence(ops: StoredOp[]): boolean {
  for (const op of ops) {
    if (op.kind === "create") return true;
    if (op.kind !== "update") continue;
    const type = (op.ref as RecordRef).type;
    for (const change of op.changes) {
      if (!fieldDescriptor(type, change.field)?.editorial) return true;
    }
  }
  return false;
}

// ---------- staleness ----------

type StaleRecord = { type: string; id: string; reason: "baseChanged" | "unavailable" };

/**
 * Which records an op set can no longer be applied to as reviewed: the base
 * Revision moved (someone else's change landed first) or the record itself
 * left ordinary editing (hidden, merged, locked, deleted). Spec §5: any base
 * change before approval makes the version stale — explicit rebase and
 * resubmit, never a silent rebase.
 */
async function staleRecordsOf(
  ctx: QueryCtx | MutationCtx,
  ops: StoredOp[],
): Promise<StaleRecord[]> {
  const stale: StaleRecord[] = [];
  for (const op of ops) {
    if (op.kind !== "update") continue;
    const ref = op.ref as RecordRef;
    const doc = await getCanonical(ctx, ref);
    if (!doc || doc.status !== "active" || doc.locked) {
      stale.push({ type: ref.type, id: ref.id as string, reason: "unavailable" });
      continue;
    }
    const latest = (await revisionsOf(ctx, ref))[0];
    if ((latest?._id ?? null) !== (op.baseRevisionId ?? null)) {
      stale.push({ type: ref.type, id: ref.id as string, reason: "baseChanged" });
    }
  }
  return stale;
}

// ---------- the Editor lifecycle: draft → submit → withdraw/rebase ----------

/**
 * Create or update a Draft proposal — the mutable working copy. Validation
 * runs now so problems surface while drafting, and again at submission and
 * approval. Any data-team member may author proposals.
 */
export const saveDraft = mutation({
  args: {
    proposalId: v.optional(v.id("proposals")),
    ops: v.array(opInput),
    evidence: v.array(evidence),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    await rateLimiter.limit(ctx, "proposalDraftSave", {
      key: user._id,
      throws: true,
    });
    const ops = await buildDraftOps(ctx, args.ops as OpInput[]);
    await checkEvidence(ctx, args.evidence);
    const draft: Draft = {
      ops,
      evidence: args.evidence,
      comment: args.comment.trim(),
    };

    if (args.proposalId) {
      const proposal = await ctx.db.get(args.proposalId);
      if (!proposal) fail("notFound", "No such proposal.");
      requireAuthor(proposal!, user);
      if (proposal!.state !== "draft") {
        fail("badState", "Only Draft proposals can be edited.");
      }
      await ctx.db.patch(args.proposalId, { draft });
      return { proposalId: args.proposalId };
    }
    const proposalId = await ctx.db.insert("proposals", {
      author: {
        kind: "user",
        userId: user._id,
        roleAtAuthorship: user.role,
      },
      state: "draft",
      currentVersionNo: 0,
      draft,
    });
    return { proposalId };
  },
});

/**
 * Submit a Draft for review: full validation, required change comment,
 * source evidence for factual changes, explicit warning acknowledgment, the
 * per-user submission rate limit — then the draft freezes into an immutable
 * Proposal Version and the proposal lands In Review. Resubmission after
 * Request Changes runs through here again and mints the next version.
 */
export const submitProposal = mutation({
  args: {
    proposalId: v.id("proposals"),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal!, user);
    if (proposal!.state !== "draft") {
      fail("badState", "Only Draft proposals can be submitted.");
    }
    const draft = proposal!.draft;
    if (!draft || draft.ops.length === 0) {
      fail("noOps", "This draft has no operations to submit.");
    }
    if (draft!.comment === "") {
      fail("commentRequired", "Every submission needs a change comment.");
    }

    // Submission runs validation (spec §5): bases must still be current,
    // references must still resolve, values must still be legal.
    const stale = await staleRecordsOf(ctx, draft!.ops);
    if (stale.length > 0) {
      throw new ConvexError({
        code: "stale",
        message:
          "Records changed since this draft was saved — rebase the draft, review it, and submit again.",
        stale,
      });
    }
    await planCreateOps(
      ctx,
      draft!.ops.filter((op): op is CreateOpInput => op.kind === "create"),
    );
    for (const op of draft!.ops) {
      if (op.kind !== "update") continue;
      const ref = op.ref as RecordRef;
      const doc = await getCanonical(ctx, ref);
      validateChanges(
        ref.type,
        doc!,
        op.changes.map((c) => ({ field: c.field, value: c.after })),
      );
    }

    if (
      needsSourceEvidence(draft!.ops) &&
      !draft!.evidence.some((row) => row.kind === "url" || row.kind === "observation")
    ) {
      fail(
        "evidenceRequired",
        "Factual changes need source evidence — link the page or observation that shows the fact.",
      );
    }

    const warnings = computeWarnings(draft!.ops);
    const acknowledged = new Set(args.acknowledgeWarnings ?? []);
    const unacknowledged = warnings.filter((w) => !acknowledged.has(w));
    if (unacknowledged.length > 0) {
      throw new ConvexError({
        code: "warningsUnacknowledged",
        message: "This proposal carries warnings that need explicit acknowledgment.",
        warnings: unacknowledged,
      });
    }

    await rateLimiter.limit(ctx, "proposalSubmit", { key: user._id, throws: true });

    const versionNo = proposal!.currentVersionNo + 1;
    await ctx.db.insert("proposalVersions", {
      proposalId: args.proposalId,
      versionNo,
      ops: draft!.ops,
      evidence: draft!.evidence,
      changeComment: draft!.comment,
      warningsAcknowledged: warnings,
    });
    await ctx.db.patch(args.proposalId, {
      state: "inReview",
      currentVersionNo: versionNo,
      submittedAt: Date.now(),
      stale: false,
      draft: undefined,
      claimedBy: undefined,
    });
    return { versionNo };
  },
});

/** Withdraw your own Draft or In-Review proposal — terminal, no review. */
export const withdrawProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal!, user);
    if (proposal!.state !== "draft" && proposal!.state !== "inReview") {
      fail("badState", "Only Draft or In-Review proposals can be withdrawn.");
    }
    await ctx.db.patch(args.proposalId, {
      state: "withdrawn",
      decidedAt: Date.now(),
      claimedBy: undefined,
    });
  },
});

/**
 * The explicit rebase (spec §5 — never silent): pull a stale In-Review
 * version (or an outdated draft) back to Draft against today's records.
 * Every update op re-anchors on the current base Revision with refreshed
 * before-values; changes the world already made become no-ops and drop out;
 * ops whose record vanished drop entirely (reported back). The author then
 * reviews the rebased draft and resubmits as a new immutable version.
 */
export const rebaseProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal!, user);

    let source: Draft;
    if (proposal!.state === "draft") {
      if (!proposal!.draft) fail("noOps", "This draft is empty.");
      source = proposal!.draft!;
    } else if (proposal!.state === "inReview") {
      const version = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) =>
          q
            .eq("proposalId", args.proposalId)
            .eq("versionNo", proposal!.currentVersionNo),
        )
        .unique();
      if (!version) fail("notFound", "The submitted version is missing.");
      source = {
        ops: version!.ops,
        evidence: version!.evidence,
        comment: version!.changeComment,
      };
    } else {
      return fail("badState", "Only Draft or In-Review proposals can be rebased.");
    }

    const ops: StoredOp[] = [];
    const dropped: string[] = [];
    for (const op of source.ops) {
      if (op.kind !== "update") {
        ops.push(op);
        continue;
      }
      const ref = op.ref as RecordRef;
      const doc = await getCanonical(ctx, ref);
      if (!doc || doc.status !== "active" || doc.locked) {
        dropped.push(`${ref.type} is no longer editable`);
        continue;
      }
      const changes: FieldChange[] = [];
      for (const change of op.changes) {
        const current = (doc as Record<string, unknown>)[change.field];
        if (sameValue(current, change.after)) continue; // already true
        changes.push({ field: change.field, before: current, after: change.after });
      }
      if (changes.length === 0) {
        dropped.push(`${ref.type} already matches the proposed values`);
        continue;
      }
      const latest = (await revisionsOf(ctx, ref))[0];
      ops.push({
        kind: "update",
        ref: op.ref,
        baseRevisionId: latest?._id,
        changes,
      });
    }
    if (ops.length === 0) {
      fail(
        "emptyRebase",
        "Nothing survives the rebase — every proposed change already happened or its record is gone.",
      );
    }
    await ctx.db.patch(args.proposalId, {
      state: "draft",
      stale: false,
      claimedBy: undefined,
      draft: { ops, evidence: source.evidence, comment: source.comment },
    });
    return { dropped };
  },
});

// ---------- the Moderator lifecycle: claim → approve/reject/changes ----------

async function requireInReview(
  ctx: MutationCtx,
  proposalId: Id<"proposals">,
): Promise<Doc<"proposals">> {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) fail("notFound", "No such proposal.");
  if (proposal!.state !== "inReview") {
    fail("badState", "This proposal is not in review.");
  }
  return proposal!;
}

async function currentVersionOf(
  ctx: QueryCtx | MutationCtx,
  proposal: Doc<"proposals">,
): Promise<Doc<"proposalVersions"> | null> {
  if (proposal.currentVersionNo === 0) return null;
  return await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) =>
      q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
    )
    .unique();
}

/**
 * Claim a proposal for review. Claims coordinate — they signal who is
 * looking — but never grant exclusive authority (spec §5): any Moderator can
 * still decide, and re-claiming an already-claimed proposal is visible, not
 * forbidden.
 */
export const claimProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    await requireInReview(ctx, args.proposalId);
    await ctx.db.patch(args.proposalId, { claimedBy: user._id });
  },
});

export const unclaimProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requireModerator(ctx);
    await requireInReview(ctx, args.proposalId);
    await ctx.db.patch(args.proposalId, { claimedBy: undefined });
  },
});

/** Internal review discussion — Data-Team-only, never public (spec §5). */
export const addNote = mutation({
  args: { proposalId: v.id("proposals"), text: v.string() },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    const text = args.text.trim();
    if (text === "") fail("noteRequired", "Notes cannot be empty.");
    await ctx.db.insert("proposalNotes", {
      proposalId: args.proposalId,
      versionNo: proposal!.currentVersionNo,
      authorId: user._id,
      kind: "comment",
      text,
    });
  },
});

/**
 * Request Changes: the proposal returns to Draft seeded with the reviewed
 * version, alongside a required note telling the author what to fix.
 * Resubmission creates the next immutable version — reviewers never edit a
 * version themselves.
 */
export const requestChanges = mutation({
  args: { proposalId: v.id("proposals"), note: v.string() },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const proposal = await requireInReview(ctx, args.proposalId);
    const note = args.note.trim();
    if (note === "") {
      fail("noteRequired", "Tell the author what needs to change.");
    }
    const version = await currentVersionOf(ctx, proposal);
    if (!version) fail("notFound", "The submitted version is missing.");
    await ctx.db.insert("proposalNotes", {
      proposalId: args.proposalId,
      versionNo: proposal.currentVersionNo,
      authorId: user._id,
      kind: "requestChanges",
      text: note,
    });
    await ctx.db.patch(args.proposalId, {
      state: "draft",
      claimedBy: undefined,
      draft: {
        ops: version!.ops,
        evidence: version!.evidence,
        comment: version!.changeComment,
      },
    });
  },
});

/**
 * Reject with a required reason — terminal; Data-Team-only forever.
 * Rejecting an import-authored conflict additionally suppresses each
 * rejected offer on (record, field, source, offered value) — spec §6: the
 * identical conflict never re-queues until the source offers a different
 * value, the observation is withdrawn, or the registry rules change.
 */
export const rejectProposal = mutation({
  args: { proposalId: v.id("proposals"), note: v.string() },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const proposal = await requireInReview(ctx, args.proposalId);
    const note = args.note.trim();
    if (note === "") fail("noteRequired", "Rejections need a reason.");
    await ctx.db.insert("proposalNotes", {
      proposalId: args.proposalId,
      versionNo: proposal.currentVersionNo,
      authorId: user._id,
      kind: "reject",
      text: note,
    });
    if (proposal.author.kind === "source") {
      const sourceKey = proposal.author.sourceKey;
      const version = await currentVersionOf(ctx, proposal);
      for (const op of version?.ops ?? []) {
        if (op.kind !== "update") continue;
        for (const change of op.changes) {
          const hash = valueHash(change.after);
          const existing = await ctx.db
            .query("conflictSuppressions")
            .withIndex("by_key", (q) =>
              q
                .eq("ref.type", (op.ref as RecordRef).type)
                .eq("ref.id", (op.ref as RecordRef).id as never)
                .eq("field", change.field)
                .eq("sourceKey", sourceKey)
                .eq("valueHash", hash),
            )
            .first();
          if (!existing) {
            await ctx.db.insert("conflictSuppressions", {
              ref: op.ref,
              field: change.field,
              sourceKey,
              valueHash: hash,
            });
          }
        }
      }
    }
    await ctx.db.patch(args.proposalId, {
      state: "rejected",
      decidedBy: user._id,
      decidedAt: Date.now(),
      claimedBy: undefined,
    });
  },
});

/**
 * Approve the exact reviewed version and apply every op in this one
 * mutation — creates in temp-ID order, then updates through the same
 * `applyUpdate` path as direct edits — producing one public Revision per
 * affected record. Stale-base detection blocks approval: instead of
 * applying, the proposal is flagged stale and the caller is told which
 * records moved; the author must explicitly rebase and resubmit.
 */
export const approveProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const proposal = await requireInReview(ctx, args.proposalId);
    const version = await currentVersionOf(ctx, proposal);
    if (!version) return fail("notFound", "The submitted version is missing.");

    // Stale-base gate. A mutation that throws would roll back the flag, so
    // staleness returns a result instead of throwing.
    const stale = await staleRecordsOf(ctx, version.ops);
    if (stale.length > 0) {
      await ctx.db.patch(args.proposalId, { stale: true });
      return { status: "stale" as const, stale };
    }

    // Approval re-runs validation (spec §5) before anything is written; a
    // throw here rolls back the whole approval.
    const plans = await planCreateOps(
      ctx,
      version.ops.filter((op): op is CreateOpInput => op.kind === "create"),
    );

    const temp = new Map<string, string>();
    const created: Array<{
      tempId: string;
      type: string;
      id: string;
      publicId: number | null;
    }> = [];
    const revisionIds: Id<"revisions">[] = [];
    let planCursor = 0;
    for (const op of version.ops) {
      if (op.kind === "create") {
        const plan = plans[planCursor++];
        if (!plan) return fail("invalidCreate", "Create plan out of sync.");
        const record = await applyCreatePlan(ctx, plan, temp);
        revisionIds.push(
          await ctx.db.insert("revisions", {
            ref: record.ref as never,
            seq: 1,
            proposalId: args.proposalId,
            author: proposal.author,
            approvedBy: user._id,
            changes: Object.entries(record.revisionFields)
              .filter(([, value]) => value !== undefined)
              .map(([field, after]) => ({ field, after })),
            comment: version.changeComment,
          }),
        );
        created.push({
          tempId: record.tempId,
          type: record.ref.type,
          id: record.ref.id,
          publicId: record.publicId,
        });
      } else if (op.kind === "update") {
        const ref = op.ref as RecordRef;
        const doc = await getCanonical(ctx, ref);
        // Re-validate the exact reviewed values against hard invariants.
        const changes = validateChanges(
          ref.type,
          doc!,
          op.changes.map((c) => ({ field: c.field, value: c.after })),
        );
        const { revisionId } = await applyUpdate(ctx, {
          ref,
          doc: doc!,
          baseRevisionId: op.baseRevisionId ?? null,
          changes,
          proposalId: args.proposalId,
          author: proposal.author,
          approvedBy: user._id,
          comment: version.changeComment,
        });
        revisionIds.push(revisionId);
      } else {
        // Merge/split/hide/restore/override ops arrive with ticket #33.
        return fail(
          "unsupportedOp",
          `"${op.kind}" operations are not approvable yet.`,
        );
      }
    }

    await ctx.db.patch(args.proposalId, {
      state: "approved",
      decidedBy: user._id,
      decidedAt: Date.now(),
      claimedBy: undefined,
      stale: false,
    });
    return { status: "approved" as const, revisionIds, created };
  },
});

// ---------- rendering helpers (queue + detail) ----------

const usernameCache = () => new Map<Id<"users">, string | null>();

async function usernameLookup(
  ctx: QueryCtx | MutationCtx,
  cache: Map<Id<"users">, string | null>,
  userId: Id<"users"> | undefined,
): Promise<string | null> {
  if (!userId) return null;
  if (!cache.has(userId)) {
    const user = await ctx.db.get(userId);
    cache.set(userId, user?.username ?? null);
  }
  return cache.get(userId) ?? null;
}

async function authorLabelOf(
  ctx: QueryCtx | MutationCtx,
  cache: Map<Id<"users">, string | null>,
  author: Doc<"proposals">["author"],
) {
  return author.kind === "user"
    ? {
        kind: "user" as const,
        username: await usernameLookup(ctx, cache, author.userId),
        role: author.roleAtAuthorship ?? null,
      }
    : { kind: "source" as const, sourceKey: author.sourceKey };
}

/** Record types an op set touches — update refs plus create targets. */
function recordTypesOf(ops: StoredOp[]): string[] {
  const types = new Set<string>();
  for (const op of ops) {
    if (op.kind === "create") {
      const type = CREATABLE_TABLES[op.table as keyof typeof CREATABLE_TABLES];
      types.add(type ?? op.table);
    } else if ("ref" in op) {
      types.add((op.ref as RecordRef).type);
    }
  }
  return [...types].sort();
}

function opKindsOf(ops: StoredOp[]): string[] {
  return [...new Set(ops.map((op) => op.kind))].sort();
}

/** One-line structural summary of a create op, resolving cheap references. */
async function describeCreate(
  ctx: QueryCtx | MutationCtx,
  op: Extract<StoredOp, { kind: "create" }>,
  tempLabels: Map<string, string>,
): Promise<string> {
  const fields = (op.fields ?? {}) as Record<string, unknown>;
  const refLabel = async (
    raw: unknown,
    table: "series" | "editions" | "publishers",
    nameOf: (doc: never) => string,
  ): Promise<string> => {
    if (typeof raw !== "string") return "(unknown)";
    if (tempLabels.has(raw)) return tempLabels.get(raw)!;
    const id = ctx.db.normalizeId(table, raw);
    if (!id) return `"${raw}"`;
    const doc = await ctx.db.get(id);
    return doc ? nameOf(doc as never) : "(missing)";
  };
  switch (op.table) {
    case "series": {
      const label = `new series "${String(fields.title ?? "?")}"`;
      tempLabels.set(op.tempId, label);
      return `Create ${label}`;
    }
    case "volumes": {
      const series = await refLabel(
        fields.seriesId,
        "series",
        (doc: Doc<"series">) => `series "${doc.title}"`,
      );
      const label = fields.label ? `volume "${String(fields.label)}"` : "an unnumbered volume";
      tempLabels.set(op.tempId, `the new ${label}`);
      return `Create ${label} in ${series}`;
    }
    case "editions": {
      const publisher =
        typeof fields.publisherSlug === "string"
          ? `publisher "${fields.publisherSlug}"`
          : await refLabel(
              fields.publisherId,
              "publishers",
              (doc: Doc<"publishers">) => `publisher "${doc.name}"`,
            );
      const coverage = Array.isArray(fields.volumeCoverage)
        ? fields.volumeCoverage.length
        : 0;
      tempLabels.set(op.tempId, "the new edition");
      return `Create an edition at ${publisher} covering ${coverage} volume${coverage === 1 ? "" : "s"}`;
    }
    case "releases": {
      const edition = await refLabel(
        fields.editionId,
        "editions",
        (doc: Doc<"editions">) => `edition #${doc.publicId}`,
      );
      const bits = [String(fields.format ?? "?")];
      if (fields.binding) bits.push(String(fields.binding));
      if (fields.isbn13) bits.push(`ISBN ${String(fields.isbn13)}`);
      tempLabels.set(op.tempId, "the new release");
      return `Create a ${bits.join(", ")} release of ${edition}`;
    }
    default:
      return `Create a ${op.table} record`;
  }
}

/**
 * Render an op set for review: grouped before/after per record, the base
 * Revision each update anchors on, per-record staleness, and structural
 * summaries for creates (the temp-ID graph made readable).
 */
async function renderOps(ctx: QueryCtx | MutationCtx, ops: StoredOp[]) {
  const rendered = [];
  const tempLabels = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === "create") {
      rendered.push({
        kind: "create" as const,
        table: op.table,
        tempId: op.tempId,
        fields: op.fields as Record<string, unknown>,
        summary: await describeCreate(ctx, op, tempLabels),
      });
    } else if (op.kind === "update") {
      const ref = op.ref as RecordRef;
      const doc = await getCanonical(ctx, ref);
      const title = doc
        ? (await displayInfo(ctx, ref.type, doc)).title
        : "(missing record)";
      const latest = (await revisionsOf(ctx, ref))[0];
      const base = op.baseRevisionId ? await ctx.db.get(op.baseRevisionId) : null;
      rendered.push({
        kind: "update" as const,
        recordType: ref.type,
        recordId: ref.id as string,
        recordTitle: title,
        changes: op.changes,
        base: base
          ? { seq: base.seq, comment: base.comment }
          : { seq: 0, comment: null },
        stale:
          !doc ||
          doc.status !== "active" ||
          Boolean(doc.locked) ||
          (latest?._id ?? null) !== (op.baseRevisionId ?? null),
      });
    } else {
      rendered.push({ kind: op.kind });
    }
  }
  return rendered;
}

/** Evidence rows with observation references resolved for display. */
async function renderEvidence(ctx: QueryCtx | MutationCtx, rows: Evidence[]) {
  const rendered = [];
  for (const row of rows) {
    if (row.kind === "observation") {
      const observation = await ctx.db.get(row.observationId);
      const snapshot = observation?.snapshot as { url?: unknown } | undefined;
      rendered.push({
        kind: "observation" as const,
        sourceKey: observation?.sourceKey ?? "(missing)",
        url: typeof snapshot?.url === "string" ? snapshot.url : null,
      });
    } else if (row.kind === "url") {
      rendered.push({ kind: "url" as const, url: row.url, note: row.note ?? null });
    } else {
      rendered.push({ kind: "note" as const, text: row.text });
    }
  }
  return rendered;
}

// ---------- the shared review queue (spec §5) ----------

/**
 * Every In-Review proposal, oldest first, with the facets the queue filters
 * on: operation, record type, author (imports vs humans, or one name),
 * warnings, staleness, and age. Data-Team-visible only; filters apply in
 * memory after the index scan (the queue holds tens of rows, not millions).
 * Claims are shown so reviewers coordinate without exclusive authority.
 */
export const reviewQueue = query({
  args: {
    operation: v.optional(v.string()),
    recordType: v.optional(v.string()),
    authorKind: v.optional(v.union(v.literal("imports"), v.literal("humans"))),
    author: v.optional(v.string()),
    staleOnly: v.optional(v.boolean()),
    warningsOnly: v.optional(v.boolean()),
    minAgeHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireDataTeam(ctx);
    const proposals = await ctx.db
      .query("proposals")
      .withIndex("by_state", (q) => q.eq("state", "inReview"))
      .order("asc")
      .collect();

    const cache = usernameCache();
    const now = Date.now();
    const rows = [];
    for (const proposal of proposals) {
      const version = await currentVersionOf(ctx, proposal);
      if (!version) continue;
      const stale =
        proposal.stale || (await staleRecordsOf(ctx, version.ops)).length > 0;
      rows.push({
        proposalId: proposal._id as string,
        versionNo: proposal.currentVersionNo,
        comment: version.changeComment,
        opCount: version.ops.length,
        opKinds: opKindsOf(version.ops),
        recordTypes: recordTypesOf(version.ops),
        author: await authorLabelOf(ctx, cache, proposal.author),
        warnings: version.warningsAcknowledged ?? [],
        stale,
        claimedBy: await usernameLookup(ctx, cache, proposal.claimedBy),
        submittedAt: proposal.submittedAt ?? proposal._creationTime,
        ageMs: now - (proposal.submittedAt ?? proposal._creationTime),
      });
    }

    return rows.filter((row) => {
      if (args.operation && !row.opKinds.includes(args.operation)) return false;
      if (args.recordType && !row.recordTypes.includes(args.recordType)) {
        return false;
      }
      if (args.authorKind === "imports" && row.author.kind !== "source") {
        return false;
      }
      if (args.authorKind === "humans" && row.author.kind !== "user") return false;
      if (args.author) {
        const name =
          row.author.kind === "user" ? row.author.username : row.author.sourceKey;
        if (name !== args.author) return false;
      }
      if (args.staleOnly && !row.stale) return false;
      if (args.warningsOnly && row.warnings.length === 0) return false;
      if (
        args.minAgeHours !== undefined &&
        row.ageMs < args.minAgeHours * 60 * 60 * 1000
      ) {
        return false;
      }
      return true;
    });
  },
});

/**
 * Everything the review page needs (Data-Team-only): the proposal's state
 * and people, every immutable version with rendered ops (grouped
 * before/after, base Revisions, staleness), evidence beside the changes,
 * the current Draft working copy, and the internal discussion.
 */
export const proposalDetail = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const viewer = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) return null;

    const cache = usernameCache();
    const versions = await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    versions.sort((a, b) => a.versionNo - b.versionNo);

    const renderedVersions = [];
    for (const version of versions) {
      renderedVersions.push({
        versionNo: version.versionNo,
        current: version.versionNo === proposal.currentVersionNo,
        changeComment: version.changeComment,
        warnings: version.warningsAcknowledged ?? [],
        ops: await renderOps(ctx, version.ops),
        evidence: await renderEvidence(ctx, version.evidence),
        submittedAt: version._creationTime,
      });
    }

    const notes = await ctx.db
      .query("proposalNotes")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    const renderedNotes = [];
    for (const note of notes) {
      renderedNotes.push({
        kind: note.kind,
        text: note.text,
        versionNo: note.versionNo,
        author: await usernameLookup(ctx, cache, note.authorId),
        at: note._creationTime,
      });
    }

    const current = versions.find(
      (version) => version.versionNo === proposal.currentVersionNo,
    );
    const stale =
      proposal.state === "inReview" && current
        ? (await staleRecordsOf(ctx, current.ops)).length > 0
        : Boolean(proposal.stale);

    return {
      proposalId: proposal._id as string,
      state: proposal.state,
      stale,
      author: await authorLabelOf(ctx, cache, proposal.author),
      claimedBy: await usernameLookup(ctx, cache, proposal.claimedBy),
      submittedAt: proposal.submittedAt ?? null,
      decidedAt: proposal.decidedAt ?? null,
      decidedBy: await usernameLookup(ctx, cache, proposal.decidedBy),
      currentVersionNo: proposal.currentVersionNo,
      versions: renderedVersions,
      draft: proposal.draft
        ? {
            ops: await renderOps(ctx, proposal.draft.ops),
            evidence: await renderEvidence(ctx, proposal.draft.evidence),
            comment: proposal.draft.comment,
            warnings: computeWarnings(proposal.draft.ops),
          }
        : null,
      notes: renderedNotes,
      viewer: {
        isAuthor:
          proposal.author.kind === "user" &&
          proposal.author.userId === viewer._id,
        canReview:
          viewer.role === "moderator" || viewer.role === "administrator",
      },
    };
  },
});

/**
 * Everything the "propose new volume + edition + release" wizard needs
 * (Data-Team-only): the target Series and the publishers to choose from.
 * The wizard emits temp-ID create ops — the atomic multi-record path.
 */
export const newRecordsForm = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, args) => {
    await requireDataTeam(ctx);
    const series = await ctx.db
      .query("series")
      .withIndex("by_publicId", (q) => q.eq("publicId", args.seriesPublicId))
      .unique();
    if (!series || series.status !== "active") return null;
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    const publishers = (await ctx.db.query("publishers").collect())
      .filter((publisher) => publisher.status === "active")
      .map((publisher) => ({
        id: publisher._id as string,
        slug: publisher.slug,
        name: publisher.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      seriesId: series._id as string,
      title: series.title,
      volumeCount: volumes.filter((volume) => volume.status === "active").length,
      publishers,
    };
  },
});

/** The viewer's own proposals, newest first — drafts through decisions. */
export const myProposals = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireDataTeam(ctx);
    const proposals = await ctx.db
      .query("proposals")
      .withIndex("by_author", (q) => q.eq("author.userId", user._id))
      .collect();
    proposals.sort((a, b) => b._creationTime - a._creationTime);

    const rows = [];
    for (const proposal of proposals) {
      const version = await currentVersionOf(ctx, proposal);
      const ops = version?.ops ?? proposal.draft?.ops ?? [];
      rows.push({
        proposalId: proposal._id as string,
        state: proposal.state,
        stale: Boolean(proposal.stale),
        comment: version?.changeComment ?? proposal.draft?.comment ?? "",
        opCount: ops.length,
        recordTypes: recordTypesOf(ops),
        updatedAt: proposal.decidedAt ?? proposal.submittedAt ?? proposal._creationTime,
      });
    }
    return rows;
  },
});
