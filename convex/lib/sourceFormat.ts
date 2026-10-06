// A reviewed interpretation of one OL record. Raw observations and their history stay raw.
import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { bookFacts, bindingFacts } from "./bookFacts";
import { outOfScopeReason, parseBookTitle } from "./bookTitle";
import { toIsbn13 } from "./isbn";
import { labelsEqual, sameWorkTitle } from "./matching";
import { olEditionValidator, type OlEditionSnapshot } from "./openLibrary";
import { nonJsonPath, valueHash } from "./values";

export const reviewedFormatValidator = v.object({
  kind: v.literal("olInferredPhysicalToDigital"),
  sourceKey: v.literal("openlibrary"),
  from: v.literal("physical"),
  to: v.literal("digital"),
  key: v.string(),
  isbn13: v.string(),
  baseSnapshot: v.string(),
  reason: v.string(),
  publisher: v.object({
    kind: v.literal("publisherOwnIsbnEbook"),
    isbn13: v.string(),
    url: v.string(),
    fetchedAt: v.number(),
    bodySha256: v.string(),
    sectionSha256: v.string(),
    byteStart: v.number(),
    byteEndExclusive: v.number(),
    excerpt: v.string(),
  }),
  ol: v.object({
    kind: v.literal("olPhysicalFormatAbsent"),
    key: v.string(),
    isbn13: v.string(),
    url: v.string(),
    fetchedAt: v.number(),
    bodySha256: v.string(),
    physicalFormatAbsent: v.literal(true),
    normalizedSnapshot: v.string(),
  }),
});
export const sourceFormatDecisionValidator = reviewedFormatValidator.extend({
  proposalId: v.id("proposals"),
  decidedAt: v.number(),
  invalidatedAt: v.optional(v.number()),
});
export type ReviewedFormat = Infer<typeof reviewedFormatValidator>;
export type SourceFormatDecision = Infer<typeof sourceFormatDecisionValidator>;
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

function olSnapshot(value: unknown): value is OlEditionSnapshot {
  if (!value || typeof value !== "object" || nonJsonPath(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    Object.keys(s).every((key) => Object.hasOwn(olEditionValidator.fields, key)) &&
    [
      "subtitle",
      "volumeLabel",
      "isbn13",
      "isbn10",
      "binding",
      "physicalFormat",
      "description",
    ].every((key) => s[key] === undefined || typeof s[key] === "string") &&
    s.kind === "olEdition" &&
    typeof s.key === "string" &&
    typeof s.url === "string" &&
    typeof s.title === "string" &&
    typeof s.seriesTitle === "string" &&
    typeof s.multiVolume === "boolean" &&
    Array.isArray(s.publishers) &&
    s.publishers.every((name: unknown) => typeof name === "string") &&
    (s.format === "physical" || s.format === "digital")
  );
}

/** Eligibility is deliberately restricted to an ordinary, explicitly numbered product. */
export function reviewedFormatRefusal(
  observation: Pick<Doc<"sourceObservations">, "sourceKey" | "sourceRecordId" | "snapshot">,
  reviewed: ReviewedFormat,
): string | null {
  const s: unknown = observation.snapshot;
  if (observation.sourceKey !== "openlibrary" || !olSnapshot(s))
    return "Not a recognized OL edition.";
  if (
    utf8Bytes(reviewed.baseSnapshot) > 32 * 1024 ||
    utf8Bytes(valueHash(reviewed)) > 64 * 1024 ||
    utf8Bytes(valueHash({ publisher: reviewed.publisher, ol: reviewed.ol })) > 16 * 1024
  )
    return "Reviewed source Format evidence exceeds its bounds.";
  if (!reviewed.reason.trim() || reviewed.reason.length > 4000)
    return "Supply a short reviewed reason.";
  if (
    !/^\/books\/OL\d+M$/.test(reviewed.key) ||
    reviewed.key.length > 100 ||
    s.key !== reviewed.key ||
    observation.sourceRecordId !== reviewed.key ||
    s.url !== `https://openlibrary.org${reviewed.key}`
  )
    return "Exact OL record identity disagrees.";
  if (
    !/^\d{13}$/.test(reviewed.isbn13) ||
    toIsbn13(reviewed.isbn13) !== reviewed.isbn13 ||
    s.isbn13 !== reviewed.isbn13 ||
    (s.isbn10 !== undefined && toIsbn13(s.isbn10) !== reviewed.isbn13)
  )
    return "Exact source ISBN identity disagrees.";
  if (
    valueHash(s) !== reviewed.baseSnapshot ||
    reviewed.ol.normalizedSnapshot !== reviewed.baseSnapshot
  )
    return "Reviewed raw base differs from the current source.";
  if (
    s.format !== "physical" ||
    s.binding !== undefined ||
    s.physicalFormat !== undefined ||
    s.multiVolume ||
    s.packaging !== undefined ||
    s.bareNumber ||
    s.bareRoman ||
    s.bareSplit ||
    typeof s.volumeLabel !== "string" ||
    !s.volumeLabel.trim() ||
    s.publishers.length === 0 ||
    s.publishers.length > 12
  )
    return "Only an inferred physical ordinary Volume without binding/physical-format facts is eligible.";
  const parsed = parseBookTitle(s.title, { subtitle: s.subtitle });
  const technical = [bookFacts(s.title, [s.seriesTitle]), bookFacts(s.subtitle)];
  if (
    parsed.packaging ||
    parsed.isBox ||
    parsed.isNovel ||
    parsed.bareNumber ||
    parsed.bareRoman ||
    !sameWorkTitle(parsed.seriesTitle, s.seriesTitle) ||
    !labelsEqual(parsed.volumeLabel ?? null, s.volumeLabel) ||
    [s.title, s.subtitle].some((text) => typeof text === "string" && outOfScopeReason(text)) ||
    [s.title, s.subtitle].some(
      (text) =>
        typeof text === "string" &&
        /\baudio(?:\s?books?)?\b|\b(?:cassette|mp3|prose)\b/i.test(text),
    ) ||
    technical.some(
      (facts) =>
        facts.bindings.length ||
        facts.packaging.length ||
        facts.unreadable.length ||
        facts.labels.some((label) => !labelsEqual(label, s.volumeLabel ?? null)),
    ) ||
    parsed.formatTags.some((tag) => bindingFacts(tag).length)
  )
    return "Known source work, Volume, packaging, binding or scope facts contradict this correction.";
  const p = reviewed.publisher;
  const o = reviewed.ol;
  const section = /^ISBN:\s*([\d\s-]+)\s*\(ebook\)\s*$/i.exec(p.excerpt);
  if (
    p.isbn13 !== reviewed.isbn13 ||
    !section ||
    toIsbn13(section[1]) !== reviewed.isbn13 ||
    p.excerpt.length > 2048
  )
    return "Publisher excerpt must attach ebook directly to the source's own ISBN.";
  try {
    const url = new URL(p.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      p.url.length > 2048 ||
      url.hostname === "openlibrary.org"
    )
      return "Supply the publisher's own HTTPS evidence URL.";
  } catch {
    return "Invalid publisher evidence URL.";
  }
  if (
    o.key !== reviewed.key ||
    o.isbn13 !== reviewed.isbn13 ||
    o.url !== `https://openlibrary.org${reviewed.key}.json`
  )
    return "Exact OL absence evidence disagrees.";
  if (
    ![p.fetchedAt, o.fetchedAt].every((time) => Number.isFinite(time) && time > 0) ||
    ![p.bodySha256, p.sectionSha256, o.bodySha256].every((hash) => /^[a-f\d]{64}$/i.test(hash)) ||
    !Number.isSafeInteger(p.byteStart) ||
    !Number.isSafeInteger(p.byteEndExclusive) ||
    p.byteStart < 0 ||
    p.byteEndExclusive <= p.byteStart ||
    p.byteEndExclusive - p.byteStart !== utf8Bytes(p.excerpt)
  )
    return "Invalid evidence time, SHA-256 or byte range.";
  return null;
}

export type FormatProjection =
  | { status: "raw"; snapshot: unknown }
  | { status: "corrected"; snapshot: OlEditionSnapshot; decision: SourceFormatDecision }
  | { status: "stale"; reason: string; decision: SourceFormatDecision };

/** Refusal has no effective snapshot. A return to an old base cannot revive invalidated evidence. */
export function projectSourceFormat(
  observation: Pick<
    Doc<"sourceObservations">,
    "sourceKey" | "sourceRecordId" | "snapshot" | "reviewedSourceFormat"
  >,
): FormatProjection {
  const decision = observation.reviewedSourceFormat;
  if (!decision) return { status: "raw", snapshot: observation.snapshot };
  const refusal =
    decision.invalidatedAt !== undefined
      ? "Accepted raw source changed after review."
      : reviewedFormatRefusal(observation, decision);
  if (refusal || !olSnapshot(observation.snapshot))
    return {
      status: "stale",
      reason: `Reviewed source Format is stale: ${refusal ?? "Unreadable source."}`,
      decision,
    };
  return {
    status: "corrected",
    snapshot: { ...observation.snapshot, format: "digital" },
    decision,
  };
}

export function formatContext(observation: Doc<"sourceObservations">) {
  const projection = projectSourceFormat(observation);
  return {
    status: projection.status,
    rawFormat: olSnapshot(observation.snapshot) ? observation.snapshot.format : null,
    effectiveFormat:
      projection.status === "corrected"
        ? "digital"
        : projection.status === "stale"
          ? null
          : olSnapshot(projection.snapshot)
            ? projection.snapshot.format
            : null,
    evidence: observation.reviewedSourceFormat ?? null,
    drift: projection.status === "stale" ? projection.reason : null,
  };
}

export function invalidateSourceFormat(observation: Doc<"sourceObservations">, now: number) {
  const decision = observation.reviewedSourceFormat;
  return decision && observation.sourceKey === "openlibrary"
    ? { ...decision, invalidatedAt: decision.invalidatedAt ?? now }
    : decision;
}
