// The Series library (/series): browse every Series with sort, filters,
// search, and pages. Reads go against `seriesStats`, one denormalized row
// per active Series that `rebuild` refreshes on a schedule (crons.ts) —
// so sorting by volume count, latest release, or followers is an index
// range, and the import write paths stay untouched. Rows lag the canonical
// records by at most one rebuild interval, which a browse page can afford.

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { coverUrl } from "./lib/covers";

export const SORTS = [
  "title",
  "recent",
  "volumes",
  "latest",
  "upcoming",
  "followers",
  "collectors",
] as const;
export type Sort = (typeof SORTS)[number];

const sortValidator = v.union(...SORTS.map((s) => v.literal(s)));
const statusValidator = v.union(
  v.literal("ongoing"),
  v.literal("completed"),
  v.literal("hiatus"),
  v.literal("cancelled"),
);

const PAGE_DEFAULT = 28;
const PAGE_MAX = 56;
// A filtered page keeps scanning the index in chunks until it fills; this
// bounds the scan so an over-selective filter can't read the whole table.
const SCAN_CHUNK = 120;
const SCAN_MAX = 1200;
const SEARCH_LIMIT = 60;

// ---------- Rebuild (scheduled) ----------

/** Series per mutation; each one reads its volumes, editions, and releases. */
const REBUILD_BATCH = 20;
/** Rows older than the run that just finished belong to hidden/merged Series. */
const STALE_SWEEP = 200;

/**
 * Rebuild every Series' stats row. Walks the series table in batches from an
 * action so no single mutation grows with the catalog, then sweeps rows whose
 * Series is no longer active. Idempotent; safe to run by hand:
 * `npx convex run seriesBrowse:rebuild`.
 */
export const rebuild = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    let cursor: number | null = null;
    let rows = 0;
    for (;;) {
      const batch: { next: number | null; count: number } = await ctx.runMutation(
        internal.seriesBrowse.rebuildBatch,
        { afterPublicId: cursor, rebuiltAt: startedAt },
      );
      rows += batch.count;
      if (batch.next === null) break;
      cursor = batch.next;
    }
    let swept = 0;
    for (;;) {
      const n: number = await ctx.runMutation(internal.seriesBrowse.sweepStale, {
        before: startedAt,
      });
      swept += n;
      if (n < STALE_SWEEP) break;
    }
    return { rows, swept, ms: Date.now() - startedAt };
  },
});

export const rebuildBatch = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()), rebuiltAt: v.number() },
  handler: async (ctx, { afterPublicId, rebuiltAt }) => {
    const docs = await ctx.db
      .query("series")
      .withIndex("by_publicId", (q) =>
        afterPublicId === null ? q : q.gt("publicId", afterPublicId),
      )
      .take(REBUILD_BATCH);
    let count = 0;
    for (const series of docs) {
      if (series.status !== "active") continue;
      await upsertStats(ctx, series, rebuiltAt);
      count++;
    }
    const last = docs[docs.length - 1];
    return { next: docs.length < REBUILD_BATCH || !last ? null : last.publicId, count };
  },
});

export const sweepStale = internalMutation({
  args: { before: v.number() },
  handler: async (ctx, { before }) => {
    const stale = await ctx.db
      .query("seriesStats")
      .withIndex("by_rebuiltAt", (q) => q.lt("rebuiltAt", before))
      .take(STALE_SWEEP);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

/** Compute and write one Series' row from its canonical records. */
async function upsertStats(ctx: MutationCtx, series: Doc<"series">, rebuiltAt: number) {
  const volumes = (
    await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect()
  ).filter((v) => v.status === "active");

  const editionIds = new Set<Id<"editions">>();
  for (const volume of volumes) {
    const rows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const row of rows) editionIds.add(row.editionId);
  }

  const publishers = new Map<string, { name: string; slug: string }>();
  let hasPhysical = false;
  let hasDigital = false;
  let releaseCount = 0;
  let first = 0;
  let latest = 0;
  let next = 0;
  let cover: { url: string | null; isbn: string | null } = { url: null, isbn: null };
  const collectors = new Set<string>();
  const today = todaySortKey();

  for (const editionId of editionIds) {
    const edition = await ctx.db.get(editionId);
    if (!edition || edition.status !== "active") continue;
    const publisher = await ctx.db.get(edition.publisherId);
    if (publisher && publisher.status === "active") {
      publishers.set(publisher.slug, { name: publisher.name, slug: publisher.slug });
    }
    const releases = (
      await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId))
        .collect()
    ).filter((r) => r.status === "active");
    for (const release of releases) {
      releaseCount++;
      if (release.format === "physical") hasPhysical = true;
      else hasDigital = true;
      const sort = release.pubDate?.sort ?? 0;
      if (sort > 0) {
        if (first === 0 || sort < first) first = sort;
        if (sort > latest) latest = sort;
        if (sort > today && (next === 0 || sort < next)) next = sort;
      }
      if (!cover.url) {
        const url = await coverUrl(ctx, release.coverImage?.storageId);
        if (url) cover = { url, isbn: release.isbn13 ?? cover.isbn };
        else if (!cover.isbn && release.isbn13 && release.format === "physical") {
          cover = { url: null, isbn: release.isbn13 };
        }
      }
      const entries = await ctx.db
        .query("collectionEntries")
        .withIndex("by_release", (q) => q.eq("releaseId", release._id))
        .collect();
      for (const entry of entries) collectors.add(entry.userId);
    }
  }
  if (!cover.isbn) {
    // No physical ISBN anywhere: a digital one still finds jacket art.
    for (const editionId of editionIds) {
      const any = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId))
        .filter((q) => q.neq(q.field("isbn13"), undefined))
        .first();
      if (any?.isbn13) {
        cover = { url: cover.url, isbn: any.isbn13 };
        break;
      }
    }
  }

  const followers = (
    await ctx.db
      .query("userSeriesStates")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect()
  ).filter((s) => s.following).length;

  const titleSort = sortKeyFor(series.title);
  const row = {
    seriesId: series._id,
    publicId: series.publicId,
    title: series.title,
    titleSort,
    letter: letterFor(titleSort),
    sourceStatus: series.sourceStatus ?? ("unknown" as const),
    publishers: [...publishers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    hasPhysical,
    hasDigital,
    volumeCount: volumes.length,
    releaseCount,
    firstReleaseSort: first,
    latestReleaseSort: latest,
    nextReleaseSort: next,
    followers,
    collectors: collectors.size,
    coverUrl: cover.url,
    coverIsbn: cover.isbn,
    rebuiltAt,
  };
  const existing = await ctx.db
    .query("seriesStats")
    .withIndex("by_series", (q) => q.eq("seriesId", series._id))
    .unique();
  if (existing) await ctx.db.replace(existing._id, row);
  else await ctx.db.insert("seriesStats", row);
}

/** "The Apothecary Diaries" → "apothecary diaries": articles don't shelve. */
export function sortKeyFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function letterFor(titleSort: string): string {
  const c = titleSort.charAt(0);
  return c >= "a" && c <= "z" ? c : "#";
}

function todaySortKey(now: Date = new Date()): number {
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

// ---------- Browse (public) ----------

type StatsRow = Doc<"seriesStats">;

const SORT_INDEX = {
  title: { index: "by_title", field: "titleSort", defaultOrder: "asc" },
  recent: { index: "by_publicId", field: "publicId", defaultOrder: "desc" },
  volumes: { index: "by_volumes", field: "volumeCount", defaultOrder: "desc" },
  latest: { index: "by_latest", field: "latestReleaseSort", defaultOrder: "desc" },
  upcoming: { index: "by_next", field: "nextReleaseSort", defaultOrder: "asc" },
  followers: { index: "by_followers", field: "followers", defaultOrder: "desc" },
  collectors: { index: "by_collectors", field: "collectors", defaultOrder: "desc" },
} as const satisfies Record<Sort, { index: string; field: keyof StatsRow; defaultOrder: "asc" | "desc" }>;

type Filters = {
  publisher?: string;
  status?: "ongoing" | "completed" | "hiatus" | "cancelled";
  format?: "physical" | "digital";
  letter?: string;
};

function matches(row: StatsRow, f: Filters): boolean {
  if (f.publisher && !row.publishers.some((p) => p.slug === f.publisher)) return false;
  if (f.status && row.sourceStatus !== f.status) return false;
  if (f.format === "physical" && !row.hasPhysical) return false;
  if (f.format === "digital" && !row.hasDigital) return false;
  if (f.letter && row.letter !== f.letter) return false;
  return true;
}

function card(row: StatsRow) {
  return {
    publicId: row.publicId,
    title: row.title,
    sourceStatus: row.sourceStatus,
    publishers: row.publishers,
    hasPhysical: row.hasPhysical,
    hasDigital: row.hasDigital,
    volumeCount: row.volumeCount,
    releaseCount: row.releaseCount,
    firstReleaseSort: row.firstReleaseSort,
    latestReleaseSort: row.latestReleaseSort,
    nextReleaseSort: row.nextReleaseSort,
    followers: row.followers,
    collectors: row.collectors,
    coverUrl: row.coverUrl,
    coverIsbn: row.coverIsbn,
  };
}

// Keyset cursor: the last row's sort value + publicId, which every sort
// index ends in, so a page resumes exactly where the previous one stopped
// even when many rows share a value (every zero-follower Series, say).
type Cursor = { v: string | number; id: number };

// Base64url over UTF-8 with the web APIs the Convex runtime provides
// (no Buffer there); titles in the cursor can be any script.
function encodeCursor(c: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Cursor>;
    if ((typeof c.v === "string" || typeof c.v === "number") && typeof c.id === "number") {
      return { v: c.v, id: c.id };
    }
  } catch {
    // a hand-edited cursor: start from the top
  }
  return null;
}

/**
 * One chunk of the sort index after `cursor`, at most `limit` rows. Two index
 * reads: the rest of the cursor's own value group, then everything past it.
 * Every sort index ends in publicId, which is what makes the cursor exact.
 * Spelled out per sort so each index range is fully typed.
 */
async function readChunk(
  ctx: QueryCtx,
  sort: Sort,
  order: "asc" | "desc",
  cursor: Cursor | null,
  limit: number,
): Promise<Array<StatsRow>> {
  const table = () => ctx.db.query("seriesStats");
  const asc = order === "asc";
  if (!cursor) {
    return await table().withIndex(SORT_INDEX[sort].index).order(order).take(limit);
  }
  const id = cursor.id;
  type IdRange<R> = { gt: (f: "publicId", v: number) => R; lt: (f: "publicId", v: number) => R };
  // The cursor's value group beyond its publicId, in sort direction.
  const same = <R>(r: IdRange<R>) => (asc ? r.gt("publicId", id) : r.lt("publicId", id));
  const num = cursor.v as number;
  const str = cursor.v as string;
  const [sameValue, rest] = (() => {
    switch (sort) {
      case "title":
        return [
          table().withIndex("by_title", (r) => same(r.eq("titleSort", str))),
          table().withIndex("by_title", (r) => (asc ? r.gt("titleSort", str) : r.lt("titleSort", str))),
        ] as const;
      case "recent":
        return [
          null,
          table().withIndex("by_publicId", (r) => (asc ? r.gt("publicId", id) : r.lt("publicId", id))),
        ] as const;
      case "volumes":
        return [
          table().withIndex("by_volumes", (r) => same(r.eq("volumeCount", num))),
          table().withIndex("by_volumes", (r) => (asc ? r.gt("volumeCount", num) : r.lt("volumeCount", num))),
        ] as const;
      case "latest":
        return [
          table().withIndex("by_latest", (r) => same(r.eq("latestReleaseSort", num))),
          table().withIndex("by_latest", (r) => (asc ? r.gt("latestReleaseSort", num) : r.lt("latestReleaseSort", num))),
        ] as const;
      case "upcoming":
        return [
          table().withIndex("by_next", (r) => same(r.eq("nextReleaseSort", num))),
          table().withIndex("by_next", (r) => (asc ? r.gt("nextReleaseSort", num) : r.lt("nextReleaseSort", num))),
        ] as const;
      case "followers":
        return [
          table().withIndex("by_followers", (r) => same(r.eq("followers", num))),
          table().withIndex("by_followers", (r) => (asc ? r.gt("followers", num) : r.lt("followers", num))),
        ] as const;
      case "collectors":
        return [
          table().withIndex("by_collectors", (r) => same(r.eq("collectors", num))),
          table().withIndex("by_collectors", (r) => (asc ? r.gt("collectors", num) : r.lt("collectors", num))),
        ] as const;
    }
  })();
  const head = sameValue ? await sameValue.order(order).take(limit) : [];
  if (head.length >= limit) return head;
  const tail = await rest.order(order).take(limit - head.length);
  return [...head, ...tail];
}

export const browse = query({
  args: {
    sort: sortValidator,
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    publisher: v.optional(v.string()),
    status: v.optional(statusValidator),
    format: v.optional(v.union(v.literal("physical"), v.literal("digital"))),
    letter: v.optional(v.string()),
    q: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const order = args.order ?? SORT_INDEX[args.sort].defaultOrder;
    const pageSize = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.pageSize ?? PAGE_DEFAULT)));
    const filters: Filters = {
      publisher: args.publisher || undefined,
      status: args.status,
      format: args.format,
      letter: args.letter && /^[a-z#]$/.test(args.letter) ? args.letter : undefined,
    };

    // Search is one page: the title index ranks, the sort then orders that
    // set in memory. Upcoming keeps "nothing announced" (0) at the end.
    const needle = args.q?.trim();
    if (needle) {
      const hits = await ctx.db
        .query("series")
        .withSearchIndex("search_title", (q) => q.search("searchText", needle))
        .take(SEARCH_LIMIT);
      const rows: Array<StatsRow> = [];
      for (const hit of hits) {
        if (hit.status !== "active") continue;
        const row = await ctx.db
          .query("seriesStats")
          .withIndex("by_series", (q) => q.eq("seriesId", hit._id))
          .unique();
        if (row && matches(row, filters)) rows.push(row);
      }
      const { field } = SORT_INDEX[args.sort];
      rows.sort((a, b) => {
        const av = a[field] as string | number;
        const bv = b[field] as string | number;
        if (args.sort === "upcoming" && (av === 0) !== (bv === 0)) return av === 0 ? 1 : -1;
        const cmp = av < bv ? -1 : av > bv ? 1 : a.publicId - b.publicId;
        return order === "asc" ? cmp : -cmp;
      });
      return { items: rows.slice(0, pageSize).map(card), nextCursor: null };
    }

    const filtered = Boolean(filters.publisher || filters.status || filters.format || filters.letter);
    let cursor = decodeCursor(args.cursor);
    // Ascending "upcoming" would start at the thousands of Series with
    // nothing announced (0); begin the range just past them instead.
    if (!cursor && args.sort === "upcoming" && order === "asc") {
      cursor = { v: 0, id: Number.MAX_SAFE_INTEGER };
    }
    // Collect one row past the page: finding it is how we know there is a
    // next page without guessing at the end of the index.
    const target = pageSize + 1;
    const items: Array<StatsRow> = [];
    let scanned = 0;
    let exhausted = false;
    // Unfiltered pages come straight off the index; filtered ones keep
    // reading chunks until the page fills or the scan budget is spent.
    while (items.length < target && !exhausted && scanned < SCAN_MAX) {
      const want = filtered ? SCAN_CHUNK : target - items.length;
      const chunk = await readChunk(ctx, args.sort, order, cursor, want);
      scanned += chunk.length;
      if (chunk.length < want) exhausted = true;
      for (const row of chunk) {
        if (matches(row, filters)) items.push(row);
        if (items.length === target) break;
      }
      const last = chunk[chunk.length - 1];
      if (last) cursor = { v: last[SORT_INDEX[args.sort].field], id: last.publicId };
    }
    const page = items.slice(0, pageSize);
    const edge = page[page.length - 1];
    const more = items.length > pageSize && edge !== undefined;
    return {
      items: page.map(card),
      nextCursor: more
        ? encodeCursor({ v: edge[SORT_INDEX[args.sort].field], id: edge.publicId })
        : null,
    };
  },
});

/** What the filter controls offer: active publishers, status counts, total. */
export const facets = query({
  args: {},
  handler: async (ctx) => {
    const publishers = (await ctx.db.query("publishers").take(500))
      .filter((p) => p.status === "active")
      .map((p) => ({ name: p.name, slug: p.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const counts = new Map<StatsRow["sourceStatus"], number>();
    let total = 0;
    // The stats table is one row per Series; counting it is the one full
    // scan this page does, and it is small (a few hundred bytes a row).
    for await (const row of ctx.db.query("seriesStats")) {
      total++;
      counts.set(row.sourceStatus, (counts.get(row.sourceStatus) ?? 0) + 1);
    }
    return {
      publishers,
      total,
      statuses: [...counts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});
