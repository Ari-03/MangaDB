import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the Cloudflare/Start plugins run
// the app inside workerd, which vitest does not need. `edge-runtime` matches
// the Convex runtime for convex-test and provides Request/Response for the
// canonical-host tests.
export default defineConfig({
  resolve: {
    // "~/*" → "src/*" from tsconfig.json, for tests of modules that import
    // app code by alias (e.g. src/server/seoRoutes.ts).
    alias: { "~": new URL("./src", import.meta.url).pathname },
  },
  test: {
    environment: "edge-runtime",
    // The rate-limiter package is inlined so its component test helper's
    // import.meta.glob (of the component's TS sources) gets transformed.
    server: { deps: { inline: ["convex-test", "@convex-dev/rate-limiter"] } },
    include: ["src/**/*.test.ts", "convex/**/*.test.ts"],
  },
});
