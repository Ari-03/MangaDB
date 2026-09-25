// Audit trail and shared catalog plumbing for the one-time repair. Each plan
// entry that writes becomes one immediately approved Proposal authored by
// the operator (the same shape sensitiveOps' direct Moderator operations
// record), and every record it changes gets an immutable Revision carrying
// that proposalId — so moderation history reads as if a Moderator had made
// the correction by hand.

import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { revisionsOf } from "../../moderation";
import type { evidence, recordRef } from "../../schema";
import { allocatePublicId } from "../publicIds";
import type { OpMeta } from "../sensitiveOps";
import { sameValue } from "../values";

export type Ref = Infer<typeof recordRef>;
type StoredOp = Doc<"proposalVersions">["ops"][number];
type Evidence = Infer<typeof evidence>;
export type Change = { field: string; before?: unknown; after?: unknown };

/** Throw mid-entry: the entry's sub-transaction rolls back and it reports as skipped. */
export const skip = (reason: string): never => {
  throw new ConvexError({ skip: reason });
};

/** The operator every repair Revision is attributed to. */
export type Actor = { userId: Id<"users">; role: Doc<"users">["role"] };

export async function resolveActor(ctx: MutationCtx, username: string): Promise<Actor> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("usernameNormalized", username.toLowerCase()))
    .unique();
  if (!user || (user.role !== "administrator" && user.role !== "moderator")) {
    throw new ConvexError(`Repair actor "${username}" must be an existing Moderator or Administrator.`);
  }
  return { userId: user._id, role: user.role };
}

/**
 * One entry's audit trail. The Proposal is created lazily on the first
 * write, so skipped and no-op entries leave no trace; `wrote` is what the
 * dry-run uses to decide whether the entry must be rolled back.
 */
export type Audit = ReturnType<typeof createAudit>;

export function createAudit(
  ctx: MutationCtx,
  actor: Actor,
  comment: string,
  evidenceRows: Evidence[],
) {
  const author = { kind: "user" as const, userId: actor.userId, roleAtAuthorship: actor.role };
  const ops: StoredOp[] = [];
  const notes: string[] = [];
  let meta: OpMeta | null = null;

  return {
    notes,
    get wrote() {
      return meta !== null;
    },
    /** The Proposal meta stock apply functions stamp on their Revisions. */
    async meta(): Promise<OpMeta> {
      if (meta) return meta;
      const now = Date.now();
      const proposalId = await ctx.db.insert("proposals", {
        author,
        state: "approved",
        currentVersionNo: 1,
        submittedAt: now,
        decidedBy: actor.userId,
        decidedAt: now,
      });
      meta = { proposalId, author, approvedBy: actor.userId, comment };
      return meta;
    },
    op(op: StoredOp) {
      ops.push(op);
    },
    note(text: string) {
      notes.push(text);
    },
    /** Append the next Revision to one record's public history. */
    async revise(ref: Ref, changes: Change[]) {
      if (changes.length === 0) return;
      const { proposalId } = await this.meta();
      const latest = (await revisionsOf(ctx, ref))[0];
      await ctx.db.insert("revisions", {
        ref,
        seq: (latest?.seq ?? 0) + 1,
        proposalId,
        author,
        approvedBy: actor.userId,
        changes,
        comment,
      });
    },
    /** Freeze the Proposal's immutable version once the entry is done. */
    async finish() {
      if (!meta) return;
      await ctx.db.insert("proposalVersions", {
        proposalId: meta.proposalId,
        versionNo: 1,
        ops,
        evidence: evidenceRows,
        changeComment: comment,
      });
    },
  };
}

/** Patch a record and write the Revision for exactly the fields that changed. */
export async function updateRecord<T extends "publishers" | "series" | "volumes" | "editions" | "releases">(
  ctx: MutationCtx,
  audit: Audit,
  ref: Ref & { id: Id<T> },
  doc: Doc<T>,
  patch: Partial<Doc<T>>,
): Promise<boolean> {
  const current = doc as Record<string, unknown>;
  const changes: Change[] = [];
  for (const [field, after] of Object.entries(patch)) {
    if (!sameValue(current[field], after)) {
      changes.push({ field, before: current[field], after });
    }
  }
  if (changes.length === 0) return false;
  await audit.meta();
  await ctx.db.patch(ref.id, patch);
  audit.op({ kind: "update", ref, changes });
  await audit.revise(ref, changes.filter((c) => c.field !== "searchText"));
  return true;
}

// ---------- volume labels & positions ----------

const NUMERIC = /^\d+(\.\d+)?$/;

/** "02" → "2", "0" stays "0", "15.50" → "15.5"; other labels are trimmed. */
export function canonicalLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  return NUMERIC.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

/** The volume number a label names, or null for unnumbered labels. */
export function labelNumber(label: string | null | undefined): number | null {
  const canonical = canonicalLabel(label);
  return canonical !== null && NUMERIC.test(canonical) ? Number(canonical) : null;
}

export function sameLabel(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalLabel(a);
  const cb = canonicalLabel(b);
  return ca === null || cb === null ? ca === cb : ca.toLowerCase() === cb.toLowerCase();
}

export async function activeVolumes(ctx: MutationCtx, seriesId: Id<"series">) {
  return (
    await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect()
  ).filter((vol) => vol.status === "active");
}

/**
 * Volume Position = volume number (owner decision, schema.ts): numbered
 * Volumes sit at their number; unnumbered ones follow the last number in
 * their current order. Idempotent.
 */
export async function settlePositions(
  ctx: MutationCtx,
  audit: Audit,
  seriesId: Id<"series">,
): Promise<void> {
  const volumes = await activeVolumes(ctx, seriesId);
  const maxNumber = volumes.reduce((max, vol) => Math.max(max, labelNumber(vol.label) ?? 0), 0);
  const unnumbered = volumes
    .filter((vol) => labelNumber(vol.label) === null)
    .sort((a, b) => a.position - b.position);
  const target = new Map(volumes.map((vol) => [vol._id, labelNumber(vol.label)]));
  unnumbered.forEach((vol, i) => target.set(vol._id, maxNumber + 1 + i));
  for (const vol of volumes) {
    const position = target.get(vol._id);
    if (position === undefined || position === null || position === vol.position) continue;
    await updateRecord(ctx, audit, { type: "volume", id: vol._id }, vol, { position });
  }
}

/**
 * The Series' active Volume with this label (null = the unlabeled one),
 * creating it (Volume Position = its number, else after the last) when
 * absent. Created Volumes are bootstrap-unreviewed.
 */
export async function ensureVolume(
  ctx: MutationCtx,
  audit: Audit,
  seriesId: Id<"series">,
  label: string | null,
): Promise<Doc<"volumes">> {
  const existing = (await activeVolumes(ctx, seriesId)).filter((vol) => sameLabel(vol.label, label));
  if (existing.length > 1) skip(`series has ${existing.length} volumes labelled "${label ?? "(none)"}"`);
  if (existing[0]) return existing[0];
  await audit.meta();
  const canonical = canonicalLabel(label);
  const last = (await activeVolumes(ctx, seriesId)).reduce((max, vol) => Math.max(max, vol.position), 0);
  const fields = {
    status: "active" as const,
    publicId: await allocatePublicId(ctx, "volume"),
    seriesId,
    ...(canonical === null ? {} : { label: canonical }),
    position: labelNumber(canonical) ?? last + 1,
    bootstrapUnreviewed: true,
  };
  const id = await ctx.db.insert("volumes", fields);
  audit.op({ kind: "create", table: "volumes", tempId: id, fields });
  await audit.revise(
    { type: "volume", id },
    Object.entries(fields).map(([field, after]) => ({ field, after })),
  );
  const created = await ctx.db.get(id);
  return created ?? skip("created volume vanished");
}

// ---------- editions, coverage, releases ----------

export async function coverageOf(ctx: MutationCtx, editionId: Id<"editions">) {
  return await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

export async function releasesOf(ctx: MutationCtx, editionId: Id<"editions">) {
  return await ctx.db
    .query("releases")
    .withIndex("by_edition", (q) => q.eq("editionId", editionId))
    .collect();
}

/** Active Editions covering a Volume. */
export async function activeEditionsCovering(ctx: MutationCtx, volumeId: Id<"volumes">) {
  const rows = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
    .collect();
  const editions: Doc<"editions">[] = [];
  for (const row of rows) {
    const edition = await ctx.db.get(row.editionId);
    if (edition && edition.status === "active") editions.push(edition);
  }
  return editions;
}

/**
 * Recompute the release denorms (seriesIds, publisherId — spec §8) of one
 * Edition from its coverage. Derived fields: no Revision.
 */
export async function refreshReleaseDenorms(ctx: MutationCtx, editionId: Id<"editions">) {
  const edition = await ctx.db.get(editionId);
  if (!edition) return;
  const seriesIds: Id<"series">[] = [];
  for (const row of await coverageOf(ctx, editionId)) {
    const volume = await ctx.db.get(row.volumeId);
    if (volume && !seriesIds.includes(volume.seriesId)) seriesIds.push(volume.seriesId);
  }
  for (const release of await releasesOf(ctx, editionId)) {
    if (sameValue(release.seriesIds, seriesIds) && release.publisherId === edition.publisherId) continue;
    await ctx.db.patch(release._id, { seriesIds, publisherId: edition.publisherId });
  }
}

/** Human-readable coverage for the Edition's "volumeCoverage" pseudo-field. */
async function describeCoverage(ctx: MutationCtx, editionId: Id<"editions">) {
  const described: string[] = [];
  for (const row of (await coverageOf(ctx, editionId)).sort((a, b) => a.order - b.order)) {
    const volume = await ctx.db.get(row.volumeId);
    described.push(
      `${volume ? `#${volume.publicId} ${volume.label ?? "(unlabelled)"}` : "missing volume"}${row.extent === "partial" ? " (partial)" : ""}`,
    );
  }
  return described;
}

/**
 * Replace an Edition's Volume Coverage. Coverage edits land on the Edition
 * as the pseudo-field "volumeCoverage" (schema.ts recordRef note).
 */
export async function replaceCoverage(
  ctx: MutationCtx,
  audit: Audit,
  editionId: Id<"editions">,
  rows: Array<{ volumeId: Id<"volumes">; extent: "complete" | "partial" }>,
): Promise<boolean> {
  const current = (await coverageOf(ctx, editionId)).sort((a, b) => a.order - b.order);
  const same =
    current.length === rows.length &&
    current.every((row, i) => row.volumeId === rows[i]?.volumeId && row.extent === rows[i]?.extent);
  if (same) return false;
  await audit.meta();
  const before = await describeCoverage(ctx, editionId);
  for (const row of current) await ctx.db.delete(row._id);
  for (const [i, row] of rows.entries()) {
    await ctx.db.insert("volumeCoverages", { editionId, volumeId: row.volumeId, order: i + 1, extent: row.extent });
  }
  const after = await describeCoverage(ctx, editionId);
  const ref = { type: "edition" as const, id: editionId };
  audit.op({ kind: "update", ref, changes: [{ field: "volumeCoverage", before, after }] });
  await audit.revise(ref, [{ field: "volumeCoverage", before, after }]);
  await refreshReleaseDenorms(ctx, editionId);
  return true;
}

/** Insert a catalog row with a creation Revision listing its initial fields. */
export async function createEdition(
  ctx: MutationCtx,
  audit: Audit,
  fields: Omit<Doc<"editions">, "_id" | "_creationTime" | "publicId">,
): Promise<Id<"editions">> {
  await audit.meta();
  const row = { ...fields, publicId: await allocatePublicId(ctx, "edition") };
  const id = await ctx.db.insert("editions", row);
  audit.op({ kind: "create", table: "editions", tempId: id, fields: row });
  await audit.revise(
    { type: "edition", id },
    Object.entries(row).map(([field, after]) => ({ field, after })),
  );
  return id;
}
