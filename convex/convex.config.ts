// Convex components (spec §5): the official rate-limiter component backs the
// per-user proposal rate limits and bulk caps enforced in proposals.ts, and
// PostHog's component sends backend analytics (lib/posthog.ts).
//
// The PostHog component requires POSTHOG_PROJECT_TOKEN, so the app declares
// it required and forwards it by reference: a push fails on a deployment that
// has not set it. An empty value is accepted and turns analytics off (docs/configuration.md,
// "Analytics (PostHog)"). Feature flags stay off: no personal API
// key is forwarded, so the component's flag-refresh cron finds nothing to do.

import posthog from "@posthog/convex/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    POSTHOG_PROJECT_TOKEN: v.string(),
    POSTHOG_HOST: v.optional(v.string()),
  },
});
app.use(rateLimiter);
app.use(posthog, {
  env: {
    POSTHOG_PROJECT_TOKEN: app.env.POSTHOG_PROJECT_TOKEN,
    POSTHOG_HOST: app.env.POSTHOG_HOST,
  },
});

export default app;
