// Wire-text plumbing (lib/text.ts): entity decoding to a fixpoint, named
// entities, and title cleanup — fixtures are real ANN/WordPress strings.

import { describe, expect, it } from "vitest";

import {
  cleanBlurb,
  cleanTitleText,
  decodeEntities,
  MAX_BLURB,
  repairMojibake,
  stripHtml,
} from "./text";

describe("decodeEntities", () => {
  it("decodes ANN's double-escaped numeric entities to a fixpoint", () => {
    expect(
      decodeEntities(
        "Marrying the Dark Knight &amp;#40;For Her Money&amp;#41;",
      ),
    ).toBe("Marrying the Dark Knight (For Her Money)");
    expect(
      decodeEntities("Marrying the Dark Knight &#40;For Her Money&#41;"),
    ).toBe("Marrying the Dark Knight (For Her Money)");
    expect(decodeEntities("Betrothed to My Sister&#8217;s Ex")).toBe(
      "Betrothed to My Sister’s Ex",
    );
    expect(decodeEntities("SPY&#x00D7;FAMILY")).toBe("SPY×FAMILY");
  });

  it("knows the named entities titles actually carry", () => {
    expect(
      decodeEntities(
        "Let's Run an Inn on Dungeon Island! &lpar;In a World Ruled by Women&rpar;",
      ),
    ).toBe("Let's Run an Inn on Dungeon Island! (In a World Ruled by Women)");
    expect(decodeEntities("Pompo: The Cin&eacute;phile")).toBe(
      "Pompo: The Cinéphile",
    );
    expect(decodeEntities("Fushigi Y&ucirc;gi")).toBe("Fushigi Yûgi");
    expect(decodeEntities("Bad&infin;End&infin;Night")).toBe("Bad∞End∞Night");
    expect(decodeEntities("Candy &amp; Cigarettes")).toBe("Candy & Cigarettes");
  });

  it("leaves unknown entities and a literal ampersand alone", () => {
    expect(decodeEntities("&bogus; & more")).toBe("&bogus; & more");
    expect(decodeEntities("&#0;")).toBe("&#0;");
  });
});

describe("cleanTitleText", () => {
  it("drops ruby annotations, unwraps inline tags, collapses whitespace", () => {
    expect(
      cleanTitleText(
        "<ruby><rb>魔法</rb><rp>(</rp><rt>まほう</rt><rp>)</rp></ruby>少女",
      ),
    ).toBe("魔法少女");
    expect(cleanTitleText("Level E<sup>2</sup>")).toBe("Level E2");
    expect(cleanTitleText("&lt;sup&gt;x&lt;/sup&gt;")).toBe("x");
    expect(cleanTitleText("A  Century of Temptation ")).toBe(
      "A Century of Temptation",
    );
  });

  it("keeps a real title's angle brackets", () => {
    expect(cleanTitleText("&lt;Infinite Dendrogram&gt;")).toBe(
      "<Infinite Dendrogram>",
    );
  });
});

describe("stripHtml", () => {
  it("strips tags and decodes", () => {
    expect(stripHtml("<p>One &amp; <b>two</b></p>")).toBe("One & two");
  });
});

describe("cleanBlurb", () => {
  it("flattens blurb HTML to one paragraph", () => {
    expect(cleanBlurb("<p>Welcome to Neo&#8211;Tokyo.<br><br>\n  It&#8217;s   big.</p>")).toBe(
      "Welcome to Neo–Tokyo. It’s big.",
    );
    // Inline tags vanish without leaving a space before punctuation.
    expect(cleanBlurb("<p>Read <i>Akira</i>, then <a href='/x'>more</a>.</p><p>Next</p>")).toBe(
      "Read Akira, then more. Next",
    );
  });

  it("offers nothing for empty or non-string input", () => {
    expect(cleanBlurb("  <p> &nbsp; </p>\n")).toBeUndefined();
    expect(cleanBlurb(null)).toBeUndefined();
    expect(cleanBlurb({ value: "text" })).toBeUndefined();
  });

  it("caps a runaway blurb on a word boundary", () => {
    const long = cleanBlurb("word ".repeat(2000))!;
    expect(long.length).toBeLessThanOrEqual(MAX_BLURB);
    expect(long.endsWith("word…")).toBe(true);
  });
});

// ANN stores a few descriptions as UTF-8 read as Windows-1252 (3 of the
// first 714 production fills, e.g. "Tsukasaâ€™s").
describe("repairMojibake", () => {
  it("re-decodes Windows-1252 runs of UTF-8 bytes", () => {
    expect(repairMojibake("Tsukasaâ€™s secret")).toBe("Tsukasa’s secret");
    expect(repairMojibake("â€œHello,â€\u009d she said â€” then waitedâ€¦")).toBe(
      "“Hello,” she said — then waited…",
    );
    expect(repairMojibake("a cafÃ© in KyÅ\u008dto")).toBe("a café in Kyōto");
    // Mixed with clean typography: only the broken runs change.
    expect(repairMojibake("It’s Tsukasaâ€™s")).toBe("It’s Tsukasa’s");
  });

  it("leaves clean text with a real â or Ã alone", () => {
    for (const clean of ["pâté and crème brûlée", "Ã la carte", "naïve façade", "Â is a letter", "plain text"]) {
      expect(repairMojibake(clean)).toBe(clean);
    }
  });

  it("leaves an accented letter before typographic punctuation alone", () => {
    // Each is valid UTF-8 when read as bytes, decoding to CJK, NKo, IPA or
    // Hebrew: real text, never mojibake.
    for (const clean of [
      "a quiet café…” she said",
      "her fiancé”—she paused",
      "Spaß“ in German",
      "CLICHÉ”",
      "3 ×\u00a04",
    ]) {
      expect(repairMojibake(clean)).toBe(clean);
    }
  });

  it("is not part of cleanBlurb, which every source shares", () => {
    expect(cleanBlurb("<p>a quiet café…” she said</p>")).toBe("a quiet café…” she said");
    expect(cleanBlurb("<p>Tsukasaâ€™s day</p>")).toBe("Tsukasaâ€™s day");
  });
});
