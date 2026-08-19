// Authority conflict rules (ticket #35, spec §6): pure decisions about what
// an import may do when a source's observed value disagrees with the
// canonical one. The registry's per-field authority map is the input —
// rules stay data-driven, so a registry edit ("rules change") re-routes the
// very next reconciliation with no code change.
//
// The conflict table, verbatim from the spec:
// - auto-update only from strictly higher authority;
// - equal-authority disagreement queues a Proposal;
// - lower-authority disagreement is recorded on the observation only;
// - a more precise consistent date auto-refines at equal-or-higher
//   authority; less precise never replaces more precise;
// - Human Overrides are sticky: a conflicting import queues, never
//   overwrites.
//
// Two deliberate extensions where the table is silent:
// - A source revising its OWN previously imported fact is not a
//   cross-source disagreement — it auto-updates (a rename at the source is
//   a field conflict that resolves in the source's favor on its own scope).
// - Filling a field that has no canonical value is not a disagreement —
//   any source with authority over the field may fill it (how OpenLibrary's
//   ISBN fill works in seeding stage ④).

import { sameValue } from "./values";

export type AuthorityLevel = "authoritative" | "standard" | "weak";

const RANK: Record<AuthorityLevel, number> = {
  authoritative: 3,
  standard: 2,
  weak: 1,
};

// Canonical field → authority-table column ("category"). Fields without a
// category can never be auto-written by an import (the table's "—" cells).
export const FIELD_CATEGORY: Record<string, string> = {
  pubDate: "date",
  isbn13: "isbn",
  isbn10: "isbn",
  title: "titles",
  altTitles: "titles",
  label: "titles",
  name: "titles",
  linePosition: "titles",
  creators: "creators",
  format: "format",
  binding: "format",
  price: "price",
};

/**
 * A source's authority rank for one canonical field, per its registry row's
 * live fieldAuthority map. 0 = no authority (unknown source, unknown field,
 * or an explicit "—" cell): such a source never writes the field.
 */
export function authorityRank(
  fieldAuthority: Record<string, AuthorityLevel> | undefined,
  field: string,
): number {
  const category = FIELD_CATEGORY[field];
  if (category === undefined || fieldAuthority === undefined) return 0;
  const level = fieldAuthority[category];
  return level === undefined ? 0 : RANK[level];
}

// ---------- partial-date precision (spec §6 refinement rule) ----------

export type PartialDateValue = {
  year: number;
  month?: number;
  day?: number;
  sort?: number;
};

function isPartialDate(value: unknown): value is PartialDateValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PartialDateValue).year === "number"
  );
}

/** 1 = year only, 2 = year+month, 3 = full date. */
export function datePrecision(date: PartialDateValue): number {
  if (date.day !== undefined) return 3;
  if (date.month !== undefined) return 2;
  return 1;
}

/** Do two partial dates agree on every part they both specify? */
export function datesConsistent(
  a: PartialDateValue,
  b: PartialDateValue,
): boolean {
  if (a.year !== b.year) return false;
  if (a.month !== undefined && b.month !== undefined && a.month !== b.month) {
    return false;
  }
  if (a.day !== undefined && b.day !== undefined && a.day !== b.day) {
    return false;
  }
  return true;
}

// ---------- the decision ----------

/** Who authored the field's current canonical value. */
export type Incumbent =
  // No revision touched the field and there is no current value: a fill.
  | { kind: "none" }
  // A value exists but predates revision history — treated like a human's.
  | { kind: "unattributed" }
  | { kind: "human" }
  | { kind: "source"; sourceKey: string; rank: number };

export type FieldDecision = {
  action: "auto" | "queue" | "recordOnly" | "skip";
  reason: string;
};

const auto = (reason: string): FieldDecision => ({ action: "auto", reason });
const queue = (reason: string): FieldDecision => ({ action: "queue", reason });
const recordOnly = (reason: string): FieldDecision => ({
  action: "recordOnly",
  reason,
});
const skip = (reason: string): FieldDecision => ({ action: "skip", reason });

/**
 * Decide what one offered field value may do to the canonical record.
 * Pure: the caller resolves the incumbent (latest Revision touching the
 * field) and both authority ranks from the live registry.
 */
export function decideField(args: {
  field: string;
  current: unknown;
  offered: unknown;
  /** Is the field on the record's sticky overriddenFields list? */
  overridden: boolean;
  incomingSourceKey: string;
  incomingRank: number;
  incumbent: Incumbent;
}): FieldDecision {
  const { current, offered, incumbent, incomingRank } = args;

  if (sameValue(current, offered)) return skip("value already matches");

  // Human Overrides stay sticky (spec §4): report, never overwrite — at any
  // authority. Only an explicit Moderator clearOverride lifts the override.
  if (args.overridden) {
    return queue("the field carries a sticky Human Override");
  }

  // A source with no authority over the field never writes it.
  if (incomingRank <= 0) {
    return recordOnly("the source has no authority for this field");
  }

  // Filling an empty field is not a disagreement.
  if (current === undefined && incumbent.kind === "none") {
    return auto("fills a field with no canonical value");
  }

  // Date precision (spec §6). Consistent + less precise never replaces more
  // precise — not even a conflict worth queueing. Consistent + more precise
  // auto-refines at equal-or-higher authority. Inconsistent dates fall
  // through to the general rules.
  if (
    args.field === "pubDate" &&
    isPartialDate(current) &&
    isPartialDate(offered) &&
    datesConsistent(current, offered)
  ) {
    const delta = datePrecision(offered) - datePrecision(current);
    if (delta <= 0) {
      return skip("less precise never replaces more precise");
    }
    if (incumbent.kind === "source") {
      if (
        incumbent.sourceKey === args.incomingSourceKey ||
        incomingRank >= incumbent.rank
      ) {
        return auto("consistent more-precise date at equal-or-higher authority");
      }
      return recordOnly("more precise, but from a lower authority");
    }
    // Human-authored (or unattributed) dates: refinement still needs a human.
    return queue("would refine a human-authored date");
  }

  // Human-authored values that are not (yet) marked overridden — records a
  // human created outright, or history that predates override tracking —
  // still never lose to an import silently.
  if (incumbent.kind === "human" || incumbent.kind === "unattributed") {
    return queue("the current value is human-authored");
  }
  if (incumbent.kind === "none") {
    // A revision never touched the field but a value exists (creation
    // predates history): treat like unattributed.
    return queue("the current value has no recorded provenance");
  }

  // Source vs source: the conflict table proper.
  if (incumbent.sourceKey === args.incomingSourceKey) {
    return auto("the source updated its own fact");
  }
  if (incomingRank > incumbent.rank) {
    return auto("strictly higher authority than the current value's source");
  }
  if (incomingRank === incumbent.rank) {
    return queue("equal authority disagreement");
  }
  return recordOnly("lower authority than the current value's source");
}
