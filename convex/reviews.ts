// Reviews (CONTEXT.md: Review): one public plain-text write-up per user per
// Series or Volume, shown on the target's page under its author's username
// with the author's Rating beside it. Plain text only: no Markdown, line
// breaks kept. Post-moderated: a Moderator hides a Review (reviewAudit
// records who and why), after which only Moderators and its author see it.
// Hidden stays hidden through the author's edits.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireUser, viewerOrNull } from "./lib/auth";
import {
  ratingRow,
  requireActiveTarget,
  resolveTarget,
  reviewRow,
  targetFields,
  targetIdArg,
  targetOfRow,
  targetRefArg,
  type TargetId,
} from "./lib/ratings";
import { requireModerator } from "./lib/roles";

export const REVIEW_MIN_LENGTH = 20;
export const REVIEW_MAX_LENGTH = 5000;
/** Reviews per page of the public list; "more" asks for another page's worth. */
export const REVIEW_PAGE = 20;
const REVIEW_LIMIT_MAX = 200;
/** Hidden Reviews a Moderator sees per target. */
const HIDDEN_LIST_MAX = 50;
/** Longest moderation reason setHidden stores. */
export const REVIEW_REASON_MAX = 500;

export const REVIEW_RATE_LIMIT = {
  reviewSave: { kind: "token bucket", rate: 20, period: HOUR, capacity: 5 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, REVIEW_RATE_LIMIT);

const isModerator = (user: Doc<"users"> | null) =>
  Boolean(
    user && !user.suspended && (user.role === "moderator" || user.role === "administrator"),
  );

/** Trim, unify line endings, and hold a Review body to its length bounds. */
function cleanBody(raw: string): string {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body.length < REVIEW_MIN_LENGTH) {
    throw new ConvexError({
      code: "reviewTooShort",
      message: `Write at least ${REVIEW_MIN_LENGTH} characters.`,
    });
  }
  if (body.length > REVIEW_MAX_LENGTH) {
    throw new ConvexError({
      code: "reviewTooLong",
      message: `Keep reviews under ${REVIEW_MAX_LENGTH} characters.`,
    });
  }
  return body;
}

/** One Review as the page shows it: author, their Rating of the same target, and the text. */
async function reviewCard(ctx: QueryCtx, review: Doc<"reviews">) {
  const author = await ctx.db.get(review.userId);
  const target = targetOfRow(review);
  const rating = target ? await ratingRow(ctx, review.userId, target) : null;
  return {
    reviewId: review._id,
    username: author?.username ?? null,
    rating: rating?.rating ?? null,
    body: review.body,
    spoiler: review.spoiler,
    hidden: review.status === "hidden",
    createdAt: review.createdAt,
    edited: review.updatedAt !== undefined,
  };
}

/** A target's Reviews of one status, newest first. */
function byStatus(ctx: QueryCtx, target: TargetId, status: Doc<"reviews">["status"]) {
  return target.kind === "series"
    ? ctx.db
        .query("reviews")
        .withIndex("by_series_status", (q) => q.eq("seriesId", target.id).eq("status", status))
        .order("desc")
    : ctx.db
        .query("reviews")
        .withIndex("by_volume_status", (q) => q.eq("volumeId", target.id).eq("status", status))
        .order("desc");
}

/**
 * A target's visible Reviews, newest first: the first `limit` (default one
 * page) and whether more exist. The same for every viewer, so the page
 * loaders can render it; hidden Reviews come from `hiddenList` and `mine`.
 * Null when the target is unknown or hidden.
 */
export const list = query({
  args: { target: targetRefArg, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const resolved = await resolveTarget(ctx, args.target);
    if (!resolved) return null;
    const limit = Math.max(1, Math.min(REVIEW_LIMIT_MAX, Math.floor(args.limit ?? REVIEW_PAGE)));
    const rows = await byStatus(ctx, resolved.target, "visible").take(limit + 1);
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await reviewCard(ctx, row));
    return { items, hasMore: rows.length > limit };
  },
});

/** A target's hidden Reviews, newest first, for Moderators only; null for everyone else. */
export const hiddenList = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    if (!isModerator(await viewerOrNull(ctx))) return null;
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    const rows = await byStatus(ctx, resolved.target, "hidden").take(HIDDEN_LIST_MAX);
    const items = [];
    for (const row of rows) items.push(await reviewCard(ctx, row));
    return items;
  },
});

/**
 * The viewer's own Review of a target (hidden or not) with the target's ID
 * for `save`. Null when signed out, username pending, or the target is
 * unknown, so the review form renders its signed-out prompt instead.
 */
export const mine = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    const review = await reviewRow(ctx, user._id, resolved.target);
    return {
      target: resolved.target,
      review: review ? await reviewCard(ctx, review) : null,
    };
  },
});

/**
 * Write or rewrite the viewer's Review of a target: 20 to 5,000 characters
 * of plain text, optionally marked as a spoiler. An edit keeps the Review's
 * place and moderation status and stamps `updatedAt`.
 */
export const save = mutation({
  args: { target: targetIdArg, body: v.string(), spoiler: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "reviewSave", { key: user._id, throws: true });
    const body = cleanBody(args.body);
    const target = await requireActiveTarget(ctx, args.target);
    const existing = await reviewRow(ctx, user._id, target);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { body, spoiler: args.spoiler, updatedAt: now });
      return { reviewId: existing._id };
    }
    const reviewId = await ctx.db.insert("reviews", {
      userId: user._id,
      ...targetFields(target),
      body,
      spoiler: args.spoiler,
      status: "visible",
      createdAt: now,
    });
    return { reviewId };
  },
});

/** Delete the viewer's own Review. Nobody else may, Moderators included (they hide). */
export const remove = mutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, { reviewId }) => {
    const user = await requireUser(ctx);
    const review = await ctx.db.get(reviewId);
    if (!review) return null;
    if (review.userId !== user._id) {
      throw new ConvexError({ code: "forbidden", message: "Only its author can delete a review." });
    }
    await ctx.db.delete(review._id);
    return null;
  },
});

/**
 * Hide or unhide a Review (Moderators and Administrators), recording the
 * action in reviewAudit with an optional reason (at most REVIEW_REASON_MAX
 * characters after trimming). A no-op change records nothing.
 */
export const setHidden = mutation({
  args: { reviewId: v.id("reviews"), hidden: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const moderator = await requireModerator(ctx);
    const reason = args.reason?.trim();
    if (reason && reason.length > REVIEW_REASON_MAX) {
      throw new ConvexError({
        code: "reasonTooLong",
        message: `A reason can be at most ${REVIEW_REASON_MAX} characters.`,
      });
    }
    const review = await ctx.db.get(args.reviewId);
    if (!review) {
      throw new ConvexError({ code: "notFound", message: "That review is gone." });
    }
    const status = args.hidden ? "hidden" : "visible";
    if (review.status === status) return null;
    await ctx.db.patch(review._id, { status });
    await ctx.db.insert("reviewAudit", {
      reviewId: review._id,
      action: args.hidden ? "hidden" : "unhidden",
      actor: { kind: "user", userId: moderator._id },
      ...(reason ? { reason } : {}),
    });
    return null;
  },
});
