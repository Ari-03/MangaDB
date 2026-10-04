// The per-Series report affordance (ticket #40, spec §7): any signed-in
// user's free-text report lands in the shared review queue as a zero-op
// In-Review Proposal, where a Moderator handles it like any other item.

import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { MAX_REPORT_LENGTH } from "./reports";
import { insertSeries } from "./test.factories";
import { MOD, PLAIN, alice, bob, dave, makeT, seedTeam, type TestT } from "./test.helpers";

/** alice, bob the Moderator and dave, and the Series "Witch Hat Atelier" (public id 7). */
async function setup(t: TestT) {
  await seedTeam(t, [alice, bob, dave]);
  return await t.run((ctx) => insertSeries(ctx, { publicId: 7, title: "Witch Hat Atelier" }));
}

describe("reports.submit", () => {
  it("puts a plain user's report into the review queue as a zero-op proposal", async () => {
    const t = makeT();
    await setup(t);
    const { proposalId } = await t.withIdentity({ subject: PLAIN }).mutation(api.reports.submit, {
      seriesPublicId: 7,
      message: "Volume 12 is missing.",
    });

    // The report feeds the SAME queue Moderators already work (spec §7).
    const queue = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueue, {});
    const row = queue.find((r) => r.proposalId === proposalId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ opCount: 0 });
    expect(row!.comment).toContain("[Report] Witch Hat Atelier");
    expect(row!.comment).toContain("Volume 12 is missing.");
    expect(row!.author).toMatchObject({ kind: "user", username: "dave" });

    // A Moderator can reject it with a reason once handled, like any item.
    await t.withIdentity({ subject: MOD }).mutation(api.proposals.rejectProposal, {
      proposalId,
      note: "Added the volume — thanks.",
    });
    const after = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueue, {});
    expect(after.find((r) => r.proposalId === proposalId)).toBeUndefined();
  });

  it("requires sign-in", async () => {
    const t = makeT();
    await setup(t);
    await expect(
      t.mutation(api.reports.submit, { seriesPublicId: 7, message: "hi" }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });

  it("rejects empty and over-long reports, and unknown series", async () => {
    const t = makeT();
    await setup(t);
    const asPlain = t.withIdentity({ subject: PLAIN });
    await expect(
      asPlain.mutation(api.reports.submit, { seriesPublicId: 7, message: "   " }),
    ).rejects.toThrow(/missing or wrong/);
    await expect(
      asPlain.mutation(api.reports.submit, {
        seriesPublicId: 7,
        message: "x".repeat(MAX_REPORT_LENGTH + 1),
      }),
    ).rejects.toThrow(/under/);
    await expect(
      asPlain.mutation(api.reports.submit, { seriesPublicId: 99, message: "hi" }),
    ).rejects.toThrow(/No such series/);
  });

  it("never reports on a hidden series", async () => {
    const t = makeT();
    const seriesId = await setup(t);
    await t.run((ctx) => ctx.db.patch(seriesId, { status: "hidden" }));
    await expect(
      t
        .withIdentity({ subject: PLAIN })
        .mutation(api.reports.submit, { seriesPublicId: 7, message: "hi" }),
    ).rejects.toThrow(/No such series/);
  });

  it("rate-limits scripted report spam", async () => {
    const t = makeT();
    await setup(t);
    const asPlain = t.withIdentity({ subject: PLAIN });
    // Burst capacity is 3; the 4th immediate report trips the bucket.
    for (let i = 0; i < 3; i++) {
      await asPlain.mutation(api.reports.submit, {
        seriesPublicId: 7,
        message: `report ${i}`,
      });
    }
    await expect(
      asPlain.mutation(api.reports.submit, { seriesPublicId: 7, message: "again" }),
    ).rejects.toMatchObject({ data: { kind: "RateLimited", name: "reportSubmit" } });
  });
});
