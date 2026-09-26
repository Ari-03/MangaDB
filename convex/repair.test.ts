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

  it("turns a print-labelled ebook digital and drops its binding", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => ctx.db.patch(s.r1.releaseId, { binding: "paperback" }));
    const entry: RepairEntry = {
      kind: "updateFields",
      key: "f",
      reason: "ebook recorded as print",
      table: "releases",
      id: s.r1.releaseId,
      changes: [{ field: "format", before: "physical", after: "digital" }],
      evidenceObservationId: null,
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const release = await t.run(async (ctx) => ctx.db.get(s.r1.releaseId));
    expect(release?.format).toBe("digital");
    expect(release?.binding).toBeUndefined();
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("clears a recorded placeholder cover", async () => {
    const t = makeT();
    const s = await seed(t);
    const before = { sourceUrl: "https://img.example/no-cover.svg", attribution: "Kodansha" };
    await t.run(async (ctx) => ctx.db.patch(s.r1.releaseId, { coverImage: before }));
    const entry: RepairEntry = {
      kind: "updateFields",
      key: "c",
      reason: "placeholder",
      table: "releases",
      id: s.r1.releaseId,
      changes: [{ field: "coverImage", before, after: null }],
      evidenceObservationId: null,
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect((await t.run(async (ctx) => ctx.db.get(s.r1.releaseId)))?.coverImage).toBeUndefined();
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("withdraws an untouched importer Proposal, and a dry run leaves it open", async () => {
    const t = makeT();
    await seed(t);
    const { proposalId, observationId } = await t.run(async (ctx) => {
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "prh" },
        state: "inReview",
        currentVersionNo: 1,
        submittedAt: 1,
      });
      const observationId = await ctx.db.insert("sourceObservations", {
        sourceKey: "prh",
        sourceRecordId: "9780000000066",
        snapshot: {},
        lastSeenAt: 1,
        withdrawn: false,
        queuedProposalId: proposalId,
      });
      return { proposalId, observationId };
    });
    const entry: RepairEntry = { kind: "withdrawProposal", key: "w", reason: "stale review", proposalId, observationId };
    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect((await t.run(async (ctx) => ctx.db.get(proposalId)))?.state).toBe("inReview");
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect((await t.run(async (ctx) => ctx.db.get(proposalId)))?.state).toBe("withdrawn");
    expect((await t.run(async (ctx) => ctx.db.get(observationId)))?.queuedProposalId).toBeUndefined();
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
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

describe("restore", () => {
  /** The shard4 Series' cascade (one Volume, Edition, Release), hidden by a hideSeries entry. */
  async function hiddenShard(t: T) {
    const s = await seed(t);
    const { editionId, releaseId } = await t.run(async (ctx) => {
      const row = await ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", s.shard4Vol)).unique();
      const release = await ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", row!.editionId)).unique();
      return { editionId: row!.editionId, releaseId: release!._id };
    });
    const hidden = await run(t, [
      { kind: "hideSeries", key: "h", reason: "western comic", seriesId: s.shard4, volumeIds: [s.shard4Vol], editionIds: [editionId], releaseIds: [releaseId] },
    ]);
    expect(hidden[0]?.status).toBe("applied");
    const entry: RepairEntry = {
      kind: "restoreRecord",
      key: "r",
      reason: "looks like manga",
      target: { type: "series", id: s.shard4 },
      volumeIds: [s.shard4Vol],
      editionIds: [editionId],
      releaseIds: [releaseId],
    };
    return { s, editionId, releaseId, entry };
  }

  const statuses = (t: T, ids: string[]) =>
    t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id as Id<"series">))?.status)));

  it("dry-runs without writing, then restores the hide's cascade with an audit trail, idempotently", async () => {
    const t = makeT();
    const { s, editionId, releaseId, entry } = await hiddenShard(t);
    const all = [s.shard4, s.shard4Vol, editionId, releaseId];
    const proposalsBefore = await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length);

    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect(await statuses(t, all)).toEqual(["hidden", "hidden", "hidden", "hidden"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(proposalsBefore);

    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await statuses(t, all)).toEqual(["active", "active", "active", "active"]);
    const trail = await t.run(async (ctx) => {
      const versions = await ctx.db.query("proposalVersions").collect();
      const revisions = await ctx.db.query("revisions").collect();
      return {
        ops: versions.at(-1)!.ops.map((op) => op.kind),
        restored: revisions.filter((r) => r.changes.some((c) => c.field === "status" && c.after === "active")),
      };
    });
    // Top-down through the stock Restore: one Revision per record.
    expect(trail.ops).toEqual(["restore", "restore", "restore", "restore"]);
    expect(trail.restored.map((r) => r.ref.id)).toEqual(all);
    expect(trail.restored.every((r) => r.comment === "Data repair: looks like manga")).toBe(true);

    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
  });

  it("restores a Release and its Edition inside a kept Series", async () => {
    const t = makeT();
    const s = await seed(t);
    const release = s.r1;
    await run(t, [{ kind: "hideRelease", key: "h", reason: "different book", releaseId: release.releaseId, editionId: release.editionId, volumeIds: [] }]);
    expect(await statuses(t, [release.releaseId, release.editionId, s.v1])).toEqual(["hidden", "hidden", "active"]);
    const entry: RepairEntry = {
      kind: "restoreRecord",
      key: "r",
      reason: "looks like manga",
      target: { type: "release", id: release.releaseId },
      volumeIds: [],
      editionIds: [release.editionId],
      releaseIds: [],
    };
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await statuses(t, [release.releaseId, release.editionId])).toEqual(["active", "active"]);
  });

  it("skips on drift: an orphaned restore, a merged row, a locked row", async () => {
    const t = makeT();
    const { s, editionId, releaseId, entry } = await hiddenShard(t);

    // The Release alone would land on an Edition that stays hidden.
    const orphan: RepairEntry = { ...entry, target: { type: "release", id: releaseId }, volumeIds: [], editionIds: [], releaseIds: [] };
    expect((await run(t, [orphan]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("stays hidden") });

    await t.run(async (ctx) => ctx.db.patch(editionId, { locked: true }));
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("locked") });
    // A skip rolls the whole entry back: the Series did not come back alone.
    expect(await statuses(t, [s.shard4])).toEqual(["hidden"]);

    await t.run(async (ctx) => ctx.db.patch(editionId, { locked: undefined, status: "merged" }));
    expect((await run(t, [entry]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("merged") });
  });
});

describe("series split", () => {
  /**
   * "Doubt!!" holding two works: vol 1 is work A's, the vol "2" label is
   * shared (work B's Yen Press book sits on it), and an unlabeled Volume is
   * wholly work B's vol 1. Both works' ANN records link the Series.
   */
  async function seedSplit(t: T) {
    const s = await seed(t);
    const ids = await t.run(async (ctx) => {
      const source = await ctx.db.insert("series", {
        status: "active",
        publicId: 500,
        title: "Doubt!!",
        altTitles: ["Rabbit Doubt"],
        searchText: "Doubt!! Rabbit Doubt",
      });
      const vol = async (label: string | undefined, position: number, publicId: number) =>
        await ctx.db.insert("volumes", { status: "active", publicId, seriesId: source, label, position });
      const edition = async (volumeId: Id<"volumes">, publicId: number, isbn13: string) => {
        const editionId = await ctx.db.insert("editions", { status: "active", publicId, publisherId: s.publisherId });
        await ctx.db.insert("volumeCoverages", { editionId, volumeId, order: 1, extent: "complete" });
        const releaseId = await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          language: "en",
          isbn13,
          publisherId: s.publisherId,
          seriesIds: [source],
        });
        return { editionId, releaseId };
      };
      const a1 = await vol("1", 1, 501);
      const shared2 = await vol("2", 2, 502);
      const unlabeled = await vol(undefined, 3, 503);
      const a1Edition = await edition(a1, 511, "9781591169086");
      const b2Edition = await edition(shared2, 512, "9780316335164");
      const b1Edition = await edition(unlabeled, 513, "9780316335157");
      const observation = async (sourceRecordId: string) =>
        await ctx.db.insert("sourceObservations", {
          sourceKey: "ann",
          sourceRecordId,
          recordRef: { type: "series", id: source },
          snapshot: { kind: "annManga", title: "Doubt" },
          lastSeenAt: 0,
          withdrawn: false,
        });
      const annA = await observation("manga:2849");
      const annB = await observation("manga:9570");
      return { source, a1, shared2, unlabeled, a1Edition, b2Edition, b1Edition, annA, annB };
    });
    const entry: RepairEntry = {
      kind: "splitSeries",
      key: "split:doubt",
      reason: "two works",
      sourceSeriesId: ids.source,
      sourceTitle: "Doubt!!",
      title: "Doubt",
      altTitles: ["Rabbit Doubt"],
      volumes: [{ volumeId: ids.unlabeled, label: null, newLabel: "1", editionIds: [ids.b1Edition.editionId] }],
      editions: [
        {
          editionId: ids.b2Edition.editionId,
          fromVolumeIds: [ids.shared2],
          labels: ["2"],
          releaseIds: [ids.b2Edition.releaseId],
        },
      ],
      placeholderLabels: ["1", "3"],
      observationIds: [ids.annB],
    };
    return { ...s, ...ids, entry };
  }

  const splitOff = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query("series").collect()).find((row) => row.title === "Doubt") ?? null);

  it("dry-runs without writing, then splits the second work out and is idempotent", async () => {
    const t = makeT();
    const s = await seedSplit(t);

    expect((await run(t, [s.entry], true))[0]?.status).toBe("applied");
    expect(await splitOff(t)).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(0);

    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = (await splitOff(t))!;
    expect(target).toMatchObject({ status: "active", altTitles: ["Rabbit Doubt"], searchText: "Doubt Rabbit Doubt" });
    const state = await t.run(async (ctx) => ({
      targetVolumes: (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", target._id)).collect()).map(
        (v) => [v.label ?? null, v.position, v._id],
      ),
      sourceVolumes: (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", s.source)).collect()).map(
        (v) => [v.label ?? null, v.position],
      ),
      b2Coverage: await ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", s.b2Edition.editionId)).collect(),
      b1Release: await ctx.db.get(s.b1Edition.releaseId),
      b2Release: await ctx.db.get(s.b2Edition.releaseId),
      a1Release: await ctx.db.get(s.a1Edition.releaseId),
      annA: await ctx.db.get(s.annA),
      annB: await ctx.db.get(s.annB),
      targetRevisions: await ctx.db.query("revisions").withIndex("by_record", (q) => q.eq("ref.type", "series").eq("ref.id", target._id)).collect(),
      sourceRevisions: await ctx.db.query("revisions").withIndex("by_record", (q) => q.eq("ref.type", "series").eq("ref.id", s.source)).collect(),
      versions: await ctx.db.query("proposalVersions").collect(),
    }));
    // The unlabeled volume became vol 1 (placeholder "1" reuses it); "2"
    // was created for the moved Edition; "3" is a new placeholder.
    expect(state.targetVolumes.map(([label, position]) => [label, position])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 3],
    ]);
    expect(state.targetVolumes[0]?.[2]).toBe(s.unlabeled);
    // The staying work keeps its vol 1 and the shared "2" (now a placeholder).
    expect(state.sourceVolumes).toEqual([
      ["1", 1],
      ["2", 2],
    ]);
    expect(state.b2Coverage.map((c) => c.volumeId)).toEqual([state.targetVolumes[1]?.[2]]);
    expect(state.b1Release?.seriesIds).toEqual([target._id]);
    expect(state.b2Release?.seriesIds).toEqual([target._id]);
    expect(state.a1Release?.seriesIds).toEqual([s.source]);
    expect(state.annA?.recordRef).toEqual({ type: "series", id: s.source });
    expect(state.annB?.recordRef).toEqual({ type: "series", id: target._id });
    const created = state.targetRevisions[0]!;
    expect(created.changes).toContainEqual({ field: "repairKey", after: "split:doubt" });
    expect(created.changes).toContainEqual({ field: "splitFrom", after: "#500 Doubt!!" });
    expect(state.sourceRevisions.flatMap((r) => r.changes.map((c) => c.field))).toEqual(["splitOut", "sourceObservation"]);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.ops.map((op) => op.kind)).toContain("split");
    expect(state.versions[0]?.evidence).toContainEqual({ kind: "observation", observationId: s.annB });

    // Re-runs find the split-off Series by its recorded key, even after an
    // importer attached a new Edition to a moved Volume.
    await t.run(async (ctx) => {
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 599, publisherId: s.publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId: s.unlabeled, order: 1, extent: "complete" });
    });
    expect((await run(t, [s.entry]))[0]?.status).toBe("alreadyApplied");
    expect(await t.run(async (ctx) => (await ctx.db.query("series").collect()).filter((row) => row.title === "Doubt").length)).toBe(1);
  });

  it("skips on drift instead of clobbering: a moved volume or edition gained an importer row", async () => {
    const t = makeT();
    const s = await seedSplit(t);
    const newEdition = await t.run(async (ctx) => {
      const editionId = await ctx.db.insert("editions", { status: "active", publicId: 598, publisherId: s.publisherId });
      await ctx.db.insert("volumeCoverages", { editionId, volumeId: s.unlabeled, order: 1, extent: "complete" });
      return editionId;
    });
    const [volumeDrift] = await run(t, [s.entry]);
    expect(volumeDrift).toMatchObject({ status: "skipped" });
    expect(volumeDrift?.reason).toContain("editions drifted");
    expect(await splitOff(t)).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.delete(newEdition);
      for (const row of await ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", newEdition)).collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.insert("releases", {
        status: "active",
        editionId: s.b2Edition.editionId,
        format: "digital",
        language: "en",
        publisherId: s.publisherId,
        seriesIds: [s.source],
      });
    });
    const [editionDrift] = await run(t, [s.entry]);
    expect(editionDrift?.status).toBe("skipped");
    expect(editionDrift?.reason).toContain("releases drifted");

    const [titleDrift] = await run(t, [{ ...s.entry, sourceTitle: "Doubt" }]);
    expect(titleDrift?.reason).toContain("source title drifted");
    expect(await splitOff(t)).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.get(s.annB))?.recordRef)).toEqual({ type: "series", id: s.source });
  });

  it("moves an Edition Line only when all of its Editions move", async () => {
    const t = makeT();
    const s = await seedSplit(t);
    const lineId = await t.run(async (ctx) => {
      const lineId = await ctx.db.insert("editionLines", { status: "active", seriesId: s.source, publisherId: s.publisherId, name: "Deluxe" });
      await ctx.db.patch(s.b2Edition.editionId, { editionLineId: lineId, linePosition: "2" });
      await ctx.db.patch(s.a1Edition.editionId, { editionLineId: lineId, linePosition: "1" });
      return lineId;
    });
    const [spans] = await run(t, [s.entry]);
    expect(spans?.reason).toContain("which stays");

    await t.run(async (ctx) => ctx.db.patch(s.a1Edition.editionId, { editionLineId: undefined, linePosition: undefined }));
    expect((await run(t, [s.entry]))[0]?.status).toBe("applied");
    const target = (await splitOff(t))!;
    expect((await t.run(async (ctx) => ctx.db.get(lineId)))?.seriesId).toBe(target._id);
  });
});

describe("volume normalization", () => {
  it("merges an unlabeled duplicate into vol 1 when the plan states its label", async () => {
    const t = makeT();
    const s = await seed(t);
    const dup = await t.run(async (ctx) =>
      ctx.db.insert("volumes", { status: "active", publicId: 901, seriesId: s.base, position: 4 }),
    );
    const entry = (label: string | null | undefined): RepairEntry => ({
      kind: "normalizeVolumes",
      key: "n",
      reason: "unlabeled copy of vol 1",
      seriesId: s.base,
      merges: [{ volumeId: dup, intoVolumeId: s.v1, ...(label === undefined ? {} : { label }) }],
      relabels: [],
    });
    expect((await run(t, [entry(undefined)]))[0]?.status).toBe("skipped");
    expect((await run(t, [entry("2")]))[0]?.status).toBe("skipped");
    expect((await run(t, [entry(null)]))[0]?.status).toBe("applied");
    expect(await t.run(async (ctx) => ctx.db.get(dup))).toMatchObject({ status: "merged", mergedIntoId: s.v1 });
  });
});

describe("lines, researched releases, cross-series books", () => {
  const status = (t: T, id: string) => t.run(async (ctx) => (await ctx.db.get(id as Id<"series">))?.status);
  const count = (t: T, table: "proposals" | "releases" | "releaseBundles" | "bundleMemberships" | "editionLines") =>
    t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

  it("hides an empty Edition Line, idempotently, and refuses one that still holds an Edition", async () => {
    const t = makeT();
    const s = await seed(t);
    const { empty, used } = await t.run(async (ctx) => {
      const empty = await ctx.db.insert("editionLines", { status: "active", seriesId: s.base, publisherId: s.publisherId, name: "Omnibus" });
      const used = await ctx.db.insert("editionLines", { status: "active", seriesId: s.base, publisherId: s.publisherId, name: "Deluxe" });
      await ctx.db.patch(s.r1.editionId, { editionLineId: used });
      return { empty, used };
    });
    const entry: RepairEntry = { kind: "hideEditionLine", key: "l", reason: "empty line", lineId: empty, seriesId: s.base, name: "Omnibus" };

    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect(await status(t, empty)).toBe("active");
    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    expect(await status(t, empty)).toBe("hidden");
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");

    const busy: RepairEntry = { ...entry, key: "u", lineId: used, name: "Deluxe" };
    expect((await run(t, [busy]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("still holds") });
    const renamed: RepairEntry = { ...entry, key: "n", name: "Omnibus Edition" };
    expect((await run(t, [renamed]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("renamed") });
  });

  it("creates a researched Release on a new Edition in a line, with an audit trail, and never duplicates an ISBN", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry: RepairEntry = {
      kind: "createRelease",
      key: "c",
      reason: "missing hardcover",
      isbn13: "9780000000066",
      isbn10: "0000000060",
      format: "physical",
      binding: "hardcover",
      pubDate: { year: 2021, month: 1, day: 5, sort: 20210105 },
      price: { amountCents: 3299, currency: "USD" },
      publisherId: s.publisherId,
      coverage: [
        { volumeId: s.v2, extent: "complete" },
        { volumeId: s.v3, extent: "partial" },
      ],
      line: { name: "Resurrected Edition", position: "4" },
      sources: ["https://example.com/book"],
    };
    const releasesBefore = await count(t, "releases");

    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect(await count(t, "releases")).toBe(releasesBefore);

    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const made = await t.run(async (ctx) => {
      const release = await ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", "9780000000066")).unique();
      const edition = await ctx.db.get(release!.editionId);
      const line = edition?.editionLineId ? await ctx.db.get(edition.editionLineId) : null;
      const coverage = await ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", release!.editionId)).collect();
      const created = await ctx.db.query("revisions").withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", release!._id)).first();
      const version = (await ctx.db.query("proposalVersions").collect()).at(-1);
      return { release, edition, line, coverage, created, version };
    });
    expect(made.release).toMatchObject({ binding: "hardcover", isbn10: "0000000060", seriesIds: [s.base], price: { amountCents: 3299 } });
    expect(made.edition).toMatchObject({ publisherId: s.publisherId, linePosition: "4" });
    expect(made.line).toMatchObject({ name: "Resurrected Edition", seriesId: s.base });
    expect(made.coverage.map((c) => [c.volumeId, c.extent])).toEqual([[s.v2, "complete"], [s.v3, "partial"]]);
    expect(made.created?.changes).toContainEqual({ field: "repairKey", after: "c" });
    expect(made.version?.evidence).toContainEqual({ kind: "url", url: "https://example.com/book" });

    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");
    // Another entry for an ISBN already on file (here: the one just made, or any other Release) is refused.
    expect((await run(t, [{ ...entry, key: "c2" }]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("already exists") });
    expect((await run(t, [{ ...entry, key: "c3", isbn13: "9780000000011", isbn10: null }]))[0]).toMatchObject({ status: "skipped" });
  });

  it("turns a box set into a bundle whose members span Series, in plan order, and extends a bundle", async () => {
    const t = makeT();
    const s = await seed(t);
    const entry: RepairEntry = {
      kind: "releaseBundle",
      key: "b",
      reason: "box set of two works",
      bundleId: null,
      box: { releaseId: s.omnibusRelease.releaseId, name: "Noragami Box Set" },
      members: [
        { isbn13: "9780000000035", order: 1 },
        { isbn13: "9780000000011", order: 2 },
      ],
      retireVolumeIds: [s.omnibusVol],
    };
    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect(await count(t, "releaseBundles")).toBe(0);

    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const made = await t.run(async (ctx) => {
      const bundle = await ctx.db.query("releaseBundles").withIndex("by_isbn13", (q) => q.eq("isbn13", "9780000000059")).unique();
      const members = await ctx.db.query("bundleMemberships").withIndex("by_bundle", (q) => q.eq("bundleId", bundle!._id)).collect();
      const retired = await ctx.db.get(s.omnibusVol);
      return { bundle, members: members.map((m) => [m.releaseId, m.order]), retired };
    });
    expect(made.bundle).toMatchObject({ name: "Noragami Box Set", format: "physical" });
    expect(made.members).toEqual([[s.shardRelease.releaseId, 1], [s.r1.releaseId, 2]]);
    expect(await status(t, s.omnibusRelease.releaseId)).toBe("hidden");
    expect(await status(t, s.omnibusRelease.editionId)).toBe("hidden");
    // Retired into the first member's Volume, which sits in another Series.
    expect(made.retired).toMatchObject({ status: "merged", mergedIntoId: s.shardVol });
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");

    // Extending the bundle: a new member joins; a member at another order is drift.
    const bundleId = made.bundle!._id;
    const extend: RepairEntry = { ...entry, key: "e", box: null, bundleId, members: [{ isbn13: "9780000000028", order: 3 }], retireVolumeIds: [] };
    expect((await run(t, [extend]))[0]?.status).toBe("applied");
    expect(await count(t, "bundleMemberships")).toBe(3);
    const moved: RepairEntry = { ...extend, key: "m", members: [{ isbn13: "9780000000011", order: 1 }] };
    expect((await run(t, [moved]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("sits at order 2") });
  });

  it("covers Volumes of several Series with one Edition, places it in a line, and skips on drift", async () => {
    const t = makeT();
    const s = await seed(t);
    const edition = await t.run(async (ctx) =>
      (await ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", s.shard4Vol)).unique())!.editionId,
    );
    const entry: RepairEntry = {
      kind: "setCoverage",
      key: "s",
      reason: "3-in-1 across two series",
      editionId: edition,
      before: [s.shard4Vol],
      coverage: [
        { seriesId: s.base, label: "3", extent: "complete" },
        { seriesId: s.shard, label: "3", extent: "partial" },
      ],
      line: { seriesId: s.base, name: "3-in-1 Edition", position: "3" },
      retireVolumeIds: [s.shard4Vol],
    };
    expect((await run(t, [{ ...entry, before: [s.v1] }]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("drifted") });
    expect((await run(t, [entry], true))[0]?.status).toBe("applied");
    expect(await count(t, "editionLines")).toBe(0);

    expect((await run(t, [entry]))[0]?.status).toBe("applied");
    const after = await t.run(async (ctx) => {
      const coverage = await ctx.db.query("volumeCoverages").withIndex("by_edition", (q) => q.eq("editionId", edition)).collect();
      const release = await ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition)).unique();
      const doc = await ctx.db.get(edition);
      const line = doc?.editionLineId ? await ctx.db.get(doc.editionLineId) : null;
      return { coverage: coverage.map((c) => [c.volumeId, c.extent]), seriesIds: release?.seriesIds, doc, line, retired: await ctx.db.get(s.shard4Vol) };
    });
    expect(after.coverage).toEqual([[s.v3, "complete"], [s.shardVol, "partial"]]);
    expect(after.seriesIds).toEqual([s.base, s.shard]);
    expect(after.doc?.linePosition).toBe("3");
    expect(after.line).toMatchObject({ seriesId: s.base, name: "3-in-1 Edition" });
    expect(after.retired).toMatchObject({ status: "merged", mergedIntoId: s.v3 });
    expect((await run(t, [entry]))[0]?.status).toBe("alreadyApplied");

    // A label with no Volume is never created: skip.
    const missing: RepairEntry = { ...entry, key: "x", coverage: [{ seriesId: s.base, label: "9", extent: "complete" }] };
    expect((await run(t, [missing]))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("0 active volumes") });
  });
});
