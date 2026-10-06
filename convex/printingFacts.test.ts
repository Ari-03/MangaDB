// C67-R4-01..03: actual OL input -> registered import -> registered decision.
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
  held = 1,
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
  expect(before.holds).toHaveLength(held);
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
