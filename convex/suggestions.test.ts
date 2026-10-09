// Suggestions: any signed-in reader proposes field changes to existing
// records, covers included, through the same Proposal write path as the
// Data Team (proposals.ts), under the reader gate, their own rate limits
// and an open-suggestion cap. A reader reads only their own Proposals
// (suggestions.ts), with the reviewers' decisions but never the internal
// discussion. Approval stays the Moderator's.

import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { READER_UPLOADS_PER_DAY } from "./coverUploads";
import {
  MAX_CHANGE_COMMENT,
  MAX_EVIDENCE_NOTE,
  MAX_EVIDENCE_ROWS,
  MAX_EVIDENCE_URL,
} from "./lib/evidence";
import { MAX_LIST_ENTRIES, MAX_TEXTAREA_LENGTH, MAX_TEXT_LENGTH } from "./lib/moderationFields";
import {
  MAX_OPEN_SUGGESTIONS,
  MAX_SUGGESTION_BYTES,
  MAX_SUGGESTION_OPS,
  NOT_PUBLIC,
  VERSIONS_SHOWN,
} from "./proposals";
import { MINE_MAX, WITHHELD_OP } from "./suggestions";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";
import {
  changesOf,
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

afterEach(() => {
  vi.useRealTimers();
});

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
    return { publisherId, seriesId, volumeId, editionId, releaseId };
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
    expect(changesOf(detail?.versions[0]).ops[0]).toMatchObject({
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
    expect(changesOf(team?.versions[0]).ops[0]).toMatchObject({
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
      content: { ops: [{ stale: true }] },
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
    const t = makeT({ transactionLimits: { documentsRead: 4_000 } });
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

/** Another, hidden Release of Alpha in an Edition of its own. */
async function insertHiddenRelease(t: TestT, ids: Awaited<ReturnType<typeof setup>>) {
  return await t.run(async (ctx) => {
    const editionId = await insertEdition(ctx, { publisherId: ids.publisherId });
    return await insertRelease(ctx, {
      editionId,
      publisherId: ids.publisherId,
      seriesIds: [ids.seriesId],
      status: "hidden",
    });
  });
}

/** Cover art as an import stores it: a blob no upload row claims. */
async function catalogArt(t: TestT) {
  const storageId = await upload(t, EDITOR);
  await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("coverUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  });
  return storageId;
}

const note = (text: string) => ({ kind: "note" as const, text });

describe("suggestions — what one change may carry", () => {
  it("bounds evidence, comments and values for everyone, and a reader's whole suggestion", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    type DraftArgs = FunctionArgs<typeof api.proposals.saveDraft>;
    const save = (subject: string, args: Partial<DraftArgs>) =>
      t.withIdentity({ subject }).mutation(api.proposals.saveDraft, {
        ops: [titleOp(seriesId, "Beta")],
        evidence: URL_EVIDENCE,
        comment: "The publisher's spelling.",
        ...args,
      });
    const refused = (code: string) => ({ data: { code } });
    for (const subject of [PLAIN, EDITOR]) {
      // The ~900 KB note that once filled the review queue.
      await expect(save(subject, { evidence: [note("x".repeat(900_000))] })).rejects.toMatchObject(
        refused("invalidEvidence"),
      );
      await expect(
        save(subject, { evidence: [note("x".repeat(MAX_EVIDENCE_NOTE + 1))] }),
      ).rejects.toMatchObject(refused("invalidEvidence"));
      await expect(
        save(subject, {
          evidence: Array.from({ length: MAX_EVIDENCE_ROWS + 1 }, (_, i) => note(`Source ${i}.`)),
        }),
      ).rejects.toMatchObject(refused("invalidEvidence"));
      await expect(
        save(subject, {
          evidence: [{ kind: "url", url: `https://a.example/${"x".repeat(MAX_EVIDENCE_URL)}` }],
        }),
      ).rejects.toMatchObject(refused("invalidEvidence"));
      await expect(
        save(subject, { comment: "x".repeat(MAX_CHANGE_COMMENT + 1) }),
      ).rejects.toMatchObject(refused("commentTooLong"));
      await expect(
        save(subject, { ops: [titleOp(seriesId, "x".repeat(MAX_TEXT_LENGTH + 1))] }),
      ).rejects.toMatchObject(refused("invalidField"));
      await expect(
        save(subject, {
          ops: [
            {
              kind: "update",
              ref: series(seriesId),
              changes: [{ field: "synopsis", value: "x".repeat(MAX_TEXTAREA_LENGTH + 1) }],
            },
          ],
        }),
      ).rejects.toMatchObject(refused("invalidField"));
      await expect(
        save(subject, {
          ops: [
            {
              kind: "update",
              ref: series(seriesId),
              changes: [
                {
                  field: "altTitles",
                  value: Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_, i) => `Alt ${i}`),
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject(refused("invalidField"));
    }

    // Repeated rows are stored once.
    const { proposalId } = await save(PLAIN, {
      evidence: [...URL_EVIDENCE, ...URL_EVIDENCE, note("Cover."), note("Cover.")],
    });
    expect((await t.run((ctx) => ctx.db.get(proposalId)))?.draft?.evidence).toEqual([
      ...URL_EVIDENCE,
      note("Cover."),
    ]);

    // Text a record already holds is never refused for its length.
    await t.run((ctx) => ctx.db.patch(seriesId, { synopsis: "s".repeat(MAX_TEXTAREA_LENGTH * 2) }));
    await save(EDITOR, {
      ops: [
        {
          kind: "update",
          ref: series(seriesId),
          changes: [
            { field: "title", value: "Beta" },
            { field: "synopsis", value: "s".repeat(MAX_TEXTAREA_LENGTH * 2) },
          ],
        },
      ],
    });

    // Each piece within bounds, a reader's whole suggestion over its size.
    const large: Partial<DraftArgs> = {
      ops: [
        {
          kind: "update",
          ref: series(seriesId),
          changes: [
            { field: "synopsis", value: "y".repeat(MAX_TEXTAREA_LENGTH) },
            {
              field: "altTitles",
              value: Array.from({ length: MAX_LIST_ENTRIES }, (_, i) =>
                `Alt ${i}`.padEnd(MAX_TEXT_LENGTH, "a"),
              ),
            },
          ],
        },
      ],
      evidence: Array.from({ length: MAX_EVIDENCE_ROWS }, (_, i) =>
        note(`Note ${i}`.padEnd(MAX_EVIDENCE_NOTE, "n")),
      ),
    };
    await expect(save(PLAIN, large)).rejects.toMatchObject(refused("tooLarge"));
    await save(EDITOR, large);
  });

  it("keeps the queue and a reader's Suggestions list readable at a Suggestion's largest", async () => {
    const t = makeT({ transactionLimits: true });
    const { seriesId } = await setup(t);
    const readerId = await userIdOf(t, PLAIN);
    // As many of the reader's rows as `mine` and a queue page read, each
    // as large as a Suggestion may be.
    const content = {
      ops: [
        {
          kind: "update" as const,
          ref: series(seriesId),
          changes: [{ field: "synopsis", after: "p".repeat(MAX_SUGGESTION_BYTES - 1_000) }],
        },
      ],
      evidence: [],
      comment: "Large.",
    };
    const states = [
      ["draft", 10],
      ["inReview", 25],
      ["withdrawn", MINE_MAX],
      ["rejected", MINE_MAX],
      ["approved", MINE_MAX],
    ] as const;
    for (const [state, count] of states) {
      await t.run(async (ctx) => {
        for (let i = 0; i < count; i++) {
          const submitted = state !== "draft" && state !== "withdrawn";
          const proposalId = await ctx.db.insert("proposals", {
            author: { kind: "user", userId: readerId },
            state,
            currentVersionNo: submitted ? 1 : 0,
            ...(submitted ? { submittedAt: i } : { draft: content }),
          });
          if (submitted) {
            await ctx.db.insert("proposalVersions", {
              proposalId,
              versionNo: 1,
              ops: content.ops,
              evidence: [],
              changeComment: content.comment,
            });
          }
        }
      });
    }
    // Every row is read whole, none cut short by the read budget.
    const mine = await t.withIdentity({ subject: PLAIN }).query(api.suggestions.mine, {});
    expect(mine).toHaveLength(MINE_MAX);
    expect(mine?.every((row) => !row.notLoaded)).toBe(true);
    const page = await t.withIdentity({ subject: MOD }).query(api.proposals.reviewQueuePage, {
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(page.page).toHaveLength(25);
    expect(page.page.every((row) => row.matches)).toBe(true);
  });

  it("reads each cited observation once, however many versions repeat it", async () => {
    const t = makeT({ transactionLimits: true });
    const { seriesId, releaseId } = await setup(t);
    const observationId = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "alpha-1",
        recordRef: release(releaseId),
        snapshot: { url: "https://kodansha.example/alpha-1" },
      }),
    );
    const proposalId = await suggestTitle(t, PLAIN, seriesId);
    // Two versions, each citing it 2,100 times, as rows stored before saving deduplicated them.
    await t.run(async (ctx) => {
      const evidence = Array.from({ length: 2_100 }, () => ({
        kind: "observation" as const,
        observationId,
      }));
      const first = await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique();
      await ctx.db.patch(first!._id, { evidence });
      await ctx.db.insert("proposalVersions", {
        proposalId,
        versionNo: 2,
        ops: first!.ops,
        evidence,
        changeComment: "Again.",
      });
      await ctx.db.patch(proposalId, { currentVersionNo: 2 });
    });
    const detail = await t
      .withIdentity({ subject: PLAIN })
      .query(api.suggestions.detail, { proposalId });
    expect(changesOf(detail?.versions[1]).evidence[0]).toMatchObject({
      sourceKey: "kodansha",
      url: "https://kodansha.example/alpha-1",
    });
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    expect(team?.versions).toHaveLength(2);
  });
});

describe("suggestions — sources and art only hidden records hold", () => {
  it("lets a reader cite only a source of a record the public catalog shows", async () => {
    const t = makeT();
    const ids = await setup(t);
    const hiddenId = await insertHiddenRelease(t, ids);
    const [publicSource, hiddenSource, heldSource] = await t.run(async (ctx) => [
      await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "alpha-1",
        recordRef: release(ids.releaseId),
        snapshot: { url: "https://kodansha.example/alpha-1" },
      }),
      await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "secret",
        recordRef: release(hiddenId),
        snapshot: { url: "https://kodansha.example/secret" },
      }),
      await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "held",
        snapshot: { url: "https://kodansha.example/held" },
      }),
    ]);
    const cite = (subject: string, observationId: Id<"sourceObservations">) =>
      t.withIdentity({ subject }).mutation(api.proposals.saveDraft, {
        ops: [titleOp(ids.seriesId, "Beta")],
        evidence: [{ kind: "observation", observationId }],
        comment: "As the source has it.",
      });
    for (const observationId of [hiddenSource, heldSource]) {
      await expect(cite(PLAIN, observationId)).rejects.toMatchObject({
        data: { code: "invalidEvidence" },
      });
      // The Data Team cites any source.
      await cite(EDITOR, observationId);
    }

    // Cited while public, then hidden: the reader no longer reads where it
    // came from, nor submits it; the Data Team still sees it.
    const { proposalId } = await cite(PLAIN, publicSource);
    const asReader = t.withIdentity({ subject: PLAIN });
    expect(
      changesOf((await asReader.query(api.suggestions.detail, { proposalId }))?.draft).evidence,
    ).toEqual([
      {
        kind: "observation",
        observationId: publicSource,
        sourceKey: "kodansha",
        url: "https://kodansha.example/alpha-1",
      },
    ]);
    await t.run((ctx) => ctx.db.patch(ids.releaseId, { status: "hidden" }));
    const detail = await asReader.query(api.suggestions.detail, { proposalId });
    expect(changesOf(detail?.draft).evidence).toEqual([
      { kind: "observation", observationId: publicSource, sourceKey: "(not public)", url: null },
    ]);
    expect(JSON.stringify(detail)).not.toContain("kodansha.example");
    await expect(
      asReader.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "invalidEvidence" } });
    const team = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    expect(changesOf(team?.draft).evidence[0]).toMatchObject({
      sourceKey: "kodansha",
      url: "https://kodansha.example/alpha-1",
    });
  });

  it("lets a reader reuse only art a record the public catalog shows holds, and shows them no other", async () => {
    const t = makeT();
    const ids = await setup(t);
    const hiddenId = await insertHiddenRelease(t, ids);
    const [hiddenArt, publicArt, historyArt] = [
      await catalogArt(t),
      await catalogArt(t),
      await catalogArt(t),
    ];
    // A public sibling shows `publicArt`; only the hidden Release shows
    // `hiddenArt`, and only its History names `historyArt`.
    const siblingId = await t.run(async (ctx) => {
      await ctx.db.patch(hiddenId, { coverImage: { storageId: hiddenArt } });
      const { revisionId } = await insertSourceRevision(ctx, {
        ref: release(hiddenId),
        sourceKey: "kodansha",
        changes: [{ field: "coverImage", after: { storageId: historyArt } }],
      });
      await ctx.db.insert("coverRefs", { storageId: historyArt, revisionId });
      return await insertRelease(ctx, {
        editionId: ids.editionId,
        publisherId: ids.publisherId,
        seriesIds: [ids.seriesId],
        format: "digital",
        coverImage: { storageId: publicArt },
      });
    });
    const coverOp = (storageId: Id<"_storage">) => ({
      kind: "update" as const,
      ref: release(ids.releaseId),
      changes: [{ field: "coverImage", value: { storageId } }],
    });
    const suggest = (subject: string, storageId: Id<"_storage">) =>
      t.withIdentity({ subject }).mutation(api.proposals.saveDraft, {
        ops: [coverOp(storageId)],
        evidence: [],
        comment: "The jacket.",
      });
    for (const storageId of [hiddenArt, historyArt]) {
      await expect(suggest(PLAIN, storageId)).rejects.toMatchObject({
        data: { code: "invalidField" },
      });
      await suggest(EDITOR, storageId);
    }

    // Reused while its sibling showed it, then the sibling is hidden: the
    // reader's page names the art but no longer draws it.
    const own = await upload(t, PLAIN);
    const { proposalId } = await suggest(PLAIN, publicArt);
    const asReader = t.withIdentity({ subject: PLAIN });
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.coverArt).toEqual([
      { storageId: publicArt, url: expect.any(String), own: false },
    ]);
    await t.run((ctx) => ctx.db.patch(siblingId, { status: "hidden" }));
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.coverArt).toEqual([
      { storageId: publicArt, url: null, own: false },
    ]);
    // Their own upload they always see.
    const { proposalId: ownDraft } = await suggest(PLAIN, own);
    expect(
      (await asReader.query(api.suggestions.detail, { proposalId: ownDraft }))?.coverArt,
    ).toEqual([{ storageId: own, url: expect.any(String), own: true }]);
  });
});

describe("suggestions — outdated Drafts", () => {
  it("marks a Draft stale when a record it changes moves, and rebases it", async () => {
    const t = makeT();
    const { seriesId, releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    // Two records: more than the suggest form edits, so its page is the only way back.
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
      stale: false,
      target: null,
    });
    await t.run((ctx) =>
      insertSourceRevision(ctx, {
        ref: release(releaseId),
        sourceKey: "kodansha",
        changes: [{ field: "isbn10", after: "1632364212" }],
      }),
    );
    const outdated = await asReader.query(api.suggestions.detail, { proposalId });
    expect(outdated).toMatchObject({
      state: "draft",
      stale: true,
      draft: { content: { ops: [{ stale: false }, { stale: true }] } },
    });
    expect(await asReader.query(api.suggestions.mine, {})).toMatchObject([{ stale: true }]);

    await asReader.mutation(api.proposals.rebaseProposal, { proposalId });
    expect(await asReader.query(api.suggestions.detail, { proposalId })).toMatchObject({
      stale: false,
    });
    await asReader.mutation(api.proposals.submitProposal, { proposalId });
  });

  it("refuses a rebase that would grow a Suggestion past its cap", async () => {
    const t = makeT();
    const { seriesId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [
        {
          kind: "update",
          ref: series(seriesId),
          changes: [{ field: "altTitles", value: ["Short"] }],
        },
      ],
      evidence: URL_EVIDENCE,
      comment: "One more name.",
    });
    // The list grows meanwhile; a rebase copies it into `before`.
    const long = Array.from({ length: 100 }, (_, i) => `${i}${"名".repeat(400)}`);
    await t.run(async (ctx) => {
      await ctx.db.patch(seriesId, { altTitles: long });
      await insertSourceRevision(ctx, {
        ref: series(seriesId),
        sourceKey: "kodansha",
        changes: [{ field: "altTitles", after: long }],
      });
    });
    await expect(asReader.mutation(api.proposals.rebaseProposal, { proposalId })).rejects.toThrow(
      /too large/,
    );
    expect(await asReader.query(api.suggestions.detail, { proposalId })).toMatchObject({
      stale: true,
    });
  });
});

describe("suggestions — cover upload allowance", () => {
  it("counts each upload started, whatever becomes of its file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = makeT();
    const { releaseId } = await setup(t);
    const asReader = t.withIdentity({ subject: PLAIN });
    // Files refused as uploads delete their rows, but not the allowance they used.
    for (let i = 0; i < READER_UPLOADS_PER_DAY; i++) {
      const { uploadId } = await asReader.mutation(api.coverUploads.uploadUrl, {});
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(10)])));
      await t.run((ctx) => ctx.db.patch(uploadId, { storageId }));
      expect(
        await asReader.mutation(api.coverUploads.uploaded, { uploadId, storageId }),
      ).toMatchObject({ ok: false });
    }
    await expect(asReader.mutation(api.coverUploads.uploadUrl, {})).rejects.toMatchObject({
      data: { code: "rateLimited" },
    });

    // A day on, it is back, while uploads that pending Drafts name wait
    // their turn with the sweep.
    vi.setSystemTime(Date.now() + 26 * 60 * 60 * 1000);
    for (let i = 0; i < READER_UPLOADS_PER_DAY; i++) {
      const cover = await upload(t, PLAIN);
      await asReader.mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "update",
            ref: release(releaseId),
            changes: [{ field: "coverImage", value: { storageId: cover } }],
          },
        ],
        evidence: [],
        comment: `Jacket ${i}.`,
      });
    }
    vi.setSystemTime(Date.now() + 26 * 60 * 60 * 1000);
    await t.mutation(internal.coverUploads.sweep, {});
    expect(await t.run((ctx) => ctx.db.query("coverUploads").collect())).toHaveLength(
      READER_UPLOADS_PER_DAY,
    );
    await asReader.mutation(api.coverUploads.uploadUrl, {});
  });
});

describe("suggestions — many resubmissions", () => {
  it("keeps the Moderator's page readable however often a reader resubmits", async () => {
    const t = makeT({ transactionLimits: true });
    await setup(t);
    const readerId = await userIdOf(t, PLAIN);
    // Ten retitles, resubmitted 205 times, as a reader may within the limits.
    const versions = 205;
    const proposalId = await t.run(async (ctx) => {
      const ops = [];
      for (let i = 0; i < MAX_SUGGESTION_OPS; i++) {
        const seriesId = await insertSeries(ctx, { publicId: 100 + i, title: `Series ${i}` });
        const { revisionId: baseRevisionId } = await insertSourceRevision(ctx, {
          ref: series(seriesId),
          sourceKey: "kodansha",
          changes: [{ field: "title", after: `Series ${i}` }],
        });
        ops.push({
          kind: "update" as const,
          ref: series(seriesId),
          baseRevisionId,
          changes: [{ field: "title", before: `Series ${i}`, after: `Retitled ${i}` }],
        });
      }
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "user", userId: readerId },
        state: "inReview",
        currentVersionNo: versions,
        submittedAt: Date.now(),
      });
      for (let versionNo = 1; versionNo <= versions; versionNo++) {
        await ctx.db.insert("proposalVersions", {
          proposalId,
          versionNo,
          ops,
          evidence: URL_EVIDENCE,
          changeComment: `Round ${versionNo}.`,
        });
      }
      return proposalId;
    });

    const detail = await t
      .withIdentity({ subject: MOD })
      .query(api.proposals.proposalDetail, { proposalId });
    expect(detail?.versions).toHaveLength(VERSIONS_SHOWN);
    expect(detail?.versions[0]?.versionNo).toBe(versions - VERSIONS_SHOWN + 1);
    expect(detail?.versions.at(-1)).toMatchObject({
      versionNo: versions,
      current: true,
      content: {
        ops: Array.from({ length: MAX_SUGGESTION_OPS }, () => ({ kind: "update", stale: false })),
      },
    });
    expect(detail).toMatchObject({ currentVersionNo: versions, stale: false });
    const asReader = t.withIdentity({ subject: PLAIN });
    expect((await asReader.query(api.suggestions.detail, { proposalId }))?.versions).toHaveLength(
      VERSIONS_SHOWN,
    );
  });
});

describe("suggestions — a Suggestion stays one", () => {
  it("holds a Suggestion to the reader gate whatever role its author holds later", async () => {
    const t = makeT();
    const ids = await setup(t);
    const { seriesId } = ids;
    const asReader = t.withIdentity({ subject: PLAIN });
    const { proposalId } = await asReader.mutation(api.proposals.saveDraft, {
      ops: [titleOp(seriesId, "Beta")],
      evidence: URL_EVIDENCE,
      comment: "The publisher's spelling.",
    });
    const hiddenId = await t.run((ctx) =>
      insertSeries(ctx, { publicId: 2, title: "Secret Gamma", status: "hidden" }),
    );
    // A held book's source, and art only a hidden Release shows.
    const heldSource = await t.run((ctx) =>
      insertObservation(ctx, { sourceKey: "kodansha", sourceRecordId: "held" }),
    );
    const hiddenArt = await catalogArt(t);
    const hiddenRelease = await insertHiddenRelease(t, ids);
    await t.run((ctx) => ctx.db.patch(hiddenRelease, { coverImage: { storageId: hiddenArt } }));
    const userId = await userIdOf(t, PLAIN);
    await t.run((ctx) => ctx.db.patch(userId, { role: "editor" }));

    // On the Data Team, its author still revises it as a reader.
    const volumeOp = {
      kind: "create" as const,
      table: "volumes",
      tempId: "v",
      fields: { seriesId, label: "2" },
    };
    const save = (ops: FunctionArgs<typeof api.proposals.saveDraft>["ops"]) =>
      asReader.mutation(api.proposals.saveDraft, {
        proposalId,
        ops,
        evidence: URL_EVIDENCE,
        comment: "A new volume.",
      });
    await expect(save([volumeOp])).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(save([titleOp(hiddenId, "Gamma")])).rejects.toMatchObject({
      data: { code: "notFound" },
    });
    await expect(
      asReader.mutation(api.proposals.saveDraft, {
        proposalId,
        ops: [titleOp(seriesId, "Beta")],
        evidence: [{ kind: "observation", observationId: heldSource }],
        comment: "As the source has it.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidEvidence" } });
    await expect(
      save([
        {
          kind: "update",
          ref: release(ids.releaseId),
          changes: [{ field: "coverImage", value: { storageId: hiddenArt } }],
        },
      ]),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
    // What they start on the Data Team is theirs to write as an Editor.
    await asReader.mutation(api.proposals.saveDraft, {
      ops: [volumeOp],
      evidence: URL_EVIDENCE,
      comment: "A new volume.",
    });

    // A Suggestion turned into a creation before the gate held it goes no further.
    await t.run((ctx) =>
      ctx.db.patch(proposalId, {
        draft: {
          ops: [{ ...volumeOp, fields: { seriesId: hiddenId, label: "2" } }],
          evidence: URL_EVIDENCE,
          comment: "A new volume.",
        },
      }),
    );
    for (const call of [api.proposals.submitProposal, api.proposals.rebaseProposal]) {
      await expect(asReader.mutation(call, { proposalId })).rejects.toMatchObject({
        data: { code: "forbidden" },
      });
    }

    // Once the role is gone, its page and row tell nothing of the Series it names.
    await t.run((ctx) => ctx.db.patch(userId, { role: undefined }));
    const detail = await asReader.query(api.suggestions.detail, { proposalId });
    expect(changesOf(detail?.draft).ops).toEqual([{ kind: "withheld", summary: WITHHELD_OP }]);
    expect(JSON.stringify(detail)).not.toContain("Secret Gamma");
    const mine = await asReader.query(api.suggestions.mine, {});
    expect(mine?.map((row) => row.proposalId)).toEqual([proposalId]);
    expect(JSON.stringify(mine)).not.toContain("Secret Gamma");

    // A report filed as a reader still reads back.
    const { proposalId: reportId } = await asReader.mutation(api.reports.submit, {
      seriesPublicId: 1,
      message: "Volume 2 is missing.",
    });
    expect(await asReader.query(api.suggestions.detail, { proposalId: reportId })).toMatchObject({
      state: "inReview",
      versions: [{ content: { ops: [] } }],
    });
  });
});
