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
  /** The source Volumes the book collects, inclusive; null when the title never says. */
  coverRange: v.union(coverRangeValidator, v.null()),
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
const LABEL = `(?:${NUM}|[A-Z]\\d{1,2}|${WORD_NUMBER}|${ROMAN})`;
/** A list or range of numbers: "1-3", "1 & 2", "1, 2, 3", "10-11+EX". */
const RANGE = `${NUM}(?:\\s*(?:-|–|—|&|,|and)\\s*${NUM})+(?:\\s*\\+\\s*\\w+)?`;

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

/** "1-3" / "1 & 2" / "1, 2, 3" → {from: "1", to: "3"}; a lone number → null. */
function parseRange(text: string): CoverRange | null {
  const numbers = text.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length < 2) return null;
  return {
    from: canonicalLabel(numbers[0]!),
    to: canonicalLabel(numbers[numbers.length - 1]!),
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
  "omnibus(?:\\s+(?:edition|collection))?",
  "\\d-in-1(?:\\s+edition)?",
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

// ---------- peeling ----------

type Peeled = {
  formatTags: string[];
  isNovel: boolean;
  isBox: boolean;
  /** Packaging names found in bracket groups, closest to the series first. */
  lineNames: string[];
  coverRange: CoverRange | null;
  noteLabel: string | null;
};

function emptyPeel(): Peeled {
  return {
    formatTags: [],
    isNovel: false,
    isBox: false,
    lineNames: [],
    coverRange: null,
    noteLabel: null,
  };
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
  // "(Contains Vol. 9 & Ashen Victor)": whatever it lists is the coverage.
  const contains = /^contains\s+vol(?:ume)?s?\.?\s*(\d+(?:\.\d+)?)/i.exec(text);
  if (contains) {
    const numbers = text.match(/\d+(?:\.\d+)?/g) ?? [contains[1]!];
    peel.coverRange = {
      from: canonicalLabel(numbers[0]!),
      to: canonicalLabel(numbers[numbers.length - 1]!),
    };
    return true;
  }
  const coverage = new RegExp(
    `^vol(?:ume)?s?\\.?\\s*(${RANGE})(?:\\s+(.*))?$`,
    "i",
  ).exec(text);
  if (coverage) {
    peel.coverRange = parseRange(coverage[1]!);
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
    peel.lineNames.push(tidyLineName(text));
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
  range: CoverRange | null;
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
  const range = m[3] !== undefined ? parseRange(m[3]) : null;
  const position =
    range === null && m[3] !== undefined
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
    range,
    isBox: BOX.test(phrase),
  };
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
  let range: CoverRange | null = null;
  let bareNumber = false;
  let packagingName: string | null = null;
  let linePosition: string | null = null;

  // A trailing packaging phrase, maybe with its own position: "Negima!
  // Omnibus 4"; without one the text before it may still carry a marker
  // ("Ryuko Vol. 1 & 2 Slipcase Set").
  const packaged = trailingPackaging(text);
  if (packaged) {
    text = packaged.rest;
    packagingName = packaged.lineName;
    linePosition = packaged.position;
    range = packaged.range;
    peel.isBox ||= packaged.isBox;
    // A second phrase is part of the same packaging: "Deluxe Complete Series Box Set".
    const more = trailingPackaging(text);
    if (more && more.position === null && more.range === null) {
      text = more.rest;
      peel.formatTags.push(more.lineName);
      peel.isBox ||= more.isBox;
    }
  }
  if (linePosition === null && range === null) {
    const marked = VOLUME_MARKER.exec(text);
    if (marked) {
      text = marked[1]!;
      const designation = marked[2]!;
      range = parseRange(designation);
      if (range === null) volumeLabel = canonicalLabel(designation);
      const subtitle = (marked[3] ?? marked[4])?.trim();
      volumeSubtitle = subtitle ? subtitle : null;
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
      peel.isBox ||= inner.isBox;
      text = peelTrailingGroups(text, peel);
    }
  }

  // An unmarked trailing number: only with a peeled tag or packaging as
  // context, or when it equals the source's own volume number.
  if (volumeLabel === null && range === null && linePosition === null) {
    const bare = BARE_NUMBER.exec(text);
    const context =
      peel.formatTags.length > 0 ||
      peel.lineNames.length > 0 ||
      packagingName !== null;
    if (bare && !/\bno\.?$/i.test(bare[1]!.trim())) {
      const designation = bare[2]!;
      const rangeHere = parseRange(designation);
      const licensed =
        context ||
        (rangeHere
          ? sameNumber(rangeHere.from, options.seriesNumber) ||
            sameNumber(rangeHere.to, options.seriesNumber)
          : sameNumber(designation, options.seriesNumber));
      if (licensed) {
        // A trailing alt-title note after the number is dropped:
        // "The Blue Wolves of Mibu 5 (Blue Miburo)".
        text = peelTrailingGroups(bare[1]!, peel);
        bareNumber = true;
        if (rangeHere) range = rangeHere;
        else volumeLabel = canonicalLabel(designation);
        volumeSubtitle = bare[3]?.trim() || null;
      }
    }
  }

  // A volume noted only in brackets: "(Kase-san and... Book 3)", "(Vol. 13)".
  if (volumeLabel === null && range === null && peel.noteLabel !== null) {
    volumeLabel = peel.noteLabel;
  }

  // A separately carried subtitle may hold the marker (OpenLibrary).
  if (volumeLabel === null && range === null && options.subtitle) {
    const sub = new RegExp(
      `^${MARKER}\\s*(${RANGE}|${LABEL})(?:\\s*[:\\-–]\\s*(.+))?$`,
      "i",
    ).exec(options.subtitle.trim());
    if (sub) {
      range = parseRange(sub[1]!);
      if (range === null) volumeLabel = canonicalLabel(sub[1]!);
      volumeSubtitle = sub[2]?.trim() || null;
    }
  }

  // Bracket packaging names apply when no trailing phrase named the line.
  const lineName = packagingName ?? peel.lineNames[0] ?? null;
  const coverRange = peel.coverRange ?? range;
  let packaging: Packaging | null = null;
  if (lineName !== null || coverRange !== null || peel.isBox) {
    packaging = {
      lineName: lineName ?? (peel.isBox ? "Box Set" : null),
      // A single number next to packaging is its line position, never a Volume.
      linePosition: linePosition ?? volumeLabel,
      coverRange,
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

export type ScopeReason = "novel" | "merchandise" | "sampler" | "nonEnglish";

const MERCHANDISE =
  /\b(?:playing cards|scratch cards|card game|roll & clash|advent calendar|stick it|activity book|colou?ring book|color the classics|papertoy|paper toy|fan notebook|sudoku|number place|origami|kirigami|papercrafts?|sticker book|postcard book|poster book|tarot deck|board game)\b|\b(?:\d{4}\s+)?(?:wall\s+)?calendar$/i;

const SAMPLER =
  /\b(?:manga showcase|free sample|fcbd|free comic book day|convention exclusive|manga magazine|sampler)\b/i;

const NON_ENGLISH =
  /versi[oó]n en espa[nñ]ol|edici[oó]n en espa[nñ]ol|\bvolumen\s+\d|[([](?:spanish|french|german|italian|portuguese|japanese)(?:\s+edition)?[)\]]|[ée]dition fran[cç]aise/i;

/**
 * Why a title is outside the English manga catalog (spec §1), or null when
 * it is in scope: prose/light novels, merchandise and activity books, promo
 * samplers, and non-English editions.
 */
export function outOfScopeReason(title: string): ScopeReason | null {
  const text = decodeEntities(title);
  if (NON_ENGLISH.test(text)) return "nonEnglish";
  if (MERCHANDISE.test(text)) return "merchandise";
  if (SAMPLER.test(text)) return "sampler";
  if (parseBookTitle(text).isNovel) return "novel";
  return null;
}
