// Mature Series (CONTEXT.md): what is rated 18+, and who sees it.
//
// A Series is mature when the Data Team says so (series.contentRating), or,
// absent that call, when any of its evidence does:
// - a source rates one of its books or the Series itself 18+: a Source
//   Observation linked to the Series or to one of its Releases carries
//   `mature: true` in its snapshot (the parsers set it from Kodansha's
//   age_rating, Seven Seas' and Yen Press's age-rating labels, and ANN's
//   Objectionable-content rating and genres) or names an adult-only imprint
//   in its `imprint` (PRH's and Seven Seas' snapshots), whatever Publisher
//   the Edition is filed under (observationRatesMature);
// - one of its Editions comes from an adult-only publisher or imprint
//   (publishers.contentRating = "mature": FAKKU, 801 Media, Ghost Ship,
//   Steamship).
// The Series library rebuild derives `series.mature` from these
// (seriesBrowse.upsertStats). An import sets the flag on the Series in its
// own transaction when it brings new evidence (applyMatureEvidence, from
// lib/observations.ts): linking an observation that is evidence, or one to a
// Release under an adult-only Publisher, a linked observation's snapshot
// turning into evidence, and a withdrawn linked one listed again. The
// Series' library row and pack entry follow in a scheduled job
// (seriesBrowse.projectMature), since a pack is a document of up to 1 MiB
// many Series share. Until it runs, the library's filtered totals and facet
// counts still include the Series; its cards check the Series itself. A
// Data Team edit to a Series' contentRating sets the flag and the
// projection at once (moderation.applyUpdate). These wait for the rebuild:
// evidence that goes away, a Publisher row marked adult-only later, a merge
// or Split, which repoint observations directly (lib/sensitiveOps.ts), not
// through linkObservation, so a survivor or a restored Series is flagged
// only then, and a projection job that failed. An observation linked to a
// Release Bundle is evidence for neither the import nor the rebuild.
//
// Visibility: everyone can see a Mature Series' own pages, but discovery
// (browse, search, the calendars, boards, author shelves, the sitemap)
// leaves it out unless the viewer opted in. Public catalog queries take the
// viewer's choice as a `showMature` argument, since they run without auth.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canonicalPublisherFor } from "./publishers";
import { patchPackEntry, seriesStatsRow } from "./seriesStats";

/**
 * The most Series one projectMature job carries into the library: each
 * rewrites the Series' pack (syncMatureProjection), up to 1 MiB, so with
 * packs near that size a job reads about 10 MB (each pack is read by the
 * query and again by the patch) and writes about 5 MB of the 16 MiB
 * limits, whatever an import flipped.
 */
export const MATURE_PROJECTIONS_PER_JOB = 5;

/** The `showMature` argument every public discovery query accepts. */
export const showMatureArg = { showMature: v.optional(v.boolean()) };

/** Whether a record rated `mature` may appear in a discovery list for this viewer. */
export function visibleTo(showMature: boolean | undefined, mature: boolean | undefined): boolean {
  return showMature === true || mature !== true;
}

/**
 * Whether a Series may appear in public discovery at all: active, with a
 * book (not Bookless), and not mature unless the viewer opted in.
 */
export function listed(series: Doc<"series">, showMature: boolean | undefined): boolean {
  return (
    series.status === "active" &&
    series.bookless !== true &&
    visibleTo(showMature, series.mature)
  );
}

/**
 * Whether a Source Observation is 18+ evidence: not withdrawn, and its
 * snapshot rates the book or Series mature (`mature: true`) or names an
 * adult-only imprint (`imprint` resolving to an `adultOnly` row in
 * lib/publishers.ts: Ghost Ship, Steamship).
 */
export function observationRatesMature(observation: Doc<"sourceObservations">): boolean {
  const snapshot: unknown = observation.snapshot;
  if (observation.withdrawn || typeof snapshot !== "object" || snapshot === null) return false;
  if ("mature" in snapshot && snapshot.mature === true) return true;
  return (
    "imprint" in snapshot &&
    typeof snapshot.imprint === "string" &&
    canonicalPublisherFor(snapshot.imprint)?.adultOnly === true
  );
}

/** Does any Source Observation linked to this record rate it 18+? */
export async function sourceRatesMature(
  ctx: QueryCtx,
  ref: { type: "series"; id: Id<"series"> } | { type: "release"; id: Id<"releases"> },
): Promise<boolean> {
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id))
    .collect();
  return observations.some(observationRatesMature);
}

/**
 * Make a linked observation's Series mature at once when it is evidence:
 * the observation rates mature (observationRatesMature), or it links a
 * Release whose Edition's Publisher is adult-only. lib/observations.ts calls
 * this when it links an observation, when a linked one's snapshot changes,
 * and when a withdrawn one is seen again, for every importer, so discovery
 * leaves the Series out from the import's own transaction. A Series
 * the Data Team rated keeps its call. Nothing here clears the flag: a Series
 * whose evidence went away is cleared by the next rebuild.
 *
 * Only `series.mature` is written here; when any Series flips, one
 * seriesBrowse.projectMature job is scheduled to update their library rows
 * and pack entries. A Series flips once per transaction, so a mutation
 * schedules at most one job per Series it flips.
 */
export async function applyMatureEvidence(ctx: MutationCtx, observation: Doc<"sourceObservations">) {
  const ref = observation.recordRef;
  let seriesIds: Id<"series">[];
  if (ref?.type === "series") {
    if (!observationRatesMature(observation)) return;
    seriesIds = [ref.id];
  } else if (ref?.type === "release") {
    const release = await ctx.db.get(ref.id);
    if (release?.status !== "active") return;
    if (!observationRatesMature(observation)) {
      const publisher = await ctx.db.get(release.publisherId);
      if (publisher?.contentRating !== "mature") return;
    }
    seriesIds = release.seriesIds;
  } else {
    return;
  }
  const flipped: Id<"series">[] = [];
  for (const seriesId of seriesIds) {
    const series = await ctx.db.get(seriesId);
    if (series?.status !== "active" || series.mature === true) continue;
    if (ratedByDataTeam(series.contentRating) !== null) continue;
    // Derived data, no Revision, as in the rebuild.
    await ctx.db.patch(series._id, { mature: true });
    flipped.push(series._id);
  }
  if (flipped.length > 0) {
    await ctx.scheduler.runAfter(0, internal.seriesBrowse.projectMature, { seriesIds: flipped });
  }
}

/**
 * Carry a Series' new `mature` flag into its library row and pack entry
 * (seriesBrowse.projectMature, and a Data Team rating edit in
 * moderation.applyUpdate), so the filtered library and its facets show it
 * without waiting for the next rebuild. A Series without a row yet (never
 * rebuilt, or bookless) has nothing to update, and one already carrying the
 * flag is left as it is.
 */
export async function syncMatureProjection(ctx: MutationCtx, series: Doc<"series">, mature: boolean) {
  const flag = mature ? { mature: true as const } : { mature: undefined };
  const row = await seriesStatsRow(ctx, series._id);
  if (row && (row.mature === true) !== mature) await ctx.db.patch(row._id, flag);
  await patchPackEntry(ctx, series.publicId, (entry) => (entry.mature === true) === mature, flag);
}

/**
 * The Data Team's call on a Series, or null when it has made none and the
 * evidence decides (any one piece makes the Series mature).
 */
export function ratedByDataTeam(contentRating: Doc<"series">["contentRating"]): boolean | null {
  return contentRating === undefined ? null : contentRating === "mature";
}
