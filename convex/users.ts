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
import { purgeUserComments } from "./comments";
import { getUserBySubject, requireIdentity, requireUser } from "./lib/auth";
import { applyRatingDelta, targetOfRow } from "./lib/ratings";
import { redactUserFromManifests } from "./lib/sensitiveOps";
import { DEFAULT_SCORE_FORMAT, scoreFormatValidator } from "./lib/scoreFormat";
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
      // Rating Format: how the viewer enters and reads scores.
      scoreFormat: user.scoreFormat ?? DEFAULT_SCORE_FORMAT,
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
 * Set the viewer's Physical/Digital/Both format preference (spec §3). It
 * scopes exactly one thing: which announced Releases from followed Series
 * appear in My Upcoming Releases (follows.myUpcoming, ticket #29). Wanted
 * and Ordered entries always appear regardless.
 */
export const setFormatPreference = mutation({
  args: {
    preference: v.union(
      v.literal("physical"),
      v.literal("digital"),
      v.literal("both"),
    ),
  },
  handler: async (ctx, { preference }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, { formatPreference: preference });
    return { preference };
  },
});

/**
 * Set the viewer's Rating Format (CONTEXT.md): which control they rate with
 * and how scores read back to them. Stored Ratings keep their 1-100 score;
 * only the display changes.
 */
export const setScoreFormat = mutation({
  args: { format: scoreFormatValidator },
  handler: async (ctx, { format }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, { scoreFormat: format });
    return { format };
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
 * Remove every personal record for a Clerk subject: tracking rows, Ratings
 * (decrementing their aggregates), Favorites, Reviews, Comments and Comment
 * Reports, then the User itself. Public catalog history (Revisions, Proposals,
 * roleAudit, reviewAudit, commentAudit) is append-only and survives; it
 * renders as a deleted author. The copies of their rows that merge manifests
 * keep for Split are redacted afterwards by redactMergeManifests.
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

    // Ratings leave their targets' aggregates as they go; Reviews go too
    // (their reviewAudit rows stay, like roleAudit).
    const ratings = await ctx.db
      .query("ratings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of ratings) {
      await ctx.db.delete(row._id);
      const target = targetOfRow(row);
      if (target) await applyRatingDelta(ctx, target, row.score, null);
    }
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of favorites) await ctx.db.delete(row._id);
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of reviews) await ctx.db.delete(row._id);
    await purgeUserComments(ctx, user._id);
    await ctx.db.delete(user._id);
    await ctx.scheduler.runAfter(0, internal.users.redactMergeManifests, {
      userId: user._id,
      cursor: null,
    });
  },
});

// Manifests are read a few at a time: one can hold a large merge's log.
const MANIFEST_PAGE = 8;

/**
 * Drop a deleted User's personal snapshots (Ratings, Reviews, tracking rows)
 * from every merge manifest, one page per transaction, rescheduling itself
 * until the table is walked. Scheduled by purgeUser; Split also refuses to
 * reinsert rows of a missing User, so the walk may take its time.
 */
export const redactMergeManifests = internalMutation({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, cursor }) => {
    const page = await ctx.db
      .query("mergeManifests")
      .paginate({ cursor, numItems: MANIFEST_PAGE });
    await redactUserFromManifests(ctx, page.page, userId);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.users.redactMergeManifests, {
        userId,
        cursor: page.continueCursor,
      });
    }
  },
});
