import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the Cloudflare/Start plugins run
// the app inside workerd, which vitest does not need. `edge-runtime` matches
// the Convex runtime for convex-test and provides Request/Response for the
// canonical-host tests.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["src/**/*.test.ts", "convex/**/*.test.ts"],
  },
});
