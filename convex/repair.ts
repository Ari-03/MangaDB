// One-time catalog data repair (the six-lane audit, 2026-09). Operator-only
// internal functions, driven by scripts/repair.ts from repair-plan.json:
//
//   npx convex run repair:runBatch '{"dryRun":true,"actor":"ari","entries":[…]}'
//   npx convex run repair:metrics
//
// runBatch applies each entry in its own sub-transaction (ctx.runMutation),
// so one failing or drifted entry rolls back alone and is reported. A dry
// run applies the entry for real and then throws, rolling the writes back:
// the report is exactly what the real run would do against the current data.
// An entry with more to do than one call should (a chunked publisher merge,
// a split's or box set's personal rows past lib/repair/ops.ts SWEEP_BUDGET)
// reports "partial", and scripts/repair.ts calls it again until it is not.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { createAudit, resolveActor } from "./lib/repair/audit";
import { outcome, repairEntry, type Outcome, type RepairEntry } from "./lib/repair/entries";
import {
  computeMetrics,
  metricTables,
  projectObservation,
  projectRow,
  type MetricTable,
  type ObservationRow,
  type Row,
} from "./lib/repair/metrics";
import { nestedLimits } from "./lib/bounded";
import { rasterType } from "./lib/covers";
import { applyEntry } from "./lib/repair/ops";
import {
  applyReviewedCreation,
  creationRefusal,
  reviewedCreationState,
} from "./lib/reviewedCatalogCreation";

/** Evidence stored on each repair Proposal: its source observations, else a plan note. */
function evidenceFor(entry: RepairEntry) {
  const note = { kind: "note" as const, text: `One-time data repair plan entry ${entry.key}` };
  switch (entry.kind) {
    case "unlinkObservation":
      return [{ kind: "observation" as const, observationId: entry.observationId }, note];
    case "editionLinePublisher":
      return [
        ...entry.editions.flatMap((move) =>
          move.observationIds.map((observationId) => ({
            kind: "observation" as const,
            observationId,
          })),
        ),
        note,
      ];
    case "editionPublisher":
    case "splitSeries":
      return [
        ...entry.observationIds.map((observationId) => ({
          kind: "observation" as const,
          observationId,
        })),
        note,
      ];
    case "updateFields":
      return entry.evidenceObservationId
        ? [{ kind: "observation" as const, observationId: entry.evidenceObservationId }, note]
        : [note];
    case "otherPrinting":
    case "releaseVariant":
      return [
        { kind: "observation" as const, observationId: entry.observationId },
        ...entry.sources.map((url) => ({ kind: "url" as const, url })),
        note,
      ];
    case "amendProposalEvidence":
      return [
        ...entry.replacements.map((row) => ({
          kind: "url" as const,
          url: row.after,
          note: `Replaces ${row.before} on Proposal ${entry.proposalId}`,
        })),
        note,
      ];
    case "createPublisher":
    case "createRelease":
    case "bundleToRelease":
      return [...entry.sources.map((url) => ({ kind: "url" as const, url })), note];
    case "createVolume":
      return [
        { kind: "observation" as const, observationId: entry.observationId },
        ...entry.sources.map((url) => ({ kind: "url" as const, url })),
        note,
      ];
    default:
      return [note];
  }
}

/** Apply one entry. Internal to runBatch: always called as a sub-transaction. */
export const applyOne = internalMutation({
  args: { entry: repairEntry, dryRun: v.boolean(), actor: v.string() },
  returns: outcome,
  handler: async (ctx, { entry, dryRun, actor }) => {
    const audit = createAudit(
      ctx,
      await resolveActor(ctx, actor),
      `Data repair: ${entry.reason}`,
      evidenceFor(entry),
    );
    const result = await applyEntry(ctx, audit, entry);
    await audit.finish();
    const reported: Outcome = {
      key: entry.key,
      ...result,
      ...(audit.notes.length > 0 ? { notes: audit.notes } : {}),
    };
    // Throwing rolls this sub-transaction back; runBatch reads the outcome.
    // Any write counts, not just audited ones: some ops (withdrawing a stale
    // Proposal) touch no catalog record and so leave no audit trail.
    if (dryRun && (audit.wrote || result.status === "applied" || result.status === "partial")) {
      throw new ConvexError({ dryRun: reported });
    }
    return reported;
  },
});

type ErrorData = { dryRun?: Outcome; skip?: string };

function errorData(error: unknown): ErrorData | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  return typeof data === "object" && data !== null ? (data as ErrorData) : null;
}

/** Apply (or dry-run) a batch of plan entries; one outcome per entry. */
export const runBatch = internalMutation({
  args: { entries: v.array(repairEntry), dryRun: v.boolean(), actor: v.string() },
  returns: v.array(outcome),
  handler: async (ctx, { entries, dryRun, actor }) => {
    const outcomes: Outcome[] = [];
    for (const entry of entries) {
      try {
        outcomes.push(
          await ctx.runMutation(
            internal.repair.applyOne,
            { entry, dryRun, actor },
            { transactionLimits: await nestedLimits(ctx) },
          ),
        );
      } catch (error) {
        const data = errorData(error);
        if (data?.dryRun) outcomes.push(data.dryRun);
        else if (data?.skip)
          outcomes.push({ key: entry.key, status: "skipped", reason: data.skip });
        else {
          outcomes.push({
            key: entry.key,
            status: "error",
            reason: error instanceof Error ? error.message.slice(0, 500) : String(error),
          });
        }
      }
    }
    return outcomes;
  },
});

// ---------- metrics ----------

const metricTable = v.union(...metricTables.map((name) => v.literal(name)));

/** One page of a table, projected to what the metrics read. */
export const metricsPage = internalQuery({
  args: { table: metricTable, cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { table, cursor, numItems }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems });
    return {
      rows: page.page.map((doc) => projectRow(table, doc)),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * One page of linked-release observations for a source. ANN's per-series
 * `manga:` records (large, never linked to releases) are skipped by range.
 */
export const observationsPage = internalQuery({
  args: { sourceKey: v.string(), cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { sourceKey, cursor, numItems }) => {
    const page = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        sourceKey === "ann"
          ? q.eq("sourceKey", "ann").gte("sourceRecordId", "release:")
          : q.eq("sourceKey", sourceKey),
      )
      .paginate({ cursor, numItems });
    return {
      rows: page.page.map(projectObservation),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

type Page<R> = { rows: R[]; continueCursor: string; isDone: boolean };

async function drain<R>(fetch: (cursor: string | null) => Promise<Page<R>>): Promise<R[]> {
  const rows: R[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Page<R> = await fetch(cursor);
    rows.push(...page.rows);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/**
 * The repair's before/after metrics over the whole catalog (read-only):
 * polluted titles, series not starting at 1, duplicate title clusters,
 * publisher rows, out-of-scope and conflated releases, and more.
 */
export const metrics = internalAction({
  args: {},
  // Annotated: the handler calls this module's own queries through
  // `internal`, which would otherwise make its type circular.
  handler: async (ctx): Promise<ReturnType<typeof computeMetrics>> => {
    const table = <T extends MetricTable>(name: T, numItems: number): Promise<Row<T>[]> =>
      drain(async (cursor): Promise<Page<Row<T>>> => {
        const page: Page<Row<MetricTable>> = await ctx.runQuery(internal.repair.metricsPage, {
          table: name,
          cursor,
          numItems,
        });
        // metricsPage projects `name`'s rows; its declared type is the union.
        return page as Page<Row<T>>;
      });
    const observations: ObservationRow[] = [];
    for (const sourceKey of ["prh", "openlibrary", "kodansha", "ann"]) {
      observations.push(
        ...(await drain(
          (cursor): Promise<Page<ObservationRow>> =>
            ctx.runQuery(internal.repair.observationsPage, { sourceKey, cursor, numItems: 2000 }),
        )),
      );
    }
    return computeMetrics({
      publishers: await table("publishers", 500),
      series: await table("series", 4000),
      volumes: await table("volumes", 8000),
      editions: await table("editions", 8000),
      releases: await table("releases", 4000),
      editionLines: await table("editionLines", 4000),
      releaseBundles: await table("releaseBundles", 4000),
      bundleMemberships: await table("bundleMemberships", 4000),
      observations,
    });
  },
});

/** Batch-040 only. The returned expected string is a complete bounded read closure. */
export const previewReviewedCreation = internalQuery({
  args: { observationId: v.id("sourceObservations") },
  handler: async (ctx, { observationId }) => {
    try {
      const state = await reviewedCreationState(ctx, observationId);
      return {
        classification: state.prior ? "alreadyApplied" : "ready",
        expected: state.expected,
        refusal: null,
        product: state.product,
        created: state.prior,
      };
    } catch (error) {
      const refusal = creationRefusal(error);
      if (!refusal) throw error;
      return { classification: "refused", expected: null, refusal, product: null, created: null };
    }
  },
});

/** Called as a subtransaction so dry runs roll back catalog and audit together. */
export const applyReviewedCreationInternal = internalMutation({
  args: {
    observationId: v.id("sourceObservations"),
    expected: v.string(),
    actor: v.string(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const result = await applyReviewedCreation(ctx, args);
    // Rolled-back IDs must never become link targets or future expected IDs.
    if (args.dryRun && result.status === "created")
      throw new ConvexError({ reviewedCreationDryRun: true });
    return result;
  },
});

type ReviewedCreationResult =
  | Awaited<ReturnType<typeof applyReviewedCreation>>
  | { status: "dryRun" }
  | { status: "refused"; reason: string };

/** Parent-only operator entry. Never links or changes the source/hold. */
export const executeReviewedCreation = internalMutation({
  args: {
    observationId: v.id("sourceObservations"),
    expected: v.string(),
    actor: v.string(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args): Promise<ReviewedCreationResult> => {
    try {
      return await ctx.runMutation(internal.repair.applyReviewedCreationInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data !== null &&
        "reviewedCreationDryRun" in error.data &&
        error.data.reviewedCreationDryRun === true
      )
        return { status: "dryRun" };
      const reason = creationRefusal(error);
      if (!reason) throw error;
      return { status: "refused", reason };
    }
  },
});

/**
 * Store cover art an operator found at `url` (a publisher or retailer
 * jacket) for an updateFields `coverImage` entry, when no source record
 * offers the Release any: a public https JPEG, PNG, GIF or WebP, at least a real jacket's
 * size. Returns the storage id the entry names. A blob no entry ends up
 * using is left in storage.
 *
 *   npx convex run repair:storeCoverFromUrl '{"url": "https://…"}'
 */
export const storeCoverFromUrl = internalAction({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new ConvexError("Cover URL must be https.");
    const res = await fetch(url);
    if (!res.ok) throw new ConvexError(`Cover URL answered ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Read from the bytes: some CDNs send jackets with no content type.
    const type = rasterType(bytes);
    if (type === null) throw new ConvexError("Not a raster image.");
    if (bytes.length < 5000)
      throw new ConvexError(`Too small for a jacket (${bytes.length} bytes).`);
    const storageId = await ctx.storage.store(new Blob([bytes], { type }));
    return { storageId, bytes: bytes.length, type };
  },
});
