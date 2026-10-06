import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type AnnReleaseSnapshot, lineOutOfScope } from "../ann";
import { placeEdition } from "../openLibrary";
import { contentRefusal, readObservationBook, readTitledRecord } from "../printings";
import { annContentFacts, annLinePackaged, packagingOf, readAnnLineTitle } from "./ann";
import { parseBookTitle, rangeLabels, outOfScopeReason } from "./bookTitle";
import { toIsbn13 } from "./isbn";
import { bindingFacts, bookFacts } from "./bookFacts";
import { labelsEqual, sameWorkTitle } from "./matching";
import { holdOf } from "./observations";
import type { OlEditionSnapshot } from "./openLibrary";
import { findPublisherByName } from "./pipeline";
import {
  type ClaimOwner,
  claimResolver,
  isbnClaims,
  MAX_DOCUMENT_BYTES,
  readRoom,
  statedIsbns,
  takeWithin,
} from "./releaseIsbns";
import { evidenceUrls, isbnScope, scopeState } from "./scope";
import { nonJsonPath, valueHash } from "./values";

export const MAX_GUARD_BYTES = 256 * 1024;
const MAX_JOIN = 80;
export const refuse = (reason: string): never => {
  throw new ConvexError({ held: reason });
};

/** Each join leaves room for the next maximum-size document and the audit/write tail. */
export function reader(ctx: QueryCtx) {
  const room = readRoom(
    ctx,
    {
      bytesRead: MAX_DOCUMENT_BYTES,
      bytesWritten: 512 * 1024,
      documentsWritten: 100,
      databaseQueries: 32,
      documentsRead: 32,
      functionsScheduled: 2,
      scheduledFunctionArgsBytes: 32 * 1024,
    },
    (short) => refuse(`Transaction incomplete: ${short.join(", ")}.`),
  );
  const facts: unknown[] = [];
  const read = async <T extends TableNames>(id: Id<T>) => {
    await room();
    const doc = await ctx.db.get(id);
    facts.push(doc);
    return doc;
  };
  const active = async <
    T extends
      | "series"
      | "volumes"
      | "editionLines"
      | "editions"
      | "publishers"
      | "releases"
      | "releaseBundles",
  >(
    id: Id<T>,
  ): Promise<Doc<T>> => {
    const seen = new Set<string>();
    let current = id;
    for (let hop = 0; hop <= 8; hop++) {
      if (seen.has(current)) return refuse("Dependency merge cycle.");
      seen.add(current);
      const doc = await read(current);
      if (!doc) return refuse("Missing dependency.");
      if (doc.status !== "merged") {
        if (doc.status !== "active" || doc.locked)
          return refuse("Dependency must be active and unlocked.");
        return doc;
      }
      if (!doc.mergedIntoId) return refuse("Merge points nowhere.");
      current = doc.mergedIntoId as Id<T>;
    }
    return refuse("Dependency exceeds eight merge hops.");
  };
  const many = async <T>(query: AsyncIterable<T>) => {
    const rows = await takeWithin(query, MAX_JOIN + 1, room);
    if (rows.length > MAX_JOIN)
      return refuse(`Dependency has more than ${MAX_JOIN} rows; incomplete.`);
    facts.push(rows);
    return rows;
  };
  return { room, facts, read, active, many };
}
export type Reader = ReturnType<typeof reader>;

/** Scan one Series under the transaction budget, retaining only requested labels.
 * Long works do not become ineligible merely because unrelated Volumes exceed a join limit.
 */
export async function volumesForLabels(
  ctx: QueryCtx,
  seriesId: Id<"series">,
  labels: readonly string[],
  r: Reader,
) {
  if (labels.length > MAX_JOIN)
    return refuse("Requested box contents exceed 80 Volumes; incomplete.");
  const matches: Doc<"volumes">[] = [];
  await r.room();
  for await (const volume of ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))) {
    if (labels.some((label) => labelsEqual(volume.label, label))) matches.push(volume);
    if (matches.length > MAX_JOIN) return refuse("Box Volume candidates exceed 80; incomplete.");
    await r.room();
  }
  r.facts.push(matches);
  return matches;
}

/** Full current source-parent provenance, never inferred from the ISBN holder. */
export async function sourceSeries(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  r: Reader,
) {
  const s = observation.snapshot as {
    mangaId?: string;
    seriesSlug?: string;
    seriesUrl?: string;
    url?: string;
  };
  if (observation.sourceKey === "openlibrary") {
    const placement = await placeEdition(ctx, observation.snapshot as OlEditionSnapshot);
    if (placement.kind === "create")
      return { series: await r.active(placement.series._id), placement };
    if (placement.kind === "hold" && placement.hold.seriesId)
      return { series: await r.active(placement.hold.seriesId), placement };
    return { series: null, placement };
  }
  const key =
    observation.sourceKey === "ann" && s.mangaId
      ? `manga:${s.mangaId}`
      : observation.sourceKey === "kodansha" && s.seriesSlug
        ? `series:${s.seriesSlug}`
        : null;
  if (!key) return { series: null, placement: null };
  const parents = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", observation.sourceKey).eq("sourceRecordId", key),
      ),
  );
  if (parents.length !== 1) return refuse("Source parent is absent or ambiguous.");
  const parent = parents[0]!;
  if (nonJsonPath(parent.snapshot)) return refuse("Source parent is not JSON.");
  const parentHold = await holdOf(ctx, parent._id);
  r.facts.push(parentHold);
  const queued = parent.queuedProposalId ? await r.read(parent.queuedProposalId) : null;
  if (
    parent.withdrawn ||
    parentHold ||
    queued?.state === "inReview" ||
    parent.recordRef?.type !== "series"
  )
    return refuse("Source parent is withdrawn, held, unlinked or in review.");
  if (observation.sourceKey === "kodansha") {
    const p = parent.snapshot as { kind?: string; slug?: string; url?: string };
    if (
      p.kind !== "series" ||
      !p.url ||
      p.url !== (s.seriesUrl ?? `https://kodansha.us/series/${s.seriesSlug}/`)
    )
      return refuse("Kodansha parent identity disagrees.");
  }
  return { series: await r.active(parent.recordRef.id), placement: null };
}

/** Complete ordered canonical content, including identity dependencies and current revisions. */
export async function releaseContents(ctx: QueryCtx, id: Id<"releases">, r: Reader) {
  const release = await r.active(id);
  const edition = await r.active(release.editionId);
  const publisher = await r.active(release.publisherId);
  if (publisher._id !== (await r.active(edition.publisherId))._id)
    return refuse("Edition and Release publishers disagree.");
  const series = [];
  for (const seriesId of release.seriesIds) series.push(await r.active(seriesId));
  const line = edition.editionLineId ? await r.active(edition.editionLineId) : null;
  if (line && (!series.some((s) => s._id === line.seriesId) || line.publisherId !== publisher._id))
    return refuse("Edition Line identity disagrees.");
  if (edition.coverageUnmapped) return refuse("Edition contents are unmapped.");
  const rows = (
    await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    )
  ).sort((a, b) => a.order - b.order);
  if (!rows.length) return refuse("Edition has no contents.");
  const contents = [];
  for (const row of rows) {
    const volume = await r.active(row.volumeId);
    const work = await r.active(volume.seriesId);
    if (row.extent !== "complete" || !series.some((s) => s._id === work._id))
      return refuse("Contents are partial or belong to another work.");
    contents.push({ volume, work, extent: row.extent, order: row.order });
  }
  for (const ref of [
    { type: "release" as const, id: release._id },
    { type: "edition" as const, id: edition._id },
  ]) {
    const latest = await takeWithin(
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
        .order("desc"),
      1,
      r.room,
    );
    r.facts.push(latest);
  }
  return { release, edition, publisher, series, line, contents };
}
export type Contents = Awaited<ReturnType<typeof releaseContents>>;

/** Own-ISBN linking may compare complete packaged contents. A Line ID alone supplies no contents. */
export async function contentMatch(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  target: Contents,
) {
  const s = observation.snapshot as {
    title?: string;
    format?: string;
    publishers?: string[];
    page?: { distributor?: string };
    imprint?: string;
  };
  if (s.format !== target.release.format) return refuse("Source and target formats disagree.");
  const ordinary = await contentRefusal(ctx, observation, target.release, target.series);
  if (!ordinary) return;
  if (observation.sourceKey !== "ann") return refuse(ordinary);
  const line = observation.snapshot as AnnReleaseSnapshot;
  const names = target.series.map((s) => s.title);
  const scope = lineOutOfScope(line, names);
  if (scope) return refuse(scope);
  const segmented = readAnnLineTitle(line.title, { names });
  if (segmented.kind === "ambiguous" || !names.some((name) => sameWorkTitle(name, segmented.work)))
    return refuse("ANN work identity is unresolved.");
  const packageFacts = packagingOf(line, names);
  if (
    !packageFacts ||
    packageFacts.title.kind === "ambiguous" ||
    !packageFacts.coverRange ||
    packageFacts.coverageGapped ||
    packageFacts.positionConflict ||
    packageFacts.formatConflict ||
    !target.line
  )
    return refuse(ordinary);
  if (
    !sameWorkTitle(target.line.name, packageFacts.line!.name) ||
    !labelsEqual(target.edition.linePosition ?? null, packageFacts.line!.position)
  )
    return refuse("Edition Line name or position disagrees.");
  const labels = rangeLabels(packageFacts.coverRange);
  if (
    !labels ||
    labels.length !== target.contents.length ||
    target.contents.some((c, i) => !labelsEqual(c.volume.label ?? null, labels[i] ?? null))
  )
    return refuse("Complete ordered canonical contents disagree with ANN.");
}

/** Pin free slots and sibling binding before a stored adapter can create anything. */
async function replaySlots(ctx: QueryCtx, series: Doc<"series">, r: Reader) {
  const editionIds = new Set<Id<"editions">>();
  const coverageIds = new Set<Id<"volumeCoverages">>();
  const releaseIds = new Set<Id<"releases">>();
  const volumes = await r.many(
    ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", series._id)),
  );
  for (const volume of volumes) {
    const coverage = await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", volume._id)),
    );
    for (const row of coverage) {
      editionIds.add(row.editionId);
      coverageIds.add(row._id);
    }
  }
  const lines = await r.many(
    ctx.db.query("editionLines").withIndex("by_series", (q) => q.eq("seriesId", series._id)),
  );
  for (const line of lines) {
    const editions = await r.many(
      ctx.db.query("editions").withIndex("by_line", (q) => q.eq("editionLineId", line._id)),
    );
    for (const edition of editions) editionIds.add(edition._id);
  }
  if (editionIds.size > MAX_JOIN)
    return refuse("Replay slot closure exceeds 80 Editions; incomplete.");
  for (const id of editionIds) {
    await r.read(id);
    const coverage = await r.many(
      ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", id)),
    );
    for (const row of coverage) coverageIds.add(row._id);
    const releases = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", id)),
    );
    for (const release of releases) releaseIds.add(release._id);
  }
  return {
    releaseIds: [...releaseIds],
    editionIds: [...editionIds],
    volumeIds: volumes.map((v) => v._id),
    lineIds: lines.map((l) => l._id),
    coverageIds: [...coverageIds],
  };
}

/** One source record and target per transaction. Expected includes every source, hold and graph fact read. */
export async function heldState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  target?: { type: "release"; id: Id<"releases"> } | { type: "bundle"; id: Id<"releaseBundles"> },
  reviewed?: ReviewedIdentity,
  replay = false,
) {
  const r = reader(ctx);
  const observation = await r.read(observationId);
  if (!observation || nonJsonPath(observation.snapshot))
    return refuse("Missing or non-JSON source snapshot.");
  const hold = await holdOf(ctx, observationId);
  r.facts.push(hold);
  const proposal = observation.queuedProposalId ? await r.read(observation.queuedProposalId) : null;
  const isbnKeys = new Set(statedIsbns(observation.snapshot).map(toIsbn13));
  const isbn13 = isbnKeys.size === 1 ? [...isbnKeys][0] : undefined;
  if (isbnKeys.size > 1 || isbnKeys.has(undefined))
    return refuse("Source ISBN identity is invalid or ambiguous.");
  const scope = isbn13 ? await scopeState(ctx, isbn13) : null;
  r.facts.push(scope);
  const snapshotScope = observation.snapshot as {
    title?: string;
    page?: { status?: string; title?: string };
    outOfScope?: string;
  };
  const ownScope =
    observation.sourceKey === "ann"
      ? [
          snapshotScope.title,
          snapshotScope.page?.status === "ok" ? snapshotScope.page.title : undefined,
        ]
          .filter((title): title is string => typeof title === "string")
          .map(outOfScopeReason)
          .find((reason) => reason !== null)
      : observation.sourceKey === "kodansha"
        ? snapshotScope.outOfScope
        : undefined;
  const scopeReason =
    (await isbnScope(ctx, isbn13 ?? undefined)) ??
    (ownScope ? `Stored source scope: ${ownScope}` : null);
  r.facts.push(scopeReason);
  const terminal = Boolean(
    observation.recordRef ||
      observation.withdrawn ||
      (proposal?.state === "inReview" && proposal.author.kind === "source") ||
      scopeReason,
  );
  const source =
    terminal && !target
      ? { series: null, placement: null }
      : await sourceSeries(ctx, observation, r);
  r.facts.push(source.placement);
  let replayBefore: Awaited<ReturnType<typeof replaySlots>> | null = null;
  if (replay) {
    if (target || terminal || !source.series)
      return refuse("Replay needs an unlinked source with a resolved canonical work.");
    replayBefore = await replaySlots(ctx, source.series, r);
    if (source.placement?.kind === "create") await r.active(source.placement.publisher._id);
    else {
      const snapshot = observation.snapshot as AnnReleaseSnapshot;
      const publisher = snapshot.page?.distributor
        ? await findPublisherByName(ctx, snapshot.page.distributor)
        : null;
      if (!publisher) return refuse("Replay publisher is unresolved.");
      await r.active(publisher._id);
    }
  }
  const heldSeries = hold?.seriesId && !terminal ? await r.active(hold.seriesId) : null;
  const claims = isbn13
    ? await isbnClaims(ctx, isbn13, {
        resolver: claimResolver(ctx, { room: r.room }),
        room: r.room,
      })
    : { complete: true, unresolved: [], owners: new Map<string, ClaimOwner>(), printed: false };
  if (!claims?.complete || claims.unresolved.length)
    return refuse("ISBN claims incomplete or unresolved.");
  r.facts.push([...claims.owners.values()]);
  const bootstrap = await r.many(ctx.db.query("appConfig"));
  let contents: Contents | null = null;
  let bundle: Doc<"releaseBundles"> | null = null;
  let members: Array<{ releaseId: Id<"releases">; order: number }> = [];
  const memberContents: Contents[] = [];
  if (target?.type === "release") contents = await releaseContents(ctx, target.id, r);
  if (target?.type === "bundle") {
    bundle = await r.active(target.id);
    await r.active(bundle.publisherId);
    members = (
      await r.many(
        ctx.db
          .query("bundleMemberships")
          .withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id)),
      )
    ).sort((a, b) => a.order - b.order);
    if (!members.length)
      return refuse("Bundle contents are empty; research and repair membership first.");
    for (const member of members)
      memberContents.push(await releaseContents(ctx, member.releaseId, r));
  }
  if (reviewed) {
    if (
      !isbn13 ||
      toIsbn13(reviewed.isbn13) !== isbn13 ||
      !reviewed.volumeIds.length ||
      reviewed.volumeIds.length > 80 ||
      new Set(reviewed.volumeIds).size !== reviewed.volumeIds.length
    )
      return refuse("Review must name the exact ISBN and complete ordered unique Volumes.");
    evidenceUrls(reviewed.evidenceUrls);
    await r.active(reviewed.seriesId);
    await r.active(reviewed.publisherId);
    for (const id of reviewed.volumeIds) await r.active(id);
  }
  const expected = valueHash({
    observationId,
    target: target ?? null,
    reviewed: reviewed ?? null,
    replay,
    facts: r.facts,
    bootstrap,
  });
  if (new TextEncoder().encode(expected).length > MAX_GUARD_BYTES)
    return refuse("Guard exceeds 256 KiB; inspect this record separately.");
  const eligible =
    !observation.withdrawn &&
    !observation.recordRef &&
    hold !== null &&
    proposal?.state !== "inReview";
  return {
    observation,
    hold,
    proposal,
    source,
    isbn13: isbn13 ?? null,
    scopeReason,
    claims,
    contents,
    bundle,
    members,
    memberContents,
    expected,
    eligible,
    r,
    reviewed,
    heldSeries,
    replayBefore,
  };
}

/** Publisher identity uses the source's own resolver. Corporate-family acceptance is deferred. */
export async function publisherMatch(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  publisherId: Id<"publishers">,
) {
  const s = observation.snapshot as {
    publishers?: string[];
    imprint?: string;
    page?: { distributor?: string };
  };
  const names =
    observation.sourceKey === "ann"
      ? [s.page?.distributor]
      : observation.sourceKey === "openlibrary"
        ? s.publishers
        : observation.sourceKey === "sevenseas"
          ? ["Seven Seas Entertainment"]
          : [s.imprint];
  if (!names?.some(Boolean))
    return refuse("Source publisher identity is unknown; exact-ISBN review is required.");
  for (const name of names) {
    if (!name) continue;
    const pub = await findPublisherByName(ctx, name);
    if (pub) {
      if (pub._id !== publisherId)
        return refuse("Source publisher differs; corporate-family acceptance is deferred.");
      return;
    }
  }
  return refuse("Source publisher cannot be resolved.");
}

/** The containing product must agree with its own active publisher and every member. */
export async function bundleEnvelope(ctx: QueryCtx, state: Awaited<ReturnType<typeof heldState>>) {
  const bundle = state.bundle ?? refuse("No Bundle.");
  const publisher = await state.r.active(bundle.publisherId);
  const format = (state.observation.snapshot as { format?: string }).format;
  if (bundle.format !== format) return refuse("Bundle and source formats differ.");
  if (state.reviewed) {
    if (state.reviewed.publisherId !== publisher._id)
      return refuse("Bundle and reviewed product publishers differ.");
  } else await publisherMatch(ctx, state.observation, publisher._id);
  for (const content of state.memberContents) {
    if (content.release.format !== bundle.format || content.publisher._id !== publisher._id)
      return refuse("Bundle member format/publisher differs.");
  }
}

export async function bundleMatch(ctx: QueryCtx, state: Awaited<ReturnType<typeof heldState>>) {
  const bundle = state.bundle ?? refuse("No Bundle.");
  const s = state.observation.snapshot as AnnReleaseSnapshot;
  if (state.observation.sourceKey !== "ann")
    return refuse(
      "Bundle source needs explicit contents evidence; this adapter has no complete stored contents reader.",
    );
  const names = [state.source.series?.title ?? ""];
  if (!annLinePackaged(s, names) || !/box\s*set/i.test(s.title))
    return refuse("Source does not identify a box set.");
  const scope = lineOutOfScope(s, names);
  if (scope) return refuse(scope);
  if (s.format !== bundle.format || !state.source.series)
    return refuse("Bundle format or source work is unresolved.");
  await publisherMatch(ctx, state.observation, bundle.publisherId);
  if (!new Set([toIsbn13(bundle.isbn13), toIsbn13(bundle.isbn10)]).has(state.isbn13 ?? undefined))
    return refuse("Bundle ISBN disagrees.");
  const series = state.source.series;
  const actual = state.memberContents.flatMap((content) => content.contents);
  if (actual.some((content) => content.work._id !== series._id))
    return refuse("Ordered complete Bundle work disagrees.");
  const facts = await sourceContentsMatch(ctx, state, state.memberContents, series, false);
  if (!facts.packaged || !facts.hasKnownRange)
    return refuse(
      "Source supplies no complete box contents; exact publisher contents review is required.",
    );
}

/** An operator's exact-ISBN determination; URL syntax does not certify its substance. */
export type ReviewedIdentity = {
  isbn13: string;
  seriesId: Id<"series">;
  publisherId: Id<"publishers">;
  volumeIds: Id<"volumes">[];
  evidenceUrls: string[];
  sourceTitle?: string;
  umbrellaRouting?: { sourceTitle: string; productTitle: string; productVolumeLabel: string };
};
export async function reviewedMatch(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  contents: Contents[],
) {
  const proof = state.reviewed ?? refuse("Complete exact-ISBN identity review is required.");
  const actual = contents.flatMap((c) => c.contents);
  if (
    actual.length !== proof.volumeIds.length ||
    actual.some((c, i) => c.work._id !== proof.seriesId || c.volume._id !== proof.volumeIds[i]) ||
    contents.some((c) => c.publisher._id !== proof.publisherId)
  )
    return refuse("Reviewed ordered canonical work, extent or publisher differs.");
  const routed = await reviewedRouting(ctx, state, proof.seriesId);
  if (state.source.series && state.source.series._id !== proof.seriesId && !routed)
    return refuse("Source parent work disagrees with review.");
  const series = await state.r.active(proof.seriesId);
  await sourceContentsMatch(ctx, state, contents, series, routed);
  if (
    routed &&
    (actual.length !== 1 ||
      !labelsEqual(actual[0]!.volume.label ?? null, proof.umbrellaRouting!.productVolumeLabel))
  )
    return refuse("Reviewed product Volume differs from complete canonical contents.");
}

/** Known source facts apply to the whole product in both ordinary and reviewed links. */
async function sourceContentsMatch(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  contents: Contents[],
  series: Doc<"series">,
  routed: Awaited<ReturnType<typeof reviewedRouting>>,
) {
  const actual = contents.flatMap((content) => content.contents);
  const proof = state.reviewed;
  const s = state.observation.snapshot as {
    title?: string;
    subtitle?: string;
    seriesTitle?: string;
    format?: string;
    coverRange?: { from: string; to: string };
    coverageGapped?: boolean;
    packaging?: {
      coverRange?: { from: string; to: string } | null;
      coverageGapped?: boolean;
      lineName?: string | null;
      linePosition?: string | null;
    };
  };
  if (contents.some((c) => c.release.format !== s.format))
    return refuse("Known source format differs.");
  const ranges = [s.coverRange, s.packaging?.coverRange];
  if (s.coverageGapped || s.packaging?.coverageGapped)
    return refuse("Known incomplete source contents cannot be reviewed as a complete range.");
  let sourceLabel: string | undefined;
  let sourceBinding: "hardcover" | "paperback" | undefined;
  let packaged = false;
  let lineName: string | null | undefined;
  let position: string | null | undefined;
  if (state.observation.sourceKey === "ann") {
    const line = state.observation.snapshot as AnnReleaseSnapshot;
    const names = routed ? [series.title, routed.sourceWork] : [series.title];
    const reading = await readObservationBook(ctx, state.observation, [series], names);
    const named = readAnnLineTitle(line.title, { names });
    // A reviewed Season/Box product can be titled beyond its parent work.
    // Exact title text plus selected IDs cannot excuse an unrelated known work.
    const productWork = line.title.replace(
      /\s*(?:[-–—:]\s*)?(?:Season\s+\d+(?:\s+Part\s+\d+)?|Box\s+Set(?:\s+\d+)?)(?:\s+Manga\s+Box\s+Set)?$/i,
      "",
    );
    const reviewedProduct =
      proof?.sourceTitle === line.title &&
      state.source.series?._id === series._id &&
      annLinePackaged(line, names) &&
      sameWorkTitle(productWork, series.title);
    if (
      named.kind === "ambiguous" ||
      (!sameWorkTitle(reading.work, series.title) &&
        !(
          routed &&
          (sameWorkTitle(reading.work, routed.rootWork) || samePartWork(reading.work, series.title))
        ) &&
        !reviewedProduct) ||
      reading.scope.length ||
      reading.unreadable.length
    )
      return refuse(
        `Known ANN work "${reading.work}", scope or unreadable facts contradict review: ${reading.unreadable.join("; ")}`,
      );
    const facts = annContentFacts(line, names);
    if (
      facts.coverageGapped ||
      facts.positionConflict ||
      facts.formatConflict ||
      facts.title.kind === "ambiguous"
    )
      return refuse("Known ANN content/position/format conflict.");
    ranges.push(facts.coverRange);
    packaged = reading.packaging.length > 0;
    sourceLabel = reading.label;
    sourceBinding = reading.binding;
    lineName = facts.lineName;
    position = facts.position;
    if (!packaged && reading.needsLabel && !sourceLabel)
      return refuse("ANN states no Volume; exact contents remain unknown.");
  } else {
    const title = state.observation.sourceKey === "kodansha" ? s.seriesTitle : s.title;
    if (!title) return refuse("Missing work context cannot be replaced by review.");
    const reading = readTitledRecord(
      state.observation.sourceKey,
      title,
      state.observation.snapshot as Parameters<typeof readTitledRecord>[2],
      [series.title],
    );
    if (
      reading.scope.length ||
      reading.unreadable.length ||
      !sameWorkTitle(reading.work, series.title)
    )
      return refuse("Known source work, scope or unreadable facts contradict review.");
    const parsed = parseBookTitle(title, { subtitle: s.subtitle });
    const raw = parseBookTitle(title);
    ranges.push(parsed.packaging?.coverRange, raw.packaging?.coverRange);
    if (parsed.packaging?.coverageGapped || raw.packaging?.coverageGapped)
      return refuse("Known incomplete source contents cannot be reviewed as a complete range.");
    lineName = s.packaging?.lineName ?? parsed.packaging?.lineName;
    position = s.packaging?.linePosition ?? parsed.packaging?.linePosition;
    const positions = [
      s.packaging?.linePosition,
      parsed.packaging?.linePosition,
      raw.packaging?.linePosition,
    ].filter((one): one is string => !!one);
    if (positions.some((one) => !labelsEqual(one, position ?? null)))
      return refuse("Known source positions disagree.");
    if (
      [title, s.subtitle].some((text) => bookFacts(text, [series.title]).digital) &&
      s.format !== "digital"
    )
      return refuse("Known source digital format contradicts target.");
    packaged = reading.packaging.length > 0;
    sourceLabel = reading.label;
    sourceBinding = reading.binding;
  }
  for (const content of contents) {
    const bindings = new Set(bindingFacts(content.release.binding));
    if (bindings.size > 1 || (sourceBinding && bindings.size && !bindings.has(sourceBinding)))
      return refuse("Known source binding contradicts target.");
  }
  // A single source label is a Volume; a packaged label is its position.
  // Compare a package with all members together, never with its first Release.
  if (
    !packaged &&
    sourceLabel &&
    (actual.length !== 1 || !labelsEqual(actual[0]!.volume.label ?? null, sourceLabel))
  )
    return refuse("Known single-Volume extent differs.");
  if (state.bundle && packaged && position) {
    const targetPosition = parseBookTitle(state.bundle.name).packaging?.linePosition;
    if (targetPosition && !labelsEqual(targetPosition, position))
      return refuse("Known Bundle position differs.");
  }
  if (!state.bundle && packaged && lineName) {
    const target = contents[0]!;
    if (
      !target.line ||
      !sameWorkTitle(target.line.name, lineName) ||
      (position && !labelsEqual(target.edition.linePosition ?? null, position))
    )
      return refuse("Known Edition Line name or position differs.");
  }
  for (const range of ranges) {
    if (!range) continue;
    const labels = rangeLabels(range);
    if (
      !labels ||
      actual.length !== labels.length ||
      actual.some((c, i) => !labelsEqual(c.volume.label ?? null, labels[i] ?? null))
    )
      return refuse("Known ordered source contents differ.");
  }
  return { packaged, hasKnownRange: ranges.some(Boolean) };
}

/** The manga discriminator changes spelling, not the root work's identity. */
function mangaWorkTitle(title: string) {
  return title.replace(/\s+\(manga\)\s*$/i, "").trim();
}

/** The root before a named Part; other title words and punctuation stay meaningful. */
function partWork(title: string) {
  const part = /^(.*?)\bPart\s+(\d+)\b/i.exec(title);
  if (!part) return null;
  const root = part[1]!.replace(/(?:\s*[-–—:]\s*)$/, "").trim();
  return { root: mangaWorkTitle(root), part: part[2]!, sourceWork: part[0].trim() };
}

function samePartWork(sourceTitle: string, targetTitle: string) {
  const source = partWork(sourceTitle);
  const target = partWork(targetTitle);
  return (
    !!source && !!target && source.part === target.part && sameWorkTitle(source.root, target.root)
  );
}

/** An explicitly reviewed member of a multi-Part ANN parent; never changes that parent. */
export async function reviewedRouting(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  seriesId: Id<"series">,
) {
  const route = state.reviewed?.umbrellaRouting;
  if (!route) return false;
  if (state.observation.sourceKey !== "ann")
    return refuse("Umbrella routing requires ANN source provenance.");
  const line = state.observation.snapshot as AnnReleaseSnapshot;
  if (route.sourceTitle !== line.title) return refuse("Reviewed source title changed.");
  const series = await state.r.active(seriesId);
  const product = parseBookTitle(route.productTitle);
  if (
    !sameWorkTitle(product.seriesTitle, series.title) ||
    !labelsEqual(product.volumeLabel ?? null, route.productVolumeLabel)
  )
    return refuse("Reviewed product does not independently identify this work and Volume.");
  const source = partWork(line.title);
  if (
    !source ||
    !samePartWork(line.title, route.productTitle) ||
    !samePartWork(line.title, series.title)
  )
    return refuse("Known source root work or Part disagrees with reviewed product.");
  const parents = await state.r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "ann").eq("sourceRecordId", `manga:${line.mangaId}`),
      ),
  );
  const parent = parents[0]?.snapshot as
    | {
        kind?: string;
        title?: string;
        releases?: Array<{ annId: string; title: string; isbn13?: string }>;
      }
    | undefined;
  const parts = new Set(
    parent?.releases?.flatMap((r) => r.title.match(/\bPart\s+(\d+)\b/i)?.[1] ?? []) ?? [],
  );
  if (
    parents.length !== 1 ||
    parent?.kind !== "annManga" ||
    parts.size < 2 ||
    !parent.releases?.some(
      (r) =>
        r.annId === line.annId && r.title === line.title && toIsbn13(r.isbn13) === state.isbn13,
    )
  )
    return refuse(
      "Source parent does not preserve this exact product in a multi-Part manga entry.",
    );
  if (
    !parent.title ||
    !sameWorkTitle(mangaWorkTitle(parent.title), source.root) ||
    !state.source.series ||
    !sameWorkTitle(mangaWorkTitle(state.source.series.title), source.root)
  )
    return refuse("Source Part root work disagrees with its manga parent.");
  const names = [series.title, source.sourceWork];
  const reading = await readObservationBook(ctx, state.observation, [series], names);
  const facts = annContentFacts(line, names);
  if (
    (!sameWorkTitle(reading.work, source.root) && !samePartWork(reading.work, series.title)) ||
    reading.scope.length ||
    reading.unreadable.length ||
    facts.coverageGapped ||
    facts.positionConflict ||
    facts.formatConflict ||
    facts.title.kind === "ambiguous" ||
    !reading.label ||
    !labelsEqual(reading.label, route.productVolumeLabel)
  )
    return refuse("Known source work or independent Volume/page facts contradict Part routing.");
  return { sourceWork: source.sourceWork, rootWork: source.root };
}
