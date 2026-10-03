// Run plumbing shared by the sync actions: the registry lookup, the cover
// store, closing a finished run, and the enablement gate of the chained
// importers (ANN, Yen Press, OpenLibrary, the Kodansha backlist). A run spans
// many action links; disabling a source must stop the runs the scheduler
// started. The gate lets a run an operator forced on a disabled source
// (imports:startRun, then the sync with its runId) through; what happens next
// is the source's own: ANN, Open Library and the Kodansha backlist write to
// the end, and Yen Press's applies refuse every write. PRH keeps its own gate
// (convex/prh.ts): any link that finds the source disabled, forced or not,
// closes the run as failed, which counts toward the source's unhealthy alert.

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
 * Close a run with its totals and return the result fields every sync
 * reports for a finished run; a failed run's result carries `failed`. The
 * caller picks the status and spreads the result into its own:
 * `return { ...(await closeRun(ctx, runId, status, totals)), completeSweep }`.
 */
export async function closeRun(
  ctx: ActionCtx,
  runId: Id<"importRuns">,
  status: "succeeded" | "failed",
  totals: { seen: number; changed: number; errors: string[]; healthNeutral?: boolean },
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
