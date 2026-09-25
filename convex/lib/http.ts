// Polite HTTP plumbing shared by every import adapter (spec §6): a common
// User-Agent that identifies MangaDB and invites corrections, a pre-request
// pause per source etiquette (ANN's 1 req/s, WordPress-friendly ~3 req/s for
// the publisher APIs), and backoff within a run that honours rate limits.

export const USER_AGENT =
  "MangaDB importer (+https://mangadb.org; data corrections welcome)";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Attempts per request: rate limits and dropped connections get a few more. */
const MAX_ATTEMPTS = 5;
/** Longest single wait, so a retried request still fits in one import action. */
const MAX_BACKOFF_MS = 60_000;

/** Server-asked wait from a 429/503 `Retry-After` (seconds or HTTP date). */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : at - Date.now();
}

/**
 * Polite fetch: pause first, then up to five attempts with exponential
 * backoff. Rate limiting (429, and 503 with Retry-After) waits as long as the
 * server asks, up to a minute; other client errors won't heal and fail at
 * once. The body is read inside the loop, so a connection dropped mid-body is
 * retried too; the returned Response is fully buffered.
 */
export async function politeFetch(
  url: string,
  delayMs: number,
): Promise<Response> {
  await sleep(delayMs);
  let lastError: unknown;
  let wait = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(Math.min(MAX_BACKOFF_MS, Math.max(wait, 2000 * 2 ** attempt)));
    wait = 0;
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) {
        const body = await res.arrayBuffer();
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      const rateLimited = res.status === 429 || (res.status === 503 && res.headers.has("retry-after"));
      if (rateLimited) {
        wait = retryAfterMs(res) ?? 0;
        continue;
      }
      // Other client errors won't heal on retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
