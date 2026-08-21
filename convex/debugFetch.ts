// Temporary diagnostic: what does a third-party endpoint return when fetched
// from this Convex deployment's egress IPs? Delete after use.
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { USER_AGENT } from "./lib/http";
import { candidateSeries, labelsEqual } from "./lib/matching";
import { findPublisherByName } from "./lib/pipeline";

// Count active releases sharing an isbn13 — duplicate-creation check.
export const probeDuplicateIsbns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const byIsbn = new Map<string, number>();
    let total = 0;
    for await (const release of ctx.db.query("releases")) {
      total++;
      if (release.status !== "active" || release.isbn13 === undefined) continue;
      byIsbn.set(release.isbn13, (byIsbn.get(release.isbn13) ?? 0) + 1);
    }
    const dups = [...byIsbn.entries()].filter(([, n]) => n > 1);
    return { totalReleases: total, duplicatedIsbns: dups.length, sample: dups.slice(0, 10) };
  },
});

// Cancel a scheduled function by id (operator recovery tool).
export const cancelScheduled = internalMutation({
  args: { id: v.id("_scheduled_functions") },
  handler: async (ctx, { id }) => {
    await ctx.scheduler.cancel(id);
    return { canceled: id };
  },
});

// Look up one source observation and report its match state.
export const probeObservation = internalMutation({
  args: { sourceKey: v.string(), sourceRecordId: v.string() },
  handler: async (ctx, { sourceKey, sourceRecordId }) => {
    const obs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", sourceKey).eq("sourceRecordId", sourceRecordId),
      )
      .unique();
    if (!obs) return { found: false };
    return {
      found: true,
      recordRef: obs.recordRef ?? null,
      conflicts: obs.conflicts ?? [],
      withdrawn: obs.withdrawn ?? false,
      lastSeenAt: obs.lastSeenAt ?? null,
    };
  },
});

// Trace the leaf-creation gates for one (publisher, series title, label)
// triple — which gate would stop an OpenLibrary record here?
export const probeMatch = internalMutation({
  args: {
    publisherName: v.string(),
    seriesTitle: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, { publisherName, seriesTitle, label }) => {
    const publisher = await findPublisherByName(ctx, publisherName);
    const candidates = await candidateSeries(ctx, seriesTitle);
    let volumeFound = false;
    let volumeLabels: Array<string | null> = [];
    if (candidates.length === 1) {
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", candidates[0]!._id))
        .collect();
      volumeLabels = volumes.slice(0, 12).map((vol) => vol.label ?? null);
      volumeFound = volumes.some(
        (vol) => vol.status === "active" && labelsEqual(vol.label, label ?? null),
      );
    }
    return {
      publisherFound: publisher?.name ?? null,
      candidateCount: candidates.length,
      candidateTitles: candidates.slice(0, 5).map((s) => s.title),
      volumeFound,
      volumeLabels,
    };
  },
});

export const probe = internalAction({
  args: { url: v.string(), browserUa: v.optional(v.boolean()) },
  handler: async (_ctx, { url, browserUa }) => {
    const ua = browserUa
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
      : USER_AGENT;
    const res = await fetch(url, { headers: { "User-Agent": ua } });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      server: res.headers.get("server"),
      mitigated: res.headers.get("cf-mitigated"),
      head: body.slice(0, 400),
    };
  },
});
