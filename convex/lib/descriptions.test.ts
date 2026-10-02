import { describe, expect, it } from "vitest";

import { representativeDescription } from "./descriptions";

type Fixture = Parameters<typeof representativeDescription>[0][number];

function release(fields: Partial<Fixture> & { id: string }) {
  return { format: "physical" as const, ...fields };
}

const pick = (releases: Array<ReturnType<typeof release>>) =>
  representativeDescription(releases)?.release.id ?? null;

describe("representativeDescription", () => {
  it("is null when no Release carries non-blank text", () => {
    expect(representativeDescription([])).toBeNull();
    expect(
      representativeDescription([
        release({ id: "a" }),
        release({ id: "b", description: "  \n " }),
      ]),
    ).toBeNull();
  });

  it("returns the trimmed text with the Release it came from", () => {
    const only = release({ id: "a", format: "digital", description: "  Blurb. " });
    expect(representativeDescription([release({ id: "b" }), only])).toEqual({
      release: only,
      text: "Blurb.",
    });
  });

  it("puts a Human Override of the description ahead of everything else", () => {
    expect(
      pick([
        release({ id: "print", description: "Much longer print blurb text." }),
        release({
          id: "fixed",
          format: "digital",
          description: "Fixed.",
          pubDate: { year: 2030, sort: 20300000 },
          overriddenFields: ["description"],
        }),
      ]),
    ).toBe("fixed");
  });

  it("ignores overrides of other fields", () => {
    expect(
      pick([
        release({
          id: "digital",
          format: "digital",
          description: "Digital.",
          overriddenFields: ["price"],
        }),
        release({ id: "print", description: "Print." }),
      ]),
    ).toBe("print");
  });

  it("prefers physical over digital, whatever the dates and lengths", () => {
    expect(
      pick([
        release({
          id: "digital",
          format: "digital",
          description: "An earlier and much longer digital blurb.",
          pubDate: { year: 2015, sort: 20150000 },
        }),
        release({ id: "print", description: "Print.", pubDate: { year: 2016, sort: 20160000 } }),
      ]),
    ).toBe("print");
  });

  it("then the earliest dated, undated last", () => {
    expect(
      pick([
        release({ id: "undated", description: "Undated and the longest of all." }),
        release({ id: "later", description: "Later.", pubDate: { year: 2020, month: 3, sort: 20200300 } }),
        release({ id: "earlier", description: "Earlier.", pubDate: { year: 2020, month: 1, sort: 20200100 } }),
      ]),
    ).toBe("earlier");
  });

  it("then the longest text, a full tie keeping input order", () => {
    const date = { year: 2020, sort: 20200000 };
    expect(
      pick([
        release({ id: "short", description: "Short.", pubDate: date }),
        release({ id: "long", description: "Somewhat longer.", pubDate: date }),
      ]),
    ).toBe("long");
    expect(
      pick([
        release({ id: "first", description: "Same.", pubDate: date }),
        release({ id: "second", description: "Same.", pubDate: date }),
      ]),
    ).toBe("first");
  });
});
