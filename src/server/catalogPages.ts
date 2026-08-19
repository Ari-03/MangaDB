import { createServerFn } from "@tanstack/react-start";

import { api } from "../../convex/_generated/api";
import { convexServerClient } from "~/server/convex";

/**
 * SSR fetches for the Volume, Edition, and Bundle pages and the /isbn route
 * (ticket #23): public catalog reads, so no auth token. Each returns the
 * resolved page — for a merged record this is already the survivor's data
 * (the routes 301 on any ID/slug mismatch) — or null when the record is
 * unknown/hidden or Convex is not configured.
 */
export const fetchVolumePage = createServerFn({ method: "GET" })
  .validator((publicId: number) => publicId)
  .handler(async ({ data: publicId }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalogPages.volumePage, { publicId });
  });

export type VolumePageData = NonNullable<
  Awaited<ReturnType<typeof fetchVolumePage>>
>;

export const fetchEditionPage = createServerFn({ method: "GET" })
  .validator((publicId: number) => publicId)
  .handler(async ({ data: publicId }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalogPages.editionPage, { publicId });
  });

export type EditionPageData = NonNullable<
  Awaited<ReturnType<typeof fetchEditionPage>>
>;

export const fetchBundlePage = createServerFn({ method: "GET" })
  .validator((publicId: number) => publicId)
  .handler(async ({ data: publicId }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalogPages.bundlePage, { publicId });
  });

export type BundlePageData = NonNullable<
  Awaited<ReturnType<typeof fetchBundlePage>>
>;

/**
 * Resolve a normalized ISBN to its 301 target: the owning Edition anchored
 * at the matching Release, or the Bundle page for a box-set ISBN (a Release
 * match wins any conflict — resolution order lives in the Convex query).
 */
export const fetchIsbnTarget = createServerFn({ method: "GET" })
  .validator((isbn: string) => isbn)
  .handler(async ({ data: isbn }) => {
    const convex = convexServerClient();
    if (!convex) return null;
    return await convex.query(api.catalogPages.isbnLookup, { isbn });
  });

export type IsbnTarget = NonNullable<
  Awaited<ReturnType<typeof fetchIsbnTarget>>
>;
