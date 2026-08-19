import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { CoverageChips, ReleaseRow } from "~/lib/catalogRows";
import { ModEditLink, ModReleaseEditLinks, RecordHistory } from "~/lib/moderation";
import { editionPath, parsePublicId, slugParams } from "~/lib/slug";
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
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.edition.title} (Manga) — MangaDB` },
          {
            name: "description",
            content: `${loaderData.edition.title}${
              loaderData.edition.publisher
                ? ` from ${loaderData.edition.publisher.name}`
                : ""
            }: every release with format, binding, ISBNs, and release dates.`,
          },
        ]
      : [],
  }),
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
