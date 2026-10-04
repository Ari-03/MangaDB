import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { showMature } from "~/lib/mature";
import { currentMonth, monthParam, monthTitle, parseMonthParam } from "~/lib/month";
import {
  followPublisherSlug,
  isFiltered,
  ReleasesBrowser,
  validateBrowseFilters,
  type BrowseFilters,
} from "~/lib/releasesBrowser";
import {
  itemListJsonLd,
  monthTitleTag,
  pageHead,
} from "~/lib/seo";
import { editionPath } from "~/lib/slug";

/**
 * `/releases/{yyyy-mm}` — the Month Grid sibling of the Release Agenda
 * (spec §10): the same month window of Canonical Releases
 * rendered month-at-a-glance, each release on its publication date.
 *
 * `?view=agenda` renders the Agenda for this month instead, so past and
 * future months are browsable in either view and every view + filter
 * combination is a shareable URL. Unfiltered month grids are the indexable
 * month views (spec §11); any query param makes the page noindex/follow with
 * a canonical pointing at the bare month URL.
 */
export const Route = createFileRoute("/releases/$month")({
  validateSearch: (
    search: Record<string, unknown>,
  ): BrowseFilters & { view?: "agenda" } => ({
    ...validateBrowseFilters(search),
    view: search.view === "agenda" ? "agenda" : undefined,
  }),
  // Filters and the view apply in memory over the month
  // (lib/releasesBrowser.tsx), so the loader depends on the month alone and
  // neither a filter change nor a view switch reloads.
  loader: async ({ params, location }) => {
    const anchor = parseMonthParam(params.month);
    if (!anchor) throw notFound();
    const data = await catalogQuery(api.releases.monthBrowse, { ...anchor, showMature: showMature() });
    await followPublisherSlug(location, data);
    return { anchor, today: currentMonth(), data };
  },
  // Indexing policy (spec §11): unfiltered month views are the evergreen
  // "manga releases {month}" landing pages; filtered combinations are
  // noindex/follow. The canonical always points at the bare month URL, so no
  // query-string variant — including a stray `?page=N` — is ever indexed.
  // JSON-LD: BreadcrumbList + an ItemList of the month's Releases, each
  // linking its Edition page anchored at the Release row.
  head: ({ loaderData, match }) => {
    if (!loaderData) return {};
    const { anchor, data } = loaderData;
    const filtered = isFiltered(match.search) || match.search.view !== undefined;
    const path = `/releases/${monthParam(anchor)}`;
    return pageHead({
      title: monthTitleTag(monthTitle(anchor)),
      description: `Every English manga release of ${monthTitle(anchor)} at a glance: volumes, formats, and publishers on a month calendar.`,
      path,
      robots: filtered ? "noindex, follow" : undefined,
      breadcrumbs: [{ name: "Releases", path: "/releases" }, { name: monthTitle(anchor) }],
      // The ItemList describes the canonical month page, so it is built
      // only from the unfiltered window.
      jsonLd:
        !filtered && data.releases.length > 0
          ? [
              itemListJsonLd(
                data.releases.map((release) => ({
                  name: [release.series[0]?.title, release.volumeLabel]
                    .filter(Boolean)
                    .join(" "),
                  path: editionPath(release.edition.publicId, release.edition.title),
                  anchor: release.anchor,
                })),
              ),
            ]
          : [],
    });
  },
  component: MonthPage,
  notFoundComponent: MonthNotFound,
});

function MonthNotFound() {
  return (
    <main className="releases-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">English manga releases</p>
          <h1 className="page-title">Month not found</h1>
        </div>
      </div>
      <p className="notice">
        Months live at <code>/releases/{"{yyyy-mm}"}</code>, like{" "}
        <code>/releases/{monthParam(currentMonth())}</code>.{" "}
        <Link to="/releases">Browse the release agenda</Link>.
      </p>
    </main>
  );
}

function MonthPage() {
  const { anchor, today, data } = Route.useLoaderData();
  const { view, ...filters } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onFiltersChange = (next: BrowseFilters) =>
    void navigate({
      search: view === "agenda" ? { ...next, view } : next,
      replace: true,
    });

  return (
    <ReleasesBrowser
      view={view ?? "grid"}
      anchor={anchor}
      today={today}
      atMonthUrl
      filters={filters}
      data={data}
      onFiltersChange={onFiltersChange}
    />
  );
}
