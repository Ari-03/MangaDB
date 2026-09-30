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
// A blurb's statement has one of three outcomes, and nothing here guesses
// past it:
//
//   - a contiguous range ("collects volumes 1–3"): the book's coverage;
//   - evidence no range can hold: a gap ("Collects volumes 1 and 3"), or a
//     statement that reads more than one way ("volumes 1–3 and 4 bonus
//     stories": 1–4 or 1–3) when the line size agrees with none of its
//     readings. The book stays Unmapped Packaging, and no weaker signal
//     fills in a Volume;
//   - silence: the next blurb, then the line size, decides.
//
// What a list of Volumes says depends on what stands before it (reach()):
//
//   - a collect-verb that governs it, with nothing but a name between them
//     ("Collects Berserk Volumes 40, 41"): a statement about the book;
//   - no verb ("The story continues in volumes 4 and 5"), or a verb whose
//     phrase or sentence ends first: at an article or a preposition
//     ("Includes a preview of volumes 4 and 5"), at sentence punctuation,
//     or at a capital "Volumes" after ordinary words ("Collects the hit
//     series Volumes 4–6 on sale now", two blocks cleanBlurb joined with a
//     space): a mention, which names Volumes without saying the book holds
//     them. A gap in it still blocks, a reading that agrees with the line
//     size is the size's own, and anything else is silence;
//   - a verb with other words between ("Collects the hit series volumes
//     1–3", "Collects both volumes 1 and 2"): either of the two. Like a
//     mention it never places the book past the line size, but a size it
//     contradicts blocks rather than deciding.
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
// "1-3", "1–3", "1‑3" (non-breaking hyphen), "1−3" (minus), "1 through 3".
const DASH = String.raw`\s*(?:[-‐‑−–—]|to|through|thru)\s*`;
const VERB = String.raw`\b(?:collect(?:s|ing|ed)?|contain(?:s|ing)?|includ(?:es|ing)|compil(?:es|ing)|gather(?:s|ing))`;
// Up to seven words between the verb and "volumes": reach() reads them.
const LEAD_IN = String.raw`(?:[\p{L}\p{N}_'’:!?,.-]+\s+){0,7}?`;

// One listed item: "5", "#5", "1-3", "volume 3" (as in "volume 1 and volume 3").
const ITEM = String.raw`(?:${VOL}\s*)?#?${NUM}(?:${DASH}#?${NUM})?`;
// What joins the next item: "1 and 3", "1 & 3", "1 + 3", "1-3 plus 4",
// "1 as well as 3", "1 along with 3".
const CONJ = String.raw`(?:\band\b|&|\+|\bplus\b|\bas\s+well\s+as\b|\balong\s+with\b)`;
// Between items: a conjunction, or "," ";" "/" with or without one ("40,
// 41, and 42"). "/" and ";" join only weakly: see readings().
const SEP = String.raw`\s*(?:[,;/]\s*(?:${CONJ}\s*)?|${CONJ}\s*)`;
const LIST = `${ITEM}(?:${SEP}${ITEM})*`;
const WEAK_JOIN = /[/;]/;

// Hard statement ends: sentence punctuation before a capital, unless it
// closes an abbreviation ("Dr. Stone"), and a block-level tag in raw HTML
// ("<li>Collects volumes 1, 2, and 3</li><li>Hardcover</li>"; a <br> is
// only a line break: "volumes 1, 2<br>and 3" lists three). BREAK stands in
// for both; no list, separator, or lead-in word matches it. Sources hand
// over blurbs through cleanBlurb (lib/text.ts), which has already turned
// every tag into a space, so a block boundary reaches here as a space:
// reach() is what keeps "Collects bonus art</p><p>The story continues in
// volumes 4 and 5" from reading as one statement.
const BREAK = "¶";
const BLOCK_TAG = /<\/?(?:p|li|div|ul|ol|h[1-6]|blockquote|tr|td|th)\b[^>]*>/gi;
const SENTENCE_END = /(?:(?<!\b(?:Dr|Mr|Mrs|Ms|St|No|Vols?))\.|[!?])(?=\s+["'“‘]?[A-Z])/g;

// A collect-verb and the list after it: "Collects volumes 1–3", "Collects
// Negima! Volumes 1–3". A sentence end the lead-in crosses is `crossed`.
const STATED = new RegExp(
  `(?<verb>${VERB})\\s+(?<lead>${LEAD_IN})(?<crossed>(?<=[!?] )${BREAK} )?` +
    `(?<marker>vol(?:ume)?)(?<plural>s)?\\.?\\s*(?<list>${LIST})`,
  "giu",
);
// Every "Volumes 1–3" or "Volumes 1 and 3", with a verb before it or not.
const BARE = new RegExp(`\\bvol(?:ume)?(?<plural>s)?\\.?\\s*(?<list>${LIST})`, "gi");

// A name: words that start with a capital or a digit, joined by short
// lowercase words ("Mob Psycho 100", "Dr. Stone", "Attack on Titan").
const NAME = /^[\p{Lu}\p{N}]\S*(?:\s+(?:\p{Ll}{1,3}\s+)*[\p{Lu}\p{N}]\S*)*$/u;
// An article or a preposition opens a phrase of its own; a list right
// after one is that phrase's ("a preview of volumes 4 and 5").
const OPENER = /\b(?:a|an|the|of|in|on|at|to|for|from|with|into|by)$/i;
// The numbers of each item in a matched list.
const SPAN = new RegExp(`(${NUM})(?:${DASH}#?(${NUM}))?`, "gi");

// What must follow a list's last item for it to be a Volume for certain: a
// statement end, or punctuation that closes a phrase ("40, 41, and the
// Guidebook"). A number that counts something else runs on into what it
// counts: "4 bonus stories", "4-page", "4 “bonus”", "4 (four!)", "3 remastered".
const END = new RegExp(String.raw`^(?:\s*(?:$|${BREAK}|[.!?,;:)\]—])|\s+[-–](?:\s|$))`);
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
  String.raw`\b${VOL}\s*${WORD_ITEM}(?:${SEP}(?:${VOL}\s*)?${WORD_ITEM}\b)*\b`,
  "gi",
);
const WORD_NUMBER = new RegExp(`\\b${WORD}\\b`, "gi");

/** A listed item's reach: "5" is 5–5, "1-3" is 1–3. */
type Span = { from: number; to: number };

/**
 * What one statement says: one reading, or several when it may say more
 * than its list holds. Non-null readings always differ. A null reading is
 * one no range can hold.
 */
type Readings = [CoverRange | null, ...Array<CoverRange | null>];

function range(from: number, to: number): CoverRange | null {
  const whole = Number.isInteger(from) && Number.isInteger(to);
  if (!(whole && from >= 1 && to >= from && to <= MAX_VOLUME && to - from < 50)) return null;
  return { from: canonicalLabel(String(from)), to: canonicalLabel(String(to)) };
}

/**
 * Strip markup and entities so patterns see plain prose, with BREAK at every
 * statement end, and read number words in a Volume list as digits
 * ("volumes one and three" → "volumes 1 and 3").
 */
function plain(text: string): string {
  return decodeEntities(text.replace(BLOCK_TAG, ` ${BREAK} `).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(WORD_LIST, (list) =>
      list.replace(WORD_NUMBER, (word) => String(NUMBER_WORDS.indexOf(word.toLowerCase()) + 1)),
    )
    .replace(SENTENCE_END, `$& ${BREAK}`);
}

function spans(list: string): Span[] {
  return Array.from(list.matchAll(SPAN), ([, from, to]) => ({
    from: Number(from),
    to: Number(to ?? from),
  }));
}

/** A single number, not a range: "volume 5". */
function lone(list: Span[]): boolean {
  return list.length === 1 && list[0]!.from === list[0]!.to;
}

/** A later item that does not start where the one before it ended: "1 and 3", "1-2, 4". */
function gapped(list: Span[]): boolean {
  return list.some((span, i) => i > 0 && span.from !== list[i - 1]!.to + 1);
}

/** The range the items hold: null for a gap, a backwards item ("9-3"), or no book's size ("1-80"). */
function spanRange(list: Span[]): CoverRange | null {
  if (gapped(list) || list.some((span) => span.to < span.from)) return null;
  return range(list[0]!.from, list.at(-1)!.to);
}

/**
 * A matched list's readings, fullest first, given the prose after it. The
 * first item always stands: the marker ("volumes") names it a Volume. The
 * rest are certain only up to the first item joined on by "/" or ";"
 * ("1-3 / 4-6" may name two books), and the last only when a statement end
 * follows it ("4 bonus stories" counts something else). Past that point the
 * list also reads without them, unless that leaves one number under a
 * plural marker: "volumes" promises several.
 */
function readings(list: string, rest: string, plural: boolean): Readings {
  const items = spans(list);
  // "Volumes 1 through the finale": the rest of the list went unread.
  if (plural && lone(items)) return [null];
  const weak = list.search(WEAK_JOIN);
  const certain =
    weak >= 0 ? spans(list.slice(0, weak)).length : END.test(rest) ? items.length : items.length - 1;
  const kept = items.slice(0, Math.max(1, certain));
  const found: Readings = [spanRange(items)];
  if (kept.length < items.length && !(plural && lone(kept))) found.push(spanRange(kept));
  return found;
}

/**
 * Whether the rest of the sentence names, with its own marker, a Volume
 * outside the list ("volume 1 of Alpha and volume 2 of Beta"): then the
 * list may not be all the statement collects.
 */
function namesMore(list: string, rest: string): boolean {
  const items = spans(list);
  const named = Array.from(rest.split(BREAK)[0]!.matchAll(NAMED), ([, label]) => Number(label));
  return named.some((label) => label < items[0]!.from || label > items.at(-1)!.to);
}

/** How a collect-verb stands to the list after it, judged by the words between (see the header). */
type Reach = "governs" | "unsure" | "mentions";

function reach(verb: string, lead: string, marker: string, crossed: boolean): Reach {
  const words = lead.trim().replace(/^the\b\s*/i, "");
  if (words === "") return "governs";
  if (OPENER.test(words)) return "mentions";
  // Copy set in capitals marks nothing with them ("COLLECTS THE HIT SERIES").
  const cased = verb !== verb.toUpperCase();
  if (cased && NAME.test(words)) return "governs";
  // A sentence ended before the list ("Collects bonus art! Volumes 4 and 5
  // are out now"), or a capital "Volumes" after other words starts one
  // ("Collects the hit series</h3><p>Volumes 4-6 on sale now").
  return crossed || (cased && marker.startsWith("V")) ? "mentions" : "unsure";
}

/** The reading that agrees with the line's declared size, if one does. */
function agreeing(found: Readings, size: CoverRange | null): CoverRange | null {
  const agrees = (reading: CoverRange | null) => reading?.from === size?.from && reading?.to === size?.to;
  return size === null ? null : (found.find(agrees) ?? null);
}

/**
 * What one blurb says the book collects, given the line's declared size
 * (null without one): a range; null for a statement no range can hold,
 * which blocks every weaker signal; undefined for silence. The first
 * list a collect-verb governs decides; with none, a list only agrees with
 * the size or blocks: by a gap, or by contradicting the size when a verb
 * may state it.
 */
function blurbCoverage(text: string | undefined, size: CoverRange | null): CoverRange | null | undefined {
  if (!text) return undefined;
  const prose = plain(text);
  const statements = Array.from(prose.matchAll(STATED), (match) => {
    const { verb, lead, crossed, marker, plural, list } = match.groups!;
    return {
      reach: reach(verb!, lead!, marker!, crossed !== undefined),
      list: list!,
      plural: plural !== undefined,
      end: match.index + match[0].length,
    };
  });
  const governed = statements.find((statement) => statement.reach === "governs");
  if (governed) {
    const { list, plural, end } = governed;
    const rest = prose.slice(end);
    const found = readings(list, rest, plural);
    if (namesMore(list, rest)) found.unshift(null);
    return found.length === 1 ? found[0] : agreeing(found, size);
  }
  // No statement: each list is a mention, or unsure (known by where it ends).
  const unsure = new Set(statements.filter((statement) => statement.reach === "unsure").map(({ end }) => end));
  for (const bare of prose.matchAll(BARE)) {
    const { list, plural } = bare.groups!;
    const end = bare.index + bare[0].length;
    const items = spans(list!);
    // "Volume 5 continues the saga" says nothing about this book.
    if (lone(items)) continue;
    const agreed = agreeing(readings(list!, prose.slice(end), plural !== undefined), size);
    if (agreed) return agreed;
    if (gapped(items) || (size !== null && unsure.has(end))) return null;
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
 * else the first blurb that states one, else the line's declared size.
 * `texts` are the source's blurbs in order of trust (PRH: flap copy,
 * positioning, keynote). A statement no range can hold (a gapped list, in
 * the title or the deciding blurb) is null: weaker signals never override it.
 *
 * A blurb that reads more than one way is settled only by independent
 * evidence: the reading that agrees with the line's declared size at the
 * book's position places it (the title's own range, the other such
 * evidence, already decided above). With no size, or one that agrees with
 * none of them, the book stays unmapped. Its range readings all differ, so
 * at most one can agree. A list whose verb may not govern it is settled the
 * same way, except that with no size it is silence.
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
