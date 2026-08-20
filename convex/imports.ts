// Shared import machinery (tickets #34/#37, spec §6): Import Run logging,
// the cadence dispatcher that turns registry rows into scheduled adapter
// runs, the post-sweep withdrawal pass (with its possible-cancellation
// review), source-health alert email, the Data Team dashboard queries, and
// the bootstrap-unreviewed backlog query. Source-specific fetch/parse/apply
// lives in each adapter module; everything here is source-agnostic.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { getSourceByKey, recordSourceOutcome } from "./importSources";
import { sendAdminEmail } from "./lib/email";
import { alreadyHandled } from "./lib/pipeline";
import { requireDataTeam, requireModerator } from "./lib/roles";
import { revisionsOf } from "./moderation";

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
    await recordSourceOutcome(
      ctx,
      run.sourceKey,
      args.status === "succeeded",
      args.errors,
    );
  },
});

/** Recent runs of one source (or all), newest first — Data Team inspection
 * of source, timing, records seen/changed, and errors (spec §6, #37). */
export const recentRuns = query({
  args: { sourceKey: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { sourceKey, limit }) => {
    await requireDataTeam(ctx);
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

/**
 * The Data Team dashboard's source table (#37): every registry row with its
 * health flag and last-run summary, unhealthy sources first.
 */
export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    const sources = await ctx.db.query("approvedSources").collect();
    const rows = [];
    for (const source of sources) {
      const lastRun = await ctx.db
        .query("importRuns")
        .withIndex("by_source", (q) => q.eq("sourceKey", source.key))
        .order("desc")
        .first();
      rows.push({
        key: source.key,
        name: source.name,
        enabled: source.enabled,
        cadence: source.cadence,
        healthState: source.healthState,
        consecutiveFailures: source.consecutiveFailures,
        lastRun: lastRun
          ? {
              status: lastRun.status,
              startedAt: lastRun._creationTime,
              finishedAt: lastRun.finishedAt ?? null,
              recordsSeen: lastRun.recordsSeen,
              recordsChanged: lastRun.recordsChanged,
              errorCount: lastRun.errors.length,
            }
          : null,
      });
    }
    return rows.sort(
      (a, b) =>
        Number(b.healthState === "unhealthy") -
          Number(a.healthState === "unhealthy") || a.key.localeCompare(b.key),
    );
  },
});

// ---------- health alert email (spec §6: runs & failure, #37) ----------

/**
 * Email the Administrator about a source-health transition. Scheduled by
 * recordSourceOutcome exactly once per transition — the health flip and the
 * scheduling commit in the same mutation, so unhealthy → email once,
 * recovery → email once, and repeated failures while already unhealthy (or
 * successes while healthy) never re-send. Unconfigured email (no
 * RESEND_API_KEY) logs and skips; the dashboard flag still shows the state.
 */
export const healthAlert = internalAction({
  args: {
    sourceKey: v.string(),
    transition: v.union(v.literal("unhealthy"), v.literal("recovered")),
    consecutiveFailures: v.number(),
    errors: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: args.sourceKey },
    );
    const name = source?.name ?? args.sourceKey;
    const subject =
      args.transition === "unhealthy"
        ? `[MangaDB] Import source unhealthy: ${name}`
        : `[MangaDB] Import source recovered: ${name}`;
    const lines =
      args.transition === "unhealthy"
        ? [
            `The import source "${name}" (${args.sourceKey}) is unhealthy after ${args.consecutiveFailures} consecutive failed runs.`,
            "",
            ...(args.errors.length > 0
              ? ["Errors from the latest run:", ...args.errors.map((e) => `  - ${e}`), ""]
              : []),
            "It will keep retrying on its registry cadence; you will get one more email when it recovers.",
            "Run history: https://mangadb.org/mod/imports",
          ]
        : [
            `The import source "${name}" (${args.sourceKey}) recovered — its latest run succeeded and it is healthy again.`,
            "Run history: https://mangadb.org/mod/imports",
          ];
    const result = await sendAdminEmail({ subject, text: lines.join("\n") });
    if (!result.sent) {
      console.warn(
        `[imports] health alert for "${args.sourceKey}" (${args.transition}) not emailed: ${result.reason}`,
      );
    }
    return result;
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
// ships. All five v1 sources have adapters (tickets #34/#36); adapters take
// only optional tuning args, so dispatching with {} is valid.
const ADAPTERS: Record<
  string,
  FunctionReference<"action", "internal", Record<string, unknown>>
> = {
  sevenseas: internal.sevenSeas.sync,
  kodansha: internal.kodansha.sync,
  ann: internal.ann.sync,
  prh: internal.prh.sync,
  openlibrary: internal.openLibrary.sync,
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

// ---------- covers (spec §6) ----------

/**
 * Attach a stored cover: {storageId, sourceUrl, attribution} per spec §6.
 * Source-agnostic; adapters only attach when the release has no cover yet
 * (the publisher's own art wins over a re-import from elsewhere). A racing
 * duplicate or vanished release deletes the fresh blob instead of orphaning
 * it; replacing an outdated same-URL-family cover deletes the old blob.
 */
export const attachCover = internalMutation({
  args: {
    releaseId: v.id("releases"),
    storageId: v.id("_storage"),
    sourceUrl: v.string(),
    attribution: v.string(),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.status !== "active" || release.coverImage) {
      await ctx.storage.delete(args.storageId);
      return { attached: false };
    }
    await ctx.db.patch(args.releaseId, {
      coverImage: {
        storageId: args.storageId,
        sourceUrl: args.sourceUrl,
        attribution: args.attribution,
      },
    });
    return { attached: true };
  },
});

// ---------- withdrawal (spec §6: observations, #37) ----------

/** yyyymmdd sort key for "today" (UTC) — comparable to releases.pubDate.sort. */
function todaySort(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Is this partial-precision date still (possibly) in the future? Compares
 * the latest day the date could mean, so "2026" and "Dec 2026" count as
 * future all year — a withdrawn listing for either may still be a
 * cancellation worth reviewing. A date fully in the past never is.
 */
export function possiblyFuture(
  pubDate: { year: number; month?: number; day?: number },
  now: number,
): boolean {
  const latest =
    pubDate.year * 10000 + (pubDate.month ?? 12) * 100 + (pubDate.day ?? 31);
  return latest > todaySort(now);
}

/**
 * A withdrawn observation whose linked Release is still future-dated is a
 * possible cancellation: queue one In-Review Proposal — a pre-filled `hide`
 * op the reviewer approves (confirmed cancellation) or rejects (keep the
 * release). Past-dated linked records are untouched, unlinked observations
 * queue nothing, and withdrawal itself never writes a canonical field —
 * absence is not evidence (spec §6). The observation's queuedProposalId
 * dedups: one open queue item per observation.
 */
async function queueWithdrawalReview(
  ctx: MutationCtx,
  sourceName: string,
  sourceKey: string,
  observation: Doc<"sourceObservations">,
): Promise<boolean> {
  if (observation.recordRef?.type !== "release") return false;
  const release = await ctx.db.get(observation.recordRef.id);
  if (!release || release.status !== "active" || release.locked) return false;
  if (!release.pubDate || !possiblyFuture(release.pubDate, Date.now())) {
    return false;
  }
  if (await alreadyHandled(ctx, observation)) return false;
  const ref = { type: "release" as const, id: release._id };
  const latest = (await revisionsOf(ctx, ref))[0];
  const proposalId = await ctx.db.insert("proposals", {
    author: { kind: "source", sourceKey },
    state: "inReview",
    currentVersionNo: 1,
    submittedAt: Date.now(),
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: [{ kind: "hide", ref, baseRevisionId: latest?._id }],
    evidence: [{ kind: "observation", observationId: observation._id }],
    changeComment: `${sourceName} no longer lists this future-dated release — possible cancellation. Approve to hide the release; reject to keep it. Withdrawal by itself never changes a field (absence is not evidence).`,
  });
  await ctx.db.patch(observation._id, { queuedProposalId: proposalId });
  return true;
}

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
 * A withdrawn observation whose linked Release is still future-dated queues
 * a possible-cancellation review (#37).
 */
export const markWithdrawn = internalMutation({
  args: { sourceKey: v.string(), notSeenSince: v.number() },
  handler: async (ctx, { sourceKey, notSeenSince }) => {
    const source = await getSourceByKey(ctx, sourceKey);
    const sourceName = source?.name ?? sourceKey;
    const stale = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_seen", (q) =>
        q.eq("sourceKey", sourceKey).lt("lastSeenAt", notSeenSince),
      )
      .collect();
    let marked = 0;
    let reviewsQueued = 0;
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
      if (await queueWithdrawalReview(ctx, sourceName, sourceKey, obs)) {
        reviewsQueued++;
      }
    }
    return { marked, reviewsQueued };
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
