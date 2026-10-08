// The source a description's text is credited to, for the footer under a
// public blurb ("Source: Kodansha USA") and the edit form's "Keep" choice.
// Credit is recorded provenance, never a guess from a hostname:
//
// 1. Walk the record's Revisions newest first to the newest one that
//    touches the field's text or states its source (`citedField`).
// 2. The text that Revision chain last wrote must be the text shown now;
//    text that changed outside History is credited to nobody.
// 3. A person's stated source is the credit: their citation, or none for
//    text they said has no external source. A person's edit that stated
//    nothing (before the source control existed) credits nobody.
// 4. An import's Revision credits its citation. Without one (an import's
//    conflict a Moderator approved), it credits the page of that same
//    source's linked record whose text is exactly the text shown.
// 5. Text no Revision touched (it predates History) is credited only when
//    exactly one source's linked records offer exactly that text with an
//    https page; any disagreement credits nobody.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { recordRef } from "../schema";
import type { Infer } from "convex/values";
import { getSourceByKey } from "../importSources";
import { httpsUrl, type Citation } from "./moderationFields";

type RecordRef = Infer<typeof recordRef>;

/** Revisions read before the walk gives up and credits nobody. */
const HISTORY_SCAN = 200;
/** Linked observations read for the exact-text fallback. */
const OBSERVATION_SCAN = 30;

/** Non-blank text, trimmed, or null. */
function textOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * The only linked source record of `ref` whose `field` text is exactly
 * `text` and that names an https page, as a credit; `sourceKey` limits it
 * to that source. Several records of one source agree, so the oldest's page
 * is credited; records of two sources make it ambiguous: no credit.
 */
async function exactTextCredit(
  ctx: QueryCtx,
  ref: RecordRef,
  field: string,
  text: string,
  sourceKey?: string,
): Promise<Citation | null> {
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id))
    .take(OBSERVATION_SCAN);
  const matches: Array<Doc<"sourceObservations">> = [];
  for (const observation of observations) {
    if (sourceKey !== undefined && observation.sourceKey !== sourceKey) continue;
    // A record of another printing says nothing about this Release's text.
    if (observation.printingIsbn13 !== undefined) continue;
    const snapshot: Record<string, unknown> =
      typeof observation.snapshot === "object" && observation.snapshot !== null
        ? observation.snapshot
        : {};
    const url = snapshot.url;
    if (textOf(snapshot[field]) !== text || typeof url !== "string" || !httpsUrl(url)) continue;
    matches.push(observation);
  }
  const first = matches[0];
  if (!first || matches.some((m) => m.sourceKey !== first.sourceKey)) return null;
  const source = await getSourceByKey(ctx, first.sourceKey);
  return {
    sourceName: source?.name ?? first.sourceKey,
    url: (first.snapshot as { url: string }).url,
  };
}

/**
 * The credit for `field` on `ref`, whose current text is `text` (see the
 * rules above); null when nothing on record names a source for it.
 */
export async function fieldAttribution(
  ctx: QueryCtx,
  ref: RecordRef,
  field: string,
  text: unknown,
): Promise<Citation | null> {
  const shown = textOf(text);
  if (shown === null) return null;
  let credit: Doc<"revisions"> | undefined;
  let wrote: Doc<"revisions"> | undefined;
  let read = 0;
  for await (const revision of ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .order("desc")) {
    if (++read > HISTORY_SCAN) return null;
    const touches = revision.changes.some((change) => change.field === field);
    if (credit === undefined && (touches || revision.citedField === field)) credit = revision;
    if (touches) {
      wrote = revision;
      break;
    }
  }
  if (wrote !== undefined) {
    const after = wrote.changes.find((change) => change.field === field)?.after;
    if (textOf(after) !== shown) return null;
  }
  if (credit === undefined) return await exactTextCredit(ctx, ref, field, shown);
  if (credit.citedField === field) return credit.citation ?? null;
  if (credit.author.kind === "user") return null;
  if (credit.citation) return credit.citation;
  return await exactTextCredit(ctx, ref, field, shown, credit.author.sourceKey);
}
