import { makeFunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { heldError } from "./heldRepair";
import { nestedLimits } from "./lib/bounded";
import { MAX_GUARD_BYTES } from "./lib/heldBooks";
import { utf8Bytes } from "./lib/sourceFormat";
import {
  applySourceParent,
  restoreSourceParent,
  type SourceParentRestoreResult,
  type SourceParentResult,
  sourceParentArgs,
  sourceParentExecuteArgs,
  sourceParentRestoreArgs,
  sourceParentRestoreExecuteArgs,
  sourceParentRestoreState,
  sourceParentState,
} from "./lib/sourceSeriesParentRepair";

/*
 * G5 held-book repair: record a reviewed Kodansha `series:<slug>` parent
 * (lib/sourceSeriesParentRepair.ts). previewInternal is read-only; its
 * `expected` pins executeInternal, which applies in one nested transaction
 * and reports a refusal instead of throwing. previewRestoreInternal and
 * restoreInternal undo an apply while nothing has built on it since.
 */

const executeArgs = v.object(sourceParentExecuteArgs);
const restoreArgs = v.object(sourceParentRestoreExecuteArgs);
// Referenced by name so this module needs no generated-API entry of its own.
const executeOne = makeFunctionReference<"mutation", Infer<typeof executeArgs>, SourceParentResult>(
  "heldSourceParents:executeOneInternal",
);
const restoreOne = makeFunctionReference<
  "mutation",
  Infer<typeof restoreArgs>,
  SourceParentRestoreResult
>("heldSourceParents:restoreOneInternal");

export const previewInternal = internalQuery({
  args: sourceParentArgs,
  handler: async (ctx, args) => {
    try {
      const state = await sourceParentState(ctx, args, Date.now());
      if (state.already)
        return {
          expected: state.expected,
          refusal: null,
          action: "alreadyApplied" as const,
          parentId: state.parent._id,
          ledgerId: state.receipt._id,
          heldVolumes: null,
          bindingDiscrepancies: null,
        };
      return {
        expected: state.expected,
        refusal: null,
        action: "link" as const,
        parentId: null,
        ledgerId: null,
        heldVolumes: state.closure.held,
        // Reported for G4; this route never decides a Binding.
        bindingDiscrepancies: state.closure.bindingDiscrepancies,
      };
    } catch (error) {
      return {
        expected: null,
        refusal: heldError(error),
        action: null,
        parentId: null,
        ledgerId: null,
        heldVolumes: null,
        bindingDiscrepancies: null,
      };
    }
  },
});

export const executeInternal = internalMutation({
  args: sourceParentExecuteArgs,
  handler: async (ctx, args): Promise<SourceParentResult> => {
    if (utf8Bytes(args.expected) > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(executeOne, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const executeOneInternal = internalMutation({
  args: sourceParentExecuteArgs,
  handler: applySourceParent,
});

export const previewRestoreInternal = internalQuery({
  args: sourceParentRestoreArgs,
  handler: async (ctx, args) => {
    try {
      const state = await sourceParentRestoreState(ctx, args);
      return {
        expected: state.expected,
        refusal: null,
        action: state.already ? ("alreadyRestored" as const) : ("restore" as const),
      };
    } catch (error) {
      return { expected: null, refusal: heldError(error), action: null };
    }
  },
});

export const restoreInternal = internalMutation({
  args: sourceParentRestoreExecuteArgs,
  handler: async (ctx, args): Promise<SourceParentRestoreResult> => {
    if (utf8Bytes(args.expected) > MAX_GUARD_BYTES)
      return { status: "refused", reason: "Guard exceeds 256 KiB." };
    try {
      return await ctx.runMutation(restoreOne, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      return { status: "refused", reason: heldError(error) };
    }
  },
});
export const restoreOneInternal = internalMutation({
  args: sourceParentRestoreExecuteArgs,
  handler: restoreSourceParent,
});
