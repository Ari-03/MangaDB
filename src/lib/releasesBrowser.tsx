// Shared UI for the Releases browser (ticket #24, spec §10): the Agenda
// (`/releases`) and the Month Grid (`/releases/{yyyy-mm}`) are sibling views
// over the same month window of Canonical Releases, sharing the Format and
// Publisher filters. View + filter state is entirely in the URL — the view is
// the path (plus `?view=agenda` on month URLs), the filters are query params —
// so any browser state is shareable as a link.

import { Link } from "@tanstack/react-router";

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
export type BrowseFilters = { format?: ReleaseFormat; publisher?: string };

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
  };
}

const FORMAT_LABELS: Record<ReleaseFormat, string> = {
  physical: "Physical",
  digital: "Digital",
};

export function ReleasesBrowser({
  view,
  anchor,
  today,
  atMonthUrl,
  filters,
  data,
  onFiltersChange,
}: {
  view: "agenda" | "grid";
  anchor: YearMonth;
  today: YearMonth;
  /** True on `/releases/{yyyy-mm}`; false on `/releases` (the Agenda home). */
  atMonthUrl: boolean;
  filters: BrowseFilters;
  data: MonthReleasesData | null;
  onFiltersChange: (filters: BrowseFilters) => void;
}) {
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
            onChange={onFiltersChange}
          />
        ) : null}
        {data ? (
          <span className="result-count">
            {data.releases.length}{" "}
            {data.releases.length === 1 ? "release" : "releases"}
          </span>
        ) : null}
      </div>

      {data === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to browse the release calendar.
        </p>
      ) : data.releases.length === 0 ? (
        <p className="notice">
          No releases {filters.format || filters.publisher ? "match these filters " : ""}
          in {monthTitle(anchor)}.
        </p>
      ) : view === "grid" ? (
        <GridView anchor={anchor} filters={filters} releases={data.releases} />
      ) : (
        <AgendaView anchor={anchor} releases={data.releases} />
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
 * Format + Publisher filters, identical in both views. A real GET form whose
 * fields mirror the search params, so it works before hydration (submit) and
 * after it (change handlers navigate immediately).
 */
function FilterBar({
  action,
  keepViewParam,
  filters,
  publishers,
  onChange,
}: {
  action: string;
  keepViewParam: boolean;
  filters: BrowseFilters;
  publishers: MonthReleasesData["publishers"];
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
 * month by month.
 */
export function AgendaView({
  anchor,
  releases,
}: {
  anchor: YearMonth;
  releases: Array<BrowseRelease>;
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
              <ReleaseCard key={release.id} release={release} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function seriesLinkParams(publicId: number, title: string) {
  return { publicId: String(publicId), slug: slugify(title) };
}

function ReleaseCard({ release }: { release: BrowseRelease }) {
  return (
    <li className="release-card">
      <Cover release={release} />
      <div className="release-card-body">
        <h3>
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
}: {
  anchor: YearMonth;
  filters: BrowseFilters;
  releases: Array<BrowseRelease>;
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
              <ReleaseCard key={release.id} release={release} />
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
                <GridItem key={release.id} release={release} />
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

function GridItem({ release }: { release: BrowseRelease }) {
  const lead = release.series[0];
  if (!lead) return null;
  return (
    <Link
      className="calendar-item"
      to="/series/$publicId/$slug"
      params={seriesLinkParams(lead.publicId, lead.title)}
      title={`${release.series.map((s) => s.title).join(" × ")} ${release.volumeLabel} · ${FORMAT_LABELS[release.format]}${release.publisher ? ` · ${release.publisher.name}` : ""}`}
    >
      <strong>{lead.title}</strong>
      <span>
        {release.volumeLabel || "Release"} ·{" "}
        {FORMAT_LABELS[release.format]}
      </span>
    </Link>
  );
}
