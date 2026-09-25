// The one-time catalog repair's operations, one per plan-entry kind. Each
// validates that the rows still look the way the plan expected (skipping
// with a reason on drift instead of clobbering), is idempotent (a re-run
// reports alreadyApplied), and writes through the stock sensitive-op apply
// functions where they fit: Hide, Restore, and Merge for volumes, editions, releases,
// and — once its Volumes are placed — Series. The stock Series merge appends
// loser Volumes after the survivor's, so Volumes are placed by label first.

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { allocatePublicId } from "../publicIds";
import {
  DUPLICATE_SLUGS,
  IMPRINT_PARENTS,
  canonicalPublisherFor,
} from "../publishers";
import { applyHide, applyMerge, applyRestore } from "../sensitiveOps";
import { sameValue } from "../values";
import {
  activeEditionsCovering,
  activeVolumes,
  canonicalLabel,
  coverageOf,
  createEdition,
  ensureVolume,
  labelNumber,
  refreshReleaseDenorms,
  releasesOf,
  replaceCoverage,
  sameLabel,
  settlePositions,
  skip,
  updateRecord,
  type Audit,
  type Ref,
} from "./audit";
import type { EntryOf, Outcome, RepairEntry } from "./entries";

type Status = Outcome["status"];
type Result = { status: Status; reason?: string };

const applied: Result = { status: "applied" };
const already: Result = { status: "alreadyApplied" };

/** Dispatch one plan entry to its operation. */
export async function applyEntry(ctx: MutationCtx, audit: Audit, entry: RepairEntry): Promise<Result> {
  switch (entry.kind) {
    case "publisherMerge":
      return await publisherMerge(ctx, audit, entry);
    case "publisherParent":
      return await publisherParent(ctx, audit, entry);
    case "editionPublisher":
      return await editionPublisher(ctx, audit, entry);
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
    case "releaseBundle":
      return await releaseBundle(ctx, audit, entry);
    case "setCoverage":
      return await setCoverage(ctx, audit, entry);
  }
}

/**
 * Withdraw a source-authored In-Review Proposal nobody has claimed or noted,
 * and unlink it from its observation. No catalog record changes, so there is
 * no Revision; the Proposal's own state is the audit trail.
 */
async function withdrawProposal(ctx: MutationCtx, entry: EntryOf<"withdrawProposal">): Promise<Result> {
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
async function hide(ctx: MutationCtx, audit: Audit, ref: Ref, doc: { status: string; locked?: boolean }) {
  if (doc.status !== "active") return false;
  if (doc.locked) skip(`${ref.type} ${ref.id} is locked`);
  audit.op({ kind: "hide", ref });
  await applyHide(ctx, ref, await audit.meta());
  return true;
}

/** Restore a record through the stock Restore unless it already is active. */
async function restore(ctx: MutationCtx, audit: Audit, ref: Ref, doc: { status: string; locked?: boolean }) {
  if (doc.status === "active") return false;
  if (doc.locked) skip(`${ref.type} ${ref.id} is locked`);
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
  const editions = await ctx.db
    .query("editions")
    .withIndex("by_publisher", (q) => q.eq("publisherId", loser._id))
    .take(PUBLISHER_CHUNK);
  const straysLeft = editions.length === 0
    ? await ctx.db
        .query("releases")
        .withIndex("by_publisher_date", (q) => q.eq("publisherId", loser._id))
        .take(PUBLISHER_CHUNK)
    : [];
  if (editions.length > 0 || straysLeft.length > 0) {
    const { proposalId } = await audit.meta();
    const repointed: Array<{ table: string; docId: string; field: string; before: Id<"publishers">; after: Id<"publishers"> }> = [];
    for (const edition of editions) {
      await ctx.db.patch(edition._id, { publisherId: survivor._id });
      repointed.push({ table: "editions", docId: edition._id, field: "publisherId", before: loser._id, after: survivor._id });
      for (const release of await releasesOf(ctx, edition._id)) {
        if (release.publisherId !== loser._id) continue;
        await ctx.db.patch(release._id, { publisherId: survivor._id });
        repointed.push({ table: "releases", docId: release._id, field: "publisherId", before: loser._id, after: survivor._id });
      }
    }
    for (const release of straysLeft) {
      await ctx.db.patch(release._id, { publisherId: survivor._id });
      repointed.push({ table: "releases", docId: release._id, field: "publisherId", before: loser._id, after: survivor._id });
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
    return { status: "partial", reason: `repointed ${editions.length} editions, ${repointed.length - editions.length} releases` };
  }
  await merge(ctx, audit, { type: "publisher", id: survivor._id }, { type: "publisher", id: loser._id });
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

async function editionPublisher(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"editionPublisher">,
): Promise<Result> {
  const edition = await ctx.db.get(entry.editionId);
  if (!edition || edition.status !== "active") return skip("edition not active");
  if (edition.publisherId === entry.toPublisherId) return already;
  const current = await ctx.db.get(edition.publisherId);
  const from = await ctx.db.get(entry.fromPublisherId);
  const to = await ctx.db.get(entry.toPublisherId);
  if (!current || !from || !to || to.status !== "active") return skip("publisher rows missing");
  if (companySlug(current.slug) !== companySlug(from.slug)) {
    skip(`edition is on ${current.slug}, plan expected ${from.slug}`);
  }
  if (entry.imprint !== null) {
    // Owner rule: PRH's imprint outranks Seven Seas/OpenLibrary attribution
    // to the parent, but only toward a known imprint of the same company.
    const resolved = canonicalPublisherFor(entry.imprint);
    if (!resolved || resolved.parentSlug === undefined) skip(`"${entry.imprint}" is not a known imprint`);
    if (companySlug(resolved!.slug) !== to.slug) skip(`"${entry.imprint}" resolves to ${resolved!.slug}, not ${to.slug}`);
    if (resolved!.parentSlug !== companySlug(from.slug)) {
      skip(`${resolved!.slug} is not an imprint of ${companySlug(from.slug)}`);
    }
    const releaseIds = new Set((await releasesOf(ctx, edition._id)).map((r) => r._id));
    let stillEvidenced = false;
    for (const observationId of entry.observationIds) {
      const observation = await ctx.db.get(observationId);
      const ref = observation?.recordRef;
      const snapshot: { imprint?: unknown } | undefined = observation?.snapshot;
      if (ref?.type === "release" && releaseIds.has(ref.id) && snapshot?.imprint === entry.imprint) {
        stillEvidenced = true;
      }
    }
    if (!stillEvidenced) skip("the PRH imprint evidence is no longer linked");
  }
  if (edition.editionLineId) {
    const line = await ctx.db.get(edition.editionLineId);
    if (line && line.publisherId !== to._id) skip("edition sits in another publisher's edition line");
  }
  await updateRecord(ctx, audit, { type: "edition", id: edition._id }, edition, { publisherId: to._id });
  await refreshReleaseDenorms(ctx, edition._id);
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
      if (release.status === "active" && !releaseIds.has(release._id)) skip("edition gained a release");
    }
  }
  const releases = [];
  for (const id of entry.releaseIds) {
    const release = await ctx.db.get(id);
    if (!release || !editionIds.has(release.editionId)) skip(`release ${id} moved`);
    releases.push(release!);
  }

  let changed = false;
  for (const release of releases) changed = (await hide(ctx, audit, { type: "release", id: release._id }, release)) || changed;
  for (const edition of editions) changed = (await hide(ctx, audit, { type: "edition", id: edition._id }, edition)) || changed;
  for (const volume of volumes) changed = (await hide(ctx, audit, { type: "volume", id: volume._id }, volume)) || changed;
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
  if (entry.editionId !== null && release.editionId !== entry.editionId) skip("release moved to another edition");
  let changed = await hide(ctx, audit, { type: "release", id: release._id }, release);

  // The Edition and Volumes follow only once nothing active is left under
  // them, so entries sharing an Edition converge in any order.
  if (entry.editionId !== null) {
    const edition = await ctx.db.get(entry.editionId);
    const liveReleases = (await releasesOf(ctx, entry.editionId)).filter((r) => r.status === "active");
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
  const volumeIds = unique(target.type === "volume" ? [target.id, ...entry.volumeIds] : entry.volumeIds);
  const editionIds = unique(target.type === "edition" ? [target.id, ...entry.editionIds] : entry.editionIds);
  const releaseIds = unique(target.type === "release" ? [target.id, ...entry.releaseIds] : entry.releaseIds);

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
    if (target.type === "series" && volume.seriesId !== target.id) skip(`volume ${volume.publicId} left the series`);
    if (!(await liveAfter(volume.seriesId))) skip(`volume ${volume.publicId}'s series stays hidden`);
  }
  for (const edition of editions) {
    const coverage = await coverageOf(ctx, edition._id);
    if (coverage.length === 0) skip(`edition ${edition.publicId} covers no volume`);
    for (const cover of coverage) {
      if (!(await liveAfter(cover.volumeId))) skip(`edition ${edition.publicId} covers a volume that stays hidden`);
      const volume = await ctx.db.get(cover.volumeId);
      if (volume && !(await liveAfter(volume.seriesId))) skip(`edition ${edition.publicId}'s series stays hidden`);
    }
  }
  for (const release of releases) {
    if (!(await liveAfter(release.editionId))) skip(`release ${release._id} sits on an edition that stays hidden`);
  }

  let changed = false;
  for (const doc of series) changed = (await restore(ctx, audit, { type: "series", id: doc._id }, doc)) || changed;
  for (const doc of volumes) changed = (await restore(ctx, audit, { type: "volume", id: doc._id }, doc)) || changed;
  for (const doc of editions) changed = (await restore(ctx, audit, { type: "edition", id: doc._id }, doc)) || changed;
  for (const doc of releases) changed = (await restore(ctx, audit, { type: "release", id: doc._id }, doc)) || changed;
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
  if (!ref) return already;
  if (ref.type !== entry.recordType || ref.id !== entry.recordId) {
    return skip(`observation now links ${ref.type} ${ref.id}`);
  }
  await audit.meta();
  await ctx.db.patch(observation._id, { recordRef: undefined });
  const source = `${observation.sourceKey} ${observation.sourceRecordId}`;
  audit.op({ kind: "update", ref, changes: [{ field: "sourceObservation", before: source }] });
  await audit.revise(ref, [{ field: "sourceObservation", before: source }]);
  return applied;
}

// ---------- stage 3: series merges ----------

/** Follow a Volume's merge pointers to the active Volume it now lives on. */
async function liveVolume(ctx: MutationCtx, id: Id<"volumes"> | null) {
  let volume = id ? await ctx.db.get(id) : null;
  for (let hops = 0; volume && volume.status === "merged" && volume.mergedIntoId && hops < 5; hops++) {
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
    return TITLE_AUTHORITIES.has(observation.sourceKey) && typeof snapshot.title === "string" && snapshot.title !== series.title;
  });
  if (!contested) return;
  await updateRecord(ctx, audit, { type: "series", id: seriesId }, series, {
    overriddenFields: [...(series.overriddenFields ?? []), "title"].sort(),
  });
}

async function retitleSeries(ctx: MutationCtx, audit: Audit, seriesId: Id<"series">, title: string) {
  const series = await ctx.db.get(seriesId);
  if (!series || series.title === title) return;
  await updateRecord(ctx, audit, { type: "series", id: seriesId }, series, {
    title,
    searchText: [title, ...series.altTitles].join(" "),
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

  for (const placement of entry.placements) {
    const volume = await ctx.db.get(placement.volumeId);
    if (!volume) skip(`volume ${placement.volumeId} missing`);
    if (volume!.status === "merged") {
      const home = await liveVolume(ctx, volume!._id);
      if (home?.seriesId !== survivor._id) skip(`volume ${volume!.publicId} merged outside the survivor`);
      continue;
    }
    if (volume!.status !== "active") continue; // hidden since planning: nothing to place
    if (volume!.seriesId === survivor._id) continue;
    if (volume!.seriesId !== loser._id) skip(`volume ${volume!.publicId} left the loser`);
    await placeVolume(ctx, audit, volume!, survivor._id, placement);
  }
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
 * Volume the plan names (or the one with the same label), else move it
 * across with its label, at position = its number.
 */
async function placeVolume(
  ctx: MutationCtx,
  audit: Audit,
  volume: Doc<"volumes">,
  survivorId: Id<"series">,
  placement: { label: string | null; intoVolumeId: Id<"volumes"> | null },
) {
  const survivorVolumes = await activeVolumes(ctx, survivorId);
  let target = await liveVolume(ctx, placement.intoVolumeId);
  if (target && target.seriesId !== survivorId) target = null;
  if (!target && placement.label !== null) {
    const matches = survivorVolumes.filter((v) => sameLabel(v.label, placement.label));
    if (matches.length > 1) skip(`survivor has ${matches.length} volumes labelled "${placement.label}"`);
    target = matches[0] ?? null;
  }
  if (target) {
    if (target.locked || volume.locked) skip("volume locked");
    await merge(ctx, audit, { type: "volume", id: target._id }, { type: "volume", id: volume._id });
    return;
  }
  const label = canonicalLabel(placement.label);
  const maxPosition = survivorVolumes.reduce((max, v) => Math.max(max, v.position), 0);
  await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
    seriesId: survivorId,
    label: label ?? undefined,
    position: labelNumber(label) ?? maxPosition + 1,
  });
  for (const row of await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
    .collect()) {
    await refreshReleaseDenorms(ctx, row.editionId);
  }
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
  const fields = { status: "active" as const, seriesId, publisherId, name, bootstrapUnreviewed: true };
  const id = await ctx.db.insert("editionLines", fields);
  audit.op({ kind: "create", table: "editionLines", tempId: id, fields });
  await audit.revise({ type: "editionLine", id }, Object.entries(fields).map(([field, after]) => ({ field, after })));
  return id;
}

/** The publisher rows one company answers to: itself, its parent, its imprints. */
async function companyRows(ctx: MutationCtx, publisherId: Id<"publishers">) {
  const row = await ctx.db.get(publisherId);
  const ids = new Set<Id<"publishers">>([publisherId]);
  if (row?.parentPublisherId) ids.add(row.parentPublisherId);
  const imprints = await ctx.db
    .query("publishers")
    .withIndex("by_parent", (q) => q.eq("parentPublisherId", publisherId))
    .collect();
  for (const imprint of imprints) ids.add(imprint._id);
  return ids;
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
    if ((await coverageOf(ctx, edition._id)).length !== 1) continue;
    for (const release of await releasesOf(ctx, edition._id)) {
      if (release.status === "active" && release.format === format) candidates.push(release);
    }
  }
  candidates.sort((a, b) => (a.pubDate?.sort ?? Infinity) - (b.pubDate?.sort ?? Infinity));
  return candidates[0] ?? null;
}

async function remodelEdition(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"remodelEdition">,
): Promise<Result> {
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
        expected[i]?.volumeId ? row.volumeId === expected[i]?.volumeId : sameLabel(labels[i], expected[i]?.label),
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
          await updateRecord(ctx, audit, { type: "release", id: release._id }, release, { editionId });
        }
      } else continue;
    }
    const rows = [];
    for (const cover of group.coverage) {
      rows.push({ volumeId: (await coveredVolume(ctx, audit, target._id, cover))._id, extent: cover.extent });
    }
    if (rows.length > 0) await replaceCoverage(ctx, audit, editionId, rows);
    await placeInLine(editionId, group.linePosition);
    await refreshReleaseDenorms(ctx, editionId);
  }
  if (entry.groups.length === 0) {
    await placeInLine(edition._id, null);
    audit.note("coverage left for review");
  }

  const first = entry.groups.find((g) => g.coverage.length > 0)?.coverage[0];
  const firstVolume = first ? await coveredVolume(ctx, audit, target._id, first) : null;
  await retireVolumes(ctx, audit, entry.retireVolumeIds, firstVolume?._id ?? null);
  await settlePositions(ctx, audit, target._id);
  return audit.wrote ? applied : already;
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

/** An existing bundle for this box-set Release: same ISBN, else same name/publisher/format. */
async function existingBundle(ctx: MutationCtx, release: Doc<"releases">, name: string, publisherId: Id<"publishers">) {
  if (release.isbn13) {
    return await ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", release.isbn13))
      .first();
  }
  // Bundles are few (box sets only); a scan is fine for a one-time repair.
  return (await ctx.db.query("releaseBundles").collect()).find(
    (b) => b.name === name && b.publisherId === publisherId && b.format === release.format,
  ) ?? null;
}

/**
 * A box set is a Release Bundle (spec §2): each box-set Release's facts
 * become a bundle's, member Releases join in coverage order, and the
 * box-set Releases/Edition are hidden (identity and history kept).
 */
async function toBundle(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"remodelEdition">,
  edition: Doc<"editions">,
  name: string,
): Promise<Result> {
  const boxes = (await releasesOf(ctx, edition._id)).filter((r) => r.status !== "merged");
  if (boxes.length === 0) return skip("box set has no release");
  if (edition.status !== "active" && !(await existingBundle(ctx, boxes[0]!, name, edition.publisherId))) {
    return skip(`edition is ${edition.status}`);
  }
  const labels = (entry.groups[0]?.coverage ?? []).flatMap((c) => (c.label === null ? [] : [c.label]));
  const company = await companyRows(ctx, edition.publisherId);
  let firstMemberVolume: Id<"volumes"> | null = null;

  for (const box of boxes) {
    let bundle = await existingBundle(ctx, box, name, edition.publisherId);
    if (!bundle) {
      await audit.meta();
      const fields = {
        status: "active" as const,
        publicId: await allocatePublicId(ctx, "bundle"),
        name,
        publisherId: edition.publisherId,
        format: box.format,
        isbn13: box.isbn13,
        isbn10: box.isbn10,
        pubDate: box.pubDate,
        price: box.price,
        description: box.description,
        coverImage: box.coverImage,
        bootstrapUnreviewed: true,
      };
      const id = await ctx.db.insert("releaseBundles", fields);
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
    const bundleId = bundle._id;
    const members = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
      .collect();
    const missing: string[] = [];
    const volumes = await activeVolumes(ctx, entry.targetSeriesId);
    for (const [i, label] of labels.entries()) {
      const volume = volumes.find((v) => sameLabel(v.label, label));
      if (volume && firstMemberVolume === null) firstMemberVolume = volume._id;
      const member = volume ? await memberReleaseFor(ctx, volume._id, company, box.format) : null;
      if (!member) {
        missing.push(label);
        continue;
      }
      if (members.some((m) => m.releaseId === member._id)) continue;
      await audit.meta();
      await ctx.db.insert("bundleMemberships", { bundleId, releaseId: member._id, order: i + 1 });
      await audit.revise({ type: "releaseBundle", id: bundleId }, [
        { field: "member", after: `release ${member.isbn13 ?? member._id} (vol ${label})` },
      ]);
    }
    if (missing.length > 0) audit.note(`bundle ${bundle.publicId}: no member release for vol ${missing.join(", ")}`);
    if (await hide(ctx, audit, { type: "release", id: box._id }, box)) {
      await audit.revise({ type: "release", id: box._id }, [
        { field: "convertedToBundle", after: `#${bundle.publicId} ${name}` },
      ]);
    }
  }
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
      await merge(ctx, audit, { type: "release", id: survivor._id }, { type: "release", id: twin._id });
    }
  }
  return applied;
}

// ---------- stages 5-6: fields & volume numbering ----------

/** Plan JSON uses null for "absent". */
const stored = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

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
      else patch.altTitles = change.after;
    }
    const title = patch.title ?? series.title;
    patch.searchText = [title, ...(patch.altTitles ?? series.altTitles)].join(" ");
    await updateRecord(ctx, audit, { type: "series", id: series._id }, series, patch);
    if (patch.title !== undefined) await lockTitleIfContested(ctx, audit, series._id);
    return applied;
  }

  const release = await ctx.db.get(entry.id);
  if (!release || release.status !== "active") return skip("release not active");
  if (release.locked) return skip("release locked");
  const pending = pendingChanges(release, entry.changes);
  if (pending.length === 0) return already;
  const patch: Partial<Doc<"releases">> = {};
  for (const change of pending) {
    switch (change.field) {
      case "pubDate":
        patch.pubDate = stored(change.after);
        break;
      case "coverImage":
        patch.coverImage = undefined;
        break;
      case "format":
        patch.format = change.after;
        // Binding describes physical construction only (glossary: Binding).
        if (change.after === "digital" && release.binding !== undefined) patch.binding = undefined;
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
      .first();
    if (clash && clash._id !== release._id) skip(`ISBN ${isbn13} already on another release`);
  }
  if (release.format === "digital" && patch.binding !== undefined) skip("binding on a digital release");
  await updateRecord(ctx, audit, { type: "release", id: release._id }, release, patch);
  return applied;
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
    if (volume!.seriesId !== series._id || into!.seriesId !== series._id) skip("duplicate volume left the series");
    if (label !== undefined) {
      if (!sameLabel(volume!.label, label)) skip(`duplicate volume ${volume!.publicId} label drifted`);
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


// ---------- stage 12: series splits ----------

/** Creation-Revision field naming the plan entry that split a Series off. */
const SPLIT_KEY_FIELD = "repairKey";

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
    searchText: [entry.title, ...entry.altTitles].join(" "),
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
  if (staying) skip(`edition line "${line.name}" also holds edition ${staying.publicId}, which stays`);
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
  if (entry.volumes.length + entry.editions.length + entry.observationIds.length === 0) {
    return skip("the split moves no volume, edition, or observation");
  }

  let target = await splitTarget(ctx, entry);
  if (target && target.status !== "active") skip(`split-off series ${target.publicId} is ${target.status}`);
  if (!target) {
    if (source.title !== entry.sourceTitle) skip(`source title drifted: ${JSON.stringify(source.title)}`);
    target = await createSplitSeries(ctx, audit, entry, source);
  }
  const targetId = target!._id;
  const moving = new Set<string>([
    ...entry.volumes.flatMap((row) => row.editionIds),
    ...entry.editions.map((row) => row.editionId),
  ]);

  // Whole Volumes: re-parented with the moved work's own label. Anything
  // the importers attached since planning (another Edition) is drift.
  for (const row of entry.volumes) {
    const volume = await ctx.db.get(row.volumeId);
    if (!volume) return skip(`volume ${row.volumeId} missing`);
    if (volume.seriesId === targetId) continue;
    if (volume.status !== "active") skip(`volume ${volume.publicId} is ${volume.status}`);
    if (volume.seriesId !== source._id) skip(`volume ${volume.publicId} left the source series`);
    if (volume.locked) skip(`volume ${volume.publicId} is locked`);
    if (!sameLabel(volume.label, row.label)) skip(`volume ${volume.publicId} label drifted: ${JSON.stringify(volume.label ?? null)}`);
    const editions = await activeEditionsCovering(ctx, volume._id);
    if (!sameValue(idSet(editions.map((e) => e._id)), idSet(row.editionIds))) {
      skip(`volume ${volume.publicId} editions drifted: now ${editions.map((e) => e.publicId).join(", ") || "none"}`);
    }
    const targetVolumes = await activeVolumes(ctx, targetId);
    if (targetVolumes.some((v) => sameLabel(v.label, row.newLabel))) {
      skip(`split-off series already has a volume labelled ${JSON.stringify(row.newLabel)}`);
    }
    const label = canonicalLabel(row.newLabel);
    const last = targetVolumes.reduce((max, v) => Math.max(max, v.position), 0);
    await updateRecord(ctx, audit, { type: "volume", id: volume._id }, volume, {
      seriesId: targetId,
      label: label ?? undefined,
      position: labelNumber(label) ?? last + 1,
    });
    for (const edition of editions) {
      await followLine(ctx, audit, edition, source._id, targetId, moving);
      await refreshReleaseDenorms(ctx, edition._id);
    }
  }

  // Editions on a Volume label both works share: the staying work keeps
  // the Volume; the Edition's coverage moves to the new Series' Volume.
  for (const row of entry.editions) {
    const edition = await ctx.db.get(row.editionId);
    if (!edition || edition.status !== "active") return skip(`edition ${row.editionId} not active`);
    if (row.labels.length !== row.fromVolumeIds.length) skip("plan error: one label per coverage row");
    const coverage = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
    const covered = [];
    for (const cover of coverage) covered.push(await ctx.db.get(cover.volumeId));
    const done = covered.length === row.labels.length && covered.every((vol, i) => vol?.seriesId === targetId && sameLabel(vol.label, row.labels[i]));
    if (done) continue;
    if (!sameValue(coverage.map((c) => c.volumeId), row.fromVolumeIds)) {
      skip(`edition ${edition.publicId} coverage drifted`);
    }
    const releases = (await releasesOf(ctx, edition._id)).filter((r) => r.status === "active");
    if (!sameValue(idSet(releases.map((r) => r._id)), idSet(row.releaseIds))) {
      skip(`edition ${edition.publicId} releases drifted: now ${releases.map((r) => r.isbn13 ?? r._id).join(", ")}`);
    }
    if (edition.locked) skip(`edition ${edition.publicId} is locked`);
    const rows = [];
    for (const [i, label] of row.labels.entries()) {
      rows.push({ volumeId: (await ensureVolume(ctx, audit, targetId, label))._id, extent: coverage[i]!.extent });
    }
    await followLine(ctx, audit, edition, source._id, targetId, moving);
    await replaceCoverage(ctx, audit, edition._id, rows);
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
    await ctx.db.patch(observation._id, { recordRef: { type: "series", id: targetId } });
    const from = { type: "series" as const, id: source._id };
    const to = { type: "series" as const, id: targetId };
    audit.op({ kind: "update", ref: from, changes: [{ field: "sourceObservation", before: record }] });
    audit.op({ kind: "update", ref: to, changes: [{ field: "sourceObservation", after: record }] });
    await audit.revise(from, [{ field: "sourceObservation", before: record }]);
    await audit.revise(to, [{ field: "sourceObservation", after: record }]);
  }

  await settlePositions(ctx, audit, source._id);
  await settlePositions(ctx, audit, targetId);
  await lockTitleIfContested(ctx, audit, targetId);
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
  entry: EntryOf<"createRelease">,
): Promise<Result> {
  const clashes = await ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", entry.isbn13))
    .collect();
  const own = clashes.length === 1 && (await createdByEntry(ctx, { type: "release", id: clashes[0]!._id }, entry.key));
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
  const bundle = await ctx.db
    .query("releaseBundles")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", entry.isbn13))
    .first();
  if (bundle) skip(`ISBN ${entry.isbn13} is Release Bundle ${bundle.publicId}`);
  if (entry.format === "digital" && entry.binding !== null) skip("plan error: binding on a digital release");
  const publisher = await ctx.db.get(entry.publisherId);
  if (!publisher || publisher.status !== "active") skip("publisher not active");

  const volumes: Doc<"volumes">[] = [];
  for (const row of entry.coverage) {
    const volume = await ctx.db.get(row.volumeId);
    if (!volume || volume.status !== "active") return skip(`volume ${row.volumeId} not active`);
    volumes.push(volume);
  }
  const first = volumes[0];
  if (!first) return skip("plan error: no coverage");
  const series = await ctx.db.get(first.seriesId);
  if (!series || series.status !== "active") return skip("series not active");

  const line = entry.line;
  const editionId = await createEdition(ctx, audit, {
    status: "active",
    publisherId: entry.publisherId,
    bootstrapUnreviewed: true,
    ...(line
      ? {
          editionLineId: await findOrCreateLine(ctx, audit, series._id, entry.publisherId, line.name),
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
    seriesIds: [...new Set(volumes.map((v) => v.seriesId))],
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

/**
 * A Release Bundle whose members may sit in several Series: extend one, or
 * turn a box-set Release into one. Members keep the plan's order; a member
 * already in the bundle at another order is drift.
 */
async function releaseBundle(
  ctx: MutationCtx,
  audit: Audit,
  entry: EntryOf<"releaseBundle">,
): Promise<Result> {
  let bundle: Doc<"releaseBundles"> | null = null;
  let box: Doc<"releases"> | null = null;
  if (entry.bundleId !== null && entry.box === null) {
    bundle = await ctx.db.get(entry.bundleId);
  } else if (entry.box !== null && entry.bundleId === null) {
    box = await ctx.db.get(entry.box.releaseId);
    if (!box) return skip("box-set release missing");
    const isbn13 = box.isbn13;
    if (isbn13 === undefined) return skip("box-set release has no ISBN");
    bundle = await ctx.db
      .query("releaseBundles")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .first();
    if (!bundle) {
      if (box.status !== "active") return skip(`box-set release is ${box.status}`);
      if (box.locked) skip("box-set release is locked");
      const edition = await ctx.db.get(box.editionId);
      if (!edition) return skip("box-set edition missing");
      await audit.meta();
      const fields = {
        status: "active" as const,
        publicId: await allocatePublicId(ctx, "bundle"),
        name: entry.box.name,
        publisherId: edition.publisherId,
        format: box.format,
        isbn13,
        isbn10: box.isbn10,
        pubDate: box.pubDate,
        price: box.price,
        description: box.description,
        coverImage: box.coverImage,
        bootstrapUnreviewed: true,
      };
      const id = await ctx.db.insert("releaseBundles", fields);
      audit.op({ kind: "create", table: "releaseBundles", tempId: id, fields });
      await audit.revise(
        { type: "releaseBundle", id },
        Object.entries(fields)
          .filter(([, after]) => after !== undefined)
          .map(([field, after]) => ({ field, after })),
      );
      bundle = await ctx.db.get(id);
    }
  } else {
    return skip("plan error: name either a bundle or a box set");
  }
  if (!bundle || bundle.status !== "active") return skip("bundle not active");
  const bundleRef = { type: "releaseBundle" as const, id: bundle._id };

  const memberships = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
    .collect();
  let firstVolume: Id<"volumes"> | null = null;
  for (const planned of entry.members) {
    const hits = (
      await ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", planned.isbn13))
        .collect()
    ).filter((r) => r.status === "active");
    const member = hits[0];
    if (!member || hits.length > 1) return skip(`member ${planned.isbn13}: ${hits.length} active releases`);
    if (box && member._id === box._id) skip("plan error: the box set is its own member");
    firstVolume ??= (await coverageOf(ctx, member.editionId)).sort((a, b) => a.order - b.order)[0]?.volumeId ?? null;
    const row = memberships.find((m) => m.releaseId === member._id);
    if (row) {
      if (row.order !== planned.order) skip(`member ${planned.isbn13} sits at order ${row.order}`);
      continue;
    }
    if (memberships.some((m) => m.order === planned.order)) skip(`order ${planned.order} is taken by another member`);
    await audit.meta();
    const id = await ctx.db.insert("bundleMemberships", { bundleId: bundle._id, releaseId: member._id, order: planned.order });
    const inserted = await ctx.db.get(id);
    if (inserted) memberships.push(inserted);
    const change = { field: "member", after: `release ${planned.isbn13} (order ${planned.order})` };
    audit.op({ kind: "update", ref: bundleRef, changes: [change] });
    await audit.revise(bundleRef, [change]);
  }

  if (box) {
    if (await hide(ctx, audit, { type: "release", id: box._id }, box)) {
      await audit.revise({ type: "release", id: box._id }, [
        { field: "convertedToBundle", after: `#${bundle.publicId} ${bundle.name}` },
      ]);
    }
    const edition = await ctx.db.get(box.editionId);
    const live = (await releasesOf(ctx, box.editionId)).filter((r) => r.status === "active");
    if (edition && live.length === 0) await hide(ctx, audit, { type: "edition", id: edition._id }, edition);
  }
  await retireVolumes(ctx, audit, entry.retireVolumeIds, firstVolume);
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
    const matches = (await activeVolumes(ctx, row.seriesId)).filter((v) => sameLabel(v.label, row.label));
    const volume = matches[0];
    if (!volume || matches.length > 1) {
      return skip(`series ${row.seriesId} has ${matches.length} active volumes labelled ${JSON.stringify(row.label)}`);
    }
    rows.push({ volumeId: volume._id, extent: row.extent });
  }
  if (rows.length === 0) return skip("plan error: empty coverage");

  const current = (await coverageOf(ctx, edition._id)).sort((a, b) => a.order - b.order);
  const done =
    current.length === rows.length &&
    current.every((c, i) => c.volumeId === rows[i]?.volumeId && c.extent === rows[i]?.extent);
  if (!done && !sameValue(current.map((c) => c.volumeId), entry.before)) {
    skip(`edition ${edition.publicId} coverage drifted`);
  }
  await replaceCoverage(ctx, audit, edition._id, rows);

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
  await retireVolumes(ctx, audit, entry.retireVolumeIds, rows[0]!.volumeId);
  return audit.wrote ? applied : already;
}
