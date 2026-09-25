// ANN parser tests (ticket #36) against the live XML shapes captured
// 2026-08-20 from reports.xml / api.xml (Frieren, manga id 24449).

import { describe, expect, it } from "vitest";
import {
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
    const items = parseReport(REPORT);
    expect(items.map((i) => i.id)).toEqual(["40451", "40447"]);
    expect(items[1]!.name).toBe(
      "There's No Freaking Way I'll Be Your Lover! Unless... Second Season",
    );
  });
});

describe("parseAnnDate — ANN's month-precision convention", () => {
  it("keeps full, month, and year precision distinct", () => {
    expect(parseAnnDate("2026-02-10")).toEqual({ year: 2026, month: 2, day: 10 });
    expect(parseAnnDate("2024-11-00")).toEqual({ year: 2024, month: 11 });
    expect(parseAnnDate("2027")).toEqual({ year: 2027 });
    expect(parseAnnDate("soon")).toBeUndefined();
  });

  it("reads a pre-2010 day 01 as the month placeholder it is", () => {
    expect(parseAnnDate("2004-06-01")).toEqual({ year: 2004, month: 6 });
    expect(parseAnnDate("2009-12-01")).toEqual({ year: 2009, month: 12 });
    // Modern day-1 dates are real (159/178 agree with PRH).
    expect(parseAnnDate("2024-10-01")).toEqual({ year: 2024, month: 10, day: 1 });
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
    expect(splitReleaseTitle("Frieren (GN 7.5)")).toMatchObject({ label: "7.5" });
    expect(splitReleaseTitle("Oneshot Story (GN)")).toMatchObject({
      label: undefined,
      multi: false,
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
    expect(manga.releases[4]).toMatchObject({ multi: true, editionLineHint: true });
  });

  it("tolerates warnings and empty responses", () => {
    expect(parseApiResponse("<ann><warning>no result</warning></ann>")).toEqual([]);
  });
});

describe("release lines — ISBNs, chapters, packaging in the title", () => {
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
    // The series' own name carries the word: not packaging.
    expect(
      splitReleaseTitle("The Omnibus Club (GN 2)", "The Omnibus Club"),
    ).toMatchObject({ label: "2", editionLineHint: false });
  });
});

// Trimmed copies of live release pages (fetched 2026-09-25; 10045 from the
// release-less audit's cache): the fields block and the entry link, with a
// site-chrome manga link in front to prove the entry link is the one read.
const GN_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><div id="cover_placeholder"></div><b>Title:</b> One Piece<br><b>Volume:</b>  GN 113<br><b>Pages:</b> 208<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2026-11-10<br><b>Suggested retail price:</b> $11.99<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">9747</span><span title="product">6670</span><span title="check digit">5</span></span><span style="visibility:hidden"> 1974766705</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">9747</span><span title="product">6670</span><span title="check digit">3</span></span><span style="visibility:hidden"> 9781974766703</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2026-03-17, modified on 2026-03-17)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

const EBOOK_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/23227.jpg" align="RIGHT"><b>Title:</b> One Piece - Romance Dawn<br><b>Volume:</b>  eBook 1<br><b>Running time:</b> 210<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2013-02-19<br><b>Suggested retail price:</b> $6.99<br></p><p><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">4525</span><span title="check digit">7</span></span><span style="visibility:hidden"> 9781421545257</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2013-02-27, modified on 2014-09-18)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

const BOX_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/24124.jpg" align="RIGHT"><b>Title:</b> One Piece - East Blue and Baroque Works Box Set<br><b>Volume:</b>  GN 1-23<br><b>Pages:</b> 4720<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2013-11-05<br><b>Suggested retail price:</b> $185.99<br><b>Age rating:</b> 13+<br></p><p><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">4215</span><span title="product">6074</span><span title="check digit">7</span></span><span style="visibility:hidden"> 1421560747</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">6074</span><span title="check digit">8</span></span><span style="visibility:hidden"> 9781421560748</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2013-06-18, modified on 2013-06-18)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=1223">One Piece (manga)</a></b></li></ul></body></html>`;

const OLD_PAGE = `<html><body><div id="nav"><a href="/encyclopedia/manga.php?id=1">Top manga</a></div><hr><img src="//cdn.animenewsnetwork.com/thumbnails/area200x300/releases/10045.jpg" align="RIGHT"><b>Title:</b> Fall in Love Like a Comic!<br><b>Volume:</b>  GN 2 / 2<br><b>Pages:</b> 192<br><b>Distributor:</b> <a href="company.php?id=4552">Viz Media</a><p><b>Release date:</b> 2008-01-01<br><b>Suggested retail price:</b> $8.99<br><b>Age rating:</b> 15+<br></p><p><b>SKU:</b> <span class="release-ean">CTFL-02</span><br><b>ISBN-10:</b> <span class="release-ean"><span title="English language">1</span><span title="publisher">4215</span><span title="product">1374</span><span title="check digit">9</span></span><span style="visibility:hidden"> 1421513749</span><br><b>ISBN-13:</b> <span class="release-ean"><span title="Bookland (ISBN)">978</span><span title="English language">1</span><span title="publisher">4215</span><span title="product">1374</span><span title="check digit">4</span></span><span style="visibility:hidden"> 9781421513744</span><br></p><p class="easyread-width"><b>Description:</b><br>…</p><p><small>(added on 2007-10-05, modified on 2007-10-05)</small></p><ul><li><b>Encyclopedia information about <a class="ENCYC" href="/encyclopedia/manga.php?id=8124">Zoku Manga Mitaina Koi Shitai!</a></b></li></ul></body></html>`;

describe("parseReleasePage", () => {
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
});
