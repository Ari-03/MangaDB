// Other Printings decided by a person (CONTEXT.md, docs/operations.md):
// the only way a held book becomes another printing of a Release, or a
// further record of one is linked to it. No importer records one on its
// own; the Data Team, or an agent whose decision a reviewer checked,
// decides it with evidence, and this records it through the shared writes
// (lib/printings.ts) after checking the invariants nothing may break. The
// consistency check at the end reads the whole catalog's printing claims
// for an operator, a page at a time.

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { type AnnReleaseSnapshot, lineOutOfScope, packagingOf } from "./ann";
import { getSourceByKey } from "./importSources";
import { splitReleaseTitle } from "./lib/ann";
import { canonicalLabel, isNovelTitle, outOfScopeReason, parseBookTitle } from "./lib/bookTitle";
import { toIsbn13 } from "./lib/isbn";
import { labelsEqual } from "./lib/matching";
import { mergeSurvivor } from "./lib/merges";
import { holdOf } from "./lib/observations";
import { findPublisherByName, toPartialDate } from "./lib/pipeline";
import { linkRecordedPrinting, recordPrinting } from "./lib/printings";
import {
  type Budget,
  budgetShortfall,
  CLAIM_SCAN,
  type ClaimResolver,
  claimResolver,
  type IsbnClaims,
  isbnClaims,
  MAX_DOCUMENT_BYTES,
  primaryIsbnsOf,
  printedClaimRefusal,
  statedIsbns,
} from "./lib/releaseIsbns";
import { isMangaBook } from "./lib/sevenSeas";
import { decodeEntities } from "./lib/text";

/** A snapshot's date parts, as each source stores them (ANN's page first). */
type DateLike = { year?: unknown; month?: unknown; day?: unknown };

/** The fields of a source record these checks read, whichever source's shape it has. */
type SnapshotFacts = {
  kind?: unknown;
  url?: unknown;
  title?: unknown;
  format?: unknown;
  binding?: unknown;
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

// An ebook as the sources write it: ANN's "eBook 3" designator, Open
// Library's "Kindle Edition" or "ebook" format, a title's "(Digital Edition)".
const DIGITAL_TEXT = /\be-?books?\b|\bkindle\b|\bdigital (?:edition|version)\b/i;

/** The record calls the book digital: its format, binding, designator or title. */
function saysDigital(s: SnapshotFacts): boolean {
  if (s?.format === "digital") return true;
  return [s?.binding, s?.title, s?.page?.volume, s?.page?.title].some(
    (text) => typeof text === "string" && DIGITAL_TEXT.test(text),
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
 * Why the held book's Series or publisher is not the Release's, or null:
 * its hold's Series, followed through merges, must be one of the Release's
 * Series, and a publisher the record names must resolve to the Release's
 * publisher (followed through merges too).
 */
async function slotRefusal(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
  s: SnapshotFacts,
): Promise<string | null> {
  const hold = await holdOf(ctx, observation._id);
  if (hold?.seriesId === undefined) return "The book is not held under a Series.";
  const heldSeries = await mergeSurvivor(ctx, "series", await ctx.db.get(hold.seriesId));
  const releaseSeries = await Promise.all(
    release.seriesIds.map(
      async (id) => (await mergeSurvivor(ctx, "series", await ctx.db.get(id)))?._id,
    ),
  );
  if (heldSeries === null || !releaseSeries.includes(heldSeries._id)) {
    return `The book is held under ${heldSeries ? `"${heldSeries.title}"` : "a Series that no longer exists"}, which is not the Release's Series.`;
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
  /** Why it reads as more (or other) than one Volume: any one refuses for now. */
  packaging: string[];
  /** Why it is outside the catalog (a novel, a non-English book, …). */
  scope: string[];
  /** Why the record cannot be read with certainty: statements that disagree. */
  unreadable: string[];
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const BRACKETED = /\[[^\]]*\]/;

/**
 * The work and Volume an ANN release line states, from each of its
 * statements separately: the line's title, the release page's designator
 * (re-read with today's parser), the page's own title and manga entry, and
 * the stored flags. A stored flag is evidence, never the authority: a fresh
 * reading that disagrees with it is unreadable, and either one saying
 * packaging is packaging. A missing statement is unknown; a designator that
 * no longer reads is unreadable. `entryName` is the entry's title, trusted
 * to own the packaging words in the line's title only when it is one of
 * the Release's Series titles.
 *
 * Integration point (docs/operations.md): with the fixed ANN line reader
 * (lib/ann.ts readAnnLineTitle and lib/matching.ts sameWorkTitle), this is
 * the one place that reading replaces the work and packaging read here.
 */
function readAnnLine(line: AnnReleaseSnapshot, entryName: string): BookReading {
  const reading: BookReading = {
    work: line.title,
    label: line.label !== undefined ? canonicalLabel(line.label) : undefined,
    packaging: [],
    scope: [],
    unreadable: [],
  };
  if (line.multi) reading.packaging.push("a multi-volume designator");
  if (line.editionLineHint) reading.packaging.push("a packaging designator or title");
  if (line.coverRange) {
    reading.packaging.push(`a stated range (${line.coverRange.from}-${line.coverRange.to})`);
  }
  if (line.coverageGapped) reading.packaging.push("a Volume list no range holds");
  const named = packagingOf(line);
  if (named !== null) reading.packaging.push(`the line name ${named.name}`);
  const outOfScope = lineOutOfScope(line);
  if (outOfScope !== null) reading.scope.push(outOfScope);

  const page = line.page?.status === "ok" ? line.page : undefined;
  if (nonEmpty(page?.volume)) {
    const fresh = splitReleaseTitle(`${line.title} (${page.volume})`, entryName);
    if (fresh === null) {
      reading.unreadable.push(`ANN's designator "${page.volume}" does not read as one book`);
    } else {
      const label = fresh.label !== undefined ? canonicalLabel(fresh.label) : undefined;
      const stated = [
        ["Volume", label, reading.label],
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
      reading.label = label;
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
  if (parsed.isNovel) reading.scope.push("its title marks a novel");
  if (parsed.packaging !== null || parsed.isBox) {
    reading.packaging.push(`its title "${line.title}"`);
  }
  const bare = parsed.bareNumber || parsed.bareRoman;
  if (!bare) reading.work = parsed.seriesTitle;
  if (!bare && parsed.volumeLabel !== null) {
    if (reading.label !== undefined && !labelsEqual(parsed.volumeLabel, reading.label)) {
      reading.unreadable.push(
        `its title says Volume ${parsed.volumeLabel}, its designator Volume ${reading.label}`,
      );
    }
    reading.label ??= canonicalLabel(parsed.volumeLabel);
  }
  if (nonEmpty(page?.title)) {
    const pageTitle = splitReleaseTitle(page.title, entryName)?.title ?? page.title;
    const pageParsed = parseBookTitle(pageTitle);
    const pageWork =
      pageParsed.bareNumber || pageParsed.bareRoman ? pageTitle : pageParsed.seriesTitle;
    if (workKey(pageWork) !== workKey(reading.work)) {
      reading.unreadable.push(`ANN's page is titled "${page.title}", the line "${line.title}"`);
    }
    // The page's title is a statement of its own: packaging or a novel there counts too.
    if (pageParsed.packaging !== null || pageParsed.isBox || BRACKETED.test(page.title)) {
      reading.packaging.push(`ANN's page title "${page.title}"`);
    }
    if (pageParsed.isNovel || isNovelTitle(page.title))
      reading.scope.push("its page title marks a novel");
  }
  return reading;
}

/**
 * The work and Volume another source's record states: its title read by the
 * shared parser, checked against the fields the importer stored. A trailing
 * number the parser would split off without a Volume marker ("Kingdom
 * Hearts II") may be the work's own name, so such a reading is unreadable
 * here: a record that says "Vol." is read.
 */
function readTitledRecord(sourceKey: string, title: string, s: SnapshotFacts): BookReading {
  const parsed = parseBookTitle(title);
  const reading: BookReading = {
    work: parsed.seriesTitle,
    label: parsed.volumeLabel !== null ? canonicalLabel(parsed.volumeLabel) : undefined,
    packaging: [],
    scope: [],
    unreadable: [],
  };
  if (parsed.packaging !== null || parsed.isBox) reading.packaging.push(`its title "${title}"`);
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
  if (nonEmpty(s?.volumeLabel) && !labelsEqual(s.volumeLabel, reading.label ?? null)) {
    reading.unreadable.push(
      `its title says Volume ${reading.label ?? "none"}, its stored Volume ${s.volumeLabel}`,
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

/**
 * Why the record is not a printing of the Release's one Volume, or null:
 * the content check every decision passes before ownership is read. The
 * record must read as one Volume of a work titled as one of the Release's
 * Series, with nothing marking it packaging, out of scope, or unreadable;
 * and the Release's Edition must collect exactly that one whole Volume of
 * that Series (an Edition Line member with only that Volume counts).
 * Packaging is refused whole for now: a packaged printing waits until its
 * line, position and coverage can be compared with the Edition's.
 */
async function contentRefusal(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
): Promise<string | null> {
  const s = observation.snapshot as SnapshotFacts;
  const title = typeof s?.title === "string" ? s.title.trim() : "";
  if (title === "") return "The record gives no title to read the book from.";

  const seriesTitles: string[] = [];
  for (const id of release.seriesIds) {
    const series = await mergeSurvivor(ctx, "series", await ctx.db.get(id));
    if (series !== null && series.status !== "merged") seriesTitles.push(series.title);
  }
  const ownWork = (work: string) => seriesTitles.some((t) => workKey(t) === workKey(work));

  let reading: BookReading;
  if (observation.sourceKey === "ann" && s?.kind === "annRelease") {
    const line = observation.snapshot as AnnReleaseSnapshot;
    const entry = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "ann").eq("sourceRecordId", `manga:${line.mangaId}`),
      )
      .unique();
    const entryTitle = (entry?.snapshot as { title?: unknown } | undefined)?.title;
    reading = readAnnLine(line, nonEmpty(entryTitle) && ownWork(entryTitle) ? entryTitle : "");
  } else {
    reading = readTitledRecord(observation.sourceKey, title, s);
  }
  if (BRACKETED.test(title)) reading.packaging.push(`the bracketed part of "${title}"`);
  if (isNovelTitle(title)) reading.scope.push("its title marks a novel");
  const outOfScope = outOfScopeReason(title);
  if (outOfScope !== null) reading.scope.push(`its title reads ${outOfScope}`);

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

  // The Release's contents: exactly one whole Volume of one of its Series.
  const edition = await ctx.db.get(release.editionId);
  if (edition === null || edition.status !== "active") {
    return "The Release's Edition is not an active Edition.";
  }
  if (edition.coverageUnmapped) return "The Release's Edition does not say what it collects.";
  if (edition.editionLineId !== undefined) {
    const line = await mergeSurvivor(ctx, "editionLines", await ctx.db.get(edition.editionLineId));
    if (line === null || line.status === "merged") {
      return "The Release's Edition Line cannot be followed to an Edition Line.";
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
  const volume = await mergeSurvivor(ctx, "volumes", await ctx.db.get(row.volumeId));
  const volumeSeries =
    volume !== null ? await mergeSurvivor(ctx, "series", await ctx.db.get(volume.seriesId)) : null;
  if (
    volume === null ||
    volume.status !== "active" ||
    volumeSeries === null ||
    !ownWork(volumeSeries.title)
  ) {
    return "The Release's Volume cannot be followed to an active Volume of its Series.";
  }
  if (reading.label !== undefined && !labelsEqual(volume.label, reading.label)) {
    return `The record is Volume ${reading.label}; the Release is Volume ${volume.label ?? "(unlabeled)"}.`;
  }
  return null;
}

// ---------- the decision ----------

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
 *   npx convex run printings:recordDecidedInternal '{"observationId": "…",
 *     "releaseId": "…", "reason": "…", "evidenceUrl": "https://…"}'
 */
export const recordDecidedInternal = internalMutation({
  args: {
    observationId: v.id("sourceObservations"),
    releaseId: v.id("releases"),
    reason: v.string(),
    evidenceUrl: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { observationId, releaseId, reason, evidenceUrl },
  ): Promise<
    | { status: "recorded"; isbn13: string }
    | { status: "linked"; isbn13: string; releaseId: Id<"releases">; proposalId: Id<"proposals"> }
    | { status: "refused"; reason: string }
  > => {
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
    if (saysDigital(snapshot)) return refuse("The record calls the book digital.");
    const citation = decidedCitationUrl(evidenceUrl, snapshot);
    if ("refusal" in citation) return refuse(citation.refusal);

    const release = await ctx.db.get(releaseId);
    if (release === null) return refuse("No such Release.");
    if (release.status !== "active") return refuse(`The Release is ${release.status}.`);
    if (release.locked) return refuse("The Release is locked.");
    if (release.format !== "physical") return refuse("The Release is not physical.");
    const slot = await slotRefusal(ctx, observation, release, snapshot);
    if (slot !== null) return refuse(slot);
    const content = await contentRefusal(ctx, observation, release);
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
/** Before each item's joins: room for its claims and links, beyond the page itself. */
const CHECK_ITEM: Budget = {
  bytesRead: 2 * MAX_DOCUMENT_BYTES,
  documentsRead: 4 * (CLAIM_SCAN + 1) + 20,
  databaseQueries: 20,
};

/** One thing the check found, and how bad it is. */
type Finding = {
  /**
   * `violation`: the ownership invariant (lib/releaseIsbns.ts) is broken.
   * `incomplete`: this item was not fully inspected. `diagnostic`: history
   * worth a look (a record unlinked since, a mark nobody owns any more),
   * not corruption.
   */
  severity: "violation" | "incomplete" | "diagnostic";
  isbn13?: string;
  rowId?: Id<"releaseIsbns">;
  observationId?: Id<"sourceObservations">;
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

/**
 * One page of the Other Printings consistency check, read-only, for an
 * operator to walk to the end (docs/operations.md). Pass `rows` reads
 * `releaseIsbns`: each row's ISBN must be valid and have one owner, a
 * physical Release, with no Bundle claiming it (violations); a row whose
 * evidence record is gone or now links elsewhere is a diagnostic. Pass
 * `observations` reads every source record and checks the marked ones: a
 * mark must be a valid ISBN, on a record linked to a Release, whose one
 * owner is that Release (merges followed; the Release may hold it as its
 * own after a promotion); a mark nobody owns, or on an unlinked record, is a
 * diagnostic. Pages are native (`paginationOpts`, its byte and row limits
 * honoured), at most CHECK_PAGE items; an item whose joins the transaction
 * cannot afford is reported `incomplete`, never passed over. The catalog
 * is checked once both passes reach `isDone` with no `incomplete` finding,
 * and clean when there is also no violation. It reads ownership and
 * evidence only, never whether two books are the same.
 *
 *   npx convex run printings:consistencyInternal \
 *     '{"pass": "rows", "paginationOpts": {"numItems": 100, "cursor": null}}'
 */
export const consistencyInternal = internalQuery({
  args: {
    pass: v.union(v.literal("rows"), v.literal("observations")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { pass, paginationOpts }) => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > CHECK_PAGE) {
      throw new ConvexError({
        code: "invalidArgs",
        message: `A page inspects 1 to ${CHECK_PAGE} items.`,
      });
    }
    const resolver = claimResolver(ctx);
    const findings: Finding[] = [];
    const page =
      pass === "rows"
        ? await ctx.db.query("releaseIsbns").paginate(paginationOpts)
        : await ctx.db.query("sourceObservations").paginate(paginationOpts);
    let inspected = 0;
    for (const item of page.page) {
      const short = budgetShortfall(await ctx.meta.getTransactionMetrics(), CHECK_ITEM);
      if (short.length > 0) {
        const left = page.page.length - inspected;
        findings.push({
          severity: "incomplete",
          message: `${left} item(s) of this page were read but not inspected: the transaction is nearly spent (${short.join(", ")}). Check this page again with fewer items.`,
        });
        break;
      }
      inspected++;
      findings.push(
        ...(pass === "rows"
          ? await checkRow(ctx, resolver, item as Doc<"releaseIsbns">)
          : await checkMark(ctx, resolver, item as Doc<"sourceObservations">)),
      );
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

/** The rows pass, for one `releaseIsbns` row. */
async function checkRow(
  ctx: QueryCtx,
  resolver: ClaimResolver,
  row: Doc<"releaseIsbns">,
): Promise<Finding[]> {
  const claims = await isbnClaims(ctx, row.isbn13, { resolver });
  if (claims === null) {
    return [
      {
        severity: "violation",
        rowId: row._id,
        message: `Row ${row._id}'s ISBN "${row.isbn13}" is no valid ISBN.`,
      },
    ];
  }
  const sole = soleOwner(claims);
  if ("finding" in sole) return [{ ...sole.finding, rowId: row._id }];
  const findings: Finding[] = [];
  const isbn13 = claims.isbn13;
  if (sole.owner.format !== "physical") {
    findings.push({
      severity: "violation",
      isbn13,
      rowId: row._id,
      message: `ISBN ${isbn13}'s owner, Release ${sole.owner._id}, is not physical.`,
    });
  }
  if (row.observationId !== undefined) {
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
  const claims = (await isbnClaims(ctx, isbn13, { resolver }))!;
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
