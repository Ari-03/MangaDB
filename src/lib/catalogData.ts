import { ConvexHttpClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

import { api } from "../../convex/_generated/api";
import { timingNeedsToday, todaySortKey } from "~/lib/month";

// Public catalog reads for route loaders (spec §9: SSR reads go through the
// Convex HTTP client). They run wherever the loader runs: in the Worker for
// SSR, and straight from the browser on client navigations and preloads, so
// a tab switch is one request to Convex instead of a server-function hop
// through the Worker first. Public queries only, no auth token; personal
// reads use the SSR token flow (server/auth.ts + server/convex.ts).

// Stateless without auth, so one client serves every read. Made on first
// use: the Worker's `process.env` is read at request time, like
// server/convex.ts does.
let client: ConvexHttpClient | null | undefined;

/**
 * Run a public Convex query. Null when no deployment is configured, so pages
 * render a setup notice instead of crashing.
 */
export async function catalogQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): Promise<FunctionReturnType<Query> | null> {
  if (client === undefined) {
    const url =
      import.meta.env.VITE_CONVEX_URL ??
      (typeof process === "undefined" ? undefined : process.env.VITE_CONVEX_URL);
    client = url ? new ConvexHttpClient(url) : null;
  }
  return client ? await client.query(query, args) : null;
}

/** A query's result with the "unconfigured" and "not found" nulls taken out. */
type Found<Query extends FunctionReference<"query">> = NonNullable<
  FunctionReturnType<Query>
>;

/** One month window of the Releases browser: Agenda and Month Grid (ticket #24). */
export type MonthReleasesData = Found<typeof api.releases.monthBrowse>;
export type BrowseRelease = MonthReleasesData["releases"][number];

/**
 * The Publishers board (`/publishers`, `/publishers/{yyyy-mm}`): one month's
 * activity per Publisher plus the A–Z directory (convex/publisher.ts
 * monthBoard, served from the precomputed board when there is one).
 */
export type PublishersBoardData = Found<typeof api.publisher.monthBoard>;

/**
 * The Publisher Spotlight page (ticket #25). The query returns
 * `{ redirectTo }` for a renamed or merged Publisher's old slug (the route
 * 301s), the page data otherwise.
 */
export type PublisherPageData = Exclude<
  Found<typeof api.publisher.publisherPage>,
  { redirectTo: string }
>;

/** The Series page (ticket #22); a merged Series resolves to its survivor. */
export type SeriesPageData = Found<typeof api.catalog.seriesPage>;
/** Volume, Edition, and Bundle pages (ticket #23), resolved like the Series page. */
export type VolumePageData = Found<typeof api.catalogPages.volumePage>;
export type EditionPageData = Found<typeof api.catalogPages.editionPage>;
export type BundlePageData = Found<typeof api.catalogPages.bundlePage>;
/** /search (ticket #38): Series + Publisher matches and "Did you mean" near misses. */
export type SearchResults = Found<typeof api.catalog.search>;
/** An author page: the author and every Series they're credited on (people.ts). */
export type AuthorPageData = Found<typeof api.people.authorPage>;
/** One author on the Authors tab. */
export type AuthorCard = Found<typeof api.people.authors>["page"][number];
/** A public profile (ticket #30), exactly what its owner's visibility allows. */
export type PublicProfileData = Found<typeof api.sharing.publicProfile>;

// contract: `api.seriesBrowse.browse` / `api.seriesBrowse.facets` are the
// Series library queries in convex/seriesBrowse.ts. Argument and result types
// are inferred from them, so the page follows the backend's shape; the one
// argument the page does not give, `todaySort`, is filled in here.
export type SeriesBrowseArgs = Omit<
  FunctionArgs<typeof api.seriesBrowse.browse>,
  "todaySort"
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
  });
}
