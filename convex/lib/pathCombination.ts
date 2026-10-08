// Resolve the series-scoped display choice for both public and personal
// shelves. Publisher merges never require rewriting the choice itself.
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { PathCombination } from "./editionGroups";
import { followMerges } from "./merges";

export async function pathCombination(
  ctx: QueryCtx,
  series: Doc<"series">,
): Promise<PathCombination | undefined> {
  const publishers = new Map<string, { name: string; slug: string }>();
  const aliases = new Set<string>();
  for (const id of series.combinedPathPublisherIds ?? []) {
    const stored = await ctx.db.get(id);
    const publisher = await followMerges(ctx, "publishers", stored);
    if (!publisher) continue;
    publishers.set(publisher._id, { name: publisher.name, slug: publisher.slug });
    aliases.add(publisher.slug);
    if (stored) aliases.add(stored.slug);
  }
  return publishers.size >= 2
    ? { publishers: [...publishers.values()], aliases: [...aliases] }
    : undefined;
}
