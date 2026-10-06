// ANN parser tests (ticket #36) against the live XML shapes captured
// 2026-08-20 from reports.xml / api.xml (Frieren, manga id 24449).

import { describe, expect, it } from "vitest";
import {
  annLinePackaged,
  packagingOf,
  pageRestatesLine,
  readAnnLineTitle,
  cleanAnnDescription,
  parseAnnDate,
  parseApiResponse,
  parseReleasePage,
  parseReport,
  splitReleaseTitle,
} from "./ann";

const REPORT = `<report skipped="0" listed="3"><args><type>manga</type></args>
<item><id>40451</id><gid>2503062384</gid><type>manga</type><name>Soshite Kuchibiru ni Chi ga Nijimu</name><precision>manga</precision><vintage>2026-08-19</vintage></item>
<item><id>40447</id><gid>1853155867</gid><type>manga</type><name>There&#039;s No Freaking Way I&#039;ll Be Your Lover! Unless... Second Season</name><precision>manga</precision><vintage>2027</vintage></item>
<item><id>9999</id><gid>1</gid><type>anime</type><name>Not A Manga</name></item></report>`;

const API = `<ann><manga id="24449" gid="2959400328" type="manga" name="Frieren: Beyond Journey&#039;s End" precision="manga" generated-on="2026-08-20T00:14:41Z">
<info gid="4083496145" type="Main title" lang="EN">Frieren: Beyond Journey&#039;s End</info>
<info gid="3004762124" type="Alternative title" lang="IT">Frieren - Oltre la fine del viaggio</info>
<info gid="1628474890" type="Alternative title" lang="JA">Sōsō no Frieren</info>
<info gid="1173357738" type="Alternative title" lang="JA">葬送のフリーレン</info>
<info gid="2033164419" type="Genres">adventure</info>
<release date="2021-11-09" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=42006">Frieren: Beyond Journey&#039;s End (eBook 1)</release>
<release date="2021-11-09" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=42005">Frieren: Beyond Journey&#039;s End (GN 1)</release>
<release date="2026-02-10" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=52404">Frieren: Beyond Journey&#039;s End (GN 14)</release>
<release date="2024-11-00" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51000">Frieren: Beyond Journey&#039;s End (GN 7.5)</release>
<release date="2025-01-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51001">Frieren: Beyond Journey&#039;s End (Omnibus GN 1-3)</release>
<release date="2025-01-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=51002">Frieren: The Movie (DVD)</release>
<staff gid="161175717"><task>Story</task><person id="208754">Kanehito Yamada</person></staff>
<staff gid="2097634453"><task>Art</task><person id="208753">Tsukasa Abe</person></staff></manga><warning>no result for manga=4658</warning></ann>`;

describe("parseReport", () => {
  it("enumerates manga items, decoding entities and skipping non-manga", () => {
    const { items, malformed, rawCount } = parseReport(REPORT);
    expect(items.map((i) => i.id)).toEqual(["40451", "40447"]);
    expect(items[1]!.name).toBe(
      "There's No Freaking Way I'll Be Your Lover! Unless... Second Season",
    );
    expect(malformed).toEqual([]);
    // Paging counts the anime row too.
    expect(rawCount).toBe(3);
  });

  it("skips a row without id/name and reports its position; the rest parse", () => {
    const { items, malformed, rawCount } = parseReport(
      `<report skipped="0" listed="3"><item><id>1</id><type>manga</type><name>A</name></item>
<item><name>Missing id</name></item>
<item><id>3</id><type>manga</type><name>C</name></item></report>`,
    );
    expect(items.map((i) => i.id)).toEqual(["1", "3"]);
    expect(malformed).toEqual([1]);
    expect(rawCount).toBe(3);
  });

  it("rejects an untrustworthy page: not a report, or listed disagreeing with the items", () => {
    expect(() => parseReport("<html>Temporarily unavailable</html>")).toThrow(
      /invalid report document/,
    );
    expect(() =>
      parseReport(
        '<report listed="1"><item><id>1</id><name>A</name></item><item><id>2</id><name>B</name></item></report>',
      ),
    ).toThrow(/listed count/);
  });

  it("accepts the final page, where ANN's listed count is the page size, not the item count", () => {
    const { items, rawCount } = parseReport(
      '<report skipped="24000" listed="500"><args><type>manga</type></args><item><id>1223</id><type>manga</type><name>One Piece</name></item></report>',
    );
    expect(rawCount).toBe(1);
    expect(items).toEqual([{ id: "1223", name: "One Piece" }]);
  });
});

describe("parseAnnDate — ANN's month-precision convention", () => {
  it("keeps full, month, and year precision distinct", () => {
    expect(parseAnnDate("2026-02-10")).toEqual({
      year: 2026,
      month: 2,
      day: 10,
    });
    expect(parseAnnDate("2024-11-00")).toEqual({ year: 2024, month: 11 });
    expect(parseAnnDate("2027")).toEqual({ year: 2027 });
    expect(parseAnnDate("soon")).toBeUndefined();
  });

  it("reads a pre-2010 day 01 as the month placeholder it is", () => {
    expect(parseAnnDate("2004-06-01")).toEqual({ year: 2004, month: 6 });
    expect(parseAnnDate("2009-12-01")).toEqual({ year: 2009, month: 12 });
    // Modern day-1 dates are real (159/178 agree with PRH).
    expect(parseAnnDate("2024-10-01")).toEqual({
      year: 2024,
      month: 10,
      day: 1,
    });
  });
});

describe("parseApiResponse — title hygiene", () => {
  it("decodes double-escaped entities and drops ruby and whitespace noise", () => {
    const [manga] = parseApiResponse(`<ann><manga id="36878" name="x">
<info gid="1" type="Main title" lang="EN">Marrying the Dark Knight &amp;#40;For Her Money&amp;#41;</info>
<info gid="2" type="Alternative title" lang="JA">&lt;ruby&gt;&lt;rb&gt;騎士&lt;/rb&gt;&lt;rt&gt;きし&lt;/rt&gt;&lt;/ruby&gt;</info>
<info gid="3" type="Alternative title" lang="EN">A  Century   of Temptation</info>
</manga></ann>`);
    expect(manga).toMatchObject({
      title: "Marrying the Dark Knight (For Her Money)",
      altTitles: ["騎士", "A Century of Temptation"],
    });
  });
});

describe("splitReleaseTitle", () => {
  it("classifies GN/eBook designators and extracts labels", () => {
    expect(splitReleaseTitle("Frieren (GN 14)")).toMatchObject({
      title: "Frieren",
      label: "14",
      format: "physical",
      multi: false,
      editionLineHint: false,
    });
    expect(splitReleaseTitle("Frieren (eBook 2)")).toMatchObject({
      label: "2",
      format: "digital",
    });
    expect(splitReleaseTitle("Frieren (GN 7.5)")).toMatchObject({
      label: "7.5",
    });
    expect(splitReleaseTitle("Oneshot Story (GN)")).toMatchObject({
      label: undefined,
      multi: false,
    });
    // VIZ's One Piece omnibus shape: the designator states the collected range.
    expect(
      splitReleaseTitle("One Piece - [Omnibus] 33 - Wano (GN 97-99)", "One Piece"),
    ).toMatchObject({
      title: "One Piece - [Omnibus] 33 - Wano",
      label: undefined,
      multi: true,
      editionLineHint: true,
      coverRange: { from: "97", to: "99" },
    });
  });

  it("flags omnibus/box-set packaging and ranges; rejects non-book lines", () => {
    expect(splitReleaseTitle("Frieren (Omnibus GN 1-3)")).toMatchObject({
      multi: true,
      editionLineHint: true,
    });
    expect(splitReleaseTitle("Frieren (Hardcover GN 3)")).toMatchObject({
      label: "3",
      editionLineHint: true,
    });
    expect(splitReleaseTitle("Frieren: The Movie (DVD)")).toBeNull();
    expect(splitReleaseTitle("No designator at all")).toBeNull();
  });

  // What each designator form yields: [label, multi, coverRange, coverageGapped].
  const coverage = (text: string) => {
    const split = splitReleaseTitle(text);
    return split && [split.label, split.multi, split.coverRange, split.coverageGapped];
  };
  const range = (from: string, to: string) => ({ from, to });

  it("reads a contiguous Volume list as the range it spans, as a written range", () => {
    expect(coverage("Alpha (GN 97-99)")).toEqual([undefined, true, range("97", "99"), undefined]);
    expect(coverage("Alpha (eBook 8-10)")).toEqual([undefined, true, range("8", "10"), undefined]);
    expect(coverage("Alpha (Omnibus GN 1-3)")).toEqual([
      undefined,
      true,
      range("1", "3"),
      undefined,
    ]);
    expect(coverage("Alpha (GN 1, 2, 3)")).toEqual([undefined, true, range("1", "3"), undefined]);
    expect(coverage("Alpha (GN 1 & 2)")).toEqual([undefined, true, range("1", "2"), undefined]);
    expect(coverage("Alpha (GN 1 and 2)")).toEqual([undefined, true, range("1", "2"), undefined]);
    expect(coverage("Alpha (GN 1-3, 4-6)")).toEqual([undefined, true, range("1", "6"), undefined]);
    // A range Coverage cannot list (a fraction, more than one book holds)
    // is a statement no range holds, never one to leave unmapped.
    expect(coverage("Alpha (GN 10.5-11)")).toEqual([undefined, true, undefined, true]);
    expect(coverage("Alpha (GN 1-80)")).toEqual([undefined, true, undefined, true]);
    // The shared grammar's em dash is a range too.
    expect(coverage("Alpha (GN 1—3)")).toEqual([undefined, true, range("1", "3"), undefined]);
    // The release page's "of N" total, if a line ever carries it, is not a Volume.
    expect(coverage("Alpha (GN 1-4 / 34)")).toEqual([undefined, true, range("1", "4"), undefined]);
    expect(coverage("Alpha (eBook 1-2 / 2)")).toEqual([
      undefined,
      true,
      range("1", "2"),
      undefined,
    ]);
  });

  it("reads coverage only after the format marker: a number before it is never coverage", () => {
    expect(coverage("Alpha (2nd Edition GN 1-3)")).toEqual([
      undefined,
      true,
      range("1", "3"),
      undefined,
    ]);
    expect(coverage("Alpha (3-in-1 Edition GN 1-3)")).toEqual([
      undefined,
      true,
      range("1", "3"),
      undefined,
    ]);
    expect(coverage("Alpha (2020 Edition GN 1-3)")).toEqual([
      undefined,
      true,
      range("1", "3"),
      undefined,
    ]);
    expect(coverage("Alpha (2nd Edition GN 1)")).toEqual(["1", false, undefined, undefined]);
    expect(coverage("Alpha (3-in-1 Edition GN 1)")).toEqual(["1", false, undefined, undefined]);
    expect(coverage("Alpha (Vol. 1 GN 2)")).toEqual(["2", false, undefined, undefined]);
    expect(coverage("Alpha (2nd Edition GN 1, 3)")).toEqual([undefined, true, undefined, true]);
    // A number in the title's own parentheses is not the designator.
    expect(coverage("Alpha (2020) (GN 1, 3)")).toEqual([undefined, true, undefined, true]);
    expect(splitReleaseTitle("Alpha (2nd Edition) (GN 1-3)")).toMatchObject({
      title: "Alpha (2nd Edition)",
      coverRange: range("1", "3"),
    });
    expect(coverage("Alpha (3-in-1 Edition) (GN 1)")).toEqual(["1", false, undefined, undefined]);
  });

  it("rejects a list no range holds: multi-volume with neither label nor range", () => {
    for (const designator of [
      "GN 1, 3",
      "GN 1-3, 5",
      "GN 1-2 & 4",
      "GN 3-1",
      "GN 1-3-5",
      "eBook 2, 4",
    ]) {
      expect(coverage(`Alpha (${designator})`), designator).toEqual([
        undefined,
        true,
        undefined,
        true,
      ]);
    }
    // The whole list is read, never its first numbers: a trailing item, a
    // numbered extra, words or a dangling separator leave it unread.
    for (const designator of [
      "GN 1, 2, and 4",
      "GN 1, 2, & 4",
      "GN 1, and 3",
      "GN 1-2 + 3",
      "GN 1 and Vol. 3",
      "GN 3 Part 1-2",
      "GN 1 and",
      "GN 1-3 Special",
      "GN 1 Part 2",
    ]) {
      expect(coverage(`Alpha (${designator})`), designator).toEqual([
        undefined,
        true,
        undefined,
        true,
      ]);
    }
    // Any number smaller than the one before it, not only the last.
    for (const designator of ["GN 1-5, 6-2", "GN 1-3, 4-2, 3-5"]) {
      expect(coverage(`Alpha (${designator})`), designator).toEqual([
        undefined,
        true,
        undefined,
        true,
      ]);
    }
    // On a 3-in-1 line too: the line's size never stands in for the list.
    expect(splitReleaseTitle("Naruto [3-in-1 Edition] (GN 1, 3)", "Naruto")).toMatchObject({
      title: "Naruto [3-in-1 Edition]",
      multi: true,
      editionLineHint: true,
      coverageGapped: true,
    });
  });

  it("keeps a single number, a half Volume, and a designator with no number as before", () => {
    expect(coverage("Alpha (GN 1)")).toEqual(["1", false, undefined, undefined]);
    expect(coverage("Alpha (GN 01)")).toEqual(["01", false, undefined, undefined]);
    expect(coverage("Alpha (GN 10.5)")).toEqual(["10.5", false, undefined, undefined]);
    expect(coverage("Alpha (GN box 2)")).toEqual(["2", false, undefined, undefined]);
    expect(coverage("Alpha (eBook ex 3)")).toEqual(["3", false, undefined, undefined]);
    expect(coverage("Alpha (GN 4 / 8)")).toEqual(["4", false, undefined, undefined]);
    expect(coverage("Alpha (GN 1A)")).toEqual(["1", false, undefined, undefined]);
    expect(coverage("Alpha (GN A)")).toEqual([undefined, false, undefined, undefined]);
    expect(coverage("Alpha (GN)")).toEqual([undefined, false, undefined, undefined]);
    expect(coverage("Alpha (eBook)")).toEqual([undefined, false, undefined, undefined]);
    // Not book designators, chapters, and no designator at all: no line.
    for (const text of [
      "Alpha (omnibus 1)",
      "Alpha (Box Set 1)",
      "Alpha (light novel)",
      "Alpha (eBook ch 17)",
      "Alpha",
    ]) {
      expect(splitReleaseTitle(text), text).toBeNull();
    }
  });
});

describe("parseApiResponse", () => {
  it("parses the manga record: titles, filtered alt titles, staff, releases", () => {
    const records = parseApiResponse(API);
    expect(records).toHaveLength(1);
    const manga = records[0]!;
    expect(manga.id).toBe("24449");
    expect(manga.title).toBe("Frieren: Beyond Journey's End");
    // EN/JA alternative titles only — the Italian one is dropped.
    expect(manga.altTitles).toEqual(["Sōsō no Frieren", "葬送のフリーレン"]);
    expect(manga.staff).toEqual(["Kanehito Yamada", "Tsukasa Abe"]);
    expect(manga.credits).toEqual([
      { personId: "208754", name: "Kanehito Yamada", task: "Story" },
      { personId: "208753", name: "Tsukasa Abe", task: "Art" },
    ]);
    // The DVD line is rejected; five book lines remain.
    expect(manga.releases).toHaveLength(5);
    expect(manga.releases[1]).toMatchObject({
      annId: "42005",
      date: { year: 2021, month: 11, day: 9 },
      label: "1",
      format: "physical",
    });
    expect(manga.releases[3]).toMatchObject({
      annId: "51000",
      date: { year: 2024, month: 11 },
      label: "7.5",
    });
    expect(manga.releases[4]).toMatchObject({
      multi: true,
      editionLineHint: true,
    });
  });

  it("reads the Plot Summary as the synopsis: entities decoded, line breaks collapsed", () => {
    const [manga] = parseApiResponse(`<ann><manga id="24449" name="Frieren">
<info gid="4083496145" type="Main title" lang="EN">Frieren</info>
<info gid="1981291311" type="Plot Summary">The demon king has been defeated, and the victorious hero party returns home.
Elf mage Frieren &amp;amp; her comrades said &quot;farewell&quot; &#8212; what&#039;s next?</info>
</manga></ann>`);
    expect(manga!.synopsis).toBe(
      "The demon king has been defeated, and the victorious hero party returns home. " +
        'Elf mage Frieren & her comrades said "farewell" — what\'s next?',
    );
    // No Plot Summary (or an empty one): no synopsis at all.
    expect(parseApiResponse(API)[0]!.synopsis).toBeUndefined();
    const [blank] = parseApiResponse(
      `<ann><manga id="1" name="X"><info gid="1" type="Plot Summary"> </info></manga></ann>`,
    );
    expect(blank!.synopsis).toBeUndefined();
  });

  it("tolerates warnings and empty responses", () => {
    expect(parseApiResponse("<ann><warning>no result</warning></ann>")).toEqual([]);
  });

  it("falls back to the name attribute when the Main title is absent or empty", () => {
    const records =
      parseApiResponse(`<ann><manga id="1" name="No Main Title &#039;Here&#039;"><info type="Genres">x</info></manga>
<manga id="2" name="Empty Main Title"><info gid="1" type="Main title" lang="EN">  </info></manga>
<manga id="3" name=""><info gid="1" type="Main title" lang="EN"></info></manga></ann>`);
    expect(records.map((r) => [r.id, r.title])).toEqual([
      ["1", "No Main Title 'Here'"],
      ["2", "Empty Main Title"],
    ]);
  });
});

describe("release lines — ISBNs, chapters, packaging in the title", () => {
  it("keeps missing-href identities distinct across manga and packaging lines", () => {
    const xml = `<ann>${[1, 2]
      .map(
        (id) => `<manga id="${id}" name="Series ${id}">
      <release date="2026-01-01">Series ${id} (GN 1-3)</release>
      <release date="2026-01-01">Series ${id} (GN 4-6)</release>
      </manga>`,
      )
      .join("")}</ann>`;
    const ids = parseApiResponse(xml).flatMap((manga) => manga.releases.map((line) => line.annId));
    expect(new Set(ids).size).toBe(4);
  });

  it("keeps a valid ean as the line's ISBN-13 and drops malformed ones", () => {
    const [manga] = parseApiResponse(`<ann><manga id="1223" name="One Piece">
<info gid="1" type="Main title" lang="EN">One Piece</info>
<release date="2026-11-10" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=57439" ean="9781974766703">One Piece (GN 113)</release>
<release date="2005-06-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5000" ean="1591163269">One Piece (GN 5)</release>
<release date="2005-06-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5001" ean="CTFL-02">One Piece (GN 6)</release>
</manga></ann>`);
    expect(manga!.releases.map((r) => r.isbn13)).toEqual([
      "9781974766703",
      "9781591163268",
      undefined,
    ]);
  });

  it("rejects single chapters and flags box designators and title packaging", () => {
    expect(splitReleaseTitle("Kakegurui - Compulsive Gambler (eBook ch 17)")).toBeNull();
    expect(splitReleaseTitle("Fairy Tail - [Box Set] (GN box 2)")).toMatchObject({
      editionLineHint: true,
    });
    expect(splitReleaseTitle("Berserk Deluxe Edition (GN 1)", "Berserk")).toMatchObject({
      label: "1",
      editionLineHint: true,
    });
    // A complete collection packages the whole series, numbered or not.
    expect(
      splitReleaseTitle("Summer Ghost: The Complete Manga Collection (GN)", "Summer Ghost"),
    ).toMatchObject({ label: undefined, editionLineHint: true });
    expect(splitReleaseTitle("orange: The Complete Collection 2 (GN 2)", "Orange")).toMatchObject({
      label: "2",
      editionLineHint: true,
    });
    // The series' own name carries the word: not packaging.
    expect(splitReleaseTitle("The Omnibus Club (GN 2)", "The Omnibus Club")).toMatchObject({
      label: "2",
      editionLineHint: false,
    });
  });

  // Staging's Held Books (2026-10-05): these lines were read as Volume N and
  // held as a reprint of the Volume's existing Release.
  it("flags an Edition Line named in the title, bracketed or after a dash", () => {
    for (const [title, entry] of [
      ["Vagabond [VIZBIG Edition]", "Vagabond"],
      ["Inuyasha [VIZBIG Edition]", "Inuyasha"],
      ["Dragon Ball Z [VIZBIG Edition]", "Dragon Ball"],
      ["Fushigi Yûgi [VIZBIG Edition]", "Fushigi Yûgi"],
      ["Hot Gimmick [VIZBIG Edition]", "Hot Gimmick"],
      ["Attack on Titan [Colossal Edition]", "Attack on Titan"],
      ["Death Note [Black Edition]", "Death Note"],
      ["Fairy Tail [Master's Edition]", "Fairy Tail"],
      ["Death Note - Library Edition", "Death Note"],
      ["Naruto - [Library Edition]", "Naruto"],
      ["Vagabond - Definitive Edition [Hardcover]", "Vagabond"],
    ]) {
      expect(splitReleaseTitle(`${title} (GN 2)`, entry), title).toMatchObject({
        title,
        label: "2",
        multi: false,
        editionLineHint: true,
      });
    }
    // The entry's own name carries the line name: its lines are its Volumes.
    expect(splitReleaseTitle("Makunouchi Deluxe (GN 2)", "Makunouchi Deluxe")).toMatchObject({
      label: "2",
      editionLineHint: false,
    });
  });

  it("leaves reissues, bindings and variants single Volumes", () => {
    for (const [title, entry] of [
      ["Dragon Ball Z [2nd Edition]", "Dragon Ball"],
      ["Oh My Goddess! [2nd Ed]", "Oh My Goddess!"],
      ["Buddha - Deer Park [Hardcover]", "Buddha"],
      ["Gunsmith Cats [Revised Edition]", "Gunsmith Cats"],
      ["Dominion [4th Edition]", "Dominion"],
      ["Kamisama Kiss - [Limited Edition]", "Kamisama Kiss"],
      ["Soul Eater - [Slipcased Edition]", "Soul Eater"],
      ["Attack on Titan - [Special Edition with DVD]", "Attack on Titan"],
      // Anniversary reprints, numbered by Volume.
      ["NANA - [25th Anniversary Edition]", "NANA"],
      ["Bleach - 20th Anniversary Edition", "Bleach"],
      ["The Walking Man [Anniversary Edition]", "The Walking Man"],
    ]) {
      const split = splitReleaseTitle(`${title} (GN 5)`, entry);
      expect(split, title).toMatchObject({ label: "5", multi: false, editionLineHint: false });
      expect(split?.coverRange, title).toBeUndefined();
    }
  });

  it("reads a packaged title's bracketed Volume list as its coverage", () => {
    // VIZ's VIZBIG Rurouni Kenshin: the designator is the line position.
    expect(
      splitReleaseTitle("Rurouni Kenshin - VIZBIG Edition [13-15] (GN 5 / 9)", "Rurouni Kenshin"),
    ).toMatchObject({
      title: "Rurouni Kenshin - VIZBIG Edition [13-15]",
      label: "5",
      multi: false,
      editionLineHint: true,
      coverRange: { from: "13", to: "15" },
    });
    // A list no range holds is a statement all the same: held, never sized.
    // So is one the grammar does not read: never the line's size instead.
    for (const list of ["1, 3", "3-1", "1 and Vol. 3", "5"]) {
      const split = splitReleaseTitle(`Alpha - VIZBIG Edition [${list}] (GN 1)`, "Alpha");
      expect(split, list).toMatchObject({
        label: "1",
        editionLineHint: true,
        coverageGapped: true,
      });
      expect(split?.coverRange, list).toBeUndefined();
    }
    // A line, reissue or binding tag with a number in it states no Volumes.
    for (const [title, entry] of [
      ["Naruto [3-in-1 Edition]", "Naruto"],
      ["Vagabond - Definitive Edition [Hardcover]", "Vagabond"],
      ["Dragon Ball [VIZBIG Edition] [2nd Edition]", "Dragon Ball"],
    ]) {
      const split = splitReleaseTitle(`${title} (GN 2)`, entry);
      expect(split, title).toMatchObject({ label: "2", editionLineHint: true });
      expect(split?.coverageGapped, title).toBeUndefined();
    }
    // Beside a designator's own list the two must agree, or the line is held.
    const both = (text: string) => {
      const split = splitReleaseTitle(text, "Alpha");
      return split && [split.multi, split.coverRange, split.coverageGapped];
    };
    expect(both("Alpha - VIZBIG Edition [1-3] (GN 1-3)")).toEqual([
      true,
      { from: "1", to: "3" },
      undefined,
    ]);
    for (const text of [
      "Alpha - VIZBIG Edition [1, 3] (GN 1-3)",
      "Alpha - VIZBIG Edition [4-6] (GN 1-3)",
      "Alpha - VIZBIG Edition [1-3] (GN 1, 3)",
    ]) {
      expect(both(text), text).toEqual([true, undefined, true]);
    }
    // Only a packaged line's list: a bracket on any other line is its name's.
    expect(splitReleaseTitle("Alpha [1-3] (GN 1)", "Alpha")).toMatchObject({
      label: "1",
      editionLineHint: false,
    });
    expect(splitReleaseTitle("Alpha [1-3] (GN 1)", "Alpha")?.coverRange).toBeUndefined();
  });

  // A line word in the entry's own name owns the like word of the title's
  // opening words that spell the name out, never a second line the title
  // adds, nor the same word anywhere else in the title.
  it("flags a line added to a name carrying a line word, and only that", () => {
    for (const [title, entry] of [
      ["Makunouchi Deluxe [VIZBIG Edition]", "Makunouchi Deluxe"],
      ["The Omnibus Club [Colossal Edition]", "The Omnibus Club"],
      ["The Omnibus Club - [Omnibus]", "The Omnibus Club"],
      ["Makunouchi Deluxe Deluxe Edition", "Makunouchi Deluxe"],
      // Another work's bracket: the entry's word is not this title's name.
      ["Alpha [Deluxe]", "Makunouchi Deluxe"],
      ["Alpha [Omnibus]", "The Omnibus Club"],
      ["Alpha [VIZBIG Edition]", "Beta VIZBIG Edition"],
      ["Makunouchi [Deluxe]", "Makunouchi Deluxe"],
      // A title that only shortens the name does not spell it out.
      ["Alpha Deluxe", "Alpha Deluxe Edition"],
    ]) {
      expect(splitReleaseTitle(`${title} (GN 1)`, entry), title).toMatchObject({
        label: "1",
        multi: false,
        editionLineHint: true,
      });
    }
    for (const [title, entry] of [
      ["Makunouchi Deluxe", "Makunouchi Deluxe"],
      ["The Omnibus Club", "The Omnibus Club"],
      ["MAKUNOUCHI DELUXE", "Makunouchi Deluxe"],
      ["Makunouchi Deluxe: Fighting Spirit", "Makunouchi Deluxe"],
      ["Makúnouchi Deluxe", "Makunouchi Deluxe"],
    ]) {
      expect(splitReleaseTitle(`${title} (GN 2)`, entry), title).toMatchObject({
        label: "2",
        editionLineHint: false,
      });
    }
  });
});

describe("readAnnLineTitle — a packaged line's work", () => {
  it("keeps every number and mark of the work before the line's name", () => {
    for (const [title, work, lineName] of [
      ["Kingdom Hearts II [VIZBIG Edition]", "Kingdom Hearts II", "VIZBIG Edition"],
      ["Alpha 2 [VIZBIG Edition]", "Alpha 2", "VIZBIG Edition"],
      ["Citrus+ [VIZBIG Edition]", "Citrus+", "VIZBIG Edition"],
      ["Bastard!! [VIZBIG Edition]", "Bastard!!", "VIZBIG Edition"],
      ["E’S [VIZBIG Edition]", "E’S", "VIZBIG Edition"],
      ["Alpha (Manga) [VIZBIG Edition]", "Alpha (Manga)", "VIZBIG Edition"],
      ["Alpha (Light Novel) [VIZBIG Edition]", "Alpha (Light Novel)", "VIZBIG Edition"],
      ["Naruto [3-in-1 Edition]", "Naruto", "3-in-1 Edition"],
      ["Fullmetal Alchemist (3-in-1 Edition)", "Fullmetal Alchemist", "3-in-1 Edition"],
      ["Death Note - Library Edition", "Death Note", "Library Edition"],
      ["Berserk Deluxe Edition", "Berserk", "Deluxe Edition"],
      ["Fairy Tail [Master's Edition]", "Fairy Tail", "Master's Edition"],
      // The line's article is the line's: the name is read without it.
      ["Summer Ghost: The Complete Manga Collection", "Summer Ghost", "Complete Manga Collection"],
      ["Dark Metro - The Ultimate Edition", "Dark Metro", "Ultimate Edition"],
      ["Dark Metro - [The Ultimate Edition]", "Dark Metro", "Ultimate Edition"],
      // The line's position, subtitle, tags and stated Volumes go too.
      ["One Piece - [Omnibus] 33 - Wano", "One Piece", "Omnibus"],
      ["Rurouni Kenshin - VIZBIG Edition [13-15]", "Rurouni Kenshin", "VIZBIG Edition"],
      ["Rurouni Kenshin - VIZBIG Edition [1, 3]", "Rurouni Kenshin", "VIZBIG Edition"],
      ["Vagabond - Definitive Edition [Hardcover]", "Vagabond", "Definitive Edition"],
      ["Dragon Ball [VIZBIG Edition] [2nd Edition]", "Dragon Ball", "VIZBIG Edition"],
      ["Sailor Moon Eternal Edition 2", "Sailor Moon", "Eternal Edition"],
    ] as const) {
      expect(readAnnLineTitle(title), title).toMatchObject({ kind: "line", work, lineName });
    }
  });

  it("leaves the work's own line words in the work", () => {
    expect(
      readAnnLineTitle("Makunouchi Deluxe [VIZBIG Edition]", { names: ["Makunouchi Deluxe"] }),
    ).toEqual({
      kind: "line",
      work: "Makunouchi Deluxe",
      lineName: "VIZBIG Edition",
      position: null,
      tail: "[VIZBIG Edition]",
    });
    expect(
      readAnnLineTitle("The Omnibus Club [Colossal Edition]", { names: ["The Omnibus Club"] }),
    ).toMatchObject({ kind: "line", work: "The Omnibus Club", lineName: "Colossal Edition" });
    // Any of the work's spellings may account for its words.
    expect(
      readAnnLineTitle("Makunouchi Deluxe [VIZBIG Edition]", {
        names: ["Makunouchi", "Makunouchi Deluxe"],
      }),
    ).toMatchObject({ kind: "line", work: "Makunouchi Deluxe" });
  });

  it("keeps a leading The of the work's own name in the work", () => {
    expect(readAnnLineTitle("The Dark Metro - The Ultimate Edition")).toMatchObject({
      kind: "line",
      work: "The Dark Metro",
      lineName: "Ultimate Edition",
    });
    expect(
      readAnnLineTitle("The Omnibus Club [Colossal Edition]", { names: ["The Omnibus Club"] }),
    ).toMatchObject({ kind: "line", work: "The Omnibus Club", lineName: "Colossal Edition" });
  });

  it("reads the one position the line's segment states, canonical", () => {
    for (const [title, position] of [
      ["Alpha VIZBIG Edition 2", "2"],
      // Inside the line's bracket, or marked in a tag after it.
      ["Alpha [VIZBIG Edition Vol. 2]", "2"],
      ["Alpha [VIZBIG Edition II]", "2"],
      ["Alpha [VIZBIG Edition] (Book II)", "2"],
      ["Alpha [VIZBIG Edition] 2 (Vol. 2)", "2"],
      // Two that differ, or one it cannot read: none.
      ["Alpha [VIZBIG Edition 2] 1", null],
      ["Alpha [VIZBIG Edition] (Vol. ii)", null],
      ["Alpha [VIZBIG Edition] 2", "2"],
      ["Alpha [VIZBIG Edition] II", "2"],
      ["Alpha VIZBIG Edition II", "2"],
      ["Alpha VIZBIG Edition 02", "2"],
      ["Alpha VIZBIG Edition Vol. 1", "1"],
      ["One Piece - [Omnibus] 33 - Wano", "33"],
      ["Alpha VIZBIG Edition 1: Includes Vols. 4-6", "1"],
      // No position: none written, or the number opens a list.
      ["Alpha [VIZBIG Edition]", null],
      ["Alpha VIZBIG Edition 1-3", null],
      ["Alpha [VIZBIG Edition Vols. 1, 3]", null],
      ["Rurouni Kenshin - VIZBIG Edition [13-15]", null],
    ] as const) {
      expect(readAnnLineTitle(title), title).toMatchObject({ kind: "line", position });
    }
    expect(readAnnLineTitle("Alpha [VIZBIG Edition Vol. 2]")).toMatchObject({
      work: "Alpha",
      lineName: "VIZBIG Edition",
    });
  });

  it("reads a title naming no line beyond the work's own as wholly the work", () => {
    expect(readAnnLineTitle("Makunouchi Deluxe", { names: ["Makunouchi Deluxe"] })).toEqual({
      kind: "single",
      work: "Makunouchi Deluxe",
    });
    expect(readAnnLineTitle("One Piece")).toEqual({ kind: "single", work: "One Piece" });
    // Neither an anniversary reprint nor a reissue or binding tag names a line.
    for (const title of [
      "NANA - [25th Anniversary Edition]",
      "Kamisama Kiss - [Limited Edition]",
      "Oh My Goddess! [2nd Ed]",
    ]) {
      expect(readAnnLineTitle(title), title).toEqual({ kind: "single", work: title });
    }
    // A stated Volume list is coverage only on a packaged line.
    expect(readAnnLineTitle("Alpha [1-3]")).toEqual({ kind: "single", work: "Alpha [1-3]" });
    expect(readAnnLineTitle("Alpha [1-3]", { packaged: true })).toEqual({
      kind: "single",
      work: "Alpha",
    });
    // A work whose own name ends in the list keeps it.
    expect(readAnnLineTitle("Number [9]", { packaged: true, names: ["Number [9]"] })).toEqual({
      kind: "single",
      work: "Number [9]",
    });
  });

  it("names no work when the title leaves it unclear", () => {
    for (const [title, names] of [
      // Two lines, and no name to own either word.
      ["Makunouchi Deluxe [VIZBIG Edition]", []],
      ["Makunouchi Deluxe [VIZBIG Edition]", ["Makunouchi"]],
      ["Alpha Omnibus [VIZBIG Edition]", ["Alpha"]],
      // No work before the line, an open bracket, words no position explains.
      ["VIZBIG Edition", []],
      ["[VIZBIG Edition] Vagabond", ["Vagabond"]],
      ["Alpha [VIZBIG Edition", ["Alpha"]],
      ["Alpha Omnibus Club", ["Alpha"]],
    ] as const) {
      expect(readAnnLineTitle(title, { names }), title).toMatchObject({ kind: "ambiguous" });
    }
  });
});

describe("packagingOf — every fact a packaged line's title and designator state", () => {
  /** A packaged line as splitReleaseTitle stores it from "title (designator)". */
  const line = (title: string, designator = "GN 1", entry = "") => {
    const split = splitReleaseTitle(`${title} (${designator})`, entry);
    if (split === null) throw new Error(`No designator in ${title}`);
    return split;
  };
  /** The same line stored before its title's statements were read: the designator's flags only. */
  const stale = (title: string, designator = "GN 1") => ({
    ...line("Alpha", designator),
    title,
    editionLineHint: true,
  });

  it("reads the line from the title's own line name, the work's words aside", () => {
    expect(
      packagingOf(line("Makunouchi Deluxe [VIZBIG Edition]", "GN 1", "Makunouchi Deluxe"), [
        "Makunouchi Deluxe",
      ])?.line,
    ).toEqual({
      name: "VIZBIG Edition",
      position: "1",
    });
    expect(
      packagingOf(line("The Omnibus Club [Colossal Edition]", "GN 1", "The Omnibus Club"), [
        "The Omnibus Club",
      ])?.line,
    ).toEqual({
      name: "Colossal Edition",
      position: "1",
    });
    // A range under a name with a line word is an Omnibus, not that word's line.
    expect(
      packagingOf(line("Makunouchi Deluxe", "GN 1-3", "Makunouchi Deluxe"), ["Makunouchi Deluxe"]),
    ).toMatchObject({
      title: { kind: "single", work: "Makunouchi Deluxe" },
      line: { name: "Omnibus", position: null },
      coverRange: { from: "1", to: "3" },
    });
    expect(
      packagingOf(line("Makunouchi Deluxe", "GN 1", "Makunouchi Deluxe"), ["Makunouchi Deluxe"]),
    ).toBeNull();
  });

  it("keeps the parser's reading of the lines it already read", () => {
    for (const [title, name, position] of [
      ["Naruto [3-in-1 Edition]", "3-in-1 Edition", "1"],
      ["Rurouni Kenshin - VIZBIG Edition [13-15]", "VIZBIG Edition", "1"],
      ["Vagabond - Definitive Edition [Hardcover]", "Definitive Edition", "1"],
      ["Summer Ghost: The Complete Manga Collection", "Complete Collection", "1"],
      ["Kingdom Hearts II [VIZBIG Edition]", "VIZBIG Edition", "1"],
    ] as const) {
      expect(packagingOf(line(title))?.line, title).toEqual({ name, position });
    }
    // An anniversary tag on a range stays the parser's line name.
    expect(
      packagingOf(line("NANA - [25th Anniversary Edition]", "GN 1-3"), ["NANA"])?.line,
    ).toEqual({
      name: "25th Anniversary Edition",
      position: null,
    });
  });

  it("reads coverage the title states inside its line's tag or subtitle", () => {
    for (const [title, coverRange] of [
      ["Alpha [VIZBIG Edition Vols. 4-6]", { from: "4", to: "6" }],
      ["Alpha VIZBIG Edition 1: Includes Vols. 4-6", { from: "4", to: "6" }],
      ["Alpha [VIZBIG Edition] 1: Includes Vols. 4-6", { from: "4", to: "6" }],
      ["Alpha [VIZBIG Edition] (Vols. 4-6)", { from: "4", to: "6" }],
      ["Alpha 3-in-1 Edition Vols. 1-3", { from: "1", to: "3" }],
      // A tag's whole list, as the list ending a title is read.
      ["Alpha - VIZBIG Edition [4-6] [Hardcover]", { from: "4", to: "6" }],
      // No statement: nothing, so the line's size may size it.
      ["Alpha [VIZBIG Edition]", null],
    ] as const) {
      for (const stored of [line(title), stale(title)]) {
        expect(packagingOf(stored, ["Alpha"]), title).toMatchObject({
          coverRange,
          coverageGapped: false,
        });
      }
    }
  });

  it("rejects coverage no range holds, or statements that disagree, stored or freshly read", () => {
    for (const [title, designator] of [
      ["Alpha [VIZBIG Edition Vols. 1, 3]", "GN 1"],
      ["Alpha VIZBIG Edition 1: Includes Vols. 1 & 3", "GN 1"],
      ["Alpha [VIZBIG Edition] 1: Includes Vols. 1 & 3", "GN 1"],
      // A valid range elsewhere never clears a rejected statement.
      ["Alpha [VIZBIG Edition Vols. 1, 3]", "GN 1-3"],
      ["Alpha [VIZBIG Edition Vols. 1, 3] [1-3]", "GN 1"],
      // Two ranges that differ: neither is taken.
      ["Alpha [VIZBIG Edition Vols. 4-6]", "GN 1-3"],
      ["Alpha VIZBIG Edition 1: Includes Vols. 4-6", "GN 1-3"],
      ["Alpha [4-6]", "GN 1-3"],
      ["Alpha [1, 3]", "GN 1-3"],
      // A tag's list with a gap.
      ["Alpha - VIZBIG Edition [1, 3] [Hardcover]", "GN 1-3"],
    ] as const) {
      for (const stored of [line(title, designator), stale(title, designator)]) {
        expect(packagingOf(stored, ["Alpha"]), `${title} (${designator})`).toMatchObject({
          coverRange: null,
          coverageGapped: true,
        });
      }
    }
  });

  it("takes the title's position, the designator's only when the title has none, and flags two", () => {
    for (const [title, designator, position, positionConflict] of [
      ["Alpha VIZBIG Edition 2", "GN 4-6", "2", false],
      ["Alpha [VIZBIG Edition] II", "GN 4-6", "2", false],
      ["Alpha [VIZBIG Edition] II", "GN 2", "2", false],
      ["Alpha VIZBIG Edition 02", "GN 2", "2", false],
      ["Alpha [VIZBIG Edition]", "GN 2", "2", false],
      ["One Piece - [Omnibus] 33 - Wano", "GN 97-99", "33", false],
      // Two positions that differ: no position, and the conflict is stated.
      ["Alpha VIZBIG Edition 2", "GN 1", null, true],
      ["Alpha [VIZBIG Edition] 2", "GN 1", null, true],
      ["Alpha [VIZBIG Edition] II", "GN 3", null, true],
      // A tag after the line numbers it too.
      ["Alpha [VIZBIG Edition] (GN 2)", "GN 2", "2", false],
      ["Alpha [VIZBIG Edition] (GN 5)", "GN 1", null, true],
      ["Alpha VIZBIG Edition 2 (Vol. 3)", "GN 4-6", null, true],
      // A list in a tag is coverage, not a position.
      ["Alpha [VIZBIG Edition] (Vols. 4-6)", "GN 1", "1", false],
    ] as const) {
      expect(packagingOf(line(title, designator), ["Alpha", "One Piece"]), title).toMatchObject({
        line: { position },
        positionConflict,
      });
    }
    // A known line keeps its name where the shared parser reads no position.
    expect(packagingOf(line("Alpha [VIZBIG Edition] II", "GN 4-6"), ["Alpha"])?.line).toEqual({
      name: "VIZBIG Edition",
      position: "2",
    });
  });

  it("reads a line's article as the line's", () => {
    for (const title of [
      "Dark Metro - The Ultimate Edition",
      "Dark Metro - [The Ultimate Edition]",
    ]) {
      expect(packagingOf(line(title, "GN 1-3", "Dark Metro"), ["Dark Metro"]), title).toMatchObject(
        {
          title: { kind: "line", work: "Dark Metro" },
          line: { name: "Ultimate Edition", position: null },
          coverRange: { from: "1", to: "3" },
        },
      );
    }
  });

  it("reads a bare range title as the work and its range, its own bracket kept by a name that ends in it", () => {
    expect(packagingOf(line("Alpha [1-3]", "GN 1-3", "Alpha"), ["Alpha"])).toMatchObject({
      title: { kind: "single", work: "Alpha" },
      line: { name: "Omnibus", position: null },
      coverRange: { from: "1", to: "3" },
      coverageGapped: false,
    });
    expect(packagingOf(line("Number [9]", "GN 1-2", "Number [9]"), ["Number [9]"])).toMatchObject({
      title: { kind: "single", work: "Number [9]" },
      line: { name: "Omnibus" },
      coverRange: { from: "1", to: "2" },
    });
  });

  it("names no line for an unclear title, and nothing for a box set", () => {
    expect(packagingOf(line("Alpha [VIZBIG Edition] [Omnibus]"), ["Alpha"])).toMatchObject({
      title: { kind: "ambiguous" },
      line: null,
    });
    expect(packagingOf(line("Makunouchi Deluxe [VIZBIG Edition]"), ["Makunouchi"])).toMatchObject({
      line: null,
    });
    expect(packagingOf(line("Alpha Box Set", "GN 1-3"), ["Alpha"])).toBeNull();
  });
});

describe("packagingOf — every statement in a line's segment, read whole", () => {
  const read = (title: string, designator = "GN 1") => {
    const split = splitReleaseTitle(`${title} (${designator})`, "Alpha");
    if (split === null) throw new Error(`No designator in ${title}`);
    return { fresh: packagingOf(split, ["Alpha"]), stored: split };
  };
  const cover = (range: { from: string; to: string } | null) =>
    range === null ? "rejected" : `${range.from}-${range.to}`;

  // One list, written in each place a line's title states coverage, reads
  // the same everywhere: a range only when every item runs in order with no
  // gap and Coverage can list it.
  const PLACES = [
    (list: string) => `Alpha [VIZBIG Edition Vols. ${list}]`,
    (list: string) => `Alpha VIZBIG Edition ${list}`,
    (list: string) => `Alpha [VIZBIG Edition] (Vols. ${list})`,
    (list: string) => `Alpha [VIZBIG Edition] [${list}]`,
    (list: string) => `Alpha VIZBIG Edition 1: Includes Vols. ${list}`,
    (list: string) => `Alpha [VIZBIG Edition] (Contains Vols. ${list})`,
  ];
  it.each([
    ["4-6", "4-6"],
    ["1-3, 4-6", "1-6"],
    ["2-4, 5", "2-5"],
    ["1, 3", "rejected"],
    ["1 & 3", "rejected"],
    ["1-3, 7-9", "rejected"],
    ["1-3-5", "rejected"],
    ["6-4", "rejected"],
    ["1-3, 6-4", "rejected"],
    ["1.5-3.5", "rejected"],
    ["1-80", "rejected"],
  ])("reads the list %s as %s wherever the title writes it", (list, expected) => {
    for (const place of PLACES) {
      const title = place(list);
      const { fresh, stored } = read(title);
      expect(fresh, title).toMatchObject({
        coverageGapped: expected === "rejected",
        positionConflict: false,
        line: { name: "VIZBIG Edition", position: "1" },
      });
      expect(cover(fresh!.coverRange), title).toBe(expected);
      // The snapshot keeps the same reading, a rejection included.
      expect(stored.coverageGapped === true ? "rejected" : cover(stored.coverRange!), title).toBe(
        expected,
      );
    }
  });

  // A second statement appended to any first one is never dropped: one that
  // agrees keeps the range, one that differs, skips a Volume or reads no
  // range rejects it. The designator is one more statement.
  const BASES = [
    "Alpha [VIZBIG Edition Vols. 4-6]",
    "Alpha VIZBIG Edition 4-6",
    "Alpha [VIZBIG Edition] (Vols. 4-6)",
    "Alpha VIZBIG Edition 1: Includes Vols. 4-6",
    "Alpha VIZBIG Edition 1: Includes Vols. 1-3 plus 4-6",
  ];
  const SECOND = [
    (list: string) => ` (Vols. ${list})`,
    (list: string) => ` [${list}]`,
    (list: string) => ` (Includes Vols. ${list})`,
  ];
  it.each([
    ["4-6", true],
    ["1-3", false],
    ["4, 6", false],
    ["4-6-8", false],
    ["6-4", false],
    ["4.5-6", false],
    ["1-80", false],
  ])("keeps a second statement %s beside the first (agrees: %s)", (list, agrees) => {
    for (const base of BASES) {
      const first = read(base).fresh!.coverRange!;
      for (const second of SECOND) {
        const title = `${base}${second(list)}`;
        const same = agrees && first.from === "4";
        const { fresh } = read(title);
        expect(fresh?.coverageGapped, title).toBe(!same);
        expect(fresh?.coverRange, title).toEqual(same ? first : null);
      }
    }
  });

  it("reads the designator as one more statement beside the title's", () => {
    for (const base of BASES.slice(0, 3)) {
      expect(read(base, "GN 4-6").fresh?.coverRange, base).toEqual({ from: "4", to: "6" });
      expect(read(base, "GN 1-3").fresh?.coverageGapped, base).toBe(true);
      expect(read(base, "GN 1, 3").stored.coverageGapped, base).toBe(true);
    }
  });

  // Every position the title states, in any spelling the grammar reads, must
  // agree with the others and with a single designator's label; a range
  // designator is coverage. One it cannot read is never filled in.
  const POSITIONED = [
    "Alpha VIZBIG Edition 2",
    "Alpha VIZBIG Edition Vol. 2",
    "Alpha [VIZBIG Edition] II",
    "Alpha [VIZBIG Edition Vol. 2]",
    "Alpha [VIZBIG Edition II]",
    "Alpha [VIZBIG Edition] (Vol. 2)",
    "Alpha [VIZBIG Edition] [Book II]",
    "Alpha [VIZBIG Edition] (GN 2)",
    "Alpha [VIZBIG Edition Book II]",
  ];
  it.each([
    [" (Vol. 2)", "GN 2", "2"],
    [" (Book II)", "GN 2", "2"],
    ["", "GN 4-6", "2"],
    [" (Vol. II)", "GN 4-6", "2"],
    [" (Vol. 3)", "GN 2", null],
    ["", "GN 1", null],
    [" (Vol. II)", "GN 1", null],
    [" (Vol. ii)", "GN 2", null],
    [" (Vol. two)", "GN 2", null],
    [" (Vol. -2)", "GN 2", null],
    [" (Vol. 2A)", "GN 2", null],
  ] as const)("reads a position with%s at %s as %s", (second, designator, position) => {
    for (const base of POSITIONED) {
      const title = `${base}${second}`;
      const { fresh } = read(title, designator);
      expect(fresh, title).toMatchObject({
        positionConflict: position === null,
        line: { name: "VIZBIG Edition", position },
      });
    }
  });

  it("keeps a number beside the line's name out of the name, and words without one in it", () => {
    for (const [title, name] of [
      ["Alpha [VIZBIG Edition Vol. 2]", "VIZBIG Edition"],
      ["Alpha [VIZBIG Edition 2]", "VIZBIG Edition"],
      ["Alpha [VIZBIG Edition I]", "VIZBIG Edition"],
      ["Alpha [VIZBIG Edition Two]", "VIZBIG Edition"],
      ["Alpha [VIZBIG Edition Vols. 1-3]", "VIZBIG Edition"],
      ["Alpha [VIZBIG Edition Includes Vols. 1-3 plus 4-6]", "VIZBIG Edition"],
      ["Alpha [Side Story VIZBIG Edition]", "Side Story VIZBIG Edition"],
      ["Alpha [VIZBIG Edition Hardcover]", "VIZBIG Edition"],
      ["Alpha [3-in-1 Edition] 2", "3-in-1 Edition"],
    ] as const) {
      expect(read(title, "GN 2").fresh?.line?.name, title).toBe(name);
    }
    // An n-in-1 name's count is the line's: the book is 2, nothing conflicts.
    // A lone numeral in the bracket is the book's position.
    expect(read("Alpha [VIZBIG Edition I]", "GN 1").fresh?.line).toEqual({
      name: "VIZBIG Edition",
      position: "1",
    });
    expect(read("Alpha [VIZBIG Edition I]", "GN 2").fresh?.positionConflict).toBe(true);
    expect(read("Alpha [3-in-1 Edition] 2", "GN 2").fresh).toMatchObject({
      line: { position: "2" },
      positionConflict: false,
      coverRange: null,
      coverageGapped: false,
    });
  });

  it("passes over a reissue or binding tag, and holds a number it cannot place", () => {
    for (const title of [
      "Alpha [VIZBIG Edition] [2nd Edition]",
      "Alpha [VIZBIG Edition] (Hardcover)",
      "Alpha [VIZBIG Edition] [Side Story]",
      "One Piece - [Omnibus] 33 - Wano",
    ]) {
      expect(read(title, "GN 2").fresh, title).toMatchObject({
        coverageGapped: false,
        positionConflict: title.startsWith("One Piece"),
      });
    }
    for (const title of [
      "Alpha [VIZBIG Edition] (Part 2)",
      "Alpha VIZBIG Edition 1: Arc 3",
      "Alpha [VIZBIG Edition] (Vol. 2 / 4)",
      "Alpha [2 VIZBIG Edition]",
    ]) {
      expect(read(title).fresh, title).toMatchObject({
        coverRange: null,
        coverageGapped: true,
        positionConflict: true,
      });
    }
  });

  // A box set's name is the bundle's ("[Box Set - Part 1]"): nothing in it is
  // read as the book's, and its designator's range is stored as it reads.
  it("reads a box set's designator alone", () => {
    for (const title of [
      "The Quintessential Quintuplets - [Box Set - Part 1]",
      "Akira [35th Anniversary Box Set]",
    ]) {
      const { fresh, stored } = read(title, "GN 1-7");
      expect(fresh, title).toBeNull();
      expect(stored, title).toMatchObject({ coverRange: { from: "1", to: "7" } });
      expect(stored.coverageGapped, title).toBeUndefined();
    }
  });
});

describe("splitReleaseTitle — a packaged title's own statements, stored", () => {
  it("stores the coverage the title and designator agree on, and rejects any other", () => {
    expect(splitReleaseTitle("Alpha [VIZBIG Edition Vols. 4-6] (GN 1)", "Alpha")).toMatchObject({
      label: "1",
      coverRange: { from: "4", to: "6" },
    });
    expect(splitReleaseTitle("Alpha [1-3] (GN 1-3)", "Alpha")).toMatchObject({
      multi: true,
      editionLineHint: false,
      coverRange: { from: "1", to: "3" },
    });
    expect(splitReleaseTitle("Number [9] (GN 1-2)", "Number [9]")).toMatchObject({
      coverRange: { from: "1", to: "2" },
    });
    for (const text of [
      "Alpha [VIZBIG Edition Vols. 1, 3] (GN 1)",
      "Alpha VIZBIG Edition 1: Includes Vols. 1 & 3 (GN 1)",
      "Alpha [VIZBIG Edition Vols. 4-6] (GN 1-3)",
      "Alpha [4-6] (GN 1-3)",
      "Alpha [1, 3] (GN 1-3)",
    ]) {
      const split = splitReleaseTitle(text, "Alpha");
      expect(split, text).toMatchObject({ coverageGapped: true });
      expect(split?.coverRange, text).toBeUndefined();
    }
  });
});

// Trimmed copies of live release pages (fetched 2026-09-25, 10948 and 23227
// again on 2026-10-02 with their descriptions; 10045 from the release-less
// audit's cache): the fields block and the entry link, with a site-chrome
// manga link in front to prove the entry link is the one read. "…" marks a
// description the trim left out.
const GN_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><div id="cover_placeholder"></div><b>Title:</b> One Piece<br><b>Volume:</b>  GN 113<br><b>Pages:</b> 208<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2026-11-10<br><b>Suggested retail price:</b> $11.99<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">9747</span><span title="product">6670</span><span title="check digit">5</span></span><span style="visibility:hidden"> 1974766705</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">9747</span><span title="product">6670</span><span title="check digit">3</span></span><span style="visibility:hidden"> 9781974766703</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2026-03-17, modified on 2026-03-17)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

const EBOOK_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/23227.jpg" align="RIGHT"><b>Title:</b> One Piece - Romance Dawn<br><b>Volume:</b>  eBook 1<br><b>Running time:</b> 210<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2013-02-19<br><b>Suggested retail price:</b> $6.99<br></p><p><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">4525</span><span title="check digit">7</span></span><span style="visibility:hidden"> 9781421545257</span><br></p><p class="easyread-width"><b>Description:</b><br></p><div class="simple-html">A new shonen sensation in Japan,\u200b this series features Monkey D.\u200b Luffy,\u200b whose main ambition is to become a pirate.\u200b Eating the Gum-Gum Fruit gives him strange powers but also invokes the fruit's curse: anybody who consumes it can never learn to swim.\u200b Nevertheless,\u200b Monkey and his crewmate Roronoa Zoro,\u200b master of the three-sword fighting style,\u200b sail the Seven Seas of swashbuckling adventure in search of the elusive treasure "One Piece.\u200b"</div><p></p><p><small>(added on 2013-02-27, modified on 2014-09-18)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

// An older page: the Description runs inline, its paragraphs split by <br>s.
const ROMANCE_DAWN_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/10948.jpg" align="RIGHT"><b>Title:</b> One Piece - Romance Dawn<br><b>Volume:</b>  GN 1<br><b>Pages:</b> 208<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2003-06-01<br><b>Suggested retail price:</b> $7.95<br><b>Age rating:</b> 13+<br></p><p><b>SKU:</b> <span class="release-ean">CTOP-01</span><br><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">56931</span><span title="product">901</span><span title="check digit">4</span></span><span style="visibility:hidden"> 1569319014</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">56931</span><span title="product">901</span><span title="check digit">7</span></span><span style="visibility:hidden"> 9781569319017</span><br></p><p class="easyread-width"><b>Description:</b><br>In a world of pirates, one man wants to become the greatest of them all: Monkey D. Luffy, who gained strange powers from eating the cursed Gum-Gum Fruit!<br>
<br>
As a child, Luffy was inspired to become a pirate by listening to the tales of the buccaneer "Red-Haired" Shanks. Now, Luffy is grown up and sets out to sea in a rowboat, in search of "One Piece," the greatest treasure in the world! But is Roronoa Zoro, the pirate hunter, a friend or a foe?<br>
<br>
Story and art by Eiichiro Oda.</p><p><small>(added on 2008-01-04, modified on 2008-01-04)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

// A sparse 2006 entry (fetched 2026-10-02): no description, only ANN's
// review link inside the Description field.
const NO_DESCRIPTION_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><div id="cover_placeholder"></div><b>Title:</b> June<br><b>Volume:</b>  GN 4<br><b>Pages:</b> 200<br><b>Distributor:</b> <a href="company.php?id=7117">Netcomics</a><p><b>Release date:</b> 2007-11-30<br><b>Suggested retail price:</b> $9.99<br><b>Age rating:</b> 13+<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">60009</span><span title="product">143</span><span title="check digit">1</span></span><span style="visibility:hidden"> 1600091431</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">60009</span><span title="product">143</span><span title="check digit">8</span></span><span style="visibility:hidden"> 9781600091438</span><br></p><p class="easyread-width"><b>Description:</b><br><a href="0/0/reviews/new">Submit your own review of this item.</a></p><p><small>(added on 2006-12-01, modified on 2006-12-01)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=7283">June (manhwa)</a></b></li></ul></body></html>`;

// A 2002 VIZ entry (fetched 2026-10-02): a U+0092 ANN serves for an
// apostrophe, and ANN's Notes as a field of their own after the Description.
const NOTES_FIELD_PAGE = `<html><body><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/41568.jpg" align="RIGHT"><b>Title:</b> Bastard!! - [1st Ed]<br><b>Volume:</b>  GN 2<br><b>Pages:</b> 192<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2002-11-05<br><b>Suggested retail price:</b> $9.95<br><b>Age rating:</b> 17+<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">56931</span><span title="product">769</span><span title="check digit">0</span></span><span style="visibility:hidden"> 1569317690</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">56931</span><span title="product">769</span><span title="check digit">3</span></span><span style="visibility:hidden"> 9781569317693</span><br></p><p class="easyread-width"><b>Description:</b><br>After making their way past giant eyeballs in the perilous dungeon, Dark Schneider and Princess Sheila face the first of the Four Divine Kings of the Rebel Armies. Meanwhile, news of Dark Schneider\u0092s resurrection reaches the bloodthirsty sorceress who was once his lover. The Bastard!! series has been adapted into a Japanese PlayStation game and a six-episode anime series.</p><p class="easyread-width"><b>Notes:</b><br>Published in left-to-right "flipped" format.</p><p><small>(added on 2021-10-09, modified on 2021-10-09)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1214">Bastard!! (manga)</a></b></li></ul></body></html>`;

const BOX_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/24124.jpg" align="RIGHT"><b>Title:</b> One Piece - East Blue and Baroque Works Box Set<br><b>Volume:</b>  GN 1-23<br><b>Pages:</b> 4720<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2013-11-05<br><b>Suggested retail price:</b> $185.99<br><b>Age rating:</b> 13+<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">4215</span><span title="product">6074</span><span title="check digit">7</span></span><span style="visibility:hidden"> 1421560747</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">6074</span><span title="check digit">8</span></span><span style="visibility:hidden"> 9781421560748</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2013-06-18, modified on 2013-06-18)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

const OLD_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/10045.jpg" align="RIGHT"><b>Title:</b> Fall in Love Like a Comic!<br><b>Volume:</b>  GN 2 / 2<br><b>Pages:</b> 192<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2008-01-01<br><b>Suggested retail price:</b> $8.99<br><b>Age rating:</b> 15+<br></p><p><b>SKU:</b> <span class="release-ean">CTFL-02</span><br><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">4215</span><span title="product">1374</span><span title="check digit">9</span></span><span style="visibility:hidden"> 1421513749</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">1374</span><span title="check digit">4</span></span><span style="visibility:hidden"> 9781421513744</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2007-10-05, modified on 2007-10-05)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=8124">Zoku Manga Mitaina Koi Shitai!</a></b></li></ul></body></html>`;

describe("parseReleasePage", () => {
  it("derives an ISBN-13 when an older release lists only ISBN-10", () => {
    const page = "<b>Title:</b> Example<br><b>ISBN-10:</b> 1421513749<br>";
    expect(parseReleasePage(page)).toMatchObject({
      isbn10: "1421513749",
      isbn13: "9781421513744",
    });
  });

  it("reads distributor, ISBNs, date, price, and the entry of a GN page", () => {
    expect(parseReleasePage(GN_PAGE)).toEqual({
      title: "One Piece",
      volume: "GN 113",
      distributor: "Viz Media",
      distributorId: "4552",
      date: { year: 2026, month: 11, day: 10 },
      isbn13: "9781974766703",
      isbn10: "1974766705",
      priceCents: 1199,
      mangaId: "1223",
      // The trimmed fixture's elided text.
      description: "…",
    });
  });

  it("reads an eBook page without an ISBN-10 and a box set page", () => {
    expect(parseReleasePage(EBOOK_PAGE)).toMatchObject({
      volume: "eBook 1",
      isbn13: "9781421545257",
      isbn10: undefined,
      priceCents: 699,
    });
    expect(parseReleasePage(BOX_PAGE)).toMatchObject({
      title: "One Piece - East Blue and Baroque Works Box Set",
      volume: "GN 1-23",
      isbn13: "9781421560748",
    });
  });

  it("keeps ANN's pre-2010 day-01 month placeholder, and rejects non-release pages", () => {
    expect(parseReleasePage(OLD_PAGE)).toMatchObject({
      distributor: "Viz Media",
      date: { year: 2008, month: 1 },
      isbn13: "9781421513744",
      isbn10: "1421513749",
    });
    expect(parseReleasePage("<html><body>No such release</body></html>")).toBeNull();
  });

  it("reads the Description in both live shapes, without the added-on trailer", () => {
    expect(parseReleasePage(ROMANCE_DAWN_PAGE)).toMatchObject({
      title: "One Piece - Romance Dawn",
      volume: "GN 1",
      isbn13: "9781569319017",
      mangaId: "1223",
      description:
        // ANN's appended credit sentence is dropped: the byline shows it.
        'In a world of pirates, one man wants to become the greatest of them all: Monkey D. Luffy, who gained strange powers from eating the cursed Gum-Gum Fruit! As a child, Luffy was inspired to become a pirate by listening to the tales of the buccaneer "Red-Haired" Shanks. Now, Luffy is grown up and sets out to sea in a rowboat, in search of "One Piece," the greatest treasure in the world! But is Roronoa Zoro, the pirate hunter, a friend or a foe?',
    });
    // The newer layout: text in a div after the field's paragraph, with
    // zero-width spaces after its punctuation.
    const ebook = parseReleasePage(EBOOK_PAGE)!.description!;
    expect(ebook).toMatch(
      /^A new shonen sensation in Japan, this series features Monkey D\. Luffy, /,
    );
    expect(ebook).toMatch(/in search of the elusive treasure "One Piece\."$/);
    expect(ebook).not.toMatch(/[\u200B-\u200D\uFEFF]|added on/);
  });

  // Synthetic shapes inside the real pages' field markup.
  const inlineField = (text: string) =>
    ROMANCE_DAWN_PAGE.replace(
      /<p class="easyread-width">[\s\S]*?<\/p><p><small>/,
      `<p class="easyread-width"><b>Description:</b><br>${text}</p><p><small>`,
    );
  const divField = (text: string) =>
    EBOOK_PAGE.replace(
      /<div class="simple-html">[\s\S]*?<\/div><p><\/p>/,
      `<div class="simple-html">${text}</div><p></p>`,
    );

  it("keeps markup inside the Description from cutting it short", () => {
    expect(
      parseReleasePage(inlineField("Includes:<ul><li>Volume 1</li><li>Volume 2</li></ul>"))
        ?.description,
    ).toBe("Includes: Volume 1 Volume 2");
    expect(
      parseReleasePage(
        inlineField("Pirates <small>(and ninjas)</small> sail.<br><b>Note:</b> Bonus story."),
      )?.description,
    ).toBe("Pirates (and ninjas) sail. Note: Bonus story.");
    expect(
      parseReleasePage(
        divField("<p>Part one.</p><div>Part <small>two</small>.</div><ul><li>A list</li></ul>"),
      )?.description,
    ).toBe("Part one. Part two. A list");
  });

  it("strips zero-width spaces, entity-encoded ones too", () => {
    expect(
      parseReleasePage(divField("Luffy,&#8203; Zoro,\u200b and Nami&#x200B;."))?.description,
    ).toBe("Luffy, Zoro, and Nami.");
    expect(parseReleasePage(divField("&#8203;"))?.description).toBeUndefined();
  });

  it("never returns ANN's review link as a description", () => {
    expect(parseReleasePage(NO_DESCRIPTION_PAGE)).toMatchObject({
      title: "June",
      volume: "GN 4",
      distributor: "Netcomics",
      isbn13: "9781600091438",
      mangaId: "7283",
      description: undefined,
    });
    // The link after real text goes too.
    expect(
      parseReleasePage(
        inlineField(
          'A story.<br><a href="0/0/reviews/new">Submit your own review of this item.</a>',
        ),
      )?.description,
    ).toBe("A story.");
  });

  it("has no description when the page has none", () => {
    const field = /<p class="easyread-width">[\s\S]*?<\/p>/;
    expect(field.test(ROMANCE_DAWN_PAGE)).toBe(true);
    const absent = ROMANCE_DAWN_PAGE.replace(field, "");
    const empty = ROMANCE_DAWN_PAGE.replace(
      field,
      '<p class="easyread-width"><b>Description:</b><br></p>',
    );
    expect(parseReleasePage(absent)).toMatchObject({
      isbn13: "9781569319017",
      description: undefined,
    });
    expect(parseReleasePage(empty)?.description).toBeUndefined();
  });
});

describe("cleanAnnDescription", () => {
  it("drops ANN's trailing credit sentences", () => {
    expect(
      cleanAnnDescription(
        "But is Roronoa Zoro, the pirate hunter, a friend or a foe? Story and art by Eiichiro Oda.",
      ),
    ).toBe("But is Roronoa Zoro, the pirate hunter, a friend or a foe?");
    expect(
      cleanAnnDescription("Noriko needs all the help she can get. Story and art by Kiyoko Hikawa."),
    ).toBe("Noriko needs all the help she can get.");
    expect(cleanAnnDescription("Magic school! Story & Art by CLAMP")).toBe("Magic school!");
    expect(cleanAnnDescription('"Run!" Written and illustrated by Ken Akamatsu.')).toBe('"Run!"');
  });

  // Real endings from production descriptions.
  it.each([
    "Story by Yumi Hotta and Art by Takeshi Obata.",
    "Story by Ken Akamatsu and art by RAN.",
    "Story by Eiji Otsuka and Art by Sho-u Tajima.",
    "Story by Haruka Aoi and Art by BH SNOW+CLINIC.",
    "Story by Naoki Hisaya and Art by Chaco Abeno",
    "Story and art by Dat Nishiwaki and Original Concept by Type-Moon.",
    "Story and art by Yu Yagami and Original Story by Taro Achi.",
    "Original story by Studio BONES and story and art by Jinsei Kataoka & Kazuma Kondou.",
    "Manga by Mizutaka Suhou and original story by Akira Kurosawa.",
    "Originally written by Hideyuki Kikuchi, adapted by Saiko Takaki.",
    "Story by Sunao Yoshida and Art by Kiyo Kyujyo; Character Designs by Thores Shibamoto.",
    "Written by Yuya Aoki and Illustrated by Rando Ayamine.",
    "Story and Kazuo Koike and Art by Goseki Kojima.",
    "Story and art by by Akira Himekawa.",
    "Story and art by Masanori*Ookamigumi*Katakura.",
    "Story and art by Oh!Great.",
    "Story and art by MEE (Minoru Tachikawa).",
    "Adapted by Chayamachi Suguro.",
    "Story and art by Eiichiro Oda. Notes: Recalled due to a misprint on page 193.",
  ])("drops the credit ending %j", (ending) => {
    expect(cleanAnnDescription(`Will they win the final battle? ${ending}`)).toBe(
      "Will they win the final battle?",
    );
  });

  it("drops only the fused credit glued to the copy before it", () => {
    expect(cleanAnnDescription("The end of her Story and art by Akihisa Ikeda.")).toBe(
      "The end of her",
    );
    // Two clauses glued mid-sentence stay: never cutting prose costs this
    // one real credit.
    const glued =
      "Insights from an E.R. physician Story by Koshun Takami and art by Masayuki Taguchi.";
    expect(cleanAnnDescription(glued)).toBe(glued);
  });

  it.each([
    "Here is the story of The Mandalorian, and his desperate quest to save the Child and himself. Based on the series created by Jon Favreau and written by Dave Filoni.",
    "That is the desire to defeat his father! Created by Masashi Kishimoto and features story by Ukyo Kodachi and art by Mikio Ikemoto.",
  ])("never cuts credits out of the middle of a sentence: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it.each([
    "Story by ufotable and Art by tartan check.",
    "Story and art by atsushi Suzumi.",
    "Story and art by est em.",
    "Story and art by Oh! great.",
    "Story by Girls und Panzer Projekt and Art by Ryohichi Saitaniya.",
    "Story and art by Written by Koji Kumeta.",
    "Sotyr and art by Julietta Suzuki.",
    "Story and and art by You Higuri.",
    "Written and art by Minako Narita.",
    "Story and art by Kei Toume .",
  ])(
    "drops a credit sentence with lower-case or odd names, a typo or a doubled prefix: %j",
    (ending) => {
      expect(cleanAnnDescription(`Will they win? ${ending}`)).toBe("Will they win?");
    },
  );

  it("drops a credit glued to the full stop before it", () => {
    expect(
      cleanAnnDescription(
        "Teenage madness in this concluding volume.Story and art by Usamaru Furuya.",
      ),
    ).toBe("Teenage madness in this concluding volume.");
  });

  it.each([
    "Who is the traitor? Story and art by Mizumomoto and is created by Atlus.",
    "Can she win him over? Story and Art by Rie Takada - creator of Wild Act.",
    "Exciting adventures! Story and art by Kanan and others.",
    "A tale for all. Story and art by everyone.",
    // Constructed prose with lower-case "names": only the known name
    // words (`LOWERCASE_NAME_WORDS`) pass.
    "It began. Story by committee, art by accident.",
    "It began. Script by day, art by night.",
    "It began. Created by pure accident.",
    "It began. Adapted by popular demand.",
    "It began. Written by hand and illustrated by candlelight.",
    "It began. Story and art by everyone involved.",
    "A thriller . . .",
  ])("keeps a credit sentence that goes on as prose: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it("drops ANN's fused credit when it opens the text", () => {
    expect(cleanAnnDescription("Story and art by Taeko Watanabe. Romance between swordsmen.")).toBe(
      "Romance between swordsmen.",
    );
    expect(
      cleanAnnDescription("Story and art by Oh!Great. FEARSOME FRIEND AND FOE On their mission!"),
    ).toBe("FEARSOME FRIEND AND FOE On their mission!");
  });

  it.each([
    "Story by Taeko Watanabe. Romance between swordsmen.",
    "Story and art by J. K. Smith. A tale.",
    "Story and art by the sea. A tale.",
  ])("keeps an opening credit that is not fused, has an initial, or names no one: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it.each([
    // Glued mid-sentence with one clause: prose, not ANN's credit.
    "Their journey begins a Love Story by Moonlight.",
    "She paints a Story by Candlelight.",
    // One common-noun word after a plain role.
    "It all started here. Created by God.",
    "The plan was doomed. Art by Committee.",
    "Every letter matters. Written by Hand.",
    // A shouted sentence.
    "The lab burns. CREATED BY ACCIDENT, THE CLONE SEEKS REVENGE.",
    // A "Notes:" line that is the publisher's copy.
    "A mystery unfolds. Notes: none of this is what it seems.",
  ])("keeps prose that only looks like a credit: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it("drops a one-word fused credit and ANN's note about the release", () => {
    expect(cleanAnnDescription("A one-shot. Story and art by CLAMP.")).toBe("A one-shot.");
    expect(
      cleanAnnDescription(
        "A sequel. Notes: This volume despite being numbered as the first volume contains material from the 10th volume of the Japanese release.",
      ),
    ).toBe("A sequel.");
  });

  it.each([
    "Story and art by Osamu Tezuka. Harcover edition limited to only 1,500 copies",
    "Story and art by Miwa Ueda. #75 - What's Hot Pick",
    "Written and drawn by Yukito Kishiro. 232 pages.",
  ])("keeps an ending with other text after the credit: %j", (ending) => {
    const text = `Will they win? ${ending}`;
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it.each([
    "Story and art by Eiichiro Oda.",
    "Story and art by Yonezou Nekota.",
    "Submit your own review of this item.",
  ])("has nothing left of a text that is only a credit or page chrome: %j", (text) => {
    expect(cleanAnnDescription(text)).toBeUndefined();
  });

  it.each([
    "A tale. Story and art by Eiichiro Oda. Now in a deluxe edition.",
    "A thriller. Art by the creator of the hit series.",
    "The cover was created by hand.",
    "A gripping tale created by fans and rewritten by many hands across the years.",
  ])("keeps a credit that is prose, mid-text, or not a sentence of its own: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it("repairs mojibake and is idempotent on clean text", () => {
    expect(cleanAnnDescription("Tsukasaâ€™s secret. Story by A B.")).toBe("Tsukasa’s secret.");
    const clean = "Luffy, Zoro, and Nami. A friend or a foe?";
    expect(cleanAnnDescription(clean)).toBe(clean);
    expect(cleanAnnDescription(cleanAnnDescription("X. Story by Y Z.")!)).toBe("X.");
  });
});

describe("cleanAnnDescription: ANN's notes, C1 controls, entities and listing junk", () => {
  it("reads only the Description, not the Notes field after it, and maps U+0092", () => {
    const page = parseReleasePage(NOTES_FIELD_PAGE)!;
    expect(page.description).toBe(
      "After making their way past giant eyeballs in the perilous dungeon, Dark Schneider and Princess Sheila face the first of the Four Divine Kings of the Rebel Armies. Meanwhile, news of Dark Schneider’s resurrection reaches the bloodthirsty sorceress who was once his lover. The Bastard!! series has been adapted into a Japanese PlayStation game and a six-episode anime series.",
    );
    expect(page.isbn13).toBe("9781569317693");
  });

  // Bold-label paragraphs inside the copy are copy; only ANN's own
  // `<p class="easyread-width"><b>Notes:</b>` field ends the Description.
  const notesField =
    '<p class="easyread-width"><b>Notes:</b><br>Published in left-to-right "flipped" format.</p>';
  const withField = (description: string, after = "") =>
    NOTES_FIELD_PAGE.replace(
      /<p class="easyread-width"><b>Description:<\/b>[\s\S]*?(?=<p><small>)/,
      `<p class="easyread-width"><b>Description:</b>${description}${after}`,
    );

  it("keeps the copy's own bold-label paragraphs, inline and in a div", () => {
    expect(
      parseReleasePage(
        withField("<br>A story.</p><p><b>Bonus Features:</b> Sketches and an interview.</p>"),
      )?.description,
    ).toBe("A story. Bonus Features: Sketches and an interview.");
    expect(
      parseReleasePage(
        withField(
          '<br></p><div class="simple-html"><p>A story.</p><p><b>Bonus Features:</b> Sketches.</p></div><p></p>',
        ),
      )?.description,
    ).toBe("A story. Bonus Features: Sketches.");
    expect(
      parseReleasePage(withField("<br>A story.</p><p><b>Note:</b> Reads right to left.</p>"))
        ?.description,
    ).toBe("A story. Note: Reads right to left.");
  });

  it("keeps a nested div and stops at ANN's Notes field after it", () => {
    expect(
      parseReleasePage(
        withField(
          '<br></p><div class="simple-html"><div>Part one.</div> Part two.</div><p></p>',
          notesField,
        ),
      )?.description,
    ).toBe("Part one. Part two.");
    expect(parseReleasePage(withField("<br>A story.</p>", notesField))?.description).toBe(
      "A story.",
    );
  });

  it("drops stored format notes", () => {
    expect(
      cleanAnnDescription('The wizard wakes. Notes: Published in left-to-right "flipped" format.'),
    ).toBe("The wizard wakes.");
    expect(
      cleanAnnDescription(
        "Serving the forces of good... Notes: Published in right-to-left format.",
      ),
    ).toBe("Serving the forces of good...");
  });

  it("maps C1 controls to the Windows-1252 characters ANN meant", () => {
    expect(cleanAnnDescription("Dark Schneider\u0092s nemesis.")).toBe("Dark Schneider’s nemesis.");
    expect(cleanAnnDescription("But then a miracle\u0097her body rises.")).toBe(
      "But then a miracle—her body rises.",
    );
  });

  it("decodes stray entities and ANN's &qout; typo", () => {
    expect(cleanAnnDescription('Who is the &qout;other" Kamui?')).toBe('Who is the "other" Kamui?');
    expect(cleanAnnDescription("Up against the ropes. ,p&gt;Enter a lad named Gear.")).toBe(
      "Up against the ropes. Enter a lad named Gear.",
    );
  });

  it.each([
    "Book is in like-new condition.",
    "Book is in excellent condition..It may has been previously used but well cared coz it doesn't show any marks/highlights..clean and crisp...glossy dust jacket..All orders ship with tracking for your convenience. Please do not hesitate to email us with any questions.",
    "Will ship out as soon as we stock th",
    "Find, shop, and buy computers, laptops, books, dvd, videos, games, video games, music, sporting goods, software, electronics, digital cameras, camcorders, toys, luggage, and dvd players at Buy.com",
    "Retail Price: $14.95 No Longer Available For Purchase Free Canadian Shipping @ $250 Free US Economy Shipping @ $49",
    "Publisher - SEVEN SEAS Genre - Action/Comedy Media - Printed Material Age Rating - 16+ (More Information) Page Count - 180 Date Available - Jun 9 2015 Product Availability - Pre-Order, Not Yet Shipping (More Information)",
    "Book by Buronson",
    "Book by Takaya, Yoshiki",
    "Language:English.Pink Innocent 3",
    "No further information has been provided for this title.",
    "SCIENCE FICTION.",
    "OVERSIZED GRAPHIC NOVEL",
    "Manga trade style comic.",
    "(2nd Ed)",
  ])("rejects a description that is only retail or listing junk: %j", (junk) => {
    expect(cleanAnnDescription(junk)).toBeUndefined();
  });

  it.each([
    "Graphic novel. Cult classic.",
    "Reads R to L (Japanese Style) for mature audiences.",
    "I want to save the world with rice!",
    "Ash is alarmed by Eiji's condition. Book is in his hands.",
    "A Book by its cover.",
    // Starting like the junk is not enough.
    "Book by book, the legend grows.",
    "Book is in mint condition, but the story inside is falling apart.",
    "Will ship out his men at dawn.",
  ])("keeps a short blurb or text that only mentions junk words: %j", (text) => {
    expect(cleanAnnDescription(text)).toBe(text);
  });
});

// Round 4 (C66-R3-01..03): who owns a line word, a marker's unread number,
// and the release page read beside the line, all through the one reader.

/** An ANN line as the mirror stores it from "title (designator)" under `entry`, with an ok page. */
function stored(
  title: string,
  designator = "GN 1",
  page?: { title?: string; volume?: string },
  entry = "Alpha",
) {
  const split = splitReleaseTitle(`${title} (${designator})`, entry);
  if (split === null) throw new Error(`No designator in ${title}`);
  return { ...split, ...(page ? { page: { status: "ok", fetchedAt: 1, ...page } } : {}) };
}

describe("line words a name owns: only the work's own name opening the title", () => {
  it.each([
    ["Alpha [Deluxe]", "Makunouchi Deluxe", "Deluxe"],
    ["Alpha [Omnibus]", "The Omnibus Club", "Omnibus"],
    ["Alpha [VIZBIG Edition]", "Beta VIZBIG Edition", "VIZBIG Edition"],
    ["Alpha Deluxe Edition", "Alpha Deluxe Edition Club", "Deluxe Edition"],
  ])("%s under %s adds %s", (title, name, line) => {
    expect(readAnnLineTitle(title, { names: [name] })).toMatchObject({
      kind: "line",
      work: "Alpha",
      lineName: line,
    });
  });

  it("owns the words of a name the title opens with, in any case, accent or stop", () => {
    for (const title of ["Makunouchi Deluxe", "MAKUNOUCHI DELUXE", "Makúnouchi Deluxe:"]) {
      expect(readAnnLineTitle(title, { names: ["Makunouchi Deluxe"] }).kind, title).toBe("single");
    }
    expect(
      readAnnLineTitle("Makunouchi Deluxe [VIZBIG Edition]", { names: ["Makunouchi Deluxe"] }),
    ).toMatchObject({ kind: "line", work: "Makunouchi Deluxe", lineName: "VIZBIG Edition" });
  });

  it("is packaging under the Series' own title whatever the stored flag says", () => {
    // The mirror stored these under the entry's name; under the Series they add a line.
    const deluxe = stored("Alpha Deluxe Edition", "GN 1", undefined, "Alpha Deluxe Edition");
    expect(deluxe.editionLineHint).toBe(false);
    expect(annLinePackaged(deluxe, ["Alpha"])).toBe(true);
    expect(annLinePackaged(deluxe, ["Alpha Deluxe Edition"])).toBe(false);
    // Without a work in context only the stored flags and the page speak.
    expect(annLinePackaged(deluxe)).toBe(false);
    // A stored true is never cleared by a reading that owns the word.
    expect(annLinePackaged({ ...deluxe, editionLineHint: true }, ["Alpha Deluxe Edition"])).toBe(
      true,
    );
    expect(annLinePackaged({ ...deluxe, coverageGapped: true }, ["Alpha Deluxe Edition"])).toBe(
      true,
    );
  });

  it("is packaging when the line's page says so, by its title or its Volume field", () => {
    const plain = stored("Alpha", "GN 1");
    expect(annLinePackaged(plain, ["Alpha"])).toBe(false);
    for (const page of [
      { title: "Alpha [VIZBIG Edition]" },
      { volume: "GN 1-3" },
      { volume: "Omnibus GN 1" },
    ]) {
      expect(annLinePackaged({ ...plain, page: { status: "ok", ...page } }, ["Alpha"])).toBe(true);
      // A page that was never read says nothing.
      expect(annLinePackaged({ ...plain, page: { status: "error", ...page } }, ["Alpha"])).toBe(
        false,
      );
    }
  });

  it("leaves the work unclear when the entry's name owns a word the Series' does not", () => {
    const line = stored("Makunouchi Deluxe", "GN 2", undefined, "Makunouchi Deluxe");
    const under = (entry?: string) =>
      packagingOf({ ...line, editionLineHint: true }, ["Makunouchi"], entry);
    expect(under()).toMatchObject({ line: { name: "Deluxe", position: "2" } });
    expect(under("Makunouchi Deluxe")).toMatchObject({
      title: { kind: "ambiguous", reason: expect.stringMatching(/manga entry's name/) },
      line: null,
    });
    // An entry owning no more than the Series changes nothing.
    for (const entry of ["Makunouchi", "A different entry title", "Makunouchi VIZBIG Edition"]) {
      expect(under(entry), entry).toMatchObject({ line: { name: "Deluxe", position: "2" } });
    }
  });
});

describe("a marker's number the grammar cannot read is an unknown position", () => {
  it.each([
    "Alpha [VIZBIG Edition] (Vol. thirty)",
    "Alpha [VIZBIG Edition] (Book Thirty)",
    "Alpha [VIZBIG Edition] (Volume Twenty One)",
    "Alpha [VIZBIG Edition] (Vols. thirty-one)",
    "Alpha [VIZBIG Edition Vol. thirty]",
    "Alpha [Vol. thirty VIZBIG Edition]",
    "Alpha [VIZBIG Edition] (Vol. ２)",
    "Alpha [VIZBIG Edition Vol. ２]",
    "Alpha VIZBIG Edition ２",
    "Alpha [VIZBIG Edition] (２)",
    "Alpha [VIZBIG Edition] Ⅱ",
    "Alpha [VIZBIG Edition] (Vol. n/a)",
    "Alpha [VIZBIG Edition] (Vol. unknown)",
    "Alpha [VIZBIG Edition] (Vol. M)",
    "Alpha [VIZBIG Edition] (Vol.)",
    "Alpha [VIZBIG Edition] #",
    "Alpha [VIZBIG Edition] (Part Two)",
    "Alpha [VIZBIG Edition] (Part 2)",
    "Alpha [VIZBIG Edition]: The Book of Sand",
    "Alpha [VIZBIG Edition] (Vol. 0)",
    "Alpha [VIZBIG Edition] (Vol. 1/2)",
  ])("%s at GN 1 keeps VIZBIG Edition with no position", (title) => {
    const read = packagingOf(stored(title), ["Alpha"]);
    expect(read).toMatchObject({
      positionConflict: true,
      line: { name: "VIZBIG Edition", position: null },
    });
  });

  it("reads supported positions, and passes over words with no number or marker", () => {
    for (const [title, designator, position] of [
      ["Alpha [VIZBIG Edition] (Vol. II)", "GN 2", "2"],
      ["Alpha [VIZBIG Edition] (Book 2)", "GN 2", "2"],
      ["Alpha [VIZBIG Edition Vol. 2]", "GN 2", "2"],
      ["Alpha [Side Story VIZBIG Edition]", "GN 1", "1"],
      ["Alpha [VIZBIG Edition] [Hardcover]", "GN 1", "1"],
      ["Alpha [VIZBIG Edition] [2nd Edition]", "GN 1", "1"],
      ["Alpha [VIZBIG Edition] (3rd Printing)", "GN 1", "1"],
      ["Alpha [VIZBIG Edition] - Wano", "GN 1", "1"],
    ] as const) {
      const read = packagingOf(stored(title, designator), ["Alpha"]);
      expect(read?.positionConflict, title).toBe(false);
      expect(read?.line?.position, title).toBe(position);
    }
  });

  it("holds a plain unexplained word after the line as unclear, never as a position", () => {
    expect(packagingOf(stored("Alpha VIZBIG Edition Thirty"), ["Alpha"])).toMatchObject({
      title: { kind: "ambiguous" },
      line: null,
    });
  });
});

describe("the release page, read beside the line", () => {
  const vizbig = (designator: string, page?: { title?: string; volume?: string }) =>
    packagingOf(stored("Alpha [VIZBIG Edition]", designator, page), ["Alpha"]);

  it("agrees with a page that restates the line, its total aside", () => {
    for (const volume of ["GN 1", "GN 1 / 4", "1"]) {
      expect(vizbig("GN 1", { title: "Alpha [VIZBIG Edition]", volume }), volume).toMatchObject({
        coverageGapped: false,
        positionConflict: false,
        formatConflict: false,
        line: { name: "VIZBIG Edition", position: "1" },
      });
    }
    // A page with no number, or none at all, says nothing.
    expect(vizbig("GN 1", { volume: "GN" })?.line?.position).toBe("1");
    expect(vizbig("GN 1")?.line?.position).toBe("1");
    // A label is a position, a list coverage: "33" beside "GN 97-99".
    expect(
      packagingOf(
        stored("One Piece - [Omnibus] 33 - Wano", "GN 97-99", { volume: "GN 33" }, "One Piece"),
        ["One Piece"],
      ),
    ).toMatchObject({
      coverRange: { from: "97", to: "99" },
      line: { name: "Omnibus", position: "33" },
    });
  });

  it.each([
    { designator: "GN 1", volume: "GN 2", conflict: "position" },
    { designator: "GN 1", volume: "Vol. two", conflict: "both" },
    { designator: "GN 1-3", volume: "GN 4-6", conflict: "coverage" },
    { designator: "GN 1-3", volume: "GN 1, 3", conflict: "coverage" },
    { designator: "GN 1-3", volume: "GN 1-3-5", conflict: "coverage" },
    { designator: "GN 1", title: "Alpha [VIZBIG Edition Vol. 2]", conflict: "position" },
    { designator: "GN 1-3", title: "Alpha [VIZBIG Edition Vols. 4-6]", conflict: "coverage" },
  ])("holds $designator against page $volume $title", ({ designator, volume, title, conflict }) => {
    const read = vizbig(designator, { title, volume });
    expect(read?.positionConflict).toBe(conflict !== "coverage");
    expect(read?.coverageGapped).toBe(conflict !== "position");
    if (conflict !== "position") expect(read?.coverRange).toBeNull();
    if (read?.positionConflict) expect(read.line?.position ?? null).toBeNull();
  });

  it("leaves the work unclear when the page titles another work or line", () => {
    for (const title of ["Alpha+ [VIZBIG Edition]", "Alpha [Omnibus]", "Alpha"]) {
      expect(vizbig("GN 1", { title }), title).toMatchObject({
        title: { kind: "ambiguous", reason: "is titled otherwise on its release page" },
        line: null,
      });
    }
  });

  it("names a format conflict without choosing a format", () => {
    expect(vizbig("GN 1", { volume: "eBook 1" })).toMatchObject({ formatConflict: true });
    expect(vizbig("GN 1", { volume: "GN 1" })).toMatchObject({ formatConflict: false });
  });

  it("keeps a stored rejection whatever the page says", () => {
    const line = { ...stored("Alpha [VIZBIG Edition]", "GN 1-3"), coverageGapped: true as const };
    const page = { status: "ok", volume: "GN 1-3", title: "Alpha [VIZBIG Edition]" };
    expect(packagingOf({ ...line, page }, ["Alpha"])).toMatchObject({
      coverageGapped: true,
      coverRange: null,
    });
  });

  it("tells whether a stored page still restates its line", () => {
    const line = stored("Alpha [VIZBIG Edition]", "GN 1-3");
    const restates = (page: { title?: string; volume?: string }, status = "ok") =>
      pageRestatesLine({ ...line, page: { status, ...page } });
    expect(restates({ title: "Alpha [VIZBIG Edition]", volume: "GN 1-3 / 9" })).toBe(true);
    expect(restates({ title: "alpha  [VIZBIG Edition]", volume: "GN 1-3" })).toBe(true);
    expect(restates({ title: "Alpha [VIZBIG Edition]", volume: "GN 1, 3" })).toBe(false);
    expect(restates({ volume: "GN 4-6" })).toBe(false);
    expect(restates({ volume: "eBook 1-3" })).toBe(false);
    expect(restates({ title: "Alpha+ [VIZBIG Edition]" })).toBe(false);
    expect(restates({ volume: "Vol. two" })).toBe(false);
    expect(restates({ volume: "GN 9" }, "error")).toBe(true);
    expect(pageRestatesLine(line)).toBe(true);
    const single = stored("Alpha [VIZBIG Edition]", "GN 2");
    expect(pageRestatesLine({ ...single, page: { status: "ok", volume: "GN 2 / 4" } })).toBe(true);
    expect(pageRestatesLine({ ...single, page: { status: "ok", volume: "GN 3" } })).toBe(false);
  });
});
