// Yen Press tests: the sitemap/title-page parsers against trimmed copies of
// live pages (fetched 2026-09-25: the header, format tabs, prices, and the
// "full details" section; a site-nav genre link stays in front to prove the
// category is read from the book's own labels; little-witch-academia-3,
// fetched 2026-09-26, also keeps the `.content-heading-txt` blurb), and the
// adapter run against a stubbed yenpress.com — no network.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import { isbn10To13 } from "./lib/isbn";
import {
  skipsWithoutFetch,
  parseSitemap,
  parseTitlePage,
  parseYenDate,
  toSnapshots,
} from "./lib/yenPress";
import { insertBundle, insertObservation, insertPublisher, insertSeries } from "./test.factories";
import {
  bundleMembers,
  drain,
  expectStampedAtHandOff,
  makeT,
  seedRegistry,
  tickingClock,
  type TestT,
} from "./test.helpers";

// Trimmed first-party HTML; fixture comments record fetch dates where needed.
const liveFixture = (name: string) =>
  readFileSync(new URL(`./lib/__fixtures__/yenPress/${name}.html`, import.meta.url), "utf8");

const MANGA_PAGE = `<html><body><div class="nav"><a href="/genres?category=light-novels&genre=comedy">LN</a></div><h1 class="heading title-52 bold white desktop-only fade-el">A Misanthrope Teaches a Class for Demi-Humans, Vol. 4 (manga): Mr. Hitoma, Won’t You Teach Us About Humans…?</h1><div class="buy-info"><div class="tabs"> <span class="deliver active" data-id="">Paperback</span> <span class="deliver" data-id="">Digital</span> </div><div class="deliver-info"><p class="book-price">$13.00 US / $17.00 CAN</p></div><div class="deliver-info"><p class="book-price">$6.99 US / $8.99 CAN</p></div></div><section class="book-details wrapper-1410 prel fade-in-container"> <div class="detail active"> <div class="txt-hold fade-el "> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only"> <a href="/genres?category=manga&genre=slice-of-life" class="white-label">Slice-of-Life</a> <a href="/genres?category=manga&genre=comedy" class="white-label">Comedy</a> <a href="/genres?category=manga&genre=drama" class="white-label">Drama</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=manga&genre=slice-of-life" class="white-label">Slice-of-Life</a> <a href="/genres?category=manga&genre=comedy" class="white-label">Comedy</a> <a href="/genres?category=manga&genre=drama" class="white-label">Drama</a> </div> </div> <!-- Main --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">A Misanthrope Teaches a Class for Demi-Humans (manga)</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Trim Size</span> <p class="info"> 5"x7.5" </p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">272 pages</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9798855438611</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Jan 26, 2027</p> </div> <div class="detail-box"> <span>Age Rating</span> <p class="info">T (Teen)</p> </div> </div> <div> <span class="type paragraph fs-15">Imprint</span> <p class="info">Yen Press</p> </div> </div> </div> <div class="detail"> <div class="txt-hold"> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only fade-el"> <a href="/genres?category=manga&genre=comedy" class="white-label">Comedy</a> <a href="/genres?category=manga&genre=drama" class="white-label">Drama</a> <a href="/genres?category=manga&genre=slice-of-life" class="white-label">Slice-of-Life</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=manga&genre=comedy" class="white-label">Comedy</a> <a href="/genres?category=manga&genre=drama" class="white-label">Drama</a> <a href="/genres?category=manga&genre=slice-of-life" class="white-label">Slice-of-Life</a> </div> </div> <!-- Digital --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">A Misanthrope Teaches a Class for Demi-Humans (manga)</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">272 pages</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9798855438628</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Jan 26, 2027</p> </div> </div> <div> <div class="detail-box"> <span>Age Rating</span> <p class="info">T (Teen)</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Imprint</span> <p class="info">Yen Press</p> </div> </div> </div> </div> </section></body></html>`;

const DELUXE_PAGE = `<html><body><div class="nav"><a href="/genres?category=light-novels&genre=comedy">LN</a></div><h1 class="heading title-52 bold white desktop-only fade-el">Battle Royale Deluxe Edition, Vol. 3</h1><div class="buy-info"><div class="tabs"> <span class="deliver active" data-id="10663139508517">Hardback</span> <span class="deliver" data-id="">Digital</span> </div><div class="deliver-info"><p class="book-price">$55.00 US / $70.00 CAN</p></div><div class="deliver-info"><p class="book-price">$14.99 US / $19.99 CAN</p></div></div><section class="book-details wrapper-1410 prel fade-in-container"> <div class="detail active"> <div class="txt-hold fade-el "> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only"> <a href="/genres?category=manga&genre=action-and-adventure" class="white-label">Action and Adventure</a> <a href="/genres?category=manga&genre=dark&subgenre=skip" class="white-label">Dark</a> <a href="/genres?category=manga&genre=dystopian&subgenre=skip" class="white-label">Dystopian</a> <a href="/genres?category=manga&genre=book-tie-in&subgenre=skip" class="white-label">Book Tie-in</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=manga&genre=action-and-adventure" class="white-label">Action and Adventure</a> <a href="/genres?category=manga&genre=dark&subgenre=skip" class="white-label">Dark</a> <a href="/genres?category=manga&genre=dystopian&subgenre=skip" class="white-label">Dystopian</a> <a href="/genres?category=manga&genre=book-tie-in&subgenre=skip" class="white-label">Book Tie-in</a> </div> </div> <!-- Main --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">Battle Royale Deluxe Edition</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Trim Size</span> <p class="info"> 7"x10.13" </p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">608 pages</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9798855431483</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Dec 15, 2026</p> </div> <div class="detail-box"> <span>Age Rating</span> <p class="info">18+ M (Mature)</p> </div> </div> <div> <span class="type paragraph fs-15">Imprint</span> <p class="info">Yen Press</p> </div> </div> </div> <div class="detail"> <div class="txt-hold"> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only fade-el"> <a href="/genres?category=manga&genre=action-and-adventure" class="white-label">Action and Adventure</a> <a href="/genres?category=manga&genre=dark&subgenre=skip" class="white-label">Dark</a> <a href="/genres?category=manga&genre=dystopian&subgenre=skip" class="white-label">Dystopian</a> <a href="/genres?category=manga&genre=book-tie-in&subgenre=skip" class="white-label">Book Tie-in</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=manga&genre=action-and-adventure" class="white-label">Action and Adventure</a> <a href="/genres?category=manga&genre=dark&subgenre=skip" class="white-label">Dark</a> <a href="/genres?category=manga&genre=dystopian&subgenre=skip" class="white-label">Dystopian</a> <a href="/genres?category=manga&genre=book-tie-in&subgenre=skip" class="white-label">Book Tie-in</a> </div> </div> <!-- Digital --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">Battle Royale Deluxe Edition</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">608 pages</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9798855431490</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Dec 15, 2026</p> </div> </div> <div> <div class="detail-box"> <span>Age Rating</span> <p class="info">18+ M (Mature)</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Imprint</span> <p class="info">Yen Press</p> </div> </div> </div> </div> </section></body></html>`;

const NOVEL_PAGE = `<html><body><div class="nav"><a href="/genres?category=light-novels&genre=comedy">LN</a></div><h1 class="heading title-52 bold white desktop-only fade-el">A Livid Lady's Guide to Getting Even: How I Crushed My Homeland with My Mighty Grimoires: Volume 2 (Light Novel)</h1><div class="buy-info"><div class="tabs"> <span class="deliver active" data-id="10671739306277">Paperback</span> </div><div class="deliver-info"><p class="book-price">$15.99 US / $21.99 CAN</p></div></div><section class="book-details wrapper-1410 prel fade-in-container"> <div class="detail active"> <div class="txt-hold fade-el "> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only"> <a href="/genres?category=light-novels&genre=fantasy" class="white-label">Fantasy</a> <a href="/genres?category=light-novels&genre=anime-tie-in&subgenre=skip" class="white-label">Anime Tie-in</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=light-novels&genre=fantasy" class="white-label">Fantasy</a> <a href="/genres?category=light-novels&genre=anime-tie-in&subgenre=skip" class="white-label">Anime Tie-in</a> </div> </div> <!-- Main --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">A Livid Lady's Guide to Getting Even: How I Crushed My Homeland with My Mighty Grimoires</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Trim Size</span> <p class="info"> 5.05"x7.05" </p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">214 pages</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9781718386693</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Jan 26, 2027</p> </div> <div class="detail-box"> <span>Age Rating</span> <p class="info">T (Teen)</p> </div> </div> <div> <span class="type paragraph fs-15">Imprint</span> <p class="info">J-Novel Club</p> </div> </div> </div> </section></body></html>`;

const IZE_BOX_PAGE = `<html><body><div class="nav"><a href="/genres?category=light-novels&genre=comedy">LN</a></div><h1 class="heading title-52 bold white desktop-only fade-el">Mignon: Special Box Set w/USB</h1><div class="buy-info"><div class="tabs"> <span class="deliver active" data-id="">Paperback</span> </div><div class="deliver-info"><p class="book-price">$75.00 US / $95.00 CAN</p></div></div><section class="book-details wrapper-1410 prel fade-in-container"> <div class="detail active"> <div class="txt-hold fade-el "> <h3 class="upper heading">full details</h3> <div class="detail-labels mobile-only"> <a href="/genres?category=comics&genre=fantasy" class="white-label">Fantasy</a> <a href="/genres?category=comics&genre=drama" class="white-label">Drama</a> <a href="/genres?category=comics&genre=lgbtq" class="white-label">LGBTQ</a> <a href="/genres?category=comics&genre=romance" class="white-label">Romance</a> <a href="/genres?category=comics&genre=slice-of-life" class="white-label">Slice-of-Life</a> <a href="/genres?category=comics&genre=boys-love&subgenre=skip" class="white-label">Boys Love</a> </div> <div class="detail-labels desktop-only fade-el"> <a href="/genres?category=comics&genre=fantasy" class="white-label">Fantasy</a> <a href="/genres?category=comics&genre=drama" class="white-label">Drama</a> <a href="/genres?category=comics&genre=lgbtq" class="white-label">LGBTQ</a> <a href="/genres?category=comics&genre=romance" class="white-label">Romance</a> <a href="/genres?category=comics&genre=slice-of-life" class="white-label">Slice-of-Life</a> <a href="/genres?category=comics&genre=boys-love&subgenre=skip" class="white-label">Boys Love</a> </div> </div> <!-- Main --> <div class="detail-info fade-el"> <div> <div class="detail-box"> <span class="type paragraph fs-15">Series</span> <p class="info">Mignon</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">Trim Size</span> <p class="info"> 5.75"x8.25" </p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Page Count</span> <p class="info">270 pages</p> </div> <div class="detail-box"> <span class="type paragraph fs-15">ISBN</span> <p class="info">9798400906855</p> </div> </div> <div> <div class="detail-box"> <span class="type paragraph fs-15">Release Date</span> <p class="info">Jan 26, 2027</p> </div> <div class="detail-box"> <span>Age Rating</span> <p class="info">18+ M (Mature)</p> </div> </div> <div> <span class="type paragraph fs-15">Imprint</span> <p class="info">Ize Press</p> </div> </div> </div> </section></body></html>`;

const MANGA_URL =
  "https://yenpress.com/titles/9798855438611-a-misanthrope-teaches-a-class-for-demi-humans-vol-4-manga";
const DELUXE_URL = "https://yenpress.com/titles/9798855431483-battle-royale-deluxe-edition-vol-3";
const NOVEL_URL =
  "https://yenpress.com/titles/9781718386693-a-livid-lady-s-guide-to-getting-even-volume-2-light-novel";
const IZE_URL = "https://yenpress.com/titles/9798400906855-mignon-special-box-set-w-usb";

function sitemap(urls: string[]): string {
  const entries = urls
    .map((url) => `<url>\n  <loc>${url}</loc>\n  <changefreq>monthly</changefreq>\n</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://yenpress.com/category/manga</loc></url>\n${entries}</urlset>`;
}

describe("parseSitemap / skipsWithoutFetch", () => {
  it("lists English-market title pages and skips everything else", () => {
    const titles = parseSitemap(
      sitemap([
        MANGA_URL,
        "https://yenpress.com/titles/9798855438628-a-misanthrope-teaches-a-class-for-demi-humans-vol-4-manga",
        "https://yenpress.com/titles/9788952746054-freak-vol-1",
        "https://yenpress.com/series/sickness-unto-love",
      ]),
    );
    expect(titles.map((t) => t.isbn13)).toEqual(["9798855438611", "9798855438628"]);
    expect(titles[0]!.slug).toBe("a-misanthrope-teaches-a-class-for-demi-humans-vol-4-manga");
  });

  it("names prose, audio, and single-chapter slugs", () => {
    expect(skipsWithoutFetch("a-livid-lady-s-guide-volume-2-light-novel")).toBe(true);
    expect(skipsWithoutFetch("sickness-unto-love-audio")).toBe(true);
    expect(skipsWithoutFetch("chihaya-re-vol-1")).toBe(false);
    expect(skipsWithoutFetch("the-novelist-s-manga-vol-1")).toBe(false);
    expect(skipsWithoutFetch("toilet-bound-hanako-kun-chapter-134")).toBe(true);
    expect(skipsWithoutFetch("reborn-as-a-vending-machine-chapter-21-manga")).toBe(true);
    // x.5 extra chapters (staging 2026-09-27: these reached the page fetch and failed every run).
    expect(skipsWithoutFetch("goblin-slayer-chapter-64-5-manga")).toBe(true);
    expect(skipsWithoutFetch("kakegurui-compulsive-gambler-chapter-80-5")).toBe(true);
    expect(
      skipsWithoutFetch("re-starting-life-in-another-world-chapter-5-the-city-of-water-vol-2"),
    ).toBe(false);
  });
});

describe("parseTitlePage / toSnapshots", () => {
  it("reads one snapshot per format, cutting the volume subtitle off the title", () => {
    expect(parseYenDate("Jan 26, 2027")).toEqual({
      year: 2027,
      month: 1,
      day: 26,
    });
    const page = parseTitlePage(MANGA_PAGE)!;
    expect(page.category).toBe("manga");
    const [print, digital] = toSnapshots(page, MANGA_URL);
    expect(print).toMatchObject({
      isbn13: "9798855438611",
      seriesTitle: "A Misanthrope Teaches a Class for Demi-Humans",
      volumeLabel: "4",
      format: "physical",
      binding: "paperback",
      onsale: { year: 2027, month: 1, day: 26 },
      priceCents: 1300,
      imprint: "Yen Press",
      outOfScope: undefined,
    });
    expect(digital).toMatchObject({
      isbn13: "9798855438628",
      format: "digital",
      priceCents: 699,
    });
  });

  it("keeps packaging as packaging and hardbacks as hardcover", () => {
    const [hardback] = toSnapshots(parseTitlePage(DELUXE_PAGE)!, DELUXE_URL);
    expect(hardback).toMatchObject({
      seriesTitle: "Battle Royale",
      volumeLabel: undefined,
      packaging: { lineName: "Deluxe Edition", linePosition: "3" },
      binding: "hardcover",
    });
  });

  it("scopes out light novels, but keeps Ize Press manhwa filed under comics", () => {
    const [novel] = toSnapshots(parseTitlePage(NOVEL_PAGE)!, NOVEL_URL);
    // J-Novel Club's novels are out by category (its print manga is in).
    expect(novel!.outOfScope).toBe("category light-novels");
    const [ize] = toSnapshots(parseTitlePage(IZE_BOX_PAGE)!, IZE_URL);
    expect(ize).toMatchObject({
      imprint: "Ize Press",
      category: "comics",
      isBox: true,
    });
    expect(ize!.outOfScope).toBeUndefined();
  });

  it("scopes out single digital chapters but not arc names with a volume", () => {
    const chapter = MANGA_PAGE.replace(
      /A Misanthrope Teaches a Class for Demi-Humans, Vol\. 4 \(manga\)[^<]*/,
      "Monster and the Beast, Chapter 22 (v-scroll)",
    );
    expect(toSnapshots(parseTitlePage(chapter)!, MANGA_URL)[0]!.outOfScope).toBe("single chapter");
    const arc = MANGA_PAGE.replace(
      /A Misanthrope Teaches a Class for Demi-Humans, Vol\. 4 \(manga\)[^<]*/,
      "Re:ZERO -Starting Life in Another World-, Chapter 5: The City of Water, Vol. 2",
    );
    expect(toSnapshots(parseTitlePage(arc)!, MANGA_URL)[0]).toMatchObject({
      volumeLabel: "2",
      outOfScope: undefined,
    });
  });

  it("admits JY manga while keeping JY prose out", () => {
    const page = parseTitlePage(liveFixture("little-witch-academia"))!;
    expect(page.category).toBe("manga");
    const snapshots = toSnapshots(
      page,
      "https://yenpress.com/titles/9781975327453-little-witch-academia-vol-1-manga",
    );
    expect(snapshots.map((s) => s.isbn13)).toEqual(["9781975327453", "9781975382469"]);
    expect(snapshots.every((s) => s.outOfScope === undefined)).toBe(true);
    expect(
      toSnapshots({ ...page, category: "light-novels" }, "https://yenpress.com")[0]!.outOfScope,
    ).toBeDefined();
    // No genre labels at all: JY falls through to the title rules like any imprint.
    expect(
      toSnapshots({ ...page, category: undefined }, "https://yenpress.com")[0]!.outOfScope,
    ).toBeUndefined();
  });

  it("reads the blurb paragraph, not the tagline, onto every format's snapshot", () => {
    const html = liveFixture("little-witch-academia-3");
    const page = parseTitlePage(html)!;
    expect(page.description).toMatch(
      /^The curtain rises ono an interschool broom race .* final volume of Little Witch Academia!$/,
    );
    expect(page.description).not.toContain("give up");
    const snapshots = toSnapshots(
      page,
      "https://yenpress.com/titles/9781975357429-little-witch-academia-vol-3-manga",
    );
    expect(snapshots.map((s) => s.isbn13)).toEqual(["9781975357429", "9781975357436"]);
    expect(snapshots.every((s) => s.description === page.description)).toBe(true);
    // The live markup sometimes leaves the <p> unclosed before </div>.
    const unclosed = html.replace(/<\/p>\s*<\/div>/, "\n</div>");
    expect(parseTitlePage(unclosed)!.description).toBe(page.description);
    // A page without the block offers no description at all.
    expect(parseTitlePage(liveFixture("little-witch-academia"))!.description).toBeUndefined();
  });

  it("rejects impossible calendar dates", () => {
    expect(parseYenDate("Feb 29, 2025")).toBeUndefined();
    expect(parseYenDate("Apr 31, 2026")).toBeUndefined();
    expect(parseYenDate("Feb 29, 2024")).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it("rejects a page that is not a title page", () => {
    expect(parseTitlePage("<html><body><h1>Oops</h1></body></html>")).toBeNull();
  });
});

// ---------- the adapter ----------

const requested: string[] = [];

function stubYen(pages: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    requested.push(url);
    if (url === "https://yenpress.com/sitemap.xml") {
      const digital = MANGA_URL.replace("9798855438611", "9798855438628");
      return new Response(sitemap([...Object.keys(pages), digital, NOVEL_URL]), {
        headers: { "content-type": "application/xml" },
      });
    }
    const html = pages[url];
    return html !== undefined
      ? new Response(html, { headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  requested.length = 0;
});

/** The registry in Bootstrap Mode, and the launch publishers Yen's books file under. */
async function seed(t: TestT) {
  await seedRegistry(t, true);
  await t.mutation(internal.launch.seedPublishers, {});
}

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.yenPress.sync, { politeDelayMs: 0, ...args });

describe("Yen merchandise pages", () => {
  it.each([
    ["delicious-in-dungeon-shirt", "Paperback"],
    ["delicious-in-dungeon-acrylic-standee", "Hardback"],
  ])("observes %s without creating catalog records", async (fixture, tab) => {
    const t = makeT();
    await seed(t);
    const page = parseTitlePage(liveFixture(fixture))!;
    // Yen labels these products as manga and gives them book format tabs.
    expect(page.category).toBe("manga");
    expect(page.formats[0]!.tab).toBe(tab);
    const snapshot = toSnapshots(page, "https://yenpress.com/titles/merchandise")[0]!;
    expect(await t.mutation(internal.yenPress.applyTitle, { snapshot })).toMatchObject({
      status: "recordOnly",
      reason: "merchandise",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      expect(await ctx.db.query("editions").collect()).toHaveLength(0);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ snapshot: { outOfScope: "merchandise" } });
      expect(observations[0]!.recordRef).toBeUndefined();
    });
  });

  it("excludes Yen's merchandise collection even without a product type in the title", () => {
    const page = parseTitlePage(liveFixture("delicious-in-dungeon-shirt"))!;
    const [snapshot] = toSnapshots(
      { ...page, title: "Delicious in Dungeon Party Artwork" },
      "https://yenpress.com/titles/merchandise",
    );
    expect(snapshot!.outOfScope).toBe("merchandise");
  });
});

describe("yenPress.booksToFetch", () => {
  it("fetches a page when a newly listed format has no observation yet", async () => {
    const t = makeT();
    const now = Date.UTC(2026, 8, 25);
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "yenpress",
        sourceRecordId: "9798855438611",
        snapshot: { onsale: { year: 2020, month: 1, day: 1 }, mature: false },
        lastSeenAt: now,
      }),
    );
    const plan = (books: string[][]) => t.query(internal.yenPress.booksToFetch, { books, now });
    // Print alone is fresh; print + a digital ISBN never seen is due.
    expect(await plan([["9798855438611"]])).toEqual({ due: [], boxes: [] });
    expect(await plan([["9798855438611", "9798855438628"]])).toEqual({ due: [0], boxes: [] });
  });

  // Standards 2: the planner names fresh linked boxes, so the sync can
  // reconcile each in its own mutation; a due box is simply re-read.
  it("reports fresh linked boxes apart from the pages due", async () => {
    const t = makeT();
    const now = Date.UTC(2026, 8, 25);
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
      const bundleId = await insertBundle(ctx, { name: "Mignon Box Set (Vol. 1-2)", publisherId });
      for (const [isbn, lastSeenAt] of [
        ["9798400906855", now],
        ["9798400906862", 0],
      ] as const) {
        await insertObservation(ctx, {
          sourceKey: "yenpress",
          sourceRecordId: isbn,
          snapshot: { onsale: { year: 2020, month: 1, day: 1 }, mature: false },
          lastSeenAt,
          recordRef: { type: "releaseBundle", id: bundleId },
        });
      }
    });
    expect(
      await t.query(internal.yenPress.booksToFetch, {
        books: [["9798400906855"], ["9798400906862"], ["9798855438611"]],
        now,
      }),
    ).toEqual({ due: [1, 2], boxes: [0] });
  });
});

describe("yenPress.sync — disabling a source", () => {
  it("stops a scheduled run at its next link once the source is disabled", async () => {
    const t = makeT();
    await seed(t);
    stubYen({
      [MANGA_URL]: MANGA_PAGE,
      [DELUXE_URL]: DELUXE_PAGE,
      [IZE_URL]: IZE_BOX_PAGE,
    });
    expect(await sync(t, { maxFetches: 1 })).toMatchObject({
      continued: true,
      fetched: 1,
    });
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "yenpress",
      enabled: false,
    });
    await drain(t);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", automatic: true });
      expect(run!.errors.at(-1)).toMatch(/disabled mid-run/);
    });
    // Only the first link's page was fetched.
    expect(requested.filter((url) => url !== "https://yenpress.com/sitemap.xml")).toHaveLength(1);
  });

  it("finishes the hundred titles under way and stops before the next hundred", async () => {
    const t = makeT();
    await seed(t);
    // 101 new titles: two planning chunks. Every title page is gone (a 404 is
    // only a notice), and the source is disabled while the first one loads.
    const urls = Array.from(
      { length: 101 },
      (_, i) =>
        `https://yenpress.com/titles/${isbn10To13(`19753${String(i).padStart(4, "0")}0`)}-gate-manga-vol-${i + 1}`,
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://yenpress.com/sitemap.xml") return new Response(sitemap(urls));
      if (requested.length === 2) {
        await t.mutation(internal.importSources.setEnabledInternal, {
          key: "yenpress",
          enabled: false,
        });
      }
      return new Response("not found", { status: 404 });
    });
    expect(await sync(t)).toMatchObject({ stopped: true, fetched: 100, continued: false });
    expect(requested.filter((url) => url !== "https://yenpress.com/sitemap.xml")).toHaveLength(100);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "stopped", automatic: true });
    });
  });

  it("imports through a run an operator forced on the disabled source", async () => {
    const t = makeT();
    await seed(t);
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "yenpress",
      enabled: false,
    });
    stubYen({
      [MANGA_URL]: MANGA_PAGE,
      [DELUXE_URL]: DELUXE_PAGE,
      [IZE_URL]: IZE_BOX_PAGE,
    });
    const runId = await t.mutation(internal.imports.startRun, {
      sourceKey: "yenpress",
    });
    expect(await sync(t, { runId, maxFetches: 1 })).toMatchObject({
      continued: true,
    });
    await drain(t);
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run).toMatchObject({ status: "succeeded", recordsSeen: 5 });
      expect(run?.errors.some((e) => /disabled mid-run/.test(e))).toBe(false);
      // Every book is observed and placed, as on an enabled source: Vol. 4
      // print + digital and the Deluxe hardback + digital become Releases,
      // the box an observation of its own.
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId).sort()).toEqual([
        "9798400906855",
        "9798855431483",
        "9798855431490",
        "9798855438611",
        "9798855438628",
      ]);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13).sort()).toEqual([
        "9798855431483",
        "9798855431490",
        "9798855438611",
        "9798855438628",
      ]);
      const linked = observations.filter((o) => o.recordRef?.type === "release");
      expect(linked).toHaveLength(4);
    });
    expect(requested.filter((url) => url !== "https://yenpress.com/sitemap.xml")).toHaveLength(3);
  });
});

describe("yenPress.sync", () => {
  it.each([1, 300])(
    "fetches separate format pages sharing a slug with a budget of %i",
    async (maxFetches) => {
      const t = makeT();
      await seed(t);
      const printUrl = "https://yenpress.com/titles/9780759528598-nightschool-vol-1";
      const digitalUrl = "https://yenpress.com/titles/9780316213691-nightschool-vol-1";
      const pages: Record<string, string> = {
        [printUrl]: liveFixture("nightschool-print"),
        [digitalUrl]: liveFixture("nightschool-digital"),
      };
      vi.stubGlobal("fetch", async (input: string) => {
        requested.push(input);
        return new Response(
          input.endsWith("/sitemap.xml") ? sitemap(Object.keys(pages)) : pages[input],
        );
      });
      await sync(t, { maxFetches });
      await drain(t);
      expect(requested.filter((url) => url.includes("/titles/")).sort()).toEqual(
        [digitalUrl, printUrl].sort(),
      );
      await t.run(async (ctx) => {
        const observations = await ctx.db.query("sourceObservations").collect();
        expect(observations.map((o) => o.sourceRecordId).sort()).toEqual([
          "9780316213691",
          "9780759528598",
        ]);
      });
    },
  );

  it("carries page failure through continuation", async () => {
    const t = makeT();
    await seed(t);
    stubYen({ [MANGA_URL]: "<html>Broken template</html>", [DELUXE_URL]: DELUXE_PAGE });
    await sync(t, { maxFetches: 1 });
    await drain(t);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.status).toBe("failed");
      expect(run!.errors.some((error) => error.includes("not a title page"))).toBe(true);
    });
  });

  it("notes a removed title page (HTTP 404) without failing the run", async () => {
    const t = makeT();
    await seed(t);
    // The manga's digital URL is in the sitemap but its page is gone.
    stubYen({ [DELUXE_URL]: DELUXE_PAGE });
    const result = await sync(t);
    expect(result).toMatchObject({ continued: false, fetched: 2, errorCount: 1 });
    expect((result as { failed?: boolean }).failed).toBeUndefined();
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.status).toBe("succeeded");
      expect(run!.errors[0]).toContain("HTTP 404");
    });
  });

  it("fails a sitemap response that silently lost its titles", async () => {
    const t = makeT();
    await seed(t);
    vi.stubGlobal("fetch", async () => new Response("<html>Temporarily unavailable</html>"));
    expect(await sync(t)).toMatchObject({ failed: true, recordsSeen: 0 });
  });

  it("creates JY manga releases under its own imprint", async () => {
    const t = makeT();
    await seed(t);
    const url = "https://yenpress.com/titles/9781975327453-little-witch-academia-vol-1-manga";
    const snapshots = toSnapshots(parseTitlePage(liveFixture("little-witch-academia"))!, url);
    for (const snapshot of snapshots) await t.mutation(internal.yenPress.applyTitle, { snapshot });
    await t.run(async (ctx) => {
      const publisher = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "jy"))
        .unique();
      expect(publisher!.parentPublisherId).toBeDefined();
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(2);
      expect(releases.every((release) => release.publisherId === publisher!._id)).toBe(true);
    });
  });

  it("carries the blurb into new Releases and fills it on linked ones", async () => {
    const t = makeT();
    await seed(t);
    const url = "https://yenpress.com/titles/9781975357429-little-witch-academia-vol-3-manga";
    const page = parseTitlePage(liveFixture("little-witch-academia-3"))!;
    // First seen without a blurb, then with one: the linked Releases fill.
    for (const snapshot of toSnapshots({ ...page, description: undefined }, url)) {
      await t.mutation(internal.yenPress.applyTitle, { snapshot });
    }
    const descriptions = async () =>
      await t.run(async (ctx) =>
        (await ctx.db.query("releases").collect()).map((r) => r.description ?? null),
      );
    expect(await descriptions()).toEqual([null, null]);
    for (const snapshot of toSnapshots(page, url)) {
      expect(await t.mutation(internal.yenPress.applyTitle, { snapshot })).toMatchObject({
        status: "updated",
      });
    }
    expect(await descriptions()).toEqual([page.description, page.description]);
  });

  it("creates in-scope books under Yen's publisher rows, once per page, never novels", async () => {
    const t = makeT();
    await seed(t);
    stubYen({
      [MANGA_URL]: MANGA_PAGE,
      [DELUXE_URL]: DELUXE_PAGE,
      [IZE_URL]: IZE_BOX_PAGE,
    });

    const result = await sync(t);
    expect(result).toMatchObject({ continued: false, fetched: 3 });
    // The novel slug is never fetched; the manga's digital URL shares its page.
    expect(requested.filter((u) => u.includes("/titles/"))).toHaveLength(3);

    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      const isbns = releases.map((r) => r.isbn13).sort();
      // Vol. 4 print + digital, plus the Deluxe hardback + digital: an
      // Edition Line member whose coverage the title never states is created
      // as Unmapped Packaging under its line (Bootstrap Mode).
      expect(isbns).toEqual(["9798855431483", "9798855431490", "9798855438611", "9798855438628"]);
      const deluxe = (await ctx.db.query("editions").collect()).filter((e) => e.coverageUnmapped);
      expect(deluxe).toHaveLength(1);
      expect(await ctx.db.get(deluxe[0]!.editionLineId!)).toMatchObject({ name: "Deluxe Edition" });
      expect(
        await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", deluxe[0]!._id))
          .collect(),
      ).toHaveLength(0);
      // The Deluxe-only work gets its base Series (no Volumes yet) for the line to hang on.
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title).sort()).toEqual([
        "A Misanthrope Teaches a Class for Demi-Humans",
        "Battle Royale",
      ]);
      const yen = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "yen-press"))
        .unique();
      expect(releases.every((r) => r.publisherId === yen!._id)).toBe(true);
      expect(releases.find((r) => r.format === "physical")).toMatchObject({
        binding: "paperback",
        pubDate: { year: 2027, month: 1, day: 26 },
        price: { amountCents: 1300, currency: "USD" },
      });
    });
  });

  it("is incremental: fresh books are not refetched, and a small budget chains", async () => {
    const t = makeT();
    await seed(t);
    stubYen({
      [MANGA_URL]: MANGA_PAGE,
      [DELUXE_URL]: DELUXE_PAGE,
      [IZE_URL]: IZE_BOX_PAGE,
    });

    const clock = tickingClock();
    const first = await sync(t, { maxFetches: 1 });
    expect(first).toMatchObject({ continued: true, fetched: 1 });
    await expectStampedAtHandOff(t);
    clock.mockRestore();
    await drain(t);
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run).toMatchObject({ status: "succeeded" });
    });

    requested.length = 0;
    const again = await sync(t);
    expect(again).toMatchObject({ fetched: 0 });
    expect(requested).toEqual(["https://yenpress.com/sitemap.xml"]);
  });
});

// R09: Yen re-reads a box set's page when it falls due; that re-apply,
// unchanged, links the books that arrived after the box.
/** A Mignon single-Volume snapshot. */
const mignonBook = (
  isbn13: string,
  volumeLabel: string,
  format: "physical" | "digital" = "physical",
) => ({
  kind: "yenTitle" as const,
  url: `https://yenpress.com/titles/${isbn13}-mignon-vol-${volumeLabel}`,
  isbn13,
  title: `Mignon, Vol. ${volumeLabel}`,
  seriesTitle: "Mignon",
  volumeLabel,
  multiVolume: false,
  format,
  imprint: "Yen Press",
});

/** The Mignon Vol. 1–2 paperback box's snapshot. */
const MIGNON_BOX = {
  ...mignonBook("9798400906855", "1"),
  url: "https://yenpress.com/titles/9798400906855-mignon-box-set",
  title: "Mignon Box Set (Vol. 1-2)",
  volumeLabel: undefined,
  multiVolume: true,
  isBox: true,
  packaging: { lineName: "Box Set", linePosition: null, coverRange: { from: "1", to: "2" } },
};

/** Seed the registry (Bootstrap Mode) and the Mignon Series. */
async function seedMignon(t: TestT) {
  await seed(t);
  await t.run((ctx) => insertSeries(ctx, { title: "Mignon" }));
}

/** The one bundle's member ISBNs and orders (`isbn@order`) in page order. */
const mignonMembers = async (t: TestT) =>
  (await bundleMembers(t)).map((member) => `${member.release.isbn13}@${member.order}`);

describe("yenPress.applyTitle — a box set gains members that arrive after it (B15)", () => {
  it("an unchanged box re-applied after its books arrive links them", async () => {
    const t = makeT();
    await seedMignon(t);
    expect(await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX })).toMatchObject({
      status: "created",
    });
    for (const [isbn13, label] of [
      ["9781975300012", "1"],
      ["9781975300029", "2"],
    ] as const) {
      await t.mutation(internal.yenPress.applyTitle, { snapshot: mignonBook(isbn13, label) });
    }
    expect(await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX })).toMatchObject({
      status: "updated",
      changed: true,
    });
    const members = await bundleMembers(t);
    expect(members.map((member) => member.release.isbn13)).toEqual([
      "9781975300012",
      "9781975300029",
    ]);
    expect(await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX })).toMatchObject({
      status: "unchanged",
    });
  });
});

// W08: a linked box fills only from its canonical identity; a Format the
// Bundle does not have goes to review instead.
describe("yenPress.applyTitle — a linked box keeps its canonical identity (W08)", () => {
  it("a paperback box re-applied as digital adds no digital member", async () => {
    const t = makeT();
    await seedMignon(t);
    await t.mutation(internal.yenPress.applyTitle, { snapshot: mignonBook("9781975300012", "1") });
    await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX });
    await t.mutation(internal.yenPress.applyTitle, {
      snapshot: mignonBook("9781975300029", "1", "digital"),
    });
    expect(
      await t.mutation(internal.yenPress.applyTitle, {
        snapshot: { ...MIGNON_BOX, format: "digital" },
      }),
    ).toMatchObject({ status: "needsReview", reason: expect.stringMatching(/Format/) });
    expect(await mignonMembers(t)).toEqual(["9781975300012@1"]);
  });
});

// Standards 2: a fresh box is reconciled from its stored snapshot in a
// mutation of its own (yenPress.reconcileLinkedBox).
describe("yenPress.reconcileLinkedBox", () => {
  // W09: backlist boxes are filled here, so a legacy compact order (the
  // baseline importer stored a lone Vol. 2 at order 1) is renumbered.
  it("fills a legacy box by label position, renumbering its compact order", async () => {
    const t = makeT();
    await seedMignon(t);
    await t.mutation(internal.yenPress.applyTitle, { snapshot: mignonBook("9781975300029", "2") });
    await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX });
    await t.run(async (ctx) => {
      const [member] = await ctx.db.query("bundleMemberships").collect();
      await ctx.db.patch(member!._id, { order: 1 });
    });
    await t.mutation(internal.yenPress.applyTitle, { snapshot: mignonBook("9781975300012", "1") });
    expect(
      await t.mutation(internal.yenPress.reconcileLinkedBox, { isbn: MIGNON_BOX.isbn13 }),
    ).toEqual({ added: 1 });
    expect(await mignonMembers(t)).toEqual(["9781975300012@1", "9781975300029@2"]);
  });

  // Operator and scheduled runs alike: whether to run is the sync's gate, so
  // the mutation fills a box while the source is disabled too.
  it("adds nothing for a Release, and fills a box whatever the source's flag", async () => {
    const t = makeT();
    await seedMignon(t);
    await t.mutation(internal.yenPress.applyTitle, { snapshot: MIGNON_BOX });
    await t.mutation(internal.yenPress.applyTitle, { snapshot: mignonBook("9781975300012", "1") });
    expect(
      await t.mutation(internal.yenPress.reconcileLinkedBox, { isbn: "9781975300012" }),
    ).toEqual({ added: 0 });
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "yenpress",
      enabled: false,
    });
    expect(
      await t.mutation(internal.yenPress.reconcileLinkedBox, { isbn: MIGNON_BOX.isbn13 }),
    ).toEqual({ added: 1 });
    expect(await mignonMembers(t)).toEqual(["9781975300012@1"]);
  });
});

// R09 through the cron entry point: the sitemap sorts a box's slug before
// its volumes', so a first run creates the box before its books. The box is
// backlist — its page not due again for months — yet the next run links the
// books from its stored snapshot, without re-reading its page.
describe("yenPress.sync — a fresh box set gains members that arrived after it (B15)", () => {
  /** The fixture page cut to its paperback: one format, one snapshot. */
  const PRINT_ONLY_PAGE = MANGA_PAGE.replace(' <span class="deliver" data-id="">Digital</span>', "")
    .replace('<div class="deliver-info"><p class="book-price">$6.99 US / $8.99 CAN</p></div>', "")
    .replace(/<div class="detail"> <div class="txt-hold">.*<\/section>/, "</section>");
  /** A backlist paperback's page, built from the fixture with its facts swapped. */
  const titlePage = (title: string, isbn13: string) =>
    PRINT_ONLY_PAGE.replaceAll(
      "A Misanthrope Teaches a Class for Demi-Humans, Vol. 4 (manga): Mr. Hitoma, Won’t You Teach Us About Humans…?",
      title,
    )
      .replaceAll("A Misanthrope Teaches a Class for Demi-Humans (manga)", "Alpha Adventures")
      .replaceAll("9798855438611", isbn13)
      .replaceAll("Jan 26, 2027", "Jan 26, 2020");
  const BOX_URL = "https://yenpress.com/titles/9781975300050-alpha-adventures-box-set";
  const VOL_1_URL = "https://yenpress.com/titles/9781975300012-alpha-adventures-vol-1";
  const VOL_2_URL = "https://yenpress.com/titles/9781975300029-alpha-adventures-vol-2";
  const pages = {
    [BOX_URL]: titlePage("Alpha Adventures Box Set (Vol. 1-2)", "9781975300050"),
    [VOL_1_URL]: titlePage("Alpha Adventures, Vol. 1", "9781975300012"),
    [VOL_2_URL]: titlePage("Alpha Adventures, Vol. 2", "9781975300029"),
  };
  /** The one box's members, by their Releases' ISBNs in bundle order. */
  const boxMembers = async (t: TestT) =>
    (await bundleMembers(t)).map((member) => member.release.isbn13);

  it("links the late books on the next run, without fetching the box page", async () => {
    const t = makeT();
    await seed(t);
    await t.run((ctx) => insertSeries(ctx, { title: "Alpha Adventures" }));
    stubYen(pages);
    await sync(t);
    // The box was applied first: its books did not exist yet.
    expect(await boxMembers(t)).toEqual([]);

    // (stubYen's sitemap also lists a page it 404s, so that one is re-tried.)
    requested.length = 0;
    expect(await sync(t)).toMatchObject({ recordsChanged: 1 });
    expect(requested.filter((url) => url in pages)).toEqual([]);
    expect(await boxMembers(t)).toEqual(["9781975300012", "9781975300029"]);

    // Nothing left to add: a further run writes nothing.
    expect(await sync(t)).toMatchObject({ recordsChanged: 0 });
    expect(await boxMembers(t)).toHaveLength(2);
  });

  it("links the late books of every fresh box, one box at a time", async () => {
    const t = makeT();
    await seed(t);
    // The same three pages for a second Series, under valid Beta ISBNs.
    const betaIsbn = (html: string) =>
      html
        .replaceAll("9781975300050", "9781975300159")
        .replaceAll("9781975300012", "9781975300111")
        .replaceAll("9781975300029", "9781975300128");
    const betaPages = Object.fromEntries(
      Object.entries(pages).map(([url, html]) => [
        betaIsbn(url.replace("alpha", "beta")),
        betaIsbn(html.replaceAll("Alpha", "Beta")),
      ]),
    );
    await t.run(async (ctx) => {
      for (const title of ["Alpha Adventures", "Beta Adventures"])
        await insertSeries(ctx, { title });
    });
    stubYen({ ...pages, ...betaPages });
    await sync(t);
    /** Each box's name and its members' ISBNs in bundle order. */
    const members = async () => {
      const bundles = await t.run((ctx) => ctx.db.query("releaseBundles").collect());
      return await Promise.all(
        bundles.map(async (bundle) => {
          const rows = await bundleMembers(t, bundle._id);
          return [bundle.name, rows.map((row) => row.release.isbn13)] as const;
        }),
      );
    };
    expect(await members()).toEqual([
      ["Alpha Adventures Box Set (Vol. 1-2)", []],
      ["Beta Adventures Box Set (Vol. 1-2)", []],
    ]);

    expect(await sync(t)).toMatchObject({ recordsChanged: 2 });
    expect(await members()).toEqual([
      ["Alpha Adventures Box Set (Vol. 1-2)", ["9781975300012", "9781975300029"]],
      ["Beta Adventures Box Set (Vol. 1-2)", ["9781975300111", "9781975300128"]],
    ]);
  });
});

// R12: Yen Press places through the shared catalog path (lib/catalogTitle.ts);
// a page blurb listing Volumes with a gap keeps the 3-in-1 size from
// inventing the Volume it skips.
describe("yenPress.applyTitle — a gapped coverage statement is never widened (R12)", () => {
  it("a blurb collecting Volumes 1 and 3 leaves the book Unmapped Packaging", async () => {
    const t = makeT();
    await seed(t);
    const page = {
      ...parseTitlePage(DELUXE_PAGE)!,
      title: "Battle Royale 3-in-1 Edition, Vol. 1",
      description: "Collects volumes 1 and 3 of the thriller.",
    };
    for (const snapshot of toSnapshots(page, DELUXE_URL)) {
      await t.mutation(internal.yenPress.applyTitle, { snapshot });
    }
    await t.run(async (ctx) => {
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(0);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.coverageUnmapped)).toEqual([true]);
    });
  });

  it("a bare gapped list with no collect-verb leaves the book Unmapped Packaging", async () => {
    const t = makeT();
    await seed(t);
    const page = {
      ...parseTitlePage(DELUXE_PAGE)!,
      title: "Battle Royale 3-in-1 Edition, Vol. 1",
      description: "Volumes 1 and 3 in one book!",
    };
    for (const snapshot of toSnapshots(page, DELUXE_URL)) {
      await t.mutation(internal.yenPress.applyTitle, { snapshot });
    }
    await t.run(async (ctx) => {
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(0);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.coverageUnmapped)).toEqual([true]);
    });
  });

  it("a title listing Volumes 1 & 3 leaves the book Unmapped Packaging", async () => {
    const t = makeT();
    await seed(t);
    const page = {
      ...parseTitlePage(DELUXE_PAGE)!,
      title: "Battle Royale 3-in-1 Edition 1 (Vol. 1 & 3)",
    };
    for (const snapshot of toSnapshots(page, DELUXE_URL)) {
      await t.mutation(internal.yenPress.applyTitle, { snapshot });
    }
    await t.run(async (ctx) => {
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
      expect(await ctx.db.query("volumeCoverages").collect()).toHaveLength(0);
      const editions = await ctx.db.query("editions").collect();
      expect(editions.map((e) => e.coverageUnmapped)).toEqual([true]);
    });
  });
});

describe("yenPress.applyTitle — a sequel's book stays off its first work", () => {
  const FIRST = "The Alchemist Who Survived Now Dreams of a Quiet City Life";
  const SEQUEL = `${FIRST} II`;
  const ISBN = "9781975393489";
  const [snapshot] = toSnapshots(
    {
      title: `${SEQUEL}, Vol. 1 (manga): Cycle of the Elixir`,
      category: "manga",
      formats: [
        { tab: "Paperback", isbn13: ISBN, imprint: "Yen Press", seriesName: `${SEQUEL} (manga)` },
      ],
    },
    `https://yenpress.com/titles/${ISBN}-the-alchemist-who-survived-now-dreams-of-a-quiet-city-life-ii-vol-1-manga`,
  );

  /** The first work carrying the sequel's name as an alt title, and the sequel's Series. */
  async function seedAlchemist(t: TestT, sequel: "active" | "hidden") {
    await seed(t);
    return await t.run(async (ctx) => {
      const firstId = await insertSeries(ctx, {
        publicId: 1229,
        title: FIRST,
        altTitles: [SEQUEL],
      });
      const sequelId = await insertSeries(ctx, { publicId: 5358, title: SEQUEL, status: sequel });
      for (const seriesId of [firstId, sequelId]) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: seriesId === firstId ? 12291 : 53581,
          seriesId,
          label: "1",
          position: 1,
        });
      }
      return { firstId, sequelId };
    });
  }

  it("files it under the sequel's Series by Yen's own series title", async () => {
    const t = makeT();
    const { sequelId } = await seedAlchemist(t, "active");
    expect(snapshot!.seriesTitle).toBe(SEQUEL);
    await t.mutation(internal.yenPress.applyTitle, { snapshot: snapshot! });
    await t.run(async (ctx) => {
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => [r.isbn13, r.seriesIds])).toEqual([[ISBN, [sequelId]]]);
    });
  });

  it("holds it when the sequel is hidden, though the first work carries the sequel's name as an alt title", async () => {
    const t = makeT();
    await seedAlchemist(t, "hidden");
    await t.mutation(internal.yenPress.applyTitle, { snapshot: snapshot! });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toEqual([]);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === ISBN,
      )!;
      const hold = await ctx.db
        .query("placementHolds")
        .withIndex("by_observation", (q) => q.eq("observationId", obs._id))
        .unique();
      expect(hold?.kind).toBe("series");
    });
  });
});
