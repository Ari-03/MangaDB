// Import-test fixtures shared by more than one suite: a stubbed Seven Seas
// site serving fixture books in the live wire shapes (the listing JSON, the
// book page, cover art), used by sevenSeas.test.ts and reconcile.test.ts.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import { vi } from "vitest";

import { MIN_COVER_BYTES } from "./lib/covers";

export const SEVEN_SEAS = "https://sevenseasentertainment.com";

/** One Seven Seas book as the fixture site serves it. */
export type FixtureBook = {
  id: number;
  slug: string;
  title: string;
  modified?: string;
  seriesSlug?: string;
  seriesTitle?: string;
  date?: string;
  price?: string;
  category?: string;
  isbn?: string;
  cover?: boolean;
  /** The cover's file under uploads/covers (default `{slug}.jpg`); an .svg is a placeholder. */
  coverFile?: string;
  /** The listing's `content.rendered` blurb HTML. */
  blurb?: string;
};

/** The book's page (`/books/{slug}/`): cover, series link, credits, date, price, format, ISBN. */
export function bookPageHtml(b: FixtureBook): string {
  const file = b.coverFile ?? `${b.slug}.jpg`;
  const cover =
    b.cover === false
      ? ""
      : `<img src="${SEVEN_SEAS}/wp-content/uploads/covers/${file}" title="${b.title}" alt="${b.title}">`;
  const series = b.seriesSlug
    ? `<b>Series: </b><span> <a href="${SEVEN_SEAS}/series/${b.seriesSlug}/">${b.seriesTitle ?? b.title}</a></span>`
    : "";
  return `<html><body><div id="volume-module">${cover}</div><div id="volume-meta"> ${series}<p><b>Story & Art by:</b> <span class="creator"><a href="${SEVEN_SEAS}/creator/someone/">Someone</a></span></p>${
    b.date ? `<p><b>Release Date:</b> ${b.date}</p>` : ""
  }${b.price ? `<p><b>Price:</b> ${b.price}</p>` : ""}<p><b>Format:</b> ${
    b.category ?? "Manga"
  }</p>${b.isbn ? `<p><b>ISBN:</b> ${b.isbn}</p>` : ""}</div></body></html>`;
}

/** One book's item in the listing (`wp-json/wp/v2/books`) wire shape. */
export function listingItem(b: FixtureBook) {
  return {
    id: b.id,
    status: "publish",
    slug: b.slug,
    link: `${SEVEN_SEAS}/books/${b.slug}/`,
    title: { rendered: b.title },
    modified_gmt: b.modified ?? "2026-08-01T00:00:00",
    content: { rendered: b.blurb ?? "" },
  };
}

/** Cover-image URLs the stubbed site served; a suite clears it after each test. */
export const imageRequests: string[] = [];

/**
 * Stub global fetch with a fixture site serving `books`: a one-page
 * listing, each book's page, and cover art (a real-sized JPEG, or an SVG
 * placeholder for an .svg file).
 */
export function stubSite(books: FixtureBook[]) {
  const listing = books.map(listingItem);
  const pages = new Map(books.map((b) => [`${SEVEN_SEAS}/books/${b.slug}/`, bookPageHtml(b)]));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.startsWith(`${SEVEN_SEAS}/wp-json/wp/v2/books`)) {
      return new Response(JSON.stringify(listing), {
        headers: {
          "x-wp-totalpages": books.length === 0 ? "0" : "1",
          "content-type": "application/json",
        },
      });
    }
    const page = pages.get(url);
    if (page !== undefined) {
      return new Response(page, { headers: { "content-type": "text/html" } });
    }
    if (url.includes("/wp-content/uploads/")) {
      imageRequests.push(url);
      return url.endsWith(".svg")
        ? new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
            headers: { "content-type": "image/svg+xml" },
          })
        : new Response(new Blob([new Uint8Array(MIN_COVER_BYTES + 1).fill(0xff)]), {
            headers: { "content-type": "image/jpeg" },
          });
    }
    return new Response("not found", { status: 404 });
  });
}

/** Volume 1 of the "Alpha Adventures (Manga)" series, with a listing blurb. */
export const ALPHA_1: FixtureBook = {
  id: 101,
  slug: "alpha-manga-vol-1",
  title: "Alpha Adventures (Manga) Vol. 1",
  modified: "2026-08-01T00:00:00",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "January 6, 2026",
  price: "$14.99",
  isbn: "978-1-9990001-0-3",
  blurb: "<p>Alpha&#8217;s <em>first</em>\n adventure.</p>\n",
};
