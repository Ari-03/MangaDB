// Backend analytics through PostHog's Convex component, @posthog/convex
// (docs/configuration.md "Analytics (PostHog)").
//
// - `capture(ctx, user, event, props)` records a named event from a mutation
//   or an action. The component schedules its own action to send it, so from
//   a mutation the event commits (or rolls back) with the mutation.
// - `withExceptionCapture(name, ctx, run)` wraps the body of an unattended
//   action (crons, import adapters): an error it throws is sent as
//   `$exception`, then rethrown.
//
// Both are no-ops, with nothing scheduled and no logging, while the Convex
// env var POSTHOG_PROJECT_TOKEN is empty (convex.config.ts requires it to be
// set, so "off" is the empty string).
//
// Distinct ids: an event a user caused carries their Clerk subject, the id
// the browser SDK identifies them by, so both halves land on one person.
// Everything else is "server" with `$process_person_profile: false`, which
// creates no person profile. Never email or username.
//
// A user who opted out (`users.analyticsOptOut`) is never sent: `capture`
// drops every event they caused, moderation included. System events and
// exceptions carry no person and always go.

import { PostHog } from "@posthog/convex";
import type { Scheduler } from "convex/server";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { env } from "../_generated/server";

const posthog = new PostHog(components.posthog);

/** Distinct id for events no user caused. */
export const SERVER_DISTINCT_ID = "server";

/** A mutation or action context: both can schedule the component's send. */
type CaptureCtx = { scheduler: Scheduler };

type TargetKind = "series" | "volume" | "edition";

/** Every named server event and its properties (snake_case, no PII). */
export type ServerEvents = {
  import_run_finished: {
    source_key: string;
    status: "succeeded" | "failed" | "stopped";
    records_seen: number;
    records_changed: number;
    error_count: number;
    duration_ms: number;
  };
  source_unhealthy: { source_key: string; consecutive_failures: number };
  source_recovered: { source_key: string; consecutive_failures: number };
  moderation_action: {
    action: string;
    target_kind: "comment" | "comment_author" | "review" | "proposal";
    actor_role: NonNullable<Doc<"users">["role"]>;
  };
  rating_set: { kind: TargetKind; score: number | null; cleared: boolean };
  review_saved: { kind: TargetKind; spoiler: boolean; length_bucket: string; edited: boolean };
  favorite_toggled: { kind: TargetKind; favorite: boolean };
};

export type ServerEventName = keyof ServerEvents;

// Unset only in tests; deployments must set it (possibly to "").
const enabled = () => Boolean(env.POSTHOG_PROJECT_TOKEN?.trim());

/**
 * Capture a named event. Pass the user who caused it, or null for a system
 * event; nothing is sent for a user who opted out of analytics. The event
 * keeps the caller's timestamp, not the send's.
 */
export async function capture<E extends ServerEventName>(
  ctx: CaptureCtx,
  user: Pick<Doc<"users">, "clerkSubject" | "analyticsOptOut"> | null,
  event: E,
  properties: ServerEvents[E],
): Promise<void> {
  if (!enabled() || user?.analyticsOptOut) return;
  await posthog.capture(ctx, {
    event,
    distinctId: user?.clerkSubject ?? SERVER_DISTINCT_ID,
    properties: user ? properties : { ...properties, $process_person_profile: false },
    timestamp: new Date(),
  });
}

/**
 * `moderation_action` by a Moderator or Administrator (the caller's
 * requireModerator result), attributed to them.
 */
export async function captureModeration(
  ctx: CaptureCtx,
  actor: Doc<"users">,
  action: string,
  targetKind: ServerEvents["moderation_action"]["target_kind"],
): Promise<void> {
  if (!actor.role) return;
  await capture(ctx, actor, "moderation_action", {
    action,
    target_kind: targetKind,
    actor_role: actor.role,
  });
}

/**
 * Run the body of an unattended action (a cron or scheduled import): an
 * error it throws is captured as `$exception` tagged `function_name: name`,
 * then rethrown so Convex still logs and records the failure. Used inside
 * the handler, `handler: async (ctx, args): Promise<R> =>
 * withExceptionCapture("mod.fn", ctx, async () => { ... })`, so the
 * handler's own annotations keep typing its args. An action's scheduling is
 * not transactional, so the capture survives the rethrow.
 */
export async function withExceptionCapture<R>(
  name: string,
  ctx: CaptureCtx,
  run: () => Promise<R>,
): Promise<R> {
  try {
    return await run();
  } catch (error) {
    if (enabled()) {
      await posthog
        .captureException(ctx, {
          error,
          distinctId: SERVER_DISTINCT_ID,
          additionalProperties: { function_name: name, $process_person_profile: false },
        })
        // Never let reporting replace the error being reported.
        .catch((e: unknown) => console.warn(`[posthog] exception capture failed: ${String(e)}`));
    }
    throw error;
  }
}
