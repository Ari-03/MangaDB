// Which books stand on the home page's shelves. The home page is a taste of
// the catalog, so it seats only books whose real jacket we hold: a book with
// no art (the cloth placeholder elsewhere) still has its place in the agenda,
// the calendar, and every catalog page, just not here.
//
// Convex knows which ISBN a book's jacket would be fetched by, not whether
// art exists for it; the cover store does (server/covers.ts `coversOnFile`).
// The route loader asks it about each shelf's candidates, and the same
// selection runs again in the component with the answer.

/** What a shelf needs to know about a book's art (catalog rows carry both). */
export type Jacket = { coverUrl: string | null; coverIsbn: string | null };

/**
 * ISBNs whose jacket the cover store holds, or null when it could not be
 * asked (no bucket bound) — then an ISBN counts as art, as it does on every
 * other page.
 */
export type CoversOnFile = ReadonlySet<string> | null;

/**
 * One shelf's question for the cover store: its books in shelf order, each
 * the ISBN its jacket would be fetched by, or null for a book that already
 * shows publisher art; and how many jacketed books the shelf seats.
 */
export type CoverShelf = { need: number; candidates: Array<string | null> };

/** Candidates asked about per seat: enough to fill a shelf past its misses. */
const CANDIDATES_PER_SEAT = 4;

/** True when the book shows real art: publisher art, or a jacket on file. */
export function hasJacket(book: Jacket, onFile: CoversOnFile): boolean {
  if (book.coverUrl !== null) return true;
  if (book.coverIsbn === null) return false;
  return onFile === null || onFile.has(book.coverIsbn);
}

/** The first `limit` books with a real jacket, in shelf order. */
export function jacketed<Book extends Jacket>(
  books: ReadonlyArray<Book>,
  onFile: CoversOnFile,
  limit: number,
): Array<Book> {
  const seated: Array<Book> = [];
  for (const book of books) {
    if (seated.length === limit) break;
    if (hasJacket(book, onFile)) seated.push(book);
  }
  return seated;
}

/**
 * The question to ask the cover store for a shelf of `need` seats. Books
 * with no art to try are left out, and the list is capped: a book past the
 * cap is never asked about, so it reads as jacketless and stays off.
 */
export function coverShelf(books: ReadonlyArray<Jacket>, need: number): CoverShelf {
  const candidates = books
    .filter((book) => book.coverUrl !== null || book.coverIsbn !== null)
    .slice(0, need * CANDIDATES_PER_SEAT)
    .map((book) => (book.coverUrl !== null ? null : book.coverIsbn));
  return { need, candidates };
}

/**
 * Keep the first book per key (date order is preserved), trading it for a
 * later sibling that has art to try when the first has none — so a shelf
 * never shows one book twice, and prefers the copy that can show a cover.
 */
export function oneCoverPer<Book extends Jacket>(
  books: ReadonlyArray<Book>,
  keyOf: (book: Book) => number,
): Array<Book> {
  const kept = new Map<number, Book>();
  for (const book of books) {
    const key = keyOf(book);
    const current = kept.get(key);
    if (!current) kept.set(key, book);
    else if (!hasJacket(current, null) && hasJacket(book, null)) kept.set(key, book);
  }
  // Map keeps first-insertion order, so a swapped-in sibling keeps its slot.
  return [...kept.values()];
}

type Dated = { day: number | null; sort: number };
export type DayGroup<Book> = { day: number; sort: number; releases: Array<Book> };

/**
 * The month window bucketed by publication day, chronological (the query
 * returns it date-sorted), with the two days the home shelves show: the
 * nearest day the month still has ahead of it (its last one once the month
 * has shipped), then the day after it. Month-precision books — day unknown,
 * sort yyyymm00 — belong to no day and are kept apart rather than heading
 * the shelf as if they shipped on the first.
 */
export function shelfDays<Book extends Dated>(books: ReadonlyArray<Book>, todaySort: number) {
  const dated: Array<DayGroup<Book>> = [];
  const undated: Array<Book> = [];
  for (const book of books) {
    if (book.day === null) {
      undated.push(book);
      continue;
    }
    const open = dated[dated.length - 1];
    if (open && open.day === book.day) open.releases.push(book);
    else dated.push({ day: book.day, sort: book.sort, releases: [book] });
  }
  const ahead = dated.findIndex((group) => group.sort >= todaySort);
  const primaryIndex = ahead === -1 ? dated.length - 1 : ahead;
  const primary = dated[primaryIndex] ?? null;
  const secondary = primary ? (dated[primaryIndex + 1] ?? null) : null;
  return { primary, secondary, undated };
}

type HeroBook = Jacket &
  Dated & { series: ReadonlyArray<{ publicId: number }>; edition: { publicId: number } };

/**
 * The hero wall's candidates, best first: the soonest books from today on,
 * one per Series, with the publication day the "on the shelf" row below
 * already shows moved to the back — so the two repeat each other only when
 * the days after it cannot fill the wall. Day-precision dates only: a "day
 * TBA" book has no place in a soonest-first line.
 */
export function heroPool<Book extends HeroBook>(
  books: ReadonlyArray<Book>,
  todaySort: number,
  shelfDay: number | null,
): Array<Book> {
  const upcoming = books.filter((book) => book.day !== null && book.sort >= todaySort);
  return oneCoverPer(
    [
      ...upcoming.filter((book) => book.sort !== shelfDay),
      ...upcoming.filter((book) => book.sort === shelfDay),
    ],
    (book) => book.series[0]?.publicId ?? book.edition.publicId,
  );
}

/** The hero wall: the pool's first `limit` jacketed books, soonest first. */
export function heroBooks<Book extends HeroBook>(
  pool: ReadonlyArray<Book>,
  onFile: CoversOnFile,
  limit: number,
): Array<Book> {
  return jacketed(pool, onFile, limit).sort((a, b) => a.sort - b.sort);
}
