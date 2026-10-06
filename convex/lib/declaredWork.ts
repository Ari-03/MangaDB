import type { Doc, Id } from "../_generated/dataModel";

/** Current canonical declarations; spelling still uses the caller's strict work comparison. */
export function declaredWorkNames(series: Doc<"series">) {
  return [series.title, ...(series.altTitles ?? [])];
}

/** Supplied only after the bounded held reader verifies the independent ANN parent. */
export type AnnWorkContext = {
  seriesId: Id<"series">;
  names: readonly string[];
  parentTitle: string | null;
};
