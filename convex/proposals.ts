// Editor Proposals and the review queue (spec §5). The full
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
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
  applyClearOverride,
  applyUpdate,
  coverArtOf,
  getCanonical,
  insertRevision,
  requireOverridden,
  revisionsOf,
  validateChanges,
  validateUpdate,
  writtenBy,
  type CatalogDoc,
  type FieldChange,
  type RecordRef,
} from "./moderation";
import { citation as citationValidator, evidence, recordRef } from "./schema";
import { fieldAttribution } from "./lib/attribution";
import { checkCoverUse, coverBlobsOf, pinCovers } from "./lib/coverRefs";
import { coverUrl } from "./lib/covers";
import { checkComment, checkEvidence } from "./lib/evidence";
import {
  applyCreatePlan,
  carriesPlacement,
  checkOpCount,
  marksJoin,
  planCreateOps,
  unavailableCreateRefs,
  CREATABLE_TABLES,
  type CreateOpInput,
  type IsbnUpdate,
} from "./lib/proposalCreates";
import { fail } from "./lib/errors";
import { toIsbn13 } from "./lib/isbn";
import { publiclyVisible, type RecordGet } from "./lib/publicRecords";
import { loaded, proposalReads, type ProposalReads } from "./lib/proposalReads";
import { primaryNamespaceRefusal } from "./lib/releaseIsbns";
import {
  editorialField,
  fieldDescriptor,
  type Citation,
  type RecordType,
} from "./lib/moderationFields";
import { observationRatesMature } from "./lib/mature";
import { linkObservation } from "./lib/observations";
import { captureModeration } from "./lib/posthog";
import type { ProposalWarning } from "./lib/proposalWarnings";
import {
  matchesQueueFilters,
  queueKind,
  reportSeriesPublicId,
  summarizeVersion,
  type QueueKind,
} from "./lib/queueSummary";
import { requireUser } from "./lib/auth";
import { onDataTeam, requireDataTeam, requireModerator } from "./lib/roles";
import {
  applyMerge,
  SINGLE_RECORD_OPS,
  type OpMeta,
  type SingleRecordOp,
} from "./lib/sensitiveOps";
import { usernameLookup } from "./lib/usernameLookup";
import { sameValue, valueHash } from "./lib/values";
import { checkPlacement, placementChanged, placementView } from "./placement";

// ---------- abuse controls (spec §5: rate limits + bulk caps) ----------

// Token buckets per user (Convex rate-limiter component): steady editing
// never hits these; scripted abuse does. A reader's Suggestions draw on
// their own, tighter buckets.
export const RATE_LIMITS = {
  proposalSubmit: { kind: "token bucket", rate: 30, period: HOUR, capacity: 5 },
  proposalDraftSave: {
    kind: "token bucket",
    rate: 120,
    period: HOUR,
    capacity: 20,
  },
  suggestionSubmit: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
  suggestionDraftSave: { kind: "token bucket", rate: 60, period: HOUR, capacity: 10 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, RATE_LIMITS);

/** The most ops one Suggestion carries (the Data Team's cap is MAX_OPS_PER_PROPOSAL). */
export const MAX_SUGGESTION_OPS = 10;

/** The most versions one Proposal's page lists, the newest (proposalDetail, suggestions.detail). */
export const VERSIONS_SHOWN = 50;

/**
 * How many of those, the newest, show their changes (ops and evidence);
 * older ones show their number, comment, op count and submission time.
 * The current version is the newest, so it is always among them.
 */
export const CHANGES_SHOWN = 6;

/** The most Suggestions one reader may have open (Draft or In Review) at once. */
export const MAX_OPEN_SUGGESTIONS = 20;

/**
 * Whether `proposal` is a Suggestion: a person wrote it holding no
 * data-team role (lib/queueSummary.ts `suggestion`). It stays one whatever
 * role they hold later, so the reader gate (`readerGated`) holds it while
 * they revise it on the Data Team and after that role is revoked.
 */
export function isSuggestion(proposal: Doc<"proposals">) {
  return proposal.author.kind === "user" && proposal.author.roleAtAuthorship === undefined;
}

/**
 * Whether `user` writing `proposal` (null for a new Draft) is held to the
 * reader gate: they hold no data-team role, or it is a Suggestion.
 */
function readerGated(user: Doc<"users">, proposal: Doc<"proposals"> | null) {
  return !onDataTeam(user) || (proposal !== null && isSuggestion(proposal));
}

/**
 * The reader gate on a Proposal's ops: a Suggestion only updates fields of
 * existing records, at most MAX_SUGGESTION_OPS of them. Creating records,
 * clearing an override, and merging, hiding or locking stay with the Data
 * Team. Which fields an update may name is the field registry's to say
 * (moderation.ts validateChanges), as for anyone. Saving, submitting and
 * rebasing all check it (`readerGated`), so a Draft written while its
 * author was on the Data Team goes no further once they are not, and a
 * Suggestion never becomes more than one.
 */
function checkSuggestionOps(ops: ReadonlyArray<{ kind: string }>) {
  if (ops.length > MAX_SUGGESTION_OPS) {
    fail("bulkCap", `A suggestion carries at most ${MAX_SUGGESTION_OPS} changes.`);
  }
  if (ops.some((op) => op.kind !== "update")) {
    fail(
      "forbidden",
      "A suggestion changes fields of existing records. Creating records or clearing an override needs the Data Team.",
    );
  }
}

/**
 * A reader suggests changes only to records the public catalog shows
 * (lib/publicRecords.ts publiclyVisible): a Volume of a hidden Series reads as
 * not found, as its page does. Saving and submitting check it; one hidden
 * while the Suggestion is In Review is left to the Moderator deciding it.
 */
async function checkSuggestionTargets(ctx: QueryCtx, ops: ReadonlyArray<OpInput | StoredOp>) {
  for (const op of ops) {
    if (op.kind !== "update") continue;
    const doc = await getCanonical(ctx, op.ref);
    if (!doc || !(await publiclyVisible(ctx, op.ref.type, doc))) {
      fail("notFound", "That record is not in the public catalog.");
    }
  }
}

/**
 * The most a Suggestion stores, in bytes of its ops (before- and
 * after-values), evidence and comment. One record's change fits many times
 * over; the bound keeps any reader's rows small enough that the review
 * queue and their Suggestions list (suggestions.ts mine), which read many
 * at once, stay far inside a query's read limit.
 */
export const MAX_SUGGESTION_BYTES = 64 * 1024;

/** Refuse a reader's Draft larger than MAX_SUGGESTION_BYTES. */
function checkSuggestionSize(draft: Draft) {
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_SUGGESTION_BYTES) {
    fail(
      "tooLarge",
      "This suggestion is too large. Split it into smaller ones, or shorten its text.",
    );
  }
}

/** Refuse a reader's new Suggestion while MAX_OPEN_SUGGESTIONS of theirs are open. */
async function checkOpenSuggestions(ctx: MutationCtx, userId: Id<"users">) {
  let open = 0;
  for (const state of ["draft", "inReview"] as const) {
    const rows = await ctx.db
      .query("proposals")
      .withIndex("by_author", (q) => q.eq("author.userId", userId).eq("state", state))
      .take(MAX_OPEN_SUGGESTIONS);
    open += rows.length;
  }
  if (open >= MAX_OPEN_SUGGESTIONS) {
    fail(
      "tooManyOpen",
      `You have ${MAX_OPEN_SUGGESTIONS} suggestions open. Submit, finish or withdraw some first.`,
    );
  }
}

// ---------- shared shapes ----------

type StoredOp = Doc<"proposalVersions">["ops"][number];
type Evidence = Doc<"proposalVersions">["evidence"][number];
type Draft = NonNullable<Doc<"proposals">["draft"]>;

// What clients submit when drafting: creates carry raw fields (validated by
// the creation registry); updates carry field/value pairs and a
// clearOverride names one overridden field — the server computes
// before/after and captures the base Revision.
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
    // The source of the record's editorial text (moderation.ts validateUpdate).
    citation: v.optional(v.union(citationValidator, v.null())),
  }),
  v.object({
    kind: v.literal("clearOverride"),
    ref: recordRef,
    field: v.string(),
  }),
);

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
      citation?: Citation | null;
    }
  | { kind: "clearOverride"; ref: RecordRef; field: string };

/**
 * Validate submitted draft ops against the current database and return the
 * stored form: update ops get normalized before/after changes and the
 * record's current base Revision (the staleness anchor); a clearOverride
 * must name an editable field the record has overridden and gets the base
 * Revision too; create ops keep their validated raw fields so temp-ID
 * references survive verbatim, except a held book's `placement` and the
 * `joinExisting` mark, which only placement.ts and the importers write. A
 * record takes one update and any number of clears, but never a change to
 * a field and the clear of its override together: the change is itself a
 * human correction, and which of the two applied last would decide the
 * outcome. `reader` (a Suggestion's Draft) holds a cover to the art a
 * reader may use (lib/coverRefs.ts checkCoverUse).
 */
async function buildDraftOps(
  ctx: MutationCtx,
  submitted: OpInput[],
  author: Doc<"users">,
  reader: boolean,
): Promise<StoredOp[]> {
  if (submitted.length === 0) {
    fail("noOps", "A proposal needs at least one operation.");
  }
  checkOpCount(submitted.length);
  const ops: StoredOp[] = [];
  const updatedRecords = new Set<string>();
  const clearedFields = new Set<string>();
  for (const op of submitted) {
    if (op.kind === "create") {
      if (carriesPlacement(op)) {
        fail(
          "invalidCreate",
          "A held book's placement is prepared from its observation: use Prepare placement.",
        );
      }
      if (marksJoin(op)) {
        fail(
          "invalidCreate",
          "A create op joins an existing record only in a placement or an import: reference the record by ID.",
        );
      }
      ops.push({
        kind: "create",
        table: op.table,
        tempId: op.tempId,
        fields: op.fields,
      });
      continue;
    }
    const ref = op.ref;
    if (op.kind === "update") {
      if (updatedRecords.has(ref.id as string)) {
        fail("duplicateRecord", "One proposal may update each record only once.");
      }
      updatedRecords.add(ref.id as string);
    } else {
      const key = `${ref.id}:${op.field}`;
      if (clearedFields.has(key)) {
        fail("duplicateRecord", "One proposal may clear each override only once.");
      }
      clearedFields.add(key);
    }
    const doc = await getCanonical(ctx, ref);
    if (!doc) fail("notFound", "A record this proposal changes does not exist.");
    if (doc.status !== "active" || doc.locked) {
      fail("locked", `A record this proposal changes is ${doc.locked ? "locked" : doc.status}.`);
    }
    const latest = (await revisionsOf(ctx, ref))[0];
    if (op.kind === "update") {
      const { changes, citation, citedText } = await validateUpdate(ctx, {
        ref,
        doc,
        changes: op.changes,
        citation: op.citation,
        author,
        reader,
      });
      ops.push({
        kind: "update",
        ref,
        baseRevisionId: latest?._id,
        changes,
        ...(citation !== undefined ? { citation } : {}),
        ...(citedText !== undefined ? { citedText } : {}),
      });
    } else {
      requireOverridden(ref.type, doc, op.field);
      ops.push({
        kind: "clearOverride",
        ref,
        field: op.field,
        baseRevisionId: latest?._id,
      });
    }
  }
  for (const op of ops) {
    if (op.kind !== "update") continue;
    for (const { field } of op.changes) {
      if (clearedFields.has(`${op.ref.id}:${field}`)) {
        fail(
          "clearsChangedField",
          `This proposal changes "${field}" and clears its override: a changed field stays a human correction. Clear the override on its own.`,
        );
      }
    }
  }
  await planOps(ctx, ops);
  return ops;
}

/**
 * Validate an op set's creates together with the Release ISBNs its updates
 * write, so the proposal's final ISBN assignments are checked as one.
 * Save, submission, and approval all run this; approval inside its
 * transaction, before anything is written.
 */
async function planOps(ctx: MutationCtx, ops: StoredOp[]) {
  const isbnUpdates: IsbnUpdate[] = [];
  const bundleAssignments = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "update") continue;
    // A Bundle never takes an ISBN with Other Printings (lib/releaseIsbns.ts).
    if (op.ref.type === "releaseBundle") {
      const isbns = op.changes.flatMap(({ field, after }) =>
        (field === "isbn13" || field === "isbn10") && typeof after === "string" ? [after] : [],
      );
      for (const isbn of isbns) {
        const key = toIsbn13(isbn);
        if (key) bundleAssignments.add(key);
      }
      const printed = await primaryNamespaceRefusal(ctx, isbns, "bundle", op.ref.id);
      if (printed !== null) fail("invalidField", `${printed} Correct that first.`);
    }
    if (op.ref.type !== "release") continue;
    for (const { field, after } of op.changes) {
      if (field !== "isbn13" && field !== "isbn10") continue;
      isbnUpdates.push({
        releaseId: op.ref.id,
        field,
        isbn: typeof after === "string" ? after : undefined,
      });
    }
  }
  const plans = await planCreateOps(
    ctx,
    ops.filter((op): op is CreateOpInput => op.kind === "create"),
    isbnUpdates,
  );
  const releaseAssignments = [
    ...isbnUpdates.map((update) => update.isbn),
    ...plans.flatMap((plan) =>
      plan.table === "releases" ? [plan.fields.isbn13, plan.fields.isbn10] : [],
    ),
  ];
  for (const isbn of releaseAssignments) {
    const key = toIsbn13(isbn);
    if (key && bundleAssignments.has(key))
      fail("invalidField", `A Release and Bundle in this proposal would share ISBN ${key}.`);
  }
  return plans;
}

/**
 * Keep every cover blob `ops` name while the Proposal is undecided
 * (lib/coverRefs.ts), so neither an import nor the upload sweep deletes
 * art a reviewer has yet to see.
 */
async function pinProposalCovers(ctx: MutationCtx, proposalId: Id<"proposals">, ops: StoredOp[]) {
  const changes = ops.flatMap((op) => (op.kind === "update" ? op.changes : []));
  await pinCovers(ctx, coverBlobsOf(changes), { proposalId });
}

/**
 * The editorial text an update op's citation is about, when the op leaves
 * that text alone: what it was chosen for (`citedText`). Undefined when the
 * op cites nothing or writes the text itself.
 */
function citedTextOf(op: Extract<StoredOp, { kind: "update" }>): string | undefined {
  const field = editorialField(op.ref.type);
  if (op.citation === undefined || !field) return undefined;
  if (op.changes.some((change) => change.field === field.name)) return undefined;
  return op.citedText ?? "";
}

/**
 * Re-validate an update op exactly as stored: its values against today's
 * record and hard invariants, an op that only cites a source included,
 * which is refused once the text it was chosen for has changed.
 */
function revalidate(op: Extract<StoredOp, { kind: "update" }>, doc: CatalogDoc) {
  const cited = citedTextOf(op);
  const field = editorialField(op.ref.type);
  if (cited !== undefined && field && (doc as Record<string, unknown>)[field.name] !== cited) {
    fail(
      "stale",
      "The text this source was chosen for has changed. Rebase, then choose its source again.",
    );
  }
  return validateChanges(
    op.ref.type,
    doc,
    op.changes.map((c) => ({ field: c.field, value: c.after })),
    op.citation !== undefined,
  );
}

// ---------- warnings (surfaced at submit, acknowledged explicitly) ----------

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
    const type = op.ref.type;
    for (const change of op.changes) {
      if (!fieldDescriptor(type, change.field)?.editorial) return true;
    }
  }
  return false;
}

// ---------- staleness ----------

type StaleRecord = {
  type: string;
  id: string;
  reason: "baseChanged" | "unavailable" | "notOverridden";
};

/**
 * Which records an op set can no longer be applied to as reviewed: the base
 * Revision moved (someone else's change landed first), the record itself
 * left ordinary editing (hidden, merged, locked, deleted), a field a
 * clearOverride names is no longer overridden, or a record a create op
 * references by ID — an importer's coverage over existing Volumes, a new
 * volume's series — is no longer active. Spec §5: any base change before
 * approval makes the version stale — explicit rebase and resubmit, never a
 * silent rebase. Each record is listed once per reason, however many of
 * its ops are stale. A query passes its response's `reads`, so each record
 * and its newest Revision are read once however many rows name them.
 */
export async function staleRecordsOf(
  ctx: QueryCtx,
  ops: StoredOp[],
  reads: ProposalReads = proposalReads(ctx),
): Promise<StaleRecord[]> {
  const stale: StaleRecord[] = [];
  for (const op of ops) {
    if (op.kind !== "update" && op.kind !== "clearOverride") continue;
    const ref = op.ref;
    const doc = await reads.doc(ref);
    if (!doc || doc.status !== "active" || doc.locked) {
      stale.push({ type: ref.type, id: ref.id as string, reason: "unavailable" });
      continue;
    }
    const latest = await reads.latest(ref);
    if ((latest?._id ?? null) !== (op.baseRevisionId ?? null)) {
      stale.push({ type: ref.type, id: ref.id as string, reason: "baseChanged" });
    } else if (op.kind === "clearOverride" && !(doc.overriddenFields ?? []).includes(op.field)) {
      stale.push({ type: ref.type, id: ref.id as string, reason: "notOverridden" });
    }
  }
  const creates = ops.filter((op): op is CreateOpInput => op.kind === "create");
  for (const ref of await unavailableCreateRefs(ctx, creates)) {
    stale.push({ ...ref, reason: "unavailable" });
  }
  const seen = new Set<string>();
  return stale.filter(({ type, id, reason }) => {
    const key = `${type}:${id}:${reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- the Editor lifecycle: draft → submit → withdraw/rebase ----------

/**
 * Create or update a Draft proposal — the mutable working copy. Validation
 * runs now so problems surface while drafting, and again at submission and
 * approval; its evidence and comment are held to lib/evidence.ts's bounds.
 * Any data-team member may author proposals; any other signed-in User a
 * Suggestion (checkSuggestionOps), under their own rate limit,
 * MAX_OPEN_SUGGESTIONS and MAX_SUGGESTION_BYTES, citing only observations
 * the public catalog shows; a Suggestion stays under those rules whoever
 * revises it (`readerGated`). A Draft that places a held book is refused
 * (`placementDraft`): its author states it through placement.setPlacement,
 * which rebuilds its ops from the observation.
 */
export const saveDraft = mutation({
  args: {
    proposalId: v.optional(v.id("proposals")),
    ops: v.array(opInput),
    evidence: v.array(evidence),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const proposal = args.proposalId ? await ctx.db.get(args.proposalId) : null;
    if (args.proposalId) {
      if (!proposal) fail("notFound", "No such proposal.");
      requireAuthor(proposal, user);
      if (proposal.state !== "draft") {
        fail("badState", "Only Draft proposals can be edited.");
      }
      if (proposal.draft?.ops.some((op) => op.kind === "create" && carriesPlacement(op))) {
        fail(
          "placementDraft",
          "This Draft places a held book: state its coverage, line and comment in its placement form.",
        );
      }
    }
    const reader = readerGated(user, proposal);
    if (reader) {
      checkSuggestionOps(args.ops);
      await checkSuggestionTargets(ctx, args.ops);
    }
    await rateLimiter.limit(ctx, reader ? "suggestionDraftSave" : "proposalDraftSave", {
      key: user._id,
      throws: true,
    });
    const ops = await buildDraftOps(ctx, args.ops as OpInput[], user, reader);
    const draft: Draft = {
      ops,
      evidence: await checkEvidence(ctx, args.evidence, reader),
      comment: checkComment(args.comment),
    };
    if (reader) checkSuggestionSize(draft);

    if (proposal) {
      await ctx.db.patch(proposal._id, { draft });
      await pinProposalCovers(ctx, proposal._id, ops);
      return { proposalId: proposal._id };
    }
    if (reader) await checkOpenSuggestions(ctx, user._id);
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
    await pinProposalCovers(ctx, proposalId, ops);
    return { proposalId };
  },
});

/**
 * Submit a Draft for review: full validation, required change comment,
 * source evidence for factual changes, explicit warning acknowledgment, the
 * per-user submission rate limit — then the draft freezes into an immutable
 * Proposal Version and the proposal lands In Review. Resubmission after
 * Request Changes runs through here again and mints the next version. Only
 * the author submits; a reader's Draft, or a Suggestion, must still pass
 * the reader gate (`readerGated`).
 */
export const submitProposal = mutation({
  args: {
    proposalId: v.id("proposals"),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal, user);
    if (proposal.state !== "draft") {
      fail("badState", "Only Draft proposals can be submitted.");
    }
    const reader = readerGated(user, proposal);
    const draft = proposal.draft;
    if (!draft || draft.ops.length === 0) {
      fail("noOps", "This draft has no operations to submit.");
    }
    if (reader) {
      checkSuggestionOps(draft.ops);
      await checkSuggestionTargets(ctx, draft.ops);
      // A Draft written on the Data Team, or a source hidden since it was saved.
      await checkEvidence(ctx, draft.evidence, true);
      checkSuggestionSize(draft);
    }
    if (draft.comment === "") {
      fail("commentRequired", "Every submission needs a change comment.");
    }

    // Submission runs validation (spec §5): bases must still be current,
    // references must still resolve, values must still be legal.
    const stale = await staleRecordsOf(ctx, draft.ops);
    if (stale.length > 0) {
      throw new ConvexError({
        code: "stale",
        message:
          "Records changed since this draft was saved — rebase the draft, review it, and submit again.",
        stale,
      });
    }
    await checkPlacement(ctx, args.proposalId, await planOps(ctx, draft.ops));
    for (const op of draft.ops) {
      if (op.kind !== "update") continue;
      const doc = await getCanonical(ctx, op.ref);
      const changes = revalidate(op, doc!);
      // A cover must still be the author's upload or catalog art, and stored.
      for (const change of changes) {
        if (change.field === "coverImage") {
          await checkCoverUse(ctx, doc as Doc<"releases">, change, user, reader);
        }
      }
    }
    await pinProposalCovers(ctx, args.proposalId, draft.ops);

    if (
      needsSourceEvidence(draft.ops) &&
      !draft.evidence.some((row) => row.kind === "url" || row.kind === "observation")
    ) {
      fail(
        "evidenceRequired",
        "Factual changes need source evidence — link the page or observation that shows the fact.",
      );
    }

    const warnings = computeWarnings(draft.ops);
    const acknowledged = new Set(args.acknowledgeWarnings ?? []);
    const unacknowledged = warnings.filter((w) => !acknowledged.has(w));
    if (unacknowledged.length > 0) {
      throw new ConvexError({
        code: "warningsUnacknowledged",
        message: "This proposal carries warnings that need explicit acknowledgment.",
        warnings: unacknowledged,
      });
    }

    await rateLimiter.limit(ctx, reader ? "suggestionSubmit" : "proposalSubmit", {
      key: user._id,
      throws: true,
    });

    const versionNo = proposal.currentVersionNo + 1;
    await ctx.db.insert("proposalVersions", {
      proposalId: args.proposalId,
      versionNo,
      ops: draft.ops,
      evidence: draft.evidence,
      changeComment: draft.comment,
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

/**
 * Withdraw your own Draft or In-Review proposal — terminal, no review. Any
 * signed-in author may, whatever their role now.
 */
export const withdrawProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal, user);
    if (proposal.state !== "draft" && proposal.state !== "inReview") {
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
 * a clearOverride re-anchors too, or drops when its field is no longer
 * overridden; ops whose record vanished drop entirely (reported back). The
 * author then reviews the rebased draft and resubmits as a new immutable
 * version. Only the author rebases; a reader's, or a Suggestion, must
 * still carry only what a Suggestion may (`readerGated`).
 */
export const rebaseProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) fail("notFound", "No such proposal.");
    requireAuthor(proposal, user);

    let source: Draft;
    if (proposal.state === "draft") {
      if (!proposal.draft) fail("noOps", "This draft is empty.");
      source = proposal.draft;
    } else if (proposal.state === "inReview") {
      const version = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) =>
          q.eq("proposalId", args.proposalId).eq("versionNo", proposal.currentVersionNo),
        )
        .unique();
      if (!version) fail("notFound", "The submitted version is missing.");
      source = {
        ops: version.ops,
        evidence: version.evidence,
        comment: version.changeComment,
      };
    } else {
      return fail("badState", "Only Draft or In-Review proposals can be rebased.");
    }
    const reader = readerGated(user, proposal);
    if (reader) checkSuggestionOps(source.ops);

    const ops: StoredOp[] = [];
    const dropped: string[] = [];
    for (const op of source.ops) {
      if (op.kind !== "update" && op.kind !== "clearOverride") {
        ops.push(op);
        continue;
      }
      const ref = op.ref;
      const doc = await getCanonical(ctx, ref);
      if (!doc || doc.status !== "active" || doc.locked) {
        dropped.push(`${ref.type} is no longer editable`);
        continue;
      }
      if (op.kind === "clearOverride") {
        if (!(doc.overriddenFields ?? []).includes(op.field)) {
          dropped.push(`${ref.type} no longer overrides ${op.field}`);
          continue;
        }
        const latest = (await revisionsOf(ctx, ref))[0];
        ops.push({ ...op, baseRevisionId: latest?._id });
        continue;
      }
      const changes: FieldChange[] = [];
      for (const change of op.changes) {
        const current = (doc as Record<string, unknown>)[change.field];
        if (sameValue(current, change.after)) continue; // already true
        changes.push({ field: change.field, before: current, after: change.after });
      }
      const cited = await rebasedCitation(ctx, op, doc, changes);
      if (cited === "moved") {
        dropped.push(`${ref.type} text changed since its source was chosen`);
      }
      const { citation, citedText } = cited === "moved" ? {} : (cited ?? {});
      if (changes.length === 0 && citation === undefined) {
        if (cited !== "moved") dropped.push(`${ref.type} already matches the proposed values`);
        continue;
      }
      const latest = (await revisionsOf(ctx, ref))[0];
      ops.push({
        kind: "update",
        ref: op.ref,
        baseRevisionId: latest?._id,
        changes,
        ...(citation !== undefined ? { citation } : {}),
        ...(citedText !== undefined ? { citedText } : {}),
      });
    }
    if (ops.length === 0) {
      fail(
        "emptyRebase",
        "Nothing survives the rebase: every proposed change already happened, its record is gone, or the text a source was chosen for has changed.",
      );
    }
    const draft = { ops, evidence: source.evidence, comment: source.comment };
    // Rebasing copies the record's current values into `before`, which can
    // grow a Suggestion past its cap when those values grew meanwhile.
    if (reader) checkSuggestionSize(draft);
    await ctx.db.patch(args.proposalId, {
      state: "draft",
      stale: false,
      claimedBy: undefined,
      draft,
    });
    return { dropped };
  },
});

/**
 * An update op's source statement after a rebase: kept while the op still
 * changes the text. Otherwise it is about the text the op wrote or was
 * drafted against: "moved" when today's text is different (the source must
 * be chosen again), else kept, with that text as its `citedText`, only
 * when today's credit differs from it (the rule moderation.ts
 * validateUpdate applies to a fresh op).
 */
async function rebasedCitation(
  ctx: MutationCtx,
  op: Extract<StoredOp, { kind: "update" }>,
  doc: CatalogDoc,
  changes: FieldChange[],
): Promise<{ citation: Citation | null; citedText?: string } | "moved" | undefined> {
  const field = editorialField(op.ref.type);
  if (op.citation === undefined || !field) return undefined;
  if (changes.some((change) => change.field === field.name)) return { citation: op.citation };
  const text = (doc as Record<string, unknown>)[field.name];
  const wrote = op.changes.find((change) => change.field === field.name);
  if (text !== (wrote ? wrote.after : citedTextOf(op))) return "moved";
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const current = await fieldAttribution(ctx, op.ref, field.name, text);
  return sameValue(current, op.citation) ? undefined : { citation: op.citation, citedText: text };
}

// ---------- the Moderator lifecycle: claim → approve/reject/changes ----------

async function requireInReview(
  ctx: MutationCtx,
  proposalId: Id<"proposals">,
): Promise<Doc<"proposals">> {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) fail("notFound", "No such proposal.");
  if (proposal.state !== "inReview") {
    fail("badState", "This proposal is not in review.");
  }
  return proposal;
}

export async function currentVersionOf(
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
      versionNo: proposal.currentVersionNo,
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
 * version themselves. Refused for an import's proposal: no one revises an
 * import's Draft, and no list shows one, so it would strand the book. Also
 * refused for a reader's report (no ops): there is nothing to revise, and a
 * Draft with no ops can never be submitted again.
 */
export const requestChanges = mutation({
  args: { proposalId: v.id("proposals"), note: v.string() },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const proposal = await requireInReview(ctx, args.proposalId);
    if (proposal.author.kind === "source") {
      fail(
        "importAuthored",
        "An import wrote this proposal, so no one can revise it: approve it, reject it, or edit the record directly.",
      );
    }
    const note = args.note.trim();
    if (note === "") {
      fail("noteRequired", "Tell the author what needs to change.");
    }
    const version = await currentVersionOf(ctx, proposal);
    if (!version) fail("notFound", "The submitted version is missing.");
    if (version.ops.length === 0) {
      fail("nothingToRevise", "A report has nothing to revise: approve it or reject it.");
    }
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
        ops: version.ops,
        evidence: version.evidence,
        comment: version.changeComment,
      },
    });
    await captureModeration(ctx, user, "request_changes", "proposal");
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
                .eq("ref.type", op.ref.type)
                .eq("ref.id", op.ref.id)
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
    await captureModeration(ctx, user, "reject", "proposal");
  },
});

/**
 * Approve the exact reviewed version and apply every op in this one
 * mutation — creates in temp-ID order, then updates and clearOverrides
 * through the same `applyUpdate` and `applyClearOverride` paths as direct
 * edits — producing one public Revision per update or clear. Stale-base
 * detection blocks approval: instead of applying, the proposal is flagged
 * stale and the caller is told which records moved; the author must
 * explicitly rebase and resubmit. A new Release that places a held book
 * (placement.ts) gets that book's observation linked to it here, which
 * takes it off the Held Books list and applies its 18+ evidence.
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
    // throw here rolls back the whole approval. A held book's placement is
    // checked against the book as it is now (placement.ts checkPlacement).
    const plans = await planOps(ctx, version.ops);
    await checkPlacement(ctx, args.proposalId, plans);

    const temp = new Map<string, string>();
    const created: Array<{
      tempId: string;
      type: string;
      id: string;
      publicId: number | null;
    }> = [];
    const revisionIds: Id<"revisions">[] = [];
    const meta: OpMeta = {
      proposalId: args.proposalId,
      author: proposal.author,
      approvedBy: user._id,
      comment: version.changeComment,
    };
    // The stale gate checked every op's base before anything was written; a
    // record this approval has already revised is checked against that
    // Revision instead, so its update and clears apply in op order.
    const revisedHere = new Map<string, Id<"revisions">>();
    const baseOf = (op: { ref: RecordRef; baseRevisionId?: Id<"revisions"> }) =>
      revisedHere.get(op.ref.id) ?? op.baseRevisionId ?? null;
    let planCursor = 0;
    for (const op of version.ops) {
      if (op.kind === "create") {
        const plan = plans[planCursor++];
        if (!plan) return fail("invalidCreate", "Create plan out of sync.");
        const record = await applyCreatePlan(ctx, plan, temp);
        // A joined existing record was not created: no creation Revision.
        if (record.existing) continue;
        if (
          plan.table === "releases" &&
          plan.placement !== undefined &&
          record.ref.type === "release"
        ) {
          // Linking clears the hold and applies the book's 18+ evidence.
          await linkObservation(ctx, plan.placement.observationId, record.ref);
        }
        const changes = Object.entries(record.revisionFields)
          .filter(([, value]) => value !== undefined)
          .map(([field, after]) => ({ field, after }));
        revisionIds.push((await insertRevision(ctx, record.ref, null, changes, meta)).revisionId);
        created.push({
          tempId: record.tempId,
          type: record.ref.type,
          id: record.ref.id,
          publicId: record.publicId,
        });
      } else if (op.kind === "update") {
        const ref = op.ref;
        const doc = await getCanonical(ctx, ref);
        // Re-validate the exact reviewed values against hard invariants.
        const changes = revalidate(op, doc!);
        const { revisionId } = await applyUpdate(ctx, {
          ref,
          doc: doc!,
          baseRevisionId: baseOf(op),
          changes,
          proposalId: args.proposalId,
          author: proposal.author,
          approvedBy: user._id,
          comment: version.changeComment,
          citation: op.citation,
        });
        revisedHere.set(ref.id, revisionId);
        revisionIds.push(revisionId);
      } else if (op.kind === "clearOverride") {
        const { revisionId } = await applyClearOverride(ctx, {
          ref: op.ref,
          field: op.field,
          baseRevisionId: baseOf(op),
          meta,
        });
        revisedHere.set(op.ref.id, revisionId);
        revisionIds.push(revisionId);
      } else {
        // Sensitive catalog operations: the same apply
        // functions as the direct Moderator mutations (sensitiveOps.ts) —
        // each validates the record's current state and throws (rolling the
        // whole approval back) when the world moved.
        if (op.kind === "merge") {
          revisionIds.push(...(await applyMerge(ctx, op.survivor, op.merged, meta)));
        } else {
          revisionIds.push(...(await SINGLE_RECORD_OPS[op.kind](ctx, op.ref, meta)));
        }
      }
    }

    await ctx.db.patch(args.proposalId, {
      state: "approved",
      decidedBy: user._id,
      decidedAt: Date.now(),
      claimedBy: undefined,
      stale: false,
    });
    await captureModeration(ctx, user, "approve", "proposal");
    return { status: "approved" as const, revisionIds, created };
  },
});

// ---------- rendering helpers (queue + detail) ----------

async function authorLabelOf(
  usernameOf: ReturnType<typeof usernameLookup>,
  author: Doc<"proposals">["author"],
) {
  return author.kind === "user"
    ? {
        kind: "user" as const,
        username: await usernameOf(author.userId),
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
      types.add(op.ref.type);
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
  get: RecordGet,
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
    const doc = await get(id);
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
      const coverage = Array.isArray(fields.volumeCoverage) ? fields.volumeCoverage.length : 0;
      tempLabels.set(op.tempId, "the new edition");
      if (fields.coverageUnmapped === true) {
        return `Create an edition at ${publisher} as Unmapped Packaging of its line`;
      }
      if (coverage === 0) {
        return `Create an edition at ${publisher} whose coverage is not stated yet`;
      }
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
      const placed = fields.placement === undefined ? "" : ", linked to the held book it places";
      return `Create a ${bits.join(", ")} release of ${edition}${placed}`;
    }
    default:
      return `Create a ${op.table} record`;
  }
}

/** How a reader's own Proposal names a record the public catalog no longer shows. */
export const NOT_PUBLIC = "A record that is no longer public";

/**
 * What op rendering tells of the record an op names, from `reads`: the
 * record, its newest Revision, its title, and whether its live state may be
 * shown. From `proposalReads(ctx, { publicOnly: true })` (a reader's own
 * Proposals, suggestions.ts) a record the public catalog does not show is
 * titled NOT_PUBLIC and `shown` is false, so nothing of it now is told.
 */
async function recordFacts(reads: ProposalReads, ref: RecordRef) {
  const doc = await reads.doc(ref);
  const shown = await reads.shown(ref);
  const title = shown || !doc ? (await reads.display(ref)).title : NOT_PUBLIC;
  return { doc, shown, title, latest: await reads.latest(ref) };
}

/**
 * Render an op set for review: grouped before/after per record, the base
 * Revision each update anchors on, per-record staleness, and structural
 * summaries for creates (the temp-ID graph made readable). Staleness and a
 * clear's kept value compare against the live record, so they are reported
 * only for `live` ops (the working copy or current version of a Proposal
 * still in Draft or review); a decided Proposal's approval itself moved the
 * base, and the live value is not what it reviewed. `reads` is shared by
 * one response's calls; from `proposalReads(ctx, { publicOnly: true })`, a
 * record it does not show keeps only what the author wrote: its changes'
 * after-values and citation, with no title, before-values or base comment
 * (`withheld`).
 */
export async function renderOps(
  ctx: QueryCtx,
  ops: StoredOp[],
  live: boolean,
  reads: ProposalReads = proposalReads(ctx),
) {
  const rendered = [];
  const tempLabels = new Map<string, string>();
  const baseOf = async (op: { baseRevisionId?: Id<"revisions"> }, shown: boolean) => {
    const base = op.baseRevisionId ? await reads.get(op.baseRevisionId) : null;
    return base
      ? { seq: base.seq, comment: shown ? base.comment : null }
      : { seq: 0, comment: null };
  };
  for (const op of ops) {
    if (op.kind === "create") {
      rendered.push({
        kind: "create" as const,
        table: op.table,
        tempId: op.tempId,
        fields: op.fields as Record<string, unknown>,
        summary: await describeCreate(ctx, op, tempLabels, reads.get),
      });
    } else if (op.kind === "update") {
      const ref = op.ref;
      const { doc, shown, title, latest } = await recordFacts(reads, ref);
      const withheld = doc !== null && !shown;
      rendered.push({
        kind: "update" as const,
        recordType: ref.type,
        recordId: ref.id as string,
        recordTitle: title,
        withheld,
        changes: withheld ? op.changes.map(({ field, after }) => ({ field, after })) : op.changes,
        // The source the op states for the record's text; undefined says nothing.
        citation: op.citation,
        base: await baseOf(op, !withheld),
        stale:
          live &&
          (!doc ||
            doc.status !== "active" ||
            Boolean(doc.locked) ||
            (latest?._id ?? null) !== (op.baseRevisionId ?? null)),
      });
    } else if (op.kind === "clearOverride") {
      const ref = op.ref;
      const { doc, shown, title, latest } = await recordFacts(reads, ref);
      // Who wrote the kept value is read from the whole history, only while it is shown.
      const keptShown = live && (doc === null || shown);
      if (keptShown) await reads.room();
      rendered.push({
        kind: "clearOverride" as const,
        recordType: ref.type,
        recordId: ref.id as string,
        recordTitle: title,
        field: op.field,
        fieldLabel: fieldDescriptor(ref.type, op.field)?.label ?? op.field,
        kept: keptShown
          ? {
              value: doc ? (doc as Record<string, unknown>)[op.field] : undefined,
              writtenBy: writtenBy(await revisionsOf(ctx, ref), op.field),
            }
          : null,
        base: await baseOf(op, doc === null || shown),
        stale:
          live &&
          (!doc ||
            doc.status !== "active" ||
            Boolean(doc.locked) ||
            !(doc.overriddenFields ?? []).includes(op.field) ||
            (latest?._id ?? null) !== (op.baseRevisionId ?? null)),
      });
    } else if (op.kind === "merge") {
      rendered.push({
        kind: "merge" as const,
        summary: `Merge ${await refLabel(reads, op.merged)} into ${await refLabel(reads, op.survivor)}`,
      });
    } else {
      rendered.push({
        kind: op.kind,
        summary: `${OP_VERBS[op.kind]} ${await refLabel(reads, op.ref)}`,
      });
    }
  }
  return rendered;
}

/** How a summary line names each single-record op. */
const OP_VERBS: Record<SingleRecordOp, string> = {
  hide: "Hide",
  restore: "Restore",
  split: "Split out",
  lock: "Lock",
  unlock: "Unlock",
};

/** `type "title"` label for a sensitive-op summary line. */
async function refLabel(reads: ProposalReads, ref: RecordRef): Promise<string> {
  return `${ref.type} "${(await recordFacts(reads, ref)).title}"`;
}

/**
 * Evidence rows with observation references resolved for display
 * (lib/proposalReads.ts `cited`); `reads` is shared by one response's calls.
 */
export async function renderEvidence(rows: Evidence[], reads: ProposalReads) {
  const rendered = [];
  for (const row of rows) {
    if (row.kind === "observation") {
      rendered.push({
        kind: "observation" as const,
        observationId: row.observationId,
        ...(await reads.cited(row.observationId)),
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
 * The most Proposals one queue page may read; each costs a version read and
 * staleness checks, within the response's read budget (lib/proposalReads.ts).
 */
export const REVIEW_PAGE_MAX = 50;

/**
 * One In-Review Proposal's queue facets: its current version, the row both
 * queue queries return (what it touches, who wrote it, its warnings,
 * staleness and claim), and the summary (lib/queueSummary.ts), whose `kind`
 * the filters also read. Null when the Proposal has no submitted version.
 * Staleness reads each record and its newest Revision through the
 * response's `reads`, once however many rows name them.
 */
async function queueRowOf(
  ctx: QueryCtx,
  usernameOf: ReturnType<typeof usernameLookup>,
  proposal: Doc<"proposals">,
  reads: ProposalReads,
) {
  const version = await currentVersionOf(ctx, proposal);
  if (!version) return null;
  return {
    version,
    summary: summarizeVersion(
      version.ops,
      proposal.author,
      version.changeComment,
      version.evidence,
    ),
    row: {
      proposalId: proposal._id as string,
      versionNo: proposal.currentVersionNo,
      comment: version.changeComment,
      opCount: version.ops.length,
      opKinds: opKindsOf(version.ops),
      recordTypes: recordTypesOf(version.ops),
      author: await authorLabelOf(usernameOf, proposal.author),
      warnings: version.warningsAcknowledged ?? [],
      stale: proposal.stale || (await staleRecordsOf(ctx, version.ops, reads)).length > 0,
      claimedBy: await usernameOf(proposal.claimedBy),
      submittedAt: proposal.submittedAt ?? proposal._creationTime,
    },
  };
}

/** A series as a queue row's subject. */
function seriesSubject(series: Doc<"series">, isbn13: string | null = null) {
  return {
    recordType: "series" as RecordType,
    title: series.title,
    page: { entity: "series" as const, publicId: series.publicId },
    isbn13,
    coverUrl: null as string | null,
    mature: series.mature === true,
  };
}

/** Whether any of these Series is a Mature Series. */
async function anyMature(reads: ProposalReads, seriesIds: ReadonlyArray<Id<"series">>) {
  for (const id of seriesIds) {
    if ((await reads.get(id))?.mature === true) return true;
  }
  return false;
}

/**
 * The art a row's jacket may show for a record and whether it is a Mature
 * Series' (the jacket is concealed then): a Release, Variant or Bundle's
 * stored cover and ISBN. Other records have no art, so nothing is read.
 * Records are read through `reads`; a box set's first member and the
 * blob's metadata are the only reads outside it.
 */
async function subjectArt(ctx: QueryCtx, reads: ProposalReads, type: RecordType, doc: CatalogDoc) {
  const none = { isbn13: null as string | null, coverUrl: null as string | null, mature: false };
  if (type === "release") {
    const release = doc as Doc<"releases">;
    return {
      isbn13: release.isbn13 ?? null,
      coverUrl: await coverUrl(ctx, release.coverImage?.storageId),
      mature: await anyMature(reads, release.seriesIds),
    };
  }
  if (type === "releaseVariant") {
    const variant = doc as Doc<"releaseVariants">;
    const release = await reads.get(variant.releaseId);
    return {
      isbn13: release?.isbn13 ?? null,
      coverUrl: await coverUrl(
        ctx,
        variant.coverImage?.storageId ?? release?.coverImage?.storageId,
      ),
      mature: release ? await anyMature(reads, release.seriesIds) : false,
    };
  }
  if (type === "releaseBundle") {
    const bundle = doc as Doc<"releaseBundles">;
    // A box set collects one Series; its first member says which.
    const member = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
      .first();
    const release = member ? await reads.get(member.releaseId) : null;
    return {
      isbn13: bundle.isbn13 ?? null,
      coverUrl: await coverUrl(ctx, bundle.coverImage?.storageId),
      mature: release ? await anyMature(reads, release.seriesIds) : false,
    };
  }
  if (type === "series") return { ...none, mature: (doc as Doc<"series">).mature === true };
  return none;
}

/** The most observation evidence rows one queue subject reads for an 18+ rating. */
const SUBJECT_OBSERVATION_READS = 10;

/**
 * Whether the version's observation evidence rates its book 18+
 * (observationRatesMature). A held book's placement cites the observation
 * that already rates it, while the Series it lands in is not flagged until
 * approval links it. Reads at most SUBJECT_OBSERVATION_READS observations.
 */
async function evidenceRatesMature(reads: ProposalReads, evidence: ReadonlyArray<Evidence>) {
  const ids = evidence
    .flatMap((row) => (row.kind === "observation" ? [row.observationId] : []))
    .slice(0, SUBJECT_OBSERVATION_READS);
  for (const id of ids) {
    const observation = await reads.get(id);
    if (observation && observationRatesMature(observation)) return true;
  }
  return false;
}

/**
 * The record a queue row names (recordSubjectOf), concealed as mature when
 * that record is a Mature Series' or the version's source evidence rates
 * the book 18+, as the Held Books list does for the same observation.
 */
async function queueSubjectOf(
  ctx: QueryCtx,
  version: Doc<"proposalVersions">,
  reads: ProposalReads,
) {
  const subject = await recordSubjectOf(ctx, version, reads);
  if (subject && !subject.mature && (await evidenceRatesMature(reads, version.evidence))) {
    return { ...subject, mature: true };
  }
  return subject;
}

/** A subject named by its type and a label alone: nothing of the record is shown. */
function bareSubject(recordType: RecordType, title: string) {
  return { recordType, title, page: null, isbn13: null, coverUrl: null, mature: false };
}

/**
 * The record a queue row names: the first record an op refers to (a
 * merge's survivor), else the Series a creation adds to (with the new
 * Release's ISBN for its jacket), else the Series a report was filed from.
 * "(missing record)" when that record is gone; null when nothing names one.
 * From `proposalReads(ctx, { publicOnly: true })` (a reader's own
 * Proposals, suggestions.ts) a record the public catalog does not show
 * (lib/publicRecords.ts publiclyVisible) is named NOT_PUBLIC, with no page,
 * ISBN or art.
 */
export async function recordSubjectOf(
  ctx: QueryCtx,
  version: Pick<Doc<"proposalVersions">, "ops" | "evidence">,
  reads: ProposalReads,
) {
  const { ops } = version;
  const refOp = ops.find((op) => op.kind === "merge" || "ref" in op);
  const ref = refOp?.kind === "merge" ? refOp.survivor : refOp && "ref" in refOp ? refOp.ref : null;
  if (ref) {
    const doc = await reads.doc(ref);
    if (!doc) return bareSubject(ref.type, "(missing record)");
    if (!(await reads.shown(ref))) return bareSubject(ref.type, NOT_PUBLIC);
    const { title, backLink } = await reads.display(ref);
    // A box set's member and the blob's metadata, read outside `reads`, are one more read.
    await reads.room();
    return {
      recordType: ref.type,
      title,
      page: backLink ? { entity: backLink.entity, publicId: backLink.publicId } : null,
      ...(await subjectArt(ctx, reads, ref.type, doc)),
    };
  }
  const creates = ops.filter((op): op is CreateOpInput => op.kind === "create");
  if (creates.length > 0) {
    const field = (op: CreateOpInput, name: string): unknown =>
      (op.fields as Record<string, unknown> | undefined)?.[name];
    const isbn = creates
      .map((op) => field(op, "isbn13"))
      .find((value) => typeof value === "string");
    const isbn13 = typeof isbn === "string" ? isbn : null;
    for (const op of creates) {
      const raw = field(op, "seriesId");
      const id = typeof raw === "string" ? ctx.db.normalizeId("series", raw) : null;
      const series = id ? await reads.get(id) : null;
      if (!id || !series) continue;
      if (!(await reads.shown({ type: "series", id }))) return bareSubject("series", NOT_PUBLIC);
      return seriesSubject(series, isbn13);
    }
    const newSeries = creates.find((op) => op.table === "series");
    if (newSeries) {
      return {
        recordType: "series" as RecordType,
        title: String(field(newSeries, "title") ?? "New series"),
        page: null,
        isbn13,
        coverUrl: null,
        mature: false,
      };
    }
    return null;
  }
  const publicId = reportSeriesPublicId(version.evidence);
  if (publicId === null) return null;
  const series = await ctx.db
    .query("series")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  if (!series) return null;
  if (!(await reads.shown({ type: "series", id: series._id }))) {
    return bareSubject("series", NOT_PUBLIC);
  }
  return seriesSubject(series);
}

/** The filters both queue queries take (lib/queueSummary.ts QueueFilters). */
const queueFilterArgs = {
  operation: v.optional(v.string()),
  recordType: v.optional(v.string()),
  authorKind: v.optional(v.union(v.literal("imports"), v.literal("humans"))),
  author: v.optional(v.string()),
  staleOnly: v.optional(v.boolean()),
  warningsOnly: v.optional(v.boolean()),
  minAgeHours: v.optional(v.number()),
};

/** The comment a legacy queue row past the read budget carries in place of its own. */
export const NOT_LOADED_COMMENT =
  "Not loaded: too much to read with the rest of the queue. Open it to review it.";

/** How many In-Review proposals the legacy queue scans, oldest first. */
export const LEGACY_QUEUE_MAX = 1000;

/**
 * The oldest In-Review proposals, oldest first, with the facets the queue filters
 * on and its age in `ageMs`, filtered with the same rules as
 * reviewQueuePage. Data-Team-visible only. This is the contract clients
 * built before the paged queue still call, kept with its arguments and
 * array result so a Worker or open tab older than the Convex deploy keeps
 * working; it reads the oldest LEGACY_QUEUE_MAX In-Review proposals, so a
 * backlog of reports or Suggestions cannot make the scan itself fail. The
 * site calls reviewQueuePage. Remove this once no deployed client calls it.
 * Rows share one read of each record within the read budget
 * (lib/proposalReads.ts), as reviewQueuePage's do. Past it, every
 * remaining Proposal is listed unfiltered in the same row shape, with
 * `notLoaded: true`, NOT_LOADED_COMMENT for its comment and no ops, so
 * an old client shows it and links to its page instead of the query
 * failing.
 */
export const reviewQueue = query({
  args: queueFilterArgs,
  handler: async (ctx, args) => {
    await requireDataTeam(ctx);
    const proposals = await ctx.db
      .query("proposals")
      .withIndex("by_state", (q) => q.eq("state", "inReview"))
      .order("asc")
      .take(LEGACY_QUEUE_MAX);

    const usernameOf = usernameLookup(ctx);
    const reads = proposalReads(ctx, { budgeted: true });
    const now = Date.now();
    const rows = [];
    for (const proposal of proposals) {
      const found = await loaded(async () => {
        await reads.room();
        return await queueRowOf(ctx, usernameOf, proposal, reads);
      }, "notLoaded" as const);
      if (found === "notLoaded") {
        const submittedAt = proposal.submittedAt ?? proposal._creationTime;
        rows.push({
          proposalId: proposal._id as string,
          versionNo: proposal.currentVersionNo,
          comment: NOT_LOADED_COMMENT,
          opCount: 0,
          opKinds: [],
          recordTypes: [],
          author: await authorLabelOf(usernameOf, proposal.author),
          warnings: [],
          stale: Boolean(proposal.stale),
          claimedBy: await usernameOf(proposal.claimedBy),
          submittedAt,
          ageMs: now - submittedAt,
          notLoaded: true,
        });
        continue;
      }
      if (!found) continue;
      if (!matchesQueueFilters({ ...found.row, kind: found.summary.kind }, { ...args, now })) {
        continue;
      }
      rows.push({ ...found.row, ageMs: now - found.row.submittedAt, notLoaded: false });
    }
    return rows;
  },
});

/**
 * The shared review queue, one page at a time: In-Review Proposals, oldest
 * submission first, Data-Team-visible only. Every Proposal the page reads
 * is returned: one that passes the filters (lib/queueSummary.ts
 * matchesQueueFilters) as a full row with its subject and summary, any
 * other as `{ matches: false }`, so the page can say how many it checked
 * and nothing is dropped unseen. Pages hold at most REVIEW_PAGE_MAX. Rows
 * share one read of each record (lib/proposalReads.ts); once the response
 * is near a read limit, the rest of the page is returned as `{ notLoaded:
 * true }`, which the page lists for opening one by one. `minAgeHours`
 * measures from the client's `now` (queries never read the clock). Claims
 * are shown so reviewers coordinate without exclusive authority.
 */
export const reviewQueuePage = query({
  args: {
    ...queueFilterArgs,
    paginationOpts: paginationOptsValidator,
    kind: v.optional(queueKind),
    now: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, ...filters }) => {
    await requireDataTeam(ctx);
    if (paginationOpts.numItems > REVIEW_PAGE_MAX) {
      fail("pageTooLarge", `Ask for at most ${REVIEW_PAGE_MAX} proposals a page.`);
    }
    if (filters.minAgeHours !== undefined && filters.now === undefined) {
      fail("nowRequired", "Filtering by age needs the current time.");
    }
    const result = await queueScan(ctx, filters).order("asc").paginate(paginationOpts);

    const usernameOf = usernameLookup(ctx);
    const reads = proposalReads(ctx, { budgeted: true });
    const page = [];
    for (const proposal of result.page) {
      const proposalId = proposal._id as string;
      const row = async () => {
        await reads.room();
        const found = await queueRowOf(ctx, usernameOf, proposal, reads);
        if (!found || !matchesQueueFilters({ ...found.row, kind: found.summary.kind }, filters)) {
          return { proposalId, matches: false as const };
        }
        return {
          ...found.row,
          kind: found.summary.kind,
          summary: found.summary,
          matches: true as const,
          subject: await queueSubjectOf(ctx, found.version, reads),
        };
      };
      page.push(
        await loaded(row, { proposalId, matches: false as const, notLoaded: true as const }),
      );
    }
    return { ...result, page };
  },
});

/**
 * The In-Review proposals a queue view can match, by the narrowest index
 * its filters allow: a reader's Suggestions, a person's proposals (reports,
 * field changes, new records, the People view) or a source's. So a view of
 * a few rows is not paged out behind every older import offer; the row
 * filters still decide what matches.
 */
function queueScan(
  ctx: QueryCtx,
  filters: { kind?: QueueKind; authorKind?: "imports" | "humans" },
) {
  const proposals = ctx.db.query("proposals");
  if (filters.kind === "suggestion") {
    return proposals.withIndex("by_state_and_author_role", (q) =>
      q.eq("state", "inReview").eq("author.kind", "user").eq("author.roleAtAuthorship", undefined),
    );
  }
  const source =
    filters.kind === "importOffer" ||
    filters.kind === "importCreation" ||
    filters.authorKind === "imports";
  const person =
    filters.kind === "report" ||
    filters.kind === "fieldChange" ||
    filters.kind === "newRecords" ||
    filters.authorKind === "humans";
  if (source !== person) {
    return proposals.withIndex("by_state_and_author_kind", (q) =>
      q.eq("state", "inReview").eq("author.kind", source ? "source" : "user"),
    );
  }
  return proposals.withIndex("by_state", (q) => q.eq("state", "inReview"));
}

/** A Proposal's newest VERSIONS_SHOWN versions, newest first. */
export async function newestVersions(ctx: QueryCtx, proposalId: Id<"proposals">) {
  return await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
    .order("desc")
    .take(VERSIONS_SHOWN);
}

/**
 * `versions` (newest first) as a proposal page lists them, oldest first:
 * the newest CHANGES_SHOWN with `content` from `render`, read newest
 * first, or "notLoaded" once the response's read budget is spent
 * (lib/proposalReads.ts); older ones "older".
 */
export async function versionViews<Content>(
  versions: ReadonlyArray<Doc<"proposalVersions">>,
  currentVersionNo: number,
  render: (version: Doc<"proposalVersions">) => Promise<Content>,
) {
  const views = [];
  for (const [i, version] of versions.entries()) {
    views.push({
      versionNo: version.versionNo,
      current: version.versionNo === currentVersionNo,
      changeComment: version.changeComment,
      warnings: version.warningsAcknowledged ?? [],
      submittedAt: version._creationTime,
      opCount: version.ops.length,
      content:
        i < CHANGES_SHOWN
          ? await loaded(() => render(version), "notLoaded" as const)
          : ("older" as const),
    });
  }
  return views.reverse();
}

type ShownChange = { field: string; before?: unknown; after?: unknown };

/** The field changes a page's Draft and versions show, for drawing their cover art. */
export function shownChanges(
  views: ReadonlyArray<{
    content:
      | { ops: ReadonlyArray<{ kind: string; changes?: ReadonlyArray<ShownChange> }> }
      | "notLoaded"
      | "older";
  }>,
) {
  return views.flatMap(({ content }) =>
    typeof content === "string" ? [] : content.ops.flatMap((op) => op.changes ?? []),
  );
}

/**
 * Everything the review page needs (Data-Team-only): the proposal's state
 * and people, the internal discussion, its newest VERSIONS_SHOWN immutable
 * versions and the current Draft working copy. The Draft and the newest
 * CHANGES_SHOWN versions carry rendered ops (grouped before/after, base
 * Revisions, staleness) with their evidence; older ones only what
 * versionViews keeps. The current version is always among them; versions
 * are numbered from 1, so `currentVersionNo` says how many there are. A
 * reader resubmits without a Moderator, so what is rendered is bounded:
 * each record, Revision and observation is read once for the page, and
 * past the read budget (lib/proposalReads.ts) a Draft or version is
 * "notLoaded". The discussion, staleness and placement are read first.
 */
export const proposalDetail = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const viewer = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) return null;

    const usernameOf = usernameLookup(ctx);
    const reads = proposalReads(ctx, { budgeted: true });
    const versions = await newestVersions(ctx, proposal._id);
    const current = versions.find((version) => version.versionNo === proposal.currentVersionNo);

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
        author: await usernameOf(note.authorId),
        at: note._creationTime,
      });
    }

    // A placement whose source now names another book than its author
    // reviewed is stale too: approval refuses it (placement.ts).
    const stale =
      proposal.state === "inReview" && current
        ? await loaded(
            async () =>
              (await staleRecordsOf(ctx, current.ops, reads)).length > 0 ||
              (await placementChanged(ctx, current.ops)),
            Boolean(proposal.stale),
          )
        : Boolean(proposal.stale);
    // A held book's placement (placement.ts): the Draft's, else the current version's.
    const placement = await placementView(ctx, proposal.draft?.ops ?? current?.ops ?? []);

    const undecided = proposal.state === "draft" || proposal.state === "inReview";
    const render = async (ops: StoredOp[], evidence: Evidence[], live: boolean) => ({
      ops: await renderOps(ctx, ops, live, reads),
      evidence: await renderEvidence(evidence, reads),
    });
    const working = proposal.draft;
    const draft = working
      ? {
          comment: working.comment,
          warnings: computeWarnings(working.ops),
          opCount: working.ops.length,
          content: await loaded(
            () => render(working.ops, working.evidence, undecided),
            "notLoaded" as const,
          ),
        }
      : null;
    const renderedVersions = await versionViews(versions, proposal.currentVersionNo, (version) =>
      render(version.ops, version.evidence, undecided && version.versionNo === current?.versionNo),
    );

    return {
      proposalId: proposal._id as string,
      state: proposal.state,
      stale,
      author: await authorLabelOf(usernameOf, proposal.author),
      claimedBy: await usernameOf(proposal.claimedBy),
      submittedAt: proposal.submittedAt ?? null,
      decidedAt: proposal.decidedAt ?? null,
      decidedBy: await usernameOf(proposal.decidedBy),
      currentVersionNo: proposal.currentVersionNo,
      versions: renderedVersions,
      draft,
      notes: renderedNotes,
      coverArt: await coverArtOf(
        ctx,
        shownChanges([...renderedVersions, ...(draft ? [draft] : [])]),
      ),
      placement,
      viewer: {
        isAuthor: proposal.author.kind === "user" && proposal.author.userId === viewer._id,
        canReview: viewer.role === "moderator" || viewer.role === "administrator",
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
      const comment = version?.changeComment ?? proposal.draft?.comment ?? "";
      rows.push({
        proposalId: proposal._id as string,
        state: proposal.state,
        stale: Boolean(proposal.stale),
        comment,
        opCount: ops.length,
        recordTypes: recordTypesOf(ops),
        // What the queue row says; no reads (lib/queueSummary.ts).
        summary: summarizeVersion(
          ops,
          proposal.author,
          comment,
          version?.evidence ?? proposal.draft?.evidence ?? [],
        ),
        updatedAt: proposal.decidedAt ?? proposal.submittedAt ?? proposal._creationTime,
      });
    }
    return rows;
  },
});
