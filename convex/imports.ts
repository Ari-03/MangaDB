// Shared import machinery (ticket #34, spec §6): Import Run logging, the
// cadence dispatcher that turns registry rows into scheduled adapter runs,
// the post-sweep withdrawal pass, and the bootstrap-unreviewed backlog
// query. Source-specific fetch/parse/apply lives in each adapter module
// (sevenSeas.ts is the first); everything here is source-agnostic.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { recordSourceOutcome } from "./importSources";
import { requireModerator } from "./lib/roles";

// ---------- Import Runs (spec §6: runs & failure) ----------

/** Errors kept per run — enough to debug, bounded so a bad sweep can't bloat. */
const MAX_RUN_ERRORS = 50;

export const startRun = internalMutation({
  args: { sourceKey: v.string() },
  handler: async (ctx, { sourceKey }) => {
    return await ctx.db.insert("importRuns", {
      sourceKey,
      status: "running",
      recordsSeen: 0,
      recordsChanged: 0,
      errors: [],
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("importRuns"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      recordsSeen: args.recordsSeen,
      recordsChanged: args.recordsChanged,
      errors: args.errors.slice(0, MAX_RUN_ERRORS),
    });
    await recordSourceOutcome(ctx, run.sourceKey, args.status === "succeeded");
  },
});

/** Recent runs of one source (or all), newest first — the ops view. */
export const recentRuns = query({
  args: { sourceKey: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { sourceKey, limit }) => {
    await requireModerator(ctx);
    const n = Math.min(limit ?? 20, 100);
    if (sourceKey !== undefined) {
      return await ctx.db
        .query("importRuns")
        .withIndex("by_source", (q) => q.eq("sourceKey", sourceKey))
        .order("desc")
        .take(n);
    }
    return await ctx.db.query("importRuns").order("desc").take(n);
  },
});

// ---------- cadence (spec §6) ----------

// Cadence is a registry data string; the dispatcher understands these
// intervals. Values are slightly under the nominal period so an hourly tick
// never skips a day through scheduling jitter. An unrecognized cadence
// never runs (and logs) rather than guessing.
const CADENCE_INTERVALS_MS: Record<string, number> = {
  daily: 22 * 60 * 60 * 1000,
  weekly: 6.5 * 24 * 60 * 60 * 1000,
  monthly: 27 * 24 * 60 * 60 * 1000,
};

/** Is a source with this cadence due, given its last run start time? */
export function isDue(
  cadence: string,
  lastStartedAt: number | null,
  now: number,
): boolean {
  const interval = CADENCE_INTERVALS_MS[cadence.trim().toLowerCase()];
  if (interval === undefined) return false;
  if (lastStartedAt === null) return true;
  return now - lastStartedAt >= interval;
}

// The code half of the registry: which adapter action serves each source
// key. A registry row without an adapter is inert data until its adapter
// ships (Kodansha, PRH, ANN, OpenLibrary are later tickets).
// Adapters take only optional tuning args, so dispatching with {} is valid.
const ADAPTERS: Record<
  string,
  FunctionReference<"action", "internal", Record<string, unknown>>
> = {
  sevenseas: internal.sevenSeas.sync,
};

export const enabledSources = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sources = await ctx.db.query("approvedSources").collect();
    const result = [];
    for (const source of sources) {
      if (!source.enabled) continue;
      const lastRun = await ctx.db
        .query("importRuns")
        .withIndex("by_source", (q) => q.eq("sourceKey", source.key))
        .order("desc")
        .first();
      result.push({
        key: source.key,
        cadence: source.cadence,
        lastStartedAt: lastRun?._creationTime ?? null,
        lastStatus: lastRun?.status ?? null,
      });
    }
    return result;
  },
});

/**
 * The hourly cron tick (crons.ts): read the registry, start every enabled,
 * due source that has an adapter. Cadence edits take effect on the next
 * tick — no code change (spec §6). A still-running run defers the source.
 */
export const runScheduled = internalAction({
  args: {},
  handler: async (ctx) => {
    const sources = await ctx.runQuery(internal.imports.enabledSources, {});
    const now = Date.now();
    const started: string[] = [];
    for (const source of sources) {
      const adapter = ADAPTERS[source.key];
      if (!adapter) continue;
      if (source.lastStatus === "running") continue;
      if (!isDue(source.cadence, source.lastStartedAt, now)) {
        if (CADENCE_INTERVALS_MS[source.cadence.trim().toLowerCase()] === undefined) {
          console.warn(
            `[imports] source "${source.key}" has unrecognized cadence "${source.cadence}" — skipping`,
          );
        }
        continue;
      }
      await ctx.scheduler.runAfter(0, adapter, {});
      started.push(source.key);
    }
    return { started };
  },
});

// ---------- withdrawal (spec §6: observations) ----------

/**
 * After a COMPLETE listing sweep, observations the sweep did not touch have
 * disappeared at the source: mark them withdrawn — retained, never deleted;
 * absence is never evidence and downtime never expires data (which is why
 * only a complete sweep may call this). Synthetic link observations (the
 * `series:` rung-① links) are skipped: only books appear in the listing.
 *
 * Withdrawal also lifts the record's conflict suppressions from this source
 * (spec §6: suppression holds until the value, observation, or rules
 * change) — if the record ever reappears, its conflicts get a fresh look.
 */
export const markWithdrawn = internalMutation({
  args: { sourceKey: v.string(), notSeenSince: v.number() },
  handler: async (ctx, { sourceKey, notSeenSince }) => {
    const stale = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_seen", (q) =>
        q.eq("sourceKey", sourceKey).lt("lastSeenAt", notSeenSince),
      )
      .collect();
    let marked = 0;
    for (const obs of stale) {
      if (obs.withdrawn) continue;
      if (obs.sourceRecordId.startsWith("series:")) continue;
      await ctx.db.patch(obs._id, { withdrawn: true });
      if (obs.recordRef) {
        const suppressions = await ctx.db
          .query("conflictSuppressions")
          .withIndex("by_key", (q) =>
            q
              .eq("ref.type", obs.recordRef!.type)
              .eq("ref.id", obs.recordRef!.id as never),
          )
          .collect();
        for (const row of suppressions) {
          if (row.sourceKey === sourceKey) await ctx.db.delete(row._id);
        }
      }
      marked++;
    }
    return { marked };
  },
});

// ---------- the bootstrap-unreviewed backlog (spec §7) ----------

const BACKLOG_SAMPLE = 100;

/**
 * The queryable post-launch review backlog: every canonical record created
 * in Bootstrap Mode that steady-state rules would have queued. Counts are
 * exact up to the sample cap per type.
 */
export const bootstrapBacklog = query({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    const backlogOf = async (
      table: "series" | "volumes" | "editions" | "releases" | "releaseBundles",
    ) => {
      const docs = await ctx.db
        .query(table)
        .withIndex("by_bootstrap", (q) => q.eq("bootstrapUnreviewed", true))
        .take(BACKLOG_SAMPLE + 1);
      return {
        count: Math.min(docs.length, BACKLOG_SAMPLE),
        hasMore: docs.length > BACKLOG_SAMPLE,
        ids: docs.slice(0, BACKLOG_SAMPLE).map((d) => d._id),
      };
    };
    return {
      series: await backlogOf("series"),
      volumes: await backlogOf("volumes"),
      editions: await backlogOf("editions"),
      releases: await backlogOf("releases"),
      bundles: await backlogOf("releaseBundles"),
    };
  },
});
