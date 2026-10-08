// The counts on the data team's workroom tabs (src/lib/modShell.tsx). Each
// is a capped read, never a scan: the tab shows COUNT_CAP + 1 as "100+".

import { query } from "./_generated/server";
import { viewerOrNull } from "./lib/auth";
import { COUNT_CAP } from "./lib/workroom";
import { MAX_SOURCES } from "./imports";

/**
 * In-Review Proposals and Held Books, each read up to COUNT_CAP + 1, and
 * how many Approved Sources are unhealthy (the registry, read up to
 * MAX_SOURCES as imports.dashboardPage does). Null for anyone outside the
 * Data Team, so the tab strip can ask without a role check and an error
 * page that draws the strip cannot fail on it.
 */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await viewerOrNull(ctx);
    if (!viewer?.role || viewer.suspended) return null;
    const inReview = await ctx.db
      .query("proposals")
      .withIndex("by_state", (q) => q.eq("state", "inReview"))
      .take(COUNT_CAP + 1);
    const held = await ctx.db
      .query("placementHolds")
      .withIndex("by_held")
      .take(COUNT_CAP + 1);
    const sources = await ctx.db.query("approvedSources").take(MAX_SOURCES);
    return {
      inReview: inReview.length,
      heldBooks: held.length,
      unhealthySources: sources.filter((source) => source.healthState === "unhealthy").length,
    };
  },
});
