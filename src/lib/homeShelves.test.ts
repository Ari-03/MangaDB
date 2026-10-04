import { describe, expect, test } from "vitest";

import {
  coverShelf,
  hasJacket,
  heroBooks,
  heroPool,
  homePools,
  homeQuestions,
  homeShelves,
  jacketed,
  oneCoverPer,
  shelfDays,
} from "./homeShelves";

const ART = "https://files.example/art.jpg";
const isbnOf = (id: number) => `97800000000${String(id).padStart(2, "0")}`;
/** A book by its id: publisher art, an ISBN to try, or neither. */
const book = (id: number, art: "url" | "isbn" | "none", sort = 20261006) => ({
  id,
  coverUrl: art === "url" ? ART : null,
  coverIsbns: art === "isbn" ? [isbnOf(id)] : [],
  day: sort % 100 === 0 ? null : sort % 100,
  sort,
  series: [{ publicId: id }],
  edition: { publicId: id },
});
/** A book with a second ISBN to try after its first (an ebook twin). */
const twin = (id: number) => ({ ...book(id, "isbn"), coverIsbns: [isbnOf(id), isbnOf(id + 50)] });
const ids = (books: ReadonlyArray<{ id: number }>) => books.map((entry) => entry.id);

describe("hasJacket", () => {
  test("publisher art always counts; an ISBN only when its jacket is on file", () => {
    const onFile = new Set([isbnOf(2)]);
    expect(hasJacket(book(1, "url"), onFile)).toBe(true);
    expect(hasJacket(book(2, "isbn"), onFile)).toBe(true);
    expect(hasJacket(book(3, "isbn"), onFile)).toBe(false);
    expect(hasJacket(book(4, "none"), onFile)).toBe(false);
  });

  test("an unanswered check trusts an ISBN, but never a book with no art to try", () => {
    expect(hasJacket(book(3, "isbn"), null)).toBe(true);
    expect(hasJacket(book(4, "none"), null)).toBe(false);
  });

  test("judges a book by its first candidate only", () => {
    expect(hasJacket(twin(1), new Set([isbnOf(1)]))).toBe(true);
    expect(hasJacket(twin(1), new Set([isbnOf(51)]))).toBe(false);
  });
});

describe("jacketed", () => {
  test("seats the first jacketed books in shelf order, skipping cloth", () => {
    const shelf = [book(1, "isbn"), book(2, "none"), book(3, "url"), book(4, "isbn"), book(5, "isbn")];
    const onFile = new Set([isbnOf(4), isbnOf(5)]);
    expect(ids(jacketed(shelf, onFile, 2))).toEqual([3, 4]);
    expect(ids(jacketed(shelf, onFile, 10))).toEqual([3, 4, 5]);
  });
});

describe("coverShelf", () => {
  test("asks about ISBNs, marks publisher art null, and leaves out cloth", () => {
    const shelf = [book(1, "isbn"), book(2, "none"), book(3, "url")];
    expect(coverShelf(shelf, 2)).toEqual({ need: 2, candidates: [isbnOf(1), null] });
  });

  test("asks about each book's first candidate", () => {
    expect(coverShelf([twin(1), book(2, "isbn")], 1).candidates).toEqual([isbnOf(1), isbnOf(2)]);
  });

  test("caps the candidates at four per seat", () => {
    const shelf = Array.from({ length: 20 }, (_, index) => book(index, "isbn"));
    expect(coverShelf(shelf, 2).candidates).toHaveLength(8);
  });
});

describe("oneCoverPer", () => {
  test("keeps one book per key, preferring a sibling with art to try", () => {
    const paper = { ...book(1, "none"), edition: { publicId: 7 } };
    const digital = { ...book(2, "isbn"), edition: { publicId: 7 } };
    const other = { ...book(3, "isbn"), edition: { publicId: 8 } };
    expect(ids(oneCoverPer([paper, digital, other], (entry) => entry.edition.publicId))).toEqual([
      2, 3,
    ]);
  });
});

describe("shelfDays", () => {
  const month = [
    book(1, "isbn", 20261001),
    book(2, "isbn", 20261006),
    book(3, "isbn", 20261006),
    book(4, "isbn", 20261013),
    book(5, "isbn", 20261000),
  ];

  test("leads with the nearest day ahead, then the day after it", () => {
    const { primary, secondary, undated } = shelfDays(month, 20261003);
    expect(primary?.day).toBe(6);
    expect(ids(primary?.releases ?? [])).toEqual([2, 3]);
    expect(secondary?.day).toBe(13);
    expect(ids(undated)).toEqual([5]);
  });

  test("falls back to the month's last day once it has shipped", () => {
    const { primary, secondary } = shelfDays(month, 20261020);
    expect(primary?.day).toBe(13);
    expect(secondary).toBeNull();
  });
});

describe("the hero wall", () => {
  const TODAY = 20261003;
  const SHELF_DAY = 20261006;
  const month = [
    book(1, "isbn", 20261001), // already out
    book(2, "isbn", SHELF_DAY),
    book(3, "isbn", 20261013),
    book(4, "isbn", 20261020),
    book(5, "isbn", 20261000), // day to be announced
  ];

  test("puts the shelf day's books last and drops past and undated ones", () => {
    expect(ids(heroPool(month, TODAY, SHELF_DAY))).toEqual([3, 4, 2]);
  });

  test("seats only jacketed books, soonest first", () => {
    const pool = heroPool(month, TODAY, SHELF_DAY);
    // Book 3 has no jacket on file: the shelf day's book fills in, in date order.
    const onFile = new Set([isbnOf(2), isbnOf(4)]);
    expect(ids(heroBooks(pool, onFile, 2))).toEqual([2, 4]);
    // With enough jacketed books after the shelf day, it is not repeated.
    expect(ids(heroBooks(pool, new Set([isbnOf(2), isbnOf(3), isbnOf(4)]), 2))).toEqual([3, 4]);
  });
});

describe("the home page's shelves", () => {
  const TODAY = 20261003;
  /** A Series row as recentSeries returns it. */
  const series = (id: number, art: "url" | "isbn" | "none") => {
    const { coverUrl, coverIsbns } = book(id, art);
    return { publicId: id, title: `Series ${id}`, coverUrl, coverIsbns, createdAt: 0 };
  };
  const month = [
    book(1, "isbn", 20261001), // already out
    book(2, "isbn", 20261006),
    book(3, "none", 20261006),
    book(4, "isbn", 20261006),
    book(5, "isbn", 20261013),
    book(6, "none", 20261020),
    book(7, "isbn", 20261000), // day to be announced
  ];
  const next = [book(8, "isbn", 20261102), book(9, "isbn", 20261103)];
  const pools = homePools(month, next, TODAY);
  const fourSeries = [1, 2, 3, 4, 5].map((id) => series(id + 20, "isbn"));

  test("asks the cover store about the hero, both day shelves and the Series, in that order", () => {
    const [hero, primary, secondary, shelf] = homeQuestions(pools, fourSeries);
    expect(hero).toEqual({ need: 15, candidates: [isbnOf(5), isbnOf(8), isbnOf(9), isbnOf(2), isbnOf(4)] });
    expect(primary).toEqual({ need: 14, candidates: [isbnOf(2), isbnOf(4)] });
    expect(secondary).toEqual({ need: 7, candidates: [isbnOf(5)] });
    expect(shelf?.candidates).toHaveLength(5);
  });

  test("seats only books on file, counting every book the day has", () => {
    const onFile = new Set([isbnOf(4), isbnOf(9), ...[21, 22, 23, 24].map(isbnOf)]);
    const shelves = homeShelves(pools, fourSeries, onFile);
    expect(ids(shelves.hero)).toEqual([4, 9]);
    expect(shelves.primary).toMatchObject({ day: 6, count: 3 });
    expect(ids(shelves.primary?.books ?? [])).toEqual([4]);
    // The day after seats nothing on file, so it has no shelf at all.
    expect(shelves.secondary).toBeNull();
    // A dated day leads, so the day-TBA book is counted but never carried.
    expect(shelves.undated).toEqual({ count: 1, books: [] });
    expect(shelves.series.map((entry) => entry.publicId)).toEqual([21, 22, 23, 24]);
    expect(shelves.seriesLinks).toEqual([]);
  });

  test("with the check unanswered, seats every book with art to try", () => {
    const shelves = homeShelves(pools, fourSeries, null);
    expect(ids(shelves.primary?.books ?? [])).toEqual([2, 4]);
    expect(shelves.secondary).toMatchObject({ day: 13, count: 1 });
    expect(ids(shelves.secondary?.books ?? [])).toEqual([5]);
  });

  test("shelves day-TBA books once the month has no dated day left", () => {
    const undated = [book(1, "isbn", 20261000), book(2, "none", 20261000)];
    const shelves = homeShelves(homePools(undated, [], TODAY), [], null);
    expect(shelves.primary).toBeNull();
    expect(shelves.undated.count).toBe(2);
    expect(ids(shelves.undated.books)).toEqual([1]);
  });

  test("lists the newest Series by name when too few have jackets", () => {
    const rows = [series(1, "isbn"), series(2, "none"), series(3, "url")];
    const shelves = homeShelves(pools, rows, new Set([isbnOf(1)]));
    expect(shelves.series).toEqual([]);
    // Names only: the list carries no jacket data it would not show.
    expect(shelves.seriesLinks).toEqual([
      { publicId: 1, title: "Series 1" },
      { publicId: 2, title: "Series 2" },
      { publicId: 3, title: "Series 3" },
    ]);
  });
});
