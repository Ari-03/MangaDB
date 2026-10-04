import { describe, expect, it } from "vitest";

import {
  allowedEdits,
  editDistance,
  matchesAllWords,
  matchesSeries,
  matchNames,
  nicknameKeys,
  probePrefixes,
  rankNearMisses,
  searchWords,
  seriesSearchText,
  sortByTitleMatch,
} from "./searchMatch";

describe("searchWords", () => {
  it("lower-cases, drops accents, and splits on punctuation", () => {
    expect(searchWords("Pokémon: Red & Blue")).toEqual(["pokemon", "red", "blue"]);
    expect(searchWords("Tokyo Ghoul:re")).toEqual(["tokyo", "ghoul", "re"]);
  });

  it("reads a multiplication sign as the word x", () => {
    expect(searchWords("SPY×FAMILY")).toEqual(["spy", "x", "family"]);
    expect(searchWords("Hunter × Hunter")).toEqual(["hunter", "x", "hunter"]);
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
  it("counts a query that is a name's initials as exact, a partial one not at all", () => {
    const shelf = [
      { title: "Ao Haru Ride", altTitles: [] },
      { title: "Aot Hat Club", altTitles: [] },
      { title: "Attack on Titan", altTitles: [] },
    ];
    const order = (query: string) => sortByTitleMatch(query, shelf).map((h) => h.title);
    expect(order("aot")).toEqual(["Attack on Titan", "Aot Hat Club", "Ao Haru Ride"]);
    expect(order("ao")[0]).toBe("Ao Haru Ride");
  });

  it("puts a match on the Series' own title ahead of one through an alt title", () => {
    const shelf = [
      { title: "The King's Beast", altTitles: ["Kogetsu no Yume"] },
      { title: "Demon Slayer: Kimetsu no Yaiba", altTitles: ["Kimetsu no Yaiba"] },
    ];
    expect(sortByTitleMatch("kny", shelf).map((h) => h.title)).toEqual([
      "Demon Slayer: Kimetsu no Yaiba",
      "The King's Beast",
    ]);
  });

  it("gives two-letter initials no lift over a title that opens with them", () => {
    const shelf = [
      { title: "Dear Emily", altTitles: [] },
      { title: "Death Note", altTitles: [] },
    ];
    expect(sortByTitleMatch("de", shelf).map((h) => h.title)).toEqual(["Dear Emily", "Death Note"]);
    expect(sortByTitleMatch("de", [...shelf].reverse()).map((h) => h.title)).toEqual([
      "Death Note",
      "Dear Emily",
    ]);
  });

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

describe("nicknameKeys", () => {
  const keys = (...names: string[]) => {
    const { initials, runs } = nicknameKeys(names);
    return [...initials, ...runs];
  };

  it("takes the initials of every multi-word name, and the name run together", () => {
    expect(nicknameKeys(["Attack on Titan"])).toEqual({
      initials: ["aot"],
      runs: ["attackontitan"],
    });
    expect(keys("Spy x Family")).toContain("sxf");
    expect(keys("Hunter x Hunter")).toContain("hxh");
    expect(keys("Hunter × Hunter", "SPY×FAMILY")).toEqual(
      expect.arrayContaining(["hxh", "sxf", "spyxfamily"]),
    );
    expect(keys("One-Punch Man")).toContain("opm");
    expect(keys("Chainsaw Man")).toContain("chainsawman");
  });

  it("keeps numbers whole, folds apostrophes, and drops a leading article", () => {
    expect(keys("Mob Psycho 100")).toContain("mp100");
    expect(keys("JoJo's Bizarre Adventure")).toContain("jba");
    expect(keys("The Apothecary Diaries")).toEqual(
      expect.arrayContaining(["tad", "ad", "apothecarydiaries"]),
    );
  });

  it("reads each part of a subtitled name as a name of its own", () => {
    expect(nicknameKeys(["Demon Slayer: Kimetsu no Yaiba"]).initials).toEqual(
      expect.arrayContaining(["dskny", "ds", "kny"]),
    );
    expect(nicknameKeys(["My Hero Academia", "Boku no Hero Academia"]).initials).toEqual(
      expect.arrayContaining(["mha", "bnha"]),
    );
  });

  it("takes a letter outside the BMP whole", () => {
    expect(nicknameKeys(["𠮷野 家"]).initials).toEqual(["𠮷家"]);
  });

  it("derives nothing from a one-word name", () => {
    expect(keys("Berserk", "JJK")).toEqual([]);
  });
});

describe("matchesSeries", () => {
  const series = (title: string, altTitles: string[] = []) => ({ title, altTitles });

  it("takes initials only whole, and words and run-together names by their opening", () => {
    expect(matchesSeries("aot", series("Attack on Titan"))).toBe(true);
    expect(matchesSeries("aot", series("Ace of the Diamond"))).toBe(false);
    expect(matchesSeries("ao", series("Attack on Titan"))).toBe(false);
    expect(matchesSeries("chainsaw", series("Chainsaw Man"))).toBe(true);
    expect(matchesSeries("chainsawm", series("Chainsaw Man"))).toBe(true);
    expect(matchesSeries("spy x family", series("SPY×FAMILY"))).toBe(true);
    expect(matchesSeries("jjk", series("Jujutsu Kaisen", ["JJK"]))).toBe(true);
  });
});

describe("seriesSearchText", () => {
  it("is the names, then their keys", () => {
    expect(seriesSearchText("Jujutsu Kaisen", ["JJK"])).toBe("Jujutsu Kaisen JJK jk jujutsukaisen");
  });
});

describe("matchNames", () => {
  const publishers = [
    { name: "Yen Press" },
    { name: "Seven Seas Entertainment" },
    { name: "Drawn & Quarterly" },
    { name: "Ize Press" },
    { name: "Press Start" },
    { name: "One Peace Books" },
    { name: "ComicsOne" },
    { name: "Del Rey Manga" },
    { name: "Titan Manga" },
    { name: "Dark Horse" },
  ];
  const names = (query: string) => matchNames(query, publishers).map((m) => m.item.name);
  const opened = (query: string) =>
    matchNames(query, publishers).flatMap((m) => (m.names ? [m.item.name] : []));

  it("finds a name by the start of any of its words", () => {
    expect(names("Seven Seas Entertainment")).toEqual(["Seven Seas Entertainment"]);
    expect(names("seven seas")).toEqual(["Seven Seas Entertainment"]);
    expect(names("seas")).toEqual(["Seven Seas Entertainment"]);
    expect(names("seas seven")).toEqual(["Seven Seas Entertainment"]);
  });

  it("does not match inside a word", () => {
    // "one" opens One Peace Books but sits mid-word in ComicsOne.
    expect(names("one")).toEqual(["One Peace Books"]);
    expect(names("ark")).toEqual([]);
    expect(names("ma")).toEqual(["Del Rey Manga", "Titan Manga"]);
  });

  it("puts exact and opening matches first, then the rest A–Z", () => {
    expect(names("press")).toEqual(["Press Start", "Ize Press", "Yen Press"]);
    expect(names("yen press")).toEqual(["Yen Press"]);
  });

  it("marks a name as named only when the query spells its leading words whole", () => {
    expect(opened("seven seas")).toEqual(["Seven Seas Entertainment"]);
    expect(opened("seven")).toEqual(["Seven Seas Entertainment"]);
    expect(opened("one")).toEqual(["One Peace Books"]);
    expect(opened("del rey")).toEqual(["Del Rey Manga"]);
    expect(opened("press")).toEqual(["Press Start"]);
    // A word deeper in the name only suggests the Publisher.
    expect(names("manga")).toEqual(["Del Rey Manga", "Titan Manga"]);
    expect(opened("manga")).toEqual([]);
    expect(opened("seas")).toEqual([]);
    expect(opened("seas seven")).toEqual([]);
  });

  it("lists a name a partial word starts without marking it named", () => {
    for (const query of ["d", "de", "del r", "sev", "seven sea"]) {
      expect(opened(query)).toEqual([]);
    }
    expect(names("de")).toEqual(["Del Rey Manga"]);
    // "Del" is a whole word of Del Rey Manga, so it names it.
    expect(opened("del")).toEqual(["Del Rey Manga"]);
    expect(names("d")).toEqual(["Dark Horse", "Del Rey Manga", "Drawn & Quarterly"]);
    expect(names("seven sea")).toEqual(["Seven Seas Entertainment"]);
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
  const titles = (query: string) => rankNearMisses(query, catalog, 3).map((m) => m.item.title);

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
