// The Kodansha adapter (ticket #36, spec §6/§7): the second own-catalog
// source through the shared pipeline, on Kodansha's first-party JSON
// endpoints (never HTML scraping). One daily run fetches the release
// calendar (~8 weekly buckets of upcoming volumes) plus this week's
// new-releases list, splits each item into per-format snapshots (print and
// digital are distinct Releases of one Edition), and hands each to
// `applyVolume` — the same observation → matching ladder → authority
// reconciliation → creation/queue flow as Seven Seas (see sevenSeas.ts for
// the pipeline narrative; the shared halves live in lib/pipeline.ts).
//
// Kodansha's endpoints expose no ISBNs or prices; the PRH API overlays
// those later at authoritative rank (Kodansha is PRH-distributed). The
// calendar is a rolling window, not a catalog sweep, so this adapter never
// marks observations withdrawn — absence from a window is not evidence.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import { errorMessage, politeFetch } from "./lib/http";
import {
  kodanshaSnapshotValidator,
  parseCalendar,
  parseNewReleases,
  sourceRecordId,
  toSnapshots,
  type KodanshaItem,
  type KodanshaSnapshot,
} from "./lib/kodansha";
import { candidateSeries, matchRelease, type ReleaseFact } from "./lib/matching";
import { upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  creationGates,
  linkSeriesObservation,
  publisherBySlug,
  queueCreationProposal,
  reconcileLinkedSeries,
  recordUnplaced,
  toPartialDate,
} from "./lib/pipeline";
import type { CanonicalPublisher } from "./lib/publishers";
import { reconcileFields } from "./lib/reconcile";

export const SOURCE_KEY = "kodansha";
const BASE_URL = "https://kodansha.us";
const PUBLISHER: CanonicalPublisher = { name: "Kodansha", slug: "kodansha" };
const VERTICAL: CanonicalPublisher = { name: "Vertical", slug: "vertical", parentSlug: "kodansha" };
const IMPORT_COMMENT = "Imported from Kodansha.";

// ---------- the sync action ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One Kodansha import run: two JSON fetches, then one apply mutation per
 * (volume, format). Runs daily per the registry cadence.
 *
 *   npx convex run kodansha:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        'The approved-source registry has no "kodansha" row. Run: npx convex run importSources:seedRegistry \'{}\'',
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const runId: Id<"importRuns"> = await ctx.runMutation(
      internal.imports.startRun,
      { sourceKey: SOURCE_KEY },
    );
    const delay = args.politeDelayMs ?? 350;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;

    try {
      // Merge the two endpoints keyed by (volume, format): the calendar has
      // the ~8-week window; new-releases refines this week with per-format
      // flags and an exact ISO date, so it wins on overlap.
      const items = new Map<string, { item: KodanshaItem; snapshot: KodanshaSnapshot }>();
      const ingest = (list: KodanshaItem[]) => {
        for (const item of list) {
          for (const snapshot of toSnapshots(item)) {
            items.set(sourceRecordId(item, snapshot.format), { item, snapshot });
          }
        }
      };
      const calendarRes = await politeFetch(
        `${BASE_URL}/wp-json/kodansha/v1/release-calendar`,
        delay,
      );
      ingest(parseCalendar(await calendarRes.json()));
      const newRes = await politeFetch(
        `${BASE_URL}/wp-json/kodansha/v1/new-releases`,
        delay,
      );
      ingest(parseNewReleases(await newRes.json()));

      for (const [recordId, { snapshot }] of items) {
        seen++;
        try {
          const result = await ctx.runMutation(internal.kodansha.applyVolume, {
            sourceRecordId: recordId,
            snapshot,
          });
          if (result.changed) changed++;
          if (result.status === "needsReview") {
            errors.push(`review ${recordId}: ${result.reason ?? "conflict"}`);
          }
          if (result.coverNeeded && result.releaseId && snapshot.coverUrl) {
            try {
              const imgRes = await politeFetch(snapshot.coverUrl, delay);
              const storageId = await ctx.storage.store(await imgRes.blob());
              await ctx.runMutation(internal.imports.attachCover, {
                releaseId: result.releaseId,
                storageId,
                sourceUrl: snapshot.coverUrl,
                attribution: source.attribution ?? PUBLISHER.name,
              });
            } catch (e) {
              errors.push(`cover ${recordId}: ${errorMessage(e)}`);
            }
          }
        } catch (e) {
          errors.push(`volume ${recordId}: ${errorMessage(e)}`);
        }
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return { runId, recordsSeen: seen, recordsChanged: changed, errorCount: errors.length };
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
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one (volume, format) ----------

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
function offeredReleaseFields(snapshot: KodanshaSnapshot): Record<string, unknown> {
  const offered: Record<string, unknown> = {};
  if (snapshot.releaseDate) offered.pubDate = toPartialDate(snapshot.releaseDate);
  return offered;
}

/**
 * Reconcile one normalized (volume, format) snapshot into the canonical
 * catalog — one atomic mutation per record (spec §6). Mirrors
 * sevenSeas.applyBook on the shared pipeline.
 */
export const applyVolume = internalMutation({
  args: { sourceRecordId: v.string(), snapshot: kodanshaSnapshotValidator },
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

    // Rung ①: stored source-id link — a rename or date shift at the source
    // is then a field conflict under the authority rules.
    if (observation.recordRef?.type === "release") {
      const release = await ctx.db.get(observation.recordRef.id);
      if (!release || release.status !== "active" || release.locked) {
        return { status: "recordOnly", changed: false };
      }
      if (!changed && release.coverImage) {
        return { status: "unchanged", changed: false };
      }
      const seriesResult = await reconcileLinkedSeries(ctx, {
        sourceKey: SOURCE_KEY,
        seriesKey: snapshot.seriesSlug,
        offeredTitle: snapshot.seriesTitle,
        citation,
        now,
      });
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

    let { seriesId } = await reconcileLinkedSeries(ctx, {
      sourceKey: SOURCE_KEY,
      seriesKey: snapshot.seriesSlug,
      offeredTitle: snapshot.seriesTitle,
      citation,
      now,
    });

    // No stored series link yet: resolve the base Series by title before
    // ever creating one (the ANN backbone usually has it already).
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

    // A packaging line's volume is an Edition Line member whose covered
    // Volumes Kodansha never states: never a Volume, left for an Editor.
    if (snapshot.packaging) {
      await recordUnplaced(
        ctx,
        observation,
        `"${snapshot.title}" is ${snapshot.packaging.lineName ?? "packaging"} of "${snapshot.seriesTitle}" with no stated coverage — an Editor maps it.`,
        now,
      );
      return { status: "recordOnly", changed: false, reason: "packaging without coverage" };
    }

    const publisherRef = await publisherForSeries(ctx, seriesId);
    const publisher = await publisherBySlug(ctx, publisherRef.slug);
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: snapshot.volumeLabel ?? null,
      multiVolume: false,
      format: snapshot.format,
      publisherId:
        publisher && publisher.status === "active" ? publisher._id : null,
    };
    const match = await matchRelease(ctx, fact);

    const releasePayload = {
      format: snapshot.format,
      pubDate: snapshot.releaseDate ? toPartialDate(snapshot.releaseDate) : undefined,
    };
    const labels = snapshot.volumeLabel !== undefined ? [snapshot.volumeLabel] : [];

    if (match.kind === "match") {
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

    if (match.kind === "review" || ambiguousSeries > 0) {
      const reason =
        match.kind === "review"
          ? match.reason
          : `${ambiguousSeries} same-titled Series`;
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false, reason };
      }
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRef.slug },
        now,
        comment:
          match.kind === "review"
            ? `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`
            : `"${snapshot.seriesTitle}" matches ${ambiguousSeries} same-titled Series — the importer never guesses.`,
      });
      return { status: "needsReview", changed: true, reason };
    }

    const bootstrap = await getBootstrapMode(ctx);
    const gates = creationGates({
      seriesId,
      multiVolume: false,
      editionLineHint: false,
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
        release: { ...releasePayload, publisherSlug: publisherRef.slug },
        now,
        comment: `"${snapshot.title}" observed at ${sourceName} needs ${gates.join(" and ")} — steady-state creation gate.`,
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
      release: { ...releasePayload, publisher: publisherRef },
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

/**
 * The publisher a Kodansha record belongs to. kodansha.us also lists its
 * Vertical imprint's books and the API names no imprint, so a Series whose
 * existing Editions are Vertical's (and none Kodansha's) is Vertical's —
 * never hard-coded Kodansha. A new or Kodansha Series stays Kodansha.
 */
async function publisherForSeries(
  ctx: MutationCtx,
  seriesId: Id<"series"> | null,
): Promise<CanonicalPublisher> {
  if (seriesId === null) return PUBLISHER;
  const slugs = new Set<string>();
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  for (const volume of volumes) {
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      if (publisher) slugs.add(publisher.slug);
    }
  }
  const vertical = (slug: string) => slug === "vertical" || slug === "vertical-comics";
  const kodansha = (slug: string) => slug === "kodansha" || slug === "kodansha-comics";
  return [...slugs].some(vertical) && ![...slugs].some(kodansha) ? VERTICAL : PUBLISHER;
}
