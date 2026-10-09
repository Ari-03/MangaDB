// Editor Proposals and the review queue (ticket #32, spec §5): the Draft →
// In Review → Approved/Rejected/Withdrawn lifecycle with Request Changes
// back to Draft, stale-base detection with explicit rebase, the filterable
// Data-Team queue with coordinating claims, atomic multi-record creation
// via temp-IDs, and the per-user rate limits + bulk caps.

import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { queueCreationProposal } from "./lib/pipeline";
import { MAX_OPS_PER_PROPOSAL } from "./lib/proposalCreates";
import {
  insertObservation,
  insertPublisher,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import {
  changesOf,
  ADMIN,
  EDITOR,
  MOD,
  PLAIN,
  alice,
  bob,
  carol,
  dave,
  makeT,
  seedTeam,
  type TestT,
  type TestUser,
  queueRows,
} from "./test.helpers";

/** A second Moderator, for the claims test. */
const beth = {
  subject: "user_mod2",
  username: "beth",
  role: "moderator",
} as const satisfies TestUser;

const setup = (t: TestT) => seedTeam(t, [alice, bob, beth, carol, dave]);

async function addSeries(t: TestT, overrides: Partial<{ title: string; publicId: number }> = {}) {
  return await t.run((ctx) => insertSeries(ctx, { publicId: 1, title: "Alpha", ...overrides }));
}

async function addPublisher(t: TestT) {
  return await t.run((ctx) => insertPublisher(ctx, { name: "Seven Seas" }));
}

/** The op renaming a Series. */
const titleOp = (seriesId: Id<"series">, title: string) => ({
  kind: "update" as const,
  ref: { type: "series" as const, id: seriesId },
  changes: [{ field: "title", value: title }],
});

/**
 * An importer's creation proposal through the real queue path, from a fresh
 * Seven Seas observation: coverage of `labels` (existing Volumes by ID, the
 * rest as temp-ID creates) and a physical Release.
 */
const queueImport = (
  t: TestT,
  seriesId: Id<"series">,
  sourceRecordId: string,
  labels: string[],
  release: { isbn13?: string } = {},
) =>
  t.run(async (ctx) => {
    const observationId = await insertObservation(ctx, {
      sourceKey: "sevenseas",
      sourceRecordId,
      snapshot: { url: `https://sevenseasentertainment.com/books/${sourceRecordId}` },
      lastSeenAt: 1,
    });
    return await queueCreationProposal(ctx, {
      sourceKey: "sevenseas",
      observation: (await ctx.db.get(observationId))!,
      seriesId,
      seriesTitle: "Alpha",
      labels,
      release: { format: "physical", publisherSlug: "seven-seas", ...release },
      comment: "Queued by the creation gate.",
      now: 1,
    });
  });

const URL_EVIDENCE = [{ kind: "url" as const, url: "https://publisher.example/announcement" }];

/** Draft + submit one title-update proposal as the Editor. */
async function submitTitleProposal(t: TestT, seriesId: Id<"series">, title = "Beta") {
  const asEditor = t.withIdentity({ subject: EDITOR });
  const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
    ops: [titleOp(seriesId, title)],
    evidence: URL_EVIDENCE,
    comment: "Official romanization per the publisher.",
  });
  await asEditor.mutation(api.proposals.submitProposal, { proposalId });
  return proposalId;
}

describe("proposals — authorization", () => {
  it("drafting needs a signed-in user; review needs a moderator", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const draftArgs = { ops: [titleOp(seriesId, "Beta")], evidence: [], comment: "Nope." };
    await expect(t.mutation(api.proposals.saveDraft, draftArgs)).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    // A reader drafts only Suggestions (suggestions.test.ts): no creations.
    await expect(
      t.withIdentity({ subject: PLAIN }).mutation(api.proposals.saveDraft, {
        ops: [{ kind: "create", table: "volumes", tempId: "v", fields: { seriesId, label: "2" } }],
        evidence: [],
        comment: "Nope.",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const proposalId = await submitTitleProposal(t, seriesId);
    for (const call of [
      () =>
        t.withIdentity({ subject: EDITOR }).mutation(api.proposals.approveProposal, { proposalId }),
      () =>
        t
          .withIdentity({ subject: EDITOR })
          .mutation(api.proposals.rejectProposal, { proposalId, note: "no" }),
      () =>
        t.withIdentity({ subject: EDITOR }).mutation(api.proposals.claimProposal, { proposalId }),
    ]) {
      await expect(call()).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    // The queue is Data-Team-visible — Editors included, plain users not.
    await expect(queueRows(t.withIdentity({ subject: PLAIN }), {})).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    const queue = await queueRows(t.withIdentity({ subject: EDITOR }), {});
    expect(queue).toHaveLength(1);
  });
});

describe("proposals — lifecycle", () => {
  it("Draft → In Review → Approved creates the public Revisions", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId);

    let proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal).toMatchObject({
      state: "inReview",
      currentVersionNo: 1,
      author: { kind: "user", roleAtAuthorship: "editor" },
    });
    expect(proposal?.draft).toBeUndefined();

    const result = await t
      .withIdentity({ subject: MOD })
      .mutation(api.proposals.approveProposal, { proposalId });
    expect(result.status).toBe("approved");

    proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal?.state).toBe("approved");
    expect(proposal?.decidedBy).toBeDefined();

    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.title).toBe("Beta");
    expect(series?.searchText).toBe("Beta");

    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      seq: 1,
      proposalId,
      comment: "Official romanization per the publisher.",
      changes: [{ field: "title", before: "Alpha", after: "Beta" }],
      author: { kind: "user", roleAtAuthorship: "editor" },
    });
    // Author (Editor) and approver (Moderator) are distinct people.
    const approver = await t.run((ctx) => ctx.db.get(revisions[0].approvedBy!));
    expect(approver?.username).toBe("bob");
  });

  it("submission validates: comment, evidence for factual changes", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const ops = [titleOp(seriesId, "Beta")];

    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops,
      evidence: [],
      comment: "",
    });
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "commentRequired" } });

    // A factual change (the title) without a source link is refused; a bare
    // free-text note is not source evidence.
    await asEditor.mutation(api.proposals.saveDraft, {
      proposalId,
      ops,
      evidence: [{ kind: "note", text: "trust me" }],
      comment: "Rename.",
    });
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "evidenceRequired" } });

    await asEditor.mutation(api.proposals.saveDraft, {
      proposalId,
      ops,
      evidence: URL_EVIDENCE,
      comment: "Rename.",
    });
    const { versionNo } = await asEditor.mutation(api.proposals.submitProposal, {
      proposalId,
    });
    expect(versionNo).toBe(1);
  });

  it("editorial-only changes need no source evidence", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const volumeId = await t.run((ctx) => insertVolume(ctx, { seriesId }));
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: { type: "volume", id: volumeId },
          changes: [{ field: "synopsis", value: "A quiet start." }],
        },
      ],
      evidence: [],
      comment: "Wrote a synopsis.",
    });
    const { versionNo } = await asEditor.mutation(api.proposals.submitProposal, {
      proposalId,
    });
    expect(versionNo).toBe(1);
  });

  it("drafting validates ops: unknown fields, locked records, duplicates, caps", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const asEditor = t.withIdentity({ subject: EDITOR });

    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "update",
            ref: { type: "series", id: seriesId },
            changes: [{ field: "publicId", value: 9 }],
          },
        ],
        evidence: [],
        comment: "Sneaky.",
      }),
    ).rejects.toMatchObject({ data: { code: "unknownField" } });

    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [titleOp(seriesId, "Beta"), titleOp(seriesId, "Beta")],
        evidence: [],
        comment: "Twice.",
      }),
    ).rejects.toMatchObject({ data: { code: "duplicateRecord" } });

    const hiddenId = await t.run((ctx) =>
      insertSeries(ctx, { status: "hidden", publicId: 2, title: "Hidden" }),
    );
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [titleOp(hiddenId, "Beta")],
        evidence: [],
        comment: "Hidden.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });

    // Bulk cap: more ops than the per-proposal maximum is refused outright.
    const tooMany = Array.from({ length: MAX_OPS_PER_PROPOSAL + 1 }, (_, i) => ({
      kind: "create" as const,
      table: "volumes",
      tempId: `volume-${i}`,
      fields: { seriesId: seriesId as string, label: String(i) },
    }));
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: tooMany,
        evidence: URL_EVIDENCE,
        comment: "Everything at once.",
      }),
    ).rejects.toMatchObject({ data: { code: "bulkCap" } });
  });

  it("Request Changes returns to Draft; resubmission is a new immutable version", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });

    await expect(
      asMod.mutation(api.proposals.requestChanges, { proposalId, note: "  " }),
    ).rejects.toMatchObject({ data: { code: "noteRequired" } });
    await asMod.mutation(api.proposals.requestChanges, {
      proposalId,
      note: "Use the cover romanization, not the website's.",
    });

    let proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal?.state).toBe("draft");
    expect(proposal?.draft?.ops).toHaveLength(1);

    // The author revises the draft and resubmits — version 2, immutable v1
    // untouched.
    await asEditor.mutation(api.proposals.saveDraft, {
      proposalId,
      ops: [titleOp(seriesId, "Beta (cover)")],
      evidence: URL_EVIDENCE,
      comment: "Cover romanization.",
    });
    const { versionNo } = await asEditor.mutation(api.proposals.submitProposal, {
      proposalId,
    });
    expect(versionNo).toBe(2);

    const versions = await t.run((ctx) =>
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .collect(),
    );
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.versionNo === 1)?.changeComment).toBe(
      "Official romanization per the publisher.",
    );

    proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal).toMatchObject({ state: "inReview", currentVersionNo: 2 });

    const result = await asMod.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("approved");
    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.title).toBe("Beta (cover)");
  });

  it("reject and withdraw are terminal; reviewers never edit versions", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });

    const rejected = await submitTitleProposal(t, seriesId, "Wrong");
    await expect(
      asMod.mutation(api.proposals.rejectProposal, { proposalId: rejected, note: "" }),
    ).rejects.toMatchObject({ data: { code: "noteRequired" } });
    await asMod.mutation(api.proposals.rejectProposal, {
      proposalId: rejected,
      note: "Contradicts the printed cover.",
    });
    expect((await t.run((ctx) => ctx.db.get(rejected)))?.state).toBe("rejected");
    await expect(
      asMod.mutation(api.proposals.approveProposal, { proposalId: rejected }),
    ).rejects.toMatchObject({ data: { code: "badState" } });

    const withdrawn = await submitTitleProposal(t, seriesId, "Other");
    // Only the author may withdraw.
    await expect(
      asMod.mutation(api.proposals.withdrawProposal, { proposalId: withdrawn }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await t
      .withIdentity({ subject: EDITOR })
      .mutation(api.proposals.withdrawProposal, { proposalId: withdrawn });
    expect((await t.run((ctx) => ctx.db.get(withdrawn)))?.state).toBe("withdrawn");

    // The record never changed.
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.title).toBe("Alpha");
  });
});

describe("proposals — stale-base detection and explicit rebase", () => {
  it("blocks approval when a base Revision moved; rebase + resubmit unblocks", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId, "Beta");
    const asMod = t.withIdentity({ subject: MOD });
    const asEditor = t.withIdentity({ subject: EDITOR });

    // A direct edit lands first: the proposal's base Revision is now stale.
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "altTitles", value: ["A-side"] }],
      comment: "Alt title from the colophon.",
    });

    const result = await asMod.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("stale");
    expect(result.stale).toEqual([{ type: "series", id: seriesId, reason: "baseChanged" }]);
    // No silent rebase: nothing applied, proposal flagged, still in review.
    const proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal).toMatchObject({ state: "inReview", stale: true });
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.title).toBe("Alpha");

    // The queue shows it stale.
    const queue = await queueRows(asMod, { staleOnly: true });
    expect(queue.map((row) => row.proposalId)).toEqual([proposalId]);

    // Explicit rebase (author only) returns it to Draft on the new base.
    await expect(
      asMod.mutation(api.proposals.rebaseProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    const { dropped } = await asEditor.mutation(api.proposals.rebaseProposal, {
      proposalId,
    });
    expect(dropped).toEqual([]);
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });

    const approved = await asMod.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(approved.status).toBe("approved");
    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.title).toBe("Beta");
    // The concurrent change survived the rebase.
    expect(series?.altTitles).toEqual(["A-side"]);
  });

  it("rebase drops changes the world already made and refuses empty results", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId, "Beta");
    const asMod = t.withIdentity({ subject: MOD });
    const asEditor = t.withIdentity({ subject: EDITOR });

    // Someone else applies the very same rename first.
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "Same fix, direct.",
    });

    await expect(
      asEditor.mutation(api.proposals.rebaseProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "emptyRebase" } });
  });

  it("blocks submission of a draft whose base moved since saving", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [titleOp(seriesId, "Beta")],
      evidence: URL_EVIDENCE,
      comment: "Rename.",
    });
    await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "altTitles", value: ["A-side"] }],
      comment: "Concurrent change.",
    });
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "stale" } });
  });

  it("flags an importer creation proposal stale when a reused Volume is merged away", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    await addPublisher(t);
    const asMod = t.withIdentity({ subject: MOD });
    const addVolume = () =>
      t.run((ctx) => insertVolume(ctx, { seriesId, label: "1", position: 1 }));
    // The importer's real path: coverage over the existing Volume 1 by ID,
    // a temp-ID create for the missing Volume 2.
    const queue = (sourceRecordId: string) => queueImport(t, seriesId, sourceRecordId, ["1", "2"]);

    const volumeId = await addVolume();
    const proposalId = await queue("alpha-omnibus");
    // A moderator merges Volume 1 into a duplicate row before review.
    const survivorId = await addVolume();
    await t.run((ctx) => ctx.db.patch(volumeId, { status: "merged", mergedIntoId: survivorId }));

    const result = await asMod.mutation(api.proposals.approveProposal, { proposalId });
    expect(result.status).toBe("stale");
    expect(result.stale).toEqual([{ type: "volume", id: volumeId, reason: "unavailable" }]);
    // Nothing applied, proposal flagged, still in review.
    expect(await t.run((ctx) => ctx.db.get(proposalId))).toMatchObject({
      state: "inReview",
      stale: true,
    });
    expect(await t.run((ctx) => ctx.db.query("editions").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("volumes").collect())).toHaveLength(2);

    // Re-queued from the next crawl, the proposal reuses the survivor and applies.
    const requeued = await queue("alpha-omnibus-2");
    const approved = await asMod.mutation(api.proposals.approveProposal, {
      proposalId: requeued,
    });
    expect(approved.status).toBe("approved");
    const volumes = await t.run((ctx) => ctx.db.query("volumes").collect());
    expect(volumes.filter((v) => v.status === "active").map((v) => v.label)).toEqual(["1", "2"]);
    const coverage = await t.run((ctx) => ctx.db.query("volumeCoverages").collect());
    expect(coverage.map((row) => row.volumeId)).toEqual([
      survivorId,
      volumes.find((v) => v.label === "2")!._id,
    ]);
  });
});

describe("proposals — temp-ID multi-record creation", () => {
  it("one proposal atomically creates volume + edition + coverage + release", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const publisherId = await addPublisher(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });

    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "create",
          table: "volumes",
          tempId: "volume-1",
          fields: { seriesId: seriesId as string, label: "1" },
        },
        {
          kind: "create",
          table: "editions",
          tempId: "edition",
          fields: {
            publisherId: publisherId as string,
            volumeCoverage: [{ volume: "volume-1", order: 1, extent: "complete" }],
          },
        },
        {
          kind: "create",
          table: "releases",
          tempId: "release",
          fields: {
            editionId: "edition",
            format: "physical",
            binding: "paperback",
            language: "en",
            isbn13: "978-1-99900-071-4",
            pubDate: { year: 2027, month: 3 },
          },
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "Volume 1 announced.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });

    const result = await asMod.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("unreachable");
    expect(result.created.map((c) => c.type)).toEqual(["volume", "edition", "release"]);

    const volumes = await t.run((ctx) => ctx.db.query("volumes").collect());
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({
      seriesId,
      position: 1,
      label: "1",
      status: "active",
    });
    expect(typeof volumes[0].publicId).toBe("number");

    const editions = await t.run((ctx) => ctx.db.query("editions").collect());
    expect(editions).toHaveLength(1);
    expect(editions[0].publisherId).toBe(publisherId);

    const coverage = await t.run((ctx) => ctx.db.query("volumeCoverages").collect());
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      editionId: editions[0]._id,
      volumeId: volumes[0]._id,
      order: 1,
      extent: "complete",
    });

    const releases = await t.run((ctx) => ctx.db.query("releases").collect());
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      editionId: editions[0]._id,
      format: "physical",
      binding: "paperback",
      isbn13: "9781999000714",
      pubDate: { year: 2027, month: 3, sort: 20270300 },
      // Denorms computed by the shared write path.
      publisherId,
      seriesIds: [seriesId],
    });

    // One creation Revision (seq 1) per created record, attributed to the
    // Editor and approved by the Moderator.
    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    expect(revisions).toHaveLength(3);
    for (const revision of revisions) {
      expect(revision.seq).toBe(1);
      expect(revision.proposalId).toBe(proposalId);
      expect(revision.author.kind).toBe("user");
      expect(revision.approvedBy).toBeDefined();
    }
  });

  it("rejects broken temp-ID graphs and enforces creation invariants", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const publisherId = await addPublisher(t);
    const asEditor = t.withIdentity({ subject: EDITOR });

    // Forward reference: the edition covers a volume declared later.
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "create",
            table: "editions",
            tempId: "edition",
            fields: {
              publisherId: publisherId as string,
              volumeCoverage: [{ volume: "volume-1", order: 1, extent: "complete" }],
            },
          },
          {
            kind: "create",
            table: "volumes",
            tempId: "volume-1",
            fields: { seriesId: seriesId as string },
          },
        ],
        evidence: URL_EVIDENCE,
        comment: "Backwards.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });

    // Digital releases cannot carry a binding (hard invariant).
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "create",
            table: "volumes",
            tempId: "volume-1",
            fields: { seriesId: seriesId as string },
          },
          {
            kind: "create",
            table: "editions",
            tempId: "edition",
            fields: {
              publisherId: publisherId as string,
              volumeCoverage: [{ volume: "volume-1", order: 1, extent: "complete" }],
            },
          },
          {
            kind: "create",
            table: "releases",
            tempId: "release",
            fields: {
              editionId: "edition",
              format: "digital",
              binding: "paperback",
              language: "en",
            },
          },
        ],
        evidence: URL_EVIDENCE,
        comment: "Digital hardcover?",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });

    // Unknown tables are never creatable.
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [{ kind: "create", table: "users", tempId: "u", fields: { username: "x" } }],
        evidence: URL_EVIDENCE,
        comment: "No.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
  });

  it("a new-series proposal needs its warning acknowledged, then creates it", async () => {
    const t = makeT();
    await setup(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "create",
          table: "series",
          tempId: "series",
          fields: { title: "Brand New", altTitles: ["BN"] },
        },
        {
          kind: "create",
          table: "volumes",
          tempId: "volume-1",
          fields: { seriesId: "series", label: "1" },
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "New license announced.",
    });

    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({
      data: { code: "warningsUnacknowledged", warnings: ["newSeries"] },
    });
    await asEditor.mutation(api.proposals.submitProposal, {
      proposalId,
      acknowledgeWarnings: ["newSeries"],
    });

    const result = await t
      .withIdentity({ subject: MOD })
      .mutation(api.proposals.approveProposal, { proposalId });
    expect(result.status).toBe("approved");
    const series = await t.run((ctx) => ctx.db.query("series").collect());
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      title: "Brand New",
      searchText: "Brand New BN bn brandnew",
    });
    const volumes = await t.run((ctx) => ctx.db.query("volumes").collect());
    expect(volumes[0]?.seriesId).toBe(series[0]._id);
  });

  it("approves an importer-queued creation proposal (source author)", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    await addPublisher(t);

    // Queued the way the importers do: publisher by slug, a temp-ID Volume
    // create for vol 2, a real series ID as a string.
    const proposalId = await queueImport(t, seriesId, "alpha-vol-2", ["2"], {
      isbn13: "9781999000721",
    });

    const asMod = t.withIdentity({ subject: MOD });
    const queue = await queueRows(asMod, {
      authorKind: "imports",
    });
    expect(queue.map((row) => row.proposalId)).toEqual([proposalId]);

    const result = await asMod.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("approved");
    const releases = await t.run((ctx) => ctx.db.query("releases").collect());
    expect(releases).toHaveLength(1);
    expect(releases[0].isbn13).toBe("9781999000721");
    // Import-authored, human-approved.
    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    expect(revisions.every((r) => r.author.kind === "source")).toBe(true);
    expect(revisions.every((r) => r.approvedBy !== undefined)).toBe(true);
  });
});

describe("proposals — the review queue", () => {
  it("filters by operation, record type, author, warnings, stale, and age", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    await addPublisher(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });

    const updateId = await submitTitleProposal(t, seriesId, "Beta");
    const { proposalId: createId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "create",
          table: "series",
          tempId: "series",
          fields: { title: "Brand New" },
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "New license.",
    });
    await asEditor.mutation(api.proposals.submitProposal, {
      proposalId: createId,
      acknowledgeWarnings: ["newSeries"],
    });

    const all = await queueRows(asMod, {});
    expect(all.map((row) => row.proposalId)).toEqual([updateId, createId]);

    const updates = await queueRows(asMod, {
      operation: "update",
    });
    expect(updates.map((row) => row.proposalId)).toEqual([updateId]);

    const seriesRows = await queueRows(asMod, {
      recordType: "series",
    });
    expect(seriesRows).toHaveLength(2);

    const byAuthor = await queueRows(asMod, {
      author: "carol",
    });
    expect(byAuthor).toHaveLength(2);
    expect(await queueRows(asMod, { author: "bob" })).toHaveLength(0);

    const warned = await queueRows(asMod, {
      warningsOnly: true,
    });
    expect(warned.map((row) => row.proposalId)).toEqual([createId]);

    expect(await queueRows(asMod, { staleOnly: true })).toHaveLength(0);
    expect(await queueRows(asMod, { minAgeHours: 1, now: Date.now() })).toHaveLength(0);
  });

  it("claims coordinate without exclusive authority", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId);
    const asMod = t.withIdentity({ subject: MOD });
    const asMod2 = t.withIdentity({ subject: beth.subject });

    await asMod.mutation(api.proposals.claimProposal, { proposalId });
    let queue = await queueRows(asMod, {});
    expect(queue[0].claimedBy).toBe("bob");

    // Another moderator can still decide — the claim is a signal, not a lock.
    const result = await asMod2.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("approved");
    queue = await queueRows(asMod, {});
    expect(queue).toHaveLength(0);
  });

  it("proposalDetail renders versions, evidence, notes, and viewer powers", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });

    await asMod.mutation(api.proposals.addNote, {
      proposalId,
      text: "Checked the publisher page — looks right.",
    });

    const detail = await asEditor.query(api.proposals.proposalDetail, {
      proposalId,
    });
    expect(detail).toMatchObject({
      state: "inReview",
      stale: false,
      author: { kind: "user", username: "carol", role: "editor" },
      viewer: { isAuthor: true, canReview: false },
    });
    expect(detail?.versions).toHaveLength(1);
    const version = changesOf(detail!.versions[0]);
    expect(version.ops[0]).toMatchObject({
      kind: "update",
      recordType: "series",
      recordTitle: "Alpha",
      stale: false,
      base: { seq: 0 },
      changes: [{ field: "title", before: "Alpha", after: "Beta" }],
    });
    expect(version.evidence[0]).toMatchObject({
      kind: "url",
      url: "https://publisher.example/announcement",
    });
    expect(detail?.notes).toHaveLength(1);
    expect(detail?.notes[0]).toMatchObject({ kind: "comment", author: "bob" });

    // Pending proposals are Data-Team-only in v1.
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.proposals.proposalDetail, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const mine = await asEditor.query(api.proposals.myProposals, {});
    expect(mine.map((row) => row.proposalId)).toEqual([proposalId]);
  });
});

describe("proposals — per-user rate limits", () => {
  it("caps burst submissions per user via the rate-limiter component", async () => {
    const t = makeT();
    await setup(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const seriesIds: Id<"series">[] = [];
    for (let i = 0; i < 6; i++) {
      seriesIds.push(await addSeries(t, { title: `S${i}`, publicId: i + 1 }));
    }

    // Submission capacity is 5; the sixth burst submission is refused.
    for (let i = 0; i < 5; i++) {
      await submitTitleProposal(t, seriesIds[i], `S${i} fixed`);
    }
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [titleOp(seriesIds[5], "S5 fixed")],
      evidence: URL_EVIDENCE,
      comment: "One too many.",
    });
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { kind: "RateLimited" } });

    // The limit is per user: the admin can still submit.
    const asAdmin = t.withIdentity({ subject: ADMIN });
    const { proposalId: adminDraft } = await asAdmin.mutation(api.proposals.saveDraft, {
      ops: [titleOp(seriesIds[5], "S5 fixed")],
      evidence: URL_EVIDENCE,
      comment: "Different user.",
    });
    await asAdmin.mutation(api.proposals.submitProposal, {
      proposalId: adminDraft,
    });
  });
});

describe("proposals — clearing a Human Override", () => {
  const SERIES = (id: Id<"series">) => ({ type: "series" as const, id });

  /**
   * "Alpha" imported from Seven Seas, then renamed "Beta" by the Moderator:
   * `title` is a Human Override on a human-written value.
   */
  async function overriddenTitle(t: TestT) {
    const seriesId = await addSeries(t);
    const { revisionId } = await t.run((ctx) =>
      insertSourceRevision(ctx, {
        ref: SERIES(seriesId),
        sourceKey: "sevenseas",
        changes: [{ field: "title", after: "Alpha" }],
      }),
    );
    await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
      ref: SERIES(seriesId),
      baseRevisionId: revisionId,
      changes: [{ field: "title", value: "Beta" }],
      comment: "The publisher renamed it.",
    });
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.overriddenFields).toEqual(["title"]);
    return seriesId;
  }

  const clearOp = (seriesId: Id<"series">, field = "title") => ({
    kind: "clearOverride" as const,
    ref: SERIES(seriesId),
    field,
  });

  const revisionsOf = (t: TestT, seriesId: Id<"series">) =>
    t.run((ctx) =>
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "series").eq("ref.id", seriesId))
        .collect(),
    );

  /** Draft and submit `ops` as the Editor; a clear needs a reason but no evidence. */
  async function submitAsEditor(
    t: TestT,
    ops: Array<ReturnType<typeof clearOp> | ReturnType<typeof titleOp>>,
  ) {
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops,
      evidence: [],
      comment: "The publisher's own page is right again; let imports weigh it.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    return proposalId;
  }

  it("an Editor's clear waits for review; approval lifts it with one Revision and keeps the value", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asMod = t.withIdentity({ subject: MOD });

    // Role gates: a reader cannot draft one, an Editor cannot clear directly.
    await expect(
      t.withIdentity({ subject: PLAIN }).mutation(api.proposals.saveDraft, {
        ops: [clearOp(seriesId)],
        evidence: [],
        comment: "No.",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    for (const subject of [PLAIN, EDITOR]) {
      await expect(
        t.withIdentity({ subject }).mutation(api.moderation.submitDirectClear, {
          ref: SERIES(seriesId),
          field: "title",
          comment: "No.",
        }),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }

    const before = await revisionsOf(t, seriesId);
    const proposalId = await submitAsEditor(t, [clearOp(seriesId)]);
    const version = await t.run(async (ctx) =>
      (await ctx.db.query("proposalVersions").collect()).find(
        (row) => row.proposalId === proposalId,
      ),
    );
    expect(version?.ops).toEqual([
      {
        kind: "clearOverride",
        ref: SERIES(seriesId),
        field: "title",
        baseRevisionId: before.at(-1)!._id,
      },
    ]);
    // In review, nothing has changed yet.
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.overriddenFields).toEqual(["title"]);
    const queue = await queueRows(asMod, { operation: "clearOverride" });
    expect(queue.map((row) => row.proposalId)).toEqual([proposalId]);
    const detail = await asMod.query(api.proposals.proposalDetail, { proposalId });
    expect(changesOf(detail?.versions[0]).ops).toEqual([
      {
        kind: "clearOverride",
        recordType: "series",
        recordId: seriesId,
        recordTitle: "Beta",
        field: "title",
        fieldLabel: "Title",
        kept: { value: "Beta", writtenBy: { kind: "human" } },
        base: { seq: 2, comment: "The publisher renamed it." },
        stale: false,
      },
    ]);

    // The Editor cannot approve their own.
    await expect(
      t.withIdentity({ subject: EDITOR }).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    expect(await asMod.mutation(api.proposals.approveProposal, { proposalId })).toMatchObject({
      status: "approved",
    });
    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.overriddenFields).toBeUndefined();
    expect(series?.title).toBe("Beta");
    const after = await revisionsOf(t, seriesId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      seq: 3,
      proposalId,
      author: { kind: "user", roleAtAuthorship: "editor" },
      changes: [{ field: "overriddenFields", before: ["title"], after: [] }],
      comment: "The publisher's own page is right again; let imports weigh it.",
    });
    // The clear touched no field, so the title's author is still the Moderator.
    const history = await t.query(api.moderation.recordHistory, { type: "series", publicId: 1 });
    expect(history?.overriddenFields).toEqual([]);
  });

  it("a Moderator's direct clear applies at once as an approved Proposal, against the base it saw", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asMod = t.withIdentity({ subject: MOD });
    const [first, latest] = await revisionsOf(t, seriesId);

    const args = {
      ref: SERIES(seriesId),
      field: "title",
      comment: "Imports may weigh the title again.",
    };
    await expect(
      asMod.mutation(api.moderation.submitDirectClear, { ...args, comment: " " }),
    ).rejects.toMatchObject({ data: { code: "commentRequired" } });
    await expect(
      asMod.mutation(api.moderation.submitDirectClear, { ...args, baseRevisionId: first!._id }),
    ).rejects.toMatchObject({ data: { code: "stale" } });
    expect(await revisionsOf(t, seriesId)).toHaveLength(2);

    const { proposalId, seq } = await asMod.mutation(api.moderation.submitDirectClear, {
      ...args,
      baseRevisionId: latest!._id,
    });
    expect(seq).toBe(3);
    const stored = await t.run(async (ctx) => ({
      proposal: await ctx.db.get(proposalId),
      versions: (await ctx.db.query("proposalVersions").collect()).filter(
        (row) => row.proposalId === proposalId,
      ),
      series: await ctx.db.get(seriesId),
    }));
    expect(stored.proposal).toMatchObject({ state: "approved", currentVersionNo: 1 });
    expect(stored.versions.map((row) => row.ops)).toEqual([
      [
        {
          kind: "clearOverride",
          ref: SERIES(seriesId),
          field: "title",
          baseRevisionId: latest!._id,
        },
      ],
    ]);
    expect(stored.series?.overriddenFields).toBeUndefined();
    expect(stored.series?.title).toBe("Beta");

    // Nothing is left to clear.
    await expect(
      asMod.mutation(api.moderation.submitDirectClear, { ...args, baseRevisionId: undefined }),
    ).rejects.toMatchObject({ data: { code: "notOverridden" } });
  });

  it("refuses a direct clear on a locked or hidden record", async () => {
    for (const operation of [api.sensitiveOps.lockRecord, api.sensitiveOps.hideRecord]) {
      const t = makeT();
      await setup(t);
      const seriesId = await overriddenTitle(t);
      const asMod = t.withIdentity({ subject: MOD });
      await asMod.mutation(operation, {
        ref: SERIES(seriesId),
        reason: "A dispute.",
        confirmImpact: true,
      });
      const revisions = await revisionsOf(t, seriesId);
      await expect(
        asMod.mutation(api.moderation.submitDirectClear, {
          ref: SERIES(seriesId),
          field: "title",
          baseRevisionId: revisions.at(-1)!._id,
          comment: "Imports may weigh the title again.",
        }),
      ).rejects.toMatchObject({ data: { code: "locked" } });
      expect((await t.run((ctx) => ctx.db.get(seriesId)))?.overriddenFields).toEqual(["title"]);
      expect(await revisionsOf(t, seriesId)).toEqual(revisions);
    }
  });

  it("refuses at draft a field that is not overridden or not editable, and a change to a field it clears", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const draft = (ops: Array<ReturnType<typeof clearOp> | ReturnType<typeof titleOp>>) =>
      asEditor.mutation(api.proposals.saveDraft, { ops, evidence: [], comment: "Clear it." });
    const proposals = () => t.run((ctx) => ctx.db.query("proposals").collect());
    const existing = await proposals();

    await expect(draft([clearOp(seriesId, "altTitles")])).rejects.toMatchObject({
      data: { code: "notOverridden" },
    });
    await expect(draft([clearOp(seriesId, "searchText")])).rejects.toMatchObject({
      data: { code: "unknownField" },
    });
    await expect(draft([clearOp(seriesId), clearOp(seriesId)])).rejects.toMatchObject({
      data: { code: "duplicateRecord" },
    });
    // A change to the title is itself a human correction of it.
    await expect(draft([titleOp(seriesId, "Gamma"), clearOp(seriesId)])).rejects.toMatchObject({
      data: { code: "clearsChangedField" },
    });
    expect(await proposals()).toEqual(existing);
  });

  it("refuses a clear made stale before approval, writing nothing", async () => {
    const reasons = {
      // A Moderator cleared it directly meanwhile.
      cleared: "baseChanged",
      // The list lost the field without a Revision (as data from before history might).
      unlisted: "notOverridden",
      locked: "unavailable",
      hidden: "unavailable",
    } as const;
    for (const [how, reason] of Object.entries(reasons)) {
      const t = makeT();
      await setup(t);
      const seriesId = await overriddenTitle(t);
      const asMod = t.withIdentity({ subject: MOD });
      const proposalId = await submitAsEditor(t, [clearOp(seriesId)]);

      const sensitive = { ref: SERIES(seriesId), reason: "A dispute.", confirmImpact: true };
      if (how === "cleared") {
        await asMod.mutation(api.moderation.submitDirectClear, {
          ref: SERIES(seriesId),
          field: "title",
          baseRevisionId: (await revisionsOf(t, seriesId)).at(-1)!._id,
          comment: "Cleared directly.",
        });
      } else if (how === "unlisted") {
        await t.run((ctx) => ctx.db.patch(seriesId, { overriddenFields: undefined }));
      } else if (how === "locked") {
        await asMod.mutation(api.sensitiveOps.lockRecord, sensitive);
      } else {
        await asMod.mutation(api.sensitiveOps.hideRecord, sensitive);
      }
      const series = await t.run((ctx) => ctx.db.get(seriesId));
      const revisions = await revisionsOf(t, seriesId);

      const result = await asMod.mutation(api.proposals.approveProposal, { proposalId });
      expect(result, how).toEqual({
        status: "stale",
        stale: [{ type: "series", id: seriesId, reason }],
      });
      expect(await t.run((ctx) => ctx.db.get(seriesId)), how).toEqual(series);
      expect(await revisionsOf(t, seriesId), how).toEqual(revisions);
      expect((await t.run((ctx) => ctx.db.get(proposalId)))?.state, how).toBe("inReview");

      // Rebase drops a clear with nothing left to clear or no editable record, and so refuses.
      await expect(
        t.withIdentity({ subject: EDITOR }).mutation(api.proposals.rebaseProposal, { proposalId }),
        how,
      ).rejects.toMatchObject({ data: { code: "emptyRebase" } });
    }
  });

  it("rebases a clear whose base moved onto the new base, and then applies it", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asMod = t.withIdentity({ subject: MOD });
    const asEditor = t.withIdentity({ subject: EDITOR });
    const proposalId = await submitAsEditor(t, [clearOp(seriesId)]);

    const { revisionId } = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: SERIES(seriesId),
      baseRevisionId: (await revisionsOf(t, seriesId)).at(-1)!._id,
      changes: [{ field: "altTitles", value: ["B-side"] }],
      comment: "Alt title from the colophon.",
    });
    expect((await asMod.mutation(api.proposals.approveProposal, { proposalId })).status).toBe(
      "stale",
    );

    expect(await asEditor.mutation(api.proposals.rebaseProposal, { proposalId })).toEqual({
      dropped: [],
    });
    const rebased = await t.run((ctx) => ctx.db.get(proposalId));
    expect(rebased?.draft?.ops).toEqual([
      { kind: "clearOverride", ref: SERIES(seriesId), field: "title", baseRevisionId: revisionId },
    ]);
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    expect((await asMod.mutation(api.proposals.approveProposal, { proposalId })).status).toBe(
      "approved",
    );
    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.overriddenFields).toBeUndefined();
    expect(series?.altTitles).toEqual(["B-side"]);
  });

  it("applies an update and a clear of the same record together, in op order", async () => {
    for (const updateFirst of [true, false]) {
      const t = makeT();
      await setup(t);
      const seriesId = await overriddenTitle(t);
      const altTitles = {
        kind: "update" as const,
        ref: SERIES(seriesId),
        changes: [{ field: "altTitles", value: ["B-side"] }],
      };
      const asEditor = t.withIdentity({ subject: EDITOR });
      const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
        ops: updateFirst ? [altTitles, clearOp(seriesId)] : [clearOp(seriesId), altTitles],
        evidence: URL_EVIDENCE,
        comment: "Alt title, and let imports weigh the title.",
      });
      await asEditor.mutation(api.proposals.submitProposal, { proposalId });
      const result = await t
        .withIdentity({ subject: MOD })
        .mutation(api.proposals.approveProposal, { proposalId });
      expect(result.status).toBe("approved");
      const series = await t.run((ctx) => ctx.db.get(seriesId));
      expect(series).toMatchObject({ altTitles: ["B-side"], title: "Beta" });
      expect(series?.overriddenFields).toBeUndefined();
      const applied = updateFirst
        ? [["altTitles"], ["overriddenFields"]]
        : [["overriddenFields"], ["altTitles"]];
      expect(
        (await revisionsOf(t, seriesId)).map((row) => row.changes.map((change) => change.field)),
      ).toEqual([["title"], ["title"], ...applied]);
    }
  });

  it("names a stale record once, and shows staleness and the kept value only while undecided", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asMod = t.withIdentity({ subject: MOD });
    const asEditor = t.withIdentity({ subject: EDITOR });
    const altTitles = {
      kind: "update" as const,
      ref: SERIES(seriesId),
      changes: [{ field: "altTitles", value: ["B-side"] }],
    };
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [altTitles, clearOp(seriesId)],
      evidence: URL_EVIDENCE,
      comment: "Alt title, and let imports weigh the title.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: SERIES(seriesId),
      baseRevisionId: (await revisionsOf(t, seriesId)).at(-1)!._id,
      changes: [{ field: "title", value: "Gamma" }],
      comment: "The publisher renamed it again.",
    });

    // Both ops anchor on the moved base; the record is named once.
    expect(await asMod.mutation(api.proposals.approveProposal, { proposalId })).toEqual({
      status: "stale",
      stale: [{ type: "series", id: seriesId, reason: "baseChanged" }],
    });
    const pending = await asMod.query(api.proposals.proposalDetail, { proposalId });
    expect(changesOf(pending?.versions[0]).ops).toMatchObject([
      { kind: "update", stale: true },
      {
        kind: "clearOverride",
        stale: true,
        kept: { value: "Gamma", writtenBy: { kind: "human" } },
      },
    ]);

    await asEditor.mutation(api.proposals.rebaseProposal, { proposalId });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    expect((await asMod.mutation(api.proposals.approveProposal, { proposalId })).status).toBe(
      "approved",
    );
    // Approval itself moved the base: no version of a decided Proposal is stale,
    // and the record's live value is not what the clear was reviewed against.
    const decided = await asMod.query(api.proposals.proposalDetail, { proposalId });
    expect(decided?.versions).toHaveLength(2);
    for (const version of decided!.versions) {
      expect(changesOf(version).ops).toMatchObject([
        { kind: "update", stale: false },
        { kind: "clearOverride", stale: false, kept: null },
      ]);
    }
  });

  it("applies a clear and an update of another record both or neither", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await overriddenTitle(t);
    const asMod = t.withIdentity({ subject: MOD });
    const { releaseId } = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Pub" });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 9,
        publisherId,
      });
      return {
        releaseId: await ctx.db.insert("releases", {
          status: "active",
          editionId,
          publisherId,
          seriesIds: [seriesId],
          format: "physical",
          language: "en",
        }),
      };
    });
    const bindingOp = {
      kind: "update" as const,
      ref: { type: "release" as const, id: releaseId },
      changes: [{ field: "binding", value: "hardcover" }],
    };
    const asEditor = t.withIdentity({ subject: EDITOR });
    const submit = async () => {
      const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
        ops: [clearOp(seriesId), bindingOp],
        evidence: URL_EVIDENCE,
        comment: "Binding per the publisher; imports may weigh the title.",
      });
      await asEditor.mutation(api.proposals.submitProposal, { proposalId });
      return proposalId;
    };

    // The Release turns out digital (a record from before history, so no
    // Revision moved): the binding fails validation after the clear applied,
    // and the whole approval rolls back.
    const doomed = await submit();
    await t.run((ctx) => ctx.db.patch(releaseId, { format: "digital" }));
    await expect(
      asMod.mutation(api.proposals.approveProposal, { proposalId: doomed }),
    ).rejects.toMatchObject({
      data: { code: "invalidField" },
    });
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.overriddenFields).toEqual(["title"]);
    expect(await revisionsOf(t, seriesId)).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(doomed)))?.state).toBe("inReview");
    await asEditor.mutation(api.proposals.withdrawProposal, { proposalId: doomed });

    await t.run((ctx) => ctx.db.patch(releaseId, { format: "physical" }));
    const proposalId = await submit();
    expect((await asMod.mutation(api.proposals.approveProposal, { proposalId })).status).toBe(
      "approved",
    );
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.overriddenFields).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(releaseId)))?.binding).toBe("hardcover");
  });
});
