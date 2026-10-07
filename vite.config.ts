import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

import { transitivePreloads } from "./build/transitivePreloads.ts";

// Route preloads that cover every static import, not only the first level;
// the pair must sit around tanstackStart() (build/transitivePreloads.ts).
const preloads = transitivePreloads();

// TanStack Start SSR on Cloudflare Workers (spec §12): the Cloudflare plugin
// runs the SSR environment inside workerd in dev and builds the Worker bundle
// for `wrangler deploy`.
export default defineConfig({
  resolve: {
    // "~/*" → "src/*" from tsconfig.json
    tsconfigPaths: true,
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    preloads.expand,
    tanstackStart(),
    preloads.restore,
    react(),
  ],
});
