import { describe, expect, test } from "vitest";

import {
  coverShelf,
  hasJacket,
  heroBooks,
  heroPool,
  jacketed,
  oneCoverPer,
  shelfDays,
} from "./homeShelves";

const ART = "https://files.example/art.jpg";
/** A book by its id: publisher art, an ISBN to try, or neither. */
const book = (id: number, art: "url" | "isbn" | "none", sort = 20261006) => ({
  id,
  coverUrl: art === "url" ? ART : null,
  coverIsbn: art === "isbn" ? `97800000000${String(id).padStart(2, "0")}` : null,
  day: sort % 100 === 0 ? null : sort % 100,
  sort,
  series: [{ publicId: id }],
  edition: { publicId: id },
});
const isbnOf = (id: number) => book(id, "isbn").coverIsbn!;
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
