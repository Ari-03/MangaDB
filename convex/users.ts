// Accounts (spec §9). Clerk owns credentials and sessions; the
// Convex User is created just in time on first sign-in, keyed by the stable
// Clerk subject — never email. Creation happens atomically with the required
// username claim, so a signed-in visitor without a User row is exactly "first
// sign-in, claim pending" and the app routes them to the claim screen.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { purgeUserComments, type PurgeRoom } from "./comments";
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
 * goes, a day after the purge and the Clerk deletion.
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
 * schedules deleteClerkIdentity, and the row goes a day after Clerk
 * confirms the sign-in is gone (removePurgedUser): until then the marked
 * row keeps the identity, and any token issued to it, out of the account
 * and from claiming a new one. Refused for the last active Administrator,
 * and for an identity with no User (no username claimed): its sign-in can
 * only be deleted in Clerk. Asking again while a deletion is under way, or
 * waiting on Clerk, changes nothing. Needs CLERK_SECRET_KEY on the Convex
 * deployment; without it nothing is marked or scheduled.
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
    if (!user) fail("noAccount", "This sign-in has no MangaDB account to delete.");
    if (user.deletingSince !== undefined) return null;
    await guardLastAdministrator(
      ctx,
      user,
      "You are the last active Administrator. Appoint another Administrator before deleting your account.",
    );
    await ctx.db.patch(user._id, { deletingSince: Date.now() });
    await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId: user._id });
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
 * How long a purged User row outlives its Clerk identity. A Convex token
 * issued before Clerk deleted the identity stays valid until it expires
 * (the lifetime is set on the "convex" JWT template in Clerk), and while
 * the marked row exists such a token can neither use the account nor
 * claim a username. The username stays taken until the row goes.
 */
export const PURGED_ROW_GRACE = 24 * 60 * MINUTE;

/**
 * Delete the Clerk identity of a purged User through the Backend API, then
 * schedule removePurgedUser PURGED_ROW_GRACE later. purgeUser's last run
 * schedules it. A 404 means the identity is already gone, which counts as
 * done. A failed call (an error status, a network error, a missing
 * CLERK_SECRET_KEY) reschedules this action after the next
 * CLERK_RETRY_DELAYS wait; past the last it logs an error with the command
 * that retries it and stops, leaving the marked row in place. Run with
 * `attempt: 0` by hand, it is that retry.
 */
export const deleteClerkIdentity = internalAction({
  args: { clerkSubject: v.string(), attempt: v.number() },
  handler: async (ctx, { clerkSubject, attempt }) => {
    const failure = await deleteFromClerk(clerkSubject);
    if (failure === null) {
      await ctx.scheduler.runAfter(PURGED_ROW_GRACE, internal.users.removePurgedUser, { clerkSubject });
      return null;
    }
    const delay = CLERK_RETRY_DELAYS[attempt];
    if (delay === undefined) {
      console.error(
        `Gave up deleting Clerk identity ${clerkSubject} after ${attempt + 1} attempts (${failure}). ` +
          "Its MangaDB data is purged; its User row stays, marked deleting, until a day after the identity is gone. " +
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

/**
 * Delete a subject's User row, only if it is still the marked row the
 * purge has emptied (`purgedAt`). deleteClerkIdentity schedules it
 * PURGED_ROW_GRACE after Clerk confirms. Anything else (no row, a live
 * one, a purge still running) is left alone, so a second removal, from a
 * repeated Clerk success, does nothing.
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
 * The most units of work one purgeUser run takes: a row deleted or
 * detached, or a Rating deleted with its aggregates. A unit reads at most
 * nine documents (counting the read inside each patch and delete), writes
 * at most four and queries at most four index ranges, so a run stays near
 * 1,800 documents read, 800 written and 800 ranges, far inside the 32,000,
 * 16,000 and 4,096 limits. Bytes are bounded by PURGE_RESERVE instead.
 */
export const PURGE_BATCH = 200;

/**
 * The read and write budget purgeUser keeps in hand before each unit of
 * work; with less left, the run stops and reschedules itself. Every patch
 * and delete reads the document it changes, and that read counts too. The
 * most expensive unit is a Series Rating whose rank moves: it reads the
 * library pack it shares with about 1,000 Series twice (the lookup in
 * seriesBrowse.syncRatingProjection, then the patch that rewrites it) and
 * writes it once, and a pack may reach the 1 MiB document limit: 2 MiB
 * read, 1 MiB written. Its other documents (the Rating, its ratingStats
 * and seriesStats rows) are a few KB, and every other unit reads well
 * under 100 KB (a Review of 5,000 characters is at most 15,000 bytes of
 * text, read by the query and again by the delete). The 1 MiB over that
 * covers those rows, the next row a query fetches before the check that
 * stops the run, and the run's last writes, so a run ends under the
 * 16 MiB limits.
 */
export const PURGE_RESERVE = 3 * 1024 * 1024;

/**
 * Empty a deleting User's personal tables, one unit of work at a time
 * while the run has room (purgeRoom), rescheduling itself until one run
 * reads every table to its end. That run, in the same transaction, sets
 * `purgedAt` and schedules redactMergeManifests and deleteClerkIdentity,
 * so no row inserted meanwhile (by a merge, say) is left behind. The row
 * itself stays, marked, until a day after Clerk has deleted the sign-in
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

    const room = purgeRoom(ctx);
    const remove = (row: { _id: Id<TableNames> }) => ctx.db.delete(row._id);
    // Each step is true once it has read its table to the end. The first
    // that stops for want of room ends the run: what it left, and every
    // later table, waits for the next one. A run always takes at least one
    // unit, so each makes progress.
    const steps = [
      () => purgeUserComments(ctx, userId, room),
      () => drain(ctx.db.query("reviews").withIndex("by_user", (q) => q.eq("userId", userId)), room, remove),
      () =>
        drain(ctx.db.query("ratings").withIndex("by_user", (q) => q.eq("userId", userId)), room, async (row) => {
          await ctx.db.delete(row._id);
          const target = targetOfRow(row);
          if (target) await applyRatingDelta(ctx, target, row.score, null);
        }),
      () => drain(ctx.db.query("favorites").withIndex("by_user", (q) => q.eq("userId", userId)), room, remove),
      () => drain(ctx.db.query("collectionEntries").withIndex("by_user", (q) => q.eq("userId", userId)), room, remove),
      () =>
        drain(ctx.db.query("userSeriesStates").withIndex("by_user_series", (q) => q.eq("userId", userId)), room, remove),
      () =>
        drain(ctx.db.query("releaseProgress").withIndex("by_user_release", (q) => q.eq("userId", userId)), room, remove),
      () =>
        drain(ctx.db.query("volumeProgress").withIndex("by_user_volume", (q) => q.eq("userId", userId)), room, remove),
    ];
    for (const step of steps) {
      if (!(await step())) {
        await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId });
        return;
      }
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

/**
 * One purgeUser run's allowance: each call answers whether one more unit
 * of work fits, and counts it when it does. A unit fits while the run has
 * taken fewer than PURGE_BATCH and has at least PURGE_RESERVE of its read
 * and write budgets left, as the transaction measures them.
 */
function purgeRoom(ctx: MutationCtx): PurgeRoom {
  let taken = 0;
  return async () => {
    if (taken >= PURGE_BATCH) return false;
    const { bytesRead, bytesWritten } = await ctx.meta.getTransactionMetrics();
    if (Math.min(bytesRead.remaining, bytesWritten.remaining) < PURGE_RESERVE) return false;
    taken += 1;
    return true;
  };
}

/** Remove `rows` one unit each while `room` allows; true when the rows ran out first. */
async function drain<Row>(rows: AsyncIterable<Row>, room: PurgeRoom, remove: (row: Row) => Promise<void>) {
  for await (const row of rows) {
    if (!(await room())) return false;
    await remove(row);
  }
  return true;
}

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
