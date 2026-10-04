// Import-foundation and steady-state tests (tickets #34/#37, spec §6/§7):
// the Approved Source registry as editable data, Bootstrap Mode toggling,
// Import Run logging with the three-consecutive-failures health rule,
// cadence dispatch, withdrawal's possible-cancellation review, the exactly-
// once Administrator health emails, and the Data Team dashboard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { isDue, possiblyFuture } from "./imports";
import { isStranded, STRANDED_AFTER_MS } from "./lib/importRuns";
import { insertObservation, insertSeries, seedCatalog } from "./test.factories";
import { alice, dave, drain, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";

/** alice, the Administrator, and dave, who holds no role. */
const setup = (t: TestT) => seedTeam(t, [alice, dave]);

/** Every source the registry seeds. */
const SOURCE_KEYS = ["ann", "kodansha", "kodansha-backlist", "openlibrary", "prh", "sevenseas", "yenpress"];

/**
 * Start and finish one Import Run of `sourceKey` (Seven Seas unless given),
 * counting nothing unless told; a failed run carries one HTTP error.
 */
async function finishRun(
  t: TestT,
  status: "succeeded" | "failed",
  run: { sourceKey?: string; recordsSeen?: number; recordsChanged?: number; errors?: string[] } = {},
) {
  const runId = await t.mutation(internal.imports.startRun, { sourceKey: run.sourceKey ?? "sevenseas" });
  await t.mutation(internal.imports.finishRun, {
    runId,
    status,
    recordsSeen: run.recordsSeen ?? 0,
    recordsChanged: run.recordsChanged ?? 0,
    errors: run.errors ?? (status === "failed" ? ["HTTP 500 for /wp-json"] : []),
  });
}

describe("imports.runScheduled", () => {
  it("seeds the canonical publisher rows before starting sources, so a fresh deployment can place VIZ and Dark Horse books", async () => {
    const t = makeT();
    await seedRegistry(t);
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    expect(await t.run((ctx) => ctx.db.query("publishers").collect())).toHaveLength(0);
    await t.action(internal.imports.runScheduled, {});
    const slugs = (await t.run((ctx) => ctx.db.query("publishers").collect())).map((p) => p.slug);
    expect(slugs).toContain("viz-media");
    expect(slugs).toContain("dark-horse");
    // Running again is a no-op.
    await t.action(internal.imports.runScheduled, {});
    expect(await t.run((ctx) => ctx.db.query("publishers").collect())).toHaveLength(slugs.length);
    await drain(t); // the syncs it dispatched, under this test's stub
  });
});

describe("stranded runs", () => {
  const HOUR = 60 * 60 * 1000;
  // Fake timers: the clock moves only by clockAt, and the syncs a tick
  // dispatches stay queued instead of running beside the assertions.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Seven Seas' registry row: its health. */
  const sevenSeas = (t: TestT) =>
    t.run((ctx) =>
      ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique(),
    );
  /** The clock reads `ms` from now on. */
  const clockAt = (ms: number) => vi.setSystemTime(ms);
  /** An automatic Seven Seas run opened now, last stamped at `lastActivityAt`. */
  async function openRun(t: TestT, lastActivityAt: number) {
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "sevenseas", automatic: true });
    await t.run((ctx) => ctx.db.patch(runId, { lastActivityAt }));
    return runId;
  }
  const tick = (t: TestT) => t.action(internal.imports.runScheduled, {});

  it("is quiet time since the last stamp, or for an unstamped run, age past 12 hours", () => {
    const now = 100 * HOUR;
    const opened = now - 5 * HOUR;
    expect(isStranded({ _creationTime: opened, lastActivityAt: now - STRANDED_AFTER_MS }, now)).toBe(false);
    expect(isStranded({ _creationTime: opened, lastActivityAt: now - STRANDED_AFTER_MS - 1 }, now)).toBe(true);
    // A multi-hour chain that passed the gate a minute ago is live.
    expect(isStranded({ _creationTime: now - 20 * HOUR, lastActivityAt: now - 60_000 }, now)).toBe(false);
    expect(isStranded({ _creationTime: now - 12 * HOUR }, now)).toBe(false);
    expect(isStranded({ _creationTime: now - 12 * HOUR - 1 }, now)).toBe(true);
  });

  it("closes a quiet run as failed, counts the failure, and dispatches the source", async () => {
    const t = makeT();
    await seedRegistry(t);
    const opened = Date.now();
    const runId = await openRun(t, opened);
    clockAt(opened + 23 * HOUR);
    expect(await tick(t)).toMatchObject({ started: expect.arrayContaining(["sevenseas"]) });
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run).toMatchObject({ status: "failed" });
      expect(run?.errors).toEqual([
        `Stranded: no activity since ${new Date(opened).toISOString()}; closed by the scheduler.`,
      ]);
    });
    expect(await sevenSeas(t)).toMatchObject({ consecutiveFailures: 1 });
  });

  it("still defers a source whose hours-old run passed the gate recently", async () => {
    const t = makeT();
    await seedRegistry(t);
    const later = Date.now() + 23 * HOUR;
    const runId = await openRun(t, later - 60_000);
    clockAt(later);
    const { started } = await tick(t);
    expect(started).not.toContain("sevenseas");
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "running" });
    expect(await sevenSeas(t)).toMatchObject({ consecutiveFailures: 0 });
  });

  it("leaves a run opened before heartbeats alone until it is 12 hours old", async () => {
    const t = makeT();
    await seedRegistry(t);
    const opened = Date.now();
    const runId = await t.run((ctx) =>
      ctx.db.insert("importRuns", { sourceKey: "sevenseas", status: "running", recordsSeen: 0, recordsChanged: 0, errors: [] }),
    );
    clockAt(opened + 11 * HOUR);
    await tick(t);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "running" });
    clockAt(opened + 13 * HOUR);
    await tick(t);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "failed" });
    expect(await sevenSeas(t)).toMatchObject({ consecutiveFailures: 1 });
  });

  it("closes a run once when two ticks overlap", async () => {
    const t = makeT();
    await seedRegistry(t);
    const opened = Date.now();
    const runId = await openRun(t, opened);
    clockAt(opened + 2 * HOUR);
    await Promise.all([tick(t), tick(t)]);
    await tick(t);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.status).toBe("failed");
    expect(run?.errors.filter((e) => e.startsWith("Stranded:"))).toHaveLength(1);
    expect(await sevenSeas(t)).toMatchObject({ consecutiveFailures: 1 });
  });

  it("stamps the run at each gate pass that lets it go on", async () => {
    const t = makeT();
    await seedRegistry(t);
    const opened = Date.now();
    const runId = await openRun(t, opened);
    const pass = () =>
      t.mutation(internal.imports.stopIfAutomatic, {
        runId,
        sourceKey: "sevenseas",
        recordsSeen: 0,
        recordsChanged: 0,
        errors: [],
      });
    clockAt(opened + 20 * 60_000);
    expect(await pass()).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ lastActivityAt: opened + 20 * 60_000 });
    // A forced run on a disabled source passes too, and is stamped.
    await t.run((ctx) => ctx.db.patch(runId, { automatic: undefined }));
    await t.mutation(internal.importSources.setEnabledInternal, { key: "sevenseas", enabled: false });
    clockAt(opened + 40 * 60_000);
    expect(await pass()).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ lastActivityAt: opened + 40 * 60_000 });
  });

  it("closes a stranded run with the counts and errors its last pass stored", async () => {
    const t = makeT();
    await seedRegistry(t);
    const opened = Date.now();
    const runId = await openRun(t, opened);
    const carried = Array.from({ length: 60 }, (_, i) => `error ${i}`);
    clockAt(opened + 3 * HOUR);
    expect(
      await t.mutation(internal.imports.stopIfAutomatic, {
        runId,
        sourceKey: "sevenseas",
        recordsSeen: 1200,
        recordsChanged: 85,
        errors: carried,
      }),
    ).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      recordsSeen: 1200,
      recordsChanged: 85,
      errors: carried.slice(0, 50),
    });
    // A hand-off stores its totals the same way.
    clockAt(opened + 4 * HOUR);
    await t.mutation(internal.imports.recordRunActivity, {
      runId,
      recordsSeen: 1300,
      recordsChanged: 90,
      errors: carried.slice(0, 2),
    });
    clockAt(opened + 6 * HOUR);
    expect(await t.mutation(internal.imports.closeStrandedRun, { runId })).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "failed",
      recordsSeen: 1300,
      recordsChanged: 90,
      errors: [
        "error 0",
        "error 1",
        `Stranded: no activity since ${new Date(opened + 4 * HOUR).toISOString()}; closed by the scheduler.`,
      ],
    });
  });

  it("leaves a closed run alone at a hand-off", async () => {
    const t = makeT();
    await seedRegistry(t);
    const runId = await openRun(t, Date.now());
    await t.mutation(internal.imports.finishRun, { runId, status: "succeeded", recordsSeen: 3, recordsChanged: 1, errors: [] });
    const before = await t.run((ctx) => ctx.db.get(runId));
    clockAt(Date.now() + HOUR);
    await t.mutation(internal.imports.recordRunActivity, { runId, recordsSeen: 9, recordsChanged: 9, errors: ["late"] });
    expect(await t.run((ctx) => ctx.db.get(runId))).toEqual(before);
  });

  it("stops a closed run's chain without writing to the run or the source's health", async () => {
    const t = makeT();
    await seedRegistry(t);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "sevenseas" });
    await t.mutation(internal.imports.finishRun, {
      runId,
      status: "failed",
      recordsSeen: 3,
      recordsChanged: 1,
      errors: ["closed elsewhere"],
    });
    const before = await t.run((ctx) => ctx.db.get(runId));
    const health = await sevenSeas(t);
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("", { status: 503 });
    });
    expect(await t.action(internal.sevenSeas.sync, { politeDelayMs: 0, runId })).toEqual({ skipped: "disabled" });
    expect(requested).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(runId))).toEqual(before);
    expect(await sevenSeas(t)).toEqual(health);
  });
});

describe("importSources.seedRegistry", () => {
  it("seeds the five v1 sources plus Yen Press and the Kodansha backlist per the spec authority table", async () => {
    const t = makeT();
    const { inserted } = await t.mutation(internal.importSources.seedRegistry, {});
    expect(inserted.sort()).toEqual(SOURCE_KEYS);
    const sources = await t.run((ctx) => ctx.db.query("approvedSources").collect());
    const sevenSeas = sources.find((s) => s.key === "sevenseas")!;
    expect(sevenSeas).toMatchObject({
      enabled: true,
      cadence: "daily",
      healthState: "healthy",
      consecutiveFailures: 0,
      fieldAuthority: { date: "authoritative", isbn: "authoritative" },
    });
    // ANN's ISBN authority is weak: it fills a blank ISBN, never overrides (spec §6 table).
    const ann = sources.find((s) => s.key === "ann")!;
    expect(ann.fieldAuthority.isbn).toBe("weak");
    // Every adapter exists (#34/#36 + Yen Press + Kodansha backlist), so every row seeds enabled.
    expect(sources.every((s) => s.enabled)).toBe(true);
  });

  it("never overwrites an edited row on re-run", async () => {
    const t = makeT();
    await setup(t);
    await seedRegistry(t);
    await signedIn(t, alice).mutation(api.importSources.upsert, {
      key: "sevenseas",
      name: "Seven Seas Entertainment",
      enabled: false,
      scope: "Seven Seas' own catalog",
      fieldAuthority: { date: "weak" },
      cadence: "weekly",
    });
    const { inserted } = await t.mutation(internal.importSources.seedRegistry, {});
    expect(inserted).toEqual([]);
    const sources = await signedIn(t, alice).query(api.importSources.list, {});
    const sevenSeas = sources.find((s) => s.key === "sevenseas")!;
    expect(sevenSeas.cadence).toBe("weekly");
    expect(sevenSeas.enabled).toBe(false);
    expect(sevenSeas.fieldAuthority).toEqual({ date: "weak" });
  });
});

describe("importSources.backfillFieldAuthority", () => {
  it("adds default categories a stored row lacks, never changing a set one", async () => {
    const t = makeT();
    await seedRegistry(t);
    // A deployment seeded before the description column existed, plus an
    // Administrator who already chose ANN's description authority.
    await t.run(async (ctx) => {
      for (const source of await ctx.db.query("approvedSources").collect()) {
        const { description: _, ...rest } = source.fieldAuthority;
        await ctx.db.patch(source._id, {
          fieldAuthority: source.key === "ann" ? { ...rest, description: "standard" } : rest,
        });
      }
    });

    const { added } = await t.mutation(internal.importSources.backfillFieldAuthority, {});
    expect(added).toContainEqual({
      key: "kodansha",
      category: "description",
      level: "authoritative",
    });
    expect(added).toContainEqual({ key: "prh", category: "description", level: "standard" });
    expect(added.some((row) => row.key === "ann")).toBe(false);
    expect(added.every((row) => row.category === "description")).toBe(true);

    const sources = await t.run((ctx) => ctx.db.query("approvedSources").collect());
    const byKey = new Map(sources.map((s) => [s.key, s.fieldAuthority]));
    expect(byKey.get("kodansha")).toMatchObject({
      description: "authoritative",
      date: "authoritative",
    });
    expect(byKey.get("ann")?.description).toBe("standard");

    // Idempotent: a second run has nothing left to add.
    const again = await t.mutation(internal.importSources.backfillFieldAuthority, {});
    expect(again.added).toEqual([]);
  });

  it("keeps a weak description an Administrator already set", async () => {
    const t = makeT();
    await seedRegistry(t);
    await t.run(async (ctx) => {
      const kodansha = (await ctx.db.query("approvedSources").collect()).find(
        (s) => s.key === "kodansha",
      )!;
      await ctx.db.patch(kodansha._id, { fieldAuthority: { date: "weak", description: "weak" } });
    });
    const { added } = await t.mutation(internal.importSources.backfillFieldAuthority, {});
    expect(added.filter((row) => row.key === "kodansha").map((row) => row.category).sort()).toEqual(
      ["creators", "format", "isbn", "price", "titles"],
    );
    const kodansha = await t.run(async (ctx) =>
      (await ctx.db.query("approvedSources").collect()).find((s) => s.key === "kodansha"),
    );
    expect(kodansha?.fieldAuthority).toMatchObject({ date: "weak", description: "weak" });
  });
});

describe("importSources.upsert — registry rows are data", () => {
  it("adds a brand-new source with no code change", async () => {
    const t = makeT();
    await setup(t);
    const row = {
      key: "yenpress",
      name: "Yen Press",
      enabled: false,
      scope: "Yen Press catalog",
      fieldAuthority: { date: "authoritative", isbn: "authoritative" },
      cadence: "daily",
      attribution: "Data courtesy of Yen Press.",
    } as const;
    await signedIn(t, alice).mutation(api.importSources.upsert, row);
    const sources = await signedIn(t, alice).query(api.importSources.list, {});
    // The registry was empty: the one row listed is the new source, as given.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject(row);
  });

  it("is Administrator-gated and validates keys", async () => {
    const t = makeT();
    await setup(t);
    const args = {
      key: "x",
      name: "X",
      enabled: false,
      scope: "x",
      fieldAuthority: {},
      cadence: "daily",
    };
    await expect(
      signedIn(t, dave).mutation(api.importSources.upsert, args),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      signedIn(t, alice).mutation(api.importSources.upsert, { ...args, key: "Bad Key!" }),
    ).rejects.toMatchObject({ data: { code: "invalidKey" } });
  });
});

describe("Bootstrap Mode", () => {
  it("defaults off, toggles via the admin mutation, reads via bootstrapStatus", async () => {
    const t = makeT();
    await setup(t);
    const admin = signedIn(t, alice);
    expect(await admin.query(api.importSources.bootstrapStatus, {})).toEqual({
      bootstrapMode: false,
    });
    await admin.mutation(api.importSources.setBootstrapMode, { on: true });
    expect(await admin.query(api.importSources.bootstrapStatus, {})).toEqual({
      bootstrapMode: true,
    });
    await expect(
      signedIn(t, dave).mutation(api.importSources.setBootstrapMode, { on: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("import runs & source health", () => {
  it("logs source, timing, counts, and errors", async () => {
    const t = makeT();
    await setup(t);
    await seedRegistry(t);
    await finishRun(t, "succeeded", { recordsSeen: 10, recordsChanged: 2 });
    const runs = await signedIn(t, alice).query(api.imports.recentRuns, { sourceKey: "sevenseas" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sourceKey: "sevenseas",
      status: "succeeded",
      recordsSeen: 10,
      recordsChanged: 2,
      errors: [],
    });
    expect(runs[0]!.finishedAt).toBeDefined();
  });

  it("flips unhealthy after three consecutive failures and recovers on success", async () => {
    const t = makeT();
    await seedRegistry(t);
    const health = async () =>
      await t.run(async (ctx) => {
        const s = await ctx.db
          .query("approvedSources")
          .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
          .unique();
        return { state: s!.healthState, failures: s!.consecutiveFailures };
      });

    await finishRun(t, "failed");
    await finishRun(t, "failed");
    expect(await health()).toEqual({ state: "healthy", failures: 2 });
    await finishRun(t, "failed");
    expect(await health()).toEqual({ state: "unhealthy", failures: 3 });
    await finishRun(t, "succeeded");
    expect(await health()).toEqual({ state: "healthy", failures: 0 });
    await drain(t); // the health alerts the transitions scheduled
  });
});

describe("imports.stopIfAutomatic", () => {
  it("keeps the stop note on a run that already carries fifty errors", async () => {
    const t = makeT();
    await seedRegistry(t);
    const runId = await t.mutation(internal.imports.startRun, { sourceKey: "sevenseas", automatic: true });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "sevenseas", enabled: false });
    const carried = Array.from({ length: 50 }, (_, i) => `error ${i}`);
    expect(
      await t.mutation(internal.imports.stopIfAutomatic, {
        runId,
        sourceKey: "sevenseas",
        recordsSeen: 0,
        recordsChanged: 0,
        errors: carried,
      }),
    ).toBe(true);
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run?.status).toBe("stopped");
      expect(run?.errors).toEqual([...carried.slice(0, 49), "Stopped: the source was disabled mid-run."]);
    });
  });

  // An action deployed before the gate took a source key calls it without
  // one, and only after reading its source as disabled.
  it("accepts a call without a source key, as actions deployed before it make", async () => {
    const t = makeT();
    await seedRegistry(t);
    const automatic = await t.mutation(internal.imports.startRun, { sourceKey: "ann", automatic: true });
    const forced = await t.mutation(internal.imports.startRun, { sourceKey: "ann" });
    await t.mutation(internal.importSources.setEnabledInternal, { key: "ann", enabled: false });
    const legacy = (runId: typeof automatic) =>
      t.mutation(internal.imports.stopIfAutomatic, { runId, recordsSeen: 4, recordsChanged: 2, errors: ["e"] });
    expect(await legacy(automatic)).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(automatic))).toMatchObject({
      status: "stopped",
      recordsSeen: 4,
      errors: ["e", "Stopped: the source was disabled mid-run."],
    });
    expect(await legacy(forced)).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(forced))).toMatchObject({ status: "running", recordsSeen: 4 });
    // A closed run still stops the chain.
    expect(await legacy(automatic)).toBe(true);
  });
});

describe("cadence", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("isDue understands the registry cadence strings", () => {
    const now = Date.UTC(2026, 7, 19);
    expect(isDue("daily", null, now)).toBe(true);
    expect(isDue("daily", now - DAY, now)).toBe(true);
    expect(isDue("daily", now - DAY / 2, now)).toBe(false);
    expect(isDue("weekly", now - 7 * DAY, now)).toBe(true);
    expect(isDue("weekly", now - 3 * DAY, now)).toBe(false);
    expect(isDue("monthly", now - 30 * DAY, now)).toBe(true);
    expect(isDue("monthly", now - 10 * DAY, now)).toBe(false);
    // Unknown cadence strings never run rather than guessing.
    expect(isDue("hourly-ish", null, now)).toBe(false);
  });

  it("enabledSources reports only enabled rows with their last run", async () => {
    const t = makeT();
    await seedRegistry(t);
    const before = await t.query(internal.imports.enabledSources, {});
    // Every seeded source is enabled and unrun.
    expect(before.map((s) => s.key).sort()).toEqual(SOURCE_KEYS);
    expect(
      before.every((s) => s.lastStartedAt === null && s.lastStatus === null),
    ).toBe(true);
    await finishRun(t, "succeeded");
    const after = await t.query(internal.imports.enabledSources, {});
    expect(after[0]!.lastStatus).toBe("succeeded");
    expect(after[0]!.lastStartedAt).not.toBeNull();
  });
});

// ---------- withdrawal review (#37) ----------

/** One canonical Release linked (rung ①) to a Seven Seas observation. */
async function insertLinkedRelease(
  t: TestT,
  pubDate?: { year: number; month?: number; day?: number; sort: number },
) {
  return await t.run(async (ctx) => {
    const { releaseId } = await seedCatalog(ctx, {
      publisher: { name: "Seven Seas Entertainment", slug: "seven-seas" },
      series: { title: "Alpha Adventures" },
      release: { isbn13: "9781999000103", pubDate },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "sevenseas",
      sourceRecordId: "book:101",
      recordRef: { type: "release", id: releaseId },
      snapshot: { title: "Alpha Adventures Vol. 1" },
      lastSeenAt: 1_000,
    });
    return { releaseId, observationId };
  });
}

describe("withdrawal → possible-cancellation review (#37)", () => {
  const FUTURE = { year: 2100, month: 1, day: 6, sort: 21000106 };
  const PAST = { year: 2020, month: 3, day: 3, sort: 20200303 };

  it("possiblyFuture compares the latest day a partial date could mean", () => {
    const now = Date.UTC(2026, 7, 20); // 2026-08-20
    expect(possiblyFuture({ year: 2026, month: 8, day: 21 }, now)).toBe(true);
    expect(possiblyFuture({ year: 2026, month: 8, day: 20 }, now)).toBe(false);
    expect(possiblyFuture({ year: 2026 }, now)).toBe(true); // could be Dec 31
    expect(possiblyFuture({ year: 2026, month: 8 }, now)).toBe(true);
    expect(possiblyFuture({ year: 2026, month: 7 }, now)).toBe(false);
    expect(possiblyFuture({ year: 2025 }, now)).toBe(false);
  });

  it("queues one hide-op review for a future-dated linked Release, touching no field", async () => {
    const t = makeT();
    await setup(t);
    await seedRegistry(t);
    const { releaseId, observationId } = await insertLinkedRelease(t, FUTURE);
    const before = await t.run((ctx) => ctx.db.get(releaseId));

    const result = await t.mutation(internal.imports.markWithdrawn, {
      sourceKey: "sevenseas",
      notSeenSince: Date.now(),
    });
    expect(result).toEqual({ marked: 1, reviewsQueued: 1 });

    const obs = (await t.run((ctx) => ctx.db.get(observationId)))!;
    expect(obs.withdrawn).toBe(true);
    expect(obs.queuedProposalId).toBeDefined();

    // Absence never nulls a field: the Release is byte-for-byte untouched.
    const after = await t.run((ctx) => ctx.db.get(releaseId));
    expect(after).toEqual(before);

    const proposal = (await t.run((ctx) =>
      ctx.db.get(obs.queuedProposalId!),
    ))!;
    expect(proposal).toMatchObject({
      state: "inReview",
      author: { kind: "source", sourceKey: "sevenseas" },
    });
    const version = await t.run(async (ctx) =>
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
        .unique(),
    );
    expect(version!.ops).toEqual([
      { kind: "hide", ref: { type: "release", id: releaseId }, baseRevisionId: undefined },
    ]);
    expect(version!.changeComment).toContain("possible cancellation");
    expect(version!.evidence).toEqual([
      { kind: "observation", observationId },
    ]);

    // Approving the pre-filled guess hides the release — one click.
    await signedIn(t, alice).mutation(api.proposals.approveProposal, { proposalId: proposal._id });
    const hidden = await t.run((ctx) => ctx.db.get(releaseId));
    expect(hidden!.status).toBe("hidden");
  });

  it("leaves past-dated and undated linked Releases untouched (no review)", async () => {
    for (const pubDate of [PAST, undefined]) {
      const t = makeT();
      await seedRegistry(t);
      const { releaseId, observationId } = await insertLinkedRelease(t, pubDate);
      const result = await t.mutation(internal.imports.markWithdrawn, {
        sourceKey: "sevenseas",
        notSeenSince: Date.now(),
      });
      // Withdrawn — retained, never deleted — but nothing queues.
      expect(result).toEqual({ marked: 1, reviewsQueued: 0 });
      const obs = (await t.run((ctx) => ctx.db.get(observationId)))!;
      expect(obs.withdrawn).toBe(true);
      expect(obs.queuedProposalId).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual(
        [],
      );
      const release = await t.run((ctx) => ctx.db.get(releaseId));
      expect(release!.status).toBe("active");
      expect(release!.pubDate).toEqual(pubDate);
    }
  });

  it("never double-queues: an open or rejected review blocks a repeat", async () => {
    const t = makeT();
    await setup(t);
    await seedRegistry(t);
    const { observationId } = await insertLinkedRelease(t, FUTURE);
    await t.mutation(internal.imports.markWithdrawn, {
      sourceKey: "sevenseas",
      notSeenSince: Date.now(),
    });
    // The source relists the book (withdrawn clears), then drops it again.
    await t.run(async (ctx) => {
      await ctx.db.patch(observationId, { withdrawn: false, lastSeenAt: 2_000 });
    });
    const again = await t.mutation(internal.imports.markWithdrawn, {
      sourceKey: "sevenseas",
      notSeenSince: Date.now(),
    });
    expect(again.reviewsQueued).toBe(0); // the first review is still open
    const proposals = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(proposals).toHaveLength(1);
  });
});

// ---------- health alert emails (#37) ----------

describe("source health alert emails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  type Sent = { to: string; subject: string; text: string };

  function stubResend(sent: Sent[]) {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("IMPORT_ALERT_EMAIL_TO", "admin@example.com");
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "object" && "url" in input ? input.url : String(input);
        if (url === "https://api.resend.com/emails") {
          sent.push(JSON.parse(String(init?.body)) as Sent);
          return new Response(JSON.stringify({ id: "email_1" }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
  }

  it("emails the Administrator exactly once per transition, each way", async () => {
    const t = makeT();
    await seedRegistry(t);
    const sent: Sent[] = [];
    stubResend(sent);

    // Two failures: still healthy, no email.
    await finishRun(t, "failed");
    await finishRun(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(0);

    // Third failure: the transition — exactly one email.
    await finishRun(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("admin@example.com");
    expect(sent[0]!.subject).toContain("unhealthy");
    expect(sent[0]!.subject).toContain("Seven Seas");
    expect(sent[0]!.text).toContain("3 consecutive failed runs");
    expect(sent[0]!.text).toContain("HTTP 500 for /wp-json");

    // A fourth failure while already unhealthy: no repeat.
    await finishRun(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(1);

    // Recovery: exactly one more.
    await finishRun(t, "succeeded");
    await drain(t);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toContain("recovered");

    // Staying healthy never re-sends.
    await finishRun(t, "succeeded");
    await drain(t);
    expect(sent).toHaveLength(2);
  });

  it("skips (never throws) when email is unconfigured", async () => {
    const t = makeT();
    await seedRegistry(t);
    const result = await t.action(internal.imports.healthAlert, {
      sourceKey: "sevenseas",
      transition: "unhealthy",
      consecutiveFailures: 3,
      errors: [],
    });
    expect(result).toMatchObject({ sent: false });
    expect((result as { reason: string }).reason).toContain("unconfigured");
  });
});

// ---------- the Data Team dashboard (#37) ----------

describe("imports.dashboard", () => {
  it("is data-team gated and flags unhealthy sources first with last-run summaries", async () => {
    const t = makeT();
    await setup(t);
    await seedRegistry(t);
    for (let i = 0; i < 3; i++) await finishRun(t, "failed", { sourceKey: "kodansha", recordsSeen: 5 });
    await expect(
      signedIn(t, dave).query(api.imports.dashboard, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const rows = await signedIn(t, alice).query(api.imports.dashboard, {});
    expect(rows.map((r) => r.key)[0]).toBe("kodansha"); // unhealthy first
    const kodansha = rows.find((r) => r.key === "kodansha")!;
    expect(kodansha).toMatchObject({
      healthState: "unhealthy",
      consecutiveFailures: 3,
    });
    expect(kodansha.lastRun).toMatchObject({
      status: "failed",
      recordsSeen: 5,
      recordsChanged: 0,
      errorCount: 1,
    });
    expect(kodansha.lastRun!.startedAt).toBeGreaterThan(0);
    // Unrun sources still appear, healthy, with no run yet.
    const ann = rows.find((r) => r.key === "ann")!;
    expect(ann.healthState).toBe("healthy");
    expect(ann.lastRun).toBeNull();
    await drain(t); // the health alert the transition scheduled
  });
});

describe("imports.bootstrapBacklog", () => {
  it("is moderator-gated and reports tagged records per type", async () => {
    const t = makeT();
    await setup(t);
    await t.run(async (ctx) => {
      await insertSeries(ctx, { title: "Tagged", bootstrapUnreviewed: true });
      await insertSeries(ctx, { title: "Untagged" });
    });
    await expect(
      signedIn(t, dave).query(api.imports.bootstrapBacklog, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    const backlog = await signedIn(t, alice).query(api.imports.bootstrapBacklog, {});
    expect(backlog.series.count).toBe(1);
    expect(backlog.volumes.count).toBe(0);
    expect(backlog.releases.count).toBe(0);
  });
});
