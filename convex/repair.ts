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
import { applyEntry } from "./lib/repair/ops";

/** Evidence stored on each repair Proposal: its source observations, else a plan note. */
function evidenceFor(entry: RepairEntry) {
  const note = { kind: "note" as const, text: `One-time data repair plan entry ${entry.key}` };
  switch (entry.kind) {
    case "unlinkObservation":
      return [{ kind: "observation" as const, observationId: entry.observationId }, note];
    case "editionPublisher":
      return [...entry.observationIds.map((observationId) => ({ kind: "observation" as const, observationId })), note];
    case "updateFields":
      return entry.evidenceObservationId
        ? [{ kind: "observation" as const, observationId: entry.evidenceObservationId }, note]
        : [note];
    default:
      return [note];
  }
}

/** Apply one entry. Internal to runBatch: always called as a sub-transaction. */
export const applyOne = internalMutation({
  args: { entry: repairEntry, dryRun: v.boolean(), actor: v.string() },
  returns: outcome,
  handler: async (ctx, { entry, dryRun, actor }) => {
    const audit = createAudit(ctx, await resolveActor(ctx, actor), `Data repair: ${entry.reason}`, evidenceFor(entry));
    const result = await applyEntry(ctx, audit, entry);
    await audit.finish();
    const reported: Outcome = {
      key: entry.key,
      ...result,
      ...(audit.notes.length > 0 ? { notes: audit.notes } : {}),
    };
    // Throwing rolls this sub-transaction back; runBatch reads the outcome.
    if (dryRun && audit.wrote) throw new ConvexError({ dryRun: reported });
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
        outcomes.push(await ctx.runMutation(internal.repair.applyOne, { entry, dryRun, actor }));
      } catch (error) {
        const data = errorData(error);
        if (data?.dryRun) outcomes.push(data.dryRun);
        else if (data?.skip) outcomes.push({ key: entry.key, status: "skipped", reason: data.skip });
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
        sourceKey === "ann" ? q.eq("sourceKey", "ann").gte("sourceRecordId", "release:") : q.eq("sourceKey", sourceKey),
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
