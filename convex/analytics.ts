// The action half of backend analytics (lib/posthog.ts): mutations cannot
// fetch, so captureFromMutation schedules this to send their events.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { capture as sendToPostHog } from "./lib/posthog";

/** Send events captured in a mutation. Properties are flat scalars. */
export const capture = internalAction({
  args: {
    events: v.array(
      v.object({
        event: v.string(),
        distinctId: v.optional(v.string()),
        properties: v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null())),
        timestamp: v.number(),
      }),
    ),
  },
  handler: async (_ctx, { events }) => {
    await sendToPostHog(events);
  },
});
