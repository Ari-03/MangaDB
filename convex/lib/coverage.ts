// Coverage inference for packaging books ("Berserk Deluxe Volume 1",
// "One Piece 3-in-1 Edition Vol. 5") whose title never states which Volumes
// they collect. Without a coverage such a book stays on its observation for
// an Editor (lib/catalogTitle.ts), so the Deluxe/Omnibus reading paths that
// readers come here for never appear. Two further signals fill the gap:
//
//   1. The publisher's own blurb. PRH flap copy and keynotes say "collecting
//      volumes 1–3" or "Collects Berserk Volumes 40, 41"; Yen Press and Seven
//      Seas page text does the same.
//   2. A line name that declares its size: "3-in-1" and VIZBIG (always three
//      volumes) at position p cover volumes 3p-2 … 3p.
//
// Plain "Omnibus" / "Deluxe" with no stated size and no blurb range stays
// unknown: guessing a size would map books onto the wrong Volumes. So does a
// title or blurb that lists Volumes with a gap ("Volumes 1 and 3 in one
// book!"): the line size never fills in the Volume it skips.

import { canonicalLabel, parseVolumeList, type CoverRange, type Packaging } from "./bookTitle";

/** Largest sensible volume number in a coverage statement. */
const MAX_VOLUME = 500;

const VOL = String.raw`vol(?:ume)?s?\.?`;
const NUM = String.raw`\d{1,3}`;
const DASH = String.raw`\s*(?:[-–—]|to|through|thru)\s*`;
// Up to six words between the verb and "volumes": "collects Berserk volumes 1–3",
// "collecting the first three New York Times bestselling volumes" is not matched.
const LEAD = String.raw`(?:collect(?:s|ing|ed)?|contain(?:s|ing)?|includ(?:es|ing)|compil(?:es|ing)|gather(?:s|ing))\s+(?:the\s+)?(?:(?:original\s+)?[\w'’:!?,.-]+\s+){0,6}?`;

// One listed item: "5", "#5", "1-3", "volume 3" (as in "volume 1 and volume 3").
const ITEM = String.raw`(?:${VOL}\s*)?#?${NUM}(?:${DASH}#?${NUM})?`;
// Between items: "1, 2", "1 and 3", "1 & 3", "40, 41, and 42".
const SEP = String.raw`(?:\s*,\s*(?:(?:\band\b|&)\s*)?|\s*(?:\band\b|&)\s*)`;
// A later item must end the list or lead on to a function word. In "volumes
// 1–3 and 4 bonus stories" or "1-3, and 16 pages of art" the number counts
// something else (and "16" is never read as "1", nor "4-6 new" as "4"); a
// possessive ("and volume 4's bonus chapter") names only part of a Volume.
// Unknown words end the list before the item, so a miss can drop a listed
// Volume but never invent one.
const FOLLOWS = String.raw`(?:of|in|into|and|or|plus|with|from|together|for|as|at|on|by|to|are|is|was|were|now|all|alongside|along|including|which|that|but|so|while|the|a|an)`;
const LISTED = String.raw`(?![\d’']|\s*[-–—]\s*#?\d|\s+(?!${FOLLOWS}\b)[a-z])`;
const LIST = `${ITEM}(?:${SEP}${ITEM}${LISTED})*`;

// "Collects volumes 1–3", "Collects volumes 40, 41, and the Guidebook",
// "Collects volumes 1-2 and 4" (gapped, so no range).
const STATED = new RegExp(`${LEAD}${VOL}\\s*(${LIST})`, "i");
// A bare "Volumes 1–3" or "Volumes 1 and 3" anywhere: weaker, so it comes last.
// Global: an unusable range ("Volumes 1-80 of the saga") must not hide a later list.
const BARE = new RegExp(
  `\\b${VOL}\\s*(${ITEM}(?:${SEP}${ITEM}${LISTED})+|#?${NUM}${DASH}#?${NUM})\\b`,
  "gi",
);

// "Collects volumes one and three": number words after "volume(s)" read as digits.
const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];
const WORD = `(?:${NUMBER_WORDS.join("|")})`;
const WORD_ITEM = `${WORD}(?:${DASH}${WORD})?`;
const WORD_LIST = new RegExp(
  `\\b${VOL}\\s*${WORD_ITEM}(?:${SEP}(?:${VOL}\\s*)?${WORD_ITEM}\\b${LISTED})*\\b`,
  "gi",
);
const WORD_NUMBER = new RegExp(`\\b${WORD}\\b`, "gi");

function range(from: number, to: number): CoverRange | null {
  if (!(from >= 1 && to >= from && to <= MAX_VOLUME && to - from < 50)) return null;
  return { from: canonicalLabel(String(from)), to: canonicalLabel(String(to)) };
}

/**
 * Strip markup and entities so patterns see plain prose, read "plus" before a
 * number as a list separator, and read number words in a Volume list as
 * digits ("volumes one and three" → "volumes 1 and 3").
 */
function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&rsquo;|&#8217;|&#0*39;|&apos;/g, "’")
    .replace(/&(?:amp;)+|&#0*38;|&#x0*26;/gi, "&")
    .replace(/\s+/g, " ")
    // "volumes 1 + 3", "volumes 1-3 plus 4": another listed item.
    .replace(new RegExp(`\\s*(?:\\+|\\bplus)\\s+(?=(?:${VOL}\\s*)?#?\\d)`, "gi"), " & ")
    .replace(WORD_LIST, (list) =>
      list.replace(WORD_NUMBER, (word) => String(NUMBER_WORDS.indexOf(word.toLowerCase()) + 1)),
    );
}

/** The range a captured list holds: null when it skips a Volume or is impossible. */
function listRange(list: string): CoverRange | null {
  const listed = parseVolumeList(list);
  if (listed === null) {
    // A single Volume: "collects volume 5".
    const only = Number(/\d+/.exec(list)![0]);
    return range(only, only);
  }
  const { coverRange } = listed;
  return coverRange ? range(Number(coverRange.from), Number(coverRange.to)) : null;
}

/**
 * What a blurb says the book collects: null when it says nothing, else the
 * stated range, whose `coverRange` is null when the statement is one no
 * range can hold — a list with a gap ("collects volumes 1 and 3", never
 * 1–3) or an impossible range ("volumes 9-3"). That null is evidence, not
 * silence: inferCoverage lets nothing weaker stand in for it.
 */
function statedCoverage(text: string | undefined): { coverRange: CoverRange | null } | null {
  if (!text) return null;
  const prose = plain(text);
  const stated = STATED.exec(prose);
  if (stated) return { coverRange: listRange(stated[1]!) };
  // A bare statement is weak: a usable range counts, and so does a gapped
  // list ("Volumes 1 and 3 in one book!"), but an unusable range
  // ("Volumes 1-80 of the saga") says nothing about this book, so the next
  // bare statement is read instead.
  for (const [, list] of prose.matchAll(BARE)) {
    const found = listRange(list!);
    if (found) return { coverRange: found };
    if (parseVolumeList(list!)?.coverRange === null) return { coverRange: null };
  }
  return null;
}

/** The Volumes a blurb says the book collects, when it states a usable range. */
export function coverageFromText(text: string | undefined): CoverRange | null {
  return statedCoverage(text)?.coverRange ?? null;
}

/**
 * Volumes per book when the line NAME guarantees it, per the 2026-09-27
 * publisher survey (docs/research): every book of these lines collects the
 * same count. Names whose size varies by series — "Deluxe" (1–3 across
 * publishers), "Collector's Edition" (1.3–3), "Perfect Edition", plain
 * "Omnibus" (2 or 3), kanzenban recuts like "Fullmetal Edition" — return
 * null and wait for a blurb or a Moderator.
 */
const FIXED_LINE_SIZES: Array<[RegExp, number]> = [
  [/\bvizbig\b/i, 3], // VIZ: "collects the material from three standard volumes"
  [/\bcolossal\s+edition\b/i, 5], // Kodansha, Attack on Titan
  [/\bmaster['’]s\s+edition\b/i, 5], // Kodansha, Fairy Tail (Vertical's "Master Edition" varies)
  [/\bgrimoire\s+edition\b/i, 3], // Kodansha, Witch Hat Atelier
  [/\bblack\s+edition\b/i, 2], // VIZ, Death Note
  [/\blegendary\s+edition\b/i, 2], // VIZ, The Legend of Zelda
  [/\bdefinitive\s+(?:hardcover\s+)?(?:edition|collection)\b/i, 3], // VIZ Vagabond, Kodansha AoT
];

export function declaredLineSize(lineName: string | null): number | null {
  if (lineName === null) return null;
  const nIn1 = /\b(\d)-in-1\b/i.exec(lineName);
  if (nIn1) return Number(nIn1[1]);
  for (const [pattern, size] of FIXED_LINE_SIZES) {
    if (pattern.test(lineName)) return size;
  }
  return null;
}

/** "3-in-1 Edition" at position 5 → volumes 13–15; null without a declared size or an integer position. */
export function coverageFromLine(
  lineName: string | null,
  linePosition: string | null,
): CoverRange | null {
  const size = declaredLineSize(lineName);
  if (size === null || linePosition === null || !/^\d{1,3}$/.test(linePosition)) return null;
  const position = Number(linePosition);
  return range(size * (position - 1) + 1, size * position);
}

/**
 * The coverage to place a packaged book by: the title's own statement,
 * else the first blurb that states one, else the line's declared size.
 * `texts` are the source's blurbs in order of trust (PRH: flap copy,
 * positioning, keynote). A statement no range can hold (a gapped list, in
 * the title or the deciding blurb) is null: weaker signals never override it.
 */
export function inferCoverage(
  packaging: Packaging,
  texts: Array<string | undefined>,
): CoverRange | null {
  if (packaging.coverRange || packaging.coverageGapped) return packaging.coverRange;
  for (const text of texts) {
    const stated = statedCoverage(text);
    if (stated) return stated.coverRange;
  }
  return coverageFromLine(packaging.lineName, packaging.linePosition);
}
