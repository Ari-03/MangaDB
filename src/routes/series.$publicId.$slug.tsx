import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";

import { editionTitle, volumeTitle } from "../../convex/lib/titles";
import { Cover, firstIsbn } from "~/lib/cover";
import { SeriesFollowControls } from "~/lib/follows";
import { formatPartialDate } from "~/lib/format";
import {
  ModEditLink,
  ProposeNewRecordsLink,
  RecordHistory,
} from "~/lib/moderation";
import {
  SeriesReadingControls,
  SeriesReadingProgress,
  VolumeReadCount,
} from "~/lib/reading";
import { SeriesReportAffordance } from "~/lib/report";
import {
  bookSeriesJsonLd,
  breadcrumbListJsonLd,
  jsonLdScript,
  pageHead,
  seriesTitleTag,
} from "~/lib/seo";
import { SeriesVisibilityControls } from "~/lib/sharing";
import { parsePublicId, seriesPath, slugParams } from "~/lib/slug";
import { fetchSeriesPage, type SeriesPageData } from "~/server/seriesPage";

/**
 * The Series page (ticket #22): `/series/{id}/{slug}`, server-rendered from
 * Convex. The Series' Editions are grouped into reading paths — the standard
 * run per publisher, then each Edition Line (Omnibus, Deluxe, …); the picker
 * shows each path's first book and `?edition=` opens that path as a shelf of
 * its books, with gaps in a standard run marked. Releases, Variants and
 * Bundles live on each book's Edition page.
 *
 * The public ID is identity; the slug is cosmetic and computed from the
 * current title (spec §8/§11). A stale or wrong slug — including the old ID
 * of a merged Series, which resolves to its survivor — 301s to the canonical
 * URL.
 */
export const Route = createFileRoute("/series/$publicId/$slug")({
  // `?edition=` picks the reading path; the loader ignores it, so switching
  // paths never refetches the page.
  validateSearch: (search: Record<string, unknown>): { edition?: string } =>
    typeof search.edition === "string" ? { edition: search.edition } : {},
  loader: async ({ params }) => {
    const publicId = parsePublicId(params.publicId);
    if (publicId === null) throw notFound();
    const page = await fetchSeriesPage({ data: publicId });
    if (!page) throw notFound();
    const canonical = seriesPath(page.series.publicId, page.series.title);
    if (`/series/${params.publicId}/${params.slug}` !== canonical) {
      throw redirect({ href: canonical, statusCode: 301 });
    }
    return page;
  },
  // Title/description formulas, cover-led social card, canonical link, and
  // BreadcrumbList + BookSeries JSON-LD (spec §11, ticket #39).
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { series, volumes, coverUrl } = loaderData;
    const path = seriesPath(series.publicId, series.title);
    const volumeCount =
      volumes.length === 1 ? "1 volume" : `${volumes.length} volumes`;
    return {
      ...pageHead({
        title: seriesTitleTag(series.title),
        description: `English releases of ${series.title}: ${volumeCount} in the canonical reading order, with every edition, format, and release date.`,
        path,
        image: coverUrl,
      }),
      scripts: [
        jsonLdScript(
          breadcrumbListJsonLd([
            { name: "MangaDB", path: "/" },
            { name: series.title },
          ]),
        ),
        jsonLdScript(
          bookSeriesJsonLd({
            title: series.title,
            altTitles: series.altTitles,
            path,
          }),
        ),
      ],
    };
  },
  component: SeriesPage,
  notFoundComponent: SeriesNotFound,
});

function SeriesNotFound() {
  return (
    <main className="series-page">
      <h1 className="series-title">Series not found</h1>
      <p className="notice">
        No series lives at this address. <Link to="/">Browse the catalog</Link>.
      </p>
    </main>
  );
}

const SOURCE_STATUS_LABELS = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "On hiatus",
  cancelled: "Cancelled",
} as const;

const RELATIONSHIP_LABELS = {
  sequel: "a sequel of",
  prequel: "a prequel of",
  spinoff: "a spinoff of",
  reboot: "a reboot of",
  sideStory: "a side story of",
  other: "related to",
} as const;

type Volume = SeriesPageData["volumes"][number];
type EditionGroup = SeriesPageData["editionGroups"][number];
type Book = EditionGroup["books"][number];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** First and last known publication dates across some books, as a span. */
function dateSpan(books: ReadonlyArray<Book>): string | null {
  let first: Book["releases"][number]["pubDate"] = null;
  let last: Book["releases"][number]["pubDate"] = null;
  for (const release of books.flatMap((book) => book.releases)) {
    const date = release.pubDate;
    if (!date) continue;
    if (!first || date.sort < first.sort) first = date;
    if (!last || date.sort > last.sort) last = date;
  }
  const from = formatPartialDate(first);
  const to = formatPartialDate(last);
  return from === null ? null : from === to ? from : `${from} – ${to}`;
}

/**
 * The packaging facts the hero states, rolled up from the reading paths:
 * how many books and Releases, which Publishers, and the dated span.
 */
function packagingFacts(groups: ReadonlyArray<EditionGroup>) {
  const books = groups.flatMap((group) => group.books);
  const publishers = new Map<string, string>();
  for (const book of books) {
    if (book.publisher) publishers.set(book.publisher.slug, book.publisher.name);
  }
  return {
    editionCount: books.length,
    releaseCount: books.reduce((n, book) => n + book.releases.length, 0),
    publishers: [...publishers].map(([slug, name]) => ({ slug, name })),
    dateSpan: dateSpan(books),
  };
}

function seriesLinkParams(publicId: number, title: string) {
  const canonical = seriesPath(publicId, title);
  const slug = canonical.split("/").pop() ?? "";
  return { publicId: String(publicId), slug };
}

/** "Vol. 3", "Vol. 1–3", or null for a book with no mapped Volumes. */
function coveredText(book: Book): string | null {
  const first = book.coverage[0];
  const last = book.coverage[book.coverage.length - 1];
  if (!first || !last) return null;
  const name = (cov: Book["coverage"][number]) => cov.label ?? `#${cov.position}`;
  const partial = book.coverage.some((cov) => cov.extent === "partial") ? " (part)" : "";
  return first === last
    ? `Vol. ${name(first)}${partial}`
    : `Vol. ${name(first)}–${name(last)}${partial}`;
}

/** What a book is called within its path: its line number, else its Volumes. */
function bookLabel(book: Book): string {
  if (book.lineName !== null) {
    return book.linePosition !== null
      ? `${book.lineName} ${book.linePosition}`
      : book.lineName;
  }
  return coveredText(book) ?? "Unnumbered";
}

function bookTitle(seriesTitle: string, book: Book): string {
  return editionTitle({
    seriesTitle,
    lineName: book.lineName,
    linePosition: book.linePosition,
    covered: book.coverage,
  });
}

/**
 * One slot of a reading path: a book, or — in a standard path — a canonical
 * Volume this run has no book for (not on file, or never published by this
 * publisher), so gaps read as gaps instead of silently closing up.
 */
type Slot =
  | { kind: "book"; book: Book }
  | { kind: "missing"; volume: Volume };

/**
 * A standard path walks the canonical sequence up to its last covered
 * Volume, placing each book at its first Volume and a gap marker wherever no
 * book covers one. Line paths are simply their books in line order.
 */
function pathSlots(group: EditionGroup, volumes: ReadonlyArray<Volume>): Slot[] {
  if (group.kind === "line") {
    return group.books.map((book) => ({ kind: "book", book }));
  }
  const byFirstVolume = new Map<number, Book[]>();
  const covered = new Set<number>();
  const unplaced: Book[] = [];
  for (const book of group.books) {
    const first = book.coverage[0];
    if (!first) {
      unplaced.push(book);
      continue;
    }
    byFirstVolume.set(first.volumePublicId, [
      ...(byFirstVolume.get(first.volumePublicId) ?? []),
      book,
    ]);
    for (const cov of book.coverage) covered.add(cov.volumePublicId);
  }
  const lastPosition = Math.max(
    -Infinity,
    ...group.books.flatMap((book) => book.coverage.map((cov) => cov.position)),
  );
  const slots: Slot[] = [];
  for (const volume of volumes) {
    if (volume.position > lastPosition) break;
    const books = byFirstVolume.get(volume.publicId);
    if (books) for (const book of books) slots.push({ kind: "book", book });
    else if (!covered.has(volume.publicId)) slots.push({ kind: "missing", volume });
  }
  return [...slots, ...unplaced.map((book): Slot => ({ kind: "book", book }))];
}

function SeriesPage() {
  const page = Route.useLoaderData();
  const { edition: editionKey } = Route.useSearch();
  const { series, family, volumes, editionGroups, coverUrl } = page;
  const facts = packagingFacts(editionGroups);
  // The first path's first book fronts the Series — the standard run leads,
  // so this is its Volume 1 whenever one is on file.
  const frontBook = editionGroups[0]?.books[0] ?? null;
  const heroIsbn = frontBook ? firstIsbn([frontBook]) : null;
  // One path needs no picker; with several, the reader picks one.
  const selected =
    editionGroups.length === 1
      ? editionGroups[0]
      : editionGroups.find((group) => group.key === editionKey);

  return (
    <main className="series-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <Link to="/series">Series</Link>
      </nav>

      <section className="series-hero">
        <div className="series-hero-aside">
          <div className="series-cover">
            {/* The front book's jacket; coverless Series get the cloth
                binding rather than a broken image. */}
            <Cover src={coverUrl} isbn13={heroIsbn} title={series.title} lazy={false} />
          </div>
          {facts.dateSpan ? (
            <p className="note">English releases on file: {facts.dateSpan}.</p>
          ) : null}
        </div>

        <div className="series-hero-body">
          <h1 className="series-title">{series.title}</h1>
          <div className="chips">
            {series.sourceStatus ? (
              <span className="chip" title="Status of the original publication">
                {SOURCE_STATUS_LABELS[series.sourceStatus]}
              </span>
            ) : null}
            <span className="chip">
              {plural(volumes.length, "volume", "volumes")}
            </span>
            {editionGroups.length > 1 ? (
              <span className="chip">
                {plural(editionGroups.length, "edition", "editions")}
              </span>
            ) : null}
          </div>

          {series.synopsis ? (
            <p className="series-synopsis">{series.synopsis}</p>
          ) : null}

          <dl className="facts">
            {series.sourceStatus ? (
              <div>
                <dt className="fact-term">Source status</dt>
                <dd className="fact-def">
                  {SOURCE_STATUS_LABELS[series.sourceStatus]} in Japanese
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="fact-term">Volumes</dt>
              <dd className="fact-def">
                {volumes.length} in the canonical sequence
              </dd>
            </div>
            {facts.editionCount > 0 ? (
              <div>
                <dt className="fact-term">English packaging</dt>
                <dd className="fact-def">
                  {plural(facts.editionCount, "book", "books")},{" "}
                  {plural(facts.releaseCount, "release", "releases")}
                </dd>
              </div>
            ) : null}
            {facts.publishers.length > 0 ? (
              <div>
                <dt className="fact-term">Publishers</dt>
                <dd className="fact-def">
                  {facts.publishers.map((publisher, i) => (
                    <span key={publisher.slug}>
                      {i > 0 ? ", " : ""}
                      <Link
                        to="/publisher/$slug"
                        params={{ slug: publisher.slug }}
                      >
                        {publisher.name}
                      </Link>
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {family ? (
              <div>
                <dt className="fact-term">Series family</dt>
                <dd className="fact-def">
                  {family.name}
                  {/* The siblings, linked from the hero; the shelf further
                      down shows them as books with their relationships. */}
                  <span className="fact-sub">
                    {family.members
                      .filter((member) => member.publicId !== series.publicId)
                      .map((member, i) => (
                        <span key={member.publicId}>
                          {i > 0 ? ", " : ""}
                          <Link
                            to="/series/$publicId/$slug"
                            params={seriesLinkParams(
                              member.publicId,
                              member.title,
                            )}
                          >
                            {member.title}
                          </Link>
                        </span>
                      ))}
                  </span>
                </dd>
              </div>
            ) : null}
            {series.altTitles.length > 0 ? (
              <div>
                <dt className="fact-term">Also known as</dt>
                <dd className="fact-def">{series.altTitles.join(", ")}</dd>
              </div>
            ) : null}
          </dl>

          {/* The signed-in tracking bar. Every control inside renders null
              signed out, which leaves the bar empty — CSS hides it then, so
              the public page keeps the hero clean. */}
          <div className="owner-bar">
            {/* Series Follow is the explicit toggle for future-release
                interest (#29); always private in v1. */}
            <SeriesFollowControls seriesPublicId={series.publicId} />
            {/* Series Reading Status is set only here, by explicit choice
                (#28); the tracking prompts never change it without
                confirmation. */}
            <SeriesReadingControls seriesPublicId={series.publicId} />
            {/* Per-Series visibility overrides for the public profile (#30). */}
            <SeriesVisibilityControls seriesPublicId={series.publicId} />
            <SeriesReadingProgress
              seriesPublicId={series.publicId}
              volumeCount={volumes.length}
            />
          </div>
        </div>
      </section>

      {editionGroups.length > 1 ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Editions</h2>
            <p className="section-note">
              Each edition is its own run of books. Pick one to see its
              reading path.
            </p>
          </div>
          <EditionPicker
            groups={editionGroups}
            selectedKey={selected?.key ?? null}
            series={series}
          />
        </section>
      ) : null}

      {selected ? (
        <section className="section reading-path">
          <div className="section-head">
            <h2 className="section-title">
              {editionGroups.length > 1 ? selected.name : "Reading path"}
            </h2>
            <p className="section-note">
              {selected.publisher ? `${selected.publisher.name} · ` : ""}
              {plural(selected.books.length, "book", "books")}
              {selected.kind === "line"
                ? " in the publisher's own numbering"
                : " in reading order"}
            </p>
          </div>
          <div className="shelf">
            {pathSlots(selected, volumes).map((slot) =>
              slot.kind === "book" ? (
                <BookShelfItem
                  key={slot.book.publicId}
                  book={slot.book}
                  seriesTitle={series.title}
                  seriesPublicId={series.publicId}
                  showCoverage={selected.kind === "line"}
                />
              ) : (
                <MissingVolume
                  key={`missing-${slot.volume.publicId}`}
                  volume={slot.volume}
                  seriesTitle={series.title}
                />
              ),
            )}
          </div>
        </section>
      ) : null}

      {editionGroups.length === 0 ? (
        <section className="section reading-path">
          <div className="section-head">
            <h2 className="section-title">Volumes</h2>
            <p className="section-note">
              No English edition is on file for this series yet.
            </p>
          </div>
          {volumes.length === 0 ? (
            <p className="notice">No volumes are recorded for this series yet.</p>
          ) : (
            <div className="shelf">
              {volumes.map((volume) => (
                <MissingVolume
                  key={volume.publicId}
                  volume={volume}
                  seriesTitle={series.title}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {family ? <FamilySection family={family} self={series} /> : null}

      {/* Partially imported Series show as-is; every Series page carries the
          report affordance feeding the proposal queue (#40, spec §7). */}
      <SeriesReportAffordance seriesPublicId={series.publicId} />

      {/* Public revision history + the data-team entry points (#31/#32). */}
      <RecordHistory type="series" publicId={series.publicId} />
      <ModEditLink type="series" editKey={String(series.publicId)} />
      <ProposeNewRecordsLink seriesPublicId={series.publicId} />
    </main>
  );
}

/**
 * The edition picker: each path's first book as its cover, then the path's
 * name, publisher and extent. Selection lives in the URL (`?edition=`), so a
 * path is shareable and the picker works before hydration.
 */
function EditionPicker({
  groups,
  selectedKey,
  series,
}: {
  groups: ReadonlyArray<EditionGroup>;
  selectedKey: string | null;
  series: SeriesPageData["series"];
}) {
  return (
    <nav className="edition-picker" aria-label="Editions">
      {groups.map((group) => {
        const first = group.books[0];
        const span = dateSpan(group.books);
        const isSelected = group.key === selectedKey;
        return (
          <Link
            key={group.key}
            className={isSelected ? "edition-card is-selected" : "edition-card"}
            to="/series/$publicId/$slug"
            params={seriesLinkParams(series.publicId, series.title)}
            search={{ edition: group.key }}
            // Switching editions keeps the reader where they are.
            resetScroll={false}
            aria-current={isSelected ? "true" : undefined}
          >
            <span className="edition-card-cover">
              {first ? (
                <Cover
                  src={first.coverUrl}
                  isbn13={firstIsbn([first])}
                  title={bookTitle(series.title, first)}
                  foot={[bookLabel(first), group.publisher?.name]}
                />
              ) : null}
            </span>
            <span className="edition-card-body">
              <span className="edition-card-name">{group.name}</span>
              {group.publisher ? (
                <span className="edition-card-meta">{group.publisher.name}</span>
              ) : null}
              <span className="edition-card-meta">
                {plural(group.books.length, "book", "books")}
                {span ? ` · ${span}` : ""}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * One book on a reading path, linking its Edition page (the book detail page,
 * where its Releases and the collection controls live). The cloth carries the
 * book's own number: its line position in a line, its Volume label otherwise.
 */
function BookShelfItem({
  book,
  seriesTitle,
  seriesPublicId,
  showCoverage,
}: {
  book: Book;
  seriesTitle: string;
  seriesPublicId: number;
  showCoverage: boolean;
}) {
  const title = bookTitle(seriesTitle, book);
  const number = book.lineName !== null ? book.linePosition : (book.coverage[0]?.label ?? null);
  const date = formatPartialDate(book.releases[0]?.pubDate ?? null);
  const formats = [...new Set(book.releases.map((r) => r.format))];
  const covered = showCoverage ? coveredText(book) : null;
  return (
    <div className="shelf-item">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={slugParams(book.publicId, title)}
          aria-label={title}
        >
          <Cover
            src={book.coverUrl}
            isbn13={firstIsbn([book])}
            title={title}
            numbered={number !== null ? { series: seriesTitle, number } : undefined}
          />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/edition/$publicId/$slug"
          params={slugParams(book.publicId, title)}
        >
          {bookLabel(book)}
        </Link>
        <div className="caption-meta">
          {covered ? (
            <>
              <span>{covered}</span>
              <span className="dot" />
            </>
          ) : null}
          <span>{date ?? "Date TBA"}</span>
          {/* Line books already carry their Volume range; formats would
              overflow the caption. */}
          {!showCoverage && formats.length > 0 ? (
            <>
              <span className="dot" />
              <span>
                {formats.map((f) => (f === "physical" ? "Print" : "Digital")).join(" + ")}
              </span>
            </>
          ) : null}
        </div>
        {/* Durable, edition-independent read count (#28) for a one-volume
            book; signed-in only. */}
        {book.coverage.length === 1 && book.coverage[0] ? (
          <VolumeReadCount
            seriesPublicId={seriesPublicId}
            volumePublicId={book.coverage[0].volumePublicId}
          />
        ) : null}
      </div>
    </div>
  );
}

/** A canonical Volume with no book in this path, linking its Volume page. */
function MissingVolume({
  volume,
  seriesTitle,
}: {
  volume: Volume;
  seriesTitle: string;
}) {
  const title = volumeTitle(seriesTitle, volume.label);
  return (
    <div className="shelf-item shelf-item--missing">
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/volume/$publicId/$slug"
          params={slugParams(volume.publicId, title)}
          aria-label={title}
        >
          <Cover
            title={title}
            numbered={
              volume.label !== null
                ? { series: seriesTitle, number: volume.label }
                : undefined
            }
          />
        </Link>
      </div>
      <div className="caption">
        <Link
          className="caption-title"
          to="/volume/$publicId/$slug"
          params={slugParams(volume.publicId, title)}
        >
          {volume.label !== null ? `Vol. ${volume.label}` : "Unnumbered"}
        </Link>
        <div className="caption-meta">
          <span>Not on file</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The Series Family shelf: sibling Series stand next to this one, each
 * keeping its own Volume sequence. The typed relationships are spelled out
 * underneath as sentences — the edge is stored once, whichever end this
 * Series is.
 */
function FamilySection({
  family,
  self,
}: {
  family: NonNullable<SeriesPageData["family"]>;
  self: SeriesPageData["series"];
}) {
  return (
    <section className="section series-family">
      <div className="section-head">
        <h2 className="section-title">{family.name} series family</h2>
        <p className="section-note">
          Related series share this shelf and keep their own volume sequences.
        </p>
      </div>
      <div className="shelf">
        {family.members.map((member) => {
          const isSelf = member.publicId === self.publicId;
          return (
            <div className="shelf-item" key={member.publicId}>
              <div className="cover-wrap">
                {isSelf ? (
                  <Cover title={member.title} />
                ) : (
                  <Link
                    className="cover-link"
                    to="/series/$publicId/$slug"
                    params={seriesLinkParams(member.publicId, member.title)}
                    aria-label={member.title}
                  >
                    <Cover title={member.title} />
                  </Link>
                )}
              </div>
              <div className="caption">
                {isSelf ? (
                  <span className="caption-title" aria-current="page">
                    {member.title}
                  </span>
                ) : (
                  <Link
                    className="caption-title"
                    to="/series/$publicId/$slug"
                    params={seriesLinkParams(member.publicId, member.title)}
                  >
                    {member.title}
                  </Link>
                )}
                <div className="caption-meta">
                  {isSelf ? <span>You are here</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {family.relationships.length > 0 ? (
        <ul className="family-relationships">
          {family.relationships.map((rel, i) => (
            <li key={i}>
              {rel.from.title} is {RELATIONSHIP_LABELS[rel.type]} {rel.to.title}
              {rel.note ? ` — ${rel.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
