import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { api } from "../../convex/_generated/api";
import { ROLE_NAMES, type CreditRole } from "~/lib/byline";
import { catalogQuery, type AuthorPageData } from "~/lib/catalogData";
import { showMature } from "~/lib/mature";
import { SeriesShelfItem } from "~/lib/shelfItem";
import { plural } from "~/lib/format";
import { authorTitleTag, pageHead, personJsonLd } from "~/lib/seo";
import { Breadcrumbs, NotFound } from "~/lib/pageScaffold";
import { authorPath, parsePublicId } from "~/lib/slug";

/**
 * An author page (`/author/{id}/{slug}`): everyone credited on a Series
 * gets one, listing every Series they worked on, latest release first, with
 * their role on each. Credits come from the Anime News Network
 * Encyclopedia, which the page credits and links, as ANN's terms ask, or
 * from publishers' creator names for Series ANN does not credit; a person
 * only publishers name has no ANN page, so neither link nor credit shows.
 * A stale slug 301s to the canonical URL, as for a Series.
 */
type AuthorSeries = AuthorPageData["series"][number];

/** Wrote or drew it (people.ts `isMaker`), as opposed to only originating it. */
const made = (entry: AuthorSeries) => entry.roles.some((role) => role !== "original");

export const Route = createFileRoute("/author/$publicId/$slug")({
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await catalogQuery(api.people.authorPage, { publicId, showMature: showMature() });
    if (!page) throw notFound();
    const canonical = authorPath(page.author.publicId, page.author.name);
    if (`/author/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { author } = loaderData;
    // The same count the page leads with: Series they wrote or drew.
    const series = loaderData.series.filter(made);
    const path = authorPath(author.publicId, author.name);
    const titles = series
      .slice(0, 3)
      .map((s) => s.title)
      .join(", ");
    return pageHead({
      title: authorTitleTag(author.name),
      description: `Manga by ${author.name} in English: ${series.length} series${titles ? `, including ${titles}` : ""}, with every edition and release date.`,
      path,
      image: series[0]?.coverUrl ?? null,
      breadcrumbs: [{ name: "Authors", path: "/authors" }, { name: author.name }],
      jsonLd: [personJsonLd({ name: author.name, path, sameAs: author.annUrl })],
    });
  },
  component: AuthorPage,
  notFoundComponent: () => <NotFound noun="Author" browse="authors" />,
});

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
  const { author, series: all } = Route.useLoaderData();
  // Their own work leads; Series they only originated (a spinoff someone
  // else writes and draws) follow in their own section.
  const series = all.filter(made);
  const originals = all.filter((entry) => !made(entry));
  const volumes = series.reduce((sum, entry) => sum + entry.volumeCount, 0);
  return (
    <main className="author-page">
      <Breadcrumbs trail={[<Link to="/authors">Authors</Link>]} />

      <header className="author-hero">
        <p className="page-kicker">Author</p>
        <h1 className="author-name">{author.name}</h1>
        <p className="chips">
          <span className="chip">{series.length} series</span>
          <span className="chip">
            {volumes.toLocaleString("en-US")} {volumes === 1 ? "volume" : "volumes"}
          </span>
          {originals.length > 0 ? (
            <span className="chip">Original creator of {originals.length} more</span>
          ) : null}
        </p>
        {all.length > 0 ? <p className="author-roles">{roleSummary(all)}</p> : null}
        {author.annUrl ? (
          <p className="note author-credit">
            Credits from the{" "}
            <a href={author.annUrl} rel="noopener" target="_blank">
              Anime News Network Encyclopedia
            </a>
            .
          </p>
        ) : null}
      </header>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Series</h2>
          <p className="section-note">Latest release first</p>
        </div>
        {series.length === 0 ? (
          <p className="notice">
            {originals.length > 0
              ? `${author.name} is credited as the original creator below; the catalog has none of their own series in English yet.`
              : `None of ${author.name}'s series has an English book in the catalog yet.`}
          </p>
        ) : (
          <div className="shelf">
            {series.map((entry, i) => (
              <AuthorSeriesItem key={entry.publicId} entry={entry} eager={i < 6} />
            ))}
          </div>
        )}
      </section>

      {originals.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Original work</h2>
            <p className="section-note">
              Series others write or draw from {author.name}'s original work
            </p>
          </div>
          <div className="shelf">
            {originals.map((entry) => (
              <AuthorSeriesItem key={entry.publicId} entry={entry} eager={false} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

/** One Series on the author's shelf: jacket, title, their role, its size. */
function AuthorSeriesItem({ entry, eager }: { entry: AuthorSeries; eager: boolean }) {
  return (
    <SeriesShelfItem series={entry} lazy={!eager}>
      <div className="caption-meta">
        <span>{plural(entry.volumeCount, "vol")}</span>
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
    </SeriesShelfItem>
  );
}
