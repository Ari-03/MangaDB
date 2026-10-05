// Other Printings (CONTEXT.md): the writes that record a book as another
// printing of a Release, or link one more record of a printing already
// recorded. A person, or an agent whose decision a reviewer checked,
// decides either (printings.recordDecidedInternal checks the invariants
// first); no importer records one on its own. Once recorded, the
// printing's ISBN finds the Release for readers and for the matching
// ladder (lib/releaseIsbns.ts), so a later sync of that book links to the
// Release, marked as the printing's record, and offers it nothing.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { linkObservation } from "./observations";
import { insertSourceProposal } from "./reconcile";
import { printingLinkAudit, recordName } from "./releaseIsbns";

type PartialDate = NonNullable<Doc<"releaseIsbns">["pubDate"]>;

/** Who decided, why, and what the Revision cites. */
type Decision = {
  release: Doc<"releases">;
  isbn13: string;
  reason: string;
  sourceKey: string;
  observationId: Id<"sourceObservations">;
  citation: { sourceName: string; url: string };
  now: number;
};

/** One approved Proposal by the record's source, with one Revision on the Release. */
async function auditDecision(
  ctx: MutationCtx,
  args: Decision,
  change: { field: string; after: string },
  comment: string,
): Promise<Id<"proposals">> {
  const ref = { type: "release" as const, id: args.release._id };
  const latest = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", args.release._id))
    .order("desc")
    .first();
  const changes = [change];
  const { proposalId } = await insertSourceProposal(ctx, {
    sourceKey: args.sourceKey,
    state: "approved",
    ops: [{ kind: "update", ref, baseRevisionId: latest?._id, changes }],
    evidence: [args.observationId],
    comment: `${comment} ${args.reason}`,
    now: args.now,
    citation: args.citation,
    revisions: [{ ref, seq: (latest?.seq ?? 0) + 1, changes }],
  });
  return proposalId;
}

/**
 * Record ISBN `isbn13` (published `pubDate`) as another printing of
 * `release` and link the book's observation to the Release, which marks it
 * as that printing's record and takes the book off the Held Books list
 * (linkObservation). Every call writes the ISBN row and one approved
 * Proposal authored by the record's source, with a public Revision on the
 * Release that carries `reason` and cites `citation`, so every link it makes
 * has its own audit. An ISBN already recorded, on any Release, throws a
 * `conflict` before anything is written or linked. Nothing else on the
 * Release changes: its own ISBN, date, price, blurb and cover stay its
 * printing's (reconcileFields offers a marked record's facts nothing). The
 * caller checks that the book may be recorded.
 */
export async function recordPrinting(
  ctx: MutationCtx,
  args: Decision & { pubDate?: PartialDate },
): Promise<void> {
  const { release, isbn13, pubDate } = args;
  const existing = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .first();
  if (existing !== null) {
    fail("conflict", `ISBN ${isbn13} is already recorded as a printing; nothing was recorded.`);
  }
  await ctx.db.insert("releaseIsbns", {
    releaseId: release._id,
    isbn13,
    ...(pubDate !== undefined ? { pubDate } : {}),
    reason: args.reason,
    sourceKey: args.sourceKey,
    observationId: args.observationId,
  });
  await auditDecision(
    ctx,
    args,
    {
      field: "otherPrinting",
      after: `ISBN ${isbn13}${pubDate !== undefined ? `, ${pubDate.year}` : ""}`,
    },
    `Recorded from ${args.citation.sourceName} as another printing.`,
  );
  await linkObservation(ctx, args.observationId, { type: "release", id: release._id });
}

/**
 * Link one more record of a printing `release` already has a row for: the
 * link marks it and clears its hold (linkObservation), with one approved
 * Proposal by the record's source and a `sourceObservation` Revision on the
 * Release (printingLinkAudit) carrying `reason` and citing `citation`. No
 * row is written. Throws `conflict` before writing anything unless the row
 * is the Release's and the record is unlinked. The caller checks that the
 * record may be linked.
 */
export async function linkRecordedPrinting(
  ctx: MutationCtx,
  args: Decision,
): Promise<Id<"proposals">> {
  const { release, isbn13 } = args;
  const row = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .first();
  const observation = await ctx.db.get(args.observationId);
  if (row?.releaseId !== release._id || observation === null || observation.recordRef) {
    fail("conflict", `ISBN ${isbn13} is not a recorded printing this record can be linked to.`);
  }
  const proposalId = await auditDecision(
    ctx,
    args,
    { field: "sourceObservation", after: printingLinkAudit(recordName(observation), isbn13) },
    `Linked from ${args.citation.sourceName} as a record of another printing.`,
  );
  await linkObservation(ctx, args.observationId, { type: "release", id: release._id });
  return proposalId;
}
