// Username rendering for lists that name the same Users many times (review
// queue, revision history, role audit log).

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { liveUser } from "./auth";

/**
 * A lookup that reads each User once per request. A missing id or a
 * deleted account, or one whose deletion is under way, reads as null.
 */
export function usernameLookup(ctx: QueryCtx) {
  const cache = new Map<Id<"users">, string | null>();
  return async (userId: Id<"users"> | undefined): Promise<string | null> => {
    if (!userId) return null;
    if (!cache.has(userId)) cache.set(userId, (await liveUser(ctx, userId))?.username ?? null);
    return cache.get(userId) ?? null;
  };
}
