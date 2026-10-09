// What a person attaches to a change beside its ops: the evidence rows a
// Proposal Version carries (schema `evidence`) and its change comment,
// checked before any version stores them: by drafts and submissions
// (proposals.ts) and by the Moderator's direct edit (moderation.ts). The
// bounds hold for everyone, the Data Team included: the review queue and a
// reader's Suggestions list read many of these rows in one query.

import type { Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { evidence } from "../schema";
import { fail } from "./errors";
import { observationPublic } from "./publicRecords";

export type Evidence = Infer<typeof evidence>;

/** The most evidence rows one change carries; a form attaches two or three. */
export const MAX_EVIDENCE_ROWS = 10;
/** The longest evidence URL, as for a citation (lib/moderationFields.ts normalizeCitation). */
export const MAX_EVIDENCE_URL = 2000;
/** The longest evidence note, or note beside a URL. */
export const MAX_EVIDENCE_NOTE = 2000;
/** The longest change comment. */
export const MAX_CHANGE_COMMENT = 2000;

/**
 * Check `rows` and return them without exact repeats, so no version stores
 * a row twice. Malformed or oversized rows are refused, as is an
 * observation that does not exist; with `publicOnly` (a reader's
 * Suggestion) also one the public catalog does not show
 * (lib/publicRecords.ts observationPublic).
 */
export async function checkEvidence(
  ctx: MutationCtx,
  rows: Evidence[],
  publicOnly = false,
): Promise<Evidence[]> {
  const distinct = [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
  if (distinct.length > MAX_EVIDENCE_ROWS) {
    fail("invalidEvidence", `Attach at most ${MAX_EVIDENCE_ROWS} pieces of evidence.`);
  }
  for (const row of distinct) {
    if (row.kind === "url") {
      if (!/^https?:\/\/\S+$/.test(row.url) || row.url.length > MAX_EVIDENCE_URL) {
        fail(
          "invalidEvidence",
          `Evidence URLs must be http(s) links of at most ${MAX_EVIDENCE_URL} characters.`,
        );
      }
      if ((row.note?.length ?? 0) > MAX_EVIDENCE_NOTE) {
        fail("invalidEvidence", `Evidence notes are at most ${MAX_EVIDENCE_NOTE} characters.`);
      }
    } else if (row.kind === "note") {
      if (row.text.trim() === "") {
        fail("invalidEvidence", "Evidence notes cannot be empty.");
      }
      if (row.text.length > MAX_EVIDENCE_NOTE) {
        fail("invalidEvidence", `Evidence notes are at most ${MAX_EVIDENCE_NOTE} characters.`);
      }
    } else {
      const observation = await ctx.db.get(row.observationId);
      if (!observation) fail("invalidEvidence", "Evidence references a missing observation.");
      if (publicOnly && !(await observationPublic(ctx, observation))) {
        fail("invalidEvidence", "That source record is not one the public catalog shows.");
      }
    }
  }
  return distinct;
}

/** A change comment, trimmed; refused past MAX_CHANGE_COMMENT characters. */
export function checkComment(comment: string): string {
  const trimmed = comment.trim();
  if (trimmed.length > MAX_CHANGE_COMMENT) {
    fail("commentTooLong", `Keep the change comment under ${MAX_CHANGE_COMMENT} characters.`);
  }
  return trimmed;
}
