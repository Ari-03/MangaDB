// Source-agnostic apply machinery for import adapters (spec §6/§7):
// everything between a source's normalized snapshot and the canonical
// catalog that is not source-specific, so every adapter runs the same
// pipeline:
//
// - partial-date normalization with the yyyymmdd sort key (spec §8)
// - the series half of matching rung ① (source-keyed series observations,
//   rename-as-field-conflict reconciliation)
// - rung ①'s ISBN ownership check: a linked Release never takes the facts
//   a snapshot offers under another Release's ISBN
// - queue dedup: one open queue item per observation; a rejected one never
//   re-queues until the snapshot changes
// - publisher resolution: canonical names and duplicate aliases, imprints
//   as rows of their own, merged rows followed to their survivor
// - the creation path: publisher/series/volume/edition-line/edition/release
//   inserts (and box sets as Release Bundles) with the system-authored,
//   immediately approved Proposal and one public importer-authored Revision
//   per created record, citing the source. Volume Position is the volume
//   number; packaging covers the base Series' real Volumes, never its own
// - rung ① for box sets: a linked Release Bundle picks up the members whose
//   Releases arrived after it, on unchanged snapshots too
// - the steady-state review queue: an In-Review Proposal pre-filled with
//   the parsed guess (temp-ID create ops the approval registry applies)
// - repairs stand: series links and same-label Volumes follow merges to
//   their survivors, and the creation path never recreates a Series an
//   Editor hid (removedSeriesFor) — the record stays on its observation
//
// `release` is optional on both paths: a series-structured source (ANN)
// creates or queues the Series/Volume backbone without any Release.

import type { FunctionReference } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { getSourceByKey } from "../importSources";
import { authorityRank } from "./authority";
import { canonicalLabel } from "./bookTitle";
import { partialDateSort, type DateParts } from "./dates";
import { coverageOf, coveringOf, releasesOf } from "./editionRows";
import { errorMessage } from "./http";
import { hiddenSeriesTitled, isWholeSingleVolume, labelsEqual, survivorOf } from "./matching";
import { followMerges, mergeSurvivor } from "./merges";
import {
  clearHold,
  getObservation,
  linkObservation,
  recordUnplaced,
  upsertObservation,
} from "./observations";
import { applyRetrying } from "./occ";
import { allocatePublicId } from "./publicIds";
import {
  canonicalPublisherBySlug,
  canonicalPublisherFor,
  publisherNameKey,
  type CanonicalPublisher,
} from "./publishers";
import { insertSourceProposal, reconcileFields } from "./reconcile";
import { seriesSearchText } from "./searchMatch";

// ---------- dates & labels ----------

export type PartialDate = DateParts & { sort: number };

/** Partial-precision date with its yyyymmdd sort key, zeroed unknown parts (spec §8). */
export function toPartialDate(date: DateParts): PartialDate {
  return { ...date, sort: partialDateSort(date) };
}

// A release that implies an Edition Line — deluxe, omnibus, n-in-1, box-set
// packaging — always reviews in steady state (spec §6 creation boundaries).
export const EDITION_LINE_HINT =
  /\b(omnibus|box(?:ed)? set|slipcase|deluxe|collector['’]?s|\d-in-1|vizbig|perfect edition|colossal edition|master['’]?s? edition|anniversary edition|complete (?:manga )?collection)\b/i;

export function needsEditionLine(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => text !== undefined && EDITION_LINE_HINT.test(text));
}

// ---------- queue dedup (spec §6) ----------

/** When the observation's CURRENT snapshot was stored (history is append-only). */
async function snapshotStoredAt(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
): Promise<number> {
  const lastSuperseded = await ctx.db
    .query("observationSnapshots")
    .withIndex("by_observation", (q) => q.eq("observationId", observation._id))
    .order("desc")
    .first();
  return lastSuperseded?.supersededAt ?? observation._creationTime;
}

/**
 * Queue dedup (spec §6): one open queue item per observation, and a
 * rejected one never re-queues until the snapshot changes. Approved or
 * withdrawn queue items never block.
 */
export async function alreadyHandled(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
): Promise<boolean> {
  if (!observation.queuedProposalId) return false;
  const proposal = await ctx.db.get(observation.queuedProposalId);
  if (!proposal) return false;
  if (proposal.state === "inReview") return true;
  if (proposal.state === "rejected") {
    return (await snapshotStoredAt(ctx, observation)) <= (proposal.decidedAt ?? 0);
  }
  return false;
}

// ---------- publishers ----------

/** The row a slug means today: current slug, rename redirect, then merges. */
export async function publisherBySlug(
  ctx: MutationCtx,
  slug: string,
): Promise<Doc<"publishers"> | null> {
  const canonicalSlug = canonicalPublisherBySlug(slug)?.slug ?? slug;
  let doc = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", canonicalSlug))
    .unique();
  if (!doc) {
    const redirect = await ctx.db
      .query("publisherSlugRedirects")
      .withIndex("by_fromSlug", (q) => q.eq("fromSlug", canonicalSlug))
      .unique();
    doc = redirect ? await ctx.db.get(redirect.publisherId) : null;
  }
  return await mergeSurvivor(ctx, "publishers", doc);
}

/**
 * Find-or-create a publisher row by slug. A duplicate slug ("kodansha-comics")
 * resolves to its company first, and an existing row is followed through
 * rename redirects and merges to the survivor — a merged row never collects
 * new Editions. A new imprint row records its parent when the parent exists,
 * and a new adult-only one its content rating.
 */
export async function ensurePublisher(
  ctx: MutationCtx,
  publisher: { name: string; slug: string; parentSlug?: string },
): Promise<{ id: Id<"publishers">; slug: string; created: boolean }> {
  const canonical = canonicalPublisherBySlug(publisher.slug);
  const wanted: CanonicalPublisher = canonical ?? publisher;
  const existing = await publisherBySlug(ctx, wanted.slug);
  if (existing) return { id: existing._id, slug: existing.slug, created: false };
  const parent =
    wanted.parentSlug !== undefined ? await publisherBySlug(ctx, wanted.parentSlug) : null;
  const id = await ctx.db.insert("publishers", {
    status: "active",
    name: wanted.name,
    slug: wanted.slug,
    ...(parent ? { parentPublisherId: parent._id } : {}),
    // An adult-only publisher is born marked (lib/mature.ts).
    ...(wanted.adultOnly ? { contentRating: "mature" as const } : {}),
  });
  return { id, slug: wanted.slug, created: true };
}

/**
 * Resolve a source's publisher NAME against existing publisher rows only —
 * never creating one. In order: the canonical list (a company's own name or
 * a duplicate alias like "Kodansha Comics"; an imprint like "Ghost Ship"
 * resolves to its own row), an exact normalized name, then the longest
 * normalized-prefix match, tolerating corporate suffixes ("VIZ Media LLC" ↔
 * "VIZ Media"). Merged rows count as their survivor. How OpenLibrary, PRH,
 * and ANN resolve publishers: null means the source cannot establish the
 * publisher key.
 */
export async function findPublisherByName(
  ctx: MutationCtx,
  name: string,
): Promise<Doc<"publishers"> | null> {
  const wanted = publisherNameKey(name);
  if (wanted === "") return null;

  const canonical = canonicalPublisherFor(name);
  if (canonical) {
    const row = await publisherBySlug(ctx, canonical.slug);
    if (row && row.status === "active") return row;
  }

  // Every row's name, answered by its surviving company row.
  const rows: Array<{ doc: Doc<"publishers">; key: string }> = [];
  for (const pub of await ctx.db.query("publishers").collect()) {
    const survivor = await followMerges(ctx, "publishers", pub);
    if (survivor) {
      rows.push({ doc: survivor, key: publisherNameKey(pub.name) });
    }
  }
  const unique = (hits: typeof rows) => {
    const ids = new Set(hits.map((hit) => hit.doc._id));
    return ids.size === 1 ? hits[0]!.doc : null;
  };

  const exact = rows.filter((row) => row.key === wanted);
  if (exact.length > 0) return unique(exact);

  // "VIZ Media LLC" starts with "viz media": the longest such name wins,
  // so "Kodansha Comics USA" prefers a "Kodansha Comics" row over "Kodansha".
  const prefixes = rows.filter((row) => wanted.startsWith(`${row.key} `));
  if (prefixes.length > 0) {
    const longest = Math.max(...prefixes.map((row) => row.key.length));
    return unique(prefixes.filter((row) => row.key.length === longest));
  }
  // A truncated source string ("Seven Seas" for "Seven Seas Entertainment").
  return unique(rows.filter((row) => row.key.startsWith(`${wanted} `)));
}

// ---------- the series half of rung ① ----------

/**
 * The synthetic series-link snapshot: the source's series title, page, and
 * blurb, plus its age rating where the source rates series (Kodansha:
 * kodansha.ts recordListingRatings; read by lib/mature.ts).
 */
type SeriesLinkSnapshot = {
  kind: "series";
  title: string;
  url?: string;
  synopsis?: string;
  mature?: boolean;
};

/**
 * Upsert the synthetic series-link observation (`series:{key}`) and point it
 * at the canonical Series if not linked yet. The key is the source's own
 * series identity (its slug or record id), making a later series rename a
 * rung-① field conflict instead of a failed match. A feed without series
 * text (Kodansha's calendar) keeps the synopsis another feed stored, and
 * the stored age rating always stays.
 */
export async function linkSeriesObservation(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    seriesKey: string;
    title: string;
    url?: string;
    synopsis?: string;
    seriesId: Id<"series">;
    now: number;
  },
): Promise<Id<"sourceObservations">> {
  const sourceRecordId = `series:${args.seriesKey}`;
  const stored = (await getObservation(ctx, args.sourceKey, sourceRecordId))?.snapshot as
    | SeriesLinkSnapshot
    | undefined;
  const synopsis = args.synopsis ?? stored?.synopsis;
  const { observation } = await upsertObservation(ctx, {
    sourceKey: args.sourceKey,
    sourceRecordId,
    snapshot: {
      kind: "series",
      title: args.title,
      url: args.url,
      ...(synopsis !== undefined ? { synopsis } : {}),
      ...(stored?.mature !== undefined ? { mature: stored.mature } : {}),
    },
    now: args.now,
  });
  if (!observation.recordRef) {
    await linkObservation(ctx, observation._id, { type: "series", id: args.seriesId });
  }
  return observation._id;
}

/**
 * A source's series link (`series:{key}`) and the active Series it names,
 * a merged one answered by its survivor; null without one.
 */
async function linkedSeries(
  ctx: MutationCtx,
  sourceKey: string,
  seriesKey: string,
): Promise<{ link: Doc<"sourceObservations">; series: Doc<"series"> } | null> {
  const link = await getObservation(ctx, sourceKey, `series:${seriesKey}`);
  if (link?.recordRef?.type !== "series") return null;
  const series = await survivorOf<"series">(ctx, await ctx.db.get(link.recordRef.id));
  return series?.status === "active" ? { link, series } : null;
}

/**
 * The linked Series' id: the read-only half of `reconcileLinkedSeries`, for
 * callers that only place a record.
 */
export async function linkedSeriesId(
  ctx: MutationCtx,
  sourceKey: string,
  seriesKey: string,
): Promise<Id<"series"> | null> {
  return (await linkedSeries(ctx, sourceKey, seriesKey))?.series._id ?? null;
}

/**
 * Reconcile the linked Series' title — and its synopsis, when the source
 * offers one — with the source's current values: a series rename at the
 * source is a field conflict routed through the same authority rules as any
 * other field (spec §6 rung ①, never a failed match). An offered synopsis
 * is also stored on the series observation. Returns the linked series, if
 * any, for the creation boundaries.
 */
export async function reconcileLinkedSeries(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    seriesKey: string;
    offeredTitle: string;
    offeredSynopsis?: string;
    citation: { sourceName: string; url: string };
    now: number;
  },
): Promise<{ seriesId: Id<"series"> | null; changed: boolean }> {
  const linked = await linkedSeries(ctx, args.sourceKey, args.seriesKey);
  if (linked === null) return { seriesId: null, changed: false };
  const { series } = linked;
  let seriesObs = linked.link;
  // A repair merged the linked Series: the link follows it to the survivor.
  if (series._id !== seriesObs.recordRef?.id) {
    await linkObservation(ctx, seriesObs._id, { type: "series", id: series._id });
  }
  const snapshot = seriesObs.snapshot as SeriesLinkSnapshot;
  if (args.offeredSynopsis !== undefined && snapshot.synopsis !== args.offeredSynopsis) {
    ({ observation: seriesObs } = await upsertObservation(ctx, {
      sourceKey: args.sourceKey,
      sourceRecordId: seriesObs.sourceRecordId,
      snapshot: { ...snapshot, synopsis: args.offeredSynopsis },
      now: args.now,
    }));
  }
  if (series.locked) return { seriesId: series._id, changed: false };
  const result = await reconcileFields(ctx, {
    sourceKey: args.sourceKey,
    ref: { type: "series", id: series._id },
    doc: series,
    offered: {
      title: args.offeredTitle,
      ...(args.offeredSynopsis !== undefined ? { synopsis: args.offeredSynopsis } : {}),
    },
    observation: seriesObs,
    citation: args.citation,
    now: args.now,
  });
  return { seriesId: series._id, changed: result.changed };
}

// ---------- creation boundaries (spec §6/§7) ----------

/**
 * The steady-state always-review gates for one creation-shaped fact.
 * Bootstrap Mode lifts them (spec §7); ambiguity never goes through here —
 * the matching ladder already queued it.
 */
export function creationGates(args: {
  seriesId: Id<"series"> | null;
  multiVolume: boolean;
  editionLineHint: boolean;
}): string[] {
  return [
    ...(args.seriesId === null ? ["a brand-new Series"] : []),
    ...(args.multiVolume ? ["multi-Volume Coverage"] : []),
    ...(args.editionLineHint ? ["an Edition Line (deluxe/omnibus/box-set packaging)"] : []),
  ];
}

// ---------- removed Series (repairs the importers respect) ----------

/** What a brand-new Series for a record would recreate (removedSeriesFor). */
export type RemovedSeries =
  | { kind: "merged"; survivor: Doc<"series"> }
  | { kind: "hidden"; series: Doc<"series">; reason: string };

/** A publisher row and its parent: an imprint and its company are one house. */
async function publisherHouse(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
): Promise<Id<"publishers">[]> {
  const row = await ctx.db.get(publisherId);
  return row?.parentPublisherId !== undefined ? [row._id, row.parentPublisherId] : [publisherId];
}

/**
 * Every Edition (any status) covering one of the Series' Volumes, once per
 * coverage: an Edition covering several Volumes repeats.
 */
export async function seriesEditions(
  ctx: MutationCtx,
  seriesId: Id<"series">,
): Promise<Doc<"editions">[]> {
  const editions: Doc<"editions">[] = [];
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  for (const volume of volumes) {
    const coverages = await coveringOf(ctx, volume._id);
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (edition) editions.push(edition);
    }
  }
  return editions;
}

/** Every publisher house the Series' Editions (any status) were published by. */
async function seriesPublishers(
  ctx: MutationCtx,
  seriesId: Id<"series">,
): Promise<Set<Id<"publishers">>> {
  const houses = new Set<Id<"publishers">>();
  for (const edition of await seriesEditions(ctx, seriesId)) {
    for (const id of await publisherHouse(ctx, edition.publisherId)) houses.add(id);
  }
  return houses;
}

/**
 * The repair a brand-new Series for this record would undo, or null when
 * creating one is fine. In order:
 *
 * 1. The record's own Series link — the observation's `recordRef` (ANN's
 *    manga entry) or the source's `series:{key}` link observation —
 *    pointing at a merged Series (→ its survivor) or a hidden one.
 * 2. A hidden Series with the same normalized title, unless both sides
 *    name publishers and they differ: a namesake from another house (a
 *    manga "Ring" against Vertical's hidden prose "Ring") is a new work.
 *
 * Merged-by-title never reaches here: candidateSeries already answers a
 * merged Series' title with its survivor.
 */
export async function removedSeriesFor(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    observation: Doc<"sourceObservations">;
    seriesKey?: string;
    seriesTitle: string;
    /** The incoming record's publisher, when the source names one. */
    publisherId: Id<"publishers"> | null;
  },
): Promise<RemovedSeries | null> {
  const linkObs =
    args.observation.recordRef?.type === "series"
      ? args.observation
      : args.seriesKey !== undefined
        ? await getObservation(ctx, args.sourceKey, `series:${args.seriesKey}`)
        : null;
  if (linkObs?.recordRef?.type === "series") {
    const linked = await survivorOf<"series">(ctx, await ctx.db.get(linkObs.recordRef.id));
    if (linked?.status === "hidden") return hiddenWork(args.seriesTitle, linked);
    if (linked?.status === "active" && linked._id !== linkObs.recordRef.id) {
      return { kind: "merged", survivor: linked };
    }
  }
  return await hiddenWorkTitled(ctx, args.seriesTitle, args.publisherId);
}

type HiddenWork = Extract<RemovedSeries, { kind: "hidden" }>;

function hiddenWork(seriesTitle: string, series: Doc<"series">): HiddenWork {
  return {
    kind: "hidden",
    series,
    reason: `"${seriesTitle}" is Series ${series.publicId} ("${series.title}"), which an Editor hid — not recreated by an import.`,
  };
}

/**
 * The hidden Series a title names (step 2 of removedSeriesFor), or null:
 * one with the same normalized title, unless both sides name publishers
 * and they differ. Open Library, which never creates a Series, asks it to
 * hold such a book.
 */
export async function hiddenWorkTitled(
  ctx: MutationCtx,
  seriesTitle: string,
  publisherId: Id<"publishers"> | null,
): Promise<HiddenWork | null> {
  const incoming = publisherId !== null ? new Set(await publisherHouse(ctx, publisherId)) : null;
  for (const series of await hiddenSeriesTitled(ctx, seriesTitle)) {
    if (incoming !== null) {
      const houses = await seriesPublishers(ctx, series._id);
      if (houses.size > 0 && ![...houses].some((id) => incoming.has(id))) continue;
    }
    return hiddenWork(seriesTitle, series);
  }
  return null;
}

// ---------- ISBN ownership at rung ① ----------

// Holders read per ISBN; a healthy catalog has one, a duplicate awaiting a
// merge two.
const ISBN_HOLDERS_SCAN = 10;

/**
 * The canonical Release other than `release` that holds `isbn13`: active or
 * hidden, a merged holder answered by its survivor. Null when `release`
 * holds it itself or nobody does.
 */
export async function isbnHolderBesides(
  ctx: MutationCtx,
  release: Doc<"releases">,
  isbn13: string,
): Promise<Doc<"releases"> | null> {
  if (release.isbn13 === isbn13) return null;
  const holders = await ctx.db
    .query("releases")
    .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
    .take(ISBN_HOLDERS_SCAN);
  for (const holder of holders) {
    const owner = await survivorOf<"releases">(ctx, holder);
    if (owner !== null && owner._id !== release._id) return owner;
  }
  return null;
}

/** Record (or replace) the observation's ISBN conflict for an Editor. */
export async function recordIsbnConflict(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  isbn13: string,
  reason: string,
  now: number,
): Promise<void> {
  // Stored, not the caller's copy: a link earlier in this mutation may have
  // cleared its placement note.
  const stored = (await ctx.db.get(observation._id))?.conflicts ?? [];
  const kept = stored.filter((c) => c.field !== "isbn13");
  await ctx.db.patch(observation._id, {
    conflicts: [...kept, { field: "isbn13", offered: isbn13, at: now, reason }],
  });
}

/**
 * Rung ①'s ownership check, before any field is reconciled: an ISBN-13
 * names one Release (CONTEXT.md), so a snapshot offering an ISBN another
 * Release holds is that book's facts, not the linked Release's (a calendar
 * duplicate awaiting a merge, or a record an old crawl rewrote with another
 * Binding). The pair is recorded on the observation for an Editor and the
 * caller applies nothing; returns whether it did.
 */
export async function isbnHeldElsewhere(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  release: Doc<"releases">,
  isbn13: string | undefined,
  now: number,
): Promise<boolean> {
  if (isbn13 === undefined) return false;
  const holder = await isbnHolderBesides(ctx, release, isbn13);
  if (holder === null) return false;
  await recordIsbnConflict(
    ctx,
    observation,
    isbn13,
    `ISBN ${isbn13} is already on Release ${holder._id}, not on the Release this record links (${release._id}); none of its facts are applied until an Editor resolves which book it is (a duplicate to merge, or another book).`,
    now,
  );
  return true;
}

// ---------- the creation path ----------

/**
 * The one language every import adapter covers (English-only scope, spec
 * §1): the language of the Releases they create, and the known language
 * they offer the matching ladder.
 */
export const IMPORT_LANGUAGE = "en";

/** The Release-level facts a source offers at creation. */
export type ReleasePayload = {
  format: "physical" | "digital";
  binding?: string;
  isbn13?: string;
  isbn10?: string;
  pubDate?: PartialDate;
  price?: { amountCents: number; currency: string };
  /** The publisher's blurb for this book (a Release Description). */
  description?: string;
};

/**
 * An active, unlocked Release with no description and no human override of
 * it: one an adapter may refetch a source page for, to fill the blank (Seven
 * Seas' detail pages, ANN's release pages). A human's cleared description is
 * theirs to keep.
 */
export function blurbWanted(release: Doc<"releases">): boolean {
  return (
    release.status === "active" &&
    !release.locked &&
    release.description === undefined &&
    !release.overriddenFields?.includes("description")
  );
}

/**
 * Whether `sourceKey`'s blurb would replace this Release's description:
 * it has none (`blurbWanted`), or its text was last written by a source
 * ranking below `sourceKey` for descriptions — an aggregator (ANN, Open
 * Library) filled the blank before the publisher's own page was re-read.
 * A human's text, a Human Override, unattributed text and a locked Release
 * are never wanted. How a first-party adapter that only re-reads pages for
 * a missing blurb (Seven Seas) still replaces aggregator copy.
 */
export async function blurbOutranked(
  ctx: MutationCtx,
  release: Doc<"releases">,
  sourceKey: string,
): Promise<boolean> {
  if (blurbWanted(release)) return true;
  if (
    release.status !== "active" ||
    release.locked ||
    release.overriddenFields?.includes("description")
  ) {
    return false;
  }
  const revision = await lastDescriptionRevision(ctx, release._id);
  if (revision?.author.kind !== "source") return false;
  const [incoming, incumbent] = await Promise.all([
    getSourceByKey(ctx, sourceKey),
    getSourceByKey(ctx, revision.author.sourceKey),
  ]);
  return (
    authorityRank(incumbent?.fieldAuthority, "description") <
    authorityRank(incoming?.fieldAuthority, "description")
  );
}

/** The latest Revision that touched a Release's description, or null. */
async function lastDescriptionRevision(ctx: QueryCtx, releaseId: Id<"releases">) {
  const history = ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
    .order("desc");
  for await (const revision of history) {
    if (revision.changes.some((change) => change.field === "description")) return revision;
  }
  return null;
}

/**
 * The observations behind the Release's current description when
 * `sourceKey` wrote it: the evidence of the latest Revision touching the
 * field. Null when anyone else wrote it (another source, a human) or
 * nobody did.
 */
export async function descriptionEvidence(
  ctx: QueryCtx,
  release: Doc<"releases">,
  sourceKey: string,
): Promise<Id<"sourceObservations">[] | null> {
  const revision = await lastDescriptionRevision(ctx, release._id);
  if (revision?.author.kind !== "source" || revision.author.sourceKey !== sourceKey) return null;
  const proposal = await ctx.db.get(revision.proposalId);
  const version = proposal
    ? await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) =>
          q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
        )
        .unique()
    : null;
  return (version?.evidence ?? []).flatMap((row) =>
    row.kind === "observation" ? [row.observationId] : [],
  );
}

/**
 * Rewrite a Release description a source wrote, from the observation it
 * wrote it from: the source's own fact through reconcileFields (one
 * approved Proposal, its version, one Revision citing the source), with
 * `text` undefined clearing the field. Only while the Release is active or
 * hidden, unlocked, carries no Human Override on the field, its current
 * text differs, and `observation` is the evidence for that text — so a
 * publisher's, another source's, or a human's text is never touched.
 * How the ANN repair and refresh and the Open Library repair fix text
 * their own sources wrote.
 */
export async function rewriteOwnDescription(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    observation: Doc<"sourceObservations">;
    release: Doc<"releases">;
    text: string | undefined;
    citation: { sourceName: string; url: string };
    now: number;
  },
): Promise<"updated" | "cleared" | null> {
  const { release, text } = args;
  if (
    (release.status !== "active" && release.status !== "hidden") ||
    release.locked ||
    release.overriddenFields?.includes("description") ||
    typeof release.description !== "string" ||
    release.description === text
  ) {
    return null;
  }
  const evidence = await descriptionEvidence(ctx, release, args.sourceKey);
  if (evidence === null || !evidence.includes(args.observation._id)) return null;
  const result = await reconcileFields(ctx, {
    sourceKey: args.sourceKey,
    ref: { type: "release", id: release._id },
    doc: release,
    offered: { description: text },
    observation: args.observation,
    citation: args.citation,
    now: args.now,
  });
  if (!result.applied.includes("description")) return null;
  return text === undefined ? "cleared" : "updated";
}

// ---------- the description repair (ann.ts, openLibrary.ts) ----------

/** A source's description cleaner: the text to keep, or undefined when no blurb remains. */
type DescriptionCleaner = (text: string) => string | undefined;

/** Observations scanned per repair lookup. */
export const REPAIR_SCAN = 100;
/** Failed records whose message a repair link logs (the count is complete). */
const REPAIR_ERROR_SAMPLES = 20;

export const repairCountsValidator = v.object({
  scanned: v.number(),
  snapshotFixed: v.number(),
  releaseUpdated: v.number(),
  releaseCleared: v.number(),
  errors: v.number(),
});
type RepairCounts = Infer<typeof repairCountsValidator>;

/** What repairing one observation did. */
export type DescriptionRepair = { snapshotFixed: boolean; release: "updated" | "cleared" | null };

/** Text `clean` would change. A non-string is listed too, so its record fails loudly and is counted. */
function staleDescription(text: unknown, clean: DescriptionCleaner): boolean {
  return text !== undefined && (typeof text !== "string" || clean(text) !== text);
}

/**
 * The repair work in a scanned page of observations: those whose stored
 * description (`stored`) or linked Release's current text `clean` would
 * change, whoever wrote that text (the repair mutation decides). `next` is
 * null once the scan is exhausted.
 */
export async function descriptionRepairWork(
  ctx: QueryCtx,
  docs: Doc<"sourceObservations">[],
  stored: (doc: Doc<"sourceObservations">) => unknown,
  clean: DescriptionCleaner,
) {
  const ids: Id<"sourceObservations">[] = [];
  for (const doc of docs) {
    const release = doc.recordRef?.type === "release" ? await ctx.db.get(doc.recordRef.id) : null;
    if (staleDescription(stored(doc), clean) || staleDescription(release?.description, clean)) {
      ids.push(doc._id);
    }
  }
  const last = docs.at(-1);
  return {
    ids,
    scanned: docs.length,
    next: docs.length < REPAIR_SCAN || !last ? null : last.sourceRecordId,
  };
}

/**
 * A stored snapshot part with its description re-cleaned (dropped when
 * nothing remains), or null when it is already clean. Patched in place:
 * the same fetch re-read, so no history row.
 */
export function recleaned<T extends { description?: string }>(
  holder: T,
  clean: DescriptionCleaner,
): (Omit<T, "description"> & { description?: string }) | null {
  if (!staleDescription(holder.description, clean)) return null;
  const fixed = clean(holder.description!);
  const { description: _, ...rest } = holder;
  return fixed === undefined ? rest : { ...rest, description: fixed };
}

/**
 * Re-clean the text of the Release an observation links to when `clean`
 * would change it, through `rewriteOwnDescription` (only text the source
 * wrote from this observation; no lock, no Human Override), citing `url`
 * under the registry's name for the source (else `sourceName`).
 */
export async function repairLinkedDescription(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  args: { sourceKey: string; clean: DescriptionCleaner; sourceName: string; url: string },
): Promise<DescriptionRepair["release"]> {
  if (observation.recordRef?.type !== "release") return null;
  const release = await ctx.db.get(observation.recordRef.id);
  if (
    release === null ||
    typeof release.description !== "string" ||
    !staleDescription(release.description, args.clean)
  ) {
    return null;
  }
  const source = await getSourceByKey(ctx, args.sourceKey);
  return await rewriteOwnDescription(ctx, {
    sourceKey: args.sourceKey,
    observation,
    release,
    text: args.clean(release.description),
    citation: { sourceName: source?.name ?? args.sourceName, url: args.url },
    now: Date.now(),
  });
}

/**
 * The walk behind `ann:repairDescriptions` and `openLibrary:repairDescriptions`:
 * page through `candidates`, repair each observation with work in its own
 * mutation (`repair`), and hand the cursor and counts to a fresh action
 * (`self`) after `budgetMs`. A record that fails is counted and logged and
 * the walk goes on. Counts are logged at every hand-off and at the end,
 * since the CLI stops listening after a few minutes.
 */
export async function runDescriptionRepair(
  ctx: ActionCtx,
  args: { after?: string; counts?: RepairCounts },
  walk: {
    /** Log prefix and the noun for a failed record ("ann.repairDescriptions", "line"). */
    label: string;
    noun: string;
    budgetMs: number;
    candidates: FunctionReference<
      "query",
      "internal",
      { after: string | null },
      Awaited<ReturnType<typeof descriptionRepairWork>>
    >;
    repair: FunctionReference<
      "mutation",
      "internal",
      { observationId: Id<"sourceObservations"> },
      DescriptionRepair
    >;
    self: FunctionReference<"action", "internal", { after?: string; counts?: RepairCounts }>;
  },
): Promise<RepairCounts & { continued: boolean }> {
  const started = Date.now();
  const counts: RepairCounts = args.counts ?? {
    scanned: 0,
    snapshotFixed: 0,
    releaseUpdated: 0,
    releaseCleared: 0,
    errors: 0,
  };
  let logged = 0;
  let cursor: string | null = args.after ?? null;
  for (;;) {
    const batch = await ctx.runQuery(walk.candidates, { after: cursor });
    counts.scanned += batch.scanned;
    for (const observationId of batch.ids) {
      try {
        const done = await applyRetrying(ctx, walk.repair, { observationId });
        if (done.snapshotFixed) counts.snapshotFixed++;
        if (done.release === "updated") counts.releaseUpdated++;
        if (done.release === "cleared") counts.releaseCleared++;
      } catch (e) {
        counts.errors++;
        if (logged++ < REPAIR_ERROR_SAMPLES) {
          console.error(`[${walk.label}] ${walk.noun} ${observationId}: ${errorMessage(e)}`);
        }
      }
    }
    cursor = batch.next;
    if (cursor === null) {
      console.log(`[${walk.label}] done: ${JSON.stringify(counts)}`);
      return { ...counts, continued: false };
    }
    if (Date.now() - started > walk.budgetMs) {
      await ctx.scheduler.runAfter(0, walk.self, { after: cursor, counts });
      console.log(`[${walk.label}] continuing after ${cursor}: ${JSON.stringify(counts)}`);
      return { ...counts, continued: true };
    }
  }
}

type PublisherRef = { name: string; slug: string; parentSlug?: string };

export type CreationArgs = {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  citation: { sourceName: string; url: string };
  /** Comment on the system Proposal and every creation Revision. */
  importComment: string;
  seriesId: Id<"series"> | null;
  seriesTitle: string;
  seriesAltTitles?: string[];
  /** The source's series blurb, for a brand-new Series and its series link. */
  seriesSynopsis?: string;
  /** Source-side series identity for the rung-① series link. */
  seriesKey?: string;
  seriesUrl?: string;
  /**
   * Covered volume labels in order; [] = one unlabeled Volume (oneshot) —
   * unless `seriesOnly`, which creates the Series with no Volume at all.
   */
  labels: string[];
  /** Backbone creation whose source lists only packaged lines (ANN omnibus-only). */
  seriesOnly?: boolean;
  /**
   * The Edition Line a packaged Release belongs to ("Omnibus" 7), under the
   * base Series; its coverage is `labels` — the real Volumes it collects.
   */
  editionLine?: { name: string; position: string | null };
  /**
   * With `editionLine` and no `labels`: create the member as Unmapped
   * Packaging — an Edition with no coverage rows, flagged for a Moderator to
   * map — instead of refusing. Never creates a Volume.
   */
  coverageUnmapped?: true;
  /**
   * The Release to create, with its publisher. Absent for series-structured
   * backbone creation (ANN): only the Series and its Volumes are created.
   */
  release?: ReleasePayload & { publisher: PublisherRef };
  /** Tag records steady state would have queued (spec §7 Bootstrap Mode). */
  tagBootstrapUnreviewed: boolean;
  now: number;
};

type CreatedRecord = {
  ref: {
    type:
      | "publisher"
      | "series"
      | "volume"
      | "editionLine"
      | "edition"
      | "release"
      | "releaseBundle";
    id: string;
  };
  table: string;
  fields: Record<string, unknown>;
};

export type CreationResult = {
  /** The Series the records went under — the hidden one when `blocked`. */
  seriesId: Id<"series">;
  volumeIds: Id<"volumes">[];
  releaseId?: Id<"releases">;
  /** False when everything already existed and nothing was written. */
  changed: boolean;
  /**
   * Set when the record belongs to a Series an Editor hid: nothing was
   * created and the reason sits on the observation as a placement note.
   */
  blocked?: string;
};

/**
 * Volume Position for a new Volume (spec §2): the volume number itself when
 * the label is a number ("0", "7", "7.5" alike), so a gap in the sequence is
 * a missing Volume. Unnumbered Volumes — and a number whose slot is somehow
 * taken — sort just after the last whole number, between it and the next,
 * so they never push a later numbered Volume off its number.
 */
export function volumePositionFor(
  label: string | null | undefined,
  taken: ReadonlySet<number>,
): number {
  const numeric =
    label !== null && label !== undefined && /^\d+(?:\.\d+)?$/.test(label.trim())
      ? Number(label)
      : NaN;
  if (Number.isFinite(numeric) && !taken.has(numeric)) return numeric;
  if (!Number.isFinite(numeric) && taken.size === 0) return 1;
  const base = Number.isFinite(numeric) ? numeric : Math.floor(Math.max(0, ...taken));
  for (let k = 1; k <= 40; k++) {
    const candidate = base + 1 - 2 ** -k;
    if (!taken.has(candidate)) return candidate;
  }
  return Math.max(0, ...taken) + 1;
}

/**
 * Ensure Volumes for every label under the series, reusing by label equality
 * (a second packaging of the same content must not duplicate the Volume).
 * Labels are stored canonically ("05" → "5"); positions follow
 * volumePositionFor; Volumes created earlier in this call count too.
 *
 * Repairs stand: a same-label Volume a repair merged answers as its
 * survivor under this Series. For `backboneOnly` calls (no Release to
 * cover it — ANN's Volume backbone) a same-label Volume that was hidden or
 * merged away is never recreated; the label is skipped.
 */
async function ensureVolumes(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  labels: Array<string | undefined>,
  tag: { bootstrapUnreviewed?: boolean },
  created: CreatedRecord[],
  backboneOnly: boolean,
): Promise<Id<"volumes">[]> {
  const existingVolumes: Array<
    Pick<Doc<"volumes">, "_id" | "status" | "label" | "position" | "mergedIntoId">
  > = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const taken = new Set(existingVolumes.map((vol) => vol.position));
  const volumeIds: Id<"volumes">[] = [];
  for (const raw of labels) {
    const label = raw !== undefined ? canonicalLabel(raw) : undefined;
    const sameLabel = existingVolumes.filter((vol) => labelsEqual(vol.label, label ?? null));
    const existing = sameLabel.find((vol) => vol.status === "active");
    if (existing) {
      volumeIds.push(existing._id);
      continue;
    }
    const merged = sameLabel.find((vol) => vol.mergedIntoId !== undefined);
    const survivor =
      merged?.mergedIntoId !== undefined
        ? await survivorOf<"volumes">(ctx, await ctx.db.get(merged.mergedIntoId))
        : null;
    if (survivor?.status === "active" && survivor.seriesId === seriesId) {
      volumeIds.push(survivor._id);
      continue;
    }
    if (backboneOnly && sameLabel.length > 0) continue;
    const position = volumePositionFor(label, taken);
    taken.add(position);
    const publicId = await allocatePublicId(ctx, "volume");
    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      ...tag,
      publicId,
      seriesId,
      position,
      label,
    });
    existingVolumes.push({ _id: volumeId, status: "active", label, position });
    volumeIds.push(volumeId);
    created.push({
      ref: { type: "volume", id: volumeId },
      table: "volumes",
      fields: { label: label ?? undefined, position },
    });
  }
  return volumeIds;
}

/** Whether a Release may be filed under this Edition: active and unlocked. */
export const joinableEdition = (edition: Doc<"editions">) =>
  edition.status === "active" && !edition.locked;

/**
 * Every Edition, in any state, by this publisher covering exactly these
 * volumes (complete, in order) in the same Edition Line at the same
 * position — or outside any line when the new Release has none.
 */
export async function siblingEditions(
  ctx: QueryCtx,
  publisherId: Id<"publishers">,
  volumeIds: Id<"volumes">[],
  line: { id: Id<"editionLines">; position: string | null } | null,
): Promise<Doc<"editions">[]> {
  if (volumeIds.length === 0) return [];
  const siblings = [];
  for (const coverage of await coveringOf(ctx, volumeIds[0]!)) {
    const edition = await ctx.db.get(coverage.editionId);
    if (!edition || edition.publisherId !== publisherId) continue;
    if ((edition.editionLineId ?? null) !== (line?.id ?? null)) continue;
    if (line !== null && (edition.linePosition ?? null) !== line.position) continue;
    const rows = await coverageOf(ctx, edition._id);
    if (rows.length !== volumeIds.length) continue;
    const matches = rows
      .sort((a, b) => a.order - b.order)
      .every((row, i) => row.volumeId === volumeIds[i] && row.extent === "complete");
    if (matches) siblings.push(edition);
  }
  return siblings;
}

/**
 * The active, unlocked one of those siblings (siblingEditions): the
 * Edition a same-packaging Release in another Format/Binding belongs to
 * (spec §2: an Edition is realized by Releases differing only there); an
 * omnibus never joins a single volume's Edition, or vice versa. A placement
 * Proposal's Edition joins it too (lib/proposalCreates.ts).
 */
export async function findSiblingEdition(
  ctx: QueryCtx,
  publisherId: Id<"publishers">,
  volumeIds: Id<"volumes">[],
  line: { id: Id<"editionLines">; position: string | null } | null,
): Promise<Id<"editions"> | null> {
  return (
    (await siblingEditions(ctx, publisherId, volumeIds, line)).find(joinableEdition)?._id ?? null
  );
}

/**
 * The line's members, in any state, from this publisher at this position
 * that are Unmapped Packaging: the siblings of an Unmapped Packaging
 * Release (print and digital of "Deluxe 14" share one Edition). Coverage
 * cannot tell them apart yet, so the position does.
 */
export async function unmappedSiblings(
  ctx: QueryCtx,
  publisherId: Id<"publishers">,
  line: { id: Id<"editionLines">; position: string | null },
): Promise<Doc<"editions">[]> {
  const members = await ctx.db
    .query("editions")
    .withIndex("by_line", (q) => q.eq("editionLineId", line.id))
    .collect();
  return members.filter(
    (edition) =>
      edition.publisherId === publisherId &&
      edition.coverageUnmapped === true &&
      (edition.linePosition ?? null) === line.position,
  );
}

/**
 * The active, unlocked one of those (unmappedSiblings). A placement
 * Proposal's unmapped Edition joins it too (lib/proposalCreates.ts).
 */
export async function findUnmappedSibling(
  ctx: QueryCtx,
  publisherId: Id<"publishers">,
  line: { id: Id<"editionLines">; position: string | null },
): Promise<Id<"editions"> | null> {
  return (await unmappedSiblings(ctx, publisherId, line)).find(joinableEdition)?._id ?? null;
}

/** The Series' active Edition Line of this name (any case) for one publisher. */
async function activeEditionLine(
  ctx: MutationCtx,
  args: { seriesId: Id<"series">; publisherId: Id<"publishers">; name: string },
): Promise<Doc<"editionLines"> | undefined> {
  const lines = await ctx.db
    .query("editionLines")
    .withIndex("by_series", (q) => q.eq("seriesId", args.seriesId))
    .collect();
  const wanted = args.name.toLowerCase();
  return lines.find(
    (line) =>
      line.status === "active" &&
      line.publisherId === args.publisherId &&
      line.name.toLowerCase() === wanted,
  );
}

/** Find-or-create the base Series' Edition Line for one publisher (spec §2). */
async function ensureEditionLine(
  ctx: MutationCtx,
  args: {
    seriesId: Id<"series">;
    publisherId: Id<"publishers">;
    name: string;
    tag: { bootstrapUnreviewed?: boolean };
  },
  created: CreatedRecord[],
): Promise<Id<"editionLines">> {
  const existing = await activeEditionLine(ctx, args);
  if (existing) return existing._id;
  const id = await ctx.db.insert("editionLines", {
    status: "active",
    ...args.tag,
    seriesId: args.seriesId,
    publisherId: args.publisherId,
    name: args.name,
  });
  created.push({
    ref: { type: "editionLine", id },
    table: "editionLines",
    fields: { name: args.name },
  });
  return id;
}

/**
 * Record what a creation inserted as one system-authored, immediately
 * approved Proposal (spec §5: imports author Proposals too) with one public
 * Revision per created record, citing the source name + record URL (spec §6
 * attribution). The evidence names every observation the facts came from.
 */
async function recordCreation(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    evidence: Id<"sourceObservations">[];
    citation: { sourceName: string; url: string };
    comment: string;
    now: number;
  },
  created: CreatedRecord[],
): Promise<void> {
  if (created.length === 0) return;
  await insertSourceProposal(ctx, {
    ...args,
    state: "approved",
    ops: created.map((record) => ({
      kind: "create" as const,
      table: record.table,
      tempId: record.ref.type === "volume" ? record.ref.id : record.ref.type,
      fields: record.fields,
    })),
    revisions: created.map((record) => ({
      ref: record.ref as never,
      seq: 1,
      changes: Object.entries(record.fields)
        .filter(([, value]) => value !== undefined)
        .map(([field, after]) => ({ field, after })),
    })),
  });
}

/**
 * The rung-⑤ creation path: insert whatever does not exist yet (publisher,
 * Series, Volumes, Edition Line, Edition, Release), then record it as one
 * system Proposal with its Revisions (recordCreation). One call = one
 * atomic mutation slice. A packaged Release (`editionLine`) must name the
 * real Volumes it covers — it never becomes a Volume of its own.
 */
export async function createCanonicalRecords(
  ctx: MutationCtx,
  args: CreationArgs,
): Promise<CreationResult> {
  const { now } = args;
  const tag = args.tagBootstrapUnreviewed ? { bootstrapUnreviewed: true } : {};
  const created: CreatedRecord[] = [];
  const evidence: Id<"sourceObservations">[] = [args.observation._id];

  const unmapped = args.editionLine !== undefined && args.labels.length === 0;
  if (unmapped && args.coverageUnmapped !== true) {
    throw new Error(
      "An Edition Line member needs its covered Volumes; packaging never becomes a Volume.",
    );
  }

  let seriesId = args.seriesId;
  if (seriesId === null) {
    // Never undo a repair: a merged Series' records go to its survivor, and
    // a hidden work is not brought back as a fresh Series.
    const publisher =
      args.release !== undefined ? await publisherBySlug(ctx, args.release.publisher.slug) : null;
    const removed = await removedSeriesFor(ctx, {
      sourceKey: args.sourceKey,
      observation: args.observation,
      seriesKey: args.seriesKey,
      seriesTitle: args.seriesTitle,
      publisherId: publisher?._id ?? null,
    });
    if (removed?.kind === "hidden") {
      await recordUnplaced(ctx, args.observation, { kind: "series", reason: removed.reason }, now);
      return {
        seriesId: removed.series._id,
        volumeIds: [],
        changed: false,
        blocked: removed.reason,
      };
    }
    if (removed?.kind === "merged") seriesId = removed.survivor._id;
  }
  if (seriesId === null) {
    const publicId = await allocatePublicId(ctx, "series");
    const altTitles = args.seriesAltTitles ?? [];
    const fields = { title: args.seriesTitle, altTitles, synopsis: args.seriesSynopsis };
    seriesId = await ctx.db.insert("series", {
      status: "active",
      ...tag,
      publicId,
      ...fields,
      searchText: seriesSearchText(args.seriesTitle, altTitles),
    });
    created.push({
      ref: { type: "series", id: seriesId },
      table: "series",
      fields,
    });
    if (args.seriesKey !== undefined) {
      evidence.push(
        await linkSeriesObservation(ctx, {
          sourceKey: args.sourceKey,
          seriesKey: args.seriesKey,
          title: args.seriesTitle,
          url: args.seriesUrl,
          synopsis: args.seriesSynopsis,
          seriesId,
          now,
        }),
      );
    }
  }

  // Unmapped packaging covers nothing yet; it must not become an unlabeled Volume.
  const volumeLabels: Array<string | undefined> =
    args.labels.length > 0 ? args.labels : args.seriesOnly || unmapped ? [] : [undefined];
  const volumeIds = await ensureVolumes(
    ctx,
    seriesId,
    volumeLabels,
    tag,
    created,
    args.release === undefined,
  );

  let releaseId: Id<"releases"> | undefined;
  if (args.release !== undefined) {
    const publisher = await ensurePublisher(ctx, args.release.publisher);
    if (publisher.created) {
      created.push({
        ref: { type: "publisher", id: publisher.id },
        table: "publishers",
        fields: { name: args.release.publisher.name, slug: publisher.slug },
      });
    }

    const line =
      args.editionLine !== undefined
        ? {
            id: await ensureEditionLine(
              ctx,
              {
                seriesId,
                publisherId: publisher.id,
                name: args.editionLine.name,
                tag,
              },
              created,
            ),
            position: args.editionLine.position,
          }
        : null;

    let editionId =
      unmapped && line
        ? await findUnmappedSibling(ctx, publisher.id, line)
        : await findSiblingEdition(ctx, publisher.id, volumeIds, line);
    if (editionId === null) {
      const editionPublicId = await allocatePublicId(ctx, "edition");
      editionId = await ctx.db.insert("editions", {
        status: "active",
        ...tag,
        publicId: editionPublicId,
        publisherId: publisher.id,
        ...(line ? { editionLineId: line.id, linePosition: line.position ?? undefined } : {}),
        ...(unmapped ? { coverageUnmapped: true as const } : {}),
      });
      for (const [i, volumeId] of volumeIds.entries()) {
        await ctx.db.insert("volumeCoverages", {
          editionId,
          volumeId,
          order: i + 1,
          extent: "complete",
        });
      }
      created.push({
        ref: { type: "edition", id: editionId },
        table: "editions",
        fields: {
          linePosition: line?.position ?? undefined,
          volumeCoverage: volumeIds.map((id, i) => ({
            volumeId: id,
            order: i + 1,
            extent: "complete",
          })),
          ...(unmapped ? { coverageUnmapped: true } : {}),
        },
      });
    }

    const releaseFields = {
      format: args.release.format,
      binding: args.release.binding,
      language: IMPORT_LANGUAGE,
      isbn13: args.release.isbn13,
      isbn10: args.release.isbn10,
      pubDate: args.release.pubDate,
      price: args.release.price,
      description: args.release.description,
    };
    releaseId = await ctx.db.insert("releases", {
      status: "active",
      ...tag,
      editionId,
      ...releaseFields,
      publisherId: publisher.id,
      seriesIds: [seriesId],
    });
    created.push({
      ref: { type: "release", id: releaseId },
      table: "releases",
      fields: releaseFields,
    });
  }

  await recordCreation(
    ctx,
    {
      sourceKey: args.sourceKey,
      evidence,
      citation: args.citation,
      comment: args.importComment,
      now,
    },
    created,
  );

  if (releaseId !== undefined) {
    await linkObservation(ctx, args.observation._id, { type: "release", id: releaseId });
  }

  return { seriesId, volumeIds, releaseId, changed: created.length > 0 };
}

// ---------- Release Bundles (box sets) ----------

export type BundleArgs = {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  citation: { sourceName: string; url: string };
  importComment: string;
  /** The base Series whose Volumes the box collects. */
  seriesId: Id<"series">;
  /** The box's own name ("Fire Force Box Set 1"). */
  name: string;
  /** Covered Volume labels, in order. */
  labels: string[];
  publisher: PublisherRef;
  release: ReleasePayload;
  tagBootstrapUnreviewed: boolean;
  now: number;
};

/**
 * A box set as a Release Bundle (spec §2): its own purchasable facts, with
 * memberships to the member Releases that already exist — the same
 * publisher's single-Volume Releases of the covered Volumes in the box's
 * Format, ordered by the box's own Volume sequence. A box set is never a
 * Release, a Volume, or a Series. Idempotent by ISBN-13: an existing bundle
 * links instead, and picks up members whose Releases arrived after it (a
 * box imported before its books) with one importer-authored Revision —
 * unless the box names another Series or Format than the bundle's own
 * (`conflict`, left on the observation for review; `addLateBundleMembers`).
 * `members` counts the bundle's members from `labels` after the call.
 */
export async function createReleaseBundle(
  ctx: MutationCtx,
  args: BundleArgs,
): Promise<{
  bundleId: Id<"releaseBundles">;
  members: number;
  created: boolean;
  conflict?: string;
}> {
  const existing =
    args.release.isbn13 !== undefined
      ? await ctx.db
          .query("releaseBundles")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", args.release.isbn13))
          .first()
      : null;
  if (existing) {
    await linkObservation(ctx, args.observation._id, { type: "releaseBundle", id: existing._id });
    const { expected, conflict } = await addLateBundleMembers(ctx, existing, {
      ...args,
      format: args.release.format,
    });
    return { bundleId: existing._id, members: expected, created: false, conflict };
  }

  const created: CreatedRecord[] = [];
  const tag = args.tagBootstrapUnreviewed ? { bootstrapUnreviewed: true } : {};
  const publisher = await ensurePublisher(ctx, args.publisher);
  if (publisher.created) {
    created.push({
      ref: { type: "publisher", id: publisher.id },
      table: "publishers",
      fields: { name: args.publisher.name, slug: publisher.slug },
    });
  }

  const members = await expectedBundleMembers(
    ctx,
    { ...args, format: args.release.format },
    publisher.id,
  );
  const memberIds = members.map((member) => member.releaseId);

  const publicId = await allocatePublicId(ctx, "bundle");
  const fields = {
    name: args.name,
    format: args.release.format,
    isbn13: args.release.isbn13,
    isbn10: args.release.isbn10,
    pubDate: args.release.pubDate,
    price: args.release.price,
    description: args.release.description,
  };
  const bundleId = await ctx.db.insert("releaseBundles", {
    status: "active",
    ...tag,
    publicId,
    publisherId: publisher.id,
    ...fields,
  });
  for (const member of members) {
    await ctx.db.insert("bundleMemberships", { bundleId, ...member });
  }
  created.push({
    ref: { type: "releaseBundle", id: bundleId },
    table: "releaseBundles",
    fields: { ...fields, members: memberIds },
  });
  await recordCreation(
    ctx,
    {
      sourceKey: args.sourceKey,
      evidence: [args.observation._id],
      citation: args.citation,
      comment: args.importComment,
      now: args.now,
    },
    created,
  );
  await linkObservation(ctx, args.observation._id, { type: "releaseBundle", id: bundleId });
  return { bundleId, members: memberIds.length, created: true };
}

/**
 * The member Releases a box's covered Volumes have today: for each label,
 * the publisher's active Release of that whole Volume alone in the box's
 * Format, outside any Edition Line. `order` is the label's place in the box
 * (1-based), so members that arrive late still sort by Volume
 * (`addLateBundleMembers` renumbers generated orders to match).
 */
async function expectedBundleMembers(
  ctx: MutationCtx,
  args: Pick<BundleMembersArgs, "seriesId" | "labels" | "format">,
  publisherId: Id<"publishers">,
): Promise<Array<{ releaseId: Id<"releases">; order: number }>> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", args.seriesId))
    .collect();
  const members: Array<{ releaseId: Id<"releases">; order: number }> = [];
  for (const [i, label] of args.labels.entries()) {
    const volume = volumes.find((vol) => vol.status === "active" && labelsEqual(vol.label, label));
    if (!volume) continue;
    const coverages = await coveringOf(ctx, volume._id);
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      // The member is the publisher's whole single-Volume book: never a
      // packaging line's, an omnibus, or a book holding part of the Volume
      // (the rule matching applies, lib/matching.ts).
      if (edition.publisherId !== publisherId || !(await isWholeSingleVolume(ctx, edition))) {
        continue;
      }
      const member = (await releasesOf(ctx, edition._id)).find(
        (release) => release.status === "active" && release.format === args.format,
      );
      if (member) {
        if (!members.some((m) => m.releaseId === member._id)) {
          members.push({ releaseId: member._id, order: i + 1 });
        }
        break;
      }
    }
  }
  return members;
}

/** What reconciling a box's members needs: its covered Volumes, Format and citation. */
export type BundleMembersArgs = Pick<
  BundleArgs,
  "sourceKey" | "observation" | "citation" | "importComment" | "seriesId" | "labels" | "now"
> & { format: ReleasePayload["format"] };

/**
 * Why a box cannot fill this bundle, or null when it can: the box must name
 * the bundle's own Format and the one Series its members already belong to
 * (merged members answer through their survivor; hidden ones still count).
 * A bundle with no members yet has no Series to keep (a box imported before
 * its books); one whose members span two Series never auto-fills.
 */
async function bundleIdentityConflict(
  ctx: MutationCtx,
  bundle: Doc<"releaseBundles">,
  current: Array<Doc<"bundleMemberships">>,
  args: Pick<BundleMembersArgs, "seriesId" | "format">,
): Promise<string | null> {
  if (bundle.format !== undefined && bundle.format !== args.format) {
    return (
      `Box set "${bundle.name}" is ${bundle.format}; the source now lists it as ` +
      `${args.format} — Format conflict, an Editor reviews it.`
    );
  }
  const seriesIds = new Set<Id<"series">>();
  for (const row of current) {
    const release = await survivorOf<"releases">(ctx, await ctx.db.get(row.releaseId));
    for (const id of release?.seriesIds ?? []) seriesIds.add(id);
  }
  if (seriesIds.size === 0 || (seriesIds.size === 1 && seriesIds.has(args.seriesId))) {
    return null;
  }
  const title = async (id: Id<"series">) => (await ctx.db.get(id))?.title ?? id;
  const collected = (await Promise.all([...seriesIds].map(title))).join(", ");
  return (
    `Box set "${bundle.name}" collects ${collected}; the source now places it in ` +
    `${await title(args.seriesId)} — Series conflict, an Editor reviews it.`
  );
}

/**
 * Reconcile an existing bundle with the members its Volumes have now: add
 * the missing ones at their Volume's place and record the change as one
 * system-approved Proposal with a public Revision citing the source.
 * Nothing is ever removed. Only a box of the bundle's own canonical
 * identity fills it (`bundleIdentityConflict`): another Series or Format
 * adds nothing and leaves the conflict on the observation for review.
 * Existing members keep their places when an Editor ordered them or added
 * one outside the box's Volumes; when every member is the box's own and
 * already in Volume order, their orders are the importer's (the original
 * importer numbered them compactly over the books that existed) and are
 * renumbered by Volume place, so late members never collide with them.
 * `order` is a sort key, not part of the recorded `members` change. A
 * hidden, merged or locked bundle, or one whose members a human overrode,
 * is left alone. `expected` counts the expected members linked afterwards,
 * `added` the ones this call linked.
 */
async function addLateBundleMembers(
  ctx: MutationCtx,
  bundle: Doc<"releaseBundles">,
  args: BundleMembersArgs,
): Promise<{ expected: number; added: number; conflict?: string }> {
  if (bundle.status !== "active" || bundle.locked || bundle.overriddenFields?.includes("members")) {
    return { expected: 0, added: 0 };
  }
  // In page order: by `order`, then creation.
  const current = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundle._id))
    .collect();
  const conflict = await bundleIdentityConflict(ctx, bundle, current, args);
  if (conflict !== null) {
    await recordUnplaced(ctx, args.observation, { kind: "series", reason: conflict }, args.now);
    return { expected: 0, added: 0, conflict };
  }
  const expected = await expectedBundleMembers(ctx, args, bundle.publisherId);
  const linked = new Set<Id<"releases">>(current.map((row) => row.releaseId));
  const missing = expected.filter((member) => !linked.has(member.releaseId));
  if (missing.length === 0) return { expected: expected.length, added: 0 };

  const place = new Map(expected.map((member) => [member.releaseId, member.order]));
  const generated = current.every(
    (row, i) =>
      place.has(row.releaseId) &&
      (i === 0 || place.get(current[i - 1]!.releaseId)! < place.get(row.releaseId)!),
  );
  if (generated) {
    for (const row of current) {
      const order = place.get(row.releaseId)!;
      if (row.order !== order) await ctx.db.patch(row._id, { order });
    }
  }
  const last = Math.max(0, ...current.map((row) => row.order));
  for (const [i, member] of missing.entries()) {
    await ctx.db.insert("bundleMemberships", {
      bundleId: bundle._id,
      releaseId: member.releaseId,
      order: generated ? member.order : last + i + 1,
    });
  }
  const ref = { type: "releaseBundle" as const, id: bundle._id };
  const latest = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .order("desc")
    .first();
  const before = current.map((row) => row.releaseId);
  const after = generated
    ? [...current, ...missing]
        .map((member) => member.releaseId)
        .sort((a, b) => place.get(a)! - place.get(b)!)
    : [...before, ...missing.map((member) => member.releaseId)];
  const changes = [{ field: "members", before, after }];
  await insertSourceProposal(ctx, {
    sourceKey: args.sourceKey,
    state: "approved",
    ops: [{ kind: "update", ref, baseRevisionId: latest?._id, changes }],
    evidence: [args.observation._id],
    comment: args.importComment,
    now: args.now,
    citation: args.citation,
    revisions: [{ ref, seq: (latest?.seq ?? 0) + 1, changes }],
  });
  return { expected: expected.length, added: missing.length };
}

/** What reconciling a linked box did: members added, or why it went to review. */
export type BundleReconcile = { added: number; conflict?: string };

/**
 * Rung ① for a box set already placed as a Release Bundle: the bundle picks
 * up members whose Releases arrived after it (`addLateBundleMembers`).
 * Adapters call it for every linked box they see, unchanged snapshots and
 * listings included, since members arrive through other records and never
 * change the box's own. A box that names another Series or Format than the
 * bundle's adds nothing and returns the `conflict` for the run to report.
 */
export async function reconcileLinkedBundle(
  ctx: MutationCtx,
  bundleId: Id<"releaseBundles">,
  args: BundleMembersArgs,
): Promise<BundleReconcile> {
  const bundle = await ctx.db.get(bundleId);
  if (!bundle) return { added: 0 };
  const { added, conflict } = await addLateBundleMembers(ctx, bundle, args);
  return conflict === undefined ? { added } : { added, conflict };
}

// ---------- the steady-state review queue path ----------

/** One temp-ID create op of a Proposal (lib/proposalCreates.ts reads them). */
export type CreateOp = { kind: "create"; table: string; tempId: string; fields: unknown };

/** What the creation ops describe: the records a book needs, in temp-ID form. */
export type CreationOpsArgs = {
  seriesId: Id<"series"> | null;
  seriesTitle: string;
  seriesAltTitles?: string[];
  /** Covered labels; [] = one unlabeled Volume, unless `seriesOnly` or `placement` says otherwise. */
  labels: string[];
  seriesOnly?: boolean;
  /**
   * The Edition Line a packaged guess belongs to. The ops reference the base
   * Series' existing line of that name, or create it, so approval files the
   * Edition under it. Its position wins over `linePosition`.
   */
  editionLine?: { name: string; position: string | null };
  /** Edition Line Position of a packaged guess queued without `editionLine`. */
  linePosition?: string;
  /** The Release guess with the publisher's slug; absent = backbone only. */
  release?: ReleasePayload & { publisherSlug: string };
  /**
   * A Data Team member's placement of a held book (placement.ts), under its
   * existing Series. Its coverage is `labels`, or Unmapped Packaging under
   * the line, or not stated yet (`pending`: the Edition covers nothing and
   * the Draft cannot be submitted). Its Volume and Edition ops join a record
   * created meanwhile instead of duplicating it (`joinExisting`), and the
   * Release op names the observation approval links to it.
   */
  placement?: {
    observationId: Id<"sourceObservations">;
    seriesId: Id<"series">;
    coverage: "labels" | "unmapped" | "pending";
  };
};

export type QueueArgs = Omit<CreationOpsArgs, "placement"> & {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  comment: string;
  now: number;
};

/**
 * The Edition Line reference for a queued packaging guess: the base
 * Series' active line of that name from this publisher when one exists (the
 * importer's ensureEditionLine rule), else a create op for it appended to
 * `ops`, whose temp-ID is returned. The op is `joinExisting`: two members of
 * one new line queued before either is approved both carry it, and the one
 * approved second joins the line the first created (lib/proposalCreates.ts).
 */
async function queueEditionLine(
  ctx: MutationCtx,
  args: {
    seriesId: Id<"series"> | null;
    publisherSlug: string;
    name: string;
    ops: CreateOp[];
  },
): Promise<string> {
  const publisher = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", args.publisherSlug))
    .unique();
  if (args.seriesId !== null && publisher !== null) {
    const existing = await activeEditionLine(ctx, {
      seriesId: args.seriesId,
      publisherId: publisher._id,
      name: args.name,
    });
    if (existing) return existing._id;
  }
  args.ops.push({
    kind: "create",
    table: "editionLines",
    tempId: "edition-line",
    fields: {
      seriesId: args.seriesId ?? "series",
      publisherSlug: args.publisherSlug,
      name: args.name,
      joinExisting: true,
    },
  });
  return "edition-line";
}

/**
 * The temp-ID create ops for whatever does not exist yet (Series, Volumes,
 * Edition Line, Edition, Release): existing active Volumes of a label (or a
 * merged one's survivor) are referenced by ID, the rest created. Shared by
 * an import's queued Proposal (queueCreationProposal) and a member's
 * placement of a held book (placement.ts), which alone sets `placement`.
 */
export async function creationOps(ctx: MutationCtx, args: CreationOpsArgs): Promise<CreateOp[]> {
  const ops: CreateOp[] = [];
  const placement = args.placement;
  const join = placement !== undefined ? { joinExisting: true } : {};
  if (args.seriesId === null) {
    ops.push({
      kind: "create",
      table: "series",
      tempId: "series",
      fields: {
        title: args.seriesTitle,
        altTitles: args.seriesAltTitles ?? [],
      },
    });
  }
  const volumeRefs: string[] = [];
  const existingVolumes =
    args.seriesId === null
      ? []
      : await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", args.seriesId!))
          .collect();
  const volumeLabels: Array<string | undefined> =
    placement !== undefined && placement.coverage !== "labels"
      ? []
      : args.labels.length > 0
        ? args.labels.map(canonicalLabel)
        : args.seriesOnly
          ? []
          : [undefined];
  for (const [i, label] of volumeLabels.entries()) {
    const sameLabel = existingVolumes.filter((volume) => labelsEqual(volume.label, label ?? null));
    let existing = sameLabel.find((volume) => volume.status === "active");
    if (!existing) {
      for (const volume of sameLabel) {
        const survivor = await survivorOf<"volumes">(ctx, volume);
        if (survivor?.status === "active" && survivor.seriesId === args.seriesId) {
          existing = survivor;
          break;
        }
      }
    }
    if (existing) {
      if (!volumeRefs.includes(existing._id)) volumeRefs.push(existing._id);
      continue;
    }
    // Canonical labels can repeat in a source range. One Volume and one
    // coverage row represent that content, including within this proposal.
    if (volumeLabels.slice(0, i).some((previous) => labelsEqual(previous, label ?? null))) continue;
    const tempId = `volume-${i + 1}`;
    volumeRefs.push(tempId);
    ops.push({
      kind: "create",
      table: "volumes",
      tempId,
      fields: { seriesId: args.seriesId ?? "series", label, ...join },
    });
  }
  if (args.release !== undefined) {
    const editionLineId =
      args.editionLine === undefined
        ? undefined
        : await queueEditionLine(ctx, {
            seriesId: args.seriesId,
            publisherSlug: args.release.publisherSlug,
            name: args.editionLine.name,
            ops,
          });
    const linePosition = args.editionLine?.position ?? args.linePosition;
    ops.push({
      kind: "create",
      table: "editions",
      tempId: "edition",
      fields: {
        publisherSlug: args.release.publisherSlug,
        ...(editionLineId !== undefined ? { editionLineId } : {}),
        ...(linePosition !== undefined ? { linePosition } : {}),
        volumeCoverage: volumeRefs.map((volume, i) => ({
          volume,
          order: i + 1,
          extent: "complete",
        })),
        ...(placement?.coverage === "unmapped" ? { coverageUnmapped: true } : {}),
        ...join,
      },
    });
    ops.push({
      kind: "create",
      table: "releases",
      tempId: "release",
      fields: {
        editionId: "edition",
        format: args.release.format,
        binding: args.release.binding,
        language: IMPORT_LANGUAGE,
        isbn13: args.release.isbn13,
        isbn10: args.release.isbn10,
        pubDate: args.release.pubDate,
        price: args.release.price,
        description: args.release.description,
        ...(placement !== undefined
          ? { placement: { observationId: placement.observationId, seriesId: placement.seriesId } }
          : {}),
      },
    });
  }
  return ops;
}

/**
 * Queue an In-Review Proposal pre-filled with the parsed guess (spec §5/§6):
 * temp-ID create ops for whatever does not exist yet (creationOps),
 * evidence citing the observation, the gate or matching-ladder flag in the
 * change comment.
 * These land in the shared review queue (proposals.ts); a Moderator's
 * approval applies the ops via the creation registry. The observation
 * remembers the proposal (queuedProposalId) so an unchanged snapshot never
 * re-queues — not while one is open, and not after a rejection. While the
 * Proposal is in review the book is the review queue's, never a Held Book
 * (clearHold); once it is decided, a later hold lists the book again.
 */
export async function queueCreationProposal(
  ctx: MutationCtx,
  args: QueueArgs,
): Promise<Id<"proposals">> {
  const { sourceKey, observation, comment, now, ...described } = args;
  const { proposalId } = await insertSourceProposal(ctx, {
    sourceKey,
    state: "inReview",
    ops: await creationOps(ctx, described),
    evidence: [observation._id],
    comment,
    now,
  });
  await ctx.db.patch(observation._id, { queuedProposalId: proposalId });
  await clearHold(ctx, observation._id);
  return proposalId;
}
