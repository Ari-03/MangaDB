// The public Releases browser (spec §10): one month-window query
// serving both the Release Agenda (`/releases`) and the Month Grid
// (`/releases/{yyyy-mm}`) over the same Canonical Releases. The pages load a
// month and apply the Format and Publisher filters in memory, so changing a
// filter never waits on the network.
//
// Recorded schema trade-off (spec §8): the scan is a date window over the
// active Releases (`by_status_date`), and every other refinement (Format and
// Publisher on the page) happens in memory, because Convex can't index array
// containment and month windows hold hundreds of rows.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { PUBLISHER_SCAN_CAP } from "./catalog";
import { publisherLink } from "./catalogPages";
import { followMerges } from "./lib/merges";
import { editionTitle, releaseAnchor } from "./lib/titles";
import { jacketCache, releaseCover } from "./lib/covers";
import { boundedReads } from "./lib/boundedReads";
import { coverageOf } from "./lib/editionRows";
import { showMatureArg, visibleTo } from "./lib/mature";

// A month window holds hundreds of releases across all publishers (spec §8);
// the cap only guards against pathology, mirroring COUNT_CAP elsewhere.
export const WINDOW_CAP = 1000;

/**
 * The Publisher a slug means: the current slug first, then the
 * rename-redirect table (spec §11), then a merged row to its survivor, so
 * shared links survive renames and duplicate-row merges. The surviving
 * active Publisher, or null for an unknown or hidden one. Shared with the
 * Publisher Spotlight (publisher.ts), whose route 301s when the slug differs.
 */
export async function resolvePublisher(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"publishers"> | null> {
  let doc = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!doc) {
    const redirect = await ctx.db
      .query("publisherSlugRedirects")
      .withIndex("by_fromSlug", (q) => q.eq("fromSlug", slug))
      .unique();
    doc = redirect ? await ctx.db.get(redirect.publisherId) : null;
  }
  return await followMerges(ctx, "publishers", doc);
}

/**
 * Memoize an async lookup by key: the argument itself, or `keyOf(arg)` when
 * given (a document's `_id`). The promise itself is cached, so lookups
 * running in parallel (Promise.all) still read each key once.
 */
export function memoize<A, V>(
  load: (arg: A) => Promise<V>,
  keyOf: (arg: A) => unknown = (arg) => arg,
): (arg: A) => Promise<V> {
  const cache = new Map<unknown, Promise<V>>();
  return (arg) => {
    const key = keyOf(arg);
    let hit = cache.get(key);
    if (!hit) {
      hit = load(arg);
      cache.set(key, hit);
    }
    return hit;
  };
}

/**
 * Memoized reads for joining Releases to the catalog: gets by ID, an
 * Edition's ordered Coverage, and a Release's jacket art. Make one per query
 * and pass it to every helper that looks up the same rows (joinBrowseRows,
 * the Publishers board), so each document is read once. Its reads share one
 * queue (lib/boundedReads.ts), the caller's when `ctx` is already bounded,
 * so a month joined all at once stays under Convex's in-flight read limit.
 */
export function browseCache(unbounded: QueryCtx) {
  const ctx = boundedReads(unbounded);
  const coverage = memoize((editionId: Id<"editions">) => coverageOf(ctx, editionId));
  const edition = memoize((id: Id<"editions">) => ctx.db.get(id));
  // Edition jackets; an ISBN-less Edition's borrow shares these reads.
  const jackets = jacketCache(ctx, coverage, edition);
  return {
    // A Release's art (lib/covers.ts `releaseCover`): its stored cover or its
    // Edition's, and the Edition's ISBNs to fetch art by. Keyed by `_id`, so
    // two reads of the same Release share one lookup.
    cover: memoize(
      (release: Doc<"releases">) => releaseCover(ctx, release, jackets),
      (release) => release._id,
    ),
    publisher: memoize((id: Id<"publishers">) => ctx.db.get(id)),
    series: memoize((id: Id<"series">) => ctx.db.get(id)),
    volume: memoize((id: Id<"volumes">) => ctx.db.get(id)),
    edition,
    line: memoize((id: Id<"editionLines">) => ctx.db.get(id)),
    coverage,
  };
}
export type BrowseCache = ReturnType<typeof browseCache>;

/**
 * The Volume label a browser row wears, composed from the Edition's ordered
 * Coverage: "Vol. 3" for a single covered Volume, "Vol. 1–3" for an omnibus,
 * "Oneshot" for an unlabeled lone Volume, with "(partial)" appended when any
 * Coverage is partial. Labels display; Positions are only the fallback.
 */
function composeVolumeLabel(
  covered: Array<{ label: string | null; position: number }>,
  anyPartial: boolean,
): string {
  if (covered.length === 0) return "";
  const name = (vol: { label: string | null; position: number }) =>
    vol.label ?? String(vol.position);
  let label: string;
  if (covered.length === 1) {
    const only = covered[0]!;
    label = only.label ? `Vol. ${only.label}` : "Oneshot";
  } else {
    label = `Vol. ${name(covered[0]!)}–${name(covered[covered.length - 1]!)}`;
  }
  return anyPartial ? `${label} (partial)` : label;
}

/**
 * The active Volumes an Edition covers, in Coverage order, as a browser row
 * labels them, and whether any of their Coverage is partial.
 */
async function coveredVolumes(cache: BrowseCache, editionId: Id<"editions">) {
  const rows = await cache.coverage(editionId);
  const volumes = await Promise.all(rows.map((row) => cache.volume(row.volumeId)));
  const covered = [];
  let anyPartial = false;
  for (const [i, row] of rows.entries()) {
    const volume = volumes[i];
    if (!volume || volume.status !== "active") continue;
    covered.push({ label: volume.label ?? null, position: volume.position });
    if (row.extent === "partial") anyPartial = true;
  }
  return { covered, anyPartial };
}

/**
 * Join active Release docs into the row shape every release lane renders:
 * cover, Series link(s), Volume label, Format, and Publisher per row (spec
 * §10). A month-precision date (day unknown, sort yyyymm00) keeps `day: null`
 * so views can group it as "date to be announced"; rows whose Edition or
 * every Series is hidden drop out, and a row of any Mature Series says so
 * (`mature`) for the caller to filter. Rows return date-sorted, then stable by
 * title and volume. Shared by the browser's month window (monthBrowse), the
 * Publisher Spotlight's upcoming lane and the Publishers board's cover
 * strips (publisher.ts); pass `cache` to share lookups a caller already made.
 */
export async function joinBrowseRows(
  ctx: QueryCtx,
  docs: Array<Doc<"releases">>,
  cache: BrowseCache = browseCache(ctx),
) {
  // Every Release joins at once: the cache shares in-flight lookups, so rows
  // of one Edition or Series still read it once, and keeps at most
  // READ_CONCURRENCY reads in flight; Promise.all returns the rows in `docs`
  // order for the stable sort below. Within a row the Edition and then its
  // Series gate the rest, so a dropped row reads no further.
  const joined = await Promise.all(
    docs.map(async (release) => {
      const pubDate = release.pubDate;
      if (!pubDate) return null; // unreachable inside an index range; type guard

      const edition = await cache.edition(release.editionId);
      if (!edition || edition.status !== "active") return null;

      // Series links come from the denormalized seriesIds (spec §8); a hidden
      // Series hides its releases from the public browser. A book of any
      // Mature Series is mature (lib/mature.ts); callers filter on the flag.
      const series = [];
      let mature = false;
      for (const doc of await Promise.all(release.seriesIds.map((id) => cache.series(id)))) {
        if (doc && doc.status === "active") {
          series.push({ publicId: doc.publicId, title: doc.title });
          if (doc.mature) mature = true;
        }
      }
      if (series.length === 0) return null;

      const [{ covered, anyPartial }, publisherDoc, line, cover] = await Promise.all([
        coveredVolumes(cache, edition._id),
        cache.publisher(release.publisherId),
        edition.editionLineId ? cache.line(edition.editionLineId) : null,
        cache.cover(release),
      ]);

      return {
        id: release._id,
        // The row's canonical target (spec §11: a Release is a row on its
        // Edition page): Edition public ID + composed title for the link, the
        // Release's anchor within it. Month pages build their ItemList JSON-LD
        // from these.
        edition: {
          publicId: edition.publicId,
          title: editionTitle({
            seriesTitle: series[0]?.title ?? null,
            lineName: line && line.status === "active" ? line.name : null,
            linePosition: edition.linePosition ?? null,
            covered,
          }),
        },
        anchor: releaseAnchor(release),
        day: pubDate.day ?? null,
        sort: pubDate.sort,
        format: release.format,
        binding: release.binding ?? null,
        isbn13: release.isbn13 ?? null,
        series,
        mature,
        volumeLabel: composeVolumeLabel(covered, anyPartial),
        lineName: line && line.status === "active" ? line.name : null,
        linePosition: edition.linePosition ?? null,
        publisher: publisherLink(publisherDoc),
        // The row's art (lib/covers.ts `releaseCover`): `coverUrl` is its own
        // stored cover, else its Edition's, and `coverIsbns` the Edition's
        // ISBNs to fetch art by, physical first, the same for every row of one
        // Edition. `isbn13` above stays the Release's own identity.
        ...cover,
      };
    }),
  );
  const releases = joined.filter((row) => row !== null);

  // Chronological, then stable within a day by title and volume.
  releases.sort(
    (a, b) =>
      a.sort - b.sort ||
      (a.series[0]?.title ?? "").localeCompare(b.series[0]?.title ?? "") ||
      a.volumeLabel.localeCompare(b.volumeLabel),
  );
  return releases;
}

/**
 * Every Canonical Release publishing in one month, joined into the shape both
 * browser views render (joinBrowseRows). Hidden/merged records never surface.
 * Releases only — Bundles stay off the browser (spec §10).
 *
 * Also returns the active Publisher list (small, spec §8) so the filter
 * dropdown renders from the same round trip. Books of Mature Series, and
 * adult-only Publishers, are left out unless `showMature` (lib/mature.ts).
 */
export const monthBrowse = query({
  args: { year: v.number(), month: v.number(), ...showMatureArg },
  handler: async (ctx, { year, month, showMature }) => {
    const valid =
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      year >= 1000 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12;
    // yyyymmdd sort keys: yyyymm00 (month-precision) … yyyymm99 covers every
    // day of the month; a year-only date (yyyy0000) falls in no month window.
    const fromSort = year * 10000 + month * 100;
    const toSort = fromSort + 99;

    const [publisherDocs, windowDocs] = await Promise.all([
      ctx.db.query("publishers").take(PUBLISHER_SCAN_CAP),
      // Active rows only, off the status-led index: hidden and merged
      // Releases neither cost reads nor push active ones past the cap.
      valid
        ? ctx.db
            .query("releases")
            .withIndex("by_status_date", (q) =>
              q.eq("status", "active").gte("pubDate.sort", fromSort).lte("pubDate.sort", toSort),
            )
            .take(WINDOW_CAP)
        : [],
    ]);
    const publishers = publisherDocs
      .filter(
        (doc) => doc.status === "active" && visibleTo(showMature, doc.contentRating === "mature"),
      )
      .map((doc) => ({ name: doc.name, slug: doc.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      releases: (await joinBrowseRows(ctx, windowDocs)).filter((row) =>
        visibleTo(showMature, row.mature),
      ),
      publishers,
      // The window hit WINDOW_CAP: the month holds more active Releases than
      // this read. The pages filter in memory, so they say so rather than
      // miss releases silently (months hold ~250–350 today).
      capped: windowDocs.length === WINDOW_CAP,
    };
  },
});

/**
 * The current slug for a Publisher-filter slug (`resolvePublisher`: renamed
 * and merged Publishers follow to their survivor), or null when it names no
 * active Publisher. The Releases pages filter by slug in memory, so a shared
 * link with an old slug redirects to the current one first.
 */
export const canonicalPublisherSlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const publisher = await resolvePublisher(ctx, slug);
    return publisher?.status === "active" ? publisher.slug : null;
  },
});
