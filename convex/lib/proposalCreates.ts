// Proposal create ops (spec §5): one Proposal can atomically
// create several new records — temp-IDs let later ops reference records
// earlier ops create, so a Volume + its Edition Line + its Edition +
// coverage + a Release land together or not at all. This module is the
// creation registry: which tables a create op may target, how its fields
// are validated and normalized (reusing the direct-edit field registry for
// the overlapping fields), and how a validated plan is applied at approval.
//
// The field shapes deliberately match what the Seven Seas importer queues
// (sevenSeas.ts queueCreationProposal): references accept either a stored
// document ID or the temp-ID of an earlier create op; an edition names its
// publisher by ID or slug; coverage rows use `volume`/`volumeId`; an
// edition joins an Edition Line through `editionLineId`. An Edition Line
// create the importer queues carries `joinExisting: true`: sibling guesses
// queued before either is approved each create the same line, so at
// approval such an op resolves to the line when it exists by then.
//
// Hard invariants checked with every plan: no ISBN the proposal assigns — to
// a new Release or, through an update op, an existing one — ends up on two
// active Releases, and an Edition joins only a line of its own publisher
// under the base Series of the Volumes it covers.
//
// Validation (`planCreateOps`) runs at draft save, submission, and approval;
// application (`applyCreatePlan`) runs only inside the approval mutation.

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { editionSeriesIds } from "./editionRows";
import { fail } from "./errors";
import { volumePositionFor } from "./pipeline";
import { allocatePublicId } from "./publicIds";
import { seriesSearchText } from "./searchMatch";
import {
  fieldDescriptor,
  normalizeFieldValue,
  type RecordType,
} from "./moderationFields";

// ---------- shapes ----------

export type CreateOpInput = {
  kind: "create";
  table: string;
  tempId: string;
  fields: unknown;
};

/** Creatable tables and the record type each row becomes. */
export const CREATABLE_TABLES = {
  series: "series",
  volumes: "volume",
  editionLines: "editionLine",
  editions: "edition",
  releases: "release",
} as const satisfies Record<string, RecordType>;

export type CreatableTable = keyof typeof CREATABLE_TABLES;

/** A reference that resolves either to a stored doc or an earlier temp-ID. */
type RefTo<Table extends TableNames> =
  | { kind: "temp"; tempId: string }
  | { kind: "id"; id: Id<Table> };

type CoveragePlan = {
  volume: RefTo<"volumes">;
  order: number;
  extent: "complete" | "partial";
  note?: string;
};

export type CreatePlan =
  | {
      table: "series";
      tempId: string;
      fields: { title: string; altTitles: string[]; sourceStatus?: string };
    }
  | {
      table: "volumes";
      tempId: string;
      series: RefTo<"series">;
      fields: { label?: string; synopsis?: string };
    }
  | {
      table: "editionLines";
      tempId: string;
      series: RefTo<"series">;
      publisherId: Id<"publishers">;
      fields: { name: string };
      /** Set when a `joinExisting` op resolved to this stored line: nothing is created. */
      existingId?: Id<"editionLines">;
    }
  | {
      table: "editions";
      tempId: string;
      publisherId: Id<"publishers">;
      coverage: CoveragePlan[];
      editionLine?: RefTo<"editionLines">;
      fields: { linePosition?: string };
    }
  | {
      table: "releases";
      tempId: string;
      edition: RefTo<"editions">;
      fields: {
        format: "physical" | "digital";
        binding?: string;
        language: string;
        isbn13?: string;
        isbn10?: string;
        pubDate?: { year: number; month?: number; day?: number; sort: number };
        price?: { amountCents: number; currency: string };
        description?: string;
      };
    };

/** Refuse a malformed create op. */
function bad(message: string): never {
  return fail("invalidCreate", message);
}

// ---------- field plumbing ----------

/** Normalize one field through the shared registry, or throw. */
function viaRegistry(type: RecordType, field: string, raw: unknown): unknown {
  const descriptor = fieldDescriptor(type, field);
  if (!descriptor) return bad(`"${field}" is not a field of a new ${type}.`);
  const normalized = normalizeFieldValue(descriptor, raw);
  if (!normalized.ok) return bad(normalized.message);
  return normalized.value;
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad(`Malformed fields for the new ${what}.`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Resolve a reference value — a temp-ID string of an earlier create op or a
 * stored document ID. Temp-IDs win over coincidental ID-shaped strings.
 */
async function resolveRef<Table extends "series" | "volumes" | "editionLines" | "editions">(
  ctx: QueryCtx | MutationCtx,
  raw: unknown,
  table: Table,
  earlierTempIds: Map<string, CreatableTable>,
  what: string,
): Promise<RefTo<Table>> {
  if (typeof raw !== "string" || raw === "") {
    return bad(`${what} must reference a record or a temp-ID.`);
  }
  const tempTable = earlierTempIds.get(raw);
  if (tempTable !== undefined) {
    if (tempTable !== table) {
      return bad(`${what}: temp-ID "${raw}" is a new ${tempTable} row, not ${table}.`);
    }
    return { kind: "temp", tempId: raw };
  }
  const stored = await storedRef(ctx, raw, table);
  if (stored === null) {
    return bad(`${what}: "${raw}" is neither a known temp-ID nor a ${table} ID.`);
  }
  if (!stored.active) {
    return bad(`${what}: the referenced ${table} record is missing or not active.`);
  }
  return { kind: "id", id: stored.id };
}

/** Tables a create op's fields may reference by stored ID. */
type ReferencedTable = "series" | "volumes" | "editionLines" | "editions" | "publishers";

/**
 * Look up a stored-document reference: null when `raw` is not an ID of
 * `table`, else the ID and whether the record is still active.
 */
async function storedRef<Table extends ReferencedTable>(
  ctx: QueryCtx | MutationCtx,
  raw: string,
  table: Table,
): Promise<{ id: Id<Table>; active: boolean } | null> {
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) return null;
  const doc = (await ctx.db.get(id)) as { status?: string } | null;
  return { id, active: doc?.status === "active" };
}

// ---------- planning (validation) ----------

/**
 * Validate a proposal's create ops in order and return the normalized plan.
 * Throws ConvexError (code "invalidCreate") on any structural problem: an
 * unknown table, duplicate or forward temp-ID references, missing required
 * fields, a reference to a record that no longer exists, a Release ISBN
 * already taken, or an Edition Line that does not fit its Edition.
 * `isbnUpdates` are the ISBNs the same proposal's update ops write on
 * existing Releases; the ISBN check covers creates and updates together
 * (see `checkIsbnAssignments`). Runs at draft save, submission, and approval
 * (inside the approval transaction) — hard invariants are never overridable.
 */
export async function planCreateOps(
  ctx: QueryCtx | MutationCtx,
  ops: CreateOpInput[],
  isbnUpdates: IsbnUpdate[] = [],
): Promise<CreatePlan[]> {
  const plans: CreatePlan[] = [];
  const tempIds = new Map<string, CreatableTable>();
  const planByTemp = new Map<string, CreatePlan>();
  const isbnClaims: IsbnClaim[] = [];
  for (const op of ops) {
    if (!(op.table in CREATABLE_TABLES)) {
      bad(`Proposals cannot create "${op.table}" records.`);
    }
    const table = op.table as CreatableTable;
    if (op.tempId === "" || tempIds.has(op.tempId)) {
      bad(`Temp-ID "${op.tempId}" is empty or used twice.`);
    }
    const fields = asObject(op.fields, CREATABLE_TABLES[table]);

    switch (table) {
      case "series": {
        const title = viaRegistry("series", "title", fields.title);
        if (title === undefined) bad("A new series needs a title.");
        plans.push({
          table,
          tempId: op.tempId,
          fields: {
            title: title as string,
            altTitles: (viaRegistry("series", "altTitles", fields.altTitles) ??
              []) as string[],
            sourceStatus: viaRegistry(
              "series",
              "sourceStatus",
              fields.sourceStatus,
            ) as string | undefined,
          },
        });
        break;
      }
      case "volumes": {
        const series = await resolveRef(
          ctx,
          fields.seriesId,
          "series",
          tempIds,
          "New volume's series",
        );
        plans.push({
          table,
          tempId: op.tempId,
          series,
          fields: {
            label: viaRegistry("volume", "label", fields.label) as
              | string
              | undefined,
            synopsis: viaRegistry("volume", "synopsis", fields.synopsis) as
              | string
              | undefined,
          },
        });
        break;
      }
      case "editionLines": {
        const series = await resolveRef(
          ctx,
          fields.seriesId,
          "series",
          tempIds,
          "New edition line's series",
        );
        const publisherId = await resolvePublisher(ctx, fields, "edition line");
        const name = viaRegistry("editionLine", "name", fields.name);
        if (typeof name !== "string") return bad("A new edition line needs a name.");
        // One line per (base Series, publisher, name), as the importer keeps it.
        const wanted = name.toLowerCase();
        const twin = [...planByTemp.values()].some(
          (plan) =>
            plan.table === "editionLines" &&
            seriesKey(plan.series) === seriesKey(series) &&
            plan.publisherId === publisherId &&
            plan.fields.name.toLowerCase() === wanted,
        );
        const stored =
          series.kind === "id"
            ? (
                await ctx.db
                  .query("editionLines")
                  .withIndex("by_series", (q) => q.eq("seriesId", series.id))
                  .collect()
              ).find(
                (line) =>
                  line.status === "active" &&
                  line.publisherId === publisherId &&
                  line.name.toLowerCase() === wanted,
              )
            : undefined;
        // An op flagged `joinExisting` (the importer's queued guesses) names
        // its line by identity: when a sibling proposal's approval created
        // that line meanwhile, the op resolves to it instead of a twin.
        if (stored !== undefined && !twin && fields.joinExisting === true) {
          plans.push({
            table,
            tempId: op.tempId,
            series,
            publisherId,
            fields: { name: stored.name },
            existingId: stored._id,
          });
          break;
        }
        if (twin || stored !== undefined) {
          bad(
            `The edition line "${name}" already exists for this series and publisher — reference it instead.`,
          );
        }
        plans.push({ table, tempId: op.tempId, series, publisherId, fields: { name } });
        break;
      }
      case "editions": {
        const publisherId = await resolvePublisher(ctx, fields, "edition");
        const coverage = await planCoverage(ctx, fields, tempIds);
        const editionLine =
          fields.editionLineId === undefined
            ? undefined
            : await resolveRef(
                ctx,
                fields.editionLineId,
                "editionLines",
                tempIds,
                "New edition's line",
              );
        if (editionLine !== undefined) {
          await checkLineFits(ctx, editionLine, publisherId, coverage, planByTemp);
        }
        plans.push({
          table,
          tempId: op.tempId,
          publisherId,
          coverage,
          editionLine,
          fields: {
            linePosition: viaRegistry(
              "edition",
              "linePosition",
              fields.linePosition,
            ) as string | undefined,
          },
        });
        break;
      }
      case "releases": {
        const edition = await resolveRef(
          ctx,
          fields.editionId,
          "editions",
          tempIds,
          "New release's edition",
        );
        const format = fields.format;
        if (format !== "physical" && format !== "digital") {
          bad('A new release needs a format: "physical" or "digital".');
        }
        const binding = viaRegistry("release", "binding", fields.binding) as
          | string
          | undefined;
        // Hard invariant (CONTEXT.md): Binding applies only to physical.
        if (format === "digital" && binding !== undefined) {
          bad("Binding applies only to physical releases.");
        }
        const language = viaRegistry("release", "language", fields.language);
        const isbn13 = viaRegistry("release", "isbn13", fields.isbn13) as string | undefined;
        const isbn10 = viaRegistry("release", "isbn10", fields.isbn10) as string | undefined;
        if (isbn13 !== undefined) isbnClaims.push({ field: "isbn13", isbn: isbn13, by: "create" });
        if (isbn10 !== undefined) isbnClaims.push({ field: "isbn10", isbn: isbn10, by: "create" });
        plans.push({
          table,
          tempId: op.tempId,
          edition,
          fields: {
            format,
            binding,
            language: language as string,
            isbn13,
            isbn10,
            pubDate: viaRegistry("release", "pubDate", fields.pubDate) as
              | { year: number; month?: number; day?: number; sort: number }
              | undefined,
            price: viaRegistry("release", "price", fields.price) as
              | { amountCents: number; currency: string }
              | undefined,
            description: viaRegistry(
              "release",
              "description",
              fields.description,
            ) as string | undefined,
          },
        });
        break;
      }
    }
    tempIds.set(op.tempId, table);
    planByTemp.set(op.tempId, plans[plans.length - 1]!);
  }
  await checkIsbnAssignments(ctx, isbnClaims, isbnUpdates);
  return plans;
}

/** A Release ISBN column. */
type IsbnField = "isbn13" | "isbn10";

/**
 * An ISBN an update op of the same proposal writes on an existing Release;
 * `isbn` undefined clears the field, freeing its old value.
 */
export type IsbnUpdate = {
  releaseId: Id<"releases">;
  field: IsbnField;
  isbn: string | undefined;
};

/** One ISBN a proposal's final state assigns, and the kind of op assigning it. */
type IsbnClaim = { field: IsbnField; isbn: string; by: "create" | "update" };

/**
 * Release identity (CONTEXT.md): an ISBN names one Release. Checks the
 * proposal's final ISBN assignments — new Releases and updated ones alike —
 * against each other and against every active Release. A holder whose same
 * ISBN field this proposal rewrites no longer counts, so moving an ISBN off a
 * mis-keyed Release and onto the right one is allowed. A real duplicate is
 * resolved by merging or correcting the holder, never by a second holder.
 * Codes follow the op kinds involved: "invalidCreate" when a create is,
 * else "invalidField" (the update validation code).
 */
async function checkIsbnAssignments(
  ctx: QueryCtx | MutationCtx,
  creates: IsbnClaim[],
  updates: IsbnUpdate[],
): Promise<void> {
  const refuse = (involvesCreate: boolean, message: string) =>
    fail(involvesCreate ? "invalidCreate" : "invalidField", message);
  const rewritten = new Set(updates.map((update) => `${update.field}:${update.releaseId}`));
  const claims = [
    ...updates.flatMap(({ field, isbn }): IsbnClaim[] =>
      isbn === undefined ? [] : [{ field, isbn, by: "update" }],
    ),
    ...creates,
  ];
  const claimed = new Map<string, IsbnClaim>();
  for (const claim of claims) {
    const { field, isbn } = claim;
    const twin = claimed.get(`${field}:${isbn}`);
    if (twin) {
      refuse(
        twin.by === "create" || claim.by === "create",
        `Two releases in this proposal would share the ISBN ${isbn}.`,
      );
    }
    claimed.set(`${field}:${isbn}`, claim);
    const holders =
      field === "isbn13"
        ? await ctx.db
            .query("releases")
            .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn))
            .collect()
        : await ctx.db
            .query("releases")
            .withIndex("by_isbn10", (q) => q.eq("isbn10", isbn))
            .collect();
    const held = holders.some(
      (release) => release.status === "active" && !rewritten.has(`${field}:${release._id}`),
    );
    if (held) {
      refuse(
        claim.by === "create",
        claim.by === "create"
          ? `ISBN ${isbn} already belongs to an active Release — correct or merge that Release instead of creating another.`
          : `ISBN ${isbn} already belongs to another active Release — correct or merge that Release first.`,
      );
    }
  }
}

/** Identity of a Series reference: temp-IDs and stored IDs never collide. */
const seriesKey = (ref: RefTo<"series">): string =>
  ref.kind === "temp" ? `temp:${ref.tempId}` : `id:${ref.id}`;

/**
 * An Edition Line belongs to the base Series whose Volumes it collects and
 * to one publisher (CONTEXT.md): a new edition may join a line only when the
 * line's publisher is the edition's and every covered Volume sits in the
 * line's Series. References may be stored records or earlier temp-IDs.
 */
async function checkLineFits(
  ctx: QueryCtx | MutationCtx,
  lineRef: RefTo<"editionLines">,
  publisherId: Id<"publishers">,
  coverage: CoveragePlan[],
  planByTemp: Map<string, CreatePlan>,
): Promise<void> {
  let line: { series: RefTo<"series">; publisherId: Id<"publishers"> };
  if (lineRef.kind === "temp") {
    const plan = planByTemp.get(lineRef.tempId);
    if (plan?.table !== "editionLines") return bad("New edition's line resolved out of order.");
    line = plan;
  } else {
    const doc = (await ctx.db.get(lineRef.id))!;
    line = { series: { kind: "id", id: doc.seriesId }, publisherId: doc.publisherId };
  }
  if (line.publisherId !== publisherId) {
    bad("New edition's line belongs to another publisher.");
  }
  const lineSeries = seriesKey(line.series);
  for (const row of coverage) {
    let series: RefTo<"series">;
    if (row.volume.kind === "temp") {
      const plan = planByTemp.get(row.volume.tempId);
      if (plan?.table !== "volumes") return bad("Coverage row resolved out of order.");
      series = plan.series;
    } else {
      const volume = (await ctx.db.get(row.volume.id))!;
      series = { kind: "id", id: volume.seriesId };
    }
    if (seriesKey(series) !== lineSeries) {
      bad("New edition's line belongs to another series than the volumes it covers.");
    }
  }
}

/**
 * A new edition or edition line names its publisher by ID or by slug (the
 * importer's form).
 */
async function resolvePublisher(
  ctx: QueryCtx | MutationCtx,
  fields: Record<string, unknown>,
  what: "edition" | "edition line",
): Promise<Id<"publishers">> {
  if (typeof fields.publisherId === "string" && fields.publisherId !== "") {
    const stored = await storedRef(ctx, fields.publisherId, "publishers");
    if (stored?.active) return stored.id;
    return bad(`New ${what}'s publisher was not found.`);
  }
  if (typeof fields.publisherSlug === "string" && fields.publisherSlug !== "") {
    const doc = await ctx.db
      .query("publishers")
      .withIndex("by_slug", (q) => q.eq("slug", fields.publisherSlug as string))
      .unique();
    if (doc && doc.status === "active") return doc._id;
    return bad(`No active publisher with slug "${fields.publisherSlug}".`);
  }
  return bad(`A new ${what} needs publisherId or publisherSlug.`);
}

// ---------- staleness ----------

const REFERENCED_TYPES: Record<ReferencedTable, RecordType> = {
  series: "series",
  volumes: "volume",
  editionLines: "editionLine",
  editions: "edition",
  publishers: "publisher",
};

/** The stored-ID references one create op's fields may carry (raw, unvalidated). */
function referencesOf(op: CreateOpInput): Array<{ table: ReferencedTable; raw: unknown }> {
  const fields = op.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return [];
  const f = fields as Record<string, unknown>;
  switch (op.table) {
    case "volumes":
      return [{ table: "series", raw: f.seriesId }];
    case "editionLines":
      return [
        { table: "series", raw: f.seriesId },
        { table: "publishers", raw: f.publisherId },
      ];
    case "editions": {
      const rows = Array.isArray(f.volumeCoverage) ? f.volumeCoverage : [];
      return [
        { table: "publishers", raw: f.publisherId },
        { table: "editionLines", raw: f.editionLineId },
        ...rows.map((row) => {
          const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
          return { table: "volumes" as const, raw: r.volumeId ?? r.volume };
        }),
      ];
    }
    case "releases":
      return [{ table: "editions", raw: f.editionId }];
    default:
      return [];
  }
}

/**
 * Stored records the create ops reference — by ID, or a new edition's
 * publisher by slug — that are no longer active: hidden, merged, or deleted
 * since the proposal was written (an importer's proposal reuses existing
 * Volumes, so this happens whenever one is merged before review). Temp-IDs of
 * ops in the same proposal are skipped; strings that resolve to nothing are
 * left for `planCreateOps` to reject as structural errors. Approval checks
 * this first so a vanished reference reads as a stale proposal instead of a
 * thrown `resolveRef`.
 */
export async function unavailableCreateRefs(
  ctx: QueryCtx | MutationCtx,
  ops: CreateOpInput[],
): Promise<Array<{ type: RecordType; id: string }>> {
  const tempIds = new Set(ops.map((op) => op.tempId));
  const unavailable = new Map<string, RecordType>();
  for (const op of ops) {
    for (const { table, raw } of referencesOf(op)) {
      if (typeof raw !== "string" || raw === "" || tempIds.has(raw)) continue;
      const stored = await storedRef(ctx, raw, table);
      if (stored !== null && !stored.active) unavailable.set(stored.id, REFERENCED_TYPES[table]);
    }
    // The importer's form names the publisher by slug; ID wins when both are set.
    const fields = op.fields as { publisherId?: unknown; publisherSlug?: unknown } | null;
    const byId = typeof fields?.publisherId === "string" && fields.publisherId !== "";
    const slug = fields?.publisherSlug;
    const namesPublisher = op.table === "editions" || op.table === "editionLines";
    if (namesPublisher && !byId && typeof slug === "string" && slug !== "") {
      const doc = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (doc && doc.status !== "active") unavailable.set(doc._id, "publisher");
    }
  }
  return [...unavailable].map(([id, type]) => ({ type, id }));
}

/** Validate the ordered Volume Coverage of a new edition (≥ 1 row). */
async function planCoverage(
  ctx: QueryCtx | MutationCtx,
  fields: Record<string, unknown>,
  tempIds: Map<string, CreatableTable>,
): Promise<CoveragePlan[]> {
  const raw = fields.volumeCoverage;
  if (!Array.isArray(raw) || raw.length === 0) {
    return bad("A new edition needs at least one volume coverage row.");
  }
  const coverage: CoveragePlan[] = [];
  const orders = new Set<number>();
  for (const entry of raw) {
    const row = asObject(entry, "edition coverage row");
    const volume = await resolveRef(
      ctx,
      row.volumeId ?? row.volume,
      "volumes",
      tempIds,
      "Coverage row",
    );
    const order = row.order;
    if (typeof order !== "number" || !Number.isInteger(order) || order < 1) {
      return bad("Coverage order must be a positive whole number.");
    }
    if (orders.has(order)) return bad("Coverage orders must be unique.");
    orders.add(order);
    if (row.extent !== "complete" && row.extent !== "partial") {
      return bad('Coverage extent must be "complete" or "partial".');
    }
    const note =
      typeof row.note === "string" && row.note.trim() !== ""
        ? row.note.trim()
        : undefined;
    coverage.push({ volume, order, extent: row.extent, note });
  }
  return coverage;
}

// ---------- application (approval only) ----------

export type CreatedRecord = {
  tempId: string;
  ref:
    | { type: "series"; id: Id<"series"> }
    | { type: "volume"; id: Id<"volumes"> }
    | { type: "editionLine"; id: Id<"editionLines"> }
    | { type: "edition"; id: Id<"editions"> }
    | { type: "release"; id: Id<"releases"> };
  publicId: number | null;
  /** Field values for the creation Revision (creations list every field). */
  revisionFields: Record<string, unknown>;
  /**
   * The op resolved to a record that already existed (a `joinExisting`
   * Edition Line): nothing was inserted, so it gets no creation Revision.
   */
  existing?: true;
};

function resolved<Table extends TableNames>(
  ref: RefTo<Table>,
  temp: Map<string, string>,
): Id<Table> {
  if (ref.kind === "id") return ref.id;
  const id = temp.get(ref.tempId);
  if (id === undefined) {
    return bad(`Temp-ID "${ref.tempId}" resolved out of order.`);
  }
  return id as Id<Table>;
}

/**
 * Apply one validated create plan inside the approval mutation. `temp` maps
 * temp-IDs of already-applied ops to their new document IDs; the caller
 * applies plans in op order so references always resolve. Derived fields
 * (public IDs, search text, volume position, release denorms) are computed
 * here — the same rules the importer and direct-edit paths follow.
 */
export async function applyCreatePlan(
  ctx: MutationCtx,
  plan: CreatePlan,
  temp: Map<string, string>,
): Promise<CreatedRecord> {
  switch (plan.table) {
    case "series": {
      const publicId = await allocatePublicId(ctx, "series");
      const id = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title: plan.fields.title,
        altTitles: plan.fields.altTitles,
        searchText: seriesSearchText(plan.fields.title, plan.fields.altTitles),
        sourceStatus: plan.fields.sourceStatus as
          | Doc<"series">["sourceStatus"]
          | undefined,
      });
      temp.set(plan.tempId, id);
      return {
        tempId: plan.tempId,
        ref: { type: "series", id },
        publicId,
        revisionFields: { ...plan.fields },
      };
    }
    case "volumes": {
      const seriesId = resolved(plan.series, temp);
      // Volume Position: the volume number when the label is one (spec §2),
      // else just after the last whole number — counting volumes this same
      // proposal just created (reads see our writes).
      const siblings = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .collect();
      const position = volumePositionFor(
        plan.fields.label,
        new Set(siblings.map((vol) => vol.position)),
      );
      const publicId = await allocatePublicId(ctx, "volume");
      const id = await ctx.db.insert("volumes", {
        status: "active",
        publicId,
        seriesId,
        position,
        label: plan.fields.label,
        synopsis: plan.fields.synopsis,
      });
      temp.set(plan.tempId, id);
      return {
        tempId: plan.tempId,
        ref: { type: "volume", id },
        publicId,
        revisionFields: { ...plan.fields, position },
      };
    }
    case "editionLines": {
      if (plan.existingId !== undefined) {
        temp.set(plan.tempId, plan.existingId);
        return {
          tempId: plan.tempId,
          ref: { type: "editionLine", id: plan.existingId },
          publicId: null,
          revisionFields: {},
          existing: true,
        };
      }
      const id = await ctx.db.insert("editionLines", {
        status: "active",
        seriesId: resolved(plan.series, temp),
        publisherId: plan.publisherId,
        name: plan.fields.name,
      });
      temp.set(plan.tempId, id);
      return {
        tempId: plan.tempId,
        ref: { type: "editionLine", id },
        publicId: null,
        revisionFields: { ...plan.fields },
      };
    }
    case "editions": {
      const publicId = await allocatePublicId(ctx, "edition");
      const editionLineId = plan.editionLine && resolved(plan.editionLine, temp);
      const id = await ctx.db.insert("editions", {
        status: "active",
        publicId,
        publisherId: plan.publisherId,
        editionLineId,
        linePosition: plan.fields.linePosition,
      });
      const coverage = [];
      for (const row of [...plan.coverage].sort((a, b) => a.order - b.order)) {
        const volumeId = resolved(row.volume, temp);
        await ctx.db.insert("volumeCoverages", {
          editionId: id,
          volumeId,
          order: row.order,
          extent: row.extent,
          note: row.note,
        });
        coverage.push({
          volumeId,
          order: row.order,
          extent: row.extent,
          note: row.note,
        });
      }
      temp.set(plan.tempId, id);
      return {
        tempId: plan.tempId,
        ref: { type: "edition", id },
        publicId,
        // Coverage records as the Edition's pseudo-field (spec §8).
        revisionFields: { ...plan.fields, editionLineId, volumeCoverage: coverage },
      };
    }
    case "releases": {
      const editionId = resolved(plan.edition, temp);
      const edition = await ctx.db.get(editionId);
      if (!edition) return bad("New release's edition vanished mid-apply.");
      // Denorms maintained by the shared write path (spec §8).
      const seriesIds = await editionSeriesIds(ctx, edition);
      const id = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        ...plan.fields,
        publisherId: edition.publisherId,
        seriesIds,
      });
      temp.set(plan.tempId, id);
      return {
        tempId: plan.tempId,
        ref: { type: "release", id },
        publicId: null,
        revisionFields: { ...plan.fields },
      };
    }
  }
}
