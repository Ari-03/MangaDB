import { ConvexHttpClient } from "convex/browser";

/**
 * Server-side Convex client for SSR loaders (spec §9: SSR reads go through
 * the Convex HTTP client; the authed variant arrives with the Clerk slice).
 *
 * Returns null when no deployment is configured — the scaffold builds and
 * runs before any Convex credentials exist, and pages render a setup notice
 * instead of crashing.
 */
export function convexServerClient(): ConvexHttpClient | null {
  const url =
    import.meta.env.VITE_CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? null;
  return url ? new ConvexHttpClient(url) : null;
}
