import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { ROLE_NAMES, type CreditRole } from "~/lib/byline";
import { catalogQuery, type AuthorPageData } from "~/lib/catalogData";
import { Cover } from "~/lib/cover";
import {
  authorTitleTag,
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  personJsonLd,
} from "~/lib/seo";
import { authorPath, parsePublicId, slugParams } from "~/lib/slug";

/**
 * An author page (`/author/{id}/{slug}`): everyone ANN credits on a Series
 * gets one, listing every Series they worked on, latest release first, with
 * their role on each. Credits come from the Anime News Network
 * Encyclopedia, which the page credits and links, as ANN's terms ask.
 * A stale slug 301s to the canonical URL, as for a Series.
 */
export const Route = createFileRoute("/author/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await catalogQuery(api.people.authorPage, { publicId });
    if (!page) throw notFound();
    const canonical = authorPath(page.author.publicId, page.author.name);
    if (`/author/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { author, series } = loaderData;
    const path = authorPath(author.publicId, author.name);
    const titles = series.slice(0, 3).map((s) => s.title).join(", ");
    return {
      ...pageHead({
        title: authorTitleTag(author.name),
        description: `Manga by ${author.name} in English: ${series.length} series${titles ? `, including ${titles}` : ""}, with every edition and release date.`,
        path,
        image: series[0]?.coverUrl ?? null,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: "Authors", path: "/authors" },
            { name: author.name },
          ]),
        ),
        jsonLdScript(personJsonLd({ name: author.name, path, sameAs: author.annUrl })),
      ],
    };
  },
  component: AuthorPage,
  notFoundComponent: () => (
    <main>
      <h1>Author not found</h1>
      <p className="notice">
        No author lives at this address. <Link to="/authors">Browse authors</Link>.
      </p>
    </main>
  ),
});

type AuthorSeries = AuthorPageData["series"][number];

/** "Story & Art on 12 · Original creator on 3": what they did, how often. */
function roleSummary(series: ReadonlyArray<AuthorSeries>): string {
  const counts = new Map<CreditRole, number>();
  for (const entry of series) {
    for (const role of entry.roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${ROLE_NAMES[role]} on ${n}`)
    .join(" · ");
}

function AuthorPage() {
  const { author, series } = Route.useLoaderData();
  const volumes = series.reduce((sum, entry) => sum + entry.volumeCount, 0);
  return (
    <main className="author-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <Link to="/authors">Authors</Link>
      </nav>

      <header className="author-hero">
        <p className="page-kicker">Author</p>
        <h1 className="author-name">{author.name}</h1>
        <p className="chips">
          <span className="chip">
            {series.length} series
          </span>
          <span className="chip">
            {volumes.toLocaleString("en-US")} {volumes === 1 ? "volume" : "volumes"}
          </span>
        </p>
        {series.length > 0 ? <p className="author-roles">{roleSummary(series)}</p> : null}
        <p className="note author-credit">
          Credits from the{" "}
          <a href={author.annUrl} rel="noopener" target="_blank">
            Anime News Network Encyclopedia
          </a>
          .
        </p>
      </header>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Series</h2>
          <p className="section-note">Latest release first</p>
        </div>
        {series.length === 0 ? (
          <p className="notice">
            None of {author.name}'s series has an English book in the catalog yet.
          </p>
        ) : (
          <div className="shelf">
            {series.map((entry, i) => (
              <AuthorSeriesItem key={entry.publicId} entry={entry} eager={i < 6} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/** One Series on the author's shelf: jacket, title, their role, its size. */
function AuthorSeriesItem({ entry, eager }: { entry: AuthorSeries; eager: boolean }) {
  const params = slugParams(entry.publicId, entry.title);
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/series/$publicId/$slug"
          params={params}
          tabIndex={-1}
          aria-hidden="true"
        >
          <Cover src={entry.coverUrl} isbn13={entry.coverIsbn} title={entry.title} lazy={!eager} />
        </Link>
      </div>
      <div className="caption">
        <Link className="caption-title" to="/series/$publicId/$slug" params={params}>
          {entry.title}
        </Link>
        <div className="caption-meta">
          <span>
            {entry.volumeCount} {entry.volumeCount === 1 ? "vol" : "vols"}
          </span>
          {entry.publishers[0] ? (
            <>
              <span className="dot" />
              <span>{entry.publishers.map((p) => p.name).join(", ")}</span>
            </>
          ) : null}
        </div>
        <p className="caption-sub author-role-chips">
          {entry.roles.map((role) => (
            <span key={role} className="chip">
              {ROLE_NAMES[role]}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
