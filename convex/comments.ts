// Comments (CONTEXT.md: Comment, Comment Report, Shadowed User): short
// public plain-text posts on a Series or Volume page, with one level of
// replies. Post-moderated: a Comment is published on insert unless a hold
// rule sends it to the Data Team's queue (/mod/comments) first, and three
// distinct reports hide a published one until a Moderator decides. Every
// Moderator decision lands in commentAudit.
//
// Visibility, per viewer:
// - approved: everyone, unless its author is shadowed;
// - pending: its author ("Awaiting review") and the queue;
// - hidden: its author ("Hidden by moderators", no body) and the queue;
// - removed: nobody; a removed top-level Comment with visible replies
//   stays as a "[removed]" placeholder so the thread keeps its shape;
// - a shadowed author sees their own pending, hidden and approved Comments
//   as published; nobody else sees any of them.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireUser, viewerOrNull } from "./lib/auth";
import { requireActiveTarget, resolveTarget, targetIdArg, targetRefArg, type TargetId } from "./lib/ratings";
import { requireDataTeam, requireModerator } from "./lib/roles";
import { volumeTitle } from "./lib/titles";
import { commentReportReason } from "./schema";

const DAY = 24 * HOUR;

/** Hold rules, the auto-hide threshold, and the size limits in one place. */
export const COMMENT_POLICY = {
  /** Accounts younger than this post into the queue. */
  minAccountAgeMs: 7 * DAY,
  /** Authors with fewer approved Comments than this post into the queue. */
  minApprovedComments: 3,
  /** Bodies with more `http(s)://` links than this go to the queue. */
  maxLinks: 2,
  /** Distinct reports that hide an approved Comment. */
  autoHideReports: 3,
  maxLength: 2000,
  noteMaxLength: 500,
  /** Top-level Comments per page; "more" asks for another page's worth. */
  page: 20,
} as const;

const LIMIT_MAX = 200;
const REPLIES_MAX = 100;
const QUEUE_PAGE = 100;
const REASON_MAX = 500;

export const COMMENT_RATE_LIMIT = {
  commentPost: { kind: "token bucket", rate: 20, period: HOUR, capacity: 5 },
  commentReport: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, COMMENT_RATE_LIMIT);

type Comment = Doc<"comments">;
type User = Doc<"users">;

const isModerator = (user: User | null) =>
  Boolean(user && !user.suspended && (user.role === "moderator" || user.role === "administrator"));
const isDataTeam = (user: User | null) => Boolean(user && !user.suspended && user.role);

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

/** Trim, unify line endings, and hold a Comment body to 1-2,000 characters. */
function cleanBody(raw: string): string {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) fail("commentEmpty", "Write something first.");
  if (body.length > COMMENT_POLICY.maxLength) {
    fail("commentTooLong", `Keep comments under ${COMMENT_POLICY.maxLength} characters.`);
  }
  return body;
}

const linkCount = (body: string) => body.match(/https?:\/\//gi)?.length ?? 0;

/**
 * Why a new Comment from `user` would be held for review; empty means it
 * publishes at once. The Data Team is never held.
 */
async function holdReasons(ctx: QueryCtx, user: User, body: string) {
  if (isDataTeam(user)) return [];
  const reasons: Array<"newAccount" | "fewApproved" | "links"> = [];
  if (Date.now() - user._creationTime < COMMENT_POLICY.minAccountAgeMs) reasons.push("newAccount");
  const approved = await ctx.db
    .query("comments")
    .withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "approved"))
    .take(COMMENT_POLICY.minApprovedComments);
  if (approved.length < COMMENT_POLICY.minApprovedComments) reasons.push("fewApproved");
  if (linkCount(body) > COMMENT_POLICY.maxLinks) reasons.push("links");
  return reasons;
}

/** The (seriesId, volumeId) pair a target's Comments are stored under. */
async function keysOf(ctx: QueryCtx, target: TargetId) {
  if (target.kind === "series") return { seriesId: target.id, volumeId: undefined };
  const volume = await ctx.db.get(target.id);
  if (!volume) return fail("notFound", "Nothing to comment on here any more.");
  return { seriesId: volume.seriesId, volumeId: target.id };
}

function reasonOf(raw: string | undefined) {
  const reason = raw?.trim().slice(0, REASON_MAX);
  return reason ? { reason } : {};
}

async function audit(
  ctx: MutationCtx,
  commentId: Id<"comments">,
  action: Doc<"commentAudit">["action"],
  actor: Doc<"commentAudit">["actor"],
  extra: { reason?: string; userId?: Id<"users"> } = {},
) {
  await ctx.db.insert("commentAudit", { commentId, action, actor, ...extra });
}

// ---------- reading ----------

/** A Comment as the viewer sees it; null when they see nothing at all. */
type Shown = "approved" | "pending" | "hidden";

function shownAs(comment: Comment, author: User | null, viewer: User | null): Shown | null {
  if (comment.status === "removed") return null;
  if (viewer && comment.userId === viewer._id) {
    return viewer.commentShadowed ? "approved" : comment.status;
  }
  if (comment.status !== "approved" || author?.commentShadowed) return null;
  return "approved";
}

/** Memoised author lookups for one query. */
function authorCache(ctx: QueryCtx) {
  const cache = new Map<Id<"users">, User | null>();
  return async (userId: Id<"users">) => {
    if (!cache.has(userId)) cache.set(userId, await ctx.db.get(userId));
    return cache.get(userId) ?? null;
  };
}

function card(comment: Comment, author: User | null, viewer: User | null, state: Shown | "removed") {
  const hideBody = state === "hidden" || state === "removed";
  return {
    commentId: comment._id,
    username: state === "removed" ? null : (author?.username ?? null),
    own: state !== "removed" && viewer !== null && comment.userId === viewer._id,
    state,
    body: hideBody ? "" : comment.body,
    spoiler: hideBody ? false : comment.spoiler,
    createdAt: comment.createdAt,
    edited: comment.editedAt !== undefined,
  };
}

/**
 * A page's Comments for the viewer: the newest `limit` top-level threads
 * (default one page), each with its visible replies oldest first, plus the
 * target ID `post` takes. Signed out it is the same for everyone, so the page
 * loaders render it; signed in it adds the viewer's own held and hidden
 * Comments. Null when the target is unknown or hidden.
 */
export const list = query({
  args: { target: targetRefArg, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const resolved = await resolveTarget(ctx, args.target);
    if (!resolved) return null;
    const limit = Math.max(1, Math.min(LIMIT_MAX, Math.floor(args.limit ?? COMMENT_POLICY.page)));
    const viewer = await viewerOrNull(ctx);
    const authorOf = authorCache(ctx);
    const { seriesId, volumeId } = await keysOf(ctx, resolved.target);

    const threads = (status: Comment["status"]) =>
      ctx.db
        .query("comments")
        .withIndex("by_target_thread_status", (q) =>
          q.eq("seriesId", seriesId).eq("volumeId", volumeId).eq("parentId", undefined).eq("status", status),
        )
        .order("desc")
        .take(limit + 1);
    // Published threads, removed ones that may still carry replies, and the
    // viewer's own that only they see; merged newest first.
    const candidates = [...(await threads("approved")), ...(await threads("removed"))];
    if (viewer) {
      const own = await ctx.db
        .query("comments")
        .withIndex("by_user_target", (q) =>
          q.eq("userId", viewer._id).eq("seriesId", seriesId).eq("volumeId", volumeId),
        )
        .take(LIMIT_MAX);
      const seen = new Set(candidates.map((row) => row._id));
      candidates.push(...own.filter((row) => row.parentId === undefined && !seen.has(row._id)));
    }
    candidates.sort((a, b) => b._creationTime - a._creationTime);

    const items = [];
    for (const comment of candidates) {
      if (items.length > limit) break;
      const replyRows = await ctx.db
        .query("comments")
        .withIndex("by_parent", (q) => q.eq("parentId", comment._id))
        .take(REPLIES_MAX);
      const replies = [];
      for (const reply of replyRows) {
        const author = await authorOf(reply.userId);
        const state = shownAs(reply, author, viewer);
        if (state) replies.push(card(reply, author, viewer, state));
      }
      const author = await authorOf(comment.userId);
      const state = shownAs(comment, author, viewer);
      if (state) items.push({ ...card(comment, author, viewer, state), replies });
      else if (comment.status === "removed" && replies.length > 0) {
        items.push({ ...card(comment, author, viewer, "removed"), replies });
      }
    }
    return {
      target: resolved.target,
      items: items.slice(0, limit),
      hasMore: items.length > limit,
    };
  },
});

// ---------- writing ----------

/**
 * Post a Comment, or a reply to a top-level one, on a Series or Volume:
 * 1 to 2,000 characters of plain text, optionally marked as a spoiler.
 * Published at once unless a hold rule fires (`held`), in which case only
 * its author and the queue see it until a Moderator approves it.
 */
export const post = mutation({
  args: {
    target: targetIdArg,
    parentId: v.optional(v.id("comments")),
    body: v.string(),
    spoiler: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "commentPost", { key: user._id, throws: true });
    const body = cleanBody(args.body);
    const keys = await keysOf(ctx, await requireActiveTarget(ctx, args.target));
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent) return fail("notFound", "That comment is gone.");
      if (parent.parentId) fail("replyDepth", "Reply to the comment at the top of the thread.");
      if (parent.seriesId !== keys.seriesId || parent.volumeId !== keys.volumeId) {
        fail("wrongTarget", "That comment belongs to another page.");
      }
      const open = parent.status === "approved" || (parent.status === "pending" && parent.userId === user._id);
      if (!open) fail("closed", "That comment is no longer open for replies.");
    }
    const held = (await holdReasons(ctx, user, body)).length > 0;
    const commentId = await ctx.db.insert("comments", {
      userId: user._id,
      ...keys,
      ...(args.parentId ? { parentId: args.parentId } : {}),
      body,
      spoiler: args.spoiler,
      status: held ? "pending" : "approved",
      reportCount: 0,
      createdAt: Date.now(),
    });
    return { commentId, held, seriesId: keys.seriesId };
  },
});

async function requireOwn(ctx: MutationCtx, user: User, commentId: Id<"comments">) {
  const comment = await ctx.db.get(commentId);
  if (!comment) return fail("notFound", "That comment is gone.");
  if (comment.userId !== user._id) fail("forbidden", "Only its author can change a comment.");
  return comment;
}

/**
 * Rewrite the viewer's own approved or pending Comment. An edit that adds
 * more than two links sends an approved Comment back to the queue, so a
 * clean post cannot be turned into spam afterwards.
 */
export const edit = mutation({
  args: { commentId: v.id("comments"), body: v.string(), spoiler: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const comment = await requireOwn(ctx, user, args.commentId);
    if (comment.status !== "approved" && comment.status !== "pending") {
      fail("badState", "This comment can no longer be edited.");
    }
    const body = cleanBody(args.body);
    const relinked = !isDataTeam(user) && linkCount(body) > COMMENT_POLICY.maxLinks;
    const now = Date.now();
    await ctx.db.patch(comment._id, {
      body,
      spoiler: args.spoiler,
      editedAt: now,
      updatedAt: now,
      ...(relinked ? { status: "pending" as const } : {}),
    });
    return { held: relinked || comment.status === "pending" };
  },
});

/**
 * Delete the viewer's own Comment: it becomes `removed` (the row stays for
 * the audit trail and to hold a thread's replies together until the author's
 * account purge). Moderators use `moderate` instead.
 */
export const remove = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, { commentId }) => {
    const user = await requireUser(ctx);
    const comment = await requireOwn(ctx, user, commentId);
    if (comment.status === "removed") return null;
    await ctx.db.patch(comment._id, { status: "removed", updatedAt: Date.now() });
    await audit(ctx, comment._id, "remove", { kind: "user", userId: user._id }, { reason: "Deleted by its author" });
    return null;
  },
});

/**
 * Report someone else's published Comment, once per user per Comment. The
 * third distinct report hides it (an audit row with the system as actor)
 * until a Moderator decides.
 */
export const report = mutation({
  args: {
    commentId: v.id("comments"),
    reason: commentReportReason,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "commentReport", { key: user._id, throws: true });
    const comment = await ctx.db.get(args.commentId);
    if (!comment || comment.status !== "approved") return fail("notFound", "That comment is gone.");
    if (comment.userId === user._id) fail("ownComment", "You can't report your own comment.");
    const note = args.note?.trim();
    if (note && note.length > COMMENT_POLICY.noteMaxLength) {
      fail("noteTooLong", `Keep the note under ${COMMENT_POLICY.noteMaxLength} characters.`);
    }
    const existing = await ctx.db
      .query("commentReports")
      .withIndex("by_comment_reporter", (q) => q.eq("commentId", comment._id).eq("reporterId", user._id))
      .unique();
    if (existing) fail("alreadyReported", "You already reported this comment.");
    await ctx.db.insert("commentReports", {
      commentId: comment._id,
      reporterId: user._id,
      reason: args.reason,
      ...(note ? { note } : {}),
      createdAt: Date.now(),
    });
    const reportCount = comment.reportCount + 1;
    const hide = reportCount >= COMMENT_POLICY.autoHideReports;
    await ctx.db.patch(comment._id, { reportCount, ...(hide ? { status: "hidden" as const, updatedAt: Date.now() } : {}) });
    if (hide) {
      await audit(ctx, comment._id, "hide", { kind: "system" }, { reason: `${reportCount} reports` });
    }
    return { hidden: hide };
  },
});

// ---------- moderation ----------

/** Clear a Comment's reports once a Moderator has decided it may stand. */
async function dismissReports(ctx: MutationCtx, comment: Comment) {
  const reports = await ctx.db
    .query("commentReports")
    .withIndex("by_comment_reporter", (q) => q.eq("commentId", comment._id))
    .collect();
  for (const row of reports) await ctx.db.delete(row._id);
}

const moderationAction = v.union(
  v.literal("approve"),
  v.literal("hide"),
  v.literal("unhide"),
  v.literal("remove"),
  v.literal("restore"),
);

/** The statuses each action applies to, and where it leaves the Comment. */
const TRANSITIONS = {
  // Approving a published Comment dismisses its reports.
  approve: { from: ["pending", "approved"], to: "approved" },
  hide: { from: ["approved", "pending"], to: "hidden" },
  unhide: { from: ["hidden"], to: "approved" },
  remove: { from: ["approved", "pending", "hidden"], to: "removed" },
  restore: { from: ["removed"], to: "approved" },
} as const satisfies Record<string, { from: ReadonlyArray<Comment["status"]>; to: Comment["status"] }>;

/**
 * A Moderator's decision on one Comment, audited with an optional reason.
 * Every move to `approved` clears the Comment's reports. Restore refuses a
 * Comment its author deleted.
 */
export const moderate = mutation({
  args: { commentId: v.id("comments"), action: moderationAction, reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const moderator = await requireModerator(ctx);
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return fail("notFound", "That comment is gone.");
    const { from, to } = TRANSITIONS[args.action];
    if (!(from as ReadonlyArray<Comment["status"]>).includes(comment.status)) {
      fail("badState", `Can't ${args.action} a comment that is ${comment.status}.`);
    }
    if (args.action === "restore") {
      const removals = await ctx.db
        .query("commentAudit")
        .withIndex("by_comment", (q) => q.eq("commentId", comment._id))
        .order("desc")
        .filter((q) => q.eq(q.field("action"), "remove"))
        .first();
      if (removals?.actor.kind === "user" && removals.actor.userId === comment.userId) {
        fail("authorDeleted", "Its author deleted this comment; it stays deleted.");
      }
    }
    if (to === "approved") {
      await dismissReports(ctx, comment);
      await ctx.db.patch(comment._id, { status: to, reportCount: 0, updatedAt: Date.now() });
    } else {
      await ctx.db.patch(comment._id, { status: to, updatedAt: Date.now() });
    }
    await audit(ctx, comment._id, args.action, { kind: "user", userId: moderator._id }, reasonOf(args.reason));
    return null;
  },
});

/**
 * Shadow or unshadow a Comment's author (a Shadowed User's Comments look
 * published to them and are hidden from everyone else). Audited against the
 * Comment that prompted it. A no-op change records nothing.
 */
export const setShadowed = mutation({
  args: { commentId: v.id("comments"), shadowed: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const moderator = await requireModerator(ctx);
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return fail("notFound", "That comment is gone.");
    const author = await ctx.db.get(comment.userId);
    if (!author) return fail("notFound", "Its author's account is gone.");
    if (Boolean(author.commentShadowed) === args.shadowed) return null;
    if (args.shadowed && isDataTeam(author)) fail("forbidden", "Data Team members can't be shadowed.");
    await ctx.db.patch(author._id, { commentShadowed: args.shadowed ? true : undefined });
    await audit(ctx, comment._id, args.shadowed ? "shadow" : "unshadow", { kind: "user", userId: moderator._id }, {
      ...reasonOf(args.reason),
      userId: author._id,
    });
    return null;
  },
});

// ---------- the queue ----------

const queueTab = v.union(v.literal("pending"), v.literal("reported"), v.literal("hidden"), v.literal("removed"));

function tabRows(ctx: QueryCtx, tab: "pending" | "reported" | "hidden" | "removed", take: number) {
  const byStatus = ctx.db.query("comments");
  switch (tab) {
    case "pending": // oldest first: the longest wait at the top
      return byStatus.withIndex("by_status", (q) => q.eq("status", "pending")).order("asc").take(take);
    case "reported": // most reported first
      return byStatus
        .withIndex("by_status", (q) => q.eq("status", "approved").gte("reportCount", 1))
        .order("desc")
        .take(take);
    default:
      return byStatus.withIndex("by_status", (q) => q.eq("status", tab)).order("desc").take(take);
  }
}

type ReasonCounts = Partial<Record<Doc<"commentReports">["reason"], number>>;

/**
 * One tab of the Comments queue (Data Team): pending (oldest first),
 * reported (published with reports, most reported first), hidden, and
 * removed (newest first, for Restore). Each row carries what a Moderator
 * needs to decide: the page it is on, author, body, and the reports.
 */
export const queue = query({
  args: { tab: queueTab },
  handler: async (ctx, { tab }) => {
    await requireDataTeam(ctx);
    const found = await tabRows(ctx, tab, QUEUE_PAGE + 1);
    const authorOf = authorCache(ctx);
    const rows = [];
    for (const comment of found.slice(0, QUEUE_PAGE)) {
      const author = await authorOf(comment.userId);
      const series = await ctx.db.get(comment.seriesId);
      const volume = comment.volumeId ? await ctx.db.get(comment.volumeId) : null;
      const reports = await ctx.db
        .query("commentReports")
        .withIndex("by_comment_reporter", (q) => q.eq("commentId", comment._id))
        .take(50);
      const reasons: ReasonCounts = {};
      for (const row of reports) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
      rows.push({
        commentId: comment._id,
        target: volume
          ? {
              kind: "volume" as const,
              publicId: volume.publicId,
              title: volumeTitle(series?.title ?? "", volume.label ?? null),
            }
          : { kind: "series" as const, publicId: series?.publicId ?? 0, title: series?.title ?? "(gone)" },
        username: author?.username ?? null,
        authorShadowed: Boolean(author?.commentShadowed),
        isReply: comment.parentId !== undefined,
        body: comment.body,
        spoiler: comment.spoiler,
        status: comment.status,
        reportCount: comment.reportCount,
        reasons,
        notes: reports.flatMap((row) => (row.note ? [{ reason: row.reason, note: row.note }] : [])),
        createdAt: comment.createdAt,
        edited: comment.editedAt !== undefined,
      });
    }
    return { rows, hasMore: found.length > QUEUE_PAGE };
  },
});

/**
 * How many Comments wait in each queue tab (capped at 100, shown as "100+"),
 * for the nav badge and the tabs. Null for anyone outside the Data Team, so
 * the nav can call it without a role check.
 */
export const queueCounts = query({
  args: {},
  handler: async (ctx) => {
    if (!isDataTeam(await viewerOrNull(ctx))) return null;
    const count = async (tab: "pending" | "reported" | "hidden") => (await tabRows(ctx, tab, QUEUE_PAGE)).length;
    return { pending: await count("pending"), reported: await count("reported"), hidden: await count("hidden") };
  },
});

// ---------- upkeep (users.purgeUser) ----------

/**
 * Hard-delete a User's Comments and Comment Reports: reports they filed
 * (lowering those Comments' counts, never unhiding one), reports on their
 * Comments, and the Comments themselves. Replies to a deleted Comment lose
 * their parent and become top-level. commentAudit rows stay, like
 * reviewAudit.
 */
export async function purgeUserComments(ctx: MutationCtx, userId: Id<"users">) {
  const filed = await ctx.db
    .query("commentReports")
    .withIndex("by_reporter", (q) => q.eq("reporterId", userId))
    .collect();
  for (const row of filed) {
    await ctx.db.delete(row._id);
    const comment = await ctx.db.get(row.commentId);
    if (comment && comment.userId !== userId) {
      await ctx.db.patch(comment._id, { reportCount: Math.max(0, comment.reportCount - 1) });
    }
  }
  const own = await ctx.db
    .query("comments")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const comment of own) {
    await dismissReports(ctx, comment);
    const replies = await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) => q.eq("parentId", comment._id))
      .collect();
    for (const reply of replies) {
      if (reply.userId !== userId) await ctx.db.patch(reply._id, { parentId: undefined });
    }
    await ctx.db.delete(comment._id);
  }
}
