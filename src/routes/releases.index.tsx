import { createFileRoute } from "@tanstack/react-router";

import { currentMonth } from "~/lib/month";
import {
  breadcrumbListJsonLd,
  browserTitleTag,
  jsonLdScript,
  pageHead,
} from "~/lib/seo";
import {
  ReleasesBrowser,
  validateBrowseFilters,
  type BrowseFilters,
} from "~/lib/releasesBrowser";
import { fetchMonthReleases } from "~/server/releases";

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
  loaderDeps: ({ search }) => ({
    format: search.format,
    publisher: search.publisher,
  }),
  loader: async ({ deps }) => {
    // The Agenda anchors on the month containing today (UTC), computed on the
    // server so SSR and hydration agree.
    const anchor = currentMonth();
    const data = await fetchMonthReleases({ data: { ...anchor, ...deps } });
    return {
      anchor,
      data,
      filtered: Boolean(deps.format || deps.publisher),
    };
  },
  // Indexing policy (spec §11): the unfiltered browser is indexable; any
  // filtered combination is noindex/follow. The canonical always points at
  // the bare `/releases`, so no query-string variant — including a stray
  // `?page=N` — is ever the indexed URL.
  head: ({ loaderData }) => ({
    ...pageHead({
      title: browserTitleTag(),
      description:
        "English manga releases day by day: every volume publishing this month, with format, publisher, and edition details.",
      path: "/releases",
      robots: loaderData?.filtered ? "noindex, follow" : undefined,
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
