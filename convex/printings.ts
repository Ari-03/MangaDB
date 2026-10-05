// Other Printings decided by a person (CONTEXT.md, docs/operations.md):
// the only way a held book becomes another printing of a Release. No
// importer records one on its own; the Data Team, or an agent whose
// decision a reviewer checked, decides it with evidence, and this records
// it through the shared write (lib/printings.ts recordPrinting) after
// checking the invariants nothing may break.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { isbn13CheckOk, isbn13To10 } from "./lib/isbn";
import { mergeSurvivor } from "./lib/merges";
import { holdOf } from "./lib/observations";
import { findPublisherByName, toPartialDate } from "./lib/pipeline";
import { recordPrinting } from "./lib/printings";
import { observedIsbn13 } from "./lib/releaseIsbns";

/** A snapshot's date parts, as each source stores them (ANN's page first). */
type DateLike = { year?: unknown; month?: unknown; day?: unknown };

/** The fields of a source record these checks read, whichever source's shape it has. */
type SnapshotFacts = {
  url?: unknown;
  title?: unknown;
  format?: unknown;
  binding?: unknown;
  imprint?: unknown;
  publishers?: unknown;
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

/**
 * Record one held book as another printing of a Release, as decided by a
 * person or a reviewed agent: the `releaseIsbns` row, the record's
 * `printingIsbn13` mark and link (which clears its hold), and an approved
 * Proposal with an `otherPrinting` Revision on the Release that carries
 * `reason` and cites `evidenceUrl` (else the record's own URL). It checks
 * the invariants and nothing about whether the books are the same: the
 * record is not withdrawn or linked and does not call the book digital, its
 * ISBN-13 is valid and no active Release (by ISBN-13 or ISBN-10) and no
 * other Release's printing holds it; the Release is active, unlocked and
 * physical; the book is held under one of the Release's Series; and a
 * publisher the record names is the Release's. Anything else is refused
 * with a reason, not thrown, so a script can log it and go on.
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
  ): Promise<{ status: "recorded"; isbn13: string } | { status: "refused"; reason: string }> => {
    const refuse = (why: string) => ({ status: "refused" as const, reason: why });
    if (reason.trim() === "") return refuse("A decided printing needs a reason.");

    const observation = await ctx.db.get(observationId);
    if (observation === null) return refuse("No such source record.");
    if (observation.withdrawn) return refuse("Its source no longer lists the book.");
    if (observation.recordRef !== undefined) {
      return refuse("The book's record is already linked to a record.");
    }
    const snapshot = observation.snapshot as SnapshotFacts;
    const isbn13 = observedIsbn13(snapshot);
    if (isbn13 === undefined || !/^97[89]\d{10}$/.test(isbn13) || !isbn13CheckOk(isbn13)) {
      return refuse(`The record gives no valid ISBN-13 (${isbn13 ?? "none"}).`);
    }
    if (saysDigital(snapshot)) return refuse("The record calls the book digital.");

    const release = await ctx.db.get(releaseId);
    if (release === null) return refuse("No such Release.");
    if (release.status !== "active") return refuse(`The Release is ${release.status}.`);
    if (release.locked) return refuse("The Release is locked.");
    if (release.format !== "physical") return refuse("The Release is not physical.");
    const slot = await slotRefusal(ctx, observation, release, snapshot);
    if (slot !== null) return refuse(slot);

    const isbn10 = isbn13To10(isbn13);
    const holders = [
      ...(await ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
        .collect()),
      ...(isbn10 !== undefined
        ? await ctx.db
            .query("releases")
            .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10))
            .collect()
        : []),
    ];
    if (holders.some((holder) => holder.status === "active")) {
      return refuse(`ISBN ${isbn13} is already an active Release's own.`);
    }
    const rows = await ctx.db
      .query("releaseIsbns")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .collect();
    if (rows.some((row) => row.releaseId !== releaseId)) {
      return refuse(`ISBN ${isbn13} is already another Release's printing.`);
    }

    const source = await getSourceByKey(ctx, observation.sourceKey);
    const pubDate = observedDate(snapshot);
    await recordPrinting(ctx, {
      release,
      isbn13,
      ...(pubDate !== undefined ? { pubDate } : {}),
      reason,
      sourceKey: observation.sourceKey,
      observationId,
      citation: {
        sourceName: `${source?.name ?? observation.sourceKey} (decided by review)`,
        url: evidenceUrl ?? (typeof snapshot?.url === "string" ? snapshot.url : ""),
      },
      now: Date.now(),
    });
    return { status: "recorded", isbn13 };
  },
});
