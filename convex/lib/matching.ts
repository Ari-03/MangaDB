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
//
// Repairs stand: a merged Series or Release answers as its survivor, an
// ISBN on a hidden Release reviews instead of creating, and hidden Series
// are reported separately (hiddenSeriesTitled) so creation can refuse them.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isNovelTitle } from "./bookTitle";
import { decodeEntities } from "./text";

// ---------- pure text rules ----------

// Appended to a novel's key: no title text can produce it (punctuation
// folds to spaces), so a prose novel never keys equal to its manga.
const NOVEL_KEY = " #novel";

/** Entities decoded, accents and apostrophes folded, "&" read as "and", lowercased. */
function foldTitle(title: string): string {
  return decodeEntities(title)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/&/g, " and ");
}

/**
 * Normalized series-title key for rungs ③/④ and every by-title Series
 * lookup: entities decoded, accents/apostrophes folded, "&" ≡ "and", a
 * leading "The" dropped, bracketed discriminators like "(Manga)" stripped,
 * punctuation collapsed. A novel marker ("(Light Novel)", ": The Novel")
 * stays in the key, so a novel never matches its manga. Equality on this
 * key is the "normalized series title" of the ladder.
 */
export function normalizeTitle(title: string): string {
  const key = foldTitle(title)
    .replace(/[([][^()[\]]*[)\]]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
  return isNovelTitle(title) ? `${key}${NOVEL_KEY}` : key;
}

/**
 * Loose title-similarity sanity check for the ISBN rung (spec §6): at least
 * half of the shorter title's tokens must appear in the other, on the same
 * folding as normalizeTitle. A novel is never similar to a manga.
 */
export function titlesSimilar(a: string, b: string): boolean {
  if (isNovelTitle(a) !== isNovelTitle(b)) return false;
  const tokens = (s: string) =>
    new Set(
      foldTitle(s)
        .replace(/[([][^()[\]]*[)\]]/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && w !== "the"),
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

// Full-text hits scanned per query. Generous on purpose: relevance ranking
// can bury the one real Series under many near-namesakes ("Otherside Picnic
// 01…16 (Manga)" shards), and a Series with no Releases yet (an ANN
// backbone entry) must still be found.
const SEARCH_SCAN = 100;

// Merge chains are short (a repair merges into a survivor, rarely twice);
// the bound only guards against a corrupt cycle.
const MAX_MERGE_HOPS = 8;

/**
 * A canonical row followed through `mergedIntoId` to the row that absorbed
 * it: the row itself when not merged, null when the chain dead-ends. How
 * importers respect a repair's merges instead of recreating the loser.
 */
export async function survivorOf<T extends "series" | "volumes" | "releases">(
  ctx: QueryCtx | MutationCtx,
  doc: Doc<T> | null,
): Promise<Doc<T> | null> {
  let current = doc;
  for (let hops = 0; current !== null && current.status === "merged"; hops++) {
    if (current.mergedIntoId === undefined || hops >= MAX_MERGE_HOPS) return null;
    current = await ctx.db.get(current.mergedIntoId);
  }
  return current;
}

/**
 * Every Series whose title normalizes to the given one, merged rows
 * answered by their survivor, split by what they mean to an importer:
 * `active` (attach here) and `hidden` (an Editor removed this work — never
 * recreate it). Active alt-title matches count only when no primary title
 * matches (ANN lists sequels and spinoffs — "Citrus Plus", "Dragon Ball Z"
 * — as alt titles). Searched under both the raw and the folded spelling, so "Candy &
 * Cigarettes" finds "CANDY AND CIGARETTES".
 */
async function seriesByTitle(
  ctx: QueryCtx | MutationCtx,
  seriesTitle: string,
): Promise<{ active: Doc<"series">[]; hidden: Doc<"series">[] }> {
  const wanted = normalizeTitle(seriesTitle);
  if (wanted === "") return { active: [], hidden: [] };
  const queries = new Set([decodeEntities(seriesTitle), wanted.replace(NOVEL_KEY, "")]);
  const seen = new Map<Id<"series">, Doc<"series">>();
  for (const text of queries) {
    const hits = await ctx.db
      .query("series")
      .withSearchIndex("search_title", (q) => q.search("searchText", text))
      .take(SEARCH_SCAN);
    for (const hit of hits) seen.set(hit._id, hit);
  }
  const all = [...seen.values()];
  const resolve = async (hits: Doc<"series">[]) => {
    const active = new Map<Id<"series">, Doc<"series">>();
    const hidden = new Map<Id<"series">, Doc<"series">>();
    for (const hit of hits) {
      const series = await survivorOf<"series">(ctx, hit);
      if (series?.status === "active") active.set(series._id, series);
      else if (series?.status === "hidden") hidden.set(series._id, series);
    }
    return { active: [...active.values()], hidden: [...hidden.values()] };
  };
  const primary = await resolve(
    all.filter((series) => normalizeTitle(series.title) === wanted),
  );
  const alt = await resolve(
    all.filter((series) => series.altTitles.some((title) => normalizeTitle(title) === wanted)),
  );
  // A hidden namesake never shadows an active Series that carries the
  // title as an alt title; and hidden Series count by primary title only —
  // an alt title (a pinyin or romanized name) is too loose to refuse a
  // creation on.
  return {
    active: primary.active.length > 0 ? primary.active : alt.active,
    hidden: primary.hidden,
  };
}

/**
 * Active Series whose title normalizes to the given one (seriesByTitle): a
 * merged Series' title finds the Series it was merged into. Exported for
 * every by-title series resolution.
 */
export async function candidateSeries(
  ctx: QueryCtx | MutationCtx,
  seriesTitle: string,
): Promise<Doc<"series">[]> {
  return (await seriesByTitle(ctx, seriesTitle)).active;
}

/**
 * Hidden Series whose title normalizes to the given one — works an Editor
 * removed from the catalog. The creation path consults this before making
 * a brand-new Series, so a sync never resurrects a hidden work.
 */
export async function hiddenSeriesTitled(
  ctx: QueryCtx | MutationCtx,
  seriesTitle: string,
): Promise<Doc<"series">[]> {
  return (await seriesByTitle(ctx, seriesTitle)).hidden;
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
    const withIsbn = await ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", fact.isbn13))
      .collect();
    // A merged Release answers as its survivor; a hidden one is an Editor's
    // decision about this very book — a human looks before anything is
    // created for it again.
    const resolved = await Promise.all(
      withIsbn.map((release) => survivorOf<"releases">(ctx, release)),
    );
    const byIsbn = resolved.find((release) => release?.status === "active") ?? null;
    if (byIsbn === null && resolved.some((release) => release?.status === "hidden")) {
      return {
        kind: "review",
        rung: 2,
        reason: `ISBN ${fact.isbn13} belongs to a Release an Editor hid`,
      };
    }
    if (byIsbn) {
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
  // loose title-only candidates. A candidate that matches the full key
  // except Format is a SIBLING, not ambiguity: Releases of one Edition
  // differ exactly in Format/Binding (spec §2), so a publisher's digital
  // counterpart of an existing print volume is the creation path, never a
  // review — the creation helper attaches it to the sibling's Edition.
  const strict = new Map<string, Doc<"releases">>();
  const siblings = new Map<string, Doc<"releases">>();
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
          // A different ISBN-13 is a different Release by definition
          // (CONTEXT.md): never this record, and not ambiguity either.
          if (
            fact.isbn13 !== undefined &&
            release.isbn13 !== undefined &&
            release.isbn13 !== fact.isbn13
          ) {
            continue;
          }
          const sameEdition =
            coversOnlyThisVolume &&
            fact.publisherId !== null &&
            edition.publisherId === fact.publisherId;
          const bucket = !sameEdition
            ? loose
            : release.format === fact.format
              ? strict
              : siblings;
          bucket.set(release._id, release);
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
  // Only format-siblings (or nothing) found: create the new Release.
  return { kind: "create", rung: 5 };
}
