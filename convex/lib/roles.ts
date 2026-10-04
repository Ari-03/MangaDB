// Data-team roles and the governance matrix (spec §4/§5):
// Administrators appoint Moderators (and, as a superset, everything else);
// Moderators appoint Editors and approve/reject proposals; Editors propose.
// Role checks always read the live User doc — the role is never baked into a
// session — and suspension removes privileges immediately.

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireUser } from "./auth";
import { fail } from "./errors";

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
    fail("forbidden", "This action needs a data-team role you do not hold.");
  }
  return user;
}

/** Moderator-or-Administrator gate — the approval/direct-edit privilege. */
export async function requireModerator(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  return await requireRole(ctx, ["moderator", "administrator"]);
}

/** Any data-team role — the propose/queue-visibility privilege (spec §5). */
export async function requireDataTeam(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  return await requireRole(ctx, DATA_ROLES);
}

/** An Administrator who is neither suspended nor deleting their account. */
function activeAdministrator(user: Doc<"users">): boolean {
  return user.role === "administrator" && !user.suspended && user.deletingSince === undefined;
}

/**
 * Count of active Administrators: not suspended and not deleting their
 * account. Reads only the Administrators (by_role), a handful of rows.
 */
async function countActiveAdministrators(ctx: QueryCtx | MutationCtx): Promise<number> {
  const admins = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "administrator"))
    .collect();
  return admins.filter(activeAdministrator).length;
}

/**
 * Refuse any change that would leave MangaDB without a working Administrator
 * (spec §4 makes the Administrator the root of governance): revoking the
 * last active one, moving them to another role, or deleting their account.
 * Refuses with `message`; a no-op unless `target` is an active
 * Administrator.
 */
export async function guardLastAdministrator(
  ctx: MutationCtx,
  target: Doc<"users">,
  message = "Cannot remove the last active Administrator.",
) {
  if (!activeAdministrator(target)) return;
  if ((await countActiveAdministrators(ctx)) <= 1) fail("lastAdministrator", message);
}
