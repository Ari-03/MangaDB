// Batch-040's reviewed creation contract. Preview and apply run the same
// bounded closure; the mutation re-reads it before making its first write.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { heldState, MAX_GUARD_BYTES, refuse } from "./heldBooks";
import {
  sameLabel,
  createAudit,
  createEdition,
  REPAIR_KEY_FIELD,
  resolveActor,
  type Ref,
} from "./repair/audit";
import { assignedProduct } from "./reviewedCatalogProducts";
import { sameValue, valueHash, nonJsonPath } from "./values";

const RECEIPT = "reviewedCatalogCreation";

/** Recognized guard failures only. Runtime errors must remain errors. */
export function creationRefusal(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return null;
  if ("held" in data && typeof data.held === "string") return data.held;
  if ("skip" in data && typeof data.skip === "string") return data.skip;
  return null;
}

/** Includes all statuses, raw history, catalog history and raw ISBN owners. */
export async function reviewedCreationState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
) {
  const product =
    assignedProduct(observationId) ?? refuse("Observation is outside reviewed batch-040 scope.");
  const held = await heldState(ctx, observationId);
  const { r, observation, source } = held;
  if (
    !held.eligible ||
    held.scopeReason ||
    !held.hold ||
    held.hold.kind !== "isbn" ||
    held.hold.sourceKey !== "ann" ||
    held.hold.seriesId !== product.seriesId ||
    observation.sourceKey !== "ann" ||
    observation.sourceRecordId !== product.sourceRecordId ||
    observation.reviewedSourceFormat ||
    !sameValue(observation.snapshot, product.snapshot) ||
    held.isbn13 !== product.isbn13 ||
    !source.parent ||
    source.series?._id !== product.seriesId
  )
    return refuse("Held source or independently linked parent differs from reviewed product.");
  const parentSnapshot: unknown = source.parent.snapshot;
  if (
    typeof parentSnapshot !== "object" ||
    parentSnapshot === null ||
    !("title" in parentSnapshot) ||
    parentSnapshot.title !== "Inuyasha" ||
    !("id" in parentSnapshot) ||
    parentSnapshot.id !== "76" ||
    source.parent.sourceRecordId !== "manga:76"
  )
    return refuse("Reviewed parent work identity differs.");
  // A merged survivor does not silently replace a reviewed canonical ID.
  const series = await r.active(source.series._id);
  if (series._id !== product.seriesId || series.title !== "Inuyasha" || series.mergedIntoId)
    return refuse("Reviewed Series identity differs.");
  const publisherId =
    ctx.db.normalizeId("publishers", product.publisherId) ??
    refuse("Invalid reviewed publisher ID.");
  const publisher = await r.active(publisherId);
  if (
    publisher._id !== product.publisherId ||
    publisher.name !== "VIZ Media" ||
    publisher.mergedIntoId
  )
    return refuse("Reviewed publisher identity differs.");
  const sourceFacts: unknown[] = [
    observation,
    held.hold,
    held.proposal,
    source.parent,
    series,
    publisher,
  ];
  for (const observed of [observation, source.parent]) {
    sourceFacts.push(
      await r.many(
        ctx.db
          .query("observationSnapshots")
          .withIndex("by_observation", (q) => q.eq("observationId", observed._id)),
      ),
    );
    const identities = await r.many(
      ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", observed.sourceKey).eq("sourceRecordId", observed.sourceRecordId),
        ),
    );
    if (identities.length !== 1 || identities[0]?._id !== observed._id)
      return refuse("Source identity is duplicated.");
    sourceFacts.push(identities);
  }
  const history = async (ref: Ref) =>
    r.many(
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id)),
    );
  sourceFacts.push(await history({ type: "series", id: series._id }));
  sourceFacts.push(await history({ type: "publisher", id: publisher._id }));
  const volumes = await r.many(
    ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", series._id)),
  );
  const covered: Doc<"volumes">[] = [];
  for (const pin of product.volumes) {
    const matches = volumes.filter((volume) => sameLabel(volume.label, pin.label));
    const volume = matches[0];
    if (
      matches.length !== 1 ||
      !volume ||
      volume._id !== pin.id ||
      volume.status !== "active" ||
      volume.locked ||
      volume.mergedIntoId ||
      volume.label !== pin.label ||
      volume.position !== Number(pin.label)
    )
      return refuse("Reviewed unique active Volume identity, label or order differs.");
    covered.push(volume);
    sourceFacts.push(await history({ type: "volume", id: volume._id }));
  }
  const lines = await r.many(
    ctx.db.query("editionLines").withIndex("by_series", (q) => q.eq("seriesId", series._id)),
  );
  const named = lines.filter(
    (line) =>
      line.publisherId === publisher._id &&
      line.name.trim().toLowerCase() === product.lineName.toLowerCase(),
  );
  const line = named[0];
  if (
    named.length !== 1 ||
    !line ||
    line._id !== product.lineId ||
    line.status !== "active" ||
    line.locked ||
    line.mergedIntoId ||
    line.name !== product.lineName
  )
    return refuse("Reviewed Edition Line is missing, ambiguous or inactive.");
  sourceFacts.push(await history({ type: "editionLine", id: line._id }));
  sourceFacts.push(volumes, lines);
  // Source baseline stays invariant across creation. Catalog candidate sets
  // and ISBN ownership belong to the changing pre/post preview closure below.
  const sourceExpected = await closureToken({ product, facts: sourceFacts });
  const ledgers = await r.many(
    ctx.db
      .query("heldRepairLedger")
      .withIndex("by_observation", (q) => q.eq("observationId", observationId)),
  );
  const priorLedgers = ledgers.filter((ledger) => ledger.operation === RECEIPT);
  if (priorLedgers.length > 1) return refuse("Prior creation ledger is duplicated.");
  const ledger = priorLedgers[0];
  const candidates = new Map<Id<"editions">, Doc<"editions">>();
  for (const candidateLine of lines) {
    const members = await r.many(
      ctx.db
        .query("editions")
        .withIndex("by_line", (q) => q.eq("editionLineId", candidateLine._id)),
    );
    for (const member of members) candidates.set(member._id, member);
  }
  // Include Editions without a line and Editions attached to another Series'
  // line that cover any reviewed Volume. Distinct edition identities survive.
  for (const volume of covered) {
    const rows = await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
    );
    for (const row of rows) {
      if (candidates.has(row.editionId)) continue;
      const edition = (await r.read(row.editionId)) ?? refuse("Dangling coverage Edition.");
      candidates.set(edition._id, edition);
    }
  }
  if (ledger) {
    if (!ledger.createdReleaseId || !ledger.createdStructure || ledger.before !== sourceExpected)
      return refuse("Prior creation ledger or source baseline differs.");
    const edition =
      (await r.read(ledger.createdStructure.editionId)) ??
      refuse("Prior created Edition is missing.");
    candidates.set(edition._id, edition);
    await r.read(ledger.createdReleaseId);
  }
  const details = [];
  for (const edition of candidates.values()) {
    const coverage = await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    const releases = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    const revisions = await history({ type: "edition", id: edition._id });
    for (const release of releases) await history({ type: "release", id: release._id });
    details.push({ edition, coverage, releases, revisions });
  }
  // Raw claims reserve ISBNs even when hidden/merged or duplicated. Resolving
  // to a survivor must never hide a second primary or a printing/bundle row.
  const primaries13 = await r.many(
    ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", product.isbn13)),
  );
  const primaries10 = await r.many(
    ctx.db.query("releases").withIndex("by_isbn10", (q) => q.eq("isbn10", product.isbn10)),
  );
  const printings = await r.many(
    ctx.db.query("releaseIsbns").withIndex("by_isbn13", (q) => q.eq("isbn13", product.isbn13)),
  );
  const bundles = await r.many(
    ctx.db.query("releaseBundles").withIndex("by_isbn13", (q) => q.eq("isbn13", product.isbn13)),
  );
  const bundles10 = await r.many(
    ctx.db.query("releaseBundles").withIndex("by_isbn10", (q) => q.eq("isbn10", product.isbn10)),
  );
  const slots = details.filter(
    ({ edition }) =>
      edition.editionLineId === line._id && sameLabel(edition.linePosition, product.position),
  );
  const own = primaries13[0];
  let prior: {
    releaseId: Id<"releases">;
    editionId: Id<"editions">;
    proposalId: Id<"proposals">;
  } | null = null;
  if (ledger && own?._id !== ledger.createdReleaseId)
    return refuse("Prior repair Release no longer solely claims its reviewed ISBN.");
  if (own) {
    const revisions = await history({ type: "release", id: own._id });
    const creation = revisions[0];
    const target = details.find(({ edition }) => edition._id === own.editionId);
    if (
      !creation ||
      revisions.length !== 1 ||
      creation.seq !== 1 ||
      !target ||
      !creation.changes.some(
        (change) => change.field === REPAIR_KEY_FIELD && change.after === product.key,
      )
    )
      return refuse("ISBN already exists; independent reuse review is required.");
    const receipt = {
      product: valueHash(product),
      sourceExpected,
      editionId: target.edition._id,
      coverageIds: target.coverage.map((row) => row._id),
    };
    if (
      primaries13.length !== 1 ||
      primaries10.length !== 1 ||
      primaries10[0]?._id !== own._id ||
      printings.length ||
      bundles.length ||
      bundles10.length ||
      held.claims.owners.size !== 1 ||
      slots.length !== 1 ||
      slots[0]?.edition._id !== target.edition._id ||
      !creation.changes.some(
        (change) => change.field === RECEIPT && sameValue(change.after, receipt),
      )
    )
      return refuse("Prior repair ownership, source baseline or receipt differs.");
    if (
      !ledger ||
      ledger.proposalId !== creation.proposalId ||
      ledger.createdReleaseId !== own._id ||
      ledger.target?.type !== "release" ||
      ledger.target.id !== own._id ||
      ledger.after !== valueHash(receipt) ||
      !sameValue(ledger.createdStructure, {
        editionId: target.edition._id,
        volumeIds: covered.map((volume) => volume._id),
        sharedEdition: false,
        newEdition: true,
        newVolumeIds: [],
        newCoverageIds: target.coverage.map((row) => row._id),
        lineId: line._id,
        newLine: false,
      })
    )
      return refuse("Prior creation ledger does not close over actual created IDs.");
    const fields = releaseFields(product, target.edition._id, publisher._id, series._id);
    const editionFields = {
      status: "active",
      publisherId: publisher._id,
      editionLineId: line._id,
      linePosition: product.position,
      bootstrapUnreviewed: true,
    };
    const actualReleaseFields = Object.fromEntries(
      Object.entries(own).filter(([key]) => !key.startsWith("_")),
    );
    const actualEditionFields = Object.fromEntries(
      Object.entries(target.edition).filter(([key]) => !key.startsWith("_")),
    );
    if (
      own.locked ||
      own.mergedIntoId ||
      target.edition.locked ||
      target.edition.mergedIntoId ||
      target.edition.coverageUnmapped ||
      !sameValue(actualReleaseFields, fields) ||
      !sameValue(actualEditionFields, { ...editionFields, publicId: target.edition.publicId }) ||
      own.price !== undefined ||
      own.digitalFileFormat !== undefined ||
      target.releases.length !== 1 ||
      target.coverage.length !== covered.length ||
      target.coverage.some(
        (row, i) =>
          row.volumeId !== covered[i]?._id ||
          row.extent !== "complete" ||
          row.order !== i + 1 ||
          row.note !== undefined,
      )
    )
      return refuse("Prior repair product, ordered complete coverage or siblings differ.");
    const proposal = await r.read(creation.proposalId);
    const versions = await r.many(
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", creation.proposalId)),
    );
    const auditRevisions = await r.many(
      ctx.db
        .query("revisions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", creation.proposalId)),
    );
    const version = versions[0];
    const expectedOps = [
      {
        kind: "create",
        table: "editions",
        tempId: target.edition._id,
        fields: { ...editionFields, publicId: target.edition.publicId },
      },
      {
        kind: "update",
        ref: { type: "edition", id: target.edition._id },
        changes: [
          {
            field: "volumeCoverage",
            after: target.coverage.map(({ volumeId, order, extent }) => ({
              volumeId,
              order,
              extent,
            })),
          },
        ],
      },
      { kind: "create", table: "releases", tempId: own._id, fields },
    ];
    const evidence = creationEvidence(product, observationId);
    if (
      !proposal ||
      proposal.state !== "approved" ||
      proposal.stale ||
      proposal.currentVersionNo !== 1 ||
      versions.length !== 1 ||
      !version ||
      !sameValue(version.ops, expectedOps) ||
      !sameValue(version.evidence, evidence) ||
      target.revisions.length !== 2 ||
      target.revisions.some((revision) => revision.proposalId !== creation.proposalId) ||
      auditRevisions.length !== 3 ||
      proposal.author.kind !== "user" ||
      proposal.decidedBy !== proposal.author.userId ||
      version.changeComment !== `Reviewed catalog creation: ${product.reason}` ||
      auditRevisions.some(
        (revision) =>
          !sameValue(revision.author, proposal.author) ||
          revision.approvedBy !== proposal.decidedBy ||
          revision.comment !== version.changeComment,
      ) ||
      !sameValue(creation.author, proposal.author) ||
      creation.approvedBy !== proposal.decidedBy
    )
      return refuse("Prior repair Proposal, version or Revision audit is incomplete.");
    // Check the full revision changes, not just the existence of a key.
    const expectedReleaseChanges = [
      ...Object.entries(fields).map(([field, after]) => ({ field, after })),
      { field: REPAIR_KEY_FIELD, after: product.key },
      { field: RECEIPT, after: receipt },
    ];
    const firstEdition = target.revisions.find((revision) => revision.seq === 1);
    const coverageRevision = target.revisions.find((revision) => revision.seq === 2);
    if (
      !sameValue(creation.changes, expectedReleaseChanges) ||
      !sameValue(
        firstEdition?.changes,
        Object.entries({ ...editionFields, publicId: target.edition.publicId }).map(
          ([field, after]) => ({ field, after }),
        ),
      ) ||
      !sameValue(coverageRevision?.changes, expectedOps[1]?.changes)
    )
      return refuse("Prior repair Revision fields differ.");
    prior = { releaseId: own._id, editionId: own.editionId, proposalId: creation.proposalId };
  } else {
    if (
      primaries10.length ||
      printings.length ||
      bundles.length ||
      bundles10.length ||
      held.claims.owners.size
    )
      return refuse("Reviewed ISBN has an existing primary, printing or Bundle claim.");
    for (const target of details) {
      for (const release of target.releases) {
        const revisions = await history({ type: "release", id: release._id });
        if (
          revisions.some((revision) =>
            revision.changes.some(
              (change) => change.field === REPAIR_KEY_FIELD && change.after === product.key,
            ),
          )
        )
          return refuse("Same-product prior repair exists with changed target identity.");
      }
    }
    if (slots.length)
      return refuse(
        "Reviewed line position is occupied; preserve it and independently review reuse.",
      );
  }
  const expected = await closureToken({
    contract: "batch-040-reviewed-creation-v1",
    product,
    facts: r.facts,
    prior,
  });
  return { product, sourceExpected, expected, prior, covered, publisher, series, line };
}

/** Hash a canonical, size-checked closure to keep receipts and retry reads bounded. */
async function closureToken(value: unknown) {
  if (nonJsonPath(value)) return refuse("Creation closure is non-JSON; incomplete.");
  const bytes = new TextEncoder().encode(valueHash(value));
  if (bytes.length > MAX_GUARD_BYTES)
    return refuse("Creation closure exceeds 256 KiB; incomplete.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `batch-040-v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type Product = NonNullable<ReturnType<typeof assignedProduct>>;
function releaseFields(
  product: Product,
  editionId: Id<"editions">,
  publisherId: Id<"publishers">,
  seriesId: Id<"series">,
) {
  return {
    status: "active" as const,
    editionId,
    format: "physical" as const,
    binding: "paperback",
    language: "en",
    isbn13: product.isbn13,
    isbn10: product.isbn10,
    pubDate: product.pubDate,
    publisherId,
    seriesIds: [seriesId],
    bootstrapUnreviewed: true,
  };
}
function creationEvidence(product: Product, observationId: Id<"sourceObservations">) {
  return [
    { kind: "observation" as const, observationId },
    ...product.evidence.map((evidence) => ({ kind: "url" as const, url: evidence.url })),
    {
      kind: "note" as const,
      text: valueHash({
        contract: "batch-040-reviewed-creation-v1",
        key: product.key,
        evidence: product.evidence,
      }),
    },
  ];
}

/** No edits to existing Editions, Releases, line, sources or tracking. */
export async function applyReviewedCreation(
  ctx: MutationCtx,
  args: { observationId: Id<"sourceObservations">; expected: string; actor: string },
) {
  const state = await reviewedCreationState(ctx, args.observationId);
  if (state.expected !== args.expected)
    return refuse("Creation preview is stale. Refresh and review it.");
  const actor = await resolveActor(ctx, args.actor);
  if (state.prior) return { status: "alreadyApplied" as const, ...state.prior };
  const { product, covered, publisher, series, line } = state;
  const audit = createAudit(
    ctx,
    actor,
    `Reviewed catalog creation: ${product.reason}`,
    creationEvidence(product, args.observationId),
  );
  const editionId = await createEdition(ctx, audit, {
    status: "active",
    publisherId: publisher._id,
    editionLineId: line._id,
    linePosition: product.position,
    bootstrapUnreviewed: true,
  });
  const coverageIds: Id<"volumeCoverages">[] = [];
  const coverage = covered.map((volume, index) => ({
    volumeId: volume._id,
    order: index + 1,
    extent: "complete" as const,
  }));
  for (const row of coverage)
    coverageIds.push(await ctx.db.insert("volumeCoverages", { editionId, ...row }));
  const changes = [{ field: "volumeCoverage", after: coverage }];
  audit.op({ kind: "update", ref: { type: "edition", id: editionId }, changes });
  await audit.revise({ type: "edition", id: editionId }, changes);
  const fields = releaseFields(product, editionId, publisher._id, series._id);
  const releaseId = await ctx.db.insert("releases", fields);
  audit.op({ kind: "create", table: "releases", tempId: releaseId, fields });
  await audit.revise({ type: "release", id: releaseId }, [
    ...Object.entries(fields).map(([field, after]) => ({ field, after })),
    { field: REPAIR_KEY_FIELD, after: product.key },
    {
      field: RECEIPT,
      after: {
        product: valueHash(product),
        sourceExpected: state.sourceExpected,
        editionId,
        coverageIds,
      },
    },
  ]);
  const { proposalId } = await audit.meta();
  await audit.finish();
  await ctx.db.insert("heldRepairLedger", {
    observationId: args.observationId,
    operation: RECEIPT,
    proposalId,
    before: state.sourceExpected,
    after: valueHash({
      product: valueHash(product),
      sourceExpected: state.sourceExpected,
      editionId,
      coverageIds,
    }),
    target: { type: "release", id: releaseId },
    createdReleaseId: releaseId,
    createdStructure: {
      editionId,
      volumeIds: covered.map((volume) => volume._id),
      sharedEdition: false,
      newEdition: true,
      newVolumeIds: [],
      newCoverageIds: coverageIds,
      lineId: line._id,
      newLine: false,
    },
  });
  return { status: "created" as const, releaseId, editionId, proposalId };
}
