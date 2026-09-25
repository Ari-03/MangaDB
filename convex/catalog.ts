import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { coverUrl, seriesCover } from "./lib/covers";
import { groupEditions } from "./lib/editionGroups";

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

/**
 * The newest Series in the catalog (highest public IDs), each with a jacket
 * for the home page's "recently added" shelf. Small and bounded: the shelf
 * is a taste of the catalog, search and the browser are the way in.
 */
export const RECENT_SERIES_MAX = 28;
export const recentSeries = query({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const take = Math.max(1, Math.min(RECENT_SERIES_MAX, Math.floor(limit)));
    // Look a little past the limit and seat the Series that have a jacket
    // first: a shelf of the newest announcements is mostly books whose art
    // no one has published yet, and a wall of cloth is not a taste of the
    // catalog. Cloth fills whatever is left, newest first.
    const docs = await ctx.db
      .query("series")
      .withIndex("by_publicId")
      .order("desc")
      .take(take * 3);
    type Shelved = {
      publicId: number;
      title: string;
      coverUrl: string | null;
      coverIsbn: string | null;
    };
    const jacketed: Array<Shelved> = [];
    const cloth: Array<Shelved> = [];
    for (const doc of docs) {
      if (doc.status !== "active") continue;
      const entry = { publicId: doc.publicId, title: doc.title, ...(await seriesCover(ctx, doc._id)) };
      (entry.coverUrl || entry.coverIsbn ? jacketed : cloth).push(entry);
      if (jacketed.length === take) break;
    }
    return [...jacketed, ...cloth]
      .slice(0, take)
      .sort((a, b) => b.publicId - a.publicId);
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
 * Exported for reading.ts (personal tracking resolves Series the same way).
 */
export async function resolveActiveSeries(
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
 * (ordered by Volume Position — the Label is display-only); each
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
    const volumeById = new Map(volumeDocs.map((doc) => [doc._id, doc]));

    // Every Edition of the Series: those covering its Volumes, plus Edition
    // Line members whose volume range is not mapped yet (an omnibus of
    // unknown extent still belongs to its line's reading path).
    const editionIds = new Set<Id<"editions">>();
    for (const volume of volumeDocs) {
      const rows = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
        .collect();
      for (const row of rows) editionIds.add(row.editionId);
    }
    const lines = await ctx.db
      .query("editionLines")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    for (const line of lines) {
      if (line.status !== "active") continue;
      const members = await ctx.db
        .query("editions")
        .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
        .collect();
      for (const member of members) editionIds.add(member._id);
    }

    const editions = [];
    for (const editionId of editionIds) {
      const edition = await ctx.db.get(editionId);
      if (!edition || edition.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      const line = edition.editionLineId
        ? await ctx.db.get(edition.editionLineId)
        : null;

      // The Edition's ordered Coverage within this Series.
      const coverageRows = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      const coverage = [];
      for (const cov of coverageRows) {
        const covered = volumeById.get(cov.volumeId);
        if (!covered) continue;
        coverage.push({
          volumePublicId: covered.publicId,
          position: covered.position,
          label: covered.label ?? null,
          extent: cov.extent,
        });
      }

      const releaseDocs = (
        await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect()
      ).filter((doc) => doc.status === "active");
      // A book's jacket: the first stored cover among its Releases; the page
      // falls back to ISBN-derived art (lib/cover.tsx) when there is none.
      let editionCover: string | null = null;
      const releases = [];
      for (const release of releaseDocs) {
        if (editionCover === null && release.coverImage) {
          editionCover = await coverUrl(ctx, release.coverImage.storageId);
        }
        releases.push({
          format: release.format,
          isbn13: release.isbn13 ?? null,
          pubDate: release.pubDate ?? null,
        });
      }
      releases.sort(
        (a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity),
      );

      editions.push({
        publicId: edition.publicId,
        publisher:
          publisher && publisher.status === "active"
            ? { name: publisher.name, slug: publisher.slug }
            : null,
        lineName: line && line.status === "active" ? line.name : null,
        linePosition: edition.linePosition ?? null,
        coverage,
        coverUrl: editionCover,
        releases,
      });
    }

    // The reading paths the page offers; the first path's first book fronts
    // the Series (its cover and social card).
    const editionGroups = groupEditions(editions);
    const volumes = volumeDocs.map((volume) => ({
      publicId: volume.publicId,
      position: volume.position,
      label: volume.label ?? null,
      synopsis: volume.synopsis ?? null,
    }));

    return {
      series: {
        publicId: series.publicId,
        title: series.title,
        altTitles: series.altTitles,
        sourceStatus: series.sourceStatus ?? null,
        synopsis: series.synopsis ?? null,
      },
      family,
      volumes,
      editionGroups,
      coverUrl: editionGroups[0]?.books[0]?.coverUrl ?? null,
    };
  },
});
