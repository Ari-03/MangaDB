import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { conversionPreview, referenceAudit, scopedReleaseState } from "./lib/heldRepair";
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
      const { bundleContentsState } = await import("./lib/heldRepair");
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
    const { bundleContentsState } = await import("./lib/heldRepair");
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
    for (const correction of args.corrections) {
      await ctx.db.patch(correction.releaseId, { format: correction.to });
      const changes = [{ field: "format", before: correction.from, after: correction.to }];
      audit.op({ kind: "update", ref: { type: "release", id: correction.releaseId }, changes });
      await audit.revise({ type: "release", id: correction.releaseId }, changes);
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
