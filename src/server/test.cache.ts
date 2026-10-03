// The Workers edge cache (`caches.default`) as a stub for the src/server
// tests; vi.unstubAllGlobals() removes it. Test-only: the name stays outside
// vitest's include (**/*.test.ts) and no app code imports it.

import { vi } from "vitest";

/**
 * An in-memory edge cache keyed by URL. Like the Workers one it stores only
 * GET requests and hands out a fresh copy of the response on each match.
 * Returns its entries.
 */
export function stubEdgeCache(): Map<string, Response> {
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (req: Request) => entries.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => {
        if (req.method !== "GET") throw new TypeError("Cannot cache response to non-GET request.");
        entries.set(req.url, res);
      },
    },
  });
  return entries;
}

/** An empty edge cache whose `broken` side, reads or writes, throws. */
export function stubBrokenEdgeCache(broken: "read" | "write") {
  vi.stubGlobal("caches", {
    default: {
      match: async () => {
        if (broken === "read") throw new Error("cache read failed");
        return undefined;
      },
      put: async () => {
        if (broken === "write") throw new Error("cache write failed");
      },
    },
  });
}
