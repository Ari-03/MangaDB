import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { Byline } from "~/lib/byline";
import { catalogQuery } from "~/lib/catalogData";
import { AboutSeriesNote, CoverageChips, ReleaseRow } from "~/lib/catalogRows";
import { Cover } from "~/lib/cover";
import { FavoriteButton } from "~/lib/favorites";
import { ConcealArt } from "~/lib/mature";
import {
  ModEditLink,
  ModReleaseEditLinks,
  RecordHistory,
} from "~/lib/moderation";
import { RatingAggregate } from "~/lib/ratings";
import { TakePanel } from "~/lib/reviews";
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

/**
 * The Edition page — the book detail page (ticket #23, spec §2/§10/§11):
 * `/edition/{id}/{slug}`, server-rendered from Convex. The header carries
 * the book's one Edition Description (CONTEXT.md), labelled when it is only
 * the Series synopsis. Release rows differ only in Format/Binding, each
 * carrying ISBNs and date, with Release Variants beneath their Release and
 * bundle-membership links.
 * Coverage chips link the covered Volumes (canonical numbering), kept
 * visibly separate from the Edition Line Position (publisher numbering).
 *
 * Releases have no page of their own (spec §11): each row anchors by ISBN
 * when present, else document ID, and `/isbn/{isbn}` 301s here at that
 * fragment. The Edition's title is composed, never stored (spec §8); a stale
 * slug or a merged Edition's old ID 301s to the canonical URL.
 *
 * Rating follows CONTEXT.md (Rating): a book that collects exactly one whole
 * Volume is rated as that Volume, and an omnibus (more than one Volume) is
 * rated as one book. Either way the target's aggregate chip joins the header
 * and the viewer's take (TakePanel: Rating, Review, Favorite) sits under the
 * cover with a line saying what it rates. A partial single-volume book and
 * Unmapped Packaging carry no rating.
 */

/**
 * What a book is rated as: the Edition itself when it collects more than one
 * Volume; else its only covered Volume, when it covers that Volume
 * completely (`volume` then names it); else nothing. The server applies the
 * same rule (convex/lib/ratings.ts), refusing single-volume Editions.
 */
function ratedAs<
  Covered extends { volumePublicId: number; extent: "complete" | "partial" },
>(editionPublicId: number, coverage: ReadonlyArray<Covered>) {
  if (new Set(coverage.map((c) => c.volumePublicId)).size > 1) {
    return {
      target: { kind: "edition" as const, publicId: editionPublicId },
      volume: undefined,
    };
  }
  const only = coverage.length === 1 ? coverage[0] : undefined;
  return only?.extent === "complete"
    ? {
        target: { kind: "volume" as const, publicId: only.volumePublicId },
        volume: only,
      }
    : null;
}

export const Route = createFileRoute("/edition/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await catalogQuery(api.catalogPages.editionPage, { publicId });
    if (!page) throw notFound();
    const canonical = editionPath(page.edition.publicId, page.edition.title);
    if (`/edition/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    // The aggregate of what the book is rated as (its Volume, or itself as
    // an omnibus): rendered with the page, then live (lib/ratings.tsx).
    const rated = ratedAs(page.edition.publicId, page.coverage);
    const rating = rated
      ? await catalogQuery(api.ratings.summary, { target: rated.target })
      : null;
    return { ...page, rating };
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // JSON-LD (spec §11, ticket #39): BreadcrumbList plus one Book per Release
  // row — Releases have no page of their own, so each Book's URL is this
  // Edition page anchored at its row. The description leads with facts
  // (publisher, date, ISBN), falling back to the Edition Description when it
  // is the book's own; that text, truncated, is also each Book's
  // `description`. The
  // Series synopsis fallback describes the series, not this book, so neither
  // uses it.
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { edition, series, releases, description, coverUrl, mature } = loaderData;
    const path = editionPath(edition.publicId, edition.title);
    const primarySeries = series[0];
    const first = releases[0];
    const facts = [
      edition.publisher ? `from ${edition.publisher.name}` : null,
      first?.pubDate ? `released ${isoPartialDate(first.pubDate)}` : null,
      first?.isbn13 ? `ISBN ${first.isbn13}` : null,
    ].filter((fact) => fact !== null);
    const blurb = description && description.source !== "series" ? description.text : null;
    // Repeated on every Book, so cut short: the full text is on the page.
    const bookDescription = blurb ? truncateDescription(blurb, 500) : null;
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
        mature,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            ...(primarySeries
              ? [
                  {
                    name: primarySeries.title,
                    path: seriesPath(
                      primarySeries.publicId,
                      primarySeries.title,
                    ),
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
              description: bookDescription,
              // No art for crawlers on a Mature Series' page (lib/mature.tsx).
              coverUrl: mature ? null : release.coverUrl,
            }),
          ),
        ),
      ],
    };
  },
  component: ConcealedEditionPage,
  notFoundComponent: EditionNotFound,
});

function EditionNotFound() {
  return (
    <main>
      <h1>Edition not found</h1>
      <p className="notice">
        No edition lives at this address. <Link to="/">Browse the catalog</Link>
        .
      </p>
    </main>
  );
}

/** A Mature Series' page hides its art from viewers who have not opted in (lib/mature.tsx). */
function ConcealedEditionPage() {
  return (
    <ConcealArt mature={Route.useLoaderData().mature}>
      <EditionPage />
    </ConcealArt>
  );
}

function EditionPage() {
  const {
    edition,
    series,
    credits,
    coverage,
    description,
    releases,
    coverUrl,
    coverIsbns,
    rating,
  } = Route.useLoaderData();
  const primarySeries = series[0];
  const rated = ratedAs(edition.publicId, coverage);
  const ratingTarget = rated?.target ?? null;
  // One covered Volume with a Label gets the numbered cloth spine (one trade
  // dress, a big number); an omnibus keeps the title placeholder.
  const single = coverage.length === 1 ? coverage[0] : undefined;
  const numbered =
    single && single.label && primarySeries
      ? { series: primarySeries.title, number: single.label }
      : undefined;

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

      <section className="detail-hero">
        <div className="detail-cover">
          <div className="detail-cover-plate">
            <Cover
              src={coverUrl}
              isbn13={coverIsbns}
              title={edition.title}
              foot={[
                single
                  ? `Vol ${single.label ?? `#${single.position}`}`
                  : "Edition",
                edition.publisher?.name,
              ]}
              numbered={numbered}
              lazy={false}
            />
          </div>
        </div>

        {/* The viewer's take under the cover, saying what it rates: the
            Volume a single-volume book collects, or the omnibus itself. A
            grid item of its own, so opening the review form can give it the
            full width. */}
        {rated ? (
          <TakePanel
            target={rated.target}
            noun={rated.volume ? "volume" : "omnibus"}
            note={
              rated.volume ? (
                <>
                  Rates the volume this book collects,{" "}
                  <Link
                    to="/volume/$publicId/$slug"
                    params={slugParams(
                      rated.volume.volumePublicId,
                      rated.volume.volumeTitle,
                    )}
                  >
                    {rated.volume.volumeTitle}
                  </Link>
                  , not this edition.
                </>
              ) : (
                "Rates this omnibus as one book."
              )
            }
          >
            <FavoriteButton target={rated.target} />
          </TakePanel>
        ) : null}

        <div className="detail-body">
          <h1 className="detail-title">{edition.title}</h1>
          <Byline credits={credits} />
          <p className="fact-chips">
            {edition.publisher ? (
              <Link
                className="chip"
                to="/publisher/$slug"
                params={{ slug: edition.publisher.slug }}
              >
                {edition.publisher.name}
              </Link>
            ) : null}
            {edition.lineName ? (
              // Edition Line Position: publisher package numbering, never the
              // canonical Volume number (spec §2).
              <span className="chip chip--line">
                {edition.lineName}
                {edition.linePosition ? (
                  <span
                    className="line-position"
                    title="Position within the edition line"
                  >
                    position {edition.linePosition}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="chip">
              {releases.length === 1
                ? "1 release"
                : `${releases.length} releases`}
            </span>
            {ratingTarget ? (
              <RatingAggregate target={ratingTarget} initial={rating} />
            ) : null}
          </p>

          {coverage.length > 0 ? (
            <CoverageChips coverage={coverage} />
          ) : edition.coverageUnmapped ? (
            <p className="detail-note">
              Which volumes this book collects is not mapped yet — it is listed in the
              publisher's own numbering until the data team maps it.
            </p>
          ) : null}

          {/* One description for the book, wherever it came from; the
              Series synopsis names the series it is about. */}
          {description ? (
            <div className="detail-blurb">
              {description.source === "series" ? (
                <AboutSeriesNote series={description.series} />
              ) : null}
              <p className="blurb-text">{description.text}</p>
            </div>
          ) : (
            <p className="detail-note">
              One publisher, one packaging of the content. Paste an ISBN into
              search to land on its row below.
            </p>
          )}

          <div className="section-head detail-section-head" id="releases">
            <h2 className="section-title">Releases</h2>
            <p className="section-note">
              The purchasable forms, differing only in format and binding.
            </p>
          </div>
          {releases.length === 0 ? (
            <p className="notice">No releases recorded for this edition yet.</p>
          ) : (
            <ul className="release-rows">
              {releases.map((release) => (
                <ReleaseRow key={release.id} release={release} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <hr className="rule" />

      {series.length > 0 || edition.publisher ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Keep browsing</h2>
            <p className="section-note">
              Other packagings of this content are listed on the series page.
            </p>
          </div>
          <div className="directory">
            {series.map((entry) => (
              <Link
                key={entry.publicId}
                className="directory-row"
                to="/series/$publicId/$slug"
                params={slugParams(entry.publicId, entry.title)}
              >
                <span className="directory-name">{entry.title}</span>
                <span className="directory-meta">
                  Series &middot; every volume and the editions covering it
                </span>
              </Link>
            ))}
            {edition.publisher ? (
              <Link
                className="directory-row"
                to="/publisher/$slug"
                params={{ slug: edition.publisher.slug }}
              >
                <span className="directory-name">{edition.publisher.name}</span>
                <span className="directory-meta">
                  Publisher &middot; profile and upcoming releases
                </span>
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Public revision history + the moderator edit entry point (#31). */}
      <RecordHistory type="edition" publicId={edition.publicId} />
      <ModEditLink type="edition" editKey={String(edition.publicId)} />
      <ModReleaseEditLinks
        releases={releases.map((r) => ({ id: r.id, anchor: r.anchor }))}
      />
    </main>
  );
}
