// The evidence rows a Proposal Version carries (schema `evidence`), checked
// before any version stores them: by Editor drafts and submissions
// (proposals.ts) and by the Moderator's direct edit (moderation.ts).

import type { Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { evidence } from "../schema";
import { fail } from "./errors";

export type Evidence = Infer<typeof evidence>;

/** Malformed evidence never reaches a version: check each row now. */
export async function checkEvidence(ctx: MutationCtx, rows: Evidence[]): Promise<void> {
  for (const row of rows) {
    if (row.kind === "url") {
      if (!/^https?:\/\/\S+$/.test(row.url)) {
        fail("invalidEvidence", "Evidence URLs must be http(s) links.");
      }
    } else if (row.kind === "note") {
      if (row.text.trim() === "") {
        fail("invalidEvidence", "Evidence notes cannot be empty.");
      }
    } else if (!(await ctx.db.get(row.observationId))) {
      fail("invalidEvidence", "Evidence references a missing observation.");
    }
  }
}
