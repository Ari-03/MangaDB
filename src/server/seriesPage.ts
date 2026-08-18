import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetch for the Series page (ticket #22): public catalog read, so no auth
 * token. Returns the resolved page — for a merged Series this is already the
 * survivor's data (the routes 301 on any ID/slug mismatch) — or null when the
 * Series is unknown/hidden or Convex is not configured.
 */
export const fetchSeriesPage = createServerFn({ method: "GET" })
  .validator((publicId: number) => publicId)
  .handler(async ({ data: publicId }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalog.seriesPage, { publicId });
  });

export type SeriesPageData = NonNullable<
  Awaited<ReturnType<typeof fetchSeriesPage>>
>;
