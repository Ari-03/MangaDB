// Backend analytics: server events to PostHog's capture API (README
// "Analytics (PostHog)" → Backend). No SDK: one POST to `/batch/` per call.
//
// - `capture(events)` sends from an action. It awaits the request with a
//   short timeout and never throws; a failure logs one console.warn.
// - `captureFromMutation(ctx, user, event, props)` is the mutation path:
//   mutations cannot fetch, so it schedules analytics.capture, which calls
//   `capture`. The event keeps the mutation's timestamp.
// - `withExceptionCapture(name, run)` wraps the body of an unattended action
//   (crons, import adapters): an error it throws is sent as `$exception`,
//   then rethrown.
//
// All of it is a no-op, with no logging and nothing scheduled, until the
// Convex env var POSTHOG_API_KEY holds the project key (`phc_…`).
//
// Distinct ids: an event a user caused carries their Clerk subject, the id
// the browser SDK identifies them by, so both halves land on one person.
// Everything else is "server" with `$process_person_profile: false`, which
// creates no person profile. Never email or username.

import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * PostHog Cloud region: "us" or "eu". Keep in sync with POSTHOG_REGION in
 * src/server/posthogProxy.ts (Convex code cannot import from src).
 */
const POSTHOG_REGION = "us";
const BATCH_URL = `https://${POSTHOG_REGION}.i.posthog.com/batch/`;
const TIMEOUT_MS = 5000;
/** Distinct id for events no user caused. */
export const SERVER_DISTINCT_ID = "server";
/** `$lib` on every server event, so queries can tell them from the browser's. */
export const SERVER_LIB = "mangadb-convex";

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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One event as `capture` takes it; `analytics.capture`'s validator mirrors it. */
export type CaptureEvent = {
  event: string;
  /** Clerk subject of the user who caused it; absent → SERVER_DISTINCT_ID. */
  distinctId?: string;
  properties: { [key: string]: Json };
  /** Epoch ms; defaults to now. */
  timestamp?: number;
};

const apiKey = () => process.env.POSTHOG_API_KEY || undefined;

/** The `/batch/` body for `events` (exported for tests). */
export function batchBody(key: string, events: CaptureEvent[]) {
  return {
    api_key: key,
    batch: events.map((e) => ({
      event: e.event,
      distinct_id: e.distinctId ?? SERVER_DISTINCT_ID,
      properties: {
        ...e.properties,
        $lib: SERVER_LIB,
        ...(e.distinctId === undefined ? { $process_person_profile: false } : {}),
      },
      timestamp: new Date(e.timestamp ?? Date.now()).toISOString(),
    })),
  };
}

/** Send events to PostHog from an action. Never throws. */
export async function capture(events: CaptureEvent[]): Promise<void> {
  const key = apiKey();
  if (!key || events.length === 0) return;
  try {
    const res = await fetch(BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchBody(key, events)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[posthog] capture failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[posthog] capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Capture a named event from a mutation by scheduling analytics.capture. Pass
 * the user who caused it, or null for a system event. The scheduled action
 * commits with the mutation, so a rolled-back mutation sends nothing.
 */
export async function captureFromMutation<E extends ServerEventName>(
  ctx: MutationCtx,
  user: Pick<Doc<"users">, "clerkSubject"> | null,
  event: E,
  properties: ServerEvents[E],
): Promise<void> {
  if (!apiKey()) return;
  await ctx.scheduler.runAfter(0, internal.analytics.capture, {
    events: [
      {
        event,
        ...(user ? { distinctId: user.clerkSubject } : {}),
        properties,
        timestamp: Date.now(),
      },
    ],
  });
}

/**
 * `moderation_action` by a Moderator or Administrator (the caller's
 * requireModerator result), attributed to them.
 */
export async function captureModeration(
  ctx: MutationCtx,
  actor: Doc<"users">,
  action: string,
  targetKind: ServerEvents["moderation_action"]["target_kind"],
): Promise<void> {
  if (!actor.role) return;
  await captureFromMutation(ctx, actor, "moderation_action", {
    action,
    target_kind: targetKind,
    actor_role: actor.role,
  });
}

/**
 * PostHog's manual `$exception` shape (posthog.com/docs/error-tracking):
 * one `$exception_list` entry with the error's V8 stack as raw frames,
 * outermost call first and the throwing frame last.
 */
export function exceptionEvent(name: string, error: unknown): CaptureEvent {
  const err = error instanceof Error ? error : new Error(String(error));
  const frames = stackFrames(err.stack);
  return {
    event: "$exception",
    properties: {
      function_name: name,
      $exception_list: [
        {
          type: err.name || "Error",
          value: err.message,
          mechanism: { handled: false, synthetic: !(error instanceof Error) },
          ...(frames.length > 0 ? { stacktrace: { type: "raw", frames } } : {}),
        },
      ],
    },
  };
}

// "    at fn (file:12:3)", "    at async fn (file:12:3)" or "    at file:12:3"
const V8_FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

function stackFrames(stack: string | undefined): Json[] {
  const frames: Json[] = [];
  for (const line of stack?.split("\n") ?? []) {
    const [, fn, filename, lineno, colno] = V8_FRAME.exec(line) ?? [];
    if (filename === undefined) continue;
    frames.push({
      platform: "custom",
      lang: "javascript",
      function: fn ?? "<anonymous>",
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      resolved: true,
      in_app: !filename.includes("node_modules"),
    });
  }
  return frames.reverse();
}

/**
 * Run the body of an unattended action (a cron or scheduled import): an
 * error it throws is captured as `$exception` tagged `function_name: name`,
 * then rethrown so Convex still logs and records the failure. Used inside
 * the handler, `handler: async (ctx, args): Promise<R> =>
 * withExceptionCapture("mod.fn", async () => { ... })`, so the handler's
 * own annotations keep typing its args.
 */
export async function withExceptionCapture<R>(name: string, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (e) {
    await capture([exceptionEvent(name, e)]);
    throw e;
  }
}
