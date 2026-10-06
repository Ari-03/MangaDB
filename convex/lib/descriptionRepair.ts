import { v } from "convex/values";

// Keep the continuation validator independent of importer runtime helpers.
export const repairCountsValidator = v.object({
  scanned: v.number(),
  snapshotFixed: v.number(),
  releaseUpdated: v.number(),
  releaseCleared: v.number(),
  errors: v.number(),
});
