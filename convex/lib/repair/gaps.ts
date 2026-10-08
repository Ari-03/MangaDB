// Reviewed repairs for publishers, proposal evidence and store-exclusive covers.
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { referenceAudit } from "../heldRepair";
import { applyHide } from "../sensitiveOps";
import { reader, releaseContents } from "../heldBooks";
import { holdOf, linkObservation } from "../observations";
import { canonicalPublisherFor, publisherNameKey } from "../publishers";
import { claimResolver, isbnClaims, observedIsbn13, primaryIsbnsOf } from "../releaseIsbns";
import { isbnScope } from "../scope";
import { projectSourceFormat } from "../sourceFormat";
import { sameValue, valueHash } from "../values";
import { type Audit, REPAIR_KEY_FIELD, skip, updateRecord } from "./audit";
import type { EntryOf } from "./entries";

type GapEntry = EntryOf<
  "createPublisher" | "amendProposalEvidence" | "releaseVariant" | "otherPrinting"
>;

/** A URL is evidence only when it names an HTTP page, not an empty or local path. */
function checkUrls(urls: string[]) {
  if (!urls.length || urls.length > 20) skip("Supply 1 to 20 evidence URLs.");
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return skip("Evidence URL is invalid.");
    }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
      skip("Evidence must name an HTTP page without credentials.");
  }
}

/** Physical cover and printing decisions never override a reviewed digital source Format. */
function requirePhysicalSource(observation: Doc<"sourceObservations">) {
  const projection = projectSourceFormat(observation);
  if (projection.status === "stale") return skip(projection.reason);
  const snapshot: unknown = projection.snapshot;
  if (
    projection.status === "corrected" ||
    (typeof snapshot === "object" &&
      snapshot !== null &&
      "format" in snapshot &&
      snapshot.format === "digital")
  )
    skip("A digital source cannot become a physical printing or cover variant.");
}

/** Hash all reviewed source, target and ISBN facts before a cover decision. */
export async function variantState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  releaseId: Id<"releases">,
) {
  const r = reader(ctx);
  const observation = (await r.read(observationId)) ?? skip("Observation missing.");
  const hold = await holdOf(ctx, observationId);
  const target = await releaseContents(ctx, releaseId, r, true);
  if (target.release._id !== releaseId)
    skip("Review the active Release rather than its merged alias.");
  const isbn13 = observedIsbn13(observation.snapshot) ?? skip("Observation has no valid ISBN.");
  const scope = await isbnScope(ctx, isbn13);
  if (scope) skip(scope);
  const rows = await r.many(
    ctx.db.query("releaseIsbns").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)),
  );
  const variants = await r.many(
    ctx.db.query("releaseVariants").withIndex("by_release", (q) => q.eq("releaseId", releaseId)),
  );
  const claims = await isbnClaims(ctx, isbn13, {
    resolver: claimResolver(ctx, { room: r.room }),
    room: r.room,
  });
  if (!claims?.complete || claims.unresolved.length) return skip("ISBN ownership is incomplete.");
  const owners = [...claims.owners.values()].map((owner) => ({ kind: owner.kind, doc: owner.doc }));
  return {
    observation,
    hold,
    target,
    isbn13,
    rows,
    variants,
    owners,
    expected: valueHash({ observation, hold, facts: r.facts, owners }),
  };
}

/** Dispatch with a keyed immutable receipt; retries cannot change the reviewed payload. */
export async function applyGapEntry(ctx: MutationCtx, audit: Audit, entry: GapEntry) {
  if (!entry.key.trim() || !entry.reason.trim()) skip("Repair key and reason are required.");
  const receipt = await ctx.db
    .query("repairToolReceipts")
    .withIndex("by_key", (q) => q.eq("key", entry.key))
    .unique();
  const entryHash = valueHash(entry);
  if (receipt) {
    if (receipt.entryHash !== entryHash) skip("Repair key was already used for another payload.");
    return { status: "alreadyApplied" as const };
  }
  switch (entry.kind) {
    case "otherPrinting":
      await recordOtherPrinting(ctx, audit, entry);
      break;
    case "createPublisher":
      await createPublisher(ctx, audit, entry);
      break;
    case "amendProposalEvidence":
      await amendEvidence(ctx, audit, entry);
      break;
    case "releaseVariant":
      await recordVariant(ctx, audit, entry);
      break;
  }
  await ctx.db.insert("repairToolReceipts", {
    key: entry.key,
    entryHash,
    proposalId: (await audit.meta()).proposalId,
  });
  return { status: "applied" as const };
}

/** Create a publisher only after checking names, aliases, slugs and one-level ancestry. */
async function createPublisher(ctx: MutationCtx, audit: Audit, entry: EntryOf<"createPublisher">) {
  checkUrls(entry.sources);
  const name = entry.name.trim();
  const key = publisherNameKey(name);
  if (!key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug))
    skip("Publisher name or slug is invalid.");
  const canonical = canonicalPublisherFor(name);
  if (canonical && (canonical.slug !== entry.slug || canonical.name !== name))
    skip("Use the canonical publisher name and slug, rather than a source alias.");
  for await (const existing of ctx.db.query("publishers")) {
    if (
      publisherNameKey(existing.name) === key ||
      existing.slug === entry.slug ||
      (canonical &&
        (existing.slug === canonical.slug ||
          canonicalPublisherFor(existing.name)?.slug === canonical.slug))
    )
      skip("Publisher already exists by name, slug or alias, including hidden rows.");
  }
  const redirect = await ctx.db
    .query("publisherSlugRedirects")
    .withIndex("by_fromSlug", (q) => q.eq("fromSlug", entry.slug))
    .first();
  if (redirect) skip("Publisher slug is an existing redirect.");
  if (entry.parentPublisherId) {
    const parent = await ctx.db.get(entry.parentPublisherId);
    if (!parent || parent.status !== "active" || parent.locked || parent.parentPublisherId)
      skip("Parent must be an active unlocked company, not an imprint.");
  }
  await audit.meta();
  const fields = {
    status: "active" as const,
    name,
    slug: entry.slug,
    bootstrapUnreviewed: true,
    ...(entry.parentPublisherId ? { parentPublisherId: entry.parentPublisherId } : {}),
  };
  const id = await ctx.db.insert("publishers", fields);
  audit.op({ kind: "create", table: "publishers", tempId: id, fields });
  await audit.revise({ type: "publisher", id }, [
    ...Object.entries(fields).map(([field, after]) => ({ field, after })),
    { field: REPAIR_KEY_FIELD, after: entry.key },
  ]);
}

/** Correct URLs by appending a new version and an actor-attributed note; old versions survive. */
async function amendEvidence(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"amendProposalEvidence">,
) {
  checkUrls(entry.replacements.map((row) => row.after));
  const proposal = await ctx.db.get(entry.proposalId);
  if (
    !proposal ||
    proposal.state !== "approved" ||
    proposal.currentVersionNo !== entry.expectedVersionNo
  )
    return skip("Only an approved Proposal at the reviewed version can be corrected.");
  const version = await ctx.db
    .query("proposalVersions")
    .withIndex("by_proposal", (q) =>
      q.eq("proposalId", proposal._id).eq("versionNo", entry.expectedVersionNo),
    )
    .unique();
  if (!version) return skip("Proposal version missing.");
  const urls = new Set(version.evidence.flatMap((row) => (row.kind === "url" ? [row.url] : [])));
  if (
    new Set(entry.replacements.map((row) => row.before)).size !== entry.replacements.length ||
    entry.replacements.some((row) => row.before === row.after || !urls.has(row.before))
  )
    skip("Replacement must name distinct existing evidence URLs and change them.");
  const replacements = new Map(entry.replacements.map((row) => [row.before, row.after]));
  const evidence = version.evidence.map((row) =>
    row.kind === "url" && replacements.has(row.url)
      ? { ...row, url: replacements.get(row.url)! }
      : row,
  );
  const meta = await audit.meta();
  const versionNo = entry.expectedVersionNo + 1;
  await ctx.db.insert("proposalVersions", {
    proposalId: proposal._id,
    versionNo,
    ops: version.ops,
    evidence,
    changeComment: `Evidence correction: ${entry.reason}`,
    ...(version.warningsAcknowledged ? { warningsAcknowledged: version.warningsAcknowledged } : {}),
  });
  await ctx.db.patch(proposal._id, { currentVersionNo: versionNo });
  await ctx.db.insert("proposalNotes", {
    proposalId: proposal._id,
    versionNo,
    authorId: meta.approvedBy ?? skip("Repair actor missing."),
    kind: "comment",
    text: `Evidence correction ${entry.key}, audit Proposal ${meta.proposalId}: ${entry.reason}\n${entry.replacements.map((row) => `${row.before} -> ${row.after}`).join("\n")}`,
  });
  audit.note(
    `Proposal ${proposal._id}: appended evidence version ${versionNo}; approved operations unchanged.`,
  );
}

/** A reviewed store cover keeps the Release identity and suppresses source fact reconciliation. */
async function recordVariant(ctx: MutationCtx, audit: Audit, entry: EntryOf<"releaseVariant">) {
  checkUrls(entry.sources);
  if (!entry.name.trim()) skip("Variant name is required.");
  const state = await variantState(ctx, entry.observationId, entry.releaseId);
  if (state.expected !== entry.expected) skip("Reviewed source, target or ISBN state drifted.");
  const { observation, target, isbn13, rows, owners } = state;
  requirePhysicalSource(observation);
  if (observation.withdrawn || observation.queuedProposalId || target.release.format !== "physical")
    skip("Source is withdrawn or queued, or target is not physical.");
  const coverage = target.contents.map((row) => ({ volumeId: row.volume._id, extent: row.extent }));
  if (
    target.publisher._id !== entry.publisherId ||
    (target.release.binding ?? null) !== entry.binding ||
    !sameValue(coverage, entry.coverage) ||
    (!coverage.length && !target.edition.coverageUnmapped)
  )
    skip("Evidence publication facts or coverage differ from target.");
  if (state.variants.some((row) => publisherNameKey(row.name) === publisherNameKey(entry.name)))
    skip("A variant with this name already exists; review it instead.");
  if (entry.printingRowId) {
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?._id !== entry.printingRowId ||
      row.releaseId !== entry.releaseId ||
      row.kind ||
      row.variantId ||
      observation.recordRef?.type !== "release" ||
      observation.recordRef.id !== entry.releaseId ||
      observation.printingIsbn13 !== isbn13 ||
      owners.length !== 1 ||
      owners[0]?.kind !== "release" ||
      owners[0].doc._id !== entry.releaseId
    )
      skip("Only this Release's recorded plain Other Printing can be converted.");
  } else if (observation.recordRef || !state.hold || rows.length || owners.length) {
    skip("A held unlinked source and an unclaimed ISBN are required.");
  }
  const fields = {
    status: "active" as const,
    releaseId: entry.releaseId,
    name: entry.name.trim(),
    bootstrapUnreviewed: true,
  };
  await audit.meta();
  const variantId = await ctx.db.insert("releaseVariants", fields);
  audit.op({ kind: "create", table: "releaseVariants", tempId: variantId, fields });
  await audit.revise({ type: "releaseVariant", id: variantId }, [
    ...Object.entries(fields).map(([field, after]) => ({ field, after })),
    { field: REPAIR_KEY_FIELD, after: entry.key },
  ]);
  if (entry.printingRowId)
    await ctx.db.patch(entry.printingRowId, { variantId, reason: entry.reason });
  else
    await ctx.db.insert("releaseIsbns", {
      releaseId: entry.releaseId,
      isbn13,
      variantId,
      reason: entry.reason,
      sourceKey: observation.sourceKey,
      observationId: observation._id,
    });
  const changes = [
    {
      field: "releaseVariantIsbn",
      before: entry.printingRowId ? `Other Printing ${isbn13}` : undefined,
      after: `${entry.name}: ${isbn13}`,
    },
  ];
  audit.op({ kind: "update", ref: { type: "release", id: entry.releaseId }, changes });
  await audit.revise({ type: "release", id: entry.releaseId }, changes);
  await linkObservation(ctx, observation._id, { type: "release", id: entry.releaseId });
}

/** Inspect every reference before retiring a mistaken standalone printing Release. */
export async function printingSourceState(ctx: QueryCtx, sourceReleaseId: Id<"releases">) {
  const refs = await referenceAudit(ctx, sourceReleaseId);
  const r = reader(ctx);
  const observations = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) =>
        q.eq("recordRef.type", "release").eq("recordRef.id", sourceReleaseId),
      ),
  );
  const memberships = await r.many(
    ctx.db
      .query("bundleMemberships")
      .withIndex("by_release", (q) => q.eq("releaseId", sourceReleaseId)),
  );
  const printings = await r.many(
    ctx.db.query("releaseIsbns").withIndex("by_release", (q) => q.eq("releaseId", sourceReleaseId)),
  );
  const siblings = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", refs.edition._id)),
  );
  return {
    refs,
    observations,
    memberships,
    printings,
    siblings,
    expected: valueHash({ refs, observations, facts: r.facts }),
  };
}

/** Explicit evidence can establish multi-Volume printing identity; no source title heuristic is bypassed automatically. */
async function recordOtherPrinting(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"otherPrinting">,
) {
  checkUrls(entry.sources);
  const state = await variantState(ctx, entry.observationId, entry.releaseId);
  if (state.expected !== entry.expected) skip("Reviewed source, target or ISBN state drifted.");
  const { observation, target, isbn13, owners } = state;
  requirePhysicalSource(observation);
  if (primaryIsbnsOf(target.release).has(isbn13))
    skip("This ISBN is the base Release's own, not a secondary cover or printing.");
  const coverage = target.contents.map((row) => ({ volumeId: row.volume._id, extent: row.extent }));
  if (
    observation.withdrawn ||
    observation.queuedProposalId ||
    target.release.format !== "physical" ||
    target.publisher._id !== entry.publisherId ||
    (target.release.binding ?? null) !== entry.binding ||
    !coverage.length ||
    coverage.some((row) => row.extent !== "complete") ||
    !sameValue(coverage, entry.coverage)
  )
    skip(
      "A physical same-publisher, same-binding printing with exact complete coverage is required.",
    );
  if (state.rows.length) skip("ISBN already has a secondary claim.");
  let source: Awaited<ReturnType<typeof printingSourceState>> | null = null;
  if (entry.sourceReleaseId) {
    if (entry.sourceReleaseId === entry.releaseId)
      skip("A printing cannot retire its target Release.");
    source = await printingSourceState(ctx, entry.sourceReleaseId);
    if (source.expected !== entry.expectedSource) skip("Source Release dependencies drifted.");
    const { refs } = source;
    if (
      !refs.eligible ||
      refs.counts["collectionEntries.release"] ||
      refs.variants.length ||
      source.memberships.length ||
      source.printings.length ||
      source.siblings.length !== 1 ||
      refs.release.status !== "active" ||
      refs.release.locked ||
      refs.edition.locked ||
      refs.edition.overriddenFields?.length ||
      refs.release.overriddenFields?.length ||
      [...primaryIsbnsOf(refs.release)].some((key) => key !== isbn13) ||
      refs.release.editionId === target.edition._id ||
      refs.release.publisherId !== target.publisher._id ||
      refs.release.format !== "physical" ||
      (refs.release.binding ?? null) !== entry.binding ||
      !sameValue(
        refs.coverages
          .sort((a, b) => a.order - b.order)
          .map((row) => ({ volumeId: row.volumeId, extent: row.extent })),
        coverage,
      ) ||
      owners.length !== 1 ||
      owners[0]?.kind !== "release" ||
      owners[0].doc._id !== entry.sourceReleaseId ||
      source.observations.some(
        (row) => row.withdrawn || row.queuedProposalId || observedIsbn13(row.snapshot) !== isbn13,
      )
    )
      skip(
        "Source printing is not isolated or its content/publication facts differ; preserve its references separately.",
      );
    if (
      observation.recordRef &&
      (observation.recordRef.type !== "release" ||
        observation.recordRef.id !== entry.sourceReleaseId)
    )
      skip("Observation is linked elsewhere.");
  } else if (
    entry.expectedSource !== null ||
    owners.length ||
    observation.recordRef ||
    !state.hold
  ) {
    skip("An unlinked held observation with an unclaimed ISBN is required.");
  }
  const meta = await audit.meta();
  if (source) {
    await updateRecord(
      ctx,
      audit,
      { type: "release", id: source.refs.release._id },
      source.refs.release,
      { isbn13: undefined, isbn10: undefined },
    );
    for (const ref of [
      { type: "release" as const, id: source.refs.release._id },
      { type: "edition" as const, id: source.refs.edition._id },
    ]) {
      audit.op({ kind: "hide", ref });
      await applyHide(ctx, ref, meta);
    }
  }
  await ctx.db.insert("releaseIsbns", {
    releaseId: entry.releaseId,
    isbn13,
    reason: entry.reason,
    sourceKey: observation.sourceKey,
    observationId: observation._id,
    ...(source?.refs.release.pubDate ? { pubDate: source.refs.release.pubDate } : {}),
  });
  const changes = [{ field: "otherPrinting", after: `ISBN ${isbn13}` }];
  audit.op({ kind: "update", ref: { type: "release", id: entry.releaseId }, changes });
  await audit.revise({ type: "release", id: entry.releaseId }, changes);
  for (const id of new Set([
    observation._id,
    ...(source?.observations.map((row) => row._id) ?? []),
  ]))
    await linkObservation(ctx, id, { type: "release", id: entry.releaseId });
}
