// The unmatched-placement tail (spec §6/§7): what happens to a book the
// matching ladder found no Release for. Seven Seas (`applyBook`), Kodansha
// (`applyVolume`) and the catalog-title feeds PRH and Yen Press
// (lib/catalogTitle.ts `applyCatalogTitle`) each parse their record,
// resolve its base Series and publisher, run the ladder, and hand an
// unmatched book here, in this order:
//
// 1. packaging whose coverage nothing states is held for an Editor, unless
//    Bootstrap Mode may create it as Unmapped Packaging under its line
// 2. a book under a locked Series is held, in either mode: a lock is an
//    Editor's, and an import writes nothing under it (a book with no
//    publisher is not: step 4 records it)
// 3. a ladder flag (rung ②–④) queues the pre-filled creation guess for review
// 4. with no publisher to file it under, the book is only recorded
// 5. a title naming several Series queues the guess for review
// 6. outside Bootstrap Mode, a creation gate queues the guess, unless a
//    brand-new Series would recreate a work an Editor hid (held instead,
//    whether or not a Proposal is already open)
// 7. otherwise it is created (lib/pipeline.ts createCanonicalRecords)
//
// Queueing is deduplicated per observation (lib/pipeline.ts alreadyHandled)
// and first ensures the publisher row, so approval finds it. An apply that
// reaches this tail and does not hold the book for a lock leaves no lock
// hold behind, whichever step it ends at (`holdUnderLock`); one its adapter
// ends earlier, at a scope gate, keeps a lock hold it had.
// Bootstrap Mode is read only at a step that uses it (1 and 6), unless the
// adapter already read it, so a book held or queued before those steps
// leaves app config out of its transaction's reads.
// The adapters keep everything source-shaped: parsing, source-slug series
// links, the linked-record reconcile, covers and blurbs, publisher
// resolution, box sets, and what they hold packaging with. Where sources
// still differ inside the tail, `UnmatchedOptions` names each difference.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getBootstrapMode } from "../importSources";
import type { Packaging } from "./bookTitle";
import type { CoverRequest } from "./covers";
import type { MatchOutcome } from "./matching";
import { clearHold, recordUnplaced } from "./observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  creationGates,
  ensurePublisher,
  queueCreationProposal,
  removedSeriesFor,
  type ReleasePayload,
} from "./pipeline";
import type { CanonicalPublisher } from "./publishers";

/** What a source's apply mutation returns; the tail returns it for an unmatched book. */
export type ApplyResult = {
  status:
    | "unchanged"
    | "created"
    | "updated"
    | "linked"
    | "queued"
    | "alreadyQueued"
    | "needsReview"
    | "recordOnly";
  changed: boolean;
  releaseId?: Id<"releases">;
  /** Art the action should store on the Release (Seven Seas, Kodansha). */
  cover?: CoverRequest;
  reason?: string;
};

/** A book the ladder matched to no Release, as its adapter resolved it. */
export type UnmatchedBook = {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  citation: { sourceName: string; url: string };
  /** Comment on the creation Proposal and every creation Revision. */
  importComment: string;
  /** The book's own title, as hold notes and Proposal comments quote it. */
  title: string;
  /** The ladder's verdict: rung ⑤ creation, or a flag for review. */
  match: Exclude<MatchOutcome, { kind: "match" }>;
  /** The one active Series the book belongs under, or null. */
  seriesId: Id<"series"> | null;
  seriesTitle: string;
  /** How many active Series the title names when it names several; 0 otherwise. */
  ambiguousSeries: number;
  /** The source's own series identity and blurb (Seven Seas, Kodansha), for a new Series' link. */
  seriesKey?: string;
  seriesUrl?: string;
  seriesSynopsis?: string;
  /** The book's packaging, with the note it is held with when it cannot be placed. */
  packaging: (Packaging & { hold: string }) | null;
  /** The Volume labels the book covers; [] for packaging whose coverage nothing states. */
  labels: string[];
  /** The publisher a Release is filed under; undefined when the record names none. */
  publisher: CanonicalPublisher | undefined;
  /** The publisher row the adapter resolved, which tells a hidden namesake from another house. */
  publisherId: Id<"publishers"> | null;
  release: ReleasePayload;
  /**
   * Bootstrap Mode, when the adapter has read it already: Seven Seas for
   * every unmatched book and the catalog feeds for every book, as each did
   * before the tail was shared. Kodansha leaves it to the tail.
   */
  bootstrap?: boolean;
  now: number;
};

/** The differences between sources that remain inside the tail. */
export type UnmatchedOptions = {
  /**
   * In Bootstrap Mode, a named line's member with no stated coverage is
   * created as Unmapped Packaging (CONTEXT.md) for a Moderator to map.
   * Seven Seas, PRH, Yen Press. Kodansha's adapter places no packaging: it
   * passes no labels for it, so every such book is held.
   */
  unmappedPackaging: boolean;
  /**
   * A queued ambiguity quotes the book's title and gives "ambiguous series"
   * as its reason (PRH, Yen Press: the title is all a catalog record has).
   * Seven Seas and Kodansha quote the Series title and give the count.
   */
  ambiguityQuotesBook: boolean;
};

/**
 * The note a book under a locked Series is held with. It tells a lock hold
 * from the tail's other `series` hold (a hidden work's) and from an
 * adapter's (a box set with no unique base Series); imports.ts
 * storedHoldKind lists a note it matches as a `series` hold.
 */
export const LOCK_NOTE = /^Series \d+ is locked\.$/;

/**
 * Hold a book under a locked Series, in Bootstrap Mode or out of it: a lock
 * is an Editor's, and an import creates and queues nothing under it (Open
 * Library and ANN hold the same way). The hold names the Series, for
 * whoever lifts the lock. Returns the result to answer with, or null when
 * `seriesId` is not locked; then a lock hold an earlier apply left (row and
 * note) goes, so an apply that reaches the tail or a box set's branch
 * leaves none behind, whichever way it ends from there. The tail calls it
 * for every book that gets past step 1, passing no Series for a book with
 * no publisher (which the lock does not hold, so it only drops the hold);
 * Seven Seas, PRH and Yen Press for a box set they would place as a
 * Release Bundle (the branch's other exits replace the note with their
 * own).
 */
export async function holdUnderLock(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  seriesId: Id<"series"> | null,
  now: number,
): Promise<ApplyResult | null> {
  const series = seriesId !== null ? await ctx.db.get(seriesId) : null;
  if (series?.locked) {
    await recordUnplaced(
      ctx,
      observation,
      { kind: "series", reason: `Series ${series.publicId} is locked.`, seriesId: series._id },
      now,
    );
    return { status: "recordOnly", changed: false, reason: "locked series" };
  }
  const note = observation.conflicts?.find((c) => c.field === "placement")?.reason;
  if (note !== undefined && LOCK_NOTE.test(note)) await clearHold(ctx, observation._id);
  return null;
}

/**
 * Hold, queue, or create one unmatched book (the order is the header's).
 * Returns the adapter's result; a created Release's id is on it, and the
 * adapter adds its cover.
 */
export async function placeUnmatched(
  ctx: MutationCtx,
  book: UnmatchedBook,
  options: UnmatchedOptions,
): Promise<ApplyResult> {
  const { sourceKey, observation, seriesId, seriesTitle, packaging, labels, publisher, now } = book;
  const editionLine =
    packaging?.lineName != null
      ? { name: packaging.lineName, position: packaging.linePosition }
      : undefined;
  // Each read at most once per invocation, and only by a step that needs it.
  let bootstrap = book.bootstrap;
  const bootstrapMode = async () => (bootstrap ??= await getBootstrapMode(ctx));
  let handled: boolean | undefined;
  const isHandled = async () => (handled ??= await alreadyHandled(ctx, observation));

  // Packaging with no coverage from any signal. In Bootstrap Mode a named
  // line's member is still created, as Unmapped Packaging under its line:
  // the book shows in the publisher's own numbering and a Moderator maps
  // its Volumes later. A bare range with no line name, an ambiguous Series,
  // no publisher, or steady state (which never queues a guess without
  // coverage) keeps the book on its observation instead.
  const unmapped =
    options.unmappedPackaging &&
    packaging !== null &&
    labels.length === 0 &&
    editionLine !== undefined &&
    (await bootstrapMode()) &&
    book.ambiguousSeries === 0 &&
    publisher !== undefined;
  if (packaging !== null && labels.length === 0 && !unmapped) {
    await recordUnplaced(
      ctx,
      observation,
      { kind: "packaging", reason: packaging.hold, ...(seriesId !== null ? { seriesId } : {}) },
      now,
    );
    return { status: "recordOnly", changed: false, reason: "packaging without coverage" };
  }

  // The pre-filled creation guess, deduplicated per observation. A queued
  // packaging guess carries its Edition Line, so approval files the Edition
  // under the base Series' line of that name (or creates it).
  const queue = async (comment: string, reason?: string): Promise<ApplyResult> => {
    if (await isHandled()) {
      return { status: "alreadyQueued", changed: false, reason };
    }
    // No publisher on the record: nothing reviewable to pre-fill.
    if (publisher === undefined) return { status: "needsReview", changed: false, reason };
    // The row a slug means today: created when missing, a merged one's
    // survivor. A hidden row stays hidden, and approval finds the guess stale.
    const publisherSlug = (await ensurePublisher(ctx, publisher)).slug;
    await queueCreationProposal(ctx, {
      sourceKey,
      observation,
      seriesId,
      seriesTitle,
      labels,
      editionLine,
      linePosition: packaging?.linePosition ?? undefined,
      release: { ...book.release, publisherSlug },
      now,
      comment,
    });
    return { status: reason ? "needsReview" : "queued", changed: true, reason };
  };

  // A locked Series takes no new books from an import. A book with no
  // publisher could not be created anyway, so the lock does not hold it
  // (step 4 records it); it still drops a lock hold left from before.
  const held = await holdUnderLock(
    ctx,
    observation,
    publisher !== undefined ? seriesId : null,
    now,
  );
  if (held !== null) return held;

  // Ambiguity always queues flagged (spec §6), in Bootstrap Mode or out of
  // it: the importer never merges.
  const { match } = book;
  if (match.kind === "review") {
    return await queue(
      `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`,
      match.reason,
    );
  }

  // Cannot create a Release without a publisher (spec §2).
  if (publisher === undefined) return { status: "recordOnly", changed: false };

  if (book.ambiguousSeries > 0) {
    // Same-titled Series: creating under either is a guess.
    const quoted = options.ambiguityQuotesBook ? book.title : seriesTitle;
    return await queue(
      `"${quoted}" matches ${book.ambiguousSeries} same-titled Series — the importer never guesses.`,
      options.ambiguityQuotesBook
        ? "ambiguous series"
        : `${book.ambiguousSeries} same-titled Series`,
    );
  }

  // Rung ⑤, behind the steady-state boundaries (spec §6): a single-Volume
  // Release under an existing Series creates; a brand-new Series,
  // multi-Volume Coverage, or an Edition Line always queues, pre-filled so a
  // correct guess is one click. Bootstrap Mode lifts the gates (spec §7).
  const bootstrapping = await bootstrapMode();
  const gates = creationGates({
    seriesId,
    multiVolume: labels.length > 1,
    editionLineHint: editionLine !== undefined,
  });
  if (gates.length > 0 && !bootstrapping) {
    if (seriesId === null) {
      // A brand-new Series for a work an Editor hid would undo the repair:
      // the book stays on its observation instead of the queue. It is looked
      // for before the open-Proposal check, so a book queued before the
      // Editor hid the work gets the note too (the open Proposal stays as
      // it is). The creation path makes the same check itself.
      const removed = await removedSeriesFor(ctx, {
        sourceKey,
        observation,
        seriesKey: book.seriesKey,
        seriesTitle,
        publisherId: book.publisherId,
      });
      if (removed?.kind === "hidden") {
        await recordUnplaced(ctx, observation, { kind: "series", reason: removed.reason }, now);
        return { status: "recordOnly", changed: false, reason: "hidden series" };
      }
    }
    return await queue(
      `"${book.title}" observed at ${book.citation.sourceName} needs ${gates.join(" and ")} — steady-state creation gate.${editionLine ? ` Edition Line: ${editionLine.name}.` : ""}`,
    );
  }

  const creation = await createCanonicalRecords(ctx, {
    sourceKey,
    observation,
    citation: book.citation,
    importComment: book.importComment,
    seriesId,
    seriesTitle,
    seriesKey: book.seriesKey,
    seriesUrl: book.seriesUrl,
    seriesSynopsis: book.seriesSynopsis,
    labels,
    editionLine,
    ...(unmapped ? { coverageUnmapped: true as const } : {}),
    release: { ...book.release, publisher },
    // Tag exactly what steady state would have queued (spec §7).
    tagBootstrapUnreviewed: bootstrapping && gates.length > 0,
    now,
  });
  // A Series an Editor hid, or an ISBN another record owns as a printing:
  // nothing was created, the reason is the book's hold.
  if (creation.blocked !== undefined) {
    return {
      status: "recordOnly",
      changed: creation.changed,
      reason: creation.heldAs === "series" ? "hidden series" : creation.blocked,
    };
  }
  return { status: "created", changed: true, releaseId: creation.releaseId };
}
