// Ratings (CONTEXT.md: Rating): one private 1-10 score per user per Series
// or Volume. The number itself stays private; the public sees the target's
// aggregate ("8.4 · 12 ratings"), which moves in the same transaction as
// the Rating (lib/ratings.ts), and a Review's author score beside it.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireUser, viewerOrNull } from "./lib/auth";
import {
  RATING_MAX,
  RATING_MIN,
  applyRatingDelta,
  ratingRow,
  ratingSummary,
  requireActiveTarget,
  resolveTarget,
  targetFields,
  targetIdArg,
  targetRefArg,
} from "./lib/ratings";

// Rating is a click, so the bucket is roomy; the cap stops scripted floods.
export const RATING_RATE_LIMIT = {
  ratingSet: { kind: "token bucket", rate: 120, period: HOUR, capacity: 30 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, RATING_RATE_LIMIT);

/**
 * A target's public aggregate: `average` (unrounded, null when unrated) and
 * `count`. Null when the target is unknown or hidden. The page loaders read
 * it for the server render; the rating control re-reads it live.
 */
export const summary = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    return await ratingSummary(ctx, resolved.target);
  },
});

/**
 * The viewer's own Rating of a target, with the target's ID for `set`. Null
 * when signed out, username pending, or the target is unknown, so the
 * rating control renders nothing.
 */
export const mine = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    const row = await ratingRow(ctx, user._id, resolved.target);
    return { target: resolved.target, rating: row?.rating ?? null };
  },
});

/**
 * Set, change, or clear (`rating: null`) the viewer's Rating of a target:
 * an integer from 1 to 10. A merged target resolves to its survivor.
 */
export const set = mutation({
  args: { target: targetIdArg, rating: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "ratingSet", { key: user._id, throws: true });
    const { rating } = args;
    if (
      rating !== null &&
      (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX)
    ) {
      throw new ConvexError({
        code: "invalidRating",
        message: `A rating is a whole number from ${RATING_MIN} to ${RATING_MAX}.`,
      });
    }
    const target = await requireActiveTarget(ctx, args.target);
    const existing = await ratingRow(ctx, user._id, target);
    const before = existing?.rating ?? null;
    if (before === rating) return { rating };

    if (rating === null) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) {
      await ctx.db.patch(existing._id, { rating, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("ratings", {
        userId: user._id,
        ...targetFields(target),
        rating,
        updatedAt: Date.now(),
      });
    }
    await applyRatingDelta(ctx, target, before, rating);
    return { rating };
  },
});
