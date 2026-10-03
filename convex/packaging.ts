// Unmapped Packaging (CONTEXT.md): Edition Line members created without the
// Volumes they collect, because no source stated them. They show under
// their line in the publisher's own numbering; a Moderator maps each one
// here, which writes its Volume Coverage and clears the flag.
//
// Queue: Data Team. Mapping: Moderator, as a direct edit — an approved
// Proposal plus Revisions on the Edition (lib/repair/audit.ts), the same
// trail every other coverage write leaves.
//
// The same page lists Bookless Series (CONTEXT.md): backbones whose books
// never attached, kept out of public discovery by the stats rebuild
// (seriesBrowse.ts) until a book lands or the Data Team decides.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { activeVolumes } from "./catalog";
import { editionCoverage } from "./catalogPages";
import { releasesOf } from "./lib/editionRows";
import { fail } from "./lib/errors";
import { createAudit, replaceCoverage, sameLabel, updateRecord } from "./lib/repair/audit";
import { requireDataTeam, requireModerator } from "./lib/roles";

const QUEUE_PAGE = 100;

/** Oldest unmapped Editions first, with what a Moderator needs to map them. */
export const unmappedQueue = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    // Hidden/merged Editions keep the flag; they must not use page slots.
    const flagged = await ctx.db
      .query("editions")
      .withIndex("by_coverageUnmapped", (q) => q.eq("coverageUnmapped", true))
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(QUEUE_PAGE + 1);
    const rows = [];
    for (const edition of flagged.slice(0, QUEUE_PAGE)) {
      const line = edition.editionLineId ? await ctx.db.get(edition.editionLineId) : null;
      const series = line ? await ctx.db.get(line.seriesId) : null;
      if (!line || !series || series.status !== "active") continue;
      const publisher = await ctx.db.get(edition.publisherId);
      const { title } = await editionCoverage(ctx, edition);
      const releases = await releasesOf(ctx, edition._id);
      const volumes = (
        await ctx.db
          .query("volumes")
          .withIndex("by_series", (q) => q.eq("seriesId", series._id))
          .collect()
      )
        .filter((volume) => volume.status === "active")
        .sort((a, b) => a.position - b.position);
      rows.push({
        editionId: edition._id,
        editionPublicId: edition.publicId,
        title,
        lineName: line.name,
        linePosition: edition.linePosition ?? null,
        publisher: publisher?.name ?? null,
        series: { publicId: series.publicId, title: series.title },
        isbns: releases
          .filter((release) => release.status === "active")
          .map((release) => release.isbn13 ?? release.isbn10 ?? null)
          .filter((isbn): isbn is string => isbn !== null),
        firstReleaseSort: Math.min(
          ...releases.map((release) => release.pubDate?.sort ?? Number.POSITIVE_INFINITY),
        ),
        /** The Series' Volumes a mapping may pick from, in reading order. */
        volumeLabels: volumes.map((volume) => volume.label ?? "").filter((label) => label !== ""),
      });
    }
    return { rows, hasMore: flagged.length > QUEUE_PAGE };
  },
});

/**
 * Map an unmapped Edition onto the Series' Volumes `from`..`to` (inclusive,
 * by reading position) and clear the flag. Moderator; a comment is
 * required because it becomes the Revision's rationale.
 */
export const mapEditionCoverage = mutation({
  args: {
    editionId: v.id("editions"),
    from: v.string(),
    to: v.string(),
    comment: v.string(),
  },
  handler: async (ctx, { editionId, from, to, comment }) => {
    const user = await requireModerator(ctx);
    const rationale = comment.trim();
    if (rationale === "") fail("commentRequired", "Say why.");
    const edition = await ctx.db.get(editionId);
    if (!edition || edition.status !== "active") fail("notFound", "No such active Edition.");
    if (edition.locked) fail("locked", "This Edition is locked.");
    if (!edition.editionLineId) fail("noLine", "Only Edition Line members can be mapped here.");
    const line = await ctx.db.get(edition.editionLineId);
    if (!line) fail("notFound", "The Edition's line vanished.");
    const volumes = (await activeVolumes(ctx, line.seriesId)).sort((a, b) => a.position - b.position);
    const pick = (label: string): Doc<"volumes"> => {
      const matches = volumes.filter((volume) => sameLabel(volume.label, label));
      if (matches.length !== 1) {
        fail(
          "unknownVolume",
          matches.length === 0
            ? `The Series has no Volume "${label}".`
            : `The Series has ${matches.length} Volumes labelled "${label}".`,
        );
      }
      return matches[0]!;
    };
    const first = pick(from);
    const last = pick(to);
    if (last.position < first.position) fail("badRange", `"${to}" comes before "${from}".`);
    const covered = volumes.filter(
      (volume) => volume.position >= first.position && volume.position <= last.position,
    );
    const audit = createAudit(ctx, { userId: user._id, role: user.role }, rationale, []);
    await replaceCoverage(
      ctx,
      audit,
      editionId,
      covered.map((volume) => ({ volumeId: volume._id, extent: "complete" as const })),
    );
    const ref = { type: "edition" as const, id: editionId };
    await updateRecord(ctx, audit, ref, edition, { coverageUnmapped: undefined });
    await audit.finish();
    return { covered: covered.length, volumeIds: covered.map((volume) => volume._id) };
  },
});

/**
 * Bookless Series, oldest public ID first: what the Data Team reviews to
 * decide whether a backbone deserves rescue (a missing publisher row, a
 * packaging-only run) or a hide. Each row names the ANN entry that built it.
 */
export const booklessQueue = query({
  args: {},
  handler: async (ctx) => {
    await requireDataTeam(ctx);
    // A hidden/merged Series the rebuild no longer visits keeps the flag.
    const flagged = await ctx.db
      .query("series")
      .withIndex("by_bookless", (q) => q.eq("bookless", true))
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(QUEUE_PAGE + 1);
    const rows = [];
    for (const series of flagged.slice(0, QUEUE_PAGE)) {
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", series._id))
        .collect();
      // The source that built the backbone: its series-level observation.
      const links = await ctx.db
        .query("sourceObservations")
        .withIndex("by_record", (q) => q.eq("recordRef.type", "series").eq("recordRef.id", series._id))
        .collect();
      rows.push({
        seriesId: series._id,
        publicId: series.publicId,
        title: series.title,
        volumeCount: volumes.filter((volume) => volume.status === "active").length,
        sources: links.map((obs) => ({ sourceKey: obs.sourceKey, recordId: obs.sourceRecordId })),
      });
    }
    rows.sort((a, b) => a.publicId - b.publicId);
    return { rows, hasMore: flagged.length > QUEUE_PAGE };
  },
});
