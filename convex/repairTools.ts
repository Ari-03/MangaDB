// Read-only guards for reviewed repair entries; writes always use repair.runBatch.
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { printingSourceState, variantState } from "./lib/repair/gaps";

/** Preview source and target facts before recording or converting a Release Variant. */
export const variantStateInternal = internalQuery({
  args: { observationId: v.id("sourceObservations"), releaseId: v.id("releases") },
  handler: async (ctx, args) => {
    const state = await variantState(ctx, args.observationId, args.releaseId);
    return {
      expected: state.expected,
      isbn13: state.isbn13,
      publisherId: state.target.publisher._id,
      binding: state.target.release.binding ?? null,
      coverage: state.target.contents.map((row) => ({
        volumeId: row.volume._id,
        extent: row.extent,
      })),
      printingRowIds: state.rows.map((row) => row._id),
    };
  },
});

/** Preview a mistaken standalone printing's complete dependencies before retiring it. */
export const printingSourceStateInternal = internalQuery({
  args: { sourceReleaseId: v.id("releases") },
  handler: async (ctx, args) => {
    const state = await printingSourceState(ctx, args.sourceReleaseId);
    return { expected: state.expected, counts: state.refs.counts, eligible: state.refs.eligible };
  },
});
