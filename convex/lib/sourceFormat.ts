// A reviewed interpretation of one OL record. Raw observations and their history stay raw.
import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { bookFacts, bindingFacts, digitalFileFormat, fileFormatFact } from "./bookFacts";
import { outOfScopeReason, parseBookTitle } from "./bookTitle";
import { fullDateValidator } from "./dates";
import { toIsbn13 } from "./isbn";
import { labelsEqual, normalizeTitle, sameWorkTitle } from "./matching";
import { olEditionValidator, type OlEditionSnapshot } from "./openLibrary";
import { canonicalPublisherFor } from "./publishers";
import { nonJsonPath, valueHash } from "./values";

// One literal section of a retained response body, by its exact UTF-8 byte range.
const capturedSection = {
  sectionSha256: v.string(),
  byteStart: v.number(),
  byteEndExclusive: v.number(),
  excerpt: v.string(),
};
// A store's own product record for the exact ebook SKU, captured whole:
// final URL, status, body SHA-256 and byte length.
const ownSkuCapture = {
  isbn13: v.string(),
  sku: v.string(),
  url: v.string(),
  httpStatus: v.literal(200),
  fetchedAt: v.number(),
  bodySha256: v.string(),
  bodyBytes: v.number(),
};
const distributorCapture = {
  kind: v.literal("primaryDigitalDistributorOwnSku"),
  ...ownSkuCapture,
};

export const reviewedFormatValidator = v.object({
  kind: v.literal("olInferredPhysicalToDigital"),
  sourceKey: v.literal("openlibrary"),
  from: v.literal("physical"),
  to: v.literal("digital"),
  key: v.string(),
  isbn13: v.string(),
  baseSnapshot: v.string(),
  reason: v.string(),
  // The ebook evidence: the publisher's own "ISBN: … (ebook)" line, a
  // distributor's own SKU metadata (BookWalker JSON-LD Product plus its
  // BreadcrumbList; OverDrive's mediaItems object), or the publisher's own
  // Shopify product for the SKU, kept as literal sections.
  publisher: v.union(
    v.object({
      kind: v.literal("publisherOwnIsbnEbook"),
      isbn13: v.string(),
      url: v.string(),
      fetchedAt: v.number(),
      bodySha256: v.string(),
      ...capturedSection,
    }),
    v.object({
      ...distributorCapture,
      distributor: v.literal("bookwalker"),
      product: v.object(capturedSection),
      breadcrumbs: v.object(capturedSection),
    }),
    v.object({
      ...distributorCapture,
      distributor: v.literal("overdrive"),
      mediaItems: v.object(capturedSection),
    }),
    // The facts the reviewer read from the product's own tags, re-read from
    // the section on every projection: its file format, the imprint it is
    // published under (the legal parent or an imprint of it), and its own
    // publication date. Its variant price states no currency and is not used.
    v.object({
      kind: v.literal("publisherOwnShopifySkuEbook"),
      ...ownSkuCapture,
      product: v.object(capturedSection),
      digitalFileFormat,
      imprint: v.string(),
      publishDate: fullDateValidator,
    }),
  ),
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
    (s.digitalFileFormat === undefined || fileFormatFact(s.digitalFileFormat) !== null) &&
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
    s.digitalFileFormat !== undefined ||
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
  if (p.isbn13 !== reviewed.isbn13)
    return "Publisher excerpt must attach ebook directly to the source's own ISBN.";
  if (p.kind === "publisherOwnIsbnEbook") {
    // A literal &nbsp; between the ISBN and "(ebook)" reads as the space it
    // renders; the stored excerpt and its byte range stay as captured.
    const section = /^ISBN:\s*([\d\s-]+)\s*\(ebook\)\s*$/i.exec(p.excerpt.replace(/&nbsp;/g, " "));
    if (!section || toIsbn13(section[1]) !== reviewed.isbn13 || p.excerpt.length > 2048)
      return "Publisher excerpt must attach ebook directly to the source's own ISBN.";
  } else {
    const refusal =
      p.kind === "publisherOwnShopifySkuEbook" ? shopifyRefusal(p, s) : distributorRefusal(p, s);
    if (refusal) return refusal;
  }
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
  const sections =
    p.kind === "publisherOwnIsbnEbook"
      ? [p]
      : p.kind === "publisherOwnShopifySkuEbook"
        ? [p.product]
        : p.distributor === "bookwalker"
          ? [p.product, p.breadcrumbs]
          : [p.mediaItems];
  const bodyBytes = p.kind === "publisherOwnIsbnEbook" ? Number.MAX_SAFE_INTEGER : p.bodyBytes;
  if (
    ![p.fetchedAt, o.fetchedAt].every((time) => Number.isFinite(time) && time > 0) ||
    ![p.bodySha256, o.bodySha256, ...sections.map((one) => one.sectionSha256)].every((hash) =>
      /^[a-f\d]{64}$/i.test(hash),
    ) ||
    !Number.isSafeInteger(bodyBytes) ||
    sections.some(
      (one) =>
        !Number.isSafeInteger(one.byteStart) ||
        !Number.isSafeInteger(one.byteEndExclusive) ||
        one.byteStart < 0 ||
        one.byteEndExclusive <= one.byteStart ||
        one.byteEndExclusive > bodyBytes ||
        one.byteEndExclusive - one.byteStart !== utf8Bytes(one.excerpt),
    )
  )
    return "Invalid evidence time, SHA-256 or byte range.";
  return null;
}

type DistributorEvidence = Extract<
  ReviewedFormat["publisher"],
  { kind: "primaryDigitalDistributorOwnSku" }
>;
type ShopifyEvidence = Extract<
  ReviewedFormat["publisher"],
  { kind: "publisherOwnShopifySkuEbook" }
>;

/**
 * The publisher names each distributor states on its own SKU, by canonical
 * slug. Reviewed per distributor and kept out of DUPLICATE_ALIASES, so they
 * never resolve a source's publisher string.
 */
const DISTRIBUTOR_PUBLISHERS: Record<DistributorEvidence["distributor"], Record<string, string>> = {
  bookwalker: { "One Peace Books": "one-peace-books" },
  overdrive: { "One Peace Ebooks": "one-peace-books" },
};

/** The value at a key path through parsed JSON objects, or undefined. */
function at(value: unknown, ...path: string[]): unknown {
  let here = value;
  for (const key of path) {
    if (!here || typeof here !== "object" || Array.isArray(here) || !Object.hasOwn(here, key))
      return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  return here;
}

/** The literal JSON a section retained, parsed as data; undefined when it is not JSON. */
function literalJson(excerpt: string): unknown {
  try {
    return JSON.parse(excerpt);
  } catch {
    return undefined;
  }
}

/**
 * A distributor's own SKU proves the source's exact ISBN is an English manga
 * ebook of the same numbered Volume from the same publisher, read only from
 * the fields its own metadata attaches to that SKU. A novel, another ISBN on
 * the page or a related product never qualifies.
 */
export function distributorRefusal(p: DistributorEvidence, s: OlEditionSnapshot): string | null {
  const sections = p.distributor === "bookwalker" ? [p.product, p.breadcrumbs] : [p.mediaItems];
  if (sections.some((one) => utf8Bytes(one.excerpt) > 8 * 1024))
    return "Distributor evidence section exceeds 8 KiB.";
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    return "Invalid publisher evidence URL.";
  }
  const ownSku =
    p.distributor === "bookwalker"
      ? /^[\dA-Z]{12}$/.test(p.sku) &&
        url.hostname === "bookwalker.com" &&
        new RegExp(`^/volume/${p.sku}/[a-z\\d-]+$`).test(url.pathname)
      : /^\d{1,12}$/.test(p.sku) &&
        /^[a-z\d-]+\.overdrive\.com$/.test(url.hostname) &&
        url.pathname === `/media/${p.sku}`;
  if (!ownSku || url.protocol !== "https:" || url.port || url.search || url.hash)
    return "Supply the distributor's own HTTPS product URL for this SKU.";

  let name: unknown;
  let stated: unknown;
  if (p.distributor === "bookwalker") {
    const product = literalJson(p.product.excerpt);
    const crumbs = literalJson(p.breadcrumbs.excerpt);
    const types = at(product, "@type");
    const trail = at(crumbs, "itemListElement");
    name = at(product, "name");
    stated = at(product, "brand", "name");
    if (
      !Array.isArray(types) ||
      !types.includes("Book") ||
      at(product, "@id") !== `https://bookwalker.com/volume/${p.sku}` ||
      at(product, "url") !== p.url ||
      at(product, "isbn") !== p.isbn13 ||
      at(product, "bookFormat") !== "https://schema.org/EBook" ||
      at(product, "inLanguage") !== "en"
    )
      return "Distributor product must attach the exact ISBN to an English ebook at this SKU.";
    if (
      at(crumbs, "@type") !== "BreadcrumbList" ||
      !Array.isArray(trail) ||
      trail.length < 2 ||
      at(trail.at(-1), "item") !== p.url ||
      at(trail.at(-1), "name") !== name ||
      !trail.slice(0, -1).some((crumb) => at(crumb, "name") === "Manga") ||
      trail.some((crumb) => /novel/i.test(String(at(crumb, "name"))))
    )
      return "Distributor breadcrumbs must file this SKU under Manga.";
  } else {
    const items = literalJson(p.mediaItems.excerpt);
    const item = at(items, p.sku);
    const languages = at(item, "languages");
    const formats = at(item, "formats");
    const bisac = at(item, "bisacCodes");
    name = at(item, "title");
    stated = at(item, "publisher", "name");
    // Every ISBN any format of this SKU carries, in its own field or its identifiers.
    const isbns = Array.isArray(formats)
      ? formats.flatMap((format) => {
          const ids = at(format, "identifiers");
          return [
            ...(at(format, "isbn") === undefined ? [] : [at(format, "isbn")]),
            ...(Array.isArray(ids) ? ids : [])
              .filter((id) => at(id, "type") === "ISBN")
              .map((id) => at(id, "value")),
          ];
        })
      : [];
    const ebook = Array.isArray(formats)
      ? formats.filter((format) => at(format, "id") === "ebook-overdrive")
      : [];
    const ebookIds = at(ebook[0], "identifiers");
    // Series metadata is optional: the title below must name the Volume anyway.
    // Absent, it proves nothing; present, its reading order must agree.
    const series = at(item, "detailedSeries");
    const order = at(series, "readingOrder");
    if (
      !items ||
      typeof items !== "object" ||
      Object.keys(items).length !== 1 ||
      at(item, "id") !== p.sku ||
      at(item, "type", "id") !== "ebook" ||
      !Array.isArray(languages) ||
      languages.length !== 1 ||
      at(languages[0], "id") !== "en" ||
      ebook.length !== 1 ||
      at(ebook[0], "isbn") !== p.isbn13 ||
      !Array.isArray(ebookIds) ||
      !ebookIds.some((id) => at(id, "type") === "ISBN" && at(id, "value") === p.isbn13) ||
      isbns.some((isbn) => isbn !== p.isbn13)
    )
      return "Distributor product must attach the exact ISBN to an English ebook at this SKU.";
    if (
      !Array.isArray(bisac) ||
      bisac.length === 0 ||
      !bisac.every((code) => typeof code === "string" && /^CGN004\d{3}$/.test(code)) ||
      (series !== undefined &&
        (typeof order !== "string" || !labelsEqual(order, s.volumeLabel ?? null)))
    )
      return "Distributor subjects must file this SKU as manga, in its Volume's reading order when stated.";
  }

  const slug =
    typeof stated === "string" ? DISTRIBUTOR_PUBLISHERS[p.distributor][stated] : undefined;
  if (!slug || !s.publishers.every((one) => canonicalPublisherFor(one)?.slug === slug))
    return "Distributor publisher disagrees with the source's publisher.";
  if (typeof name !== "string") return "Distributor title must name the source's work and Volume.";
  const title = parseBookTitle(name);
  if (
    title.isNovel ||
    title.isBox ||
    title.packaging ||
    outOfScopeReason(name) ||
    normalizeTitle(title.seriesTitle) !== normalizeTitle(s.seriesTitle) ||
    title.volumeLabel === null ||
    !labelsEqual(title.volumeLabel, s.volumeLabel ?? null)
  )
    return "Distributor title must name the source's work and Volume.";
  return null;
}

/**
 * Publisher-owned Shopify stores, by exact host, and the canonical slug of
 * the legal publisher each sells for. Reviewed per store; a product's own
 * imprint tag may name that publisher or one of its known imprints.
 */
const SHOPIFY_STORES: Record<string, string> = { "tokyopop.com": "tokyopop" };

/** The one value a product's `prefix:` tags state, or null when absent or repeated. */
function soleTag(tags: readonly string[], prefix: string): string | null {
  const values = tags.filter((tag) => tag.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

/**
 * The publisher's own Shopify product proves the source's exact ISBN is a
 * non-shipping English manga ebook of the same numbered Volume, in the
 * reviewed file format, under the reviewed imprint of the source's legal
 * publisher, published on the reviewed date. Read only from the product
 * object the store returns for this SKU; a store route other than its
 * product JSON, a second variant, or a related product never qualifies.
 */
function shopifyRefusal(p: ShopifyEvidence, s: OlEditionSnapshot): string | null {
  if (utf8Bytes(p.product.excerpt) > 8 * 1024) return "Store product section exceeds 8 KiB.";
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    return "Invalid publisher evidence URL.";
  }
  const legal = SHOPIFY_STORES[url.hostname];
  const product = literalJson(p.product.excerpt);
  const handle = at(product, "handle");
  const listing =
    url.pathname === "/products.json" &&
    [...url.searchParams].every(
      ([key, value]) => (key === "limit" || key === "page") && /^\d{1,4}$/.test(value),
    );
  const own = typeof handle === "string" && url.pathname === `/products/${handle}.json`;
  if (
    !legal ||
    url.protocol !== "https:" ||
    url.port ||
    url.hash ||
    !(listing || (own && !url.search))
  )
    return "Supply the publisher store's own HTTPS product route for this SKU.";

  const variants = at(product, "variants");
  const tags = at(product, "tags");
  if (
    !Array.isArray(variants) ||
    variants.length !== 1 ||
    at(variants[0], "sku") !== p.sku ||
    p.sku !== p.isbn13 ||
    at(variants[0], "product_id") !== at(product, "id") ||
    typeof at(product, "id") !== "number" ||
    at(variants[0], "requires_shipping") !== false ||
    at(product, "product_type") !== "eBook" ||
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === "string")
  )
    return "Store product must attach the exact ISBN to its one non-shipping eBook variant.";
  const date = soleTag(tags, "publication-date:");
  const day = `${p.publishDate.year}-${String(p.publishDate.month).padStart(2, "0")}-${String(p.publishDate.day).padStart(2, "0")}`;
  if (
    soleTag(tags, "format:") !== "eBook" ||
    fileFormatFact(soleTag(tags, "format-detail:")) !== p.digitalFileFormat ||
    soleTag(tags, "imprint:") !== p.imprint ||
    date === null ||
    date !== day
  )
    return "Store tags must state the reviewed file format, imprint and publication date.";
  if (
    !tags.some((tag) => /^(?:bic|bisac)\b/i.test(tag) && /\bmanga\b/i.test(tag)) ||
    tags.some((tag) => /\b(?:light )?novels?\b/i.test(tag) && !/graphic[ -]novels?/i.test(tag))
  )
    return "Store subjects must file this SKU as manga.";

  // The source names the legal publisher; the product's imprint is it or one of its imprints.
  const imprint = canonicalPublisherFor(p.imprint);
  const stated = tags.filter((tag) => tag.startsWith("publisher:"));
  if (
    s.publishers.length === 0 ||
    !s.publishers.every((one) => canonicalPublisherFor(one)?.slug === legal) ||
    stated.length === 0 ||
    !stated.every((tag) => canonicalPublisherFor(tag.slice(10))?.slug === legal) ||
    !imprint ||
    (imprint.slug !== legal && imprint.parentSlug !== legal)
  )
    return "Store publisher or imprint disagrees with the source's publisher.";

  const name = at(product, "title");
  if (typeof name !== "string") return "Store title must name the source's work and Volume.";
  const title = parseBookTitle(name);
  if (
    title.isNovel ||
    title.isBox ||
    title.packaging ||
    outOfScopeReason(name) ||
    normalizeTitle(title.seriesTitle) !== normalizeTitle(s.seriesTitle) ||
    title.volumeLabel === null ||
    !labelsEqual(title.volumeLabel, s.volumeLabel ?? null)
  )
    return "Store title must name the source's work and Volume.";
  return null;
}

/**
 * The placement reading of a reviewed record: digital, and for a publisher's
 * own store product also its file format, its imprint as the publisher and
 * its own publication date. The raw snapshot keeps the legal publisher and
 * Open Library's date; only placement reads this.
 */
export function reviewedSnapshot(
  snapshot: OlEditionSnapshot,
  reviewed: ReviewedFormat,
): OlEditionSnapshot {
  const p = reviewed.publisher;
  if (p.kind !== "publisherOwnShopifySkuEbook") return { ...snapshot, format: "digital" };
  return {
    ...snapshot,
    format: "digital",
    digitalFileFormat: p.digitalFileFormat,
    publishers: [p.imprint],
    publishDate: p.publishDate,
  };
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
    snapshot: reviewedSnapshot(observation.snapshot, decision),
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
    effectiveFileFormat:
      projection.status === "corrected" ? (projection.snapshot.digitalFileFormat ?? null) : null,
    effectivePublishers: projection.status === "corrected" ? projection.snapshot.publishers : null,
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
