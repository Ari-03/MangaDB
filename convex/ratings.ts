// Ratings (CONTEXT.md: Rating): one private score per user per Series,
// Volume, or omnibus Edition (a single-volume Edition rates its Volume;
// lib/ratings.ts refuses it as a target), stored as a whole number from 1 to 100 whatever Rating Format the
// user entered it in (lib/scoreFormat.ts). The number itself stays private;
// the public sees the target's aggregate ("8.4 · 12 ratings"), which moves
// in the same transaction as the Rating (lib/ratings.ts), and a Review's
// author score beside it.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireUser, viewerOrNull } from "./lib/auth";
import { capture } from "./lib/posthog";
import {
  applyRatingDelta,
  ratingRow,
  ratingSummary,
  requireActiveTarget,
  resolveTarget,
  targetFields,
  targetIdArg,
  targetRefArg,
} from "./lib/ratings";
import { SCORE_MAX, SCORE_MIN, isValidScore } from "./lib/scoreFormat";

// Rating is a click, so the bucket is roomy; the cap stops scripted floods.
export const RATING_RATE_LIMIT = {
  ratingSet: { kind: "token bucket", rate: 120, period: HOUR, capacity: 30 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, RATING_RATE_LIMIT);

/**
 * A target's public aggregate: `average` (unrounded, on the 1-100 score
 * scale, null when unrated) and
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
 * without a viewer (viewerOrNull) or for an unknown target, so the rating
 * control renders nothing.
 */
export const mine = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    const row = await ratingRow(ctx, user._id, resolved.target);
    return { target: resolved.target, score: row?.score ?? null };
  },
});

/**
 * Set, change, or clear (`score: null`) the viewer's Rating of a target: a
 * whole number from 1 to 100 (the client converts from the viewer's Rating
 * Format). A merged target resolves to its survivor; an Edition that is no
 * target is refused (`rateVolume`, `unmapped`).
 */
export const set = mutation({
  args: { target: targetIdArg, score: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "ratingSet", { key: user._id, throws: true });
    const { score } = args;
    if (score !== null && !isValidScore(score)) {
      throw new ConvexError({
        code: "invalidScore",
        message: `A score is a whole number from ${SCORE_MIN} to ${SCORE_MAX}.`,
      });
    }
    const { target } = await requireActiveTarget(ctx, args.target);
    const existing = await ratingRow(ctx, user._id, target);
    const before = existing?.score ?? null;
    if (before === score) return { score };

    if (score === null) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) {
      await ctx.db.patch(existing._id, { score, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("ratings", {
        userId: user._id,
        ...targetFields(target),
        score,
        updatedAt: Date.now(),
      });
    }
    await applyRatingDelta(ctx, target, before, score);
    await capture(ctx, user, "rating_set", {
      kind: target.kind,
      score,
      cleared: score === null,
    });
    return { score };
  },
});
