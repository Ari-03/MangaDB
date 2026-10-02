// Personal collection (ticket #27, spec §3): Wanted / Ordered / Owned
// Collection Entries on Releases and Bundles, variant pinning, computed
// Derived Ownership, the per-Series overlay behind the shelf quick actions,
// batch marking, and the library shelf on /me.
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
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { activeVolumes, resolveActiveSeries } from "./catalog";
import { editionCoverage, publisherLink } from "./catalogPages";
import { followMerges, getActive, requireActive } from "./lib/merges";
import { seriesStateRow } from "./lib/seriesStates";
import { requireUser, viewerOrNull } from "./lib/auth";
import { releaseCover } from "./lib/covers";
import { editionPathKey } from "./lib/editionGroups";
import { releaseAnchor } from "./lib/titles";
import { completelyCoveredVolumes, volumeProgressRow } from "./reading";

/** Batch marking (the library's "Own all") stops here; nobody shelves more in one click. */
export const MANY_ENTRIES_CAP = 200;

// Mirrors the collectionEntries.state union in schema.ts.
const stateValidator = v.union(
  v.literal("wanted"),
  v.literal("ordered"),
  v.literal("owned"),
);

// ---------- shared lookups ----------

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

/**
 * Active, merge-resolved Series covered by one Collection Entry's target.
 * `seriesCache` (raw Series id → resolved Series) lets a pass over a whole
 * collection read each Series once instead of once per entry.
 */
async function entrySeries(
  ctx: QueryCtx,
  entry: Doc<"collectionEntries">,
  seriesCache = new Map<Id<"series">, Doc<"series"> | null>(),
): Promise<Map<Id<"series">, Doc<"series">>> {
  const covered = new Map<Id<"series">, Doc<"series">>();
  const addRelease = async (releaseId: Id<"releases">) => {
    const release = await getActive(ctx, "releases", releaseId);
    if (!release) return;
    for (const seriesId of release.seriesIds) {
      let series = seriesCache.get(seriesId);
      if (series === undefined) {
        series = await getActive(ctx, "series", seriesId);
        seriesCache.set(seriesId, series);
      }
      if (series) covered.set(series._id, series);
    }
  };
  if (entry.releaseId) {
    await addRelease(entry.releaseId);
  } else if (entry.bundleId) {
    const bundle = await getActive(ctx, "releaseBundles", entry.bundleId);
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
 * computed once after *new* entries were inserted (one click, or a whole
 * batch): for each Series the new entries' targets cover, suggest a Series
 * Follow exactly when no older entry of the user covers it (so this is their
 * first Collection Entry in that Series), they are not already following
 * it, and the prompt was never dismissed for it. The collection is read in
 * one pass however many entries are new, so a batch stays linear. The client
 * renders the suggestion; only follows.setSeriesFollow ever creates the
 * follow, and follows.dismissFollowPrompt suppresses it permanently.
 */
async function followSuggestions(
  ctx: QueryCtx,
  userId: Id<"users">,
  newEntryIds: ReadonlySet<Id<"collectionEntries">>,
) {
  if (newEntryIds.size === 0) return [];
  const rows = await ctx.db
    .query("collectionEntries")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const seriesCache = new Map<Id<"series">, Doc<"series"> | null>();

  const target = new Map<Id<"series">, Doc<"series">>();
  for (const row of rows) {
    if (!newEntryIds.has(row._id)) continue;
    for (const [seriesId, series] of await entrySeries(ctx, row, seriesCache)) {
      target.set(seriesId, series);
    }
  }
  if (target.size === 0) return [];

  const alreadyCovered = new Set<Id<"series">>();
  for (const row of rows) {
    if (newEntryIds.has(row._id)) continue;
    for (const seriesId of (await entrySeries(ctx, row, seriesCache)).keys()) {
      if (target.has(seriesId)) alreadyCovered.add(seriesId);
    }
    if (alreadyCovered.size === target.size) return []; // every Series already collected
  }

  const suggestions = [];
  for (const [seriesId, series] of target) {
    if (alreadyCovered.has(seriesId)) continue;
    const state = await seriesStateRow(ctx, userId, seriesId);
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
    const bundle = await getActive(ctx, "releaseBundles", membership.bundleId);
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
  const edition = await getActive(ctx, "editions", release.editionId);
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
    const release = await getActive(ctx, "releases", releaseId);
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
    const bundle = await getActive(ctx, "releaseBundles", bundleId);
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
      const edition = await getActive(ctx, "editions", coverage.editionId);
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
 * The viewer's collection picture inside one Series, for the shelf overlay
 * on the Series page and the library's path shelves: every direct entry on a
 * Release of the Series (state + pinned Variant) and every Release owned
 * through an Owned Bundle (Derived Ownership, computed here as always), plus
 * the format preference the quick actions use to pick a Release when a book
 * has several. Null when signed out, username pending, or the Series is
 * unknown — the public shelf renders without badges or actions.
 */
export const seriesEntries = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    if (!series) return null;

    const inSeries = async (release: Doc<"releases">) => {
      for (const rawId of release.seriesIds) {
        if (rawId === series._id) return true;
        const resolved = await getActive(ctx, "series", rawId);
        if (resolved && resolved._id === series._id) return true;
      }
      return false;
    };

    const rows = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const entries = [];
    const derivedOwned = new Set<Id<"releases">>();
    for (const row of rows) {
      if (row.releaseId) {
        const release = await getActive(ctx, "releases", row.releaseId);
        if (!release || !(await inSeries(release))) continue;
        entries.push({
          releaseId: release._id,
          state: row.state,
          variantId: row.variantId ?? null,
        });
      } else if (row.bundleId && row.state === "owned") {
        const bundle = await getActive(ctx, "releaseBundles", row.bundleId);
        if (!bundle) continue;
        const memberships = await ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
          .collect();
        for (const membership of memberships) {
          const release = await getActive(ctx, "releases", membership.releaseId);
          if (release && (await inSeries(release))) derivedOwned.add(release._id);
        }
      }
    }
    return {
      seriesId: series._id,
      formatPreference: user.formatPreference,
      entries,
      derivedOwned: [...derivedOwned],
    };
  },
});

/** Whether every completely covered Volume of an Edition has a completed read. */
async function editionRead(
  ctx: QueryCtx,
  userId: Id<"users">,
  editionId: Id<"editions">,
): Promise<boolean | null> {
  const volumes = await completelyCoveredVolumes(ctx, editionId);
  // A book covering nothing completely (a split, or coverage not yet mapped)
  // has no read state to show.
  if (volumes.length === 0) return null;
  for (const volume of volumes) {
    const progress = await volumeProgressRow(ctx, userId, volume._id);
    if (!progress || progress.readCount < 1) return false;
  }
  return true;
}

/**
 * One shelved book for the library: the Release's Edition joined with the
 * facts the shelf shows (title, line numbering, covered Volumes, cover) and
 * the reading-path key it belongs to on its Series page.
 */
async function libraryBook(
  ctx: QueryCtx,
  userId: Id<"users">,
  release: Doc<"releases">,
) {
  const edition = await getActive(ctx, "editions", release.editionId);
  if (!edition) return null;
  const { title, lineName, coverage, series } = await editionCoverage(ctx, edition);
  if (!series) return null; // nothing to shelve it under (no coverage and no line)
  const publisher = publisherLink(await ctx.db.get(edition.publisherId));
  return {
    series,
    pathKey: editionPathKey({ publisher, lineName }),
    pathName: lineName ?? "Standard edition",
    pathKind: lineName === null ? ("standard" as const) : ("line" as const),
    publisher,
    editionLineId: edition.editionLineId ?? null,
    book: {
      releaseId: release._id,
      editionPublicId: edition.publicId,
      title,
      lineName,
      linePosition: edition.linePosition ?? null,
      coverage: coverage.map((cov) => ({
        volumePublicId: cov.volumePublicId,
        position: cov.position,
        label: cov.label,
        extent: cov.extent,
      })),
      anchor: releaseAnchor(release),
      format: release.format,
      binding: release.binding ?? null,
      ...(await releaseCover(ctx, release)),
      read: await editionRead(ctx, userId, edition._id),
    },
  };
}

type LibraryBook = NonNullable<Awaited<ReturnType<typeof libraryBook>>>["book"] & {
  state: Doc<"collectionEntries">["state"];
  variantName: string | null;
  /** True when a direct Collection Entry holds this state. */
  direct: boolean;
  /** The box set that also puts it on the shelf (Derived Ownership), if any. */
  via: { bundlePublicId: number; bundleName: string } | null;
};

/**
 * The viewer's library shelf for /me: every Collection Entry shelved under
 * its Series and reading path — "Berserk › Deluxe Edition: 2 of 14 books" —
 * so ownership reads at the edition level, with each path's full size on
 * hand for the "own the rest" affordance. An Owned box set puts its members
 * on the shelf as Derived Ownership (`via` names the box set) and is listed
 * once more under `bundles`; Wanted/Ordered box sets are listed there only.
 *
 * Path size: an Edition Line's active Editions, or the Series' active Volume
 * count for a standard run (one book per Volume is the norm; the expanded
 * shelf shows the real books either way). Series wear the library cover
 * from seriesStats when the rebuild has stored one.
 */
export const myLibrary = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;

    const rows = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    type Path = {
      key: string;
      name: string;
      kind: "standard" | "line";
      publisher: { name: string; slug: string } | null;
      editionLineId: Id<"editionLines"> | null;
      books: LibraryBook[];
    };
    type SeriesShelf = {
      seriesPublicId: number;
      title: string;
      paths: Map<string, Path>;
    };
    const shelves = new Map<number, SeriesShelf>();
    const bundles = [];

    const shelve = async (
      release: Doc<"releases">,
      state: Doc<"collectionEntries">["state"],
      variantId: Id<"releaseVariants"> | undefined,
      via: LibraryBook["via"],
    ) => {
      const joined = await libraryBook(ctx, user._id, release);
      if (!joined) return;
      const shelf = shelves.get(joined.series.publicId) ?? {
        seriesPublicId: joined.series.publicId,
        title: joined.series.title,
        paths: new Map<string, Path>(),
      };
      shelves.set(shelf.seriesPublicId, shelf);
      const path = shelf.paths.get(joined.pathKey) ?? {
        key: joined.pathKey,
        name: joined.pathName,
        kind: joined.pathKind,
        publisher: joined.publisher,
        editionLineId: joined.editionLineId,
        books: [],
      };
      shelf.paths.set(path.key, path);
      // Direct ownership and Derived Ownership coexist on one book: it is
      // shelved once, the direct entry's state winning, the box set named.
      const existing = path.books.find((book) => book.releaseId === release._id);
      if (existing) {
        if (via) existing.via = via;
        else {
          existing.state = state;
          existing.direct = true;
          existing.variantName = await variantName(ctx, variantId);
        }
        return;
      }
      path.books.push({
        ...joined.book,
        state,
        variantName: await variantName(ctx, variantId),
        direct: via === null,
        via,
      });
    };

    for (const row of rows) {
      if (row.releaseId) {
        const release = await getActive(ctx, "releases", row.releaseId);
        if (!release) continue;
        await shelve(release, row.state, row.variantId, null);
      } else if (row.bundleId) {
        const bundle = await getActive(ctx, "releaseBundles", row.bundleId);
        if (!bundle) continue;
        const memberships = await ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
          .collect();
        memberships.sort((a, b) => a.order - b.order);
        const via = { bundlePublicId: bundle.publicId, bundleName: bundle.name };
        // Only an Owned box set confers Derived Ownership on its members.
        if (row.state === "owned") {
          for (const membership of memberships) {
            const release = await getActive(ctx, "releases", membership.releaseId);
            if (!release) continue;
            await shelve(release, "owned", membership.variantId, via);
          }
        }
        bundles.push({
          state: row.state,
          bundleId: bundle._id,
          bundlePublicId: bundle.publicId,
          title: bundle.name,
          format: bundle.format ?? null,
          memberCount: memberships.length,
          coverIsbn: bundle.isbn13 ?? null,
        });
      }
    }

    const series = [];
    for (const shelf of shelves.values()) {
      const stats = await ctx.db
        .query("seriesStats")
        .withIndex("by_publicId", (q) => q.eq("publicId", shelf.seriesPublicId))
        .unique();
      let volumeCount = stats?.volumeCount ?? null;
      const paths = [];
      for (const path of shelf.paths.values()) {
        let bookCount: number | null = null;
        if (path.editionLineId) {
          const members = await ctx.db
            .query("editions")
            .withIndex("by_line", (q) => q.eq("editionLineId", path.editionLineId!))
            .collect();
          bookCount = members.filter((doc) => doc.status === "active").length;
        } else {
          if (volumeCount === null) {
            const seriesDoc = await resolveActiveSeries(ctx, shelf.seriesPublicId);
            if (seriesDoc) volumeCount = (await activeVolumes(ctx, seriesDoc._id)).length;
          }
          bookCount = volumeCount;
        }
        const position = (book: LibraryBook) => {
          const line = Number(book.linePosition);
          if (book.linePosition !== null && Number.isFinite(line)) return line;
          return book.coverage[0]?.position ?? Infinity;
        };
        path.books.sort((a, b) => position(a) - position(b) || a.title.localeCompare(b.title));
        paths.push({
          key: path.key,
          name: path.name,
          kind: path.kind,
          publisher: path.publisher,
          bookCount,
          books: path.books,
        });
      }
      paths.sort(
        (a, b) =>
          (a.kind === "line" ? 1 : 0) - (b.kind === "line" ? 1 : 0) ||
          a.name.localeCompare(b.name),
      );
      series.push({
        seriesPublicId: shelf.seriesPublicId,
        title: shelf.title,
        coverUrl: stats?.coverUrl ?? paths[0]?.books[0]?.coverUrl ?? null,
        coverIsbn: stats?.coverIsbn ?? paths[0]?.books[0]?.coverIsbns[0] ?? null,
        paths,
      });
    }
    series.sort((a, b) => a.title.localeCompare(b.title));
    bundles.sort((a, b) => a.title.localeCompare(b.title));
    return { series, bundles };
  },
});

// ---------- mutations ----------

/**
 * The Collection Entry write for one Release, shared by the single and batch
 * mutations: set the exact state (Wanted | Ordered | Owned — replacing any
 * previous state, so exactly one ever holds) with an optional pinned
 * Variant, or pass no state to remove the entry. `variant` is the Variant to
 * pin (undefined clears the pin) or "keep" to leave an existing entry's pin
 * untouched. Only a newly selected pin must be an active Variant of this
 * Release; a pin the entry already holds is kept even if the Variant was
 * hidden since, so a state change never fails on it. Removal deletes only
 * the direct entry; Derived Ownership is computed, so it is untouchable from
 * here. Returns the inserted entry's id when this was a new entry, for the
 * caller to compute follow suggestions (ticket #29) once.
 */
async function writeReleaseEntry(
  ctx: MutationCtx,
  user: Doc<"users">,
  releaseId: Id<"releases">,
  state: Doc<"collectionEntries">["state"] | undefined,
  variant: Id<"releaseVariants"> | undefined | "keep",
) {
  const release = await requireActive(ctx, "releases", releaseId, "Release");
  const existing = await releaseEntryRow(ctx, user._id, release._id);
  if (!state) {
    if (existing) await ctx.db.delete(existing._id);
    return { entry: null, insertedId: null };
  }

  if (variant && variant !== "keep" && variant !== existing?.variantId) {
    const doc = await ctx.db.get(variant);
    if (!doc || doc.status !== "active" || doc.releaseId !== release._id) {
      throw new ConvexError({
        code: "badVariant",
        message: "That variant does not belong to this release.",
      });
    }
  }

  if (existing) {
    // Patching variantId with undefined clears a previously pinned Variant.
    // A state change on an existing entry is never a first entry — no prompt.
    await ctx.db.patch(
      existing._id,
      variant === "keep" ? { state } : { state, variantId: variant },
    );
    const variantId = variant === "keep" ? existing.variantId : variant;
    return { entry: { state, variantId: variantId ?? null }, insertedId: null };
  }
  const variantId = variant === "keep" ? undefined : variant;
  const insertedId = await ctx.db.insert("collectionEntries", {
    userId: user._id,
    releaseId: release._id,
    state,
    variantId,
  });
  return { entry: { state, variantId: variantId ?? null }, insertedId };
}

/**
 * The one write path for a Release's Collection Entry (see
 * writeReleaseEntry): set the exact state with an optional pinned Variant, or
 * omit `state` to remove the entry. A first entry in a Series returns
 * `suggestFollow` (ticket #29) — a suggestion only.
 */
export const setReleaseEntry = mutation({
  args: {
    releaseId: v.id("releases"),
    state: v.optional(stateValidator),
    variantId: v.optional(v.id("releaseVariants")),
  },
  handler: async (ctx, { releaseId, state, variantId }) => {
    const user = await requireUser(ctx);
    const { entry, insertedId } = await writeReleaseEntry(
      ctx,
      user,
      releaseId,
      state,
      variantId,
    );
    const suggestFollow = await followSuggestions(
      ctx,
      user._id,
      new Set(insertedId ? [insertedId] : []),
    );
    return { entry, suggestFollow };
  },
});

/**
 * The same write for many Releases at once — the library's "Own the rest"
 * and the Series page's whole-path marking. Each Release gets exactly the
 * state given (or its entry removed when `state` is omitted), through the
 * same rules as one click; pinned Variants are left as they were on entries
 * that already exist. Follow suggestions are computed once over all the new
 * entries, so a first entry in a Series still prompts once and the batch's
 * reads stay linear in the collection. Capped at MANY_ENTRIES_CAP.
 */
export const setManyReleaseEntries = mutation({
  args: {
    releaseIds: v.array(v.id("releases")),
    state: v.optional(stateValidator),
  },
  handler: async (ctx, { releaseIds, state }) => {
    const user = await requireUser(ctx);
    if (releaseIds.length > MANY_ENTRIES_CAP) {
      throw new ConvexError({
        code: "tooMany",
        message: `Mark at most ${MANY_ENTRIES_CAP} releases at once.`,
      });
    }
    const inserted = new Set<Id<"collectionEntries">>();
    let changed = 0;
    for (const releaseId of new Set(releaseIds)) {
      const { insertedId } = await writeReleaseEntry(ctx, user, releaseId, state, "keep");
      if (insertedId) inserted.add(insertedId);
      changed += 1;
    }
    return { changed, suggestFollow: await followSuggestions(ctx, user._id, inserted) };
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
    const bundle = await requireActive(ctx, "releaseBundles", bundleId, "Bundle");

    const existing = await bundleEntryRow(ctx, user._id, bundle._id);
    if (!state) {
      if (existing) await ctx.db.delete(existing._id);
      return { entry: null, suggestFollow: [] };
    }
    if (existing) {
      await ctx.db.patch(existing._id, { state });
      return { entry: { state }, suggestFollow: [] };
    }
    const entryId = await ctx.db.insert("collectionEntries", {
      userId: user._id,
      bundleId: bundle._id,
      state,
    });
    return {
      entry: { state },
      suggestFollow: await followSuggestions(ctx, user._id, new Set([entryId])),
    };
  },
});
