import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { AnnReleaseSnapshot } from "../ann";
import { digitalSiblingProofs } from "./digitalSiblingProofs";
import {
  reader,
  heldState,
  refuse,
  MAX_GUARD_BYTES,
  publisherMatch,
  guardedResolverContext,
  contentMatch,
  volumesForLabels,
} from "./heldBooks";
import { fullDateValidator } from "./dates";
import { utf8Bytes } from "./sourceFormat";
import { sameValue, valueHash } from "./values";
import { fileFormatFact, takesFormatSlot } from "./bookFacts";
import { parseBookTitle, outOfScopeReason } from "./bookTitle";
import { sameWorkTitle, labelsEqual } from "./matching";
import { isbn13To10 } from "./isbn";
import { createAudit, resolveActor, refreshReleaseDenorms } from "./repair/audit";
import { declaredWorkNames } from "./declaredWork";
import { releaseUrl, mangaUrl } from "./ann";
import { internal } from "../_generated/api";
import { findPublisherByName } from "./pipeline";
import { publisherNameKey } from "./publishers";
import type { evidence } from "../schema";

const capture = v.object({
  url: v.string(),
  retrievedAt: v.string(),
  bodySha256: v.string(),
  bodyBytes: v.number(),
  byteStart: v.number(),
  byteEndExclusive: v.number(),
  sectionSha256: v.string(),
  excerpt: v.string(),
  artifact: v.string(),
  httpStatus: v.literal(200),
});
export const digitalSiblingReview = v.object({
  isbn13: v.string(),
  seriesId: v.id("series"),
  publisherId: v.id("publishers"),
  volumeIds: v.array(v.id("volumes")),
  sourceTitle: v.string(),
  productTitle: v.string(),
  productVolumeLabel: v.string(),
  digitalFileFormat: v.literal("pdf"),
  occupiedIsbn13: v.string(),
  occupiedDigitalFileFormat: v.literal("epub"),
  publicationDate: fullDateValidator,
  publisherProof: capture,
  occupiedProof: capture,
  evidenceUrls: v.array(v.string()),
});
export const digitalSiblingArgs = {
  observationId: v.id("sourceObservations"),
  editionId: v.id("editions"),
  occupiedReleaseId: v.id("releases"),
  reviewed: digitalSiblingReview,
};
const digitalSiblingInput = v.object(digitalSiblingArgs);
export type DigitalSiblingArgs = Infer<typeof digitalSiblingInput>;

export async function digest(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse("Invalid literal product JSON.");
  return value as Record<string, unknown>;
}
function literal(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    return refuse("Invalid literal product JSON.");
  }
}
/** Immutable reviewed captures bind whole-body provenance to the supplied literal sections.
 * New ISBN pairs require independent evidence review and new pins, never caller assertions. */
export async function validateDigitalSiblingProof(reviewed: Infer<typeof digitalSiblingReview>) {
  if (utf8Bytes(valueHash(reviewed)) > 64 * 1024) return refuse("Product proof exceeds 64 KiB.");
  const {
    seriesId: _series,
    publisherId: _publisher,
    volumeIds: _volumes,
    ...productProof
  } = reviewed;
  const pin = Object.entries(digitalSiblingProofs).find(([isbn]) => isbn === reviewed.isbn13)?.[1];
  if (!pin || !sameValue(productProof, pin))
    return refuse("Product proof differs from independently reviewed capture.");
  for (const p of [reviewed.publisherProof, reviewed.occupiedProof]) {
    if (
      !Number.isFinite(Date.parse(p.retrievedAt)) ||
      !Number.isSafeInteger(p.bodyBytes) ||
      !Number.isSafeInteger(p.byteStart) ||
      !Number.isSafeInteger(p.byteEndExclusive) ||
      p.byteStart < 0 ||
      p.byteEndExclusive > p.bodyBytes ||
      p.byteEndExclusive - p.byteStart !== utf8Bytes(p.excerpt) ||
      (await digest(p.excerpt)) !== p.sectionSha256
    )
      return refuse("Literal section SHA256, UTF8 byte range or capture timestamp disagrees.");
    if (
      p.byteStart === 0 &&
      p.byteEndExclusive === p.bodyBytes &&
      (await digest(p.excerpt)) !== p.bodySha256
    )
      return refuse("Whole body SHA256 disagrees.");
  }
  const pdf = literal(reviewed.publisherProof.excerpt);
  const epub = object(literal(reviewed.occupiedProof.excerpt)[reviewed.occupiedIsbn13]);
  const variants = pdf.variants;
  const tags = pdf.tags;
  if (
    !Array.isArray(variants) ||
    variants.length !== 1 ||
    object(variants[0]).sku !== reviewed.isbn13 ||
    object(variants[0]).barcode !== reviewed.isbn13 ||
    object(variants[0]).requires_shipping !== false ||
    pdf.type !== "eBook" ||
    !Array.isArray(tags) ||
    !tags.includes("format-detail:PDF") ||
    !tags.includes("imprint:TOKYOPOP") ||
    !tags.includes("publisher:TOKYOPOP") ||
    !tags.includes("publication-date:2020-08-06") ||
    String(epub.isbn) !== reviewed.occupiedIsbn13 ||
    epub.isbnStr !== reviewed.occupiedIsbn13 ||
    epub.audioLength !== null ||
    epub.boxComponentCt !== 0 ||
    !Array.isArray(epub.categories) ||
    !epub.categories.some((category) => object(category).catDesc === "Manga ") ||
    object(epub.format).subname !== "EPUB FXL Manga RTL" ||
    object(epub.imprint).name !== "TOKYOPOP" ||
    pdf.title !== reviewed.productTitle ||
    epub.title !== pdf.title ||
    pdf.vendor !== epub.author ||
    pdf.description !== epub.aboutTheBook
  )
    return refuse(
      "Selected product ISBN, work, contributor, description, publisher or file format disagrees.",
    );
  const title = parseBookTitle(reviewed.productTitle);
  if (
    title.isNovel ||
    title.isBox ||
    title.packaging ||
    outOfScopeReason(reviewed.productTitle) ||
    !sameWorkTitle(title.seriesTitle, reviewed.sourceTitle) ||
    !labelsEqual(title.volumeLabel, reviewed.productVolumeLabel)
  )
    return refuse("Product is not the independently evidenced ordinary complete manga Volume.");
}

/** Complete bounded closure, including reserved siblings on other Editions of this Volume. */
export async function digitalSiblingState(
  ctx: QueryCtx,
  args: DigitalSiblingArgs,
  createdReleaseId?: Id<"releases">,
) {
  await validateDigitalSiblingProof(args.reviewed);
  const state = await heldState(ctx, args.observationId, {
    type: "release",
    id: args.occupiedReleaseId,
  });
  const { r } = state;
  const target = state.contents ?? refuse("Missing occupied Release.");
  const review = args.reviewed;
  const line = state.observation.snapshot as AnnReleaseSnapshot;
  const sourceFields = object(state.observation.snapshot);
  // ANN's parent schema uses id, while a release line uses annId. The URL
  // comes from the immutable reviewed pair, not a caller-supplied source key.
  const sourceUrl = review.evidenceUrls.find((url) =>
    url.startsWith("https://www.animenewsnetwork.com/encyclopedia/releases.php?id="),
  );
  const parent = state.source.parent ?? refuse("Missing ANN source parent.");
  const parentFields = object(parent.snapshot);
  const parentTitle = parentFields.title;
  if (
    sourceFields.kind !== "annRelease" ||
    typeof line.annId !== "string" ||
    !/^[1-9][0-9]*$/.test(line.annId) ||
    state.observation.sourceRecordId !== `release:${line.annId}` ||
    line.url !== releaseUrl(line.annId) ||
    line.url !== sourceUrl ||
    line.mangaId !== "15868" ||
    parent.sourceKey !== "ann" ||
    parent.sourceRecordId !== `manga:${line.mangaId}` ||
    parentFields.kind !== "annManga" ||
    parentFields.id !== line.mangaId ||
    (parentFields.annId !== undefined && parentFields.annId !== parentFields.id) ||
    parentFields.url !== mangaUrl(line.mangaId) ||
    typeof parentTitle !== "string" ||
    !state.source.series ||
    !declaredWorkNames(state.source.series).some((name) => sameWorkTitle(name, parentTitle))
  )
    return refuse("ANN release or parent kind, key, own ID, URL or work title disagrees.");
  if (
    (sourceFields.digitalFileFormat !== undefined && sourceFields.digitalFileFormat !== "pdf") ||
    (line.page &&
      object(line.page).digitalFileFormat !== undefined &&
      object(line.page).digitalFileFormat !== "pdf")
  )
    return refuse("Source file format contradicts independently evidenced PDF.");
  if (
    state.observation.sourceKey !== "ann" ||
    state.isbn13 !== review.isbn13 ||
    state.scopeReason ||
    state.observation.withdrawn ||
    state.proposal?.state === "inReview" ||
    (!createdReleaseId && (!state.eligible || state.hold?.seriesId !== review.seriesId)) ||
    (createdReleaseId &&
      (state.hold ||
        state.observation.recordRef?.type !== "release" ||
        state.observation.recordRef.id !== createdReleaseId)) ||
    state.source.series?._id !== review.seriesId ||
    line.title !== review.sourceTitle ||
    line.page?.status !== "ok" ||
    line.page.title !== review.sourceTitle ||
    line.page.mangaId !== line.mangaId ||
    line.page.isbn13 !== review.isbn13 ||
    line.page.volume !== `eBook ${review.productVolumeLabel} / 3` ||
    line.format !== "digital" ||
    !labelsEqual(line.label ?? null, review.productVolumeLabel) ||
    line.multi ||
    line.coverRange ||
    line.coverageGapped ||
    line.editionLineHint
  )
    return refuse("Source, held work, successful ordinary eBook page or source parent disagrees.");
  if (
    target.release._id !== args.occupiedReleaseId ||
    target.edition._id !== args.editionId ||
    target.release.format !== "digital" ||
    target.release.digitalFileFormat !== "epub" ||
    target.release.isbn13 !== review.occupiedIsbn13 ||
    target.release.language !== "en" ||
    target.edition.editionLineId ||
    target.edition.linePosition ||
    target.line ||
    target.publisher._id !== review.publisherId ||
    target.series.length !== 1 ||
    target.series[0]!._id !== review.seriesId ||
    !sameWorkTitle(target.series[0]!.title, review.sourceTitle) ||
    target.contents.length !== 1 ||
    review.volumeIds.length !== 1 ||
    target.contents[0]!.volume._id !== review.volumeIds[0] ||
    !labelsEqual(target.contents[0]!.volume.label ?? null, review.productVolumeLabel)
  )
    return refuse(
      "Active existing Edition, English EPUB, publisher or complete ordinary Volume disagrees.",
    );
  const coverage = await r.many(
    ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", args.editionId)),
  );
  if (
    coverage.length !== 1 ||
    coverage[0]!.volumeId !== review.volumeIds[0] ||
    coverage[0]!.extent !== "complete" ||
    coverage[0]!.order !== 1 ||
    !sameValue(target.release.seriesIds, [review.seriesId])
  )
    return refuse("Existing target must directly cover exactly one active canonical Volume.");
  // Native content checks retain scope, chapter, format, packaging and numeric identity checks.
  await publisherMatch(guardedResolverContext(ctx, r), state.observation, review.publisherId);
  if (line.page?.status !== "ok" || line.page.distributor !== "Tokyopop")
    return refuse("Source publisher differs from the reviewed ANN distributor.");
  // Resolve the captured product imprint as well as ANN's display name. A
  // slug alone cannot prove publisher identity, and rename redirects are valid.
  if (line.page.distributorId !== undefined && line.page.distributorId !== "11")
    return refuse("ANN distributor ID contradicts reviewed company 11.");
  const productPublisher = await findPublisherByName(guardedResolverContext(ctx, r), "TOKYOPOP");
  if (!productPublisher) return refuse("Reviewed product publisher cannot be resolved.");
  const canonicalPublisher = await r.active(productPublisher._id);
  if (
    canonicalPublisher._id !== review.publisherId ||
    canonicalPublisher._id !== target.publisher._id ||
    publisherNameKey(canonicalPublisher.name) !== publisherNameKey("TOKYOPOP")
  )
    return refuse("Resolved product and canonical publisher identity disagree.");
  const canonicalResolvedPublisherId = canonicalPublisher._id;
  await contentMatch(ctx, state, target);
  const candidates = await volumesForLabels(ctx, review.seriesId, [review.productVolumeLabel], r);
  if (candidates.length !== 1 || candidates[0]!._id !== review.volumeIds[0])
    return refuse("Canonical Volume label is ambiguous or reserved.");
  if (createdReleaseId) {
    if (state.claims.owners.size !== 1 || !state.claims.owners.has(createdReleaseId))
      return refuse("Audited PDF is no longer sole ISBN owner.");
  } else if (state.claims.owners.size)
    return refuse("Held ISBN already has a primary, alternate or bundle owner.");
  const rows = await r.many(
    ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", review.volumeIds[0]!)),
  );
  const editionIds = new Set(rows.map((row) => row.editionId));
  for (const id of editionIds) {
    const edition = await r.read(id);
    if (!edition) return refuse("Slot Edition vanished.");
    const editionPublisher = await r.active(edition.publisherId);
    await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", id)),
    );
    const siblings = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", id)),
    );
    for (const sibling of siblings) {
      const siblingPublisher = await r.active(sibling.publisherId);
      if (siblingPublisher._id !== editionPublisher._id)
        return refuse("Slot Edition and Release publisher identities disagree.");
      if (
        id === args.editionId &&
        (sibling.publisherId !== review.publisherId ||
          !sameValue(sibling.seriesIds, [review.seriesId]))
      )
        return refuse(
          "Existing sibling denormalizations disagree; repair separately before creation.",
        );
      await r.many(
        ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", sibling._id)),
      );
      if (sibling._id === createdReleaseId) {
        if (
          sibling.editionId !== args.editionId ||
          sibling.status !== "active" ||
          sibling.locked ||
          sibling.format !== "digital" ||
          sibling.digitalFileFormat !== "pdf" ||
          sibling.isbn13 !== review.isbn13 ||
          sibling.language !== "en"
        )
          return refuse("Created PDF drifted.");
        continue;
      }
      if (editionPublisher._id !== canonicalResolvedPublisherId || sibling.format !== "digital")
        continue;
      if (
        sibling._id !== args.occupiedReleaseId ||
        takesFormatSlot(sibling, "digital", "pdf") ||
        sibling.status !== "active" ||
        sibling.locked ||
        fileFormatFact(sibling.digitalFileFormat) !== "epub"
      )
        return refuse("Unknown, conflicting or reserved digital sibling blocks the PDF slot.");
    }
  }
  let publisher = target.publisher;
  const seen = new Set<string>();
  while (publisher.parentPublisherId) {
    if (seen.has(publisher._id) || seen.size >= 8) return refuse("Publisher ancestry incomplete.");
    seen.add(publisher._id);
    const parent = await r.active(publisher.parentPublisherId);
    if (parent._id !== publisher.parentPublisherId) return refuse("Publisher ancestry merged.");
    publisher = parent;
  }
  for (const ref of [
    { type: "edition" as const, id: args.editionId },
    { type: "volume" as const, id: review.volumeIds[0]! },
    { type: "series" as const, id: review.seriesId },
    { type: "publisher" as const, id: review.publisherId },
  ])
    await r.many(
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id)),
    );
  await r.many(
    ctx.db
      .query("observationSnapshots")
      .withIndex("by_observation", (q) => q.eq("observationId", args.observationId)),
  );
  if (state.proposal)
    await r.many(
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", state.proposal!._id)),
    );
  const proposalIds = new Set<Id<"proposals">>();
  for (const fact of r.facts) {
    if (!Array.isArray(fact)) continue;
    for (const row of fact) {
      if (row && typeof row === "object" && "proposalId" in row && "seq" in row) {
        const revision = row as { proposalId: Id<"proposals"> };
        proposalIds.add(revision.proposalId);
      }
    }
  }
  if (proposalIds.size > 80)
    return refuse("Revision proposals exceed complete bounded audit closure.");
  for (const id of proposalIds) {
    await r.read(id);
    await r.many(
      ctx.db.query("proposalVersions").withIndex("by_proposal", (q) => q.eq("proposalId", id)),
    );
  }
  let linkAudit = null;
  if (createdReleaseId) {
    // Exclude the enclosing creation ledger to avoid a recursive after snapshot.
    // Capture every link candidate, so deletion, replacement and ambiguity refuse.
    const links = await r.many(
      ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", args.observationId))
        .filter((q) => q.eq(q.field("operation"), "link")),
    );
    const matches = links.filter(
      (ledger) => ledger.target?.type === "release" && ledger.target.id === createdReleaseId,
    );
    const link =
      matches.length === 1 ? matches[0]! : refuse("Native link audit missing or ambiguous.");
    const linkBefore = object(literal(link.before));
    const beforeObservation = object(linkBefore.observation);
    const beforeHold = object(linkBefore.hold);
    if (
      beforeObservation._id !== args.observationId ||
      beforeObservation.recordRef !== undefined ||
      !sameValue(beforeObservation.snapshot, state.observation.snapshot) ||
      beforeObservation.sourceKey !== state.observation.sourceKey ||
      beforeObservation.sourceRecordId !== state.observation.sourceRecordId ||
      beforeHold.observationId !== args.observationId ||
      beforeHold.seriesId !== review.seriesId ||
      link.after !== valueHash({ observation: state.observation, hold: state.hold })
    )
      return refuse("Native link audit source transition disagrees.");
    const proposal = await r.read(link.proposalId);
    const versions = await r.many(
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", link.proposalId)),
    );
    if (
      proposal?.state !== "approved" ||
      versions.length !== 1 ||
      proposal.currentVersionNo !== versions[0]!.versionNo
    )
      return refuse("Native link approved proposal/version missing or ambiguous.");
    linkAudit = { ledgerId: link._id, proposalId: link.proposalId, before: link.before };
  }
  const snapshot = valueHash({ args, facts: r.facts });
  if (utf8Bytes(snapshot) > MAX_GUARD_BYTES / 2)
    return refuse("Digital sibling state exceeds ledger bounds.");
  return { state, target, snapshot, linkAudit, expected: await digest(snapshot) };
}

function createdStructure(args: DigitalSiblingArgs) {
  return {
    editionId: args.editionId,
    volumeIds: args.reviewed.volumeIds,
    sharedEdition: true,
    newEdition: false,
    newVolumeIds: [],
    newCoverageIds: [],
    newLine: false,
  };
}

/** The immutable creation version anchors the ledger ID and all metadata.
 * Its after snapshot includes that version, so excluding after avoids recursion. */
async function creationAnchor(ledger: Doc<"heldRepairLedger">) {
  const { after: _after, ...envelope } = ledger;
  return {
    kind: "note" as const,
    text: `digitalSiblingCreationLedger:${await digest(valueHash(envelope))}`,
  };
}

export type SiblingResult = {
  status: "applied" | "alreadyApplied" | "refused";
  reason?: string;
  releaseId?: Id<"releases">;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
};
/** Single transaction: native creation audit, exact-owner guard, native link and ledger.
 * The optional failure hook belongs to helper tests and is never a function argument. */
export async function createDigitalSibling(
  ctx: MutationCtx,
  args: DigitalSiblingArgs & { actor: string; expected: string },
  afterCreate?: () => void | Promise<void>,
): Promise<SiblingResult> {
  if (!/^[a-f0-9]{64}$/.test(args.expected))
    return refuse("Digital sibling expected must be a fresh SHA256 state digest.");
  if (args.actor !== "ari") return refuse("Digital sibling repair actor must be ari.");
  const actor = await resolveActor(ctx, args.actor);
  const base: DigitalSiblingArgs = {
    observationId: args.observationId,
    editionId: args.editionId,
    occupiedReleaseId: args.occupiedReleaseId,
    reviewed: args.reviewed,
  };
  const ledgers = await heldLedger(ctx, args.observationId);
  const existing = ledgers.filter((l) => l.operation === "createDigitalSibling");
  if (existing.length) {
    const ledger =
      existing.length === 1 ? existing[0]! : refuse("Ambiguous digital sibling ledger.");
    if (
      !sameValue(ledger.createdStructure, createdStructure(base)) ||
      !ledger.createdReleaseId ||
      !ledger.target ||
      ledger.target.type !== "release" ||
      ledger.target.id !== ledger.createdReleaseId
    )
      return refuse("Incomplete audited digital sibling retry.");
    const before = literal(ledger.before);
    if (!sameValue(object(before).args, base) || (await digest(ledger.before)) !== args.expected)
      return refuse("Retry differs from original audited request.");
    const after = await digitalSiblingState(ctx, base, ledger.createdReleaseId);
    if (after.snapshot !== ledger.after)
      return refuse("Audited digital sibling state drifted; inspect before retry.");
    const proposal = await after.state.r.read(ledger.proposalId);
    const versions = await after.state.r.many(
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", ledger.proposalId)),
    );
    const anchor = await creationAnchor(ledger);
    if (
      proposal?.state !== "approved" ||
      versions.length !== 1 ||
      proposal.currentVersionNo !== versions[0]!.versionNo ||
      !versions[0]!.evidence.some((row) => sameValue(row, anchor)) ||
      !versions[0]!.ops.some((op) => op.kind === "create" && op.tempId === ledger.createdReleaseId)
    )
      return refuse("Creation audit missing.");
    return {
      status: "alreadyApplied",
      releaseId: ledger.createdReleaseId,
      proposalId: ledger.proposalId,
      ledgerId: ledger._id,
    };
  }
  const before = await digitalSiblingState(ctx, base);
  if (before.expected !== args.expected)
    return refuse(
      "Digital sibling source, proof, ownership or canonical state changed; preview again.",
    );
  await before.state.r.room();
  const evidenceRows: Infer<typeof evidence>[] = [
    { kind: "observation", observationId: args.observationId },
    ...args.reviewed.evidenceUrls.map((url) => ({ kind: "url" as const, url })),
    { kind: "note", text: await digest(valueHash(args.reviewed)) },
  ];
  const audit = createAudit(
    ctx,
    actor,
    "Create independently evidenced own-ISBN PDF on existing ordinary Edition and link source.",
    evidenceRows,
  );
  const date = args.reviewed.publicationDate;
  const fields = {
    status: "active" as const,
    editionId: args.editionId,
    format: "digital" as const,
    digitalFileFormat: "pdf" as const,
    language: "en",
    isbn13: args.reviewed.isbn13,
    isbn10: isbn13To10(args.reviewed.isbn13),
    publisherId: before.target.publisher._id,
    seriesIds: [args.reviewed.seriesId],
    pubDate: { ...date, sort: date.year * 10000 + date.month * 100 + date.day },
  };
  const releaseId = await ctx.db.insert("releases", fields);
  audit.op({ kind: "create", table: "releases", tempId: releaseId, fields });
  await audit.revise(
    { type: "release", id: releaseId },
    Object.entries(fields).map(([field, after]) => ({ field, after })),
  );
  await refreshReleaseDenorms(ctx, args.editionId);
  await afterCreate?.();
  const link: { expected: string | null; refusal: string | null } = await ctx.runQuery(
    internal.heldBooks.previewInternal,
    { observationId: args.observationId, target: { type: "release", id: releaseId } },
  );
  if (link.refusal || !link.expected)
    return refuse(link.refusal ?? "New Release cannot pass native link guard.");
  const linked: SiblingResult = await ctx.runMutation(internal.heldBooks.applyInternal, {
    observationId: args.observationId,
    target: { type: "release", id: releaseId },
    operation: "link",
    expected: link.expected,
    actor: args.actor,
    reason: "Link independently evidenced own-ISBN PDF, preserving EPUB and existing coverage.",
    evidenceUrls: args.reviewed.evidenceUrls,
  });
  if (linked.status !== "applied" || !linked.ledgerId || !linked.proposalId)
    return refuse("Native linking failed; creation rolled back.");
  // Insert the envelope first so the immutable creation version can name its
  // original identity. The placeholder never commits if finishing/linking fails.
  const proposalId = (await audit.meta()).proposalId;
  const ledgerId = await ctx.db.insert("heldRepairLedger", {
    observationId: args.observationId,
    operation: "createDigitalSibling",
    proposalId,
    before: before.snapshot,
    after: "",
    target: { type: "release", id: releaseId },
    createdReleaseId: releaseId,
    createdStructure: createdStructure(base),
  });
  const ledger = await before.state.r.read(ledgerId);
  if (!ledger) return refuse("Creation ledger vanished before completion.");
  evidenceRows.push(await creationAnchor(ledger));
  await audit.finish();
  const after = await digitalSiblingState(ctx, base, releaseId);
  if (
    after.linkAudit?.ledgerId !== linked.ledgerId ||
    after.linkAudit.proposalId !== linked.proposalId ||
    after.linkAudit.before !==
      valueHash({ observation: before.state.observation, hold: before.state.hold })
  )
    return refuse("Native link audit does not match the atomic source transition.");
  await ctx.db.patch(ledgerId, { after: after.snapshot });
  return { status: "applied", releaseId, proposalId, ledgerId };
}
async function heldLedger(ctx: QueryCtx, observationId: Id<"sourceObservations">) {
  // Reuse the same complete bounded reader, including its transaction reserve.
  return reader(ctx).many(
    ctx.db
      .query("heldRepairLedger")
      .withIndex("by_observation", (q) => q.eq("observationId", observationId)),
  );
}
