/**
 * Look `key` up in the Worker's edge cache. A failed read is logged with
 * `failure` and counts as a miss: the cache may cost a regeneration, never
 * the response.
 */
export function readEdgeCache(key: Request, failure: string): Promise<Response | undefined> {
  return caches.default.match(key).catch((error: unknown) => {
    console.error(failure, error);
    return undefined;
  });
}
