// Favorites (CONTEXT.md: Favorite): a User's private mark on a Series, a
// Volume, or an omnibus Edition (the targets Ratings take, lib/ratings.ts),
// toggled from its page and listed in the library's Favorites view.
// Nothing here is readable by another user; profiles never show Favorites.
// A Volume or Edition row carries its Series too (denormalised, like
// comments), so a Series merge can move every row of a Series through one
// index.

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { editionCover } from "./catalogPages";
import { getActive } from "./lib/merges";
import { requireUser, viewerOrNull } from "./lib/auth";
import { coverUrl } from "./lib/covers";
import { releasesOf } from "./lib/editionRows";
import { capture } from "./lib/posthog";
import {
  omnibusEdition,
  requireActiveTarget,
  resolveTarget,
  targetIdArg,
  targetRefArg,
  type TargetId,
} from "./lib/ratings";
import { volumeTitle } from "./lib/titles";
import { seriesStatsRow } from "./seriesBrowse";

/**
 * Favorites the library view lists; older ones past this stay stored. Sized
 * against Convex's 16,384 documents read per query: an omnibus Favorite reads
 * its row, Edition, Edition Line and Series (4), each of its k coverage rows
 * with that Volume and Series (3k), and up to 10 Releases with their stored
 * cover metadata (20, editionCover), so 24 + 3k. A 3-in-1 is 33 reads, and
 * 500 of them (16,500) would pass the limit; 200 of them read 6,600, and even
 * 200 ten-volume omnibuses (54 each) stay near 10,800.
 */
const MINE_MAX = 200;

/** One user's Favorite of one target, or null. */
async function favoriteRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: TargetId,
): Promise<Doc<"favorites"> | null> {
  const favorites = ctx.db.query("favorites");
  switch (target.kind) {
    case "series":
      return await favorites
        .withIndex("by_user_series", (q) =>
          q
            .eq("userId", userId)
            .eq("seriesId", target.id)
            .eq("volumeId", undefined)
            .eq("editionId", undefined),
        )
        .unique();
    case "volume":
      return await favorites
        .withIndex("by_user_volume", (q) => q.eq("userId", userId).eq("volumeId", target.id))
        .unique();
    case "edition":
      return await favorites
        .withIndex("by_user_edition", (q) => q.eq("userId", userId).eq("editionId", target.id))
        .unique();
  }
}

/**
 * Whether the viewer favorited a target, with the target's ID for `toggle`.
 * Null without a viewer (viewerOrNull) or for an unknown or hidden target,
 * so the button renders nothing.
 */
export const isFavorite = query({
  args: { target: targetRefArg },
  handler: async (ctx, { target }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const resolved = await resolveTarget(ctx, target);
    if (!resolved) return null;
    const row = await favoriteRow(ctx, user._id, resolved.target);
    return { target: resolved.target, favorite: row !== null };
  },
});

/**
 * Favorite or unfavorite a target, whichever it is not now; returns the new
 * state. A merged target resolves to its survivor; a hidden one is refused.
 */
export const toggle = mutation({
  args: { target: targetIdArg },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { target, series } = await requireActiveTarget(
      ctx,
      args.target,
      "Nothing to favorite here any more.",
    );
    const existing = await favoriteRow(ctx, user._id, target);
    await capture(ctx, user, "favorite_toggled", { kind: target.kind, favorite: !existing });
    if (existing) {
      await ctx.db.delete(existing._id);
      return { favorite: false };
    }
    // The target's own key beside its Series (a Series row has only that).
    const key =
      target.kind === "volume"
        ? { volumeId: target.id }
        : target.kind === "edition"
          ? { editionId: target.id }
          : {};
    await ctx.db.insert("favorites", { userId: user._id, seriesId: series._id, ...key });
    return { favorite: true };
  },
});

/**
 * A Volume's jacket: the first stored cover among the active Releases of its
 * active Editions (what its Volume page lists), else an ISBN to look one up
 * by: the first physical Release's, else the first one seen (the upstreams
 * know print best).
 */
async function volumeCover(ctx: QueryCtx, volumeId: Id<"volumes">) {
  const covering = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
    .take(10);
  // Books covering the whole Volume first; an omnibus jacket is a last resort.
  covering.sort((a, b) => (a.extent === "complete" ? 0 : 1) - (b.extent === "complete" ? 0 : 1));
  let isbn: string | null = null;
  let printIsbn: string | null = null;
  for (const row of covering) {
    const edition = await ctx.db.get(row.editionId);
    if (!edition || edition.status !== "active") continue;
    const releases = await releasesOf(ctx, row.editionId);
    for (const release of releases) {
      if (release.status !== "active") continue;
      const url = await coverUrl(ctx, release.coverImage?.storageId);
      if (url) return { coverUrl: url, coverIsbn: release.isbn13 ?? null };
      isbn ??= release.isbn13 ?? null;
      if (release.format === "physical") printIsbn ??= release.isbn13 ?? null;
    }
  }
  return { coverUrl: null, coverIsbn: printIsbn ?? isbn };
}

/**
 * The viewer's Favorites, newest first, for the library: each active Series,
 * Volume or omnibus Edition with its ID for `toggle`, title, cover, and
 * whether it is Mature (the view conceals that art unless the viewer opted
 * in). Favorites of hidden records, and of Editions no longer rated as one
 * book, are left out while so. Null without a viewer.
 */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const rows = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(MINE_MAX);
    const items = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.editionId) {
        // Resolve merges first, so Favorites of Editions merged into one read
        // the survivor's coverage and cover once.
        const edition = await getActive(ctx, "editions", row.editionId);
        if (!edition || seen.has(edition._id)) continue;
        seen.add(edition._id);
        const found = await omnibusEdition(ctx, edition);
        if (!("target" in found)) continue;
        items.push({
          kind: "edition" as const,
          target: found.target,
          publicId: found.edition.publicId,
          title: found.info.title,
          seriesTitle: found.series.title,
          label: null,
          mature: found.info.mature,
          ...(await editionCover(ctx, found.edition._id)),
        });
      } else if (row.volumeId) {
        const volume = await getActive(ctx, "volumes", row.volumeId);
        const series = volume ? await ctx.db.get(volume.seriesId) : null;
        if (!volume || !series || series.status !== "active" || seen.has(volume._id)) continue;
        seen.add(volume._id);
        items.push({
          kind: "volume" as const,
          target: { kind: "volume" as const, id: volume._id },
          publicId: volume.publicId,
          title: volumeTitle(series.title, volume.label ?? null),
          seriesTitle: series.title,
          label: volume.label ?? null,
          mature: series.mature === true,
          ...(await volumeCover(ctx, volume._id)),
        });
      } else {
        const series = await getActive(ctx, "series", row.seriesId);
        if (!series || seen.has(series._id)) continue;
        seen.add(series._id);
        const stats = await seriesStatsRow(ctx, series._id);
        items.push({
          kind: "series" as const,
          target: { kind: "series" as const, id: series._id },
          publicId: series.publicId,
          title: series.title,
          seriesTitle: series.title,
          label: null,
          mature: series.mature === true,
          coverUrl: stats?.coverUrl ?? null,
          coverIsbn: stats?.coverIsbn ?? null,
        });
      }
    }
    return { items };
  },
});
