// C67-R3-01: actual OL input -> registered import -> registered decision.
// Main title, subtitle and stored fields are independent source statements.
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { parseEditionJson, type OlEditionSnapshot } from "./lib/openLibrary";
import { makeT, seedRegistry, type TestT } from "./test.helpers";
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
  stored?: Partial<OlEditionSnapshot>,
) {
  const t = makeT({ transactionLimits: true });
  await seedRegistry(t);
  const book = await t.run(vagabond);
  await t.run((ctx) => ctx.db.patch(book.releaseId, { binding }));
  const snapshot = parseEditionJson(raw)!;
  expect(snapshot).not.toBeNull();
  const observation = await importBook(t, { ...snapshot, ...stored });
  if (existing) {
    const coherent = parseEditionJson({ ...source("Vagabond, Vol. 1"), key: "/books/OL78M" })!;
    const first = await importBook(t, coherent);
    expect(await decide(t, first._id, book.releaseId)).toEqual({
      status: "recorded",
      isbn13: OLDER,
    });
  }
  const before = await state(t);
  expect(before.holds).toHaveLength(
    raw.title === "Vagabond" &&
      ["Vol. 1 (Digital)", "Hearts II, Vol. 1"].includes(raw.subtitle ?? "")
      ? 0
      : 1,
  );
  expect(before.observations.find((row) => row._id === observation._id)).toMatchObject({
    snapshot: Object.fromEntries(
      Object.entries({ ...snapshot, ...stored }).filter(([, value]) => value !== undefined),
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

const subtitles = [
  ["Vol. 1 (Hardcover)", /hardcover/],
  ["Vol. 1 (Paperback)", null],
  ["Vol. 1 (Digital)", /digital/i],
  ["Vol. 1", null],
  ["Vol. 2", /Volume 2/],
  ["Volumes 1-2", /packaging/],
  ["Hearts II, Vol. 1", null],
] as const;

// The review's entire 28-case matrix, with independently expected outcomes.
describe.each([false, true])("actual OL subtitles, existing row %s", (existing) => {
  for (const title of ["Vagabond", "Vagabond, Vol. 1"]) {
    it.each(subtitles)(`${title} + %s`, async (subtitle, refusal) => {
      const fixture = await setup(existing, source(title, subtitle));
      if (fixture.snapshot.title === title) expect(fixture.snapshot.subtitle).toBe(subtitle);
      else expect(fixture.snapshot.subtitle).toBeUndefined();
      if (title === "Vagabond" && subtitle === "Hearts II, Vol. 1") {
        await refused(fixture, /not held under a Series|work .*not the Release's Series/);
      } else if (title === "Vagabond" && subtitle === "Vol. 1 (Digital)")
        await refused(fixture, /not held under a Series|digital/i);
      else if (refusal) await refused(fixture, refusal);
      else await accepted(fixture, existing);
    });
  }

  it.each([
    ["Vagabond, Vol. 1 (Hardcover)", "Vol. 1 (Paperback)", undefined, "hardcover"],
    ["Vagabond, Vol. 1", "Vol. 1 (Paperback)", "Hardcover", "hardcover"],
    ["Vagabond, Vol. 1 (Hardcover)", "Vol. 1", "Paperback", "paperback"],
    ["Vagabond, Vol. 1 (Paperback)", "Vol. 1 (Hardcover)", "Paperback", "paperback"],
  ])(
    "refuses independent Binding disagreement: %s + %s, field %s",
    async (title, subtitle, field, target) => {
      await refused(
        await setup(existing, source(title!, subtitle, field), target),
        /cannot be read.*(?:paperback|hardcover)/,
      );
    },
  );

  it("compares subtitle-only known Binding with the target", async () => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", "Hardcover")),
      /hardcover.*paperback/,
    );
  });
  it("compares the field with the target when title and subtitle leave Binding unknown", async () => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", "Vol. 1", "Hardcover")),
      /hardcover.*paperback/,
    );
  });
  it("compares a subtitle-origin Volume with the target", async () => {
    await refused(
      await setup(existing, source("Vagabond", "Vol. 2")),
      /is Volume 2; the Release is Volume 1/,
    );
  });
  it("keeps the stored Volume independent of equal title and subtitle labels", async () => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", "Vol. 1"), "paperback", {
        volumeLabel: "2",
      }),
      /stored reading Volume 2/,
    );
  });
  it("keeps a stored packaging flag independent of a single-Volume title and subtitle", async () => {
    await refused(
      await setup(existing, source("Vagabond, Vol. 1", "Vol. 1"), "paperback", {
        multiVolume: true,
      }),
      /stored multi-volume/,
    );
  });
  it.each(["Digital", "Vol. 1 (Digital Edition)", "Vol. 1 (eBook)"])(
    "refuses raw format evidence %s",
    async (subtitle) => {
      await refused(await setup(existing, source("Vagabond, Vol. 1", subtitle)), /digital/i);
    },
  );
  it.each(["Vol. 01 (Paperback)", "Something Sinister", "Hearts II, Vol. 1"])(
    "keeps equal labels and prose subtitles %s",
    async (subtitle) => {
      await accepted(
        await setup(existing, source("Vagabond, Vol. 1", subtitle, "Paperback")),
        existing,
      );
    },
  );
  it("accepts equal Binding on all three statements", async () => {
    await accepted(
      await setup(
        existing,
        source("Vagabond, Vol. 1 (Hardcover)", "Vol. 01 (Hardcover)", "Hardcover"),
        "hardcover",
      ),
      existing,
    );
  });
  it("leaves unknown target Binding to the reviewer", async () => {
    // Explicit undefined default arguments select the default; patch the target instead.
    const fixture = await setup(existing, source("Vagabond, Vol. 1", "Vol. 1 (Hardcover)"));
    await fixture.t.run((ctx) => ctx.db.patch(fixture.book.releaseId, { binding: undefined }));
    fixture.before = await state(fixture.t);
    await accepted(fixture, existing);
  });
  it.each([undefined, "", "  "])("accepts missing or blank subtitle %s", async (subtitle) => {
    const fixture = await setup(existing, source("Vagabond, Vol. 1", subtitle));
    expect(Object.hasOwn(fixture.snapshot, "subtitle")).toBe(false);
    await accepted(fixture, existing);
  });
  it("keeps a legacy subtitle-origin label when no source subtitle survived", async () => {
    const snapshot = parseEditionJson(source("Vagabond", "Vol. 1"))!;
    const { subtitle: _lost, ...legacy } = snapshot;
    // Undefined is omitted from the serialized mutation argument, just as
    // the historical snapshot lacked this optional field.
    const fixture = await setup(existing, source("Vagabond", "Vol. 1"), "paperback", {
      ...legacy,
      subtitle: undefined,
    });
    expect(Object.hasOwn(fixture.observation.snapshot, "subtitle")).toBe(false);
    await accepted(fixture, existing);
  });
});

describe("fresh OL scope and joining", () => {
  it.each(["Vol. 1 (Light Novel)", "Light Novel", "Vol. 1 (French Edition)"])(
    "the producer excludes scoped subtitle %s before import",
    async (subtitle) => {
      const t = makeT({ transactionLimits: true });
      await seedRegistry(t);
      await t.run(vagabond);
      const before = await state(t);
      expect(parseEditionJson(source("Vagabond, Vol. 1", subtitle))).toBeNull();
      expect(await state(t)).toEqual(before);
    },
  );
  it("keeps joined sequel and subtitle work names instead of flattening identity", () => {
    expect(parseEditionJson(source("Mashle", "Magic and Muscles, Vol. 3"))).toMatchObject({
      title: "Mashle: Magic and Muscles, Vol. 3",
      seriesTitle: "Mashle: Magic and Muscles",
      volumeLabel: "3",
    });
    expect(parseEditionJson(source("Kingdom", "Hearts II"))).toMatchObject({
      title: "Kingdom: Hearts II",
      bareRoman: true,
    });
  });
});
