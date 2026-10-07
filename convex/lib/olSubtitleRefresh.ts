import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { referenceAudit } from "./heldRepair";
import { labelsEqual } from "./matching";
import { heldState, MAX_GUARD_BYTES, refuse } from "./heldBooks";
import { canonicalPublisherFor } from "./publishers";
import { sameWorkTitle } from "./matching";
import { toIsbn13 } from "./isbn";
import { parseEditionJson } from "./openLibrary";
import {
  reviewedFormatValidator,
  reviewedFormatRefusal,
  utf8Bytes,
  type ReviewedFormat,
} from "./sourceFormat";
import { sameValue, valueHash } from "./values";

const capture = v.object({
  url: v.string(),
  httpStatus: v.literal(200),
  fetchedAt: v.number(),
  bodySha256: v.string(),
  body: v.string(),
});
export const subtitleRefreshProof = v.object({
  referenceReleaseId: v.id("releases"),
  key: v.string(),
  isbn13: v.string(),
  reason: v.string(),
  ol: capture,
  reviewed: reviewedFormatValidator,
});
type Proof = Infer<typeof subtitleRefreshProof>;

async function verifyCapture(c: Infer<typeof capture>, limit: number) {
  if (utf8Bytes(c.body) > limit || !Number.isFinite(c.fetchedAt) || c.fetchedAt <= 0)
    return refuse("Capture exceeds bounds or has an invalid timestamp.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.body));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== c.bodySha256) return refuse("Captured body SHA-256 disagrees.");
}

/** Pins the complete native held context before accepting any raw snapshot change. */
export async function subtitleRefreshState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  proof: Proof,
) {
  if (!proof.reason.trim() || proof.reason.length > 4000)
    return refuse("Supply a short reviewed reason.");
  const state = await heldState(ctx, observationId, {
    type: "release",
    id: proof.referenceReleaseId,
  });
  if (
    !state.eligible ||
    state.scopeReason ||
    !state.source.series ||
    !state.heldSeries ||
    state.source.series._id !== state.heldSeries._id
  )
    return refuse(
      "Refresh needs a held, unlinked source with independently matching canonical work.",
    );
  if (state.observation.reviewedSourceFormat)
    return refuse("Existing source Format decision prevents raw refresh.");
  if (
    state.observation.sourceKey !== "openlibrary" ||
    state.observation.sourceRecordId !== proof.key ||
    !/^\/books\/OL\d+M$/.test(proof.key) ||
    state.isbn13 !== proof.isbn13 ||
    toIsbn13(proof.isbn13) !== proof.isbn13
  )
    return refuse("Exact source key or ISBN disagrees.");
  if (proof.ol.url !== `https://openlibrary.org${proof.key}.json`)
    return refuse("Use the exact own-key OL JSON URL.");
  await verifyCapture(proof.ol, 32 * 1024);
  let raw: unknown;
  try {
    raw = JSON.parse(proof.ol.body);
  } catch {
    return refuse("Invalid OL JSON body.");
  }
  const next = parseEditionJson(raw);
  const old = state.observation.snapshot;
  if (
    !old ||
    typeof old !== "object" ||
    Object.hasOwn(old, "subtitle") ||
    !next ||
    next.key !== proof.key ||
    next.isbn13 !== proof.isbn13 ||
    next.subtitle !== "The Manga Companion" ||
    !sameValue(next, { ...old, subtitle: "The Manga Companion" })
  )
    return refuse("Only an absent subtitle newly parsed as The Manga Companion may change.");
  if (!raw || typeof raw !== "object" || Object.hasOwn(raw, "physical_format"))
    return refuse("Current OL raw body has physical_format.");
  const reviewed: ReviewedFormat = proof.reviewed;
  if (
    reviewed.ol.bodySha256 !== proof.ol.bodySha256 ||
    reviewed.ol.key !== proof.key ||
    reviewed.ol.isbn13 !== proof.isbn13 ||
    reviewed.ol.url !== proof.ol.url ||
    reviewed.ol.fetchedAt !== proof.ol.fetchedAt
  )
    return refuse("Reviewed OL evidence differs from the own-key raw capture.");
  const formatRefusal = reviewedFormatRefusal({ ...state.observation, snapshot: next }, reviewed);
  if (formatRefusal) return refuse(formatRefusal);
  if (
    !sameWorkTitle(next.seriesTitle, "Rising of the Shield Hero") ||
    !next.publishers.length ||
    !next.publishers.every((name) => canonicalPublisherFor(name)?.slug === "one-peace-books")
  )
    return refuse("Source work or publisher differs from the publisher manga product.");
  const publishers = await state.r.many(
    ctx.db.query("publishers").withIndex("by_slug", (q) => q.eq("slug", "one-peace-books")),
  );
  if (publishers.length !== 1) return refuse("Publisher is unresolved or ambiguous.");
  const publisher = await state.r.active(publishers[0]!._id);
  if (
    !state.contents ||
    state.contents.publisher._id !== publisher._id ||
    state.contents.series.length !== 1 ||
    state.contents.series[0]!._id !== state.source.series._id ||
    state.contents.contents.length !== 1 ||
    !labelsEqual(state.contents.contents[0]!.volume.label ?? null, next.volumeLabel ?? null)
  )
    return refuse(
      "Reference Release must contain exactly the current source work and Volume from this publisher.",
    );
  const refs = await referenceAudit(ctx, proof.referenceReleaseId);
  if (!refs.complete) return refuse("Reference audit is incomplete.");
  const expected = valueHash({ held: state.expected, publisher, publishers, refs, proof, next });
  if (utf8Bytes(expected) > MAX_GUARD_BYTES) return refuse("Guard exceeds 256 KiB.");
  return { ...state, next, expected };
}
