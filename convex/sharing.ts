// Tracking visibility + public profiles (ticket #30, spec §3): personal
// tracking is private by default, with separate visibility defaults for
// Ownership and Reading (on the User) plus per-Series overrides (on
// userSeriesStates). `/u/{username}` is a current-state public profile.
//
// The invariants, straight from the glossary (CONTEXT.md):
// - Tracking Visibility is a private-by-default sharing policy with separate
//   defaults for Ownership and Reading and per-Series overrides — never
//   configured for individual Volumes or Releases.
// - Public Ownership shows Owned Releases, selected Variants, Bundles, and
//   derived member ownership — never Wanted/Ordered entries.
// - Public Reading shows Series Reading Status, active Release percentage,
//   and Volume read counts.
// - Series Follows always stay private in v1: nothing here ever reads or
//   returns the following/followPromptDismissed fields.
// - The profile is current-state only — no activity feed, no timestamps.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { resolveActiveSeries } from "./catalog";
import { followMerges } from "./catalogPages";
import { releaseLink, variantName } from "./collection";
import { requireUser, viewerOrNull } from "./lib/auth";
import { normalizeUsername } from "./lib/usernames";
import { requireActiveSeries } from "./reading";

// Mirrors the visibility union in schema.ts.
const visibilityValidator = v.union(v.literal("public"), v.literal("private"));
// The two independently configured tracking surfaces (spec §3).
const kindValidator = v.union(v.literal("ownership"), v.literal("reading"));

type Visibility = "public" | "private";
type Kind = "ownership" | "reading";

// ---------- effective-visibility resolution ----------

/**
 * The per-Series override map for one user, keyed by the Series the row was
 * written against. Only the two visibility fields leave this module — the
 * same rows carry Follows, which stay private in v1.
 */
async function overrideMap(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("userSeriesStates")
    .withIndex("by_user_series", (q) => q.eq("userId", userId))
    .collect();
  return new Map(rows.map((row) => [row.seriesId, row]));
}

/** Override wins over the default; no override means the default applies. */
function effectiveVisibility(
  user: Doc<"users">,
  overrides: Map<Id<"series">, Doc<"userSeriesStates">>,
  kind: Kind,
  seriesId: Id<"series">,
): Visibility {
  const override =
    kind === "ownership"
      ? overrides.get(seriesId)?.ownershipVisibility
      : overrides.get(seriesId)?.readingVisibility;
  return (
    override ??
    (kind === "ownership" ? user.ownershipVisibility : user.readingVisibility)
  );
}

/** The surviving identities of a Release's covered Series, deduplicated. */
async function resolvedSeriesIds(
  ctx: QueryCtx,
  raw: Array<Id<"series">>,
): Promise<Array<Id<"series">>> {
  const out = new Set<Id<"series">>();
  for (const id of raw) {
    const series = await followMerges(ctx, "series", await ctx.db.get(id));
    // A hidden Series keeps its override reachable under the stored id, so
    // the user's per-Series choice still governs entries that point at it.
    out.add(series ? series._id : id);
  }
  return [...out];
}

/**
 * Whether a Release-shaped record is publicly visible for one surface: every
 * covered Series must be effectively public — one private Series hides the
 * whole entry, because showing it would reveal tracking of that Series. A
 * Release with no coverage has no Series to override, so the default alone
 * governs it.
 */
async function seriesAllPublic(
  ctx: QueryCtx,
  user: Doc<"users">,
  overrides: Map<Id<"series">, Doc<"userSeriesStates">>,
  kind: Kind,
  rawSeriesIds: Array<Id<"series">>,
): Promise<boolean> {
  const ids = await resolvedSeriesIds(ctx, rawSeriesIds);
  if (ids.length === 0) {
    return (
      (kind === "ownership" ? user.ownershipVisibility : user.readingVisibility) ===
      "public"
    );
  }
  return ids.every(
    (id) => effectiveVisibility(user, overrides, kind, id) === "public",
  );
}

// ---------- mutations ----------

/**
 * Set one of the viewer's two visibility defaults (spec §3: Ownership and
 * Reading are configured separately). Both start private at account creation
 * (users.claimUsername); making either public is always this explicit choice.
 */
export const setDefaultVisibility = mutation({
  args: { kind: kindValidator, visibility: visibilityValidator },
  handler: async (ctx, { kind, visibility }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(
      user._id,
      kind === "ownership"
        ? { ownershipVisibility: visibility }
        : { readingVisibility: visibility },
    );
    return { kind, visibility };
  },
});

/**
 * Set (or clear, with "default") the viewer's per-Series visibility override
 * for one surface. Overrides live on the per-user-per-series state row; a row
 * is created on first override and the other per-series facts are untouched.
 */
export const setSeriesVisibility = mutation({
  args: {
    seriesId: v.id("series"),
    kind: kindValidator,
    visibility: v.union(visibilityValidator, v.literal("default")),
  },
  handler: async (ctx, { seriesId, kind, visibility }) => {
    const user = await requireUser(ctx);
    const series = await requireActiveSeries(ctx, seriesId);
    const override = visibility === "default" ? undefined : visibility;
    const patch =
      kind === "ownership"
        ? { ownershipVisibility: override }
        : { readingVisibility: override };

    const state = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) =>
        q.eq("userId", user._id).eq("seriesId", series._id),
      )
      .unique();
    if (state) {
      // Patching with undefined clears the override back to the default.
      await ctx.db.patch(state._id, patch);
    } else if (override) {
      await ctx.db.insert("userSeriesStates", {
        userId: user._id,
        seriesId: series._id,
        following: false,
        followPromptDismissed: false,
        ...patch,
      });
    }
    return { kind, visibility };
  },
});

// ---------- queries ----------

/**
 * The viewer's visibility picture for one Series page: both defaults and both
 * overrides, plus the username for the "view your profile" link. Null when
 * signed out, username pending, or the Series is unknown — the public page
 * renders identically without the sharing controls.
 */
export const seriesVisibility = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    if (!series) return null;

    const state = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) =>
        q.eq("userId", user._id).eq("seriesId", series._id),
      )
      .unique();
    return {
      seriesId: series._id,
      username: user.username,
      defaults: {
        ownership: user.ownershipVisibility,
        reading: user.readingVisibility,
      },
      overrides: {
        ownership: state?.ownershipVisibility ?? null,
        reading: state?.readingVisibility ?? null,
      },
    };
  },
});

/**
 * The current-state public profile behind `/u/{username}` (spec §3/§11): a
 * public read — no auth — showing exactly what the owner's visibility allows.
 *
 * - Ownership: Owned Release entries (with the selected Variant) and Owned
 *   Bundles with their derived member ownership. Wanted/Ordered entries are
 *   filtered before anything else is considered — they are never exposed at
 *   any visibility.
 * - Reading: per-Series rows with the Series Reading Status, per-Volume read
 *   counts, and active passes with their percentage.
 * - Follows are never read into the result. No activity feed: every item is
 *   present state, never an event.
 *
 * Null when no such user exists. A fully private profile returns empty
 * sections — the page exists (public-but-noindex) but shares nothing.
 */
export const publicProfile = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) =>
        q.eq("usernameNormalized", normalizeUsername(username)),
      )
      .unique();
    if (!user) return null;
    const overrides = await overrideMap(ctx, user._id);
    const ownershipPublic = (ids: Array<Id<"series">>) =>
      seriesAllPublic(ctx, user, overrides, "ownership", ids);

    // ----- public Ownership -----

    const entries = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const releases = [];
    const bundles = [];
    for (const row of entries) {
      // Wanted/Ordered never appear on a profile, whatever the visibility.
      if (row.state !== "owned") continue;
      if (row.releaseId) {
        const release = await followMerges(
          ctx,
          "releases",
          await ctx.db.get(row.releaseId),
        );
        if (!release || !(await ownershipPublic(release.seriesIds))) continue;
        const link = await releaseLink(ctx, release);
        if (!link) continue;
        releases.push({
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
        const memberships = await ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
          .collect();
        memberships.sort((a, b) => a.order - b.order);
        // Derived member ownership shows with the Bundle; one member whose
        // Series is private hides the whole box set (it would reveal that
        // Series either way).
        let allPublic = true;
        let checkedAny = false;
        const members = [];
        for (const membership of memberships) {
          const release = await followMerges(
            ctx,
            "releases",
            await ctx.db.get(membership.releaseId),
          );
          if (!release) continue;
          checkedAny = true;
          if (!(await ownershipPublic(release.seriesIds))) {
            allPublic = false;
            break;
          }
          const link = await releaseLink(ctx, release);
          if (!link) continue;
          members.push({
            ...link,
            variantName: await variantName(ctx, membership.variantId),
          });
        }
        if (!allPublic) continue;
        // A Bundle whose members carry no Series signal (memberless, or every
        // member hidden) has nothing to override; the default alone governs.
        if (!checkedAny && user.ownershipVisibility !== "public") continue;
        bundles.push({
          bundlePublicId: bundle.publicId,
          name: bundle.name,
          members,
        });
      }
    }
    releases.sort((a, b) => a.editionTitle.localeCompare(b.editionTitle));
    bundles.sort((a, b) => a.name.localeCompare(b.name));

    // ----- public Reading -----

    // One row per effectively-public Series the user has any reading state
    // in: a chosen status, read Volumes, or an active pass.
    type ReadingRow = {
      seriesPublicId: number;
      title: string;
      readingStatus: NonNullable<Doc<"userSeriesStates">["readingStatus"]> | null;
      totalVolumes: number;
      readVolumes: Array<{
        volumePublicId: number;
        label: string | null;
        position: number;
        readCount: number;
      }>;
      passes: Array<{
        editionPublicId: number;
        editionTitle: string;
        anchor: string;
        format: "physical" | "digital";
        binding: string | null;
        percent: number | null;
      }>;
    };
    const readingRows = new Map<Id<"series">, ReadingRow>();

    const readingRowFor = async (
      rawSeriesId: Id<"series">,
    ): Promise<ReadingRow | null> => {
      const series = await followMerges(
        ctx,
        "series",
        await ctx.db.get(rawSeriesId),
      );
      if (!series) return null;
      if (
        effectiveVisibility(user, overrides, "reading", series._id) !== "public"
      ) {
        return null;
      }
      const existing = readingRows.get(series._id);
      if (existing) return existing;
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .collect();
      const row: ReadingRow = {
        seriesPublicId: series.publicId,
        title: series.title,
        readingStatus: null,
        totalVolumes: volumes.filter((volume) => volume.status === "active")
          .length,
        readVolumes: [],
        passes: [],
      };
      readingRows.set(series._id, row);
      return row;
    };

    // Series Reading Status — only the status leaves the state row; the
    // Follow fields on the same row stay private (v1).
    for (const state of overrides.values()) {
      if (!state.readingStatus) continue;
      const row = await readingRowFor(state.seriesId);
      if (row) row.readingStatus = state.readingStatus;
    }

    // Volume read counts.
    const volumeRows = await ctx.db
      .query("volumeProgress")
      .withIndex("by_user_volume", (q) => q.eq("userId", user._id))
      .collect();
    for (const progress of volumeRows) {
      if (progress.readCount < 1) continue;
      const volume = await followMerges(
        ctx,
        "volumes",
        await ctx.db.get(progress.volumeId),
      );
      if (!volume) continue;
      const row = await readingRowFor(volume.seriesId);
      if (!row) continue;
      row.readVolumes.push({
        volumePublicId: volume.publicId,
        label: volume.label ?? null,
        position: volume.position,
        readCount: progress.readCount,
      });
    }

    // Active passes with their percentage. Like Ownership, a Release covering
    // any effectively-private Series stays off the profile entirely.
    const passRows = await ctx.db
      .query("releaseProgress")
      .withIndex("by_user_release", (q) => q.eq("userId", user._id))
      .collect();
    for (const pass of passRows) {
      const release = await followMerges(
        ctx,
        "releases",
        await ctx.db.get(pass.releaseId),
      );
      if (!release) continue;
      if (
        !(await seriesAllPublic(ctx, user, overrides, "reading", release.seriesIds))
      ) {
        continue;
      }
      const row = await readingRowFor(pass.seriesId);
      if (!row) continue;
      const link = await releaseLink(ctx, release);
      if (!link) continue;
      row.passes.push({ ...link, percent: pass.percent ?? null });
    }

    const reading = [...readingRows.values()].filter(
      (row) =>
        row.readingStatus !== null ||
        row.readVolumes.length > 0 ||
        row.passes.length > 0,
    );
    for (const row of reading) {
      row.readVolumes.sort((a, b) => a.position - b.position);
      row.passes.sort((a, b) => a.editionTitle.localeCompare(b.editionTitle));
    }
    reading.sort((a, b) => a.title.localeCompare(b.title));

    return {
      username: user.username,
      ownership: { releases, bundles },
      reading,
    };
  },
});
