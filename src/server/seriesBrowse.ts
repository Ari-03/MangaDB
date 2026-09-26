import { createServerFn } from "@tanstack/react-start";
import type { FunctionArgs } from "convex/server";

import { api } from "../../convex/_generated/api";
import { todaySortKey } from "~/lib/month";
import { convexServerClient } from "~/server/convex";

// contract: `api.seriesBrowse.browse` / `api.seriesBrowse.facets` are the
// Series library queries in convex/seriesBrowse.ts. Argument and result types
// are inferred from them, so the page follows the backend's shape; the one
// argument the page does not give, `todaySort`, is filled in here.
export type SeriesBrowseArgs = Omit<
  FunctionArgs<typeof api.seriesBrowse.browse>,
  "todaySort"
>;

/**
 * One page of the Series library (`/series`): filtered, then sorted,
 * cursor-paged, with the filtered total. Called by the route loader for the
 * first page and from the client as the shelf scrolls. A timing filter gets
 * today's date (UTC) from the server clock, since the Convex query is cached
 * and must not read one. Returns null when Convex is not configured.
 */
export const fetchSeriesBrowse = createServerFn({ method: "GET" })
  .validator((args: SeriesBrowseArgs) => args)
  .handler(async ({ data }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.seriesBrowse.browse, {
      ...data,
      // Only the timing filters read it; leaving it off keeps other views'
      // cache keys the same from day to day.
      todaySort: data.timing ? todaySortKey() : undefined,
    });
  });

/**
 * The library's filter vocabulary: every Publisher with a Series and its
 * Series count, the total Series count, and counts per Source Status. Null
 * when unconfigured.
 */
export const fetchSeriesFacets = createServerFn({ method: "GET" }).handler(
  async () => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.seriesBrowse.facets, {});
  },
);

export type SeriesBrowsePage = NonNullable<
  Awaited<ReturnType<typeof fetchSeriesBrowse>>
>;
export type SeriesBrowseItem = SeriesBrowsePage["items"][number];
export type SeriesFacets = NonNullable<
  Awaited<ReturnType<typeof fetchSeriesFacets>>
>;
