import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { parseEditionJson } from "./lib/openLibrary";
import { contentRefusal, readTitledRecord } from "./printings";
import { numberedSubtitles } from "./test.numberedSubtitles";
import { makeT, type TestT } from "./test.helpers";
import { insertBook } from "./test.moderation";
import {
  insertCoverage,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertSeries,
  insertSourceRevision,
  insertVolume,
} from "./test.factories";

const work = "Lone Wolf and Cub";
const row = numberedSubtitles[0]!;
const evidenceUrls = [
  "https://images.darkhorse.com/common/salestools/catalogs/DH_Backlist_2009.pdf",
];

async function setup(t: TestT, original: (typeof numberedSubtitles)[number] = row) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "test-admin",
      username: "repair-test",
      usernameNormalized: "repair-test",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, { name: "Dark Horse", slug: "dark-horse" });
    const seriesId = await insertSeries(ctx, { title: work });
    const label = original.snapshot.bareSplit.volumeLabel;
    const volumeId = await insertVolume(ctx, { seriesId, label, position: Number(label) });
    const book = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      release: { isbn13: original.snapshot.isbn13, binding: "paperback" },
    });
    // A distinct deluxe product in the occupied slot must not be changed.
    const editionLineId = await insertEditionLine(ctx, {
      publisherId,
      seriesId,
      name: "Deluxe Edition",
    });
    const deluxe = await insertBook(ctx, {
      publisherId,
      seriesId,
      volumeId,
      edition: { editionLineId, linePosition: "1" },
      release: { isbn13: "9781506747613", binding: "hardcover" },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "openlibrary",
      sourceRecordId: original.snapshot.key,
      snapshot: original.snapshot,
      lastSeenAt: original.lastSeenAt,
      conflicts: original.conflicts.map((c) => ({ ...c })),
    });
    const holdId = await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "openlibrary",
      kind: "isbn",
      seriesId,
      heldAt: 10,
    });
    await ctx.db.insert("releaseProgress", {
      userId,
      releaseId: book.releaseId,
      seriesId,
      percent: 35,
    });
    await ctx.db.insert("volumeProgress", { userId, volumeId, readCount: 2 });
    await insertSourceRevision(ctx, {
      sourceKey: "openlibrary",
      ref: { type: "release", id: book.releaseId },
      changes: [],
    });
    return { ...book, deluxe, publisherId, seriesId, volumeId, observationId, holdId, userId };
  });
}
function argsFor(
  s: Awaited<ReturnType<typeof setup>>,
  original: (typeof numberedSubtitles)[number] = row,
) {
  return {
    observationId: s.observationId,
    target: { type: "release" as const, id: s.releaseId },
    reviewed: {
      isbn13: original.snapshot.isbn13,
      seriesId: s.seriesId,
      publisherId: s.publisherId,
      volumeIds: [s.volumeId],
      sourceTitle: original.snapshot.title,
      evidenceUrls,
    },
  };
}
async function state(t: TestT) {
  return t.run(async (ctx) => ({
    releases: await ctx.db.query("releases").collect(),
    editions: await ctx.db.query("editions").collect(),
    volumes: await ctx.db.query("volumes").collect(),
    coverage: await ctx.db.query("volumeCoverages").collect(),
    progress: await ctx.db.query("releaseProgress").collect(),
    volumeProgress: await ctx.db.query("volumeProgress").collect(),
    revisions: await ctx.db.query("revisions").collect(),
    observations: await ctx.db.query("sourceObservations").collect(),
    holds: await ctx.db.query("placementHolds").collect(),
    ledger: await ctx.db.query("heldRepairLedger").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    series: await ctx.db.query("series").collect(),
    publishers: await ctx.db.query("publishers").collect(),
    editionLines: await ctx.db.query("editionLines").collect(),
    releaseIsbns: await ctx.db.query("releaseIsbns").collect(),
    observationSnapshots: await ctx.db.query("observationSnapshots").collect(),
    proposalVersions: await ctx.db.query("proposalVersions").collect(),
    collectionEntries: await ctx.db.query("collectionEntries").collect(),
    userSeriesStates: await ctx.db.query("userSeriesStates").collect(),
    counters: await ctx.db.query("counters").collect(),
    catalogCounts: await ctx.db.query("catalogCounts").collect(),
  }));
}

describe("independently resolved numbered subtitles", () => {
  const digitalCounterfacts = [
    { name: "retained eBook", fields: { subtitle: "eBook" } },
    { name: "retained Kindle", fields: { subtitle: "Kindle" } },
    { name: "retained Digital Edition", fields: { subtitle: "Digital Edition" } },
    { name: "dedicated binding eBook", fields: { binding: "eBook" } },
    { name: "dedicated physicalFormat eBook", fields: { physicalFormat: "eBook" } },
  ];

  it.each(digitalCounterfacts)(
    "refuses $name in both previews and fresh/stale execute without writes",
    async ({ fields }) => {
      const t = makeT();
      const s = await setup(t);
      const reviewed = argsFor(s);
      const ordinary = { observationId: s.observationId, target: reviewed.target };
      const inputs = [ordinary, reviewed];
      const stale = await Promise.all(
        inputs.map((input) => t.query(internal.heldBooks.previewInternal, input)),
      );
      for (const preview of stale) {
        expect(preview).toMatchObject({ classification: "linkReady", refusal: null });
        expect(preview.expected).toBeTruthy();
      }
      await t.run((ctx) =>
        ctx.db.patch(s.observationId, { snapshot: { ...row.snapshot, ...fields } }),
      );
      const before = await state(t);
      for (const [index, input] of inputs.entries()) {
        const fresh = await t.query(internal.heldBooks.previewInternal, input);
        expect(fresh.classification).not.toBe("linkReady");
        expect(fresh.refusal).toBeTruthy();
        expect(fresh.expected).toBeTruthy();
        expect(await state(t)).toEqual(before);
        for (const expected of [fresh.expected!, stale[index]!.expected!]) {
          const result = await t.mutation(internal.heldBooks.executeInternal, {
            ...input,
            actor: "repair-test",
            operation: "link",
            expected,
            reason: "In-memory digital counterfact regression.",
            evidenceUrls,
          });
          expect(result.status).toBe("refused");
          expect(await state(t)).toEqual(before);
        }
      }
    },
  );

  const dedicatedDescriptions = [
    "Adobe eBook",
    "Electronic resource",
    "eBook EPUB",
    "eBook (EPUB)",
    "EPUB",
    "PDF",
    "Kindle Edition",
    "Digital download",
    "MOBI",
    "AZW3",
    "Online resource",
    "Paperback / EPUB",
    "EPUB / Paperback",
    "Paperback; electronic resource",
    "e&#66;ook&nbsp;EPUB",
    "ＥＰＵＢ",
    "e–book (PDF)",
    "Unknown",
    "Digital adventures",
    "Paperback unknown",
    "Paperback Vol. 3",
    "EPUB mysterious",
    "???",
    123,
    { format: "paperback" },
  ];
  const dedicatedCounterfacts = dedicatedDescriptions.flatMap((value) =>
    ["binding", "physicalFormat"].flatMap((field) =>
      ["physical", "missing"].map((format) => ({ value, field, format })),
    ),
  );
  it.each(dedicatedCounterfacts)(
    "refuses dedicated $field=$value with $format format in ordinary/reviewed fresh/stale execution",
    async ({ value, field, format }) => {
      const t = makeT();
      const s = await setup(t);
      const reviewed = argsFor(s);
      const inputs = [{ observationId: s.observationId, target: reviewed.target }, reviewed];
      const stale = await Promise.all(
        inputs.map((input) => t.query(internal.heldBooks.previewInternal, input)),
      );
      for (const preview of stale)
        expect(preview).toMatchObject({ classification: "linkReady", refusal: null });
      await t.run((ctx) =>
        ctx.db.patch(s.observationId, {
          snapshot: {
            ...row.snapshot,
            [field]: value,
            format: format === "missing" ? undefined : format,
          },
        }),
      );
      const before = await state(t);
      for (const [index, input] of inputs.entries()) {
        const fresh = await t.query(internal.heldBooks.previewInternal, input);
        expect(fresh.classification).not.toBe("linkReady");
        expect(fresh.refusal).toBeTruthy();
        expect(fresh.expected).toBeTruthy();
        expect(await state(t)).toEqual(before);
        for (const expected of [fresh.expected!, stale[index]!.expected!]) {
          const result = await t.mutation(internal.heldBooks.executeInternal, {
            ...input,
            actor: "repair-test",
            operation: "link",
            expected,
            reason: "Dedicated format must not certify a contradictory or unreadable product.",
            evidenceUrls,
          });
          expect(result.status).toBe("refused");
          expect(await state(t)).toEqual(before);
        }
      }
    },
  );

  it.each([
    "Paperback",
    "Trade paperback",
    "Mass-market paperback",
    "Soft cover",
    "Softbound",
    "Paper&#98;ack",
    "Printed book",
    "Physical format",
  ])("preserves dedicated physical %s through both guarded transactions", async (value) => {
    for (const reviewed of [false, true]) {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      await t.run((ctx) =>
        ctx.db.patch(s.observationId, {
          snapshot: { ...row.snapshot, binding: value, physicalFormat: value },
        }),
      );
      const input = reviewed ? args : { observationId: s.observationId, target: args.target };
      const before = await state(t);
      const fresh = await t.query(internal.heldBooks.previewInternal, input);
      expect(fresh).toMatchObject({ classification: "linkReady", refusal: null });
      const result = await t.mutation(internal.heldBooks.executeInternal, {
        ...input,
        actor: "repair-test",
        operation: "link",
        expected: fresh.expected!,
        reason: "Legitimate dedicated physical format regression.",
        evidenceUrls,
      });
      expect(result.status).toBe("applied");
      const after = await state(t);
      expect(after.observations[0]!.snapshot).toEqual(before.observations[0]!.snapshot);
      expect(after.releases).toEqual(before.releases);
      expect(after.coverage).toEqual(before.coverage);
      expect(after.revisions).toEqual(before.revisions);
      expect(after.progress).toEqual(before.progress);
      expect(after.holds).toEqual([]);
      expect(after.ledger).toHaveLength(1);
    }
  });

  it.each([
    "Electronic resource",
    "eBook EPUB",
    "EPUB FXL Manga RTL",
    "PDF",
    "Kindle Edition",
    "e&#66;ook&nbsp;EPUB",
  ])("keeps matching dedicated digital %s eligible in both guards", async (value) => {
    const t = makeT();
    const s = await setup(t);
    const args = argsFor(s);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.releaseId, { format: "digital", binding: undefined });
      await ctx.db.patch(s.observationId, {
        snapshot: { ...row.snapshot, format: "digital", binding: value, physicalFormat: value },
      });
    });
    const before = await state(t);
    for (const input of [args, { observationId: s.observationId, target: args.target }])
      expect(await t.query(internal.heldBooks.previewInternal, input)).toMatchObject({
        classification: "linkReady",
        refusal: null,
      });
    expect(await state(t)).toEqual(before);
  });

  it.each(["Paperback / EPUB", "EPUB mysterious", "Paperback", "Unknown"])(
    "refuses dedicated %s even on a digital source/target",
    async (value) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      await t.run(async (ctx) => {
        await ctx.db.patch(s.releaseId, { format: "digital", binding: undefined });
        await ctx.db.patch(s.observationId, {
          snapshot: {
            ...row.snapshot,
            format: "digital",
            binding: undefined,
            physicalFormat: value,
          },
        });
      });
      const before = await state(t);
      for (const input of [args, { observationId: s.observationId, target: args.target }]) {
        const fresh = await t.query(internal.heldBooks.previewInternal, input);
        expect(fresh.refusal).toBeTruthy();
        const result = await t.mutation(internal.heldBooks.executeInternal, {
          ...input,
          actor: "repair-test",
          operation: "link",
          expected: fresh.expected!,
          reason: "Mixed/unknown dedicated digital format regression.",
          evidenceUrls,
        });
        expect(result.status).toBe("refused");
        expect(await state(t)).toEqual(before);
      }
    },
  );

  it.each([
    "binding",
    "physicalFormat",
    "retained subtitle",
    "extracted subtitle",
    "adapter mixed field",
  ])(
    "refuses digital source/target with physical %s in both fresh/stale transactions",
    async (where) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      await t.run(async (ctx) => {
        await ctx.db.patch(s.releaseId, { format: "digital", binding: undefined });
        await ctx.db.patch(s.observationId, {
          snapshot: {
            ...row.snapshot,
            format: "digital",
            binding: "eBook",
            physicalFormat: "EPUB",
          },
        });
      });
      const inputs = [args, { observationId: s.observationId, target: args.target }];
      const stale = await Promise.all(
        inputs.map((input) => t.query(internal.heldBooks.previewInternal, input)),
      );
      for (const preview of stale)
        expect(preview).toMatchObject({ classification: "linkReady", refusal: null });
      const parsed = parseEditionJson({
        key: row.snapshot.key,
        title: "Lone Wolf and Cub 2",
        subtitle: "The Gateless Barrier",
        isbn_13: [row.snapshot.isbn13],
        publishers: ["Dark Horse"],
        physical_format: "Paperback / eBook",
      });
      expect(parsed).toMatchObject({ format: "digital", physicalFormat: "Paperback / eBook" });
      const title = where === "extracted subtitle" ? `${work} 2: Hardcover` : row.snapshot.title;
      const snapshot =
        where === "adapter mixed field"
          ? parsed
          : {
              ...row.snapshot,
              title,
              format: "digital",
              binding: where === "binding" ? "paperback" : "eBook",
              physicalFormat: where === "physicalFormat" ? "Paperback" : "EPUB",
              ...(where === "retained subtitle" ? { subtitle: "Hardcover" } : {}),
            };
      await t.run((ctx) => ctx.db.patch(s.observationId, { snapshot }));
      const before = await state(t);
      for (const [index, original] of inputs.entries()) {
        const input =
          "reviewed" in original
            ? { ...original, reviewed: { ...original.reviewed, sourceTitle: title } }
            : original;
        const fresh = await t.query(internal.heldBooks.previewInternal, input);
        expect(fresh.refusal).toBeTruthy();
        expect(fresh.classification).not.toBe("linkReady");
        for (const expected of [fresh.expected!, stale[index]!.expected!]) {
          const result = await t.mutation(internal.heldBooks.executeInternal, {
            ...input,
            actor: "repair-test",
            operation: "link",
            expected,
            reason: "Physical metadata contradicts a digital source even with no target binding.",
            evidenceUrls,
          });
          expect(result.status).toBe("refused");
          expect(await state(t)).toEqual(before);
        }
      }
    },
  );

  it.each(["extracted", "retained"])("keeps %s Digital adventures as prose", async (where) => {
    const t = makeT();
    const s = await setup(t);
    const args = argsFor(s);
    const title = where === "extracted" ? `${work} 2: Digital adventures` : row.snapshot.title;
    const snapshot = {
      ...row.snapshot,
      title,
      ...(where === "retained" ? { subtitle: "Digital adventures" } : {}),
    };
    await t.run((ctx) => ctx.db.patch(s.observationId, { snapshot }));
    for (const input of [
      { observationId: s.observationId, target: args.target },
      { ...args, reviewed: { ...args.reviewed, sourceTitle: title } },
    ])
      expect(await t.query(internal.heldBooks.previewInternal, input)).toMatchObject({
        classification: "linkReady",
        refusal: null,
      });
    expect((await state(t)).observations[0]!.snapshot).toEqual(snapshot);
  });

  it.each(["Digital Edition", "Kindle", "eBook"])(
    "preserves the authentic declared work name %s",
    async (name) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      const title = `${name} 2: The Gateless Barrier`;
      await t.run(async (ctx) => {
        await ctx.db.patch(s.seriesId, { title: name, searchText: name });
        await ctx.db.patch(s.observationId, {
          snapshot: {
            ...row.snapshot,
            title,
            seriesTitle: title,
            bareSplit: { seriesTitle: name, volumeLabel: "2" },
          },
        });
      });
      for (const input of [
        { observationId: s.observationId, target: args.target },
        { ...args, reviewed: { ...args.reviewed, sourceTitle: title } },
      ])
        expect(await t.query(internal.heldBooks.previewInternal, input)).toMatchObject({
          classification: "linkReady",
          refusal: null,
        });
    },
  );

  it.each(["physical", "digital", "missing"])(
    "keeps known digital evidence consistent with %s stored source format",
    async (format) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      await t.run(async (ctx) => {
        await ctx.db.patch(s.releaseId, { format: "digital", binding: undefined });
        await ctx.db.patch(s.observationId, {
          snapshot: {
            ...row.snapshot,
            format: format === "missing" ? undefined : format,
            binding: "eBook",
            physicalFormat: "eBook",
            subtitle: "Digital Edition",
          },
        });
      });
      const before = await state(t);
      for (const input of [args, { observationId: s.observationId, target: args.target }]) {
        const preview = await t.query(internal.heldBooks.previewInternal, input);
        if (format === "digital")
          expect(preview).toMatchObject({ classification: "linkReady", refusal: null });
        else {
          expect(preview.refusal).toBeTruthy();
          expect(preview.classification).not.toBe("linkReady");
        }
      }
      expect(await state(t)).toEqual(before);
    },
  );

  it.each(numberedSubtitles)("reads and guards original $snapshot.title", async (original) => {
    const t = makeT();
    const s = await setup(t, original);
    const args = argsFor(s, original);
    const reading = readTitledRecord(
      "openlibrary",
      original.snapshot.title,
      original.snapshot,
      [work],
      { seriesId: s.seriesId, names: [work], parentTitle: null },
    );
    expect(reading).toMatchObject({
      work,
      label: original.snapshot.bareSplit.volumeLabel,
      binding: "paperback",
      packaging: [],
      scope: [],
      unreadable: [],
    });
    for (const previewArgs of [args, { observationId: s.observationId, target: args.target }]) {
      const preview = await t.query(internal.heldBooks.previewInternal, previewArgs);
      expect(preview).toMatchObject({ classification: "linkReady", refusal: null });
      expect(preview.expected).toBeTruthy();
    }
    const before = await state(t);
    const preview = await t.query(internal.heldBooks.previewInternal, args);
    const result = await t.mutation(internal.heldBooks.executeInternal, {
      ...args,
      actor: "repair-test",
      operation: "link",
      expected: preview.expected!,
      reason: "Exact ISBN original single reviewed.",
      evidenceUrls,
    });
    expect(result.status).toBe("applied");
    const after = await state(t);
    expect(after.releases).toEqual(before.releases);
    expect(after.editions).toEqual(before.editions);
    expect(after.volumes).toEqual(before.volumes);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.observations[0]).toMatchObject({
      snapshot: original.snapshot,
      lastSeenAt: original.lastSeenAt,
      recordRef: { type: "release", id: s.releaseId },
    });
    expect(after.holds).toEqual([]);
    expect(after.ledger).toHaveLength(1);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.progress).toEqual(before.progress);
    expect(after.volumeProgress).toEqual(before.volumeProgress);
  });

  it("requires source context and preserves whole-name matching", async () => {
    const t = makeT();
    const s = await setup(t);
    const context = { seriesId: s.seriesId, names: [work], parentTitle: null };
    for (const supplied of [
      undefined,
      { ...context, names: ["Other Work"] },
      { ...context, names: [work, row.snapshot.title] },
    ]) {
      expect(
        readTitledRecord("openlibrary", row.snapshot.title, row.snapshot, [work], supplied).work,
      ).toBe(row.snapshot.title);
    }
    await t.run(async (ctx) => {
      const observation = (await ctx.db.get(s.observationId))!;
      const release = (await ctx.db.get(s.releaseId))!;
      const series = [(await ctx.db.get(s.seriesId))!];
      expect(await contentRefusal(ctx, observation, release, series)).toBeTruthy();
      const other = await insertSeries(ctx, { title: "Other Work" });
      expect(
        await contentRefusal(ctx, observation, release, series, { ...context, seriesId: other }),
      ).toBeTruthy();
    });
  });

  it.each(["Part 2", "Episode 2", "II", "2-4", "2 / 4"])(
    "does not peel %s before a subtitle",
    async (number) => {
      const t = makeT();
      const s = await setup(t);
      const title = `${work} ${number}: Subtitle`;
      const reading = readTitledRecord("openlibrary", title, { title }, [work], {
        seriesId: s.seriesId,
        names: [work, `${work} Part`, `${work} Episode`],
        parentTitle: null,
      });
      // Explicit Part and range grammar remains owned by the existing parser.
      // The new contextual branch must produce exactly the old reading.
      expect(reading).toEqual(readTitledRecord("openlibrary", title, { title }, [work]));
    },
  );

  it.each([
    "Vol. 3",
    "Includes Vols. 2-4",
    "Vol. unknown",
    "Light Novel",
    "eBook",
    "Hardcover",
    "Omnibus",
    "[2-4]",
    "(French Edition)",
  ])("keeps embedded technical counterfacts: %s", async (subtitle) => {
    const t = makeT();
    const s = await setup(t);
    const args = argsFor(s);
    const title = `${work} 2: ${subtitle}`;
    await t.run((ctx) => ctx.db.patch(s.observationId, { snapshot: { ...row.snapshot, title } }));
    for (const previewArgs of [
      { ...args, reviewed: { ...args.reviewed, sourceTitle: title } },
      { observationId: s.observationId, target: args.target },
    ]) {
      const preview = await t.query(internal.heldBooks.previewInternal, previewArgs);
      expect(preview.refusal).toBeTruthy();
      expect(preview.classification).not.toBe("linkReady");
    }
  });

  it("compares extracted and retained subtitles together without letting target names own their facts", async () => {
    const t = makeT();
    const s = await setup(t);
    const title = `${work} 2: Vol. 3; Hardcover`;
    const reading = readTitledRecord(
      "openlibrary",
      title,
      { title, subtitle: "Vol. 2; Paperback", binding: "paperback" },
      [title],
      { seriesId: s.seriesId, names: [work], parentTitle: null },
    );
    expect(reading.work).toBe(work);
    expect(reading.unreadable.some((text) => text.includes("Volume 3"))).toBe(true);
    expect(reading.unreadable.some((text) => text.includes("hardcover"))).toBe(true);
  });

  it.each(["publisher", "series", "coverage", "partial", "isbn owner"])(
    "still refuses conflicting canonical %s",
    async (conflict) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      await t.run(async (ctx) => {
        if (conflict === "publisher") {
          const publisherId = await insertPublisher(ctx, { name: "Other Press" });
          await ctx.db.patch(s.releaseId, { publisherId });
        } else if (conflict === "series") {
          const seriesId = await insertSeries(ctx, { title: "Other Work" });
          await ctx.db.patch(s.releaseId, { seriesIds: [seriesId] });
        } else if (conflict === "coverage") {
          const volumeId = await insertVolume(ctx, {
            seriesId: s.seriesId,
            label: "3",
            position: 3,
          });
          await insertCoverage(ctx, { editionId: s.editionId, volumeId, order: 2 });
        } else if (conflict === "partial") {
          const coverage = await ctx.db
            .query("volumeCoverages")
            .withIndex("by_edition", (q) => q.eq("editionId", s.editionId))
            .unique();
          await ctx.db.patch(coverage!._id, { extent: "partial" });
        } else if (conflict === "isbn owner") {
          await ctx.db.patch(s.deluxe.releaseId, { isbn13: row.snapshot.isbn13 });
        }
      });
      const before = await state(t);
      expect((await t.query(internal.heldBooks.previewInternal, args)).refusal).toBeTruthy();
      expect(await state(t)).toEqual(before);
    },
  );

  it.each(["snapshot", "target revision", "hold", "parent resolution", "bootstrap", "claims"])(
    "refuses an old preview after %s changes, with no incidental writes",
    async (changed) => {
      const t = makeT();
      const s = await setup(t);
      const args = argsFor(s);
      const preview = await t.query(internal.heldBooks.previewInternal, args);
      expect(preview.refusal).toBeNull();
      await t.run(async (ctx) => {
        if (changed === "snapshot")
          await ctx.db.patch(s.observationId, {
            snapshot: { ...row.snapshot, subtitle: "Display prose" },
          });
        else if (changed === "target revision")
          await insertSourceRevision(ctx, {
            sourceKey: "openlibrary",
            ref: args.target,
            changes: [],
          });
        else if (changed === "hold") await ctx.db.patch(s.holdId, { heldAt: 20 });
        else if (changed === "parent resolution")
          await ctx.db.patch(s.seriesId, { altTitles: ["New declaration"] });
        else if (changed === "bootstrap")
          await ctx.db.insert("appConfig", { bootstrapMode: true, seriesPacksReady: true });
        else await ctx.db.patch(s.deluxe.releaseId, { isbn13: row.snapshot.isbn13 });
      });
      const before = await state(t);
      const result = await t.mutation(internal.heldBooks.executeInternal, {
        ...args,
        actor: "repair-test",
        operation: "link",
        expected: preview.expected!,
        reason: "Exact ISBN original single reviewed.",
        evidenceUrls,
      });
      expect(result.status).toBe("refused");
      expect(await state(t)).toEqual(before);
    },
  );
});
