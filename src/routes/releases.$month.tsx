import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { currentMonth, monthParam, monthTitle, parseMonthParam } from "~/lib/month";
import {
  ReleasesBrowser,
  validateBrowseFilters,
  type BrowseFilters,
} from "~/lib/releasesBrowser";
import { fetchMonthReleases } from "~/server/releases";

/**
 * `/releases/{yyyy-mm}` — the Month Grid sibling of the Release Agenda
 * (ticket #24, spec §10): the same month window of Canonical Releases
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
  loaderDeps: ({ search }) => ({
    format: search.format,
    publisher: search.publisher,
    view: search.view,
  }),
  loader: async ({ params, deps }) => {
    const anchor = parseMonthParam(params.month);
    if (!anchor) throw notFound();
    const data = await fetchMonthReleases({
      data: { ...anchor, format: deps.format, publisher: deps.publisher },
    });
    return {
      anchor,
      today: currentMonth(),
      data,
      filtered: Boolean(deps.format || deps.publisher || deps.view),
    };
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${monthTitle(loaderData.anchor)} manga releases — MangaDB` },
          {
            name: "description",
            content: `Every English manga release of ${monthTitle(loaderData.anchor)} at a glance: volumes, formats, and publishers on a month calendar.`,
          },
          ...(loaderData.filtered
            ? [{ name: "robots", content: "noindex, follow" }]
            : []),
        ]
      : [],
    links: loaderData?.filtered
      ? [{ rel: "canonical", href: `/releases/${monthParam(loaderData.anchor)}` }]
      : [],
  }),
  component: MonthPage,
  notFoundComponent: MonthNotFound,
});

function MonthNotFound() {
  return (
    <main>
      <h1>Month not found</h1>
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
