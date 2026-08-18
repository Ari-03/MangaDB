// Custom Cloudflare Workers entry (wrangler.jsonc `main`). Wraps the TanStack
// Start request handler with the canonical-host redirect (spec §11: apex
// canonical, www 301, HTTPS-only). Queue/scheduled handlers slot in here later.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { canonicalRedirect } from "./server/canonicalHost";

export default createServerEntry({
  fetch(request, opts) {
    const redirect = canonicalRedirect(request, process.env.CANONICAL_HOST);
    if (redirect) return redirect;
    return handler.fetch(request, opts);
  },
});
