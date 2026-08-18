// Public IDs (spec §8): per-entity sequential integers allocated from the
// `counters` table. Slugs are cosmetic and computed at request time; the
// integer is the stable half of every catalog URL (/series/{id}/{slug}).
// Releases deliberately have none — they anchor on their Edition's page.

import type { MutationCtx } from "../_generated/server";

/** Entities that carry a public ID; each has its own counter row. */
export type PublicIdEntity = "series" | "volume" | "edition" | "bundle";

/**
 * Allocate `count` consecutive public IDs in one counter bump and return the
 * first. Imports reserve blocks this way (spec §8); interactive writes take
 * one at a time via `allocatePublicId`. Gaps from abandoned reservations are
 * fine — IDs are identity, not census.
 */
export async function allocatePublicIdBlock(
  ctx: MutationCtx,
  entity: PublicIdEntity,
  count: number,
): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_entity", (q) => q.eq("entity", entity))
    .unique();
  if (!counter) {
    await ctx.db.insert("counters", { entity, next: 1 + count });
    return 1;
  }
  await ctx.db.patch(counter._id, { next: counter.next + count });
  return counter.next;
}

/** Allocate the next sequential public ID for one new record. */
export async function allocatePublicId(
  ctx: MutationCtx,
  entity: PublicIdEntity,
): Promise<number> {
  return await allocatePublicIdBlock(ctx, entity, 1);
}
