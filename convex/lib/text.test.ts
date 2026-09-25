// Wire-text plumbing (lib/text.ts): entity decoding to a fixpoint, named
// entities, and title cleanup — fixtures are real ANN/WordPress strings.

import { describe, expect, it } from "vitest";

import { cleanTitleText, decodeEntities, stripHtml } from "./text";

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
