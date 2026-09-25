import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Cover } from "~/lib/cover";
import { MONTH_NAMES } from "~/lib/month";
import {
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  SITE_NAME,
} from "~/lib/seo";
import { slugParams } from "~/lib/slug";
import {
  fetchSeriesBrowse,
  fetchSeriesFacets,
  type SeriesBrowseArgs,
  type SeriesBrowseItem,
  type SeriesBrowsePage,
  type SeriesFacets,
} from "~/server/seriesBrowse";

type SeriesSort = SeriesBrowseArgs["sort"];
type SeriesStatus = NonNullable<SeriesBrowseArgs["status"]>;
type SeriesFormat = NonNullable<SeriesBrowseArgs["format"]>;

/** Library view state; every key is a query param, unset means the default. */
type LibrarySearch = {
  /** Unset is the default, Title A–Z. */
  sort?: Exclude<SeriesSort, "title">;
  order?: "asc" | "desc";
  publisher?: string;
  status?: SeriesStatus;
  format?: SeriesFormat;
  /** "a".."z", or "#" for titles that start with anything else. */
  letter?: string;
  q?: string;
};

// Keyed by the backend's unions, so a new sort or status fails the type
// check until it has a label here.
const SORT_LABELS: Record<SeriesSort, string> = {
  title: "Title A–Z",
  recent: "Recently added",
  volumes: "Most volumes",
  latest: "Latest release",
  upcoming: "Upcoming next",
  followers: "Most followed",
  collectors: "Most collected",
};

const STATUS_LABELS: Record<SeriesStatus, string> = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "Hiatus",
  cancelled: "Cancelled",
};

const FORMAT_LABELS: Record<SeriesFormat, string> = {
  physical: "Physical",
  digital: "Digital",
};

const LETTERS = ["#", ..."abcdefghijklmnopqrstuvwxyz"];

/** `value` when it is one of `labels`' keys, else undefined. */
function keyOf<K extends string>(
  labels: Record<K, string>,
  value: unknown,
): K | undefined {
  return typeof value === "string" && Object.hasOwn(labels, value)
    ? (value as K)
    : undefined;
}

/** Unknown or empty values read as unset; `sort=title` is the default. */
function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const sort = keyOf(SORT_LABELS, search.sort);
  const letter =
    typeof search.letter === "string" ? search.letter.toLowerCase() : "";
  const q = typeof search.q === "string" ? search.q.trim().slice(0, 100) : "";
  return {
    sort: sort === "title" ? undefined : sort,
    order:
      search.order === "asc" || search.order === "desc"
        ? search.order
        : undefined,
    publisher:
      typeof search.publisher === "string" && search.publisher !== ""
        ? search.publisher
        : undefined,
    status: keyOf(STATUS_LABELS, search.status),
    format: keyOf(FORMAT_LABELS, search.format),
    letter: LETTERS.includes(letter) ? letter : undefined,
    q: q || undefined,
  };
}

/** The backend query args for a view (first page unless a cursor is given). */
function browseArgs(
  search: LibrarySearch,
  cursor: string | null = null,
): SeriesBrowseArgs {
  return { ...search, sort: search.sort ?? "title", cursor };
}

/**
 * `/series` — the Series library: every Series in the catalog as a shelf,
 * sorted by title, recency, size, release dates, or popularity, filtered by
 * Publisher, Source Status, Format, first letter, or a title search. The
 * first page and the filter facets are server-rendered; further pages load
 * from the client as the reader scrolls, and are kept for the session so
 * coming back to the library restores the shelf and the scroll position.
 *
 * Indexing mirrors the Releases browser (spec §11): the bare, default-sorted
 * `/series` is indexable; any param makes the view noindex/follow, and the
 * canonical is always the bare path.
 */
export const Route = createFileRoute("/series/")({
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [page, facets] = await Promise.all([
      fetchSeriesBrowse({ data: browseArgs(deps) }),
      fetchSeriesFacets(),
    ]);
    return {
      page,
      facets,
      filtered: Object.values(deps).some((value) => value !== undefined),
    };
  },
  head: ({ loaderData }) => ({
    ...pageHead({
      title: `Browse Series | ${SITE_NAME}`,
      description:
        "Every manga series in the catalog, A to Z. Filter by publisher, status, and format, or sort by latest and upcoming releases.",
      path: "/series",
      robots: loaderData?.filtered ? "noindex, follow" : undefined,
    }),
    scripts: [
      jsonLdScript(
        breadcrumbListJsonLd([
          { name: "MangaDB", path: "/" },
          { name: "Series" },
        ]),
      ),
    ],
  }),
  component: SeriesLibraryPage,
});

function SeriesLibraryPage() {
  const { page, facets } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <main className="library-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">The library</p>
          <h1 className="page-title">Series</h1>
        </div>
        {facets ? (
          <p className="result-count">
            {facets.total.toLocaleString("en-US")} series in the catalog
          </p>
        ) : null}
      </div>

      <Toolbar search={search} facets={facets} />
      <LetterStrip search={search} />

      {page === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to browse the library.
        </p>
      ) : page.items.length === 0 ? (
        <p className="notice">
          No series match these filters.{" "}
          <Link to="/series">Clear the filters</Link>
        </p>
      ) : (
        // Keyed by the view so a filter change starts a fresh shelf instead
        // of appending to the old one.
        <LibraryShelf
          key={JSON.stringify(search)}
          search={search}
          firstPage={page}
        />
      )}
    </main>
  );
}

/**
 * Sort, Publisher, Status, Format, and title search. A real GET form whose
 * fields mirror the search params: it submits before hydration, and after it
 * each change navigates in place. Format is a segmented set of links, so its
 * value rides along as a hidden field, as does the letter.
 */
function Toolbar({
  search,
  facets,
}: {
  search: LibrarySearch;
  facets: SeriesFacets | null;
}) {
  const navigate = Route.useNavigate();
  const go = (next: LibrarySearch) => void navigate({ search: next, replace: true });
  const statusCounts = new Map<string, number>(
    facets?.statuses.map((entry) => [entry.status, entry.count]) ?? [],
  );

  return (
    <div className="toolbar library-toolbar">
      <form
        className="filter-bar"
        method="get"
        action="/series"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get("q");
          go({ ...search, q: typeof q === "string" && q.trim() ? q.trim() : undefined });
        }}
      >
        {search.format ? <input type="hidden" name="format" value={search.format} /> : null}
        {search.letter ? <input type="hidden" name="letter" value={search.letter} /> : null}
        <label className="filter">
          <span className="filter-label">Sort</span>
          <select
            className="select"
            name="sort"
            value={search.sort ?? "title"}
            onChange={(event) => {
              const sort = keyOf(SORT_LABELS, event.currentTarget.value);
              // A new sort starts from its own default direction.
              go({
                ...search,
                sort: sort === "title" ? undefined : sort,
                order: undefined,
              });
            }}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="filter-label">Publisher</span>
          <select
            className="select"
            name="publisher"
            value={search.publisher ?? ""}
            onChange={(event) =>
              go({ ...search, publisher: event.currentTarget.value || undefined })
            }
          >
            <option value="">All publishers</option>
            {facets?.publishers.map((publisher) => (
              <option key={publisher.slug} value={publisher.slug}>
                {publisher.name}
              </option>
            ))}
          </select>
        </label>
        {/* Source Status is imported like any other fact; until a source
            supplies it the whole catalog reads "unknown" and the control
            would filter nothing. */}
        {statusCounts.size > 1 ? (
        <label className="filter">
          <span className="filter-label">Status</span>
          <select
            className="select"
            name="status"
            value={search.status ?? ""}
            onChange={(event) =>
              go({
                ...search,
                status: keyOf(STATUS_LABELS, event.currentTarget.value),
              })
            }
          >
            <option value="">Any status</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => {
              const count = statusCounts.get(value);
              return (
                <option key={value} value={value}>
                  {count === undefined ? label : `${label} (${count})`}
                </option>
              );
            })}
          </select>
        </label>
        ) : null}
        <nav className="seg library-format" aria-label="Format">
          {([undefined, "physical", "digital"] as const).map((format) => (
            <Link
              key={format ?? "all"}
              className={search.format === format ? "seg-btn is-on" : "seg-btn"}
              aria-current={search.format === format ? "true" : undefined}
              to="/series"
              search={{ ...search, format }}
              replace
            >
              {format ? FORMAT_LABELS[format] : "All"}
            </Link>
          ))}
        </nav>
        <div className="library-search">
          <input
            // Re-mounts when the URL's q changes (e.g. cleared filters).
            key={search.q ?? ""}
            className="search-input"
            type="search"
            name="q"
            defaultValue={search.q ?? ""}
            placeholder="Search titles"
            aria-label="Search series titles"
          />
          <button className="library-search-btn" type="submit" aria-label="Search">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

/** First-letter index: All, #, A–Z. Links, so it works without JavaScript. */
function LetterStrip({ search }: { search: LibrarySearch }) {
  return (
    <nav className="letter-strip" aria-label="Browse by first letter">
      {[undefined, ...LETTERS].map((letter) => {
        const on = search.letter === letter;
        return (
          <Link
            key={letter ?? "all"}
            className={on ? "letter is-on" : "letter"}
            aria-current={on ? "true" : undefined}
            aria-label={
              letter === undefined
                ? "All letters"
                : letter === "#"
                  ? "Titles starting with a number or symbol"
                  : undefined
            }
            to="/series"
            search={{ ...search, letter }}
          >
            {letter === undefined ? "All" : letter.toUpperCase()}
          </Link>
        );
      })}
    </nav>
  );
}

/** Covers rendered eagerly: roughly the first shelf row at desktop width. */
const EAGER_COVERS = 7;

/**
 * Pages already loaded per view (keyed by its search params), kept for the
 * browser session so returning to the library rebuilds the whole shelf at
 * once — the router's scroll restoration then lands where the reader left.
 * In memory only: a fresh page load starts from the server-rendered page.
 */
const loadedViews = new Map<string, { items: SeriesBrowsePage["items"]; cursor: string | null }>();

/** How far below the viewport the next page starts loading. */
const PRELOAD_MARGIN = "1200px";

/**
 * The results shelf. The next page loads as the reader nears the end of the
 * shelf (an observed sentinel), so the library scrolls without a button; a
 * failed page offers a retry in place.
 */
function LibraryShelf({
  search,
  firstPage,
}: {
  search: LibrarySearch;
  firstPage: SeriesBrowsePage;
}) {
  const viewKey = JSON.stringify(search);
  const restored = loadedViews.get(viewKey);
  const [items, setItems] = useState(restored?.items ?? firstPage.items);
  const [cursor, setCursor] = useState(restored ? restored.cursor : firstPage.nextCursor);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (!cursor || loading.current) return;
    loading.current = true;
    setState("loading");
    try {
      const next = await fetchSeriesBrowse({ data: browseArgs(search, cursor) });
      if (!next) throw new Error("Convex is not configured");
      const merged = [...items, ...next.items];
      loadedViews.set(viewKey, { items: merged, cursor: next.nextCursor });
      setItems(merged);
      setCursor(next.nextCursor);
      setState("idle");
    } catch {
      setState("error");
    } finally {
      loading.current = false;
    }
  }, [cursor, items, search, viewKey]);

  // Load the next page whenever the sentinel under the shelf comes near the
  // viewport; re-armed after each page so a short page keeps filling.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || state === "error") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor, loadMore, state]);

  return (
    <>
      <div className="shelf library-shelf">
        {items.map((item, i) => (
          <SeriesCard
            key={item.publicId}
            item={item}
            sort={search.sort ?? "title"}
            eager={i < EAGER_COVERS}
          />
        ))}
      </div>
      {cursor ? (
        <div className="library-more" ref={sentinel}>
          {state === "error" ? (
            <>
              <p className="library-more-error" role="alert">
                Could not load more series.
              </p>
              <button className="btn" type="button" onClick={() => void loadMore()}>
                Try again
              </button>
            </>
          ) : (
            <p className="library-more-status" aria-live="polite">
              {state === "loading" ? "Loading more series…" : ""}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

function SeriesCard({
  item,
  sort,
  eager,
}: {
  item: SeriesBrowseItem;
  sort: SeriesSort;
  eager: boolean;
}) {
  const params = slugParams(item.publicId, item.title);
  const publishers = item.publishers.map((publisher) => publisher.name).join(", ");
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        {/* The cover repeats the title link, so it stays out of the tab order. */}
        <Link
          className="cover-link"
          to="/series/$publicId/$slug"
          params={params}
          tabIndex={-1}
          aria-hidden="true"
        >
          <Cover
            src={item.coverUrl}
            isbn13={item.coverIsbn}
            title={item.title}
            lazy={!eager}
          />
        </Link>
      </div>
      <div className="caption">
        <Link className="caption-title" to="/series/$publicId/$slug" params={params}>
          {item.title}
        </Link>
        <div className="caption-meta">
          <span>
            {item.volumeCount} {item.volumeCount === 1 ? "vol" : "vols"}
          </span>
          {publishers ? (
            <>
              <span className="dot" />
              <span>{publishers}</span>
            </>
          ) : null}
        </div>
        <SortDetail item={item} sort={sort} />
      </div>
    </div>
  );
}

/** The caption's second line: whatever the shelf is sorted by. */
function SortDetail({ item, sort }: { item: SeriesBrowseItem; sort: SeriesSort }) {
  const latest = releaseDate(item.latestReleaseSort);
  const next = releaseDate(item.nextReleaseSort);
  switch (sort) {
    case "latest":
      return <p className="caption-sub">{latest ? `Latest ${latest}` : "No dated releases"}</p>;
    case "upcoming":
      return <p className="caption-sub">{next ? `Next ${next}` : "Nothing scheduled"}</p>;
    case "followers":
      return <p className="caption-sub">{item.followers.toLocaleString("en-US")} following</p>;
    case "collectors":
      return <p className="caption-sub">{item.collectors.toLocaleString("en-US")} collecting</p>;
    default:
      return item.sourceStatus === "unknown" ? null : (
        <p className="caption-sub">
          <span className="chip">{STATUS_LABELS[item.sourceStatus]}</span>
        </p>
      );
  }
}

/**
 * A yyyymmdd sort key as a date at its known precision: "12 Sep 2026",
 * "Sep 2026" (day unannounced, dd = 00), or "2026". Null for 0 (no date).
 */
function releaseDate(key: number): string | null {
  if (!key) return null;
  const year = Math.floor(key / 10000);
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  const monthName = MONTH_NAMES[month - 1]?.slice(0, 3);
  if (!monthName) return String(year);
  return day ? `${day} ${monthName} ${year}` : `${monthName} ${year}`;
}
