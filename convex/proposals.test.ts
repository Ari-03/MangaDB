// Editor Proposals and the review queue (ticket #32, spec §5): the Draft →
// In Review → Approved/Rejected/Withdrawn lifecycle with Request Changes
// back to Draft, stale-base detection with explicit rebase, the filterable
// Data-Team queue with coordinating claims, atomic multi-record creation
// via temp-IDs, and the per-user rate limits + bulk caps.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api } from "./_generated/api";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MAX_OPS_PER_PROPOSAL } from "./proposals";

const ADMIN = "user_admin";
const MOD = "user_mod";
const MOD2 = "user_mod2";
const EDITOR = "user_editor";
const PLAIN = "user_plain";

function makeT() {
  const t = convexTest(schema);
  // The rate-limiter component (convex.config.ts) backs the proposal rate
  // limits; tests register its schema + implementation.
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
    .withIdentity({ subject: MOD2 })
    .mutation(api.users.claimUsername, { username: "beth" });
  await t
    .withIdentity({ subject: EDITOR })
    .mutation(api.users.claimUsername, { username: "carol" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  const asAdmin = t.withIdentity({ subject: ADMIN });
  await asAdmin.mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  await asAdmin.mutation(api.roles.appoint, { username: "beth", role: "moderator" });
  await asAdmin.mutation(api.roles.appoint, { username: "carol", role: "editor" });
}

async function addSeries(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{ title: string; publicId: number }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("series", {
      status: "active",
      publicId: overrides.publicId ?? 1,
      title: overrides.title ?? "Alpha",
      altTitles: [],
      searchText: overrides.title ?? "Alpha",
    }),
  );
}

async function addPublisher(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) =>
    ctx.db.insert("publishers", {
      status: "active",
      name: "Seven Seas",
      slug: "seven-seas",
    }),
  );
}

const URL_EVIDENCE = [
  { kind: "url" as const, url: "https://publisher.example/announcement" },
];

/** Draft + submit one title-update proposal as the Editor. */
async function submitTitleProposal(
  t: ReturnType<typeof convexTest>,
  seriesId: Id<"series">,
  title = "Beta",
) {
  const asEditor = t.withIdentity({ subject: EDITOR });
  const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
    ops: [
      {
        kind: "update",
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: title }],
      },
    ],
    evidence: URL_EVIDENCE,
    comment: "Official romanization per the publisher.",
  });
  await asEditor.mutation(api.proposals.submitProposal, { proposalId });
  return proposalId;
}

describe("proposals — authorization", () => {
  it("drafting needs a data-team role; review needs a moderator", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const draftArgs = {
      ops: [
        {
          kind: "update" as const,
          ref: { type: "series" as const, id: seriesId },
          changes: [{ field: "title", value: "Beta" }],
        },
      ],
      evidence: [],
      comment: "Nope.",
    };
    await expect(t.mutation(api.proposals.saveDraft, draftArgs)).rejects.toThrow(
      ConvexError,
    );
    await expect(
      t.withIdentity({ subject: PLAIN }).mutation(api.proposals.saveDraft, draftArgs),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const proposalId = await submitTitleProposal(t, seriesId);
    for (const call of [
      () =>
        t
          .withIdentity({ subject: EDITOR })
          .mutation(api.proposals.approveProposal, { proposalId }),
      () =>
        t
          .withIdentity({ subject: EDITOR })
          .mutation(api.proposals.rejectProposal, { proposalId, note: "no" }),
      () =>
        t
          .withIdentity({ subject: EDITOR })
          .mutation(api.proposals.claimProposal, { proposalId }),
    ]) {
      await expect(call()).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    // The queue is Data-Team-visible — Editors included, plain users not.
    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.proposals.reviewQueue, {}),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    const queue = await t
      .withIdentity({ subject: EDITOR })
      .query(api.proposals.reviewQueue, {});
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
    const ops = [
      {
        kind: "update" as const,
        ref: { type: "series" as const, id: seriesId },
        changes: [{ field: "title", value: "Beta" }],
      },
    ];

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
    const volumeId = await t.run((ctx) =>
      ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 1,
        label: "1",
      }),
    );
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
    const change = { field: "title", value: "Beta" };

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
        ops: [
          { kind: "update", ref: { type: "series", id: seriesId }, changes: [change] },
          { kind: "update", ref: { type: "series", id: seriesId }, changes: [change] },
        ],
        evidence: [],
        comment: "Twice.",
      }),
    ).rejects.toMatchObject({ data: { code: "duplicateRecord" } });

    const hiddenId = await t.run((ctx) =>
      ctx.db.insert("series", {
        status: "hidden",
        publicId: 2,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      }),
    );
    await expect(
      asEditor.mutation(api.proposals.saveDraft, {
        ops: [
          { kind: "update", ref: { type: "series", id: hiddenId }, changes: [change] },
        ],
        evidence: [],
        comment: "Hidden.",
      }),
    ).rejects.toMatchObject({ data: { code: "locked" } });

    // Bulk cap: more ops than the per-proposal maximum is refused outright.
    const publisherId = await addPublisher(t);
    void publisherId;
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
      ops: [
        {
          kind: "update",
          ref: { type: "series", id: seriesId },
          changes: [{ field: "title", value: "Beta (cover)" }],
        },
      ],
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
    expect(result.stale).toEqual([
      { type: "series", id: seriesId, reason: "baseChanged" },
    ]);
    // No silent rebase: nothing applied, proposal flagged, still in review.
    const proposal = await t.run((ctx) => ctx.db.get(proposalId));
    expect(proposal).toMatchObject({ state: "inReview", stale: true });
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.title).toBe("Alpha");

    // The queue shows it stale.
    const queue = await asMod.query(api.proposals.reviewQueue, { staleOnly: true });
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
      ops: [
        {
          kind: "update",
          ref: { type: "series", id: seriesId },
          changes: [{ field: "title", value: "Beta" }],
        },
      ],
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
    expect(result.created.map((c) => c.type)).toEqual([
      "volume",
      "edition",
      "release",
    ]);

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
        ops: [
          { kind: "create", table: "users", tempId: "u", fields: { username: "x" } },
        ],
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
      searchText: "Brand New BN",
    });
    const volumes = await t.run((ctx) => ctx.db.query("volumes").collect());
    expect(volumes[0]?.seriesId).toBe(series[0]._id);
  });

  it("approves an importer-queued creation proposal (source author)", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    await addPublisher(t);

    // The shape sevenSeas.ts queueCreationProposal writes: publisher by
    // slug, coverage rows keyed `volume`, a real series ID as a string.
    const proposalId = await t.run(async (ctx) => {
      const observationId = await ctx.db.insert("sourceObservations", {
        sourceKey: "sevenseas",
        sourceRecordId: "alpha-vol-2",
        snapshot: { url: "https://sevenseasentertainment.com/books/alpha-2" },
        lastSeenAt: Date.now(),
        withdrawn: false,
      });
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "sevenseas" },
        state: "inReview",
        currentVersionNo: 1,
        submittedAt: Date.now(),
      });
      await ctx.db.insert("proposalVersions", {
        proposalId,
        versionNo: 1,
        ops: [
          {
            kind: "create",
            table: "volumes",
            tempId: "volume-1",
            fields: { seriesId: seriesId as string, label: "2" },
          },
          {
            kind: "create",
            table: "editions",
            tempId: "edition",
            fields: {
              publisherSlug: "seven-seas",
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
              language: "en",
              isbn13: "9781999000721",
            },
          },
        ],
        evidence: [{ kind: "observation", observationId }],
        changeComment: 'Multi-volume coverage "Alpha Vol. 2" — creation gate.',
      });
      return proposalId;
    });

    const asMod = t.withIdentity({ subject: MOD });
    const queue = await asMod.query(api.proposals.reviewQueue, {
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
    const { proposalId: createId } = await asEditor.mutation(
      api.proposals.saveDraft,
      {
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
      },
    );
    await asEditor.mutation(api.proposals.submitProposal, {
      proposalId: createId,
      acknowledgeWarnings: ["newSeries"],
    });

    const all = await asMod.query(api.proposals.reviewQueue, {});
    expect(all.map((row) => row.proposalId)).toEqual([updateId, createId]);

    const updates = await asMod.query(api.proposals.reviewQueue, {
      operation: "update",
    });
    expect(updates.map((row) => row.proposalId)).toEqual([updateId]);

    const seriesRows = await asMod.query(api.proposals.reviewQueue, {
      recordType: "series",
    });
    expect(seriesRows).toHaveLength(2);

    const byAuthor = await asMod.query(api.proposals.reviewQueue, {
      author: "carol",
    });
    expect(byAuthor).toHaveLength(2);
    expect(
      await asMod.query(api.proposals.reviewQueue, { author: "bob" }),
    ).toHaveLength(0);

    const warned = await asMod.query(api.proposals.reviewQueue, {
      warningsOnly: true,
    });
    expect(warned.map((row) => row.proposalId)).toEqual([createId]);

    expect(
      await asMod.query(api.proposals.reviewQueue, { staleOnly: true }),
    ).toHaveLength(0);
    expect(
      await asMod.query(api.proposals.reviewQueue, { minAgeHours: 1 }),
    ).toHaveLength(0);
  });

  it("claims coordinate without exclusive authority", async () => {
    const t = makeT();
    await setup(t);
    const seriesId = await addSeries(t);
    const proposalId = await submitTitleProposal(t, seriesId);
    const asMod = t.withIdentity({ subject: MOD });
    const asMod2 = t.withIdentity({ subject: MOD2 });

    await asMod.mutation(api.proposals.claimProposal, { proposalId });
    let queue = await asMod.query(api.proposals.reviewQueue, {});
    expect(queue[0].claimedBy).toBe("bob");

    // Another moderator can still decide — the claim is a signal, not a lock.
    const result = await asMod2.mutation(api.proposals.approveProposal, {
      proposalId,
    });
    expect(result.status).toBe("approved");
    queue = await asMod.query(api.proposals.reviewQueue, {});
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
    const version = detail!.versions[0];
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
      t
        .withIdentity({ subject: PLAIN })
        .query(api.proposals.proposalDetail, { proposalId }),
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
      ops: [
        {
          kind: "update",
          ref: { type: "series", id: seriesIds[5] },
          changes: [{ field: "title", value: "S5 fixed" }],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "One too many.",
    });
    await expect(
      asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { kind: "RateLimited" } });

    // The limit is per user: the admin can still submit.
    const asAdmin = t.withIdentity({ subject: ADMIN });
    const { proposalId: adminDraft } = await asAdmin.mutation(
      api.proposals.saveDraft,
      {
        ops: [
          {
            kind: "update",
            ref: { type: "series", id: seriesIds[5] },
            changes: [{ field: "title", value: "S5 fixed" }],
          },
        ],
        evidence: URL_EVIDENCE,
        comment: "Different user.",
      },
    );
    await asAdmin.mutation(api.proposals.submitProposal, {
      proposalId: adminDraft,
    });
  });
});
