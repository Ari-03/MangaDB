// PRH Enhanced API parsing (ticket #36, spec §6/§7): pure functions from
// the Penguin Random House title-list JSON to normalized snapshots. PRH
// distributes 50+ publishers including Kodansha, Seven Seas, Dark Horse,
// Square Enix, Denpa, and Vertical (VIZ is NOT PRH-distributed); the
// adapter overlays authoritative onsale dates and ISBNs on those records.
//
// Endpoint (requires an api_key; docs at developer.penguinrandomhouse.com):
//   GET /resources/v2/title/domains/PRH.US/imprints/{code}/titles
//       ?api_key=…&rows=200&start=N&sort=onsale&dir=asc|desc
// The imprint-scoped path is mandatory: the flat /titles endpoint silently
// ignores its `imprint` and `onsaleFrom` query params (verified live
// 2026-08 and 2026-09), so date filtering happens client-side in the sync.
// The sync adds the content zoom
// (`zoom=https://api.penguinrandomhouse.com/title/titles/content/definition`),
// which embeds each title's marketing copy in the same response
// (`_embeds[].content`: `flapcopy`, `positioning`, `jacketquotes`… as HTML
// with entities and `<br>`; verified live 2026-09-26,
// __fixtures__/prh/titles-page-zoom.json). The flap copy (else the one-line
// positioning) is the snapshot's `description` — PRH's Release Description.
//
// The parser is deliberately tolerant of shape drift (nested vs flat
// imprint/format fields, string vs number ISBNs) — verified against the
// live API 2026-08.
//
// Scope: a distributed imprint can still publish prose, merchandise, or
// other languages, so titles are gated here — PRH's prose "Vertical"
// imprint and Seven Seas' coloring-book "Waves of Color" imprint are denied
// outright (only "Vertical Comics" is manga), and novels, merchandise,
// samplers, and non-English editions are dropped by title. PRH's own
// classification adds what titles miss (prhScopeReason): `graphicCategory`
// "Light Novel", prose-only BISAC `subjects`, and the general TOKYOPOP
// imprint's "Graphic Novel" category (its art books, card decks, album-style
// GNs). Scope is "does it look like manga", not origin: OEL/global manga,
// manhwa, manhua and manga-styled originals stay in. A non-manga-looking
// comic PRH still files as "Manga" (e.g. a US-style issue) has no PRH
// signal and is left to Editors.

import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { outOfScopeReason, parseBookTitle } from "./bookTitle";
import { catalogTitleFields } from "./catalogTitle";
import { cleanBlurb } from "./text";

// ---------- the normalized snapshot ----------

export const prhTitleValidator = v.object({
  kind: v.literal("prhTitle"),
  ...catalogTitleFields,
});

export type PrhTitleSnapshot = Infer<typeof prhTitleValidator>;

// ---------- field plumbing ----------

/** "2026-12-08" or "2026-12-08T00:00:00-05:00" → a full-precision date. */
export function parseOnsale(
  raw: unknown,
): { year: number; month: number; day: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

function asIsbn13(raw: unknown): string | undefined {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return /^\d{13}$/.test(digits) ? digits : undefined;
}

function asIsbn10(raw: unknown): string | undefined {
  const chars = String(raw ?? "")
    .replace(/[^0-9Xx]/g, "")
    .toUpperCase();
  return /^\d{9}[\dX]$/.test(chars) ? chars : undefined;
}

/** Nested `{code, description}` or flat string → the description text. */
function described(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (typeof raw === "object" && raw !== null) {
    const desc = (raw as Record<string, unknown>).description;
    if (typeof desc === "string" && desc.trim() !== "") return desc.trim();
  }
  return undefined;
}

function priceCents(entry: Record<string, unknown>): number | undefined {
  const flat = entry.priceUsd ?? entry.priceUSD;
  if (typeof flat === "number" && flat > 0) return Math.round(flat * 100);
  if (Array.isArray(entry.price)) {
    for (const row of entry.price) {
      if (typeof row !== "object" || row === null) continue;
      const p = row as Record<string, unknown>;
      if (p.currencyCode === "USD" && typeof p.amount === "number" && p.amount > 0) {
        return Math.round(p.amount * 100);
      }
    }
  }
  return undefined;
}

/** The content zoom's embeds (`_embeds[].content`) for this EAN; one naming another EAN is ignored. */
function contentEmbeds(entry: Record<string, unknown>, isbn13: string): Record<string, unknown>[] {
  return (Array.isArray(entry._embeds) ? entry._embeds : []).flatMap((embed) => {
    const content = (embed as { content?: unknown } | null)?.content;
    if (typeof content !== "object" || content === null) return [];
    const fields = content as Record<string, unknown>;
    return fields.ean === undefined || String(fields.ean) === isbn13 ? [fields] : [];
  });
}

/** The title's blurb from the content zoom: the flap copy, else the one-line positioning. */
function flapCopy(entry: Record<string, unknown>, isbn13: string): string | undefined {
  const contents = contentEmbeds(entry, isbn13);
  for (const key of ["flapcopy", "positioning"]) {
    for (const content of contents) {
      const text = cleanBlurb(content[key]);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/**
 * Every content text that might state a packaged book's coverage, in order
 * of trust: flap copy, positioning, then the keynote ("Collects Berserk
 * Volumes 40, 41, and Berserk Official Guidebook") — lib/coverage.ts reads
 * them when the title leaves the coverage unstated.
 */
function coverageHints(entry: Record<string, unknown>, isbn13: string): string[] {
  const contents = contentEmbeds(entry, isbn13);
  const hints: string[] = [];
  for (const key of ["flapcopy", "positioning", "keynote"]) {
    for (const content of contents) {
      const text = cleanBlurb(content[key]);
      if (text !== undefined && !hints.includes(text)) hints.push(text);
    }
  }
  return hints;
}

// ---------- title records ----------

/** The entry's ISBN-13 — its identity, and the PRH observation's source-record id. */
function entryIsbn13(entry: Record<string, unknown>): string | undefined {
  return asIsbn13(entry.isbn ?? entry.isbnHyphenated);
}

const DIGITAL = /\be-?book\b|\bdigital\b|\bDN\b/i;
const AUDIO = /audio/i;

// Imprints that are never manga: Vertical Inc.'s prose line (its manga
// arrives as "Vertical Comics") and Seven Seas' coloring books.
const DENIED_IMPRINTS = /^(?:vertical|waves of color)$/i;

// PRH classification signals, calibrated on live imprint listings
// (2026-09-25: 209, 210, 206, 140, KN, KM, V4, XO, XP, 123, 334):
// - graphicCategory "Light Novel" is prose everywhere ("Berserk: The Flame
//   Dragon Knight" carries no novel word in its title).
// - Every BISAC subject a FIC (fiction) code: prose ("Six: Paths of Horror").
//   Juvenile-only (JUV) subjects are NOT a signal — real kids' manga ("The
//   Fox & Little Tanuki", Tokyopop's "Agent Boo") carry only those.
// - "Graphic Novel" is not a signal in general (Titan Manga and Vertical
//   Comics file real manga under it), but in the general TOKYOPOP imprint
//   it marks only non-manga: art books, card decks, advent calendars,
//   sticker books, the album-style "Ballad of The Broken Heart".
const PROSE_CATEGORY = /^light novel$/i;
const NON_MANGA_GN_IMPRINT = /^tokyopop$/i;

/**
 * Why PRH's own classification puts a title outside the manga catalog, or
 * null when it does not: see the signals above. `imprint` is the parsed
 * imprint description.
 */
export function prhScopeReason(
  entry: Record<string, unknown>,
  imprint: string | undefined,
): "novel" | "prose" | "notManga" | null {
  const category = typeof entry.graphicCategory === "string" ? entry.graphicCategory.trim() : "";
  if (PROSE_CATEGORY.test(category)) return "novel";
  const codes = Array.isArray(entry.subjects)
    ? entry.subjects.flatMap((subject) =>
        typeof subject === "object" &&
        subject !== null &&
        "code" in subject &&
        typeof subject.code === "string"
          ? [subject.code]
          : [],
      )
    : [];
  if (codes.length > 0 && codes.every((code) => code.startsWith("FIC"))) return "prose";
  if (
    imprint !== undefined &&
    NON_MANGA_GN_IMPRINT.test(imprint) &&
    /^graphic novel$/i.test(category)
  ) {
    return "notManga";
  }
  return null;
}

/** Why readTitle produced no snapshot: unusable data, or deliberately not manga. */
type DropReason = "malformed" | "outOfScope";

/** One title entry → a snapshot, or null when malformed / out of scope. */
export function parseTitle(raw: unknown): PrhTitleSnapshot | null {
  const read = readTitle(raw);
  return typeof read === "string" ? null : read;
}

/** parseTitle, saying why an entry was dropped (parseTitleList reports it). */
function readTitle(raw: unknown): PrhTitleSnapshot | DropReason {
  if (typeof raw !== "object" || raw === null) return "malformed";
  const entry = raw as Record<string, unknown>;
  const isbn13 = entryIsbn13(entry);
  if (isbn13 === undefined) return "malformed";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title === "") return "malformed";

  // Scope (spec §1): prose imprints, novels, merchandise, samplers, and
  // non-English editions never enter the catalog.
  const imprint = described(entry.imprint) ?? described(entry.publisher);
  if (imprint !== undefined && DENIED_IMPRINTS.test(imprint)) return "outOfScope";
  if (outOfScopeReason(title) !== null) return "outOfScope";
  if (prhScopeReason(entry, imprint) !== null) return "outOfScope";
  const language = described(entry.language);
  if (language !== undefined && !/^(?:e|en|eng|english)$/i.test(language)) return "outOfScope";

  // Format family: audio is out of catalog scope entirely (spec §1).
  const formatText = described(entry.format) ?? described(entry.formatFamily) ?? "";
  if (AUDIO.test(formatText)) return "outOfScope";
  const digital = DIGITAL.test(formatText);
  const binding = !digital
    ? /hardcover/i.test(formatText)
      ? "hardcover"
      : /paperback|trade/i.test(formatText)
        ? "paperback"
        : undefined
    : undefined;

  const seriesNumber =
    typeof entry.seriesNumber === "number" || typeof entry.seriesNumber === "string"
      ? entry.seriesNumber
      : undefined;
  const parsed = parseBookTitle(title, { seriesNumber });
  const coverRange = parsed.packaging?.coverRange ?? null;

  const seo = entry.seoFriendlyUrl;
  const url =
    typeof seo === "string" && seo.startsWith("/")
      ? `https://www.penguinrandomhouse.com${seo}`
      : `https://www.penguinrandomhouse.com/search/site-search?q=${isbn13}`;

  return {
    kind: "prhTitle",
    url,
    isbn13,
    isbn10: asIsbn10(entry.isbn10),
    title,
    seriesTitle: parsed.seriesTitle,
    volumeLabel: parsed.volumeLabel ?? undefined,
    multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
    packaging: parsed.packaging ?? undefined,
    isBox: parsed.isBox || undefined,
    bareNumber: parsed.bareNumber || undefined,
    bareRoman: parsed.bareRoman || undefined,
    bareSplit: parsed.bareSplit ?? undefined,
    author: typeof entry.author === "string" ? entry.author.trim() : undefined,
    onsale: parseOnsale(entry.onsale ?? entry.onSaleDate),
    format: digital ? "digital" : "physical",
    binding,
    imprint,
    priceCents: priceCents(entry),
    description: flapCopy(entry, isbn13),
    // Only packaging with an unstated coverage needs the extra texts.
    ...(parsed.packaging && parsed.packaging.coverRange === null
      ? { coverageHints: coverageHints(entry, isbn13) }
      : {}),
  };
}

/** A listed entry that produced no snapshot: still present at the source. */
export type DroppedTitle = {
  /** The entry's identity, when its ISBN is readable. */
  isbn13?: string;
  reason: DropReason;
};

/**
 * The title-list envelope → its parsed titles + the total record count.
 * Verified live 2026-09-26 (__fixtures__/prh/titles-page.json): every page
 * carries `status` ("ok", or "warning" with the data intact), a root
 * `recordCount`, and `data.titles`; a page past the end or an unknown
 * imprint is an HTTP 404, never an empty page. So the count is required —
 * without it an empty page is no evidence the imprint is empty, and a
 * missing `titles` array is tolerated only with an explicit recordCount 0.
 *
 * Entries the parser drops are reported in `dropped`: presence at the
 * source does not depend on normalizing, so the sync keeps them present
 * rather than letting a full sweep withdraw them (B09).
 */
export function parseTitleList(raw: unknown): {
  titles: PrhTitleSnapshot[];
  dropped: DroppedTitle[];
  recordCount: number;
  /** Upstream page size, before scope filtering. */
  rawCount: number;
} {
  const root = raw as Record<string, unknown> | null;
  const envelope = typeof root?.data === "object" && root.data !== null;
  const data = (envelope ? root.data : root) as Record<string, unknown> | null;
  const status = root?.status;
  if (typeof status === "string" && status !== "ok" && status !== "warning") {
    throw new Error(`PRH response status is ${status}`);
  }
  const count = root?.recordCount ?? data?.recordCount;
  if (typeof count !== "number") throw new Error("PRH response is missing its recordCount");
  const recordCount = count;
  const list = data?.titles;
  if (!Array.isArray(list)) {
    if (list == null && recordCount === 0) {
      return { titles: [], dropped: [], rawCount: 0, recordCount };
    }
    throw new Error("PRH response is missing its titles array");
  }
  const titles: PrhTitleSnapshot[] = [];
  const dropped: DroppedTitle[] = [];
  for (const entry of list) {
    const read = readTitle(entry);
    if (typeof read !== "string") {
      titles.push(read);
      continue;
    }
    const isbn13 =
      typeof entry === "object" && entry !== null
        ? entryIsbn13(entry as Record<string, unknown>)
        : undefined;
    dropped.push({ ...(isbn13 !== undefined ? { isbn13 } : {}), reason: read });
  }
  return { titles, dropped, rawCount: list.length, recordCount };
}

// ---------- the author line ----------

/** One credit an author line gives, in people.ts's roles. */
export type AuthorCredit = { name: string; role: Doc<"seriesCredits">["role"] };

type Task = "story" | "art" | "original";

// Every task an author-line label may name, and what it credits: null for
// tasks that make no one an author of the Series here (design, translation,
// lettering, editing, adapting someone else's work).
const TASKS: Record<string, Task | null> = {
  story: "story",
  written: "story",
  writer: "story",
  art: "art",
  artwork: "art",
  illustrated: "art",
  illustration: "art",
  illustrations: "art",
  manga: "art",
  drawn: "art",
  created: "original",
  creator: "original",
  "original story": "original",
  "original concept": "original",
  "original work": "original",
  "original creator": "original",
  "original illustrations": null,
  "original character design": null,
  "original character designs": null,
  "character design": null,
  "character designs": null,
  "graffiti designs": null,
  translated: null,
  translation: null,
  lettered: null,
  lettering: null,
  letters: null,
  retouch: null,
  compiled: null,
  storyboards: null,
  layouts: null,
  composition: null,
  contributions: null,
  supervised: null,
  organized: null,
  "research consulting": null,
  adaptation: null,
  adapted: null,
  adaptated: null,
  script: null,
};

const TASK = Object.keys(TASKS)
  .sort((a, b) => b.length - a.length)
  .join("|");
/** Between tasks of one label: "Story & Art", "Created, written, and illustrated". */
const TASK_JOIN = /\s*,\s*and\s+|\s*,\s*|\s*&\s*|\s+and\s+/i;
/** A label opening a clause or following a comma: "Story by ", ", Art by ", "By ". */
const LABEL = new RegExp(
  `(?:^|,\\s*)(?:((?:${TASK})(?:(?:${TASK_JOIN.source})(?:${TASK}))*)\\s+)?by\\s+`,
  "gi",
);
/** Clauses end at a semicolon or a sentence's full stop (not an initial's: "M. Alice"). */
const CLAUSE_BREAK = /\s*;\s*|(?<=[^\s.]{2})\.(?:\s+|$)/;
/** Words no name contains: a sign the line has a shape this parser does not know. */
const NOT_A_NAME =
  /\b(?:by|with|various|artists?|creators?|series|story|art|written|illustrated|illustrations?|designs?|translat\w*|letter\w*|based|original)\b/i;

/**
 * The credits in PRH's free-text `author` line, or none when the line has a
 * shape this does not recognise (a wrong credit is worse than none):
 *
 * - "Yui Sakuma", "Kazuo Koike and Goseki Kojima": each a role-less author.
 * - Labelled clauses split by ";", ", " before a label, or a full stop:
 *   "Story by A; Art by B", "Written and illustrated by A. Translated by
 *   B.", "Original concept by A; Story by B; Art by C". Tasks map to roles
 *   (`TASKS`); a label with only dropped tasks (character design,
 *   translation, compilation, adaptation) credits nobody, "By A" is a
 *   role-less author, and a label naming an "Original ..." credits the
 *   original creator whatever follows ("Original Story and Illustrations").
 * - Unlabelled names opening a labelled line take the role the labels
 *   leave open: "A; Illustrated by B" → A wrote it, "A; Story by B" → A
 *   drew it, "A; created by B" → A is the author, and with both story and
 *   art labelled A is the original creator.
 * - A line crediting a writer but nobody for the art ("Written by A")
 *   makes the writer the role-less author.
 *
 * Refused: a single-word name beside a comma ("Fushimi, Tsukasa" is Last,
 * First), colons, an unlabelled name after the first clause, a label this
 * does not know, and names holding task words ("Various Artists").
 * Parenthesised studios and labels are dropped first ("POPO (Friendly
 * Land)"); a "based on ..." clause names the source, not a credit. A
 * person may appear twice with two roles; people.ts merges them.
 */
export function parseAuthorCredits(author: string | undefined): AuthorCredit[] {
  const text = (author ?? "").replace(/\s*\([^()]*\)/g, "").replace(/\s+/g, " ").trim();
  if (text === "" || /[:/()[\]]/.test(text)) return [];
  const labeled: AuthorCredit[] = [];
  let lead: string[] = [];
  let first = true;
  for (const clause of text.split(CLAUSE_BREAK)) {
    if (clause === "") continue;
    if (/^based on\b/i.test(clause)) {
      first = false;
      continue;
    }
    const marks = [...clause.matchAll(LABEL)];
    const opening = marks[0]?.index ?? clause.length;
    if (opening > 0) {
      const names = first ? splitNames(clause.slice(0, opening)) : null;
      if (!names) return [];
      lead = names;
    }
    first = false;
    for (const [i, mark] of marks.entries()) {
      const names = splitNames(
        clause.slice(mark.index + mark[0].length, marks[i + 1]?.index ?? clause.length),
      );
      if (!names) return [];
      const role = mark[1] === undefined ? "author" : labelRole(mark[1]);
      if (role) labeled.push(...names.map((name) => ({ name, role })));
    }
  }
  const has = (task: "story" | "art") =>
    labeled.some((credit) => credit.role === task || credit.role === "story_art");
  const story = has("story");
  const art = has("art");
  const leadRole: AuthorCredit["role"] =
    story && art ? "original" : art ? "story" : story ? "art" : "author";
  const credits: AuthorCredit[] = [...lead.map((name) => ({ name, role: leadRole })), ...labeled];
  if (credits.some((credit) => credit.role === "art" || credit.role === "story_art")) return credits;
  return credits.map((credit): AuthorCredit =>
    credit.role === "story" ? { ...credit, role: "author" } : credit,
  );
}

/** A label's role: writing and drawing are Story & Art; null when it credits no maker or source. */
function labelRole(label: string): AuthorCredit["role"] | null {
  const tasks = label.toLowerCase().split(TASK_JOIN);
  const original = tasks[0]?.startsWith("original ") === true;
  const found = new Set(tasks.map((task) => (original && TASKS[task] ? "original" : TASKS[task])));
  if (found.has("story") && found.has("art")) return "story_art";
  if (found.has("story")) return "story";
  if (found.has("art")) return "art";
  if (found.has("original")) return "original";
  return null;
}

/**
 * The names in "A, B, and C" / "A and B" / "A & B", or null when one is
 * not plainly a name: empty, holding a task word, or a single word in a
 * comma list (a "Last, First" name).
 */
function splitNames(text: string): string[] | null {
  const names = text.split(/\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+/i).map((name) => name.trim());
  if (names.some((name) => name === "" || NOT_A_NAME.test(name))) return null;
  if (text.includes(",") && names.some((name) => !name.includes(" "))) return null;
  return names;
}
