// Role governance (spec §4/§5): the initial Administrator is
// appointed by the operator; Administrators appoint Moderators; Moderators
// appoint Editors. Every appointment, revocation, suspension, and
// reinstatement writes a permanent roleAudit row — the audit trail is
// append-only and survives even account deletion.
//
// Revocation and suspension remove privileges only: past attribution is
// untouched, because Revisions and Proposals record the author's role at
// authorship (authorRef.roleAtAuthorship) and are immutable.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { fail } from "./lib/errors";
import {
  canGovern,
  DATA_ROLES,
  guardLastAdministrator,
  requireModerator,
  requireRole,
  type DataRole,
} from "./lib/roles";
import { usernameLookup } from "./lib/usernameLookup";
import { normalizeUsername } from "./lib/usernames";
import { dataRole } from "./schema";

/** The User a username names; a User deleting their account counts as none. */
async function findUserByUsername(
  ctx: MutationCtx,
  username: string,
): Promise<Doc<"users">> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_username", (q) =>
      q.eq("usernameNormalized", normalizeUsername(username)),
    )
    .unique();
  if (!user || user.deletingSince !== undefined) fail("notFound", `No user named "${username}".`);
  return user;
}

/**
 * Bootstrap the initial Administrator (spec §5). Operator-only —
 * run once against the deployment, before any Administrator exists:
 *
 *   npx convex run roles:bootstrapAdministrator '{"username":"yourname"}'
 *
 * Audited with the system actor; every later role change goes through the
 * authenticated mutations below.
 */
export const bootstrapAdministrator = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const existingAdmin = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "administrator"))
      .first();
    if (existingAdmin) {
      fail("alreadyBootstrapped", "An Administrator already exists; appoint further roles through them.");
    }
    const user = await findUserByUsername(ctx, username);
    await ctx.db.patch(user._id, { role: "administrator" });
    await ctx.db.insert("roleAudit", {
      userId: user._id,
      action: "appointed",
      role: "administrator",
      actor: { kind: "system" },
      reason: "Initial Administrator (operator bootstrap).",
    });
    return { username: user.username, role: "administrator" as const };
  },
});

async function requireGovernanceOver(
  ctx: MutationCtx,
  role: DataRole,
): Promise<Doc<"users">> {
  const actor = await requireRole(ctx, ["moderator", "administrator"]);
  if (!canGovern(actor.role as DataRole, role)) {
    fail("forbidden", `A ${actor.role} cannot govern the ${role} role.`);
  }
  return actor;
}

/** Appoint (or change) a user's data-team role. Permanently audited. */
export const appoint = mutation({
  args: {
    username: v.string(),
    role: dataRole,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { username, role, reason }) => {
    const actor = await requireGovernanceOver(ctx, role);
    const target = await findUserByUsername(ctx, username);
    if (target.role === role) fail("noChange", `@${target.username} is already a ${role}.`);
    if (target.role) {
      // A role change implies removing the current role too.
      const currentActor = actor.role as DataRole;
      if (!canGovern(currentActor, target.role)) {
        fail("forbidden", `A ${actor.role} cannot change a ${target.role}'s role.`);
      }
      await guardLastAdministrator(ctx, target);
      await ctx.db.insert("roleAudit", {
        userId: target._id,
        action: "revoked",
        role: target.role,
        actor: { kind: "user", userId: actor._id },
        reason: reason ?? `Role changed to ${role}.`,
      });
    }
    await ctx.db.patch(target._id, { role });
    await ctx.db.insert("roleAudit", {
      userId: target._id,
      action: "appointed",
      role,
      actor: { kind: "user", userId: actor._id },
      reason,
    });
    return { username: target.username, role };
  },
});

/**
 * Revoke a user's role. Removes privileges only: the user's past Proposals
 * and Revisions keep their recorded role-at-authorship forever.
 */
export const revoke = mutation({
  args: { username: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { username, reason }) => {
    const target = await findUserByUsername(ctx, username);
    if (!target.role) fail("noChange", `@${target.username} holds no role.`);
    const actor = await requireGovernanceOver(ctx, target.role);
    await guardLastAdministrator(ctx, target);
    await ctx.db.patch(target._id, { role: undefined });
    await ctx.db.insert("roleAudit", {
      userId: target._id,
      action: "revoked",
      role: target.role,
      actor: { kind: "user", userId: actor._id },
      reason,
    });
    return { username: target.username };
  },
});

/**
 * Suspend a user: privileges and account access stop immediately (requireUser
 * refuses them, and they cannot change their username), and their public
 * profile is hidden (sharing.publicProfile). Nothing of theirs is changed:
 * the role marker and sharing choices stay, so reinstatement restores both.
 * Audited permanently.
 */
export const suspend = mutation({
  args: { username: v.string(), reason: v.string() },
  handler: async (ctx, { username, reason }) => {
    const target = await findUserByUsername(ctx, username);
    const governedRole: DataRole = target.role ?? "editor";
    const actor = await requireGovernanceOver(ctx, governedRole);
    if (target._id === actor._id) fail("forbidden", "You cannot suspend yourself.");
    if (target.suspended) fail("noChange", `@${target.username} is already suspended.`);
    // No last-Administrator guard: only another active Administrator can suspend one.
    await ctx.db.patch(target._id, { suspended: true });
    await ctx.db.insert("roleAudit", {
      userId: target._id,
      action: "suspended",
      role: governedRole,
      actor: { kind: "user", userId: actor._id },
      reason,
    });
    return { username: target.username };
  },
});

/** Lift a suspension. Audited permanently. */
export const reinstate = mutation({
  args: { username: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { username, reason }) => {
    const target = await findUserByUsername(ctx, username);
    const governedRole: DataRole = target.role ?? "editor";
    const actor = await requireGovernanceOver(ctx, governedRole);
    if (!target.suspended) fail("noChange", `@${target.username} is not suspended.`);
    await ctx.db.patch(target._id, { suspended: undefined });
    await ctx.db.insert("roleAudit", {
      userId: target._id,
      action: "reinstated",
      role: governedRole,
      actor: { kind: "user", userId: actor._id },
      reason,
    });
    return { username: target.username };
  },
});

/**
 * Current role holders, for the /mod/roles page. Data team only. Reads only
 * the role holders (by_role, one range per role; the team is a handful of
 * people) and leaves out anyone deleting their account.
 */
export const roster = query({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    const rows = [];
    for (const role of DATA_ROLES) {
      const holders = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", role))
        .collect();
      for (const u of holders) {
        if (u.deletingSince !== undefined) continue;
        rows.push({ username: u.username, role, suspended: u.suspended ?? false });
      }
    }
    return rows.sort((a, b) => a.username.localeCompare(b.username));
  },
});

const AUDIT_LOG_LIMIT = 200;

/**
 * The permanent role-change audit trail, newest first. Data team only in v1;
 * entries for deleted accounts render with a null username — the row itself
 * is never rewritten or removed.
 */
export const auditLog = query({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    const rows = await ctx.db.query("roleAudit").order("desc").take(AUDIT_LOG_LIMIT);
    const usernameOf = usernameLookup(ctx);
    const entries = [];
    for (const row of rows) {
      entries.push({
        at: row._creationTime,
        action: row.action,
        role: row.role,
        username: await usernameOf(row.userId),
        actor:
          row.actor.kind === "user"
            ? { kind: "user" as const, username: await usernameOf(row.actor.userId) }
            : { kind: "system" as const },
        reason: row.reason ?? null,
      });
    }
    return entries;
  },
});
