import { episodeRoute, type EpisodeRouting } from "./episodeRouting";
import { standalonePassageContradicts, type StandaloneIdentity } from "./standaloneIdentity";
import {
  projectSourceFormat,
  reviewedFormatRefusal,
  reviewedSnapshot,
  utf8Bytes,
  type ReviewedFormat,
} from "./sourceFormat";
import { type ProvisionalTitle, resolveBaseSeries } from "./catalogTitle";
import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type AnnReleaseSnapshot, lineOutOfScope } from "../ann";
import { placeEdition, REBINDER } from "../openLibrary";
import { contentRefusal, readObservationBook, readTitledRecord } from "../printings";
import {
  type AnnRelease,
  annContentFacts,
  annLinePackaged,
  packagingOf,
  readAnnLineTitle,
} from "./ann";
import { parseBookTitle, rangeLabels, outOfScopeReason } from "./bookTitle";
import { toIsbn13 } from "./isbn";
import { bindingFacts, bookFacts, type DigitalFileFormat, takesFormatSlot } from "./bookFacts";
import { labelsEqual, sameWorkTitle, type TitleScan } from "./matching";
import { type WorkContext, declaredWorkNames } from "./declaredWork";
import { holdOf } from "./observations";
import type { OlEditionSnapshot } from "./openLibrary";
import { findPublisherByName, siblingEditions } from "./pipeline";
import {
  type ClaimOwner,
  claimResolver,
  isbnClaims,
  MAX_DOCUMENT_BYTES,
  primaryIsbnsOf,
  readRoom,
  statedIsbns,
  takeWithin,
} from "./releaseIsbns";
import { evidenceUrls, isbnScope, scopeState } from "./scope";
import { distinctGuardFacts, nonJsonPath, valueHash } from "./values";

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

/** Capture resolver dependencies, including rejected candidates and merge/redirect hops.
 * A resolver's ordinary scan cap cannot certify a complete held-book guard.
 */
export function guardedResolverContext(ctx: QueryCtx, r: Reader): QueryCtx {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, prop) {
        const value: unknown = Reflect.get(on, prop, on);
        if (typeof value !== "function") return value;
        if (prop === "collect") return () => r.many(on as AsyncIterable<unknown>);
        if (prop === "take")
          return async (requested: number) => {
            await r.room();
            const cap = Math.min(requested, MAX_JOIN);
            const result: unknown = await value.call(on, cap + 1);
            if (!Array.isArray(result) || result.length > cap)
              return refuse("Resolver candidates exceed the complete bounded scan; incomplete.");
            r.facts.push(result);
            await r.room();
            return result;
          };
        if (prop === "get" || prop === "unique" || prop === "first" || prop === "next")
          return async (...args: unknown[]) => {
            await r.room();
            const result: unknown = await value.apply(on, args);
            r.facts.push(result);
            await r.room();
            return result;
          };
        return (...args: unknown[]) => {
          const result: unknown = value.apply(on, args);
          return result !== null && typeof result === "object" && !(result instanceof Promise)
            ? wrap(result)
            : result;
        };
      },
    });
  return { ...ctx, db: wrap(ctx.db) };
}

// Convex indexes at most 32 characters of a search term; a longer word proves nothing.
const MAX_SEARCH_TERM_BYTES = 32;

/**
 * A complete by-title scan for resolveBaseSeries. The index matches any one
 * word, so a whole title's hits are bounded only by its commonest word ("Made
 * in Abyss" shares "in" with hundreds of Series). Each word is scanned alone
 * instead (a lone term is prefix-matched: every Series holding the word), and
 * the scans that finish within MAX_JOIN are unioned. A Series with the title
 * holds its words (seriesByTitle asks with the source's spelling and the
 * folded key), so it is read unless every word overflows, which refuses.
 * Each word's hits, or its overflow, is a guard fact.
 */
function titleScan(ctx: QueryCtx, r: Reader): TitleScan {
  const scanned = new Map<string, Doc<"series">[] | null>();
  return async (text) => {
    const words = new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
    const hits = new Map<Id<"series">, Doc<"series">>();
    let complete = words.size === 0;
    for (const word of words) {
      let found = scanned.get(word);
      if (found === undefined) {
        const rows =
          utf8Bytes(word) > MAX_SEARCH_TERM_BYTES
            ? null
            : await takeWithin(
                ctx.db
                  .query("series")
                  .withSearchIndex("search_title", (q) => q.search("searchText", word)),
                MAX_JOIN + 1,
                r.room,
              );
        found = rows && rows.length <= MAX_JOIN ? rows : null;
        scanned.set(word, found);
        r.facts.push({ word, found });
      }
      if (!found) continue;
      complete = true;
      for (const doc of found) hits.set(doc._id, doc);
    }
    if (!complete)
      return refuse("Resolver candidates exceed the complete bounded scan; incomplete.");
    return [...hits.values()];
  };
}

/** resolveBaseSeries with every read a guard fact and every title lookup complete. */
const guardedBaseSeries = (ctx: QueryCtx, r: Reader, parsed: ProvisionalTitle) =>
  resolveBaseSeries(guardedResolverContext(ctx, r), parsed, titleScan(ctx, r));

/** Scan one Series under the transaction budget, retaining only requested labels.
 * Long works do not become ineligible merely because unrelated Volumes exceed a join limit.
 */
export async function volumesForLabels(
  ctx: QueryCtx,
  seriesId: Id<"series">,
  labels: readonly (string | null)[],
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
    const projection = projectSourceFormat(observation);
    if (projection.status === "stale") return refuse(projection.reason);
    const snapshot = projection.snapshot as OlEditionSnapshot;
    // The ISBN ladder can match a Release without resolving the source title.
    // Work provenance must come from the title's independent catalog resolution.
    const work = await guardedBaseSeries(ctx, r, snapshot);
    r.facts.push(work);
    const placement = await placeEdition(ctx, snapshot);
    return {
      series: work.candidates.length === 1 ? await r.active(work.candidates[0]!._id) : null,
      placement,
      parent: null,
    };
  }
  const key =
    observation.sourceKey === "ann" && s.mangaId
      ? `manga:${s.mangaId}`
      : observation.sourceKey === "kodansha" && s.seriesSlug
        ? `series:${s.seriesSlug}`
        : null;
  if (!key) return { series: null, placement: null, parent: null };
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
  return { series: await r.active(parent.recordRef.id), placement: null, parent };
}

/**
 * Declared names of a non-ANN source's independently resolved Series (Open
 * Library title resolution or Kodansha parent), never the ISBN holder's.
 */
function declaredWorkContext(
  state: Awaited<ReturnType<typeof heldState>>,
  series: Doc<"series">,
): WorkContext | undefined {
  if (state.observation.sourceKey === "ann" || state.source.series?._id !== series._id)
    return undefined;
  return { seriesId: series._id, names: declaredWorkNames(state.source.series), parentTitle: null };
}

/** Names belong to the verified current survivor, never the ISBN holder or parent aliases. */
function annWorkContext(
  state: Awaited<ReturnType<typeof heldState>>,
  series: Doc<"series">,
): WorkContext | undefined {
  if (
    state.observation.sourceKey !== "ann" ||
    !state.source.parent ||
    state.source.series?._id !== series._id
  )
    return undefined;
  const title = (state.source.parent.snapshot as { title?: unknown }).title;
  return {
    seriesId: series._id,
    names: declaredWorkNames(state.source.series),
    parentTitle: typeof title === "string" ? title : null,
  };
}

/**
 * Complete ordered canonical content, including identity dependencies and
 * current revisions. `lenient` (a box set's member, lib/repair/ops.ts
 * releaseBundle) also takes an Unmapped Packaging member, with no contents,
 * and partial coverage: a box set holds the book whatever it collects.
 */
export async function releaseContents(
  ctx: QueryCtx,
  id: Id<"releases">,
  r: Reader,
  lenient = false,
) {
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
  if (edition.coverageUnmapped && !lenient) return refuse("Edition contents are unmapped.");
  const rows = (
    await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    )
  ).sort((a, b) => a.order - b.order);
  if (!rows.length && !(lenient && edition.coverageUnmapped))
    return refuse("Edition has no contents.");
  const contents = [];
  for (const row of rows) {
    const volume = await r.active(row.volumeId);
    const work = await r.active(volume.seriesId);
    if ((row.extent !== "complete" && !lenient) || !series.some((s) => s._id === work._id))
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

/**
 * Whether a source and a Release both state a file format and state
 * different ones. An unstated file format is unknown (glossary: Format).
 */
function fileFormatsDisagree(source: { digitalFileFormat?: unknown }, release: Doc<"releases">) {
  return (
    source.digitalFileFormat !== undefined &&
    release.digitalFileFormat !== undefined &&
    source.digitalFileFormat !== release.digitalFileFormat
  );
}

/** Own-ISBN linking may compare complete packaged contents. A Line ID alone supplies no contents. */
export async function contentMatch(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  target: Contents,
) {
  const observation = state.observation;
  const s = state.effective.snapshot as {
    title?: string;
    format?: string;
    digitalFileFormat?: string;
    publishers?: string[];
    page?: { distributor?: string };
    imprint?: string;
  };
  if (s.format !== target.release.format) return refuse("Source and target formats disagree.");
  if (fileFormatsDisagree(s, target.release))
    return refuse("Source and target file formats disagree.");
  const selected = target.series.find((one) => one._id === state.source.series?._id);
  const context = selected
    ? (annWorkContext(state, selected) ?? declaredWorkContext(state, selected))
    : undefined;
  const ordinary = await contentRefusal(ctx, observation, target.release, target.series, context);
  if (!ordinary) return;
  if (observation.sourceKey !== "ann") return refuse(ordinary);
  const line = observation.snapshot as AnnReleaseSnapshot;
  const names = context?.names ?? target.series.map((s) => s.title);
  const scope = lineOutOfScope(line, names);
  if (scope) return refuse(scope);
  const segmented = readAnnLineTitle(line.title, { names });
  if (segmented.kind === "ambiguous") return refuse("ANN work identity is unresolved.");
  const series = context
    ? names.some((name) => sameWorkTitle(name, segmented.work))
      ? selected
      : undefined
    : target.series.find((one) => sameWorkTitle(one.title, segmented.work));
  if (!series) return refuse("ANN work identity is unresolved.");
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
  // Packaging relaxes the printing-only single-Volume rule, while retaining
  // the same source identity and physical-product checks as reviewed links.
  await sourceContentsMatch(ctx, state, [target], series, false);
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

/**
 * A hidden Release whose every primary ISBN has a current, approved exact-ISBN
 * libraryRebind decision with evidence, and is that ISBN's sole owner: a
 * reviewed library copy. It keeps its Edition, Volume, coverage, sources and
 * ISBN, but not the publisher's ordinary format slot. Every read joins the
 * guard, so a revoked decision or a changed claim invalidates a preview.
 * Status and ISBN prefixes alone never qualify a Release.
 */
async function reviewedLibraryCopy(ctx: QueryCtx, release: Doc<"releases">, r: Reader) {
  if (release.status !== "hidden") return false;
  const keys = primaryIsbnsOf(release);
  if (!keys.size) return false;
  for (const isbn of keys) {
    const scope = await scopeState(ctx, isbn);
    r.facts.push(scope);
    if (scope.active?.reason !== "libraryRebind" || !scope.active.evidenceUrls.length) return false;
    if ((await r.read(scope.active.proposalId))?.state !== "approved") return false;
    const claims = await isbnClaims(ctx, isbn, {
      resolver: claimResolver(ctx, { room: r.room }),
      room: r.room,
    });
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.owners.size !== 1 ||
      !claims.owners.has(release._id)
    )
      return false;
    r.facts.push([...claims.owners.values()]);
  }
  return true;
}

/**
 * The publisher's ordinary single-Volume slot a replay would fill, using the
 * sibling ownership rules of member placement: `free`, taken by an `active`
 * Release, or `reserved` by a hidden or merged one. Only a reviewed library
 * copy (reviewedLibraryCopy) leaves it free. Another file format frees it only
 * where both Releases' file formats are known. A free slot has at most one
 * surviving active, unlocked sibling Edition, which createCanonicalRecords
 * reuses (findSiblingEdition).
 */
async function replayFormatSlot(
  ctx: QueryCtx,
  slot: { series: Doc<"series">; volumeLabel: string | null; publisher: Doc<"publishers"> },
  fact: { format: "physical" | "digital"; digitalFileFormat?: DigitalFileFormat },
  r: Reader,
): Promise<"free" | "active" | "reserved"> {
  const volumes = await volumesForLabels(ctx, slot.series._id, [slot.volumeLabel], r);
  // labelsEqual treats an absent label as the ordinary unlabeled Volume.
  const selected = volumes.filter((v) => labelsEqual(v.label, slot.volumeLabel));
  const active = selected.filter((v) => v.status === "active");
  if (active.length !== 1) return refuse("Replay Volume is absent or ambiguous.");
  const volume = await r.active(active[0]!._id);
  for (const candidate of selected) {
    if ((await r.active(candidate._id))._id !== volume._id)
      return refuse("Replay Volume ownership is unresolved.");
  }
  const siblings = await siblingEditions(
    guardedResolverContext(ctx, r),
    slot.publisher._id,
    [volume._id],
    null,
  );
  const exact = new Set(siblings.map((edition) => edition._id));
  const survivors = new Set<Id<"editions">>();
  let taken: "free" | "active" | "reserved" = "free";
  for (const sibling of siblings) {
    const edition = await r.active(sibling._id);
    if (!exact.has(edition._id)) return refuse("Replay Edition merged outside this slot.");
    survivors.add(edition._id);
    const releases = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", sibling._id)),
    );
    for (const release of releases) {
      if (!takesFormatSlot(release, fact.format, fact.digitalFileFormat)) continue;
      if (release.status === "active") taken = taken === "free" ? "active" : taken;
      else if (!(await reviewedLibraryCopy(ctx, release, r))) taken = "reserved";
    }
  }
  if (survivors.size > 1) return refuse("Replay Edition ownership is ambiguous.");
  return taken;
}

/**
 * ANN's ordinary single-Volume creation (ann.applyReleasePage), proved before
 * the stored adapter runs: an in-scope, unpackaged line of the parent's
 * Series, its page's own ISBN and an existing publisher. Returns the slot that
 * line would fill, or null where the adapter holds or packages it instead.
 */
function annReplaySlot(
  line: AnnReleaseSnapshot,
  isbn13: string | undefined,
  series: Doc<"series">,
  publisher: Doc<"publishers">,
) {
  const names = [series.title];
  if (
    line.page?.status !== "ok" ||
    !isbn13 ||
    toIsbn13(line.page.isbn13 ?? line.isbn13) !== isbn13 ||
    line.coverageGapped ||
    lineOutOfScope(line, names) !== null ||
    annLinePackaged(line, names)
  )
    return null;
  return { series, volumeLabel: line.label ?? null, publisher };
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
  const effective = projectSourceFormat(observation);
  if (effective.status === "stale") return refuse(effective.reason);
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
      ? { series: null, placement: null, parent: null }
      : await sourceSeries(ctx, observation, r);
  r.facts.push(source.placement);
  let replayBefore: Awaited<ReturnType<typeof replaySlots>> | null = null;
  let annCreate = false;
  if (replay) {
    if (target || terminal || !source.series)
      return refuse("Replay needs an unlinked source with a resolved canonical work.");
    replayBefore = await replaySlots(ctx, source.series, r);
    if (source.placement?.kind === "create") {
      await r.active(source.placement.publisher._id);
      const snapshot = effective.snapshot as OlEditionSnapshot;
      if ((await replayFormatSlot(ctx, source.placement, snapshot, r)) !== "free")
        return refuse("Replay format slot is occupied; restore or resolve its existing Release.");
    } else {
      const snapshot = observation.snapshot as AnnReleaseSnapshot;
      const publisher = snapshot.page?.distributor
        ? await findPublisherByName(ctx, snapshot.page.distributor)
        : null;
      if (!publisher) return refuse("Replay publisher is unresolved.");
      await r.active(publisher._id);
      // An active occupant stays the adapter's own link-or-hold decision.
      const slot = annReplaySlot(snapshot, isbn13, source.series, publisher);
      const taken = slot && (await replayFormatSlot(ctx, slot, snapshot, r));
      if (taken === "reserved")
        return refuse("Replay format slot is occupied; restore or resolve its existing Release.");
      annCreate = taken === "free";
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
    if (reviewed.standalone) {
      if (observation.sourceKey !== "ann" || target?.type !== "release")
        return refuse("Standalone review requires an ANN own-release target.");
      // Pin every row, including hidden/merged history, before constructing expected.
      // New active content units invalidate the preview even outside target coverage.
      const workVolumes = await r.many(
        ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", reviewed.seriesId)),
      );
      for (const ref of [
        { type: "series" as const, id: reviewed.seriesId },
        { type: "publisher" as const, id: reviewed.publisherId },
        ...workVolumes.map((volume) => ({ type: "volume" as const, id: volume._id })),
      ]) {
        r.facts.push(
          await takeWithin(
            ctx.db
              .query("revisions")
              .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
              .order("desc"),
            1,
            r.room,
          ),
        );
      }
      for (const name of [
        reviewed.standalone.publisherName,
        (observation.snapshot as AnnReleaseSnapshot).page?.distributor,
      ]) {
        if (name) await findPublisherByName(guardedResolverContext(ctx, r), name);
      }
    }
  }
  let episode: ReturnType<typeof episodeRoute> | null = null;
  if (reviewed?.episodeRouting) {
    if (
      reviewed.umbrellaRouting ||
      reviewed.collectionRouting ||
      reviewed.titledVolume ||
      replay ||
      bundle ||
      !contents ||
      contents.series.length !== 1 ||
      contents.series[0]!._id !== reviewed.seriesId ||
      contents.publisher._id !== reviewed.publisherId ||
      contents.contents.length !== 1 ||
      contents.contents[0]!.volume._id !== reviewed.volumeIds[0] ||
      reviewed.volumeIds.length !== 1 ||
      contents.contents[0]!.work._id !== reviewed.seriesId ||
      contents.line ||
      effective.status !== "raw"
    )
      return refuse(
        "Episode routing requires one exact existing complete local Volume and no other routing proof.",
      );
    try {
      episode = episodeRoute({
        observation,
        parent: source.parent,
        umbrella: source.series,
        isbn13: isbn13 ?? null,
        proof: reviewed.episodeRouting,
        evidenceUrls: reviewed.evidenceUrls,
        series: contents.series[0]!,
        publisher: contents.publisher,
        release: contents.release,
        volume: contents.contents[0]!.volume,
      });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  }
  const eligible =
    !observation.withdrawn &&
    !observation.recordRef &&
    hold !== null &&
    proposal?.state !== "inReview";
  const state = {
    observation,
    effective,
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
    expected: "",
    eligible,
    r,
    reviewed,
    episode,
    heldSeries,
    replayBefore,
    annCreate,
  };
  if (reviewed?.collectionRouting) {
    if (!eligible || scopeReason)
      return refuse(scopeReason ?? "Collection product must remain held and unlinked.");
    if (
      !contents ||
      bundle ||
      target?.type !== "release" ||
      target.id !== contents.release._id ||
      contents.release.editionId !== contents.edition._id
    )
      return refuse(
        "Collection routing requires its own active Release and Edition, without redirects.",
      );
    await reviewedMatch(ctx, state, [contents]);
  }
  state.expected = valueHash({
    observationId,
    target: target ?? null,
    reviewed: reviewed ?? null,
    replay,
    facts: target?.type === "bundle" ? distinctGuardFacts(r.facts) : r.facts,
    bootstrap,
  });
  if (new TextEncoder().encode(state.expected).length > MAX_GUARD_BYTES)
    return refuse("Guard exceeds 256 KiB; inspect this record separately.");
  return state;
}

/**
 * The publisher names a source record states about itself: ANN's distributor,
 * Open Library's publishers, Seven Seas' own name, or a store's imprint.
 * kodansha.us states none: it lists Vertical's books too and names no
 * imprint. Used by publisherMatch and G1's unmapped link (lib/unmappedLink.ts).
 */
export function sourcePublisherNames(sourceKey: string, snapshot: unknown): string[] {
  const s = snapshot as {
    publishers?: unknown;
    imprint?: unknown;
    page?: { distributor?: unknown };
  };
  const names =
    sourceKey === "ann"
      ? [s.page?.distributor]
      : sourceKey === "openlibrary"
        ? Array.isArray(s.publishers)
          ? s.publishers
          : []
        : sourceKey === "sevenseas"
          ? ["Seven Seas Entertainment"]
          : [s.imprint];
  return names.filter((name): name is string => typeof name === "string" && name !== "");
}

/** Publisher identity uses the source's own resolver. Corporate-family acceptance is deferred. */
export async function publisherMatch(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
  publisherId: Id<"publishers">,
) {
  const names = sourcePublisherNames(observation.sourceKey, observation.snapshot);
  if (!names.length)
    return refuse("Source publisher identity is unknown; exact-ISBN review is required.");
  for (const name of names) {
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
  const format = (state.effective.snapshot as { format?: string }).format;
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
  const context = state.source.series ? annWorkContext(state, state.source.series) : undefined;
  const names = context?.names ?? [state.source.series?.title ?? ""];
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
  standalone?: StandaloneIdentity;
  titledVolume?: { productTitle: string; volumeTitle: string; productVolumeLabel: string };
  episodeRouting?: EpisodeRouting;
  collectionRouting?: {
    sourceTitle: string;
    productTitle: string;
    productVolumeLabel: string;
    productEvidence: { url: string; sha256: string; publisherName: string };
    parentSeriesId: Id<"series">;
    parentObservationId: Id<"sourceObservations">;
    binding: "hardcover" | "paperback";
  };
  umbrellaRouting?: { sourceTitle: string; productTitle: string; productVolumeLabel: string };
};
export async function reviewedMatch(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  contents: Contents[],
  newBundleName?: string,
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
  await sourceContentsMatch(ctx, state, contents, series, routed, newBundleName);
  if (
    routed &&
    (actual.length !== 1 ||
      !labelsEqual(
        actual[0]!.volume.label ?? null,
        (proof.episodeRouting ?? proof.collectionRouting ?? proof.umbrellaRouting)!
          .productVolumeLabel,
      ))
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
  newBundleName?: string,
) {
  const actual = contents.flatMap((content) => content.contents);
  if (state.episode) {
    // episodeRoute checked every original title, page, parent, SKU, format and local/global fact
    // before the expected guard was computed. Never rewrite the source or suppress reader flags.
    if (
      contents.length !== 1 ||
      actual.length !== 1 ||
      actual[0]!.work._id !== series._id ||
      actual[0]!.volume._id !== state.reviewed?.volumeIds[0] ||
      actual[0]!.extent !== "complete" ||
      actual[0]!.volume.label !== state.episode.localLabel
    )
      return refuse("Episode complete canonical contents changed.");
    return { packaged: false, hasKnownRange: false };
  }
  if (actual.some((content) => content.work._id !== series._id))
    return refuse("Complete canonical contents belong to another work.");
  const proof = state.reviewed;
  const s = state.effective.snapshot as {
    title?: string;
    subtitle?: string;
    seriesTitle?: string;
    format?: string;
    digitalFileFormat?: string;
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
  if (contents.some((c) => fileFormatsDisagree(s, c.release)))
    return refuse("Source and target file formats disagree.");
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
    const context = state.reviewed?.collectionRouting
      ? { seriesId: series._id, names: [series.title], parentTitle: series.title }
      : routed
        ? undefined
        : annWorkContext(state, series);
    const workNames = context?.names ?? [series.title];
    const names = routed ? [series.title, routed.sourceWork] : workNames;
    const reading = await readObservationBook(ctx, state.observation, [series], names, context);
    const named = readAnnLineTitle(line.title, { names });
    const parent = state.source.parent?.snapshot as
      | { kind?: string; id?: string; title?: string }
      | undefined;
    // Shared by the reviewed readings below: an exact own-ISBN review of this
    // ANN line under its own parent and Series, one target Edition, no route.
    const exactLine =
      !routed &&
      !state.bundle &&
      contents.length === 1 &&
      proof?.sourceTitle === line.title &&
      proof.evidenceUrls.length > 0 &&
      line.page?.status === "ok" &&
      line.page.title === line.title &&
      toIsbn13(line.page.isbn13) === proof.isbn13 &&
      state.source.series?._id === series._id &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      workNames.some((name) => sameWorkTitle(parent.title!, name));
    // Only an exact-ISBN publisher review may identify this one book's subtitle.
    // Keep the raw reader's binding, labels, scope and technical clauses intact.
    const title = parseBookTitle(line.title).seriesTitle;
    const subtitle = /^(.*?)\s+[-–—]\s+(.+)$/.exec(title);
    const reviewedSubtitle =
      !routed &&
      !state.bundle &&
      proof?.sourceTitle === line.title &&
      proof.evidenceUrls.length > 0 &&
      line.page?.status === "ok" &&
      toIsbn13(line.page.isbn13) === proof.isbn13 &&
      proof.volumeIds.length === 1 &&
      actual.length === 1 &&
      actual[0]!.extent === "complete" &&
      actual[0]!.volume._id === proof.volumeIds[0] &&
      actual[0]!.work._id === proof.seriesId &&
      proof.seriesId === series._id &&
      state.source.series?._id === series._id &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      workNames.some((name) => sameWorkTitle(parent.title!, name)) &&
      subtitle !== null &&
      workNames.some((name) => sameWorkTitle(subtitle[1]!, name)) &&
      !/\b(?:part|episode|novel)\b/i.test(subtitle[2]!) &&
      (!contents.some((content) => content.line) ||
        (contents.length === 1 &&
          /^second edition$/i.test(contents[0]!.line?.name ?? "") &&
          parseBookTitle(line.title).formatTags.length === 1 &&
          /^2nd Edition$/i.test(parseBookTitle(line.title).formatTags[0]!) &&
          reading.label !== undefined &&
          labelsEqual(contents[0]!.edition.linePosition ?? null, reading.label))) &&
      !line.multi &&
      !line.editionLineHint &&
      !line.coverRange &&
      !line.coverageGapped &&
      !bookFacts(line.title, workNames).packaging.length &&
      reading.label !== undefined &&
      labelsEqual(actual[0]!.volume.label ?? null, reading.label) &&
      sameWorkTitle(reading.work, title);
    // A bracketed edition descriptor ("[Authentic Relaunch]", "[2nd Ed]") names
    // this exact Edition Line, not the work. Keep the raw reader's volume,
    // scope, binding and format facts in force.
    const tagged = /^(.*?)(?:\s+[-–—])?\s+\[([^[\]]+)\]$/.exec(line.title);
    const descriptor = tagged ? editionDescriptor(tagged[2]!) : null;
    const reviewedEditionTag =
      !routed &&
      !state.bundle &&
      proof?.sourceTitle === line.title &&
      proof.evidenceUrls.length > 0 &&
      line.page?.status === "ok" &&
      line.page.title === line.title &&
      toIsbn13(line.page.isbn13) === proof.isbn13 &&
      state.source.series?._id === series._id &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      workNames.some((name) => sameWorkTitle(parent.title!, name)) &&
      tagged !== null &&
      descriptor !== null &&
      workNames.some((name) => sameWorkTitle(tagged[1]!, name)) &&
      contents.length === 1 &&
      contents[0]!.line?.seriesId === series._id &&
      sameWorkTitle(contents[0]!.line.name, descriptor) &&
      actual.length === 1 &&
      actual[0]!.extent === "complete" &&
      reading.label !== undefined &&
      labelsEqual(actual[0]!.volume.label ?? null, reading.label) &&
      labelsEqual(contents[0]!.edition.linePosition ?? null, reading.label) &&
      !line.multi &&
      !line.editionLineHint &&
      !line.coverRange &&
      !line.coverageGapped &&
      reading.packaging.every(
        (fact) =>
          fact === `ANN's page title "${line.title}"` ||
          fact === `the bracketed part of "${line.title}"`,
      ) &&
      sameWorkTitle(reading.work, line.title);
    // Exact own-ISBN product review identifies a titled member, never a Series alias.
    // The existing ANN reader still owns all numeric, scope and format statements.
    const titled = proof?.titledVolume;
    const reviewedTitled = !!titled;
    if (titled) {
      const titleFacts = bookFacts(titled.volumeTitle);
      if (
        routed ||
        state.source.series?._id !== series._id ||
        proof.sourceTitle !== line.title ||
        !titled.volumeTitle.trim() ||
        line.title !== `${series.title} - ${titled.volumeTitle}` ||
        titled.productTitle !==
          `${series.title} Vol. ${titled.productVolumeLabel}: ${titled.volumeTitle}` ||
        actual.length !== 1 ||
        actual[0]!.extent !== "complete" ||
        !labelsEqual(actual[0]!.volume.label ?? null, titled.productVolumeLabel) ||
        !reading.label ||
        !labelsEqual(reading.label, titled.productVolumeLabel) ||
        reading.packaging.length ||
        titleFacts.labels.length ||
        titleFacts.packaging.length ||
        titleFacts.unreadable.length ||
        titleFacts.bindings.length ||
        titleFacts.digital ||
        outOfScopeReason(titled.volumeTitle)
      )
        return refuse("Reviewed titled product does not identify this exact complete Volume.");
    }
    // An exact product review may identify ANN's space-separated 3-in-1 suffix.
    // The stored reader's numeric, format and conflict facts still apply.
    const threeInOne = /^(.*?)\s+3 in 1 Edition$/i.exec(line.title);
    const reviewedThreeInOne =
      !routed &&
      !state.bundle &&
      proof?.sourceTitle === line.title &&
      proof.evidenceUrls.length > 0 &&
      line.page?.status === "ok" &&
      line.page.title === line.title &&
      toIsbn13(line.page.isbn13) === proof.isbn13 &&
      state.source.series?._id === series._id &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      workNames.some((name) => sameWorkTitle(parent.title!, name)) &&
      threeInOne !== null &&
      workNames.some((name) => sameWorkTitle(threeInOne[1]!, name)) &&
      contents.length === 1 &&
      contents[0]!.line?.name === "Omnibus" &&
      actual.length === 3 &&
      actual.every((row) => row.extent === "complete") &&
      reading.label !== undefined &&
      labelsEqual(contents[0]!.edition.linePosition ?? null, reading.label);
    // A reviewed Season/Box product can be titled beyond its parent work.
    // Exact title text plus selected IDs cannot excuse an unrelated known work.
    const productWork = (
      state.bundle &&
      proof?.sourceTitle === line.title &&
      state.source.series?._id === series._id &&
      named.kind === "line" &&
      named.lineName === "Box Set" &&
      /\bSeason\s+\d+(?:\s+Part\s+\d+)?$/i.test(named.work)
        ? named.work
        : line.title
    ).replace(
      /\s*(?:[-–—:]\s*)?(?:Season\s+\d+(?:\s+Part\s+\d+)?|Box\s+Set(?:\s+\d+)?)(?:\s+Manga\s+Box\s+Set)?$/i,
      "",
    );
    const reviewedProduct =
      proof?.sourceTitle === line.title &&
      state.source.series?._id === series._id &&
      annLinePackaged(line, [series.title]) &&
      sameWorkTitle(productWork, series.title);
    // An exact package review may read the words between the work and "Box Set"
    // as the box's own qualifier ("Claymore - Complete Box Set", "One Piece -
    // East Blue and Baroque Works Box Set"), never as another work. ANN's
    // parent and stated range, the reviewed Volumes and the ordered members
    // must all agree (the range is compared below); "Complete" must also be
    // every active Volume of the work.
    const boxed = /^(.*?)\s+[-–—]\s+(.+?)\s+Box\s+Set$/i.exec(line.title);
    const qualifier = boxed ? boxQualifier(boxed[2]!) : null;
    const reviewedQualifier =
      boxed !== null &&
      qualifier !== null &&
      !routed &&
      !!(state.bundle || newBundleName) &&
      // A creation packet's product name, then the Bundle it created, is
      // its reviewed source title.
      (proof?.sourceTitle ?? newBundleName ?? state.bundle?.name) === line.title &&
      proof?.isbn13 === state.isbn13 &&
      proof.evidenceUrls.length > 0 &&
      line.page?.status === "ok" &&
      line.page.title === line.title &&
      toIsbn13(line.page.isbn13) === proof.isbn13 &&
      state.source.series?._id === series._id &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      workNames.some((name) => sameWorkTitle(parent.title!, name)) &&
      workNames.some((name) => sameWorkTitle(boxed[1]!, name)) &&
      line.format === "physical" &&
      line.multi &&
      !!line.coverRange &&
      !line.coverageGapped &&
      reading.label === undefined &&
      (await qualifierAgrees(ctx, state.r, series, qualifier, boxed[2]!, boxed[1]!, actual));
    // The ANN grammar can leave an edition descriptor in the work when a line
    // word follows it ("No Longer Human Complete Edition Omnibus" reads work
    // "No Longer Human Complete Edition", line "Omnibus"). An exact review may
    // read the descriptor as the line's, only when the rest is a declared work
    // name, the ANN parent is that work, and descriptor plus line word is the
    // target's own Edition Line name. Numbers, scope and ranges stay binding.
    const qualifiedWork =
      exactLine && named.kind === "line" && named.lineName
        ? workNames.find((name) => reading.work.toLowerCase().startsWith(`${name.toLowerCase()} `))
        : undefined;
    const lineDescriptor =
      qualifiedWork !== undefined
        ? editionDescriptor(reading.work.slice(qualifiedWork.length))
        : null;
    const reviewedLineDescriptor =
      lineDescriptor !== null &&
      // This compound grammar recognizes "Complete Edition Omnibus" only.
      // The generic bracket descriptor reader accepts arbitrary words, which
      // cannot prove that a work suffix is an edition rather than another work.
      /^Complete Edition$/i.test(lineDescriptor) &&
      named.kind === "line" &&
      named.lineName === "Omnibus" &&
      parent?.kind === "annManga" &&
      parent.id === line.mangaId &&
      parent.title !== undefined &&
      sameWorkTitle(parent.title, qualifiedWork!) &&
      contents[0]!.line?.seriesId === series._id &&
      sameWorkTitle(contents[0]!.line.name, `${lineDescriptor} ${named.lineName}`)
        ? `${lineDescriptor} ${named.lineName}`
        : null;
    if (
      named.kind === "ambiguous" ||
      (!workNames.some((name) => sameWorkTitle(reading.work, name)) &&
        !reviewedLineDescriptor &&
        !(
          routed &&
          (sameWorkTitle(reading.work, routed.rootWork) || samePartWork(reading.work, series.title))
        ) &&
        !reviewedProduct &&
        !reviewedSubtitle &&
        !reviewedEditionTag &&
        !reviewedTitled &&
        !reviewedThreeInOne &&
        !reviewedQualifier) ||
      reading.scope.length ||
      reading.unreadable.length
    )
      return refuse(
        `Known ANN work "${reading.work}", scope or unreadable facts contradict review: ${reading.unreadable.join("; ")}`,
      );
    let facts = annContentFacts(line, names);
    // ANN's grammar holds an English number word unread ("Book One"). An exact
    // review may read the one "Book <word>" as its digit only when that
    // re-read is conflict-free, changes nothing else, and the shared title
    // parser and the stored reader state the same position.
    const word = /\bBook\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)\b/;
    const spelled = word.exec(line.title)?.[1];
    if (exactLine && facts.positionConflict && spelled && line.title.split(word).length === 3) {
      const digit = String(
        [
          "One",
          "Two",
          "Three",
          "Four",
          "Five",
          "Six",
          "Seven",
          "Eight",
          "Nine",
          "Ten",
          "Eleven",
          "Twelve",
        ].indexOf(spelled) + 1,
      );
      const title = line.title.replace(word, `Book ${digit}`);
      const reread = annContentFacts({ ...line, title, page: { ...line.page!, title } }, names);
      if (
        !reread.positionConflict &&
        reread.position === digit &&
        reading.label === digit &&
        parseBookTitle(line.title).packaging?.linePosition === digit &&
        reread.lineName === facts.lineName &&
        reread.coverageGapped === facts.coverageGapped &&
        reread.formatConflict === facts.formatConflict &&
        JSON.stringify(reread.coverRange) === JSON.stringify(facts.coverRange)
      )
        facts = reread;
    }
    if (
      facts.coverageGapped ||
      facts.positionConflict ||
      facts.formatConflict ||
      facts.title.kind === "ambiguous"
    )
      return refuse("Known ANN content/position/format conflict.");
    ranges.push(facts.coverRange);
    packaged = reviewedThreeInOne || (!reviewedEditionTag && reading.packaging.length > 0);
    sourceLabel = reading.label;
    sourceBinding = reading.binding;
    lineName = reviewedThreeInOne ? "3 in 1 Edition" : (reviewedLineDescriptor ?? facts.lineName);
    position = facts.position;
    if (proof?.standalone) {
      await standaloneMatch(ctx, state, contents, series, reading, facts, routed);
    }
    if (!packaged && reading.needsLabel && !sourceLabel && !proof?.standalone)
      return refuse("ANN states no Volume; exact contents remain unknown.");
  } else {
    const title = state.observation.sourceKey === "kodansha" ? s.seriesTitle : s.title;
    if (!title) return refuse("Missing work context cannot be replaced by review.");
    const workNames =
      state.source.series?._id === series._id ? declaredWorkNames(series) : [series.title];
    const reading = readTitledRecord(
      state.observation.sourceKey,
      title,
      state.effective.snapshot as Parameters<typeof readTitledRecord>[2],
      workNames,
      declaredWorkContext(state, series),
    );
    // An exact-ISBN package review may reconcile a leading article only after
    // independent source resolution and complete ordered contents agree.
    const reviewedArticle =
      !!state.bundle &&
      reading.packaging.length > 0 &&
      proof?.sourceTitle === title &&
      proof.isbn13 === state.isbn13 &&
      state.source.series?._id === series._id &&
      !!s.seriesTitle &&
      sameWorkTitle(reading.work, s.seriesTitle) &&
      workNames.some((name) =>
        sameWorkTitle(reading.work.replace(/^the\s+/i, ""), name.replace(/^the\s+/i, "")),
      );
    // Open Library can retain "Complete" or "Manga" in a box's work name.
    // Reconcile only a trailing package qualifier or leading article after
    // independent Series context and all ordered member contents agree.
    const packageWork = reading.work.replace(/\s+(?:complete|manga)$/i, "");
    const withoutArticle = (name: string) => name.replace(/^the\s+/i, "");
    if (
      state.observation.sourceKey === "openlibrary" &&
      (state.bundle || newBundleName) &&
      reading.packaging.length > 0 &&
      s.seriesTitle &&
      !workNames.some((name) => sameWorkTitle(withoutArticle(s.seriesTitle!), withoutArticle(name)))
    )
      return refuse("Known source Series title contradicts package work.");
    const reviewedBoxWork =
      state.observation.sourceKey === "openlibrary" &&
      !!(state.bundle || newBundleName) &&
      proof?.isbn13 === state.isbn13 &&
      reading.packaging.length > 0 &&
      /\bbox\s*set\b/i.test(title) &&
      (!/\s+(?:complete|manga)$/i.test(reading.work) ||
        /\b(?:complete|manga)\s+box\s*set\b/i.test(title)) &&
      state.source.series?._id === series._id &&
      !!s.seriesTitle &&
      sameWorkTitle(withoutArticle(s.seriesTitle), withoutArticle(packageWork)) &&
      workNames.some((name) =>
        sameWorkTitle(withoutArticle(s.seriesTitle!), withoutArticle(name)),
      ) &&
      workNames.some((name) => sameWorkTitle(withoutArticle(packageWork), withoutArticle(name))) &&
      // Reconciling a leading article still needs the exact source title pinned,
      // as reviewedArticle does: the reviewed sourceTitle, else the Bundle's own name.
      ((proof.sourceTitle ?? newBundleName ?? state.bundle?.name) === title ||
        workNames.some((name) => sameWorkTitle(packageWork, name)));
    if (
      reading.scope.length ||
      reading.unreadable.length ||
      (!workNames.some((name) => sameWorkTitle(reading.work, name)) &&
        !reviewedArticle &&
        !reviewedBoxWork)
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
      [title, s.subtitle].some((text) => bookFacts(text, workNames).digital) &&
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
  const bundleName = state.bundle?.name ?? newBundleName;
  if (bundleName && packaged && position) {
    const targetPosition = parseBookTitle(bundleName).packaging?.linePosition;
    if (targetPosition && !labelsEqual(targetPosition, position))
      return refuse("Known Bundle position differs.");
  }
  if (!bundleName && packaged && lineName) {
    const target = contents[0]!;
    // ANN's 3-in-1 name can identify an Omnibus member after exact product
    // review. Keep its position and all three independently reviewed whole
    // Volumes binding; this does not infer coverage from the member number.
    const reviewedThreeInOne =
      state.observation.sourceKey === "ann" &&
      proof?.sourceTitle === s.title &&
      state.source.series?._id === series._id &&
      contents.length === 1 &&
      /^3[ -]in[ -]1(?: Edition)?$/i.test(lineName) &&
      target.line?.name === "Omnibus" &&
      !!position &&
      actual.length === 3 &&
      actual.every((row) => row.extent === "complete");
    if (
      !target.line ||
      (!sameWorkTitle(target.line.name, lineName) && !reviewedThreeInOne) ||
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

/** The reviewed exception supplies only missing extent. Every raw contradiction
 * and the independently resolved work remain binding; no source fact is rewritten.
 */
async function standaloneMatch(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  contents: Contents[],
  series: Doc<"series">,
  reading: Awaited<ReturnType<typeof readObservationBook>>,
  facts: ReturnType<typeof annContentFacts>,
  routed: Awaited<ReturnType<typeof reviewedRouting>>,
) {
  const review = state.reviewed!;
  const proof = review.standalone!;
  const line = state.observation.snapshot as AnnReleaseSnapshot;
  const page = line.page;
  const parent = state.source.parent;
  const parentSnapshot = parent?.snapshot as
    | { kind?: string; id?: string; title?: string; releases?: AnnReleaseSnapshot[] }
    | undefined;
  const entries = parentSnapshot?.releases?.filter((entry) => entry.annId === line.annId) ?? [];
  const entry = entries[0];
  const target = contents[0];
  const actual = contents.flatMap((c) => c.contents);
  const names = declaredWorkNames(series);
  const product = parseBookTitle(proof.productTitle);
  const productFacts = bookFacts(proof.productTitle);
  const active = (
    await state.r.many(
      ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", series._id)),
    )
  ).filter((volume) => volume.status === "active");
  const publisher = await findPublisherByName(ctx, proof.publisherName);
  const sourcePublisher =
    page?.status === "ok" && page.distributor
      ? await findPublisherByName(ctx, page.distributor)
      : null;
  if (
    state.observation.sourceKey !== "ann" ||
    routed ||
    state.bundle ||
    review.titledVolume ||
    review.umbrellaRouting ||
    !parent ||
    parent._id !== proof.parentObservationId ||
    parentSnapshot?.kind !== "annManga" ||
    parentSnapshot.id !== line.mangaId ||
    !parentSnapshot.title ||
    !names.some((name) => sameWorkTitle(parentSnapshot.title!, name)) ||
    entries.length !== 1 ||
    entry?.isbn13 !== proof.isbn13 ||
    entry.title !== line.title ||
    entry.label !== undefined ||
    entry.multi ||
    entry.editionLineHint ||
    entry.coverRange ||
    entry.coverageGapped ||
    entry.format !== proof.format ||
    state.source.series?._id !== series._id ||
    review.sourceTitle !== line.title ||
    proof.isbn13 !== state.isbn13 ||
    proof.isbn13 !== review.isbn13 ||
    page?.status !== "ok" ||
    page.isbn13 !== proof.isbn13 ||
    page.mangaId !== line.mangaId ||
    state.observation.sourceRecordId !== `release:${line.annId}` ||
    !target ||
    contents.length !== 1 ||
    target.release._id !== proof.releaseId ||
    target.release.seriesIds.length !== 1 ||
    target.release.seriesIds[0] !== series._id ||
    !primaryIsbnsOf(target.release).has(proof.isbn13) ||
    [target.release.isbn13, target.release.isbn10].some(
      (isbn) => isbn !== undefined && toIsbn13(isbn) !== proof.isbn13,
    ) ||
    state.claims.owners.size !== 1 ||
    !state.claims.owners.has(proof.releaseId) ||
    !publisher ||
    !sourcePublisher ||
    publisher._id !== review.publisherId ||
    sourcePublisher._id !== review.publisherId ||
    (reading.binding && reading.binding !== proof.binding) ||
    proof.format !== line.format ||
    proof.format !== target.release.format ||
    (proof.format === "digital"
      ? proof.binding !== undefined || target.release.binding !== undefined
      : !proof.binding || target.release.binding !== proof.binding) ||
    page.volume !== (proof.format === "digital" ? "eBook" : "GN") ||
    line.label !== undefined ||
    reading.label !== undefined ||
    reading.packaging.length > 0 ||
    reading.scope.length > 0 ||
    reading.unreadable.length > 0 ||
    line.multi ||
    line.editionLineHint ||
    line.coverRange ||
    line.coverageGapped ||
    facts.coverRange ||
    facts.coverageGapped ||
    facts.lineName ||
    facts.position ||
    target.line ||
    target.edition.linePosition !== undefined ||
    target.edition.coverageUnmapped ||
    actual.length !== 1 ||
    review.volumeIds.length !== 1 ||
    review.volumeIds[0] !== proof.volumeId ||
    actual[0]?.volume._id !== proof.volumeId ||
    actual[0]?.extent !== "complete" ||
    actual[0]?.volume.label !== undefined ||
    active.length !== 1 ||
    active[0]?._id !== proof.volumeId ||
    active[0]?.locked ||
    !names.some((name) => sameWorkTitle(product.seriesTitle, name)) ||
    product.volumeLabel ||
    product.packaging ||
    product.isBox ||
    product.isNovel ||
    productFacts.labels.length ||
    productFacts.packaging.length ||
    productFacts.unreadable.length ||
    productFacts.bindings.length ||
    productFacts.digital ||
    outOfScopeReason(proof.productTitle) ||
    // Standalone work names cannot use this path to route chapter/Part products.
    [line.title, page.title, parentSnapshot.title, proof.productTitle, proof.extentStatement].some(
      (text) => !!text && /\b(?:chapter|part|episode|novel)\b/i.test(text),
    ) ||
    standalonePassageContradicts(proof) ||
    outOfScopeReason(proof.extentStatement) ||
    !review.evidenceUrls.includes(proof.evidenceUrl) ||
    !proof.extentStatement.trim() ||
    proof.extentStatement.length > 4000 ||
    !Number.isFinite(proof.capture.fetchedAt) ||
    proof.capture.fetchedAt <= 0 ||
    !/^[a-f0-9]{64}$/.test(proof.capture.bodySha256) ||
    proof.capture.excerpt.length > 16000 ||
    !proof.capture.excerpt.includes(proof.isbn13) ||
    !proof.capture.excerpt.includes(proof.productTitle) ||
    !proof.capture.excerpt.includes(proof.extentStatement)
  )
    return refuse(
      "Reviewed standalone proof does not identify this exact whole unlabeled manga product.",
    );
  evidenceUrls([proof.evidenceUrl]);
}

/**
 * The Edition Line a bracketed descriptor names ("Authentic Relaunch"; "2nd
 * Ed" is "Second Edition"), or null when the bracket states anything else:
 * a number, range, binding, format, package, Part, store or out-of-scope word.
 */
function editionDescriptor(text: string): string | null {
  const ordinal = /^(1st|2nd|3rd)\s+Ed(?:\.|ition)?$/i.exec(text.trim())?.[1]?.toLowerCase();
  const name = ordinal
    ? `${{ "1st": "First", "2nd": "Second", "3rd": "Third" }[ordinal]} Edition`
    : text.trim();
  const facts = bookFacts(name);
  if (
    !name ||
    /[\d[\]()]/.test(name) ||
    /\b(?:part|season|episode|novel|vol(?:ume)?s?|book|box(?:ed)?|set|omnibus|nook|kindle|e-?book|digital)\b/i.test(
      name,
    ) ||
    facts.labels.length ||
    facts.packaging.length ||
    facts.unreadable.length ||
    facts.bindings.length ||
    facts.digital ||
    outOfScopeReason(name)
  )
    return null;
  return name;
}

/**
 * A box title's qualifier as a package reads it: "Complete", an anniversary,
 * or a plain arc name. Null for words that state contents, a variant printing
 * (collector's, deluxe, premium, limited, special) or another product kind.
 */
function boxQualifier(text: string): "complete" | "anniversary" | "arc" | null {
  const trimmed = text.trim();
  if (/^complete$/i.test(trimmed)) return "complete";
  if (/^\d+(?:st|nd|rd|th)\s+anniversary$/i.test(trimmed)) return "anniversary";
  const facts = bookFacts(trimmed);
  if (
    /[\d[\]()]/.test(trimmed) ||
    /\b(?:part|season|episode|novel|vol(?:ume)?s?|book|box(?:ed)?|set|edition|omnibus|collection|collector'?s|deluxe|premium|limited|special|variant|hardcover|complete|anniversary|art\s*books?|artbooks?|illustrations?|posters?|fan\s*books?|guide(?:\s*books?)?|data\s*books?|character\s*books?|anime|dvds?|blu-?rays?|soundtracks?|stickers?|figures?|bonus|extras?|exclusive|gift|slipcase)\b/i.test(
      trimmed,
    ) ||
    facts.labels.length ||
    facts.packaging.length ||
    facts.unreadable.length ||
    facts.bindings.length ||
    facts.digital ||
    outOfScopeReason(trimmed)
  )
    return null;
  return "arc";
}

/**
 * Whether the qualifier agrees with the work: "Complete" members are every
 * active Volume, and an arc name is no other Series' title, alone or after
 * the work ("Naruto - Boruto" is never a Naruto box). Every read is a fact.
 */
async function qualifierAgrees(
  ctx: QueryCtx,
  r: Reader,
  series: Doc<"series">,
  qualifier: "complete" | "anniversary" | "arc",
  arc: string,
  work: string,
  actual: Contents["contents"],
) {
  if (qualifier === "anniversary") return true;
  if (qualifier === "complete") {
    const active: Id<"volumes">[] = [];
    await r.room();
    for await (const volume of ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))) {
      if (volume.status === "active") active.push(volume._id);
      if (active.length > MAX_JOIN) return refuse("Complete box Volumes exceed 80; incomplete.");
      await r.room();
    }
    r.facts.push(active);
    const members = new Set(actual.map((row) => row.volume._id));
    return members.size === active.length && active.every((id) => members.has(id));
  }
  const others = (await titleScan(ctx, r)(arc)).filter((one) => one._id !== series._id);
  return !others.some((other) =>
    [other.title, ...other.altTitles].some(
      (title) =>
        [arc, `${work} - ${arc}`, `${work}: ${arc}`].some((name) => sameWorkTitle(title, name)) ||
        sameWorkTitle(title.split(/:\s|\s[-–—]\s/)[0]!, arc),
    ),
  );
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

/** One exact publisher product in its own collection Volume; the ANN parent stays linked. */
async function collectionRouting(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  seriesId: Id<"series">,
) {
  const proof = state.reviewed!;
  const route = proof.collectionRouting!;
  const target = state.contents;
  const line = state.observation.snapshot as AnnReleaseSnapshot;
  const series = await state.r.active(seriesId);
  const parent = state.source.parent;
  const snapshot = parent?.snapshot as
    | {
        kind?: string;
        id?: string;
        title?: string;
        releases?: AnnRelease[];
      }
    | undefined;
  const suffix = /^(.*?) (Full Color Collection|Paperback Collection)( \[Hardcover\])?$/.exec(
    line.title,
  );
  const binding = suffix?.[2] === "Full Color Collection" ? "hardcover" : "paperback";
  const work = suffix ? `${suffix[1]} ${suffix[2]}` : "";
  const member = snapshot?.releases?.filter((row) => row.annId === line.annId) ?? [];
  if (
    state.observation.sourceKey !== "ann" ||
    proof.umbrellaRouting ||
    proof.titledVolume ||
    !suffix ||
    !suffix[1] ||
    /\b(?:part|novel|neo|spinoff)\b/i.test(suffix[1]) ||
    series.title !== work ||
    route.sourceTitle !== line.title ||
    proof.sourceTitle !== line.title ||
    route.productTitle !== `${work} ${route.productVolumeLabel}` ||
    !/^\d+$/.test(route.productVolumeLabel) ||
    route.binding !== binding ||
    (binding === "paperback" && suffix[3]) ||
    state.observation.sourceRecordId !== `release:${line.annId}` ||
    !target ||
    state.bundle ||
    target.release.format !== "physical" ||
    line.format !== "physical" ||
    target.release.binding !== binding ||
    line.multi ||
    line.editionLineHint ||
    line.coverRange ||
    line.coverageGapped ||
    target.line ||
    target.contents.length !== 1 ||
    target.series.length !== 1 ||
    target.series[0]!._id !== seriesId ||
    target.contents[0]!.work._id !== seriesId ||
    target.contents[0]!.volume._id !== proof.volumeIds[0] ||
    proof.volumeIds.length !== 1 ||
    !labelsEqual(target.contents[0]!.volume.label, route.productVolumeLabel) ||
    state.claims.owners.size !== 1 ||
    !state.claims.owners.has(target.release._id) ||
    !primaryIsbnsOf(target.release).has(proof.isbn13) ||
    proof.isbn13 !== state.isbn13 ||
    toIsbn13(line.isbn13) !== proof.isbn13 ||
    !/^[a-f0-9]{64}$/.test(route.productEvidence.sha256) ||
    !proof.evidenceUrls.includes(route.productEvidence.url) ||
    ![route.productEvidence.url].some((url) => {
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        parsed.hostname === "www.penguinrandomhouse.com" &&
        parsed.pathname.startsWith("/books/") &&
        parsed.pathname.split("/").filter(Boolean).at(-1) === proof.isbn13
      );
    })
  )
    return refuse(
      "Reviewed collection product identity, binding, ISBN owner or complete Volume disagrees.",
    );
  if (
    !parent ||
    parent._id !== route.parentObservationId ||
    parent.sourceKey !== "ann" ||
    parent.sourceRecordId !== `manga:${line.mangaId}` ||
    snapshot?.kind !== "annManga" ||
    snapshot.id !== line.mangaId ||
    parent.recordRef?.type !== "series" ||
    parent.recordRef.id !== route.parentSeriesId ||
    state.source.series?._id !== route.parentSeriesId ||
    snapshot.title !== suffix[1] ||
    state.source.series.title !== suffix[1] ||
    member.length !== 1 ||
    member[0]!.title !== line.title ||
    toIsbn13(member[0]!.isbn13) !== proof.isbn13 ||
    !labelsEqual(member[0]!.label ?? null, route.productVolumeLabel) ||
    member[0]!.format !== "physical" ||
    member[0]!.multi !== false ||
    member[0]!.editionLineHint !== false ||
    member[0]!.coverRange ||
    member[0]!.coverageGapped
  )
    return refuse("Collection parent identity, recordRef or exact product membership disagrees.");
  const page = line.page;
  if (
    page?.status !== "ok" ||
    page.title !== line.title ||
    page.distributor !== route.productEvidence.publisherName ||
    page.mangaId !== line.mangaId ||
    toIsbn13(page.isbn13) !== proof.isbn13 ||
    (page.isbn10 && toIsbn13(page.isbn10) !== proof.isbn13) ||
    page.volume !== `GN ${route.productVolumeLabel}` ||
    !labelsEqual(line.label ?? null, route.productVolumeLabel)
  )
    return refuse("Collection source page ISBN, title, parent or GN label disagrees.");
  await publisherMatch(guardedResolverContext(ctx, state.r), state.observation, proof.publisherId);
  return { sourceWork: work, rootWork: suffix[1]! };
}

/** Preview and execution share this Series-review contract. Collection checks are also hashed by heldState. */
export async function validateSeriesReview(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  seriesId: Id<"series">,
) {
  if (!state.eligible || state.scopeReason)
    return refuse(state.scopeReason ?? "Book must remain held and unlinked.");
  const series = await state.r.active(seriesId);
  if (state.reviewed && state.reviewed.seriesId !== series._id)
    return refuse("Reviewed Series and proposed routing differ.");
  if (!state.source.series && !state.reviewed)
    return refuse("No source parent: supply exact product identity/contents review.");
  const routed = await reviewedRouting(ctx, state, series._id);
  if (state.source.series && state.source.series._id !== series._id && !routed)
    return refuse("Source parent points elsewhere; repair its link before changing the hold.");
  if (state.contents && state.reviewed) await reviewedMatch(ctx, state, [state.contents]);
  return series;
}

/** An explicitly reviewed member of a multi-Part ANN parent; never changes that parent. */
export async function reviewedRouting(
  ctx: QueryCtx,
  state: Awaited<ReturnType<typeof heldState>>,
  seriesId: Id<"series">,
) {
  if (state.episode) {
    if (state.reviewed?.seriesId !== seriesId) return refuse("Episode routing Series differs.");
    return state.episode;
  }
  if (state.reviewed?.collectionRouting) return collectionRouting(ctx, state, seriesId);
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

/** Decision-only guard. Placement/coverage is evaluated later by the normal held preview. */
export async function sourceFormatState(
  ctx: QueryCtx,
  observationId: Id<"sourceObservations">,
  reviewed: ReviewedFormat,
) {
  const r = reader(ctx);
  const resolutionCtx = guardedResolverContext(ctx, r);
  const observation = await r.read(observationId);
  if (!observation) return refuse("Missing source observation.");
  const refusal = reviewedFormatRefusal(observation, reviewed);
  if (refusal) return refuse(refusal);
  const effective = projectSourceFormat(observation);
  if (effective.status === "stale") return refuse(effective.reason);
  if (observation.reviewedSourceFormat) {
    const {
      proposalId: _proposalId,
      decidedAt: _decidedAt,
      invalidatedAt: _invalidatedAt,
      ...previous
    } = observation.reviewedSourceFormat;
    if (valueHash(previous) !== valueHash(reviewed))
      return refuse("A different reviewed Format decision already exists.");
  }
  const hold = await holdOf(ctx, observationId);
  r.facts.push(hold);
  const proposal = observation.queuedProposalId ? await r.read(observation.queuedProposalId) : null;
  const versions = proposal
    ? await r.many(
        ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) =>
            q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
          ),
      )
    : [];
  r.facts.push(proposal?.draft ?? null, versions);
  if (observation.withdrawn || observation.recordRef || !hold || proposal?.state === "inReview")
    return refuse("Correction requires a held, present, unlinked source outside any review.");
  const scope = await scopeState(ctx, reviewed.isbn13);
  const scopeSources = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "yenpress").eq("sourceRecordId", reviewed.isbn13),
      ),
  );
  r.facts.push(scope);
  const scoped = await isbnScope(ctx, reviewed.isbn13);
  if (scoped) return refuse(scoped);
  const snapshot = observation.snapshot as OlEditionSnapshot;
  if (snapshot.publishers.some((name) => REBINDER.test(name)))
    return refuse("Library rebinder metadata cannot establish the publisher's ebook.");
  await r.room();
  const work = await guardedBaseSeries(ctx, r, snapshot);
  r.facts.push(work, scopeSources);
  await r.room();
  if (work.candidates.length !== 1 || !hold.seriesId)
    return refuse("Independent source work or held Series is unresolved or ambiguous.");
  const series = await r.active(work.candidates[0]!._id);
  const heldSeries = await r.active(hold.seriesId);
  if (series._id !== heldSeries._id)
    return refuse("Independent source work disagrees with held Series.");
  const publishers = [];
  for (const name of snapshot.publishers) {
    await r.room();
    publishers.push({ name, publisher: await findPublisherByName(resolutionCtx, name) });
    await r.room();
  }
  r.facts.push(publishers);
  const publisherIds = new Set(
    publishers.flatMap((one) => (one.publisher ? [one.publisher._id] : [])),
  );
  if (publisherIds.size !== 1) return refuse("Source publisher is unresolved or ambiguous.");
  const publisher = await r.active([...publisherIds][0]!);
  const proposedSnapshot = reviewedSnapshot(snapshot, reviewed);
  // A store product's imprint places the book: it must be the legal publisher
  // or that publisher's own imprint row, never a name the parent's alias implies.
  if (reviewed.publisher.kind === "publisherOwnShopifySkuEbook") {
    const found = await findPublisherByName(resolutionCtx, reviewed.publisher.imprint);
    const imprint = found ? await r.active(found._id) : null;
    r.facts.push(imprint);
    if (!imprint || (imprint._id !== publisher._id && imprint.parentPublisherId !== publisher._id))
      return refuse("Reviewed imprint is not the source publisher or its known imprint.");
  }
  const claims = await isbnClaims(resolutionCtx, reviewed.isbn13, {
    resolver: claimResolver(resolutionCtx, { room: r.room }),
    room: r.room,
  });
  if (!claims?.complete || claims.unresolved.length)
    return refuse("ISBN claims incomplete or unresolved.");
  r.facts.push([...claims.owners.values()]);
  const expected = valueHash({ observationId, reviewed, proposedSnapshot, facts: r.facts });
  if (utf8Bytes(expected) > MAX_GUARD_BYTES) return refuse("Guard exceeds 256 KiB.");
  return { observation, hold, expected, proposedSnapshot, series, publisher, r };
}
