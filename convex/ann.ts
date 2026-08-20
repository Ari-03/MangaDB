// The ANN Encyclopedia adapter (ticket #36, spec §6/§7): the weekly full
// mirror that builds the all-publisher, series-structured Series/Volume
// backbone — including the publishers whose sites are never scraped (VIZ,
// Square Enix).
//
// Etiquette: ANN allows 1 request per second; every fetch waits ≥1.1 s and
// details are batched 50 manga per request, so a ~40k-entry mirror is ~800
// detail requests. One action invocation processes a bounded number of
// batches (Convex actions are time-limited) and schedules itself to
// continue, carrying the Import Run and counters; the run closes — and the
// post-sweep withdrawal pass fires — only when the final link of the chain
// reaches the end of the report.
//
// What ANN writes, and deliberately does not write:
// - one manga entry = one Series (linked via the manga observation itself;
//   a title change at ANN is a rung-① field conflict at standard authority)
// - "(GN n)" / "(eBook n)" designators define the Volume backbone; missing
//   Volumes are created under the linked Series (spec §6 allows creating
//   the Volume of a single-volume release under a linked Series); brand-new
//   Series queue in steady state and create tagged in Bootstrap Mode
// - ANN's API carries no publisher and no ISBN, and a Release requires a
//   Publisher (spec §2) — so ANN never creates Editions or Releases. Its
//   release lines are stored as observations keyed on ANN's own release
//   ids; each links to the canonical Release once one exists (created by a
//   publisher source, PRH, or OpenLibrary) — series link + volume label +
//   format under one series is a full-key match — and from then on ANN's
//   dates reconcile in at standard authority (how VIZ dates keep fresh).
//   Ambiguity (two same-label same-format releases) is left unlinked for
//   the record — the importer never guesses.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import {
  annMangaValidator,
  mangaUrl,
  parseApiResponse,
  parseReport,
  releaseUrl,
  toSnapshot,
  type AnnMangaSnapshot,
} from "./lib/ann";
import { errorMessage, politeFetch } from "./lib/http";
import { candidateSeries, labelsEqual } from "./lib/matching";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  queueCreationProposal,
  toPartialDate,
} from "./lib/pipeline";
import { reconcileFields } from "./lib/reconcile";

export const SOURCE_KEY = "ann";
const REPORT_URL =
  "https://www.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=manga";
const API_URL = "https://cdn.animenewsnetwork.com/encyclopedia/api.xml";
const IMPORT_COMMENT = "Imported from the Anime News Network Encyclopedia.";

/** ANN's rate limit is 1 req/s; stay comfortably under it. */
const ANN_DELAY_MS = 1100;
/** Manga ids per api.xml request (ANN's documented batch maximum). */
const BATCH_SIZE = 50;
/** Report page size — one report fetch covers several detail batches. */
const REPORT_PAGE = 500;
/** Errors carried across continuation links (finishRun caps at 50 anyway). */
const MAX_CARRIED_ERRORS = 50;

// ---------- the mirror action ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      /** True when this link scheduled a continuation instead of finishing. */
      continued: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One link of the weekly mirror chain. Called with no args by the cadence
 * dispatcher; continuation links carry the run state.
 *
 *   npx convex run ann:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. Defaults to ANN's 1 req/s. */
    politeDelayMs: v.optional(v.number()),
    /** Detail batches (50 manga each) per invocation before continuing. */
    maxBatches: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    nskip: v.optional(v.number()),
    runId: v.optional(v.id("importRuns")),
    runStartedAt: v.optional(v.number()),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        'The approved-source registry has no "ann" row. Run: npx convex run importSources:seedRegistry \'{}\'',
      );
    }
    if (!source.enabled && args.runId === undefined) {
      return { skipped: "disabled" as const };
    }

    const runId: Id<"importRuns"> =
      args.runId ??
      (await ctx.runMutation(internal.imports.startRun, {
        sourceKey: SOURCE_KEY,
      }));
    const runStartedAt = args.runStartedAt ?? Date.now();
    const delay = args.politeDelayMs ?? ANN_DELAY_MS;
    const maxBatches = args.maxBatches ?? 40;
    const errors = [...(args.errors ?? [])];
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;
    let nskip = args.nskip ?? 0;

    try {
      let batchesDone = 0;
      let reachedEnd = false;

      while (batchesDone < maxBatches && !reachedEnd) {
        const pageStart = nskip;
        const reportRes = await politeFetch(
          `${REPORT_URL}&nlist=${REPORT_PAGE}&nskip=${nskip}`,
          delay,
        );
        const ids = parseReport(await reportRes.text()).map((item) => item.id);
        if (ids.length === 0) {
          reachedEnd = true;
          break;
        }

        for (
          let offset = 0;
          offset < ids.length && batchesDone < maxBatches;
          offset += BATCH_SIZE
        ) {
          const batch = ids.slice(offset, offset + BATCH_SIZE);
          try {
            const apiRes = await politeFetch(
              `${API_URL}?manga=${batch.join("/")}`,
              delay,
            );
            for (const manga of parseApiResponse(await apiRes.text())) {
              // Entries with no English book release contribute nothing to
              // the backbone (scope: all ENGLISH releases).
              if (manga.releases.length === 0) continue;
              seen++;
              try {
                const result = await ctx.runMutation(internal.ann.applyManga, {
                  snapshot: toSnapshot(manga),
                });
                if (result.changed) changed++;
              } catch (e) {
                errors.push(`manga ${manga.id}: ${errorMessage(e)}`);
              }
            }
          } catch (e) {
            errors.push(`batch @${nskip + offset}: ${errorMessage(e)}`);
          }
          batchesDone++;
          nskip += batch.length;
        }

        // A short report page whose ids are fully consumed = the end of the
        // enumeration; a full page loops for the next one.
        if (nskip - pageStart === ids.length && ids.length < REPORT_PAGE) {
          reachedEnd = true;
        }
      }

      if (!reachedEnd) {
        // Budget spent mid-mirror: hand the run to the next link.
        await ctx.scheduler.runAfter(0, internal.ann.sync, {
          politeDelayMs: args.politeDelayMs,
          maxBatches: args.maxBatches,
          nskip,
          runId,
          runStartedAt,
          seen,
          changed,
          errors: errors.slice(0, MAX_CARRIED_ERRORS),
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          continued: true,
          errorCount: errors.length,
        };
      }

      // The full mirror completed: entries the sweep no longer lists have
      // disappeared at ANN → withdrawn (spec §6; retained, never deleted).
      await ctx.runMutation(internal.imports.markWithdrawn, {
        sourceKey: SOURCE_KEY,
        notSeenSince: runStartedAt,
      });
      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        continued: false,
        errorCount: errors.length,
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
        continued: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one manga entry ----------

type ApplyResult = {
  status: "created" | "linked" | "queued" | "alreadyQueued" | "ambiguous" | "recordOnly";
  changed: boolean;
  seriesId?: Id<"series">;
  releasesLinked: number;
};

/** Volume labels this entry evidences: plain GN/eBook numbers, no ranges or
 * omnibus/box-set packaging (those describe Editions, not source Volumes). */
function backboneLabels(snapshot: AnnMangaSnapshot): Array<string | undefined> {
  const labels: Array<string | undefined> = [];
  const has = (label: string | undefined) =>
    labels.some((l) => (l ?? null) === (label ?? null));
  for (const release of snapshot.releases) {
    if (release.multi || release.editionLineHint) continue;
    if (!has(release.label)) labels.push(release.label);
  }
  return labels;
}

/**
 * The series-scoped release match: under a rung-①-linked Series, a volume
 * label + format is the full key (the ladder's publisher+title key exists
 * to disambiguate same-titled series; a stored series link is strictly
 * stronger). Exactly one clean candidate links; anything else stays
 * unlinked — the importer never guesses.
 */
async function matchReleaseInSeries(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  label: string | undefined,
  format: "physical" | "digital",
): Promise<{ kind: "one"; release: Doc<"releases"> } | { kind: "none" | "many" }> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const candidates = new Map<string, Doc<"releases">>();
  for (const volume of volumes) {
    if (volume.status !== "active") continue;
    if (!labelsEqual(volume.label, label ?? null)) continue;
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      const editionCoverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      if (editionCoverage.length !== 1) continue;
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      for (const release of releases) {
        if (release.status !== "active" || release.locked) continue;
        if (release.format !== format) continue;
        candidates.set(release._id, release);
      }
    }
  }
  const hits = [...candidates.values()];
  if (hits.length === 1) return { kind: "one", release: hits[0]! };
  return { kind: hits.length === 0 ? "none" : "many" };
}

/**
 * Reconcile one manga entry: series link/creation, the Volume backbone, and
 * per-release observations with date reconciliation. One atomic mutation
 * per manga entry (its records must change together).
 */
export const applyManga = internalMutation({
  args: { snapshot: annMangaValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? "Anime News Network Encyclopedia";
    const citation = { sourceName, url: snapshot.url };

    const { observation } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId: `manga:${snapshot.id}`,
      snapshot,
      now,
    });

    let changed = false;

    // ----- the Series: rung ① stored link, else resolve/create -----
    let seriesId: Id<"series"> | null = null;
    if (observation.recordRef?.type === "series") {
      const series = await ctx.db.get(observation.recordRef.id);
      if (series && series.status === "active") {
        seriesId = series._id;
        if (!series.locked) {
          const result = await reconcileFields(ctx, {
            sourceKey: SOURCE_KEY,
            ref: { type: "series", id: series._id },
            doc: series,
            offered: { title: snapshot.title },
            observation,
            citation,
            now,
          });
          changed = changed || result.changed;
        }
      }
    } else {
      const candidates = await candidateSeries(ctx, snapshot.title);
      if (candidates.length === 1) {
        seriesId = candidates[0]!._id;
        await ctx.db.patch(observation._id, {
          recordRef: { type: "series", id: seriesId },
        });
        changed = true;
      } else if (candidates.length > 1) {
        // Two same-titled Series: linking either would be a guess.
        return { status: "ambiguous", changed, releasesLinked: 0 };
      }
    }

    const labels = backboneLabels(snapshot);

    if (seriesId === null) {
      // Brand-new Series: the steady-state always-review gate, lifted in
      // Bootstrap Mode (spec §7) — where the whole backbone gets built.
      const bootstrap = await getBootstrapMode(ctx);
      if (!bootstrap) {
        if (await alreadyHandled(ctx, observation)) {
          return { status: "alreadyQueued", changed, releasesLinked: 0 };
        }
        await queueCreationProposal(ctx, {
          sourceKey: SOURCE_KEY,
          observation,
          seriesId: null,
          seriesTitle: snapshot.title,
          seriesAltTitles: snapshot.altTitles,
          labels: labels.filter((l): l is string => l !== undefined),
          now,
          comment: `"${snapshot.title}" observed at ${sourceName} needs a brand-new Series — steady-state creation gate. Series + Volume backbone only; ANN carries no publisher, so Releases arrive from other sources.`,
        });
        return { status: "queued", changed: true, releasesLinked: 0 };
      }
      const creation = await createCanonicalRecords(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        seriesId: null,
        seriesTitle: snapshot.title,
        seriesAltTitles: snapshot.altTitles,
        labels: labels.filter((l): l is string => l !== undefined),
        tagBootstrapUnreviewed: true,
        now,
      });
      seriesId = creation.seriesId;
      await ctx.db.patch(observation._id, {
        recordRef: { type: "series", id: seriesId },
      });
      changed = true;
    } else if (labels.length > 0) {
      // The Volume backbone under a linked Series — within the spec §6
      // auto-create boundary; a no-op when every Volume already exists.
      const creation = await createCanonicalRecords(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        citation,
        importComment: IMPORT_COMMENT,
        seriesId,
        seriesTitle: snapshot.title,
        labels: labels.filter((l): l is string => l !== undefined),
        tagBootstrapUnreviewed: false,
        now,
      });
      changed = changed || creation.changed;
    }

    // ----- release lines: observations + linking + date reconciliation -----
    let releasesLinked = 0;
    for (const release of snapshot.releases) {
      const url = /^\d+$/.test(release.annId)
        ? releaseUrl(release.annId)
        : snapshot.url;
      const { observation: releaseObs } = await upsertObservation(ctx, {
        sourceKey: SOURCE_KEY,
        sourceRecordId: `release:${release.annId}`,
        snapshot: { kind: "annRelease", mangaId: snapshot.id, ...release, url },
        now,
      });

      let canonical: Doc<"releases"> | null = null;
      if (releaseObs.recordRef?.type === "release") {
        const linked = await ctx.db.get(releaseObs.recordRef.id);
        if (linked && linked.status === "active" && !linked.locked) {
          canonical = linked;
        }
      } else if (!release.multi && !release.editionLineHint) {
        const match = await matchReleaseInSeries(
          ctx,
          seriesId,
          release.label,
          release.format,
        );
        if (match.kind === "one") {
          canonical = match.release;
          await ctx.db.patch(releaseObs._id, {
            recordRef: { type: "release", id: canonical._id },
          });
          releasesLinked++;
          changed = true;
        }
      }

      if (canonical && release.date) {
        const result = await reconcileFields(ctx, {
          sourceKey: SOURCE_KEY,
          ref: { type: "release", id: canonical._id },
          doc: canonical,
          offered: { pubDate: toPartialDate(release.date) },
          observation: releaseObs,
          citation: { sourceName, url },
          now,
        });
        changed = changed || result.changed;
      }
    }

    return {
      status: releasesLinked > 0 ? "linked" : changed ? "created" : "recordOnly",
      changed,
      seriesId,
      releasesLinked,
    };
  },
});
