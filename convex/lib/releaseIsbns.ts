// Other Printings (CONTEXT.md) as rows: the `releaseIsbns` table read by
// ISBN and by Release, the mark a linked record of one carries, and who
// claims an ISBN when a write must know for certain (isbnClaims). Lookups
// only, with no imports beyond types and ISBN arithmetic, so the matching
// ladder, reconciliation, the pages and the writers can all read it without
// an import cycle. The write that records one is lib/printings.ts, and the
// decision to record one is a person's (printings.ts).
//
// The ownership invariant the writers keep (docs/operations.md): every
// ISBN-13 with at least one current `releaseIsbns` row has all its current
// claims (Releases' own `isbn13`/`isbn10`, printing rows, Bundles' ISBNs)
// resolving through merges to exactly one canonical Release, active or
// hidden, and no Bundle. That Release may hold it both as its own and as a
// row (a promoted printing). An ISBN with no row keeps the older policy:
// duplicate primaries are refused against active holders only.

import type { TransactionMetrics } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isbn13To10, toIsbn13 } from "./isbn";

// ---------- what one transaction has left ----------

/** The largest document Convex stores: one more read may cost this much. */
export const MAX_DOCUMENT_BYTES = 1 << 20;

const METRICS = [
  "bytesRead",
  "bytesWritten",
  "databaseQueries",
  "documentsRead",
  "documentsWritten",
  "functionsScheduled",
  "scheduledFunctionArgsBytes",
] as const satisfies ReadonlyArray<keyof TransactionMetrics>;

/** What an operation still plans to use, per transaction metric. */
export type Budget = Partial<Record<keyof TransactionMetrics, number>>;

/**
 * The metrics `need` would overrun, as "bytesRead (needs N, R left)"; empty
 * when it fits. An operation that must finish in one transaction checks its
 * remaining work (with a reserve for what it cannot count exactly) against
 * `ctx.meta.getTransactionMetrics()` before reading or writing more, and
 * refuses rather than abort halfway.
 */
export function budgetShortfall(metrics: TransactionMetrics, need: Budget): string[] {
  return METRICS.flatMap((name) => {
    const wanted = need[name] ?? 0;
    const left = metrics[name].remaining;
    return wanted > left ? [`${name} (needs ${wanted}, ${left} left)`] : [];
  });
}

/** A value's serialized size, near enough to what Convex counts for it. */
export function sizeOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

// Rows read per ISBN by the public lookups: an ISBN names one printing.
const PRINTING_SCAN = 20;

/**
 * The Releases recorded as printed under this ISBN, as stored (merges not
 * followed). Any spelling is read as its ISBN-13 (lib/isbn.ts toIsbn13: an
 * ISBN-10, hyphens, a lowercase x); one with a bad check digit finds none.
 * For lookups that take the first hit; a write asks isbnClaims instead.
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

/** How many Other Printings a Release row shows, the first recorded. */
export const SHOWN_PRINTINGS = 20;
// Rows read beyond the shown ones: a Release's own ISBN-13 and ISBN-10 may
// each still have a row from before a promotion, and those are not shown.
const OWN_ROW_ALLOWANCE = 2;

/**
 * A Release's Other Printings as its row shows them: the first
 * SHOWN_PRINTINGS recorded, its own ISBNs left out (primaryIsbnsOf), sorted
 * oldest first (undated last, ties in recorded order). Only that subset is
 * sorted: a later-recorded older printing is not shown. `more` is true when
 * others may remain unshown, including when retained rows of its own ISBNs
 * filled the extra rows read, so a row never claims a complete list it has
 * not read.
 */
export async function otherPrintingsOf(
  ctx: QueryCtx,
  release: Pick<Doc<"releases">, "_id" | "isbn13" | "isbn10">,
): Promise<{ printings: Array<Doc<"releaseIsbns">>; more: boolean }> {
  const read = SHOWN_PRINTINGS + OWN_ROW_ALLOWANCE + 1;
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_release", (q) => q.eq("releaseId", release._id))
    .take(read);
  const own = primaryIsbnsOf(release);
  const others = rows.filter((row) => !own.has(toIsbn13(row.isbn13) ?? row.isbn13));
  const printings = others
    .slice(0, SHOWN_PRINTINGS)
    .sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));
  return { printings, more: others.length > SHOWN_PRINTINGS || rows.length === read };
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
 * the Release row's list, a decision, a Restore). A merge's duplicate check
 * reads the survivor's `isbn13` only (lib/sensitiveOps.ts), so a row the
 * survivor has as its ISBN-10 moves with it and its ISBN-13 still finds the
 * Release.
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

/** A source record as Revisions name it: "{sourceKey} {sourceRecordId}". */
export function recordName(
  observation: Pick<Doc<"sourceObservations">, "sourceKey" | "sourceRecordId">,
): string {
  return `${observation.sourceKey} ${observation.sourceRecordId}`;
}

/**
 * The `sourceObservation` value of the Revision a reviewed link of a record
 * of an already-recorded printing writes (lib/printings.ts
 * linkRecordedPrinting): the record's first link, to the printing's Release.
 * Split tells it from a later relink by this exact text.
 */
export function printingLinkAudit(record: string, isbn13: string): string {
  return `${record} — a record of Other Printing ISBN ${isbn13}`;
}

// ---------- who claims an ISBN, for writes ----------

// Rows read per claim index: past this many, a write cannot know it has
// seen every claim, and refuses.
export const CLAIM_SCAN = 20;
// Merge pointers followed from a stored claim before it counts as
// unresolved; exactly this many resolve.
export const MERGE_HOPS = 8;

/** One stored claim on an ISBN, before merges are followed. */
export type Claim =
  | {
      on: "release";
      via: "isbn13" | "isbn10" | "printing";
      storedId: Id<"releases">;
      rowId?: Id<"releaseIsbns">;
    }
  | { on: "bundle"; via: "isbn13" | "isbn10"; storedId: Id<"releaseBundles"> };

/** Where a stored claim's merge chain ends, or why it cannot be followed. */
type Resolution<T> = { doc: T } | { unresolved: string };

/**
 * Follows claims' merge chains, each stored record once per operation. With
 * `terminal`, that Release resolves to itself even while merged, so a Split
 * can ask who will own a claim once the Release is active again; chains
 * through it stop there.
 */
export type ClaimResolver = {
  release(id: Id<"releases">): Promise<Resolution<Doc<"releases">>>;
  bundle(id: Id<"releaseBundles">): Promise<Resolution<Doc<"releaseBundles">>>;
};

export function claimResolver(
  ctx: QueryCtx,
  options: { terminal?: Id<"releases"> } = {},
): ClaimResolver {
  async function follow<T extends "releases" | "releaseBundles">(
    id: Id<T>,
  ): Promise<Resolution<Doc<T>>> {
    const visited = new Set<string>();
    let current = await ctx.db.get(id);
    if (current === null) return { unresolved: `${id} no longer exists` };
    for (let hops = 0; ; hops++) {
      if (current._id === options.terminal || current.status !== "merged") return { doc: current };
      const next = current.mergedIntoId as Id<T> | undefined;
      if (next === undefined) return { unresolved: `${current._id} is merged into nothing` };
      if (visited.has(current._id)) return { unresolved: `${current._id} is in a merge cycle` };
      if (hops === MERGE_HOPS) {
        return { unresolved: `${id} is merged more than ${MERGE_HOPS} times over` };
      }
      visited.add(current._id);
      const survivor: Doc<T> | null = await ctx.db.get(next);
      if (survivor === null) {
        return { unresolved: `${current._id} is merged into ${next}, which no longer exists` };
      }
      current = survivor;
    }
  }
  const once = <V>(memo: Map<string, Promise<V>>, id: string, load: () => Promise<V>) => {
    let hit = memo.get(id);
    if (!hit) {
      hit = load();
      memo.set(id, hit);
    }
    return hit;
  };
  const releases = new Map<string, Promise<Resolution<Doc<"releases">>>>();
  const bundles = new Map<string, Promise<Resolution<Doc<"releaseBundles">>>>();
  return {
    release: (id) => once(releases, id, () => follow(id)),
    bundle: (id) => once(bundles, id, () => follow(id)),
  };
}

/** A canonical record and the stored claims on one ISBN that reach it. */
export type ClaimOwner =
  | { kind: "release"; doc: Doc<"releases">; claims: Claim[] }
  | { kind: "bundle"; doc: Doc<"releaseBundles">; claims: Claim[] };

/** Every stored claim on one ISBN, grouped by the canonical record it reaches. */
export type IsbnClaims = {
  isbn13: string;
  /** By canonical record ID. */
  owners: Map<string, ClaimOwner>;
  /** Claims whose merge chain cannot be followed: still claims, never nobody's. */
  unresolved: Array<{ claim: Claim; reason: string }>;
  /** False when a claim index held more than CLAIM_SCAN rows: some were not read. */
  complete: boolean;
  /** A printing row claims it (or more than CLAIM_SCAN do), whatever `keep` let through. */
  printed: boolean;
};

/**
 * Every stored claim on `isbn` (any spelling; null when it is no ISBN):
 * Releases' `isbn13` and `isbn10` (by the ISBN-10 form; a 979 ISBN has
 * none), printing rows, and Bundles' `isbn13` and `isbn10`, active, hidden
 * and merged alike. `keep` drops claims (a row being moved, a field being
 * rewritten) before merges are followed, so what remains is grouped by
 * where each claim's chain ends (`resolver`); one owner may carry several
 * claims, and the caller decides by claim kind. Each index is read up to
 * CLAIM_SCAN + 1 rows; `complete` says whether that was all of them.
 */
export async function isbnClaims(
  ctx: QueryCtx,
  isbn: string,
  { resolver, keep }: { resolver: ClaimResolver; keep?: (claim: Claim) => boolean },
): Promise<IsbnClaims | null> {
  const isbn13 = toIsbn13(isbn);
  if (isbn13 === undefined) return null;
  const isbn10 = isbn13To10(isbn13);
  const take = CLAIM_SCAN + 1;
  const [own13, own10, rows, box13, box10] = await Promise.all([
    ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .take(take),
    isbn10 === undefined
      ? []
      : ctx.db
          .query("releases")
          .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10))
          .take(take),
    ctx.db
      .query("releaseIsbns")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .take(take),
    ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .take(take),
    isbn10 === undefined
      ? []
      : ctx.db
          .query("releaseBundles")
          .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10))
          .take(take),
  ]);
  const raw: Claim[] = [
    ...own13.map((r): Claim => ({ on: "release", via: "isbn13", storedId: r._id })),
    ...own10.map((r): Claim => ({ on: "release", via: "isbn10", storedId: r._id })),
    ...rows.map(
      (row): Claim => ({ on: "release", via: "printing", storedId: row.releaseId, rowId: row._id }),
    ),
    ...box13.map((b): Claim => ({ on: "bundle", via: "isbn13", storedId: b._id })),
    ...box10.map((b): Claim => ({ on: "bundle", via: "isbn10", storedId: b._id })),
  ];
  const claims: IsbnClaims = {
    isbn13,
    owners: new Map(),
    unresolved: [],
    complete: [own13, own10, rows, box13, box10].every((read) => read.length < take),
    printed: rows.length > 0,
  };
  for (const claim of keep ? raw.filter(keep) : raw) {
    const resolved =
      claim.on === "release"
        ? await resolver.release(claim.storedId)
        : await resolver.bundle(claim.storedId);
    if ("unresolved" in resolved) {
      claims.unresolved.push({ claim, reason: resolved.unresolved });
      continue;
    }
    const owner = claims.owners.get(resolved.doc._id);
    if (owner) owner.claims.push(claim);
    else if (claim.on === "release") {
      claims.owners.set(resolved.doc._id, {
        kind: "release",
        doc: resolved.doc as Doc<"releases">,
        claims: [claim],
      });
    } else {
      claims.owners.set(resolved.doc._id, {
        kind: "bundle",
        doc: resolved.doc as Doc<"releaseBundles">,
        claims: [claim],
      });
    }
  }
  return claims;
}

/** How a claim names its ISBN, for a refusal. */
function claimText(claim: Claim): string {
  if (claim.on === "bundle") return `Release Bundle ${claim.storedId}'s ${claim.via}`;
  return claim.via === "printing"
    ? `a printing row of Release ${claim.storedId}`
    : `Release ${claim.storedId}'s ${claim.via}`;
}

/**
 * Why `claims` may not end with `releaseId` as the ISBN's one owner, or
 * null: the rule every write that adds or keeps a claim on a printed ISBN
 * (one with a printing row, or that the write records as one) follows. Some
 * claims were not read; a claim's merge chain cannot be followed; a Bundle
 * claims it; or it reaches another Release, active or hidden. With no
 * `releaseId` (a new Release or Bundle), any claim at all refuses.
 */
export function printedClaimRefusal(claims: IsbnClaims, releaseId?: Id<"releases">): string | null {
  const isbn = claims.isbn13;
  if (!claims.complete) {
    return `ISBN ${isbn} has more stored claims than one check reads (over ${CLAIM_SCAN} per kind): an administrator corrects them first.`;
  }
  const [unresolved] = claims.unresolved;
  if (unresolved !== undefined) {
    return `ISBN ${isbn} is claimed by ${claimText(unresolved.claim)}, and ${unresolved.reason}: an administrator corrects it first.`;
  }
  for (const owner of claims.owners.values()) {
    if (owner.kind === "bundle") {
      return `ISBN ${isbn} is Release Bundle ${owner.doc.publicId}'s, and an ISBN with other printings is a Release's only.`;
    }
    if (owner.doc._id !== releaseId) {
      return `ISBN ${isbn} belongs to ${owner.doc.status === "hidden" ? "hidden " : ""}Release ${owner.doc._id} (${owner.claims.map(claimText).join("; ")}).`;
    }
  }
  return null;
}

/**
 * Why a write may not leave `isbns` (any spellings; undefined skipped)
 * claimed by Release `releaseId`, or by a new Release or a Bundle when it
 * is omitted, or null: printedClaimRefusal for each ISBN with a printing
 * row. An ISBN without one is left to the caller's older checks. `keep`
 * drops claims the same write removes (a primary it rewrites).
 */
export async function printedIsbnRefusal(
  ctx: QueryCtx,
  isbns: ReadonlyArray<string | undefined>,
  releaseId?: Id<"releases">,
  keep?: (claim: Claim) => boolean,
): Promise<string | null> {
  const resolver = claimResolver(ctx);
  for (const isbn of isbns) {
    const claims = isbn === undefined ? null : await isbnClaims(ctx, isbn, { resolver, keep });
    const why = claims?.printed ? printedClaimRefusal(claims, releaseId) : null;
    if (why !== null) return why;
  }
  return null;
}
