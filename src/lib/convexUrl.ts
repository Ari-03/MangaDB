/**
 * The Convex deployment URL: the build-time `VITE_CONVEX_URL`, else the
 * Worker's runtime `process.env` (read per call, at request time). Undefined
 * when no deployment is configured, or in a browser build without one.
 */
export function convexUrl(): string | undefined {
  return (
    import.meta.env.VITE_CONVEX_URL ??
    (typeof process === "undefined" ? undefined : process.env.VITE_CONVEX_URL)
  );
}
