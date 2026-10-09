// What one response reads to render Proposals: the review queue
// (proposals.ts reviewQueuePage), a reader's Suggestions list
// (suggestions.ts mine) and both proposal pages (proposalDetail,
// suggestions.detail), and the legacy unpaged queue (proposals.ts
// reviewQueue). Any signed-in reader writes Suggestions, so what these
// read must stay inside a query's limits however a reader fills them.
// `proposalReads` reads each document (a record, its parents, a Revision,
// an observation) and each Edition's coverage at most once per response,
// shared by every row and version, and, when budgeted, stops before a
// read once the response is within READ_RESERVE of a limit: the row or
// version being read, and every later one, is then "not loaded"
// (`loaded`) instead of the whole query failing.

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { displayInfo, latestRevisionOf, type RecordRef } from "../moderation";
import { coverageOf } from "./editionRows";
import { publiclyVisible, type RecordGet } from "./publicRecords";

const MiB = 1024 * 1024;

/**
 * What a budgeted response keeps unread on each limit (16 MiB read, 4,096
 * index ranges, 32,000 documents) before it starts another read.
 *
 * Why a budget and not fewer rows: at the field limits
 * (lib/moderationFields.ts, three UTF-8 bytes a character in CJK), the
 * largest record is a Series: a 500-character title (1.5 KB), 100
 * alternative titles of 500 (150 KB), its searchText repeating both
 * (151.5 KB) and a 10,000-character synopsis (30 KB), about 333 KB. Every
 * other type is under 35 KB. The largest Revision rewrites those fields,
 * before and after (363 KB), with a 2,000-character comment (6 KB): about
 * 370 KB. Staleness reads a record and its latest Revision (703 KB);
 * rendering an op adds its base Revision (370 KB) and its title (for a
 * Release: its Edition, line and line's Series, and each covered Volume,
 * at most 32 KB, with its Series, read once however many Volumes share
 * it). So, read once each:
 *
 * - a queue page: 25 rows × 10 ops = 250 records × 703 KB ≈ 172 MB;
 * - `mine`: 50 subjects and 20 open rows × 10 ops, up to 250 records too;
 * - a proposal page: the Draft and CHANGES_SHOWN (6) versions × 10 ops =
 *   70 records × (703 + 370) KB ≈ 75 MB, and 70 × (3 + a title's 5 + 2
 *   per Volume) ≈ 1,000 index ranges for three-volume omnibuses.
 *
 * 16 MiB holds about 23 such records, two queue rows, so no row or
 * version count is both useful and safe. Instead every read through
 * `proposalReads` first checks that this much is left: each document
 * (`get`, which titles, visibility checks and a reader's cover holders
 * read their parents through too), each record's newest Revision, each
 * Edition's coverage rows, and each row's own reads (`room`: its version,
 * a box set's first member, a blob's metadata, a holder scan of at most 50
 * Releases, Bundles or Variants). A response then reads at most its limit
 * less READ_RESERVE before its last read starts, plus that one read: one
 * document, at most 1 MiB (Convex's limit, so import-written text past
 * the field limits too), or one index range, at most 50 holders of about
 * 35 KB. Index ranges and documents a read takes are far below their
 * reserves. A title too large to finish leaves its row or version "not
 * loaded" like any other read. Records of ordinary size never come near
 * it: the queue reads whole pages and a proposal page all its shown
 * versions.
 */
export const READ_RESERVE = {
  bytesRead: 4 * MiB,
  databaseQueries: 512,
  documentsRead: 2_048,
} as const;

const RESERVED = Object.keys(READ_RESERVE) as Array<keyof typeof READ_RESERVE>;

/** Thrown by a budgeted read once the response has no room left; `loaded` catches it. */
class NotLoaded extends Error {}

/** `read`'s value, or `otherwise` when a budgeted read inside it found no room. */
export async function loaded<Value, Otherwise>(
  read: () => Promise<Value>,
  otherwise: Otherwise,
): Promise<Value | Otherwise> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotLoaded) return otherwise;
    throw error;
  }
}

/**
 * One response's reads of what Proposals name, each at most once (see the
 * top of this file). `publicOnly` (a reader's own Proposals,
 * suggestions.ts) makes `shown` the public catalog's rule
 * (publicRecords.ts publiclyVisible) instead of whether the record
 * exists. `budgeted` (queries only) makes every uncached read first check
 * READ_RESERVE; a mutation's staleness check reads unbudgeted.
 */
export function proposalReads(
  ctx: QueryCtx,
  { publicOnly = false, budgeted = false }: { publicOnly?: boolean; budgeted?: boolean } = {},
) {
  let spent = false;
  /** Throw NotLoaded once the response is within READ_RESERVE of a limit; it stays spent. */
  const room = async () => {
    if (!budgeted) return;
    if (!spent) {
      const metrics = await ctx.meta.getTransactionMetrics();
      spent = RESERVED.some((name) => metrics[name].remaining < READ_RESERVE[name]);
    }
    if (spent) throw new NotLoaded();
  };
  /** `read`, once per key for the response, after `room`. */
  const once = <Key, Value>(keyOf: (key: Key) => string, read: (key: Key) => Promise<Value>) => {
    const cache = new Map<string, { value: Value }>();
    const get = async (key: Key) => {
      const hit = cache.get(keyOf(key));
      if (hit) return hit.value;
      await room();
      const value = await read(key);
      cache.set(keyOf(key), { value });
      return value;
    };
    return Object.assign(get, { cache });
  };
  const byRef = (ref: RecordRef) => ref.id;

  const anyDoc = once(String, (id: Id<TableNames>) => ctx.db.get(id));
  /**
   * Any document by id, read once: records, their parents, Revisions and
   * observations alike. Titles (catalogPages.ts TitleReads), visibility and
   * cover holders read through it too, so each of their reads is budgeted.
   */
  const get: RecordGet = async <T extends TableNames>(id: Id<T>) =>
    (await anyDoc(id)) as Doc<T> | null;
  const doc = (ref: RecordRef) => get(ref.id);
  /** An Edition's coverage rows, read once. */
  const coverage = once(String, (id: Id<"editions">) => coverageOf(ctx, id));
  /** A record's newest Revision, which is also its ops' usual base. */
  const latest = once(byRef, async (ref: RecordRef) => {
    const newest = await latestRevisionOf(ctx, ref);
    if (newest) anyDoc.cache.set(newest._id, { value: newest });
    return newest;
  });
  /** Whether the record may be shown as it is now (see `publicOnly`). */
  const shown = once(byRef, async (ref: RecordRef) => {
    const record = await doc(ref);
    return record !== null && (!publicOnly || (await publiclyVisible(ctx, ref.type, record, get)));
  });
  /** The record's title and page (moderation.ts displayInfo), "(missing record)" once it is gone. */
  const display = once(byRef, async (ref: RecordRef) => {
    const record = await doc(ref);
    return record
      ? await displayInfo(ctx, ref.type, record, { get, coverage })
      : { title: "(missing record)", backLink: null };
  });
  /**
   * An observation as evidence names it: its source and the page its
   * snapshot came from; "(not public)" with no page when `shown` refuses
   * the record it is linked to (publicRecords.ts observationPublic).
   */
  const cited = once(String, async (id: Id<"sourceObservations">) => {
    const found = await get(id);
    if (!found) return { sourceKey: "(missing)", url: null };
    if (publicOnly && !(found.recordRef && (await shown(found.recordRef)))) {
      return { sourceKey: "(not public)", url: null };
    }
    const snapshot = found.snapshot as { url?: unknown } | undefined;
    return {
      sourceKey: found.sourceKey,
      url: typeof snapshot?.url === "string" ? snapshot.url : null,
    };
  });
  return { room, get, doc, latest, shown, display, cited };
}

export type ProposalReads = ReturnType<typeof proposalReads>;
