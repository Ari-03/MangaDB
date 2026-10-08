// A frozen copy of the Publishers board builder as it stood at ce80597,
// before computeBoard's two views shared one set of month reads
// (publisher.ts monthInputs). Test-only: publisher.test.ts checks the
// current builder's output against it, byte for byte, and compares what
// each reads. It is not a second implementation to keep in step; when the
// board's output changes on purpose, delete it and the oracle tests.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { PUBLISHER_SCAN_CAP } from "./catalog";
import { boundedReads } from "./lib/boundedReads";
import { visibleTo } from "./lib/mature";
import { seriesStatsRow } from "./lib/seriesStats";
import { BOARD_COVER_CAP } from "./publisher";
import { browseCache, joinBrowseRows, memoize, WINDOW_CAP, type BrowseCache } from "./releases";

const EDITION_RELEASE_CAP = 50;

/** A Release on the board with the active Series it keeps. */
type BoardRow = { release: Doc<"releases">; series: Array<Doc<"series">> };

/**
 * One month's visible Canonical Releases grouped by Publisher, in window
 * (date) order. Same window and visibility as the Releases browser
 * (monthBrowse + joinBrowseRows): active Releases dated inside the month
 * (`fromSort` is its yyyymm00 key), whose Edition is active and which keep
 * at least one active Series, each with those Series; books of a Mature
 * Series only with `showMature`. Lookups go through the caller's `cache`,
 * in parallel. A null month (malformed input) is an empty window.
 */
async function visibleMonth(
  ctx: QueryCtx,
  cache: BrowseCache,
  fromSort: number | null,
  showMature: boolean,
) {
  // yyyymm00 (month-precision) … yyyymm99 covers every day of the month.
  // Active rows only, off the status-led index like monthBrowse: hidden and
  // merged Releases neither cost reads nor push active ones past the cap.
  const windowDocs =
    fromSort === null
      ? []
      : await ctx.db
          .query("releases")
          .withIndex("by_status_date", (q) =>
            q
              .eq("status", "active")
              .gte("pubDate.sort", fromSort)
              .lte("pubDate.sort", fromSort + 99),
          )
          .take(WINDOW_CAP);

  const rows = await Promise.all(
    windowDocs.map(async (release): Promise<BoardRow | null> => {
      const edition = await cache.edition(release.editionId);
      if (!edition || edition.status !== "active") return null;
      const series = (await Promise.all(release.seriesIds.map(cache.series))).flatMap((doc) =>
        doc?.status === "active" ? [doc] : [],
      );
      if (!showMature && series.some((doc) => doc.mature)) return null;
      return series.length > 0 ? { release, series } : null;
    }),
  );
  const byPublisher = new Map<Id<"publishers">, Array<BoardRow>>();
  for (const row of rows) {
    if (!row) continue;
    const list = byPublisher.get(row.release.publisherId);
    if (list) list.push(row);
    else byPublisher.set(row.release.publisherId, [row]);
  }
  return byPublisher;
}

/**
 * What each Publisher is releasing in one month, plus the A–Z directory of
 * every active Publisher: the Publishers board's data (`monthBoard` below).
 *
 * `board` has one entry per Publisher with visible Releases that month,
 * busiest first: counts by Format, distinct Series, how many of those are
 * new series (see `debutSeries`), last month's count for a delta, and a few
 * joined rows (joinBrowseRows) for the cover strip. Imprints are Publishers
 * of their own, so they get their own cards and name their parent. Every
 * lookup shares one memo cache (`browseCache`).
 *
 * `directory` lists every active Publisher A–Z with its month count;
 * imprints nest under an active parent (one level, spec'd on the schema),
 * defunct ones are flagged. A malformed month reads as an empty board.
 *
 * Without `showMature`, books of Mature Series and adult-only Publishers
 * are left out of every count, strip, and directory entry (lib/mature.ts).
 * Pass one `cache` to build both views of a month from the same reads, made
 * from the same bounded ctx (lib/boundedReads.ts) so its reads and the
 * board's own share one queue.
 */
async function buildMonthBoard(
  unbounded: QueryCtx,
  year: number,
  month: number,
  showMature: boolean,
  cache?: BrowseCache,
) {
  // A busy month's rows join at once; every read waits its turn in one queue.
  const ctx = boundedReads(unbounded);
  cache ??= browseCache(ctx);
  const fromSort = monthOk(year, month) ? year * 10000 + month * 100 : null;
  const previousSort =
    fromSort === null ? null : month === 1 ? fromSort - 10000 + 1100 : fromSort - 100;

  const [publisherDocs, current, previous] = await Promise.all([
    ctx.db.query("publishers").take(PUBLISHER_SCAN_CAP),
    visibleMonth(ctx, cache, fromSort, showMature),
    visibleMonth(ctx, cache, previousSort, showMature),
  ]);
  const active = new Map(
    publisherDocs
      .filter(
        (doc) => doc.status === "active" && visibleTo(showMature, doc.contentRating === "mature"),
      )
      .map((doc) => [doc._id, doc]),
  );
  const parentOf = (doc: Doc<"publishers">) =>
    doc.parentPublisherId ? (active.get(doc.parentPublisherId) ?? null) : null;

  // The Series an Edition debuts, or null. A debut is a standard Edition
  // (no Edition Line, so not a Deluxe Vol. 1 repackaging) whose coverage
  // includes an active Volume at Position 1, with no active Release dated
  // before this month in that Edition (a digital Release of a 2019 print
  // Vol. 1 is a backfill) nor anywhere in the Series (a relaunch of a 2005
  // Series is not new). The Series-wide check reads the rebuilt
  // `seriesStats.firstReleaseSort`, so it lags by up to a rebuild; a Series
  // without a stats row yet has no known earlier Release. A year-only date
  // this year (yyyy0000) may well be this month, so it is no evidence of
  // an earlier Release; an earlier month of this year is. Memoized per
  // Edition; the Release checks read only the few Vol. 1 Editions.
  const debutSeries = memoize(async (editionId: Id<"editions">) => {
    const edition = await cache.edition(editionId);
    if (!edition || edition.editionLineId || fromSort === null) return null;
    const earlier = (sort: number) => sort > 0 && sort < fromSort && sort !== year * 10000;
    let seriesId: Id<"series"> | null = null;
    for (const row of await cache.coverage(edition._id)) {
      const volume = await cache.volume(row.volumeId);
      if (volume?.status === "active" && volume.position === 1) {
        seriesId = volume.seriesId;
        break;
      }
    }
    if (!seriesId) return null;
    const siblings = await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
      .take(EDITION_RELEASE_CAP);
    if (siblings.some((doc) => doc.status === "active" && earlier(doc.pubDate?.sort ?? 0))) {
      return null;
    }
    const stats = await seriesStatsRow(ctx, seriesId);
    return earlier(stats?.firstReleaseSort ?? 0) ? null : seriesId;
  });

  // Whether a Release has jacket art the strip can show: a stored cover,
  // or an ISBN to fetch it by. Read through the cache, so joinBrowseRows
  // reuses the lookup for the picks.
  const hasArt = async (release: Doc<"releases">) => {
    const cover = await cache.cover(release);
    return cover.coverUrl !== null || cover.coverIsbns.length > 0;
  };

  const cards = await Promise.all(
    [...current].map(async ([publisherId, rows]) => {
      const publisher = active.get(publisherId);
      // Rows of an inactive Publisher show unattributed in the browser;
      // there is no card to hang them on.
      if (!publisher) return null;

      const series = new Set(rows.flatMap((row) => row.series.map((doc) => doc._id)));
      const debuts = await Promise.all(
        rows.map(async ({ release }) => {
          const debut = await debutSeries(release.editionId);
          return debut !== null && series.has(debut) ? debut : null;
        }),
      );
      const newSeries = new Set(debuts.flatMap((debut) => (debut ? [debut] : [])));
      const physical = rows.filter((row) => row.release.format === "physical").length;

      // The cover strip: one Release per Series, preferring ones with art
      // (stored, or an ISBN to fetch it by), then new series, then physical
      // over digital (a shelf shows the jacket), else date then title order.
      // Candidates are ranked before any join, then walked in (new series,
      // Format) order in batches of BOARD_COVER_CAP tested for art in
      // parallel. A batch holds only candidates that can still change the
      // picks (a lead Series with no art found yet) and at most one per
      // Series; a second one waits for the next batch, in case the first
      // has no art. Stop at BOARD_COVER_CAP Series with art and fill from
      // the best artless ones; only the picks get joined.
      const ranked = rows
        .map((row, index) => ({
          ...row,
          rank: (debuts[index] ? 0 : 2) + (row.release.format === "physical" ? 0 : 1),
        }))
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            (a.release.pubDate?.sort ?? 0) - (b.release.pubDate?.sort ?? 0) ||
            (a.series[0]?.title ?? "").localeCompare(b.series[0]?.title ?? ""),
        );
      const withArt: Array<Doc<"releases">> = [];
      const artless = new Map<Id<"series">, Doc<"releases">>();
      const artSeries = new Set<Id<"series">>();
      let next = 0;
      while (withArt.length < BOARD_COVER_CAP && next < ranked.length) {
        const batch: Array<{ release: Doc<"releases">; lead: Id<"series"> }> = [];
        while (batch.length < BOARD_COVER_CAP && next < ranked.length) {
          const {
            release,
            series: [lead],
          } = ranked[next]!;
          if (lead && batch.some((entry) => entry.lead === lead._id)) break;
          next++;
          if (lead && !artSeries.has(lead._id)) batch.push({ release, lead: lead._id });
        }
        const art = await Promise.all(batch.map(({ release }) => hasArt(release)));
        for (const [i, { release, lead }] of batch.entries()) {
          if (withArt.length === BOARD_COVER_CAP) break;
          if (art[i]) {
            artSeries.add(lead);
            withArt.push(release);
          } else if (!artless.has(lead)) {
            artless.set(lead, release);
          }
        }
      }
      const picks = [
        ...withArt,
        ...[...artless].flatMap(([seriesId, release]) =>
          artSeries.has(seriesId) ? [] : [release],
        ),
      ].slice(0, BOARD_COVER_CAP);
      // Joined exactly as the browser joins them, kept in pick order.
      const joined = new Map((await joinBrowseRows(ctx, picks, cache)).map((row) => [row.id, row]));
      const covers = picks.flatMap((release) => joined.get(release._id) ?? []);

      const parent = parentOf(publisher);
      return {
        publisher: {
          name: publisher.name,
          slug: publisher.slug,
          parent: parent ? { name: parent.name, slug: parent.slug } : null,
        },
        releases: rows.length,
        physical,
        digital: rows.length - physical,
        series: series.size,
        newSeries: newSeries.size,
        previousReleases: previous.get(publisherId)?.length ?? 0,
        covers,
      };
    }),
  );
  const board = cards.flatMap((card) => (card ? [card] : []));
  board.sort((a, b) => b.releases - a.releases || a.publisher.name.localeCompare(b.publisher.name));

  // The directory: top-level Publishers A–Z, each with its imprints.
  const entry = (doc: Doc<"publishers">) => ({
    name: doc.name,
    slug: doc.slug,
    defunct: doc.defunct === true,
    releases: current.get(doc._id)?.length ?? 0,
  });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const docs = [...active.values()];
  const directory = docs
    .filter((doc) => parentOf(doc) === null)
    .map((doc) => ({
      ...entry(doc),
      imprints: docs
        .filter((imprint) => parentOf(imprint)?._id === doc._id)
        .map(entry)
        .sort(byName),
    }))
    .sort(byName);

  return { board, directory };
}

/** A real calendar month; anything else reads as an empty board. */
function monthOk(year: number, month: number) {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= 1000 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12
  );
}

/** The old computeBoard's handler: both views, sharing only the join cache. */
export async function oldComputeBoard(unbounded: QueryCtx, year: number, month: number) {
  const ctx = boundedReads(unbounded);
  const cache = browseCache(ctx);
  return {
    general: await buildMonthBoard(ctx, year, month, false, cache),
    mature: await buildMonthBoard(ctx, year, month, true, cache),
  };
}

/** The old live monthBoard: one view with its own cache. */
export async function oldMonthBoard(
  ctx: QueryCtx,
  year: number,
  month: number,
  showMature: boolean,
) {
  return await buildMonthBoard(ctx, year, month, showMature);
}
