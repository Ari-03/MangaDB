// Volume, Edition, and Bundle pages + /isbn resolution (spec §2,
// §10, §11): the rest of the public catalog surface beyond the Series page
// (catalog.ts). One query per page, each returning exactly the joined shape
// its route renders; `isbnLookup` resolves an ISBN to its redirect target.
//
// Every query resolves merged records to their survivor (merged docs keep
// their public ID and point at the winner, spec §8) so the routes can 301,
// and reads hidden records as absent. Maturity is the exception: it is the
// content's, so hidden parts of a book or box set still count toward it.
//
// The Edition and Volume pages each resolve one description (CONTEXT.md:
// Edition Description, Volume Synopsis) instead of printing every Release's
// stored Release Description on its row.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { editionTitle, releaseAnchor, volumeTitle } from "./lib/titles";
import { coverUrl, jacketCache } from "./lib/covers";
import { representativeDescription } from "./lib/descriptions";
import { coverageOf, coveringOf, releasesOf } from "./lib/editionRows";
import { isWholeSingleVolume } from "./lib/matching";
import { followMerges, getActive, mergeSurvivor } from "./lib/merges";
import { otherPrintingsOf, printingReleases } from "./lib/releaseIsbns";
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

/** A Publisher as catalog rows link it, or null when it is hidden or gone. */
export function publisherLink(publisher: Doc<"publishers"> | null) {
  return publisher && publisher.status === "active"
    ? { name: publisher.name, slug: publisher.slug }
    : null;
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
  for (const row of await coverageOf(ctx, editionId)) {
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
  const storedLine = edition.editionLineId ? await ctx.db.get(edition.editionLineId) : null;
  const line = storedLine && storedLine.status === "active" ? storedLine : null;
  const lineName = line?.name ?? null;

  // Maturity is the content's, judged through merges and before
  // any hiding: the Edition Line's Series and every covered Volume's Series
  // count though hidden Volumes, Series and lines drop out of the listing.
  const contentLine = await mergeSurvivor(ctx, "editionLines", storedLine);
  const storedLineSeries = contentLine ? await ctx.db.get(contentLine.seriesId) : null;
  let collectsMature = (await mergeSurvivor(ctx, "series", storedLineSeries))?.mature === true;

  const rows = await coverageOf(ctx, edition._id);
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
      ? {
          publicId: lineSeries.publicId,
          title: lineSeries.title,
          mature: lineSeries.mature === true,
        }
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
 * facts with both ISBNs, the ISBNs of its Other Printings (oldest first,
 * with their year), Variants beneath their Release, and containing Bundles
 * cross-linked (spec §2/§10). `anchor` is the row's fragment on the Edition
 * page — ISBN when present, else document ID (spec §8). No Release
 * Description: the page shows one resolved description instead.
 */
async function releaseRow(ctx: QueryCtx, release: Doc<"releases">) {
  const otherPrintings = (await otherPrintingsOf(ctx, release._id))
    .filter((row) => row.isbn13 !== release.isbn13)
    .map((row) => ({ isbn13: row.isbn13, year: row.pubDate?.year ?? null }));

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
    otherPrintings,
    pubDate: release.pubDate ?? null,
    price: release.price ?? null,
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

/**
 * Active Releases of an Edition: the docs (for representativeDescription,
 * lib/descriptions.ts) and their joined rows, date-sorted.
 */
async function editionReleases(ctx: QueryCtx, editionId: Id<"editions">) {
  const docs = (await releasesOf(ctx, editionId)).filter((doc) => doc.status === "active");
  const rows = [];
  for (const doc of docs) rows.push(await releaseRow(ctx, doc));
  return { docs, rows: rows.sort(byDate) };
}

/**
 * The Series synopsis as a page's last-resort description, flagged
 * `source: "series"` and naming the Series so the page labels it "About
 * {title}" rather than passing it off as the book's.
 */
function seriesSynopsis(series: Doc<"series"> | null) {
  const text = series?.synopsis?.trim();
  return series && text
    ? {
        source: "series" as const,
        text,
        series: { publicId: series.publicId, title: series.title },
      }
    : null;
}

/**
 * The Edition Description (CONTEXT.md): its own Releases' representative
 * Release Description; else, when it covers exactly one Volume and that
 * one completely, the Volume Synopsis (an omnibus never borrows one
 * Volume's); else its Series' synopsis, flagged as such.
 */
async function editionDescription(
  ctx: QueryCtx,
  releases: Array<Doc<"releases">>,
  covered: Pick<Awaited<ReturnType<typeof editionCoverage>>, "coverage" | "volumeCount" | "series">,
) {
  const own = representativeDescription(releases);
  if (own) return { source: "release" as const, text: own.text };

  const only = covered.volumeCount === 1 ? covered.coverage[0] : undefined;
  if (only?.extent === "complete") {
    const volume = await ctx.db
      .query("volumes")
      .withIndex("by_publicId", (q) => q.eq("publicId", only.volumePublicId))
      .unique();
    const synopsis = volume?.synopsis?.trim();
    if (synopsis) return { source: "volume" as const, text: synopsis };
  }

  if (!covered.series) return null;
  const { publicId } = covered.series;
  const series = await ctx.db
    .query("series")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  return seriesSynopsis(series);
}

// ---------- Volume page ----------

/**
 * Everything the Volume page renders (spec §10): every Release
 * covering this Volume grouped under its Edition, each Edition carrying its
 * extent for THIS Volume (`extentForVolume`) so the route lists complete and
 * partial coverage distinctly — including the omnibus case, where the full
 * ordered Coverage shows what else the Edition contains. Canonical Volume
 * numbering (`position`) arrives separately from any Edition Line numbering
 * (`linePosition`); Release rows carry their containing Bundles.
 *
 * `description` is the Volume Synopsis; else the representative Release
 * Description among Editions that are ordinary books of this one whole
 * Volume (isWholeSingleVolume: no omnibus, split part or Edition Line
 * packaging lends its blurb; a publishing Publisher's Editions rank ahead
 * of a defunct one's), naming the Edition it came from; else the Series
 * synopsis, flagged as such.
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

    const coveringRows = await coveringOf(ctx, volume._id);
    const synopsis = volume.synopsis?.trim();
    const editions = [];
    // Releases of whole single-volume Editions, the borrowable blurbs when
    // there is no Volume Synopsis (each marked with whether its Publisher is
    // defunct, so the current licensee's blurb leads), and the Editions they
    // belong to.
    const lendingReleases = [];
    const lenders = new Map<
      Id<"editions">,
      { publicId: number; title: string; publisherName: string | null }
    >();
    for (const row of coveringRows) {
      const edition = await ctx.db.get(row.editionId);
      if (!edition || edition.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      const activePublisher = publisherLink(publisher);
      const { title, lineName, coverage } = await editionCoverage(ctx, edition);
      const { docs, rows } = await editionReleases(ctx, edition._id);
      if (!synopsis && (await isWholeSingleVolume(ctx, edition))) {
        const publisherDefunct = publisher?.defunct === true;
        lendingReleases.push(...docs.map((doc) => ({ ...doc, publisherDefunct })));
        lenders.set(edition._id, {
          publicId: edition.publicId,
          title,
          publisherName: activePublisher?.name ?? null,
        });
      }
      editions.push({
        publicId: edition.publicId,
        title,
        publisher: activePublisher,
        lineName,
        linePosition: edition.linePosition ?? null,
        // This Edition's extent for the page's Volume — the complete/partial
        // grouping key. The full Coverage above shows the omnibus span.
        extentForVolume: row.extent,
        extentNote: row.note ?? null,
        coverage,
        releases: rows,
      });
    }
    editions.sort((a, b) => a.publicId - b.publicId);

    const borrowed = representativeDescription(lendingReleases);
    const lender = borrowed ? lenders.get(borrowed.release.editionId) : undefined;
    const description = synopsis
      ? { source: "volume" as const, text: synopsis }
      : borrowed && lender
        ? { source: "edition" as const, text: borrowed.text, edition: lender }
        : seriesSynopsis(series);

    return {
      volume: {
        publicId: volume.publicId,
        position: volume.position,
        label: volume.label ?? null,
        title: volumeTitle(series.title, volume.label ?? null),
      },
      series: { publicId: series.publicId, title: series.title },
      /** A Mature Series' Volume (lib/mature.ts): art hidden from viewers who have not opted in. */
      mature: series.mature === true,
      credits: await creditsFor(ctx, series._id),
      description,
      editions,
      coverUrl: representativeCover(editions.flatMap((e) => e.releases)),
    };
  },
});

// ---------- Edition page ----------

/**
 * The book detail page (spec §2/§10): the Edition's identity
 * (composed title, Publisher, Edition Line membership + Edition Line
 * Position, ordered Volume Coverage with canonical positions kept separate),
 * its one Edition Description (`editionDescription`: `source` says whether
 * it is the book's own or its Series'), and its Release rows — differing
 * only in Format/Binding — each with ISBNs, date, Variants beneath, and
 * bundle-membership links.
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
    const covered = await editionCoverage(ctx, edition);
    const { title, lineName, coverage, series: lineSeries, mature, coverageUnmapped } = covered;
    const { docs, rows: releases } = await editionReleases(ctx, edition._id);

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
        publisher: publisherLink(publisher),
      },
      series,
      /** Collects a Mature Series (lib/mature.ts): art hidden from viewers who have not opted in. */
      mature,
      // The authors of the (first) Series it collects.
      credits: series[0] ? await creditsForPublicId(ctx, series[0].publicId) : [],
      coverage,
      description: await editionDescription(ctx, docs, covered),
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
 * members drop out, so hiding a member's Release or Edition never
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
 * The Bundle page (spec §2): the Release Bundle's own publication
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
        // Document id, for the signed-in collection controls.
        id: bundle._id,
        publicId: bundle.publicId,
        name: bundle.name,
        format: bundle.format ?? null,
        isbn13: bundle.isbn13 ?? null,
        isbn10: bundle.isbn10 ?? null,
        pubDate: bundle.pubDate ?? null,
        price: bundle.price ?? null,
        description: bundle.description ?? null,
        publisher: publisherLink(publisher),
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
 * redirects to the owning Edition anchored at the matching Release row; an
 * Other Printing's ISBN (lib/releaseIsbns.ts) finds its Release the same
 * way, after the Releases' own ISBNs; a box-set ISBN redirects to its Bundle
 * page. Merged records resolve to their survivor — the anchor is the
 * surviving Release's — and hidden records never match, so a hidden
 * Release's printings find nothing either. Null means no active match: the
 * route 404s.
 */
export const isbnLookup = query({
  args: { isbn: v.string() },
  handler: async (ctx, { isbn }) => {
    const is13 = isbn.length === 13;

    const ownDocs = is13
      ? await ctx.db
          .query("releases")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn))
          .collect()
      : await ctx.db
          .query("releases")
          .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn))
          .collect();
    const releaseDocs = [...ownDocs, ...(await printingReleases(ctx, isbn))];
    for (const doc of releaseDocs) {
      const release = await followMerges(ctx, "releases", doc);
      if (!release) continue;
      const edition = await getActive(ctx, "editions", release.editionId);
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
