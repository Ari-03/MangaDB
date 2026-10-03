// Reviews (CONTEXT.md: Review): one public plain-text Review per user per
// Series, Volume, or omnibus Edition, shown with the author's Rating; edit and delete by the
// author only; post-moderation by Moderators with an audit trail; upkeep
// through purge and merge; and the public profile's lists.

import { describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { TargetId, TargetRef } from "./lib/ratings";
import { REVIEW_MAX_LENGTH, REVIEW_MIN_LENGTH, REVIEW_REASON_MAX } from "./reviews";
import { insertCoverage, insertEdition, insertPublisher, insertVolume } from "./test.factories";
import { ADMIN, MOD, alice, bob, makeT, seedTeam, signedIn, type TestT } from "./test.helpers";
import { edition, frierenTwins, merge, omnibusEditions, series, seriesWithVolume, volume } from "./test.tracking";

// These tests cover Reviews as public content, so they run with the flag on;
// features.test.ts covers the switched-off behaviour.
vi.mock("./lib/features", () => ({ FEATURES: { publicReviews: true, comments: true } }));

const AUTHOR = "user_author";
const OTHER = "user_other";

const TEXT = "A quiet, patient story about grief.\nThe art carries it.";

/**
 * Administrator alice, Moderator bob, the author carol and another reader
 * dave; the Frieren pair (Series 1 and 2, Volumes 11 and 21) and a Mature
 * Series 3, "Adult Title", with Volume 31.
 */
async function seed() {
  const t = makeT();
  await seedTeam(t, [alice, bob, { subject: AUTHOR, username: "carol" }, { subject: OTHER, username: "dave" }]);
  const ids = await t.run(async (ctx) => ({
    ...(await frierenTwins(ctx)),
    adult: await seriesWithVolume(ctx, 3, "Adult Title", { mature: true }),
  }));
  return { t, ids };
}

type Ids = Awaited<ReturnType<typeof seed>>["ids"];

async function write(t: TestT, subject: string, ids: Ids, body = TEXT, spoiler = false) {
  return await t
    .withIdentity({ subject })
    .mutation(api.reviews.save, { target: { kind: "series", id: ids.one.seriesId }, body, spoiler });
}

const list = (t: TestT, target: TargetRef = series(1)) => t.query(api.reviews.list, { target });

describe("reviews.save", () => {
  it("posts a public Review with the author's username and Rating beside it", async () => {
    const { t, ids } = await seed();
    expect(await t.query(api.reviews.mine, { target: series(1) })).toBeNull();

    await t
      .withIdentity({ subject: AUTHOR })
      .mutation(api.ratings.set, { target: { kind: "series", id: ids.one.seriesId }, score: 90 });
    await write(t, AUTHOR, ids, `  ${TEXT.replace("\n", "\r\n")}  `);

    const page = await list(t);
    expect(page).toMatchObject({ hasMore: false });
    expect(page!.items).toHaveLength(1);
    expect(page!.items[0]).toMatchObject({
      username: "carol",
      score: 90,
      body: TEXT, // trimmed, line endings unified, line breaks kept
      spoiler: false,
      hidden: false,
      edited: false,
    });
    // Without a Rating the score is simply absent.
    await write(t, OTHER, ids);
    expect((await list(t))!.items.find((i) => i.username === "dave")).toMatchObject({ score: null });
  });

  it("holds the body to 20-5,000 characters", async () => {
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
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
    const { t } = await seed();
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
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
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
    const { t, ids } = await seed();
    await write(t, AUTHOR, ids);
    await write(t, OTHER, ids);
    await t.mutation(internal.users.purgeUser, { clerkSubject: AUTHOR });
    const page = await list(t);
    expect(page!.items.map((i) => i.username)).toEqual(["dave"]);
    expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toHaveLength(1);
  });

  it("a merge repoints Reviews and keeps the survivor's on a clash", async () => {
    const { t, ids } = await seed();
    await write(t, AUTHOR, ids, "Survivor review, the one to keep.");
    const onLoser = (subject: string, body: string) =>
      t
        .withIdentity({ subject })
        .mutation(api.reviews.save, { target: { kind: "series", id: ids.two.seriesId }, body, spoiler: false });
    await onLoser(AUTHOR, "Loser review, dropped by the merge.");
    await onLoser(OTHER, "Only on the loser, so it moves over.");

    await merge(signedIn(t, bob), { type: "series", id: ids.one.seriesId }, { type: "series", id: ids.two.seriesId });
    const bodies = (await list(t))!.items.map((i) => i.body).sort();
    expect(bodies).toEqual(["Only on the loser, so it moves over.", "Survivor review, the one to keep."]);
  });
});

describe("the public profile", () => {
  it("lists rated Series only where Reading is public, Reviews always, mature only when opted in", async () => {
    const { t, ids } = await seed();
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.ratings.set, { target: { kind: "series", id: ids.one.seriesId }, score: 90 });
    await author.mutation(api.ratings.set, { target: { kind: "series", id: ids.adult.seriesId }, score: 60 });
    await author.mutation(api.ratings.set, { target: { kind: "volume", id: ids.one.volumeId }, score: 40 });
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
      score: 90,
      spoiler: true,
    });

    await author.mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([{ kind: "series", publicId: 1, title: "Frieren", score: 90 }]);

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

describe("reviews.save refusals and merged targets", () => {
  const save = (t: TestT, target: TargetId) =>
    t.withIdentity({ subject: AUTHOR }).mutation(api.reviews.save, { target, body: TEXT, spoiler: false });

  it("refuses a hidden Series and a hidden Volume", async () => {
    const { t, ids } = await seed();
    await t.run((ctx) => ctx.db.patch(ids.two.volumeId, { status: "hidden" }));
    await expect(save(t, { kind: "volume", id: ids.two.volumeId })).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(save(t, { kind: "series", id: ids.one.seriesId })).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toEqual([]);
  });

  it("follows a merged target to its survivor, and refuses one merged into a hidden record", async () => {
    const { t, ids } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.two.seriesId, { status: "merged", mergedIntoId: ids.one.seriesId });
      await ctx.db.patch(ids.two.volumeId, { status: "merged", mergedIntoId: ids.one.volumeId });
    });
    const onSeries = await save(t, { kind: "series", id: ids.two.seriesId });
    const onVolume = await save(t, { kind: "volume", id: ids.two.volumeId });
    const rows = await t.run(async (ctx) => [await ctx.db.get(onSeries.reviewId), await ctx.db.get(onVolume.reviewId)]);
    expect(rows[0]).toMatchObject({ seriesId: ids.one.seriesId });
    expect(rows[1]).toMatchObject({ volumeId: ids.one.volumeId });

    await t.run((ctx) => ctx.db.patch(ids.one.seriesId, { status: "hidden" }));
    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.reviews.save, {
        target: { kind: "series", id: ids.two.seriesId },
        body: TEXT,
        spoiler: false,
      }),
    ).rejects.toMatchObject({ data: { code: "notFound" } });
  });
});

describe("reviews.mine", () => {
  it("is null signed out and while the username is pending", async () => {
    const { t } = await seed();
    expect(await t.query(api.reviews.mine, { target: series(1) })).toBeNull();
    expect(
      await t.withIdentity({ subject: "user_unclaimed" }).query(api.reviews.mine, { target: series(1) }),
    ).toBeNull();
  });
});

describe("reviews.setHidden reason", () => {
  it("takes up to REVIEW_REASON_MAX characters and refuses more", async () => {
    const { t, ids } = await seed();
    const { reviewId } = await write(t, AUTHOR, ids);
    const mod = t.withIdentity({ subject: MOD });
    await expect(
      mod.mutation(api.reviews.setHidden, { reviewId, hidden: true, reason: "x".repeat(REVIEW_REASON_MAX + 1) }),
    ).rejects.toMatchObject({ data: { code: "reasonTooLong" } });
    expect((await list(t))!.items).toHaveLength(1);
    // Trimmed first, so surrounding whitespace does not count.
    await mod.mutation(api.reviews.setHidden, {
      reviewId,
      hidden: true,
      reason: `  ${"x".repeat(REVIEW_REASON_MAX)}  `,
    });
    const audit = await t.run((ctx) => ctx.db.query("reviewAudit").collect());
    expect(audit[0]!.reason).toHaveLength(REVIEW_REASON_MAX);
  });
});

describe("the public profile's Reviews after catalog changes", () => {
  it("omits a Review whose Series went hidden and repoints one whose target merged", async () => {
    const { t, ids } = await seed();
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.ratings.set, { target: { kind: "series", id: ids.one.seriesId }, score: 80 });
    await author.mutation(api.reviews.save, {
      target: { kind: "series", id: ids.two.seriesId },
      body: "Written on what turned out to be a duplicate.",
      spoiler: false,
    });
    await author.mutation(api.reviews.save, {
      target: { kind: "volume", id: ids.adult.volumeId },
      body: "A volume whose Series is about to be hidden.",
      spoiler: false,
    });
    // Catalog changes made underneath the rows, as a stale row would see them.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.two.seriesId, { status: "merged", mergedIntoId: ids.one.seriesId });
      await ctx.db.patch(ids.adult.seriesId, { status: "hidden" });
    });
    const profile = await t.query(api.sharing.publicProfile, { username: "carol", showMature: true });
    expect(profile!.reviews).toHaveLength(1);
    expect(profile!.reviews[0]).toMatchObject({
      target: { kind: "series", publicId: 1, title: "Frieren" },
      score: 80,
      body: "Written on what turned out to be a duplicate.",
    });
  });
});

/** seed() plus the omnibus Editions over Series 1 (901-904; omnibusEditions). */
async function seedBooks() {
  const seeded = await seed();
  const books = await seeded.t.run((ctx) => omnibusEditions(ctx, seeded.ids.one));
  return { ...seeded, books };
}

describe("Reviews of an omnibus Edition", () => {
  const save = (t: TestT, target: TargetId) =>
    t.withIdentity({ subject: AUTHOR }).mutation(api.reviews.save, { target, body: TEXT, spoiler: false });

  it("reviews a multi-volume Edition as one book, with the author's Rating of it", async () => {
    const { t, ids, books } = await seedBooks();
    const target = { kind: "edition" as const, id: books.omnibus };
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.ratings.set, { target, score: 70 });
    await author.mutation(api.reviews.save, { target, body: TEXT, spoiler: false });

    expect((await list(t, edition(901)))!.items).toEqual([
      expect.objectContaining({ username: "carol", score: 70, body: TEXT }),
    ]);
    expect(await author.query(api.reviews.mine, { target: edition(901) })).toMatchObject({
      target,
      review: { body: TEXT },
    });
    // Its Volume and Series have none.
    expect((await list(t, volume(11)))!.items).toEqual([]);
    expect((await list(t))!.items).toEqual([]);
  });

  it("refuses a single-volume Edition with rateVolume", async () => {
    const { t, ids, books } = await seedBooks();
    await expect(save(t, { kind: "edition", id: books.single })).rejects.toMatchObject({
      data: { code: "rateVolume" },
    });
    expect(await list(t, edition(902))).toBeNull();
  });

  it("an Edition merge repoints Reviews, the survivor's winning a clash", async () => {
    const { t, ids, books } = await seedBooks();
    const on = (subject: string, editionId: Id<"editions">, body: string) =>
      t.withIdentity({ subject }).mutation(api.reviews.save, {
        target: { kind: "edition", id: editionId },
        body,
        spoiler: false,
      });
    await on(AUTHOR, books.omnibus, "Survivor review, the one to keep.");
    await on(AUTHOR, books.twin, "Loser review, dropped by the merge.");
    await on(OTHER, books.twin, "Only on the loser, so it moves over.");
    await merge(signedIn(t, alice), { type: "edition", id: books.omnibus }, { type: "edition", id: books.twin });
    const bodies = (await list(t, edition(901)))!.items.map((i) => i.body).sort();
    expect(bodies).toEqual(["Only on the loser, so it moves over.", "Survivor review, the one to keep."]);
  });

  it("purging a user deletes their Edition Reviews", async () => {
    const { t, ids, books } = await seedBooks();
    await save(t, { kind: "edition", id: books.omnibus });
    await t.mutation(internal.users.purgeUser, { clerkSubject: AUTHOR });
    expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toEqual([]);
  });

  it("the profile leaves a Mature omnibus' rating out unless the viewer opted in", async () => {
    const { t, ids } = await seed();
    const adultOmnibus = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "VIZ", slug: "viz" });
      const vol2 = await insertVolume(ctx, { seriesId: ids.adult.seriesId, publicId: 32, position: 2 });
      const editionId = await insertEdition(ctx, { publicId: 905, publisherId });
      for (const [order, volumeId] of [ids.adult.volumeId, vol2].entries()) {
        await insertCoverage(ctx, { editionId, volumeId, order });
      }
      return editionId;
    });
    const author = t.withIdentity({ subject: AUTHOR });
    await author.mutation(api.ratings.set, { target: { kind: "edition", id: adultOmnibus }, score: 70 });
    await author.mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });

    expect((await t.query(api.sharing.publicProfile, { username: "carol" }))!.ratings).toEqual([]);
    expect((await t.query(api.sharing.publicProfile, { username: "carol", showMature: true }))!.ratings).toEqual([
      { kind: "edition", publicId: 905, title: "Adult Title Vol 1–2", score: 70 },
    ]);
  });

  it("the profile lists a rated omnibus under its Series' Reading visibility, and its Review", async () => {
    const { t, ids, books } = await seedBooks();
    const author = t.withIdentity({ subject: AUTHOR });
    const target = { kind: "edition" as const, id: books.omnibus };
    await author.mutation(api.ratings.set, { target, score: 80 });
    await author.mutation(api.reviews.save, { target, body: TEXT, spoiler: false });

    let profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([]);
    expect(profile!.reviews).toEqual([
      expect.objectContaining({ target: { kind: "edition", publicId: 901, title: "Frieren Vol 1–2" }, score: 80 }),
    ]);

    await author.mutation(api.sharing.setDefaultVisibility, { kind: "reading", visibility: "public" });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([{ kind: "edition", publicId: 901, title: "Frieren Vol 1–2", score: 80 }]);

    // The Edition's Series decides: a private override on it hides the rating.
    await author.mutation(api.sharing.setSeriesVisibility, {
      seriesId: ids.one.seriesId,
      kind: "reading",
      visibility: "private",
    });
    profile = await t.query(api.sharing.publicProfile, { username: "carol" });
    expect(profile!.ratings).toEqual([]);
  });
});
