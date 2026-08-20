// Polite HTTP plumbing shared by every import adapter (spec §6): a common
// User-Agent that identifies MangaDB and invites corrections, a pre-request
// pause per source etiquette (ANN's 1 req/s, WordPress-friendly ~3 req/s for
// the publisher APIs), and exponential backoff within a run.

export const USER_AGENT =
  "MangaDB importer (+https://mangadb.org; data corrections welcome)";

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Polite fetch: pause first, then up to 3 attempts with exponential backoff. */
export async function politeFetch(
  url: string,
  delayMs: number,
): Promise<Response> {
  await sleep(delayMs);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      // Client errors won't heal on retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
