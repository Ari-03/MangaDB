// Backend analytics (lib/posthog.ts) through PostHog's Convex component,
// registered here from @posthog/convex/test: the no-op without
// POSTHOG_PROJECT_TOKEN, the distinct-id rules, mutations scheduling the
// component's send with the event, what the component delivers, nothing
// for a user who opted out, and $exception capture around unattended
// actions.

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { lengthBucket } from "./reviews";
import { insertSeries } from "./test.factories";
import { ADMIN, READER, alice, makeT, reader, seedTeam, type TestT } from "./test.helpers";

const TOKEN = "phc_test_token";

type WireEvent = { event: string; distinct_id: string; properties: Record<string, unknown> };

/**
 * Stub fetch with a PostHog that accepts everything. Returns each POST's
 * batch of events (the component's client gzips each body).
 */
function stubPostHog(): Promise<WireEvent[]>[] {
  const posted: Promise<WireEvent[]>[] = [];
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new Response(init?.body).body!.pipeThrough(new DecompressionStream("gzip"));
    posted.push(new Response(body).json().then((b: { batch: WireEvent[] }) => b.batch));
    return new Response("{}", { status: 200 });
  });
  return posted;
}

const wireEvents = async (posted: ReturnType<typeof stubPostHog>) => (await Promise.all(posted)).flat();

/** An administrator, a reader, and one active Series (publicId 7). */
async function seed() {
  const t = makeT();
  await seedTeam(t, [alice, reader]);
  const seriesId = await t.run((ctx) => insertSeries(ctx, { publicId: 7, title: "Witch Hat Atelier" }));
  return { t, target: { kind: "series" as const, id: seriesId } };
}

type Scheduled = { name: string; args: Record<string, unknown> };

/** The component sends the app scheduled, with properties JSON-encoded. */
async function scheduled(t: TestT): Promise<Scheduled[]> {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.map((job) => {
    const args = job.args[0] as Record<string, unknown>;
    const decoded = { ...args };
    for (const key of ["properties", "additionalProperties"]) {
      if (typeof args[key] === "string") decoded[key] = JSON.parse(args[key]);
    }
    return { name: job.name, args: decoded };
  });
}

/**
 * Analytics on, against a stub PostHog. Timers are fake so scheduled sends
 * run only when a test drains them, never after it ends.
 */
function enableCapture() {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", TOKEN);
  vi.useFakeTimers();
  return stubPostHog();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("capture", () => {
  it("schedules nothing without POSTHOG_PROJECT_TOKEN", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
    vi.useFakeTimers();
    const { t, target } = await seed();
    await t.withIdentity({ subject: READER }).mutation(api.ratings.set, { target, score: 80 });
    expect(await scheduled(t)).toHaveLength(0);
  });

  it("rating_set, review_saved and favorite_toggled schedule the component's capture as the user", async () => {
    const posted = enableCapture();
    const { t, target } = await seed();
    const reader = t.withIdentity({ subject: READER });
    await reader.mutation(api.ratings.set, { target, score: 80 });
    await reader.mutation(api.ratings.set, { target, score: null });
    await reader.mutation(api.reviews.save, { target, body: "A".repeat(150), spoiler: true });
    await reader.mutation(api.favorites.toggle, { target });

    const jobs = await scheduled(t);
    expect(jobs.every((job) => job.name === "lib:capture")).toBe(true);
    expect(jobs.map((job) => job.args)).toMatchObject([
      { event: "rating_set", distinctId: READER, properties: { kind: "series", score: 80, cleared: false } },
      { event: "rating_set", distinctId: READER, properties: { kind: "series", score: null, cleared: true } },
      {
        event: "review_saved",
        distinctId: READER,
        properties: { kind: "series", spoiler: true, length_bucket: "100_499", edited: false },
      },
      { event: "favorite_toggled", distinctId: READER, properties: { kind: "series", favorite: true } },
    ]);
    // The mutation's time, not the send's.
    expect(jobs.every((job) => typeof job.args.timestamp === "number")).toBe(true);

    // The component's actions deliver every event as scheduled; user events
    // keep their person profile. (Its endpoint and library branding are
    // PostHog's, not asserted.) Each send is its own action and POST and
    // they run concurrently, so arrival order is not the scheduling order
    // and is not asserted.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const events = await wireEvents(posted);
    const delivered = (event: string, properties: Record<string, unknown>) =>
      expect.objectContaining({
        event,
        distinct_id: READER,
        properties: expect.objectContaining(properties),
      });
    expect(events).toHaveLength(jobs.length);
    expect(events).toEqual(
      expect.arrayContaining([
        delivered("rating_set", { kind: "series", score: 80, cleared: false }),
        delivered("rating_set", { kind: "series", score: null, cleared: true }),
        delivered("review_saved", { kind: "series", spoiler: true, length_bucket: "100_499", edited: false }),
        delivered("favorite_toggled", { kind: "series", favorite: true }),
      ]),
    );
    expect(events.some((e) => "$process_person_profile" in e.properties)).toBe(false);
  });

  it("moderation_action carries the action, target kind and actor role", async () => {
    enableCapture();
    const { t } = await seed();
    const { proposalId } = await t
      .withIdentity({ subject: READER })
      .mutation(api.reports.submit, { seriesPublicId: 7, message: "Volume 12 is missing." });
    await t.withIdentity({ subject: ADMIN }).mutation(api.proposals.rejectProposal, { proposalId, note: "Fixed." });
    expect((await scheduled(t)).at(-1)?.args).toMatchObject({
      event: "moderation_action",
      distinctId: ADMIN,
      properties: { action: "reject", target_kind: "proposal", actor_role: "administrator" },
    });
  });

  it("sends nothing a user who opted out caused, moderation included, until they opt back in", async () => {
    enableCapture();
    const { t, target } = await seed();
    const reader = t.withIdentity({ subject: READER });
    const admin = t.withIdentity({ subject: ADMIN });
    await reader.mutation(api.users.setAnalyticsOptOut, { optOut: true });
    await admin.mutation(api.users.setAnalyticsOptOut, { optOut: true });

    await reader.mutation(api.ratings.set, { target, score: 80 });
    const { reviewId } = await reader.mutation(api.reviews.save, { target, body: "A".repeat(150), spoiler: false });
    await reader.mutation(api.favorites.toggle, { target });
    await admin.mutation(api.reviews.setHidden, { reviewId, hidden: true });
    expect(await scheduled(t)).toEqual([]);

    // System events carry no person and still go.
    await t.mutation(internal.importSources.seedRegistry, {});
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    await t.mutation(internal.imports.finishRun, { runId, status: "succeeded", recordsSeen: 1, recordsChanged: 0, errors: [] });
    expect((await scheduled(t)).map((job) => job.args)).toMatchObject([
      { event: "import_run_finished", distinctId: "server" },
    ]);

    await reader.mutation(api.users.setAnalyticsOptOut, { optOut: false });
    await reader.mutation(api.ratings.set, { target, score: 60 });
    await admin.mutation(api.reviews.setHidden, { reviewId, hidden: false });
    expect((await scheduled(t)).map((job) => job.args).slice(1)).toMatchObject([
      { event: "rating_set", distinctId: READER, properties: { score: 60 } },
    ]);
  });

  it("import_run_finished and source_unhealthy are anonymous server events", async () => {
    const posted = enableCapture();
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
    const captures = (await scheduled(t)).filter((job) => job.name === "lib:capture").map((job) => job.args);
    expect(captures).toHaveLength(4);
    expect(captures[0]).toMatchObject({
      event: "import_run_finished",
      distinctId: "server",
      properties: {
        source_key: "ann",
        status: "failed",
        records_seen: 4,
        records_changed: 1,
        error_count: 2,
        $process_person_profile: false,
      },
    });
    expect(captures[3]).toMatchObject({
      event: "source_unhealthy",
      distinctId: "server",
      properties: { source_key: "ann", consecutive_failures: 3, $process_person_profile: false },
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const events = await wireEvents(posted);
    expect(events.find((e) => e.event === "source_unhealthy")).toMatchObject({
      distinct_id: "server",
      properties: { source_key: "ann", consecutive_failures: 3, $process_person_profile: false },
    });
  });
});

describe("withExceptionCapture", () => {
  it("wraps the import entry points: a failing adapter reports $exception under its name and rethrows", async () => {
    const posted = enableCapture();
    const t = makeT();
    // No registry row: ann.sync throws before fetching anything.
    await expect(t.action(internal.ann.sync, {})).rejects.toThrow(/no "ann" row/);
    const [job] = await scheduled(t);
    expect(job).toMatchObject({
      name: "lib:captureException",
      args: {
        distinctId: "server",
        errorName: "Error",
        errorMessage: expect.stringMatching(/no "ann" row/),
        additionalProperties: { function_name: "ann.sync", $process_person_profile: false },
      },
    });
    expect(job!.args.errorStack).toMatch(/convex\/ann\.ts/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [event] = await wireEvents(posted);
    expect(event).toMatchObject({
      event: "$exception",
      distinct_id: "server",
      properties: {
        function_name: "ann.sync",
        $process_person_profile: false,
        $exception_list: [{ type: "Error", value: expect.stringMatching(/no "ann" row/) }],
      },
    });
  });

  it("passes results through and schedules nothing when the body succeeds", async () => {
    enableCapture();
    const t = makeT();
    // An empty catalog: a rebuild that credits nothing, finished in one go.
    const result = await t.action(internal.people.rebuild, {});
    expect(result).toEqual({
      credits: 0,
      publisherCredits: 0,
      swept: 0,
      pruned: 0,
      people: 0,
      continued: false,
      ms: expect.any(Number),
    });
    expect(await scheduled(t)).toEqual([]);
  });

  it("rethrows without scheduling when POSTHOG_PROJECT_TOKEN is empty", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
    const t = makeT();
    await expect(t.action(internal.ann.sync, {})).rejects.toThrow(/no "ann" row/);
    expect(await scheduled(t)).toEqual([]);
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
