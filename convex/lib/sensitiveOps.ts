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
// skipping anything the world changed since.

import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  displayInfo,
  getCanonical,
  revisionsOf,
  type CatalogDoc,
  type RecordRef,
} from "../moderation";
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
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
  const seriesIds: Id<"series">[] = [];
  for (const row of coverage) {
    const volume = await ctx.db.get(row.volumeId);
    if (volume && !seriesIds.includes(volume.seriesId)) {
      seriesIds.push(volume.seriesId);
    }
  }
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
  switch (type) {
    case "publisher": {
      const loser = loserDoc as Doc<"publishers">;
      const survivor = survivorDoc as Doc<"publishers">;
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
      // the volumes move (afterwards the coverage no longer leads back).
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

      // User tracking: one row per user × series — the survivor's row wins.
      const states = await ctx.db
        .query("userSeriesStates")
        .withIndex("by_series", (q) => q.eq("seriesId", loserId))
        .collect();
      for (const state of states) {
        const existing = await ctx.db
          .query("userSeriesStates")
          .withIndex("by_user_series", (q) =>
            q.eq("userId", state.userId).eq("seriesId", survivorId),
          )
          .unique();
        if (existing) await removeRow(ctx, log, "userSeriesStates", state);
        else await repoint(ctx, log, "userSeriesStates", state, { seriesId: survivorId });
      }
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
        }
      }

      for (const editionId of affectedEditions) {
        await recomputeReleaseDenorms(ctx, log, editionId);
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
      for (const edition of editions) {
        await repoint(ctx, log, "editions", edition, {
          editionLineId: survivorDoc._id,
        });
      }
      return;
    }

    case "edition": {
      const loserId = loserDoc._id as Id<"editions">;
      const survivorId = survivorDoc._id as Id<"editions">;

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
      // seriesIds/publisherId denorms from the survivor edition.
      await recomputeReleaseDenorms(ctx, log, survivorId);
      return;
    }

    case "release": {
      const loserId = loserDoc._id as Id<"releases">;
      const survivorId = survivorDoc._id as Id<"releases">;

      const variants = await ctx.db
        .query("releaseVariants")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const variant of variants) {
        await repoint(ctx, log, "releaseVariants", variant, { releaseId: survivorId });
      }

      const memberships = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_release", (q) => q.eq("releaseId", loserId))
        .collect();
      for (const membership of memberships) {
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
        else await repoint(ctx, log, "collectionEntries", entry, { releaseId: survivorId });
      }

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
        else await repoint(ctx, log, "releaseProgress", row, { releaseId: survivorId });
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
  const manifests = await ctx.db
    .query("mergeManifests")
    .withIndex("by_loser", (q) =>
      q.eq("loserRef.type", ref.type).eq("loserRef.id", ref.id as never),
    )
    .collect();
  const open = manifests
    .filter((m) => m.reversedAt === undefined)
    .sort((a, b) => b._creationTime - a._creationTime);
  return open[0] ?? null;
}

/**
 * Split — the only reversal of a mistaken merge: replay the merge manifest
 * backward (delete what it inserted, reinsert what it removed, repoint back
 * every reference that still points where the merge left it) and reactivate
 * the loser. References the world re-aimed since the merge are left alone.
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
  const manifest = await reversibleManifestOf(ctx, ref);
  if (!manifest) {
    fail("noManifest", "This merge predates manifests and cannot be split automatically.");
  }
  const survivor = manifest!.survivorRef as RecordRef;

  for (const row of manifest!.inserted) {
    const id = ctx.db.normalizeId(row.table as TableNames, row.docId);
    if (id && (await ctx.db.get(id))) await ctx.db.delete(id);
  }
  for (const row of manifest!.removed) {
    await ctx.db.insert(row.table as TableNames, row.doc as never);
  }
  for (const entry of [...manifest!.repointed].reverse()) {
    const id = ctx.db.normalizeId(entry.table as TableNames, entry.docId);
    if (!id) continue;
    const target = (await ctx.db.get(id)) as Record<string, unknown> | null;
    if (!target) continue;
    if (!sameValue(target[entry.field], entry.after)) continue;
    await ctx.db.patch(id, { [entry.field]: entry.before } as never);
  }

  await ctx.db.patch(ref.id, { status: "active", mergedIntoId: undefined } as never);
  await ctx.db.patch(manifest!._id, { reversedAt: Date.now() });

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
