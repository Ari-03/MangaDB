// The shared release-title parser (lib/bookTitle.ts). Fixtures are real
// titles from the production snapshot's source observations (PRH,
// OpenLibrary, Kodansha, Seven Seas), grouped by the shape that used to
// defeat the per-source splitters. The packaging grammar's edge cases
// (gapped lists, competing coverage statements) use synthetic "Alpha"
// titles built to isolate one rule each.

import { describe, expect, it } from "vitest";

import {
  canonicalLabel,
  isNovelTitle,
  outOfScopeReason,
  parseBookTitle,
  rangeLabels,
} from "./bookTitle";

/** series | label | subtitle, the three facts most cases pin. */
function split(title: string, seriesNumber?: number | string) {
  const parsed = parseBookTitle(title, { seriesNumber });
  return [parsed.seriesTitle, parsed.volumeLabel, parsed.volumeSubtitle];
}

describe("parseBookTitle — volume markers", () => {
  it("reads every marker spelling, with or without a space", () => {
    expect(split("Chainsaw Man, Vol. 22")).toEqual(["Chainsaw Man", "22", null]);
    expect(split("Alpi the Soul Sender Vol.5")).toEqual(["Alpi the Soul Sender", "5", null]);
    expect(split("Berserk Volume 41")).toEqual(["Berserk", "41", null]);
    expect(split("Flowers of Evil, Volume 4")).toEqual(["Flowers of Evil", "4", null]);
    expect(split("One Piece #3")).toEqual(["One Piece", "3", null]);
    expect(split("Homestuck, Book 4")).toEqual(["Homestuck", "4", null]);
    expect(split("Paradise Kiss, Part 1")).toEqual(["Paradise Kiss", "1", null]);
    expect(split("Rising of the Shield Hero Volume 08")).toEqual([
      "Rising of the Shield Hero",
      "8",
      null,
    ]);
    expect(split("Sudoku Plus, Volume Two")).toEqual(["Sudoku Plus", "2", null]);
  });

  it("keeps a per-volume subtitle out of the series title", () => {
    expect(split("Lone Wolf and Cub Volume 7: Cloud Dragon, Wind Tiger")).toEqual([
      "Lone Wolf and Cub",
      "7",
      "Cloud Dragon, Wind Tiger",
    ]);
    expect(split("Buddha: Volume 3: Devadatta")).toEqual(["Buddha", "3", "Devadatta"]);
    expect(split("World's End Harem Vol. 14 - After World")).toEqual([
      "World's End Harem",
      "14",
      "After World",
    ]);
    expect(split("Appleseed Book 2: Prometheus Unbound")).toEqual([
      "Appleseed",
      "2",
      "Prometheus Unbound",
    ]);
    expect(split("Emanon Volume 4: Emanon Wanderer Part Three")).toEqual([
      "Emanon",
      "4",
      "Emanon Wanderer Part Three",
    ]);
    expect(split("Sundome!! Milky Way Vol. 10 Another End")).toEqual([
      "Sundome!! Milky Way",
      "10",
      "Another End",
    ]);
  });

  // R12: a "Vol." or "#" after "Part N" / "Book N" starts the designation;
  // it never joins the Part's number into a Volume list (real OpenLibrary
  // titles among them).
  it("reads 'Part N, Vol. M' as Volume M of the Part, never packaging", () => {
    for (const [title, series, label] of [
      ["Alpha, Part 1, Vol. 2", "Alpha, Part 1", "2"],
      ["Alpha Book 2, Vol. 3", "Alpha Book 2", "3"],
      ["JoJo's Bizarre Adventure: Part 5, Vol. 6", "JoJo's Bizarre Adventure: Part 5", "6"],
      ["Magical Pokemon Journey Part 4, #1", "Magical Pokemon Journey Part 4", "1"],
      ["Magical Pokemon Journey Part 4, #3", "Magical Pokemon Journey Part 4", "3"],
      ["Magical Pokémon Journey, Part 4, Vol 1", "Magical Pokémon Journey, Part 4", "1"],
      ["Magical Pokemon Journey Part 6, Vol. 3", "Magical Pokemon Journey Part 6", "3"],
      ["Magical Pokemon, Part 2, Vol. 3", "Magical Pokemon, Part 2", "3"],
    ] as const) {
      expect(parseBookTitle(title), title).toMatchObject({
        seriesTitle: series,
        volumeLabel: label,
        packaging: null,
      });
    }
    // After a "Vol." marker a listed item may still repeat it.
    expect(parseBookTitle("Alpha Vol. 3 + Vol. 4").packaging?.coverRange).toEqual({
      from: "3",
      to: "4",
    });
    expect(parseBookTitle("Alpha #1 & #3").packaging).toMatchObject({
      coverRange: null,
      coverageGapped: true,
    });
  });

  it("splits at the last marker, not an earlier one inside the name", () => {
    expect(split("Magic Knight Rayearth Part 2 Vol. 3 (Paperback)")).toEqual([
      "Magic Knight Rayearth Part 2",
      "3",
      null,
    ]);
    expect(split("10 Things I Want to Do Before I Turn 40 - Part 2")).toEqual([
      "10 Things I Want to Do Before I Turn 40",
      "2",
      null,
    ]);
  });

  it("peels format tags before and after the marker", () => {
    expect(parseBookTitle("ENNEAD Vol. 4 [Mature Hardcover]")).toMatchObject({
      seriesTitle: "ENNEAD",
      volumeLabel: "4",
      formatTags: ["Mature Hardcover"],
    });
    expect(parseBookTitle("Betrothed to My Sister's Ex (Manga) Vol. 6")).toMatchObject({
      seriesTitle: "Betrothed to My Sister's Ex",
      volumeLabel: "6",
    });
    expect(split("My Beautiful Man, Volume 6 (Manga)")).toEqual(["My Beautiful Man", "6", null]);
    expect(split("I Ship My Rival x Me (The Comic / Manhua) Vol. 2")).toEqual([
      "I Ship My Rival x Me",
      "2",
      null,
    ]);
    expect(split("Hellsing Volume 9 (Second Edition)")).toEqual(["Hellsing", "9", null]);
    expect(split("Plus-Sized Elf Vol. 4 (Rerelease)")).toEqual(["Plus-Sized Elf", "4", null]);
  });

  it("reads a volume noted only in brackets", () => {
    expect(split("A Chinese Fantasy: Law of the Fox [Book 2]")).toEqual([
      "A Chinese Fantasy: Law of the Fox",
      "2",
      null,
    ]);
    expect(parseBookTitle("Himouto! Umaru-chan Vol. G1 (Vol. 13)")).toMatchObject({
      seriesTitle: "Himouto! Umaru-chan",
      volumeLabel: "G1",
    });
  });

  it("reads a marker from a separately carried subtitle", () => {
    expect(parseBookTitle("Frieren", { subtitle: "Vol. 5" })).toMatchObject({
      seriesTitle: "Frieren",
      volumeLabel: "5",
    });
  });

  it("never treats a book kind as a volume marker", () => {
    expect(split("Cells at Work! Picture Book 3: I'm Not Scared of Shots!")[0]).toBe(
      "Cells at Work! Picture Book 3: I'm Not Scared of Shots!",
    );
  });
});

describe("parseBookTitle — unmarked trailing numbers", () => {
  it("splits with a peeled format tag as context", () => {
    expect(parseBookTitle("Otherside Picnic 05 (Manga)")).toMatchObject({
      seriesTitle: "Otherside Picnic",
      volumeLabel: "5",
      bareNumber: true,
    });
    expect(split("Battle Angel Alita 3 (Paperback)")).toEqual(["Battle Angel Alita", "3", null]);
    expect(split("BAKEMONOGATARI (manga) 11", 11)).toEqual(["BAKEMONOGATARI", "11", null]);
  });

  it("splits when the number equals the source's own volume number", () => {
    expect(split("Negima! 19", 19)).toEqual(["Negima!", "19", null]);
    expect(split("Buddha 3: Devadatta", 3)).toEqual(["Buddha", "3", "Devadatta"]);
    expect(split("The Limit, 3", 3)).toEqual(["The Limit", "3", null]);
    expect(split("Say I Love You. 11", 11)).toEqual(["Say I Love You.", "11", null]);
    expect(split("Mechanical Buddy Universe 1.0 03", 3)).toEqual([
      "Mechanical Buddy Universe 1.0",
      "3",
      null,
    ]);
    expect(split("The Blue Wolves of Mibu 5 (Blue Miburo)", 5)).toEqual([
      "The Blue Wolves of Mibu",
      "5",
      null,
    ]);
    expect(split("O Maidens in Your Savage Season 3", 3)).toEqual([
      "O Maidens in Your Savage Season",
      "3",
      null,
    ]);
  });

  it("does not truncate numbers that belong to the name", () => {
    // No seriesNumber, no tag: the number is part of the title.
    expect(split("Omega 6")).toEqual(["Omega 6", null, null]);
    expect(split("Mob Psycho 100")).toEqual(["Mob Psycho 100", null, null]);
    expect(split("Golgo 13")).toEqual(["Golgo 13", null, null]);
    expect(split("1984")).toEqual(["1984", null, null]);
    // "No. 6" is a name even with a matching seriesNumber.
    expect(split("No. 6", 6)).toEqual(["No. 6", null, null]);
    expect(split("Kaiju No. 8", 8)).toEqual(["Kaiju No. 8", null, null]);
    expect(split("No. 6 Volume 7")).toEqual(["No. 6", "7", null]);
    expect(split("Mob Psycho 100 Volume 5")).toEqual(["Mob Psycho 100", "5", null]);
    // A franchise ordinal on a title with no number never becomes a label.
    expect(split("orange -future-", 3)).toEqual(["orange -future-", null, null]);
    expect(split("Pop Team Epic, Second Season", 2)).toEqual([
      "Pop Team Epic, Second Season",
      null,
      null,
    ]);
  });

  it("flags a seriesNumber-licensed split so callers can double-check the name", () => {
    // "Omega 6" with PRH seriesNumber 6 splits, flagged: the PRH adapter
    // keeps the whole title when only it names an existing Series.
    expect(parseBookTitle("Omega 6", { seriesNumber: 6 })).toMatchObject({
      seriesTitle: "Omega",
      volumeLabel: "6",
      bareNumber: true,
    });
    expect(parseBookTitle("Chainsaw Man, Vol. 22").bareNumber).toBe(false);
  });

  it("offers the split it declined, for callers with catalog access", () => {
    // No seriesNumber, no tag: the title stays whole, the split is only offered.
    expect(parseBookTitle("Tower Dungeon 7")).toMatchObject({
      seriesTitle: "Tower Dungeon 7",
      volumeLabel: null,
      bareNumber: false,
      bareSplit: { seriesTitle: "Tower Dungeon", volumeLabel: "7" },
    });
    expect(parseBookTitle("The Otaku Love Connection 01").bareSplit).toEqual({
      seriesTitle: "The Otaku Love Connection",
      volumeLabel: "1",
    });
    expect(parseBookTitle("Ascendance of a Bookworm: Fanbook 2").bareSplit).toEqual({
      seriesTitle: "Ascendance of a Bookworm: Fanbook",
      volumeLabel: "2",
    });
    // A taken split, a range, a "No." name, a marked title: nothing to offer.
    expect(parseBookTitle("Tower Dungeon 7", { seriesNumber: 7 }).bareSplit).toBeNull();
    expect(parseBookTitle("Astro Boy 1 & 2").bareSplit).toBeNull();
    expect(parseBookTitle("Kaiju No. 8").bareSplit).toBeNull();
    expect(parseBookTitle("Chainsaw Man, Vol. 22").bareSplit).toBeNull();
    expect(parseBookTitle("1984").bareSplit).toBeNull();
  });

  it("keeps real names that contain packaging or edition words", () => {
    for (const title of [
      "Lovesickness: Junji Ito Story Collection",
      "The Ancient Magus' Bride: Fragments Collection",
      "Welcome to Demon School! Iruma-kun: IruMafia Edition",
      "The Complete Aranzi Hour",
      "Pop Team Epic, Second Season",
      "Galaxy Express 999",
    ]) {
      expect(parseBookTitle(title), title).toMatchObject({
        seriesTitle: title,
        packaging: null,
      });
    }
    expect(split("Welcome to Demon School! Iruma-kun: IruMafia Edition 7", 7)).toEqual([
      "Welcome to Demon School! Iruma-kun: IruMafia Edition",
      "7",
      null,
    ]);
  });
});

describe("parseBookTitle — packaging", () => {
  const packaging = (title: string, seriesNumber?: number) => {
    const parsed = parseBookTitle(title, { seriesNumber });
    return {
      seriesTitle: parsed.seriesTitle,
      volumeLabel: parsed.volumeLabel,
      packaging: parsed.packaging,
      isBox: parsed.isBox,
    };
  };
  /** What `packaging` returns for a packaged synthetic "Alpha" book: no Volume label, no box. */
  const packagedAlpha = <P>(found: P) => ({
    seriesTitle: "Alpha",
    volumeLabel: null,
    packaging: found,
    isBox: false,
  });

  it("maps an omnibus to its line position and the volumes it collects", () => {
    expect(packaging("Noragami Omnibus 7 (Vol. 19-21)", 7)).toEqual({
      seriesTitle: "Noragami",
      volumeLabel: null,
      packaging: {
        lineName: "Omnibus",
        linePosition: "7",
        coverRange: { from: "19", to: "21" },
      },
      isBox: false,
    });
    expect(packaging("Tokyo Revengers (Omnibus) Vol. 23-24").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: { from: "23", to: "24" },
    });
    expect(packaging("High-Rise Invasion Omnibus 5-6").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: { from: "5", to: "6" },
    });
    expect(packaging("Blue Giant Omnibus Vols. 5-6").seriesTitle).toBe("Blue Giant");
    expect(packaging("The Way of the Househusband, Vol. 1-3 (Omnibus)")).toMatchObject({
      seriesTitle: "The Way of the Househusband",
      packaging: { lineName: "Omnibus", coverRange: { from: "1", to: "3" } },
    });
  });

  it("never turns an omnibus number into a volume label", () => {
    // Coverage unknown: the number is the line position only.
    expect(packaging("Negima! Omnibus 4", 4)).toEqual({
      seriesTitle: "Negima!",
      volumeLabel: null,
      packaging: { lineName: "Omnibus", linePosition: "4", coverRange: null },
      isBox: false,
    });
    expect(packaging("Ichi the Killer (Omnibus) Vol. 1")).toMatchObject({
      seriesTitle: "Ichi the Killer",
      volumeLabel: null,
      packaging: { lineName: "Omnibus", linePosition: "1" },
    });
    expect(packaging("Astro Boy Omnibus Volume 7", 7).packaging?.linePosition).toBe("7");
  });

  it("reads deluxe, collector's, n-in-1, anniversary and complete lines", () => {
    expect(
      packaging("Monster Musume: Deluxe Edition 1 (Vol. 1-3 Hardcover Omnibus)", 1),
    ).toMatchObject({
      seriesTitle: "Monster Musume",
      packaging: {
        lineName: "Deluxe Edition",
        linePosition: "1",
        coverRange: { from: "1", to: "3" },
      },
    });
    expect(
      packaging(
        "The Girl From the Other Side: Siúil, a Rún Deluxe Edition IV (Vol. 10-11+EX Hardcover Omnibus)",
      ),
    ).toMatchObject({
      seriesTitle: "The Girl From the Other Side: Siúil, a Rún",
      packaging: {
        lineName: "Deluxe Edition",
        linePosition: "IV",
        coverRange: { from: "10", to: "11" },
      },
    });
    expect(packaging("Vinland Saga Deluxe 1", 1).packaging).toMatchObject({
      lineName: "Deluxe",
      linePosition: "1",
    });
    expect(packaging("Blade of the Immortal Deluxe Volume 10").seriesTitle).toBe(
      "Blade of the Immortal",
    );
    expect(packaging("Rozen Maiden Collector's Edition Vol. 2")).toMatchObject({
      seriesTitle: "Rozen Maiden",
      packaging: { lineName: "Collector's Edition", linePosition: "2" },
    });
    expect(packaging("Tarot Café: The Collector’s Edition, Volume 2").seriesTitle).toBe(
      "Tarot Café",
    );
    expect(packaging("Aoashi (3-in-1 Edition) Volume 2 (Vol. 4,5,6)", 2)).toMatchObject({
      seriesTitle: "Aoashi",
      packaging: {
        lineName: "3-in-1 Edition",
        linePosition: "2",
        coverRange: { from: "4", to: "6" },
      },
    });
    expect(packaging("Darwin's Game (3-in-1 Edition) (Vol.1, 2, 3) Vol.1").packaging).toEqual({
      lineName: "3-in-1 Edition",
      linePosition: "1",
      coverRange: { from: "1", to: "3" },
    });
    expect(packaging("MARS 30th Anniversary Edition")).toMatchObject({
      seriesTitle: "MARS",
      packaging: { lineName: "30th Anniversary Edition" },
    });
    expect(packaging("Soul Eater: The Perfect Edition 03").packaging).toMatchObject({
      lineName: "Perfect Edition",
      linePosition: "3",
    });
    expect(packaging("orange: The Complete Collection 1").packaging).toMatchObject({
      lineName: "Complete Collection",
      linePosition: "1",
    });
    expect(packaging("Ajin: Demi-Human Complete 3").seriesTitle).toBe("Ajin: Demi-Human");
    expect(packaging("Sailor Moon 9 (Naoko Takeuchi Collection)", 9)).toMatchObject({
      seriesTitle: "Sailor Moon",
      volumeLabel: null,
      packaging: { lineName: "Naoko Takeuchi Collection", linePosition: "9" },
    });
  });

  it("reads the publishers' premium line names (2026 survey)", () => {
    const cases: Array<[string, string, string | null]> = [
      ["Death Note Black Edition, Vol. 3", "Black Edition", "3"],
      ["Fullmetal Alchemist: Fullmetal Edition, Vol. 16", "Fullmetal Edition", "16"],
      ["Witch Hat Atelier: Grimoire Edition 2", "Grimoire Edition", "2"],
      ["Vagabond Definitive Edition, Vol. 4", "Definitive Edition", "4"],
      // tidyLineName drops binding words: "Hardcover" is not part of the line name.
      [
        "Attack on Titan Definitive Hardcover Collection 1 (Vol. 1-3)",
        "Definitive Collection",
        "1",
      ],
      ["The Legend of Zelda: Legendary Edition, Vol. 2", "Legendary Edition", "2"],
      ["Fruits Basket Ultimate Edition Volume 6", "Ultimate Edition", "6"],
      ["Parasyte Full Color Collection 1", "Full Color Collection", "1"],
      ["PandoraHearts Limited Edition Omnibus 3", "Limited Edition Omnibus", "3"],
      ["Uzumaki (3-in-1 Deluxe Edition)", "3-in-1 Deluxe Edition", null],
      ["Death Note (All-in-One Edition)", "All-in-One Edition", null],
    ];
    for (const [title, lineName, linePosition] of cases) {
      expect(packaging(title).packaging, title).toMatchObject({ lineName, linePosition });
    }
    expect(
      packaging("Attack on Titan Definitive Hardcover Collection 1 (Vol. 1-3)").packaging,
    ).toMatchObject({
      coverRange: { from: "1", to: "3" },
    });
    // Reprints and variants are not packaging.
    for (const title of [
      "Black Jack Volume 3, Special Edition",
      "Usagi Yojimbo Saga Volume 1 Limited Edition",
    ]) {
      expect(packaging(title).packaging, title).toBeNull();
    }
  });

  it("marks box sets and slipcases as bundles", () => {
    expect(packaging("Fire Force Manga Box Set 1 (Vol. 1-6)", 1)).toEqual({
      seriesTitle: "Fire Force",
      volumeLabel: null,
      packaging: {
        lineName: "Box Set",
        linePosition: "1",
        coverRange: { from: "1", to: "6" },
      },
      isBox: true,
    });
    expect(packaging("Attack on Titan Season 3 Part 2 Manga Box Set")).toMatchObject({
      seriesTitle: "Attack on Titan",
      packaging: { lineName: "Box Set", linePosition: "Season 3 Part 2" },
      isBox: true,
    });
    expect(
      packaging("Attack on Titan The Final Season Part 2 Manga Box Set").packaging,
    ).toMatchObject({ linePosition: "Final Season Part 2" });
    expect(packaging("Twilight Out of Focus Box Set")).toMatchObject({
      seriesTitle: "Twilight Out of Focus",
      isBox: true,
    });
    expect(packaging("Ryuko Vol. 1 & 2 Slipcase Set")).toMatchObject({
      seriesTitle: "Ryuko",
      packaging: { coverRange: { from: "1", to: "2" } },
      isBox: true,
    });
    expect(packaging("Sherlock: A Scandal in Belgravia 1-2 Slipcase Set").seriesTitle).toBe(
      "Sherlock: A Scandal in Belgravia",
    );
    expect(
      packaging("Sailor Moon Manga Box Set Vol. 1-6 (Naoko Takeuchi Collection)"),
    ).toMatchObject({
      seriesTitle: "Sailor Moon",
      packaging: { lineName: "Box Set", coverRange: { from: "1", to: "6" } },
      isBox: true,
    });
    expect(packaging("Battle Angel Alita Deluxe Complete Series Box Set")).toMatchObject({
      seriesTitle: "Battle Angel Alita",
      isBox: true,
    });
  });

  it("treats a bare range as multi-volume coverage with no line", () => {
    expect(packaging("DARLING in the FRANXX Vol. 7-8").packaging).toEqual({
      lineName: null,
      linePosition: null,
      coverRange: { from: "7", to: "8" },
    });
    expect(packaging("Astro Boy 1 & 2", 2)).toMatchObject({
      seriesTitle: "Astro Boy",
      packaging: { coverRange: { from: "1", to: "2" } },
    });
    expect(packaging("Tomo-chan Is a Girl! Volumes 1-3").seriesTitle).toBe("Tomo-chan Is a Girl!");
  });

  // B18: a list with a gap names exactly its Volumes; a from–to range over
  // it would claim the ones it skips. It stays packaging, with no coverage,
  // marked gapped (R12) so no weaker signal fills the coverage in.
  it("never widens a gapped volume list into a range", () => {
    expect(packaging("Alpha Vol. 1 & 3")).toEqual(
      packagedAlpha({ lineName: null, linePosition: null, coverRange: null, coverageGapped: true }),
    );
    expect(packaging("Alpha Omnibus (Vol. 1, 3)").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: null,
      coverageGapped: true,
    });
    expect(packaging("Alpha Omnibus 1, 3").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: null,
      coverageGapped: true,
    });
    expect(packaging("Alpha 3-in-1 Edition 1 (Vol. 1 & 3)").packaging).toEqual({
      lineName: "3-in-1 Edition",
      linePosition: "1",
      coverRange: null,
      coverageGapped: true,
    });
    expect(packaging("Battle Angel Alita Deluxe 5 (Contains Vol. 9 & 11)").packaging).toMatchObject(
      { linePosition: "5", coverRange: null, coverageGapped: true },
    );
    expect(packaging("Alpha Vol. 1-3, 5").packaging).toMatchObject({
      coverRange: null,
      coverageGapped: true,
    });
    // Contiguous lists and chained ranges still span first to last.
    expect(packaging("Alpha Vol. 1, 2, 3").packaging).toEqual({
      lineName: null,
      linePosition: null,
      coverRange: { from: "1", to: "3" },
    });
    expect(packaging("Alpha Vol. 1-3, 4-6").packaging?.coverRange).toEqual({ from: "1", to: "6" });
    // Packaging that lists nothing is unknown, not gapped.
    expect(packaging("Negima! Omnibus 4").packaging?.coverageGapped).toBeUndefined();
  });

  // R12: a listed item may repeat the marker or carry "#"; the gap still shows.
  it("marks a gapped list whose items repeat the marker or carry '#'", () => {
    for (const title of [
      "Alpha 3-in-1 Edition 1 (Vol. 1 and Vol. 3)",
      "Alpha 3-in-1 Edition 1 (Vol. 1 & Vol. 3)",
      "Alpha 3-in-1 Edition 1 (Vol. #1 & #3)",
      "Alpha 3-in-1 Edition 1 (Includes Vols. 1 and 3)",
    ]) {
      expect(packaging(title), title).toEqual(
        packagedAlpha({
          lineName: "3-in-1 Edition",
          linePosition: "1",
          coverRange: null,
          coverageGapped: true,
        }),
      );
    }
    expect(packaging("Alpha Vol. 1 & Vol. 3").packaging).toMatchObject({
      coverRange: null,
      coverageGapped: true,
    });
    expect(
      packaging("Alpha 3-in-1 Edition 1 (Vol. 1, Vol. 2 and Vol. 3)").packaging?.coverRange,
    ).toEqual({
      from: "1",
      to: "3",
    });
  });

  // R12: every phrasing of a gapped or unreadable list is gapped, never
  // silence (the 3-in-1 size would fill it in) and never Volume 1 alone.
  it("marks gapped lists in -ing brackets, '+' lists, ', and' lists, and subtitles", () => {
    for (const title of [
      "Alpha 3-in-1 Edition 1 (Collecting Vols. 1 and 3)",
      "Alpha 3-in-1 Edition 1 (Including Vols. 1 and 3)",
      "Alpha 3-in-1 Edition 1 (Containing Vols. 1 and 3)",
      "Alpha 3-in-1 Edition 1 (Vol. 1 + Vol. 3)",
      "Alpha 3-in-1 Edition 1 (Includes Vol. 1 + 3)",
      "Alpha 3-in-1 Edition 1 (Vol. 1, 2, and 4)",
    ]) {
      expect(packaging(title), title).toEqual(
        packagedAlpha({
          lineName: "3-in-1 Edition",
          linePosition: "1",
          coverRange: null,
          coverageGapped: true,
        }),
      );
    }
    expect(packaging("Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1 & 3").packaging).toEqual({
      lineName: "3-in-1 Edition",
      linePosition: "1",
      coverRange: null,
      coverageGapped: true,
    });
    // A numbered extra after a list may be a Volume or a bonus book.
    expect(packaging("Alpha Omnibus 1 (Vol. 1-2 + 3)").packaging).toMatchObject({
      coverRange: null,
      coverageGapped: true,
    });
    // Contiguous forms still span first to last; a lettered extra is no Volume.
    expect(packaging("Alpha 3-in-1 Edition 1 (Vol. 1, 2, and 3)").packaging?.coverRange).toEqual({
      from: "1",
      to: "3",
    });
    expect(
      packaging("Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1-3").packaging?.coverRange,
    ).toEqual({
      from: "1",
      to: "3",
    });
    expect(packaging("Alpha Vol. 10-11+EX").packaging?.coverRange).toEqual({
      from: "10",
      to: "11",
    });
    expect(parseBookTitle("Alpha Vol. 18+1")).toMatchObject({
      volumeLabel: "18+1",
      packaging: null,
    });
  });

  // W02: a title statement reads only its Volume designation. Page counts
  // and other copy after it are prose, never coverage endpoints.
  it("reads a title statement's designation, never the numbers in the copy after it", () => {
    const cases: Array<[string, { from: string; to: string }]> = [
      ["Alpha Deluxe Edition 1 (Collecting Vol. 1 plus 16 pages of art)", { from: "1", to: "1" }],
      ["Alpha Deluxe Edition 1 (Containing Vol. 1 with 16 pages of art)", { from: "1", to: "1" }],
      ["Alpha Deluxe Edition 1 (Including Vol. 1 with 16 pages of art)", { from: "1", to: "1" }],
      ["Alpha Deluxe Edition 1 (Contains Vol. 9 in a 600-page hardcover)", { from: "9", to: "9" }],
      ["Alpha Deluxe Edition 1 (Collects Vol. 1 of 10)", { from: "1", to: "1" }],
      [
        "Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 16 pages of art)",
        { from: "1", to: "3" },
      ],
      ["Alpha 3-in-1 Edition 1 (Collecting Vol. 1 plus 16 pages of art)", { from: "1", to: "1" }],
      [
        "Alpha Deluxe Edition 1 (Collecting Vol. 1 and Vol. 2 bonus stories)",
        { from: "1", to: "2" },
      ],
    ];
    for (const [title, coverRange] of cases) {
      const found = packaging(title).packaging;
      expect(found?.coverRange, title).toEqual(coverRange);
      expect(found?.coverageGapped, title).toBeUndefined();
    }
    expect(
      packaging("Battle Angel Alita Deluxe 5 (Contains Vol. 9 & Ashen Victor)").packaging
        ?.coverRange,
    ).toEqual({ from: "9", to: "9" });
  });

  // W02: a bare last number after "and", "&", or a comma with copy after it
  // may count something else, and a title has no size to settle it; a join
  // and a number the designation never read leaves it unfinished. Either
  // way the coverage is unknown, never a guess.
  it("leaves a title statement unknown when its last number may count the copy after it", () => {
    for (const title of [
      "Alpha Deluxe Edition 1 (Collecting Vol. 1 and 2 bonus stories)",
      "Alpha Deluxe Edition 1 (Collecting Vols. 1-3 and 4 bonus stories)",
      "Alpha Deluxe Edition 1 (Collecting Vols. 1-3, 4 bonus stories)",
      "Alpha 3-in-1 Edition 1 (Includes Vol. 1 + 3)",
    ]) {
      expect(packaging(title).packaging, title).toMatchObject({
        coverRange: null,
        coverageGapped: true,
      });
    }
    // A bare number after a join is read when the statement ends after it,
    // as in a blurb ("Collects volumes 1-3 plus 4").
    const plus4 = packaging("Alpha Deluxe Edition 1 (Collecting Vols. 1-3 plus 4)").packaging;
    expect(plus4?.coverRange).toEqual({ from: "1", to: "4" });
    expect(plus4?.coverageGapped).toBeUndefined();
  });

  // W02: a marked item or a range joined past the designation ("plus Vol. 2",
  // "as well as Vols. 4-6") is a Volume whatever copy follows it. Dropping it
  // would silently shorten the coverage; each item is judged for contiguity.
  it("reads a marked item or range a title statement joins with plus, as well as, or along with", () => {
    const read: Array<[string, { from: string; to: string }]> = [
      ["Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vol. 2)", { from: "1", to: "2" }],
      ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 4)", { from: "1", to: "4" }],
      [
        "Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 4 bonus stories)",
        { from: "1", to: "4" },
      ],
      ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vols. 4-6)", { from: "1", to: "6" }],
      ["Alpha Deluxe Edition 1 (Collects Vol. 1 as well as Vol. 2)", { from: "1", to: "2" }],
      [
        "Alpha Deluxe Edition 1 (Collects Vol. 1 along with Vol. 2 and a bonus chapter)",
        { from: "1", to: "2" },
      ],
      ["Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus #4)", { from: "1", to: "4" }],
      ["Alpha Deluxe Edition 1 (Collects Vols. 1-3, plus 4-6 in one book)", { from: "1", to: "6" }],
      ["Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vol. 2 plus Vol. 3)", { from: "1", to: "3" }],
    ];
    for (const [title, coverRange] of read) {
      const found = packaging(title).packaging;
      expect(found?.coverRange, title).toEqual(coverRange);
      expect(found?.coverageGapped, title).toBeUndefined();
    }
    for (const title of [
      "Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 5)",
      "Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vols. 5-6 in one book)",
      "Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vol. 2 + 4)",
      "Alpha Deluxe Edition 1 (Collects Vol. 1 plus Vols. 2 and 3 bonus stories)",
      "Alpha Deluxe Edition 1 (Collects Vol. 1 as well as 3)",
      // "and 16" is a bare last item with copy after it: it may count the copy.
      "Alpha Deluxe Edition 1 (Collects Vol. 1 along with Vol. 2 and 16 pages of art)",
      // A half Volume is read whole, never cut to Volume 4: no range holds it.
      "Alpha Deluxe Edition 1 (Collects Vol. 3 plus Vol. 4.5)",
      // A possessive names what Volume 4 holds: it may or may not be
      // collected, and a title has no size to settle it. Never shortened.
      "Alpha Deluxe Edition 1 (Collects Vols. 1-3 plus Vol. 4's bonus chapter)",
    ]) {
      expect(packaging(title).packaging, title).toMatchObject({
        coverRange: null,
        coverageGapped: true,
      });
    }
  });

  // N01: a title statement is read by the blurb grammar, so ordinary list
  // continuations after a joined range ("plus 4-6 and 7-9") are read, a gap
  // blocks, and a list that reads two ways stays unknown, never shortened.
  it("reads ordinary list continuations after a joined range as the blurb grammar does", () => {
    const read: Array<[string, { from: string; to: string }]> = [
      ["plus 4-6 and 7-9 in one book", { from: "1", to: "9" }],
      ["plus 4-6, 7-9 in one book", { from: "1", to: "9" }],
      ["plus 4-6 & 7-9 in one book", { from: "1", to: "9" }],
      ["plus 4-6 and Vol. 7-9 in one book", { from: "1", to: "9" }],
      ["plus 4-6 and 7-9", { from: "1", to: "9" }],
      ["plus 4-6 and 7", { from: "1", to: "7" }],
    ];
    for (const [tail, coverRange] of read) {
      const title = `Alpha Deluxe Edition 1 (Collects Vols. 1-3 ${tail})`;
      const found = packaging(title).packaging;
      expect(found?.coverRange, title).toEqual(coverRange);
      expect(found?.coverageGapped, title).toBeUndefined();
    }
    for (const tail of [
      "plus 4-6 and 8-9 in one book",
      "plus 4-6 and 8-9",
      "plus 4-6 and 7 in one book",
      "plus Vol. 4 and 5 bonus stories",
      "plus Vol. 4, 5 and 6 in one book",
      "plus Vol. 4's bonus chapter",
      "plus Vol. 4’s bonus chapter",
      "plus Vol. 4'S bonus chapter",
    ]) {
      const title = `Alpha Deluxe Edition 1 (Collects Vols. 1-3 ${tail})`;
      expect(packaging(title).packaging, title).toMatchObject({
        coverRange: null,
        coverageGapped: true,
      });
    }
  });

  // N04: everything a title states about its coverage must agree. A
  // statement no range holds (a gap, a possessive) is never replaced by a
  // range stated elsewhere in the title, and two ranges that differ are no
  // range at all: the book stays unknown, never on a guess.
  it("never lets a designation outside the brackets stand in for a rejected bracket statement", () => {
    const REJECTED = { coverRange: null, coverageGapped: true };
    for (const outer of [
      "Alpha, Vol. 1-9",
      "Alpha Deluxe Edition Vol. 1-9",
      "Alpha Omnibus 1-9",
      "Alpha (Omnibus) Vol. 1-9",
      "Alpha 3-in-1 Edition Vol. 1-9",
      "Alpha Vol. 1-9 Box Set",
    ]) {
      for (const bracket of [
        "(Collects Vols. 1-3 plus Vol. 4's bonus chapter)",
        "(Collects Vols. 1-3 plus Vol. 4’s bonus chapter)",
        "(Collects Vols. 1-3 plus Vol. 4&#8217;s bonus chapter)",
        "(Collects Vols. 1-3 plus 4-6 and 8-9 in one book)",
        "(Vol. 1 & 3)",
        // Two ranges that disagree.
        "(Collects Vols. 1-3)",
        "(Vol. 1-3)",
        "(Collects Vol. 5)",
      ]) {
        const title = `${outer} ${bracket}`;
        expect(packaging(title).packaging, title).toMatchObject(REJECTED);
      }
      // Two ranges that agree are one statement made twice.
      for (const bracket of [
        "(Collects Vols. 1-3 plus 4-6 and 7-9 in one book)",
        "(Collects Vols. 1-9)",
        "(Vol. 1-9)",
      ]) {
        const title = `${outer} ${bracket}`;
        const found = packaging(title).packaging;
        expect(found?.coverRange, title).toEqual({ from: "1", to: "9" });
        expect(found?.coverageGapped, title).toBeUndefined();
      }
    }
    // The review's own titles.
    expect(
      packaging("Alpha Deluxe Edition Vol. 1-9 (Collects Vols. 1-3 plus Vol. 4’s bonus chapter)")
        .packaging,
    ).toEqual({ lineName: "Deluxe Edition", linePosition: null, ...REJECTED });
    expect(packaging("Alpha, Vol. 1-9 (Collects Vols. 1-3 plus 4-6 and 8-9 in one book)")).toEqual(
      packagedAlpha({ lineName: null, linePosition: null, ...REJECTED }),
    );
  });

  it("holds every other pair of coverage statements in a title to the same rule", () => {
    const REJECTED = { coverRange: null, coverageGapped: true };
    for (const title of [
      // A gapped designation outside, a range in the bracket.
      "Alpha, Vol. 1 & 3 (Collects Vols. 1-3)",
      "Alpha Omnibus 1 & 3 (Vol. 1-3)",
      // Two brackets, in either order.
      "Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1 and 3)",
      "Alpha Deluxe Edition 1 (Collects Vols. 1 and 3) (Vol. 1-3)",
      "Alpha Deluxe Edition 1 (Vol. 1-3) (Vol. 4-6)",
      // A bracket before the designation.
      "Alpha (Collects Vols. 1 & 3) Vol. 1-3",
      // A subtitle statement beside a range.
      "Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1 & 3",
      "Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1-6",
    ]) {
      expect(packaging(title).packaging, title).toMatchObject(REJECTED);
    }
    // A carried subtitle (OpenLibrary) and a licensed bare range are designations too.
    const bracket = "(Collects Vols. 1-3 plus Vol. 4's bonus chapter)";
    const carried = parseBookTitle(`Alpha Deluxe Edition ${bracket}`, { subtitle: "Vol. 1-9" });
    expect(carried.packaging).toMatchObject(REJECTED);
    expect(packaging(`Alpha 1-9 ${bracket}`, 1).packaging).toMatchObject(REJECTED);
    // Agreement still maps. (A lone number beside a bracket stays a line
    // position: "Noragami Omnibus 7 (Vol. 19-21)" in the omnibus test.)
    expect(packaging("Alpha Deluxe Edition 1 (Vol. 1-3) (Collects Vols. 1-3)").packaging).toEqual({
      lineName: "Deluxe Edition",
      linePosition: "1",
      coverRange: { from: "1", to: "3" },
    });
    expect(
      packaging("Alpha (3-in-1 Edition), Vol. 1-3: Includes Vols. 1-3").packaging?.coverRange,
    ).toEqual({
      from: "1",
      to: "3",
    });
  });

  // N04 siblings: a list after a packaging phrase that a marker follows, and
  // a stated subtitle on a book with no Edition Line, are statements too and
  // meet the rest only in `agreed`.
  it("holds a list before a marker and a line-less subtitle statement to the same rule", () => {
    const REJECTED = { coverRange: null, coverageGapped: true };
    expect(packaging("Alpha 3-in-1 Edition 1 & 3, Vol. 1")).toEqual(
      packagedAlpha({ lineName: "3-in-1 Edition", linePosition: "1", ...REJECTED }),
    );
    expect(packaging("Alpha Omnibus 1-3 Vol. 4-6").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      ...REJECTED,
    });
    for (const title of [
      "Alpha, Vol. 1-3: Includes Vols. 1 & 3",
      "Alpha, Vol. 1-3: Includes Vols. 1-6",
    ]) {
      expect(packaging(title).packaging, title).toEqual({
        lineName: null,
        linePosition: null,
        ...REJECTED,
      });
    }
    // A subtitle statement against a bracket range on a line-less book.
    expect(packaging("Alpha, Vol. 1: Includes Vols. 1-3 (Vol. 4-6)").packaging).toMatchObject(
      REJECTED,
    );
    // Agreement maps.
    expect(packaging("Alpha Omnibus 1-3 Vol. 1-3").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: { from: "1", to: "3" },
    });
    expect(packaging("Alpha, Vol. 1-3: Includes Vols. 1-3").packaging).toEqual({
      lineName: null,
      linePosition: null,
      coverRange: { from: "1", to: "3" },
    });
    // A lone number after the phrase is a line position, never a statement.
    for (const title of ["Alpha Omnibus 2 (Vol. 4-6)", "Alpha Omnibus 2 Vol. 4-6"]) {
      expect(packaging(title).packaging, title).toEqual({
        lineName: "Omnibus",
        linePosition: "2",
        coverRange: { from: "4", to: "6" },
      });
    }
    // A plain Volume's subtitle stays display text: nothing makes it packaging.
    const plain = parseBookTitle("Alpha, Vol. 1: Includes Vols. 1 & 3");
    expect(plain).toMatchObject({
      volumeLabel: "1",
      volumeSubtitle: "Includes Vols. 1 & 3",
      packaging: null,
    });
  });

  // N04 follow-up: what else a title states about its coverage is read only
  // where it is marked (a Volume marker, a collect-verb, a packaging
  // bracket's own Volume list, a carried subtitle), and a list the grammar
  // cannot read stands against any range. Neither ever splits a Series name
  // or places a book the title's own words do not name.
  describe("reads a title's other marked statements and rejects what it cannot read", () => {
    const REJECTED = { coverRange: null, coverageGapped: true };
    const ONE_TO_THREE = { from: "1", to: "3" };

    it("reads a packaging bracket's own Volume list", () => {
      expect(packaging("Alpha 3-in-1 Edition 1 (Omnibus Vol. 1 & 3)").packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "1",
        ...REJECTED,
      });
      // A real PRH title names its line and its coverage in one bracket.
      expect(
        packaging("The Walking Cat: A Cat's-Eye-View of the Zombie Apocalypse (Omnibus Vol. 1-3)"),
      ).toEqual({
        seriesTitle: "The Walking Cat: A Cat's-Eye-View of the Zombie Apocalypse",
        volumeLabel: null,
        packaging: { lineName: "Omnibus", linePosition: null, coverRange: ONE_TO_THREE },
        isBox: false,
      });
      expect(packaging("Alpha (Omnibus Vol. 1-3) Vol. 2").packaging).toEqual({
        lineName: "Omnibus",
        linePosition: "2",
        coverRange: ONE_TO_THREE,
      });
      // An unmarked list there stays in the line name, unread, so it stands against the rest.
      expect(packaging("Alpha (Omnibus 1-3) Vol. 4-6").packaging).toEqual({
        lineName: "Omnibus 1-3",
        linePosition: null,
        ...REJECTED,
      });
      expect(packaging("Alpha (3-in-1 Edition 1 & 3), Vol. 1")).toEqual(
        packagedAlpha({ lineName: "3-in-1 Edition 1 & 3", linePosition: "1", ...REJECTED }),
      );
    });

    it("reads a subtitle statement after a packaging phrase's own number or list", () => {
      for (const [title, linePosition] of [
        ["Alpha Deluxe Edition 1-3: Includes Vols. 4-6", null],
        ["Alpha 3-in-1 Edition 1 & 3: Includes Vols. 1-3", null],
        ["Alpha 3-in-1 Edition 2: Includes Vols. 1 & 3", "2"],
      ] as const) {
        const lineName = title.includes("Deluxe") ? "Deluxe Edition" : "3-in-1 Edition";
        expect(packaging(title), title).toEqual(
          packagedAlpha({ lineName, linePosition, ...REJECTED }),
        );
      }
      // Real Viz titles: the statement no longer swallows the line into the Series.
      expect(packaging("Dragonball 3-in-1 Edition 1: Includes vols. 1, 2 & 3")).toEqual({
        seriesTitle: "Dragonball",
        volumeLabel: null,
        packaging: { lineName: "3-in-1 Edition", linePosition: "1", coverRange: ONE_TO_THREE },
        isBox: false,
      });
      expect(packaging("Alpha Deluxe Edition 1-3: Includes Vols. 1-3").packaging).toEqual({
        lineName: "Deluxe Edition",
        linePosition: null,
        coverRange: ONE_TO_THREE,
      });
      // Anywhere else the marker grammar reads the title as before.
      expect(parseBookTitle("Alpha, Vol. 2: Includes Vols. 4-6")).toMatchObject({
        seriesTitle: "Alpha",
        volumeLabel: "2",
        packaging: null,
      });
      expect(parseBookTitle("Alpha, Vol. 2 (Manga): Includes Vols. 4-6")).toMatchObject({
        volumeLabel: null,
        packaging: { coverRange: { from: "4", to: "6" } },
      });
    });

    it("reads a packaged book's subtitle that is only a list", () => {
      for (const subtitle of ["Vols. 1 & 3", "Volumes 1 & 3", "Vol. 1 & 3"]) {
        const title = `Alpha 3-in-1 Edition, Vol. 1: ${subtitle}`;
        expect(packaging(title).packaging, title).toEqual({
          lineName: "3-in-1 Edition",
          linePosition: "1",
          ...REJECTED,
        });
      }
      // The lone "Vol. 1" is the line position, so the list is the one statement.
      expect(packaging("Alpha 3-in-1 Edition, Vol. 1: Vols. 1-3").packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "1",
        coverRange: ONE_TO_THREE,
      });
      expect(packaging("Alpha 3-in-1 Edition, Vol. 2: Vols. 4-6").packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "2",
        coverRange: { from: "4", to: "6" },
      });
      // A plain Volume's subtitle stays display text.
      expect(parseBookTitle("Alpha, Vol. 1: Vols. 1 & 3")).toMatchObject({
        volumeLabel: "1",
        volumeSubtitle: "Vols. 1 & 3",
        packaging: null,
      });
    });

    it("reads a carried subtitle's Volume list beside a packaged book's own designation", () => {
      for (const subtitle of ["Vol. 1 & 3", "Vol. 4-6"]) {
        expect(
          parseBookTitle("Alpha Omnibus Vol. 1-3", { subtitle }).packaging,
          subtitle,
        ).toMatchObject(REJECTED);
      }
      for (const subtitle of ["Vol. 1-3", "Vol. 2"]) {
        expect(parseBookTitle("Alpha Omnibus Vol. 1-3", { subtitle }).packaging, subtitle).toEqual({
          lineName: "Omnibus",
          linePosition: null,
          coverRange: ONE_TO_THREE,
        });
      }
      // "Alpha (3-in-1 Edition), Vol. 1" is "Alpha 3-in-1 Edition 1": the same subtitle reads the same.
      for (const subtitle of ["Vol. 1 & 3", "Vols. 4-6", "Vols. 1-3"]) {
        expect(
          parseBookTitle("Alpha (3-in-1 Edition), Vol. 1", { subtitle }).packaging,
          subtitle,
        ).toEqual(parseBookTitle("Alpha 3-in-1 Edition 1", { subtitle }).packaging);
      }
      expect(
        parseBookTitle("Alpha (3-in-1 Edition), Vol. 1", { subtitle: "Vol. 1 & 3" }).packaging,
      ).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "1",
        ...REJECTED,
      });
      // A real OpenLibrary pair.
      expect(
        parseBookTitle("Aoashi (3-in-1 Edition) Volume 3", { subtitle: "Vol. 7,8,9" }).packaging,
      ).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "3",
        coverRange: { from: "7", to: "9" },
      });
      // The carried list's own subtitle is a statement too.
      expect(
        parseBookTitle("Alpha Omnibus Vol. 1-3", { subtitle: "Vol. 1-3: Includes Vols. 1 & 3" })
          .packaging,
      ).toMatchObject(REJECTED);
      expect(
        parseBookTitle("Alpha Omnibus Vol. 1-3", { subtitle: "Vol. 1-3: Includes Vols. 1-3" })
          .packaging,
      ).toEqual({ lineName: "Omnibus", linePosition: null, coverRange: ONE_TO_THREE });
      // A plain Volume keeps its label, and a Part list is no Volume list.
      expect(parseBookTitle("Alpha, Vol. 1", { subtitle: "Vols. 1 & 3" })).toMatchObject({
        volumeLabel: "1",
        packaging: null,
      });
      expect(parseBookTitle("Alpha (Omnibus), Vol. 2", { subtitle: "Part 1-2" }).packaging).toEqual(
        {
          lineName: "Omnibus",
          linePosition: "2",
          coverRange: null,
        },
      );
    });

    // The verdict's second site: the packaging bracket the bare number peels
    // counts, so the carried statement is read as it is beside "Vol. 2".
    it("reads a carried statement beside a packaged book's bare number", () => {
      const subtitle = "Vol. 1-3: Includes Vols. 1 & 3";
      expect(parseBookTitle("Alpha (3-in-1 Edition) 2 (Manga)", { subtitle }).packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "2",
        ...REJECTED,
      });
      expect(parseBookTitle("Alpha (3-in-1 Edition) 2 (Manga)", { subtitle }).packaging).toEqual(
        parseBookTitle("Alpha (3-in-1 Edition), Vol. 2", { subtitle }).packaging,
      );
      expect(
        parseBookTitle("Alpha (Omnibus) 2 (Manga)", { subtitle: "Vol. 4-6: Includes Vols. 4 & 6" })
          .packaging,
      ).toEqual({ lineName: "Omnibus", linePosition: "2", ...REJECTED });
    });

    it("reads a carried subtitle that is only a statement", () => {
      for (const [title, subtitle] of [
        ["Alpha (3-in-1 Edition), Vol. 1-3", "Includes Vols. 1 & 3"],
        ["Alpha Omnibus Vol. 1-3", "Includes Vols. 1 & 3"],
        ["Alpha Omnibus Vol. 1-3", "Includes Vols. 1-6"],
        ["Dragon Ball (3-in-1 Edition), Vol. 1", "Includes vols. 1 & 3"],
      ] as const) {
        expect(
          parseBookTitle(title, { subtitle }).packaging,
          `${title} / ${subtitle}`,
        ).toMatchObject(REJECTED);
      }
      expect(
        parseBookTitle("Alpha Omnibus Vol. 1-3", { subtitle: "Includes Vols. 1-3" }).packaging,
      ).toEqual({
        lineName: "Omnibus",
        linePosition: null,
        coverRange: ONE_TO_THREE,
      });
      const dragonBall = parseBookTitle("Dragon Ball (3-in-1 Edition), Vol. 1", {
        subtitle: "Includes vols. 1, 2 & 3",
      });
      expect(dragonBall.packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "1",
        coverRange: ONE_TO_THREE,
      });
      // A plain Volume's carried statement stays its display subtitle (accepted limit).
      expect(parseBookTitle("Alpha, Vol. 1", { subtitle: "Includes Vols. 1 & 3" })).toMatchObject({
        volumeLabel: "1",
        packaging: null,
      });
    });

    // The backstop: a Volume list or a phrase's list the grammar leaves in a
    // packaged book's Series title, line name or subtitle was stated but
    // never read, so no range and no line size stands in for it. The Series
    // title stays as the grammar read it.
    it("rejects a packaged book that leaves a Volume list or a phrase's list unread", () => {
      for (const [title, seriesTitle] of [
        ["Alpha Vol. 1 & 3 Vol. 1-3", "Alpha Vol. 1 & 3"],
        ["Alpha Vol. 1 & 3 3-in-1 Edition 1", "Alpha Vol. 1 & 3"],
        ["Alpha Vol. 4-6 Omnibus 2", "Alpha Vol. 4-6"],
        ["Alpha Vol. 4-6 Omnibus 1-3", "Alpha Vol. 4-6"],
        ["Alpha Omnibus 1 & 3 Deluxe Edition 2 Vol. 4-6", "Alpha Omnibus 1 & 3"],
        ["Alpha Omnibus 1-3 Box Set Vol. 4-6", "Alpha Omnibus 1-3"],
        ["Alpha Omnibus 1-3 Vol. 4-6 Box Set", "Alpha Omnibus 1-3"],
        // A real OpenLibrary box set: "Gift" hides the list from the marker.
        ["Prince Valiant Vols. 19-21, Gift Box Set", "Prince Valiant Vols. 19-21, Gift"],
        // The verdict's first site: a phrase's list in a marker's subtitle, or before a later phrase.
        ["Alpha Vol. 1-3 Omnibus 1 & 3 Deluxe Edition 1", "Alpha Vol. 1-3 Omnibus 1 & 3"],
        ["Alpha Omnibus 1 & 3 Vol. 1-3 Deluxe Edition 1", "Alpha Omnibus 1 & 3 Vol. 1-3"],
        ["Alpha Vol. 4-6 Omnibus 1-3 Deluxe Edition 2", "Alpha Vol. 4-6 Omnibus 1-3"],
        ["Alpha Vol. 4-6 Omnibus 1-3 Box Set", "Alpha"],
        ["Alpha, Vol. 1-3 Omnibus 1 & 3: Cloud Dragon", "Alpha"],
        ["Alpha Vol. 1-3 Omnibus 4-6 Hardcover", "Alpha"],
      ] as const) {
        const found = parseBookTitle(title);
        expect(found.seriesTitle, title).toBe(seriesTitle);
        expect(found.packaging, title).toMatchObject(REJECTED);
      }
      expect(
        parseBookTitle("Alpha Vol. 1-3", { subtitle: "Omnibus 1 & 3" }).packaging,
      ).toMatchObject(REJECTED);
      // Years are no Volumes, and a plain book is no packaging.
      expect(packaging("The Complete Peanuts 1950-1954 Gift Box Set").packaging).toEqual({
        lineName: "Box Set",
        linePosition: null,
        coverRange: null,
      });
      expect(parseBookTitle("Alpha 1 & 2 (Manga) Vol. 3")).toMatchObject({
        seriesTitle: "Alpha 1 & 2",
        volumeLabel: "3",
        packaging: null,
      });
      expect(parseBookTitle("Junk (Volume 1-7) Set").packaging).toBeNull();
    });

    // An unmarked list and a Part or Book list belong to the name: they
    // never split a Series, place a book or reject one, and the parse is
    // the one the title always had.
    it("leaves an unmarked list and a Part or Book list in the name", () => {
      for (const [title, seriesTitle, found] of [
        [
          "Persona 3 & 4 Omnibus 1",
          "Persona 3 & 4",
          { lineName: "Omnibus", linePosition: "1", coverRange: null },
        ],
        [
          "Persona 3 & 4 3-in-1 Edition 1",
          "Persona 3 & 4",
          { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null },
        ],
        [
          "Tokyo 24-7 Deluxe Edition 1",
          "Tokyo 24-7",
          { lineName: "Deluxe Edition", linePosition: "1", coverRange: null },
        ],
        [
          "Alpha Book 1-2 Omnibus 1",
          "Alpha Book 1-2",
          { lineName: "Omnibus", linePosition: "1", coverRange: null },
        ],
        [
          "Alpha Part 1-2 Omnibus 1 (Vol. 1-3)",
          "Alpha Part 1-2",
          { lineName: "Omnibus", linePosition: "1", coverRange: ONE_TO_THREE },
        ],
        [
          "Alpha Part 1-2, Vol. 1-3",
          "Alpha Part 1-2",
          { lineName: null, linePosition: null, coverRange: ONE_TO_THREE },
        ],
        [
          "Alpha Part 4 Deluxe Edition 3 (Vol. 7-9)",
          "Alpha Part 4",
          { lineName: "Deluxe Edition", linePosition: "3", coverRange: { from: "7", to: "9" } },
        ],
        [
          "Alpha 1 & 3 3-in-1 Edition 1",
          "Alpha 1 & 3",
          { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null },
        ],
        [
          "Alpha 1, 2 & 3 Omnibus 2",
          "Alpha 1, 2 & 3",
          { lineName: "Omnibus", linePosition: "2", coverRange: null },
        ],
        [
          "Alpha 1 & 3 (Omnibus) Vol. 2",
          "Alpha 1 & 3",
          { lineName: "Omnibus", linePosition: "2", coverRange: null },
        ],
        [
          "Alpha 1-3 (Vol. 4-6)",
          "Alpha 1-3",
          { lineName: null, linePosition: null, coverRange: { from: "4", to: "6" } },
        ],
        // A phrase's range beside a lone number is no statement of its own.
        [
          "Alpha Omnibus 1-3 Vol. 2",
          "Alpha",
          { lineName: "Omnibus", linePosition: "2", coverRange: null },
        ],
        [
          "Alpha Omnibus 1-3 Box Set",
          "Alpha Omnibus",
          { lineName: "Box Set", linePosition: null, coverRange: ONE_TO_THREE },
        ],
      ] as const) {
        const parsed = parseBookTitle(title);
        expect(parsed.seriesTitle, title).toBe(seriesTitle);
        expect(parsed.packaging, title).toEqual(found);
      }
      expect(parseBookTitle("Alpha, Part 1, Vol. 2")).toMatchObject({
        volumeLabel: "2",
        packaging: null,
      });
      // A whole title with a list is never cut into a name and a range.
      expect(parseBookTitle("Getting smart with Lotus 1-2-3", { seriesNumber: 1 })).toMatchObject({
        seriesTitle: "Getting smart with Lotus 1-2-3",
        packaging: null,
      });
      expect(parseBookTitle("Bone, tomes 5, 6, 7, 8", { seriesNumber: 8 }).packaging).toBeNull();
    });

    it("never takes a thousands-separated number in a Series name for a list", () => {
      const SAVING = "Saving 80,000 Gold in Another World for My Retirement";
      expect(packaging(`${SAVING} Omnibus 1 (Vol. 1-3)`)).toEqual({
        seriesTitle: SAVING,
        volumeLabel: null,
        packaging: { lineName: "Omnibus", linePosition: "1", coverRange: ONE_TO_THREE },
        isBox: false,
      });
      expect(packaging(`${SAVING}, Vol. 1-3`)).toEqual({
        seriesTitle: SAVING,
        volumeLabel: null,
        packaging: { lineName: null, linePosition: null, coverRange: ONE_TO_THREE },
        isBox: false,
      });
      expect(packaging(`${SAVING} 3-in-1 Edition 1`).packaging).toEqual({
        lineName: "3-in-1 Edition",
        linePosition: "1",
        coverRange: null,
      });
      expect(packaging("I'm Standing on 1,000,000 Lives Omnibus 1 (Vol. 1-2)").packaging).toEqual({
        lineName: "Omnibus",
        linePosition: "1",
        coverRange: { from: "1", to: "2" },
      });
      expect(packaging("Alpha 3,000 & 1 Omnibus 1 (Vol. 1-3)")).toEqual({
        seriesTitle: "Alpha 3,000 & 1",
        volumeLabel: null,
        packaging: { lineName: "Omnibus", linePosition: "1", coverRange: ONE_TO_THREE },
        isBox: false,
      });
      expect(packaging("Alpha 1,000-1,002 Omnibus").packaging).toEqual({
        lineName: "Omnibus",
        linePosition: null,
        coverRange: null,
      });
    });

    it("keeps a lone line position a position, never a statement", () => {
      for (const [title, linePosition, coverRange] of [
        ["Alpha Omnibus 2.5", "2.5", null],
        ["Alpha Omnibus Two", "Two", null],
        ["Alpha Deluxe Edition IV", "IV", null],
        ["Alpha Omnibus Book 2", "2", null],
      ] as const) {
        const found = parseBookTitle(title).packaging;
        expect(found?.linePosition, title).toBe(linePosition);
        expect(found?.coverRange, title).toEqual(coverRange);
        expect(found?.coverageGapped, title).toBeUndefined();
      }
    });

    // A trailing statement is split off only where the marker grammar would
    // take its "Vols." for the designation. Where an earlier marker
    // designates the book, the title reads as it always did: a plain Volume
    // keeps its subtitle as display text, and the Series keeps its name.
    it("splits off a trailing statement only where the marker grammar would read it", () => {
      for (const [title, seriesTitle, volumeLabel] of [
        ["Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3", "Alpha", "2"],
        ["Alpha, Vol. 2 - 3-in-1 Edition 1: Includes Vols. 1-3", "Alpha", "2"],
        ["Alpha, Vol. 2: Omnibus 1 - Includes Vols. 4-6", "Alpha", "2"],
        ["Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1 & 3", "Alpha", "2"],
        ["Alpha Part 2: Omnibus 1: Includes Vols. 1-3", "Alpha", "2"],
        ["Alpha: Part 4 - Diamond Deluxe Edition 1: Includes Vols. 1-3", "Alpha", "4"],
        ["Alpha Vol. 3: Box Set 1: Includes Vols. 1-3", "Alpha", "3"],
        ["Catch-22, Volume Two: Omnibus 2 (Vol. 2): Contains Volumes 1, 2, and 3", "Catch-22", "2"],
      ] as const) {
        expect(parseBookTitle(title), title).toMatchObject({
          seriesTitle,
          volumeLabel,
          packaging: null,
          isBox: false,
        });
      }
      for (const [title, seriesTitle] of [
        ["Alpha Omnibus Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha Omnibus"],
        ["Alpha 3-in-1 Edition Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha 3-in-1 Edition"],
        ["Alpha Box Set Omnibus Vol. 1-3: Includes Vols. 1-3", "Alpha Box Set"],
      ] as const) {
        expect(packaging(title), title).toEqual({
          seriesTitle,
          volumeLabel: null,
          packaging: { lineName: "Omnibus", linePosition: null, coverRange: ONE_TO_THREE },
          isBox: false,
        });
      }
      expect(
        packaging("Blade Runner 2049: Vol. 4-6: Complete 3: Includes Vol. 4 (Vol. 4-6)"),
      ).toEqual({
        seriesTitle: "Blade Runner 2049",
        volumeLabel: null,
        packaging: { lineName: null, linePosition: null, coverRange: { from: "4", to: "6" } },
        isBox: false,
      });
      // The phrase's list in the Book list's subtitle still stands against it.
      expect(packaging("Alpha Book 1-2: Deluxe Edition 1-3: Includes Vols. 1-3")).toEqual(
        packagedAlpha({ lineName: null, linePosition: null, ...REJECTED }),
      );
      // Where the statement's own "Vols." would be the designation, the split stands.
      expect(packaging("Alpha Part 4 Omnibus 1: Includes Vols. 1-3")).toEqual({
        seriesTitle: "Alpha Part 4",
        volumeLabel: null,
        packaging: { lineName: "Omnibus", linePosition: "1", coverRange: ONE_TO_THREE },
        isBox: false,
      });
    });

    // A dash chain ("2 - 4-6", "4-6-8") spans its first number to its last,
    // so where the title read no list before it is a statement no range holds.
    it("never reads a dash chain as a range where the title read no list before", () => {
      for (const [title, subtitle] of [
        ["Alpha Omnibus, Vol. 2: Vol. 2 - 4-6", null],
        ["Alpha (Omnibus) Vol. 2: Vols. 4-6-8", null],
        ["Alpha 3-in-1 Edition, Vol. 1: Vols. 1-2-5", null],
        ["Area 51, Omnibus Book 2: Vol. 2 - 4-6", null],
        ["Alpha, Omnibus Book 2 - Vol. 1-3 - Vol.2", null],
        ["Blade Runner 2049 Omnibus Book 2 - Vol. 1 + Vol. 2 - Vol. 4-6", null],
        ["Alpha (Omnibus Vol. 4-6-8)", null],
        // A plain bracket is the same kind of statement: never 4–8 with 5 and 7 invented.
        ["Alpha Omnibus 2 (Vol. 4-6-8)", null],
        ["Alpha Omnibus 2 (Vol. 2 - 4-6)", null],
        ["Alpha (Omnibus) Volume 2", "Vol. 4-6-8"],
        ["Alpha (Omnibus) Volume 2", "Vol. 2 - 4-6"],
      ] as const) {
        expect(
          parseBookTitle(title, { subtitle }).packaging,
          `${title} / ${subtitle}`,
        ).toMatchObject(REJECTED);
      }
    });

    // A gapped list after a phrase stands against a marker's designation
    // ("Alpha 3-in-1 Edition 1 & 3, Vol. 1" above), never against a bare
    // number the grammar has yet to read.
    it("reads a bare number before a phrase whose list no marker follows", () => {
      expect(packaging("Alpha 2 Omnibus (Light Novel) 1 & 3")).toEqual(
        packagedAlpha({ lineName: "Omnibus", linePosition: "2", coverRange: null }),
      );
      expect(
        parseBookTitle("Area 51, Omnibus Vol. 1-3 (Light Novel), 1 & 3 (Hardcover)"),
      ).toMatchObject({
        seriesTitle: "Area",
        isNovel: true,
        packaging: { lineName: "Omnibus", linePosition: "51", coverRange: null },
      });
    });
  });
});

describe("parseBookTitle — novels and text hygiene", () => {
  it("marks prose and light novels, but not graphic novels", () => {
    expect(
      parseBookTitle("Grandmaster of Demonic Cultivation: Mo Dao Zu Shi (Novel) Vol. 4"),
    ).toMatchObject({
      seriesTitle: "Grandmaster of Demonic Cultivation: Mo Dao Zu Shi",
      volumeLabel: "4",
      isNovel: true,
    });
    expect(isNovelTitle("Her Royal Highness Seems to Be Angry, Volume 3 (Light Novel)")).toBe(true);
    expect(isNovelTitle("Little Mushroom (Deluxe Hardcover Novel) Vol. 2")).toBe(true);
    expect(
      isNovelTitle("Saving 80,000 Gold in Another World for My Retirement 8 (light novel)"),
    ).toBe(true);
    expect(isNovelTitle("Bizenghast: The Novel")).toBe(true);
    expect(isNovelTitle("Afro Samurai Vol.1 (Graphic Novel)")).toBe(false);
    expect(isNovelTitle("Utsubora – A Story of a Novelist")).toBe(false);
  });

  it("decodes entities and collapses whitespace", () => {
    expect(parseBookTitle("Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6").seriesTitle).toBe(
      "Betrothed to My Sister’s Ex",
    );
    expect(parseBookTitle("A  Century of Temptation").seriesTitle).toBe("A Century of Temptation");
    expect(
      parseBookTitle(
        "Blue Sheep Reverie Volume 3\n            \n                Blue Sheep Reverie",
      ).seriesTitle,
    ).toBe("Blue Sheep Reverie");
  });

  it("keeps styled dashes and name parentheticals", () => {
    expect(parseBookTitle("orange -future-").seriesTitle).toBe("orange -future-");
    expect(parseBookTitle("Marrying the Dark Knight (For Her Money)").seriesTitle).toBe(
      "Marrying the Dark Knight (For Her Money)",
    );
    expect(parseBookTitle("Slow Life In Another World (I Wish!) (Manga) Vol. 9").seriesTitle).toBe(
      "Slow Life In Another World (I Wish!)",
    );
  });
});

describe("canonicalLabel / rangeLabels", () => {
  it("canonicalizes numeric labels and keeps others", () => {
    expect(canonicalLabel("05")).toBe("5");
    expect(canonicalLabel("7.50")).toBe("7.5");
    expect(canonicalLabel("0")).toBe("0");
    expect(canonicalLabel("Five")).toBe("5");
    expect(canonicalLabel("IV")).toBe("4");
    expect(canonicalLabel("G1")).toBe("G1");
    expect(canonicalLabel("Side Story")).toBe("Side Story");
  });

  it("expands a cover range", () => {
    expect(rangeLabels({ from: "19", to: "21" })).toEqual(["19", "20", "21"]);
    expect(rangeLabels({ from: "9", to: "9" })).toEqual(["9"]);
    expect(rangeLabels({ from: "3", to: "1" })).toEqual([]);
  });
});

describe("outOfScopeReason", () => {
  it("classifies the scope audit's clear-cut classes", () => {
    expect(outOfScopeReason("The Seven Deadly Sins (Novel)")).toBe("novel");
    expect(outOfScopeReason("Cowboy Bebop - Playing Cards")).toBe("merchandise");
    expect(outOfScopeReason("SPY x FAMILY S1 Activity Book")).toBe("merchandise");
    expect(outOfScopeReason("Attack on Titan Coloring Book")).toBe("merchandise");
    expect(outOfScopeReason("Official Frieren Advent Calendar")).toBe("merchandise");
    expect(outOfScopeReason("Number Place: Blue")).toBe("merchandise");
    expect(outOfScopeReason("Monster Musume: Monster Girl Papercrafts")).toBe("merchandise");
    expect(outOfScopeReason("TOKYOPOP Manga Showcase 2024")).toBe("sampler");
    expect(outOfScopeReason("Cells at Work! Picture Book 5")).toBe("childrensBook");
    expect(outOfScopeReason("Chi's Sweet Home Board Book")).toBe("childrensBook");
    expect(outOfScopeReason("The Picture of Dorian Gray, Book 1")).toBeNull();
    expect(outOfScopeReason("Adults' Picture Book")).toBeNull();
    expect(outOfScopeReason("Star Collector, Chapter 1, FREE SAMPLE")).toBe("sampler");
    expect(outOfScopeReason("Lullaby of the Dawn, Booklet #1 (Convention Exclusive)")).toBe(
      "sampler",
    );
    expect(
      outOfScopeReason(
        "La Bendición Del Oficial Del Cielo, Volumen 1 (Manhua) – Versión en Español",
      ),
    ).toBe("nonEnglish");
    expect(outOfScopeReason("Perfeddion (Spanish)")).toBe("nonEnglish");
  });

  it("leaves manga in scope", () => {
    for (const title of [
      "Chainsaw Man, Vol. 22",
      "Afro Samurai Vol.1 (Graphic Novel)",
      "Noragami Omnibus 7 (Vol. 19-21)",
      "Monster Collection",
      "The Calendar Girl",
    ]) {
      expect(outOfScopeReason(title), title).toBeNull();
    }
  });
});

describe("parseBookTitle — bare roman numerals and +1 extras", () => {
  const roman = (title: string) => {
    const p = parseBookTitle(title);
    return [p.seriesTitle, p.volumeLabel, p.bareNumber, p.bareRoman];
  };

  it("reads a bare trailing roman numeral as a provisional volume number", () => {
    expect(roman("BARBARITIES I")).toEqual(["BARBARITIES", "1", true, true]);
    expect(roman("BARBARITIES IV")).toEqual(["BARBARITIES", "4", true, true]);
    expect(roman("Monster Girl Encyclopedia II")).toEqual([
      "Monster Girl Encyclopedia",
      "2",
      true,
      true,
    ]);
  });

  it("leaves pronouns and marked titles alone", () => {
    expect(roman("You and I")).toEqual(["You and I", null, false, false]);
    expect(roman("Kingdom Hearts II Vol. 3")).toEqual(["Kingdom Hearts II", "3", false, false]);
    // Provisional: the catalog keeps these whole unless a base Series exists.
    expect(roman("Triage X")).toEqual(["Triage", "10", true, true]);
  });

  it("lets a bracketed volume win over a trailing numeral", () => {
    expect(roman("Kingdom Hearts II (Vol. 3)")).toEqual(["Kingdom Hearts II", "3", false, false]);
    const tower = parseBookTitle("Tower Dungeon 7 (Vol. 8)");
    expect(tower.volumeLabel).toBe("8");
    expect(tower.bareSplit).toBeNull();
  });

  it("keeps an '18+1' extra as one unnumbered label, not a range", () => {
    expect(roman("Barakamon, Vol. 18+1")).toEqual(["Barakamon", "18+1", false, false]);
    expect(roman("Barakamon, Vol. 18")).toEqual(["Barakamon", "18", false, false]);
  });
});
