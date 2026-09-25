import { describe, expect, test } from "vitest";

import { seriesCoverIsbn, type SeriesCoverCandidate } from "./covers";

const NOW = new Date(Date.UTC(2026, 8, 25));
const release = (
  isbn13: string | undefined,
  over: Partial<SeriesCoverCandidate> = {},
): SeriesCoverCandidate => ({
  isbn13,
  format: "physical",
  pubDate: { year: 2020, sort: 20200101 },
  inLine: false,
  position: 1,
  ...over,
});

describe("seriesCoverIsbn", () => {
  test("no ISBN anywhere is no pick", () => {
    expect(seriesCoverIsbn([], NOW)).toBeNull();
    expect(seriesCoverIsbn([release(undefined)], NOW)).toBeNull();
  });

  test("the standard run's Volume 1 in print leads", () => {
    const picked = seriesCoverIsbn(
      [
        // omnibus 1, older than the standard Volume 1
        release("9780000000001", { inLine: true, pubDate: { year: 2010, sort: 20100101 } }),
        release("9780000000002", { format: "digital" }), // vol 1 ebook
        release("9780000000004", { position: 2 }), // vol 2 print
        release("9780000000003"), // vol 1 print
      ],
      NOW,
    );
    expect(picked).toBe("9780000000003");
  });

  test("an Edition Line's earlier Volume beats a later standard one", () => {
    // Kanokon: omnibuses from Volume 5, the standard run only from Volume 10.
    const picked = seriesCoverIsbn(
      [
        release("9780000000010", { position: 10 }),
        release("9780000000005", { inLine: true, position: 5 }),
      ],
      NOW,
    );
    expect(picked).toBe("9780000000005");
  });

  test("a published book beats an earlier-placed forthcoming one", () => {
    const picked = seriesCoverIsbn(
      [
        release("9780000000001", { pubDate: { year: 2027, sort: 20270101 } }),
        release("9780000000002", { pubDate: undefined }),
        release("9780000000003", { position: 3 }),
      ],
      NOW,
    );
    expect(picked).toBe("9780000000003");
  });

  test("digital and Edition Lines still stand in when nothing better exists", () => {
    expect(
      seriesCoverIsbn([release("9780000000001", { format: "digital", inLine: true })], NOW),
    ).toBe("9780000000001");
  });
});
