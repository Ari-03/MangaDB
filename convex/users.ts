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
  internalQuery,
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
 * account deletion is under way (deletionPending tells the two apart).
 * Drives the routing decision between the /me shell and the forced
 * username claim.
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
 * Whether the signed-in identity's account deletion is under way, which
 * users.viewer and every other query read as signed out. /me asks when
 * the viewer is null, so a session still signed in to Clerk is told its
 * account is being deleted and signed out, instead of being sent to
 * sign in again.
 */
export const deletionPending = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const user = await getUserBySubject(ctx, identity.subject);
    return user?.deletingSince !== undefined;
  },
});

/**
 * Claim (or change) the viewer's username. First claim creates the User just
 * in time with private-by-default visibility. A change releases the old
 * name immediately — uniqueness is only ever the normalized-copy index lookup
 * at claim time, so the freed name is claimable in the next mutation. A
 * suspended User cannot change theirs. A User whose account deletion is
 * under way can do neither, and keeps their name taken until their row
 * goes, after the purge and the Clerk deletion.
 */
export const claimUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const identity = await requireIdentity(ctx);
    const existing = await getUserBySubject(ctx, identity.subject);
    if (existing?.deletingSince !== undefined) fail("unauthenticated", "This account is being deleted.");
    if (existing?.suspended) fail("suspended", "Account suspended.");
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
 * Delete the viewer's account: the purge, then the Clerk sign-in, then the
 * User row. One transaction marks the User as deleting (`deletingSince`;
 * from then on they count as gone, lib/auth.ts) and schedules purgeUser,
 * which empties their personal tables in bounded runs. Its last run
 * schedules deleteClerkIdentity, and the row goes only once Clerk confirms
 * the sign-in is gone (removePurgedUser): until then the marked row keeps
 * the identity out of the account and from claiming a new one. Refused for
 * the last active Administrator. Asking again while a deletion is under
 * way, or waiting on Clerk, changes nothing. An identity with no User (no
 * username claimed yet) gets the Clerk deletion alone. Needs
 * CLERK_SECRET_KEY on the Convex deployment; without it nothing is marked
 * or scheduled.
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
    } else {
      await ctx.scheduler.runAfter(0, internal.users.deleteClerkIdentity, {
        clerkSubject: identity.subject,
        attempt: 0,
      });
    }
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
 * Delete a Clerk identity through the Backend API, then its purged User row
 * (removePurgedUser). A 404 means the identity is already gone, which
 * counts as done. A failed call (an error status, a network error, a
 * missing CLERK_SECRET_KEY) reschedules this action after the next
 * CLERK_RETRY_DELAYS wait; past the last it logs an error with the command
 * that retries it and stops, leaving the marked row in place. Run with
 * `attempt: 0` by hand, it is that retry.
 *
 * Before each attempt it stops if the subject holds a live (unmarked) User,
 * which only an identity that had no User when it asked can come to hold:
 * that account is new, and its sign-in stays. A username claimed while the
 * DELETE is in flight is not caught, and loses its sign-in with the rest;
 * that identity had no data when it asked, and the window is one request.
 */
export const deleteClerkIdentity = internalAction({
  args: { clerkSubject: v.string(), attempt: v.number() },
  handler: async (ctx, { clerkSubject, attempt }) => {
    if (await ctx.runQuery(internal.users.holdsLiveUser, { clerkSubject })) {
      console.warn(`Not deleting Clerk identity ${clerkSubject}: it has claimed a new account since asking.`);
      return null;
    }
    const failure = await deleteFromClerk(clerkSubject);
    if (failure === null) {
      await ctx.runMutation(internal.users.removePurgedUser, { clerkSubject });
      return null;
    }
    const delay = CLERK_RETRY_DELAYS[attempt];
    if (delay === undefined) {
      console.error(
        `Gave up deleting Clerk identity ${clerkSubject} after ${attempt + 1} attempts (${failure}). ` +
          "Its MangaDB data is purged; its User row stays, marked deleting, until the identity is gone. " +
          `Once Clerk is reachable, run: npx convex run users:deleteClerkIdentity '{"clerkSubject":"${clerkSubject}","attempt":0}'`,
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

/** Whether a Clerk subject holds a User that is not being deleted. */
export const holdsLiveUser = internalQuery({
  args: { clerkSubject: v.string() },
  handler: async (ctx, { clerkSubject }) => {
    const user = await getUserBySubject(ctx, clerkSubject);
    return user !== null && user.deletingSince === undefined;
  },
});

/**
 * Delete a subject's User row once its Clerk identity is gone, only if it
 * is still the marked row the purge has emptied (`purgedAt`). Anything else
 * (no row, a live one, a purge still running) is left alone; a running
 * purge schedules the Clerk deletion again when it finishes.
 */
export const removePurgedUser = internalMutation({
  args: { clerkSubject: v.string() },
  handler: async (ctx, { clerkSubject }) => {
    const user = await getUserBySubject(ctx, clerkSubject);
    if (user?.deletingSince === undefined || user.purgedAt === undefined) return;
    await ctx.db.delete(user._id);
  },
});

/**
 * The most rows one purgeUser run deletes or detaches, Ratings included.
 * Every row but a Rating is small: deleting a Review (at most 5,000
 * characters), a Comment (2,000) or a tracking row, or detaching a reply,
 * reads and writes at most two such documents (the row, and a Comment a
 * report counted on or a reply belonged to), under 16 KB each way. So the
 * batch, Ratings aside, stays near 3 MB read and written.
 */
export const PURGE_BATCH = 200;

/**
 * The most Ratings one purgeUser run deletes. A Rating writes up to four
 * documents: itself, its target's ratingStats row and, for a Series, its
 * library row and the pack of about 1,000 Series it shares
 * (seriesBrowse.syncRatingProjection), which is read every time and
 * rewritten when the rank moves. A pack may grow to the 1 MiB document
 * limit, so a Rating is budgeted just over 1 MiB read and as much written:
 * eight of them and the rest of the batch stay under 12 MiB each way,
 * inside the 16 MiB transaction limits. A fixed count rather than a check
 * of getTransactionMetrics, because the bound follows from the document
 * limit alone and holds whatever else the run read first.
 */
export const PURGE_RATINGS = 8;

/**
 * Empty a deleting User's personal tables, PURGE_BATCH rows per run (at
 * most PURGE_RATINGS of them Ratings), rescheduling itself until one run
 * reads every table to its end. That run, in the same transaction, sets
 * `purgedAt` and schedules redactMergeManifests and deleteClerkIdentity,
 * so no row inserted meanwhile (by a merge, say) is left behind. The row
 * itself stays, marked, until Clerk has deleted the sign-in
 * (removePurgedUser); no function adds rows for a marked User meanwhile.
 * Comments (with Comment Reports) and Reviews go first, then Ratings, each
 * with its aggregate update in the same transaction, then Favorites and
 * the tracking rows.
 * Public catalog history (Revisions, Proposals, roleAudit, reviewAudit,
 * commentAudit) is append-only and survives; it renders as a deleted
 * author. Does nothing unless the User is marked deleting (deleteAccount)
 * and not yet purged, so rerunning it is safe.
 */
export const purgeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (user?.deletingSince === undefined || user.purgedAt !== undefined) return;

    // Finished only when every read in this run came back short of what it
    // asked for: a full take, or none for want of room, may have left rows
    // behind.
    let left = PURGE_BATCH - (await purgeUserComments(ctx, userId, PURGE_BATCH));
    let finished = left > 0;

    const reviews =
      left > 0 ? await ctx.db.query("reviews").withIndex("by_user", (q) => q.eq("userId", userId)).take(left) : [];
    for (const row of reviews) await ctx.db.delete(row._id);
    finished &&= reviews.length < left;
    left -= reviews.length;

    const ratingRoom = Math.min(left, PURGE_RATINGS);
    const ratings =
      ratingRoom > 0
        ? await ctx.db.query("ratings").withIndex("by_user", (q) => q.eq("userId", userId)).take(ratingRoom)
        : [];
    for (const row of ratings) {
      await ctx.db.delete(row._id);
      const target = targetOfRow(row);
      if (target) await applyRatingDelta(ctx, target, row.score, null);
    }
    finished &&= ratings.length < ratingRoom;
    left -= ratings.length;

    const rest = [
      (n: number) => ctx.db.query("favorites").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("collectionEntries").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("userSeriesStates").withIndex("by_user_series", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("releaseProgress").withIndex("by_user_release", (q) => q.eq("userId", userId)).take(n),
      (n: number) => ctx.db.query("volumeProgress").withIndex("by_user_volume", (q) => q.eq("userId", userId)).take(n),
    ];
    for (const next of rest) {
      const rows = left > 0 ? await next(left) : [];
      for (const row of rows) await ctx.db.delete(row._id);
      finished &&= rows.length < left;
      left -= rows.length;
    }

    if (!finished) {
      await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId });
      return;
    }
    await ctx.db.patch(userId, { purgedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.users.redactMergeManifests, {
      userId,
      cursor: null,
    });
    await ctx.scheduler.runAfter(0, internal.users.deleteClerkIdentity, {
      clerkSubject: user.clerkSubject,
      attempt: 0,
    });
  },
});

// Manifests are read a few at a time: one can hold a large merge's log.
const MANIFEST_PAGE = 8;

/**
 * Drop a deleted User's personal snapshots (Ratings, Reviews, tracking rows)
 * from every merge manifest, one page per transaction, rescheduling itself
 * until the table is walked. Scheduled by purgeUser once the User's tables
 * are empty; Split also refuses to reinsert rows of a User being deleted or
 * gone, so the walk may take its time.
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
