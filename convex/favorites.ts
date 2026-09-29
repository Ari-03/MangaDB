// Favorites (CONTEXT.md: Favorite): a User's private mark on a Series, a
// Volume, or an omnibus Edition (the targets Ratings take, lib/ratings.ts),
// toggled from its page and listed in the library's Favorites view.
// Nothing here is readable by another user; profiles never show Favorites.
// A Volume or Edition row carries its Series too (denormalised, like
// comments), so a Series merge can move every row of a Series through one
// index.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { editionCover, followMerges } from "./catalogPages";
import { requireUser, viewerOrNull } from "./lib/auth";
import { coverUrl } from "./lib/covers";
import {
  omnibusEdition,
  requireActiveTarget,
  resolveTarget,
  targetIdArg,
  targetRefArg,
  type TargetId,
} from "./lib/ratings";
import { volumeTitle } from "./lib/titles";

/** Favorites the library view lists; older ones past this stay stored. */
const MINE_MAX = 500;

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
 * Null when signed out, username pending, or the target is unknown or
 * hidden, so the button renders nothing.
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

/** A Volume's jacket: the first stored cover among its Releases, else an ISBN to look one up by. */
async function volumeCover(ctx: QueryCtx, volumeId: Id<"volumes">) {
  const covering = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
    .take(10);
  // Books covering the whole Volume first; an omnibus jacket is a last resort.
  covering.sort((a, b) => (a.extent === "complete" ? 0 : 1) - (b.extent === "complete" ? 0 : 1));
  let isbn: string | null = null;
  for (const row of covering) {
    const releases = await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", row.editionId))
      .collect();
    for (const release of releases) {
      if (release.status !== "active") continue;
      const url = await coverUrl(ctx, release.coverImage?.storageId);
      if (url) return { coverUrl: url, coverIsbn: release.isbn13 ?? null };
      isbn ??= release.isbn13 ?? null;
    }
  }
  return { coverUrl: null, coverIsbn: isbn };
}

/**
 * The viewer's Favorites, newest first, for the library: each active Series,
 * Volume or omnibus Edition with its ID for `toggle`, title, cover, and
 * whether it is Mature (the view conceals that art unless the viewer opted
 * in). Favorites of hidden records, and of Editions no longer rated as one
 * book, are left out while so. Null when signed out or username pending.
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
        const found = await omnibusEdition(ctx, await ctx.db.get(row.editionId));
        if (!("target" in found) || seen.has(found.edition._id)) continue;
        seen.add(found.edition._id);
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
        const volume = await followMerges(ctx, "volumes", await ctx.db.get(row.volumeId));
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
        const series = await followMerges(ctx, "series", await ctx.db.get(row.seriesId));
        if (!series || seen.has(series._id)) continue;
        seen.add(series._id);
        const stats = await ctx.db
          .query("seriesStats")
          .withIndex("by_series", (q) => q.eq("seriesId", series._id))
          .unique();
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
