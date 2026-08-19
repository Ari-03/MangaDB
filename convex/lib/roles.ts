// Data-team roles and the governance matrix (spec §4/§5, ticket #31):
// Administrators appoint Moderators (and, as a superset, everything else);
// Moderators appoint Editors and approve/reject proposals; Editors propose.
// Role checks always read the live User doc — the role is never baked into a
// session — and suspension removes privileges immediately.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireUser } from "./auth";

export type DataRole = NonNullable<Doc<"users">["role"]>;

export const DATA_ROLES = ["editor", "moderator", "administrator"] as const;

/**
 * May `actor` govern (appoint/revoke/suspend/reinstate) the `target` role?
 * Administrators govern every role including other Administrators; Moderators
 * govern Editors only; Editors govern nobody.
 */
export function canGovern(actor: DataRole, target: DataRole): boolean {
  if (actor === "administrator") return true;
  if (actor === "moderator") return target === "editor";
  return false;
}

/**
 * The gate for moderation functions: a signed-in, non-suspended User holding
 * one of `roles`. Returns the User doc so callers attribute work to it.
 */
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  roles: readonly DataRole[],
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!user.role || !roles.includes(user.role)) {
    throw new ConvexError({
      code: "forbidden",
      message: "This action needs a data-team role you do not hold.",
    });
  }
  return user;
}

/** Moderator-or-Administrator gate — the approval/direct-edit privilege. */
export async function requireModerator(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  return await requireRole(ctx, ["moderator", "administrator"]);
}

/** Any data-team role — the propose/queue-visibility privilege (spec §5). */
export async function requireDataTeam(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  return await requireRole(ctx, DATA_ROLES);
}

/**
 * Count of active (non-suspended) Administrators. Guards the lockout case:
 * the last Administrator can never be revoked or suspended.
 */
export async function countActiveAdministrators(
  ctx: QueryCtx | MutationCtx,
): Promise<number> {
  // The users table has no role index; the data team is a handful of people,
  // so a filtered scan is fine and avoids an index that only this guard uses.
  const users = await ctx.db.query("users").collect();
  return users.filter((u) => u.role === "administrator" && !u.suspended).length;
}
