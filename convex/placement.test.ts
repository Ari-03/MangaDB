// "Prepare placement" on a Held Book (placement.ts): the Draft it writes for
// an ordinary single book and for a book on a line, who may prepare, submit
// and approve, the books it refuses and why, one Draft per book, and what
// approval does when an import created the same records while the Proposal
// waited.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { recordUnplaced } from "./lib/observations";
import { parseDumpLine } from "./lib/openLibrary";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, bob, carol, dave, makeT, seedRegistry, seedTeam, signedIn, type TestT, type TestUser } from "./test.helpers";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

/** Serve these Open Library editions as the filtered dump. */
function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions.map(dumpLine).join("\n");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input) === DUMP_URL ? new Response(`${body}\n`) : new Response("not found", { status: 404 }),
  );
}

const dumpLine = (edition: Record<string, unknown>) =>
  `/type/edition\t${String(edition.key)}\t1\t2026-08-01T00:00:00\t${JSON.stringify(edition)}`;

/** A VIZ book as Open Library lists it. */
const book = (key: string, title: string, isbn: string, publishers = ["Viz Media"]) => ({
  key,
  title,
  publishers,
  isbn_13: [isbn],
  physical_format: "paperback",
  publish_date: "Oct 13, 2026",
  languages: [{ key: "/languages/eng" }],
});
const ALICE_1 = book("/books/OL1M", "Alice in Borderland, Vol. 1", "9781974728374");
// Book 4 of VIZ's three-in-one line: Volumes 10 to 12, never Volume 4.
const VAGABOND_4 = book("/books/OL2M", "Vagabond Definitive Edition, Vol. 4", "9781974700400");

beforeEach(() => {
  vi.stubEnv("OPENLIBRARY_DUMP_URL", DUMP_URL);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * The cast, VIZ, "Alice in Borderland" (7) with only its Volume 4 and
 * "Vagabond" (8) with only Volumes 10 and 11, and Open Library's two books
 * held: Alice 1 as a missing Volume, Vagabond's book 4 as packaging.
 */
async function held(t: TestT) {
  await seedRegistry(t);
  await seedTeam(t, [alice, bob, carol, dave]);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const aliceId = await insertSeries(ctx, { publicId: 7, title: "Alice in Borderland" });
    await insertVolume(ctx, { seriesId: aliceId, position: 4, label: "4" });
    const vagabondId = await insertSeries(ctx, { publicId: 8, title: "Vagabond" });
    await insertVolume(ctx, { seriesId: vagabondId, position: 10, label: "10" });
    await insertVolume(ctx, { seriesId: vagabondId, position: 11, label: "11" });
    return { publisherId, aliceId, vagabondId };
  });
  stubDump([ALICE_1, VAGABOND_4]);
  await t.action(internal.openLibrary.sync, {});
  const rows = (await heldList(t)).page;
  expect(rows.map((row) => [row.sourceRecordId, row.kind])).toEqual([
    ["/books/OL2M", "packaging"],
    ["/books/OL1M", "volumeMissing"],
  ]);
  const observationOf = (key: string) => rows.find((row) => row.sourceRecordId === key)!.observationId;
  return { ...ids, alice1: observationOf("/books/OL1M"), vagabond4: observationOf("/books/OL2M") };
}

const heldList = (t: TestT) =>
  signedIn(t, carol).query(api.imports.heldBooks, { paginationOpts: { numItems: 25, cursor: null } });

async function prepare(t: TestT, observationId: Id<"sourceObservations">, user: TestUser = carol) {
  const result = await signedIn(t, user).mutation(api.placement.preparePlacement, { observationId });
  if (result.status === "unavailable") throw new Error(result.reason);
  return result.proposalId;
}

const detail = (t: TestT, proposalId: Id<"proposals">) =>
  signedIn(t, carol).query(api.proposals.proposalDetail, { proposalId });

const approve = (t: TestT, proposalId: Id<"proposals">) =>
  signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });

/** The Series' active Volume labels, in position order. */
const volumeLabels = (t: TestT, seriesId: Id<"series">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", seriesId)).collect())
      .filter((volume) => volume.status === "active")
      .sort((a, b) => a.position - b.position)
      .map((volume) => volume.label),
  );

const linkOf = (t: TestT, observationId: Id<"sourceObservations">) =>
  t.run(async (ctx) => (await ctx.db.get(observationId))?.recordRef);

describe("an ordinary single book", () => {
  it("prepared and submitted by an Editor, approved by a Moderator: Volume, Edition and Release exist and the book is linked", async () => {
    const t = makeT();
    const { alice1, aliceId, publisherId } = await held(t);
    const proposalId = await prepare(t, alice1);

    const draft = await detail(t, proposalId);
    expect(draft).toMatchObject({ state: "draft", author: { kind: "user", username: "carol", role: "editor" } });
    expect(draft!.placement).toMatchObject({
      book: {
        title: "Alice in Borderland, Vol. 1",
        label: "1",
        line: null,
        publisher: "Viz Media",
        isbn13: "9781974728374",
        url: "https://openlibrary.org/books/OL1M",
        ordinary: true,
      },
      series: { publicId: 7, title: "Alice in Borderland" },
      coverage: { kind: "volumes", volumes: [{ label: "1", created: true }] },
      line: null,
      publisherSlug: "viz-media",
      release: { format: "physical", binding: "paperback", isbn13: "9781974728374" },
    });
    expect(draft!.draft!.evidence).toEqual([
      { kind: "observation", sourceKey: "openlibrary", url: "https://openlibrary.org/books/OL1M" },
    ]);
    // While it is a Draft and while it waits, the book stays held, marked.
    expect((await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal).toEqual({
      id: proposalId,
      state: "draft",
    });

    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    expect((await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal).toEqual({
      id: proposalId,
      state: "inReview",
    });
    // An Editor cannot approve, their own Proposal included.
    await expect(
      signedIn(t, carol).mutation(api.proposals.approveProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });

    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, aliceId)).toEqual(["1", "4"]);
    const release = await t.run(async (ctx) =>
      ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", "9781974728374")).unique(),
    );
    expect(release).toMatchObject({ status: "active", format: "physical", publisherId, seriesIds: [aliceId] });
    expect(await linkOf(t, alice1)).toEqual({ type: "release", id: release!._id });
    expect((await heldList(t)).page.map((row) => row.observationId)).not.toContain(alice1);
    const page = await t.query(api.catalog.seriesPage, { publicId: 7 });
    expect(JSON.stringify(page!.editionGroups)).toContain("9781974728374");
    expect(page!.volumes.map((volume) => volume.label)).toEqual(["1", "4"]);
  });

  it("lets a Moderator approve their own placement, as any Proposal of theirs", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1, bob);
    await signedIn(t, bob).mutation(api.proposals.submitProposal, { proposalId });
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await linkOf(t, alice1)).toMatchObject({ type: "release" });
  });

  it("applies the book's 18+ evidence to its Series on approval", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob, carol]);
    const { seriesId, observationId } = await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      const seriesId = await insertSeries(ctx, { publicId: 9, title: "Night Garden" });
      const snapshot = {
        kind: "book",
        url: "https://sevenseasentertainment.com/books/night-garden-vol-3/",
        title: "Night Garden Vol. 3",
        modifiedGmt: "2026-08-01T00:00:00",
        seriesTitle: "Night Garden",
        seriesSlug: "night-garden",
        volumeLabel: "3",
        creators: [],
        category: "Manga",
        isbn13: "9798891600003",
        mature: true,
      };
      const observationId = await insertObservation(ctx, { sourceKey: "sevenseas", sourceRecordId: "303", snapshot });
      await recordUnplaced(ctx, (await ctx.db.get(observationId))!, { kind: "volumeMissing", reason: "Held.", seriesId }, Date.now());
      return { seriesId, observationId };
    });
    const proposalId = await prepare(t, observationId);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect((await t.run((ctx) => ctx.db.get(seriesId)))?.mature).toBe(true);
    expect(await volumeLabels(t, seriesId)).toEqual(["3"]);
  });

  it("refuses a reader outside the Data Team", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    await expect(
      signedIn(t, dave).mutation(api.placement.preparePlacement, { observationId: alice1 }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });
});

describe("a book on a line", () => {
  it("proposes no Volume from its book number, cannot be submitted until its coverage is stated, then covers the stated Volumes", async () => {
    const t = makeT();
    const { vagabond4, vagabondId } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    const draft = (await detail(t, proposalId))!;
    expect(draft.placement).toMatchObject({
      book: { label: null, line: { name: "Definitive Edition", position: "4" }, ordinary: false },
      coverage: { kind: "pending" },
      line: { name: "Definitive Edition", position: "4", created: true },
    });
    expect(draft.draft!.ops.filter((op) => op.kind === "create" && op.table === "volumes")).toEqual([]);
    await expect(
      signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({ data: { code: "invalidCreate", message: expect.stringContaining("state the Volumes it covers") } });

    await signedIn(t, carol).mutation(api.placement.setPlacement, {
      proposalId,
      coverage: { from: "10", to: "12" },
      line: { name: "Definitive Edition", position: "4" },
      comment: "Book 4 of VIZ's three-in-one Definitive Edition collects Volumes 10 to 12.",
    });
    expect((await detail(t, proposalId))!.placement!.coverage).toEqual({
      kind: "volumes",
      volumes: [
        { label: "10", created: false },
        { label: "11", created: false },
        { label: "12", created: true },
      ],
    });
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    expect((await approve(t, proposalId)).status).toBe("approved");

    expect(await volumeLabels(t, vagabondId)).toEqual(["10", "11", "12"]);
    await t.run(async (ctx) => {
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      const line = await ctx.db.get(editions[0]!.editionLineId!);
      expect(line).toMatchObject({ name: "Definitive Edition", seriesId: vagabondId });
      expect(editions[0]!.linePosition).toBe("4");
      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", editions[0]!._id))
        .collect();
      const labels = await Promise.all(coverage.map(async (row) => (await ctx.db.get(row.volumeId))?.label));
      expect(labels).toEqual(["10", "11", "12"]);
    });
    expect(await linkOf(t, vagabond4)).toMatchObject({ type: "release" });
  });

  it("places it as Unmapped Packaging under its line, which needs a line and creates no Volume", async () => {
    const t = makeT();
    const { vagabond4, vagabondId } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    const set = (line: { name: string; position: string | null } | null) =>
      signedIn(t, carol).mutation(api.placement.setPlacement, {
        proposalId,
        coverage: "unmapped",
        line,
        comment: "Coverage unknown.",
      });
    await expect(set(null)).rejects.toMatchObject({ data: { code: "invalidCoverage" } });
    await set({ name: "Definitive Edition", position: "4" });
    expect((await detail(t, proposalId))!.placement!.coverage).toEqual({ kind: "unmapped" });
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, vagabondId)).toEqual(["10", "11"]);
    const editions = await t.run((ctx) => ctx.db.query("editions").collect());
    expect(editions).toEqual([expect.objectContaining({ coverageUnmapped: true, linePosition: "4" })]);
  });

  it("lets only the author restate it, and only while it is a Draft", async () => {
    const t = makeT();
    const { vagabond4 } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    const restate = (user: TestUser) =>
      signedIn(t, user).mutation(api.placement.setPlacement, {
        proposalId,
        coverage: { from: "10", to: "12" },
        line: { name: "Definitive Edition", position: "4" },
        comment: "Volumes 10 to 12.",
      });
    await expect(restate(bob)).rejects.toMatchObject({ data: { code: "forbidden" } });
    await restate(carol);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    await expect(restate(carol)).rejects.toMatchObject({ data: { code: "badState" } });
  });
});

describe("books it does not prepare", () => {
  /** Hold an observation of `snapshot` as `kind` under `seriesId`, as an importer would. */
  async function holdBook(
    t: TestT,
    sourceKey: string,
    snapshot: Record<string, unknown>,
    hold: { kind: "volumeMissing" | "packaging" | "series" | "isbn" | "other"; seriesId?: Id<"series"> },
  ) {
    return await t.run(async (ctx) => {
      const id = await insertObservation(ctx, { sourceKey, sourceRecordId: String(snapshot.key ?? snapshot.annId), snapshot });
      await recordUnplaced(ctx, (await ctx.db.get(id))!, { ...hold, reason: "Held for the test." }, Date.now());
      return id;
    });
  }
  const olSnapshot = (edition: Record<string, unknown>) => parseDumpLine(dumpLine(edition))!;

  async function reasonFor(t: TestT, observationId: Id<"sourceObservations">) {
    const result = await signedIn(t, carol).mutation(api.placement.preparePlacement, { observationId });
    expect(result.status).toBe("unavailable");
    return result.status === "unavailable" ? result.reason : null;
  }

  it("says why, and leaves each book held with no Proposal", async () => {
    const t = makeT();
    const { aliceId, alice1 } = await held(t);
    const locked = await t.run((ctx) => insertSeries(ctx, { publicId: 9, title: "Locked Saga", locked: true }));
    const hidden = await t.run((ctx) => insertSeries(ctx, { publicId: 10, title: "Hidden Saga", status: "hidden" }));

    const noSeries = await holdBook(t, "openlibrary", olSnapshot(book("/books/OL10M", "Nobody, Vol. 1", "9781974700011")), {
      kind: "series",
    });
    const lockedBook = await holdBook(t, "openlibrary", olSnapshot(book("/books/OL11M", "Locked Saga, Vol. 1", "9781974700028")), {
      kind: "volumeMissing",
      seriesId: locked,
    });
    const hiddenBook = await holdBook(t, "openlibrary", olSnapshot(book("/books/OL12M", "Hidden Saga, Vol. 1", "9781974700035")), {
      kind: "volumeMissing",
      seriesId: hidden,
    });
    const unknownPublisher = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL13M", "Alice in Borderland, Vol. 2", "9781974700042", ["Unheard Of Press"])),
      { kind: "volumeMissing", seriesId: aliceId },
    );
    const rebinder = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL14M", "Alice in Borderland, Vol. 3", "9781974700059", ["Turtleback", "Viz Media"])),
      { kind: "volumeMissing", seriesId: aliceId },
    );
    // An ISBN or slot taken, or a missing publisher row, under a Series that would do.
    const slotTaken = await holdBook(t, "openlibrary", olSnapshot(book("/books/OL15M", "Alice in Borderland, Vol. 6", "9781974700073")), {
      kind: "isbn",
      seriesId: aliceId,
    });
    const noPublisherRow = await holdBook(t, "openlibrary", olSnapshot(book("/books/OL16M", "Alice in Borderland, Vol. 7", "9781974700080")), {
      kind: "other",
      seriesId: aliceId,
    });
    const prose = await holdBook(
      t,
      "ann",
      {
        kind: "annRelease",
        annId: "5001",
        mangaId: "77",
        url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5001",
        title: "Alice in Borderland",
        label: "5",
        multi: false,
        format: "physical",
        editionLineHint: false,
        isbn13: "9781974700066",
        page: { status: "ok", fetchedAt: 1, distributor: "Yen On", isbn13: "9781974700066" },
      },
      { kind: "volumeMissing", seriesId: aliceId },
    );

    expect(await reasonFor(t, noSeries)).toMatch(/^No single active, unlocked Series fits this book/);
    expect(await reasonFor(t, slotTaken)).toMatch(/^Its ISBN, or its Volume's slot for this publisher and format, is already taken/);
    expect(await reasonFor(t, noPublisherRow)).toBe(
      "Its publisher is missing or has no Publisher row. Prepare placement never creates a Publisher.",
    );
    expect(await reasonFor(t, lockedBook)).toBe('The Series it names, "Locked Saga", is locked.');
    expect(await reasonFor(t, hiddenBook)).toBe('The Series it names, "Hidden Saga", is hidden.');
    expect(await reasonFor(t, unknownPublisher)).toBe(
      'No Publisher row matches "Unheard Of Press". Prepare placement never creates a Publisher.',
    );
    expect(await reasonFor(t, rebinder)).toMatch(/library rebinder's copy/);
    expect(await reasonFor(t, prose)).toBe('"Yen On" is a prose imprint: out of manga scope.');

    // Another source's Release took the ISBN after the book was held.
    await t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").first())!._id;
      const volumeId = await insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1" });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      await insertRelease(ctx, { editionId, publisherId, seriesIds: [aliceId], isbn13: "9781974728374" });
    });
    expect(await reasonFor(t, alice1)).toBe(
      "ISBN 9781974728374 is already on an active Release: link or correct that Release instead.",
    );

    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toHaveLength(10);
  });
});

describe("one Draft per book", () => {
  it("opens the same Draft on a repeat, a replay and another member's click", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const first = await signedIn(t, carol).mutation(api.placement.preparePlacement, { observationId: alice1 });
    expect(first.status).toBe("prepared");
    const again = await signedIn(t, carol).mutation(api.placement.preparePlacement, { observationId: alice1 });
    const other = await signedIn(t, bob).mutation(api.placement.preparePlacement, { observationId: alice1 });
    expect([again, other]).toEqual([
      { status: "existing", proposalId: first.status === "prepared" ? first.proposalId : null },
      { status: "existing", proposalId: first.status === "prepared" ? first.proposalId : null },
    ]);
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(1);
  });

  it("returns a rejected book to the held list, ready to prepare again", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    // Open Library lists it again while it waits: still held, still marked.
    await t.action(internal.openLibrary.sync, {});
    expect((await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal?.state).toBe("inReview");
    await signedIn(t, bob).mutation(api.proposals.rejectProposal, { proposalId, note: "Wrong book." });
    const row = (await heldList(t)).page.find((held) => held.observationId === alice1);
    expect(row).toMatchObject({ kind: "volumeMissing", proposal: null });
    expect((await prepare(t, alice1)) !== proposalId).toBe(true);
  });
});

describe("approval after an import placed the same records", () => {
  it("joins the Volume and the sibling Edition an import created meanwhile, never a duplicate", async () => {
    const t = makeT();
    const { alice1, aliceId, publisherId } = await held(t);
    const proposalId = await prepare(t, alice1);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    // Another source creates Volume 1 with VIZ's digital Release of it.
    const editionId = await t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1" });
      const id = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId: id, volumeId });
      await insertRelease(ctx, { editionId: id, publisherId, seriesIds: [aliceId], format: "digital", isbn13: "9781974799991" });
      return id;
    });
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, aliceId)).toEqual(["1", "4"]);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("editions").collect()).toHaveLength(1);
      const releases = await ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", editionId)).collect();
      expect(releases.map((release) => release.format).sort()).toEqual(["digital", "physical"]);
    });
    expect(await linkOf(t, alice1)).toMatchObject({ type: "release" });
  });

  it("reuses a Volume of the range created meanwhile", async () => {
    const t = makeT();
    const { vagabond4, vagabondId } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    await signedIn(t, carol).mutation(api.placement.setPlacement, {
      proposalId,
      coverage: { from: "10", to: "12" },
      line: { name: "Definitive Edition", position: "4" },
      comment: "Volumes 10 to 12.",
    });
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    await t.run((ctx) => insertVolume(ctx, { seriesId: vagabondId, position: 12, label: "12" }));
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, vagabondId)).toEqual(["10", "11", "12"]);
  });

  it("refuses when the ISBN was taken meanwhile, writing nothing, and a rejection returns the hold", async () => {
    const t = makeT();
    const { alice1, aliceId, publisherId } = await held(t);
    const proposalId = await prepare(t, alice1);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId });
      await insertRelease(ctx, { editionId, publisherId, seriesIds: [aliceId], isbn13: "9781974728374" });
    });
    await expect(approve(t, proposalId)).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(1);
    expect(await linkOf(t, alice1)).toBeNull();
    await signedIn(t, bob).mutation(api.proposals.rejectProposal, { proposalId, note: "Already placed." });
    expect((await heldList(t)).page.find((row) => row.observationId === alice1)).toMatchObject({ proposal: null });
  });

  it("refuses when the book was linked meanwhile", async () => {
    const t = makeT();
    const { alice1, aliceId, publisherId } = await held(t);
    const proposalId = await prepare(t, alice1);
    await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId });
      const releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [aliceId] });
      await ctx.db.patch(alice1, { recordRef: { type: "release", id: releaseId } });
    });
    await expect(approve(t, proposalId)).rejects.toMatchObject({
      data: { code: "invalidCreate", message: expect.stringContaining("already linked") },
    });
    expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
  });

  it("goes stale when the Series was locked or hidden meanwhile", async () => {
    for (const change of [{ locked: true }, { status: "hidden" as const }]) {
      const t = makeT();
      const { alice1, aliceId } = await held(t);
      const proposalId = await prepare(t, alice1);
      await signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId });
      await t.run((ctx) => ctx.db.patch(aliceId, change));
      expect(await approve(t, proposalId)).toMatchObject({
        status: "stale",
        stale: [{ type: "series", id: aliceId, reason: "unavailable" }],
      });
      expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
      expect(await linkOf(t, alice1)).toBeNull();
    }
  });
});
