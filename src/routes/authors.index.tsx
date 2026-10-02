import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { catalogQuery, type AuthorCard } from "~/lib/catalogData";
import { showMature } from "~/lib/mature";
import { Cover } from "~/lib/cover";
import { pageHead, SITE_NAME } from "~/lib/seo";
import { slugParams } from "~/lib/slug";

/** Authors per page of the tab. */
const PAGE_SIZE = 48;

const authorsPage = (cursor: string | null, mature: boolean) =>
  catalogQuery(api.people.authors, {
    paginationOpts: { numItems: PAGE_SIZE, cursor },
    showMature: mature,
  });

/**
 * `/authors` — the Authors tab: every author credited on a Series in the
 * catalog (by ANN, or by a publisher where ANN is silent), the most
 * prolific first (people.ts `authors`), each with the
 * jacket of their biggest Series. More load on request. Indexable.
 */
export const Route = createFileRoute("/authors/")({
  loader: async () => {
    // The mature-titles choice the first page was read under (lib/mature.tsx).
    const mature = showMature();
    return { first: await authorsPage(null, mature), mature };
  },
  head: () =>
    pageHead({
      title: `Manga Authors – Browse by Mangaka | ${SITE_NAME}`,
      description:
        "Browse manga authors and artists with English releases, the most prolific first, and every series each one made.",
      path: "/authors",
      breadcrumbs: [{ name: "Authors" }],
    }),
  component: AuthorsPage,
});

function AuthorsPage() {
  const { first, mature } = Route.useLoaderData();
  // A changed mature-titles choice starts the list over from its new first page.
  return <AuthorsList key={String(mature)} first={first} mature={mature} />;
}

function AuthorsList({
  first,
  mature,
}: {
  first: Awaited<ReturnType<typeof authorsPage>>;
  mature: boolean;
}) {
  const [authors, setAuthors] = useState<AuthorCard[]>(first?.page ?? []);
  const [cursor, setCursor] = useState(first && !first.isDone ? first.continueCursor : null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const loadMore = async () => {
    if (!cursor) return;
    setState("loading");
    try {
      const next = await authorsPage(cursor, mature);
      if (!next) throw new Error("Convex is not configured");
      setAuthors((prev) => [...prev, ...next.page]);
      setCursor(next.isDone ? null : next.continueCursor);
      setState("idle");
    } catch {
      setState("error");
    }
  };

  return (
    <main className="authors-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">The library</p>
          <h1 className="page-title">Authors</h1>
        </div>
      </div>
      <p className="section-note authors-note">
        Everyone credited on a series in the catalog, the most prolific first. Credits from the{" "}
        <a href="https://www.animenewsnetwork.com/encyclopedia/" rel="noopener" target="_blank">
          Anime News Network Encyclopedia
        </a>
        , and from publishers' own catalogs for series it doesn't cover.
      </p>

      {first === null ? (
        <p className="notice">Convex is not configured, so there are no authors to show.</p>
      ) : authors.length === 0 ? (
        <p className="notice">No author credits yet: they arrive with the next credits rebuild.</p>
      ) : (
        <div className="shelf">
          {authors.map((author, i) => (
            <AuthorItem key={author.publicId} author={author} eager={i < 12} />
          ))}
        </div>
      )}

      {cursor ? (
        <div className="library-more">
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={state === "loading"}
          >
            {state === "loading" ? "Loading…" : "Show more authors"}
          </button>
          {state === "error" ? <p className="note">That didn't load. Try again.</p> : null}
        </div>
      ) : null}
    </main>
  );
}

/** One author: their biggest Series' jacket, their name, how many Series. */
function AuthorItem({ author, eager }: { author: AuthorCard; eager: boolean }) {
  const params = slugParams(author.publicId, author.name);
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/author/$publicId/$slug"
          params={params}
          tabIndex={-1}
          aria-hidden="true"
        >
          <Cover
            src={author.coverUrl}
            isbn13={author.coverIsbn}
            title={author.name}
            foot={[`${author.seriesCount} series`, null]}
            lazy={!eager}
          />
        </Link>
      </div>
      <div className="caption">
        <Link className="caption-title" to="/author/$publicId/$slug" params={params}>
          {author.name}
        </Link>
        <div className="caption-meta">
          <span>{author.seriesCount} series</span>
        </div>
      </div>
    </div>
  );
}
