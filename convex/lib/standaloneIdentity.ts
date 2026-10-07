// Human-reviewed whole-product evidence. URL syntax and singleton coverage alone
// cannot establish extent; the operator must inspect the retained publisher text.
import { v, type Infer } from "convex/values";
import { bindingFacts, bookFacts } from "./bookFacts";

export const standaloneIdentityValidator = v.object({
  kind: v.literal("completeStandaloneManga"),
  isbn13: v.string(),
  parentObservationId: v.id("sourceObservations"),
  releaseId: v.id("releases"),
  volumeId: v.id("volumes"),
  productTitle: v.string(),
  publisherName: v.string(),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.optional(v.union(v.literal("paperback"), v.literal("hardcover"))),
  extent: v.literal("complete-single-book"),
  evidenceUrl: v.string(),
  // Literal inspected passage establishing the whole standalone book, rather
  // than a statement that this SKU happens to be one physical book.
  extentStatement: v.string(),
  capture: v.object({
    fetchedAt: v.number(),
    bodySha256: v.string(),
    excerpt: v.string(),
  }),
});
export type StandaloneIdentity = Infer<typeof standaloneIdentityValidator>;

/**
 * The selected proof passage is own-product evidence, not a related-products
 * list. Fail closed on technical uncertainty without interpreting contents
 * entry numbers as product ordinals. This does not authenticate the capture.
 */
export function standalonePassageContradicts(proof: StandaloneIdentity) {
  let text = proof.extentStatement;
  // Only a complete, sequential contents list ending at Copyright has this
  // exemption. Remove the list alone so a later Volume/format claim still fails.
  text = text.replace(/\bContents\s+((?:#\d+\s+)+)Copyright\b/gi, (list, entries: string) => {
    const numbers = Array.from(entries.matchAll(/#(\d+)/g), (match) => Number(match[1]));
    return numbers.every((number, index) => number === index + 1) ? "Contents Copyright" : list;
  });
  // A book count is not an ordinal. Keep the retained publisher's exact
  // completeness phrase while rejecting Volume 1/2 and unreadable designators.
  text = text.replace(/\bin (?:one|a single) volume\b/gi, "in a single book");
  const facts = bookFacts(text);
  const bindings = bindingFacts(text);
  const digital = /\b(?:e-?books?|digital|electronic|kindle)\b/i.test(text);
  const physical = /\b(?:print|physical)(?:-only|\s+(?:edition|format))\b/i.test(text);
  const fields = Array.from(text.matchAll(/\b(?:binding|format)\s*:\s*([^;\n.]*)/gi));
  return (
    /\b(?:vol(?:ume)?s?\.?|volumen|GN)\b|#|\bbook\s+(?:[\d?]|n\/a\b|unknown\b|[ivx]+\b|one\b|two\b)/i.test(
      text,
    ) ||
    /\b(?:partial|abridged|excerpt|sample|preview|remaining|incomplete|ongoing)\b|\bonly\s+(?:the\s+)?(?:first|some)\b|\bfirst\s+(?:\d+|one|two|three|four|five)\s+(?:stories|chapters)\b/i.test(
      text,
    ) ||
    facts.labels.length > 0 ||
    facts.packaging.length > 0 ||
    facts.unreadable.length > 0 ||
    bindings.some((binding) => binding !== proof.binding) ||
    (digital && proof.format !== "digital") ||
    (physical && proof.format !== "physical") ||
    fields.some(
      ([, value]) =>
        !/^(?:(?:trade\s+)?(?:paper\s?back|soft\s?(?:cover|back|bound)|hard\s?(?:cover|back|bound))|e-?book|digital|electronic|kindle|physical|print)(?:\s+(?:edition|format|binding))?$/i.test(
          value!.trim(),
        ),
    )
  );
}
