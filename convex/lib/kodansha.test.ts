// Kodansha parser tests (ticket #36) against the live wire shapes captured
// 2026-08-20 from kodansha.us/wp-json/kodansha/v1/*, and the backlist
// parsers against trimmed live pages in __fixtures__/kodansha (fetched
// 2026-09-25: each page's JSON-LD blocks and /series/ links, verbatim).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  crawlMode,
  FULL_REFRESH_MS,
  needsRecheck,
  parseCalendar,
  parseCreators,
  parseIsoDate,
  parseNewReleases,
  parseSeriesListing,
  parseSeriesName,
  parseSeriesPage,
  parseVolumeLabel,
  parseVolumePage,
  parseVolumeUrl,
  RECHECK_MS,
  sourceRecordId,
  toBacklistSnapshots,
  toSnapshots,
  volumesToFetch,
  type SeriesCrawl,
} from "./kodansha";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/kodansha/${name}`, import.meta.url), "utf8");

// Verbatim slices of the live payloads (including the \u00a0 in titles).
const CALENDAR = {
  success: true,
  data: [
    {
      tue_key: "2026-08-04",
      date_label: "Published on Aug. 4, 2026",
      is_past: true,
      items: [
        {
          title: "Volume\u00a021",
          series_name: "Welcome to Demon School! Iruma-kun",
          creators: "By Osamu Nishi",
          image: "https://production.image.azuki.co/b80d2b33/800.webp",
          volume_url: "https://kodansha.us/series/welcome-to-demon-school-iruma-kun/volume-21/",
          formats: ["digital", "print"],
        },
        {
          title: "Volume\u00a022",
          series_name: "Tying the Knot with an Amagami Sister",
          creators: "By Marcey Naito",
          image: "https://production.image.azuki.co/ea90e88b/800.webp",
          volume_url: "https://kodansha.us/series/tying-the-knot-with-an-amagami-sister/volume-22/",
          formats: ["digital"],
        },
        { title: "malformed", volume_url: 42 },
      ],
    },
  ],
};

const NEW_RELEASES = {
  success: true,
  data: [
    {
      series_name: "My Home Hero",
      volume_title: "Volume 26",
      image: "https://production.image.azuki.co/99becf61/800.webp",
      volume_url: "https://kodansha.us/series/my-home-hero/volume-26/",
      series_slug: "my-home-hero",
      series_type: "comic",
      creators: "By Naoki Yamakawa, Masashi Asaki",
      release_date: "2026-08-18T04:00:00+00:00",
      product_uuid: "e6e2286a",
      volume_uuid: "991d2c15",
      age_rating: 18,
      is_purchasable: true,
      has_print: false,
      is_free: false,
    },
    {
      series_name: "Some Light Novel",
      volume_title: "Volume 3",
      volume_url: "https://kodansha.us/series/some-light-novel/volume-3/",
      series_type: "novel",
      release_date: "2026-08-18T04:00:00+00:00",
      is_purchasable: true,
      has_print: true,
    },
  ],
};

describe("small parsers", () => {
  it("splits volume URLs into slugs", () => {
    expect(parseVolumeUrl("https://kodansha.us/series/my-home-hero/volume-26/")).toEqual({
      seriesSlug: "my-home-hero",
      volumeSlug: "volume-26",
    });
    expect(parseVolumeUrl("https://kodansha.us/about/")).toBeNull();
  });

  it("reads volume labels through the API's non-breaking space", () => {
    expect(parseVolumeLabel("Volume\u00a021")).toBe("21");
    expect(parseVolumeLabel("Volume 7.5")).toBe("7.5");
    expect(parseVolumeLabel("Box Set")).toBeUndefined();
    // The slug stands in when the title carries no "Volume N" (Comeback
    // After Fate v1, Honey Bee & Lemon Balm v3).
    expect(parseVolumeLabel("Comeback After Fate", "volume-1")).toBe("1");
    expect(parseVolumeLabel("Volume 05")).toBe("5");
    // volume-0 is Kodansha's slug for an unnumbered oneshot.
    expect(parseVolumeLabel("Mermaid Prince", "volume-0")).toBeUndefined();
    expect(parseVolumeLabel("Fairy Tail Volume 0", "volume-0")).toBe("0");
  });

  it("splits creator bylines", () => {
    expect(parseCreators("By Naoki Yamakawa, Masashi Asaki")).toEqual([
      "Naoki Yamakawa",
      "Masashi Asaki",
    ]);
    expect(parseCreators(undefined)).toEqual([]);
  });

  it("parses both ISO date shapes", () => {
    expect(parseIsoDate("2026-08-04")).toEqual({
      year: 2026,
      month: 8,
      day: 4,
    });
    expect(parseIsoDate("2026-08-18T04:00:00+00:00")).toEqual({
      year: 2026,
      month: 8,
      day: 18,
    });
    expect(parseIsoDate("soon")).toBeUndefined();
    expect(parseIsoDate("2025-02-29")).toBeUndefined();
    expect(parseIsoDate("2026-04-31")).toBeUndefined();
    expect(parseIsoDate("2026-08-04garbage")).toBeUndefined();
    expect(parseIsoDate("2024-02-29")).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });
});

describe("feed envelopes", () => {
  it.each([parseCalendar, parseNewReleases, parseSeriesListing])(
    "rejects API errors and schema drift while permitting an empty feed",
    (parse) => {
      expect(() => parse({ success: false, data: [] })).toThrow();
      expect(() => parse({ error: "upstream unavailable" })).toThrow();
      expect(() => parse({ data: {} })).toThrow();
      expect(() => parse({ success: true, data: [] })).not.toThrow();
    },
  );
});

describe("parseCalendar", () => {
  it("flattens weekly buckets, dating items by tue_key and skipping malformed ones", () => {
    const items = parseCalendar(CALENDAR);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      seriesTitle: "Welcome to Demon School! Iruma-kun",
      seriesSlug: "welcome-to-demon-school-iruma-kun",
      volumeSlug: "volume-21",
      volumeLabel: "21",
      creators: ["Osamu Nishi"],
      formats: ["physical", "digital"],
      releaseDate: { year: 2026, month: 8, day: 4 },
    });
    expect(items[1]!.formats).toEqual(["digital"]);
  });
});

describe("parseNewReleases", () => {
  it("reads comics with per-format flags and marks novels out of scope", () => {
    const items = parseNewReleases(NEW_RELEASES);
    expect(items).toHaveLength(2);
    expect(items[1]!.outOfScope).toBe("novel");
    expect(items[0]!.outOfScope).toBeUndefined();
    expect(items[0]).toMatchObject({
      seriesTitle: "My Home Hero",
      volumeLabel: "26",
      formats: ["digital"], // has_print false, is_purchasable true
      releaseDate: { year: 2026, month: 8, day: 18 },
    });
  });
});

describe("per-format snapshots", () => {
  it("splits one item into one snapshot per format with distinct identities", () => {
    const item = parseCalendar(CALENDAR)[0]!;
    const snapshots = toSnapshots(item);
    expect(snapshots.map((s) => s.format)).toEqual(["physical", "digital"]);
    expect(sourceRecordId(item, "physical")).toBe(
      "welcome-to-demon-school-iruma-kun/volume-21#physical",
    );
    expect(sourceRecordId(item, "digital")).not.toBe(sourceRecordId(item, "physical"));
    expect(snapshots[0]!.title).toBe("Welcome to Demon School! Iruma-kun Volume 21");
  });
});

describe("series pages that are packaging lines", () => {
  const item = (seriesName: string, slug: string, title = "Volume 4") =>
    parseCalendar({
      data: [
        {
          tue_key: "2026-08-04",
          items: [
            {
              title,
              series_name: seriesName,
              creators: "By Muneyuki Kaneshiro",
              volume_url: `https://kodansha.us/series/${slug}/volume-4/`,
              formats: ["print"],
            },
          ],
        },
      ],
    })[0];

  it("keeps the base series and turns the volume into a line position", () => {
    const omnibus = item("Blue Lock Omnibus", "blue-lock-omnibus");
    expect(omnibus?.volumeLabel).toBeUndefined();
    expect(omnibus).toMatchObject({
      seriesName: "Blue Lock Omnibus",
      seriesTitle: "Blue Lock",
      packaging: { lineName: "Omnibus", linePosition: "4", coverRange: null },
    });
    expect(item("MARS 30th Anniversary Edition", "mars-30th")?.seriesTitle).toBe("MARS");
    const snapshot = toSnapshots(item("Blue Lock Omnibus", "blue-lock-omnibus")!)[0]!;
    expect(snapshot).toMatchObject({
      title: "Blue Lock Omnibus Volume 4",
      seriesTitle: "Blue Lock",
      packaging: { linePosition: "4" },
    });
  });

  it("drops the (Manga) discriminator and marks novels out of scope", () => {
    expect(item("Am I Actually the Strongest? (Manga)", "am-i")?.seriesTitle).toBe(
      "Am I Actually the Strongest?",
    );
    expect(item("Witch Hat Atelier: Grimoire Edition", "grimoire")?.seriesTitle).toBe(
      "Witch Hat Atelier: Grimoire Edition",
    );
    expect(item("The Seven Deadly Sins (Novel)", "sds-novel")?.outOfScope).toBe("novel");
    expect(item("Blue Lock", "blue-lock")?.outOfScope).toBeUndefined();
  });

  it("marks children's picture books out of scope, carried onto every snapshot", () => {
    const picture = item("Cells at Work! Picture Book", "cells-at-work-picture-book")!;
    expect(picture.outOfScope).toBe("childrensBook");
    expect(toSnapshots(picture).map((s) => s.outOfScope)).toEqual(["childrensBook"]);
  });
});

describe("parseSeriesName — Kodansha's own packaging names", () => {
  it("maps Kodansha-only line names onto the base Series", () => {
    expect(parseSeriesName("Ajin: Demi-Human Complete")).toEqual({
      seriesTitle: "Ajin: Demi-Human",
      packaging: { lineName: "Complete", linePosition: null, coverRange: null },
      isNovel: false,
    });
    expect(parseSeriesName("The Flowers of Evil - Complete").seriesTitle).toBe(
      "The Flowers of Evil",
    );
    expect(parseSeriesName("Parasyte Full Color Collection").packaging?.lineName).toBe(
      "Full Color Collection",
    );
    expect(parseSeriesName("Blue Lock Omnibus")).toMatchObject({
      seriesTitle: "Blue Lock",
      packaging: { lineName: "Omnibus" },
    });
  });

  it("keeps numbers in a series name and drops the webtoon (Print) tag", () => {
    expect(parseSeriesName("Beast #6")).toMatchObject({
      seriesTitle: "Beast #6",
      packaging: null,
    });
    expect(parseSeriesName("She's My Knight (Print)")).toMatchObject({
      seriesTitle: "She's My Knight",
      packaging: null,
    });
    expect(parseSeriesName("Magic Knight Rayearth 2").seriesTitle).toBe("Magic Knight Rayearth 2");
  });
});

describe("backlist: search-series listing", () => {
  it("keeps comic series with their update stamps and drops novels", () => {
    const page = parseSeriesListing(JSON.parse(fixture("search-series.json")));
    expect(page.pageLength).toBe(4);
    expect(page.total).toBe(1170);
    expect(page.entries).toEqual([
      {
        slug: "10-dance",
        name: "10 DANCE",
        lastUpdatedAt: "2026-04-08T03:42:28+00:00",
      },
      {
        slug: "5-centimeters-per-second-collectors-edition",
        name: "5 Centimeters per Second (Collector's Edition)",
        lastUpdatedAt: "2026-02-06T09:53:10+00:00",
      },
      {
        slug: "7-billion-needles",
        name: "7 Billion Needles",
        lastUpdatedAt: "2026-02-06T09:53:11+00:00",
      },
    ]);
    expect(() => parseSeriesListing({ success: false })).toThrow();
  });
});

describe("backlist: series pages", () => {
  it("lists volume pages from JSON-LD hasPart, in volume order", () => {
    expect(parseSeriesPage(fixture("series-7-billion-needles.html"), "7-billion-needles")).toEqual([
      "volume-1",
      "volume-2",
      "volume-3",
      "volume-4",
    ]);
  });

  it("falls back to the page's own links when hasPart is absent (packaging pages)", () => {
    // The live page also links the base series, sibling lines, and
    // where-to-buy subpages — none are volume pages of this series.
    expect(parseSeriesPage(fixture("series-blue-lock-omnibus.html"), "blue-lock-omnibus")).toEqual([
      "volume-1",
      "volume-2",
      "volume-3",
      "volume-4",
      "volume-5",
    ]);
  });
});

describe("backlist: volume pages", () => {
  it("reads one offer per format with its own ISBN, date, and price", () => {
    const url = "https://kodansha.us/series/blue-lock/volume-1/";
    const page = parseVolumePage(fixture("blue-lock-volume-1.html"), url)!;
    expect(page.title).toBe("Blue Lock Volume 1");
    expect(page.item).toMatchObject({
      seriesName: "Blue Lock",
      seriesTitle: "Blue Lock",
      seriesSlug: "blue-lock",
      volumeSlug: "volume-1",
      volumeLabel: "1",
      creators: ["Muneyuki Kaneshiro"],
      formats: ["digital", "physical"],
      coverUrl: "https://production.image.azuki.co/a5dd87dd-6148-4cf3-917b-2f54a576854c/800.webp",
    });
    expect(page.offers).toEqual([
      {
        format: "digital",
        isbn13: "9781636990033",
        releaseDate: { year: 2021, month: 3, day: 16 },
        priceCents: 399,
      },
      {
        format: "physical",
        binding: "paperback",
        isbn13: "9781646516544",
        releaseDate: { year: 2022, month: 6, day: 21 },
        priceCents: 1299,
      },
    ]);

    const snapshots = toBacklistSnapshots(page);
    expect(snapshots.map((s) => s.sourceRecordId)).toEqual([
      "blue-lock/volume-1#digital",
      "blue-lock/volume-1#physical",
    ]);
    // The identities are the calendar's, so both feeds share one observation.
    expect(snapshots[1]!.sourceRecordId).toBe(sourceRecordId(page.item, "physical"));
    expect(snapshots[1]!.snapshot).toMatchObject({
      kind: "kodanshaVolume",
      title: "Blue Lock Volume 1",
      seriesTitle: "Blue Lock",
      seriesUrl: "https://kodansha.us/series/blue-lock/",
      volumeLabel: "1",
      format: "physical",
      binding: "paperback",
      isbn13: "9781646516544",
      priceCents: 1299,
      releaseDate: { year: 2022, month: 6, day: 21 },
    });
  });

  it("keeps a packaging line's volume on its base Series as a line position", () => {
    const url = "https://kodansha.us/series/blue-lock-omnibus/volume-1/";
    const page = parseVolumePage(fixture("blue-lock-omnibus-volume-1.html"), url)!;
    expect(page.item.volumeLabel).toBeUndefined();
    expect(page.item).toMatchObject({
      seriesTitle: "Blue Lock",
      packaging: { lineName: "Omnibus", linePosition: "1", coverRange: null },
    });
    expect(page.offers).toEqual([
      expect.objectContaining({ format: "physical", isbn13: "9798888778210" }),
    ]);
  });

  it("reads Kodansha's volume-0 oneshots without a volume label", () => {
    const mermaid = parseVolumePage(
      fixture("mermaid-prince-volume-0.html"),
      "https://kodansha.us/series/mermaid-prince/volume-0/",
    )!;
    expect(mermaid.item).toMatchObject({
      seriesTitle: "Mermaid Prince",
      volumeLabel: undefined,
    });
    expect(mermaid.offers.map((o) => o.isbn13)).toEqual(["9781647293628", "9781647293611"]);
    const collectors = parseVolumePage(
      fixture("5-centimeters-collectors-edition-volume-0.html"),
      "https://kodansha.us/series/5-centimeters-per-second-collectors-edition/volume-0/",
    )!;
    expect(collectors.item).toMatchObject({
      seriesTitle: "5 Centimeters per Second",
      packaging: { lineName: "Collector's Edition", linePosition: null },
    });
    expect(toBacklistSnapshots(collectors)[0]!.snapshot.title).toBe(
      "5 Centimeters per Second (Collector's Edition)",
    );
  });

  it("keys a second same-format ISBN on its ISBN, and skips unusable offers", () => {
    const html = fixture("blue-lock-volume-1.html").replace(
      '"workExample": [',
      `"workExample": [
        { "@type": "Book", "bookFormat": "https://schema.org/Hardcover", "isbn": "9781646516544" },
        { "@type": "Book", "bookFormat": "https://schema.org/AudiobookFormat", "isbn": "9781636990040" },
        { "@type": "Book", "bookFormat": "https://schema.org/Hardcover", "isbn": "9781636990041" },
        { "@type": "Book", "bookFormat": "https://schema.org/Hardcover", "isbn": "9780316473996", "datePublished": "2020-01-01" },`,
    );
    const page = parseVolumePage(html, "https://kodansha.us/series/blue-lock/volume-1/")!;
    // Audiobooks, bad check digits, and repeated ISBNs are dropped.
    expect(page.offers.map((o) => `${o.binding}:${o.isbn13}`)).toEqual([
      "hardcover:9781646516544",
      "hardcover:9780316473996",
      "undefined:9781636990033",
    ]);
    expect(toBacklistSnapshots(page).map((s) => s.sourceRecordId)).toEqual([
      "blue-lock/volume-1#physical",
      "blue-lock/volume-1#physical:9780316473996",
      "blue-lock/volume-1#digital",
    ]);
  });

  it("returns null without a JSON-LD Book, and marks out-of-scope books", () => {
    expect(
      parseVolumePage("<html><title>x</title></html>", "https://kodansha.us/series/x/volume-1/"),
    ).toBeNull();
    const novel = fixture("blue-lock-volume-1.html").replace(
      '"name": "Blue Lock Volume 1"',
      '"name": "Blue Lock (Novel) Volume 1"',
    );
    const page = parseVolumePage(novel, "https://kodansha.us/series/blue-lock/volume-1/")!;
    expect(page.item.outOfScope).toBe("novel");
    expect(toBacklistSnapshots(page).every((s) => s.snapshot.outOfScope === "novel")).toBe(true);
  });
});

describe("backlist: crawl state", () => {
  const now = Date.UTC(2026, 8, 25);
  const state = (over: Partial<SeriesCrawl> = {}): SeriesCrawl => ({
    kind: "kodanshaSeriesCrawl",
    name: "Blue Lock",
    url: "https://kodansha.us/series/blue-lock/",
    lastUpdatedAt: "2026-09-01T00:00:00+00:00",
    volumes: ["volume-1", "volume-2", "volume-40"],
    recheck: ["volume-40"],
    ...over,
  });
  const entry = { lastUpdatedAt: "2026-09-01T00:00:00+00:00" };

  it("crawls new, re-stamped, and stale series whole; re-checks moving ones weekly", () => {
    expect(crawlMode(entry, null, now)).toBe("full");
    expect(
      crawlMode(
        { lastUpdatedAt: "2026-09-20T00:00:00+00:00" },
        { snapshot: state(), crawledAt: now - 1000 },
        now,
      ),
    ).toBe("full");
    expect(crawlMode(entry, { snapshot: state(), crawledAt: now - FULL_REFRESH_MS - 1 }, now)).toBe(
      "full",
    );
    expect(crawlMode(entry, { snapshot: state(), crawledAt: now - RECHECK_MS - 1 }, now)).toBe(
      "recheck",
    );
    expect(crawlMode(entry, { snapshot: state(), crawledAt: now - 1000 }, now)).toBeNull();
    expect(
      crawlMode(entry, { snapshot: state({ recheck: [] }), crawledAt: now - RECHECK_MS - 1 }, now),
    ).toBeNull();
  });

  it("does not postpone the full refresh when a weekly recheck just ran", () => {
    expect(
      crawlMode(
        entry,
        {
          snapshot: state({ fullCrawledAt: now - FULL_REFRESH_MS - 1 }),
          crawledAt: now - 1000,
        },
        now,
      ),
    ).toBe("full");
  });

  it("re-checks only moving and new volume pages", () => {
    const current = ["volume-1", "volume-2", "volume-40", "volume-41"];
    expect(volumesToFetch("recheck", state(), current)).toEqual(["volume-40", "volume-41"]);
    expect(volumesToFetch("full", state(), current)).toEqual(current);
    expect(volumesToFetch("recheck", null, current)).toEqual(current);
  });

  it("marks upcoming, recent, and undated volumes as still moving", () => {
    const upcoming = parseVolumePage(
      fixture("blue-lock-volume-40.html"),
      "https://kodansha.us/series/blue-lock/volume-40/",
    )!;
    expect(upcoming.offers[0]!.releaseDate).toEqual({
      year: 2026,
      month: 11,
      day: 24,
    });
    expect(needsRecheck(upcoming.offers, now)).toBe(true);
    const old = parseVolumePage(
      fixture("blue-lock-volume-1.html"),
      "https://kodansha.us/series/blue-lock/volume-1/",
    )!;
    expect(needsRecheck(old.offers, now)).toBe(false);
    expect(needsRecheck([{ format: "digital", isbn13: "9781636990033" }], now)).toBe(true);
    expect(needsRecheck([], now)).toBe(true);
  });
});
