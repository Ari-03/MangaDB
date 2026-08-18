import { describe, expect, it } from "vitest";

import { isValidIsbn10, isValidIsbn13, normalizeIsbn } from "./isbn";

describe("isValidIsbn13", () => {
  it("accepts checksum-valid 978/979 ISBNs", () => {
    expect(isValidIsbn13("9781421580364")).toBe(true); // real: Tokyo Ghoul Vol 1
    expect(isValidIsbn13("9791234567896")).toBe(true); // 979 prefix, valid check
    expect(isValidIsbn13("9781999000103")).toBe(true); // dev-seed fake, valid check
  });

  it("rejects bad checksums, wrong prefixes, and wrong lengths", () => {
    expect(isValidIsbn13("9781421580365")).toBe(false); // check digit off by one
    // 13 digits, valid EAN checksum, but not Bookland — a numeric title/UPC-ish
    // query must fall through to text search, never the ISBN redirect.
    expect(isValidIsbn13("1234567890128")).toBe(false);
    expect(isValidIsbn13("978142158036")).toBe(false);
    expect(isValidIsbn13("97814215803641")).toBe(false);
  });
});

describe("isValidIsbn10", () => {
  it("accepts checksum-valid ISBN-10s, including an X check character", () => {
    expect(isValidIsbn10("1421580365")).toBe(true); // real: Tokyo Ghoul Vol 1
    expect(isValidIsbn10("097522980X")).toBe(true);
  });

  it("rejects bad checksums, X anywhere but last, and wrong lengths", () => {
    expect(isValidIsbn10("1421580366")).toBe(false);
    expect(isValidIsbn10("X97522980X")).toBe(false);
    expect(isValidIsbn10("142158036")).toBe(false);
    expect(isValidIsbn10("14215803650")).toBe(false);
  });
});

describe("normalizeIsbn", () => {
  it("strips separators and uppercases the check character", () => {
    expect(normalizeIsbn("978-1-4215-8036-4")).toBe("9781421580364");
    expect(normalizeIsbn(" 978 1 4215 8036 4 ")).toBe("9781421580364");
    expect(normalizeIsbn("0-9752298-0-x")).toBe("097522980X");
  });

  it("returns null for anything that is not a valid ISBN", () => {
    expect(normalizeIsbn("")).toBeNull();
    expect(normalizeIsbn("Tokyo Ghoul")).toBeNull();
    expect(normalizeIsbn("978-1-4215-8036-5")).toBeNull(); // bad checksum
    expect(normalizeIsbn("1234567890128")).toBeNull(); // 13 digits, not 978/979
  });
});
