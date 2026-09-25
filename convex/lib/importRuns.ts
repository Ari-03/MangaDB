// The enablement gate shared by the chained importers (ANN, Yen Press,
// OpenLibrary). A run spans many action links; disabling a source must stop
// the runs the scheduler started, while a run an operator forced on a
// disabled source (imports:startRun, then the sync with its runId) finishes.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

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
