import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { pageHead } from "~/lib/seo";

/**
 * The "about the data" page (ticket #40, spec §7): where the catalog comes
 * from, the honest digital-coverage note, the ANN attribution its license
 * requires, and the cover takedown contact (#13). Static, indexable.
 *
 * Set as one readable column (~68ch) — this is the only page on the site that
 * is read rather than browsed, so it gets no shelves, only the display face.
 */
export const Route = createFileRoute("/about-the-data")({
  head: () =>
    pageHead({
      title: "About the Data | MangaDB",
      description:
        "Where MangaDB's catalog comes from: publisher catalogs, the Anime News Network Encyclopedia, the Penguin Random House API, and OpenLibrary — plus what's covered, what isn't yet, and how to report problems.",
      path: "/about-the-data",
    }),
  component: AboutTheData,
});

// The takedown/attribution contact. A mailbox the operator must actually
// run — see the README's launch section.
export const DATA_CONTACT_EMAIL = "data@mangadb.org";

type Source = {
  name: string;
  body: ReactNode;
  credit?: ReactNode;
};

// The four sources behind every record, in the order they carry weight: a
// publisher on its own books, then the all-publisher backbone, then the
// bibliographic fill-ins.
const SOURCES: Source[] = [
  {
    name: "Seven Seas Entertainment, Kodansha",
    body: "Release data from each publisher's own catalog — the authority on its own books.",
  },
  {
    name: "Anime News Network Encyclopedia",
    body: "The all-publisher series and volume backbone.",
    credit: (
      <>
        Encyclopedia data provided by{" "}
        <a href="https://www.animenewsnetwork.com/encyclopedia/">
          Anime News Network
        </a>
        .
      </>
    ),
  },
  {
    name: "Penguin Random House API",
    body: "Authoritative release dates, ISBNs, and prices for PRH-distributed publishers.",
  },
  {
    name: "OpenLibrary",
    body: (
      <>
        Bibliographic ISBN data from{" "}
        <a href="https://openlibrary.org">openlibrary.org</a> (CC0).
      </>
    ),
  },
];

function AboutTheData() {
  return (
    <main className="about-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>About the data</span>
      </nav>

      <h1>About the data</h1>
      <p className="about-lede">
        MangaDB catalogs English-language manga <strong>volume</strong>{" "}
        releases: which volumes exist, and when each edition of each one comes
        out. The catalog is built from external sources and kept correct by
        people — imported facts carry their source in each record's public
        history, and approved human corrections are never silently overwritten
        by a re-import.
      </p>

      <h2>Sources</h2>
      <ul className="about-sources">
        {SOURCES.map((source) => (
          <li key={source.name}>
            <span className="source-name">{source.name}</span>
            <span>
              {source.body}
              {source.credit ? (
                <em className="source-credit">{source.credit}</em>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      <h2>What's covered — and what isn't yet</h2>
      <p>
        <strong>Physical releases are the focus and are tracked in full</strong>{" "}
        — the complete backlist and every announced upcoming release our
        sources list.{" "}
        <strong>Digital coverage is partial at launch:</strong> digital-only
        and digital-first releases appear where a source lists them, but no
        source in the current set covers every storefront, so a missing
        digital edition is a known gap rather than a statement that it doesn't
        exist. Digital coverage grows source by source.
      </p>
      <p>
        Some series are partially imported — a volume, a date, or an edition
        can be missing or wrong. Every series page has a{" "}
        <em>"see something missing or wrong? Report it"</em> button that puts
        your report straight into the review queue.
      </p>

      <h2>Covers &amp; takedown</h2>
      <p>
        Cover images belong to their publishers and are shown to identify each
        release, with the source credited. Jacket art is looked up by ISBN
        from the distribution catalog Penguin Random House operates for the
        publishers it carries, and kept in our own cache so pages never lean
        on a third party while you browse. If you hold rights to a cover (or
        anything else here) and want it corrected or removed, email{" "}
        <a href={`mailto:${DATA_CONTACT_EMAIL}`}>{DATA_CONTACT_EMAIL}</a> with
        the page link — takedowns are honored promptly.
      </p>

      <h2>Corrections</h2>
      <p>
        Spot an error? Use the report button on the series page, or email{" "}
        <a href={`mailto:${DATA_CONTACT_EMAIL}`}>{DATA_CONTACT_EMAIL}</a>.
        Every accepted correction becomes a public revision on the record it
        fixes.
      </p>
    </main>
  );
}
