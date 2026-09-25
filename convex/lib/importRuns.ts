// The enablement gate shared by the chained importers (ANN, Yen Press,
// OpenLibrary). A run spans many action links; disabling a source must stop
// the runs the scheduler started, while a run an operator forced on a
// disabled source (imports:startRun, then the sync with its runId) finishes.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";

/**
 * The run this link should work on, or null to stop. A fresh call on a
 * disabled source skips; a fresh call on an enabled one opens an automatic
 * run; a continuation of an automatic run whose source has since been
 * disabled is closed with its counts so far.
 */
export async function runToContinue(
  ctx: ActionCtx,
  source: Doc<"approvedSources">,
  args: { runId?: Id<"importRuns">; seen?: number; changed?: number; errors?: string[] },
): Promise<Id<"importRuns"> | null> {
  if (args.runId === undefined) {
    if (!source.enabled) return null;
    return await ctx.runMutation(internal.imports.startRun, { sourceKey: source.key, automatic: true });
  }
  if (source.enabled) return args.runId;
  const stopped: boolean = await ctx.runMutation(internal.imports.stopIfAutomatic, {
    runId: args.runId,
    recordsSeen: args.seen ?? 0,
    recordsChanged: args.changed ?? 0,
    errors: args.errors ?? [],
  });
  return stopped ? null : args.runId;
}

/**
 * Open the run a finished run chains into (ANN's release-page pass after its
 * mirror), inheriting whether it was automatic: a forced mirror chains a
 * forced page pass, a scheduled one a scheduled pass. Call it in the same
 * mutation that schedules the follow-on, so a run is never left "running"
 * with nothing scheduled to finish it.
 */
export async function openFollowOnRun(
  ctx: MutationCtx,
  afterRunId: Id<"importRuns">,
  sourceKey: string,
): Promise<Id<"importRuns">> {
  const previous = await ctx.db.get(afterRunId);
  return await ctx.db.insert("importRuns", {
    sourceKey,
    status: "running",
    recordsSeen: 0,
    recordsChanged: 0,
    errors: [],
    ...(previous?.automatic ? { automatic: true } : {}),
  });
}
