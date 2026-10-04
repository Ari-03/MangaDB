// Shared import machinery (spec §6): Import Run logging and the gate, the
// cadence dispatcher that turns registry rows into scheduled adapter runs
// (closing stranded runs first), the post-sweep withdrawal pass (with its
// possible-cancellation review), source-health alert email, the Data Team
// dashboard queries, the Held Books list and its backfill, and the
// bootstrap-unreviewed backlog query. Source-specific fetch/parse/apply
// lives in each adapter module; everything here is source-agnostic.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type FunctionReference, paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getSourceByKey, recordSourceOutcome } from "./importSources";
import { todaySortKey } from "./lib/dates";
import { releasesOf } from "./lib/editionRows";
import { sendAdminEmail } from "./lib/email";
import { isStranded, lastActiveAt } from "./lib/importRuns";
import { clearHold, type HoldKind, holdOf, proposalInReview, recordUnplaced } from "./lib/observations";
import type { OlEditionSnapshot } from "./lib/openLibrary";
import { alreadyHandled } from "./lib/pipeline";
import { capture, withExceptionCapture } from "./lib/posthog";
import { insertSourceProposal } from "./lib/reconcile";
import { requireDataTeam, requireModerator } from "./lib/roles";
import { LOCK_NOTE } from "./lib/unmatched";
import { revisionsOf } from "./moderation";
import { type AnnReleaseSnapshot, lineOutOfScope, SOURCE_KEY as ANN } from "./ann";
import { placeEdition, SOURCE_KEY as OPEN_LIBRARY } from "./openLibrary";
import { holdKind } from "./schema";

// ---------- Import Runs (spec §6: runs & failure) ----------

/** Errors kept per run — enough to debug, bounded so a bad sweep can't bloat. */
const MAX_RUN_ERRORS = 50;

/**
 * Open an Import Run. A sync opens its own runs with `automatic: true`
 * (lib/importRuns.ts runToContinue): the cadence dispatcher's, and an
 * operator's bare `sync '{}'`. An operator forces a run by calling this
 * without `automatic` and passing the id to the sync; such a run carries on
 * while its source is disabled (lib/importRuns.ts).
 */
export const startRun = internalMutation({
  args: { sourceKey: v.string(), automatic: v.optional(v.boolean()) },
  handler: async (ctx, { sourceKey, automatic }) => {
    return await ctx.db.insert("importRuns", {
      sourceKey,
      status: "running",
      lastActivityAt: Date.now(),
      recordsSeen: 0,
      recordsChanged: 0,
      errors: [],
      ...(automatic ? { automatic } : {}),
    });
  },
});

/**
 * The import gate (lib/importRuns.ts stopAtGate), checked at link entry
 * and at page, batch and withdrawal boundaries by the sync scheduled under
 * `sourceKey`. In order: a run that is missing, belongs to another source
 * key, or is no longer "running" stops its chain and nothing is written.
 * Otherwise it reads the run's own source row: while it is enabled, or for
 * an operator's run, the run goes on, its `lastActivityAt` is stamped and
 * the totals given are stored on it. Once it is disabled, an automatic run
 * is closed as "stopped" with those totals (health-neutral: it never
 * touches the source's failure streak). Returns whether the run is over.
 *
 * `sourceKey` is optional for actions deployed before the gate took it,
 * which call here only once they have read their source as disabled; the
 * run's own key stands in, so they get no mismatch check. The fallback can
 * go once no such action can still be running.
 */
export const stopIfAutomatic = internalMutation({
  args: {
    runId: v.id("importRuns"),
    sourceKey: v.optional(v.string()),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const sourceKey = args.sourceKey ?? run?.sourceKey;
    if (!run) {
      console.warn(`[imports] ${sourceKey ?? "unknown source"}: run ${args.runId} does not exist; its chain stops`);
      return true;
    }
    if (run.sourceKey !== sourceKey) {
      console.error(
        `[imports] ${sourceKey}: run ${run._id} belongs to "${run.sourceKey}"; stopping without touching either source`,
      );
      return true;
    }
    if (run.status !== "running") {
      console.warn(`[imports] ${sourceKey}: run ${run._id} is already ${run.status}; its chain stops`);
      return true;
    }
    const source = await getSourceByKey(ctx, run.sourceKey);
    if (source?.enabled || !run.automatic) {
      await stampActivity(ctx, run._id, args);
      return false;
    }
    // Its own status, not "succeeded": the sweep is incomplete. The note
    // always fits: it follows the first MAX_RUN_ERRORS - 1 carried errors.
    const errors = [...args.errors.slice(0, MAX_RUN_ERRORS - 1), "Stopped: the source was disabled mid-run."];
    const finishedAt = Date.now();
    await ctx.db.patch(args.runId, {
      status: "stopped",
      finishedAt,
      recordsSeen: args.recordsSeen,
      recordsChanged: args.recordsChanged,
      errors,
    });
    await captureRunFinished(ctx, run, { ...args, status: "stopped", errors, finishedAt });
    return true;
  },
});

/**
 * Stamp a still-running run as a link hands it to its continuation, storing
 * its totals so far (lib/importRuns.ts stampHandOff). A run closed meanwhile
 * is left alone; the continuation stops at its gate.
 */
export const recordRunActivity = internalMutation({
  args: {
    runId: v.id("importRuns"),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.status === "running") await stampActivity(ctx, run._id, args);
  },
});

/**
 * Stamp a running run's `lastActivityAt` and store its totals so far, so a
 * run later closed as stranded shows what it had done.
 */
async function stampActivity(
  ctx: MutationCtx,
  runId: Id<"importRuns">,
  totals: { recordsSeen: number; recordsChanged: number; errors: string[] },
) {
  await ctx.db.patch(runId, {
    lastActivityAt: Date.now(),
    recordsSeen: totals.recordsSeen,
    recordsChanged: totals.recordsChanged,
    errors: totals.errors.slice(0, MAX_RUN_ERRORS),
  });
}

export const finishRun = internalMutation({
  args: {
    runId: v.id("importRuns"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
    /**
     * A success that must not reset the source's failure streak: a follow-on
     * run chained after a failed parent (ANN's page pass after an incomplete
     * mirror) would otherwise hide the parent's recurring failure from the
     * unhealthy alert. A failure still counts.
     */
    healthNeutral: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return;
    await closeWithOutcome(ctx, run, args);
  },
});

/**
 * Close a "running" run as succeeded or failed with these totals, and count
 * it toward its source's health unless it is a health-neutral success.
 */
async function closeWithOutcome(
  ctx: MutationCtx,
  run: Doc<"importRuns">,
  closing: {
    status: "succeeded" | "failed";
    recordsSeen: number;
    recordsChanged: number;
    errors: string[];
    healthNeutral?: boolean;
  },
) {
  const finishedAt = Date.now();
  await ctx.db.patch(run._id, {
    status: closing.status,
    finishedAt,
    recordsSeen: closing.recordsSeen,
    recordsChanged: closing.recordsChanged,
    errors: closing.errors.slice(0, MAX_RUN_ERRORS),
  });
  await captureRunFinished(ctx, run, { ...closing, finishedAt });
  if (closing.healthNeutral && closing.status === "succeeded") return;
  await recordSourceOutcome(ctx, run.sourceKey, closing.status === "succeeded", closing.errors);
}

/**
 * The hourly tick's recovery (runScheduled): close a run whose chain is gone
 * (lib/importRuns.ts isStranded) as "failed", saying when it was last
 * active, so its source can run again. It keeps the counts and errors its
 * last gate pass or hand-off stored. The failure counts toward source
 * health like any other: a chain that keeps dying raises the unhealthy
 * alert. Returns whether it closed the run; a run that is closed already, or
 * has shown activity since the tick read it, is left alone, so overlapping
 * ticks close it once.
 */
export const closeStrandedRun = internalMutation({
  args: { runId: v.id("importRuns") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running" || !isStranded(run, Date.now())) return false;
    const lastActive = new Date(lastActiveAt(run)).toISOString();
    const note = `Stranded: no activity since ${lastActive}; closed by the scheduler.`;
    await closeWithOutcome(ctx, run, {
      status: "failed",
      recordsSeen: run.recordsSeen,
      recordsChanged: run.recordsChanged,
      errors: [...run.errors.slice(0, MAX_RUN_ERRORS - 1), note],
    });
    return true;
  },
});

/** `import_run_finished` for a run closing now with these totals. */
async function captureRunFinished(
  ctx: MutationCtx,
  run: Doc<"importRuns">,
  closing: {
    status: "succeeded" | "failed" | "stopped";
    recordsSeen: number;
    recordsChanged: number;
    errors: string[];
    finishedAt: number;
  },
) {
  await capture(ctx, null, "import_run_finished", {
    source_key: run.sourceKey,
    status: closing.status,
    records_seen: closing.recordsSeen,
    records_changed: closing.recordsChanged,
    error_count: closing.errors.length,
    duration_ms: closing.finishedAt - run._creationTime,
  });
}

/** Recent runs of one source (or all), newest first — Data Team inspection
 * of source, timing, records seen/changed, and errors (spec §6). */
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
 * The Data Team dashboard's source table: every registry row with its
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

// ---------- health alert email (spec §6: runs & failure) ----------

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
// ships. All five v1 sources, Yen Press, and the Kodansha
// backlist crawl have adapters;
// adapters take only optional tuning args, so dispatching with {} is valid.
const ADAPTERS: Record<
  string,
  FunctionReference<"action", "internal", Record<string, unknown>>
> = {
  sevenseas: internal.sevenSeas.sync,
  kodansha: internal.kodansha.sync,
  ann: internal.ann.sync,
  prh: internal.prh.sync,
  openlibrary: internal.openLibrary.sync,
  yenpress: internal.yenPress.sync,
  "kodansha-backlist": internal.kodansha.backlistSync,
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
        lastRunId: lastRun?._id ?? null,
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
 * tick — no code change (spec §6). A still-running run defers the source,
 * unless its chain is gone (lib/importRuns.ts isStranded): then the tick
 * closes it as failed (closeStrandedRun) and treats the source as usual.
 */
export const runScheduled = internalAction({
  args: {},
  handler: async (ctx) =>
    withExceptionCapture("imports.runScheduled", ctx, async () => {
      // The canonical publisher rows (launch.ts) must exist before any source
      // runs: ANN's release pages and Open Library resolve a distributor NAME
      // against them and create nothing for an unknown one. A fresh
      // deployment that was never seeded (staging, 2026-09-27) imported 5,600
      // series and not one VIZ release. Idempotent by slug, so every tick may
      // call it.
      await ctx.runMutation(internal.launch.seedPublishers, {});
      const sources = await ctx.runQuery(internal.imports.enabledSources, {});
      const now = Date.now();
      const started: string[] = [];
      for (const source of sources) {
        const adapter = ADAPTERS[source.key];
        if (!adapter) continue;
        if (source.lastStatus === "running" && source.lastRunId !== null) {
          const closed: boolean = await ctx.runMutation(internal.imports.closeStrandedRun, {
            runId: source.lastRunId,
          });
          if (!closed) continue;
        }
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
    }),
});

// ---------- covers (spec §6) ----------

/**
 * Attach a cover {storageId, sourceUrl, attribution} (spec §6), the one
 * attach path for publisher art (lib/covers.ts `storeCover`). Without a
 * `storageId` the art at `sourceUrl` was a placeholder: the Release records
 * the URL, keeps any art it already shows, and is not fetched again until
 * the URL changes. Refused for a missing, inactive, or locked Release, one
 * whose cover already came from `sourceUrl`, or an incoming blob that no
 * longer exists (an overlapping run replaced it: `stale`). Otherwise the
 * Release takes the blob of an active sibling in its Edition with the same
 * `sourceUrl` (print and digital share one file), else the incoming one,
 * replacing art the publisher has since changed. A blob nothing shows any
 * more, the incoming one or the replaced one, is deleted; one another
 * Release or a Bundle still shows is kept, wherever a split or merge has
 * moved it (`by_cover`). Returns what the Release now holds for
 * `sourceUrl`: its blob, "placeholder", or null when nothing.
 */
export const attachCover = internalMutation({
  args: {
    releaseId: v.id("releases"),
    storageId: v.optional(v.id("_storage")),
    sourceUrl: v.string(),
    attribution: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ attached: boolean; held: Id<"_storage"> | "placeholder" | null; stale?: true }> => {
    const incoming = args.storageId;
    // Shown by any Release but this one, or by a Bundle made from a Release.
    const shown = async (id: Id<"_storage">) => {
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_cover", (q) => q.eq("coverImage.storageId", id))
        .collect();
      if (releases.some((r) => r._id !== args.releaseId)) return true;
      const bundle = await ctx.db
        .query("releaseBundles")
        .withIndex("by_cover", (q) => q.eq("coverImage.storageId", id))
        .first();
      return bundle !== null;
    };
    // Delete `id` unless it is `keep` or something still shows it.
    const drop = async (id: Id<"_storage"> | undefined, keep: Id<"_storage"> | undefined) => {
      if (id !== undefined && id !== keep && !(await shown(id))) await ctx.storage.delete(id);
    };

    if (incoming !== undefined && (await ctx.db.system.get(incoming)) === null) {
      return { attached: false, held: null, stale: true };
    }
    const release = await ctx.db.get(args.releaseId);
    if (!release) {
      await drop(incoming, undefined);
      return { attached: false, held: null };
    }
    const current = release.coverImage;
    const same = current !== undefined && current.sourceUrl === args.sourceUrl;
    const frozen = release.status !== "active" || release.locked === true;
    if (frozen || same) {
      await drop(incoming, current?.storageId);
      return { attached: false, held: same && !frozen ? (current.storageId ?? "placeholder") : null };
    }
    const siblings = await releasesOf(ctx, release.editionId);
    const storageId =
      siblings.find(
        (r) => r._id !== release._id && r.status === "active" && r.coverImage?.sourceUrl === args.sourceUrl,
      )?.coverImage?.storageId ??
      incoming ??
      current?.storageId;
    await ctx.db.patch(release._id, {
      coverImage: { storageId, sourceUrl: args.sourceUrl, attribution: args.attribution },
    });
    await drop(incoming, storageId);
    await drop(current?.storageId, storageId);
    return { attached: true, held: storageId ?? "placeholder" };
  },
});

// ---------- withdrawal (spec §6: observations) ----------

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
  return latest > todaySortKey(new Date(now));
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
  const { proposalId } = await insertSourceProposal(ctx, {
    sourceKey,
    state: "inReview",
    ops: [{ kind: "hide", ref, baseRevisionId: latest?._id }],
    evidence: [observation._id],
    comment: `${sourceName} no longer lists this future-dated release — possible cancellation. Approve to hide the release; reject to keep it. Withdrawal by itself never changes a field (absence is not evidence).`,
    now: Date.now(),
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
 * It takes a held record off the Held Books list with its `placement` note;
 * if the record reappears, its next placement holds it again. A withdrawn
 * observation whose linked Release is still future-dated queues a
 * possible-cancellation review.
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
      await clearHold(ctx, obs._id);
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

// ---------- Held Books (CONTEXT.md; held and cleared in lib/observations.ts) ----------

/**
 * Held Books, most recently held first, optionally of one kind and from one
 * source. Data Team. Each row carries what the source says about the book,
 * why it is held, and the member's placement Proposal still open for it, if
 * any (placement.ts: a Draft, or awaiting review), and whether the viewer
 * wrote it. A book whose import Proposal is in review is never held: the
 * review queue has it.
 */
export const heldBooks = query({
  args: {
    paginationOpts: paginationOptsValidator,
    kind: v.optional(holdKind),
    sourceKey: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, kind, sourceKey }) => {
    const viewer = await requireDataTeam(ctx);
    const holds = ctx.db.query("placementHolds");
    const ordered =
      sourceKey !== undefined && kind !== undefined
        ? holds.withIndex("by_source_kind_held", (q) => q.eq("sourceKey", sourceKey).eq("kind", kind))
        : sourceKey !== undefined
          ? holds.withIndex("by_source_held", (q) => q.eq("sourceKey", sourceKey))
          : kind !== undefined
            ? holds.withIndex("by_kind_held", (q) => q.eq("kind", kind))
            : holds.withIndex("by_held");
    const result = await ordered.order("desc").paginate(paginationOpts);
    return { ...result, page: await Promise.all(result.page.map((hold) => heldBook(ctx, hold, viewer._id))) };
  },
});

/** One Held Books row: the hold and the source's own facts. */
async function heldBook(ctx: QueryCtx, hold: Doc<"placementHolds">, viewerId: Id<"users">) {
  const observation = await ctx.db.get(hold.observationId);
  // Each source stores its own snapshot shape; these fields are common.
  const book = observation?.snapshot as
    | {
        title?: unknown;
        url?: unknown;
        isbn13?: unknown;
        seriesTitle?: unknown;
        volumeLabel?: unknown;
        label?: unknown;
        page?: { isbn13?: unknown };
      }
    | undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const series = hold.seriesId !== undefined ? await ctx.db.get(hold.seriesId) : null;
  const queued = observation?.queuedProposalId !== undefined ? await ctx.db.get(observation.queuedProposalId) : null;
  return {
    holdId: hold._id,
    sourceKey: hold.sourceKey,
    sourceRecordId: observation?.sourceRecordId ?? null,
    kind: hold.kind,
    reason: observation?.conflicts?.find((c) => c.field === "placement")?.reason ?? null,
    heldAt: hold.heldAt,
    lastSeenAt: observation?.lastSeenAt ?? null,
    title: text(book?.title),
    url: text(book?.url),
    isbn13: text(book?.isbn13) ?? text(book?.page?.isbn13),
    seriesTitle: text(book?.seriesTitle),
    volumeLabel: text(book?.volumeLabel) ?? text(book?.label),
    series: series ? { publicId: series.publicId, title: series.title } : null,
    observationId: hold.observationId,
    proposal:
      queued?.state === "draft" || queued?.state === "inReview"
        ? {
            id: queued._id,
            state: queued.state,
            mine: queued.author.kind === "user" && queued.author.userId === viewerId,
          }
        : null,
  };
}

/**
 * The kind of a hold recorded before kinds existed, read from its reason,
 * or null for a line no one can place or that is out of scope, which is
 * never listed. The texts are those of every importer but Open Library,
 * whose editions the backfill classifies afresh: ann.ts applyReleasePage,
 * lib/catalogTitle.ts (PRH and Yen Press), sevenSeas.ts, kodansha.ts, the
 * locked-Series note of lib/unmatched.ts (`LOCK_NOTE`) and the hidden-Series
 * note of lib/pipeline.ts removedSeriesFor.
 */
export function storedHoldKind(reason: string): HoldKind | null {
  if (/^ANN lists no ISBN|^A store-exclusive or variant cover|" is a prose imprint:|" publishes in another language:/.test(reason)) {
    return null;
  }
  if (LOCK_NOTE.test(reason) || /which an Editor hid|has no unique base Series|no linked active Series|^The Series is locked/.test(reason)) {
    return "series";
  }
  if (/^ISBN \d+ is |already has a \w+ .* Release \(ISBN/.test(reason)) return "isbn";
  if (/^No Volume .* under the Series|but the Series lacks/.test(reason)) return "volumeMissing";
  if (/packaging|Packaging|Box set|Edition Line|with no stated coverage/.test(reason)) return "packaging";
  return "other";
}

/**
 * Observations per backfill transaction. An Open Library classification
 * runs up to four title searches of up to 200 rows each, reads its title's
 * Series' Volumes twice, and one Volume's Editions and Releases: some 1,200
 * documents for a 150-Volume Series, so a page stays near 12,000 of a
 * transaction's 32,000.
 */
const BACKFILL_PAGE = 10;

/**
 * Bring stored observations onto the Held Books list, page by page over
 * every observation, continuing itself until done. An observation that
 * already has a hold row keeps it as its importer wrote it, unless it is no
 * longer held:
 *
 * - a linked observation's `placement` note is dropped as stale, except on
 *   a Release Bundle, where it is a box set's live Series conflict;
 * - an observation whose import Proposal is in review is the review queue's:
 *   its hold and note go (proposalInReview; a decided Proposal, or a
 *   member's placement Proposal, does not count);
 * - an unlinked Open Library edition is classified as applyEdition would
 *   (placeEdition): held if unheld and placeEdition holds it, its hold and
 *   note dropped if placeEdition skips it or leaves it to the ladder's flag
 *   (a match or a creation waits for the next apply);
 * - any other unlinked observation with a `placement` note and no row is
 *   held under the kind its reason names (storedHoldKind), first held when
 *   the note was written; a row whose note names an unlisted line goes and
 *   the note stays;
 * - an unlinked ANN line whose stored title or page puts it out of scope
 *   (lineOutOfScope) is noted as the page pass notes it, and any row goes.
 *
 * Withdrawn observations are skipped. Writes observations and holds only:
 * no fetch, no canonical record, no link. Safe to rerun. A page that fails
 * ends the chain; rerun it from the top.
 *
 *   npx convex run imports:backfillHolds '{}'
 */
export const backfillHolds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    held: v.optional(v.number()),
    classified: v.optional(v.number()),
    cleared: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const counts = { held: args.held ?? 0, classified: args.classified ?? 0, cleared: args.cleared ?? 0 };
    const { page, isDone, continueCursor } = await ctx.db
      .query("sourceObservations")
      .paginate({ numItems: BACKFILL_PAGE, cursor: args.cursor ?? null });
    for (const observation of page) {
      if (observation.withdrawn) continue;
      const note = observation.conflicts?.find((c) => c.field === "placement");
      if (observation.recordRef !== undefined) {
        if (note !== undefined && observation.recordRef.type !== "releaseBundle") {
          await clearHold(ctx, observation._id);
          counts.cleared++;
        }
        continue;
      }
      if (await proposalInReview(ctx, observation)) {
        if (await clearHold(ctx, observation._id)) counts.cleared++;
        continue;
      }
      const row = await holdOf(ctx, observation._id);
      if (observation.sourceKey === OPEN_LIBRARY) {
        const placement = await placeEdition(ctx, observation.snapshot as OlEditionSnapshot);
        if (placement.kind === "hold") {
          if (row !== null) continue;
          const at = note?.reason === placement.hold.reason ? note.at : Date.now();
          if (await recordUnplaced(ctx, observation, placement.hold, at)) counts.classified++;
        } else if (placement.kind === "skip" || placement.kind === "review") {
          if (await clearHold(ctx, observation._id)) counts.cleared++;
        }
        continue;
      }
      if (note === undefined) continue;
      const kind = storedHoldKind(note.reason);
      const outOfScope =
        kind !== null && observation.sourceKey === ANN && observation.snapshot?.kind === "annRelease"
          ? lineOutOfScope(observation.snapshot as AnnReleaseSnapshot)
          : null;
      if (outOfScope !== null) {
        if (await recordUnplaced(ctx, observation, { kind: null, reason: outOfScope }, Date.now())) counts.cleared++;
      } else if (row === null && kind !== null) {
        if (await recordUnplaced(ctx, observation, { kind, reason: note.reason }, note.at)) counts.held++;
      } else if (row !== null && kind === null) {
        if (await recordUnplaced(ctx, observation, { kind, reason: note.reason }, note.at)) counts.cleared++;
      }
    }
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.imports.backfillHolds, { cursor: continueCursor, ...counts });
    } else {
      console.log(
        `[imports.backfillHolds] done: ${counts.held} held from notes, ${counts.classified} Open Library editions held, ${counts.cleared} holds or stale notes cleared`,
      );
    }
    return { ...counts, done: isDone };
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
