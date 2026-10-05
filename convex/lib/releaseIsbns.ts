// Other Printings (CONTEXT.md) as rows: the `releaseIsbns` table read by
// ISBN and by Release, and the mark a linked record of one carries.
// Lookups only, with no imports beyond types and ISBN arithmetic, so the
// matching ladder, reconciliation and the pages can all read it without an
// import cycle. The write that records one is lib/printings.ts, and the
// decision to record one is a person's (printings.ts).

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { toIsbn13 } from "./isbn";

// Rows read per ISBN or per Release: an ISBN names one printing, and a
// long-lived book has a handful.
const PRINTING_SCAN = 20;

/**
 * The Releases recorded as printed under this ISBN, as stored (merges not
 * followed). An ISBN-10 is read as its ISBN-13.
 */
export async function printingReleases(
  ctx: QueryCtx,
  isbn: string,
): Promise<Array<Doc<"releases"> | null>> {
  const isbn13 = isbn.length === 13 ? isbn : toIsbn13(isbn);
  if (isbn13 === undefined) return [];
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .take(PRINTING_SCAN);
  return await Promise.all(rows.map((row) => ctx.db.get(row.releaseId)));
}

/** A Release's other printings, oldest first (undated last). */
export async function otherPrintingsOf(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
): Promise<Array<Doc<"releaseIsbns">>> {
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .take(PRINTING_SCAN);
  return rows.sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));
}

/**
 * The ISBN-13 a source record describes, whatever the source: every
 * adapter's snapshot carries `isbn13`, and an ANN line's stored release
 * page may carry its own, which the page pass reads first.
 */
export function observedIsbn13(snapshot: unknown): string | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const { isbn13, page } = snapshot as { isbn13?: unknown; page?: { isbn13?: unknown } };
  const fromPage = page?.isbn13;
  if (typeof fromPage === "string") return fromPage;
  return typeof isbn13 === "string" ? isbn13 : undefined;
}

/**
 * The printing's ISBN when `isbn13` is recorded as one of the Release's
 * Other Printings (and is not its own ISBN), else undefined. How
 * linkObservation marks a record it links as another printing's; an ISBN
 * with no printing row reads no document.
 */
export async function printingIsbnOf(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  isbn13: string | undefined,
): Promise<string | undefined> {
  if (isbn13 === undefined) return undefined;
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .take(PRINTING_SCAN);
  if (!rows.some((row) => row.releaseId === releaseId)) return undefined;
  return (await ctx.db.get(releaseId))?.isbn13 === isbn13 ? undefined : isbn13;
}
