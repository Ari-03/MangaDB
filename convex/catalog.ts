import { v } from "convex/values";
import { type BoxSetPart, boxSetContents } from "./lib/boxSets";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { publisherLink } from "./catalogPages";
import { boundedReads } from "./lib/boundedReads";
import { todaySortKey } from "./lib/dates";
import { followMerges } from "./lib/merges";
import { coverUrl, seriesCover, statsCoverIsbns } from "./lib/covers";
import { fieldAttribution } from "./lib/attribution";
import { editionCoverage } from "./catalogPages";
import { coverageOf, coveringOf, releasesOf } from "./lib/editionRows";
import { groupEditions } from "./lib/editionGroups";
import { pathCombination } from "./lib/pathCombination";
import { listed, showMatureArg, visibleTo } from "./lib/mature";
import { canonicalPublisherFor } from "./lib/publishers";
import { creditsFor } from "./people";
import {
  matchesAllWords,
  matchesSeries,
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
        return [
          table,
          { count: Math.min(active, COUNT_CAP), capped: docs.length > COUNT_CAP },
        ] as const;
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
 * The newest Series in the catalog (highest public IDs) the viewer may
 * see (`listed`), each with a jacket for the home page's "recently added"
 * shelf. Small and bounded: the shelf
 * is a taste of the catalog, search and the browser are the way in.
 *
 * `todaySort` is today's yyyymmdd (UTC) for the cover pick (lib/covers.ts
 * `seriesCoverIsbns`): Convex caches a query's result until something it read
 * changes, and a clock read expires it within seconds, so the app sends the
 * day (src/lib/catalogData.ts). Optional only for clients from before the
 * argument: a Worker mid-deploy, or a browser tab still on the old bundle
 * (the home loader also runs in the browser). Those get the clock's day, as
 * they always did, so their covers rank as before; the current app always
 * sends it, so its results never read the clock. Make it required once old
 * clients have aged out.
 */
export const RECENT_SERIES_MAX = 28;
export const recentSeries = query({
  args: { limit: v.number(), todaySort: v.optional(v.number()), ...showMatureArg },
  handler: async (ctx, { limit, todaySort, showMature }) => {
    const take = Math.max(1, Math.min(RECENT_SERIES_MAX, Math.floor(limit)));
    // Old clients only: the clock, and the cache expiry that comes with it.
    const today = todaySort ?? todaySortKey(new Date());
    // Look a little past the limit and seat the Series that have a jacket
    // first: a shelf of the newest announcements is mostly books whose art
    // no one has published yet, and a wall of cloth is not a taste of the
    // catalog. Cloth fills whatever is left, newest first. Bookless Series
    // (no books yet) are not a taste of the catalog, and Mature Series only
    // for a viewer who opted in.
    const docs = (
      await ctx.db
        .query("series")
        .withIndex("by_publicId")
        .order("desc")
        .take(take * 3)
    ).filter((doc) => listed(doc, showMature));
    type Shelved = {
      publicId: number;
      title: string;
      coverUrl: string | null;
      coverIsbns: string[];
    };
    const jacketed: Array<Shelved> = [];
    const cloth: Array<Shelved> = [];
    // Covers resolve a batch at a time, newest first, each batch only as
    // large as the jackets still wanted: it can fill the shelf only on its
    // last Series, so the Series read are exactly those a one-at-a-time walk
    // stopping at the `take`-th jacket reads, in far fewer round trips.
    let next = 0;
    while (next < docs.length && jacketed.length < take) {
      const batch = docs.slice(next, next + take - jacketed.length);
      next += batch.length;
      const entries = await Promise.all(
        batch.map(async (doc) => ({
          publicId: doc.publicId,
          title: doc.title,
          ...(await seriesCover(ctx, doc._id, today)),
        })),
      );
      for (const entry of entries) {
        (entry.coverUrl || entry.coverIsbns.length > 0 ? jacketed : cloth).push(entry);
      }
    }
    return [...jacketed, ...cloth].slice(0, take).sort((a, b) => b.publicId - a.publicId);
  },
});

// ---------- Search ----------

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
 * the `whole` hits whose titles contain every typed word (or its initials,
 * `matchesSeries`), exact and opening matches first (`sortByTitleMatch`). The index matches any one term ("one
 * peice" finds every "One …"), so `whole` is what tells a real match from a
 * shared word. Reads `take` documents.
 */
async function titleHits(
  ctx: QueryCtx,
  query: string,
  take: number,
  showMature: boolean | undefined,
) {
  const docs = await ctx.db
    .query("series")
    .withSearchIndex("search_title", (q) => q.search("searchText", query))
    .take(take);
  // Bookless Series stay out of search until a book lands (CONTEXT.md), and
  // Mature Series unless the viewer opted in.
  const active = docs.filter((doc) => listed(doc, showMature));
  const whole = sortByTitleMatch(
    query,
    active.filter((doc) => matchesSeries(query, doc)),
  );
  return { active, whole };
}

/**
 * "Did you mean" Series for a query the index matched poorly: probe the
 * index with the query words' 3- and 4-letter openings (`probePrefixes`, at
 * most 4 × PROBE_TAKE reads), pool those with the hits already read, and
 * rank the near misses in memory (lib/searchMatch.ts).
 */
async function nearMisses(
  ctx: QueryCtx,
  query: string,
  seen: ReadonlyArray<Doc<"series">>,
  showMature: boolean | undefined,
) {
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
    if (listed(doc, showMature)) pool.set(doc._id, doc);
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
async function publisherHits(
  ctx: QueryCtx,
  query: string,
  limit: number,
  showMature: boolean | undefined,
) {
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
    if (target?.status === "active" && visibleTo(showMature, target.contentRating === "mature")) {
      hits.set(target._id, { name: target.name, slug: target.slug });
      names ||= match.names;
    }
  }
  return { publishers: [...hits.values()].slice(0, limit), names };
}

/** Authors in search results and suggestions. */
export const SEARCH_AUTHORS = 6;
export const SUGGEST_AUTHORS = 3;

/**
 * Authors whose name the query opens, word by word (`matchesAllWords`), off
 * the people name index, the most prolific first. Authors with no visible
 * Series, as maker or original creator, are left out.
 */
async function authorHits(
  ctx: QueryCtx,
  query: string,
  limit: number,
  showMature: boolean | undefined,
) {
  const docs = await ctx.db
    .query("people")
    .withSearchIndex("search_name", (q) => q.search("name", query))
    .take(limit * 4);
  return docs
    .filter(
      (doc) =>
        doc.seriesCount + (doc.originalCount ?? 0) > 0 &&
        visibleTo(showMature, doc.matureOnly) &&
        matchesAllWords(query, doc.name),
    )
    .sort((a, b) => b.seriesCount - a.seriesCount)
    .slice(0, limit)
    .map((doc) => ({
      publicId: doc.publicId,
      name: doc.name,
      seriesCount: doc.seriesCount,
      originalCount: doc.originalCount ?? 0,
    }));
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
    coverIsbn: statsCoverIsbns(stats),
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
 * Search hits with each Series Family kept together in reading order
 * (`familyPosition`), at the place of its best-ranked member: "jojo" lists
 * Part 1, Part 2, … rather than the index's relevance order among Parts.
 * Series outside a Family keep their rank.
 */
export function familiesTogether<T extends Pick<Doc<"series">, "familyId" | "familyPosition">>(
  ranked: ReadonlyArray<T>,
): T[] {
  const byFamily = new Map<string, T[]>();
  for (const doc of ranked) {
    if (doc.familyId) byFamily.set(doc.familyId, [...(byFamily.get(doc.familyId) ?? []), doc]);
  }
  const placed = new Set<string>();
  return ranked.flatMap((doc) => {
    if (!doc.familyId) return [doc];
    if (placed.has(doc.familyId)) return [];
    placed.add(doc.familyId);
    return [...byFamily.get(doc.familyId)!].sort(
      (a, b) =>
        (a.familyPosition ?? Number.MAX_SAFE_INTEGER) -
        (b.familyPosition ?? Number.MAX_SAFE_INTEGER),
    );
  });
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
 * Mature Series, adult-only Publishers, and authors of nothing else stay
 * out unless `showMature` (lib/mature.ts); suggest does the same.
 */
export const search = query({
  args: { query: v.string(), ...showMatureArg },
  handler: async (ctx, { query: rawQuery, showMature }) => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") {
      return { series: [], publishers: [], authors: [], didYouMean: [] };
    }

    // Overfetch so post-filtering hidden/merged docs can't starve the page.
    const [hits, { publishers, names }, authors] = await Promise.all([
      titleHits(ctx, trimmed, SEARCH_LIMIT * 2, showMature),
      publisherHits(ctx, trimmed, SEARCH_LIMIT, showMature),
      authorHits(ctx, trimmed, SEARCH_AUTHORS, showMature),
    ]);
    const wholeIds = new Set(hits.whole.map((doc) => doc._id));
    const ranked = familiesTogether(
      [...hits.whole, ...hits.active.filter((doc) => !wholeIds.has(doc._id))].slice(
        0,
        SEARCH_LIMIT,
      ),
    );
    const [series, didYouMean] = await Promise.all([
      Promise.all(ranked.map((doc) => seriesCard(ctx, doc, matchedAlt(trimmed, doc)))),
      hits.whole.length === 0 && !names && authors.length === 0
        ? nearMisses(ctx, trimmed, hits.active, showMature).then((misses) =>
            nearMissCards(ctx, misses),
          )
        : [],
    ]);

    return { series, publishers, authors, didYouMean };
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
  args: { query: v.string(), ...showMatureArg },
  handler: async (ctx, { query: rawQuery, showMature }) => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") return { series: [], didYouMean: [], publishers: [], authors: [] };

    const [hits, { publishers, names }, authors] = await Promise.all([
      titleHits(ctx, trimmed, SUGGEST_TAKE, showMature),
      publisherHits(ctx, trimmed, SUGGEST_PUBLISHERS, showMature),
      authorHits(ctx, trimmed, SUGGEST_AUTHORS, showMature),
    ]);
    // A query that names an author wants the author, not typo help.
    const misses =
      hits.whole.length === 0 && !names && authors.length === 0
        ? await nearMisses(ctx, trimmed, hits.active, showMature)
        : [];
    const better = hits.whole.length > 0 || misses.length > 0 || names || authors.length > 0;
    const shown = familiesTogether(better ? hits.whole : hits.active);
    const [series, didYouMean] = await Promise.all([
      Promise.all(
        shown.slice(0, SUGGEST_LIMIT).map((doc) => seriesCard(ctx, doc, matchedAlt(trimmed, doc))),
      ),
      nearMissCards(ctx, misses),
    ]);

    return { series, didYouMean, publishers, authors };
  },
});

// ---------- Series page ----------

/**
 * The active Series a public ID names, merges followed (lib/merges.ts): a
 * merged Series keeps its public ID, so the losing ID's URL 301s without a
 * redirects table. Hidden records read as absent.
 */
export async function resolveActiveSeries(
  ctx: QueryCtx,
  publicId: number,
): Promise<Doc<"series"> | null> {
  const stored = await ctx.db
    .query("series")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  return await followMerges(ctx, "series", stored);
}

/**
 * A Series' active Volumes in reading order: the by_series index is
 * (seriesId, position). Labels never sort anything.
 */
export async function activeVolumes(ctx: QueryCtx, seriesId: Id<"series">) {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  return volumes.filter((volume) => volume.status === "active");
}

/**
 * Every active Edition of a Series, in the order first met: those covering
 * its active `volumes` (with the Position of the first Volume each covers),
 * then Edition Line members whose volume range is not mapped yet (an
 * omnibus of unknown extent still belongs to its line's reading path).
 * Shared by the Series page and the Series library rebuild (seriesBrowse.ts),
 * so both count the same books.
 *
 * The reads run concurrently, a round of each kind (every Volume's Coverage
 * and the Series' lines, then the Editions and line members), at most
 * READ_CONCURRENCY at a time (lib/boundedReads.ts, the caller's queue when
 * `ctx` is already bounded), and the results are walked in Volume and row
 * order afterwards, so the order and the first Positions are those of a
 * walk one Volume at a time.
 */
export async function seriesEditions(
  unbounded: QueryCtx,
  seriesId: Id<"series">,
  volumes: Array<Doc<"volumes">>,
) {
  const ctx = boundedReads(unbounded);
  const [covering, lines] = await Promise.all([
    Promise.all(volumes.map((volume) => coveringOf(ctx, volume._id))),
    ctx.db
      .query("editionLines")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect(),
  ]);
  // Each Edition once, at the first Volume that meets it.
  const firstMet = new Map<Id<"editions">, number>();
  volumes.forEach((volume, i) => {
    for (const row of covering[i]!) {
      if (!firstMet.has(row.editionId)) firstMet.set(row.editionId, volume.position);
    }
  });
  const [covered, members] = await Promise.all([
    Promise.all([...firstMet.keys()].map((id) => ctx.db.get(id))),
    Promise.all(
      lines
        .filter((line) => line.status === "active")
        .map((line) =>
          ctx.db
            .query("editions")
            .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
            .collect(),
        ),
    ),
  ]);
  const editions = new Map<Id<"editions">, Doc<"editions">>();
  const firstPosition = new Map<Id<"editions">, number>();
  for (const edition of covered) {
    if (!edition || edition.status !== "active") continue;
    editions.set(edition._id, edition);
    firstPosition.set(edition._id, firstMet.get(edition._id)!);
  }
  for (const member of members.flat()) {
    if (member.status === "active" && !editions.has(member._id)) editions.set(member._id, member);
  }
  return { editions, firstPosition };
}

/**
 * A Series' Family as its page shows it: only when >= 2 active member
 * Series exist (spec §2), so a lone Series displays no family concept at
 * all. Null otherwise.
 */
async function seriesFamily(ctx: QueryCtx, series: Doc<"series">) {
  if (!series.familyId) return null;
  const familyDoc = await ctx.db.get(series.familyId);
  if (!familyDoc || familyDoc.status !== "active") return null;
  const members = (
    await ctx.db
      .query("series")
      .withIndex("by_family", (q) => q.eq("familyId", familyDoc._id))
      .collect()
  ).filter((doc) => doc.status === "active");
  if (members.length < 2) return null;
  const memberById = new Map(members.map((m) => [m._id, m]));
  // Edges are stored once as "from is a {type} of to" (spec §2); the page
  // renders the sentence whichever end this Series is.
  const edges = (
    await Promise.all([
      ctx.db
        .query("seriesRelationships")
        .withIndex("by_from", (q) => q.eq("fromSeriesId", series._id))
        .collect(),
      ctx.db
        .query("seriesRelationships")
        .withIndex("by_to", (q) => q.eq("toSeriesId", series._id))
        .collect(),
    ])
  ).flat();
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
  return {
    name: familyDoc.name,
    // Reading order (familyPosition), then age; unplaced Series last. Each
    // with its jacket from the Series library, as search shows it, and
    // whether its art is Mature (the shelf conceals it per cover).
    members: await Promise.all(
      members
        .sort(
          (a, b) =>
            (a.familyPosition ?? Number.MAX_SAFE_INTEGER) -
              (b.familyPosition ?? Number.MAX_SAFE_INTEGER) || a.publicId - b.publicId,
        )
        .map(async (m) => {
          const stats = await ctx.db
            .query("seriesStats")
            .withIndex("by_series", (q) => q.eq("seriesId", m._id))
            .first();
          return {
            publicId: m.publicId,
            title: m.title,
            mature: m.mature === true,
            coverUrl: stats?.coverUrl ?? null,
            coverIsbn: statsCoverIsbns(stats),
          };
        }),
    ),
    relationships,
  };
}

/** Box sets read per Release on the Series page; a book is in a few at most. */
const BOX_SETS_PER_RELEASE = 8;

/**
 * Everything the Series page renders, shaped as the Reading Path hierarchy
 * (spec §10): the canonical Volume sequence leads
 * (ordered by Volume Position — the Label is display-only); each
 * Volume carries every covering Edition with its full ordered Coverage,
 * Edition Line membership, Releases, Variants, and Bundle cross-links. The
 * box sets holding its books come last, each with what it holds here.
 *
 * Returns null for unknown or hidden Series. For a merged Series it returns
 * the survivor's page — the route compares the requested public ID and slug
 * to the canonical ones and 301s on any mismatch (spec §11).
 */
export const seriesPage = query({
  args: { publicId: v.number() },
  handler: async (unbounded, { publicId }) => {
    // Every read below shares one queue (lib/boundedReads.ts): a long Series
    // with several runs hydrates more Editions at once than Convex lets one
    // function have reads in flight.
    const ctx = boundedReads(unbounded);
    const series = await resolveActiveSeries(ctx, publicId);
    if (!series) return null;

    // The family, the credits and the books share nothing, so they read
    // concurrently.
    const [family, credits, volumeDocs] = await Promise.all([
      seriesFamily(ctx, series),
      // Its authors, from ANN's staff credits or publishers' creator names (people.ts).
      creditsFor(ctx, series._id),
      // The canonical Volume sequence, in reading order.
      activeVolumes(ctx, series._id),
    ]);
    const volumeById = new Map(volumeDocs.map((doc) => [doc._id, doc]));

    // Every Edition hydrates at once, the queue starting at most
    // READ_CONCURRENCY reads at a time; Promise.all keeps them in the order
    // seriesEditions met them, which the reading paths are built from.
    const { editions: editionDocs } = await seriesEditions(ctx, series._id, volumeDocs);
    // Each box set holding a book of this Series, with what each such book
    // holds here (lib/boxSets.ts), filled while the Editions hydrate.
    const boxSetParts = new Map<Id<"releaseBundles">, BoxSetPart[]>();
    const editions = await Promise.all(
      [...editionDocs.values()].map(async (edition) => {
        const [publisher, line, coverageRows, releaseDocs] = await Promise.all([
          ctx.db.get(edition.publisherId),
          edition.editionLineId ? ctx.db.get(edition.editionLineId) : null,
          // The Edition's ordered Coverage within this Series.
          coverageOf(ctx, edition._id),
          releasesOf(ctx, edition._id).then((docs) =>
            docs.filter((doc) => doc.status === "active"),
          ),
        ]);

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

        // A book's jacket: the first stored cover among its Releases; the page
        // falls back to ISBN-derived art (lib/cover.tsx) when there is none.
        // Checked one Release at a time, so it reads no further than the first.
        let editionCover: string | null = null;
        for (const release of releaseDocs) {
          if (!release.coverImage) continue;
          editionCover = await coverUrl(ctx, release.coverImage.storageId);
          if (editionCover !== null) break;
        }
        const memberships = await Promise.all(
          releaseDocs.map((release) =>
            ctx.db
              .query("bundleMemberships")
              .withIndex("by_release", (q) => q.eq("releaseId", release._id))
              .take(BOX_SETS_PER_RELEASE),
          ),
        );
        const part: BoxSetPart = {
          seriesTitle: series.title,
          labels: coverage.map((cov) => cov.label),
          line:
            line && line.status === "active"
              ? { name: line.name, position: edition.linePosition ?? null }
              : null,
        };
        for (const membership of memberships.flat()) {
          boxSetParts.set(membership.bundleId, [
            ...(boxSetParts.get(membership.bundleId) ?? []),
            part,
          ]);
        }
        const releases = releaseDocs.map((release) => ({
          // The document id is what the signed-in overlay (collection and
          // reading quick actions on the shelf) addresses a Release by.
          id: release._id,
          format: release.format,
          isbn13: release.isbn13 ?? null,
          pubDate: release.pubDate ?? null,
        }));
        releases.sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));

        return {
          publicId: edition.publicId,
          publisher: publisherLink(publisher),
          lineName: line && line.status === "active" ? line.name : null,
          linePosition: edition.linePosition ?? null,
          coverage,
          coverUrl: editionCover,
          releases,
        };
      }),
    );

    // The reading paths the page offers; the first path's first book fronts
    // the Series (its cover and social card).
    const editionGroups = groupEditions(editions, await pathCombination(ctx, series));
    const volumes = volumeDocs.map((volume) => ({
      publicId: volume.publicId,
      position: volume.position,
      label: volume.label ?? null,
      synopsis: volume.synopsis ?? null,
    }));

    // The box sets, oldest first: each its own cover and what it holds here.
    const boxSets = [];
    for (const [bundleId, parts] of boxSetParts) {
      const bundle = await ctx.db.get(bundleId);
      if (!bundle || bundle.status !== "active") continue;
      boxSets.push({
        publicId: bundle.publicId,
        name: bundle.name,
        isbn13: bundle.isbn13 ?? null,
        pubDate: bundle.pubDate ?? null,
        coverUrl: await coverUrl(ctx, bundle.coverImage?.storageId),
        contents: boxSetContents(parts, false),
      });
    }
    boxSets.sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));

    // The book fronting the Series: its Edition page holds the cover's edit link.
    const front = editionGroups[0]?.books[0];
    const frontDoc = front
      ? [...editionDocs.values()].find((doc) => doc.publicId === front.publicId)
      : undefined;

    return {
      series: {
        publicId: series.publicId,
        title: series.title,
        altTitles: series.altTitles,
        sourceStatus: series.sourceStatus ?? null,
        synopsis: series.synopsis ?? null,
        /** The synopsis' source credit (lib/attribution.ts). */
        synopsisAttribution: await fieldAttribution(
          ctx,
          { type: "series", id: series._id },
          "synopsis",
          series.synopsis,
        ),
        /** Bookless Series (CONTEXT.md): volumes known, no English book attached yet. */
        bookless: series.bookless === true,
        /** Mature Series (lib/mature.ts): the page hides its art from viewers who have not opted in. */
        mature: series.mature === true,
      },
      family,
      credits,
      volumes,
      editionGroups,
      boxSets,
      coverUrl: front?.coverUrl ?? null,
      coverEdition: frontDoc
        ? { publicId: frontDoc.publicId, title: (await editionCoverage(ctx, frontDoc)).title }
        : null,
    };
  },
});
