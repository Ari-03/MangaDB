// The per-user-per-Series state row (userSeriesStates): Reading Status,
// the Follow and its prompt, and the visibility overrides share it, each
// written by its own module (reading.ts, follows.ts, sharing.ts).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** One user's state row for one Series, or null. */
export async function seriesStateRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
) {
  return await ctx.db
    .query("userSeriesStates")
    .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
    .unique();
}

/**
 * Patch one user's state row for one Series with `fields`, or, when there is
 * none and `create` holds, insert one: not following, prompt not dismissed,
 * plus `fields`. A write that only clears something passes `create: false`.
 */
export async function writeSeriesState(
  ctx: MutationCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
  fields: Partial<Omit<Doc<"userSeriesStates">, "_id" | "_creationTime" | "userId" | "seriesId">>,
  create: boolean,
) {
  const state = await seriesStateRow(ctx, userId, seriesId);
  if (state) {
    await ctx.db.patch(state._id, fields);
  } else if (create) {
    await ctx.db.insert("userSeriesStates", {
      userId,
      seriesId,
      following: false,
      followPromptDismissed: false,
      ...fields,
    });
  }
}
