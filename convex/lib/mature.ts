// Mature Series (CONTEXT.md): what is rated 18+, and who sees it.
//
// A Series is mature when the Data Team says so (series.contentRating), or,
// absent that call, when any of its evidence does:
// - a source rates one of its books or the Series itself 18+: a Source
//   Observation linked to the Series or to one of its Releases carries
//   `mature: true` in its snapshot (the parsers set it from Kodansha's
//   age_rating, Seven Seas' and Yen Press's age-rating labels, a Seven Seas
//   page naming an adult-only imprint, and ANN's Objectionable-content
//   rating and genres);
// - one of its Editions comes from an adult-only publisher or imprint
//   (publishers.contentRating = "mature": FAKKU, 801 Media, Ghost Ship,
//   Steamship).
// The Series library rebuild derives `series.mature` from these
// (seriesBrowse.upsertStats), so new evidence shows within one rebuild. A
// Seven Seas book page rating its book mature applies at once
// (seriesBrowse.applyMatureEvidence), as does an edit to a Series'
// contentRating (moderation.applyUpdate).
//
// Visibility: everyone can see a Mature Series' own pages, but discovery
// (browse, search, the calendars, boards, author shelves, the sitemap)
// leaves it out unless the viewer opted in. Public catalog queries take the
// viewer's choice as a `showMature` argument, since they run without auth.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

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

/** Does any Source Observation linked to this record rate it 18+? */
export async function sourceRatesMature(
  ctx: QueryCtx,
  ref: { type: "series"; id: Id<"series"> } | { type: "release"; id: Id<"releases"> },
): Promise<boolean> {
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id))
    .collect();
  return observations.some(
    (obs) => !obs.withdrawn && (obs.snapshot as { mature?: unknown } | null)?.mature === true,
  );
}

/**
 * The Data Team's call on a Series, or null when it has made none and the
 * evidence decides (any one piece makes the Series mature).
 */
export function ratedByDataTeam(contentRating: Doc<"series">["contentRating"]): boolean | null {
  return contentRating === undefined ? null : contentRating === "mature";
}
