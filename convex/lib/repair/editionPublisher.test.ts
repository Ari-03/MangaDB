// The editionPublisher and editionLinePublisher repairs move whole Editions,
// so they apply only against the exact Release closure the reviewer saw
// (expectedReleaseIds), a matching count of Releases without evidence
// (otherReleases) and, for an imprint move, PRH's own record of a Release's
// ISBN stating the imprint. Shape: the Kodansha/Vertical imprint correction
// (Nude Model, the Seraph of the End: Guren Ichinose line), a Kodansha
// Edition whose paperback carries a PRH "Vertical Comics" observation and
// whose ebook carries none.

import { describe, expect, it } from "vitest";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  insertBundle,
  insertBundleMember,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
} from "../../test.factories";
import { makeT, type TestT as T } from "../../test.helpers";
import type { EntryOf, RepairEntry } from "./entries";

async function run(t: T, entries: RepairEntry[], dryRun = false) {
  return await t.mutation(internal.repair.runBatch, { entries, dryRun, actor: "ari" });
}

const VERTICAL_COMICS = "Vertical Comics";

/** A PRH title snapshot as lib/prh.ts records it: its own ISBN and the imprint it states. */
const prhSnapshot = (isbn13: string, imprint = VERTICAL_COMICS) => ({
  kind: "prhTitle",
  isbn13,
  imprint,
  format: "physical",
});

/** An administrator "Ari", Kodansha, its imprint Vertical (parent row set), Seven Seas and one Series. */
async function seedCatalog(ctx: MutationCtx) {
  await ctx.db.insert("users", {
    clerkSubject: "admin",
    username: "Ari",
    usernameNormalized: "ari",
    role: "administrator",
    formatPreference: "both",
    ownershipVisibility: "private",
    readingVisibility: "private",
  });
  const kodansha = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
  const vertical = await insertPublisher(ctx, {
    name: "Vertical",
    slug: "vertical",
    parentPublisherId: kodansha,
  });
  const sevenSeas = await insertPublisher(ctx, { name: "Seven Seas", slug: "seven-seas" });
  const seriesId = await insertSeries(ctx, { title: "Nude Model" });
  return { kodansha, vertical, sevenSeas, seriesId };
}

type Catalog = Awaited<ReturnType<typeof seedCatalog>>;

/**
 * A Kodansha Edition with a physical paperback (PRH "Vertical Comics" on its
 * own ISBN, linked) and a digital ebook with no PRH record.
 */
async function insertPair(
  ctx: MutationCtx,
  c: Catalog,
  isbns: { paperback: string; ebook: string },
  edition: Partial<Doc<"editions">> = {},
) {
  const editionId = await insertEdition(ctx, { publisherId: c.kodansha, ...edition });
  const release = (fields: { isbn13: string; format: "physical" | "digital" }) =>
    insertRelease(ctx, { editionId, publisherId: c.kodansha, seriesIds: [c.seriesId], ...fields });
  const paperback = await release({ isbn13: isbns.paperback, format: "physical" });
  const ebook = await release({ isbn13: isbns.ebook, format: "digital" });
  const prh = await insertObservation(ctx, {
    sourceKey: "prh",
    sourceRecordId: isbns.paperback,
    recordRef: { type: "release", id: paperback },
    snapshot: prhSnapshot(isbns.paperback),
  });
  return { editionId, paperback, ebook, prh };
}

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const c = await seedCatalog(ctx);
    const pair = await insertPair(ctx, c, { paperback: "9781647293369", ebook: "9798889335016" });
    return { ...c, ...pair };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** The reviewed whole-Edition move; `overrides` stand in for a stale or wrong plan. */
const move = (
  s: Seeded,
  overrides: Partial<EntryOf<"editionPublisher">> = {},
): EntryOf<"editionPublisher"> => ({
  kind: "editionPublisher",
  key: "rt1-nude-model",
  reason: "PRH names the imprint",
  editionId: s.editionId,
  fromPublisherId: s.kodansha,
  toPublisherId: s.vertical,
  imprint: VERTICAL_COMICS,
  observationIds: [s.prh],
  otherReleases: 1,
  expectedReleaseIds: [s.paperback, s.ebook],
  ...overrides,
});

const revisionCount = (ctx: MutationCtx, ref: Doc<"revisions">["ref"]) =>
  ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", ref.type).eq("ref.id", ref.id))
    .collect()
    .then((rows) => rows.length);

/** One Edition's publisher, its Releases' publishers, and its Revision count. */
const editionState = async (ctx: MutationCtx, editionId: Id<"editions">) => ({
  edition: (await ctx.db.get(editionId))?.publisherId,
  releases: (
    await ctx.db
      .query("releases")
      .withIndex("by_edition", (q) => q.eq("editionId", editionId))
      .collect()
  ).map((release) => release.publisherId),
  revisions: await revisionCount(ctx, { type: "edition", id: editionId }),
});

const state = (t: T, s: Seeded) => t.run((ctx) => editionState(ctx, s.editionId));

/** Run one entry and expect it to skip with `reason`, leaving the Edition on Kodansha. */
async function expectSkip(t: T, s: Seeded, entry: RepairEntry, reason: RegExp) {
  const [outcome] = await run(t, [entry]);
  expect(outcome?.status).toBe("skipped");
  expect(outcome?.reason).toMatch(reason);
  const after = await state(t, s);
  expect(after.edition).toBe(s.kodansha);
  expect(after.releases.every((publisherId) => publisherId === s.kodansha)).toBe(true);
  expect(after.revisions).toBe(0);
}

describe("editionPublisher Release closure", () => {
  it("moves the whole Edition when the closure and count match, then reports alreadyApplied", async () => {
    const t = makeT();
    const s = await seed(t);
    const [dry] = await run(t, [move(s)], true);
    expect(dry?.status).toBe("applied");
    expect(await state(t, s)).toEqual({
      edition: s.kodansha,
      releases: [s.kodansha, s.kodansha],
      revisions: 0,
    });

    const [outcome] = await run(t, [move(s)]);
    expect(outcome?.status).toBe("applied");
    const after = await state(t, s);
    expect(after.edition).toBe(s.vertical);
    expect(after.releases).toEqual([s.vertical, s.vertical]);
    expect(after.revisions).toBe(1);

    const [again] = await run(t, [move(s)]);
    expect(again?.status).toBe("alreadyApplied");
    expect((await state(t, s)).revisions).toBe(after.revisions);
  });

  it("refuses the wrong count of Releases without evidence (the Nude Model 0)", async () => {
    const t = makeT();
    const s = await seed(t);
    await expectSkip(t, s, move(s, { otherReleases: 0 }), /1 releases without evidence/);
  });

  it("refuses a move without expectedReleaseIds", async () => {
    const t = makeT();
    const s = await seed(t);
    await expectSkip(
      t,
      s,
      move(s, { expectedReleaseIds: undefined }),
      /expectedReleaseIds is required/,
    );
  });

  it("refuses a Release added to the Edition since review", async () => {
    const t = makeT();
    const s = await seed(t);
    const added = await t.run((ctx) =>
      insertRelease(ctx, {
        editionId: s.editionId,
        publisherId: s.kodansha,
        seriesIds: [s.seriesId],
        isbn13: "9781647290000",
        format: "digital",
      }),
    );
    await expectSkip(t, s, move(s), new RegExp(`unexpected \\[${added}\\]`));
  });

  it("refuses a Release that left the Edition, moved or deleted", async () => {
    const t = makeT();
    const s = await seed(t);
    const elsewhere = await t.run((ctx) => insertEdition(ctx, { publisherId: s.kodansha }));
    await t.run((ctx) => ctx.db.patch(s.ebook, { editionId: elsewhere }));
    await expectSkip(t, s, move(s), new RegExp(`missing \\[${s.ebook}\\]`));

    await t.run((ctx) => ctx.db.delete(s.ebook));
    await expectSkip(t, s, move(s), new RegExp(`missing \\[${s.ebook}\\]`));
  });

  it("counts a hidden Release in the closure, since the move rewrites it too", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.ebook, { status: "hidden" }));
    await expectSkip(
      t,
      s,
      move(s, { expectedReleaseIds: [s.paperback], otherReleases: 0 }),
      new RegExp(`unexpected \\[${s.ebook}\\]`),
    );
    const [outcome] = await run(t, [move(s)]);
    expect(outcome?.status).toBe("applied");
  });

  it("refuses a closure listing one Release twice", async () => {
    const t = makeT();
    const s = await seed(t);
    await expectSkip(
      t,
      s,
      move(s, { expectedReleaseIds: [s.paperback, s.ebook, s.ebook] }),
      /lists a Release twice/,
    );
  });
});

describe("editionPublisher imprint evidence", () => {
  it("refuses evidence relinked to a Release outside the Edition", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId: s.kodansha });
      const elsewhere = await insertRelease(ctx, {
        editionId,
        publisherId: s.kodansha,
        seriesIds: [s.seriesId],
        isbn13: "9781647293369",
      });
      await ctx.db.patch(s.prh, { recordRef: { type: "release", id: elsewhere } });
    });
    await expectSkip(t, s, move(s), /is not linked to a Release of the Edition/);
    // Recounting without it still finds no evidence for the imprint.
    await expectSkip(t, s, move(s, { observationIds: [], otherReleases: 2 }), /needs PRH evidence/);
  });

  it("refuses another source's imprint statement (Seven Seas carries `imprint` too)", async () => {
    const t = makeT();
    const s = await seed(t);
    const sevenSeas = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "nude-model",
        recordRef: { type: "release", id: s.paperback },
        snapshot: { isbn13: "9781647293369", imprint: VERTICAL_COMICS },
      }),
    );
    await expectSkip(
      t,
      s,
      move(s, { observationIds: [sevenSeas] }),
      /is a sevenseas record, not PRH's/,
    );
    await expectSkip(
      t,
      s,
      move(s, { observationIds: [s.prh, sevenSeas] }),
      /is a sevenseas record, not PRH's/,
    );
  });

  it("refuses a PRH record of another ISBN linked to the Release", async () => {
    const t = makeT();
    const s = await seed(t);
    // Linked to the paperback, but PRH's record (and its snapshot) is another printing's ISBN.
    await t.run((ctx) =>
      ctx.db.patch(s.prh, {
        sourceRecordId: "9781647290001",
        snapshot: prhSnapshot("9781647290001"),
      }),
    );
    await expectSkip(t, s, move(s), /is not the Release's own ISBN record/);
    // The record ID agrees but the snapshot names another ISBN.
    await t.run((ctx) =>
      ctx.db.patch(s.prh, {
        sourceRecordId: "9781647293369",
        snapshot: prhSnapshot("9781647290001"),
      }),
    );
    await expectSkip(t, s, move(s), /is not the Release's own ISBN record/);
  });

  it("refuses a withdrawn record and an Other Printing's record", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.prh, { withdrawn: true }));
    await expectSkip(t, s, move(s), /is withdrawn/);
    await t.run((ctx) =>
      ctx.db.patch(s.prh, { withdrawn: false, printingIsbn13: "9781647293369" }),
    );
    await expectSkip(t, s, move(s), /records Other Printing/);
  });

  it("refuses a record stating another imprint, and PRH's prose imprint", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.prh, { snapshot: prhSnapshot("9781647293369", "Kodansha Comics") }),
    );
    await expectSkip(t, s, move(s), /states "Kodansha Comics", not "Vertical Comics"/);
    await t.run((ctx) =>
      ctx.db.patch(s.prh, { snapshot: prhSnapshot("9781647293369", "Vertical") }),
    );
    await expectSkip(t, s, move(s, { imprint: "Vertical" }), /PRH's prose imprint/);
  });

  it("refuses a sibling's contrary own-ISBN PRH statement, linked or not, unless withdrawn", async () => {
    const t = makeT();
    const s = await seed(t);
    const contrary = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: "9798889335016",
        snapshot: { ...prhSnapshot("9798889335016", "Kodansha Comics"), format: "digital" },
      }),
    );
    await expectSkip(t, s, move(s), /PRH states "Kodansha Comics" for 9798889335016/);
    await t.run((ctx) => ctx.db.patch(contrary, { withdrawn: true }));
    const [outcome] = await run(t, [move(s)]);
    expect(outcome?.status).toBe("applied");
  });

  it("moves only toward the known imprint row of the Edition's own company", async () => {
    const t = makeT();
    const s = await seed(t);
    const ghostShip = await t.run((ctx) =>
      insertPublisher(ctx, {
        name: "Ghost Ship",
        slug: "ghost-ship",
        parentPublisherId: s.sevenSeas,
      }),
    );
    await expectSkip(
      t,
      s,
      move(s, { imprint: "Ghost Ship", toPublisherId: ghostShip }),
      /ghost-ship is not an imprint of kodansha/,
    );
    await expectSkip(
      t,
      s,
      move(s, { toPublisherId: ghostShip }),
      /resolves to vertical, not ghost-ship/,
    );
    await expectSkip(
      t,
      s,
      move(s, { fromPublisherId: s.sevenSeas }),
      /not an imprint of seven-seas/,
    );
    // The catalog row must name the company too, not only lib/publishers.ts.
    await t.run((ctx) => ctx.db.patch(s.vertical, { parentPublisherId: undefined }));
    await expectSkip(t, s, move(s), /vertical does not name kodansha as its parent/);
  });
});

describe("editionPublisher record guards", () => {
  it("refuses a locked Edition and a publisher Human Override", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.editionId, { locked: true }));
    await expectSkip(t, s, move(s), /is locked/);
    await t.run((ctx) =>
      ctx.db.patch(s.editionId, { locked: undefined, overriddenFields: ["publisherId"] }),
    );
    await expectSkip(t, s, move(s), /has a publisher override/);
  });

  it("refuses a Release in another publisher's Bundle, not one in the target's", async () => {
    const t = makeT();
    const s = await seed(t);
    const box = await t.run(async (ctx) => {
      const bundleId = await insertBundle(ctx, { publisherId: s.kodansha });
      await insertBundleMember(ctx, { bundleId, releaseId: s.paperback });
      return bundleId;
    });
    await expectSkip(t, s, move(s), /is in bundle \d+ of another publisher/);
    await t.run((ctx) => ctx.db.patch(box, { publisherId: s.vertical }));
    const [outcome] = await run(t, [move(s)]);
    expect(outcome?.status).toBe("applied");
  });

  it("refuses a Release with an Other Printing or Alternate Ebook ISBN", async () => {
    const t = makeT();
    const s = await seed(t);
    const row = await t.run((ctx) =>
      ctx.db.insert("releaseIsbns", {
        releaseId: s.paperback,
        isbn13: "9781647290002",
        reason: "earlier printing",
        sourceKey: "prh",
      }),
    );
    await expectSkip(t, s, move(s), /has other ISBN 9781647290002/);
    await t.run((ctx) =>
      ctx.db.patch(row, { releaseId: s.ebook, kind: "alternateEbook", isbn13: "9798889330000" }),
    );
    await expectSkip(t, s, move(s), /has other ISBN 9798889330000/);
  });

  it("keeps the legacy owner repair (no imprint): any linked observation counts", async () => {
    const t = makeT();
    const s = await seed(t);
    const ol = await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "openlibrary",
        sourceRecordId: "OL1M",
        recordRef: { type: "release", id: s.ebook },
        snapshot: { publishers: ["Seven Seas"] },
      }),
    );
    const owner = move(s, {
      imprint: null,
      toPublisherId: s.sevenSeas,
      observationIds: [ol],
      otherReleases: 1,
    });
    await expectSkip(t, s, { ...owner, otherReleases: 0 }, /1 releases without evidence/);
    const [outcome] = await run(t, [owner]);
    expect(outcome?.status).toBe("applied");
    expect((await state(t, s)).edition).toBe(s.sevenSeas);
    const [again] = await run(t, [owner]);
    expect(again?.status).toBe("alreadyApplied");
  });

  it("still refuses an Edition in a line of another publisher", async () => {
    const t = makeT();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const lineId = await insertEditionLine(ctx, {
        seriesId: s.seriesId,
        publisherId: s.kodansha,
      });
      await ctx.db.patch(s.editionId, { editionLineId: lineId });
    });
    await expectSkip(t, s, move(s), /another publisher's edition line/);
  });
});

/** A Kodansha line of two members, each a PRH-evidenced paperback with an ebook. */
async function seedLine(t: T) {
  return await t.run(async (ctx) => {
    const c = await seedCatalog(ctx);
    const lineId = await insertEditionLine(ctx, {
      seriesId: c.seriesId,
      publisherId: c.kodansha,
      name: "Seraph of the End: Guren Ichinose",
    });
    const one = await insertPair(
      ctx,
      c,
      { paperback: "9781647292379", ebook: "9798889331643" },
      { editionLineId: lineId, linePosition: "1" },
    );
    const two = await insertPair(
      ctx,
      c,
      { paperback: "9781647292744", ebook: "9798889332442" },
      { editionLineId: lineId, linePosition: "2" },
    );
    return { ...c, lineId, one, two };
  });
}

type Line = Awaited<ReturnType<typeof seedLine>>;
type Pair = Line["one"];

const member = (pair: Pair) => ({
  editionId: pair.editionId,
  observationIds: [pair.prh],
  otherReleases: 1,
  expectedReleaseIds: [pair.paperback, pair.ebook],
});

const lineMove = (
  l: Line,
  overrides: Partial<EntryOf<"editionLinePublisher">> = {},
): EntryOf<"editionLinePublisher"> => ({
  kind: "editionLinePublisher",
  key: "p1-seraph-line",
  reason: "PRH names the imprint of every member",
  lineId: l.lineId,
  fromPublisherId: l.kodansha,
  toPublisherId: l.vertical,
  imprint: VERTICAL_COMICS,
  editions: [member(l.one), member(l.two)],
  ...overrides,
});

/** The line's publisher and Revision count, and each member's state. */
const lineState = (t: T, l: Line) =>
  t.run(async (ctx) => ({
    line: (await ctx.db.get(l.lineId))?.publisherId,
    lineRevisions: await revisionCount(ctx, { type: "editionLine", id: l.lineId }),
    one: await editionState(ctx, l.one.editionId),
    two: await editionState(ctx, l.two.editionId),
  }));

/** Run one line entry, expect it skipped with `reason`, and nothing in the line moved. */
async function expectLineSkip(t: T, l: Line, entry: RepairEntry, reason: RegExp) {
  const before = await lineState(t, l);
  const [outcome] = await run(t, [entry]);
  expect(outcome?.status).toBe("skipped");
  expect(outcome?.reason).toMatch(reason);
  expect(await lineState(t, l)).toEqual(before);
  expect(before.line).toBe(l.kodansha);
}

describe("editionLinePublisher", () => {
  it("moves the line and every member atomically, dry run first, then reports alreadyApplied", async () => {
    const t = makeT();
    const l = await seedLine(t);
    const before = await lineState(t, l);
    const [dry] = await run(t, [lineMove(l)], true);
    expect(dry?.status).toBe("applied");
    expect(await lineState(t, l)).toEqual(before);

    const [outcome] = await run(t, [lineMove(l)]);
    expect(outcome?.status).toBe("applied");
    const after = await lineState(t, l);
    expect(after).toEqual({
      line: l.vertical,
      lineRevisions: 1,
      one: { edition: l.vertical, releases: [l.vertical, l.vertical], revisions: 1 },
      two: { edition: l.vertical, releases: [l.vertical, l.vertical], revisions: 1 },
    });

    const [again] = await run(t, [lineMove(l)]);
    expect(again?.status).toBe("alreadyApplied");
    expect(await lineState(t, l)).toEqual(after);
  });

  it("refuses an omitted or newly added active member", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await expectLineSkip(
      t,
      l,
      lineMove(l, { editions: [member(l.one)] }),
      /active line member edition \d+ is not in the entry/,
    );
    await t.run((ctx) =>
      insertEdition(ctx, { publisherId: l.kodansha, editionLineId: l.lineId, linePosition: "3" }),
    );
    await expectLineSkip(t, l, lineMove(l), /active line member edition \d+ is not in the entry/);
  });

  it("refuses a listed Edition outside the line, a hidden listed member, or a duplicate", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run((ctx) => ctx.db.patch(l.two.editionId, { editionLineId: undefined }));
    await expectLineSkip(t, l, lineMove(l), /is not in line/);
    await t.run((ctx) =>
      ctx.db.patch(l.two.editionId, { editionLineId: l.lineId, status: "hidden" }),
    );
    await expectLineSkip(t, l, lineMove(l), /edition \d+ is not active/);
    await t.run((ctx) => ctx.db.patch(l.two.editionId, { status: "active" }));
    await expectLineSkip(
      t,
      l,
      lineMove(l, { editions: [member(l.one), member(l.one), member(l.two)] }),
      /lists an Edition twice/,
    );
  });

  it("refuses a hidden member left on the old publisher, not one already on the target", async () => {
    const t = makeT();
    const l = await seedLine(t);
    const hidden = await t.run((ctx) =>
      insertEdition(ctx, {
        publisherId: l.kodansha,
        editionLineId: l.lineId,
        status: "hidden",
      }),
    );
    await expectLineSkip(
      t,
      l,
      lineMove(l),
      /hidden line member edition \d+ is on another publisher/,
    );
    await t.run((ctx) => ctx.db.patch(hidden, { publisherId: l.vertical }));
    const [outcome] = await run(t, [lineMove(l)]);
    expect(outcome?.status).toBe("applied");
  });

  it("rolls back every member when one member fails its own checks", async () => {
    const t = makeT();
    const l = await seedLine(t);
    // Member two's ebook: PRH's own record says Kodansha Comics.
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: "9798889332442",
        snapshot: prhSnapshot("9798889332442", "Kodansha Comics"),
      }),
    );
    await expectLineSkip(t, l, lineMove(l), /PRH states "Kodansha Comics" for 9798889332442/);
  });

  it("refuses member closure drift, a wrong count, and a member without evidence", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await expectLineSkip(
      t,
      l,
      lineMove(l, {
        editions: [member(l.one), { ...member(l.two), expectedReleaseIds: [l.two.paperback] }],
      }),
      new RegExp(`unexpected \\[${l.two.ebook}\\]`),
    );
    await expectLineSkip(
      t,
      l,
      lineMove(l, { editions: [member(l.one), { ...member(l.two), otherReleases: 0 }] }),
      /1 releases without evidence/,
    );
    await expectLineSkip(
      t,
      l,
      lineMove(l, {
        editions: [member(l.one), { ...member(l.two), observationIds: [], otherReleases: 2 }],
      }),
      /needs PRH evidence/,
    );
  });

  it("refuses a locked or overridden line or member", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run((ctx) => ctx.db.patch(l.lineId, { locked: true }));
    await expectLineSkip(t, l, lineMove(l), /line ".*" is locked/);
    await t.run((ctx) =>
      ctx.db.patch(l.lineId, { locked: undefined, overriddenFields: ["publisherId"] }),
    );
    await expectLineSkip(t, l, lineMove(l), /line ".*" has a publisher override/);
    await t.run((ctx) => ctx.db.patch(l.lineId, { overriddenFields: undefined }));
    await t.run((ctx) => ctx.db.patch(l.two.editionId, { locked: true }));
    await expectLineSkip(t, l, lineMove(l), /edition \d+ is locked/);
  });

  it("refuses a line on another company", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run((ctx) => ctx.db.patch(l.lineId, { publisherId: l.sevenSeas }));
    const [outcome] = await run(t, [lineMove(l)]);
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.reason).toMatch(/edition line is on seven-seas, plan expected kodansha/);
  });

  it("finishes members a line already on the target still holds on the old publisher", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run((ctx) => ctx.db.patch(l.lineId, { publisherId: l.vertical }));
    const [outcome] = await run(t, [lineMove(l)]);
    expect(outcome?.status).toBe("applied");
    const after = await lineState(t, l);
    expect(after.lineRevisions).toBe(0);
    expect(after.one.edition).toBe(l.vertical);
    expect(after.two.edition).toBe(l.vertical);
  });
});

describe("editionLinePublisher evidence and publisher consistency", () => {
  it("refuses to move a line with no active members or evidence", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(l.one.editionId, { status: "merged" });
      await ctx.db.patch(l.two.editionId, { status: "merged" });
    });
    const before = await lineState(t, l);
    const [outcome] = await run(t, [lineMove(l, { editions: [] })]);
    expect(outcome?.status).toBe("skipped");
    expect(await lineState(t, l)).toEqual(before);
    expect((await lineState(t, l)).lineRevisions).toBe(0);
  });

  it("refuses unevidenced line moves when members are already on the target", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(l.one.editionId, { publisherId: l.vertical });
      await ctx.db.patch(l.two.editionId, { publisherId: l.vertical });
    });
    // Bogus evidence: no observations, wrong counts, wrong closures.
    const bogus = (pair: Pair) => ({
      editionId: pair.editionId,
      observationIds: [],
      otherReleases: 99,
      expectedReleaseIds: [],
    });
    const before = await lineState(t, l);
    const [outcome] = await run(t, [lineMove(l, { editions: [bogus(l.one), bogus(l.two)] })]);
    expect(outcome?.status).toBe("skipped");
    expect(await lineState(t, l)).toEqual(before);
  });

  it("refuses an already-applied answer when member Release publishers disagree", async () => {
    const t = makeT();
    const l = await seedLine(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(l.lineId, { publisherId: l.vertical });
      await ctx.db.patch(l.one.editionId, { publisherId: l.vertical });
      await ctx.db.patch(l.two.editionId, { publisherId: l.vertical });
    });
    const before = await lineState(t, l);
    const [outcome] = await run(t, [lineMove(l)]);
    expect(outcome?.status).toBe("skipped");
    expect(await lineState(t, l)).toEqual(before);
  });

  it("refuses a hidden target member whose Release publisher disagrees", async () => {
    const t = makeT();
    const l = await seedLine(t);
    const hidden = await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, {
        publisherId: l.vertical,
        editionLineId: l.lineId,
        status: "hidden",
      });
      await insertRelease(ctx, {
        editionId,
        publisherId: l.kodansha,
        seriesIds: [l.seriesId],
        isbn13: "9781647299999",
      });
      return editionId;
    });
    const before = await lineState(t, l);
    const [outcome] = await run(t, [lineMove(l)]);
    expect((await t.run((ctx) => editionState(ctx, hidden))).releases).toEqual([l.kodansha]);
    expect(outcome?.status).toBe("skipped");
    expect(await lineState(t, l)).toEqual(before);
  });
});
