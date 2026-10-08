import {
  unmappedProductArgs,
  unmappedProductExecuteArgs,
  unmappedProductState,
  applyUnmappedProduct,
  type UnmappedResult,
} from "./lib/unmappedProduct";
import {
  unmappedLinkArgs,
  unmappedLinkExecuteArgs,
  unmappedLinkState,
  applyUnmappedLink,
  type UnmappedLinkResult,
} from "./lib/unmappedLink";
import {
  digitalSiblingArgs,
  digitalSiblingState,
  createDigitalSibling,
  type SiblingResult,
} from "./lib/digitalSibling";
import {
  canonicalDigitalProof,
  canonicalDigitalProofs,
  canonicalDigitalState,
} from "./lib/canonicalDigital";
import { utf8Bytes } from "./lib/sourceFormat";
import { sameValue } from "./lib/values";
import { heldPackageContentsState, packageLedgerState } from "./lib/heldPackageContents";
import { MAX_GUARD_BYTES } from "./lib/heldBooks";
import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  conversionPreview,
  referenceAudit,
  scopedReleaseState,
  bundleContentsState,
} from "./lib/heldRepair";
import { nestedLimits } from "./lib/bounded";
import { internal } from "./_generated/api";
import { resolveActor, createAudit } from "./lib/repair/audit";
import { evidenceUrls } from "./lib/scope";
import { applyEntry } from "./lib/repair/ops";
import type { Id } from "./_generated/dataModel";
import { primaryIsbnsOf } from "./lib/releaseIsbns";
import { valueHash } from "./lib/values";
export function heldError(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data;
    return typeof data === "object" && data !== null && "held" in data
      ? String(data.held)
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
  }
  return error instanceof Error ? error.message : String(error);
}
const ids = { releaseId: v.id("releases"), bundleId: v.id("releaseBundles") };
export const referenceAuditInternal = internalQuery({
  args: { releaseId: v.id("releases"), bundleId: v.optional(v.id("releaseBundles")) },
  handler: async (ctx, args) => {
    try {
      const audit = await referenceAudit(ctx, args.releaseId, args.bundleId);
      return { complete: audit.complete, counts: audit.counts, eligible: audit.eligible };
    } catch {
      return { complete: false, counts: {}, eligible: false };
    }
  },
});
export const conversionStateInternal = internalQuery({
  args: ids,
  handler: async (ctx, args) => {
    try {
      const state = await conversionPreview(ctx, args.releaseId, args.bundleId);
      return {
        expected: state.expected,
        refusal: null,
        members: state.members.map((m) => ({ releaseId: m.releaseId, order: m.order })),
        linkedSourceCount: state.linkedSourceCount,
        sharedEdition: state.sharedEdition,
        placeholderVolumeIds: state.placeholderVolumeIds,
        privateCounts: state.already ? {} : state.refs.counts,
        alreadyConverted: state.already,
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error) };
    }
  },
});
const convertArgs = {
  ...ids,
  actor: v.string(),
  expected: v.string(),
  reason: v.string(),
  evidenceUrls: v.array(v.string()),
};
type Converted = {
  status: "applied" | "alreadyApplied" | "refused";
  reason?: string;
  proposalId?: Id<"proposals">;
  linkedSourceCount?: number;
  placeholderVolumeIds?: Id<"volumes">[];
};
export const convertInternal = internalMutation({
  args: convertArgs,
  handler: async (ctx, args): Promise<Converted> => {
    try {
      return await ctx.runMutation(internal.heldRepair.convertOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return {
        status: "refused",
        reason: heldError(error),
      };
    }
  },
});
export const convertOneInternal = internalMutation({
  args: convertArgs,
  handler: async (ctx, args): Promise<Converted> => {
    const state = await conversionPreview(ctx, args.releaseId, args.bundleId);
    if (state.expected !== args.expected)
      throw new ConvexError("Conversion state changed; preview again.");
    const actor = await resolveActor(ctx, args.actor);
    if (!args.reason.trim() || args.reason.length > 4000)
      throw new ConvexError("Conversion needs a short reviewed reason.");
    const urls = evidenceUrls(args.evidenceUrls);
    if (state.already) return { status: "alreadyApplied" };
    const audit = createAudit(
      ctx,
      actor,
      args.reason,
      urls.map((url) => ({ kind: "url" as const, url })),
    );
    const result = await applyEntry(ctx, audit, {
      kind: "releaseBundle",
      key: `held-conversion:${args.releaseId}:${args.bundleId}`,
      reason: args.reason,
      bundleId: null,
      box: { releaseId: args.releaseId, name: state.bundle.name },
      members: state.contents.map((c, i) => ({
        isbn13: c.release.isbn13 ?? [...primaryIsbnsOf(c.release)][0]!,
        order: state.members[i]!.order,
      })),
      retireVolumeIds: [],
      expectedConversion: args.expected,
    });
    if (result.status !== "applied" && result.status !== "alreadyApplied")
      throw new ConvexError("Conversion did not complete; whole operation rolled back.");
    await audit.finish();
    const proposalId = (await audit.meta()).proposalId;
    const revision = await ctx.db
      .query("revisions")
      .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", args.releaseId))
      .order("desc")
      .first();
    if (!revision || !revision.changes.some((c) => c.field === "convertedToBundle"))
      throw new ConvexError("Conversion audit is missing.");
    return {
      status: "applied",
      proposalId,
      linkedSourceCount: state.linkedSourceCount,
      placeholderVolumeIds: state.placeholderVolumeIds,
    };
  },
});

const contentsArgs = {
  bundleId: v.id("releaseBundles"),
  memberIds: v.array(v.id("releases")),
  corrections: v.array(
    v.object({
      releaseId: v.id("releases"),
      from: v.union(v.literal("physical"), v.literal("digital")),
      to: v.union(v.literal("physical"), v.literal("digital")),
    }),
  ),
};
export const bundleContentsStateInternal = internalQuery({
  args: contentsArgs,
  handler: async (ctx, args) => {
    try {
      const state = await bundleContentsState(ctx, args.bundleId, args.memberIds, args.corrections);
      return {
        expected: state.expected,
        refusal: null,
        linkedSourceCount: state.linkedSourceCount,
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error) };
    }
  },
});
const fixArgs = {
  ...contentsArgs,
  actor: v.string(),
  expected: v.string(),
  reason: v.string(),
  evidenceUrls: v.array(v.string()),
};
type Fixed = {
  status: "applied" | "alreadyApplied" | "refused";
  reason?: string;
  proposalId?: Id<"proposals">;
};
export const repairBundleContentsInternal = internalMutation({
  args: fixArgs,
  handler: async (ctx, args): Promise<Fixed> => {
    try {
      return await ctx.runMutation(internal.heldRepair.repairBundleContentsOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
/** Preserve all Release/Edition/Volume IDs and their tracking; record exact membership and format revisions. */
export const repairBundleContentsOneInternal = internalMutation({
  args: fixArgs,
  handler: async (ctx, args): Promise<Fixed> => {
    const state = await bundleContentsState(ctx, args.bundleId, args.memberIds, args.corrections);
    if (state.expected !== args.expected)
      throw new ConvexError("Contents/format state drifted; preview again.");
    if (!args.reason.trim() || args.reason.length > 4000)
      throw new ConvexError("Supply a short exact-ISBN researched reason.");
    const urls = evidenceUrls(args.evidenceUrls);
    const audit = createAudit(
      ctx,
      await resolveActor(ctx, args.actor),
      args.reason,
      urls.map((url) => ({ kind: "url" as const, url })),
    );
    // The guarded field repair refuses digital beside Other Printings and
    // clears the other Format's Binding or file format in the same audit.
    for (const correction of args.corrections) {
      const result = await applyEntry(ctx, audit, {
        kind: "updateFields",
        table: "releases",
        id: correction.releaseId,
        key: `held-contents-format:${correction.releaseId}`,
        reason: args.reason,
        evidenceObservationId: null,
        changes: [{ field: "format", before: correction.from, after: correction.to }],
      });
      if (result.status !== "applied")
        throw new ConvexError("Format correction did not apply; rolled back.");
    }
    const before = state.members
      .sort((a, b) => a.order - b.order)
      .map((m) => ({ releaseId: m.releaseId, order: m.order }));
    const after = args.memberIds.map((releaseId, i) => ({ releaseId, order: i + 1 }));
    if (valueHash(before) !== valueHash(after)) {
      for (const row of state.members) {
        const order = args.memberIds.indexOf(row.releaseId) + 1;
        if (!order) await ctx.db.delete(row._id);
        else if (order !== row.order) await ctx.db.patch(row._id, { order });
      }
      for (const [i, releaseId] of args.memberIds.entries())
        if (!state.members.some((m) => m.releaseId === releaseId))
          await ctx.db.insert("bundleMemberships", {
            bundleId: args.bundleId,
            releaseId,
            order: i + 1,
          });
      const changes = [{ field: "members", before, after }];
      audit.op({ kind: "update", ref: { type: "releaseBundle", id: args.bundleId }, changes });
      await audit.revise({ type: "releaseBundle", id: args.bundleId }, changes);
    }
    if (!audit.wrote) return { status: "alreadyApplied" };
    await audit.finish();
    return { status: "applied", proposalId: (await audit.meta()).proposalId };
  },
});

export const scopedReleaseStateInternal = internalQuery({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    try {
      const state = await scopedReleaseState(ctx, releaseId);
      return {
        expected: state.expected,
        refusal: null,
        privateCounts: state.privateCounts,
        sourceIds: state.sourceIds,
        retainedEditionId: state.release.editionId,
        retainedVolumeIds: state.contents.contents.map((c) => c.volume._id),
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error) };
    }
  },
});
const scopeHideArgs = {
  actor: v.string(),
  releaseId: v.id("releases"),
  expected: v.string(),
  reason: v.string(),
  evidenceUrls: v.array(v.string()),
};
export const hideScopedReleaseInternal = internalMutation({
  args: scopeHideArgs,
  handler: async (ctx, args): Promise<Fixed> => {
    try {
      return await ctx.runMutation(internal.heldRepair.hideScopedReleaseOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const hideScopedReleaseOneInternal = internalMutation({
  args: scopeHideArgs,
  handler: async (ctx, args): Promise<Fixed> => {
    const actor = await resolveActor(ctx, args.actor);
    if (!args.reason.trim() || args.reason.length > 4000)
      throw new ConvexError("Give a short exact-ISBN scope repair reason.");
    const urls = evidenceUrls(args.evidenceUrls);
    const state = await scopedReleaseState(ctx, args.releaseId);
    if (state.expected !== args.expected)
      throw new ConvexError("Canonical, scope, source or personal state changed; preview again.");
    const audit = createAudit(
      ctx,
      actor,
      args.reason,
      urls.map((url) => ({ kind: "url" as const, url })),
    );
    const result = await applyEntry(ctx, audit, {
      kind: "hideRelease",
      key: `held-scope:${args.releaseId}`,
      reason: args.reason,
      releaseId: args.releaseId,
      editionId: null,
      volumeIds: [],
    });
    if (result.status !== "applied")
      throw new ConvexError("Scope repair did not complete; rolled back.");
    audit.note(
      `Only this Release hidden; retained Edition ${state.release.editionId}, Volumes and ${state.sourceIds.length} historical source references.`,
    );
    await audit.finish();
    return { status: "applied", proposalId: (await audit.meta()).proposalId };
  },
});

const heldContentsArgs = {
  observationId: v.id("sourceObservations"),
  bundleId: v.id("releaseBundles"),
  memberIds: v.array(v.id("releases")),
};
export const heldBundleContentsStateInternal = internalQuery({
  args: heldContentsArgs,
  handler: async (ctx, args) => {
    try {
      const state = await heldPackageContentsState(
        ctx,
        args.observationId,
        args.bundleId,
        args.memberIds,
      );
      return { expected: state.expected, refusal: null };
    } catch (error) {
      return { expected: null, refusal: heldError(error) };
    }
  },
});
const completeContentsArgs = {
  ...heldContentsArgs,
  actor: v.string(),
  expected: v.string(),
  reason: v.string(),
  evidenceUrls: v.array(v.string()),
};
type CompletedContents = Fixed & { ledgerId?: Id<"heldRepairLedger"> };
/** Repair membership only. A separate fresh heldBooks link remains necessary to clear the hold. */
export const completeHeldBundleContentsInternal = internalMutation({
  args: completeContentsArgs,
  handler: async (ctx, args): Promise<CompletedContents> => {
    if (new TextEncoder().encode(args.expected).length > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(
        internal.heldRepair.completeHeldBundleContentsOneInternal,
        args,
        {
          transactionLimits: await nestedLimits(ctx),
        },
      );
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const completeHeldBundleContentsOneInternal = internalMutation({
  args: completeContentsArgs,
  handler: async (ctx, args): Promise<CompletedContents> => {
    const before = await heldPackageContentsState(
      ctx,
      args.observationId,
      args.bundleId,
      args.memberIds,
    );
    if (before.expected !== args.expected)
      throw new ConvexError("Contents or source state changed; preview again.");
    const serializedBefore = packageLedgerState(before.snapshot);
    const result: Fixed = await ctx.runMutation(
      internal.heldRepair.repairBundleContentsOneInternal,
      {
        bundleId: args.bundleId,
        memberIds: args.memberIds,
        corrections: [],
        actor: args.actor,
        expected: before.state.expected,
        reason: args.reason,
        evidenceUrls: args.evidenceUrls,
      },
    );
    if (result.status === "alreadyApplied") return result;
    if (result.status !== "applied" || !result.proposalId)
      throw new ConvexError("Membership repair did not complete; rolled back.");
    const after = await heldPackageContentsState(
      ctx,
      args.observationId,
      args.bundleId,
      args.memberIds,
    );
    if (
      valueHash(before.snapshot.observation) !== valueHash(after.snapshot.observation) ||
      valueHash(before.snapshot.hold) !== valueHash(after.snapshot.hold) ||
      valueHash(before.snapshot.bundle) !== valueHash(after.snapshot.bundle) ||
      valueHash(after.snapshot.members.map((m) => ({ releaseId: m.releaseId, order: m.order }))) !==
        valueHash(args.memberIds.map((releaseId, i) => ({ releaseId, order: i + 1 })))
    )
      throw new ConvexError("Membership/source preservation failed; rolled back.");
    const ledgerId = await ctx.db.insert("heldRepairLedger", {
      observationId: args.observationId,
      operation: "completeBundleContents",
      proposalId: result.proposalId,
      before: serializedBefore,
      after: packageLedgerState(after.snapshot),
      target: { type: "bundle", id: args.bundleId },
    });
    return { ...result, ledgerId };
  },
});

// Guarded correction for a reviewed own-ISBN ebook; holds require separate placement.
export const previewCanonicalDigitalInternal = internalQuery({
  args: { releaseId: v.id("releases"), observationId: v.id("sourceObservations") },
  handler: async (ctx, args) => {
    try {
      const state = await canonicalDigitalState(ctx, args.releaseId, args.observationId);
      return { expected: state.expected, refusal: null, proof: state.proof };
    } catch (error) {
      const release = await ctx.db.get(args.releaseId);
      const proof = release?.isbn13 ? canonicalDigitalProofs[release.isbn13] : undefined;
      return { expected: null, refusal: heldError(error), proof: proof ?? null };
    }
  },
});

/** Atomic existing field repair plus complete native before/after ledger. */
export const correctCanonicalDigitalInternal = internalMutation({
  args: {
    releaseId: v.id("releases"),
    observationId: v.id("sourceObservations"),
    expected: v.string(),
    actor: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await canonicalDigitalState(ctx, args.releaseId, args.observationId);
    if (state.expected !== args.expected)
      throw new ConvexError("Canonical correction state changed; preview again.");
    const audit = createAudit(
      ctx,
      await resolveActor(ctx, args.actor),
      state.proof === canonicalDigitalProof
        ? "Correct exact own-ISBN Farming Life Volume 10 ebook format. No printing relationship asserted."
        : `Correct exact own-ISBN ${state.proof.title} ebook format. No printing relationship asserted.`,
      [
        { kind: "url", url: state.proof.url },
        { kind: "note", text: valueHash(state.proof) },
      ],
    );
    await state.r.room();
    const result = await applyEntry(ctx, audit, {
      kind: "updateFields",
      table: "releases",
      id: args.releaseId,
      key: `canonical-digital:${args.releaseId}`,
      reason: "Exact own-ISBN BookWalker EBook Product and Manga breadcrumb.",
      evidenceObservationId: null,
      changes: [{ field: "format", before: "physical", after: "digital" }],
    });
    if (result.status !== "applied")
      throw new ConvexError("Canonical format repair did not apply; rolled back.");
    await audit.finish();
    const proposalId = (await audit.meta()).proposalId;
    const corrected = await ctx.db.get(args.releaseId);
    if (
      !corrected ||
      !sameValue(corrected, { ...state.release, format: "digital", binding: undefined })
    )
      throw new ConvexError("Canonical repair changed unexpected fields; rolled back.");
    const after = valueHash({
      before: state.before,
      release: corrected,
      proposal: await ctx.db.get(proposalId),
      versions: await state.r.many(
        ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId)),
      ),
      revisions: await state.r.many(
        ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", args.releaseId)),
      ),
    });
    if (utf8Bytes(valueHash({ before: state.before, after })) > MAX_GUARD_BYTES)
      throw new ConvexError("Canonical correction ledger exceeds bounds; rolled back.");
    const ledgerId = await ctx.db.insert("heldRepairLedger", {
      observationId: args.observationId,
      target: { type: "release", id: args.releaseId },
      operation: "correctCanonicalDigital",
      proposalId,
      before: state.before,
      after,
    });
    return { status: "applied", releaseId: args.releaseId, proposalId, ledgerId };
  },
});

export const previewDigitalSiblingInternal = internalQuery({
  args: digitalSiblingArgs,
  handler: async (ctx, args) => {
    try {
      const state = await digitalSiblingState(ctx, args);
      return { expected: state.expected, refusal: null };
    } catch (error) {
      return { expected: null, refusal: heldError(error) };
    }
  },
});
const createDigitalSiblingArgs = { ...digitalSiblingArgs, actor: v.string(), expected: v.string() };
export const createDigitalSiblingInternal = internalMutation({
  args: createDigitalSiblingArgs,
  handler: async (ctx, args): Promise<SiblingResult> => {
    try {
      return await ctx.runMutation(internal.heldRepair.createDigitalSiblingOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const createDigitalSiblingOneInternal = internalMutation({
  args: createDigitalSiblingArgs,
  handler: async (ctx, args): Promise<SiblingResult> => createDigitalSibling(ctx, args),
});

// Exact batch-051 product review, independent of unproved chapter/Volume coverage.
export const previewUnmappedProductInternal = internalQuery({
  args: unmappedProductArgs,
  handler: async (ctx, args) => {
    try {
      const state = await unmappedProductState(ctx, args.observationId, args.proof);
      return {
        expected: state.expected,
        refusal: null,
        action: state.already ? "alreadyApplied" : state.release ? "link" : "create",
        releaseId: state.release?._id ?? null,
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error), action: null, releaseId: null };
    }
  },
});
export const placeUnmappedProductInternal = internalMutation({
  args: unmappedProductExecuteArgs,
  handler: async (ctx, args): Promise<UnmappedResult> => {
    if (utf8Bytes(args.expected) > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(internal.heldRepair.placeUnmappedProductOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const placeUnmappedProductOneInternal = internalMutation({
  args: unmappedProductExecuteArgs,
  handler: applyUnmappedProduct,
});

// G1: identity-only link to the sole exact-ISBN owner whose contents stay unmapped.
export const previewUnmappedLinkInternal = internalQuery({
  args: unmappedLinkArgs,
  handler: async (ctx, args) => {
    try {
      const state = await unmappedLinkState(ctx, args);
      return {
        expected: state.expected,
        refusal: null,
        action: state.already ? "alreadyApplied" : "link",
        sourceFacts: state.facts,
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error), action: null, sourceFacts: null };
    }
  },
});
export const linkUnmappedProductInternal = internalMutation({
  args: unmappedLinkExecuteArgs,
  handler: async (ctx, args): Promise<UnmappedLinkResult> => {
    if (utf8Bytes(args.expected) > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(internal.heldRepair.linkUnmappedProductOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const linkUnmappedProductOneInternal = internalMutation({
  args: unmappedLinkExecuteArgs,
  handler: applyUnmappedLink,
});
