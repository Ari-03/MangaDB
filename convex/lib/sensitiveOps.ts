// The sensitive catalog operations (ticket #33, spec §5): Hide, Restore,
// Merge, Split, and temporary Locks. Each apply function validates the
// record's current state, performs the operation, and appends immutable
// public Revisions — shared by the direct Moderator mutations
// (../sensitiveOps.ts) and review-queue approval (../proposals.ts), so both
// paths behave identically.
//
// Merge picks a survivor and physically transfers Source Observations,
// compatible relationships, child records, and user tracking to it; the
// loser keeps its identity, public ID, and revision history and points at
// the winner (`status: "merged"` + `mergedIntoId`), which is what turns
// every losing-ID URL into a permanent 301 — no redirects table. Everything
// a merge moved is written to a mergeManifests row, and an explicit Split
// (the only way to reverse a mistaken merge) replays that manifest backward,
// skipping anything the world changed since. Neither Merge nor Split makes
// any User's tracking more visible on their public profile than it was just
// before: wherever tracking changes the Series it answers to, that Series
// absorbs the overrides it left (stricterVisibility; a merge logs these
// writes in its manifest), Split never widens an override it replays, and a
// merge that would move tracked Releases or Bundles between some Series and
// none is refused, since no override governs tracking with no Series.

import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { followMerges, primaryVolumeSeries } from "../catalogPages";
import {
  displayInfo,
  getCanonical,
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
import { sameValue } from "./values";

const fail = (code: string, message: string): never => {
  throw new ConvexError({ code, message });
};

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
  return await ctx.db.insert("revisions", {
    ref: ref as never,
    seq: (latest?.seq ?? 0) + 1,
    proposalId: meta.proposalId,
    author: meta.author,
    approvedBy: meta.approvedBy,
    changes,
    comment: meta.comment,
  });
}

async function requireRecord(
  ctx: MutationCtx,
  ref: RecordRef,
): Promise<CatalogDoc> {
  const doc = await getCanonical(ctx, ref);
  if (!doc) fail("notFound", `No such ${ref.type}.`);
  return doc!;
}

// ---------- hide / restore ----------

/**
 * Hide removes a record from public discovery while preserving its identity,
 * history, and every tracking reference — nothing but `status` changes. A
 * hidden record is locked against ordinary edits by its status.
 */
export async function applyHide(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (doc.status !== "active") {
    fail("badState", `Only active records can be hidden; this ${ref.type} is ${doc.status}.`);
  }
  if (doc.locked) fail("locked", "This record is temporarily locked — unlock it first.");
  await ctx.db.patch(ref.id, { status: "hidden" } as never);
  return [
    await recordRevision(
      ctx,
      ref,
      [{ field: "status", before: "active", after: "hidden" }],
      meta,
    ),
  ];
}

/** Restore reactivates a hidden record. It never reverses a merge (Split does). */
export async function applyRestore(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (doc.status === "merged") {
    fail("badState", "A merged record is reversed only by an explicit Split — Restore cannot.");
  }
  if (doc.status !== "hidden") {
    fail("badState", `Only hidden records can be restored; this ${ref.type} is ${doc.status}.`);
  }
  await ctx.db.patch(ref.id, { status: "active" } as never);
  return [
    await recordRevision(
      ctx,
      ref,
      [{ field: "status", before: "hidden", after: "active" }],
      meta,
    ),
  ];
}

// ---------- temporary locks ----------

/** A Moderator's temporary lock on an active record (disputes, spec §5). */
export async function applyLock(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (doc.status !== "active") {
    fail("badState", `A ${doc.status} record is already locked by its status.`);
  }
  if (doc.locked) fail("badState", "This record is already locked.");
  await ctx.db.patch(ref.id, { locked: true } as never);
  return [
    await recordRevision(
      ctx,
      ref,
      [{ field: "locked", before: false, after: true }],
      meta,
    ),
  ];
}

export async function applyUnlock(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (!doc.locked) fail("badState", "This record is not locked.");
  await ctx.db.patch(ref.id, { locked: undefined } as never);
  return [
    await recordRevision(
      ctx,
      ref,
      [{ field: "locked", before: true, after: false }],
      meta,
    ),
  ];
}

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
    .withIndex("by_record", (q) =>
      q.eq("recordRef.type", loser.type).eq("recordRef.id", loser.id as never),
    )
    .collect();
  for (const observation of observations) {
    await repoint(ctx, log, "sourceObservations", observation, {
      recordRef: { type: loser.type, id: survivorId },
    });
  }
  const suppressions = await ctx.db
    .query("conflictSuppressions")
    .withIndex("by_key", (q) =>
      q.eq("ref.type", loser.type).eq("ref.id", loser.id as never),
    )
    .collect();
  for (const suppression of suppressions) {
    await repoint(ctx, log, "conflictSuppressions", suppression, {
      ref: { type: loser.type, id: survivorId },
    });
  }
}

/**
 * The Series an Edition's Releases carry (`seriesIds`, spec §8): those of
 * its covered Volumes in coverage order, or, for Unmapped Packaging that
 * covers nothing yet, its Edition Line's.
 */
async function editionSeriesIds(
  ctx: MutationCtx,
  edition: Doc<"editions">,
): Promise<Id<"series">[]> {
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
    .collect();
  const seriesIds: Id<"series">[] = [];
  for (const row of coverage) {
    const volume = await ctx.db.get(row.volumeId);
    if (volume && !seriesIds.includes(volume.seriesId)) {
      seriesIds.push(volume.seriesId);
    }
  }
  if (seriesIds.length === 0 && edition.editionLineId) {
    const line = await ctx.db.get(edition.editionLineId);
    if (line) seriesIds.push(line.seriesId);
  }
  return seriesIds;
}

/**
 * Recompute the release denorms (`seriesIds`, `publisherId` — spec §8) for
 * every release of one Edition from its current coverage, logging changes.
 */
async function recomputeReleaseDenorms(
  ctx: MutationCtx,
  log: TransferLog,
  editionId: Id<"editions">,
): Promise<void> {
  const edition = await ctx.db.get(editionId);
  if (!edition) return;
  const seriesIds = await editionSeriesIds(ctx, edition);
  const releases = await ctx.db
    .query("releases")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
  for (const release of releases) {
    await repoint(ctx, log, "releases", release, {
      seriesIds,
      publisherId: edition.publisherId,
    });
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
 * One User's tracking on some surfaces answered to the `from` Series and now
 * answers to the `to` Series (a cross-Series merge moved it, or re-derived
 * its Release's Series; a repair re-parented its Volume). Every `to` Series
 * absorbs the overrides of the Series the tracking left
 * (stricterVisibility), on a new state row where the User had none;
 * tracking with no Series followed the default alone. A merge's
 * synthesized rows are undone by Split only once bare again, and Split
 * never widens them back (keepSplitVisibility). Merges refuse to move
 * tracked Releases between some Series and none (refuseSeriesChange); a
 * carry to no Series is a no-op here.
 */
export async function carryVisibility(
  ctx: MutationCtx,
  sink: OverrideSink,
  userId: Id<"users">,
  fields: readonly VisibilityField[],
  from: Array<Id<"series">>,
  to: Array<Id<"series">>,
): Promise<void> {
  const fromIds = await governingSeries(ctx, from);
  const toIds = await governingSeries(ctx, to);
  const dropped = fromIds.filter((id) => !toIds.includes(id));
  if (toIds.length === 0 || (fromIds.length > 0 && dropped.length === 0)) return;
  const sources =
    fromIds.length === 0
      ? [null]
      : await Promise.all(dropped.map((id) => seriesStateOf(ctx, userId, id)));
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
 * Refuse a merge that moves a Release or Bundle from some Series to none, or
 * a tracked one (`tracked`, asked only then) from none to some. With no
 * Series the account default alone governs its tracking, which no override
 * can narrow: losing its Series would drop an explicit private choice, and
 * gaining one would let the Split back to none drop any private choice the
 * User made on the new Series in between (an operation nothing reverses
 * passes `tracked` = null: gaining a Series only narrows it then).
 */
async function refuseSeriesChange(
  from: Array<Id<"series">>,
  to: Array<Id<"series">>,
  tracked: (() => Promise<boolean>) | null,
): Promise<void> {
  if (from.length > 0 && to.length === 0) {
    fail(
      "badMerge",
      "This merge would leave a Release with no Series. Map the surviving Edition's Volume Coverage first, or merge the other way.",
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
  const entries = await ctx.db
    .query("collectionEntries")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
    .collect();
  return entries.filter((entry) => entry.state === "owned").map((entry) => entry.userId);
}

/** The Bundles holding a Release. */
async function bundlesOf(ctx: MutationCtx, releaseId: Id<"releases">) {
  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .collect();
  return [...new Set(memberships.map((row) => row.bundleId))];
}

/**
 * What an Edition's tracking answers to right now: each of its Releases'
 * stored Series (what the public profile reads) and the Series its omnibus
 * Ratings ride on. Taken before an operation re-derives them, for
 * carryEditionTracking / carryReleaseTracking.
 */
export async function editionGovernance(ctx: MutationCtx, editionId: Id<"editions">) {
  const releases = await ctx.db
    .query("releases")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
  return {
    releaseSeries: new Map(releases.map((release) => [release._id, release.seriesIds])),
    ratedSeriesId: (await primaryVolumeSeries(ctx, editionId))?._id,
  };
}
export type EditionGovernance = Awaited<ReturnType<typeof editionGovernance>>;

/**
 * A Release's Series were re-derived (`from` → its current `seriesIds`,
 * wherever it now sits): carry the Tracking Visibility of every User the
 * profile shows it for — Owned entries, owners of Bundles holding it, and
 * active passes. A Release that would lose every Series, or (in a
 * reversible operation) a tracked one that had none, is refused
 * (refuseSeriesChange).
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
  const carry = (userId: Id<"users">, fields: readonly VisibilityField[]) =>
    carryVisibility(ctx, sink, userId, fields, from, release.seriesIds);
  const entries = await ctx.db
    .query("collectionEntries")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .collect();
  for (const entry of entries) if (entry.state === "owned") await carry(entry.userId, OWNERSHIP);
  for (const bundleId of await bundlesOf(ctx, releaseId)) {
    for (const userId of await bundleOwners(ctx, bundleId)) await carry(userId, OWNERSHIP);
  }
  const passes = await ctx.db
    .query("releaseProgress")
    .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
    .collect();
  for (const pass of passes) await carry(pass.userId, READING);
}

/**
 * An operation re-derived an Edition's Series (`before`, from
 * editionGovernance taken first): carry the trackers of each Release it had
 * (carryReleaseTracking) and the Reading visibility of its omnibus Ratings.
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
  const ratedSeriesId = (await primaryVolumeSeries(ctx, editionId))?._id;
  if (!before.ratedSeriesId || !ratedSeriesId) return;
  const ratings = await ctx.db
    .query("ratings")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
  for (const rating of ratings) {
    await carryVisibility(ctx, sink, rating.userId, READING, [before.ratedSeriesId], [ratedSeriesId]);
  }
}

/**
 * Which surfaces a User tracks on a Series about to merge away, looked up
 * wherever the public profile finds tracking: Volume read counts, passes
 * and Series Ratings filed under it; passes, Owned Releases and Owned
 * Bundles on the Releases of `editionIds` (its Volumes' and Edition Lines'
 * Editions, spanning omnibuses included); and omnibus Ratings on those
 * Editions. Only the given `surfaces` are checked.
 */
async function trackedSurfaces(
  ctx: MutationCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
  scope: {
    releaseIds: Array<Id<"releases">>;
    bundleIds: Array<Id<"releaseBundles">>;
    editionIds: Array<Id<"editions">>;
  },
  surfaces: readonly VisibilityField[],
): Promise<VisibilityField[]> {
  const found: VisibilityField[] = [];
  if (surfaces.includes("readingVisibility")) {
    const filed =
      (await ctx.db
        .query("volumeProgress")
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
        .first()) ??
      (await ctx.db
        .query("releaseProgress")
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
        .first()) ??
      (await ctx.db
        .query("ratings")
        .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
        .first());
    let reads = filed !== null;
    for (const releaseId of scope.releaseIds) {
      if (reads) break;
      reads =
        (await ctx.db
          .query("releaseProgress")
          .withIndex("by_user_release", (q) => q.eq("userId", userId).eq("releaseId", releaseId))
          .first()) !== null;
    }
    for (const editionId of scope.editionIds) {
      if (reads) break;
      reads =
        (await ctx.db
          .query("ratings")
          .withIndex("by_user_edition", (q) => q.eq("userId", userId).eq("editionId", editionId))
          .first()) !== null;
    }
    if (reads) found.push("readingVisibility");
  }
  if (surfaces.includes("ownershipVisibility")) {
    let owns = false;
    for (const releaseId of scope.releaseIds) {
      if (owns) break;
      const entry = await ctx.db
        .query("collectionEntries")
        .withIndex("by_user_release", (q) => q.eq("userId", userId).eq("releaseId", releaseId))
        .first();
      owns = entry?.state === "owned";
    }
    for (const bundleId of scope.bundleIds) {
      if (owns) break;
      const entry = await ctx.db
        .query("collectionEntries")
        .withIndex("by_user_bundle", (q) => q.eq("userId", userId).eq("bundleId", bundleId))
        .first();
      owns = entry?.state === "owned";
    }
    if (owns) found.push("ownershipVisibility");
  }
  return found;
}

/**
 * A Series merge's Users who keep a survivor state row but had none on the
 * loser: their loser tracking followed the account default, so an explicit
 * public survivor override would publish it. On each surface they track
 * on the loser, that override goes back to the default (stricterVisibility
 * against a missing row), logged for Split. Users with a loser row are
 * combined as their rows merge; Users with no row on either side follow
 * the default on both, which the merge leaves as it was.
 */
async function guardSurvivorOverrides(
  ctx: MutationCtx,
  log: TransferLog,
  loserId: Id<"series">,
  survivorId: Id<"series">,
  handled: Set<Id<"users">>,
  editionIds: Set<Id<"editions">>,
): Promise<void> {
  const candidates = (
    await ctx.db
      .query("userSeriesStates")
      .withIndex("by_series", (q) => q.eq("seriesId", survivorId))
      .collect()
  ).filter((row) => !handled.has(row.userId) && VISIBILITY_FIELDS.some((f) => row[f] === "public"));
  if (candidates.length === 0) return;
  const releaseIds: Array<Id<"releases">> = [];
  const bundleIds = new Set<Id<"releaseBundles">>();
  for (const editionId of editionIds) {
    const releases = await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .collect();
    for (const release of releases) {
      releaseIds.push(release._id);
      for (const bundleId of await bundlesOf(ctx, release._id)) bundleIds.add(bundleId);
    }
  }
  const scope = { releaseIds, bundleIds: [...bundleIds], editionIds: [...editionIds] };
  for (const row of candidates) {
    const publicFields = VISIBILITY_FIELDS.filter((f) => row[f] === "public");
    const fields = await trackedSurfaces(ctx, row.userId, loserId, scope, publicFields);
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
 * Keep an Edition's own Ratings, Reviews and Favorites reachable when its
 * coverage stops making it an omnibus: once its coverage rows name exactly
 * one Volume (a Volume merge folded its two Volumes into one, or a Data Team
 * remap), it is rated through that Volume (lib/ratings.ts omnibusEdition),
 * so everything users left on the Edition moves to the Volume. The
 * Volume's own row wins where a user has both, and the Edition's is removed.
 * Both aggregates are recounted, which drops the Edition's ratingStats row.
 * Every move lands in `log`: a merge passes its manifest's log so a Split
 * puts the rows back (applySplit recounts what they touched). Without a log
 * the collapse is one-way. Does nothing while the coverage names zero or
 * several Volumes. Returns how many rows moved or were removed.
 */
export async function collapseEditionTakes(
  ctx: MutationCtx,
  editionId: Id<"editions">,
  log: TransferLog = { repointed: [], removed: [], inserted: [] },
): Promise<number> {
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
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
  const covering = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
    .collect();
  let count = 0;
  for (const editionId of new Set(covering.map((row) => row.editionId))) {
    const rows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .collect();
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
  if (ref.type === "series") return { kind: "series", id: ref.id as Id<"series"> };
  if (ref.type === "volume") return { kind: "volume", id: ref.id as Id<"volumes"> };
  if (ref.type === "edition") return { kind: "edition", id: ref.id as Id<"editions"> };
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
        .withIndex("by_family", (q) =>
          q.eq("familyId", loserDoc._id as Id<"seriesFamilies">),
        )
        .collect();
      for (const member of members) {
        await repoint(ctx, log, "series", member, { familyId: survivorDoc._id });
      }
      return;
    }

    case "series": {
      const loserId = loserDoc._id as Id<"series">;
      const survivorId = survivorDoc._id as Id<"series">;

      // Collect the editions whose release denorms mention the loser before
      // the volumes move (afterwards the coverage no longer leads back):
      // those covering its Volumes, and every member of its Edition Lines
      // (Unmapped Packaging covers nothing; its line names the Series).
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      const affectedEditions = new Set<Id<"editions">>();
      for (const volume of volumes) {
        const coverage = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
          .collect();
        for (const row of coverage) affectedEditions.add(row.editionId);
      }

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
        const members = await ctx.db
          .query("editions")
          .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
          .collect();
        for (const edition of members) affectedEditions.add(edition._id);
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
      // (a side without a row followed the default), for every User whose
      // tracking the merge moves, with or without a loser row.
      const states = await ctx.db
        .query("userSeriesStates")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const state of states) {
        const existing = await seriesStateOf(ctx, state.userId, survivorId);
        if (existing) {
          await removeRow(ctx, log, "userSeriesStates", state);
          await repoint(ctx, log, "userSeriesStates", existing, stricterVisibility(existing, [state]));
        } else {
          await repoint(ctx, log, "userSeriesStates", state, {
            seriesId: survivorId,
            ...stricterVisibility(state, [null]),
          });
        }
      }
      await guardSurvivorOverrides(
        ctx,
        log,
        loserId,
        survivorId,
        new Set(states.map((state) => state.userId)),
        affectedEditions,
      );
      // Progress rows key on user × release / user × volume, which the merge
      // does not change — repoint the series denorm only.
      const releaseProgress = await ctx.db
        .query("releaseProgress")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const row of releaseProgress) {
        await repoint(ctx, log, "releaseProgress", row, { seriesId: survivorId });
      }
      const volumeProgress = await ctx.db
        .query("volumeProgress")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const row of volumeProgress) {
        await repoint(ctx, log, "volumeProgress", row, { seriesId: survivorId });
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

      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_volume", (q) => q.eq("volumeId", loserId))
        .collect();
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
        const editionRows = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", row.editionId))
          .collect();
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
          .withIndex("by_user_volume", (q) =>
            q.eq("userId", row.userId).eq("volumeId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "volumeProgress", row);
        else {
          await repoint(ctx, log, "volumeProgress", row, {
            volumeId: survivorId,
            seriesId: survivor.seriesId,
          });
          if (crossSeries) {
            await carryVisibility(ctx, sink, row.userId, READING, [loserSeriesId], [survivor.seriesId]);
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
        .withIndex("by_line", (q) =>
          q.eq("editionLineId", loserDoc._id as Id<"editionLines">),
        )
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
      // their Releases' Series and the Series their omnibus Ratings ride on.
      const loserBefore = await editionGovernance(ctx, loserId);
      const survivorBefore = await editionGovernance(ctx, survivorId);

      const survivorCoverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", survivorId))
        .collect();
      const maxOrder = survivorCoverage.reduce((max, r) => Math.max(max, r.order), 0);
      const loserCoverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", loserId))
        .collect();
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

      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", loserId))
        .collect();
      for (const release of releases) {
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
      // as lib/ratings.ts reads it). A moved Rating now rides on the
      // survivor's first Series, which absorbs the Reading visibility of
      // the loser's.
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
      const primarySeries = await primaryVolumeSeries(ctx, survivorId);
      const loserRatedSeries = loserBefore.ratedSeriesId;
      if (loserRatedSeries && primarySeries) {
        for (const userId of movedRaters) {
          await carryVisibility(ctx, sink, userId, READING, [loserRatedSeries], [primarySeries._id]);
        }
      }
      const seriesDenorm = primarySeries ? { seriesId: primarySeries._id } : {};
      const favorites = await ctx.db
        .query("favorites")
        .withIndex("by_edition", (q) => q.eq("editionId", loserId))
        .collect();
      for (const row of favorites) {
        const existing = await ctx.db
          .query("favorites")
          .withIndex("by_user_edition", (q) => q.eq("userId", row.userId).eq("editionId", survivorId))
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
        for (const userId of await bundleOwners(ctx, membership.bundleId)) await carry(userId, OWNERSHIP);
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
      // derives it (reading.ts passSeriesId: the first covered Series,
      // merge-resolved), so a cross-Series merge files it under the right
      // work. A survivor without coverage leaves the pass's Series alone.
      const firstSeriesId = (survivorDoc as Doc<"releases">).seriesIds[0];
      const passSeriesId = firstSeriesId
        ? ((await followMerges(ctx, "series", await ctx.db.get(firstSeriesId)))?._id ?? firstSeriesId)
        : undefined;
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
          await carryVisibility(ctx, sink, row.userId, READING, [...fromSeries, row.seriesId], toSeries);
        }
      }
      return;
    }

    case "releaseVariant": {
      const loserId = loserDoc._id as Id<"releaseVariants">;
      const survivorId = survivorDoc._id as Id<"releaseVariants">;
      // Variant pins have no index of their own; variant merges are rare
      // enough that a scan of the two referencing tables is acceptable.
      for (const entry of await ctx.db.query("collectionEntries").collect()) {
        if (entry.variantId !== loserId) continue;
        await repoint(ctx, log, "collectionEntries", entry, { variantId: survivorId });
      }
      for (const membership of await ctx.db.query("bundleMemberships").collect()) {
        if (membership.variantId !== loserId) continue;
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
    loserRef: loser as never,
    survivorRef: survivor as never,
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
    .withIndex("by_loser", (q) =>
      q.eq("loserRef.type", ref.type).eq("loserRef.id", ref.id as never),
    )
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
 * `userId`) only while its User still exists. Account deletion redacts these
 * snapshots (redactUserFromManifests), and this guard covers any the
 * redaction has not reached yet.
 */
async function ownerExists(ctx: MutationCtx, doc: unknown): Promise<boolean> {
  const userId = (doc as { userId?: unknown }).userId;
  if (typeof userId !== "string") return true;
  const id = ctx.db.normalizeId("users", userId);
  return id !== null && (await ctx.db.get(id)) !== null;
}

/**
 * Personal snapshots a deleted User left in merge manifests, removed from one
 * page of manifests at a time. The account purge (users.purgeUser) schedules
 * internal.users.redactMergeManifests, which calls this per page; Split then
 * has nothing of theirs to reinsert.
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

/** Tables whose rows are one User's profile-visible tracking or its overrides. */
const TRACKING_TABLES = new Set([
  "userSeriesStates",
  "collectionEntries",
  "releaseProgress",
  "volumeProgress",
  "ratings",
]);

/** The Series a catalog record's tracking answers to on the profile. */
async function recordSeries(ctx: MutationCtx, ref: RecordRef): Promise<Array<Id<"series">>> {
  const doc = await getCanonical(ctx, ref);
  if (!doc) return [];
  switch (ref.type) {
    case "series":
      return [doc._id as Id<"series">];
    case "volume":
      return [(doc as Doc<"volumes">).seriesId];
    case "editionLine":
      return [(doc as Doc<"editionLines">).seriesId];
    case "edition": {
      const { releaseSeries } = await editionGovernance(ctx, doc._id as Id<"editions">);
      const ids = [...(await editionSeriesIds(ctx, doc as Doc<"editions">)), ...[...releaseSeries.values()].flat()];
      return [...new Set(ids)];
    }
    case "release":
      return (doc as Doc<"releases">).seriesIds;
    case "releaseBundle":
      return await bundleSeries(ctx, doc._id as Id<"releaseBundles">);
    default:
      return [];
  }
}

/** The Series named on one side (`before`: where Split sends it) of the manifests' Series references. */
function manifestSeries(
  ctx: MutationCtx,
  manifests: Array<Doc<"mergeManifests">>,
  side: "before" | "after",
): Array<Id<"series">> {
  const ids = manifests.flatMap((manifest) =>
    manifest.repointed
      .filter((entry) => entry.field === "seriesId" || entry.field === "seriesIds")
      .flatMap((entry): unknown[] => (Array.isArray(entry[side]) ? entry[side] : [entry[side]])),
  );
  return ids.flatMap((id) => {
    const seriesId = typeof id === "string" ? ctx.db.normalizeId("series", id) : null;
    return seriesId ? [seriesId] : [];
  });
}

/**
 * Every User whose tracking a Split moves: the owners of personal rows the
 * manifests repointed, removed or inserted, and everyone tracking a Release
 * whose Series they re-derived or a Bundle whose members they changed.
 */
async function splitTrackers(ctx: MutationCtx, manifests: Array<Doc<"mergeManifests">>) {
  const users = new Set<Id<"users">>();
  const releaseIds = new Set<Id<"releases">>();
  const bundleIds = new Set<Id<"releaseBundles">>();
  const addUser = (doc: unknown) => {
    const id = (doc as { userId?: unknown } | null)?.userId;
    const userId = typeof id === "string" ? ctx.db.normalizeId("users", id) : null;
    if (userId) users.add(userId);
  };
  const addBundle = (id: unknown) => {
    const bundleId = typeof id === "string" ? ctx.db.normalizeId("releaseBundles", id) : null;
    if (bundleId) bundleIds.add(bundleId);
  };
  const seen = new Set<string>();
  for (const manifest of manifests) {
    for (const row of manifest.removed) {
      if (TRACKING_TABLES.has(row.table)) addUser(row.doc);
      if (row.table === "bundleMemberships") addBundle((row.doc as { bundleId?: unknown }).bundleId);
    }
    for (const entry of manifest.repointed) {
      if (entry.table === "bundleMemberships" && entry.field === "bundleId") addBundle(entry.before);
      const releaseId = entry.field === "seriesIds" ? ctx.db.normalizeId("releases", entry.docId) : null;
      if (releaseId) releaseIds.add(releaseId);
    }
    for (const entry of [...manifest.repointed, ...manifest.inserted]) {
      if (entry.table === "releases") continue;
      if (seen.has(entry.docId)) continue;
      seen.add(entry.docId);
      if (TRACKING_TABLES.has(entry.table)) {
        const id = ctx.db.normalizeId(entry.table as TableNames, entry.docId);
        addUser(id ? await ctx.db.get(id) : null);
      } else if (entry.table === "bundleMemberships") {
        const id = ctx.db.normalizeId("bundleMemberships", entry.docId);
        addBundle(id ? (await ctx.db.get(id))?.bundleId : null);
      }
    }
  }
  for (const releaseId of releaseIds) {
    for (const table of ["collectionEntries", "releaseProgress"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
        .collect();
      for (const row of rows) users.add(row.userId);
    }
    for (const bundleId of await bundlesOf(ctx, releaseId)) bundleIds.add(bundleId);
  }
  for (const bundleId of bundleIds) {
    const entries = await ctx.db
      .query("collectionEntries")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
      .collect();
    for (const entry of entries) users.add(entry.userId);
  }
  return users;
}

/**
 * Taken before a Split replays anything: for each User whose tracking it
 * moves, the overrides on every Series the merged record's tracking answered
 * to (the survivor's, merge-followed), as keepSplitVisibility's floor.
 */
async function splitGovernance(
  ctx: MutationCtx,
  manifests: Array<Doc<"mergeManifests">>,
  survivor: RecordRef,
) {
  const governing = await governingSeries(ctx, [
    ...(await recordSeries(ctx, survivor)),
    ...manifestSeries(ctx, manifests, "after"),
  ]);
  const snapshots = new Map<Id<"users">, Map<Id<"series">, VisibilityOverrides | null>>();
  if (governing.length === 0) return snapshots;
  for (const userId of await splitTrackers(ctx, manifests)) {
    const snapshot = new Map<Id<"series">, VisibilityOverrides | null>();
    for (const seriesId of governing) {
      const state = await seriesStateOf(ctx, userId, seriesId);
      snapshot.set(
        seriesId,
        state && { ownershipVisibility: state.ownershipVisibility, readingVisibility: state.readingVisibility },
      );
    }
    snapshots.set(userId, snapshot);
  }
  return snapshots;
}

/**
 * After a Split, no tracking shows more than the merged record showed it
 * (`before`, from splitGovernance). Each governing Series gets back at most
 * its own earlier overrides (the replay may have reverted what the merge
 * narrowed, or taken its row back to the loser), and each Series the Split
 * sends tracking back to absorbs all of them (stricterVisibility), on a new
 * row if need be.
 */
async function keepSplitVisibility(
  ctx: MutationCtx,
  before: Awaited<ReturnType<typeof splitGovernance>>,
  loser: RecordRef,
  manifests: Array<Doc<"mergeManifests">>,
): Promise<void> {
  if (before.size === 0) return;
  const returned = await governingSeries(ctx, [
    ...(await recordSeries(ctx, loser)),
    ...manifestSeries(ctx, manifests, "before"),
  ]);
  const scratch = manifestSink(ctx, { repointed: [], removed: [], inserted: [] });
  for (const [userId, snapshot] of before) {
    for (const [seriesId, state] of snapshot) {
      await narrowState(ctx, scratch, userId, seriesId, [state]);
    }
    const floor = [...snapshot.values()];
    for (const seriesId of returned) {
      if (!snapshot.has(seriesId)) await narrowState(ctx, scratch, userId, seriesId, floor);
    }
  }
}

/**
 * Split — the only reversal of a mistaken merge: replay the merge's
 * manifest(s) backward (delete what it inserted, reinsert what it removed, repoint back
 * every reference that still points where the merge left it) and reactivate
 * the loser. References the world re-aimed since the merge are left alone,
 * and personal rows of a deleted User are never reinserted. Tracking
 * Visibility only ever narrows (keepSplitVisibility): an override the merge
 * narrowed stays narrow, since the User may have tracked more under it
 * since or another merge relied on it, and tracking the Split moves back
 * shows no more than the merged record showed it.
 */
export async function applySplit(
  ctx: MutationCtx,
  ref: RecordRef,
  meta: OpMeta,
): Promise<Id<"revisions">[]> {
  const doc = await requireRecord(ctx, ref);
  if (doc.status !== "merged" || !doc.mergedIntoId) {
    fail("badState", `Only merged records can be split back out; this ${ref.type} is ${doc.status}.`);
  }
  // Newest first: a chunked merge's manifests are undone in reverse order.
  const manifests = await reversibleManifestsOf(ctx, ref);
  const latest = manifests[0];
  if (!latest) {
    fail("noManifest", "This merge predates manifests and cannot be split automatically.");
  }
  const survivor = latest!.survivorRef as RecordRef;
  const governed = await splitGovernance(ctx, manifests, survivor);

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
      await ctx.db.insert(row.table as TableNames, row.doc as never);
    }
    for (const entry of [...manifest.repointed].reverse()) {
      const id = ctx.db.normalizeId(entry.table as TableNames, entry.docId);
      if (!id) continue;
      const target = (await ctx.db.get(id)) as Record<string, unknown> | null;
      if (!target) continue;
      if (!sameValue(target[entry.field], entry.after)) continue;
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

  await ctx.db.patch(ref.id, { status: "active", mergedIntoId: undefined } as never);
  await keepSplitVisibility(ctx, governed, ref, manifests);
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

// ---------- impact preview ----------

export type ImpactRow = { label: string; count: number };

/** Child Publisher rows the impact preview reads before it stops counting imprints. */
export const IMPRINT_PREVIEW_CAP = 100;

/**
 * What an operation on this record touches — shown to the Moderator before
 * every Hide/Restore/Merge/Split/Lock as the required impact preview
 * (spec §5). Counts use the same lookups the merge transfer walks.
 */
export async function impactOf(
  ctx: QueryCtx | MutationCtx,
  ref: RecordRef,
): Promise<ImpactRow[]> {
  const rows: ImpactRow[] = [];
  const add = (label: string, count: number) => rows.push({ label, count });

  add(
    "Source observations",
    (
      await ctx.db
        .query("sourceObservations")
        .withIndex("by_record", (q) =>
          q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id as never),
        )
        .collect()
    ).length,
  );
  add("Public revisions", (await revisionsOf(ctx, ref)).length);

  switch (ref.type) {
    case "publisher": {
      const id = ref.id as Id<"publishers">;
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
        children
          .slice(0, IMPRINT_PREVIEW_CAP)
          .filter((row) => row.status !== "merged").length,
      );
      add(
        "Edition lines",
        (await ctx.db.query("editionLines").collect()).filter(
          (l) => l.publisherId === id,
        ).length,
      );
      add(
        "Editions",
        (
          await ctx.db
            .query("editions")
            .withIndex("by_publisher", (q) => q.eq("publisherId", id))
            .collect()
        ).length,
      );
      add(
        "Releases",
        (
          await ctx.db
            .query("releases")
            .withIndex("by_publisher_date", (q) => q.eq("publisherId", id))
            .collect()
        ).length,
      );
      add(
        "Bundles",
        (await ctx.db.query("releaseBundles").collect()).filter(
          (b) => b.publisherId === id,
        ).length,
      );
      break;
    }
    case "seriesFamily": {
      add(
        "Member series",
        (
          await ctx.db
            .query("series")
            .withIndex("by_family", (q) => q.eq("familyId", ref.id as Id<"seriesFamilies">))
            .collect()
        ).length,
      );
      break;
    }
    case "series": {
      const id = ref.id as Id<"series">;
      add(
        "Volumes",
        (
          await ctx.db
            .query("volumes")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      add(
        "Edition lines",
        (
          await ctx.db
            .query("editionLines")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
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
      add(
        "User series states (follows, reading, visibility)",
        (
          await ctx.db
            .query("userSeriesStates")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      add(
        "Reading passes",
        (
          await ctx.db
            .query("releaseProgress")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      add(
        "Volume read counts",
        (
          await ctx.db
            .query("volumeProgress")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      add("Ratings", (await ratingsOf(ctx, { kind: "series", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "series", id })).length);
      add(
        "Favorites (of the series and its volumes)",
        (
          await ctx.db
            .query("favorites")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      add(
        "Comments (on the series and its volumes)",
        (
          await ctx.db
            .query("comments")
            .withIndex("by_series", (q) => q.eq("seriesId", id))
            .collect()
        ).length,
      );
      break;
    }
    case "volume": {
      const id = ref.id as Id<"volumes">;
      add(
        "Coverage rows (editions covering this volume)",
        (
          await ctx.db
            .query("volumeCoverages")
            .withIndex("by_volume", (q) => q.eq("volumeId", id))
            .collect()
        ).length,
      );
      add(
        "Volume read counts",
        (
          await ctx.db
            .query("volumeProgress")
            .withIndex("by_volume", (q) => q.eq("volumeId", id))
            .collect()
        ).length,
      );
      add("Ratings", (await ratingsOf(ctx, { kind: "volume", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "volume", id })).length);
      add(
        "Ratings, reviews and favorites of two-volume omnibuses (move to the survivor if the other Volume is merged)",
        await collapsibleTakes(ctx, id),
      );
      add(
        "Favorites",
        (
          await ctx.db
            .query("favorites")
            .withIndex("by_volume", (q) => q.eq("volumeId", id))
            .collect()
        ).length,
      );
      add(
        "Comments",
        (
          await ctx.db
            .query("comments")
            .withIndex("by_volume", (q) => q.eq("volumeId", id))
            .collect()
        ).length,
      );
      break;
    }
    case "editionLine": {
      add(
        "Editions in this line",
        (
          await ctx.db
            .query("editions")
            .withIndex("by_line", (q) => q.eq("editionLineId", ref.id as Id<"editionLines">))
            .collect()
        ).length,
      );
      break;
    }
    case "edition": {
      const id = ref.id as Id<"editions">;
      add(
        "Coverage rows",
        (
          await ctx.db
            .query("volumeCoverages")
            .withIndex("by_edition", (q) => q.eq("editionId", id))
            .collect()
        ).length,
      );
      add(
        "Releases",
        (
          await ctx.db
            .query("releases")
            .withIndex("by_edition", (q) => q.eq("editionId", id))
            .collect()
        ).length,
      );
      add("Ratings", (await ratingsOf(ctx, { kind: "edition", id })).length);
      add("Reviews", (await reviewsOf(ctx, { kind: "edition", id })).length);
      add(
        "Favorites",
        (
          await ctx.db
            .query("favorites")
            .withIndex("by_edition", (q) => q.eq("editionId", id))
            .collect()
        ).length,
      );
      break;
    }
    case "release": {
      const id = ref.id as Id<"releases">;
      add(
        "Variants",
        (
          await ctx.db
            .query("releaseVariants")
            .withIndex("by_release", (q) => q.eq("releaseId", id))
            .collect()
        ).length,
      );
      add(
        "Bundle memberships",
        (
          await ctx.db
            .query("bundleMemberships")
            .withIndex("by_release", (q) => q.eq("releaseId", id))
            .collect()
        ).length,
      );
      add(
        "Collection entries",
        (
          await ctx.db
            .query("collectionEntries")
            .withIndex("by_release", (q) => q.eq("releaseId", id))
            .collect()
        ).length,
      );
      add(
        "Reading passes",
        (
          await ctx.db
            .query("releaseProgress")
            .withIndex("by_release", (q) => q.eq("releaseId", id))
            .collect()
        ).length,
      );
      break;
    }
    case "releaseVariant": {
      const id = ref.id as Id<"releaseVariants">;
      add(
        "Collection entries pinning this variant",
        (await ctx.db.query("collectionEntries").collect()).filter(
          (e) => e.variantId === id,
        ).length,
      );
      add(
        "Bundle memberships pinning this variant",
        (await ctx.db.query("bundleMemberships").collect()).filter(
          (m) => m.variantId === id,
        ).length,
      );
      break;
    }
    case "releaseBundle": {
      const id = ref.id as Id<"releaseBundles">;
      add(
        "Member releases",
        (
          await ctx.db
            .query("bundleMemberships")
            .withIndex("by_bundle", (q) => q.eq("bundleId", id))
            .collect()
        ).length,
      );
      add(
        "Collection entries",
        (
          await ctx.db
            .query("collectionEntries")
            .withIndex("by_bundle", (q) => q.eq("bundleId", id))
            .collect()
        ).length,
      );
      break;
    }
  }
  return rows;
}
