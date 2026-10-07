import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { reviewedCatalogProducts } from "./lib/reviewedCatalogProducts";
import {
  insertBundle,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

type Product = (typeof reviewedCatalogProducts)[number];
const scope = vi.hoisted<{ product: Product | undefined }>(() => ({ product: undefined }));
// Convex-test allocates its own IDs. Only the ten reviewed manifest IDs are
// translated into each test's isolated database; the production allowlist is unchanged.
vi.mock("./lib/reviewedCatalogProducts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/reviewedCatalogProducts")>();
  return {
    ...original,
    assignedProduct: (id: string) =>
      scope.product?.observationId === id ? scope.product : original.assignedProduct(id),
  };
});
beforeEach(() => {
  scope.product = undefined;
});

async function seed(pin = reviewedCatalogProducts[0]!) {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "Ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    await ctx.db.insert("appConfig", { bootstrapMode: true });
    const seriesId = await insertSeries(ctx, { title: "Inuyasha" });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media" });
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: pin.lineName });
    const volumes = [];
    for (const volume of pin.volumes)
      volumes.push({
        id: await insertVolume(ctx, {
          seriesId,
          label: volume.label,
          position: Number(volume.label),
        }),
        label: volume.label,
      });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:76",
      snapshot: { kind: "annManga", id: "76", title: "Inuyasha" },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: pin.sourceRecordId,
      snapshot: pin.snapshot,
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      heldAt: 123,
      seriesId,
    });
    // Preserve a different legitimate Edition with the same contents.
    const distinctLineId = await insertEditionLine(ctx, {
      seriesId,
      publisherId,
      name: "Separate edition",
    });
    const editionId = await insertEdition(ctx, {
      publisherId,
      editionLineId: distinctLineId,
      linePosition: pin.position,
    });
    for (const [i, volume] of volumes.entries())
      await insertCoverage(ctx, { editionId, volumeId: volume.id, order: i + 1 });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781569319482",
      binding: "paperback",
    });
    return {
      seriesId,
      publisherId,
      lineId,
      volumes,
      parentId,
      observationId,
      holdId,
      editionId,
      releaseId,
    };
  });
  const product = {
    ...pin,
    observationId: ids.observationId,
    seriesId: ids.seriesId,
    publisherId: ids.publisherId,
    lineId: ids.lineId,
    volumes: ids.volumes,
  };
  scope.product = product;
  return { t, ids, product };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
const preview = (f: Fixture) =>
  f.t.query(internal.repair.previewReviewedCreation, { observationId: f.ids.observationId });
async function ready(f: Fixture) {
  const result = await preview(f);
  expect(result.classification, result.refusal ?? undefined).toBe("ready");
  if (!result.expected) throw new Error("missing guard");
  return result.expected;
}
const execute = (f: Fixture, expected: string, dryRun = false) =>
  f.t.mutation(internal.repair.executeReviewedCreation, {
    observationId: f.ids.observationId,
    expected,
    actor: "ari",
    dryRun,
  });
// Snapshot every table this operation can write, plus all preserved source,
// catalog and tracking tables. Zero-write means exact document equality.
async function snapshot(t: TestT) {
  return t.run(async (ctx) => {
    const tables = [
      "series",
      "publishers",
      "volumes",
      "editionLines",
      "editions",
      "volumeCoverages",
      "releases",
      "releaseBundles",
      "releaseIsbns",
      "sourceObservations",
      "observationSnapshots",
      "placementHolds",
      "heldRepairLedger",
      "proposals",
      "proposalVersions",
      "revisions",
      "counters",
      "collectionEntries",
      "ratings",
      "reviews",
      "favorites",
    ] as const;
    return Object.fromEntries(
      await Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).collect()])),
    );
  });
}
async function occupied(ctx: MutationCtx, f: Fixture, equivalent: boolean) {
  const editionId = await insertEdition(ctx, {
    publisherId: f.ids.publisherId,
    editionLineId: f.ids.lineId,
    linePosition: f.product.position,
  });
  const contents = equivalent ? f.ids.volumes : [f.ids.volumes[0]!];
  for (const [i, volume] of contents.entries())
    await insertCoverage(ctx, { editionId, volumeId: volume.id, order: i + 1 });
  await insertRelease(ctx, {
    editionId,
    publisherId: f.ids.publisherId,
    seriesIds: [f.ids.seriesId],
    isbn13: "9781974728374",
  });
}

describe("batch-040 reviewed catalog creation", () => {
  it("retains exactly the ten assigned evidence pins", () => {
    expect(reviewedCatalogProducts).toHaveLength(10);
    expect(new Set(reviewedCatalogProducts.map((product) => product.observationId)).size).toBe(10);
    expect(reviewedCatalogProducts.map((product) => product.position)).toEqual([
      "2",
      "4",
      "5",
      "7",
      "8",
      "9",
      "11",
      "12",
      "13",
      "14",
    ]);
    for (const product of reviewedCatalogProducts) {
      expect(product.volumes).toHaveLength(3);
      expect(product.evidence).toHaveLength(2);
      for (const evidence of product.evidence) expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it.each(reviewedCatalogProducts.map((product) => [product.isbn13, product] as const))(
    "creates and audits exact reviewed product %s; fresh retry writes nothing",
    async (_isbn, pin) => {
      const f = await seed(pin);
      const expected = await ready(f);
      const before = await snapshot(f.t);
      expect(await execute(f, expected, true)).toEqual({ status: "dryRun" });
      expect(await snapshot(f.t)).toEqual(before);
      const result = await execute(f, expected);
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("not created");
      const after = await snapshot(f.t);
      expect(after.editions).toHaveLength(2);
      expect(after.releases).toHaveLength(2);
      expect(after.volumeCoverages).toHaveLength(6);
      expect(after.proposals).toHaveLength(1);
      expect(after.proposalVersions).toHaveLength(1);
      expect(after.revisions).toHaveLength(3);
      expect(after.heldRepairLedger).toHaveLength(1);
      for (const table of [
        "series",
        "publishers",
        "volumes",
        "editionLines",
        "sourceObservations",
        "observationSnapshots",
        "placementHolds",
        "collectionEntries",
        "ratings",
        "reviews",
        "favorites",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(after.editions).toContainEqual(before.editions[0]);
      expect(after.releases).toContainEqual(before.releases[0]);
      const post = await preview(f);
      expect(post.classification, post.refusal ?? undefined).toBe("alreadyApplied");
      if (!post.expected) throw new Error("no post guard");
      expect(post.expected).not.toBe(expected);
      expect(await execute(f, post.expected)).toEqual({ ...result, status: "alreadyApplied" });
      expect(await snapshot(f.t)).toEqual(after);
      expect((await execute(f, expected)).status).toBe("refused");
      expect(await snapshot(f.t)).toEqual(after);
    },
  );

  const driftCases: Array<[string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>]> = [
    [
      "source raw facts",
      async (ctx, f) =>
        ctx.db.patch(f.ids.observationId, {
          snapshot: { ...f.product.snapshot, format: "digital" },
        }),
    ],
    [
      "raw source history",
      async (ctx, f) =>
        ctx.db.insert("observationSnapshots", {
          observationId: f.ids.observationId,
          snapshot: { old: true },
          supersededAt: 1,
        }),
    ],
    [
      "parent raw history",
      async (ctx, f) =>
        ctx.db.insert("observationSnapshots", {
          observationId: f.ids.parentId,
          snapshot: { old: true },
          supersededAt: 1,
        }),
    ],
    ["held context", async (ctx, f) => ctx.db.patch(f.ids.holdId, { heldAt: 999 })],
    [
      "parent work",
      async (ctx, f) =>
        ctx.db.patch(f.ids.parentId, {
          snapshot: { id: "76", kind: "annManga", title: "Another work" },
        }),
    ],
    [
      "parent canonical routing",
      async (ctx, f) =>
        ctx.db.patch(f.ids.parentId, {
          recordRef: { type: "series", id: await insertSeries(ctx, { title: "Other" }) },
        }),
    ],
    ["line identity", async (ctx, f) => ctx.db.patch(f.ids.lineId, { name: "Other edition" })],
    ["line status", async (ctx, f) => ctx.db.patch(f.ids.lineId, { status: "hidden" })],
    [
      "duplicate line identity",
      async (ctx, f) =>
        insertEditionLine(ctx, {
          publisherId: f.ids.publisherId,
          seriesId: f.ids.seriesId,
          name: " vizbig edition ",
        }),
    ],
    ["occupied target slot", async (ctx, f) => occupied(ctx, f, false)],
    ["equivalent target Edition", async (ctx, f) => occupied(ctx, f, true)],
    ["archived Volume", async (ctx, f) => ctx.db.patch(f.ids.volumes[1]!.id, { status: "hidden" })],
    ["Volume order", async (ctx, f) => ctx.db.patch(f.ids.volumes[1]!.id, { position: 99 })],
    ["Volume label", async (ctx, f) => ctx.db.patch(f.ids.volumes[1]!.id, { label: "99" })],
    [
      "duplicate Volume label",
      async (ctx, f) =>
        insertVolume(ctx, {
          seriesId: f.ids.seriesId,
          label: f.ids.volumes[1]!.label,
          position: 5,
        }),
    ],
    [
      "wrong-Series coverage",
      async (ctx, f) =>
        ctx.db.patch(f.ids.volumes[1]!.id, {
          seriesId: await insertSeries(ctx, { title: "Other" }),
        }),
    ],
    ["Series status", async (ctx, f) => ctx.db.patch(f.ids.seriesId, { status: "hidden" })],
    ["publisher status", async (ctx, f) => ctx.db.patch(f.ids.publisherId, { status: "hidden" })],
    [
      "primary ISBN-13",
      async (ctx, f) => ctx.db.patch(f.ids.releaseId, { isbn13: f.product.isbn13 }),
    ],
    [
      "primary ISBN-10 only",
      async (ctx, f) => ctx.db.patch(f.ids.releaseId, { isbn10: f.product.isbn10 }),
    ],
    [
      "alternate ISBN",
      async (ctx, f) =>
        ctx.db.insert("releaseIsbns", {
          releaseId: f.ids.releaseId,
          isbn13: f.product.isbn13,
          reason: "reviewed",
          sourceKey: "ann",
        }),
    ],
    [
      "Bundle ISBN-13",
      async (ctx, f) =>
        insertBundle(ctx, { publisherId: f.ids.publisherId, isbn13: f.product.isbn13 }),
    ],
    [
      "Bundle ISBN-10 only",
      async (ctx, f) =>
        insertBundle(ctx, { publisherId: f.ids.publisherId, isbn10: f.product.isbn10 }),
    ],
    [
      "hidden primary owner",
      async (ctx, f) =>
        ctx.db.patch(f.ids.releaseId, { status: "hidden", isbn13: f.product.isbn13 }),
    ],
    [
      "catalog Revision",
      async (ctx, f) => {
        const user = await ctx.db.query("users").first();
        if (!user) throw new Error("no actor");
        const author = {
          kind: "user" as const,
          userId: user._id,
          roleAtAuthorship: "administrator" as const,
        };
        const proposalId = await ctx.db.insert("proposals", {
          state: "approved",
          currentVersionNo: 1,
          author,
        });
        return ctx.db.insert("revisions", {
          ref: { type: "volume", id: f.ids.volumes[1]!.id },
          seq: 1,
          proposalId,
          author,
          changes: [{ field: "label", after: f.ids.volumes[1]!.label }],
          comment: "concurrent revision",
        });
      },
    ],
  ];
  it.each(driftCases)("stale %s refuses with zero writes", async (_name, drift) => {
    const f = await seed();
    const expected = await ready(f);
    await f.t.run((ctx) => drift(ctx, f));
    const before = await snapshot(f.t);
    expect((await execute(f, expected)).status).toBe("refused");
    expect(await snapshot(f.t)).toEqual(before);
  });
  it("unknown observation refuses without catalog or audit writes", async () => {
    const f = await seed();
    const id = await f.t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:unassigned",
        snapshot: f.product.snapshot,
      }),
    );
    const before = await snapshot(f.t);
    expect(
      (await f.t.query(internal.repair.previewReviewedCreation, { observationId: id }))
        .classification,
    ).toBe("refused");
    expect(
      (
        await f.t.mutation(internal.repair.executeReviewedCreation, {
          observationId: id,
          actor: "ari",
          dryRun: false,
          expected: "invented",
        })
      ).status,
    ).toBe("refused");
    expect(await snapshot(f.t)).toEqual(before);
  });
  it("the same fresh preview cannot create twice, including concurrent submissions", async () => {
    const f = await seed();
    const expected = await ready(f);
    const results = await Promise.all([execute(f, expected), execute(f, expected)]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "refused"]);
    expect((await snapshot(f.t)).releases).toHaveLength(2);
  });
  it("overflow refuses a complete preview and writes nothing", async () => {
    const f = await seed();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 81; i++)
        await ctx.db.insert("observationSnapshots", {
          observationId: f.ids.observationId,
          supersededAt: i,
          snapshot: { old: i },
        });
    });
    const before = await snapshot(f.t);
    expect((await preview(f)).classification).toBe("refused");
    expect((await execute(f, "invented")).status).toBe("refused");
    expect(await snapshot(f.t)).toEqual(before);
  });
  const retryDrifts: Array<
    [
      string,
      (
        ctx: MutationCtx,
        f: Fixture,
        ids: {
          releaseId: import("./_generated/dataModel").Id<"releases">;
          editionId: import("./_generated/dataModel").Id<"editions">;
          proposalId: import("./_generated/dataModel").Id<"proposals">;
        },
      ) => Promise<unknown>,
    ]
  > = [
    [
      "Release ISBN",
      async (ctx, _f, ids) =>
        ctx.db.patch(ids.releaseId, { isbn13: "9781974728374", isbn10: "1974728374" }),
    ],
    [
      "Release extra field",
      async (ctx, _f, ids) =>
        ctx.db.patch(ids.releaseId, { description: "changed without reviewed audit" }),
    ],
    ["Release format", async (ctx, _f, ids) => ctx.db.patch(ids.releaseId, { format: "digital" })],
    [
      "Release binding",
      async (ctx, _f, ids) => ctx.db.patch(ids.releaseId, { binding: "hardcover" }),
    ],
    ["Release language", async (ctx, _f, ids) => ctx.db.patch(ids.releaseId, { language: "ja" })],
    ["Release status", async (ctx, _f, ids) => ctx.db.patch(ids.releaseId, { status: "hidden" })],
    [
      "Release date",
      async (ctx, _f, ids) =>
        ctx.db.patch(ids.releaseId, { pubDate: { year: 2099, sort: 20990000 } }),
    ],
    ["Edition slot", async (ctx, _f, ids) => ctx.db.patch(ids.editionId, { linePosition: "99" })],
    ["Edition status", async (ctx, _f, ids) => ctx.db.patch(ids.editionId, { status: "hidden" })],
    [
      "partial coverage",
      async (ctx, _f, ids) => {
        const row = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", ids.editionId))
          .first();
        if (!row) throw new Error("no coverage");
        return ctx.db.patch(row._id, { extent: "partial" });
      },
    ],
    [
      "reordered coverage",
      async (ctx, _f, ids) => {
        const row = await ctx.db
          .query("volumeCoverages")
          .withIndex("by_edition", (q) => q.eq("editionId", ids.editionId))
          .first();
        if (!row) throw new Error("no coverage");
        return ctx.db.patch(row._id, { order: 99 });
      },
    ],
    [
      "duplicate coverage",
      async (ctx, f, ids) =>
        insertCoverage(ctx, { editionId: ids.editionId, volumeId: f.ids.volumes[0]!.id, order: 4 }),
    ],
    [
      "competing primary",
      async (ctx, f) => ctx.db.patch(f.ids.releaseId, { isbn13: f.product.isbn13 }),
    ],
    [
      "competing alternate",
      async (ctx, f) =>
        ctx.db.insert("releaseIsbns", {
          releaseId: f.ids.releaseId,
          isbn13: f.product.isbn13,
          reason: "reviewed",
          sourceKey: "ann",
        }),
    ],
    ["occupied second slot", async (ctx, f) => occupied(ctx, f, false)],
    [
      "new Release sibling",
      async (ctx, f, ids) =>
        insertRelease(ctx, {
          editionId: ids.editionId,
          publisherId: f.ids.publisherId,
          seriesIds: [f.ids.seriesId],
          isbn13: "9781974728374",
        }),
    ],
    [
      "audit approval",
      async (ctx, _f, ids) => ctx.db.patch(ids.proposalId, { state: "withdrawn" }),
    ],
    [
      "audit version",
      async (ctx, _f, ids) => {
        const version = await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", ids.proposalId))
          .first();
        if (!version) throw new Error("no version");
        return ctx.db.patch(version._id, { ops: [] });
      },
    ],
    [
      "audit Revision",
      async (ctx, _f, ids) => {
        const revision = await ctx.db
          .query("revisions")
          .withIndex("by_record", (q) => q.eq("ref.type", "release").eq("ref.id", ids.releaseId))
          .first();
        if (!revision) throw new Error("no revision");
        return ctx.db.patch(revision._id, {
          changes: revision.changes.filter((change) => change.field !== "reviewedCatalogCreation"),
        });
      },
    ],
    [
      "audit actual IDs",
      async (ctx, f) => {
        const ledger = await ctx.db
          .query("heldRepairLedger")
          .withIndex("by_observation", (q) => q.eq("observationId", f.ids.observationId))
          .first();
        if (!ledger) throw new Error("no ledger");
        return ctx.db.patch(ledger._id, { createdReleaseId: f.ids.releaseId });
      },
    ],
  ];
  it.each(retryDrifts)(
    "fresh retry preview refuses altered %s and writes nothing",
    async (_name, drift) => {
      const f = await seed();
      const expected = await ready(f);
      const result = await execute(f, expected);
      if (result.status !== "created") throw new Error("not created");
      await f.t.run((ctx) => drift(ctx, f, result));
      const before = await snapshot(f.t);
      expect((await preview(f)).classification).toBe("refused");
      expect((await execute(f, expected)).status).toBe("refused");
      expect(await snapshot(f.t)).toEqual(before);
    },
  );
  it("proves the existing generic operation cannot supply the target slot guard", async () => {
    const f = await seed();
    await f.t.run((ctx) => occupied(ctx, f, true));
    expect((await preview(f)).classification).toBe("refused");
    const outcome = await f.t.mutation(internal.repair.runBatch, {
      actor: "ari",
      dryRun: false,
      entries: [
        {
          kind: "createRelease",
          key: f.product.key,
          reason: f.product.reason,
          isbn13: f.product.isbn13,
          isbn10: f.product.isbn10,
          format: "physical",
          binding: "paperback",
          publisherId: f.ids.publisherId,
          pubDate: f.product.pubDate,
          price: null,
          coverage: f.ids.volumes.map((volume) => ({
            volumeId: volume.id,
            extent: "complete" as const,
          })),
          line: { name: f.product.lineName, position: f.product.position },
          sources: f.product.evidence.map((evidence) => evidence.url),
        },
      ],
    });
    expect(outcome[0]?.status).toBe("applied");
    const slots = await f.t.run((ctx) =>
      ctx.db
        .query("editions")
        .withIndex("by_line", (q) => q.eq("editionLineId", f.ids.lineId))
        .collect(),
    );
    expect(slots.filter((edition) => edition.linePosition === f.product.position)).toHaveLength(2);
  });
  it("supports the 56-Volume catalog and a retained large parent snapshot without unbounded guards", async () => {
    const f = await seed();
    await f.t.run(async (ctx) => {
      for (let number = 1; number <= 56; number++) {
        if (f.ids.volumes.some((volume) => volume.label === String(number))) continue;
        await insertVolume(ctx, { seriesId: f.ids.seriesId, position: number });
      }
      await ctx.db.patch(f.ids.parentId, {
        snapshot: {
          kind: "annManga",
          id: "76",
          title: "Inuyasha",
          releases: Array.from({ length: 120 }, (_, i) => ({
            annId: String(i),
            title: "Inuyasha [VIZBIG Edition]",
            date: { year: 2010 },
            format: "physical",
            isbn13: "9781569319482",
            label: String(i),
            multi: false,
          })),
        },
      });
    });
    const expected = await ready(f);
    expect(expected).toMatch(/^batch-040-v1:[a-f0-9]{64}$/);
    expect((await execute(f, expected)).status).toBe("created");
    const post = await preview(f);
    expect(post.classification, post.refusal ?? undefined).toBe("alreadyApplied");
    if (!post.expected) throw new Error("no post guard");
    expect((await execute(f, post.expected)).status).toBe("alreadyApplied");
  });
});
