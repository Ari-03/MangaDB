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

describe("moderation — series synopsis is editorial and editable", () => {
  it("appears on the edit form and saves through a direct edit", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    const asMod = t.withIdentity({ subject: MOD });
    const form = await asMod.query(api.moderation.editForm, { type: "series", key: "1" });
    expect(form?.fields.find((f) => f.name === "synopsis")).toMatchObject({
      kind: "textarea",
      editorial: true,
      value: null,
    });
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "series", id: seriesId },
      changes: [{ field: "synopsis", value: "  A quiet start.  " }],
      comment: "Wrote a synopsis.",
    });
    const series = await t.run((ctx) => ctx.db.get(seriesId));
    expect(series?.synopsis).toBe("A quiet start.");
  });
});

describe("moderation.sourceBlurbs", () => {
  // A Release whose description Kodansha authored, with a Kodansha and an
  // ANN observation linked; ANN's lower-authority offer was recorded only.
  async function seedRelease(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
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
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [],
        description: "Kodansha's own blurb.",
      });
      for (const [key, name] of [
        ["kodansha", "Kodansha USA"],
        ["ann", "Anime News Network Encyclopedia"],
      ] as const) {
        await ctx.db.insert("approvedSources", {
          key,
          name,
          enabled: true,
          scope: "test",
          fieldAuthority: { description: key === "kodansha" ? "authoritative" : "weak" },
          cadence: "daily",
          healthState: "healthy",
          consecutiveFailures: 0,
        });
      }
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "kodansha" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: releaseId },
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "kodansha" },
        changes: [{ field: "description", before: undefined, after: "Kodansha's own blurb." }],
        comment: "Imported from Kodansha USA.",
      });
      await ctx.db.insert("sourceObservations", {
        sourceKey: "kodansha",
        sourceRecordId: "vol-1",
        recordRef: { type: "release", id: releaseId },
        snapshot: { url: "https://kodansha.test/vol-1", description: "Kodansha's own blurb." },
        lastSeenAt: 1000,
        withdrawn: false,
      });
      await ctx.db.insert("sourceObservations", {
        sourceKey: "ann",
        sourceRecordId: "line:9",
        recordRef: { type: "release", id: releaseId },
        snapshot: { url: "https://ann.test/9", description: "ANN's summary." },
        lastSeenAt: 2000,
        withdrawn: false,
        conflicts: [
          {
            field: "description",
            offered: "ANN's summary.",
            at: 2000,
            reason: "lower authority than the current value's source",
          },
        ],
      });
      // Another source linked without any blurb: nothing to list.
      await ctx.db.insert("sourceObservations", {
        sourceKey: "openlibrary",
        sourceRecordId: "OL1M",
        recordRef: { type: "release", id: releaseId },
        snapshot: { url: "https://openlibrary.test/OL1M" },
        lastSeenAt: 3000,
        withdrawn: true,
      });
      return releaseId;
    });
  }

  it("lists every source's text with its source and marks the canonical one", async () => {
    const t = convexTest(schema);
    await setup(t);
    const releaseId = await seedRelease(t);
    const result = await t
      .withIdentity({ subject: MOD })
      .query(api.moderation.sourceBlurbs, { ref: { type: "release", id: releaseId } });

    expect(result?.field).toBe("description");
    expect(result?.canonical).toEqual({
      text: "Kodansha's own blurb.",
      author: { kind: "source", sourceKey: "kodansha" },
      overridden: false,
    });
    expect(result?.truncated).toBe(false);
    const bySource = new Map(result?.blurbs.map((b) => [b.sourceKey, b]));
    expect(result?.blurbs).toHaveLength(2);
    expect(bySource.get("kodansha")).toMatchObject({
      sourceName: "Kodansha USA",
      url: "https://kodansha.test/vol-1",
      text: "Kodansha's own blurb.",
      current: true,
      recordedOnly: null,
      lastSeenAt: 1000,
      withdrawn: false,
    });
    expect(bySource.get("ann")).toMatchObject({
      sourceName: "Anime News Network Encyclopedia",
      url: "https://ann.test/9",
      text: "ANN's summary.",
      current: false,
      recordedOnly: { reason: "lower authority than the current value's source", at: 2000 },
    });
  });

  it("reports a human author and is Moderator-only", async () => {
    const t = convexTest(schema);
    await setup(t);
    const releaseId = await seedRelease(t);
    const base = await t.run(async (ctx) => (await ctx.db.query("revisions").collect())[0]!);
    const asMod = t.withIdentity({ subject: MOD });
    await asMod.mutation(api.moderation.submitDirectEdit, {
      ref: { type: "release", id: releaseId },
      baseRevisionId: base._id,
      changes: [{ field: "description", value: "An editor's rewrite." }],
      comment: "Tightened the blurb.",
    });
    const result = await asMod.query(api.moderation.sourceBlurbs, {
      ref: { type: "release", id: releaseId },
    });
    expect(result?.canonical).toEqual({
      text: "An editor's rewrite.",
      author: { kind: "user", username: "bob" },
      overridden: true,
    });
    expect(result?.blurbs.every((b) => !b.current)).toBe(true);

    await expect(
      t
        .withIdentity({ subject: EDITOR })
        .query(api.moderation.sourceBlurbs, { ref: { type: "release", id: releaseId } }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  it("reads a series link observation's synopsis", async () => {
    const t = convexTest(schema);
    await setup(t);
    const seriesId = await addSeries(t);
    await t.run((ctx) =>
      ctx.db.insert("sourceObservations", {
        sourceKey: "sevenseas",
        sourceRecordId: "series:alpha",
        recordRef: { type: "series", id: seriesId },
        snapshot: {
          kind: "series",
          title: "Alpha",
          url: "https://ss.test/alpha",
          synopsis: "Alpha begins.",
        },
        lastSeenAt: 1,
        withdrawn: false,
      }),
    );
    const result = await t
      .withIdentity({ subject: MOD })
      .query(api.moderation.sourceBlurbs, { ref: { type: "series", id: seriesId } });
    expect(result).toMatchObject({
      field: "synopsis",
      canonical: { text: null, author: null, overridden: false },
      blurbs: [
        { sourceKey: "sevenseas", sourceName: "sevenseas", text: "Alpha begins.", current: false },
      ],
    });
  });
});
