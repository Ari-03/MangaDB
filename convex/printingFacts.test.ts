// C67-R4-01..03 and C67-R5-01..03 and C67-R6-01..02: actual OL input -> registered import -> registered decision.
// Main title, subtitle and stored fields are independent source statements.
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { parseEditionJson, type OlEditionSnapshot } from "./lib/openLibrary";
import { alice, makeT, seedRegistry, withUser, type TestT } from "./test.helpers";
import { catalogState, decide, OLDER, vagabond } from "./test.printings";

/** Preserve every decision document, including audit contents, on refusal. */
const state = async (t: TestT) => ({
  ...(await catalogState(t)),
  ...(await t.run(async (ctx) => ({
    proposals: await ctx.db.query("proposals").collect(),
    versions: await ctx.db.query("proposalVersions").collect(),
    revisions: await ctx.db.query("revisions").collect(),
    history: await ctx.db.query("observationSnapshots").collect(),
    editions: await ctx.db.query("editions").collect(),
    coverage: await ctx.db.query("volumeCoverages").collect(),
    series: await ctx.db.query("series").collect(),
    volumes: await ctx.db.query("volumes").collect(),
    lines: await ctx.db.query("editionLines").collect(),
    bundles: await ctx.db.query("releaseBundles").collect(),
    memberships: await ctx.db.query("bundleMemberships").collect(),
    variants: await ctx.db.query("releaseVariants").collect(),
    privateGraph: {
      users: await ctx.db.query("users").collect(),
      entries: await ctx.db.query("collectionEntries").collect(),
      seriesStates: await ctx.db.query("userSeriesStates").collect(),
      releaseProgress: await ctx.db.query("releaseProgress").collect(),
      volumeProgress: await ctx.db.query("volumeProgress").collect(),
      ratings: await ctx.db.query("ratings").collect(),
      favorites: await ctx.db.query("favorites").collect(),
      reviews: await ctx.db.query("reviews").collect(),
      comments: await ctx.db.query("comments").collect(),
    },
  }))),
});

const source = (title: string, subtitle?: string, physicalFormat?: string) => ({
  key: "/books/OL77M",
  title,
  subtitle,
  isbn_13: [OLDER],
  publishers: ["VIZ Media"],
  physical_format: physicalFormat,
});

async function importBook(t: TestT, snapshot: OlEditionSnapshot) {
  expect(await t.mutation(internal.openLibrary.applyEdition, { snapshot })).toMatchObject({
    status: "recordOnly",
  });
  return (await t.run((ctx) =>
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "openlibrary").eq("sourceRecordId", snapshot.key),
      )
      .unique(),
  ))!;
}

/** Import the questionable record before a real coherent decision establishes a row. */
async function setup(
  existing: boolean,
  raw: ReturnType<typeof source>,
  binding: string | undefined = "paperback",
  held: number | null = 1,
  workTitle = "Vagabond",
) {
  const t = makeT({ transactionLimits: true });
  await seedRegistry(t);
  const book = await t.run(vagabond);
  await t.run((ctx) => ctx.db.patch(book.releaseId, { binding }));
  await t.run((ctx) => ctx.db.patch(book.seriesId, { title: workTitle, searchText: workTitle }));
  const asAlice = await withUser(t, alice);
  await asAlice.mutation(api.sharing.setDefaultVisibility, {
    kind: "ownership",
    visibility: "public",
  });
  await asAlice.mutation(api.sharing.setSeriesVisibility, {
    seriesId: book.seriesId,
    kind: "ownership",
    visibility: "private",
  });
  await asAlice.mutation(api.collection.setReleaseEntry, {
    releaseId: book.releaseId,
    state: "owned",
  });
  const snapshot = parseEditionJson(raw)!;
  expect(snapshot).not.toBeNull();
  const observation = await importBook(t, snapshot);
  if (existing) {
    const coherent = parseEditionJson({ ...source(`${workTitle}, Vol. 1`), key: "/books/OL78M" })!;
    const first = await importBook(t, coherent);
    expect(await decide(t, first._id, book.releaseId)).toEqual({
      status: "recorded",
      isbn13: OLDER,
    });
  }
  const before = await state(t);
  if (held !== null) expect(before.holds).toHaveLength(held);
  expect(before.observations.find((row) => row._id === observation._id)).toMatchObject({
    snapshot: Object.fromEntries(
      Object.entries(snapshot).filter(([, value]) => value !== undefined),
    ),
  });
  expect(observation.recordRef).toBeUndefined();
  expect(observation.printingIsbn13).toBeUndefined();
  return { t, book, observation, snapshot, before };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function refused(fixture: Fixture, reason: RegExp) {
  const { t, book, observation, before } = fixture;
  expect(await decide(t, observation._id, book.releaseId)).toEqual({
    status: "refused",
    reason: expect.stringMatching(reason),
  });
  expect(await state(t)).toEqual(before);
}

async function accepted(fixture: Fixture, existing: boolean) {
  const { t, book, observation, before } = fixture;
  const result = await decide(t, observation._id, book.releaseId);
  expect(result).toMatchObject({ status: existing ? "linked" : "recorded", isbn13: OLDER });
  const after = await state(t);
  expect(after.releases).toEqual(before.releases);
  expect(after.editions).toEqual(before.editions);
  expect(after.coverage).toEqual(before.coverage);
  expect(after.series).toEqual(before.series);
  expect(after.volumes).toEqual(before.volumes);
  expect(after.history).toEqual(before.history);
  expect(after.privateGraph).toEqual(before.privateGraph);
  expect(after.lines).toEqual(before.lines);
  expect(after.bundles).toEqual(before.bundles);
  expect(after.memberships).toEqual(before.memberships);
  expect(after.variants).toEqual(before.variants);
  expect(after.holds).toEqual([]);
  expect(after.observations.find((row) => row._id === observation._id)).toEqual({
    ...observation,
    conflicts: [],
    recordRef: { type: "release", id: book.releaseId },
    printingIsbn13: OLDER,
  });
  expect(after.rows).toHaveLength(1);
  if (existing) expect(after.rows).toEqual(before.rows);
  else
    expect(after.rows[0]).toMatchObject({
      releaseId: book.releaseId,
      isbn13: OLDER,
      observationId: observation._id,
      sourceKey: "openlibrary",
    });
  expect(after.proposals).toHaveLength(before.proposals.length + 1);
  expect(after.versions).toHaveLength(before.versions.length + 1);
  expect(after.revisions).toHaveLength(before.revisions.length + 1);
  const proposal = after.proposals.at(-1)!;
  expect(proposal).toMatchObject({ state: "approved" });
  expect(after.revisions.at(-1)).toMatchObject({
    ref: { type: "release", id: book.releaseId },
    proposalId: proposal._id,
    changes: [
      {
        field: existing ? "sourceObservation" : "otherPrinting",
        after: expect.stringContaining(OLDER),
      },
    ],
  });
  if (existing)
    expect(after.revisions.at(-1)!.changes[0]!.after).toContain("openlibrary /books/OL77M");
}

// Every material R4 witness uses untouched real parser output and real holds.
const witnesses = [
  { title: "Vagabond, Vol. 1", subtitle: "Vol. 1: Includes Volumes 1-2" },
  { title: "Vagabond, Vol. 1", subtitle: "Vol. 1 (Vol. 2)" },
  { title: "Vagabond, Vol. 1", subtitle: "Vol. 1: Vol. 2" },
  { title: "Vagabond", subtitle: "Vol. 1: Includes Volumes 1-2" },
  { title: "Vagabond", subtitle: "Vol. 1 (Vol. 2)" },
  { title: "Vagabond, Vol. 1: Includes Volumes 1-2" },
  { title: "Vagabond, Vol. 1 (Vol. 2)" },
  { title: "Vagabond, Vol. 1", subtitle: "Vol. 1 (Hardback)" },
  { title: "Vagabond, Vol. 1", subtitle: "(Hardbound)" },
  { title: "Vagabond, Vol. 1", subtitle: "Hardcover Edition" },
  { title: "Vagabond, Vol. 1", format: "Hardback" },
  { title: "Vagabond, Vol. 1", format: "Hardbound" },
  { title: "Vagabond, Vol. 1", format: "Hard cover" },
  { title: "Vagabond, Vol. 1", format: "Softcover", target: "hardcover" },
  { title: "Vagabond, Vol. 1", format: "Softbound", target: "hardcover" },
  { title: "Vagabond, Vol. 1", subtitle: "Vol. 1, Digital" },
  { title: "Vagabond, Vol. 1", subtitle: "Digital Download" },
];

// Exactly 21 raw R5 routes, exercised against both genuine row branches.
const round5 = [
  ...[
    "Vol. 1: Includes Volumes 1, ?, 2",
    "Vol. 1: Includes Volumes 1, ?",
    "Vol. 1: Includes Volumes 1, unknown",
    "Vol. 1: Includes Volumes 1 and unknown",
    "Vol. 1: Includes Volume 1, plus Volume 2",
    "Vol. 1: Includes Volume 1 and also Volume 2",
    "Vol. 1 (Hardback )",
    "Vol. 1 (Hardbound )",
    "Vol. 1 (Hardcover Edition )",
    "Vol. 1: Hardback .",
    "Vol. 1 (Paperback ; Hardcover )",
    "Vol. 1 (Digital )",
    "Vol. 1 (Digital Download )",
    "Vol. 1: Digital Download .",
    "Vol. 1 (eBook 1)",
    "Vol. 1 (Kindle Edition 1)",
    "Vol. 1: eBook (GN 1)",
  ].map((subtitle) => ({ title: "Vagabond, Vol. 1", subtitle })),
  ...["Vol. 1: Includes Volumes 1, ?, 2", "Vol. 1: Includes Volumes 1, ?"].flatMap((clause) => [
    { title: "Vagabond", subtitle: clause },
    { title: `Vagabond, ${clause}`, subtitle: undefined },
  ]),
];

// Change whitespace at every lexical boundary, without changing any work name.
const boundarySpaces = [" ", "\t", "\n", "\u00a0"];
const boundaryClauses = boundarySpaces.flatMap((space) => [
  `Vol. 1${space}(${space}Hardback${space})`,
  `Vol. 1${space}[${space}Hardbound${space}]`,
  `Vol. 1${space}(${space}Hardcover Edition${space})${space}.`,
  `Vol. 1${space}:${space}Hardback${space}.`,
  `Vol. 1${space}(${space}Paperback${space};${space}Hardcover${space})`,
  `Vol. 1${space}(${space}Digital${space})`,
  `Vol. 1${space}(${space}Digital Download${space})`,
  `Vol. 1${space}:${space}Digital Download${space}.`,
  `Vol. 1${space}(${space}eBook${space}1${space})`,
  `Vol. 1${space}(${space}Kindle Edition${space}1${space})`,
  `Vol. 1${space}:${space}eBook${space}(${space}GN${space}1${space})`,
  `Vol. 1${space}:${space}Includes Volumes 1${space},${space}?${space},${space}2`,
]);

const incompleteContents = [
  "Includes Volumes 1, unavailable",
  "Collects Volumes 1 and undecided",
  "Contains Volumes 1 or unspecified",
  "Includes Volumes 1,",
  "Collects Volume 1 plus Volume 2",
  "Contains Volume 1 and additionally Volume 2",
  "Includes Volume 1, ?, Contains Volume 2",
  "Includes Volume 1, unresolved (Vol. 2)",
  "Vol. 1 (Includes Volumes 1, [?, Volume 2])",
  "Contains Volume 2; Includes Volume 1, unspecified",
  "Includes Volumes 1-1",
  "Includes Volumes 1--2",
  "Includes Volumes 1-0",
  "Includes Volumes 1-1.5",
  "Includes Volumes 1, 3",
  "Includes Volumes 1, 01, unresolved",
  "Includes Volumes 1, Paperback dreams",
  "Includes Volumes 1, Digital adventures",
  "Vol. 1 (Paperback Volume 2)",
  "Includes Volumes unknown and Volume 2",
  "Vol. 1: (Includes Volume 1) and (unknown)",
  "Vol. 1: ((Collects Volume 1)) , unspecified",
  "Vol. 1 (Hardback Volumes unknown)",
  "Vol. 1 (Paperback Includes Volumes unknown)",
];

const conflicts = [
  "Vol. 1; Collects Volumes 1 and 2",
  "Contains Vols. 1, 2: Vol. 1",
  "Vol. 1 (Includes Vols. 1 & 3)",
  "Vol. 1: Volumes 1/2",
  "Vol. 1 (Vol. 2) (Vol. 1)",
  "Volume 2; Volume 01",
  "Vol. 1, Book 2",
  "Vol. 1; Part II",
  "Vol. 1 Vol. 2",
  "Vol. 1: Includes Volumes unknown",
  "Vol. 1: Includes Volume 1 + EX",
  "Vol. 1: Collects Volumes 1 to 2",
  "Vol. 1: Includes Volumes 1 through 3",
  "Vol. 1 (Paperback / Hardback)",
  "Vol. 1 (Hardbound, Softcover)",
  "Vol. 1 (Softbound and Hard cover)",
  "Paperback; Hardcover Edition; Paperback",
  "Vol. 1 (Digital download)",
  "Digital Version; Vol. 1",
  "Vol. 1, e-book",
  "Vol. 1 (Kindle Edition)",
  "Vol. 1 (Electronic Edition)",
  "Vol. 1, Digital Download.",
  "Vol. 1. Vol. 2",
];
const equivalent = [
  "Vol. 1 (Vol. 01)",
  "Vol. 01.",
  "Book of Dreams",
  "Part of the Journey",
  "Volume I; Volume 1",
  "Volume i; Volume 01",
  "Vol. 1: Collects Volume 01",
  "Includes Volume 1; Vol. 01",
  "Vol. 1: Something Sinister",
  "Vol. 1: The digital adventures",
  "Vol. 1: A Hardcover Dream",
  "Vol. 1 (Graphic Novel)",
  "Hearts II",
  "2",
];
const bindingAliases = [
  ["Hardcover", "hardcover"],
  ["Hard cover", "hardcover"],
  ["Hardback", "hardcover"],
  ["Hard back", "hardcover"],
  ["Hardbound", "hardcover"],
  ["Hard bound", "hardcover"],
  ["Paperback", "paperback"],
  ["Paper back", "paperback"],
  ["Trade Paperback", "paperback"],
  ["Softcover", "paperback"],
  ["Soft cover", "paperback"],
  ["Softback", "paperback"],
  ["Soft back", "paperback"],
  ["Softbound", "paperback"],
  ["Soft bound", "paperback"],
] as const;

describe.each([false, true])("all explicit source facts, existing row %s", (existing) => {
  it.each(witnesses)(
    "freezes actual R4 witness %j",
    async ({ title, subtitle, format, target }) => {
      await refused(
        await setup(existing, source(title, subtitle, format), target),
        /Volume|packaging|hardcover|paperback|digital/i,
      );
    },
  );
  it.each(round5)("freezes actual R5 witness %j", async ({ title, subtitle }) => {
    await refused(
      await setup(existing, source(title, subtitle)),
      /Volume|packaging|hardcover|paperback|digital/i,
    );
  });
  it.each(
    [...boundaryClauses, ...incompleteContents].flatMap((clause) => [
      { route: "retained", title: "Vagabond, Vol. 1", subtitle: clause },
      { route: "plain", title: "Vagabond", subtitle: clause },
      { route: "main", title: `Vagabond, ${clause}`, subtitle: undefined },
    ]),
  )("freezes $route boundary $title + $subtitle", async ({ route, title, subtitle }) => {
    const fixture = await setup(
      existing,
      source(title, subtitle),
      "paperback",
      route === "retained" ? 1 : null,
    );
    if (fixture.snapshot.subtitle !== undefined) expect(fixture.snapshot.subtitle).toBe(subtitle);
    await refused(fixture, /Volume|packaging|hardcover|paperback|digital|not held/i);
  });
  it.each(
    boundarySpaces.flatMap((space) => [
      `Vol. 1${space}(${space}Paperback${space};${space}Softcover${space})`,
      `Vol. 1${space}:${space}Collects Volume 01${space};${space}Vol. I${space}.`,
      `Vol. 1${space}:${space}Includes Volumes 1${space},${space}01${space}and${space}Volume I`,
      `Vol. 1${space}:${space}Something Sinister`,
    ]),
  )("keeps matching facts and prose across boundary %s", async (subtitle) => {
    await accepted(await setup(existing, source("Vagabond, Vol. 1", subtitle)), existing);
  });
  it.each([
    "Vol. 1 (eBook1)",
    "Vol. 1 (Kindle Edition1)",
    "Vol. 1: Digital GN 1",
    "Vol. 1 (Hardback 1)",
    "Vol. 1 (Paperback 1 Hardcover 2)",
  ])("retains a numbered technical format %s", async (subtitle) => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", subtitle)),
      /digital|hardcover/i,
    );
  });
  it.each(conflicts)("retained subtitle refuses %s", async (subtitle) => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", subtitle)),
      /Volume|packaging|hardcover|paperback|digital/i,
    );
  });
  it.each([
    ["Vagabond, Vol. 1: Contains Volumes 1 and 2", undefined],
    ["Vagabond, Vol. 1: Collects Volume 2", undefined],
    ["Vagabond, Vol. 1 (Volume II)", undefined],
    ["Vagabond, Vol. 1: Vol. 2", undefined],
    ["Vagabond", "Vol. 1: Contains Volumes 1 and 2"],
    ["Vagabond", "Vol. 1: Collects Volume 2"],
    ["Vagabond", "Vol. 1 (Volume II)"],
  ])("preserves neighboring main/joined contents %s + %s", async (title, subtitle) => {
    await refused(await setup(existing, source(title!, subtitle)), /Volume|packaging/i);
  });
  it.each([
    ["Softcover", "Vol. 1 (Hardbound)", "hardcover"],
    ["Hard back", "Vol. 1 (Softbound)", "paperback"],
    ["Softbound", "Hard cover Edition; Vol. 1", "paperback"],
  ])("compares raw field %s with subtitle %s", async (format, subtitle, target) => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", subtitle, format), target),
      /cannot be read.*(?:hardcover|paperback)/,
    );
  });
  it.each(["Digital Adventures", "Hardcover Dreams", "Alpha 2", "Kingdom Hearts II"])(
    "keeps authentic work-owned words in %s",
    async (work) => {
      await accepted(
        await setup(existing, source(`${work}, Vol. 1`), "paperback", 1, work),
        existing,
      );
    },
  );
  it("keeps a real joined sequel's identity", async () => {
    await accepted(
      await setup(
        existing,
        source("Kingdom", "Hearts II, Vol. 1"),
        "paperback",
        1,
        "Kingdom: Hearts II",
      ),
      existing,
    );
  });
  it.each(equivalent)("keeps normalized statements and display prose %s", async (subtitle) => {
    await accepted(await setup(existing, source("Vagabond, Vol. 1", subtitle)), existing);
  });
  it.each(bindingAliases)("fresh physical-format %s equals %s", async (format, target) => {
    const fixture = await setup(existing, source("Vagabond, Vol. 1", undefined, format), target);
    expect(fixture.snapshot.binding).toBe(target);
    expect(fixture.snapshot.physicalFormat).toBe(format);
    await accepted(fixture, existing);
  });
  it.each(bindingAliases)(
    "subtitle %s disagrees with the target's opposite Binding",
    async (format, binding) => {
      const target = binding === "hardcover" ? "paperback" : "hardcover";
      await refused(
        await setup(existing, source("Vagabond, Vol. 1", `Vol. 1 (${format})`), target),
        /hardcover|paperback/,
      );
    },
  );
  it.each([
    "Paperback / Hardback",
    "Softbound; Hardcover",
    "Hardcover and Paperback",
    "Hardbound, Softcover",
  ])("compares every dedicated field Binding in %s", async (format) => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", undefined, format)),
      /cannot be read.*(?:hardcover|paperback)/,
    );
  });
  it.each([
    "Vagabond, Vol. 1 (Hardback)",
    "Vagabond, Vol. 1 (Hardbound)",
    "Vagabond, Vol. 1, Digital",
    "Vagabond, Vol. 1 (Digital download)",
  ])("keeps the real unheld main route %s unchanged", async (title) => {
    await refused(
      await setup(existing, source(title), "paperback", 0),
      /not held under a Series|digital/i,
    );
  });
  it.each(["Vol. 1 (Hardback)", "Vol. 1, Digital", "Vol. 1 (Digital download)"])(
    "keeps the real unheld joined route %s unchanged",
    async (subtitle) => {
      await refused(
        await setup(existing, source("Vagabond", subtitle), "paperback", 0),
        /not held under a Series|digital/i,
      );
    },
  );
  it.each(["Vol. 01 (Paperback)", "Vol. 1", "Vol. 1: Something Sinister"])(
    "accepts real subtitle-origin designation %s",
    async (subtitle) => {
      await accepted(await setup(existing, source("Vagabond", subtitle)), existing);
    },
  );
  it.each([
    ["Paperback / Hardback", "paperback"],
    ["Hardbound / Softcover", "hardcover"],
    ["Softbound; Hardcover", "hardcover"],
    ["Hardcover, Paperback", "paperback"],
  ])("compares every target Binding token in %s", async (binding, original) => {
    const fixture = await setup(existing, source("Vagabond, Vol. 1"), original);
    await fixture.t.run((ctx) => ctx.db.patch(fixture.book.releaseId, { binding }));
    fixture.before = await state(fixture.t);
    await refused(fixture, /Release states conflicting Binding/);
  });
  it("keeps unknown Binding under manual review", async () => {
    const fixture = await setup(existing, source("Vagabond, Vol. 1", "Vol. 1 (Hardback)"));
    await fixture.t.run((ctx) => ctx.db.patch(fixture.book.releaseId, { binding: undefined }));
    fixture.before = await state(fixture.t);
    await accepted(fixture, existing);
  });
});

describe("actual raw Digital format import", () => {
  it.each(["Digital", "Digital Download", "Kindle", "eBook", "Electronic Hardcover"])(
    "never decides a raw %s import as a physical printing",
    async (format) => {
      const t = makeT({ transactionLimits: true });
      await seedRegistry(t);
      const book = await t.run(vagabond);
      const snapshot = parseEditionJson(source("Vagabond, Vol. 1", undefined, format))!;
      expect(snapshot.format).toBe("digital");
      expect(snapshot.physicalFormat).toBe(format);
      expect(snapshot.binding).toBeUndefined();
      await t.mutation(internal.openLibrary.applyEdition, { snapshot });
      const observation = (await t.run((ctx) =>
        ctx.db
          .query("sourceObservations")
          .withIndex("by_source_record", (q) =>
            q.eq("sourceKey", "openlibrary").eq("sourceRecordId", snapshot.key),
          )
          .unique(),
      ))!;
      const before = await state(t);
      const result = await decide(t, observation._id, book.releaseId);
      expect(result).toMatchObject({ status: "refused" });
      expect(await state(t)).toEqual(before);
    },
  );
});

it("keeps a real unheld work-owned Volume word route unchanged", async () => {
  const t = makeT({ transactionLimits: true });
  await seedRegistry(t);
  const book = await t.run(vagabond);
  await t.run((ctx) =>
    ctx.db.patch(book.seriesId, { title: "Tales of Volume 2", searchText: "Tales of Volume 2" }),
  );
  const snapshot = parseEditionJson(source("Tales of Volume 2, Vol. 1"))!;
  const observation = await importBook(t, snapshot);
  const before = await state(t);
  expect(before.holds).toEqual([]);
  expect(await decide(t, observation._id, book.releaseId)).toMatchObject({
    status: "refused",
    reason: "The book is not held under a Series.",
  });
  expect(await state(t)).toEqual(before);
});

const round6 = [
  "Vol. 1: Includes Volumes 1 (and unknown)",
  "Vol. 1: Includes Volumes 1 (and ?)",
  "Vol. 1: Includes Volumes 1 [and unknown]",
  "Vol. 1: Includes Volumes 1 {and unknown}",
  "Vol. 1: Includes Volumes 1 (and 2)",
  "Vol. 1: Includes Volumes 1 [and 2]",
  "Vol. 1: Includes Volumes 1 (through 2)",
  "Vol. 1: Includes Volumes 1 (or unknown)",
  "Vol. 1: Includes Volumes 1, (unknown)",
  "Vol. 1: Includes Volumes 1 and (unknown)",
  "Vol. 1: Includes Volumes 1, ((unknown)) and Volume 2",
  "Vol. 1: Includes Volumes 1 (and Volume 2)",
  "Vol. 1: Includes Volumes 1 (Paperback) and unknown",
  "Vol. 1: Includes Volumes 1 (Paperback), unknown",
  "Vol. 1 (eBook II)",
  "Vol. 1 (Kindle Edition II)",
  "Vol. 1: eBook (GN II)",
  "Vol. 1 (eBook #1)",
  "Vol. 1 (eBook Volume 2)",
  "Vol. 1 (Paperback 1.5 Hardcover 2)",
  "Vol. 1: Digital GN 1 Hardcover 2",
  "Vol. 1: Includes Volumes 1--1",
  "Vol. 1 (Paperback 1; Hardcover 2)",
  "Vol. 1: Includes Volumes 1, 01 and ?",
  "Vol. 1: Includes Volume 1 and perhaps Volume 2",
  "Vol. 1: Includes Volume 1 (and unknown), Volume 2",
  "Vol. 1: Includes Volumes 1 (and unknown); Hardback",
  "Vol. 1 (Hardback II)",
  "Vol. 1 (Hardbound II)",
  "Vol. 1 (Hardcover Edition II)",
  "Vol. 1: eBook GN II",
  "Vol. 1: Hardback GN II",
  "Vol. 1: Includes Volumes 1 (and 2) (Paperback)",
  "Vol. 1: Includes Volumes 1 ((and unknown))",
  "Vol. 1: Includes Volumes 1 (Paperback ) and ?",
  "Vol. 1: Includes Volumes 1 (Paperback 1) and unknown",
  "Vol. 1: Includes Volumes 1 (Paperback) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback) and Volume 2",
  "Vol. 1: Includes Volumes 1 (Paperback); Volume 2",
  "Vol. 1: Includes Volumes 1 and ((unknown))",
  "Vol. 1: Includes Volumes 1, (Paperback) and unknown",
  "Vol. 1: Includes Volumes 1, Paperback and unknown",
  "Vol. 1: Includes Volumes 1, (and unknown)",
  "Vol. 1: Includes Volumes 1 (& unknown)",
  "Vol. 1: Includes Volumes 1 (+ unknown)",
  "Vol. 1: Includes Volumes 1 (/ unknown)",
  "Vol. 1: Includes Volumes 1 {- 2}",
];

// Every R6 source is real parser output with a genuine hold on retained routes.
describe.each([false, true])(
  "connected contents and format designators, existing %s",
  (existing) => {
    it.each(round6)("freezes R6 clause %s", async (subtitle) => {
      const fixture = await setup(existing, source("Vagabond, Vol. 1", subtitle));
      expect(fixture.snapshot.subtitle).toBe(subtitle);
      await refused(fixture, /Volume|packaging|hardcover|paperback|digital/i);
    });
    it.each(
      [
        "Vol. 1: Includes Volumes 1 (and 2)",
        "Vol. 1: Includes Volumes 1 (Paperback) and unknown",
        "Vol. 1 (eBook II)",
      ].flatMap((clause) => [
        { route: "plain", title: "Vagabond", subtitle: clause },
        { route: "main", title: `Vagabond, ${clause}`, subtitle: undefined },
      ]),
    )("freezes R6 $route $title + $subtitle", async ({ title, subtitle }) => {
      await refused(
        await setup(existing, source(title, subtitle), "paperback", null),
        /Volume|packaging|hardcover|paperback|digital|not held/i,
      );
    });
    it.each(
      boundarySpaces.flatMap((space) =>
        [
          ["(", ")"],
          ["{", "}"],
          ["((", "))"],
        ].map(([open, close]) => ({ space, open, close })),
      ),
    )(
      "keeps scope across wrappers $open with whitespace $space",
      async ({ space, open, close }) => {
        for (const connector of ["and", "&", "+", "/", "through", "or"]) {
          const subtitle = `Vol. 1: Includes Volumes 1${space}${open}${space}Paperback II${space}${close}${space}${open}${connector}${space}unresolved component${close}`;
          const fixture = await setup(existing, source("Vagabond, Vol. 1", subtitle));
          expect(fixture.snapshot.subtitle).toBe(subtitle);
          await refused(fixture, /Volume|packaging/i);
        }
      },
    );
    it.each([
      "Includes Volumes 1 (Paperback; Softcover) and 2",
      "Includes Volumes 1 ((Paperback 01; Softbound II)) , unavailable",
      "Collects Volume 1 (Paperback II) and Volume II",
      "Contains Volumes 1 (Paperback Edition II), 2 (Paperback)",
      "Includes Volumes 1 (Paperback (GN II)) and 2",
      "Includes Volumes 1 {and {2}}",
      "Includes Volumes 1 (to II)",
      "Includes Volumes 1 (Paperback) + 2",
      "Includes Volumes 1 (Paperback) / unavailable",
    ])("retains neighboring connected %s", async (clause) => {
      await refused(
        await setup(existing, source("Vagabond, Vol. 1", `Vol. 1: ${clause}`)),
        /Volume|packaging/i,
      );
    });
    it.each([
      "II",
      "iv",
      "IX",
      "XXI",
      "L",
      "IIII",
      "GN unknown",
      "GN ?",
      "#unavailable",
      "GN (unknown)",
    ])("keeps known format for technical payload %s", async (payload) => {
      for (const format of ["Hardback", "Kindle Edition"]) {
        const subtitle = `Vol. 1 (${format} ${payload})`;
        const fixture = await setup(existing, source("Vagabond, Vol. 1", subtitle));
        expect(fixture.snapshot.subtitle).toBe(subtitle);
        await refused(fixture, /hardcover|digital/i);
      }
    });
    it.each([
      "Vol. 1: Includes Volume 01; Paperback",
      "Vol. 1: Includes Volumes 1, 1.0",
      "Vol. 1: Includes Volumes 1 (and Volume 01)",
      "Vol. 1: Includes Volume 1 (Paperback); An unexpected adventure",
      "Vol. 1: Includes Volumes 1, 01 and Volume I",
      "Vol. 1 (Paperback 1)",
      "Vol. 1 (Paperback Edition 1)",
      "Vol. 1: The Digital Journey",
      "Vol. 1: Includes Volume 1; An unexpected adventure",
      "Vol. 1: Hardcover dreams",
      "Vol. 1: Includes Volumes 1 ((and 01))",
      "Vol. 1: Includes Volumes 1 (Paperback II) and 1.0",
      "Vol. 1: Includes Volumes 1 (Paperback; Softcover) and Volume I",
      "Vol. 1 (Paperback iv)",
      "Vol. 1 (Paperback GN unknown)",
      "Vol. 1: Includes Volume 1 (Paperback (GN II)); Digital adventures",
    ])("keeps equal contents, equal numbered formats and prose %s", async (subtitle) => {
      await accepted(await setup(existing, source("Vagabond, Vol. 1", subtitle)), existing);
    });
  },
);

// C67-R7-01/02: keep the complete independently reviewed matrix durably.
const round7 = [
  "Vol. 1 (and II)",
  "Vol. 1 (and two)",
  "Vol. 1 {and II}",
  "Vol. 1 (through II)",
  "Vol. 1 (through two)",
  "Vol. 1 (or II)",
  "Vol. 1 (Paperback) and II",
  "Vol. 1 (Paperback) and two",
  "Vol. 1 (Paperback) and unknown",
  "Vol. 1 (Paperback) and ?",
  "Vol. 1 (and #2)",
  "Vol. 1 (Paperback) and #2",
  "Vol. 1 (and 2)",
  "Vol. 1 (and Volume II)",
  "Vol. 1 and (II)",
  "Vol. 1 and (two)",
  "Vol. 1 and ((II))",
  "Vol. 1, (II)",
  "Vol. 1 / (II)",
  "Vol. 1 (Paperback GN Hardcover Paperback)",
  "Vol. 1 (Paperback GN eBook Paperback)",
  "Vol. 1 (Paperback GN Volume 2 Paperback)",
  "Vol. 1 (Paperback #Volume2)",
  "Vol. 1 (Paperback #Digital)",
  "Vol. 1 (Paperback #Hardback)",

  "Vol. 1 (Paperback GN Volume 2)",
  "Vol. 1 (Paperback GN Volume2)",
  "Vol. 1 (Paperback # Volume 2)",
  "Vol. 1 (Paperback GN Hardcover)",
  "Vol. 1 (Paperback GN eBook)",
  "Vol. 1 (Paperback #Hardcover)",
  "Vol. 1 (Paperback #eBook)",
  "Vol. 1 (Paperback GN Hardback)",
  "Vol. 1 (Paperback GN Digital Download)",
  "Vol. 1: Includes Volumes 1 (Paperback GN Volume 2)",
  "Vol. 1: Includes Volumes 1 (Paperback GN unknown) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback GN 1 and 2)",
  "Vol. 1: Includes Volumes 1 (Paperback GN 1; and 2)",
  "Vol. 1: Includes Volumes 1 (Paperback GN 1: and 2)",
  "Vol. 1: Includes Volumes 1 (Paperback GN 1. and 2)",
  "Vol. 1: Includes Volumes 1 (Paperback GN 1, 2)",
  "Vol. 1: Includes Volumes 1 (Paperback) plus 2",
  "Vol. 1: Includes Volumes 1 (Paperback) also Volume 2",
  "Vol. 1: Includes Volumes 1 (Paperback) and (2)",
  "Vol. 1: Includes Volumes 1 (Paperback) and (unknown)",
  "Vol. 1: Includes Volumes 1 (Paperback; Hardcover) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback; eBook) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback: edition) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback.) and 2",
  "Vol. 1: Includes Volumes 1 (Paperback) and II",
  "Vol. 1: Includes Volumes 1 (Paperback) or II",
  "Vol. 1: Includes Volumes 1 (Paperback) through II",
  "Vol. 1: Includes Volumes 1 and Paperback and II",
  "Vol. 1: Includes Volumes 1 Paperback and 2",
  "Vol. 1 (Paperback (GN Volume 2))",
  "Vol. 1 (Paperback (GN Hardcover))",
  "Vol. 1 (Paperback (GN eBook))",
  "Vol. 1 (Paperback GN Book 2)",
  "Vol. 1 (Paperback GN Part 2)",
  "Vol. 1 (Paperback GN Vol. 2)",
  "Vol. 1 (Paperback GN Vol2)",
  "Vol. 1 (Paperback GN Digital)",
  "Vol. 1 (Paperback GN Hardcover Edition II)",
  "Vol. 1 (Paperback GN eBook II)",
  "Vol. 1 (Paperback GN ? Volume 2)",
  "Vol. 1 (Paperback GN ? Hardcover)",
  "Vol. 1 (Paperback GN ? eBook)",
  "Vol. 1: Includes Volumes 1 (Paperback GN) and unknown",
  "Vol. 1: Includes Volumes 1 (Paperback #) and 2",
  "Vol. 1 (Paperback 1 Hardcover)",
  "Vol. 1 (Paperback II eBook)",
  "Vol. 1 (Hardback GN unknown)",
  "Vol. 1 (Digital GN unknown)",
  "Vol. 1 (Paperback GN 2 Volume 2)",
  "Vol. 1 (Paperback GN 1.5 Hardcover)",
  "Vol. 1: Includes Volumes 1 (Paperback 1) and unknown",
  "Vol. 1: Includes Volumes 1 and Paperback GN 1, unknown",
  "Vol. 1: Includes Volumes 1; (Volume 2)",
  "Vol. 1: Includes Volumes 1. (Volume 2)",
  "Vol. 1 (eBook IIX)",
  "Vol. 1 (Hardcover IIX)",
  "Vol. 1 (Paperback GN 1/Hardcover)",
  "Vol. 1 (Paperback GN 1+eBook)",
];
const round7Positive = [
  "Vol. 1 (Paperback GN II)",
  "Vol. 1 (Paperback GN unknown)",
  "Vol. 1 (Paperback GN #2)",
  "Vol. 1: Includes Volumes 1 (Paperback) and Volume I",
  "Vol. 1: Includes Volumes 1 (Paperback) and I",
  "Vol. 1: Includes Volumes 1 (Paperback; Paperback) and 01",
  "Vol. 1: Includes Volumes 1 (Paperback) ; An unexpected adventure",
  "Vol. 1: Includes Volumes 1 (Paperback) : An unexpected adventure",
  "Vol. 1: Includes Volumes 1 (Paperback). An unexpected adventure",
  "Vol. 1: Digital adventures",
];
const round7Routes = [
  "Vol. 1 (and II)",
  "Vol. 1 (and two)",
  "Vol. 1 (Paperback) and II",
  "Vol. 1 (Paperback GN Volume 2)",
  "Vol. 1 (Paperback GN Hardcover)",
  "Vol. 1 (Paperback GN eBook)",
];
describe.each([false, true])(
  "designator boundaries and singular contents, existing %s",
  (existing) => {
    it.each(round7)("freezes R7 retained %s", async (subtitle) => {
      const fixture = await setup(existing, source("Vagabond, Vol. 1", subtitle));
      expect(fixture.snapshot.subtitle).toBe(subtitle);
      await refused(fixture, /Volume|packaging|hardcover|paperback|digital/i);
    });
    it.each(
      round7Routes.flatMap((clause) => [
        { title: "Vagabond", subtitle: clause },
        { title: `Vagabond, ${clause}`, subtitle: undefined },
      ]),
    )("freezes R7 route $title + $subtitle", async ({ title, subtitle }) => {
      await refused(
        await setup(existing, source(title, subtitle), "paperback", null),
        /Volume|packaging|hardcover|paperback|digital|not held/i,
      );
    });
    it.each(round7Positive)("preserves R7 positive %s", async (subtitle) => {
      await accepted(await setup(existing, source("Vagabond, Vol. 1", subtitle)), existing);
    });
  },
);

const technicalNeighbors = [
  "Volume 2",
  "Volume2",
  "Vol.2",
  "Vol2",
  "Book II",
  "Book2",
  "Part two",
  "Part2",
  "Volumes unknown",
  "Hardcover",
  "Hardback",
  "HardcoverEdition",
  "eBook",
  "DigitalDownload",
];
describe.each([false, true])("technical source consumption, existing %s", (existing) => {
  it.each(technicalNeighbors)(
    "preserves independent %s after every format designator",
    async (technical) => {
      for (const designator of ["GN", "#", "GN#", "GNGN", "GN#GN"]) {
        for (const space of ["", ...boundarySpaces]) {
          for (const annotation of [
            `Paperback ${designator}${space}${technical}`,
            `Paperback (${designator}${space}${technical}) Paperback`,
            `Paperback ${designator} unresolved ${technical} Paperback`,
            `Paperback ${designator} unresolved component ${technical} Paperback`,
            `Paperback ${designator} an unavailable component Hardcover dreams Digital adventures ${technical} Paperback`,
          ]) {
            const clause = `Vol. 1 (${annotation})`;
            for (const raw of [
              source("Vagabond, Vol. 1", clause),
              source("Vagabond", clause),
              source(`Vagabond, ${clause}`),
            ]) {
              const fixture = await setup(existing, raw, "paperback", null);
              // Joined inputs carry the clause verbatim in title, rather than
              // fabricating the producer's optional retained subtitle field.
              if (raw.title === "Vagabond, Vol. 1")
                expect(fixture.snapshot.subtitle).toBe(raw.subtitle);
              await refused(fixture, /Volume|packaging|hardcover|paperback|digital|not held/i);
            }
          }
        }
      }
    },
  );
  it.each(["2", "02", "2.0", "II", "ii", "two", "TWO", "A2", "2+3", "?", "unresolved component"])(
    "retains supported or uncertain connected component %s",
    async (component) => {
      for (const marker of [
        "Vol.",
        "Volumes",
        "Includes Volume",
        "Collects Volumes",
        "Contains Volume",
      ]) {
        for (const connector of ["and", "or", ",", "/", "&", "+", "through", "to", "-"]) {
          for (const interposed of ["", "(Paperback)", "((Paperback GN II))"]) {
            const clause = `${marker} 1 ${interposed} ${connector} ((${component}))`;
            await refused(
              await setup(existing, source("Vagabond, Vol. 1", clause)),
              /Volume|packaging/i,
            );
          }
        }
      }
    },
  );
  it.each(["1", "01", "1.0", "I", "i", "one"])(
    "keeps equal connected component %s",
    async (label) => {
      for (const prefix of ["Vol. 1", "Volumes 1", "Includes Volume 1"]) {
        for (const connector of ["and", "or", ",", "/", "&", "+"]) {
          await accepted(
            await setup(
              existing,
              source("Vagabond, Vol. 1", `${prefix} (Paperback GN II) ${connector} ((${label}))`),
            ),
            existing,
          );
        }
        await refused(
          await setup(
            existing,
            source("Vagabond, Vol. 1", `${prefix} (Paperback) through (${label})`),
          ),
          /Volume|packaging/i,
        );
      }
    },
  );
  it.each([
    "Vol. 1 (Paperback GNII)",
    "Vol. 1 (Paperback GN#2)",
    "Vol. 1 (Paperback #2)",
    "Vol. 1 (Paperback GN unknown)",
    "Vol. 1 (Paperback GNGN unknown)",
    "Vol. 1 (Paperback GN (unresolved)); Digital adventures",
    "Vol. 1 (Paperback) Something Sinister",
    "Vol. 1 (Paperback) Hardcover dreams",
    "Vol. 1 (Paperback); and an unexpected adventure",
    "Vol. 1 (Paperback): Digital adventures",
    "Vol. 1 (Paperback). An unexpected adventure",
  ])("preserves payload or separate prose positive %s", async (subtitle) => {
    await accepted(await setup(existing, source("Vagabond, Vol. 1", subtitle)), existing);
  });
});
