// Cover changes through the moderation write path (coverUploads.ts,
// http.ts, lib/coverRefs.ts, moderation.ts applyUpdate): an upload is
// checked and tied to its uploader, a person's cover is always a Human
// Override, and no blob a record shows, History names or a pending
// Proposal names is ever deleted, by the importer (imports.attachCover) or
// by the upload sweep, nor anything before older Revisions are pinned.

import { describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertSourceRevision,
  insertVariant,
  insertVolume,
} from "./test.factories";
import {
  alice,
  bob,
  carol,
  dave,
  EDITOR,
  MOD,
  makeT,
  pinCoverHistory,
  seedTeam,
  type TestT,
} from "./test.helpers";

const ART = "https://kodansha.test/alpha-1.jpg";

// convex-test serves HTTP actions at this origin (t.fetch).
vi.stubEnv("CONVEX_SITE_URL", "https://some.convex.site");

/**
 * Give a stored blob the content type production takes from the upload:
 * convex-test records none.
 */
async function typed(t: TestT, id: Id<"_storage">, type: string) {
  await t.run((ctx) => ctx.db.patch(id as never, { contentType: type } as never));
  return id;
}

/** Store a blob as the importer or a repair tool would. */
async function storeImage(t: TestT, { bytes = 4096, type = "image/jpeg" } = {}) {
  const id = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)], { type })));
  return await typed(t, id, type);
}

/** POST a file to an upload URL as the form does; the HTTP action's answer. */
async function post(t: TestT, url: string, { bytes = 4096, type = "image/jpeg" } = {}) {
  const { pathname, search } = new URL(url);
  const response = await t.fetch(`${pathname}${search}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: new Blob([new Uint8Array(bytes)], { type }),
  });
  const body = (await response.json()) as { storageId?: Id<"_storage">; message?: string };
  if (body.storageId) await typed(t, body.storageId, type);
  return { status: response.status, ...body };
}

/** Upload a file as `subject`: issue the URL, post the file, report it back. */
async function upload(t: TestT, subject: string, file: { bytes?: number; type?: string } = {}) {
  const as = t.withIdentity({ subject });
  const { uploadId, url } = await as.mutation(api.coverUploads.uploadUrl, {});
  const { storageId } = await post(t, url, file);
  expect(
    await as.mutation(api.coverUploads.uploaded, { uploadId, storageId: storageId! }),
  ).toMatchObject({ ok: true });
  return storageId!;
}

/** Put every upload past its day, as the sweep will find it tomorrow. */
async function pastTheirDay(t: TestT) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("coverUploads").collect()) {
      await ctx.db.patch(row._id, { sweepAfter: 0 });
    }
  });
}

/** Seed the Data Team and finish the pin backfill, as on a deployment that has run it. */
async function ready(t: TestT) {
  await seedTeam(t, [alice, bob, carol, dave]);
  await pinCoverHistory(t);
}

/** Alpha's one-volume book with a Release whose art the importer attached (no Revision). */
async function book(t: TestT) {
  const imported = await storeImage(t);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha USA" });
    const seriesId = await insertSeries(ctx, { title: "Alpha" });
    const volumeId = await insertVolume(ctx, { seriesId });
    const editionId = await insertEdition(ctx, { publisherId });
    await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781632364210",
      coverImage: { storageId: imported, sourceUrl: ART, attribution: "Kodansha" },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "kodansha",
      sourceRecordId: "alpha-1",
      recordRef: { type: "release", id: releaseId },
      snapshot: { coverUrl: "https://kodansha.test/alpha-1-new.jpg" },
    });
    return { publisherId, seriesId, editionId, releaseId, observationId };
  });
  return { ...ids, imported };
}

const releaseOf = (t: TestT, id: Id<"releases">) => t.run((ctx) => ctx.db.get(id));
const stored = (t: TestT, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);

/** The Moderator's direct edit of a Release's cover. */
async function setCover(
  t: TestT,
  releaseId: Id<"releases">,
  value: { storageId: string; attribution?: string } | null,
) {
  return await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
    ref: { type: "release", id: releaseId },
    baseRevisionId: (
      await t.run((ctx) =>
        ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", releaseId))
          .order("desc")
          .first(),
      )
    )?._id,
    changes: [{ field: "coverImage", value }],
    comment: "The publisher's jacket.",
  });
}

/** The importer's download of new art for `releaseId`. */
async function importArt(t: TestT, b: Awaited<ReturnType<typeof book>>) {
  const incoming = await storeImage(t);
  const result = await t.mutation(internal.imports.attachCover, {
    releaseId: b.releaseId,
    editionId: b.editionId,
    observationId: b.observationId,
    storageId: incoming,
    sourceUrl: "https://kodansha.test/alpha-1-new.jpg",
    attribution: "Kodansha",
  });
  return { incoming, result };
}

describe("cover uploads", () => {
  it("saves a Moderator's upload through the edit form as a Human Override with History", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    const fresh = await upload(t, MOD);

    const { revisionId } = await setCover(t, b.releaseId, {
      storageId: fresh,
      attribution: "https://kodansha.us/alpha-1",
    });

    const release = await releaseOf(t, b.releaseId);
    expect(release?.coverImage).toEqual({
      storageId: fresh,
      attribution: "https://kodansha.us/alpha-1",
      sourceUrl: "https://kodansha.us/alpha-1",
    });
    // No import-authored Revision existed, and the cover is overridden anyway.
    expect(release?.overriddenFields).toEqual(["coverImage"]);
    const revision = await t.run((ctx) => ctx.db.get(revisionId));
    expect(revision?.changes).toEqual([
      {
        field: "coverImage",
        before: { storageId: b.imported, sourceUrl: ART, attribution: "Kodansha" },
        after: release?.coverImage,
      },
    ]);
    const pins = await t.run((ctx) => ctx.db.query("coverRefs").collect());
    expect(pins.map((pin) => pin.storageId).sort()).toEqual([b.imported, fresh].sort());
    // The shelf row is refreshed rather than left to the six-hour rebuild.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("refreshStats"))).toBe(true);

    // The importer's next download is refused, and deletes nothing anyone needs.
    const { incoming, result } = await importArt(t, b);
    expect(result).toMatchObject({ attached: false, refused: "cover is a Human Override" });
    expect((await releaseOf(t, b.releaseId))?.coverImage?.storageId).toBe(fresh);
    expect(await stored(t, incoming)).toBe(false);
    expect(await stored(t, b.imported)).toBe(true);
    expect(await stored(t, fresh)).toBe(true);
  });

  it("removes a cover as an override, keeps the old art, and imports resume once it is cleared", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    await setCover(t, b.releaseId, null);
    const removed = await releaseOf(t, b.releaseId);
    expect(removed?.coverImage).toBeUndefined();
    expect(removed?.overriddenFields).toEqual(["coverImage"]);
    expect(await stored(t, b.imported)).toBe(true);

    const latest = await t.run((ctx) =>
      ctx.db
        .query("revisions")
        .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", b.releaseId))
        .order("desc")
        .first(),
    );
    await t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectClear, {
      ref: { type: "release", id: b.releaseId },
      field: "coverImage",
      baseRevisionId: latest?._id,
      comment: "Let the publisher's art back in.",
    });
    const { incoming, result } = await importArt(t, b);
    expect(result).toMatchObject({ attached: true });
    expect((await releaseOf(t, b.releaseId))?.coverImage?.storageId).toBe(incoming);
    // History still names the art the person removed.
    expect(await stored(t, b.imported)).toBe(true);
  });

  it("refuses files that are not covers and blobs the person has no claim to", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    const asMod = t.withIdentity({ subject: MOD });

    // A GIF and a placeholder-sized JPEG are refused and deleted.
    for (const file of [{ type: "image/gif" }, { bytes: 900 }]) {
      const { uploadId, url } = await asMod.mutation(api.coverUploads.uploadUrl, {});
      const { storageId } = await post(t, url, file);
      expect(
        await asMod.mutation(api.coverUploads.uploaded, { uploadId, storageId: storageId! }),
      ).toMatchObject({ ok: false });
      expect(await stored(t, storageId!)).toBe(false);
    }

    // An upload names only the blob its own URL stored: a stray blob, or
    // another upload's, is refused and left alone.
    const earlier = await storeImage(t);
    const { uploadId, url } = await asMod.mutation(api.coverUploads.uploadUrl, {});
    await expect(
      asMod.mutation(api.coverUploads.uploaded, { uploadId, storageId: earlier }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await stored(t, earlier)).toBe(true);

    // The URL needs its token, and takes one file: a refused file is not kept.
    const blobs = () =>
      t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
    const before = await blobs();
    const forged = new URL(url);
    forged.searchParams.set("token", "guess");
    expect(await post(t, forged.href)).toMatchObject({ status: 403 });
    expect(await post(t, url)).toMatchObject({ status: 200 });
    expect(await post(t, url)).toMatchObject({ status: 403 });
    expect(await blobs()).toBe(before + 1);

    // Someone else's upload, or a stray blob, cannot go into a change.
    const carols = await upload(t, EDITOR);
    await expect(setCover(t, b.releaseId, { storageId: carols })).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    await expect(setCover(t, b.releaseId, { storageId: earlier })).rejects.toMatchObject({
      data: { code: "invalidField" },
    });

    // Art another record of the catalog shows may be reused.
    const sibling = await t.run(async (ctx) => {
      const release = await ctx.db.get(b.releaseId);
      return await insertRelease(ctx, {
        editionId: b.editionId,
        publisherId: b.publisherId,
        seriesIds: release!.seriesIds,
        format: "digital",
      });
    });
    await setCover(t, sibling, { storageId: b.imported, attribution: "Kodansha" });
    expect((await releaseOf(t, sibling))?.coverImage?.storageId).toBe(b.imported);
  });

  it("never claims or deletes catalog art stored after an upload began", async () => {
    const t = makeT();
    await ready(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { uploadId } = await asEditor.mutation(api.coverUploads.uploadUrl, {});
    // Meanwhile the importer stores a GIF and a Release shows it.
    const gif = await storeImage(t, { type: "image/gif" });
    const releaseId = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx);
      const editionId = await insertEdition(ctx, { publisherId });
      return await insertRelease(ctx, {
        publisherId,
        editionId,
        seriesIds: [],
        coverImage: { storageId: gif },
      });
    });
    await expect(
      asEditor.mutation(api.coverUploads.uploaded, { uploadId, storageId: gif }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await stored(t, gif)).toBe(true);
    expect((await releaseOf(t, releaseId))?.coverImage?.storageId).toBe(gif);
    // Nor did the attempt tie the art to the Editor: the sweep has no row for it.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("coverUploads")
          .withIndex("by_storage", (q) => q.eq("storageId", gif))
          .first(),
      ),
    ).toBeNull();
  });

  it("holds an Editor's staged cover through review and applies it on approval", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const staged = await upload(t, EDITOR);
    const ref = { type: "release" as const, id: b.releaseId };

    // Another Editor's upload is refused at drafting.
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.proposals.saveDraft, {
        ops: [
          { kind: "update", ref, changes: [{ field: "coverImage", value: { storageId: staged } }] },
        ],
        evidence: [],
        comment: "Not mine.",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [
        { kind: "update", ref, changes: [{ field: "coverImage", value: { storageId: staged } }] },
      ],
      evidence: [],
      comment: "The publisher's new jacket.",
    });
    // Covers need no factual evidence.
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });

    // A day later the sweep keeps it: the Proposal is In Review.
    await pastTheirDay(t);
    await t.mutation(internal.coverUploads.sweep, {});
    expect(await stored(t, staged)).toBe(true);
    const deferred = await t.run((ctx) => ctx.db.query("coverUploads").collect());
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.sweepAfter).toBeGreaterThan(Date.now());

    // An import replacing the current art meanwhile keeps the staged blob too.
    const { incoming } = await importArt(t, b);
    expect(await stored(t, staged)).toBe(true);

    // Approval records the art it replaced as the change's before, so History keeps it.
    const approved = await t
      .withIdentity({ subject: MOD })
      .mutation(api.proposals.approveProposal, { proposalId });
    expect(approved.status).toBe("approved");
    expect((await releaseOf(t, b.releaseId))?.coverImage?.storageId).toBe(staged);
    const pinned = await t.run((ctx) =>
      ctx.db
        .query("coverRefs")
        .withIndex("by_storage", (q) => q.eq("storageId", incoming))
        .collect(),
    );
    expect(pinned.some((pin) => pin.revisionId !== undefined)).toBe(true);
  });

  it("approves a staged cover, and refuses one whose file has gone", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    const asEditor = t.withIdentity({ subject: EDITOR });
    const asMod = t.withIdentity({ subject: MOD });
    const ref = { type: "release" as const, id: b.releaseId };
    const propose = async (storageId: Id<"_storage">) => {
      const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
        ops: [{ kind: "update", ref, changes: [{ field: "coverImage", value: { storageId } }] }],
        evidence: [],
        comment: "Better scan.",
      });
      await asEditor.mutation(api.proposals.submitProposal, { proposalId });
      return proposalId;
    };

    const gone = await upload(t, EDITOR);
    const doomed = await propose(gone);
    await t.run((ctx) => ctx.storage.delete(gone));
    await expect(
      asMod.mutation(api.proposals.approveProposal, { proposalId: doomed }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
    await asMod.mutation(api.proposals.rejectProposal, { proposalId: doomed, note: "File lost." });

    const staged = await upload(t, EDITOR);
    const proposalId = await propose(staged);
    const result = await asMod.mutation(api.proposals.approveProposal, { proposalId });
    expect(result.status).toBe("approved");
    const release = await releaseOf(t, b.releaseId);
    expect(release?.coverImage?.storageId).toBe(staged);
    expect(release?.overriddenFields).toEqual(["coverImage"]);
  });

  it("sweeps unused uploads and rejected proposals' files, never art in use", async () => {
    const t = makeT();
    await ready(t);
    const b = await book(t);
    const unused = await upload(t, MOD);
    const used = await upload(t, MOD);
    await setCover(t, b.releaseId, { storageId: used });
    const rejected = await upload(t, EDITOR);
    const { proposalId } = await t
      .withIdentity({ subject: EDITOR })
      .mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "update",
            ref: { type: "release", id: b.releaseId },
            changes: [{ field: "coverImage", value: { storageId: rejected } }],
          },
        ],
        evidence: [],
        comment: "Alternate jacket.",
      });
    await t
      .withIdentity({ subject: EDITOR })
      .mutation(api.proposals.withdrawProposal, { proposalId });
    await pastTheirDay(t);
    await t.mutation(internal.coverUploads.sweep, {});
    expect(await stored(t, unused)).toBe(false);
    expect(await stored(t, rejected)).toBe(false);
    expect(await stored(t, used)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("coverUploads").collect())).toEqual([]);
  });
});

describe("imports.attachCover retention", () => {
  it("keeps replaced art a Variant shows or History names", async () => {
    const t = makeT();
    await ready(t);

    // Shown by a Variant.
    const a = await book(t);
    await t.run((ctx) =>
      insertVariant(ctx, { releaseId: a.releaseId, coverImage: { storageId: a.imported } }),
    );
    await importArt(t, a);
    expect(await stored(t, a.imported)).toBe(true);

    // Named by a Revision of another record (a person once set it there).
    const b = await book(t);
    const other = await book(t);
    await setCover(t, other.releaseId, { storageId: b.imported, attribution: "Kodansha" });
    await setCover(t, other.releaseId, null);
    await importArt(t, b);
    expect(await stored(t, b.imported)).toBe(true);

    // Art nothing needs is still replaced and deleted.
    const d = await book(t);
    const { result } = await importArt(t, d);
    expect(result).toMatchObject({ attached: true });
    expect(await stored(t, d.imported)).toBe(false);
  });

  it("deletes no art until the Revisions written before pins have theirs", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol, dave]);
    // Another Release's Revision from before pins existed names this art.
    const b = await book(t);
    await t.run(async (ctx) => {
      const holder = await insertRelease(ctx, {
        editionId: b.editionId,
        publisherId: b.publisherId,
        seriesIds: [b.seriesId],
        format: "digital",
      });
      await insertSourceRevision(ctx, {
        sourceKey: "kodansha",
        ref: { type: "release", id: holder },
        changes: [{ field: "coverImage", before: { storageId: b.imported } }],
      });
    });
    // An unused upload is past its day.
    const unused = await upload(t, MOD);
    await pastTheirDay(t);

    // Before the backfill, neither the importer nor the sweep deletes.
    expect((await importArt(t, b)).result).toMatchObject({ attached: true });
    expect(await stored(t, b.imported)).toBe(true);
    await t.mutation(internal.coverUploads.sweep, {});
    expect(await stored(t, unused)).toBe(true);

    // The cron's run pins the old Revision and is done; a second start is a no-op.
    expect(await t.mutation(internal.coverUploads.pinRevisionCovers, {})).toEqual({
      pinned: 1,
      done: true,
    });
    expect(await t.mutation(internal.coverUploads.pinRevisionCovers, {})).toEqual({
      pinned: 0,
      done: true,
    });
    const pins = await t.run((ctx) =>
      ctx.db
        .query("coverRefs")
        .withIndex("by_storage", (q) => q.eq("storageId", b.imported))
        .collect(),
    );
    expect(pins).toHaveLength(1);

    // The old art stays for good; the unused upload, looked at again, goes.
    await pastTheirDay(t);
    await t.mutation(internal.coverUploads.sweep, {});
    expect(await stored(t, unused)).toBe(false);
    expect(await stored(t, b.imported)).toBe(true);
  });

  it("runs the backfill as one chain from its saved cursor", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx);
      const editionId = await insertEdition(ctx, { publisherId });
      const releaseId = await insertRelease(ctx, { publisherId, editionId, seriesIds: [] });
      for (let i = 0; i < 201; i++) {
        await insertSourceRevision(ctx, {
          sourceKey: "kodansha",
          ref: { type: "release", id: releaseId },
          changes: [{ field: "price", after: i }],
        });
      }
    });
    vi.useFakeTimers();
    try {
      expect(await t.mutation(internal.coverUploads.pinRevisionCovers, {})).toEqual({
        pinned: 0,
        done: false,
      });
      // The cron finds the chain moving and leaves it be; a stale step stops.
      expect(await t.mutation(internal.coverUploads.pinRevisionCovers, {})).toEqual({
        pinned: 0,
        done: false,
      });
      expect(await t.mutation(internal.coverUploads.pinRevisionCovers, { from: null })).toEqual({
        pinned: 0,
        done: false,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await t.run((ctx) => ctx.db.query("coverPinBackfill").first())).toMatchObject({
      done: true,
    });
  });
});
