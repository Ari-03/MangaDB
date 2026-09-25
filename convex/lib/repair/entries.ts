// Validators for the one-time catalog repair plan (repair-plan.json, built by
// /tmp/mangadb-audit/plan/build_plan.py and fed batch by batch through
// scripts/repair.ts). Every entry names the rows it expects and their
// expected current state, so the executor (./ops.ts) can skip and report
// drift instead of clobbering. `kind` is the plan step's kind, stamped on
// each entry by the runner; the entry types are inferred from here.

import { v, type Infer } from "convex/values";

const nullableString = v.union(v.string(), v.null());

const partialDate = v.object({
  year: v.number(),
  month: v.optional(v.number()),
  day: v.optional(v.number()),
  sort: v.number(),
});

const cover = v.object({
  storageId: v.id("_storage"),
  sourceUrl: v.optional(v.string()),
  attribution: v.optional(v.string()),
});

const base = { key: v.string(), reason: v.string() };

// ---------- stage 1: publishers ----------

/** Merge a duplicate publisher row (lib/publishers.ts DUPLICATE_SLUGS) into its company. */
export const publisherMergeEntry = v.object({
  kind: v.literal("publisherMerge"),
  ...base,
  loserId: v.id("publishers"),
  survivorId: v.id("publishers"),
  expectEditions: v.number(),
});

/** Link an imprint row to its parent company (lib/publishers.ts IMPRINT_PARENTS). */
export const publisherParentEntry = v.object({
  kind: v.literal("publisherParent"),
  ...base,
  publisherId: v.id("publishers"),
  slug: v.string(),
});

/**
 * Move an Edition (and its Releases' denorm) to another publisher row. With
 * `imprint`, the target must be that PRH imprint's row and an imprint of the
 * edition's current company.
 */
export const editionPublisherEntry = v.object({
  kind: v.literal("editionPublisher"),
  ...base,
  editionId: v.id("editions"),
  fromPublisherId: v.id("publishers"),
  toPublisherId: v.id("publishers"),
  imprint: nullableString,
  observationIds: v.array(v.id("sourceObservations")),
  otherReleases: v.number(),
});

// ---------- stage 2: scope ----------

/** Hide an out-of-scope Series with its whole cascade, atomically. */
export const hideSeriesEntry = v.object({
  kind: v.literal("hideSeries"),
  ...base,
  seriesId: v.id("series"),
  volumeIds: v.array(v.id("volumes")),
  editionIds: v.array(v.id("editions")),
  releaseIds: v.array(v.id("releases")),
});

/**
 * Hide one out-of-scope Release; its Edition and Volumes follow once nothing
 * active is left under them (order-independent across entries).
 */
export const hideReleaseEntry = v.object({
  kind: v.literal("hideRelease"),
  ...base,
  releaseId: v.id("releases"),
  editionId: v.union(v.id("editions"), v.null()),
  volumeIds: v.array(v.id("volumes")),
});

const recordType = v.union(
  v.literal("publisher"),
  v.literal("seriesFamily"),
  v.literal("series"),
  v.literal("volume"),
  v.literal("editionLine"),
  v.literal("edition"),
  v.literal("release"),
  v.literal("releaseVariant"),
  v.literal("releaseBundle"),
);

/** Clear a Source Observation's link to a record it does not describe. */
export const unlinkObservationEntry = v.object({
  kind: v.literal("unlinkObservation"),
  ...base,
  observationId: v.id("sourceObservations"),
  recordType,
  recordId: v.string(),
});

// ---------- stages 3-4: series merges & packaging ----------

/**
 * Merge a duplicate Series: place each loser Volume in the survivor by label
 * (merge into the same-labelled Volume, else move), then run the stock
 * Series merge. Packaging volumes hold the merge until stage 4 re-models
 * them; re-running the same entry finishes it.
 */
export const mergeSeriesEntry = v.object({
  kind: v.literal("mergeSeries"),
  ...base,
  loserId: v.id("series"),
  survivorId: v.id("series"),
  placements: v.array(
    v.object({
      volumeId: v.id("volumes"),
      label: nullableString,
      intoVolumeId: v.union(v.id("volumes"), v.null()),
    }),
  ),
  packagingVolumeIds: v.array(v.id("volumes")),
  retitle: nullableString,
});

/**
 * Re-model an Edition that covers a packaging or placeholder Volume: into an
 * Edition Line of the base Series with real coverage (one Edition per
 * group), or into a Release Bundle; then retire the bogus Volume(s).
 * No groups = line membership only, coverage left for review.
 */
export const remodelEditionEntry = v.object({
  kind: v.literal("remodelEdition"),
  ...base,
  editionId: v.id("editions"),
  volumeId: v.id("volumes"),
  targetSeriesId: v.id("series"),
  line: v.union(v.object({ name: v.string(), position: nullableString }), v.null()),
  bundle: v.union(v.object({ name: v.string() }), v.null()),
  // Group 0 stays on this Edition; later groups become new Editions. A
  // coverage row names a label in the target Series (created when missing)
  // or, for research's "cover the survivor's sole volume", a Volume id.
  groups: v.array(
    v.object({
      releaseIds: v.union(v.array(v.id("releases")), v.null()),
      coverage: v.array(
        v.object({
          label: nullableString,
          volumeId: v.union(v.id("volumes"), v.null()),
          extent: v.union(v.literal("complete"), v.literal("partial")),
        }),
      ),
      linePosition: nullableString,
    }),
  ),
  retireVolumeIds: v.array(v.id("volumes")),
});

/**
 * Fold one Edition into another (the same book split across two), stock
 * merge. Both must cover the same Volumes, except `packagingTwin`s: two
 * source records of one box set whose packaging Volumes stage 4 retires.
 */
export const foldEditionEntry = v.object({
  kind: v.literal("foldEdition"),
  ...base,
  keepEditionId: v.id("editions"),
  otherEditionId: v.id("editions"),
  packagingTwin: v.boolean(),
});

// ---------- stages 5-6: field repairs & volume numbering ----------

// `null` in a plan means "absent" (JSON has no undefined).
const seriesChange = v.union(
  v.object({ field: v.literal("title"), before: v.string(), after: v.string() }),
  v.object({
    field: v.literal("altTitles"),
    before: v.array(v.string()),
    after: v.array(v.string()),
  }),
);

const releaseChange = v.union(
  v.object({
    field: v.union(v.literal("isbn13"), v.literal("isbn10"), v.literal("binding")),
    before: nullableString,
    after: nullableString,
  }),
  v.object({
    field: v.literal("pubDate"),
    before: v.union(partialDate, v.null()),
    after: v.union(partialDate, v.null()),
  }),
  v.object({
    field: v.literal("coverImage"),
    before: v.union(cover, v.null()),
    after: v.null(),
  }),
);

/** Field-level repair with expected before-values (drift = skip). */
export const updateFieldsEntry = v.union(
  v.object({
    kind: v.literal("updateFields"),
    ...base,
    table: v.literal("series"),
    id: v.id("series"),
    changes: v.array(seriesChange),
    evidenceObservationId: v.union(v.id("sourceObservations"), v.null()),
  }),
  v.object({
    kind: v.literal("updateFields"),
    ...base,
    table: v.literal("releases"),
    id: v.id("releases"),
    changes: v.array(releaseChange),
    evidenceObservationId: v.union(v.id("sourceObservations"), v.null()),
  }),
);

/**
 * Volume Position = volume number: merge duplicate Volumes, apply relabels,
 * canonicalize numeric labels, and settle positions for one Series.
 */
export const normalizeVolumesEntry = v.object({
  kind: v.literal("normalizeVolumes"),
  ...base,
  seriesId: v.id("series"),
  merges: v.array(v.object({ volumeId: v.id("volumes"), intoVolumeId: v.id("volumes") })),
  relabels: v.array(
    v.object({ volumeId: v.id("volumes"), before: nullableString, after: nullableString }),
  ),
});

export const repairEntry = v.union(
  publisherMergeEntry,
  publisherParentEntry,
  editionPublisherEntry,
  hideSeriesEntry,
  hideReleaseEntry,
  unlinkObservationEntry,
  mergeSeriesEntry,
  remodelEditionEntry,
  foldEditionEntry,
  updateFieldsEntry,
  normalizeVolumesEntry,
);

export type RepairEntry = Infer<typeof repairEntry>;
export type EntryOf<K extends RepairEntry["kind"]> = Extract<RepairEntry, { kind: K }>;

/** What happened to one plan entry, with free-form notes on partial work. */
export const outcome = v.object({
  key: v.string(),
  status: v.union(
    v.literal("applied"),
    v.literal("partial"),
    v.literal("deferred"),
    v.literal("alreadyApplied"),
    v.literal("noop"),
    v.literal("skipped"),
    v.literal("error"),
  ),
  reason: v.optional(v.string()),
  notes: v.optional(v.array(v.string())),
});

export type Outcome = Infer<typeof outcome>;
