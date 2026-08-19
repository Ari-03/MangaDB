// Shared render pieces for the catalog detail pages (ticket #23): the
// Release row (publication facts, ISBNs, Release Description, Variants
// beneath, Bundle cross-links) and the coverage chip listing. Used by the
// Volume and Edition pages; the Series page keeps its own lighter row.

import { Link } from "@tanstack/react-router";

import { ReleaseCollectionControls } from "~/lib/collection";
import { formatPartialDate, formatPrice } from "~/lib/format";
import { ReleasePassControls } from "~/lib/reading";
import { slugParams } from "~/lib/slug";

/** The releaseRow shape from convex/catalogPages.ts, structurally. */
export type ReleaseRowData = {
  id: string;
  anchor: string;
  format: "physical" | "digital";
  binding: string | null;
  language: string;
  isbn13: string | null;
  isbn10: string | null;
  pubDate: { year: number; month?: number; day?: number; sort: number } | null;
  price: { amountCents: number; currency: string } | null;
  description: string | null;
  variants: Array<{ name: string }>;
  bundles: Array<{ publicId: number; name: string }>;
};

export type CoverageChipData = {
  volumePublicId: number;
  position: number;
  label: string | null;
  volumeTitle: string;
  extent: "complete" | "partial";
  note: string | null;
};

/**
 * A Release row, anchored by ISBN when present, else document ID (spec §8) —
 * the `/isbn/{isbn}` redirect lands on this fragment. Variants render
 * beneath their Release; containing Bundles link to their Bundle pages.
 */
export function ReleaseRow({ release }: { release: ReleaseRowData }) {
  const form =
    release.format === "physical"
      ? `Physical${release.binding ? ` · ${release.binding}` : ""}`
      : "Digital";
  const date = formatPartialDate(release.pubDate);
  const price = formatPrice(release.price);
  return (
    <li className="release" id={release.anchor}>
      <div className="release-facts">
        <span className="release-form">{form}</span>
        {date ? <span className="release-date">{date}</span> : null}
        {release.isbn13 ? (
          <span className="release-isbn">ISBN-13 {release.isbn13}</span>
        ) : null}
        {release.isbn10 ? (
          <span className="release-isbn">ISBN-10 {release.isbn10}</span>
        ) : null}
        {price ? <span className="release-price">{price}</span> : null}
      </div>
      {release.description ? (
        <p className="release-description">{release.description}</p>
      ) : null}
      {release.variants.length > 0 ? (
        <p className="release-variants">
          Cover variants:{" "}
          {release.variants.map((variant) => variant.name).join(", ")}
        </p>
      ) : null}
      {release.bundles.length > 0 ? (
        <p className="release-bundles">
          Also in{" "}
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
      {/* Collection Entry controls (#27); render nothing signed out. */}
      <ReleaseCollectionControls releaseId={release.id} />
      {/* Release Progress pass controls (#28); render nothing signed out. */}
      <ReleasePassControls releaseId={release.id} />
    </li>
  );
}

/**
 * An Edition's ordered Volume Coverage as chips linking each covered
 * Volume's page — canonical numbering (Label, Position fallback) with the
 * partial extent labeled distinctly, never mixed into Edition Line
 * numbering.
 */
export function CoverageChips({ coverage }: { coverage: CoverageChipData[] }) {
  return (
    <p className="coverage">
      Covers{" "}
      {coverage.map((cov, i) => (
        <span key={cov.volumePublicId} className="coverage-chip">
          {i > 0 ? " " : ""}
          <Link
            to="/volume/$publicId/$slug"
            params={slugParams(cov.volumePublicId, cov.volumeTitle)}
          >
            Vol {cov.label ?? `#${cov.position}`}
          </Link>
          {cov.extent === "partial" ? " (partial)" : ""}
          {cov.note ? <span className="coverage-note"> — {cov.note}</span> : null}
        </span>
      ))}
    </p>
  );
}
