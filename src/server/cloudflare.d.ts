// Minimal typing for the Cloudflare runtime module the Worker entry uses.
// Kept structural and local so the type check does not depend on the
// generated worker-configuration.d.ts (gitignored, `npm run cf-typegen`).
declare module "cloudflare:workers" {
  interface R2ObjectBody {
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  }
  interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    put(
      key: string,
      value: ArrayBuffer,
      options?: {
        httpMetadata?: { contentType?: string; cacheControl?: string };
        customMetadata?: Record<string, string>;
      },
    ): Promise<unknown>;
  }
  export const env: {
    /** The cover-art bucket (wrangler.jsonc `r2_buckets`). */
    COVERS?: R2Bucket;
  };
}
