// Seeding orchestration, quality gates, and the launch checklist (ticket
// #40, spec §7): stage ordering under Bootstrap Mode, the two ~50-Series
// hand-verification samples with redraw rounds, the title-similarity
// duplicate sweep with durable resolutions, the correction-loop
// attestation, and the computed launch-ready checklist.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const ADMIN = "user_admin";
const MOD = "user_mod";
const PLAIN = "user_plain";

async function setup(t: ReturnType<typeof convexTest>) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: MOD })
    .mutation(api.users.claimUsername, { username: "bob" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  // Stage gating reads enabled flags off the registry, so seed it (idempotent).
  await t.mutation(internal.importSources.seedRegistry, {});
}

/** Insert one finished Import Run so a stage/source counts as succeeded. */
async function addRun(
  t: ReturnType<typeof convexTest>,
  sourceKey: string,
  status: "succeeded" | "failed" = "succeeded",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("importRuns", {
      sourceKey,
      status,
      finishedAt: Date.now(),
      recordsSeen: 1,
      recordsChanged: 1,
      errors: [],
    });
  });
}

/** A tiny active catalog: series with volumes/editions/releases per counts. */
async function seedCatalog(
  t: ReturnType<typeof convexTest>,
  seriesSpecs: Array<{ title: string; altTitles?: string[]; releases?: number }>,
) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    });
    const ids: Id<"series">[] = [];
    let publicId = 1;
    for (const spec of seriesSpecs) {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: publicId++,
        title: spec.title,
        altTitles: spec.altTitles ?? [],
        searchText: [spec.title, ...(spec.altTitles ?? [])].join(" "),
      });
      ids.push(seriesId);
      for (let i = 0; i < (spec.releases ?? 0); i++) {
        const editionId = await ctx.db.insert("editions", {
          status: "active",
          publicId: 100 * publicId + i,
          publisherId,
        });
        await ctx.db.insert("releases", {
          status: "active",
          editionId,
          format: "physical",
          language: "en",
          pubDate: { year: 2027, month: 1, day: 5 + i, sort: 20270105 + i },
          publisherId,
          seriesIds: [seriesId],
        });
      }
    }
    return ids;
  });
}

describe("seed stages (spec §7: four stages, in order, under Bootstrap Mode)", () => {
  it("refuses to start any stage with Bootstrap Mode off", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
    await expect(
      t.withIdentity({ subject: ADMIN }).mutation(api.launch.startSeedStage, { stage: 1 }),
    ).rejects.toThrow(/Bootstrap Mode/);
  });

  it("refuses out-of-order stage starts", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    await expect(
      t.withIdentity({ subject: ADMIN }).mutation(api.launch.startSeedStage, { stage: 2 }),
    ).rejects.toThrow(/in order/);
  });

  it("a disabled source does not hold its stage open", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    // Seven Seas disabled (e.g. its site blocks our egress): Kodansha's
    // success alone completes stage 1, and stage 2 may start.
    await t.mutation(internal.importSources.setEnabledInternal, {
      key: "sevenseas",
      enabled: false,
    });
    await addRun(t, "kodansha");
    const res = await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.launch.startSeedStage, { stage: 2 });
    expect(res.started).toEqual(["ann"]);
  });

  it("starts stage 1's two pilots, and stage 2 once stage 1 completed", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    const asAdmin = t.withIdentity({ subject: ADMIN });
    const result = await asAdmin.mutation(api.launch.startSeedStage, { stage: 1 });
    expect(result).toMatchObject({ started: ["sevenseas", "kodansha"] });

    // Simulate the pilots completing full runs.
    await addRun(t, "sevenseas");
    await addRun(t, "kodansha");
    const status = await asAdmin.query(api.launch.seedStatus, {});
    expect(status.stages[0]).toMatchObject({ complete: true });
    expect(status.stages[1]).toMatchObject({ complete: false });
    expect(status.orderedOk).toBe(true);

    const stage2 = await asAdmin.mutation(api.launch.startSeedStage, { stage: 2 });
    expect(stage2).toMatchObject({ started: ["ann"] });
  });

  it("a failed run does not complete a stage; ordering tracks first successes", async () => {
    const t = convexTest(schema);
    await setup(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await addRun(t, "sevenseas", "failed");
    let status = await asAdmin.query(api.launch.seedStatus, {});
    expect(status.stages[0]!.complete).toBe(false);

    // ANN succeeded before the pilots: out of order.
    await addRun(t, "ann");
    await addRun(t, "sevenseas");
    await addRun(t, "kodansha");
    status = await asAdmin.query(api.launch.seedStatus, {});
    expect(status.stages[0]!.complete).toBe(true);
    expect(status.stages[1]!.complete).toBe(true);
    expect(status.orderedOk).toBe(false);
  });

  it("only Administrators start stages", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.launch.startSeedStage, { stage: 1 }),
    ).rejects.toThrow();
  });
});

describe("QA samples (gates ①/②: hand-verification rounds)", () => {
  it("draws a random sample of every active Series when under the cap", async () => {
    const t = convexTest(schema);
    await setup(t);
    await seedCatalog(t, [
      { title: "Witch Hat Atelier" },
      { title: "Dungeon Meshi" },
      { title: "Berserk" },
    ]);
    const asMod = t.withIdentity({ subject: MOD });
    const result = await asMod.action(api.launch.drawQaSample, { kind: "random" });
    expect(result).toEqual({ round: 1, size: 3 });

    const qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.random).toMatchObject({ round: 1, total: 3, pending: 3, pass: false });
  });

  it("prominent = the Series with the most active Releases", async () => {
    const t = convexTest(schema);
    await setup(t);
    await seedCatalog(t, [
      { title: "Big", releases: 3 },
      { title: "Medium", releases: 1 },
      { title: "None" },
    ]);
    const asMod = t.withIdentity({ subject: MOD });
    const result = await asMod.action(api.launch.drawQaSample, { kind: "prominent" });
    expect(result).toEqual({ round: 1, size: 2 }); // release-less Series never ranks
    const qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.prominent.rows.map((r) => r.title).sort()).toEqual(["Big", "Medium"]);
  });

  it("verifying every row passes the gate; a failure needs a note and blocks it", async () => {
    const t = convexTest(schema);
    await setup(t);
    await seedCatalog(t, [{ title: "A" }, { title: "B" }]);
    const asMod = t.withIdentity({ subject: MOD });
    await asMod.action(api.launch.drawQaSample, { kind: "random" });
    let qa = await asMod.query(api.launch.qaStatus, {});
    const [first, second] = qa.random.rows;

    await expect(
      asMod.mutation(api.launch.recordQaCheck, {
        checkId: first!._id,
        status: "failed",
      }),
    ).rejects.toThrow(/Name the error/);

    await asMod.mutation(api.launch.recordQaCheck, {
      checkId: first!._id,
      status: "failed",
      note: "date off by one month",
    });
    await asMod.mutation(api.launch.recordQaCheck, {
      checkId: second!._id,
      status: "verified",
    });
    qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.random).toMatchObject({ verified: 1, failed: 1, pending: 0, pass: false });

    // Fix the class pipeline-wide, then redraw: a fresh round, gate re-runs.
    await asMod.action(api.launch.drawQaSample, { kind: "random" });
    qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.random).toMatchObject({ round: 2, pending: 2, failed: 0 });
    for (const row of qa.random.rows) {
      await asMod.mutation(api.launch.recordQaCheck, {
        checkId: row._id,
        status: "verified",
      });
    }
    qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.random.pass).toBe(true);
  });

  it("sampling is Moderator-gated", async () => {
    const t = convexTest(schema);
    await setup(t);
    await expect(
      t.withIdentity({ subject: PLAIN }).action(api.launch.drawQaSample, { kind: "random" }),
    ).rejects.toThrow();
  });
});

describe("duplicate sweep (gate ③)", () => {
  it("flags likely duplicates, and a 'distinct' resolution is durable across re-sweeps", async () => {
    const t = convexTest(schema);
    await setup(t);
    await seedCatalog(t, [
      { title: "Tokyo Ghoul" },
      { title: "Tokyo Ghoul (Manga)" },
      { title: "Dungeon Meshi", altTitles: ["Delicious in Dungeon"] },
      { title: "Delicious in Dungeon" },
      { title: "One Piece" },
    ]);
    const asMod = t.withIdentity({ subject: MOD });
    const sweep = await asMod.action(api.launch.runDuplicateSweep, {});
    expect(sweep).toMatchObject({ seriesScanned: 5, pairsFlagged: 2, newlyOpened: 2 });

    let queue = await asMod.query(api.launch.duplicateQueue, {});
    expect(queue.rows).toHaveLength(2);

    for (const row of queue.rows) {
      await asMod.mutation(api.launch.resolveDuplicate, {
        candidateId: row.candidateId,
        resolution: "distinct",
        note: "different series",
      });
    }
    queue = await asMod.query(api.launch.duplicateQueue, {});
    expect(queue.rows).toHaveLength(0);

    // Re-sweep: the resolved pairs never re-open.
    const again = await asMod.action(api.launch.runDuplicateSweep, {});
    expect(again).toMatchObject({ pairsFlagged: 2, newlyOpened: 0 });
    queue = await asMod.query(api.launch.duplicateQueue, {});
    expect(queue.rows).toHaveLength(0);
  });

  it("auto-closes an open pair once a member is merged away", async () => {
    const t = convexTest(schema);
    await setup(t);
    const [aId, bId] = await seedCatalog(t, [
      { title: "Berserk" },
      { title: "Berserk" },
    ]);
    const asMod = t.withIdentity({ subject: MOD });
    await asMod.action(api.launch.runDuplicateSweep, {});
    let qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.duplicates.openCount).toBe(1);

    // A Moderator merges the duplicates (#33); here: the status flip itself.
    await t.run(async (ctx) => {
      await ctx.db.patch(bId!, { status: "merged", mergedIntoId: aId });
    });
    await asMod.action(api.launch.runDuplicateSweep, {});
    qa = await asMod.query(api.launch.qaStatus, {});
    expect(qa.duplicates.openCount).toBe(0);
    expect(qa.duplicates.lastSweep).toMatchObject({ seriesScanned: 1 });
  });
});

describe("correction-loop attestation (launch gate ④)", () => {
  it("accepts an approved, human-authored proposal that produced a Revision", async () => {
    const t = convexTest(schema);
    await setup(t);
    const [seriesId] = await seedCatalog(t, [{ title: "Witch Hat Atelier" }]);
    const asMod = t.withIdentity({ subject: MOD });
    // The fix for a reported error: a direct edit (an immediately approved,
    // user-authored Proposal with one public Revision — ticket #31).
    const edit = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId! },
      changes: [{ field: "title", value: "Witch Hat Atelier (Atelier of Witch Hat)" }],
      comment: "Fix reported title",
    });
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.launch.attestCorrectionLoop, { proposalId: edit.proposalId });
    const checklist = await asMod.query(api.launch.launchChecklist, {});
    expect(checklist.gates.correctionLoopExercised).toBe(true);
    expect(checklist.detail.correctionLoop).toMatchObject({ proposalId: edit.proposalId });
  });

  it("rejects import-authored or unapproved proposals", async () => {
    const t = convexTest(schema);
    await setup(t);
    const importProposal = await t.run(async (ctx) =>
      ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "sevenseas" },
        state: "approved",
        currentVersionNo: 1,
      }),
    );
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await expect(
      asAdmin.mutation(api.launch.attestCorrectionLoop, { proposalId: importProposal }),
    ).rejects.toThrow(/human/);
  });
});

describe("launchChecklist (spec §7: gates, and only the gates)", () => {
  it("computes every gate and flips ready when all pass", async () => {
    const t = convexTest(schema);
    await setup(t);
    await t.mutation(internal.importSources.seedRegistry, {});
    const [seriesId] = await seedCatalog(t, [
      { title: "Witch Hat Atelier", releases: 2 },
    ]);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    const asMod = t.withIdentity({ subject: MOD });

    let checklist = await asMod.query(api.launch.launchChecklist, {});
    expect(checklist.ready).toBe(false);
    expect(checklist.gates).toMatchObject({
      seedStagesComplete: false,
      qualityGatesPass: false,
      bootstrapOff: true, // absent config = steady state
      calendarPopulated: true, // the seeded 2027 releases
      sourcesHealthy: false,
      correctionLoopExercised: false,
      aboutDataPage: true,
    });

    // ① all four stages, in order (each source's first success).
    for (const key of ["sevenseas", "kodansha", "ann", "prh", "openlibrary"]) {
      await addRun(t, key);
    }
    // ② both samples verified + sweep resolved.
    for (const kind of ["random", "prominent"] as const) {
      await asMod.action(api.launch.drawQaSample, { kind });
    }
    const qa = await asMod.query(api.launch.qaStatus, {});
    for (const row of [...qa.random.rows, ...qa.prominent.rows]) {
      await asMod.mutation(api.launch.recordQaCheck, {
        checkId: row._id,
        status: "verified",
      });
    }
    await asMod.action(api.launch.runDuplicateSweep, {});
    // ④ the correction loop, for real.
    const edit = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId! },
      changes: [{ field: "title", value: "Witch Hat Atelier — Fixed" }],
      comment: "Fix reported gap",
    });
    await asAdmin.mutation(api.launch.attestCorrectionLoop, {
      proposalId: edit.proposalId,
    });

    checklist = await asMod.query(api.launch.launchChecklist, {});
    expect(checklist.gates).toMatchObject({
      seedStagesComplete: true,
      qualityGatesPass: true,
      bootstrapOff: true,
      calendarPopulated: true,
      sourcesHealthy: true,
      correctionLoopExercised: true,
      aboutDataPage: true,
    });
    expect(checklist.ready).toBe(true);

    // Bootstrap Mode back on flips the gate (it must be off permanently).
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: true });
    checklist = await asMod.query(api.launch.launchChecklist, {});
    expect(checklist.gates.bootstrapOff).toBe(false);
    expect(checklist.ready).toBe(false);
  });

  it("is Data-Team-gated", async () => {
    const t = convexTest(schema);
    await setup(t);
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.launch.launchChecklist, {}),
    ).rejects.toThrow();
  });
});
