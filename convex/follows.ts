// Series Follows + My Upcoming Releases (ticket #29, spec §3).
//
// The invariants, straight from the glossary (CONTEXT.md):
// - A Series Follow is an explicit choice, independent of Collection Entries
//   and Volume Progress. Recording another tracking fact may *suggest* a
//   follow (collection.ts returns the suggestion after a first Collection
//   Entry in a Series) but never creates one without confirmation — only
//   setSeriesFollow ever writes `following`.
// - The post-first-entry prompt appears once per Series; dismissal is
//   permanent (`followPromptDismissed`, written only by dismissFollowPrompt).
// - My Upcoming Releases = announced future Canonical Releases from followed
//   Series matching the user's Physical/Digital/Both preference, plus every
//   future Wanted/Ordered Release *and Bundle* regardless of preference —
//   deduplicated, Owned excluded (direct or derived), computed live and
//   never stored.
// - Follows are always private in v1: nothing here is readable for another
//   user, and sharing.ts never exposes them.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { resolveActiveSeries } from "./catalog";
import { followMerges } from "./catalogPages";
import { requireUser, viewerOrNull } from "./lib/auth";
import { requireActiveSeries } from "./reading";
import { joinBrowseRows } from "./releases";

// My Upcoming scans the uncapped future horizon (spec §7) over by_date; the
// cap guards pathology and is surfaced as `capped` so the view can say so.
export const UPCOMING_SCAN_CAP = 4000;

async function seriesStateRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
) {
  return await ctx.db
    .query("userSeriesStates")
    .withIndex("by_user_series", (q) =>
      q.eq("userId", userId).eq("seriesId", seriesId),
    )
    .unique();
}

// ---------- queries ----------

/**
 * The viewer's follow state for one Series page. Null when signed out,
 * username pending, or the Series is unknown — the public page renders
 * identically, just without the toggle.
 */
export const seriesFollow = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    if (!series) return null;
    const state = await seriesStateRow(ctx, user._id, series._id);
    return { seriesId: series._id, following: state?.following ?? false };
  },
});

/**
 * The public IDs of every Series the viewer follows, merge-resolved — the
 * Releases browser's overlay for the subtle followed marker and the
 * followed-Series filter (both applied client-side, per the recorded spec §8
 * trade-off: array-containment filters run in memory, never on an index).
 * Null when signed out or username pending.
 */
export const followedSeries = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const states = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", user._id))
      .collect();
    const seriesPublicIds = [];
    for (const state of states) {
      if (!state.following) continue;
      const series = await followMerges(ctx, "series", await ctx.db.get(state.seriesId));
      if (series) seriesPublicIds.push(series.publicId);
    }
    return { seriesPublicIds };
  },
});

/**
 * My Upcoming Releases (spec §3), computed live on every read — nothing is
 * stored. `todaySort` is the route-computed yyyymmdd key (spec §8 partial
 * dates), exactly as the Publisher Spotlight's upcoming lane takes it.
 *
 * The formula: announced future Canonical Releases from followed Series
 * matching the viewer's Physical/Digital/Both preference, plus every future
 * Wanted/Ordered Release and Bundle regardless of preference; one row per
 * Release however many clauses match it (dedup); anything Owned — directly
 * or derived through an Owned Bundle — is excluded.
 *
 * "Future" follows the publisher-lane convention: the scan starts at the
 * current month's yyyymm00, keeping dated rows today-or-later plus day-TBA
 * rows of the current month and beyond; a past-month TBA row sits below the
 * range and a dated row earlier this month drops in memory.
 */
export const myUpcoming = query({
  args: { todaySort: v.number() },
  handler: async (ctx, { todaySort }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    if (!Number.isInteger(todaySort) || todaySort <= 0) {
      return { items: [], capped: false };
    }
    const monthStart = Math.floor(todaySort / 100) * 100;
    const upcoming = (pubDate?: { sort: number; day?: number }) =>
      pubDate !== undefined &&
      pubDate.sort >= monthStart &&
      (pubDate.sort >= todaySort || pubDate.day === undefined);

    // Followed Series, both the stored id and its merge survivor, so a
    // follow recorded before a merge still matches the survivor's denorms.
    const states = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", user._id))
      .collect();
    const followed = new Set<Id<"series">>();
    for (const state of states) {
      if (!state.following) continue;
      followed.add(state.seriesId);
      const series = await followMerges(ctx, "series", await ctx.db.get(state.seriesId));
      if (series) followed.add(series._id);
    }
    const inFollowed = (doc: Doc<"releases">) =>
      doc.seriesIds.some((id) => followed.has(id));
    const matchesPreference = (doc: Doc<"releases">) =>
      user.formatPreference === "both" || doc.format === user.formatPreference;

    // The viewer's Collection Entries, keyed by merge-resolved target: the
    // Wanted/Ordered inclusion clause and the Owned exclusion in one pass.
    const entries = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const releaseEntries = new Map<
      Id<"releases">,
      { doc: Doc<"releases">; state: Doc<"collectionEntries">["state"] }
    >();
    const bundleEntries = new Map<
      Id<"releaseBundles">,
      { doc: Doc<"releaseBundles">; state: Doc<"collectionEntries">["state"] }
    >();
    for (const entry of entries) {
      if (entry.releaseId) {
        const doc = await followMerges(ctx, "releases", await ctx.db.get(entry.releaseId));
        if (doc) releaseEntries.set(doc._id, { doc, state: entry.state });
      } else if (entry.bundleId) {
        const doc = await followMerges(
          ctx,
          "releaseBundles",
          await ctx.db.get(entry.bundleId),
        );
        if (doc) bundleEntries.set(doc._id, { doc, state: entry.state });
      }
    }

    // Derived Ownership excludes too: owning a Bundle owns its members.
    const derivedOwned = new Set<Id<"releases">>();
    for (const { doc, state } of bundleEntries.values()) {
      if (state !== "owned") continue;
      const memberships = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", doc._id))
        .collect();
      for (const membership of memberships) {
        const release = await followMerges(
          ctx,
          "releases",
          await ctx.db.get(membership.releaseId),
        );
        if (release) derivedOwned.add(release._id);
      }
    }

    // Candidate Releases, deduplicated by document: the followed-Series
    // clause comes from the date-window index scan (in-memory refinement per
    // the recorded spec §8 trade-off); the Wanted/Ordered clause comes
    // straight from the entries, so it holds even past the scan cap.
    const windowDocs = await ctx.db
      .query("releases")
      .withIndex("by_date", (q) => q.gte("pubDate.sort", monthStart))
      .take(UPCOMING_SCAN_CAP);
    const capped = windowDocs.length === UPCOMING_SCAN_CAP;

    const candidates = new Map<Id<"releases">, Doc<"releases">>();
    for (const doc of windowDocs) {
      if (doc.status !== "active" || !upcoming(doc.pubDate)) continue;
      if (inFollowed(doc) && matchesPreference(doc)) candidates.set(doc._id, doc);
    }
    for (const { doc, state } of releaseEntries.values()) {
      if (state !== "wanted" && state !== "ordered") continue;
      if (!upcoming(doc.pubDate)) continue;
      candidates.set(doc._id, doc);
    }

    const included = [...candidates.values()].filter(
      (doc) =>
        releaseEntries.get(doc._id)?.state !== "owned" && !derivedOwned.has(doc._id),
    );
    const rows = await joinBrowseRows(ctx, included);
    const annotations = new Map(
      included.map((doc) => {
        const state = releaseEntries.get(doc._id)?.state;
        return [
          doc._id,
          {
            state: state === "wanted" || state === "ordered" ? state : null,
            followed: inFollowed(doc),
          },
        ] as const;
      }),
    );
    const releaseItems = rows.map((row) => ({
      kind: "release" as const,
      ...row,
      ...annotations.get(row.id)!,
    }));

    // Future Wanted/Ordered Bundles, regardless of preference. An undated
    // Bundle is not announced (CONTEXT.md: an Upcoming Release has a *known*
    // future date), so it never appears.
    const bundleItems: Array<{
      kind: "bundle";
      id: Id<"releaseBundles">;
      bundlePublicId: number;
      name: string;
      sort: number;
      day: number | null;
      format: "physical" | "digital" | null;
      state: "wanted" | "ordered";
    }> = [];
    for (const { doc, state } of bundleEntries.values()) {
      if (state !== "wanted" && state !== "ordered") continue;
      if (!upcoming(doc.pubDate)) continue;
      bundleItems.push({
        kind: "bundle" as const,
        id: doc._id,
        bundlePublicId: doc.publicId,
        name: doc.name,
        sort: doc.pubDate!.sort,
        day: doc.pubDate!.day ?? null,
        format: doc.format ?? null,
        state,
      });
    }

    const name = (
      item: (typeof releaseItems)[number] | (typeof bundleItems)[number],
    ) =>
      item.kind === "release"
        ? (item.series[0]?.title ?? item.edition.title)
        : item.name;
    const items = [...releaseItems, ...bundleItems].sort(
      (a, b) => a.sort - b.sort || name(a).localeCompare(name(b)),
    );
    return { items, capped };
  },
});

// ---------- mutations ----------

/**
 * The one write path for a Series Follow (spec §3): the explicit toggle on
 * the Series page, or the confirmed post-first-entry prompt. Nothing else —
 * not collection entries, not reading — ever sets `following`.
 */
export const setSeriesFollow = mutation({
  args: { seriesId: v.id("series"), following: v.boolean() },
  handler: async (ctx, { seriesId, following }) => {
    const user = await requireUser(ctx);
    const series = await requireActiveSeries(ctx, seriesId);
    const state = await seriesStateRow(ctx, user._id, series._id);
    if (state) {
      await ctx.db.patch(state._id, { following });
    } else if (following) {
      await ctx.db.insert("userSeriesStates", {
        userId: user._id,
        seriesId: series._id,
        following: true,
        followPromptDismissed: false,
      });
    }
    return { following };
  },
});

/**
 * Permanently dismiss the post-first-entry follow prompt for one Series
 * (spec §3: dismissal suppresses future prompts). collection.ts checks this
 * flag before ever suggesting again; nothing clears it.
 */
export const dismissFollowPrompt = mutation({
  args: { seriesId: v.id("series") },
  handler: async (ctx, { seriesId }) => {
    const user = await requireUser(ctx);
    const series = await requireActiveSeries(ctx, seriesId);
    const state = await seriesStateRow(ctx, user._id, series._id);
    if (state) {
      await ctx.db.patch(state._id, { followPromptDismissed: true });
    } else {
      await ctx.db.insert("userSeriesStates", {
        userId: user._id,
        seriesId: series._id,
        following: false,
        followPromptDismissed: true,
      });
    }
    return null;
  },
});
