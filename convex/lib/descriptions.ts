// The Edition Description (CONTEXT.md): one blurb per book, resolved at
// query time from the Release Descriptions its Releases store. Nothing is
// stored or migrated; the Edition and Volume pages (catalogPages.ts) feed in
// the Release docs they already loaded, so the pick costs no extra reads.
//
// Field Authority is not consulted here: weighing it would take a revisions
// read per Release, and the import write path already enforces it on every
// stored description. A Human Override is on the doc itself, so it counts.

import type { Doc } from "../_generated/dataModel";

/** The Release fields the pick reads. */
type DescribedRelease = Pick<
  Doc<"releases">,
  "format" | "pubDate" | "description" | "overriddenFields"
>;

type Candidate<R> = { release: R; text: string };

/**
 * Whether `a` speaks for the book ahead of `b`: a Human Override of the
 * description first, then physical before digital, then the earliest
 * publication date (undated last), then the longer text.
 */
function outranks<R extends DescribedRelease>(a: Candidate<R>, b: Candidate<R>): boolean {
  const overridden = (c: Candidate<R>) =>
    c.release.overriddenFields?.includes("description") === true;
  if (overridden(a) !== overridden(b)) return overridden(a);
  const physical = (c: Candidate<R>) => c.release.format === "physical";
  if (physical(a) !== physical(b)) return physical(a);
  const dateA = a.release.pubDate?.sort ?? Infinity;
  const dateB = b.release.pubDate?.sort ?? Infinity;
  if (dateA !== dateB) return dateA < dateB;
  return a.text.length > b.text.length;
}

/**
 * The representative Release Description among `releases` and the Release
 * it came from (callers attribute it by that Release's Edition), or null
 * when none carries non-blank text. Ordered by `outranks`; a full tie keeps
 * the first in input order.
 */
export function representativeDescription<R extends DescribedRelease>(
  releases: ReadonlyArray<R>,
): Candidate<R> | null {
  let best: Candidate<R> | null = null;
  for (const release of releases) {
    const text = release.description?.trim();
    if (!text) continue;
    const candidate = { release, text };
    if (!best || outranks(candidate, best)) best = candidate;
  }
  return best;
}
