// Stored cover art that people change through the moderation write path
// (the registry's `coverImage`, lib/moderationFields.ts): which blobs are
// still needed, whether a blob may go into a change, and which a reader
// may see (`publicArt`).
//
// A blob is needed while any Release, Bundle or Release Variant shows it,
// any Revision names it (History keeps every cover it ever showed), or a
// Proposal still in Draft or In Review names it. Revisions and Proposals
// record that in `coverRefs`, one row per blob and holder, so the check is
// an index read, never a scan of history. Revisions written before
// `coverRefs` existed get their pins from a backfill
// (coverUploads.pinRevisionCovers), and until it finishes every blob counts
// as needed. Two callers delete blobs, and both ask `coverInUse` first: the
// importer replacing art (imports.attachCover) and the hourly sweep of
// abandoned uploads (coverUploads.ts).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { CatalogDoc } from "../moderation";
import { MIN_COVER_BYTES } from "./covers";
import { fail } from "./errors";
import { COVER_TYPES, MAX_COVER_UPLOAD_BYTES, type RecordType } from "./moderationFields";
import { publiclyVisible, publicRecord } from "./publicRecords";
import { onDataTeam } from "./roles";

type Change = { field: string; before?: unknown; after?: unknown };

/** Pins read per blob before `coverInUse` assumes it is needed. */
const PIN_SCAN = 50;

/** The storage id a stored or submitted cover value names, if any. */
export function coverStorageId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { storageId } = value as { storageId?: unknown };
  return typeof storageId === "string" ? storageId : null;
}

/** Every blob the `coverImage` changes in `changes` name, before and after. */
export function coverBlobsOf(changes: ReadonlyArray<Change>): Array<Id<"_storage">> {
  const ids = new Set<Id<"_storage">>();
  for (const change of changes) {
    if (change.field !== "coverImage") continue;
    for (const value of [change.before, change.after]) {
      const id = coverStorageId(value);
      if (id !== null) ids.add(id as Id<"_storage">);
    }
  }
  return [...ids];
}

/**
 * Record that `holder` needs each of `storageIds`. A Proposal pins a blob
 * once however often its draft is saved; a Revision pins each blob once,
 * being immutable.
 */
export async function pinCovers(
  ctx: MutationCtx,
  storageIds: ReadonlyArray<Id<"_storage">>,
  holder: { revisionId: Id<"revisions"> } | { proposalId: Id<"proposals"> },
) {
  for (const storageId of storageIds) {
    if ("proposalId" in holder) {
      const pins = await ctx.db
        .query("coverRefs")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .take(PIN_SCAN);
      if (pins.some((pin) => pin.proposalId === holder.proposalId)) continue;
    }
    await ctx.db.insert("coverRefs", { storageId, ...holder });
  }
}

/**
 * Whether a Revision, or (unless `revisionsOnly`) a Proposal still in Draft
 * or In Review, names `storageId`. Past PIN_SCAN pins it answers yes: so many holders mean the
 * blob is in use.
 */
export async function pinned(ctx: QueryCtx, storageId: Id<"_storage">, revisionsOnly: boolean) {
  const pins = await ctx.db
    .query("coverRefs")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(PIN_SCAN + 1);
  if (pins.length > PIN_SCAN) return true;
  for (const pin of pins) {
    if (pin.revisionId !== undefined) return true;
    if (revisionsOnly || pin.proposalId === undefined) continue;
    const proposal = await ctx.db.get(pin.proposalId);
    if (proposal?.state === "draft" || proposal?.state === "inReview") return true;
  }
  return false;
}

/** Whether a Release (other than `exceptRelease`), a Bundle or a Release Variant shows `storageId`. */
export async function shown(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  exceptRelease?: Id<"releases">,
): Promise<boolean> {
  const releases = await ctx.db
    .query("releases")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .take(2);
  if (releases.some((release) => release._id !== exceptRelease)) return true;
  const bundle = await ctx.db
    .query("releaseBundles")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .first();
  if (bundle !== null) return true;
  const variant = await ctx.db
    .query("releaseVariants")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .first();
  return variant !== null;
}

/**
 * Whether a record the public catalog shows (lib/publicRecords.ts) holds
 * `storageId`: a Release, Bundle or Variant showing it now, or a Revision
 * naming it, which that record's public History shows. The art a reader
 * may reuse or see beside their Suggestion, besides their own uploads.
 * Reads at most PIN_SCAN holders of each kind.
 */
export async function publicArt(ctx: QueryCtx, storageId: Id<"_storage">): Promise<boolean> {
  const holders: Array<[RecordType, CatalogDoc]> = [];
  for (const release of await ctx.db
    .query("releases")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .take(PIN_SCAN)) {
    holders.push(["release", release]);
  }
  for (const bundle of await ctx.db
    .query("releaseBundles")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .take(PIN_SCAN)) {
    holders.push(["releaseBundle", bundle]);
  }
  for (const variant of await ctx.db
    .query("releaseVariants")
    .withIndex("by_cover", (q) => q.eq("coverImage.storageId", storageId))
    .take(PIN_SCAN)) {
    holders.push(["releaseVariant", variant]);
  }
  for (const [type, doc] of holders) {
    if (await publiclyVisible(ctx, type, doc)) return true;
  }
  const pins = await ctx.db
    .query("coverRefs")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(PIN_SCAN);
  for (const pin of pins) {
    const revision = pin.revisionId ? await ctx.db.get(pin.revisionId) : null;
    if (revision && (await publicRecord(ctx, revision.ref))) return true;
  }
  return false;
}

/** Whether `userId` uploaded `storageId` (coverUploads.ts), while its upload row lasts. */
export async function ownUpload(ctx: QueryCtx, storageId: Id<"_storage">, userId: Id<"users">) {
  const upload = await ctx.db
    .query("coverUploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  return upload?.uploaderId === userId;
}

/** Whether every Revision written before `coverRefs` existed has its covers pinned. */
export async function historyPinned(ctx: QueryCtx): Promise<boolean> {
  return (await ctx.db.query("coverPinBackfill").first())?.done === true;
}

/**
 * Whether `storageId` must be kept: something shows it (a Release other
 * than `exceptRelease`, a Bundle, a Variant), a Revision names it, or a
 * pending Proposal does. Until the backfill of older Revisions' pins
 * finishes (`historyPinned`), every blob must be kept.
 */
export async function coverInUse(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  exceptRelease?: Id<"releases">,
): Promise<boolean> {
  if (!(await historyPinned(ctx))) return true;
  return (await shown(ctx, storageId, exceptRelease)) || (await pinned(ctx, storageId, false));
}

/**
 * Refuse a blob the shelf could not show: missing (deleted since it was
 * chosen), markup, or a placeholder-sized file. An `upload` is held to the
 * upload rules as well: JPEG, PNG or WebP, at most MAX_COVER_UPLOAD_BYTES.
 */
export async function checkCoverBlob(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  upload: boolean,
): Promise<void> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) fail("invalidField", "The cover's file is no longer stored. Upload it again.");
  const type = meta.contentType ?? "";
  if (type === "image/svg+xml" || meta.size < MIN_COVER_BYTES) {
    fail("invalidField", "That file is a placeholder, not cover art.");
  }
  if (upload && !(COVER_TYPES as readonly string[]).includes(type)) {
    fail("invalidField", "Only JPEG, PNG or WebP. GIF and SVG are not shelved.");
  }
  if (upload && meta.size > MAX_COVER_UPLOAD_BYTES) {
    fail("invalidField", "Over 10 MB. Export a smaller JPEG.");
  }
}

/** A submitted storage id as an Id, or a refusal: client input is only a string. */
function storageIdOf(ctx: QueryCtx, raw: string): Id<"_storage"> {
  const id = ctx.db.system.normalizeId("_storage", raw);
  if (id === null) fail("invalidField", "A cover needs an uploaded file.");
  return id;
}

/**
 * Refuse a cover value whose blob is gone or no longer shelvable: approval
 * runs this on every cover an op sets, since time passed since submission.
 */
export async function checkCoverStored(ctx: QueryCtx, value: unknown) {
  const raw = coverStorageId(value);
  if (raw !== null) await checkCoverBlob(ctx, storageIdOf(ctx, raw), false);
}

/**
 * Whether `author` may put the cover in `change` on `doc`: removing art,
 * keeping the record's own blob, a blob `author` uploaded (coverUploads.ts),
 * or art the catalog already holds. For the Data Team that is any art a
 * record shows or History names; for a reader (`reader`, by default one
 * holding no data-team role; proposals.ts passes it for a Suggestion
 * whoever writes it) only art a record the public catalog shows holds
 * (`publicArt`), so a Suggestion cannot reach art only a hidden record
 * has. Anything else is a blob they have no claim to.
 * Checked when a direct edit is saved and when a Proposal is drafted or
 * submitted; approval checks only that the blob is still there
 * (`checkCoverBlob`), since the Proposal has pinned it.
 */
export async function checkCoverUse(
  ctx: QueryCtx,
  doc: Pick<Doc<"releases">, "coverImage">,
  change: Change,
  author: Doc<"users">,
  reader = !onDataTeam(author),
) {
  const raw = coverStorageId(change.after);
  if (raw === null) return;
  const storageId = storageIdOf(ctx, raw);
  if (storageId === doc.coverImage?.storageId) return;
  const upload = await ctx.db
    .query("coverUploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (upload !== null) {
    if (upload.uploaderId !== author._id) {
      fail("forbidden", "That cover was uploaded by someone else.");
    }
    await checkCoverBlob(ctx, storageId, true);
    return;
  }
  const catalogArt = reader
    ? await publicArt(ctx, storageId)
    : (await shown(ctx, storageId)) || (await pinned(ctx, storageId, true));
  if (!catalogArt) {
    fail("invalidField", "That file is not an upload of yours or art on the catalog.");
  }
  await checkCoverBlob(ctx, storageId, false);
}
