// Catalog seeding, quality gates, and the launch-ready checklist (ticket
// #40, spec §7). Seeding runs the four stages in order under Bootstrap
// Mode; the quality gates draw the two ~50-Series hand-verification samples
// and run the title-similarity duplicate sweep; the checklist computes every
// launch gate from live data so "ready" is a query result, not a vibe. The
// per-Series report affordance that feeds the proposal queue lives in
// convex/reports.ts; the "about the data" page is a static route
// (src/routes/about-the-data.tsx).

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getBootstrapMode } from "./importSources";
import { findDuplicatePairs, pairKeyOf, Reservoir, type SweepEntry } from "./lib/qa";
import { requireDataTeam, requireModerator, requireRole } from "./lib/roles";

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

// ---------- the four seed stages (spec §7) ----------

// In order: ① publisher pilots prove the pipeline cheaply, ② the ANN full
// mirror builds the all-publisher Series/Volume backbone, ③ the PRH overlay
// adds authoritative dates/ISBNs/prices, ④ the OpenLibrary dump fills ISBNs
// into the existing skeleton (flat records never define structure).
export const SEED_STAGES = [
  { stage: 1, name: "Seven Seas + Kodansha (pipeline pilots)", sources: ["sevenseas", "kodansha"] },
  { stage: 2, name: "ANN full mirror (Series/Volume backbone)", sources: ["ann"] },
  { stage: 3, name: "PRH overlay (authoritative dates/ISBNs)", sources: ["prh"] },
  { stage: 4, name: "OpenLibrary dump (ISBN fill)", sources: ["openlibrary"] },
] as const;

/** Earliest succeeded Import Run of one source, else null. */
async function firstSuccessOf(
  ctx: QueryCtx | MutationCtx,
  sourceKey: string,
): Promise<number | null> {
  const run = await ctx.db
    .query("importRuns")
    .withIndex("by_source", (q) => q.eq("sourceKey", sourceKey))
    .filter((q) => q.eq(q.field("status"), "succeeded"))
    .first();
  return run?._creationTime ?? null;
}

type StageStatus = {
  stage: number;
  name: string;
  sources: Array<{ key: string; firstSucceededAt: number | null; running: boolean }>;
  complete: boolean;
  /** When the stage completed: the latest of its sources' first successes. */
  completedAt: number | null;
};

async function stageStatuses(ctx: QueryCtx | MutationCtx): Promise<{
  stages: StageStatus[];
  orderedOk: boolean;
}> {
  const stages: StageStatus[] = [];
  for (const def of SEED_STAGES) {
    const sources = [];
    for (const key of def.sources) {
      const lastRun = await ctx.db
        .query("importRuns")
        .withIndex("by_source", (q) => q.eq("sourceKey", key))
        .order("desc")
        .first();
      sources.push({
        key,
        firstSucceededAt: await firstSuccessOf(ctx, key),
        running: lastRun?.status === "running",
      });
    }
    const complete = sources.every((s) => s.firstSucceededAt !== null);
    stages.push({
      stage: def.stage,
      name: def.name,
      sources,
      complete,
      completedAt: complete
        ? Math.max(...sources.map((s) => s.firstSucceededAt!))
        : null,
    });
  }
  // "In order": every completed stage's sources first succeeded after the
  // previous stage completed. Sources keep running on cadence afterwards —
  // only the FIRST success anchors the ordering.
  let orderedOk = true;
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]!;
    const cur = stages[i]!;
    if (!cur.complete) continue;
    if (!prev.complete || prev.completedAt! > cur.completedAt!) orderedOk = false;
  }
  return { stages, orderedOk };
}

/** Seed-stage progress for the /mod/launch dashboard (Data Team). */
export const seedStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    const { stages, orderedOk } = await stageStatuses(ctx);
    return { stages, orderedOk, bootstrapMode: await getBootstrapMode(ctx) };
  },
});

// The adapter map, stage-local so launch.ts never imports the adapters'
// module graphs (imports.ts owns the cadence dispatcher's copy).
const STAGE_ADAPTERS = {
  sevenseas: internal.sevenSeas.sync,
  kodansha: internal.kodansha.sync,
  ann: internal.ann.sync,
  prh: internal.prh.sync,
  openlibrary: internal.openLibrary.sync,
} as const;

async function startStage(ctx: MutationCtx, stage: number) {
  const def = SEED_STAGES.find((s) => s.stage === stage);
  if (!def) return fail("invalidStage", "Seed stages are 1–4.");
  if (!(await getBootstrapMode(ctx))) {
    return fail(
      "bootstrapOff",
      "Seeding runs under Bootstrap Mode (spec §7). Turn it on first.",
    );
  }
  const { stages } = await stageStatuses(ctx);
  for (const prior of stages) {
    if (prior.stage >= stage) break;
    if (!prior.complete) {
      return fail(
        "outOfOrder",
        `Stage ${prior.stage} (${prior.name}) has not completed a full run yet — the stages run in order.`,
      );
    }
  }
  const current = stages.find((s) => s.stage === stage)!;
  const started: string[] = [];
  for (const source of current.sources) {
    if (source.running) continue; // a still-running run defers its source
    // PRH stage ③ is the full catalog sweep, not the daily future window.
    const args = source.key === "prh" ? { mode: "full" as const } : {};
    await ctx.scheduler.runAfter(
      0,
      STAGE_ADAPTERS[source.key as keyof typeof STAGE_ADAPTERS],
      args,
    );
    started.push(source.key);
  }
  return { started, deferredRunning: current.sources.filter((s) => s.running).map((s) => s.key) };
}

/**
 * Start one seed stage's adapters (Administrator). Refuses out-of-order
 * starts and requires Bootstrap Mode on; progress lands in Import Runs, so
 * `seedStatus` shows completion. Long sources (ANN's ~40k-entry mirror)
 * self-chain across action limits under one run — starting is enough.
 */
export const startSeedStage = mutation({
  args: { stage: v.number() },
  handler: async (ctx, { stage }) => {
    await requireRole(ctx, ["administrator"]);
    return await startStage(ctx, stage);
  },
});

/**
 * Operator escape hatch (like importSources.setBootstrapModeInternal):
 *   npx convex run launch:startSeedStageInternal '{"stage":1}'
 */
export const startSeedStageInternal = internalMutation({
  args: { stage: v.number() },
  handler: async (ctx, { stage }) => await startStage(ctx, stage),
});

// ---------- QA gate ①/②: the two hand-verification samples ----------

export const QA_SAMPLE_SIZE = 50;

/** Latest sample round per kind; 0 means never drawn. */
async function latestRound(
  ctx: QueryCtx | MutationCtx,
  kind: "random" | "prominent",
): Promise<number> {
  const latest = await ctx.db
    .query("qaChecks")
    .withIndex("by_kind_round", (q) => q.eq("kind", kind))
    .order("desc")
    .first();
  return latest?.round ?? 0;
}

/** Gate for the sampling actions: the caller must be a Moderator. */
export const assertModerator = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireModerator(ctx);
    return null;
  },
});

/** One page of active Series for the sampling/sweep actions. */
export const seriesPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("series").paginate(paginationOpts);
    return {
      page: result.page
        .filter((s) => s.status === "active")
        .map((s) => ({
          id: s._id,
          publicId: s.publicId,
          title: s.title,
          altTitles: s.altTitles,
        })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** One page of active Releases' series links, for the prominence count. */
export const releaseSeriesPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("releases").paginate(paginationOpts);
    return {
      seriesIds: result.page
        .filter((r) => r.status === "active")
        .flatMap((r) => r.seriesIds as string[]),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const seriesByIds = internalQuery({
  args: { ids: v.array(v.id("series")) },
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const doc = await ctx.db.get(id);
      if (doc && doc.status === "active") {
        out.push({ id: doc._id, publicId: doc.publicId, title: doc.title });
      }
    }
    return out;
  },
});

/** Replace one kind's sample with the next round's rows. */
export const replaceQaSample = internalMutation({
  args: {
    kind: v.union(v.literal("random"), v.literal("prominent")),
    entries: v.array(
      v.object({
        seriesId: v.id("series"),
        publicId: v.number(),
        title: v.string(),
      }),
    ),
  },
  handler: async (ctx, { kind, entries }) => {
    const round = (await latestRound(ctx, kind)) + 1;
    for (const entry of entries) {
      await ctx.db.insert("qaChecks", {
        kind,
        round,
        seriesId: entry.seriesId,
        publicId: entry.publicId,
        title: entry.title,
        status: "pending",
      });
    }
    return { round, size: entries.length };
  },
});

const SAMPLE_PAGE = 500;

/**
 * Draw (or redraw, after a pipeline-wide fix) a quality-gate sample
 * (Moderator): "random" reservoir-samples ~50 active Series uniformly;
 * "prominent" takes the ~50 Series with the most active Releases — the
 * catalog's high-traffic entries, where an error costs the most credibility
 * (spec §7). Each draw is a new round; the gate reads only the latest.
 */
export const drawQaSample = action({
  args: { kind: v.union(v.literal("random"), v.literal("prominent")) },
  // Explicit annotation breaks the type cycle with this module's own
  // internal.* references (same pattern as the adapters).
  handler: async (ctx, { kind }): Promise<{ round: number; size: number }> => {
    await ctx.runQuery(internal.launch.assertModerator, {});

    let picked: Array<{ seriesId: Id<"series">; publicId: number; title: string }>;
    if (kind === "random") {
      const reservoir = new Reservoir<{
        seriesId: Id<"series">;
        publicId: number;
        title: string;
      }>(QA_SAMPLE_SIZE);
      let cursor: string | null = null;
      do {
        const page: {
          page: Array<{ id: Id<"series">; publicId: number; title: string }>;
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.launch.seriesPage, {
          paginationOpts: { numItems: SAMPLE_PAGE, cursor },
        });
        for (const s of page.page) {
          reservoir.add({ seriesId: s.id, publicId: s.publicId, title: s.title });
        }
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor !== null);
      picked = reservoir.sample();
    } else {
      // Release count per Series across the whole catalog, paged in memory.
      const counts = new Map<string, number>();
      let cursor: string | null = null;
      do {
        const page: {
          seriesIds: string[];
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.launch.releaseSeriesPage, {
          paginationOpts: { numItems: SAMPLE_PAGE, cursor },
        });
        for (const id of page.seriesIds) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor !== null);
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, QA_SAMPLE_SIZE)
        .map(([id]) => id as Id<"series">);
      const docs: Array<{ id: Id<"series">; publicId: number; title: string }> =
        await ctx.runQuery(internal.launch.seriesByIds, { ids: top });
      picked = docs.map((d) => ({
        seriesId: d.id,
        publicId: d.publicId,
        title: d.title,
      }));
    }

    return await ctx.runMutation(internal.launch.replaceQaSample, {
      kind,
      entries: picked,
    });
  },
});

/**
 * Record one hand-verification outcome (Moderator). "failed" carries a note
 * naming the error — the class gets fixed pipeline-wide and the sample is
 * redrawn (`drawQaSample` again), per the spec's no-numeric-threshold rule.
 */
export const recordQaCheck = mutation({
  args: {
    checkId: v.id("qaChecks"),
    status: v.union(v.literal("verified"), v.literal("failed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { checkId, status, note }) => {
    const user = await requireModerator(ctx);
    const check = await ctx.db.get(checkId);
    if (!check) return fail("notFound", "No such QA check.");
    if (status === "failed" && !note?.trim()) {
      return fail("noteRequired", "Name the error so its class can be fixed pipeline-wide.");
    }
    await ctx.db.patch(checkId, {
      status,
      note: note?.trim() || undefined,
      checkedBy: user._id,
      checkedAt: Date.now(),
    });
  },
});

// ---------- QA gate ③: the title-similarity duplicate sweep ----------

/** Insert newly flagged pairs; a pairKey already recorded (open OR resolved)
 * never re-opens — "resolved as distinct" is a durable human decision. */
export const recordSweepPairs = internalMutation({
  args: {
    pairs: v.array(
      v.object({
        aId: v.id("series"),
        bId: v.id("series"),
        reason: v.string(),
      }),
    ),
  },
  handler: async (ctx, { pairs }) => {
    let inserted = 0;
    for (const pair of pairs) {
      const pairKey = pairKeyOf(pair.aId, pair.bId);
      const existing = await ctx.db
        .query("duplicateCandidates")
        .withIndex("by_pairKey", (q) => q.eq("pairKey", pairKey))
        .unique();
      if (existing) continue;
      const a = await ctx.db.get(pair.aId);
      const b = await ctx.db.get(pair.bId);
      if (!a || !b || a.status !== "active" || b.status !== "active") continue;
      await ctx.db.insert("duplicateCandidates", {
        pairKey,
        aId: pair.aId,
        bId: pair.bId,
        aTitle: a.title,
        bTitle: b.title,
        reason: pair.reason,
        status: "open",
      });
      inserted++;
    }
    return { inserted };
  },
});

/** Close open pairs a Merge/Hide already settled, and stamp the sweep
 * summary on appConfig. */
export const finishSweep = internalMutation({
  args: { seriesScanned: v.number(), pairsFlagged: v.number() },
  handler: async (ctx, { seriesScanned, pairsFlagged }) => {
    const open = await ctx.db
      .query("duplicateCandidates")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    for (const candidate of open) {
      const a = await ctx.db.get(candidate.aId);
      const b = await ctx.db.get(candidate.bId);
      if (a?.status === "active" && b?.status === "active") continue;
      await ctx.db.patch(candidate._id, {
        status: "resolved",
        resolution: "merged",
        resolvedAt: Date.now(),
        note: "Closed automatically: a member of the pair is no longer active.",
      });
    }
    const config = await ctx.db.query("appConfig").first();
    const sweep = { ranAt: Date.now(), seriesScanned, pairsFlagged };
    if (config) await ctx.db.patch(config._id, { duplicateSweep: sweep });
    else await ctx.db.insert("appConfig", { bootstrapMode: false, duplicateSweep: sweep });
  },
});

const SWEEP_CHUNK = 200;

/**
 * The full-catalog title-similarity sweep (Moderator): page every active
 * Series, flag colliding normalized titles/alt-titles as duplicate
 * candidates, and auto-close pairs a Merge already settled. Every flagged
 * pair is a human decision — resolve as "distinct" here, or Merge via
 * /mod/manage and re-sweep (the next sweep closes it automatically).
 */
export const runDuplicateSweep = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ seriesScanned: number; pairsFlagged: number; newlyOpened: number }> => {
    await ctx.runQuery(internal.launch.assertModerator, {});

    const entries: SweepEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: {
        page: Array<{ id: Id<"series">; title: string; altTitles: string[] }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.launch.seriesPage, {
        paginationOpts: { numItems: SAMPLE_PAGE, cursor },
      });
      for (const s of page.page) {
        entries.push({ id: s.id, title: s.title, altTitles: s.altTitles });
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);

    const pairs = findDuplicatePairs(entries);
    let inserted = 0;
    for (let i = 0; i < pairs.length; i += SWEEP_CHUNK) {
      const chunk = pairs.slice(i, i + SWEEP_CHUNK).map((p) => ({
        aId: p.aId as Id<"series">,
        bId: p.bId as Id<"series">,
        reason: p.reason,
      }));
      const result: { inserted: number } = await ctx.runMutation(
        internal.launch.recordSweepPairs,
        { pairs: chunk },
      );
      inserted += result.inserted;
    }
    await ctx.runMutation(internal.launch.finishSweep, {
      seriesScanned: entries.length,
      pairsFlagged: pairs.length,
    });
    return { seriesScanned: entries.length, pairsFlagged: pairs.length, newlyOpened: inserted };
  },
});

const DUPLICATE_QUEUE_PAGE = 100;

/** Open duplicate pairs for the dashboard, oldest first (Data Team). */
export const duplicateQueue = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    const open = await ctx.db
      .query("duplicateCandidates")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(DUPLICATE_QUEUE_PAGE + 1);
    const rows = [];
    for (const candidate of open.slice(0, DUPLICATE_QUEUE_PAGE)) {
      const a = await ctx.db.get(candidate.aId);
      const b = await ctx.db.get(candidate.bId);
      rows.push({
        candidateId: candidate._id,
        reason: candidate.reason,
        a: { publicId: a?.publicId ?? null, title: candidate.aTitle },
        b: { publicId: b?.publicId ?? null, title: candidate.bTitle },
      });
    }
    return { rows, hasMore: open.length > DUPLICATE_QUEUE_PAGE };
  },
});

/**
 * Resolve one flagged pair (Moderator). "distinct" is the human decision
 * that these are different Series (durable — the pair never re-flags);
 * "merged" is bookkeeping when the duplicates were collapsed via the Merge
 * operation (#33) — the sweep also closes those automatically.
 */
export const resolveDuplicate = mutation({
  args: {
    candidateId: v.id("duplicateCandidates"),
    resolution: v.union(v.literal("distinct"), v.literal("merged")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { candidateId, resolution, note }) => {
    const user = await requireModerator(ctx);
    const candidate = await ctx.db.get(candidateId);
    if (!candidate) return fail("notFound", "No such duplicate candidate.");
    if (candidate.status !== "open") {
      return fail("alreadyResolved", "This pair is already resolved.");
    }
    await ctx.db.patch(candidateId, {
      status: "resolved",
      resolution,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      note: note?.trim() || undefined,
    });
  },
});

// ---------- QA + checklist status ----------

type SampleStatus = {
  round: number;
  total: number;
  verified: number;
  failed: number;
  pending: number;
  pass: boolean;
};

async function sampleStatus(
  ctx: QueryCtx,
  kind: "random" | "prominent",
): Promise<SampleStatus & { rows: Doc<"qaChecks">[] }> {
  const round = await latestRound(ctx, kind);
  const rows =
    round === 0
      ? []
      : await ctx.db
          .query("qaChecks")
          .withIndex("by_kind_round", (q) => q.eq("kind", kind).eq("round", round))
          .collect();
  const verified = rows.filter((r) => r.status === "verified").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  return {
    round,
    total: rows.length,
    verified,
    failed,
    pending,
    // The gate: a drawn sample, fully checked, with no unresolved failure —
    // a failure means fix the class pipeline-wide and redraw (spec §7).
    pass: round > 0 && rows.length > 0 && pending === 0 && failed === 0,
    rows,
  };
}

/** The QA dashboard: both samples' latest rounds with their rows. */
export const qaStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    const config = await ctx.db.query("appConfig").first();
    const openDuplicates = await ctx.db
      .query("duplicateCandidates")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(1001);
    return {
      random: await sampleStatus(ctx, "random"),
      prominent: await sampleStatus(ctx, "prominent"),
      duplicates: {
        lastSweep: config?.duplicateSweep ?? null,
        openCount: Math.min(openDuplicates.length, 1000),
        hasMore: openDuplicates.length > 1000,
      },
    };
  },
});

// ---------- launch gate ④: the correction loop, exercised for real ----------

/**
 * Attest that the correction loop ran end-to-end for real (Administrator):
 * report → proposal → approval → public revision. Takes the approved,
 * human-authored proposal that fixed a reported error and verifies it
 * produced at least one public Revision before recording the attestation.
 */
export const attestCorrectionLoop = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }) => {
    const user = await requireRole(ctx, ["administrator"]);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) return fail("notFound", "No such proposal.");
    if (proposal.state !== "approved") {
      return fail("notApproved", "The correction-loop proposal must be approved.");
    }
    if (proposal.author.kind !== "user") {
      return fail(
        "notHuman",
        "The correction loop is a human loop — pick a user-authored proposal, not an import's.",
      );
    }
    const revision = await ctx.db
      .query("revisions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
      .first();
    if (!revision) {
      return fail(
        "noRevision",
        "That approval produced no public Revision — the loop must end in one.",
      );
    }
    const config = await ctx.db.query("appConfig").first();
    const correctionLoop = {
      proposalId,
      attestedBy: user._id,
      attestedAt: Date.now(),
    };
    if (config) await ctx.db.patch(config._id, { correctionLoop });
    else {
      await ctx.db.insert("appConfig", { bootstrapMode: false, correctionLoop });
    }
  },
});

// ---------- the launch-ready checklist (spec §7) ----------

/** yyyymmdd sort key for "today" (UTC), comparable to releases.pubDate.sort. */
function todaySort(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

const V1_SOURCE_KEYS = ["sevenseas", "kodansha", "ann", "prh", "openlibrary"];

/**
 * Every launch gate, computed from live data (spec §7): ① four seed stages
 * complete in order, ② quality gates pass with Bootstrap Mode off, ③
 * calendar populated + all five sources healthy on steady-state cadences,
 * ④ correction loop attested, ⑤ the "about the data" page (a static route —
 * always true once deployed). Non-gates (digital parity, an empty
 * bootstrap-unreviewed backlog, series count) are deliberately absent.
 */
export const launchChecklist = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    const config = await ctx.db.query("appConfig").first();

    // ① seed stages
    const { stages, orderedOk } = await stageStatuses(ctx);
    const stagesComplete = stages.every((s) => s.complete) && orderedOk;

    // ② quality gates + Bootstrap Mode off
    const { rows: _randomRows, ...random } = await sampleStatus(ctx, "random");
    const { rows: _prominentRows, ...prominent } = await sampleStatus(ctx, "prominent");
    const openDuplicates = await ctx.db
      .query("duplicateCandidates")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(1);
    const sweepRan = config?.duplicateSweep !== undefined;
    const duplicatesPass = sweepRan && openDuplicates.length === 0;
    const bootstrapMode = config?.bootstrapMode ?? false;
    const qualityGatesPass = random.pass && prominent.pass && duplicatesPass;

    // ③ populated calendar + all five sources healthy
    const today = todaySort(Date.now());
    const futureWindow = await ctx.db
      .query("releases")
      .withIndex("by_date", (q) => q.gte("pubDate.sort", today))
      .take(50);
    const futureReleases = futureWindow.filter((r) => r.status === "active").length;
    const sources = [];
    for (const key of V1_SOURCE_KEYS) {
      const source = await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      const lastRun = await ctx.db
        .query("importRuns")
        .withIndex("by_source", (q) => q.eq("sourceKey", key))
        .order("desc")
        .first();
      sources.push({
        key,
        registered: source !== null,
        enabled: source?.enabled ?? false,
        healthState: source?.healthState ?? "missing",
        cadence: source?.cadence ?? null,
        lastRunStatus: lastRun?.status ?? null,
        everSucceeded: (await firstSuccessOf(ctx, key)) !== null,
      });
    }
    const sourcesHealthy = sources.every(
      (s) => s.registered && s.enabled && s.healthState === "healthy" && s.everSucceeded,
    );

    // ④ correction loop attested
    const correctionLoop = config?.correctionLoop ?? null;

    const gates = {
      seedStagesComplete: stagesComplete,
      qualityGatesPass,
      bootstrapOff: !bootstrapMode,
      calendarPopulated: futureReleases > 0,
      sourcesHealthy,
      correctionLoopExercised: correctionLoop !== null,
      aboutDataPage: true, // static route, ships with the code
    };
    return {
      gates,
      ready: Object.values(gates).every(Boolean),
      detail: {
        stages,
        orderedOk,
        bootstrapMode,
        random,
        prominent,
        duplicates: {
          sweepRan,
          lastSweep: config?.duplicateSweep ?? null,
          open: openDuplicates.length > 0,
        },
        futureReleases,
        sources,
        correctionLoop,
      },
    };
  },
});
