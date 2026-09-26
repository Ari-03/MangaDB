// The Seven Seas adapter (ticket #34, spec §6/§7) — the import pipeline
// proven end to end on one source. The sync action pages through the WP
// REST catalog (`wp/v2/books`) using `modified_gmt` as the change signal,
// fetches the book page for new/changed records, normalizes it
// (lib/sevenSeas.ts), and hands each snapshot to `applyBook`:
//
//   observation upsert (latest snapshot + append-only history)
//     → the full matching ladder (lib/matching.ts): ① stored link ·
//       ② ISBN-13 + title sanity · ③ publisher+title+label+format with
//       exactly one candidate · ④ title-only always reviews · ⑤ create.
//       Ambiguity always queues flagged; the importer never merges.
//     → linked records reconcile field-by-field under the authority rules
//       (lib/reconcile.ts): auto-update, queue a conflict Proposal, or
//       record on the observation only. Human Overrides stay sticky.
//     → the creation path emits a system-authored, immediately approved
//       Proposal creating Series/Volume/Edition/Release with public
//       importer-authored Revisions citing the source name + record URL.
//     → in steady state, a brand-new Series, multi-Volume Coverage, or an
//       Edition-Line-shaped release queues an In-Review Proposal instead;
//       in Bootstrap Mode those records are created directly and tagged
//       bootstrap-unreviewed (spec §7).
//
// Covers land in Convex file storage as {storageId, sourceUrl, attribution}.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import { errorMessage, politeFetch } from "./lib/http";
import { rangeLabels } from "./lib/bookTitle";
import { candidateSeries, matchRelease, type MatchOutcome, type ReleaseFact } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  createReleaseBundle,
  creationGates,
  queueCreationProposal,
  reconcileLinkedSeries,
  recordUnplaced,
  toPartialDate,
  linkSeriesObservation,
} from "./lib/pipeline";
import { reconcileFields } from "./lib/reconcile";
import {
  bookSnapshotValidator,
  isMangaBook,
  normalizeBook,
  parseBookListing,
  parseBookPage,
  type BookSnapshot,
} from "./lib/sevenSeas";

export const SOURCE_KEY = "sevenseas";
const BASE_URL = "https://sevenseasentertainment.com";
const PUBLISHER = { name: "Seven Seas Entertainment", slug: "seven-seas" };
const IMPORT_COMMENT = "Imported from Seven Seas Entertainment.";

// ---------- the sync action ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      completeSweep: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One Seven Seas import run. Defaults suit the daily cadence: a full
 * listing sweep (~65 pages of 100) with a bounded number of book-page
 * detail fetches, so the initial backfill converges over repeated runs
 * (modified-desc ordering surfaces new/changed books first) while a
 * steady-state run does the sweep plus a handful of detail fetches.
 *
 *   npx convex run sevenSeas:sync '{"maxDetailFetches":50}'
 */
export const sync = internalAction({
  args: {
    /** Cap listing pages (an uncapped sweep is what enables withdrawal). */
    maxListingPages: v.optional(v.number()),
    /** Cap book-page fetches per run; skipped books wait for the next run. */
    maxDetailFetches: v.optional(v.number()),
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** Re-fetch details even for observations whose modified_gmt is unchanged. */
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        "The approved-source registry has no \"sevenseas\" row. Run: npx convex run importSources:seedRegistry '{}'",
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const runId: Id<"importRuns"> = await ctx.runMutation(internal.imports.startRun, {
      sourceKey: SOURCE_KEY,
    });
    const runStartedAt = Date.now();
    const delay = args.politeDelayMs ?? 350;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;
    let completeSweep = true;
    let detailFailures = 0;

    try {
      let page = 1;
      let totalPages = 1;
      let detailBudget = args.maxDetailFetches ?? 200;

      while (page <= totalPages) {
        if (args.maxListingPages !== undefined && page > args.maxListingPages) {
          completeSweep = false;
          break;
        }
        const res = await politeFetch(
          `${BASE_URL}/wp-json/wp/v2/books?per_page=100&page=${page}&orderby=modified&order=desc`,
          delay,
        );
        const pageCount = res.headers.get("x-wp-totalpages");
        if (pageCount === null || !/^\d+$/.test(pageCount)) {
          throw new Error("Seven Seas listing is missing valid X-WP-TotalPages");
        }
        totalPages = Number(pageCount);
        if (!Number.isSafeInteger(totalPages)) {
          throw new Error("Seven Seas listing has an invalid page count");
        }
        const items: unknown = await res.json();
        if (!Array.isArray(items) || (items.length > 0 && totalPages < page)) {
          throw new Error("Seven Seas listing has an invalid collection shape");
        }
        if (items.length === 0 && totalPages >= page) {
          throw new Error("Seven Seas listing ended before its declared page count");
        }

        for (const raw of items) {
          const listing = parseBookListing(raw);
          if (!listing) {
            throw new Error(`Seven Seas listing page ${page} contains an invalid book`);
          }
          const note = await ctx.runMutation(internal.sevenSeas.noteListing, {
            sourceRecordId: listing.sourceRecordId,
            modifiedGmt: listing.modifiedGmt,
            force: args.force ?? false,
          });
          // Presence remains evidence even if the source recategorizes a
          // previously imported book as prose. Scope changes are not deletion.
          if (!isMangaBook({ title: listing.title })) continue;
          seen++;
          if (!note.needsDetail) continue;
          if (detailBudget <= 0) {
            completeSweep = false;
            continue;
          }
          detailBudget--;

          try {
            const pageRes = await politeFetch(listing.url, delay);
            const details = parseBookPage(await pageRes.text());
            const snapshot = normalizeBook(listing, details);
            if (
              !isMangaBook({
                category: snapshot.category,
                title: snapshot.title,
              })
            ) {
              continue;
            }

            const result = await ctx.runMutation(internal.sevenSeas.applyBook, {
              sourceRecordId: listing.sourceRecordId,
              snapshot,
            });
            if (result.changed) changed++;
            if (result.status === "needsReview") {
              errors.push(`review ${listing.slug}: ${result.reason ?? "conflict"}`);
            }

            if (result.coverNeeded && result.releaseId && snapshot.coverUrl) {
              try {
                const imgRes = await politeFetch(snapshot.coverUrl, delay);
                const storageId = await ctx.storage.store(await imgRes.blob());
                await ctx.runMutation(internal.sevenSeas.attachCover, {
                  releaseId: result.releaseId,
                  storageId,
                  sourceUrl: snapshot.coverUrl,
                  attribution: source.attribution ?? PUBLISHER.name,
                });
              } catch (e) {
                errors.push(`cover ${listing.slug}: ${errorMessage(e)}`);
              }
            }
          } catch (e) {
            detailFailures++;
            errors.push(`book ${listing.slug}: ${errorMessage(e)}`);
          }
        }
        page++;
      }

      // Disappearance → withdrawn, only after a COMPLETE sweep (absence is
      // never evidence on a partial one). Failed individual books are safe:
      // noteListing already bumped their observations.
      if (completeSweep) {
        await ctx.runMutation(internal.imports.markWithdrawn, {
          sourceKey: SOURCE_KEY,
          notSeenSince: runStartedAt,
        });
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: detailFailures > 0 ? "failed" : "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        completeSweep,
        errorCount: errors.length,
        ...(detailFailures > 0 ? { failed: true } : {}),
      };
    } catch (e) {
      errors.push(errorMessage(e));
      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "failed",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        completeSweep: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- listing bookkeeping ----------

/**
 * Note one listing hit: presence in the listing bumps last-seen (unchanged
 * fetches bump last-seen ONLY — spec §6); the stored snapshot's
 * modified_gmt decides whether the book page is worth fetching.
 */
export const noteListing = internalMutation({
  args: {
    sourceRecordId: v.string(),
    modifiedGmt: v.string(),
    force: v.boolean(),
  },
  handler: async (ctx, { sourceRecordId, modifiedGmt, force }) => {
    const obs = await getObservation(ctx, SOURCE_KEY, sourceRecordId);
    if (!obs) return { needsDetail: true };
    await ctx.db.patch(obs._id, { lastSeenAt: Date.now(), withdrawn: false });
    const stored = (obs.snapshot as Partial<BookSnapshot> | null)?.modifiedGmt;
    return { needsDetail: force || stored !== modifiedGmt };
  },
});

// ---------- applying one book ----------

type ApplyResult = {
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
  coverNeeded?: boolean;
  reason?: string;
};

/** The fields this source offers on a linked Release, in canonical form. */
function offeredReleaseFields(snapshot: BookSnapshot): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  if (snapshot.isbn13 !== undefined) offered.isbn13 = snapshot.isbn13;
  if (snapshot.releaseDate) offered.pubDate = toPartialDate(snapshot.releaseDate);
  if (snapshot.priceCents !== undefined) {
    offered.price = {
      amountCents: snapshot.priceCents,
      currency: snapshot.currency ?? "USD",
    };
  }
  return offered;
}

/** The shared series-rename reconcile, keyed on Seven Seas' series slug. */
function reconcileSeries(
  ctx: Parameters<typeof reconcileLinkedSeries>[0],
  snapshot: BookSnapshot,
  citation: { sourceName: string; url: string },
  now: number,
) {
  return reconcileLinkedSeries(ctx, {
    sourceKey: SOURCE_KEY,
    seriesKey: snapshot.seriesSlug,
    offeredTitle: snapshot.seriesTitle,
    citation,
    now,
  });
}

/**
 * Reconcile one normalized book snapshot into the canonical catalog. One
 * atomic mutation per record (spec §6): the observation write, the match,
 * and the proposal/revision/record writes commit together or not at all.
 */
export const applyBook = internalMutation({
  args: { sourceRecordId: v.string(), snapshot: bookSnapshotValidator },
  handler: async (ctx, { sourceRecordId, snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? PUBLISHER.name;
    const citation = { sourceName, url: snapshot.url };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId,
      snapshot,
      now,
    });

    // Rung ①: stored source-id link. A rename at the source is then a field
    // conflict on the linked record — reconciled under the authority rules —
    // never a failed match.
    if (observation.recordRef?.type === "release") {
      const release = await ctx.db.get(observation.recordRef.id);
      if (!release || release.status !== "active" || release.locked) {
        return { status: "recordOnly", changed: false };
      }
      if (!changed && release.coverImage) {
        return { status: "unchanged", changed: false };
      }
      const seriesResult = await reconcileSeries(ctx, snapshot, citation, now);
      const result = await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return {
        status:
          result.applied.length > 0
            ? "updated"
            : result.queued.length > 0
              ? "queued"
              : "recordOnly",
        changed: result.changed || seriesResult.changed,
        releaseId: release._id,
        coverNeeded: !release.coverImage && snapshot.coverUrl !== undefined,
      };
    }

    if (observation.recordRef?.type === "releaseBundle") {
      return { status: changed ? "recordOnly" : "unchanged", changed: false };
    }

    // The series half of rung ① (keyed on the source's own series slug),
    // including a rename check; without a stored link, the base Series by
    // title — never a new Series while one already exists.
    let { seriesId } = await reconcileSeries(ctx, snapshot, citation, now);
    let ambiguousSeries = 0;
    if (seriesId === null) {
      const candidates = await candidateSeries(ctx, snapshot.seriesTitle);
      if (candidates.length === 1) {
        seriesId = candidates[0]!._id;
        await linkSeriesObservation(ctx, {
          sourceKey: SOURCE_KEY,
          seriesKey: snapshot.seriesSlug,
          title: snapshot.seriesTitle,
          url: snapshot.seriesUrl,
          seriesId,
          now,
        });
      }
      ambiguousSeries = candidates.length > 1 ? candidates.length : 0;
    }

    const publisher = await ctx.db
      .query("publishers")
      .withIndex("by_slug", (q) => q.eq("slug", PUBLISHER.slug))
      .unique();
    // Packaging covers the base Series' real Volumes; it is never a Volume.
    const packaging = snapshot.packaging ?? null;
    const labels = packaging
      ? packaging.coverRange
        ? rangeLabels(packaging.coverRange)
        : []
      : snapshot.volumeLabel !== undefined
        ? [snapshot.volumeLabel]
        : [];
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: packaging ? null : (snapshot.volumeLabel ?? null),
      multiVolume: packaging !== null,
      format: "physical",
      isbn13: snapshot.isbn13,
      publisherId: publisher && publisher.status === "active" ? publisher._id : null,
    };
    // A box set is never a Release: it skips the ladder for the bundle path.
    const match: MatchOutcome = snapshot.isBox
      ? { kind: "create", rung: 5 }
      : await matchRelease(ctx, fact);

    if (match.kind === "match") {
      // Rung ② or ③ found the one canonical Release this book is: link the
      // observation, then reconcile the offered fields into it.
      const release = match.release;
      await ctx.db.patch(observation._id, {
        recordRef: { type: "release", id: release._id },
      });
      const firstSeriesId = release.seriesIds[0];
      if (firstSeriesId !== undefined) {
        await linkSeriesObservation(ctx, {
          sourceKey: SOURCE_KEY,
          seriesKey: snapshot.seriesSlug,
          title: snapshot.seriesTitle,
          url: snapshot.seriesUrl,
          seriesId: firstSeriesId,
          now,
        });
      }
      await reconcileFields(ctx, {
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return {
        status: "linked",
        changed: true,
        releaseId: release._id,
        coverNeeded: !release.coverImage && snapshot.coverUrl !== undefined,
      };
    }

    const releasePayload = {
      format: "physical" as const,
      binding: snapshot.binding,
      isbn13: snapshot.isbn13,
      pubDate: snapshot.releaseDate ? toPartialDate(snapshot.releaseDate) : undefined,
      price:
        snapshot.priceCents !== undefined
          ? {
              amountCents: snapshot.priceCents,
              currency: snapshot.currency ?? "USD",
            }
          : undefined,
    };

    const bootstrap = await getBootstrapMode(ctx);

    // A box set is a Release Bundle of the base Series' existing Releases.
    if (snapshot.isBox) {
      if (seriesId === null || labels.length === 0 || !bootstrap) {
        await recordUnplaced(
          ctx,
          observation,
          `Box set "${snapshot.title}" needs a unique base Series and stated coverage, and outside Bootstrap Mode a review.`,
          now,
        );
        return { status: "recordOnly", changed: false, reason: "box set" };
      }
      const bundle = await createReleaseBundle(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        seriesId,
        name: snapshot.title,
        labels,
        publisher: PUBLISHER,
        release: releasePayload,
        tagBootstrapUnreviewed: true,
        now,
      });
      return { status: bundle.created ? "created" : "linked", changed: true };
    }

    if (packaging && labels.length === 0) {
      await recordUnplaced(
        ctx,
        observation,
        `"${snapshot.title}" is packaging whose covered Volumes the title does not state — an Editor maps it.`,
        now,
      );
      return {
        status: "recordOnly",
        changed: false,
        reason: "packaging without coverage",
      };
    }
    const editionLine =
      packaging?.lineName != null
        ? { name: packaging.lineName, position: packaging.linePosition }
        : undefined;

    if (match.kind === "review" || ambiguousSeries > 0) {
      // Ambiguity always queues flagged (spec §6) — the importer never
      // merges, in Bootstrap Mode or out of it. The queue item is the
      // pre-filled creation guess with the flag in its change comment.
      const reason =
        match.kind === "review" ? match.reason : `${ambiguousSeries} same-titled Series`;
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false, reason };
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        linePosition: packaging?.linePosition ?? undefined,
        release: { ...releasePayload, publisherSlug: PUBLISHER.slug },
        now,
        comment:
          match.kind === "review"
            ? `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`
            : `"${snapshot.seriesTitle}" matches ${ambiguousSeries} same-titled Series — the importer never guesses.`,
      });
      return { status: "needsReview", changed: true, reason };
    }

    // Rung ⑤ — creation, behind the steady-state boundaries (spec §6): a
    // single-Volume Release under an already-linked Series auto-creates; a
    // brand-new Series, multi-Volume Coverage, or an Edition-Line-shaped
    // release always queues, pre-filled so a correct guess is one click.
    // Bootstrap Mode lifts the gates (spec §7).
    const gates = creationGates({
      seriesId,
      multiVolume: labels.length > 1,
      editionLineHint: editionLine !== undefined,
    });
    if (gates.length > 0 && !bootstrap) {
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false };
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        linePosition: packaging?.linePosition ?? undefined,
        release: { ...releasePayload, publisherSlug: PUBLISHER.slug },
        now,
        comment: `"${snapshot.title}" observed at ${sourceName} needs ${gates.join(" and ")} — steady-state creation gate.${editionLine ? ` Edition Line: ${editionLine.name}.` : ""}`,
      });
      return { status: "queued", changed: true };
    }

    const creation = await createCanonicalRecords(ctx, {
      sourceKey: SOURCE_KEY,
      observation,
      citation,
      importComment: IMPORT_COMMENT,
      seriesId,
      seriesTitle: snapshot.seriesTitle,
      seriesKey: snapshot.seriesSlug,
      seriesUrl: snapshot.seriesUrl,
      labels,
      editionLine,
      release: { ...releasePayload, publisher: PUBLISHER },
      // Tag exactly what steady state would have queued (spec §7).
      tagBootstrapUnreviewed: bootstrap && gates.length > 0,
      now,
    });
    return {
      status: "created",
      changed: true,
      releaseId: creation.releaseId,
      coverNeeded: snapshot.coverUrl !== undefined,
    };
  },
});

// ---------- covers ----------

/**
 * Attach a stored cover: {storageId, sourceUrl, attribution} per spec §6.
 * A racing duplicate or vanished release deletes the fresh blob instead of
 * orphaning it; replacing an outdated source cover deletes the old blob.
 */
export const attachCover = internalMutation({
  args: {
    releaseId: v.id("releases"),
    storageId: v.id("_storage"),
    sourceUrl: v.string(),
    attribution: v.string(),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.status !== "active") {
      await ctx.storage.delete(args.storageId);
      return { attached: false };
    }
    const current = release.coverImage;
    if (current?.sourceUrl === args.sourceUrl) {
      await ctx.storage.delete(args.storageId);
      return { attached: false };
    }
    if (current) await ctx.storage.delete(current.storageId);
    await ctx.db.patch(args.releaseId, {
      coverImage: {
        storageId: args.storageId,
        sourceUrl: args.sourceUrl,
        attribution: args.attribution,
      },
    });
    return { attached: true };
  },
});
