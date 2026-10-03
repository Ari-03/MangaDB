// Row factories for the convex-test suites: catalog records, Source
// Observations and source-authored Revisions, inserted with schema-valid
// defaults that any field can override. Each takes the ctx of `t.run`:
//
//   const { seriesId, releaseId } = await t.run((ctx) =>
//     seedCatalog(ctx, { series: { title: "Alpha" }, release: { isbn13 } }));
//
// Default public ids count up from 1,000,000 within a test file, so rows
// never collide with each other or with ids the code under test allocates
// (lib/publicIds.ts starts at 1). Pass `publicId` whenever a test reads it.
// Two dots in the name keep Convex from deploying it (see test.helpers.ts).

import type { WithoutSystemFields } from "convex/server";

import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type Fields<T extends TableNames> = WithoutSystemFields<Doc<T>>;
/** A table's fields: those in `Required` must be given, the rest default. */
export type Overrides<T extends TableNames, Required extends keyof Fields<T> = never> = Partial<Fields<T>> &
  Pick<Fields<T>, Required>;

let lastPublicId = 1_000_000;
const nextPublicId = () => ++lastPublicId;

/** A Publisher. `name` defaults to the slug or "Publisher N"; `slug` to the name, slugified. */
export async function insertPublisher(ctx: MutationCtx, fields: Overrides<"publishers"> = {}) {
  const name = fields.name ?? fields.slug ?? `Publisher ${nextPublicId()}`;
  const slug = fields.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return await ctx.db.insert("publishers", { status: "active", ...fields, name, slug });
}

/** An active Series; `searchText` defaults to the title and alt titles joined by spaces. */
export async function insertSeries(ctx: MutationCtx, fields: Overrides<"series"> = {}) {
  const publicId = fields.publicId ?? nextPublicId();
  const title = fields.title ?? `Series ${publicId}`;
  const altTitles = fields.altTitles ?? [];
  return await ctx.db.insert("series", {
    status: "active",
    searchText: [title, ...altTitles].join(" "),
    ...fields,
    publicId,
    title,
    altTitles,
  });
}

/** An active Volume at `position` (default 1) labeled with it; pass `label: undefined` for none. */
export async function insertVolume(ctx: MutationCtx, fields: Overrides<"volumes", "seriesId">) {
  const position = fields.position ?? 1;
  return await ctx.db.insert("volumes", {
    status: "active",
    publicId: nextPublicId(),
    label: String(position),
    ...fields,
    position,
  });
}

/** An active Edition Line, named "Edition Line" unless given. */
export async function insertEditionLine(
  ctx: MutationCtx,
  fields: Overrides<"editionLines", "seriesId" | "publisherId">,
) {
  return await ctx.db.insert("editionLines", { status: "active", name: "Edition Line", ...fields });
}

/** An active Edition. Its coverage is separate rows (insertCoverage). */
export async function insertEdition(ctx: MutationCtx, fields: Overrides<"editions", "publisherId">) {
  return await ctx.db.insert("editions", { status: "active", publicId: nextPublicId(), ...fields });
}

/** A coverage row: the Edition holds the Volume complete, at order 1 unless given. */
export async function insertCoverage(
  ctx: MutationCtx,
  fields: Overrides<"volumeCoverages", "editionId" | "volumeId">,
) {
  return await ctx.db.insert("volumeCoverages", { order: 1, extent: "complete", ...fields });
}

/** An active physical English Release. Its publisher and Series are the caller's to denormalize. */
export async function insertRelease(
  ctx: MutationCtx,
  fields: Overrides<"releases", "editionId" | "publisherId" | "seriesIds">,
) {
  return await ctx.db.insert("releases", { status: "active", format: "physical", language: "en", ...fields });
}

/** An active Release Variant, named "Variant" unless given. */
export async function insertVariant(ctx: MutationCtx, fields: Overrides<"releaseVariants", "releaseId">) {
  return await ctx.db.insert("releaseVariants", { status: "active", name: "Variant", ...fields });
}

/** An active Release Bundle named "Box Set N", with no format unless given. */
export async function insertBundle(ctx: MutationCtx, fields: Overrides<"releaseBundles", "publisherId">) {
  const publicId = fields.publicId ?? nextPublicId();
  return await ctx.db.insert("releaseBundles", {
    status: "active",
    name: `Box Set ${publicId}`,
    ...fields,
    publicId,
  });
}

/** A Release's membership in a Bundle; `order` defaults to after the bundle's last member. */
export async function insertBundleMember(
  ctx: MutationCtx,
  fields: Overrides<"bundleMemberships", "bundleId" | "releaseId">,
) {
  const members = await ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", fields.bundleId))
    .collect();
  return await ctx.db.insert("bundleMemberships", { order: (members.at(-1)?.order ?? 0) + 1, ...fields });
}

/** A Source Observation: unlinked, not withdrawn, seen at 0, with an empty snapshot unless given. */
export async function insertObservation(
  ctx: MutationCtx,
  fields: Overrides<"sourceObservations", "sourceKey" | "sourceRecordId">,
) {
  return await ctx.db.insert("sourceObservations", { snapshot: {}, lastSeenAt: 0, withdrawn: false, ...fields });
}

/**
 * Provenance as an importer leaves it: an approved Proposal authored by
 * `sourceKey` and its Revision of `ref`. `seq` defaults to the record's
 * next. The record itself is not patched.
 */
export async function insertSourceRevision(
  ctx: MutationCtx,
  args: Pick<Fields<"revisions">, "ref" | "changes"> &
    Partial<Pick<Fields<"revisions">, "seq" | "comment" | "citation">> & { sourceKey: string },
) {
  const { sourceKey, ...revision } = args;
  const author = { kind: "source" as const, sourceKey };
  const history = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", args.ref.type).eq("ref.id", args.ref.id))
    .collect();
  const proposalId = await ctx.db.insert("proposals", { author, state: "approved", currentVersionNo: 1 });
  const revisionId = await ctx.db.insert("revisions", {
    seq: history.length + 1,
    comment: `Imported from ${sourceKey}.`,
    ...revision,
    proposalId,
    author,
  });
  return { proposalId, revisionId };
}

/**
 * A seriesStats row (not inserted): an empty Series' figures, `titleSort`
 * the lower-cased title and `letter` its first letter (or "#").
 */
export function seriesStatsRow(fields: Overrides<"seriesStats", "seriesId" | "publicId" | "title">): Fields<"seriesStats"> {
  const titleSort = fields.titleSort ?? fields.title.toLowerCase();
  const first = titleSort.charAt(0);
  return {
    letter: /[a-z]/.test(first) ? first : "#",
    sourceStatus: "unknown",
    publishers: [],
    hasPhysical: false,
    hasDigital: false,
    volumeCount: 0,
    releaseCount: 0,
    firstReleaseSort: 0,
    latestReleaseSort: 0,
    nextReleaseSort: 0,
    followers: 0,
    collectors: 0,
    coverUrl: null,
    coverIsbn: null,
    rebuiltAt: 0,
    ...fields,
    titleSort,
  };
}

/** Per-record overrides for seedCatalog. `line` adds an Edition Line the Edition belongs to. */
export type CatalogOverrides = {
  publisher?: Id<"publishers"> | Overrides<"publishers">;
  series?: Overrides<"series">;
  volume?: Partial<Fields<"volumes">>;
  line?: Partial<Fields<"editionLines">>;
  edition?: Partial<Fields<"editions">>;
  coverage?: Partial<Fields<"volumeCoverages">>;
  release?: Partial<Fields<"releases">>;
};

/**
 * One whole chain, inserted in this order: publisher → Series → Volume →
 * (Edition Line) → Edition → coverage → Release. `publisher` takes an
 * existing id, or fields; fields whose slug is already in the database
 * reuse that Publisher, so several chains can share one.
 */
export async function seedCatalog(ctx: MutationCtx, overrides: CatalogOverrides = {}) {
  const publisherId = await catalogPublisher(ctx, overrides.publisher);
  const seriesId = await insertSeries(ctx, overrides.series);
  const volumeId = await insertVolume(ctx, { seriesId, ...overrides.volume });
  const editionLineId = overrides.line && (await insertEditionLine(ctx, { seriesId, publisherId, ...overrides.line }));
  const editionId = await insertEdition(ctx, { publisherId, editionLineId, ...overrides.edition });
  await insertCoverage(ctx, { editionId, volumeId, ...overrides.coverage });
  const releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], ...overrides.release });
  return { publisherId, seriesId, volumeId, editionLineId, editionId, releaseId };
}

async function catalogPublisher(ctx: MutationCtx, publisher: CatalogOverrides["publisher"]) {
  if (typeof publisher === "string") return publisher;
  const slug = publisher?.slug;
  const existing =
    slug === undefined
      ? null
      : await ctx.db
          .query("publishers")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique();
  return existing?._id ?? (await insertPublisher(ctx, publisher));
}
