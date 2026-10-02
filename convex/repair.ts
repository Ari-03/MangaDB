// One-time catalog data repair (the six-lane audit, 2026-09). Operator-only
// internal functions, driven by scripts/repair.ts from repair-plan.json:
//
//   npx convex run repair:runBatch '{"dryRun":true,"actor":"ari","entries":[…]}'
//
// runBatch applies each entry in its own sub-transaction (ctx.runMutation),
// so one failing or drifted entry rolls back alone and is reported. A dry
// run applies the entry for real and then throws, rolling the writes back:
// the report is exactly what the real run would do against the current data.
// An entry with more to do than one call should (a chunked publisher merge,
// a split's or box set's personal rows past lib/repair/ops.ts SWEEP_BUDGET)
// reports "partial", and scripts/repair.ts calls it again until it is not.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { createAudit, resolveActor } from "./lib/repair/audit";
import { outcome, repairEntry, type Outcome, type RepairEntry } from "./lib/repair/entries";
import { applyEntry } from "./lib/repair/ops";

/** Evidence stored on each repair Proposal: its source observations, else a plan note. */
function evidenceFor(entry: RepairEntry) {
  const note = { kind: "note" as const, text: `One-time data repair plan entry ${entry.key}` };
  switch (entry.kind) {
    case "unlinkObservation":
      return [{ kind: "observation" as const, observationId: entry.observationId }, note];
    case "editionPublisher":
    case "splitSeries":
      return [...entry.observationIds.map((observationId) => ({ kind: "observation" as const, observationId })), note];
    case "updateFields":
      return entry.evidenceObservationId
        ? [{ kind: "observation" as const, observationId: entry.evidenceObservationId }, note]
        : [note];
    case "createRelease":
      return [...entry.sources.map((url) => ({ kind: "url" as const, url })), note];
    default:
      return [note];
  }
}

/** Apply one entry. Internal to runBatch: always called as a sub-transaction. */
export const applyOne = internalMutation({
  args: { entry: repairEntry, dryRun: v.boolean(), actor: v.string() },
  returns: outcome,
  handler: async (ctx, { entry, dryRun, actor }) => {
    const audit = createAudit(ctx, await resolveActor(ctx, actor), `Data repair: ${entry.reason}`, evidenceFor(entry));
    const result = await applyEntry(ctx, audit, entry);
    await audit.finish();
    const reported: Outcome = {
      key: entry.key,
      ...result,
      ...(audit.notes.length > 0 ? { notes: audit.notes } : {}),
    };
    // Throwing rolls this sub-transaction back; runBatch reads the outcome.
    // Any write counts, not just audited ones: some ops (withdrawing a stale
    // Proposal) touch no catalog record and so leave no audit trail.
    if (dryRun && (audit.wrote || result.status === "applied" || result.status === "partial")) {
      throw new ConvexError({ dryRun: reported });
    }
    return reported;
  },
});

type ErrorData = { dryRun?: Outcome; skip?: string };

function errorData(error: unknown): ErrorData | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  return typeof data === "object" && data !== null ? (data as ErrorData) : null;
}

/** Apply (or dry-run) a batch of plan entries; one outcome per entry. */
export const runBatch = internalMutation({
  args: { entries: v.array(repairEntry), dryRun: v.boolean(), actor: v.string() },
  returns: v.array(outcome),
  handler: async (ctx, { entries, dryRun, actor }) => {
    const outcomes: Outcome[] = [];
    for (const entry of entries) {
      try {
        outcomes.push(await ctx.runMutation(internal.repair.applyOne, { entry, dryRun, actor }));
      } catch (error) {
        const data = errorData(error);
        if (data?.dryRun) outcomes.push(data.dryRun);
        else if (data?.skip) outcomes.push({ key: entry.key, status: "skipped", reason: data.skip });
        else {
          outcomes.push({
            key: entry.key,
            status: "error",
            reason: error instanceof Error ? error.message.slice(0, 500) : String(error),
          });
        }
      }
    }
    return outcomes;
  },
});
