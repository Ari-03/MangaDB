// MangaDB Convex schema.
//
// Open vocabularies (language codes, binding, currency, reserved usernames)
// are validated in mutations against code-level constant lists, not schema
// literals, so extending them is never a schema event. Structural invariants
// the schema can't express (exactly-one-of, "note required when type=other",
// binding only on physical) are enforced at submission/approval.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { scoreFormatValidator } from "./lib/scoreFormat";

// ---------- shared validators ----------

// Partial-precision publication date. `sort` is yyyymmdd with zeroed
// unknown parts (20260800 = "Aug 2026"), giving one indexable key for the
// calendar, month pages, and upcoming queries; month grouping is a prefix range.
export const partialDate = v.object({
  year: v.number(),
  month: v.optional(v.number()),
  day: v.optional(v.number()),
  sort: v.number(),
});

export const money = v.object({
  amountCents: v.number(),
  currency: v.string(),
});

export const cover = v.object({
  // Absent when the source's art at `sourceUrl` was a placeholder: the URL is
  // remembered so it is not fetched again until it changes (lib/covers.ts).
  storageId: v.optional(v.id("_storage")),
  sourceUrl: v.optional(v.string()),
  attribution: v.optional(v.string()),
});

const visibility = v.union(v.literal("public"), v.literal("private"));

export const releaseFormat = v.union(v.literal("physical"), v.literal("digital"));

// A Series' publication status as its sources report it.
const sourceStatus = v.union(
  v.literal("ongoing"),
  v.literal("completed"),
  v.literal("hiatus"),
  v.literal("cancelled"),
);
// The library's copy, where a Series no source has reported reads "unknown".
const browseSourceStatus = v.union(...sourceStatus.members, v.literal("unknown"));

// A Comment's moderation state (comments.ts): published, held for a
// Moderator, hidden (by Moderators or 3 reports), removed (by its author
// or a Moderator; the row stays for audit until the author's account purge),
// or shadowed (its author is a Shadowed User: published-looking to them,
// invisible to everyone else; unshadowing turns it back into approved).
export const commentStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("hidden"),
  v.literal("removed"),
  v.literal("shadowed"),
);

export const commentReportReason = v.union(
  v.literal("spam"),
  v.literal("harassment"),
  v.literal("spoiler"),
  v.literal("offTopic"),
  v.literal("other"),
);

// A Review's moderation state (reviews.ts mirrors it).
export const reviewStatus = v.union(v.literal("visible"), v.literal("hidden"));

export const dataRole = v.union(
  v.literal("editor"),
  v.literal("moderator"),
  v.literal("administrator"),
);

// A Series credit's role (people.ts ROLE_ORDER): "author" is the role-less
// credit ("By") a publisher gives when it names someone without a task.
const creditRole = v.union(
  v.literal("story_art"),
  v.literal("story"),
  v.literal("art"),
  v.literal("original"),
  v.literal("author"),
);

// The canonical record types, as `recordRef` below names them.
export const recordType = v.union(
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

// Discriminated reference to any canonical record. Observations, proposals,
// revisions, and suppressions all target one of these. Volume-coverage rows
// are deliberately absent: coverage is edited as the pseudo-field
// "volumeCoverage" of its Edition, so revision history lands on the Edition.
export const recordRef = v.union(
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

// Why an import holds a book it could not place (a Held Book, CONTEXT.md).
// The reason itself is the observation's `placement` note.
export const holdKind = v.union(
  // The Volume it names does not exist under a known Series and Publisher.
  v.literal("volumeMissing"),
  // Packaging whose covered Volumes no source states, or states as a list
  // no range holds, or a line member or box set that steady state leaves
  // to an Editor.
  v.literal("packaging"),
  // No unique active Series to place it under: hidden, ambiguous, locked, or
  // not linked.
  v.literal("series"),
  // Its ISBN is already held elsewhere, or its Volume already has the
  // publisher's Release in that format.
  v.literal("isbn"),
  // Anything else a person could act on: ANN names no distributor, or one
  // with no publisher row.
  v.literal("other"),
);

// Human authors record their role at authorship; promotions never rewrite it.
const authorRef = v.union(
  v.object({
    kind: v.literal("user"),
    userId: v.id("users"),
    roleAtAuthorship: v.optional(dataRole),
  }),
  v.object({ kind: v.literal("source"), sourceKey: v.string() }),
);

// `before`/`after` are optional because "absent" is a real value: setting a
// previously empty field has no `before`, clearing one has no `after`.
const fieldChange = v.object({
  field: v.string(),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
});

// One coherent atomic intent: approval applies every op in a single
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

// Exported for the proposal write path (proposals.ts), which accepts and
// stores evidence rows.
export const evidence = v.union(
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
// edits in code. `overriddenFields` is the sticky Human Override set;
// its audit trail lives in Revisions.
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
    // Publishers are the slug-only URL exception; renames 301 via
    // publisherSlugRedirects.
    slug: v.string(),
    description: v.optional(v.string()),
    // An imprint names its parent company ("Ghost Ship" → Seven Seas); one
    // level deep — a parent never has a parent itself. Duplicate strings for
    // one company are merged instead (lib/publishers.ts).
    parentPublisherId: v.optional(v.id("publishers")),
    // No longer publishing English manga (ADV, Tokyopop's Blu, CMX, …):
    // their books stay in the catalog; the flag is display/reporting data.
    defunct: v.optional(v.boolean()),
    // "mature": every book this publisher or imprint issues is for adults
    // (FAKKU, 801 Media, Ghost Ship), so each of its Series is a Mature
    // Series (lib/mature.ts). Set by the Data Team as an ordinary field.
    contentRating: v.optional(v.literal("mature")),
  })
    .index("by_slug", ["slug"])
    .index("by_parent", ["parentPublisherId"]),

  // Series browse (the /series library): one denormalized row per active
  // Series, rebuilt on a schedule by seriesBrowse.rebuild so the browse
  // page can sort and page by index without touching the import write
  // paths. Everything here is derived; the canonical records stay the
  // source of truth. Numbers are yyyymmdd sort keys like releases.pubDate.
  seriesStats: defineTable({
    seriesId: v.id("series"),
    publicId: v.number(),
    title: v.string(),
    // Lower-cased, leading article dropped, so "The Apothecary Diaries"
    // shelves under A.
    titleSort: v.string(),
    // "a".."z" or "#" for titles that start with a digit or symbol.
    letter: v.string(),
    sourceStatus: browseSourceStatus,
    publishers: v.array(v.object({ name: v.string(), slug: v.string() })),
    hasPhysical: v.boolean(),
    hasDigital: v.boolean(),
    volumeCount: v.number(),
    releaseCount: v.number(),
    firstReleaseSort: v.number(),
    latestReleaseSort: v.number(),
    // Earliest future release, or 0 when nothing is announced.
    nextReleaseSort: v.number(),
    // Most recent release already out, or 0 when none is. Optional only
    // until every row has been rebuilt; readers fall back to latestReleaseSort.
    lastReleasedSort: v.optional(v.number()),
    // Title and alt titles as lower-cased, accent-free words joined by
    // spaces, for the library's in-memory title filter. Optional like
    // lastReleasedSort; readers fall back to titleSort.
    searchKey: v.optional(v.string()),
    // Series Follows and distinct users with a Collection Entry on any of
    // its Releases: the popularity signals the catalog actually has.
    followers: v.number(),
    collectors: v.number(),
    coverUrl: v.union(v.string(), v.null()),
    // The ISBNs the jacket is looked up by, best first (lib/covers.ts
    // seriesCoverIsbns), and the first of them. Optional only until every
    // row has been rebuilt; readers fall back to coverIsbn (statsCoverIsbns).
    coverIsbn: v.union(v.string(), v.null()),
    coverIsbns: v.optional(v.array(v.string())),
    // Copied from series.mature, so the library can leave Mature Series out.
    mature: v.optional(v.literal(true)),
    // Copied from the Series' ratingStats row by the rebuild and, at once, by
    // every rating write (lib/ratings.ts), on the 1-100 score scale.
    // `ratingRank` is the average once RATING_RANK_MIN ratings are in and 0
    // before, so "Top rated" sorts the thinly rated last. Optional only until
    // every row has been rebuilt.
    ratingAverage: v.optional(v.number()),
    ratingCount: v.optional(v.number()),
    ratingRank: v.optional(v.number()),
    rebuiltAt: v.number(),
  })
    .index("by_series", ["seriesId"])
    .index("by_publicId", ["publicId"])
    .index("by_title", ["titleSort", "publicId"])
    .index("by_volumes", ["volumeCount", "publicId"])
    .index("by_latest", ["latestReleaseSort", "publicId"])
    .index("by_next", ["nextReleaseSort", "publicId"])
    .index("by_followers", ["followers", "publicId"])
    .index("by_collectors", ["collectors", "publicId"])
    .index("by_rating", ["ratingRank", "publicId"])
    .index("by_rebuiltAt", ["rebuiltAt"]),

  // Authors (people.ts): the creators credited on each Series, derived by
  // `people.rebuild` from the stored ANN manga observations and, for Series
  // ANN does not credit, the publishers' release observations, like
  // seriesStats. ANN's person id is the identity when there is one, so one
  // author keeps one row across entries and spellings; a person only a
  // publisher names has no `annId` and is matched by `nameKey`.
  // `seriesCount` (Series they wrote or drew), `originalCount` (Series they
  // are only the original creator of), and the jacket (their biggest
  // Series') are derived for the Authors tab.
  people: defineTable({
    publicId: v.number(),
    name: v.string(),
    // Absent for a person only a publisher names; ANN adopts the row (sets
    // this) when it later credits someone of the same `nameKey`.
    annId: v.optional(v.string()),
    // people.ts nameKey(name): the folded key (case, accents, punctuation,
    // long vowels, Kunrei/Hepburn spellings, word order and spacing) that
    // finds a name's candidate people; people.ts matchPerson then prefers
    // an exact spelling. The rebuild's first phase rewrites a key an older
    // rule left; optional only for rows from before keys existed.
    nameKey: v.optional(v.string()),
    seriesCount: v.number(),
    // Optional only until the first rebuild after it arrived; readers read 0.
    originalCount: v.optional(v.number()),
    coverUrl: v.union(v.string(), v.null()),
    coverIsbn: v.union(v.string(), v.null()),
    // Every visible Series they are credited on is a Mature Series, so
    // they stay off the Authors tab and out of search for anyone who has
    // not opted in. The jacket above never comes from a Mature Series
    // while they have another.
    matureOnly: v.optional(v.literal(true)),
    // Name-only people: the rebuild that found them credited nowhere.
    // The next successful rebuild deletes them if still uncredited (so one
    // run's loss is never final), and clears this once they are credited.
    creditlessSince: v.optional(v.number()),
  })
    .index("by_publicId", ["publicId"])
    .index("by_annId", ["annId"])
    .index("by_nameKey", ["nameKey"])
    .index("by_seriesCount", ["seriesCount"])
    .searchIndex("search_name", { searchField: "name" }),

  // One Series–author–role link, from ANN's staff tasks (people.ts roleFor)
  // or, for a Series ANN does not credit, a publisher's creator names.
  // "author" is the role-less credit ("By"): a publisher named the person
  // without saying what they did.
  seriesCredits: defineTable({
    seriesId: v.id("series"),
    personId: v.id("people"),
    role: creditRole,
    // Which publisher fallback wrote the row: "prh" for PRH's parsed author
    // line, "creators" for Kodansha's and Seven Seas' role-less creator
    // lists (used only where PRH credits nothing). Absent for rows derived
    // from ANN.
    source: v.optional(v.union(v.literal("prh"), v.literal("creators"))),
    // Publisher rows only: the role the observations of the rebuild that
    // last stamped the row gave it. `role` may show a fuller role from an
    // earlier run until that rebuild settles (people.ts settleRoles), so a
    // role the run has yet to reach doesn't flicker away and back.
    runRole: v.optional(creditRole),
    // PRH rows only: the names this rebuild's observations gave this credit,
    // one per spelling key, near spellings of one name among them ("Choe
    // Gyu-Seok", "Choi Gyu-Seok"), each with its roles, how many
    // observations named it, and the latest of those observations'
    // lastSeenAt. Names, not people: a spelling that loses never needs a
    // person. `settleRoles` decides each Series from these. A handful at most.
    runNames: v.optional(
      v.array(
        v.object({ name: v.string(), role: creditRole, count: v.number(), seenAt: v.number() }),
      ),
    ),
    // PRH rows only: pairs of spelling keys ("a|b") one line of this
    // rebuild named together, so settle keeps them two people. A line names
    // a handful of people, so a Series has a few pairs.
    runApart: v.optional(v.array(v.string())),
    // Superseded by runNames; left by a staging rehearsal of the previous
    // rule and cleared from each row the next time a rebuild stamps it.
    runVariants: v.optional(
      v.array(v.object({ personId: v.id("people"), count: v.number(), seenAt: v.number() })),
    ),
    rebuiltAt: v.number(),
  })
    .index("by_series", ["seriesId"])
    .index("by_person", ["personId"])
    .index("by_rebuiltAt", ["rebuiltAt"])
    // The sweep of ANN's rows alone, when a rebuild's publisher pass failed.
    .index("by_source_and_rebuiltAt", ["source", "rebuiltAt"]),

  // The Publishers board precomputed (publisher.ts rebuildBoards): monthBoard's
  // result for each month in the rolling window, as JSON, so paging months is
  // one document read. `month` is yyyymm; a payload is tens of KB. Each month
  // is stored twice: with Mature Series (`mature: true`) and without (absent).
  publisherBoards: defineTable({
    month: v.number(),
    mature: v.optional(v.literal(true)),
    // publisher.ts BOARD_VERSION when written; another version is ignored.
    version: v.number(),
    payload: v.string(),
    builtAt: v.number(),
  }).index("by_month_and_mature", ["month", "mature"]),

  // The library's filter-and-sort facts for every Series, packed many to a
  // document so a filtered view reads a handful of documents instead of one
  // per Series (seriesBrowse.browse). Block k holds the Series with
  // publicId in [k * PACK_SPAN, (k + 1) * PACK_SPAN), so a Series is always
  // in exactly one pack. Rewritten from seriesStats at the end of each
  // rebuild, and read only once appConfig.seriesPacksReady says a complete
  // set exists; an entry is a few hundred bytes, a pack well under 1 MB.
  seriesStatsPacks: defineTable({
    block: v.number(),
    entries: v.array(
      v.object({
        publicId: v.number(),
        titleSort: v.string(),
        searchKey: v.string(),
        sourceStatus: browseSourceStatus,
        publishers: v.array(v.object({ name: v.string(), slug: v.string() })),
        hasPhysical: v.boolean(),
        hasDigital: v.boolean(),
        volumeCount: v.number(),
        latestReleaseSort: v.number(),
        nextReleaseSort: v.number(),
        lastReleasedSort: v.number(),
        followers: v.number(),
        collectors: v.number(),
        // As on seriesStats; optional until every pack has been rewritten.
        ratingRank: v.optional(v.number()),
        mature: v.optional(v.literal(true)),
      }),
    ),
  }).index("by_block", ["block"]),

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
    // What the Series is about, shown under its title; absent until a source
    // or an Editor supplies one.
    synopsis: v.optional(v.string()),
    sourceStatus: v.optional(sourceStatus),
    // Bookless Series (CONTEXT.md): active, but no Edition covers any of its
    // Volumes and no Edition Line member exists — a backbone a source built
    // whose books never attached. Derived by the Series library rebuild
    // (seriesBrowse.upsertStats), which also clears it the moment a book
    // lands. Public discovery (browse, search, home, sitemap) skips it; the
    // page stays reachable by URL; the Data Team reviews it (/mod/packaging).
    bookless: v.optional(v.literal(true)),
    // The Data Team's call on whether this is a Mature Series (CONTEXT.md):
    // "mature" or "general" wins over every source; absent follows them.
    contentRating: v.optional(v.union(v.literal("mature"), v.literal("general"))),
    // Mature Series (CONTEXT.md): rated 18+ by a source, published by an
    // adult-only publisher, or so rated above. Derived by the Series library
    // rebuild (lib/mature.ts); public discovery leaves it out for anyone who
    // has not opted in, and its pages hide their cover art.
    mature: v.optional(v.literal(true)),
  })
    .index("by_publicId", ["publicId"])
    .index("by_family", ["familyId"])
    .index("by_bootstrap", ["bootstrapUnreviewed"])
    .index("by_bookless", ["bookless"])
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
    // Sort key of the canonical reading sequence: the volume number itself
    // for numbered Volumes (so a gap shows a missing Volume; fractional and
    // 0 allowed), appended after the last one for unnumbered Volumes.
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
    // Unmapped Packaging (CONTEXT.md): an Edition Line member whose source
    // never stated which Volumes it collects. It has no volumeCoverages
    // rows and shows under its line in the publisher's own numbering until
    // a Moderator maps it (moderation.mapEditionCoverage clears the flag).
    coverageUnmapped: v.optional(v.literal(true)),
  })
    .index("by_publicId", ["publicId"])
    .index("by_line", ["editionLineId"])
    .index("by_publisher", ["publisherId"])
    .index("by_bootstrap", ["bootstrapUnreviewed"])
    .index("by_coverageUnmapped", ["coverageUnmapped"]),

  volumeCoverages: defineTable({
    editionId: v.id("editions"),
    volumeId: v.id("volumes"),
    order: v.number(),
    extent: v.union(v.literal("complete"), v.literal("partial")),
    // Optional chapter/page description — descriptive, not modeled.
    note: v.optional(v.string()),
  })
    .index("by_edition", ["editionId", "order"])
    .index("by_volume", ["volumeId"]),

  // Releases have no public ID: they are anchors on their Edition's page,
  // addressed by ISBN when present, else by document ID.
  releases: defineTable({
    ...canonical("releases"),
    editionId: v.id("editions"),
    format: releaseFormat,
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
    .index("by_bootstrap", ["bootstrapUnreviewed"])
    // Who shows a stored cover, so replacing one never strands a sharer.
    .index("by_cover", ["coverImage.storageId"]),

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
    format: v.optional(releaseFormat),
    isbn13: v.optional(v.string()),
    isbn10: v.optional(v.string()),
    pubDate: v.optional(partialDate),
    price: v.optional(money),
    description: v.optional(v.string()),
    coverImage: v.optional(cover),
  })
    .index("by_publicId", ["publicId"])
    .index("by_isbn13", ["isbn13"])
    .index("by_isbn10", ["isbn10"])
    .index("by_bootstrap", ["bootstrapUnreviewed"])
    .index("by_cover", ["coverImage.storageId"]),

  bundleMemberships: defineTable({
    bundleId: v.id("releaseBundles"),
    releaseId: v.id("releases"),
    // Bundle-specified variant of the member, when the box set includes one.
    variantId: v.optional(v.id("releaseVariants")),
    order: v.number(),
  })
    .index("by_bundle", ["bundleId", "order"])
    .index("by_release", ["releaseId"])
    // Variant merges and their previews find pins by the variant alone.
    .index("by_variantId", ["variantId"]),

  // ---------- provenance & moderation ----------

  // The approved-source registry is data, not code.
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
    // Lower-authority disagreements live here, on the observation only
    // (spec §6 conflict rules) — one entry per field, latest offer wins.
    conflicts: v.optional(
      v.array(
        v.object({
          field: v.string(),
          offered: v.any(),
          at: v.number(),
          reason: v.string(),
        }),
      ),
    ),
    // The Proposal this observation most recently queued (a flagged match
    // review, a steady-state creation gate, or an authority conflict) —
    // reconciliation's dedup anchor: one open queue item per observation,
    // and a rejected one never re-queues until the snapshot changes.
    queuedProposalId: v.optional(v.id("proposals")),
  })
    .index("by_source_record", ["sourceKey", "sourceRecordId"])
    .index("by_record", ["recordRef.type", "recordRef.id"])
    // For the post-sweep withdrawal pass: records a completed full listing
    // sweep did not touch have disappeared at the source (retained,
    // never deleted; absence is never evidence).
    .index("by_source_seen", ["sourceKey", "lastSeenAt"]),

  // Held Books (CONTEXT.md): one row per unlinked, non-withdrawn
  // observation with no queued Proposal that an import holds
  // (lib/observations.ts recordUnplaced), removed when it is linked,
  // withdrawn, or queued for review. A table of its own, so the list
  // has small indexes and adding them never backfills sourceObservations.
  placementHolds: defineTable({
    observationId: v.id("sourceObservations"),
    sourceKey: v.string(),
    kind: holdKind,
    // When it was first held under this kind; a re-sighting keeps it.
    heldAt: v.number(),
    // The active Series the import resolved for it, when it found one.
    seriesId: v.optional(v.id("series")),
  })
    .index("by_observation", ["observationId"])
    .index("by_held", ["heldAt"])
    .index("by_kind_held", ["kind", "heldAt"])
    .index("by_source_held", ["sourceKey", "heldAt"])
    .index("by_source_kind_held", ["sourceKey", "kind", "heldAt"]),

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
    // Number of immutable versions submitted so far; 0 for a never-submitted
    // Draft. `currentVersionNo` names the version under review once submitted.
    currentVersionNo: v.number(),
    // Set when any affected record's base Revision changes before approval;
    // a stale proposal must return to Draft and be rebased.
    stale: v.optional(v.boolean()),
    claimedBy: v.optional(v.id("users")),
    submittedAt: v.optional(v.number()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    // Lineage link when resubmitting rejected work as a new Proposal.
    resubmittedFromId: v.optional(v.id("proposals")),
    // The mutable working copy while in Draft. Submission freezes it
    // into an immutable proposalVersions row and clears it; Request Changes
    // and rebase seed it back from the last submitted version.
    draft: v.optional(
      v.object({
        ops: v.array(proposalOp),
        evidence: v.array(evidence),
        comment: v.string(),
      }),
    ),
  })
    .index("by_state", ["state", "submittedAt"])
    .index("by_author", ["author.userId", "state"]),

  // Immutable once submitted; Request Changes yields a new version.
  proposalVersions: defineTable({
    proposalId: v.id("proposals"),
    versionNo: v.number(),
    ops: v.array(proposalOp),
    evidence: v.array(evidence),
    changeComment: v.string(),
    warningsAcknowledged: v.optional(v.array(v.string())),
  }).index("by_proposal", ["proposalId", "versionNo"]),

  // Internal review discussion (private in v1 — Data-Team-only, never
  // public). Decision notes (request-changes reasons, rejections) land here
  // beside free-form comments; the note keeps the version it was made on.
  proposalNotes: defineTable({
    proposalId: v.id("proposals"),
    versionNo: v.number(),
    authorId: v.id("users"),
    kind: v.union(
      v.literal("comment"),
      v.literal("requestChanges"),
      v.literal("reject"),
    ),
    text: v.string(),
  }).index("by_proposal", ["proposalId"]),

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
    // Source citation for importer-authored Revisions (ANN attribution).
    citation: v.optional(v.object({ sourceName: v.string(), url: v.string() })),
  })
    .index("by_record", ["ref.type", "ref.id", "seq"])
    // Launch gate ④: verifying a correction produced public Revisions.
    .index("by_proposal", ["proposalId"]),

  // Rejected import conflicts, keyed by record, field, source and offered
  // value; suppression lifts when the source offers a different value, the
  // observation is withdrawn, or registry rules change.
  conflictSuppressions: defineTable({
    ref: recordRef,
    field: v.string(),
    sourceKey: v.string(),
    valueHash: v.string(),
  }).index("by_key", ["ref.type", "ref.id", "field", "sourceKey", "valueHash"]),

  // What one Merge physically did: every reference it repointed
  // (with the prior value), every duplicate row it deleted, and every row it
  // inserted — exactly what an explicit Split reverses. One manifest per
  // merge; `reversedAt` marks a consumed manifest (a loser merged again later
  // gets a fresh one). The reason/authorship trail lives in Revisions.
  mergeManifests: defineTable({
    loserRef: recordRef,
    survivorRef: recordRef,
    proposalId: v.id("proposals"),
    repointed: v.array(
      v.object({
        table: v.string(),
        docId: v.string(),
        field: v.string(),
        before: v.optional(v.any()),
        after: v.optional(v.any()),
      }),
    ),
    removed: v.array(v.object({ table: v.string(), doc: v.any() })),
    inserted: v.array(v.object({ table: v.string(), docId: v.string() })),
    reversedAt: v.optional(v.number()),
  }).index("by_loser", ["loserRef.type", "loserRef.id"]),

  // The one-time data repair's personal-tracking trail (lib/repair/ops.ts):
  // the personal rows one repair Proposal re-filed, inserted, or folded
  // into another, in bounded chunks (the Proposal's version records only
  // their count). Rows name documents, never their User, and stay off the
  // public Revisions. The repair is never reversed; this is its record.
  repairTrails: defineTable({
    proposalId: v.id("proposals"),
    ref: recordRef,
    rows: v.array(
      v.object({
        table: v.string(),
        docId: v.string(),
        field: v.string(),
        before: v.optional(v.any()),
        after: v.optional(v.any()),
        into: v.optional(v.string()),
      }),
    ),
  }),

  // Where a data-repair entry's sweep of personal rows stands between its
  // bounded legs (lib/repair/ops.ts sweep): one row per sweep, keyed by the
  // plan entry, resuming after the `_creationTime` it reached. All of an
  // entry's rows are deleted once its sweeps finish in one pass.
  repairSweeps: defineTable({
    entryKey: v.string(),
    sweep: v.string(),
    after: v.number(),
    done: v.boolean(),
  }).index("by_entry_sweep", ["entryKey", "sweep"]),

  importRuns: defineTable({
    sourceKey: v.string(),
    // "stopped": an automatic run closed early because its source was
    // disabled. It never counts toward the source's health.
    status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("stopped")),
    // Set on a run a sync opens itself (the cadence dispatcher, or an
    // operator's bare `sync '{}'`): once its source is disabled, it stops at
    // the next link, page, batch or withdrawal boundary (lib/importRuns.ts).
    // An operator's forced run (imports:startRun) lacks it and carries on.
    automatic: v.optional(v.boolean()),
    // Stamped when the run opens, at every gate pass and at every hand-off to
    // a continuation, each storing the counts so far (lib/importRuns.ts).
    // A "running" run quiet for longer than STRANDED_AFTER_MS lost its chain:
    // the hourly tick closes it as "failed" so the source can run again. A
    // run opened before the field has none and counts as stranded only once
    // it is 12 hours old (isStranded).
    lastActivityAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    recordsSeen: v.number(),
    recordsChanged: v.number(),
    errors: v.array(v.string()),
  }).index("by_source", ["sourceKey"]),

  // Append-only forever: every appointment, revocation, suspension, and
  // reinstatement lands here and is never edited or deleted. The initial
  // Administrator is appointed by the operator (roles.bootstrapAdministrator),
  // recorded with the system actor.
  roleAudit: defineTable({
    userId: v.id("users"),
    action: v.union(
      v.literal("appointed"),
      v.literal("revoked"),
      v.literal("suspended"),
      v.literal("reinstated"),
    ),
    role: dataRole,
    actor: v.union(
      v.object({ kind: v.literal("user"), userId: v.id("users") }),
      v.object({ kind: v.literal("system") }),
    ),
    reason: v.optional(v.string()),
  }),

  // Sequential public-ID allocation per entity type ("series", "volume",
  // "edition", "bundle", "person"), one ID per new record (lib/publicIds.ts);
  // gaps are fine.
  counters: defineTable({
    entity: v.string(),
    next: v.number(),
  }).index("by_entity", ["entity"]),

  // Exact active-record totals for the home page, refreshed by the Series
  // library rebuild (seriesBrowse.rebuild); one row.
  catalogCounts: defineTable({
    publishers: v.number(),
    series: v.number(),
    volumes: v.number(),
    editions: v.number(),
    releases: v.number(),
    countedAt: v.number(),
  }),

  // Singleton. Bootstrap Mode is switched off permanently before launch.
  // The launch bookkeeping (spec §7) also lives here: the latest
  // duplicate-sweep summary (QA gate ③) and the Administrator's attestation
  // that the correction loop ran end-to-end for real (launch gate ④).
  appConfig: defineTable({
    bootstrapMode: v.boolean(),
    // Set once the first rebuild has written a complete seriesStatsPacks set;
    // until then the Series library filters from the seriesStats rows.
    seriesPacksReady: v.optional(v.boolean()),
    duplicateSweep: v.optional(
      v.object({
        ranAt: v.number(),
        seriesScanned: v.number(),
        pairsFlagged: v.number(),
      }),
    ),
    correctionLoop: v.optional(
      v.object({
        proposalId: v.id("proposals"),
        attestedBy: v.id("users"),
        attestedAt: v.number(),
      }),
    ),
  }),

  // ---------- launch QA (spec §7) ----------

  // One row per Series in a drawn quality-gate sample (~50 random, ~50 most
  // prominent). Verification is by hand; a "failed" row names an error whose
  // class must be fixed pipeline-wide, after which the sample is redrawn as
  // the next round — the gate reads only the latest round per kind.
  qaChecks: defineTable({
    kind: v.union(v.literal("random"), v.literal("prominent")),
    round: v.number(),
    seriesId: v.id("series"),
    publicId: v.number(),
    title: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    note: v.optional(v.string()),
    checkedBy: v.optional(v.id("users")),
    checkedAt: v.optional(v.number()),
  }).index("by_kind_round", ["kind", "round"]),

  // Title-similarity duplicate sweep results (QA gate ③): one row per flagged
  // Series pair, keyed so a re-sweep never re-opens a resolved pair. "merged"
  // records that the pair was collapsed via the Merge operation;
  // "distinct" records a human decision that they are different Series.
  duplicateCandidates: defineTable({
    pairKey: v.string(),
    aId: v.id("series"),
    bId: v.id("series"),
    aTitle: v.string(),
    bTitle: v.string(),
    reason: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    resolution: v.optional(v.union(v.literal("distinct"), v.literal("merged"))),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    note: v.optional(v.string()),
  })
    .index("by_pairKey", ["pairKey"])
    .index("by_status", ["status"]),

  // ---------- users & personal tracking ----------

  users: defineTable({
    // Stable Clerk JWT subject — identity link is never by email.
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
    // Private by default; per-Series overrides live on userSeriesStates.
    ownershipVisibility: visibility,
    readingVisibility: visibility,
    // Shadowed User (CONTEXT.md): a Moderator's quiet mute. Their Comments
    // still look published to them and are hidden from everyone else.
    commentShadowed: v.optional(v.boolean()),
    // Rating Format (CONTEXT.md): how this User enters and reads scores.
    // Absent means DEFAULT_SCORE_FORMAT (lib/scoreFormat.ts).
    scoreFormat: v.optional(scoreFormatValidator),
    // True when this User opted out of analytics (users.setAnalyticsOptOut):
    // lib/posthog.ts sends nothing under their id and the browser client
    // neither loads nor identifies them. Absent means never chosen, which
    // tracks as before; a browser sending Do Not Track sets it once.
    analyticsOptOut: v.optional(v.boolean()),
    // When the User asked to delete their account (users.deleteAccount).
    // From then on they count as gone (lib/auth.ts) while the purge empties
    // their personal rows; the row itself goes last, a day after Clerk
    // confirms the sign-in is deleted (users.removePurgedUser).
    deletingSince: v.optional(v.number()),
    // When the purge found every personal table empty (users.purgeUser).
    // Set only on a deleting User, whose row then holds nothing but itself
    // and stays until a day after the Clerk deletion.
    purgedAt: v.optional(v.number()),
  })
    .index("by_clerkSubject", ["clerkSubject"])
    .index("by_username", ["usernameNormalized"])
    // Role holders, for the governance checks and /mod/roles (lib/roles.ts).
    .index("by_role", ["role"]),

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
    .index("by_user_bundle", ["userId", "bundleId"])
    // Reverse lookups for merge transfer + impact previews.
    .index("by_release", ["releaseId"])
    .index("by_bundle", ["bundleId"])
    .index("by_variantId", ["variantId"]),

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
    // One non-blocking follow prompt per series; dismissal is permanent.
    followPromptDismissed: v.boolean(),
    ownershipVisibility: v.optional(visibility),
    readingVisibility: v.optional(visibility),
  })
    .index("by_user_series", ["userId", "seriesId"])
    // Reverse lookup for merge transfer + impact previews.
    .index("by_series", ["seriesId"]),

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
    .index("by_user_series", ["userId", "seriesId"])
    // Reverse lookups for merge transfer + impact previews.
    .index("by_release", ["releaseId"])
    .index("by_series", ["seriesId"]),

  // A row's Series is its Volume's; nothing reads or writes `seriesId`, which
  // older rows still hold until reading:unsetProgressSeries clears them.
  volumeProgress: defineTable({
    userId: v.id("users"),
    volumeId: v.id("volumes"),
    seriesId: v.optional(v.id("series")),
    readCount: v.number(),
    // Supports undoing the most recent completion.
    lastCompletedAt: v.optional(v.number()),
  })
    .index("by_user_volume", ["userId", "volumeId"])
    .index("by_user_series", ["userId", "seriesId"])
    // Reverse lookups for merge transfer + impact previews.
    .index("by_volume", ["volumeId"])
    .index("by_series", ["seriesId"]),

  // Ratings and Reviews (convex/ratings.ts, convex/reviews.ts). Each row
  // targets exactly one Series, one Volume, or one omnibus Edition (an
  // Edition collecting more than one Volume; a single-volume Edition rates
  // its Volume): exactly one of seriesId / volumeId / editionId is set
  // (enforced in lib/ratings.ts), the collectionEntries shape, so every side
  // stays indexable. One row per (user, target).

  // A Rating: a private whole-number score from 1 to 100, whatever Rating
  // Format the User entered it in (lib/scoreFormat.ts). Only the aggregate
  // (ratingStats) and a Review's own score beside it are ever public.
  ratings: defineTable({
    userId: v.id("users"),
    seriesId: v.optional(v.id("series")),
    volumeId: v.optional(v.id("volumes")),
    editionId: v.optional(v.id("editions")),
    score: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_series", ["userId", "seriesId"])
    .index("by_user_volume", ["userId", "volumeId"])
    .index("by_user_edition", ["userId", "editionId"])
    // Reverse lookups for aggregate recounts and merge transfer.
    .index("by_series", ["seriesId"])
    .index("by_volume", ["volumeId"])
    .index("by_edition", ["editionId"]),

  // Sum and count of one target's Ratings (scores, 1-100), kept in step by
  // every rating write in the same transaction (lib/ratings.ts), recounted on
  // merge and split. The average is sum / count; no row, or count 0, means
  // unrated.
  ratingStats: defineTable({
    seriesId: v.optional(v.id("series")),
    volumeId: v.optional(v.id("volumes")),
    editionId: v.optional(v.id("editions")),
    sum: v.number(),
    count: v.number(),
  })
    .index("by_series", ["seriesId"])
    .index("by_volume", ["volumeId"])
    .index("by_edition", ["editionId"]),

  // A Favorite (CONTEXT.md): a User's private mark on one Series, one
  // Volume, or one omnibus Edition (convex/favorites.ts). A Series row has
  // neither volumeId nor editionId; a Volume or Edition row carries its
  // target and, denormalised, the target's Series (an Edition's is its
  // first covered Volume's), like comments. One row per (user, target).
  favorites: defineTable({
    userId: v.id("users"),
    seriesId: v.id("series"),
    volumeId: v.optional(v.id("volumes")),
    editionId: v.optional(v.id("editions")),
  })
    // Newest first per user (the index ends in _creationTime): the library view.
    .index("by_user", ["userId"])
    // A Series favorite is (user, series, volumeId and editionId undefined).
    .index("by_user_series", ["userId", "seriesId", "volumeId", "editionId"])
    .index("by_user_volume", ["userId", "volumeId"])
    .index("by_user_edition", ["userId", "editionId"])
    // Merge transfer (every row of a Series, Volume and Edition rows included).
    .index("by_series", ["seriesId"])
    .index("by_volume", ["volumeId"])
    .index("by_edition", ["editionId"]),

  // A Review: plain text (line breaks kept, no Markdown) by its author,
  // public once FEATURES.publicReviews is on (lib/features.ts), and
  // post-moderated: Moderators hide or unhide it (reviewAudit). A later
  // user-content report queue can add optional reportCount / lastReportedAt
  // fields here without a migration.
  reviews: defineTable({
    userId: v.id("users"),
    seriesId: v.optional(v.id("series")),
    volumeId: v.optional(v.id("volumes")),
    editionId: v.optional(v.id("editions")),
    body: v.string(),
    spoiler: v.boolean(),
    status: reviewStatus,
    createdAt: v.number(),
    // Set on every edit after the first save; the page shows "edited".
    updatedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_series", ["userId", "seriesId"])
    .index("by_user_volume", ["userId", "volumeId"])
    .index("by_user_edition", ["userId", "editionId"])
    // Newest first per target (the index ends in _creationTime); the status
    // variants serve the public list and the Moderators' hidden list.
    .index("by_series", ["seriesId"])
    .index("by_volume", ["volumeId"])
    .index("by_edition", ["editionId"])
    .index("by_series_status", ["seriesId", "status"])
    .index("by_volume_status", ["volumeId", "status"])
    .index("by_edition_status", ["editionId", "status"]),

  // Append-only record of Moderator actions on Reviews, shaped like
  // roleAudit. Survives the Review's deletion.
  reviewAudit: defineTable({
    reviewId: v.id("reviews"),
    action: v.union(v.literal("hidden"), v.literal("unhidden")),
    actor: v.union(
      v.object({ kind: v.literal("user"), userId: v.id("users") }),
      v.object({ kind: v.literal("system") }),
    ),
    reason: v.optional(v.string()),
  }),

  // Comments (convex/comments.ts, CONTEXT.md: Comment): short public plain
  // text on a Series or Volume page, one level of replies. Unlike Ratings
  // and Reviews, `seriesId` is always set: on a Series Comment it is the
  // target, on a Volume Comment (volumeId set) it is the Volume's Series,
  // denormalised for merge transfer and any later Mature filtering.
  comments: defineTable({
    userId: v.id("users"),
    seriesId: v.id("series"),
    volumeId: v.optional(v.id("volumes")),
    // A reply's top-level Comment; replies never have replies.
    parentId: v.optional(v.id("comments")),
    body: v.string(),
    spoiler: v.boolean(),
    status: commentStatus,
    // Distinct Comment Reports since a Moderator last cleared them.
    reportCount: v.number(),
    createdAt: v.number(),
    // Any change after posting (an edit or a moderation decision).
    updatedAt: v.optional(v.number()),
    // The author's last edit; the page shows "edited".
    editedAt: v.optional(v.number()),
    // Thread heads only: how many approved replies it has, kept in step by
    // every status change of a reply. Drives "N more replies" and whether a
    // gone head still needs a placeholder. Absent on heads that never had one.
    replyCount: v.optional(v.number()),
  })
    // A page's threads: (series, volume-or-undefined, top level, status), newest last.
    .index("by_target_thread_status", ["seriesId", "volumeId", "parentId", "status"])
    // A thread's replies by status, oldest first.
    .index("by_parent", ["parentId", "status"])
    // The hold rule's approved count and the account purge.
    .index("by_user", ["userId", "status"])
    // The viewer's own held and hidden Comments on one page.
    .index("by_user_target", ["userId", "seriesId", "volumeId"])
    // Merge transfer and impact previews.
    .index("by_series", ["seriesId"])
    .index("by_volume", ["volumeId"])
    // The moderation queue's Reported tab: approved, most reported first.
    .index("by_status", ["status", "reportCount"])
    // The other queue tabs by age: pending oldest first, hidden and removed newest first.
    .index("by_status_time", ["status"]),

  // One User's report of one Comment (CONTEXT.md: Comment Report). Three
  // distinct reports hide an approved Comment until a Moderator decides.
  commentReports: defineTable({
    commentId: v.id("comments"),
    reporterId: v.id("users"),
    reason: commentReportReason,
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    // One report per user per Comment; the commentId prefix lists a Comment's reports.
    .index("by_comment_reporter", ["commentId", "reporterId"])
    .index("by_reporter", ["reporterId"]),

  // Append-only record of moderation on Comments, shaped like reviewAudit.
  // `userId` names the author a shadow / unshadow applied to. Survives the
  // Comment's deletion.
  commentAudit: defineTable({
    commentId: v.id("comments"),
    action: v.union(
      v.literal("approve"),
      v.literal("hide"),
      v.literal("unhide"),
      v.literal("remove"),
      v.literal("restore"),
      v.literal("shadow"),
      v.literal("unshadow"),
    ),
    actor: v.union(
      v.object({ kind: v.literal("user"), userId: v.id("users") }),
      v.object({ kind: v.literal("system") }),
    ),
    userId: v.optional(v.id("users")),
    reason: v.optional(v.string()),
  }).index("by_comment", ["commentId"]),
});
