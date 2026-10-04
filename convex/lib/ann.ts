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
import { coverRangeValidator, parseVolumeList } from "./bookTitle";
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
  /** Omnibus/box-set/deluxe packaging — an Edition Line shape. */
  editionLineHint: v.boolean(),
  /** The line's ISBN-13 (from ANN's `ean` attribute), when valid. */
  isbn13: v.optional(v.string()),
  /** The Volumes a "(GN 97-99)" or "(GN 1, 2, 3)" designator says the book collects. */
  coverRange: v.optional(coverRangeValidator),
  /**
   * The designator lists Volumes no range holds: a gap ("GN 1, 3", "GN 1-3,
   * 5"), a backwards range or a dash chain. Multi-volume with no label and no
   * range, and never sized from the line's name: the page pass holds it.
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
// always mean packaging; in the line's own title ("Berserk Deluxe Edition
// (GN 1)", "Summer Ghost: The Complete Manga Collection (GN)") only when
// the entry's name does not itself contain them.
const DESIGNATOR_PACKAGING = /\b(omnibus|box(?:ed)?(?: set)?|deluxe|collector'?s|hardcover)\b/i;
const TITLE_PACKAGING =
  /\b(omnibus|box(?:ed)? set|deluxe|collector['’]?s|perfect edition|\d-in-1|complete (?:manga )?collection)\b/i;

/**
 * The designator's numbers: the first run of numbers joined as a list or
 * range ("4", "97-99", "1, 3", "1-3, 5"). Text after it is not read: the
 * total in "GN 4 / 8" or the part in "GN 3 Part 1".
 */
const DESIGNATOR_LIST = /\d+(?:\.\d+)?(?:\s*(?:[-–&,]|\band\b)\s*\d+(?:\.\d+)?)*/i;
/** "1-3-5": a dash chain names no range. */
const DASH_CHAIN = /[-–]\s*\d+(?:\.\d+)?\s*[-–]/;

/**
 * Split one release line's text: "Frieren: Beyond Journey's End (GN 14)" →
 * title + label + format. GN/OGN designators are print, eBook digital;
 * omnibus/box-set designators flag Edition Line packaging. A list of
 * Volumes is read by the shared grammar (lib/bookTitle.ts parseVolumeList):
 * a range or contiguous list ("1-3", "1, 2, 3", "1 & 2") is multi-volume
 * with that range; one no range holds ("1, 3", "1-3, 5", "3-1") is
 * multi-volume with `coverageGapped` and neither label nor range. Returns
 * null for lines that are not book releases (DVDs and other designators ANN
 * mixes into other media types) and for single chapters ("eBook ch 17") —
 * chapters are never Volumes. `entryName` (the manga's own title) lets
 * packaging words in the line title count only when they are not part of
 * the series name.
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
  const isEbook = /\be-?book\b/i.test(designator);
  const isPrint = /\bO?GN\b/.test(designator) || /graphic novel/i.test(designator);
  if (!isEbook && !isPrint) return null;
  if (/\bch(?:apter)?\.?\s*\d/i.test(designator)) return null;
  const titleWord = TITLE_PACKAGING.exec(title)?.[1];
  const editionLineHint =
    DESIGNATOR_PACKAGING.test(designator) ||
    (titleWord !== undefined && !entryName.toLowerCase().includes(titleWord.toLowerCase()));
  const numbers = DESIGNATOR_LIST.exec(designator)?.[0];
  const list = numbers !== undefined ? parseVolumeList(numbers) : null;
  const range = list?.coverRange;
  const gapped =
    list !== null &&
    (range == null || DASH_CHAIN.test(numbers!) || Number(range.from) > Number(range.to));
  return {
    title,
    label: list === null ? numbers : undefined,
    multi: list !== null,
    format: isEbook ? "digital" : "physical",
    editionLineHint,
    ...(gapped ? { coverageGapped: true } : range ? { coverRange: range } : {}),
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
  const rating = /<info[^>]*type="Objectionable content"[^>]*>\s*([A-Z]+)\s*<\/info>/.exec(body)?.[1];
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
const LOWERCASE_NAME_WORDS = new Set(["atsushi", "check", "em", "est", "great", "tartan", "ufotable", "und"]);
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
    const current = { role: words.slice(at, at + role).join(" ").toLowerCase(), names: 0, lower: false };
    clauses.push(current);
    at += role;
    // ANN's doubled prefix: "Story and art by Written by Koji Kumeta."
    for (let again = creditRoleAt(words, at); again > 0; again = creditRoleAt(words, at)) at += again;
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
      if (/[.!?]$/.test(word) && !/^\p{L}\.$/u.test(word) && !(word.endsWith("!") && at === words.length - 1)) {
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
    words.every((w) => NAME_WORD.test(w.replace(/[.,;:!?]+$/, "")) || NAME_JOINERS.has(w.toLowerCase()))
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
    if (clauses.length === 1 && first!.names === 1 && (!isStoryAndArt(first!) || first!.lower)) continue;
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
  const inline =
    bounded ? field.replace(/<\/p>\s*$/i, "") : (/^([\s\S]*?)<\/p>/i.exec(field)?.[1] ?? "");
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
