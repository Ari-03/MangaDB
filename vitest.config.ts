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
    // Refuses fetch, WebSocket and happy-dom's network for any test that
    // has not stubbed them.
    setupFiles: ["./vitest.setup.ts"],
    // The slowest convex-test cases near 4s on a 4-vCPU CI runner; 5s is too thin.
    testTimeout: 15_000,
    // The rate-limiter package is inlined so its component test helper's
    // import.meta.glob (of the component's TS sources) gets transformed.
    // posthog-js is inlined so vi.resetModules() gives a fresh instance, the
    // page load in src/lib/analyticsClient.test.ts.
    server: { deps: { inline: ["convex-test", "@convex-dev/rate-limiter", "@posthog/convex", "posthog-js"] } },
    include: ["src/**/*.test.ts", "convex/**/*.test.ts"],
  },
});
