import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { coverUrl, seriesCover } from "./lib/covers";
import { groupEditions } from "./lib/editionGroups";
import { canonicalPublisherFor } from "./lib/publishers";
import {
  matchesAllWords,
  matchNames,
  probePrefixes,
  rankNearMisses,
  sortByTitleMatch,
} from "./lib/searchMatch";

// Fallback cap for counting on a deployment the rebuild has not counted yet;
// the home page renders "N+" past it.
export const COUNT_CAP = 1000;

const COUNTED_TABLES = ["publishers", "series", "volumes", "editions", "releases"] as const;
type CountedTable = (typeof COUNTED_TABLES)[number];
/** Documents read per page when recounting; well inside a query's read limit. */
const COUNT_PAGE = 4000;

/**
 * Active catalog totals for the home page: the exact counts the Series
 * library rebuild stores (`recountCatalog`), else a capped live count so a
 * fresh deployment still renders.
 */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const stored = await ctx.db.query("catalogCounts").first();
    const entries = await Promise.all(
      COUNTED_TABLES.map(async (table) => {
        if (stored) return [table, { count: stored[table], capped: false }] as const;
        const docs = await ctx.db.query(table).take(COUNT_CAP + 1);
        const active = docs.filter((doc) => doc.status === "active").length;
        return [table, { count: Math.min(active, COUNT_CAP), capped: docs.length > COUNT_CAP }] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<CountedTable, { count: number; capped: boolean }>;
  },
});

/** One page of a table, counting its active documents. */
export const countActivePage = internalQuery({
  args: {
    table: v.union(...COUNTED_TABLES.map((table) => v.literal(table))),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(table).paginate({ numItems: COUNT_PAGE, cursor });
    return {
      active: page.page.filter((doc) => doc.status === "active").length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const saveCounts = internalMutation({
  args: {
    publishers: v.number(),
    series: v.number(),
    volumes: v.number(),
    editions: v.number(),
    releases: v.number(),
    countedAt: v.number(),
  },
  handler: async (ctx, counts) => {
    const existing = await ctx.db.query("catalogCounts").first();
    if (existing) await ctx.db.replace(existing._id, counts);
    else await ctx.db.insert("catalogCounts", counts);
  },
});

/**
 * Count every active catalog record, a page at a time, and store the totals.
 * Runs at the end of each Series library rebuild (every six hours).
 */
export async function recountCatalog(ctx: ActionCtx): Promise<Record<CountedTable, number>> {
  const totals = { publishers: 0, series: 0, volumes: 0, editions: 0, releases: 0 };
  for (const table of COUNTED_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page: { active: number; cursor: string; isDone: boolean } = await ctx.runQuery(
        internal.catalog.countActivePage,
        { table, cursor },
      );
      totals[table] += page.active;
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  await ctx.runMutation(internal.catalog.saveCounts, { ...totals, countedAt: Date.now() });
  return totals;
}

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
// small list" — a few dozen English-market publishers, 65 active today), so
// a capped scan replaces any index; the cap only guards against pathology.
export const PUBLISHER_SCAN_CAP = 500;
/** Series rows in the header's live suggestions. */
export const SUGGEST_LIMIT = 6;
// Search-index hits read per suggestion: merged and hidden Series stay in
// the index and crowd the top, and the exact title is not always its first
// hit ("Attack on Titan" trails its spinoffs), so look past the six shown.
const SUGGEST_TAKE = 20;
/** Publisher rows in the header's live suggestions. */
export const SUGGEST_PUBLISHERS = 3;
/** "Did you mean" titles offered at most. */
export const NEAR_MISS_LIMIT = 3;
/** Documents each typo-help prefix probe reads (at most four probes). */
const PROBE_TAKE = 8;

/**
 * Active Series the title search index returns for a query, and among them
 * the `whole` hits whose titles contain every typed word, exact and opening
 * matches first (`sortByTitleMatch`). The index matches any one term ("one
 * peice" finds every "One …"), so `whole` is what tells a real match from a
 * shared word. Reads `take` documents.
 */
async function titleHits(ctx: QueryCtx, query: string, take: number) {
  const docs = await ctx.db
    .query("series")
    .withSearchIndex("search_title", (q) => q.search("searchText", query))
    .take(take);
  const active = docs.filter((doc) => doc.status === "active");
  const whole = sortByTitleMatch(
    query,
    active.filter((doc) => matchesAllWords(query, doc.searchText)),
  );
  return { active, whole };
}

/**
 * "Did you mean" Series for a query the index matched poorly: probe the
 * index with the query words' 3- and 4-letter openings (`probePrefixes`, at
 * most 4 × PROBE_TAKE reads), pool those with the hits already read, and
 * rank the near misses in memory (lib/searchMatch.ts).
 */
async function nearMisses(ctx: QueryCtx, query: string, seen: ReadonlyArray<Doc<"series">>) {
  const pool = new Map(seen.map((doc) => [doc._id, doc]));
  const probes = await Promise.all(
    probePrefixes(query).map((prefix) =>
      ctx.db
        .query("series")
        .withSearchIndex("search_title", (q) => q.search("searchText", prefix))
        .take(PROBE_TAKE),
    ),
  );
  for (const doc of probes.flat()) {
    if (doc.status === "active") pool.set(doc._id, doc);
  }
  return rankNearMisses(query, [...pool.values()], NEAR_MISS_LIMIT);
}

/**
 * Active Publishers the query finds, read off the small publisher list — one
 * capped scan of PUBLISHER_SCAN_CAP rows — and whether it `names` one. A
 * canonical alias (lib/publishers.ts `canonicalPublisherFor`: "Shonen Jump"
 * → VIZ Media, "Seven Seas Siren" → Seven Seas) leads, then the name
 * matches (`matchNames`: every query word opens a word of the name, exact
 * and opening matches first). A merged row's old name finds its survivor
 * ("Kodansha Comics" → Kodansha), which also covers moderator merges the
 * alias table does not list.
 *
 * `names` is true for an alias or a name whose leading words the query
 * spells out whole ("seven seas", "kodansha", "digital"): the reader is
 * after that Publisher, so search skips typo help and suggest drops loose
 * Series rows. A partial word ("kod", "del") or a word deeper in a name
 * ("manga", "press", "gasp") lists the Publishers but suppresses nothing.
 * Shared by search and suggest, so the dropdown and the page agree.
 */
async function publisherHits(ctx: QueryCtx, query: string, limit: number) {
  const docs = await ctx.db.query("publishers").take(PUBLISHER_SCAN_CAP);
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const alias = canonicalPublisherFor(query);
  const aliased = alias ? docs.find((doc) => doc.slug === alias.slug) : undefined;
  const matches = [
    ...(aliased ? [{ item: aliased, names: true }] : []),
    ...matchNames(query, docs),
  ];
  const hits = new Map<Id<"publishers">, { name: string; slug: string }>();
  let names = false;
  for (const match of matches) {
    // Follow merges within the list; the visited set guards a cycle.
    let target: Doc<"publishers"> | undefined = match.item;
    const visited = new Set<Id<"publishers">>();
    while (target?.status === "merged" && target.mergedIntoId && !visited.has(target._id)) {
      visited.add(target._id);
      target = byId.get(target.mergedIntoId);
    }
    if (target?.status === "active") {
      hits.set(target._id, { name: target.name, slug: target.slug });
      names ||= match.names;
    }
  }
  return { publishers: [...hits.values()].slice(0, limit), names };
}

/** The alt title a hit matched through, or null when its title matched. */
function matchedAlt(query: string, doc: Doc<"series">): string | null {
  if (matchesAllWords(query, doc.title)) return null;
  return doc.altTitles.find((alt) => matchesAllWords(query, alt)) ?? null;
}

/**
 * A Series result as search renders it: the Series library's stored jacket,
 * Volume count, and first publisher (one indexed `seriesStats` read). A
 * Series the library has not rebuilt yet reads as cloth with no counts.
 */
async function seriesCard(ctx: QueryCtx, doc: Doc<"series">, altMatch: string | null) {
  const stats = await ctx.db
    .query("seriesStats")
    .withIndex("by_series", (q) => q.eq("seriesId", doc._id))
    .first();
  return {
    publicId: doc.publicId,
    title: doc.title,
    altTitles: doc.altTitles,
    altMatch,
    coverUrl: stats?.coverUrl ?? null,
    coverIsbn: stats?.coverIsbn ?? null,
    volumeCount: stats?.volumeCount ?? null,
    publisher: stats?.publishers[0]?.name ?? null,
  };
}

/** Cards for near misses, naming the alt title when that is what was close. */
function nearMissCards(ctx: QueryCtx, misses: Awaited<ReturnType<typeof nearMisses>>) {
  return Promise.all(
    misses.map(({ item, matched }) =>
      seriesCard(ctx, item, matched === item.title ? null : matched),
    ),
  );
}

/**
 * v1 search (spec §8): Series only, matched through the title + alt-titles
 * search index (`searchText` is both concatenated on write), hits containing
 * every typed word first, each with its jacket from the Series library;
 * Publishers by name or alias (`publisherHits`). When no Series hit contains
 * the whole query and it names no Publisher, `didYouMean` offers near-miss
 * titles ("berzerk" → Berserk); "Seven Seas" names a Publisher, so it gets
 * no "Seven Seeds?". No Volume or Bundle search in v1.
 * ISBN inputs never reach this query — the /search route recognizes them
 * first and redirects through `/isbn/{isbn}`.
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
      return { series: [], publishers: [], didYouMean: [] };
    }

    // Overfetch so post-filtering hidden/merged docs can't starve the page.
    const [hits, { publishers, names }] = await Promise.all([
      titleHits(ctx, trimmed, SEARCH_LIMIT * 2),
      publisherHits(ctx, trimmed, SEARCH_LIMIT),
    ]);
    const wholeIds = new Set(hits.whole.map((doc) => doc._id));
    const ranked = [
      ...hits.whole,
      ...hits.active.filter((doc) => !wholeIds.has(doc._id)),
    ].slice(0, SEARCH_LIMIT);
    const [series, didYouMean] = await Promise.all([
      Promise.all(ranked.map((doc) => seriesCard(ctx, doc, matchedAlt(trimmed, doc)))),
      hits.whole.length === 0 && !names
        ? nearMisses(ctx, trimmed, hits.active).then((misses) => nearMissCards(ctx, misses))
        : [],
    ]);

    return { series, publishers, didYouMean };
  },
});

/**
 * Live suggestions for the header search box, run per (debounced) keystroke
 * by the reactive client, so every read is bounded: SUGGEST_TAKE search-index
 * hits, a `seriesStats` row per shown Series, the publisher list matched
 * exactly as search matches it (`publisherHits`, ~70 rows today, at most
 * PUBLISHER_SCAN_CAP), and — only when no Series hit contains every typed
 * word and the query names no Publisher — up to four typo-help probes of
 * PROBE_TAKE documents each: about 100 documents for a typical query, under
 * 140 in the worst case with today's publisher list.
 *
 * Series that share only some words with the query are noise next to a
 * "did you mean" or a Publisher the query names, so they fill the list only
 * when there is nothing better.
 */
export const suggest = query({
  args: { query: v.string() },
  handler: async (ctx, { query: rawQuery }) => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") return { series: [], didYouMean: [], publishers: [] };

    const [hits, { publishers, names }] = await Promise.all([
      titleHits(ctx, trimmed, SUGGEST_TAKE),
      publisherHits(ctx, trimmed, SUGGEST_PUBLISHERS),
    ]);
    const misses =
      hits.whole.length === 0 && !names ? await nearMisses(ctx, trimmed, hits.active) : [];
    const better = hits.whole.length > 0 || misses.length > 0 || names;
    const shown = better ? hits.whole : hits.active;
    const [series, didYouMean] = await Promise.all([
      Promise.all(
        shown
          .slice(0, SUGGEST_LIMIT)
          .map((doc) => seriesCard(ctx, doc, matchedAlt(trimmed, doc))),
      ),
      nearMissCards(ctx, misses),
    ]);

    return { series, didYouMean, publishers };
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
