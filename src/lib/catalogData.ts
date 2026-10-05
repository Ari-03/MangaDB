import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";
import { convexUrl } from "~/lib/convexUrl";
import { showMature } from "~/lib/mature";
import { addMonths, timingNeedsToday, todaySortKey, type YearMonth } from "~/lib/month";

// Public catalog reads for route loaders (spec §9: SSR reads go through the
// Convex HTTP client). They run wherever the loader runs: in the Worker for
// SSR, and straight from the browser on client navigations and preloads, so
// a tab switch is one request to Convex instead of a server-function hop
// through the Worker first. Public queries only, no auth token; personal
// reads use the SSR token flow (server/auth.ts + server/convex.ts).

// Stateless without auth, so one client serves every read. Made on first
// use: the Worker's `process.env` is read at request time, like
// server/convex.ts does.
let client: ConvexHttpClient | undefined;

/** Run a public Convex query. */
export async function catalogQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): Promise<FunctionReturnType<Query>> {
  client ??= new ConvexHttpClient(convexUrl());
  return await client.query(query, args);
}

/** A query's result with its "not found" null taken out. */
type Found<Query extends FunctionReference<"query">> = NonNullable<FunctionReturnType<Query>>;

/** One month window of the Releases browser: Agenda and Month Grid. */
export type MonthReleasesData = Found<typeof api.releases.monthBrowse>;
export type BrowseRelease = MonthReleasesData["releases"][number];

/** A release's book title: crossovers ship under every Series they collect, so the titles join. */
export function releaseTitle(release: BrowseRelease): string {
  return release.series.map((series) => series.title).join(" × ");
}

/**
 * The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): one month's
 * activity per Publisher plus the A–Z directory (convex/publisher.ts
 * monthBoard, served from the precomputed board when there is one).
 */
export type PublishersBoardData = Found<typeof api.publisher.monthBoard>;

/**
 * The Publisher Spotlight page. The query returns
 * `{ redirectTo }` for a renamed or merged Publisher's old slug (the route
 * 301s), the page data otherwise.
 */
export type PublisherPageData = Exclude<
  Found<typeof api.publisher.publisherPage>,
  { redirectTo: string }
>;

/** The Series page; a merged Series resolves to its survivor. */
export type SeriesPageData = Found<typeof api.catalog.seriesPage>;
/** Volume, Edition, and Bundle pages, resolved like the Series page. */
export type VolumePageData = Found<typeof api.catalogPages.volumePage>;
export type EditionPageData = Found<typeof api.catalogPages.editionPage>;
export type BundlePageData = Found<typeof api.catalogPages.bundlePage>;
/** /search: Series + Publisher matches and "Did you mean" near misses. */
export type SearchResults = Found<typeof api.catalog.search>;
/** An author page: the author and every Series they're credited on (people.ts). */
export type AuthorPageData = Found<typeof api.people.authorPage>;
/** One author on the Authors tab. */
export type AuthorCard = Found<typeof api.people.authors>["page"][number];
/** A public profile, exactly what its owner's visibility allows. */
export type PublicProfileData = Found<typeof api.sharing.publicProfile>;

// contract: `api.seriesBrowse.browse` / `api.seriesBrowse.facets` are the
// Series library queries in convex/seriesBrowse.ts. Argument and result types
// are inferred from them, so the page follows the backend's shape; the two
// arguments the page does not give, `todaySort` and the viewer's
// `showMature` (lib/mature.tsx), are filled in here.
export type SeriesBrowseArgs = Omit<
  FunctionArgs<typeof api.seriesBrowse.browse>,
  "todaySort" | "showMature"
>;
export type SeriesBrowsePage = Found<typeof api.seriesBrowse.browse>;
export type SeriesBrowseItem = SeriesBrowsePage["items"][number];
/**
 * The library's filter vocabulary: every Publisher with a Series and its
 * Series count, the total Series count, and counts per Source Status.
 */
export type SeriesFacets = Found<typeof api.seriesBrowse.facets>;

/**
 * One page of the Series library (`/series`): filtered, then sorted,
 * cursor-paged, with the filtered total. Called by the route loader for the
 * first page and as the shelf scrolls. A view whose timing filter counts
 * back from today (`timingNeedsToday`) sends today's date (UTC), since the
 * Convex query is cached and must not read a clock; other views don't, so
 * their cache keys stay the same from day to day. Later pages filter by the
 * first page's day, which their cursor carries; today's date is only the
 * fallback for a cursor that doesn't decode.
 */
export function fetchSeriesBrowse(args: SeriesBrowseArgs) {
  const needsToday = args.timing !== undefined && timingNeedsToday(args.timing);
  return catalogQuery(api.seriesBrowse.browse, {
    ...args,
    todaySort: needsToday ? todaySortKey() : undefined,
    showMature: showMature(),
  });
}

/**
 * The home page's catalog reads: the headline counts, the `seriesPool`
 * newest Series, and the Releases of `month` and the month after it (the
 * hero wall runs on into next month when this one is nearly done). The home
 * page's shelves never show a Mature Series or its books, whatever the
 * viewer chose (lib/mature.tsx). The Series total uses the library's full
 * catalog, including mature titles, and excludes Series without books.
 * The header search is not one of these reads; it follows the choice.
 * The newest Series' cover pick tells published books from forthcoming
 * ones, so it gets today's date (UTC): the Convex query must not read a
 * clock, which would expire its cached result within seconds.
 */
export function fetchHomeCatalog(month: YearMonth, seriesPool: number) {
  return Promise.all([
    catalogQuery(api.catalog.stats, {}),
    catalogQuery(api.catalog.recentSeries, {
      limit: seriesPool,
      todaySort: todaySortKey(),
      showMature: false,
    }),
    catalogQuery(api.releases.monthBrowse, { ...month, showMature: false }),
    catalogQuery(api.releases.monthBrowse, { ...addMonths(month, 1), showMature: false }),
    catalogQuery(api.seriesBrowse.facets, { showMature: true }),
  ]);
}
