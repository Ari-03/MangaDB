// Shared UI for the Releases browser (ticket #24, spec §10): the Agenda
// (`/releases`) and the Month Grid (`/releases/{yyyy-mm}`) are sibling views
// over the same month window of Canonical Releases, sharing the Format,
// Publisher, and followed-Series filters. View + filter state is entirely in
// the URL — the view is the path (plus `?view=agenda` on month URLs), the
// filters are query params — so any browser state is shareable as a link.
//
// Followed Series (ticket #29) are a subtle marker + a filter, never a
// separate section. Follows are personal, so the marker and filter are a
// signed-in client-side overlay (per the recorded spec §8 trade-off, the
// followed filter applies in memory): the SSR month window stays public and
// identical for everyone, and `?followed=true` views are noindex (spec §11).

import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";
import { Cover } from "~/lib/cover";
import {
  addMonths,
  daysInMonth,
  firstWeekday,
  monthParam,
  MONTH_NAMES,
  monthTitle,
  sameMonth,
  weekdayName,
  type YearMonth,
} from "~/lib/month";
import { slugParams } from "~/lib/slug";
import type { BrowseRelease, MonthReleasesData } from "~/server/releases";

export type ReleaseFormat = "physical" | "digital";
export type BrowseFilters = {
  format?: ReleaseFormat;
  publisher?: string;
  /** Only releases from followed Series (#29); a personal, noindex view. */
  followed?: true;
};

/** Search-param validation shared by both routes; unknown values read as unset. */
export function validateBrowseFilters(
  search: Record<string, unknown>,
): BrowseFilters {
  return {
    format:
      search.format === "physical" || search.format === "digital"
        ? search.format
        : undefined,
    publisher:
      typeof search.publisher === "string" && search.publisher !== ""
        ? search.publisher
        : undefined,
    // `true` from client navigation; strings from a shared URL or the
    // pre-hydration GET form ("on" is an unvalued checkbox submission).
    followed:
      search.followed === true ||
      search.followed === "true" ||
      search.followed === "1" ||
      search.followed === "on"
        ? true
        : undefined,
  };
}

/**
 * The signed-in viewer's followed Series as a publicId set, for the marker
 * and the followed filter. Null when Convex is unconfigured, signed out,
 * username pending, or still loading — the browser then renders exactly the
 * public view.
 */
type FollowedSeriesSet = ReadonlySet<number> | null;

const FORMAT_LABELS: Record<ReleaseFormat, string> = {
  physical: "Physical",
  digital: "Digital",
};

type BrowserProps = {
  view: "agenda" | "grid";
  anchor: YearMonth;
  today: YearMonth;
  /** True on `/releases/{yyyy-mm}`; false on `/releases` (the Agenda home). */
  atMonthUrl: boolean;
  filters: BrowseFilters;
  data: MonthReleasesData | null;
  onFiltersChange: (filters: BrowseFilters) => void;
};

export function ReleasesBrowser(props: BrowserProps) {
  // The follow overlay needs the reactive client; without it the browser is
  // exactly the public view (hooks can't be conditional, hence the split).
  if (!convexClient) return <BrowserView {...props} followedSeries={null} />;
  return <BrowserWithFollows {...props} />;
}

function BrowserWithFollows(props: BrowserProps) {
  const followed = useQuery(api.follows.followedSeries, {});
  return (
    <BrowserView
      {...props}
      followedSeries={followed ? new Set(followed.seriesPublicIds) : null}
    />
  );
}

function BrowserView({
  view,
  anchor,
  today,
  atMonthUrl,
  filters,
  data,
  onFiltersChange,
  followedSeries,
}: BrowserProps & { followedSeries: FollowedSeriesSet }) {
  // The followed filter applies in memory over the public month window; the
  // marker set doubles as the predicate.
  const followsFilter = (release: BrowseRelease) =>
    followedSeries !== null &&
    release.series.some((series) => followedSeries.has(series.publicId));
  const releases = data
    ? filters.followed
      ? data.releases.filter(followsFilter)
      : data.releases
    : null;
  const filtered = Boolean(
    filters.format || filters.publisher || filters.followed,
  );

  return (
    <main className="releases-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">English manga releases</p>
          <h1 className="page-title">{monthTitle(anchor)}</h1>
        </div>
        <MonthNav view={view} anchor={anchor} today={today} filters={filters} />
      </div>

      <div className="toolbar">
        <ViewToggle view={view} anchor={anchor} today={today} filters={filters} />
        {data ? (
          <FilterBar
            action={atMonthUrl ? `/releases/${monthParam(anchor)}` : "/releases"}
            keepViewParam={atMonthUrl && view === "agenda"}
            filters={filters}
            publishers={data.publishers}
            // The followed checkbox needs a followed set to filter against;
            // it also renders when the filter is already on, so a signed-out
            // viewer of a shared ?followed URL can switch it off.
            showFollowed={followedSeries !== null || filters.followed === true}
            onChange={onFiltersChange}
          />
        ) : null}
        {releases ? <ResultCount releases={releases} /> : null}
      </div>

      {data === null || releases === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to browse the release calendar.
        </p>
      ) : filters.followed && followedSeries === null ? (
        <p className="notice">
          {/* Clerk owns /sign-in; a plain anchor leaves the router out of it. */}
          <a href="/sign-in">Sign in</a> to see only releases from series you
          follow.
        </p>
      ) : releases.length === 0 ? (
        <p className="notice">
          No releases{" "}
          {filtered ? "match these filters " : ""}
          in {monthTitle(anchor)}.
          {filtered ? (
            <>
              {" "}
              <button
                className="link-btn"
                type="button"
                onClick={() => onFiltersChange({})}
              >
                Clear the filters
              </button>
            </>
          ) : null}
        </p>
      ) : view === "grid" ? (
        <GridView
          anchor={anchor}
          filters={filters}
          releases={releases}
          followedSeries={followedSeries}
        />
      ) : (
        <AgendaView
          anchor={anchor}
          releases={releases}
          followedSeries={followedSeries}
        />
      )}
    </main>
  );
}

/** "12 releases · 3 publication days" — the window's size, not a filter. */
function ResultCount({ releases }: { releases: Array<BrowseRelease> }) {
  const days = new Set(
    releases.filter((release) => release.day !== null).map((r) => r.day),
  ).size;
  return (
    <p className="result-count">
      {releases.length} {releases.length === 1 ? "release" : "releases"}
      {days > 0
        ? ` · ${days} publication ${days === 1 ? "day" : "days"}`
        : null}
    </p>
  );
}

/**
 * `/releases` is the parent route of every month URL, and a month link's
 * search is a subset of the current one, so the router's default prefix
 * matching would mark the wrong nav item `aria-current="page"`. The masthead
 * and the view toggle say "current" themselves.
 */
const EXACT_ACTIVE = { exact: true } as const;

/** Search object for month-route links, keeping `view=agenda` sticky. */
function monthSearch(view: "agenda" | "grid", filters: BrowseFilters) {
  return view === "agenda" ? { ...filters, view: "agenda" as const } : filters;
}

function MonthNav({
  view,
  anchor,
  today,
  filters,
}: {
  view: "agenda" | "grid";
  anchor: YearMonth;
  today: YearMonth;
  filters: BrowseFilters;
}) {
  const prev = addMonths(anchor, -1);
  const next = addMonths(anchor, 1);
  const shortName = (ym: YearMonth) => MONTH_NAMES[ym.month - 1]!.slice(0, 3);
  return (
    <nav className="month-nav" aria-label="Month navigation">
      <Link
        to="/releases/$month"
        params={{ month: monthParam(prev) }}
        search={monthSearch(view, filters)}
        activeOptions={EXACT_ACTIVE}
        rel="nofollow"
      >
        ← {shortName(prev)}
      </Link>
      {sameMonth(anchor, today) ? (
        <span aria-current="date">This month</span>
      ) : view === "agenda" ? (
        // The current month's Agenda is canonically `/releases` (spec §10:
        // Agenda is the first-visit default).
        <Link to="/releases" search={filters} activeOptions={EXACT_ACTIVE}>
          This month
        </Link>
      ) : (
        <Link
          to="/releases/$month"
          params={{ month: monthParam(today) }}
          search={filters}
          activeOptions={EXACT_ACTIVE}
        >
          This month
        </Link>
      )}
      <Link
        to="/releases/$month"
        params={{ month: monthParam(next) }}
        search={monthSearch(view, filters)}
        activeOptions={EXACT_ACTIVE}
        rel="nofollow"
      >
        {shortName(next)} →
      </Link>
    </nav>
  );
}

/** The Agenda | Month grid segmented control; the current view is not a link. */
function ViewToggle({
  view,
  anchor,
  today,
  filters,
}: {
  view: "agenda" | "grid";
  anchor: YearMonth;
  today: YearMonth;
  filters: BrowseFilters;
}) {
  return (
    <nav className="seg" aria-label="View">
      {view === "agenda" ? (
        <span className="seg-btn is-on" aria-current="page">
          Agenda
        </span>
      ) : sameMonth(anchor, today) ? (
        <Link
          className="seg-btn"
          to="/releases"
          search={filters}
          activeOptions={EXACT_ACTIVE}
        >
          Agenda
        </Link>
      ) : (
        <Link
          className="seg-btn"
          to="/releases/$month"
          params={{ month: monthParam(anchor) }}
          search={{ ...filters, view: "agenda" }}
          activeOptions={EXACT_ACTIVE}
          rel="nofollow"
        >
          Agenda
        </Link>
      )}
      {view === "grid" ? (
        <span className="seg-btn is-on" aria-current="page">
          Month grid
        </span>
      ) : (
        <Link
          className="seg-btn"
          to="/releases/$month"
          params={{ month: monthParam(anchor) }}
          search={filters}
          activeOptions={EXACT_ACTIVE}
        >
          Month grid
        </Link>
      )}
    </nav>
  );
}

/**
 * Format + Publisher + followed-Series filters, identical in both views. A
 * real GET form whose fields mirror the search params, so it works before
 * hydration (submit) and after it (change handlers navigate immediately).
 * The followed toggle appears only for signed-in viewers (or to switch an
 * already-on followed filter off) — followed is never a separate section.
 *
 * The form is `display: contents`, so its controls sit directly on the
 * toolbar's flex line while still submitting as one GET form.
 */
function FilterBar({
  action,
  keepViewParam,
  filters,
  publishers,
  showFollowed,
  onChange,
}: {
  action: string;
  keepViewParam: boolean;
  filters: BrowseFilters;
  publishers: MonthReleasesData["publishers"];
  showFollowed: boolean;
  onChange: (filters: BrowseFilters) => void;
}) {
  return (
    <form
      className="filter-bar"
      method="get"
      action={action}
      onSubmit={(event) => event.preventDefault()}
    >
      {keepViewParam ? <input type="hidden" name="view" value="agenda" /> : null}
      <label className="filter">
        <span className="filter-label">Format</span>
        <select
          className="select"
          name="format"
          value={filters.format ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange({
              ...filters,
              format:
                value === "physical" || value === "digital" ? value : undefined,
            });
          }}
        >
          <option value="">All formats</option>
          <option value="physical">Physical</option>
          <option value="digital">Digital</option>
        </select>
      </label>
      <label className="filter">
        <span className="filter-label">Publisher</span>
        <select
          className="select"
          name="publisher"
          value={filters.publisher ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange({ ...filters, publisher: value || undefined });
          }}
        >
          <option value="">All publishers</option>
          {publishers.map((publisher) => (
            <option key={publisher.slug} value={publisher.slug}>
              {publisher.name}
            </option>
          ))}
        </select>
      </label>
      {showFollowed ? (
        // A real checkbox worn as a pill: the GET fallback still submits
        // `followed=on`, and the pill lights up from :has(:checked).
        <label className="toggle-pill filter-followed">
          <input
            type="checkbox"
            name="followed"
            value="true"
            checked={filters.followed === true}
            onChange={(event) =>
              onChange({
                ...filters,
                followed: event.currentTarget.checked ? true : undefined,
              })
            }
          />
          <span className="star" aria-hidden="true">
            ★
          </span>
          <span className="filter-label">Followed series</span>
        </label>
      ) : null}
      <noscript>
        <button className="btn btn-sm" type="submit">
          Apply
        </button>
      </noscript>
    </form>
  );
}

/** Day groups in window order; `null` (day to be announced) sorts first. */
function groupByDay(releases: Array<BrowseRelease>) {
  const groups = new Map<number | null, Array<BrowseRelease>>();
  for (const release of releases) {
    const list = groups.get(release.day);
    if (list) list.push(release);
    else groups.set(release.day, [release]);
  }
  return [...groups.entries()].sort(
    ([a], [b]) => (a ?? 0) - (b ?? 0),
  );
}

/** "3 releases" — every count in the browser reads the same way. */
function releaseCount(n: number): string {
  return `${n} ${n === 1 ? "release" : "releases"}`;
}

/** The row's book title: the Series (or crossover Series) it publishes. */
function releaseTitle(release: BrowseRelease): string {
  return release.series.map((series) => series.title).join(" × ");
}

/**
 * The Agenda's per-day anchor, so the Month Grid can link a day straight to
 * its section. Month-qualified because the Publisher page stacks several
 * months of AgendaView on one document.
 */
function dayAnchorId(anchor: YearMonth, day: number | null): string {
  return `day-${monthParam(anchor)}-${day === null ? "tba" : String(day).padStart(2, "0")}`;
}

const LONG_WEEKDAYS: Record<string, string> = {
  Sun: "Sunday",
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
};

// ---------- Agenda (spec §10: cover-led chronological default) ----------

/**
 * The cover-led day-grouped release list. Exported for the Publisher
 * Spotlight's upcoming lane (ticket #25), which renders the same rows
 * month by month (without the followed overlay).
 */
export function AgendaView({
  anchor,
  releases,
  followedSeries = null,
}: {
  anchor: YearMonth;
  releases: Array<BrowseRelease>;
  followedSeries?: FollowedSeriesSet;
}) {
  return (
    <div className="agenda">
      {groupByDay(releases).map(([day, dayReleases]) => {
        const short = day === null ? null : weekdayName(anchor, day);
        return (
          <section key={day ?? "tba"} className="day" id={dayAnchorId(anchor, day)}>
            <div className="day-marker">
              <h2 className="day-date">
                {day === null ? (
                  <span className="day-tba">Day to be announced</span>
                ) : (
                  <>
                    <span className="day-dow">
                      {short === null ? "" : (LONG_WEEKDAYS[short] ?? short)}
                    </span>
                    <span className="day-num">{day}</span>
                  </>
                )}
              </h2>
              <p className="day-count">{releaseCount(dayReleases.length)}</p>
            </div>
            <ol className="day-list">
              {dayReleases.map((release) => (
                <ReleaseRow
                  key={release.id}
                  release={release}
                  followedSeries={followedSeries}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** Whether any of the row's Series is one the viewer follows. */
function isFollowed(
  release: BrowseRelease,
  followedSeries: FollowedSeriesSet,
): boolean {
  return (
    followedSeries !== null &&
    release.series.some((series) => followedSeries.has(series.publicId))
  );
}

/** The subtle followed-Series marker (#29) — never a separate section. */
function FollowedMarker() {
  return (
    <span
      className="star"
      title="You follow this series"
      aria-label="You follow this series"
    >
      ★
    </span>
  );
}

/**
 * One Release on the shelf: cover, the Series it belongs to, the Volume label
 * linking the Edition page at this Release's row (spec §11 — a Release has no
 * page of its own), Publisher, and Format/Binding.
 *
 * Collection state is deliberately absent: it is per-Release and personal,
 * and the only query for it is one-release-at-a-time, so a month window would
 * open hundreds of subscriptions. Shelf-state controls live on the Edition
 * page the Volume label links to.
 */
function ReleaseRow({
  release,
  followedSeries = null,
}: {
  release: BrowseRelease;
  followedSeries?: FollowedSeriesSet;
}) {
  const title = releaseTitle(release);
  const volumeLabel = release.volumeLabel || "Edition";
  const editionParams = slugParams(
    release.edition.publicId,
    release.edition.title,
  );
  const followed = isFollowed(release, followedSeries);
  return (
    <li className={followed ? "rel is-followed" : "rel"}>
      {/* The cover repeats the Volume label's link, so it stays out of the
          tab order and off the accessibility tree. */}
      <Link
        className="rel-cover"
        to="/edition/$publicId/$slug"
        params={editionParams}
        hash={release.anchor}
        tabIndex={-1}
        aria-hidden="true"
      >
        <Cover
          src={release.coverUrl}
          isbn13={release.coverIsbn}
          title={`${title} ${volumeLabel}`.trim()}
          foot={[release.volumeLabel, release.publisher?.name]}
        />
      </Link>
      <div className="rel-main">
        <p className="rel-title">
          <span className="rel-series">
            {release.series.map((series, i) => (
              <span key={series.publicId}>
                {i > 0 ? " × " : ""}
                <Link
                  to="/series/$publicId/$slug"
                  params={slugParams(series.publicId, series.title)}
                >
                  {series.title}
                </Link>
              </span>
            ))}
          </span>
          <Link
            className="rel-vol"
            to="/edition/$publicId/$slug"
            params={editionParams}
            hash={release.anchor}
          >
            {volumeLabel}
          </Link>
          {followed ? <FollowedMarker /> : null}
        </p>
        <div className="rel-meta">
          {release.publisher ? (
            // The Publisher Spotlight page (ticket #25, spec §11).
            <Link to="/publisher/$slug" params={{ slug: release.publisher.slug }}>
              {release.publisher.name}
            </Link>
          ) : null}
          <span className={`chip chip--${release.format}`}>
            {FORMAT_LABELS[release.format]}
            {release.binding ? ` · ${release.binding}` : ""}
          </span>
          {release.lineName ? (
            <span className="chip chip--line">
              {release.lineName}
              {release.linePosition ? ` ${release.linePosition}` : ""}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ---------- Month Grid (spec §10: month-at-a-glance sibling) ----------

// Nearly every release in a month lands on the same weekday, so a seven-column
// calendar would be ~85% empty cells. The grid is one row per week instead: a
// dated gutter, the week's publication day(s) as a strip of covers on a ledge,
// and the quiet days as ticks.

/** Covers shown per day strip before the rest collapse into "+N more". */
const STRIP_MAX = 7;

/** "31 Aug" for any day offset in the anchor month; 0 and negatives roll back. */
function dayLabel(anchor: YearMonth, day: number): string {
  const date = new Date(Date.UTC(anchor.year, anchor.month - 1, day));
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]!.slice(0, 3)}`;
}

function GridView({
  anchor,
  filters,
  releases,
  followedSeries,
}: {
  anchor: YearMonth;
  filters: BrowseFilters;
  releases: Array<BrowseRelease>;
  followedSeries: FollowedSeriesSet;
}) {
  const byDay = new Map<number, Array<BrowseRelease>>();
  const tba: Array<BrowseRelease> = [];
  for (const release of releases) {
    if (release.day === null) tba.push(release);
    else {
      const list = byDay.get(release.day);
      if (list) list.push(release);
      else byDay.set(release.day, [release]);
    }
  }

  const length = daysInMonth(anchor);
  // Weeks run Sunday to Saturday; the first one reaches back into last month.
  const weekStarts: Array<number> = [];
  for (let start = 1 - firstWeekday(anchor); start <= length; start += 7) {
    weekStarts.push(start);
  }

  return (
    <div className="month-weeks">
      {tba.length > 0 ? (
        <section className="week-row week-row--tba">
          <div className="week-gutter">
            <span className="wk-kicker">This month</span>
            <span className="wk-date">Day to be announced</span>
            <span className="wk-total">{releaseCount(tba.length)}</span>
          </div>
          <div className="week-body">
            <CoverStrip
              anchor={anchor}
              filters={filters}
              day={null}
              releases={tba}
              followedSeries={followedSeries}
            />
          </div>
        </section>
      ) : null}

      {weekStarts.map((start) => {
        const days = [0, 1, 2, 3, 4, 5, 6]
          .map((offset) => start + offset)
          .filter((day) => day >= 1 && day <= length);
        const active = days.filter((day) => byDay.has(day));
        const quiet = days.filter((day) => !byDay.has(day));
        const total = active.reduce(
          (sum, day) => sum + (byDay.get(day)?.length ?? 0),
          0,
        );
        return (
          // A week nobody publishes in is a tick line, not a panel.
          <section
            key={start}
            className={total > 0 ? "week-row" : "week-row is-quiet"}
          >
            <div className="week-gutter">
              <span className="wk-kicker">Week of</span>
              <span className="wk-date">{dayLabel(anchor, start)}</span>
              <span className="wk-range">to {dayLabel(anchor, start + 6)}</span>
              {total > 0 ? (
                <span className="wk-total">{releaseCount(total)}</span>
              ) : null}
            </div>
            <div className="week-body">
              {active.map((day) => (
                <div key={day} className="rel-day">
                  <div className="rd-head">
                    <h2 className="rd-date">
                      <span className="rd-dow">{weekdayName(anchor, day)}</span>{" "}
                      {day} {MONTH_NAMES[anchor.month - 1]}
                    </h2>
                    <span className="rd-count">
                      {releaseCount(byDay.get(day)?.length ?? 0)}
                    </span>
                    <Link
                      className="rd-link"
                      to="/releases/$month"
                      params={{ month: monthParam(anchor) }}
                      search={{ ...filters, view: "agenda" }}
                      hash={dayAnchorId(anchor, day)}
                      rel="nofollow"
                    >
                      Open this day in the agenda
                    </Link>
                  </div>
                  <CoverStrip
                    anchor={anchor}
                    filters={filters}
                    day={day}
                    releases={byDay.get(day) ?? []}
                    followedSeries={followedSeries}
                  />
                </div>
              ))}
              {quiet.length > 0 ? (
                <p className="wk-quiet">
                  No releases{" "}
                  {quiet.map((day) => (
                    <span key={day} className="qd">
                      {day}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A day's covers on a ledge; the overflow collapses into one "+N more" tile. */
function CoverStrip({
  anchor,
  filters,
  day,
  releases,
  followedSeries,
}: {
  anchor: YearMonth;
  filters: BrowseFilters;
  day: number | null;
  releases: Array<BrowseRelease>;
  followedSeries: FollowedSeriesSet;
}) {
  const overflow = releases.length > STRIP_MAX ? releases.length - STRIP_MAX + 1 : 0;
  const shown = overflow > 0 ? releases.slice(0, STRIP_MAX - 1) : releases;
  return (
    <div className="wk-covers">
      {shown.map((release) => {
        const title = releaseTitle(release);
        const full = `${title} ${release.volumeLabel}`.trim();
        return (
          <Link
            key={release.id}
            className="cover-link"
            to="/edition/$publicId/$slug"
            params={slugParams(release.edition.publicId, release.edition.title)}
            hash={release.anchor}
            title={full}
          >
            <Cover
              src={release.coverUrl}
              isbn13={release.coverIsbn}
              title={full}
              foot={[release.volumeLabel, release.publisher?.name]}
              followed={isFollowed(release, followedSeries)}
            />
          </Link>
        );
      })}
      {overflow > 0 ? (
        <Link
          className="wk-more"
          to="/releases/$month"
          params={{ month: monthParam(anchor) }}
          search={{ ...filters, view: "agenda" }}
          hash={dayAnchorId(anchor, day)}
          rel="nofollow"
        >
          +{overflow}
          <br />
          more
        </Link>
      ) : null}
    </div>
  );
}
