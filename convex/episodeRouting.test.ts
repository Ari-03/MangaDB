import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { AnnReleaseSnapshot } from "./ann";
import type { AnnMangaSnapshot } from "./lib/ann";
import { episodeTitle } from "./lib/episodeRouting";
import { holdOf } from "./lib/observations";
import { valueHash } from "./lib/values";
import { episodeCases, episodeParentSnapshot } from "./test.episodeCases";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  insertSourceRevision,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

const fault = vi.hoisted(() => ({ audit: false }));
vi.mock("./moderation", async (original) => {
  const module = await original<typeof import("./moderation")>();
  return {
    ...module,
    insertFirstVersion: (...args: Parameters<typeof module.insertFirstVersion>) => {
      if (fault.audit) throw new Error("Injected audit failure after hold/link writes");
      return module.insertFirstVersion(...args);
    },
  };
});
afterEach(() => {
  fault.audit = false;
});

/** Fresh local IDs around the retained real source facts. Never call a live deployment. */
async function seed(t: TestT, item = episodeCases[0]!) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "episode-test",
      username: "episode-test",
      usernameNormalized: "episode-test",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "Yen Press" });
    const umbrellaId = await insertSeries(ctx, { title: "Umineko When They Cry" });
    const seriesId = await insertSeries(ctx, {
      title: item.seriesTitle,
      bootstrapUnreviewed: item.bootstrapUnreviewed,
    });
    const volumeId = await insertVolume(ctx, {
      seriesId,
      position: Number(item.localLabel),
      label: item.localLabel,
    });
    const editionId = await insertEdition(ctx, { publisherId });
    const coverageId = await insertCoverage(ctx, { editionId, volumeId });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      format: item.format,
      binding: item.binding,
      isbn13: item.isbn13,
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:11729",
      snapshot: episodeParentSnapshot,
      recordRef: { type: "series", id: umbrellaId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: `release:${item.snapshot.annId}`,
      snapshot: item.snapshot,
      conflicts: item.conflicts,
    });
    const archiveId = await ctx.db.insert("observationSnapshots", {
      observationId,
      snapshot: item.snapshot,
      supersededAt: 1,
    });
    const holdId = await ctx.db.insert("placementHolds", {
      sourceKey: "ann",
      observationId,
      kind: "isbn",
      heldAt: 1,
    });
    const configId = await ctx.db.insert("appConfig", { bootstrapMode: true });
    const collectionId = await ctx.db.insert("collectionEntries", {
      userId,
      releaseId,
      state: "owned",
    });
    const progressId = await ctx.db.insert("releaseProgress", {
      userId,
      releaseId,
      seriesId,
      percent: 37,
    });
    const { revisionId } = await insertSourceRevision(ctx, {
      sourceKey: "yenpress",
      changes: [],
      ref: { type: "release", id: releaseId },
    });
    const otherId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:untouched",
    });
    const otherHoldId = await ctx.db.insert("placementHolds", {
      sourceKey: "ann",
      observationId: otherId,
      kind: "isbn",
      heldAt: 1,
    });
    const reviewed = {
      isbn13: item.isbn13,
      publisherId,
      seriesId,
      volumeIds: [volumeId],
      evidenceUrls: [
        item.productUrl,
        item.snapshot.url,
        "https://www.animenewsnetwork.com/encyclopedia/manga.php?id=11729",
      ],
      episodeRouting: {
        parentObservationId: parentId,
        sourceTitle: item.snapshot.title,
        productTitle: item.productTitle,
        productVolumeLabel: item.localLabel,
        sourceGlobalLabel: item.snapshot.label!,
        productIsbn13: item.isbn13,
        productFormat: item.format,
        productBinding: item.format === "physical" ? ("paperback" as const) : ("digital" as const),
        publisherName: "Yen Press",
        publisherSeriesTitle: "Umineko WHEN THEY CRY",
        productUrl: item.productUrl,
      },
    };
    return {
      archiveId,
      userId,
      publisherId,
      umbrellaId,
      seriesId,
      volumeId,
      editionId,
      coverageId,
      releaseId,
      parentId,
      observationId,
      holdId,
      otherHoldId,
      configId,
      collectionId,
      progressId,
      revisionId,
      reviewed,
      target: { type: "release" as const, id: releaseId },
    };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const args = (s: Seed) => ({
  observationId: s.observationId,
  target: s.target,
  reviewed: s.reviewed,
});
const review = (t: TestT, s: Seed) =>
  t.query(internal.heldBooks.previewReviewSeriesInternal, args(s));
const execute = (t: TestT, s: Seed, expected: string, operation: "reviewSeries" | "link") =>
  t.mutation(internal.heldBooks.executeInternal, {
    ...args(s),
    actor: "episode-test",
    operation,
    seriesId: s.seriesId,
    expected,
    reason: "Own-ISBN publisher Episode/local Volume and ANN membership independently reviewed.",
    evidenceUrls: s.reviewed.evidenceUrls,
  });
async function preserved(t: TestT, s: Seed) {
  return await t.run(async (ctx) =>
    Promise.all(
      [
        s.archiveId,
        s.parentId,
        s.umbrellaId,
        s.seriesId,
        s.volumeId,
        s.editionId,
        s.releaseId,
        s.coverageId,
        s.collectionId,
        s.progressId,
        s.revisionId,
        s.otherHoldId,
      ].map((id) => ctx.db.get(id)),
    ),
  );
}
async function sourceEdit(t: TestT, s: Seed, edit: (line: AnnReleaseSnapshot) => void) {
  await t.run(async (ctx) => {
    const doc = await ctx.db.get(s.observationId);
    const line = structuredClone(doc!.snapshot) as AnnReleaseSnapshot;
    edit(line);
    await ctx.db.patch(s.observationId, { snapshot: line });
  });
}
async function parentEdit(t: TestT, s: Seed, edit: (parent: AnnMangaSnapshot) => void) {
  await t.run(async (ctx) => {
    const doc = await ctx.db.get(s.parentId);
    const parent = structuredClone(doc!.snapshot) as AnnMangaSnapshot;
    edit(parent);
    await ctx.db.patch(s.parentId, { snapshot: parent });
  });
}

describe("Umineko Episode ISBN routes", () => {
  for (const item of episodeCases)
    it(`reviews and links retained ${item.batchId} ISBN ${item.isbn13}`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t, item);
      const before = await preserved(t, s);
      const ready = await review(t, s);
      expect(ready).toMatchObject({ classification: "reviewSeriesReady", refusal: null });
      expect((await t.query(internal.heldBooks.previewInternal, args(s))).refusal).toContain(
        "Hold needs",
      );
      expect((await execute(t, s, ready.expected!, "reviewSeries")).status).toBe("applied");
      expect(await t.run((ctx) => holdOf(ctx, s.observationId))).toMatchObject({
        seriesId: s.seriesId,
      });
      const link = await t.query(internal.heldBooks.previewInternal, args(s));
      expect(link).toMatchObject({ classification: "linkReady", refusal: null });
      expect(link.expected).not.toBe(ready.expected);
      expect((await execute(t, s, link.expected!, "link")).status).toBe("applied");
      await t.run(async (ctx) => {
        const observation = await ctx.db.get(s.observationId);
        expect(observation?.snapshot).toEqual(item.snapshot);
        expect(observation?.conflicts).toEqual(
          item.conflicts.filter((conflict) => conflict.field !== "placement"),
        );
        const ledger = await ctx.db.query("heldRepairLedger").collect();
        expect(ledger.find((entry) => entry.operation === "link")?.before).toContain(
          valueHash(item.conflicts),
        );
        expect(observation?.recordRef).toEqual({ type: "release", id: s.releaseId });
        expect(await holdOf(ctx, s.observationId)).toBeNull();
        expect(await ctx.db.query("heldRepairLedger").collect()).toHaveLength(2);
        expect(await ctx.db.query("proposals").collect()).toHaveLength(3);
        expect(await ctx.db.query("proposalVersions").collect()).toHaveLength(2);
      });
      expect(await preserved(t, s)).toEqual(before);
    });
});

const negatives: Array<[string, (t: TestT, s: Seed) => Promise<void> | void]> = [
  [
    "wrong publisher Episode",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Episode 2",
        "Episode 3",
      );
    },
  ],
  [
    "wrong arc",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Turn",
        "Banquet",
      );
    },
  ],
  [
    "wrong root",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Umineko",
        "Higurashi",
      );
    },
  ],
  [
    "Part instead of Episode",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Episode",
        "Part",
      );
    },
  ],
  [
    "wrong publisher local Volume",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Vol. 1",
        "Vol. 2",
      );
    },
  ],
  [
    "bare ambiguous volume",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle = s.reviewed.episodeRouting.productTitle.replace(
        "Vol. 1",
        "1",
      );
    },
  ],
  [
    "chapter extent",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle += " Chapters 1-6";
    },
  ],
  [
    "novel",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle += " (novel)";
    },
  ],
  [
    "range",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle += "-2";
    },
  ],
  [
    "package",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle += " Box Set";
    },
  ],
  [
    "unknown technical text",
    (_t, s) => {
      s.reviewed.episodeRouting.productTitle += " GN ?";
    },
  ],
  [
    "wrong proof global ordinal",
    (_t, s) => {
      s.reviewed.episodeRouting.sourceGlobalLabel = "4";
    },
  ],
  [
    "wrong publisher SKU",
    (_t, s) => {
      s.reviewed.episodeRouting.productIsbn13 = "9780316229524";
    },
  ],
  [
    "sibling SKU URL",
    (_t, s) => {
      s.reviewed.episodeRouting.productUrl = s.reviewed.episodeRouting.productUrl.replace(
        s.reviewed.isbn13,
        "9780316229524",
      );
    },
  ],
  [
    "missing own ISBN evidence",
    (_t, s) => {
      s.reviewed.evidenceUrls = [s.reviewed.evidenceUrls[1]!];
    },
  ],
  [
    "wrong imprint",
    (_t, s) => {
      s.reviewed.episodeRouting.publisherName = "Orbit";
    },
  ],
  [
    "wrong publisher series",
    (_t, s) => {
      s.reviewed.episodeRouting.publisherSeriesTitle = "Higurashi When They Cry";
    },
  ],
  [
    "wrong publisher format",
    (_t, s) => {
      s.reviewed.episodeRouting.productFormat = "digital";
    },
  ],
  [
    "wrong publisher binding",
    (_t, s) => {
      s.reviewed.episodeRouting.productBinding = "digital";
    },
  ],
  [
    "contradictory page local Volume",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.title = line.title.replace("Volume 1", "Volume 2");
      }),
  ],
  [
    "contradictory page Episode",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.title = line.title.replace("Episode 2", "Episode 3");
      }),
  ],
  [
    "contradictory page ISBN",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.isbn13 = "9780316229524";
      }),
  ],
  [
    "contradictory ISBN10",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.isbn10 = "0316229520";
      }),
  ],
  [
    "contradictory page parent",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.mangaId = "11728";
      }),
  ],
  [
    "unknown page designator",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.volume = "Chapter 3";
      }),
  ],
  [
    "page range",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.volume = "GN 3 / 4";
      }),
  ],
  [
    "contradictory page format",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.volume = "eBook 3";
      }),
  ],
  [
    "missing page",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        delete line.page;
      }),
  ],
  [
    "unparsed page",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.status = "unparsed";
      }),
  ],
  [
    "unknown distributor",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.distributor = "Other Press";
      }),
  ],
  [
    "physical Orbit distributor",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.page!.distributor = "Orbit";
      }),
  ],
  [
    "packaged source",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.multi = true;
      }),
  ],
  [
    "source range",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.coverRange = { from: "1", to: "2" };
      }),
  ],
  [
    "source gap",
    (t, s) =>
      sourceEdit(t, s, (line) => {
        line.coverageGapped = true;
      }),
  ],
  [
    "missing parent member",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases = parent.releases.filter(
          (r) => r.annId !== episodeCases[0]!.snapshot.annId,
        );
      }),
  ],
  [
    "duplicate parent member",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.push(
          parent.releases.find((r) => r.annId === episodeCases[0]!.snapshot.annId)!,
        );
      }),
  ],
  [
    "wrong parent tuple format",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.find((r) => r.annId === episodeCases[0]!.snapshot.annId)!.format =
          "digital";
      }),
  ],
  [
    "wrong parent tuple ISBN",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.find((r) => r.annId === episodeCases[0]!.snapshot.annId)!.isbn13 =
          "9780316229524";
      }),
  ],
  [
    "wrong parent tuple title",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.find((r) => r.annId === episodeCases[0]!.snapshot.annId)!.title += " extra";
      }),
  ],
  [
    "wrong parent tuple global",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.find((r) => r.annId === episodeCases[0]!.snapshot.annId)!.label = "4";
      }),
  ],
  [
    "contradictory sibling numbering",
    (t, s) =>
      parentEdit(t, s, (parent) => {
        parent.releases.find(
          (r) =>
            r.title === episodeCases[0]!.snapshot.title &&
            r.annId !== episodeCases[0]!.snapshot.annId,
        )!.label = "99";
      }),
  ],
  [
    "duplicate parent",
    (t, s) =>
      t.run(async (ctx) => {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "manga:11729",
          snapshot: episodeParentSnapshot,
          recordRef: { type: "series", id: s.umbrellaId },
        });
      }),
  ],
  [
    "wrong supplied parent ID",
    (_t, s) => {
      s.reviewed.episodeRouting.parentObservationId = s.observationId;
    },
  ],
  [
    "wrong canonical Episode",
    (t, s) =>
      t.run((ctx) =>
        ctx.db.patch(s.seriesId, {
          title: episodeCases[0]!.seriesTitle.replace("Episode 2", "Episode 3"),
        }),
      ),
  ],
  [
    "wrong canonical local Volume",
    (t, s) => t.run((ctx) => ctx.db.patch(s.volumeId, { label: "2", position: 2 })),
  ],
  ["wrong canonical position", (t, s) => t.run((ctx) => ctx.db.patch(s.volumeId, { position: 3 }))],
  ["partial coverage", (t, s) => t.run((ctx) => ctx.db.patch(s.coverageId, { extent: "partial" }))],
  [
    "extra coverage",
    (t, s) =>
      t.run(async (ctx) => {
        await insertCoverage(ctx, { editionId: s.editionId, volumeId: s.volumeId, order: 2 });
      }),
  ],
  [
    "wrong target publisher",
    (t, s) =>
      t.run(async (ctx) => {
        const id = await insertPublisher(ctx, { name: "Other Press" });
        await ctx.db.patch(s.releaseId, { publisherId: id });
      }),
  ],
  [
    "wrong target binding",
    (t, s) => t.run((ctx) => ctx.db.patch(s.releaseId, { binding: "hardcover" })),
  ],
  [
    "wrong target format",
    (t, s) => t.run((ctx) => ctx.db.patch(s.releaseId, { format: "digital" })),
  ],
  ["inactive target", (t, s) => t.run((ctx) => ctx.db.patch(s.releaseId, { status: "hidden" }))],
  [
    "additional ISBN owner",
    (t, s) =>
      t.run(async (ctx) => {
        await insertRelease(ctx, {
          editionId: s.editionId,
          publisherId: s.publisherId,
          seriesIds: [s.seriesId],
          isbn13: s.reviewed.isbn13,
        });
      }),
  ],
  [
    "non ANN source",
    (t, s) => t.run((ctx) => ctx.db.patch(s.observationId, { sourceKey: "other" })),
  ],
];
for (const [name, mutate] of negatives)
  it(`refuses ${name} before review and link`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    await mutate(t, s);
    const before = await t.run((ctx) => ctx.db.get(s.holdId));
    const ready = await review(t, s);
    expect(ready.refusal).not.toBeNull();
    expect(ready.expected).toBeNull();
    await t.run((ctx) => ctx.db.patch(s.holdId, { seriesId: s.seriesId }));
    expect((await t.query(internal.heldBooks.previewInternal, args(s))).refusal).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toEqual([]);
    expect(before?.seriesId).toBeUndefined();
  });

const changes: Array<[string, (t: TestT, s: Seed) => Promise<void>]> = [
  ["parent observation", (t, s) => t.run((ctx) => ctx.db.patch(s.parentId, { lastSeenAt: 77 }))],
  [
    "source observation",
    (t, s) => t.run((ctx) => ctx.db.patch(s.observationId, { lastSeenAt: 77 })),
  ],
  ["hold", (t, s) => t.run((ctx) => ctx.db.patch(s.holdId, { heldAt: 77 }))],
  ["coverage", (t, s) => t.run((ctx) => ctx.db.patch(s.coverageId, { order: 2 }))],
  [
    "revision",
    (t, s) =>
      t.run(async (ctx) => {
        await insertSourceRevision(ctx, {
          sourceKey: "yenpress",
          changes: [],
          ref: { type: "release", id: s.releaseId },
        });
      }),
  ],
  ["bootstrap", (t, s) => t.run((ctx) => ctx.db.patch(s.configId, { bootstrapMode: false }))],
  [
    "withdrawn source",
    (t, s) => t.run((ctx) => ctx.db.patch(s.observationId, { withdrawn: true })),
  ],
  [
    "new ISBN owner",
    (t, s) =>
      t.run(async (ctx) => {
        await insertRelease(ctx, {
          editionId: s.editionId,
          publisherId: s.publisherId,
          seriesIds: [s.seriesId],
          isbn13: s.reviewed.isbn13,
        });
      }),
  ],
];
for (const [name, change] of changes)
  for (const operation of ["reviewSeries", "link"] as const)
    it(`rejects stale ${name} for ${operation} without writes`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      if (operation === "link")
        expect((await execute(t, s, (await review(t, s)).expected!, "reviewSeries")).status).toBe(
          "applied",
        );
      const preview =
        operation === "link"
          ? await t.query(internal.heldBooks.previewInternal, args(s))
          : await review(t, s);
      expect(preview.refusal).toBeNull();
      await change(t, s);
      const before = await t.run(async (ctx) =>
        valueHash({
          observation: await ctx.db.get(s.observationId),
          hold: await ctx.db.get(s.holdId),
          ledger: await ctx.db.query("heldRepairLedger").collect(),
        }),
      );
      expect((await execute(t, s, preview.expected!, operation)).status).toBe("refused");
      expect(
        await t.run(async (ctx) =>
          valueHash({
            observation: await ctx.db.get(s.observationId),
            hold: await ctx.db.get(s.holdId),
            ledger: await ctx.db.query("heldRepairLedger").collect(),
          }),
        ),
      ).toBe(before);
    });
for (const operation of ["reviewSeries", "link"] as const)
  it(`rolls back ${operation} if audit fails after mutation`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    if (operation === "link") await execute(t, s, (await review(t, s)).expected!, "reviewSeries");
    const preview =
      operation === "link"
        ? await t.query(internal.heldBooks.previewInternal, args(s))
        : await review(t, s);
    const before = await t.run(async (ctx) =>
      valueHash({
        observation: await ctx.db.get(s.observationId),
        hold: await ctx.db.get(s.holdId),
        proposals: await ctx.db.query("proposals").collect(),
        ledger: await ctx.db.query("heldRepairLedger").collect(),
      }),
    );
    fault.audit = true;
    expect((await execute(t, s, preview.expected!, operation)).status).toBe("refused");
    fault.audit = false;
    expect(
      await t.run(async (ctx) =>
        valueHash({
          observation: await ctx.db.get(s.observationId),
          hold: await ctx.db.get(s.holdId),
          proposals: await ctx.db.query("proposals").collect(),
          ledger: await ctx.db.query("heldRepairLedger").collect(),
        }),
      ),
    ).toBe(before);
  });
it("does not parse unrelated or implicit Episode titles", () => {
  for (const title of [
    "Umineko When They Cry Volume 1",
    "Umineko When They Cry Part 2: Turn of the Golden Witch Volume 1",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Chapters 1-6",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Volume ?",
    "Higurashi When They Cry Episode 2: Turn of the Golden Witch Volume 1",
  ])
    expect(episodeTitle(title)).toBeNull();
});

for (const [name, change] of [
  [
    "parent link redirected",
    async (t: TestT, s: Seed) =>
      t.run(async (ctx) => {
        const other = await insertSeries(ctx, { title: "Other work" });
        await ctx.db.patch(s.parentId, { recordRef: { type: "series", id: other } });
      }),
  ],
  [
    "new parent hold",
    async (t: TestT, s: Seed) =>
      t.run(async (ctx) => {
        await ctx.db.insert("placementHolds", {
          sourceKey: "ann",
          observationId: s.parentId,
          kind: "isbn",
          heldAt: 2,
        });
      }),
  ],
  [
    "target locked",
    async (t: TestT, s: Seed) => t.run((ctx) => ctx.db.patch(s.releaseId, { locked: true })),
  ],
  [
    "umbrella locked",
    async (t: TestT, s: Seed) => t.run((ctx) => ctx.db.patch(s.umbrellaId, { locked: true })),
  ],
  [
    "canonical work renamed",
    async (t: TestT, s: Seed) => t.run((ctx) => ctx.db.patch(s.seriesId, { title: "Other work" })),
  ],
  [
    "publisher renamed",
    async (t: TestT, s: Seed) =>
      t.run((ctx) => ctx.db.patch(s.publisherId, { name: "Other Press" })),
  ],
  [
    "edition publisher changed",
    async (t: TestT, s: Seed) =>
      t.run(async (ctx) => {
        const other = await insertPublisher(ctx, { name: "Other Press" });
        await ctx.db.patch(s.editionId, { publisherId: other });
      }),
  ],
] as const)
  for (const operation of ["reviewSeries", "link"] as const)
    it(`r1 rejects drift: ${name} during ${operation}`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      if (operation === "link") await execute(t, s, (await review(t, s)).expected!, "reviewSeries");
      const preview =
        operation === "link"
          ? await t.query(internal.heldBooks.previewInternal, args(s))
          : await review(t, s);
      await change(t, s);
      const before = valueHash(await preserved(t, s));
      const ledgerBefore = await t.run((ctx) => ctx.db.query("heldRepairLedger").collect());
      expect((await execute(t, s, preview.expected!, operation)).status).toBe("refused");
      expect(valueHash(await preserved(t, s))).toBe(before);
      expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toEqual(
        ledgerBefore,
      );
    });

it("r1 retries require fresh guards and never duplicate ledger or links", async () => {
  const t = makeT({ transactionLimits: true });
  const s = await seed(t);
  const ready = await review(t, s);
  expect((await execute(t, s, ready.expected!, "reviewSeries")).status).toBe("applied");
  expect((await execute(t, s, ready.expected!, "reviewSeries")).status).toBe("refused");
  const refreshed = await review(t, s);
  expect((await execute(t, s, refreshed.expected!, "reviewSeries")).status).toBe("alreadyApplied");
  const link = await t.query(internal.heldBooks.previewInternal, args(s));
  expect((await execute(t, s, link.expected!, "link")).status).toBe("applied");
  expect((await execute(t, s, link.expected!, "link")).status).toBe("refused");
  expect(await t.run((ctx) => ctx.db.query("heldRepairLedger").collect())).toHaveLength(2);
});

const ordinalContradictions: Array<[string, (parent: AnnMangaSnapshot, s: Seed) => void]> = [
  [
    "Astra retained sibling Special Edition suffix",
    (parent, s) => {
      const sibling = parent.releases.find(
        (member) =>
          member.label === s.reviewed.episodeRouting.sourceGlobalLabel &&
          member.annId !== episodeCases[0]!.snapshot.annId,
      )!;
      sibling.title =
        "Umineko When They Cry Episode 3: Banquet of the Golden Witch Volume 1 (Special Edition)";
    },
  ],
  ...[
    "Higurashi When They Cry Volume 1",
    "Umineko When They Cry Volume 1",
    "Umineko When They Cry Episode 3: Banquet of the Golden Witch Volume ?",
    "Umineko When They Cry Episode 3: Banquet of the Golden Witch Volume 1-2",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Volume ?",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Volume 1-2",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Volume 1 Box Set",
    "Umineko When They Cry Episode 3: Banquet of the Golden Witch Volume 1",
    "Umineko When They Cry Episode 2: Turn of the Golden Witch Volume 2",
  ].map((title): [string, (parent: AnnMangaSnapshot, s: Seed) => void] => [
    title,
    (parent, s) => {
      parent.releases.push({
        annId: "r1-contradiction",
        date: { day: 1, month: 1, year: 2013 },
        title,
        isbn13: "9780316229524",
        format: "physical",
        label: s.reviewed.episodeRouting.sourceGlobalLabel,
        multi: false,
        editionLineHint: false,
      });
    },
  ]),
  ...[
    ["retained sibling range and multi", { multi: true, coverRange: { from: "1", to: "2" } }],
    ["retained sibling range alone", { coverRange: { from: "1", to: "2" } }],
    ["retained sibling unresolved multi", { multi: true }],
    ["retained sibling package", { editionLineHint: true }],
    ["retained sibling gap", { coverageGapped: true }],
  ].map(([name, facts]): [string, (parent: AnnMangaSnapshot, s: Seed) => void] => [
    String(name),
    (parent, s) => {
      const sibling = parent.releases.find(
        (member) =>
          member.title === s.reviewed.episodeRouting.sourceTitle &&
          member.annId !== episodeCases[0]!.snapshot.annId,
      )!;
      Object.assign(sibling, facts);
    },
  ]),
];

/** Include observation, hold and audit tables as well as the complete preserved graph. */
async function mutationState(t: TestT, s: Seed) {
  return valueHash({
    graph: await preserved(t, s),
    mutable: await t.run(async (ctx) => ({
      observation: await ctx.db.get(s.observationId),
      hold: await ctx.db.get(s.holdId),
      ledger: await ctx.db.query("heldRepairLedger").collect(),
      proposals: await ctx.db.query("proposals").collect(),
      versions: await ctx.db.query("proposalVersions").collect(),
      series: await ctx.db.query("series").collect(),
    })),
  });
}
for (const [name, change] of ordinalContradictions)
  for (const operation of ["reviewSeries", "link"] as const)
    it(`r2 refuses selected ordinal ${name} during ${operation}, fresh and stale`, async () => {
      const t = makeT({ transactionLimits: true });
      const s = await seed(t);
      if (operation === "link")
        expect((await execute(t, s, (await review(t, s)).expected!, "reviewSeries")).status).toBe(
          "applied",
        );
      const preview =
        operation === "link"
          ? await t.query(internal.heldBooks.previewInternal, args(s))
          : await review(t, s);
      expect(preview.refusal).toBeNull();
      await parentEdit(t, s, (parent) => change(parent, s));
      const before = await mutationState(t, s);
      for (const blocked of [
        await review(t, s),
        await t.query(internal.heldBooks.previewInternal, args(s)),
      ]) {
        expect(["blocked", "incomplete"]).toContain(blocked.classification);
        expect(blocked.refusal).toContain("Episode routing:");
        expect(blocked.expected).toBeNull();
      }
      // A stale successful guard and a forced call after a fresh refusal both rerun the route.
      // A blocked fresh preview deliberately issues no valid execute token.
      for (const expected of [preview.expected!, "blocked-preview-has-no-executable-guard"]) {
        const result = await execute(t, s, expected, operation);
        expect(result.status).toBe("refused");
        expect(result.reason).toContain("Episode routing:");
        expect(await mutationState(t, s)).toBe(before);
      }
    });

for (const format of ["physical", "digital"] as const)
  it(`r2 permits another unambiguous ${format} printing at the selected ordinal`, async () => {
    const t = makeT({ transactionLimits: true });
    const s = await seed(t);
    await parentEdit(t, s, (parent) => {
      parent.releases.push({
        annId: `another-${format}-printing`,
        title: s.reviewed.episodeRouting.sourceTitle,
        label: s.reviewed.episodeRouting.sourceGlobalLabel,
        format,
        multi: false,
        editionLineHint: false,
      });
    });
    const ready = await review(t, s);
    expect(ready.refusal).toBeNull();
    expect((await execute(t, s, ready.expected!, "reviewSeries")).status).toBe("applied");
    const link = await t.query(internal.heldBooks.previewInternal, args(s));
    expect(link.refusal).toBeNull();
    expect((await execute(t, s, link.expected!, "link")).status).toBe("applied");
  });
