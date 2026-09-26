import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
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
import { useUrlDraft } from "~/lib/urlDraft";
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
type VolumeBucket = NonNullable<SeriesBrowseArgs["volumes"]>;
type ReleaseTiming = NonNullable<SeriesBrowseArgs["timing"]>;

/**
 * Library view state; every key is a query param, unset means the default.
 * Filters come first, so they lead the URL too:
 * `/series?publisher=viz-media,yen-press&volumes=2-5&sort=latest`.
 */
type LibrarySearch = {
  /** Publisher slugs, sorted and comma-joined; any of them matches. */
  publisher?: string;
  volumes?: VolumeBucket;
  timing?: ReleaseTiming;
  status?: SeriesStatus;
  format?: SeriesFormat;
  /** "a".."z", or "#" for titles that start with anything else. */
  letter?: string;
  q?: string;
  /** Unset is the default, Title A–Z. */
  sort?: Exclude<SeriesSort, "title">;
  order?: "asc" | "desc";
};

// Keyed by the backend's unions, so a new sort, bucket, or status fails the
// type check until it has a label here.
const SORT_LABELS: Record<SeriesSort, string> = {
  title: "Title A–Z",
  recent: "Recently added",
  volumes: "Most volumes",
  latest: "Latest release",
  upcoming: "Upcoming next",
  followers: "Most followed",
  collectors: "Most collected",
};

const VOLUME_LABELS: Record<VolumeBucket, string> = {
  one: "1",
  "2-5": "2–5",
  "6-15": "6–15",
  "16-plus": "16+",
};

const TIMING_LABELS: Record<ReleaseTiming, string> = {
  upcoming: "Upcoming",
  "past-3m": "Last 3 months",
  "past-6m": "Last 6 months",
  "past-12m": "Last 12 months",
  finished: "Finished",
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

/** How long title search waits for a pause in typing before it navigates. */
const SEARCH_DELAY_MS = 250;

/** `value` when it is one of `labels`' keys, else undefined. */
function keyOf<K extends string>(
  labels: Record<K, string>,
  value: unknown,
): K | undefined {
  return typeof value === "string" && Object.hasOwn(labels, value)
    ? (value as K)
    : undefined;
}

/**
 * Unknown or empty values read as unset; `sort=title` is the default.
 * Publishers arrive comma-joined from links or repeated (`publisher=a&
 * publisher=b`) from the pre-hydration GET form; both land sorted and
 * comma-joined, so one set of Publishers is one URL.
 */
function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const sort = keyOf(SORT_LABELS, search.sort);
  const letter =
    typeof search.letter === "string" ? search.letter.toLowerCase() : "";
  const q = typeof search.q === "string" ? search.q.trim().slice(0, 100) : "";
  const publishers = [search.publisher]
    .flat()
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => /^[a-z0-9-]+$/.test(slug));
  return {
    publisher: [...new Set(publishers)].sort().join(",") || undefined,
    volumes: keyOf(VOLUME_LABELS, search.volumes),
    timing: keyOf(TIMING_LABELS, search.timing),
    status: keyOf(STATUS_LABELS, search.status),
    format: keyOf(FORMAT_LABELS, search.format),
    letter: LETTERS.includes(letter) ? letter : undefined,
    q: q || undefined,
    sort: sort === "title" ? undefined : sort,
    order:
      search.order === "asc" || search.order === "desc"
        ? search.order
        : undefined,
  };
}

/** One string per view: the shelf cache key and the draft's "already there" check. */
function viewKey(search: LibrarySearch): string {
  return JSON.stringify(search);
}

/** The backend query args for a view (first page unless a cursor is given). */
function browseArgs(
  search: LibrarySearch,
  cursor: string | null = null,
): SeriesBrowseArgs {
  const { publisher, sort, ...filters } = search;
  return {
    ...filters,
    publishers: publisher?.split(","),
    sort: sort ?? "title",
    cursor,
  };
}

/**
 * Facets change only when the stats rebuild runs, so the browser asks once
 * per session instead of on every filter change (each ask reads all the
 * packs). The server renders them fresh; a failed ask is retried next time.
 */
let clientFacets: ReturnType<typeof fetchSeriesFacets> | undefined;
function libraryFacets() {
  if (typeof window === "undefined") return fetchSeriesFacets();
  clientFacets ??= fetchSeriesFacets().catch((error: unknown) => {
    clientFacets = undefined;
    throw error;
  });
  return clientFacets;
}

/**
 * `/series` — the Series library: every Series in the catalog as a shelf.
 * Filters come first — Publishers (any of several), volume count, release
 * timing, Format, Source Status, first letter, and a title search that
 * follows the typing — and the sort (title, recency, size, release dates,
 * popularity) orders whatever they match, with the matching count above the
 * shelf. The first page and the filter facets are server-rendered; further
 * pages load from the client as the reader scrolls, and are kept for the
 * session so coming back to the library restores the shelf and the scroll
 * position.
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
      libraryFacets(),
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
        "Every manga series in the catalog. Filter by publisher, volume count, release timing, and format, then sort by title, latest, or upcoming releases.",
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
  const { draft, update } = useLibraryDraft(search);
  const loading = useRouterState({ select: (state) => state.isLoading });

  return (
    <main className="library-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">The library</p>
          <h1 className="page-title">Series</h1>
        </div>
      </div>

      <div className="library-layout">
        <FilterPanel draft={draft} update={update} facets={facets} />

        <section
          className="library-results"
          aria-label="Series"
          aria-busy={loading || undefined}
        >
          <div className="results-head">
            <ResultCount page={page} facets={facets} />
            <label className="results-sort">
              <span className="filter-label">Sort by</span>
              <select
                className="select"
                name="sort"
                // Submits with the filter form before hydration.
                form="library-filters"
                value={draft.sort ?? "title"}
                // A new sort starts from its own default direction.
                onChange={(event) =>
                  update({
                    sort: validateLibrarySearch({ sort: event.currentTarget.value }).sort,
                    order: undefined,
                  })
                }
              >
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ActiveFilters search={search} facets={facets} />
          <LetterStrip search={search} />

          {page === null ? (
            <p className="notice">
              Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see
              the README) and restart to browse the library.
            </p>
          ) : page.items.length === 0 ? (
            <p className="notice">
              No series match these filters.{" "}
              <Link to="/series" search={{ sort: search.sort, order: search.order }}>
                Clear the filters
              </Link>
            </p>
          ) : (
            // Keyed by the view so a filter change starts a fresh shelf
            // instead of appending to the old one.
            <LibraryShelf key={viewKey(search)} search={search} firstPage={page} />
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * The filter panel's working copy of the view. A control changes it at once
 * and navigates in place (replace, no scroll jump); title search navigates
 * after a pause in typing. Any navigation the page did not ask for (a
 * removed chip, Clear all, a letter, back/forward), even one landing on the
 * view already shown, replaces the draft and drops a pending search; views
 * it asked for landing, even one a newer request has superseded, never
 * reset what is being typed (`useUrlDraft`). The router drops a superseded navigation's
 * results, so a slow response for an older query never replaces a newer one.
 */
function useLibraryDraft(search: LibrarySearch) {
  const navigate = Route.useNavigate();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelPending = useCallback(() => clearTimeout(timer.current), []);
  const { draft, setDraft, request } = useUrlDraft(search, viewKey(search), cancelPending);
  useEffect(() => cancelPending, [cancelPending]);

  const update = useCallback(
    (patch: Partial<LibrarySearch>, delayMs = 0) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      cancelPending();
      const go = () => {
        const view = validateLibrarySearch(next);
        if (request(viewKey(view))) {
          void navigate({ search: view, replace: true, resetScroll: false });
        }
      };
      if (delayMs > 0) timer.current = setTimeout(go, delayMs);
      else go();
    },
    [draft, setDraft, cancelPending, request, navigate],
  );

  return { draft, update };
}

type UpdateDraft = ReturnType<typeof useLibraryDraft>["update"];

/** "123 series match" for a filtered view, the catalog size otherwise. */
function ResultCount({
  page,
  facets,
}: {
  page: SeriesBrowsePage | null;
  facets: SeriesFacets | null;
}) {
  const count = page?.total ?? facets?.total;
  if (count === undefined) return <p className="results-count" />;
  const n = count.toLocaleString("en-US");
  return (
    <p className="results-count" aria-live="polite">
      {page?.total === null || page?.total === undefined ? (
        <>
          <strong>{n}</strong> series in the catalog
        </>
      ) : (
        <>
          <strong>{n}</strong> series {count === 1 ? "matches" : "match"}
        </>
      )}
    </p>
  );
}

/**
 * Title search and the filters, as a real GET form whose fields mirror the
 * search params: before hydration it submits like any form (the search
 * button, or Enter); after it every control applies on change. Under 960px
 * the filter groups fold behind a "Filters" button.
 */
function FilterPanel({
  draft,
  update,
  facets,
}: {
  draft: LibrarySearch;
  update: UpdateDraft;
  facets: SeriesFacets | null;
}) {
  const [open, setOpen] = useState(false);
  const statusCounts = new Map<string, number>(
    facets?.statuses.map((entry) => [entry.status, entry.count]) ?? [],
  );
  const publishers = draft.publisher?.split(",") ?? [];
  const activeCount =
    publishers.length +
    [draft.volumes, draft.timing, draft.status, draft.format].filter(Boolean).length;

  return (
    <aside className="library-filters" aria-label="Filters">
      <form
        id="library-filters"
        method="get"
        action="/series"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          update({});
          setOpen(false);
        }}
      >
        {draft.letter ? <input type="hidden" name="letter" value={draft.letter} /> : null}
        {draft.order ? <input type="hidden" name="order" value={draft.order} /> : null}
        <div className="library-search">
          <input
            className="search-input"
            type="search"
            name="q"
            value={draft.q ?? ""}
            onChange={(event) => update({ q: event.currentTarget.value }, SEARCH_DELAY_MS)}
            placeholder="Search titles"
            aria-label="Search series titles"
            autoComplete="off"
          />
          <button className="library-search-btn" type="submit" aria-label="Search">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" />
            </svg>
          </button>
        </div>
        <button
          className="filters-toggle"
          type="button"
          aria-expanded={open}
          aria-controls="library-filter-groups"
          onClick={() => setOpen(!open)}
        >
          Filters
          {activeCount > 0 ? <span className="filters-toggle-count">{activeCount}</span> : null}
        </button>

        <div id="library-filter-groups" className="filter-groups" data-open={open}>
          {facets ? (
            <PublisherPicker
              publishers={facets.publishers}
              selected={publishers}
              onChange={(slugs) => update({ publisher: slugs.join(",") || undefined })}
            />
          ) : null}
          <ChoiceGroup
            legend="Volumes"
            name="volumes"
            anyLabel="Any"
            labels={VOLUME_LABELS}
            value={draft.volumes}
            onPick={(volumes) => update({ volumes })}
          />
          <ChoiceGroup
            legend="Releases"
            name="timing"
            anyLabel="Any time"
            labels={TIMING_LABELS}
            value={draft.timing}
            onPick={(timing) => update({ timing })}
            hint="Finished: nothing announced and no release in a year."
          />
          <ChoiceGroup
            legend="Format"
            name="format"
            anyLabel="Any"
            labels={FORMAT_LABELS}
            value={draft.format}
            onPick={(format) => update({ format })}
          />
          {/* Source Status is imported like any other fact; until a source
              supplies it the whole catalog reads "unknown" and the group
              would filter nothing. */}
          {statusCounts.size > 1 ? (
            <ChoiceGroup
              legend="Source status"
              name="status"
              anyLabel="Any"
              labels={STATUS_LABELS}
              value={draft.status}
              onPick={(status) => update({ status })}
            />
          ) : null}
          <button className="btn btn-primary filters-apply" type="submit">
            Show results
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * The Publisher checklist: any number may be ticked (a Series matches when
 * any of its Publishers is), with a find-as-you-type box over the list and
 * each Publisher's Series count. The find box is not a form field.
 */
function PublisherPicker({
  publishers,
  selected,
  onChange,
}: {
  publishers: SeriesFacets["publishers"];
  selected: ReadonlyArray<string>;
  onChange: (slugs: Array<string>) => void;
}) {
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const shown = needle
    ? publishers.filter((publisher) => publisher.name.toLowerCase().includes(needle))
    : publishers;
  return (
    <fieldset className="filter-group">
      <legend className="filter-legend">
        Publishers
        {selected.length > 0 ? (
          <button className="filter-legend-clear" type="button" onClick={() => onChange([])}>
            Clear {selected.length}
          </button>
        ) : null}
      </legend>
      <input
        className="search-input publisher-find"
        type="search"
        value={find}
        onChange={(event) => setFind(event.currentTarget.value)}
        placeholder="Find a publisher"
        aria-label="Find a publisher"
        autoComplete="off"
      />
      <ul className="publisher-list">
        {shown.map((publisher) => (
          <li key={publisher.slug}>
            <label className="publisher-option">
              <input
                type="checkbox"
                name="publisher"
                value={publisher.slug}
                checked={selected.includes(publisher.slug)}
                onChange={(event) =>
                  onChange(
                    event.currentTarget.checked
                      ? [...selected, publisher.slug]
                      : selected.filter((slug) => slug !== publisher.slug),
                  )
                }
              />
              <span className="publisher-name">{publisher.name}</span>
              <span className="publisher-count">{publisher.count.toLocaleString("en-US")}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="publisher-none">No publisher matches “{find.trim()}”</li>
        ) : null}
      </ul>
    </fieldset>
  );
}

/**
 * A single-choice filter as a row of pill-shaped radios, "Any" first. Keyed
 * by the backend union through `labels`, so the pick arrives typed.
 */
function ChoiceGroup<K extends string>({
  legend,
  name,
  anyLabel,
  labels,
  value,
  onPick,
  hint,
}: {
  legend: string;
  name: string;
  anyLabel: string;
  labels: Record<K, string>;
  value: K | undefined;
  onPick: (value: K | undefined) => void;
  hint?: string;
}) {
  const options: Array<[string, string]> = [["", anyLabel], ...Object.entries<string>(labels)];
  return (
    <fieldset className="filter-group">
      <legend className="filter-legend">{legend}</legend>
      <div className="choice-row">
        {options.map(([key, label]) => (
          <label key={key} className="choice">
            <input
              type="radio"
              name={name}
              value={key}
              checked={(value ?? "") === key}
              onChange={() => onPick(keyOf(labels, key))}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {hint ? <p className="filter-hint">{hint}</p> : null}
    </fieldset>
  );
}

/**
 * The filters in force as removable chips, then "Clear all" (which keeps the
 * sort). Links, so they work before hydration and push history.
 */
function ActiveFilters({
  search,
  facets,
}: {
  search: LibrarySearch;
  facets: SeriesFacets | null;
}) {
  const names = new Map(facets?.publishers.map((p) => [p.slug, p.name]));
  const publishers = search.publisher?.split(",") ?? [];
  const chips: Array<{ key: string; label: string; next: LibrarySearch }> = [
    ...publishers.map((slug) => ({
      key: `publisher:${slug}`,
      label: names.get(slug) ?? slug,
      next: {
        ...search,
        publisher: publishers.filter((other) => other !== slug).join(",") || undefined,
      },
    })),
  ];
  if (search.volumes) {
    chips.push({ key: "volumes", label: `${VOLUME_LABELS[search.volumes]} ${search.volumes === "one" ? "volume" : "volumes"}`, next: { ...search, volumes: undefined } });
  }
  if (search.timing) {
    chips.push({ key: "timing", label: `Releases: ${TIMING_LABELS[search.timing]}`, next: { ...search, timing: undefined } });
  }
  if (search.format) {
    chips.push({ key: "format", label: FORMAT_LABELS[search.format], next: { ...search, format: undefined } });
  }
  if (search.status) {
    chips.push({ key: "status", label: `Source: ${STATUS_LABELS[search.status]}`, next: { ...search, status: undefined } });
  }
  if (search.letter) {
    chips.push({ key: "letter", label: `Starts with ${search.letter.toUpperCase()}`, next: { ...search, letter: undefined } });
  }
  if (search.q) {
    chips.push({ key: "q", label: `“${search.q}”`, next: { ...search, q: undefined } });
  }
  if (chips.length === 0) return null;
  return (
    <div className="active-filters">
      <ul className="active-filter-list" aria-label="Active filters">
        {chips.map((chip) => (
          <li key={chip.key}>
            <Link
              className="chip active-filter"
              to="/series"
              search={chip.next}
              resetScroll={false}
              activeOptions={EXACT}
              aria-label={`Remove filter: ${chip.label}`}
            >
              {chip.label}
              <span className="active-filter-x" aria-hidden="true">×</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        className="link-btn"
        to="/series"
        search={{ sort: search.sort, order: search.order }}
        resetScroll={false}
        activeOptions={EXACT}
      >
        Clear all
      </Link>
    </div>
  );
}

/**
 * The router calls a link "active" when the current search merely contains
 * the link's, which every filter-removing link does; views here compare whole.
 */
const EXACT = { exact: true };

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
            resetScroll={false}
            activeOptions={EXACT}
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
  const key = viewKey(search);
  const restored = loadedViews.get(key);
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
      loadedViews.set(key, { items: merged, cursor: next.nextCursor });
      setItems(merged);
      setCursor(next.nextCursor);
      setState("idle");
    } catch {
      setState("error");
    } finally {
      loading.current = false;
    }
  }, [cursor, items, search, key]);

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
