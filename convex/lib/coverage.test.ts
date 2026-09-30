import { describe, expect, it } from "vitest";
import { coverageFromLine, coverageFromText, inferCoverage } from "./coverage";
import { cleanBlurb } from "./text";

describe("coverageFromText — publisher blurbs that state the collected volumes", () => {
  it("reads PRH flap copy and keynotes (live Berserk Deluxe text, 2026-09-27)", () => {
    expect(
      coverageFromText(
        "A stunning deluxe edition collecting volumes 1&ndash;3 of the <i>New York Times</i> bestselling adult fantasy horror manga",
      ),
    ).toEqual({ from: "1", to: "3" });
    expect(
      coverageFromText("Collects <i>Berserk</i> Volumes 40, 41, and <i>Berserk Official Guidebook</i>."),
    ).toEqual({ from: "40", to: "41" });
    expect(coverageFromText("This omnibus contains volumes 4 through 6.")).toEqual({
      from: "4",
      to: "6",
    });
    expect(coverageFromText("Includes Vol. 7-9 plus bonus art.")).toEqual({ from: "7", to: "9" });
  });

  it("stays null when nothing is stated", () => {
    expect(coverageFromText("The first three volumes of a fantasy epic.")).toBeNull();
    expect(coverageFromText("Volume 5 continues the saga.")).toBeNull();
    expect(coverageFromText(undefined)).toBeNull();
  });

  it("rejects impossible ranges", () => {
    expect(coverageFromText("collects volumes 9-3")).toBeNull();
    expect(coverageFromText("collects volumes 1-80")).toBeNull();
  });
});

describe("coverageFromText — explicit lists (B18)", () => {
  it("never turns a gapped list into a range over the skipped Volumes", () => {
    expect(coverageFromText("Collects volumes 1 and 3.")).toBeNull();
    expect(coverageFromText("Collects Berserk Volumes 40, 42, and the Guidebook.")).toBeNull();
    expect(coverageFromText("Collects volumes 1, 2, and 3.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volume 5 in hardcover.")).toEqual({ from: "5", to: "5" });
  });
});

describe("coverageFromLine — line names that declare their size", () => {
  it("maps N-in-1 and VIZBIG positions onto volume ranges", () => {
    expect(coverageFromLine("3-in-1 Edition", "1")).toEqual({ from: "1", to: "3" });
    expect(coverageFromLine("3-in-1 Edition", "5")).toEqual({ from: "13", to: "15" });
    expect(coverageFromLine("2-in-1", "4")).toEqual({ from: "7", to: "8" });
    expect(coverageFromLine("VIZBIG Edition", "2")).toEqual({ from: "4", to: "6" });
    expect(coverageFromLine("Colossal Edition", "2")).toEqual({ from: "6", to: "10" });
    expect(coverageFromLine("Master's Edition", "3")).toEqual({ from: "11", to: "15" });
    expect(coverageFromLine("Grimoire Edition", "2")).toEqual({ from: "4", to: "6" });
    expect(coverageFromLine("Black Edition", "6")).toEqual({ from: "11", to: "12" });
    expect(coverageFromLine("Legendary Edition", "1")).toEqual({ from: "1", to: "2" });
    expect(coverageFromLine("Definitive Edition", "4")).toEqual({ from: "10", to: "12" });
    // Series-dependent names never guess.
    expect(coverageFromLine("Master Edition", "1")).toBeNull();
    expect(coverageFromLine("Collector's Edition", "1")).toBeNull();
    expect(coverageFromLine("Perfect Edition", "1")).toBeNull();
    expect(coverageFromLine("Fullmetal Edition", "1")).toBeNull();
  });

  it("never guesses for an undeclared size or a non-numeric position", () => {
    expect(coverageFromLine("Omnibus", "7")).toBeNull();
    expect(coverageFromLine("Deluxe Edition", "14")).toBeNull();
    expect(coverageFromLine("3-in-1 Edition", "IV")).toBeNull();
    expect(coverageFromLine(null, "1")).toBeNull();
  });
});

describe("inferCoverage — precedence", () => {
  it("prefers the title, then the blurbs in order, then the line size", () => {
    const stated = { lineName: "Omnibus", linePosition: "2", coverRange: { from: "4", to: "6" } };
    expect(inferCoverage(stated, ["collects volumes 1-3"])).toEqual({ from: "4", to: "6" });
    const deluxe = { lineName: "Deluxe Edition", linePosition: "14", coverRange: null };
    expect(inferCoverage(deluxe, [undefined, "Collects Berserk Volumes 40, 41."])).toEqual({
      from: "40",
      to: "41",
    });
    expect(inferCoverage(deluxe, [undefined])).toBeNull();
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "3", coverRange: null };
    expect(inferCoverage(threeIn1, [])).toEqual({ from: "7", to: "9" });
  });

  // R12: a statement no range can hold is evidence, not silence.
  it("never lets the line size override a gapped or impossible statement", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    expect(inferCoverage({ ...threeIn1, coverageGapped: true }, [])).toBeNull();
    expect(inferCoverage({ ...threeIn1, coverageGapped: true }, ["Collects volumes 1-3."])).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1 and 3."])).toBeNull();
    expect(inferCoverage(threeIn1, [undefined, "A giant edition.", "Collects volumes 1 & 3."])).toBeNull();
    expect(inferCoverage(threeIn1, ["collects volumes 9-3"])).toBeNull();
    // The first blurb that states a usable range still decides.
    const second = { ...threeIn1, linePosition: "2" };
    expect(inferCoverage(second, ["Collects volumes 4-6.", "Collects volumes 1 and 3."])).toEqual({
      from: "4",
      to: "6",
    });
    // An unusable bare range states nothing, so the size still applies.
    expect(inferCoverage(threeIn1, ["Volumes 1-80 of the saga."])).toEqual({ from: "1", to: "3" });
  });

  // R12: a gapped list needs no collect-verb to count. Without one it was
  // read as silence and the 3-in-1 size invented Volume 2.
  it("reads a bare, numbered-word, or ranged gapped list as a gap", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Volumes 1 and 3 in one book!",
      "Features volumes 1 and 3.",
      "This edition brings together volumes 1 and 3.",
      "Collects volumes #1 and #3.",
      "Collects volumes one and three.",
      "Collecting volume 1 and volume 3.",
      "Collects volumes 1-2 and 4.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toBeNull();
    }
    // Contiguous lists, in words or with "#", still state a range.
    expect(coverageFromText("Collects volumes one through three.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes #4, #5 and #6.")).toEqual({ from: "4", to: "6" });
    // A single bare Volume still says nothing about the book.
    expect(inferCoverage(threeIn1, ["Volume One of the hit series."])).toEqual({ from: "1", to: "3" });
    // An unusable bare range does not hide a later gapped list.
    expect(
      inferCoverage(threeIn1, ["Volumes 1-80 of the saga are out. Volumes 1 and 3 in one book!"]),
    ).toBeNull();
    // "+", "plus", and encoded ampersands separate listed Volumes too.
    for (const blurb of [
      "Collects volumes 1 + 3.",
      "Collects volumes 1 plus 3.",
      "Collects volumes 1 &amp;amp; 3.",
      "Collects volumes 1 &#38; 3.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toBeNull();
    }
  });

  // R12: a bare last number after "and", "&", or a comma, followed by
  // anything but a statement end, may count something else, so the list
  // reads two ways, with it and without it. Only the line size at the
  // book's position settles them.
  it("reads a count after the list two ways, settled only by the line size", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Collects volumes 1–3 and 4 bonus stories.",
      "Collects volumes 1-3 and 4 all-new bonus stories.",
      "Collects volumes 1-3 and 4-page bonus comic.",
      "Collects volumes 1-3 and 4 “bonus” stories.",
      "Collects volumes 1-3 and 4 (four!) bonus stories.",
      "Collects volumes 1-3 and 4.5 bonus pages.",
      "Collects volumes 1-3 and 16 pages of color art.",
      "Collects volumes 1-3, and 2 new short stories.",
      "Collects volumes 1-3 and volume 4's bonus chapter.",
      "Collects volumes 1-3 and volume 4&#8217;s bonus chapter.",
      "Collects volumes 1-3 and 4 of the author's short stories.",
      "Volumes 1-3 and 4 all-new stories in one book.",
    ]) {
      expect(coverageFromText(blurb), blurb).toBeNull();
      expect(inferCoverage(threeIn1, [blurb]), blurb).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(deluxe, [blurb]), blurb).toBeNull();
    }
    // The fuller reading wins when it is the one that agrees.
    const fourIn1 = { lineName: "4-in-1 Edition", linePosition: "1", coverRange: null };
    expect(inferCoverage(fourIn1, ["Collects volumes 1-3 and 4 in one book."])).toEqual({ from: "1", to: "4" });
    // Volume 1 alone or 1–2: a 3-in-1 (1–3) agrees with neither.
    expect(inferCoverage(threeIn1, ["Includes volume one and two bonus stories."])).toBeNull();
    // A gapped list stays gapped whatever follows it.
    expect(inferCoverage(threeIn1, ["Collects volumes 1 and 3 remastered."])).toBeNull();
    // A statement end keeps every item: punctuation or the end of the text.
    expect(coverageFromText("Collects volumes 1, 2, and 3—the complete arc.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes 1, 2, and 3, the complete arc.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects volumes 1-3 plus 4")).toEqual({ from: "1", to: "4" });
    // So does a serial list: its last number is one of the list.
    expect(coverageFromText("<ul><li>Collects volumes 1, 2, and 3</li><li>Hardcover</li></ul>")).toEqual({
      from: "1",
      to: "3",
    });
    expect(coverageFromText("Collects volumes 1, 2, and 3 of the hit.")).toEqual({ from: "1", to: "3" });
    // A number is read whole: "4.5" is never Volume 4, and no range holds it.
    expect(inferCoverage(threeIn1, ["Collects volumes 1-3 and 4.5."])).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volume 4.5."])).toBeNull();
  });

  // R12: a list the reader cannot finish is never cut short to what it read.
  it("never shortens a list it cannot finish", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Collects volumes 1 as well as 3.",
      "Collects volumes 1 along with 3.",
      "Collects volumes 1; 3.",
      "Collects volumes 1/3.",
      "Collects volumes 1-2; 4.",
      "Collects vols 1and 3",
      "Volumes 1 as well as 3 in one book!",
      "Collects volume 1 as well as volume 3.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toBeNull();
    }
    // "as well as" and "along with" join a list like "and": 1–3 and 5 is a gap.
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    expect(inferCoverage(deluxe, ["Collects volumes 1-3 as well as 5."])).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1-3 as well as 5."])).toBeNull();
    expect(coverageFromText("Collects volumes 1-3 as well as 4.")).toEqual({ from: "1", to: "4" });
    // A Volume the sentence names past the list, with its own marker, may be
    // part of what it collects: only a line size that agrees settles it.
    expect(inferCoverage(deluxe, ["Collects volume 1 of Alpha and volume 2 of Beta."])).toBeNull();
    // One named inside a phrase of its own is a mention.
    for (const size of [threeIn1, deluxe]) {
      expect(inferCoverage(size, ["Collects volumes 1-3, plus a preview of volume 4."])).toEqual({
        from: "1",
        to: "3",
      });
    }
    // One Volume under a singular marker still stands, and so does a list
    // whose sentence ends before another Volume is named, or whose later
    // numbers run on into what they count.
    expect(coverageFromText("Collects volume 5 in hardcover.")).toEqual({ from: "5", to: "5" });
    expect(coverageFromText("Collects volumes 1-3. Volume 4 arrives in May.")).toEqual({ from: "1", to: "3" });
    expect(coverageFromText("Collects Vol. 1-3 in a 600-page hardcover with 16 pages of color.")).toEqual({
      from: "1",
      to: "3",
    });
  });

  // R12: a number later in the sentence that the list never joined counts
  // something else ("chapters 1–27", "Mob Psycho 100"). The one stated range
  // still places a book whose line declares no size.
  it("reads one stated range whole, whatever numbers follow it", () => {
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Collects volumes 1–3 (chapters 1–27).",
      "Collects volumes 1-3 (chapters 1-27).",
      "Collects volumes 1-3 of Mob Psycho 100.",
      "Collects volumes 1-3 of Eyeshield 21!",
      "Collects volumes 1-3 of Kaiju No. 8.",
      "Collects volumes 1-3 of 10.",
      "Collects volumes 1-3, chapters 1 to 27.",
      "Collects volumes 1-3, rated 16.",
      "Collects volumes 1-3. Chapters 1–27 of the hit series.",
      // A title's own "!" or abbreviation ends no sentence.
      "Collects Negima! Volumes 1-3.",
      "Collects Dr. Stone volumes 1-3.",
      // A line break is not a block: the list runs on.
      "Collects volumes 1, 2<br/>and 3",
      // A Volume named inside the list's own span says nothing new.
      "Collects volumes 1-3 (volume 3 adds a bonus chapter).",
      // Every dash spelling reads as a range.
      "Collects volumes 1‑3 (non-breaking hyphen).",
      "Collects volumes 1−3 (minus sign).",
    ]) {
      expect(coverageFromText(blurb), blurb).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(deluxe, [blurb]), blurb).toEqual({ from: "1", to: "3" });
    }
  });

  // R12: a list no collect-verb governs names Volumes without saying the
  // book holds them ("The story continues in volumes 4 and 5"). It never
  // places the book past the line size: only a gap in it counts, and blocks.
  // (A list that opens its sentence states the coverage on a line with no
  // size: see below.)
  it("never places a book by a list no verb governs", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "The story continues in volumes 4 and 5.",
      "Catch up before volumes 4 and 5, coming soon.",
      "Don't miss volumes 2 and 3!",
      "Volumes 5 and 6 pick up where volume 4 left off.",
      "The story continues in volumes 4–6.",
      "Collects bonus art. The story continues in volumes 4 and 5.",
      "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5.</p>",
      "Together at last: volumes 1, 2, and 3.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(deluxe, [blurb]), blurb).toBeNull();
      expect(coverageFromText(blurb), blurb).toBeNull();
    }
    // A stated range in a later blurb still decides.
    expect(inferCoverage(deluxe, ["The story continues in volumes 4 and 5.", "Collects volumes 1-3."])).toEqual({
      from: "1",
      to: "3",
    });
    // A gap still blocks, even in a singular list that reads two ways.
    expect(inferCoverage(threeIn1, ["Volume 1 and 3 in one book!"])).toBeNull();
    expect(inferCoverage(threeIn1, ["The saga continues in volumes 4 and 5. Volumes 1 and 3 in one book!"])).toBeNull();
  });

  // R12: a collect-verb collects the phrase an article or preposition
  // opens, not the list inside it, and a verb in another sentence governs
  // nothing. cleanBlurb turns every tag into a space, so a block boundary
  // reaches coverage as one.
  it("reads a list after an article, a preposition, or a sentence end as a mention", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const raw of [
      "<p>Collects bonus art</p><p>The story continues in volumes 4 and 5</p>",
      "Includes a preview of volumes 4 and 5.",
      "Includes a preview of volume 4.",
      "Includes A Preview Of Volumes 4 and 5.",
      "INCLUDES A PREVIEW OF VOLUMES 4 AND 5.",
      "Includes a letter from Oda. Volumes 4 and 5 are out now.",
      "Collects bonus art! Volumes 4 and 5 are out now.",
      "Collects chapters 1-27 and a preview of volumes 4-6.",
    ]) {
      const blurb = cleanBlurb(raw);
      expect(inferCoverage(threeIn1, [blurb]), raw).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(deluxe, [blurb]), raw).toBeNull();
    }
  });

  // A block boundary cleanBlurb spaced over is invisible here, and a capital
  // "Volumes" is no sign of a new block: the verb governs the next block's
  // list. A size the statement contradicts still blocks; a line with no size
  // takes the Volumes the statement names.
  it("reads a list across a lost block boundary as the verb's statement", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    const range = cleanBlurb("<h3>Collects the hit series</h3><p>Volumes 4-6 on sale now.</p>");
    expect(inferCoverage(threeIn1, [range])).toBeNull();
    expect(inferCoverage(deluxe, [range])).toEqual({ from: "4", to: "6" });
    // "5 on sale" may count something else: only a size could settle it.
    const list = cleanBlurb("<p>Collects exclusive art</p><p>Volumes 4 and 5 on sale now</p>");
    expect(inferCoverage(threeIn1, [list])).toBeNull();
    expect(inferCoverage(deluxe, [list])).toBeNull();
  });

  it("places a book by a list whose verb governs it through a name", () => {
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const raw of [
      "Collects <i>Berserk</i> Volumes 1, 2, and 3.",
      "Collects Attack on Titan volumes 1-3.",
      "Collects The Promised Neverland volumes 1-3.",
      "Collects the Mob Psycho 100 volumes 1-3.",
      "Collects Pokémon Adventures volumes 1-3.",
      "Collects Oshi no Ko volumes 1-3.",
      "COLLECTS VOLUMES 1-3.",
    ]) {
      expect(inferCoverage(deluxe, [cleanBlurb(raw)]), raw).toEqual({ from: "1", to: "3" });
    }
  });

  // Any other words between verb and list ("the hit series", "both",
  // capitals throughout) leave the verb governing it. The size never
  // overrides the statement: one it contradicts blocks.
  it("governs through any lead-in that opens no phrase of its own", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const second = { ...threeIn1, linePosition: "2" };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const blurb of [
      "Collects the hit series volumes 1-3.",
      "Collects all volumes 1-3.",
      "Contains the complete volumes 1-3.",
      "COLLECTS THE HIT SERIES VOLUMES 1-3.",
      "Collects xxxHOLiC volumes 1-3.",
      "Collects “Alpha” volumes 1-3.",
      "Collects That Time I Got Reincarnated as a Slime volumes 1-3.",
    ]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(second, [blurb]), blurb).toBeNull();
      expect(inferCoverage(deluxe, [blurb]), blurb).toEqual({ from: "1", to: "3" });
    }
    expect(inferCoverage(threeIn1, ["Collects both volumes 1 and 2."])).toBeNull();
    expect(inferCoverage(threeIn1, ["COLLECTS THE HIT SERIES VOLUMES 4-6 ON SALE NOW."])).toBeNull();
    // The first statement decides, in its blurb and across blurbs.
    expect(inferCoverage(deluxe, ["Collects the hit series volumes 4-6.", "Collects volumes 1-3."])).toEqual({
      from: "4",
      to: "6",
    });
    expect(inferCoverage(second, ["Collects the hit series volumes 1-3. Collects volumes 4-6."])).toBeNull();
  });

  // R12: "/" and ";" join a list only weakly: "1-3 / 4-6" may name two
  // books. The list reads with and without what follows the joiner, and only
  // the line size settles it.
  it("reads an item joined by a slash or semicolon two ways", () => {
    const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
    const second = { ...threeIn1, linePosition: "2" };
    const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
    for (const blurb of ["Collects volumes 1-3 / 4-6.", "Collects volumes 1-3; 4-6."]) {
      expect(inferCoverage(threeIn1, [blurb]), blurb).toEqual({ from: "1", to: "3" });
      expect(inferCoverage(second, [blurb]), blurb).toBeNull();
      expect(inferCoverage(deluxe, [blurb]), blurb).toBeNull();
      expect(coverageFromText(blurb), blurb).toBeNull();
    }
    // Even "1/2/3": only the size settles it.
    expect(coverageFromText("Collects volumes 1/2/3.")).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1/2/3."])).toEqual({ from: "1", to: "3" });
    expect(inferCoverage(threeIn1, ["Collects volume 1/3."])).toBeNull();
  });
});

describe("coverage — the nearest collect-verb, the size, and ambiguity (R12)", () => {
  const deluxe = { lineName: "Deluxe Edition", linePosition: "1", coverRange: null };
  const threeIn1 = { lineName: "3-in-1 Edition", linePosition: "1", coverRange: null };
  const second = { ...threeIn1, linePosition: "2" };
  const ONE_TO_THREE = { from: "1", to: "3" };

  it("judges the collect-verb nearest the list", () => {
    for (const blurb of [
      "This collected edition includes volumes 1-3.",
      "Includes a new afterword and collects volumes 1-3.",
      "Includes all-new bonus material and collects volumes 1-3 of the original series.",
      "Collecting the acclaimed manga, this omnibus contains volumes 1-3.",
    ]) {
      expect(coverageFromText(blurb), blurb).toEqual(ONE_TO_THREE);
      expect(inferCoverage(deluxe, [blurb]), blurb).toEqual(ONE_TO_THREE);
      expect(inferCoverage(threeIn1, [blurb]), blurb).toEqual(ONE_TO_THREE);
      expect(inferCoverage(second, [blurb]), blurb).toBeNull();
    }
  });

  it("reads a capital Volumes after a verb as a statement", () => {
    const blurb = "This collected edition contains Volumes 1–3 of the series.";
    expect(inferCoverage(deluxe, [blurb])).toEqual(ONE_TO_THREE);
    expect(inferCoverage(second, [blurb])).toBeNull();
  });

  it("never lets the size override a governed statement that contradicts it", () => {
    expect(inferCoverage(second, ["Collects volumes 1-3."])).toBeNull();
    expect(inferCoverage(threeIn1, ["The previously collected volumes 4-6 are also available."])).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1-3.", "Collects volumes 4-6."])).toEqual(ONE_TO_THREE);
  });

  it("never reads a dash range as ambiguous, whatever follows it", () => {
    for (const blurb of [
      "Collects volumes 1-3 plus 16 pages of color art.",
      "Collects volumes 1-3 of Alpha!",
      "Collects volumes 1–3 in a 600-page hardcover.",
    ]) {
      expect(coverageFromText(blurb), blurb).toEqual(ONE_TO_THREE);
      expect(inferCoverage(deluxe, [blurb]), blurb).toEqual(ONE_TO_THREE);
    }
    // A last item that is a range is a Volume range too: 1–6, which the
    // 3-in-1 size contradicts.
    expect(coverageFromText("Collects volumes 1-3 and 4-6 new stories.")).toEqual({ from: "1", to: "6" });
    expect(inferCoverage(threeIn1, ["Collects volumes 1-3 and 4-6 new stories."])).toBeNull();
  });

  it("settles a bare last item followed by more copy only by the size", () => {
    const twoIn1 = { lineName: "2-in-1 Edition", linePosition: "1", coverRange: null };
    for (const [blurb, size, expected] of [
      ["Collects volumes 1-3 and 4 bonus stories.", threeIn1, ONE_TO_THREE],
      ["Collects volumes 1-3 and 4 bonus stories.", second, null],
      ["Collects volumes 1-3 and 4 bonus stories.", deluxe, null],
      ["Contains volumes 1 and 2 of Alpha!", twoIn1, { from: "1", to: "2" }],
      ["Contains volumes 1 and 2 of Alpha!", deluxe, null],
      ["Collects volumes 4 and 5 featuring new art.", deluxe, null],
    ] as const) {
      expect(inferCoverage(size, [blurb]), `${blurb} on ${size.lineName}`).toEqual(expected);
    }
    // A serial list ("1, 2, and 3") names its last item a Volume.
    expect(coverageFromText("Contains volumes 1, 2 and 3 of Alpha!")).toEqual(ONE_TO_THREE);
  });

  it("reads a sentence-initial list with no verb as a statement only on a line with no size", () => {
    expect(coverageFromText("Volumes 10–12 of the acclaimed series, in hardcover.")).toEqual({ from: "10", to: "12" });
    expect(coverageFromText("Volumes 1, 2, and 3 together at last.")).toEqual(ONE_TO_THREE);
    expect(inferCoverage(deluxe, ["Volumes 1-3 in one book!"])).toEqual(ONE_TO_THREE);
    // On a sized line it is a mention: the size wins over it.
    expect(inferCoverage(second, ["Volumes 1-3 in one book!"])).toEqual({ from: "4", to: "6" });
    // An ambiguous last item still leaves an unsized book Unmapped.
    expect(inferCoverage(deluxe, ["Includes a letter from Oda. Volumes 4 and 5 are out now."])).toBeNull();
    // A verb's statement outranks it.
    expect(inferCoverage(deluxe, ["Volumes 1 and 3 are here. Collects volumes 1-3."])).toEqual(ONE_TO_THREE);
  });

  it("never shortens a range that runs on", () => {
    expect(coverageFromText("Collects volumes 1-2-3")).toBeNull();
    expect(inferCoverage(threeIn1, ["Collects volumes 1-2-3."])).toBeNull();
    expect(inferCoverage(deluxe, ["Collects volumes 1–2–3."])).toBeNull();
  });
});
