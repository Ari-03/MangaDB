// MangaDB Convex schema — drafted and settled under wayfinder #11.
// Embodies the decisions from #5 (hybrid data strategy), #6 (edition mapping),
// #7 (personal tracking), #10 (Clerk auth), #13 (ingestion policy),
// #14 (proposal workflow), #15 (bootstrap/seeding), and #19 (routes/SEO).
//
// Open vocabularies (language codes, binding, currency, reserved usernames)
// are validated in mutations against code-level constant lists, not schema
// literals, so extending them is never a schema event. Structural invariants
// the schema can't express (exactly-one-of, "note required when type=other",
// binding only on physical) are enforced at submission/approval per #14.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ---------- shared validators ----------

// Partial-precision publication date (#13). `sort` is yyyymmdd with zeroed
// unknown parts (20260800 = "Aug 2026"), giving one indexable key for the
// calendar, month pages, and upcoming queries; month grouping is a prefix range.
const partialDate = v.object({
  year: v.number(),
  month: v.optional(v.number()),
  day: v.optional(v.number()),
  sort: v.number(),
});

const money = v.object({
  amountCents: v.number(),
  currency: v.string(),
});

const cover = v.object({
  storageId: v.id("_storage"),
  sourceUrl: v.optional(v.string()),
  attribution: v.optional(v.string()),
});

const visibility = v.union(v.literal("public"), v.literal("private"));

const dataRole = v.union(
  v.literal("editor"),
  v.literal("moderator"),
  v.literal("administrator"),
);

// Discriminated reference to any canonical record. Observations, proposals,
// revisions, and suppressions all target one of these. Volume-coverage rows
// are deliberately absent: coverage is edited as the pseudo-field
// "volumeCoverage" of its Edition, so revision history lands on the Edition.
const recordRef = v.union(
  v.object({ type: v.literal("publisher"), id: v.id("publishers") }),
  v.object({ type: v.literal("seriesFamily"), id: v.id("seriesFamilies") }),
  v.object({ type: v.literal("series"), id: v.id("series") }),
  v.object({ type: v.literal("volume"), id: v.id("volumes") }),
  v.object({ type: v.literal("editionLine"), id: v.id("editionLines") }),
  v.object({ type: v.literal("edition"), id: v.id("editions") }),
  v.object({ type: v.literal("release"), id: v.id("releases") }),
  v.object({ type: v.literal("releaseVariant"), id: v.id("releaseVariants") }),
  v.object({ type: v.literal("releaseBundle"), id: v.id("releaseBundles") }),
);

// Human authors record their role at authorship; promotions never rewrite it (#14).
const authorRef = v.union(
  v.object({
    kind: v.literal("user"),
    userId: v.id("users"),
    roleAtAuthorship: v.optional(dataRole),
  }),
  v.object({ kind: v.literal("source"), sourceKey: v.string() }),
);

const fieldChange = v.object({
  field: v.string(),
  before: v.any(),
  after: v.any(),
});

// One coherent atomic intent (#14): approval applies every op in a single
// mutation. `tempId` lets one proposal create a Volume, its Edition, and
// coverage together, with later ops referencing the not-yet-created records.
// `baseRevisionId` is the staleness anchor; absent only for records that
// predate revision history.
const proposalOp = v.union(
  v.object({
    kind: v.literal("create"),
    table: v.string(),
    tempId: v.string(),
    fields: v.any(),
  }),
  v.object({
    kind: v.literal("update"),
    ref: recordRef,
    baseRevisionId: v.optional(v.id("revisions")),
    changes: v.array(fieldChange),
  }),
  v.object({
    kind: v.literal("merge"),
    survivor: recordRef,
    merged: recordRef,
    baseRevisionIds: v.array(v.id("revisions")),
  }),
  v.object({
    kind: v.literal("split"),
    ref: recordRef,
    baseRevisionId: v.optional(v.id("revisions")),
    details: v.any(),
  }),
  v.object({
    kind: v.literal("hide"),
    ref: recordRef,
    baseRevisionId: v.optional(v.id("revisions")),
  }),
  v.object({
    kind: v.literal("restore"),
    ref: recordRef,
    baseRevisionId: v.optional(v.id("revisions")),
  }),
  v.object({
    kind: v.literal("clearOverride"),
    ref: recordRef,
    field: v.string(),
    baseRevisionId: v.optional(v.id("revisions")),
  }),
  v.object({ kind: v.literal("lock"), ref: recordRef }),
  v.object({ kind: v.literal("unlock"), ref: recordRef }),
);

const evidence = v.union(
  v.object({
    kind: v.literal("observation"),
    observationId: v.id("sourceObservations"),
  }),
  v.object({ kind: v.literal("url"), url: v.string(), note: v.optional(v.string()) }),
  v.object({ kind: v.literal("note"), text: v.string() }),
);

// Envelope shared by canonical catalog tables. Merged docs keep their publicId
// and point at the winner, so losing-ID URLs resolve to permanent 301s without
// a redirects table. Hidden and merged records are locked against ordinary
// edits in code (#14). `overriddenFields` is the sticky Human Override set
// (#13); its audit trail lives in Revisions.
const canonical = <Table extends string>(table: Table) => ({
  status: v.union(v.literal("active"), v.literal("hidden"), v.literal("merged")),
  mergedIntoId: v.optional(v.id(table)),
  locked: v.optional(v.boolean()),
  bootstrapUnreviewed: v.optional(v.boolean()),
  overriddenFields: v.optional(v.array(v.string())),
});

export default defineSchema({
  // ---------- catalog ----------

  publishers: defineTable({
    ...canonical("publishers"),
    name: v.string(),
    // Publishers are the slug-only URL exception (#19); renames 301 via
    // publisherSlugRedirects.
    slug: v.string(),
    description: v.optional(v.string()),
  }).index("by_slug", ["slug"]),

  publisherSlugRedirects: defineTable({
    fromSlug: v.string(),
    publisherId: v.id("publishers"),
  }).index("by_fromSlug", ["fromSlug"]),

  seriesFamilies: defineTable({
    ...canonical("seriesFamilies"),
    name: v.string(),
  }),

  series: defineTable({
    ...canonical("series"),
    publicId: v.number(),
    title: v.string(),
    altTitles: v.array(v.string()),
    // title + altTitles concatenated on write; search indexes take one field.
    searchText: v.string(),
    familyId: v.optional(v.id("seriesFamilies")),
    sourceStatus: v.optional(
      v.union(
        v.literal("ongoing"),
        v.literal("completed"),
        v.literal("hiatus"),
        v.literal("cancelled"),
      ),
    ),
  })
    .index("by_publicId", ["publicId"])
    .index("by_family", ["familyId"])
    .index("by_bootstrap", ["bootstrapUnreviewed"])
    .searchIndex("search_title", { searchField: "searchText" }),

  // Stored once per edge, read as "from is a {type} of to"; the reverse
  // direction is rendered, never stored.
  seriesRelationships: defineTable({
    fromSeriesId: v.id("series"),
    toSeriesId: v.id("series"),
    type: v.union(
      v.literal("sequel"),
      v.literal("prequel"),
      v.literal("spinoff"),
      v.literal("reboot"),
      v.literal("sideStory"),
      v.literal("other"),
    ),
    note: v.optional(v.string()),
  })
    .index("by_from", ["fromSeriesId"])
    .index("by_to", ["toSeriesId"]),

  volumes: defineTable({
    ...canonical("volumes"),
    publicId: v.number(),
    seriesId: v.id("series"),
    // Hidden consecutive ordinal for the canonical reading sequence.
    position: v.number(),
    // Publisher-facing designation ("7.5", "Side Story"); absent for oneshots.
    label: v.optional(v.string()),
    synopsis: v.optional(v.string()),
  })
    .index("by_publicId", ["publicId"])
    .index("by_series", ["seriesId", "position"])
    .index("by_bootstrap", ["bootstrapUnreviewed"]),

  editionLines: defineTable({
    ...canonical("editionLines"),
    seriesId: v.id("series"),
    publisherId: v.id("publishers"),
    name: v.string(),
  }).index("by_series", ["seriesId"]),

  // Editions have no stored name; page titles derive from series + line +
  // position + publisher. Slugs for all catalog URLs are computed from
  // current titles at request time, never stored.
  editions: defineTable({
    ...canonical("editions"),
    publicId: v.number(),
    publisherId: v.id("publishers"),
    editionLineId: v.optional(v.id("editionLines")),
    // "Omnibus 1" — a label, never a sort key.
    linePosition: v.optional(v.string()),
  })
    .index("by_publicId", ["publicId"])
    .index("by_line", ["editionLineId"])
    .index("by_publisher", ["publisherId"])
    .index("by_bootstrap", ["bootstrapUnreviewed"]),

  volumeCoverages: defineTable({
    editionId: v.id("editions"),
    volumeId: v.id("volumes"),
    order: v.number(),
    extent: v.union(v.literal("complete"), v.literal("partial")),
    // Optional chapter/page description (#6) — descriptive, not modeled.
    note: v.optional(v.string()),
  })
    .index("by_edition", ["editionId", "order"])
    .index("by_volume", ["volumeId"]),

  // Releases have no public ID: they are anchors on their Edition's page,
  // addressed by ISBN when present, else by document ID.
  releases: defineTable({
    ...canonical("releases"),
    editionId: v.id("editions"),
    format: v.union(v.literal("physical"), v.literal("digital")),
    binding: v.optional(v.string()),
    language: v.string(),
    isbn13: v.optional(v.string()),
    isbn10: v.optional(v.string()),
    pubDate: v.optional(partialDate),
    price: v.optional(money),
    // Release Description: publisher blurb, imported per-ISBN.
    description: v.optional(v.string()),
    coverImage: v.optional(cover),
    // Denormalized from the Edition and its coverage for the browser/calendar;
    // maintained exclusively by the shared edition/coverage write helpers.
    publisherId: v.id("publishers"),
    seriesIds: v.array(v.id("series")),
  })
    .index("by_edition", ["editionId"])
    .index("by_isbn13", ["isbn13"])
    .index("by_isbn10", ["isbn10"])
    .index("by_date", ["pubDate.sort"])
    .index("by_publisher_date", ["publisherId", "pubDate.sort"])
    .index("by_bootstrap", ["bootstrapUnreviewed"]),

  releaseVariants: defineTable({
    ...canonical("releaseVariants"),
    releaseId: v.id("releases"),
    name: v.string(),
    coverImage: v.optional(cover),
  }).index("by_release", ["releaseId"]),

  releaseBundles: defineTable({
    ...canonical("releaseBundles"),
    publicId: v.number(),
    name: v.string(),
    publisherId: v.id("publishers"),
    format: v.optional(v.union(v.literal("physical"), v.literal("digital"))),
    isbn13: v.optional(v.string()),
    isbn10: v.optional(v.string()),
    pubDate: v.optional(partialDate),
    price: v.optional(money),
    description: v.optional(v.string()),
    coverImage: v.optional(cover),
  })
    .index("by_publicId", ["publicId"])
    .index("by_isbn13", ["isbn13"])
    .index("by_date", ["pubDate.sort"])
    .index("by_bootstrap", ["bootstrapUnreviewed"]),

  bundleMemberships: defineTable({
    bundleId: v.id("releaseBundles"),
    releaseId: v.id("releases"),
    // Bundle-specified variant of the member, when the box set includes one.
    variantId: v.optional(v.id("releaseVariants")),
    order: v.number(),
  })
    .index("by_bundle", ["bundleId", "order"])
    .index("by_release", ["releaseId"]),

  // ---------- provenance & moderation ----------

  // The approved-source registry is data, not code (#13).
  approvedSources: defineTable({
    key: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    scope: v.string(),
    fieldAuthority: v.record(
      v.string(),
      v.union(v.literal("authoritative"), v.literal("standard"), v.literal("weak")),
    ),
    cadence: v.string(),
    attribution: v.optional(v.string()),
    healthState: v.union(v.literal("healthy"), v.literal("unhealthy")),
    consecutiveFailures: v.number(),
  }).index("by_key", ["key"]),

  // Identity = (source, source-record-id). `snapshot` is the latest normalized
  // form — what reconciliation reads; prior snapshots are retained append-only
  // in observationSnapshots. Retention is indefinite in v1.
  sourceObservations: defineTable({
    sourceKey: v.string(),
    sourceRecordId: v.string(),
    // Linked once matched (matching-ladder rung 1); a rename at the source is
    // then a field conflict, never a failed match.
    recordRef: v.optional(recordRef),
    snapshot: v.any(),
    lastSeenAt: v.number(),
    withdrawn: v.boolean(),
  })
    .index("by_source_record", ["sourceKey", "sourceRecordId"])
    .index("by_record", ["recordRef.type", "recordRef.id"]),

  observationSnapshots: defineTable({
    observationId: v.id("sourceObservations"),
    snapshot: v.any(),
    supersededAt: v.number(),
  }).index("by_observation", ["observationId", "supersededAt"]),

  proposals: defineTable({
    author: authorRef,
    state: v.union(
      v.literal("draft"),
      v.literal("inReview"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("withdrawn"),
    ),
    currentVersionNo: v.number(),
    // Set when any affected record's base Revision changes before approval;
    // a stale proposal must return to Draft and be rebased (#14).
    stale: v.optional(v.boolean()),
    claimedBy: v.optional(v.id("users")),
    submittedAt: v.optional(v.number()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    // Lineage link when resubmitting rejected work as a new Proposal.
    resubmittedFromId: v.optional(v.id("proposals")),
  }).index("by_state", ["state", "submittedAt"]),

  // Immutable once submitted; Request Changes yields a new version (#14).
  proposalVersions: defineTable({
    proposalId: v.id("proposals"),
    versionNo: v.number(),
    ops: v.array(proposalOp),
    evidence: v.array(evidence),
    changeComment: v.string(),
    warningsAcknowledged: v.optional(v.array(v.string())),
  }).index("by_proposal", ["proposalId", "versionNo"]),

  // One immutable public Revision per affected record per approval.
  revisions: defineTable({
    ref: recordRef,
    seq: v.number(),
    proposalId: v.id("proposals"),
    author: authorRef,
    // Absent for auto-approved high-confidence imports (system-approved).
    approvedBy: v.optional(v.id("users")),
    changes: v.array(fieldChange),
    comment: v.string(),
    // Source citation for importer-authored Revisions (#13, ANN attribution).
    citation: v.optional(v.object({ sourceName: v.string(), url: v.string() })),
  }).index("by_record", ["ref.type", "ref.id", "seq"]),

  // Rejected import conflicts, keyed exactly as #13 specifies; suppression
  // lifts when the source offers a different value, the observation is
  // withdrawn, or registry rules change.
  conflictSuppressions: defineTable({
    ref: recordRef,
    field: v.string(),
    sourceKey: v.string(),
    valueHash: v.string(),
  }).index("by_key", ["ref.type", "ref.id", "field", "sourceKey", "valueHash"]),

  importRuns: defineTable({
    sourceKey: v.string(),
    status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed")),
    finishedAt: v.optional(v.number()),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
  }).index("by_source", ["sourceKey"]),

  roleAudit: defineTable({
    userId: v.id("users"),
    action: v.union(
      v.literal("appointed"),
      v.literal("revoked"),
      v.literal("suspended"),
      v.literal("reinstated"),
    ),
    role: dataRole,
    actorId: v.id("users"),
    reason: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  // Sequential public-ID allocation per entity type ("series", "volume",
  // "edition", "bundle"). Imports reserve blocks in one bump; gaps are fine.
  counters: defineTable({
    entity: v.string(),
    next: v.number(),
  }).index("by_entity", ["entity"]),

  // Singleton. Bootstrap Mode (#15) is switched off permanently before launch.
  appConfig: defineTable({
    bootstrapMode: v.boolean(),
  }),

  // ---------- users & personal tracking ----------

  users: defineTable({
    // Stable Clerk JWT subject (#10) — identity link is never by email.
    clerkSubject: v.string(),
    // Required at first sign-in; unique case-insensitively via the normalized
    // copy; changeable with immediate release; reserved names checked in code.
    username: v.string(),
    usernameNormalized: v.string(),
    role: v.optional(dataRole),
    suspended: v.optional(v.boolean()),
    formatPreference: v.union(
      v.literal("physical"),
      v.literal("digital"),
      v.literal("both"),
    ),
    // Private by default (#7); per-Series overrides live on userSeriesStates.
    ownershipVisibility: visibility,
    readingVisibility: visibility,
  })
    .index("by_clerkSubject", ["clerkSubject"])
    .index("by_username", ["usernameNormalized"]),

  // Exactly one of releaseId/bundleId is set (enforced in mutations — the
  // two-optional-fields shape keeps both sides indexable). One entry per
  // (user, target); Derived Ownership is computed at read time, never stored.
  collectionEntries: defineTable({
    userId: v.id("users"),
    releaseId: v.optional(v.id("releases")),
    bundleId: v.optional(v.id("releaseBundles")),
    state: v.union(v.literal("wanted"), v.literal("ordered"), v.literal("owned")),
    variantId: v.optional(v.id("releaseVariants")),
  })
    .index("by_user", ["userId"])
    .index("by_user_release", ["userId", "releaseId"])
    .index("by_user_bundle", ["userId", "bundleId"]),

  // One row per (user, series) combining every per-series fact; a row exists
  // once the user touches the series in any way.
  userSeriesStates: defineTable({
    userId: v.id("users"),
    seriesId: v.id("series"),
    readingStatus: v.optional(
      v.union(
        v.literal("planToRead"),
        v.literal("reading"),
        v.literal("paused"),
        v.literal("dropped"),
        v.literal("completed"),
      ),
    ),
    following: v.boolean(),
    // One non-blocking follow prompt per series (#7); dismissal is permanent.
    followPromptDismissed: v.boolean(),
    ownershipVisibility: v.optional(visibility),
    readingVisibility: v.optional(visibility),
  }).index("by_user_series", ["userId", "seriesId"]),

  // An active reading pass; at most one per (user, release). Confirmed
  // completion increments volumeProgress for completely covered Volumes and
  // removes this row.
  releaseProgress: defineTable({
    userId: v.id("users"),
    releaseId: v.id("releases"),
    seriesId: v.id("series"),
    percent: v.optional(v.number()),
  })
    .index("by_user_release", ["userId", "releaseId"])
    .index("by_user_series", ["userId", "seriesId"]),

  volumeProgress: defineTable({
    userId: v.id("users"),
    volumeId: v.id("volumes"),
    seriesId: v.id("series"),
    readCount: v.number(),
    // Supports undoing the most recent completion (#7).
    lastCompletedAt: v.optional(v.number()),
  })
    .index("by_user_volume", ["userId", "volumeId"])
    .index("by_user_series", ["userId", "seriesId"]),
});
