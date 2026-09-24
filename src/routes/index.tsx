import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { CSSProperties, ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import { clothColor, Cover } from "~/lib/cover";
import {
  currentMonth,
  MONTH_NAMES,
  monthParam,
  monthTitle,
  todaySortKey,
  type YearMonth,
} from "~/lib/month";
import { pageHead, SITE_NAME } from "~/lib/seo";
import { slugify, slugParams } from "~/lib/slug";
import { convexServerClient } from "~/server/convex";
import { fetchMonthReleases, type BrowseRelease } from "~/server/releases";

// Scaffold proof (#21): the home page server-renders the result of a Convex
// query. Runs only on the server; the Convex URL never reaches the client
// bundle by way of this function. #22 adds the browse list of Series so the
// catalog is reachable by link, not just by URL.
/** Two ledges of the newest Series in the catalog. */
const SERIES_SHELF_LIMIT = 14;

const fetchHomeData = createServerFn({ method: "GET" }).handler(async () => {
  const convex = convexServerClient();
  if (!convex) return null;
  const [stats, series] = await Promise.all([
    convex.query(api.catalog.stats, {}),
    convex.query(api.catalog.recentSeries, { limit: SERIES_SHELF_LIMIT }),
  ]);
  return { stats, series };
});

export const Route = createFileRoute("/")({
  // The shelves are server-rendered from the same public month window the
  // Releases browser uses (src/server/releases.ts) — never a client-side
  // Convex read for public catalog data.
  loader: async () => {
    const month = currentMonth();
    const [home, releases] = await Promise.all([
      fetchHomeData(),
      fetchMonthReleases({ data: month }),
    ]);
    // The "today" boundary travels with the loader data so SSR and hydration
    // group the shelves identically.
    return { home, month, todaySort: todaySortKey(), releases };
  },
  // Canonical + social card for the home page (ticket #39); the title and
  // description templates live in the root route's defaults.
  head: () =>
    pageHead({
      title: `${SITE_NAME} – English Manga Volumes & Release Dates`,
      description:
        "Track English manga volume releases: what volumes exist, when each edition comes out, and which ones you own, want, or have read.",
      path: "/",
    }),
  component: Home,
});

const LABELS = [
  ["series", "Series"],
  ["volumes", "Volumes"],
  ["editions", "Editions"],
  ["releases", "Releases"],
  ["publishers", "Publishers"],
] as const;

/** Covers standing on the hero's ledges: three short rows at most. */
const HERO_ROWS = 3;
const HERO_COLS = 5;
/** Below this a shelf of Series reads as a gap, so the link list serves. */
const SERIES_SHELF_MIN = 4;
/** Home shelves are a taste of the month; the agenda holds the whole of it. */
const SHELF_LIMIT = 14;
const NEXT_SHELF_LIMIT = 7;

function Home() {
  const { home, month, todaySort, releases } = Route.useLoaderData();
  const stats = home?.stats ?? null;
  const series = home?.series ?? [];
  const monthReleases = releases?.releases ?? [];
  const heroCovers = monthReleases.slice(0, HERO_ROWS * HERO_COLS);

  return (
    <main className="home">
      <section className={heroCovers.length > 0 ? "hero" : "hero hero--solo"}>
        <div className="hero-copy">
          <h1 className="hero-title">Know what lands on the shelf this week.</h1>
          <p className="hero-sub">
            MangaDB tracks every English manga volume, every edition that
            collects it, and every release date — so you always know what to buy
            next and what you already own.
          </p>
          <div className="hero-cta">
            <Link className="btn btn-primary" to="/releases">
              Open the release agenda
            </Link>
            <Link className="btn" to="/search" search={{ q: "" }}>
              Find a series
            </Link>
          </div>
          {stats ? (
            <div className="stat-row">
              {LABELS.map(([key, label]) => (
                <div className="stat" key={key}>
                  <div className="stat-num">
                    {groupDigits(stats[key].count)}
                    {stats[key].capped ? "+" : ""}
                  </div>
                  <div className="stat-label">{label}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="notice hero-notice">
              Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
              README) and restart to server-render live catalog counts here.
            </p>
          )}
        </div>
        {heroCovers.length > 0 ? (
          <HeroShelf releases={heroCovers} />
        ) : null}
      </section>

      <ReleaseShelves
        month={month}
        todaySort={todaySort}
        releases={monthReleases}
      />

      {series.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Recently added series</h2>
            <p className="section-note">
              The newest additions to the catalog
            </p>
            <Link className="section-link" to="/search" search={{ q: "" }}>
              Search all series
            </Link>
          </div>
          {series.length >= SERIES_SHELF_MIN ? (
            <div className="shelf">
              {series.map((entry) => (
                <div className="shelf-item" key={entry.publicId}>
                  <div className="cover-wrap">
                    <Link
                      className="cover-link"
                      to="/series/$publicId/$slug"
                      params={{
                        publicId: String(entry.publicId),
                        slug: slugify(entry.title),
                      }}
                      tabIndex={-1}
                      aria-hidden="true"
                    >
                      {/* The Series' first jacket (lib/covers.ts); a Series
                          with no art anywhere stands as a cloth-bound book
                          carrying its own title. */}
                      <Cover
                        src={entry.coverUrl}
                        isbn13={entry.coverIsbn}
                        title={entry.title}
                      />
                    </Link>
                  </div>
                  <div className="caption">
                    <Link
                      className="caption-title"
                      to="/series/$publicId/$slug"
                      params={{
                        publicId: String(entry.publicId),
                        slug: slugify(entry.title),
                      }}
                    >
                      {entry.title}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ul className="series-links">
              {series.map((entry) => (
                <li key={entry.publicId}>
                  <Link
                    to="/series/$publicId/$slug"
                    params={{
                      publicId: String(entry.publicId),
                      slug: slugify(entry.title),
                    }}
                  >
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  );
}

/** Three short ledges of this month's covers, standing beside the hero copy. */
function HeroShelf({ releases }: { releases: Array<BrowseRelease> }) {
  // A thin month should not leave four fifths of a five-wide ledge bare, so
  // the shelf narrows to what it actually holds (never below three).
  const cols = Math.min(HERO_COLS, Math.max(3, releases.length));
  const rows: Array<Array<BrowseRelease>> = [];
  for (let i = 0; i < releases.length; i += cols) {
    rows.push(releases.slice(i, i + cols));
  }
  return (
    <div
      className="hero-shelf"
      style={{ "--hero-cols": cols } as CSSProperties}
      role="group"
      aria-label="Covers publishing this month"
    >
      {rows.map((row, index) => (
        <div className="hero-row" key={index}>
          {row.map((release) => (
            <EditionLink className="cover-link" release={release} key={release.id}>
              <Cover
                src={release.coverUrl}
                isbn13={release.coverIsbn}
                title={releaseTitle(release)}
                foot={[release.volumeLabel, release.publisher?.name]}
                lazy={index > 0}
              />
            </EditionLink>
          ))}
        </div>
      ))}
    </div>
  );
}

type DayGroup = { day: number; sort: number; releases: Array<BrowseRelease> };

/**
 * The month window bucketed by publication day, chronological (the query
 * returns it date-sorted). Month-precision Releases — day unknown, sort
 * yyyymm00 — belong to no day and are kept apart rather than heading the
 * shelf as if they shipped on the first.
 */
function groupByDay(releases: Array<BrowseRelease>) {
  const dated: Array<DayGroup> = [];
  const undated: Array<BrowseRelease> = [];
  for (const release of releases) {
    if (release.day === null) {
      undated.push(release);
      continue;
    }
    const open = dated[dated.length - 1];
    if (open && open.day === release.day) open.releases.push(release);
    else dated.push({ day: release.day, sort: release.sort, releases: [release] });
  }
  return { dated, undated };
}

/**
 * The home shelves: the nearest publication day the month still has ahead of
 * it (falling back to its last one once the month has shipped), then the day
 * after it. An empty month is an invitation, never a blank section.
 */
function ReleaseShelves({
  month,
  todaySort,
  releases,
}: {
  month: YearMonth;
  todaySort: number;
  releases: Array<BrowseRelease>;
}) {
  const { dated, undated } = groupByDay(releases);
  const ahead = dated.findIndex((group) => group.sort >= todaySort);
  const primaryIndex = ahead === -1 ? dated.length - 1 : ahead;
  const primary = dated[primaryIndex] ?? null;
  const secondary = primary ? (dated[primaryIndex + 1] ?? null) : null;

  if (!primary) {
    // No dated day left in the window: either the month holds only
    // day-to-be-announced Releases, or it holds nothing at all.
    return (
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            {undated.length > 0
              ? `Coming in ${MONTH_NAMES[month.month - 1]}`
              : "On the shelf this month"}
          </h2>
          <p className="section-note">
            {undated.length > 0
              ? `${countLabel(undated.length)}, publication day still to be announced`
              : `Nothing is dated for ${monthTitle(month)} yet`}
          </p>
          {/* An empty month carries its own call to action below, so the
              section head does not repeat it. */}
          {undated.length > 0 ? (
            <Link className="section-link" to="/releases">
              Full agenda for {MONTH_NAMES[month.month - 1]}
            </Link>
          ) : null}
        </div>
        {undated.length > 0 ? (
          <Shelf releases={undated.slice(0, SHELF_LIMIT)} eager />
        ) : (
          <EmptyMonth month={month} />
        )}
      </section>
    );
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            {primaryHeading(primary.day, todaySort)}
          </h2>
          <p className="section-note">
            {fullDate(month, primary.day)} — {countLabel(primary.releases.length)}
          </p>
          <Link className="section-link" to="/releases">
            Full agenda for {MONTH_NAMES[month.month - 1]}
          </Link>
        </div>
        <Shelf releases={primary.releases.slice(0, SHELF_LIMIT)} eager />
      </section>

      {secondary ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">
              Next {weekdayFull(month, secondary.day)}, {secondary.day}{" "}
              {MONTH_NAMES[month.month - 1]}
            </h2>
            <p className="section-note">
              {countLabel(secondary.releases.length)} already dated
            </p>
            <Link
              className="section-link"
              to="/releases/$month"
              params={{ month: monthParam(month) }}
              search={{}}
            >
              See the month grid
            </Link>
          </div>
          <Shelf releases={secondary.releases.slice(0, NEXT_SHELF_LIMIT)} />
        </section>
      ) : null}
    </>
  );
}

/** A row of Releases as shelved books: cover, then the ledge and its label. */
function Shelf({
  releases,
  eager = false,
}: {
  releases: Array<BrowseRelease>;
  eager?: boolean;
}) {
  return (
    <div className="shelf">
      {releases.map((release) => {
        const lead = release.series[0];
        return (
          <div className="shelf-item" key={release.id}>
            <div className="cover-wrap">
              <EditionLink className="cover-link" release={release}>
                <Cover
                  src={release.coverUrl}
                  isbn13={release.coverIsbn}
                  title={releaseTitle(release)}
                  foot={[release.volumeLabel, release.publisher?.name]}
                  lazy={!eager}
                />
              </EditionLink>
            </div>
            <div className="caption">
              {lead ? (
                <Link
                  className="caption-title"
                  to="/series/$publicId/$slug"
                  params={slugParams(lead.publicId, lead.title)}
                >
                  {releaseTitle(release)}
                </Link>
              ) : (
                <span className="caption-title">{releaseTitle(release)}</span>
              )}
              <div className="caption-meta">
                {release.volumeLabel ? <span>{release.volumeLabel}</span> : null}
                {release.volumeLabel && release.publisher ? (
                  <span className="dot" />
                ) : null}
                {release.publisher ? <span>{release.publisher.name}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A Release links to its row on the Edition page (spec §11: a Release is a
 * row on its Edition, anchored by its own identifier).
 */
function EditionLink({
  release,
  children,
  ...rest
}: {
  release: BrowseRelease;
  children: ReactNode;
  className?: string;
  tabIndex?: number;
  "aria-hidden"?: boolean;
}) {
  return (
    <Link
      to="/edition/$publicId/$slug"
      params={slugParams(release.edition.publicId, release.edition.title)}
      hash={release.anchor}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** Nothing dated this month: ghosted spines and a way on to the agenda. */
function EmptyMonth({ month }: { month: YearMonth }) {
  return (
    <div className="empty-shelf">
      <div className="ghost-shelf" aria-hidden="true">
        {["plank-a", "plank-b", "plank-c"].map((seed) => (
          <div className="ghost-spine" key={seed}>
            <span className="cover">
              <span
                className="cover-ph"
                style={{ "--cloth": clothColor(seed) } as CSSProperties}
              />
            </span>
          </div>
        ))}
      </div>
      <div className="empty-note">
        <p>
          No release in {monthTitle(month)} has a date on file yet. Dates land
          here as publishers announce them — the agenda keeps every other month.
        </p>
        <Link className="btn btn-primary" to="/releases">
          Open the release agenda
        </Link>
      </div>
    </div>
  );
}

/** Crossovers ship under every Series they collect, so the titles join. */
function releaseTitle(release: BrowseRelease): string {
  return release.series.map((entry) => entry.title).join(" × ");
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "release" : "releases"}`;
}

/** Thousands separators without a locale, so SSR and hydration agree. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const WEEKDAYS_FULL = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

/** Weekday of a day in the month, UTC like every other date in the browser. */
function weekdayFull({ year, month }: YearMonth, day: number): string {
  return WEEKDAYS_FULL[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}

function fullDate(month: YearMonth, day: number): string {
  return `${weekdayFull(month, day)} ${day} ${MONTH_NAMES[month.month - 1]} ${month.year}`;
}

/** What the nearest day is to the reader: today, this week, later, or gone. */
function primaryHeading(day: number, todaySort: number): string {
  const delta = day - (todaySort % 100);
  if (delta < 0) return "Last on the shelf";
  if (delta === 0) return "On the shelf today";
  if (delta <= 7) return "On the shelf this week";
  return "Next on the shelf";
}
