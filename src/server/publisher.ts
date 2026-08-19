import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetch for the Publisher Spotlight page (ticket #25): a public read, no
 * auth token. Returns `{ redirectTo }` for a renamed or merged Publisher's
 * old slug (the route 301s), the page data otherwise, or null when the
 * Publisher is unknown/hidden or Convex is not configured.
 */
export const fetchPublisherPage = createServerFn({ method: "GET" })
  .validator(
    (args: { slug: string; todaySort: number; horizonSort: number }) => args,
  )
  .handler(async ({ data }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.publisher.publisherPage, data);
  });

type PublisherPageResult = NonNullable<
  Awaited<ReturnType<typeof fetchPublisherPage>>
>;
export type PublisherPageData = Exclude<
  PublisherPageResult,
  { redirectTo: string }
>;
