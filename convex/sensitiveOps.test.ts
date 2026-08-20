// Sensitive catalog operations (ticket #33, spec §5): Hide/Restore
// round-trips, Merge's transfer of observations, relationships, and user
// tracking (with the loser's URLs resolving to the survivor — the 301
// source), Split as the only reversal of a merge, the ordinary-edit locks on
// Hidden/Merged records plus temporary Moderator locks, and the
// reason + impact preview + explicit confirmation every operation demands.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import schema from "./schema";

function makeT() {
  const t = convexTest(schema);
  // The rate-limiter component (convex.config.ts) backs the proposal rate
  // limits saveDraft hits in the lock test.
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

const ADMIN = "user_admin";
const MOD = "user_mod";
const EDITOR = "user_editor";
const PLAIN = "user_plain";

async function setup(t: ReturnType<typeof convexTest>) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: MOD })
    .mutation(api.users.claimUsername, { username: "bob" });
  await t
    .withIdentity({ subject: EDITOR })
    .mutation(api.users.claimUsername, { username: "carol" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "carol", role: "editor" });
}

async function userIdOf(
  t: ReturnType<typeof convexTest>,
  username: string,
): Promise<Id<"users">> {
  const user = await t.run(async (ctx) =>
    (await ctx.db.query("users").collect()).find((u) => u.username === username),
  );
  if (!user) throw new Error(`no user ${username}`);
  return user._id;
}

/**
 * Two Series that are catalog duplicates plus a bystander: the survivor
 * "Alpha" (vol 1, edition, release), the loser "Alpha (dupe)" (vol 1,
 * edition, release, a linked Source Observation, relationship edges to both
 * the survivor and the bystander "Gamma"), and user tracking on both sides —
 * dave tracks both duplicates (dedup case), carol tracks only the loser
 * (transfer case).
 */
async function seedMergeFixture(t: ReturnType<typeof convexTest>) {
  const daveId = await userIdOf(t, "dave");
  const carolId = await userIdOf(t, "carol");
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });
    const makeSeries = async (publicId: number, title: string) =>
      await ctx.db.insert("series", {
        status: "active",
        publicId,
        title,
        altTitles: [],
        searchText: title,
      });
    const survivor = await makeSeries(1, "Alpha");
    const loser = await makeSeries(2, "Alpha (dupe)");
    const bystander = await makeSeries(3, "Gamma");

    const makeBook = async (
      seriesId: Id<"series">,
      volumePublicId: number,
      editionPublicId: number,
      isbn13: string,
    ) => {
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: volumePublicId,
        seriesId,
        position: 1,
        label: "1",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: editionPublicId,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        isbn13,
        pubDate: { year: 2026, month: 3, day: 10, sort: 20260310 },
        publisherId,
        seriesIds: [seriesId],
      });
      return { volumeId, editionId, releaseId };
    };
    const survivorBook = await makeBook(survivor, 11, 21, "9781999000103");
    const loserBook = await makeBook(loser, 12, 22, "9781999000318");

    // Provenance on the loser.
    const observationId = await ctx.db.insert("sourceObservations", {
      sourceKey: "sevenSeas",
      sourceRecordId: "alpha-dupe",
      recordRef: { type: "series", id: loser },
      snapshot: { title: "Alpha (dupe)" },
      lastSeenAt: Date.now(),
      withdrawn: false,
    });

    // Relationship edges: loser→survivor becomes a self-edge (dropped);
    // loser→bystander repoints to survivor→bystander.
    const selfEdge = await ctx.db.insert("seriesRelationships", {
      fromSeriesId: loser,
      toSeriesId: survivor,
      type: "sideStory",
    });
    const keptEdge = await ctx.db.insert("seriesRelationships", {
      fromSeriesId: loser,
      toSeriesId: bystander,
      type: "spinoff",
    });

    // Tracking: dave follows both duplicates, carol only the loser.
    await ctx.db.insert("userSeriesStates", {
      userId: daveId,
      seriesId: survivor,
      readingStatus: "reading",
      following: true,
      followPromptDismissed: false,
    });
    await ctx.db.insert("userSeriesStates", {
      userId: daveId,
      seriesId: loser,
      readingStatus: "completed",
      following: true,
      followPromptDismissed: true,
    });
    await ctx.db.insert("userSeriesStates", {
      userId: carolId,
      seriesId: loser,
      readingStatus: "planToRead",
      following: false,
      followPromptDismissed: false,
    });
    await ctx.db.insert("volumeProgress", {
      userId: daveId,
      volumeId: loserBook.volumeId,
      seriesId: loser,
      readCount: 2,
    });

    return {
      publisherId,
      survivor,
      loser,
      bystander,
      survivorBook,
      loserBook,
      observationId,
      selfEdge,
      keptEdge,
      daveId,
      carolId,
    };
  });
}

const asMod = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: MOD });

describe("sensitiveOps — authorization, reason, and confirmation", () => {
  it("demands the Moderator role, a reason, and explicit confirmation", async () => {
    const t = makeT();
    await setup(t);
    const { survivor } = await seedMergeFixture(t);
    const ref = { type: "series" as const, id: survivor };

    // Editors and plain users cannot perform sensitive operations.
    for (const subject of [PLAIN, EDITOR]) {
      await expect(
        t.withIdentity({ subject }).mutation(api.sensitiveOps.hideRecord, {
          ref,
          reason: "Testing.",
          confirmImpact: true,
        }),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    // A reason is required.
    await expect(
      asMod(t).mutation(api.sensitiveOps.hideRecord, {
        ref,
        reason: "   ",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "reasonRequired" } });
    // The impact preview must be explicitly confirmed.
    await expect(
      asMod(t).mutation(api.sensitiveOps.hideRecord, {
        ref,
        reason: "Duplicate.",
        confirmImpact: false,
      }),
    ).rejects.toMatchObject({ data: { code: "confirmRequired" } });
  });

  it("manageForm serves the impact preview to Moderators only", async () => {
    const t = makeT();
    await setup(t);
    await seedMergeFixture(t);

    await expect(
      t
        .withIdentity({ subject: EDITOR })
        .query(api.sensitiveOps.manageForm, { type: "series", key: "1" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const form = await asMod(t).query(api.sensitiveOps.manageForm, {
      type: "series",
      key: "2",
    });
    expect(form).not.toBeNull();
    expect(form!.status).toBe("active");
    expect(form!.splitAvailable).toBe(false);
    const counts = Object.fromEntries(form!.impact.map((r) => [r.label, r.count]));
    expect(counts["Source observations"]).toBe(1);
    expect(counts["Volumes"]).toBe(1);
    expect(counts["Relationship edges"]).toBe(2);
    expect(counts["User series states (follows, reading, visibility)"]).toBe(2);
    expect(counts["Volume read counts"]).toBe(1);
  });
});

describe("sensitiveOps — hide and restore", () => {
  it("round-trips a record without losing history or tracking references", async () => {
    const t = makeT();
    await setup(t);
    const { survivor, daveId } = await seedMergeFixture(t);
    const ref = { type: "series" as const, id: survivor };

    // Give the record some history first.
    await asMod(t).mutation(api.moderation.submitDirectEdit, {
      ref,
      changes: [{ field: "title", value: "Alpha!" }],
      comment: "Punctuation per the cover.",
    });

    const hidden = await asMod(t).mutation(api.sensitiveOps.hideRecord, {
      ref,
      reason: "Publisher takedown request.",
      confirmImpact: true,
    });
    expect(hidden.revisionIds).toHaveLength(1);

    // Gone from public discovery…
    expect(await t.query(api.catalog.seriesPage, { publicId: 1 })).toBeNull();
    // …but identity, history, and tracking references are preserved.
    const doc = await t.run((ctx) => ctx.db.get(survivor));
    expect(doc).toMatchObject({ status: "hidden", title: "Alpha!", publicId: 1 });
    const states = await t.run(async (ctx) =>
      (await ctx.db.query("userSeriesStates").collect()).filter(
        (s) => s.seriesId === survivor && s.userId === daveId,
      ),
    );
    expect(states).toHaveLength(1);

    // Hidden records reject ordinary edits.
    await expect(
      asMod(t).mutation(api.moderation.submitDirectEdit, {
        ref,
        baseRevisionId: hidden.revisionIds[0],
        changes: [{ field: "title", value: "Beta" }],
        comment: "Nope.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });

    const restored = await asMod(t).mutation(api.sensitiveOps.restoreRecord, {
      ref,
      reason: "Request withdrawn.",
      confirmImpact: true,
    });
    expect(restored.revisionIds).toHaveLength(1);
    const page = await t.query(api.catalog.seriesPage, { publicId: 1 });
    expect(page?.series.title).toBe("Alpha!");

    // The full history survived the round-trip: edit, hide, restore.
    const history = await t.query(api.moderation.recordHistory, {
      type: "series",
      publicId: 1,
    });
    expect(history?.revisions.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(history?.revisions[1]).toMatchObject({
      comment: "Publisher takedown request.",
      changes: [{ field: "status", before: "active", after: "hidden" }],
    });
  });

  it("hide requires an active record; restore requires a hidden one", async () => {
    const t = makeT();
    await setup(t);
    const { survivor } = await seedMergeFixture(t);
    const ref = { type: "series" as const, id: survivor };

    await expect(
      asMod(t).mutation(api.sensitiveOps.restoreRecord, {
        ref,
        reason: "Not hidden.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });

    await asMod(t).mutation(api.sensitiveOps.hideRecord, {
      ref,
      reason: "Hide once.",
      confirmImpact: true,
    });
    await expect(
      asMod(t).mutation(api.sensitiveOps.hideRecord, {
        ref,
        reason: "Hide twice.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
  });
});

describe("sensitiveOps — temporary locks", () => {
  it("locks an active record against ordinary edits until unlocked", async () => {
    const t = makeT();
    await setup(t);
    const { survivor } = await seedMergeFixture(t);
    const ref = { type: "series" as const, id: survivor };

    await asMod(t).mutation(api.sensitiveOps.lockRecord, {
      ref,
      reason: "Disputed rename — freezing while we check the source.",
      confirmImpact: true,
    });

    // Direct edits and Editor proposal drafts both refuse a locked record.
    await expect(
      asMod(t).mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "title", value: "Beta" }],
        comment: "Nope.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });
    await expect(
      t.withIdentity({ subject: EDITOR }).mutation(api.proposals.saveDraft, {
        ops: [
          { kind: "update", ref, changes: [{ field: "title", value: "Beta" }] },
        ],
        evidence: [],
        comment: "Nope.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });

    // Locking twice is refused; unlock lifts the freeze.
    await expect(
      asMod(t).mutation(api.sensitiveOps.lockRecord, {
        ref,
        reason: "Again.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
    await asMod(t).mutation(api.sensitiveOps.unlockRecord, {
      ref,
      reason: "Dispute resolved.",
      confirmImpact: true,
    });
    const edit = await asMod(t).mutation(api.moderation.submitDirectEdit, {
      ref,
      baseRevisionId: await t.run(async (ctx) => {
        const revisions = await ctx.db.query("revisions").collect();
        return revisions
          .filter((r) => r.ref.id === survivor)
          .sort((a, b) => b.seq - a.seq)[0]?._id;
      }),
      changes: [{ field: "title", value: "Beta" }],
      comment: "Resolved rename.",
    });
    expect(edit.seq).toBeGreaterThan(0);
  });
});

describe("sensitiveOps — merge", () => {
  it("transfers observations, relationships, and tracking; the losing ID resolves to the survivor", async () => {
    const t = makeT();
    await setup(t);
    const fixture = await seedMergeFixture(t);
    const { survivor, loser, bystander, observationId } = fixture;

    await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: survivor },
      loser: { type: "series", id: loser },
      reason: "Duplicate created by the import sweep.",
      confirmImpact: true,
    });

    // The loser keeps its identity and points at the winner.
    const loserDoc = await t.run((ctx) => ctx.db.get(loser));
    expect(loserDoc).toMatchObject({
      status: "merged",
      mergedIntoId: survivor,
      publicId: 2,
    });

    // Source Observations transferred.
    const observation = await t.run((ctx) => ctx.db.get(observationId));
    expect(observation?.recordRef).toEqual({ type: "series", id: survivor });

    // Relationships: the loser→survivor edge dropped as a self-edge; the
    // loser→bystander edge repointed to the survivor.
    const edges = await t.run((ctx) => ctx.db.query("seriesRelationships").collect());
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromSeriesId: survivor,
      toSeriesId: bystander,
      type: "spinoff",
    });

    // Tracking: dave's duplicate row deduped (survivor's row wins), carol's
    // row transferred, dave's volume read count keeps its series denorm.
    const states = await t.run((ctx) => ctx.db.query("userSeriesStates").collect());
    expect(states.filter((s) => s.seriesId === loser)).toHaveLength(0);
    const daveStates = states.filter((s) => s.userId === fixture.daveId);
    expect(daveStates).toHaveLength(1);
    expect(daveStates[0]).toMatchObject({
      seriesId: survivor,
      readingStatus: "reading",
    });
    const carolStates = states.filter((s) => s.userId === fixture.carolId);
    expect(carolStates).toHaveLength(1);
    expect(carolStates[0]).toMatchObject({
      seriesId: survivor,
      readingStatus: "planToRead",
    });
    const progress = await t.run((ctx) => ctx.db.query("volumeProgress").collect());
    expect(progress[0]).toMatchObject({ seriesId: survivor, readCount: 2 });

    // The loser's volume joined the survivor's reading path after its own.
    const movedVolume = await t.run((ctx) => ctx.db.get(fixture.loserBook.volumeId));
    expect(movedVolume).toMatchObject({ seriesId: survivor, position: 2 });
    // Release denorms recomputed.
    const movedRelease = await t.run((ctx) => ctx.db.get(fixture.loserBook.releaseId));
    expect(movedRelease?.seriesIds).toEqual([survivor]);

    // The losing public ID resolves to the survivor — the routes' permanent
    // 301 source (merged-doc pointer, no redirects table).
    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.series.publicId).toBe(1);
    expect(page?.volumes.map((v) => v.publicId)).toEqual([11, 12]);

    // One Revision landed on each side, sharing the reason.
    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    const loserRevision = revisions.find((r) => r.ref.id === loser);
    expect(loserRevision?.comment).toBe("Duplicate created by the import sweep.");
    expect(loserRevision?.changes[0]).toMatchObject({
      field: "status",
      after: "merged",
    });
    expect(revisions.some((r) => r.ref.id === survivor)).toBe(true);

    // Merged records reject ordinary edits…
    await expect(
      asMod(t).mutation(api.moderation.submitDirectEdit, {
        ref: { type: "series", id: loser },
        changes: [{ field: "title", value: "Beta" }],
        comment: "Nope.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });
    // …and further sensitive ops that need an active record.
    await expect(
      asMod(t).mutation(api.sensitiveOps.hideRecord, {
        ref: { type: "series", id: loser },
        reason: "Nope.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
  });

  it("refuses self-merges, cross-type merges, and non-active participants", async () => {
    const t = makeT();
    await setup(t);
    const { survivor, loser } = await seedMergeFixture(t);

    await expect(
      asMod(t).mutation(api.sensitiveOps.mergeRecords, {
        survivor: { type: "series", id: survivor },
        loser: { type: "series", id: survivor },
        reason: "Self.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badMerge" } });

    await asMod(t).mutation(api.sensitiveOps.hideRecord, {
      ref: { type: "series", id: loser },
      reason: "Hidden first.",
      confirmImpact: true,
    });
    await expect(
      asMod(t).mutation(api.sensitiveOps.mergeRecords, {
        survivor: { type: "series", id: survivor },
        loser: { type: "series", id: loser },
        reason: "Loser hidden.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
  });

  it("deduplicates release-level tracking on a release merge", async () => {
    const t = makeT();
    await setup(t);
    const fixture = await seedMergeFixture(t);
    const survivorRelease = fixture.survivorBook.releaseId;
    const loserRelease = fixture.loserBook.releaseId;

    await t.run(async (ctx) => {
      // dave collects both duplicates; carol only the loser.
      await ctx.db.insert("collectionEntries", {
        userId: fixture.daveId,
        releaseId: survivorRelease,
        state: "owned",
      });
      await ctx.db.insert("collectionEntries", {
        userId: fixture.daveId,
        releaseId: loserRelease,
        state: "wanted",
      });
      await ctx.db.insert("collectionEntries", {
        userId: fixture.carolId,
        releaseId: loserRelease,
        state: "ordered",
      });
      await ctx.db.insert("releaseProgress", {
        userId: fixture.carolId,
        releaseId: loserRelease,
        seriesId: fixture.loser,
        percent: 40,
      });
    });

    await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "release", id: survivorRelease },
      loser: { type: "release", id: loserRelease },
      reason: "Same ISBN listed twice.",
      confirmImpact: true,
    });

    const entries = await t.run((ctx) => ctx.db.query("collectionEntries").collect());
    expect(entries.filter((e) => e.releaseId === loserRelease)).toHaveLength(0);
    const dave = entries.filter((e) => e.userId === fixture.daveId);
    expect(dave).toHaveLength(1);
    expect(dave[0]).toMatchObject({ releaseId: survivorRelease, state: "owned" });
    const carol = entries.filter((e) => e.userId === fixture.carolId);
    expect(carol[0]).toMatchObject({ releaseId: survivorRelease, state: "ordered" });
    const progress = await t.run((ctx) => ctx.db.query("releaseProgress").collect());
    expect(progress[0]).toMatchObject({ releaseId: survivorRelease, percent: 40 });
  });
});

describe("sensitiveOps — split", () => {
  it("reverses a merge exactly; Restore cannot", async () => {
    const t = makeT();
    await setup(t);
    const fixture = await seedMergeFixture(t);
    const { survivor, loser, bystander } = fixture;

    const before = {
      states: await t.run((ctx) => ctx.db.query("userSeriesStates").collect()),
      edges: await t.run((ctx) => ctx.db.query("seriesRelationships").collect()),
    };

    await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: survivor },
      loser: { type: "series", id: loser },
      reason: "Mistaken duplicate.",
      confirmImpact: true,
    });

    // Restore is not the reversal of a merge.
    await expect(
      asMod(t).mutation(api.sensitiveOps.restoreRecord, {
        ref: { type: "series", id: loser },
        reason: "Wrong tool.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });

    // The manage panel offers Split for the merged loser.
    const form = await asMod(t).query(api.sensitiveOps.manageForm, {
      type: "series",
      key: "2",
    });
    expect(form?.status).toBe("merged");
    expect(form?.splitAvailable).toBe(true);
    expect(form?.mergedInto?.title).toBe("Alpha");

    await asMod(t).mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "series", id: loser },
      reason: "The two series are actually different works.",
      confirmImpact: true,
    });

    // The loser is active again and no longer points at the survivor.
    const loserDoc = await t.run((ctx) => ctx.db.get(loser));
    expect(loserDoc?.status).toBe("active");
    expect(loserDoc?.mergedIntoId).toBeUndefined();
    expect((await t.query(api.catalog.seriesPage, { publicId: 2 }))?.series.title).toBe(
      "Alpha (dupe)",
    );

    // Observations, volume, and release denorms returned.
    const observation = await t.run((ctx) => ctx.db.get(fixture.observationId));
    expect(observation?.recordRef).toEqual({ type: "series", id: loser });
    const volume = await t.run((ctx) => ctx.db.get(fixture.loserBook.volumeId));
    expect(volume).toMatchObject({ seriesId: loser, position: 1 });
    const release = await t.run((ctx) => ctx.db.get(fixture.loserBook.releaseId));
    expect(release?.seriesIds).toEqual([loser]);

    // Tracking rows match the pre-merge world, including the deduped row
    // the merge deleted (reinserted with the same contents).
    const states = await t.run((ctx) => ctx.db.query("userSeriesStates").collect());
    const shape = (rows: typeof states) =>
      rows
        .map((s) => ({
          userId: s.userId,
          seriesId: s.seriesId,
          readingStatus: s.readingStatus,
          following: s.following,
        }))
        .sort((a, b) =>
          `${a.userId}${a.seriesId}`.localeCompare(`${b.userId}${b.seriesId}`),
        );
    expect(shape(states)).toEqual(shape(before.states));

    // Both relationship edges exist again with their original endpoints.
    const edges = await t.run((ctx) => ctx.db.query("seriesRelationships").collect());
    expect(edges).toHaveLength(2);
    expect(
      edges.some((e) => e.fromSeriesId === loser && e.toSeriesId === survivor),
    ).toBe(true);
    expect(
      edges.some((e) => e.fromSeriesId === loser && e.toSeriesId === bystander),
    ).toBe(true);
    void before.edges;

    // The manifest is consumed: a second split has nothing to reverse.
    await expect(
      asMod(t).mutation(api.sensitiveOps.splitRecord, {
        ref: { type: "series", id: loser },
        reason: "Again.",
        confirmImpact: true,
      }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
    const manifests = await t.run((ctx) => ctx.db.query("mergeManifests").collect());
    expect(manifests).toHaveLength(1);
    expect(manifests[0].reversedAt).toBeDefined();
  });

  it("leaves references alone that the world re-aimed after the merge", async () => {
    const t = makeT();
    await setup(t);
    const fixture = await seedMergeFixture(t);
    const { survivor, loser, bystander } = fixture;

    await asMod(t).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: survivor },
      loser: { type: "series", id: loser },
      reason: "Merge first.",
      confirmImpact: true,
    });
    // Someone re-links the observation to the bystander before the split.
    await t.run((ctx) =>
      ctx.db.patch(fixture.observationId, {
        recordRef: { type: "series", id: bystander },
      }),
    );
    await asMod(t).mutation(api.sensitiveOps.splitRecord, {
      ref: { type: "series", id: loser },
      reason: "Undo the merge.",
      confirmImpact: true,
    });
    const observation = await t.run((ctx) => ctx.db.get(fixture.observationId));
    expect(observation?.recordRef).toEqual({ type: "series", id: bystander });
  });
});

describe("sensitiveOps — the review-queue path", () => {
  it("approveProposal applies sensitive ops through the same engine", async () => {
    const t = makeT();
    await setup(t);
    const { survivor, loser } = await seedMergeFixture(t);
    const carolId = await userIdOf(t, "carol");

    // A merge proposal landed In Review (author: an Editor).
    const proposalId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("proposals", {
        author: { kind: "user", userId: carolId, roleAtAuthorship: "editor" },
        state: "inReview",
        currentVersionNo: 1,
        submittedAt: Date.now(),
      });
      await ctx.db.insert("proposalVersions", {
        proposalId: id,
        versionNo: 1,
        ops: [
          {
            kind: "merge",
            survivor: { type: "series", id: survivor },
            merged: { type: "series", id: loser },
            baseRevisionIds: [],
          },
        ],
        evidence: [],
        changeComment: "These are the same work.",
      });
      return id;
    });

    // The queue renders the op as a readable summary.
    const detail = await asMod(t).query(api.proposals.proposalDetail, { proposalId });
    const op = detail?.versions[0]?.ops[0];
    expect(op).toMatchObject({ kind: "merge" });
    expect((op as { summary?: string }).summary).toContain("Merge series");

    const result = await asMod(t).mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result).toMatchObject({ status: "approved" });

    const loserDoc = await t.run((ctx) => ctx.db.get(loser));
    expect(loserDoc).toMatchObject({ status: "merged", mergedIntoId: survivor });
    // The Revisions carry the Editor author and the Moderator approver.
    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    const merged = revisions.find((r) => r.ref.id === loser);
    expect(merged?.author).toMatchObject({ kind: "user", userId: carolId });
    expect(merged?.approvedBy).toBeDefined();
  });
});
