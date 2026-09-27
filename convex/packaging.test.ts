import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const ADMIN = "user_admin";
const MOD = "user_mod";
const EDITOR = "user_editor";
const PLAIN = "user_plain";

async function setup() {
  const t = convexTest(schema);
  await t.withIdentity({ subject: ADMIN }).mutation(api.users.claimUsername, { username: "alice" });
  await t.withIdentity({ subject: MOD }).mutation(api.users.claimUsername, { username: "bob" });
  await t.withIdentity({ subject: EDITOR }).mutation(api.users.claimUsername, { username: "carol" });
  await t.withIdentity({ subject: PLAIN }).mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t.withIdentity({ subject: ADMIN }).mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  await t.withIdentity({ subject: ADMIN }).mutation(api.roles.appoint, { username: "carol", role: "editor" });

  // Berserk with Volumes 1–6 and an unmapped "Deluxe 2" from Dark Horse.
  const ids = await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Dark Horse",
      slug: "dark-horse",
    });
    const seriesId = await ctx.db.insert("series", {
      status: "active",
      publicId: 1,
      title: "Berserk",
      altTitles: [],
      searchText: "Berserk",
    });
    const volumeIds: Id<"volumes">[] = [];
    for (let n = 1; n <= 6; n++) {
      volumeIds.push(
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: n,
          seriesId,
          position: n,
          label: String(n),
        }),
      );
    }
    const editionLineId = await ctx.db.insert("editionLines", {
      status: "active",
      seriesId,
      publisherId,
      name: "Deluxe",
    });
    const editionId = await ctx.db.insert("editions", {
      status: "active",
      publicId: 1,
      publisherId,
      editionLineId,
      linePosition: "2",
      coverageUnmapped: true,
    });
    const releaseId = await ctx.db.insert("releases", {
      status: "active",
      editionId,
      format: "physical",
      binding: "hardcover",
      language: "en",
      isbn13: "9781506711998",
      publisherId,
      seriesIds: [seriesId],
    });
    return { seriesId, editionId, releaseId, volumeIds };
  });
  return { t, ...ids };
}

describe("packaging — Unmapped Packaging queue and mapping", () => {
  it("lists unmapped line members to the Data Team with the Series' Volume labels", async () => {
    const { t, editionId } = await setup();
    const queue = await t.withIdentity({ subject: EDITOR }).query(api.packaging.unmappedQueue, {});
    expect(queue.hasMore).toBe(false);
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      editionId,
      title: "Berserk Deluxe 2",
      lineName: "Deluxe",
      linePosition: "2",
      publisher: "Dark Horse",
      series: { publicId: 1, title: "Berserk" },
      isbns: ["9781506711998"],
      volumeLabels: ["1", "2", "3", "4", "5", "6"],
    });
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.packaging.unmappedQueue, {}),
    ).rejects.toThrow();
  });

  it("maps the Edition onto Volumes from..to, clears the flag, and records the Revision", async () => {
    const { t, editionId, releaseId, seriesId, volumeIds } = await setup();
    const result = await t
      .withIdentity({ subject: MOD })
      .mutation(api.packaging.mapEditionCoverage, {
        editionId,
        from: "4",
        to: "6",
        comment: "Dark Horse flap copy: collects volumes 4–6.",
      });
    expect(result.covered).toBe(3);
    await t.run(async (ctx) => {
      const rows = (
        await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", editionId))
          .collect()
      ).sort((a, b) => a.order - b.order);
      expect(rows.map((r) => r.volumeId)).toEqual(volumeIds.slice(3, 6));
      expect(rows.every((r) => r.extent === "complete")).toBe(true);
      expect((await ctx.db.get(editionId))?.coverageUnmapped).toBeUndefined();
      expect((await ctx.db.get(releaseId))?.seriesIds).toEqual([seriesId]);
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "edition").eq("ref.id", editionId))
        .collect();
      expect(revisions.map((r) => r.changes.map((c) => c.field)).flat().sort()).toEqual([
        "coverageUnmapped",
        "volumeCoverage",
      ]);
      expect(revisions.every((r) => r.author.kind === "user")).toBe(true);
    });
    // Gone from the queue.
    const queue = await t.withIdentity({ subject: MOD }).query(api.packaging.unmappedQueue, {});
    expect(queue.rows).toHaveLength(0);
  });

  it("refuses Editors, empty comments, unknown Volumes and backwards ranges", async () => {
    const { t, editionId } = await setup();
    const map = (subject: string, args: { from: string; to: string; comment: string }) =>
      t.withIdentity({ subject }).mutation(api.packaging.mapEditionCoverage, { editionId, ...args });
    await expect(map(EDITOR, { from: "1", to: "3", comment: "x" })).rejects.toThrow();
    await expect(map(MOD, { from: "1", to: "3", comment: "  " })).rejects.toThrow(/commentRequired/);
    await expect(map(MOD, { from: "1", to: "9", comment: "x" })).rejects.toThrow(/unknownVolume/);
    await expect(map(MOD, { from: "3", to: "1", comment: "x" })).rejects.toThrow(/badRange/);
  });
});

describe("packaging — Bookless Series queue", () => {
  it("lists flagged series with their volume count and the ANN entry that built them", async () => {
    const { t, seriesId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(seriesId, { bookless: true });
      await ctx.db.insert("sourceObservations", {
        sourceKey: "ann",
        sourceRecordId: "manga:2298",
        snapshot: { kind: "annManga" },
        lastSeenAt: Date.now(),
        withdrawn: false,
        recordRef: { type: "series", id: seriesId },
      });
    });
    const queue = await t.withIdentity({ subject: EDITOR }).query(api.packaging.booklessQueue, {});
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      publicId: 1,
      title: "Berserk",
      volumeCount: 6,
      sources: [{ sourceKey: "ann", recordId: "manga:2298" }],
    });
    await expect(t.withIdentity({ subject: PLAIN }).query(api.packaging.booklessQueue, {})).rejects.toThrow();
  });
});
