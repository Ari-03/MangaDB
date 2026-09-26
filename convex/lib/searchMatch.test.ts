import { describe, expect, it } from "vitest";

import {
  allowedEdits,
  editDistance,
  matchesAllWords,
  matchNames,
  probePrefixes,
  rankNearMisses,
  searchWords,
  sortByTitleMatch,
} from "./searchMatch";

describe("searchWords", () => {
  it("lower-cases, drops accents, and splits on punctuation", () => {
    expect(searchWords("Pokémon: Red & Blue")).toEqual(["pokemon", "red", "blue"]);
    expect(searchWords("Tokyo Ghoul:re")).toEqual(["tokyo", "ghoul", "re"]);
  });

  it("keeps non-Latin words whole", () => {
    expect(searchWords("ワンピース")).toEqual(["ワンピース"]);
  });
});

describe("matchesAllWords", () => {
  it("needs every query word to start some word of the text", () => {
    expect(matchesAllWords("one pie", "One Piece")).toBe(true);
    expect(matchesAllWords("one peice", "One Piece")).toBe(false);
    expect(matchesAllWords("chainsaw man", "Velveteen & Mandala")).toBe(false);
  });

  it("never matches an empty query", () => {
    expect(matchesAllWords("  ", "One Piece")).toBe(false);
  });
});

describe("sortByTitleMatch", () => {
  const hits = [
    { title: "Attack on Titan Anthology", altTitles: [] },
    { title: "The Science of Attack on Titan", altTitles: [] },
    { title: "Attack on Titan", altTitles: ["Shingeki no Kyojin"] },
    { title: "Attack on Titan: No Regrets", altTitles: [] },
  ];
  const order = (query: string) => sortByTitleMatch(query, hits).map((h) => h.title);

  it("puts an exact title first, then openings shortest first, then the rest", () => {
    expect(order("attack on titan")).toEqual([
      "Attack on Titan",
      "Attack on Titan Anthology",
      "Attack on Titan: No Regrets",
      "The Science of Attack on Titan",
    ]);
    expect(order("attack on")[0]).toBe("Attack on Titan");
  });

  it("counts alt titles, and keeps the given order among the rest", () => {
    expect(order("shingeki")).toEqual([
      "Attack on Titan",
      "Attack on Titan Anthology",
      "The Science of Attack on Titan",
      "Attack on Titan: No Regrets",
    ]);
  });
});

describe("matchNames", () => {
  const publishers = [
    { name: "Yen Press" },
    { name: "Seven Seas Entertainment" },
    { name: "Drawn & Quarterly" },
    { name: "Ize Press" },
    { name: "Press Start" },
  ];
  const names = (query: string) => matchNames(query, publishers).map((p) => p.name);

  it("finds a name from any part of it, not just its opening", () => {
    expect(names("Seven Seas Entertainment")).toEqual(["Seven Seas Entertainment"]);
    expect(names("seven seas")).toEqual(["Seven Seas Entertainment"]);
    expect(names("seas")).toEqual(["Seven Seas Entertainment"]);
  });

  it("puts exact and opening matches first, then the rest A–Z", () => {
    expect(names("press")).toEqual(["Press Start", "Ize Press", "Yen Press"]);
    expect(names("yen press")).toEqual(["Yen Press"]);
  });

  it("folds punctuation and '&' so spelling variants still match", () => {
    expect(names("drawn and quarterly")).toEqual(["Drawn & Quarterly"]);
    expect(names("DRAWN & QUARTERLY!")).toEqual(["Drawn & Quarterly"]);
  });

  it("matches nothing for a query with no letters or digits", () => {
    expect(names("  !! ")).toEqual([]);
  });
});

describe("probePrefixes", () => {
  it("probes 3- and 4-letter openings of the two longest words", () => {
    expect(probePrefixes("berzerk")).toEqual(["ber", "berz"]);
    expect(probePrefixes("one peice")).toEqual(["pei", "peic", "one"]);
    expect(probePrefixes("the chainsaw man")).toEqual(["cha", "chai", "the"]);
  });

  it("skips words too short to narrow anything", () => {
    expect(probePrefixes("a to b")).toEqual([]);
    expect(probePrefixes("one")).toEqual([]);
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions, and adjacent swaps", () => {
    expect(editDistance("berzerk", "berserk")).toBe(1);
    expect(editDistance("onepeice", "onepiece")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("gives up past the cap", () => {
    expect(editDistance("kitten", "sitting", 1)).toBe(2);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });
});

describe("allowedEdits", () => {
  it("allows one edit per four letters, at least one", () => {
    expect(allowedEdits(4)).toBe(1);
    expect(allowedEdits(7)).toBe(1);
    expect(allowedEdits(8)).toBe(2);
    expect(allowedEdits(12)).toBe(3);
  });
});

describe("rankNearMisses", () => {
  const catalog = [
    { title: "Berserk", altTitles: ["ベルセルク"] },
    { title: "Berserk of Gluttony", altTitles: [] },
    { title: "One Piece", altTitles: ["ワンピース"] },
    { title: "One-Punch Man", altTitles: [] },
    { title: "Chainsaw Man", altTitles: ["チェンソーマン"] },
    { title: "Chainsmoker Cat", altTitles: [] },
    { title: "Attack on Titan", altTitles: ["Shingeki no Kyojin"] },
  ];
  const titles = (query: string) =>
    rankNearMisses(query, catalog, 3).map((m) => m.item.title);

  it("finds the titles the typical typos meant", () => {
    expect(titles("berzerk")).toEqual(["Berserk", "Berserk of Gluttony"]);
    expect(titles("one peice")).toEqual(["One Piece"]);
    expect(titles("chainsawman")).toEqual(["Chainsaw Man"]);
  });

  it("matches alt titles and reports which name matched", () => {
    const [hit] = rankNearMisses("shingeki no kyojn", catalog, 3);
    expect(hit?.item.title).toBe("Attack on Titan");
    expect(hit?.matched).toBe("Shingeki no Kyojin");
  });

  it("ranks a whole-title match ahead of an opening match", () => {
    const [first, second] = rankNearMisses("berserk", catalog, 3);
    expect(first).toMatchObject({ matched: "Berserk", score: 0 });
    expect(second).toMatchObject({ matched: "Berserk of Gluttony", score: 0.5 });
  });

  it("stays quiet for short queries and far-off text", () => {
    expect(titles("one")).toEqual([]);
    expect(titles("xylophone")).toEqual([]);
  });
});
