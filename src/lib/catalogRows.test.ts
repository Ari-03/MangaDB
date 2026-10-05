// The Release row's Other Printings line (catalogRows.tsx otherPrintingsText):
// what a reader is told about the printings shown, and about any not shown.

import { describe, expect, it } from "vitest";

import { otherPrintingsText } from "./catalogRows";

describe("otherPrintingsText", () => {
  const printings = [
    { isbn13: "9781591160342", year: 2002 },
    { isbn13: "9781974700011", year: null },
  ];

  it("lists every printing with its year when the list is whole", () => {
    expect(otherPrintingsText({ otherPrintings: printings, morePrintings: false })).toBe(
      "Also printed as ISBN 9781591160342, 2002; ISBN 9781974700011",
    );
    expect(otherPrintingsText({ otherPrintings: [], morePrintings: false })).toBeNull();
  });

  it("says when the list is only the first recorded and others may remain", () => {
    expect(otherPrintingsText({ otherPrintings: printings, morePrintings: true })).toBe(
      "Also printed as ISBN 9781591160342, 2002; ISBN 9781974700011 (the first 2 recorded; others may not be shown)",
    );
    expect(otherPrintingsText({ otherPrintings: [], morePrintings: true })).toBe(
      "Also printed under other ISBNs, not shown here.",
    );
  });
});
