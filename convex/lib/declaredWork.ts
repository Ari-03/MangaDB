import type { Doc, Id } from "../_generated/dataModel";

/** Current canonical declarations; spelling still uses the caller's strict work comparison. */
export function declaredWorkNames(series: Doc<"series">) {
  return [series.title, ...(series.altTitles ?? [])];
}

/**
 * Supplied only after the bounded held reader independently resolves the source
 * to this Series: an ANN or Kodansha parent, or an Open Library title resolution.
 * parentTitle is the ANN entry's title; other sources supply null.
 */
export type WorkContext = {
  seriesId: Id<"series">;
  names: readonly string[];
  parentTitle: string | null;
};
