import { ConvexHttpClient } from "convex/browser";

/**
 * Server-side Convex client for SSR loaders (spec §9: SSR reads go through
 * the Convex HTTP client). Pass the viewer's Clerk "convex"-template token —
 * from `ssrAuth()` in ./auth — to authenticate personal reads; omit it for
 * public catalog reads.
 *
 * Returns null when no deployment is configured — the scaffold builds and
 * runs before any Convex credentials exist, and pages render a setup notice
 * instead of crashing.
 */
export function convexServerClient(
  authToken?: string | null,
): ConvexHttpClient | null {
  const url =
    import.meta.env.VITE_CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? null;
  if (!url) return null;
  const client = new ConvexHttpClient(url);
  if (authToken) client.setAuth(authToken);
  return client;
}
