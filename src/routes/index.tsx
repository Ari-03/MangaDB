import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { fetchHomeCatalog, releaseTitle, type BrowseRelease } from "~/lib/catalogData";
import { plural } from "~/lib/format";
import { clothColor, Cover } from "~/lib/cover";
import {
  coverShelf,
  heroBooks,
  heroPool,
  jacketed,
  oneCoverPer,
  shelfDays,
  type CoverShelf,
  type CoversOnFile,
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

/** Two ledges of the newest Series in the catalog. */
const SERIES_SHELF_LIMIT = 14;
/** Series asked for to fill them: only jacketed ones are shelved (the query's cap). */
const SERIES_SHELF_POOL = 28;

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
  // Series, whatever the viewer chose.
  loader: async () => {
    const month = currentMonth();
    const [stats, series, releases, nextReleases] = await fetchHomeCatalog(
      month,
      SERIES_SHELF_POOL,
    );
    // The "today" boundary travels with the loader data so SSR and hydration
    // group the shelves identically.
    const todaySort = todaySortKey();
    const pools = homePools(releases?.releases ?? [], nextReleases?.releases ?? [], todaySort);
    const { primary, secondary, undated } = pools.days;
    // Which candidates have a jacket on file. A failed check is "unknown"
    // (null): the shelves then seat any book with art to try, as before.
    const jackets = await fetchCoversOnFile({
      data: [
        coverShelf(pools.hero, HERO_ROWS * HERO_COLS),
        coverShelf(primary ? primary.releases : undated, SHELF_LIMIT),
        coverShelf(secondary?.releases ?? [], NEXT_SHELF_LIMIT),
        coverShelf(series ?? [], SERIES_SHELF_LIMIT),
      ],
    }).catch(() => null);
    return { stats, series, month, todaySort, releases, nextReleases, jackets };
  },
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

/** Covers standing on the hero's ledges: three short rows at most. */
const HERO_ROWS = 3;
const HERO_COLS = 5;
/** Below this a shelf of Series reads as a gap, so the link list serves. */
const SERIES_SHELF_MIN = 4;
/** Home shelves are a taste of the month; the agenda holds the whole of it. */
const SHELF_LIMIT = 14;
const NEXT_SHELF_LIMIT = 7;

/**
 * Every home shelf's candidates in shelf order, before the jacket check: the
 * loader asks the cover store about them, and the component seats the ones
 * it holds.
 */
function homePools(
  releases: Array<BrowseRelease>,
  nextReleases: Array<BrowseRelease>,
  todaySort: number,
) {
  // A book's physical and digital Releases are one cover on a shelf.
  const monthBooks = oneCoverPer(releases, (r) => r.edition.publicId);
  const hero = heroPool(
    [...monthBooks, ...oneCoverPer(nextReleases, (r) => r.edition.publicId)],
    todaySort,
    // The day the shelf below leads with (see ReleaseShelves).
    monthBooks.find((book) => book.day !== null && book.sort >= todaySort)?.sort ?? null,
  );
  return { days: shelfDays(monthBooks, todaySort), hero };
}

function Home() {
  const { stats, series, month, todaySort, releases, nextReleases, jackets } =
    Route.useLoaderData();
  const onFile = useMemo(() => (jackets ? new Set(jackets) : null), [jackets]);
  const pools = homePools(releases?.releases ?? [], nextReleases?.releases ?? [], todaySort);
  const heroCovers = heroBooks(pools.hero, onFile, HERO_ROWS * HERO_COLS);
  // The shelf seats jacketed Series; too few of them and the newest Series
  // are listed by name instead.
  const newest = (series ?? []).slice(0, SERIES_SHELF_LIMIT);
  const shelfSeries = jacketed(series ?? [], onFile, SERIES_SHELF_LIMIT);

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
                  <div className="stat-num">{roundedCount(stats[key].count)}</div>
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
        days={pools.days}
        onFile={onFile}
      />

      {newest.length > 0 ? (
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
          {shelfSeries.length >= SERIES_SHELF_MIN ? (
            <div className="shelf">
              {shelfSeries.map((entry) => (
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
              {newest.map((entry) => (
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
        <div className="hero-row" key={index}>
          {row.map((release) => (
            <EditionLink className="cover-link" release={release} key={release.id}>
              <Cover
                src={release.coverUrl}
                isbn13={release.coverIsbns}
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

/**
 * The home shelves: the nearest publication day the month still has ahead of
 * it (falling back to its last one once the month has shipped), then the day
 * after it (lib/homeShelves.ts `shelfDays`). Each seats its jacketed books;
 * the counts beside the headings are of every book that day. An empty month
 * is an invitation, never a blank section.
 */
function ReleaseShelves({
  month,
  todaySort,
  days: { primary, secondary, undated },
  onFile,
}: {
  month: YearMonth;
  todaySort: number;
  days: ReturnType<typeof homePools>["days"];
  onFile: CoversOnFile;
}) {
  if (!primary) {
    const books = jacketed(undated, onFile, SHELF_LIMIT);
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
              ? `${plural(undated.length, "book")}, publication day still to be announced`
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
        {undated.length === 0 ? (
          <EmptyMonth month={month} />
        ) : books.length > 0 ? (
          <Shelf releases={books} eager />
        ) : null}
      </section>
    );
  }

  const primaryBooks = jacketed(primary.releases, onFile, SHELF_LIMIT);
  const secondaryBooks = secondary ? jacketed(secondary.releases, onFile, NEXT_SHELF_LIMIT) : [];
  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            {primaryHeading(primary.day, todaySort)}
          </h2>
          <p className="section-note">
            {fullDate(month, primary.day)} — {plural(primary.releases.length, "book")}
          </p>
          <Link className="section-link" to="/releases">
            Full agenda for {MONTH_NAMES[month.month - 1]}
          </Link>
        </div>
        {primaryBooks.length > 0 ? <Shelf releases={primaryBooks} eager /> : null}
      </section>

      {secondary && secondaryBooks.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">
              Next {weekdayFullName(month, secondary.day)}, {secondary.day}{" "}
              {MONTH_NAMES[month.month - 1]}
            </h2>
            <p className="section-note">
              {plural(secondary.releases.length, "book")} already dated
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
          <Shelf releases={secondaryBooks} />
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
                  isbn13={release.coverIsbns}
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
