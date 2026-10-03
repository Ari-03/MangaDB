// Catalog-title placement shared by the distributor/publisher catalog feeds
// that speak in books (ISBN + title + imprint + onsale): the PRH API and
// Yen Press. One record → the matching ladder → authority reconciliation
// on a match, or the standard creation boundaries under the imprint's
// publisher row: omnibus/deluxe books become Edition Line members covering
// real Volumes, box sets Release Bundles (which pick up books arriving after
// them), and packaging whose coverage the title never states stays on its
// observation for an Editor. Each adapter
// wraps `applyCatalogTitle` in its own internalMutation (one atomic
// mutation per record, spec §6).

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getBootstrapMode, getSourceByKey } from "../importSources";
import { packagingValidator, rangeLabels, type ParsedBookTitle } from "./bookTitle";
import { fullDateValidator } from "./dates";
import type { CoverRequest } from "./covers";
import { inferCoverage } from "./coverage";
import { candidateSeries, matchRelease, type ReleaseFact } from "./matching";
import { upsertObservation } from "./observations";
import {
  alreadyHandled,
  type BundleReconcile,
  createCanonicalRecords,
  createReleaseBundle,
  creationGates,
  ensurePublisher,
  findPublisherByName,
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  queueCreationProposal,
  reconcileLinkedBundle,
  recordUnplaced,
  removedSeriesFor,
  toPartialDate,
} from "./pipeline";
import { canonicalPublisherFor, type CanonicalPublisher } from "./publishers";
import { reconcileFields } from "./reconcile";

/** The snapshot fields every catalog-title source normalizes to. */
export const catalogTitleFields = {
  url: v.string(),
  isbn13: v.string(),
  isbn10: v.optional(v.string()),
  title: v.string(),
  /** The base Series title (lib/bookTitle.ts), never the book title. */
  seriesTitle: v.string(),
  /** The single covered Volume; absent for oneshots and all packaging. */
  volumeLabel: v.optional(v.string()),
  /** Packaging covering more than one Volume. */
  multiVolume: v.boolean(),
  /** Omnibus / deluxe / box-set / range shape, when the title has one. */
  packaging: v.optional(packagingValidator),
  /** A box set: a Release Bundle, never a Release. */
  isBox: v.optional(v.boolean()),
  /** The label came from an unmarked trailing number ("Omega 6" may be a title). */
  bareNumber: v.optional(v.boolean()),
  /** The bare number was a trailing roman numeral (lib/bookTitle.ts BARE_ROMAN). */
  bareRoman: v.optional(v.boolean()),
  /** The split an unlicensed trailing number would make (lib/bookTitle.ts `bareSplit`). */
  bareSplit: v.optional(v.object({ seriesTitle: v.string(), volumeLabel: v.string() })),
  author: v.optional(v.string()),
  onsale: v.optional(fullDateValidator),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.string()),
  /** The imprint = the publisher brand (e.g. "Kodansha Comics"). */
  imprint: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  /** The book's blurb (PRH flap copy, Yen's page text) — the Release Description. */
  description: v.optional(v.string()),
  /**
   * Further publisher text that may state a packaged book's coverage
   * ("Collects volumes 40, 41"), e.g. PRH's positioning and keynote. Only
   * carried for packaging whose title leaves the coverage unstated.
   */
  coverageHints: v.optional(v.array(v.string())),
};

const catalogTitleValidator = v.object(catalogTitleFields);
export type CatalogTitle = Infer<typeof catalogTitleValidator>;

/**
 * A parsed book title as snapshot fields (PRH, Yen Press, OpenLibrary): the
 * parser's nulls and false flags become absent fields.
 */
export function parsedTitleFields(parsed: ParsedBookTitle) {
  const coverRange = parsed.packaging?.coverRange ?? null;
  return {
    seriesTitle: parsed.seriesTitle,
    volumeLabel: parsed.volumeLabel ?? undefined,
    multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
    packaging: parsed.packaging ?? undefined,
    bareNumber: parsed.bareNumber || undefined,
    bareRoman: parsed.bareRoman || undefined,
    bareSplit: parsed.bareSplit ?? undefined,
  };
}

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

/**
 * The fields this source offers on a linked Release, in canonical form.
 * Seven Seas, Kodansha and OpenLibrary keep their own: each reads other
 * snapshot fields and offers a different set, and the key order becomes
 * the order of a queued Proposal's changes.
 */
function offeredReleaseFields(snapshot: CatalogTitle): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  offered.isbn13 = snapshot.isbn13;
  if (snapshot.isbn10 !== undefined) offered.isbn10 = snapshot.isbn10;
  if (snapshot.onsale) offered.pubDate = toPartialDate(snapshot.onsale);
  if (snapshot.priceCents !== undefined) {
    offered.price = { amountCents: snapshot.priceCents, currency: "USD" };
  }
  if (snapshot.binding !== undefined) offered.binding = snapshot.binding;
  if (snapshot.description !== undefined) offered.description = snapshot.description;
  return offered;
}

/** A parsed book title with its provisional readings (lib/bookTitle.ts). */
export type ProvisionalTitle = Pick<
  CatalogTitle,
  "title" | "seriesTitle" | "volumeLabel" | "bareNumber" | "bareRoman" | "bareSplit"
>;

const ROMAN_ONES = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

/**
 * A bare-Roman title read as one work's whole name: the parsed base and its
 * numeral ("Barbarities" and Volume 2 make "Barbarities II"), free of the
 * format and packaging groups the raw source title carries. Null outside the
 * numerals the parser splits (I to XXXIX).
 */
function romanWholeName(parsed: ProvisionalTitle): string | null {
  const value = Number(parsed.volumeLabel);
  if (!Number.isInteger(value) || value < 1 || value > 39) return null;
  return `${parsed.seriesTitle} ${"X".repeat(Math.floor(value / 10))}${ROMAN_ONES[value % 10]}`;
}

/** A title's letters and digits only, for telling a spelling from extra words. */
const lettersOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The conservative resolution of a title's provisional readings against the
 * EXISTING catalog: the base Series title, the covered Volume label, and the
 * active Series that title names. Shared by every adapter that parses book
 * titles (catalog feeds here, OpenLibrary).
 *
 * An unmarked trailing number may belong to the name ("Omega 6"): when only
 * the whole title names an existing Series, the book is that Series'. A
 * trailing roman numeral is more often a sequel's name ("Kingdom Hearts
 * II") than a volume, so the whole title is asked first, and the split
 * stands only when an existing base Series claims it ("BARBARITIES II" →
 * Barbarities Vol. 2); a new work keeps its whole name. A trailing number
 * the parser left in place for want of a volume number ("Tower Dungeon 7"
 * from a PRH row without seriesNumber) follows the same rule: whole title
 * first, else an existing base Series takes it as a Volume, else the new
 * work keeps its whole name.
 */
export async function resolveBaseSeries(
  ctx: QueryCtx | MutationCtx,
  parsed: ProvisionalTitle,
): Promise<{ seriesTitle: string; volumeLabel: string | null; candidates: Doc<"series">[] }> {
  const named = await candidateSeries(ctx, parsed.seriesTitle);
  const plain = {
    seriesTitle: parsed.seriesTitle,
    volumeLabel: parsed.volumeLabel ?? null,
    candidates: named,
  };
  if (parsed.bareRoman) {
    // The source's raw title may still carry groups the parser peeled
    // ("Barbarities II (Manga)"), so the whole name is asked both ways and
    // a new work is named without them.
    // Punctuation alone ("Alpha, II") is the source's own spelling and stays.
    const tidied = romanWholeName(parsed);
    const wholeName =
      tidied !== null && lettersOf(tidied) !== lettersOf(parsed.title) ? tidied : parsed.title;
    let whole = await candidateSeries(ctx, parsed.title);
    if (whole.length === 0 && wholeName !== parsed.title) {
      whole = await candidateSeries(ctx, wholeName);
    }
    if (whole.length > 0 || named.length === 0) {
      return { seriesTitle: whole[0]?.title ?? wholeName, volumeLabel: null, candidates: whole };
    }
    return plain;
  }
  if (named.length > 0) return plain;
  if (parsed.bareNumber) {
    const whole = await candidateSeries(ctx, parsed.title);
    if (whole.length > 0) {
      return { seriesTitle: whole[0]!.title, volumeLabel: null, candidates: whole };
    }
  } else if (parsed.bareSplit) {
    const base = await candidateSeries(ctx, parsed.bareSplit.seriesTitle);
    if (base.length > 0) {
      return {
        seriesTitle: base[0]!.title,
        volumeLabel: parsed.bareSplit.volumeLabel,
        candidates: base,
      };
    }
  }
  return plain;
}

/**
 * The Volume labels a title covers: for packaging, the range its title
 * states, else its blurbs, else a line name that declares its size
 * (lib/coverage.ts), [] when none does; else its own Volume, if any.
 */
function coveredLabels(snapshot: CatalogTitle, volumeLabel: string | null): string[] {
  if (snapshot.packaging) {
    const range = inferCoverage(snapshot.packaging, [
      snapshot.description,
      ...(snapshot.coverageHints ?? []),
    ]);
    return range ? rangeLabels(range) : [];
  }
  return volumeLabel !== null ? [volumeLabel] : [];
}

/**
 * Rung ① for a box set already placed as a Release Bundle: the bundle picks
 * up the members whose books arrived after it (lib/pipeline.ts
 * reconcileLinkedBundle), from the box's snapshot alone — so a planner that
 * skips re-reading a fresh box can still pass its stored snapshot. The base
 * Series is the one active Series the title names. Returns how many members
 * it added (none when the observation links no bundle), or the `conflict`
 * when the box now names another Series or Format than its bundle's.
 */
export async function reconcileCatalogBox(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    importComment: string;
    citation: { sourceName: string; url: string };
    observation: Doc<"sourceObservations">;
    snapshot: CatalogTitle;
    now: number;
  },
): Promise<BundleReconcile> {
  const { observation, snapshot } = args;
  if (observation.recordRef?.type !== "releaseBundle" || !snapshot.packaging) return { added: 0 };
  const { volumeLabel, candidates } = await resolveBaseSeries(ctx, snapshot);
  const labels = coveredLabels(snapshot, volumeLabel);
  if (candidates.length !== 1 || labels.length === 0) return { added: 0 };
  return await reconcileLinkedBundle(ctx, observation.recordRef.id, {
    sourceKey: args.sourceKey,
    observation,
    citation: args.citation,
    importComment: args.importComment,
    seriesId: candidates[0]!._id,
    labels,
    format: snapshot.format,
    now: args.now,
  });
}

/**
 * Reconcile one catalog title into the canonical catalog: ISBN matching
 * links it to the existing skeleton record, then the source's dates/ISBNs/
 * prices, titles/format, and blurb reconcile in at its registry authority.
 * Unmatched titles follow the standard creation boundaries under the
 * imprint's publisher. It applies whatever the source's enabled flag says:
 * a sync stops at its gate (lib/importRuns.ts), never mid-record.
 */
export async function applyCatalogTitle(
  ctx: MutationCtx,
  opts: {
    sourceKey: string;
    defaultSourceName: string;
    importComment: string;
    /** The source's full snapshot (its `kind` plus the catalog fields). */
    snapshot: CatalogTitle & { kind: string };
  },
): Promise<ApplyResult> {
  const { snapshot } = opts;
  const now = Date.now();
  const source = await getSourceByKey(ctx, opts.sourceKey);
  const sourceName = source?.name ?? opts.defaultSourceName;
  const citation = { sourceName, url: snapshot.url };

  const { observation, changed } = await upsertObservation(ctx, {
    sourceKey: opts.sourceKey,
    sourceRecordId: snapshot.isbn13,
    snapshot,
    now,
  });

  // Rung ①: stored source-id link.
  if (observation.recordRef?.type === "release") {
    const release = await ctx.db.get(observation.recordRef.id);
    if (!release || release.status !== "active" || release.locked) {
      return { status: "recordOnly", changed: false };
    }
    if (!changed) return { status: "unchanged", changed: false };
    // An ISBN another Release holds is that book's: none of the record's
    // facts are reconciled onto this link until an Editor resolves the pair.
    if (await isbnHeldElsewhere(ctx, observation, release, snapshot.isbn13, now)) {
      return {
        status: "needsReview",
        changed,
        releaseId: release._id,
        reason: "ISBN held by another Release",
      };
    }
    const result = await reconcileFields(ctx, {
      sourceKey: opts.sourceKey,
      ref: { type: "release", id: release._id },
      doc: release,
      offered: offeredReleaseFields(snapshot),
      observation,
      citation,
      now,
    });
    return {
      status:
        result.applied.length > 0 ? "updated" : result.queued.length > 0 ? "queued" : "recordOnly",
      changed: result.changed,
      releaseId: release._id,
    };
  }

  // A box set already placed as a Release Bundle: its only reconcile is the
  // members that arrived after it, changed record or not (they arrive
  // through other records, never through the box's own). A box now naming
  // another Series or Format goes to review instead.
  if (observation.recordRef?.type === "releaseBundle") {
    const { added, conflict } = await reconcileCatalogBox(ctx, {
      sourceKey: opts.sourceKey,
      importComment: opts.importComment,
      citation,
      observation,
      snapshot,
      now,
    });
    if (conflict !== undefined) return { status: "needsReview", changed: false, reason: conflict };
    if (added > 0) return { status: "updated", changed: true };
    return { status: changed ? "recordOnly" : "unchanged", changed: false };
  }

  // Series first: every placement below hangs off the base Series.
  const { seriesTitle, volumeLabel, candidates } = await resolveBaseSeries(ctx, snapshot);
  const seriesId = candidates.length === 1 ? candidates[0]!._id : null;

  // Packaging maps onto the base Series' real Volumes — never a Volume or
  // Series of its own; without a stated coverage it links by ISBN or not at
  // all.
  const packaging = snapshot.packaging ?? null;
  const labels = coveredLabels(snapshot, volumeLabel);

  // The publisher key is the imprint, resolved against existing rows (a
  // duplicate string like "Kodansha Comics" resolves to its company; an
  // imprint like "Ghost Ship" to its own row).
  const publisher =
    snapshot.imprint !== undefined ? await findPublisherByName(ctx, snapshot.imprint) : null;
  const publisherRow =
    snapshot.imprint !== undefined ? imprintPublisher(snapshot.imprint) : undefined;
  const releasePayload = {
    format: snapshot.format,
    binding: snapshot.binding,
    isbn13: snapshot.isbn13,
    isbn10: snapshot.isbn10,
    pubDate: snapshot.onsale ? toPartialDate(snapshot.onsale) : undefined,
    price:
      snapshot.priceCents !== undefined
        ? { amountCents: snapshot.priceCents, currency: "USD" }
        : undefined,
    description: snapshot.description,
  };
  const bootstrap = await getBootstrapMode(ctx);

  // Box sets are Release Bundles of the base Series' existing Releases.
  if (snapshot.isBox) {
    if (seriesId === null || publisherRow === undefined || !bootstrap) {
      await recordUnplaced(
        ctx,
        observation,
        seriesId === null
          ? `Box set "${snapshot.title}" has no unique base Series.`
          : `Box set "${snapshot.title}" is a Release Bundle — steady state leaves bundles to review.`,
        now,
      );
      return { status: "recordOnly", changed: false, reason: "box set" };
    }
    const bundle = await createReleaseBundle(ctx, {
      sourceKey: opts.sourceKey,
      observation,
      citation,
      importComment: opts.importComment,
      seriesId,
      name: snapshot.title,
      labels,
      publisher: publisherRow,
      release: releasePayload,
      tagBootstrapUnreviewed: true,
      now,
    });
    if (bundle.conflict !== undefined) {
      return { status: "needsReview", changed: true, reason: bundle.conflict };
    }
    return { status: bundle.created ? "created" : "linked", changed: true };
  }

  // Rungs ②–⑤ via the shared ladder. Packaging only ever matches by ISBN
  // (multiVolume skips rungs ③/④): an Omnibus 7 is never Volume 7.
  const fact: ReleaseFact = {
    seriesTitle,
    volumeLabel: packaging ? null : volumeLabel,
    multiVolume: packaging !== null,
    format: snapshot.format,
    binding: snapshot.binding,
    language: IMPORT_LANGUAGE,
    isbn13: snapshot.isbn13,
    publisherId: publisher?._id ?? null,
  };
  const match = await matchRelease(ctx, fact);

  if (match.kind === "match") {
    const release = match.release;
    await ctx.db.patch(observation._id, {
      recordRef: { type: "release", id: release._id },
    });
    await reconcileFields(ctx, {
      sourceKey: opts.sourceKey,
      ref: { type: "release", id: release._id },
      doc: release,
      offered: offeredReleaseFields(snapshot),
      observation,
      citation,
      now,
    });
    return { status: "linked", changed: true, releaseId: release._id };
  }

  const editionLine =
    packaging?.lineName != null
      ? { name: packaging.lineName, position: packaging.linePosition }
      : undefined;
  // Packaging with no coverage from any signal. In Bootstrap Mode a named
  // line's member is still created, as Unmapped Packaging under its line
  // (CONTEXT.md): the book shows in the publisher's own numbering and a
  // Moderator maps its Volumes later. A bare range with no line name, an
  // ambiguous Series, or steady state (which never queues a guess without
  // coverage) keeps the book on its observation instead.
  const unmapped =
    packaging !== null &&
    labels.length === 0 &&
    editionLine !== undefined &&
    bootstrap &&
    candidates.length <= 1 &&
    publisherRow !== undefined;
  if (packaging && labels.length === 0 && !unmapped) {
    await recordUnplaced(
      ctx,
      observation,
      `"${snapshot.title}" is packaging (${packaging.lineName ?? "multi-volume"}) whose covered Volumes the title does not state — an Editor maps it.`,
      now,
    );
    return { status: "recordOnly", changed: false, reason: "packaging without coverage" };
  }

  const linePosition = packaging?.linePosition ?? undefined;
  // A queued packaging guess carries its Edition Line, so approval files the
  // Edition under the base Series' line of that name (or creates it).
  const queue = async (comment: string, reason?: string): Promise<ApplyResult> => {
    if (await alreadyHandled(ctx, observation)) {
      return { status: "alreadyQueued", changed: false, reason };
    }
    if (publisherRow === undefined) {
      // No imprint on the record: nothing reviewable to pre-fill.
      return { status: "needsReview", changed: false, reason };
    }
    // The creation registry resolves publisherSlug at approval; ensure the
    // imprint's row exists so the queued guess stays one-click appliable.
    const row = await ensurePublisher(ctx, publisherRow);
    await queueCreationProposal(ctx, {
      sourceKey: opts.sourceKey,
      observation,
      seriesId,
      seriesTitle,
      labels,
      editionLine,
      linePosition,
      release: { ...releasePayload, publisherSlug: row.slug },
      now,
      comment,
    });
    return { status: reason ? "needsReview" : "queued", changed: true, reason };
  };

  if (match.kind === "review") {
    return await queue(
      `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`,
      match.reason,
    );
  }

  if (publisherRow === undefined) {
    // Cannot create a Release without a publisher (spec §2).
    return { status: "recordOnly", changed: false };
  }

  if (candidates.length > 1) {
    // Two same-titled Series: creating under either is a guess.
    return await queue(
      `"${snapshot.title}" matches ${candidates.length} same-titled Series — the importer never guesses.`,
      "ambiguous series",
    );
  }

  const gates = creationGates({
    seriesId,
    multiVolume: labels.length > 1,
    editionLineHint: editionLine !== undefined,
  });
  if (gates.length > 0 && !bootstrap) {
    if (seriesId === null) {
      // A brand-new Series for a work an Editor hid would undo the repair:
      // the book stays on its observation instead of the queue. (The
      // creation path below makes the same check itself.)
      const removed = await removedSeriesFor(ctx, {
        sourceKey: opts.sourceKey,
        observation,
        seriesTitle,
        publisherId: publisher?._id ?? null,
      });
      if (removed?.kind === "hidden") {
        await recordUnplaced(ctx, observation, removed.reason, now);
        return { status: "recordOnly", changed: false, reason: "hidden series" };
      }
    }
    return await queue(
      `"${snapshot.title}" observed at ${sourceName} needs ${gates.join(" and ")} — steady-state creation gate.${editionLine ? ` Edition Line: ${editionLine.name}.` : ""}`,
    );
  }

  const creation = await createCanonicalRecords(ctx, {
    sourceKey: opts.sourceKey,
    observation,
    citation,
    importComment: opts.importComment,
    seriesId,
    seriesTitle,
    labels,
    editionLine,
    ...(unmapped ? { coverageUnmapped: true as const } : {}),
    release: { ...releasePayload, publisher: publisherRow },
    tagBootstrapUnreviewed: bootstrap && gates.length > 0,
    now,
  });
  if (creation.blocked !== undefined) {
    return { status: "recordOnly", changed: false, reason: "hidden series" };
  }
  return { status: "created", changed: true, releaseId: creation.releaseId };
}

/**
 * An imprint string → the publisher row it belongs on: the canonical row
 * for a known name ("Kodansha Comics" → Kodansha, "Ghost Ship" → the Ghost
 * Ship imprint under Seven Seas), else a row slugified from the name.
 */
export function imprintPublisher(imprint: string): CanonicalPublisher {
  const known = canonicalPublisherFor(imprint);
  if (known) return known;
  const name = imprint.trim();
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { name, slug: slug === "" ? "prh-imprint" : slug };
}
