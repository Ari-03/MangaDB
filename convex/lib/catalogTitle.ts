// Catalog-title placement shared by the distributor/publisher catalog feeds
// that speak in books (ISBN + title + imprint + onsale): the PRH API and
// Yen Press. One record → the matching ladder → authority reconciliation
// on a match, or the standard creation boundaries under the imprint's
// publisher row: omnibus/deluxe books become Edition Line members covering
// real Volumes, box sets Release Bundles, and packaging whose coverage the
// title never states stays on its observation for an Editor. Each adapter
// wraps `applyCatalogTitle` in its own internalMutation (one atomic
// mutation per record, spec §6).

import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getBootstrapMode, getSourceByKey } from "../importSources";
import { packagingValidator, rangeLabels } from "./bookTitle";
import { candidateSeries, matchRelease, type ReleaseFact } from "./matching";
import { upsertObservation } from "./observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  createReleaseBundle,
  creationGates,
  ensurePublisher,
  findPublisherByName,
  queueCreationProposal,
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
  author: v.optional(v.string()),
  onsale: v.optional(v.object({ year: v.number(), month: v.number(), day: v.number() })),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.string()),
  /** The imprint = the publisher brand (e.g. "Kodansha Comics"). */
  imprint: v.optional(v.string()),
  priceCents: v.optional(v.number()),
};

const catalogTitleValidator = v.object(catalogTitleFields);
export type CatalogTitle = Infer<typeof catalogTitleValidator>;

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
  reason?: string;
};

/** The fields this source offers on a linked Release, in canonical form. */
function offeredReleaseFields(snapshot: CatalogTitle): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  offered.isbn13 = snapshot.isbn13;
  if (snapshot.isbn10 !== undefined) offered.isbn10 = snapshot.isbn10;
  if (snapshot.onsale) offered.pubDate = toPartialDate(snapshot.onsale);
  if (snapshot.priceCents !== undefined) {
    offered.price = { amountCents: snapshot.priceCents, currency: "USD" };
  }
  if (snapshot.binding !== undefined) offered.binding = snapshot.binding;
  return offered;
}

/**
 * Reconcile one catalog title into the canonical catalog: ISBN matching
 * links it to the existing skeleton record, then the source's dates/ISBNs/
 * prices and titles/format reconcile in at its registry authority.
 * Unmatched titles follow the standard creation boundaries under the
 * imprint's publisher. A disabled source applies nothing (the kill switch
 * for an in-flight sync).
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
  // Kill switch: disabling the source stops an in-flight sync's applies
  // too, not just the next run's top-of-sync gate.
  if (source && !source.enabled) return { status: "recordOnly", changed: false };
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

  // A box set already placed as a Release Bundle has nothing to reconcile.
  if (observation.recordRef?.type === "releaseBundle") {
    return { status: changed ? "recordOnly" : "unchanged", changed: false };
  }

  // Series first: every placement below hangs off the base Series. An
  // unmarked trailing number may belong to the name ("Omega 6"): when only
  // the whole title names an existing Series, the book is that Series'.
  let seriesTitle = snapshot.seriesTitle;
  let volumeLabel = snapshot.volumeLabel ?? null;
  let candidates = await candidateSeries(ctx, seriesTitle);
  if (candidates.length === 0 && snapshot.bareNumber) {
    const whole = await candidateSeries(ctx, snapshot.title);
    if (whole.length > 0) {
      candidates = whole;
      seriesTitle = whole[0]!.title;
      volumeLabel = null;
    }
  }
  const seriesId = candidates.length === 1 ? candidates[0]!._id : null;

  // Packaging maps onto the base Series' real Volumes — never a Volume or
  // Series of its own. Without a stated coverage it links by ISBN or not
  // at all.
  const packaging = snapshot.packaging ?? null;
  const labels = packaging
    ? packaging.coverRange
      ? rangeLabels(packaging.coverRange)
      : []
    : volumeLabel !== null
      ? [volumeLabel]
      : [];

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
    return { status: bundle.created ? "created" : "linked", changed: true };
  }

  // Rungs ②–⑤ via the shared ladder. Packaging only ever matches by ISBN
  // (multiVolume skips rungs ③/④): an Omnibus 7 is never Volume 7.
  const fact: ReleaseFact = {
    seriesTitle,
    volumeLabel: packaging ? null : volumeLabel,
    multiVolume: packaging !== null,
    format: snapshot.format,
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

  if (packaging && labels.length === 0) {
    await recordUnplaced(
      ctx,
      observation,
      `"${snapshot.title}" is packaging (${packaging.lineName ?? "multi-volume"}) whose covered Volumes the title does not state — an Editor maps it.`,
      now,
    );
    return { status: "recordOnly", changed: false, reason: "packaging without coverage" };
  }

  const editionLine =
    packaging?.lineName != null
      ? { name: packaging.lineName, position: packaging.linePosition }
      : undefined;
  const linePosition = packaging?.linePosition ?? undefined;
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
