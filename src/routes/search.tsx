import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, type CSSProperties } from "react";

import { Cover } from "~/lib/cover";
import { normalizeIsbn } from "~/lib/isbn";
import { isbnInProgress, useDebounced } from "~/lib/searchSuggest";
import { slugParams } from "~/lib/slug";
import { useUrlDraft } from "~/lib/urlDraft";
import { fetchSearchResults, type SearchResults } from "~/server/search";

/**
 * v1 search (ticket #38, spec §8/§11): `/search?q=…` over Series via the
 * title + alt-titles search index, results linking canonical Series pages
 * with their jackets; Publisher lookup via the small publisher list, linking
 * Publisher pages. When nothing contains the whole query, a "Did you mean"
 * line offers near-miss titles. Results follow the box as you type (a
 * debounced `replace` navigation, so history is not spammed).
 *
 * An input recognized as a valid ISBN never runs a text search: the loader
 * redirects through the `/isbn/{isbn}` route, which owns resolution to the
 * owning Edition (or Bundle) page and 301s there (ticket #23). The search →
 * /isbn hop is a 302 because it depends on the typed query, not on a record.
 *
 * No Volume or Bundle search in v1. Search pages are not in the indexable
 * set (spec §11), so they carry robots noindex.
 */
export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    const q = deps.q.trim();
    const isbn = normalizeIsbn(q);
    if (isbn) {
      throw redirect({ href: `/isbn/${isbn}`, statusCode: 302 });
    }
    if (q === "") return { q, results: emptyResults() };
    return { q, results: await fetchSearchResults({ data: q }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.q
          ? `Search “${loaderData.q}” — MangaDB`
          : "Search — MangaDB",
      },
      { name: "robots", content: "noindex, follow" },
    ],
  }),
  component: SearchPage,
});

function emptyResults(): SearchResults {
  return { series: [], publishers: [], didYouMean: [] };
}

/** Quiet time before the page's box re-runs the search. */
const LIVE_DEBOUNCE_MS = 250;

function SearchPage() {
  const { q, results } = Route.useLoaderData();
  const { q: urlQuery } = Route.useSearch();
  const navigate = Route.useNavigate();

  // The box is controlled so results can follow it: once typing pauses, the
  // URL is replaced (the loader re-runs; the old results stay up meanwhile).
  // The route stays mounted, so focus and caret survive. A query arriving
  // from elsewhere (the header box, a "Did you mean" link) refills the box,
  // but none this box asked for while typing carried on, whatever order
  // they land in (`useUrlDraft`).
  const { draft: text, setDraft: setText, request } = useUrlDraft(urlQuery, urlQuery);
  const settled = useDebounced(text, LIVE_DEBOUNCE_MS);
  useEffect(() => {
    // An ISBN being typed waits for Enter (the loader redirects valid ones).
    if (isbnInProgress(settled.trim()) || !request(settled)) return;
    void navigate({ search: { q: settled }, replace: true, resetScroll: false });
  }, [settled, request, navigate]);

  return (
    <main className="search-page">
      <div className="acct-head">
        <h1 className="acct-title">Search the shelves</h1>
        {/* A real GET form: the page works before hydration, and with JS the
            submit becomes a client-side navigation. */}
        <form
          className="search-form"
          role="search"
          action="/search"
          method="get"
          onSubmit={(event) => {
            event.preventDefault();
            request(text);
            void navigate({ to: "/search", search: { q: text } });
          }}
        >
          <input
            className="search-field"
            type="search"
            name="q"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Series title, publisher, or ISBN"
            aria-label="Search series, publishers, or an ISBN"
            autoFocus
          />
          <button className="btn btn-primary" type="submit">
            Search
          </button>
        </form>
        <p className="search-note">
          Series titles — including alternate titles — and publishers. Paste an
          ISBN to jump straight to that book.
        </p>
      </div>

      {results === null ? (
        <p className="notice">
          Convex is not configured. Set <code>VITE_CONVEX_URL</code> (see the
          README) and restart to search the catalog.
        </p>
      ) : q === "" ? null : (
        <SearchResultsView q={q} results={results} />
      )}
    </main>
  );
}

function SearchResultsView({
  q,
  results,
}: {
  q: string;
  results: SearchResults;
}) {
  const didYouMean = <DidYouMean hits={results.didYouMean} />;
  if (results.series.length === 0 && results.publishers.length === 0) {
    return (
      <>
        {didYouMean}
        <div className="empty-shelf">
          <div className="ghost-shelf" aria-hidden="true">
            <div className="ghost-spine">
              <span className="cover">
                <span className="cover-ph" style={{ "--cloth": "#455060" } as CSSProperties} />
              </span>
            </div>
            <div className="ghost-spine">
              <span className="cover">
                <span className="cover-ph" style={{ "--cloth": "#7a2e2a" } as CSSProperties} />
              </span>
            </div>
            <div className="ghost-spine">
              <span className="cover">
                <span className="cover-ph" style={{ "--cloth": "#2b5d5b" } as CSSProperties} />
              </span>
            </div>
          </div>
          <div className="empty-note">
            <p>
              Nothing on the shelf matches “{q}”. Try fewer words, the Japanese
              title, or browse what is coming out this month.
            </p>
            <Link className="btn" to="/releases">
              Open the release agenda
            </Link>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {didYouMean}
      {results.series.length > 0 ? (
        <section className="search-results">
          <div className="section-head">
            <h2 className="section-title">Series</h2>
            <p className="section-note">
              {results.series.length}{" "}
              {results.series.length === 1 ? "match" : "matches"} for “{q}”
            </p>
          </div>
          <div className="shelf">
            {results.series.map((s) => (
              <div className="shelf-item" key={s.publicId}>
                <div className="cover-wrap">
                  <Link
                    className="cover-link"
                    to="/series/$publicId/$slug"
                    params={slugParams(s.publicId, s.title)}
                  >
                    {/* The Series library's jacket for it; a Series with no
                        art on file is plain cloth with the title. */}
                    <Cover
                      src={s.coverUrl}
                      isbn13={s.coverIsbn}
                      title={s.title}
                      lazy={false}
                    />
                  </Link>
                </div>
                <div className="caption">
                  <Link
                    className="caption-title"
                    to="/series/$publicId/$slug"
                    params={slugParams(s.publicId, s.title)}
                  >
                    {s.title}
                  </Link>
                  {s.altTitles.length > 0 ? (
                    <p className="result-alt">
                      also known as {s.altTitles.join(", ")}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {results.publishers.length > 0 ? (
        <section className="search-results">
          <div className="section-head">
            <h2 className="section-title">Publishers</h2>
          </div>
          <div className="pub-hits">
            {results.publishers.map((p) => (
              // The Publisher Spotlight page (ticket #25, spec §11).
              <Link
                className="pub-hit"
                key={p.slug}
                to="/publisher/$slug"
                params={{ slug: p.slug }}
              >
                <span className="pub-mark" aria-hidden="true">
                  {p.name.slice(0, 1)}
                </span>
                <span>
                  <span className="pub-hit-name">{p.name}</span>
                  <span className="pub-hit-meta">Publisher spotlight</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * "Did you mean Berserk?" over results that don't contain the query. Each
 * suggestion re-runs the search with the title (or alt title) that came
 * close, which lands the Series and its relatives.
 */
function DidYouMean({ hits }: { hits: SearchResults["didYouMean"] }) {
  if (hits.length === 0) return null;
  return (
    <p className="did-you-mean">
      Did you mean{" "}
      {hits.map((hit, i) => {
        const name = hit.altMatch ?? hit.title;
        return (
          <span key={hit.publicId}>
            {i === 0 ? null : i === hits.length - 1 ? " or " : ", "}
            <Link to="/search" search={{ q: name }}>
              {name}
            </Link>
          </span>
        );
      })}
      ?
    </p>
  );
}
