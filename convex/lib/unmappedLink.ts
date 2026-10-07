import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AnnReleaseSnapshot } from "../ann";
import { readObservationBook, readTitledRecord } from "../printings";
import { annContentFacts } from "./ann";
import { bindingFacts } from "./bookFacts";
import { parseBookTitle } from "./bookTitle";
import { declaredWorkNames, type WorkContext } from "./declaredWork";
import { heldState, MAX_GUARD_BYTES, type Reader, refuse, sourcePublisherNames } from "./heldBooks";
import { toIsbn13, isbn13To10 } from "./isbn";
import { labelsEqual, sameWorkTitle } from "./matching";
import { linkObservation } from "./observations";
import { findPublisherByName } from "./pipeline";
import { DUPLICATE_SLUGS } from "./publishers";
import { storedClaims } from "./releaseIsbns";
import { createAudit, resolveActor } from "./repair/audit";
import { evidenceUrls, scopeState } from "./scope";
import { utf8Bytes } from "./sourceFormat";
import { sameValue, valueHash } from "./values";

/*
 * G1: link a held source to the existing sole exact-ISBN owner whose Edition
 * is coverageUnmapped with no coverage rows. The link asserts product
 * identity only (ISBN, work, publisher, Edition Line, position, format,
 * binding). It never writes coverage, Release, Edition or Line fields, and
 * a source's stated range stays a recorded fact, never contents.
 *
 * Callers: heldRepair.previewUnmappedLinkInternal (read-only preview) and
 * heldRepair.linkUnmappedProductInternal (nested, all-or-nothing apply).
 * The ledger's before/after use heldBooks' {observation, hold} shape, so
 * heldBooks.restoreInternal can undo a link.
 */

export const UNMAPPED_LINK_OPERATION = "linkUnmappedProduct";
const MAX_EVIDENCE = 8;
const MAX_EXCERPT = 2048;
const binding = v.union(v.literal("hardcover"), v.literal("paperback"));

/**
 * One captured own-ISBN product page: what it states about this exact SKU.
 *
 * Attestation contract. The server never fetches a page or sees its body, so
 * `sha256`, `capturedAt`, `excerpt`, `statesProductTitle` and
 * `statesPublisher` are the reviewing actor's attestation: the excerpt is
 * one contiguous run of verbatim page text, with no elisions or joins, from
 * a captured body that hashes to `sha256`; `statesProductTitle` is the page's
 * own heading for this SKU, copied verbatim from that excerpt, never a
 * breadcrumb, series link or related product. The server checks only that
 * the excerpt is consistent: it holds the title, the title names the Series
 * and the Line with the position, this ISBN follows as a whole token, and
 * no other ISBN appears.
 */
const evidenceItem = v.object({
  url: v.string(),
  sha256: v.string(),
  capturedAt: v.number(),
  /** Verbatim contiguous page text from the product heading through this ISBN, at most 2 KiB. */
  excerpt: v.string(),
  /** The page's own product heading, verbatim within the excerpt. */
  statesProductTitle: v.string(),
  statesIsbn13: v.string(),
  statesLineName: v.string(),
  /** Null only for a product its publisher does not number in its line. */
  statesLinePosition: v.union(v.string(), v.null()),
  statesBinding: v.optional(binding),
  /** The publisher the page names for this SKU ("Published by Kodansha Comics"), verbatim within the excerpt. */
  statesPublisher: v.optional(v.string()),
});

/** The reviewer's exact-product identity. Every field is rechecked against stored records. */
export const unmappedLinkProof = v.object({
  isbn13: v.string(),
  seriesId: v.id("series"),
  publisherId: v.id("publishers"),
  editionLineId: v.id("editionLines"),
  lineName: v.string(),
  linePosition: v.union(v.string(), v.null()),
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: v.union(binding, v.null()),
  /** The raw source title, verbatim. */
  sourceTitle: v.string(),
  /**
   * "linePosition": the source's single label is the product's position in
   * its publisher Line ("Yu-Gi-Oh!, Vol. 5" is 3-in-1 Edition 5), not a
   * canonical Volume. "none": the source states no label.
   */
  sourceLabel: v.union(v.literal("none"), v.literal("linePosition")),
  /** An exact reviewed spelling difference between the source's line and the Line. */
  lineNameEquivalence: v.optional(v.object({ sourceLineName: v.string(), lineName: v.string() })),
  evidence: v.array(evidenceItem),
  reason: v.string(),
});
export type UnmappedLinkProof = Infer<typeof unmappedLinkProof>;

export const unmappedLinkArgs = {
  observationId: v.id("sourceObservations"),
  releaseId: v.id("releases"),
  proof: unmappedLinkProof,
};
export const unmappedLinkExecuteArgs = {
  ...unmappedLinkArgs,
  actor: v.string(),
  expected: v.string(),
};
const linkArgs = v.object(unmappedLinkArgs);
const executeArgs = v.object(unmappedLinkExecuteArgs);
export type UnmappedLinkResult = {
  status: "linked" | "alreadyApplied" | "refused";
  reason?: string;
  releaseId?: Id<"releases">;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
};

type State = Awaited<ReturnType<typeof heldState>>;
type Owner = {
  release: Doc<"releases">;
  edition: Doc<"editions">;
  line: Doc<"editionLines">;
  series: Doc<"series">;
  publisher: Doc<"publishers">;
};

const MAX_TITLE = 300;
const MAX_PUBLISHER_NAMES = 4;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Anything but a letter or digit: the gap a page may put between words. */
const GAP = "[^\\p{L}\\p{N}]*";
/** A name matched word by word, whatever punctuation the page uses ("Yu-Gi-Oh!", "Girl Friends:"). */
const looseName = (name: string) => (name.match(/[\p{L}\p{N}]+/gu) ?? []).map(escaped).join(GAP);

/**
 * ISBN-shaped tokens with their offsets: 10 or 13 characters once hyphens go.
 * Whole tokens only, never digits joined across words ("978 pages. Item 1421579283").
 */
const isbnTokens = (text: string) =>
  [...text.matchAll(/(?<![0-9Xx-])(?:[0-9]-?){9,12}[0-9Xx](?![0-9Xx-]*[0-9Xx])/g)]
    .map((match) => ({ at: match.index, isbn: match[0].replace(/-/g, "").toUpperCase() }))
    .filter((token) => token.isbn.length === 10 || token.isbn.length === 13);

/**
 * Each place `text` names the Series directly followed by the Line, with
 * the position directly after it, or null when none follows:
 * "Yu-Gi-Oh! (3-in-1 Edition), Vol. 5", "Girl Friends: The Complete
 * Collection 1", "Codename: Sailor V Eternal Edition 2". Another work's
 * Line ("Sailor Moon Eternal Edition 12"), a bare breadcrumb Line or a
 * stray number elsewhere is not such a statement.
 */
export function workLinePositions(text: string, workNames: readonly string[], lineName: string) {
  const works = workNames.map(looseName).filter(Boolean).join("|");
  const line = looseName(lineName);
  if (!works || !line) return [];
  const statement = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${works})${GAP}(?:the(?![\\p{L}\\p{N}])${GAP})?${line}(?![\\p{L}\\p{N}])` +
      `(?:${GAP}(?:(?:vol(?:ume)?|no|book|part)(?![\\p{L}\\p{N}])${GAP})?(\\p{N}+(?:\\.\\p{N}+)?)(?![\\p{L}\\p{N}]))?`,
    "giu",
  );
  return [...text.matchAll(statement)].map((match) => ({
    at: match.index,
    end: match.index + match[0].length,
    position: match[1] ?? null,
  }));
}

/**
 * Hosts that speak for a publisher's own SKU: its site or its trade
 * distributor's catalogue. Keyed by canonical publisher slug.
 */
const PUBLISHER_HOSTS: Record<string, readonly string[]> = {
  "viz-media": ["viz.com", "simonandschuster.com"],
  "seven-seas": [
    "sevenseasentertainment.com",
    "penguinrandomhouse.com",
    "penguinrandomhouseretail.com",
  ],
  kodansha: ["kodansha.us", "penguinrandomhouse.com", "penguinrandomhouseretail.com"],
  "dark-horse": ["darkhorse.com", "penguinrandomhouse.com", "penguinrandomhouseretail.com"],
};
function onPublisherHost(url: string, publisher: Pick<Doc<"publishers">, "slug">) {
  const host = new URL(url.trim()).hostname.toLowerCase();
  const hosts = PUBLISHER_HOSTS[DUPLICATE_SLUGS[publisher.slug] ?? publisher.slug] ?? [];
  return hosts.some((one) => host === one || host.endsWith(`.${one}`));
}

/** What evidence is checked against: the owner's Line and publisher, and the Series' names. */
export type EvidenceOwner = {
  line: Pick<Doc<"editionLines">, "name">;
  publisher: Pick<Doc<"publishers">, "slug">;
  workNames: readonly string[];
};

/**
 * Exact own-SKU evidence, checked against the proof and the owner. Every
 * page must pair this ISBN with its own product title, and the title alone
 * states the Line and position. Returns the normalized URLs and the
 * publishers each page names, with whether that page is publisher-side.
 */
export function checkEvidence(
  proof: Pick<
    UnmappedLinkProof,
    "isbn13" | "linePosition" | "format" | "binding" | "evidence" | "reason"
  >,
  owner: EvidenceOwner,
) {
  if (!proof.reason.trim() || proof.reason.length > 4000)
    return refuse("Give a short reviewed exact-product reason.");
  if (!proof.evidence.length || proof.evidence.length > MAX_EVIDENCE)
    return refuse(`Supply 1-${MAX_EVIDENCE} captured own-ISBN product pages.`);
  const urls = evidenceUrls(proof.evidence.map((e) => e.url));
  const own = new Set([proof.isbn13, isbn13To10(proof.isbn13)].filter(Boolean));
  const bindings = new Set<string>();
  const publishers: { name: string; publisherSide: boolean }[] = [];
  let publisherSide = false;
  for (const item of proof.evidence) {
    const excerpt = item.excerpt;
    const title = item.statesProductTitle.trim();
    const tokens = isbnTokens(excerpt);
    if (
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isFinite(item.capturedAt) ||
      item.capturedAt <= 0 ||
      !excerpt.trim() ||
      excerpt.length > MAX_EXCERPT ||
      toIsbn13(item.statesIsbn13) !== proof.isbn13 ||
      !tokens.length ||
      tokens.some((token) => !own.has(token.isbn))
    )
      return refuse(
        "Evidence must be a hashed capture whose excerpt states this exact ISBN and no other.",
      );
    const titleAt = title ? excerpt.indexOf(title) : -1;
    const isbnAt = tokens.find((token) => token.at >= titleAt + title.length)?.at;
    if (title.length > MAX_TITLE || titleAt < 0 || isbnAt === undefined)
      return refuse("Evidence must hold the page's own product title followed by this ISBN.");
    if (!sameWorkTitle(item.statesLineName, owner.line.name))
      return refuse("Evidence does not state the owner's Edition Line.");
    // The title alone states the Line and position, starting with the
    // Series' own name, and every such statement in it carries the position.
    // From the title to the ISBN, any other numbered statement must agree, so
    // a related product or a date ("Release February 2") never stands in; an
    // unnumbered series label ("Series: SPRIGGAN: Deluxe Edition") says
    // nothing about the position.
    const named = workLinePositions(title, owner.workNames, item.statesLineName);
    if (named[0]?.at !== 0)
      return refuse("Evidence title does not name the Series and the owner's Edition Line.");
    const numbered = workLinePositions(
      excerpt.slice(titleAt + title.length, isbnAt),
      owner.workNames,
      item.statesLineName,
    ).flatMap((one) => (one.position === null ? [] : [one.position]));
    const position = item.statesLinePosition;
    if (
      position === null
        ? proof.linePosition !== null ||
          named.some((one) => one.position !== null) ||
          numbered.length > 0
        : proof.linePosition === null ||
          !labelsEqual(position, proof.linePosition) ||
          named.some((one) => !one.position || !labelsEqual(one.position, position)) ||
          numbered.some((one) => !labelsEqual(one, position))
    )
      return refuse("Evidence title does not state the owner's Line position.");
    const side = onPublisherHost(item.url, owner.publisher);
    publisherSide ||= side;
    if (item.statesPublisher !== undefined) {
      const name = item.statesPublisher.trim();
      if (!name || !excerpt.includes(name))
        return refuse("Evidence publisher must be verbatim page text.");
      publishers.push({ name, publisherSide: side });
    }
    if (item.statesBinding) bindings.add(item.statesBinding);
  }
  if (bindings.size > 1) return refuse("Evidence states conflicting Bindings.");
  const stated = [...bindings][0];
  if (stated && (proof.format === "digital" || (proof.binding && stated !== proof.binding)))
    return refuse("Evidence Binding contradicts the reviewed product.");
  return { urls, publishers, publisherSide };
}
type CheckedEvidence = ReturnType<typeof checkEvidence>;

/**
 * Every source and evidence publisher name must resolve to the owner's
 * company itself: an unresolved name or a corporate-family match refuses.
 * A source that names no publisher (kodansha.us) needs a publisher-side page
 * that does.
 */
async function publisherAgrees(
  ctx: QueryCtx,
  r: Reader,
  sourceNames: string[],
  evidence: CheckedEvidence,
  owner: Owner,
) {
  if (sourceNames.length > MAX_PUBLISHER_NAMES)
    return refuse("Source states too many publishers; review them first.");
  if (!sourceNames.length && !evidence.publishers.length)
    return refuse("Source publisher identity is unknown; evidence must name the publisher.");
  const resolved = [];
  for (const name of [...sourceNames, ...evidence.publishers.map((one) => one.name)]) {
    await r.room();
    resolved.push({ name, publisherId: (await findPublisherByName(ctx, name))?._id ?? null });
  }
  r.facts.push(resolved);
  const unresolved = resolved.find((one) => !one.publisherId);
  if (unresolved)
    return refuse(`Publisher "${unresolved.name}" is unresolved; review it before linking.`);
  if (resolved.some((one) => one.publisherId !== owner.publisher._id))
    return refuse(
      "Source publisher differs from the owner's; corporate-family acceptance is deferred.",
    );
  if (!sourceNames.length && !evidence.publishers.some((one) => one.publisherSide))
    return refuse("Source names no publisher; a publisher-side page must name it.");
}

/**
 * What the source says about its own product, read by the same readers the
 * ordinary link uses: work, single label, Binding, Line name and position,
 * and any stated range (kept as a fact, never compared with or written as
 * contents). Scope, unreadable, ambiguous or conflicting statements refuse.
 */
async function sourceProductFacts(ctx: QueryCtx, state: State, series: Doc<"series">) {
  const observation = state.observation;
  const s = state.effective.snapshot as {
    title?: string;
    subtitle?: string;
    seriesTitle?: string;
    format?: string;
    coverRange?: { from: string; to: string } | null;
    coverageGapped?: boolean;
    packaging?: {
      coverRange?: { from: string; to: string } | null;
      coverageGapped?: boolean;
      lineName?: string | null;
      linePosition?: string | null;
    } | null;
  };
  const names = declaredWorkNames(series);
  const ranges: unknown[] = [s.coverRange, s.packaging?.coverRange];
  if (s.coverageGapped || s.packaging?.coverageGapped)
    return refuse("Source states incomplete contents.");
  let reading: Awaited<ReturnType<typeof readObservationBook>>;
  let lineName: string | null | undefined;
  let position: string | null | undefined;
  if (observation.sourceKey === "ann") {
    const line = observation.snapshot as AnnReleaseSnapshot;
    const parent = state.source.parent?.snapshot as { title?: unknown } | undefined;
    const context: WorkContext = {
      seriesId: series._id,
      names,
      parentTitle: typeof parent?.title === "string" ? parent.title : null,
    };
    reading = await readObservationBook(ctx, observation, [series], names, context);
    const facts = annContentFacts(line, names);
    if (
      facts.positionConflict ||
      facts.formatConflict ||
      facts.coverageGapped ||
      facts.title.kind === "ambiguous"
    )
      return refuse("Known ANN line, position, format or contents conflict.");
    ranges.push(facts.coverRange);
    lineName = facts.lineName;
    position = facts.position;
  } else {
    // The record's own product title is read whole. Kodansha's series title
    // ("Codename: Sailor V") must also name the Series on its own; read alone,
    // its trailing "V" would parse as a Volume.
    const title = s.title;
    if (!title) return refuse("Source states no product title.");
    if (s.seriesTitle !== undefined && !names.some((name) => sameWorkTitle(name, s.seriesTitle!)))
      return refuse(`Source series title "${s.seriesTitle}" is not the reviewed Series.`);
    reading = readTitledRecord(
      observation.sourceKey,
      title,
      state.effective.snapshot as Parameters<typeof readTitledRecord>[2],
      names,
      { seriesId: series._id, names, parentTitle: null },
    );
    const parsed = [parseBookTitle(title, { subtitle: s.subtitle }), parseBookTitle(title)];
    if (parsed.some((one) => one.packaging?.coverageGapped))
      return refuse("Source states incomplete contents.");
    ranges.push(...parsed.map((one) => one.packaging?.coverRange));
    lineName = s.packaging?.lineName ?? parsed[0]!.packaging?.lineName;
    const positions = [
      s.packaging?.linePosition,
      ...parsed.map((one) => one.packaging?.linePosition),
    ];
    position = positions.find((one) => !!one) ?? null;
    if (positions.some((one) => !!one && !labelsEqual(one, position ?? null)))
      return refuse("Known source positions disagree.");
  }
  if (reading.scope.length || reading.unreadable.length)
    return refuse(
      `Source scope or unreadable facts refuse: ${[...reading.scope, ...reading.unreadable].join("; ")}`,
    );
  if (!names.some((name) => sameWorkTitle(name, reading.work)))
    return refuse(`Source work "${reading.work}" is not the reviewed Series.`);
  if (reading.label && position && !labelsEqual(reading.label, position))
    return refuse("Known source label and position disagree.");
  return {
    work: reading.work,
    label: reading.label ?? null,
    binding: reading.binding ?? null,
    packaged: reading.packaging.length > 0,
    lineName: lineName ?? null,
    position: position ?? null,
    format: s.format ?? null,
    statedRanges: ranges.filter(Boolean),
  };
}

/** The owner's complete identity closure: ISBN namespace, aliases, Bundles, Line positions, coverage. */
async function ownerState(
  ctx: QueryCtx,
  state: State,
  releaseId: Id<"releases">,
  proof: UnmappedLinkProof,
): Promise<Owner> {
  const r = state.r;
  const release = await r.active(releaseId);
  if (release._id !== releaseId) return refuse("Owner Release was merged; review its survivor.");
  const edition = await r.active(release.editionId);
  if (edition._id !== release.editionId) return refuse("Owner Edition was merged.");
  if (!edition.editionLineId) return refuse("Owner has no Edition Line; use the ordinary link.");
  const line = await r.active(edition.editionLineId);
  const series = await r.active(proof.seriesId);
  const publisher = await r.active(release.publisherId);
  if (
    line._id !== edition.editionLineId ||
    series._id !== proof.seriesId ||
    publisher._id !== release.publisherId
  )
    return refuse("Owner identity was merged.");
  if (
    release.isbn13 !== proof.isbn13 ||
    (release.isbn10 !== undefined && toIsbn13(release.isbn10) !== proof.isbn13) ||
    !sameValue(release.seriesIds, [proof.seriesId]) ||
    release.publisherId !== proof.publisherId ||
    edition.publisherId !== proof.publisherId ||
    line.publisherId !== proof.publisherId ||
    line.seriesId !== proof.seriesId ||
    line._id !== proof.editionLineId ||
    line.name !== proof.lineName ||
    release.format !== proof.format ||
    (release.binding ?? null) !== proof.binding ||
    (proof.format === "digital" && proof.binding !== null)
  )
    return refuse("Owner Release, Edition or Line differs from the reviewed product.");
  if (bindingFacts(release.binding).length > 1) return refuse("Owner states conflicting Bindings.");
  if (edition.coverageUnmapped !== true)
    return refuse("Owner contents are mapped; use heldBooks.link.");
  const coverage = await r.many(
    ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
  );
  if (coverage.length) return refuse("Owner Edition has coverage rows; use heldBooks.link.");
  // Position closure in every status; an unnumbered product must be its Line's only Edition.
  const members = await r.many(
    ctx.db.query("editions").withIndex("by_line", (q) => q.eq("editionLineId", line._id)),
  );
  const position = edition.linePosition ?? null;
  if (position === null ? proof.linePosition !== null : !labelsEqual(position, proof.linePosition))
    return refuse("Owner Line position differs from the reviewed product.");
  const occupants = members.filter((one) =>
    position === null ? true : labelsEqual(one.linePosition ?? null, position),
  );
  if (occupants.length !== 1 || occupants[0]!._id !== edition._id)
    return refuse(
      position === null
        ? "An unnumbered product must be its Line's only Edition."
        : "Another Edition occupies this Line position.",
    );
  const siblings = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
  );
  if (siblings.some((one) => one._id !== release._id && one.format === release.format))
    return refuse("Owner Edition has another Release of this format.");
  const aliases = [
    ...(await r.many(
      ctx.db.query("releases").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", release._id)),
    )),
    ...(await r.many(
      ctx.db.query("editions").withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", edition._id)),
    )),
  ];
  if (aliases.length) return refuse("Owner has merged aliases; review them first.");
  const memberships = await r.many(
    ctx.db
      .query("bundleMemberships")
      .withIndex("by_release", (q) => q.eq("releaseId", release._id)),
  );
  if (memberships.length) return refuse("Owner is a Bundle member; review the package.");
  await r.many(
    ctx.db.query("releaseIsbns").withIndex("by_release", (q) => q.eq("releaseId", release._id)),
  );
  // The newest revision of each record pins concurrent catalog edits.
  for (const ref of [
    { type: "release" as const, id: release._id },
    { type: "edition" as const, id: edition._id },
    { type: "editionLine" as const, id: line._id },
  ]) {
    await r.room();
    r.facts.push(
      await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
        .order("desc")
        .first(),
    );
  }
  return { release, edition, line, series, publisher };
}

/** Native records prove an earlier link; a caller's declaration never does. */
async function verifyReceipt(
  ctx: QueryCtx,
  r: Reader,
  observation: Doc<"sourceObservations">,
  releaseId: Id<"releases">,
) {
  const ledgers = await r.many(
    ctx.db
      .query("heldRepairLedger")
      .withIndex("by_observation", (q) => q.eq("observationId", observation._id)),
  );
  const receipts = ledgers.filter(
    (l) => l.operation === UNMAPPED_LINK_OPERATION && l.target?.id === releaseId,
  );
  // A restored and relinked source keeps every earlier receipt. Only the
  // observation's newest ledger row may speak for the current link; an older
  // receipt never stands in for a newer one that no longer verifies.
  const newest = ledgers.reduce<(typeof ledgers)[number] | undefined>(
    (latest, one) => (!latest || one._creationTime > latest._creationTime ? one : latest),
    undefined,
  );
  if (!newest || !receipts.includes(newest))
    return refuse("Link receipt is missing or is not the newest repair of this source.");
  const receipt = newest;
  const holds = await r.many(
    ctx.db
      .query("placementHolds")
      .withIndex("by_observation", (q) => q.eq("observationId", observation._id)),
  );
  const proposal = await r.read(receipt.proposalId);
  const audit = await r.many(
    ctx.db
      .query("revisions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", receipt.proposalId)),
  );
  if (
    holds.length ||
    receipt.after !== valueHash({ observation, hold: null }) ||
    proposal?.state !== "approved" ||
    !audit.some(
      (row) =>
        row.ref.type === "release" &&
        row.ref.id === releaseId &&
        row.changes.some(
          (c) =>
            c.field === "sourceObservation" &&
            sameValue(c.after, {
              observationId: observation._id,
              operation: UNMAPPED_LINK_OPERATION,
            }),
        ),
    )
  )
    return refuse("Link receipt no longer matches the native records.");
  return receipt;
}

/** Preview and apply share this guard; `expected` hashes every fact read. */
export async function unmappedLinkState(ctx: QueryCtx, args: Infer<typeof linkArgs>) {
  const { observationId, releaseId, proof } = args;
  const current = await ctx.db.get(observationId);
  if (!current) return refuse("Missing source observation.");
  if (current.recordRef) {
    if (current.recordRef.type !== "release" || current.recordRef.id !== releaseId)
      return refuse("Source is linked elsewhere.");
    const state = await heldState(ctx, observationId);
    const receipt = await verifyReceipt(ctx, state.r, current, releaseId);
    return {
      already: true as const,
      receipt,
      expected: state.expected,
      state,
      owner: null,
      facts: null,
    };
  }
  const state = await heldState(ctx, observationId);
  const r = state.r;
  const observation = state.observation;
  const hold = state.hold;
  const raw = observation.snapshot as { title?: unknown };
  if (!state.eligible || state.scopeReason || observation.printingIsbn13)
    return refuse(
      state.scopeReason ?? "Source must be held, unlinked, present and outside review.",
    );
  if (!hold || !["isbn", "packaging", "volumeMissing"].includes(hold.kind))
    return refuse("Only isbn, packaging and volumeMissing holds take this link.");
  if (hold.seriesId && hold.seriesId !== proof.seriesId)
    return refuse("Held Series differs from the reviewed Series.");
  if (state.proposal?.state === "draft") return refuse("Source has a draft Proposal.");
  if (raw.title !== proof.sourceTitle)
    return refuse("Reviewed source title differs from the record.");
  if (state.isbn13 !== proof.isbn13 || toIsbn13(proof.isbn13) !== proof.isbn13)
    return refuse("Every stated source ISBN must be the reviewed ISBN-13.");
  // The source's own parent or title resolution, never the ISBN holder, names the work.
  if (!state.source.series || state.source.series._id !== proof.seriesId)
    return refuse("Source parent is absent or names another Series.");
  const scope = await scopeState(ctx, proof.isbn13);
  r.facts.push(scope);
  if (scope.active) return refuse("ISBN has a scope decision.");
  const namespace = await storedClaims(ctx, proof.isbn13, r.room);
  r.facts.push(namespace);
  if (
    !namespace?.complete ||
    namespace.printed ||
    state.claims.printed ||
    namespace.raw.some((c) => c.claim.on !== "release" || c.claim.storedId !== releaseId) ||
    state.claims.owners.size !== 1 ||
    state.claims.owners.get(releaseId)?.kind !== "release"
  )
    return refuse("The Release must be the ISBN's sole owner, without printing or Bundle claims.");
  const owner = await ownerState(ctx, state, releaseId, proof);
  const facts = await sourceProductFacts(ctx, state, owner.series);
  if (facts.format !== owner.release.format) return refuse("Source format differs from the owner.");
  if (facts.binding && owner.release.binding && facts.binding !== owner.release.binding)
    return refuse("Known source Binding contradicts the owner.");
  if (facts.lineName) {
    const equivalence = proof.lineNameEquivalence;
    const equivalent =
      equivalence?.sourceLineName === facts.lineName && equivalence.lineName === owner.line.name;
    if (!sameWorkTitle(facts.lineName, owner.line.name) && !equivalent)
      return refuse("Source Line name differs from the owner's Line.");
  } else if (proof.lineNameEquivalence) return refuse("Source states no Line name to reconcile.");
  const position = owner.edition.linePosition ?? null;
  if (facts.position && (position === null || !labelsEqual(facts.position, position)))
    return refuse("Source Line position differs from the owner's.");
  if (facts.label === null ? proof.sourceLabel !== "none" : proof.sourceLabel !== "linePosition")
    return refuse("Review must say how the source's label reads.");
  // A stated label is the publisher's Line position, never an invented one.
  if (facts.label !== null && (position === null || !labelsEqual(facts.label, position)))
    return refuse("Source label is not the owner's Line position.");
  const evidence = checkEvidence(proof, { ...owner, workNames: declaredWorkNames(owner.series) });
  const sourceNames = sourcePublisherNames(observation.sourceKey, state.effective.snapshot);
  await publisherAgrees(ctx, r, sourceNames, evidence, owner);
  // Where the evidence alone supplies the Line, its position or the
  // publisher (a bare label read as a Line position, a source with no Line
  // name or position, kodansha.us naming no publisher), one page must be the
  // publisher's or its trade distributor's own SKU page.
  if (
    (proof.sourceLabel === "linePosition" ||
      !facts.lineName ||
      (position !== null && !facts.position) ||
      !sourceNames.length) &&
    !evidence.publisherSide
  )
    return refuse(
      "Evidence alone states this product's Line or publisher; supply the publisher's or its distributor's own SKU page.",
    );
  const urls = evidence.urls;
  const expected = valueHash({
    operation: UNMAPPED_LINK_OPERATION,
    observationId,
    releaseId,
    proof,
    held: state.expected,
    facts: r.facts,
  });
  if (utf8Bytes(expected) > MAX_GUARD_BYTES) return refuse("Guard exceeds 256 KiB.");
  return { already: false as const, receipt: null, expected, state, owner, facts, urls };
}

/** One nested transaction: link, revision, audit and ledger, or nothing. */
export async function applyUnmappedLink(
  ctx: MutationCtx,
  args: Infer<typeof executeArgs>,
): Promise<UnmappedLinkResult> {
  const result = await unmappedLinkState(ctx, args);
  if (result.expected !== args.expected) return refuse("Link state changed; preview again.");
  const actor = await resolveActor(ctx, args.actor);
  if (result.already)
    return { status: "alreadyApplied", releaseId: args.releaseId, ledgerId: result.receipt._id };
  const { state, owner, facts, urls } = result;
  const before = valueHash({ observation: state.observation, hold: state.hold });
  const note = valueHash({
    operation: UNMAPPED_LINK_OPERATION,
    proof: args.proof,
    sourceFacts: facts,
    contents: "unmapped; no coverage asserted",
  });
  if (utf8Bytes(note) > 64 * 1024) return refuse("Audit note exceeds 64 KiB.");
  const audit = createAudit(ctx, actor, args.proof.reason.trim(), [
    { kind: "observation", observationId: args.observationId },
    ...urls.map((url) => ({ kind: "url" as const, url })),
    { kind: "note", text: note },
  ]);
  await linkObservation(ctx, args.observationId, { type: "release", id: args.releaseId });
  const changes = [
    {
      field: "sourceObservation",
      after: { observationId: args.observationId, operation: UNMAPPED_LINK_OPERATION },
    },
  ];
  audit.op({ kind: "update", ref: { type: "release", id: args.releaseId }, changes });
  await audit.revise({ type: "release", id: args.releaseId }, changes);
  await audit.finish();
  const proposalId = (await audit.meta()).proposalId;
  // Postconditions: only the link and its hold changed; the product is untouched.
  const observation = await ctx.db.get(args.observationId);
  const holds = await ctx.db
    .query("placementHolds")
    .withIndex("by_observation", (q) => q.eq("observationId", args.observationId))
    .take(2);
  const coverage = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", owner.edition._id))
    .take(1);
  const expectedObservation = {
    ...state.observation,
    recordRef: { type: "release", id: args.releaseId },
    conflicts: state.observation.conflicts?.filter((c) => c.field !== "placement"),
  };
  if (
    !sameValue(observation, expectedObservation) ||
    holds.length ||
    coverage.length ||
    !sameValue(await ctx.db.get(owner.release._id), owner.release) ||
    !sameValue(await ctx.db.get(owner.edition._id), owner.edition) ||
    !sameValue(await ctx.db.get(owner.line._id), owner.line)
  )
    throw new ConvexError("Link postconditions failed; whole operation rolled back.");
  const ledgerId = await ctx.db.insert("heldRepairLedger", {
    observationId: args.observationId,
    operation: UNMAPPED_LINK_OPERATION,
    proposalId,
    before,
    after: valueHash({ observation, hold: null }),
    target: { type: "release", id: args.releaseId },
  });
  return { status: "linked", releaseId: args.releaseId, proposalId, ledgerId };
}
