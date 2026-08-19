// Reading tracking (ticket #28, spec §3): Series Reading Status, Release
// Progress passes, and Volume Progress read counts.
//
// The invariants, straight from the glossary (CONTEXT.md):
// - Series Reading Status is set only by explicit choice. The start-reading
//   and completed-series prompts are suggestions computed here and rendered
//   client-side; only setSeriesReadingStatus ever writes the status, and it
//   runs only when the user picks or confirms.
// - A Release Progress pass carries an optional 0–100% estimate. Reaching
//   100% never completes anything — completePass is a separate, explicitly
//   confirmed mutation.
// - Confirmed completion increments Volume Progress (durable,
//   edition-independent read counts) for every *completely* covered Volume;
//   partial coverage is untouched. Another completed pass is a reread.
// - Undo of the most recent completion decrements. The completion timestamp
//   identifies the event: undo only decrements Volumes whose
//   lastCompletedAt still matches, so a later reread makes the older undo a
//   no-op for that Volume.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { resolveActiveSeries } from "./catalog";
import { editionCoverage, followMerges } from "./catalogPages";
import { getUserBySubject, requireUser } from "./lib/auth";
import { releaseAnchor } from "./lib/titles";

// Mirrors the userSeriesStates.readingStatus union in schema.ts.
const readingStatusValidator = v.union(
  v.literal("planToRead"),
  v.literal("reading"),
  v.literal("paused"),
  v.literal("dropped"),
  v.literal("completed"),
);

// ---------- shared lookups ----------

/**
 * The viewer's User for personal *queries*: null when signed out or the
 * username claim is pending, so overlay queries render as "nothing to show"
 * instead of erroring on public pages. Mutations use requireUser instead.
 */
async function viewerOrNull(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await getUserBySubject(ctx, identity.subject);
}

/** The Release resolved through merges; throws when unknown or hidden. */
async function requireActiveRelease(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
): Promise<Doc<"releases">> {
  const release = await followMerges(ctx, "releases", await ctx.db.get(releaseId));
  if (!release) {
    throw new ConvexError({ code: "notFound", message: "Release not found." });
  }
  return release;
}

/** The Series resolved through merges; throws when unknown or hidden. */
async function requireActiveSeries(
  ctx: QueryCtx,
  seriesId: Id<"series">,
): Promise<Doc<"series">> {
  const series = await followMerges(ctx, "series", await ctx.db.get(seriesId));
  if (!series) {
    throw new ConvexError({ code: "notFound", message: "Series not found." });
  }
  return series;
}

async function seriesStateRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
) {
  return await ctx.db
    .query("userSeriesStates")
    .withIndex("by_user_series", (q) =>
      q.eq("userId", userId).eq("seriesId", seriesId),
    )
    .unique();
}

async function volumeProgressRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  volumeId: Id<"volumes">,
) {
  return await ctx.db
    .query("volumeProgress")
    .withIndex("by_user_volume", (q) =>
      q.eq("userId", userId).eq("volumeId", volumeId),
    )
    .unique();
}

async function passRowFor(
  ctx: QueryCtx,
  userId: Id<"users">,
  releaseId: Id<"releases">,
) {
  return await ctx.db
    .query("releaseProgress")
    .withIndex("by_user_release", (q) =>
      q.eq("userId", userId).eq("releaseId", releaseId),
    )
    .unique();
}

/**
 * The active Volumes a Release covers *completely* — the exact set a
 * confirmed completion increments (spec §3); partial coverage never appears
 * here. Coverage lives on the Edition, so all of an Edition's Releases share
 * it. Volumes are merge-resolved and deduplicated by surviving identity.
 */
async function completelyCoveredVolumes(
  ctx: QueryCtx,
  release: Doc<"releases">,
): Promise<Array<Doc<"volumes">>> {
  const rows = await ctx.db
    .query("volumeCoverages")
    .withIndex("by_edition", (q) => q.eq("editionId", release.editionId))
    .collect();
  const volumes = new Map<Id<"volumes">, Doc<"volumes">>();
  for (const row of rows) {
    if (row.extent !== "complete") continue;
    const volume = await followMerges(ctx, "volumes", await ctx.db.get(row.volumeId));
    if (volume) volumes.set(volume._id, volume);
  }
  return [...volumes.values()];
}

/**
 * The denormalized seriesId for a new releaseProgress row: the Release's
 * first covered Series, merge-resolved. A Release without any coverage has
 * no Series to attribute the pass to, so tracking it is rejected.
 */
async function passSeriesId(
  ctx: QueryCtx,
  release: Doc<"releases">,
): Promise<Id<"series">> {
  const first = release.seriesIds[0];
  if (first) {
    const series = await followMerges(ctx, "series", await ctx.db.get(first));
    if (series) return series._id;
  }
  throw new ConvexError({
    code: "noCoverage",
    message: "This release has no volume coverage yet, so a pass cannot be tracked.",
  });
}

/**
 * Whether every active Volume of a Series now has at least one completed
 * read — the condition for the completed-series *prompt* (which only ever
 * suggests; confirmation goes through setSeriesReadingStatus).
 */
async function allVolumesRead(
  ctx: QueryCtx,
  userId: Id<"users">,
  seriesId: Id<"series">,
): Promise<boolean> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  const active = volumes.filter((volume) => volume.status === "active");
  if (active.length === 0) return false;
  for (const volume of active) {
    const progress = await volumeProgressRow(ctx, userId, volume._id);
    if (!progress || progress.readCount < 1) return false;
  }
  return true;
}

// ---------- queries ----------

/**
 * The viewer's tracking overlay for one Series page: reading status, every
 * active Volume with its read count, and the active passes in the Series.
 * Null when signed out, username pending, or the Series is unknown — the
 * public page renders identically, just without the personal controls.
 */
export const seriesTracking = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    if (!series) return null;

    const state = await seriesStateRow(ctx, user._id, series._id);
    const volumeDocs = await ctx.db
      .query("volumes")
      .withIndex("by_series", (q) => q.eq("seriesId", series._id))
      .collect();
    const volumes = [];
    for (const volume of volumeDocs) {
      if (volume.status !== "active") continue;
      const progress = await volumeProgressRow(ctx, user._id, volume._id);
      volumes.push({
        volumeId: volume._id,
        volumePublicId: volume.publicId,
        readCount: progress?.readCount ?? 0,
        lastCompletedAt: progress?.lastCompletedAt ?? null,
      });
    }
    const passes = (
      await ctx.db
        .query("releaseProgress")
        .withIndex("by_user_series", (q) =>
          q.eq("userId", user._id).eq("seriesId", series._id),
        )
        .collect()
    ).map((pass) => ({ releaseId: pass.releaseId, percent: pass.percent ?? null }));

    return {
      seriesId: series._id,
      readingStatus: state?.readingStatus ?? null,
      volumes,
      passes,
    };
  },
});

/**
 * The viewer's pass state for one Release row. Null when signed out (the
 * row shows no controls); otherwise `pass` is the active pass or null.
 */
export const passForRelease = query({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const release = await followMerges(ctx, "releases", await ctx.db.get(releaseId));
    if (!release) return null;
    const pass = await passRowFor(ctx, user._id, release._id);
    return { pass: pass ? { percent: pass.percent ?? null } : null };
  },
});

/**
 * The viewer's reading overview for /me: every Series with a chosen Reading
 * Status (with volumes-read progress) and every active pass, joined with
 * enough catalog data to link the Series and Edition pages.
 */
export const myReading = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;

    const states = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", user._id))
      .collect();
    const statuses = [];
    for (const state of states) {
      if (!state.readingStatus) continue;
      const series = await followMerges(ctx, "series", await ctx.db.get(state.seriesId));
      if (!series) continue;
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .collect();
      const active = volumes.filter((volume) => volume.status === "active");
      let volumesRead = 0;
      for (const volume of active) {
        const progress = await volumeProgressRow(ctx, user._id, volume._id);
        if (progress && progress.readCount >= 1) volumesRead += 1;
      }
      statuses.push({
        seriesPublicId: series.publicId,
        title: series.title,
        readingStatus: state.readingStatus,
        volumesRead,
        totalVolumes: active.length,
      });
    }
    statuses.sort((a, b) => a.title.localeCompare(b.title));

    const passRows = await ctx.db
      .query("releaseProgress")
      .withIndex("by_user_release", (q) => q.eq("userId", user._id))
      .collect();
    const passes = [];
    for (const row of passRows) {
      const release = await followMerges(ctx, "releases", await ctx.db.get(row.releaseId));
      if (!release) continue;
      const edition = await followMerges(
        ctx,
        "editions",
        await ctx.db.get(release.editionId),
      );
      if (!edition) continue;
      const { title } = await editionCoverage(ctx, edition);
      passes.push({
        releaseId: row.releaseId,
        percent: row.percent ?? null,
        format: release.format,
        binding: release.binding ?? null,
        editionPublicId: edition.publicId,
        editionTitle: title,
        anchor: releaseAnchor(release),
      });
    }
    passes.sort((a, b) => a.editionTitle.localeCompare(b.editionTitle));

    return { statuses, passes };
  },
});

// ---------- mutations ----------

/**
 * The one write path for Series Reading Status (spec §3): an explicit user
 * choice, whether from the status picker or a confirmed prompt. Omitting
 * `status` clears it back to "not tracked". Nothing else in this module —
 * starting a pass, completing one, marking volumes read — ever touches it.
 */
export const setSeriesReadingStatus = mutation({
  args: {
    seriesId: v.id("series"),
    status: v.optional(readingStatusValidator),
  },
  handler: async (ctx, { seriesId, status }) => {
    const user = await requireUser(ctx);
    const series = await requireActiveSeries(ctx, seriesId);
    const state = await seriesStateRow(ctx, user._id, series._id);
    if (state) {
      await ctx.db.patch(state._id, { readingStatus: status });
    } else if (status) {
      await ctx.db.insert("userSeriesStates", {
        userId: user._id,
        seriesId: series._id,
        readingStatus: status,
        following: false,
        followPromptDismissed: false,
      });
    }
    return { readingStatus: status ?? null };
  },
});

/**
 * Start (or resume) a Release Progress pass: at most one per (user, release).
 * Returns the Series whose Reading Status is not currently "Reading" as
 * `suggestReading` — the client renders the non-blocking prompt; declining
 * changes nothing because this mutation never writes the status.
 */
export const startPass = mutation({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);

    const existing = await passRowFor(ctx, user._id, release._id);
    if (!existing) {
      const seriesId = await passSeriesId(ctx, release);
      await ctx.db.insert("releaseProgress", {
        userId: user._id,
        releaseId: release._id,
        seriesId,
      });
    }

    const suggestReading = [];
    const seen = new Set<Id<"series">>();
    for (const rawId of release.seriesIds) {
      const series = await followMerges(ctx, "series", await ctx.db.get(rawId));
      if (!series || seen.has(series._id)) continue;
      seen.add(series._id);
      const state = await seriesStateRow(ctx, user._id, series._id);
      if ((state?.readingStatus ?? null) !== "reading") {
        suggestReading.push({ seriesId: series._id, title: series.title });
      }
    }
    return { suggestReading };
  },
});

/**
 * Update the pass's optional 0–100% estimate. Hitting 100% only *prompts*
 * client-side; this mutation never completes the pass or touches counts.
 */
export const setPassPercent = mutation({
  args: { releaseId: v.id("releases"), percent: v.number() },
  handler: async (ctx, { releaseId, percent }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new ConvexError({
        code: "badPercent",
        message: "Progress must be between 0 and 100.",
      });
    }
    const pass = await passRowFor(ctx, user._id, release._id);
    if (!pass) {
      throw new ConvexError({ code: "noPass", message: "No active reading pass." });
    }
    await ctx.db.patch(pass._id, { percent });
    return null;
  },
});

/**
 * Complete the pass — only ever called after explicit confirmation. Every
 * completely covered Volume's read count increments (a reread when > 1),
 * stamped with one shared completedAt so the completion can be undone as a
 * unit; partially covered Volumes are untouched. The pass row is removed.
 *
 * Returns `suggestCompleted`: covered Series where every active Volume now
 * has a read and the Reading Status is not already "Completed" — material
 * for the completed-series prompt, which only setSeriesReadingStatus acts on.
 */
export const completePass = mutation({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);
    const pass = await passRowFor(ctx, user._id, release._id);
    if (!pass) {
      throw new ConvexError({ code: "noPass", message: "No active reading pass." });
    }

    const completedAt = Date.now();
    const covered = await completelyCoveredVolumes(ctx, release);
    for (const volume of covered) {
      const progress = await volumeProgressRow(ctx, user._id, volume._id);
      if (progress) {
        await ctx.db.patch(progress._id, {
          readCount: progress.readCount + 1,
          lastCompletedAt: completedAt,
        });
      } else {
        await ctx.db.insert("volumeProgress", {
          userId: user._id,
          volumeId: volume._id,
          seriesId: volume.seriesId,
          readCount: 1,
          lastCompletedAt: completedAt,
        });
      }
    }
    await ctx.db.delete(pass._id);

    const suggestCompleted = [];
    const seen = new Set<Id<"series">>();
    for (const volume of covered) {
      if (seen.has(volume.seriesId)) continue;
      seen.add(volume.seriesId);
      const series = await ctx.db.get(volume.seriesId);
      if (!series || series.status !== "active") continue;
      const state = await seriesStateRow(ctx, user._id, series._id);
      if (state?.readingStatus === "completed") continue;
      if (await allVolumesRead(ctx, user._id, series._id)) {
        suggestCompleted.push({ seriesId: series._id, title: series.title });
      }
    }
    return { completedAt, suggestCompleted };
  },
});

/**
 * Undo a pass completion, identified by its completedAt stamp. Decrements
 * exactly the Volumes whose most recent completion is still that stamp — a
 * reread since then leaves the newer count alone (its own undo carries the
 * newer stamp). A count reaching zero removes the row; otherwise the prior
 * completion time is unknown, so lastCompletedAt clears. When anything was
 * undone and no new pass has started, the pass is restored at 100% — the
 * exact state before the confirmation being reversed.
 */
export const undoCompletion = mutation({
  args: { releaseId: v.id("releases"), completedAt: v.number() },
  handler: async (ctx, { releaseId, completedAt }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);

    let decremented = 0;
    for (const volume of await completelyCoveredVolumes(ctx, release)) {
      const progress = await volumeProgressRow(ctx, user._id, volume._id);
      if (!progress || progress.lastCompletedAt !== completedAt) continue;
      if (progress.readCount <= 1) {
        await ctx.db.delete(progress._id);
      } else {
        await ctx.db.patch(progress._id, {
          readCount: progress.readCount - 1,
          lastCompletedAt: undefined,
        });
      }
      decremented += 1;
    }

    if (decremented > 0 && !(await passRowFor(ctx, user._id, release._id))) {
      await ctx.db.insert("releaseProgress", {
        userId: user._id,
        releaseId: release._id,
        seriesId: await passSeriesId(ctx, release),
        percent: 100,
      });
    }
    return { decremented };
  },
});

/** Abandon the pass without completing: no read count changes anywhere. */
export const cancelPass = mutation({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await requireUser(ctx);
    const release = await requireActiveRelease(ctx, releaseId);
    const pass = await passRowFor(ctx, user._id, release._id);
    if (pass) await ctx.db.delete(pass._id);
    return null;
  },
});

/**
 * Direct Volume Progress edit (CONTEXT.md: read counts "may be updated
 * directly or by confirmed completion") — mark a volume read without a pass,
 * record an offline reread, or correct a count. Zero removes the row.
 */
export const setVolumeReadCount = mutation({
  args: { volumeId: v.id("volumes"), readCount: v.number() },
  handler: async (ctx, { volumeId, readCount }) => {
    const user = await requireUser(ctx);
    const volume = await followMerges(ctx, "volumes", await ctx.db.get(volumeId));
    if (!volume) {
      throw new ConvexError({ code: "notFound", message: "Volume not found." });
    }
    if (!Number.isInteger(readCount) || readCount < 0) {
      throw new ConvexError({
        code: "badCount",
        message: "Read count must be a whole number of completed reads.",
      });
    }
    const progress = await volumeProgressRow(ctx, user._id, volume._id);
    if (readCount === 0) {
      if (progress) await ctx.db.delete(progress._id);
    } else if (progress) {
      await ctx.db.patch(progress._id, {
        readCount,
        // A direct increment is a completed read now; a downward correction
        // keeps the existing completion time.
        lastCompletedAt:
          readCount > progress.readCount ? Date.now() : progress.lastCompletedAt,
      });
    } else {
      await ctx.db.insert("volumeProgress", {
        userId: user._id,
        volumeId: volume._id,
        seriesId: volume.seriesId,
        readCount,
        lastCompletedAt: Date.now(),
      });
    }
    return { readCount };
  },
});
