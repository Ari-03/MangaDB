// Proposal create ops (ticket #32, spec §5): one Proposal can atomically
// create several new records — temp-IDs let later ops reference records
// earlier ops create, so a Volume + its Edition + coverage + a Release land
// together or not at all. This module is the creation registry: which tables
// a create op may target, how its fields are validated and normalized
// (reusing the direct-edit field registry for the overlapping fields), and
// how a validated plan is applied at approval.
//
// The field shapes deliberately match what the Seven Seas importer queues
// (sevenSeas.ts queueCreationProposal): references accept either a stored
// document ID or the temp-ID of an earlier create op; an edition names its
// publisher by ID or slug; coverage rows use `volume`/`volumeId`.
//
// Validation (`planCreateOps`) runs at draft save, submission, and approval;
// application (`applyCreatePlan`) runs only inside the approval mutation.

import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { allocatePublicId } from "./publicIds";
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
      table: "editions";
      tempId: string;
      publisherId: Id<"publishers">;
      coverage: CoveragePlan[];
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

const bad = (message: string): never => {
  throw new ConvexError({ code: "invalidCreate", message });
};

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
async function resolveRef<Table extends "series" | "volumes" | "editions">(
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
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) {
    return bad(`${what}: "${raw}" is neither a known temp-ID nor a ${table} ID.`);
  }
  const doc = (await ctx.db.get(id)) as { status?: string } | null;
  if (!doc || doc.status !== "active") {
    return bad(`${what}: the referenced ${table} record is missing or not active.`);
  }
  return { kind: "id", id };
}

// ---------- planning (validation) ----------

/**
 * Validate a proposal's create ops in order and return the normalized plan.
 * Throws ConvexError (code "invalidCreate") on any structural problem: an
 * unknown table, duplicate or forward temp-ID references, missing required
 * fields, or a reference to a record that no longer exists. Runs at draft
 * save, submission, and approval — hard invariants are never overridable.
 */
export async function planCreateOps(
  ctx: QueryCtx | MutationCtx,
  ops: CreateOpInput[],
): Promise<CreatePlan[]> {
  const plans: CreatePlan[] = [];
  const tempIds = new Map<string, CreatableTable>();
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
      case "editions": {
        const publisherId = await resolvePublisher(ctx, fields);
        const coverage = await planCoverage(ctx, fields, tempIds);
        plans.push({
          table,
          tempId: op.tempId,
          publisherId,
          coverage,
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
        plans.push({
          table,
          tempId: op.tempId,
          edition,
          fields: {
            format: format as "physical" | "digital",
            binding,
            language: language as string,
            isbn13: viaRegistry("release", "isbn13", fields.isbn13) as
              | string
              | undefined,
            isbn10: viaRegistry("release", "isbn10", fields.isbn10) as
              | string
              | undefined,
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
  }
  return plans;
}

/** A new edition names its publisher by ID or by slug (the importer's form). */
async function resolvePublisher(
  ctx: QueryCtx | MutationCtx,
  fields: Record<string, unknown>,
): Promise<Id<"publishers">> {
  if (typeof fields.publisherId === "string" && fields.publisherId !== "") {
    const id = ctx.db.normalizeId("publishers", fields.publisherId);
    if (id) {
      const doc = await ctx.db.get(id);
      if (doc && doc.status === "active") return id;
    }
    return bad("New edition's publisher was not found.");
  }
  if (typeof fields.publisherSlug === "string" && fields.publisherSlug !== "") {
    const doc = await ctx.db
      .query("publishers")
      .withIndex("by_slug", (q) => q.eq("slug", fields.publisherSlug as string))
      .unique();
    if (doc && doc.status === "active") return doc._id;
    return bad(`No active publisher with slug "${fields.publisherSlug}".`);
  }
  return bad("A new edition needs publisherId or publisherSlug.");
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
    | { type: "edition"; id: Id<"editions"> }
    | { type: "release"; id: Id<"releases"> };
  publicId: number | null;
  /** Field values for the creation Revision (creations list every field). */
  revisionFields: Record<string, unknown>;
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
        searchText: [plan.fields.title, ...plan.fields.altTitles].join(" "),
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
      // Volume Position: next in the series' canonical sequence, counting
      // volumes this same proposal just created (reads see our writes).
      const last = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .order("desc")
        .first();
      const position = (last?.position ?? 0) + 1;
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
    case "editions": {
      const publicId = await allocatePublicId(ctx, "edition");
      const id = await ctx.db.insert("editions", {
        status: "active",
        publicId,
        publisherId: plan.publisherId,
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
        revisionFields: { ...plan.fields, volumeCoverage: coverage },
      };
    }
    case "releases": {
      const editionId = resolved(plan.edition, temp);
      const edition = await ctx.db.get(editionId);
      if (!edition) return bad("New release's edition vanished mid-apply.");
      // Denorms maintained by the shared write path (spec §8).
      const seriesIds: Id<"series">[] = [];
      const coverageRows = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId))
        .collect();
      for (const row of coverageRows) {
        const volume = await ctx.db.get(row.volumeId);
        if (volume && !seriesIds.includes(volume.seriesId)) {
          seriesIds.push(volume.seriesId);
        }
      }
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
