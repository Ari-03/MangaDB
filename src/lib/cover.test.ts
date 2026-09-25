import { describe, expect, test } from "vitest";

import { coverIsbns } from "./cover";

describe("coverIsbns", () => {
  test("physical first, then digital, deduplicated and capped", () => {
    const isbns = coverIsbns([
      {
        releases: [
          { isbn13: "9780000000001", format: "digital" },
          { isbn13: null, format: "physical" },
          { isbn13: "9780000000002", format: "physical" },
        ],
      },
      {
        releases: [
          { isbn13: "9780000000002", format: "physical" },
          { isbn13: "9780000000003", format: "physical" },
          { isbn13: "9780000000004", format: "physical" },
        ],
      },
    ]);
    expect(isbns).toEqual(["9780000000002", "9780000000003", "9780000000004"]);
  });

  test("no ISBNs is an empty list (cloth)", () => {
    expect(coverIsbns([{ releases: [{ isbn13: null, format: "physical" }] }])).toEqual([]);
  });
});
