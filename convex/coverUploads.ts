// Cover art uploads for the Cover section of the edit and propose forms.
// The form asks for an upload URL (`uploadUrl`) and posts the file to it.
// The URL is this deployment's HTTP action (http.ts /cover-upload), not a
// bare storage URL: it stores the file itself and records the blob on the
// upload row (`stored`), so a row only ever names a blob its own upload
// stored. The form then reports the blob back (`uploaded`), which checks
// the file. Only then may a change name it (lib/coverRefs.ts
// checkCoverUse): a direct edit, or a Proposal whose Draft pins it.
//
// Nothing is changed by an upload. A blob no record, Revision or pending
// Proposal came to use is deleted by the hourly `sweep` a day after it was
// uploaded; one a Draft or In-Review Proposal names waits another day,
// however long the Proposal takes.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalMutation, mutation } from "./_generated/server";
import {
  checkCoverBlob,
  coverBlobsOf,
  coverInUse,
  pinCovers,
  pinned,
  shown,
} from "./lib/coverRefs";
import { fail } from "./lib/errors";
import { requireDataTeam } from "./lib/roles";

const DAY = 24 * 60 * 60 * 1000;
/** Uploads one person may start in a day: a form needs one or two. */
const UPLOADS_PER_DAY = 50;
/** Rows one sweep run handles before it schedules the next. */
const SWEEP_BATCH = 100;
/** Revisions one backfill run reads. */
const BACKFILL_BATCH = 200;
/** How long the backfill may go without a step before the cron starts it again. */
const BACKFILL_STALL = 10 * 60 * 1000;

/**
 * Start an upload: the URL to POST the file to, which carries the upload
 * row's id and secret token, and the row the finished blob is reported
 * against. Data Team only.
 */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireDataTeam(ctx);
    const now = Date.now();
    const recent = await ctx.db
      .query("coverUploads")
      .withIndex("by_uploader", (q) => q.eq("uploaderId", user._id).gt("sweepAfter", now))
      .take(UPLOADS_PER_DAY);
    if (recent.length >= UPLOADS_PER_DAY) {
      fail("rateLimited", "Too many cover uploads today. Try again tomorrow.");
    }
    const token = crypto.randomUUID();
    const uploadId = await ctx.db.insert("coverUploads", {
      uploaderId: user._id,
      token,
      sweepAfter: now + DAY,
    });
    const url = new URL("/cover-upload", env.CONVEX_SITE_URL);
    url.searchParams.set("upload", uploadId);
    url.searchParams.set("token", token);
    return { uploadId, url: url.href };
  },
});

/**
 * Record the blob the upload HTTP action (http.ts) just stored on the row
 * its URL named. False when the id or token is wrong, or the row already
 * has a file or is past its day: the action then deletes the blob, which
 * it stored itself.
 */
export const stored = internalMutation({
  args: { uploadId: v.string(), token: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { uploadId, token, storageId }) => {
    const id = ctx.db.normalizeId("coverUploads", uploadId);
    const row = id === null ? null : await ctx.db.get(id);
    if (!row || row.token !== token || row.storageId !== undefined) return false;
    if (row.sweepAfter <= Date.now()) return false;
    await ctx.db.patch(row._id, { storageId });
    return true;
  },
});

/**
 * Report the blob an upload stored. It must be the one the upload's own
 * URL recorded (`stored`), so no other blob can be claimed through it, and
 * pass the upload rules (lib/coverRefs.ts checkCoverBlob); a file that
 * fails them is deleted with its row and refused with `ok: false` and the
 * reason. Returns what the form shows beside the preview.
 */
export const uploaded = mutation({
  args: { uploadId: v.id("coverUploads"), storageId: v.id("_storage") },
  handler: async (ctx, { uploadId, storageId }) => {
    const user = await requireDataTeam(ctx);
    const row = await ctx.db.get(uploadId);
    if (!row || row.uploaderId !== user._id) fail("forbidden", "No such upload of yours.");
    if (row.storageId !== storageId) {
      fail("forbidden", "That file was not stored by this upload.");
    }
    const meta = await ctx.db.system.get(storageId);
    if (!meta) fail("invalidField", "The upload did not arrive. Try again.");
    // A refusal is returned, not thrown: throwing would roll the delete back.
    // The blob is this upload's own, and checkCoverUse never lets a file
    // that fails these rules into a change, so nothing else can need it.
    try {
      await checkCoverBlob(ctx, storageId, true);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      await ctx.storage.delete(storageId);
      await ctx.db.delete(uploadId);
      return { ok: false as const, message: (error.data as { message: string }).message };
    }
    return { ok: true as const, storageId, contentType: meta.contentType ?? null, size: meta.size };
  },
});

/**
 * Settle uploads whose day is up (crons.ts, hourly): a row never given a
 * file goes; a blob the catalog or History now holds stays and loses its
 * row; one a pending Proposal names waits another day; anything else is
 * deleted with its row. Continues in a fresh transaction when the batch
 * was full.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("coverUploads")
      .withIndex("by_sweepAfter", (q) => q.lt("sweepAfter", now))
      .take(SWEEP_BATCH);
    for (const row of due) {
      const storageId = row.storageId;
      if (storageId === undefined) {
        await ctx.db.delete(row._id);
      } else if (await coverInUse(ctx, storageId)) {
        // A pending Proposal may yet be withdrawn, and before older
        // Revisions are pinned every blob counts as needed: look again
        // tomorrow. Art a record or a Revision holds is the catalog's.
        const kept = (await shown(ctx, storageId)) || (await pinned(ctx, storageId, true));
        if (!kept) {
          await ctx.db.patch(row._id, { sweepAfter: now + DAY });
        } else {
          await ctx.db.delete(row._id);
        }
      } else {
        if ((await ctx.db.system.get(storageId)) !== null) await ctx.storage.delete(storageId);
        await ctx.db.delete(row._id);
      }
    }
    if (due.length === SWEEP_BATCH)
      await ctx.scheduler.runAfter(0, internal.coverUploads.sweep, {});
    return { settled: due.length };
  },
});

/**
 * Pin the covers that Revisions written before `coverRefs` existed name
 * (the repair tools' cover changes), a batch per run. Until it is done,
 * nothing deletes cover art (lib/coverRefs.ts coverInUse).
 *
 * The cursor lives in the `coverPinBackfill` row, and each run continues
 * the next. A cron (crons.ts) starts it, and starts it again when no run
 * has stepped for BACKFILL_STALL; a continuation whose `from` is no longer
 * the saved cursor stops, so two chains never both go on. Pins already
 * there are skipped, so a page read twice does no harm.
 */
export const pinRevisionCovers = internalMutation({
  args: { from: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { from }) => {
    const now = Date.now();
    const state = await ctx.db.query("coverPinBackfill").first();
    if (state?.done) return { pinned: 0, done: true };
    const cursor = state?.cursor ?? null;
    if (from === undefined ? state && now - state.steppedAt < BACKFILL_STALL : from !== cursor) {
      return { pinned: 0, done: false };
    }
    const page = await ctx.db.query("revisions").paginate({ cursor, numItems: BACKFILL_BATCH });
    let pinned = 0;
    for (const revision of page.page) {
      const blobs = coverBlobsOf(revision.changes);
      if (blobs.length === 0) continue;
      const existing = await ctx.db
        .query("coverRefs")
        .withIndex("by_storage", (q) => q.eq("storageId", blobs[0]!))
        .take(50);
      if (existing.some((pin) => pin.revisionId === revision._id)) continue;
      await pinCovers(ctx, blobs, { revisionId: revision._id });
      pinned += blobs.length;
    }
    const next = { cursor: page.continueCursor, done: page.isDone, steppedAt: now };
    if (state) await ctx.db.patch(state._id, next);
    else await ctx.db.insert("coverPinBackfill", next);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.coverUploads.pinRevisionCovers, {
        from: page.continueCursor,
      });
    }
    return { pinned, done: page.isDone };
  },
});
