import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { CSSProperties, ReactNode } from "react";

import { fetchHomeCatalog, releaseTitle, type BrowseRelease } from "~/lib/catalogData";
import { plural } from "~/lib/format";
import { clothColor, Cover } from "~/lib/cover";
import {
  HERO_COLS,
  homePools,
  homeQuestions,
  homeShelves,
  type CoverShelf,
  type DayShelf,
} from "~/lib/homeShelves";
import {
  currentMonth,
  MONTH_NAMES,
  monthParam,
  monthTitle,
  todaySortKey,
  weekdayFullName,
  type YearMonth,
} from "~/lib/month";
import { pageHead, SITE_NAME } from "~/lib/seo";
import { slugify, slugParams } from "~/lib/slug";
import { SeriesShelfItem } from "~/lib/shelfItem";
import { coversOnFile } from "~/server/covers";

/** Series asked for to fill the Series shelf: only jacketed ones are shelved (the query's cap). */
const SERIES_SHELF_POOL = 28;
/**
 * Covers that load at once rather than lazily. React's server render puts a
 * preload in <head> for every eager <img>, where it competes with the
 * scripts, so only the covers every width shows on first paint ask for one:
 * the first three on the top ledge, all a phone's ledge holds (home.css).
 */
const EAGER_COVERS = 3;

// The home shelves seat only books whose real jacket we hold
// (lib/homeShelves.ts), and the cover store is the one that knows. Runs in
// the Worker for SSR and as an RPC on client navigations.
const fetchCoversOnFile = createServerFn({ method: "POST" })
  .inputValidator((shelves: Array<CoverShelf>) => shelves)
  .handler(async ({ data }) => coversOnFile(data, new URL(getRequest().url).origin));

export const Route = createFileRoute("/")({
  // The shelves are server-rendered from the same public month window the
  // Releases browser uses (lib/catalogData.ts) — a loader read, never a
  // reactive subscription for public catalog data — and never hold a Mature
  // Series, whatever the viewer chose. The loader seats the shelves itself
  // and returns only the books they show: the two months it reads would
  // otherwise travel in the page's HTML (about 250 KB of it).
  loader: async () => {
    const month = currentMonth();
    const [stats, series, releases, nextReleases] = await fetchHomeCatalog(
      month,
      SERIES_SHELF_POOL,
    );
    // The "today" boundary travels with the loader data so the headings
    // read the same day the shelves were seated by, in SSR and hydration.
    const todaySort = todaySortKey();
    const pools = homePools(releases.releases, nextReleases.releases, todaySort);
    // Which candidates have a jacket on file. A failed check is "unknown"
    // (null): the shelves then seat any book with art to try, as before.
    const jackets = await fetchCoversOnFile({ data: homeQuestions(pools, series) }).catch(
      () => null,
    );
    return {
      counts: {
        series: stats.series.count,
        volumes: stats.volumes.count,
        publishers: stats.publishers.count,
      },
      month,
      todaySort,
      ...homeShelves(pools, series, jackets ? new Set(jackets) : null),
    };
  },
  // Coming back home within five minutes reuses the shelves instead of
  // re-reading both months and the cover store in the background. The
  // shelves turn on the UTC day (todaySort), so a reused page is at most
  // five minutes behind midnight; a full page load always runs the loader.
  staleTime: 5 * 60_000,
  // Canonical + social card for the home page; the title and
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

// The hero's headline counts. Editions and Releases stay out: to a reader
// they restate Volumes in catalog jargon.
const LABELS = [
  ["series", "Series"],
  ["volumes", "Volumes"],
  ["publishers", "Publishers"],
] as const;

function Home() {
  const { counts, month, todaySort, hero, primary, secondary, undated, series, seriesLinks } =
    Route.useLoaderData();

  return (
    <main className="home">
      <section className={hero.length > 0 ? "hero" : "hero hero--solo"}>
        <div className="hero-copy">
          <h1 className="hero-title">A place on the internet for your manga shelf.</h1>
          <p className="hero-sub">
            Keep track of the volumes you own, the ones you want, and the ones you've read. Discover
            upcoming English releases and see which volumes each edition collects.
          </p>
          <div className="hero-cta">
            <Link className="btn btn-primary" to="/releases">
              Open the release agenda
            </Link>
            <Link className="btn" to="/search" search={{ q: "" }}>
              Find a series
            </Link>
          </div>
          <div className="stat-row">
            {LABELS.map(([key, label]) => (
              <div className="stat" key={key}>
                <div className="stat-num">{roundedCount(counts[key])}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>
        </div>
        {hero.length > 0 ? <HeroShelf releases={hero} /> : null}
      </section>

      <ReleaseShelves
        month={month}
        todaySort={todaySort}
        eager={hero.length === 0 ? EAGER_COVERS : 0}
        primary={primary}
        secondary={secondary}
        undated={undated}
      />

      {series.length > 0 || seriesLinks.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Recently added series</h2>
            <p className="section-note">The newest additions to the catalog</p>
            <Link className="section-link" to="/search" search={{ q: "" }}>
              Search all series
            </Link>
          </div>
          {series.length > 0 ? (
            <div className="shelf">
              {series.map((entry) => (
                // The Series' first jacket (lib/covers.ts); a Series with no
                // art on file is not shelved here.
                <SeriesShelfItem
                  key={entry.publicId}
                  series={{ ...entry, coverIsbn: entry.coverIsbns }}
                />
              ))}
            </div>
          ) : (
            <ul className="series-links">
              {seriesLinks.map((entry) => (
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

/** Three short ledges of the soonest covers, standing beside the hero copy. */
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
      aria-label="Covers publishing soon"
    >
      {rows.map((row, index) => (
        <div
          className="hero-row"
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position in the grid; the covers inside it are keyed by Release
          key={index}
        >
          {row.map((release, column) => (
            <EditionLink className="cover-link" release={release} key={release.id}>
              <Cover
                src={release.coverUrl}
                isbn13={release.coverIsbns}
                title={releaseTitle(release)}
                foot={[release.volumeLabel, release.publisher?.name]}
                lazy={index > 0 || column >= EAGER_COVERS}
              />
            </EditionLink>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The home shelves: the nearest publication day the month still has ahead of
 * it (falling back to its last one once the month has shipped), then the day
 * after it (lib/homeShelves.ts `shelfDays`). Each shows the jacketed books
 * the loader seated; the counts beside the headings are of every book that
 * day. An empty month is an invitation, never a blank section. `eager` is
 * how many of the first shelf's covers load at once: none while the hero
 * wall stands above it.
 */
function ReleaseShelves({
  month,
  todaySort,
  eager,
  primary,
  secondary,
  undated,
}: {
  month: YearMonth;
  todaySort: number;
  eager: number;
  primary: DayShelf<BrowseRelease> | null;
  secondary: DayShelf<BrowseRelease> | null;
  undated: { count: number; books: Array<BrowseRelease> };
}) {
  if (!primary) {
    // No dated day left in the window: either the month holds only
    // day-to-be-announced Releases, or it holds nothing at all.
    return (
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            {undated.count > 0
              ? `Coming in ${MONTH_NAMES[month.month - 1]}`
              : "On the shelf this month"}
          </h2>
          <p className="section-note">
            {undated.count > 0
              ? `${plural(undated.count, "book")}, publication day still to be announced`
              : `Nothing is dated for ${monthTitle(month)} yet`}
          </p>
          {/* An empty month carries its own call to action below, so the
              section head does not repeat it. */}
          {undated.count > 0 ? (
            <Link className="section-link" to="/releases">
              Full agenda for {MONTH_NAMES[month.month - 1]}
            </Link>
          ) : null}
        </div>
        {undated.count === 0 ? (
          <EmptyMonth month={month} />
        ) : undated.books.length > 0 ? (
          <Shelf releases={undated.books} eager={eager} />
        ) : null}
      </section>
    );
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">{primaryHeading(primary.day, todaySort)}</h2>
          <p className="section-note">
            {fullDate(month, primary.day)} — {plural(primary.count, "book")}
          </p>
          <Link className="section-link" to="/releases">
            Full agenda for {MONTH_NAMES[month.month - 1]}
          </Link>
        </div>
        {primary.books.length > 0 ? <Shelf releases={primary.books} eager={eager} /> : null}
      </section>

      {secondary ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">
              Next {weekdayFullName(month, secondary.day)}, {secondary.day}{" "}
              {MONTH_NAMES[month.month - 1]}
            </h2>
            <p className="section-note">{plural(secondary.count, "book")} already dated</p>
            <Link
              className="section-link"
              to="/releases/$month"
              params={{ month: monthParam(month) }}
              search={{}}
            >
              See the month grid
            </Link>
          </div>
          <Shelf releases={secondary.books} />
        </section>
      ) : null}
    </>
  );
}

/**
 * A row of Releases as shelved books: cover, then the ledge and its label.
 * The first `eager` covers load at once, the rest lazily.
 */
function Shelf({ releases, eager = 0 }: { releases: Array<BrowseRelease>; eager?: number }) {
  return (
    <div className="shelf">
      {releases.map((release, index) => {
        const lead = release.series[0];
        return (
          <div className="shelf-item" key={release.id}>
            <div className="cover-wrap">
              <EditionLink className="cover-link" release={release}>
                <Cover
                  src={release.coverUrl}
                  isbn13={release.coverIsbns}
                  title={releaseTitle(release)}
                  foot={[release.volumeLabel, release.publisher?.name]}
                  lazy={index >= eager}
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
                {release.volumeLabel && release.publisher ? <span className="dot" /> : null}
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
              <span className="cover-ph" style={{ "--cloth": clothColor(seed) } as CSSProperties} />
            </span>
          </div>
        ))}
      </div>
      <div className="empty-note">
        <p>
          No release in {monthTitle(month)} has a date on file yet. Dates land here as publishers
          announce them — the agenda keeps every other month.
        </p>
        <Link className="btn btn-primary" to="/releases">
          Open the release agenda
        </Link>
      </div>
    </div>
  );
}

/**
 * A headline count rounded down to two significant figures, as a floor:
 * 5,488 → "5,400+", 28,155 → "28,000+", 65 → "65+". The catalog grows daily,
 * so exact figures would only be stale precision.
 */
function roundedCount(value: number): string {
  if (value <= 0) return "0";
  const step = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
  return `${groupDigits(Math.floor(value / step) * step)}+`;
}

/** Thousands separators without a locale, so SSR and hydration agree. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fullDate(month: YearMonth, day: number): string {
  return `${weekdayFullName(month, day)} ${day} ${MONTH_NAMES[month.month - 1]} ${month.year}`;
}

/** What the nearest day is to the reader: today, this week, later, or gone. */
function primaryHeading(day: number, todaySort: number): string {
  const delta = day - (todaySort % 100);
  if (delta < 0) return "Last on the shelf";
  if (delta === 0) return "On the shelf today";
  if (delta <= 7) return "On the shelf this week";
  return "Next on the shelf";
}
