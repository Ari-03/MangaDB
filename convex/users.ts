// Accounts (spec §9, ticket #26). Clerk owns credentials and sessions; the
// Convex User is created just in time on first sign-in, keyed by the stable
// Clerk subject — never email. Creation happens atomically with the required
// username claim, so a signed-in visitor without a User row is exactly "first
// sign-in, claim pending" and the app routes them to the claim screen.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { getUserBySubject, requireIdentity } from "./lib/auth";
import { validateUsername } from "./lib/usernames";

/**
 * The signed-in viewer's account state; null when signed out. Drives the
 * routing decision between the /me shell and the forced username claim.
 */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) return { needsUsername: true as const };
    return {
      needsUsername: false as const,
      username: user.username,
      // Data-team role (ticket #31); gates the edit affordances client-side.
      // Authorization is always re-checked in the moderation functions.
      role: user.role ?? null,
      formatPreference: user.formatPreference,
      ownershipVisibility: user.ownershipVisibility,
      readingVisibility: user.readingVisibility,
      suspended: user.suspended ?? false,
    };
  },
});

/**
 * Claim (or change) the viewer's username. First claim creates the User just
 * in time with private-by-default visibility (#7). A change releases the old
 * name immediately — uniqueness is only ever the normalized-copy index lookup
 * at claim time, so the freed name is claimable in the next mutation.
 */
export const claimUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const identity = await requireIdentity(ctx);
    const trimmed = username.trim();
    const result = validateUsername(trimmed);
    if (!result.ok) {
      throw new ConvexError({ code: result.code, message: result.message });
    }

    const holder = await ctx.db
      .query("users")
      .withIndex("by_username", (q) =>
        q.eq("usernameNormalized", result.normalized),
      )
      .unique();
    if (holder && holder.clerkSubject !== identity.subject) {
      throw new ConvexError({
        code: "taken",
        message: "That username is already taken.",
      });
    }

    const existing = await getUserBySubject(ctx, identity.subject);
    if (existing) {
      await ctx.db.patch(existing._id, {
        username: trimmed,
        usernameNormalized: result.normalized,
      });
    } else {
      await ctx.db.insert("users", {
        clerkSubject: identity.subject,
        username: trimmed,
        usernameNormalized: result.normalized,
        formatPreference: "both",
        ownershipVisibility: "private",
        readingVisibility: "private",
      });
    }
    return { username: trimmed };
  },
});

/**
 * Delete the viewer's account: the Clerk identity via the Backend API first
 * (nothing is touched if that call fails), then all MangaDB data. Requires
 * CLERK_SECRET_KEY on the Convex deployment. A 404 from Clerk means the
 * identity is already gone; the data purge still runs.
 */
export const deleteAccount = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "unauthenticated", message: "Sign in first." });
    }
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "CLERK_SECRET_KEY is not set on the Convex deployment; cannot delete the Clerk identity.",
      );
    }
    const response = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(identity.subject)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Clerk identity deletion failed (HTTP ${response.status}).`);
    }
    await ctx.runMutation(internal.users.purgeUser, {
      clerkSubject: identity.subject,
    });
  },
});

/**
 * Remove every personal record for a Clerk subject: tracking rows, then the
 * User itself. Public catalog history (Revisions, Proposals, roleAudit) is
 * append-only and survives; it renders as a deleted author.
 */
export const purgeUser = internalMutation({
  args: { clerkSubject: v.string() },
  handler: async (ctx, { clerkSubject }) => {
    const user = await getUserBySubject(ctx, clerkSubject);
    if (!user) return;

    const collection = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const seriesStates = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", user._id))
      .collect();
    const releaseProg = await ctx.db
      .query("releaseProgress")
      .withIndex("by_user_release", (q) => q.eq("userId", user._id))
      .collect();
    const volumeProg = await ctx.db
      .query("volumeProgress")
      .withIndex("by_user_volume", (q) => q.eq("userId", user._id))
      .collect();

    for (const doc of [...collection, ...seriesStates, ...releaseProg, ...volumeProg]) {
      await ctx.db.delete(doc._id);
    }
    await ctx.db.delete(user._id);
  },
});
