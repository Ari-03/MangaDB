// Custom Cloudflare Workers entry (wrangler.jsonc `main`). Wraps the TanStack
// Start request handler with the canonical-host redirect (spec §11: apex
// canonical, www 301, HTTPS-only) and the SEO endpoints — robots.txt and the
// on-demand sitemaps (ticket #39). Queue/scheduled handlers slot in here later.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { canonicalRedirect } from "./server/canonicalHost";
import { seoResponse } from "./server/seoRoutes";

export default createServerEntry({
  async fetch(request, opts) {
    const redirect = canonicalRedirect(request, process.env.CANONICAL_HOST);
    if (redirect) return redirect;
    const seo = await seoResponse(request);
    if (seo) return seo;
    return handler.fetch(request, opts);
  },
});
