// The moderation core (spec §4/§5): immutable, versioned Proposals are the
// single write path for catalog changes. This module holds the
// Administrator/Moderator direct edit — a save that is an immediately
// approved Proposal Version — producing one immutable public Revision per
// affected record, plus the public per-record history, the implicit Human
// Override marking and the clear that lifts one. Editor submission and the
// review queue live in proposals.ts and reuse `applyUpdate`,
// `applyClearOverride`, `validateChanges`, and the record plumbing exported
// here.

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { editionCoverage } from "./catalogPages";
import { followMerges } from "./lib/merges";
import { getSourceByKey } from "./importSources";
import { recordRef, recordType } from "./schema";
import { liveUser } from "./lib/auth";
import { latestTouch } from "./lib/authority";
import { fail } from "./lib/errors";
import { ratedByDataTeam, syncMatureProjection } from "./lib/mature";
import { anchoredOn, currentOps } from "./lib/observations";
import { requireDataTeam, requireModerator } from "./lib/roles";
import {
  EDITABLE_FIELDS,
  fieldDescriptor,
  normalizeFieldValue,
  type RecordType,
} from "./lib/moderationFields";
import { seriesSearchText } from "./lib/searchMatch";
import type { OpMeta } from "./lib/sensitiveOps";
import { volumeTitle } from "./lib/titles";
import { usernameLookup } from "./lib/usernameLookup";
import { sameValue } from "./lib/values";

// ---------- record refs & lookup ----------

export const TABLE_FOR_TYPE = {
  publisher: "publishers",
  seriesFamily: "seriesFamilies",
  series: "series",
  volume: "volumes",
  editionLine: "editionLines",
  edition: "editions",
  release: "releases",
  releaseVariant: "releaseVariants",
  releaseBundle: "releaseBundles",
} as const;

export type CatalogTable = (typeof TABLE_FOR_TYPE)[RecordType];
export type CatalogDoc = Doc<CatalogTable>;
export type RecordRef = Infer<typeof recordRef>;

export async function getCanonical(
  ctx: QueryCtx | MutationCtx,
  ref: RecordRef,
): Promise<CatalogDoc | null> {
  return await ctx.db.get(ref.id);
}

/** One record's newest Revision, read alone: its history can be long. */
export async function latestRevisionOf(ctx: QueryCtx | MutationCtx, ref: RecordRef) {
  return await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .order("desc")
    .first();
}

/** Revisions of one record, newest first (the by_record index ends on seq). */
export async function revisionsOf(ctx: QueryCtx | MutationCtx, ref: RecordRef) {
  return await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .order("desc")
    .collect();
}

// ---------- Human Override detection (spec §4) ----------

/**
 * Which of `fields` are currently import-authored on this record: the most
 * recent Revision that touched the field (creations list every initial
 * field) was authored by a source. Records that predate revision history
 * have no import provenance, so nothing is marked. An approved human change
 * to an import-authored field implicitly becomes a sticky Human Override.
 */
function importAuthoredFields(
  revisionsNewestFirst: Array<Doc<"revisions">>,
  fields: string[],
): Set<string> {
  const result = new Set<string>();
  for (const field of fields) {
    if (latestTouch(revisionsNewestFirst, field)?.author.kind === "source") result.add(field);
  }
  return result;
}

// ---------- value plumbing ----------

export type FieldChange = { field: string; before: unknown; after: unknown };

/**
 * Validate a submitted change set against the field registry and the current
 * doc, dropping no-ops. Throws ConvexError on anything malformed — both
 * submission and approval run this validation (spec §5); hard invariants are
 * never overridable.
 */
export function validateChanges(
  type: RecordType,
  doc: CatalogDoc,
  submitted: Array<{ field: string; value: unknown }>,
): FieldChange[] {
  const seen = new Set<string>();
  const changes: FieldChange[] = [];
  const next: Record<string, unknown> = {};
  for (const { field, value } of submitted) {
    if (seen.has(field)) fail("invalidField", `Field "${field}" appears twice.`);
    seen.add(field);
    const descriptor = fieldDescriptor(type, field);
    if (!descriptor) fail("unknownField", `"${field}" is not an editable field of a ${type}.`);
    const normalized = normalizeFieldValue(descriptor, value);
    if (!normalized.ok) fail("invalidField", normalized.message);
    const before = (doc as Record<string, unknown>)[field];
    next[field] = normalized.value;
    if (sameValue(before, normalized.value)) continue;
    changes.push({ field, before, after: normalized.value });
  }

  // Hard invariant (CONTEXT.md): Binding applies only to physical Releases.
  if (type === "release") {
    const release = doc as Doc<"releases">;
    const binding = "binding" in next ? next.binding : release.binding;
    if (release.format === "digital" && binding !== undefined) {
      fail("invalidField", "Binding applies only to physical releases.");
    }
  }

  if (changes.length === 0) fail("noChanges", "Nothing changed — edit at least one field.");
  return changes;
}

// ---------- the approved-update write path ----------

type Author = Doc<"proposals">["author"];

/**
 * A Proposal approved as it is made (direct edits, sensitive operations,
 * the data repair): its author's approver decides it at submission.
 */
export async function insertApprovedProposal(
  ctx: MutationCtx,
  author: Author,
  approvedBy: Id<"users">,
): Promise<Id<"proposals">> {
  const now = Date.now();
  return await ctx.db.insert("proposals", {
    author,
    state: "approved",
    currentVersionNo: 1,
    submittedAt: now,
    decidedBy: approvedBy,
    decidedAt: now,
  });
}

/** A Proposal's immutable version 1. */
export async function insertFirstVersion(
  ctx: MutationCtx,
  proposalId: Id<"proposals">,
  version: Pick<Doc<"proposalVersions">, "ops" | "evidence" | "changeComment">,
): Promise<void> {
  await ctx.db.insert("proposalVersions", { proposalId, versionNo: 1, ...version });
}

/**
 * Append the next immutable Revision to one record's history. `latest` is
 * the record's newest Revision as the caller read it (none for a record
 * just created), and the new one's `seq` follows it.
 */
export async function insertRevision(
  ctx: MutationCtx,
  ref: RecordRef,
  latest: Doc<"revisions"> | null | undefined,
  changes: Doc<"revisions">["changes"],
  meta: OpMeta,
) {
  const seq = (latest?.seq ?? 0) + 1;
  const revisionId = await ctx.db.insert("revisions", {
    ref,
    seq,
    proposalId: meta.proposalId,
    author: meta.author,
    approvedBy: meta.approvedBy,
    changes,
    comment: meta.comment,
  });
  return { revisionId, seq };
}

/**
 * Apply one approved update op to its record: staleness check against the
 * base Revision, the patch itself (plus derived fields), implicit Human
 * Override marking, and the new immutable Revision. Shared by direct edits
 * and review-queue approval.
 */
export async function applyUpdate(
  ctx: MutationCtx,
  args: {
    ref: RecordRef;
    doc: CatalogDoc;
    baseRevisionId: Id<"revisions"> | null;
    changes: FieldChange[];
    proposalId: Id<"proposals">;
    author: Doc<"proposals">["author"];
    approvedBy: Id<"users">;
    comment: string;
  },
) {
  const { ref, doc, changes } = args;
  const history = await revisionsOf(ctx, ref);
  const latest = history[0] ?? null;

  // Staleness (spec §5): the op recorded the record's base Revision; any
  // base change before approval requires an explicit rebase, never a silent
  // one. For a direct edit this surfaces as "reload and re-edit".
  if ((latest?._id ?? null) !== args.baseRevisionId) {
    fail(
      "stale",
      "This record changed since the edit was loaded. Reload and re-apply your change.",
    );
  }

  const patch: Record<string, unknown> = {};
  for (const change of changes) patch[change.field] = change.after;

  // Derived fields maintained by the shared write path (spec §8): the Series
  // search index concatenates title + altTitles.
  if (ref.type === "series") {
    const series = doc as Doc<"series">;
    const title = ("title" in patch ? patch.title : series.title) as string;
    const altTitles = ("altTitles" in patch ? patch.altTitles : series.altTitles) as string[];
    patch.searchText = seriesSearchText(title, altTitles);
    // A content rating decides `mature` now rather than at the next
    // library rebuild; clearing it hands the call back to the evidence,
    // which that rebuild re-reads (lib/mature.ts).
    const rated =
      "contentRating" in patch
        ? ratedByDataTeam(patch.contentRating as Doc<"series">["contentRating"])
        : null;
    if (rated !== null) {
      patch.mature = rated ? true : undefined;
      // The library's projections follow now too, not at the next rebuild.
      await syncMatureProjection(ctx, series, rated);
    }
  }

  // Implicit Human Override (spec §4): a human author's approved change to an
  // import-authored field joins the record's sticky overridden-fields list.
  // Only an approved clearOverride op removes an entry (`applyClearOverride`).
  if (args.author.kind === "user") {
    const overridden = importAuthoredFields(
      history,
      changes.map((c) => c.field),
    );
    if (overridden.size > 0) {
      const merged = new Set([...(doc.overriddenFields ?? []), ...overridden]);
      patch.overriddenFields = [...merged].sort();
    }
  }

  await ctx.db.patch(ref.id, patch as never);
  return await insertRevision(ctx, ref, latest, changes, args);
}

// ---------- lifting a Human Override ----------

/**
 * Refuse a clearOverride of anything but an editable field that is on the
 * record's overriddenFields. Drafting and applying both check it.
 */
export function requireOverridden(type: RecordType, doc: CatalogDoc, field: string): void {
  if (!fieldDescriptor(type, field)) {
    fail("unknownField", `"${field}" is not an editable field of a ${type}.`);
  }
  if (!(doc.overriddenFields ?? []).includes(field)) {
    fail("notOverridden", `"${field}" carries no Human Override.`);
  }
}

/**
 * Lift one Human Override: take `field` off an active, unlocked record's
 * overriddenFields and record that list's before and after as a Revision.
 * The field's value and the Revisions that wrote it stay as they are, so an
 * import's next differing value still queues when a human wrote the value
 * and follows Field Authority when a source did (`decideField`). `baseRevisionId`
 * is the record's newest Revision as the caller last saw it. Shared by
 * review-queue approval and the Moderator's direct clear.
 */
export async function applyClearOverride(
  ctx: MutationCtx,
  args: {
    ref: RecordRef;
    field: string;
    baseRevisionId: Id<"revisions"> | null;
    meta: OpMeta;
  },
) {
  const { ref, field } = args;
  const doc = await getCanonical(ctx, ref);
  if (!doc) fail("notFound", "No such record.");
  if (doc.status !== "active") {
    fail("locked", `This record is ${doc.status} and locked against ordinary edits.`);
  }
  if (doc.locked) fail("locked", "This record is temporarily locked.");
  requireOverridden(ref.type, doc, field);
  const latest = (await revisionsOf(ctx, ref))[0] ?? null;
  if ((latest?._id ?? null) !== args.baseRevisionId) {
    fail("stale", "This record changed since the override was loaded. Reload and try again.");
  }
  const before = doc.overriddenFields ?? [];
  const after = before.filter((name) => name !== field);
  await ctx.db.patch(ref.id, { overriddenFields: after.length > 0 ? after : undefined });
  return await insertRevision(
    ctx,
    ref,
    latest,
    [{ field: "overriddenFields", before, after }],
    args.meta,
  );
}

/**
 * The Moderator's direct clear of one Human Override, recorded like a
 * direct edit: an immediately approved Proposal whose one clearOverride op
 * the Moderator approves, and one public Revision carrying the reason.
 */
export const submitDirectClear = mutation({
  args: {
    ref: recordRef,
    field: v.string(),
    baseRevisionId: v.optional(v.id("revisions")),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const comment = args.comment.trim();
    if (comment === "") fail("commentRequired", "Every change needs a change comment.");
    const { ref, field } = args;
    const author = { kind: "user" as const, userId: user._id, roleAtAuthorship: user.role };
    const proposalId = await insertApprovedProposal(ctx, author, user._id);
    await insertFirstVersion(ctx, proposalId, {
      ops: [{ kind: "clearOverride", ref, field, baseRevisionId: args.baseRevisionId }],
      evidence: [],
      changeComment: comment,
    });
    const { revisionId, seq } = await applyClearOverride(ctx, {
      ref,
      field,
      baseRevisionId: args.baseRevisionId ?? null,
      meta: { proposalId, author, approvedBy: user._id, comment },
    });
    return { proposalId, revisionId, seq };
  },
});

export type WrittenBy =
  | { kind: "human" }
  | { kind: "source"; sourceKey: string }
  | { kind: "unrecorded" };

/**
 * Who wrote a field's current value, as the import rules weigh it: the
 * latest Revision touching it (`latestTouch`), or none on record. Shown
 * beside a Human Override so whoever lifts it knows what imports will do.
 */
export function writtenBy(revisionsNewestFirst: Array<Doc<"revisions">>, field: string): WrittenBy {
  const author = latestTouch(revisionsNewestFirst, field)?.author;
  if (!author) return { kind: "unrecorded" };
  return author.kind === "user"
    ? { kind: "human" }
    : { kind: "source", sourceKey: author.sourceKey };
}

/**
 * The Administrator/Moderator direct edit: the form's save is an
 * immediately approved Proposal Version — the same machinery as reviewed
 * proposals, with the author as approver — producing one immutable public
 * Revision. Hidden and merged records are locked against ordinary edits, as
 * are explicitly locked records (spec §5).
 */
export const submitDirectEdit = mutation({
  args: {
    ref: recordRef,
    baseRevisionId: v.optional(v.id("revisions")),
    changes: v.array(v.object({ field: v.string(), value: v.any() })),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const ref = args.ref;

    const comment = args.comment.trim();
    if (comment === "") fail("commentRequired", "Every change needs a change comment.");

    const doc = await getCanonical(ctx, ref);
    if (!doc) fail("notFound", "No such record.");
    if (doc.status !== "active") {
      fail("locked", `This record is ${doc.status} and locked against ordinary edits.`);
    }
    if (doc.locked) fail("locked", "This record is temporarily locked.");

    const changes = validateChanges(ref.type, doc, args.changes);
    const author = {
      kind: "user" as const,
      userId: user._id,
      roleAtAuthorship: user.role,
    };

    const proposalId = await insertApprovedProposal(ctx, author, user._id);
    await insertFirstVersion(ctx, proposalId, {
      ops: [{ kind: "update", ref, baseRevisionId: args.baseRevisionId, changes }],
      evidence: [],
      changeComment: comment,
    });

    const { revisionId, seq } = await applyUpdate(ctx, {
      ref,
      doc,
      baseRevisionId: args.baseRevisionId ?? null,
      changes,
      proposalId,
      author,
      approvedBy: user._id,
      comment,
    });
    return { proposalId, revisionId, seq };
  },
});

// ---------- the edit form (moderator/administrator) ----------

/**
 * The stored record with this public ID, merged or hidden ones included.
 * The four tables that carry one share the by_publicId index, so one
 * table's typing serves for all of them.
 */
function storedByPublicId(
  ctx: QueryCtx,
  table: "series" | "volumes" | "editions" | "releaseBundles",
  publicId: number,
) {
  return ctx.db
    .query(table as "volumes")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
}

/**
 * Resolve an edit-form key to its doc: the public ID for entities that have
 * one, the slug for publishers, the document ID otherwise. No merge
 * following — editing a merged loser is refused, not silently redirected.
 */
export async function resolveEditTarget(
  ctx: QueryCtx,
  type: RecordType,
  key: string,
): Promise<CatalogDoc | null> {
  switch (type) {
    case "series":
    case "volume":
    case "edition":
    case "releaseBundle": {
      const publicId = Number(key);
      if (!Number.isInteger(publicId)) return null;
      return await storedByPublicId(ctx, TABLE_FOR_TYPE[type], publicId);
    }
    case "publisher":
      return await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", key))
        .unique();
    default: {
      const id = ctx.db.normalizeId(TABLE_FOR_TYPE[type], key);
      return id ? ((await ctx.db.get(id)) as CatalogDoc | null) : null;
    }
  }
}

/** Where the edit form links back to, as `/{entity}/{publicId}/{slug}` input. */
export type BackLink = {
  entity: "series" | "volume" | "edition" | "bundle";
  publicId: number;
  title: string;
} | null;

export async function displayInfo(
  ctx: QueryCtx,
  type: RecordType,
  doc: CatalogDoc,
): Promise<{ title: string; backLink: BackLink }> {
  switch (type) {
    case "series": {
      const series = doc as Doc<"series">;
      return {
        title: series.title,
        backLink: {
          entity: "series",
          publicId: series.publicId,
          title: series.title,
        },
      };
    }
    case "volume": {
      const volume = doc as Doc<"volumes">;
      const series = await ctx.db.get(volume.seriesId);
      const title = volumeTitle(series?.title ?? "Unknown series", volume.label ?? null);
      return {
        title,
        backLink: { entity: "volume", publicId: volume.publicId, title },
      };
    }
    case "edition": {
      const edition = doc as Doc<"editions">;
      const { title } = await editionCoverage(ctx, edition);
      return {
        title,
        backLink: { entity: "edition", publicId: edition.publicId, title },
      };
    }
    case "release": {
      const release = doc as Doc<"releases">;
      const edition = await ctx.db.get(release.editionId);
      if (!edition) return { title: "Release", backLink: null };
      const { title } = await editionCoverage(ctx, edition);
      return {
        title: `${title} — ${release.format}${release.binding ? ` (${release.binding})` : ""} release`,
        backLink: { entity: "edition", publicId: edition.publicId, title },
      };
    }
    case "releaseBundle": {
      const bundle = doc as Doc<"releaseBundles">;
      return {
        title: bundle.name,
        backLink: {
          entity: "bundle",
          publicId: bundle.publicId,
          title: bundle.name,
        },
      };
    }
    case "publisher":
      return { title: (doc as Doc<"publishers">).name, backLink: null };
    case "seriesFamily":
      return { title: (doc as Doc<"seriesFamilies">).name, backLink: null };
    case "editionLine":
      return { title: (doc as Doc<"editionLines">).name, backLink: null };
    case "releaseVariant":
      return { title: (doc as Doc<"releaseVariants">).name, backLink: null };
  }
}

/**
 * Everything the edit and propose forms need (Data Team only): the record's
 * editable fields with current values (straight from the registry the
 * mutations validate against), the base Revision for the staleness check,
 * the record's overridden-fields list, and for each overridden editable
 * field who wrote its value (what clearing it would leave imports to weigh),
 * and whether an import's Proposal on the record waits in review (which a
 * clear, moving the base, would leave stale).
 * Editors use it to draft update and clearOverride Proposals; Moderators for
 * direct edits and clears — the mutations re-check the stronger role.
 */
export const editForm = query({
  args: { type: recordType, key: v.string() },
  handler: async (ctx, { type, key }) => {
    await requireDataTeam(ctx);
    const doc = await resolveEditTarget(ctx, type, key);
    if (!doc) return null;
    const ref = { type, id: doc._id } as RecordRef;
    const history = await revisionsOf(ctx, ref);
    const { title, backLink } = await displayInfo(ctx, type, doc);
    return {
      ref: { type, id: doc._id as string },
      title,
      status: doc.status,
      locked: doc.locked ?? false,
      overriddenFields: doc.overriddenFields ?? [],
      overrides: (doc.overriddenFields ?? []).flatMap((field) => {
        const descriptor = fieldDescriptor(type, field);
        return descriptor
          ? [{ field, label: descriptor.label, writtenBy: writtenBy(history, field) }]
          : [];
      }),
      baseRevisionId: history[0]?._id ?? null,
      importReviewPending: await importReviewPending(ctx, ref),
      fields: EDITABLE_FIELDS[type].map((descriptor) => ({
        ...descriptor,
        value: (doc as Record<string, unknown>)[descriptor.name] ?? null,
      })),
      backLink,
    };
  },
});

// ---------- source blurbs (reviewer visibility) ----------

/** Observations read per record; a record links a handful of sources in practice. */
const BLURB_OBSERVATION_CAP = 50;

/**
 * Whether an observation linked to the record has queued a Proposal, still
 * in review, that changes this record against its base Revision (an import's
 * field conflict; anchoredOn). A source's Proposal cannot be rebased, so any
 * Revision on the record leaves it stale until the source record next
 * changes. A cancellation review (a `hide`) is not stranded and does not
 * count. Past the observation cap it answers null: not known.
 */
async function importReviewPending(ctx: QueryCtx, ref: RecordRef): Promise<boolean | null> {
  const observations = await ctx.db
    .query("sourceObservations")
    .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", ref.id))
    .take(BLURB_OBSERVATION_CAP + 1);
  if (observations.length > BLURB_OBSERVATION_CAP) return null;
  for (const { queuedProposalId } of observations) {
    const proposal = queuedProposalId ? await ctx.db.get(queuedProposalId) : null;
    if (proposal?.state !== "inReview") continue;
    if ((await currentOps(ctx, proposal)).some((op) => anchoredOn(op, ref))) return true;
  }
  return false;
}

/** A non-empty string, or null: snapshots are `v.any()` and adapters evolve. */
function blurbText(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Every blurb a source offered for one Release (its description) or Series
 * (its synopsis), for the edit form's review panel: one entry per linked
 * observation's current snapshot text, plus any recordOnly conflict entry
 * whose text differs from it. Also which text is canonical now and who
 * authored it (the latest Revision touching the field, as reconciliation
 * resolves the incumbent). Moderator/Administrator only.
 */
export const sourceBlurbs = query({
  args: {
    ref: v.object({
      type: v.union(v.literal("release"), v.literal("series")),
      id: v.string(),
    }),
  },
  handler: async (ctx, { ref }) => {
    await requireModerator(ctx);
    const id = ctx.db.normalizeId(TABLE_FOR_TYPE[ref.type], ref.id);
    const doc = id ? await ctx.db.get(id) : null;
    if (!id || !doc) return null;
    const field = ref.type === "release" ? "description" : "synopsis";
    const canonicalText = blurbText((doc as Record<string, unknown>)[field]);

    const touch = latestTouch(await revisionsOf(ctx, { type: ref.type, id } as RecordRef), field);
    const author =
      touch === undefined
        ? null
        : touch.author.kind === "user"
          ? {
              kind: "user" as const,
              username: (await liveUser(ctx, touch.author.userId))?.username ?? null,
            }
          : { kind: "source" as const, sourceKey: touch.author.sourceKey };

    const observations = await ctx.db
      .query("sourceObservations")
      .withIndex("by_record", (q) => q.eq("recordRef.type", ref.type).eq("recordRef.id", id))
      .take(BLURB_OBSERVATION_CAP + 1);

    const sourceNames = new Map<string, string>();
    const sourceName = async (key: string) => {
      if (!sourceNames.has(key)) {
        sourceNames.set(key, (await getSourceByKey(ctx, key))?.name ?? key);
      }
      return sourceNames.get(key) ?? key;
    };

    const blurbs = [];
    for (const observation of observations.slice(0, BLURB_OBSERVATION_CAP)) {
      const snapshot: Record<string, unknown> =
        typeof observation.snapshot === "object" && observation.snapshot !== null
          ? observation.snapshot
          : {};
      const conflict = (observation.conflicts ?? []).find((c) => c.field === field);
      const recorded = conflict
        ? { text: blurbText(conflict.offered), reason: conflict.reason, at: conflict.at }
        : null;
      const offeredNow = blurbText(snapshot[field]);
      const base = {
        observationId: observation._id,
        sourceKey: observation.sourceKey,
        sourceName: await sourceName(observation.sourceKey),
        url: blurbText(snapshot.url),
        lastSeenAt: observation.lastSeenAt,
        withdrawn: observation.withdrawn,
      };
      // A recordOnly entry names the offer that lost; it rides on the matching
      // snapshot text, or stands alone when the snapshot has since moved on.
      const texts = [
        ...(offeredNow !== null ? [offeredNow] : []),
        ...(recorded?.text && recorded.text !== offeredNow ? [recorded.text] : []),
      ];
      for (const text of texts) {
        const current = text === canonicalText;
        blurbs.push({
          ...base,
          text,
          current,
          recordedOnly:
            recorded?.text === text && !current
              ? { reason: recorded.reason, at: recorded.at }
              : null,
        });
      }
    }

    return {
      field,
      canonical: {
        text: canonicalText,
        author,
        overridden: (doc.overriddenFields ?? []).includes(field),
      },
      blurbs,
      truncated: observations.length > BLURB_OBSERVATION_CAP,
    };
  },
});

// ---------- public revision history (spec §5) ----------

const historyTargetArg = v.union(
  v.literal("series"),
  v.literal("volume"),
  v.literal("edition"),
  v.literal("releaseBundle"),
);

/**
 * A record's public history, newest first: final diff, author, approver,
 * timestamp, change comment, and source citation when the change was
 * imported (spec §5 — internal discussion, pending and rejected proposals
 * stay private). Merged records resolve to their survivor, matching the
 * page the reader is on; hidden records read as absent.
 */
export const recordHistory = query({
  args: { type: historyTargetArg, publicId: v.number() },
  handler: async (ctx, { type, publicId }) => {
    const table = TABLE_FOR_TYPE[type];
    const resolved: CatalogDoc | null = await followMerges(
      ctx,
      table as "volumes",
      await storedByPublicId(ctx, table, publicId),
    );
    if (!resolved) return null;

    const ref = { type, id: resolved._id } as RecordRef;
    const revisions = await revisionsOf(ctx, ref);
    const usernameOf = usernameLookup(ctx);

    const entries = [];
    for (const revision of revisions) {
      entries.push({
        seq: revision.seq,
        at: revision._creationTime,
        comment: revision.comment,
        changes: revision.changes,
        author:
          revision.author.kind === "user"
            ? {
                kind: "user" as const,
                username: await usernameOf(revision.author.userId),
                role: revision.author.roleAtAuthorship ?? null,
              }
            : {
                kind: "source" as const,
                sourceKey: revision.author.sourceKey,
              },
        approver: revision.approvedBy ? await usernameOf(revision.approvedBy) : null,
        citation: revision.citation ?? null,
      });
    }
    return {
      overriddenFields: resolved.overriddenFields ?? [],
      revisions: entries,
    };
  },
});
