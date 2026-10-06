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
// A member's placement of a held book (placement.ts) marks its Volume and
// Edition creates `joinExisting` too: a Volume of that label an import
// created meanwhile, or the sibling Edition it filed a Release under (same
// publisher, line, position and coverage), is reused, never duplicated. Its
// line is the one line of its name every state resolves to, and its
// Edition the one member every exact sibling resolves to, never the first
// open one. A matching record the placement may not join (a hidden Volume,
// one merged away, a hidden, merged or locked Edition or line, a second
// independent line or member) is never read as absent: the plan names it
// `unavailable` and the Proposal is stale. Its
// Edition may be Unmapped Packaging (`coverageUnmapped`, under a line, no
// coverage rows), and its Release names the observation it places
// (`placement`), which approval links to the new Release (proposals.ts).
// Only placement.ts writes `placement`, and only it and the importers write
// `joinExisting` (proposals.ts refuses both in a member's own ops).
//
// Hard invariants checked with every plan: no ISBN the proposal assigns — to
// a new Release or, through an update op, an existing one — ends up on two
// active Releases, and an Edition joins only a line of its own publisher
// under the base Series of the Volumes it covers.
//
// Validation (`planCreateOps`) runs at draft save, submission, and approval;
// application (`applyCreatePlan`) runs only inside the approval mutation.

import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { editionSeriesIds } from "./editionRows";
import { fail } from "./errors";
import { labelsEqual, survivorOf } from "./matching";
import {
  joinableEdition,
  namedEditionLine,
  siblingEditions,
  unmappedSiblings,
  volumePositionFor,
} from "./pipeline";
import { allocatePublicId } from "./publicIds";
import { assignedIsbnRefusal } from "./releaseIsbns";
import { seriesSearchText } from "./searchMatch";
import { fieldDescriptor, normalizeFieldValue, type RecordType } from "./moderationFields";

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
      /** Set when a `joinExisting` op resolved to this stored Volume: nothing is created. */
      existingId?: Id<"volumes">;
      unavailable?: Unjoinable;
    }
  | {
      table: "editionLines";
      tempId: string;
      series: RefTo<"series">;
      publisherId: Id<"publishers">;
      fields: { name: string };
      /** Set when a `joinExisting` op resolved to this stored line: nothing is created. */
      existingId?: Id<"editionLines">;
      unavailable?: Unjoinable;
    }
  | {
      table: "editions";
      tempId: string;
      publisherId: Id<"publishers">;
      coverage: CoveragePlan[];
      editionLine?: RefTo<"editionLines">;
      fields: { linePosition?: string; coverageUnmapped?: true };
      /** Set when a `joinExisting` op resolved to this stored sibling Edition: nothing is created. */
      existingId?: Id<"editions">;
      unavailable?: Unjoinable;
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
      /**
       * The held book this Release places, linked to it at approval, under
       * that Series, and which book its source named when the member stated
       * the placement (`reviewed`; absent on a placement written before it
       * was recorded, which nothing then trusts: placement.ts).
       */
      placement?: {
        observationId: Id<"sourceObservations">;
        seriesId: Id<"series">;
        reviewed?: string;
      };
    };

/** Bulk-operation cap: one coherent intent, not a mass migration. */
export const MAX_OPS_PER_PROPOSAL = 25;

/** Refuse an op set over the bulk cap (`bulkCap`). */
export function checkOpCount(count: number): void {
  if (count > MAX_OPS_PER_PROPOSAL) {
    fail(
      "bulkCap",
      `One proposal carries at most ${MAX_OPS_PER_PROPOSAL} operations — split unrelated work.`,
    );
  }
}

/** A stored record a placement's op matches but may not join (hidden, locked, merged away). */
type Unjoinable = { type: RecordType; id: string };

/** What a placement's `joinExisting` op resolves to: a stored record, one it may not join, or nothing. */
type Join<Table extends TableNames> = { existingId?: Id<Table>; unavailable?: Unjoinable };

/** Whether a create op carries a held book's `placement` (only placement.ts writes one). */
export const carriesPlacement = (op: CreateOpInput): boolean =>
  typeof op.fields === "object" && op.fields !== null && "placement" in op.fields;

/** Whether a create op is marked `joinExisting` (only placement.ts and the importers mark one). */
export const marksJoin = (op: CreateOpInput): boolean =>
  typeof op.fields === "object" && op.fields !== null && "joinExisting" in op.fields;

/** The records a plan's placement joins matched but may not join: the Proposal is stale. */
export const unjoinable = (plans: CreatePlan[]): Unjoinable[] =>
  plans.flatMap((plan) =>
    "unavailable" in plan && plan.unavailable !== undefined ? [plan.unavailable] : [],
  );

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
  const placing = ops.some(carriesPlacement);
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
            altTitles: (viaRegistry("series", "altTitles", fields.altTitles) ?? []) as string[],
            sourceStatus: viaRegistry("series", "sourceStatus", fields.sourceStatus) as
              | string
              | undefined,
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
        const label = viaRegistry("volume", "label", fields.label) as string | undefined;
        // A placement's Volume an import created meanwhile is that Volume.
        const join =
          fields.joinExisting === true && series.kind === "id"
            ? await joinedVolume(ctx, series.id, label)
            : {};
        plans.push({
          table,
          tempId: op.tempId,
          series,
          fields: {
            label,
            synopsis: viaRegistry("volume", "synopsis", fields.synopsis) as string | undefined,
          },
          ...join,
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
        if (placing && series.kind === "id") {
          // A placement's line is the one line of its name every state
          // resolves to (pipeline.ts namedEditionLine), never the first
          // active one beside a hidden, locked, unresolved or independent
          // twin; it creates the line only when no line of the name exists
          // in any state. A closed name is `unavailable`: the Proposal is
          // stale until a Moderator resolves it.
          if (twin) bad(`The edition line "${name}" is created twice by this proposal.`);
          const resolved = await namedEditionLine(ctx, { seriesId: series.id, publisherId, name });
          if (resolved.kind === "line" && fields.joinExisting !== true) {
            bad(
              `The edition line "${name}" already exists for this series and publisher — reference it instead.`,
            );
          }
          plans.push({
            table,
            tempId: op.tempId,
            series,
            publisherId,
            // Keep the requested namespace for the placement proof. The
            // stored survivor may have been renamed by its merge.
            fields: { name },
            ...(resolved.kind === "line" ? { existingId: resolved.line._id } : {}),
            ...(resolved.kind === "closed"
              ? { unavailable: { type: "editionLine", id: resolved.lineId } }
              : {}),
          });
          break;
        }
        const named =
          series.kind === "id"
            ? (
                await ctx.db
                  .query("editionLines")
                  .withIndex("by_series", (q) => q.eq("seriesId", series.id))
                  .collect()
              ).filter(
                (line) => line.publisherId === publisherId && line.name.toLowerCase() === wanted,
              )
            : [];
        const stored = named.find((line) => line.status === "active");
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
        const unmapped = fields.coverageUnmapped === true;
        const coverage = await planCoverage(ctx, fields, tempIds, unmapped);
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
        } else if (unmapped) {
          bad("Unmapped Packaging is a member of an Edition Line: name its line.");
        }
        const linePosition = viaRegistry("edition", "linePosition", fields.linePosition) as
          | string
          | undefined;
        const join =
          fields.joinExisting === true
            ? await storedSibling(
                ctx,
                { publisherId, coverage, editionLine, linePosition, unmapped },
                planByTemp,
              )
            : {};
        plans.push({
          table,
          tempId: op.tempId,
          publisherId,
          coverage,
          editionLine,
          fields: { linePosition, ...(unmapped ? { coverageUnmapped: true as const } : {}) },
          ...join,
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
        const binding = viaRegistry("release", "binding", fields.binding) as string | undefined;
        // Hard invariant (CONTEXT.md): Binding applies only to physical.
        if (format === "digital" && binding !== undefined) {
          bad("Binding applies only to physical releases.");
        }
        const language = viaRegistry("release", "language", fields.language);
        const isbn13 = viaRegistry("release", "isbn13", fields.isbn13) as string | undefined;
        const isbn10 = viaRegistry("release", "isbn10", fields.isbn10) as string | undefined;
        if (isbn13 !== undefined) isbnClaims.push({ field: "isbn13", isbn: isbn13, by: "create" });
        if (isbn10 !== undefined) isbnClaims.push({ field: "isbn10", isbn: isbn10, by: "create" });
        const placement =
          fields.placement === undefined ? undefined : await planPlacement(ctx, fields.placement);
        plans.push({
          table,
          tempId: op.tempId,
          edition,
          ...(placement !== undefined ? { placement } : {}),
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
            description: viaRegistry("release", "description", fields.description) as
              | string
              | undefined,
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

/**
 * One ISBN a proposal's final state assigns, the kind of op assigning it,
 * and for an update the Release it writes.
 */
type IsbnClaim = {
  field: IsbnField;
  isbn: string;
  by: "create" | "update";
  releaseId?: Id<"releases">;
};

/**
 * Release identity (CONTEXT.md): an ISBN names one Release. Checks the
 * proposal's final ISBN assignments — new Releases and updated ones alike —
 * against each other and against every active Release; and an ISBN with
 * Other Printings against every claim on it, hidden and merged ones
 * included (a Release may take one of its own printings' ISBNs as its
 * own). Approval runs this too, so a queued Proposal is checked against
 * the catalog as it is then. A holder whose same
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
    ...updates.flatMap(({ field, isbn, releaseId }): IsbnClaim[] =>
      isbn === undefined ? [] : [{ field, isbn, by: "update", releaseId }],
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
    // An ISBN with other printings is one Release's alone, active or
    // hidden (lib/releaseIsbns.ts): a Release may take its own printing's
    // ISBN as its own, and no other claim may remain but a primary this
    // proposal rewrites.
    const printed = await assignedIsbnRefusal(
      ctx,
      [isbn],
      claim.releaseId,
      (held) =>
        held.on !== "release" ||
        held.via === "printing" ||
        !rewritten.has(`${held.via}:${held.storedId}`),
    );
    if (printed !== null) {
      refuse(claim.by === "create", `${printed} Correct or merge that Release instead.`);
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

/**
 * What a placement's Volume of `label` joins in its Series: the active
 * Volume of the label. A Volume of the label that is hidden, or merged
 * into another (whose survivor, keeping the label in this Series, would be
 * the active one), is never read as absent: it is `unavailable`. The
 * reviewer saw a new Volume of that label, so a survivor of another label
 * is the author's to restate, not approval's to follow.
 */
async function joinedVolume(
  ctx: QueryCtx | MutationCtx,
  seriesId: Id<"series">,
  label: string | undefined,
): Promise<Join<"volumes">> {
  const sameLabel = (
    await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect()
  ).filter((volume) => labelsEqual(volume.label, label ?? null));
  const active = sameLabel.find((volume) => volume.status === "active");
  if (active !== undefined) return { existingId: active._id };
  return sameLabel[0] !== undefined
    ? { unavailable: { type: "volume", id: sameLabel[0]._id } }
    : {};
}

/**
 * The stored Edition a placement's `joinExisting` Edition resolves to: the
 * sibling an import created meanwhile under the same publisher, line and
 * position, covering exactly these Volumes, complete and in order
 * (pipeline.ts siblingEditions), or the line's unmapped member at that
 * position (unmappedSiblings). Every such sibling, in every state, must
 * resolve to one member (`oneMember`); the first open one is never chosen
 * beside a hidden, locked or independent one. Unmapped Packaging at no
 * known position proves no identity: beside any unmapped member at no
 * position it is `unavailable`. Nothing while any covered Volume or the
 * line is still to be created: no stored Edition can cover a record that
 * does not exist yet.
 */
async function storedSibling(
  ctx: QueryCtx | MutationCtx,
  edition: {
    publisherId: Id<"publishers">;
    coverage: CoveragePlan[];
    editionLine: RefTo<"editionLines"> | undefined;
    linePosition: string | undefined;
    unmapped: boolean;
  },
  planByTemp: Map<string, CreatePlan>,
): Promise<Join<"editions">> {
  let lineId: Id<"editionLines"> | null = null;
  if (edition.editionLine?.kind === "id") lineId = edition.editionLine.id;
  else if (edition.editionLine?.kind === "temp") {
    const plan = planByTemp.get(edition.editionLine.tempId);
    if (plan?.table !== "editionLines" || plan.existingId === undefined) return {};
    lineId = plan.existingId;
  }
  const line = lineId !== null ? { id: lineId, position: edition.linePosition ?? null } : null;
  let siblings: Doc<"editions">[] = [];
  if (edition.unmapped) {
    if (line === null) return {};
    siblings = await unmappedSiblings(ctx, edition.publisherId, line);
    if (line.position === null && siblings[0] !== undefined) {
      return { unavailable: { type: "edition", id: siblings[0]._id } };
    }
  } else {
    const volumeIds: Id<"volumes">[] = [];
    for (const row of [...edition.coverage].sort((a, b) => a.order - b.order)) {
      if (row.extent !== "complete") return {};
      if (row.volume.kind === "id") {
        volumeIds.push(row.volume.id);
        continue;
      }
      const plan = planByTemp.get(row.volume.tempId);
      if (plan?.table !== "volumes" || plan.existingId === undefined) return {};
      volumeIds.push(plan.existingId);
    }
    siblings = await siblingEditions(ctx, edition.publisherId, volumeIds, line);
  }
  return await oneMember(ctx, siblings);
}

/**
 * The one member a placement's siblings (storedSibling: every Edition, in
 * any state, of its publisher, line, position and contents) are: each
 * merged one answered by its survivor, which must be one of them, active
 * and unlocked. One hidden, locked or merged elsewhere, or two independent
 * ones (two Editions an import or an Editor made for the same book), is
 * `unavailable`: which one the book is, or whether either is, is a
 * Moderator's to settle, and the placement's form never names an Edition.
 * None: nothing to join.
 */
async function oneMember(
  ctx: QueryCtx | MutationCtx,
  siblings: Doc<"editions">[],
): Promise<Join<"editions">> {
  const exact = new Set(siblings.map((sibling) => sibling._id));
  const members = new Set<Id<"editions">>();
  for (const sibling of siblings) {
    const survivor = await survivorOf<"editions">(ctx, sibling);
    if (survivor === null || !exact.has(survivor._id) || !joinableEdition(survivor)) {
      return { unavailable: { type: "edition", id: sibling._id } };
    }
    members.add(survivor._id);
  }
  const [member, second] = members;
  if (second !== undefined) return { unavailable: { type: "edition", id: second } };
  return member !== undefined ? { existingId: member } : {};
}

/**
 * Validate a Release op's `placement`: it names an observation that exists
 * and a Series, and carries which book the member reviewed (`reviewed`,
 * passed through as written). Whether that book can still be placed under
 * that Series by these ops is placement.ts's question (checkPlacement),
 * asked at submission and approval; whether the Series is still active and
 * unlocked is a staleness question (unavailableCreateRefs).
 */
async function planPlacement(
  ctx: QueryCtx | MutationCtx,
  raw: unknown,
): Promise<{ observationId: Id<"sourceObservations">; seriesId: Id<"series">; reviewed?: string }> {
  const placement = asObject(raw, "release's placement");
  const observationId =
    typeof placement.observationId === "string"
      ? ctx.db.normalizeId("sourceObservations", placement.observationId)
      : null;
  const seriesId =
    typeof placement.seriesId === "string"
      ? ctx.db.normalizeId("series", placement.seriesId)
      : null;
  if (observationId === null || seriesId === null) {
    return bad("A placed release names its observation and Series by ID.");
  }
  if ((await ctx.db.get(observationId)) === null)
    return bad("The observation this release places no longer exists.");
  return {
    observationId,
    seriesId,
    ...(typeof placement.reviewed === "string" ? { reviewed: placement.reviewed } : {}),
  };
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
 * thrown `resolveRef`. A placement's joins count too (`unjoinable`): a
 * record it matches but may not join is unavailable the same way.
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
    const fields = op.fields as {
      publisherId?: unknown;
      publisherSlug?: unknown;
      placement?: unknown;
    } | null;
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
    // A placement goes under its Series only while the Series is open to
    // edits: hidden, merged or locked since, it is stale like any record.
    const placement = fields?.placement;
    const placed =
      typeof placement === "object" && placement !== null && "seriesId" in placement
        ? placement.seriesId
        : undefined;
    if (op.table === "releases" && typeof placed === "string") {
      const seriesId = ctx.db.normalizeId("series", placed);
      const series = seriesId !== null ? await ctx.db.get(seriesId) : null;
      if (series !== null && (series.status !== "active" || series.locked)) {
        unavailable.set(series._id, "series");
      }
    }
  }
  if (ops.some(carriesPlacement)) {
    // Ops that cannot be planned at all are planOps' to refuse, not stale.
    let plans: CreatePlan[] = [];
    try {
      plans = await planCreateOps(ctx, ops);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
    }
    for (const { type, id } of unjoinable(plans)) unavailable.set(id, type);
  }
  return [...unavailable].map(([id, type]) => ({ type, id }));
}

/**
 * Validate the ordered Volume Coverage of a new edition: at least one row,
 * or none for Unmapped Packaging (`unmapped`).
 */
async function planCoverage(
  ctx: QueryCtx | MutationCtx,
  fields: Record<string, unknown>,
  tempIds: Map<string, CreatableTable>,
  unmapped: boolean,
): Promise<CoveragePlan[]> {
  const raw = fields.volumeCoverage ?? [];
  if (unmapped) {
    if (Array.isArray(raw) && raw.length === 0) return [];
    return bad(
      "Unmapped Packaging covers no Volumes yet: drop its coverage rows or its unmapped mark.",
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return bad(
      "A new edition needs at least one volume coverage row: state the Volumes it covers, or mark it Unmapped Packaging under its line.",
    );
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
      typeof row.note === "string" && row.note.trim() !== "" ? row.note.trim() : undefined;
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
   * Edition Line, or a placement's Volume or Edition): nothing was
   * inserted, so it gets no creation Revision.
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
  // The stale gate stops these first; never create a twin of one.
  if ("unavailable" in plan && plan.unavailable !== undefined) {
    return bad(
      `A ${plan.unavailable.type} this placement matches is hidden, locked or merged away.`,
    );
  }
  switch (plan.table) {
    case "series": {
      const publicId = await allocatePublicId(ctx, "series");
      const id = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title: plan.fields.title,
        altTitles: plan.fields.altTitles,
        searchText: seriesSearchText(plan.fields.title, plan.fields.altTitles),
        sourceStatus: plan.fields.sourceStatus as Doc<"series">["sourceStatus"] | undefined,
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
      if (plan.existingId !== undefined) {
        temp.set(plan.tempId, plan.existingId);
        return {
          tempId: plan.tempId,
          ref: { type: "volume", id: plan.existingId },
          publicId: null,
          revisionFields: {},
          existing: true,
        };
      }
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
      if (plan.existingId !== undefined) {
        temp.set(plan.tempId, plan.existingId);
        return {
          tempId: plan.tempId,
          ref: { type: "edition", id: plan.existingId },
          publicId: null,
          revisionFields: {},
          existing: true,
        };
      }
      const publicId = await allocatePublicId(ctx, "edition");
      const editionLineId = plan.editionLine && resolved(plan.editionLine, temp);
      const id = await ctx.db.insert("editions", {
        status: "active",
        publicId,
        publisherId: plan.publisherId,
        editionLineId,
        linePosition: plan.fields.linePosition,
        ...(plan.fields.coverageUnmapped ? { coverageUnmapped: true as const } : {}),
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
