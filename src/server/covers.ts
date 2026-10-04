// Cover art for Releases with an ISBN-13, served from our own domain
// (`/covers/{isbn13}.jpg`) so the shelves never depend on a third party at
// render time; Convex file storage holds only publisher-served art
// (Kodansha, Seven Seas), fetched once per Edition and image URL.
//
// Flow: edge cache → R2 bucket → upstream fetch; R2 and cache writes finish
// in the background, and a storage failure only costs the copy, never the
// art. The first upstream is the distribution CDN Penguin Random House runs
// for the publishers it carries, which is most English manga; it answers any
// ISBN-13 it knows with the jacket art and unknown ones with a stand-in.
// Where it has nothing (older Tokyopop and VIZ backlist, much of Yen Press,
// many ebook ISBNs) the OpenLibrary Covers API is asked next. No art from
// either is "no cover", remembered for a day; the app draws its cloth
// placeholder for those (see ~/lib/cover.tsx). An upstream that is down,
// refusing us (OpenLibrary answers 403 past ~100 ISBN lookups per 5 minutes
// per IP), or cut off or stalled mid-download makes it a five-minute miss
// instead, so a burst of lookups never hides art for a day. Spec §6: covers
// are stored under industry-standard tolerance with the takedown contact on
// /about-the-data.
//
// A stored jacket is checked against its upstreams again once 90 days have
// passed since they were last asked (R2 metadata `fetchedAt`, or `checkedAt`
// when a check kept the copy). The copy is still served, for an hour at a
// time, while the check runs in the background: real art replaces it, and a
// miss or a stand-in keeps it and only records the check. An outage records
// nothing, so the copy stays due and the first request after its hour asks
// again. No response is cached past the moment its copy falls due, but a
// browser or edge copy taken before a replacement is served until its
// lifetime ends, so a corrected jacket takes up to an hour after its check
// to show, and up to 90 days to be noticed upstream at all.
//
// Measured on a stratified sample of the catalog's ISBNs (docs/decisions.md,
// "Cover art sources"): PRH ≈86%, OpenLibrary ≈8.5% more, ≈5% nowhere.
import { env, waitUntil } from "cloudflare:workers";

import type { CoverShelf } from "~/lib/homeShelves";
import { readEdgeCache } from "~/server/edgeCache";

const COVER_PATH = /^\/covers\/(97[89]\d{10})\.jpg$/;
const ISBN13 = /^97[89]\d{10}$/;
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
/** A stored jacket is checked against its upstreams again after this long. */
const REFRESH_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Lifetime of a copy served while its check is due, so the result shows soon. */
const STALE_TTL = 60 * 60;
/** Checks running at once per isolate; a stale copy beyond it waits for a later request. */
const REFRESH_LIMIT = 4;
/** An upstream that has not delivered its jacket by then couldn't answer. */
const UPSTREAM_TIMEOUT_MS = 10_000;
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
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await readEdgeCache(cacheKey, "covers: edge cache read failed");
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Cover-Cache", "hit");
    return hit;
  }

  const response = await lookup(isbn13);
  inBackground("edge cache write", cache.put(cacheKey, response.clone()));
  return response;
}

/**
 * Let a cache or R2 write finish after the response is sent. A failed write
 * is logged, never allowed to cost the visitor art we already have.
 */
function inBackground(label: string, work: Promise<unknown>): void {
  waitUntil(work.catch((error: unknown) => console.error(`covers: ${label} failed`, error)));
}

type StoredCover = {
  bytes: ArrayBuffer;
  etag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};
type Jacket = { bytes: ArrayBuffer; contentType: string; source: string };

/** R2's copy of a cover, or null when absent or the bucket can't be read. */
async function storedCover(
  bucket: NonNullable<typeof env.COVERS>,
  key: string,
): Promise<StoredCover | null> {
  try {
    const stored = await bucket.get(key);
    if (!stored) return null;
    const { etag, httpMetadata, customMetadata } = stored;
    return { bytes: await stored.arrayBuffer(), etag, httpMetadata, customMetadata };
  } catch (error) {
    console.error("covers: R2 read failed", error);
    return null;
  }
}

async function lookup(isbn13: string): Promise<Response> {
  const bucket = env.COVERS;
  const key = `${isbn13}.jpg`;

  const stored = bucket && (await storedCover(bucket, key));
  if (stored) {
    const contentType = stored.httpMetadata?.contentType ?? "image/jpeg";
    const fresh = lastChecked(stored.customMetadata) + REFRESH_AGE_MS - Date.now();
    if (fresh > 0) {
      // Never cached past the moment its check falls due.
      return coverOk(stored.bytes, contentType, "r2", Math.min(HIT_TTL, Math.ceil(fresh / 1000)));
    }
    refreshInBackground(bucket, isbn13, stored);
    return coverOk(stored.bytes, contentType, "r2", STALE_TTL);
  }

  const found = await firstJacket(isbn13, UPSTREAMS);
  // An upstream that couldn't answer might have had the art: a short-lived
  // miss, not a remembered one.
  if (found === "unavailable") {
    return new Response("Cover source unavailable", {
      status: 503,
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
  if (!found) return coverMissing();
  if (bucket) inBackground("R2 write", storeJacket(bucket, key, found));
  return coverOk(found.bytes, found.contentType, "upstream", HIT_TTL);
}

/**
 * When a stored jacket's upstreams were last asked: the later of `fetchedAt`
 * (its bytes arrived) and `checkedAt` (a check kept them). 0 when neither
 * is readable, so an object without them is due at once.
 */
function lastChecked(metadata: Record<string, string> | undefined): number {
  const times = [metadata?.fetchedAt, metadata?.checkedAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((time) => !Number.isNaN(time));
  return Math.max(0, ...times);
}

/**
 * The first real jacket among `sources`, in order: null when none has art,
 * "unavailable" when none has art and one of them couldn't say.
 */
async function firstJacket(
  isbn13: string,
  sources: ReadonlyArray<(isbn13: string) => string>,
): Promise<Jacket | null | "unavailable"> {
  let unavailable = false;
  for (const source of sources) {
    const url = source(isbn13);
    const found = await fetchJacket(url);
    if (found === "unavailable") unavailable = true;
    else if (found) return { ...found, source: url };
  }
  return unavailable ? "unavailable" : null;
}

/** Store `jacket` under `key`; with `onlyIf`, only over the object that etag names. */
function storeJacket(
  bucket: NonNullable<typeof env.COVERS>,
  key: string,
  jacket: Jacket,
  onlyIf?: { etagMatches: string },
) {
  return bucket.put(key, jacket.bytes, {
    httpMetadata: { contentType: jacket.contentType },
    customMetadata: { source: jacket.source, fetchedAt: new Date().toISOString() },
    onlyIf,
  });
}

/** ISBNs whose stored jacket this isolate is checking now. */
const refreshing = new Set<string>();

/**
 * Check a stored jacket against its upstreams after the response is sent, at
 * most one check per ISBN and `REFRESH_LIMIT` in all per isolate. Only
 * upstreams ranked at or above the one the copy came from are asked, so a
 * passing outage at the first never trades its art for a lesser source's,
 * and art from the first never costs an OpenLibrary lookup.
 */
function refreshInBackground(
  bucket: NonNullable<typeof env.COVERS>,
  isbn13: string,
  stored: StoredCover,
): void {
  if (refreshing.has(isbn13) || refreshing.size >= REFRESH_LIMIT) return;
  refreshing.add(isbn13);
  inBackground("refresh", refresh(bucket, isbn13, stored).finally(() => refreshing.delete(isbn13)));
}

async function refresh(
  bucket: NonNullable<typeof env.COVERS>,
  isbn13: string,
  stored: StoredCover,
): Promise<void> {
  const key = `${isbn13}.jpg`;
  const rank = UPSTREAMS.findIndex((source) => source(isbn13) === stored.customMetadata?.source);
  const found = await firstJacket(isbn13, rank < 0 ? UPSTREAMS : UPSTREAMS.slice(0, rank + 1));
  // Nobody looked: the copy stays due, asked about again after its hour.
  if (found === "unavailable") return;
  // Either write lands only on the object this check read: a jacket another
  // isolate stored meanwhile was checked at least as recently, and is kept.
  // R2's etag for a single-part upload derives from its bytes, so the
  // condition tells different jackets apart.
  const onlyIf = { etagMatches: stored.etag };
  if (found) {
    await storeJacket(bucket, key, found, onlyIf);
    return;
  }
  // No art upstream is no evidence against the stored copy: keep it, and
  // record the check so it is not repeated on every request.
  await bucket.put(key, stored.bytes, {
    httpMetadata: stored.httpMetadata,
    customMetadata: { ...stored.customMetadata, checkedAt: new Date().toISOString() },
    onlyIf,
  });
}

/**
 * One upstream's jacket for a URL: the image, null when it has no real art
 * (404, non-image, a tiny or known stand-in), or "unavailable" when it
 * couldn't say (network error or a body cut off mid-read, rate limit,
 * server error, or no complete answer within UPSTREAM_TIMEOUT_MS).
 */
async function fetchJacket(
  url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null | "unavailable"> {
  let upstream: Response;
  try {
    // The signal also aborts the body read below, so a download that
    // stalls midway fails it too.
    upstream = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return "unavailable";
  }
  if (upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
    return "unavailable";
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) return null;
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch {
    return "unavailable";
  }
  if (bytes.byteLength < MIN_COVER_BYTES) return null;
  if (PLACEHOLDER_SHA256.has(await sha256Hex(bytes))) return null;
  return { bytes, contentType };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A jacket response; `maxAge` (seconds) is both the browser's and the edge cache's lifetime. */
function coverOk(bytes: ArrayBuffer, contentType: string, origin: string, maxAge: number): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${maxAge}`,
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

// ---------- which jackets we hold ----------

// A shelf that shows art only (the home page, lib/homeShelves.ts) has to
// know before it renders which of its books have a real jacket. R2 is that
// record: only real art is ever stored there, so an object under an ISBN
// means a jacket and its absence means cloth (or art nobody has asked for
// yet, which the warm-up below goes and gets).

/** Asked-about shelves and seats per call; the home page uses 4 and 15. */
const MAX_SHELVES = 8;
const MAX_SEATS = 30;
const MAX_CANDIDATES = 120;
/** Absent jackets fetched in the background per call, so upstreams see a trickle. */
const WARM_LIMIT = 8;
/** A stored jacket stays stored; an absent one may arrive within minutes. */
const ON_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const ABSENT_TTL_MS = 5 * 60 * 1000;
const MEMO_MAX = 20_000;

/** What this isolate last learned per ISBN, so a warm one rarely asks R2. */
const onFileMemo = new Map<string, { onFile: boolean; expires: number }>();

/** Whether R2 holds a jacket for `isbn13`; a failed read is "no", unremembered. */
async function jacketOnFile(
  bucket: NonNullable<typeof env.COVERS>,
  isbn13: string,
): Promise<boolean> {
  const now = Date.now();
  const known = onFileMemo.get(isbn13);
  if (known && known.expires > now) return known.onFile;
  let onFile: boolean;
  try {
    onFile = (await bucket.head(`${isbn13}.jpg`)) !== null;
  } catch (error) {
    console.error("covers: R2 head failed", error);
    return false;
  }
  if (onFileMemo.size >= MEMO_MAX) onFileMemo.clear();
  onFileMemo.set(isbn13, { onFile, expires: now + (onFile ? ON_FILE_TTL_MS : ABSENT_TTL_MS) });
  return onFile;
}

/**
 * The ISBNs among `shelves`' candidates whose jacket we hold, or null when
 * no bucket is bound and nothing can be said. Each shelf is walked in order
 * only until its seats are filled (a null candidate already shows publisher
 * art and takes a seat), so a full shelf costs about one R2 read per seat.
 * Jackets found absent are requested through `coverResponse` in the
 * background, a few per call: one that exists upstream is stored for the
 * next visitor, and a real miss is remembered at the edge for a day.
 *
 * Input comes from the client on navigations, so it is bounded and every
 * candidate is checked to be an ISBN-13 before it becomes an R2 key.
 */
export async function coversOnFile(
  shelves: ReadonlyArray<CoverShelf>,
  origin: string,
): Promise<Array<string> | null> {
  const bucket = env.COVERS;
  if (!bucket) return null;
  const onFile = new Set<string>();
  const absent = new Set<string>();
  await Promise.all(
    shelves.slice(0, MAX_SHELVES).map(async ({ need, candidates }) => {
      const seats = Math.min(MAX_SEATS, Math.max(0, Math.floor(need)));
      const asked = candidates
        .slice(0, MAX_CANDIDATES)
        .filter((isbn) => isbn === null || ISBN13.test(isbn));
      let seated = 0;
      let next = 0;
      while (seated < seats && next < asked.length) {
        // Never more reads at once than seats still empty.
        const round = asked.slice(next, next + (seats - seated));
        next += round.length;
        const held = await Promise.all(
          round.map((isbn) => (isbn === null ? true : jacketOnFile(bucket, isbn))),
        );
        round.forEach((isbn, index) => {
          if (held[index]) seated++;
          if (isbn !== null) (held[index] ? onFile : absent).add(isbn);
        });
      }
    }),
  );
  for (const isbn13 of [...absent].slice(0, WARM_LIMIT)) {
    inBackground(
      "jacket warm-up",
      // The art itself is not wanted here, only the lookup's side effects
      // (R2 and the edge cache). Not awaited: the body is teed for the cache
      // write, and a tee's cancel settles only once both halves are done.
      coverResponse(new Request(`${origin}/covers/${isbn13}.jpg`)).then((response) => {
        void response?.body?.cancel();
      }),
    );
  }
  return [...onFile];
}
