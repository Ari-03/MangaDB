// Comments (CONTEXT.md: Comment, Comment Report, Shadowed User): hold rules
// on posting, one reply level, author edit/delete, reports and auto-hide,
// Moderator actions with their audit trail, who sees what (shadowing,
// placeholders, the reply cap), the queue, rate limits, and upkeep through
// purge, merge, and split.

import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { COMMENT_POLICY } from "./lib/commentPolicy";
import type { PageTargetRef } from "./lib/ratings";
import { insertEdition, insertPublisher, insertVolume } from "./test.factories";
import {
  ADMIN,
  EDITOR,
  MOD,
  alice,
  bob,
  makeT,
  purgeAccount,
  seedTeam,
  signedIn,
  type TestT,
} from "./test.helpers";
import { merge, series, seriesWithVolume, split, volume } from "./test.tracking";

// These tests cover Comments switched on; features.test.ts covers them off.
vi.mock("./lib/features", () => ({ FEATURES: { publicReviews: true, comments: true } }));

const AUTHOR = "user_author";
const OTHER = "user_other";
const R1 = "user_r1";
const R2 = "user_r2";
const R3 = "user_r3";

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock past the new-account hold, so only the other rules apply. */
function ageAccounts() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + COMMENT_POLICY.minAccountAgeMs + 60_000);
}

/**
 * Administrator alice, Moderator bob, Editor erin, and five ordinary users
 * (carol the author, dave, rae, rob, ria); Series 1 "Frieren", its duplicate
 * Series 2, and Series 9 "Elsewhere", each with Volumes 1 and 2 (publicIds
 * N1 and N2).
 */
async function seed(t: TestT) {
  await seedTeam(t, [
    alice,
    bob,
    { subject: EDITOR, username: "erin", role: "editor" },
    { subject: AUTHOR, username: "carol" },
    { subject: OTHER, username: "dave" },
    { subject: R1, username: "rae" },
    { subject: R2, username: "rob" },
    { subject: R3, username: "ria" },
  ]);
  return await t.run(async (ctx) => {
    const mk = async (publicId: number, title: string) => {
      const { seriesId, volumeId } = await seriesWithVolume(ctx, publicId, title);
      const volume2Id = await insertVolume(ctx, {
        seriesId,
        publicId: publicId * 10 + 2,
        position: 2,
      });
      return { seriesId, volumeId, volume2Id };
    };
    return {
      one: await mk(1, "Frieren"),
      two: await mk(2, "Frieren (duplicate)"),
      elsewhere: await mk(9, "Elsewhere"),
    };
  });
}
type Ids = Awaited<ReturnType<typeof seed>>;

/** Give a user three approved Comments on another Series, lifting the approved-count hold. */
async function trust(t: TestT, ids: Ids, subject: string) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", subject))
      .unique();
    for (let i = 0; i < COMMENT_POLICY.minApprovedComments; i++) {
      await ctx.db.insert("comments", {
        userId: user!._id,
        seriesId: ids.elsewhere.seriesId,
        body: `Earlier comment ${i}`,
        spoiler: false,
        status: "approved",
        reportCount: 0,
        createdAt: i,
      });
    }
  });
}

/** Seed, age the accounts, and trust the ordinary users: every post publishes. */
async function trustedSetup(t: TestT) {
  const ids = await seed(t);
  ageAccounts();
  for (const subject of [AUTHOR, OTHER, R1, R2, R3]) await trust(t, ids, subject);
  return ids;
}

function post(
  t: TestT,
  subject: string,
  ids: Ids,
  body = "Loved the pacing of this arc.",
  extra: { parentId?: Id<"comments">; spoiler?: boolean; onVolume?: boolean } = {},
) {
  return t.withIdentity({ subject }).mutation(api.comments.post, {
    target: extra.onVolume
      ? { kind: "volume", id: ids.one.volumeId }
      : { kind: "series", id: ids.one.seriesId },
    body,
    spoiler: extra.spoiler ?? false,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
}

const listAs = (t: TestT, subject: string | null, target: PageTargetRef = series(1)) =>
  subject === null
    ? t.query(api.comments.list, { target })
    : t.withIdentity({ subject }).query(api.comments.list, { target });

/** bob's decision on one Comment. */
const moderate = (
  t: TestT,
  commentId: Id<"comments">,
  action: FunctionArgs<typeof api.comments.moderate>["action"],
) => signedIn(t, bob).mutation(api.comments.moderate, { commentId, action });

const statusOf = (t: TestT, commentId: Id<"comments">) =>
  t.run(async (ctx) => (await ctx.db.get(commentId))?.status);
const auditActions = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("commentAudit").collect()).map((row) => row.action));

describe("comments.post: hold rules", () => {
  it("holds a new account's Comment for review", async () => {
    const t = makeT();
    const ids = await seed(t);
    await trust(t, ids, AUTHOR);
    const result = await post(t, AUTHOR, ids);
    expect(result.held).toBe(true);
    expect(await statusOf(t, result.commentId)).toBe("pending");
  });

  it("holds an old account with fewer than three approved Comments", async () => {
    const t = makeT();
    const ids = await seed(t);
    ageAccounts();
    expect((await post(t, AUTHOR, ids)).held).toBe(true);
    await trust(t, ids, AUTHOR);
    expect((await post(t, AUTHOR, ids)).held).toBe(false);
  });

  it("holds a body with more than two links", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    expect((await post(t, AUTHOR, ids, "See https://a.example and http://b.example")).held).toBe(
      false,
    );
    const spam = await post(
      t,
      AUTHOR,
      ids,
      "https://a.example https://b.example HTTPS://c.example",
    );
    expect(spam.held).toBe(true);
    expect(await statusOf(t, spam.commentId)).toBe("pending");
  });

  it("never holds the Data Team", async () => {
    const t = makeT();
    const ids = await seed(t);
    expect((await post(t, MOD, ids)).held).toBe(false);
    expect((await post(t, EDITOR, ids, "https://a https://b https://c")).held).toBe(false);
  });

  it("holds the body to 1-2,000 characters, trimmed", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await expect(post(t, AUTHOR, ids, "   \n  ")).rejects.toMatchObject({
      data: { code: "commentEmpty" },
    });
    await expect(
      post(t, AUTHOR, ids, "x".repeat(COMMENT_POLICY.maxLength + 1)),
    ).rejects.toMatchObject({
      data: { code: "commentTooLong" },
    });
    await post(t, AUTHOR, ids, "x".repeat(COMMENT_POLICY.maxLength));
    await post(t, AUTHOR, ids, "  ok\r\nfine  ");
    const page = await listAs(t, null);
    expect(page!.items[0]!.body).toBe("ok\nfine");
  });

  it("requires a claimed, unsuspended account", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(post(t, "user_nobody", ids)).rejects.toMatchObject({
      data: { code: "usernameRequired" },
    });
    await expect(
      t.mutation(api.comments.post, {
        target: { kind: "series", id: ids.one.seriesId },
        body: "hi",
        spoiler: false,
      }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });
});

describe("replies", () => {
  it("allows one level only, on the same page, under an open Comment", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const top = await post(t, AUTHOR, ids);
    const reply = await post(t, OTHER, ids, "Agreed.", { parentId: top.commentId });
    await expect(
      post(t, AUTHOR, ids, "Deeper.", { parentId: reply.commentId }),
    ).rejects.toMatchObject({
      data: { code: "replyDepth" },
    });
    await expect(
      post(t, OTHER, ids, "Wrong page.", { parentId: top.commentId, onVolume: true }),
    ).rejects.toMatchObject({
      data: { code: "wrongTarget" },
    });
    await moderate(t, top.commentId, "hide");
    await expect(
      post(t, OTHER, ids, "Too late.", { parentId: top.commentId }),
    ).rejects.toMatchObject({
      data: { code: "closed" },
    });
  });

  it("nests replies oldest first under their thread, threads newest first", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const first = await post(t, AUTHOR, ids, "First thread");
    await post(t, OTHER, ids, "Second thread");
    await post(t, OTHER, ids, "Reply one", { parentId: first.commentId });
    await post(t, R1, ids, "Reply two", { parentId: first.commentId });
    const page = await listAs(t, null);
    expect(page!.items.map((item) => item.body)).toEqual(["Second thread", "First thread"]);
    expect(page!.items[1]!.replies.map((item) => item.body)).toEqual(["Reply one", "Reply two"]);
    expect(page!.target).toEqual({ kind: "series", id: ids.one.seriesId });
  });

  it("keeps Series and Volume pages apart", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await post(t, AUTHOR, ids, "On the series");
    await post(t, AUTHOR, ids, "On volume 1", { onVolume: true });
    expect((await listAs(t, null))!.items.map((i) => i.body)).toEqual(["On the series"]);
    expect((await listAs(t, null, volume(11)))!.items.map((i) => i.body)).toEqual(["On volume 1"]);
    expect(await listAs(t, null, volume(999))).toBeNull();
  });

  it("pages top-level threads", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      for (let i = 0; i < COMMENT_POLICY.page + 3; i++) {
        await ctx.db.insert("comments", {
          userId,
          seriesId: ids.one.seriesId,
          body: `Comment ${i}`,
          spoiler: false,
          status: "approved",
          reportCount: 0,
          createdAt: i,
        });
      }
    });
    const first = await listAs(t, null);
    expect(first!.items).toHaveLength(COMMENT_POLICY.page);
    expect(first!.hasMore).toBe(true);
    expect(first!.items[0]!.body).toBe(`Comment ${COMMENT_POLICY.page + 2}`);
    const all = await t.query(api.comments.list, { target: series(1), limit: 40 });
    expect(all!.items).toHaveLength(COMMENT_POLICY.page + 3);
    expect(all!.hasMore).toBe(false);
  });
});

describe("author edit and delete", () => {
  it("lets only the author edit, marks it edited, and re-holds a link-stuffed edit", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    await expect(
      t
        .withIdentity({ subject: OTHER })
        .mutation(api.comments.edit, { commentId, body: "mine now", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t
        .withIdentity({ subject: MOD })
        .mutation(api.comments.edit, { commentId, body: "mod edit", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.comments.edit, { commentId, body: "Fixed a typo.", spoiler: true });
    expect((await listAs(t, null))!.items[0]).toMatchObject({
      body: "Fixed a typo.",
      spoiler: true,
      edited: true,
    });

    const result = await author.mutation(api.comments.edit, {
      commentId,
      body: "https://a https://b https://c",
      spoiler: false,
    });
    expect(result.held).toBe(true);
    expect(await statusOf(t, commentId)).toBe("pending");
  });

  it("deletes to removed, audited, and refuses edits afterwards", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.comments.remove, { commentId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await t.withIdentity({ subject: AUTHOR }).mutation(api.comments.remove, { commentId });
    expect(await statusOf(t, commentId)).toBe("removed");
    expect((await listAs(t, AUTHOR))!.items).toEqual([]);
    await expect(
      t
        .withIdentity({ subject: AUTHOR })
        .mutation(api.comments.edit, { commentId, body: "back", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
    expect(await auditActions(t)).toEqual(["remove"]);
    // A Moderator cannot restore what its author deleted.
    await expect(moderate(t, commentId, "restore")).rejects.toMatchObject({
      data: { code: "authorDeleted" },
    });
  });
});

describe("reports", () => {
  it("takes one report per user, never the author's own, and hides at three", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    const reportAs = (subject: string, note?: string) =>
      t
        .withIdentity({ subject })
        .mutation(api.comments.report, { commentId, reason: "spam", ...(note ? { note } : {}) });

    await expect(reportAs(AUTHOR)).rejects.toMatchObject({ data: { code: "ownComment" } });
    await expect(reportAs(R1, "x".repeat(COMMENT_POLICY.noteMaxLength + 1))).rejects.toMatchObject({
      data: { code: "noteTooLong" },
    });
    expect(await reportAs(R1, " selling pills ")).toEqual({ hidden: false });
    await expect(reportAs(R1)).rejects.toMatchObject({ data: { code: "alreadyReported" } });
    expect(await reportAs(R2)).toEqual({ hidden: false });
    expect(await statusOf(t, commentId)).toBe("approved");
    expect(await reportAs(R3)).toEqual({ hidden: true });
    expect(await statusOf(t, commentId)).toBe("hidden");

    const audit = await t.run((ctx) => ctx.db.query("commentAudit").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ commentId, action: "hide", actor: { kind: "system" } });
    const reports = await t.run((ctx) => ctx.db.query("commentReports").collect());
    expect(reports.map((row) => row.note)).toContain("selling pills");
    // A hidden Comment takes no more reports.
    await expect(reportAs(OTHER)).rejects.toMatchObject({ data: { code: "notFound" } });
  });

  it("is rate limited per user", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const targets = [];
    for (const subject of [MOD, ADMIN, EDITOR, AUTHOR, OTHER, R2]) {
      targets.push((await post(t, subject, ids, `Comment by ${subject}`)).commentId);
    }
    let limited = false;
    for (const commentId of targets) {
      try {
        await t
          .withIdentity({ subject: R1 })
          .mutation(api.comments.report, { commentId, reason: "other" });
      } catch (err) {
        expect(err).toMatchObject({ data: { kind: "RateLimited" } });
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("posting rate limit", () => {
  it("allows a burst of five, then refuses", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    for (let i = 0; i < 5; i++) await post(t, AUTHOR, ids, `Take ${i}`);
    await expect(post(t, AUTHOR, ids, "One too many")).rejects.toMatchObject({
      data: { kind: "RateLimited" },
    });
  });
});

describe("moderation", () => {
  it("is Moderator-only and audits every decision", async () => {
    const t = makeT();
    const ids = await seed(t);
    const { commentId } = await post(t, AUTHOR, ids); // new account: pending
    const act = (
      subject: string,
      action: "approve" | "hide" | "unhide" | "remove" | "restore",
      reason?: string,
    ) =>
      t
        .withIdentity({ subject })
        .mutation(api.comments.moderate, { commentId, action, ...(reason ? { reason } : {}) });

    await expect(act(OTHER, "approve")).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(act(EDITOR, "approve")).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(act(MOD, "unhide")).rejects.toMatchObject({ data: { code: "badState" } });

    await act(MOD, "approve");
    expect(await statusOf(t, commentId)).toBe("approved");
    await act(MOD, "hide", " Off-topic ");
    expect(await statusOf(t, commentId)).toBe("hidden");
    await act(ADMIN, "unhide");
    await act(MOD, "remove", "Harassment");
    expect(await statusOf(t, commentId)).toBe("removed");
    await act(MOD, "restore");
    expect(await statusOf(t, commentId)).toBe("approved");

    const audit = await t.run((ctx) => ctx.db.query("commentAudit").collect());
    expect(audit.map((row) => row.action)).toEqual([
      "approve",
      "hide",
      "unhide",
      "remove",
      "restore",
    ]);
    expect(audit[1]).toMatchObject({ reason: "Off-topic", actor: { kind: "user" } });
  });

  it("approving a reported Comment dismisses its reports", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    for (const subject of [R1, R2]) {
      await t
        .withIdentity({ subject })
        .mutation(api.comments.report, { commentId, reason: "spoiler" });
    }
    await moderate(t, commentId, "approve");
    const row = await t.run((ctx) => ctx.db.get(commentId));
    expect(row).toMatchObject({ status: "approved", reportCount: 0 });
    expect(await t.run((ctx) => ctx.db.query("commentReports").collect())).toEqual([]);
  });

  it("shadows and unshadows the author, audited against the Comment", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    const shadow = (subject: string, shadowed: boolean) =>
      t.withIdentity({ subject }).mutation(api.comments.setShadowed, { commentId, shadowed });
    await expect(shadow(EDITOR, true)).rejects.toMatchObject({ data: { code: "forbidden" } });
    await shadow(MOD, true);
    await shadow(MOD, true); // no-op
    await shadow(MOD, false);
    const audit = await t.run((ctx) => ctx.db.query("commentAudit").collect());
    expect(audit.map((row) => row.action)).toEqual(["shadow", "unshadow"]);
    expect(audit[0]!.userId).toBeDefined();
    // Data Team members can't be shadowed.
    const modComment = await post(t, MOD, ids);
    await expect(
      t.withIdentity({ subject: ADMIN }).mutation(api.comments.setShadowed, {
        commentId: modComment.commentId,
        shadowed: true,
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("visibility", () => {
  it("shows each status to the right viewers", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const mod = t.withIdentity({ subject: MOD });

    await post(t, AUTHOR, ids, "Approved");
    await post(t, AUTHOR, ids, "Pending https://a https://b https://c");
    const hidden = await post(t, AUTHOR, ids, "Hidden");
    await moderate(t, hidden.commentId, "hide");
    const lonely = await post(t, AUTHOR, ids, "Removed, no replies");
    await moderate(t, lonely.commentId, "remove");
    const threaded = await post(t, OTHER, ids, "Removed, with a reply");
    await post(t, R1, ids, "A reply that keeps the thread", { parentId: threaded.commentId });
    await moderate(t, threaded.commentId, "remove");
    const shadowed = await post(t, R2, ids, "From a shadowed user");
    await mod.mutation(api.comments.setShadowed, { commentId: shadowed.commentId, shadowed: true });
    // Posted after shadowing: still visible to its author only.
    await post(t, R2, ids, "Shadowed again");

    const view = async (subject: string | null) =>
      (await listAs(t, subject))!.items.map((item) => [item.state, item.body, item.own]);

    // Anonymous, another user, and a Moderator (who uses the queue) see the same page.
    const publicView = [
      ["removed", "", false],
      ["approved", "Approved", false],
    ];
    expect(await view(null)).toEqual(publicView);
    expect(await view(OTHER)).toEqual(publicView);
    expect(await view(MOD)).toEqual(publicView);

    // The author also sees their held and hidden Comments, the hidden one without its body.
    expect(await view(AUTHOR)).toEqual([
      ["removed", "", false],
      ["hidden", "", true],
      ["pending", "Pending https://a https://b https://c", true],
      ["approved", "Approved", true],
    ]);

    // The shadowed user sees their own Comments as published.
    expect(await view(R2)).toEqual([
      ["approved", "Shadowed again", true],
      ["approved", "From a shadowed user", true],
      ["removed", "", false],
      ["approved", "Approved", false],
    ]);

    // The removed thread's placeholder keeps its reply, and no author.
    const placeholder = (await listAs(t, null))!.items[0]!;
    expect(placeholder).toMatchObject({
      username: null,
      replies: [{ body: "A reply that keeps the thread" }],
    });
  });
});

describe("the queue", () => {
  it("lists pending, reported, hidden and removed for the Data Team only", async () => {
    const t = makeT();
    const ids = await seed(t);
    const held = await post(t, AUTHOR, ids, "Held for review", { onVolume: true });
    await trust(t, ids, OTHER);
    ageAccounts();
    for (const subject of [R1, R2, R3]) await trust(t, ids, subject);
    const once = await post(t, OTHER, ids, "Reported once");
    const twice = await post(t, OTHER, ids, "Reported twice");
    await t.withIdentity({ subject: R1 }).mutation(api.comments.report, {
      commentId: once.commentId,
      reason: "offTopic",
      note: "not about the manga",
    });
    for (const subject of [R1, R2]) {
      await t
        .withIdentity({ subject })
        .mutation(api.comments.report, { commentId: twice.commentId, reason: "spam" });
    }

    await expect(
      t.withIdentity({ subject: OTHER }).query(api.comments.queue, { tab: "pending" }),
    ).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect(await t.withIdentity({ subject: OTHER }).query(api.comments.queueCounts, {})).toBeNull();
    expect(await t.query(api.comments.queueCounts, {})).toBeNull();

    const editor = t.withIdentity({ subject: EDITOR });
    const pending = await editor.query(api.comments.queue, { tab: "pending" });
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({
      commentId: held.commentId,
      username: "carol",
      status: "pending",
      target: { kind: "volume", publicId: 11, title: "Frieren Vol 1" },
    });

    const reported = await editor.query(api.comments.queue, { tab: "reported" });
    expect(reported.rows.map((row) => [row.body, row.reportCount])).toEqual([
      ["Reported twice", 2],
      ["Reported once", 1],
    ]);
    expect(reported.rows[0]!.reasons).toEqual({ spam: 2 });
    expect(reported.rows[1]!.notes).toEqual([{ reason: "offTopic", note: "not about the manga" }]);

    expect(await editor.query(api.comments.queueCounts, {})).toEqual({
      pending: 1,
      reported: 2,
      hidden: 0,
    });
    await t
      .withIdentity({ subject: R3 })
      .mutation(api.comments.report, { commentId: twice.commentId, reason: "spam" });
    expect(await editor.query(api.comments.queueCounts, {})).toEqual({
      pending: 1,
      reported: 1,
      hidden: 1,
    });
    expect((await editor.query(api.comments.queue, { tab: "hidden" })).rows[0]!.body).toBe(
      "Reported twice",
    );

    await moderate(t, once.commentId, "remove");
    expect(
      (await editor.query(api.comments.queue, { tab: "removed" })).rows.map((row) => row.body),
    ).toEqual(["Reported once"]);
  });
});

describe("upkeep", () => {
  it("purging a user deletes their Comments and reports, and orphans replies to top level", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const theirs = await post(t, AUTHOR, ids, "Leaving soon");
    await post(t, OTHER, ids, "Reply that stays", { parentId: theirs.commentId });
    const other = await post(t, OTHER, ids, "Reported by the leaver");
    await t
      .withIdentity({ subject: AUTHOR })
      .mutation(api.comments.report, { commentId: other.commentId, reason: "spam" });
    await t
      .withIdentity({ subject: R1 })
      .mutation(api.comments.report, { commentId: theirs.commentId, reason: "spam" });

    await purgeAccount(t, AUTHOR);

    const rows = await t.run((ctx) => ctx.db.query("comments").collect());
    const leaverId = theirs.commentId;
    expect(rows.find((row) => row._id === leaverId)).toBeUndefined();
    // Only the leaver's own seeded history went with them.
    expect(rows.filter((row) => row.body.startsWith("Earlier"))).toHaveLength(
      4 * COMMENT_POLICY.minApprovedComments,
    );
    expect(rows.find((row) => row.body === "Reply that stays")!.parentId).toBeUndefined();
    expect(rows.find((row) => row.body === "Reported by the leaver")!.reportCount).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("commentReports").collect())).toEqual([]);
    expect((await listAs(t, null))!.items.map((item) => item.body)).toEqual([
      "Reported by the leaver",
      "Reply that stays",
    ]);
  });

  it("a Series merge moves its Comments, Volume Comments included", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await post(t, AUTHOR, ids, "On the survivor");
    const onLoser = (
      body: string,
      target: { kind: "series"; id: Id<"series"> } | { kind: "volume"; id: Id<"volumes"> },
    ) =>
      t
        .withIdentity({ subject: OTHER })
        .mutation(api.comments.post, { target, body, spoiler: false });
    await onLoser("On the loser", { kind: "series", id: ids.two.seriesId });
    const volumeComment = await onLoser("On the loser's volume", {
      kind: "volume",
      id: ids.two.volumeId,
    });

    await merge(
      signedIn(t, bob),
      { type: "series", id: ids.one.seriesId },
      { type: "series", id: ids.two.seriesId },
    );
    expect((await listAs(t, null))!.items.map((item) => item.body)).toEqual([
      "On the loser",
      "On the survivor",
    ]);
    const moved = await t.run((ctx) => ctx.db.get(volumeComment.commentId));
    expect(moved).toMatchObject({ seriesId: ids.one.seriesId, volumeId: ids.two.volumeId });
    // The old URL's page resolves to the survivor's comments too.
    expect((await listAs(t, null, series(2)))!.items).toHaveLength(2);
  });

  it("a Volume merge moves its Comments", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await t.withIdentity({ subject: OTHER }).mutation(api.comments.post, {
      target: { kind: "volume", id: ids.one.volume2Id },
      body: "On volume 2",
      spoiler: false,
    });
    await merge(
      signedIn(t, bob),
      { type: "volume", id: ids.one.volumeId },
      { type: "volume", id: ids.one.volume2Id },
    );
    expect((await listAs(t, null, volume(11)))!.items.map((item) => item.body)).toEqual([
      "On volume 2",
    ]);
  });
});

/** A user's ID by Clerk subject. */
const userIdOf = (t: TestT, subject: string) =>
  t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", subject))
      .unique();
    return user!._id;
  });

/** Insert `count` top-level Comments by `subject` on Series 1, oldest first. */
async function insertHeads(
  t: TestT,
  ids: Ids,
  subject: string,
  count: number,
  status: "approved" | "removed" | "pending",
) {
  const userId = await userIdOf(t, subject);
  return await t.run(async (ctx) => {
    const made = [];
    for (let i = 0; i < count; i++) {
      made.push(
        await ctx.db.insert("comments", {
          userId,
          seriesId: ids.one.seriesId,
          body: `${status} ${subject} ${i}`,
          spoiler: false,
          status,
          reportCount: 0,
          replyCount: 0,
          createdAt: i,
        }),
      );
    }
    return made;
  });
}

const suspend = async (t: TestT, subject: string) => {
  const userId = await userIdOf(t, subject);
  await t.run((ctx) => ctx.db.patch(userId, { suspended: true }));
};

describe("shadowing as a status", () => {
  it("a shadowed spammer's rows never crowd out older Comments, and unshadowing restores them", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await post(t, OTHER, ids, "An honest, older comment");
    const spam = await insertHeads(t, ids, R2, 25, "approved");
    const before = await listAs(t, null);
    expect(before!.items).toHaveLength(COMMENT_POLICY.page);
    expect(before!.hasMore).toBe(true);

    await t
      .withIdentity({ subject: MOD })
      .mutation(api.comments.setShadowed, { commentId: spam[0]!, shadowed: true });
    expect(await statusOf(t, spam[0]!)).toBe("shadowed");
    const after = await listAs(t, null);
    expect(after!.items.map((item) => item.body)).toEqual(["An honest, older comment"]);
    expect(after!.hasMore).toBe(false);

    // The shadowed author still sees their own Comments as published.
    const theirs = await listAs(t, R2);
    expect(theirs!.items).toHaveLength(COMMENT_POLICY.page);
    expect(theirs!.items.every((item) => item.state === "approved" && item.own)).toBe(true);
    expect(theirs!.hasMore).toBe(true);
    // A new post while shadowed is stored shadowed and reported as published.
    const fresh = await post(t, R2, ids, "Posted while shadowed");
    expect(fresh.held).toBe(false);
    expect(await statusOf(t, fresh.commentId)).toBe("shadowed");

    await t
      .withIdentity({ subject: MOD })
      .mutation(api.comments.setShadowed, { commentId: spam[0]!, shadowed: false });
    expect(await statusOf(t, spam[0]!)).toBe("approved");
    expect(await statusOf(t, fresh.commentId)).toBe("approved");
    const restored = await listAs(t, null);
    expect(restored!.items[0]!.body).toBe("Posted while shadowed");
    expect(restored!.hasMore).toBe(true);
  });

  it("a Moderator's approve of a shadowed author's Comment keeps it shadowed", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const held = await post(t, R2, ids, "https://a https://b https://c");
    await t
      .withIdentity({ subject: MOD })
      .mutation(api.comments.setShadowed, { commentId: held.commentId, shadowed: true });
    expect(await statusOf(t, held.commentId)).toBe("pending");
    await moderate(t, held.commentId, "approve");
    expect(await statusOf(t, held.commentId)).toBe("shadowed");
  });

  it("keeps a Shadowed User's Comments hidden while their account deletion waits for the purge", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const held = await post(t, R2, ids, "https://a https://b https://c");
    const shown = await post(t, R2, ids, "Published before the shadowing");
    await t
      .withIdentity({ subject: MOD })
      .mutation(api.comments.setShadowed, { commentId: shown.commentId, shadowed: true });
    // An approved row past setShadowed's cap: only the author's flag hides it.
    await t.run((ctx) => ctx.db.patch(shown.commentId, { status: "approved" }));
    expect((await listAs(t, null))!.items).toEqual([]);

    // Deletion requested, the purge not yet run.
    const authorId = await userIdOf(t, R2);
    await t.run((ctx) => ctx.db.patch(authorId, { deletingSince: Date.now() }));

    for (const subject of [null, R1]) expect((await listAs(t, subject))!.items).toEqual([]);
    await moderate(t, held.commentId, "approve");
    expect(await statusOf(t, held.commentId)).toBe("shadowed");
    // The queue still flags the author as shadowed, and names nobody.
    await t.run((ctx) => ctx.db.patch(shown.commentId, { reportCount: 1 }));
    expect(
      (await signedIn(t, bob).query(api.comments.queue, { tab: "reported" })).rows,
    ).toMatchObject([{ commentId: shown.commentId, username: null, authorShadowed: true }]);
  });
});

describe("placeholders", () => {
  it("a removed head older than a page of removed heads keeps its placeholder", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const head = await post(t, OTHER, ids, "Old thread");
    await post(t, R1, ids, "Its reply", { parentId: head.commentId });
    await moderate(t, head.commentId, "remove");
    await insertHeads(t, ids, R2, COMMENT_POLICY.page + 1, "removed");
    const page = await listAs(t, null);
    expect(page!.items).toHaveLength(1);
    expect(page!.items[0]).toMatchObject({
      commentId: head.commentId,
      state: "removed",
      username: null,
      createdAt: 0,
      edited: false,
      replies: [{ body: "Its reply" }],
    });
    expect(page!.hasMore).toBe(false);
  });

  it("a hidden head with replies stays as a [hidden] placeholder for everyone but its author", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const head = await post(t, OTHER, ids, "Soon hidden");
    await t.withIdentity({ subject: OTHER }).mutation(api.comments.edit, {
      commentId: head.commentId,
      body: "Soon hidden, edited",
      spoiler: false,
    });
    await post(t, R1, ids, "A reply that keeps it", { parentId: head.commentId });
    await moderate(t, head.commentId, "hide");

    for (const subject of [null, R1]) {
      const [item] = (await listAs(t, subject))!.items;
      expect(item).toMatchObject({
        state: "withheld",
        body: "",
        username: null,
        own: false,
        createdAt: 0,
        edited: false,
      });
      expect(item!.replies.map((reply) => reply.body)).toEqual(["A reply that keeps it"]);
    }
    expect((await listAs(t, OTHER))!.items[0]).toMatchObject({ state: "hidden", own: true });
  });

  it("a re-held head keeps the replies it gathered while published", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const head = await post(t, OTHER, ids, "Published, then re-held");
    await post(t, R1, ids, "Reply while it was up", { parentId: head.commentId });
    const result = await t.withIdentity({ subject: OTHER }).mutation(api.comments.edit, {
      commentId: head.commentId,
      body: "https://a https://b https://c",
      spoiler: false,
    });
    expect(result.held).toBe(true);

    for (const subject of [null, R1]) {
      const [item] = (await listAs(t, subject))!.items;
      expect(item).toMatchObject({ state: "withheld", body: "", username: null });
      expect(item!.replies.map((reply) => reply.body)).toEqual(["Reply while it was up"]);
    }
    expect((await listAs(t, OTHER))!.items[0]).toMatchObject({ state: "pending", own: true });
  });
});

describe("reply cap", () => {
  it("shows the first replies inline, counts the rest, and loads them on demand", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const head = await post(t, AUTHOR, ids, "Busy thread");
    const repliers = [OTHER, R1, R2, R3, MOD, ADMIN, EDITOR];
    const made = [];
    for (const subject of repliers) {
      made.push(
        (await post(t, subject, ids, `Reply by ${subject}`, { parentId: head.commentId }))
          .commentId,
      );
    }
    // The author's own held reply shows inline even past the cap.
    await post(t, AUTHOR, ids, "Own held reply https://a https://b https://c", {
      parentId: head.commentId,
    });
    expect((await t.run((ctx) => ctx.db.get(head.commentId)))!.replyCount).toBe(repliers.length);

    const anon = (await listAs(t, null))!.items[0]!;
    expect(anon.replies).toHaveLength(COMMENT_POLICY.inlineReplies);
    expect(anon.moreReplies).toBe(repliers.length - COMMENT_POLICY.inlineReplies);
    const mine = (await listAs(t, AUTHOR))!.items[0]!;
    expect(mine.replies.at(-1)).toMatchObject({ state: "pending", own: true });

    const all = await t.query(api.comments.replies, {
      target: series(1),
      commentId: head.commentId,
    });
    expect(all!.map((reply) => reply.body)).toEqual(
      repliers.map((subject) => `Reply by ${subject}`),
    );
    expect(
      await t.query(api.comments.replies, { target: series(2), commentId: head.commentId }),
    ).toBeNull();
    expect(
      await t.query(api.comments.replies, { target: series(1), commentId: made[0]! }),
    ).toBeNull();

    // Status changes keep the count in step.
    await moderate(t, made[0]!, "hide");
    await t.withIdentity({ subject: R1 }).mutation(api.comments.remove, { commentId: made[1]! });
    expect((await t.run((ctx) => ctx.db.get(head.commentId)))!.replyCount).toBe(
      repliers.length - 2,
    );
    await moderate(t, made[0]!, "unhide");
    expect((await t.run((ctx) => ctx.db.get(head.commentId)))!.replyCount).toBe(
      repliers.length - 1,
    );
  });

  it("caps a page at maxThreads", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await insertHeads(t, ids, OTHER, COMMENT_POLICY.maxThreads + 5, "approved");
    const page = await t.query(api.comments.list, { target: series(1), limit: 1000 });
    expect(page!.items).toHaveLength(COMMENT_POLICY.maxThreads);
    expect(page!.hasMore).toBe(true);
  });
});

describe("guards", () => {
  it("refuses replies to someone else's pending Comment and to a removed one", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const held = await post(t, AUTHOR, ids, "https://a https://b https://c");
    await expect(post(t, OTHER, ids, "Hi", { parentId: held.commentId })).rejects.toMatchObject({
      data: { code: "closed" },
    });
    // Its author may reply under their own held Comment.
    await post(t, AUTHOR, ids, "Adding context", { parentId: held.commentId });
    const gone = await post(t, AUTHOR, ids, "Gone soon");
    await t
      .withIdentity({ subject: AUTHOR })
      .mutation(api.comments.remove, { commentId: gone.commentId });
    await expect(post(t, OTHER, ids, "Hi", { parentId: gone.commentId })).rejects.toMatchObject({
      data: { code: "closed" },
    });
  });

  it("refuses the author's edit of a hidden Comment", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    await moderate(t, commentId, "hide");
    await expect(
      t
        .withIdentity({ subject: AUTHOR })
        .mutation(api.comments.edit, { commentId, body: "Sneaky", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
  });

  it("refuses reports of a removed or pending Comment by ID", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const held = await post(t, AUTHOR, ids, "https://a https://b https://c");
    const gone = await post(t, AUTHOR, ids, "Gone");
    await t
      .withIdentity({ subject: AUTHOR })
      .mutation(api.comments.remove, { commentId: gone.commentId });
    for (const commentId of [held.commentId, gone.commentId]) {
      await expect(
        t
          .withIdentity({ subject: R1 })
          .mutation(api.comments.report, { commentId, reason: "spam" }),
      ).rejects.toMatchObject({ data: { code: "notFound" } });
    }
  });

  it("refuses a suspended user's posts and reports, and a suspended Moderator's decisions", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    await suspend(t, OTHER);
    await expect(post(t, OTHER, ids)).rejects.toMatchObject({ data: { code: "suspended" } });
    await expect(
      t
        .withIdentity({ subject: OTHER })
        .mutation(api.comments.report, { commentId, reason: "spam" }),
    ).rejects.toMatchObject({ data: { code: "suspended" } });
    await suspend(t, MOD);
    await expect(moderate(t, commentId, "hide")).rejects.toMatchObject({
      data: { code: "suspended" },
    });
    await expect(
      t.withIdentity({ subject: MOD }).query(api.comments.queue, { tab: "pending" }),
    ).rejects.toMatchObject({
      data: { code: "suspended" },
    });
    expect(await t.withIdentity({ subject: MOD }).query(api.comments.queueCounts, {})).toBeNull();
  });

  it("approve on a published Comment needs reports to dismiss", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    await expect(moderate(t, commentId, "approve")).rejects.toMatchObject({
      data: { code: "badState" },
    });
  });

  it("refuses an Edition target at the validator: Comments stay on Series and Volume pages", async () => {
    const t = makeT();
    await trustedSetup(t);
    const comments = () => t.run(async (ctx) => (await ctx.db.query("comments").collect()).length);
    const before = await comments();
    const editionId = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ", slug: "viz" });
      return await insertEdition(ctx, { publicId: 901, publisherId });
    });
    await expect(
      t.withIdentity({ subject: AUTHOR }).mutation(api.comments.post, {
        // Not a PageTargetId: the call a stale or hand-built client could make.
        target: { kind: "edition", id: editionId } as never,
        body: "Loved the pacing of this arc.",
        spoiler: false,
      }),
    ).rejects.toThrow(/Validator/);
    expect(await comments()).toBe(before);
  });

  it("says comment, not rate, when the target is gone", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(post(t, AUTHOR, ids)).rejects.toMatchObject({
      data: { code: "notFound", message: "Nothing to comment on here any more." },
    });
  });
});

describe("queue order and counts", () => {
  it("lists pending by age, a re-held reported Comment included", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const reheld = await post(t, OTHER, ids, "Clean at first");
    for (const subject of [R1, R2]) {
      await t
        .withIdentity({ subject })
        .mutation(api.comments.report, { commentId: reheld.commentId, reason: "spam" });
    }
    const later = await post(t, AUTHOR, ids, "Held later https://a https://b https://c");
    await t.withIdentity({ subject: OTHER }).mutation(api.comments.edit, {
      commentId: reheld.commentId,
      body: "Now https://a https://b https://c",
      spoiler: false,
    });
    const pending = await t
      .withIdentity({ subject: EDITOR })
      .query(api.comments.queue, { tab: "pending" });
    expect(pending.rows.map((row) => [row.commentId, row.reportCount])).toEqual([
      [reheld.commentId, 2],
      [later.commentId, 0],
    ]);
  });

  it("caps queueCounts at 100", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    await insertHeads(t, ids, OTHER, 105, "pending");
    expect(
      await t.withIdentity({ subject: EDITOR }).query(api.comments.queueCounts, {}),
    ).toMatchObject({ pending: 100 });
  });
});

describe("upkeep, more", () => {
  it("purges a user who replied in their own thread", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const head = await post(t, AUTHOR, ids, "My thread");
    await post(t, AUTHOR, ids, "My own follow-up", { parentId: head.commentId });
    const kept = await post(t, OTHER, ids, "Someone else's reply", { parentId: head.commentId });
    const elsewhere = await post(t, OTHER, ids, "Other thread");
    await post(t, AUTHOR, ids, "My reply there", { parentId: elsewhere.commentId });
    expect((await t.run((ctx) => ctx.db.get(elsewhere.commentId)))!.replyCount).toBe(1);

    await purgeAccount(t, AUTHOR);
    const rows = await t.run((ctx) => ctx.db.query("comments").collect());
    expect(rows.filter((row) => row.body.startsWith("My"))).toEqual([]);
    const orphan = rows.find((row) => row._id === kept.commentId)!;
    expect(orphan.parentId).toBeUndefined();
    expect(orphan.replyCount).toBe(0);
    expect(rows.find((row) => row._id === elsewhere.commentId)!.replyCount).toBe(0);
    expect((await listAs(t, null))!.items.map((item) => item.body)).toEqual([
      "Other thread",
      "Someone else's reply",
    ]);
  });

  it("a Volume merge across Series repoints seriesId", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const moved = await t.withIdentity({ subject: OTHER }).mutation(api.comments.post, {
      target: { kind: "volume", id: ids.two.volumeId },
      body: "On the other Series' volume",
      spoiler: false,
    });
    await merge(
      signedIn(t, bob),
      { type: "volume", id: ids.one.volumeId },
      { type: "volume", id: ids.two.volumeId },
    );
    expect(await t.run((ctx) => ctx.db.get(moved.commentId))).toMatchObject({
      seriesId: ids.one.seriesId,
      volumeId: ids.one.volumeId,
    });
    expect((await listAs(t, null, volume(11)))!.items.map((item) => item.body)).toEqual([
      "On the other Series' volume",
    ]);
  });

  it("a split puts merged Comments back", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const onLoser = await t.withIdentity({ subject: OTHER }).mutation(api.comments.post, {
      target: { kind: "series", id: ids.two.seriesId },
      body: "On the loser",
      spoiler: false,
    });
    const mod = signedIn(t, bob);
    await merge(
      mod,
      { type: "series", id: ids.one.seriesId },
      { type: "series", id: ids.two.seriesId },
    );
    expect((await t.run((ctx) => ctx.db.get(onLoser.commentId)))!.seriesId).toBe(ids.one.seriesId);
    await split(mod, { type: "series", id: ids.two.seriesId });
    expect((await t.run((ctx) => ctx.db.get(onLoser.commentId)))!.seriesId).toBe(ids.two.seriesId);
    expect((await listAs(t, null, series(2)))!.items.map((item) => item.body)).toEqual([
      "On the loser",
    ]);
    expect((await listAs(t, null))!.items).toEqual([]);
  });
});
