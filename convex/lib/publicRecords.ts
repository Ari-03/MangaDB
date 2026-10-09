// What the public catalog shows, for everything a reader (a signed-in User
// holding no data-team role) may draft on, cite or read back: the forms
// (moderation.ts editForm, sourceBlurbs), their Suggestions
// (proposals.ts, suggestions.ts), the observations they cite as evidence
// (lib/evidence.ts) and the cover art they reuse (lib/coverRefs.ts).

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { CatalogDoc, CatalogTable, RecordRef } from "../moderation";
import type { RecordType } from "./moderationFields";

/**
 * How a check reads a document by id: straight from the database by
 * default, or through a response's shared cache and read budget
 * (lib/proposalReads.ts `get`).
 */
export type RecordGet = <T extends TableNames>(id: Id<T>) => Promise<Doc<T> | null>;

/**
 * Whether the public catalog shows `doc` as itself: it is active, and so is
 * what its page or row hangs from, as the page queries judge it
 * (catalogPages.ts): a Volume's Series (volumePage), a Release's Edition
 * (editionPage rows), a Variant's Release. A merged record's page redirects
 * to its survivor, so it is not shown as itself. An Edition stays shown
 * when the Series it covers are hidden, as editionPage keeps it.
 */
export async function publiclyVisible(
  ctx: QueryCtx,
  type: RecordType,
  doc: CatalogDoc,
  get: RecordGet = (id) => ctx.db.get(id),
): Promise<boolean> {
  if (doc.status !== "active") return false;
  const shown = async (parentType: RecordType, id: Id<CatalogTable>) => {
    const parent = await get(id);
    return parent !== null && (await publiclyVisible(ctx, parentType, parent, get));
  };
  switch (type) {
    case "volume":
      return await shown("series", (doc as Doc<"volumes">).seriesId);
    case "release":
      return await shown("edition", (doc as Doc<"releases">).editionId);
    case "releaseVariant":
      return await shown("release", (doc as Doc<"releaseVariants">).releaseId);
    default:
      return true;
  }
}

/** Whether `ref` names a record the public catalog shows. */
export async function publicRecord(
  ctx: QueryCtx,
  ref: RecordRef | undefined,
  get: RecordGet = (id) => ctx.db.get(id),
): Promise<boolean> {
  if (!ref) return false;
  const doc = await get(ref.id);
  return doc !== null && (await publiclyVisible(ctx, ref.type, doc, get));
}

/**
 * Whether a reader may cite or read an observation: it is linked to a
 * record the public catalog shows, whose sources' pages are no secret. An
 * unlinked one (a held book) or one of a hidden record stays the Data
 * Team's.
 */
export async function observationPublic(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations"> | null,
): Promise<boolean> {
  return observation !== null && (await publicRecord(ctx, observation.recordRef));
}
