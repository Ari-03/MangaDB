import { createServerFn } from "@tanstack/react-start";
import type { FunctionArgs } from "convex/server";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

// contract: `api.seriesBrowse.browse` / `api.seriesBrowse.facets` are the
// Series library queries in convex/seriesBrowse.ts. Argument and result types
// are inferred from them, so the page follows the backend's shape.
export type SeriesBrowseArgs = FunctionArgs<typeof api.seriesBrowse.browse>;

/**
 * One page of the Series library (`/series`): filtered, then sorted,
 * cursor-paged, with the filtered total. Called by the route loader for the
 * first page and from the client as the shelf scrolls. Returns null when
 * Convex is not configured.
 */
export const fetchSeriesBrowse = createServerFn({ method: "GET" })
  .validator((args: SeriesBrowseArgs) => args)
  .handler(async ({ data }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.seriesBrowse.browse, data);
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
