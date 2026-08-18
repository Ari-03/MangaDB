import { createFileRoute, Link, redirect } from "@tanstack/react-router";

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
      <h1>Search</h1>
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
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Series title or ISBN…"
          aria-label="Search series, publishers, or an ISBN"
          autoFocus
        />
        <button type="submit">Search</button>
      </form>
      <p className="section-hint">
        Searches series titles (including alternate titles) and publishers.
        Paste an ISBN to jump straight to that book.
      </p>

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
      <p className="notice">
        No series or publishers match “{q}”.
      </p>
    );
  }
  return (
    <>
      {results.series.length > 0 ? (
        <section className="search-results">
          <h2>Series</h2>
          <ul className="result-list">
            {results.series.map((s) => (
              <li key={s.publicId}>
                <Link
                  to="/series/$publicId/$slug"
                  params={seriesLinkParams(s.publicId, s.title)}
                >
                  {s.title}
                </Link>
                {s.altTitles.length > 0 ? (
                  <span className="result-alt">
                    {" "}
                    also known as {s.altTitles.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {results.publishers.length > 0 ? (
        <section className="search-results">
          <h2>Publishers</h2>
          <ul className="result-list">
            {results.publishers.map((p) => (
              // Publisher Spotlight pages are ticket #25; /publisher/{slug}
              // is their canonical URL (spec §11), so a plain anchor here.
              <li key={p.slug}>
                <a href={`/publisher/${p.slug}`}>{p.name}</a>
              </li>
            ))}
          </ul>
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
