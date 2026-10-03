// Run plumbing shared by the sync actions: the registry lookup, the cover
// store, closing a finished run, and the gate every sync checks while it
// runs.
//
// Disabling a source, the same rule for every sync:
// - A fresh call (the cadence dispatcher's, or an operator's bare
//   `sync '{}'`) on a disabled source opens no run. On an enabled one it
//   opens an automatic run.
// - The gate (`stopAtGate`) is checked at each link's entry, at page or
//   batch boundaries inside a link, and just before a withdrawal pass. An
//   automatic run that finds its source disabled there closes as "stopped"
//   with its counts and errors so far. A stop does not count toward the
//   source's failure streak or its unhealthy alert, and a stopped sweep
//   never withdraws anything.
// - A disable is not an instant stop: the page or batch already under way
//   finishes and writes, and the run stops at the next boundary.
// - A run an operator forced (imports:startRun, then the sync with its
//   runId) carries on and imports while the source is disabled.
// - The apply mutations never check the flag, so operator backfills, direct
//   applies and the Kodansha backlist crawl write whatever the "kodansha"
//   row says. Each sync is gated on its own registry row; the backlist's is
//   "kodansha-backlist".

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { storeCover, type StoredCovers } from "./covers";
import { errorMessage } from "./http";

/** Errors a continuation link carries forward to the next one. */
export const MAX_CARRIED_ERRORS = 50;

/**
 * A sync's registry row. A missing row is a setup error, so it throws. The
 * declared return type also breaks the inference cycle between an adapter
 * and imports.ts's adapter map.
 */
export async function registryRow(
  ctx: ActionCtx,
  key: string,
): Promise<Doc<"approvedSources">> {
  const source = await ctx.runQuery(internal.importSources.getByKey, { key });
  if (!source) {
    throw new Error(
      `The approved-source registry has no "${key}" row. Run: npx convex run importSources:seedRegistry '{}'`,
    );
  }
  return source;
}

/**
 * Store one book's cover during a run. A cover never fails its book: a
 * notice or a failed download is logged on the run as `cover {label}: …`.
 * Returns false when the download failed, so a caller can retry it later.
 */
export async function storeRunCover(
  ctx: ActionCtx,
  covers: StoredCovers,
  request: Parameters<typeof storeCover>[2],
  log: { label: string; errors: string[] },
): Promise<boolean> {
  try {
    const notice = await storeCover(ctx, covers, request);
    if (notice) log.errors.push(`cover ${log.label}: ${notice}`);
    return true;
  } catch (e) {
    log.errors.push(`cover ${log.label}: ${errorMessage(e)}`);
    return false;
  }
}

/** A sync's running totals: what a stop or a close records on the run. */
type RunTotals = { seen: number; changed: number; errors: string[] };

/**
 * The gate (imports.stopIfAutomatic), checked before a run's next page,
 * batch, link or withdrawal pass. Null when the run may go on. Otherwise the
 * run is over (closed as "stopped" with these totals if it was automatic)
 * and this is what the sync reports for it:
 * `if (stopped) return { ...stopped, completeSweep: false }`.
 */
export async function stopAtGate(ctx: ActionCtx, runId: Id<"importRuns">, totals: RunTotals) {
  const stopped: boolean = await ctx.runMutation(internal.imports.stopIfAutomatic, {
    runId,
    recordsSeen: totals.seen,
    recordsChanged: totals.changed,
    errors: totals.errors,
  });
  if (!stopped) return null;
  return {
    runId,
    recordsSeen: totals.seen,
    recordsChanged: totals.changed,
    errorCount: totals.errors.length,
    stopped: true as const,
  };
}

/**
 * The run this link should work on, or null to stop. A fresh call on a
 * disabled source skips; a fresh call on an enabled one opens an automatic
 * run; a continuation, or an operator's forced run, passes the gate.
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
  const stopped = await stopAtGate(ctx, args.runId, {
    seen: args.seen ?? 0,
    changed: args.changed ?? 0,
    errors: args.errors ?? [],
  });
  return stopped === null ? args.runId : null;
}

/**
 * Close a run with its totals and return the result fields every sync
 * reports for a finished run; a failed run's result carries `failed`. The
 * caller picks the status and spreads the result into its own:
 * `return { ...(await closeRun(ctx, runId, status, totals)), completeSweep }`.
 */
export async function closeRun(
  ctx: ActionCtx,
  runId: Id<"importRuns">,
  status: "succeeded" | "failed",
  totals: RunTotals & { healthNeutral?: boolean },
) {
  await ctx.runMutation(internal.imports.finishRun, {
    runId,
    status,
    recordsSeen: totals.seen,
    recordsChanged: totals.changed,
    errors: totals.errors,
    healthNeutral: totals.healthNeutral,
  });
  return {
    runId,
    recordsSeen: totals.seen,
    recordsChanged: totals.changed,
    errorCount: totals.errors.length,
    ...(status === "failed" ? { failed: true as const } : {}),
  };
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
