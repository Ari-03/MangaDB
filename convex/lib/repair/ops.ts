// The one-time catalog repair's operations, one per plan-entry kind. Each
// validates that the rows still look the way the plan expected (skipping
// with a reason on drift instead of clobbering), is idempotent (a re-run
// reports alreadyApplied), and writes through the stock sensitive-op apply
// functions where they fit: Hide, Restore, and Merge for volumes, editions, releases,
// and — once its Volumes are placed — Series. The stock Series merge appends
// loser Volumes after the survivor's, so Volumes are placed by label first.

import { isbnScope } from "../scope";
import { getBootstrapMode } from "../../importSources";
import { placeEdition } from "../../openLibrary";
import type { OlEditionSnapshot } from "../openLibrary";
import { projectSourceFormat } from "../sourceFormat";
import { reader, releaseContents, volumesForLabels } from "../heldBooks";
import { referenceAudit, convertedClaim, conversionState } from "../heldRepair";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { Contents } from "../heldBooks";
import type { MutationCtx } from "../../_generated/server";
import type { DigitalFileFormat } from "../bookFacts";
import { type IsbnField, isbn13To10, isbnFieldValue, toIsbn13 } from "../isbn";
import { followMerges } from "../merges";
import { getObservation, holdOf, linkObservation } from "../observations";
import { allocatePublicId } from "../publicIds";
import { DUPLICATE_SLUGS, IMPRINT_PARENTS, canonicalPublisherFor } from "../publishers";
import {
  assignedIsbnRefusal,
  primaryIsbnsOf,
  isbnClaims,
  claimResolver,
  statedIsbns,
  storedClaims,
} from "../releaseIsbns";
import { seriesSearchText } from "../searchMatch";
import {
  OWNERSHIP,
  READING,
  applyHide,
  applyMerge,
  applyRestore,
  bundleOwners,
  bundleSeries,
  carryEditionTracking,
  carryVisibility,
  editionGovernance,
  restoreRefusal,
  type EditionGovernance,
  type OverrideSink,
} from "../sensitiveOps";
import { sameValue, valueHash } from "../values";
import {
  activeEditionsCovering,
  activeVolumes,
  canonicalLabel,
  coverageOf,
  coveringOf,
  createEdition,
  ensureVolume,
  labelNumber,
  REPAIR_KEY_FIELD,
  refreshReleaseDenorms,
  releasesOf,
  replaceCoverage,
  sameLabel,
  settlePositions,
  skip,
  updateRecord,
  type Audit,
  type Ref,
  type TrailRow,
} from "./audit";
import type { EntryOf, Outcome, RepairEntry } from "./entries";

type Status = Outcome["status"];
type Result = { status: Status; reason?: string };

const applied: Result = { status: "applied" };
const already: Result = { status: "alreadyApplied" };

/** Dispatch one plan entry to its operation. */
export async function applyEntry(
  ctx: MutationCtx,
  audit: Audit,
  entry: RepairEntry,
): Promise<Result> {
  switch (entry.kind) {
    case "publisherMerge":
      return await publisherMerge(ctx, audit, entry);
    case "publisherParent":
      return await publisherParent(ctx, audit, entry);
    case "editionPublisher":
      return await editionPublisher(ctx, audit, entry);
    case "editionLinePublisher":
      return await editionLinePublisher(ctx, audit, entry);
    case "hideSeries":
      return await hideSeries(ctx, audit, entry);
    case "hideRelease":
      return await hideRelease(ctx, audit, entry);
    case "restoreRecord":
      return await restoreRecord(ctx, audit, entry);
    case "unlinkObservation":
      return await unlinkObservation(ctx, audit, entry);
    case "mergeSeries":
      return await mergeSeries(ctx, audit, entry);
    case "remodelEdition":
      return await remodelEdition(ctx, audit, entry);
    case "foldEdition":
      return await foldEdition(ctx, audit, entry);
    case "updateFields":
      return await updateFields(ctx, audit, entry);
    case "normalizeVolumes":
      return await normalizeVolumes(ctx, audit, entry);
    case "withdrawProposal":
      return await withdrawProposal(ctx, entry);
    case "splitSeries":
      return await splitSeries(ctx, audit, entry);
    case "hideEditionLine":
      return await hideEditionLine(ctx, audit, entry);
    case "createRelease":
      return await createRelease(ctx, audit, entry);
    case "createVolume":
      return await createVolume(ctx, audit, entry);
    case "releaseBundle":
      return await releaseBundle(ctx, audit, entry);
    case "setCoverage":
      return await setCoverage(ctx, audit, entry);
    case "seriesFamily":
      return await seriesFamily(ctx, audit, entry);
    case "splitEdition":
      return await splitEdition(ctx, audit, entry);
    case "addVolume":
      return await addVolume(ctx, audit, entry);
  }
}

/**
 * Withdraw a source-authored In-Review Proposal nobody has claimed or noted,
 * and unlink it from its observation. No catalog record changes, so there is
 * no Revision; the Proposal's own state is the audit trail.
 */
async function withdrawProposal(
  ctx: MutationCtx,
  entry: EntryOf<"withdrawProposal">,
): Promise<Result> {
  const proposal = await ctx.db.get(entry.proposalId);
  const observation = await ctx.db.get(entry.observationId);
  if (!proposal || !observation) return skip("proposal or observation missing");
  if (proposal.state === "withdrawn") {
    if (observation.queuedProposalId === proposal._id) {
      await ctx.db.patch(observation._id, { queuedProposalId: undefined });
      return applied;
    }
    return already;
  }
  if (proposal.state !== "inReview") return skip(`proposal is ${proposal.state}`);
  if (proposal.author.kind !== "source") return skip("proposal was written by a person");
  if (proposal.claimedBy) return skip("a reviewer has claimed the proposal");
  const note = await ctx.db
    .query("proposalNotes")
    .withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
    .first();
  if (note) return skip("the proposal has reviewer notes");
  await ctx.db.patch(proposal._id, { state: "withdrawn", decidedAt: Date.now() });
  if (observation.queuedProposalId === proposal._id) {
    await ctx.db.patch(observation._id, { queuedProposalId: undefined });
  }
  return applied;
}

/** Hide a record through the stock Hide unless it already is hidden. */
async function hide(
  ctx: MutationCtx,
  audit: Audit,
  ref: Ref,
  doc: { status: string; locked?: boolean },
) {
  if (doc.status !== "active") return false;
  if (doc.locked) skip(`${ref.type} ${ref.id} is locked`);
  audit.op({ kind: "hide", ref });
  await applyHide(ctx, ref, await audit.meta());
  return true;
}

/** Restore a record through the stock Restore unless it already is active. */
async function restore(
  ctx: MutationCtx,
  audit: Audit,
  ref: Ref,
  doc: { status: string; locked?: boolean },
) {
  if (doc.status === "active") return false;
  if (doc.locked) skip(`${ref.type} ${ref.id} is locked`);
  // Restore's own check (its ISBNs still its own), reported as this entry's skip.
  const refusal = await restoreRefusal(ctx, ref);
  if (refusal !== null) skip(refusal);
  audit.op({ kind: "restore", ref });
  await applyRestore(ctx, ref, await audit.meta());
  return true;
}

async function merge(ctx: MutationCtx, audit: Audit, survivor: Ref, loser: Ref) {
  audit.op({ kind: "merge", survivor, merged: loser, baseRevisionIds: [] });
  await applyMerge(ctx, survivor, loser, await audit.meta());
}

// ---------- stage 1: publishers ----------

/** Editions (with their releases) repointed per call; the runner re-calls until done. */
const PUBLISHER_CHUNK = 250;

async function publisherMerge(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"publisherMerge">,
): Promise<Result> {
  const loser = await ctx.db.get(entry.loserId);
  const survivor = await ctx.db.get(entry.survivorId);
  if (!loser || !survivor) return skip("publisher row missing");
  if (loser.status === "merged") {
    return loser.mergedIntoId === survivor._id ? already : skip("loser merged elsewhere");
  }
  if (loser.status !== "active" || survivor.status !== "active") skip("publisher not active");
  if (DUPLICATE_SLUGS[loser.slug] !== survivor.slug) {
    skip(`lib/publishers.ts does not list ${loser.slug} as a duplicate of ${survivor.slug}`);
  }

  // The stock publisher merge repoints everything in one transaction, which
  // outgrows a mutation (and a manifest document) for thousands of rows:
  // repoint in chunks, each with its own manifest, then finish with the stock
  // merge for the small tables, the slug redirect, status, and Revisions.
  // Each call is its own Proposal; Split still replays every chunk with the
  // closing merge, since it groups a merge's manifests by survivor
  // (lib/sensitiveOps.ts reversibleManifestsOf).
  const editions = await ctx.db
    .query("editions")
    .withIndex("by_publisher", (q) => q.eq("publisherId", loser._id))
    .take(PUBLISHER_CHUNK);
  const straysLeft =
    editions.length === 0
      ? await ctx.db
          .query("releases")
          .withIndex("by_publisher_date", (q) => q.eq("publisherId", loser._id))
          .take(PUBLISHER_CHUNK)
      : [];
  if (editions.length > 0 || straysLeft.length > 0) {
    const { proposalId } = await audit.meta();
    const repointed: Array<{
      table: string;
      docId: string;
      field: string;
      before: Id<"publishers">;
      after: Id<"publishers">;
    }> = [];
    for (const edition of editions) {
      await ctx.db.patch(edition._id, { publisherId: survivor._id });
      repointed.push({
        table: "editions",
        docId: edition._id,
        field: "publisherId",
        before: loser._id,
        after: survivor._id,
      });
      for (const release of await releasesOf(ctx, edition._id)) {
        if (release.publisherId !== loser._id) continue;
        await ctx.db.patch(release._id, { publisherId: survivor._id });
        repointed.push({
          table: "releases",
          docId: release._id,
          field: "publisherId",
          before: loser._id,
          after: survivor._id,
        });
      }
    }
    for (const release of straysLeft) {
      await ctx.db.patch(release._id, { publisherId: survivor._id });
      repointed.push({
        table: "releases",
        docId: release._id,
        field: "publisherId",
        before: loser._id,
        after: survivor._id,
      });
    }
    await ctx.db.insert("mergeManifests", {
      loserRef: { type: "publisher", id: loser._id },
      survivorRef: { type: "publisher", id: survivor._id },
      proposalId,
      repointed,
      removed: [],
      inserted: [],
    });
    audit.op({
      kind: "update",
      ref: { type: "publisher", id: loser._id },
      changes: [{ field: "editionsRepointed", after: editions.length }],
    });
    return {
      status: "partial",
      reason: `repointed ${editions.length} editions, ${repointed.length - editions.length} releases`,
    };
  }
  await merge(
    ctx,
    audit,
    { type: "publisher", id: survivor._id },
    { type: "publisher", id: loser._id },
  );
  return applied;
}

async function publisherBySlug(ctx: MutationCtx, slug: string) {
  let row = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  for (let hops = 0; row && row.status === "merged" && row.mergedIntoId && hops < 5; hops++) {
    row = await ctx.db.get(row.mergedIntoId);
  }
  return row && row.status === "active" ? row : null;
}

async function publisherParent(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"publisherParent">,
): Promise<Result> {
  const publisher = await ctx.db.get(entry.publisherId);
  if (!publisher || publisher.status !== "active") return skip("publisher not active");
  const parentSlug = IMPRINT_PARENTS[publisher.slug];
  if (parentSlug === undefined) return { status: "noop", reason: "not an imprint" };
  const parent = await publisherBySlug(ctx, parentSlug);
  if (!parent) return skip(`parent ${parentSlug} has no active row`);
  if (publisher.parentPublisherId === parent._id) return already;
  if (publisher.parentPublisherId !== undefined) skip("already linked to another parent");
  await updateRecord(ctx, audit, { type: "publisher", id: publisher._id }, publisher, {
    parentPublisherId: parent._id,
  });
  return applied;
}

/** The company a publisher row stands for (a duplicate row resolves to its survivor). */
function companySlug(slug: string): string {
  return DUPLICATE_SLUGS[slug] ?? slug;
}

/**
 * PRH's prose imprint shares Vertical's name; the PRH importer keeps it out of
 * scope (lib/prh.ts DENIED_IMPRINTS), so it is never manga imprint evidence.
 */
const PRH_PROSE_IMPRINT = /^\s*vertical\s*$/i;

type EditionMove = Pick<
  EntryOf<"editionPublisher">,
  "observationIds" | "otherReleases" | "expectedReleaseIds"
>;

/**
 * The plan's publisher rows for a move. With `imprint`, `to` must be exactly
 * that known imprint's row and name `from`'s company as its parent, in the
 * catalog as in lib/publishers.ts.
 */
async function movePublishers(
  ctx: MutationCtx,
  fromId: Id<"publishers">,
  toId: Id<"publishers">,
  imprint: string | null,
) {
  const from = await ctx.db.get(fromId);
  const to = await ctx.db.get(toId);
  if (!from || !to || to.status !== "active") return skip("publisher rows missing");
  if (imprint === null) return { from, to };
  // Owner rule: PRH's imprint outranks Seven Seas/OpenLibrary attribution
  // to the parent, but only toward a known imprint of the same company.
  if (PRH_PROSE_IMPRINT.test(imprint)) skip(`"${imprint}" is PRH's prose imprint`);
  const resolved = canonicalPublisherFor(imprint);
  if (!resolved || resolved.parentSlug === undefined) skip(`"${imprint}" is not a known imprint`);
  if (companySlug(resolved!.slug) !== to.slug)
    skip(`"${imprint}" resolves to ${resolved!.slug}, not ${to.slug}`);
  if (resolved!.parentSlug !== companySlug(from.slug)) {
    skip(`${resolved!.slug} is not an imprint of ${companySlug(from.slug)}`);
  }
  const parent = to.parentPublisherId ? await ctx.db.get(to.parentPublisherId) : null;
  if (!parent || companySlug(parent.slug) !== companySlug(from.slug))
    skip(`${to.slug} does not name ${companySlug(from.slug)} as its parent`);
  return { from, to };
}

/** Skip unless a record's publisher row is the company the plan expected to move it from. */
async function expectOnCompany(
  ctx: MutationCtx,
  what: string,
  publisherId: Id<"publishers">,
  from: Doc<"publishers">,
) {
  const current = await ctx.db.get(publisherId);
  if (!current) return skip(`${what}'s publisher row is missing`);
  if (companySlug(current.slug) !== companySlug(from.slug))
    skip(`${what} is on ${current.slug}, plan expected ${from.slug}`);
}

/**
 * The Edition's Releases, any status (refreshReleaseDenorms rewrites them
 * all), when they are exactly `expected`. Read in the same transaction as the
 * write, so an added, removed or moved Release refuses.
 */
async function expectReleaseClosure(
  ctx: MutationCtx,
  editionId: Id<"editions">,
  expected: Id<"releases">[] | undefined,
) {
  if (expected === undefined)
    return skip("expectedReleaseIds is required to move an Edition's publisher");
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length) skip("expectedReleaseIds lists a Release twice");
  const releases = await releasesOf(ctx, editionId);
  const actual = new Set(releases.map((release) => release._id));
  const added = [...actual].filter((id) => !expectedSet.has(id));
  const missing = expected.filter((id) => !actual.has(id));
  if (added.length > 0 || missing.length > 0) {
    skip(
      `edition releases drifted: unexpected [${added.join(", ")}], missing [${missing.join(", ")}]`,
    );
  }
  return releases;
}

/** The Releases among `releases` that one of `observationIds` is linked to (legacy evidence). */
async function linkedReleases(
  ctx: MutationCtx,
  releases: Doc<"releases">[],
  observationIds: Id<"sourceObservations">[],
) {
  const ids = new Set(releases.map((release) => release._id));
  const evidenced = new Set<Id<"releases">>();
  for (const observationId of observationIds) {
    const ref = (await ctx.db.get(observationId))?.recordRef;
    if (ref?.type === "release" && ids.has(ref.id)) evidenced.add(ref.id);
  }
  return evidenced;
}

/**
 * The Releases an imprint move's observations evidence. Each must be PRH's
 * own record of a Release in `releases`: linked to it, not withdrawn, not
 * the record of an Other Printing, with its record ID, snapshot ISBN and the
 * Release's ISBN all one ISBN, stating exactly `imprint`. Any other
 * observation refuses the entry rather than being ignored.
 */
async function imprintEvidence(
  ctx: MutationCtx,
  releases: Doc<"releases">[],
  observationIds: Id<"sourceObservations">[],
  imprint: string,
) {
  if (observationIds.length === 0) skip("an imprint move needs PRH evidence");
  const byId = new Map(releases.map((release) => [release._id as string, release]));
  const evidenced = new Set<Id<"releases">>();
  for (const observationId of new Set(observationIds)) {
    const observation = await ctx.db.get(observationId);
    if (!observation) return skip(`observation ${observationId} is missing`);
    const ref = observation.recordRef;
    const release = ref?.type === "release" ? byId.get(ref.id) : undefined;
    const snapshot: { isbn13?: unknown; imprint?: unknown } = observation.snapshot ?? {};
    const refusal =
      observation.sourceKey !== "prh"
        ? `is a ${observation.sourceKey} record, not PRH's`
        : release === undefined
          ? "is not linked to a Release of the Edition"
          : observation.withdrawn
            ? "is withdrawn"
            : observation.printingIsbn13 !== undefined
              ? `records Other Printing ${observation.printingIsbn13}`
              : release.isbn13 === undefined ||
                  observation.sourceRecordId !== release.isbn13 ||
                  snapshot.isbn13 !== release.isbn13
                ? `is not the Release's own ISBN record (${observation.sourceRecordId}, release ${release.isbn13 ?? "no ISBN"})`
                : snapshot.imprint !== imprint
                  ? `states ${JSON.stringify(snapshot.imprint)}, not "${imprint}"`
                  : null;
    if (refusal !== null) skip(`observation ${observationId} ${refusal}`);
    evidenced.add(release!._id);
  }
  return evidenced;
}

/**
 * Refuse when PRH's own record of any Release's ISBN states an imprint that
 * is not `imprint` and does not resolve to `to`, linked or not: the move
 * would contradict the publisher's own statement for that book.
 */
async function expectNoContraryImprint(
  ctx: MutationCtx,
  releases: Doc<"releases">[],
  imprint: string,
  to: Doc<"publishers">,
) {
  for (const release of releases) {
    if (release.isbn13 === undefined) continue;
    const observation = await getObservation(ctx, "prh", release.isbn13);
    if (!observation || observation.withdrawn) continue;
    const stated: unknown = observation.snapshot?.imprint;
    if (typeof stated !== "string" || stated === imprint) continue;
    const resolved = canonicalPublisherFor(stated);
    if (resolved && companySlug(resolved.slug) === to.slug) continue;
    skip(`PRH states "${stated}" for ${release.isbn13}, not ${to.slug}`);
  }
}

/**
 * Everything a whole-Edition publisher move must hold before it writes,
 * shared by editionPublisher and editionLinePublisher: the Edition unlocked
 * with no publisher Human Override, its exact Release closure and evidence
 * count, no contrary PRH imprint, no Release in another publisher's Bundle,
 * and no Other Printing or Alternate Ebook ISBN rows (their publisher would
 * move with no evidence for them).
 */
async function expectEditionMove(
  ctx: MutationCtx,
  edition: Doc<"editions">,
  move: EditionMove,
  to: Doc<"publishers">,
  imprint: string | null,
) {
  if (edition.locked) skip(`edition ${edition.publicId} is locked`);
  if ((edition.overriddenFields ?? []).includes("publisherId"))
    skip(`edition ${edition.publicId} has a publisher override`);
  const releases = await expectReleaseClosure(ctx, edition._id, move.expectedReleaseIds);
  const evidenced =
    imprint === null
      ? await linkedReleases(ctx, releases, move.observationIds)
      : await imprintEvidence(ctx, releases, move.observationIds, imprint);
  const others = releases.length - evidenced.size;
  if (others !== move.otherReleases)
    skip(
      `edition ${edition.publicId} has ${others} releases without evidence, plan expected ${move.otherReleases}`,
    );
  if (imprint !== null) await expectNoContraryImprint(ctx, releases, imprint, to);
  for (const release of releases) {
    const printing = await ctx.db
      .query("releaseIsbns")
      .withIndex("by_release", (q) => q.eq("releaseId", release._id))
      .first();
    if (printing) skip(`release ${release._id} has other ISBN ${printing.isbn13}`);
    const memberships = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_release", (q) => q.eq("releaseId", release._id))
      .collect();
    for (const membership of memberships) {
      const bundle = await ctx.db.get(membership.bundleId);
      if (bundle && bundle.publisherId !== to._id)
        skip(`release ${release._id} is in bundle ${bundle.publicId} of another publisher`);
    }
  }
}

/** Write a checked move: the Edition's publisher with its Revision, then its Releases' denorm. */
async function moveEdition(
  ctx: MutationCtx,
  audit: Audit,
  edition: Doc<"editions">,
  to: Doc<"publishers">,
) {
  await updateRecord(ctx, audit, { type: "edition", id: edition._id }, edition, {
    publisherId: to._id,
  });
  await refreshReleaseDenorms(ctx, edition._id);
}

async function editionPublisher(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"editionPublisher">,
): Promise<Result> {
  const edition = await ctx.db.get(entry.editionId);
  if (!edition || edition.status !== "active") return skip("edition not active");
  if (edition.publisherId === entry.toPublisherId) return already;
  const { from, to } = await movePublishers(
    ctx,
    entry.fromPublisherId,
    entry.toPublisherId,
    entry.imprint,
  );
  await expectOnCompany(ctx, "edition", edition.publisherId, from);
  await expectEditionMove(ctx, edition, entry, to, entry.imprint);
  if (edition.editionLineId) {
    const line = await ctx.db.get(edition.editionLineId);
    if (line && line.publisherId !== to._id)
      skip("edition sits in another publisher's edition line");
  }
  await moveEdition(ctx, audit, edition, to);
  return applied;
}

/**
 * Move an Edition Line and its members to an imprint in one transaction
 * (entries.ts editionLinePublisherEntry). Every non-merged member is read:
 * an active one the entry omits, a hidden one not already on `to`, or a
 * listed Edition outside the line refuses; merged members are tombstones.
 */
async function editionLinePublisher(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"editionLinePublisher">,
): Promise<Result> {
  const line = await ctx.db.get(entry.lineId);
  if (!line || line.status !== "active") return skip("edition line not active");
  const listed = new Map(entry.editions.map((move) => [move.editionId as string, move]));
  if (listed.size !== entry.editions.length) skip("the entry lists an Edition twice");
  const members = await ctx.db
    .query("editions")
    .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
    .collect();
  const byId = new Map(members.map((member) => [member._id as string, member]));
  for (const member of members) {
    if (member.status === "merged" || listed.has(member._id)) continue;
    if (member.status === "active")
      skip(`active line member edition ${member.publicId} is not in the entry`);
    if (member.publisherId !== entry.toPublisherId)
      skip(`hidden line member edition ${member.publicId} is on another publisher`);
  }
  for (const id of listed.keys()) {
    const member = byId.get(id);
    if (!member) skip(`edition ${id} is not in line "${line.name}"`);
    if (member!.status !== "active") skip(`edition ${member!.publicId} is not active`);
  }
  const moving = entry.editions.flatMap((move) => {
    const edition = byId.get(move.editionId)!;
    return edition.publisherId === entry.toPublisherId ? [] : [{ edition, move }];
  });
  // Members already on `to` are not re-checked, so their Releases' denorm
  // must already agree, or the rerun would report alreadyApplied over it.
  for (const member of members) {
    if (member.status === "merged" || member.publisherId !== entry.toPublisherId) continue;
    const stale = (await releasesOf(ctx, member._id)).find(
      (release) => release.publisherId !== member.publisherId,
    );
    if (stale)
      skip(`line member edition ${member.publicId} has release ${stale._id} on another publisher`);
  }
  if (moving.length === 0) {
    if (line.publisherId === entry.toPublisherId) return already;
    // Only a moving member's PRH evidence is checked; none means nothing evidences the line.
    skip(`no listed member of line "${line.name}" moves, so nothing evidences the line's move`);
  }

  const { from, to } = await movePublishers(
    ctx,
    entry.fromPublisherId,
    entry.toPublisherId,
    entry.imprint,
  );
  if (line.locked) skip(`edition line "${line.name}" is locked`);
  if ((line.overriddenFields ?? []).includes("publisherId"))
    skip(`edition line "${line.name}" has a publisher override`);
  if (line.publisherId !== to._id)
    await expectOnCompany(ctx, "edition line", line.publisherId, from);
  for (const { edition, move } of moving) {
    await expectOnCompany(ctx, `edition ${edition.publicId}`, edition.publisherId, from);
    await expectEditionMove(ctx, edition, move, to, entry.imprint);
  }

  if (line.publisherId !== to._id) {
    await audit.meta();
    await ctx.db.patch(line._id, { publisherId: to._id });
    const ref = { type: "editionLine" as const, id: line._id };
    const changes = [{ field: "publisherId", before: line.publisherId, after: to._id }];
    audit.op({ kind: "update", ref, changes });
    await audit.revise(ref, changes);
  }
  for (const { edition } of moving) await moveEdition(ctx, audit, edition, to);
  return applied;
}

// ---------- stage 2: scope ----------

async function hideSeries(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"hideSeries">,
): Promise<Result> {
  const series = await ctx.db.get(entry.seriesId);
  if (!series) return skip("series missing");
  if (series.status === "merged") skip("series was merged");

  // The cascade must still be exactly what the plan saw: new volumes,
  // editions, or releases under the series mean it gained content.
  const volumeIds = new Set<string>(entry.volumeIds);
  const editionIds = new Set<string>(entry.editionIds);
  const releaseIds = new Set<string>(entry.releaseIds);
  for (const volume of await activeVolumes(ctx, series._id)) {
    if (!volumeIds.has(volume._id)) skip(`volume ${volume.publicId} is not in the plan`);
  }
  const volumes = [];
  for (const id of entry.volumeIds) {
    const volume = await ctx.db.get(id);
    if (!volume || volume.seriesId !== series._id) skip(`volume ${id} left the series`);
    volumes.push(volume!);
    for (const edition of await activeEditionsCovering(ctx, id)) {
      if (!editionIds.has(edition._id)) skip(`edition ${edition.publicId} is not in the plan`);
    }
  }
  const editions = [];
  for (const id of entry.editionIds) {
    const edition = await ctx.db.get(id);
    if (!edition) skip(`edition ${id} missing`);
    editions.push(edition!);
    for (const release of await releasesOf(ctx, id)) {
      if (release.status === "active" && !releaseIds.has(release._id))
        skip("edition gained a release");
    }
  }
  const releases = [];
  for (const id of entry.releaseIds) {
    const release = await ctx.db.get(id);
    if (!release || !editionIds.has(release.editionId)) skip(`release ${id} moved`);
    releases.push(release!);
  }

  let changed = false;
  for (const release of releases)
    changed = (await hide(ctx, audit, { type: "release", id: release._id }, release)) || changed;
  for (const edition of editions)
    changed = (await hide(ctx, audit, { type: "edition", id: edition._id }, edition)) || changed;
  for (const volume of volumes)
    changed = (await hide(ctx, audit, { type: "volume", id: volume._id }, volume)) || changed;
  changed = (await hide(ctx, audit, { type: "series", id: series._id }, series)) || changed;
  return changed ? applied : already;
}

async function hideRelease(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"hideRelease">,
): Promise<Result> {
  const release = await ctx.db.get(entry.releaseId);
  if (!release) return skip("release missing");
  if (release.status === "merged") skip("release was merged");
  if (entry.editionId !== null && release.editionId !== entry.editionId)
    skip("release moved to another edition");
  let changed = await hide(ctx, audit, { type: "release", id: release._id }, release);

  // The Edition and Volumes follow only once nothing active is left under
  // them, so entries sharing an Edition converge in any order.
  if (entry.editionId !== null) {
    const edition = await ctx.db.get(entry.editionId);
    const liveReleases = (await releasesOf(ctx, entry.editionId)).filter(
      (r) => r.status === "active",
    );
    if (edition && liveReleases.length === 0) {
      changed = (await hide(ctx, audit, { type: "edition", id: edition._id }, edition)) || changed;
    } else if (edition?.status === "active") {
      audit.note("edition kept: other releases still active");
    }
  }
  for (const volumeId of entry.volumeIds) {
    const volume = await ctx.db.get(volumeId);
    if (!volume) continue;
    if ((await activeEditionsCovering(ctx, volumeId)).length === 0) {
      changed = (await hide(ctx, audit, { type: "volume", id: volume._id }, volume)) || changed;
    } else if (volume.status === "active") {
      audit.note(`volume ${volume.publicId} kept: still covered by an active edition`);
    }
  }
  return changed ? applied : already;
}

/**
 * Undo a scope hide: the target plus the cascade the hide took down come
 * back top-down (Series, Volumes, Editions, Releases). Rows the importers or
 * a Moderator changed since (merged, missing, locked, moved under a record
 * that stays hidden) are drift; an already-active row is a no-op, so a
 * re-run reports alreadyApplied.
 */
async function restoreRecord(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"restoreRecord">,
): Promise<Result> {
  const { target } = entry;
  const unique = <T>(list: T[]) => [...new Set(list)];
  const seriesIds = target.type === "series" ? [target.id] : [];
  const volumeIds = unique(
    target.type === "volume" ? [target.id, ...entry.volumeIds] : entry.volumeIds,
  );
  const editionIds = unique(
    target.type === "edition" ? [target.id, ...entry.editionIds] : entry.editionIds,
  );
  const releaseIds = unique(
    target.type === "release" ? [target.id, ...entry.releaseIds] : entry.releaseIds,
  );

  const usable = <D extends { status: string }>(label: string, doc: D | null): D => {
    if (!doc) return skip(`${label} missing`);
    if (doc.status === "merged") skip(`${label} was merged`);
    if (doc.status !== "hidden" && doc.status !== "active") skip(`${label} is ${doc.status}`);
    return doc;
  };
  const series = [];
  for (const id of seriesIds) series.push(usable(`series ${id}`, await ctx.db.get(id)));
  const volumes = [];
  for (const id of volumeIds) volumes.push(usable(`volume ${id}`, await ctx.db.get(id)));
  const editions = [];
  for (const id of editionIds) editions.push(usable(`edition ${id}`, await ctx.db.get(id)));
  const releases = [];
  for (const id of releaseIds) releases.push(usable(`release ${id}`, await ctx.db.get(id)));

  // Every restored row's parent must be active afterwards: restored by this
  // entry, or active already. Anything else means the row moved since.
  const restoring = new Set<string>([...seriesIds, ...volumeIds, ...editionIds, ...releaseIds]);
  const liveAfter = async (id: Id<"series"> | Id<"volumes"> | Id<"editions">) =>
    restoring.has(id) || (await ctx.db.get(id))?.status === "active";
  for (const volume of volumes) {
    if (target.type === "series" && volume.seriesId !== target.id)
      skip(`volume ${volume.publicId} left the series`);
    if (!(await liveAfter(volume.seriesId)))
      skip(`volume ${volume.publicId}'s series stays hidden`);
  }
  for (const edition of editions) {
    const coverage = await coverageOf(ctx, edition._id);
    if (coverage.length === 0) skip(`edition ${edition.publicId} covers no volume`);
    for (const cover of coverage) {
      if (!(await liveAfter(cover.volumeId)))
        skip(`edition ${edition.publicId} covers a volume that stays hidden`);
      const volume = await ctx.db.get(cover.volumeId);
      if (volume && !(await liveAfter(volume.seriesId)))
        skip(`edition ${edition.publicId}'s series stays hidden`);
    }
  }
  for (const release of releases) {
    if (!(await liveAfter(release.editionId)))
      skip(`release ${release._id} sits on an edition that stays hidden`);
  }

  let changed = false;
  for (const doc of series)
    changed = (await restore(ctx, audit, { type: "series", id: doc._id }, doc)) || changed;
  for (const doc of volumes)
    changed = (await restore(ctx, audit, { type: "volume", id: doc._id }, doc)) || changed;
  for (const doc of editions)
    changed = (await restore(ctx, audit, { type: "edition", id: doc._id }, doc)) || changed;
  for (const doc of releases)
    changed = (await restore(ctx, audit, { type: "release", id: doc._id }, doc)) || changed;
  return changed ? applied : already;
}

async function unlinkObservation(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"unlinkObservation">,
): Promise<Result> {
  const observation = await ctx.db.get(entry.observationId);
  if (!observation) return skip("observation missing");
  const ref = observation.recordRef;
  if (!ref) {
    // An Other Printing's mark (`printingIsbn13`) belongs to a link; one
    // left on an unlinked record is cleared, and nothing else changes.
    if (observation.printingIsbn13 === undefined) return already;
    await ctx.db.patch(observation._id, { printingIsbn13: undefined });
    audit.note(`cleared printing mark ${observation.printingIsbn13} of an unlinked observation`);
    return applied;
  }
  if (ref.type !== entry.recordType || ref.id !== entry.recordId) {
    return skip(`observation now links ${ref.type} ${ref.id}`);
  }
  await audit.meta();
  // The printing mark goes with the link (lib/observations.ts linkObservation).
  await ctx.db.patch(observation._id, { recordRef: undefined, printingIsbn13: undefined });
  const source = `${observation.sourceKey} ${observation.sourceRecordId}`;
  audit.op({ kind: "update", ref, changes: [{ field: "sourceObservation", before: source }] });
  await audit.revise(ref, [{ field: "sourceObservation", before: source }]);
  return applied;
}

// ---------- stage 3: series merges ----------

/** Follow a Volume's merge pointers to the active Volume it now lives on. */
async function liveVolume(ctx: MutationCtx, id: Id<"volumes"> | null) {
  let volume = id ? await ctx.db.get(id) : null;
  for (
    let hops = 0;
    volume && volume.status === "merged" && volume.mergedIntoId && hops < 5;
    hops++
  ) {
    volume = await ctx.db.get(volume.mergedIntoId);
  }
  return volume && volume.status === "active" ? volume : null;
}

/** Sources that are authoritative for titles and would rename a Series back. */
const TITLE_AUTHORITIES = new Set(["kodansha", "sevenseas"]);

/**
 * Put `title` on the Series' sticky Human Override list when a linked
 * authoritative source still names it differently (e.g. a Kodansha
 * "Initial D Omnibus" series page now linked to "Initial D").
 */
async function lockTitleIfContested(ctx: MutationCtx, audit: Audit, seriesId: Id<"series">) {
  const series = await ctx.db.get(seriesId);
  if (!series || series.status !== "active") return;
  if ((series.overriddenFields ?? []).includes("title")) return;
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", "series").eq("recordRef.id", seriesId))
    .collect();
  const contested = observations.some((observation) => {
    const snapshot: { title?: unknown } = observation.snapshot ?? {};
    return (
      TITLE_AUTHORITIES.has(observation.sourceKey) &&
      typeof snapshot.title === "string" &&
      snapshot.title !== series.title
    );
  });
  if (!contested) return;
  await updateRecord(ctx, audit, { type: "series", id: seriesId }, series, {
    overriddenFields: [...(series.overriddenFields ?? []), "title"].sort(),
  });
}

async function retitleSeries(
  ctx: MutationCtx,
  audit: Audit,
  seriesId: Id<"series">,
  title: string,
) {
  const series = await ctx.db.get(seriesId);
  if (!series || series.title === title) return;
  await updateRecord(ctx, audit, { type: "series", id: seriesId }, series, {
    title,
    searchText: seriesSearchText(title, series.altTitles),
  });
}

/** Active loser Volumes that no plan row places and that nothing active covers. */
async function orphanVolumes(ctx: MutationCtx, volumes: Doc<"volumes">[], planned: Set<string>) {
  const orphans = [];
  for (const volume of volumes) {
    if (planned.has(volume._id)) continue;
    if ((await activeEditionsCovering(ctx, volume._id)).length > 0) {
      skip(`loser volume ${volume.publicId} is not in the plan and still has editions`);
    }
    orphans.push(volume);
  }
  return orphans;
}

async function mergeSeries(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"mergeSeries">,
): Promise<Result> {
  const loser = await ctx.db.get(entry.loserId);
  const survivor = await ctx.db.get(entry.survivorId);
  if (!loser || !survivor) return skip("series missing");
  if (loser.status === "merged") {
    if (loser.mergedIntoId !== survivor._id) skip("loser merged elsewhere");
    if (entry.retitle) await retitleSeries(ctx, audit, survivor._id, entry.retitle);
    return audit.wrote ? applied : already;
  }
  if (loser.status !== "active") skip("loser is hidden");
  if (survivor.status !== "active") skip(`survivor is ${survivor.status}`);
  if (loser.locked || survivor.locked) skip("series locked");

  const loserVolumes = await activeVolumes(ctx, loser._id);
  const planned = new Set<string>([
    ...entry.placements.map((p) => p.volumeId),
    ...entry.packagingVolumeIds,
  ]);
  const orphans = await orphanVolumes(ctx, loserVolumes, planned);

  // A placement an earlier leg made still re-files what that leg left
  // (followVolume); the Series merge waits until nothing is left.
  const moves = newMoves(entry.key);
  for (const placement of entry.placements) {
    const volume = await ctx.db.get(placement.volumeId);
    if (!volume) skip(`volume ${placement.volumeId} missing`);
    if (volume!.status === "merged") {
      const home = await liveVolume(ctx, volume!._id);
      if (home?.seriesId !== survivor._id)
        skip(`volume ${volume!.publicId} merged outside the survivor`);
      await followVolume(ctx, audit, moves, home!);
      continue;
    }
    if (volume!.status !== "active") continue; // hidden since planning: nothing to place
    if (volume!.seriesId === survivor._id) {
      await followVolume(ctx, audit, moves, volume!);
      continue;
    }
    if (volume!.seriesId !== loser._id) skip(`volume ${volume!.publicId} left the loser`);
    await placeVolume(ctx, audit, moves, volume!, survivor._id, placement);
  }
  await closeMoves(ctx, audit, { type: "series", id: loser._id }, moves);
  if (moves.unfinished) return partial;
  for (const orphan of orphans) {
    await hide(ctx, audit, { type: "volume", id: orphan._id }, orphan);
    audit.note(`hid orphan volume ${orphan.publicId} (no active edition)`);
  }

  const waiting = [];
  for (const id of entry.packagingVolumeIds) {
    const volume = await ctx.db.get(id);
    if (volume && volume.status === "active" && volume.seriesId === loser._id) waiting.push(volume);
  }
  if (entry.retitle) await retitleSeries(ctx, audit, survivor._id, entry.retitle);
  await settlePositions(ctx, audit, survivor._id);
  if (waiting.length > 0) {
    await lockTitleIfContested(ctx, audit, survivor._id);
    return { status: "deferred", reason: `${waiting.length} packaging volume(s) await stage 4` };
  }

  await merge(ctx, audit, { type: "series", id: survivor._id }, { type: "series", id: loser._id });
  await lockTitleIfContested(ctx, audit, survivor._id);
  await settlePositions(ctx, audit, survivor._id);
  return applied;
}

/**
 * Place one loser Volume in the survivor: merge it into the survivor's
 * Volume the plan names (or the one with the same label; the Volume merge
 * files the passes on its Editions itself, in the manifest Split reverses,
 * and followVolume only heals rows an earlier run left), else move it across
 * with its label, at position = its number, carrying its trackers'
 * Tracking Visibility and re-filing their rows (carryingTracking; the
 * Series merge that follows may wait for stage 4).
 */
async function placeVolume(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  volume: Doc<"volumes">,
  survivorId: Id<"series">,
  placement: { label: string | null; intoVolumeId: Id<"volumes"> | null },
) {
  const survivorVolumes = await activeVolumes(ctx, survivorId);
  let target = await liveVolume(ctx, placement.intoVolumeId);
  if (target && target.seriesId !== survivorId) target = null;
  if (!target && placement.label !== null) {
    const matches = survivorVolumes.filter((v) => sameLabel(v.label, placement.label));
    if (matches.length > 1)
      skip(`survivor has ${matches.length} volumes labelled "${placement.label}"`);
    target = matches[0] ?? null;
  }
  if (target) {
    if (target.locked || volume.locked) skip("volume locked");
    await merge(ctx, audit, { type: "volume", id: target._id }, { type: "volume", id: volume._id });
    await followVolume(ctx, audit, moves, target);
    return;
  }
  const label = canonicalLabel(placement.label);
  const maxPosition = survivorVolumes.reduce((max, v) => Math.max(max, v.position), 0);
  const coverage = await coveringOf(ctx, volume._id);
  const editionIds = new Set(coverage.map((row) => row.editionId));
  await carryingTracking(ctx, audit, moves, { volumeIds: [volume._id], editionIds }, async () => {
    await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
      seriesId: survivorId,
      label: label ?? undefined,
      position: labelNumber(label) ?? maxPosition + 1,
    });
    for (const editionId of editionIds) await refreshReleaseDenorms(ctx, editionId);
  });
}

// ---------- stage 4: packaging ----------

async function findOrCreateLine(
  ctx: MutationCtx,
  audit: Audit,
  seriesId: Id<"series">,
  publisherId: Id<"publishers">,
  name: string,
): Promise<Id<"editionLines">> {
  const lines = await ctx.db
    .query("editionLines")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const existing = lines.find(
    (line) => line.status === "active" && line.publisherId === publisherId && line.name === name,
  );
  if (existing) return existing._id;
  await audit.meta();
  const fields = {
    status: "active" as const,
    seriesId,
    publisherId,
    name,
    bootstrapUnreviewed: true,
  };
  const id = await ctx.db.insert("editionLines", fields);
  audit.op({ kind: "create", table: "editionLines", tempId: id, fields });
  await audit.revise(
    { type: "editionLine", id },
    Object.entries(fields).map(([field, after]) => ({ field, after })),
  );
  return id;
}

/**
 * Pick the member Release a box set holds for one Volume: an active
 * same-company, same-format Release of a single-Volume Edition outside any
 * line, earliest first.
 */
async function memberReleaseFor(
  ctx: MutationCtx,
  volumeId: Id<"volumes">,
  publishers: Set<Id<"publishers">>,
  format: Doc<"releases">["format"],
) {
  const candidates: Doc<"releases">[] = [];
  for (const edition of await activeEditionsCovering(ctx, volumeId)) {
    if (!publishers.has(edition.publisherId) || edition.editionLineId) continue;
    const coverage = await coverageOf(ctx, edition._id);
    if (edition.coverageUnmapped || coverage.length !== 1 || coverage[0]!.extent !== "complete")
      continue;
    for (const release of await releasesOf(ctx, edition._id)) {
      if (release.status === "active" && release.format === format) candidates.push(release);
    }
  }
  if (candidates.length > 1)
    skip("Box member has multiple eligible Releases; name exact members in releaseBundle.");
  return candidates[0] ?? null;
}

async function remodelEdition(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"remodelEdition">,
): Promise<Result> {
  if (entry.groups.some((group) => group.into)) return await moveIntoExisting(ctx, audit, entry);
  const edition = await ctx.db.get(entry.editionId);
  const target = await ctx.db.get(entry.targetSeriesId);
  if (!edition) return skip("edition missing");
  if (!target || target.status !== "active") return skip("target series not active");
  if (edition.locked) skip("edition locked");
  if (entry.bundle !== null) return await toBundle(ctx, audit, entry, edition, entry.bundle.name);
  if (edition.status !== "active") return skip(`edition is ${edition.status}`);

  // Either the Edition still covers the planned Volume, or an earlier run
  // already re-modelled it (then every step below is a no-op).
  const coverage = await coverageOf(ctx, edition._id);
  const onPlanned = coverage.some((row) => row.volumeId === entry.volumeId);
  if (!onPlanned) {
    const labels: Array<string | null> = [];
    for (const row of coverage) labels.push((await ctx.db.get(row.volumeId))?.label ?? null);
    const expected = entry.groups[0]?.coverage ?? [];
    const done =
      expected.length > 0 &&
      coverage.length === expected.length &&
      coverage.every((row, i) =>
        expected[i]?.volumeId
          ? row.volumeId === expected[i]?.volumeId
          : sameLabel(labels[i], expected[i]?.label),
      );
    if (!done) skip("edition no longer covers the planned volume");
  }

  const placeInLine = async (id: Id<"editions">, position: string | null) => {
    if (!entry.line) return;
    const doc = await ctx.db.get(id);
    if (!doc) return;
    const lineId = await findOrCreateLine(ctx, audit, target._id, doc.publisherId, entry.line.name);
    await updateRecord(ctx, audit, { type: "edition", id }, doc, {
      editionLineId: lineId,
      linePosition: position ?? entry.line.position ?? doc.linePosition,
    });
  };

  // Group 0 stays on this Edition; each further group's Releases move to a
  // new Edition of the same publisher with its own coverage. A group without
  // coverage keeps what it has (releases the research could not place).
  // Their trackers keep their Tracking Visibility and their rows follow
  // (carryingTracking), also on a re-run over an Edition an earlier run
  // created.
  const moves = newMoves(entry.key);
  const editionIds = new Set([edition._id]);
  for (const group of entry.groups.slice(1)) {
    for (const id of group.releaseIds ?? []) {
      const release = await ctx.db.get(id);
      if (release) editionIds.add(release.editionId);
    }
  }
  await carryingTracking(ctx, audit, moves, { editionIds }, async () => {
    for (const [i, group] of entry.groups.entries()) {
      let editionId = edition._id;
      if (i > 0) {
        const releases = [];
        for (const id of group.releaseIds ?? []) {
          const release = await ctx.db.get(id);
          if (!release || release.status !== "active") skip(`release ${id} not active`);
          releases.push(release!);
        }
        const moved = releases.find((r) => r.editionId !== edition._id);
        if (moved) {
          editionId = moved.editionId; // created by an earlier run
        } else if (releases.length > 0) {
          editionId = await createEdition(ctx, audit, {
            status: "active",
            publisherId: edition.publisherId,
            bootstrapUnreviewed: true,
          });
          for (const release of releases) {
            await updateRecord(ctx, audit, { type: "release", id: release._id }, release, {
              editionId,
            });
          }
        } else continue;
      }
      const rows = [];
      for (const cover of group.coverage) {
        rows.push({
          volumeId: (await coveredVolume(ctx, audit, target._id, cover))._id,
          extent: cover.extent,
        });
      }
      if (rows.length > 0) await replaceCoverage(ctx, audit, editionId, rows);
      await placeInLine(editionId, group.linePosition);
      await refreshReleaseDenorms(ctx, editionId);
    }
    if (entry.groups.length === 0) {
      await placeInLine(edition._id, null);
      audit.note("coverage left for review");
    }
  });
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  if (moves.unfinished) return partial;

  const first = entry.groups.find((g) => g.coverage.length > 0)?.coverage[0];
  const firstVolume = first ? await coveredVolume(ctx, audit, target._id, first) : null;
  await retireVolumes(ctx, audit, entry.retireVolumeIds, firstVolume?._id ?? null);
  await settlePositions(ctx, audit, target._id);
  return audit.wrote ? applied : already;
}

type Into = NonNullable<EntryOf<"remodelEdition">["groups"][number]["into"]>;

/**
 * A remodel whose later groups name `into` (entries.ts): move exactly those
 * Releases off the Edition into existing, empty Unmapped members of a line
 * of the target Series, and write nothing else. Group 0 stays as it is: it
 * restates the Edition's coverage by Volume id and names every Release that
 * stays. Every fact the move depends on is checked first, and any drift
 * refuses the whole entry, including on a re-run: no coverage, line,
 * position, Volume, Bundle or denorm is ever written or normalized, because
 * each Release must already carry the publisher and Series both Editions
 * derive. The one catalog write is each moving Release's `editionId`,
 * audited. It runs in carryingTracking like every repair move: no Series
 * changes, so no visibility is carried, but its follow sweeps still re-file
 * any personal row of these Editions that an earlier change left stale,
 * logged on the trail as always. Past SWEEP_BUDGET the move commits and
 * reports partial, and the next call, finding every Release moved, goes on
 * with the unfinished sweeps saved under the entry's key, moving nothing
 * again. That call checks the current catalog and that the saved sweep names
 * are exactly this move's; it cannot tell which call saved them, so equal
 * same-scope work under a reused key is finished too (docs/operations.md).
 * A re-run that finds every Release moved and no sweep saved returns
 * alreadyApplied before any write.
 */
async function moveIntoExisting(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"remodelEdition">,
): Promise<Result> {
  const [first, ...later] = entry.groups;
  if (!first || first.into) {
    return skip("group 0 stays on the edition; only a later group moves into another");
  }
  if (entry.line !== null || entry.bundle !== null || entry.retireVolumeIds.length > 0) {
    skip("a move into an existing edition changes no line, bundle or retired volume");
  }
  if (first.linePosition !== null) skip("group 0 states no line position");
  const staying = first.releaseIds ?? skip("group 0 names the releases that stay");
  const groups: Array<{ into: Into; releaseIds: Array<Id<"releases">> }> = [];
  for (const { into, coverage, linePosition, releaseIds } of later) {
    if (!into) return skip("every later group moves into an existing edition");
    if (coverage.length > 0 || linePosition !== null) {
      skip("a group moving into an existing edition states no coverage or line position");
    }
    if (!releaseIds?.length) {
      return skip("a group moving into an existing edition names its releases");
    }
    groups.push({ into, releaseIds });
  }
  const named = [...staying, ...groups.flatMap((group) => group.releaseIds)];
  for (const [i, id] of named.entries()) {
    if (named.indexOf(id) !== i) skip(`release ${id} is named twice`);
  }

  const edition = await ctx.db.get(entry.editionId);
  if (!edition) return skip("edition missing");
  if (edition.locked) skip("edition locked");
  if (edition.status !== "active") skip(`edition is ${edition.status}`);
  const series = await ctx.db.get(entry.targetSeriesId);
  if (!series || series.status !== "active" || series.locked)
    return skip("target series not active and unlocked");
  const publisher = await ctx.db.get(edition.publisherId);
  if (!publisher || publisher.status !== "active" || publisher.locked)
    return skip("publisher not active and unlocked");

  // Group 0's coverage is the Edition's, row for row, each an active Volume
  // of the target Series: so the Edition derives exactly that Series.
  const coverage = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
  if (coverage.length !== first.coverage.length) {
    skip("group 0 does not restate the edition's coverage");
  }
  for (const [i, row] of coverage.entries()) {
    const stated = first.coverage[i];
    const volume = await ctx.db.get(row.volumeId);
    if (
      stated?.volumeId !== row.volumeId ||
      stated.extent !== row.extent ||
      volume?.status !== "active" ||
      volume.locked ||
      volume.seriesId !== series._id ||
      (stated.label !== null && !sameLabel(volume.label, stated.label))
    ) {
      skip("group 0 does not restate the edition's coverage");
    }
  }
  if (!coverage.some((row) => row.volumeId === entry.volumeId)) {
    skip("edition no longer covers the planned volume");
  }
  const carries = (release: Doc<"releases">) =>
    release.publisherId === edition.publisherId && sameValue(release.seriesIds, [series._id]);

  const targets = new Set<Id<"editions">>();
  const moving: Array<{ release: Doc<"releases">; into: Id<"editions"> }> = [];
  for (const { into, releaseIds } of groups) {
    const target = await intoTarget(ctx, edition, series._id, into);
    if (targets.has(target._id)) skip(`two groups move into edition ${target.publicId}`);
    targets.add(target._id);
    for (const member of await releasesOf(ctx, target._id)) {
      if (!releaseIds.includes(member._id)) {
        skip(`edition ${target.publicId} holds release ${member._id} the move does not name`);
      }
    }
    const formats = new Set<Doc<"releases">["format"]>();
    for (const id of releaseIds) {
      const release = await ctx.db.get(id);
      if (!release || release.status !== "active") return skip(`release ${id} not active`);
      if (release.locked) skip(`release ${id} is locked`);
      if (release.editionId !== edition._id && release.editionId !== target._id) {
        skip(`release ${id} sits on another edition`);
      }
      if (!carries(release)) {
        skip(`release ${id} does not carry the edition's publisher and series`);
      }
      if (formats.has(release.format)) {
        skip(`edition ${target.publicId} would hold two active ${release.format} releases`);
      }
      formats.add(release.format);
      if (release.editionId === edition._id) moving.push({ release, into: target._id });
    }
  }
  // The Edition keeps exactly group 0's Releases, of any status.
  for (const release of await releasesOf(ctx, edition._id)) {
    if (moving.some((move) => move.release._id === release._id)) continue;
    if (!staying.includes(release._id)) {
      skip(`the edition holds release ${release._id} no group names`);
    }
    if (!carries(release)) {
      skip(`release ${release._id} does not carry the edition's publisher and series`);
    }
  }
  for (const id of staying) {
    if ((await ctx.db.get(id))?.editionId !== edition._id) {
      skip(`release ${id} of group 0 is not on the edition`);
    }
  }

  // Sweeps saved under this entry's key (closeMoves). A saved row holds only
  // the key, sweep name, cursor and done flag, not the kind, reason, args or
  // actor of the call that saved it. A leg of this move that saves sweeps has
  // also moved every Release, so a move still to make refuses any, and a
  // finished move with none saved is a no-op.
  const saved = await ctx.db
    .query("repairSweeps")
    .withIndex("by_entry_sweep", (q) => q.eq("entryKey", entry.key))
    .collect();
  if (moving.length > 0 && saved.length > 0) {
    skip("personal tracking saved under this entry's key belongs to no move it has made");
  }
  if (moving.length === 0) {
    if (saved.length === 0) return already;
    if (saved.every((row) => row.done)) skip("this entry's saved personal tracking is finished");
    audit.note("continues the personal tracking an earlier call left");
  }
  const moves = newMoves(entry.key);
  await carryingTracking(ctx, audit, moves, { editionIds: [edition._id, ...targets] }, async () => {
    for (const { release, into } of moving) {
      await updateRecord(ctx, audit, { type: "release", id: release._id }, release, {
        editionId: into,
      });
    }
  });
  // A continuation goes on only when the sweeps this move runs are exactly
  // the saved ones: one that would start another sweep, or leave a saved
  // one, is not this move's work, and refusing rolls the leg back. Equal
  // names prove the same Releases and Edition are in scope now, not that
  // this entry saved them; such work finishes as this call's audited
  // re-filing.
  const sweeps = (names: Iterable<string>) => [...names].sort();
  if (
    moving.length === 0 &&
    !sameValue(sweeps(moves.sweeps.keys()), sweeps(saved.map((row) => row.sweep)))
  ) {
    skip("this entry's saved personal tracking is not this move's");
  }
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  return moves.unfinished ? partial : applied;
}

/**
 * The Edition a group moves into, as the plan saw it: active and unlocked,
 * of `edition`'s publisher, at `linePosition` of the named active, unlocked
 * line of `seriesId` and that publisher, and empty and Unmapped (no
 * coverage, so it derives that Series from its line). The line is named by
 * id, never found by name, so none is created and none of another Series or
 * publisher is used.
 */
async function intoTarget(
  ctx: MutationCtx,
  edition: Doc<"editions">,
  seriesId: Id<"series">,
  into: Into,
): Promise<Doc<"editions">> {
  const target = await ctx.db.get(into.editionId);
  if (!target || target._id === edition._id) {
    return skip(`edition ${into.editionId} is not another existing edition`);
  }
  if (target.status !== "active") skip(`edition ${target.publicId} is ${target.status}`);
  if (target.locked) skip(`edition ${target.publicId} is locked`);
  if (target.publisherId !== edition.publisherId) {
    skip(`edition ${target.publicId} has another publisher`);
  }
  if (
    target.editionLineId !== into.editionLineId ||
    (target.linePosition ?? null) !== into.linePosition
  ) {
    skip(
      `edition ${target.publicId} is not at position ${into.linePosition ?? "(none)"} of line ${into.editionLineId}`,
    );
  }
  const line = await ctx.db.get(into.editionLineId);
  if (!line || line.status !== "active" || line.locked) {
    return skip(`line ${into.editionLineId} is not an active, unlocked line`);
  }
  if (line.seriesId !== seriesId) skip(`line ${line._id} is not the target series'`);
  if (line.publisherId !== edition.publisherId) skip(`line ${line._id} has another publisher`);
  if (!target.coverageUnmapped || (await coverageOf(ctx, target._id)).length > 0) {
    skip(`edition ${target.publicId} is not an empty Unmapped edition`);
  }
  return target;
}

/** The target-Series Volume one coverage row names (by id, else by label, created if missing). */
async function coveredVolume(
  ctx: MutationCtx,
  audit: Audit,
  seriesId: Id<"series">,
  cover: { label: string | null; volumeId: Id<"volumes"> | null },
) {
  if (cover.volumeId !== null) {
    const volume = await ctx.db.get(cover.volumeId);
    if (!volume || volume.status !== "active" || volume.seriesId !== seriesId) {
      return skip(`covered volume ${cover.volumeId} is not an active volume of the target series`);
    }
    return volume;
  }
  if (cover.label === null) return skip("coverage row names neither a label nor a volume");
  return await ensureVolume(ctx, audit, seriesId, cover.label);
}

/**
 * Retire packaging/placeholder Volumes nothing active covers any more: merge
 * each into the first Volume the package covers (its URL 301s there), or
 * hide it when there is none.
 */
async function retireVolumes(
  ctx: MutationCtx,
  audit: Audit,
  volumeIds: Id<"volumes">[],
  intoId: Id<"volumes"> | null,
) {
  const into = intoId ? await ctx.db.get(intoId) : null;
  for (const id of volumeIds) {
    const volume = await ctx.db.get(id);
    if (!volume || volume.status !== "active") continue;
    if ((await activeEditionsCovering(ctx, id)).length > 0) {
      audit.note(`volume ${volume.publicId} kept: still covered`);
      continue;
    }
    if (into && into._id !== id && into.status === "active" && !into.locked && !volume.locked) {
      await merge(ctx, audit, { type: "volume", id: into._id }, { type: "volume", id });
    } else {
      await hide(ctx, audit, { type: "volume", id }, volume);
    }
  }
}

const STATE_RANK = { wanted: 0, ordered: 1, owned: 2 } as const;

/**
 * Members joined a Bundle whose ownership answered to the `before` Series
 * (bundleSeries; none for a memberless one, which followed each owner's
 * default alone): every owner keeps it as private as it was. A later leg
 * that adds no member reads no owner.
 */
async function carryBundleOwners(
  ctx: MutationCtx,
  sink: OverrideSink,
  bundleId: Id<"releaseBundles">,
  before: Array<Id<"series">>,
) {
  const after = await bundleSeries(ctx, bundleId);
  if (sameValue([...after].sort(), [...before].sort())) return;
  for (const userId of await bundleOwners(ctx, bundleId)) {
    await carryVisibility(ctx, sink, userId, OWNERSHIP, before, after);
  }
}

/**
 * A box-set Release turned Release Bundle hands its Collection Entries to
 * the bundle, so an Owned box set stays in its owner's library (and its
 * members with it, by Derived Ownership). A User already holding an entry
 * on the bundle keeps that one, raised to the stronger state (Owned over
 * Ordered over Wanted), and the box-set entry folds into it. The shared
 * preflight refuses pinned Release Variants before any transfer. Ownership
 * the box set's Series kept private stays private on the bundle's member
 * Series (carryVisibility); a bundle with no member Series would fall back
 * to the owner's default, so it cannot take an Owned box set that had one.
 * Hands over at most the leg's budget; true once the box set holds none.
 */
async function entriesToBundle(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  box: Doc<"releases">,
  bundleId: Id<"releaseBundles">,
): Promise<boolean> {
  // Each handed-over entry leaves the box set's range, so a leg takes the
  // next ones up to its budget and the box set keeps the rest meanwhile.
  const entries = await ctx.db
    .query("collectionEntries")
    .withIndex("by_release", (q) => q.eq("releaseId", box._id))
    .take(moves.left + 1);
  const more = entries.length > moves.left;
  if (more) {
    moves.unfinished = true;
    entries.pop();
  }
  moves.left -= entries.length;
  const bundleSeriesIds = await bundleSeries(ctx, bundleId);
  const sink = trailSink(ctx, audit, moves);
  for (const entry of entries) {
    const kept = await ctx.db
      .query("collectionEntries")
      .withIndex("by_user_bundle", (q) => q.eq("userId", entry.userId).eq("bundleId", bundleId))
      .unique();
    if (entry.state === "owned" && kept?.state !== "owned") {
      if (bundleSeriesIds.length === 0 && box.seriesIds.length > 0) {
        skip("the bundle has no member Series to keep its owners' Tracking Visibility");
      }
      await carryVisibility(ctx, sink, entry.userId, OWNERSHIP, box.seriesIds, bundleSeriesIds);
    }
    if (!kept) {
      await refile(ctx, audit, moves, "collectionEntries", entry, {
        releaseId: undefined,
        bundleId,
        variantId: undefined,
      });
      continue;
    }
    if (STATE_RANK[entry.state] > STATE_RANK[kept.state]) {
      await refile(ctx, audit, moves, "collectionEntries", kept, { state: entry.state });
    }
    await audit.meta();
    await ctx.db.delete(entry._id);
    const { releaseId, state, variantId } = entry;
    moves.trail.push({
      table: "collectionEntries",
      docId: entry._id,
      field: "(removed)",
      before: { releaseId, state, variantId },
      into: kept._id,
    });
  }
  return !more;
}

/**
 * A box-set Release's ISBNs as the Bundle made from it stores them, or why
 * they cannot be. A valid ISBN, in either field and any spelling, is stored
 * as its field's one spelling (lib/isbn.ts isbnFieldValue). Text that is no
 * valid ISBN is kept as it was (compacted when it has an ISBN's shape): it
 * can hide no claim. A valid ISBN with no form in its field (a 979 ISBN
 * kept as `isbn10`) is the Bundle's ISBN-13 when that field is free, and
 * dropped when it is the same book as the ISBN-13; beside another `isbn13`
 * it is refused, as are two valid ISBNs naming different books: a person
 * corrects the Release first, so no barcode is lost or replaced.
 */
function bundleIsbns(
  box: Pick<Doc<"releases">, "isbn13" | "isbn10">,
): { isbn13?: string; isbn10?: string } | { refusal: string } {
  const text = (field: IsbnField, raw: string | undefined) =>
    raw === undefined ? undefined : (isbnFieldValue(field, raw) ?? raw);
  const key13 = toIsbn13(box.isbn13);
  const key10 = toIsbn13(box.isbn10);
  if (key13 !== undefined && key10 !== undefined && key13 !== key10) {
    return { refusal: `box-set release names two ISBNs (${key13}, ${key10})` };
  }
  const isbn13 = key13 ?? text("isbn13", box.isbn13);
  if (key10 === undefined) return { isbn13, isbn10: text("isbn10", box.isbn10) };
  const isbn10 = isbn13To10(key10);
  if (isbn10 !== undefined) return { isbn13, isbn10 };
  if (key13 === key10) return { isbn13 };
  if (isbn13 === undefined) return { isbn13: key10 };
  return {
    refusal: `box-set release keeps ISBN ${key10}, which has no ISBN-10, as its isbn10 beside isbn13 "${isbn13}"`,
  };
}

/** An existing bundle for this box-set Release: same ISBN-13, else same name/publisher/format. */
async function existingBundle(
  ctx: MutationCtx,
  release: Doc<"releases">,
  isbn13: string | undefined,
  name: string,
  publisherId: Id<"publishers">,
) {
  if (isbn13) {
    return await ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .unique();
  }
  // Bundles are few (box sets only); a scan is fine for a one-time repair.
  return (
    (await ctx.db.query("releaseBundles").collect()).find(
      (b) => b.name === name && b.publisherId === publisherId && b.format === release.format,
    ) ?? null
  );
}

/** Same-transaction reference closure before any conversion effects, including origin continuations. */
async function boxConversionPreflight(
  ctx: MutationCtx,
  box: Doc<"releases">,
  bundleId: Id<"releaseBundles"> | undefined,
  retireVolumeIds: Id<"volumes">[],
) {
  const r = reader(ctx);
  try {
    if (box.status !== "active" || box.locked) skip("Box must be active and unlocked.");
    await r.active(box._id);
    const refs = await referenceAudit(ctx, box._id, bundleId);
    const publisher = await r.active(box.publisherId);
    if (refs.edition.publisherId !== publisher._id)
      skip("Box Edition and Release publishers disagree.");
    if (refs.edition.editionLineId) {
      const line = await r.active(refs.edition.editionLineId);
      if (line.publisherId !== publisher._id || !box.seriesIds.includes(line.seriesId))
        skip("Box Edition Line identity differs.");
    }
    if (!refs.complete || !refs.eligible)
      skip("Personal-data preservation required before box conversion.");
    for (const id of retireVolumeIds) {
      if (!refs.volumes.some((v) => v._id === id))
        skip("Retirement must name the box's own current placeholder Volumes.");
      if (Object.entries(refs.counts).some(([name, count]) => count && name.endsWith(`.${id}`)))
        skip("Placeholder has personal references; retain its identity and history.");
    }
    return refs;
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data &&
      "held" in error.data
    )
      skip(String(error.data.held));
    throw error;
  }
}

/** Box claims permit only this box and its intended Bundle, including origin continuations. */
async function conversionClaims(
  ctx: MutationCtx,
  box: Doc<"releases">,
  bundle: Doc<"releaseBundles"> | null,
) {
  for (const key of primaryIsbnsOf(box)) {
    const scope = await isbnScope(ctx, key);
    if (scope) skip(scope);
    const claims = await isbnClaims(ctx, key, { resolver: claimResolver(ctx) });
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.printed ||
      [...claims.owners.values()].some(
        (owner) => owner.doc._id !== box._id && owner.doc._id !== bundle?._id,
      )
    )
      skip(
        `ISBN ${key} belongs to Release/Bundle claims outside this conversion or an Other Printing.`,
      );
    if (bundle && !primaryIsbnsOf(bundle).has(key)) skip("Box and Bundle ISBNs disagree.");
  }
}

/** Exact current members resolved before Bundle creation, membership, ownership or audit writes. */
async function conversionMembers(
  ctx: MutationCtx,
  planned: EntryOf<"releaseBundle">["members"],
  publisherId: Id<"publishers">,
  format: Doc<"releases">["format"],
  boxId?: Id<"releases">,
) {
  const r = reader(ctx);
  await r.active(publisherId);
  if (
    !planned.length ||
    planned.length > 80 ||
    new Set(planned.map((p) => p.order)).size !== planned.length
  )
    skip("Box conversion needs complete nonempty uniquely ordered members.");
  const selected: Array<{
    release: Contents["release"];
    contents: Contents["contents"];
    order: number;
  }> = [];
  for (const member of planned) {
    const key = toIsbn13(member.isbn13);
    const scope = await isbnScope(ctx, key);
    if (scope) skip(scope);
    let releaseId: Id<"releases">;
    if (key) {
      const claims = await isbnClaims(ctx, key, {
        resolver: claimResolver(ctx, { room: r.room }),
        room: r.room,
      });
      if (!claims?.complete || claims.unresolved.length || claims.owners.size !== 1)
        return skip(`member ${member.isbn13}: ownership is incomplete or ambiguous`);
      const owner = [...claims.owners.values()][0]!;
      if (owner.kind !== "release") return skip("Box member must be a Release.");
      releaseId = owner.doc._id;
    } else {
      // Legacy non-ISBN text has no normalized namespace claim. Preserve
      // the old exact selector, requiring one unambiguous stored Release.
      const exact = await r.many(
        ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", member.isbn13)),
      );
      if (exact.length !== 1) skip("Legacy member selector is absent or ambiguous.");
      releaseId = exact[0]!._id;
    }
    if (releaseId === boxId) skip("Box must not be its own member.");
    const content = await releaseContents(ctx, releaseId, r, true);
    if (content.publisher._id !== publisherId || content.release.format !== format)
      skip("Member publisher or format differs from Bundle.");
    selected.push({ release: content.release, contents: content.contents, order: member.order });
  }
  if (new Set(selected.map((m) => m.release._id)).size !== selected.length)
    skip("Box repeats the same member Release.");
  return selected;
}

/** Both callable converters finish with the same exact immutable proof. */
async function completeBoxConversion(
  ctx: MutationCtx,
  audit: Audit,
  box: Doc<"releases">,
  bundle: Doc<"releaseBundles">,
) {
  if (!(await hide(ctx, audit, { type: "release", id: box._id }, box))) return;
  const revision = await audit.revise({ type: "release", id: box._id }, [
    { field: "convertedToBundle", after: `#${bundle.publicId} ${bundle.name}` },
  ]);
  if (!revision) return skip("Conversion audit missing.");
  await ctx.db.insert("bundleConversions", {
    releaseId: box._id,
    bundleId: bundle._id,
    proposalId: (await audit.meta()).proposalId,
    revisionId: revision.revisionId,
    isbnKeys: valueHash([...primaryIsbnsOf(box)].sort()),
  });
}

/**
 * A box set is a Release Bundle (spec §2): each box-set Release's facts
 * become a bundle's, member Releases join in coverage order, their
 * Collection Entries pass to the bundle (entriesToBundle), and the
 * box-set Releases/Edition are hidden (identity and history kept).
 */
async function toBundle(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"remodelEdition">,
  edition: Doc<"editions">,
  name: string,
): Promise<Result> {
  const r = reader(ctx);
  const target = await r.active(entry.targetSeriesId);
  const boxes = await r.many(
    ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
  );
  const actualBoxes = boxes.filter((b) => b.status !== "merged");
  if (!actualBoxes.length) skip("box set has no release");
  if (entry.groups.length !== 1 || entry.groups[0]!.coverage.some((c) => c.extent !== "complete"))
    skip("Box conversion needs one complete content group.");
  const coverage = entry.groups[0]!.coverage;
  if (coverage.length > 80) skip("Requested box contents exceed 80 Volumes; incomplete.");
  const plans = [];
  for (const box of actualBoxes) {
    const isbns = bundleIsbns(box);
    if ("refusal" in isbns) return skip(isbns.refusal);
    const bundle = await existingBundle(ctx, box, isbns.isbn13, name, edition.publisherId);
    if (
      bundle &&
      (bundle.status !== "active" ||
        bundle.locked ||
        bundle.publisherId !== box.publisherId ||
        bundle.format !== box.format)
    )
      skip("Existing Bundle identity or eligibility differs.");
    const origin = bundle
      ? await ctx.db
          .query("repairBundleOrigins")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
          .unique()
      : null;
    if (bundle && (origin?.releaseId !== box._id || origin.entryKey !== entry.key))
      skip("Existing Bundle remodel needs an explicit guarded releaseBundle conversion.");
    const proof = bundle ? await convertedClaim(ctx, box, bundle) : null;
    if (!proof) {
      await boxConversionPreflight(ctx, box, bundle?._id, entry.retireVolumeIds);
      if (!(await coverageOf(ctx, edition._id)).some((c) => c.volumeId === entry.volumeId))
        skip("Box Edition no longer covers the planned placeholder.");
      await conversionClaims(ctx, box, bundle);
    }
    const selected: Array<{
      release: Contents["release"];
      contents: Contents["contents"];
      order: number;
    }> = [];
    const labels = coverage.flatMap((row) =>
      row.volumeId === null && row.label !== null ? [row.label] : [],
    );
    const volumes = labels.length ? await volumesForLabels(ctx, target._id, labels, r) : [];
    for (const [i, row] of coverage.entries()) {
      const matches =
        row.volumeId !== null
          ? [await r.active(row.volumeId)].filter((v) => v.seriesId === target._id)
          : volumes.filter((v) => v.status === "active" && sameLabel(v.label, row.label));
      if (matches.length !== 1) skip("Box contents need one exact current Volume for each member.");
      const volume = await r.active(matches[0]!._id);
      if (row.label !== null && !sameLabel(volume.label, row.label))
        skip("Box member Volume label drifted.");
      const member = await memberReleaseFor(
        ctx,
        volume._id,
        new Set([edition.publisherId]),
        box.format,
      );
      if (!member || member._id === box._id)
        return skip("Box contents incomplete: no exact member Release.");
      const content = await releaseContents(ctx, member._id, r);
      if (
        content.publisher._id !== edition.publisherId ||
        content.contents.length !== 1 ||
        content.contents[0]!.volume._id !== volume._id ||
        content.release.format !== box.format
      )
        skip("Box member identity differs.");
      for (const key of primaryIsbnsOf(content.release)) {
        const scope = await isbnScope(ctx, key);
        if (scope) skip(scope);
        const claims = await isbnClaims(ctx, key, {
          resolver: claimResolver(ctx, { room: r.room }),
          room: r.room,
        });
        if (
          !claims?.complete ||
          claims.unresolved.length ||
          claims.owners.size !== 1 ||
          !claims.owners.has(content.release._id)
        )
          skip("Box member primary claims are incomplete or ambiguous.");
      }
      selected.push({ release: content.release, contents: content.contents, order: i + 1 });
    }
    if (!selected.length || new Set(selected.map((m) => m.release._id)).size !== selected.length)
      skip("Box conversion needs nonempty unique members.");
    const current = bundle
      ? await r.many(
          ctx.db
            .query("bundleMemberships")
            .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id)),
        )
      : [];
    if (
      current.some(
        (m) => !selected.some((p) => p.release._id === m.releaseId && p.order === m.order),
      ) ||
      (proof && current.length !== selected.length)
    )
      skip("Existing Bundle members drifted.");
    if (proof) {
      for (const id of entry.retireVolumeIds) {
        const volume = await ctx.db.get(id);
        if (!volume || volume.status === "active")
          skip("Converted placeholder retirement drifted.");
      }
    }
    plans.push({ box, bundle, isbns, selected, current, proof });
  }
  if (plans.every((p) => p.proof)) return already;
  const moves = newMoves(entry.key);
  let firstMemberVolume: Id<"volumes"> | null = null;
  for (const plan of plans) {
    if (plan.proof) continue;
    const { box, selected, current, isbns } = plan;
    let bundle = plan.bundle;
    if (!bundle) {
      await audit.meta();
      const fields = {
        status: "active" as const,
        publicId: await allocatePublicId(ctx, "bundle"),
        name,
        publisherId: edition.publisherId,
        format: box.format,
        isbn13: isbns.isbn13,
        isbn10: isbns.isbn10,
        pubDate: box.pubDate,
        price: box.price,
        description: box.description,
        coverImage: box.coverImage,
        bootstrapUnreviewed: true,
      };
      const id = await ctx.db.insert("releaseBundles", fields);
      await ctx.db.insert("repairBundleOrigins", {
        bundleId: id,
        releaseId: box._id,
        entryKey: entry.key,
        proposalId: (await audit.meta()).proposalId,
      });
      audit.op({ kind: "create", table: "releaseBundles", tempId: id, fields });
      await audit.revise(
        { type: "releaseBundle", id },
        Object.entries(fields)
          .filter(([, after]) => after !== undefined)
          .map(([field, after]) => ({ field, after })),
      );
      bundle = await ctx.db.get(id);
    }
    if (!bundle) return skip("bundle vanished");
    const seriesBefore = await bundleSeries(ctx, bundle._id);
    for (const member of selected) {
      firstMemberVolume ??= member.contents[0]!.volume._id;
      if (current.some((m) => m.releaseId === member.release._id)) continue;
      await audit.meta();
      await ctx.db.insert("bundleMemberships", {
        bundleId: bundle._id,
        releaseId: member.release._id,
        order: member.order,
      });
      await audit.revise({ type: "releaseBundle", id: bundle._id }, [
        {
          field: "member",
          after: `release ${member.release.isbn13 ?? member.release._id} (order ${member.order})`,
        },
      ]);
    }
    await carryBundleOwners(ctx, trailSink(ctx, audit, moves), bundle._id, seriesBefore);
    if (await entriesToBundle(ctx, audit, moves, box, bundle._id))
      await completeBoxConversion(ctx, audit, box, bundle);
  }
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  if (moves.unfinished) return partial;
  await hide(ctx, audit, { type: "edition", id: edition._id }, edition);
  await retireVolumes(ctx, audit, entry.retireVolumeIds, firstMemberVolume);
  return audit.wrote ? applied : already;
}

async function foldEdition(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"foldEdition">,
): Promise<Result> {
  const keep = await ctx.db.get(entry.keepEditionId);
  const other = await ctx.db.get(entry.otherEditionId);
  if (!keep || !other) return skip("edition missing");
  if (other.status === "merged") {
    return other.mergedIntoId === keep._id ? already : skip("merged elsewhere");
  }
  if (keep.status !== "active" || other.status !== "active") skip("edition not active");
  if (keep.publisherId !== other.publisherId) skip("editions have different publishers");
  if (keep.editionLineId !== other.editionLineId) skip("editions sit in different lines");
  if (!entry.packagingTwin) {
    // After the series merges both Editions must cover the same Volumes.
    const volumesOf = async (id: Id<"editions">) =>
      (await coverageOf(ctx, id)).map((row) => row.volumeId).sort();
    if (!sameValue(await volumesOf(keep._id), await volumesOf(other._id))) {
      skip("editions cover different volumes");
    }
  }

  await merge(ctx, audit, { type: "edition", id: keep._id }, { type: "edition", id: other._id });

  // A same-format twin without an ISBN is the same book: merge it into the
  // one Release of that format that has one.
  const releases = (await releasesOf(ctx, keep._id)).filter((r) => r.status === "active");
  for (const format of ["physical", "digital"] as const) {
    const ofFormat = releases.filter((r) => r.format === format);
    const withIsbn = ofFormat.filter((r) => r.isbn13);
    const survivor = withIsbn[0];
    if (withIsbn.length !== 1 || !survivor) continue;
    for (const twin of ofFormat.filter((r) => !r.isbn13)) {
      await merge(
        ctx,
        audit,
        { type: "release", id: survivor._id },
        { type: "release", id: twin._id },
      );
    }
  }
  return applied;
}

// ---------- stages 5-6: fields & volume numbering ----------

/** Plan JSON uses null for "absent". */
const stored = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

/**
 * A plan's ISBN as its field stores it (lib/isbn.ts isbnFieldValue: the one
 * spelling every claim check finds), before any collision check, write or
 * audit uses it; a plan value that is no ISBN of that kind skips the entry.
 * Null (absent) stays null.
 */
function plannedIsbn(field: IsbnField, value: string): string;
function plannedIsbn(field: IsbnField, value: string | null): string | null;
function plannedIsbn(field: IsbnField, value: string | null): string | null {
  if (value === null) return null;
  return (
    isbnFieldValue(field, value) ??
    skip(`"${value}" is not an ${field === "isbn13" ? "ISBN-13" : "ISBN-10"}`)
  );
}

/**
 * Check each change against the record: already at `after` is fine, at
 * `before` gets applied, anything else is drift. Returns the fields to patch.
 */
function pendingChanges<C extends { field: string; before: unknown; after: unknown }>(
  doc: Record<string, unknown>,
  changes: C[],
): C[] {
  return changes.filter((change) => {
    const value = doc[change.field];
    if (sameValue(value, stored(change.after))) return false;
    if (!sameValue(value, stored(change.before))) {
      skip(`${change.field} drifted: ${JSON.stringify(value)}`);
    }
    return true;
  });
}

/** Add `field` to the Human Overrides `patch` will leave on `release`. */
function override(patch: Partial<Doc<"releases">>, release: Doc<"releases">, field: string) {
  patch.overriddenFields = [
    ...new Set([...(patch.overriddenFields ?? release.overriddenFields ?? []), field]),
  ];
}

async function updateFields(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"updateFields">,
): Promise<Result> {
  if (entry.table === "series") {
    const series = await ctx.db.get(entry.id);
    if (!series || series.status !== "active") return skip("series not active");
    if (series.locked) return skip("series locked");
    const pending = pendingChanges(series, entry.changes);
    if (pending.length === 0) return already;
    const patch: Partial<Doc<"series">> = {};
    for (const change of pending) {
      if (change.field === "title") patch.title = change.after;
      else if (change.field === "synopsis") patch.synopsis = stored(change.after);
      else patch.altTitles = change.after;
    }
    const title = patch.title ?? series.title;
    patch.searchText = seriesSearchText(title, patch.altTitles ?? series.altTitles);
    await updateRecord(ctx, audit, { type: "series", id: series._id }, series, patch);
    if (patch.title !== undefined) await lockTitleIfContested(ctx, audit, series._id);
    return applied;
  }

  if (entry.table === "volumes") {
    const volume = await ctx.db.get(entry.id);
    if (!volume || volume.status !== "active") return skip("volume not active");
    if (volume.locked) return skip("volume locked");
    const pending = pendingChanges(volume, entry.changes);
    if (pending.length === 0) return already;
    await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
      synopsis: stored(pending[0]!.after),
    });
    return applied;
  }

  const release = await ctx.db.get(entry.id);
  if (!release || release.status !== "active") return skip("release not active");
  if (release.locked) return skip("release locked");
  // A new ISBN is written, checked and audited as its field stores it; the
  // value it replaces is compared as stored.
  const changes = entry.changes.map((change) =>
    change.field === "isbn13" || change.field === "isbn10"
      ? { ...change, after: plannedIsbn(change.field, change.after) }
      : change,
  );
  const pending = pendingChanges(release, changes);
  if (pending.length === 0) return already;
  const patch: Partial<Doc<"releases">> = {};
  for (const change of pending) {
    switch (change.field) {
      case "pubDate":
        patch.pubDate = stored(change.after);
        break;
      case "coverImage":
        if (change.after?.storageId && (await ctx.storage.getUrl(change.after.storageId)) === null)
          skip("the planned cover's stored file does not exist");
        patch.coverImage = stored(change.after);
        // An operator's art is a Human Override: no import replaces it.
        if (change.after !== null) override(patch, release, "coverImage");
        break;
      case "description":
        patch.description = stored(change.after);
        if (change.after !== null) override(patch, release, "description");
        break;
      case "format":
        if (change.after === "digital") {
          const printing = await ctx.db
            .query("releaseIsbns")
            .withIndex("by_release", (q) => q.eq("releaseId", release._id))
            .first();
          if (printing !== null)
            skip(
              `The Release has other printings (ISBN ${printing.isbn13}), and only a physical Release has other printings. Keep its format physical.`,
            );
        }
        patch.format = change.after;
        // Binding describes physical construction only (glossary: Binding).
        if (change.after === "digital" && release.binding !== undefined) patch.binding = undefined;
        if (change.after === "physical" && release.digitalFileFormat !== undefined)
          patch.digitalFileFormat = undefined;
        break;
      case "digitalFileFormat":
        patch.digitalFileFormat = stored(change.after);
        break;
      default:
        patch[change.field] = stored(change.after);
    }
  }
  const isbn13 = patch.isbn13;
  if (isbn13 !== undefined) {
    const clash = await ctx.db
      .query("releases")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .unique();
    if (clash && clash._id !== release._id) skip(`ISBN ${isbn13} already on another release`);
  }
  // An ISBN with Other Printings is one Release's alone (lib/releaseIsbns.ts).
  const printed = await assignedIsbnRefusal(ctx, [patch.isbn13, patch.isbn10], release._id);
  if (printed !== null) skip(printed);
  if (release.format === "digital" && patch.binding !== undefined)
    skip("binding on a digital release");
  const fileFormat = pending.find(
    (change): change is Extract<typeof change, { field: "digitalFileFormat" }> =>
      change.field === "digitalFileFormat",
  );
  if (fileFormat?.after) {
    const refusal = await fileFormatRefusal(
      ctx,
      { ...release, ...patch },
      entry.evidenceObservationId,
      fileFormat,
    );
    if (refusal) skip(refusal);
  }
  await updateRecord(ctx, audit, { type: "release", id: release._id }, release, patch);
  return applied;
}

/**
 * Why a planned PDF/EPUB classification is unsupported, or null. The Release
 * must be digital with an ISBN-13, and the evidence a present source record
 * linked to it under that ISBN, digital, stating no other file format. A
 * known file format changes only where that record states the new one.
 */
async function fileFormatRefusal(
  ctx: MutationCtx,
  release: Doc<"releases">,
  evidenceId: Id<"sourceObservations"> | null,
  change: { before: DigitalFileFormat | null; after: DigitalFileFormat | null },
): Promise<string | null> {
  if (release.format !== "digital") return "a file format on a physical release";
  if (!release.isbn13) return "a file format needs the release's own ISBN-13";
  const observation = evidenceId ? await ctx.db.get(evidenceId) : null;
  if (!observation) return "a file format needs its linked source record";
  const snapshot = observation.snapshot as {
    isbn13?: unknown;
    format?: unknown;
    digitalFileFormat?: unknown;
  } | null;
  if (
    observation.withdrawn ||
    observation.recordRef?.type !== "release" ||
    observation.recordRef.id !== release._id ||
    snapshot?.isbn13 !== release.isbn13 ||
    snapshot.format !== "digital"
  )
    return "the evidence is not a present digital record linked to this release under its ISBN";
  if (snapshot.digitalFileFormat !== undefined && snapshot.digitalFileFormat !== change.after)
    return `the linked record states ${String(snapshot.digitalFileFormat)}`;
  if (change.before !== null && snapshot.digitalFileFormat !== change.after)
    return "reclassifying a known file format needs a record that states the new one";
  return null;
}

async function normalizeVolumes(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"normalizeVolumes">,
): Promise<Result> {
  const series = await ctx.db.get(entry.seriesId);
  if (!series || series.status !== "active") return skip("series not active");

  for (const { volumeId, intoVolumeId, label } of entry.merges) {
    const volume = await ctx.db.get(volumeId);
    const into = await liveVolume(ctx, intoVolumeId);
    if (!volume || !into) skip("duplicate volume pair missing");
    if (volume!.status === "merged") continue;
    if (volume!.status !== "active") continue;
    if (volume!.seriesId !== series._id || into!.seriesId !== series._id)
      skip("duplicate volume left the series");
    if (label !== undefined) {
      if (!sameLabel(volume!.label, label))
        skip(`duplicate volume ${volume!.publicId} label drifted`);
    } else if (!sameLabel(volume!.label, into!.label)) {
      skip("duplicate volumes no longer share a label");
    }
    await merge(ctx, audit, { type: "volume", id: into!._id }, { type: "volume", id: volume!._id });
  }

  const volumes = await activeVolumes(ctx, series._id);
  for (const relabel of entry.relabels) {
    const volume = volumes.find((v) => v._id === relabel.volumeId);
    if (!volume) {
      audit.note(`relabel of ${relabel.volumeId} skipped: not an active volume here`);
      continue;
    }
    if (sameLabel(volume.label, relabel.after)) continue;
    if (!sameLabel(volume.label, relabel.before)) skip(`volume ${volume.publicId} label drifted`);
    if (volumes.some((v) => v._id !== volume._id && sameLabel(v.label, relabel.after))) {
      audit.note(`relabel of volume ${volume.publicId} to "${relabel.after}" skipped: label taken`);
      continue;
    }
    await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
      label: canonicalLabel(relabel.after) ?? undefined,
    });
  }

  for (const volume of await activeVolumes(ctx, series._id)) {
    const canonical = canonicalLabel(volume.label);
    if (volume.label !== undefined && canonical !== volume.label) {
      await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
        label: canonical ?? undefined,
      });
    }
  }
  await settlePositions(ctx, audit, series._id);
  return audit.wrote ? applied : already;
}

// ---------- personal tracking that follows a move ----------

/**
 * Personal rows one leg of an entry may examine. A split's sweeps and a box
 * set's Collection Entries stop there: the entry reports "partial", and the
 * runner (scripts/repair.ts) calls it again to go on where it stopped.
 */
export const SWEEP_BUDGET = 250;

/** How far one sweep got this leg: past every row created at or before `after`, or `done`. */
type SweepState = { after: number; done: boolean };

/**
 * One entry's personal work this leg: the trail of rows it moved and the
 * overrides that keep them private, the rows it may still examine, whether
 * any was left for the next leg, and where its sweeps stand.
 */
type Moves = {
  key: string;
  trail: TrailRow[];
  left: number;
  unfinished: boolean;
  sweeps: Map<string, SweepState>;
  carried: Set<string>;
};

const newMoves = (key: string): Moves => ({
  key,
  trail: [],
  left: SWEEP_BUDGET,
  unfinished: false,
  sweeps: new Map(),
  carried: new Set(),
});

/** The status of an entry that left personal work for its next leg. */
const partial: Result = {
  status: "partial",
  reason: "personal tracking continues on the next call",
};

type PersonalTable =
  | "releaseProgress"
  | "favorites"
  | "comments"
  | "userSeriesStates"
  | "collectionEntries";

/** Patch a personal row, logging each field that changes on the trail. */
async function refile<T extends PersonalTable>(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  table: T,
  doc: Doc<T>,
  patch: Partial<Doc<T>>,
) {
  const current: Record<string, unknown> = doc;
  const changed = Object.entries(patch).filter(
    ([field, after]) => !sameValue(current[field], after),
  );
  if (changed.length === 0) return;
  await audit.meta();
  await ctx.db.patch(doc._id, patch);
  for (const [field, after] of changed) {
    moves.trail.push({ table, docId: doc._id, field, before: current[field], after });
  }
}

/**
 * One page of a sweep: up to `count` rows created after `after`, the cursor
 * past them, and whether the sweep is over. `_creationTime` is not
 * guaranteed unique, and a cursor that stopped between two rows created at
 * the same instant would skip the second. So a page never ends inside such
 * a run: when the row after its last shares that row's creation time, the
 * whole run is read, however long, and the page grows by it. The cursor
 * therefore always moves past every row returned.
 */
export async function sweepPage<D extends { _creationTime: number }>(
  page: (after: number, count: number) => Promise<D[]>,
  after: number,
  count: number,
): Promise<{ rows: D[]; after: number; done: boolean }> {
  // One row past the page shows whether its last row's instant goes on.
  const read = await page(after, count + 1);
  if (read.length <= count) {
    return { rows: read, after: read.at(-1)?._creationTime ?? after, done: true };
  }
  const instant = read[count]!._creationTime;
  const rows = read.slice(0, count);
  if (rows[count - 1]!._creationTime !== instant) {
    return { rows, after: rows[count - 1]!._creationTime, done: false };
  }
  // The page would split the run at `instant`: read that run from its start
  // (just past the row before it), doubling until a later row or the end shows.
  const lead = rows.filter((row) => row._creationTime < instant);
  const before = lead.at(-1)?._creationTime ?? after;
  for (let ask = 2 * (read.length - lead.length); ; ask *= 2) {
    const from = await page(before, ask);
    const run = from.filter((row) => row._creationTime === instant);
    if (run.length < from.length || from.length < ask) {
      return { rows: [...lead, ...run], after: instant, done: run.length === from.length };
    }
  }
}

/**
 * Visit, in creation order, the rows `page` returns after a creation time,
 * resuming where this entry's earlier leg left the sweep `name` and
 * spending the leg's budget. A sweep the budget cuts short marks the entry
 * unfinished. Rows a visit re-files stay in their range, hence the cursor
 * (`sweepPage` keeps it from ever splitting rows created at one instant).
 */
async function sweep<D extends { _creationTime: number }>(
  ctx: MutationCtx,
  moves: Moves,
  name: string,
  page: (after: number, count: number) => Promise<D[]>,
  visit: (row: D) => Promise<void>,
) {
  let state = moves.sweeps.get(name);
  if (!state) {
    const saved = await ctx.db
      .query("repairSweeps")
      .withIndex("by_entry_sweep", (q) => q.eq("entryKey", moves.key).eq("sweep", name))
      .unique();
    state = { after: saved?.after ?? -1, done: saved?.done ?? false };
    moves.sweeps.set(name, state);
  }
  while (!state.done) {
    if (moves.left <= 0) {
      moves.unfinished = true;
      return;
    }
    const step = await sweepPage(page, state.after, moves.left);
    for (const row of step.rows) await visit(row);
    state.after = step.after;
    state.done = step.done;
    moves.left -= step.rows.length;
  }
}

/**
 * Close one entry's leg: its trail goes to bounded records on the Proposal
 * (audit.trail) under `ref`, and its sweeps are saved for the next leg, or,
 * all finished, cleared so a later re-run starts afresh.
 */
async function closeMoves(ctx: MutationCtx, audit: Audit, ref: Ref, moves: Moves) {
  await audit.trail(ref, moves.trail);
  // One row per sweep of this entry, so as many as the plan entry has
  // Volumes, Releases and Editions.
  const saved = await ctx.db
    .query("repairSweeps")
    .withIndex("by_entry_sweep", (q) => q.eq("entryKey", moves.key))
    .collect();
  const unsaved = new Map(moves.sweeps);
  for (const row of saved) {
    const state = unsaved.get(row.sweep);
    unsaved.delete(row.sweep);
    if (!moves.unfinished) await ctx.db.delete(row._id);
    else if (state && (state.after !== row.after || state.done !== row.done))
      await ctx.db.patch(row._id, state);
  }
  if (!moves.unfinished) return;
  for (const [name, state] of unsaved) {
    await ctx.db.insert("repairSweeps", { entryKey: moves.key, sweep: name, ...state });
  }
}

/**
 * Where the repair writes the Tracking Visibility overrides the shared rule
 * (sensitiveOps carryVisibility) narrows: on the entry's trail, a new state
 * row as "(inserted)" without its User. The repair is never reversed, so
 * tracking may gain its first Series.
 */
function trailSink(ctx: MutationCtx, audit: Audit, moves: Moves): OverrideSink {
  return {
    reversible: false,
    carried: moves.carried,
    write: async (userId, seriesId, state, patch) => {
      if (state) return await refile(ctx, audit, moves, "userSeriesStates", state, patch);
      await audit.meta();
      const fields = { seriesId, following: false, followPromptDismissed: false, ...patch };
      const docId = await ctx.db.insert("userSeriesStates", { userId, ...fields });
      moves.trail.push({ table: "userSeriesStates", docId, field: "(inserted)", after: fields });
    },
  };
}

/**
 * Run `change`, which may move these Volumes to another Series or re-derive
 * these Editions' Series (re-parenting, new coverage, a moved line, a
 * Release moved to another Edition), then keep every User's tracking of
 * them as private as it was: Volume read counts, Owned Releases, Owned
 * Bundles holding them, passes, and omnibus Ratings (carryEditionTracking,
 * the rule merges apply) now answer to Series that absorb the overrides of
 * those they left. Only what `change` actually moves is carried, so a
 * re-run that moves nothing leaves every override as the User has since
 * set it.
 *
 * Unlike the re-filing sweeps, this carry is not bounded: the profile reads
 * these surfaces through the catalog (a read count through its Volume's
 * Series, ownership through its Release's), so it must commit with
 * `change`, and it reads every tracker (carryBundleOwners likewise). The
 * staged form needs sharing.ts to treat Series under a move as private for
 * everyone: freeze both sides, move the catalog, carry each tracker in
 * sweeps, then unfreeze. Carrying ahead of the move instead would race a
 * User's own later override change.
 *
 * Then the personal rows that denormalize a Series re-file under the one
 * they now belong to (followVolume, followEdition, followRelease), in
 * bounded sweeps. Every repair that moves tracking between Series runs its
 * move here, so none can carry the visibility and forget the rows.
 */
async function carryingTracking<R>(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  scope: { volumeIds?: Array<Id<"volumes">>; editionIds: Iterable<Id<"editions">> },
  change: () => Promise<R>,
): Promise<R> {
  const volumesBefore = new Map<Id<"volumes">, Id<"series"> | undefined>();
  for (const id of scope.volumeIds ?? []) volumesBefore.set(id, (await ctx.db.get(id))?.seriesId);
  const editionsBefore = new Map<Id<"editions">, EditionGovernance>();
  for (const id of scope.editionIds) editionsBefore.set(id, await editionGovernance(ctx, id));

  const result = await change();

  const sink = trailSink(ctx, audit, moves);
  for (const [volumeId, from] of volumesBefore) {
    const to = (await ctx.db.get(volumeId))?.seriesId;
    if (!from || !to || from === to) continue;
    const readers = await ctx.db
      .query("volumeProgress")
      .withIndex("by_volume", (q) => q.eq("volumeId", volumeId))
      .collect();
    for (const row of readers) await carryVisibility(ctx, sink, row.userId, READING, [from], [to]);
  }
  for (const [editionId, before] of editionsBefore)
    await carryEditionTracking(ctx, sink, editionId, before);

  for (const volumeId of volumesBefore.keys()) {
    const volume = await ctx.db.get(volumeId);
    if (volume) await followVolume(ctx, audit, moves, volume);
  }
  for (const [editionId, before] of editionsBefore) {
    await followEdition(ctx, audit, moves, editionId);
    // A Release `change` moved to another Edition follows on its own.
    for (const releaseId of before.releaseSeries.keys()) {
      const release = await ctx.db.get(releaseId);
      if (release && release.editionId !== editionId)
        await followRelease(ctx, audit, moves, release);
    }
  }
  return result;
}

/**
 * A repair re-parented this Volume (or merged another into it): re-file
 * what carries its Series (Volume Favorites, Comments) and
 * each covering Edition's rows (followEdition) under the Series it now sits
 * in. Rows key on the Volume, so nothing collides; only stale rows move, so
 * a re-run heals any earlier move. Each table is a sweep (bounded legs).
 */
async function followVolume(ctx: MutationCtx, audit: Audit, moves: Moves, volume: Doc<"volumes">) {
  const stale = (row: { seriesId: Id<"series"> }) => row.seriesId !== volume.seriesId;
  const to = { seriesId: volume.seriesId };
  await sweep(
    ctx,
    moves,
    `favorites:${volume._id}`,
    (after, count) =>
      ctx.db
        .query("favorites")
        .withIndex("by_volume", (q) => q.eq("volumeId", volume._id).gt("_creationTime", after))
        .take(count),
    async (row) => {
      if (stale(row)) await refile(ctx, audit, moves, "favorites", row, to);
    },
  );
  await sweep(
    ctx,
    moves,
    `comments:${volume._id}`,
    (after, count) =>
      ctx.db
        .query("comments")
        .withIndex("by_volume", (q) => q.eq("volumeId", volume._id).gt("_creationTime", after))
        .take(count),
    async (row) => {
      if (stale(row)) await refile(ctx, audit, moves, "comments", row, to);
    },
  );
  for (const edition of await activeEditionsCovering(ctx, volume._id)) {
    await followEdition(ctx, audit, moves, edition._id);
  }
}

/**
 * A repair re-derived this Release's Series: each of its Release Progress
 * rows takes the Release's first covered Series, merges followed
 * (reading.ts passSeriesId). The profile shows a pass only where its own
 * Series is public too, so re-filing one carries its reader's Reading
 * visibility from the Series it was filed under. Only stale rows move, so a
 * re-run heals any earlier move without carrying again. A sweep
 * (bounded legs).
 */
async function followRelease(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  release: Doc<"releases">,
) {
  const first = release.seriesIds[0];
  if (!first) return;
  const passSeriesId = (await followMerges(ctx, "series", await ctx.db.get(first)))?._id ?? first;
  const sink = trailSink(ctx, audit, moves);
  await sweep(
    ctx,
    moves,
    `releaseProgress:${release._id}`,
    (after, count) =>
      ctx.db
        .query("releaseProgress")
        .withIndex("by_release", (q) => q.eq("releaseId", release._id).gt("_creationTime", after))
        .take(count),
    async (pass) => {
      if (pass.seriesId === passSeriesId) return;
      await refile(ctx, audit, moves, "releaseProgress", pass, { seriesId: passSeriesId });
      await carryVisibility(
        ctx,
        sink,
        pass.userId,
        READING,
        [...release.seriesIds, pass.seriesId],
        [...release.seriesIds, passSeriesId],
      );
    },
  );
}

/**
 * A repair moved this Edition's coverage (and refreshed its Releases'
 * Series): its Releases' passes follow (followRelease), and an omnibus
 * Favorite takes its first covered Volume's Series. Only stale rows move;
 * the Favorites are a sweep (bounded legs).
 */
async function followEdition(
  ctx: MutationCtx,
  audit: Audit,
  moves: Moves,
  editionId: Id<"editions">,
) {
  for (const release of await releasesOf(ctx, editionId))
    await followRelease(ctx, audit, moves, release);

  const first = (await coverageOf(ctx, editionId)).sort((a, b) => a.order - b.order)[0];
  const firstSeriesId = first ? (await ctx.db.get(first.volumeId))?.seriesId : undefined;
  if (!firstSeriesId) return;
  await sweep(
    ctx,
    moves,
    `favorites@edition:${editionId}`,
    (after, count) =>
      ctx.db
        .query("favorites")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId).gt("_creationTime", after))
        .take(count),
    async (row) => {
      if (row.seriesId !== firstSeriesId)
        await refile(ctx, audit, moves, "favorites", row, { seriesId: firstSeriesId });
    },
  );
}

// ---------- stage 12: series splits ----------

/** Creation-Revision field naming the plan entry that split a Series off. */
const SPLIT_KEY_FIELD = REPAIR_KEY_FIELD;

/**
 * The Series an earlier run of this split created, or null. Every row the
 * split moves points at it once applied (one entry = one transaction), and
 * its creation Revision records the entry key; that key is the proof.
 */
async function splitTarget(ctx: MutationCtx, entry: EntryOf<"splitSeries">) {
  const candidates = new Set<Id<"series">>();
  for (const id of entry.observationIds) {
    const ref = (await ctx.db.get(id))?.recordRef;
    if (ref?.type === "series") candidates.add(ref.id);
  }
  for (const row of entry.volumes) {
    const volume = await ctx.db.get(row.volumeId);
    if (volume) candidates.add(volume.seriesId);
  }
  for (const row of entry.editions) {
    for (const cover of await coverageOf(ctx, row.editionId)) {
      const volume = await ctx.db.get(cover.volumeId);
      if (volume) candidates.add(volume.seriesId);
    }
  }
  candidates.delete(entry.sourceSeriesId);
  for (const id of candidates) {
    const created = await ctx.db
      .query("revisions")
      .withIndex("by_record", (q) => q.eq("ref.type", "series").eq("ref.id", id))
      .first();
    if (created?.changes.some((c) => c.field === SPLIT_KEY_FIELD && c.after === entry.key)) {
      return await ctx.db.get(id);
    }
  }
  return null;
}

/** Create the split-off Series, recording where it came from and the entry key. */
async function createSplitSeries(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"splitSeries">,
  source: Doc<"series">,
) {
  await audit.meta();
  const fields = {
    status: "active" as const,
    publicId: await allocatePublicId(ctx, "series"),
    title: entry.title,
    altTitles: entry.altTitles,
    searchText: seriesSearchText(entry.title, entry.altTitles),
  };
  const id = await ctx.db.insert("series", fields);
  audit.op({ kind: "create", table: "series", tempId: id, fields });
  audit.op({
    kind: "split",
    ref: { type: "series", id: source._id },
    details: {
      into: id,
      volumeIds: entry.volumes.map((row) => row.volumeId),
      editionIds: entry.editions.map((row) => row.editionId),
      observationIds: entry.observationIds,
    },
  });
  await audit.revise({ type: "series", id }, [
    ...Object.entries(fields)
      .filter(([field]) => field !== "searchText")
      .map(([field, after]) => ({ field, after })),
    { field: "splitFrom", after: `#${source.publicId} ${source.title}` },
    { field: SPLIT_KEY_FIELD, after: entry.key },
  ]);
  await audit.revise({ type: "series", id: source._id }, [
    { field: "splitOut", after: `#${fields.publicId} ${entry.title}` },
  ]);
  const created = await ctx.db.get(id);
  return created ?? skip("created series vanished");
}

const idSet = (ids: string[]) => [...new Set(ids)].sort();

/**
 * An Edition Line of the source Series follows its Editions to the new one,
 * but only when every active Edition in it moves: a line spanning both
 * works is a plan error.
 */
async function followLine(
  ctx: MutationCtx,
  audit: Audit,
  edition: Doc<"editions">,
  sourceId: Id<"series">,
  targetId: Id<"series">,
  moving: Set<string>,
) {
  if (!edition.editionLineId) return;
  const line = await ctx.db.get(edition.editionLineId);
  if (!line || line.seriesId !== sourceId) return;
  const members = await ctx.db
    .query("editions")
    .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
    .collect();
  const staying = members.find((m) => m.status === "active" && !moving.has(m._id));
  if (staying)
    skip(`edition line "${line.name}" also holds edition ${staying.publicId}, which stays`);
  await audit.meta();
  await ctx.db.patch(line._id, { seriesId: targetId });
  const ref = { type: "editionLine" as const, id: line._id };
  const changes = [{ field: "seriesId", before: sourceId, after: targetId }];
  audit.op({ kind: "update", ref, changes });
  await audit.revise(ref, changes);
}

async function splitSeries(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"splitSeries">,
): Promise<Result> {
  const source = await ctx.db.get(entry.sourceSeriesId);
  if (!source || source.status !== "active") return skip("source series not active");
  if (source.locked) return skip("source series locked");
  if (
    entry.volumes.length +
      entry.editions.length +
      entry.observationIds.length +
      entry.placeholderLabels.length ===
    0
  ) {
    return skip("the split moves no volume, edition, or observation, and adds no volume");
  }

  let target = await splitTarget(ctx, entry);
  if (target && target.status !== "active")
    skip(`split-off series ${target.publicId} is ${target.status}`);
  if (!target) {
    if (source.title !== entry.sourceTitle)
      skip(`source title drifted: ${JSON.stringify(source.title)}`);
    target = await createSplitSeries(ctx, audit, entry, source);
  }
  const targetId = target!._id;
  const moving = new Set<string>([
    ...entry.volumes.flatMap((row) => row.editionIds),
    ...entry.editions.map((row) => row.editionId),
  ]);

  // Personal tracking follows the moved work (followVolume, followEdition),
  // also on a re-run, which heals a split made before it did. Its Tracking
  // Visibility moves with it (carryingTracking): the split-off Series
  // absorbs the source's overrides for each User whose tracking it takes.
  // The re-filing runs in bounded legs (sweep): the catalog moves in the
  // first, and later calls find it done and go on re-filing.
  const moves = newMoves(entry.key);

  // Whole Volumes: re-parented with the moved work's own label. Anything
  // the importers attached since planning (another Edition) is drift.
  for (const row of entry.volumes) {
    const volume = await ctx.db.get(row.volumeId);
    if (!volume) return skip(`volume ${row.volumeId} missing`);
    if (volume.seriesId === targetId) {
      await followVolume(ctx, audit, moves, volume);
      continue;
    }
    if (volume.status !== "active") skip(`volume ${volume.publicId} is ${volume.status}`);
    if (volume.seriesId !== source._id) skip(`volume ${volume.publicId} left the source series`);
    if (volume.locked) skip(`volume ${volume.publicId} is locked`);
    if (!sameLabel(volume.label, row.label))
      skip(`volume ${volume.publicId} label drifted: ${JSON.stringify(volume.label ?? null)}`);
    const editions = await activeEditionsCovering(ctx, volume._id);
    if (!sameValue(idSet(editions.map((e) => e._id)), idSet(row.editionIds))) {
      skip(
        `volume ${volume.publicId} editions drifted: now ${editions.map((e) => e.publicId).join(", ") || "none"}`,
      );
    }
    const targetVolumes = await activeVolumes(ctx, targetId);
    if (targetVolumes.some((v) => sameLabel(v.label, row.newLabel))) {
      skip(`split-off series already has a volume labelled ${JSON.stringify(row.newLabel)}`);
    }
    const label = canonicalLabel(row.newLabel);
    const last = targetVolumes.reduce((max, v) => Math.max(max, v.position), 0);
    const scope = { volumeIds: [volume._id], editionIds: editions.map((e) => e._id) };
    await carryingTracking(ctx, audit, moves, scope, async () => {
      await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
        seriesId: targetId,
        label: label ?? undefined,
        position: labelNumber(label) ?? last + 1,
      });
      for (const edition of editions) {
        await followLine(ctx, audit, edition, source._id, targetId, moving);
        await refreshReleaseDenorms(ctx, edition._id);
      }
    });
  }

  // Editions on a Volume label both works share: the staying work keeps
  // the Volume; the Edition's coverage moves to the new Series' Volume.
  for (const row of entry.editions) {
    const edition = await ctx.db.get(row.editionId);
    if (!edition || edition.status !== "active") return skip(`edition ${row.editionId} not active`);
    if (row.labels.length !== row.fromVolumeIds.length)
      skip("plan error: one label per coverage row");
    const coverage = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
    const covered = [];
    for (const cover of coverage) covered.push(await ctx.db.get(cover.volumeId));
    const done =
      covered.length === row.labels.length &&
      covered.every((vol, i) => vol?.seriesId === targetId && sameLabel(vol.label, row.labels[i]));
    if (done) {
      await followEdition(ctx, audit, moves, edition._id);
      continue;
    }
    if (
      !sameValue(
        coverage.map((c) => c.volumeId),
        row.fromVolumeIds,
      )
    ) {
      skip(`edition ${edition.publicId} coverage drifted`);
    }
    const releases = (await releasesOf(ctx, edition._id)).filter((r) => r.status === "active");
    if (!sameValue(idSet(releases.map((r) => r._id)), idSet(row.releaseIds))) {
      skip(
        `edition ${edition.publicId} releases drifted: now ${releases.map((r) => r.isbn13 ?? r._id).join(", ")}`,
      );
    }
    if (edition.locked) skip(`edition ${edition.publicId} is locked`);
    const rows: Parameters<typeof replaceCoverage>[3] = [];
    for (const [i, label] of row.labels.entries()) {
      rows.push({
        volumeId: (await ensureVolume(ctx, audit, targetId, label))._id,
        extent: coverage[i]!.extent,
      });
    }
    await carryingTracking(ctx, audit, moves, { editionIds: [edition._id] }, async () => {
      await followLine(ctx, audit, edition, source._id, targetId, moving);
      await replaceCoverage(ctx, audit, edition._id, rows);
    });
  }

  // The moved work's backbone Volumes that have no Release yet.
  for (const label of entry.placeholderLabels) await ensureVolume(ctx, audit, targetId, label);

  // Series-level observations: importers resolve the work's Series through
  // these, so its future Releases land on the new Series.
  for (const id of entry.observationIds) {
    const observation = await ctx.db.get(id);
    if (!observation) return skip(`observation ${id} missing`);
    const ref = observation.recordRef;
    if (ref?.type === "series" && ref.id === targetId) continue;
    const record = `${observation.sourceKey} ${observation.sourceRecordId}`;
    if (ref?.type !== "series" || ref.id !== source._id) {
      skip(`${record} now links ${ref ? `${ref.type} ${ref.id}` : "nothing"}`);
    }
    await audit.meta();
    await linkObservation(ctx, observation._id, { type: "series", id: targetId });
    const from = { type: "series" as const, id: source._id };
    const to = { type: "series" as const, id: targetId };
    audit.op({
      kind: "update",
      ref: from,
      changes: [{ field: "sourceObservation", before: record }],
    });
    audit.op({ kind: "update", ref: to, changes: [{ field: "sourceObservation", after: record }] });
    await audit.revise(from, [{ field: "sourceObservation", before: record }]);
    await audit.revise(to, [{ field: "sourceObservation", after: record }]);
  }

  await closeMoves(ctx, audit, { type: "series", id: source._id }, moves);

  await settlePositions(ctx, audit, source._id);
  await settlePositions(ctx, audit, targetId);
  await lockTitleIfContested(ctx, audit, targetId);
  if (moves.unfinished) return partial;
  return audit.wrote ? applied : already;
}

// ---------- stage 19: lines, researched Releases, cross-Series books ----------

/** Whether a record's creation Revision names this plan entry (how a re-run finds its own row). */
async function createdByEntry(ctx: MutationCtx, ref: Ref, key: string) {
  const created = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .first();
  return created?.changes.some((c) => c.field === SPLIT_KEY_FIELD && c.after === key) ?? false;
}

/** Hide an Edition Line nothing active sits in any more. */
async function hideEditionLine(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"hideEditionLine">,
): Promise<Result> {
  const line = await ctx.db.get(entry.lineId);
  if (!line) return skip("edition line missing");
  if (line.seriesId !== entry.seriesId) skip("edition line moved to another series");
  if (line.name !== entry.name) skip(`edition line renamed: ${JSON.stringify(line.name)}`);
  if (line.status === "hidden") return already;
  if (line.status !== "active") skip(`edition line is ${line.status}`);
  const members = await ctx.db
    .query("editions")
    .withIndex("by_line", (q) => q.eq("editionLineId", line._id))
    .collect();
  const live = members.find((edition) => edition.status === "active");
  if (live) skip(`edition line still holds edition ${live.publicId}`);
  await hide(ctx, audit, { type: "editionLine", id: line._id }, line);
  return applied;
}

/**
 * Create a researched Release on a new Edition covering existing Volumes.
 * The ISBN must be new everywhere (Releases and Release Bundles), except
 * for the Release an earlier run of this very entry created.
 */
async function createRelease(
  ctx: MutationCtx,
  audit: Audit,
  planned: EntryOf<"createRelease">,
): Promise<Result> {
  // Its ISBNs as their fields store them, for every check and the write.
  const entry = {
    ...planned,
    isbn13: plannedIsbn("isbn13", planned.isbn13),
    isbn10: plannedIsbn("isbn10", planned.isbn10),
  };
  const clashes = await ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", entry.isbn13))
    .collect();
  const own =
    clashes.length === 1 &&
    (await createdByEntry(ctx, { type: "release", id: clashes[0]!._id }, entry.key));
  if (own) return already;
  if (clashes.length > 0) return skip(`ISBN ${entry.isbn13} already exists`);
  const isbn10 = entry.isbn10;
  if (isbn10 !== null) {
    const clash10 = await ctx.db
      .query("releases")
      .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10))
      .first();
    if (clash10) skip(`ISBN-10 ${isbn10} already exists`);
  }
  const printed = await assignedIsbnRefusal(ctx, [entry.isbn13, isbn10 ?? undefined]);
  if (printed !== null) skip(printed);
  const bundle = await ctx.db
    .query("releaseBundles")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", entry.isbn13))
    .first();
  if (bundle) skip(`ISBN ${entry.isbn13} is Release Bundle ${bundle.publicId}`);
  if (entry.format === "digital" && entry.binding !== null)
    skip("plan error: binding on a digital release");
  const publisher = await ctx.db.get(entry.publisherId);
  if (!publisher || publisher.status !== "active") skip("publisher not active");

  const volumes: Doc<"volumes">[] = [];
  for (const row of entry.coverage) {
    const volume = await ctx.db.get(row.volumeId);
    if (!volume || volume.status !== "active") return skip(`volume ${row.volumeId} not active`);
    volumes.push(volume);
  }
  const unmapped = entry.unmappedSeriesId !== undefined;
  if (unmapped && (volumes.length > 0 || entry.line === null))
    return skip("plan error: an unmapped member states a line and no coverage");
  const seriesId = entry.unmappedSeriesId ?? volumes[0]?.seriesId;
  if (!seriesId) return skip("plan error: no coverage");
  const series = await ctx.db.get(seriesId);
  if (!series || series.status !== "active") return skip("series not active");

  const line = entry.line;
  const editionId = await createEdition(ctx, audit, {
    status: "active",
    publisherId: entry.publisherId,
    bootstrapUnreviewed: true,
    ...(unmapped ? { coverageUnmapped: true } : {}),
    ...(line
      ? {
          editionLineId: await findOrCreateLine(
            ctx,
            audit,
            series._id,
            entry.publisherId,
            line.name,
          ),
          ...(line.position === null ? {} : { linePosition: line.position }),
        }
      : {}),
  });
  await replaceCoverage(ctx, audit, editionId, entry.coverage);

  const fields = {
    status: "active" as const,
    editionId,
    format: entry.format,
    language: "en",
    isbn13: entry.isbn13,
    ...(isbn10 === null ? {} : { isbn10 }),
    ...(entry.binding === null ? {} : { binding: entry.binding }),
    ...(entry.pubDate === null ? {} : { pubDate: entry.pubDate }),
    ...(entry.price === null ? {} : { price: entry.price }),
    publisherId: entry.publisherId,
    seriesIds: unmapped ? [series._id] : [...new Set(volumes.map((v) => v.seriesId))],
    bootstrapUnreviewed: true,
  };
  const id = await ctx.db.insert("releases", fields);
  audit.op({ kind: "create", table: "releases", tempId: id, fields });
  await audit.revise({ type: "release", id }, [
    ...Object.entries(fields).map(([field, after]) => ({ field, after })),
    { field: SPLIT_KEY_FIELD, after: entry.key },
  ]);
  await refreshReleaseDenorms(ctx, editionId);
  return applied;
}

/** Why a createVolume entry's sources are not HTTPS pages citing more than Open Library, or null. */
function sourcesRefusal(sources: string[]): string | null {
  const hosts: string[] = [];
  for (const text of sources) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return `plan error: source ${JSON.stringify(text)} is not a URL`;
    }
    if (url.protocol !== "https:" || !url.hostname)
      return `plan error: source ${JSON.stringify(text)} is not an HTTPS page`;
    hosts.push(url.hostname.toLowerCase());
  }
  return hosts.some((host) => host !== "openlibrary.org" && !host.endsWith(".openlibrary.org"))
    ? null
    : "plan error: no source beyond Open Library";
}

/**
 * Create the one numbered backbone Volume a held Open Library edition is
 * missing. Every fact the plan states is re-read (drift = skip), and the
 * edition must still place, through the importer's own placeEdition, as
 * exactly this Series' missing Volume. A re-run finds its own Volume by the
 * creation Revision's entry key. Only the Volume is written: the hold, the
 * observation and its Release are left to the held book's native replay.
 */
async function createVolume(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"createVolume">,
): Promise<Result> {
  if (!(await getBootstrapMode(ctx))) return skip("Bootstrap Mode is off");
  const series = await ctx.db.get(entry.seriesId);
  if (!series || series.status !== "active" || series.mergedIntoId !== undefined)
    return skip("series not active");
  if (series.locked) return skip("series locked");
  if (series.title !== entry.seriesTitle)
    return skip(`series retitled: ${JSON.stringify(series.title)}`);
  if (!/^[1-9]\d*$/.test(entry.label))
    return skip("plan error: label is not a plain volume number");
  const sources = sourcesRefusal(entry.sources);
  if (sources) return skip(sources);

  // Every Volume of the Series, hidden and merged too: none may hold the label.
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", series._id))
    .collect();
  const labelled = volumes.filter((vol) => sameLabel(vol.label, entry.label));
  const [existing] = labelled;
  if (
    labelled.length === 1 &&
    existing?.status === "active" &&
    (await createdByEntry(ctx, { type: "volume", id: existing._id }, entry.key))
  )
    return already;
  if (existing)
    return skip(
      `series already has ${existing.status} Volume ${entry.label} (${existing.publicId})`,
    );
  const active = volumes
    .filter((vol) => vol.status === "active")
    .sort((a, b) => a.position - b.position)
    .map((vol) => ({ volumeId: vol._id, label: vol.label ?? null }));
  if (!sameValue(active, entry.expectedActiveVolumes))
    return skip("series' active Volumes differ from the plan");
  const contiguous = entry.expectedActiveVolumes.every((row, i) => row.label === String(i + 1));
  if (!contiguous || entry.label !== String(entry.expectedActiveVolumes.length + 1))
    return skip(`plan error: Volume ${entry.label} does not follow Volumes 1-n without a gap`);

  const hold = await ctx.db.get(entry.holdId);
  if (
    !hold ||
    hold.observationId !== entry.observationId ||
    hold.sourceKey !== "openlibrary" ||
    hold.kind !== "volumeMissing" ||
    hold.seriesId !== series._id ||
    (await holdOf(ctx, entry.observationId))?._id !== hold._id
  )
    return skip("hold no longer names this Series' missing Volume");
  const observation = await ctx.db.get(entry.observationId);
  if (
    !observation ||
    observation.sourceKey !== "openlibrary" ||
    observation.withdrawn ||
    observation.recordRef ||
    observation.printingIsbn13 !== undefined
  )
    return skip("observation is not a present, unlinked Open Library edition");
  const queued = observation.queuedProposalId
    ? await ctx.db.get(observation.queuedProposalId)
    : null;
  if (queued?.state === "draft" || queued?.state === "inReview")
    return skip(`observation's Proposal is ${queued.state}`);
  const effective = projectSourceFormat(observation);
  if (effective.status === "stale") return skip(effective.reason);
  const snapshot = effective.snapshot as OlEditionSnapshot;
  const isbn13 = toIsbn13(entry.isbn13);
  const stated = new Set(statedIsbns(snapshot).map(toIsbn13));
  if (
    isbn13 !== entry.isbn13 ||
    snapshot.kind !== "olEdition" ||
    stated.size !== 1 ||
    !stated.has(isbn13) ||
    snapshot.seriesTitle !== entry.seriesTitle ||
    snapshot.volumeLabel !== entry.label ||
    snapshot.multiVolume ||
    snapshot.packaging ||
    snapshot.bareNumber ||
    snapshot.bareRoman ||
    snapshot.bareSplit
  )
    return skip(
      "observation does not state this ISBN as an ordinary numbered Volume of the Series",
    );
  const placement = await placeEdition(ctx, snapshot);
  if (
    placement.kind !== "hold" ||
    placement.hold.kind !== "volumeMissing" ||
    placement.hold.seriesId !== series._id
  )
    return skip(`observation no longer places as this Series' missing Volume (${placement.kind})`);
  const scope = await isbnScope(ctx, isbn13);
  if (scope) return skip(scope);
  const claims = await storedClaims(ctx, isbn13);
  if (!claims?.complete || claims.printed || claims.raw.length > 0)
    return skip(`ISBN ${isbn13} already has an owner`);

  const volume = await ensureVolume(ctx, audit, series._id, entry.label, entry.key);
  audit.note(`created Volume ${volume.publicId} (${entry.label}) of Series ${series.publicId}`);
  return applied;
}

/**
 * A Release Bundle whose members may sit in several Series: extend one, or
 * turn a box-set Release into one (its Collection Entries pass to the
 * bundle, entriesToBundle). Members keep the plan's order; a member
 * already in the bundle at another order is drift.
 */
async function releaseBundle(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"releaseBundle">,
): Promise<Result> {
  const r = reader(ctx);
  let bundle: Doc<"releaseBundles"> | null = null;
  let box: Doc<"releases"> | null = null;
  let isbns: { isbn13?: string; isbn10?: string } = {};
  let converted = false;
  if (entry.bundleId !== null && entry.box === null) {
    bundle = await r.active(entry.bundleId);
  } else if (entry.box !== null && entry.bundleId === null) {
    box = await ctx.db.get(entry.box.releaseId);
    if (!box) return skip("box-set release missing");
    const read = bundleIsbns(box);
    if ("refusal" in read) return skip(read.refusal);
    isbns = read;
    if (!isbns.isbn13) skip("box-set release has no ISBN");
    bundle = await ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbns.isbn13))
      .unique();
    if (bundle) {
      if (
        bundle.locked ||
        bundle.status !== "active" ||
        bundle.publisherId !== box.publisherId ||
        bundle.format !== box.format
      )
        skip("Existing Bundle identity or eligibility differs.");
      converted = Boolean(await convertedClaim(ctx, box, bundle));
      if (!converted) {
        const origin = await ctx.db
          .query("repairBundleOrigins")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id))
          .unique();
        if (origin?.releaseId !== box._id || origin.entryKey !== entry.key) {
          if (!entry.expectedConversion)
            skip("An existing Bundle conversion needs a current expectedConversion guard.");
          const state = await conversionState(ctx, box._id, bundle._id);
          if (state.expected !== entry.expectedConversion) skip("Conversion state drifted.");
          const planned = entry.members.map((m) => ({
            isbn13: toIsbn13(m.isbn13),
            order: m.order,
          }));
          const actual = state.contents.map((c, i) => ({
            isbn13: toIsbn13(c.release.isbn13),
            order: state.members[i]!.order,
          }));
          if (!sameValue(planned, actual))
            skip("Conversion needs the exact complete member set and order.");
          if (entry.retireVolumeIds.length)
            skip("Placeholder retirement requires a separate preservation-backed repair.");
        }
      }
    }
    if (!converted) {
      await boxConversionPreflight(ctx, box, bundle?._id, entry.retireVolumeIds);
      await conversionClaims(ctx, box, bundle);
    }
  } else if (entry.create && entry.bundleId === null && entry.box === null) {
    // A box set no Release stands for: the Bundle is made from its stated
    // facts, or found again by the entry that made it.
    const isbn13 = toIsbn13(entry.create.isbn13);
    if (!isbn13) return skip("plan error: the box set's ISBN is not an ISBN");
    const existing = await ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .unique();
    if (
      existing &&
      !(await createdByEntry(ctx, { type: "releaseBundle", id: existing._id }, entry.key))
    )
      return skip(`ISBN ${isbn13} is already Bundle ${existing.publicId}`);
    if (!existing) {
      const claims = await isbnClaims(ctx, isbn13, {
        resolver: claimResolver(ctx, { room: r.room }),
        room: r.room,
      });
      if (!claims?.complete || claims.owners.size > 0)
        return skip(`ISBN ${isbn13} is claimed: convert its box Release instead`);
    }
    // An ISBN-10 is stored only as the same book's other spelling, so the
    // ISBN-13's claims above stand for it too.
    const isbn10 = entry.create.isbn10 ? plannedIsbn("isbn10", entry.create.isbn10) : null;
    if (isbn10 !== null && toIsbn13(isbn10) !== isbn13)
      return skip(`plan error: ISBN-10 ${isbn10} is not ISBN ${isbn13}'s`);
    bundle = existing;
    isbns = { isbn13, ...(isbn10 === null ? {} : { isbn10 }) };
  } else skip("plan error: name a bundle, a box set, or a box set to create");

  const publisherId = bundle?.publisherId ?? box?.publisherId ?? entry.create!.publisherId;
  const format = bundle?.format ?? box?.format ?? entry.create!.format;
  const selected = await conversionMembers(ctx, entry.members, publisherId, format, box?._id);
  const current = bundle
    ? await r.many(
        ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id)),
      )
    : [];
  // An origin continuation may still lack members, but must not gain other contents.
  if (
    box &&
    current.some((m) => !selected.some((p) => p.release._id === m.releaseId && p.order === m.order))
  )
    skip("Existing Bundle has unplanned members or order.");
  if (converted) {
    if (current.length !== selected.length) skip("Converted Bundle members drifted.");
    for (const id of entry.retireVolumeIds) {
      const volume = await ctx.db.get(id);
      if (!volume || volume.status === "active") skip("Converted placeholder retirement drifted.");
    }
    return already;
  }
  for (const member of selected) {
    const row = current.find((m) => m.releaseId === member.release._id);
    if (row && row.order !== member.order)
      skip(`member ${member.release.isbn13} sits at order ${row.order}`);
    if (!row && current.some((m) => m.order === member.order))
      skip(`order ${member.order} is taken by another member`);
  }
  // Every dependency and personal reference has been read before the first effect.
  if (!bundle) {
    await audit.meta();
    const created = entry.create;
    const fields = {
      status: "active" as const,
      publicId: await allocatePublicId(ctx, "bundle"),
      name: box ? entry.box!.name : created!.name,
      publisherId,
      format,
      isbn13: isbns.isbn13,
      isbn10: isbns.isbn10,
      pubDate: box ? box.pubDate : (created!.pubDate ?? undefined),
      price: box ? box.price : (created!.price ?? undefined),
      description: box ? box.description : undefined,
      coverImage: box ? box.coverImage : undefined,
      bootstrapUnreviewed: true,
    };
    const id = await ctx.db.insert("releaseBundles", fields);
    if (box) {
      await ctx.db.insert("repairBundleOrigins", {
        bundleId: id,
        releaseId: box._id,
        entryKey: entry.key,
        proposalId: (await audit.meta()).proposalId,
      });
    }
    audit.op({ kind: "create", table: "releaseBundles", tempId: id, fields });
    await audit.revise({ type: "releaseBundle", id }, [
      ...Object.entries(fields)
        .filter(([, after]) => after !== undefined)
        .map(([field, after]) => ({ field, after })),
      ...(box ? [] : [{ field: SPLIT_KEY_FIELD, after: entry.key }]),
    ]);
    bundle = await ctx.db.get(id);
  }
  if (!bundle) return skip("bundle vanished");
  const bundleRef = { type: "releaseBundle" as const, id: bundle._id };
  const moves = newMoves(entry.key);
  const seriesBefore = await bundleSeries(ctx, bundle._id);
  for (const member of selected) {
    if (current.some((m) => m.releaseId === member.release._id)) continue;
    await audit.meta();
    await ctx.db.insert("bundleMemberships", {
      bundleId: bundle._id,
      releaseId: member.release._id,
      order: member.order,
    });
    const change = {
      field: "member",
      after: `release ${member.release.isbn13 ?? member.release._id} (order ${member.order})`,
    };
    audit.op({ kind: "update", ref: bundleRef, changes: [change] });
    await audit.revise(bundleRef, [change]);
  }
  await carryBundleOwners(ctx, trailSink(ctx, audit, moves), bundle._id, seriesBefore);
  if (box && (await entriesToBundle(ctx, audit, moves, box, bundle._id))) {
    await completeBoxConversion(ctx, audit, box, bundle);
    const edition = await ctx.db.get(box.editionId);
    const live = (await releasesOf(ctx, box.editionId)).filter((r) => r.status === "active");
    if (edition && !live.length)
      await hide(ctx, audit, { type: "edition", id: edition._id }, edition);
  }
  await closeMoves(ctx, audit, box ? { type: "release", id: box._id } : bundleRef, moves);
  if (moves.unfinished) return partial;
  await retireVolumes(
    ctx,
    audit,
    entry.retireVolumeIds,
    selected[0]?.contents[0]?.volume._id ?? null,
  );
  return audit.wrote ? applied : already;
}

/**
 * Point an Edition's coverage at Volumes of any Series (an omnibus or an
 * anthology spanning works), optionally place it in a line, and retire the
 * Volumes its old coverage leaves empty.
 */
async function setCoverage(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"setCoverage">,
): Promise<Result> {
  const edition = await ctx.db.get(entry.editionId);
  if (!edition || edition.status !== "active") return skip("edition not active");
  if (edition.locked) skip("edition locked");
  const rows: Array<{ volumeId: Id<"volumes">; extent: "complete" | "partial" }> = [];
  for (const row of entry.coverage) {
    const matches = (await activeVolumes(ctx, row.seriesId)).filter((v) =>
      sameLabel(v.label, row.label),
    );
    const volume = matches[0];
    if (!volume || matches.length > 1) {
      return skip(
        `series ${row.seriesId} has ${matches.length} active volumes labelled ${JSON.stringify(row.label)}`,
      );
    }
    rows.push({ volumeId: volume._id, extent: row.extent });
  }
  if (entry.unmapped) return await unmapIntoLine(ctx, audit, entry, edition, rows.length);
  if (rows.length === 0) return skip("plan error: empty coverage");

  if (entry.clearLine && entry.line !== null)
    return skip("plan error: clearLine takes the Edition out of its line, so states none");
  const current = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
  const done =
    current.length === rows.length &&
    current.every((c, i) => c.volumeId === rows[i]?.volumeId && c.extent === rows[i]?.extent) &&
    !(entry.clearLine && edition.editionLineId !== undefined);
  if (
    !done &&
    !sameValue(
      current.map((c) => c.volumeId),
      entry.before,
    )
  ) {
    skip(`edition ${edition.publicId} coverage drifted`);
  }
  // The Edition's trackers keep their Tracking Visibility wherever its
  // coverage (or line) takes its Releases' Series (carryingTracking).
  const moves = newMoves(entry.key);
  await carryingTracking(ctx, audit, moves, { editionIds: [edition._id] }, async () => {
    await replaceCoverage(ctx, audit, edition._id, rows);
    await updateRecord(ctx, audit, { type: "edition", id: edition._id }, edition, {
      coverageUnmapped: undefined,
      ...(entry.clearLine ? { editionLineId: undefined, linePosition: undefined } : {}),
    });

    if (entry.line) {
      const { seriesId, name, position } = entry.line;
      let covers = false;
      for (const row of rows) covers ||= (await ctx.db.get(row.volumeId))?.seriesId === seriesId;
      if (!covers) skip("plan error: the line's series is not covered");
      const lineId = await findOrCreateLine(ctx, audit, seriesId, edition.publisherId, name);
      const fresh = await ctx.db.get(edition._id);
      if (!fresh) return skip("edition vanished");
      await updateRecord(ctx, audit, { type: "edition", id: fresh._id }, fresh, {
        editionLineId: lineId,
        linePosition: position ?? undefined,
      });
    }
  });
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  if (moves.unfinished) return partial;
  await retireVolumes(ctx, audit, entry.retireVolumeIds, rows[0]!.volumeId);
  return audit.wrote ? applied : already;
}

/**
 * setCoverage's `unmapped` form: the Edition becomes Unmapped Packaging in
 * the planned line, its coverage removed and `coverageUnmapped` set. The
 * coverage it has now must be the plan's `before` (drift = skip).
 */
async function unmapIntoLine(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"setCoverage">,
  edition: Doc<"editions">,
  plannedRows: number,
): Promise<Result> {
  if (plannedRows > 0 || entry.line === null)
    return skip("plan error: an unmapped member states a line and no coverage");
  const { seriesId, name, position } = entry.line;
  const current = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
  const line = edition.editionLineId ? await ctx.db.get(edition.editionLineId) : null;
  const done =
    current.length === 0 &&
    edition.coverageUnmapped === true &&
    line?.seriesId === seriesId &&
    line.name === name &&
    (edition.linePosition ?? null) === position;
  if (done) return already;
  if (
    !sameValue(
      current.map((c) => c.volumeId),
      entry.before,
    )
  ) {
    skip(`edition ${edition.publicId} coverage drifted`);
  }
  const moves = newMoves(entry.key);
  await carryingTracking(ctx, audit, moves, { editionIds: [edition._id] }, async () => {
    const lineId = await findOrCreateLine(ctx, audit, seriesId, edition.publisherId, name);
    await updateRecord(ctx, audit, { type: "edition", id: edition._id }, edition, {
      editionLineId: lineId,
      linePosition: position ?? undefined,
      coverageUnmapped: true,
    });
    await replaceCoverage(ctx, audit, edition._id, []);
    await refreshReleaseDenorms(ctx, edition._id);
  });
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  if (moves.unfinished) return partial;
  await retireVolumes(ctx, audit, entry.retireVolumeIds, null);
  return audit.wrote ? applied : already;
}

/** Group the plan's Series in one Series Family, created by name when none is active. */
async function seriesFamily(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"seriesFamily">,
): Promise<Result> {
  const rows: Array<Doc<"series">> = [];
  for (const planned of entry.series) {
    const series = await ctx.db.get(planned.seriesId);
    if (!series || series.status !== "active") return skip(`series ${planned.seriesId} not active`);
    if (series.title !== planned.title)
      return skip(`series ${series.publicId} title drifted: ${JSON.stringify(series.title)}`);
    rows.push(series);
  }
  let family = (
    await ctx.db
      .query("seriesFamilies")
      .withIndex("by_name", (q) => q.eq("name", entry.name))
      .collect()
  ).find((one) => one.status === "active");
  for (const series of rows) {
    if (series.familyId !== undefined && series.familyId !== family?._id)
      return skip(`series ${series.publicId} is already in another family`);
  }
  if (!family) {
    await audit.meta();
    const fields = { status: "active" as const, name: entry.name, bootstrapUnreviewed: true };
    const id = await ctx.db.insert("seriesFamilies", fields);
    audit.op({ kind: "create", table: "seriesFamilies", tempId: id, fields });
    await audit.revise(
      { type: "seriesFamily", id },
      Object.entries(fields).map(([field, after]) => ({ field, after })),
    );
    family = (await ctx.db.get(id))!;
  }
  // The plan's Series follow, in its order, the members it does not name, so
  // an entry adding one Part to an existing Family shelves it after the rest.
  const familyId = family._id;
  const planned = new Set(rows.map((series) => series._id));
  const members = await ctx.db
    .query("series")
    .withIndex("by_family", (q) => q.eq("familyId", familyId))
    .collect();
  const placed = rows.map((series) => series.familyPosition);
  const inOrder =
    rows.every((series) => series.familyId === familyId) &&
    placed.every((at, i) => at !== undefined && (i === 0 || at > (placed[i - 1] ?? 0)));
  if (inOrder) return already;
  const after = members
    .filter((series) => series.status === "active" && !planned.has(series._id))
    .reduce((max, series) => Math.max(max, series.familyPosition ?? 0), 0);
  for (const [i, series] of rows.entries()) {
    await updateRecord(ctx, audit, { type: "series", id: series._id }, series, {
      familyId,
      familyPosition: after + i + 1,
    });
  }
  return audit.wrote ? applied : already;
}

/** Move the planned Releases out of an Edition into a new one (entries.ts splitEditionEntry). */
async function splitEdition(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"splitEdition">,
): Promise<Result> {
  const unmapped = entry.unmapped === true;
  if (entry.releaseIds.length === 0 || entry.keepReleaseIds.length === 0)
    return skip("plan error: a split moves some Releases and keeps some");
  if (unmapped ? entry.coverage.length > 0 || entry.line === null : entry.coverage.length === 0)
    return skip("plan error: state coverage, or a line and no coverage when unmapped");
  const edition = await ctx.db.get(entry.editionId);
  if (!edition || edition.status !== "active") return skip("edition not active");
  if (edition.locked) return skip(`edition ${edition.publicId} is locked`);

  const moving: Array<Doc<"releases">> = [];
  for (const id of entry.releaseIds) {
    const release = await ctx.db.get(id);
    if (!release || release.status !== "active") return skip(`release ${id} not active`);
    moving.push(release);
  }
  const elsewhere = new Set(moving.map((r) => r.editionId).filter((id) => id !== edition._id));
  if (elsewhere.size > 1) return skip("the planned Releases sit in several Editions");
  const kept = (await releasesOf(ctx, edition._id)).filter((r) => r.status === "active");
  const expected =
    elsewhere.size === 0 ? [...entry.keepReleaseIds, ...entry.releaseIds] : entry.keepReleaseIds;
  if (!sameValue(idSet(kept.map((r) => r._id)), idSet(expected)))
    return skip(
      `edition ${edition.publicId} releases drifted: now ${kept.map((r) => r.isbn13 ?? r._id).join(", ")}`,
    );

  // A re-run finds the planned Releases already moved: only an Edition this
  // entry created, still holding exactly them, is its own to finish.
  let targetId = [...elsewhere][0];
  const rerun = targetId ? await ctx.db.get(targetId) : null;
  if (targetId) {
    if (!rerun || rerun.status !== "active") return skip("split-off edition not active");
    if (rerun.locked) return skip(`edition ${rerun.publicId} is locked`);
    if (!(await createdByEntry(ctx, { type: "edition", id: targetId }, entry.key)))
      return skip(
        `the planned Releases sit in edition ${rerun.publicId}, which this entry did not create`,
      );
    const holds = (await releasesOf(ctx, targetId)).filter((r) => r.status === "active");
    if (!sameValue(idSet(holds.map((r) => r._id)), idSet(entry.releaseIds)))
      return skip(`edition ${rerun.publicId} releases drifted since the split`);
  }

  const moves = newMoves(entry.key);
  await carryingTracking(
    ctx,
    audit,
    moves,
    { editionIds: [edition._id, ...(targetId ? [targetId] : [])] },
    async () => {
      if (!targetId) {
        targetId = await createEdition(
          ctx,
          audit,
          {
            status: "active",
            publisherId: edition.publisherId,
            bootstrapUnreviewed: true,
            ...(unmapped ? { coverageUnmapped: true } : {}),
          },
          entry.key,
        );
        for (const release of moving) {
          await updateRecord(ctx, audit, { type: "release", id: release._id }, release, {
            editionId: targetId,
          });
        }
      }
      const rows: Parameters<typeof replaceCoverage>[3] = [];
      for (const row of entry.coverage) {
        rows.push({
          volumeId: (await ensureVolume(ctx, audit, row.seriesId, row.label))._id,
          extent: row.extent,
        });
      }
      if (rerun) {
        // The split already wrote its coverage; anything else is a later edit.
        const now = (await coverageOf(ctx, targetId)).sort((a, b) => a.order - b.order);
        const planned = rows.map((r) => [r.volumeId, r.extent]);
        if (
          now.length > 0 &&
          !sameValue(
            now.map((c) => [c.volumeId, c.extent]),
            planned,
          )
        )
          return skip(`edition ${rerun.publicId} coverage drifted since the split`);
      }
      await replaceCoverage(ctx, audit, targetId, rows);
      if (entry.line) {
        const target = await ctx.db.get(targetId);
        if (!target) return skip("new edition vanished");
        const lineId = await findOrCreateLine(
          ctx,
          audit,
          entry.line.seriesId,
          target.publisherId,
          entry.line.name,
        );
        if (rerun?.editionLineId !== undefined && rerun.editionLineId !== lineId)
          return skip(`edition ${rerun.publicId} moved to another line since the split`);
        await updateRecord(ctx, audit, { type: "edition", id: targetId }, target, {
          editionLineId: lineId,
          linePosition: entry.line.position ?? undefined,
        });
      }
      await refreshReleaseDenorms(ctx, targetId);
      await refreshReleaseDenorms(ctx, edition._id);
    },
  );
  await closeMoves(ctx, audit, { type: "edition", id: edition._id }, moves);
  if (moves.unfinished) return partial;
  return audit.wrote ? applied : already;
}

/** Add one numbered or named extra Volume to a Series (entries.ts addVolumeEntry). */
async function addVolume(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"addVolume">,
): Promise<Result> {
  const series = await ctx.db.get(entry.seriesId);
  if (!series || series.status !== "active") return skip("series not active");
  if (series.locked) return skip(`series ${series.publicId} is locked`);
  if (series.title !== entry.seriesTitle)
    return skip(`series ${series.publicId} title drifted: ${JSON.stringify(series.title)}`);
  const volumes = await activeVolumes(ctx, series._id);
  const label = canonicalLabel(entry.label);
  if (label === null) return skip("plan error: a Volume to add needs a label");
  if (volumes.some((v) => sameLabel(v.label, label))) return already;
  await audit.meta();
  const fields = {
    status: "active" as const,
    publicId: await allocatePublicId(ctx, "volume"),
    seriesId: series._id,
    label,
    position: labelNumber(label) ?? volumes.reduce((max, v) => Math.max(max, v.position), 0) + 1,
    bootstrapUnreviewed: true,
  };
  const id = await ctx.db.insert("volumes", fields);
  audit.op({ kind: "create", table: "volumes", tempId: id, fields });
  await audit.revise({ type: "volume", id }, [
    ...Object.entries(fields).map(([field, after]) => ({ field, after })),
    { field: SPLIT_KEY_FIELD, after: entry.key },
  ]);
  return applied;
}
