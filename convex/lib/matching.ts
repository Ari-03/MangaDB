// The matching ladder (ticket #35, spec §6), source-agnostic. Rung ① — the
// persisted source-id link on the observation — is the caller's fast path
// (a rename at the source is then a field conflict, never a failed match);
// this module resolves everything below it, strongest first:
//
//   ② ISBN-13 exact, with a title-similarity sanity check
//   ③ publisher + normalized series title + volume label + format, onto an
//     ordinary whole-Volume Edition, Binding and language not contradicting —
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
import { factualOverrides } from "./moderationFields";
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

/** Letters and digits only, one space between words. */
const words = (text: string) =>
  text.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Normalized series-title key for rungs ③/④ and every by-title Series
 * lookup: entities decoded, accents/apostrophes folded, "&" ≡ "and", a
 * leading "The" dropped, trailing bracketed discriminators like "(Manga)"
 * stripped, punctuation collapsed. Brackets inside a title are part of it:
 * "Rent-A-(Really Shy!)-Girlfriend" is the spinoff, not "Rent-A-Girlfriend".
 * Square brackets that are the whole title ("[Oshi No Ko]", "[Oshi No Ko]
 * (Manga)") keep their words: stripping them would leave an empty key that
 * matches nothing, so every import created a new Series. A novel marker
 * ("(Light Novel)", ": The Novel") stays in the key, so a novel never
 * matches its manga. Equality on this key is the "normalized series title"
 * of the ladder.
 */
export function normalizeTitle(title: string): string {
  const folded = foldTitle(title);
  const key = (
    words(folded.replace(/(\s*[([][^()[\]]*[)\]])+\s*$/, " ")) ||
    words(folded.replace(/(\s*\([^()]*\))+\s*$/, " ")) ||
    words(folded)
  ).replace(/^the /, "");
  return isNovelTitle(title) ? `${key}${NOVEL_KEY}` : key;
}

/**
 * The Series among several sharing a normalized key whose title matches
 * with its punctuation kept, when exactly one does: "Bastard" is the
 * WEBTOON and "Bastard!!" is Hagiwara's work, though both key to
 * "bastard". Otherwise all of them, for the caller's ambiguity handling.
 */
function exactTitleAmong(title: string, series: Doc<"series">[]): Doc<"series">[] {
  if (series.length < 2) return series;
  const strict = (text: string) => foldTitle(text).replace(/\s+/g, " ").trim();
  const exact = series.filter((doc) => strict(doc.title) === strict(title));
  return exact.length === 1 ? exact : series;
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
export function labelsEqual(a: string | null | undefined, b: string | null): boolean {
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
  /** Physical Binding ("Paperback", "hardcover"); case-insensitive, unknown when absent. */
  binding?: string;
  /** Language code ("en"); unknown when absent. */
  language?: string;
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
  const primary = await resolve(all.filter((series) => normalizeTitle(series.title) === wanted));
  const alt = await resolve(
    all.filter((series) => series.altTitles.some((title) => normalizeTitle(title) === wanted)),
  );
  // A hidden namesake never shadows an active Series that carries the
  // title as an alt title; and hidden Series count by primary title only —
  // an alt title (a pinyin or romanized name) is too loose to refuse a
  // creation on.
  return {
    active:
      primary.active.length > 0 ? exactTitleAmong(seriesTitle, primary.active) : alt.active,
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

/** What a source knows about a work beyond its title (ANN's staff and books). */
export type WorkEvidence = {
  books: Array<{ isbn13: string; format: "physical" | "digital" }>;
  annPersonIds: string[];
};

// Bound on the Series walk below; a long Series answers well before it.
const EVIDENCE_VOLUMES = 150;

/**
 * Whether a title-matched Series is the work the evidence describes. A
 * title alone links Doubt to Doubt!!, E'S to ES, and Citrus to Citrus+ (an
 * alt title); once linked, the source builds its Volumes and credits there.
 *   "same"      — one of the work's ISBNs is already a Release of the Series
 *   "different" — both sides know their creators (ANN person ids) and share
 *                 none, or both hold ISBNs in a common format and share none
 *                 (a spinoff shares its author, so only the books tell it)
 *   "unknown"   — not enough on one side to tell; the title decides
 */
export async function workMatch(
  ctx: QueryCtx | MutationCtx,
  seriesId: Id<"series">,
  evidence: WorkEvidence,
): Promise<"same" | "different" | "unknown"> {
  const isbns = new Set(evidence.books.map((book) => book.isbn13));
  for (const isbn13 of isbns) {
    const releases = await ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .collect();
    if (releases.some((r) => r.status === "active" && r.seriesIds.includes(seriesId))) {
      return "same";
    }
  }

  if (evidence.annPersonIds.length > 0) {
    const credits = await ctx.db
      .query("seriesCredits")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect();
    const known = new Set<string>();
    for (const credit of credits) {
      // ANN's own credits only: a publisher row names its person by name
      // alone, which may have matched an ANN namesake (people.ts).
      if (credit.source !== undefined) continue;
      const person = await ctx.db.get(credit.personId);
      if (person?.annId !== undefined) known.add(person.annId);
    }
    // A shared creator proves nothing (a spinoff shares its author), but
    // wholly different creators are different works.
    if (known.size > 0 && !evidence.annPersonIds.some((id) => known.has(id))) {
      return "different";
    }
  }

  // No shared ISBN (checked above): any Release of the Series with an ISBN
  // in a format the evidence also lists is a book of another work.
  const formats = new Set(evidence.books.map((book) => book.format));
  if (formats.size === 0) return "unknown";
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .take(EVIDENCE_VOLUMES);
  const seen = new Set<Id<"editions">>();
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    const coverage = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const row of coverage) {
      if (seen.has(row.editionId)) continue;
      seen.add(row.editionId);
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", row.editionId))
        .collect();
      if (releases.some((r) => r.status === "active" && r.isbn13 && formats.has(r.format))) {
        return "different";
      }
    }
  }
  return "unknown";
}

/**
 * Whether an Edition is an ordinary book of one whole Volume: its only
 * Volume Coverage row is complete and it belongs to no Edition Line. A
 * single-volume record keyed by label (rung ③, ANN's label and page
 * fallbacks) may link only onto such an Edition; a split part, an omnibus,
 * or a line's packaging of the same Volume is another book.
 */
export async function isWholeSingleVolume(
  ctx: QueryCtx | MutationCtx,
  edition: Doc<"editions">,
): Promise<boolean> {
  if (edition.editionLineId !== undefined) return false;
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
    .take(2);
  return coverage.length === 1 && coverage[0]!.extent === "complete";
}

/** Two known values that differ, compared case-insensitively ("Paperback" = "paperback"). */
function contradicts(known: string | undefined, offered: string | undefined): boolean {
  return (
    known !== undefined &&
    offered !== undefined &&
    known.trim().toLowerCase() !== offered.trim().toLowerCase()
  );
}

/**
 * Resolve one release fact against the canonical catalog, rungs ② → ⑤.
 * Rung ③ requires the full key — publisher, normalized title, volume label,
 * format — onto an ordinary whole-Volume Edition (isWholeSingleVolume);
 * near-misses on publisher/coverage/packaging become rung ④ title-only
 * candidates, and a same-Edition Release of another Format or Binding is a
 * sibling (the creation path).
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
    // Multiple historical rows can resolve to the same survivor. Distinct
    // active survivors sharing an ISBN are ambiguous, regardless of title.
    const active = new Map<Id<"releases">, Doc<"releases">>();
    for (const release of resolved) {
      if (release?.status === "active") active.set(release._id, release);
    }
    if (active.size > 1) {
      return {
        kind: "review",
        rung: 2,
        reason: `ISBN ${fact.isbn13} matches ${active.size} distinct active Releases`,
      };
    }
    const byIsbn = active.values().next().value ?? null;
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
  // except Format or a known Binding is a SIBLING, not ambiguity: Releases
  // of one Edition differ exactly in Format/Binding (spec §2), so a
  // publisher's digital counterpart or hardcover of an existing paperback
  // volume is the creation path, never a review — the creation helper
  // attaches it to the sibling's Edition.
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
        const wholeVolume = await isWholeSingleVolume(ctx, edition);
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
          // So is another language (a Release is one language).
          if (contradicts(release.language, fact.language)) continue;
          const sameEdition =
            wholeVolume && fact.publisherId !== null && edition.publisherId === fact.publisherId;
          const sameRelease =
            release.format === fact.format && !contradicts(release.binding, fact.binding);
          const bucket = !sameEdition ? loose : sameRelease ? strict : siblings;
          bucket.set(release._id, release);
        }
      }
    }
  }

  const strictHits = [...strict.values()];
  if (strictHits.length === 1) {
    const candidate = strictHits[0]!;
    // Auto only with no lock or factual override (spec §6): a record humans
    // have touched that way gets a human look before any link. An edited
    // blurb is not such a touch.
    if (
      candidate.locked ||
      factualOverrides("release", candidate.overriddenFields ?? []).length > 0
    ) {
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
  // Only Format/Binding siblings (or nothing) found: create the new Release.
  return { kind: "create", rung: 5 };
}
