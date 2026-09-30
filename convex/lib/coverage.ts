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
// Each list of Volumes in a blurb is one of two things:
//
//   - a statement about the book. The collect-verb nearest the list in its
//     sentence governs it ("Includes an afterword and collects volumes
//     1–3"), unless an article or preposition opens the list's own phrase
//     ("Includes a preview of volumes 4 and 5"). The first list a verb
//     governs decides. With none, on a line with no declared size, the first
//     list that opens its sentence ("Volumes 10–12 of the acclaimed series")
//     decides. Its range places the book, and a size it contradicts leaves
//     the book Unmapped Packaging: the size never overrides it;
//   - a mention ("The story continues in volumes 4 and 5"). A reading that
//     agrees with the line size is the size's own and a gap blocks; anything
//     else is silence, so the next blurb, then the size, decides.
//
// A list reads two ways when its last item is a bare number after "and",
// "&", or a comma with more copy after it ("volumes 1–3 and 4 bonus
// stories": 1–4 or 1–3), unless that number closes a serial list ("1, 2,
// and 3 together"), and when items follow a "/" or ";" ("1–3 / 4–6" may name
// two books). A range never reads two ways, whatever follows it ("volumes
// 1–3 plus 16 pages of art", "1–3 plus 4–6 in one book"), and neither does a
// last item with its own marker ("1–3 and volume 4 in one book") unless a
// possessive follows it ("and volume 4's bonus chapter"). Only the line size
// settles two readings.
// Otherwise the statement is evidence no range can hold, as a gap or a range
// that runs on ("1-2-3") is: the book stays Unmapped, never on a shortened
// range and never on a guess.
//
// Plain "Omnibus" / "Deluxe" with no stated size and no blurb range stays
// unknown too: guessing a size would map books onto the wrong Volumes.

import { canonicalLabel, type CoverRange, type Packaging } from "./bookTitle";
import { decodeEntities } from "./text";

/** Largest sensible volume number in a coverage statement. */
const MAX_VOLUME = 500;

const VOL = String.raw`vol(?:ume)?s?\.?`;
// A Volume number, read whole: "16" is never "1", nor "4.5" "4".
const NUM = String.raw`\d{1,3}(?:\.\d+)?(?!\.?\d)`;
// "1-3", "1–3", "1‑3" (non-breaking hyphen), "1‒3" (figure dash), "1−3"
// (minus), "1~3", "1 through 3".
const DASH_MARK = "[-‐‑‒–—−~]";
const DASH = String.raw`\s*(?:${DASH_MARK}|to|through|thru)\s*`;
const VERB = /\b(?:collect(?:s|ing|ed)?|contain(?:s|ing)?|includ(?:es|ing)|compil(?:es|ing)|gather(?:s|ing))\b/gi;

// An item with its own marker: "#5", "volume 3" (as in "volume 1 and volume
// 3"), "vols. 4-6".
const MARKED_ITEM = String.raw`(?:${VOL}\s*|#)#?${NUM}(?:${DASH}#?${NUM})?`;
// One listed item: a marked one, "5", or "1-3".
const ITEM = String.raw`(?:${MARKED_ITEM}|${NUM}(?:${DASH}#?${NUM})?)`;
// A joined item read whatever follows it: one with its own marker ("plus
// volume 4 in one book") or a range ("plus 4-6 in one book").
const JOINED = String.raw`(?:${MARKED_ITEM}|${NUM}${DASH}#?${NUM})`;
// Between items: "," "and" "&" ("40, 41, and 42"), or "/" ";", which join
// only weakly (readings()).
const SEP = String.raw`\s*(?:[,;/]\s*(?:(?:\band\b|&)\s*)?|(?:\band\b|&)\s*)`;
// A statement end, or punctuation that closes a phrase ("40, 41, and the
// Guidebook").
const END = String.raw`(?:\s*(?:$|[.!?,;:)\]—])|\s+[-–](?:\s|$))`;
// "1-3 plus 4-6", "1 + vol. 3", "1 as well as 3": one more item. A range or
// an item with its own marker is always read; a bare number only when a
// statement end follows it (in "1-3 plus 16 pages" it counts something
// else). Every joined item is read: "1-3 plus 4-6 plus 7-9".
const ALSO = String.raw`\s*,?\s*(?:\+|\bplus\b|\bas\s+well\s+as\b|\balong\s+with\b)\s*`;
const LIST = `${ITEM}(?:${SEP}${ITEM}|${ALSO}(?:${ITEM}(?=${END})|${JOINED}))*`;
// Every "Volumes 1–3" or "Volume 1 and 3".
const LISTED = new RegExp(`\\bvol(?:ume)?(?<plural>s)?\\.?\\s*(?<list>${LIST})`, "gi");

// "." "!" or "?" before a capital ends a sentence, unless the "." closes an
// abbreviation ("Dr. Stone"), or the "!" or "?" is a name's own and its
// Volumes follow ("Collects Negima! Volumes 37-38", "Haikyu!! VOLUMES"). A
// name is a capitalized word inside a sentence: "Collects bonus art!
// Volumes 4 and 5 are out now" and "Wow! Volumes 1-3 in one book" still
// split. A "." after a name is an ordinary sentence end ("from Oda. Volumes
// 4-6 on sale now"), so "Bakuman. Volumes 1-3" splits too.
const SENTENCE_END =
  /(?<=(?<!\b(?:Dr|Mr|Mrs|Ms|St|No|Vols?))\.|[!?])(?!(?<=[^\s.!?]\s+["'“‘]?[A-Z]\S*[!?])\s+["'“‘]?(?:Vol(?:umes?|s)?|VOL(?:UMES?|S)?)\b)\s+(?=["'“‘]?[A-Z])/;
// An article or preposition that opens the list's own phrase: the verb then
// collects the phrase's head ("a preview of volumes 4 and 5"), not the list.
const OPENER = /\b(?:a|an|the|of|in|on|at|to|for|from|with|into|by)$/i;

// The numbers of each item in a matched list.
const SPAN = new RegExp(`(${NUM})(?:${DASH}#?(${NUM}))?`, "gi");
const ENDS = new RegExp(`^${END}`);
// "1-2-3": the list runs on past what was read.
const RUN_ON = new RegExp(String.raw`^\s*${DASH_MARK}\s*#?\d`);
// The join before each middle item of a serial list: a bare comma ("1, 2, and 3").
const COMMA = new RegExp(String.raw`^\s*,\s*(?:${VOL}\s*)?#?$`, "i");
const WEAK_JOIN = /[/;]/;
// The join before an item that carries its own marker: "and volume 4", "& #4".
const MARKED = new RegExp(String.raw`(?:\b${VOL}|#)\s*#?$`, "i");
// "volume 4's bonus chapter": the item names what the Volume holds.
const POSSESSIVE = /^['’]s\b/;
// A Volume the sentence names past the list with its own marker.
const NAMED = new RegExp(String.raw`\b${VOL}\s*#?(\d{1,3})`, "gi");

// "Collects volumes one and three": number words in a Volume list read as digits.
const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];
const WORD = `(?:${NUMBER_WORDS.join("|")})`;
const WORD_ITEM = String.raw`(?:${WORD}|\d{1,3})(?:${DASH}(?:${WORD}|\d{1,3}))?`;
const WORD_LIST = new RegExp(
  String.raw`\b${VOL}\s*${WORD_ITEM}(?:(?:${SEP}|${ALSO})(?:${VOL}\s*)?${WORD_ITEM}\b)*\b`,
  "gi",
);
const WORD_NUMBER = new RegExp(`\\b${WORD}\\b`, "gi");

/** A listed item ("5" is 5–5, "1-3" is 1–3) and the text that joins it to the one before. */
type Item = { from: number; to: number; single: boolean; join: string };

/**
 * What one list says: one reading, or more when it may say more than its
 * certain items. A null reading is one no range can hold.
 */
type Readings = [CoverRange | null, ...Array<CoverRange | null>];

/**
 * A list in a blurb: a statement a collect-verb governs, a list that opens
 * its sentence (a statement only on a line with no size), or a mention.
 * `broken` when no range holds it as written: a gap, or a list left unread.
 */
type Listed = { kind: "stated" | "opening" | "mention"; found: Readings; broken: boolean };

function range(from: number, to: number): CoverRange | null {
  const whole = Number.isInteger(from) && Number.isInteger(to);
  if (!(whole && from >= 1 && to >= from && to <= MAX_VOLUME && to - from < 50)) return null;
  return { from: canonicalLabel(String(from)), to: canonicalLabel(String(to)) };
}

/**
 * Strip markup and entities so patterns see plain prose, and read number
 * words in a Volume list as digits ("volumes one and three" → "volumes 1
 * and 3").
 */
function plain(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(WORD_LIST, (list) =>
      list.replace(WORD_NUMBER, (word) => String(NUMBER_WORDS.indexOf(word.toLowerCase()) + 1)),
    );
}

function items(list: string): Item[] {
  let read = 0;
  return Array.from(list.matchAll(SPAN), (match) => {
    const [text, from, to] = match;
    const join = list.slice(read, match.index);
    read = match.index + text.length;
    return { from: Number(from), to: Number(to ?? from), single: to === undefined, join };
  });
}

/** One number alone: "volume 5". */
function lone(part: Item[]): boolean {
  return part.length === 1 && part[0]!.single;
}

/** A later item that does not start where the one before it ended: "1 and 3", "1-2, 4". */
function gapped(part: Item[]): boolean {
  return part.some((item, i) => i > 0 && item.from !== part[i - 1]!.to + 1);
}

/** The range the items hold: null for a gap, a backwards item ("9-3"), or no book's size ("1-80"). */
function spanRange(part: Item[]): CoverRange | null {
  if (gapped(part) || part.some((item) => item.to < item.from)) return null;
  return range(part[0]!.from, part.at(-1)!.to);
}

/**
 * A list's readings, fullest first, given the rest of its sentence (see the
 * header). The first item always stands: the marker names it a Volume, and
 * so does a later item's own marker ("and volume 4"), so only a bare last
 * number, or one a possessive follows ("and volume 4's bonus chapter"), may
 * count something else. One number under a plural marker ("volumes 1
 * through the finale") is a list left unread, which no range holds.
 */
function readings(all: Item[], rest: string, plural: boolean): Readings {
  const read = (part: Item[]) => (plural && lone(part) ? null : spanRange(part));
  const weak = all.findIndex((item) => WEAK_JOIN.test(item.join));
  const serial = all.length > 2 && all.slice(1, -1).every((item) => COMMA.test(item.join));
  const last = all.at(-1)!;
  const bare = last.single && (!MARKED.test(last.join) || POSSESSIVE.test(rest));
  const countsMore = all.length > 1 && bare && !serial && !ENDS.test(rest);
  const certain = weak > 0 ? weak : countsMore ? all.length - 1 : all.length;
  return certain < all.length ? [read(all), read(all.slice(0, certain))] : [read(all)];
}

/**
 * Whether the rest of the sentence names, with its own marker, a Volume
 * outside the list ("volume 1 of Alpha and volume 2 of Beta"): then the
 * list may not be all the statement collects. One named inside a phrase of
 * its own ("plus a preview of volume 4") is a mention.
 */
function namesMore(all: Item[], rest: string): boolean {
  return Array.from(rest.matchAll(NAMED)).some((named) => {
    const label = Number(named[1]);
    const outside = label < all[0]!.from || label > all.at(-1)!.to;
    return outside && !OPENER.test(rest.slice(0, named.index).trimEnd());
  });
}

/** How a list stands to the book, judged by its sentence up to the list (see the header). */
function standing(before: string): Listed["kind"] {
  const verb = Array.from(before.matchAll(VERB)).at(-1);
  if (!verb) return /^[^\p{L}\p{N}]*$/u.test(before) ? "opening" : "mention";
  const lead = before.slice(verb.index + verb[0].length).trim().replace(/^the\b\s*/i, "");
  return OPENER.test(lead) ? "mention" : "stated";
}

/** Every list in one sentence. */
function listsIn(sentence: string): Listed[] {
  return Array.from(sentence.matchAll(LISTED)).flatMap((match): Listed[] => {
    const { plural, list } = match.groups!;
    const all = items(list!);
    const kind = standing(sentence.slice(0, match.index));
    const rest = sentence.slice(match.index + match[0].length);
    // "Volume 5 continues the saga" says nothing about this book.
    if (kind !== "stated" && !plural && lone(all)) return [];
    const runOn = RUN_ON.test(rest);
    const found: Readings = runOn ? [null] : readings(all, rest, plural !== undefined);
    if (kind !== "mention" && namesMore(all, rest)) found.unshift(null);
    return [{ kind, found, broken: runOn || gapped(all) || (plural !== undefined && lone(all)) }];
  });
}

/** The reading that agrees with the line's declared size, if one does. */
function agreeing(found: Readings, size: CoverRange | null): CoverRange | null {
  const agrees = (reading: CoverRange | null) => reading?.from === size?.from && reading?.to === size?.to;
  return size === null ? null : (found.find(agrees) ?? null);
}

/**
 * What one blurb says the book collects, given the line's declared size
 * (null without one): a range; null for evidence no range can hold, which
 * blocks every weaker signal; undefined for silence (see the header).
 */
function blurbCoverage(text: string | undefined, size: CoverRange | null): CoverRange | null | undefined {
  if (!text) return undefined;
  const lists = plain(text).split(SENTENCE_END).flatMap(listsIn);
  const statement =
    lists.find(({ kind }) => kind === "stated") ??
    (size === null ? lists.find(({ kind }) => kind === "opening") : undefined);
  if (statement) {
    const { found } = statement;
    if (size !== null) return agreeing(found, size);
    return found.length === 1 ? found[0] : null;
  }
  for (const { found, broken } of lists) {
    const agreed = agreeing(found, size);
    if (agreed) return agreed;
    if (broken) return null;
  }
  return undefined;
}

/** The Volumes a blurb says the book collects, read with no line size to settle it. */
export function coverageFromText(text: string | undefined): CoverRange | null {
  return blurbCoverage(text, null) ?? null;
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
 * else the first blurb that says anything, else the line's declared size.
 * `texts` are the source's blurbs in order of trust (PRH: flap copy,
 * positioning, keynote). Evidence no range can hold is null, and weaker
 * signals never override it: a gapped list in the title or the deciding
 * blurb, a statement the size contradicts, or two readings the size does
 * not settle. The title's own range needs no settling: it decides first.
 */
export function inferCoverage(
  packaging: Packaging,
  texts: Array<string | undefined>,
): CoverRange | null {
  if (packaging.coverRange || packaging.coverageGapped) return packaging.coverRange;
  const size = coverageFromLine(packaging.lineName, packaging.linePosition);
  for (const text of texts) {
    const found = blurbCoverage(text, size);
    if (found !== undefined) return found;
  }
  return size;
}
