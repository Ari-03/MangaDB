import { ConvexHttpClient } from "convex/browser";

import { convexUrl } from "~/lib/convexUrl";

/**
 * Server-side Convex client for SSR loaders (spec §9: SSR reads go through
 * the Convex HTTP client). Pass the viewer's Clerk "convex"-template token —
 * from `ssrAuth()` in ./auth — to authenticate personal reads; omit it for
 * public catalog reads.
 */
export function convexServerClient(authToken?: string | null) {
  const client = new ConvexHttpClient(convexUrl());
  if (authToken) client.setAuth(authToken);
  return client;
}
