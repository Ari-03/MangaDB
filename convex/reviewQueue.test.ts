// The review queue page (proposals.reviewQueuePage) and the workroom's tab
// counts (workroom.counts): each row's subject and summary, paging that
// reports every Proposal it read, and the caps that keep both bounded. The
// legacy proposals.reviewQueue keeps its array contract for older clients.

import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { insertFirstVersion } from "./moderation";
import { REVIEW_PAGE_MAX } from "./proposals";
import { recordUnplaced } from "./lib/observations";
import { COUNT_CAP } from "./lib/workroom";
import {
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertCoverage,
} from "./test.factories";
import {
  EDITOR,
  MOD,
  PLAIN,
  alice,
  bob,
  carol,
  dave,
  makeT,
  queueRows,
  seedTeam,
  signedIn,
  type TestT,
} from "./test.helpers";

const setup = (t: TestT) => seedTeam(t, [alice, bob, carol, dave]);

/** "Alpha" vol. 1 with a Kodansha paperback Release (ISBN 9781234567897). */
async function seedRelease(t: TestT, mature = false) {
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha USA" });
    const seriesId = await insertSeries(ctx, {
      publicId: 1,
      title: "Alpha",
      ...(mature ? { mature: true as const } : {}),
    });
    const volumeId = await insertVolume(ctx, { seriesId, position: 1, label: "1" });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781234567897",
      binding: "paperback",
    });
    return { seriesId, releaseId };
  });
}

/** An import offer from Kodansha changing the Release's publication date. */
async function insertImportOffer(ctx: MutationCtx, releaseId: Id<"releases">, submittedAt = 1) {
  const proposalId = await ctx.db.insert("proposals", {
    author: { kind: "source", sourceKey: "kodansha" },
    state: "inReview",
    currentVersionNo: 1,
    submittedAt,
  });
  await insertFirstVersion(ctx, proposalId, {
    ops: [
      {
        kind: "update",
        ref: { type: "release", id: releaseId },
        changes: [
          {
            field: "pubDate",
            before: { year: 2026, month: 3, day: 10, sort: 20260310 },
            after: { year: 2026, month: 3, day: 24, sort: 20260324 },
          },
        ],
      },
    ],
    evidence: [],
    changeComment:
      "Import conflict from Kodansha: date. The importer never overwrites — approve to accept the source's value, reject to suppress this exact offer.",
  });
  return proposalId;
}

describe("the review queue's rows", () => {
  it("names a Release update by the record's title, ISBN and page, and labels the change", async () => {
    const t = makeT();
    await setup(t);
    const { releaseId } = await seedRelease(t);
    const proposalId = await t.run((ctx) => insertImportOffer(ctx, releaseId));
    const [row] = await queueRows(t.withIdentity({ subject: EDITOR }));
    const expected = await t.run(async (ctx) => {
      const { displayInfo } = await import("./moderation");
      return await displayInfo(ctx, "release", (await ctx.db.get(releaseId))!);
    });
    expect(row).toMatchObject({
      proposalId,
      kind: "importOffer",
      subject: {
        recordType: "release",
        title: expected.title,
        page: { entity: "edition", publicId: expected.backLink!.publicId },
        isbn13: "9781234567897",
        coverUrl: null,
        mature: false,
      },
      summary: {
        kind: "importOffer",
        fields: [{ field: "pubDate", label: "Publication date" }],
        moreFields: 0,
      },
    });
    // The stored comment is untouched; the proposal page still shows it.
    expect(row!.comment).toContain("The importer never overwrites");
  });

  it("marks a Mature Series' Release so its jacket is concealed", async () => {
    const t = makeT();
    await setup(t);
    const { releaseId } = await seedRelease(t, true);
    await t.run((ctx) => insertImportOffer(ctx, releaseId));
    const [row] = await queueRows(t.withIdentity({ subject: MOD }));
    expect(row?.subject?.mature).toBe(true);
  });

  it("conceals a held book's placement its source rates 18+ before its Series is mature", async () => {
    const t = makeT();
    await setup(t);
    const { seriesId, observationId } = await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      const seriesId = await insertSeries(ctx, { publicId: 9, title: "Night Garden" });
      const observationId = await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "303",
        snapshot: {
          kind: "book",
          url: "https://sevenseasentertainment.com/books/night-garden-vol-3/",
          title: "Night Garden Vol. 3",
          modifiedGmt: "2026-08-01T00:00:00",
          seriesTitle: "Night Garden",
          seriesSlug: "night-garden",
          volumeLabel: "3",
          creators: [],
          category: "Manga",
          isbn13: "9798891600003",
          mature: true,
        },
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(observationId))!,
        { kind: "volumeMissing", reason: "Held.", seriesId },
        Date.now(),
      );
      return { seriesId, observationId };
    });
    const asEditor = signedIn(t, carol);
    const held = await asEditor.query(api.imports.heldBooks, {
      paginationOpts: { cursor: null, numItems: 25 },
    });
    expect(held.page[0]?.mature).toBe(true);

    const prepared = await asEditor.mutation(api.placement.preparePlacement, { observationId });
    if (prepared.status === "unavailable") throw new Error(prepared.reason);
    const { proposalId } = prepared;
    await asEditor.mutation(api.placement.setPlacement, {
      proposalId,
      coverage: { from: "3", to: "3" },
      line: null,
      comment: "Volume 3.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });

    const [row] = await queueRows(signedIn(t, bob));
    expect(row).toMatchObject({
      proposalId,
      subject: {
        recordType: "series",
        title: "Night Garden",
        isbn13: "9798891600003",
        mature: true,
      },
    });
    // The Series itself is flagged only when approval links the observation.
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.mature).toBeUndefined();
  });

  it("reads a record that is gone as a missing record, stale, without throwing", async () => {
    const t = makeT();
    await setup(t);
    const { releaseId } = await seedRelease(t);
    await t.run(async (ctx) => {
      await insertImportOffer(ctx, releaseId);
      await ctx.db.delete(releaseId);
    });
    const [row] = await queueRows(t.withIdentity({ subject: MOD }));
    expect(row).toMatchObject({
      stale: true,
      subject: { recordType: "release", title: "(missing record)", page: null, isbn13: null },
    });
  });

  it("names a report by the Series it was filed from, and the summary keeps only the message", async () => {
    const t = makeT();
    await setup(t);
    await t.run((ctx) => insertSeries(ctx, { publicId: 7, title: "Witch Hat Atelier" }));
    await t
      .withIdentity({ subject: PLAIN })
      .mutation(api.reports.submit, { seriesPublicId: 7, message: "Volume 14 is missing." });
    const [row] = await queueRows(t.withIdentity({ subject: MOD }), { kind: "report" });
    expect(row).toMatchObject({
      kind: "report",
      subject: { recordType: "series", title: "Witch Hat Atelier", page: { publicId: 7 } },
      summary: { report: "Volume 14 is missing." },
    });
  });
});

describe("the review queue's pages", () => {
  /** Five import offers submitted at 1..5, then an Editor's title change at 6. */
  async function seedFive(t: TestT) {
    const { releaseId, seriesId } = await seedRelease(t);
    const offers = await t.run(async (ctx) => {
      const ids = [];
      for (let at = 1; at <= 5; at++) ids.push(await insertImportOffer(ctx, releaseId, at));
      return ids;
    });
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: { type: "series", id: seriesId },
          changes: [{ field: "title", value: "Beta" }],
        },
      ],
      evidence: [{ kind: "url", url: "https://publisher.example/a" }],
      comment: "Official title.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    return { offers, edit: proposalId, seriesId };
  }

  it("reads only the author group a view can match, oldest first, so older imports don't bury people's proposals", async () => {
    const t = makeT();
    await setup(t);
    const { offers, edit, seriesId } = await seedFive(t);
    // A reader's Suggestion, submitted after everything else.
    const asReader = t.withIdentity({ subject: PLAIN });
    const { proposalId: suggestion } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: { type: "series", id: seriesId },
          changes: [{ field: "title", value: "Gamma" }],
        },
      ],
      evidence: [{ kind: "url", url: "https://publisher.example/b" }],
      comment: "The cover says Gamma.",
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId: suggestion });
    const asMod = t.withIdentity({ subject: MOD });
    const page = async (filters: { kind?: "suggestion" | "importOffer"; authorKind?: "humans" }) =>
      (
        await asMod.query(api.proposals.reviewQueuePage, {
          ...filters,
          paginationOpts: { numItems: 4, cursor: null },
        })
      ).page.map((row) => [row.proposalId, row.matches]);

    // The Suggestions view's first page holds the Suggestion, not the offers ahead of it.
    expect(await page({ kind: "suggestion" })).toEqual([[suggestion, true]]);
    // People reads people's proposals only: the Editor's, then the reader's.
    expect(await page({ authorKind: "humans" })).toEqual([
      [edit, true],
      [suggestion, true],
    ]);
    // An import view reads the sources' rows only.
    expect(await page({ kind: "importOffer" })).toEqual(offers.slice(0, 4).map((id) => [id, true]));
    // Unfiltered, the whole queue still pages oldest first.
    const all = await asMod.query(api.proposals.reviewQueuePage, {
      paginationOpts: { numItems: 4, cursor: null },
    });
    expect(all.page.map((row) => row.proposalId)).toEqual(offers.slice(0, 4));
    expect(all.isDone).toBe(false);
    expect(await queueRows(asMod, { kind: "importOffer" }, 3)).toHaveLength(5);
  });

  it("refuses an oversized page, an age filter without the client's time, and a reader", async () => {
    const t = makeT();
    await setup(t);
    const asMod = t.withIdentity({ subject: MOD });
    await expect(
      asMod.query(api.proposals.reviewQueuePage, {
        paginationOpts: { numItems: REVIEW_PAGE_MAX + 1, cursor: null },
      }),
    ).rejects.toMatchObject({ data: { code: "pageTooLarge" } });
    await expect(
      asMod.query(api.proposals.reviewQueuePage, {
        minAgeHours: 1,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toMatchObject({ data: { code: "nowRequired" } });
    await expect(
      t
        .withIdentity({ subject: PLAIN })
        .query(api.proposals.reviewQueuePage, { paginationOpts: { numItems: 10, cursor: null } }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  it("keeps the legacy reviewQueue's array, filters and ageMs for older clients", async () => {
    const t = makeT();
    await setup(t);
    const { offers, edit } = await seedFive(t);
    const asMod = t.withIdentity({ subject: MOD });
    const all = await asMod.query(api.proposals.reviewQueue, {});
    expect(Array.isArray(all)).toBe(true);
    expect(all.map((row) => row.proposalId)).toEqual([...offers, edit]);
    for (const row of all) {
      // The server's clock: within a minute of this test's.
      expect(Math.abs(row.ageMs - (Date.now() - row.submittedAt))).toBeLessThan(60_000);
      expect(row).not.toHaveProperty("matches");
      expect(row).not.toHaveProperty("summary");
    }
    expect(all.at(-1)).toMatchObject({
      opKinds: ["update"],
      recordTypes: ["series"],
      author: { kind: "user" },
      stale: false,
      warnings: [],
    });
    // The optional filters; the age filter reads the server's clock.
    expect(
      (await asMod.query(api.proposals.reviewQueue, { authorKind: "humans" })).map(
        (row) => row.proposalId,
      ),
    ).toEqual([edit]);
    expect(await asMod.query(api.proposals.reviewQueue, { authorKind: "imports" })).toHaveLength(5);
    expect(await asMod.query(api.proposals.reviewQueue, { staleOnly: true })).toEqual([]);
    expect(await asMod.query(api.proposals.reviewQueue, { minAgeHours: 0 })).toHaveLength(6);
    // The offers were submitted in 1970, the Editor's change just now.
    expect(
      (await asMod.query(api.proposals.reviewQueue, { minAgeHours: 1 })).map(
        (row) => row.proposalId,
      ),
    ).toEqual(offers);
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.proposals.reviewQueue, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("workroom.counts", () => {
  it("caps In Review and Held Books at one past the cap, counts unhealthy sources, and is null for a reader", async () => {
    const t = makeT();
    await setup(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < COUNT_CAP + 5; i++) {
        await ctx.db.insert("proposals", {
          author: { kind: "source", sourceKey: "kodansha" },
          state: "inReview",
          currentVersionNo: 1,
          submittedAt: i,
        });
      }
      await ctx.db.insert("approvedSources", {
        key: "kodansha",
        name: "Kodansha USA",
        enabled: false,
        scope: "Kodansha's own catalog",
        fieldAuthority: {},
        cadence: "daily",
        healthState: "unhealthy",
        consecutiveFailures: 3,
      });
    });
    expect(await t.withIdentity({ subject: EDITOR }).query(api.workroom.counts, {})).toEqual({
      inReview: COUNT_CAP + 1,
      heldBooks: 0,
      unhealthySources: 1,
    });
    expect(await t.withIdentity({ subject: PLAIN }).query(api.workroom.counts, {})).toBeNull();
    expect(await t.query(api.workroom.counts, {})).toBeNull();
  });
});
