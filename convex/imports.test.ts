// Import-foundation tests (ticket #34, spec §6/§7): the Approved Source
// registry as editable data, Bootstrap Mode toggling, Import Run logging
// with the three-consecutive-failures health rule, and cadence dispatch.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import { isDue } from "./imports";
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
    expect(ann.enabled).toBe(false);
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
    expect(before).toEqual([
      { key: "sevenseas", cadence: "daily", lastStartedAt: null, lastStatus: null },
    ]);
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
