import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { currentMonth, monthParam, monthTitle, parseMonthParam } from "~/lib/month";
import {
  ReleasesBrowser,
  validateBrowseFilters,
  type BrowseFilters,
} from "~/lib/releasesBrowser";
import {
  breadcrumbListJsonLd,
  itemListJsonLd,
  jsonLdScript,
  monthTitleTag,
  pageHead,
} from "~/lib/seo";
import { editionPath } from "~/lib/slug";
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
  // Indexing policy (spec §11): unfiltered month views are the evergreen
  // "manga releases {month}" landing pages; filtered combinations are
  // noindex/follow. The canonical always points at the bare month URL, so no
  // query-string variant — including a stray `?page=N` — is ever indexed.
  // JSON-LD: BreadcrumbList + an ItemList of the month's Releases, each
  // linking its Edition page anchored at the Release row (ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { anchor, data, filtered } = loaderData;
    const path = `/releases/${monthParam(anchor)}`;
    return {
      ...pageHead({
        title: monthTitleTag(monthTitle(anchor)),
        description: `Every English manga release of ${monthTitle(anchor)} at a glance: volumes, formats, and publishers on a month calendar.`,
        path,
        robots: filtered ? "noindex, follow" : undefined,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: "Releases", path: "/releases" },
            { name: monthTitle(anchor) },
          ]),
        ),
        // The ItemList describes the canonical month page, so it is built
        // only from the unfiltered window.
        ...(!filtered && data && data.releases.length > 0
          ? [
              jsonLdScript(
                itemListJsonLd(
                  data.releases.map((release) => ({
                    name: [release.series[0]?.title, release.volumeLabel]
                      .filter(Boolean)
                      .join(" "),
                    path: editionPath(
                      release.edition.publicId,
                      release.edition.title,
                    ),
                    anchor: release.anchor,
                  })),
                ),
              ),
            ]
          : []),
      ],
    };
  },
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
