// What a review-queue row says about a Proposal before anyone opens it
// (proposals.reviewQueuePage, proposals.myProposals; the legacy
// proposals.reviewQueue filters with it too): its kind, the first few
// field changes with labels, what it creates or clears, and for a reader's
// report the message itself. Pure functions of the stored version, so they
// cost no reads and the queue filters on `kind` beside the other facets.
// The stored change comment is untouched (versions are immutable); the
// proposal page still shows it in full.

import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { CREATABLE_TABLES } from "./proposalCreates";
import { fieldDescriptor, type RecordType } from "./moderationFields";

type StoredOp = Doc<"proposalVersions">["ops"][number];
type Evidence = Doc<"proposalVersions">["evidence"][number];
type Author = Doc<"proposals">["author"];

/** A queue kind, as the queue's `kind` filter takes it. */
export const queueKind = v.union(
  v.literal("importOffer"),
  v.literal("importCreation"),
  v.literal("fieldChange"),
  v.literal("newRecords"),
  v.literal("sensitive"),
  v.literal("report"),
  v.literal("suggestion"),
);

export type QueueKind = Infer<typeof queueKind>;

/** Every queue kind, in the order the queue's Kind filter lists them. */
export const QUEUE_KINDS: readonly QueueKind[] = queueKind.members.map((member) => member.value);

/** The ops that change a record's standing rather than its fields. */
const SENSITIVE_OPS = new Set<StoredOp["kind"]>([
  "merge",
  "split",
  "hide",
  "restore",
  "lock",
  "unlock",
]);

/**
 * A Proposal's kind: any merge, split, hide, restore, lock or unlock is
 * `sensitive`; a source's creation is `importCreation` and its field offer
 * `importOffer`; a person's Proposal with no ops is a reader's `report`
 * (reports.submit); one written by a person holding no data-team role is
 * a reader's `suggestion` (proposals.saveDraft); a person's creation is
 * `newRecords`; the rest is `fieldChange`.
 */
export function queueKindOf(ops: readonly StoredOp[], author: Author): QueueKind {
  if (ops.some((op) => SENSITIVE_OPS.has(op.kind))) return "sensitive";
  const creates = ops.some((op) => op.kind === "create");
  if (author.kind === "source") return creates ? "importCreation" : "importOffer";
  if (ops.length === 0) return "report";
  if (author.roleAtAuthorship === undefined) return "suggestion";
  return creates ? "newRecords" : "fieldChange";
}

/** How many changed fields a row names before "and N more". */
export const SUMMARY_FIELDS = 3;

export type QueueSummary = {
  kind: QueueKind;
  /** The first update op's changes, labelled, at most SUMMARY_FIELDS. */
  fields: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  /** Changes past `fields`, across every update op. */
  moreFields: number;
  /** Record types the create ops make, deduped, in op order. */
  creates: RecordType[];
  /** Field labels whose Human Override a clearOverride op lifts. */
  clears: string[];
  /** The sensitive ops (merge, hide, lock…), deduped, in op order. */
  actions: Array<StoredOp["kind"]>;
  /** A report's message without its `[Report] Title:` prefix; null otherwise. */
  report: string | null;
};

/**
 * The row summary of one version: `ops` and `author` decide the kind,
 * `comment` and `evidence` give a report its message.
 */
export function summarizeVersion(
  ops: readonly StoredOp[],
  author: Author,
  comment: string,
  evidence: readonly Evidence[],
): QueueSummary {
  const kind = queueKindOf(ops, author);
  const updates = ops.filter(
    (op): op is Extract<StoredOp, { kind: "update" }> => op.kind === "update",
  );
  const first = updates[0];
  const fields = (first?.changes ?? []).slice(0, SUMMARY_FIELDS).map((change) => ({
    field: change.field,
    label: fieldDescriptor(first!.ref.type, change.field)?.label ?? change.field,
    before: change.before,
    after: change.after,
  }));
  const changeCount = updates.reduce((sum, op) => sum + op.changes.length, 0);
  const creates: RecordType[] = [];
  for (const op of ops) {
    if (op.kind !== "create") continue;
    const type = CREATABLE_TABLES[op.table as keyof typeof CREATABLE_TABLES];
    if (type && !creates.includes(type)) creates.push(type);
  }
  const clears = ops.flatMap((op) =>
    op.kind === "clearOverride" ? [fieldDescriptor(op.ref.type, op.field)?.label ?? op.field] : [],
  );
  const actions: Array<StoredOp["kind"]> = [];
  for (const op of ops) {
    if (SENSITIVE_OPS.has(op.kind) && !actions.includes(op.kind)) actions.push(op.kind);
  }
  return {
    kind,
    fields,
    moreFields: changeCount - fields.length,
    creates,
    clears,
    actions,
    report: kind === "report" ? reportMessage(comment, evidence) : null,
  };
}

/** The note reports.submit writes beside a report's Series page link. */
const REPORT_NOTE = /^Reported from the Series page: (.*)$/s;

/** The Series page a report was filed from (`/series/{publicId}`), or null. */
export function reportSeriesPublicId(evidence: readonly Evidence[]): number | null {
  for (const row of evidence) {
    if (row.kind !== "url") continue;
    const match = /^\/series\/(\d+)$/.exec(row.url);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * A report's message: its comment without the `[Report] {title}: ` prefix
 * reports.submit wrote. The title is read from the evidence note, since
 * the Series may have been renamed since and a title can hold ": ".
 */
export function reportMessage(comment: string, evidence: readonly Evidence[]): string {
  for (const row of evidence) {
    const title = row.kind === "url" ? REPORT_NOTE.exec(row.note ?? "")?.[1] : undefined;
    const prefix = title === undefined ? null : `[Report] ${title}: `;
    if (prefix !== null && comment.startsWith(prefix)) return comment.slice(prefix.length);
  }
  return comment.replace(/^\[Report\]\s*/, "");
}

/**
 * The queue's filters, as proposals.reviewQueuePage takes them. The legacy
 * proposals.reviewQueue takes all but `kind` and passes its own clock as
 * `now`.
 */
export type QueueFilters = {
  operation?: string;
  recordType?: string;
  kind?: QueueKind;
  authorKind?: "imports" | "humans";
  author?: string;
  staleOnly?: boolean;
  warningsOnly?: boolean;
  /** Only Proposals submitted at least this long before `now`. */
  minAgeHours?: number;
  /** The client's clock, required with `minAgeHours`. */
  now?: number;
};

/** The facets of one queue row that its filters read. */
export type QueueFacets = {
  opKinds: readonly string[];
  recordTypes: readonly string[];
  kind: QueueKind;
  author: { kind: "user"; username: string | null } | { kind: "source"; sourceKey: string };
  stale: boolean;
  warnings: readonly unknown[];
  submittedAt: number;
};

/** Whether a row passes every filter that is set. */
export function matchesQueueFilters(row: QueueFacets, filters: QueueFilters): boolean {
  if (filters.operation && !row.opKinds.includes(filters.operation)) return false;
  if (filters.recordType && !row.recordTypes.includes(filters.recordType)) return false;
  if (filters.kind && row.kind !== filters.kind) return false;
  if (filters.authorKind === "imports" && row.author.kind !== "source") return false;
  if (filters.authorKind === "humans" && row.author.kind !== "user") return false;
  if (filters.author) {
    const name = row.author.kind === "user" ? row.author.username : row.author.sourceKey;
    if (name !== filters.author) return false;
  }
  if (filters.staleOnly && !row.stale) return false;
  if (filters.warningsOnly && row.warnings.length === 0) return false;
  if (filters.minAgeHours !== undefined && filters.now !== undefined) {
    if (filters.now - row.submittedAt < filters.minAgeHours * 60 * 60 * 1000) return false;
  }
  return true;
}
