// Volume, Edition, and Bundle pages + /isbn resolution (ticket #23, spec §2,
// §10, §11): the rest of the public catalog surface beyond the Series page
// (catalog.ts). One query per page, each returning exactly the joined shape
// its route renders; `isbnLookup` resolves an ISBN to its redirect target.
//
// Every query resolves merged records to their survivor (merged docs keep
// their public ID and point at the winner, spec §8) so the routes can 301,
// and reads hidden records as absent.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { editionTitle, releaseAnchor, volumeTitle } from "./lib/titles";

// ---------- shared resolution & joins ----------

type MergeableTable = "volumes" | "editions" | "releases" | "releaseBundles";

/**
 * Follow a merged record to its surviving record (spec §4/§8), cycle-guarded;
 * hidden records read as absent. Mirrors catalog.ts's resolveActiveSeries.
 * Exported for moderation.ts (revision history resolves the same way).
 */
export async function followMerges<T extends MergeableTable>(
  ctx: QueryCtx,
  // The table name anchors T's inference — `Doc<T>` alone is an indexed
  // access type TypeScript cannot infer backward from.
  _table: T,
  doc: Doc<T> | null,
): Promise<Doc<T> | null> {
  let current = doc;
  const visited = new Set<string>();
  while (current && current.status === "merged" && current.mergedIntoId) {
    if (visited.has(current._id)) return null;
    visited.add(current._id);
    current = (await ctx.db.get(current.mergedIntoId as Id<T>)) as Doc<T> | null;
  }
  return current && current.status === "active" ? current : null;
}

/**
 * An Edition's ordered Volume Coverage joined with each covered Volume and
 * its Series, plus the composed Edition title (lib/titles.ts). Hidden
 * Volumes/Series drop out of the coverage listing. Exported for
 * moderation.ts (edit-form display titles).
 */
export async function editionCoverage(ctx: QueryCtx, edition: Doc<"editions">) {
  const line = edition.editionLineId
    ? await ctx.db.get(edition.editionLineId)
    : null;
  const lineName = line && line.status === "active" ? line.name : null;

  const rows = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
    .collect();
  const coverage = [];
  for (const row of rows) {
    const volume = await ctx.db.get(row.volumeId);
    if (!volume || volume.status !== "active") continue;
    const series = await ctx.db.get(volume.seriesId);
    if (!series || series.status !== "active") continue;
    coverage.push({
      volumePublicId: volume.publicId,
      position: volume.position,
      label: volume.label ?? null,
      // Composed for canonical Volume-page links from coverage listings.
      volumeTitle: volumeTitle(series.title, volume.label ?? null),
      extent: row.extent,
      note: row.note ?? null,
      series: { publicId: series.publicId, title: series.title },
    });
  }

  const title = editionTitle({
    seriesTitle: coverage[0]?.series.title ?? null,
    lineName,
    linePosition: edition.linePosition ?? null,
    covered: coverage.map((c) => ({ label: c.label, position: c.position })),
  });
  return { title, lineName, coverage };
}

/**
 * One Release row as the Edition and Volume pages render it: publication
 * facts with both ISBNs, Variants beneath their Release, and containing
 * Bundles cross-linked (spec §2/§10). `anchor` is the row's fragment on the
 * Edition page — ISBN when present, else document ID (spec §8).
 */
async function releaseRow(ctx: QueryCtx, release: Doc<"releases">) {
  const variants = (
    await ctx.db
      .query("releaseVariants")
      .withIndex("by_release", (q) => q.eq("releaseId", release._id))
      .collect()
  )
    .filter((doc) => doc.status === "active")
    .map((doc) => ({ name: doc.name }));

  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_release", (q) => q.eq("releaseId", release._id))
    .collect();
  const bundles = [];
  for (const membership of memberships) {
    const bundle = await ctx.db.get(membership.bundleId);
    if (!bundle || bundle.status !== "active") continue;
    bundles.push({ publicId: bundle.publicId, name: bundle.name });
  }

  return {
    id: release._id,
    anchor: releaseAnchor(release),
    format: release.format,
    binding: release.binding ?? null,
    language: release.language,
    isbn13: release.isbn13 ?? null,
    isbn10: release.isbn10 ?? null,
    pubDate: release.pubDate ?? null,
    price: release.price ?? null,
    description: release.description ?? null,
    variants,
    bundles,
  };
}

type ReleaseRow = Awaited<ReturnType<typeof releaseRow>>;

const byDate = (a: ReleaseRow, b: ReleaseRow) =>
  (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity);

/** Active Releases of an Edition, joined and date-sorted. */
async function editionReleases(ctx: QueryCtx, editionId: Id<"editions">) {
  const docs = (
    await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .collect()
  ).filter((doc) => doc.status === "active");
  const rows = [];
  for (const doc of docs) rows.push(await releaseRow(ctx, doc));
  return rows.sort(byDate);
}

// ---------- Volume page ----------

/**
 * Everything the Volume page renders (spec §10, ticket #23): every Release
 * covering this Volume grouped under its Edition, each Edition carrying its
 * extent for THIS Volume (`extentForVolume`) so the route lists complete and
 * partial coverage distinctly — including the omnibus case, where the full
 * ordered Coverage shows what else the Edition contains. Canonical Volume
 * numbering (`position`) arrives separately from any Edition Line numbering
 * (`linePosition`); Release rows carry their containing Bundles.
 */
export const volumePage = query({
  args: { publicId: v.number() },
  handler: async (ctx, { publicId }) => {
    const stored = await ctx.db
      .query("volumes")
      .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
      .unique();
    const volume = await followMerges(ctx, "volumes", stored);
    if (!volume) return null;
    const series = await ctx.db.get(volume.seriesId);
    // A hidden Series hides its Volumes from the public site.
    if (!series || series.status !== "active") return null;

    const coveringRows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    const editions = [];
    for (const row of coveringRows) {
      const edition = await ctx.db.get(row.editionId);
      if (!edition || edition.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      const { title, lineName, coverage } = await editionCoverage(ctx, edition);
      editions.push({
        publicId: edition.publicId,
        title,
        publisher:
          publisher && publisher.status === "active"
            ? { name: publisher.name, slug: publisher.slug }
            : null,
        lineName,
        linePosition: edition.linePosition ?? null,
        // This Edition's extent for the page's Volume — the complete/partial
        // grouping key. The full Coverage above shows the omnibus span.
        extentForVolume: row.extent,
        extentNote: row.note ?? null,
        coverage,
        releases: await editionReleases(ctx, edition._id),
      });
    }
    editions.sort((a, b) => a.publicId - b.publicId);

    return {
      volume: {
        publicId: volume.publicId,
        position: volume.position,
        label: volume.label ?? null,
        synopsis: volume.synopsis ?? null,
        title: volumeTitle(series.title, volume.label ?? null),
      },
      series: { publicId: series.publicId, title: series.title },
      editions,
    };
  },
});

// ---------- Edition page ----------

/**
 * The book detail page (spec §2/§10, ticket #23): the Edition's identity
 * (composed title, Publisher, Edition Line membership + Edition Line
 * Position, ordered Volume Coverage with canonical positions kept separate)
 * and its Release rows — differing only in Format/Binding — each with ISBNs,
 * date, Release Description, Variants beneath, and bundle-membership links.
 */
export const editionPage = query({
  args: { publicId: v.number() },
  handler: async (ctx, { publicId }) => {
    const stored = await ctx.db
      .query("editions")
      .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
      .unique();
    const edition = await followMerges(ctx, "editions", stored);
    if (!edition) return null;

    const publisher = await ctx.db.get(edition.publisherId);
    const { title, lineName, coverage } = await editionCoverage(ctx, edition);

    // Distinct Series of the covered Volumes, for breadcrumbs/backlinks.
    const series = [];
    const seen = new Set<number>();
    for (const cov of coverage) {
      if (seen.has(cov.series.publicId)) continue;
      seen.add(cov.series.publicId);
      series.push(cov.series);
    }

    return {
      edition: {
        publicId: edition.publicId,
        title,
        lineName,
        linePosition: edition.linePosition ?? null,
        publisher:
          publisher && publisher.status === "active"
            ? { name: publisher.name, slug: publisher.slug }
            : null,
      },
      series,
      coverage,
      releases: await editionReleases(ctx, edition._id),
    };
  },
});

// ---------- Bundle page ----------

/**
 * The Bundle page (spec §2, ticket #23): the Release Bundle's own publication
 * facts (box-set ISBN, date, price) and its member Releases in order, each
 * linking back to its Edition page anchored at the Release row, with the
 * pinned Release Variant named when the box set specifies one. Members whose
 * Release or Edition is hidden drop out; a merged member follows its
 * survivor.
 */
export const bundlePage = query({
  args: { publicId: v.number() },
  handler: async (ctx, { publicId }) => {
    const stored = await ctx.db
      .query("releaseBundles")
      .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
      .unique();
    const bundle = await followMerges(ctx, "releaseBundles", stored);
    if (!bundle) return null;

    const publisher = await ctx.db.get(bundle.publisherId);
    const memberships = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
      .collect();

    const members = [];
    for (const membership of memberships) {
      const release = await followMerges(
        ctx,
        "releases",
        await ctx.db.get(membership.releaseId),
      );
      if (!release) continue;
      const edition = await followMerges(
        ctx,
        "editions",
        await ctx.db.get(release.editionId),
      );
      if (!edition) continue;
      const { title } = await editionCoverage(ctx, edition);

      let pinnedVariant: { name: string } | null = null;
      if (membership.variantId) {
        const variant = await ctx.db.get(membership.variantId);
        if (variant && variant.status === "active") {
          pinnedVariant = { name: variant.name };
        }
      }

      members.push({
        order: membership.order,
        edition: { publicId: edition.publicId, title },
        anchor: releaseAnchor(release),
        format: release.format,
        binding: release.binding ?? null,
        isbn13: release.isbn13 ?? null,
        pubDate: release.pubDate ?? null,
        pinnedVariant,
      });
    }
    members.sort((a, b) => a.order - b.order);

    return {
      bundle: {
        publicId: bundle.publicId,
        name: bundle.name,
        format: bundle.format ?? null,
        isbn13: bundle.isbn13 ?? null,
        isbn10: bundle.isbn10 ?? null,
        pubDate: bundle.pubDate ?? null,
        price: bundle.price ?? null,
        description: bundle.description ?? null,
        publisher:
          publisher && publisher.status === "active"
            ? { name: publisher.name, slug: publisher.slug }
            : null,
      },
      members,
    };
  },
});

// ---------- /isbn/{isbn} resolution ----------

/**
 * Resolve a normalized ISBN (separators stripped, checksum-verified by the
 * route) to its 301 target (spec §11): a Release match wins any conflict and
 * redirects to the owning Edition anchored at the matching Release row; a
 * box-set ISBN redirects to its Bundle page. Merged records resolve to their
 * survivor — the anchor is the surviving Release's — and hidden records
 * never match. Null means no active match: the route 404s.
 */
export const isbnLookup = query({
  args: { isbn: v.string() },
  handler: async (ctx, { isbn }) => {
    const is13 = isbn.length === 13;

    const releaseDocs = is13
      ? await ctx.db
          .query("releases")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn))
          .collect()
      : await ctx.db
          .query("releases")
          .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn))
          .collect();
    for (const doc of releaseDocs) {
      const release = await followMerges(ctx, "releases", doc);
      if (!release) continue;
      const edition = await followMerges(
        ctx,
        "editions",
        await ctx.db.get(release.editionId),
      );
      if (!edition) continue;
      const { title } = await editionCoverage(ctx, edition);
      return {
        kind: "release" as const,
        edition: { publicId: edition.publicId, title },
        anchor: releaseAnchor(release),
      };
    }

    const bundleDocs = is13
      ? await ctx.db
          .query("releaseBundles")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn))
          .collect()
      : await ctx.db
          .query("releaseBundles")
          .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn))
          .collect();
    for (const doc of bundleDocs) {
      const bundle = await followMerges(ctx, "releaseBundles", doc);
      if (!bundle) continue;
      return {
        kind: "bundle" as const,
        bundle: { publicId: bundle.publicId, name: bundle.name },
      };
    }

    return null;
  },
});
