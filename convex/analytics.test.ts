// Backend analytics (lib/posthog.ts, analytics.ts): the PostHog batch shape
// and distinct-id rules, the no-op without POSTHOG_API_KEY, mutations
// scheduling analytics.capture with the mutation's event, and $exception
// capture around unattended actions.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import { SERVER_LIB, exceptionEvent, withExceptionCapture } from "./lib/posthog";
import { lengthBucket } from "./reviews";
import schema from "./schema";

const KEY = "phc_test_key";
const ADMIN = "user_admin";
const READER = "user_reader";

type Posted = { url: string; body: unknown };

/** Stub fetch with a PostHog that accepts everything; returns what was posted. */
function stubPostHog(): Posted[] {
  const posted: Posted[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  return posted;
}

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

/** An administrator, a reader, and one active Series (publicId 7). */
async function seed() {
  const t = makeT();
  await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
  await t.withIdentity({ subject: READER }).mutation(api.users.claimUsername, { username: "carol" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  const seriesId = await t.run((ctx) =>
    ctx.db.insert("series", {
      status: "active",
      publicId: 7,
      title: "Witch Hat Atelier",
      altTitles: [],
      searchText: "Witch Hat Atelier",
    }),
  );
  return { t, target: { kind: "series" as const, id: seriesId } };
}

const scheduled = (t: ReturnType<typeof makeT>) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

/**
 * Analytics on, against a stub PostHog. Timers are fake so scheduled
 * captures run only when a test drains them, never after it ends.
 */
function enableCapture(): Posted[] {
  vi.stubEnv("POSTHOG_API_KEY", KEY);
  vi.useFakeTimers();
  return stubPostHog();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("analytics.capture", () => {
  const event = { event: "import_run_finished", properties: { source_key: "ann" }, timestamp: 1_700_000_000_000 };

  it("is a no-op without POSTHOG_API_KEY", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "");
    const posted = stubPostHog();
    await makeT().action(internal.analytics.capture, { events: [event] });
    expect(posted).toHaveLength(0);
  });

  it("posts one batch with the project key, server events anonymous and user events on the Clerk id", async () => {
    vi.stubEnv("POSTHOG_API_KEY", KEY);
    const posted = stubPostHog();
    await makeT().action(internal.analytics.capture, {
      events: [event, { ...event, event: "rating_set", distinctId: READER }],
    });
    expect(posted).toEqual([
      {
        url: "https://us.i.posthog.com/batch/",
        body: {
          api_key: KEY,
          batch: [
            {
              event: "import_run_finished",
              distinct_id: "server",
              properties: { source_key: "ann", $lib: SERVER_LIB, $process_person_profile: false },
              timestamp: "2023-11-14T22:13:20.000Z",
            },
            {
              event: "rating_set",
              distinct_id: READER,
              properties: { source_key: "ann", $lib: SERVER_LIB },
              timestamp: "2023-11-14T22:13:20.000Z",
            },
          ],
        },
      },
    ]);
  });

  it("never throws when PostHog is unreachable", async () => {
    vi.stubEnv("POSTHOG_API_KEY", KEY);
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeT().action(internal.analytics.capture, { events: [event] });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("capture from mutations", () => {
  it("schedules nothing without POSTHOG_API_KEY", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.useFakeTimers();
    const { t, target } = await seed();
    await t.withIdentity({ subject: READER }).mutation(api.ratings.set, { target, score: 80 });
    expect(await scheduled(t)).toHaveLength(0);
  });

  it("rating_set, review_saved and favorite_toggled schedule analytics.capture as the user", async () => {
    const posted = enableCapture();
    const { t, target } = await seed();
    const reader = t.withIdentity({ subject: READER });
    await reader.mutation(api.ratings.set, { target, score: 80 });
    await reader.mutation(api.ratings.set, { target, score: null });
    await reader.mutation(api.reviews.save, { target, body: "A".repeat(150), spoiler: true });
    await reader.mutation(api.favorites.toggle, { target });

    const events = (await scheduled(t)).map((job) => {
      expect(job.name).toBe("analytics:capture");
      return job.args[0];
    });
    expect(events).toMatchObject([
      { events: [{ event: "rating_set", distinctId: READER, properties: { kind: "series", score: 80, cleared: false } }] },
      { events: [{ event: "rating_set", distinctId: READER, properties: { kind: "series", score: null, cleared: true } }] },
      {
        events: [
          {
            event: "review_saved",
            distinctId: READER,
            properties: { kind: "series", spoiler: true, length_bucket: "100_499", edited: false },
          },
        ],
      },
      { events: [{ event: "favorite_toggled", distinctId: READER, properties: { kind: "series", favorite: true } }] },
    ]);

    // The scheduled actions deliver them.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(posted.flatMap((p) => (p.body as { batch: Array<{ event: string }> }).batch.map((e) => e.event))).toEqual([
      "rating_set",
      "rating_set",
      "review_saved",
      "favorite_toggled",
    ]);
  });

  it("moderation_action carries the action, target kind and actor role", async () => {
    enableCapture();
    const { t } = await seed();
    const { proposalId } = await t
      .withIdentity({ subject: READER })
      .mutation(api.reports.submit, { seriesPublicId: 7, message: "Volume 12 is missing." });
    await t.withIdentity({ subject: ADMIN }).mutation(api.proposals.rejectProposal, { proposalId, note: "Fixed." });
    const jobs = await scheduled(t);
    expect(jobs.at(-1)?.args[0]).toMatchObject({
      events: [
        {
          event: "moderation_action",
          distinctId: ADMIN,
          properties: { action: "reject", target_kind: "proposal", actor_role: "administrator" },
        },
      ],
    });
  });

  it("import_run_finished and source_unhealthy are server events", async () => {
    enableCapture();
    const t = makeT();
    await t.mutation(internal.importSources.seedRegistry, {});
    for (let i = 0; i < 3; i++) {
      const runId = await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
      await t.mutation(internal.imports.finishRun, {
        runId,
        status: "failed",
        recordsSeen: 4,
        recordsChanged: 1,
        errors: ["boom", "bang"],
      });
    }
    const captures = (await scheduled(t))
      .filter((job) => job.name === "analytics:capture")
      .map((job) => job.args[0]);
    expect(captures).toHaveLength(4);
    expect(captures[0]).toMatchObject({
      events: [
        {
          event: "import_run_finished",
          properties: { source_key: "ann", status: "failed", records_seen: 4, records_changed: 1, error_count: 2 },
        },
      ],
    });
    expect(captures[3]).toMatchObject({
      events: [{ event: "source_unhealthy", properties: { source_key: "ann", consecutive_failures: 3 } }],
    });
    // No user: no distinct id, so the transport sends "server".
    expect(captures.every((c) => !("distinctId" in (c as { events: object[] }).events[0]!))).toBe(true);
  });
});

describe("withExceptionCapture", () => {
  it("captures the error as $exception and rethrows it", async () => {
    vi.stubEnv("POSTHOG_API_KEY", KEY);
    const posted = stubPostHog();
    const failure = new RangeError("out of range");
    await expect(
      withExceptionCapture("test.job", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({
      batch: [
        {
          event: "$exception",
          distinct_id: "server",
          properties: {
            function_name: "test.job",
            $process_person_profile: false,
            $exception_list: [
              {
                type: "RangeError",
                value: "out of range",
                mechanism: { handled: false, synthetic: false },
                stacktrace: { type: "raw" },
              },
            ],
          },
        },
      ],
    });
  });

  it("passes results through untouched", async () => {
    vi.stubEnv("POSTHOG_API_KEY", KEY);
    const posted = stubPostHog();
    expect(await withExceptionCapture("test.job", async () => 42)).toBe(42);
    expect(posted).toHaveLength(0);
  });

  it("wraps the import entry points: a failing adapter reports under its name", async () => {
    vi.stubEnv("POSTHOG_API_KEY", KEY);
    const posted = stubPostHog();
    // No registry row: ann.sync throws before fetching anything.
    await expect(makeT().action(internal.ann.sync, {})).rejects.toThrow(/no "ann" row/);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({
      batch: [{ event: "$exception", properties: { function_name: "ann.sync" } }],
    });
  });
});

describe("exceptionEvent", () => {
  it("parses V8 frames outermost first, throwing frame last", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at inner (convex/ann.ts:10:5)",
      "    at async outer (convex/imports.ts:20:7)",
      "    at node_modules/convex/dist/server.js:1:2",
    ].join("\n");
    const [entry] = exceptionEvent("x", err).properties.$exception_list as Array<{
      stacktrace: { frames: Array<{ function: string; filename: string; lineno: number; in_app: boolean }> };
    }>;
    expect(entry!.stacktrace.frames).toMatchObject([
      { function: "<anonymous>", filename: "node_modules/convex/dist/server.js", in_app: false },
      { function: "outer", filename: "convex/imports.ts", lineno: 20, in_app: true },
      { function: "inner", filename: "convex/ann.ts", lineno: 10, in_app: true },
    ]);
  });

  it("wraps a thrown non-Error as a synthetic Error", () => {
    const [entry] = exceptionEvent("x", "just a string").properties.$exception_list as Array<object>;
    expect(entry).toMatchObject({ type: "Error", value: "just a string", mechanism: { synthetic: true } });
  });
});

describe("lengthBucket", () => {
  it("buckets review lengths without the text", () => {
    expect([20, 99, 100, 499, 500, 1999, 2000, 5000].map(lengthBucket)).toEqual([
      "under_100",
      "under_100",
      "100_499",
      "100_499",
      "500_1999",
      "500_1999",
      "2000_plus",
      "2000_plus",
    ]);
  });
});
