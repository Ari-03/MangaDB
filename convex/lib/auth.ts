// Authorization helpers (spec §9): every personal function authorizes in
// Convex via ctx.auth.getUserIdentity(). Identity links by the stable Clerk
// JWT subject — never by email — so an email change keeps the same User.
//
// A User whose account deletion is under way (`deletingSince` set by
// users.deleteAccount) counts as gone from that moment: signed out to
// themselves, absent to everyone else. Their row stays until the purge has
// emptied every personal table and a day has passed since Clerk deleted the
// sign-in, and still holds their username and Clerk subject so neither can
// be claimed again in the meantime, even by a token issued before.
// Moderation reads the row itself: a Shadowed User's Comments stay hidden
// while they wait for the purge (comments.ts).

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Throws unless the request carries a valid Clerk identity. */
export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({ code: "unauthenticated", message: "Sign in first." });
  }
  return identity;
}

/**
 * The User row for a Clerk subject, or null while their username claim is
 * pending. Includes a User being deleted; viewerOrNull and requireUser
 * treat that one as signed out.
 */
export async function getUserBySubject(
  ctx: QueryCtx | MutationCtx,
  clerkSubject: string,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", clerkSubject))
    .unique();
}

/**
 * A User by id as everyone else sees them: null when the row is gone or
 * its account deletion is under way. For author names, profiles and
 * owners; a moderation check (a Shadowed User's flag) reads the row itself.
 */
export async function liveUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"users"> | null> {
  const user = await ctx.db.get(userId);
  return user && user.deletingSince === undefined ? user : null;
}

/**
 * The viewer's User for personal *queries*: null when signed out, while the
 * username claim is pending, or once account deletion is under way, so
 * overlay queries render as "nothing to show" instead of erroring on public
 * pages, which render identically without the personal controls. Overlay
 * queries are null "without a viewer" in this sense. Mutations use
 * requireUser instead.
 */
export async function viewerOrNull(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await getUserBySubject(ctx, identity.subject);
  return user && user.deletingSince === undefined ? user : null;
}

/**
 * The gate for personal mutations and queries: valid identity, a User created
 * (username claimed), not being deleted, and not suspended. Tracking slices
 * call this first.
 */
export async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const identity = await requireIdentity(ctx);
  const user = await getUserBySubject(ctx, identity.subject);
  if (user?.deletingSince !== undefined) {
    throw new ConvexError({ code: "unauthenticated", message: "This account is being deleted." });
  }
  if (!user) {
    throw new ConvexError({
      code: "usernameRequired",
      message: "Claim a username to finish setting up your account.",
    });
  }
  if (user.suspended) {
    throw new ConvexError({ code: "suspended", message: "Account suspended." });
  }
  return user;
}
