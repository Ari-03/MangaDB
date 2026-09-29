// Comments (CONTEXT.md: Comment, Comment Report, Shadowed User): hold rules
// on posting, one reply level, author edit/delete, reports and auto-hide,
// Moderator actions with their audit trail, who sees what, the queue, rate
// limits, and upkeep through purge and merge.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { COMMENT_POLICY } from "./comments";

const ADMIN = "user_admin";
const MOD = "user_mod";
const EDITOR = "user_editor";
const AUTHOR = "user_author";
const OTHER = "user_other";
const R1 = "user_r1";
const R2 = "user_r2";
const R3 = "user_r3";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

const series = (publicId: number) => ({ kind: "series" as const, publicId });
const volume = (publicId: number) => ({ kind: "volume" as const, publicId });

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock past the new-account hold, so only the other rules apply. */
function ageAccounts() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + COMMENT_POLICY.minAccountAgeMs + 60_000);
}

async function seed(t: T) {
  for (const [subject, username] of [
    [ADMIN, "alice"],
    [MOD, "bob"],
    [EDITOR, "erin"],
    [AUTHOR, "carol"],
    [OTHER, "dave"],
    [R1, "rae"],
    [R2, "rob"],
    [R3, "ria"],
  ] as const) {
    await t.withIdentity({ subject }).mutation(api.users.claimUsername, { username });
  }
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  const admin = t.withIdentity({ subject: ADMIN });
  await admin.mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  await admin.mutation(api.roles.appoint, { username: "erin", role: "editor" });
  return await t.run(async (ctx) => {
    const mk = async (publicId: number, title: string) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title,
        altTitles: [],
        searchText: title,
      });
      const mkVolume = (n: number) =>
        ctx.db.insert("volumes", {
          status: "active",
          publicId: publicId * 10 + n,
          seriesId,
          position: n,
          label: String(n),
        });
      return { seriesId, volumeId: await mkVolume(1), volume2Id: await mkVolume(2) };
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
async function trust(t: T, ids: Ids, subject: string) {
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
async function trustedSetup(t: T) {
  const ids = await seed(t);
  ageAccounts();
  for (const subject of [AUTHOR, OTHER, R1, R2, R3]) await trust(t, ids, subject);
  return ids;
}

function post(
  t: T,
  subject: string,
  ids: Ids,
  body = "Loved the pacing of this arc.",
  extra: { parentId?: Id<"comments">; spoiler?: boolean; onVolume?: boolean } = {},
) {
  return t.withIdentity({ subject }).mutation(api.comments.post, {
    target: extra.onVolume ? { kind: "volume", id: ids.one.volumeId } : { kind: "series", id: ids.one.seriesId },
    body,
    spoiler: extra.spoiler ?? false,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
}

const listAs = (t: T, subject: string | null, target = series(1)) =>
  subject === null
    ? t.query(api.comments.list, { target })
    : t.withIdentity({ subject }).query(api.comments.list, { target });

const statusOf = (t: T, commentId: Id<"comments">) => t.run(async (ctx) => (await ctx.db.get(commentId))?.status);
const auditActions = (t: T) =>
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
    expect((await post(t, AUTHOR, ids, "See https://a.example and http://b.example")).held).toBe(false);
    const spam = await post(t, AUTHOR, ids, "https://a.example https://b.example HTTPS://c.example");
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
    await expect(post(t, AUTHOR, ids, "   \n  ")).rejects.toMatchObject({ data: { code: "commentEmpty" } });
    await expect(post(t, AUTHOR, ids, "x".repeat(COMMENT_POLICY.maxLength + 1))).rejects.toMatchObject({
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
    await expect(post(t, "user_nobody", ids)).rejects.toMatchObject({ data: { code: "usernameRequired" } });
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
    await expect(post(t, AUTHOR, ids, "Deeper.", { parentId: reply.commentId })).rejects.toMatchObject({
      data: { code: "replyDepth" },
    });
    await expect(post(t, OTHER, ids, "Wrong page.", { parentId: top.commentId, onVolume: true })).rejects.toMatchObject({
      data: { code: "wrongTarget" },
    });
    await t.withIdentity({ subject: MOD }).mutation(api.comments.moderate, { commentId: top.commentId, action: "hide" });
    await expect(post(t, OTHER, ids, "Too late.", { parentId: top.commentId })).rejects.toMatchObject({
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
      t.withIdentity({ subject: OTHER }).mutation(api.comments.edit, { commentId, body: "mine now", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.comments.edit, { commentId, body: "mod edit", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.comments.edit, { commentId, body: "Fixed a typo.", spoiler: true });
    expect((await listAs(t, null))!.items[0]).toMatchObject({ body: "Fixed a typo.", spoiler: true, edited: true });

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
      t.withIdentity({ subject: AUTHOR }).mutation(api.comments.edit, { commentId, body: "back", spoiler: false }),
    ).rejects.toMatchObject({ data: { code: "badState" } });
    expect(await auditActions(t)).toEqual(["remove"]);
    // A Moderator cannot restore what its author deleted.
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.comments.moderate, { commentId, action: "restore" }),
    ).rejects.toMatchObject({ data: { code: "authorDeleted" } });
  });
});

describe("reports", () => {
  it("takes one report per user, never the author's own, and hides at three", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    const reportAs = (subject: string, note?: string) =>
      t.withIdentity({ subject }).mutation(api.comments.report, { commentId, reason: "spam", ...(note ? { note } : {}) });

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
        await t.withIdentity({ subject: R1 }).mutation(api.comments.report, { commentId, reason: "other" });
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
    await expect(post(t, AUTHOR, ids, "One too many")).rejects.toMatchObject({ data: { kind: "RateLimited" } });
  });
});

describe("moderation", () => {
  it("is Moderator-only and audits every decision", async () => {
    const t = makeT();
    const ids = await seed(t);
    const { commentId } = await post(t, AUTHOR, ids); // new account: pending
    const act = (subject: string, action: "approve" | "hide" | "unhide" | "remove" | "restore", reason?: string) =>
      t.withIdentity({ subject }).mutation(api.comments.moderate, { commentId, action, ...(reason ? { reason } : {}) });

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
    expect(audit.map((row) => row.action)).toEqual(["approve", "hide", "unhide", "remove", "restore"]);
    expect(audit[1]).toMatchObject({ reason: "Off-topic", actor: { kind: "user" } });
  });

  it("approving a reported Comment dismisses its reports", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const { commentId } = await post(t, AUTHOR, ids);
    for (const subject of [R1, R2]) {
      await t.withIdentity({ subject }).mutation(api.comments.report, { commentId, reason: "spoiler" });
    }
    await t.withIdentity({ subject: MOD }).mutation(api.comments.moderate, { commentId, action: "approve" });
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
    await mod.mutation(api.comments.moderate, { commentId: hidden.commentId, action: "hide" });
    const lonely = await post(t, AUTHOR, ids, "Removed, no replies");
    await mod.mutation(api.comments.moderate, { commentId: lonely.commentId, action: "remove" });
    const threaded = await post(t, OTHER, ids, "Removed, with a reply");
    await post(t, R1, ids, "A reply that keeps the thread", { parentId: threaded.commentId });
    await mod.mutation(api.comments.moderate, { commentId: threaded.commentId, action: "remove" });
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
    expect(placeholder).toMatchObject({ username: null, replies: [{ body: "A reply that keeps the thread" }] });
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
      await t.withIdentity({ subject }).mutation(api.comments.report, { commentId: twice.commentId, reason: "spam" });
    }

    await expect(t.withIdentity({ subject: OTHER }).query(api.comments.queue, { tab: "pending" })).rejects.toMatchObject({
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

    expect(await editor.query(api.comments.queueCounts, {})).toEqual({ pending: 1, reported: 2, hidden: 0 });
    await t.withIdentity({ subject: R3 }).mutation(api.comments.report, { commentId: twice.commentId, reason: "spam" });
    expect(await editor.query(api.comments.queueCounts, {})).toEqual({ pending: 1, reported: 1, hidden: 1 });
    expect((await editor.query(api.comments.queue, { tab: "hidden" })).rows[0]!.body).toBe("Reported twice");

    await t.withIdentity({ subject: MOD }).mutation(api.comments.moderate, { commentId: once.commentId, action: "remove" });
    expect((await editor.query(api.comments.queue, { tab: "removed" })).rows.map((row) => row.body)).toEqual([
      "Reported once",
    ]);
  });
});

describe("upkeep", () => {
  it("purging a user deletes their Comments and reports, and orphans replies to top level", async () => {
    const t = makeT();
    const ids = await trustedSetup(t);
    const theirs = await post(t, AUTHOR, ids, "Leaving soon");
    await post(t, OTHER, ids, "Reply that stays", { parentId: theirs.commentId });
    const other = await post(t, OTHER, ids, "Reported by the leaver");
    await t.withIdentity({ subject: AUTHOR }).mutation(api.comments.report, { commentId: other.commentId, reason: "spam" });
    await t.withIdentity({ subject: R1 }).mutation(api.comments.report, { commentId: theirs.commentId, reason: "spam" });

    await t.mutation(internal.users.purgeUser, { clerkSubject: AUTHOR });

    const rows = await t.run((ctx) => ctx.db.query("comments").collect());
    const leaverId = theirs.commentId;
    expect(rows.find((row) => row._id === leaverId)).toBeUndefined();
    // Only the leaver's own seeded history went with them.
    expect(rows.filter((row) => row.body.startsWith("Earlier"))).toHaveLength(4 * COMMENT_POLICY.minApprovedComments);
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
    const onLoser = (body: string, target: { kind: "series"; id: Id<"series"> } | { kind: "volume"; id: Id<"volumes"> }) =>
      t.withIdentity({ subject: OTHER }).mutation(api.comments.post, { target, body, spoiler: false });
    await onLoser("On the loser", { kind: "series", id: ids.two.seriesId });
    const volumeComment = await onLoser("On the loser's volume", { kind: "volume", id: ids.two.volumeId });

    await t.withIdentity({ subject: MOD }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.one.seriesId },
      loser: { type: "series", id: ids.two.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    expect((await listAs(t, null))!.items.map((item) => item.body)).toEqual(["On the loser", "On the survivor"]);
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
    await t.withIdentity({ subject: MOD }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "volume", id: ids.one.volumeId },
      loser: { type: "volume", id: ids.one.volume2Id },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    expect((await listAs(t, null, volume(11)))!.items.map((item) => item.body)).toEqual(["On volume 2"]);
  });
});
