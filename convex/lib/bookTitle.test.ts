// The shared release-title parser (lib/bookTitle.ts). Every fixture is a
// real title from the production snapshot's source observations (PRH,
// OpenLibrary, Kodansha, Seven Seas), grouped by the shape that used to
// defeat the per-source splitters.

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
    expect(split("Chainsaw Man, Vol. 22")).toEqual([
      "Chainsaw Man",
      "22",
      null,
    ]);
    expect(split("Alpi the Soul Sender Vol.5")).toEqual([
      "Alpi the Soul Sender",
      "5",
      null,
    ]);
    expect(split("Berserk Volume 41")).toEqual(["Berserk", "41", null]);
    expect(split("Flowers of Evil, Volume 4")).toEqual([
      "Flowers of Evil",
      "4",
      null,
    ]);
    expect(split("One Piece #3")).toEqual(["One Piece", "3", null]);
    expect(split("Homestuck, Book 4")).toEqual(["Homestuck", "4", null]);
    expect(split("Paradise Kiss, Part 1")).toEqual([
      "Paradise Kiss",
      "1",
      null,
    ]);
    expect(split("Rising of the Shield Hero Volume 08")).toEqual([
      "Rising of the Shield Hero",
      "8",
      null,
    ]);
    expect(split("Sudoku Plus, Volume Two")).toEqual([
      "Sudoku Plus",
      "2",
      null,
    ]);
  });

  it("keeps a per-volume subtitle out of the series title", () => {
    expect(
      split("Lone Wolf and Cub Volume 7: Cloud Dragon, Wind Tiger"),
    ).toEqual(["Lone Wolf and Cub", "7", "Cloud Dragon, Wind Tiger"]);
    expect(split("Buddha: Volume 3: Devadatta")).toEqual([
      "Buddha",
      "3",
      "Devadatta",
    ]);
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
    expect(
      parseBookTitle("Betrothed to My Sister's Ex (Manga) Vol. 6"),
    ).toMatchObject({
      seriesTitle: "Betrothed to My Sister's Ex",
      volumeLabel: "6",
    });
    expect(split("My Beautiful Man, Volume 6 (Manga)")).toEqual([
      "My Beautiful Man",
      "6",
      null,
    ]);
    expect(split("I Ship My Rival x Me (The Comic / Manhua) Vol. 2")).toEqual([
      "I Ship My Rival x Me",
      "2",
      null,
    ]);
    expect(split("Hellsing Volume 9 (Second Edition)")).toEqual([
      "Hellsing",
      "9",
      null,
    ]);
    expect(split("Plus-Sized Elf Vol. 4 (Rerelease)")).toEqual([
      "Plus-Sized Elf",
      "4",
      null,
    ]);
  });

  it("reads a volume noted only in brackets", () => {
    expect(split("A Chinese Fantasy: Law of the Fox [Book 2]")).toEqual([
      "A Chinese Fantasy: Law of the Fox",
      "2",
      null,
    ]);
    expect(
      parseBookTitle("Himouto! Umaru-chan Vol. G1 (Vol. 13)"),
    ).toMatchObject({
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
    expect(
      split("Cells at Work! Picture Book 3: I'm Not Scared of Shots!")[0],
    ).toBe("Cells at Work! Picture Book 3: I'm Not Scared of Shots!");
  });
});

describe("parseBookTitle — unmarked trailing numbers", () => {
  it("splits with a peeled format tag as context", () => {
    expect(parseBookTitle("Otherside Picnic 05 (Manga)")).toMatchObject({
      seriesTitle: "Otherside Picnic",
      volumeLabel: "5",
      bareNumber: true,
    });
    expect(split("Battle Angel Alita 3 (Paperback)")).toEqual([
      "Battle Angel Alita",
      "3",
      null,
    ]);
    expect(split("BAKEMONOGATARI (manga) 11", 11)).toEqual([
      "BAKEMONOGATARI",
      "11",
      null,
    ]);
  });

  it("splits when the number equals the source's own volume number", () => {
    expect(split("Negima! 19", 19)).toEqual(["Negima!", "19", null]);
    expect(split("Buddha 3: Devadatta", 3)).toEqual([
      "Buddha",
      "3",
      "Devadatta",
    ]);
    expect(split("The Limit, 3", 3)).toEqual(["The Limit", "3", null]);
    expect(split("Say I Love You. 11", 11)).toEqual([
      "Say I Love You.",
      "11",
      null,
    ]);
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
    expect(split("Mob Psycho 100 Volume 5")).toEqual([
      "Mob Psycho 100",
      "5",
      null,
    ]);
    // A franchise ordinal on a title with no number never becomes a label.
    expect(split("orange -future-", 3)).toEqual([
      "orange -future-",
      null,
      null,
    ]);
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
    expect(
      split("Welcome to Demon School! Iruma-kun: IruMafia Edition 7", 7),
    ).toEqual([
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
    expect(packaging("Tokyo Revengers (Omnibus) Vol. 23-24").packaging).toEqual(
      {
        lineName: "Omnibus",
        linePosition: null,
        coverRange: { from: "23", to: "24" },
      },
    );
    expect(packaging("High-Rise Invasion Omnibus 5-6").packaging).toEqual({
      lineName: "Omnibus",
      linePosition: null,
      coverRange: { from: "5", to: "6" },
    });
    expect(packaging("Blue Giant Omnibus Vols. 5-6").seriesTitle).toBe(
      "Blue Giant",
    );
    expect(
      packaging("The Way of the Househusband, Vol. 1-3 (Omnibus)"),
    ).toMatchObject({
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
    expect(
      packaging("Astro Boy Omnibus Volume 7", 7).packaging?.linePosition,
    ).toBe("7");
  });

  it("reads deluxe, collector's, n-in-1, anniversary and complete lines", () => {
    expect(
      packaging(
        "Monster Musume: Deluxe Edition 1 (Vol. 1-3 Hardcover Omnibus)",
        1,
      ),
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
    expect(
      packaging("Blade of the Immortal Deluxe Volume 10").seriesTitle,
    ).toBe("Blade of the Immortal");
    expect(packaging("Rozen Maiden Collector's Edition Vol. 2")).toMatchObject({
      seriesTitle: "Rozen Maiden",
      packaging: { lineName: "Collector's Edition", linePosition: "2" },
    });
    expect(
      packaging("Tarot Café: The Collector’s Edition, Volume 2").seriesTitle,
    ).toBe("Tarot Café");
    expect(
      packaging("Aoashi (3-in-1 Edition) Volume 2 (Vol. 4,5,6)", 2),
    ).toMatchObject({
      seriesTitle: "Aoashi",
      packaging: {
        lineName: "3-in-1 Edition",
        linePosition: "2",
        coverRange: { from: "4", to: "6" },
      },
    });
    expect(
      packaging("Darwin's Game (3-in-1 Edition) (Vol.1, 2, 3) Vol.1").packaging,
    ).toEqual({
      lineName: "3-in-1 Edition",
      linePosition: "1",
      coverRange: { from: "1", to: "3" },
    });
    expect(packaging("MARS 30th Anniversary Edition")).toMatchObject({
      seriesTitle: "MARS",
      packaging: { lineName: "30th Anniversary Edition" },
    });
    expect(
      packaging("Soul Eater: The Perfect Edition 03").packaging,
    ).toMatchObject({
      lineName: "Perfect Edition",
      linePosition: "3",
    });
    expect(
      packaging("orange: The Complete Collection 1").packaging,
    ).toMatchObject({
      lineName: "Complete Collection",
      linePosition: "1",
    });
    expect(packaging("Ajin: Demi-Human Complete 3").seriesTitle).toBe(
      "Ajin: Demi-Human",
    );
    expect(
      packaging("Sailor Moon 9 (Naoko Takeuchi Collection)", 9),
    ).toMatchObject({
      seriesTitle: "Sailor Moon",
      volumeLabel: null,
      packaging: { lineName: "Naoko Takeuchi Collection", linePosition: "9" },
    });
    expect(
      packaging("Battle Angel Alita Deluxe 5 (Contains Vol. 9 & Ashen Victor)")
        .packaging,
    ).toMatchObject({ coverRange: { from: "9", to: "9" } });
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
    expect(
      packaging("Attack on Titan Season 3 Part 2 Manga Box Set"),
    ).toMatchObject({
      seriesTitle: "Attack on Titan",
      packaging: { lineName: "Box Set", linePosition: "Season 3 Part 2" },
      isBox: true,
    });
    expect(
      packaging("Attack on Titan The Final Season Part 2 Manga Box Set")
        .packaging,
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
    expect(
      packaging("Sherlock: A Scandal in Belgravia 1-2 Slipcase Set")
        .seriesTitle,
    ).toBe("Sherlock: A Scandal in Belgravia");
    expect(
      packaging(
        "Sailor Moon Manga Box Set Vol. 1-6 (Naoko Takeuchi Collection)",
      ),
    ).toMatchObject({
      seriesTitle: "Sailor Moon",
      packaging: { lineName: "Box Set", coverRange: { from: "1", to: "6" } },
      isBox: true,
    });
    expect(
      packaging("Battle Angel Alita Deluxe Complete Series Box Set"),
    ).toMatchObject({
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
    expect(packaging("Tomo-chan Is a Girl! Volumes 1-3").seriesTitle).toBe(
      "Tomo-chan Is a Girl!",
    );
  });
});

describe("parseBookTitle — novels and text hygiene", () => {
  it("marks prose and light novels, but not graphic novels", () => {
    expect(
      parseBookTitle(
        "Grandmaster of Demonic Cultivation: Mo Dao Zu Shi (Novel) Vol. 4",
      ),
    ).toMatchObject({
      seriesTitle: "Grandmaster of Demonic Cultivation: Mo Dao Zu Shi",
      volumeLabel: "4",
      isNovel: true,
    });
    expect(
      isNovelTitle(
        "Her Royal Highness Seems to Be Angry, Volume 3 (Light Novel)",
      ),
    ).toBe(true);
    expect(
      isNovelTitle("Little Mushroom (Deluxe Hardcover Novel) Vol. 2"),
    ).toBe(true);
    expect(
      isNovelTitle(
        "Saving 80,000 Gold in Another World for My Retirement 8 (light novel)",
      ),
    ).toBe(true);
    expect(isNovelTitle("Bizenghast: The Novel")).toBe(true);
    expect(isNovelTitle("Afro Samurai Vol.1 (Graphic Novel)")).toBe(false);
    expect(isNovelTitle("Utsubora – A Story of a Novelist")).toBe(false);
  });

  it("decodes entities and collapses whitespace", () => {
    expect(
      parseBookTitle("Betrothed to My Sister&#8217;s Ex (Manga) Vol. 6")
        .seriesTitle,
    ).toBe("Betrothed to My Sister’s Ex");
    expect(parseBookTitle("A  Century of Temptation").seriesTitle).toBe(
      "A Century of Temptation",
    );
    expect(
      parseBookTitle(
        "Blue Sheep Reverie Volume 3\n            \n                Blue Sheep Reverie",
      ).seriesTitle,
    ).toBe("Blue Sheep Reverie");
  });

  it("keeps styled dashes and name parentheticals", () => {
    expect(parseBookTitle("orange -future-").seriesTitle).toBe(
      "orange -future-",
    );
    expect(
      parseBookTitle("Marrying the Dark Knight (For Her Money)").seriesTitle,
    ).toBe("Marrying the Dark Knight (For Her Money)");
    expect(
      parseBookTitle("Slow Life In Another World (I Wish!) (Manga) Vol. 9")
        .seriesTitle,
    ).toBe("Slow Life In Another World (I Wish!)");
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
    expect(outOfScopeReason("Cowboy Bebop - Playing Cards")).toBe(
      "merchandise",
    );
    expect(outOfScopeReason("SPY x FAMILY S1 Activity Book")).toBe(
      "merchandise",
    );
    expect(outOfScopeReason("Attack on Titan Coloring Book")).toBe(
      "merchandise",
    );
    expect(outOfScopeReason("Official Frieren Advent Calendar")).toBe(
      "merchandise",
    );
    expect(outOfScopeReason("Number Place: Blue")).toBe("merchandise");
    expect(outOfScopeReason("Monster Musume: Monster Girl Papercrafts")).toBe(
      "merchandise",
    );
    expect(outOfScopeReason("TOKYOPOP Manga Showcase 2024")).toBe("sampler");
    expect(outOfScopeReason("Star Collector, Chapter 1, FREE SAMPLE")).toBe(
      "sampler",
    );
    expect(
      outOfScopeReason(
        "Lullaby of the Dawn, Booklet #1 (Convention Exclusive)",
      ),
    ).toBe("sampler");
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
