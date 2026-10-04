// Minimal typing for the Cloudflare runtime the Worker uses: the
// `cloudflare:workers` module and the edge cache global. Kept structural and
// local so the type check does not depend on the generated
// worker-configuration.d.ts (gitignored, `npm run cf-typegen`).
declare module "cloudflare:workers" {
  interface R2ObjectBody {
    arrayBuffer(): Promise<ArrayBuffer>;
    etag: string;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }
  interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    /** The object's metadata without its body; null when absent. */
    head(key: string): Promise<object | null>;
    put(
      key: string,
      value: ArrayBuffer,
      options?: {
        httpMetadata?: { contentType?: string; cacheControl?: string };
        customMetadata?: Record<string, string>;
        /** Write only if the stored object still has this etag. */
        onlyIf?: { etagMatches?: string };
      },
    ): Promise<unknown>;
  }
  /** Keeps the invocation alive until `promise` settles (ctx.waitUntil). */
  export function waitUntil(promise: Promise<unknown>): void;
  export const env: {
    /** The cover-art bucket (wrangler.jsonc `r2_buckets`). */
    COVERS?: R2Bucket;
  };
}

// Workers expose the zone's edge cache as `caches.default`, which the DOM
// lib's CacheStorage does not declare.
interface CacheStorage {
  readonly default: Cache;
}
