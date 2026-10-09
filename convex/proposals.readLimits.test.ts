// What a reader's Suggestions make the pages that render Proposals read.
// Any signed-in reader may write them, so the review queue, a reader's
// Suggestions list and both proposal pages must stay inside a query's read
// limits (16 MiB, 4,096 index ranges) whatever a reader submits within the
// Suggestion limits, over records as large as the field limits allow
// (lib/proposalReads.ts READ_RESERVE has the arithmetic).

import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_CHANGE_COMMENT } from "./lib/evidence";
import { MAX_LIST_ENTRIES, MAX_TEXTAREA_LENGTH, MAX_TEXT_LENGTH } from "./lib/moderationFields";
import { CHANGES_SHOWN, MAX_SUGGESTION_OPS } from "./proposals";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { MOD, PLAIN, alice, bob, dave, makeT, seedTeam, type TestT } from "./test.helpers";

type Op = Doc<"proposalVersions">["ops"][number];

/** Text `length` characters long at three UTF-8 bytes a character, the most one costs. */
const cjk = (length: number) => "漢".repeat(length);

async function readerId(t: TestT) {
  await seedTeam(t, [alice, bob, dave]);
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", PLAIN))
      .unique();
    return user!._id;
  });
}

/** A Revision of `ref` as a Moderator's direct edit leaves it; its id. */
async function insertEdit(
  t: TestT,
  ref: { type: "series" | "release"; id: Id<"series"> | Id<"releases"> },
  changes: Doc<"revisions">["changes"],
  comment = "Edited.",
) {
  return await t.run(async (ctx) => {
    const history = await ctx.db
      .query("revisions")
      .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
      .order("desc")
      .first();
    const author = { kind: "source" as const, sourceKey: "kodansha" };
    const proposalId = await ctx.db.insert("proposals", {
      author,
      state: "approved",
      currentVersionNo: 1,
    });
    return await ctx.db.insert("revisions", {
      ref: ref as Doc<"revisions">["ref"],
      seq: (history?.seq ?? 0) + 1,
      proposalId,
      author,
      changes,
      comment,
    });
  });
}

/**
 * A Suggestion by `userId` whose versions carry `versions`' ops, oldest
 * first, as a reader's resubmissions leave them; In Review, or a Draft of
 * `draft` when given.
 */
async function insertSuggestion(t: TestT, userId: Id<"users">, versions: Op[][], draft?: Op[]) {
  return await t.run(async (ctx) => {
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "user", userId },
      state: draft ? "draft" : "inReview",
      currentVersionNo: versions.length,
      submittedAt: 1,
      ...(draft ? { draft: { ops: draft, evidence: [], comment: "Again." } } : {}),
    });
    for (const [i, ops] of versions.entries()) {
      await ctx.db.insert("proposalVersions", {
        proposalId,
        versionNo: i + 1,
        ops,
        evidence: [],
        changeComment: `Round ${i + 1}.`,
      });
    }
    return proposalId;
  });
}

const retitle = (id: Id<"series">, baseRevisionId?: Id<"revisions">): Op => ({
  kind: "update",
  ref: { type: "series", id },
  ...(baseRevisionId ? { baseRevisionId } : {}),
  changes: [{ field: "title", before: "Old", after: "New" }],
});

/** Whether a rendered version's changes are shown, and if not, why. */
const shownOf = (version: { content: unknown }) =>
  typeof version.content === "string" ? version.content : "shown";

describe("proposal pages within read limits", () => {
  it("reads each record once for a whole queue page", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    // Ten public Series given the longest synopsis a Moderator may write,
    // in CJK, so each edit's Revision holds about 60 KB.
    const targets: Array<{ id: Id<"series">; base: Id<"revisions"> }> = [];
    for (let i = 0; i < 10; i++) {
      const synopsis = cjk(MAX_TEXTAREA_LENGTH);
      const id = await t.run((ctx) => insertSeries(ctx, { synopsis }));
      const base = await insertEdit(t, { type: "series", id }, [
        { field: "synopsis", before: cjk(MAX_TEXTAREA_LENGTH), after: synopsis },
      ]);
      targets.push({ id, base });
    }
    // Twenty small Suggestions, each retitling all ten.
    for (let i = 0; i < 20; i++) {
      await insertSuggestion(t, userId, [targets.map(({ id, base }) => retitle(id, base))]);
    }
    const page = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueuePage, {
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page).toHaveLength(20);
    expect(page.page.every((row) => row.matches && !row.stale)).toBe(true);
    const mine = await t.withIdentity({ subject: PLAIN }).query(api.suggestions.mine, {});
    expect(mine?.filter((row) => !row.notLoaded)).toHaveLength(20);
  });

  it("shows the changes of the newest versions only, however many records older ones name", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    // Fifty versions, each changing ten other Releases of a three-volume omnibus.
    const releaseIds = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Omni" });
      const seriesId = await insertSeries(ctx, { publicId: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      for (const position of [1, 2, 3]) {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        await insertCoverage(ctx, { editionId, volumeId, order: position });
      }
      const ids = [];
      for (let i = 0; i < 50 * MAX_SUGGESTION_OPS; i++) {
        ids.push(await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] }));
      }
      return ids;
    });
    const versions = Array.from({ length: 50 }, (_, v) =>
      releaseIds.slice(v * MAX_SUGGESTION_OPS, (v + 1) * MAX_SUGGESTION_OPS).map(
        (id): Op => ({
          kind: "update",
          ref: { type: "release", id },
          changes: [{ field: "pubDate", after: { year: 2024, month: 4, sort: 20240400 } }],
        }),
      ),
    );
    const proposalId = await insertSuggestion(t, userId, versions);
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    const own = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    for (const detail of [team, own]) {
      expect(detail?.versions).toHaveLength(50);
      const shown = detail!.versions.map(shownOf);
      expect(shown.slice(-CHANGES_SHOWN)).toEqual(Array(CHANGES_SHOWN).fill("shown"));
      expect(shown.slice(0, -CHANGES_SHOWN)).toEqual(Array(50 - CHANGES_SHOWN).fill("older"));
      expect(detail!.versions[0]).toMatchObject({ versionNo: 1, opCount: 10 });
    }
  });

  it("reads few base Revisions however often a reader resubmits", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    // Ten Series, each edited fifty times with ~60 KB Revisions; version v
    // of the Suggestion is based on each Series' v-th.
    const bases: Array<Array<Id<"revisions">>> = [];
    const seriesIds: Array<Id<"series">> = [];
    for (let i = 0; i < 10; i++) {
      const id = await t.run((ctx) => insertSeries(ctx, { synopsis: "Short." }));
      seriesIds.push(id);
      const revisions = [];
      for (let v = 0; v < 50; v++) {
        revisions.push(
          await insertEdit(t, { type: "series", id }, [
            {
              field: "synopsis",
              before: cjk(MAX_TEXTAREA_LENGTH),
              after: cjk(MAX_TEXTAREA_LENGTH),
            },
          ]),
        );
      }
      bases.push(revisions);
    }
    const versions = Array.from({ length: 50 }, (_, v) =>
      seriesIds.map((id, i) => retitle(id, bases[i]![v])),
    );
    const proposalId = await insertSuggestion(t, userId, versions);
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    const own = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    for (const detail of [team, own]) {
      expect(detail?.stale).toBe(false);
      expect(detail?.versions.filter((version) => shownOf(version) === "shown")).toHaveLength(
        CHANGES_SHOWN,
      );
    }
  });
});

/**
 * A Series as large as the field limits let a person make it: the longest
 * title, a hundred of the longest alternative titles and the longest
 * synopsis, all in CJK (its searchText repeats the titles), with a latest
 * Revision that wrote every one of those fields over values as large.
 * Returns it and that Revision.
 */
async function insertLargestSeries(t: TestT) {
  const title = cjk(MAX_TEXT_LENGTH);
  const altTitles = Array.from({ length: MAX_LIST_ENTRIES }, () => cjk(MAX_TEXT_LENGTH));
  const synopsis = cjk(MAX_TEXTAREA_LENGTH);
  const id = await t.run((ctx) => insertSeries(ctx, { title, altTitles, synopsis }));
  const changes = [
    { field: "title", before: title, after: title },
    { field: "altTitles", before: altTitles, after: altTitles },
    { field: "synopsis", before: synopsis, after: synopsis },
  ];
  const latest = await insertEdit(t, { type: "series", id }, changes, cjk(MAX_CHANGE_COMMENT));
  return { id, latest, changes };
}

describe("proposal pages at the largest records", () => {
  it("answers a queue page whose rows each name ten of the largest Series", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    for (let row = 0; row < 25; row++) {
      const ops = [];
      for (let i = 0; i < MAX_SUGGESTION_OPS; i++) {
        const { id, latest } = await insertLargestSeries(t);
        ops.push(retitle(id, latest));
      }
      await insertSuggestion(t, userId, [ops]);
    }
    const page = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueuePage, {
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page).toHaveLength(25);
    // The first rows are read whole; the rest are listed as not loaded.
    expect(page.page[0]).toMatchObject({ matches: true, stale: false });
    const notLoaded = page.page.filter((row) => "notLoaded" in row);
    expect(notLoaded.length).toBeGreaterThan(0);
    expect(page.page.indexOf(notLoaded[0]!)).toBeGreaterThan(0);
    const mine = await t.withIdentity({ subject: PLAIN }).query(api.suggestions.mine, {});
    expect(mine).toHaveLength(25);
    expect(mine?.[0]?.notLoaded).toBe(false);
  });

  it("answers a proposal page whose shown versions each name ten of the largest Series", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    // The Draft and the newest versions each change ten Series of their
    // own, each based on a Revision as large as its latest.
    const opSet = async () => {
      const ops = [];
      for (let i = 0; i < MAX_SUGGESTION_OPS; i++) {
        const { id, changes } = await insertLargestSeries(t);
        const base = await insertEdit(t, { type: "series", id }, changes, cjk(MAX_CHANGE_COMMENT));
        await insertEdit(t, { type: "series", id }, changes, cjk(MAX_CHANGE_COMMENT));
        ops.push(retitle(id, base));
      }
      return ops;
    };
    const shown = [];
    for (let v = 0; v < CHANGES_SHOWN; v++) shown.push(await opSet());
    const draft = await opSet();
    const versions = [...Array(50 - CHANGES_SHOWN).fill(shown[0]), ...shown];
    const proposalId = await insertSuggestion(t, userId, versions, draft);
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    const own = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    // Each Series has moved past the Draft's base.
    expect(own?.stale).toBe(true);
    for (const detail of [team, own]) {
      expect(detail?.versions).toHaveLength(50);
      // The Draft is read first; what does not fit says so.
      expect(shownOf(detail!.draft!)).toBe("shown");
      const states = detail!.versions.map(shownOf);
      expect(states).toContain("notLoaded");
      expect(states.slice(0, -CHANGES_SHOWN)).toEqual(Array(50 - CHANGES_SHOWN).fill("older"));
    }
  });
});

/**
 * An Edition of `volumes` Volumes of one of the largest Series
 * (insertLargestSeries), with `releases` Releases; their ids.
 */
async function insertLongEdition(t: TestT, volumes: number, releases: number) {
  const { id: seriesId } = await insertLargestSeries(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Long" });
    const editionId = await insertEdition(ctx, { publisherId });
    for (let position = 1; position <= volumes; position++) {
      const volumeId = await insertVolume(ctx, { seriesId, position });
      await insertCoverage(ctx, { editionId, volumeId, order: position });
    }
    const ids = [];
    for (let i = 0; i < releases; i++) {
      ids.push(await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] }));
    }
    return ids;
  });
}

const rebind = (id: Id<"releases">): Op => ({
  kind: "update",
  ref: { type: "release", id },
  changes: [{ field: "binding", after: "hardcover" }],
});

describe("titles within read limits", () => {
  it("titles Releases of a thirty-volume Edition of the largest Series on both proposal pages", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    const releaseIds = await insertLongEdition(t, 30, 2);
    const proposalId = await insertSuggestion(t, userId, [releaseIds.map(rebind)]);
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    const own = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    for (const detail of [team, own]) {
      const content = detail!.versions[0]!.content;
      if (typeof content === "string") throw new Error(`version ${content}`);
      expect(content.ops).toHaveLength(2);
      for (const op of content.ops) {
        expect(op).toMatchObject({ kind: "update" });
        expect("recordTitle" in op && op.recordTitle).toMatch(/Vol 1–30 — physical release$/);
      }
    }
  });

  it("answers a queue page whose Release row follows a row of ten of the largest Series", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    const ops = [];
    for (let i = 0; i < MAX_SUGGESTION_OPS; i++) {
      const { id, latest } = await insertLargestSeries(t);
      ops.push(retitle(id, latest));
    }
    await insertSuggestion(t, userId, [ops]);
    const [releaseId] = await insertLongEdition(t, 30, 1);
    await insertSuggestion(t, userId, [[rebind(releaseId!)]]);
    const page = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueuePage, {
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page).toHaveLength(2);
    // The Edition's Series is read once for its title, not once a Volume.
    const [first, release] = page.page;
    expect(first).toMatchObject({ matches: true });
    expect(release?.matches && release.subject?.title).toMatch(/Vol 1–30 — physical release$/);
  });

  it("marks a version not loaded when its Release's title alone outgrows the budget", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    // An Edition of sixty Volumes, each of a different one of the largest Series:
    // about 20 MB of Series to read for its title.
    const seriesIds: Array<Id<"series">> = [];
    for (let i = 0; i < 60; i++) seriesIds.push((await insertLargestSeries(t)).id);
    const releaseId = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Wide" });
      const editionId = await insertEdition(ctx, { publisherId });
      for (const [i, seriesId] of seriesIds.entries()) {
        const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
        await insertCoverage(ctx, { editionId, volumeId, order: i + 1 });
      }
      return await insertRelease(ctx, { editionId, publisherId, seriesIds });
    });
    const proposalId = await insertSuggestion(t, userId, [[rebind(releaseId)]]);
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    const own = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    for (const detail of [team, own]) {
      expect(detail!.versions.map(shownOf)).toEqual(["notLoaded"]);
    }
  });

  it("answers the legacy queue whose rows each name ten of the largest Series", async () => {
    const t = makeT({ transactionLimits: true });
    const userId = await readerId(t);
    for (let row = 0; row < 3; row++) {
      const ops = [];
      for (let i = 0; i < MAX_SUGGESTION_OPS; i++) {
        const { id, latest } = await insertLargestSeries(t);
        ops.push(retitle(id, latest));
      }
      await insertSuggestion(t, userId, [ops]);
    }
    const rows = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueue, {});
    expect(rows).toHaveLength(3);
    // The first rows are read whole; the rest are marked and left for their pages.
    expect(rows[0]).toMatchObject({ notLoaded: false, opCount: MAX_SUGGESTION_OPS });
    expect(rows.at(-1)).toMatchObject({ notLoaded: true });
  });
});
