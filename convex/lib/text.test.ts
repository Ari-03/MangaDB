// Wire-text plumbing (lib/text.ts): entity decoding to a fixpoint, named
// entities, and title cleanup — fixtures are real ANN/WordPress strings.

import { describe, expect, it } from "vitest";

import {
  cleanBlurb,
  cleanTitleText,
  decodeEntities,
  decodeUtf8OrWindows1252,
  mapC1Controls,
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

// ANN stores a few descriptions as UTF-8 read as Windows-1252 ("Tsukasaâ€™s").
describe("repairMojibake", () => {
  it.each([
    ["Tsukasaâ€™s secret", "Tsukasa’s secret"],
    ["â€œHello,â€\u009d she said â€” then waitedâ€¦", "“Hello,” she said — then waited…"],
    ["a cafÃ© in KyÅ\u008dto", "a café in Kyōto"],
    // Mixed with clean typography: only the broken runs change.
    ["It’s Tsukasaâ€™s", "It’s Tsukasa’s"],
  ])("re-decodes Windows-1252 runs of UTF-8 bytes: %j", (text, repaired) => {
    expect(repairMojibake(text)).toBe(repaired);
  });

  it.each(["pâté and crème brûlée", "Ã la carte", "naïve façade", "Â is a letter", "plain text"])(
    "leaves clean text with a real â or Ã alone: %j",
    (clean) => {
      expect(repairMojibake(clean)).toBe(clean);
    },
  );

  // Each is valid UTF-8 when read as bytes, decoding to CJK, NKo, IPA or
  // Hebrew: real text, never mojibake.
  it.each(["a quiet café…” she said", "her fiancé”—she paused", "Spaß“ in German", "CLICHÉ”", "3 ×\u00a04"])(
    "leaves an accented letter before typographic punctuation alone: %j",
    (clean) => {
      expect(repairMojibake(clean)).toBe(clean);
    },
  );

  it("is not part of cleanBlurb, which every source shares", () => {
    expect(cleanBlurb("<p>a quiet café…” she said</p>")).toBe("a quiet café…” she said");
    expect(cleanBlurb("<p>Tsukasaâ€™s day</p>")).toBe("Tsukasaâ€™s day");
  });
});

describe("mapC1Controls", () => {
  it("reads C1 code points as the Windows-1252 characters of their byte", () => {
    expect(mapC1Controls("Schneider\u0092s \u0093quote\u0094 \u0085 \u0080")).toBe("Schneider’s “quote” … €");
    // Windows-1252's undefined slots carry nothing.
    expect(mapC1Controls("a\u0081b\u008Dc")).toBe("abc");
    expect(mapC1Controls("plain — text’s fine")).toBe("plain — text’s fine");
  });
});

describe("decodeUtf8OrWindows1252", () => {
  const bytes = (...parts: Array<string | number[]>) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

  it("decodes well-formed UTF-8 as UTF-8", () => {
    const text = "Berühren — Pokémon’s café …";
    expect(decodeUtf8OrWindows1252(bytes(text))).toBe(text);
  });

  it("reads a legacy byte inside a UTF-8 page as Windows-1252, not U+FFFD", () => {
    // "Schneider" 0x92 "s" (a Windows-1252 apostrophe) next to real UTF-8.
    expect(decodeUtf8OrWindows1252(bytes("Schneider", [0x92], "s — Ber", [0xfc], "hren"))).toBe(
      "Schneider’s — Berühren",
    );
    // A cut-off UTF-8 sequence at the end is one legacy byte too.
    expect(decodeUtf8OrWindows1252(bytes("caf", [0xc3]))).toBe("cafÃ");
  });
});
