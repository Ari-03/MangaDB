// Exact own-ISBN reviews of two ANN line titles the ANN grammar alone cannot
// read: a spelled "Book One" position and an edition descriptor before a line
// word. Each reading must agree with every other source fact and the target.
import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { makeT, type TestT } from "./test.helpers";
import {
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";

type Line = {
  work: string;
  altTitles?: string[];
  parentTitle: string;
  lineName: string;
  linePosition?: string;
  labels: string[];
  title: string;
  volume: string;
  binding: "hardcover" | "paperback";
};

/** One held ANN line, its parent and one Edition Line member covering `labels`. */
async function setup(t: TestT, line: Line) {
  const isbn13 = "9781506752860";
  const snapshot = {
    kind: "annRelease",
    annId: "54073",
    mangaId: "3987",
    title: line.title,
    isbn13,
    format: "physical",
    multi: true,
    editionLineHint: true,
    coverRange: { from: line.labels[0]!, to: line.labels.at(-1)! },
    page: {
      status: "ok",
      title: line.title,
      isbn13,
      mangaId: "3987",
      volume: line.volume,
      distributor: "Dark Horse Comics",
    },
  };
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, {
      name: "Dark Horse Comics",
      slug: "dark-horse",
    });
    const seriesId = await insertSeries(ctx, { title: line.work, altTitles: line.altTitles ?? [] });
    const volumeIds = [];
    for (const [i, label] of line.labels.entries())
      volumeIds.push(
        await insertVolume(ctx, { seriesId, label, position: Number(label) || i + 1 }),
      );
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: line.lineName });
    const editionId = await insertEdition(ctx, {
      publisherId,
      editionLineId: lineId,
      linePosition: line.linePosition,
    });
    for (const [i, volumeId] of volumeIds.entries())
      await insertCoverage(ctx, { editionId, volumeId, order: i + 1 });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13,
      binding: line.binding,
    });
    const parentId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:3987",
      snapshot: { kind: "annManga", id: "3987", title: line.parentTitle },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:54073",
      snapshot,
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "isbn",
      seriesId,
      heldAt: 1,
    });
    return {
      publisherId,
      seriesId,
      volumeIds,
      lineId,
      editionId,
      releaseId,
      parentId,
      observationId,
    };
  });
  const reviewed = {
    isbn13,
    seriesId: ids.seriesId,
    publisherId: ids.publisherId,
    volumeIds: ids.volumeIds,
    sourceTitle: line.title,
    evidenceUrls: [`https://www.penguinrandomhouse.com/books/${isbn13}`],
  };
  const refusal = async (review: Partial<typeof reviewed> | null = {}) =>
    (
      await t.query(internal.heldBooks.previewInternal, {
        observationId: ids.observationId,
        target: { type: "release", id: ids.releaseId },
        ...(review === null ? {} : { reviewed: { ...reviewed, ...review } }),
      })
    ).refusal;
  const retitle = (title: string, volume = line.volume) =>
    t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: { ...snapshot, title, page: { ...snapshot.page, title, volume } },
      }),
    );
  return { ids, refusal, retitle, snapshot };
}

const oldboy: Line = {
  work: "Old Boy",
  altTitles: ["Oldboy"],
  parentTitle: "Old Boy",
  lineName: "Deluxe Edition",
  linePosition: "1",
  labels: ["1", "2", "3", "4"],
  title: "Oldboy Deluxe Edition: Book One [Hardcover]",
  volume: "GN 1-4",
  binding: "hardcover",
};

it("reads a reviewed spelled Book position only where every fact and the target agree", async () => {
  const t = makeT();
  const { ids, refusal, retitle } = await setup(t, oldboy);
  expect(await refusal()).toBeNull();
  // No exact review: the ANN grammar's unread position stands.
  expect(await refusal(null)).toBeTruthy();
  expect(await refusal({ sourceTitle: "Oldboy Deluxe Edition: Book 1 [Hardcover]" })).toBeTruthy();
  // The target's position must be the spelled one.
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "2" }));
  expect(await refusal()).toBe("Known Edition Line name or position differs.");
  await t.run((ctx) => ctx.db.patch(ids.editionId, { linePosition: "1" }));
  // A second number, a number word the rule does not read, or a spelled
  // number the line's stated range contradicts stays a conflict.
  for (const [title, volume] of [
    ["Oldboy Deluxe Edition: Book One (Vol. 2) [Hardcover]", "GN 1-4"],
    ["Oldboy Deluxe Edition: Book One Book One [Hardcover]", "GN 1-4"],
    ["Oldboy Deluxe Edition: Book Thirteen [Hardcover]", "GN 1-4"],
    ["Oldboy Deluxe Edition: Book One [Hardcover]", "GN 5-8"],
    ["Oldboy Deluxe Edition: Book One [Hardcover]", "GN 2"],
  ] as const) {
    await retitle(title, volume);
    expect(await refusal({ sourceTitle: title }), `${title} ${volume}`).toBeTruthy();
  }
});

const noLongerHuman: Line = {
  work: "No Longer Human",
  altTitles: ["Ningen Shikkaku"],
  parentTitle: "No Longer Human",
  lineName: "Complete Edition Omnibus",
  labels: ["1", "2", "3"],
  title: "No Longer Human Complete Edition Omnibus",
  volume: "GN 1-3",
  binding: "paperback",
};

it("reads a reviewed edition descriptor before a line word only as the target's own line", async () => {
  const t = makeT();
  const { ids, refusal, retitle } = await setup(t, noLongerHuman);
  expect(await refusal()).toBeNull();
  expect(await refusal(null)).toBeTruthy();
  // The descriptor plus the read line word must be the target's line name.
  for (const name of ["Omnibus", "Complete Edition", "Deluxe Edition Omnibus"]) {
    await t.run((ctx) => ctx.db.patch(ids.lineId, { name }));
    expect(await refusal(), name).toBeTruthy();
  }
  await t.run((ctx) => ctx.db.patch(ids.lineId, { name: "Complete Edition Omnibus" }));
  // The ANN parent must be the declared work the rest of the title names.
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, { snapshot: { kind: "annManga", id: "3987", title: "Other Work" } }),
  );
  expect(await refusal()).toBeTruthy();
  await t.run((ctx) =>
    ctx.db.patch(ids.parentId, {
      snapshot: { kind: "annManga", id: "3987", title: "No Longer Human" },
    }),
  );
  // Another work's words, a number or a Part in the descriptor stay the work's.
  for (const title of [
    "No Longer Human Returns Complete Edition Omnibus",
    "No Longer Human Part 2 Omnibus",
    "No Longer Human 2 Omnibus",
    "Other Work Complete Edition Omnibus",
  ]) {
    await retitle(title);
    expect(await refusal({ sourceTitle: title }), title).toBeTruthy();
  }
  await retitle("No Longer Human Complete Edition Omnibus", "GN 1-2");
  expect(await refusal()).toBeTruthy();
});

// Independent adversarial review: matching mutable metadata cannot establish
// that a suffix names an edition rather than a different work.
it.each([
  ["Returns Complete Edition", "No Longer Human Returns Complete Edition Omnibus"],
  ["Another Work Complete Edition", "No Longer Human Another Work Complete Edition Omnibus"],
  ["Chapter Complete Edition", "No Longer Human Chapter Complete Edition Omnibus"],
  ["II Complete Edition", "No Longer Human II Complete Edition Omnibus"],
])(
  "keeps work-like descriptor %s held even if the target line echoes it",
  async (descriptor, title) => {
    const t = makeT();
    const { refusal } = await setup(t, {
      ...noLongerHuman,
      title,
      lineName: `${descriptor} Omnibus`,
    });
    expect(await refusal(), title).toBeTruthy();
  },
);

it.each([
  "Oldboy Deluxe Edition: Book One-Two [Hardcover]",
  "Oldboy Deluxe Edition: Book One to Two [Hardcover]",
  "Oldboy Deluxe Edition: Book One Book II [Hardcover]",
  "Oldboy Deluxe Edition: Book One (Vol. II) [Hardcover]",
  "Oldboy Deluxe Edition: Book One [Paperback]",
  "Oldboy Novel Deluxe Edition: Book One [Hardcover]",
  "Oldboy Deluxe Edition: Book One Chapter 2 [Hardcover]",
])("preserves contradictions in %s", async (title) => {
  const t = makeT();
  const { refusal } = await setup(t, { ...oldboy, title });
  expect(await refusal(), title).toBeTruthy();
});

it.each([oldboy, noLongerHuman])(
  "pins exact review identity and complete ordered contents for $work",
  async (line) => {
    const t = makeT();
    const { ids, refusal, snapshot } = await setup(t, line);
    expect(await refusal({ isbn13: "9781506752877" })).toBeTruthy();
    expect(await refusal({ volumeIds: [...ids.volumeIds].reverse() })).toBeTruthy();
    expect(await refusal({ evidenceUrls: [] })).toBeTruthy();
    const other = await t.run(async (ctx) => ({
      publisherId: await insertPublisher(ctx, { name: "Other Publisher", slug: "other" }),
      seriesId: await insertSeries(ctx, { title: "Other Work" }),
    }));
    expect(await refusal({ publisherId: other.publisherId })).toBeTruthy();
    expect(await refusal({ seriesId: other.seriesId })).toBeTruthy();
    await t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: { ...snapshot, page: { ...snapshot.page, isbn13: "9781506752877" } },
      }),
    );
    expect(await refusal()).toBeTruthy();
    await t.run((ctx) =>
      ctx.db.patch(ids.observationId, {
        snapshot: { ...snapshot, page: { ...snapshot.page, title: "Other Work" } },
      }),
    );
    expect(await refusal()).toBeTruthy();
    await t.run((ctx) => ctx.db.patch(ids.observationId, { snapshot }));
    await t.run((ctx) =>
      ctx.db.patch(ids.releaseId, {
        binding: line.binding === "hardcover" ? "paperback" : "hardcover",
      }),
    );
    // Only Oldboy's source explicitly states binding in this fixture.
    if (line === oldboy) expect(await refusal()).toBeTruthy();
  },
);

it("does not excuse a spelled position under another known ANN parent", async () => {
  const t = makeT();
  const { refusal } = await setup(t, { ...oldboy, parentTitle: "Other Work" });
  expect(await refusal()).toBeTruthy();
});

it.each([
  "No Longer Human Novel Complete Edition Omnibus",
  "No Longer Human Part Two Complete Edition Omnibus",
  "No Longer Human 2 Complete Edition Omnibus",
  "No Longer Human Complete Edition Omnibus Chapter 2",
])("preserves descriptor scope/numeric contradiction in %s", async (title) => {
  const t = makeT();
  const { refusal } = await setup(t, { ...noLongerHuman, title });
  expect(await refusal()).toBeTruthy();
});

it.each([
  ["Complete Edition Deluxe Edition", "No Longer Human Complete Edition Deluxe Edition"],
  ["Complete Edition Box Set", "No Longer Human Complete Edition Box Set"],
  ["Complete Edition VIZBIG Edition", "No Longer Human Complete Edition VIZBIG Edition"],
])("does not splice two Edition Lines into %s", async (lineName, title) => {
  const t = makeT();
  const { refusal } = await setup(t, { ...noLongerHuman, title, lineName });
  expect(await refusal()).toBeTruthy();
});

it("refuses ambiguous ISBN ownership after an exact spelled-position review", async () => {
  const t = makeT();
  const { ids, refusal } = await setup(t, oldboy);
  await t.run((ctx) =>
    insertRelease(ctx, {
      editionId: ids.editionId,
      publisherId: ids.publisherId,
      seriesIds: [ids.seriesId],
      isbn13: "9781506752860",
      binding: "hardcover",
    }),
  );
  expect(await refusal()).toBeTruthy();
});
