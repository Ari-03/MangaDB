// The sensitive catalog operations (spec §5): Hide, Restore, Lock, Unlock,
// Merge and Split. Each apply function checks the record's current state,
// performs the operation and appends immutable public Revisions; the direct
// Moderator mutations (../sensitiveOps.ts) and review-queue approval
// (../proposals.ts) share them, so both paths behave the same.
//
// Merge moves Source Observations, relationships, child records and user
// tracking to the survivor and points the loser at it (`status: "merged"`,
// `mergedIntoId`), which makes every losing-ID URL a permanent 301. What a
// merge moved goes in a mergeManifests row; Split, the only reversal,
// replays it backward and skips anything changed since.
//
// Neither Merge nor Split makes any User's tracking more visible on their
// public profile than it was just before. Both find the Users concerned
// through one enumeration (trackersOf), reading governance from the stored
// records, hidden ones included. Where tracking changes the Series it
// answers to, those Series absorb the overrides of the Series it left
// (absorbedFrom, stricterVisibility), and Split never widens an override it
// replays; a record the User does not track narrows nothing. Moving tracked
// Releases, Bundles or rated Editions between some Series and none is
// refused, since no override governs tracking with no Series.

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { primaryVolumeSeries } from "../catalogPages";
import { liveUser } from "./auth";
import { followMerges, mergeSurvivor } from "./merges";
import {
  displayInfo,
  getCanonical,
  insertRevision,
  revisionsOf,
  type CatalogDoc,
  type RecordRef,
} from "../moderation";
import {
  ratingsOf,
  recountRatings,
  reviewsOf,
  targetFields,
  targetOfRow,
  type TargetId,
} from "./ratings";
import { coverageOf, coveringOf, editionSeriesIds, releasesOf } from "./editionRows";
import { fail } from "./errors";
import { isbn13To10 } from "./isbn";
import { sameValue } from "./values";

// ---------- revision plumbing ----------

type Author = Doc<"proposals">["author"];

/** Who/why context every operation records on its Revisions. */
export type OpMeta = {
  proposalId: Id<"proposals">;
  author: Author;
  approvedBy?: Id<"users">;
  comment: string;
};

type Change = { field: string; before?: unknown; after?: unknown };

/** Append the next immutable Revision to one record's history. */
async function recordRevision(
  ctx: MutationCtx,
  ref: RecordRef,
  changes: Change[],
  meta: OpMeta,
): Promise<Id<"revisions">> {
  const latest = (await revisionsOf(ctx, ref))[0];
  return (await insertRevision(ctx, ref, latest, changes, meta)).revisionId;
}

async function requireRecord(ctx: MutationCtx, ref: RecordRef): Promise<CatalogDoc> {
  const doc = await getCanonical(ctx, ref);
  if (!doc) fail("notFound", `No such ${ref.type}.`);
  return doc;
}

// ---------- hide / restore / lock / unlock ----------

/**
 * An operation that flips one field of one record: `refuse` throws unless
 * the record may take it, then `patch` is written and `change` recorded as
 * its Revision. Nothing else about the record changes.
 */
type Toggle = {
  refuse: (doc: CatalogDoc, type: RecordRef["type"]) => void;
  patch: { status: "hidden" | "active" } | { locked: true | undefined };
  change: Change;
};

function toggleOp({ refuse, patch, change }: Toggle) {
  return async (ctx: MutationCtx, ref: RecordRef, meta: OpMeta): Promise<Id<"revisions">[]> => {
    const doc = await requireRecord(ctx, ref);
    refuse(doc, ref.type);
    await ctx.db.patch(ref.id, patch);
    return [await recordRevision(ctx, ref, [change], meta)];
  };
}

/**
 * Hide removes a record from public discovery while preserving its identity,
 * history, and every tracking reference. A hidden record is locked against
 * ordinary edits by its status.
 */
export const applyHide = toggleOp({
  refuse: (doc, type) => {
    if (doc.status !== "active") {
      fail("badState", `Only active records can be hidden; this ${type} is ${doc.status}.`);
    }
    if (doc.locked) fail("locked", "This record is temporarily locked — unlock it first.");
  },
  patch: { status: "hidden" },
  change: { field: "status", before: "active", after: "hidden" },
});

/** Restore reactivates a hidden record. It never reverses a merge (Split does). */
export const applyRestore = toggleOp({
  refuse: (doc, type) => {
    if (doc.status === "merged") {
      fail("badState", "A merged record is reversed only by an explicit Split — Restore cannot.");
    }
    if (doc.status !== "hidden") {
      fail("badState", `Only hidden records can be restored; this ${type} is ${doc.status}.`);
    }
  },
  patch: { status: "active" },
  change: { field: "status", before: "hidden", after: "active" },
});

/** A Moderator's temporary lock on an active record (disputes, spec §5). */
export const applyLock = toggleOp({
  refuse: (doc) => {
    if (doc.status !== "active") {
      fail("badState", `A ${doc.status} record is already locked by its status.`);
    }
    if (doc.locked) fail("badState", "This record is already locked.");
  },
  patch: { locked: true },
  change: { field: "locked", before: false, after: true },
});

export const applyUnlock = toggleOp({
  refuse: (doc) => {
    if (!doc.locked) fail("badState", "This record is not locked.");
  },
  patch: { locked: undefined },
  change: { field: "locked", before: true, after: false },
});

// ---------- the merge transfer engine ----------

/** Everything one merge physically did — persisted as the mergeManifests row. */
type TransferLog = {
  repointed: Array<{
    table: string;
    docId: string;
    field: string;
    before?: unknown;
    after?: unknown;
  }>;
  removed: Array<{ table: string; doc: unknown }>;
  inserted: Array<{ table: string; docId: string }>;
};

/** Patch fields on a row, logging each actual change for Split to reverse. */
async function repoint(
  ctx: MutationCtx,
  log: TransferLog,
  table: TableNames,
  doc: { _id: string },
  patch: Record<string, unknown>,
): Promise<void> {
  const current = doc as unknown as Record<string, unknown>;
  const applied: Record<string, unknown> = {};
  for (const [field, after] of Object.entries(patch)) {
    if (sameValue(current[field], after)) continue;
    applied[field] = after;
    log.repointed.push({ table, docId: doc._id, field, before: current[field], after });
  }
  if (Object.keys(applied).length === 0) return;
  await ctx.db.patch(doc._id as Id<TableNames>, applied as never);
}

/** Delete a row that would duplicate the survivor's, logging its contents. */
async function removeRow(
  ctx: MutationCtx,
  log: TransferLog,
  table: TableNames,
  doc: { _id: string },
): Promise<void> {
  const { _id, _creationTime, ...fields } = doc as unknown as {
    _id: string;
    _creationTime: number;
  } & Record<string, unknown>;
  void _creationTime;
  log.removed.push({ table, doc: fields });
  await ctx.db.delete(_id as Id<TableNames>);
}

/**
 * Repoint the loser's Source Observations and conflict suppressions at the
 * survivor — provenance follows the content on every merge (spec §4).
 */
async function transferProvenance(
  ctx: MutationCtx,
  log: TransferLog,
  loser: RecordRef,
  survivorId: Id<TableNames>,
): Promise<void> {
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", loser.type).eq("recordRef.id", loser.id))
    .collect();
  for (const observation of observations) {
    await repoint(ctx, log, "sourceObservations", observation, {
      recordRef: { type: loser.type, id: survivorId },
    });
  }
  const suppressions = await ctx.db
    .query("conflictSuppressions")
    .withIndex("by_key", (q) => q.eq("ref.type", loser.type).eq("ref.id", loser.id))
    .collect();
  for (const suppression of suppressions) {
    await repoint(ctx, log, "conflictSuppressions", suppression, {
      ref: { type: loser.type, id: survivorId },
    });
  }
}

/**
 * The Series a pass on a Release with these `seriesIds` is filed under: the
 * first, merge-followed (reading.ts passSeriesId); none without coverage.
 */
async function passSeriesOf(
  ctx: MutationCtx,
  seriesIds: Id<"series">[],
): Promise<Id<"series"> | undefined> {
  const first = seriesIds[0];
  if (!first) return undefined;
  return (await followMerges(ctx, "series", await ctx.db.get(first)))?._id ?? first;
}

/**
 * Recompute the release denorms (`seriesIds`, `publisherId` — spec §8) for
 * every release of one Edition from its current coverage, and file each
 * Release's passes under its first Series (passSeriesOf), logging changes.
 * Every operation that re-derives a Release's Series runs through here (a
 * merge logging to its manifest, Split to a scratch log), so a pass is
 * never left under the Series its Release left, and Split takes it back.
 */
async function recomputeReleaseDenorms(
  ctx: MutationCtx,
  log: TransferLog,
  editionId: Id<"editions">,
): Promise<void> {
  const edition = await ctx.db.get(editionId);
  if (!edition) return;
  const seriesIds = await editionSeriesIds(ctx, edition);
  const passSeriesId = await passSeriesOf(ctx, seriesIds);
  for (const release of await releasesOf(ctx, editionId)) {
    await repoint(ctx, log, "releases", release, {
      seriesIds,
      publisherId: edition.publisherId,
    });
    if (!passSeriesId) continue;
    const passes = await ctx.db
      .query("releaseProgress")
      .withIndex("by_release", (q) => q.eq("releaseId", release._id))
      .collect();
    for (const pass of passes) {
      await repoint(ctx, log, "releaseProgress", pass, { seriesId: passSeriesId });
    }
  }
}

// ---------- Tracking Visibility across canonical operations ----------

/** The two per-Series override fields of a userSeriesStates row (spec §3). */
const VISIBILITY_FIELDS = ["ownershipVisibility", "readingVisibility"] as const;
export type VisibilityField = (typeof VISIBILITY_FIELDS)[number];
/** A state row's overrides; an unset one follows the User's account default. */
export type VisibilityOverrides = Partial<Pick<Doc<"userSeriesStates">, VisibilityField>>;

/**
 * The override patch that keeps the `kept` Series from showing more than it
 * or any of the `others` did, both now and after any later change of the
 * User's account defaults. The one rule every canonical operation (merge,
 * Split, the data repair) applies whenever tracking changes the Series it
 * answers to. Per surface: an explicit private on any side stays private;
 * otherwise, if any side followed the default (no override, or no state
 * row: `null`), the result follows the default; public survives only where
 * every side was explicitly public. Returns just the fields that change (an
 * override going back to the default as `undefined`), limited to `fields`.
 */
export function stricterVisibility(
  kept: VisibilityOverrides | null,
  others: Array<VisibilityOverrides | null>,
  fields: readonly VisibilityField[] = VISIBILITY_FIELDS,
): VisibilityOverrides {
  const patch: VisibilityOverrides = {};
  for (const field of fields) {
    const sides = [kept, ...others].map((side) => side?.[field]);
    const combined = sides.includes("private")
      ? "private"
      : sides.includes(undefined)
        ? undefined
        : "public";
    if (combined !== kept?.[field]) patch[field] = combined;
  }
  return patch;
}

export const OWNERSHIP = ["ownershipVisibility"] as const;
export const READING = ["readingVisibility"] as const;

async function seriesStateOf(
  ctx: MutationCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
): Promise<Doc<"userSeriesStates"> | null> {
  return await ctx.db
    .query("userSeriesStates")
    .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
    .unique();
}

/**
 * The Series whose overrides govern tracking stored against these ids, as
 * the public profile resolves them (sharing.ts resolvedSeriesIds): merged
 * ones followed to their survivor, hidden ones kept as stored.
 */
async function governingSeries(
  ctx: MutationCtx,
  ids: Array<Id<"series">>,
): Promise<Array<Id<"series">>> {
  const out = new Set<Id<"series">>();
  for (const id of ids) {
    out.add((await followMerges(ctx, "series", await ctx.db.get(id)))?._id ?? id);
  }
  return [...out];
}

/**
 * Where a canonical operation writes the overrides it narrows (`state` is
 * the User's row on that Series, null for none yet), and whether it can be
 * reversed. A merge logs them in its manifest (manifestSink) and may be
 * Split, which moves tracking back; the data repair (repair/ops.ts) logs
 * them on its Proposal trail and is never reversed.
 */
export type OverrideSink = {
  reversible: boolean;
  write: (
    userId: Id<"users">,
    seriesId: Id<"series">,
    state: Doc<"userSeriesStates"> | null,
    patch: VisibilityOverrides,
  ) => Promise<void>;
};

/**
 * A merge's sink: a new state row is inserted bare, then gets its overrides
 * through `repoint`, so the manifest holds both (Split passes a scratch log;
 * what it writes is final).
 */
function manifestSink(ctx: MutationCtx, log: TransferLog): OverrideSink {
  return {
    reversible: true,
    write: async (userId, seriesId, state, patch) => {
      let row = state;
      if (!row) {
        const docId = await ctx.db.insert("userSeriesStates", {
          userId,
          seriesId,
          following: false,
          followPromptDismissed: false,
        });
        log.inserted.push({ table: "userSeriesStates", docId });
        row = await ctx.db.get(docId);
      }
      if (row) await repoint(ctx, log, "userSeriesStates", row, patch);
    },
  };
}

/**
 * How the profile gates tracking by its Series: "all" (a Release or Bundle,
 * sharing.ts seriesAllPublic: every Series must be public) or "one" (an
 * omnibus Rating, which follows whichever of its Edition's covered Series
 * the profile can show first, so hiding a record shifts which one).
 */
type Gate = "all" | "one";

/**
 * Whose overrides the `to` Series must absorb when tracking gated by `gate`
 * moves from the `from` Series (both merge-followed): null when nothing
 * needs narrowing (no Series to narrow, or no gate the tracking left), []
 * when it had none (the account default governed it), else the Series it
 * left: under "all" those `to` dropped, under "one" every candidate of
 * `from` unless the candidates are unchanged. Merges (carryVisibility, on
 * live state rows) and Split (keepSplitVisibility, on its snapshot) share it.
 */
function absorbedFrom(
  from: Array<Id<"series">>,
  to: Array<Id<"series">>,
  gate: Gate,
): Array<Id<"series">> | null {
  if (to.length === 0) return null;
  if (from.length === 0) return [];
  if (gate === "one") return sameValue(from, to) ? null : from;
  const dropped = from.filter((id) => !to.includes(id));
  return dropped.length > 0 ? dropped : null;
}

/**
 * One User's tracking on some surfaces answered to the `from` Series and now
 * answers to the `to` Series (a cross-Series merge moved it or re-derived
 * its Release's Series; a repair re-parented its Volume). Every `to` Series
 * absorbs the overrides of the Series the tracking left (absorbedFrom under
 * `gate`, stricterVisibility), on a new state row where the User had none.
 * Split removes such a row only once it is bare again. A carry to no
 * Series is a no-op; callers refuse that case (refuseSeriesChange).
 */
export async function carryVisibility(
  ctx: MutationCtx,
  sink: OverrideSink,
  userId: Id<"users">,
  fields: readonly VisibilityField[],
  from: Array<Id<"series">>,
  to: Array<Id<"series">>,
  gate: Gate = "all",
): Promise<void> {
  const toIds = await governingSeries(ctx, to);
  const absorbed = absorbedFrom(await governingSeries(ctx, from), toIds, gate);
  if (!absorbed) return;
  const sources =
    absorbed.length === 0
      ? [null]
      : await Promise.all(absorbed.map((id) => seriesStateOf(ctx, userId, id)));
  for (const seriesId of toIds) await narrowState(ctx, sink, userId, seriesId, sources, fields);
}

/** Narrow one User's state row on a Series to stricterVisibility against `sources`, through `sink`. */
async function narrowState(
  ctx: MutationCtx,
  sink: OverrideSink,
  userId: Id<"users">,
  seriesId: Id<"series">,
  sources: Array<VisibilityOverrides | null>,
  fields: readonly VisibilityField[] = VISIBILITY_FIELDS,
): Promise<void> {
  const state = await seriesStateOf(ctx, userId, seriesId);
  const patch = stricterVisibility(state, sources, fields);
  if (Object.keys(patch).length > 0) await sink.write(userId, seriesId, state, patch);
}

/**
 * Refuse a merge that moves a Release, Bundle or rated Edition from some
 * Series to none, or a tracked one (`tracked`, asked only then) from none
 * to some. With no
 * Series the account default alone governs its tracking, which no override
 * can narrow: losing its Series would drop an explicit private choice, and
 * gaining one would let the Split back to none drop any private choice the
 * User made on the new Series in between (an operation nothing reverses
 * passes `tracked` = null: gaining a Series only narrows it then). One
 * tracked only since the merge is caught by the Split (keepSplitVisibility).
 */
async function refuseSeriesChange(
  from: Array<Id<"series">>,
  to: Array<Id<"series">>,
  tracked: (() => Promise<boolean>) | null,
): Promise<void> {
  if (from.length > 0 && to.length === 0) {
    fail(
      "badMerge",
      "This merge would leave a Release or rated Edition with no Series. Map the surviving Edition's Volume Coverage first, or merge the other way.",
    );
  }
  if (from.length === 0 && to.length > 0 && tracked && (await tracked())) {
    fail(
      "badMerge",
      "This merge would give tracked Releases or Bundles that have no Series one, which a later Split could not keep private. Map their Volume Coverage or Bundle members first.",
    );
  }
}

/** Whether any User has a collection entry on a Bundle. */
async function bundleTracked(ctx: MutationCtx, bundleId: Id<"releaseBundles">) {
  return (
    (await ctx.db
      .query("collectionEntries")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
      .first()) !== null
  );
}

/** Whether any User tracks a Release: an entry or pass on it, or an entry on a Bundle holding it. */
async function releaseTracked(ctx: MutationCtx, releaseId: Id<"releases">) {
  const entry = await ctx.db
    .query("collectionEntries")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .first();
  const pass = await ctx.db
    .query("releaseProgress")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .first();
  if (entry || pass) return true;
  for (const bundleId of await bundlesOf(ctx, releaseId)) {
    if (await bundleTracked(ctx, bundleId)) return true;
  }
  return false;
}

/**
 * The Series a Bundle's ownership answers to on the profile: its member
 * Releases' (merge-followed) Series, as sharing.ts publicProfile reads them.
 */
export async function bundleSeries(ctx: MutationCtx, bundleId: Id<"releaseBundles">) {
  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
    .collect();
  const out = new Set<Id<"series">>();
  for (const membership of memberships) {
    const stored = await ctx.db.get(membership.releaseId);
    const release = (await followMerges(ctx, "releases", stored)) ?? stored;
    for (const id of release?.seriesIds ?? []) out.add(id);
  }
  return [...out];
}

/** The Users owning a Bundle (profile-visible Owned entries only). */
export async function bundleOwners(ctx: MutationCtx, bundleId: Id<"releaseBundles">) {
  return [...(await trackersOf(ctx, { bundles: [bundleId] })).trackers.keys()];
}

/** The Bundles holding a Release. */
async function bundlesOf(ctx: MutationCtx, releaseId: Id<"releases">) {
  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .collect();
  return [...new Set(memberships.map((row) => row.bundleId))];
}

// ---------- who tracks what ----------

/** The catalog records whose tracking the profile gates by Series, by kind. */
const RECORD_TABLES = {
  series: "series",
  lines: "editionLines",
  volumes: "volumes",
  editions: "editions",
  releases: "releases",
  bundles: "releaseBundles",
} as const;
type RecordKind = keyof typeof RECORD_TABLES;
type RecordId<K extends RecordKind> = Id<(typeof RECORD_TABLES)[K]>;
/** Catalog records by kind. */
type Records = { [K in RecordKind]?: Iterable<RecordId<K>> };
type RecordSets = { [K in RecordKind]: Set<RecordId<K>> };
/**
 * Each User with a profile surface on some records → each such record (by
 * id) → the overrides governing the User's tracking of it.
 */
type Trackers = Map<Id<"users">, Map<string, Set<VisibilityField>>>;

const union = <K extends RecordKind>(kind: K, all: Records[]): Set<RecordId<K>> =>
  new Set(all.flatMap((records) => [...(records[kind] ?? [])]));

/** The records of all these collections, by kind. */
const recordSets = (...all: Records[]): RecordSets => ({
  series: union("series", all),
  lines: union("lines", all),
  volumes: union("volumes", all),
  editions: union("editions", all),
  releases: union("releases", all),
  bundles: union("bundles", all),
});

/**
 * The personal tables, and the overrides deciding whether one of their rows
 * shows on its owner's profile (sharing.ts publicProfile): Ownership for an
 * entry (Owned only, surfacesOf), Reading for a read count, pass or Rating,
 * and both for a state row, which holds them.
 */
const PERSONAL_SURFACES: Partial<Record<string, readonly VisibilityField[]>> = {
  collectionEntries: OWNERSHIP,
  userSeriesStates: VISIBILITY_FIELDS,
  volumeProgress: READING,
  releaseProgress: READING,
  ratings: READING,
};

/** The overrides governing one row of `table` on the profile; none for Wanted/Ordered entries or other tables. */
function surfacesOf(table: string, row: { state?: unknown }): readonly VisibilityField[] {
  if (table === "collectionEntries" && row.state !== "owned") return [];
  return PERSONAL_SURFACES[table] ?? [];
}

/** Record that a User tracks one record on these surfaces. */
function addTracker(
  trackers: Trackers,
  userId: Id<"users">,
  recordId: string,
  fields: Iterable<VisibilityField>,
) {
  const records = trackers.get(userId) ?? new Map<string, Set<VisibilityField>>();
  const known = records.get(recordId) ?? new Set<VisibilityField>();
  for (const field of fields) known.add(field);
  if (known.size === 0) return;
  records.set(recordId, known);
  trackers.set(userId, records);
}

/** Every surface a User tracks among their records. */
const surfacesTracked = (tracked: Map<string, Set<VisibilityField>> | undefined) => [
  ...new Set([...(tracked?.values() ?? [])].flatMap((fields) => [...fields])),
];

/**
 * These records and every record whose Series derive from theirs, as the
 * database stands: a Series' Volumes and Edition Lines, the Editions on a
 * line or covering a Volume, an Edition's Releases (their `seriesIds` come
 * from its coverage or line), and the Bundles holding a Release (theirs
 * come from their members).
 */
async function withDependents(ctx: MutationCtx, records: Records): Promise<RecordSets> {
  const out = recordSets(records);
  for (const seriesId of out.series) {
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect();
    for (const volume of volumes) out.volumes.add(volume._id);
    const lines = await ctx.db
      .query("editionLines")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect();
    for (const line of lines) out.lines.add(line._id);
  }
  for (const lineId of out.lines) {
    const editions = await ctx.db
      .query("editions")
      .withIndex("by_line", (q) => q.eq("editionLineId", lineId))
      .collect();
    for (const edition of editions) out.editions.add(edition._id);
  }
  for (const volumeId of out.volumes) {
    const coverage = await coveringOf(ctx, volumeId);
    for (const row of coverage) out.editions.add(row.editionId);
  }
  for (const editionId of out.editions) {
    for (const release of await releasesOf(ctx, editionId)) out.releases.add(release._id);
  }
  for (const releaseId of out.releases) {
    for (const bundleId of await bundlesOf(ctx, releaseId)) out.bundles.add(bundleId);
  }
  return out;
}

/**
 * Who tracks what an operation touches: the one enumeration of affected
 * Users that merges and Split share. `records`: the touched records with
 * everything under them (withDependents); `trackers`: every User with a
 * profile surface on any of those (trackersIn).
 */
async function trackersOf(
  ctx: MutationCtx,
  touched: Records,
): Promise<{ records: RecordSets; trackers: Trackers }> {
  const records = await withDependents(ctx, touched);
  return { records, trackers: await trackersIn(ctx, records) };
}

/**
 * Every User with a profile surface on these records, per record, and the
 * overrides governing it. A Series: state rows, Series Ratings, and the
 * passes filed under it. A Volume: its read counts. An Edition:
 * its omnibus Ratings. A Release: its entries and passes. A Bundle: its
 * entries. Reviews, Volume Ratings and Favorites are no surface of Tracking
 * Visibility: the profile lists Reviews whatever it is and never shows the
 * other two.
 */
async function trackersIn(ctx: MutationCtx, records: RecordSets): Promise<Trackers> {
  const trackers: Trackers = new Map();
  const add = (
    table: TableNames,
    recordId: string,
    rows: Array<{ userId: Id<"users">; state?: unknown }>,
  ) => {
    for (const row of rows) addTracker(trackers, row.userId, recordId, surfacesOf(table, row));
  };
  for (const seriesId of records.series) {
    for (const table of ["userSeriesStates", "ratings", "releaseProgress"] as const) {
      add(
        table,
        seriesId,
        await ctx.db
          .query(table)
          .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
          .collect(),
      );
    }
  }
  for (const volumeId of records.volumes) {
    add(
      "volumeProgress",
      volumeId,
      await ctx.db
        .query("volumeProgress")
        .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
        .collect(),
    );
  }
  for (const editionId of records.editions) {
    add("ratings", editionId, await ratingsOf(ctx, { kind: "edition", id: editionId }));
  }
  for (const releaseId of records.releases) {
    for (const table of ["collectionEntries", "releaseProgress"] as const) {
      add(
        table,
        releaseId,
        await ctx.db
          .query(table)
          .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
          .collect(),
      );
    }
  }
  for (const bundleId of records.bundles) {
    add(
      "collectionEntries",
      bundleId,
      await ctx.db
        .query("collectionEntries")
        .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
        .collect(),
    );
  }
  return trackers;
}

/**
 * The Series an Edition's omnibus Ratings may answer to on the profile, read
 * before any display filter: every covered Series in coverage order, hidden
 * Volumes and Series included, or its line's (editionSeriesIds); none once
 * the Edition is gone. The profile follows the first it can show
 * (lib/ratings.ts omnibusEdition), so any of them may govern (gate "one").
 */
async function editionRatedSeries(ctx: MutationCtx, editionId: Id<"editions">) {
  const edition = await ctx.db.get(editionId);
  return edition ? await editionSeriesIds(ctx, edition) : [];
}

/**
 * What an Edition's tracking answers to right now: each of its Releases'
 * stored Series (what the public profile reads) and the Series its omnibus
 * Ratings may ride on (editionRatedSeries). Taken before an operation
 * re-derives them, for carryEditionTracking / carryReleaseTracking.
 */
export async function editionGovernance(ctx: MutationCtx, editionId: Id<"editions">) {
  const releases = await releasesOf(ctx, editionId);
  return {
    releaseSeries: new Map(releases.map((release) => [release._id, release.seriesIds])),
    ratedSeries: await editionRatedSeries(ctx, editionId),
  };
}
export type EditionGovernance = Awaited<ReturnType<typeof editionGovernance>>;

/**
 * A Release's Series were re-derived (`from` → its current `seriesIds`,
 * wherever it now sits): carry the Tracking Visibility of everyone tracking
 * it (trackersOf: Owned entries, owners of Bundles holding it, and active
 * passes). A Release that would lose every Series, or (in a reversible
 * operation) a tracked one that had none, is refused (refuseSeriesChange).
 */
async function carryReleaseTracking(
  ctx: MutationCtx,
  sink: OverrideSink,
  releaseId: Id<"releases">,
  from: Array<Id<"series">>,
): Promise<void> {
  const release = await ctx.db.get(releaseId);
  if (!release || sameValue(release.seriesIds, from)) return;
  await refuseSeriesChange(
    from,
    release.seriesIds,
    sink.reversible ? () => releaseTracked(ctx, releaseId) : null,
  );
  for (const [userId, tracked] of (await trackersOf(ctx, { releases: [releaseId] })).trackers) {
    await carryVisibility(ctx, sink, userId, surfacesTracked(tracked), from, release.seriesIds);
  }
}

/**
 * An operation re-derived an Edition's Series (`before`, from
 * editionGovernance taken first): carry the trackers of each Release it had
 * (carryReleaseTracking) and the Reading visibility of its omnibus Ratings,
 * which ride on one of its covered Series rather than its Releases' all
 * (carryEditionRatings).
 */
export async function carryEditionTracking(
  ctx: MutationCtx,
  sink: OverrideSink,
  editionId: Id<"editions">,
  before: EditionGovernance,
): Promise<void> {
  for (const [releaseId, from] of before.releaseSeries) {
    await carryReleaseTracking(ctx, sink, releaseId, from);
  }
  await carryEditionRatings(ctx, sink, editionId, before.ratedSeries);
}

/**
 * The omnibus Ratings on an Edition (of `raters`, else all of them) rode on
 * the `from` Series (editionRatedSeries taken first) and now ride on its
 * current ones: carry their Reading visibility under gate "one". Losing
 * every Series is refused, as for a Release (refuseSeriesChange); so is
 * gaining one in a reversible operation, since the Raters track it.
 */
async function carryEditionRatings(
  ctx: MutationCtx,
  sink: OverrideSink,
  editionId: Id<"editions">,
  from: Array<Id<"series">>,
  raters?: Array<Id<"users">>,
): Promise<void> {
  const userIds =
    raters ?? (await ratingsOf(ctx, { kind: "edition", id: editionId })).map((row) => row.userId);
  if (userIds.length === 0) return;
  const to = await editionRatedSeries(ctx, editionId);
  await refuseSeriesChange(from, to, sink.reversible ? async () => true : null);
  for (const userId of userIds) await carryVisibility(ctx, sink, userId, READING, from, to, "one");
}

/**
 * A Series merge's Users who keep a survivor state row but had none on the
 * loser: their loser tracking followed the account default, so an explicit
 * public survivor override would publish it. On each surface they track on
 * `loser` (the loser with its dependents, read before anything moves), that
 * override goes back to the default (stricterVisibility against a missing
 * row), logged for Split. Users with a loser row (`handled`) are combined as
 * their rows merge; Users with no row on either side follow the default on
 * both, which the merge leaves as it was.
 */
async function guardSurvivorOverrides(
  ctx: MutationCtx,
  log: TransferLog,
  loser: RecordSets,
  survivorId: Id<"series">,
  handled: Set<Id<"users">>,
): Promise<void> {
  const candidates = (
    await ctx.db
      .query("userSeriesStates")
      .withIndex("by_series", (q) => q.eq("seriesId", survivorId))
      .collect()
  ).filter((row) => !handled.has(row.userId) && VISIBILITY_FIELDS.some((f) => row[f] === "public"));
  if (candidates.length === 0) return;
  const trackers = await trackersIn(ctx, loser);
  for (const row of candidates) {
    const surfaces = surfacesTracked(trackers.get(row.userId));
    const fields = VISIBILITY_FIELDS.filter((f) => row[f] === "public" && surfaces.includes(f));
    await repoint(ctx, log, "userSeriesStates", row, stricterVisibility(row, [null], fields));
  }
}

/**
 * Move the loser's Ratings and Reviews to the survivor, one per user × target:
 * where a user already rated or reviewed the survivor, the survivor's row
 * wins and the loser's is removed (Split reinserts it). The two may be of
 * different kinds (an omnibus collapsing onto its Volume): the loser's key
 * is cleared as the survivor's is set, so a row keeps exactly one. The
 * aggregates are recounted afterwards (`recountRatings`), not logged.
 */
async function transferRatingsAndReviews(
  ctx: MutationCtx,
  log: TransferLog,
  loser: TargetId,
  survivor: TargetId,
): Promise<void> {
  const patch = {
    seriesId: undefined,
    volumeId: undefined,
    editionId: undefined,
    ...targetFields(survivor),
  };
  const survivorRatings = new Set((await ratingsOf(ctx, survivor)).map((row) => row.userId));
  for (const row of await ratingsOf(ctx, loser)) {
    if (survivorRatings.has(row.userId)) await removeRow(ctx, log, "ratings", row);
    else await repoint(ctx, log, "ratings", row, patch);
  }
  const survivorReviews = new Set((await reviewsOf(ctx, survivor)).map((row) => row.userId));
  for (const row of await reviewsOf(ctx, loser)) {
    if (survivorReviews.has(row.userId)) await removeRow(ctx, log, "reviews", row);
    else await repoint(ctx, log, "reviews", row, patch);
  }
}

/**
 * Keep an Edition's own Ratings, Reviews and Favorites reachable once its
 * coverage names exactly one Volume (a Volume merge or a remap), since it is
 * then rated through that Volume (lib/ratings.ts omnibusEdition): they move
 * to the Volume, the Volume's row winning where a user has both, and both
 * aggregates are recounted. Moves land in `log`, so a merge's manifest lets
 * Split put them back; without a log the collapse is one-way. Returns how
 * many rows moved or were removed.
 */
export async function collapseEditionTakes(
  ctx: MutationCtx,
  editionId: Id<"editions">,
  log: TransferLog = { repointed: [], removed: [], inserted: [] },
): Promise<number> {
  const coverage = await coverageOf(ctx, editionId);
  const volumeIds = [...new Set(coverage.map((row) => row.volumeId))];
  const volume = volumeIds.length === 1 ? await ctx.db.get(volumeIds[0]!) : null;
  if (!volume) return 0;
  const edition: TargetId = { kind: "edition", id: editionId };
  const target: TargetId = { kind: "volume", id: volume._id };
  const before = log.repointed.length + log.removed.length;
  await transferRatingsAndReviews(ctx, log, edition, target);
  const favorites = await ctx.db
    .query("favorites")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
  for (const row of favorites) {
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_volume", (q) => q.eq("userId", row.userId).eq("volumeId", volume._id))
      .unique();
    if (existing) await removeRow(ctx, log, "favorites", row);
    else {
      await repoint(ctx, log, "favorites", row, {
        editionId: undefined,
        volumeId: volume._id,
        seriesId: volume.seriesId,
      });
    }
  }
  const moved = log.repointed.length + log.removed.length - before;
  if (moved > 0) {
    await recountRatings(ctx, edition);
    await recountRatings(ctx, target);
  }
  return moved;
}

/**
 * Ratings, Reviews and Favorites left on Editions covering this Volume and
 * exactly one other: what `collapseEditionTakes` would move to the survivor
 * if the two Volumes were merged. The impact preview's count.
 */
async function collapsibleTakes(ctx: QueryCtx, volumeId: Id<"volumes">): Promise<number> {
  const covering = await coveringOf(ctx, volumeId);
  let count = 0;
  for (const editionId of new Set(covering.map((row) => row.editionId))) {
    const rows = await coverageOf(ctx, editionId);
    if (new Set(rows.map((row) => row.volumeId)).size !== 2) continue;
    const target: TargetId = { kind: "edition", id: editionId };
    count += (await ratingsOf(ctx, target)).length + (await reviewsOf(ctx, target)).length;
    count += (
      await ctx.db
        .query("favorites")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId))
        .collect()
    ).length;
  }
  return count;
}

/** A Series, Volume or Edition ref as a rating target; other record types have none. */
function ratingTarget(ref: RecordRef): TargetId | null {
  if (ref.type === "series") return { kind: "series", id: ref.id };
  if (ref.type === "volume") return { kind: "volume", id: ref.id };
  if (ref.type === "edition") return { kind: "edition", id: ref.id };
  return null;
}

/** Recount both sides' rating aggregates after a merge or split moved Ratings. */
async function recountMergedRatings(ctx: MutationCtx, a: RecordRef, b: RecordRef) {
  for (const ref of [a, b]) {
    const target = ratingTarget(ref);
    if (target) await recountRatings(ctx, target);
  }
}

/**
 * Every rating target a manifest moved Ratings onto or off. Beyond the
 * merge's own two records these are the Editions a Volume merge collapsed
 * (collapseEditionTakes), which Split recounts once the Ratings are back.
 */
function ratingTargetsIn(manifests: Array<Doc<"mergeManifests">>): TargetId[] {
  type Keys = Parameters<typeof targetOfRow>[0];
  const keys = new Set(["seriesId", "volumeId", "editionId"]);
  const targets = new Map<string, TargetId>();
  // Manifest values are stored untyped (v.any()); these are rating keys.
  const add = (row: Keys) => {
    const target = targetOfRow(row);
    if (target) targets.set(target.id, target);
  };
  for (const manifest of manifests) {
    for (const entry of manifest.repointed) {
      if (entry.table !== "ratings" || !keys.has(entry.field)) continue;
      add({ [entry.field]: entry.before } as Keys);
      add({ [entry.field]: entry.after } as Keys);
    }
    for (const row of manifest.removed) {
      if (row.table === "ratings") add(row.doc as Keys);
    }
  }
  return [...targets.values()];
}

/**
 * Transfer every compatible reference from the merge loser to the survivor:
 * child records, relationship edges, and user tracking. Where a transferred
 * row would duplicate one the survivor already has (a user tracking both
 * duplicates, an edge both records carried), the survivor's row wins and the
 * loser's is deleted — recorded in the manifest so Split reinserts it.
 */
async function transferReferences(
  ctx: MutationCtx,
  log: TransferLog,
  type: RecordRef["type"],
  loserDoc: CatalogDoc,
  survivorDoc: CatalogDoc,
): Promise<void> {
  const sink = manifestSink(ctx, log);
  switch (type) {
    case "publisher": {
      const loser = loserDoc as Doc<"publishers">;
      const survivor = survivorDoc as Doc<"publishers">;
      // Imprints follow their parent company, one level deep. A survivor that
      // was the loser's own imprint becomes top-level (it cannot parent
      // itself); a survivor that is another company's imprint cannot take
      // the loser's imprints, so the merge is refused until they move.
      const imprints = (
        await ctx.db
          .query("publishers")
          .withIndex("by_parent", (q) => q.eq("parentPublisherId", loser._id))
          .collect()
      ).filter((row) => row.status !== "merged" && row._id !== survivor._id);
      const survivorParent =
        survivor.parentPublisherId === loser._id ? undefined : survivor.parentPublisherId;
      if (imprints.length > 0 && survivorParent !== undefined) {
        fail(
          "badMerge",
          "The survivor is itself an imprint, and imprints nest one level only — give the loser's imprints another parent first.",
        );
      }
      await repoint(ctx, log, "publishers", survivor, { parentPublisherId: survivorParent });
      for (const imprint of imprints) {
        await repoint(ctx, log, "publishers", imprint, { parentPublisherId: survivor._id });
      }
      // editionLines and releaseBundles have no publisher index; both tables
      // are small enough for a rare moderator action to scan.
      for (const line of await ctx.db.query("editionLines").collect()) {
        if (line.publisherId !== loser._id) continue;
        await repoint(ctx, log, "editionLines", line, { publisherId: survivor._id });
      }
      const editions = await ctx.db
        .query("editions")
        .withIndex("by_publisher", (q) => q.eq("publisherId", loser._id))
        .collect();
      for (const edition of editions) {
        await repoint(ctx, log, "editions", edition, { publisherId: survivor._id });
      }
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_publisher_date", (q) => q.eq("publisherId", loser._id))
        .collect();
      for (const release of releases) {
        await repoint(ctx, log, "releases", release, { publisherId: survivor._id });
      }
      for (const bundle of await ctx.db.query("releaseBundles").collect()) {
        if (bundle.publisherId !== loser._id) continue;
        await repoint(ctx, log, "releaseBundles", bundle, { publisherId: survivor._id });
      }
      // The loser's slug keeps resolving: existing redirects repoint and the
      // loser's own slug becomes a redirect (publishers are the slug-only
      // URL exception, spec §11).
      for (const redirect of await ctx.db.query("publisherSlugRedirects").collect()) {
        if (redirect.publisherId !== loser._id) continue;
        await repoint(ctx, log, "publisherSlugRedirects", redirect, {
          publisherId: survivor._id,
        });
      }
      const redirectId = await ctx.db.insert("publisherSlugRedirects", {
        fromSlug: loser.slug,
        publisherId: survivor._id,
      });
      log.inserted.push({ table: "publisherSlugRedirects", docId: redirectId });
      return;
    }

    case "seriesFamily": {
      const members = await ctx.db
        .query("series")
        .withIndex("by_family", (q) => q.eq("familyId", loserDoc._id as Id<"seriesFamilies">))
        .collect();
      for (const member of members) {
        await repoint(ctx, log, "series", member, { familyId: survivorDoc._id });
      }
      return;
    }

    case "series": {
      const loserId = loserDoc._id as Id<"series">;
      const survivorId = survivorDoc._id as Id<"series">;

      // Read before anything moves (afterwards nothing leads back): the
      // Editions whose release denorms name the loser (on its Edition Lines
      // or covering its Volumes), and survivor overrides that would publish
      // loser tracking (guardSurvivorOverrides).
      const dependents = await withDependents(ctx, { series: [loserId] });
      const affectedEditions = dependents.editions;
      const states = await ctx.db
        .query("userSeriesStates")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      await guardSurvivorOverrides(
        ctx,
        log,
        dependents,
        survivorId,
        new Set(states.map((state) => state.userId)),
      );
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();

      // Volumes append after the survivor's reading path (positions offset
      // past its max) so the merged sequence stays unambiguous; a Moderator
      // reorders or merges duplicate Volumes afterwards as needed.
      const survivorVolumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", survivorId))
        .collect();
      const offset = survivorVolumes.reduce((max, v) => Math.max(max, v.position), 0);
      for (const volume of [...volumes].sort((a, b) => a.position - b.position)) {
        await repoint(ctx, log, "volumes", volume, {
          seriesId: survivorId,
          position: offset + volume.position,
        });
      }

      const lines = await ctx.db
        .query("editionLines")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const line of lines) {
        await repoint(ctx, log, "editionLines", line, { seriesId: survivorId });
      }

      // Relationship edges: self-edges (loser ↔ survivor) and edges the
      // survivor already carries are dropped; the rest repoint.
      const survivorFrom = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_from", (q) => q.eq("fromSeriesId", survivorId))
        .collect();
      const survivorTo = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_to", (q) => q.eq("toSeriesId", survivorId))
        .collect();
      const fromEdges = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_from", (q) => q.eq("fromSeriesId", loserId))
        .collect();
      for (const edge of fromEdges) {
        const duplicate = survivorFrom.some(
          (e) => e.toSeriesId === edge.toSeriesId && e.type === edge.type,
        );
        if (edge.toSeriesId === survivorId || duplicate) {
          await removeRow(ctx, log, "seriesRelationships", edge);
        } else {
          await repoint(ctx, log, "seriesRelationships", edge, {
            fromSeriesId: survivorId,
          });
        }
      }
      const toEdges = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_to", (q) => q.eq("toSeriesId", loserId))
        .collect();
      for (const edge of toEdges) {
        const duplicate = survivorTo.some(
          (e) => e.fromSeriesId === edge.fromSeriesId && e.type === edge.type,
        );
        if (edge.fromSeriesId === survivorId || duplicate) {
          await removeRow(ctx, log, "seriesRelationships", edge);
        } else {
          await repoint(ctx, log, "seriesRelationships", edge, {
            toSeriesId: survivorId,
          });
        }
      }

      // User tracking: one row per user × series — the survivor's row wins,
      // but never with a wider Tracking Visibility than either side had
      // (a side without a row followed the default; guarded above).
      for (const state of states) {
        const existing = await seriesStateOf(ctx, state.userId, survivorId);
        if (existing) {
          await removeRow(ctx, log, "userSeriesStates", state);
          await repoint(
            ctx,
            log,
            "userSeriesStates",
            existing,
            stricterVisibility(existing, [state]),
          );
        } else {
          await repoint(ctx, log, "userSeriesStates", state, {
            seriesId: survivorId,
            ...stricterVisibility(state, [null]),
          });
        }
      }
      // Passes key on user × release, which the merge does not change —
      // repoint the series denorm only. Read counts follow their Volumes.
      const releaseProgress = await ctx.db
        .query("releaseProgress")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const row of releaseProgress) {
        await repoint(ctx, log, "releaseProgress", row, { seriesId: survivorId });
      }
      await transferRatingsAndReviews(
        ctx,
        log,
        { kind: "series", id: loserId },
        { kind: "series", id: survivorId },
      );
      // Favorites: a Series favorite moves over unless the user already
      // favorited the survivor; a Volume or Edition favorite keeps its
      // target (a Volume just moved above) and follows it with the Series
      // denorm.
      const favorites = await ctx.db
        .query("favorites")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const row of favorites) {
        if (row.volumeId === undefined && row.editionId === undefined) {
          const existing = await ctx.db
            .query("favorites")
            .withIndex("by_user_series", (q) =>
              q
                .eq("userId", row.userId)
                .eq("seriesId", survivorId)
                .eq("volumeId", undefined)
                .eq("editionId", undefined),
            )
            .unique();
          if (existing) {
            await removeRow(ctx, log, "favorites", row);
            continue;
          }
        }
        await repoint(ctx, log, "favorites", row, { seriesId: survivorId });
      }
      // Comments carry the Series on every row (Volume Comments too, whose
      // Volumes just moved above); there is no per-user clash to resolve.
      const comments = await ctx.db
        .query("comments")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const row of comments) {
        await repoint(ctx, log, "comments", row, { seriesId: survivorId });
      }

      for (const editionId of affectedEditions) {
        await recomputeReleaseDenorms(ctx, log, editionId);
      }
      return;
    }

    case "volume": {
      const loserId = loserDoc._id as Id<"volumes">;
      const survivorId = survivorDoc._id as Id<"volumes">;
      const survivor = survivorDoc as Doc<"volumes">;

      const coverage = await coveringOf(ctx, loserId);
      const affectedEditions = new Set(coverage.map((row) => row.editionId));
      // A cross-Series merge re-derives these Editions' Series; what the
      // tracking answered to before is carried below (carryEditionTracking).
      const loserSeriesId = (loserDoc as Doc<"volumes">).seriesId;
      const crossSeries = loserSeriesId !== survivor.seriesId;
      const governedBefore = new Map<Id<"editions">, EditionGovernance>();
      if (crossSeries) {
        for (const editionId of affectedEditions) {
          governedBefore.set(editionId, await editionGovernance(ctx, editionId));
        }
      }
      for (const row of coverage) {
        const editionRows = await coverageOf(ctx, row.editionId);
        if (editionRows.some((r) => r.volumeId === survivorId)) {
          await removeRow(ctx, log, "volumeCoverages", row);
        } else {
          await repoint(ctx, log, "volumeCoverages", row, { volumeId: survivorId });
        }
      }

      const progress = await ctx.db
        .query("volumeProgress")
        .withIndex("by_volume", (q) => q.eq("volumeId", loserId))
        .collect();
      for (const row of progress) {
        const existing = await ctx.db
          .query("volumeProgress")
          .withIndex("by_user_volume", (q) => q.eq("userId", row.userId).eq("volumeId", survivorId))
          .unique();
        if (existing) await removeRow(ctx, log, "volumeProgress", row);
        else {
          await repoint(ctx, log, "volumeProgress", row, { volumeId: survivorId });
          if (crossSeries) {
            await carryVisibility(
              ctx,
              sink,
              row.userId,
              READING,
              [loserSeriesId],
              [survivor.seriesId],
            );
          }
        }
      }
      await transferRatingsAndReviews(
        ctx,
        log,
        { kind: "volume", id: loserId },
        { kind: "volume", id: survivorId },
      );
      const favorites = await ctx.db
        .query("favorites")
        .withIndex("by_volume", (q) => q.eq("volumeId", loserId))
        .collect();
      for (const row of favorites) {
        const existing = await ctx.db
          .query("favorites")
          .withIndex("by_user_volume", (q) => q.eq("userId", row.userId).eq("volumeId", survivorId))
          .unique();
        if (existing) await removeRow(ctx, log, "favorites", row);
        else {
          await repoint(ctx, log, "favorites", row, {
            volumeId: survivorId,
            seriesId: survivor.seriesId,
          });
        }
      }
      const comments = await ctx.db
        .query("comments")
        .withIndex("by_volume", (q) => q.eq("volumeId", loserId))
        .collect();
      for (const row of comments) {
        await repoint(ctx, log, "comments", row, {
          volumeId: survivorId,
          seriesId: survivor.seriesId,
        });
      }

      // An omnibus of just these two Volumes now covers one: its Ratings,
      // Reviews and Favorites move to the survivor (Split moves them back).
      for (const editionId of affectedEditions) {
        await recomputeReleaseDenorms(ctx, log, editionId);
        await collapseEditionTakes(ctx, editionId, log);
        const before = governedBefore.get(editionId);
        if (before) await carryEditionTracking(ctx, sink, editionId, before);
      }
      return;
    }

    case "editionLine": {
      const editions = await ctx.db
        .query("editions")
        .withIndex("by_line", (q) => q.eq("editionLineId", loserDoc._id as Id<"editionLines">))
        .collect();
      // Unmapped Packaging takes its Releases' Series from its line, so a
      // merge across Series re-derives them and carries their tracking.
      for (const edition of editions) {
        const before = await editionGovernance(ctx, edition._id);
        await repoint(ctx, log, "editions", edition, {
          editionLineId: survivorDoc._id,
        });
        await recomputeReleaseDenorms(ctx, log, edition._id);
        await carryEditionTracking(ctx, sink, edition._id, before);
      }
      return;
    }

    case "edition": {
      const loserId = loserDoc._id as Id<"editions">;
      const survivorId = survivorDoc._id as Id<"editions">;
      // What both Editions' tracking answers to before the coverage moves:
      // their Releases' Series and the Series their omnibus Ratings may ride on.
      const loserBefore = await editionGovernance(ctx, loserId);
      const survivorBefore = await editionGovernance(ctx, survivorId);

      const survivorCoverage = await coverageOf(ctx, survivorId);
      const maxOrder = survivorCoverage.reduce((max, r) => Math.max(max, r.order), 0);
      const loserCoverage = await coverageOf(ctx, loserId);
      for (const row of [...loserCoverage].sort((a, b) => a.order - b.order)) {
        if (survivorCoverage.some((r) => r.volumeId === row.volumeId)) {
          await removeRow(ctx, log, "volumeCoverages", row);
        } else {
          await repoint(ctx, log, "volumeCoverages", row, {
            editionId: survivorId,
            order: maxOrder + row.order,
          });
        }
      }

      for (const release of await releasesOf(ctx, loserId)) {
        await repoint(ctx, log, "releases", release, { editionId: survivorId });
      }
      // Moved releases (and any the coverage change affected) get fresh
      // seriesIds/publisherId denorms from the survivor edition. Their
      // Series can change either way (an Unmapped Packaging side answered
      // to its line's Series until the other side's coverage replaced it),
      // so every Release's trackers are carried, on both sides.
      await recomputeReleaseDenorms(ctx, log, survivorId);
      for (const [releaseId, from] of loserBefore.releaseSeries) {
        await carryReleaseTracking(ctx, sink, releaseId, from);
      }
      await carryEditionTracking(ctx, sink, survivorId, survivorBefore);

      // An omnibus is a rating target of its own: its Ratings, Reviews and
      // Favorites move to the survivor, the survivor's row winning a clash.
      // A moved Favorite takes the survivor's Series denorm (primaryVolumeSeries,
      // as lib/ratings.ts reads it). A moved Rating now rides on one of the
      // survivor's covered Series, which absorb the Reading visibility of
      // the loser's (carryEditionRatings, hidden Series included).
      const survivorRaters = new Set(
        (await ratingsOf(ctx, { kind: "edition", id: survivorId })).map((row) => row.userId),
      );
      const movedRaters = (await ratingsOf(ctx, { kind: "edition", id: loserId }))
        .map((row) => row.userId)
        .filter((userId) => !survivorRaters.has(userId));
      await transferRatingsAndReviews(
        ctx,
        log,
        { kind: "edition", id: loserId },
        { kind: "edition", id: survivorId },
      );
      await carryEditionRatings(ctx, sink, survivorId, loserBefore.ratedSeries, movedRaters);
      const primarySeries = await primaryVolumeSeries(ctx, survivorId);
      const seriesDenorm = primarySeries ? { seriesId: primarySeries._id } : {};
      const favorites = await ctx.db
        .query("favorites")
        .withIndex("by_edition", (q) => q.eq("editionId", loserId))
        .collect();
      for (const row of favorites) {
        const existing = await ctx.db
          .query("favorites")
          .withIndex("by_user_edition", (q) =>
            q.eq("userId", row.userId).eq("editionId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "favorites", row);
        else await repoint(ctx, log, "favorites", row, { editionId: survivorId, ...seriesDenorm });
      }
      return;
    }

    case "release": {
      const loserId = loserDoc._id as Id<"releases">;
      const survivorId = survivorDoc._id as Id<"releases">;
      const fromSeries = (loserDoc as Doc<"releases">).seriesIds;
      const toSeries = (survivorDoc as Doc<"releases">).seriesIds;
      await refuseSeriesChange(fromSeries, toSeries, () => releaseTracked(ctx, loserId));

      const variants = await ctx.db
        .query("releaseVariants")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const variant of variants) {
        await repoint(ctx, log, "releaseVariants", variant, { releaseId: survivorId });
      }

      // Other Printings follow their Release, so their ISBNs find the
      // survivor. An ISBN the survivor already carries, as its own or as a
      // printing, keeps the survivor's and the loser's row is removed.
      const printingsOf = (releaseId: Id<"releases">) =>
        ctx.db
          .query("releaseIsbns")
          .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
          .collect();
      const survivorIsbns = new Set([
        (survivorDoc as Doc<"releases">).isbn13,
        ...(await printingsOf(survivorId)).map((row) => row.isbn13),
      ]);
      for (const row of await printingsOf(loserId)) {
        if (survivorIsbns.has(row.isbn13)) await removeRow(ctx, log, "releaseIsbns", row);
        else await repoint(ctx, log, "releaseIsbns", row, { releaseId: survivorId });
      }

      // A cross-Series merge files the loser's tracking under the survivor's
      // Series, which absorb the Tracking Visibility of those it leaves
      // (carryVisibility): moved Owned entries and passes, and every owner
      // of a Bundle that held the loser (its member Series change whether
      // the membership moves or folds into the survivor's). A survivor with
      // no Series, or a tracked loser with none, was refused above.
      const carry = (userId: Id<"users">, fields: readonly VisibilityField[]) =>
        carryVisibility(ctx, sink, userId, fields, fromSeries, toSeries);

      const memberships = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const membership of memberships) {
        for (const userId of await bundleOwners(ctx, membership.bundleId))
          await carry(userId, OWNERSHIP);
        const bundleRows = await ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", membership.bundleId))
          .collect();
        if (bundleRows.some((m) => m.releaseId === survivorId)) {
          await removeRow(ctx, log, "bundleMemberships", membership);
        } else {
          await repoint(ctx, log, "bundleMemberships", membership, {
            releaseId: survivorId,
          });
        }
      }

      const entries = await ctx.db
        .query("collectionEntries")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const entry of entries) {
        const existing = await ctx.db
          .query("collectionEntries")
          .withIndex("by_user_release", (q) =>
            q.eq("userId", entry.userId).eq("releaseId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "collectionEntries", entry);
        else {
          await repoint(ctx, log, "collectionEntries", entry, { releaseId: survivorId });
          if (entry.state === "owned") await carry(entry.userId, OWNERSHIP);
        }
      }

      // A moved pass takes the survivor's Series denorm the way startPass
      // derives it (passSeriesOf: the first covered Series, merge-resolved),
      // so a cross-Series merge files it under the right work. A survivor
      // without coverage leaves the pass's Series alone.
      const passSeriesId = await passSeriesOf(ctx, (survivorDoc as Doc<"releases">).seriesIds);
      const passSeries = passSeriesId ? { seriesId: passSeriesId } : {};
      const progress = await ctx.db
        .query("releaseProgress")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const row of progress) {
        const existing = await ctx.db
          .query("releaseProgress")
          .withIndex("by_user_release", (q) =>
            q.eq("userId", row.userId).eq("releaseId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "releaseProgress", row);
        else {
          await repoint(ctx, log, "releaseProgress", row, {
            releaseId: survivorId,
            ...passSeries,
          });
          // The profile gates a pass by its Release's Series and its own.
          await carryVisibility(
            ctx,
            sink,
            row.userId,
            READING,
            [...fromSeries, row.seriesId],
            toSeries,
          );
        }
      }
      return;
    }

    case "releaseVariant": {
      const loserId = loserDoc._id as Id<"releaseVariants">;
      const survivorId = survivorDoc._id as Id<"releaseVariants">;
      // Found by the pin itself, not the row's Release: a pin's Release has
      // not always matched its variant's. applyMerge refused more than
      // VARIANT_MERGE_PIN_LIMIT of them.
      const pins = variantPins(ctx, loserId);
      for (const entry of await pins.entries.collect()) {
        await repoint(ctx, log, "collectionEntries", entry, { variantId: survivorId });
      }
      for (const membership of await pins.memberships.collect()) {
        await repoint(ctx, log, "bundleMemberships", membership, {
          variantId: survivorId,
        });
      }
      return;
    }

    case "releaseBundle": {
      const loserId = loserDoc._id as Id<"releaseBundles">;
      const survivorId = survivorDoc._id as Id<"releaseBundles">;
      // Every member moves to the survivor, so both sides' owners end up
      // behind the union of member Series: never wider, as a private one
      // hides the whole Bundle. Only a side with no Series signal (the
      // default alone governed it) could widen, and is refused if tracked.
      const loserSeries = await bundleSeries(ctx, loserId);
      const survivorSeries = await bundleSeries(ctx, survivorId);
      const merged = [...new Set([...loserSeries, ...survivorSeries])];
      await refuseSeriesChange(loserSeries, merged, () => bundleTracked(ctx, loserId));
      await refuseSeriesChange(survivorSeries, merged, () => bundleTracked(ctx, survivorId));

      const survivorRows = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", survivorId))
        .collect();
      const maxOrder = survivorRows.reduce((max, m) => Math.max(max, m.order), 0);
      const memberships = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", loserId))
        .collect();
      for (const membership of [...memberships].sort((a, b) => a.order - b.order)) {
        if (survivorRows.some((m) => m.releaseId === membership.releaseId)) {
          await removeRow(ctx, log, "bundleMemberships", membership);
        } else {
          await repoint(ctx, log, "bundleMemberships", membership, {
            bundleId: survivorId,
            order: maxOrder + membership.order,
          });
        }
      }

      const entries = await ctx.db
        .query("collectionEntries")
        .withIndex("by_bundle", (q) => q.eq("bundleId", loserId))
        .collect();
      for (const entry of entries) {
        const existing = await ctx.db
          .query("collectionEntries")
          .withIndex("by_user_bundle", (q) =>
            q.eq("userId", entry.userId).eq("bundleId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "collectionEntries", entry);
        else await repoint(ctx, log, "collectionEntries", entry, { bundleId: survivorId });
      }
      return;
    }
  }
}

// ---------- Release Variant merges ----------

/**
 * Pins one Release Variant merge may move, in both tables together. Split
 * puts every pin back in one transaction and reads far more per pin than
 * the merge: of a transaction's 4,096 index ranges, about 5 per Owned entry
 * with a User of its own and 11 per membership of a one-Release Bundle, so
 * 250 of either, or of both, leave a third for the rest. The limit does not
 * make every variant merge reversible: Split also reads 4 ranges per further
 * Release of a moved membership's Bundle and several per owner of that
 * Bundle, so a merge that touched a Bundle with very many owners or many
 * Releases can still be beyond a Split.
 */
export const VARIANT_MERGE_PIN_LIMIT = 250;

/** The Collection Entries and Bundle Memberships pinning a Release Variant. */
function variantPins(ctx: QueryCtx, variantId: Id<"releaseVariants">) {
  return {
    entries: ctx.db
      .query("collectionEntries")
      .withIndex("by_variantId", (q) => q.eq("variantId", variantId)),
    memberships: ctx.db
      .query("bundleMemberships")
      .withIndex("by_variantId", (q) => q.eq("variantId", variantId)),
  };
}

/** How many rows pin a variant, each count stopping one past the merge limit. */
async function variantPinCounts(ctx: QueryCtx, variantId: Id<"releaseVariants">) {
  const pins = variantPins(ctx, variantId);
  return {
    entries: (await pins.entries.take(VARIANT_MERGE_PIN_LIMIT + 1)).length,
    memberships: (await pins.memberships.take(VARIANT_MERGE_PIN_LIMIT + 1)).length,
  };
}

/**
 * Why merging Release Variant `loserId` into `survivorId` is refused, or
 * null. Variants merge only within one Release, each resolved through any
 * Release merge, so a moved pin stays on its row's Release; and move at
 * most VARIANT_MERGE_PIN_LIMIT pins. applyMerge refuses
 * with this before writing anything; the merge form shows it instead of
 * the merge.
 */
export async function variantMergeRefusal(
  ctx: QueryCtx,
  survivorId: Id<"releaseVariants">,
  loserId: Id<"releaseVariants">,
): Promise<string | null> {
  const releaseOf = async (variantId: Id<"releaseVariants">) => {
    const variant = await ctx.db.get(variantId);
    if (!variant) return null;
    return (await mergeSurvivor(ctx, "releases", await ctx.db.get(variant.releaseId)))?._id ?? null;
  };
  const survivorRelease = await releaseOf(survivorId);
  if (!survivorRelease || survivorRelease !== (await releaseOf(loserId))) {
    return "These variants belong to different Releases. Merge the Releases first, then merge the variants.";
  }
  const { entries, memberships } = await variantPinCounts(ctx, loserId);
  if (entries + memberships > VARIANT_MERGE_PIN_LIMIT) {
    return (
      `More than ${VARIANT_MERGE_PIN_LIMIT} collection entries and bundle memberships pin the ` +
      `variant being merged, and a variant merge moves at most ${VARIANT_MERGE_PIN_LIMIT}, since Split ` +
      "puts every pin back in one transaction."
    );
  }
  return null;
}

/**
 * Why merging Release `loserId` into `survivorId` is refused, or null. The
 * loser's Other Printings move to the survivor (transferReferences), and
 * only a physical Release has other printings (printings.ts), so a loser
 * with printing rows merges only into a physical survivor. applyMerge
 * refuses with this before writing anything; the merge form shows it
 * instead of the merge.
 */
export async function releaseMergeRefusal(
  ctx: QueryCtx,
  survivorId: Id<"releases">,
  loserId: Id<"releases">,
): Promise<string | null> {
  const survivor = await ctx.db.get(survivorId);
  if (survivor === null || survivor.format === "physical") return null;
  const printing = await ctx.db
    .query("releaseIsbns")
    .withIndex("by_release", (q) => q.eq("releaseId", loserId))
    .first();
  if (printing === null) return null;
  return (
    `The Release being merged has other printings (ISBN ${printing.isbn13}), which would move to ` +
    `a ${survivor.format} Release, and only a physical Release has other printings. Merge it into ` +
    "a physical Release."
  );
}

// ---------- merge & split ----------

/**
 * Merge: pick a survivor, transfer everything, mark the loser Merged with a
 * pointer at the winner (its URLs 301 from now on), and persist the manifest
 * an explicit Split would replay backward. One Revision lands on each side.
 */
export async function applyMerge(
  ctx: MutationCtx,
  survivor: RecordRef,
  loser: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  if (survivor.type !== loser.type) {
    fail("badMerge", "Merge survivor and loser must be the same record type.");
  }
  if ((survivor.id as string) === (loser.id as string)) {
    fail("badMerge", "A record cannot merge into itself.");
  }
  const survivorDoc = await requireRecord(ctx, survivor);
  const loserDoc = await requireRecord(ctx, loser);
  for (const [doc, role] of [
    [survivorDoc, "survivor"],
    [loserDoc, "loser"],
  ] as const) {
    if (doc.status !== "active") {
      fail("badState", `The merge ${role} is ${doc.status}; both records must be active.`);
    }
    if (doc.locked) {
      fail("locked", `The merge ${role} is temporarily locked — unlock it first.`);
    }
  }
  if (survivor.type === "releaseVariant" && loser.type === "releaseVariant") {
    const refusal = await variantMergeRefusal(ctx, survivor.id, loser.id);
    if (refusal) fail("badMerge", refusal);
  }
  if (survivor.type === "release" && loser.type === "release") {
    const refusal = await releaseMergeRefusal(ctx, survivor.id, loser.id);
    if (refusal) fail("badMerge", refusal);
  }

  const loserTitle = (await displayInfo(ctx, loser.type, loserDoc)).title;
  const survivorTitle = (await displayInfo(ctx, survivor.type, survivorDoc)).title;

  const log: TransferLog = { repointed: [], removed: [], inserted: [] };
  await transferProvenance(ctx, log, loser, survivor.id);
  await transferReferences(ctx, log, loser.type, loserDoc, survivorDoc);
  await recountMergedRatings(ctx, survivor, loser);

  await ctx.db.patch(loser.id, {
    status: "merged",
    mergedIntoId: survivor.id,
  } as never);
  await ctx.db.insert("mergeManifests", {
    loserRef: loser,
    survivorRef: survivor,
    proposalId: meta.proposalId,
    repointed: log.repointed,
    removed: log.removed,
    inserted: log.inserted,
  });

  return [
    await recordRevision(
      ctx,
      loser,
      [
        { field: "status", before: "active", after: "merged" },
        { field: "mergedInto", after: `${survivor.type} "${survivorTitle}"` },
      ],
      meta,
    ),
    await recordRevision(
      ctx,
      survivor,
      [{ field: "mergedFrom", after: `${loser.type} "${loserTitle}"` }],
      meta,
    ),
  ];
}

/** The latest un-reversed merge manifest for a merged record, if any. */
export async function reversibleManifestOf(
  ctx: QueryCtx | MutationCtx,
  ref: RecordRef,
): Promise<Doc<"mergeManifests"> | null> {
  return (await reversibleManifestsOf(ctx, ref))[0] ?? null;
}

/**
 * Every open manifest of the latest merge of this record, newest first. A
 * merge too large for one transaction (the data repair's chunked publisher
 * merge, lib/repair/ops.ts) writes its chunk manifests before the closing
 * merge's, each under its own repair Proposal, so the operation is not one
 * Proposal: it is every open manifest into the latest one's survivor written
 * since this record's previous Split. Split must replay them all.
 */
async function reversibleManifestsOf(
  ctx: QueryCtx | MutationCtx,
  ref: RecordRef,
): Promise<Array<Doc<"mergeManifests">>> {
  const manifests = await ctx.db
    .query("mergeManifests")
    .withIndex("by_loser", (q) => q.eq("loserRef.type", ref.type).eq("loserRef.id", ref.id))
    .collect();
  const lastSplit = Math.max(
    0,
    ...manifests.filter((m) => m.reversedAt !== undefined).map((m) => m._creationTime),
  );
  const open = manifests
    .filter((m) => m.reversedAt === undefined && m._creationTime > lastSplit)
    .sort((a, b) => b._creationTime - a._creationTime);
  const latest = open[0];
  if (!latest) return [];
  return open.filter((m) => sameValue(m.survivorRef, latest.survivorRef));
}

/**
 * Whether a manifest snapshot may be reinserted: a personal row (one with a
 * `userId`) only while its User still exists and is not being deleted, so a
 * Split never refills a table the account purge has drained. Account
 * deletion redacts these snapshots (redactUserFromManifests), and this
 * guard covers any the redaction has not reached yet.
 */
async function ownerExists(ctx: MutationCtx, doc: unknown): Promise<boolean> {
  const userId = (doc as { userId?: unknown }).userId;
  if (typeof userId !== "string") return true;
  const id = ctx.db.normalizeId("users", userId);
  return id !== null && (await liveUser(ctx, id)) !== null;
}

/**
 * Fields older manifests log that their table no longer keeps, by table: a
 * read count's Series, which is its Volume's. Split neither repoints nor
 * reinserts them, nor reads tracking from them.
 */
const RETIRED_FIELDS: Partial<Record<string, string>> = { volumeProgress: "seriesId" };

/** A removed row's snapshot as Split reinserts it: without its table's retired field. */
function liveSnapshot(table: string, doc: unknown): Record<string, unknown> {
  const fields = { ...(doc as Record<string, unknown>) };
  const retired = RETIRED_FIELDS[table];
  if (retired) delete fields[retired];
  return fields;
}

/**
 * Personal snapshots a deleted User left in merge manifests, removed from one
 * page of manifests at a time. The account purge (users.purgeUser), once it
 * has emptied the User's tables, schedules internal.users.redactMergeManifests,
 * which calls this per page; Split then has nothing of theirs to reinsert.
 */
export async function redactUserFromManifests(
  ctx: MutationCtx,
  manifests: Array<Doc<"mergeManifests">>,
  userId: Id<"users">,
): Promise<void> {
  for (const manifest of manifests) {
    const removed = manifest.removed.filter(
      (row) => (row.doc as { userId?: unknown }).userId !== userId,
    );
    if (removed.length < manifest.removed.length) {
      await ctx.db.patch(manifest._id, { removed });
    }
  }
}

// ---------- Split keeps Tracking Visibility ----------

/** The record references a personal row carries, by field. */
const REF_FIELDS: Array<[string, RecordKind]> = [
  ["seriesId", "series"],
  ["volumeId", "volumes"],
  ["editionId", "editions"],
  ["releaseId", "releases"],
  ["bundleId", "bundles"],
];

/** A Split's loser as a record kind whose tracking answers to Series. */
const LOSER_KINDS: Partial<Record<RecordRef["type"], RecordKind>> = {
  series: "series",
  editionLine: "lines",
  volume: "volumes",
  edition: "editions",
  release: "releases",
  releaseBundle: "bundles",
};

/** Add a manifest's untyped reference (one id or an array of them) of one kind; returns the ids added. */
function addRefs<K extends RecordKind>(
  ctx: MutationCtx,
  into: RecordSets,
  kind: K,
  value: unknown,
) {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  const added: Array<RecordId<K>> = [];
  for (const raw of values) {
    const id = typeof raw === "string" ? ctx.db.normalizeId(RECORD_TABLES[kind], raw) : null;
    if (id) {
      into[kind].add(id);
      added.push(id);
    }
  }
  return added;
}

/**
 * What a Split touches, read before it replays anything: the loser and
 * every record whose Series the replay changes (a re-parented Volume or
 * Edition Line, an Edition whose coverage or line moved, a Release whose
 * Series or Edition moved and both its Editions, a Bundle whose members
 * moved). `users`: everyone tracking those or anything under them as the
 * database stands now (trackersOf), plus the owners of the personal rows
 * the manifests moved, removed or inserted, each tracking every record
 * their row points at. `records`: everything trackersOf read, plus every
 * record those personal rows point at on either side of the replay.
 */
async function splitScope(
  ctx: MutationCtx,
  loser: RecordRef,
  manifests: Array<Doc<"mergeManifests">>,
) {
  const users: Trackers = new Map();
  const moved = recordSets();
  const refs = recordSets();
  const loserKind = LOSER_KINDS[loser.type];
  if (loserKind) addRefs(ctx, moved, loserKind, loser.id);
  // A personal row: its owner, and every record it points at.
  const personal = (table: string, row: Record<string, unknown> | null) => {
    const fields = row ? surfacesOf(table, row) : [];
    const userId = typeof row?.userId === "string" ? ctx.db.normalizeId("users", row.userId) : null;
    if (!row || !userId || fields.length === 0) return;
    for (const [field, kind] of REF_FIELDS) {
      if (field === RETIRED_FIELDS[table]) continue;
      for (const id of addRefs(ctx, refs, kind, row[field])) addTracker(users, userId, id, fields);
    }
  };
  // A link row: the Edition or Bundle whose Series it changes, and what it links there.
  const link = (table: string, row: Record<string, unknown> | null) => {
    if (table === "volumeCoverages") {
      addRefs(ctx, moved, "editions", row?.editionId);
      addRefs(ctx, refs, "volumes", row?.volumeId);
    } else if (table === "bundleMemberships") {
      addRefs(ctx, moved, "bundles", row?.bundleId);
      addRefs(ctx, refs, "releases", row?.releaseId);
    }
  };
  // A row as it stands now, read once however many of its fields moved.
  const rows = new Map<string, Record<string, unknown> | null>();
  const current = async (table: string, docId: string) => {
    if (!rows.has(docId)) {
      const id = ctx.db.normalizeId(table as TableNames, docId);
      rows.set(docId, id ? ((await ctx.db.get(id)) as Record<string, unknown> | null) : null);
    }
    return rows.get(docId) ?? null;
  };
  for (const manifest of manifests) {
    for (const { table, doc } of manifest.removed) {
      personal(table, doc as Record<string, unknown>);
      link(table, doc as Record<string, unknown>);
    }
    for (const { table, docId } of manifest.inserted) personal(table, await current(table, docId));
    for (const { table, docId, field, before, after } of manifest.repointed) {
      if (field === RETIRED_FIELDS[table]) continue;
      if (table === "volumes" && field === "seriesId") addRefs(ctx, moved, "volumes", docId);
      else if (table === "editionLines" && field === "seriesId")
        addRefs(ctx, moved, "lines", docId);
      else if (table === "editions" && field === "editionLineId")
        addRefs(ctx, moved, "editions", docId);
      else if (table === "releases" && field === "seriesIds")
        addRefs(ctx, moved, "releases", docId);
      else if (table === "releases" && field === "editionId") {
        addRefs(ctx, moved, "releases", docId);
        addRefs(ctx, moved, "editions", [before, after]);
      } else if (
        PERSONAL_SURFACES[table] ||
        table === "volumeCoverages" ||
        table === "bundleMemberships"
      ) {
        // The row as it stands, and as the replay will point it (a row the
        // world moved since stays where it is).
        const row = await current(table, docId);
        for (const side of row ? [row, { ...row, [field]: before }] : []) {
          personal(table, side);
          link(table, side);
        }
      }
    }
  }
  const touched = await trackersOf(ctx, moved);
  for (const [userId, tracked] of touched.trackers) {
    for (const [recordId, fields] of tracked) addTracker(users, userId, recordId, fields);
  }
  return { users, records: recordSets(touched.records, refs) };
}

/** A record as the profile reads it: followed through merges, or as stored when hidden. */
async function asShown<
  T extends "editionLines" | "volumes" | "editions" | "releases" | "releaseBundles",
>(ctx: MutationCtx, table: T, id: Id<T>) {
  const stored = await ctx.db.get(id);
  return (await followMerges(ctx, table, stored)) ?? stored;
}

/**
 * Each record's Series, keyed by its id, as the profile gates its tracking
 * (sharing.ts publicProfile) and merge-followed (governingSeries): an
 * Edition Line's or Volume's Series, an Edition's covered Volumes' (or its
 * line's; hidden ones included), a Release's `seriesIds`, a Bundle's
 * members'.
 */
async function seriesByRecord(ctx: MutationCtx, records: RecordSets) {
  const out = new Map<string, Array<Id<"series">>>();
  for (const id of records.series) out.set(id, [id]);
  for (const id of records.lines) {
    const line = await asShown(ctx, "editionLines", id);
    if (line) out.set(id, [line.seriesId]);
  }
  for (const id of records.volumes) {
    const volume = await asShown(ctx, "volumes", id);
    if (volume) out.set(id, [volume.seriesId]);
  }
  for (const id of records.editions) {
    const edition = await asShown(ctx, "editions", id);
    if (edition) out.set(id, await editionSeriesIds(ctx, edition));
  }
  for (const id of records.releases) {
    const release = await asShown(ctx, "releases", id);
    if (release) out.set(id, release.seriesIds);
  }
  for (const id of records.bundles) {
    const bundle = await asShown(ctx, "releaseBundles", id);
    if (bundle) out.set(id, await bundleSeries(ctx, bundle._id));
  }
  for (const [id, seriesIds] of out) out.set(id, await governingSeries(ctx, seriesIds));
  return out;
}

/**
 * Taken before a Split replays anything: what it touches and whom
 * (splitScope), the Series each touched record answers to now (resolved
 * before the replay reactivates the loser, which then governs itself), and
 * each User's overrides on the Series of the records THAT User tracks
 * (null: no row), the floor keepSplitVisibility holds the Split to. One
 * lookup per User and Series their own tracking reaches.
 */
async function splitGovernance(
  ctx: MutationCtx,
  loser: RecordRef,
  manifests: Array<Doc<"mergeManifests">>,
) {
  const { users, records } = await splitScope(ctx, loser, manifests);
  const before = await seriesByRecord(ctx, records);
  const snapshots = new Map<Id<"users">, Map<Id<"series">, VisibilityOverrides | null>>();
  for (const [userId, tracked] of users) {
    // A User gone or being deleted gets no override rows written for them.
    if (!(await liveUser(ctx, userId))) continue;
    const snapshot = new Map<Id<"series">, VisibilityOverrides | null>();
    for (const recordId of tracked.keys()) {
      for (const seriesId of before.get(recordId) ?? []) {
        if (snapshot.has(seriesId)) continue;
        const state = await seriesStateOf(ctx, userId, seriesId);
        snapshot.set(
          seriesId,
          state && {
            ownershipVisibility: state.ownershipVisibility,
            readingVisibility: state.readingVisibility,
          },
        );
      }
    }
    snapshots.set(userId, snapshot);
  }
  return { users, records, before, snapshots };
}

/**
 * After a Split, no surface shows more than it did just before (the floor
 * splitGovernance took), and nothing a User does not track is narrowed.
 * Per User: each Series their tracked records answered to gets back at most
 * its own earlier overrides, and each Series a tracked record answers to
 * now absorbs the earlier overrides of the Series that record left
 * (absorbedFrom; gate "one" for an omnibus Rating's Edition). The sources
 * per Series are applied in one write (stricterVisibility is monotone): one
 * read and at most one write per User and Series. A tracked Release or
 * Bundle the Split would leave with no Series is refused, since no override
 * could keep it private.
 */
async function keepSplitVisibility(
  ctx: MutationCtx,
  { users, records, before, snapshots }: Awaited<ReturnType<typeof splitGovernance>>,
): Promise<void> {
  const after = await seriesByRecord(ctx, records);
  const losesSeries = (id: string) =>
    (before.get(id)?.length ?? 0) > 0 && after.get(id)?.length === 0;
  const refuse = () =>
    fail(
      "badSplit",
      "This Split would leave a Release or Bundle that Users have tracked since the merge with no Series, where no override could keep that tracking private. Give it Volume Coverage or Bundle members first.",
    );
  for (const id of records.releases)
    if (losesSeries(id) && (await releaseTracked(ctx, id))) refuse();
  for (const id of records.bundles) if (losesSeries(id) && (await bundleTracked(ctx, id))) refuse();
  const editions = new Set<string>(records.editions);
  const scratch = manifestSink(ctx, { repointed: [], removed: [], inserted: [] });
  for (const [userId, snapshot] of snapshots) {
    // Per Series, per surface: the earlier overrides it may show no more than.
    type Sources = Array<VisibilityOverrides | null>;
    const floors = new Map<Id<"series">, Record<VisibilityField, Sources>>();
    const hold = (seriesId: Id<"series">, fields: Iterable<VisibilityField>, sources: Sources) => {
      const floor = floors.get(seriesId) ?? { ownershipVisibility: [], readingVisibility: [] };
      for (const field of fields) floor[field].push(...sources);
      floors.set(seriesId, floor);
    };
    for (const [seriesId, state] of snapshot) hold(seriesId, VISIBILITY_FIELDS, [state]);
    for (const [recordId, fields] of users.get(userId) ?? []) {
      const to = after.get(recordId) ?? [];
      const absorbed = absorbedFrom(
        before.get(recordId) ?? [],
        to,
        editions.has(recordId) ? "one" : "all",
      );
      if (!absorbed) continue;
      const sources =
        absorbed.length === 0 ? [null] : absorbed.map((id) => snapshot.get(id) ?? null);
      for (const seriesId of to) hold(seriesId, fields, sources);
    }
    for (const [seriesId, floor] of floors) {
      const state = await seriesStateOf(ctx, userId, seriesId);
      const patch: VisibilityOverrides = {};
      for (const field of VISIBILITY_FIELDS)
        Object.assign(patch, stricterVisibility(state, floor[field], [field]));
      if (Object.keys(patch).length > 0) await scratch.write(userId, seriesId, state, patch);
    }
  }
}

/** A printing stays where it is if another owner has claimed its ISBN since the merge. */
async function canRestorePrinting(
  ctx: MutationCtx,
  row: Pick<Doc<"releaseIsbns">, "isbn13" | "releaseId">,
  movedRowId?: Id<"releaseIsbns">,
): Promise<boolean> {
  const ownedElsewhere = (release: Doc<"releases">) =>
    release.status === "active" && release._id !== row.releaseId;
  for await (const release of ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", row.isbn13))) {
    if (ownedElsewhere(release)) return false;
  }
  const isbn10 = isbn13To10(row.isbn13);
  if (isbn10 !== undefined) {
    for await (const release of ctx.db
      .query("releases")
      .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10))) {
      if (ownedElsewhere(release)) return false;
    }
  }
  for await (const printing of ctx.db
    .query("releaseIsbns")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", row.isbn13))) {
    if (printing._id !== movedRowId && printing.releaseId !== row.releaseId) return false;
  }
  return true;
}

/**
 * Split, the only reversal of a mistaken merge: replay the merge's
 * manifests backward (delete what they inserted, reinsert what they removed
 * unless its User is gone, repoint every reference still where the merge
 * left it, skipping printings whose ISBN another owner now holds;
 * RETIRED_FIELDS are neither reinserted nor repointed) and
 * reactivate the loser. The touched Editions' Release Series are then
 * derived afresh from the restored links (recomputeReleaseDenorms).
 * No profile shows more afterwards than just before (keepSplitVisibility):
 * an override the merge narrowed stays narrow, as the User may have tracked
 * more under it in the meantime.
 */
export async function applySplit(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (doc.status !== "merged" || !doc.mergedIntoId) {
    fail(
      "badState",
      `Only merged records can be split back out; this ${ref.type} is ${doc.status}.`,
    );
  }
  // Newest first: a chunked merge's manifests are undone in reverse order.
  const manifests = await reversibleManifestsOf(ctx, ref);
  const latest = manifests[0];
  if (!latest) {
    fail("noManifest", "This merge predates manifests and cannot be split automatically.");
  }
  const survivor = latest.survivorRef;
  const governed = await splitGovernance(ctx, ref, manifests);

  for (const manifest of manifests) {
    // State rows the merge synthesized (carryVisibility) wait until the
    // replay below has reverted the overrides it set on them.
    const synthesized: string[] = [];
    for (const row of manifest.inserted) {
      if (row.table === "userSeriesStates") {
        synthesized.push(row.docId);
        continue;
      }
      const id = ctx.db.normalizeId(row.table as TableNames, row.docId);
      if (id && (await ctx.db.get(id))) await ctx.db.delete(id);
    }
    for (const row of manifest.removed) {
      if (!(await ownerExists(ctx, row.doc))) continue;
      if (
        row.table === "releaseIsbns" &&
        !(await canRestorePrinting(ctx, row.doc as Doc<"releaseIsbns">))
      )
        continue;
      await ctx.db.insert(row.table as TableNames, liveSnapshot(row.table, row.doc) as never);
    }
    for (const entry of [...manifest.repointed].reverse()) {
      if (entry.field === RETIRED_FIELDS[entry.table]) continue;
      const id = ctx.db.normalizeId(entry.table as TableNames, entry.docId);
      if (!id) continue;
      const target = (await ctx.db.get(id)) as Record<string, unknown> | null;
      if (!target) continue;
      if (!sameValue(target[entry.field], entry.after)) continue;
      if (entry.table === "releaseIsbns" && entry.field === "releaseId") {
        const releaseId =
          typeof entry.before === "string" ? ctx.db.normalizeId("releases", entry.before) : null;
        if (
          releaseId === null ||
          !(await canRestorePrinting(
            ctx,
            { ...(target as Doc<"releaseIsbns">), releaseId },
            id as Id<"releaseIsbns">,
          ))
        )
          continue;
      }
      await ctx.db.patch(id, { [entry.field]: entry.before } as never);
    }
    // A synthesized state row goes once bare again (keepSplitVisibility
    // below puts back any override the Split may not drop). One the User
    // has since written to (a Follow, a dismissal, a status, an override)
    // stays with what they wrote.
    for (const docId of synthesized) {
      const id = ctx.db.normalizeId("userSeriesStates", docId);
      const state = id ? await ctx.db.get(id) : null;
      if (
        state &&
        !state.following &&
        !state.followPromptDismissed &&
        !state.readingStatus &&
        !state.ownershipVisibility &&
        !state.readingVisibility
      ) {
        await ctx.db.delete(state._id);
      }
    }
  }

  await ctx.db.patch(ref.id, { status: "active", mergedIntoId: undefined });
  // Release Series, and the Series their passes are filed under, are derived
  // from the links just restored; like every write a Split makes, the
  // re-derivation is final (a scratch log).
  const derived: TransferLog = { repointed: [], removed: [], inserted: [] };
  for (const editionId of governed.records.editions)
    await recomputeReleaseDenorms(ctx, derived, editionId);
  await keepSplitVisibility(ctx, governed);
  await recountMergedRatings(ctx, ref, survivor);
  for (const target of ratingTargetsIn(manifests)) await recountRatings(ctx, target);
  const reversedAt = Date.now();
  for (const manifest of manifests) await ctx.db.patch(manifest._id, { reversedAt });

  const survivorDoc = await getCanonical(ctx, survivor);
  const survivorTitle = survivorDoc
    ? (await displayInfo(ctx, survivor.type, survivorDoc)).title
    : "(missing record)";
  const title = (await displayInfo(ctx, ref.type, doc)).title;

  const revisions = [
    await recordRevision(
      ctx,
      ref,
      [
        { field: "status", before: "merged", after: "active" },
        { field: "mergedInto", before: `${survivor.type} "${survivorTitle}"` },
      ],
      meta,
    ),
  ];
  if (survivorDoc) {
    revisions.push(
      await recordRevision(
        ctx,
        survivor,
        [{ field: "splitOut", after: `${ref.type} "${title}"` }],
        meta,
      ),
    );
  }
  return revisions;
}

/** The operations on one record, by their Proposal op kind. */
export const SINGLE_RECORD_OPS = {
  hide: applyHide,
  restore: applyRestore,
  split: applySplit,
  lock: applyLock,
  unlock: applyUnlock,
};
export type SingleRecordOp = keyof typeof SINGLE_RECORD_OPS;

// ---------- impact preview ----------

export type ImpactRow = { label: string; count: number };

/** Child Publisher rows the impact preview reads before it stops counting imprints. */
export const IMPRINT_PREVIEW_CAP = 100;

/**
 * What an operation on this record touches — shown to the Moderator before
 * every Hide/Restore/Merge/Split/Lock as the required impact preview
 * (spec §5). Counts use the same lookups the merge transfer walks.
 */
export async function impactOf(ctx: QueryCtx | MutationCtx, ref: RecordRef): Promise<ImpactRow[]> {
  const rows: ImpactRow[] = [];
  const add = (label: string, count: number) => rows.push({ label, count });
  // Most rows are the size of one indexed query.
  const count = async (label: string, query: { collect(): Promise<unknown[]> }) =>
    add(label, (await query.collect()).length);

  await count(
    "Source observations",
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id)),
  );
  add("Public revisions", (await revisionsOf(ctx, ref)).length);

  switch (ref.type) {
    case "publisher": {
      const id = ref.id;
      // A company has a handful of imprints; the read stops at the cap and
      // says so rather than count an unbounded set.
      const children = await ctx.db
        .query("publishers")
        .withIndex("by_parent", (q) => q.eq("parentPublisherId", id))
        .take(IMPRINT_PREVIEW_CAP + 1);
      const capped = children.length > IMPRINT_PREVIEW_CAP;
      add(
        "Imprints (follow the survivor on a merge)" +
          (capped
            ? ` — more than ${IMPRINT_PREVIEW_CAP} child rows, first ${IMPRINT_PREVIEW_CAP} counted`
            : ""),
        children.slice(0, IMPRINT_PREVIEW_CAP).filter((row) => row.status !== "merged").length,
      );
      add(
        "Edition lines",
        (await ctx.db.query("editionLines").collect()).filter((l) => l.publisherId === id).length,
      );
      await count(
        "Editions",
        ctx.db.query("editions").withIndex("by_publisher", (q) => q.eq("publisherId", id)),
      );
      await count(
        "Releases",
        ctx.db.query("releases").withIndex("by_publisher_date", (q) => q.eq("publisherId", id)),
      );
      add(
        "Bundles",
        (await ctx.db.query("releaseBundles").collect()).filter((b) => b.publisherId === id).length,
      );
      break;
    }
    case "seriesFamily": {
      await count(
        "Member series",
        ctx.db.query("series").withIndex("by_family", (q) => q.eq("familyId", ref.id)),
      );
      break;
    }
    case "series": {
      const id = ref.id;
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", id))
        .collect();
      add("Volumes", volumes.length);
      await count(
        "Edition lines",
        ctx.db.query("editionLines").withIndex("by_series", (q) => q.eq("seriesId", id)),
      );
      const fromEdges = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_from", (q) => q.eq("fromSeriesId", id))
        .collect();
      const toEdges = await ctx.db
        .query("seriesRelationships")
        .withIndex("by_to", (q) => q.eq("toSeriesId", id))
        .collect();
      add("Relationship edges", fromEdges.length + toEdges.length);
      await count(
        "User series states (follows, reading, visibility)",
        ctx.db.query("userSeriesStates").withIndex("by_series", (q) => q.eq("seriesId", id)),
      );
      await count(
        "Reading passes",
        ctx.db.query("releaseProgress").withIndex("by_series", (q) => q.eq("seriesId", id)),
      );
      // Read counts follow their Volumes, as trackersIn finds them.
      let reads = 0;
      for (const volume of volumes) {
        reads += (
          await ctx.db
            .query("volumeProgress")
            .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
            .collect()
        ).length;
      }
      add("Volume read counts", reads);
      add("Ratings", (await ratingsOf(ctx, { kind: "series", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "series", id })).length);
      await count(
        "Favorites (of the series and its volumes)",
        ctx.db.query("favorites").withIndex("by_series", (q) => q.eq("seriesId", id)),
      );
      await count(
        "Comments (on the series and its volumes)",
        ctx.db.query("comments").withIndex("by_series", (q) => q.eq("seriesId", id)),
      );
      break;
    }
    case "volume": {
      const id = ref.id;
      await count(
        "Coverage rows (editions covering this volume)",
        ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", id)),
      );
      await count(
        "Volume read counts",
        ctx.db.query("volumeProgress").withIndex("by_volume", (q) => q.eq("volumeId", id)),
      );
      add("Ratings", (await ratingsOf(ctx, { kind: "volume", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "volume", id })).length);
      add(
        "Ratings, reviews and favorites of two-volume omnibuses (move to the survivor if the other Volume is merged)",
        await collapsibleTakes(ctx, id),
      );
      await count(
        "Favorites",
        ctx.db.query("favorites").withIndex("by_volume", (q) => q.eq("volumeId", id)),
      );
      await count(
        "Comments",
        ctx.db.query("comments").withIndex("by_volume", (q) => q.eq("volumeId", id)),
      );
      break;
    }
    case "editionLine": {
      await count(
        "Editions in this line",
        ctx.db.query("editions").withIndex("by_line", (q) => q.eq("editionLineId", ref.id)),
      );
      break;
    }
    case "edition": {
      const id = ref.id;
      add("Coverage rows", (await coverageOf(ctx, id)).length);
      add("Releases", (await releasesOf(ctx, id)).length);
      add("Ratings", (await ratingsOf(ctx, { kind: "edition", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "edition", id })).length);
      await count(
        "Favorites",
        ctx.db.query("favorites").withIndex("by_edition", (q) => q.eq("editionId", id)),
      );
      break;
    }
    case "release": {
      const id = ref.id;
      await count(
        "Other printings (ISBNs that also find it; they follow it on a merge)",
        ctx.db.query("releaseIsbns").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      await count(
        "Variants",
        ctx.db.query("releaseVariants").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      await count(
        "Bundle memberships",
        ctx.db.query("bundleMemberships").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      await count(
        "Collection entries",
        ctx.db.query("collectionEntries").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      await count(
        "Reading passes",
        ctx.db.query("releaseProgress").withIndex("by_release", (q) => q.eq("releaseId", id)),
      );
      break;
    }
    case "releaseVariant": {
      // The rows a merge of this variant repoints, counted only as far as
      // a merge may move them.
      const pins = await variantPinCounts(ctx, ref.id);
      const limit = VARIANT_MERGE_PIN_LIMIT;
      const pinRow = (label: string, count: number) =>
        count > limit
          ? add(`${label} — more than ${limit}, first ${limit} counted`, limit)
          : add(label, count);
      pinRow("Collection entries pinning this variant", pins.entries);
      pinRow("Bundle memberships pinning this variant", pins.memberships);
      break;
    }
    case "releaseBundle": {
      const id = ref.id;
      await count(
        "Member releases",
        ctx.db.query("bundleMemberships").withIndex("by_bundle", (q) => q.eq("bundleId", id)),
      );
      await count(
        "Collection entries",
        ctx.db.query("collectionEntries").withIndex("by_bundle", (q) => q.eq("bundleId", id)),
      );
      break;
    }
  }
  return rows;
}
