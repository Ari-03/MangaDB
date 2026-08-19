import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { CoverageChips, ReleaseRow } from "~/lib/catalogRows";
import { ModEditLink, ModReleaseEditLinks, RecordHistory } from "~/lib/moderation";
import {
  bookJsonLd,
  breadcrumbListJsonLd,
  editionTitleTag,
  isoPartialDate,
  jsonLdScript,
  pageHead,
  truncateDescription,
} from "~/lib/seo";
import { editionPath, parsePublicId, seriesPath, slugParams } from "~/lib/slug";
import { fetchEditionPage } from "~/server/catalogPages";

/**
 * The Edition page — the book detail page (ticket #23, spec §2/§10/§11):
 * `/edition/{id}/{slug}`, server-rendered from Convex. Release rows differ
 * only in Format/Binding, each carrying ISBNs, date, Release Description,
 * with Release Variants beneath their Release and bundle-membership links.
 * Coverage chips link the covered Volumes (canonical numbering), kept
 * visibly separate from the Edition Line Position (publisher numbering).
 *
 * Releases have no page of their own (spec §11): each row anchors by ISBN
 * when present, else document ID, and `/isbn/{isbn}` 301s here at that
 * fragment. The Edition's title is composed, never stored (spec §8); a stale
 * slug or a merged Edition's old ID 301s to the canonical URL.
 */
export const Route = createFileRoute("/edition/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchEditionPage({ data: publicId });
    if (!page) throw notFound();
    const canonical = editionPath(page.edition.publicId, page.edition.title);
    if (`/edition/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // JSON-LD (spec §11, ticket #39): BreadcrumbList plus one Book per Release
  // row — Releases have no page of their own, so each Book's URL is this
  // Edition page anchored at its row. The description leads with facts
  // (publisher, date, ISBN), falling back to the Release Description blurb.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { edition, series, releases, coverUrl } = loaderData;
    const path = editionPath(edition.publicId, edition.title);
    const primarySeries = series[0];
    const first = releases[0];
    const facts = [
      edition.publisher ? `from ${edition.publisher.name}` : null,
      first?.pubDate ? `released ${isoPartialDate(first.pubDate)}` : null,
      first?.isbn13 ? `ISBN ${first.isbn13}` : null,
    ].filter((fact) => fact !== null);
    const blurb = releases.find((r) => r.description)?.description;
    return {
      ...pageHead({
        title: editionTitleTag(edition.title, edition.publisher?.name ?? null),
        description:
          facts.length > 0
            ? `${edition.title} ${facts.join(", ")} — every release with format, binding, ISBN, and release date.`
            : blurb
              ? truncateDescription(blurb)
              : `${edition.title}: every release with format, binding, ISBN, and release date.`,
        path,
        image: coverUrl,
        ogType: "book",
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            ...(primarySeries
              ? [
                  {
                    name: primarySeries.title,
                    path: seriesPath(primarySeries.publicId, primarySeries.title),
                  },
                ]
              : []),
            { name: edition.title },
          ]),
        ),
        ...releases.map((release) =>
          jsonLdScript(
            bookJsonLd({
              name: edition.title,
              editionPath: path,
              anchor: release.anchor,
              format: release.format,
              binding: release.binding,
              isbn13: release.isbn13,
              isbn10: release.isbn10,
              pubDate: release.pubDate,
              language: release.language,
              publisherName: edition.publisher?.name ?? null,
              coverUrl: release.coverUrl,
            }),
          ),
        ),
      ],
    };
  },
  component: EditionPage,
  notFoundComponent: EditionNotFound,
});

function EditionNotFound() {
  return (
    <main>
      <h1>Edition not found</h1>
      <p className="notice">
        No edition lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

function EditionPage() {
  const { edition, series, coverage, releases } = Route.useLoaderData();
  const primarySeries = series[0];

  return (
    <main className="edition-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        {primarySeries ? (
          <>
            <Link
              to="/series/$publicId/$slug"
              params={slugParams(primarySeries.publicId, primarySeries.title)}
            >
              {primarySeries.title}
            </Link>{" "}
            <span aria-hidden="true">/</span>{" "}
          </>
        ) : null}
        <span>Edition</span>
      </nav>

      <h1>{edition.title}</h1>
      <p className="series-facts">
        {edition.publisher ? (
          <span className="fact">Published by {edition.publisher.name}</span>
        ) : null}
        {edition.lineName ? (
          <span className="fact">
            {edition.lineName} edition line
            {/* Edition Line Position: publisher package numbering, never the
                canonical Volume number (spec §2). */}
            {edition.linePosition ? (
              <span className="line-position" title="Position within the edition line">
                {" "}
                · line #{edition.linePosition}
              </span>
            ) : null}
          </span>
        ) : null}
      </p>

      {coverage.length > 0 ? <CoverageChips coverage={coverage} /> : null}

      <section className="edition-releases">
        <h2>Releases</h2>
        <p className="section-hint">
          The purchasable forms of this edition — differing only in format and
          binding. Paste an ISBN into search to land on its row.
        </p>
        {releases.length === 0 ? (
          <p className="notice">No releases recorded for this edition yet.</p>
        ) : (
          <ul className="release-list">
            {releases.map((release) => (
              <ReleaseRow key={release.id} release={release} />
            ))}
          </ul>
        )}
      </section>

      {/* Public revision history + the moderator edit entry point (#31). */}
      <RecordHistory type="edition" publicId={edition.publicId} />
      <ModEditLink type="edition" editKey={String(edition.publicId)} />
      <ModReleaseEditLinks
        releases={releases.map((r) => ({ id: r.id, anchor: r.anchor }))}
      />
    </main>
  );
}
