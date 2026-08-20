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
// - the creation path: publisher/series/volume/edition/release inserts with
//   the system-authored, immediately approved Proposal and one public
//   importer-authored Revision per created record, citing the source
// - the steady-state review queue: an In-Review Proposal pre-filled with
//   the parsed guess (temp-ID create ops the approval registry applies)
//
// `release` is optional on both paths: a series-structured source (ANN)
// creates or queues the Series/Volume backbone without any Release.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { labelsEqual, normalizeTitle } from "./matching";
import { getObservation, upsertObservation } from "./observations";
import { allocatePublicId } from "./publicIds";
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

/** "1–3" (or "1-3") → [1, 2, 3]; a plain or fractional label → itself alone. */
export function coveredLabels(label: string | undefined): string[] {
  if (label === undefined) return [];
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(label);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to > from && to - from < 20) {
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
    }
  }
  return [label];
}

// A single-Volume release that still implies an Edition Line — deluxe,
// omnibus, box-set packaging — always reviews in steady state (spec §6
// creation boundaries); multi-volume ranges are caught by the coverage gate.
export const EDITION_LINE_HINT = /\b(omnibus|box(?:ed)? set|deluxe|collector'?s)\b/i;

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
    return (
      (await snapshotStoredAt(ctx, observation)) <= (proposal.decidedAt ?? 0)
    );
  }
  return false;
}

// ---------- publishers ----------

/** Find-or-create the adapter's own publisher row by slug. */
export async function ensurePublisher(
  ctx: MutationCtx,
  publisher: { name: string; slug: string },
): Promise<{ id: Id<"publishers">; created: boolean }> {
  const existing = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", publisher.slug))
    .unique();
  if (existing) return { id: existing._id, created: false };
  const id = await ctx.db.insert("publishers", {
    status: "active",
    name: publisher.name,
    slug: publisher.slug,
  });
  return { id, created: true };
}

/**
 * Resolve a source's publisher NAME against existing publisher rows only —
 * never creating one. Normalized-prefix match tolerates corporate suffixes
 * ("VIZ Media LLC" ↔ "VIZ Media"). How OpenLibrary and ANN resolve
 * publishers: null means the source cannot establish the publisher key.
 */
export async function findPublisherByName(
  ctx: MutationCtx,
  name: string,
): Promise<Doc<"publishers"> | null> {
  const wanted = normalizeTitle(name);
  if (wanted === "") return null;
  const publishers = await ctx.db.query("publishers").collect();
  const hits = publishers.filter((pub) => {
    if (pub.status !== "active") return false;
    const have = normalizeTitle(pub.name);
    return (
      have === wanted ||
      wanted.startsWith(`${have} `) ||
      have.startsWith(`${wanted} `)
    );
  });
  return hits.length === 1 ? hits[0]! : null;
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
): Promise<void> {
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
  const seriesObs = await getObservation(
    ctx,
    args.sourceKey,
    `series:${args.seriesKey}`,
  );
  if (seriesObs?.recordRef?.type !== "series") {
    return { seriesId: null, changed: false };
  }
  const series = await ctx.db.get(seriesObs.recordRef.id);
  if (!series || series.status !== "active") {
    return { seriesId: null, changed: false };
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
    ...(args.editionLineHint
      ? ["an Edition Line (deluxe/omnibus/box-set packaging)"]
      : []),
  ];
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
  /** Covered volume labels in order; [] = one unlabeled Volume (oneshot). */
  labels: string[];
  /**
   * The Release to create, with its publisher. Absent for series-structured
   * backbone creation (ANN): only the Series and its Volumes are created.
   */
  release?: ReleasePayload & { publisher: { name: string; slug: string } };
  /** Tag records steady state would have queued (spec §7 Bootstrap Mode). */
  tagBootstrapUnreviewed: boolean;
  now: number;
};

type CreatedRecord = {
  ref: {
    type: "publisher" | "series" | "volume" | "edition" | "release";
    id: string;
  };
  table: string;
  fields: Record<string, unknown>;
};

export type CreationResult = {
  seriesId: Id<"series">;
  volumeIds: Id<"volumes">[];
  releaseId?: Id<"releases">;
  /** False when everything already existed and nothing was written. */
  changed: boolean;
};

/**
 * Ensure Volumes for every label under the series, reusing by label equality
 * (a second packaging of the same content must not duplicate the Volume);
 * new ones take the numeric label as Position when it is a free integer,
 * else append after the current end.
 */
async function ensureVolumes(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  labels: Array<string | undefined>,
  tag: { bootstrapUnreviewed?: boolean },
  created: CreatedRecord[],
): Promise<Id<"volumes">[]> {
  const existingVolumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const taken = new Set(existingVolumes.map((vol) => vol.position));
  let nextAppend = Math.max(0, ...existingVolumes.map((vol) => vol.position)) + 1;
  const volumeIds: Id<"volumes">[] = [];
  for (const label of labels) {
    const existing = existingVolumes.find(
      (vol) => vol.status === "active" && labelsEqual(vol.label, label ?? null),
    );
    if (existing) {
      volumeIds.push(existing._id);
      continue;
    }
    const numeric = label !== undefined ? Number(label) : NaN;
    let position: number;
    if (Number.isInteger(numeric) && numeric >= 1 && !taken.has(numeric)) {
      position = numeric;
    } else {
      position = nextAppend++;
      while (taken.has(position)) position = nextAppend++;
    }
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
 * volumes (complete, in order), outside any Edition Line — the sibling
 * edition a same-packaging Release in another Format/Binding belongs to
 * (spec §2: an Edition is realized by Releases differing only there).
 */
async function findSiblingEdition(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
  volumeIds: Id<"volumes">[],
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
    if (edition.editionLineId !== undefined) continue;
    const rows = await ctx.db
      .query("volumeCoverages")
      .withIndex("by_edition", (q) => q.eq("editionId", edition._id))
      .collect();
    if (rows.length !== volumeIds.length) continue;
    const matches = rows
      .sort((a, b) => a.order - b.order)
      .every(
        (row, i) => row.volumeId === volumeIds[i] && row.extent === "complete",
      );
    if (matches) return edition._id;
  }
  return null;
}

/**
 * The rung-⑤ creation path: insert whatever does not exist yet (publisher,
 * Series, Volumes, Edition, Release), then record it as one system-authored,
 * immediately approved Proposal (spec §5: imports author Proposals too) with
 * one public Revision per created record, citing the source name + record
 * URL (spec §6 attribution). One call = one atomic mutation slice.
 */
export async function createCanonicalRecords(
  ctx: MutationCtx,
  args: CreationArgs,
): Promise<CreationResult> {
  const { now } = args;
  const tag = args.tagBootstrapUnreviewed ? { bootstrapUnreviewed: true } : {};
  const created: CreatedRecord[] = [];

  let seriesId = args.seriesId;
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
    created.push({ ref: { type: "series", id: seriesId }, table: "series", fields });
    if (args.seriesKey !== undefined) {
      await linkSeriesObservation(ctx, {
        sourceKey: args.sourceKey,
        seriesKey: args.seriesKey,
        title: args.seriesTitle,
        url: args.seriesUrl,
        seriesId,
        now,
      });
    }
  }

  const volumeLabels: Array<string | undefined> =
    args.labels.length > 0 ? args.labels : [undefined];
  const volumeIds = await ensureVolumes(ctx, seriesId, volumeLabels, tag, created);

  let releaseId: Id<"releases"> | undefined;
  if (args.release !== undefined) {
    const publisher = await ensurePublisher(ctx, args.release.publisher);
    if (publisher.created) {
      created.push({
        ref: { type: "publisher", id: publisher.id },
        table: "publishers",
        fields: {
          name: args.release.publisher.name,
          slug: args.release.publisher.slug,
        },
      });
    }

    let editionId = await findSiblingEdition(ctx, publisher.id, volumeIds);
    if (editionId === null) {
      const editionPublicId = await allocatePublicId(ctx, "edition");
      editionId = await ctx.db.insert("editions", {
        status: "active",
        ...tag,
        publicId: editionPublicId,
        publisherId: publisher.id,
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

  if (created.length > 0) {
    const author = { kind: "source" as const, sourceKey: args.sourceKey };
    const proposalId = await ctx.db.insert("proposals", {
      author,
      state: "approved",
      currentVersionNo: 1,
      submittedAt: now,
      decidedAt: now,
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
      evidence: [
        { kind: "observation" as const, observationId: args.observation._id },
      ],
      changeComment: args.importComment,
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
        comment: args.importComment,
        citation: args.citation,
      });
    }
  }

  if (releaseId !== undefined) {
    await ctx.db.patch(args.observation._id, {
      recordRef: { type: "release", id: releaseId },
    });
  }

  return { seriesId, volumeIds, releaseId, changed: created.length > 0 };
}

// ---------- the steady-state review queue path ----------

export type QueueArgs = {
  sourceKey: string;
  observation: Doc<"sourceObservations">;
  seriesId: Id<"series"> | null;
  seriesTitle: string;
  seriesAltTitles?: string[];
  labels: string[];
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
  const volumeTempIds: string[] = [];
  const volumeLabels: Array<string | undefined> =
    args.labels.length > 0 ? args.labels : [undefined];
  for (const [i, label] of volumeLabels.entries()) {
    const tempId = `volume-${i + 1}`;
    volumeTempIds.push(tempId);
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
        volumeCoverage: volumeTempIds.map((tempId, i) => ({
          volume: tempId,
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
