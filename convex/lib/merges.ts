// Following merges (spec §4/§8): a merged record keeps its public ID and
// points at the record that absorbed it, so reads resolve every stored
// reference to its survivor. Public pages and tracking alike read through
// these; catalogPages.ts re-exports `followMerges` for older importers.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type MergeableTable =
  | "publishers"
  | "series"
  | "volumes"
  | "editionLines"
  | "editions"
  | "releases"
  | "releaseBundles";

/**
 * The record a merge chain ends at, whatever its status, cycle-guarded.
 * Maturity reads content through this rather than `followMerges`, so hiding
 * a record never makes what it holds general.
 */
export async function mergeSurvivor<T extends MergeableTable>(
  ctx: QueryCtx,
  // The table name anchors T's inference — `Doc<T>` alone is an indexed
  // access type TypeScript cannot infer backward from.
  _table: T,
  doc: Doc<T> | null,
): Promise<Doc<T> | null> {
  let current = doc;
  const visited = new Set<string>();
  while (current && current.status === "merged" && current.mergedIntoId) {
    if (visited.has(current._id)) return null;
    visited.add(current._id);
    current = (await ctx.db.get(current.mergedIntoId as Id<T>)) as Doc<T> | null;
  }
  return current;
}

/** The surviving record of a merge chain; hidden records read as absent. */
export async function followMerges<T extends MergeableTable>(
  ctx: QueryCtx,
  table: T,
  doc: Doc<T> | null,
): Promise<Doc<T> | null> {
  const survivor = await mergeSurvivor(ctx, table, doc);
  return survivor && survivor.status === "active" ? survivor : null;
}

/** `followMerges` from a stored ID: the active survivor, or null. */
export async function getActive<T extends MergeableTable>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  return await followMerges(ctx, table, await ctx.db.get(id));
}

/**
 * The active survivor of a stored record (by ID or as read), for writes:
 * throws `notFound` ("{label} not found.") when it is unknown or hidden.
 */
export async function requireActive<T extends MergeableTable>(
  ctx: QueryCtx,
  table: T,
  stored: Id<T> | Doc<T> | null,
  label: string,
): Promise<Doc<T>> {
  const doc = typeof stored === "string" ? await ctx.db.get(stored) : stored;
  const active = await followMerges(ctx, table, doc);
  if (!active) {
    throw new ConvexError({ code: "notFound", message: `${label} not found.` });
  }
  return active;
}
