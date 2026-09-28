import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { catalogQuery } from "~/lib/catalogData";
import { showMature } from "~/lib/mature";
import { currentMonth } from "~/lib/month";
import {
  breadcrumbListJsonLd,
  browserTitleTag,
  jsonLdScript,
  pageHead,
} from "~/lib/seo";
import {
  followPublisherSlug,
  isFiltered,
  ReleasesBrowser,
  validateBrowseFilters,
  type BrowseFilters,
} from "~/lib/releasesBrowser";

/**
 * `/releases` — the Release Agenda (ticket #24, spec §10): the first-visit
 * default of the Releases browser. A cover-led chronological list of the
 * current month's Canonical Releases, grouped and anchored by publication
 * date, each row showing cover, Volume label, Format, and Publisher.
 *
 * The Month Grid sibling lives at `/releases/{yyyy-mm}` (spec §11: the
 * browser paginates by month URL). Format and Publisher filters are query
 * params, so view + filter state round-trips through the URL. Filtered views
 * are noindex/follow with a canonical pointing at the unfiltered browser
 * (spec §11).
 */
export const Route = createFileRoute("/releases/")({
  validateSearch: validateBrowseFilters,
  // Filters apply in memory over the month (lib/releasesBrowser.tsx), so
  // the loader depends on nothing but today's month and a filter change
  // never reloads.
  loader: async ({ location }) => {
    // The Agenda anchors on the month containing today (UTC), computed on the
    // server so SSR and hydration agree.
    const anchor = currentMonth();
    const data = await catalogQuery(api.releases.monthBrowse, { ...anchor, showMature: showMature() });
    await followPublisherSlug(location, data);
    return { anchor, data };
  },
  // Indexing policy (spec §11): the unfiltered browser is indexable; any
  // filtered combination — including the personal followed filter, which is
  // never indexed — is noindex/follow. The canonical always points at the
  // bare `/releases`, so no query-string variant — including a stray
  // `?page=N` — is ever the indexed URL.
  head: ({ match }) => ({
    ...pageHead({
      title: browserTitleTag(),
      description:
        "English manga releases day by day: every volume publishing this month, with format, publisher, and edition details.",
      path: "/releases",
      robots: isFiltered(match.search) ? "noindex, follow" : undefined,
    }),
    scripts: [
      jsonLdScript(
        breadcrumbListJsonLd([
          { name: "MangaDB", path: "/" },
          { name: "Releases" },
        ]),
      ),
    ],
  }),
  component: ReleasesAgendaPage,
});

function ReleasesAgendaPage() {
  const { anchor, data } = Route.useLoaderData();
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();
  const onFiltersChange = (next: BrowseFilters) =>
    void navigate({ search: next, replace: true });

  return (
    <ReleasesBrowser
      view="agenda"
      anchor={anchor}
      today={anchor}
      atMonthUrl={false}
      filters={filters}
      data={data}
      onFiltersChange={onFiltersChange}
    />
  );
}
