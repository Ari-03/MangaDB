// Public IDs (spec §8): per-entity sequential integers allocated from the
// `counters` table. Slugs are cosmetic and computed at request time; the
// integer is the stable half of every catalog URL (/series/{id}/{slug}).
// Releases deliberately have none — they anchor on their Edition's page.

import type { MutationCtx } from "../_generated/server";

/** Entities that carry a public ID; each has its own counter row. */
export type PublicIdEntity = "series" | "volume" | "edition" | "bundle" | "person";

/** Allocate the next sequential public ID for one new record. */
export async function allocatePublicId(
  ctx: MutationCtx,
  entity: PublicIdEntity,
): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_entity", (q) => q.eq("entity", entity))
    .unique();
  if (!counter) {
    await ctx.db.insert("counters", { entity, next: 2 });
    return 1;
  }
  await ctx.db.patch(counter._id, { next: counter.next + 1 });
  return counter.next;
}
