// Before/after metrics for the one-time catalog repair: each audit lane's
// headline defect, recomputed from the live tables (repair:metrics pages
// through them). The title and scope rules are deliberately simple regexes
// mirroring the audit reports; they measure movement, not ground truth.

import type { Doc } from "../../_generated/dataModel";
import { DUPLICATE_SLUGS } from "../publishers";

const projections = {
  publishers: (d: Doc<"publishers">) => ({
    id: d._id,
    status: d.status,
    slug: d.slug,
    linked: d.parentPublisherId !== undefined,
  }),
  series: (d: Doc<"series">) => ({ id: d._id, status: d.status, title: d.title }),
  volumes: (d: Doc<"volumes">) => ({
    seriesId: d.seriesId,
    status: d.status,
    label: d.label ?? null,
    position: d.position,
  }),
  editions: (d: Doc<"editions">) => ({ status: d.status, inLine: d.editionLineId !== undefined }),
  releases: (d: Doc<"releases">) => ({
    id: d._id,
    status: d.status,
    isbn13: d.isbn13 ?? null,
    publisherId: d.publisherId,
    placeholderCover: d.coverImage?.sourceUrl?.includes("placeholder") ?? false,
  }),
  editionLines: (d: Doc<"editionLines">) => ({ status: d.status }),
  releaseBundles: (d: Doc<"releaseBundles">) => ({ status: d.status }),
  bundleMemberships: (d: Doc<"bundleMemberships">) => ({ bundleId: d.bundleId }),
};

type RowMap = { [T in keyof typeof projections]: ReturnType<(typeof projections)[T]> };
export type MetricTable = keyof RowMap;
export type Row<T extends MetricTable> = RowMap[T];
export const metricTables = Object.keys(projections) as MetricTable[];

// Mapped over the table name, so indexing with a generic T stays correlated.
const project: { [T in MetricTable]: (doc: Doc<T>) => RowMap[T] } = projections;

/** Project one document of `table` to the fields the metrics read. */
export function projectRow<T extends MetricTable>(table: T, doc: Doc<T>): Row<T> {
  return project[table](doc);
}

/** Linked PRH / OpenLibrary / ANN-release observations, projected. */
export function projectObservation(d: Doc<"sourceObservations">) {
  const snapshot: { isbn13?: unknown; title?: unknown; imprint?: unknown } = d.snapshot ?? {};
  return {
    sourceKey: d.sourceKey,
    releaseId: d.recordRef?.type === "release" ? d.recordRef.id : null,
    isbn13: typeof snapshot.isbn13 === "string" ? snapshot.isbn13 : null,
    title: typeof snapshot.title === "string" ? snapshot.title : "",
    imprint: typeof snapshot.imprint === "string" ? snapshot.imprint : null,
  };
}
export type ObservationRow = ReturnType<typeof projectObservation>;

// Series titles still carrying per-volume, format, or packaging text (the
// series-titles lane's patterns).
const POLLUTED = [
  /\bvol(?:ume)?s?\.?\s*\d/i,
  /\((?:manga|comic|the comic[^)]*|manhua|manhwa|paperback|hardcover|novel|light novel|illustrated novel)\)/i,
  /\[(?:paperback|mature hardcover|hardcover)\]/i,
  /\bomnibus\b/i,
  /\bbox\s+set\b/i,
  /\bcollector'?s edition\b/i,
  /\bdeluxe edition\b/i,
  /\b\d-in-1\b/i,
  /,\s*part$/i,
  /&#?\w+;/,
  /\s{2,}/,
];

// Out-of-scope books by their source title (the scope lane's clear rules).
const OUT_OF_SCOPE = [
  /\((?![^)]*graphic)[^)]*\bnovel\b[^)]*\)|\blight\s*novel\b|:\s*the novel\b/i,
  /playing cards|scratch cards|card game|roll & clash|advent calendar|\bstick it\b|activity book|coloring book|papertoy|fan notebook|sudoku|number place|origami|kirigami|papercraft/i,
  /manga showcase|free sample|\(fcbd|convention exclusive|manga magazine/i,
  /versi[oó]n en espa[nñ]ol|\(spanish\)/i,
];

/** The duplicates lane's cluster key: title minus volume/format/packaging noise. */
export function clusterKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&#?\w+;/g, " ")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/[,:\-–]?\s*\b(?:vol(?:ume)?s?\.?|book|part)\s*\d.*$/, " ")
    .replace(/\b(?:manga\s+)?(?:omnibus|box\s+set|deluxe(?:\s+edition)?|collector'?s\s+edition|\d-in-1(?:\s+edition)?)\b.*$/, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(?:\s\d{1,3})+\s*$/, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "");
}

export type MetricRows = { [T in MetricTable]: Row<T>[] } & { observations: ObservationRow[] };

export function computeMetrics(rows: MetricRows) {
  const activeSeries = rows.series.filter((s) => s.status === "active");
  const activeReleases = rows.releases.filter((r) => r.status === "active");
  const releaseById = new Map(activeReleases.map((r) => [r.id, r]));

  const minPosition = new Map<string, number>();
  let labelPositionMismatch = 0;
  let zeroPaddedLabels = 0;
  for (const vol of rows.volumes) {
    if (vol.status !== "active") continue;
    minPosition.set(vol.seriesId, Math.min(minPosition.get(vol.seriesId) ?? Infinity, vol.position));
    if (vol.label !== null && /^\d+(\.\d+)?$/.test(vol.label)) {
      if (Number(vol.label) !== vol.position) labelPositionMismatch++;
      if (/^0\d/.test(vol.label)) zeroPaddedLabels++;
    }
  }
  const clusters = new Map<string, number>();
  for (const s of activeSeries) {
    const key = clusterKey(s.title);
    if (key) clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  const dupClusters = [...clusters.values()].filter((n) => n > 1);

  const outOfScope = new Set<string>();
  const conflated = new Set<string>();
  const annLinks = new Map<string, number>();
  for (const obs of rows.observations) {
    const release = obs.releaseId ? releaseById.get(obs.releaseId) : undefined;
    if (!release) continue;
    if (obs.sourceKey === "ann") {
      annLinks.set(release.id, (annLinks.get(release.id) ?? 0) + 1);
      continue;
    }
    if (obs.isbn13 && release.isbn13 && obs.isbn13 !== release.isbn13) conflated.add(release.id);
    const sameBook = obs.isbn13 !== null && obs.isbn13 === release.isbn13;
    if (sameBook && (OUT_OF_SCOPE.some((re) => re.test(obs.title)) || (obs.sourceKey === "prh" && obs.imprint === "Vertical"))) {
      outOfScope.add(release.id);
    }
  }
  for (const release of activeReleases) {
    if (release.isbn13?.startsWith("9784")) outOfScope.add(release.id);
  }

  const duplicateRowIds = new Set(
    rows.publishers.filter((p) => p.status === "active" && p.slug in DUPLICATE_SLUGS).map((p) => p.id),
  );

  return {
    publishersActive: rows.publishers.filter((p) => p.status === "active").length,
    publishersMerged: rows.publishers.filter((p) => p.status === "merged").length,
    imprintsLinked: rows.publishers.filter((p) => p.status === "active" && p.linked).length,
    releasesOnDuplicatePublisherRows: activeReleases.filter((r) => duplicateRowIds.has(r.publisherId)).length,
    seriesActive: activeSeries.length,
    seriesMerged: rows.series.filter((s) => s.status === "merged").length,
    seriesHidden: rows.series.filter((s) => s.status === "hidden").length,
    seriesPollutedTitles: activeSeries.filter((s) => POLLUTED.some((re) => re.test(s.title))).length,
    seriesNotStartingAt1: activeSeries.filter((s) => (minPosition.get(s.id) ?? 1) > 1).length,
    duplicateTitleClusters: dupClusters.length,
    seriesInDuplicateClusters: dupClusters.reduce((sum, n) => sum + n, 0),
    volumesActive: rows.volumes.filter((v) => v.status === "active").length,
    volumesLabelPositionMismatch: labelPositionMismatch,
    volumesZeroPaddedLabels: zeroPaddedLabels,
    releasesActive: activeReleases.length,
    releasesOutOfScope: outOfScope.size,
    releasesConflated: conflated.size,
    releasesWithSeveralAnnLines: [...annLinks.values()].filter((n) => n > 1).length,
    releasesPlaceholderCovers: activeReleases.filter((r) => r.placeholderCover).length,
    editionsActive: rows.editions.filter((e) => e.status === "active").length,
    editionsInLines: rows.editions.filter((e) => e.status === "active" && e.inLine).length,
    editionLinesActive: rows.editionLines.filter((l) => l.status === "active").length,
    releaseBundlesActive: rows.releaseBundles.filter((b) => b.status === "active").length,
    bundleMemberships: rows.bundleMemberships.length,
  };
}
