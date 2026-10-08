// The Moderator or Administrator a repair, a held-book action or an undo is
// attributed to. Its own module, free of catalog imports, so the printing
// writers can name one without an import cycle.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

/** The operator every repair Revision is attributed to. */
export type Actor = { userId: Id<"users">; role: Doc<"users">["role"] };

/** The active Moderator or Administrator with this username; throws for anyone else. */
export async function resolveActor(ctx: MutationCtx, username: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("usernameNormalized", username.toLowerCase()))
    .unique();
  if (
    !user ||
    user.deletingSince !== undefined ||
    (user.role !== "administrator" && user.role !== "moderator")
  ) {
    throw new ConvexError(
      `Repair actor "${username}" must be an existing Moderator or Administrator.`,
    );
  }
  return { userId: user._id, role: user.role };
}
