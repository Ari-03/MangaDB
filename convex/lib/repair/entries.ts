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

/**
 * Undo a scope hide (stage 17: scope is judged by look, so manga-looking
 * works hidden as "Western comics" come back). `target` is the record the
 * hide was aimed at; the id lists are the rest of what that hide took down,
 * restored top-down through the stock Restore. Every row must still be
 * hidden (or already active from an earlier run), and each restored row's
 * parent must end up active, so nothing comes back orphaned.
 */
export const restoreRecordEntry = v.object({
  kind: v.literal("restoreRecord"),
  ...base,
  target: v.union(
    v.object({ type: v.literal("series"), id: v.id("series") }),
    v.object({ type: v.literal("volume"), id: v.id("volumes") }),
    v.object({ type: v.literal("edition"), id: v.id("editions") }),
    v.object({ type: v.literal("release"), id: v.id("releases") }),
  ),
  volumeIds: v.array(v.id("volumes")),
  editionIds: v.array(v.id("editions")),
  releaseIds: v.array(v.id("releases")),
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

const releaseFormat = v.union(v.literal("physical"), v.literal("digital"));

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
  // An ebook recorded as print (or the reverse); going digital drops Binding.
  v.object({
    field: v.literal("format"),
    before: releaseFormat,
    after: releaseFormat,
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
 * canonicalize numeric labels, and settle positions for one Series. A merge
 * normally needs both Volumes to share a label; one that states the
 * duplicate's current `label` (e.g. an unlabeled copy of vol 1) is checked
 * against that instead.
 */
export const normalizeVolumesEntry = v.object({
  kind: v.literal("normalizeVolumes"),
  ...base,
  seriesId: v.id("series"),
  merges: v.array(
    v.object({
      volumeId: v.id("volumes"),
      intoVolumeId: v.id("volumes"),
      label: v.optional(nullableString),
    }),
  ),
  relabels: v.array(
    v.object({ volumeId: v.id("volumes"), before: nullableString, after: nullableString }),
  ),
});

// ---------- stage 12: series splits ----------

/**
 * Split a second work out of a Series that holds two (an earlier title
 * match merged them): create the work's own Series, move its whole Volumes
 * across, re-point its Editions that sit on a Volume label both works share
 * onto the new Series, add the backbone Volumes it lacks, and relink its
 * series-level Source Observations so importers route its future Releases
 * there. Labels are the moved work's own numbering. Every row states what
 * it expects now (drift = skip); the new Series' creation Revision records
 * the entry key, which is how a re-run finds it again (alreadyApplied).
 */
export const splitSeriesEntry = v.object({
  kind: v.literal("splitSeries"),
  ...base,
  sourceSeriesId: v.id("series"),
  sourceTitle: v.string(),
  title: v.string(),
  altTitles: v.array(v.string()),
  // Volumes that belong wholly to the moved work, with the active Editions
  // covering each one now.
  volumes: v.array(
    v.object({
      volumeId: v.id("volumes"),
      label: nullableString,
      newLabel: nullableString,
      editionIds: v.array(v.id("editions")),
    }),
  ),
  // Editions of the moved work on a Volume the staying work keeps: each
  // coverage row (in order) moves to the new Series' Volume with that label.
  editions: v.array(
    v.object({
      editionId: v.id("editions"),
      fromVolumeIds: v.array(v.id("volumes")),
      labels: v.array(nullableString),
      releaseIds: v.array(v.id("releases")),
    }),
  ),
  // Backbone Volumes of the moved work that have no Release yet.
  placeholderLabels: v.array(nullableString),
  // Series-level observations (e.g. its ANN manga record) linked to the source now.
  observationIds: v.array(v.id("sourceObservations")),
});

// ---------- stage 19: lines, researched Releases, cross-Series books ----------

/** Hide an Edition Line that no active Edition sits in (an empty or obsolete line). */
export const hideEditionLineEntry = v.object({
  kind: v.literal("hideEditionLine"),
  ...base,
  lineId: v.id("editionLines"),
  seriesId: v.id("series"),
  name: v.string(),
});

const money = v.object({ amountCents: v.number(), currency: v.string() });

/**
 * Create a researched Release no importer has on file, on a new Edition
 * covering existing Volumes (optionally placed in an Edition Line of the
 * first covered Volume's Series). Refused when the ISBN exists anywhere; the
 * creation Revision records the entry key, which is how a re-run recognizes
 * its own Release (alreadyApplied). `sources` land on the Proposal as URLs.
 */
export const createReleaseEntry = v.object({
  kind: v.literal("createRelease"),
  ...base,
  isbn13: v.string(),
  isbn10: nullableString,
  format: v.union(v.literal("physical"), v.literal("digital")),
  binding: nullableString,
  pubDate: v.union(partialDate, v.null()),
  price: v.union(money, v.null()),
  publisherId: v.id("publishers"),
  coverage: v.array(
    v.object({ volumeId: v.id("volumes"), extent: v.union(v.literal("complete"), v.literal("partial")) }),
  ),
  line: v.union(v.object({ name: v.string(), position: nullableString }), v.null()),
  sources: v.array(v.string()),
});

/**
 * A Release Bundle whose members may sit in several Series. Either extends
 * an existing bundle (`bundleId`) or turns a box-set Release into one
 * (`box`: the box's facts become the bundle's, the box Release and, once
 * empty, its Edition are hidden). Members are named by ISBN and keep the
 * plan's order; `retireVolumeIds` (the box's own placeholder Volumes) merge
 * into the first member's Volume once nothing covers them.
 */
export const releaseBundleEntry = v.object({
  kind: v.literal("releaseBundle"),
  ...base,
  bundleId: v.union(v.id("releaseBundles"), v.null()),
  box: v.union(v.object({ releaseId: v.id("releases"), name: v.string() }), v.null()),
  members: v.array(v.object({ isbn13: v.string(), order: v.number() })),
  retireVolumeIds: v.array(v.id("volumes")),
});

/**
 * Set one Edition's Volume Coverage to Volumes of any Series (an omnibus or
 * anthology spanning works), each named by Series + label and never
 * created. `before` is the coverage the plan saw (drift = skip). Optionally
 * places the Edition in a line of one Series, then retires the Volumes the
 * old coverage leaves empty.
 */
export const setCoverageEntry = v.object({
  kind: v.literal("setCoverage"),
  ...base,
  editionId: v.id("editions"),
  before: v.array(v.id("volumes")),
  coverage: v.array(
    v.object({
      seriesId: v.id("series"),
      label: nullableString,
      extent: v.union(v.literal("complete"), v.literal("partial")),
    }),
  ),
  line: v.union(v.object({ seriesId: v.id("series"), name: v.string(), position: nullableString }), v.null()),
  retireVolumeIds: v.array(v.id("volumes")),
});

/**
 * Withdraw an importer's own In-Review Proposal that no human has touched,
 * clearing the observation's queue link, so the next import re-evaluates the
 * record under the current parser (queue dedup otherwise holds it forever).
 */
export const withdrawProposalEntry = v.object({
  kind: v.literal("withdrawProposal"),
  ...base,
  proposalId: v.id("proposals"),
  observationId: v.id("sourceObservations"),
});

export const repairEntry = v.union(
  publisherMergeEntry,
  publisherParentEntry,
  editionPublisherEntry,
  hideSeriesEntry,
  hideReleaseEntry,
  restoreRecordEntry,
  unlinkObservationEntry,
  mergeSeriesEntry,
  remodelEditionEntry,
  foldEditionEntry,
  updateFieldsEntry,
  normalizeVolumesEntry,
  withdrawProposalEntry,
  splitSeriesEntry,
  hideEditionLineEntry,
  createReleaseEntry,
  releaseBundleEntry,
  setCoverageEntry,
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
