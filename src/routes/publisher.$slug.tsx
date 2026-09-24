import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";

import {
  addMonths,
  currentMonth,
  monthEndSortKey,
  monthParam,
  monthTitle,
  todaySortKey,
  type YearMonth,
} from "~/lib/month";
import { ModEditLink } from "~/lib/moderation";
import { AgendaView } from "~/lib/releasesBrowser";
import {
  breadcrumbListJsonLd,
  jsonLdScript,
  organizationJsonLd,
  pageHead,
  publisherTitleTag,
} from "~/lib/seo";
import { fetchPublisherPage, type PublisherPageData } from "~/server/publisher";

// The bounded lane's horizon: today through the end of the month three months
// out (~a 90-day shelf, prototype #17). The Releases browser owns everything
// beyond it.
const LANE_HORIZON_MONTHS = 3;

/**
 * The Publisher Spotlight page (ticket #25, spec §10/§11): `/publisher/{slug}`
 * is a publisher-led profile — identity and context first, then a bounded
 * upcoming-Releases lane — with a clear route into the main Releases browser
 * pre-filtered to this Publisher. There is no cross-publisher overview page;
 * that comparison lives in the browser (prototype #17's decision).
 *
 * Publishers are the slug-only URL exception (spec §8): a renamed Publisher's
 * old slug 301s here via publisherSlugRedirects, and a merged Publisher's
 * slug 301s to its survivor's.
 */
export const Route = createFileRoute("/publisher/$slug")({
  loader: async ({ params }) => {
    // Lane bounds are computed here (UTC) so SSR and hydration agree,
    // mirroring the Releases browser's month anchor.
    const now = new Date();
    const page = await fetchPublisherPage({
      data: {
        slug: params.slug,
        todaySort: todaySortKey(now),
        horizonSort: monthEndSortKey(
          addMonths(currentMonth(now), LANE_HORIZON_MONTHS),
        ),
      },
    });
    if (!page) throw notFound();
    if ("redirectTo" in page) {
      throw redirect({
        href: `/publisher/${page.redirectTo}`,
        statusCode: 301,
      });
    }
    return page;
  },
  // Title/description formulas, canonical link, and BreadcrumbList +
  // Organization JSON-LD (spec §11, ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { publisher } = loaderData;
    const path = `/publisher/${publisher.slug}`;
    return {
      ...pageHead({
        title: publisherTitleTag(publisher.name),
        description: `${publisher.name} on MangaDB: publisher profile, upcoming English manga releases, and the full release calendar.`,
        path,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: publisher.name },
          ]),
        ),
        jsonLdScript(
          organizationJsonLd({
            name: publisher.name,
            path,
            description: publisher.description,
          }),
        ),
      ],
    };
  },
  component: PublisherPage,
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

/**
 * Lane rows grouped for display: one group per month (rows carry yyyymmdd
 * sort keys, spec §8), with year-only-precision rows (month 0) in their own
 * "month to be announced" group.
 */
function groupLaneByMonth(upcoming: PublisherPageData["upcoming"]) {
  const groups: Array<{
    key: string;
    year: number;
    month: number | null;
    rows: PublisherPageData["upcoming"];
  }> = [];
  for (const row of upcoming) {
    const year = Math.floor(row.sort / 10000);
    const month = Math.floor(row.sort / 100) % 100 || null;
    const key = `${year}-${month ?? "tba"}`;
    const group = groups.find((g) => g.key === key);
    if (group) group.rows.push(row);
    else groups.push({ key, year, month, rows: [row] });
  }
  return groups;
}

function PublisherPage() {
  const { publisher, upcoming, upcomingCapped, editionCount } =
    Route.useLoaderData();
  const groups = groupLaneByMonth(upcoming);

  return (
    <main className="publisher-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Publisher</span>
      </nav>

      <header className="pub-hero">
        <span className="pub-logo" aria-hidden="true">
          {publisher.name}
        </span>
        <div className="pub-body">
          <h1 className="pub-title">{publisher.name}</h1>
          {publisher.description ? (
            <p className="pub-blurb">{publisher.description}</p>
          ) : null}
          {editionCount.count > 0 ? (
            <p className="fact-chips">
              <span className="chip">
                {editionCount.count}
                {editionCount.capped ? "+" : ""} edition
                {editionCount.count === 1 && !editionCount.capped ? "" : "s"} in
                the catalog
              </span>
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

      <hr className="rule" />

      <section className="section publisher-upcoming">
        <div className="section-head">
          <h2 className="section-title">
            Landing in the next {LANE_HORIZON_MONTHS} months
          </h2>
          <p className="section-note">
            Past months, other publishers and format filters live in the release
            browser.
          </p>
          <Link
            className="section-link"
            to="/releases"
            search={{ publisher: publisher.slug }}
          >
            Open the release browser
          </Link>
        </div>

        {groups.length === 0 ? (
          <p className="notice">
            Nothing announced from {publisher.name} in the next{" "}
            {LANE_HORIZON_MONTHS} months.{" "}
            <Link to="/releases" search={{ publisher: publisher.slug }}>
              See their full release calendar
            </Link>
            .
          </p>
        ) : (
          groups.map((group) => {
            const anchor: YearMonth = {
              year: group.year,
              month: group.month ?? 1,
            };
            return (
              <section key={group.key} className="publisher-lane-month">
                <h3>
                  {group.month === null ? (
                    `${group.year} — month to be announced`
                  ) : (
                    <Link
                      to="/releases/$month"
                      params={{ month: monthParam(anchor) }}
                      search={{ publisher: publisher.slug }}
                      rel="nofollow"
                    >
                      {monthTitle(anchor)}
                    </Link>
                  )}
                </h3>
                <AgendaView anchor={anchor} releases={group.rows} />
              </section>
            );
          })
        )}

        {upcomingCapped ? (
          <p className="note lane-more">
            Showing the next {upcoming.length}.{" "}
            <Link to="/releases" search={{ publisher: publisher.slug }}>
              See every {publisher.name} release in the browser
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
