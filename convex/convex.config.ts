// Convex components (spec §5): the official rate-limiter component backs the
// per-user proposal rate limits and bulk caps enforced in proposals.ts.

import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);

export default app;
