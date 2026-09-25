// The one-time catalog repair (repair.ts, lib/repair/*): dry runs roll back,
// every operation is idempotent, drift skips instead of clobbering, series
// merges place volumes by label (not the stock append), packaging becomes
// Edition Lines / Release Bundles with real coverage, and every write lands
// in the moderation audit trail.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { RepairEntry } from "./lib/repair/entries";
import { canonicalLabel, labelNumber, sameLabel } from "./lib/repair/audit";
import { clusterKey } from "./lib/repair/metrics";
import schema from "./schema";

// Explicit module map: node_modules may be shared with another checkout,
// whose convex/ directory convex-test would otherwise glob.
const modules = import.meta.glob("./**/*.*s");

function makeT() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

/** Admin actor + a publisher, a base series (vols 1-3, releases on 1-2) and a PRH shard series. */
async function seed(t: T) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "Ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await ctx.db.insert("publishers", { status: "active", name: "Kodansha", slug: "kodansha" });
    let publicId = 100;
    const series = async (title: string) =>
      await ctx.db.insert("series", { status: "active", publicId: publicId++, title, altTitles: [], searchText: title });
    const volume = async (seriesId: Id<"series">, label: string | undefined, position: number) =>
      await ctx.db.insert("volumes", { status: "active", publicId: publicId++, seriesId, label, position });
    const release = async (volumeId: Id<"volumes">, seriesId: Id<"series">, isbn13: string, format: "physical" | "digital" = "physical") => {
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: publicId++, publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format,
        language: "en",
        isbn13,
        publisherId,
        seriesIds: [seriesId],
      });
      return { editionId, releaseId };
    };
    const base = await series("Noragami");
    const v1 = await volume(base, "1", 1);
    const v2 = await volume(base, "2", 2);
    const v3 = await volume(base, "3", 3);
    const r1 = await release(v1, base, "9780000000011");
    await release(v2, base, "9780000000028");
    const shard = await series("Noragami 03 (Manga)");
    const shardVol = await volume(shard, "03", 3);
    const shardRelease = await release(shardVol, shard, "9780000000035", "digital");
    const shard4 = await series("Noragami Vol.4");
    const shard4Vol = await volume(shard4, undefined, 1);
    await release(shard4Vol, shard4, "9780000000042");
    const omnibus = await series("Noragami Omnibus 1 (Vol. 1-3)");
    const omnibusVol = await volume(omnibus, "1", 1);
    const omnibusRelease = await release(omnibusVol, omnibus, "9780000000059");
    return { publisherId, base, v1, v2, v3, r1, shard, shardVol, shardRelease, shard4, shard4Vol, omnibus, omnibusVol, omnibusRelease };
  });
}

async function run(t: T, entries: RepairEntry[], dryRun = false) {
  return await t.mutation(internal.repair.runBatch, { entries, dryRun, actor: "ari" });
}

describe("label helpers", () => {
  it("canonicalizes numeric labels and keeps the rest", () => {
    expect(canonicalLabel("03")).toBe("3");
    expect(canonicalLabel("0")).toBe("0");
    expect(canonicalLabel("15.50")).toBe("15.5");
    expect(canonicalLabel("G1")).toBe("G1");
    expect(labelNumber("Side Story")).toBeNull();
    expect(sameLabel("01", "1")).toBe(true);
    expect(sameLabel(null, undefined)).toBe(true);
  });

  it("clusters per-volume shard titles onto their base title", () => {
    expect(clusterKey("Otherside Picnic 05 (Manga)")).toBe(clusterKey("Otherside Picnic"));
    expect(clusterKey("Lone Wolf and Cub Volume 5: Black Wind")).toBe(clusterKey("Lone Wolf and Cub"));
    expect(clusterKey("Noragami Omnibus 7 (Vol. 19-21)")).toBe(clusterKey("Noragami"));
    expect(clusterKey("Tokyo Ghoul:re")).not.toBe(clusterKey("Tokyo Ghoul"));
  });
});

describe("series merge", () => {
  it("dry-runs without writing, then merges by label and is idempotent", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry: RepairEntry = {
      kind: "mergeSeries",
      key: `series:${s.shard}`,
      reason: "PRH shard",
      loserId: s.shard,
      survivorId: s.base,
      placements: [{ volumeId: s.shardVol, label: "3", intoVolumeId: s.v3 }],
      packagingVolumeIds: [],
      retitle: null,
    };
    const dry = await run(t, [entry], true);
    expect(dry[0]?.status).toBe("applied");
    expect(await t.run(async (ctx) => (await ctx.db.get(s.shard))?.status)).toBe("active");
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(0);

    const [applied] = await run(t, [entry]);
    expect(applied?.status).toBe("applied");
    const state = await t.run(async (ctx) => ({
      loser: await ctx.db.get(s.shard),
      shardVol: await ctx.db.get(s.shardVol),
      release: await ctx.db.get(s.shardRelease.releaseId),
      coverage: await ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", s.v3)).collect(),
      revisions: await ctx.db.query("revisions").collect(),
      versions: await ctx.db.query("proposalVersions").collect(),
    }));
    expect(state.loser?.status).toBe("merged");
    expect(state.loser?.mergedIntoId).toBe(s.base);
    // Merged into the survivor's own "3", not appended as a fourth volume.
    expect(state.shardVol?.status).toBe("merged");
    expect(state.shardVol?.mergedIntoId).toBe(s.v3);
    expect(state.coverage).toHaveLength(1);
    expect(state.release?.seriesIds).toEqual([s.base]);
    expect(state.revisions.every((r) => r.author.kind === "user" && r.comment.startsWith("Data repair:"))).toBe(true);
    expect(state.versions).toHaveLength(1);

    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("moves a volume that the survivor lacks, at position = its number", async () => {
    const t = makeT();
    const s = await seed(t);
    const [out] = await run(t, [
      {
        kind: "mergeSeries",
        key: "k",
        reason: "r",
        loserId: s.shard4,
        survivorId: s.base,
        placements: [{ volumeId: s.shard4Vol, label: "4", intoVolumeId: null }],
        packagingVolumeIds: [],
        retitle: null,
      },
    ]);
    expect(out?.status).toBe("applied");
    const moved = await t.run(async (ctx) => await ctx.db.get(s.shard4Vol));
    expect(moved).toMatchObject({ status: "active", seriesId: s.base, label: "4", position: 4 });
  });

  it("skips on drift: the loser gained a volume the plan does not place", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const vol = await ctx.db.insert("volumes", { status: "active", publicId: 999, seriesId: s.shard, label: "9", position: 9 });
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 998, publisherId: s.publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId: vol, order: 1, extent: "complete" });
    });
    const [out] = await run(t, [
      {
        kind: "mergeSeries",
        key: "k",
        reason: "r",
        loserId: s.shard,
        survivorId: s.base,
        placements: [{ volumeId: s.shardVol, label: "3", intoVolumeId: s.v3 }],
        packagingVolumeIds: [],
        retitle: null,
      },
    ]);
    expect(out?.status).toBe("skipped");
    expect(await t.run(async (ctx) => (await ctx.db.get(s.shardVol))?.status)).toBe("active");
  });

  it("holds the merge while packaging volumes remain, and locks a contested title", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("sourceObservations", {
        sourceKey: "kodansha",
        sourceRecordId: "series:noragami-omnibus",
        recordRef: { type: "series", id: s.omnibus },
        snapshot: { kind: "series", title: "Noragami Omnibus" },
        lastSeenAt: 0,
        withdrawn: false,
      });
    });
    const merge: RepairEntry = {
      kind: "mergeSeries",
      key: "m",
      reason: "packaging shard",
      loserId: s.omnibus,
      survivorId: s.base,
      placements: [],
      packagingVolumeIds: [s.omnibusVol],
      retitle: null,
    };
    expect((await run(t, [merge]))[0]?.status).toBe("deferred");

    const remodel: RepairEntry = {
      kind: "remodelEdition",
      key: "e",
      reason: "omnibus",
      editionId: (await t.run(async (ctx) => (await ctx.db.get(s.omnibusRelease.releaseId))!.editionId)),
      volumeId: s.omnibusVol,
      targetSeriesId: s.base,
      line: { name: "Omnibus", position: "1" },
      bundle: null,
      groups: [
        {
          releaseIds: null,
          coverage: ["1", "2", "3"].map((label) => ({ label, volumeId: null, extent: "complete" as const })),
          linePosition: null,
        },
      ],
      retireVolumeIds: [s.omnibusVol],
    };
    expect((await run(t, [remodel]))[0]?.status).toBe("applied");
    expect((await run(t, [remodel]))[0]?.status).toBe("alreadyApplied");
    expect((await run(t, [merge]))[0]?.status).toBe("applied");

    const state = await t.run(async (ctx) => {
      const edition = await ctx.db.get(s.omnibusRelease.editionId);
      return {
        edition,
        line: edition?.editionLineId ? await ctx.db.get(edition.editionLineId) : null,
        coverage: await ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", s.omnibusRelease.editionId)).collect(),
        packagingVolume: await ctx.db.get(s.omnibusVol),
        base: await ctx.db.get(s.base),
        loser: await ctx.db.get(s.omnibus),
        release: await ctx.db.get(s.omnibusRelease.releaseId),
      };
    });
    expect(state.line).toMatchObject({ name: "Omnibus", seriesId: s.base });
    expect(state.edition?.linePosition).toBe("1");
    expect(state.coverage.map((c) => c.volumeId)).toEqual([s.v1, s.v2, s.v3]);
    expect(state.packagingVolume).toMatchObject({ status: "merged", mergedIntoId: s.v1 });
    expect(state.loser?.status).toBe("merged");
    expect(state.release?.seriesIds).toEqual([s.base]);
    // Kodansha (authoritative for titles) still calls it "Noragami Omnibus".
    expect(state.base?.overriddenFields).toEqual(["title"]);
  });
});

describe("packaging", () => {
  it("turns a box set into a Release Bundle with member releases", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry: RepairEntry = {
      kind: "remodelEdition",
      key: "b",
      reason: "box set",
      editionId: s.omnibusRelease.editionId,
      volumeId: s.omnibusVol,
      targetSeriesId: s.base,
      line: null,
      bundle: { name: "Noragami Box Set 1" },
      groups: [
        { releaseIds: null, coverage: ["1", "2"].map((label) => ({ label, volumeId: null, extent: "complete" as const })), linePosition: null },
      ],
      retireVolumeIds: [s.omnibusVol],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
    const state = await t.run(async (ctx) => ({
      bundles: await ctx.db.query("releaseBundles").collect(),
      members: await ctx.db.query("bundleMemberships").collect(),
      box: await ctx.db.get(s.omnibusRelease.releaseId),
    }));
    expect(state.bundles).toHaveLength(1);
    expect(state.bundles[0]).toMatchObject({ name: "Noragami Box Set 1", isbn13: "9780000000059" });
    expect(state.members.map((m) => m.order)).toEqual([1, 2]);
    expect(state.box?.status).toBe("hidden");
  });
});

describe("field repairs and scope", () => {
  it("applies expected-before changes, skips drift, and is idempotent", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry = (before: string | null): RepairEntry => ({
      kind: "updateFields",
      key: "u",
      reason: "isbn",
      table: "releases",
      id: s.r1.releaseId,
      changes: [{ field: "isbn10", before, after: "0000000019" }],
      evidenceObservationId: null,
    });
    expect((await run(t, [entry("9999999999")]))[0]?.status).toBe("skipped");
    expect((await run(t, [entry(null)]))[0]?.status).toBe("applied");
    expect((await run(t, [entry(null)]))[0]?.status).toBe("alreadyApplied");
  });

  it("hides a series with its cascade and unlinks an observation", async () => {
    const t = makeT();
    const s = await seed(t);
    const observationId = await t.run(async (ctx) =>
      await ctx.db.insert("sourceObservations", {
        sourceKey: "openlibrary",
        sourceRecordId: "/books/OL1M",
        recordRef: { type: "release", id: s.r1.releaseId },
        snapshot: {},
        lastSeenAt: 0,
        withdrawn: false,
      }),
    );
    const out = await run(t, [
      {
        kind: "hideSeries",
        key: "h",
        reason: "novel",
        seriesId: s.shard4,
        volumeIds: [s.shard4Vol],
        editionIds: [await t.run(async (ctx) => (await ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", s.shard4Vol)).unique())!.editionId)],
        releaseIds: await t.run(async (ctx) => {
          const row = await ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", s.shard4Vol)).unique();
          return (await ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", row!.editionId)).collect()).map((r) => r._id);
        }),
      },
      { kind: "unlinkObservation", key: "o", reason: "foreign book", observationId, recordType: "release", recordId: s.r1.releaseId },
    ]);
    expect(out.map((o) => o.status)).toEqual(["applied", "applied"]);
    const state = await t.run(async (ctx) => ({
      series: await ctx.db.get(s.shard4),
      volume: await ctx.db.get(s.shard4Vol),
      observation: await ctx.db.get(observationId),
    }));
    expect(state.series?.status).toBe("hidden");
    expect(state.volume?.status).toBe("hidden");
    expect(state.observation?.recordRef).toBeUndefined();
  });

  it("normalizes labels and settles positions to the volume number", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.v1, { label: "01", position: 2 });
      await ctx.db.patch(s.v2, { position: 3 });
      await ctx.db.patch(s.v3, { position: 4 });
      await ctx.db.insert("volumes", { status: "active", publicId: 900, seriesId: s.base, label: "Side Story", position: 1 });
    });
    const [out] = await run(t, [
      { kind: "normalizeVolumes", key: "n", reason: "positions", seriesId: s.base, merges: [], relabels: [] },
    ]);
    expect(out?.status).toBe("applied");
    const volumes = await t.run(async (ctx) =>
      (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", s.base)).collect()).map((v) => [v.label, v.position]),
    );
    expect(volumes).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 3],
      ["Side Story", 4],
    ]);
  });
});
