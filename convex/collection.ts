// Personal collection (ticket #27, spec §3): Wanted / Ordered / Owned
// Collection Entries on Releases and Bundles, variant pinning, and computed
// Derived Ownership.
//
// The invariants, straight from the glossary (CONTEXT.md):
// - A Collection Entry targets a Release or a Bundle, in exactly one of three
//   states: Wanted | Ordered | Owned (Ordered includes preorders). Every
//   transition is user-controlled — nothing here changes state as a side
//   effect of anything.
// - A Release entry may optionally identify a Release Variant (the alternate
//   cover the user owns or wants).
// - Owning a Bundle yields Derived Ownership of its member Releases —
//   computed at read time, never stored — which coexists with direct entries.
//   Removing the Bundle entry therefore never erases a direct entry.
// - There is no stored Volume-ownership state: a Volume reads as owned
//   through the owned Releases covering it (volumeOwnership below).

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { editionCoverage, followMerges } from "./catalogPages";
import { requireUser, viewerOrNull } from "./lib/auth";
import { releaseAnchor } from "./lib/titles";
import { requireActiveRelease } from "./reading";

// Mirrors the collectionEntries.state union in schema.ts.
const stateValidator = v.union(
  v.literal("wanted"),
  v.literal("ordered"),
  v.literal("owned"),
);

// ---------- shared lookups ----------

/** The Bundle resolved through merges; throws when unknown or hidden. */
async function requireActiveBundle(
  ctx: QueryCtx,
  bundleId: Id<"releaseBundles">,
): Promise<Doc<"releaseBundles">> {
  const bundle = await followMerges(
    ctx,
    "releaseBundles",
    await ctx.db.get(bundleId),
  );
  if (!bundle) {
    throw new ConvexError({ code: "notFound", message: "Bundle not found." });
  }
  return bundle;
}

/** The one direct entry for (user, release) — at most one by invariant. */
async function releaseEntryRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  releaseId: Id<"releases">,
) {
  return await ctx.db
    .query("collectionEntries")
    .withIndex("by_user_release", (q) =>
      q.eq("userId", userId).eq("releaseId", releaseId),
    )
    .unique();
}

/** The one entry for (user, bundle) — at most one by invariant. */
async function bundleEntryRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  bundleId: Id<"releaseBundles">,
) {
  return await ctx.db
    .query("collectionEntries")
    .withIndex("by_user_bundle", (q) =>
      q.eq("userId", userId).eq("bundleId", bundleId),
    )
    .unique();
}

/** Active, merge-resolved Series covered by one Collection Entry's target. */
async function entrySeries(
  ctx: QueryCtx,
  entry: Doc<"collectionEntries">,
): Promise<Map<Id<"series">, Doc<"series">>> {
  const covered = new Map<Id<"series">, Doc<"series">>();
  const addRelease = async (releaseId: Id<"releases">) => {
    const release = await followMerges(ctx, "releases", await ctx.db.get(releaseId));
    if (!release) return;
    for (const seriesId of release.seriesIds) {
      const series = await followMerges(ctx, "series", await ctx.db.get(seriesId));
      if (series) covered.set(series._id, series);
    }
  };
  if (entry.releaseId) {
    await addRelease(entry.releaseId);
  } else if (entry.bundleId) {
    const bundle = await followMerges(
      ctx,
      "releaseBundles",
      await ctx.db.get(entry.bundleId),
    );
    if (!bundle) return covered;
    const memberships = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
      .collect();
    for (const membership of memberships) {
      await addRelease(membership.releaseId);
    }
  }
  return covered;
}

/**
 * The one non-blocking follow prompt per Series (ticket #29, spec §3),
 * computed after a *new* entry was inserted: for each Series the new entry's
 * target covers, suggest a Series Follow exactly when this is the user's
 * first Collection Entry in that Series (no other entry covers it), they are
 * not already following it, and the prompt was never dismissed for it. The
 * client renders the suggestion; only follows.setSeriesFollow ever creates
 * the follow, and follows.dismissFollowPrompt suppresses it permanently.
 */
async function followSuggestions(
  ctx: QueryCtx,
  userId: Id<"users">,
  newEntry: Doc<"collectionEntries">,
) {
  const target = await entrySeries(ctx, newEntry);
  if (target.size === 0) return [];

  const others = (
    await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()
  ).filter((entry) => entry._id !== newEntry._id);
  const alreadyCovered = new Set<Id<"series">>();
  for (const other of others) {
    for (const seriesId of (await entrySeries(ctx, other)).keys()) {
      alreadyCovered.add(seriesId);
    }
  }

  const suggestions = [];
  for (const [seriesId, series] of target) {
    if (alreadyCovered.has(seriesId)) continue;
    const state = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) =>
        q.eq("userId", userId).eq("seriesId", seriesId),
      )
      .unique();
    if (state?.following || state?.followPromptDismissed) continue;
    suggestions.push({ seriesId, title: series.title });
  }
  return suggestions;
}

/** A Variant's display name, or null when it is hidden or gone. */
export async function variantName(
  ctx: QueryCtx,
  variantId: Id<"releaseVariants"> | undefined,
): Promise<string | null> {
  if (!variantId) return null;
  const variant = await ctx.db.get(variantId);
  return variant && variant.status === "active" ? variant.name : null;
}

/**
 * Derived Ownership for one Release (spec §3): every active Bundle containing
 * it that the user Owns, with the bundle-pinned Variant named when the box
 * set specifies one. Computed here at read time — never stored — so it
 * appears and disappears with the Bundle entry alone.
 */
async function derivedOwnership(
  ctx: QueryCtx,
  userId: Id<"users">,
  releaseId: Id<"releases">,
) {
  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .collect();
  const derived = [];
  const seen = new Set<Id<"releaseBundles">>();
  for (const membership of memberships) {
    const bundle = await followMerges(
      ctx,
      "releaseBundles",
      await ctx.db.get(membership.bundleId),
    );
    if (!bundle || seen.has(bundle._id)) continue;
    seen.add(bundle._id);
    const entry = await bundleEntryRow(ctx, userId, bundle._id);
    if (entry?.state !== "owned") continue;
    derived.push({
      bundlePublicId: bundle.publicId,
      bundleName: bundle.name,
      pinnedVariantName: await variantName(ctx, membership.variantId),
    });
  }
  return derived;
}

/** Enough joined Edition context to link a Release from personal views. */
export async function releaseLink(ctx: QueryCtx, release: Doc<"releases">) {
  const edition = await followMerges(
    ctx,
    "editions",
    await ctx.db.get(release.editionId),
  );
  if (!edition) return null;
  const { title } = await editionCoverage(ctx, edition);
  return {
    editionPublicId: edition.publicId,
    editionTitle: title,
    anchor: releaseAnchor(release),
    format: release.format,
    binding: release.binding ?? null,
  };
}

// ---------- queries ----------

/**
 * The viewer's collection state for one Release row: the direct entry (state
 * + pinned Variant), the Release's active Variants for the picker, and any
 * Derived Ownership from Owned Bundles. Null when signed out, username
 * pending, or the Release is unknown — the public row renders identically,
 * just without the controls.
 */
export const entryForRelease = query({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const release = await followMerges(ctx, "releases", await ctx.db.get(releaseId));
    if (!release) return null;

    const entry = await releaseEntryRow(ctx, user._id, release._id);
    const variants = (
      await ctx.db
        .query("releaseVariants")
        .withIndex("by_release", (q) => q.eq("releaseId", release._id))
        .collect()
    )
      .filter((doc) => doc.status === "active")
      .map((doc) => ({ variantId: doc._id, name: doc.name }));

    return {
      releaseId: release._id,
      entry: entry
        ? { state: entry.state, variantId: entry.variantId ?? null }
        : null,
      variants,
      derived: await derivedOwnership(ctx, user._id, release._id),
    };
  },
});

/**
 * The viewer's collection state for one Bundle page. Null when signed out or
 * the Bundle is unknown; otherwise `entry` is the entry or null.
 */
export const entryForBundle = query({
  args: { bundleId: v.id("releaseBundles") },
  handler: async (ctx, { bundleId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const bundle = await followMerges(
      ctx,
      "releaseBundles",
      await ctx.db.get(bundleId),
    );
    if (!bundle) return null;
    const entry = await bundleEntryRow(ctx, user._id, bundle._id);
    return { bundleId: bundle._id, entry: entry ? { state: entry.state } : null };
  },
});

/**
 * How the viewer owns one Volume — exclusively through the owned Releases
 * covering it, direct or derived, since no Volume-ownership state is ever
 * stored (spec §3). Each item names its route: `via` is null for a direct
 * Owned entry and the owning Bundle for Derived Ownership; the same Release
 * appears once per route because the two coexist. Null when signed out or
 * the Volume is unknown.
 */
export const volumeOwnership = query({
  args: { volumePublicId: v.number() },
  handler: async (ctx, { volumePublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const stored = await ctx.db
      .query("volumes")
      .withIndex("by_publicId", (q) => q.eq("publicId", volumePublicId))
      .unique();
    const volume = await followMerges(ctx, "volumes", stored);
    if (!volume) return null;

    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    const owned = [];
    for (const coverage of coverages) {
      const edition = await followMerges(
        ctx,
        "editions",
        await ctx.db.get(coverage.editionId),
      );
      if (!edition) continue;
      const releases = (
        await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect()
      ).filter((doc) => doc.status === "active");
      for (const release of releases) {
        const link = await releaseLink(ctx, release);
        if (!link) continue;
        const direct = await releaseEntryRow(ctx, user._id, release._id);
        if (direct?.state === "owned") {
          owned.push({
            ...link,
            extent: coverage.extent,
            variantName: await variantName(ctx, direct.variantId),
            via: null,
          });
        }
        for (const bundle of await derivedOwnership(ctx, user._id, release._id)) {
          owned.push({
            ...link,
            extent: coverage.extent,
            variantName: bundle.pinnedVariantName,
            via: { bundlePublicId: bundle.bundlePublicId, bundleName: bundle.bundleName },
          });
        }
      }
    }
    return { owned };
  },
});

/**
 * The viewer's whole collection for /me, one item per Collection Entry with
 * its state — the route groups by state. Release entries join their Edition
 * link and pinned Variant; Owned Bundle entries list their member Releases
 * (Derived Ownership, with bundle-pinned Variants) so /me shows what the box
 * set puts on the shelf.
 */
export const myCollection = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;

    const rows = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const entries = [];
    for (const row of rows) {
      if (row.releaseId) {
        const release = await followMerges(
          ctx,
          "releases",
          await ctx.db.get(row.releaseId),
        );
        if (!release) continue;
        const link = await releaseLink(ctx, release);
        if (!link) continue;
        entries.push({
          kind: "release" as const,
          state: row.state,
          releaseId: release._id,
          title: link.editionTitle,
          ...link,
          variantName: await variantName(ctx, row.variantId),
        });
      } else if (row.bundleId) {
        const bundle = await followMerges(
          ctx,
          "releaseBundles",
          await ctx.db.get(row.bundleId),
        );
        if (!bundle) continue;
        // Derived Ownership listing — only an Owned bundle confers it.
        const members = [];
        if (row.state === "owned") {
          const memberships = await ctx.db
            .query("bundleMemberships")
            .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
            .collect();
          memberships.sort((a, b) => a.order - b.order);
          for (const membership of memberships) {
            const release = await followMerges(
              ctx,
              "releases",
              await ctx.db.get(membership.releaseId),
            );
            if (!release) continue;
            const link = await releaseLink(ctx, release);
            if (!link) continue;
            members.push({
              ...link,
              variantName: await variantName(ctx, membership.variantId),
            });
          }
        }
        entries.push({
          kind: "bundle" as const,
          state: row.state,
          bundleId: bundle._id,
          bundlePublicId: bundle.publicId,
          title: bundle.name,
          members,
        });
      }
    }
    entries.sort((a, b) => a.title.localeCompare(b.title));
    return { entries };
  },
});

// ---------- mutations ----------

/**
 * The one write path for a Release's Collection Entry: set the exact state
 * (Wanted | Ordered | Owned — replacing any previous state, so exactly one
 * ever holds) with an optional pinned Variant, or omit `state` to remove the
 * entry. Removal deletes only the direct entry; Derived Ownership is
 * computed, so it is untouchable from here.
 *
 * Inserting a first Collection Entry in a Series returns `suggestFollow`
 * (ticket #29) — a suggestion only; nothing here writes the follow.
 */
export const setReleaseEntry = mutation({
  args: {
    releaseId: v.id("releases"),
    state: v.optional(stateValidator),
    variantId: v.optional(v.id("releaseVariants")),
  },
  handler: async (ctx, { releaseId, state, variantId }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);

    const existing = await releaseEntryRow(ctx, user._id, release._id);
    if (!state) {
      if (existing) await ctx.db.delete(existing._id);
      return { entry: null, suggestFollow: [] };
    }

    if (variantId) {
      const variant = await ctx.db.get(variantId);
      if (!variant || variant.status !== "active" || variant.releaseId !== release._id) {
        throw new ConvexError({
          code: "badVariant",
          message: "That variant does not belong to this release.",
        });
      }
    }

    let suggestFollow: Awaited<ReturnType<typeof followSuggestions>> = [];
    if (existing) {
      // Patching variantId with undefined clears a previously pinned Variant.
      // A state change on an existing entry is never a first entry — no prompt.
      await ctx.db.patch(existing._id, { state, variantId });
    } else {
      const entryId = await ctx.db.insert("collectionEntries", {
        userId: user._id,
        releaseId: release._id,
        state,
        variantId,
      });
      suggestFollow = await followSuggestions(
        ctx,
        user._id,
        (await ctx.db.get(entryId))!,
      );
    }
    return { entry: { state, variantId: variantId ?? null }, suggestFollow };
  },
});

/**
 * The one write path for a Bundle's Collection Entry: set the exact state or
 * omit `state` to remove the entry. Removing an Owned Bundle entry ends its
 * Derived Ownership (it was never stored) and never erases any direct
 * Release entry.
 *
 * Inserting a first Collection Entry in a Series (through the Bundle's
 * member Releases) returns `suggestFollow` (ticket #29) — a suggestion only.
 */
export const setBundleEntry = mutation({
  args: {
    bundleId: v.id("releaseBundles"),
    state: v.optional(stateValidator),
  },
  handler: async (ctx, { bundleId, state }) => {
    const user = await requireUser(ctx);
    const bundle = await requireActiveBundle(ctx, bundleId);

    const existing = await bundleEntryRow(ctx, user._id, bundle._id);
    if (!state) {
      if (existing) await ctx.db.delete(existing._id);
      return { entry: null, suggestFollow: [] };
    }
    let suggestFollow: Awaited<ReturnType<typeof followSuggestions>> = [];
    if (existing) {
      await ctx.db.patch(existing._id, { state });
    } else {
      const entryId = await ctx.db.insert("collectionEntries", {
        userId: user._id,
        bundleId: bundle._id,
        state,
      });
      suggestFollow = await followSuggestions(
        ctx,
        user._id,
        (await ctx.db.get(entryId))!,
      );
    }
    return { entry: { state }, suggestFollow };
  },
});
