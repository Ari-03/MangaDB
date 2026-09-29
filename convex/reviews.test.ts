// Reviews (CONTEXT.md: Review): one public plain-text Review per user per
// Series or Volume, shown with the author's Rating; edit and delete by the
// author only; post-moderation by Moderators with an audit trail; upkeep
// through purge and merge; and the public profile's lists.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import { REVIEW_MAX_LENGTH, REVIEW_MIN_LENGTH } from "./reviews";

const ADMIN = "user_admin";
const MOD = "user_mod";
const AUTHOR = "user_author";
const OTHER = "user_other";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof makeT>;

const series = (publicId: number) => ({ kind: "series" as const, publicId });
const volume = (publicId: number) => ({ kind: "volume" as const, publicId });
const TEXT = "A quiet, patient story about grief.\nThe art carries it.";

async function seed(t: T) {
  for (const [subject, username] of [
    [ADMIN, "alice"],
    [MOD, "bob"],
    [AUTHOR, "carol"],
    [OTHER, "dave"],
  ] as const) {
    await t.withIdentity({ subject }).mutation(api.users.claimUsername, { username });
  }
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t.withIdentity({ subject: ADMIN }).mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  return await t.run(async (ctx) => {
    const mk = async (publicId: number, title: string, mature?: true) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId,
        title,
        altTitles: [],
        searchText: title,
        ...(mature ? { mature } : {}),
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: publicId * 10 + 1,
        seriesId,
        position: 1,
        label: "1",
      });
      return { seriesId, volumeId };
    };
    return {
      one: await mk(1, "Frieren"),
      two: await mk(2, "Frieren (duplicate)"),
      adult: await mk(3, "Adult Title", true),
    };
  });
}

type Ids = Awaited<ReturnType<typeof seed>>;

async function write(t: T, subject: string, ids: Ids, body = TEXT, spoiler = false) {
  return await t
    .withIdentity({ subject })
    .mutation(api.reviews.save, { target: { kind: "series", id: ids.one.seriesId }, body, spoiler });
}

const list = (t: T, target = series(1)) => t.query(api.reviews.list, { target });

describe("reviews.save", () => {
  it("posts a public Review with the author's username and Rating beside it", async () => {
    const t = makeT();
    const ids = await seed(t);
    expect(await t.query(api.reviews.mine, { target: series(1) })).toBeNull();

    await t
      .withIdentity({ subject: AUTHOR })
      .mutation(api.ratings.set, { target: { kind: "series", id: ids.one.seriesId }, rating: 9 });
    await write(t, AUTHOR, ids, `  ${TEXT.replace("\n", "\r\n")}  `);

    const page = await list(t);
    expect(page).toMatchObject({ hasMore: false });
    expect(page!.items).toHaveLength(1);
    expect(page!.items[0]).toMatchObject({
      username: "carol",
      rating: 9,
      body: TEXT, // trimmed, line endings unified, line breaks kept
      spoiler: false,
      hidden: false,
      edited: false,
    });
    // Without a Rating the score is simply absent.
    await write(t, OTHER, ids);
    expect((await list(t))!.items.find((i) => i.username === "dave")).toMatchObject({ rating: null });
  });

  it("holds the body to 20-5,000 characters", async () => {
    const t = makeT();
    const ids = await seed(t);
    await expect(write(t, AUTHOR, ids, "x".repeat(REVIEW_MIN_LENGTH - 1))).rejects.toMatchObject({
      data: { code: "reviewTooShort" },
    });
    // Whitespace does not count toward the minimum.
    await expect(write(t, AUTHOR, ids, `   ${"x".repeat(10)}      \n\n   `)).rejects.toMatchObject({
      data: { code: "reviewTooShort" },
    });
    await expect(write(t, AUTHOR, ids, "x".repeat(REVIEW_MAX_LENGTH + 1))).rejects.toMatchObject({
      data: { code: "reviewTooLong" },
    });
    await write(t, AUTHOR, ids, "x".repeat(REVIEW_MIN_LENGTH));
    await write(t, AUTHOR, ids, "x".repeat(REVIEW_MAX_LENGTH));
  });

  it("keeps one Review per user per target; a second save edits it", async () => {
    const t = makeT();
    const ids = await seed(t);
    const first = await write(t, AUTHOR, ids);
    const second = await write(t, AUTHOR, ids, "Rewritten after volume 4: even better.", true);
    expect(second.reviewId).toBe(first.reviewId);
    const page = await list(t);
    expect(page!.items).toHaveLength(1);
    expect(page!.items[0]).toMatchObject({
      body: "Rewritten after volume 4: even better.",
      spoiler: true,
      edited: true,
    });
    // A Volume Review is its own row.
    await t.withIdentity({ subject: AUTHOR }).mutation(api.reviews.save, {
      target: { kind: "volume", id: ids.one.volumeId },
      body: TEXT,
      spoiler: false,
    });
    expect((await list(t, volume(11)))!.items).toHaveLength(1);
    expect((await list(t))!.items).toHaveLength(1);
  });

  it("carries the spoiler flag, and mine returns the viewer's own Review", async () => {
    const t = makeT();
    const ids = await seed(t);
    await write(t, AUTHOR, ids, TEXT, true);
    expect((await list(t))!.items[0]).toMatchObject({ spoiler: true });
    const mine = await t.withIdentity({ subject: AUTHOR }).query(api.reviews.mine, { target: series(1) });
    expect(mine).toMatchObject({
      target: { kind: "series", id: ids.one.seriesId },
      review: { body: TEXT, spoiler: true },
    });
    const theirs = await t.withIdentity({ subject: OTHER }).query(api.reviews.mine, { target: series(1) });
    expect(theirs).toMatchObject({ review: null });
  });

  it("lists newest first, a page at a time", async () => {
    const t = makeT();
    await seed(t);
    const seriesId = (await t.run((ctx) => ctx.db.query("series").first()))!._id;
    const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("reviews", {
          userId,
          seriesId,
          body: `Review number ${i} with enough text.`,
          spoiler: false,
          status: "visible",
          createdAt: i,
        });
      }
    });
    const first = await t.query(api.reviews.list, { target: series(1) });
    expect(first!.items).toHaveLength(20);
    expect(first!.hasMore).toBe(true);
    expect(first!.items[0]!.body).toContain("number 24");
    const all = await t.query(api.reviews.list, { target: series(1), limit: 40 });
    expect(all!.items).toHaveLength(25);
    expect(all!.hasMore).toBe(false);
  });

  it("is rate limited per user", async () => {
    const t = makeT();
    const ids = await seed(t);
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      try {
        await write(t, AUTHOR, ids, `${TEXT} Take ${i}.`);
      } catch (err) {
        expect(err).toMatchObject({ data: { kind: "RateLimited" } });
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("reviews.remove", () => {
  it("lets only the author delete", async () => {
    const t = makeT();
    const ids = await seed(t);
    const { reviewId } = await write(t, AUTHOR, ids);
    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.reviews.remove, { reviewId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.reviews.remove, { reviewId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await t.withIdentity({ subject: AUTHOR }).mutation(api.reviews.remove, { reviewId });
    expect((await list(t))!.items).toHaveLength(0);
  });
});

describe("review moderation", () => {
  it("hides from everyone but Moderators and the author, with an audit row", async () => {
    const t = makeT();
    const ids = await seed(t);
    const { reviewId } = await write(t, AUTHOR, ids);

    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.reviews.setHidden, { reviewId, hidden: true }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    await t
      .withIdentity({ subject: MOD })
      .mutation(api.reviews.setHidden, { reviewId, hidden: true, reason: " Harassment " });

    // Public list: gone, for everyone.
    expect((await list(t))!.items).toHaveLength(0);
    // Moderators: in the hidden list. Everyone else: no hidden list at all.
    const hidden = await t.withIdentity({ subject: MOD }).query(api.reviews.hiddenList, { target: series(1) });
    expect(hidden).toHaveLength(1);
    expect(hidden![0]).toMatchObject({ hidden: true, username: "carol" });
    expect(await t.withIdentity({ subject: OTHER }).query(api.reviews.hiddenList, { target: series(1) })).toBeNull();
    expect(await t.query(api.reviews.hiddenList, { target: series(1) })).toBeNull();
    // The author still sees it, marked hidden, and editing does not unhide it.
    const mine = await t.withIdentity({ subject: AUTHOR }).query(api.reviews.mine, { target: series(1) });
    expect(mine!.review).toMatchObject({ hidden: true });
    await write(t, AUTHOR, ids, `${TEXT} Edited.`);
    expect((await list(t))!.items).toHaveLength(0);

    const audit = await t.run((ctx) => ctx.db.query("reviewAudit").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reviewId, action: "hidden", reason: "Harassment", actor: { kind: "user" } });

    // Hiding again records nothing; unhiding brings it back and is audited.
    await t.withIdentity({ subject: MOD }).mutation(api.reviews.setHidden, { reviewId, hidden: true });
    await t.withIdentity({ subject: ADMIN }).mutation(api.reviews.setHidden, { reviewId, hidden: false });
    expect((await list(t))!.items).toHaveLength(1);
    const actions = (await t.run((ctx) => ctx.db.query("reviewAudit").collect())).map((row) => row.action);
    expect(actions).toEqual(["hidden", "unhidden"]);
  });
});

describe("review upkeep", () => {
  it("purging a user deletes their Reviews", async () => {
    const t = makeT();
    const ids = await seed(t);
    await write(t, AUTHOR, ids);
    await write(t, OTHER, ids);
    await t.mutation(internal.users.purgeUser, { clerkSubject: AUTHOR });
    const page = await list(t);
    expect(page!.items.map((i) => i.username)).toEqual(["dave"]);
    expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toHaveLength(1);
  });

  it("a merge repoints Reviews and keeps the survivor's on a clash", async () => {
    const t = makeT();
    const ids = await seed(t);
    await write(t, AUTHOR, ids, "Survivor review, the one to keep.");
    const onLoser = (subject: string, body: string) =>
      t
        .withIdentity({ subject })
        .mutation(api.reviews.save, { target: { kind: "series", id: ids.two.seriesId }, body, spoiler: false });
    await onLoser(AUTHOR, "Loser review, dropped by the merge.");
    await onLoser(OTHER, "Only on the loser, so it moves over.");

    await t.withIdentity({ subject: MOD }).mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "series", id: ids.one.seriesId },
      loser: { type: "series", id: ids.two.seriesId },
      reason: "Duplicate.",
      confirmImpact: true,
    });
    const bodies = (await list(t))!.items.map((i) => i.body).sort();
    expect(bodies).toEqual(["Only on the loser, so it moves over.", "Survivor review, the one to keep."]);
  });
});

describe("the public profile", () => {
  it("lists rated Series only where Reading is public, Reviews always, mature only when opted in", async () => {
    const t = makeT();
    const ids = await seed(t);
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.ratings.set, { target: { kind: "series", id: ids.one.seriesId }, rating: 9 });
    await author.mutation(api.ratings.set, { target: { kind: "series", id: ids.adult.seriesId }, rating: 6 });
    await author.mutation(api.ratings.set, { target: { kind: "volume", id: ids.one.volumeId }, rating: 4 });
    await write(t, AUTHOR, ids, TEXT, true);
    await author.mutation(api.reviews.save, {
      target: { kind: "series", id: ids.adult.seriesId },
      body: "A review of the adult title.",
      spoiler: false,
    });

    // Reading private (the default): no ratings, but Reviews still show.
    let profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([]);
    expect(profile!.reviews).toHaveLength(1);
    expect(profile!.reviews[0]).toMatchObject({
      target: { kind: "series", publicId: 1, title: "Frieren" },
      rating: 9,
      spoiler: true,
    });

    await author.mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([{ seriesPublicId: 1, title: "Frieren", rating: 9 }]);

    profile = await t.query(api.sharing.publicProfile, { username: "carol", showMature: true });
    expect(profile!.ratings.map((r) => r.title)).toEqual(["Frieren", "Adult Title"]);
    expect(profile!.reviews).toHaveLength(2);

    // A per-Series private override hides that Series' rating.
    await author.mutation(api.sharing.setSeriesVisibility, {
      seriesId: ids.one.seriesId,
      kind: "reading",
      visibility: "private",
    });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([]);

    // Hidden Reviews leave the profile.
    const { reviewId } = await write(t, AUTHOR, ids);
    await t.withIdentity({ subject: MOD }).mutation(api.reviews.setHidden, { reviewId, hidden: true });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.reviews).toEqual([]);
  });
});
