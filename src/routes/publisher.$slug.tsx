import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import {
  catalogQuery,
  fetchSeriesBrowse,
  type PublisherPageData,
  type SeriesBrowseItem,
} from "~/lib/catalogData";
import { ConcealArt, showMature } from "~/lib/mature";
import { Cover } from "~/lib/cover";
import { plural } from "~/lib/format";
import {
  addMonths,
  currentMonth,
  MONTH_NAMES,
  monthEndSortKey,
  monthParam,
  monthTitle,
  sortKeyMonth,
  todaySortKey,
  weekdayName,
  type YearMonth,
} from "~/lib/month";
import { ModEditLink } from "~/lib/moderation";
import {
  organizationJsonLd,
  pageHead,
  publisherTitleTag,
} from "~/lib/seo";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { slugParams } from "~/lib/slug";
import { SeriesShelfItem } from "~/lib/shelfItem";

// The upcoming lane's horizon: the three months after this one (~a 90-day
// shelf, prototype #17). The Releases browser owns everything beyond it.
const LANE_HORIZON_MONTHS = 3;
/** Top series shown: the publisher's biggest active series. */
const TOP_SERIES = 12;
/** Books a month shelf shows before "Show all". */
const SHELF_PREVIEW = 12;

/**
 * The Publisher Spotlight page (ticket #25, spec §10/§11): `/publisher/{slug}`
 * is a publisher-led profile. Identity and a few numbers first, then this
 * month's books (still to come, then already out), the publisher's top
 * series, and what lands in the months after, each book once however many
 * formats it comes in (publisher.ts foldFormats). The Releases browser,
 * pre-filtered to this Publisher, holds the full calendar. The
 * cross-publisher overview is the Publishers board (`/publishers`).
 *
 * Publishers are the slug-only URL exception (spec §8): a renamed Publisher's
 * old slug 301s here via publisherSlugRedirects, and a merged Publisher's
 * slug 301s to its survivor's. An imprint links up to its parent company,
 * and a parent lists its imprints.
 */
export const Route = createFileRoute("/publisher/$slug")({
  loader: async ({ params }) => {
    // Lane bounds are computed here (UTC) so SSR and hydration agree,
    // mirroring the Releases browser's month anchor.
    const now = new Date();
    const month = currentMonth(now);
    const todaySort = todaySortKey(now);
    // Top series come from the Series library: most volumes among those with
    // a release in the past year. Popularity (follows, collectors) will be a
    // better signal once the catalog has enough of it.
    const [page, top, facets] = await Promise.all([
      catalogQuery(api.publisher.publisherPage, {
        slug: params.slug,
        todaySort,
        horizonSort: monthEndSortKey(addMonths(month, LANE_HORIZON_MONTHS)),
        showMature: showMature(),
      }),
      fetchSeriesBrowse({
        sort: "volumes",
        publishers: [params.slug],
        timing: "past-12m",
        pageSize: TOP_SERIES,
      }),
      catalogQuery(api.seriesBrowse.facets, { showMature: showMature() }),
    ]);
    if (!page) throw notFound();
    if ("redirectTo" in page) {
      throw redirect({
        href: `/publisher/${page.redirectTo}`,
        statusCode: 301,
      });
    }
    return {
      ...page,
      month,
      todaySort,
      topSeries: top?.items ?? [],
      activeSeries: top?.total ?? null,
      seriesCount:
        facets?.publishers.find((p) => p.slug === params.slug)?.count ?? null,
    };
  },
  // Title/description formulas, canonical link, and BreadcrumbList +
  // Organization JSON-LD (spec §11, ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { publisher } = loaderData;
    const path = `/publisher/${publisher.slug}`;
    return pageHead({
      title: publisherTitleTag(publisher.name),
      description: `${publisher.name} on MangaDB: publisher profile, upcoming English manga releases, and the full release calendar.`,
      path,
      // An adult-only publisher is marked for safe-search (lib/mature.tsx).
      mature: publisher.mature,
      breadcrumbs: [{ name: publisher.name }],
      jsonLd: [
        organizationJsonLd({
          name: publisher.name,
          path,
          description: publisher.description,
        }),
      ],
    });
  },
  component: ConcealedPublisherPage,
  notFoundComponent: PublisherNotFound,
});

function PublisherNotFound() {
  return (
    <main>
      <h1>Publisher not found</h1>
      <p className="notice">
        No publisher lives at this address.{" "}
        <Link to="/releases">Browse the release calendar</Link>.
      </p>
    </main>
  );
}


type Book = PublisherPageData["upcoming"][number];

/** Still to come: dated today or later, or dated only to this month. */
const stillToCome = (book: Book, todaySort: number) =>
  book.sort >= todaySort || book.day === null;

/** "Tue, Sep 29", or "Sep, date TBA" for a book dated only to its month. */
function bookDate(book: Book): string {
  const { year, month } = sortKeyMonth(book.sort);
  const name = MONTH_NAMES[month - 1]?.slice(0, 3) ?? "";
  return book.day === null
    ? `${name}, date TBA`
    : `${weekdayName({ year, month }, book.day)}, ${name} ${book.day}`;
}

/** Books after this month grouped by month, in date order. */
function groupByMonth(books: ReadonlyArray<Book>) {
  const groups: Array<{ month: YearMonth; books: Book[] }> = [];
  for (const book of books) {
    const month = sortKeyMonth(book.sort);
    const group = groups.at(-1);
    if (group && group.month.year === month.year && group.month.month === month.month) {
      group.books.push(book);
    } else {
      groups.push({ month, books: [book] });
    }
  }
  return groups;
}

/**
 * An adult-only publisher's page (lib/mature.tsx) says why its lanes are
 * empty for viewers who have not opted in to mature titles.
 */
function ConcealedPublisherPage() {
  return (
    <ConcealArt mature={Route.useLoaderData().publisher.mature}>
      <PublisherPage />
    </ConcealArt>
  );
}

function PublisherPage() {
  const {
    publisher,
    parent,
    imprints,
    thisMonth,
    upcoming,
    upcomingCapped,
    nextSort,
    editionCount,
    month,
    todaySort,
    topSeries,
    seriesCount,
  } = Route.useLoaderData();
  const toCome = thisMonth.books.filter((book) => stillToCome(book, todaySort));
  // Already out: the most recent first.
  const out = thisMonth.books.filter((book) => !stillToCome(book, todaySort)).reverse();
  const next = [...thisMonth.books, ...upcoming].find((book) => book.sort === nextSort);
  const monthName = MONTH_NAMES[month.month - 1];
  const calendarMonth = (m: YearMonth) => ({
    to: "/releases/$month" as const,
    params: { month: monthParam(m) },
    search: { publisher: publisher.slug },
  });

  return (
    <main className="publisher-page">
      <Breadcrumbs trail={[<Link to="/publishers">Publishers</Link>]} />

      <header className="pub-hero">
        <span className="pub-logo" aria-hidden="true">
          {publisher.name}
        </span>
        <div className="pub-body">
          <h1 className="pub-title">{publisher.name}</h1>
          {parent ? (
            <p className="pub-parent">
              An imprint of{" "}
              <Link to="/publisher/$slug" params={{ slug: parent.slug }}>
                {parent.name}
              </Link>
            </p>
          ) : null}
          {publisher.description ? (
            <p className="pub-blurb">{publisher.description}</p>
          ) : null}
          {imprints.length > 0 ? (
            <p className="pub-imprints">
              Imprints:{" "}
              {imprints.map((imprint, i) => (
                <span key={imprint.slug}>
                  {i > 0 ? ", " : null}
                  <Link to="/publisher/$slug" params={{ slug: imprint.slug }}>
                    {imprint.name}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
          {/* The clear route into the main Releases browser, pre-filtered
              (prototype #17): cross-publisher comparison lives there. */}
          <p className="pub-cta">
            <Link
              className="btn btn-primary"
              to="/releases"
              search={{ publisher: publisher.slug }}
            >
              Every {publisher.name} release in the calendar
            </Link>
          </p>
        </div>
      </header>

      <div className="stat-row pub-stats">
        {seriesCount !== null ? (
          <div className="stat">
            <div className="stat-num">{seriesCount.toLocaleString("en-US")}</div>
            <div className="stat-label">series</div>
          </div>
        ) : null}
        <div className="stat">
          <div className="stat-num">
            {editionCount.count.toLocaleString("en-US")}
            {editionCount.capped ? "+" : ""}
          </div>
          <div className="stat-label">books in the catalog</div>
        </div>
        <div className="stat">
          <div className="stat-num">
            {thisMonth.releases}
            {thisMonth.capped ? "+" : ""}
          </div>
          <div className="stat-label">releases in {monthName}</div>
        </div>
        <div className="stat">
          <div className="stat-num pub-next">{next ? bookDate(next) : "None"}</div>
          <div className="stat-label">next release</div>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            {monthName} from {publisher.name}
          </h2>
          <p className="section-note">
            {toCome.length} still to come, {out.length} out already
          </p>
          <Link className="section-link" {...calendarMonth(month)}>
            {monthName} in the calendar
          </Link>
        </div>
        {toCome.length === 0 && out.length === 0 ? (
          <p className="notice">
            Nothing from {publisher.name} is dated in {monthTitle(month)}.
          </p>
        ) : null}
        {toCome.length > 0 ? (
          <BookShelf title="Still to come" books={toCome} eager />
        ) : null}
        {out.length > 0 ? <BookShelf title="Out already" books={out} /> : null}
        {thisMonth.capped ? (
          <p className="note lane-more">
            A busy month: the calendar has every {publisher.name} release.
          </p>
        ) : null}
      </section>

      {topSeries.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Top series</h2>
            <p className="section-note">
              Their biggest series with a release in the past year
            </p>
            <Link
              className="section-link"
              to="/series"
              search={{ publisher: publisher.slug }}
            >
              All {seriesCount ?? ""} {publisher.name} series
            </Link>
          </div>
          <div className="shelf">
            {topSeries.map((item) => (
              <SeriesItem key={item.publicId} item={item} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">After {monthName}</h2>
          <p className="section-note">
            The next {LANE_HORIZON_MONTHS} months as announced so far
          </p>
          <Link
            className="section-link"
            {...calendarMonth(addMonths(month, 1))}
          >
            Open the calendar
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <p className="notice">
            Nothing from {publisher.name} announced for the next{" "}
            {LANE_HORIZON_MONTHS} months yet.
          </p>
        ) : (
          groupByMonth(upcoming).map((group) => (
            <BookShelf
              key={monthParam(group.month)}
              title={
                <Link {...calendarMonth(group.month)} rel="nofollow">
                  {monthTitle(group.month)}
                </Link>
              }
              books={group.books}
            />
          ))
        )}
        {upcomingCapped ? (
          <p className="note lane-more">
            Showing the next {upcoming.length}.{" "}
            <Link to="/releases" search={{ publisher: publisher.slug }}>
              See every {publisher.name} release in the calendar
            </Link>
            .
          </p>
        ) : null}
      </section>

      {/* The moderator/administrator edit entry point (#31); publishers are
          keyed by slug in the edit form. */}
      <ModEditLink type="publisher" editKey={publisher.slug} />
    </main>
  );
}

/**
 * A titled shelf of books, SHELF_PREVIEW at first and the rest on request,
 * so a busy month stays a glance until the reader asks for it.
 */
function BookShelf({
  title,
  books,
  eager = false,
}: {
  title: ReactNode;
  books: ReadonlyArray<Book>;
  eager?: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? books : books.slice(0, SHELF_PREVIEW);
  return (
    <div className="pub-shelf">
      <h3 className="pub-shelf-title">
        {title} <span className="pub-shelf-count">{books.length}</span>
      </h3>
      <div className="shelf">
        {shown.map((book, i) => (
          <BookItem key={book.id} book={book} eager={eager && i < 6} />
        ))}
      </div>
      {books.length > shown.length ? (
        <button type="button" className="btn btn-sm pub-shelf-more" onClick={() => setAll(true)}>
          Show all {books.length}
        </button>
      ) : null}
    </div>
  );
}

const formatLabel = ({ format, binding }: Book["formats"][number]) =>
  format === "digital"
    ? "Digital"
    : binding
      ? binding.charAt(0).toUpperCase() + binding.slice(1)
      : "Print";

/** One book: its cover to the Edition page, the Series, date, and formats. */
function BookItem({ book, eager }: { book: Book; eager: boolean }) {
  const lead = book.series[0];
  const title = [lead?.title, book.volumeLabel].filter(Boolean).join(" ");
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        {/* The cover repeats the caption's link, so it stays out of the tab order. */}
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={slugParams(book.edition.publicId, book.edition.title)}
          hash={book.anchor}
          tabIndex={-1}
          aria-hidden="true"
        >
          <Cover
            src={book.coverUrl}
            isbn13={book.coverIsbns}
            title={title}
            foot={[book.volumeLabel, book.publisher?.name]}
            lazy={!eager}
          />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/edition/$publicId/$slug"
          params={slugParams(book.edition.publicId, book.edition.title)}
          hash={book.anchor}
        >
          {lead?.title ?? book.edition.title}
        </Link>
        <div className="caption-meta">
          {book.volumeLabel ? <span>{book.volumeLabel}</span> : null}
          {book.volumeLabel ? <span className="dot" /> : null}
          <span>{bookDate(book)}</span>
        </div>
        <p className="caption-sub pub-formats">
          {book.formats.map((format) => (
            <span key={`${format.format}-${format.binding}`} className={`chip chip--${format.format}`}>
              {formatLabel(format)}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

/** A top series: its jacket to the Series page, and how big it is. */
function SeriesItem({ item }: { item: SeriesBrowseItem }) {
  return (
    <SeriesShelfItem series={item}>
      <div className="caption-meta">
        <span>{plural(item.volumeCount, "volume")}</span>
      </div>
    </SeriesShelfItem>
  );
}
