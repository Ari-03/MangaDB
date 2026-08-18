import { query } from "./_generated/server";

// Cap per-table counting so the scaffold query stays cheap even once imports
// start filling the catalog; the home page renders "N+" past the cap.
export const COUNT_CAP = 1000;

/**
 * Scaffold proof query (#21): a tiny public read the home page server-renders
 * to demonstrate the SSR → Convex round-trip. Counts active catalog records
 * (capped) so the page works on a fresh deployment with an empty database.
 */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const countActive = async (
      table: "publishers" | "series" | "volumes" | "editions" | "releases",
    ) => {
      const docs = await ctx.db.query(table).take(COUNT_CAP + 1);
      const active = docs.filter((doc) => doc.status === "active").length;
      return { count: Math.min(active, COUNT_CAP), capped: docs.length > COUNT_CAP };
    };

    return {
      publishers: await countActive("publishers"),
      series: await countActive("series"),
      volumes: await countActive("volumes"),
      editions: await countActive("editions"),
      releases: await countActive("releases"),
    };
  },
});
