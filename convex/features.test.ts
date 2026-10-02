// The feature flags switched off (lib/features.ts): Comments refused and
// empty, Reviews private to their authors. comments.test.ts and
// reviews.test.ts mock both flags on and cover the features themselves; this
// file mocks them off, so it holds whatever the flags ship as.

import { describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import { insertSeries } from "./test.factories";
import { ADMIN, PLAIN as OTHER, alice, dave, makeT, seedTeam } from "./test.helpers";

vi.mock("./lib/features", () => ({ FEATURES: { publicReviews: false, comments: false } }));

// The Review and Comment author: no Data Team role, unlike the shared carol.
const AUTHOR = "user_author";
const TEXT = "A quiet, patient story about grief.\nThe art carries it.";
const target = { kind: "series" as const, publicId: 1 };

async function seed() {
  const t = makeT();
  await seedTeam(t, [alice, { subject: AUTHOR, username: "carol" }, dave]);
  const ids = await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Frieren" });
    const author = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("usernameNormalized", "carol"))
      .unique();
    // A Comment written while Comments were on.
    const commentId = await ctx.db.insert("comments", {
      userId: author!._id,
      seriesId,
      body: "Posted before the switch.",
      spoiler: false,
      status: "approved",
      reportCount: 0,
      replyCount: 0,
      createdAt: 0,
    });
    return { seriesId, commentId };
  });
  return { t, ...ids };
}

describe("Comments switched off", () => {
  it("refuses post, edit, and report with code disabled", async () => {
    const { t, seriesId, commentId } = await seed();
    const author = t.withIdentity({ subject: AUTHOR });
    const disabled = { data: { code: "disabled" } };
    await expect(
      author.mutation(api.comments.post, {
        target: { kind: "series", id: seriesId },
        body: "Hello",
        spoiler: false,
      }),
    ).rejects.toMatchObject(disabled);
    await expect(
      author.mutation(api.comments.edit, { commentId, body: "Edited", spoiler: false }),
    ).rejects.toMatchObject(disabled);
    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.comments.report, { commentId, reason: "spam" }),
    ).rejects.toMatchObject(disabled);
    // Signed out is refused the same way, before any auth check.
    await expect(
      t.mutation(api.comments.post, { target: { kind: "series", id: seriesId }, body: "Hi", spoiler: false }),
    ).rejects.toMatchObject(disabled);
  });

  it("answers list and replies with an empty page", async () => {
    const { t, seriesId, commentId } = await seed();
    expect(await t.query(api.comments.list, { target })).toEqual({
      target: { kind: "series", id: seriesId },
      items: [],
      hasMore: false,
    });
    expect(
      await t.withIdentity({ subject: AUTHOR }).query(api.comments.replies, { target, commentId }),
    ).toEqual([]);
    // Unknown targets are still null.
    expect(await t.query(api.comments.list, { target: { kind: "series", publicId: 999 } })).toBeNull();
  });
});

describe("Reviews private", () => {
  it("keeps writing open and shows the Review to its author only", async () => {
    const { t, seriesId } = await seed();
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.reviews.save, { target: { kind: "series", id: seriesId }, body: TEXT, spoiler: false });

    const mine = await author.query(api.reviews.mine, { target });
    expect(mine!.review).toMatchObject({ username: "carol", body: TEXT });

    expect(await t.query(api.reviews.list, { target })).toEqual({ items: [], hasMore: false });
    expect(await author.query(api.reviews.list, { target })).toEqual({ items: [], hasMore: false });
    // Moderators get no hidden list either.
    expect(await t.withIdentity({ subject: ADMIN }).query(api.reviews.hiddenList, { target })).toBeNull();

    // The profile leaves Reviews out even with everything public.
    await author.mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    const profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.reviews).toEqual([]);
  });
});
