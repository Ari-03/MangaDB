import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { Cover } from "~/lib/cover";
import { normalizeIsbn } from "~/lib/isbn";
import { seriesPath } from "~/lib/slug";
import { fetchSearchResults, type SearchResults } from "~/server/search";

/**
 * v1 search (ticket #38, spec §8/§11): `/search?q=…` over Series via the
 * title + alt-titles search index, results linking canonical Series pages;
 * Publisher lookup via the small publisher list, linking Publisher pages.
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
  return { series: [], publishers: [] };
}

function SearchPage() {
  const { q, results } = Route.useLoaderData();
  const navigate = Route.useNavigate();

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
            const value = new FormData(event.currentTarget).get("q");
            void navigate({
              to: "/search",
              search: { q: typeof value === "string" ? value : "" },
            });
          }}
        >
          <input
            className="search-field"
            type="search"
            name="q"
            defaultValue={q}
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
  if (results.series.length === 0 && results.publishers.length === 0) {
    return (
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
    );
  }
  return (
    <>
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
                    params={seriesLinkParams(s.publicId, s.title)}
                  >
                    {/* A Series has no volume or publisher of its own, so
                        the coverless book is plain cloth with the title. */}
                    <Cover title={s.title} lazy={false} />
                  </Link>
                </div>
                <div className="caption">
                  <Link
                    className="caption-title"
                    to="/series/$publicId/$slug"
                    params={seriesLinkParams(s.publicId, s.title)}
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

function seriesLinkParams(publicId: number, title: string) {
  const canonical = seriesPath(publicId, title);
  const slug = canonical.split("/").pop() ?? "";
  return { publicId: String(publicId), slug };
}
