// Source-agnostic apply machinery for import adapters (tickets #34/#36,
// spec §6/§7): everything between a source's normalized snapshot and the
// canonical catalog that is not source-specific. Extracted from the Seven
// Seas adapter so Kodansha, ANN, PRH, and OpenLibrary run the exact same
// pipeline:
//
// - partial-date normalization with the yyyymmdd sort key (spec §8)
// - the series half of matching rung ① (source-keyed series observations,
//   rename-as-field-conflict reconciliation)
// - queue dedup: one open queue item per observation; a rejected one never
//   re-queues until the snapshot changes
// - publisher resolution: canonical names and duplicate aliases, imprints
//   as rows of their own, merged rows followed to their survivor
// - the creation path: publisher/series/volume/edition-line/edition/release
//   inserts (and box sets as Release Bundles) with the system-authored,
//   immediately approved Proposal and one public importer-authored Revision
//   per created record, citing the source. Volume Position is the volume
//   number; packaging covers the base Series' real Volumes, never its own
// - the steady-state review queue: an In-Review Proposal pre-filled with
//   the parsed guess (temp-ID create ops the approval registry applies)
// - repairs stand: series links and same-label Volumes follow merges to
//   their survivors, and the creation path never recreates a Series an
//   Editor hid (removedSeriesFor) — the record stays on its observation
//
// `release` is optional on both paths: a series-structured source (ANN)
// creates or queues the Series/Volume backbone without any Release.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { canonicalLabel } from "./bookTitle";
import { hiddenSeriesTitled, labelsEqual, survivorOf } from "./matching";
import { getObservation, upsertObservation } from "./observations";
import { allocatePublicId } from "./publicIds";
import {
  canonicalPublisherBySlug,
  canonicalPublisherFor,
  publisherNameKey,
  type CanonicalPublisher,
} from "./publishers";
import { reconcileFields } from "./reconcile";

// ---------- dates & labels ----------

export type PartialDateInput = { year: number; month?: number; day?: number };
export type PartialDate = PartialDateInput & { sort: number };

/** Partial-precision date with its yyyymmdd sort key, zeroed unknown parts (spec §8). */
export function toPartialDate(date: PartialDateInput): PartialDate {
  return {
    ...date,
    sort: date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0),
  };
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

/** A merged publisher row → its surviving company row (cycle-safe). */
async function survivingPublisher(
  ctx: MutationCtx,
  doc: Doc<"publishers"> | null,
): Promise<Doc<"publishers"> | null> {
  let current = doc;
  const visited = new Set<string>();
  while (current && current.status === "merged" && current.mergedIntoId) {
    if (visited.has(current._id)) return null;
    visited.add(current._id);
    current = await ctx.db.get(current.mergedIntoId);
  }
  return current;
}

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
  return await survivingPublisher(ctx, doc);
}

/**
 * Find-or-create a publisher row by slug. A duplicate slug ("kodansha-comics")
 * resolves to its company first, and an existing row is followed through
 * rename redirects and merges to the survivor — a merged row never collects
 * new Editions. A new imprint row records its parent when the parent exists.
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
    const survivor = await survivingPublisher(ctx, pub);
    if (survivor && survivor.status === "active") {
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
 * Upsert the synthetic series-link observation (`series:{key}`) and point it
 * at the canonical Series if not linked yet. The key is the source's own
 * series identity (its slug or record id), making a later series rename a
 * rung-① field conflict instead of a failed match.
 */
export async function linkSeriesObservation(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    seriesKey: string;
    title: string;
    url?: string;
    seriesId: Id<"series">;
    now: number;
  },
): Promise<Id<"sourceObservations">> {
  const { observation } = await upsertObservation(ctx, {
    sourceKey: args.sourceKey,
    sourceRecordId: `series:${args.seriesKey}`,
    snapshot: { kind: "series", title: args.title, url: args.url },
    now: args.now,
  });
  if (!observation.recordRef) {
    await ctx.db.patch(observation._id, {
      recordRef: { type: "series", id: args.seriesId },
    });
  }
  return observation._id;
}

/**
 * Reconcile the linked Series' title with the source's current one — a
 * series rename at the source is a field conflict routed through the same
 * authority rules as any other field (spec §6 rung ①, never a failed
 * match). Returns the linked series, if any, for the creation boundaries.
 */
export async function reconcileLinkedSeries(
  ctx: MutationCtx,
  args: {
    sourceKey: string;
    seriesKey: string;
    offeredTitle: string;
    citation: { sourceName: string; url: string };
    now: number;
  },
): Promise<{ seriesId: Id<"series"> | null; changed: boolean }> {
  const seriesObs = await getObservation(ctx, args.sourceKey, `series:${args.seriesKey}`);
  if (seriesObs?.recordRef?.type !== "series") {
    return { seriesId: null, changed: false };
  }
  // A repair merged the linked Series: the link follows it to the survivor.
  const linked = await ctx.db.get(seriesObs.recordRef.id);
  const series = await survivorOf<"series">(ctx, linked);
  if (!series || series.status !== "active") {
    return { seriesId: null, changed: false };
  }
  if (series._id !== linked?._id) {
    await ctx.db.patch(seriesObs._id, {
      recordRef: { type: "series", id: series._id },
    });
  }
  if (series.locked) return { seriesId: series._id, changed: false };
  const result = await reconcileFields(ctx, {
    sourceKey: args.sourceKey,
    ref: { type: "series", id: series._id },
    doc: series,
    offered: { title: args.offeredTitle },
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

/** Every publisher house the Series' Editions (any status) were published by. */
async function seriesPublishers(
  ctx: MutationCtx,
  seriesId: Id<"series">,
): Promise<Set<Id<"publishers">>> {
  const houses = new Set<Id<"publishers">>();
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  for (const volume of volumes) {
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition) continue;
      for (const id of await publisherHouse(ctx, edition.publisherId)) houses.add(id);
    }
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
  const hidden = (series: Doc<"series">): RemovedSeries => ({
    kind: "hidden",
    series,
    reason: `"${args.seriesTitle}" is Series ${series.publicId} ("${series.title}"), which an Editor hid — not recreated by an import.`,
  });

  const linkObs =
    args.observation.recordRef?.type === "series"
      ? args.observation
      : args.seriesKey !== undefined
        ? await getObservation(ctx, args.sourceKey, `series:${args.seriesKey}`)
        : null;
  if (linkObs?.recordRef?.type === "series") {
    const linked = await survivorOf<"series">(ctx, await ctx.db.get(linkObs.recordRef.id));
    if (linked?.status === "hidden") return hidden(linked);
    if (linked?.status === "active" && linked._id !== linkObs.recordRef.id) {
      return { kind: "merged", survivor: linked };
    }
  }

  const incoming =
    args.publisherId !== null ? new Set(await publisherHouse(ctx, args.publisherId)) : null;
  for (const series of await hiddenSeriesTitled(ctx, args.seriesTitle)) {
    if (incoming !== null) {
      const houses = await seriesPublishers(ctx, series._id);
      if (houses.size > 0 && ![...houses].some((id) => incoming.has(id))) continue;
    }
    return hidden(series);
  }
  return null;
}

// ---------- the creation path ----------

/** The Release-level facts a source offers at creation. */
export type ReleasePayload = {
  format: "physical" | "digital";
  binding?: string;
  language?: string;
  isbn13?: string;
  isbn10?: string;
  pubDate?: PartialDate;
  price?: { amountCents: number; currency: string };
};

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
      "publisher" | "series" | "volume" | "editionLine" | "edition" | "release" | "releaseBundle";
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

/**
 * An existing active Edition by this publisher covering exactly these
 * volumes (complete, in order) in the same Edition Line at the same
 * position — or outside any line when the new Release has none. That is the
 * sibling edition a same-packaging Release in another Format/Binding
 * belongs to (spec §2: an Edition is realized by Releases differing only
 * there); an omnibus never joins a single volume's Edition, or vice versa.
 */
async function findSiblingEdition(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
  volumeIds: Id<"volumes">[],
  line: { id: Id<"editionLines">; position: string | null } | null,
): Promise<Id<"editions"> | null> {
  if (volumeIds.length === 0) return null;
  const coverages = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_volume", (q) => q.eq("volumeId", volumeIds[0]!))
    .collect();
  for (const coverage of coverages) {
    const edition = await ctx.db.get(coverage.editionId);
    if (!edition || edition.status !== "active" || edition.locked) continue;
    if (edition.publisherId !== publisherId) continue;
    if ((edition.editionLineId ?? null) !== (line?.id ?? null)) continue;
    if (line !== null && (edition.linePosition ?? null) !== line.position) continue;
    const rows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
      .collect();
    if (rows.length !== volumeIds.length) continue;
    const matches = rows
      .sort((a, b) => a.order - b.order)
      .every((row, i) => row.volumeId === volumeIds[i] && row.extent === "complete");
    if (matches) return edition._id;
  }
  return null;
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
  const lines = await ctx.db
    .query("editionLines")
    .withIndex("by_series", (q) => q.eq("seriesId", args.seriesId))
    .collect();
  const wanted = args.name.toLowerCase();
  const existing = lines.find(
    (line) =>
      line.status === "active" &&
      line.publisherId === args.publisherId &&
      line.name.toLowerCase() === wanted,
  );
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
  const author = { kind: "source" as const, sourceKey: args.sourceKey };
  const proposalId = await ctx.db.insert("proposals", {
    author,
    state: "approved",
    currentVersionNo: 1,
    submittedAt: args.now,
    decidedAt: args.now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: created.map((record) => ({
      kind: "create" as const,
      table: record.table,
      tempId: record.ref.type === "volume" ? record.ref.id : record.ref.type,
      fields: record.fields,
    })),
    evidence: [...new Set(args.evidence)].map((observationId) => ({
      kind: "observation" as const,
      observationId,
    })),
    changeComment: args.comment,
  });
  for (const record of created) {
    await ctx.db.insert("revisions", {
      ref: record.ref as never,
      seq: 1,
      proposalId,
      author,
      changes: Object.entries(record.fields)
        .filter(([, value]) => value !== undefined)
        .map(([field, after]) => ({ field, after })),
      comment: args.comment,
      citation: args.citation,
    });
  }
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

  if (args.editionLine !== undefined && args.labels.length === 0) {
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
      await recordUnplaced(ctx, args.observation, removed.reason, now);
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
    const fields = { title: args.seriesTitle, altTitles };
    seriesId = await ctx.db.insert("series", {
      status: "active",
      ...tag,
      publicId,
      ...fields,
      searchText: [args.seriesTitle, ...altTitles].join(" "),
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
          seriesId,
          now,
        }),
      );
    }
  }

  const volumeLabels: Array<string | undefined> =
    args.labels.length > 0 ? args.labels : args.seriesOnly ? [] : [undefined];
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

    let editionId = await findSiblingEdition(ctx, publisher.id, volumeIds, line);
    if (editionId === null) {
      const editionPublicId = await allocatePublicId(ctx, "edition");
      editionId = await ctx.db.insert("editions", {
        status: "active",
        ...tag,
        publicId: editionPublicId,
        publisherId: publisher.id,
        ...(line ? { editionLineId: line.id, linePosition: line.position ?? undefined } : {}),
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
        },
      });
    }

    const releaseFields = {
      format: args.release.format,
      binding: args.release.binding,
      language: args.release.language ?? "en",
      isbn13: args.release.isbn13,
      isbn10: args.release.isbn10,
      pubDate: args.release.pubDate,
      price: args.release.price,
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
    await ctx.db.patch(args.observation._id, {
      recordRef: { type: "release", id: releaseId },
    });
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
 * Format. A box set is never a Release, a Volume, or a Series. Idempotent by
 * ISBN-13: an existing bundle links instead.
 */
export async function createReleaseBundle(
  ctx: MutationCtx,
  args: BundleArgs,
): Promise<{
  bundleId: Id<"releaseBundles">;
  members: number;
  created: boolean;
}> {
  const existing =
    args.release.isbn13 !== undefined
      ? await ctx.db
          .query("releaseBundles")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", args.release.isbn13))
          .first()
      : null;
  if (existing) {
    await ctx.db.patch(args.observation._id, {
      recordRef: { type: "releaseBundle", id: existing._id },
    });
    return { bundleId: existing._id, members: 0, created: false };
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

  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", args.seriesId))
    .collect();
  const memberIds: Id<"releases">[] = [];
  for (const label of args.labels) {
    const volume = volumes.find((vol) => vol.status === "active" && labelsEqual(vol.label, label));
    if (!volume) continue;
    const coverages = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_volume", (q) => q.eq("volumeId", volume._id))
      .collect();
    for (const coverage of coverages) {
      const edition = await ctx.db.get(coverage.editionId);
      if (!edition || edition.status !== "active") continue;
      if (edition.publisherId !== publisher.id || edition.editionLineId !== undefined) {
        continue;
      }
      const rows = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
        .collect();
      if (rows.length !== 1) continue;
      const member = (
        await ctx.db
          .query("releases")
          .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
          .collect()
      ).find((release) => release.status === "active" && release.format === args.release.format);
      if (member) {
        memberIds.push(member._id);
        break;
      }
    }
  }

  const publicId = await allocatePublicId(ctx, "bundle");
  const fields = {
    name: args.name,
    format: args.release.format,
    isbn13: args.release.isbn13,
    isbn10: args.release.isbn10,
    pubDate: args.release.pubDate,
    price: args.release.price,
  };
  const bundleId = await ctx.db.insert("releaseBundles", {
    status: "active",
    ...tag,
    publicId,
    publisherId: publisher.id,
    ...fields,
  });
  for (const [i, releaseId] of memberIds.entries()) {
    await ctx.db.insert("bundleMemberships", {
      bundleId,
      releaseId,
      order: i + 1,
    });
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
  await ctx.db.patch(args.observation._id, {
    recordRef: { type: "releaseBundle", id: bundleId },
  });
  return { bundleId, members: memberIds.length, created: true };
}

/**
 * Leave a packaged record the importer cannot place on its observation only
 * (spec §6: record, never guess): packaging whose covered Volumes the title
 * never states, or whose base Series is unknown. An Editor maps it later.
 */
export async function recordUnplaced(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  reason: string,
  now: number,
): Promise<void> {
  const kept = (observation.conflicts ?? []).filter((c) => c.field !== "placement");
  await ctx.db.patch(observation._id, {
    conflicts: [...kept, { field: "placement", offered: null, at: now, reason }],
  });
}

// ---------- the steady-state review queue path ----------

export type QueueArgs = {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  seriesId: Id<"series"> | null;
  seriesTitle: string;
  seriesAltTitles?: string[];
  /** Covered labels; [] = one unlabeled Volume, unless `seriesOnly`. */
  labels: string[];
  seriesOnly?: boolean;
  /** Edition Line Position of a packaged guess; the line is named in `comment`. */
  linePosition?: string;
  /** The Release guess with the publisher's slug; absent = backbone only. */
  release?: ReleasePayload & { publisherSlug: string };
  comment: string;
  now: number;
};

/**
 * Queue an In-Review Proposal pre-filled with the parsed guess (spec §5/§6):
 * temp-ID create ops for whatever does not exist yet, evidence citing the
 * observation, the gate or matching-ladder flag in the change comment.
 * These land in the shared review queue (proposals.ts, #32); a Moderator's
 * approval applies the ops via the creation registry. The observation
 * remembers the proposal (queuedProposalId) so an unchanged snapshot never
 * re-queues — not while one is open, and not after a rejection.
 */
export async function queueCreationProposal(
  ctx: MutationCtx,
  args: QueueArgs,
): Promise<Id<"proposals">> {
  const ops: Array<{
    kind: "create";
    table: string;
    tempId: string;
    fields: unknown;
  }> = [];
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
    args.labels.length > 0 ? args.labels.map(canonicalLabel) : args.seriesOnly ? [] : [undefined];
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
      fields: { seriesId: args.seriesId ?? "series", label },
    });
  }
  if (args.release !== undefined) {
    ops.push({
      kind: "create",
      table: "editions",
      tempId: "edition",
      fields: {
        publisherSlug: args.release.publisherSlug,
        ...(args.linePosition !== undefined ? { linePosition: args.linePosition } : {}),
        volumeCoverage: volumeRefs.map((volume, i) => ({
          volume,
          order: i + 1,
          extent: "complete",
        })),
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
        language: args.release.language ?? "en",
        isbn13: args.release.isbn13,
        isbn10: args.release.isbn10,
        pubDate: args.release.pubDate,
        price: args.release.price,
      },
    });
  }

  const proposalId = await ctx.db.insert("proposals", {
    author: { kind: "source", sourceKey: args.sourceKey },
    state: "inReview",
    currentVersionNo: 1,
    submittedAt: args.now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops,
    evidence: [{ kind: "observation", observationId: args.observation._id }],
    changeComment: args.comment,
  });
  await ctx.db.patch(args.observation._id, { queuedProposalId: proposalId });
  return proposalId;
}
