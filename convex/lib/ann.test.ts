// ANN parser tests (ticket #36) against the live XML shapes captured
// 2026-08-20 from reports.xml / api.xml (Frieren, manga id 24449).

import { describe, expect, it } from "vitest";
import {
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
    expect(splitReleaseTitle("One Piece - [Omnibus] 33 - Wano (GN 97-99)", "One Piece")).toMatchObject({
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
    expect(coverage("Alpha (Omnibus GN 1-3)")).toEqual([undefined, true, range("1", "3"), undefined]);
    expect(coverage("Alpha (GN 1, 2, 3)")).toEqual([undefined, true, range("1", "3"), undefined]);
    expect(coverage("Alpha (GN 1 & 2)")).toEqual([undefined, true, range("1", "2"), undefined]);
    expect(coverage("Alpha (GN 1 and 2)")).toEqual([undefined, true, range("1", "2"), undefined]);
    expect(coverage("Alpha (GN 1-3, 4-6)")).toEqual([undefined, true, range("1", "6"), undefined]);
    expect(coverage("Alpha (GN 10.5-11)")).toEqual([undefined, true, range("10.5", "11"), undefined]);
    // The release page's "of N" total, if a line ever carries it, is not a Volume.
    expect(coverage("Alpha (GN 1-4 / 34)")).toEqual([undefined, true, range("1", "4"), undefined]);
  });

  it("rejects a list no range holds: multi-volume with neither label nor range", () => {
    for (const designator of ["GN 1, 3", "GN 1-3, 5", "GN 1-2 & 4", "GN 3-1", "GN 1-3-5", "eBook 2, 4"]) {
      expect(coverage(`Alpha (${designator})`), designator).toEqual([undefined, true, undefined, true]);
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
    for (const text of ["Alpha (omnibus 1)", "Alpha (Box Set 1)", "Alpha (light novel)", "Alpha (eBook ch 17)", "Alpha"]) {
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
        "Elf mage Frieren & her comrades said \"farewell\" — what's next?",
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
    const records = parseApiResponse(`<ann><manga id="1" name="No Main Title &#039;Here&#039;"><info type="Genres">x</info></manga>
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
    expect(ebook).toMatch(/^A new shonen sensation in Japan, this series features Monkey D\. Luffy, /);
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
    expect(parseReleasePage(inlineField("Includes:<ul><li>Volume 1</li><li>Volume 2</li></ul>"))?.description).toBe(
      "Includes: Volume 1 Volume 2",
    );
    expect(
      parseReleasePage(inlineField("Pirates <small>(and ninjas)</small> sail.<br><b>Note:</b> Bonus story."))
        ?.description,
    ).toBe("Pirates (and ninjas) sail. Note: Bonus story.");
    expect(
      parseReleasePage(divField("<p>Part one.</p><div>Part <small>two</small>.</div><ul><li>A list</li></ul>"))
        ?.description,
    ).toBe("Part one. Part two. A list");
  });

  it("strips zero-width spaces, entity-encoded ones too", () => {
    expect(parseReleasePage(divField("Luffy,&#8203; Zoro,\u200b and Nami&#x200B;."))?.description).toBe(
      "Luffy, Zoro, and Nami.",
    );
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
    expect(parseReleasePage(inlineField('A story.<br><a href="0/0/reviews/new">Submit your own review of this item.</a>'))?.description).toBe(
      "A story.",
    );
  });

  it("has no description when the page has none", () => {
    const field = /<p class="easyread-width">[\s\S]*?<\/p>/;
    expect(field.test(ROMANCE_DAWN_PAGE)).toBe(true);
    const absent = ROMANCE_DAWN_PAGE.replace(field, "");
    const empty = ROMANCE_DAWN_PAGE.replace(field, '<p class="easyread-width"><b>Description:</b><br></p>');
    expect(parseReleasePage(absent)).toMatchObject({ isbn13: "9781569319017", description: undefined });
    expect(parseReleasePage(empty)?.description).toBeUndefined();
  });
});

describe("cleanAnnDescription", () => {
  it("drops ANN's trailing credit sentences", () => {
    expect(cleanAnnDescription("But is Roronoa Zoro, the pirate hunter, a friend or a foe? Story and art by Eiichiro Oda.")).toBe(
      "But is Roronoa Zoro, the pirate hunter, a friend or a foe?",
    );
    expect(cleanAnnDescription("Noriko needs all the help she can get. Story and art by Kiyoko Hikawa.")).toBe(
      "Noriko needs all the help she can get.",
    );
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
    expect(cleanAnnDescription(`Will they win the final battle? ${ending}`)).toBe("Will they win the final battle?");
  });

  it("drops only the fused credit glued to the copy before it", () => {
    expect(cleanAnnDescription("The end of her Story and art by Akihisa Ikeda.")).toBe("The end of her");
    // Two clauses glued mid-sentence stay: never cutting prose costs this
    // one real credit.
    const glued = "Insights from an E.R. physician Story by Koshun Takami and art by Masayuki Taguchi.";
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
  ])("drops a credit sentence with lower-case or odd names, a typo or a doubled prefix: %j", (ending) => {
    expect(cleanAnnDescription(`Will they win? ${ending}`)).toBe("Will they win?");
  });

  it("drops a credit glued to the full stop before it", () => {
    expect(cleanAnnDescription("Teenage madness in this concluding volume.Story and art by Usamaru Furuya.")).toBe(
      "Teenage madness in this concluding volume.",
    );
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
    expect(cleanAnnDescription("Story and art by Oh!Great. FEARSOME FRIEND AND FOE On their mission!")).toBe(
      "FEARSOME FRIEND AND FOE On their mission!",
    );
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
    expect(cleanAnnDescription("A sequel. Notes: This volume despite being numbered as the first volume contains material from the 10th volume of the Japanese release.")).toBe(
      "A sequel.",
    );
  });

  it.each([
    "Story and art by Osamu Tezuka. Harcover edition limited to only 1,500 copies",
    "Story and art by Miwa Ueda. #75 - What's Hot Pick",
    "Written and drawn by Yukito Kishiro. 232 pages.",
  ])("keeps an ending with other text after the credit: %j", (ending) => {
    const text = `Will they win? ${ending}`;
    expect(cleanAnnDescription(text)).toBe(text);
  });

  it.each(["Story and art by Eiichiro Oda.", "Story and art by Yonezou Nekota.", "Submit your own review of this item."])(
    "has nothing left of a text that is only a credit or page chrome: %j",
    (text) => {
      expect(cleanAnnDescription(text)).toBeUndefined();
    },
  );

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
  const notesField = '<p class="easyread-width"><b>Notes:</b><br>Published in left-to-right "flipped" format.</p>';
  const withField = (description: string, after = "") =>
    NOTES_FIELD_PAGE.replace(
      /<p class="easyread-width"><b>Description:<\/b>[\s\S]*?(?=<p><small>)/,
      `<p class="easyread-width"><b>Description:</b>${description}${after}`,
    );

  it("keeps the copy's own bold-label paragraphs, inline and in a div", () => {
    expect(
      parseReleasePage(withField("<br>A story.</p><p><b>Bonus Features:</b> Sketches and an interview.</p>"))
        ?.description,
    ).toBe("A story. Bonus Features: Sketches and an interview.");
    expect(
      parseReleasePage(
        withField('<br></p><div class="simple-html"><p>A story.</p><p><b>Bonus Features:</b> Sketches.</p></div><p></p>'),
      )?.description,
    ).toBe("A story. Bonus Features: Sketches.");
    expect(parseReleasePage(withField("<br>A story.</p><p><b>Note:</b> Reads right to left.</p>"))?.description).toBe(
      "A story. Note: Reads right to left.",
    );
  });

  it("keeps a nested div and stops at ANN's Notes field after it", () => {
    expect(
      parseReleasePage(
        withField('<br></p><div class="simple-html"><div>Part one.</div> Part two.</div><p></p>', notesField),
      )?.description,
    ).toBe("Part one. Part two.");
    expect(parseReleasePage(withField("<br>A story.</p>", notesField))?.description).toBe("A story.");
  });

  it("drops stored format notes", () => {
    expect(cleanAnnDescription('The wizard wakes. Notes: Published in left-to-right "flipped" format.')).toBe(
      "The wizard wakes.",
    );
    expect(cleanAnnDescription("Serving the forces of good... Notes: Published in right-to-left format.")).toBe(
      "Serving the forces of good...",
    );
  });

  it("maps C1 controls to the Windows-1252 characters ANN meant", () => {
    expect(cleanAnnDescription("Dark Schneider\u0092s nemesis.")).toBe("Dark Schneider’s nemesis.");
    expect(cleanAnnDescription("But then a miracle\u0097her body rises.")).toBe("But then a miracle—her body rises.");
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
