// A Series' reading path as a shelf of covers — the Series page's wall of
// books, reused by the library when a path is opened to mark more of it.
// Shared here so the two agree on labels, gaps and the signed-in overlay:
// every book wears its collection/read badges and reveals the quick actions
// on hover (lib/quickActions.tsx); signed out, the shelf is just covers.

import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import type { api } from "../../convex/_generated/api";
import { editionTitle, volumeTitle } from "../../convex/lib/titles";
import { Cover, coverIsbns } from "~/lib/cover";
import { formatPartialDate } from "~/lib/format";
import {
  bookBadges,
  BookQuickActions,
  NO_PROMPTS,
  quickBookFor,
  RunActions,
  ShelfPrompts,
  type SeriesOverlay,
  type ShelfPromptState,
  useSeriesOverlay,
} from "~/lib/quickActions";
import { slugParams } from "~/lib/slug";

/** The Series page query's result; the SSR loader returns the same shape. */
type SeriesPage = NonNullable<FunctionReturnType<typeof api.catalog.seriesPage>>;
export type Volume = SeriesPage["volumes"][number];
export type EditionGroup = SeriesPage["editionGroups"][number];
export type Book = EditionGroup["books"][number];

/** First and last known publication dates across some books, as a span. */
export function dateSpan(books: ReadonlyArray<Book>): string | null {
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

/** "Vol. 3", "Vol. 1–3", or null for a book with no mapped Volumes. */
function coveredText(
  coverage: ReadonlyArray<{ position: number; label: string | null; extent: string }>,
): string | null {
  const first = coverage[0];
  const last = coverage[coverage.length - 1];
  if (!first || !last) return null;
  const name = (cov: { position: number; label: string | null }) => cov.label ?? `#${cov.position}`;
  const partial = coverage.some((cov) => cov.extent === "partial") ? " (part)" : "";
  return first === last
    ? `Vol. ${name(first)}${partial}`
    : `Vol. ${name(first)}–${name(last)}${partial}`;
}

/** What a book is called within its path: its line number, else its Volumes. */
export function bookLabel(book: {
  lineName: string | null;
  linePosition: string | null;
  coverage: Book["coverage"];
}): string {
  if (book.lineName !== null) {
    return book.linePosition !== null ? `${book.lineName} ${book.linePosition}` : book.lineName;
  }
  return coveredText(book.coverage) ?? "Unnumbered";
}

export function bookTitle(seriesTitle: string, book: Book): string {
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
type Slot = { kind: "book"; book: Book } | { kind: "missing"; volume: Volume };

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

type PathShelfProps = {
  group: EditionGroup;
  volumes: ReadonlyArray<Volume>;
  seriesTitle: string;
  seriesPublicId: number;
  /** Fade books the viewer has no entry for (the library's "add more" view). */
  dimUnmarked?: boolean;
};

/**
 * A reading path on a shelf, with the signed-in overlay when there is a
 * viewer: the whole-run buttons above (Want / Order / Own / Read all),
 * the quick actions on every cover, and the prompt area collecting what
 * they raise — a first-entry follow suggestion, a fully-read Series.
 */
export function PathShelf(props: PathShelfProps) {
  const overlay = useSeriesOverlay(props.seriesPublicId);
  return <PathShelfView {...props} overlay={overlay} />;
}

function PathShelfView({
  group,
  volumes,
  seriesTitle,
  dimUnmarked = false,
  overlay,
}: PathShelfProps & { overlay: SeriesOverlay | null }) {
  const [prompts, setPrompts] = useState<ShelfPromptState>(NO_PROMPTS);
  const raise = (next: Partial<ShelfPromptState>) => setPrompts((prev) => ({ ...prev, ...next }));
  return (
    <>
      {overlay ? (
        <div className="shelf-toolbar">
          <RunActions books={group.books} overlay={overlay} onPrompt={raise} />
        </div>
      ) : null}
      <ShelfPrompts prompts={prompts} onChange={setPrompts} />
      <div className="shelf">
        {pathSlots(group, volumes).map((slot) =>
          slot.kind === "book" ? (
            <BookShelfItem
              key={slot.book.publicId}
              book={slot.book}
              seriesTitle={seriesTitle}
              showCoverage={group.kind === "line"}
              overlay={overlay}
              dimUnmarked={dimUnmarked}
              onPrompt={raise}
            />
          ) : (
            <MissingVolume
              key={`missing-${slot.volume.publicId}`}
              volume={slot.volume}
              seriesTitle={seriesTitle}
            />
          ),
        )}
      </div>
    </>
  );
}

/**
 * One book on a reading path, linking its Edition page (the book detail
 * page, where its Releases and Variants live). The cloth carries the book's
 * own number: its line position in a line, its Volume label otherwise. With
 * the overlay it wears its badges and offers the quick actions on hover.
 */
function BookShelfItem({
  book,
  seriesTitle,
  showCoverage,
  overlay,
  dimUnmarked,
  onPrompt,
}: {
  book: Book;
  seriesTitle: string;
  showCoverage: boolean;
  overlay: SeriesOverlay | null;
  dimUnmarked: boolean;
  onPrompt: (prompts: Partial<ShelfPromptState>) => void;
}) {
  const title = bookTitle(seriesTitle, book);
  const number = book.lineName !== null ? book.linePosition : (book.coverage[0]?.label ?? null);
  const date = formatPartialDate(book.releases[0]?.pubDate ?? null);
  const formats = [...new Set(book.releases.map((r) => r.format))];
  const covered = showCoverage ? coveredText(book.coverage) : null;
  const quick = overlay ? quickBookFor(book, overlay) : null;
  const unmarked = quick !== null && quick.state === null && !quick.derivedOwned;
  return (
    <div className={dimUnmarked && unmarked ? "shelf-item shelf-item--dim" : "shelf-item"}>
      <div className="cover-wrap">
        <Link
          className="cover-link"
          to="/edition/$publicId/$slug"
          params={slugParams(book.publicId, title)}
          aria-label={title}
        >
          <Cover
            src={book.coverUrl}
            isbn13={coverIsbns([book])}
            title={title}
            numbered={number !== null ? { series: seriesTitle, number } : undefined}
            badges={quick ? bookBadges(quick) : undefined}
          />
        </Link>
        {quick ? <BookQuickActions book={quick} onPrompt={onPrompt} /> : null}
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
      </div>
    </div>
  );
}

/** A canonical Volume with no book in this path, linking its Volume page. */
export function MissingVolume({ volume, seriesTitle }: { volume: Volume; seriesTitle: string }) {
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
              volume.label !== null ? { series: seriesTitle, number: volume.label } : undefined
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
