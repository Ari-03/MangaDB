// Authorization helpers (spec §9): every personal function authorizes in
// Convex via ctx.auth.getUserIdentity(). Identity links by the stable Clerk
// JWT subject — never by email — so an email change keeps the same User.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Throws unless the request carries a valid Clerk identity. */
export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({ code: "unauthenticated", message: "Sign in first." });
  }
  return identity;
}

/** The viewer's User doc, or null while their username claim is pending. */
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
 * The viewer's User for personal *queries*: null when signed out or the
 * username claim is pending, so overlay queries render as "nothing to show"
 * instead of erroring on public pages. Mutations use requireUser instead.
 */
export async function viewerOrNull(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await getUserBySubject(ctx, identity.subject);
}

/**
 * The gate for personal mutations and queries: valid identity, a User created
 * (username claimed), and not suspended. Tracking slices call this first.
 */
export async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const identity = await requireIdentity(ctx);
  const user = await getUserBySubject(ctx, identity.subject);
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
