// An operation that must end in its own answer, never the platform's abort
// (a Split, a printing decision), runs as a nested mutation capped at what
// its transaction has left, less what the caller keeps for itself. Past any
// of the seven transaction limits, anywhere in the operation, only the
// nested call is rolled back (its writes undone) and the caller answers
// with a refusal: a Split's `badSplit`, a decision's `refused`. Convex
// 1.41+ caps a nested ctx.runMutation by `transactionLimits` this way, and
// its caller keeps its own remaining budget (convex/_generated/ai/
// guidelines.md). The operation's own checks still refuse earlier with a
// named step; this cap is what bounds the whole of it.

import type { TransactionLimits } from "convex/server";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { MAX_DOCUMENT_BYTES } from "./releaseIsbns";

/**
 * What a caller keeps beyond its nested call: room for the one document a
 * read may overshoot the cap by, and for its own answer afterwards (a
 * Proposal's approval patches it and logs the action).
 */
const CALLER_RESERVE = {
  bytesRead: MAX_DOCUMENT_BYTES + 256 * 1024,
  bytesWritten: 256 * 1024,
  databaseQueries: 64,
  documentsRead: 64,
  documentsWritten: 32,
  functionsScheduled: 4,
  scheduledFunctionArgsBytes: 64 * 1024,
} satisfies Required<TransactionLimits>;

/** The `transactionLimits` a nested call gets: what is left, less CALLER_RESERVE (never below 0). */
export async function nestedLimits(ctx: MutationCtx): Promise<Required<TransactionLimits>> {
  const metrics = await ctx.meta.getTransactionMetrics();
  const left = (name: keyof TransactionLimits) =>
    Math.max(0, metrics[name].remaining - CALLER_RESERVE[name]);
  return {
    bytesRead: left("bytesRead"),
    bytesWritten: left("bytesWritten"),
    databaseQueries: left("databaseQueries"),
    documentsRead: left("documentsRead"),
    documentsWritten: left("documentsWritten"),
    functionsScheduled: left("functionsScheduled"),
    scheduledFunctionArgsBytes: left("scheduledFunctionArgsBytes"),
  };
}

/**
 * Why a nested call failed, when the platform stopped it (a limit): its
 * message. An application error (ConvexError: a refusal, a conflict) is
 * the operation's own answer and is rethrown unchanged.
 */
export function platformStop(error: unknown): string {
  if (error instanceof ConvexError) throw error;
  return error instanceof Error ? error.message : String(error);
}
