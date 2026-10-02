import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { FEATURES } from "../../convex/lib/features";
import { Byline } from "~/lib/byline";
import { catalogQuery, type SeriesPageData } from "~/lib/catalogData";
import { CommentsSection } from "~/lib/comments";
import { Cover, coverIsbns } from "~/lib/cover";
import { FavoriteButton } from "~/lib/favorites";
import { SeriesFollowControls } from "~/lib/follows";
import { ConcealArt } from "~/lib/mature";
import {
  ModEditLink,
  ProposeNewRecordsLink,
  RecordHistory,
} from "~/lib/moderation";
import { RatingAggregate } from "~/lib/ratings";
import { SeriesReadingControls, SeriesReadingProgress } from "~/lib/reading";
import { SeriesReportAffordance } from "~/lib/report";
import { ReviewsSection, TakePanel } from "~/lib/reviews";
import {
  bookSeriesJsonLd,
  pageHead,
  seriesTitleTag,
} from "~/lib/seo";
import { Breadcrumbs, NotFound } from "~/lib/pageScaffold";
import {
  bookLabel,
  bookTitle,
  dateSpan,
  PathShelf,
  MissingVolume,
  type EditionGroup,
} from "~/lib/seriesShelf";
import { plural } from "~/lib/format";
import { SeriesVisibilityControls } from "~/lib/sharing";
import { parsePublicId, seriesPath, slugParams } from "~/lib/slug";

/**
 * The Series page (ticket #22): `/series/{id}/{slug}`, server-rendered from
 * Convex. The Series' Editions are grouped into reading paths — the standard
 * run per publisher, then each Edition Line (Omnibus, Deluxe, …); the picker
 * shows each path's first book and `?edition=` opens that path as a shelf of
 * its books, with gaps in a standard run marked. Releases, Variants and
 * Bundles live on each book's Edition page.
 *
 * The hero: the cover (and its date span) on the left with the viewer's
 * take under it (TakePanel: Rating, Review, Follow, Favorite), the facts on
 * the right ending in the tracking bar (Reading Status, profile sharing).
 *
 * The public ID is identity; the slug is cosmetic and computed from the
 * current title (spec §8/§11). A stale or wrong slug — including the old ID
 * of a merged Series, which resolves to its survivor — 301s to the canonical
 * URL.
 */
export const Route = createFileRoute("/series/$publicId/$slug")({
  // `?edition=` picks the reading path; the loader ignores it, so switching
  // paths never refetches the page.
  validateSearch: (search: Record<string, unknown>): { edition?: string } =>
    typeof search.edition === "string" ? { edition: search.edition } : {},
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    // The rating aggregate and first pages of Reviews and Comments render
    // with the page, then follow their live queries (lib/ratings.tsx,
    // lib/reviews.tsx, lib/comments.tsx). Reviews and Comments only while
    // their feature flags are on (convex/lib/features.ts).
    const target = { kind: "series" as const, publicId };
    const [page, rating, reviews, comments] = await Promise.all([
      catalogQuery(api.catalog.seriesPage, { publicId }),
      catalogQuery(api.ratings.summary, { target }),
      FEATURES.publicReviews ? catalogQuery(api.reviews.list, { target }) : null,
      FEATURES.comments ? catalogQuery(api.comments.list, { target }) : null,
    ]);
    if (!page) throw notFound();
    const canonical = seriesPath(page.series.publicId, page.series.title);
    if (`/series/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return { ...page, rating, reviews, comments };
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList + BookSeries JSON-LD (spec §11, ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { series, volumes, coverUrl } = loaderData;
    const path = seriesPath(series.publicId, series.title);
    const volumeCount = plural(volumes.length, "volume");
    return pageHead({
      title: seriesTitleTag(series.title),
      description: `English releases of ${series.title}: ${volumeCount} in the canonical reading order, with every edition, format, and release date.`,
      path,
      image: coverUrl,
      mature: series.mature,
      breadcrumbs: [{ name: series.title }],
      jsonLd: [bookSeriesJsonLd({ title: series.title, altTitles: series.altTitles, path })],
    });
  },
  component: ConcealedSeriesPage,
  notFoundComponent: () => <NotFound noun="Series" kind="series" />,
});

const SOURCE_STATUS_LABELS = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "On hiatus",
  cancelled: "Cancelled",
} as const;

const RELATIONSHIP_LABELS = {
  sequel: "a sequel of",
  prequel: "a prequel of",
  spinoff: "a spinoff of",
  reboot: "a reboot of",
  sideStory: "a side story of",
  other: "related to",
} as const;

/**
 * The packaging facts the hero states, rolled up from the reading paths:
 * how many books and Releases, which Publishers, and the dated span.
 */
function packagingFacts(groups: ReadonlyArray<EditionGroup>) {
  const books = groups.flatMap((group) => group.books);
  const publishers = new Map<string, string>();
  for (const book of books) {
    if (book.publisher) publishers.set(book.publisher.slug, book.publisher.name);
  }
  return {
    editionCount: books.length,
    releaseCount: books.reduce((n, book) => n + book.releases.length, 0),
    publishers: [...publishers].map(([slug, name]) => ({ slug, name })),
    dateSpan: dateSpan(books),
  };
}

/** A Mature Series' page hides its art from viewers who have not opted in (lib/mature.tsx). */
function ConcealedSeriesPage() {
  return (
    <ConcealArt mature={Route.useLoaderData().series.mature}>
      <SeriesPage />
    </ConcealArt>
  );
}

function SeriesPage() {
  const page = Route.useLoaderData();
  const { edition: editionKey } = Route.useSearch();
  const { series, family, credits, volumes, editionGroups, coverUrl } = page;
  const ratingTarget = { kind: "series" as const, publicId: series.publicId };
  const facts = packagingFacts(editionGroups);
  // The first path's first book fronts the Series — the standard run leads,
  // so this is its Volume 1 whenever one is on file.
  const frontBook = editionGroups[0]?.books[0] ?? null;
  // Its ISBNs first, then the next few books' best one: when Vol. 1 has no
  // art anywhere, the series still wears its own run's jacket, not cloth.
  const heroIsbns = frontBook
    ? [
        ...coverIsbns([frontBook]),
        ...(editionGroups[0]?.books.slice(1, 6) ?? []).flatMap((book) => coverIsbns([book]).slice(0, 1)),
      ]
    : [];
  // One path needs no picker; with several, the reader picks one.
  const selected =
    editionGroups.length === 1
      ? editionGroups[0]
      : editionGroups.find((group) => group.key === editionKey);

  return (
    <main className="series-page">
      <Breadcrumbs trail={[<Link to="/series">Series</Link>]} />

      <section className="series-hero">
        <div className="series-hero-aside">
          <div className="series-cover">
            {/* The front book's jacket; coverless Series get the cloth
                binding rather than a broken image. */}
            <Cover src={coverUrl} isbn13={heroIsbns} title={series.title} lazy={false} />
          </div>
          {facts.dateSpan ? (
            <p className="note">English releases on file: {facts.dateSpan}.</p>
          ) : null}
        </div>

        {/* The viewer's take, under the cover: their private Rating (the
            chip in the body shows the public average it feeds), their own
            Review, then Follow (the explicit toggle for future-release
            interest, #29) beside the private Favorite. A grid item of its
            own, so opening the review form can give it the full width. */}
        <TakePanel target={ratingTarget} noun="series">
          <SeriesFollowControls seriesPublicId={series.publicId} />
          <FavoriteButton target={ratingTarget} />
        </TakePanel>

        <div className="series-hero-body">
          <h1 className="series-title">{series.title}</h1>
          <Byline credits={credits} />
          <div className="chips">
            {series.sourceStatus ? (
              <span className="chip" title="Status of the original publication">
                {SOURCE_STATUS_LABELS[series.sourceStatus]}
              </span>
            ) : null}
            <span className="chip">
              {plural(volumes.length, "volume", "volumes")}
            </span>
            <RatingAggregate target={ratingTarget} initial={page.rating} />
            {editionGroups.length > 1 ? (
              <span className="chip">
                {plural(editionGroups.length, "edition", "editions")}
              </span>
            ) : null}
          </div>

          {series.synopsis ? (
            <p className="series-synopsis">{series.synopsis}</p>
          ) : null}

          <dl className="facts">
            {series.sourceStatus ? (
              <div>
                <dt className="fact-term">Source status</dt>
                <dd className="fact-def">
                  {SOURCE_STATUS_LABELS[series.sourceStatus]} in Japanese
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="fact-term">Volumes</dt>
              <dd className="fact-def">
                {volumes.length} in the canonical sequence
              </dd>
            </div>
            {page.series.bookless ? (
              <div>
                <dt className="fact-term">English packaging</dt>
                <dd className="fact-def">
                  No English books on file yet — the volumes are known, but no release has
                  attached to them. This series is kept out of browse and search until one does.
                </dd>
              </div>
            ) : null}
            {facts.editionCount > 0 ? (
              <div>
                <dt className="fact-term">English packaging</dt>
                <dd className="fact-def">
                  {plural(facts.editionCount, "book", "books")},{" "}
                  {plural(facts.releaseCount, "release", "releases")}
                </dd>
              </div>
            ) : null}
            {facts.publishers.length > 0 ? (
              <div>
                <dt className="fact-term">Publishers</dt>
                <dd className="fact-def">
                  {facts.publishers.map((publisher, i) => (
                    <span key={publisher.slug}>
                      {i > 0 ? ", " : ""}
                      <Link
                        to="/publisher/$slug"
                        params={{ slug: publisher.slug }}
                      >
                        {publisher.name}
                      </Link>
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {family ? (
              <div>
                <dt className="fact-term">Series family</dt>
                <dd className="fact-def">
                  {family.name}
                  {/* The siblings, linked from the hero; the shelf further
                      down shows them as books with their relationships. */}
                  <span className="fact-sub">
                    {family.members
                      .filter((member) => member.publicId !== series.publicId)
                      .map((member, i) => (
                        <span key={member.publicId}>
                          {i > 0 ? ", " : ""}
                          <Link
                            to="/series/$publicId/$slug"
                            params={slugParams(
                              member.publicId,
                              member.title,
                            )}
                          >
                            {member.title}
                          </Link>
                        </span>
                      ))}
                  </span>
                </dd>
              </div>
            ) : null}
            {series.altTitles.length > 0 ? (
              <div>
                <dt className="fact-term">Also known as</dt>
                <dd className="fact-def">{series.altTitles.join(", ")}</dd>
              </div>
            ) : null}
          </dl>

          {/* The signed-in tracking bar: where the viewer is in the story,
              then a footer line for profile sharing. Every control inside
              renders null signed out, which leaves the groups empty — CSS
              hides the bar then, so the public page keeps the hero clean. */}
          <div className="owner-bar">
            <div className="track-group track-group--reading">
              {/* Series Reading Status is set only here, by explicit choice
                  (#28); the tracking prompts never change it without
                  confirmation. Progress counts read Volumes, not entries. */}
              <SeriesReadingControls seriesPublicId={series.publicId} />
              <SeriesReadingProgress
                seriesPublicId={series.publicId}
                volumeCount={volumes.length}
              />
            </div>
            <div className="track-group track-group--sharing">
              {/* Per-Series visibility overrides for the public profile (#30),
                  in a popover so the bar never reflows. */}
              <SeriesVisibilityControls seriesPublicId={series.publicId} />
            </div>
          </div>
        </div>
      </section>

      {editionGroups.length > 1 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Editions</h2>
            <p className="section-note">
              Each edition is its own run of books. Pick one to see its
              reading path.
            </p>
          </div>
          <EditionPicker
            groups={editionGroups}
            selectedKey={selected?.key ?? null}
            series={series}
          />
        </section>
      ) : null}

      {selected ? (
        <section className="section reading-path">
          <div className="section-head">
            <h2 className="section-title">
              {editionGroups.length > 1 ? selected.name : "Reading path"}
            </h2>
            <p className="section-note">
              {selected.publisher ? `${selected.publisher.name} · ` : ""}
              {plural(selected.books.length, "book", "books")}
              {selected.kind === "line"
                ? " in the publisher's own numbering"
                : " in reading order"}
            </p>
          </div>
          {/* Signed in, every cover wears its badges and offers Want /
              Ordered / Own and Mark read on hover (lib/quickActions.tsx). */}
          <PathShelf
            group={selected}
            volumes={volumes}
            seriesTitle={series.title}
            seriesPublicId={series.publicId}
          />
        </section>
      ) : null}

      {editionGroups.length === 0 ? (
        <section className="section reading-path">
          <div className="section-head">
            <h2 className="section-title">Volumes</h2>
            <p className="section-note">
              No English edition is on file for this series yet.
            </p>
          </div>
          {volumes.length === 0 ? (
            <p className="notice">No volumes are recorded for this series yet.</p>
          ) : (
            <div className="shelf">
              {volumes.map((volume) => (
                <MissingVolume
                  key={volume.publicId}
                  volume={volume}
                  seriesTitle={series.title}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {family ? <FamilySection family={family} self={series} /> : null}

      {FEATURES.publicReviews ? (
        <ReviewsSection target={ratingTarget} initial={page.reviews} noun="series" />
      ) : null}
      {FEATURES.comments ? (
        <CommentsSection target={ratingTarget} initial={page.comments} noun="series" />
      ) : null}

      {/* Partially imported Series show as-is; every Series page carries the
          report affordance feeding the proposal queue (#40, spec §7). */}
      <SeriesReportAffordance seriesPublicId={series.publicId} />

      {/* Public revision history + the data-team entry points (#31/#32). */}
      <RecordHistory type="series" publicId={series.publicId} />
      <ModEditLink type="series" editKey={String(series.publicId)} />
      <ProposeNewRecordsLink seriesPublicId={series.publicId} />
    </main>
  );
}

/**
 * The edition picker: each path's first book as its cover, then the path's
 * name, publisher and extent. Selection lives in the URL (`?edition=`), so a
 * path is shareable and the picker works before hydration.
 */
function EditionPicker({
  groups,
  selectedKey,
  series,
}: {
  groups: ReadonlyArray<EditionGroup>;
  selectedKey: string | null;
  series: SeriesPageData["series"];
}) {
  return (
    <nav className="edition-picker" aria-label="Editions">
      {groups.map((group) => {
        const first = group.books[0];
        const span = dateSpan(group.books);
        const isSelected = group.key === selectedKey;
        return (
          <Link
            key={group.key}
            className={isSelected ? "edition-card is-selected" : "edition-card"}
            to="/series/$publicId/$slug"
            params={slugParams(series.publicId, series.title)}
            search={{ edition: group.key }}
            // Switching editions keeps the reader where they are.
            resetScroll={false}
            aria-current={isSelected ? "true" : undefined}
          >
            <span className="edition-card-cover">
              {first ? (
                <Cover
                  src={first.coverUrl}
                  isbn13={coverIsbns([first])}
                  title={bookTitle(series.title, first)}
                  foot={[bookLabel(first), group.publisher?.name]}
                />
              ) : null}
            </span>
            <span className="edition-card-body">
              <span className="edition-card-name">{group.name}</span>
              {group.publisher ? (
                <span className="edition-card-meta">{group.publisher.name}</span>
              ) : null}
              <span className="edition-card-meta">
                {plural(group.books.length, "book", "books")}
                {span ? ` · ${span}` : ""}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The Series Family shelf: sibling Series stand next to this one, each
 * keeping its own Volume sequence. The typed relationships are spelled out
 * underneath as sentences — the edge is stored once, whichever end this
 * Series is.
 */
function FamilySection({
  family,
  self,
}: {
  family: NonNullable<SeriesPageData["family"]>;
  self: SeriesPageData["series"];
}) {
  return (
    <section className="section series-family">
      <div className="section-head">
        <h2 className="section-title">{family.name} series family</h2>
        <p className="section-note">
          Related series share this shelf and keep their own volume sequences.
        </p>
      </div>
      <div className="shelf">
        {family.members.map((member) => {
          const isSelf = member.publicId === self.publicId;
          return (
            <div className="shelf-item" key={member.publicId}>
              <div className="cover-wrap">
                {isSelf ? (
                  <Cover title={member.title} />
                ) : (
                  <Link
                    className="cover-link"
                    to="/series/$publicId/$slug"
                    params={slugParams(member.publicId, member.title)}
                    aria-label={member.title}
                  >
                    <Cover title={member.title} />
                  </Link>
                )}
              </div>
              <div className="caption">
                {isSelf ? (
                  <span className="caption-title" aria-current="page">
                    {member.title}
                  </span>
                ) : (
                  <Link
                    className="caption-title"
                    to="/series/$publicId/$slug"
                    params={slugParams(member.publicId, member.title)}
                  >
                    {member.title}
                  </Link>
                )}
                <div className="caption-meta">
                  {isSelf ? <span>You are here</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {family.relationships.length > 0 ? (
        <ul className="family-relationships">
          {family.relationships.map((rel, i) => (
            <li key={i}>
              {rel.from.title} is {RELATIONSHIP_LABELS[rel.type]} {rel.to.title}
              {rel.note ? ` — ${rel.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
