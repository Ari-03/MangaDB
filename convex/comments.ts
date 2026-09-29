// Comments (CONTEXT.md: Comment, Comment Report, Shadowed User): short
// public plain-text posts on a Series or Volume page, with one level of
// replies. Post-moderated: a Comment is published on insert unless a hold
// rule sends it to the Data Team's queue (/mod/comments) first, and three
// distinct reports hide a published one until a Moderator decides. Every
// Moderator decision lands in commentAudit.
//
// Visibility, per viewer:
// - approved: everyone;
// - pending: its author ("Awaiting review") and the queue;
// - hidden: its author ("Hidden by moderators", no body) and the queue;
// - shadowed (written while its author is a Shadowed User, or turned so by
//   setShadowed): its author, as if approved; nobody else;
// - removed: nobody;
// - a thread head that is removed, or that the viewer cannot see (hidden or
//   shadowed), stays as a "[removed]" / "[hidden]" placeholder while it has
//   replies the viewer can see, so the thread keeps its shape.
//
// Shadowing is a status rather than a read-time filter so the page's
// indexes stay exact: a shadowed spammer's rows never take a page's slots.
// A head's `replyCount` (approved replies) moves with every status change
// of a reply (`patchComment`), which bounds both the page's reply reads and
// the placeholder scan.
//
// While FEATURES.comments is off (lib/features.ts), `post`, `edit`, and
// `report` refuse with code "disabled" and `list` / `replies` answer empty.
// Deleting one's own Comment, moderation, and the account purge still work.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import type { WithoutSystemFields } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireUser, viewerOrNull } from "./lib/auth";
import { FEATURES } from "./lib/features";
import {
  pageTargetIdArg,
  pageTargetRefArg,
  requireActiveTarget,
  resolveTarget,
  type PageTargetId,
} from "./lib/ratings";
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
  /** The most top-level Comments one `list` call returns; "More comments" stops there. */
  maxThreads: 60,
  /** Replies shown under a thread before "N more replies" (the `replies` query). */
  inlineReplies: 5,
} as const;

/** The most replies the `replies` query returns for one thread. */
const REPLIES_MAX = 100;
/** The viewer's own Comments on one page that `list` and `replies` consider. */
const OWN_MAX = 200;
/** Gone thread heads `list` reads per status while looking for ones that need a placeholder. */
const PLACEHOLDER_SCAN = 200;
/** setShadowed moves an author's Comments this many at a time, up to SHADOW_MAX. */
const SHADOW_BATCH = 500;
const SHADOW_MAX = 2000;
const QUEUE_PAGE = 100;
const REASON_MAX = 500;

export const COMMENT_RATE_LIMIT = {
  commentPost: { kind: "token bucket", rate: 20, period: HOUR, capacity: 5 },
  commentReport: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, COMMENT_RATE_LIMIT);

type Comment = Doc<"comments">;
type Status = Comment["status"];
type User = Doc<"users">;

const isModerator = (user: User | null) =>
  Boolean(user && !user.suspended && (user.role === "moderator" || user.role === "administrator"));
const isDataTeam = (user: User | null) => Boolean(user && !user.suspended && user.role);

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

/** Refuse a Comment write while FEATURES.comments is off. */
function requireCommentsOn() {
  if (!FEATURES.comments) fail("disabled", "Comments are switched off for now.");
}

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
async function keysOf(ctx: QueryCtx, target: PageTargetId) {
  if (target.kind === "series") return { seriesId: target.id, volumeId: undefined };
  const volume = await ctx.db.get(target.id);
  if (!volume) return fail("notFound", "Nothing to comment on here any more.");
  return { seriesId: volume.seriesId, volumeId: target.id };
}
type Keys = Awaited<ReturnType<typeof keysOf>>;

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

/** Add `delta` to a thread head's approved-reply count. */
async function bumpReplyCount(ctx: MutationCtx, headId: Id<"comments">, delta: number) {
  if (delta === 0) return;
  const head = await ctx.db.get(headId);
  if (head) await ctx.db.patch(head._id, { replyCount: Math.max(0, (head.replyCount ?? 0) + delta) });
}

/**
 * Patch a Comment. When a reply's status moves into or out of approved, its
 * head's `replyCount` follows in the same transaction. Every status change
 * goes through here.
 */
async function patchComment(ctx: MutationCtx, comment: Comment, patch: Partial<WithoutSystemFields<Comment>>) {
  await ctx.db.patch(comment._id, patch);
  if (comment.parentId && patch.status !== undefined) {
    const delta = Number(patch.status === "approved") - Number(comment.status === "approved");
    await bumpReplyCount(ctx, comment.parentId, delta);
  }
}

// ---------- reading ----------

/** A Comment as the viewer sees it; null when they see nothing at all. */
type Shown = "approved" | "pending" | "hidden";
/** A thread head kept only for its replies: removed, or withheld from this viewer. */
type Placeholder = "removed" | "withheld";

function shownAs(comment: Comment, author: User | null, viewer: User | null): Shown | null {
  if (comment.status === "removed") return null;
  if (viewer && comment.userId === viewer._id) {
    // A Shadowed User sees their own shadowed Comments as published; a
    // moderator's hide still reads as hidden so the note and the refused
    // edit agree.
    if (comment.status === "shadowed") return "approved";
    return comment.status;
  }
  // The author check covers approved rows setShadowed's cap left behind.
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
type AuthorOf = ReturnType<typeof authorCache>;

/** A Comment for the page. A placeholder carries nothing about the Comment beyond its ID. */
function card(comment: Comment, author: User | null, viewer: User | null, state: Shown | Placeholder) {
  const placeholder = state === "removed" || state === "withheld";
  const hideBody = placeholder || state === "hidden";
  return {
    commentId: comment._id,
    username: placeholder ? null : (author?.username ?? null),
    own: !placeholder && viewer !== null && comment.userId === viewer._id,
    state,
    body: hideBody ? "" : comment.body,
    spoiler: hideBody ? false : comment.spoiler,
    createdAt: placeholder ? 0 : comment.createdAt,
    edited: !placeholder && comment.editedAt !== undefined,
  };
}

/** The viewer's own Comments on one page, newest first, grouped by thread head (top level under null). */
async function ownRows(ctx: QueryCtx, viewer: User | null, keys: Keys) {
  const byParent = new Map<Id<"comments"> | null, Comment[]>();
  if (!viewer) return byParent;
  const rows = await ctx.db
    .query("comments")
    .withIndex("by_user_target", (q) =>
      q.eq("userId", viewer._id).eq("seriesId", keys.seriesId).eq("volumeId", keys.volumeId),
    )
    .order("desc")
    .take(OWN_MAX);
  for (const row of rows) {
    const key = row.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  return byParent;
}
type OwnRows = Awaited<ReturnType<typeof ownRows>>;

/**
 * The replies to one thread head the viewer sees, oldest first: the first
 * `take` approved ones plus every one of the viewer's own (so a fresh or
 * held reply always shows), and how many approved ones wait behind
 * "N more replies".
 */
async function threadReplies(
  ctx: QueryCtx,
  head: Comment,
  own: OwnRows,
  authorOf: AuthorOf,
  viewer: User | null,
  take: number,
) {
  const approved = await ctx.db
    .query("comments")
    .withIndex("by_parent", (q) => q.eq("parentId", head._id).eq("status", "approved"))
    .take(take);
  const seen = new Set(approved.map((row) => row._id));
  const rows = [...approved, ...(own.get(head._id) ?? []).filter((row) => !seen.has(row._id))];
  rows.sort((a, b) => a._creationTime - b._creationTime);
  const replies = [];
  for (const reply of rows) {
    const author = await authorOf(reply.userId);
    const state = shownAs(reply, author, viewer);
    if (state) replies.push(card(reply, author, viewer, state));
  }
  const shownApproved = rows.filter((row) => row.status === "approved").length;
  return { replies, moreReplies: Math.max(0, (head.replyCount ?? 0) - shownApproved) };
}

/**
 * A page's Comments for the viewer: the newest `limit` top-level threads
 * (default one page, at most `maxThreads`), each with its first
 * `inlineReplies` visible replies oldest first and the count behind them,
 * plus the target ID `post` takes. Signed out it is the same for everyone,
 * so the page loaders render it; signed in it adds the viewer's own held,
 * hidden, and shadowed Comments. Null when the target is unknown or hidden;
 * an empty page while FEATURES.comments is off.
 */
export const list = query({
  args: { target: pageTargetRefArg, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const resolved = await resolveTarget(ctx, args.target);
    if (!resolved) return null;
    if (!FEATURES.comments) return { target: resolved.target, items: [], hasMore: false };
    const limit = Math.max(1, Math.min(COMMENT_POLICY.maxThreads, Math.floor(args.limit ?? COMMENT_POLICY.page)));
    const viewer = await viewerOrNull(ctx);
    const authorOf = authorCache(ctx);
    const keys = await keysOf(ctx, resolved.target);
    const own = await ownRows(ctx, viewer, keys);

    const heads = (status: Status) =>
      ctx.db
        .query("comments")
        .withIndex("by_target_thread_status", (q) =>
          q.eq("seriesId", keys.seriesId).eq("volumeId", keys.volumeId).eq("parentId", undefined).eq("status", status),
        )
        .order("desc");
    // Published threads, the viewer's own, and gone heads that still carry
    // replies (a placeholder). Only heads with approved replies, or the
    // viewer's own, can need one; the scan per status is capped. Pending
    // is scanned too: a re-held head (an edit that added links) keeps the
    // replies it gathered while it was published.
    const candidates = new Map<Id<"comments">, Comment>();
    for (const row of await heads("approved").take(limit + 1)) candidates.set(row._id, row);
    for (const row of own.get(null) ?? []) candidates.set(row._id, row);
    for (const status of ["removed", "hidden", "shadowed", "pending"] as const) {
      let scanned = 0;
      let found = 0;
      for await (const row of heads(status)) {
        if (scanned++ >= PLACEHOLDER_SCAN || found > limit) break;
        if ((row.replyCount ?? 1) > 0 || own.has(row._id)) {
          candidates.set(row._id, row);
          found++;
        }
      }
    }
    const ordered = [...candidates.values()].sort((a, b) => b._creationTime - a._creationTime);

    const items = [];
    for (const head of ordered) {
      if (items.length > limit) break;
      const author = await authorOf(head.userId);
      const state = shownAs(head, author, viewer);
      const thread = await threadReplies(ctx, head, own, authorOf, viewer, COMMENT_POLICY.inlineReplies);
      if (state) items.push({ ...card(head, author, viewer, state), ...thread });
      else if (thread.replies.length > 0) {
        items.push({ ...card(head, author, viewer, head.status === "removed" ? "removed" : "withheld"), ...thread });
      }
    }
    return {
      target: resolved.target,
      items: items.slice(0, limit),
      hasMore: items.length > limit,
    };
  },
});

/**
 * Every reply to one thread the viewer sees (up to 100), oldest first, for
 * "N more replies". Null when the target is unknown or hidden, or the
 * Comment is not a thread head on it.
 */
export const replies = query({
  args: { target: pageTargetRefArg, commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const resolved = await resolveTarget(ctx, args.target);
    if (!resolved) return null;
    if (!FEATURES.comments) return [];
    const keys = await keysOf(ctx, resolved.target);
    const head = await ctx.db.get(args.commentId);
    if (!head || head.parentId || head.seriesId !== keys.seriesId || head.volumeId !== keys.volumeId) return null;
    const viewer = await viewerOrNull(ctx);
    const own = await ownRows(ctx, viewer, keys);
    const thread = await threadReplies(ctx, head, own, authorCache(ctx), viewer, REPLIES_MAX);
    return thread.replies;
  },
});

// ---------- writing ----------

/**
 * Post a Comment, or a reply to a top-level one, on a Series or Volume:
 * 1 to 2,000 characters of plain text, optionally marked as a spoiler.
 * Published at once unless a hold rule fires (`held`), in which case only
 * its author and the queue see it until a Moderator approves it. A Shadowed
 * User's Comment is stored as shadowed, whatever the hold rules say, and
 * reported to them as published.
 */
export const post = mutation({
  args: {
    target: pageTargetIdArg,
    parentId: v.optional(v.id("comments")),
    body: v.string(),
    spoiler: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireCommentsOn();
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "commentPost", { key: user._id, throws: true });
    const body = cleanBody(args.body);
    const { target } = await requireActiveTarget(ctx, args.target, "Nothing to comment on here any more.");
    const keys = await keysOf(ctx, target);
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent) return fail("notFound", "That comment is gone.");
      if (parent.parentId) fail("replyDepth", "Reply to the comment at the top of the thread.");
      if (parent.seriesId !== keys.seriesId || parent.volumeId !== keys.volumeId) {
        fail("wrongTarget", "That comment belongs to another page.");
      }
      const ownOpen = parent.userId === user._id && (parent.status === "pending" || parent.status === "shadowed");
      if (parent.status !== "approved" && !ownOpen) fail("closed", "That comment is no longer open for replies.");
    }
    const held = !user.commentShadowed && (await holdReasons(ctx, user, body)).length > 0;
    const status = user.commentShadowed ? "shadowed" : held ? "pending" : "approved";
    const commentId = await ctx.db.insert("comments", {
      userId: user._id,
      ...keys,
      ...(args.parentId ? { parentId: args.parentId } : { replyCount: 0 }),
      body,
      spoiler: args.spoiler,
      status,
      reportCount: 0,
      createdAt: Date.now(),
    });
    if (args.parentId && status === "approved") await bumpReplyCount(ctx, args.parentId, 1);
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
 * Rewrite the viewer's own approved, pending, or shadowed Comment. An edit
 * that adds more than two links sends an approved Comment back to the
 * queue, so a clean post cannot be turned into spam afterwards (a shadowed
 * one stays shadowed).
 */
export const edit = mutation({
  args: { commentId: v.id("comments"), body: v.string(), spoiler: v.boolean() },
  handler: async (ctx, args) => {
    requireCommentsOn();
    const user = await requireUser(ctx);
    const comment = await requireOwn(ctx, user, args.commentId);
    if (comment.status !== "approved" && comment.status !== "pending" && comment.status !== "shadowed") {
      fail("badState", "This comment can no longer be edited.");
    }
    const body = cleanBody(args.body);
    const relinked =
      comment.status === "approved" && !isDataTeam(user) && linkCount(body) > COMMENT_POLICY.maxLinks;
    const now = Date.now();
    await patchComment(ctx, comment, {
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
    await patchComment(ctx, comment, { status: "removed", updatedAt: Date.now() });
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
    requireCommentsOn();
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
    await patchComment(ctx, comment, {
      reportCount,
      ...(hide ? { status: "hidden" as const, updatedAt: Date.now() } : {}),
    });
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
  // On a published Comment, approve means "dismiss its reports".
  approve: { from: ["pending", "approved"], to: "approved" },
  hide: { from: ["approved", "pending", "shadowed"], to: "hidden" },
  unhide: { from: ["hidden"], to: "approved" },
  remove: { from: ["approved", "pending", "hidden", "shadowed"], to: "removed" },
  restore: { from: ["removed"], to: "approved" },
} as const satisfies Record<string, { from: ReadonlyArray<Status>; to: Status }>;

/**
 * A Moderator's decision on one Comment, audited with an optional reason.
 * Every move to `approved` clears the Comment's reports, and lands on
 * `shadowed` instead while its author is a Shadowed User. Approving a
 * published Comment needs reports to dismiss. Restore refuses a Comment its
 * author deleted.
 */
export const moderate = mutation({
  args: { commentId: v.id("comments"), action: moderationAction, reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const moderator = await requireModerator(ctx);
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return fail("notFound", "That comment is gone.");
    const { from, to } = TRANSITIONS[args.action];
    if (!(from as ReadonlyArray<Status>).includes(comment.status)) {
      fail("badState", `Can't ${args.action} a comment that is ${comment.status}.`);
    }
    if (args.action === "approve" && comment.status === "approved" && comment.reportCount === 0) {
      fail("badState", "This comment is published and has no reports to dismiss.");
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
      const author = await ctx.db.get(comment.userId);
      await dismissReports(ctx, comment);
      await patchComment(ctx, comment, {
        status: author?.commentShadowed ? "shadowed" : "approved",
        reportCount: 0,
        updatedAt: Date.now(),
      });
    } else {
      await patchComment(ctx, comment, { status: to, updatedAt: Date.now() });
    }
    await audit(ctx, comment._id, args.action, { kind: "user", userId: moderator._id }, reasonOf(args.reason));
    return null;
  },
});

/**
 * Move a user's Comments from one status to another, SHADOW_BATCH at a
 * time, stopping after SHADOW_MAX. Rows past the cap keep their status:
 * leftover approved rows of a Shadowed User are still hidden by `shownAs`,
 * they just take page slots.
 */
async function moveStatus(ctx: MutationCtx, userId: Id<"users">, from: Status, to: Status) {
  let moved = 0;
  while (moved < SHADOW_MAX) {
    const batch = await ctx.db
      .query("comments")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("status", from))
      .take(Math.min(SHADOW_BATCH, SHADOW_MAX - moved));
    for (const row of batch) await patchComment(ctx, row, { status: to });
    moved += batch.length;
    if (batch.length < SHADOW_BATCH) break;
  }
  return moved;
}

/**
 * Shadow or unshadow a Comment's author (a Shadowed User's Comments look
 * published to them and are hidden from everyone else). Shadowing turns
 * their approved Comments into shadowed ones; unshadowing publishes every
 * shadowed one, including those written while shadowed. Audited against
 * the Comment that prompted it. A no-op change records nothing.
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
    if (args.shadowed) await moveStatus(ctx, author._id, "approved", "shadowed");
    else await moveStatus(ctx, author._id, "shadowed", "approved");
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
  const comments = ctx.db.query("comments");
  switch (tab) {
    case "pending": // oldest first: the longest wait at the top
      return comments.withIndex("by_status_time", (q) => q.eq("status", "pending")).order("asc").take(take);
    case "reported": // most reported first
      return comments
        .withIndex("by_status", (q) => q.eq("status", "approved").gte("reportCount", 1))
        .order("desc")
        .take(take);
    default: // newest first
      return comments.withIndex("by_status_time", (q) => q.eq("status", tab)).order("desc").take(take);
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
      if (reply.userId !== userId) await ctx.db.patch(reply._id, { parentId: undefined, replyCount: 0 });
    }
    // Another user's thread loses one approved reply (a no-op once its head is gone).
    if (comment.parentId && comment.status === "approved") await bumpReplyCount(ctx, comment.parentId, -1);
    await ctx.db.delete(comment._id);
  }
}
