// Accounts (spec §9). Clerk owns credentials and sessions; the
// Convex User is created just in time on first sign-in, keyed by the stable
// Clerk subject — never email. Creation happens atomically with the required
// username claim, so a signed-in visitor without a User row is exactly "first
// sign-in, claim pending" and the app routes them to the claim screen.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { purgeUserComments } from "./comments";
import { getUserBySubject, requireIdentity, requireUser } from "./lib/auth";
import { fail } from "./lib/errors";
import { applyRatingDelta, targetOfRow } from "./lib/ratings";
import { guardLastAdministrator } from "./lib/roles";
import { redactUserFromManifests } from "./lib/sensitiveOps";
import { DEFAULT_SCORE_FORMAT, scoreFormatValidator } from "./lib/scoreFormat";
import { validateUsername } from "./lib/usernames";

/**
 * The signed-in viewer's account state; null when signed out or while their
 * account deletion is under way. Drives the routing decision between the
 * /me shell and the forced username claim.
 */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await getUserBySubject(ctx, identity.subject);
    if (user?.deletingSince !== undefined) return null;
    if (!user) return { needsUsername: true as const };
    return {
      needsUsername: false as const,
      username: user.username,
      // Data-team role; gates the edit affordances client-side.
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
 * in time with private-by-default visibility. A change releases the old
 * name immediately — uniqueness is only ever the normalized-copy index lookup
 * at claim time, so the freed name is claimable in the next mutation. A User
 * whose account deletion is under way can do neither, and keeps their name
 * taken until the purge deletes their row.
 */
export const claimUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const identity = await requireIdentity(ctx);
    const existing = await getUserBySubject(ctx, identity.subject);
    if (existing?.deletingSince !== undefined) fail("unauthenticated", "This account is being deleted.");
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
 * appear in My Upcoming Releases (follows.myUpcoming). Wanted
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
 * Delete the viewer's account. One transaction marks the User as deleting
 * (`deletingSince`; from then on they count as gone, lib/auth.ts) and
 * schedules both halves, which commit with the mark and run independently:
 * purgeUser empties their personal tables in bounded runs and deletes the
 * User last, and deleteClerkIdentity removes the Clerk sign-in, retrying
 * on its own. Refused for the last active Administrator. Asking again while
 * a deletion is under way changes nothing. An identity with no User (no
 * username claimed yet, or purged while the Clerk deletion failed) gets the
 * Clerk deletion alone. Needs CLERK_SECRET_KEY on the Convex deployment;
 * without it nothing is marked or scheduled.
 */
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    if (!process.env.CLERK_SECRET_KEY) {
      console.error("CLERK_SECRET_KEY is not set on the Convex deployment; account deletion is refused.");
      fail("unconfigured", "Account deletion is not available right now.");
    }
    const user = await getUserBySubject(ctx, identity.subject);
    if (user?.deletingSince !== undefined) return null;
    if (user) {
      await guardLastAdministrator(
        ctx,
        user,
        "You are the last active Administrator. Appoint another Administrator before deleting your account.",
      );
      await ctx.db.patch(user._id, { deletingSince: Date.now() });
      await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId: user._id });
    }
    await ctx.scheduler.runAfter(0, internal.users.deleteClerkIdentity, {
      clerkSubject: identity.subject,
      attempt: 0,
    });
    return null;
  },
});

const MINUTE = 60 * 1000;

/**
 * How long deleteClerkIdentity waits before each retry: five retries over
 * about seven hours, then it gives up.
 */
export const CLERK_RETRY_DELAYS = [MINUTE / 2, 2 * MINUTE, 10 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE];

/**
 * Delete a Clerk identity through the Backend API. A 404 means it is already
 * gone, which counts as done. A failed call (an error status, a network
 * error, a missing CLERK_SECRET_KEY) reschedules this action after the next
 * CLERK_RETRY_DELAYS wait; past the last it logs an error and stops. The
 * account purge never waits on it: if it gives up, the identity can still
 * sign in, to an empty account, and delete it again.
 */
export const deleteClerkIdentity = internalAction({
  args: { clerkSubject: v.string(), attempt: v.number() },
  handler: async (ctx, { clerkSubject, attempt }) => {
    const failure = await deleteFromClerk(clerkSubject);
    if (failure === null) return null;
    const delay = CLERK_RETRY_DELAYS[attempt];
    if (delay === undefined) {
      console.error(
        `Gave up deleting Clerk identity ${clerkSubject} after ${attempt + 1} attempts (${failure}). ` +
          "Its MangaDB data is purged regardless; delete the identity in the Clerk dashboard.",
      );
      return null;
    }
    console.warn(`Deleting Clerk identity ${clerkSubject} failed (${failure}); retrying.`);
    await ctx.scheduler.runAfter(delay, internal.users.deleteClerkIdentity, {
      clerkSubject,
      attempt: attempt + 1,
    });
    return null;
  },
});

/** One DELETE call to Clerk: null once the identity is gone, else what went wrong. */
async function deleteFromClerk(clerkSubject: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return "CLERK_SECRET_KEY is not set";
  try {
    const response = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(clerkSubject)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${secretKey}` } },
    );
    return response.ok || response.status === 404 ? null : `HTTP ${response.status}`;
  } catch (error) {
    return String(error);
  }
}

/**
 * The most rows one purgeUser run deletes or detaches. Each costs a few
 * reads and at most two writes (a Rating also moves its target's
 * ratingStats row, a filed Comment Report its Comment's count), and the
 * largest row is a Review of at most 5,000 characters. So a run reads and
 * writes at most a few hundred documents and a few megabytes, well inside
 * a transaction's limits.
 */
export const PURGE_BATCH = 200;

/**
 * Empty a deleting User's personal tables, PURGE_BATCH rows per run,
 * rescheduling itself until a run finds every table empty. That run, in
 * the same transaction, deletes the User and schedules
 * redactMergeManifests, so no row inserted meanwhile (by a merge, say) is
 * left behind. Comments (with Comment Reports) and Reviews go first, then
 * Ratings, decrementing their targets' aggregates, then Favorites and the
 * tracking rows. Public catalog history (Revisions, Proposals, roleAudit,
 * reviewAudit, commentAudit) is append-only and survives; it renders as a
 * deleted author. Does nothing unless the User is marked deleting
 * (deleteAccount), so rerunning it is safe.
 */
export const purgeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (user?.deletingSince === undefined) return;

    let left = PURGE_BATCH - (await purgeUserComments(ctx, userId, PURGE_BATCH));
    if (left > 0) {
      const reviews = await ctx.db
        .query("reviews")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(left);
      for (const row of reviews) await ctx.db.delete(row._id);
      left -= reviews.length;
    }
    if (left > 0) {
      const ratings = await ctx.db
        .query("ratings")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(left);
      for (const row of ratings) {
        await ctx.db.delete(row._id);
        const target = targetOfRow(row);
        if (target) await applyRatingDelta(ctx, target, row.score, null);
      }
      left -= ratings.length;
    }
    const rest = [
      (n: number) => ctx.db.query("favorites").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("collectionEntries").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("userSeriesStates").withIndex("by_user_series", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("releaseProgress").withIndex("by_user_release", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("volumeProgress").withIndex("by_user_volume", (q) => q.eq("userId", userId)).take(n),
    ];
    for (const next of rest) {
      if (left === 0) break;
      const rows = await next(left);
      for (const row of rows) await ctx.db.delete(row._id);
      left -= rows.length;
    }

    if (left === 0) {
      // The batch is spent; whatever remains goes in the next run.
      await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId });
      return;
    }
    await ctx.db.delete(userId);
    await ctx.scheduler.runAfter(0, internal.users.redactMergeManifests, {
      userId,
      cursor: null,
    });
  },
});

// Manifests are read a few at a time: one can hold a large merge's log.
const MANIFEST_PAGE = 8;

/**
 * Drop a deleted User's personal snapshots (Ratings, Reviews, tracking rows)
 * from every merge manifest, one page per transaction, rescheduling itself
 * until the table is walked. Scheduled by purgeUser once the User is
 * deleted; Split also refuses to reinsert rows of a missing User, so the
 * walk may take its time.
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
