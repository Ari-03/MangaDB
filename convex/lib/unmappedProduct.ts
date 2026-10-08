import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { reader, refuse, MAX_GUARD_BYTES, type Reader } from "./heldBooks";
import { storedClaims, statedIsbns } from "./releaseIsbns";
import { toIsbn13, isbn13To10 } from "./isbn";
import { scopeState } from "./scope";
import { projectSourceFormat } from "./sourceFormat";
import { sameValue, valueHash, nonJsonPath } from "./values";
import {
  unmappedProductPackets,
  unmappedWorkSnapshot,
  unmappedParentObservationId,
  unmappedWorkGuide,
} from "./unmappedProductProofs";
import {
  createAudit,
  createEdition,
  refreshReleaseDenorms,
  resolveActor,
  sameLabel,
} from "./repair/audit";
import { linkObservation } from "./observations";

export const unmappedProductProof = v.object({
  isbn13: v.string(),
  seriesId: v.id("series"),
  publisherId: v.id("publishers"),
  lineName: v.string(),
  linePosition: v.string(),
  productTitle: v.string(),
  sourceTitle: v.string(),
  format: v.literal("physical"),
  binding: v.literal("paperback"),
  language: v.literal("en"),
  pubDate: v.object({ year: v.number(), month: v.number(), day: v.number(), sort: v.number() }),
  publisherUrl: v.string(),
});
type Proof = Infer<typeof unmappedProductProof>;
export const unmappedProductArgs = {
  observationId: v.id("sourceObservations"),
  proof: unmappedProductProof,
};
export const unmappedProductExecuteArgs = {
  ...unmappedProductArgs,
  actor: v.string(),
  expected: v.string(),
};
export type UnmappedResult = {
  status: "created" | "linked" | "alreadyApplied" | "refused";
  reason?: string;
  releaseId?: Id<"releases">;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
};
const operation = "placeReviewedUnmappedProduct051";

function bounded(value: unknown) {
  const serialized = valueHash(value);
  if (new TextEncoder().encode(serialized).length > MAX_GUARD_BYTES)
    return refuse("Unmapped product proof/ledger exceeds 256 KiB.");
  return serialized;
}
function productProof(proof: Proof) {
  const { sourceTitle: _sourceTitle, ...product } = proof;
  return product;
}
async function revisions(ctx: QueryCtx, r: Reader, ref: Doc<"revisions">["ref"]) {
  return await r.many(
    ctx.db
      .query("revisions")
      .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id)),
  );
}
async function histories(ctx: QueryCtx, r: Reader, id: Id<"sourceObservations">) {
  return await r.many(
    ctx.db
      .query("observationSnapshots")
      .withIndex("by_observation", (q) => q.eq("observationId", id)),
  );
}
async function holds(ctx: QueryCtx, r: Reader, id: Id<"sourceObservations">) {
  return await r.many(
    ctx.db.query("placementHolds").withIndex("by_observation", (q) => q.eq("observationId", id)),
  );
}

/** Receipt verification reads native records, not a caller's declaration that a link exists. */
async function receiptState(
  ctx: QueryCtx,
  r: Reader,
  observationId: Id<"sourceObservations">,
  releaseId: Id<"releases">,
  proposalId: Id<"proposals">,
) {
  const observation = await r.read(observationId);
  const release = await r.read(releaseId);
  const edition = release && (await r.read(release.editionId));
  const line = edition?.editionLineId && (await r.read(edition.editionLineId));
  const proposal = await r.read(proposalId);
  const versions = await r.many(
    ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId)),
  );
  const audit = await r.many(
    ctx.db.query("revisions").withIndex("by_proposal", (q) => q.eq("proposalId", proposalId)),
  );
  const currentHolds = await holds(ctx, r, observationId);
  const history = await histories(ctx, r, observationId);
  const coverage =
    edition &&
    (await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    ));
  if (
    !observation ||
    observation.withdrawn ||
    observation.printingIsbn13 ||
    observation.recordRef?.type !== "release" ||
    observation.recordRef.id !== releaseId ||
    currentHolds.length ||
    !release ||
    !edition ||
    !line ||
    coverage?.length ||
    edition.coverageUnmapped !== true ||
    proposal?.state !== "approved" ||
    proposal.stale ||
    proposal.currentVersionNo !== 1 ||
    versions.length !== 1 ||
    versions[0]?.versionNo !== 1 ||
    !audit.some(
      (row) =>
        row.ref.type === "release" &&
        row.ref.id === releaseId &&
        row.changes.some(
          (c) =>
            c.field === "sourceObservation" && sameValue(c.after, { observationId, operation }),
        ),
    )
  )
    return refuse("Native product link, proposal, version or revision audit is missing/drifted.");
  return {
    observation,
    release,
    edition,
    line,
    proposal,
    versions,
    audit,
    holds: currentHolds,
    history,
    coverage,
  };
}
async function verifyReceipt(ctx: QueryCtx, r: Reader, ledger: Doc<"heldRepairLedger">) {
  if (ledger.operation !== operation || ledger.target?.type !== "release")
    return refuse("No audited unmapped product receipt.");
  const after = await receiptState(
    ctx,
    r,
    ledger.observationId,
    ledger.target.id,
    ledger.proposalId,
  );
  if (bounded(after) !== ledger.after) return refuse("Entire audited after-state changed.");
  return after;
}

/** Fixed exact source packets; no title alias, fuzzy work routing, or contents bypass. */
export async function unmappedProductState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  proof: Proof,
) {
  const r = reader(ctx);
  r.facts.push(unmappedWorkGuide);
  const observation = await r.read(observationId);
  if (
    !observation ||
    nonJsonPath(observation.snapshot) ||
    observation.withdrawn ||
    observation.printingIsbn13
  )
    return refuse("Source is absent, withdrawn or marked as a printing.");
  const packet = unmappedProductPackets.find(
    (p) => p.sourceKey === observation.sourceKey && p.sourceRecordId === observation.sourceRecordId,
  );
  const { seriesId, publisherId, ...bibliography } = proof;
  if (
    !packet ||
    observationId !== packet.observationId ||
    !sameValue(bibliography, packet.proof) ||
    !sameValue(observation.snapshot, packet.snapshot)
  )
    return refuse("Exact batch-051 publisher/source proof changed or is not assigned.");
  r.facts.push({ publisherCaptureSha256: packet.artifactSha256 });
  const sources = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", observation.sourceKey).eq("sourceRecordId", observation.sourceRecordId),
      ),
  );
  if (sources.length !== 1 || sources[0]?._id !== observationId)
    return refuse("Assigned source identity is ambiguous.");
  const projection = projectSourceFormat(observation);
  if (projection.status === "stale" || !sameValue(projection.snapshot, packet.snapshot))
    return refuse("Source effective format/binding/publisher changed.");
  r.facts.push(projection);
  const keys = statedIsbns(observation.snapshot).map(toIsbn13);
  if (!keys.length || keys.some((k) => k !== proof.isbn13))
    return refuse("Every ISBN-10/13 must prove this exact product.");
  const series = await r.active(seriesId);
  const publisher = await r.active(publisherId);
  if (
    series._id !== seriesId ||
    series.publicId !== 4290 ||
    series.title !== "Pokémon Adventures" ||
    publisher._id !== publisherId ||
    publisher.slug !== "viz-media" ||
    publisher.name !== "VIZ Media"
  )
    return refuse("Reviewed umbrella work or publisher identity differs.");
  const pubs = await r.many(
    ctx.db.query("publishers").withIndex("by_slug", (q) => q.eq("slug", "viz-media")),
  );
  const works = await r.many(
    ctx.db.query("series").withIndex("by_publicId", (q) => q.eq("publicId", 4290)),
  );
  if (pubs.length !== 1 || works.length !== 1)
    return refuse("Work/publisher identity is ambiguous.");
  // OL has no imported parent. Its frozen arc packet is independently reviewed against
  // this unchanged ANN umbrella context and the publisher guide; no OL parent is invented.
  const parents = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:7781"),
      ),
  );
  const parent = parents[0];
  if (
    parents.length !== 1 ||
    !parent ||
    parent._id !== unmappedParentObservationId ||
    parent.withdrawn ||
    parent.recordRef?.type !== "series" ||
    parent.recordRef.id !== seriesId ||
    !sameValue(parent.snapshot, unmappedWorkSnapshot) ||
    (await holds(ctx, r, parent._id)).length
  )
    return refuse("Original umbrella source parent/context changed.");
  for (const o of [observation, parent]) {
    if (o.queuedProposalId) {
      const proposal = await r.read(o.queuedProposalId);
      if (!proposal || proposal.state === "inReview" || proposal.state === "draft")
        return refuse("Source or parent has an unresolved proposal.");
      await r.many(
        ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id)),
      );
    }
    await histories(ctx, r, o._id);
  }
  await revisions(ctx, r, { type: "series", id: seriesId });
  await revisions(ctx, r, { type: "publisher", id: publisherId });
  const scope = await scopeState(ctx, proof.isbn13);
  r.facts.push(scope);
  if (scope.active) return refuse("ISBN has a reserved scope decision.");
  await r.many(ctx.db.query("appConfig"));
  const namespace = await storedClaims(ctx, proof.isbn13, r.room);
  r.facts.push(namespace);
  if (
    !namespace?.complete ||
    namespace.printed ||
    namespace.raw.some((c) => c.claim.on !== "release")
  )
    return refuse("ISBN namespace is incomplete, a printing or a Bundle reservation.");
  const ids = new Set(namespace.raw.map((c) => c.claim.storedId));
  if (ids.size > 1) return refuse("ISBN-10/13 namespace has competing owners.");
  const lines = await r.many(
    ctx.db.query("editionLines").withIndex("by_series", (q) => q.eq("seriesId", seriesId)),
  );
  const candidates = lines.filter(
    (l) => l.name.trim().toLowerCase() === proof.lineName.toLowerCase(),
  );
  if (candidates.length > 1) return refuse("Edition Line identity is ambiguous.");
  const line = candidates[0] ?? null;
  if (
    line &&
    (line.name !== proof.lineName ||
      line.publisherId !== publisherId ||
      line.status !== "active" ||
      line.locked)
  )
    return refuse("Edition Line is conflicting or closed.");
  let members: Doc<"editions">[] = [];
  if (line) {
    await revisions(ctx, r, { type: "editionLine", id: line._id });
    members = await r.many(
      ctx.db.query("editions").withIndex("by_line", (q) => q.eq("editionLineId", line._id)),
    );
  }
  const position = members.filter((e) => sameLabel(e.linePosition, proof.linePosition));
  if (position.length > 1) return refuse("Line position has multiple Edition owners.");
  // Capture complete collision closure including all statuses and coverage, never a first match.
  for (const e of position) {
    await revisions(ctx, r, { type: "edition", id: e._id });
    await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", e._id)),
    );
    await r.many(ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", e._id)));
  }
  const owner = namespace.raw[0]?.stored;
  let release: Doc<"releases"> | null = null;
  if (owner) {
    if (!("editionId" in owner)) return refuse("Bundle owner is forbidden.");
    release = await r.active(owner._id);
    if (
      release._id !== owner._id ||
      release.isbn13 !== proof.isbn13 ||
      release.isbn10 !== isbn13To10(proof.isbn13) ||
      release.format !== proof.format ||
      release.binding !== proof.binding ||
      release.language !== proof.language ||
      !sameValue(release.pubDate, proof.pubDate) ||
      release.publisherId !== publisherId ||
      !sameValue(release.seriesIds, [seriesId])
    )
      return refuse("Exact product owner conflicts.");
    const edition = await r.active(release.editionId);
    if (
      edition._id !== release.editionId ||
      edition.publisherId !== publisherId ||
      edition.editionLineId !== line?._id ||
      edition.linePosition !== proof.linePosition ||
      edition.coverageUnmapped !== true ||
      position.length !== 1 ||
      position[0]?._id !== edition._id
    )
      return refuse("Product line/position or known mapped contents contradict the review.");
    const coverage = await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    const siblings = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    if (coverage.length || siblings.length !== 1)
      return refuse("Known contents or sibling Release conflicts.");
    const releaseRevisions = await revisions(ctx, r, { type: "release", id: release._id });
    const origins = releaseRevisions.filter((row) =>
      row.changes.some(
        (c) => c.field === "unmappedProductProof" && sameValue(c.after, productProof(proof)),
      ),
    );
    if (origins.length !== 1) return refuse("Product creation provenance is missing or ambiguous.");
    const origin = origins[0]!;
    const originObservation = origin.changes.find(
      (c) => c.field === "unmappedProductOrigin",
    )?.after;
    if (typeof originObservation !== "string")
      return refuse("Owner lacks audited exact-product creation.");
    const originId = ctx.db.normalizeId("sourceObservations", originObservation);
    if (!originId) return refuse("Invalid creation provenance.");
    const ledgers = await r.many(
      ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", originId)),
    );
    const receipt = ledgers.filter(
      (l) =>
        l.operation === operation &&
        l.createdReleaseId === release!._id &&
        l.proposalId === origin!.proposalId,
    );
    if (receipt.length !== 1) return refuse("Product creation ledger is missing or ambiguous.");
    await verifyReceipt(ctx, r, receipt[0]!);
    const printings = await r.many(
      ctx.db.query("releaseIsbns").withIndex("by_release", (q) => q.eq("releaseId", release!._id)),
    );
    if (printings.length) return refuse("Product has acquired unreviewed alternate ISBNs.");
    for (const id of [release._id, edition._id]) {
      const aliases =
        id === release._id
          ? await r.many(
              ctx.db
                .query("releases")
                .withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", release!._id)),
            )
          : await r.many(
              ctx.db
                .query("editions")
                .withIndex("by_mergedInto", (q) => q.eq("mergedIntoId", edition._id)),
            );
      if (aliases.length)
        return refuse("Product has acquired merged aliases; separate review required.");
    }
    const bundles = await r.many(
      ctx.db
        .query("bundleMemberships")
        .withIndex("by_release", (q) => q.eq("releaseId", release!._id)),
    );
    if (bundles.length) return refuse("Product has acquired Bundle membership; review separately.");
  } else if (ids.size || position.length)
    return refuse("ISBN reserved or line position occupied by an unknown product.");
  const currentHolds = await holds(ctx, r, observationId);
  const ledgers = await r.many(
    ctx.db
      .query("heldRepairLedger")
      .withIndex("by_observation", (q) => q.eq("observationId", observationId)),
  );
  let already = false;
  if (observation.recordRef) {
    if (
      !release ||
      observation.recordRef.type !== "release" ||
      observation.recordRef.id !== release._id
    )
      return refuse("Observation linked elsewhere.");
    const receipts = ledgers.filter(
      (l) => l.operation === operation && l.target?.id === release!._id,
    );
    if (receipts.length !== 1) return refuse("Link receipt missing or ambiguous.");
    await verifyReceipt(ctx, r, receipts[0]!);
    already = true;
  } else if (
    currentHolds.length !== 1 ||
    currentHolds[0]?.kind !== "isbn" ||
    currentHolds[0]?.seriesId !== seriesId ||
    currentHolds[0]?.sourceKey !== observation.sourceKey ||
    ledgers.some((l) => l.operation === operation)
  )
    return refuse("Current hold/link lifecycle changed.");
  return {
    expected: bounded({ operation, observationId, proof, facts: r.facts }),
    observation,
    hold: currentHolds[0] ?? null,
    packet,
    series,
    publisher,
    line,
    release,
    already,
    r,
  };
}

/** All inserts, native link cleanup, denorms and audits share the caller's nested transaction. */
export async function applyUnmappedProduct(
  ctx: MutationCtx,
  args: {
    observationId: Id<"sourceObservations">;
    proof: Proof;
    expected: string;
    actor: string;
  },
): Promise<UnmappedResult> {
  const state = await unmappedProductState(ctx, args.observationId, args.proof);
  if (state.expected !== args.expected)
    return refuse("Unmapped product state changed; preview again.");
  const actor = await resolveActor(ctx, args.actor);
  if (state.already) return { status: "alreadyApplied", releaseId: state.release!._id };
  const before = bounded({
    expected: state.expected,
    observation: state.observation,
    hold: state.hold,
    createdLine: !state.line,
    createdProduct: !state.release,
  });
  const reason =
    "Reviewed batch-051 own-ISBN DP/Platinum paperback identity; chapter coverage remains unmapped.";
  const audit = createAudit(ctx, actor, reason, [
    { kind: "observation", observationId: args.observationId },
    { kind: "url", url: args.proof.publisherUrl },
    { kind: "url", url: unmappedWorkGuide.url },
    {
      kind: "note",
      text: bounded({
        proof: args.proof,
        publisherCaptureSha256: state.packet.artifactSha256,
        umbrellaGuide: unmappedWorkGuide,
      }),
    },
  ]);
  let releaseId = state.release?._id;
  let lineId = state.line?._id;
  let editionId = state.release?.editionId;
  if (!releaseId) {
    if (!lineId) {
      const fields = {
        status: "active" as const,
        seriesId: args.proof.seriesId,
        publisherId: args.proof.publisherId,
        name: args.proof.lineName,
      };
      lineId = await ctx.db.insert("editionLines", fields);
      audit.op({ kind: "create", table: "editionLines", tempId: lineId, fields });
      await audit.revise(
        { type: "editionLine", id: lineId },
        Object.entries(fields).map(([field, after]) => ({ field, after })),
      );
    }
    editionId = await createEdition(ctx, audit, {
      status: "active",
      publisherId: args.proof.publisherId,
      editionLineId: lineId,
      linePosition: args.proof.linePosition,
      coverageUnmapped: true,
    });
    const fields = {
      status: "active" as const,
      editionId,
      publisherId: args.proof.publisherId,
      seriesIds: [args.proof.seriesId],
      format: args.proof.format,
      binding: args.proof.binding,
      language: args.proof.language,
      isbn13: args.proof.isbn13,
      isbn10: isbn13To10(args.proof.isbn13),
      pubDate: args.proof.pubDate,
    };
    releaseId = await ctx.db.insert("releases", fields);
    audit.op({ kind: "create", table: "releases", tempId: releaseId, fields });
    await audit.revise({ type: "release", id: releaseId }, [
      ...Object.entries(fields)
        .filter(([, after]) => after !== undefined)
        .map(([field, after]) => ({ field, after })),
      { field: "unmappedProductProof", after: productProof(args.proof) },
      { field: "unmappedProductOrigin", after: args.observationId },
    ]);
    await refreshReleaseDenorms(ctx, editionId);
  }
  await linkObservation(ctx, args.observationId, { type: "release", id: releaseId });
  const changes = [
    { field: "sourceObservation", after: { observationId: args.observationId, operation } },
  ];
  audit.op({ kind: "update", ref: { type: "release", id: releaseId }, changes });
  await audit.revise({ type: "release", id: releaseId }, changes);
  await audit.finish();
  const proposalId = (await audit.meta()).proposalId;
  const afterState = await receiptState(ctx, state.r, args.observationId, releaseId, proposalId);
  const expectedObservation = {
    ...state.observation,
    recordRef: { type: "release", id: releaseId },
    conflicts: state.observation.conflicts?.filter((c) => c.field !== "placement"),
  };
  if (!sameValue(afterState.observation, expectedObservation))
    return refuse("Source preservation failed; entire transaction rolled back.");
  const ledgerId = await ctx.db.insert("heldRepairLedger", {
    observationId: args.observationId,
    operation,
    proposalId,
    before,
    after: bounded(afterState),
    target: { type: "release", id: releaseId },
    createdReleaseId: state.release ? undefined : releaseId,
    createdStructure: state.release
      ? undefined
      : {
          editionId: editionId!,
          lineId: lineId!,
          volumeIds: [],
          sharedEdition: false,
          newEdition: true,
          newVolumeIds: [],
          newCoverageIds: [],
          newLine: !state.line,
        },
  });
  return { status: state.release ? "linked" : "created", releaseId, proposalId, ledgerId };
}
