// Volume, Edition, and Bundle pages + /isbn resolution (ticket #23, spec §2,
// §10, §11): the rest of the public catalog surface beyond the Series page
// (catalog.ts). One query per page, each returning exactly the joined shape
// its route renders; `isbnLookup` resolves an ISBN to its redirect target.
//
// Every query resolves merged records to their survivor (merged docs keep
// their public ID and point at the winner, spec §8) so the routes can 301,
// and reads hidden records as absent. Maturity is the exception: it is the
// content's, so hidden parts of a book or box set still count toward it.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { editionTitle, releaseAnchor, volumeTitle } from "./lib/titles";
import { coverUrl, jacketCache } from "./lib/covers";
import { creditsFor } from "./people";

// ---------- shared resolution & joins ----------

/** `creditsFor` a Series known by its public ID. */
async function creditsForPublicId(ctx: QueryCtx, publicId: number) {
  const series = await ctx.db
    .query("series")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  return series ? await creditsFor(ctx, series._id) : [];
}

type MergeableTable =
  | "publishers"
  | "series"
  | "volumes"
  | "editionLines"
  | "editions"
  | "releases"
  | "releaseBundles";

/**
 * The record a merge chain ends at, whatever its status (spec §4/§8),
 * cycle-guarded. Maturity reads content through this rather than
 * `followMerges`, so hiding a record never makes what it holds general.
 */
async function mergeSurvivor<T extends MergeableTable>(
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
  return current;
}

/**
 * Follow a merged record to its surviving record (spec §4/§8), cycle-guarded;
 * hidden records read as absent. Mirrors catalog.ts's resolveActiveSeries.
 * Exported for moderation.ts (revision history resolves the same way) and
 * reading.ts (tracking mutations follow merges before touching state).
 */
export async function followMerges<T extends MergeableTable>(
  ctx: QueryCtx,
  table: T,
  doc: Doc<T> | null,
): Promise<Doc<T> | null> {
  const survivor = await mergeSurvivor(ctx, table, doc);
  return survivor && survivor.status === "active" ? survivor : null;
}

/** An Edition's Volume Coverage rows in `order` (the index sorts them). */
function coverageRows(ctx: QueryCtx, editionId: Id<"editions">) {
  return ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

/** A coverage row's Volume and its Series, or null when either is not active. */
async function activeCoveredVolume(ctx: QueryCtx, row: Doc<"volumeCoverages">) {
  const volume = await ctx.db.get(row.volumeId);
  if (!volume || volume.status !== "active") return null;
  const series = await ctx.db.get(volume.seriesId);
  if (!series || series.status !== "active") return null;
  return { volume, series };
}

/**
 * An Edition's Series as ratings and favorites key it: the Series of its
 * first covered Volume in coverage order, hidden Volumes and Series skipped.
 * `editionCoverage` reports the same Series as `series` for a mapped
 * Edition (its coverage listing walks the same rows the same way).
 * Exported for the Edition merge's Favorite denorm (lib/sensitiveOps.ts).
 */
export async function primaryVolumeSeries(
  ctx: QueryCtx,
  editionId: Id<"editions">,
): Promise<Doc<"series"> | null> {
  for (const row of await coverageRows(ctx, editionId)) {
    const found = await activeCoveredVolume(ctx, row);
    if (found) return found.series;
  }
  return null;
}

/**
 * An Edition's ordered Volume Coverage joined with each covered Volume and
 * its Series, plus the composed Edition title (lib/titles.ts). Hidden
 * Volumes/Series drop out of the coverage listing; `volumeCount` and
 * `mature` still count them, and `mature` also counts a hidden Edition Line
 * or line Series. Exported for moderation.ts (edit-form display titles).
 */
export async function editionCoverage(ctx: QueryCtx, edition: Doc<"editions">) {
  const storedLine = edition.editionLineId
    ? await ctx.db.get(edition.editionLineId)
    : null;
  const line = storedLine && storedLine.status === "active" ? storedLine : null;
  const lineName = line?.name ?? null;

  // Maturity is the content's (B34, R15), judged through merges and before
  // any hiding: the Edition Line's Series and every covered Volume's Series
  // count though hidden Volumes, Series and lines drop out of the listing.
  const contentLine = await mergeSurvivor(ctx, "editionLines", storedLine);
  const storedLineSeries = contentLine ? await ctx.db.get(contentLine.seriesId) : null;
  let collectsMature = (await mergeSurvivor(ctx, "series", storedLineSeries))?.mature === true;

  const rows = await coverageRows(ctx, edition._id);
  const coverage = [];
  for (const row of rows) {
    const volume = await ctx.db.get(row.volumeId);
    const survivor = await mergeSurvivor(ctx, "volumes", volume);
    const series = survivor ? await ctx.db.get(survivor.seriesId) : null;
    if ((await mergeSurvivor(ctx, "series", series))?.mature === true) collectsMature = true;
    // Listed only while the Volume itself (its own survivor) and its Series are active.
    if (!volume || volume.status !== "active" || !series || series.status !== "active") continue;
    coverage.push({
      volumePublicId: volume.publicId,
      position: volume.position,
      label: volume.label ?? null,
      // Composed for canonical Volume-page links from coverage listings.
      volumeTitle: volumeTitle(series.title, volume.label ?? null),
      extent: row.extent,
      note: row.note ?? null,
      series: { publicId: series.publicId, title: series.title, mature: series.mature === true },
    });
  }

  // The first listed Volume's Series is primaryVolumeSeries; Unmapped
  // Packaging covers nothing yet, so its Series is its line's (an active
  // line is its own survivor, so storedLineSeries is its Series as stored).
  const lineSeries = coverage.length === 0 && line ? storedLineSeries : null;
  const series =
    coverage[0]?.series ??
    (lineSeries && lineSeries.status === "active"
      ? { publicId: lineSeries.publicId, title: lineSeries.title, mature: lineSeries.mature === true }
      : null);
  const title = editionTitle({
    seriesTitle: series?.title ?? null,
    lineName,
    linePosition: edition.linePosition ?? null,
    covered: coverage.map((c) => ({ label: c.label, position: c.position })),
  });
  return {
    title,
    lineName,
    coverage,
    /** The Edition's Series: primaryVolumeSeries's, else its line's. */
    series,
    /**
     * Distinct Volumes the coverage names, hidden ones included: whether the
     * book is an omnibus does not change while a Volume is hidden.
     */
    volumeCount: new Set(rows.map((row) => row.volumeId)).size,
    /**
     * It collects any Mature Series or sits in one's Edition Line
     * (lib/mature.ts), judged through merges and before hiding: hiding a
     * covered Volume, a Series or the line does not make the book general.
     */
    mature: collectsMature,
    coverageUnmapped: edition.coverageUnmapped === true,
  };
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
    coverUrl: await coverUrl(ctx, release.coverImage?.storageId),
    variants,
    bundles,
  };
}

/**
 * The Volume page's representative cover (spec §8: picked at query time),
 * fronting the cover-led OG/Twitter card (spec §11): the first date-sorted
 * Release row carrying one. The Edition page's is its jacket's `coverUrl`
 * (lib/covers.ts), picked by the same rule.
 */
function representativeCover(rows: Array<{ coverUrl: string | null }>) {
  return rows.find((row) => row.coverUrl !== null)?.coverUrl ?? null;
}

/** Releases `editionCover` reads per Edition, bounding the library's cost per Favorite. */
const COVER_RELEASES = 10;

/**
 * An Edition's jacket without its full Release rows (the library's
 * Favorites): among its first COVER_RELEASES Releases, the earliest dated
 * one carrying a cover, else an ISBN to look one up by: the first dated
 * physical Release's, else the first dated one's (the upstreams know print
 * best). Past ten Releases this can differ from the Edition page's jacket.
 */
export async function editionCover(ctx: QueryCtx, editionId: Id<"editions">) {
  const releases = (
    await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .take(COVER_RELEASES)
  )
    .filter((doc) => doc.status === "active")
    .sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));
  for (const release of releases) {
    const url = await coverUrl(ctx, release.coverImage?.storageId);
    if (url) return { coverUrl: url, coverIsbn: release.isbn13 ?? null };
  }
  const isbn =
    releases.find((r) => r.format === "physical" && r.isbn13) ?? releases.find((r) => r.isbn13);
  return { coverUrl: null, coverIsbn: isbn?.isbn13 ?? null };
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
      /** A Mature Series' Volume (lib/mature.ts): art hidden from viewers who have not opted in. */
      mature: series.mature === true,
      credits: await creditsFor(ctx, series._id),
      editions,
      coverUrl: representativeCover(editions.flatMap((e) => e.releases)),
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
    const {
      title,
      lineName,
      coverage,
      series: lineSeries,
      mature,
      coverageUnmapped,
    } = await editionCoverage(ctx, edition);
    const releases = await editionReleases(ctx, edition._id);

    // Distinct Series of the covered Volumes, for breadcrumbs/backlinks;
    // Unmapped Packaging falls back to its line's Series.
    const series = [];
    const seen = new Set<number>();
    for (const cov of coverage) {
      if (seen.has(cov.series.publicId)) continue;
      seen.add(cov.series.publicId);
      series.push(cov.series);
    }
    if (series.length === 0 && lineSeries) series.push(lineSeries);

    return {
      edition: {
        publicId: edition.publicId,
        title,
        lineName,
        linePosition: edition.linePosition ?? null,
        coverageUnmapped,
        publisher:
          publisher && publisher.status === "active"
            ? { name: publisher.name, slug: publisher.slug }
            : null,
      },
      series,
      /** Collects a Mature Series (lib/mature.ts): art hidden from viewers who have not opted in. */
      mature,
      // The authors of the (first) Series it collects.
      credits: series[0] ? await creditsForPublicId(ctx, series[0].publicId) : [],
      coverage,
      releases,
      // The Edition's jacket (lib/covers.ts), the art its Release rows wear
      // elsewhere: `coverUrl` is the representative cover, and `coverIsbns`
      // the ISBNs to look art up by when there is none.
      ...(await jacketCache(ctx).jacket(edition._id)),
    };
  },
});

// ---------- Bundle page ----------

/**
 * A Bundle's listed members, each with its Release and Edition (merges
 * followed; hidden ones dropped) and the Edition's composed title, and
 * whether the box set is mature: an adult-only publisher's, or holding a
 * Mature Series' book. Maturity is judged through merges before hidden
 * members drop out (B35, R14), so hiding a member's Release or Edition never
 * makes the box set general. Shared by `bundlePage` and the sitemap (seo.ts)
 * so both judge a box set alike.
 */
export async function bundleMembers(ctx: QueryCtx, bundle: Doc<"releaseBundles">) {
  const publisher = await ctx.db.get(bundle.publisherId);
  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
    .collect();
  const members = [];
  let mature = (await mergeSurvivor(ctx, "publishers", publisher))?.contentRating === "mature";
  for (const membership of memberships) {
    const release = await mergeSurvivor(ctx, "releases", await ctx.db.get(membership.releaseId));
    if (!release) continue;
    const edition = await mergeSurvivor(ctx, "editions", await ctx.db.get(release.editionId));
    if (!edition) continue;
    const coverage = await editionCoverage(ctx, edition);
    if (coverage.mature) mature = true;
    if (release.status !== "active" || edition.status !== "active") continue;
    members.push({ membership, release, edition, title: coverage.title });
  }
  return { publisher, mature, members };
}

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

    const { publisher, mature, members: resolved } = await bundleMembers(ctx, bundle);
    const members = [];
    for (const { membership, release, edition, title } of resolved) {
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
        // Document id, for the signed-in collection controls (#27).
        id: bundle._id,
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
        coverUrl: await coverUrl(ctx, bundle.coverImage?.storageId),
      },
      /** Art hidden from viewers who have not opted in (lib/mature.ts). */
      mature,
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
