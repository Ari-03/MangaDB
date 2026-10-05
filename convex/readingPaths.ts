// Series-scoped shelf presentation, set only by moderators. Combining paths
// leaves Edition identities, publishers and all personal tracking untouched.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { activeVolumes, resolveActiveSeries, seriesEditions } from "./catalog";
import { coverageOf } from "./lib/editionRows";
import { COMBINED_PUBLISHERS_CAP, previewCombinedPaths } from "./lib/editionGroups";
import { fail } from "./lib/errors";
import { getActive } from "./lib/merges";
import { createAudit, updateRecord } from "./lib/repair/audit";
import { requireModerator } from "./lib/roles";
import { sameValue } from "./lib/values";

/** All standard books on this series, independent of the current grouping. */
async function standardRuns(ctx: QueryCtx, series: Doc<"series">) {
  const volumes = await activeVolumes(ctx, series._id);
  const volumeById = new Map(volumes.map((volume) => [volume._id, volume]));
  type Run = {
    publisher: { id: Id<"publishers">; name: string; slug: string };
    books: {
      publicId: number;
      coverage: { volumePublicId: number; position: number; label: string | null }[];
    }[];
  };
  const runs = new Map<Id<"publishers">, Run>();
  for (const edition of (await seriesEditions(ctx, series._id, volumes)).editions.values()) {
    // The catalog presents books on unavailable lines as standard editions.
    // Use the same rule so its shelf, this preview, and overlap checks agree.
    const line = edition.editionLineId ? await ctx.db.get(edition.editionLineId) : null;
    if (line?.status === "active") continue;
    const publisher = await ctx.db.get(edition.publisherId);
    if (!publisher || publisher.status !== "active") continue;
    const run = runs.get(publisher._id) ?? {
      publisher: { id: publisher._id, name: publisher.name, slug: publisher.slug },
      books: [],
    };
    const coverage = [];
    for (const row of await coverageOf(ctx, edition._id)) {
      const volume = volumeById.get(row.volumeId);
      if (volume)
        coverage.push({
          volumePublicId: volume.publicId,
          position: volume.position,
          label: volume.label ?? null,
        });
    }
    run.books.push({ publicId: edition.publicId, coverage });
    runs.set(publisher._id, run);
  }
  const firstPosition = (run: Run) =>
    Math.min(...run.books.flatMap((book) => book.coverage.map((cov) => cov.position)));
  return {
    runs: [...runs.values()].sort(
      (a, b) =>
        firstPosition(a) - firstPosition(b) || a.publisher.name.localeCompare(b.publisher.name),
    ),
    volumes: volumes.map((volume) => ({
      publicId: volume.publicId,
      position: volume.position,
      label: volume.label ?? null,
    })),
  };
}

/** Live moderator form; raw expected IDs detect competing grouping changes. */
export const combineForm = query({
  args: { seriesPublicId: v.number() },
  handler: async (ctx, { seriesPublicId }) => {
    await requireModerator(ctx);
    const series = await resolveActiveSeries(ctx, seriesPublicId);
    if (!series) return null;
    const currentPublisherIds = series.combinedPathPublisherIds ?? [];
    const { runs, volumes } = await standardRuns(ctx, series);
    const available = new Set(runs.map((run) => run.publisher.id));
    const resolved: Id<"publishers">[] = [];
    for (const id of currentPublisherIds) {
      const publisher = await getActive(ctx, "publishers", id);
      if (publisher && available.has(publisher._id) && !resolved.includes(publisher._id)) {
        resolved.push(publisher._id);
      }
    }
    return {
      seriesId: series._id,
      title: series.title,
      editable: !series.locked,
      currentPublisherIds,
      selectedPublisherIds: resolved,
      runs,
      volumes,
    };
  },
});

/** Set, replace, or undo one combination, as an approved Proposal + Revision. */
export const setCombinedPath = mutation({
  args: {
    seriesId: v.id("series"),
    publisherIds: v.array(v.id("publishers")),
    expected: v.array(v.id("publishers")),
    comment: v.string(),
    confirmImpact: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireModerator(ctx);
    const comment = args.comment.trim();
    if (!comment) fail("commentRequired", "Every change needs a reason.");
    if (!args.confirmImpact)
      fail("confirmRequired", "Review the shelf preview and confirm the change.");
    const series = await ctx.db.get(args.seriesId);
    if (!series) fail("notFound", "Series not found.");
    if (series.status !== "active" || series.locked)
      fail("locked", "The series must be active and unlocked.");
    const current = series.combinedPathPublisherIds ?? [];
    if (!sameValue(current, args.expected))
      fail("stale", "The reading paths changed. Reload before saving.");
    const ids = args.publisherIds;
    if (
      ids.length === 1 ||
      ids.length > COMBINED_PUBLISHERS_CAP ||
      new Set(ids).size !== ids.length
    ) {
      fail(
        "invalidPublishers",
        `Choose between 2 and ${COMBINED_PUBLISHERS_CAP} distinct publishers, or undo the combination.`,
      );
    }
    if (sameValue(current, ids)) fail("noChanges", "The reading paths already use this grouping.");
    if (ids.length > 0) {
      const { runs, volumes } = await standardRuns(ctx, series);
      for (const id of ids) {
        if (!runs.some((run) => run.publisher.id === id))
          fail(
            "invalidPublishers",
            "Each publisher must have an active standard run on this series.",
          );
      }
      const preview = previewCombinedPaths(runs, ids, volumes);
      if (preview.overlaps.length > 0) {
        fail(
          "overlappingCoverage",
          `These runs cover the same volumes: ${preview.overlaps.map((volume) => `Vol. ${volume.label ?? volume.position}`).join(", ")}. Keep overlapping editions separate.`,
        );
      }
    }
    const audit = createAudit(ctx, { userId: user._id, role: user.role }, comment, []);
    await updateRecord(ctx, audit, { type: "series", id: series._id }, series, {
      combinedPathPublisherIds: ids.length > 0 ? ids : undefined,
    });
    await audit.finish();
    return null;
  },
});
