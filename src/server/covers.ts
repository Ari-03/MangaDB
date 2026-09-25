// Cover art for Releases with an ISBN-13, served from our own domain
// (`/covers/{isbn13}.jpg`) so the shelves never depend on a third party at
// render time and Convex file storage carries no images at all.
//
// Flow: edge cache → R2 bucket → upstream fetch. The first upstream is the
// distribution CDN Penguin Random House runs for the publishers it carries,
// which is most English manga; it answers any ISBN-13 it knows with the
// jacket art and unknown ones with a stand-in. Where it has nothing (older
// Tokyopop and VIZ backlist, much of Yen Press, many ebook ISBNs) the
// OpenLibrary Covers API is asked next. No art from either is "no cover",
// remembered for a day; the app draws its cloth placeholder for those (see
// ~/lib/cover.tsx). An upstream
// that is down or refusing us (OpenLibrary answers 403 past ~100 ISBN
// lookups per 5 minutes per IP) makes it a five-minute miss instead, so a
// burst of lookups never hides art for a day. Spec §6: covers are stored under
// industry-standard tolerance with the takedown contact on /about-the-data.
//
// Measured on a stratified sample of the catalog's ISBNs (README "Cover
// art"): PRH ≈86%, OpenLibrary ≈8.5% more, ≈5% nowhere.
import { env } from "cloudflare:workers";

const COVER_PATH = /^\/covers\/(97[89]\d{10})\.jpg$/;
/** Upstreams in order of preference; each maps an ISBN-13 to a jacket URL. */
const UPSTREAMS: ReadonlyArray<(isbn13: string) => string> = [
  (isbn13) => `https://images.penguinrandomhouse.com/cover/${isbn13}`,
  // `default=false` makes a miss a 404 instead of a blank image.
  (isbn13) => `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false`,
];
// Stand-ins (PRH's "no image available" is ~2.3 KB) are tiny; real jackets are 20 KB+.
const MIN_COVER_BYTES = 5000;
// Its "coming soon" cards for unannounced books are fixed JPEGs (two styles
// seen so far); we recognise them by hash so those books stay cloth until
// real art exists.
const PLACEHOLDER_SHA256 = new Set([
  "6fcf7ec371385bdb11d7dec2a49f0bcf6777dba4bf7ca5ee38359659f7bf1af3", // "Cover Coming Soon" card
  "ad57672ff95addb88dfbb030720b9b67013b996752ee23276a44779514da9c24", // grey "Coming Soon" tile
]);
const HIT_TTL = 60 * 60 * 24 * 30; // a jacket rarely changes
const MISS_TTL = 60 * 60 * 24; // recheck missing art daily
const USER_AGENT = "MangaDB/1.0 (+https://mangadb.org/about-the-data)";

/**
 * Handles `/covers/{isbn13}.jpg`; returns null for every other request so the
 * Worker entry can fall through to the app.
 */
export async function coverResponse(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const match = COVER_PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const isbn13 = match[1]!;

  // Edge cache first. Keyed on the bare path so query strings can't bust it.
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Cover-Cache", "hit");
    return hit;
  }

  const response = await lookup(isbn13);
  await cache.put(cacheKey, response.clone());
  return response;
}

async function lookup(isbn13: string): Promise<Response> {
  const bucket = env.COVERS;
  const key = `${isbn13}.jpg`;

  if (bucket) {
    const stored = await bucket.get(key);
    if (stored) {
      return coverOk(
        await stored.arrayBuffer(),
        stored.httpMetadata?.contentType ?? "image/jpeg",
        "r2",
      );
    }
  }

  let unavailable = false;
  for (const source of UPSTREAMS) {
    const found = await fetchJacket(source(isbn13));
    if (found === "unavailable") unavailable = true;
    if (!found || found === "unavailable") continue;
    if (bucket) {
      await bucket.put(key, found.bytes, {
        httpMetadata: { contentType: found.contentType },
        customMetadata: { source: source(isbn13), fetchedAt: new Date().toISOString() },
      });
    }
    return coverOk(found.bytes, found.contentType, "upstream");
  }
  // An upstream that couldn't answer might have had the art: a short-lived
  // miss, not a remembered one.
  if (unavailable) {
    return new Response("Cover source unavailable", {
      status: 503,
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
  return coverMissing();
}

/**
 * One upstream's jacket for a URL: the image, null when it has no real art
 * (404, non-image, a tiny or known stand-in), or "unavailable" when it
 * couldn't say (network error, rate limit, server error).
 */
async function fetchJacket(
  url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null | "unavailable"> {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
    });
  } catch {
    return "unavailable";
  }
  if (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
    return "unavailable";
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) return null;
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength < MIN_COVER_BYTES) return null;
  if (PLACEHOLDER_SHA256.has(await sha256Hex(bytes))) return null;
  return { bytes, contentType };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function coverOk(bytes: ArrayBuffer, contentType: string, origin: string): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${HIT_TTL}`,
      "X-Cover-Origin": origin,
    },
  });
}

function coverMissing(): Response {
  return new Response("No cover on file", {
    status: 404,
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": `public, max-age=${MISS_TTL}`,
    },
  });
}
