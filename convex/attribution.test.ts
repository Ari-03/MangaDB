// Description credit (lib/attribution.ts) and the citation a person states
// for editorial text (moderation.ts validateUpdate): through direct edits,
// Editor proposals and their rebase, and onto the public pages, which name
// the record that owns the text shown so the data team's links go there.

import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { fieldAttribution } from "./lib/attribution";
import {
  insertBundle,
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import { alice, bob, carol, dave, EDITOR, MOD, makeT, seedTeam, type TestT } from "./test.helpers";

const KODANSHA_TEXT = "A girl finds a sword.";
const KODANSHA = { sourceName: "Kodansha USA", url: "https://kodansha.us/alpha-1" };
const PUBLISHER_PAGE = { sourceName: "Publisher's back cover", url: "https://example.com/alpha" };

async function registry(ctx: MutationCtx) {
  for (const [key, name] of [
    ["kodansha", "Kodansha USA"],
    ["ann", "Anime News Network Encyclopedia"],
  ] as const) {
    await ctx.db.insert("approvedSources", {
      key,
      name,
      enabled: true,
      scope: "test",
      fieldAuthority: {},
      cadence: "daily",
      healthState: "healthy",
      consecutiveFailures: 0,
    });
  }
}

/**
 * Alpha (public id 7001) with Volume 7002 and its one-volume Edition 7003,
 * whose Release carries `description` (absent when undefined).
 */
async function book(t: TestT, description?: string) {
  return await t.run(async (ctx) => {
    await registry(ctx);
    const publisherId = await insertPublisher(ctx, { name: "Kodansha USA" });
    const seriesId = await insertSeries(ctx, { publicId: 7001, title: "Alpha" });
    const volumeId = await insertVolume(ctx, { seriesId, publicId: 7002 });
    const editionId = await insertEdition(ctx, { publisherId, publicId: 7003 });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781632364210",
      binding: "paperback",
      pubDate: { year: 2017, month: 3, sort: 20170300 },
      ...(description !== undefined ? { description } : {}),
    });
    return { publisherId, seriesId, volumeId, editionId, releaseId };
  });
}

/** An import's Revision writing the description, with Kodansha's page as its citation. */
async function imported(t: TestT, releaseId: Id<"releases">, citation = KODANSHA) {
  await t.run((ctx) =>
    insertSourceRevision(ctx, {
      sourceKey: "kodansha",
      ref: { type: "release", id: releaseId },
      changes: [{ field: "description", after: KODANSHA_TEXT }],
      citation,
    }),
  );
}

const latestBase = (t: TestT, releaseId: Id<"releases">) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
          .order("desc")
          .first()
      )?._id,
  );

/** The Moderator's direct edit of the Release. */
async function edit(
  t: TestT,
  releaseId: Id<"releases">,
  changes: Array<{ field: string; value: unknown }>,
  citation?: { sourceName: string; url: string } | null,
) {
  return await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
    ref: { type: "release", id: releaseId },
    baseRevisionId: await latestBase(t, releaseId),
    changes,
    comment: "Copy edit.",
    ...(citation !== undefined ? { citation } : {}),
  });
}

const editionCredit = async (t: TestT) =>
  (await t.query(api.catalogPages.editionPage, { publicId: 7003 }))?.description;

describe("description credit", () => {
  it("credits an import's citation, keeps it through a light copy edit and facts-only edits", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    expect(await editionCredit(t)).toMatchObject({
      source: "release",
      owner: {
        type: "release",
        key: b.releaseId,
        label: "the paperback release, ISBN 9781632364210",
      },
      attribution: KODANSHA,
    });

    // The form's Keep: the same source restated with lighter text.
    await edit(
      t,
      b.releaseId,
      [{ field: "description", value: "A girl finds a sword!" }],
      KODANSHA,
    );
    expect((await editionCredit(t))?.attribution).toEqual(KODANSHA);
    // A price correction says nothing about the text.
    await edit(t, b.releaseId, [{ field: "price", value: { amountCents: 1099, currency: "USD" } }]);
    expect((await editionCredit(t))?.attribution).toEqual(KODANSHA);
    // Restating the current source with unchanged text is no change at all.
    await expect(edit(t, b.releaseId, [], KODANSHA)).rejects.toMatchObject({
      data: { code: "noChanges" },
    });
  });

  it("saves a source change with the text unchanged, and an explicit no-source", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);

    const { revisionId } = await edit(t, b.releaseId, [], PUBLISHER_PAGE);
    const revision = await t.run((ctx) => ctx.db.get(revisionId));
    expect(revision).toMatchObject({
      changes: [],
      citedField: "description",
      citation: PUBLISHER_PAGE,
    });
    expect((await editionCredit(t))?.attribution).toEqual(PUBLISHER_PAGE);

    await edit(t, b.releaseId, [], null);
    expect((await editionCredit(t))?.attribution).toBeNull();
    await expect(
      edit(t, b.releaseId, [], { sourceName: "Blog", url: "http://example.com" }),
    ).rejects.toMatchObject({
      data: { code: "invalidCitation" },
    });
  });

  it("never credits a person's uncited text, or text changed outside History", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "alpha-1",
        recordRef: { type: "release", id: b.releaseId },
        snapshot: { description: "Rewritten by hand.", url: "https://kodansha.us/alpha-1" },
      }),
    );
    // No citation stated: a person's own words, though a source has the same text.
    await edit(t, b.releaseId, [{ field: "description", value: "Rewritten by hand." }]);
    expect((await editionCredit(t))?.attribution).toBeNull();
  });

  it("credits nobody for text changed outside History", async () => {
    const t = makeT();
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    await t.run((ctx) => ctx.db.patch(b.releaseId, { description: "Patched without a Revision." }));
    expect(await editionCredit(t)).toMatchObject({
      text: "Patched without a Revision.",
      attribution: null,
    });
    const direct = await t.run((ctx) =>
      fieldAttribution(ctx, { type: "release", id: b.releaseId }, "description", KODANSHA_TEXT),
    );
    expect(direct).toEqual(KODANSHA);
  });

  it("credits pre-history text only when exactly one source offers exactly that text", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    const observe = (sourceKey: string, text: string, url: string) =>
      t.run((ctx) =>
        insertObservation(ctx, {
          sourceKey,
          sourceRecordId: `${sourceKey}-${url}`,
          recordRef: { type: "release", id: b.releaseId },
          snapshot: { description: text, url },
        }),
      );
    await observe("ann", "A different summary.", "https://ann.test/1");
    expect((await editionCredit(t))?.attribution).toBeNull();
    await observe("kodansha", KODANSHA_TEXT, "https://kodansha.us/alpha-1");
    expect((await editionCredit(t))?.attribution).toEqual(KODANSHA);
    // A second source with the same words makes it ambiguous: nobody is credited.
    await observe("ann", KODANSHA_TEXT, "https://ann.test/2");
    expect((await editionCredit(t))?.attribution).toBeNull();
  });
});

describe("citations through Editor proposals", () => {
  it("carries a used blurb's source and evidence from draft to approval", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t);
    const observationId = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "alpha-1",
        recordRef: { type: "release", id: b.releaseId },
        snapshot: { description: KODANSHA_TEXT, url: KODANSHA.url },
      }),
    );
    const asEditor = t.withIdentity({ subject: EDITOR });
    const ref = { type: "release" as const, id: b.releaseId };
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref,
          changes: [{ field: "description", value: KODANSHA_TEXT }],
          citation: KODANSHA,
        },
      ],
      evidence: [{ kind: "observation", observationId }],
      comment: "The publisher's blurb.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    const detail = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    expect(detail?.versions[0]?.ops[0]).toMatchObject({ kind: "update", citation: KODANSHA });
    expect(detail?.versions[0]?.evidence).toEqual([
      {
        kind: "observation",
        observationId: expect.any(String),
        sourceKey: "kodansha",
        url: KODANSHA.url,
      },
    ]);

    await t.withIdentity({ subject: MOD }).mutation(api.proposals.approveProposal, { proposalId });
    expect(await editionCredit(t)).toMatchObject({ text: KODANSHA_TEXT, attribution: KODANSHA });
  });

  it("keeps a source-only proposal through a rebase, and drops it once the credit already matches", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const ref = { type: "release" as const, id: b.releaseId };
    const draft = async () =>
      (
        await asEditor.mutation(api.proposals.saveDraft, {
          ops: [{ kind: "update", ref, changes: [], citation: PUBLISHER_PAGE }],
          evidence: [],
          comment: "The back cover says it.",
        })
      ).proposalId;

    const first = await draft();
    await asEditor.mutation(api.proposals.submitProposal, { proposalId: first });
    // An unrelated fact lands first: the proposal goes stale, rebases, keeps its source.
    await edit(t, b.releaseId, [{ field: "price", value: { amountCents: 999, currency: "USD" } }]);
    expect(
      (
        await t
          .withIdentity({ subject: MOD })
          .mutation(api.proposals.approveProposal, { proposalId: first })
      ).status,
    ).toBe("stale");
    await asEditor.mutation(api.proposals.rebaseProposal, { proposalId: first });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId: first });
    await t
      .withIdentity({ subject: MOD })
      .mutation(api.proposals.approveProposal, { proposalId: first });
    expect((await editionCredit(t))?.attribution).toEqual(PUBLISHER_PAGE);

    // A second identical statement is nothing to propose.
    await expect(draft()).rejects.toMatchObject({ data: { code: "noChanges" } });
  });

  it("ties a source-only statement to its text: rewritten text needs the source chosen again", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });
    const ref = { type: "release" as const, id: b.releaseId };
    const NEW_TEXT = "Entirely new synopsis from another publisher.";
    const ANOTHER = { sourceName: "Another publisher", url: "https://another.example/alpha" };
    const propose = async (ops: FunctionArgs<typeof api.proposals.saveDraft>["ops"]) =>
      (
        await asEditor.mutation(api.proposals.saveDraft, {
          ops,
          evidence: [{ kind: "url", url: PUBLISHER_PAGE.url }],
          comment: "Credit the back cover.",
        })
      ).proposalId;

    // The source alone, and the source beside an unrelated fact.
    const sourceOnly = await propose([
      { kind: "update", ref, changes: [], citation: PUBLISHER_PAGE },
    ]);
    const draft = await t.run((ctx) => ctx.db.get(sourceOnly));
    expect(draft?.draft?.ops[0]).toMatchObject({ citedText: KODANSHA_TEXT });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId: sourceOnly });

    // A Moderator then replaces the text and its source.
    await edit(t, b.releaseId, [{ field: "description", value: NEW_TEXT }], ANOTHER);
    const withFact = await propose([
      {
        kind: "update",
        ref,
        changes: [{ field: "price", value: { amountCents: 999, currency: "USD" } }],
        citation: PUBLISHER_PAGE,
      },
    ]);
    // ...and rewrites it again before the second proposal is submitted.
    await edit(t, b.releaseId, [{ field: "description", value: `${NEW_TEXT} Revised.` }], ANOTHER);
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId: withFact }),
    ).rejects.toMatchObject({ data: { code: "stale" } });

    // Rebase: the source-only proposal has nothing left, the other keeps its fact alone.
    await expect(
      asEditor.mutation(api.proposals.rebaseProposal, { proposalId: sourceOnly }),
    ).rejects.toMatchObject({ data: { code: "emptyRebase" } });
    const { dropped } = await asEditor.mutation(api.proposals.rebaseProposal, {
      proposalId: withFact,
    });
    expect(dropped).toEqual(["release text changed since its source was chosen"]);
    const rebased = (await t.run((ctx) => ctx.db.get(withFact)))?.draft?.ops[0];
    expect(rebased).toMatchObject({ changes: [{ field: "price" }] });
    expect(rebased).not.toHaveProperty("citation");
    await asEditor.mutation(api.proposals.submitProposal, { proposalId: withFact });
    await asMod.mutation(api.proposals.approveProposal, { proposalId: withFact });
    expect(await editionCredit(t)).toMatchObject({
      text: `${NEW_TEXT} Revised.`,
      attribution: ANOTHER,
    });
  });

  it("refuses to submit or approve a source for text that changed without a Revision", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const ref = { type: "release" as const, id: b.releaseId };
    const draft = async () =>
      (
        await asEditor.mutation(api.proposals.saveDraft, {
          ops: [{ kind: "update", ref, changes: [], citation: PUBLISHER_PAGE }],
          evidence: [],
          comment: "The back cover says it.",
        })
      ).proposalId;
    const rewrite = (text: string) =>
      t.run((ctx) => ctx.db.patch(b.releaseId, { description: text }));

    const unsubmitted = await draft();
    await rewrite("Other words.");
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId: unsubmitted }),
    ).rejects.toMatchObject({ data: { code: "stale" } });

    await rewrite(KODANSHA_TEXT);
    const submitted = await draft();
    await asEditor.mutation(api.proposals.submitProposal, { proposalId: submitted });
    await rewrite("Other words.");
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.proposals.approveProposal, {
        proposalId: submitted,
      }),
    ).rejects.toMatchObject({ data: { code: "stale" } });
  });
});

describe("owners on the public pages", () => {
  it("names the owner of inherited text and the Edition holding a Volume's cover", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const b = await book(t, KODANSHA_TEXT);
    await imported(t, b.releaseId);

    const volume = await t.query(api.catalogPages.volumePage, { publicId: 7002 });
    expect(volume?.description).toMatchObject({
      source: "edition",
      owner: { type: "release", key: b.releaseId },
      attribution: KODANSHA,
    });
    expect(volume?.coverEdition).toEqual({ publicId: 7003, title: expect.any(String) });

    const edition = await t.query(api.catalogPages.editionPage, { publicId: 7003 });
    expect(edition?.coverOwner).toMatchObject({ type: "release", key: b.releaseId, stored: false });
    expect(edition?.frontRelease).toMatchObject({ type: "release", key: b.releaseId });

    // An omnibus never borrows one Volume's synopsis: its text is the Series'.
    await t.run(async (ctx) => {
      await ctx.db.patch(b.releaseId, { description: undefined });
      const series = (await ctx.db.query("series").first())!;
      await ctx.db.patch(series._id, { synopsis: "The series." });
      const volume2 = await insertVolume(ctx, { seriesId: series._id, position: 2 });
      await ctx.db.patch(b.volumeId, { synopsis: "Volume one." });
      await insertCoverage(ctx, { editionId: b.editionId, volumeId: volume2, order: 2 });
    });
    expect(await editionCredit(t)).toMatchObject({
      source: "series",
      owner: { type: "series", key: "7001" },
    });
    const series = await t.query(api.catalog.seriesPage, { publicId: 7001 });
    expect(series?.series.synopsisAttribution).toBeNull();
    expect(series?.coverEdition?.publicId).toBe(7003);
  });

  it("credits a Bundle's description from its own History", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    const publicId = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Kodansha USA" });
      await insertBundle(ctx, { publisherId, publicId: 7100, description: "Box." });
      return 7100;
    });
    const bundleId = (await t.run((ctx) => ctx.db.query("releaseBundles").first()))!._id;
    await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
      ref: { type: "releaseBundle", id: bundleId },
      changes: [{ field: "description", value: "The box set." }],
      comment: "From the publisher.",
      citation: KODANSHA,
    });
    const page = await t.query(api.catalogPages.bundlePage, { publicId });
    expect(page?.bundle.attribution).toEqual(KODANSHA);
  });
});
