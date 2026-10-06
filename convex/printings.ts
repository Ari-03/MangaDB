// Other Printings decided by a person (CONTEXT.md, docs/operations.md):
// the only way a held book becomes another printing of a Release, or a
// further record of one is linked to it. No importer records one on its
// own; the Data Team, or an agent whose decision a reviewer checked,
// decides it with evidence, and this records it through the shared writes
// (lib/printings.ts) after checking the invariants nothing may break. The
// consistency check at the end reads the whole catalog's printing claims
// for an operator, a page at a time.

import { matureFlipsOf } from "./lib/mature";
import { heldState } from "./lib/heldBooks";
import { isbnScope } from "./lib/scope";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { type AnnReleaseSnapshot, lineOutOfScope } from "./ann";
import { getSourceByKey } from "./importSources";
import { packagingOf, readAnnLineTitle, splitReleaseTitle } from "./lib/ann";
import { nestedLimits, platformStop } from "./lib/bounded";
import { bindingFacts, bookFacts } from "./lib/bookFacts";
import { canonicalLabel, isNovelTitle, outOfScopeReason, parseBookTitle } from "./lib/bookTitle";
import { isbnFieldValue, isbnHiddenFromIndex, toIsbn13 } from "./lib/isbn";
import { labelsEqual, sameWorkTitle } from "./lib/matching";
import type { AnnWorkContext } from "./lib/declaredWork";
import { canonicalRecord, mergeSurvivor } from "./lib/merges";
import { holdOf } from "./lib/observations";
import { findPublisherByName, toPartialDate } from "./lib/pipeline";
import { linkRecordedPrinting, recordPrinting } from "./lib/printings";
import {
  addClaim,
  CLAIM_SCAN,
  type ClaimResolver,
  claimResolver,
  type IsbnClaims,
  isbnClaims,
  MAX_DOCUMENT_BYTES,
  primaryIsbnsOf,
  printedClaimRefusal,
  type Room,
  readRoom,
  statedIsbns,
} from "./lib/releaseIsbns";
import { holdKind, releaseFormat } from "./schema";
import { sameValue, valueHash } from "./lib/values";
import { isMangaBook } from "./lib/sevenSeas";
import { decodeEntities } from "./lib/text";

/** A snapshot's date parts, as each source stores them (ANN's page first). */
type DateLike = { year?: unknown; month?: unknown; day?: unknown };

/** The fields of a source record these checks read, whichever source's shape it has. */
type SnapshotFacts = {
  kind?: unknown;
  url?: unknown;
  title?: unknown;
  subtitle?: unknown;
  format?: unknown;
  binding?: unknown;
  physicalFormat?: unknown;
  imprint?: unknown;
  publishers?: unknown;
  category?: unknown;
  outOfScope?: unknown;
  volumeLabel?: unknown;
  multiVolume?: unknown;
  packaging?: unknown;
  isBox?: unknown;
  bareNumber?: unknown;
  bareRoman?: unknown;
  date?: DateLike;
  publishDate?: DateLike;
  releaseDate?: DateLike;
  page?: { title?: unknown; volume?: unknown; distributor?: unknown; date?: DateLike };
} | null;

/** The publication date a source record gives, or undefined. */
function observedDate(s: SnapshotFacts) {
  const parts = [s?.page?.date, s?.date, s?.publishDate, s?.releaseDate].find(
    (date) => typeof date?.year === "number",
  );
  if (parts === undefined) return undefined;
  return toPartialDate({
    year: parts.year as number,
    ...(typeof parts.month === "number" ? { month: parts.month } : {}),
    ...(typeof parts.day === "number" ? { day: parts.day } : {}),
  });
}

/** Dedicated format fields and independently scoped technical title clauses. */
function saysDigital(s: SnapshotFacts, names: readonly string[]): boolean {
  if (s?.format === "digital") return true;
  if (
    [s?.binding, s?.physicalFormat, s?.page?.volume].some(
      (text) =>
        typeof text === "string" &&
        /\be-?books?\b|\bkindle\b|\belectronic\b|\bdigital\b/i.test(text),
    )
  )
    return true;
  return (
    [s?.title, s?.page?.title].some((text) => bookFacts(text, names).digital) ||
    bookFacts(s?.subtitle).digital
  );
}

/**
 * The publisher names a source record gives, in the order its importer
 * resolves them: ANN's distributor, Open Library's list (the first that
 * resolves counts), a catalog feed's imprint, and Seven Seas' own name
 * (its feed is its own catalog, an imprint like Ghost Ship filed under
 * it). Kodansha's feed names none: it also lists Vertical's books.
 */
function publisherNames(sourceKey: string, s: SnapshotFacts): string[] {
  const text = (value: unknown) => (typeof value === "string" ? [value] : []);
  switch (sourceKey) {
    case "ann":
      return text(s?.page?.distributor);
    case "openlibrary":
      return Array.isArray(s?.publishers) ? s.publishers.flatMap(text) : [];
    case "prh":
    case "yenpress":
      return text(s?.imprint);
    case "sevenseas":
      return ["Seven Seas Entertainment"];
    default:
      return [];
  }
}

/**
 * The one ISBN-13 a source record gives, or why it gives none: every ISBN
 * it states (statedIsbns), in any spelling, must be valid and name the same
 * book. A record that disagrees with itself is no evidence for a decision.
 */
function decidedIsbn13(snapshot: unknown): { isbn13: string } | { refusal: string } {
  const stated = statedIsbns(snapshot);
  if (stated.length === 0) return { refusal: "The record gives no ISBN." };
  const invalid = stated.filter((isbn) => toIsbn13(isbn) === undefined);
  if (invalid.length > 0) {
    return { refusal: `The record gives an invalid ISBN (${[...new Set(invalid)].join(", ")}).` };
  }
  const isbns = [...new Set(stated.map((isbn) => toIsbn13(isbn)))];
  const [isbn13] = isbns;
  if (isbns.length !== 1 || isbn13 === undefined) {
    return { refusal: `The record gives different ISBNs (${isbns.join(", ")}).` };
  }
  return { isbn13 };
}

/** `text` as an absolute http(s) URL with a host, else undefined. Parsed, never fetched. */
function httpUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const web = url.protocol === "https:" || url.protocol === "http:";
  return web && url.hostname !== "" ? url.href : undefined;
}

/**
 * The URL a decision's Revision cites, or why there is none: `evidenceUrl`
 * when one is given, else the record's own URL. Both are trimmed, and an
 * empty or blank `evidenceUrl` counts as not given. A given URL that is not
 * an absolute http(s) URL is refused, never replaced by the record's.
 */
function decidedCitationUrl(
  evidenceUrl: string | undefined,
  s: SnapshotFacts,
): { url: string } | { refusal: string } {
  const given = evidenceUrl?.trim() ?? "";
  if (given !== "") {
    const url = httpUrl(given);
    return url !== undefined
      ? { url }
      : { refusal: `The evidence URL (${given}) is not an absolute http(s) URL.` };
  }
  const own = typeof s?.url === "string" ? httpUrl(s.url.trim()) : undefined;
  return own !== undefined
    ? { url: own }
    : { refusal: "The decision cites no evidence URL, and the record has no http(s) URL." };
}

/**
 * The Release's Series as they are now, each followed through its merges
 * (lib/merges.ts canonicalRecord) to an active Series, or why one is not:
 * the work a decision compares the record with, by ID. A hidden Series, or
 * one whose merges end nowhere, has no printings decided for it.
 */
async function releaseSeries(
  ctx: MutationCtx,
  release: Doc<"releases">,
): Promise<{ series: Array<Doc<"series">> } | { refusal: string }> {
  const series: Array<Doc<"series">> = [];
  for (const id of release.seriesIds) {
    const found = await canonicalRecord(ctx, "series", id);
    if ("problem" in found) {
      return { refusal: `The Release's Series cannot be followed: ${found.problem}.` };
    }
    if (found.doc.status !== "active") {
      return { refusal: `The Release's Series "${found.doc.title}" is ${found.doc.status}.` };
    }
    series.push(found.doc);
  }
  return { series };
}

/**
 * Why the held book's Series or publisher is not the Release's, or null:
 * its hold's Series, followed through merges, must be one of the Release's
 * Series (releaseSeries), and a publisher the record names must resolve to
 * the Release's publisher (followed through merges too).
 */
async function slotRefusal(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
  series: Array<Doc<"series">>,
  s: SnapshotFacts,
): Promise<string | null> {
  const hold = await holdOf(ctx, observation._id);
  if (hold?.seriesId === undefined) return "The book is not held under a Series.";
  const held = await canonicalRecord(ctx, "series", hold.seriesId);
  if (!("doc" in held) || !series.some((one) => one._id === held.doc._id)) {
    return `The book is held under ${"doc" in held ? `"${held.doc.title}"` : "a Series that cannot be followed"}, which is not the Release's Series.`;
  }

  const names = publisherNames(observation.sourceKey, s);
  if (names.length === 0) return null;
  let publisher: Doc<"publishers"> | null = null;
  for (const name of names) {
    publisher = await findPublisherByName(ctx, name);
    if (publisher !== null) break;
  }
  if (publisher === null) {
    return `The record's publisher (${names.join(", ")}) resolves to no publisher row.`;
  }
  const releasePublisher = await mergeSurvivor(
    ctx,
    "publishers",
    await ctx.db.get(release.publisherId),
  );
  if (releasePublisher?._id !== publisher._id) {
    return `The record's publisher is ${publisher.name}; the Release's is ${releasePublisher?.name ?? "unknown"}.`;
  }
  return null;
}

// ---------- what the book is ----------

/**
 * A work's name as a decision compares it: entities decoded, case and
 * runs of whitespace folded, nothing else. "Citrus+" is not "Citrus", and
 * "Kingdom Hearts II" is not "Kingdom Hearts".
 */
function workKey(title: string): string {
  return decodeEntities(title).normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** What a record says the book is, read from its own fields. */
type BookReading = {
  /** The work, its own numbers kept. */
  work: string;
  /** The single Volume it states, canonical; undefined when it states none. */
  label: string | undefined;
  /**
   * The source numbers every book it lists (ANN), so a record of it that
   * states no Volume anywhere is unknown, never the Release's Volume.
   */
  needsLabel: boolean;
  /** Its agreed known Binding; undefined is unknown. */
  binding: Binding | undefined;
  /** Why it reads as more (or other) than one Volume: any one refuses for now. */
  packaging: string[];
  /** Why it is outside the catalog (a novel, a non-English book, …). */
  scope: string[];
  /** Why the record cannot be read with certainty: statements that disagree. */
  unreadable: string[];
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const BRACKETED = /\[[^\]]*\]/;

/** The two Bindings a record or Release can state plainly. */
type Binding = "hardcover" | "paperback";

/** The Binding statements among a title's peeled format tags ("Hardcover", "Trade Paperback"). */
const titleBindings = (where: string, formatTags: string[]) =>
  formatTags.map((tag) => ({ where: `${where}'s tag "${tag}"`, text: tag }));

/**
 * Every Binding a record states plainly, each with where it
 * says so: all of them must agree, and the reading takes their one
 * Binding. A record stating none leaves it unknown.
 */
function agreedBinding(
  reading: BookReading,
  statements: Array<{ where: string; text: unknown }>,
): void {
  const stated = statements.flatMap(({ where, text }) => {
    return bindingFacts(text).map((binding) => ({ where, binding }));
  });
  const [first, ...others] = stated;
  if (first === undefined) return;
  for (const other of others) {
    if (other.binding !== first.binding) {
      reading.unreadable.push(
        `${first.where} says ${first.binding}, ${other.where} ${other.binding}`,
      );
    }
  }
  reading.binding = first.binding;
}

/**
 * Every Volume a record states, each with where it says so: all of them
 * must agree (labelsEqual, so "01" is "1"), and the reading takes their one
 * Volume. A record stating none leaves the label unknown.
 */
function agreedLabel(
  reading: BookReading,
  statements: Array<{ where: string; label: string | null | undefined }>,
): void {
  const stated = statements.filter(
    (s): s is { where: string; label: string } => nonEmpty(s.label) && s.label.trim() !== "",
  );
  const [first] = stated;
  if (first === undefined) return;
  for (const other of stated.slice(1)) {
    if (!labelsEqual(first.label, other.label)) {
      reading.unreadable.push(
        `${first.where} says Volume ${first.label}, ${other.where} Volume ${other.label}`,
      );
    }
  }
  reading.label = canonicalLabel(first.label);
}

/**
 * The work and Volume an ANN release line states, from each of its
 * statements separately: the line's title, the release page's designator
 * (re-read with today's parser), the page's own title (its "Vol. 1" or its
 * "(GN 1)") and manga entry, and the stored flags. A stored flag is
 * evidence, never the authority: a fresh reading that disagrees with it is
 * unreadable, and either one saying packaging is packaging. Every Volume
 * any of them states must agree (agreedLabel), and ANN numbers its books,
 * so a line stating none anywhere is unknown (`needsLabel`). A missing
 * statement is unknown; a designator that no longer reads is unreadable.
 * A Binding a title's format tag states (the line's or the page's) counts
 * as the reading's, and tags that disagree are unreadable (agreedBinding).
 * `entryName` is the entry's title, trusted to own the packaging words in
 * the line's title only when it is one of the Release's Series titles.
 *
 * Integration point (docs/operations.md): with the fixed ANN line reader
 * (lib/ann.ts readAnnLineTitle and lib/matching.ts sameWorkTitle), this is
 * the one place that reading replaces the work and packaging read here.
 */
function readAnnLine(
  line: AnnReleaseSnapshot,
  entryName: string,
  names: readonly string[],
  annContext?: AnnWorkContext,
): BookReading {
  const reading: BookReading = {
    work: line.title,
    label: undefined,
    needsLabel: true,
    binding: undefined,
    packaging: [],
    scope: [],
    unreadable: [],
  };
  const labels: Array<{ where: string; label: string | null | undefined }> = [
    { where: "the stored line", label: line.label },
  ];
  if (line.multi) reading.packaging.push("a multi-volume designator");
  if (line.editionLineHint) reading.packaging.push("a packaging designator or title");
  if (line.coverRange) {
    reading.packaging.push(`a stated range (${line.coverRange.from}-${line.coverRange.to})`);
  }
  if (line.coverageGapped) reading.packaging.push("a Volume list no range holds");
  const named = packagingOf(line, annContext?.names);
  if (named?.line !== null && named?.line !== undefined)
    reading.packaging.push(`the line name ${named.line.name}`);
  const outOfScope = lineOutOfScope(line);
  if (outOfScope !== null) reading.scope.push(outOfScope);

  const page = line.page?.status === "ok" ? line.page : undefined;
  if (nonEmpty(page?.volume)) {
    const fresh = splitReleaseTitle(`${line.title} (${page.volume})`, entryName);
    if (fresh === null) {
      reading.unreadable.push(`ANN's designator "${page.volume}" does not read as one book`);
    } else {
      const label = fresh.label !== undefined ? canonicalLabel(fresh.label) : undefined;
      const storedLabel = line.label !== undefined ? canonicalLabel(line.label) : undefined;
      const stated = [
        ["Volume", label, storedLabel],
        ["multi-volume", fresh.multi, line.multi],
        ["packaging", fresh.editionLineHint, line.editionLineHint],
        [
          "range",
          JSON.stringify(fresh.coverRange ?? null),
          JSON.stringify(line.coverRange ?? null),
        ],
        ["gap", fresh.coverageGapped ?? false, line.coverageGapped ?? false],
      ] as const;
      for (const [what, now, stored] of stated) {
        if (now !== stored) {
          reading.unreadable.push(
            `ANN's designator "${page.volume}" now reads ${what} ${String(now)}, the stored line ${String(stored)}`,
          );
        }
      }
      if (fresh.multi) reading.packaging.push(`the designator "${page.volume}"`);
      labels.push({ where: `ANN's designator "${page.volume}"`, label: fresh.label });
    }
  }
  if (nonEmpty(page?.mangaId) && page.mangaId !== line.mangaId) {
    reading.unreadable.push(
      `ANN's page belongs to manga ${page.mangaId}, the line to ${line.mangaId}`,
    );
  }

  // The line's title: its own Volume statement must agree, and its work is
  // read whole when the parser would take a number off it ("Kingdom
  // Hearts II"): ANN's designator, not the title, numbers the book.
  const parsed = parseBookTitle(line.title);
  const titleFacts = bookFacts(line.title, names);
  labels.push(...titleFacts.labels.map((label) => ({ where: `its title "${line.title}"`, label })));
  reading.packaging.push(...titleFacts.packaging);
  reading.unreadable.push(...titleFacts.unreadable);
  const bindings = titleBindings(`its title "${line.title}"`, parsed.formatTags);
  bindings.push(
    ...titleFacts.bindings.map((text) => ({ where: `its title "${line.title}"`, text })),
  );
  if (parsed.isNovel) reading.scope.push("its title marks a novel");
  if (parsed.packaging !== null || parsed.isBox) {
    reading.packaging.push(`its title "${line.title}"`);
  }
  const bare = parsed.bareNumber || parsed.bareRoman;
  if (!bare) reading.work = parsed.seriesTitle;
  const namedPart = line.title.match(/^(.*?\bPart\s+\d+)\b/i)?.[1];
  const partOfWork =
    namedPart !== undefined && names.some((name) => sameWorkTitle(name, namedPart));
  // A verified Part belongs to the work name. Independent Vol./GN clauses
  // still come from bookFacts and the designator, and must all agree.
  if (!bare && !partOfWork)
    labels.push({ where: `its title "${line.title}"`, label: parsed.volumeLabel });
  if (nonEmpty(page?.title)) {
    // The page's title is a statement of its own, read whole before its
    // work is compared: its own designator ("Vagabond (GN 1)") and its own
    // Volume ("Vagabond, Vol. 1") count, as do packaging or a novel there.
    const split = splitReleaseTitle(page.title, entryName);
    const pageTitle = split?.title ?? page.title;
    const pageParsed = parseBookTitle(pageTitle);
    const pageFacts = bookFacts(page.title, names);
    labels.push(
      ...pageFacts.labels.map((label) => ({ where: `ANN's page title "${page.title}"`, label })),
    );
    bindings.push(
      ...pageFacts.bindings.map((text) => ({ where: `ANN's page title "${page.title}"`, text })),
    );
    reading.packaging.push(...pageFacts.packaging);
    reading.unreadable.push(...pageFacts.unreadable);
    const pageBare = pageParsed.bareNumber || pageParsed.bareRoman;
    const pageWork = pageBare ? pageTitle : pageParsed.seriesTitle;
    if (workKey(pageWork) !== workKey(reading.work)) {
      reading.unreadable.push(`ANN's page is titled "${page.title}", the line "${line.title}"`);
    }
    labels.push({ where: `ANN's page title "${page.title}"`, label: split?.label });
    const pagePart = pageTitle.match(/^(.*?\bPart\s+\d+)\b/i)?.[1];
    if (!pageBare && !(pagePart && names.some((name) => sameWorkTitle(name, pagePart)))) {
      labels.push({ where: `ANN's page title "${page.title}"`, label: pageParsed.volumeLabel });
    }
    if (
      pageParsed.packaging !== null ||
      pageParsed.isBox ||
      BRACKETED.test(page.title) ||
      split?.multi === true ||
      split?.editionLineHint === true
    ) {
      reading.packaging.push(`ANN's page title "${page.title}"`);
    }
    if (pageParsed.isNovel || isNovelTitle(page.title))
      reading.scope.push("its page title marks a novel");
    bindings.push(...titleBindings(`ANN's page title "${page.title}"`, pageParsed.formatTags));
  }
  agreedLabel(reading, labels);
  agreedBinding(reading, bindings);
  return reading;
}

/**
 * The work and Volume another source's record states: its title read by the
 * shared parser, checked against the fields the importer stored. A trailing
 * number the parser would split off without a Volume marker ("Kingdom
 * Hearts II") may be the work's own name, so such a reading is unreadable
 * here: a record that says "Vol." is read. A stored Volume the kept title
 * does not state is the importer's reading of fields the snapshot does not
 * keep (Open Library's subtitle "Vol. 1" under the title "Vagabond"): it
 * stands, and is checked against the Release like any other. An explicit
 * title or retained subtitle stating another Volume contradicts it.
 * A Binding is stated by a dedicated
 * field, a peeled format tag, or an explicit technical clause. A retained
 * subtitle is read separately for explicit Volume, Binding, packaging and
 * scope facts, so a preferred label cannot hide any later technical clause. Its
 * prose is never appended to work identity here; the producer already
 * retains joined work names in `title`. Legacy missing subtitles supply no
 * new facts, and their stored Volume continues to stand.
 */
export function readTitledRecord(
  sourceKey: string,
  title: string,
  s: SnapshotFacts,
  names: readonly string[],
): BookReading {
  const parsed = parseBookTitle(title);
  const subtitle = nonEmpty(s?.subtitle) ? s.subtitle.trim() : "";
  const titleFacts = bookFacts(title, names);
  const subtitleFacts = bookFacts(subtitle);
  const reading: BookReading = {
    work: parsed.seriesTitle,
    label: undefined,
    needsLabel: false,
    binding: undefined,
    packaging: [],
    scope: [],
    unreadable: [],
  };
  agreedBinding(reading, [
    { where: "its stored binding", text: s?.binding },
    { where: "its physical format", text: s?.physicalFormat },
    ...titleBindings(`its title "${title}"`, parsed.formatTags),
    ...titleFacts.bindings.map((text) => ({ where: `its title "${title}"`, text })),
    ...subtitleFacts.bindings.map((text) => ({ where: `its subtitle "${subtitle}"`, text })),
  ]);
  agreedLabel(reading, [
    { where: `its title "${title}"`, label: parsed.volumeLabel },
    { where: "its stored reading", label: nonEmpty(s?.volumeLabel) ? s.volumeLabel : undefined },
    ...titleFacts.labels.map((label) => ({ where: `its title "${title}"`, label })),
    ...subtitleFacts.labels.map((label) => ({ where: `its subtitle "${subtitle}"`, label })),
  ]);
  reading.unreadable.push(...titleFacts.unreadable, ...subtitleFacts.unreadable);
  reading.packaging.push(...titleFacts.packaging, ...subtitleFacts.packaging);
  if (parsed.packaging !== null || parsed.isBox) reading.packaging.push(`its title "${title}"`);
  if (BRACKETED.test(subtitle)) reading.packaging.push(`its subtitle "${subtitle}"`);
  if (subtitle !== "") {
    const scope = outOfScopeReason(subtitle);
    if (scope !== null) reading.scope.push(`its subtitle reads ${scope}`);
  }
  if (s?.multiVolume === true) reading.packaging.push("its stored multi-volume flag");
  if (s?.packaging !== undefined && s.packaging !== null) {
    reading.packaging.push("its stored packaging");
  }
  if (s?.isBox === true) reading.packaging.push("its stored box-set flag");
  if (parsed.bareNumber || parsed.bareRoman || s?.bareNumber === true || s?.bareRoman === true) {
    reading.unreadable.push(
      `its title "${title}" ends in a number that may be the work's own, with no Volume marker`,
    );
  }
  if (parsed.isNovel) reading.scope.push("its title marks a novel");
  if (nonEmpty(s?.outOfScope))
    reading.scope.push(`its source calls it out of scope (${s.outOfScope})`);
  const category = typeof s?.category === "string" ? s.category : undefined;
  if (sourceKey === "sevenseas" && !isMangaBook({ category, title })) {
    reading.scope.push(`Seven Seas files it as ${category ?? "not manga"}`);
  }
  if (sourceKey === "yenpress" && category !== undefined && category !== "manga") {
    const izeComics = category === "comics" && /^ize press$/i.test(String(s?.imprint ?? ""));
    if (!izeComics) reading.scope.push(`Yen Press files it as ${category}`);
  }
  return reading;
}

/** The final source reading, independent of the printing-only one-Volume target rule.
 * Held ANN callers supply the pinned parent and its verified canonical declarations.
 * Other callers retain their existing primary-title context and parent lookup.
 */
export async function readObservationBook(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  series: Array<Doc<"series">>,
  workTitles: readonly string[] = series.map((one) => one.title),
  annContext?: AnnWorkContext,
): Promise<BookReading> {
  const s = observation.snapshot as SnapshotFacts;
  const title = typeof s?.title === "string" ? s.title.trim() : "";

  const seriesTitles =
    observation.sourceKey === "ann" && annContext ? annContext.names : workTitles;
  const ownWork = (work: string) => seriesTitles.some((t) => sameWorkTitle(t, work));

  let reading: BookReading;
  if (observation.sourceKey === "ann" && s?.kind === "annRelease") {
    const line = observation.snapshot as AnnReleaseSnapshot;
    const entry = annContext
      ? null
      : await ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "ann").eq("sourceRecordId", `manga:${line.mangaId}`),
          )
          .unique();
    const entryTitle = annContext
      ? annContext.parentTitle
      : (entry?.snapshot as { title?: unknown } | undefined)?.title;
    reading = readAnnLine(
      line,
      nonEmpty(entryTitle) && ownWork(entryTitle) ? entryTitle : "",
      seriesTitles,
      annContext,
    );
  } else {
    reading = readTitledRecord(observation.sourceKey, title, s, seriesTitles);
  }
  if (observation.sourceKey === "ann") {
    const segmented = readAnnLineTitle(title, { names: seriesTitles });
    if (segmented.kind === "ambiguous") reading.unreadable.push(segmented.reason);
    else if (segmented.kind === "line") reading.work = segmented.work;
  }
  if (BRACKETED.test(title)) reading.packaging.push(`the bracketed part of "${title}"`);
  if (isNovelTitle(title)) reading.scope.push("its title marks a novel");
  const outOfScope = outOfScopeReason(title);
  if (outOfScope !== null) reading.scope.push(`its title reads ${outOfScope}`);

  if (title === "") reading.unreadable.push("The record gives no title to read the book from.");
  return reading;
}

/**
 * Why the record is not a printing of the Release's one Volume, or null:
 * the content check every decision passes before ownership is read. The
 * record must read as one Volume of a work titled as one of the Release's
 * Series (releaseSeries), with nothing marking it packaging, out of scope,
 * or unreadable, and no plainly stated Binding other than the Release's;
 * and the Release's Edition must collect exactly that one whole Volume, an
 * active Volume whose own Series, followed through merges, is one of those
 * Series by ID (a Series merely titled the same is another work). An
 * Edition Line member with only that Volume counts. Packaging is refused
 * whole for now: a packaged printing waits until its line, position and
 * coverage can be compared with the Edition's.
 */
export async function contentRefusal(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
  series: Array<Doc<"series">>,
  annContext?: AnnWorkContext,
): Promise<string | null> {
  const title = (observation.snapshot as SnapshotFacts)?.title;
  if (typeof title !== "string" || title.trim() === "")
    return "The record gives no title to read the book from.";
  const context =
    observation.sourceKey === "ann" && series.some((one) => one._id === annContext?.seriesId)
      ? annContext
      : undefined;
  const seriesTitles = context?.names ?? series.map((one) => one.title);
  const ownWork = (work: string) => seriesTitles.some((t) => sameWorkTitle(t, work));
  const reading = await readObservationBook(ctx, observation, series, seriesTitles, context);
  if (reading.scope.length > 0) {
    return `The record is outside the catalog: ${[...new Set(reading.scope)].join("; ")}.`;
  }
  if (reading.unreadable.length > 0) {
    return `The record cannot be read as one book: ${reading.unreadable.join("; ")}.`;
  }
  if (reading.packaging.length > 0) {
    return `The record reads as packaging (${[...new Set(reading.packaging)].join("; ")}): a printing is recorded only of one whole Volume until packaged printings can be compared.`;
  }
  if (!ownWork(reading.work)) {
    return `The record's work "${reading.work}" is not the Release's Series (${seriesTitles.map((t) => `"${t}"`).join(", ") || "none"}).`;
  }
  if (reading.label === undefined && reading.needsLabel) {
    return "The record states no Volume anywhere (its line, designator, title or page), and its source numbers every book: which Volume it is is unknown.";
  }
  const targets = new Set(bindingFacts(release.binding));
  if (targets.size > 1)
    return "The Release states conflicting Binding facts (hardcover and paperback).";
  const target = [...targets][0];
  if (reading.binding !== undefined && target !== undefined && reading.binding !== target) {
    return `The record is a ${reading.binding} book; the Release is ${target}. Another Binding is another Release, not another printing of this one.`;
  }

  // The Release's contents: exactly one whole Volume of one of its Series.
  const edition = await ctx.db.get(release.editionId);
  if (edition === null || edition.status !== "active" || edition.locked) {
    return "The Release's Edition is not an active Edition.";
  }
  if (edition.coverageUnmapped) return "The Release's Edition does not say what it collects.";
  if (edition.editionLineId !== undefined) {
    const line = await canonicalRecord(ctx, "editionLines", edition.editionLineId);
    if (!("doc" in line) || line.doc.status !== "active" || line.doc.locked) {
      return "The Release's Edition Line cannot be followed to an active Edition Line.";
    }
  }
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
    .take(2);
  const [row] = coverage;
  if (row === undefined || coverage.length > 1 || row.extent !== "complete") {
    return "The Release's Edition does not collect exactly one whole Volume.";
  }
  const volume = await canonicalRecord(ctx, "volumes", row.volumeId);
  if (!("doc" in volume) || volume.doc.status !== "active" || volume.doc.locked) {
    return "The Release's Volume cannot be followed to an active Volume.";
  }
  const volumeSeries = await canonicalRecord(ctx, "series", volume.doc.seriesId);
  if (
    !("doc" in volumeSeries) ||
    volumeSeries.doc.status !== "active" ||
    volumeSeries.doc.locked ||
    !series.some((one) => one._id === volumeSeries.doc._id) ||
    (context && context.seriesId !== volumeSeries.doc._id)
  ) {
    return "The Release's Volume is not a Volume of the Release's own Series.";
  }
  if (reading.label !== undefined && !labelsEqual(volume.doc.label, reading.label)) {
    return `The record is Volume ${reading.label}; the Release is Volume ${volume.doc.label ?? "(unlabeled)"}.`;
  }
  return null;
}

// ---------- the decision ----------

const decisionArgs = {
  observationId: v.id("sourceObservations"),
  releaseId: v.id("releases"),
  reason: v.string(),
  evidenceUrl: v.optional(v.string()),
};

/** What a decision did: recorded a new printing, linked a record of one, or refused. */
type Decided =
  | { status: "recorded"; isbn13: string }
  | { status: "linked"; isbn13: string; releaseId: Id<"releases">; proposalId: Id<"proposals"> }
  | { status: "refused"; reason: string };

/**
 * Record one held book as another printing of a Release, or link it to a
 * printing the Release already has, as decided by a person or a reviewed
 * agent. Refused with a reason, never thrown, so a script can log it and go
 * on; a refusal writes nothing and the book stays held. In order:
 *
 * - the record: not withdrawn or linked, every ISBN it states valid and
 *   naming one book, not digital, and a citation (`evidenceUrl`, else the
 *   record's own URL) that is an absolute http(s) URL;
 * - the Release: active, unlocked, physical, with the book held under one
 *   of its Series and any publisher the record names its own;
 * - the contents (contentRefusal): one whole Volume, the Release's;
 * - ownership (lib/releaseIsbns.ts isbnClaims): an ISBN that is the
 *   Release's own, or that of a Release merged into it, is refused; so is
 *   one any other Release (active or hidden) or a Bundle claims, or whose
 *   claims cannot all be read and followed.
 *
 * Then a new printing is `recorded` (lib/printings.ts recordPrinting): the
 * row, the record's mark and link, and an approved Proposal with an
 * `otherPrinting` Revision. A printing the Release already has is `linked`
 * (linkRecordedPrinting): the mark and link, with an approved Proposal and
 * a `sourceObservation` Revision of their own.
 *
 * The whole decision runs as a nested mutation capped at what the
 * transaction has left (lib/bounded.ts): one too large for a transaction
 * (claims too large to read whole, say) is `refused` like any other, with
 * nothing written, so a batch script logs it and goes on.
 *
 *   npx convex run printings:recordDecidedInternal '{"observationId": "…",
 *     "releaseId": "…", "reason": "…", "evidenceUrl": "https://…"}'
 */
export const recordDecidedInternal = internalMutation({
  args: decisionArgs,
  handler: async (ctx, args): Promise<Decided> => {
    const transactionLimits = await nestedLimits(ctx);
    try {
      return await ctx.runMutation(internal.printings.decideInternal, args, { transactionLimits });
    } catch (error) {
      return {
        status: "refused",
        reason: `The decision needs more than one transaction can read or write (${platformStop(error)}); nothing was recorded, and the book stays held.`,
      };
    }
  },
});

/** The decision itself (recordDecidedInternal), run only as its nested mutation. */
export const decideInternal = internalMutation({
  args: decisionArgs,
  handler: async (ctx, { observationId, releaseId, reason, evidenceUrl }): Promise<Decided> => {
    const refuse = (why: string) => ({ status: "refused" as const, reason: why });
    if (reason.trim() === "") return refuse("A decided printing needs a reason.");

    const observation = await ctx.db.get(observationId);
    if (observation === null) return refuse("No such source record.");
    if (observation.withdrawn) return refuse("Its source no longer lists the book.");
    if (observation.recordRef !== undefined) {
      return refuse("The book's record is already linked to a record.");
    }
    const snapshot = observation.snapshot as SnapshotFacts;
    const decided = decidedIsbn13(snapshot);
    if ("refusal" in decided) return refuse(decided.refusal);
    const { isbn13 } = decided;
    const scope = await isbnScope(ctx, isbn13);
    if (scope) return refuse(scope);
    if (
      observation.queuedProposalId &&
      (await ctx.db.get(observation.queuedProposalId))?.state === "inReview"
    )
      return refuse("A Proposal of the book is in review.");
    const citation = decidedCitationUrl(evidenceUrl, snapshot);
    if ("refusal" in citation) return refuse(citation.refusal);

    const release = await ctx.db.get(releaseId);
    if (release === null) return refuse("No such Release.");
    if (release.status !== "active") return refuse(`The Release is ${release.status}.`);
    if (release.locked) return refuse("The Release is locked.");
    if (release.format !== "physical") return refuse("The Release is not physical.");
    const work = await releaseSeries(ctx, release);
    if ("refusal" in work) return refuse(work.refusal);
    if (
      saysDigital(
        snapshot,
        work.series.map((one) => one.title),
      )
    ) {
      return refuse("The record calls the book digital.");
    }
    const slot = await slotRefusal(ctx, observation, release, work.series, snapshot);
    if (slot !== null) return refuse(slot);
    const content = await contentRefusal(ctx, observation, release, work.series);
    if (content !== null) return refuse(content);

    // Every claim on the ISBN, merges followed. The Release's own ISBN (or
    // that of a Release merged into it) comes first, even when a row from
    // before a promotion also holds it: a record of its own printing is
    // linked to it, not recorded as another printing.
    const claims = await isbnClaims(ctx, isbn13, { resolver: claimResolver(ctx) });
    if (claims === null) return refuse(`ISBN ${isbn13} is not an ISBN.`);
    const ownClaims = claims.owners.get(release._id)?.claims ?? [];
    const own = ownClaims.find((claim) => claim.on === "release" && claim.via !== "printing");
    if (own !== undefined || primaryIsbnsOf(release).has(isbn13)) {
      const merged = own !== undefined && own.storedId !== release._id;
      return refuse(
        `ISBN ${isbn13} is the Release's own${merged ? `, as the ISBN of Release ${own.storedId} merged into it` : ""}: a record of its own printing is linked to it, not recorded as another printing.`,
      );
    }
    const ownership = printedClaimRefusal(claims, release._id);
    if (ownership !== null) return refuse(ownership);

    const source = await getSourceByKey(ctx, observation.sourceKey);
    const decision = {
      release,
      isbn13,
      reason,
      sourceKey: observation.sourceKey,
      observationId,
      citation: {
        sourceName: `${source?.name ?? observation.sourceKey} (decided by review)`,
        url: citation.url,
      },
      now: Date.now(),
    };
    if (ownClaims.length > 0) {
      const proposalId = await linkRecordedPrinting(ctx, decision);
      return { status: "linked", isbn13, releaseId, proposalId };
    }
    const pubDate = observedDate(snapshot);
    await recordPrinting(ctx, { ...decision, ...(pubDate !== undefined ? { pubDate } : {}) });
    return { status: "recorded", isbn13 };
  },
});

// ---------- the consistency check ----------

/** Items one page of the check inspects at most. */
const CHECK_PAGE = 100;
/**
 * The most a page's own read may take (`paginationOpts.maximumBytesRead`,
 * this when omitted): the rest of the transaction is its items' joins.
 */
const CHECK_PAGE_BYTES = 4 * MAX_DOCUMENT_BYTES;

/** Thrown inside one item's joins when the transaction cannot afford its next read. */
class OutOfRoom extends Error {}

/** One thing the check found, and how bad it is. */
type Finding = {
  /**
   * `violation`: the ownership invariant (lib/releaseIsbns.ts) is broken,
   * or a stored ISBN is spelled so that no ownership check finds it.
   * `incomplete`: this item was not fully inspected. `diagnostic`: history
   * worth a look (a record unlinked since, a mark nobody owns any more),
   * not corruption.
   */
  severity: "violation" | "incomplete" | "diagnostic";
  isbn13?: string;
  rowId?: Id<"releaseIsbns">;
  observationId?: Id<"sourceObservations">;
  releaseId?: Id<"releases">;
  bundleId?: Id<"releaseBundles">;
  message: string;
};

/** The one Release owner of a printed ISBN, or the finding that says why there is none. */
function soleOwner(
  claims: IsbnClaims,
): { owner: Doc<"releases"> } | { finding: Omit<Finding, "rowId" | "observationId"> } {
  const isbn13 = claims.isbn13;
  if (!claims.complete) {
    return {
      finding: {
        severity: "incomplete",
        isbn13,
        message: `ISBN ${isbn13} has more than ${CLAIM_SCAN} stored claims of one kind; not all were read.`,
      },
    };
  }
  const why = claims.unresolved[0]?.reason;
  if (why !== undefined) {
    return {
      finding: {
        severity: "violation",
        isbn13,
        message: `A claim on ISBN ${isbn13} cannot be followed: ${why}.`,
      },
    };
  }
  const owners = [...claims.owners.values()];
  const bundle = owners.find((owner) => owner.kind === "bundle");
  if (bundle !== undefined) {
    return {
      finding: {
        severity: "violation",
        isbn13,
        message: `ISBN ${isbn13} has other printings and is also Release Bundle ${bundle.doc._id}'s.`,
      },
    };
  }
  const [only] = owners;
  if (only === undefined) {
    return {
      finding: {
        severity: "diagnostic",
        isbn13,
        message: `Nobody claims ISBN ${isbn13} any more.`,
      },
    };
  }
  if (owners.length > 1 || only.kind !== "release") {
    return {
      finding: {
        severity: "violation",
        isbn13,
        message: `ISBN ${isbn13} is claimed by ${owners.length} records: ${owners.map((o) => o.doc._id).join(", ")}.`,
      },
    };
  }
  return { owner: only.doc };
}

/** Where a record's link ends: the canonical Release, or why it cannot be followed. */
async function linkedRelease(
  resolver: ClaimResolver,
  observation: Doc<"sourceObservations">,
): Promise<{ release: Doc<"releases"> } | { problem: string } | null> {
  const ref = observation.recordRef;
  if (ref === undefined) return null;
  if (ref.type !== "release") return { problem: `it links a ${ref.type}, not a Release` };
  const resolved = await resolver.release(ref.id);
  return "doc" in resolved ? { release: resolved.doc } : { problem: resolved.unresolved };
}

/** The tables the check pages through, by pass. */
const PASS_TABLES = {
  rows: "releaseIsbns",
  observations: "sourceObservations",
  releases: "releases",
  bundles: "releaseBundles",
} as const;
type Pass = keyof typeof PASS_TABLES;

/**
 * One page of the Other Printings consistency check, read-only, for an
 * operator to walk to the end (docs/operations.md). Four passes:
 *
 * - `releases` and `bundles` read every Release and Bundle: an ISBN stored
 *   in a spelling its index cannot find under the ISBN's own key (lib/
 *   isbn.ts isbnHiddenFromIndex: hyphens, a lower-case x, an ISBN-10 kept
 *   as `isbn13`) is a violation. Every other check reads exact keys, so
 *   until these two passes are clean, nothing the other two find, or do
 *   not find, is complete.
 * - `rows` reads `releaseIsbns`: each row's ISBN must be valid, stored as
 *   its key, and have one owner, a physical Release, with no Bundle
 *   claiming it (violations). The row itself counts as a claim whatever its
 *   spelling, so a row the exact read misses still meets the others. A row
 *   whose evidence record is gone or now links elsewhere is a diagnostic.
 * - `observations` reads every source record and checks the marked ones: a
 *   mark must be a valid ISBN, on a record linked to a Release, whose one
 *   owner is that Release (merges followed; the Release may hold it as its
 *   own after a promotion); a mark nobody owns, or on an unlinked record, is
 *   a diagnostic.
 *
 * Pages are native: `paginationOpts` goes to `.paginate()` with all its
 * fields; `maximumBytesRead` may be at most CHECK_PAGE_BYTES and is that
 * when omitted (a page of large records stops early and its cursor goes
 * on), and `numItems` at most CHECK_PAGE. Each item's joins read one
 * document at a time while the transaction can afford the largest; an
 * item they could not finish, and every item after it, is reported
 * `incomplete` by ID, never passed over. The catalog is checked once all
 * four passes reach `isDone` with no `incomplete` finding, and clean when
 * there is also no violation. It reads ownership and evidence only, never
 * whether two books are the same.
 *
 *   npx convex run printings:consistencyInternal \
 *     '{"pass": "releases", "paginationOpts": {"numItems": 100, "cursor": null}}'
 */
export const consistencyInternal = internalQuery({
  args: {
    pass: v.union(
      v.literal("rows"),
      v.literal("observations"),
      v.literal("releases"),
      v.literal("bundles"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { pass, paginationOpts }) => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > CHECK_PAGE) {
      throw new ConvexError({
        code: "invalidArgs",
        message: `A page inspects 1 to ${CHECK_PAGE} items.`,
      });
    }
    const bytes = paginationOpts.maximumBytesRead;
    if (bytes !== undefined && (bytes < 1 || bytes > CHECK_PAGE_BYTES)) {
      throw new ConvexError({
        code: "invalidArgs",
        message: `A page reads at most ${CHECK_PAGE_BYTES} bytes (maximumBytesRead), leaving the rest for its checks.`,
      });
    }
    const page = await ctx.db
      .query(PASS_TABLES[pass])
      .paginate({ ...paginationOpts, maximumBytesRead: bytes ?? CHECK_PAGE_BYTES });
    const room = readRoom(ctx, {}, () => {
      throw new OutOfRoom();
    });
    const resolver = claimResolver(ctx, { room });
    const findings: Finding[] = [];
    let inspected = 0;
    for (const item of page.page) {
      try {
        findings.push(...(await checkItem(ctx, pass, item, resolver, room)));
      } catch (error) {
        if (!(error instanceof OutOfRoom)) throw error;
        for (const left of page.page.slice(inspected)) {
          findings.push({
            severity: "incomplete",
            ...idOf(pass, left),
            message:
              "Read but not inspected: the transaction could not afford its checks. Check this page again with fewer items.",
          });
        }
        break;
      }
      inspected++;
    }
    return {
      findings,
      scanned: page.page.length,
      inspected,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

type PassItem =
  | Doc<"releaseIsbns">
  | Doc<"sourceObservations">
  | Doc<"releases">
  | Doc<"releaseBundles">;

/** An item's ID in its pass's Finding field. */
function idOf(pass: Pass, item: PassItem): Partial<Finding> {
  switch (pass) {
    case "rows":
      return { rowId: item._id as Id<"releaseIsbns"> };
    case "observations":
      return { observationId: item._id as Id<"sourceObservations"> };
    case "releases":
      return { releaseId: item._id as Id<"releases"> };
    case "bundles":
      return { bundleId: item._id as Id<"releaseBundles"> };
  }
}

function checkItem(
  ctx: QueryCtx,
  pass: Pass,
  item: PassItem,
  resolver: ClaimResolver,
  room: Room,
): Promise<Finding[]> {
  switch (pass) {
    case "rows":
      return checkRow(ctx, resolver, room, item as Doc<"releaseIsbns">);
    case "observations":
      return checkMark(ctx, resolver, room, item as Doc<"sourceObservations">);
    case "releases":
    case "bundles":
      return Promise.resolve(checkKeys(pass, item as Doc<"releases"> | Doc<"releaseBundles">));
  }
}

/** The key passes, for one Release or Bundle: each ISBN stored as its index finds it. */
function checkKeys(pass: "releases" | "bundles", doc: Doc<"releases"> | Doc<"releaseBundles">) {
  const what = pass === "releases" ? `Release ${doc._id}` : `Release Bundle ${doc._id}`;
  const fix =
    pass === "releases" ? "a repair updateFields entry" : "a Proposal updating the Bundle";
  return (["isbn13", "isbn10"] as const).flatMap((field): Finding[] =>
    isbnHiddenFromIndex(field, doc[field])
      ? [
          {
            severity: "violation",
            isbn13: toIsbn13(doc[field]),
            ...(pass === "releases"
              ? { releaseId: doc._id as Id<"releases"> }
              : { bundleId: doc._id as Id<"releaseBundles"> }),
            message: `${what} stores its ${field} as "${doc[field]}", a spelling no ownership check reads (they read ${isbnFieldValue(field, doc[field]!) ?? "no ISBN-10 for a 979 ISBN"}): store it so (${fix}).`,
          },
        ]
      : [],
  );
}

/** The rows pass, for one `releaseIsbns` row. */
async function checkRow(
  ctx: QueryCtx,
  resolver: ClaimResolver,
  room: Room,
  row: Doc<"releaseIsbns">,
): Promise<Finding[]> {
  const claims = await isbnClaims(ctx, row.isbn13, { resolver, room });
  if (claims === null) {
    return [
      {
        severity: "violation",
        rowId: row._id,
        message: `Row ${row._id}'s ISBN "${row.isbn13}" is no valid ISBN.`,
      },
    ];
  }
  const isbn13 = claims.isbn13;
  const findings: Finding[] = [];
  if (row.isbn13 !== isbn13) {
    findings.push({
      severity: "violation",
      isbn13,
      rowId: row._id,
      message: `Row ${row._id} stores its ISBN as "${row.isbn13}", which no ownership check reads (they read ${isbn13}): store it so.`,
    });
  }
  // The row is a claim whatever its spelling: one the exact read did not
  // return still meets the claims it did.
  const listed = [...claims.owners.values()]
    .flatMap((owner) => owner.claims)
    .concat(claims.unresolved.map(({ claim }) => claim))
    .some((claim) => claim.on === "release" && claim.rowId === row._id);
  if (!listed) {
    await addClaim(
      claims,
      { on: "release", via: "printing", storedId: row.releaseId, rowId: row._id },
      resolver,
    );
  }
  const sole = soleOwner(claims);
  if ("finding" in sole) return [...findings, { ...sole.finding, rowId: row._id }];
  if (sole.owner.format !== "physical") {
    findings.push({
      severity: "violation",
      isbn13,
      rowId: row._id,
      message: `ISBN ${isbn13}'s owner, Release ${sole.owner._id}, is not physical.`,
    });
  }
  if (row.observationId !== undefined) {
    await room();
    const observation = await ctx.db.get(row.observationId);
    const link = observation === null ? null : await linkedRelease(resolver, observation);
    const message =
      observation === null
        ? "The record the decision came from is gone."
        : link === null
          ? "The record the decision came from is unlinked now."
          : "problem" in link
            ? `The record the decision came from cannot be followed: ${link.problem}.`
            : link.release._id !== sole.owner._id
              ? `The record the decision came from now links Release ${link.release._id}.`
              : null;
    if (message !== null) {
      findings.push({
        severity: "diagnostic",
        isbn13,
        rowId: row._id,
        observationId: row.observationId,
        message,
      });
    }
  }
  return findings;
}

/** The observations pass, for one source record (unmarked records pass). */
async function checkMark(
  ctx: QueryCtx,
  resolver: ClaimResolver,
  room: Room,
  observation: Doc<"sourceObservations">,
): Promise<Finding[]> {
  const mark = observation.printingIsbn13;
  if (mark === undefined) return [];
  const observationId = observation._id;
  const isbn13 = toIsbn13(mark);
  if (isbn13 === undefined) {
    return [
      { severity: "violation", observationId, message: `Its mark "${mark}" is no valid ISBN.` },
    ];
  }
  const link = await linkedRelease(resolver, observation);
  if (link === null) {
    return [
      {
        severity: "diagnostic",
        isbn13,
        observationId,
        message: `An unlinked record still carries the mark ${isbn13}.`,
      },
    ];
  }
  if ("problem" in link) {
    return [
      {
        severity: "violation",
        isbn13,
        observationId,
        message: `A marked record's link cannot be followed: ${link.problem}.`,
      },
    ];
  }
  const claims = (await isbnClaims(ctx, isbn13, { resolver, room }))!;
  const sole = soleOwner(claims);
  if ("finding" in sole) return [{ ...sole.finding, observationId }];
  if (sole.owner._id !== link.release._id) {
    return [
      {
        severity: "violation",
        isbn13,
        observationId,
        message: `It is marked ISBN ${isbn13}, which Release ${sole.owner._id} owns, but links Release ${link.release._id}.`,
      },
    ];
  }
  return [];
}

// Live-compatible held-link validators. Context is optional for old callers;
// execution requires a current expanded preview before a decision can write.
const nullable = <T extends import("convex/values").Validator<unknown, "required", string>>(
  validator: T,
) => v.union(validator, v.null());
export const linkGuard = v.object({
  snapshot: v.string(),
  context: v.optional(v.string()),
  hold: nullable(
    v.object({
      id: v.id("placementHolds"),
      kind: holdKind,
      seriesId: nullable(v.id("series")),
    }),
  ),
  queuedProposalId: nullable(v.id("proposals")),
  isbn13: nullable(v.string()),
  match: nullable(v.union(v.literal("own"), v.literal("printing"))),
  release: v.object({
    revisionId: nullable(v.id("revisions")),
    editionId: v.id("editions"),
    format: releaseFormat,
    binding: nullable(v.string()),
    language: v.string(),
    isbn13: nullable(v.string()),
    isbn10: nullable(v.string()),
    publisherId: v.id("publishers"),
    seriesIds: v.array(v.id("series")),
  }),
  edition: v.object({
    revisionId: nullable(v.id("revisions")),
    editionLineId: nullable(v.id("editionLines")),
    linePosition: nullable(v.string()),
    coverageUnmapped: v.boolean(),
    coverage: v.array(
      v.object({
        volumeId: v.id("volumes"),
        extent: v.union(v.literal("complete"), v.literal("partial")),
      }),
    ),
  }),
  matureSeriesIds: v.array(v.id("series")),
});
export type LinkGuard = Infer<typeof linkGuard>;

export const linkHeldStateInternal = internalQuery({
  args: { observationId: v.id("sourceObservations"), releaseId: v.id("releases") },
  handler: async (ctx, args) => {
    try {
      const state = await heldState(ctx, args.observationId, {
        type: "release",
        id: args.releaseId,
      });
      const target = state.contents!;
      const revision = async (type: "release" | "edition", id: Id<"releases"> | Id<"editions">) =>
        (
          await ctx.db
            .query("revisions")
            .withIndex("by_record", (q) => q.eq("ref.type", type).eq("ref.id", id))
            .order("desc")
            .first()
        )?._id ?? null;
      const flips = await matureFlipsOf(ctx, {
        ...state.observation,
        recordRef: { type: "release", id: args.releaseId },
      });
      const guard: LinkGuard = {
        context: state.expected,
        snapshot: valueHash(state.observation.snapshot),
        hold: state.hold
          ? { id: state.hold._id, kind: state.hold.kind, seriesId: state.hold.seriesId ?? null }
          : null,
        queuedProposalId: state.observation.queuedProposalId ?? null,
        isbn13: state.isbn13,
        match:
          state.isbn13 && primaryIsbnsOf(target.release).has(state.isbn13) ? "own" : "printing",
        release: {
          revisionId: await revision("release", args.releaseId),
          editionId: target.edition._id,
          format: target.release.format,
          binding: target.release.binding ?? null,
          language: target.release.language,
          isbn13: target.release.isbn13 ?? null,
          isbn10: target.release.isbn10 ?? null,
          publisherId: target.release.publisherId,
          seriesIds: target.release.seriesIds,
        },
        edition: {
          revisionId: await revision("edition", target.edition._id),
          editionLineId: target.edition.editionLineId ?? null,
          linePosition: target.edition.linePosition ?? null,
          coverageUnmapped: target.edition.coverageUnmapped === true,
          coverage: target.contents.map((c) => ({ volumeId: c.volume._id, extent: c.extent })),
        },
        matureSeriesIds: flips.map((s) => s._id),
      };
      const preview: { refusal?: string | null } = await ctx.runQuery(
        internal.heldBooks.previewInternal,
        { observationId: args.observationId, target: { type: "release", id: args.releaseId } },
      );
      return { guard, refusal: preview.refusal ?? null };
    } catch (error) {
      return {
        guard: null,
        refusal:
          error instanceof ConvexError
            ? String(
                typeof error.data === "object" && error.data !== null && "held" in error.data
                  ? error.data.held
                  : error.data,
              )
            : String(error),
      };
    }
  },
});

export const linkHeldInternal = internalMutation({
  args: {
    actor: v.string(),
    observationId: v.id("sourceObservations"),
    releaseId: v.id("releases"),
    reason: v.string(),
    evidenceUrls: v.array(v.string()),
    expected: linkGuard,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: string;
    reason?: string;
    proposalId?: Id<"proposals">;
    ledgerId?: Id<"heldRepairLedger">;
  }> => {
    if (!args.expected.context)
      return {
        status: "refused",
        reason:
          "Read a new held-link preview with complete source/content context before execution.",
      };
    const current: { guard: LinkGuard | null; refusal: string | null } = await ctx.runQuery(
      internal.printings.linkHeldStateInternal,
      { observationId: args.observationId, releaseId: args.releaseId },
    );
    if (current.refusal || !sameValue(args.expected, current.guard))
      return {
        status: "refused",
        reason: current.refusal ?? "The state differs from the reviewed one.",
      };
    const result = await ctx.runMutation(internal.heldBooks.executeInternal, {
      actor: args.actor,
      observationId: args.observationId,
      target: { type: "release", id: args.releaseId },
      reason: args.reason,
      evidenceUrls: args.evidenceUrls,
      expected: args.expected.context,
      operation: "link",
    });
    return { ...result, status: result.status === "applied" ? "linked" : result.status };
  },
});
