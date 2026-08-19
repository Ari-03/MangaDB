// The moderation core (ticket #31, spec §4/§5): immutable, versioned
// Proposals are the single write path for catalog changes. This slice
// implements the Administrator/Moderator direct edit — a save that is an
// immediately approved Proposal Version — producing one immutable public
// Revision per affected record, plus the public per-record history and the
// implicit Human Override marking. Editor submission and the review queue
// are the next slice; they reuse `applyUpdate` and grow the op set.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { editionCoverage, followMerges } from "./catalogPages";
import { recordRef } from "./schema";
import { requireModerator } from "./lib/roles";
import {
  EDITABLE_FIELDS,
  fieldDescriptor,
  normalizeFieldValue,
  type RecordType,
} from "./lib/moderationFields";
import { volumeTitle } from "./lib/titles";

// ---------- record refs & lookup ----------

const TABLE_FOR_TYPE = {
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

type CatalogTable = (typeof TABLE_FOR_TYPE)[RecordType];
type CatalogDoc = Doc<CatalogTable>;
type RecordRef = { type: RecordType; id: Id<CatalogTable> };

async function getCanonical(
  ctx: QueryCtx | MutationCtx,
  ref: RecordRef,
): Promise<CatalogDoc | null> {
  return (await ctx.db.get(ref.id)) as CatalogDoc | null;
}

/** Revisions of one record, newest first (the by_record index ends on seq). */
async function revisionsOf(ctx: QueryCtx | MutationCtx, ref: RecordRef) {
  return await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) =>
      q.eq("ref.type", ref.type).eq("ref.id", ref.id as never),
    )
    .order("desc")
    .collect();
}

// ---------- Human Override detection (spec §4, ticket #31) ----------

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
    const latestTouch = revisionsNewestFirst.find((rev) =>
      rev.changes.some((change) => change.field === field),
    );
    if (latestTouch && latestTouch.author.kind === "source") result.add(field);
  }
  return result;
}

// ---------- value plumbing ----------

/** Structural equality for field values (partial dates, prices, lists). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      if (!sameValue(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

type FieldChange = { field: string; before: unknown; after: unknown };

/**
 * Validate a submitted change set against the field registry and the current
 * doc, dropping no-ops. Throws ConvexError on anything malformed — both
 * submission and approval run this validation (spec §5); hard invariants are
 * never overridable.
 */
function validateChanges(
  type: RecordType,
  doc: CatalogDoc,
  submitted: Array<{ field: string; value: unknown }>,
): FieldChange[] {
  const seen = new Set<string>();
  const changes: FieldChange[] = [];
  const next: Record<string, unknown> = {};
  for (const { field, value } of submitted) {
    if (seen.has(field)) {
      throw new ConvexError({
        code: "invalidField",
        message: `Field "${field}" appears twice.`,
      });
    }
    seen.add(field);
    const descriptor = fieldDescriptor(type, field);
    if (!descriptor) {
      throw new ConvexError({
        code: "unknownField",
        message: `"${field}" is not an editable field of a ${type}.`,
      });
    }
    const normalized = normalizeFieldValue(descriptor, value);
    if (!normalized.ok) {
      throw new ConvexError({ code: "invalidField", message: normalized.message });
    }
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
      throw new ConvexError({
        code: "invalidField",
        message: "Binding applies only to physical releases.",
      });
    }
  }

  if (changes.length === 0) {
    throw new ConvexError({
      code: "noChanges",
      message: "Nothing changed — edit at least one field.",
    });
  }
  return changes;
}

// ---------- the approved-update write path ----------

/**
 * Apply one approved update op to its record: staleness check against the
 * base Revision, the patch itself (plus derived fields), implicit Human
 * Override marking, and the new immutable Revision. Shared by direct edits
 * today and the review-queue approval in the next slice.
 */
async function applyUpdate(
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
    throw new ConvexError({
      code: "stale",
      message:
        "This record changed since the edit was loaded. Reload and re-apply your change.",
    });
  }

  const patch: Record<string, unknown> = {};
  for (const change of changes) patch[change.field] = change.after;

  // Derived fields maintained by the shared write path (spec §8): the Series
  // search index concatenates title + altTitles.
  if (ref.type === "series") {
    const series = doc as Doc<"series">;
    const title = ("title" in patch ? patch.title : series.title) as string;
    const altTitles = ("altTitles" in patch
      ? patch.altTitles
      : series.altTitles) as string[];
    patch.searchText = [title, ...altTitles].join(" ");
  }

  // Implicit Human Override (spec §4): a human author's approved change to an
  // import-authored field joins the record's sticky overridden-fields list.
  // Only an explicit clearOverride op (a later slice) removes an entry.
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

  const revisionId = await ctx.db.insert("revisions", {
    ref: ref as never,
    seq: (latest?.seq ?? 0) + 1,
    proposalId: args.proposalId,
    author: args.author,
    approvedBy: args.approvedBy,
    changes,
    comment: args.comment,
  });
  return { revisionId, seq: (latest?.seq ?? 0) + 1 };
}

/**
 * The Administrator/Moderator direct edit (ticket #31): the form's save is an
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
    const ref = args.ref as RecordRef;

    const comment = args.comment.trim();
    if (comment === "") {
      throw new ConvexError({
        code: "commentRequired",
        message: "Every change needs a change comment.",
      });
    }

    const doc = await getCanonical(ctx, ref);
    if (!doc) {
      throw new ConvexError({ code: "notFound", message: "No such record." });
    }
    if (doc.status !== "active") {
      throw new ConvexError({
        code: "locked",
        message: `This record is ${doc.status} and locked against ordinary edits.`,
      });
    }
    if (doc.locked) {
      throw new ConvexError({
        code: "locked",
        message: "This record is temporarily locked.",
      });
    }

    const changes = validateChanges(ref.type, doc, args.changes);
    const author = {
      kind: "user" as const,
      userId: user._id,
      roleAtAuthorship: user.role,
    };
    const now = Date.now();

    // The immediately approved Proposal + its immutable version 1.
    const proposalId = await ctx.db.insert("proposals", {
      author,
      state: "approved",
      currentVersionNo: 1,
      submittedAt: now,
      decidedBy: user._id,
      decidedAt: now,
    });
    await ctx.db.insert("proposalVersions", {
      proposalId,
      versionNo: 1,
      ops: [
        {
          kind: "update",
          ref: ref as never,
          baseRevisionId: args.baseRevisionId,
          changes,
        },
      ],
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

const recordTypeArg = v.union(
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

/**
 * Resolve an edit-form key to its doc: the public ID for entities that have
 * one, the slug for publishers, the document ID otherwise. No merge
 * following — editing a merged loser is refused, not silently redirected.
 */
async function resolveEditTarget(
  ctx: QueryCtx,
  type: RecordType,
  key: string,
): Promise<CatalogDoc | null> {
  switch (type) {
    case "series": {
      const publicId = Number(key);
      if (!Number.isInteger(publicId)) return null;
      return await ctx.db
        .query("series")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
    }
    case "volume": {
      const publicId = Number(key);
      if (!Number.isInteger(publicId)) return null;
      return await ctx.db
        .query("volumes")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
    }
    case "edition": {
      const publicId = Number(key);
      if (!Number.isInteger(publicId)) return null;
      return await ctx.db
        .query("editions")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
    }
    case "releaseBundle": {
      const publicId = Number(key);
      if (!Number.isInteger(publicId)) return null;
      return await ctx.db
        .query("releaseBundles")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
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
type BackLink = {
  entity: "series" | "volume" | "edition" | "bundle";
  publicId: number;
  title: string;
} | null;

async function displayInfo(
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
 * Everything the direct-edit form needs (moderator/administrator only): the
 * record's editable fields with current values (straight from the registry
 * the mutation validates against), the base Revision for the staleness
 * check, and the record's overridden-fields list.
 */
export const editForm = query({
  args: { type: recordTypeArg, key: v.string() },
  handler: async (ctx, { type, key }) => {
    await requireModerator(ctx);
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
      baseRevisionId: history[0]?._id ?? null,
      fields: EDITABLE_FIELDS[type].map((descriptor) => ({
        ...descriptor,
        value: (doc as Record<string, unknown>)[descriptor.name] ?? null,
      })),
      backLink,
    };
  },
});

// ---------- public revision history (spec §5, ticket #31) ----------

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
    let resolved: CatalogDoc | null = null;
    if (type === "series") {
      const stored = await ctx.db
        .query("series")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
      // Series merges resolve like every other record; catalog.ts's
      // resolveActiveSeries predates the shared helper.
      let current = stored;
      const visited = new Set<string>();
      while (current && current.status === "merged" && current.mergedIntoId) {
        if (visited.has(current._id)) return null;
        visited.add(current._id);
        current = await ctx.db.get(current.mergedIntoId);
      }
      resolved = current && current.status === "active" ? current : null;
    } else {
      const table = TABLE_FOR_TYPE[type];
      const stored = await ctx.db
        .query(table as "volumes")
        .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
        .unique();
      resolved = await followMerges(ctx, table as "volumes", stored);
    }
    if (!resolved) return null;

    const ref = { type, id: resolved._id } as RecordRef;
    const revisions = await revisionsOf(ctx, ref);

    const usernameCache = new Map<Id<"users">, string | null>();
    const usernameOf = async (userId: Id<"users">) => {
      if (!usernameCache.has(userId)) {
        const user = await ctx.db.get(userId);
        usernameCache.set(userId, user?.username ?? null);
      }
      return usernameCache.get(userId) ?? null;
    };

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
        approver: revision.approvedBy
          ? await usernameOf(revision.approvedBy)
          : null,
        citation: revision.citation ?? null,
      });
    }
    return {
      overriddenFields: resolved.overriddenFields ?? [],
      revisions: entries,
    };
  },
});
