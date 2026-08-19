// The matching ladder (ticket #35, spec §6), source-agnostic. Rung ① — the
// persisted source-id link on the observation — is the caller's fast path
// (a rename at the source is then a field conflict, never a failed match);
// this module resolves everything below it, strongest first:
//
//   ② ISBN-13 exact, with a title-similarity sanity check
//   ③ publisher + normalized series title + volume label + format —
//     auto ONLY with exactly one candidate and no override/lock
//   ④ title-only plausible candidates: always review
//   ⑤ no match: the creation path
//
// Ambiguity — two plausible candidates anywhere — always resolves to
// "review"; the importer never initiates a merge.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// ---------- pure text rules ----------

/**
 * Normalized series-title key for rungs ③/④: lowercased, publisher
 * discriminators like "(Manga)" stripped, punctuation collapsed. Equality
 * on this key is the "normalized series title" of the ladder.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Loose title-similarity sanity check for the ISBN rung (spec §6): at least
 * half of the shorter title's tokens must appear in the other.
 */
export function titlesSimilar(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return true;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.5;
}

/** Volume-label equality: exact after trimming, or numerically ("07" = "7"). */
export function labelsEqual(
  a: string | null | undefined,
  b: string | null,
): boolean {
  const left = a ?? null;
  if (left === null || b === null) return left === b;
  if (left.trim() === b.trim()) return true;
  const x = Number(left);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

// ---------- the ladder ----------

/** What a source offers for matching one release-shaped record. */
export type ReleaseFact = {
  seriesTitle: string;
  /** The single covered Volume's label; null = an unlabeled oneshot. */
  volumeLabel: string | null;
  /** Multi-volume coverage (omnibus ranges) skips rungs ③/④ — ISBN or bust. */
  multiVolume: boolean;
  format: "physical" | "digital";
  isbn13?: string;
  publisherId: Id<"publishers"> | null;
};

export type MatchOutcome =
  | { kind: "match"; rung: 2 | 3; release: Doc<"releases"> }
  | { kind: "review"; rung: 2 | 3 | 4; reason: string }
  | { kind: "create"; rung: 5 };

/** Active Series whose title (or an alt title) normalizes to the fact's. */
async function candidateSeries(
  ctx: QueryCtx | MutationCtx,
  seriesTitle: string,
): Promise<Doc<"series">[]> {
  const wanted = normalizeTitle(seriesTitle);
  if (wanted === "") return [];
  const hits = await ctx.db
    .query("series")
    .withSearchIndex("search_title", (q) => q.search("searchText", seriesTitle))
    .take(20);
  return hits.filter(
    (series) =>
      series.status === "active" &&
      (normalizeTitle(series.title) === wanted ||
        series.altTitles.some((alt) => normalizeTitle(alt) === wanted)),
  );
}

/**
 * Resolve one release fact against the canonical catalog, rungs ② → ⑤.
 * Rung ③ requires the full key — publisher, normalized title, volume label,
 * format — and an edition covering exactly that one volume; near-misses on
 * publisher/format/coverage become rung ④ title-only candidates.
 */
export async function matchRelease(
  ctx: QueryCtx | MutationCtx,
  fact: ReleaseFact,
): Promise<MatchOutcome> {
  // Rung ②: ISBN-13 exact with the title sanity check. A failed check flags
  // for review — an ISBN pointing at a dissimilar title is exactly the
  // situation a human must untangle, never an importer.
  if (fact.isbn13 !== undefined) {
    const byIsbn = await ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", fact.isbn13))
      .first();
    if (byIsbn && byIsbn.status === "active") {
      const seriesTitles: string[] = [];
      for (const seriesId of byIsbn.seriesIds) {
        const series = await ctx.db.get(seriesId);
        if (series) seriesTitles.push(series.title);
      }
      if (seriesTitles.some((title) => titlesSimilar(title, fact.seriesTitle))) {
        return { kind: "match", rung: 2, release: byIsbn };
      }
      return {
        kind: "review",
        rung: 2,
        reason: `ISBN ${fact.isbn13} matches an existing release with a dissimilar title`,
      };
    }
  }

  if (fact.multiVolume) return { kind: "create", rung: 5 };

  // Rungs ③/④: walk title-matching Series → label-matching Volumes → their
  // covering Editions → Releases, splitting strict full-key hits from
  // loose title-only candidates.
  const strict = new Map<string, Doc<"releases">>();
  const loose = new Map<string, Doc<"releases">>();
  for (const series of await candidateSeries(ctx, fact.seriesTitle)) {
    const volumes = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    for (const volume of volumes) {
      if (volume.status !== "active") continue;
      if (!labelsEqual(volume.label, fact.volumeLabel)) continue;
      const coverages = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
        .collect();
      for (const coverage of coverages) {
        const edition = await ctx.db.get(coverage.editionId);
        if (!edition || edition.status !== "active") continue;
        const editionCoverage = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect();
        const coversOnlyThisVolume = editionCoverage.length === 1;
        const releases = await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect();
        for (const release of releases) {
          if (release.status !== "active") continue;
          const fullKey =
            coversOnlyThisVolume &&
            fact.publisherId !== null &&
            edition.publisherId === fact.publisherId &&
            release.format === fact.format;
          (fullKey ? strict : loose).set(release._id, release);
        }
      }
    }
  }

  const strictHits = [...strict.values()];
  if (strictHits.length === 1) {
    const candidate = strictHits[0]!;
    // Auto only with no override/lock (spec §6): a record humans have
    // touched that way gets a human look before any link.
    if (candidate.locked || (candidate.overriddenFields?.length ?? 0) > 0) {
      return {
        kind: "review",
        rung: 3,
        reason:
          "the single publisher+title+label+format candidate carries a Human Override or lock",
      };
    }
    return { kind: "match", rung: 3, release: candidate };
  }
  if (strictHits.length > 1) {
    return {
      kind: "review",
      rung: 3,
      reason: `${strictHits.length} plausible candidates match publisher+title+label+format`,
    };
  }
  if (loose.size > 0) {
    return {
      kind: "review",
      rung: 4,
      reason: `title-only match: ${loose.size} plausible candidate${loose.size === 1 ? "" : "s"} under a same-titled series`,
    };
  }
  return { kind: "create", rung: 5 };
}
