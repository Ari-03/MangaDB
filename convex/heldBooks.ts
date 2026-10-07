import { sourceFormatState } from "./lib/heldBooks";
import { reviewedFormatValidator, utf8Bytes, formatContext } from "./lib/sourceFormat";
import { convertedClaim } from "./lib/heldRepair";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { insertApprovedProposal, insertFirstVersion } from "./moderation";
import { packagingOf, readAnnLineTitle, splitReleaseTitle } from "./lib/ann";
import { nestedLimits, platformStop } from "./lib/bounded";
import {
  bundleMatch,
  bundleEnvelope,
  contentMatch,
  heldState,
  reader,
  MAX_GUARD_BYTES,
  publisherMatch,
  reviewedMatch,
  reviewedRouting,
  refuse,
} from "./lib/heldBooks";
import { clearHold, holdOf, linkObservation, recordUnplaced } from "./lib/observations";
import { resolveActor } from "./lib/repair/audit";
import { claimResolver, isbnClaims, primaryIsbnsOf } from "./lib/releaseIsbns";
import { evidenceUrls } from "./lib/scope";
import { sameWorkTitle } from "./lib/matching";
import { isbnScope } from "./lib/scope";
import { sameValue, valueHash } from "./lib/values";
import type { AnnReleaseSnapshot } from "./ann";

export const targetValidator = v.union(
  v.object({ type: v.literal("release"), id: v.id("releases") }),
  v.object({ type: v.literal("bundle"), id: v.id("releaseBundles") }),
);
export const reviewedIdentityValidator = v.object({
  isbn13: v.string(),
  seriesId: v.id("series"),
  publisherId: v.id("publishers"),
  volumeIds: v.array(v.id("volumes")),
  evidenceUrls: v.array(v.string()),
  sourceTitle: v.optional(v.string()),
  titledVolume: v.optional(
    v.object({ productTitle: v.string(), volumeTitle: v.string(), productVolumeLabel: v.string() }),
  ),
  umbrellaRouting: v.optional(
    v.object({ sourceTitle: v.string(), productTitle: v.string(), productVolumeLabel: v.string() }),
  ),
});
const previewArgs = {
  observationId: v.id("sourceObservations"),
  target: v.optional(targetValidator),
  reviewed: v.optional(reviewedIdentityValidator),
  replay: v.optional(v.boolean()),
};

/** One observation per preview; a failed/incomplete read never produces an executable guard. */
export const previewInternal = internalQuery({
  args: previewArgs,
  handler: async (ctx, args) => {
    try {
      const state = await heldState(
        ctx,
        args.observationId,
        args.target,
        args.reviewed,
        args.replay,
      );
      let refusal: string | null = !state.eligible
        ? "Observation is linked, withdrawn, unheld or in review."
        : state.scopeReason;
      if (!refusal && args.target) {
        try {
          if (args.target.type === "release") {
            const target = state.contents!;
            if (!state.isbn13) refuse("Linking needs one valid source ISBN.");
            if (state.claims.owners.size !== 1 || !state.claims.owners.has(target.release._id))
              refuse("Target is not the sole ISBN owner.");
            if (
              !state.hold?.seriesId ||
              !target.series.some((s) => s._id === state.heldSeries?._id)
            )
              refuse("Hold needs independently reviewed source Series.");
            if (
              !(await reviewedRouting(ctx, state, target.series[0]!._id)) &&
              state.source.series &&
              !target.series.some((s) => s._id === state.source.series!._id)
            )
              refuse("Source parent Series disagrees.");
            if (args.reviewed) await reviewedMatch(ctx, state, [target]);
            else {
              await publisherMatch(ctx, state.observation, target.publisher._id);
              await contentMatch(ctx, state, target);
            }
          } else {
            const bundle = state.bundle!;
            await bundleEnvelope(ctx, state);
            if (
              state.heldSeries &&
              state.heldSeries._id !== (args.reviewed?.seriesId ?? state.source.series?._id)
            )
              refuse("Held Series differs from the Bundle's reviewed canonical work.");
            for (const owner of state.claims.owners.values()) {
              if (owner.kind === "bundle" && owner.doc._id === bundle._id) continue;
              if (owner.kind === "release") {
                const proof = await convertedClaim(ctx, owner.doc, bundle);
                if (proof) continue;
              }
              refuse("Bundle has an unconverted or unrelated ISBN owner.");
            }
            if (!state.isbn13 || !primaryIsbnsOf(bundle).has(state.isbn13))
              refuse("Bundle and source ISBN differ.");
            if (args.reviewed) {
              await reviewedMatch(ctx, state, state.memberContents);
            } else await bundleMatch(ctx, state);
          }
        } catch (error) {
          refusal =
            error instanceof ConvexError &&
            typeof error.data === "object" &&
            error.data !== null &&
            "held" in error.data
              ? String(error.data.held)
              : String(error);
        }
      }
      return {
        expected: state.expected,
        sourceFormat: formatContext(state.observation),
        refusal,
        isbn13: state.isbn13,
        hold: state.hold,
        sourceSeriesId: state.source.series?._id ?? null,
        placement: state.source.placement?.kind ?? (state.annCreate ? "create" : null),
        owners: [...state.claims.owners.values()].map((o) => ({
          kind: o.kind,
          id: o.doc._id,
          status: o.doc.status,
        })),
        classification: refusal ? "blocked" : args.target ? "linkReady" : "needsDisposition",
      };
    } catch (error) {
      const observation = await ctx.db.get(args.observationId);
      return {
        expected: null,
        sourceFormat: observation ? formatContext(observation) : null,
        refusal:
          error instanceof ConvexError
            ? String(
                typeof error.data === "object" && error.data !== null && "held" in error.data
                  ? error.data.held
                  : error.data,
              )
            : String(error),
        classification: "incomplete",
      };
    }
  },
});

const operation = v.union(
  v.literal("refreshSource"),
  v.literal("reviewSeries"),
  v.literal("link"),
  v.literal("refreshAnn"),
  v.literal("replay"),
);
const executeArgs = {
  ...previewArgs,
  actor: v.string(),
  operation,
  expected: v.string(),
  reason: v.string(),
  evidenceUrls: v.array(v.string()),
  seriesId: v.optional(v.id("series")),
};
type Result = {
  status: "applied" | "alreadyApplied" | "refused";
  reason?: string;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
  releaseId?: Id<"releases">;
};

/** Capped whole operation, including revalidation, adapter writes, maturity and audit. */
export const executeInternal = internalMutation({
  args: executeArgs,
  handler: async (ctx, args): Promise<Result> => {
    if (new TextEncoder().encode(args.expected).length > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(internal.heldBooks.applyInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      if (error instanceof ConvexError) {
        const data = error.data;
        return {
          status: "refused",
          reason:
            typeof data === "object" && data !== null && "held" in data
              ? String(data.held)
              : String(data),
        };
      }
      return { status: "refused", reason: `Whole operation rolled back: ${platformStop(error)}` };
    }
  },
});

async function audit(
  ctx: MutationCtx,
  actor: Awaited<ReturnType<typeof resolveActor>>,
  observationId: Id<"sourceObservations">,
  reason: string,
  urls: string[],
  note?: string,
) {
  const author = { kind: "user" as const, userId: actor.userId, roleAtAuthorship: actor.role };
  const proposalId = await insertApprovedProposal(ctx, author, actor.userId);
  await insertFirstVersion(ctx, proposalId, {
    ops: [],
    evidence: [
      { kind: "observation", observationId },
      ...(note ? [{ kind: "note" as const, text: note }] : []),
      ...urls.map((url) => ({ kind: "url" as const, url })),
    ],
    changeComment: reason,
  });
  return proposalId;
}

/** Nested implementation; any semantic refusal throws so incidental writes also roll back. */
export const applyInternal = internalMutation({
  args: executeArgs,
  handler: async (ctx, args): Promise<Result> => {
    const actor = await resolveActor(ctx, args.actor);
    const urls = evidenceUrls([...args.evidenceUrls, ...(args.reviewed?.evidenceUrls ?? [])]);
    if (!args.reason.trim() || args.reason.length > 4000)
      return refuse("Supply a short reviewed reason.");
    const state = await heldState(ctx, args.observationId, args.target, args.reviewed, args.replay);
    if (args.expected !== state.expected)
      return refuse(
        "Source, hold, parent, claims, scope, bootstrap or target facts changed; preview again.",
      );
    const before = valueHash({ observation: state.observation, hold: state.hold });
    let releaseId: Id<"releases"> | undefined;
    if (args.operation === "refreshSource") {
      // A member's in-review placement never loses its hold or source facts.
      if (state.proposal?.state === "inReview" && state.proposal.author.kind !== "source")
        return refuse("Member placement is in review.");
      if (
        state.observation.recordRef ||
        state.observation.withdrawn ||
        (state.proposal?.state === "inReview" && state.proposal.author.kind === "source") ||
        state.scopeReason
      )
        await clearHold(ctx, args.observationId);
      else if (state.hold) {
        if (
          state.hold.seriesId &&
          state.source.series &&
          state.hold.seriesId !== state.source.series._id
        )
          return refuse("Known held Series disagrees with source parent; direction needs review.");
        if (state.source.placement?.kind === "hold")
          await recordUnplaced(
            ctx,
            state.observation,
            state.source.placement.hold,
            Date.now(),
            true,
          );
        else if (!state.hold.seriesId && state.source.series)
          await ctx.db.patch(state.hold._id, { seriesId: state.source.series._id });
        // Classifier skip/review/match/create alone is never a terminal disposition.
      }
    } else {
      if (!state.eligible)
        return refuse("Book must be held, unlinked, present and outside review.");
      if (state.scopeReason) return refuse(state.scopeReason);
      if (args.operation === "reviewSeries") {
        if (!args.seriesId)
          return refuse("Supply the researched source Series, not an ISBN-derived guess.");
        const series = await state.r.active(args.seriesId);
        if (args.reviewed && args.reviewed.seriesId !== series._id)
          return refuse("Reviewed Series and proposed routing differ.");
        if (!state.source.series && !args.reviewed)
          return refuse("No source parent: supply exact product identity/contents review.");
        const routed = await reviewedRouting(ctx, state, series._id);
        if (state.source.series && series._id !== state.source.series._id && !routed)
          return refuse(
            "Source parent points elsewhere; repair its link before changing the hold.",
          );
        if (state.hold!.seriesId === series._id) return { status: "alreadyApplied" };
        await ctx.db.patch(state.hold!._id, { seriesId: series._id });
      } else if (args.operation === "link") {
        if (!args.target) return refuse("Choose an existing target.");
        // Reuse the actual preview contract within this transaction.
        const preview: { refusal?: string | null; expected: string | null } = await ctx.runQuery(
          internal.heldBooks.previewInternal,
          { observationId: args.observationId, target: args.target, reviewed: args.reviewed },
        );
        if (preview.refusal || preview.expected !== args.expected)
          return refuse(preview.refusal ?? "Link guard changed.");
        await linkObservation(
          ctx,
          args.observationId,
          args.target.type === "release"
            ? { type: "release", id: args.target.id }
            : { type: "releaseBundle", id: args.target.id },
        );
      } else if (args.operation === "refreshAnn") {
        if (state.observation.sourceKey !== "ann" || !state.source.series)
          return refuse("ANN requires a current canonical source Series.");
        const line = state.observation.snapshot as AnnReleaseSnapshot;
        if (line.page?.status !== "ok" || !line.page.volume)
          return refuse("Missing ANN page designator; retain all stored facts.");
        const named = readAnnLineTitle(line.title, { names: [state.source.series.title] });
        if (named.kind === "ambiguous" || !sameWorkTitle(named.work, state.source.series.title))
          return refuse("ANN work identity disagrees; retain stored facts.");
        const fresh = splitReleaseTitle(
          `${line.title} (${line.page.volume})`,
          state.source.series.title,
        );
        if (!fresh) return refuse("Designator cannot be read; retain all stored facts.");
        const packageFacts = packagingOf({ ...line, ...fresh }, [state.source.series.title]);
        if (
          packageFacts?.title.kind === "ambiguous" ||
          packageFacts?.positionConflict ||
          packageFacts?.formatConflict ||
          (line.coverageGapped && !fresh.coverageGapped) ||
          (line.coverRange && !sameValue(line.coverRange, fresh.coverRange))
        )
          return refuse("Reparse contradicts known content, position or format evidence.");
        const next = {
          ...line,
          multi: line.multi || fresh.multi,
          editionLineHint: line.editionLineHint || fresh.editionLineHint,
          ...(fresh.coverRange ? { coverRange: fresh.coverRange } : {}),
          ...(fresh.coverageGapped ? { coverageGapped: true } : {}),
        };
        if (sameValue(next, line)) return { status: "alreadyApplied" };
        await ctx.db.insert("observationSnapshots", {
          observationId: args.observationId,
          snapshot: line,
          supersededAt: Date.now(),
        });
        await ctx.db.patch(args.observationId, { snapshot: next });
      } else if (args.operation === "replay") {
        if (!args.replay)
          return refuse("Replay requires a preview with replay: true to pin slots and siblings.");
        if (state.observation.sourceKey === "openlibrary") {
          if (state.source.placement?.kind !== "create")
            return refuse(
              "Only a verified free-slot OL creation replays here; existing owners use link-only.",
            );
          const result = await ctx.runMutation(internal.openLibrary.applyStoredInternal, {
            observationId: args.observationId,
            expectedSnapshot: valueHash(state.observation.snapshot),
            expectedDecision: valueHash(state.observation.reviewedSourceFormat ?? null),
          });
          releaseId = result.releaseId;
        } else if (state.observation.sourceKey === "ann") {
          if (state.claims.owners.size)
            return refuse("Existing ISBN owners use link-only, without reconciliation.");
          const line = state.observation.snapshot as AnnReleaseSnapshot;
          const result = await ctx.runMutation(internal.ann.applyReleasePage, {
            annId: line.annId,
          });
          releaseId = result.releaseId;
        } else return refuse("This source adapter has no stored placement replay.");
      }
    }
    const afterObservation = await ctx.db.get(args.observationId);
    const afterHold = await holdOf(ctx, args.observationId);
    const after = valueHash({ observation: afterObservation, hold: afterHold });
    if (before === after) return { status: "alreadyApplied" };
    const proposalId = await audit(ctx, actor, args.observationId, args.reason.trim(), urls);
    let createdStructure: Doc<"heldRepairLedger">["createdStructure"];
    if (releaseId) {
      const release = (await ctx.db.get(releaseId)) ?? refuse("Replayed Release vanished.");
      const coverage = await state.r.many(
        ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", release.editionId)),
      );
      const siblings = await state.r.many(
        ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", release.editionId)),
      );
      const edition = await ctx.db.get(release.editionId);
      createdStructure = {
        editionId: release.editionId,
        volumeIds: coverage.map((c) => c.volumeId),
        sharedEdition: siblings.some((r) => r._id !== releaseId),
        newEdition: !state.replayBefore?.editionIds.includes(release.editionId),
        newVolumeIds: coverage
          .map((c) => c.volumeId)
          .filter((id) => !state.replayBefore?.volumeIds.includes(id)),
        newCoverageIds: coverage
          .map((c) => c._id)
          .filter((id) => !state.replayBefore?.coverageIds.includes(id)),
        lineId: edition?.editionLineId,
        newLine: Boolean(
          edition?.editionLineId && !state.replayBefore?.lineIds.includes(edition.editionLineId),
        ),
      };
    }
    const ledgerId = await ctx.db.insert("heldRepairLedger", {
      observationId: args.observationId,
      operation: args.operation,
      proposalId,
      before,
      after,
      target: args.target,
      createdReleaseId:
        releaseId && !state.replayBefore?.releaseIds.includes(releaseId) ? releaseId : undefined,
      replayedReleaseId: releaseId,
      createdStructure,
    });
    return { status: "applied", proposalId, ledgerId, ...(releaseId ? { releaseId } : {}) };
  },
});

const sourceFormatArgs = {
  observationId: v.id("sourceObservations"),
  reviewed: reviewedFormatValidator,
};
export const previewSourceFormatInternal = internalQuery({
  args: sourceFormatArgs,
  handler: async (ctx, args) => {
    try {
      const state = await sourceFormatState(ctx, args.observationId, args.reviewed);
      return {
        expected: state.expected,
        correctionReady: true,
        placementNeedsFreshPreview: true,
        refusal: null,
        rawSnapshot: state.observation.snapshot,
        proposedSnapshot: state.proposedSnapshot,
        reviewed: args.reviewed,
        sourceFormat: formatContext(state.observation),
        sourceSeriesId: state.series._id,
        publisherId: state.publisher._id,
      };
    } catch (error) {
      return {
        expected: null,
        correctionReady: false,
        placementNeedsFreshPreview: true,
        refusal: heldError(error),
      };
    }
  },
});
function heldError(error: unknown) {
  if (error instanceof ConvexError) {
    const data = error.data;
    return typeof data === "object" && data !== null && "held" in data
      ? String(data.held)
      : String(data);
  }
  return String(error);
}
const correctionArgs = { ...sourceFormatArgs, actor: v.string(), expected: v.string() };
export const correctSourceFormatInternal = internalMutation({
  args: correctionArgs,
  handler: async (ctx, args): Promise<Result> => {
    if (utf8Bytes(args.expected) > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(internal.heldBooks.applySourceFormatInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
/** All audit writes and the decision patch share the guard's capped transaction. */
export const applySourceFormatInternal = internalMutation({
  args: correctionArgs,
  handler: async (ctx, args): Promise<Result> => {
    const actor = await resolveActor(ctx, args.actor);
    const state = await sourceFormatState(ctx, args.observationId, args.reviewed);
    if (state.expected !== args.expected)
      return refuse(
        "Source, review, hold, work, publisher, claims or evidence changed; preview again.",
      );
    if (state.observation.reviewedSourceFormat) return { status: "alreadyApplied" };
    const before = valueHash({ observation: state.observation, hold: state.hold });
    const decidedAt = Date.now();
    // Reserve the complete observation, both ledger states, evidence and audit tail before writing.
    const estimatedDecision = { ...args.reviewed, decidedAt, proposalId: "reserved-proposal-id" };
    const estimatedObservation = { ...state.observation, reviewedSourceFormat: estimatedDecision };
    const estimatedAfter = valueHash({ observation: estimatedObservation, hold: state.hold });
    if (
      utf8Bytes(valueHash(estimatedDecision)) > 64 * 1024 ||
      utf8Bytes(valueHash(estimatedObservation)) > MAX_GUARD_BYTES ||
      utf8Bytes(valueHash({ before, after: estimatedAfter })) > MAX_GUARD_BYTES
    )
      return refuse("Correction observation or ledger exceeds 256 KiB audit bounds.");
    await state.r.room();
    const metrics = await ctx.meta.getTransactionMetrics();
    if (
      metrics.bytesWritten.remaining <
      utf8Bytes(valueHash(estimatedObservation)) +
        utf8Bytes(valueHash({ before, after: estimatedAfter })) +
        utf8Bytes(valueHash(args.reviewed)) +
        256 * 1024
    )
      return refuse("Insufficient correction audit write tail.");
    const proposalId = await audit(
      ctx,
      actor,
      args.observationId,
      args.reviewed.reason,
      evidenceUrls([args.reviewed.publisher.url, args.reviewed.ol.url]),
      valueHash(args.reviewed),
    );
    const decision = { ...args.reviewed, proposalId, decidedAt };
    if (utf8Bytes(valueHash(decision)) > 64 * 1024) return refuse("Decision exceeds 64 KiB.");
    await ctx.db.patch(args.observationId, { reviewedSourceFormat: decision });
    const after = valueHash({
      observation: await ctx.db.get(args.observationId),
      hold: await holdOf(ctx, args.observationId),
    });
    if (utf8Bytes(valueHash({ before, after })) > MAX_GUARD_BYTES)
      return refuse("Ledger exceeds 256 KiB.");
    const ledgerId = await ctx.db.insert("heldRepairLedger", {
      observationId: args.observationId,
      operation: "correctSourceFormat",
      proposalId,
      before,
      after,
    });
    return { status: "applied", proposalId, ledgerId };
  },
});

const restoreArgs = {
  actor: v.string(),
  ledgerId: v.id("heldRepairLedger"),
  expectedAfter: v.string(),
  reason: v.string(),
};
type Restored = {
  status: "applied";
  proposalId: Id<"proposals">;
  originalHoldId: Id<"placementHolds"> | null;
  holdId: Id<"placementHolds"> | null;
  maturity: string;
};
/** Restoration is metadata-only and refuses subsequent use. Deleted hold IDs remain provenance. */
export const restoreInternal = internalMutation({
  args: restoreArgs,
  handler: async (ctx, args): Promise<Restored> => {
    return await ctx.runMutation(internal.heldBooks.restoreOneInternal, args, {
      transactionLimits: await nestedLimits(ctx),
    });
  },
});
export const restoreOneInternal = internalMutation({
  args: restoreArgs,
  handler: async (ctx, args) => {
    const actor = await resolveActor(ctx, args.actor);
    if (!args.reason.trim() || args.reason.length > 4000)
      return refuse("Supply a short restoration reason.");
    const ledger = await ctx.db.get(args.ledgerId);
    if (!ledger) return refuse("No repair ledger.");
    if (ledger.operation === "replay" || ledger.createdReleaseId)
      return refuse(
        "Creation is not inverted by hiding: inspect new and shared structure against the full backup.",
      );
    const observation = await ctx.db.get(ledger.observationId);
    const hold = await holdOf(ctx, ledger.observationId);
    const current = valueHash({ observation, hold });
    if (current !== ledger.after || args.expectedAfter !== ledger.after)
      return refuse("Repair after-state changed; restoration refuses.");
    if (
      observation?.queuedProposalId &&
      (await ctx.db.get(observation.queuedProposalId))?.state === "inReview"
    )
      return refuse("Current Proposal is in review.");
    const before = JSON.parse(ledger.before) as {
      observation: Doc<"sourceObservations">;
      hold: Doc<"placementHolds"> | null;
    };
    if (before.observation.recordRef)
      return refuse("Restoration may not overwrite an earlier linked source.");
    if (before.hold) {
      const s = before.observation.snapshot as { isbn13?: string; isbn10?: string };
      const scope = await isbnScope(ctx, s.isbn13 ?? s.isbn10);
      if (scope) return refuse("Revoke the exact scope disposition before restoring a held book.");
    }
    if (ledger.operation === "correctSourceFormat") {
      const note = valueHash({
        originalLedgerId: ledger._id,
        originalProposalId: ledger.proposalId,
        before: ledger.before,
        after: ledger.after,
      });
      if (utf8Bytes(note) > MAX_GUARD_BYTES) return refuse("Undo evidence exceeds audit bounds.");
      await ctx.db.patch(ledger.observationId, {
        reviewedSourceFormat: before.observation.reviewedSourceFormat,
      });
      const proposalId = await audit(ctx, actor, ledger.observationId, args.reason, [], note);
      const after = valueHash({
        observation: await ctx.db.get(ledger.observationId),
        hold: await holdOf(ctx, ledger.observationId),
      });
      await ctx.db.insert("heldRepairLedger", {
        observationId: ledger.observationId,
        operation: "undoSourceFormat",
        proposalId,
        before: current,
        after,
      });
      return {
        status: "applied" as const,
        proposalId,
        originalHoldId: before.hold?._id ?? null,
        holdId: hold?._id ?? null,
        maturity: "Source Format decision restored; raw observation and hold preserved.",
      };
    }
    await ctx.db.patch(ledger.observationId, {
      reviewedSourceFormat: before.observation.reviewedSourceFormat,
      recordRef: before.observation.recordRef,
      printingIsbn13: before.observation.printingIsbn13,
      conflicts: before.observation.conflicts,
      queuedProposalId: before.observation.queuedProposalId,
      snapshot: before.observation.snapshot,
    });
    if (before.hold) {
      const { _id, _creationTime, ...fields } = before.hold;
      if (hold) await ctx.db.replace(hold._id, fields);
      else await ctx.db.insert("placementHolds", fields);
    } else if (hold) await ctx.db.delete(hold._id);
    const proposalId = await audit(ctx, actor, ledger.observationId, args.reason, []);
    return {
      status: "applied" as const,
      proposalId,
      originalHoldId: before.hold?._id ?? null,
      holdId: (await holdOf(ctx, ledger.observationId))?._id ?? null,
      maturity:
        "Existing mature evidence/projections remain; restoration does not demote a Series.",
    };
  },
});

/** Native Bundle pagination unchanged. Uninspected roots are explicit, never a clean audit. */
export const isbnNamespaceAuditInternal = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    if (paginationOpts.numItems > 20) return refuse("Namespace pages are at most 20 Bundles.");
    if (
      paginationOpts.maximumBytesRead !== undefined &&
      paginationOpts.maximumBytesRead > 4 * 1024 * 1024
    )
      return refuse("Namespace root page exceeds four MiB.");
    const page = await ctx.db.query("releaseBundles").paginate({
      ...paginationOpts,
      maximumBytesRead: paginationOpts.maximumBytesRead ?? 4 * 1024 * 1024,
    });
    const r = reader(ctx);
    const resolver = claimResolver(ctx, { room: r.room });
    const rows = [];
    for (const bundle of page.page) {
      try {
        const claims = [];
        for (const key of primaryIsbnsOf(bundle)) {
          const found = await isbnClaims(ctx, key, { resolver, room: r.room });
          if (!found?.complete || found.unresolved.length) throw new Error("Incomplete ownership");
          const owners = [...found.owners.values()];
          let classification =
            owners.some((o) => o.kind === "release") && owners.some((o) => o.kind === "bundle")
              ? "collision"
              : "reserved";
          if (classification === "collision") {
            const releases = owners.filter((o) => o.kind === "release");
            if (
              owners.filter((o) => o.kind === "bundle").length === 1 &&
              releases.length === 1 &&
              releases[0]?.kind === "release" &&
              (await convertedClaim(ctx, releases[0].doc, bundle))
            )
              classification = "converted";
          }
          claims.push({
            isbn13: key,
            classification,
            owners: [...found.owners.values()].map((o) => ({
              kind: o.kind,
              id: o.doc._id,
              status: o.doc.status,
              claims: o.claims,
            })),
          });
        }
        rows.push({ bundleId: bundle._id, complete: true, claims });
      } catch {
        rows.push({ bundleId: bundle._id, complete: false, claims: [] });
      }
    }
    return { ...page, page: rows, complete: rows.every((row) => row.complete) };
  },
});
