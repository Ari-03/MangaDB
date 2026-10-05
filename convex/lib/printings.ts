// Other Printings (CONTEXT.md): the one write that records a book as
// another printing of a Release. A person, or an agent whose decision a
// reviewer checked, decides it (printings.recordDecidedInternal checks the
// invariants first); no importer records one on its own. Once recorded,
// the printing's ISBN finds the Release for readers and for the matching
// ladder (lib/releaseIsbns.ts), so a later sync of that book links to the
// Release, marked as the printing's record, and offers it nothing.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { linkObservation } from "./observations";
import { insertSourceProposal } from "./reconcile";

type PartialDate = NonNullable<Doc<"releaseIsbns">["pubDate"]>;

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
  args: {
    release: Doc<"releases">;
    isbn13: string;
    pubDate?: PartialDate;
    reason: string;
    sourceKey: string;
    observationId: Id<"sourceObservations">;
    citation: { sourceName: string; url: string };
    now: number;
  },
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
  const ref = { type: "release" as const, id: release._id };
  const latest = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", release._id))
    .order("desc")
    .first();
  const changes = [
    {
      field: "otherPrinting",
      after: `ISBN ${isbn13}${pubDate !== undefined ? `, ${pubDate.year}` : ""}`,
    },
  ];
  await insertSourceProposal(ctx, {
    sourceKey: args.sourceKey,
    state: "approved",
    ops: [{ kind: "update", ref, baseRevisionId: latest?._id, changes }],
    evidence: [args.observationId],
    comment: `Recorded from ${args.citation.sourceName} as another printing. ${args.reason}`,
    now: args.now,
    citation: args.citation,
    revisions: [{ ref, seq: (latest?.seq ?? 0) + 1, changes }],
  });
  await linkObservation(ctx, args.observationId, { type: "release", id: release._id });
}
