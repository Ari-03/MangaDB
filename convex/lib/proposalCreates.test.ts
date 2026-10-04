// The proposal creation registry (lib/proposalCreates.ts) at its edges:
// Release ISBN identity at draft, submission, and approval (B12), across a
// proposal's create and update ops together (R11), and
// Edition Line membership carried from a queued packaging guess through
// approval (B16).

import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  seedCatalog,
  type Overrides,
} from "../test.factories";
import { ADMIN, EDITOR, alice, carol, makeT, seedTeam } from "../test.helpers";
import { upsertObservation } from "./observations";
import { queueCreationProposal } from "./pipeline";
import { applyCreatePlan, planCreateOps, type CreateOpInput } from "./proposalCreates";

/** A Series "Noragami" with Volume "1", a Kodansha Edition on it, and one physical Release (`release` overrides it). */
const catalog = (ctx: MutationCtx, release: Overrides<"releases"> = {}) =>
  seedCatalog(ctx, {
    publisher: { name: "Kodansha" },
    series: { publicId: 1, title: "Noragami" },
    release,
  });

type Catalog = Awaited<ReturnType<typeof catalog>>;

/** Another Release of the catalog's Edition holding `isbn13`. */
const holder = (
  ctx: MutationCtx,
  c: Catalog,
  isbn13: string,
  status: "active" | "hidden" = "active",
) =>
  insertRelease(ctx, {
    status,
    editionId: c.editionId,
    publisherId: c.publisherId,
    seriesIds: [c.seriesId],
    isbn13,
  });

const releaseOp = (tempId: string, editionId: string, isbn13: string): CreateOpInput => ({
  kind: "create",
  table: "releases",
  tempId,
  fields: { editionId, format: "digital", language: "en", isbn13 },
});

describe("planCreateOps — Release ISBN identity (B12)", () => {
  it("refuses an ISBN an active Release already holds", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId } = await catalog(ctx, { isbn13: "9781646519026" });
      await expect(
        planCreateOps(ctx, [releaseOp("release", editionId, "978-1-64651-902-6")]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    });
  });

  it("refuses the same ISBN twice within one proposal", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { editionId } = await catalog(ctx);
      await expect(
        planCreateOps(ctx, [
          releaseOp("a", editionId, "9781646519026"),
          releaseOp("b", editionId, "9781646519026"),
        ]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    });
  });

  it("checks ISBN-10 identity too, and ignores a Release no longer active", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const c = await catalog(ctx);
      const { editionId, publisherId, seriesId } = c;
      await holder(ctx, c, "9781646519026", "hidden");
      await insertRelease(ctx, {
        editionId,
        isbn10: "1646519020",
        publisherId,
        seriesIds: [seriesId],
      });
      await expect(
        planCreateOps(ctx, [
          {
            kind: "create",
            table: "releases",
            tempId: "release",
            fields: { editionId, format: "digital", language: "en", isbn10: "1646519020" },
          },
        ]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
      const plans = await planCreateOps(ctx, [releaseOp("release", editionId, "9781646519026")]);
      expect(plans).toHaveLength(1);
    });
  });

  it("approval re-checks inside its transaction: a collision that appeared after submission blocks it", async () => {
    const t = makeT();
    await seedTeam(t, [alice, carol]);
    const c = await t.run((ctx) => catalog(ctx));
    const { editionId } = c;
    const asEditor = t.withIdentity({ subject: EDITOR });
    const { proposalId } = await asEditor.mutation(api.proposals.saveDraft, {
      ops: [releaseOp("release", editionId, "9781646519026")],
      evidence: [{ kind: "url", url: "https://publisher.example/book" }],
      comment: "Digital release announced.",
    });
    await asEditor.mutation(api.proposals.submitProposal, { proposalId });
    // An import lands the same book while the proposal waits in review.
    await t.run((ctx) => holder(ctx, c, "9781646519026"));

    await expect(
      t.withIdentity({ subject: ADMIN }).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    const holders = await t.run((ctx) =>
      ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", "9781646519026"))
        .collect(),
    );
    expect(holders).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(proposalId)))!.state).toBe("inReview");
  });
});

describe("proposal ISBN identity across create and update ops (R11)", () => {
  const X = "9781646519026";
  const Y = "9781999000714";
  const EVIDENCE = [{ kind: "url" as const, url: "https://publisher.example/book" }];

  /** Roles plus the Noragami catalog with one ISBN-less physical Release. */
  async function world() {
    const t = makeT();
    await seedTeam(t, [alice, carol]);
    const c = await t.run((ctx) => catalog(ctx, { binding: "paperback" }));
    return {
      t,
      c,
      ...c,
      physicalId: c.releaseId,
      asEditor: t.withIdentity({ subject: EDITOR }),
      asAdmin: t.withIdentity({ subject: ADMIN }),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const setIsbn = (
    id: Id<"releases">,
    value: string | null,
    field: "isbn13" | "isbn10" = "isbn13",
  ) => ({
    kind: "update" as const,
    ref: { type: "release" as const, id },
    changes: [{ field, value }],
  });

  const activeHolders = (w: World, isbn: string) =>
    w.t.run(async (ctx) =>
      (
        await ctx.db
          .query("releases")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn))
          .collect()
      ).filter((release) => release.status === "active"),
    );

  /** Save and submit a proposal as the Editor. */
  async function submit(w: World, ops: FunctionArgs<typeof api.proposals.saveDraft>["ops"]) {
    const { proposalId } = await w.asEditor.mutation(api.proposals.saveDraft, {
      ops,
      evidence: EVIDENCE,
      comment: "Correct the books.",
    });
    await w.asEditor.mutation(api.proposals.submitProposal, { proposalId });
    return proposalId;
  }

  it("refuses a create and an update assigning one ISBN, at save", async () => {
    const w = await world();
    await expect(
      w.asEditor.mutation(api.proposals.saveDraft, {
        ops: [releaseOp("digital", w.editionId, X), setIsbn(w.physicalId, X)],
        evidence: EVIDENCE,
        comment: "Digital release plus the paperback's ISBN.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    // Update first, create second: still one final ISBN, two holders.
    await expect(
      w.asEditor.mutation(api.proposals.saveDraft, {
        ops: [setIsbn(w.physicalId, X), releaseOp("digital", w.editionId, X)],
        evidence: EVIDENCE,
        comment: "Same pair, other order.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
  });

  it("refuses an update taking an ISBN another active Release holds", async () => {
    const w = await world();
    await w.t.run((ctx) => holder(ctx, w.c, X));
    await expect(
      w.asEditor.mutation(api.proposals.saveDraft, {
        ops: [setIsbn(w.physicalId, "978-1-64651-902-6")],
        evidence: EVIDENCE,
        comment: "Paperback ISBN.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
  });

  it("refuses two updates assigning one ISBN, including ISBN-10", async () => {
    const w = await world();
    const otherId = await w.t.run((ctx) => holder(ctx, w.c, Y));
    await expect(
      w.asEditor.mutation(api.proposals.saveDraft, {
        ops: [
          setIsbn(w.physicalId, "1646519020", "isbn10"),
          setIsbn(otherId, "1646519020", "isbn10"),
        ],
        evidence: EVIDENCE,
        comment: "Both get the ISBN-10.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
  });

  it("submission re-checks: a holder that appeared after saving blocks the update", async () => {
    const w = await world();
    const { proposalId } = await w.asEditor.mutation(api.proposals.saveDraft, {
      ops: [setIsbn(w.physicalId, X)],
      evidence: EVIDENCE,
      comment: "Paperback ISBN.",
    });
    await w.t.run((ctx) => holder(ctx, w.c, X));
    await expect(
      w.asEditor.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
  });

  it("approval re-checks inside its transaction: nothing is written", async () => {
    const w = await world();
    const proposalId = await submit(w, [setIsbn(w.physicalId, X)]);
    // An import lands the same book while the proposal waits in review.
    await w.t.run((ctx) => holder(ctx, w.c, X));
    await expect(
      w.asAdmin.mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });
    expect(await activeHolders(w, X)).toHaveLength(1);
    expect((await w.t.run((ctx) => ctx.db.get(w.physicalId)))!.isbn13).toBeUndefined();
    expect((await w.t.run((ctx) => ctx.db.get(proposalId)))!.state).toBe("inReview");
  });

  it("allows moving an ISBN: the holder is corrected in the same proposal", async () => {
    const w = await world();
    const holderId = await w.t.run((ctx) => holder(ctx, w.c, X));
    // The holder gets its real ISBN; the new digital Release takes X.
    const moved = await submit(w, [setIsbn(holderId, Y), releaseOp("digital", w.editionId, X)]);
    const result = await w.asAdmin.mutation(api.proposals.approveProposal, { proposalId: moved });
    expect(result.status).toBe("approved");
    const holders = await activeHolders(w, X);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.format).toBe("digital");
    // Clearing the holder's ISBN frees it for another update too.
    const cleared = await submit(w, [setIsbn(holders[0]!._id, null), setIsbn(w.physicalId, X)]);
    await w.asAdmin.mutation(api.proposals.approveProposal, { proposalId: cleared });
    expect((await activeHolders(w, X)).map((release) => release._id)).toEqual([w.physicalId]);
  });
});

describe("Edition Line membership through proposals (B16)", () => {
  async function queuedOmnibus(
    ctx: MutationCtx,
    seriesId: Id<"series">,
    isbn13: string,
    position: string,
  ) {
    const { observation } = await upsertObservation(ctx, {
      sourceKey: "prh",
      sourceRecordId: isbn13,
      snapshot: { isbn13 },
      now: 1,
    });
    return await queueCreationProposal(ctx, {
      sourceKey: "prh",
      observation,
      seriesId,
      seriesTitle: "Noragami",
      labels: ["1", "2", "3"],
      editionLine: { name: "Omnibus", position },
      release: { format: "physical", isbn13, publisherSlug: "kodansha" },
      comment: "Omnibus guess",
      now: 1,
    });
  }

  async function approveOps(ctx: MutationCtx, proposalId: Id<"proposals">) {
    const version = (await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
      .unique())!;
    const creates = version.ops.filter((op): op is CreateOpInput => op.kind === "create");
    const temp = new Map<string, string>();
    for (const plan of await planCreateOps(ctx, creates)) await applyCreatePlan(ctx, plan, temp);
  }

  it("an approved omnibus guess joins its Edition Line under the base Series", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { seriesId, publisherId } = await catalog(ctx);
      await approveOps(ctx, await queuedOmnibus(ctx, seriesId, "9781646519026", "1"));

      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ seriesId, publisherId, name: "Omnibus", status: "active" }]);
      const omnibus = (await ctx.db.query("editions").collect()).find(
        (edition) => edition.linePosition === "1",
      );
      expect(omnibus).toMatchObject({ editionLineId: lines[0]!._id, publisherId });

      // The next member of the same line reuses it instead of a second line.
      await approveOps(ctx, await queuedOmnibus(ctx, seriesId, "9781646519033", "2"));
      expect(await ctx.db.query("editionLines").collect()).toHaveLength(1);
      const members = await ctx.db
        .query("editions")
        .withIndex("by_line", (q) => q.eq("editionLineId", lines[0]!._id))
        .collect();
      expect(members.map((edition) => edition.linePosition).sort()).toEqual(["1", "2"]);
    });
  });

  it("validates the line: same publisher, same base Series, no duplicate line", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { seriesId, publisherId, volumeId } = await catalog(ctx);
      const other = await insertPublisher(ctx, { name: "Vertical" });
      const otherSeries = await insertSeries(ctx, { publicId: 2, title: "Other" });
      const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: "Omnibus" });
      const edition = (fields: Record<string, unknown>): CreateOpInput => ({
        kind: "create",
        table: "editions",
        tempId: "edition",
        fields: {
          volumeCoverage: [{ volume: volumeId, order: 1, extent: "complete" }],
          ...fields,
        },
      });
      // Another publisher's line.
      await expect(
        planCreateOps(ctx, [edition({ publisherId: other, editionLineId: lineId })]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
      // A line of another Series than the covered Volumes.
      const foreign = await insertEditionLine(ctx, {
        seriesId: otherSeries,
        publisherId,
        name: "Deluxe",
      });
      await expect(
        planCreateOps(ctx, [edition({ publisherId, editionLineId: foreign })]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
      // A second active line with the same name for the same publisher.
      await expect(
        planCreateOps(ctx, [
          {
            kind: "create",
            table: "editionLines",
            tempId: "line",
            fields: { seriesId, publisherId, name: "omnibus" },
          },
        ]),
      ).rejects.toMatchObject({ data: { code: "invalidCreate" } });
      // The valid reference plans cleanly.
      expect(
        await planCreateOps(ctx, [
          edition({ publisherId, editionLineId: lineId, linePosition: "1" }),
        ]),
      ).toHaveLength(1);
    });
  });
});
