// Reading tracking (CONTEXT.md: Series Reading Status, Release Progress,
// Volume Progress): the status picker, passes, read counts and the /me
// reading shelf. Only setSeriesReadingStatus writes a status; the
// start-reading and completed-series prompts are suggestions the client
// renders. A completion returns what it changed and Undo takes that back, so
// a later reread or count increase on a Volume makes an older undo a no-op
// there.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { activeVolumes, resolveActiveSeries } from "./catalog";
import { editionCoverage } from "./catalogPages";
import { getActive, mergeSurvivor, requireActive } from "./lib/merges";
import { seriesStateRow, writeSeriesState } from "./lib/seriesStates";
import { requireUser, viewerOrNull } from "./lib/auth";
import { boundedReads } from "./lib/boundedReads";
import { releaseCover, statsCoverIsbns } from "./lib/covers";
import { coverageOf } from "./lib/editionRows";
import { releaseAnchor } from "./lib/titles";
import { seriesStatsRow } from "./lib/seriesStats";

// Mirrors the userSeriesStates.readingStatus union in schema.ts.
const readingStatusValidator = v.union(
  v.literal("planToRead"),
  v.literal("reading"),
  v.literal("paused"),
  v.literal("dropped"),
  v.literal("completed"),
);

// ---------- shared lookups ----------

/** One user's Volume Progress row for one Volume, or null. */
export async function volumeProgressRow(
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
 * The active Volumes an Edition covers *completely* — the exact set a
 * confirmed completion of any of its Releases increments (spec §3); partial
 * coverage never appears here. Volumes are merge-resolved and deduplicated
 * by surviving identity. Exported for the library's read flag (collection.ts).
 */
export async function completelyCoveredVolumes(
  ctx: QueryCtx,
  editionId: Id<"editions">,
): Promise<Array<Doc<"volumes">>> {
  const rows = await coverageOf(ctx, editionId);
  const volumes = new Map<Id<"volumes">, Doc<"volumes">>();
  for (const row of rows) {
    if (row.extent !== "complete") continue;
    const volume = await getActive(ctx, "volumes", row.volumeId);
    if (volume) volumes.set(volume._id, volume);
  }
  return [...volumes.values()];
}

/**
 * The denormalized seriesId for a new releaseProgress row: the Release's
 * first covered Series, merge-resolved. A new pass needs that Series active;
 * a pass Undo restores (`allowHidden`) may sit under a Series hidden since,
 * as the pass it replaces did. A Release without any coverage has no Series
 * to attribute the pass to, so tracking it is rejected.
 */
async function passSeriesId(
  ctx: QueryCtx,
  release: Doc<"releases">,
  allowHidden = false,
): Promise<Id<"series">> {
  const first = release.seriesIds[0];
  if (first) {
    const series = await mergeSurvivor(ctx, "series", await ctx.db.get(first));
    if (series?.status === "active" || (allowHidden && series?.status === "hidden")) {
      return series._id;
    }
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
  const active = await activeVolumes(ctx, seriesId);
  if (active.length === 0) return false;
  for (const volume of active) {
    const progress = await volumeProgressRow(ctx, userId, volume._id);
    if (!progress || progress.readCount < 1) return false;
  }
  return true;
}

/**
 * The completed-series prompt material after a completion or read-marking: covered Series
 * where every active Volume now has a read and the status is not already
 * "Completed" — a suggestion only, acted on solely by setSeriesReadingStatus.
 */
async function completedSuggestions(
  ctx: MutationCtx,
  userId: Id<"users">,
  covered: Array<Doc<"volumes">>,
) {
  const suggestCompleted = [];
  const seen = new Set<Id<"series">>();
  for (const volume of covered) {
    if (seen.has(volume.seriesId)) continue;
    seen.add(volume.seriesId);
    const series = await ctx.db.get(volume.seriesId);
    if (!series || series.status !== "active") continue;
    const state = await seriesStateRow(ctx, userId, series._id);
    if (state?.readingStatus === "completed") continue;
    if (await allVolumesRead(ctx, userId, series._id)) {
      suggestCompleted.push({ seriesId: series._id, title: series.title });
    }
  }
  return suggestCompleted;
}

/** An active pass as /me lists it, linking the Edition row of its Release. */
async function passEntry(
  ctx: QueryCtx,
  pass: Doc<"releaseProgress">,
  release: Doc<"releases">,
  edition: Doc<"editions">,
) {
  const { title } = await editionCoverage(ctx, edition);
  return {
    releaseId: pass.releaseId,
    percent: pass.percent ?? null,
    format: release.format,
    binding: release.binding ?? null,
    editionPublicId: edition.publicId,
    editionTitle: title,
    anchor: releaseAnchor(release),
    ...(await releaseCover(ctx, release)),
  };
}

/** Store one user's read count for a Volume: patch their row, or create it. */
async function putVolumeProgress(
  ctx: MutationCtx,
  userId: Id<"users">,
  volume: Doc<"volumes">,
  progress: Doc<"volumeProgress"> | null,
  fields: Pick<Doc<"volumeProgress">, "readCount" | "lastCompletedAt">,
) {
  if (progress) {
    await ctx.db.patch(progress._id, fields);
  } else {
    await ctx.db.insert("volumeProgress", {
      userId,
      volumeId: volume._id,
      ...fields,
    });
  }
}

// ---------- queries ----------

/**
 * The viewer's tracking overlay for one Series page: reading status, every
 * active Volume with its read count, and the active passes in the Series.
 * Null without a viewer (viewerOrNull) or for an unknown Series.
 */
export const seriesTracking = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    return series ? await seriesTrackingOf(ctx, user._id, series._id) : null;
  },
});

/** seriesTracking for a known viewer and Series; exported for its cost tests. */
export async function seriesTrackingOf(ctx: QueryCtx, userId: Id<"users">, seriesId: Id<"series">) {
  // Volume Progress rows carry no usable Series (schema.ts), so each
  // Volume is looked up by (user, volume); the lookups go out together
  // through one bounded queue (boundedReads), however long the Series runs.
  const bounded = boundedReads(ctx);
  const [state, active, passRows] = await Promise.all([
    seriesStateRow(bounded, userId, seriesId),
    activeVolumes(bounded, seriesId),
    bounded.db
      .query("releaseProgress")
      .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
      .collect(),
  ]);
  const volumes = await Promise.all(
    active.map(async (volume) => {
      const progress = await volumeProgressRow(bounded, userId, volume._id);
      return {
        volumeId: volume._id,
        volumePublicId: volume.publicId,
        readCount: progress?.readCount ?? 0,
        lastCompletedAt: progress?.lastCompletedAt ?? null,
      };
    }),
  );
  return {
    seriesId,
    readingStatus: state?.readingStatus ?? null,
    volumes,
    passes: passRows.map((pass) => ({ releaseId: pass.releaseId, percent: pass.percent ?? null })),
  };
}

/**
 * The viewer's pass state for one Release row. Null without a viewer or for
 * an unknown Release; otherwise `pass` is the active pass or null.
 */
export const passForRelease = query({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;
    const release = await getActive(ctx, "releases", releaseId);
    if (!release) return null;
    const pass = await passRowFor(ctx, user._id, release._id);
    return { pass: pass ? { percent: pass.percent ?? null } : null };
  },
});

/**
 * The viewer's reading overview for /me: one row per Series the viewer has
 * any reading relationship with — a chosen Reading Status, an active pass, or
 * a read Volume — carrying the status, volumes-read progress, the Series'
 * library cover, and its active passes (each linking its Edition row). A
 * Series with only a pass or a read Volume shows with a null status, so
 * nothing the viewer is reading disappears from the shelf.
 */
export const myReading = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerOrNull(ctx);
    if (!user) return null;

    type Row = {
      seriesId: Id<"series">;
      seriesPublicId: number;
      title: string;
      readingStatus: NonNullable<Doc<"userSeriesStates">["readingStatus"]> | null;
      volumesRead: number;
      totalVolumes: number;
      coverUrl: string | null;
      coverIsbn: string[];
      passes: Array<Awaited<ReturnType<typeof passEntry>>>;
    };
    const rows = new Map<Id<"series">, Row>();
    const rowFor = async (rawSeriesId: Id<"series">): Promise<Row | null> => {
      const series = await getActive(ctx, "series", rawSeriesId);
      if (!series) return null;
      const existing = rows.get(series._id);
      if (existing) return existing;
      const active = await activeVolumes(ctx, series._id);
      let volumesRead = 0;
      for (const volume of active) {
        const progress = await volumeProgressRow(ctx, user._id, volume._id);
        if (progress && progress.readCount >= 1) volumesRead += 1;
      }
      const stats = await seriesStatsRow(ctx, series._id);
      const row: Row = {
        seriesId: series._id,
        seriesPublicId: series.publicId,
        title: series.title,
        readingStatus: null,
        volumesRead,
        totalVolumes: active.length,
        coverUrl: stats?.coverUrl ?? null,
        coverIsbn: statsCoverIsbns(stats),
        passes: [],
      };
      rows.set(series._id, row);
      return row;
    };

    const states = await ctx.db
      .query("userSeriesStates")
      .withIndex("by_user_series", (q) => q.eq("userId", user._id))
      .collect();
    for (const state of states) {
      if (!state.readingStatus) continue;
      const row = await rowFor(state.seriesId);
      if (row) row.readingStatus = state.readingStatus;
    }

    const passRows = await ctx.db
      .query("releaseProgress")
      .withIndex("by_user_release", (q) => q.eq("userId", user._id))
      .collect();
    for (const pass of passRows) {
      const release = await getActive(ctx, "releases", pass.releaseId);
      if (!release) continue;
      const edition = await getActive(ctx, "editions", release.editionId);
      if (!edition) continue;
      const row = await rowFor(pass.seriesId);
      if (!row) continue;
      row.passes.push(await passEntry(ctx, pass, release, edition));
    }

    // Read Volumes without a status or pass still put their Series here.
    const progressRows = await ctx.db
      .query("volumeProgress")
      .withIndex("by_user_volume", (q) => q.eq("userId", user._id))
      .collect();
    for (const progress of progressRows) {
      if (progress.readCount < 1) continue;
      const volume = await getActive(ctx, "volumes", progress.volumeId);
      if (volume) await rowFor(volume.seriesId);
    }

    const series = [...rows.values()];
    for (const row of series) {
      row.passes.sort((a, b) => a.editionTitle.localeCompare(b.editionTitle));
    }
    series.sort((a, b) => a.title.localeCompare(b.title));
    return { series };
  },
});

// ---------- mutations ----------

/** The most Volumes one completion may count, and so one Undo may take back. */
export const PASS_VOLUMES_CAP = 500;

/** A pass's optional 0–100% estimate, as setPassPercent and Undo accept it. */
function checkPercent(percent: number) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new ConvexError({
      code: "badPercent",
      message: "Progress must be between 0 and 100.",
    });
  }
}

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
    const series = await requireActive(ctx, "series", seriesId, "Series");
    const create = status !== undefined;
    await writeSeriesState(ctx, user._id, series._id, { readingStatus: status }, create);
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
    const release = await requireActive(ctx, "releases", releaseId, "Release");

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
      const series = await getActive(ctx, "series", rawId);
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
    const release = await requireActive(ctx, "releases", releaseId, "Release");
    checkPercent(percent);
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
 * stamped with one shared completedAt; partially covered Volumes are
 * untouched. The pass row is removed. An Edition covering more than
 * PASS_VOLUMES_CAP Volumes is refused before anything is written.
 *
 * Returns what undoCompletion takes back — `completedAt`, the `volumeIds`
 * incremented, and the pass's `percent` (absent when it had none) — and
 * `suggestCompleted`: covered Series where every active Volume now has a
 * read and the Reading Status is not already "Completed", material for the
 * completed-series prompt, which only setSeriesReadingStatus acts on.
 */
export const completePass = mutation({
  args: { releaseId: v.id("releases") },
  handler: async (ctx, { releaseId }) => {
    const user = await requireUser(ctx);
    const release = await requireActive(ctx, "releases", releaseId, "Release");
    const pass = await passRowFor(ctx, user._id, release._id);
    if (!pass) {
      throw new ConvexError({ code: "noPass", message: "No active reading pass." });
    }

    const covered = await completelyCoveredVolumes(ctx, release.editionId);
    if (covered.length > PASS_VOLUMES_CAP) {
      throw new ConvexError({
        code: "tooMany",
        message: `A pass can count at most ${PASS_VOLUMES_CAP} volumes.`,
      });
    }
    const completedAt = Date.now();
    for (const volume of covered) {
      const progress = await volumeProgressRow(ctx, user._id, volume._id);
      await putVolumeProgress(ctx, user._id, volume, progress, {
        readCount: (progress?.readCount ?? 0) + 1,
        lastCompletedAt: completedAt,
      });
    }
    await ctx.db.delete(pass._id);

    const suggestCompleted = await completedSuggestions(ctx, user._id, covered);
    return {
      completedAt,
      volumeIds: covered.map((volume) => volume._id),
      percent: pass.percent,
      suggestCompleted,
    };
  },
});

/**
 * Undo a pass completion with what completePass returned. Decrements the
 * given Volumes (merge-resolved) whose most recent completion is still
 * `completedAt`, whatever the Edition covers today. A reread or count
 * increase since then restamps the Volume, so Undo leaves the newer count
 * alone. A count reaching zero removes the row; otherwise the prior
 * completion time is unknown, so lastCompletedAt clears, which also means
 * a survivor two merged ids lead to is decremented once. The pass comes
 * back at its original `percent` when something was undone, or when the
 * completion had counted no Volume, unless a pass has been started since.
 * Repeating the same Undo with nothing changed in between does nothing:
 * the stamps no longer match, and the restored pass is there. For a
 * completion that counted no Volume, an Undo replayed after the restored
 * pass was cancelled restores it again.
 *
 * Known limit: writeVolumeReadCount keeps the stamp on a decrease, since
 * it is also the displayed last-read date, so after a decrease Undo still
 * matches and takes off one read more than the completion added: complete
 * (2 reads to 3), −1 by hand (2), then Undo leaves 1.
 *
 * The arguments come from the client, but every row read or written is the
 * caller's own: Volume ids only lower the caller's own counts, as the
 * direct edits can. Called directly with an empty Volume list, Undo creates
 * a pass at a chosen percent, which startPass and setPassPercent also
 * allow, except on a Release whose Series is hidden, where startPass
 * refuses and Undo does not. The effect is one private row of the
 * caller's own.
 */
export const undoCompletion = mutation({
  args: {
    releaseId: v.id("releases"),
    completedAt: v.number(),
    volumeIds: v.array(v.id("volumes")),
    percent: v.optional(v.number()),
  },
  handler: async (ctx, { releaseId, completedAt, volumeIds, percent }) => {
    const user = await requireUser(ctx);
    const release = await requireActive(ctx, "releases", releaseId, "Release");
    if (volumeIds.length > PASS_VOLUMES_CAP) {
      throw new ConvexError({
        code: "tooMany",
        message: `An undo can take back at most ${PASS_VOLUMES_CAP} volumes.`,
      });
    }
    if (percent !== undefined) checkPercent(percent);

    let decremented = 0;
    for (const volumeId of volumeIds) {
      const volume = await getActive(ctx, "volumes", volumeId);
      if (!volume) continue;
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

    const restore = decremented > 0 || volumeIds.length === 0;
    if (restore && !(await passRowFor(ctx, user._id, release._id))) {
      await ctx.db.insert("releaseProgress", {
        userId: user._id,
        releaseId: release._id,
        seriesId: await passSeriesId(ctx, release, true),
        percent,
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
    const release = await requireActive(ctx, "releases", releaseId, "Release");
    const pass = await passRowFor(ctx, user._id, release._id);
    if (pass) await ctx.db.delete(pass._id);
    return null;
  },
});

/**
 * The Volume Progress write shared by the direct edits: store `readCount`
 * for the viewer (zero removes the row). An increase is a completed read
 * now; a decrease is a correction and keeps the last completion time.
 */
async function writeVolumeReadCount(
  ctx: MutationCtx,
  volumeId: Id<"volumes">,
  toCount: (current: number) => number,
) {
  const user = await requireUser(ctx);
  const volume = await requireActive(ctx, "volumes", volumeId, "Volume");
  const progress = await volumeProgressRow(ctx, user._id, volume._id);
  const readCount = toCount(progress?.readCount ?? 0);
  if (!Number.isInteger(readCount) || readCount < 0) {
    throw new ConvexError({
      code: "badCount",
      message: "Read count must be a whole number of completed reads.",
    });
  }
  if (readCount === 0) {
    if (progress) await ctx.db.delete(progress._id);
  } else {
    const lastCompletedAt =
      progress && readCount <= progress.readCount ? progress.lastCompletedAt : Date.now();
    await putVolumeProgress(ctx, user._id, volume, progress, { readCount, lastCompletedAt });
  }
  return { readCount };
}

/**
 * Direct Volume Progress edit (CONTEXT.md: read counts "may be updated
 * directly or by confirmed completion") — correct a count to an exact value.
 * Zero removes the row. The Volume page's +1 / −1 buttons use
 * adjustVolumeReadCount instead, so clicks made before the count refreshes
 * are not lost.
 */
export const setVolumeReadCount = mutation({
  args: { volumeId: v.id("volumes"), readCount: v.number() },
  handler: async (ctx, { volumeId, readCount }) =>
    await writeVolumeReadCount(ctx, volumeId, () => readCount),
});

/**
 * Add `delta` completed reads to a Volume (mark read, record an offline
 * reread, or take one back) against the stored count, not the count the
 * client last saw — two quick +1 clicks are two reads. The count stops at
 * zero, which removes the row.
 */
export const adjustVolumeReadCount = mutation({
  args: { volumeId: v.id("volumes"), delta: v.number() },
  handler: async (ctx, { volumeId, delta }) => {
    if (!Number.isInteger(delta)) {
      throw new ConvexError({
        code: "badCount",
        message: "Read count must change by a whole number of completed reads.",
      });
    }
    return await writeVolumeReadCount(ctx, volumeId, (current) =>
      Math.max(0, current + delta),
    );
  },
});

/** Batch read-marking (the whole-run button) stops here, like batch entries. */
export const MANY_EDITIONS_CAP = 200;

/**
 * The read/unread write for one Edition, shared by the single and batch
 * mutations: every Volume the Edition covers *completely* gets a first
 * completed read (`read: true` — Volumes already read keep their count, so
 * a reread is never erased), or has its read history cleared (`read:
 * false`). Partial coverage is untouched, exactly as a confirmed pass
 * completion. Direct Volume Progress edits: no pass, no Reading Status
 * change. Returns the covered Volumes so the caller can compute prompts.
 */
async function writeEditionRead(
  ctx: MutationCtx,
  userId: Id<"users">,
  editionPublicId: number,
  read: boolean,
) {
  const stored = await ctx.db
    .query("editions")
    .withIndex("by_publicId", (q) => q.eq("publicId", editionPublicId))
    .unique();
  const edition = await requireActive(ctx, "editions", stored, "Edition");
  const covered = await completelyCoveredVolumes(ctx, edition._id);

  const now = Date.now();
  let changed = 0;
  for (const volume of covered) {
    const progress = await volumeProgressRow(ctx, userId, volume._id);
    if (read) {
      if (progress && progress.readCount >= 1) continue;
      await putVolumeProgress(ctx, userId, volume, progress, { readCount: 1, lastCompletedAt: now });
    } else {
      if (!progress) continue;
      await ctx.db.delete(progress._id);
    }
    changed += 1;
  }
  return { changed, covered };
}

/** Mark a whole book read or unread from its cover (see writeEditionRead). */
export const setEditionRead = mutation({
  args: { editionPublicId: v.number(), read: v.boolean() },
  handler: async (ctx, { editionPublicId, read }) => {
    const user = await requireUser(ctx);
    const { changed, covered } = await writeEditionRead(ctx, user._id, editionPublicId, read);
    return {
      changed,
      suggestCompleted: read ? await completedSuggestions(ctx, user._id, covered) : [],
    };
  },
});

/**
 * The same write for a whole run of books at once — the Series page's and
 * the library's "Read all". Each Edition follows writeEditionRead's rules;
 * the completed-series prompt is computed once over everything covered.
 * Capped at MANY_EDITIONS_CAP.
 */
export const setEditionsRead = mutation({
  args: { editionPublicIds: v.array(v.number()), read: v.boolean() },
  handler: async (ctx, { editionPublicIds, read }) => {
    const user = await requireUser(ctx);
    if (editionPublicIds.length > MANY_EDITIONS_CAP) {
      throw new ConvexError({
        code: "tooMany",
        message: `Mark at most ${MANY_EDITIONS_CAP} books at once.`,
      });
    }
    let changed = 0;
    const covered = new Map<Id<"volumes">, Doc<"volumes">>();
    for (const editionPublicId of new Set(editionPublicIds)) {
      const result = await writeEditionRead(ctx, user._id, editionPublicId, read);
      changed += result.changed;
      for (const volume of result.covered) covered.set(volume._id, volume);
    }
    return {
      changed,
      suggestCompleted: read
        ? await completedSuggestions(ctx, user._id, [...covered.values()])
        : [],
    };
  },
});

// ---------- maintenance ----------

/** Volume Progress rows one unsetProgressSeries page reads. */
export const UNSET_SERIES_PAGE = 200;

/**
 * Clear the Series older Volume Progress rows still store (a row's Series
 * is its Volume's; nothing reads the field). One page per transaction, the
 * next scheduled after it; rows written meanwhile carry no Series and are
 * left alone, so it is safe beside live reading and safe to rerun.
 *
 *   npx convex run reading:unsetProgressSeries '{}'
 */
export const unsetProgressSeries = internalMutation({
  args: { cursor: v.optional(v.string()), unset: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let unset = args.unset ?? 0;
    const { page, isDone, continueCursor } = await ctx.db
      .query("volumeProgress")
      .paginate({ numItems: UNSET_SERIES_PAGE, cursor: args.cursor ?? null });
    for (const row of page) {
      if (row.seriesId === undefined) continue;
      await ctx.db.patch(row._id, { seriesId: undefined });
      unset++;
    }
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.reading.unsetProgressSeries, { cursor: continueCursor, unset });
    } else {
      console.log(`[reading.unsetProgressSeries] done: ${unset} rows cleared`);
    }
    return { unset, done: isDone };
  },
});
