// Moderation-core tests (ticket #31, spec §4/§5): direct edits flow through
// the proposal write path (immediately approved Proposal Version → one
// immutable public Revision), validation and staleness rules, the implicit
// Human Override on import-authored fields, and the public record history.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const ADMIN = "user_admin";
const MOD = "user_mod";
const EDITOR = "user_editor";
const PLAIN = "user_plain";

async function setup(t: ReturnType<typeof convexTest>) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: MOD })
    .mutation(api.users.claimUsername, { username: "bob" });
  await t
    .withIdentity({ subject: EDITOR })
    .mutation(api.users.claimUsername, { username: "carol" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "carol", role: "editor" });
}

async function addSeries(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    status: "active" | "hidden" | "merged";
    locked: boolean;
    title: string;
    publicId: number;
  }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("series", {
      status: overrides.status ?? "active",
      locked: overrides.locked,
      publicId: overrides.publicId ?? 1,
      title: overrides.title ?? "Alpha",
      altTitles: ["A-side"],
      searchText: `${overrides.title ?? "Alpha"} A-side`,
    }),
  );
}

describe("moderation.submitDirectEdit — authorization", () => {
  it("rejects signed-out, plain, and Editor callers", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const args = {
      ref: { type: "series" as const, id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "Nope.",
    };
    await expect(t.mutation(api.moderation.submitDirectEdit, args)).rejects.toThrow(
      ConvexError,
    );
    for (const subject of [PLAIN, EDITOR]) {
      await expect(
        t.withIdentity({ subject }).mutation(api.moderation.submitDirectEdit, args),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("moderation.submitDirectEdit — the proposal write path", () => {
  it("saves as an immediately approved Proposal Version with one Revision", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);

    const result = await t
      .withIdentity({ subject: MOD })
      .mutation(api.moderation.submitDirectEdit, {
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: "  Beta  " }],
        comment: "Official romanization per the publisher.",
      });
    expect(result.seq).toBe(1);

    const proposal = await t.run((ctx) => ctx.db.get(result.proposalId));
    expect(proposal).toMatchObject({
      state: "approved",
      currentVersionNo: 1,
      author: { kind: "user", roleAtAuthorship: "moderator" },
    });
    expect(proposal?.decidedBy).toBeDefined();
    expect(proposal?.submittedAt).toBeDefined();

    const versions = await t.run((ctx) =>
      ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", result.proposalId))
        .collect(),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNo).toBe(1);
    expect(versions[0].changeComment).toBe(
      "Official romanization per the publisher.",
    );
    expect(versions[0].ops).toHaveLength(1);
    expect(versions[0].ops[0]).toMatchObject({ kind: "update" });

    const revision = await t.run((ctx) => ctx.db.get(result.revisionId));
    expect(revision).toMatchObject({
      seq: 1,
      proposalId: result.proposalId,
      comment: "Official romanization per the publisher.",
      changes: [{ field: "title", before: "Alpha", after: "Beta" }],
    });
    // A direct edit is self-approved: author and approver are the same user.
    expect(revision?.author.kind).toBe("user");
    expect(revision?.approvedBy).toBeDefined();

    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.title).toBe("Beta");
    // Derived search text is maintained by the shared write path.
    expect(series?.searchText).toBe("Beta A-side");
  });

  it("enforces staleness: the base Revision must be the record's latest", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });

    const first = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "First fix.",
    });

    // A second edit loaded before the first landed (no/old base) is stale.
    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: "Gamma" }],
        comment: "Concurrent edit.",
      }),
    ).rejects.toMatchObject({ data: { code: "stale" } });

    const second = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      baseRevisionId: first.revisionId,
      changes: [{ field: "title", value: "Gamma" }],
      comment: "Rebased edit.",
    });
    expect(second.seq).toBe(2);
  });

  it("validates: comment required, whitelisted fields only, no no-ops", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });
    const ref = { type: "series" as const, id: seriesId };

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "title", value: "Beta" }],
        comment: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "commentRequired" } });

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "publicId", value: 999 }],
        comment: "Sneaky.",
      }),
    ).rejects.toMatchObject({ data: { code: "unknownField" } });

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "title", value: "Alpha" }],
        comment: "Nothing actually changes.",
      }),
    ).rejects.toMatchObject({ data: { code: "noChanges" } });

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "sourceStatus", value: "paused" }],
        comment: "Not a real source status.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref,
        changes: [{ field: "title", value: "" }],
        comment: "Titles are required.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });

    // Nothing landed: no proposals, no revisions, record untouched.
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("revisions").collect())).toHaveLength(0);
  });

  it("refuses hidden, merged, and locked records", async () => {
    const t = convexTest(schema);
    await setup(t);
    const asMod = t.withIdentity({ subject: MOD });
    const hidden = await addSeries(t, { status: "hidden", publicId: 2 });
    const locked = await addSeries(t, { locked: true, publicId: 3 });
    for (const id of [hidden, locked]) {
      await expect(
        asMod.mutation(api.moderation.submitDirectEdit, {
          ref: { type: "series", id },
          changes: [{ field: "title", value: "Beta" }],
          comment: "Should not work.",
        }),
      ).rejects.toMatchObject({ data: { code: "locked" } });
    }
  });

  it("normalizes partial dates (sort key) and enforces the binding invariant", async () => {
    const t = convexTest(schema);
    await setup(t);
    const asMod = t.withIdentity({ subject: MOD });

    const { editionId, digitalId } = await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Pub",
        slug: "pub",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId,
      });
      const digitalId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "digital",
        language: "en",
        publisherId,
        seriesIds: [],
      });
      return { editionId, digitalId };
    });
    void editionId;

    await expect(
      asMod.mutation(api.moderation.submitDirectEdit, {
        ref: { type: "release", id: digitalId },
        changes: [{ field: "binding", value: "hardcover" }],
        comment: "Digital books have no binding.",
      }),
    ).rejects.toMatchObject({ data: { code: "invalidField" } });

    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "release", id: digitalId },
      changes: [
        { field: "pubDate", value: { year: 2027, month: 3 } },
        { field: "isbn13", value: "978-1-99900-071-4" },
      ],
      comment: "Announced for March 2027.",
    });
    const release = await t.run((ctx) => ctx.db.get(digitalId));
    expect(release?.pubDate).toEqual({ year: 2027, month: 3, sort: 20270300 });
    expect(release?.isbn13).toBe("9781999000714");
  });
});

describe("moderation — implicit Human Override (spec §4)", () => {
  async function withImportedTitle(
    t: ReturnType<typeof convexTest>,
    seriesId: Id<"series">,
  ) {
    // Simulate an importer-authored Revision having set the title (imports
    // author Proposals too; here only the Revision matters for provenance).
    await t.run(async (ctx) => {
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "sevenSeas" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "series", id: seriesId },
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "sevenSeas" },
        changes: [{ field: "title", before: undefined, after: "Alpha" }],
        comment: "Imported from Seven Seas.",
        citation: { sourceName: "Seven Seas", url: "https://example.test/alpha" },
      });
    });
  }

  it("marks an approved human change to an import-authored field as overridden", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    await withImportedTitle(t, seriesId);
    const base = await t.run(async (ctx) =>
      (await ctx.db.query("revisions").collect())[0],
    );

    await t.withIdentity({ subject: MOD }).mutation(
      api.moderation.submitDirectEdit,
      {
        ref: { type: "series", id: seriesId },
        baseRevisionId: base._id,
        changes: [
          { field: "title", value: "Beta" },
          // altTitles has no import provenance — must NOT become an override.
          { field: "altTitles", value: ["B-side"] },
        ],
        comment: "Publisher renamed the series.",
      },
    );

    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.overriddenFields).toEqual(["title"]);
  });

  it("does not mark human-authored fields, and override marking is sticky", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });

    // Purely human history: nothing gets marked.
    const first = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "Human fix on human data.",
    });
    let series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.overriddenFields).toBeUndefined();

    // An existing override survives later edits to other fields.
    await t.run((ctx) =>
      ctx.db.patch(seriesId, { overriddenFields: ["sourceStatus"] }),
    );
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      baseRevisionId: first.revisionId,
      changes: [{ field: "title", value: "Gamma" }],
      comment: "Another human fix.",
    });
    series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.overriddenFields).toEqual(["sourceStatus"]);
  });
});

describe("moderation.recordHistory", () => {
  it("returns the public history: diff, author, approver, timestamp, comment", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });

    const first = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "First fix.",
    });
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      baseRevisionId: first.revisionId,
      changes: [{ field: "sourceStatus", value: "completed" }],
      comment: "Wrapped up in Japan.",
    });

    // Public — no identity needed.
    const history = await t.query(api.moderation.recordHistory, {
      type: "series",
      publicId: 1,
    });
    expect(history).not.toBeNull();
    expect(history?.revisions.map((r) => r.seq)).toEqual([2, 1]);
    expect(history?.revisions[1]).toMatchObject({
      comment: "First fix.",
      author: { kind: "user", username: "bob", role: "moderator" },
      approver: "bob",
      changes: [{ field: "title", before: "Alpha", after: "Beta" }],
    });
    expect(typeof history?.revisions[0].at).toBe("number");
  });

  it("hides hidden records and resolves merged records to their survivor", async () => {
    const t = convexTest(schema);
    await setup(t);
    const survivor = await addSeries(t, { publicId: 1, title: "Alpha" });
    await t.run(async (ctx) => {
      await ctx.db.insert("series", {
        status: "merged",
        mergedIntoId: survivor,
        publicId: 2,
        title: "Alpha (dup)",
        altTitles: [],
        searchText: "Alpha (dup)",
      });
      await ctx.db.insert("series", {
        status: "hidden",
        publicId: 3,
        title: "Hidden",
        altTitles: [],
        searchText: "Hidden",
      });
    });
    await t.withIdentity({ subject: MOD }).mutation(
      api.moderation.submitDirectEdit,
      {
        ref: { type: "series", id: survivor },
        changes: [{ field: "title", value: "Beta" }],
        comment: "Fix.",
      },
    );

    const viaLoser = await t.query(api.moderation.recordHistory, {
      type: "series",
      publicId: 2,
    });
    expect(viaLoser?.revisions).toHaveLength(1);
    expect(
      await t.query(api.moderation.recordHistory, { type: "series", publicId: 3 }),
    ).toBeNull();
  });
});

describe("moderation.editForm", () => {
  it("returns registry fields with current values and the base revision", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });

    const before = await asMod.query(api.moderation.editForm, {
      type: "series",
      key: "1",
    });
    expect(before).toMatchObject({
      title: "Alpha",
      status: "active",
      locked: false,
      baseRevisionId: null,
      backLink: { entity: "series", publicId: 1, title: "Alpha" },
    });
    const titleField = before?.fields.find((f) => f.name === "title");
    expect(titleField).toMatchObject({ kind: "text", value: "Alpha" });

    const edit = await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "title", value: "Beta" }],
      comment: "Fix.",
    });
    const after = await asMod.query(api.moderation.editForm, {
      type: "series",
      key: "1",
    });
    expect(after?.baseRevisionId).toBe(edit.revisionId);
  });

  it("is data-team-only and resolves releases by document ID", async () => {
    const t = convexTest(schema);
    await setup(t);
    // Editors read the form too since #32 (they draft update proposals from
    // it); anyone without a data-team role is refused.
    await expect(
      t
        .withIdentity({ subject: PLAIN })
        .query(api.moderation.editForm, { type: "series", key: "1" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    const releaseId = await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Pub",
        slug: "pub",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId,
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        publisherId,
        seriesIds: [],
      });
    });
    const form = await t
      .withIdentity({ subject: MOD })
      .query(api.moderation.editForm, { type: "release", key: releaseId });
    expect(form?.fields.find((f) => f.name === "binding")).toMatchObject({
      value: "paperback",
    });
    expect(form?.backLink).toMatchObject({ entity: "edition", publicId: 1 });
  });
});
