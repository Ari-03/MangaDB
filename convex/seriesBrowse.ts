// The Series library (/series): browse every Series with filters, a sort,
// title search, and pages. Reads go against `seriesStats`, one denormalized
// row per active Series that `rebuild` refreshes on a schedule (crons.ts),
// so the import write paths stay untouched. Rows lag the canonical records
// by at most one rebuild interval, which a browse page can afford.
//
// Filters first, then the sort. An unfiltered shelf pages straight off the
// chosen sort's index. Any filter or title search instead reads every
// Series' filter-and-sort facts, keeps the matches, sorts them in memory,
// and pages that set, so every combination returns full pages and an exact
// total; only the page's own rows are then fetched for their cards.
//
// Those facts are packed about a thousand Series to a document
// (`seriesStatsPacks`, written at the end of each rebuild and read once a
// complete set exists) because reads cost per document: scanning the 5,488
// rows took ~2.2 s on the local backend, the packs ~100-170 ms. Measured
// with getTransactionMetrics, a filtered page reads 65 documents and 2.0 MB
// (8 packs, the largest ~380 KB of the 1 MB document limit); per-query
// limits are 16 MiB and 32,000 documents (8 MiB / 16,384 on older Convex),
// so bytes are the ceiling, at about 8x (4x) today's catalog.

import { ConvexError, v, type Infer, type ObjectType } from "convex/values";

import { internal } from "./_generated/api";
import { recountCatalog } from "./catalog";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { coverUrl, seriesCoverIsbn, type SeriesCoverCandidate } from "./lib/covers";
import { timingNeedsToday, todaySortKey } from "./lib/dates";
import { searchWords } from "./lib/searchMatch";

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
    // Then the packs the filtered views read, from the rows as they now are.
    let blocks = 0;
    for (;;) {
      const more: boolean = await ctx.runMutation(internal.seriesBrowse.repackBlock, { block: blocks });
      blocks++;
      if (!more) break;
    }
    // The home page's catalog totals ride along on the same schedule.
    const counts = await recountCatalog(ctx);
    return { rows, swept, blocks, counts, ms: Date.now() - startedAt };
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

/**
 * Rows this run did not touch are candidates, but a row only goes when its
 * Series is really gone (hidden, merged, deleted): two runs can overlap — a
 * manual one beside the cron — and the earlier-started run rewrites rows
 * with its older timestamp. An active Series' row is stamped forward
 * instead so it leaves the candidate set.
 */
export const sweepStale = internalMutation({
  args: { before: v.number() },
  handler: async (ctx, { before }) => {
    const stale = await ctx.db
      .query("seriesStats")
      .withIndex("by_rebuiltAt", (q) => q.lt("rebuiltAt", before))
      .take(STALE_SWEEP);
    for (const row of stale) {
      const series = await ctx.db.get(row.seriesId);
      if (series && series.status === "active") {
        await ctx.db.patch(row._id, { rebuiltAt: before });
      } else {
        await ctx.db.delete(row._id);
      }
    }
    return stale.length;
  },
});

/** Series per pack: block k covers publicIds [k * PACK_SPAN, (k + 1) * PACK_SPAN). */
const PACK_SPAN = 1000;
/** Packs a reader takes at most: room for 100k publicIds. */
const MAX_PACKS = 100;

/**
 * Rewrite pack `block` from the seriesStats rows in its publicId span,
 * dropping it when the span is empty. Returns whether any row lies past the
 * span; when none does, packs beyond it (a shrunken catalog) go too, and the
 * set is complete: the first time, this publishes it to readers
 * (appConfig.seriesPacksReady). Later runs replace packs in place, so the
 * set stays complete, if up to a rebuild stale.
 */
export const repackBlock = internalMutation({
  args: { block: v.number() },
  handler: async (ctx, { block }) => {
    const from = block * PACK_SPAN;
    const to = from + PACK_SPAN;
    const rows = await ctx.db
      .query("seriesStats")
      .withIndex("by_publicId", (q) => q.gte("publicId", from).lt("publicId", to))
      .take(PACK_SPAN);
    const entries = rows.map(entryOf);
    const existing = await ctx.db
      .query("seriesStatsPacks")
      .withIndex("by_block", (q) => q.eq("block", block))
      .unique();
    if (existing && entries.length === 0) await ctx.db.delete(existing._id);
    else if (existing) await ctx.db.replace(existing._id, { block, entries });
    else if (entries.length > 0) await ctx.db.insert("seriesStatsPacks", { block, entries });

    const more = await ctx.db
      .query("seriesStats")
      .withIndex("by_publicId", (q) => q.gte("publicId", to))
      .first();
    if (!more) {
      const beyond = await ctx.db
        .query("seriesStatsPacks")
        .withIndex("by_block", (q) => q.gt("block", block))
        .take(MAX_PACKS);
      for (const pack of beyond) await ctx.db.delete(pack._id);
      const config = await ctx.db.query("appConfig").first();
      if (!config) await ctx.db.insert("appConfig", { bootstrapMode: false, seriesPacksReady: true });
      else if (!config.seriesPacksReady) await ctx.db.patch(config._id, { seriesPacksReady: true });
    }
    return more !== null;
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
  // Each Edition's first covered Volume, for the cover pick.
  const firstPosition = new Map<Id<"editions">, number>();
  for (const volume of volumes) {
    const rows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const row of rows) {
      editionIds.add(row.editionId);
      if (!firstPosition.has(row.editionId)) firstPosition.set(row.editionId, volume.position);
    }
  }

  const publishers = new Map<string, { name: string; slug: string }>();
  let hasPhysical = false;
  let hasDigital = false;
  let releaseCount = 0;
  let first = 0;
  let latest = 0;
  let next = 0;
  let lastReleased = 0;
  let storedCover: string | null = null;
  const coverCandidates: SeriesCoverCandidate[] = [];
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
        // A month-precision date (yyyymm00) in the current month is still
        // to come — its day is unannounced, not past.
        const forthcoming = sort > today || (sort % 100 === 0 && sort >= today - (today % 100));
        if (forthcoming) {
          if (next === 0 || sort < next) next = sort;
        } else if (sort > lastReleased) {
          lastReleased = sort;
        }
      }
      storedCover ??= await coverUrl(ctx, release.coverImage?.storageId);
      coverCandidates.push({
        ...release,
        inLine: edition.editionLineId !== undefined,
        position: firstPosition.get(editionId) ?? Number.MAX_SAFE_INTEGER,
      });
      const entries = await ctx.db
        .query("collectionEntries")
        .withIndex("by_release", (q) => q.eq("releaseId", release._id))
        .collect();
      for (const entry of entries) collectors.add(entry.userId);
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
    lastReleasedSort: lastReleased,
    searchKey: searchKeyFor([series.title, ...series.altTitles]),
    followers,
    collectors: collectors.size,
    coverUrl: storedCover,
    coverIsbn: seriesCoverIsbn(coverCandidates),
    rebuiltAt,
  };
  const existing = await ctx.db
    .query("seriesStats")
    .withIndex("by_series", (q) => q.eq("seriesId", series._id))
    .unique();
  if (existing) {
    // Never move the stamp backwards: an overlapping older run must not
    // make a fresher row look stale to the newer run's sweep.
    await ctx.db.replace(existing._id, {
      ...row,
      rebuiltAt: Math.max(existing.rebuiltAt, rebuiltAt),
    });
  } else {
    await ctx.db.insert("seriesStats", row);
  }
}

/** "The Apothecary Diaries" → "apothecary diaries": articles don't shelve. */
export function sortKeyFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Title and alt titles as the distinct `searchWords` the library's title
 * filter matches against: ["Pokémon: Red", "Pokemon"] → "pokemon red". The
 * filter splits a query with `searchWords` too, so both sides agree.
 */
export function searchKeyFor(texts: ReadonlyArray<string>): string {
  return [...new Set(searchWords(texts.join(" ")))].join(" ");
}

export function letterFor(titleSort: string): string {
  const c = titleSort.charAt(0);
  return c >= "a" && c <= "z" ? c : "#";
}

/** True for a plausible yyyymmdd day key (month 1-12, day 1-31). */
function isDayKey(key: number): boolean {
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  return Number.isInteger(key) && key >= 10000101 && key <= 99991231 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}


// ---------- Browse (public) ----------

type StatsRow = Doc<"seriesStats">;
/** One Series' filter-and-sort facts, as packed in seriesStatsPacks. */
type Entry = Doc<"seriesStatsPacks">["entries"][number];

/**
 * A row's pack entry. Rows written before searchKey and lastReleasedSort
 * existed fall back to the title and the latest date (which may be
 * announced, not out) until their next rebuild.
 */
function entryOf(row: StatsRow): Entry {
  return {
    publicId: row.publicId,
    titleSort: row.titleSort,
    searchKey: row.searchKey ?? row.titleSort,
    sourceStatus: row.sourceStatus,
    publishers: row.publishers,
    hasPhysical: row.hasPhysical,
    hasDigital: row.hasDigital,
    volumeCount: row.volumeCount,
    latestReleaseSort: row.latestReleaseSort,
    nextReleaseSort: row.nextReleaseSort,
    lastReleasedSort: row.lastReleasedSort ?? row.latestReleaseSort,
    followers: row.followers,
    collectors: row.collectors,
  };
}

/**
 * Every Series' entry: the packs, a handful of documents. Until the first
 * rebuild has finished writing them (a partial set would drop Series and
 * shrink totals), the rows themselves, one document each.
 */
async function allEntries(ctx: QueryCtx): Promise<Array<Entry>> {
  const config = await ctx.db.query("appConfig").first();
  if (config?.seriesPacksReady) {
    const packs = await ctx.db.query("seriesStatsPacks").withIndex("by_block").take(MAX_PACKS);
    return packs.flatMap((pack) => pack.entries);
  }
  const entries: Array<Entry> = [];
  for await (const row of ctx.db.query("seriesStats")) entries.push(entryOf(row));
  return entries;
}

const SORT_INDEX = {
  title: { index: "by_title", field: "titleSort", defaultOrder: "asc" },
  recent: { index: "by_publicId", field: "publicId", defaultOrder: "desc" },
  volumes: { index: "by_volumes", field: "volumeCount", defaultOrder: "desc" },
  latest: { index: "by_latest", field: "latestReleaseSort", defaultOrder: "desc" },
  upcoming: { index: "by_next", field: "nextReleaseSort", defaultOrder: "asc" },
  followers: { index: "by_followers", field: "followers", defaultOrder: "desc" },
  collectors: { index: "by_collectors", field: "collectors", defaultOrder: "desc" },
} as const satisfies Record<
  Sort,
  { index: string; field: keyof StatsRow & keyof Entry; defaultOrder: "asc" | "desc" }
>;

const volumesValidator = v.union(
  v.literal("one"),
  v.literal("2-5"),
  v.literal("6-15"),
  v.literal("16-plus"),
);
/** Volume count buckets, inclusive at both ends. */
const VOLUME_RANGES: Record<Infer<typeof volumesValidator>, { min: number; max: number }> = {
  one: { min: 1, max: 1 },
  "2-5": { min: 2, max: 5 },
  "6-15": { min: 6, max: 15 },
  "16-plus": { min: 16, max: Number.POSITIVE_INFINITY },
};

const timingValidator = v.union(
  v.literal("upcoming"),
  v.literal("past-3m"),
  v.literal("past-6m"),
  v.literal("past-12m"),
  v.literal("finished"),
);
type Timing = Infer<typeof timingValidator>;
const RECENT_MONTHS = { "past-3m": 3, "past-6m": 6, "past-12m": 12 } as const;
/** "Finished" means no release in this many months (and nothing announced). */
const FINISHED_QUIET_MONTHS = 12;

/** Every filter the library offers; setting any one moves `browse` to the filtered path. */
const filterArgs = {
  /** Publisher slugs; a Series matches when any of its Publishers is listed. */
  publishers: v.optional(v.array(v.string())),
  volumes: v.optional(volumesValidator),
  timing: v.optional(timingValidator),
  status: v.optional(statusValidator),
  format: v.optional(v.union(v.literal("physical"), v.literal("digital"))),
  /** "a".."z", or "#" for titles that start with anything else. */
  letter: v.optional(v.string()),
  /** Title search: every typed word must start a word of the title or an alt title. */
  q: v.optional(v.string()),
};
type Filters = ObjectType<typeof filterArgs>;

/** The yyyymm00 key for the start of the month `months` before `today`'s. */
function monthsBefore(today: number, months: number): number {
  const index = Math.floor(today / 10000) * 12 + (Math.floor(today / 100) % 100) - 1 - months;
  return Math.floor(index / 12) * 10000 + ((index % 12) + 1) * 100;
}

/**
 * Release timing, from the row's derived dates:
 * - upcoming: an Upcoming Release is announced (nextReleaseSort).
 * - past-Nm: a release came out since the start of the month N months ago,
 *   so a month-precision date (yyyymm00) in that month counts.
 * - finished: nothing announced, the last release is over a year old, and
 *   the Source Status is not Ongoing or Hiatus. Source Status is mostly
 *   unknown today, so this is the English run's quiet end, finished or
 *   stalled; a Series whose final volume just came out reads as recent
 *   until a year has passed.
 * All but upcoming count back from `today` (`timingNeedsToday`), the
 * caller's `todaySort` (or the first page's, carried in the cursor): a
 * cached query must not read the clock, or a result from an earlier day
 * could keep serving an old cutoff.
 */
function timingTest(timing: Timing, today: number | undefined): (entry: Entry) => boolean {
  if (!timingNeedsToday(timing)) return (entry) => entry.nextReleaseSort > 0;
  if (today === undefined || !isDayKey(today)) {
    throw new ConvexError({
      code: "invalidField",
      message: `The "${timing}" timing needs todaySort, today's yyyymmdd (UTC).`,
    });
  }
  switch (timing) {
    case "past-3m":
    case "past-6m":
    case "past-12m": {
      const from = monthsBefore(today, RECENT_MONTHS[timing]);
      return (entry) => entry.lastReleasedSort >= from;
    }
    case "finished": {
      const quietSince = monthsBefore(today, FINISHED_QUIET_MONTHS);
      return (entry) =>
        entry.nextReleaseSort === 0 &&
        entry.lastReleasedSort > 0 &&
        entry.lastReleasedSort < quietSince &&
        entry.sourceStatus !== "ongoing" &&
        entry.sourceStatus !== "hiatus";
    }
  }
}

/**
 * One predicate for every filter that is set, or null when none is (the
 * unfiltered shelf). Values are resolved once here rather than per row.
 */
function matcher(f: Filters, today: number | undefined): ((entry: Entry) => boolean) | null {
  const tests: Array<(entry: Entry) => boolean> = [];
  const publishers = new Set(f.publishers?.filter(Boolean));
  if (publishers.size > 0) tests.push((entry) => entry.publishers.some((p) => publishers.has(p.slug)));
  if (f.volumes) {
    const { min, max } = VOLUME_RANGES[f.volumes];
    tests.push((entry) => entry.volumeCount >= min && entry.volumeCount <= max);
  }
  if (f.timing) tests.push(timingTest(f.timing, today));
  const { status, format, letter } = f;
  if (status) tests.push((entry) => entry.sourceStatus === status);
  if (format === "physical") tests.push((entry) => entry.hasPhysical);
  if (format === "digital") tests.push((entry) => entry.hasDigital);
  if (letter && /^[a-z#]$/.test(letter)) tests.push((entry) => letterFor(entry.titleSort) === letter);
  const words = searchWords(f.q ?? "");
  if (words.length > 0) {
    tests.push((entry) => {
      const key = ` ${entry.searchKey}`;
      return words.every((word) => key.includes(` ${word}`));
    });
  }
  return tests.length > 0 ? (entry) => tests.every((test) => test(entry)) : null;
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
// even when many rows share a value (every zero-follower Series, say). Both
// paths use it, so a Series added or hidden between requests shifts nothing
// already seen. A filtered page also carries the day its timing filter
// counted from (`t`), so later pages filter the same set as the first even
// when the view is paged across UTC midnight.
type Cursor = { v: string | number; id: number; t?: number };

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
      return { v: c.v, id: c.id, t: typeof c.t === "number" ? c.t : undefined };
    }
  } catch {
    // a hand-edited cursor: start from the top
  }
  return null;
}

/**
 * One chunk of the sort index after `cursor`, at most `limit` rows, drained
 * from a short list of index ranges: the rest of the cursor's own value
 * group, then everything past it. Every sort index ends in publicId, which
 * is what makes the cursor exact. Ascending "upcoming" shelves the Series
 * with nothing announced (0) after every dated one, as the filtered path's
 * `compare` does. Spelled out per sort so each index range is fully typed.
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
  const zerosAfter = (id: number) =>
    table().withIndex("by_next", (r) => r.eq("nextReleaseSort", 0).gt("publicId", id));
  const zerosLast = sort === "upcoming" && asc;
  const ranges = (() => {
    if (zerosLast && !cursor) {
      return [table().withIndex("by_next", (r) => r.gt("nextReleaseSort", 0)), zerosAfter(-1)];
    }
    if (zerosLast && cursor?.v === 0) return [zerosAfter(cursor.id)];
    if (!cursor) return [table().withIndex(SORT_INDEX[sort].index)];
    const id = cursor.id;
    type IdRange<R> = { gt: (f: "publicId", v: number) => R; lt: (f: "publicId", v: number) => R };
    // The cursor's value group beyond its publicId, in sort direction.
    const same = <R>(r: IdRange<R>) => (asc ? r.gt("publicId", id) : r.lt("publicId", id));
    const num = cursor.v as number;
    const str = cursor.v as string;
    switch (sort) {
      case "title":
        return [
          table().withIndex("by_title", (r) => same(r.eq("titleSort", str))),
          table().withIndex("by_title", (r) => (asc ? r.gt("titleSort", str) : r.lt("titleSort", str))),
        ];
      case "recent":
        return [table().withIndex("by_publicId", (r) => same(r))];
      case "volumes":
        return [
          table().withIndex("by_volumes", (r) => same(r.eq("volumeCount", num))),
          table().withIndex("by_volumes", (r) => (asc ? r.gt("volumeCount", num) : r.lt("volumeCount", num))),
        ];
      case "latest":
        return [
          table().withIndex("by_latest", (r) => same(r.eq("latestReleaseSort", num))),
          table().withIndex("by_latest", (r) => (asc ? r.gt("latestReleaseSort", num) : r.lt("latestReleaseSort", num))),
        ];
      case "upcoming":
        return [
          table().withIndex("by_next", (r) => same(r.eq("nextReleaseSort", num))),
          table().withIndex("by_next", (r) => (asc ? r.gt("nextReleaseSort", num) : r.lt("nextReleaseSort", num))),
          ...(zerosLast ? [zerosAfter(-1)] : []),
        ];
      case "followers":
        return [
          table().withIndex("by_followers", (r) => same(r.eq("followers", num))),
          table().withIndex("by_followers", (r) => (asc ? r.gt("followers", num) : r.lt("followers", num))),
        ];
      case "collectors":
        return [
          table().withIndex("by_collectors", (r) => same(r.eq("collectors", num))),
          table().withIndex("by_collectors", (r) => (asc ? r.gt("collectors", num) : r.lt("collectors", num))),
        ];
    }
  })();
  const rows: Array<StatsRow> = [];
  for (const range of ranges) {
    if (rows.length >= limit) break;
    rows.push(...(await range.order(order).take(limit - rows.length)));
  }
  return rows;
}

/** Whether the row's Series is still an active, unmerged public record. */
async function stillPublic(ctx: QueryCtx, row: StatsRow): Promise<boolean> {
  const series = await ctx.db.get(row.seriesId);
  return series !== null && series.status === "active" && !series.mergedIntoId;
}

/**
 * One page of the library: `items`, the `nextCursor` to pass back for the
 * following page (null at the end), and `total`, the number of Series the
 * filters match, or null for the unfiltered shelf (facets' total is that).
 * The total can include a Series hidden since the last rebuild; it is
 * skipped when a page reaches it. `todaySort` (today's yyyymmdd, UTC) is
 * required with the timings that count back from today (past-Nm, finished);
 * a cursor from such a view brings the first page's day along, and the
 * cursor's day wins over `todaySort`.
 */
export const browse = query({
  args: {
    sort: sortValidator,
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    ...filterArgs,
    todaySort: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const order = args.order ?? SORT_INDEX[args.sort].defaultOrder;
    const pageSize = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.pageSize ?? PAGE_DEFAULT)));
    const { field } = SORT_INDEX[args.sort];
    const keyOf = (row: StatsRow | Entry): Cursor => ({ v: row[field], id: row.publicId });
    const after = decodeCursor(args.cursor);
    const today = after?.t ?? args.todaySort;
    const test = matcher(args, today);

    if (test) {
      // Filters pick the set from the packs (the cost is in the header
      // comment). Then the sort orders it, nothing announced last on
      // "upcoming", and the page resumes after the cursor's entry.
      const entries = (await allEntries(ctx)).filter(test);
      const compare = (a: Cursor, b: Cursor) => {
        if (args.sort === "upcoming" && (a.v === 0) !== (b.v === 0)) return a.v === 0 ? 1 : -1;
        const cmp = a.v < b.v ? -1 : a.v > b.v ? 1 : a.id - b.id;
        return order === "asc" ? cmp : -cmp;
      };
      entries.sort((a, b) => compare(keyOf(a), keyOf(b)));
      const start = after ? entries.findIndex((entry) => compare(keyOf(entry), after) > 0) : 0;
      const items: Array<StatsRow> = [];
      let examined = start < 0 ? entries.length : start;
      for (const entry of entries.slice(examined)) {
        if (items.length === pageSize) break;
        examined++;
        const row = await ctx.db
          .query("seriesStats")
          .withIndex("by_publicId", (q) => q.eq("publicId", entry.publicId))
          .unique();
        // Entries lag their Series by up to a rebuild; a Series hidden or
        // merged since must not surface from the library meanwhile.
        if (row && (await stillPublic(ctx, row))) items.push(row);
      }
      const edge = entries[examined - 1];
      return {
        items: items.map(card),
        nextCursor:
          examined < entries.length && edge ? encodeCursor({ ...keyOf(edge), t: today }) : null,
        total: entries.length,
      };
    }

    // Unfiltered: straight off the sort index. Collect one row past the page:
    // finding it is how we know there is a next page.
    const target = pageSize + 1;
    const items: Array<StatsRow> = [];
    let cursor = after;
    for (;;) {
      const want = target - items.length;
      const chunk = await readChunk(ctx, args.sort, order, cursor, want);
      for (const row of chunk) {
        if (await stillPublic(ctx, row)) items.push(row);
      }
      const last = chunk[chunk.length - 1];
      if (!last || chunk.length < want || items.length === target) break;
      cursor = keyOf(last);
    }
    const page = items.slice(0, pageSize);
    const edge = page[page.length - 1];
    return {
      items: page.map(card),
      nextCursor: items.length > pageSize && edge ? encodeCursor(keyOf(edge)) : null,
      total: null,
    };
  },
});

/**
 * What the filter panel offers: every Publisher with a Series in the
 * library and how many it has, the total Series count, and counts per
 * Source Status. Publishers come from the packed entries themselves, so a
 * listed slug always filters to something.
 */
export const facets = query({
  args: {},
  handler: async (ctx) => {
    const publishers = new Map<string, { name: string; slug: string; count: number }>();
    const statuses = new Map<Entry["sourceStatus"], number>();
    // The same pack read as a filtered browse.
    const entries = await allEntries(ctx);
    for (const entry of entries) {
      statuses.set(entry.sourceStatus, (statuses.get(entry.sourceStatus) ?? 0) + 1);
      for (const publisher of entry.publishers) {
        const entry = publishers.get(publisher.slug);
        if (entry) entry.count++;
        else publishers.set(publisher.slug, { ...publisher, count: 1 });
      }
    }
    return {
      publishers: [...publishers.values()].sort((a, b) => a.name.localeCompare(b.name)),
      total: entries.length,
      statuses: [...statuses.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

