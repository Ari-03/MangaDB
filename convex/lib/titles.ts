// Display-title composition for Volume, Edition, and Bundle pages (ticket
// #23). Editions have no stored name (spec §8): page titles derive from
// series + line + position; Volumes derive from series + Label. These
// composed titles are also what the cosmetic URL slugs are computed from
// (spec §11), so both Convex queries and the routes import this module —
// it must stay pure and dependency-free.
//
// Labels display; Positions are only the fallback (spec §2) — the canonical
// Volume number never leaks into an Edition Line's own numbering, and vice
// versa.

export type CoveredVolume = { label: string | null; position: number };

/** The name a covered Volume wears inside a composed title. */
function volumeName(vol: CoveredVolume): string {
  return vol.label ?? String(vol.position);
}

/**
 * Volume page title: "Tokyo Ghoul Vol 3.5". An unlabeled Volume (a oneshot,
 * spec §2) is just its Series title.
 */
export function volumeTitle(seriesTitle: string, label: string | null): string {
  return label === null ? seriesTitle : `${seriesTitle} Vol ${label}`;
}

/**
 * Edition page title, derived per spec §8. An Edition Line member titles by
 * its line and Edition Line Position ("Tokyo Ghoul Monster Edition 1" —
 * publisher package numbering, never the canonical Volume number); a lineless
 * Edition titles by its covered Volume(s) ("Tokyo Ghoul Vol 1",
 * "Tokyo Ghoul Vol 1–3"); an unlabeled lone Volume is a oneshot.
 */
export function editionTitle(args: {
  seriesTitle: string | null;
  lineName: string | null;
  linePosition: string | null;
  covered: CoveredVolume[];
}): string {
  const seriesTitle = args.seriesTitle ?? "Edition";
  if (args.lineName !== null) {
    const position = args.linePosition !== null ? ` ${args.linePosition}` : "";
    return `${seriesTitle} ${args.lineName}${position}`;
  }
  const covered = args.covered;
  const first = covered[0];
  if (first === undefined) return seriesTitle;
  if (covered.length === 1) {
    return first.label !== null ? `${seriesTitle} Vol ${first.label}` : seriesTitle;
  }
  const last = covered[covered.length - 1]!;
  return `${seriesTitle} Vol ${volumeName(first)}–${volumeName(last)}`;
}

/**
 * The fragment a Release row anchors on within its Edition page (spec §8:
 * Releases have no public ID — ISBN when present, else document ID). The
 * `/isbn/{isbn}` redirect target uses the same rule, so it always lands on
 * the matching row.
 */
export function releaseAnchor(release: {
  isbn13?: string | null;
  isbn10?: string | null;
  _id: string;
}): string {
  return release.isbn13 ?? release.isbn10 ?? release._id;
}
