// The per-Series report affordance (ticket #40, spec §7): any signed-in
// user's free-text report lands in the shared review queue as a zero-op
// In-Review Proposal, where a Moderator handles it like any other item.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MAX_REPORT_LENGTH } from "./reports";

const ADMIN = "user_admin";
const MOD = "user_mod";
const PLAIN = "user_plain";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

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
  return await t.run((ctx) =>
    ctx.db.insert("series", {
      status: "active",
      publicId: 7,
      title: "Witch Hat Atelier",
      altTitles: [],
      searchText: "Witch Hat Atelier",
    }),
  );
}

describe("reports.submit", () => {
  it("puts a plain user's report into the review queue as a zero-op proposal", async () => {
    const t = makeT();
    await setup(t);
    const { proposalId } = await t
      .withIdentity({ subject: PLAIN })
      .mutation(api.reports.submit, {
        seriesPublicId: 7,
        message: "Volume 12 is missing.",
      });

    // The report feeds the SAME queue Moderators already work (spec §7).
    const queue = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.reviewQueue, {});
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
    const after = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.reviewQueue, {});
    expect(after.find((r) => r.proposalId === proposalId)).toBeUndefined();
  });

  it("requires sign-in", async () => {
    const t = makeT();
    await setup(t);
    await expect(
      t.mutation(api.reports.submit, { seriesPublicId: 7, message: "hi" }),
    ).rejects.toThrow();
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
    ).rejects.toThrow();
  });
});
