// Pure text matching for search (ticket #38 follow-up): deciding whether a
// search-index hit really contains what was typed, which prefixes to probe
// the index with for typo help, and ranking near-miss titles ("berzerk" →
// Berserk). The Convex search index only prefix-matches the last term and
// has no fuzzy mode, so catalog.ts gathers a small candidate set through
// `probePrefixes` and this module does the forgiving part in memory.
// Publishers are matched by name here too (`matchNames`), over the small list,
// by the same word-prefix rule as titles.

import { publisherNameKey } from "./publishers";

/** Shortest query (letters and digits, spaces dropped) that gets typo help. */
export const NEAR_MISS_MIN_LENGTH = 4;

/**
 * Lower-cased, accent-free words of a text, split on anything that is not a
 * letter or digit: "Pokémon: Red & Blue" → ["pokemon", "red", "blue"]. Only
 * Latin accents are dropped; kana keep their voicing marks.
 */
export function searchWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words of a text run together, so spacing typos compare equal. */
function compact(text: string): string {
  return searchWords(text).join("");
}

/**
 * True when every query word starts some word of `text`. The search index
 * returns documents matching any one term, so "one peice" finds every "One …"
 * title; this separates the hits that contain the whole query from those
 * that only share a word.
 */
export function matchesAllWords(query: string, text: string): boolean {
  const queryWords = searchWords(query);
  if (queryWords.length === 0) return false;
  const words = searchWords(text);
  return queryWords.every((q) => words.some((w) => w.startsWith(q)));
}

/**
 * Order search hits the way a reader expects: a title (or alt title) that
 * is exactly the query first, then titles that begin with it — shortest
 * first, so "berserk" puts Berserk ahead of Berserk of Gluttony — then the
 * rest in the order given (the index's relevance). The index alone ranks
 * "Attack on Titan Anthology" above Attack on Titan.
 */
export function sortByTitleMatch<
  T extends { title: string; altTitles: ReadonlyArray<string> },
>(query: string, items: ReadonlyArray<T>): T[] {
  const q = compact(query);
  const keyed = items.map((item, index) => {
    let rank = 2;
    let length = 0;
    for (const name of [item.title, ...item.altTitles]) {
      const c = compact(name);
      const nameRank = c === q ? 0 : c.startsWith(q) ? 1 : 2;
      if (nameRank < rank || (nameRank === rank && nameRank < 2 && c.length < length)) {
        rank = nameRank;
        length = c.length;
      }
    }
    return { item, rank, length: rank < 2 ? length : 0, index };
  });
  return keyed
    .sort((a, b) => a.rank - b.rank || a.length - b.length || a.index - b.index)
    .map(({ item }) => item);
}

export type NameMatch<T> = {
  item: T;
  /**
   * The query opens the name ("seven seas", "kodansha"), so it names this
   * item rather than sharing a word deeper in it ("seas", "manga").
   */
  opens: boolean;
};

/**
 * The items whose name holds every query word as the start of one of its
 * words — the rule Series titles follow (`matchesAllWords`) — compared as
 * publisher-name keys (case, accents, punctuation, and "&"/"and" folded).
 * "seas", "seven seas", and "Seven Seas Entertainment" all find Seven Seas
 * Entertainment; "one" finds One Peace Books but not ComicsOne. An exact
 * name leads, then names the query opens, then the rest, each A–Z. The one
 * Publisher matcher behind both search and suggestions.
 */
export function matchNames<T extends { name: string }>(
  query: string,
  items: ReadonlyArray<T>,
): Array<NameMatch<T>> {
  const q = publisherNameKey(query);
  if (q === "") return [];
  const queryWords = q.split(" ");
  return items
    .flatMap((item) => {
      const key = publisherNameKey(item.name);
      const words = key.split(" ");
      if (!queryWords.every((qw) => words.some((w) => w.startsWith(qw)))) return [];
      return [{ item, rank: key === q ? 0 : key.startsWith(q) ? 1 : 2 }];
    })
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
    .map(({ item, rank }) => ({ item, opens: rank < 2 }));
}

/**
 * Prefixes to probe the search index with when looking for near misses: the
 * first 3 and 4 letters of the two longest query words. A typo past the
 * fourth letter still lands the right title in a probe ("berzerk" → "ber",
 * "chainsawman" → "chai"); one in the first three letters of a one-word
 * query is out of reach. At most four probes, and none for a query too
 * short for typo help (`NEAR_MISS_MIN_LENGTH`).
 */
export function probePrefixes(query: string): string[] {
  if (compact(query).length < NEAR_MISS_MIN_LENGTH) return [];
  const words = searchWords(query)
    .filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  return [...new Set(words.flatMap((w) => [w.slice(0, 3), w.slice(0, 4)]))];
}

/** Edits a query of this many letters may be from a title and still count. */
export function allowedEdits(length: number): number {
  return Math.max(1, Math.floor(length / 4));
}

/**
 * Optimal-string-alignment distance: insertions, deletions, substitutions,
 * and swaps of adjacent letters ("peice" → "piece") each cost one. Stops
 * early and returns `max + 1` once the distance must exceed `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Three rolling rows: the swap rule looks two rows back.
  let before = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, before[j - 2]! + 1);
      }
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * How far a compacted query is from one name: the whole name, or else the
 * name's opening (within a letter of the query's length, so "berzerk" finds
 * "Berserk of Gluttony"). An opening match scores half an edit worse than a
 * whole-name match at the same distance. Null when too far off.
 */
function nameScore(query: string, name: string, max: number): number | null {
  const full = editDistance(query, name, max);
  if (full <= max) return full;
  let opening = max + 1;
  for (const length of [query.length - 1, query.length, query.length + 1]) {
    if (length < name.length) {
      opening = Math.min(opening, editDistance(query, name.slice(0, length), max));
    }
  }
  return opening <= max ? opening + 0.5 : null;
}

export type NearMiss<T> = {
  item: T;
  /** The title or alt title that came closest to the query. */
  matched: string;
  score: number;
};

/**
 * The candidates whose title or an alt title is within `allowedEdits` of
 * the query, spaces and punctuation ignored ("one peice" ~ "One Piece",
 * "chainsawman" ~ "Chainsaw Man"), closest first, then shortest title.
 * Returns nothing for queries under `NEAR_MISS_MIN_LENGTH` letters.
 */
export function rankNearMisses<
  T extends { title: string; altTitles: ReadonlyArray<string> },
>(query: string, candidates: ReadonlyArray<T>, limit: number): Array<NearMiss<T>> {
  const q = compact(query);
  if (q.length < NEAR_MISS_MIN_LENGTH) return [];
  const max = allowedEdits(q.length);
  const misses: Array<NearMiss<T>> = [];
  for (const item of candidates) {
    let best: NearMiss<T> | null = null;
    for (const name of [item.title, ...item.altTitles]) {
      const score = nameScore(q, compact(name), max);
      if (score !== null && (best === null || score < best.score)) {
        best = { item, matched: name, score };
      }
    }
    if (best) misses.push(best);
  }
  return misses
    .sort((a, b) => a.score - b.score || a.item.title.length - b.item.title.length)
    .slice(0, limit);
}
