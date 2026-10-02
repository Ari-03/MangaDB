// Shared render pieces for the Volume and Edition pages (ticket #23): the
// Release row (publication facts, ISBNs, Variants beneath, Bundle
// cross-links; the page shows one description above, not one per row), the
// coverage chip listing, and the note naming the Series a borrowed synopsis
// is about. The Bundle page draws its own member rows and the Series page
// its own lighter row.
//
// Classes live in styles/catalog-edition.css and are scoped under
// `.release-row` / `.coverage-chips` so the Series page's lighter row keeps
// its own look.

import { Link } from "@tanstack/react-router";

import type { EditionPageData } from "~/lib/catalogData";
import { ReleaseCollectionControls } from "~/lib/collection";
import { formatPartialDate, formatPrice } from "~/lib/format";
import { ReleasePassControls } from "~/lib/reading";
import { slugParams } from "~/lib/slug";

/** The releaseRow shape from convex/catalogPages.ts (Edition and Volume pages share it). */
export type ReleaseRowData = EditionPageData["releases"][number];

export type CoverageChipData = {
  volumePublicId: number;
  position: number;
  label: string | null;
  volumeTitle: string;
  extent: "complete" | "partial";
  note: string | null;
};

/** Format chip: the one fact that separates two Releases of an Edition. */
function FormatChip({ format }: { format: ReleaseRowData["format"] }) {
  return format === "physical" ? (
    <span className="chip chip--physical">Physical</span>
  ) : (
    <span className="chip chip--digital">Digital</span>
  );
}

/**
 * A Release row, anchored by ISBN when present, else document ID (spec §8) —
 * the `/isbn/{isbn}` redirect lands on this fragment, which `:target`
 * highlights. Variants render beneath their Release; containing Bundles link
 * to their Bundle pages. The signed-in collection and reading-pass controls
 * sit in the row's right-hand column and collapse it when signed out.
 */
export function ReleaseRow({ release }: { release: ReleaseRowData }) {
  const date = formatPartialDate(release.pubDate);
  const price = formatPrice(release.price);
  // Binding describes physical construction only (glossary: Binding).
  const binding = release.format === "physical" ? release.binding : null;
  return (
    <li className="release-row" id={release.anchor}>
      <div className="release-main">
        <p className="release-line">
          <FormatChip format={release.format} />
          {binding ? <span className="release-binding">{binding}</span> : null}
          {date ? <span className="release-date">{date}</span> : null}
          {price ? <span className="release-price">{price}</span> : null}
        </p>
        {release.isbn13 || release.isbn10 ? (
          <p className="release-ids">
            {release.isbn13 ? (
              <span className="release-isbn">
                <span className="release-isbn-kind">ISBN-13</span>
                {release.isbn13}
              </span>
            ) : null}
            {release.isbn10 ? (
              <span className="release-isbn">
                <span className="release-isbn-kind">ISBN-10</span>
                {release.isbn10}
              </span>
            ) : null}
          </p>
        ) : null}
        {release.variants.length > 0 ? (
          <p className="release-variants">
            Cover variants:{" "}
            {release.variants.map((variant) => variant.name).join(", ")}
          </p>
        ) : null}
        {release.bundles.length > 0 ? (
          <p className="release-bundles">
            Also sold inside{" "}
            {release.bundles.map((bundle, i) => (
              <span key={bundle.publicId}>
                {i > 0 ? ", " : ""}
                <Link
                  to="/bundle/$publicId/$slug"
                  params={slugParams(bundle.publicId, bundle.name)}
                >
                  {bundle.name}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <div className="release-side">
        {/* Collection Entry controls (#27); render nothing signed out. */}
        <ReleaseCollectionControls releaseId={release.id} />
        {/* Release Progress pass controls (#28); render nothing signed out. */}
        <ReleasePassControls releaseId={release.id} />
      </div>
    </li>
  );
}

/**
 * The quiet label above a page's description when it is only the Series
 * synopsis (convex/catalogPages.ts `seriesSynopsis`): "About {title}",
 * linking the Series page, so it never reads as the book's own blurb.
 */
export function AboutSeriesNote({ series }: { series: { publicId: number; title: string } }) {
  return (
    <p className="note">
      About{" "}
      <Link to="/series/$publicId/$slug" params={slugParams(series.publicId, series.title)}>
        {series.title}
      </Link>
    </p>
  );
}

/**
 * An Edition's ordered Volume Coverage as chips linking each covered
 * Volume's page — canonical numbering (Label, Position fallback) with the
 * partial extent labeled distinctly, never mixed into Edition Line
 * numbering.
 */
export function CoverageChips({ coverage }: { coverage: CoverageChipData[] }) {
  const notes = coverage.filter((cov) => cov.note !== null);
  return (
    <div className="coverage-chips">
      <p className="coverage-list">
        <span className="coverage-lede">Covers</span>
        {coverage.map((cov) => (
          <Link
            key={cov.volumePublicId}
            className={cov.extent === "partial" ? "chip chip--partial" : "chip"}
            to="/volume/$publicId/$slug"
            params={slugParams(cov.volumePublicId, cov.volumeTitle)}
          >
            Vol {cov.label ?? `#${cov.position}`}
            {cov.extent === "partial" ? (
              <span className="chip-extent">partial</span>
            ) : null}
          </Link>
        ))}
      </p>
      {notes.length > 0 ? (
        <ul className="coverage-notes">
          {notes.map((cov) => (
            <li key={cov.volumePublicId}>
              Vol {cov.label ?? `#${cov.position}`} — {cov.note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
