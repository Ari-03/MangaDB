// Which books stand on the home page's shelves. The home page is a taste of
// the catalog, so it seats only books whose real jacket we hold: a book with
// no art (the cloth placeholder elsewhere) still has its place in the agenda,
// the calendar, and every catalog page, just not here.
//
// Convex knows which ISBNs a book's jacket would be fetched by, not whether
// art exists for them; the cover store does (server/covers.ts `coversOnFile`).
// The route loader asks it about each shelf's candidates (`homeQuestions`),
// then seats the books with the answer (`homeShelves`) and hands the page only
// those, never the two months they were picked from. A book is judged by its
// first ISBN, the one most likely to have art.

/** Covers standing on the hero's ledges: three short rows at most. */
export const HERO_ROWS = 3;
export const HERO_COLS = 5;
/** Home shelves are a taste of the month; the agenda holds the whole of it. */
const SHELF_LIMIT = 14;
const NEXT_SHELF_LIMIT = 7;
/** Two ledges of the newest Series in the catalog. */
const SERIES_SHELF_LIMIT = 14;
/** Below this a shelf of Series reads as a gap, so the link list serves. */
const SERIES_SHELF_MIN = 4;

/** What a shelf needs to know about a book's art (catalog rows carry both). */
export type Jacket = { coverUrl: string | null; coverIsbns: ReadonlyArray<string> };

/**
 * ISBNs that count as art: those whose jacket the cover store holds, plus
 * those it could not rule out in time (a failed read, or one not answered
 * within its budget), so only a jacket known to be absent keeps a book off.
 * Null when the store could not be asked at all (no bucket bound, or the
 * call failed); then every ISBN counts as art, as it does on every other
 * page.
 */
export type CoversOnFile = ReadonlySet<string> | null;

/**
 * One shelf's question for the cover store: its books in shelf order, each
 * the first ISBN its jacket would be fetched by, or null for a book that
 * already shows publisher art; and how many jacketed books the shelf seats.
 */
export type CoverShelf = { need: number; candidates: Array<string | null> };

/** Candidates asked about per seat: enough to fill a shelf past its misses. */
const CANDIDATES_PER_SEAT = 4;

/**
 * True when the book shows real art: publisher art, or a jacket on file for
 * its first candidate, the one most likely to have art.
 */
export function hasJacket(book: Jacket, onFile: CoversOnFile): boolean {
  if (book.coverUrl !== null) return true;
  const isbn = book.coverIsbns[0];
  if (isbn === undefined) return false;
  return onFile === null || onFile.has(isbn);
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
 * The question to ask the cover store for a shelf of `need` seats, about
 * each book's first candidate, the one most likely to have art. Books with
 * no art to try are left out, and the list is capped: a book past the cap
 * is never asked about, so it reads as jacketless and stays off.
 */
export function coverShelf(books: ReadonlyArray<Jacket>, need: number): CoverShelf {
  const candidates = books
    .filter((book) => book.coverUrl !== null || book.coverIsbns.length > 0)
    .slice(0, need * CANDIDATES_PER_SEAT)
    .map((book) => (book.coverUrl !== null ? null : (book.coverIsbns[0] ?? null)));
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
type DayGroup<Book> = { day: number; sort: number; releases: Array<Book> };

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

/**
 * Every home shelf's candidates in shelf order, before the jacket check: the
 * month's books by day, and the hero wall's pool, which reaches into next
 * month.
 */
export function homePools<Book extends HeroBook>(
  releases: ReadonlyArray<Book>,
  nextReleases: ReadonlyArray<Book>,
  todaySort: number,
) {
  // A book's physical and digital Releases are one cover on a shelf.
  const monthBooks = oneCoverPer(releases, (book) => book.edition.publicId);
  const hero = heroPool(
    [...monthBooks, ...oneCoverPer(nextReleases, (book) => book.edition.publicId)],
    todaySort,
    // The day the shelf below leads with (see shelfDays).
    monthBooks.find((book) => book.day !== null && book.sort >= todaySort)?.sort ?? null,
  );
  return { days: shelfDays(monthBooks, todaySort), hero };
}

type HomePools<Book> = { days: ReturnType<typeof shelfDays<Book & Dated>>; hero: Array<Book> };
type ShelfSeries = Jacket & { publicId: number; title: string };

/** The cover store's questions for the home page: the hero wall, the two day shelves, the Series shelf. */
export function homeQuestions(
  { days: { primary, secondary, undated }, hero }: HomePools<Jacket>,
  series: ReadonlyArray<Jacket>,
): Array<CoverShelf> {
  return [
    coverShelf(hero, HERO_ROWS * HERO_COLS),
    coverShelf(primary ? primary.releases : undated, SHELF_LIMIT),
    coverShelf(secondary?.releases ?? [], NEXT_SHELF_LIMIT),
    coverShelf(series, SERIES_SHELF_LIMIT),
  ];
}

/** A day shelf as the page shows it: the day, every book that day, and the ones seated. */
export type DayShelf<Book> = { day: number; count: number; books: Array<Book> };

/**
 * What the home page shows, once the cover store has answered: the hero
 * wall; the nearest publication day and the day after it (the second only
 * when it seats a book); the day-to-be-announced books, shelved only when
 * the month has no dated day left; and the newest Series, as a shelf of
 * jackets or, with too few of those, as a list of names.
 */
export function homeShelves<Book extends HeroBook, Series extends ShelfSeries>(
  { days: { primary, secondary, undated }, hero }: HomePools<Book>,
  series: ReadonlyArray<Series>,
  onFile: CoversOnFile,
) {
  const seat = (group: DayGroup<Book>, limit: number): DayShelf<Book> => ({
    day: group.day,
    count: group.releases.length,
    books: jacketed(group.releases, onFile, limit),
  });
  const next = secondary ? seat(secondary, NEXT_SHELF_LIMIT) : null;
  const shelfSeries = jacketed(series, onFile, SERIES_SHELF_LIMIT);
  const enoughSeries = shelfSeries.length >= SERIES_SHELF_MIN;
  return {
    hero: heroBooks(hero, onFile, HERO_ROWS * HERO_COLS),
    primary: primary ? seat(primary, SHELF_LIMIT) : null,
    secondary: next && next.books.length > 0 ? next : null,
    undated: {
      count: undated.length,
      books: primary ? [] : jacketed(undated, onFile, SHELF_LIMIT),
    },
    series: enoughSeries ? shelfSeries : [],
    seriesLinks: enoughSeries
      ? []
      : series.slice(0, SERIES_SHELF_LIMIT).map(({ publicId, title }) => ({ publicId, title })),
  };
}
