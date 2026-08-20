// The PRH API adapter (ticket #36, spec §6/§7): overlays authoritative
// onsale dates and ISBNs on PRH-distributed records — Kodansha, Seven Seas,
// Dark Horse, Square Enix, Denpa, Vertical, and the rest of PRH Publisher
// Services (VIZ is not PRH-distributed). Scope enforcement is inherent: the
// API only ever returns titles PRH distributes, so PRH values can only land
// on PRH-distributed records; per the authority table its dates, ISBNs, and
// prices apply at authoritative rank, titles/creators/format at standard.
//
// Cadence (spec §6): daily future-dated + weekly full sweep. The registry
// row ticks daily; the adapter widens to a full sweep on UTC Sundays (or
// with {mode: "full"}). Withdrawal marks fire only after a complete,
// uncapped full sweep.
//
// Configuration (no live key exists in this repo — see README):
//   PRH_API_KEY        the Enhanced API key (manual activation by PRH)
//   PRH_IMPRINT_CODES  comma-separated imprint codes to mirror (verify the
//                      codes against /title/domains/PRH.US/imprints once a
//                      key is active)
// Without both, a run is skipped as "unconfigured" — never a failure.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import { errorMessage, politeFetch } from "./lib/http";
import { candidateSeries, matchRelease, type ReleaseFact } from "./lib/matching";
import { upsertObservation } from "./lib/observations";
import {
  alreadyHandled,
  createCanonicalRecords,
  creationGates,
  coveredLabels,
  ensurePublisher,
  findPublisherByName,
  needsEditionLine,
  queueCreationProposal,
  toPartialDate,
} from "./lib/pipeline";
import { imprintPublisher, parseTitleList, prhTitleValidator, type PrhTitleSnapshot } from "./lib/prh";
import { reconcileFields } from "./lib/reconcile";

export const SOURCE_KEY = "prh";
const API_BASE = "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US";
const IMPORT_COMMENT = "Imported from the Penguin Random House API.";
const ROWS_PER_PAGE = 200;

// ---------- the sync action ----------

type SyncResult =
  | { skipped: "disabled" | "unconfigured" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      mode: "future" | "full";
      completeSweep: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One PRH import run. Daily runs fetch future-dated titles (onsaleFrom =
 * today); UTC-Sunday runs (or {mode: "full"}) sweep each configured
 * imprint's whole catalog.
 *
 *   npx convex run prh:sync '{"mode":"full"}'
 */
export const sync = internalAction({
  args: {
    mode: v.optional(v.union(v.literal("future"), v.literal("full"))),
    /** Cap list pages per imprint (a cap forfeits the withdrawal pass). */
    maxPages: v.optional(v.number()),
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
        'The approved-source registry has no "prh" row. Run: npx convex run importSources:seedRegistry \'{}\'',
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const apiKey = process.env.PRH_API_KEY;
    const imprints = (process.env.PRH_IMPRINT_CODES ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code !== "");
    if (!apiKey || imprints.length === 0) {
      console.warn(
        "[imports] PRH adapter is unconfigured (set PRH_API_KEY and PRH_IMPRINT_CODES) — skipping",
      );
      return { skipped: "unconfigured" as const };
    }

    const mode: "future" | "full" =
      args.mode ?? (new Date().getUTCDay() === 0 ? "full" : "future");
    const runId: Id<"importRuns"> = await ctx.runMutation(
      internal.imports.startRun,
      { sourceKey: SOURCE_KEY },
    );
    const runStartedAt = Date.now();
    const delay = args.politeDelayMs ?? 350;
    const maxPages = args.maxPages ?? 50;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;
    let completeSweep = mode === "full";

    try {
      const today = new Date().toISOString().slice(0, 10);
      for (const imprint of imprints) {
        let start = 0;
        let pages = 0;
        for (;;) {
          if (pages >= maxPages) {
            completeSweep = false;
            break;
          }
          const params = new URLSearchParams({
            api_key: apiKey,
            imprint,
            rows: String(ROWS_PER_PAGE),
            start: String(start),
            sort: "onsale",
            dir: "asc",
          });
          if (mode === "future") params.set("onsaleFrom", today);
          const res = await politeFetch(`${API_BASE}/titles?${params}`, delay);
          const { titles, recordCount } = parseTitleList(await res.json());
          pages++;

          for (const snapshot of titles) {
            seen++;
            try {
              const result = await ctx.runMutation(internal.prh.applyTitle, {
                snapshot,
              });
              if (result.changed) changed++;
              if (result.status === "needsReview") {
                errors.push(
                  `review ${snapshot.isbn13}: ${result.reason ?? "conflict"}`,
                );
              }
            } catch (e) {
              errors.push(`title ${snapshot.isbn13}: ${errorMessage(e)}`);
            }
          }

          start += ROWS_PER_PAGE;
          const exhausted =
            titles.length === 0 ||
            (recordCount !== undefined && start >= recordCount);
          if (exhausted) break;
        }
      }

      // Disappearance → withdrawn, only after a COMPLETE full-catalog sweep
      // (absence is never evidence on a future-only or capped run).
      if (mode === "full" && completeSweep) {
        await ctx.runMutation(internal.imports.markWithdrawn, {
          sourceKey: SOURCE_KEY,
          notSeenSince: runStartedAt,
        });
      }

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
        mode,
        completeSweep: mode === "full" && completeSweep,
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
        mode,
        completeSweep: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one title ----------

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
  reason?: string;
};

/** The fields this source offers on a linked Release, in canonical form. */
function offeredReleaseFields(snapshot: PrhTitleSnapshot): Record<string, unknown> {
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
 * Reconcile one PRH title into the canonical catalog — the overlay: ISBN
 * matching links it to the existing skeleton record, then authoritative
 * dates/ISBNs/prices and standard titles/format reconcile in. Unmatched
 * titles follow the standard creation boundaries under the imprint's
 * publisher. One atomic mutation per record (spec §6).
 */
export const applyTitle = internalMutation({
  args: { snapshot: prhTitleValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? "Penguin Random House API";
    const citation = { sourceName, url: snapshot.url };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
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
        changed: result.changed,
        releaseId: release._id,
      };
    }

    // Rungs ②–⑤ via the shared ladder. The publisher key is the imprint,
    // resolved against existing rows (the overlay's usual case: the row
    // already exists from the publisher source or a prior PRH creation).
    const publisher =
      snapshot.imprint !== undefined
        ? await findPublisherByName(ctx, snapshot.imprint)
        : null;
    const fact: ReleaseFact = {
      seriesTitle: snapshot.seriesTitle,
      volumeLabel: snapshot.multiVolume ? null : (snapshot.volumeLabel ?? null),
      multiVolume: snapshot.multiVolume,
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
        sourceKey: SOURCE_KEY,
        ref: { type: "release", id: release._id },
        doc: release,
        offered: offeredReleaseFields(snapshot),
        observation,
        citation,
        now,
      });
      return { status: "linked", changed: true, releaseId: release._id };
    }

    // Creation needs a publisher; PRH's imprint description provides one.
    const publisherRow =
      snapshot.imprint !== undefined
        ? imprintPublisher(snapshot.imprint)
        : undefined;
    const labels = snapshot.multiVolume
      ? coveredLabels(snapshot.volumeLabel)
      : snapshot.volumeLabel !== undefined
        ? [snapshot.volumeLabel]
        : [];
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

    if (match.kind === "review") {
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false, reason: match.reason };
      }
      if (publisherRow === undefined) {
        // No imprint on the record: nothing reviewable to pre-fill.
        return { status: "needsReview", changed: false, reason: match.reason };
      }
      // The creation registry resolves publisherSlug at approval; ensure the
      // imprint's row exists so the queued guess stays one-click appliable.
      await ensurePublisher(ctx, publisherRow);
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId: null,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRow.slug },
        now,
        comment: `Flagged by the matching ladder (rung ${match.rung}): ${match.reason}. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.`,
      });
      return { status: "needsReview", changed: true, reason: match.reason };
    }

    if (publisherRow === undefined) {
      // Cannot create a Release without a publisher (spec §2).
      return { status: "recordOnly", changed: false };
    }

    const bootstrap = await getBootstrapMode(ctx);
    const gates = creationGates({
      // PRH keys series by bare title, never a stored link: a brand-new
      // Series is any title with no matching canonical Series.
      seriesId: null,
      multiVolume: snapshot.multiVolume,
      editionLineHint: needsEditionLine(snapshot.title),
    });
    // The brand-new-Series gate only applies when the Series truly does not
    // exist yet; an existing unique title match lifts it.
    const candidates = await candidateSeries(ctx, snapshot.seriesTitle);
    const seriesId = candidates.length === 1 ? candidates[0]!._id : null;
    const effectiveGates =
      seriesId !== null && candidates.length === 1
        ? gates.filter((gate) => gate !== "a brand-new Series")
        : gates;
    if (candidates.length > 1) {
      // Two same-titled Series: creating under either is a guess.
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false };
      }
      await ensurePublisher(ctx, publisherRow);
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId: null,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRow.slug },
        now,
        comment: `"${snapshot.title}" matches ${candidates.length} same-titled Series — the importer never guesses.`,
      });
      return { status: "needsReview", changed: true };
    }

    if (effectiveGates.length > 0 && !bootstrap) {
      if (await alreadyHandled(ctx, observation)) {
        return { status: "alreadyQueued", changed: false };
      }
      await ensurePublisher(ctx, publisherRow);
      await queueCreationProposal(ctx, {
        sourceKey: SOURCE_KEY,
        observation,
        seriesId,
        seriesTitle: snapshot.seriesTitle,
        labels,
        release: { ...releasePayload, publisherSlug: publisherRow.slug },
        now,
        comment: `"${snapshot.title}" observed at ${sourceName} needs ${effectiveGates.join(" and ")} — steady-state creation gate.`,
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
      labels,
      release: { ...releasePayload, publisher: publisherRow },
      tagBootstrapUnreviewed: bootstrap && effectiveGates.length > 0,
      now,
    });
    return { status: "created", changed: true, releaseId: creation.releaseId };
  },
});
