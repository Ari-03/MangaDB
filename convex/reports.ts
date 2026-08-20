// The per-Series "see something missing/wrong? → report" affordance
// (ticket #40, spec §7): any signed-in user — no data-team role required —
// files a free-text report from a Series page, and it lands in the shared
// review queue as a zero-op In-Review Proposal. Gap-spotters become the
// Editor pipeline: a reviewer acts on the report (a direct edit, their own
// proposal, or a merge) and then approves or rejects it like any other
// queue item. Approving a zero-op proposal writes no Revision — the fix
// itself carries the public history.

import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { requireUser } from "./lib/auth";

// Reports are the one write open to every signed-in user, so they get their
// own (tighter) bucket than the Editor proposal limits.
export const REPORT_RATE_LIMIT = {
  reportSubmit: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
} as const;

const rateLimiter = new RateLimiter(components.rateLimiter, REPORT_RATE_LIMIT);

export const MAX_REPORT_LENGTH = 2000;

/**
 * File a report on one Series. Requires only a signed-in User (the catalog
 * write paths all stay Proposal-shaped, so this inserts an In-Review
 * Proposal directly: zero ops, the report text as its change comment, and
 * the Series page as evidence).
 */
export const submit = mutation({
  args: {
    seriesPublicId: v.number(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await rateLimiter.limit(ctx, "reportSubmit", { key: user._id, throws: true });

    const message = args.message.trim();
    if (!message) {
      throw new ConvexError({
        code: "emptyReport",
        message: "Say what's missing or wrong.",
      });
    }
    if (message.length > MAX_REPORT_LENGTH) {
      throw new ConvexError({
        code: "reportTooLong",
        message: `Keep reports under ${MAX_REPORT_LENGTH} characters.`,
      });
    }
    const series = await ctx.db
      .query("series")
      .withIndex("by_publicId", (q) => q.eq("publicId", args.seriesPublicId))
      .unique();
    if (!series || series.status !== "active") {
      throw new ConvexError({ code: "notFound", message: "No such series." });
    }

    const proposalId = await ctx.db.insert("proposals", {
      author: {
        kind: "user",
        userId: user._id,
        roleAtAuthorship: user.role,
      },
      state: "inReview",
      currentVersionNo: 1,
      submittedAt: Date.now(),
    });
    await ctx.db.insert("proposalVersions", {
      proposalId,
      versionNo: 1,
      ops: [],
      evidence: [
        {
          kind: "url",
          url: `/series/${series.publicId}`,
          note: `Reported from the Series page: ${series.title}`,
        },
      ],
      changeComment: `[Report] ${series.title}: ${message}`,
    });
    return { proposalId };
  },
});
