/**
 * The Convex deployment URL: the build-time `VITE_CONVEX_URL`, else the
 * Worker's runtime `process.env` (read per call, at request time). Every
 * environment sets it, so a missing URL throws rather than leaving the site
 * to run without its backend.
 */
export function convexUrl() {
  const url: string | undefined =
    import.meta.env.VITE_CONVEX_URL ??
    (typeof process === "undefined" ? undefined : process.env.VITE_CONVEX_URL);
  if (!url) {
    throw new Error(
      "VITE_CONVEX_URL is not set. Locally, run `npx convex dev`, which writes it to .env.local (README, \"Run it locally\"); for a deploy, see docs/configuration.md.",
    );
  }
  return url;
}
