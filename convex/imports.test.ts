// Import-foundation and steady-state tests (tickets #34/#37, spec §6/§7):
// the Approved Source registry as editable data, Bootstrap Mode toggling,
// Import Run logging with the three-consecutive-failures health rule,
// cadence dispatch, withdrawal's possible-cancellation review, the exactly-
// once Administrator health emails, and the Data Team dashboard.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { isDue, possiblyFuture } from "./imports";
import schema from "./schema";

const ADMIN = "user_admin";
const PLAIN = "user_plain";

async function setup(t: ReturnType<typeof convexTest>) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
}

describe("importSources.seedRegistry", () => {
  it("seeds the five v1 sources per the spec authority table", async () => {
    const t = convexTest(schema);
    const { inserted } = await t.mutation(internal.importSources.seedRegistry, {});
    expect(inserted.sort()).toEqual([
      "ann",
      "kodansha",
      "openlibrary",
      "prh",
      "sevenseas",
    ]);
    const sources = await t.run((ctx) => ctx.db.query("approvedSources").collect());
    const sevenSeas = sources.find((s) => s.key === "sevenseas")!;
    expect(sevenSeas).toMatchObject({
      enabled: true,
      cadence: "daily",
      healthState: "healthy",
      consecutiveFailures: 0,
      fieldAuthority: { date: "authoritative", isbn: "authoritative" },
    });
    // ANN has no ISBN authority at all (spec §6 table).
    const ann = sources.find((s) => s.key === "ann")!;
    expect(ann.fieldAuthority.isbn).toBeUndefined();
    // All five adapters exist (#34/#36), so every row seeds enabled.
    expect(sources.every((s) => s.enabled)).toBe(true);
  });

  it("never overwrites an edited row on re-run", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
    await t.withIdentity({ subject: ADMIN }).mutation(api.importSources.upsert, {
      key: "sevenseas",
      name: "Seven Seas Entertainment",
      enabled: false,
      scope: "Seven Seas' own catalog",
      fieldAuthority: { date: "weak" },
      cadence: "weekly",
    });
    const { inserted } = await t.mutation(internal.importSources.seedRegistry, {});
    expect(inserted).toEqual([]);
    const sources = await t
      .withIdentity({ subject: ADMIN })
      .query(api.importSources.list, {});
    const sevenSeas = sources.find((s) => s.key === "sevenseas")!;
    expect(sevenSeas.cadence).toBe("weekly");
    expect(sevenSeas.enabled).toBe(false);
    expect(sevenSeas.fieldAuthority).toEqual({ date: "weak" });
  });
});

describe("importSources.upsert — registry rows are data", () => {
  it("adds a brand-new source with no code change", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.withIdentity({ subject: ADMIN }).mutation(api.importSources.upsert, {
      key: "yenpress",
      name: "Yen Press",
      enabled: false,
      scope: "Yen Press catalog",
      fieldAuthority: { date: "authoritative", isbn: "authoritative" },
      cadence: "daily",
      attribution: "Data courtesy of Yen Press.",
    });
    const sources = await t
      .withIdentity({ subject: ADMIN })
      .query(api.importSources.list, {});
    expect(sources.map((s) => s.key)).toContain("yenpress");
  });

  it("is Administrator-gated and validates keys", async () => {
    const t = convexTest(schema);
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
      t.withIdentity({ subject: PLAIN }).mutation(api.importSources.upsert, args),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t
        .withIdentity({ subject: ADMIN })
        .mutation(api.importSources.upsert, { ...args, key: "Bad Key!" }),
    ).rejects.toMatchObject({ data: { code: "invalidKey" } });
  });
});

describe("Bootstrap Mode", () => {
  it("defaults off, toggles via the admin mutation, reads via bootstrapStatus", async () => {
    const t = convexTest(schema);
    await setup(t);
    const admin = t.withIdentity({ subject: ADMIN });
    expect(await admin.query(api.importSources.bootstrapStatus, {})).toEqual({
      bootstrapMode: false,
    });
    await admin.mutation(api.importSources.setBootstrapMode, { on: true });
    expect(await admin.query(api.importSources.bootstrapStatus, {})).toEqual({
      bootstrapMode: true,
    });
    await expect(
      t
        .withIdentity({ subject: PLAIN })
        .mutation(api.importSources.setBootstrapMode, { on: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("import runs & source health", () => {
  const finish = async (
    t: ReturnType<typeof convexTest>,
    status: "succeeded" | "failed",
  ) => {
    const runId = await t.mutation(internal.imports.startRun, {
      sourceKey: "sevenseas",
    });
    await t.mutation(internal.imports.finishRun, {
      runId,
      status,
      recordsSeen: 10,
      recordsChanged: status === "succeeded" ? 2 : 0,
      errors: status === "failed" ? ["boom"] : [],
    });
  };

  it("logs source, timing, counts, and errors", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
    await finish(t, "succeeded");
    const runs = await t
      .withIdentity({ subject: ADMIN })
      .query(api.imports.recentRuns, { sourceKey: "sevenseas" });
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
    const t = convexTest(schema);
    await t.mutation(internal.importSources.seedRegistry, {});
    const health = async () =>
      await t.run(async (ctx) => {
        const s = await ctx.db
          .query("approvedSources")
          .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
          .unique();
        return { state: s!.healthState, failures: s!.consecutiveFailures };
      });

    await finish(t, "failed");
    await finish(t, "failed");
    expect(await health()).toEqual({ state: "healthy", failures: 2 });
    await finish(t, "failed");
    expect(await health()).toEqual({ state: "unhealthy", failures: 3 });
    await finish(t, "succeeded");
    expect(await health()).toEqual({ state: "healthy", failures: 0 });
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
    const t = convexTest(schema);
    await t.mutation(internal.importSources.seedRegistry, {});
    const before = await t.query(internal.imports.enabledSources, {});
    // All five seeded sources are enabled and unrun.
    expect(before.map((s) => s.key).sort()).toEqual([
      "ann",
      "kodansha",
      "openlibrary",
      "prh",
      "sevenseas",
    ]);
    expect(
      before.every((s) => s.lastStartedAt === null && s.lastStatus === null),
    ).toBe(true);
    const runId = await t.mutation(internal.imports.startRun, {
      sourceKey: "sevenseas",
    });
    await t.mutation(internal.imports.finishRun, {
      runId,
      status: "succeeded",
      recordsSeen: 0,
      recordsChanged: 0,
      errors: [],
    });
    const after = await t.query(internal.imports.enabledSources, {});
    expect(after[0]!.lastStatus).toBe("succeeded");
    expect(after[0]!.lastStartedAt).not.toBeNull();
  });
});

// ---------- withdrawal review (#37) ----------

/** One canonical Release linked (rung ①) to a Seven Seas observation. */
async function insertLinkedRelease(
  t: ReturnType<typeof convexTest>,
  pubDate?: { year: number; month?: number; day?: number; sort: number },
) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Alpha Adventures",
      altTitles: [],
      searchText: "Alpha Adventures",
    });
    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      publicId: 1,
      seriesId,
      position: 1,
      label: "1",
    });
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: 1,
      publisherId,
    });
    await ctx.db.insert("volumeCoverages", {
      editionId,
      volumeId,
      order: 1,
      extent: "complete",
    });
    const releaseId = await ctx.db.insert("releases", {
      status: "active",
      editionId,
      format: "physical",
      language: "en",
      isbn13: "9781999000103",
      pubDate,
      publisherId,
      seriesIds: [seriesId],
    });
    const observationId = await ctx.db.insert("sourceObservations", {
      sourceKey: "sevenseas",
      sourceRecordId: "book:101",
      recordRef: { type: "release", id: releaseId },
      snapshot: { title: "Alpha Adventures Vol. 1" },
      lastSeenAt: 1_000,
      withdrawn: false,
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
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
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
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.proposals.approveProposal, { proposalId: proposal._id });
    const hidden = await t.run((ctx) => ctx.db.get(releaseId));
    expect(hidden!.status).toBe("hidden");
  });

  it("leaves past-dated and undated linked Releases untouched (no review)", async () => {
    for (const pubDate of [PAST, undefined]) {
      const t = convexTest(schema);
      await t.mutation(internal.importSources.seedRegistry, {});
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
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
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

  const finish = async (
    t: ReturnType<typeof convexTest>,
    status: "succeeded" | "failed",
  ) => {
    const runId = await t.mutation(internal.imports.startRun, {
      sourceKey: "sevenseas",
    });
    await t.mutation(internal.imports.finishRun, {
      runId,
      status,
      recordsSeen: 0,
      recordsChanged: 0,
      errors: status === "failed" ? ["HTTP 500 for /wp-json"] : [],
    });
  };

  const drain = async (t: ReturnType<typeof convexTest>) => {
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  };

  it("emails the Administrator exactly once per transition, each way", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.importSources.seedRegistry, {});
    const sent: Sent[] = [];
    stubResend(sent);

    // Two failures: still healthy, no email.
    await finish(t, "failed");
    await finish(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(0);

    // Third failure: the transition — exactly one email.
    await finish(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("admin@example.com");
    expect(sent[0]!.subject).toContain("unhealthy");
    expect(sent[0]!.subject).toContain("Seven Seas");
    expect(sent[0]!.text).toContain("3 consecutive failed runs");
    expect(sent[0]!.text).toContain("HTTP 500 for /wp-json");

    // A fourth failure while already unhealthy: no repeat.
    await finish(t, "failed");
    await drain(t);
    expect(sent).toHaveLength(1);

    // Recovery: exactly one more.
    await finish(t, "succeeded");
    await drain(t);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toContain("recovered");

    // Staying healthy never re-sends.
    await finish(t, "succeeded");
    await drain(t);
    expect(sent).toHaveLength(2);
  });

  it("skips (never throws) when email is unconfigured", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.importSources.seedRegistry, {});
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
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
    for (let i = 0; i < 3; i++) {
      const runId = await t.mutation(internal.imports.startRun, {
        sourceKey: "kodansha",
      });
      await t.mutation(internal.imports.finishRun, {
        runId,
        status: "failed",
        recordsSeen: 5,
        recordsChanged: 0,
        errors: ["boom"],
      });
    }
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.imports.dashboard, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const rows = await t
      .withIdentity({ subject: ADMIN })
      .query(api.imports.dashboard, {});
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
  });
});

describe("imports.bootstrapBacklog", () => {
  it("is moderator-gated and reports tagged records per type", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "active",
        bootstrapUnreviewed: true,
        publicId: 1,
        title: "Tagged",
        altTitles: [],
        searchText: "Tagged",
      });
      await ctx.db.insert("series", {
        status: "active",
        publicId: 2,
        title: "Untagged",
        altTitles: [],
        searchText: "Untagged",
      });
    });
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.imports.bootstrapBacklog, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    const backlog = await t
      .withIdentity({ subject: ADMIN })
      .query(api.imports.bootstrapBacklog, {});
    expect(backlog.series.count).toBe(1);
    expect(backlog.volumes.count).toBe(0);
    expect(backlog.releases.count).toBe(0);
  });
});
