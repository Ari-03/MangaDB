// Write-conflict retry for importer apply mutations.
//
// Every import applies one record per mutation, and several importers can run
// at once (the cadence tick, or an operator starting all sources). They all
// bump the same public-ID counter rows (publicIds.ts), so under load Convex's
// own optimistic-concurrency retries can be exhausted and the mutation fails
// with "Documents read from or written to ... changed while this mutation was
// being run". Without this wrapper that record is skipped for the run (2026-09
// first staging import: 135 records across six sources).
//
// Actions may retry freely, so we space a few more attempts out with jittered
// backoff. Anything that is not a write conflict is rethrown at once.

import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { ActionCtx } from "../_generated/server";
import { errorMessage, sleep } from "./http";

/** Convex's message for an exhausted optimistic-concurrency retry. */
export function isWriteConflict(e: unknown): boolean {
  return /changed while this mutation was being run/i.test(errorMessage(e));
}

const BASE_DELAY_MS = 250;

/**
 * `ctx.runMutation(ref, args)` that retries write conflicts. `attempts` is the
 * total number of tries (default 4: the first call plus three retries spaced
 * roughly 0.25 s, 0.5 s, 1 s apart, each with up to 250 ms of jitter).
 */
export async function applyRetrying<F extends FunctionReference<"mutation", "internal">>(
  ctx: Pick<ActionCtx, "runMutation">,
  ref: F,
  args: FunctionArgs<F>,
  attempts = 4,
): Promise<FunctionReturnType<F>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.runMutation(ref, args);
    } catch (e) {
      if (attempt >= attempts || !isWriteConflict(e)) throw e;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * BASE_DELAY_MS);
    }
  }
}
