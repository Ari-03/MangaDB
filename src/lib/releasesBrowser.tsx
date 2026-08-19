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
import { slugify } from "~/lib/slug";
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

  return (
    <main className="releases-page">
      <header className="browse-masthead">
        <div>
          <p className="eyebrow">English manga releases</p>
          <h1>{monthTitle(anchor)}</h1>
        </div>
        <MonthNav view={view} anchor={anchor} today={today} filters={filters} />
      </header>

      <div className="browse-controls">
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
        {releases ? (
          <span className="result-count">
            {releases.length} {releases.length === 1 ? "release" : "releases"}
          </span>
        ) : null}
      </div>

      {data === null || releases === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to browse the release calendar.
        </p>
      ) : filters.followed && followedSeries === null ? (
        <p className="notice">
          Sign in to see only releases from series you follow.
        </p>
      ) : releases.length === 0 ? (
        <p className="notice">
          No releases{" "}
          {filters.format || filters.publisher || filters.followed
            ? "match these filters "
            : ""}
          in {monthTitle(anchor)}.
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
        rel="nofollow"
      >
        ← {shortName(prev)}
      </Link>
      {sameMonth(anchor, today) ? (
        <span aria-current="date">This month</span>
      ) : view === "agenda" ? (
        // The current month's Agenda is canonically `/releases` (spec §10:
        // Agenda is the first-visit default).
        <Link to="/releases" search={filters}>
          This month
        </Link>
      ) : (
        <Link
          to="/releases/$month"
          params={{ month: monthParam(today) }}
          search={filters}
        >
          This month
        </Link>
      )}
      <Link
        to="/releases/$month"
        params={{ month: monthParam(next) }}
        search={monthSearch(view, filters)}
        rel="nofollow"
      >
        {shortName(next)} →
      </Link>
    </nav>
  );
}

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
    <nav className="view-toggle" aria-label="View">
      {view === "agenda" ? (
        <span aria-current="page">Agenda</span>
      ) : sameMonth(anchor, today) ? (
        <Link to="/releases" search={filters}>
          Agenda
        </Link>
      ) : (
        <Link
          to="/releases/$month"
          params={{ month: monthParam(anchor) }}
          search={{ ...filters, view: "agenda" }}
          rel="nofollow"
        >
          Agenda
        </Link>
      )}
      {view === "grid" ? (
        <span aria-current="page">Month grid</span>
      ) : (
        <Link
          to="/releases/$month"
          params={{ month: monthParam(anchor) }}
          search={filters}
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
 * The followed checkbox appears only for signed-in viewers (or to switch an
 * already-on followed filter off) — followed is never a separate section.
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
      <label>
        <span className="filter-label">Format</span>
        <select
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
      <label>
        <span className="filter-label">Publisher</span>
        <select
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
        <label className="filter-followed">
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
          <span className="filter-label">Followed series</span>
        </label>
      ) : null}
      <noscript>
        <button type="submit">Apply</button>
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
      {groupByDay(releases).map(([day, dayReleases]) => (
        <section key={day ?? "tba"} className="agenda-group">
          <div className="agenda-date">
            {day === null ? (
              <span className="agenda-tba">Day to be announced</span>
            ) : (
              <>
                <strong>{day}</strong>
                <span>{weekdayName(anchor, day)}</span>
              </>
            )}
          </div>
          <ol className="agenda-cards">
            {dayReleases.map((release) => (
              <ReleaseCard
                key={release.id}
                release={release}
                followedSeries={followedSeries}
              />
            ))}
          </ol>
        </section>
      ))}
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
      className="followed-marker"
      title="You follow this series"
      aria-label="You follow this series"
    >
      ★
    </span>
  );
}

function seriesLinkParams(publicId: number, title: string) {
  return { publicId: String(publicId), slug: slugify(title) };
}

function ReleaseCard({
  release,
  followedSeries = null,
}: {
  release: BrowseRelease;
  followedSeries?: FollowedSeriesSet;
}) {
  return (
    <li className="release-card">
      <Cover release={release} />
      <div className="release-card-body">
        <h3>
          {isFollowed(release, followedSeries) ? <FollowedMarker /> : null}
          {release.series.map((series, i) => (
            <span key={series.publicId}>
              {i > 0 ? " × " : ""}
              <Link
                to="/series/$publicId/$slug"
                params={seriesLinkParams(series.publicId, series.title)}
              >
                {series.title}
              </Link>
            </span>
          ))}
          {release.volumeLabel ? ` — ${release.volumeLabel}` : ""}
        </h3>
        {release.lineName ? (
          <p className="release-card-line">
            {release.lineName}
            {release.linePosition ? ` ${release.linePosition}` : ""}
          </p>
        ) : null}
      </div>
      <div className="release-card-meta">
        <span className={`format-badge ${release.format}`}>
          {FORMAT_LABELS[release.format]}
          {release.binding ? ` · ${release.binding}` : ""}
        </span>
        {release.publisher ? (
          // The Publisher Spotlight page (ticket #25, spec §11).
          <Link
            className="release-card-publisher"
            to="/publisher/$slug"
            params={{ slug: release.publisher.slug }}
          >
            {release.publisher.name}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function Cover({ release }: { release: BrowseRelease }) {
  const title = release.series.map((series) => series.title).join(" × ");
  return release.coverUrl ? (
    <img
      className="release-cover"
      src={release.coverUrl}
      alt={`Cover of ${title} ${release.volumeLabel}`.trim()}
      loading="lazy"
    />
  ) : (
    // Covers arrive with the importers; until then the placeholder keeps the
    // browser cover-led without fabricating art.
    <span className="release-cover release-cover-placeholder" aria-hidden="true">
      {title}
    </span>
  );
}

// ---------- Month Grid (spec §10: month-at-a-glance sibling) ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const GRID_CELL_MAX = 3;

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
  const days = Array.from({ length: daysInMonth(anchor) }, (_, i) => i + 1);

  return (
    <>
      {tba.length > 0 ? (
        <section className="grid-tba">
          <h2>This month, day to be announced</h2>
          <ol className="agenda-cards">
            {tba.map((release) => (
              <ReleaseCard
                key={release.id}
                release={release}
                followedSeries={followedSeries}
              />
            ))}
          </ol>
        </section>
      ) : null}
      <div className="calendar-grid">
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="weekday">
            {weekday}
          </div>
        ))}
        {Array.from({ length: firstWeekday(anchor) }, (_, i) => (
          <div key={`pad-${i}`} className="calendar-day outside" />
        ))}
        {days.map((day) => {
          const dayReleases = byDay.get(day) ?? [];
          return (
            <div key={day} className="calendar-day">
              <div className="day-number">
                <span>{day}</span>
                {dayReleases.length > 0 ? (
                  <span className="day-count">{dayReleases.length}</span>
                ) : null}
              </div>
              {dayReleases.slice(0, GRID_CELL_MAX).map((release) => (
                <GridItem
                  key={release.id}
                  release={release}
                  followedSeries={followedSeries}
                />
              ))}
              {dayReleases.length > GRID_CELL_MAX ? (
                <Link
                  className="calendar-more"
                  to="/releases/$month"
                  params={{ month: monthParam(anchor) }}
                  search={{ ...filters, view: "agenda" }}
                  rel="nofollow"
                >
                  +{dayReleases.length - GRID_CELL_MAX} more
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

function GridItem({
  release,
  followedSeries,
}: {
  release: BrowseRelease;
  followedSeries: FollowedSeriesSet;
}) {
  const lead = release.series[0];
  if (!lead) return null;
  return (
    <Link
      className="calendar-item"
      to="/series/$publicId/$slug"
      params={seriesLinkParams(lead.publicId, lead.title)}
      title={`${release.series.map((s) => s.title).join(" × ")} ${release.volumeLabel} · ${FORMAT_LABELS[release.format]}${release.publisher ? ` · ${release.publisher.name}` : ""}`}
    >
      <strong>
        {isFollowed(release, followedSeries) ? <FollowedMarker /> : null}
        {lead.title}
      </strong>
      <span>
        {release.volumeLabel || "Release"} ·{" "}
        {FORMAT_LABELS[release.format]}
      </span>
    </Link>
  );
}
