import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";

// Cap per-table counting so the scaffold query stays cheap even once imports
// start filling the catalog; the home page renders "N+" past the cap.
export const COUNT_CAP = 1000;

/**
 * Scaffold proof query (#21): a tiny public read the home page server-renders
 * to demonstrate the SSR → Convex round-trip. Counts active catalog records
 * (capped) so the page works on a fresh deployment with an empty database.
 */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const countActive = async (
      table: "publishers" | "series" | "volumes" | "editions" | "releases",
    ) => {
      const docs = await ctx.db.query(table).take(COUNT_CAP + 1);
      const active = docs.filter((doc) => doc.status === "active").length;
      return { count: Math.min(active, COUNT_CAP), capped: docs.length > COUNT_CAP };
    };

    return {
      publishers: await countActive("publishers"),
      series: await countActive("series"),
      volumes: await countActive("volumes"),
      editions: await countActive("editions"),
      releases: await countActive("releases"),
    };
  },
});

/**
 * Active Series in public-ID order, for the home page's browse list. Capped;
 * the real browse surface is the Releases browser (a later ticket).
 */
export const listSeries = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query("series")
      .withIndex("by_publicId")
      .take(COUNT_CAP);
    return docs
      .filter((doc) => doc.status === "active")
      .map((doc) => ({ publicId: doc.publicId, title: doc.title }));
  },
});

// ---------- Search (ticket #38) ----------

export const SEARCH_LIMIT = 20;
// The publisher list is deliberately small (spec §8: "publishers via the
// small list" — a few dozen English-market publishers), so a capped scan
// replaces any index; the cap only guards against pathology.
export const PUBLISHER_SCAN_CAP = 500;

/**
 * v1 search (spec §8): Series only, matched through the title + alt-titles
 * search index (`searchText` is both concatenated on write); Publishers
 * resolved by case-insensitive name match over the small publisher list. No
 * Volume or Bundle search in v1. ISBN inputs never reach this query — the
 * /search route recognizes them first and redirects through `/isbn/{isbn}`.
 *
 * Results carry only active records: hidden records are invisible, and a
 * merged Series is findable through its survivor (merges fold alt titles
 * into the surviving record), so search always links canonical pages.
 */
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: rawQuery }) => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") {
      return { series: [], publishers: [] };
    }

    const seriesDocs = await ctx.db
      .query("series")
      .withSearchIndex("search_title", (q) => q.search("searchText", trimmed))
      // Overfetch so post-filtering hidden/merged docs can't starve the page.
      .take(SEARCH_LIMIT * 2);
    const series = seriesDocs
      .filter((doc) => doc.status === "active")
      .slice(0, SEARCH_LIMIT)
      .map((doc) => ({
        publicId: doc.publicId,
        title: doc.title,
        altTitles: doc.altTitles,
      }));

    const needle = trimmed.toLowerCase();
    const publisherDocs = await ctx.db
      .query("publishers")
      .take(PUBLISHER_SCAN_CAP);
    const publishers = publisherDocs
      .filter(
        (doc) =>
          doc.status === "active" && doc.name.toLowerCase().includes(needle),
      )
      .slice(0, SEARCH_LIMIT)
      .map((doc) => ({ name: doc.name, slug: doc.slug }));

    return { series, publishers };
  },
});

// ---------- Series page (ticket #22) ----------

/**
 * Follow a merged Series to its surviving record (spec §4/§8): merged docs
 * keep their public ID and point at the winner, so the losing ID's URL 301s
 * without a redirects table. Cycle-guarded; hidden records read as absent.
 */
async function resolveActiveSeries(
  ctx: QueryCtx,
  publicId: number,
): Promise<Doc<"series"> | null> {
  let doc = await ctx.db
    .query("series")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  const visited = new Set<string>();
  while (doc && doc.status === "merged" && doc.mergedIntoId) {
    if (visited.has(doc._id)) return null;
    visited.add(doc._id);
    doc = await ctx.db.get(doc.mergedIntoId);
  }
  return doc && doc.status === "active" ? doc : null;
}

/**
 * Everything the Series page renders, shaped as the Reading Path hierarchy
 * validated in prototype #16 (spec §10): the canonical Volume sequence leads
 * (ordered by hidden Volume Position — the Label is display-only); each
 * Volume carries every covering Edition with its full ordered Coverage,
 * Edition Line membership, Releases, Variants, and Bundle cross-links.
 *
 * Returns null for unknown or hidden Series. For a merged Series it returns
 * the survivor's page — the route compares the requested public ID and slug
 * to the canonical ones and 301s on any mismatch (spec §11).
 */
export const seriesPage = query({
  args: { publicId: v.number() },
  handler: async (ctx, { publicId }) => {
    const series = await resolveActiveSeries(ctx, publicId);
    if (!series) return null;

    // Series Family: shown only when >= 2 active member Series exist (spec
    // §2); a lone Series displays no family concept at all.
    let family: {
      name: string;
      members: Array<{ publicId: number; title: string }>;
      relationships: Array<{
        type: Doc<"seriesRelationships">["type"];
        note: string | null;
        from: { publicId: number; title: string };
        to: { publicId: number; title: string };
      }>;
    } | null = null;
    if (series.familyId) {
      const familyDoc = await ctx.db.get(series.familyId);
      if (familyDoc && familyDoc.status === "active") {
        const members = (
          await ctx.db
            .query("series")
            .withIndex("by_family", (q) => q.eq("familyId", familyDoc._id))
            .collect()
        ).filter((doc) => doc.status === "active");
        if (members.length >= 2) {
          const memberById = new Map(members.map((m) => [m._id, m]));
          // Edges are stored once as "from is a {type} of to" (spec §2); the
          // page renders the sentence whichever end this Series is.
          const edges = [
            ...(await ctx.db
              .query("seriesRelationships")
              .withIndex("by_from", (q) => q.eq("fromSeriesId", series._id))
              .collect()),
            ...(await ctx.db
              .query("seriesRelationships")
              .withIndex("by_to", (q) => q.eq("toSeriesId", series._id))
              .collect()),
          ];
          const relationships = [];
          for (const edge of edges) {
            const from = memberById.get(edge.fromSeriesId);
            const to = memberById.get(edge.toSeriesId);
            if (!from || !to) continue;
            relationships.push({
              type: edge.type,
              note: edge.note ?? null,
              from: { publicId: from.publicId, title: from.title },
              to: { publicId: to.publicId, title: to.title },
            });
          }
          family = {
            name: familyDoc.name,
            members: members
              .sort((a, b) => a.publicId - b.publicId)
              .map((m) => ({ publicId: m.publicId, title: m.title })),
            relationships,
          };
        }
      }
    }

    // Canonical Volume sequence: the by_series index is (seriesId, position),
    // so this arrives in reading order. Labels never sort anything.
    const volumeDocs = (
      await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .collect()
    ).filter((doc) => doc.status === "active");

    const volumes = [];
    for (const volume of volumeDocs) {
      const coveringRows = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
        .collect();

      const editions = [];
      for (const row of coveringRows) {
        const edition = await ctx.db.get(row.editionId);
        if (!edition || edition.status !== "active") continue;
        const publisher = await ctx.db.get(edition.publisherId);
        const line = edition.editionLineId
          ? await ctx.db.get(edition.editionLineId)
          : null;

        // The Edition's full ordered Coverage, so an omnibus shows "covers
        // Vol 1–3" under every covered Volume.
        const coverageRows = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect();
        const coverage = [];
        for (const cov of coverageRows) {
          const covered = await ctx.db.get(cov.volumeId);
          if (!covered || covered.status !== "active") continue;
          coverage.push({
            volumePublicId: covered.publicId,
            position: covered.position,
            label: covered.label ?? null,
            extent: cov.extent,
            note: cov.note ?? null,
          });
        }

        const releaseDocs = (
          await ctx.db
            .query("releases")
            .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
            .collect()
        ).filter((doc) => doc.status === "active");
        const releases = [];
        for (const release of releaseDocs) {
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

          releases.push({
            id: release._id,
            format: release.format,
            binding: release.binding ?? null,
            language: release.language,
            isbn13: release.isbn13 ?? null,
            pubDate: release.pubDate ?? null,
            price: release.price ?? null,
            description: release.description ?? null,
            variants,
            bundles,
          });
        }
        releases.sort(
          (a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity),
        );

        editions.push({
          publicId: edition.publicId,
          publisher: publisher
            ? { name: publisher.name, slug: publisher.slug }
            : null,
          lineName: line && line.status === "active" ? line.name : null,
          linePosition: edition.linePosition ?? null,
          extentForVolume: row.extent,
          coverage,
          releases,
        });
      }
      editions.sort((a, b) => a.publicId - b.publicId);

      volumes.push({
        publicId: volume.publicId,
        position: volume.position,
        label: volume.label ?? null,
        synopsis: volume.synopsis ?? null,
        editions,
      });
    }

    return {
      series: {
        publicId: series.publicId,
        title: series.title,
        altTitles: series.altTitles,
        sourceStatus: series.sourceStatus ?? null,
      },
      family,
      volumes,
    };
  },
});
