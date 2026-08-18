import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetch for /search (ticket #38): public catalog read, so no auth token.
 * Returns the Series + Publisher matches, or null when Convex is not
 * configured (the page renders a setup notice, matching the home page).
 */
export const fetchSearchResults = createServerFn({ method: "GET" })
  .validator((query: string) => query)
  .handler(async ({ data: query }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalog.search, { query });
  });

export type SearchResults = NonNullable<
  Awaited<ReturnType<typeof fetchSearchResults>>
>;
