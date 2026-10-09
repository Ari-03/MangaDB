// Suggestions: any signed-in reader proposes field changes to existing
// records, covers included, through the same Proposal write path as the
// Data Team (proposals.ts), under the reader gate, their own rate limits
// and an open-suggestion cap. A reader reads only their own Proposals
// (suggestions.ts), with the reviewers' decisions but never the internal
// discussion. Approval stays the Moderator's.

import type { FunctionArgs } from "convex/server";
import { describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { READER_UPLOADS_PER_DAY } from "./coverUploads";
import { MAX_OPEN_SUGGESTIONS, MAX_SUGGESTION_OPS, NOT_PUBLIC } from "./proposals";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import {
  EDITOR,
  MOD,
  PLAIN,
  READER,
  alice,
  bob,
  carol,
  dave,
  makeT,
  pinCoverHistory,
  queueRows,
  reader,
  seedTeam,
  type TestT,
} from "./test.helpers";

// convex-test serves HTTP actions at this origin (t.fetch).
vi.stubEnv("CONVEX_SITE_URL", "https://some.convex.site");

const URL_EVIDENCE = [{ kind: "url" as const, url: "https://publisher.example/alpha-1" }];

/** The cast (dave and reader hold no role), and Alpha's one-volume book whose date an import wrote. */
async function setup(t: TestT) {
  await seedTeam(t, [alice, bob, carol, dave, reader]);
  await pinCoverHistory(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha USA" });
    const seriesId = await insertSeries(ctx, { publicId: 1, title: "Alpha" });
    const volumeId = await insertVolume(ctx, { seriesId });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781632364210",
      pubDate: { year: 2024, month: 3, sort: 20240300 },
    });
    await insertSourceRevision(ctx, {
      ref: { type: "release", id: releaseId },
      sourceKey: "kodansha",
      changes: [{ field: "pubDate", after: { year: 2024, month: 3, sort: 20240300 } }],
    });
    return { seriesId, volumeId, editionId, releaseId };
  });
}

/** The id of the User signed in as `subject`. */
async function userIdOf(t: TestT, subject: string) {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", subject))
      .unique();
    return user!._id;
  });
}

const release = (releaseId: Id<"releases">) => ({ type: "release" as const, id: releaseId });
const series = (seriesId: Id<"series">) => ({ type: "series" as const, id: seriesId });
const titleOp = (seriesId: Id<"series">, title: string) => ({
  kind: "update" as const,
  ref: series(seriesId),
  changes: [{ field: "title", value: title }],
});

/** Upload a cover as `subject` through the real upload URL; the stored blob. */
async function upload(t: TestT, subject: string) {
  const as = t.withIdentity({ subject });
  const { uploadId, url } = await as.mutation(api.coverUploads.uploadUrl, {});
  const { pathname, search } = new URL(url);
  const response = await t.fetch(`${pathname}${search}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: new Blob([new Uint8Array(4096)], { type: "image/jpeg" }),
  });
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  // convex-test records no content type; production takes it from the upload.
  await t.run((ctx) => ctx.db.patch(storageId as never, { contentType: "image/jpeg" } as never));
  expect(await as.mutation(api.coverUploads.uploaded, { uploadId, storageId })).toMatchObject({
    ok: true,
  });
  return storageId;
}

/** Draft and submit a Series retitle as `subject`. */
async function suggestTitle(t: TestT, subject: string, seriesId: Id<"series">, title = "Beta") {
  const as = t.withIdentity({ subject });
  const { proposalId } = await as.mutation(api.proposals.saveDraft, {
    ops: [titleOp(seriesId, title)],
    evidence: URL_EVIDENCE,
    comment: "The publisher's spelling.",
  });
  await as.mutation(api.proposals.submitProposal, { proposalId });
  return proposalId;
}

describe("suggestions — drafting and approval", () => {
  it("a reader drafts and submits a field change with a cover, and approval applies it as a Human Override", async () => {
    const t = makeT();
    const { releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    const cover = await upload(t, PLAIN);

    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: release(releaseId),
          changes: [
            { field: "pubDate", value: { year: 2024, month: 4, day: 9 } },
            { field: "coverImage", value: { storageId: cover, attribution: "my copy" } },
          ],
        },
      ],
      evidence: [],
      comment: "The jacket and date of my copy.",
    });
    // A date is a fact: it needs a source.
    await expect(
      asReader.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "evidenceRequired" } });
    await asReader.mutation(api.proposals.saveDraft, {
      proposalId,
      ops: [
        {
          kind: "update",
          ref: release(releaseId),
          changes: [
            { field: "pubDate", value: { year: 2024, month: 4, day: 9 } },
            { field: "coverImage", value: { storageId: cover, attribution: "my copy" } },
          ],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "The jacket and date of my copy.",
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId });

    // It waits in the Moderators' queue as a reader's Suggestion.
    const asMod = t.withIdentity({ subject: MOD });
    const [row] = await queueRows(asMod, { kind: "suggestion" });
    expect(row).toMatchObject({
      proposalId,
      kind: "suggestion",
      author: { kind: "user", username: "dave", role: null },
    });

    // An Editor cannot approve it; a Moderator can, through the usual path.
    await expect(
      t.withIdentity({ subject: EDITOR }).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await asMod.mutation(api.proposals.approveProposal, { proposalId })).toMatchObject({
      status: "approved",
    });
    const after = await t.run((ctx) => ctx.db.get(releaseId));
    expect(after?.pubDate).toMatchObject({ year: 2024, month: 4, day: 9 });
    expect(after?.coverImage).toMatchObject({ storageId: cover, attribution: "my copy" });
    // The import wrote the date and nobody wrote the art: both are now
    // human corrections no import replaces.
    expect(after?.overriddenFields).toEqual(expect.arrayContaining(["pubDate", "coverImage"]));
    const revision = await t.run((ctx) =>
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
        .order("desc")
        .first(),
    );
    expect(revision?.author).toMatchObject({ kind: "user" });
    expect(revision?.author).not.toHaveProperty("roleAtAuthorship");
  });

  it("refuses a reader's creations, override clears and more than the op cap", async () => {
    const t = makeT();
    const { seriesId, releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    const draft = (ops: FunctionArgs<typeof api.proposals.saveDraft>["ops"]) =>
      asReader.mutation(api.proposals.saveDraft, { ops, evidence: URL_EVIDENCE, comment: "Hm." });

    await expect(
      draft([{ kind: "create", table: "volumes", tempId: "v", fields: { seriesId, label: "2" } }]),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await t.run((ctx) => ctx.db.patch(releaseId, { overriddenFields: ["pubDate"] }));
    await expect(
      draft([{ kind: "clearOverride", ref: release(releaseId), field: "pubDate" }]),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      draft(Array.from({ length: MAX_SUGGESTION_OPS + 1 }, () => titleOp(seriesId, "Beta"))),
    ).rejects.toMatchObject({ data: { code: "bulkCap" } });
    // Fields outside the registry stay refused, as for anyone.
    await expect(
      draft([
        { kind: "update", ref: series(seriesId), changes: [{ field: "status", value: "hidden" }] },
      ]),
    ).rejects.toMatchObject({ data: { code: "unknownField" } });

    // A Draft that is not a Suggestion (written while its author was on
    // the Data Team) goes no further: neither submitted nor rebased.
    const proposalId = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", PLAIN))
        .unique();
      return await ctx.db.insert("proposals", {
        author: { kind: "user", userId: user!._id, roleAtAuthorship: "editor" },
        state: "draft",
        currentVersionNo: 0,
        draft: {
          ops: [
            { kind: "create", table: "volumes", tempId: "v", fields: { seriesId, label: "2" } },
          ],
          evidence: URL_EVIDENCE,
          comment: "From my Editor days.",
        },
      });
    });
    for (const call of [api.proposals.submitProposal, api.proposals.rebaseProposal]) {
      await expect(asReader.mutation(call, { proposalId })).rejects.toMatchObject({
        data: { code: "forbidden" },
      });
    }
    // Withdrawing it is the author's still.
    await asReader.mutation(api.proposals.withdrawProposal, { proposalId });
  });

  it("refuses signed-out, username-pending and suspended users", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const args = { ops: [titleOp(seriesId, "Beta")], evidence: URL_EVIDENCE, comment: "Hm." };
    await expect(t.mutation(api.proposals.saveDraft, args)).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await expect(t.mutation(api.coverUploads.uploadUrl, {})).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await expect(
      t.withIdentity({ subject: "user_new" }).mutation(api.proposals.saveDraft, args),
    ).rejects.toMatchObject({ data: { code: "usernameRequired" } });

    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", PLAIN))
        .unique();
      await ctx.db.patch(user!._id, { suspended: true });
    });
    const asSuspended = t.withIdentity({ subject: PLAIN });
    for (const call of [
      () => asSuspended.mutation(api.proposals.saveDraft, args),
      () => asSuspended.mutation(api.proposals.withdrawProposal, { proposalId }),
      () => asSuspended.mutation(api.coverUploads.uploadUrl, {}),
    ]) {
      await expect(call()).rejects.toMatchObject({ data: { code: "suspended" } });
    }
  });
});

describe("suggestions — limits", () => {
  it("caps a reader's open suggestions", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkSubject", (q) => q.eq("clerkSubject", PLAIN))
        .unique();
      for (let i = 0; i < MAX_OPEN_SUGGESTIONS; i++) {
        await ctx.db.insert("proposals", {
          author: { kind: "user", userId: user!._id },
          state: i % 2 === 0 ? "draft" : "inReview",
          currentVersionNo: 0,
        });
      }
    });
    const args = { ops: [titleOp(seriesId, "Beta")], evidence: URL_EVIDENCE, comment: "Hm." };
    await expect(
      t.withIdentity({ subject: PLAIN }).mutation(api.proposals.saveDraft, args),
    ).rejects.toMatchObject({ data: { code: "tooManyOpen" } });
    // Another reader, and the Data Team, are not held by it.
    await t.withIdentity({ subject: READER }).mutation(api.proposals.saveDraft, args);
  });

  it("gives readers their own, tighter submission bucket", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    for (const title of ["B", "C", "D"]) await suggestTitle(t, PLAIN, seriesId, title);
    await expect(suggestTitle(t, PLAIN, seriesId, "E")).rejects.toMatchObject({
      data: { kind: "RateLimited", name: "suggestionSubmit" },
    });
    // The Editor's bucket is untouched.
    await suggestTitle(t, EDITOR, seriesId, "F");
  });

  it("lets a reader start five cover uploads a day, the Data Team fifty", async () => {
    const t = makeT();
    await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    for (let i = 0; i < READER_UPLOADS_PER_DAY; i++) {
      await asReader.mutation(api.coverUploads.uploadUrl, {});
    }
    await expect(asReader.mutation(api.coverUploads.uploadUrl, {})).rejects.toMatchObject({
      data: { code: "rateLimited" },
    });
    const asEditor = t.withIdentity({ subject: EDITOR });
    for (let i = 0; i <= READER_UPLOADS_PER_DAY; i++) {
      await asEditor.mutation(api.coverUploads.uploadUrl, {});
    }
  });
});

describe("suggestions — reading and revising your own", () => {
  it("keeps every reader to their own proposals", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    const asOther = t.withIdentity({ subject: READER });

    expect(await asOther.query(api.suggestions.detail, { proposalId })).toBeNull();
    expect(await asOther.query(api.suggestions.mine, {})).toEqual([]);
    expect(await t.query(api.suggestions.mine, {})).toBeNull();
    for (const call of [
      api.proposals.withdrawProposal,
      api.proposals.submitProposal,
      api.proposals.rebaseProposal,
    ]) {
      await expect(asOther.mutation(call, { proposalId })).rejects.toMatchObject({
        data: { code: "forbidden" },
      });
    }
    await expect(
      asOther.mutation(api.proposals.saveDraft, {
        proposalId,
        ops: [titleOp(seriesId, "Gamma")],
        evidence: URL_EVIDENCE,
        comment: "Mine now.",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    // The queue, the Data Team's proposal page and notes stay theirs.
    for (const call of [
      () => queueRows(asOther, {}),
      () => asOther.query(api.proposals.proposalDetail, { proposalId }),
      () => asOther.query(api.proposals.myProposals, {}),
      () => asOther.mutation(api.proposals.addNote, { proposalId, text: "Hi" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ data: { code: "forbidden" } });
    }

    const mine = await t.withIdentity({ subject: PLAIN }).query(api.suggestions.mine, {});
    expect(mine).toMatchObject([
      {
        proposalId,
        state: "inReview",
        subject: { recordType: "series", title: "Alpha" },
        summary: { kind: "suggestion", fields: [{ field: "title", after: "Beta" }] },
        decision: null,
      },
    ]);
  });

  it("shows the reader why it was sent back, never the internal discussion, and takes the revision", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    const asMod = t.withIdentity({ subject: MOD });
    const asReader = t.withIdentity({ subject: PLAIN });
    await asMod.mutation(api.proposals.claimProposal, { proposalId });
    await asMod.mutation(api.proposals.addNote, { proposalId, text: "Internal: check ANN." });
    await asMod.mutation(api.proposals.requestChanges, {
      proposalId,
      note: "Use the title on the cover.",
    });

    const sentBack = await asReader.query(api.suggestions.detail, { proposalId });
    expect(sentBack).toMatchObject({
      state: "draft",
      decision: { kind: "requestChanges", text: "Use the title on the cover." },
      decisions: [{ kind: "requestChanges", text: "Use the title on the cover.", versionNo: 1 }],
      target: { type: "series", key: "1" },
      draft: { comment: "The publisher's spelling." },
      versions: [{ versionNo: 1, changeComment: "The publisher's spelling." }],
    });
    expect(JSON.stringify(sentBack)).not.toContain("Internal: check ANN.");
    expect(sentBack).not.toHaveProperty("claimedBy");
    expect(sentBack).not.toHaveProperty("notes");
    expect(sentBack).not.toHaveProperty("decidedBy");

    // The reader revises the Draft and resubmits it as version 2.
    await asReader.mutation(api.proposals.saveDraft, {
      proposalId,
      ops: [titleOp(seriesId, "Alpha!")],
      evidence: URL_EVIDENCE,
      comment: "As printed on the cover.",
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId });
    const resubmitted = await asReader.query(api.suggestions.detail, { proposalId });
    expect(resubmitted).toMatchObject({ state: "inReview", decision: null, target: null });
    expect(resubmitted?.versions.map((version) => version.versionNo)).toEqual([1, 2]);

    // Rejected, the reason is the reader's to read.
    await asMod.mutation(api.proposals.rejectProposal, { proposalId, note: "ANN disagrees." });
    const [row] = (await asReader.query(api.suggestions.mine, {})) ?? [];
    expect(row).toMatchObject({
      state: "rejected",
      decision: { kind: "reject", text: "ANN disagrees.", versionNo: 2 },
    });
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.decidedAt).toEqual(
      expect.any(Number),
    );
  });

  it("a reader withdraws their own Draft or In-Review suggestion", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    await t.withIdentity({ subject: PLAIN }).mutation(api.proposals.withdrawProposal, {
      proposalId,
    });
    expect(
      await t.withIdentity({ subject: PLAIN }).query(api.suggestions.detail, { proposalId }),
    ).toMatchObject({ state: "withdrawn" });
  });

  it("refuses to send a report back for changes", async () => {
    const t = makeT();
    await setup(t);
    const { proposalId } = await t
      .withIdentity({ subject: PLAIN })
      .mutation(api.reports.submit, { seriesPublicId: 1, message: "Volume 2 is missing." });
    await expect(
      t
        .withIdentity({ subject: MOD })
        .mutation(api.proposals.requestChanges, { proposalId, note: "Which one?" }),
    ).rejects.toMatchObject({ data: { code: "nothingToRevise" } });
    // Its author can read it and withdraw it.
    const asReader = t.withIdentity({ subject: PLAIN });
    expect(await asReader.query(api.suggestions.mine, {})).toMatchObject([
      { proposalId, state: "inReview", summary: { kind: "report" } },
    ]);
    await asReader.mutation(api.proposals.withdrawProposal, { proposalId });
  });
});

describe("suggestions — records the public catalog does not show", () => {
  it("names a record hidden after the suggestion without its live title, ISBN, art or before-values", async () => {
    const t = makeT();
    const { releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    const oldCover = await upload(t, EDITOR);
    await t.run((ctx) => ctx.db.patch(releaseId, { coverImage: { storageId: oldCover } }));
    const newCover = await upload(t, PLAIN);
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: release(releaseId),
          changes: [
            { field: "pubDate", value: { year: 2024, month: 4, day: 9 } },
            { field: "coverImage", value: { storageId: newCover, attribution: "my copy" } },
          ],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "As my copy prints it.",
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId });
    // While it is public, the reader reads it as the catalog shows it.
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.subject).toMatchObject({
      title: expect.stringContaining("Alpha"),
      isbn13: "9781632364210",
    });

    await t.run((ctx) => ctx.db.patch(releaseId, { status: "hidden" }));
    const detail = await asReader.query(api.suggestions.detail, { proposalId });
    expect(detail?.subject).toEqual({
      recordType: "release",
      title: NOT_PUBLIC,
      page: null,
      isbn13: null,
      coverUrl: null,
      mature: false,
    });
    expect(detail?.versions[0]?.ops[0]).toMatchObject({
      recordTitle: NOT_PUBLIC,
      withheld: true,
      changes: [
        { field: "pubDate", after: { year: 2024, month: 4, day: 9 } },
        { field: "coverImage", after: { storageId: newCover, attribution: "my copy" } },
      ],
      base: { comment: null },
    });
    // What the reader wrote stays theirs to read; nothing of the record now.
    const text = JSON.stringify(detail);
    for (const live of ["Alpha", "9781632364210", oldCover, '"before"', "Imported from"]) {
      expect(text).not.toContain(live);
    }
    expect(text).toContain(newCover);
    expect(text).toContain("As my copy prints it.");
    expect(text).toContain(URL_EVIDENCE[0]!.url);

    const [row] = (await asReader.query(api.suggestions.mine, {})) ?? [];
    expect(row).toMatchObject({ subject: { title: NOT_PUBLIC }, withheld: true });
    for (const live of ["Alpha", "9781632364210", '"before"']) {
      expect(JSON.stringify(row)).not.toContain(live);
    }

    // A merged record is not public as itself either.
    await t.run((ctx) => ctx.db.patch(releaseId, { status: "merged" }));
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.subject).toMatchObject({
      title: NOT_PUBLIC,
    });
    // The Data Team's proposal page still shows the record.
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    expect(team?.versions[0]?.ops[0]).toMatchObject({
      recordTitle: expect.stringContaining("Alpha"),
      withheld: false,
    });
  });

  it("holds the forms and the reader's suggestions to what the public pages show", async () => {
    const t = makeT();
    const { seriesId, volumeId, editionId, releaseId } = await setup(t);
    const volumeKey = String((await t.run((ctx) => ctx.db.get(volumeId)))!.publicId);
    const editionKey = String((await t.run((ctx) => ctx.db.get(editionId)))!.publicId);
    const asReader = t.withIdentity({ subject: PLAIN });
    const asEditor = t.withIdentity({ subject: EDITOR });
    const synopsisOp = {
      kind: "update" as const,
      ref: { type: "volume" as const, id: volumeId },
      changes: [{ field: "synopsis", value: "A reader's synopsis." }],
    };
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [synopsisOp],
      evidence: [],
      comment: "A better blurb.",
    });

    // Hiding the Series hides its Volume from the public site, which still
    // shows the Edition (its page drops the hidden coverage).
    await t.run((ctx) => ctx.db.patch(seriesId, { status: "hidden" }));
    expect(await t.query(api.catalogPages.volumePage, { publicId: Number(volumeKey) })).toBeNull();
    expect(
      await t.query(api.catalogPages.editionPage, { publicId: Number(editionKey) }),
    ).not.toBeNull();
    const volumeRef = { type: "volume" as const, id: volumeId as string };
    expect(await asReader.query(api.moderation.editForm, { type: "volume", key: volumeKey })).toBe(
      null,
    );
    expect(await asReader.query(api.moderation.sourceBlurbs, { ref: volumeRef })).toBeNull();
    expect(
      await asReader.query(api.moderation.editForm, { type: "edition", key: editionKey }),
    ).not.toBeNull();
    // The Data Team still edits it.
    expect(
      await asEditor.query(api.moderation.editForm, { type: "volume", key: volumeKey }),
    ).not.toBeNull();
    expect(await asEditor.query(api.moderation.sourceBlurbs, { ref: volumeRef })).not.toBeNull();

    // The reader's Draft on it names it no more, and goes no further.
    const detail = await asReader.query(api.suggestions.detail, { proposalId });
    expect(detail).toMatchObject({ subject: { title: NOT_PUBLIC, page: null }, target: null });
    expect(JSON.stringify(detail)).not.toContain("Alpha");
    expect(JSON.stringify(detail)).toContain("A reader's synopsis.");
    await expect(
      asReader.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "notFound" } });
    await expect(
      asReader.mutation(api.proposals.saveDraft, {
        ops: [synopsisOp],
        evidence: [],
        comment: "Again.",
      }),
    ).rejects.toMatchObject({ data: { code: "notFound" } });

    // A Release under a hidden Edition is gone from its page, and from the forms.
    await t.run((ctx) => ctx.db.patch(editionId, { status: "hidden" }));
    expect(await asReader.query(api.moderation.editForm, { type: "release", key: releaseId })).toBe(
      null,
    );
    expect(
      await asReader.query(api.moderation.sourceBlurbs, {
        ref: { type: "release", id: releaseId },
      }),
    ).toBeNull();
  });
});

describe("suggestions — only what the reader wrote as a reader", () => {
  it("leaves out what the viewer wrote on the Data Team, and offers the form only a whole Draft", async () => {
    const t = makeT();
    const { seriesId, releaseId } = await setup(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId: teamDraft } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [titleOp(seriesId, "Beta")],
      evidence: URL_EVIDENCE,
      comment: "An Editor's change.",
    });
    // A Suggestion they wrote before joining the Data Team stays theirs to read.
    const editorId = await userIdOf(t, EDITOR);
    const readerDraft = await t.run((ctx) =>
      ctx.db.insert("proposals", {
        author: { kind: "user", userId: editorId },
        state: "withdrawn",
        currentVersionNo: 0,
      }),
    );
    expect((await asEditor.query(api.suggestions.mine, {}))?.map((row) => row.proposalId)).toEqual([
      readerDraft,
    ]);
    expect(await asEditor.query(api.suggestions.detail, { proposalId: teamDraft })).toBeNull();
    expect(
      await asEditor.query(api.suggestions.detail, { proposalId: readerDraft }),
    ).not.toBeNull();

    // A reader's Draft of two changes is more than the suggest form shows.
    const asReader = t.withIdentity({ subject: PLAIN });
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        titleOp(seriesId, "Beta"),
        {
          kind: "update",
          ref: release(releaseId),
          changes: [{ field: "pubDate", value: { year: 2024, month: 4 } }],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "Two fixes.",
    });
    expect(await asReader.query(api.suggestions.detail, { proposalId })).toMatchObject({
      state: "draft",
      target: null,
    });
  });
});

describe("suggestions — long histories", () => {
  it("reads the current version and the standing decision however long the history", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    const modId = await userIdOf(t, MOD);
    // Fifty more rounds of review, and a long internal discussion.
    await t.run(async (ctx) => {
      const first = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique();
      for (let versionNo = 2; versionNo <= 51; versionNo++) {
        await ctx.db.insert("proposalVersions", {
          proposalId,
          versionNo,
          ops: first!.ops,
          evidence: first!.evidence,
          changeComment: `Round ${versionNo}.`,
        });
      }
      await ctx.db.patch(proposalId, { currentVersionNo: 51 });
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("proposalNotes", {
          proposalId,
          versionNo: 51,
          authorId: modId,
          kind: "comment",
          text: `Internal ${i}.`,
        });
      }
    });
    // The Series moves under version 51.
    await t.run((ctx) =>
      insertSourceRevision(ctx, {
        ref: series(seriesId),
        sourceKey: "kodansha",
        changes: [{ field: "title", after: "Alpha" }],
      }),
    );
    const asReader = t.withIdentity({ subject: PLAIN });
    const inReview = await asReader.query(api.suggestions.detail, { proposalId });
    // The newest 50 (VERSIONS_READ), so the current version among them.
    expect(inReview?.versions).toHaveLength(50);
    expect(inReview?.versions[0]?.versionNo).toBe(2);
    expect(inReview?.versions.at(-1)).toMatchObject({
      versionNo: 51,
      current: true,
      changeComment: "Round 51.",
      ops: [{ stale: true }],
    });
    expect(inReview?.stale).toBe(true);

    const asMod = t.withIdentity({ subject: MOD });
    await asMod.mutation(api.proposals.claimProposal, { proposalId });
    await asMod.mutation(api.proposals.rejectProposal, { proposalId, note: "ANN disagrees." });
    const decision = { kind: "reject", text: "ANN disagrees.", versionNo: 51 };
    expect(await asReader.query(api.suggestions.detail, { proposalId })).toMatchObject({
      decision,
      decisions: [decision],
    });
    expect(await asReader.query(api.suggestions.mine, {})).toMatchObject([{ decision }]);
  });

  it("reads a record's history once, not once per version", async () => {
    const t = makeT({ transactionLimits: { documentsRead: 2_000 } });
    const { releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: release(releaseId),
          changes: [{ field: "pubDate", value: { year: 2024, month: 4 } }],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "From the colophon.",
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId });
    // Forty-nine more versions, and a Release with 200 Revisions.
    await t.run(async (ctx) => {
      const first = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique();
      for (let versionNo = 2; versionNo <= 50; versionNo++) {
        await ctx.db.insert("proposalVersions", {
          proposalId,
          versionNo,
          ops: first!.ops,
          evidence: first!.evidence,
          changeComment: `Round ${versionNo}.`,
        });
      }
      await ctx.db.patch(proposalId, { currentVersionNo: 50 });
      const author = { kind: "source" as const, sourceKey: "kodansha" };
      const sourceProposal = await ctx.db.insert("proposals", {
        author,
        state: "approved",
        currentVersionNo: 1,
      });
      for (let seq = 2; seq <= 201; seq++) {
        await ctx.db.insert("revisions", {
          ref: release(releaseId),
          seq,
          proposalId: sourceProposal,
          author,
          changes: [{ field: "pubDate", after: { year: 2024, month: 3, sort: 20240300 } }],
          comment: `Imported from kodansha (${seq}).`,
        });
      }
    });
    const detail = await asReader.query(api.suggestions.detail, { proposalId });
    expect(detail?.versions).toHaveLength(50);
    expect(detail?.stale).toBe(true);
  });
});
