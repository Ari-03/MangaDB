// ANN Encyclopedia parsing (spec §6/§7): pure functions from
// ANN's XML wire formats to normalized snapshots. Two endpoints feed the
// mirror (both verified live 2026-08-20):
//
// - `reports.xml?id=155&type=manga&nlist=N&nskip=M` — the enumeration of
//   every manga entry (`<item><id>…</id><name>…</name></item>`), paged.
// - `api.xml?manga=ID1/ID2/…` — batch details, up to 50 ids per request
//   (ANN etiquette: 1 request per second). Each `<manga>` carries the Main
//   title, Alternative titles, a Plot Summary (the Series synopsis ANN
//   offers at weak authority), staff, an occasional age rating
//   ("Objectionable content", genres; see `isMatureEntry`), and one
//   `<release date="YYYY-MM-DD" href="…releases.php?id=NNN">Title (GN
//   14)</release>` per North American release — future dates included,
//   month precision possible ("2024-11-00"), eBook lines for digital.
//
// ANN is series-structured: one manga entry = one Series; the "(GN n)"
// suffixes define the Volume backbone. Each release line also carries the
// book's ISBN (`ean="978…"` — present on >99.9% of lines, verified live
// 2026-09-25), which links lines to canonical Releases exactly. The API has
// no publisher, so creating a Release needs the per-release Encyclopedia
// page — `releases.php?id=NNN` — whose Distributor, ISBN-10/13, release
// date, suggested retail price, and Description (the book's blurb)
// `parseReleasePage` reads (see ann.ts's release-page pass).

import { v, type Infer } from "convex/values";
import {
  agreed,
  canonicalLabel,
  type CoverRange,
  coverRangeValidator,
  EDITION_LINE_NAME,
  parseBookTitle,
  rangeLabels,
  type Stated,
  statedList,
  tidyLineName,
  WHOLE_VOLUME_LIST,
} from "./bookTitle";
import { statementCoverage } from "./coverage";
import { datePartsValidator, type DateParts } from "./dates";
import { toIsbn13 } from "./isbn";
import {
  cleanBlurb,
  cleanTitleText,
  decodeEntities,
  mapC1Controls,
  repairMojibake,
  stripHtml,
} from "./text";

// ---------- the normalized snapshot ----------

/** One `<staff>` row: ANN's task ("Story & Art", "Art", …) and person. */
export const annCreditValidator = v.object({
  personId: v.string(),
  name: v.string(),
  task: v.string(),
});
export type AnnCredit = Infer<typeof annCreditValidator>;

/** One `<release>` line of a manga entry. */
const annReleaseValidator = v.object({
  /** ANN's stable release id (releases.php?id=NNN) — observation identity. */
  annId: v.string(),
  date: v.optional(datePartsValidator),
  /** The English release title before the "(GN n)" designator. */
  title: v.string(),
  /** Volume label ("14", "7.5"); absent = an unnumbered oneshot or a list. */
  label: v.optional(v.string()),
  /** A "(GN 1-3)" range or list designator (multi-volume). */
  multi: v.boolean(),
  format: v.union(v.literal("physical"), v.literal("digital")),
  /**
   * Omnibus/box-set/deluxe packaging — an Edition Line shape, from the
   * designator ("Omnibus GN 1-3") or a line name in the title ("[VIZBIG
   * Edition]", "- Library Edition").
   */
  editionLineHint: v.boolean(),
  /** The line's ISBN-13 (from ANN's `ean` attribute), when valid. */
  isbn13: v.optional(v.string()),
  /**
   * The Volumes a "(GN 97-99)" or "(GN 1, 2, 3)" designator says the book
   * collects, or a packaged line's title statement ("VIZBIG Edition
   * [13-15]", "[VIZBIG Edition Vols. 4-6]", "VIZBIG Edition 1: Includes
   * Vols. 4-6"), all of which agree (packagingOf).
   */
  coverRange: v.optional(coverRangeValidator),
  /**
   * The designator lists Volumes no range holds: a gap ("GN 1, 3", "GN 1-3,
   * 5"), a numbered extra ("GN 1-2 + 3"), a backwards range, a dash chain, a
   * range Coverage cannot list ("GN 10.5-11", "GN 1-80"), or text the list
   * grammar does not read. Multi-volume with no label and no range, and
   * never sized from the line's name: the page pass holds it. A packaged
   * line's title statement no range holds ("VIZBIG Edition [1, 3]", "[1 and
   * Vol. 3]", "[VIZBIG Edition Vols. 1, 3]", "Includes Vols. 1 & 3",
   * "Includes Vols. 1-3 plus 7-9", "VIZBIG Edition 1-3-5"), one that differs
   * from the designator's list or another of the title's ("Alpha [4-6]" at
   * GN 1-3), or a number in its line's segment read as neither position
   * nor coverage sets it too (packagingOf), so a decision reading the
   * stored line keeps the rejection.
   * The same flag as a title's (lib/bookTitle.ts packagingValidator).
   */
  coverageGapped: v.optional(v.literal(true)),
});
export type AnnRelease = Infer<typeof annReleaseValidator>;

// What reconciliation reads (spec §6): one observation per manga entry, its
// releases embedded (they also get per-release observations keyed on ANN's
// own release ids — see ann.ts).
export const annMangaValidator = v.object({
  kind: v.literal("annManga"),
  id: v.string(),
  url: v.string(),
  title: v.string(),
  altTitles: v.array(v.string()),
  /** The entry's Plot Summary, cleaned to one paragraph. */
  synopsis: v.optional(v.string()),
  staff: v.array(v.string()),
  /** Each staff row with its task and ANN person id (credits.ts reads these). */
  credits: v.optional(v.array(annCreditValidator)),
  /** ANN rates the entry for adults (`isMatureEntry`); absent otherwise. */
  mature: v.optional(v.literal(true)),
  releases: v.array(annReleaseValidator),
});

export type AnnMangaSnapshot = Infer<typeof annMangaValidator>;

// ---------- report enumeration ----------

export type AnnReportItem = { id: string; name: string };

export type AnnReport = {
  /** The page's manga items (non-manga and malformed rows excluded). */
  items: AnnReportItem[];
  /** Page-relative positions of rows missing an id or name — skipped, but
   * the caller must report them: an unknown entry makes withdrawal unsafe. */
  malformed: number[];
  /** Every `<item>` on the page, whatever its shape: what paging counts. */
  rawCount: number;
};

/**
 * One reports.xml page → its manga items. Throws when the page itself is
 * untrustworthy (not a report document, `listed` disagreeing with the item
 * count, a truncated item); a single malformed row only lands in `malformed`
 * so the enumeration can go on.
 */
export function parseReport(xml: string): AnnReport {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<report\b[^>]*>[\s\S]*<\/report>\s*$/.test(xml)) {
    throw new Error("ANN returned an invalid report document");
  }
  const rawCount = (xml.match(/<item>/g) ?? []).length;
  // `listed` echoes the page size asked for (nlist), not the item count: the
  // report's final page carries listed="500" with fewer items (2026-09-27:
  // 333 items holding One Piece, Berserk, Vagabond and every other 1990s
  // series). A short page is legitimate; more items than listed is not.
  const listed = /<report\b[^>]*\blisted="(\d+)"/.exec(xml)?.[1];
  if (listed !== undefined && rawCount > Number(listed)) {
    throw new Error("ANN report item count does not match its listed count");
  }
  const items: AnnReportItem[] = [];
  const malformed: number[] = [];
  let parsedCount = 0;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const at = parsedCount++;
    const body = m[1]!;
    const id = /<id>(\d+)<\/id>/.exec(body)?.[1];
    const type = /<type>([^<]*)<\/type>/.exec(body)?.[1];
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1];
    if (id === undefined || name === undefined) {
      malformed.push(at);
      continue;
    }
    if (type !== undefined && type !== "manga") continue;
    items.push({ id, name: cleanTitleText(name) });
  }
  if (parsedCount !== rawCount) throw new Error("ANN report contains an incomplete item");
  return { items, malformed, rawCount };
}

// ---------- release lines ----------

// Before 2010 ANN recorded month-only dates as the 1st (day 1 is a third of
// its 2000-04 dates against ~3% elsewhere): such a day is a placeholder.
const MONTH_PLACEHOLDER_BEFORE = 2010;

/**
 * "2026-02-10" | "2024-11-00" | "2024-00-00" → a partial-precision date.
 * A pre-2010 "day 01" reads as month precision, so a real day from another
 * source can refine it (spec §6) instead of losing to false precision.
 */
export function parseAnnDate(text: string): DateParts | undefined {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  if (year < 1900 || year > 2200) return undefined;
  const month = Number(m[2] ?? 0);
  const day = Number(m[3] ?? 0);
  if (month < 1 || month > 12) return { year };
  if (day < 1 || day > 31) return { year, month };
  if (day === 1 && year < MONTH_PLACEHOLDER_BEFORE) return { year, month };
  return { year, month, day };
}

// Packaging words. In the designator ("Omnibus GN 1-3", "GN box 2") they
// always mean packaging. In the line's own title an Edition Line's name, in
// the shared title parser's vocabulary (lib/bookTitle.ts EDITION_LINE_NAME:
// "Berserk Deluxe Edition (GN 1)", "Vagabond [VIZBIG Edition] (GN 1)",
// "Death Note - Library Edition (GN 1)", "Summer Ghost: The Complete Manga
// Collection (GN)"), means packaging unless the work's own name, opening
// the title, accounts for it: "Makunouchi Deluxe (GN 2)" is a Volume,
// "Makunouchi Deluxe [VIZBIG Edition] (GN 1)" a VIZBIG book, "Alpha
// [Deluxe] (GN 13)" a Deluxe book whatever the entry is called
// (`readAnnLineTitle`). A reissue or
// binding tag ("[2nd Edition]", "[Hardcover]") is no line: such a line
// stays a single Volume. So is an anniversary reprint, which ANN numbers by
// Volume ("NANA - [25th Anniversary Edition] (GN 2)" is Volume 2 again),
// though the shared vocabulary names it a line.
const DESIGNATOR_PACKAGING = /\b(omnibus|box(?:ed)?(?: set)?|deluxe|collector'?s|hardcover)\b/i;
const ANNIVERSARY = /\b(?:\d+(?:st|nd|rd|th)\s+)?anniversary\s+edition\b/gi;

// A line's name may carry the article the shared parser's trailing phrase
// allows ("Dark Metro - The Ultimate Edition"): it belongs to the line, not
// the work. The name itself is read without it.
const LINE_NAMES = new RegExp(
  `(?:\\bthe\\s+)?(?:\\b(?:hardcover|paperback)\\s+collection\\b|${EDITION_LINE_NAME.source})`,
  "gi",
);
const ARTICLE = /^the\s+/i;

type LineHit = {
  /** Where the hit starts, its article included. */
  start: number;
  /** Where the name starts, after any article. */
  name: number;
  end: number;
};

/** Where a text names an Edition Line, anniversary reprints aside. */
function lineNameHits(text: string): LineHit[] {
  const blanked = text.replace(ANNIVERSARY, (phrase) => " ".repeat(phrase.length));
  return [...blanked.matchAll(LINE_NAMES)].map((m) => ({
    start: m.index,
    name: m.index + (ARTICLE.exec(m[0])?.[0].length ?? 0),
    end: m.index + m[0].length,
  }));
}

/** Whether a text names an Edition Line in the shared vocabulary, anniversary reprints aside. */
export function namesEditionLine(text: string): boolean {
  return lineNameHits(text).length > 0;
}

/**
 * One word's spelling key: case, accents, apostrophe and dash glyphs aside,
 * and the stop or colon a title puts after it ("Deluxe:").
 */
const wordKey = (word: string) =>
  word
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/[‐‑–—]/g, "-")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[,:;.]+$/, "");

/** A text's spelling key, word by word (`wordKey`). */
const textKey = (text: string) => text.split(/\s+/).filter(Boolean).map(wordKey).join(" ");

/**
 * Where a title's opening words spell `name` out, word for word: the end
 * of its last one, or -1 when the title does not open with the name.
 * "Makunouchi Deluxe [VIZBIG Edition]" opens with Makunouchi Deluxe;
 * "Alpha [Deluxe]" and "Makunouchi [Deluxe]" do not.
 */
function nameEnd(title: string, name: string): number {
  const own = name.split(/\s+/).filter(Boolean).map(wordKey);
  const words = [...title.matchAll(/\S+/g)];
  if (own.length === 0 || words.length < own.length) return -1;
  if (own.some((key, i) => wordKey(words[i]![0]) !== key)) return -1;
  const last = words[own.length - 1]!;
  return last.index + last[0].length;
}

/**
 * The line names a title adds to a work's own name. A name owns the line
 * words of the title's opening words when those spell it out ("Makunouchi
 * Deluxe", "The Omnibus Club"), and no others: the same word anywhere else
 * in the title ("Alpha [Deluxe]", "Alpha [Omnibus]") is a line the title
 * adds, however the name is spelled. Several names are spellings of one
 * work, so the one that owns the most counts.
 */
function addedLineNames(title: string, names: readonly string[]) {
  const hits = lineNameHits(title);
  let best = hits;
  for (const name of names) {
    const end = nameEnd(title, name);
    const added = hits.filter((hit) => hit.end > end);
    if (added.length < best.length) best = added;
  }
  return best;
}

// ---------- a line's own statements ----------
//
// Everything a line's segment says beside its name, read whole: the text in
// the name's bracket after the name ("[VIZBIG Edition Vols. 4-6]"), then
// after the name or its bracket a designation ("2", "II", "1-3", "Vol. 2"),
// bracket tags ("(GN 12)", "[Hardcover]") and a subtitle after a separator
// ("33 - Wano", "1: Includes Vols. 4-6"). Each part is one of:
//
// - a position: one number after the name or a marker ("2", "] II", "(Vol.
//   II)", "[Book 3]"). ASCII digits and upper-case Roman numerals are read;
//   any other number ("(Vol. ii)", "(Vol. two)", "(Vol. -2)", "(Vol. 2A)",
//   "(Vol. ２)"), and any marker whose number the grammar cannot read
//   ("(Vol. thirty)", "(Vol. n/a)", "(Vol. M)", "(Book Thirty)", "(Part
//   Two)"), is a position nobody may supply instead;
// - a coverage statement: a Volume list, read whole (`wholeList`), or a
//   collect-verb statement, read whole (lib/coverage.ts statementCoverage);
// - a reissue or binding tag ("[2nd Edition]", "(Hardcover)"), or words
//   with no number and no marker in them ("- Wano", "[Side Story VIZBIG
//   Edition]"): nothing about the book's place;
// - anything else with a number or a marker in it ("(Part 2)", "1: Arc 3",
//   "1: The Book of Sand"): read as neither, so it stands against any
//   position and any coverage.
//
// Positions and coverage are separate: a list is never a position, and an
// N-in-1 name's count is the line's, never the book's.

/** What a line's segment states beside its name. */
type Tail = {
  /** Every position it states, canonical ("II" → "2"). */
  positions: string[];
  /** Every coverage statement: a range, or null for one no range holds. */
  statements: Stated[];
  /** A position it states that the grammar cannot read: no other may stand in for it. */
  positionUnread: boolean;
};

const MARK = String.raw`(?:vol(?:ume)?(s)?\.?|book|gn|#)`;
const JOIN = String.raw`\s*(?:[-–—~,&+]|\band\b|\bplus\b)\s*`;
/** One designation: an optional marker, then one number or numeral, or a list of them. */
const DESIGNATION = new RegExp(
  String.raw`^(?:${MARK}\s*)?(-?[\p{L}\p{N}.]+(?:${JOIN}(?:(?:vol(?:ume)?s?\.?|#)\s*)?[\p{L}\p{N}.]+)*)$`,
  "iu",
);
/** Between a list's items, a repeated marker included: "1 & Vol. 3", "#1-#3". */
const LIST_JOIN = new RegExp(`${JOIN}(?:(?:vol(?:ume)?s?\\.?|#)\\s*)?`, "i");
/** Where a subtitle starts: a colon or semicolon, or a dash or comma before a word ("33 - Wano"). */
const SUBTITLE = /\s*[:;]\s*|\s+[-–—](?!\s*[\d#])\s+|\s*,(?!\s*(?:[\d#&]|and\b|vol))\s*/i;
/** A reissue or anniversary tag: "[2nd Edition]", "(3rd Printing)". */
const REISSUE =
  /^(?:the\s+)?\d+(?:st|nd|rd|th)\s+(?:edition|printing|anniversary(?:\s+edition)?)$/i;
/**
 * A word that says a book's number stands after it ("Vol.", "Book", "GN",
 * "Part", "#"), whatever follows: what follows is a number the grammar
 * reads, or one it cannot, never nothing.
 */
const MARKER = String.raw`(?:(?<![\p{L}\p{N}])(?:vol(?:ume)?s?|books?|gn|parts?)(?![\p{L}\p{N}])|#)`;
const MARKED = new RegExp(MARKER, "iu");
const MARKED_LEAD = new RegExp(`^${MARKER}`, "iu");

/** A token a designation may hold: digits, a Roman numeral in either case, a number word. */
function numberLike(token: string): boolean {
  return /^\d/.test(token) || /^[ivxlc]+$/i.test(token) || /^\d+$/.test(canonicalLabel(token));
}

/** A position the grammar reads: digits, or an upper-case Roman numeral ("II" → "2"). Null for any other. */
function readPosition(token: string): string | null {
  if (/^\d+(?:\.\d+)?$/.test(token)) return canonicalLabel(token);
  const roman = /^[IVXLC]+$/.test(token) ? canonicalLabel(token) : "";
  return /^\d+$/.test(roman) ? roman : null;
}

/**
 * Whether text says something of the book's number the line's grammar must
 * read: a numeral in any script ("2", "２", "#"), a Roman numeral, or a
 * marker ("Vol. thirty", "Vol. n/a").
 */
function numeric(text: string): boolean {
  return /\p{N}|\b[IVXLC]{2,}\b/u.test(text) || MARKED.test(text);
}

/** A number the grammar cannot read: no position may stand in for it, and no coverage beside it holds. */
function unread(tail: Tail) {
  tail.statements.push(null);
  tail.positionUnread = true;
}

/**
 * An explicit Volume list read whole, the same for a designator, a title's
 * list and a line's statement: its range when its items run in order with
 * no gap and Coverage can list them; null when no range holds it as
 * written: a gap, a dash chain ("1-3-5"), a number below the one before it
 * ("6-4"), a fraction ("1.5-3.5"), more Volumes than one book holds
 * ("1-80"), or text the list grammar does not read ("1 & Two").
 */
function wholeList(text: string): CoverRange | null {
  const list = text.replace(/(?:vol(?:ume)?s?\.?|#)\s*/gi, "").trim();
  if (!WHOLE_VOLUME_LIST.test(list)) return null;
  const range = statedList(list);
  const numbers = (list.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const ordered = numbers.every((n, i) => i === 0 || n >= numbers[i - 1]!);
  return range && ordered && rangeLabels(range).length > 0 ? range : null;
}

/**
 * One designation, judged: a position (or an unread one), a list's
 * statement, or null when the text is no designation (a word that is no
 * number: "Club", "Hardcover"). `bare`: no marker before it.
 */
function designation(
  text: string,
): { bare: boolean; position: string | null } | { bare: boolean; list: Stated } | null {
  const m = DESIGNATION.exec(text.trim());
  if (!m) return null;
  const items = m[2]!.replace(/^-/, "").split(LIST_JOIN);
  if (!items.every(numberLike)) return null;
  const bare = m[0] === m[2];
  if (items.length > 1) return { bare, list: wholeList(m[2]!) };
  // "Vols. 4": a list marker that lists one Volume reads no list.
  if (m[1] !== undefined) return { bare, list: null };
  return { bare, position: readPosition(m[2]!) };
}

/**
 * Add one designation to the tail. Where it stands decides a bare number:
 * after the name it is a position, alone in a tag a list no range holds
 * ("[7]"), in a subtitle a number read as neither.
 */
function addDesignation(
  tail: Tail,
  read: NonNullable<ReturnType<typeof designation>>,
  where: "lead" | "tag" | "subtitle",
) {
  if ("list" in read) {
    tail.statements.push(read.list);
  } else if (read.bare && where === "tag") {
    tail.statements.push(null);
  } else if (read.bare && where === "subtitle") {
    unread(tail);
  } else if (read.position === null) {
    tail.positionUnread = true;
  } else {
    tail.positions.push(read.position);
  }
}

/** A tag or a subtitle: a statement, a designation, a reissue or plain words, else a number read as neither. */
function readPart(text: string, where: "tag" | "subtitle", tail: Tail) {
  const part = text.trim();
  if (part === "" || (where === "tag" && REISSUE.test(part))) return;
  const said = statementCoverage(part);
  if (said !== undefined) {
    tail.statements.push(said);
    return;
  }
  const read = designation(part);
  if (read !== null) {
    addDesignation(tail, read, where);
  } else if (numeric(part)) {
    unread(tail);
  }
}

/**
 * Read what follows a line's name into `tail`, whole: bracket tags
 * anywhere, then a designation or a statement, then a subtitle after a
 * separator. A lead the grammar cannot read but that is plainly a number
 * (one numeral, "２", or a marker and what follows it, "Vol. thirty") is
 * an unread position. False when words follow the name that no position,
 * tag or subtitle explains ("Alpha Omnibus Club", "VIZBIG Edition 2
 * Hardcover"): its segmentation is unclear.
 */
function readTail(text: string, tail: Tail): boolean {
  const tags: string[] = [];
  const rest = text.replace(/[([]([^()[\]]*)[)\]]/g, (_, inner: string) => {
    tags.push(inner);
    return " ";
  });
  if (/[()[\]]/.test(rest)) return false;
  for (const tag of tags) readPart(tag, "tag", tail);
  const cut = SUBTITLE.exec(rest);
  const lead = (cut ? rest.slice(0, cut.index) : rest).replace(/^[\s,]+/, "").trim();
  if (lead !== "") {
    const said = statementCoverage(lead);
    const read = said === undefined ? designation(lead) : null;
    if (said !== undefined) tail.statements.push(said);
    else if (read !== null) addDesignation(tail, read, "lead");
    else if (MARKED_LEAD.test(lead) || (/^\S+$/.test(lead) && numeric(lead))) unread(tail);
    else return false;
  }
  if (cut) readPart(rest.slice(cut.index + cut[0].length), "subtitle", tail);
  return true;
}

/** The one position a tail states, or null for none, an unread one, or two that differ. */
function tailPosition(tail: Tail): string | null {
  const [first] = tail.positions;
  return !tail.positionUnread && new Set(tail.positions).size === 1 ? first! : null;
}

/** The open bracket enclosing `index`, or -1. */
function enclosingBracket(text: string, index: number): number {
  const open: number[] = [];
  for (let i = 0; i < index; i++) {
    if (text[i] === "[" || text[i] === "(") open.push(i);
    else if (text[i] === "]" || text[i] === ")") open.pop();
  }
  return open.at(-1) ?? -1;
}

/**
 * What an ANN release line's title says about its work and its Edition
 * Line, read without the general title parser, whose job is splitting
 * book numbers off: it reads "Kingdom Hearts II [VIZBIG Edition]" as
 * Kingdom Hearts, and "Alpha 2 [VIZBIG Edition]" as Alpha.
 *
 * - `single`: the title names no Edition Line beyond the work's own name
 *   (`names`, its known spellings, own "Makunouchi Deluxe" only where the
 *   title opens with it: `addedLineNames`). The whole
 *   title is the work, less the Volume list ending it when the line is
 *   `packaged` (its stored `multi` or `editionLineHint`: the list is then
 *   coverage) and no name ends in that list itself. A bracket tag only the
 *   general parser calls packaging ("[Limited Edition]") stays in the work.
 * - `line`: it names exactly one more Edition Line. The work is the text
 *   before that line's name, its article ("- The Ultimate Edition") or the
 *   bracket holding it, every number and mark kept; the name, its
 *   position, a subtitle after a separator, trailing bracket tags and the
 *   stated Volume list go ("One Piece - [Omnibus] 33 - Wano" is One Piece;
 *   "Rurouni Kenshin - VIZBIG Edition [13-15]" is Rurouni Kenshin).
 *   `lineName` is the name as written, its article aside; `position` the
 *   one position the segment states, canonical ("[VIZBIG Edition] II",
 *   "[VIZBIG Edition Vol. 2]" and "[VIZBIG Edition] (Book II)" → "2"),
 *   null when it states none, states two that differ, or states one the
 *   grammar cannot read ("(Vol. ii)", "(Vol. thirty)"); a list ("VIZBIG Edition 1-3") is
 *   coverage, never a position. `tail` is the title from the line's
 *   segment on.
 * - `ambiguous`: it names two lines beyond the work's own name
 *   ("Makunouchi Deluxe [VIZBIG Edition]" with no name to own "Deluxe"),
 *   no work before its line, an unclosed bracket around it, or more words
 *   after it than a position, tags and a subtitle explain ("Alpha Omnibus
 *   Club"). Nothing may be placed by it.
 *
 * This is segmentation only: `line` says nothing of the book's coverage
 * or whether its position is right, and `single` does not make a book one
 * Volume (a GN range is packaging). `packagingOf` reads those facts. A
 * novel marker is not this reading's to judge either: `isNovelTitle` reads
 * the whole title.
 */
export type AnnLineTitle =
  | { kind: "single"; work: string }
  | { kind: "line"; work: string; lineName: string; position: string | null; tail: string }
  | { kind: "ambiguous"; reason: string };

/** `readAnnLineTitle`'s reading with the parts `packagingOf` reads further. */
type Segmented = {
  /** What the title states beside the work: the list ending it ("[13-15]") and the line's segment. */
  facts: Tail;
  /** The statements of the list ending the title alone. */
  listed: Stated[];
} & (
  | { kind: "single"; work: string }
  | {
      kind: "line";
      work: string;
      lineName: string;
      /** The line's name, tidied as the shared parser names lines ("Ultimate Edition"). */
      name: string;
      position: string | null;
      tail: string;
      /** The text inside the bracket holding the line's name, or null when unbracketed. */
      bracket: string | null;
      /** The title after the line's name, or after its bracket. */
      after: string;
    }
  | { kind: "ambiguous"; reason: string }
);

function segmentTitle(title: string, names: readonly string[], packaged: boolean): Segmented {
  const ending = titleVolumeList(title);
  // A name ending in the very list ("Number [9]") owns it: no statement.
  const stating =
    ending !== null && !names.some((name) => titleVolumeList(name)?.list === ending.list)
      ? ending
      : null;
  const facts: Tail = { positions: [], statements: [], positionUnread: false };
  if (stating !== null) readPart(stating.list, "tag", facts);
  const listed = [...facts.statements];
  const text = stating?.rest ?? title;
  const added = addedLineNames(text, names);
  const [hit] = added;
  if (hit === undefined) return { kind: "single", work: packaged ? text : title, facts, listed };
  if (added.length > 1) {
    return { kind: "ambiguous", reason: "names more than one Edition Line", facts, listed };
  }
  let start = hit.start;
  let end = hit.end;
  let nameStart = hit.name;
  let nameEnd = hit.end;
  const open = enclosingBracket(text, hit.start);
  const unclear = {
    kind: "ambiguous",
    reason: "goes on after its Edition Line in words no position explains",
    facts,
    listed,
  } as const;
  if (open !== -1) {
    const close = text.indexOf(text[open] === "[" ? "]" : ")", hit.end);
    if (close === -1)
      return { kind: "ambiguous", reason: "leaves its Edition Line's bracket open", facts, listed };
    start = open;
    end = close + 1;
    // The bracket's own words before the name belong to it ("[Side Story
    // VIZBIG Edition]"), and so do words after it with no number and no
    // marker in them; a number, a marker or a statement there is the
    // book's ("[VIZBIG Edition Vol. 2]", "[VIZBIG Edition Vol. thirty]",
    // "[VIZBIG Edition Vols. 4-6]"), never the line's name.
    if (numeric(text.slice(open + 1, hit.start))) {
      unread(facts);
    } else {
      nameStart = open + 1;
    }
    const inside = text.slice(hit.end, close);
    const states =
      numeric(inside) || designation(inside) !== null || statementCoverage(inside) !== undefined;
    if (!states) nameEnd = close;
    else if (!readTail(inside, facts)) return unclear;
  }
  const work = text
    .slice(0, start)
    .replace(/(?:\s*[,:;]|\s+[-–—])+\s*$/, "")
    .trim();
  if (work === "") {
    return { kind: "ambiguous", reason: "names no work before its Edition Line", facts, listed };
  }
  const after = text.slice(end);
  if (!readTail(after, facts)) return unclear;
  return {
    kind: "line",
    work,
    lineName: text.slice(hit.name, hit.end),
    // A binding can be part of an explicitly named Collection line.
    name: /^(?:the\s+)?(?:hardcover|paperback)\s+collection$/i.test(
      text.slice(nameStart, nameEnd).trim(),
    )
      ? text.slice(nameStart, nameEnd).trim().replace(ARTICLE, "")
      : tidyLineName(text.slice(nameStart, nameEnd)),
    position: tailPosition(facts),
    tail: text.slice(start),
    bracket: open !== -1 ? text.slice(open + 1, end - 1) : null,
    after,
    facts,
    listed,
  };
}

export function readAnnLineTitle(
  title: string,
  options: { names?: readonly string[]; packaged?: boolean } = {},
): AnnLineTitle {
  const read = segmentTitle(title, options.names ?? [], options.packaged === true);
  switch (read.kind) {
    case "single":
      return { kind: "single", work: read.work };
    case "ambiguous":
      return { kind: "ambiguous", reason: read.reason };
    case "line": {
      const { work, lineName, position, tail } = read;
      return { kind: "line", work, lineName, position, tail };
    }
  }
}

/** Bracket text that only speaks of Volumes: numbers, "Vol." and "#" markers, list joins. */
const VOLUME_STATEMENT = /^(?=.*\d)(?:[\d\s.,&+#/\-–—]|\b(?:and|vols?|volumes?)\b)+$/i;

/**
 * A line title ending in a bracketed Volume statement, as ANN writes VIZ's
 * VIZBIG Rurouni Kenshin: "Rurouni Kenshin - VIZBIG Edition [13-15]" (GN 5).
 * The title before it, and the statement, which the list grammar may not
 * read ("[1 and Vol. 3]"); null for any other title, a reissue or line tag
 * among them ("[2nd Edition]", "[3-in-1 Edition]").
 */
export function titleVolumeList(title: string): { rest: string; list: string } | null {
  const m = /^(.*?)\s*\[([^[\]]+)\]\s*$/.exec(title);
  const list = m?.[2]?.trim() ?? "";
  return m && VOLUME_STATEMENT.test(list) ? { rest: m[1]!, list } : null;
}

/** A plain word standing in for the work, so the shared parser reads only the line after it. */
const WORK_STAND_IN = "Work";

/**
 * What `packagingOf` reads: an ANN line's stored (or just parsed) title
 * and designator facts, and its release page as last fetched, of which
 * only an ok page's Title and Volume fields count.
 */
type PackagingInput = Pick<
  AnnRelease,
  "title" | "label" | "multi" | "editionLineHint" | "coverRange" | "coverageGapped"
> &
  Partial<Pick<AnnRelease, "format">> & {
    page?: { status: string; title?: string; volume?: string };
  };

/** The line's release page, when it was read: what it restates of the line. */
function currentPage(line: PackagingInput) {
  return line.page?.status === "ok" ? line.page : undefined;
}

/**
 * A release page's Volume field read as the designator it restates ("GN 2
 * / 2", "eBook 1", or a bare "33" with no format): undefined when the page
 * has none, null when it states something no designator reads ("Vol. two",
 * "２"), which is never silence.
 */
function readPageVolume(page: { volume?: string } | undefined) {
  const text = page?.volume?.trim() ?? "";
  if (text === "") return undefined;
  const read = readDesignator(text);
  if (read !== null) return read;
  return /^[\d\s.,&+/\-–—]+$/.test(text) ? { ...readCoverage(text), packaging: false } : null;
}

/**
 * Whether an ANN line is packaging (an Edition Line member, never a
 * Volume), by every signal it carries: its stored designator and title
 * flags (`multi`, `editionLineHint`, `coverageGapped`: a stored true is
 * never cleared by a fresh reading), its page's designator ("GN 1-3",
 * "Omnibus GN 1"), and its title or its page's read against the work's
 * own names (`readAnnLineTitle`): under the canonical Series those are the
 * Series' title, never an entry spelling the Series does not confirm. A
 * title adding a line the work's name does not own ("Alpha [Deluxe]" under
 * Makunouchi Deluxe, "Alpha Deluxe Edition" under Alpha) is packaging
 * whatever the entry is called. Without `names` (no work in context) the
 * titles are not read again. The mirror's backbone and slot, the page
 * pass and the Editor's placement all ask this.
 */
export function annLinePackaged(line: PackagingInput, names?: readonly string[]): boolean {
  const page = currentPage(line);
  const restated = readPageVolume(page);
  return (
    line.multi ||
    line.editionLineHint ||
    line.coverageGapped === true ||
    restated?.multi === true ||
    restated?.packaging === true ||
    (names !== undefined &&
      [line.title, page?.title].some(
        (title) => title !== undefined && readAnnLineTitle(title, { names }).kind !== "single",
      ))
  );
}

/**
 * Whether the line's ok release page still restates it: its Title spells
 * the line's title, and its Volume field reads as the line's designator
 * (format, label, single or several, list). False says only that the two
 * disagree, not which is newer: the page pass fetches the page again
 * before it judges the line, and a fresh page that still disagrees is
 * held as the disagreement it is (packagingOf), never made harmless by
 * the fetch. A persistent disagreement is fetched on the next pass;
 * continuations carry progress within their current page rather than
 * deciding it from fetch timestamps (ann.ts releasePageCandidates). Staging's
 * stored pages and lines all agreed (17,656 of 17,656 on 2026-10-05),
 * which says nothing of how many books any rule places. True without an
 * ok page: there is nothing to restate.
 */
export function pageRestatesLine(line: PackagingInput): boolean {
  const page = currentPage(line);
  if (page === undefined) return true;
  if (page.title !== undefined && textKey(page.title) !== textKey(line.title)) return false;
  const restated = readPageVolume(page);
  if (restated === undefined) return true;
  if (restated === null || restated.multi !== line.multi) return false;
  if ("format" in restated && line.format !== undefined && restated.format !== line.format)
    return false;
  if (!restated.multi) {
    const label = (text: string | undefined) => (text !== undefined ? canonicalLabel(text) : null);
    return label(restated.label) === label(line.label);
  }
  const range = (read: Pick<AnnRelease, "coverRange" | "coverageGapped">) =>
    read.coverageGapped ? "gapped" : `${read.coverRange?.from}-${read.coverRange?.to}`;
  return range(restated) === range(line);
}

/**
 * Which book an ANN line's titles name, as an Editor's placement of it is
 * reviewed (placement.ts): for its title and its ok page's Title, the
 * segmentation's kind, work and line name read against `names` (the held
 * Series' title), every number and mark of the work kept. Positions,
 * coverage and the page's Volume field are left out: a reviewed placement
 * states those itself. Two lines naming the same work and line read the
 * same; "Alpha+ [VIZBIG Edition]" after "Alpha [VIZBIG Edition]" does not.
 * A title no segmentation reads ("Alpha [Deluxe] [VIZBIG Edition]") has
 * no work or line to compare, so the whole title is its identity, spacing,
 * case and accents aside: "Beta [Deluxe] [VIZBIG Edition]" is another
 * book, though both are unclear for the same reason. Any change to such a
 * title, a number in it included, asks for the placement to be stated
 * again.
 */
export function annTitleIdentity(line: PackagingInput, names: readonly string[]): string {
  const packaged = annLinePackaged(line, names);
  const titles = [line.title, currentPage(line)?.title];
  return JSON.stringify(
    titles.map((title) => {
      if (title === undefined) return null;
      const read = segmentTitle(title, names, packaged);
      if (read.kind === "ambiguous") return [read.kind, textKey(title)];
      return read.kind === "line"
        ? [read.kind, textKey(read.work), textKey(read.name)]
        : [read.kind, textKey(read.work)];
    }),
  );
}

/** Whether two segmentations say the same: one kind, one work, one line name. */
function sameSegmentation(a: Segmented, b: Segmented): boolean {
  if (a.kind === "ambiguous" || b.kind === "ambiguous") return a.kind === b.kind;
  if (a.kind !== b.kind || textKey(a.work) !== textKey(b.work)) return false;
  return a.kind !== "line" || (b.kind === "line" && textKey(a.name) === textKey(b.name));
}

/** Whether a title's line segment, or the title itself, is a box set (the shared parser's reading). */
function boxed(title: string, read: Segmented): boolean {
  const pieces =
    read.kind !== "line"
      ? []
      : read.bracket !== null
        ? [`[${read.bracket}]`, `${read.lineName}${read.after}`]
        : [read.tail];
  return (
    parseBookTitle(title).isBox ||
    pieces.some((piece) => parseBookTitle(`${WORK_STAND_IN} ${piece}`).isBox)
  );
}

/**
 * Everything one ANN line's title, designator and current release page
 * say about its packaging, read together (`packagingOf`). `stated` is their
 * agreed coverage in the shared parser's three states (lib/bookTitle.ts
 * agreed).
 */
function readPackaging(line: PackagingInput, names: readonly string[], entry?: string) {
  const page = currentPage(line);
  // The page's Volume field restates the designator ("GN 2 / 2", "eBook
  // 1"); null when the grammar cannot read it, which is no silence.
  const restated = readPageVolume(page);
  const packaged = annLinePackaged(line, names);
  let read = segmentTitle(line.title, names, packaged);
  const retitled = page?.title !== undefined ? segmentTitle(page.title, names, packaged) : null;
  // The designator's statement, with any title list it already agreed with
  // (splitReleaseTitle stores both as one): a rejection stays rejected, and
  // so does a stored range Coverage cannot list ("6-4", "1-80"), never
  // silence.
  let stated: Stated = line.coverageGapped
    ? null
    : line.coverRange && wholeList(`${line.coverRange.from}-${line.coverRange.to}`);
  const box = boxed(line.title, read) || (retitled !== null && boxed(page!.title!, retitled));
  // A box set's segment is the bundle's name ("[Box Set - Part 1]", "[35th
  // Anniversary Box Set]"), never placed by: only its designator and a
  // list ending its title state what it holds. The page's title states its
  // own the same way, and they must agree with the line's.
  const titles = retitled === null ? [read] : [read, retitled];
  for (const title of titles) {
    for (const statement of box ? title.listed : title.facts.statements) {
      stated = agreed(stated, statement);
    }
  }
  // Every position a title states ("VIZBIG Edition 2", "[VIZBIG Edition
  // Vol. 2]", "Skip Beat! [Omnibus] (GN 12)"), then a single designator's
  // label, the line's and the page's. Two that differ say one of them
  // misnumbers the book; one the grammar cannot read ("(Vol. ii)") leaves
  // the book's place unknown.
  const positions = [
    ...titles.flatMap((title) => title.facts.positions),
    ...(!line.multi && line.label !== undefined ? [canonicalLabel(line.label)] : []),
  ];
  // A single designator whose number the grammar cannot read ("GN II",
  // "GN thirty": readCoverage), the line's or the page's, leaves the book's
  // number unknown: no title's position stands in for it. (A stored bare
  // "GN" whose title states a list no range holds reads the same; its
  // number is unknown too.)
  const unreadSingle = (read: Pick<AnnRelease, "label" | "multi" | "coverageGapped">) =>
    !read.multi && read.label === undefined && read.coverageGapped === true;
  let positionUnread = titles.some((title) => title.facts.positionUnread) || unreadSingle(line);
  let formatConflict = false;
  if (restated === null || (restated !== undefined && unreadSingle(restated))) {
    // A Volume field no designator reads: the book's number is unknown.
    stated = null;
    positionUnread = true;
  }
  if (restated) {
    formatConflict =
      "format" in restated && line.format !== undefined && restated.format !== line.format;
    // Its label is a position and its list coverage, as the line's are:
    // "33" beside "GN 97-99" is Omnibus 33 on 97–99.
    if (restated.multi) stated = agreed(stated, restated.coverRange ?? null);
    else if (restated.label !== undefined) positions.push(canonicalLabel(restated.label));
  }
  // The page titling the book as another work or another line ("Alpha+
  // [VIZBIG Edition]", "Alpha [Omnibus]") leaves it unclear which it is.
  // So does a manga entry whose own name owns a line word the work's names
  // do not ("Makunouchi Deluxe (GN 2)" from entry Makunouchi Deluxe under
  // Series Makunouchi): either the word is that name's or the line's, and
  // the entry's link may be the wrong one.
  const ambiguous = (reason: string): Segmented => ({
    kind: "ambiguous",
    reason,
    facts: read.facts,
    listed: read.listed,
  });
  const entryOwns = (title: string | undefined) =>
    title !== undefined &&
    addedLineNames(title, [entry ?? ""]).length < addedLineNames(title, names).length;
  if (retitled !== null && !sameSegmentation(read, retitled)) {
    read = ambiguous("is titled otherwise on its release page");
  } else if (entry && (entryOwns(line.title) || entryOwns(page?.title))) {
    read = ambiguous(
      `has a line word its manga entry's name ("${entry}") owns and its Series' name does not`,
    );
  }
  let name: string | null = null;
  if (read.kind === "line") {
    // The name is the recognized line's alone, never a number beside it.
    name = read.name;
  } else if (read.kind === "single") {
    // No line beyond the work's name: a vocabulary word the parser finds is
    // the name's own ("Makunouchi Deluxe (GN 1-3)" is an Omnibus); another
    // tag ("[25th Anniversary Edition]") is the parser's line, as before. A
    // multi-volume designator is an Omnibus whether or not its list reads.
    const tag = parseBookTitle(line.title).packaging?.lineName ?? null;
    const multi = line.multi || restated?.multi === true;
    name = (tag !== null && !namesEditionLine(tag) ? tag : null) ?? (multi ? "Omnibus" : null);
  }
  const positionConflict = positionUnread || new Set(positions).size > 1;
  return {
    read,
    name,
    box,
    packaged,
    stated,
    positionConflict,
    formatConflict,
    position: positions[0] ?? null,
  };
}

/** Complete source facts for reviewed own-ISBN links, including boxes without an Edition Line. */
export function annContentFacts(line: PackagingInput, names: readonly string[]) {
  const facts = readPackaging(line, names);
  return {
    coverRange: facts.stated ?? null,
    coverageGapped: facts.stated === null,
    positionConflict: facts.positionConflict,
    formatConflict: facts.formatConflict,
    position: facts.position,
    lineName: facts.box ? null : facts.name,
    title: facts.read,
  };
}

/**
 * One packaged ANN line's facts, every source read together: the stored
 * title and designator, and the release page's Title and Volume as last
 * fetched (an ok page only; a missing page or field is silence):
 *
 * - `title`: the work segmentation (`readAnnLineTitle` against `names`,
 *   the work's own: under a canonical Series its title alone; `packaged`
 *   by `annLinePackaged`). Ambiguous too when the page titles the book as
 *   another work or another line than the line's title does ("Alpha+
 *   [VIZBIG Edition]", "Alpha [Omnibus]" against "Alpha [VIZBIG
 *   Edition]"), or when `entry`, the manga entry's title, owns a line
 *   word `names` do not ("Makunouchi Deluxe (GN 2)" from entry Makunouchi
 *   Deluxe under Series Makunouchi): an entry's spelling never decides a
 *   line word, either way.
 * - `line`: its Edition Line, null exactly when `title` is ambiguous (no
 *   line is guessed then). `name` is the recognized line's name, tidied as
 *   the shared parser names lines ("Ultimate Edition" for "- The Ultimate
 *   Edition"), with any words its bracket adds that hold no number and no
 *   marker ("[Side Story VIZBIG Edition]"); a number, a marker or a
 *   statement beside it is never part of it ("[VIZBIG Edition Vol. 2]" and
 *   "[VIZBIG Edition Vol. thirty]" are VIZBIG Edition). An Omnibus for a
 *   multi-volume designator under a title adding no line. `position`: the
 *   one position the titles and the single designators' labels (the line's
 *   and the page's) agree on ("VIZBIG Edition 2", "[VIZBIG Edition Vol.
 *   2]", "[VIZBIG Edition] II", "(Book II)", "[Omnibus] (GN 12)" and "GN
 *   2" all say "2"); null when none is stated, and whenever
 *   `positionConflict` is set.
 * - `coverRange`: the Volumes every statement agrees on, or null. The
 *   statements are the designator's range ("GN 4-6", stored with any title
 *   list it agreed with), the page's ("GN 4-6 / 12"), the list ending a
 *   title ("[13-15]"), and every statement in a title's line segment: a
 *   list in its bracket ("[VIZBIG Edition Vols. 4-6]"), after its name
 *   ("VIZBIG Edition 1-3"), in a tag ("(Vols. 4-6)"), or a collect
 *   statement ("1: Includes Vols. 1-3 plus 4-6" is 1–6), each read whole.
 *   Non-null only for a range Coverage can list (lib/bookTitle.ts
 *   rangeLabels), so it never stands for a list read in part.
 * - `coverageGapped`: some statement no range holds (a gap, a dash chain,
 *   a backwards, fractional or oversized range, a statement read only in
 *   part, a stored rejection or a stored range Coverage cannot list),
 *   statements that disagree (the page's "GN 4-6" against the line's "GN
 *   1-3"), a page Volume field no designator reads, or a number in the
 *   segment read as neither position nor coverage ("(Part 2)"). Never
 *   sized from the line's name then.
 * - `positionConflict`: the titles' positions and the designators' labels
 *   do not all agree ("VIZBIG Edition 2" at "GN 1", "[VIZBIG Edition] (Vol.
 *   II)" at "GN 1", the page's "GN 2" against the line's "GN 1"), or a
 *   title states a position the grammar cannot read ("(Vol. ii)", "(Vol.
 *   two)", "(Vol. thirty)", "(Vol. ２)", "(Vol. n/a)", "VIZBIG Edition
 *   Two"), or a number read as neither, or the page's Volume field is
 *   unread. A designator's range is coverage, never a conflicting
 *   position, and so is any list in a title. A page total ("GN 2 / 2")
 *   never stands for its number.
 * - `formatConflict`: the page's Volume field names another format than
 *   the line ("eBook 1" for a GN line). No format is chosen then.
 *
 * Every number or marker a segment holds is read as one of these or held:
 * a reissue or binding tag ("[2nd Edition]", "(Hardcover)") and words with
 * no number and no marker are the only text it passes over. `kind: "line"`
 * remains segmentation; only these fields speak of contents and place.
 *
 * Null for a box set (a bundle, never a line), for a line that is not
 * packaging (`annLinePackaged`), and for one whose title adds no line and
 * whose designators are no range ("(Omnibus GN 1)" beside a plain title).
 * Pure: the page pass, the Editor's placement Draft and splitReleaseTitle
 * read the same facts.
 */
export type AnnPackaging = {
  coverRange: CoverRange | null;
  coverageGapped: boolean;
  positionConflict: boolean;
  formatConflict: boolean;
} & (
  | { title: Extract<AnnLineTitle, { kind: "ambiguous" }>; line: null }
  | {
      title: Exclude<AnnLineTitle, { kind: "ambiguous" }>;
      line: { name: string; position: string | null };
    }
);

export function packagingOf(
  line: PackagingInput,
  names: readonly string[] = [],
  entry?: string,
): AnnPackaging | null {
  const { read, name, box, packaged, stated, positionConflict, formatConflict, position } =
    readPackaging(line, names, entry);
  if (box || !packaged) return null;
  const facts = {
    coverRange: stated ?? null,
    coverageGapped: stated === null,
    positionConflict,
    formatConflict,
  };
  if (read.kind === "ambiguous") {
    return { ...facts, title: { kind: "ambiguous", reason: read.reason }, line: null };
  }
  if (name === null) return null;
  const title: Exclude<AnnLineTitle, { kind: "ambiguous" }> =
    read.kind === "single"
      ? { kind: "single", work: read.work }
      : {
          kind: "line",
          work: read.work,
          lineName: read.lineName,
          position: read.position,
          tail: read.tail,
        };
  return { ...facts, title, line: { name, position: positionConflict ? null : position } };
}

/**
 * The agreed coverage `packagingOf` reads, in the snapshot's stored shape:
 * for box sets and line-less titles too, which it returns no line for.
 */
function statedCoverage(
  line: PackagingInput,
  names: readonly string[],
): Pick<AnnRelease, "coverRange" | "coverageGapped"> {
  const { stated } = readPackaging(line, names);
  return stated === null ? { coverageGapped: true } : { coverRange: stated };
}

// The format markers: GN/OGN and "graphic novel" are print, eBook digital.
// A designator's coverage follows its first marker; anything before it ("2nd
// Edition", "3-in-1 Edition", "Omnibus") is never coverage.
const EBOOK_MARKER = /\be-?book\b/i;
const PRINT_MARKERS = [/\bO?GN\b/, /graphic novels?/i];
/**
 * A qualifier between the marker and its number: "GN box 2", "eBook ex 3".
 * The parser keeps reading "ex N" as N so stored lines stay as imported;
 * decisions ask `designatesExtra` and never take that N for a Volume.
 */
const QUALIFIER = /^\s*(?:box(?:ed)?(?:\s+set)?|ex)\b/i;

/**
 * Whether a designator numbers an extra chapter ("eBook ex 1": Yen Press's
 * Handa-kun Extra Chapter 1), never the whole Volume its number names.
 */
export function designatesExtra(designator: string | undefined): boolean {
  return designator !== undefined && /\b(?:e-?book|O?GN)\s+ex\b/i.test(designator);
}

/** ANN's "[NOOK]": the store that listed an ebook ISBN, not an edition or package. */
const STOREFRONT_TAG = /\s+\[NOOK\]$/i;
const BRACKETED_TEXT = /[[\]]/;

/**
 * The line's title without its storefront tag, or null when the tag is
 * absent or cannot be read as one: only a digital line whose ok page
 * restates the same title with an eBook designator. A physical "[NOOK]"
 * line keeps the bracket, so it still reads as packaging.
 */
export function storefrontTitle(line: PackagingInput): string | null {
  const page = currentPage(line);
  const bare = line.title.replace(STOREFRONT_TAG, "");
  if (
    bare === line.title ||
    BRACKETED_TEXT.test(bare) ||
    line.format !== "digital" ||
    !page ||
    page.title !== line.title ||
    readDesignator(page.volume ?? "")?.format !== "digital"
  )
    return null;
  return bare;
}
/** The release page's "of N" total after the coverage: "GN 4 / 8". */
const TOTAL = /\s*\/\s*\d+\s*$/;
/** One Volume, with a letter it may carry: "GN 1A" is Volume 1. */
const SINGLE = /^(\d+(?:\.\d+)?)[a-z]?$/i;

/**
 * The one payload a marker may carry that is no number and still no
 * statement of one: "GN A", ANN's letter for an unnumbered book (pinned by
 * the parser's tests; staging's 17,656 pages carry none, only a bare "GN"
 * or "eBook").
 */
const UNNUMBERED = /^a$/i;

/**
 * What a designator says after its marker, qualifier and total are taken
 * off. Nothing ("GN") or the unnumbered letter ("GN A") is an unnumbered
 * book; one number a label. Any other payload with no ASCII digit in it
 * ("GN II", "GN thirty", "GN n/a", "GN -", "GN Vol. two", "GN ２") states a
 * number the grammar cannot read: a single book whose number is unread,
 * stored as no label with `coverageGapped`, so no title's position or
 * line size ever stands in for it (packagingOf). Upper-case Romans are not
 * read here: "GN M" or "GN C" would be a Volume 1000 or 100 nobody wrote.
 * Anything else is a list, read whole (`wholeList`, the rule every list a
 * line states is read by): a range or contiguous list ("97-99", "1, 2, 3",
 * "1 & 2") is multi-volume with that range. One no range holds is
 * multi-volume with `coverageGapped` and neither label nor range: a gap
 * ("1, 3", "1, 2, and 4", "1 and Vol. 3"), a numbered extra ("1-2 + 3"), a
 * dash chain, a number smaller than the one before it ("3-1", "1-5, 6-2"),
 * a fraction or more Volumes than Coverage lists ("1.5-3.5", "1-80"), or
 * text the grammar does not read ("3 Part 1-2"). Its first numbers are
 * never read as a shorter list or a label.
 */
function readCoverage(
  afterMarker: string,
): Pick<AnnRelease, "label" | "multi" | "coverRange" | "coverageGapped"> {
  const text = afterMarker.replace(QUALIFIER, "").replace(TOTAL, "").trim();
  if (text === "" || UNNUMBERED.test(text)) return { label: undefined, multi: false };
  if (!/\d/.test(text)) return { label: undefined, multi: false, coverageGapped: true };
  const single = SINGLE.exec(text)?.[1];
  if (single !== undefined) return { label: single, multi: false };
  const range = wholeList(text);
  return range
    ? { label: undefined, multi: true, coverRange: range }
    : { label: undefined, multi: true, coverageGapped: true };
}

/**
 * One designator read ("GN 14", "Omnibus GN 1-3", "eBook 2 / 4"): its
 * format, whether it names packaging, and its coverage (`readCoverage`).
 * Null when it is no book's: no format marker ("Vol. 2", a DVD), or a
 * chapter ("eBook ch 17"). A line's own designator and its release page's
 * Volume field are read by this one rule.
 */
function readDesignator(
  designator: string,
): (ReturnType<typeof readCoverage> & Pick<AnnRelease, "format"> & { packaging: boolean }) | null {
  const marker = [EBOOK_MARKER, ...PRINT_MARKERS]
    .map((re) => re.exec(designator))
    .filter((match) => match !== null)
    .sort((a, b) => a.index - b.index)[0];
  if (marker === undefined) return null;
  if (/\bch(?:apter)?\.?\s*\d/i.test(designator)) return null;
  return {
    format: EBOOK_MARKER.test(designator) ? "digital" : "physical",
    packaging: DESIGNATOR_PACKAGING.test(designator),
    ...readCoverage(designator.slice(marker.index + marker[0].length)),
  };
}

/**
 * Split one release line's text: "Frieren: Beyond Journey's End (GN 14)" →
 * title + label + format. The designator is the line's last parenthesised
 * group, so a year or edition in the title's own parentheses is never read.
 * GN/OGN designators are print, eBook digital; omnibus/box-set designators,
 * and an Edition Line name in the title ("Vagabond [VIZBIG Edition]"), flag
 * Edition Line packaging. What follows the first format marker is the
 * coverage (`readCoverage`), and so is a packaged line's list ending its
 * title ("[13-15]"), which must agree with the designator's. Returns null
 * for lines that are not book releases (DVDs and other designators ANN
 * mixes into other media types) and for single chapters ("eBook ch 17") —
 * chapters are never Volumes.
 * `entryName` (the manga's own title) lets packaging words in the line
 * title count only when they are part of the series name that opens the
 * title (`readAnnLineTitle`). The stored flag is this context's reading
 * only: under a canonical Series, `annLinePackaged` reads the title again
 * against the Series' own title, and never clears a stored true.
 */
export function splitReleaseTitle(
  text: string,
  entryName = "",
): Omit<AnnRelease, "annId" | "date" | "isbn13"> | null {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text.trim());
  if (!m) return null;
  const title = m[1]!.trim();
  const designator = m[2]!.trim();
  if (title === "") return null;
  const read = readDesignator(designator);
  if (read === null) return null;
  const { format, packaging, label, multi, ...designated } = read;
  const editionLineHint =
    packaging || readAnnLineTitle(title, { names: [entryName] }).kind !== "single";
  // A packaged title's own statements say what the book collects too, and
  // must agree with the designator's (packagingOf): "Rurouni Kenshin -
  // VIZBIG Edition [13-15]" (GN 5) is 13–15, and so is "Alpha [VIZBIG
  // Edition Vols. 4-6]" (GN 1). Anything else holds the line
  // (`coverageGapped`), never sized from its line's name: a statement the
  // grammar does not read as a range ("[1, 3]", "Includes Vols. 1 & 3",
  // "[1 and Vol. 3]"), or one that differs from the designator's own list
  // ("Alpha [4-6]" at GN 1-3).
  const { coverRange, coverageGapped } =
    editionLineHint || multi
      ? statedCoverage({ title, label, multi, editionLineHint, ...designated }, [entryName])
      : designated;
  return {
    title,
    label,
    multi,
    format,
    editionLineHint,
    ...(coverRange ? { coverRange } : {}),
    ...(coverageGapped ? { coverageGapped } : {}),
  };
}

// ---------- manga records ----------

/**
 * One parsed manga entry: its snapshot before `toSnapshot` adds the identity
 * fields, with every credit row and the rating as a plain flag.
 */
export type AnnManga = Omit<AnnMangaSnapshot, "kind" | "url" | "credits" | "mature"> & {
  credits: AnnCredit[];
  mature: boolean;
};

/**
 * Does an entry's body rate it for adults? ANN's "Objectionable content"
 * is AA (all ages), OC (older children), TA (teens), MA (mature) or AO
 * (adults only); an erotica or hentai genre/theme says the same. Most
 * entries carry no rating at all, so its absence proves nothing.
 */
export function isMatureEntry(body: string): boolean {
  const rating = /<info[^>]*type="Objectionable content"[^>]*>\s*([A-Z]+)\s*<\/info>/.exec(
    body,
  )?.[1];
  if (rating === "MA" || rating === "AO") return true;
  return /<info[^>]*type="(?:Genres|Themes)"[^>]*>\s*(?:erotica|hentai)\s*<\/info>/i.test(body);
}

function parseReleases(body: string, entryName: string, mangaId: string): AnnRelease[] {
  const releases: AnnRelease[] = [];
  for (const m of body.matchAll(/<release\s+([^>]*)>([\s\S]*?)<\/release>/g)) {
    const attrs = m[1]!;
    const text = decodeEntities(m[2]!).trim();
    const split = splitReleaseTitle(text, entryName);
    if (!split) continue;
    const dateAttr = /date="([^"]*)"/.exec(attrs)?.[1];
    const href = /href="([^"]*)"/.exec(attrs)?.[1];
    const annId = href !== undefined ? /[?&]id=(\d+)/.exec(href)?.[1] : undefined;
    const isbn13 = toIsbn13(/\bean="([^"]*)"/.exec(attrs)?.[1]);
    releases.push({
      // Scope fallback identities to the manga and full designator so unrelated
      // entries and different omnibus ranges cannot overwrite one observation.
      annId:
        annId ??
        `${mangaId}:${split.format}:${encodeURIComponent(text)}:${isbn13 ?? dateAttr ?? ""}`,
      date: dateAttr !== undefined ? parseAnnDate(dateAttr) : undefined,
      title: split.title,
      label: split.label,
      multi: split.multi,
      format: split.format,
      editionLineHint: split.editionLineHint,
      ...(isbn13 !== undefined ? { isbn13 } : {}),
      ...(split.coverRange ? { coverRange: split.coverRange } : {}),
      ...(split.coverageGapped ? { coverageGapped: true } : {}),
    });
  }
  return releases;
}

/** Alt-title languages worth keeping for search (English + Japanese forms). */
const ALT_TITLE_LANGS = /^(EN|JA)/i;
const MAX_ALT_TITLES = 12;

/**
 * One api.xml batch response → its manga records. Tolerant: `<warning>`
 * elements ("no result for manga=…") and malformed blocks are skipped. The
 * title is the Main title, or the block's `name` attribute when that is
 * absent or empty after cleaning. The Plot Summary is decoded before tags
 * are stripped: ANN's XML escapes the text (sometimes twice).
 */
export function parseApiResponse(xml: string): AnnManga[] {
  const records: AnnManga[] = [];
  for (const m of xml.matchAll(/<manga\s+([^>]*)>([\s\S]*?)<\/manga>/g)) {
    const attrs = m[1]!;
    const body = m[2]!;
    const id = /\bid="(\d+)"/.exec(attrs)?.[1];
    if (id === undefined) continue;

    const mainTitle = /<info[^>]*type="Main title"[^>]*>([\s\S]*?)<\/info>/.exec(body)?.[1];
    const nameAttr = /\bname="([^"]*)"/.exec(attrs)?.[1];
    const title = cleanTitleText(mainTitle ?? "") || cleanTitleText(nameAttr ?? "");
    if (title === "") continue;

    const altTitles: string[] = [];
    for (const alt of body.matchAll(
      /<info[^>]*type="Alternative title"[^>]*lang="([^"]*)"[^>]*>([\s\S]*?)<\/info>/g,
    )) {
      if (!ALT_TITLE_LANGS.test(alt[1]!)) continue;
      const value = cleanTitleText(alt[2]!);
      if (value !== "" && value !== title && !altTitles.includes(value)) {
        altTitles.push(value);
      }
      if (altTitles.length >= MAX_ALT_TITLES) break;
    }

    const staff: string[] = [];
    for (const person of body.matchAll(/<person[^>]*>([\s\S]*?)<\/person>/g)) {
      const name = cleanTitleText(person[1]!);
      if (name !== "" && !staff.includes(name)) staff.push(name);
    }
    // The same rows with their task and ANN's stable person id, which is
    // what identifies an author across entries and spellings.
    const credits: AnnCredit[] = [];
    for (const row of body.matchAll(
      /<staff[^>]*>\s*<task>([\s\S]*?)<\/task>\s*<person[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/person>/g,
    )) {
      const name = cleanTitleText(row[3]!);
      const task = decodeEntities(row[1]!).trim();
      if (name !== "" && task !== "") credits.push({ personId: row[2]!, name, task });
    }

    const plot = /<info[^>]*type="Plot Summary"[^>]*>([\s\S]*?)<\/info>/.exec(body)?.[1];

    records.push({
      id,
      title,
      altTitles,
      synopsis: plot !== undefined ? cleanBlurb(decodeEntities(plot)) : undefined,
      staff,
      credits,
      mature: isMatureEntry(body),
      releases: parseReleases(body, title, id),
    });
  }
  return records;
}

// ---------- release pages ----------

/**
 * What one Encyclopedia release page (`releases.php?id=NNN`) adds to its
 * API line: the Distributor — the publisher a Release needs — plus the
 * page's own ISBNs, date, suggested retail price, and Description. Stored
 * on the line's observation as `page` (the fetch state that keeps the pass
 * incremental).
 */
export const annReleasePageValidator = v.object({
  title: v.optional(v.string()),
  /** The designator as the page shows it ("GN 2 / 2", "eBook 1"). */
  volume: v.optional(v.string()),
  distributor: v.optional(v.string()),
  /** ANN's company id for the distributor (company.php?id=N). */
  distributorId: v.optional(v.string()),
  date: v.optional(datePartsValidator),
  isbn13: v.optional(v.string()),
  isbn10: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  /** The manga entry the page belongs to. */
  mangaId: v.optional(v.string()),
  /** The book's blurb (publisher copy an ANN contributor entered), cleaned. */
  description: v.optional(v.string()),
});
export type AnnReleasePage = Infer<typeof annReleasePageValidator>;

/** One labelled field's raw HTML: `<b>Label:</b> …` up to the next break. */
function pageField(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<b>${escaped}:</b>([\\s\\S]*?)(?:<br\\s*/?>|</p>|<p\\b)`, "i").exec(html)?.[1];
}

/**
 * ANN's own next field after the Description (`<p class="easyread-width">
 * <b>Notes:</b>`). Only that class: a description's own bold-label
 * paragraph (`<p><b>Bonus Features:</b> …`) is copy, not a field.
 */
const NEXT_FIELD = /<p class="easyread-width">\s*<b>[^<]{1,40}:<\/b>/i;
/** The `<p><small>(added on …, modified on …)</small></p>` after a page's fields. */
const ADDED_ON = /<p>\s*<small>\s*\(added on\b/i;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

// Site chrome ANN renders inside the Description field itself: a page with
// no description carries only its review link there
// (`<a href="0/0/reviews/new">Submit your own review of this item.</a>`).
const REVIEW_LINK = /<a\b[^>]*\breviews\/new\b[^>]*>[\s\S]*?<\/a>/gi;
const CHROME = ["Submit your own review of this item."];

// Retail and listing rows ANN contributors pasted in place of a blurb. Only
// a description that is wholly one of these is rejected; nothing judges
// blurb quality otherwise.
const NOT_A_BLURB = [
  // A seller's condition notes, whole.
  /^Book is in like-new condition\.$/,
  /^Book is in excellent condition\.\.It may has been previously used\b[\s\S]*\bAll orders ship with tracking\b[\s\S]*$/,
  /^Will ship out as soon as we stock th$/,
  /^Find, shop, and buy\b[\s\S]*\bat Buy\.com\.?$/i,
  /^Retail Price: \$[\d.]+ No Longer Available For Purchase(?: Free [\w ]+ Shipping @ \$\d+)*$/,
  /^Publisher - [^-]+ Genre - [\s\S]+ Media - Printed Material\b[\s\S]*\bProduct Availability - [\s\S]*$/,
  // "Book by Buronson", "Book by Takaya, Yoshiki": capitalized names only.
  /^Book by \p{Lu}[\p{L}'-]*(?:,? \p{Lu}[\p{L}'-]*){0,2}$/u,
  /^Language:English\./,
  /^No further information has been provided for this title\.?$/i,
  /^(?:science fiction|fantasy|horror|romance|comedy|drama|action|mystery)\.?$/i,
  /^OVERSIZED GRAPHIC NOVEL$/,
  /^Manga trade style comic\.?$/i,
  /^\(\d+(?:st|nd|rd|th) Ed\)$/,
];

// The credit ANN appends to publisher copy ("… a friend or a foe? Story
// and art by Eiichiro Oda."): the byline already shows it. Its shapes:
// "Story and art by X.", "Story by X and Art by Y.", "Story and art by X
// and Original Concept by Y.", "Manga by X and original story by Y.",
// "Originally written by X, adapted by Y.", "Story by X. Art by Y.". A
// credit tail is one or more clauses ROLE by NAMES, joined by "and", a
// comma or a sentence break, running to the very end of the text.
const CREDIT_ROLES = [
  // ANN's own typos.
  "sotyr and art",
  "story and and art",
  "written and art",
  "written and illustrated",
  "written & illustrated",
  "story and art",
  "story & art",
  "art and story",
  "originally written",
  "original story",
  "original concept",
  "original creator",
  "original work",
  "character designs",
  "character design",
  "story",
  "art",
  "artwork",
  "written",
  "illustrated",
  "illustrations",
  "created",
  "script",
  "manga",
  "adapted",
  "concept",
].map((role) => role.split(" "));
/** A name word: it starts with a capital or digit ("Oh!Great", "Sho-u", "RAN", "(Studio"). */
const NAME_WORD = /^\(?[\p{Lu}\d]\S*$/u;
/**
 * Lower-case name words ANN's contributors wrote in a credit that is a
 * sentence of its own ("Story by ufotable and Art by tartan check.",
 * "Story and art by est em.", "atsushi Suzumi", "Oh! great", "Girls und
 * Panzer Projekt"). An explicit list because no rule tells "tartan check"
 * from "pure accident", and a constructed sentence ("Created by pure
 * accident.", "Script by day, art by night.") must stay. Extend it when a
 * new page needs a word.
 */
const LOWERCASE_NAME_WORDS = new Set([
  "atsushi",
  "check",
  "em",
  "est",
  "great",
  "tartan",
  "ufotable",
  "und",
]);
const MAX_LOOSE_NAME_WORDS = 5;
const NAME_JOINERS = new Set(["and", "&", "with", "/"]);
const SENTENCE_END = /[.!?…"”’)]$/;
const MAX_CLAUSES = 4;
const MAX_NAME_WORDS = 8;

/**
 * Words in a credit role starting at `at`, then "by" (repeats allowed: "by
 * by"); 0 when none. An ALL-CAPS role ("CREATED BY ACCIDENT, …") is a
 * shouted sentence, never ANN's credit.
 */
function creditRoleAt(words: string[], at: number): number {
  if (/^[A-Z]{2,}$/.test(words[at] ?? "")) return 0;
  for (const role of CREDIT_ROLES) {
    if (!role.every((part, k) => words[at + k]?.toLowerCase() === part)) continue;
    let end = at + role.length;
    if (words[end]?.toLowerCase() !== "by") continue;
    while (words[end]?.toLowerCase() === "by") end++;
    return end - at;
  }
  return 0;
}

type CreditClause = {
  role: string;
  names: number;
  /** Some name word is lower case (only in a `loose` tail). */
  lower: boolean;
};

/**
 * The clauses of words[start..] when it is nothing but credit clauses:
 * ROLE by NAMES (and ROLE by NAMES)*; null otherwise. `loose` (a credit
 * that is a sentence of its own) also takes the known lower-case name
 * words (`LOWERCASE_NAME_WORDS`), at most MAX_LOOSE_NAME_WORDS a clause.
 */
function creditTail(words: string[], start: number, loose = false): CreditClause[] | null {
  const clauses: CreditClause[] = [];
  let at = start;
  for (let clause = 0; clause < MAX_CLAUSES; clause++) {
    const role = creditRoleAt(words, at);
    if (role === 0) return null;
    const current = {
      role: words
        .slice(at, at + role)
        .join(" ")
        .toLowerCase(),
      names: 0,
      lower: false,
    };
    clauses.push(current);
    at += role;
    // ANN's doubled prefix: "Story and art by Written by Koji Kumeta."
    for (let again = creditRoleAt(words, at); again > 0; again = creditRoleAt(words, at))
      at += again;
    for (;;) {
      const word = words[at];
      if (word === undefined) return null;
      const bare = word.replace(/[.,;:!?]+$/, "");
      const strict = NAME_WORD.test(bare);
      const lax = loose && LOWERCASE_NAME_WORDS.has(bare);
      if (!strict && !lax) return null;
      if (!strict) current.lower = true;
      if (++current.names > (current.lower ? MAX_LOOSE_NAME_WORDS : MAX_NAME_WORDS)) return null;
      at++;
      if (at === words.length) return clauses;
      const next = words[at]!;
      // "… and Art by Y": the joiner opens the next clause.
      if (NAME_JOINERS.has(next.toLowerCase()) && creditRoleAt(words, at + 1) > 0) {
        at++;
        break;
      }
      // "X, adapted by Y" / "X. Art by Y" / "X Art by Y".
      if (creditRoleAt(words, at) > 0) break;
      // A sentence ended inside the names: the credit is over, and what
      // follows is copy ("Story by X. Romance between …"). Only an initial
      // ("J. K.") or a name with a bang before its last word ("Oh! great.")
      // goes on.
      if (
        /[.!?]$/.test(word) &&
        !/^\p{L}\.$/u.test(word) &&
        !(word.endsWith("!") && at === words.length - 1)
      ) {
        return null;
      }
      // "X and Y", "X & Y": the list goes on.
      if (NAME_JOINERS.has(next.toLowerCase())) at++;
    }
  }
  return null;
}

/** ANN's own fused role: "Story and art by", "Story & art by" (and its typos). */
function isStoryAndArt(clause: CreditClause): boolean {
  return /^(?:story|sotyr) (?:and|&)(?: and)? art by/.test(clause.role);
}

/** Whether words are a bare list of names ("Kazuo Koike", "X & Y"). */
function isNameList(words: string[]): boolean {
  return (
    words.length > 0 &&
    words.length <= MAX_NAME_WORDS &&
    words.every(
      (w) => NAME_WORD.test(w.replace(/[.,;:!?]+$/, "")) || NAME_JOINERS.has(w.toLowerCase()),
    )
  );
}

// ANN's own typo: "Story and Kazuo Koike and Art by Goseki Kojima." ("and"
// for "by").
const STORY_AND_TYPO = /^Story and (.+?) and Art by (.+)$/;

/**
 * Drop a trailing credit tail (`creditTail`). It must start a sentence
 * (the start of the text, or after . ! ? … or a closing quote or bracket),
 * except a capitalized "Story and art by …" / "Story & art by …" glued to
 * the text before it. Anything else mid-sentence is prose, however many
 * clauses it has: "Based on the series created by Jon Favreau and written
 * by Dave Filoni." and "Created by Masashi Kishimoto and features story by
 * …" stay whole. A single clause naming one word ("Created by God.", "Art
 * by Committee.") is kept unless its role is ANN's fused "Story and art",
 * the only role ANN gives one-word names ("Story and art by CLAMP.").
 */
function stripCreditTail(text: string): string {
  const words = text.split(" ");
  for (let at = 0; at < words.length; at++) {
    const opensSentence = at === 0 || SENTENCE_END.test(words[at - 1]!);
    const typo = opensSentence ? STORY_AND_TYPO.exec(words.slice(at).join(" ")) : null;
    if (typo && isNameList(typo[1]!.split(" ")) && isNameList(typo[2]!.split(" "))) {
      return words.slice(0, at).join(" ");
    }
    if (creditRoleAt(words, at) === 0) continue;
    // A credit that is a sentence of its own may name people in any case.
    const clauses = creditTail(words, at, opensSentence);
    if (clauses === null) continue;
    const glued = words[at] === "Story" && isStoryAndArt(clauses[0]!);
    if (!opensSentence && !glued) continue;
    const [first] = clauses;
    // One name word: only ANN's fused "Story and art by CLAMP.", and only
    // a capitalized one ("Story and art by everyone." is prose).
    if (clauses.length === 1 && first!.names === 1 && (!isStoryAndArt(first!) || first!.lower))
      continue;
    return words.slice(0, at).join(" ");
  }
  return text;
}

/**
 * Drop ANN's fused credit when it opens the text instead ("Story and art
 * by Taeko Watanabe. Romance between …"): only "Story and art by" /
 * "Story & art by", then one to four capitalized names with no initials,
 * the last one closing the sentence, and copy after it.
 */
function stripLeadingCredit(text: string): string {
  const words = text.split(" ");
  const role = creditRoleAt(words, 0);
  if (role === 0 || !/^Story (?:and|&) art by$/i.test(words.slice(0, role).join(" "))) return text;
  for (let at = role; at < role + 4 && at < words.length - 1; at++) {
    const word = words[at]!;
    if (!NAME_WORD.test(word.replace(/[.!]+$/, ""))) return text;
    if (!word.endsWith(".")) continue;
    // A one-letter initial ("J.") is not the end of the names.
    if (/^\p{L}\.$/u.test(word)) return text;
    return words.slice(at + 1).join(" ");
  }
  return text;
}

// ANN's own release notes some contributors append after the copy
// ("… Notes: Originally scheduled for 2006-07-31."): not the publisher's.
// Dropped when the note is about the release itself (it starts with a
// capital and talks of ISBNs, printings, schedules, recalls, volumes, or
// its format and reading direction: "Published in left-to-right "flipped"
// format.") or follows a credit tail; "Notes: none of this is what it
// seems." stays. On the page the notes are a field of their own
// (`<b>Notes:</b>`), which `pageDescription` stops before; this catches
// text stored before it did.
const NOTES_TAIL = /([.!?…"”’)])\s+Notes:\s([\s\S]*)$/;
const ANN_NOTE =
  /^[A-Z][\s\S]*\b(?:ISBN|release[sd]?|reprint(?:ed)?|printing|edition|volume|scheduled|recalled|misprint|cover|format|flipped|left-to-right|right-to-left)\b/i;

/** Drop ANN's trailing "Notes:" section when it is ANN's note (see NOTES_TAIL). */
function stripNotesTail(text: string): string {
  const notes = NOTES_TAIL.exec(text);
  if (!notes) return text;
  const before = text.slice(0, notes.index + notes[1]!.length);
  return ANN_NOTE.test(notes[2]!) || stripCreditTail(before) !== before ? before : text;
}

/**
 * The cleaner every ANN release-page description goes through, at parse
 * time and again on stored text (`ann:repairDescriptions`), so it must be
 * idempotent. Undefined when nothing of the publisher's copy remains.
 */
export function cleanAnnDescription(text: string): string | undefined {
  // Mojibake first: its runs carry C1 code points ("â€\u009d") that the
  // C1 mapping would otherwise turn into the wrong characters.
  let out = mapC1Controls(repairMojibake(text.replace(ZERO_WIDTH, "")));
  // Entities ANN escaped once more than the parser decodes ("&gt;"), its
  // typo "&qout;", and a "<p>" typed as ",p>" in front of a paragraph.
  out = decodeEntities(out.replace(/&qout;/g, "&quot;")).replace(/ ?,p>(?=\S)/g, " ");
  for (const chrome of CHROME) out = out.split(chrome).join(" ");
  out = out
    .replace(/\s+/g, " ")
    .trim()
    // A stray space between a name and the closing stop ("Kei Toume .");
    // a spaced ellipsis (". . .") is left alone.
    .replace(/(\p{L}) ([.!?])$/u, "$1$2")
    // A credit glued to the stop before it ("volume.Story and art by").
    .replace(/([a-z][.!?])(?=Story (?:and|&) art by )/g, "$1 ");
  out = stripNotesTail(out);
  out = stripCreditTail(stripLeadingCredit(out)).trim();
  if (NOT_A_BLURB.some((junk) => junk.test(out))) return undefined;
  return out === "" ? undefined : out;
}

/**
 * The page's Description, cleaned to one paragraph. It opens with a `<br>`
 * and spans paragraphs, so `pageField` cannot read it. It comes in two
 * shapes: older pages run the text inline
 * (`<b>Description:</b><br>Text<br>\n<br>More</p>`), newer ones close the
 * paragraph and carry it in `<div class="simple-html">Text</div>`. The
 * field ends at ANN's next field (`NEXT_FIELD`, its Notes) or the "added
 * on" trailer, whichever comes first, so markup inside the text (a list,
 * an inline `<small>`, a bold "Bonus Features:" paragraph, a nested div)
 * never cuts it short: the div runs to its last `</div>`, inline text to
 * its closing `</p>`. Without either bound both stop at the first close.
 */
function pageDescription(html: string): string | undefined {
  const label = /<b>Description:<\/b>/i.exec(html);
  if (!label) return undefined;
  const rest = html.slice(label.index + label[0].length);
  const ends = [rest.search(NEXT_FIELD), rest.search(ADDED_ON)].filter((at) => at >= 0);
  const bounded = ends.length > 0;
  const field = (bounded ? rest.slice(0, Math.min(...ends)) : rest).replace(REVIEW_LINK, "");
  const div = (
    bounded
      ? /^\s*(?:<br\s*\/?>)?\s*<\/p>\s*<div class="simple-html">([\s\S]*)<\/div>/i
      : /^\s*(?:<br\s*\/?>)?\s*<\/p>\s*<div class="simple-html">([\s\S]*?)<\/div>/i
  ).exec(field)?.[1];
  const inline = bounded
    ? field.replace(/<\/p>\s*$/i, "")
    : (/^([\s\S]*?)<\/p>/i.exec(field)?.[1] ?? "");
  const text = cleanBlurb(div ?? inline);
  return text !== undefined ? cleanAnnDescription(text) : undefined;
}

/**
 * One release page's HTML → its fields, or null when the page is not a
 * release (no "Title:" field — ANN's not-found page, a login wall).
 */
export function parseReleasePage(html: string): AnnReleasePage | null {
  const titleHtml = pageField(html, "Title");
  if (titleHtml === undefined) return null;
  const text = (raw: string | undefined) =>
    raw !== undefined ? cleanTitleText(stripHtml(raw)) || undefined : undefined;

  const distributorHtml = pageField(html, "Distributor");
  const distributorId =
    distributorHtml !== undefined ? /company\.php\?id=(\d+)/.exec(distributorHtml)?.[1] : undefined;
  const dateText = text(pageField(html, "Release date"));
  const price = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(
    pageField(html, "Suggested retail price") ?? "",
  )?.[1];
  // The ISBN spans spell the number out in parts, then repeat it whole in
  // a hidden span: the first valid 13/10-digit run is the ISBN.
  const isbnIn = (label: string, width: 10 | 13) => {
    const raw = stripHtml(pageField(html, label) ?? "").replace(/\s+/g, " ");
    const runs = raw.match(width === 13 ? /\d{13}/g : /\d{9}[\dX]/g) ?? [];
    return runs.find((run) => toIsbn13(run) !== undefined);
  };
  const isbn10 = isbnIn("ISBN-10", 10);
  const isbn13 = toIsbn13(isbnIn("ISBN-13", 13)) ?? toIsbn13(isbn10);

  return {
    title: text(titleHtml),
    volume: text(pageField(html, "Volume")),
    distributor: text(distributorHtml),
    distributorId,
    date: dateText !== undefined ? parseAnnDate(dateText) : undefined,
    isbn13,
    isbn10: isbn10 !== undefined && toIsbn13(isbn10) === isbn13 ? isbn10 : undefined,
    priceCents: price !== undefined ? Math.round(Number(price) * 100) : undefined,
    // The entry link under the release ("Encyclopedia information about"),
    // not whatever manga the site chrome happens to link.
    mangaId: /Encyclopedia information about[\s\S]{0,200}?manga\.php\?id=(\d+)/.exec(html)?.[1],
    description: pageDescription(html),
  };
}

// ---------- URLs & snapshots ----------

/** The Encyclopedia entry URL — ANN's license asks for exactly this linkback. */
export function mangaUrl(id: string): string {
  return `https://www.animenewsnetwork.com/encyclopedia/manga.php?id=${id}`;
}

/** The per-release Encyclopedia URL for release-level citations. */
export function releaseUrl(annId: string): string {
  return `https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${annId}`;
}

export function toSnapshot({ mature, ...manga }: AnnManga): AnnMangaSnapshot {
  return {
    kind: "annManga",
    url: mangaUrl(manga.id),
    ...manga,
    ...(mature ? { mature: true as const } : {}),
  };
}
