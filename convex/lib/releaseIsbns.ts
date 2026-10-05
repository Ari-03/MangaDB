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
 * followed). Any spelling is read as its ISBN-13 (lib/isbn.ts toIsbn13: an
 * ISBN-10, hyphens, a lowercase x); one with a bad check digit finds none.
 */
export async function printingReleases(
  ctx: QueryCtx,
  isbn: string,
): Promise<Array<Doc<"releases"> | null>> {
  const isbn13 = toIsbn13(isbn);
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
 * The ISBNs a source record states, as stored, in the order they are read:
 * an ANN line's stored release page first (the page pass reads it before
 * the line), then the snapshot's own; ISBN-13s before ISBN-10s.
 */
export function statedIsbns(snapshot: unknown): string[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  type Isbns = { isbn13?: unknown; isbn10?: unknown };
  const { page, ...own } = snapshot as Isbns & { page?: Isbns };
  return [page?.isbn13, own.isbn13, page?.isbn10, own.isbn10].filter(
    (isbn): isbn is string => typeof isbn === "string" && isbn.trim() !== "",
  );
}

/**
 * The ISBN-13 a source record describes, whatever the source: the first
 * stated ISBN (statedIsbns) that is a valid ISBN in any spelling, as its
 * ISBN-13. A stated value with a bad check digit is skipped, never read.
 */
export function observedIsbn13(snapshot: unknown): string | undefined {
  for (const isbn of statedIsbns(snapshot)) {
    const isbn13 = toIsbn13(isbn);
    if (isbn13 !== undefined) return isbn13;
  }
  return undefined;
}

/**
 * A Release's own ISBNs, its `isbn13` and `isbn10` each read as an ISBN-13:
 * what "its own ISBN" means where a printing is compared with it (the mark,
 * the Release row's list, a decision). A merge's duplicate check reads the
 * survivor's `isbn13` only (lib/sensitiveOps.ts), so a row the survivor has
 * as its ISBN-10 moves with it and its ISBN-13 still finds the Release.
 */
export function primaryIsbnsOf(release: Pick<Doc<"releases">, "isbn13" | "isbn10">): Set<string> {
  return new Set(
    [release.isbn13, release.isbn10].flatMap((isbn) => {
      const isbn13 = toIsbn13(isbn);
      return isbn13 !== undefined ? [isbn13] : [];
    }),
  );
}

/**
 * The printing's ISBN-13 when `isbn` (any spelling) is recorded as one of
 * the Release's Other Printings and is not its own ISBN (primaryIsbnsOf),
 * else undefined. How linkObservation marks a record it links as another
 * printing's; an ISBN with no printing row reads no Release.
 */
export async function printingIsbnOf(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  isbn: string | undefined,
): Promise<string | undefined> {
  const isbn13 = toIsbn13(isbn);
  if (isbn13 === undefined) return undefined;
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .take(PRINTING_SCAN);
  if (!rows.some((row) => row.releaseId === releaseId)) return undefined;
  const release = await ctx.db.get(releaseId);
  return release !== null && primaryIsbnsOf(release).has(isbn13) ? undefined : isbn13;
}
