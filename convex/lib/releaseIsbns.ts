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

/**
 * Is a record linked to `release` one of its Other Printings' records now?
 * Marked (the mark is sticky: a record keeps it when a later snapshot
 * states no ISBN), or unmarked with the ISBN its snapshot states now
 * (observedIsbn13) recorded as one of the Release's printings and not its
 * own (printingIsbnOf). A record linked as the Release's own printing
 * becomes another printing's when a correction gives the Release another
 * ISBN. Such a record offers the Release nothing: no art, no blurb, no
 * withdrawal (the paths that read this), as reconcileFields reads it. A
 * record stating no ISBN is unknown here and reads as the Release's own.
 */
export async function ofOtherPrinting(
  ctx: QueryCtx,
  release: Doc<"releases">,
  observation: Doc<"sourceObservations">,
): Promise<boolean> {
  if (observation.printingIsbn13 !== undefined) return true;
  const isbn13 = observedIsbn13(observation.snapshot);
  if (isbn13 === undefined || primaryIsbnsOf(release).has(isbn13)) return false;
  const rows = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .take(PRINTING_SCAN);
  return rows.some((row) => row.releaseId === release._id);
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

/**
 * A check made before each further read (a document, an index range): it
 * throws, through the caller's own refusal, when the transaction could not
 * afford one more document of the largest size and the caller's reserve.
 * An operation that must end in its own answer rather than the platform's
 * abort (a Release Split, the consistency check) reads through one; a
 * plain write leaves it out, and the platform's limit rolls it back whole.
 */
export type Room = () => Promise<void>;

/** A Room that keeps `reserve` (what the caller still needs afterwards) beyond the next read. */
export function readRoom(ctx: QueryCtx, reserve: Budget, refuse: (short: string[]) => never): Room {
  const need: Budget = {
    ...reserve,
    bytesRead: MAX_DOCUMENT_BYTES + (reserve.bytesRead ?? 0),
    documentsRead: 1 + (reserve.documentsRead ?? 0),
    databaseQueries: 1 + (reserve.databaseQueries ?? 0),
  };
  return async () => {
    const short = budgetShortfall(await ctx.meta.getTransactionMetrics(), need);
    if (short.length > 0) refuse(short);
  };
}

/**
 * Up to `limit` documents of `query`, read one at a time, each only once
 * `room` (when given) says it fits: never a burst the check did not see.
 */
export async function takeWithin<T>(
  query: AsyncIterable<T>,
  limit: number,
  room?: Room,
): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  await room?.();
  for await (const doc of query) {
    out.push(doc);
    if (out.length >= limit) break;
    await room?.();
  }
  return out;
}

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
 * Follows claims' merge chains. Every record read on a chain remembers
 * where its chain ends and how many pointers away, so chains that share a
 * tail read it once, whichever record they start from; a claim's own
 * record, when the caller already read it from an index, is not read again.
 * With `terminal`, that Release resolves to itself even while merged, so a
 * Split can ask who will own a claim once the Release is active again;
 * chains through it stop there. With `room`, every read is checked first.
 */
export type ClaimResolver = {
  release(id: Id<"releases">, stored?: Doc<"releases">): Promise<Resolution<Doc<"releases">>>;
  bundle(
    id: Id<"releaseBundles">,
    stored?: Doc<"releaseBundles">,
  ): Promise<Resolution<Doc<"releaseBundles">>>;
};

export function claimResolver(
  ctx: QueryCtx,
  options: { terminal?: Id<"releases">; room?: Room } = {},
): ClaimResolver {
  type Ending<T> = { doc: T; hops: number } | { unresolved: string };
  function resolver<T extends "releases" | "releaseBundles">() {
    const endings = new Map<string, Ending<Doc<T>>>();
    const read = async (id: Id<T>): Promise<Doc<T> | null> => {
      await options.room?.();
      return await ctx.db.get(id);
    };
    return async (id: Id<T>, stored?: Doc<T>): Promise<Resolution<Doc<T>>> => {
      const known = endings.get(id);
      if (known === undefined) await walk(id, stored);
      const ending = endings.get(id);
      if (ending === undefined) {
        return { unresolved: `${id} is merged more than ${MERGE_HOPS} times over` };
      }
      if ("unresolved" in ending) return ending;
      return ending.hops > MERGE_HOPS
        ? { unresolved: `${id} is merged more than ${MERGE_HOPS} times over` }
        : { doc: ending.doc };
    };
    // Reads `id`'s chain to its end (or MERGE_HOPS + 1 pointers, whichever
    // comes first) and remembers each record's ending on the way.
    async function walk(id: Id<T>, stored?: Doc<T>): Promise<void> {
      const path: string[] = [];
      let current = stored ?? (await read(id));
      let end: Ending<Doc<T>>;
      if (current === null) {
        endings.set(id, { unresolved: `${id} no longer exists` });
        return;
      }
      for (;;) {
        const known = endings.get(current._id);
        if (known !== undefined) {
          end = known;
          break;
        }
        if (current._id === options.terminal || current.status !== "merged") {
          end = { doc: current, hops: 0 };
          endings.set(current._id, end);
          break;
        }
        const next = current.mergedIntoId as Id<T> | undefined;
        if (next === undefined) {
          end = { unresolved: `${current._id} is merged into nothing` };
          endings.set(current._id, end);
          break;
        }
        if (path.includes(current._id)) {
          end = { unresolved: `${current._id} is in a merge cycle` };
          break;
        }
        path.push(current._id);
        // Past MERGE_HOPS pointers the start is unresolved however the
        // chain ends; nothing on it is remembered, so a later start nearer
        // the end reads it afresh.
        if (path.length > MERGE_HOPS) return;
        const survivor: Doc<T> | null = await read(next);
        if (survivor === null) {
          end = { unresolved: `${current._id} is merged into ${next}, which no longer exists` };
          break;
        }
        current = survivor;
      }
      path.forEach((recordId, index) => {
        endings.set(
          recordId,
          "doc" in end ? { doc: end.doc, hops: end.hops + path.length - index } : end,
        );
      });
    }
  }
  const releases = resolver<"releases">();
  const bundles = resolver<"releaseBundles">();
  return { release: releases, bundle: bundles };
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

/** The claims on one ISBN as stored, read once, before merges are followed (claimsOf). */
export type StoredClaims = {
  isbn13: string;
  /** Each claim, with its record when the index read returned it. */
  raw: Array<{ claim: Claim; stored?: Doc<"releases"> | Doc<"releaseBundles"> }>;
  complete: boolean;
  printed: boolean;
};

/**
 * Every stored claim on `isbn` (any spelling; null when it is no ISBN):
 * Releases' `isbn13` and `isbn10` (by the ISBN-10 form; a 979 ISBN has
 * none), printing rows, and Bundles' `isbn13` and `isbn10`, active, hidden
 * and merged alike. Each index is read up to CLAIM_SCAN + 1 rows, one at a
 * time within `room`; `complete` says whether that was all of them. Exact
 * keys only: a claim stored in another spelling is not found here, which
 * the consistency check reports (lib/isbn.ts isbnHiddenFromIndex).
 */
export async function storedClaims(
  ctx: QueryCtx,
  isbn: string,
  room?: Room,
): Promise<StoredClaims | null> {
  const isbn13 = toIsbn13(isbn);
  if (isbn13 === undefined) return null;
  const isbn10 = isbn13To10(isbn13);
  const take = CLAIM_SCAN + 1;
  const own13 = await takeWithin(
    ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)),
    take,
    room,
  );
  const own10 =
    isbn10 === undefined
      ? []
      : await takeWithin(
          ctx.db.query("releases").withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10)),
          take,
          room,
        );
  const rows = await takeWithin(
    ctx.db.query("releaseIsbns").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)),
    take,
    room,
  );
  const box13 = await takeWithin(
    ctx.db.query("releaseBundles").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)),
    take,
    room,
  );
  const box10 =
    isbn10 === undefined
      ? []
      : await takeWithin(
          ctx.db.query("releaseBundles").withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10)),
          take,
          room,
        );
  return {
    isbn13,
    raw: [
      ...own13.map((r) => ({
        claim: { on: "release", via: "isbn13", storedId: r._id } satisfies Claim,
        stored: r,
      })),
      ...own10.map((r) => ({
        claim: { on: "release", via: "isbn10", storedId: r._id } satisfies Claim,
        stored: r,
      })),
      ...rows.map((row) => ({
        claim: {
          on: "release",
          via: "printing",
          storedId: row.releaseId,
          rowId: row._id,
        } satisfies Claim,
      })),
      ...box13.map((b) => ({
        claim: { on: "bundle", via: "isbn13", storedId: b._id } satisfies Claim,
        stored: b,
      })),
      ...box10.map((b) => ({
        claim: { on: "bundle", via: "isbn10", storedId: b._id } satisfies Claim,
        stored: b,
      })),
    ],
    complete: [own13, own10, rows, box13, box10].every((read) => read.length < take),
    printed: rows.length > 0,
  };
}

/**
 * Add one claim to `claims`, under the canonical record its chain reaches
 * (`resolver`), or as unresolved.
 */
export async function addClaim(
  claims: IsbnClaims,
  claim: Claim,
  resolver: ClaimResolver,
  stored?: Doc<"releases"> | Doc<"releaseBundles">,
): Promise<void> {
  const resolved =
    claim.on === "release"
      ? await resolver.release(claim.storedId, stored as Doc<"releases"> | undefined)
      : await resolver.bundle(claim.storedId, stored as Doc<"releaseBundles"> | undefined);
  if ("unresolved" in resolved) {
    claims.unresolved.push({ claim, reason: resolved.unresolved });
    return;
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

/**
 * Stored claims grouped by where each claim's chain ends (`resolver`).
 * `keep` drops claims (a row being moved, a field being rewritten) before
 * merges are followed; one owner may carry several claims, and the caller
 * decides by claim kind. One read can be grouped under several resolvers.
 */
export async function claimsOf(
  stored: StoredClaims,
  { resolver, keep }: { resolver: ClaimResolver; keep?: (claim: Claim) => boolean },
): Promise<IsbnClaims> {
  const claims: IsbnClaims = {
    isbn13: stored.isbn13,
    owners: new Map(),
    unresolved: [],
    complete: stored.complete,
    printed: stored.printed,
  };
  for (const { claim, stored: doc } of stored.raw) {
    if (keep === undefined || keep(claim)) await addClaim(claims, claim, resolver, doc);
  }
  return claims;
}

/** storedClaims grouped by claimsOf: every claim on `isbn`, read and followed. */
export async function isbnClaims(
  ctx: QueryCtx,
  isbn: string,
  options: { resolver: ClaimResolver; keep?: (claim: Claim) => boolean; room?: Room },
): Promise<IsbnClaims | null> {
  const stored = await storedClaims(ctx, isbn, options.room);
  return stored === null ? null : await claimsOf(stored, options);
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
 * row. An ISBN without one is left to the caller's older checks. Each
 * distinct ISBN is checked once, whichever spellings name it, and most
 * have no row: one indexed probe for a row settles that before any claim
 * is read, so an ordinary write reads one empty index range per ISBN.
 * Where a row exists, every claim is read and followed, the Release's own
 * included. `keep` drops claims the same write removes (a primary it
 * rewrites).
 */
export async function printedIsbnRefusal(
  ctx: QueryCtx,
  isbns: ReadonlyArray<string | undefined>,
  releaseId?: Id<"releases">,
  keep?: (claim: Claim) => boolean,
): Promise<string | null> {
  const keys = new Set(isbns.flatMap((isbn) => toIsbn13(isbn) ?? []));
  const resolver = claimResolver(ctx);
  for (const isbn13 of keys) {
    const row = await ctx.db
      .query("releaseIsbns")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .first();
    if (row === null) continue;
    const claims = await isbnClaims(ctx, isbn13, { resolver, keep });
    const why = claims === null ? null : printedClaimRefusal(claims, releaseId);
    if (why !== null) return why;
  }
  return null;
}
