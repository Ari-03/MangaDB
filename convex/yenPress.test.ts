// Yen Press tests: the sitemap/title-page parsers against trimmed copies of
// live pages (fetched 2026-09-25: the header, format tabs, prices, and the
// "full details" section; a site-nav genre link stays in front to prove the
// category is read from the book's own labels), and the adapter run
// against a stubbed yenpress.com — no network.

import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import {
  skipsWithoutFetch,
  parseSitemap,
  parseTitlePage,
  parseYenDate,
  toSnapshots,
} from "./lib/yenPress";
import schema from "./schema";

// Trimmed first-party HTML fetched 2026-09-26; only fields used by the parser.
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

async function seed(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.importSources.seedRegistry, {});
  await t.mutation(internal.importSources.setBootstrapModeInternal, {
    on: true,
  });
  await t.mutation(internal.launch.seedPublishers, {});
}

const sync = (t: ReturnType<typeof convexTest>, args: object = {}) =>
  t.action(internal.yenPress.sync, { politeDelayMs: 0, ...args });

describe("yenPress.booksToFetch", () => {
  it("fetches a page when a newly listed format has no observation yet", async () => {
    const t = convexTest(schema);
    const now = Date.UTC(2026, 8, 25);
    await t.run(async (ctx) => {
      await ctx.db.insert("sourceObservations", {
        sourceKey: "yenpress",
        sourceRecordId: "9798855438611",
        snapshot: { onsale: { year: 2020, month: 1, day: 1 } },
        lastSeenAt: now,
        withdrawn: false,
      });
    });
    const due = (books: string[][]) => t.query(internal.yenPress.booksToFetch, { books, now });
    // Print alone is fresh; print + a digital ISBN never seen is due.
    expect(await due([["9798855438611"]])).toEqual([]);
    expect(await due([["9798855438611", "9798855438628"]])).toEqual([0]);
  });
});

describe("yenPress.sync — disabling a source", () => {
  const drain = async (t: ReturnType<typeof convexTest>) => {
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  };

  it("stops a scheduled run at its next link once the source is disabled", async () => {
    const t = convexTest(schema);
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

  it("finishes a run an operator forced on the disabled source", async () => {
    const t = convexTest(schema);
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
      expect(run?.status).toBe("succeeded");
      expect(run?.errors.some((e) => /disabled mid-run/.test(e))).toBe(false);
    });
    expect(requested.filter((url) => url !== "https://yenpress.com/sitemap.xml")).toHaveLength(3);
  });
});

describe("yenPress.sync", () => {
  it.each([1, 300])(
    "fetches separate format pages sharing a slug with a budget of %i",
    async (maxFetches) => {
      const t = convexTest(schema);
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
      vi.useFakeTimers();
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      vi.useRealTimers();
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
    const t = convexTest(schema);
    await seed(t);
    stubYen({ [MANGA_URL]: "<html>Broken template</html>", [DELUXE_URL]: DELUXE_PAGE });
    await sync(t, { maxFetches: 1 });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.status).toBe("failed");
      expect(run!.errors.some((error) => error.includes("not a title page"))).toBe(true);
    });
  });

  it("fails a sitemap response that silently lost its titles", async () => {
    const t = convexTest(schema);
    await seed(t);
    vi.stubGlobal("fetch", async () => new Response("<html>Temporarily unavailable</html>"));
    expect(await sync(t)).toMatchObject({ failed: true, recordsSeen: 0 });
  });

  it("creates JY manga releases under its own imprint", async () => {
    const t = convexTest(schema);
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

  it("creates in-scope books under Yen's publisher rows, once per page, never novels", async () => {
    const t = convexTest(schema);
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
      // Vol. 4 print + digital; the Deluxe hardback + digital (an Edition
      // Line member whose coverage the title never states stays unplaced).
      expect(isbns).toEqual(["9798855438611", "9798855438628"]);
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title)).toEqual(["A Misanthrope Teaches a Class for Demi-Humans"]);
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
    const t = convexTest(schema);
    await seed(t);
    stubYen({
      [MANGA_URL]: MANGA_PAGE,
      [DELUXE_URL]: DELUXE_PAGE,
      [IZE_URL]: IZE_BOX_PAGE,
    });

    const first = await sync(t, { maxFetches: 1 });
    expect(first).toMatchObject({ continued: true, fetched: 1 });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
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
