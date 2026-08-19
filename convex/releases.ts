// The public Releases browser (ticket #24, spec §10): one month-window query
// serving both the Release Agenda (`/releases`) and the Month Grid
// (`/releases/{yyyy-mm}`) over the same Canonical Releases.
//
// Recorded schema trade-off (spec §8): the scan is always a date-window over
// an index — `by_publisher_date` when a Publisher filter is present, else
// `by_date` — and every other refinement (status, Format) happens in memory
// afterwards, because Convex can't index array containment and month windows
// hold hundreds of rows.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { PUBLISHER_SCAN_CAP } from "./catalog";
import { editionTitle, releaseAnchor } from "./lib/titles";

// A month window holds hundreds of releases across all publishers (spec §8);
// the cap only guards against pathology, mirroring COUNT_CAP elsewhere.
export const WINDOW_CAP = 1000;

/**
 * Follow a Publisher-filter slug to its publisher: current slug first, then
 * the rename-redirect table, so shared filter URLs survive publisher renames.
 */
async function resolvePublisher(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"publishers"> | null> {
  const bySlug = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (bySlug) return bySlug.status === "active" ? bySlug : null;
  const redirect = await ctx.db
    .query("publisherSlugRedirects")
    .withIndex("by_fromSlug", (q) => q.eq("fromSlug", slug))
    .unique();
  if (!redirect) return null;
  const doc = await ctx.db.get(redirect.publisherId);
  return doc && doc.status === "active" ? doc : null;
}

/** Memoized ctx.db.get so the per-release joins stay cheap within a window. */
function cachedGet<T extends "publishers" | "series" | "volumes" | "editions" | "editionLines">(
  ctx: QueryCtx,
) {
  const cache = new Map<string, Doc<T> | null>();
  return async (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const doc = await ctx.db.get(id);
    cache.set(id, doc);
    return doc;
  };
}

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
 * Join active Release docs into the row shape every release lane renders:
 * cover, Series link(s), Volume label, Format, and Publisher per row (spec
 * §10). A month-precision date (day unknown, sort yyyymm00) keeps `day: null`
 * so views can group it as "date to be announced"; rows whose Edition or
 * every Series is hidden drop out. Rows return date-sorted, then stable by
 * title and volume. Shared by the browser's month window (monthBrowse) and
 * the Publisher Spotlight's upcoming lane (publisher.ts, ticket #25).
 */
export async function joinBrowseRows(
  ctx: QueryCtx,
  docs: Array<Doc<"releases">>,
) {
  const getPublisher = cachedGet<"publishers">(ctx);
  const getSeries = cachedGet<"series">(ctx);
  const getVolume = cachedGet<"volumes">(ctx);
  const getEdition = cachedGet<"editions">(ctx);
  const getLine = cachedGet<"editionLines">(ctx);
  const coverageByEdition = new Map<string, Array<Doc<"volumeCoverages">>>();

  const releases = [];
  for (const release of docs) {
    const pubDate = release.pubDate;
    if (!pubDate) continue; // unreachable inside an index range; type guard

    const edition = await getEdition(release.editionId);
    if (!edition || edition.status !== "active") continue;

    // Series links come from the denormalized seriesIds (spec §8); a hidden
    // Series hides its releases from the public browser.
    const series = [];
    for (const seriesId of release.seriesIds) {
      const doc = await getSeries(seriesId);
      if (doc && doc.status === "active") {
        series.push({ publicId: doc.publicId, title: doc.title });
      }
    }
    if (series.length === 0) continue;

    let coverage = coverageByEdition.get(edition._id);
    if (!coverage) {
      coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      coverageByEdition.set(edition._id, coverage);
    }
    const covered = [];
    let anyPartial = false;
    for (const row of coverage) {
      const volume = await getVolume(row.volumeId);
      if (!volume || volume.status !== "active") continue;
      covered.push({ label: volume.label ?? null, position: volume.position });
      if (row.extent === "partial") anyPartial = true;
    }

    const publisherDoc = await getPublisher(release.publisherId);
    const line = edition.editionLineId
      ? await getLine(edition.editionLineId)
      : null;

    releases.push({
      id: release._id,
      // The row's canonical target (spec §11: a Release is a row on its
      // Edition page): Edition public ID + composed title for the link, the
      // Release's anchor within it. Month pages build their ItemList JSON-LD
      // from these (ticket #39).
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
      volumeLabel: composeVolumeLabel(covered, anyPartial),
      lineName: line && line.status === "active" ? line.name : null,
      linePosition: edition.linePosition ?? null,
      publisher:
        publisherDoc && publisherDoc.status === "active"
          ? { name: publisherDoc.name, slug: publisherDoc.slug }
          : null,
      coverUrl: release.coverImage
        ? await ctx.storage.getUrl(release.coverImage.storageId)
        : null,
    });
  }

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
 * dropdown renders from the same round trip.
 */
export const monthBrowse = query({
  args: {
    year: v.number(),
    month: v.number(),
    format: v.optional(v.union(v.literal("physical"), v.literal("digital"))),
    // Publisher filter by slug — the URL-shareable form of the filter state.
    publisher: v.optional(v.string()),
  },
  handler: async (ctx, { year, month, format, publisher }) => {
    const publisherDocs = await ctx.db
      .query("publishers")
      .take(PUBLISHER_SCAN_CAP);
    const publishers = publisherDocs
      .filter((doc) => doc.status === "active")
      .map((doc) => ({ name: doc.name, slug: doc.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const empty = { releases: [], publishers };
    if (!Number.isInteger(year) || !Number.isInteger(month)) return empty;
    if (year < 1000 || year > 9999 || month < 1 || month > 12) return empty;

    // yyyymmdd sort keys: yyyymm00 (month-precision) … yyyymm99 covers every
    // day of the month; a year-only date (yyyy0000) falls in no month window.
    const fromSort = year * 10000 + month * 100;
    const toSort = fromSort + 99;

    // The index scan (spec §8): by_publisher_date when the Publisher filter
    // narrows the window, else by_date across all publishers.
    let windowDocs: Array<Doc<"releases">>;
    if (publisher !== undefined) {
      const filterPublisher = await resolvePublisher(ctx, publisher);
      // An unknown publisher slug matches nothing rather than erroring, so a
      // stale shared URL still renders the browser with an empty result.
      if (!filterPublisher) return empty;
      windowDocs = await ctx.db
        .query("releases")
        .withIndex("by_publisher_date", (q) =>
          q
            .eq("publisherId", filterPublisher._id)
            .gte("pubDate.sort", fromSort)
            .lte("pubDate.sort", toSort),
        )
        .take(WINDOW_CAP);
    } else {
      windowDocs = await ctx.db
        .query("releases")
        .withIndex("by_date", (q) =>
          q.gte("pubDate.sort", fromSort).lte("pubDate.sort", toSort),
        )
        .take(WINDOW_CAP);
    }

    // In-memory refinement per the recorded trade-off: status and Format.
    const refined = windowDocs.filter(
      (doc) =>
        doc.status === "active" && (format === undefined || doc.format === format),
    );

    return { releases: await joinBrowseRows(ctx, refined), publishers };
  },
});
