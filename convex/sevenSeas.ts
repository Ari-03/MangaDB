// The Seven Seas adapter (spec §6/§7). The sync action pages through the WP
// REST catalog (`wp/v2/books`) using `modified_gmt` as the change signal,
// fetches the book page for new/changed records, normalizes it
// (lib/sevenSeas.ts), and hands each snapshot to `applyBook`, which runs
// the shared matching ladder and creation path (lib/matching.ts,
// lib/pipeline.ts). Seven Seas specifics: series links are keyed by the
// site's series slug, a box set becomes a Release Bundle that picks up
// members whose books arrived after it on every listing that notes it, and
// packaging an older planner left unplaced is replayed once from its
// stored snapshot, without its page, paced by the detail budget.
//
// Covers land in Convex file storage as {storageId, sourceUrl, attribution}
// through the shared attach path (lib/covers.ts `storeCover`), and are
// replaced when the book's cover URL changes. A placeholder image is recorded
// on the Release instead, keeping any art already shown, and not fetched again
// until its URL changes. A download that fails is retried by later runs from
// the stored snapshot's URL, without refetching an unchanged book page.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import {
  coverKey,
  coverRequest,
  type CoverRequest,
  type StoredCovers,
} from "./lib/covers";
import type { ApplyResult } from "./lib/catalogTitle";
import { errorMessage, politeFetch } from "./lib/http";
import { closeRun, registryRow, runToContinue, stopAtGate, storeRunCover } from "./lib/importRuns";
import { applyRetrying } from "./lib/occ";
import { parseBookTitle, rangeLabels } from "./lib/bookTitle";
import { inferCoverage } from "./lib/coverage";
import { candidateSeries, matchRelease, type MatchOutcome, type ReleaseFact } from "./lib/matching";
import {
  getObservation,
  type Hold,
  linkObservation,
  markSeen,
  recordUnplaced,
  upsertObservation,
} from "./lib/observations";
import {
  alreadyHandled,
  blurbOutranked,
  createCanonicalRecords,
  createReleaseBundle,
  creationGates,
  IMPORT_LANGUAGE,
  isbnHeldElsewhere,
  linkedSeriesId,
  queueCreationProposal,
  reconcileLinkedBundle,
  reconcileLinkedSeries,
  removedSeriesFor,
  toPartialDate,
  linkSeriesObservation,
  type BundleReconcile,
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
import { withExceptionCapture } from "./lib/posthog";

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
      stopped?: true;
    };

/**
 * One Seven Seas import run. Defaults suit the daily cadence: a full
 * listing sweep (~65 pages of 100) with a bounded number of book-page
 * detail fetches, so the initial backfill converges over repeated runs
 * (modified-desc ordering surfaces new/changed books first) while a
 * steady-state run does the sweep plus a handful of detail fetches. Each
 * listing page, and the withdrawal pass, starts at the import gate
 * (lib/importRuns.ts): a disable stops a scheduled run there, as "stopped"
 * and without withdrawing anything.
 *
 *   npx convex run sevenSeas:sync '{"maxDetailFetches":50}'
 */
export const sync = internalAction({
  args: {
    /** Cap listing pages (an uncapped sweep is what enables withdrawal). */
    maxListingPages: v.optional(v.number()),
    /** Cap book-page fetches per run; skipped books wait for the next run. */
    maxDetailFetches: v.optional(v.number()),
    /** Cap retries of earlier failed cover downloads per run (default 50). */
    maxCoverRetries: v.optional(v.number()),
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** Re-fetch details even for observations whose modified_gmt is unchanged. */
    force: v.optional(v.boolean()),
    /** A run an operator opened with imports:startRun (forced). */
    runId: v.optional(v.id("importRuns")),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("sevenSeas.sync", ctx, async () => {
      const source = await registryRow(ctx, SOURCE_KEY);
      const runId = await runToContinue(ctx, source, args);
      if (runId === null) return { skipped: "disabled" as const };
      const runStartedAt = Date.now();
      const delay = args.politeDelayMs ?? 350;
      const errors: string[] = [];
      let seen = 0;
      let changed = 0;
      let completeSweep = true;
      // Invalid listing items plus detail fetch/parse failures: any of them
      // fails the run so source health notices a recurring problem.
      let failures = 0;
      const covers: StoredCovers = new Map();

      try {
        let page = 1;
        let totalPages = 1;
        let detailBudget = args.maxDetailFetches ?? 200;
        let coverBudget = args.maxCoverRetries ?? 50;

        while (page <= totalPages) {
          if (args.maxListingPages !== undefined && page > args.maxListingPages) {
            completeSweep = false;
            break;
          }
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, completeSweep: false };
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
          // A catalog of 6,000+ books never legitimately empties: an empty
          // listing would otherwise pass as a complete sweep and withdraw all.
          if (page === 1 && items.length === 0) {
            throw new Error("Seven Seas listing was empty");
          }

          for (const raw of items) {
            const listing = parseBookListing(raw);
            if (!listing) {
              // One bad item never aborts the sweep, but it may hide a book,
              // so absence is not evidence this run.
              failures++;
              completeSweep = false;
              errors.push(`listing page ${page}: invalid book item`);
              continue;
            }
            const note = await ctx.runMutation(internal.sevenSeas.noteListing, {
              sourceRecordId: listing.sourceRecordId,
              modifiedGmt: listing.modifiedGmt,
              force: args.force ?? false,
              offersBlurb: listing.description !== undefined,
            });
            // Presence remains evidence even if the source recategorizes a
            // previously imported book as prose. Scope changes are not deletion.
            if (!isMangaBook({ title: listing.title })) continue;
            seen++;
            if (!note.needsDetail && note.replay === undefined) {
              if (note.review !== undefined) errors.push(`review ${listing.slug}: ${note.review}`);
              // An unchanged book whose art never landed (a failed download
              // after its apply committed): retry just the art, paced by its
              // own budget so it never starves book-page fetches.
              if (note.cover && (covers.has(coverKey(note.cover)) || coverBudget-- > 0)) {
                await storeRunCover(
                  ctx,
                  covers,
                  {
                    ...note.cover,
                    attribution: source.attribution ?? PUBLISHER.name,
                    delayMs: delay,
                  },
                  { label: listing.slug, errors },
                );
              }
              continue;
            }
            // A book page to read, or a stored snapshot to replay: either
            // spends one unit of the detail budget.
            if (detailBudget <= 0) {
              completeSweep = false;
              continue;
            }
            detailBudget--;

            try {
              const snapshot =
                note.replay ??
                normalizeBook(
                  listing,
                  parseBookPage(await (await politeFetch(listing.url, delay)).text()),
                );
              if (
                !isMangaBook({
                  category: snapshot.category,
                  title: snapshot.title,
                })
              ) {
                continue;
              }

              const result = await applyRetrying(ctx, internal.sevenSeas.applyBook, {
                sourceRecordId: listing.sourceRecordId,
                snapshot,
              });
              if (result.changed) changed++;
              if (result.status === "needsReview") {
                errors.push(`review ${listing.slug}: ${result.reason ?? "conflict"}`);
              }

              if (result.cover) {
                await storeRunCover(
                  ctx,
                  covers,
                  {
                    ...result.cover,
                    attribution: source.attribution ?? PUBLISHER.name,
                    delayMs: delay,
                  },
                  { label: listing.slug, errors },
                );
              }
            } catch (e) {
              // A removed page (404) is a notice, not a failure: the book stays
              // unobserved and is simply retried while it remains listed.
              // Other transport errors and a page without volume-meta (likely
              // a challenge page) are failures.
              const message = errorMessage(e);
              if (!message.startsWith("HTTP 404")) failures++;
              errors.push(`book ${listing.slug}: ${message}`);
            }
          }
          page++;
        }

        // Disappearance → withdrawn, only after a COMPLETE sweep (absence is
        // never evidence on a partial one). Failed individual books are safe:
        // noteListing already bumped their observations. A run the gate stops
        // here closes "stopped" without withdrawing.
        if (completeSweep) {
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, completeSweep: false };
          await ctx.runMutation(internal.imports.markWithdrawn, {
            sourceKey: SOURCE_KEY,
            notSeenSince: runStartedAt,
          });
        }

        const status = failures > 0 ? "failed" : "succeeded";
        return { ...(await closeRun(ctx, runId, status, { seen, changed, errors })), completeSweep };
      } catch (e) {
        errors.push(errorMessage(e));
        return {
          ...(await closeRun(ctx, runId, "failed", { seen, changed, errors })),
          completeSweep: false,
        };
      }
    }),
});

// ---------- listing bookkeeping ----------

/**
 * Note one listing hit: presence in the listing bumps last-seen (unchanged
 * fetches bump last-seen ONLY — spec §6) and retires the cancellation
 * review a withdrawal queued; the stored snapshot's modified_gmt decides
 * whether the book page is worth fetching. When it is not, `cover` is art
 * the linked Release still lacks from the snapshot's cover URL (a download
 * that failed after the book applied), for the action to retry without the
 * page, and `replay` is a stored snapshot for the action to apply again
 * without the page (an unplaced book an older planner judged). `review` is
 * why a linked box its stored snapshot could not fill went to review.
 */
export const noteListing = internalMutation({
  args: {
    sourceRecordId: v.string(),
    modifiedGmt: v.string(),
    force: v.boolean(),
    /** The listing carries a blurb (`content.rendered`). */
    offersBlurb: v.boolean(),
  },
  handler: async (
    ctx,
    { sourceRecordId, modifiedGmt, force, offersBlurb },
  ): Promise<{
    needsDetail: boolean;
    cover?: CoverRequest;
    replay?: BookSnapshot;
    review?: string;
  }> => {
    const found = await getObservation(ctx, SOURCE_KEY, sourceRecordId);
    if (!found) return { needsDetail: true };
    const obs = await markSeen(ctx, found, Date.now());
    const stored = obs.snapshot as Partial<BookSnapshot> | null;
    if (force || stored?.modifiedGmt !== modifiedGmt) return { needsDetail: true };
    // Age ratings predate their import too: a book read before them is
    // re-read once, paced by the same budget (lib/mature.ts).
    if (stored?.mature === undefined) return { needsDetail: true };
    // A linked box's members arrive through other books, never through its
    // own page: the stored snapshot places them without a detail fetch.
    if (obs.recordRef?.type === "releaseBundle") {
      const { conflict } = await reconcileBoxMembers(
        ctx,
        obs,
        obs.snapshot as BookSnapshot,
        Date.now(),
      );
      return conflict === undefined
        ? { needsDetail: false }
        : { needsDetail: false, review: conflict };
    }
    // Packaging an older planner left unplaced is replayed from its
    // stored snapshot: the page is unchanged, only the verdict is stale. The
    // title's shape comes from today's parser, as normalizeBook reads it, so
    // a snapshot stored before the parser marked a gapped list never
    // replays its stale packaging. The action paces replays with the detail
    // budget.
    if (obs.recordRef === undefined && obs.queuedProposalId === undefined && staleVerdict(obs)) {
      const snapshot = obs.snapshot as BookSnapshot;
      const parsed = parseBookTitle(snapshot.title);
      return {
        needsDetail: false,
        replay: {
          ...snapshot,
          volumeLabel: parsed.volumeLabel ?? undefined,
          packaging: parsed.packaging ?? undefined,
          isBox: parsed.isBox || undefined,
        },
      };
    }
    const release =
      obs.recordRef?.type === "release" ? await ctx.db.get(obs.recordRef.id) : null;
    // Descriptions predate their import: a linked Release still without one
    // is re-read while the listing offers a blurb, paced by the detail
    // budget, so the backfill needs no forced run. So is one an aggregator
    // (ANN, Open Library) described first, unless the stored read already
    // says the same. A human's cleared description is theirs to keep
    // (`blurbPending` in applyBook agrees).
    if (
      offersBlurb &&
      release !== null &&
      release.description !== stored?.description &&
      (await blurbOutranked(ctx, release, SOURCE_KEY))
    ) {
      return { needsDetail: true };
    }
    // Pending art is whatever the snapshot names that the Release does not
    // hold yet; applyBook's rung ① serves only active, unlocked Releases.
    const cover =
      release !== null && release.status === "active" && !release.locked
        ? coverRequest(release, stored?.coverUrl)
        : undefined;
    return cover ? { needsDetail: false, cover } : { needsDetail: false };
  },
});

// ---------- applying one book ----------

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
  if (snapshot.description !== undefined) offered.description = snapshot.description;
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
 * Whether an unplaced observation carries a verdict a planner older than the
 * blurb, the line's size and Unmapped Packaging recorded. Only those
 * texts replay: a replay links, queues, or overwrites them with a verdict of
 * today's planner (unplacedVerdict, a hidden Series' note), none of which
 * replays again, so each observation replays at most once. No verdict at
 * all (an Editor's unlink) is settled too, until the page changes.
 */
function staleVerdict(observation: Doc<"sourceObservations">): boolean {
  const snapshot = observation.snapshot as Partial<BookSnapshot> | null;
  if (!snapshot?.title || !isMangaBook({ category: snapshot.category, title: snapshot.title })) {
    return false;
  }
  const reason = observation.conflicts?.find((c) => c.field === "placement")?.reason;
  return (
    reason ===
      `"${snapshot.title}" is packaging whose covered Volumes the title does not state — an Editor maps it.` ||
    reason ===
      `Box set "${snapshot.title}" needs a unique base Series and stated coverage, and outside Bootstrap Mode a review.`
  );
}

/** Why a packaging book or box set stays on its observation, today. */
function unplacedVerdict(snapshot: BookSnapshot, seriesId: Id<"series"> | null): Hold {
  return {
    kind: "packaging",
    reason: snapshot.isBox
      ? `Box set "${snapshot.title}" becomes a Release Bundle only in Bootstrap Mode, under one base Series, covering the Volumes its title or blurb states — otherwise an Editor places it.`
      : `"${snapshot.title}" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.`,
    ...(seriesId !== null ? { seriesId } : {}),
  };
}

/**
 * The Volume labels a book covers: a packaging range (from the title, else
 * the listing blurb, else a line name that declares its size —
 * lib/coverage.ts), else its own Volume; [] when nothing states it.
 */
function coveredLabels(snapshot: BookSnapshot): string[] {
  if (snapshot.packaging) {
    const range = inferCoverage(snapshot.packaging, [snapshot.description]);
    return range ? rangeLabels(range) : [];
  }
  return snapshot.volumeLabel !== undefined ? [snapshot.volumeLabel] : [];
}

/**
 * A linked box set picks up the members whose books arrived after it
 * (lib/pipeline.ts reconcileLinkedBundle), from its snapshot alone: the base
 * Series is the source's series link, else the one Series of that title.
 * Returns how many members it added, or the `conflict` when that Series is
 * not the bundle's own (a repointed series link goes to review).
 */
async function reconcileBoxMembers(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  snapshot: BookSnapshot,
  now: number,
): Promise<BundleReconcile> {
  if (observation.recordRef?.type !== "releaseBundle" || !snapshot.packaging) return { added: 0 };
  const labels = coveredLabels(snapshot);
  if (labels.length === 0) return { added: 0 };
  let seriesId = await linkedSeriesId(ctx, SOURCE_KEY, snapshot.seriesSlug);
  if (seriesId === null) {
    const candidates = await candidateSeries(ctx, snapshot.seriesTitle);
    if (candidates.length !== 1) return { added: 0 };
    seriesId = candidates[0]!._id;
  }
  const source = await getSourceByKey(ctx, SOURCE_KEY);
  return await reconcileLinkedBundle(ctx, observation.recordRef.id, {
    sourceKey: SOURCE_KEY,
    observation,
    citation: { sourceName: source?.name ?? PUBLISHER.name, url: snapshot.url },
    importComment: IMPORT_COMMENT,
    seriesId,
    labels,
    format: "physical",
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
      // An unchanged snapshot is done unless its art moved to a new URL.
      // An unchanged listing still reconciles once while it carries a blurb
      // the Release lacks (descriptions predate their import, so the first
      // sync after that change must not skip already-linked books), or one
      // that would replace an aggregator's text.
      const blurbPending =
        snapshot.description !== undefined &&
        snapshot.description !== release.description &&
        (await blurbOutranked(ctx, release, SOURCE_KEY));
      const cover = coverRequest(release, snapshot.coverUrl);
      if (!changed && !blurbPending && cover === undefined) {
        return { status: "unchanged", changed: false };
      }
      // An ISBN another Release holds is that book's: none of its facts
      // are reconciled onto this link until an Editor resolves the pair.
      if (await isbnHeldElsewhere(ctx, observation, release, snapshot.isbn13, now)) {
        return {
          status: "needsReview",
          changed,
          releaseId: release._id,
          reason: "ISBN held by another Release",
        };
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
        cover,
      };
    }

    // A box set already placed as a Release Bundle: its only reconcile is
    // the members that arrived after it, changed snapshot or not. A box now
    // listed under another Series goes to review instead.
    if (observation.recordRef?.type === "releaseBundle") {
      const { added, conflict } = await reconcileBoxMembers(ctx, observation, snapshot, now);
      if (conflict !== undefined) {
        return { status: "needsReview", changed: false, reason: conflict };
      }
      if (added > 0) return { status: "updated", changed: true };
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
    const labels = coveredLabels(snapshot);
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: packaging ? null : (snapshot.volumeLabel ?? null),
      multiVolume: packaging !== null,
      format: "physical",
      binding: snapshot.binding,
      language: IMPORT_LANGUAGE,
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
      await linkObservation(ctx, observation._id, { type: "release", id: release._id });
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
        cover: coverRequest(release, snapshot.coverUrl),
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
      description: snapshot.description,
    };

    const bootstrap = await getBootstrapMode(ctx);

    // A box set is a Release Bundle of the base Series' existing Releases.
    if (snapshot.isBox) {
      if (seriesId === null || labels.length === 0 || !bootstrap) {
        await recordUnplaced(ctx, observation, unplacedVerdict(snapshot, seriesId), now);
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
      if (bundle.conflict !== undefined) {
        return { status: "needsReview", changed: true, reason: bundle.conflict };
      }
      return { status: bundle.created ? "created" : "linked", changed: true };
    }

    const editionLine =
      packaging?.lineName != null
        ? { name: packaging.lineName, position: packaging.linePosition }
        : undefined;
    // Packaging with no coverage from any signal. In Bootstrap Mode a named
    // line's member is still created, as Unmapped Packaging under its line
    // (CONTEXT.md), for a Moderator to map; a bare range with no line name,
    // an ambiguous Series, or steady state keeps it on its observation
    // (lib/catalogTitle.ts applies the same rule).
    const unmapped =
      packaging !== null &&
      labels.length === 0 &&
      editionLine !== undefined &&
      bootstrap &&
      ambiguousSeries === 0;
    if (packaging && labels.length === 0 && !unmapped) {
      await recordUnplaced(ctx, observation, unplacedVerdict(snapshot, seriesId), now);
      return {
        status: "recordOnly",
        changed: false,
        reason: "packaging without coverage",
      };
    }

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
        editionLine,
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
      if (seriesId === null) {
        // A brand-new Series for a work an Editor hid would undo the repair:
        // the book stays on its observation instead of the queue, as in
        // Kodansha and applyCatalogTitle (the creation path checks itself).
        const removed = await removedSeriesFor(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          seriesKey: snapshot.seriesSlug,
          seriesTitle: snapshot.seriesTitle,
          publisherId: publisher?._id ?? null,
        });
        if (removed?.kind === "hidden") {
          await recordUnplaced(ctx, observation, { kind: "series", reason: removed.reason }, now);
          return { status: "recordOnly", changed: false, reason: "hidden series" };
        }
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        editionLine,
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
      ...(unmapped ? { coverageUnmapped: true as const } : {}),
      release: { ...releasePayload, publisher: PUBLISHER },
      // Tag exactly what steady state would have queued (spec §7).
      tagBootstrapUnreviewed: bootstrap && gates.length > 0,
      now,
    });
    // A Series an Editor hid: nothing was created, the reason is noted.
    if (creation.blocked !== undefined) {
      return { status: "recordOnly", changed: false, reason: "hidden series" };
    }
    const created = creation.releaseId && (await ctx.db.get(creation.releaseId));
    return {
      status: "created",
      changed: true,
      releaseId: creation.releaseId,
      cover: created ? coverRequest(created, snapshot.coverUrl) : undefined,
    };
  },
});
