// The shared release-title parser (spec §2/§6): one book title from any
// source — PRH, Kodansha, Seven Seas, OpenLibrary — split into the Series it
// belongs to and what the book is within it. Every importer resolves Series
// through this module so that a publisher's per-book styling never becomes a
// Series of its own:
//
//   "Otherside Picnic 05 (Manga)"                → Otherside Picnic · Vol 5
//   "Alpi the Soul Sender Vol.5"                 → Alpi the Soul Sender · Vol 5
//   "Lone Wolf and Cub Volume 7: Cloud Dragon…"  → Lone Wolf and Cub · Vol 7 + subtitle
//   "Noragami Omnibus 7 (Vol. 19-21)"            → Noragami · Omnibus 7 covering 19–21
//   "Monster Musume: Deluxe Edition 1 (Vol. 1-3 Hardcover Omnibus)"
//                                                → Monster Musume · Deluxe Edition 1 covering 1–3
//   "Fire Force Manga Box Set 1 (Vol. 1-6)"      → Fire Force · box set covering 1–6
//   "Foo (Light Novel) Vol. 5"                   → Foo · Vol 5, isNovel
//
// Packaging (omnibus, deluxe, collector's, box sets…) is never a Volume: when
// `packaging` is set, `volumeLabel` is always null and the covered Volumes
// live only in `packaging.coverRange`. Pure and dependency-light so the
// repair migration and the unit tests use exactly what the importers use.

import { v, type Infer } from "convex/values";
import { coverageFromText } from "./coverage";
import { decodeEntities } from "./text";

// ---------- the parsed shape ----------

export const coverRangeValidator = v.object({
  from: v.string(),
  to: v.string(),
});

/** How a packaged book maps onto its base Series (stored on observations). */
export const packagingValidator = v.object({
  /** Edition Line name ("Omnibus", "Deluxe Edition", "Box Set"); null for a bare range. */
  lineName: v.union(v.string(), v.null()),
  /** Edition Line Position label ("7", "IV", "Season 3 Part 2"). */
  linePosition: v.union(v.string(), v.null()),
  /**
   * The source Volumes the book collects, inclusive; null when the title
   * never says, or says it in a way no range holds (`coverageGapped`).
   */
  coverRange: v.union(coverRangeValidator, v.null()),
  /**
   * The title states its coverage, but no range holds it: a list with a gap
   * ("Vol. 1 & 3"), a statement that reads two ways, or two statements that
   * disagree ("Vol. 1-9 (Collects Vols. 1-3)"). Neither a blurb nor the
   * line's declared size may stand in for it (lib/coverage.ts inferCoverage).
   */
  coverageGapped: v.optional(v.literal(true)),
});

export type CoverRange = Infer<typeof coverRangeValidator>;
export type Packaging = Infer<typeof packagingValidator>;

export type ParsedBookTitle = {
  /** The base Series title — never carries volume, format, or packaging text. */
  seriesTitle: string;
  /** The single covered Volume's label; null for oneshots and all packaging. */
  volumeLabel: string | null;
  /** Per-volume subtitle ("Cloud Dragon, Wind Tiger"); display-only. */
  volumeSubtitle: string | null;
  /** Omnibus / deluxe / box-set / multi-volume shape; null for a plain book. */
  packaging: Packaging | null;
  /** A box set or slipcase: a Release Bundle, never a Release. */
  isBox: boolean;
  /** A prose or light novel: out of the manga catalog's scope. */
  isNovel: boolean;
  /** Peeled format/binding/edition tags, verbatim ("Manga", "Paperback"). */
  formatTags: string[];
  /**
   * The label came from an unmarked trailing number ("Negima! 19"). Callers
   * with catalog access double-check it: "Omega 6" is a whole title.
   */
  bareNumber: boolean;
  /** The bare number was a roman numeral: split only onto an existing base Series. */
  bareRoman: boolean;
  /**
   * The split an unlicensed trailing number would have made ("Tower Dungeon
   * 7" with no seriesNumber and no tag): offered, not taken. Callers with
   * catalog access accept it only when an existing base Series claims it
   * (lib/catalogTitle.ts); a new work keeps its whole name ("Omega 6").
   */
  bareSplit: { seriesTitle: string; volumeLabel: string } | null;
};

export type ParseOptions = {
  /**
   * The source's own volume number for the book (PRH `seriesNumber`). It
   * never supplies a label on its own; it only licenses splitting an
   * unmarked trailing number that equals it ("Negima! 19" with 19).
   */
  seriesNumber?: number | string | null;
  /** A subtitle field carried separately by the source (OpenLibrary). */
  subtitle?: string | null;
};

// ---------- number grammar ----------

const WORD_NUMBERS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];
const WORD_NUMBER = `(?:${WORD_NUMBERS.join("|")})`;
const ROMAN = "(?:X{0,3}(?:IX|IV|V?I{1,3}|V)|X{1,3})";
const NUM = "\\d+(?:\\.\\d+)?";
/** One volume designation: 5, 7.5, G1, Five, IV. */
/** An extra numbered off a volume: "18+1", "9+1". Unnumbered as a label. */
const PLUS_EXTRA = `${NUM}\\+\\d+`;
const PLUS_EXTRA_RE = new RegExp(`^${PLUS_EXTRA}$`);
const LABEL = `(?:${PLUS_EXTRA}|${NUM}|[A-Z]\\d{1,2}|${WORD_NUMBER}|${ROMAN})`;
/** Between listed numbers: "1-3", "1 & 2", "1, 2, 3", "1, 2, and 4". */
const JOIN = "\\s*(?:,\\s*(?:and|&)|-|–|—|&|,|and)\\s*";
/**
 * A list or range of numbers: "1-3", "1 & 2", "1, 2, and 4", "10-11+EX".
 * Right after a "Vol." or "#" marker a listed item may repeat it: "1 and
 * Vol. 3", "#1 & #3", "1 + Vol. 3". After "Part" or "Book" it may not: in
 * "Alpha, Part 1, Vol. 2" the "Vol." starts the designation, Volume 2.
 */
const RANGE = `(?:(?<=(?:\\bvol(?:ume)?s?\\.?|#)\\s*)#?${NUM}(?:(?:${JOIN}|\\s*\\+(?=\\s*(?:vol|#))\\s*)(?:vol(?:ume)?s?\\.?\\s*)?#?${NUM})+|${NUM}(?:${JOIN}${NUM})+)(?:\\s*\\+\\s*\\w+)?`;

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10 };

function romanToNumber(text: string): number | null {
  if (!new RegExp(`^${ROMAN}$`).test(text)) return null;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const value = ROMAN_VALUES[text[i]!]!;
    const next = ROMAN_VALUES[text[i + 1] ?? ""] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

/**
 * The canonical spelling of a volume label: numbers lose zero-padding and
 * trailing zeros ("05" → "5", "7.50" → "7.5", "0" stays), number words and
 * roman numerals become digits; anything else ("G1", "Side Story") is kept.
 */
export function canonicalLabel(label: string): string {
  const text = label.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return String(Number(text));
  const word = WORD_NUMBERS.indexOf(text.toLowerCase());
  if (word >= 0) return String(word + 1);
  const roman = romanToNumber(text);
  return roman !== null ? String(roman) : text;
}

/**
 * A designation naming several Volumes ("1-3", "1 & 2", "1, 2, 3", "1-3,
 * 4-6"): the range it spans, or a null `coverRange` when its list skips a
 * Volume ("1 & 3", "1-3, 5") or ends in a numbered extra ("1-2 + 3"). A
 * from–to range over a gap would claim the Volumes the book leaves out, and
 * a range is all Coverage can hold, so a gapped list stays multi-volume
 * with its coverage unknown. A lone number is no list: null.
 */
export function parseVolumeList(text: string): { coverRange: CoverRange | null } | null {
  // "10-11+EX": the extra after "+" is not a numbered Volume. A numbered
  // extra ("1-2 + 3") may be the next Volume or a bonus book, so no range
  // holds it. "+" joins another Volume only with its marker ("1 + Vol. 3").
  const extra = /\s*\+\s*(?!vol|#)(\w+)$/i.exec(text);
  const spans = (extra ? text.slice(0, extra.index) : text)
    .split(/\s*(?:&|,|\band\b|\+)\s*/i)
    .map((item) => item.match(/\d+(?:\.\d+)?/g) ?? [])
    .filter((span) => span.length > 0);
  const numbers = spans.flat();
  if (numbers.length < 2) return null;
  const contiguous =
    !/^\d/.test(extra?.[1] ?? "") &&
    spans.every((span, i) => i === 0 || Number(span[0]) === Number(spans[i - 1]!.at(-1)) + 1);
  return {
    coverRange: contiguous
      ? { from: canonicalLabel(numbers[0]!), to: canonicalLabel(numbers.at(-1)!) }
      : null,
  };
}

// ---------- tag vocabularies ----------

/** "(Manga)", "[Paperback]", "(The Comic / Manhua)", "(Second Edition)". */
const FORMAT_TAG =
  /^(?:(?:the\s+)?(?:bl\s+|yaoi\s+|yuri\s+)?(?:manga|comics?|manhua|manhwa|webtoon|graphic novel)(?:\s*\/\s*(?:manga|comics?|manhua|manhwa|webtoon))?|(?:mature\s+)?(?:hardcover|paperback|trade paperback)|(?:(?:second|2nd|third|3rd|special|revised|new|english)\s+edition)(?:\s+re-?release)?|re-?release|reprint|full[- ]colou?r)$/i;

/** A novel marker inside a bracket group: "(Light Novel)", "(Deluxe Hardcover Novel)". */
const NOVEL_TAG = /\bnovels?\b/i;
const GRAPHIC_NOVEL = /\bgraphic\s+novels?\b/i;

/** Packaging vocabulary inside a bracket group: "(Omnibus)", "(3-in-1 Edition)". */
const PACKAGING_TAG =
  /\b(?:omnibus|\d-in-1|deluxe|collector['’]?s|box(?:ed)?\s+set|slipcase|vizbig|big\s+edition|anniversary|perfect\s+edition|master['’]?s?\s+edition|colossal|eternal\s+edition)\b|\b(?:collection|edition)$/i;

const BOX = /\bbox(?:ed)?\s+set\b|\bslipcase\b/i;

/**
 * Trailing packaging phrases — each an Edition Line name. "Complete" alone
 * only counts with a position after it ("Ajin: Demi-Human Complete 3") so
 * "The Complete Aranzi Hour"-style names stay whole; "Edition" alone never
 * counts ("IruMafia Edition" is a real spinoff).
 */
const PACKAGING_PHRASE = [
  "(?:limited\\s+edition\\s+|complete\\s+)?omnibus(?:\\s+(?:edition|collection))?",
  "\\d-in-1(?:\\s+(?:deluxe\\s+)?edition)?",
  "all-in-one(?:\\s+edition)?",
  // Publisher-specific premium lines (VIZ, Kodansha, Yen, Dark Horse, Seven Seas).
  "black\\s+edition",
  "fullmetal\\s+edition",
  "grimoire\\s+edition",
  "legendary\\s+edition",
  "definitive(?:\\s+hardcover)?\\s+(?:edition|collection)",
  "ultimate\\s+edition",
  "library\\s+edition",
  "full\\s+colou?r\\s+(?:edition|collection)",
  "premium\\s+collection",
  "naoko\\s+takeuchi\\s+collection",
  "fully\\s+compiled",
  "(?:complete\\s+)?collector['’]?s\\s+(?:edition|box\\s+set)",
  "deluxe(?:\\s+edition)?(?:\\s+hardcover)?(?:\\s+collection)?",
  "(?:the\\s+)?complete(?:\\s+manga)?\\s+(?:collection|series\\s+box\\s+set)",
  "(?:the\\s+)?classic(?:\\s+manga)?\\s+collection",
  "(?:\\d+(?:st|nd|rd|th)\\s+)?anniversary\\s+edition",
  "perfect\\s+edition",
  "master['’]?s?\\s+edition",
  "colossal\\s+edition",
  "eternal\\s+edition",
  "vizbig(?:\\s+edition)?",
  "big\\s+edition",
  "box(?:ed)?\\s+set",
  "slipcase\\s+set",
].join("|");

const SEASON_PREFIX =
  "(?:(?:the\\s+)?(?:final\\s+)?season(?:\\s+(?!part\\b)\\w+)?(?:\\s+part\\s+\\w+)?\\s+)";
const POSITION = `(?:${NUM}|${ROMAN}|${WORD_NUMBER})`;

const TRAILING_PACKAGING = new RegExp(
  `^(.*?)(?:\\s*[:,]\\s*|\\s+[-–—]\\s+|\\s+)(${SEASON_PREFIX}?(?:the\\s+)?(?:complete\\s+)?(?:manga\\s+|mature\\s+)?(?:${PACKAGING_PHRASE}))(?:\\s*(?:vols?\\.?|volumes?|book|#)?\\s*(${RANGE}|${POSITION}))?$`,
  "i",
);

const TRAILING_COMPLETE = new RegExp(
  `^(.*?)(?:\\s*[:,]\\s*|\\s+[-–—]\\s+|\\s+)(complete)\\s+(${POSITION})$`,
  "i",
);

/** Words before "Book" that make it a book kind, not a volume marker. */
const BOOK_KINDS =
  "Picture|Art|Coloring|Colouring|Sketch|Fan|Guide|Activity|Sticker|Story|Note|Comic|Face|Year|Cook|Hand|Text|Photo|Data|Official";

const MARKER = `(?:Vol(?:ume)?s?\\.?|Volumen|Part|(?<!\\b(?:${BOOK_KINDS})\\s)Book|#)`;

/**
 * "Series, Vol. 5: Subtitle" — the first marker whose tail parses. An
 * unseparated tail ("Vol. 10 Another End") counts as a subtitle only when it
 * holds no further marker, so "Rayearth Part 2 Vol. 1" splits at "Vol. 1".
 */
const VOLUME_MARKER = new RegExp(
  `^(.*?\\S)(?:\\s*[,:;]\\s*|\\s+[-–—]\\s+|\\s+)${MARKER}\\s*(${RANGE}|${LABEL})(?:\\s*(?::|\\s[-–—])\\s*(.+?)|\\s+((?!.*\\b(?:vols?|volumes?|book|part)\\b)[\\[A-Z].*))?$`,
  "i",
);

/** A bracket group that is only a volume note: "(Vol. 13)", "(Kase-san and... Book 3)". */
const BRACKET_MARKER = new RegExp(`(?:^|\\s)${MARKER}\\s*(${LABEL})$`, "i");

/** "Otherside Picnic 05", "Buddha 3: Devadatta", "Astro Boy 1 & 2". */
const BARE_NUMBER = new RegExp(
  `^(.*?[^\\s#,])(?:\\s*,)?\\s+(\\d{1,3}(?:\\.\\d+)?(?:\\s*(?:-|–|&)\\s*\\d{1,3})?)(?:\\s*:\\s*(.+)|\\s+\\(([^()]+)\\))?$`,
);

/**
 * "BARBARITIES II": an unmarked trailing roman numeral, upper-case only and
 * never after a conjunction ("You and I"). Like BARE_NUMBER the split is
 * provisional (`bareNumber`): the catalog decides, and only an existing base
 * Series may claim it (lib/catalogTitle.ts), so "Kingdom Hearts II" stays whole.
 */
const BARE_ROMAN = new RegExp(`^(.*?[A-Za-z!?.)][^\\s]*)\\s+(${ROMAN})$`);
const CONJUNCTION_BEFORE = /(?:^|\s)(?:and|&|or|vs\.?|with|the|a)$/i;

// ---------- peeling ----------

/**
 * What one place in a title says the book collects: undefined when it says
 * nothing, a range, or null for coverage it states but no range holds (a
 * gapped list, a statement that reads two ways). The same three states as a
 * blurb's reading (lib/coverage.ts blurbCoverage). Silence and a rejected
 * statement are different facts, so these values meet only in `agreed`,
 * never through `??`.
 */
type Stated = CoverRange | null | undefined;

/**
 * Everything a title states about its coverage, as one reading. A bracket
 * statement, a bracket range, a subtitle statement or list, and every list
 * after a marker, a packaging phrase or none (a licensed bare list) are all
 * the title's own explicit evidence, and none outranks another: silence
 * yields to whatever the other states; a statement no range holds stands
 * against any range; and two ranges that differ ("Vol. 1-9 (Collects Vols.
 * 1-3)") contradict each other, so neither is taken. Picking one would be a
 * guess.
 */
function agreed(a: Stated, b: Stated): Stated {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a !== null && b !== null && a.from === b.from && a.to === b.to ? a : null;
}

type Peeled = {
  formatTags: string[];
  isNovel: boolean;
  isBox: boolean;
  /** Packaging names found in bracket groups, closest to the series first. */
  lineNames: string[];
  /** What the bracket groups and a subtitle statement say the book collects. */
  stated: Stated;
  noteLabel: string | null;
};

function emptyPeel(): Peeled {
  return {
    formatTags: [],
    isNovel: false,
    isBox: false,
    lineNames: [],
    stated: undefined,
    noteLabel: null,
  };
}

const VOLS = "vol(?:ume)?s?\\.?\\s*";
const STATING = `(?:contain(?:s|ing)|includ(?:es|ing)|collect(?:s|ing))\\s+${VOLS}`;
/** Text that states the book's coverage: a collect-verb, a marker, and a number. */
const STATEMENT = new RegExp(`^${STATING}#?${NUM}`, "i");
const STATED = `${STATING}(?:${RANGE}|#?${NUM})`;
/**
 * A subtitle that only states the book's coverage: a statement ("…, Vol. 1:
 * Includes Vols. 1 & 3") or a bare list of Volumes ("…, Vol. 1: Vols. 1 & 3").
 */
const STATED_SUBTITLE = new RegExp(`^(?:${STATED}|${VOLS}(${RANGE}))$`, "i");
/**
 * A trailing subtitle statement, split off before any designation is read so
 * its marker is never taken for one: "Alpha Deluxe Edition 1-3: Includes Vols. 4-6".
 */
const TRAILING_STATEMENT = new RegExp(`^(.*?\\S)\\s*(?::|\\s[-–—])\\s*(${STATED})$`, "i");
/** A list a packaging phrase introduces: "Omnibus 1 & 3", "Deluxe Edition Vol. 1-3". */
const PHRASE_LIST = `\\b(?:${PACKAGING_PHRASE})\\s*(?:vols?\\.?|volumes?|#)?\\s*${RANGE}`;
/**
 * What a packaged book must never leave unread in its Series title or line
 * name: a Volume list ("Vol. 1 & 3", "#1-3") or a phrase's list. A Part or
 * Book list ("Alpha Part 1-2") and an unmarked one ("Persona 3 & 4") belong
 * to the name.
 */
const LEFT_LIST = new RegExp(`(?<![a-z])(?:${VOLS}|#\\s*)${RANGE}|${PHRASE_LIST}`, "i");
/** A phrase's list in a subtitle: "Alpha Vol. 1-3 Omnibus 1 & 3 Deluxe Edition 1". */
const SUBTITLE_LIST = new RegExp(PHRASE_LIST, "i");
/** A packaging bracket's own Volume list: "(Omnibus Vol. 1-3)", "(Omnibus #1 & 3)". */
const GROUP_LIST = new RegExp(`^(.*?)\\s*(?:vols?\\.?|volumes?|#)\\s*(${RANGE})$`, "i");
/** A dash chain ("2 - 4-6", "4-6-8"), which `parseVolumeList` spans first to last. */
const DASH_CHAIN = new RegExp(`${NUM}\\s*[-–—]\\s*(?:${VOLS})?#?${NUM}\\s*[-–—]`, "i");

/** Text that is one Volume list and nothing else: "1-3", "1, 2, and 4", "1-2 + 3". */
export const WHOLE_VOLUME_LIST = new RegExp(`^${RANGE}$`, "i");

/**
 * A Volume list read where the title's designation grammar reads none: a
 * bracket's list ("(Vol. 4-6)", "(Omnibus Vol. 1-3)"), a subtitle, a carried
 * subtitle beside the book's designation, an ANN designator's list
 * (lib/ann.ts). A dash chain there names no range, so it is a statement no
 * range holds, never the span from its first number to its last.
 */
export function statedList(list: string): Stated {
  return DASH_CHAIN.test(list) ? null : parseVolumeList(list)?.coverRange;
}

/**
 * "Contains Vol. 9 & Ashen Victor", "Collecting Vols. 1-3 plus 4-6 and 7-9
 * in one book": the coverage a statement lists, read by the blurb grammar
 * (lib/coverage.ts) so a title and a blurb never read one sentence two
 * ways. A title has no line size to settle a list that reads two ways
 * ("Vol. 1 and 2 bonus stories", "plus Vol. 4's bonus chapter"), so that,
 * like a gap, leaves the coverage unknown, never a guess and never
 * shortened. Returns false for text that states no coverage.
 */
function absorbStatement(text: string, peel: Peeled): boolean {
  if (!STATEMENT.test(text)) return false;
  // The text states coverage, so a list left unread is rejected, never silence.
  peel.stated = agreed(peel.stated, coverageFromText(text));
  return true;
}

/**
 * Classify one bracket group's inner text, updating the peel. Returns false
 * for a group that belongs to the name ("(For Her Money)", "(Lupin the 3rd)").
 */
function absorbGroup(inner: string, peel: Peeled): boolean {
  const text = inner.trim();
  if (text === "") return true;
  if (NOVEL_TAG.test(text) && !GRAPHIC_NOVEL.test(text)) {
    peel.isNovel = true;
    peel.formatTags.push(text);
    return true;
  }
  if (absorbStatement(text, peel)) return true;
  const coverage = new RegExp(
    `^vol(?:ume)?s?\\.?\\s*(${RANGE})(?:\\s+(.*))?$`,
    "i",
  ).exec(text);
  if (coverage) {
    peel.stated = agreed(peel.stated, statedList(coverage[1]!));
    const rest = coverage[2]?.trim();
    if (rest) {
      if (PACKAGING_TAG.test(rest)) peel.lineNames.push(tidyLineName(rest));
      if (/hardcover/i.test(rest)) peel.formatTags.push("Hardcover");
    }
    return true;
  }
  if (FORMAT_TAG.test(text)) {
    peel.formatTags.push(text);
    return true;
  }
  if (PACKAGING_TAG.test(text)) {
    if (BOX.test(text)) peel.isBox = true;
    // "(Omnibus Vol. 1-3)": the list is a statement, never part of the line name.
    const list = GROUP_LIST.exec(text);
    if (list && PACKAGING_TAG.test(list[1]!)) {
      peel.stated = agreed(peel.stated, statedList(list[2]!));
      peel.lineNames.push(tidyLineName(list[1]!));
    } else {
      peel.lineNames.push(tidyLineName(text));
    }
    return true;
  }
  const note = BRACKET_MARKER.exec(text);
  if (note) {
    peel.noteLabel ??= canonicalLabel(note[1]!);
    return true;
  }
  return false;
}

/** Peel trailing bracket groups off the text for as long as they classify. */
function peelTrailingGroups(text: string, peel: Peeled): string {
  let rest = text;
  for (;;) {
    const m = /^(.*?)\s*[([]([^()[\]]*)[)\]]\s*$/.exec(rest);
    if (!m || m[1]!.trim() === "") return rest;
    if (!absorbGroup(m[2]!, peel)) return rest;
    rest = m[1]!;
  }
}

/** Drop in-title novel groups anywhere: "Foo (Novel) Vol. 5". */
function peelInnerNovelGroups(text: string, peel: Peeled): string {
  return text.replace(/\s*[([]([^()[\]]*)[)\]]/g, (group, inner: string) => {
    if (NOVEL_TAG.test(inner) && !GRAPHIC_NOVEL.test(inner)) {
      peel.isNovel = true;
      peel.formatTags.push(inner.trim());
      return "";
    }
    return group;
  });
}

/** "Hardcover Omnibus" → "Omnibus"; "Manga Box Set" → "Box Set". */
function tidyLineName(text: string): string {
  const cleaned = text
    .replace(/^the\s+/i, "")
    .replace(/^complete\s+(?=(?:manga\s+)?box\s+set)/i, "")
    .replace(/\b(?:hardcover|paperback|mature|manga)\s+/gi, "")
    .replace(/\s+(?:hardcover|paperback)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? text.trim() : cleaned;
}

/** Trailing separators left by a peel go; styled dashes ("orange -future-") stay. */
function tidySeries(text: string): string {
  return text
    .replace(/(?:\s*[,:;]|\s+[-–—])+\s*$/, "")
    .replace(/^[\s,:;]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

type TrailingPackaging = {
  rest: string;
  lineName: string;
  position: string | null;
  /** The Volumes listed after the phrase ("Omnibus 5-6"); a gapped list is null. */
  listed: Stated;
  isBox: boolean;
};

/**
 * Split a trailing packaging phrase off the text, when present: its line
 * name, and what follows it — a position ("Omnibus 7", "Deluxe Edition IV",
 * a box set's "Season 3 Part 2") or a covered range ("Omnibus 5-6").
 */
function trailingPackaging(text: string): TrailingPackaging | null {
  const m = TRAILING_PACKAGING.exec(text) ?? TRAILING_COMPLETE.exec(text);
  if (!m || m[1]!.trim() === "") return null;
  const phrase = m[2]!;
  const season = new RegExp(`^${SEASON_PREFIX}`, "i").exec(phrase)?.[0]?.trim();
  const name = season ? phrase.slice(season.length).trim() : phrase;
  const listed = m[3] !== undefined ? parseVolumeList(m[3])?.coverRange : undefined;
  const position =
    listed === undefined && m[3] !== undefined
      ? /^\d/.test(m[3])
        ? canonicalLabel(m[3])
        : m[3]
      : season
        ? season.replace(/^the\s+/i, "")
        : null;
  return {
    rest: m[1]!,
    lineName: tidyLineName(name),
    position,
    listed,
    isBox: BOX.test(phrase),
  };
}

/** The text ends, brackets aside, in a packaging phrase with its own number or list ("Dragonball 3-in-1 Edition 1"). */
function endsInPackaging(text: string): boolean {
  const phrase = trailingPackaging(peelTrailingGroups(text, emptyPeel()));
  return phrase !== null && (phrase.position !== null || phrase.listed !== undefined);
}

function sameNumber(
  label: string,
  seriesNumber: ParseOptions["seriesNumber"],
): boolean {
  if (
    seriesNumber === undefined ||
    seriesNumber === null ||
    `${seriesNumber}` === ""
  ) {
    return false;
  }
  return Number(label) === Number(seriesNumber);
}

// ---------- the parser ----------

/**
 * Parse one release title into its base Series and what the book is within
 * it. Never falls back to the whole book title when a volume marker is
 * present, and never turns a packaging number ("Omnibus 7") into a Volume.
 */
export function parseBookTitle(
  raw: string,
  options: ParseOptions = {},
): ParsedBookTitle {
  const cleaned = decodeEntities(raw)
    .replace(/[\s ]+/g, " ")
    .trim();
  const peel = emptyPeel();

  // ": The Novel" / " - The Novel" suffixes, then novel groups anywhere.
  let text = cleaned.replace(/\s*(?::|\s[-–—])\s*the\s+novel$/i, () => {
    peel.isNovel = true;
    peel.formatTags.push("The Novel");
    return "";
  });
  if (/\blight\s+novels?\b/i.test(text)) peel.isNovel = true;
  text = peelTrailingGroups(text, peel);

  let volumeLabel: string | null = null;
  let volumeSubtitle: string | null = null;
  // The Volumes a designation lists outside the brackets ("Vol. 1-3",
  // "Omnibus 5-6"): packaging even when a gap leaves it null.
  let listed: Stated = undefined;
  let bareNumber = false;
  let bareRoman = false;
  let bareSplit: ParsedBookTitle["bareSplit"] = null;
  let packagingName: string | null = null;
  let linePosition: string | null = null;

  // A subtitle statement goes first when a packaging phrase's own number or
  // list precedes it and the marker grammar would otherwise take its "Vols."
  // for the designation: "Dragonball 3-in-1 Edition 1: Includes vols. 1, 2 &
  // 3". An earlier marker keeps its reading: "Alpha, Vol. 2: Includes Vols.
  // 4-6" and "Alpha, Vol. 2: Deluxe Edition 1: Includes Vols. 1-3" are Vol.
  // 2, the subtitle display text.
  const trailing = TRAILING_STATEMENT.exec(text);
  const marker = trailing ? VOLUME_MARKER.exec(text) : null;
  const statement =
    trailing && (marker === null || marker[1]!.length > trailing[1]!.length) && endsInPackaging(trailing[1]!)
      ? trailing
      : null;
  if (statement) text = peelTrailingGroups(statement[1]!, peel);

  // A trailing packaging phrase, maybe with its own position: "Negima!
  // Omnibus 4"; without one the text before it may still carry a marker
  // ("Ryuko Vol. 1 & 2 Slipcase Set").
  const packaged = trailingPackaging(text);
  if (packaged) {
    text = packaged.rest;
    packagingName = packaged.lineName;
    linePosition = packaged.position;
    listed = packaged.listed;
    peel.isBox ||= packaged.isBox;
    // A second phrase is part of the same packaging: "Deluxe Complete Series Box Set".
    const more = trailingPackaging(text);
    if (more && more.position === null && more.listed === undefined) {
      text = more.rest;
      peel.formatTags.push(more.lineName);
      peel.isBox ||= more.isBox;
    }
  }
  if (linePosition === null && listed === undefined) {
    const marked = VOLUME_MARKER.exec(text);
    if (marked) {
      text = marked[1]!;
      const designation = marked[2]!;
      // "18+1" is one extra volume's label, never a range.
      listed = PLUS_EXTRA_RE.test(designation) ? undefined : parseVolumeList(designation)?.coverRange;
      if (listed === undefined) volumeLabel = canonicalLabel(designation);
      volumeSubtitle = (marked[3] ?? marked[4])?.trim() || null;
    }
  }

  // Whatever sits before the marker may still carry tags and packaging:
  // "Tokyo Revengers (Omnibus) Vol. 23-24", "Rozen Maiden Collector's Edition Vol. 2".
  text = peelInnerNovelGroups(text, peel);
  text = peelTrailingGroups(text, peel);
  if (packagingName === null) {
    const inner = trailingPackaging(text);
    if (inner) {
      text = inner.rest;
      packagingName = inner.lineName;
      linePosition ??= inner.position;
      // "Alpha Omnibus 1-3 Vol. 4-6": beside a marker's list, the list after
      // the phrase is one more statement, and a gap there stands against a
      // marker's lone number too ("Alpha 3-in-1 Edition 1 & 3, Vol. 1"). A
      // range beside a lone number ("Omnibus 1-3 Vol. 2") is no statement of
      // its own, and with no marker read the bare number before the phrase
      // is still read ("Alpha 2 Omnibus (Light Novel) 1 & 3" is position 2).
      if (listed !== undefined || (inner.listed === null && volumeLabel !== null)) {
        listed = agreed(listed, inner.listed);
      }
      peel.isBox ||= inner.isBox;
      text = peelTrailingGroups(text, peel);
    }
  }

  // An unmarked trailing number: only with a peeled tag or packaging as
  // context, or when it equals the source's own volume number.
  if (volumeLabel === null && listed === undefined && linePosition === null) {
    const bare = BARE_NUMBER.exec(text);
    const context =
      peel.formatTags.length > 0 ||
      peel.lineNames.length > 0 ||
      packagingName !== null;
    if (bare && !/\bno\.?$/i.test(bare[1]!.trim())) {
      const designation = bare[2]!;
      const list = parseVolumeList(designation)?.coverRange;
      const numbers = designation.match(/\d+(?:\.\d+)?/g) ?? [];
      const licensed =
        context ||
        (list !== undefined
          ? sameNumber(numbers[0]!, options.seriesNumber) ||
            sameNumber(numbers.at(-1)!, options.seriesNumber)
          : sameNumber(designation, options.seriesNumber));
      if (licensed) {
        // A trailing alt-title note after the number is dropped:
        // "The Blue Wolves of Mibu 5 (Blue Miburo)".
        text = peelTrailingGroups(bare[1]!, peel);
        bareNumber = true;
        listed = list;
        if (list === undefined) volumeLabel = canonicalLabel(designation);
        volumeSubtitle = bare[3]?.trim() || null;
      } else if (list === undefined) {
        bareSplit = { seriesTitle: tidySeries(bare[1]!), volumeLabel: canonicalLabel(designation) };
      }
    }
  }

  // A volume noted only in brackets: "(Kase-san and... Book 3)", "(Vol. 13)".
  if (volumeLabel === null && listed === undefined && peel.noteLabel !== null) {
    volumeLabel = peel.noteLabel;
  }

  // A separately carried subtitle may hold the marker (OpenLibrary). Beside
  // a packaged book's own designation (judged here, once the bare number has
  // peeled its brackets) a Volume list there is one more statement ("Aoashi
  // (3-in-1 Edition) Volume 3" carrying "Vol. 7,8,9"), and so may be its
  // subtitle. A Part or Book list there names no Volumes.
  const carried = options.subtitle
    ? new RegExp(`^(${MARKER})\\s*(${RANGE}|${LABEL})(?:\\s*[:\\-–]\\s*(.+))?$`, "i").exec(options.subtitle.trim())
    : null;
  let carriedSubtitle: string | undefined;
  if (carried) {
    const list = parseVolumeList(carried[2]!)?.coverRange;
    if (volumeLabel === null && listed === undefined) {
      listed = list;
      if (list === undefined) volumeLabel = canonicalLabel(carried[2]!);
      volumeSubtitle = carried[3]?.trim() || null;
    } else if (
      list !== undefined &&
      /^(?:vol|#)/i.test(carried[1]!) &&
      (packagingName !== null || peel.lineNames.length > 0 || peel.stated !== undefined || listed !== undefined)
    ) {
      listed = agreed(listed, statedList(carried[2]!));
      carriedSubtitle = carried[3];
    }
  }

  // Last, and only when nothing else named the volume (a bracket, a
  // subtitle): "Kingdom Hearts II (Vol. 3)" is Vol. 3 of Kingdom Hearts II.
  if (volumeLabel === null && listed === undefined && linePosition === null && packagingName === null) {
    const roman = BARE_ROMAN.exec(text);
    if (roman && !CONJUNCTION_BEFORE.test(roman[1]!)) {
      text = roman[1]!;
      volumeLabel = canonicalLabel(roman[2]!);
      bareNumber = true;
      bareRoman = true;
    }
  }
  // A declined split is offered only while no label is known: "Tower
  // Dungeon 7 (Vol. 8)" is Vol. 8, never 7.
  if (volumeLabel !== null || listed !== undefined) bareSplit = null;

  // Bracket packaging names apply when no trailing phrase named the line.
  const lineName = packagingName ?? peel.lineNames[0] ?? null;
  // "Alpha (3-in-1 Edition), Vol. 1: Includes Vols. 1 & 3", "Alpha 3-in-1
  // Edition, Vol. 1: Vols. 1 & 3": a subtitle may state the coverage too,
  // with or without a line, unless the book is a plain Volume ("Alpha, Vol.
  // 1: Includes Vols. 1 & 3" stays Vol. 1, the subtitle display text). A
  // carried subtitle is read whole as well as after its marker: "Includes
  // Vols. 1 & 3" carried beside "Alpha Omnibus Vol. 1-3" states it too.
  const isPackaging = lineName !== null || listed !== undefined || peel.stated !== undefined;
  if (isPackaging || volumeLabel === null) {
    const subtitles = [volumeSubtitle, statement?.[2], carriedSubtitle, options.subtitle];
    for (const subtitle of new Set(subtitles)) {
      const said = subtitle ? STATED_SUBTITLE.exec(subtitle.trim()) : null;
      if (!said) continue;
      if (said[1] === undefined) absorbStatement(said[0], peel);
      else peel.stated = agreed(peel.stated, statedList(said[1]));
    }
  }
  volumeSubtitle ??= statement?.[2] ?? null;
  // Brackets and the designation outside them must agree (see `agreed`): a
  // rejected statement is never replaced by the other's range. A list still
  // left in a packaged book's Series title or line name, or a phrase's list
  // in its subtitle, was stated but never read, so it stands against any
  // range as a rejected statement would.
  const unread =
    LEFT_LIST.test(text) ||
    (lineName !== null && LEFT_LIST.test(lineName)) ||
    [volumeSubtitle, options.subtitle].some((subtitle) => subtitle && SUBTITLE_LIST.test(subtitle));
  const read = agreed(peel.stated, listed);
  const stated = unread && (read !== undefined || lineName !== null || peel.isBox) ? null : read;
  let packaging: Packaging | null = null;
  if (lineName !== null || stated !== undefined || peel.isBox) {
    packaging = {
      lineName: lineName ?? (peel.isBox ? "Box Set" : null),
      // A single number next to packaging is its line position, never a Volume.
      linePosition: linePosition ?? volumeLabel,
      // The stored shape: silence is a null range alone, a rejection carries the flag.
      coverRange: stated ?? null,
      ...(stated === null ? { coverageGapped: true } : {}),
    };
    volumeLabel = null;
  }
  for (const extra of peel.lineNames) {
    if (extra !== lineName) peel.formatTags.push(extra);
  }

  const seriesTitle = tidySeries(text);
  return {
    seriesTitle: seriesTitle === "" ? cleaned : seriesTitle,
    volumeLabel,
    volumeSubtitle,
    packaging,
    isBox: peel.isBox,
    isNovel: peel.isNovel,
    formatTags: peel.formatTags,
    bareNumber,
    bareRoman,
    bareSplit,
  };
}

/** Every label a cover range spans, in order ("19"–"21" → 19, 20, 21). */
export function rangeLabels(range: CoverRange): string[] {
  const from = Number(range.from);
  const to = Number(range.to);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    to < from ||
    to - from >= 50
  ) {
    return [];
  }
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
}

/** Does this title mark a prose / light novel? ("(Novel)", ": The Novel", "light novel"). */
export function isNovelTitle(title: string): boolean {
  return parseBookTitle(title).isNovel;
}

// ---------- scope ----------

export type ScopeReason = "novel" | "merchandise" | "sampler" | "nonEnglish" | "childrensBook";

const MERCHANDISE =
  /\b(?:playing cards|scratch cards|card game|roll & clash|advent calendar|stick it|activity book|colou?ring book|color the classics|papertoy|paper toy|fan notebook|sudoku|number place|origami|kirigami|papercrafts?|sticker book|postcard book|poster book|tarot deck|board game)\b|\b(?:\d{4}\s+)?(?:wall\s+)?calendar$/i;

const SAMPLER =
  /\b(?:manga showcase|free sample|fcbd|free comic book day|convention exclusive|manga magazine|sampler)\b/i;

// Children's illustrated books a manga publisher also sells ("Cells at
// Work! Picture Book 1") — prose-and-pictures, never manga Volumes.
// "Adults' Picture Book" (Otona no Zukan) is a manga title, not one.
const CHILDRENS_BOOK = /(?<!\badults?'?\s)\b(?:picture|board)\s+books?\b/i;

const NON_ENGLISH =
  /versi[oó]n en espa[nñ]ol|edici[oó]n en espa[nñ]ol|\bvolumen\s+\d|[([](?:spanish|french|german|italian|portuguese|japanese)(?:\s+edition)?[)\]]|[ée]dition fran[cç]aise/i;

/**
 * Why a title is outside the English manga catalog (spec §1), or null when
 * it is in scope: prose/light novels, merchandise and activity books, promo
 * samplers, children's picture books, and non-English editions.
 */
export function outOfScopeReason(title: string): ScopeReason | null {
  const text = decodeEntities(title);
  if (NON_ENGLISH.test(text)) return "nonEnglish";
  if (MERCHANDISE.test(text)) return "merchandise";
  if (SAMPLER.test(text)) return "sampler";
  if (CHILDRENS_BOOK.test(text)) return "childrensBook";
  if (parseBookTitle(text).isNovel) return "novel";
  return null;
}
