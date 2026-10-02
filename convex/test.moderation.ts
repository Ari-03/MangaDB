// Shared setup for the moderation, merge/split and catalog-repair suites:
// sensitive operations as the Moderator, a one-Volume book, and the
// "Doubt!!" Series both repair suites split. Generic users, the backend and
// catalog rows come from test.helpers.ts and test.factories.ts.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { EntryOf } from "./lib/repair/entries";
import type { RecordRef } from "./moderation";
import {
  insertCoverage,
  insertEdition,
  insertRelease,
  insertSeries,
  insertVolume,
  type Overrides,
} from "./test.factories";
import { bob, signedIn, type TestT } from "./test.helpers";

// ---------- sensitive operations ----------

/** Merges `loser` into `survivor` as the Moderator bob, impact confirmed. */
export async function mergeAs(
  t: TestT,
  survivor: RecordRef,
  loser: RecordRef,
  reason = "Duplicate created by the import sweep.",
) {
  return await signedIn(t, bob).mutation(api.sensitiveOps.mergeRecords, {
    survivor,
    loser,
    reason,
    confirmImpact: true,
  });
}

type SingleRecordOp = "hideRecord" | "restoreRecord" | "lockRecord" | "unlockRecord" | "splitRecord";

/** One single-record sensitive operation on `ref` as the Moderator bob, impact confirmed. */
export async function moderate(t: TestT, op: SingleRecordOp, ref: RecordRef, reason: string) {
  return await signedIn(t, bob).mutation(api.sensitiveOps[op], { ref, reason, confirmImpact: true });
}

/** Splits a merged record back out as the Moderator bob. */
export async function splitAs(t: TestT, ref: RecordRef, reason = "The merge was a mistake.") {
  return await moderate(t, "splitRecord", ref, reason);
}

/** The Moderator's Hide of a catalog record (not a User's private override). */
export async function hideRecord(t: TestT, ref: RecordRef, reason = "Catalog maintenance.") {
  return await moderate(t, "hideRecord", ref, reason);
}

// ---------- catalog shapes ----------

/**
 * A book of one Volume: an Edition holding `volumeId` complete, and one
 * Release of it filed under `seriesId`. Overrides go to the Edition and the
 * Release.
 */
export async function insertBook(
  ctx: MutationCtx,
  args: {
    publisherId: Id<"publishers">;
    seriesId: Id<"series">;
    volumeId: Id<"volumes">;
    edition?: Overrides<"editions">;
    release?: Overrides<"releases">;
  },
) {
  const { publisherId, seriesId, volumeId } = args;
  const editionId = await insertEdition(ctx, { publisherId, ...args.edition });
  await insertCoverage(ctx, { editionId, volumeId });
  const releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], ...args.release });
  return { editionId, releaseId };
}

/**
 * "Doubt!!" (public id 500) holding two works: vol 1 is the staying work's,
 * the vol "2" label is shared (the moved work's Yen Press book sits on it),
 * and an unlabeled Volume is wholly the moved work's vol 1. One book on each.
 */
export async function insertDoubt(ctx: MutationCtx, publisherId: Id<"publishers">) {
  const source = await insertSeries(ctx, { publicId: 500, title: "Doubt!!", altTitles: ["Rabbit Doubt"] });
  const book = (volumeId: Id<"volumes">, isbn13: string) =>
    insertBook(ctx, { publisherId, seriesId: source, volumeId, release: { isbn13 } });
  const a1 = await insertVolume(ctx, { seriesId: source, label: "1", position: 1 });
  const shared2 = await insertVolume(ctx, { seriesId: source, label: "2", position: 2 });
  const unlabeled = await insertVolume(ctx, { seriesId: source, label: undefined, position: 3 });
  const a1Edition = await book(a1, "9781591169086");
  const b2Edition = await book(shared2, "9780316335164");
  const b1Edition = await book(unlabeled, "9780316335157");
  return { source, a1, shared2, unlabeled, a1Edition, b2Edition, b1Edition };
}

type Doubt = Awaited<ReturnType<typeof insertDoubt>>;

/**
 * The repair entry splitting the moved work out of "Doubt!!" as "Doubt":
 * the unlabeled Volume becomes its vol 1 and the shared-label book moves
 * to its vol "2".
 */
export function doubtSplit(d: Doubt, overrides: Partial<EntryOf<"splitSeries">> = {}): EntryOf<"splitSeries"> {
  return {
    kind: "splitSeries",
    key: "split:doubt",
    reason: "two works",
    sourceSeriesId: d.source,
    sourceTitle: "Doubt!!",
    title: "Doubt",
    altTitles: [],
    volumes: [{ volumeId: d.unlabeled, label: null, newLabel: "1", editionIds: [d.b1Edition.editionId] }],
    editions: [
      {
        editionId: d.b2Edition.editionId,
        fromVolumeIds: [d.shared2],
        labels: ["2"],
        releaseIds: [d.b2Edition.releaseId],
      },
    ],
    placeholderLabels: [],
    observationIds: [],
    ...overrides,
  };
}
