// "Prepare placement" on a Held Book (placement.ts): the Draft it writes for
// an ordinary single book and for a book on a line, who may prepare, submit
// and approve, the books it refuses and why, one live Draft per book, that
// only placement.ts writes a placement, what approval does when an import
// created the same records while the Proposal waited, and what it refuses
// when the book or its hold changed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { splitReleaseTitle } from "./lib/ann";
import { recordUnplaced } from "./lib/observations";
import { parseDumpLine } from "./lib/openLibrary";
import { reconcileFields } from "./lib/reconcile";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import {
  alice,
  bob,
  carol,
  dave,
  makeT,
  seedRegistry,
  seedTeam,
  signedIn,
  type TestT,
  type TestUser,
} from "./test.helpers";

const DUMP_URL = "https://dumps.example.org/filtered.txt";

/** Serve these Open Library editions as the filtered dump. */
function stubDump(editions: Array<Record<string, unknown>>) {
  const body = editions.map(dumpLine).join("\n");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input) === DUMP_URL
      ? new Response(`${body}\n`)
      : new Response("not found", { status: 404 }),
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
  const observationOf = (key: string) =>
    rows.find((row) => row.sourceRecordId === key)!.observationId;
  return { ...ids, alice1: observationOf("/books/OL1M"), vagabond4: observationOf("/books/OL2M") };
}

const heldList = (t: TestT) =>
  signedIn(t, carol).query(api.imports.heldBooks, {
    paginationOpts: { numItems: 25, cursor: null },
  });

async function prepare(t: TestT, observationId: Id<"sourceObservations">, user: TestUser = carol) {
  const result = await signedIn(t, user).mutation(api.placement.preparePlacement, {
    observationId,
  });
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
    (
      await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .collect()
    )
      .filter((volume) => volume.status === "active")
      .sort((a, b) => a.position - b.position)
      .map((volume) => volume.label),
  );

const linkOf = (t: TestT, observationId: Id<"sourceObservations">) =>
  t.run(async (ctx) => (await ctx.db.get(observationId))?.recordRef);

/** The author states the Draft's coverage: Volumes `from` to `to`, outside any line unless given. */
const state = (
  t: TestT,
  proposalId: Id<"proposals">,
  from: string,
  to = from,
  line: { name: string; position: string | null } | null = null,
  user: TestUser = carol,
) =>
  signedIn(t, user).mutation(api.placement.setPlacement, {
    proposalId,
    coverage: { from, to },
    line,
    comment: `Volumes ${from} to ${to}.`,
  });

const submit = (t: TestT, proposalId: Id<"proposals">, user: TestUser = carol) =>
  signedIn(t, user).mutation(api.proposals.submitProposal, { proposalId });

/** Alice 1 prepared by Carol, stated as Volume 1 and submitted. */
async function submittedAlice() {
  const t = makeT();
  const ids = await held(t);
  const proposalId = await prepare(t, ids.alice1);
  await state(t, proposalId, "1");
  await submit(t, proposalId);
  return { t, ...ids, proposalId };
}

describe("an ordinary single book", () => {
  it.each([
    { from: "1", to: "1", created: ["1"] },
    { from: "1", to: "2", created: ["1", "2"] },
  ])(
    "starts with its coverage unstated, suggests Volume 1, and creates what the Editor states ($from to $to) once a Moderator approves",
    async ({ from, to, created }) => {
      const t = makeT();
      const { alice1, aliceId, publisherId } = await held(t);
      const proposalId = await prepare(t, alice1);

      const draft = await detail(t, proposalId);
      expect(draft).toMatchObject({
        state: "draft",
        author: { kind: "user", username: "carol", role: "editor" },
      });
      expect(draft!.placement).toMatchObject({
        book: {
          title: "Alice in Borderland, Vol. 1",
          label: "1",
          line: null,
          publisher: "Viz Media",
          isbn13: "9781974728374",
          url: "https://openlibrary.org/books/OL1M",
        },
        series: { publicId: 7, title: "Alice in Borderland" },
        suggestion: "1",
        coverage: { kind: "pending" },
        line: null,
        publisherSlug: "viz-media",
        release: { format: "physical", binding: "paperback", isbn13: "9781974728374" },
      });
      expect(
        draft!.draft!.ops.filter((op) => op.kind === "create" && op.table === "volumes"),
      ).toEqual([]);
      expect(draft!.draft!.evidence).toEqual([
        {
          kind: "observation",
          sourceKey: "openlibrary",
          url: "https://openlibrary.org/books/OL1M",
        },
      ]);
      await expect(submit(t, proposalId)).rejects.toMatchObject({
        data: { code: "invalidCreate" },
      });
      // While it is a Draft and while it waits, the book stays held, marked.
      expect(
        (await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal,
      ).toEqual({
        id: proposalId,
        state: "draft",
        mine: true,
      });

      await state(t, proposalId, from, to);
      expect((await detail(t, proposalId))!.placement!.coverage).toEqual({
        kind: "volumes",
        volumes: created.map((label) => ({ label, created: true })),
      });
      await submit(t, proposalId);
      expect(
        (await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal,
      ).toEqual({
        id: proposalId,
        state: "inReview",
        mine: true,
      });
      // An Editor cannot approve, their own Proposal included.
      await expect(
        signedIn(t, carol).mutation(api.proposals.approveProposal, { proposalId }),
      ).rejects.toMatchObject({ data: { code: "forbidden" } });

      expect((await approve(t, proposalId)).status).toBe("approved");
      expect(await volumeLabels(t, aliceId)).toEqual([...created, "4"]);
      const release = await t.run(async (ctx) =>
        ctx.db
          .query("releases")
          .withIndex("by_isbn13", (q) => q.eq("isbn13", "9781974728374"))
          .unique(),
      );
      expect(release).toMatchObject({
        status: "active",
        format: "physical",
        publisherId,
        seriesIds: [aliceId],
      });
      expect(await linkOf(t, alice1)).toEqual({ type: "release", id: release!._id });
      expect((await heldList(t)).page.map((row) => row.observationId)).not.toContain(alice1);
      const page = await t.query(api.catalog.seriesPage, { publicId: 7 });
      expect(JSON.stringify(page!.editionGroups)).toContain("9781974728374");
      expect(page!.volumes.map((volume) => volume.label)).toEqual([...created, "4"]);
    },
  );

  it("suggests one Volume only for a label at most one past the Series' last Volume or filling a gap, and never for a novel", async () => {
    const t = makeT();
    const { aliceId } = await held(t);
    const suggestion = async (title: string, isbn: string) => {
      const observationId = await t.run(async (ctx) => {
        // Stored as titled, whatever the dump parser would make of it today.
        const parsed = parseDumpLine(
          dumpLine(book(`/books/OL${isbn}M`, "Alice in Borderland, Vol. 2", isbn)),
        )!;
        const snapshot = { ...parsed, title, volumeLabel: /Vol\. (\d+)/.exec(title)![1] };
        const id = await insertObservation(ctx, {
          sourceKey: "openlibrary",
          sourceRecordId: snapshot.key,
          snapshot,
        });
        await recordUnplaced(
          ctx,
          (await ctx.db.get(id))!,
          { kind: "volumeMissing", reason: "Held.", seriesId: aliceId },
          Date.now(),
        );
        return id;
      });
      return (await detail(t, await prepare(t, observationId)))!.placement!.suggestion;
    };
    // The Series holds only Volume 4.
    expect(await suggestion("Alice in Borderland, Vol. 3", "9781974700103")).toBe("3");
    expect(await suggestion("Alice in Borderland, Vol. 5", "9781974700110")).toBe("5");
    expect(await suggestion("Alice in Borderland, Vol. 6", "9781974700127")).toBeNull();
    expect(await suggestion("Alice in Borderland, Vol. 20", "9781974700134")).toBeNull();
    expect(
      await suggestion("Alice in Borderland, Vol. 2 (light novel)", "9781974700141"),
    ).toBeNull();
  });

  it("lets a Moderator approve their own placement, as any Proposal of theirs", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1, bob);
    await state(t, proposalId, "1", "1", null, bob);
    await submit(t, proposalId, bob);
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
      const observationId = await insertObservation(ctx, {
        sourceKey: "sevenseas",
        sourceRecordId: "303",
        snapshot,
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(observationId))!,
        { kind: "volumeMissing", reason: "Held.", seriesId },
        Date.now(),
      );
      return { seriesId, observationId };
    });
    const proposalId = await prepare(t, observationId);
    await state(t, proposalId, "3");
    await submit(t, proposalId);
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
      book: { label: null, line: { name: "Definitive Edition", position: "4" } },
      suggestion: null,
      coverage: { kind: "pending" },
      line: { name: "Definitive Edition", position: "4", created: true },
    });
    expect(draft.draft!.ops.filter((op) => op.kind === "create" && op.table === "volumes")).toEqual(
      [],
    );
    await expect(
      signedIn(t, carol).mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toMatchObject({
      data: {
        code: "invalidCreate",
        message: expect.stringContaining("state the Volumes it covers"),
      },
    });

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
      const labels = await Promise.all(
        coverage.map(async (row) => (await ctx.db.get(row.volumeId))?.label),
      );
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
    expect(editions).toEqual([
      expect.objectContaining({ coverageUnmapped: true, linePosition: "4" }),
    ]);
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

describe("a book read with today's parser", () => {
  it("reads a legacy Open Library snapshot with no packaging as the line book its title names", async () => {
    const t = makeT();
    const { vagabond4 } = await held(t);
    // /books/OL57786217M as the export stores it: parsed before the parser knew the line.
    await t.run(async (ctx) => {
      const observation = (await ctx.db.get(vagabond4))!;
      if (observation.snapshot?.kind !== "olEdition")
        throw new Error("not an Open Library edition");
      await ctx.db.patch(vagabond4, {
        snapshot: {
          ...observation.snapshot,
          seriesTitle: "Vagabond Definitive Edition",
          volumeLabel: "4",
          multiVolume: false,
          packaging: undefined,
        },
      });
    });
    const placement = (await detail(t, await prepare(t, vagabond4)))!.placement;
    expect(placement).toMatchObject({
      book: { label: null, line: { name: "Definitive Edition", position: "4" } },
      suggestion: null,
      coverage: { kind: "pending" },
      line: { name: "Definitive Edition", position: "4", created: true },
    });
  });

  it("reads a legacy ANN line stored without its line flag as a line book", async () => {
    const t = makeT();
    const { vagabondId } = await held(t);
    const observationId = await t.run(async (ctx) => {
      const id = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "6004",
        snapshot: {
          kind: "annRelease",
          annId: "6004",
          mangaId: "88",
          url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=6004",
          title: "Vagabond Definitive Edition",
          label: "4",
          multi: false,
          format: "physical",
          editionLineHint: false,
          isbn13: "9781974700417",
          page: { status: "ok", fetchedAt: 1, distributor: "VIZ Media", isbn13: "9781974700417" },
        },
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind: "volumeMissing", reason: "Held.", seriesId: vagabondId },
        Date.now(),
      );
      return id;
    });
    expect((await detail(t, await prepare(t, observationId)))!.placement).toMatchObject({
      book: { label: null, line: { name: "Definitive Edition", position: "4" } },
      suggestion: null,
      coverage: { kind: "pending" },
    });
  });

  // The entry's own name accounts for its line word: the book is a VIZBIG
  // book, never a "Deluxe" one, on the Draft an Editor prepares.
  it("names an ANN book's line from the title's own line, past a line word in the entry's name", async () => {
    const t = makeT();
    const { vagabondId } = await held(t);
    const observationId = await t.run(async (ctx) => {
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:89",
        snapshot: { title: "Makunouchi Deluxe" },
      });
      const id = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:6005",
        snapshot: {
          kind: "annRelease",
          annId: "6005",
          mangaId: "89",
          url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=6005",
          title: "Makunouchi Deluxe [VIZBIG Edition]",
          label: "2",
          multi: false,
          format: "physical",
          editionLineHint: true,
          isbn13: "9781974700424",
          page: { status: "ok", fetchedAt: 1, distributor: "VIZ Media", isbn13: "9781974700424" },
        },
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind: "packaging", reason: "Held.", seriesId: vagabondId },
        Date.now(),
      );
      return id;
    });
    expect((await detail(t, await prepare(t, observationId)))!.placement).toMatchObject({
      book: { label: null, line: { name: "VIZBIG Edition", position: "2" } },
      suggestion: null,
    });
  });
});

// The Draft's line comes from the title read against the Series the book
// is held under, which the hold already vouches for, and the entry's
// title where there is one: missing, renamed or relinked, the entry never
// makes "Makunouchi Deluxe [VIZBIG Edition]" a Deluxe book. A title still
// unclear leaves the line for the member to choose.
describe("an ANN book's line, read against its held Series", () => {
  type Entry = { title: string; linkedTo?: string } | null;

  /**
   * One ANN line held as packaging under Series `series`, with its manga
   * entry `entry`. With `designator` the snapshot is the mirror's own
   * reading of "title (designator)", or (`stale`) that reading without its
   * title's stored coverage; without it, a GN 2 line flagged packaging.
   */
  async function heldAnn(
    series: string,
    title: string,
    entry: Entry,
    release?: { designator: string; stale?: boolean },
  ) {
    const split = release ? splitReleaseTitle(`${title} (${release.designator})`, series) : null;
    if (release && split === null) throw new Error(`No designator in ${title}`);
    const { coverRange: _range, coverageGapped: _gapped, ...facts } = split ?? {};
    const read = split === null ? { label: "2", multi: false } : release?.stale ? facts : split;
    const t = makeT();
    await seedRegistry(t);
    await seedTeam(t, [alice, bob, carol, dave]);
    const observationId = await t.run(async (ctx) => {
      await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const seriesId = await insertSeries(ctx, { title: series });
      if (entry !== null) {
        const other =
          entry.linkedTo !== undefined
            ? await insertSeries(ctx, { title: entry.linkedTo })
            : undefined;
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "manga:88",
          ...(other !== undefined ? { recordRef: { type: "series" as const, id: other } } : {}),
          snapshot: { title: entry.title },
        });
      }
      const id = await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:5000",
        snapshot: {
          kind: "annRelease",
          annId: "5000",
          mangaId: "88",
          url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5000",
          title,
          format: "physical",
          ...read,
          editionLineHint: true,
          isbn13: "9781421599991",
          page: { status: "ok", fetchedAt: 1, distributor: "VIZ Media", isbn13: "9781421599991" },
        },
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { kind: "packaging", reason: "Packaging needs review.", seriesId },
        Date.now(),
      );
      return id;
    });
    const proposalId = await prepare(t, observationId);
    const proposal = await t.run((ctx) => ctx.db.get(proposalId));
    const created = (proposal?.draft?.ops ?? []).flatMap((op) =>
      op.kind === "create" && op.table === "editionLines" ? [op.fields?.name] : [],
    );
    return { created, view: (await detail(t, proposalId))!.placement };
  }

  it.each<{ why: string; entry: Entry }>([
    { why: "entry present", entry: { title: "Makunouchi Deluxe" } },
    { why: "entry absent", entry: null },
    { why: "entry renamed", entry: { title: "A different entry title" } },
    { why: "entry relinked", entry: { title: "Makunouchi", linkedTo: "Makunouchi" } },
    { why: "entry contradicting", entry: { title: "Makunouchi VIZBIG Edition" } },
  ])("prefills VIZBIG position 2 under Makunouchi Deluxe: $why", async ({ entry }) => {
    const { created, view } = await heldAnn(
      "Makunouchi Deluxe",
      "Makunouchi Deluxe [VIZBIG Edition]",
      entry,
    );
    expect(created).toEqual(["VIZBIG Edition"]);
    expect(view).toMatchObject({
      book: { label: null, line: { name: "VIZBIG Edition", position: "2" } },
      line: { name: "VIZBIG Edition", position: "2", created: true },
      coverage: { kind: "pending" },
      suggestion: null,
    });
  });

  // The Editor sees what the page pass reads: every statement read whole,
  // a number beside the line's name the book's, never the line's name.
  describe.each([false, true])("source facts (stale snapshot: %s)", (stale) => {
    const alpha = (title: string, designator: string) =>
      heldAnn("Alpha", title, { title: "Alpha" }, { designator, stale });

    it("shows no range for a subtitle whose second range leaves a gap", async () => {
      const { view } = await alpha("Alpha VIZBIG Edition 1: Includes Vols. 1-3 plus 7-9", "GN 1");
      expect(view?.book).toMatchObject({
        statedRange: null,
        line: { name: "VIZBIG Edition", position: "1" },
      });
    });

    it("shows the whole range a subtitle states", async () => {
      for (const title of [
        "Alpha VIZBIG Edition 1: Includes Vols. 1-3 plus 4-6",
        "Alpha [VIZBIG Edition] 1: Includes Vols. 1-3 plus 4-6",
      ]) {
        const { view } = await alpha(title, "GN 1");
        expect(view?.book?.statedRange, title).toEqual({ from: "1", to: "6" });
      }
    });

    it.each(["Alpha VIZBIG Edition 1-3-5", "Alpha [VIZBIG Edition Vols. 6-4]"])(
      "shows no range for %s",
      async (title) => {
        const { view } = await alpha(title, "GN 1");
        expect(view?.book?.statedRange).toBeNull();
      },
    );

    it.each([
      "Alpha [VIZBIG Edition] (Vol. II)",
      "Alpha [VIZBIG Edition Vol. 2]",
      "Alpha [VIZBIG Edition 2]",
    ])("prefills VIZBIG Edition and no position for %s at GN 1, and 2 at GN 2", async (title) => {
      const conflict = await alpha(title, "GN 1");
      expect(conflict.created).toEqual(["VIZBIG Edition"]);
      expect(conflict.view).toMatchObject({
        book: { line: { name: "VIZBIG Edition", position: null } },
        line: { name: "VIZBIG Edition", position: null, created: true },
      });
      const agreeing = await alpha(title, "GN 2");
      expect(agreeing.created).toEqual(["VIZBIG Edition"]);
      expect(agreeing.view).toMatchObject({
        book: { line: { name: "VIZBIG Edition", position: "2" } },
        line: { name: "VIZBIG Edition", position: "2", created: true },
      });
    });

    it("prefills no position the title states in a way it cannot read", async () => {
      const { view } = await alpha("Alpha [VIZBIG Edition] (Vol. ii)", "GN 2");
      expect(view?.book?.line).toEqual({ name: "VIZBIG Edition", position: null });
    });
  });

  it.each([
    // Two lines the title adds: neither is guessed.
    { series: "Alpha", title: "Alpha [VIZBIG Edition] [Omnibus]" },
    { series: "Makunouchi", title: "Makunouchi Deluxe [VIZBIG Edition]" },
  ])("leaves the line of $title under $series unselected", async ({ series, title }) => {
    const { created, view } = await heldAnn(series, title, null);
    expect(created).toEqual([]);
    expect(view).toMatchObject({
      book: { label: null, line: null },
      line: null,
      coverage: { kind: "pending" },
      suggestion: null,
    });
  });
});

describe("books it does not prepare", () => {
  /** Hold an observation of `snapshot` as `kind` under `seriesId`, as an importer would. */
  async function holdBook(
    t: TestT,
    sourceKey: string,
    snapshot: Record<string, unknown>,
    hold: {
      kind: "volumeMissing" | "packaging" | "series" | "isbn" | "other";
      seriesId?: Id<"series">;
    },
  ) {
    return await t.run(async (ctx) => {
      const id = await insertObservation(ctx, {
        sourceKey,
        sourceRecordId: String(snapshot.key ?? snapshot.annId),
        snapshot,
      });
      await recordUnplaced(
        ctx,
        (await ctx.db.get(id))!,
        { ...hold, reason: "Held for the test." },
        Date.now(),
      );
      return id;
    });
  }
  const olSnapshot = (edition: Record<string, unknown>) => parseDumpLine(dumpLine(edition))!;

  async function reasonFor(t: TestT, observationId: Id<"sourceObservations">) {
    const result = await signedIn(t, carol).mutation(api.placement.preparePlacement, {
      observationId,
    });
    expect(result.status).toBe("unavailable");
    return result.status === "unavailable" ? result.reason : null;
  }

  it("says why, and leaves each book held with no Proposal", async () => {
    const t = makeT();
    const { aliceId, alice1 } = await held(t);
    const locked = await t.run((ctx) =>
      insertSeries(ctx, { publicId: 9, title: "Locked Saga", locked: true }),
    );
    const hidden = await t.run((ctx) =>
      insertSeries(ctx, { publicId: 10, title: "Hidden Saga", status: "hidden" }),
    );

    const noSeries = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL10M", "Nobody, Vol. 1", "9781974700011")),
      {
        kind: "series",
      },
    );
    const lockedBook = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL11M", "Locked Saga, Vol. 1", "9781974700028")),
      {
        kind: "volumeMissing",
        seriesId: locked,
      },
    );
    const hiddenBook = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL12M", "Hidden Saga, Vol. 1", "9781974700035")),
      {
        kind: "volumeMissing",
        seriesId: hidden,
      },
    );
    const unknownPublisher = await holdBook(
      t,
      "openlibrary",
      olSnapshot(
        book("/books/OL13M", "Alice in Borderland, Vol. 2", "9781974700042", ["Unheard Of Press"]),
      ),
      { kind: "volumeMissing", seriesId: aliceId },
    );
    const rebinder = await holdBook(
      t,
      "openlibrary",
      olSnapshot(
        book("/books/OL14M", "Alice in Borderland, Vol. 3", "9781974700059", [
          "Turtleback",
          "Viz Media",
        ]),
      ),
      { kind: "volumeMissing", seriesId: aliceId },
    );
    // An ISBN or slot taken, or a missing publisher row, under a Series that would do.
    const slotTaken = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL15M", "Alice in Borderland, Vol. 6", "9781974700073")),
      {
        kind: "isbn",
        seriesId: aliceId,
      },
    );
    const noPublisherRow = await holdBook(
      t,
      "openlibrary",
      olSnapshot(book("/books/OL16M", "Alice in Borderland, Vol. 7", "9781974700080")),
      {
        kind: "other",
        seriesId: aliceId,
      },
    );
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

    expect(await reasonFor(t, noSeries)).toMatch(
      /^No single active, unlocked Series fits this book/,
    );
    expect(await reasonFor(t, slotTaken)).toMatch(
      /^Its ISBN, or its Volume's slot for this publisher and format, is already taken/,
    );
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
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [aliceId],
        isbn13: "9781974728374",
      });
    });
    expect(await reasonFor(t, alice1)).toBe(
      "ISBN 9781974728374 is already on an active Release: link or correct that Release instead.",
    );

    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toHaveLength(10);
  });
});

describe("one live Draft per book", () => {
  it("opens the author's Draft on a repeat and a replay, and anyone's once it is in review", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1);
    const click = (user: TestUser) =>
      signedIn(t, user).mutation(api.placement.preparePlacement, { observationId: alice1 });
    expect(await click(carol)).toEqual({ status: "existing", proposalId });
    await state(t, proposalId, "1");
    await submit(t, proposalId);
    expect(await click(bob)).toEqual({ status: "existing", proposalId });
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(1);
  });

  it("withdraws another member's unsubmitted Draft, with a note, and points the book at the new one", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const first = await prepare(t, alice1);
    await state(t, first, "1");
    expect(
      (await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal,
    ).toMatchObject({ mine: true });
    expect(
      (
        await signedIn(t, bob).query(api.imports.heldBooks, {
          paginationOpts: { numItems: 25, cursor: null },
        })
      ).page.find((row) => row.observationId === alice1)?.proposal,
    ).toMatchObject({ id: first, mine: false });

    const second = await prepare(t, alice1, bob);
    expect(second).not.toBe(first);
    expect(await t.run(async (ctx) => (await ctx.db.get(alice1))?.queuedProposalId)).toBe(second);
    expect(await t.run((ctx) => ctx.db.get(first))).toMatchObject({ state: "withdrawn" });
    expect((await detail(t, first))!.notes).toEqual([
      expect.objectContaining({
        kind: "comment",
        text: expect.stringContaining("@bob prepared this book's placement again"),
      }),
    ]);
    // The withdrawn Draft is no one's to state or submit; the new one is Bob's.
    await expect(state(t, first, "1")).rejects.toMatchObject({ data: { code: "badState" } });
    await expect(submit(t, first)).rejects.toMatchObject({ data: { code: "badState" } });
    await state(t, second, "1", "1", null, bob);
    await submit(t, second, bob);
    expect((await approve(t, second)).status).toBe("approved");
  });

  it.each([
    ["no book", "its author", carol],
    ["no book", "another member", bob],
    ["another book", "its author", carol],
    ["another book", "another member", bob],
  ] as const)(
    "leaves a Draft the book points at whose ops place %s as it is, and prepares a new one for %s that the book points at",
    async (other, _who, user) => {
      const t = makeT();
      const { alice1, vagabond4, aliceId } = await held(t);
      const first = await prepare(t, alice1);
      // However its ops came to place nothing, or another book.
      await t.run(async (ctx) => {
        const draft = (await ctx.db.get(first))!.draft!;
        const ops =
          other === "no book"
            ? [
                {
                  kind: "create" as const,
                  table: "volumes",
                  tempId: "v",
                  fields: { seriesId: aliceId, label: "7" },
                },
              ]
            : draft.ops.map((op) =>
                op.kind === "create" && op.table === "releases"
                  ? {
                      ...op,
                      fields: {
                        ...op.fields,
                        placement: { observationId: vagabond4, seriesId: aliceId },
                      },
                    }
                  : op,
              );
        await ctx.db.patch(first, { draft: { ...draft, ops } });
      });
      const before = await t.run((ctx) => ctx.db.get(first));

      const result = await signedIn(t, user).mutation(api.placement.preparePlacement, {
        observationId: alice1,
      });
      expect(result).toMatchObject({ status: "prepared" });
      const second = result.status === "prepared" ? result.proposalId : null;
      expect(second).not.toBe(first);
      expect(await t.run((ctx) => ctx.db.get(first))).toEqual(before);
      expect((await detail(t, first))!.notes).toEqual([]);
      expect(await t.run(async (ctx) => (await ctx.db.get(alice1))?.queuedProposalId)).toBe(second);
    },
  );

  it("prepares a new Draft over the author's own withdrawn one, never reopening or withdrawing it again", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const first = await prepare(t, alice1);
    await signedIn(t, carol).mutation(api.proposals.withdrawProposal, { proposalId: first });
    const before = await t.run((ctx) => ctx.db.get(first));
    const result = await signedIn(t, carol).mutation(api.placement.preparePlacement, {
      observationId: alice1,
    });
    expect(result).toMatchObject({ status: "prepared" });
    expect(await t.run((ctx) => ctx.db.get(first))).toEqual(before);
    expect((await detail(t, first))!.notes).toEqual([]);
  });

  it("keeps two copies in review safe: only the one the book points at is approved, and the other then refuses", async () => {
    const t = makeT();
    const { alice1, aliceId } = await held(t);
    const first = await prepare(t, alice1);
    await state(t, first, "1");
    await submit(t, first);
    // However the book came to point elsewhere, a second copy reaches review.
    await t.run((ctx) => ctx.db.patch(alice1, { queuedProposalId: undefined }));
    const second = await prepare(t, alice1, bob);
    await state(t, second, "1", "1", null, bob);
    await submit(t, second, bob);

    await expect(approve(t, first)).rejects.toMatchObject({
      data: { code: "invalidCreate", message: expect.stringContaining("another Proposal's") },
    });
    expect((await approve(t, second)).status).toBe("approved");
    await expect(approve(t, first)).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    expect(await volumeLabels(t, aliceId)).toEqual(["1", "4"]);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(1);
  });

  it("returns a rejected book to the held list, ready to prepare again", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1);
    await state(t, proposalId, "1");
    await submit(t, proposalId);
    // Open Library lists it again while it waits: still held, still marked.
    await t.action(internal.openLibrary.sync, {});
    expect(
      (await heldList(t)).page.find((row) => row.observationId === alice1)?.proposal?.state,
    ).toBe("inReview");
    await signedIn(t, bob).mutation(api.proposals.rejectProposal, {
      proposalId,
      note: "Wrong book.",
    });
    const row = (await heldList(t)).page.find((held) => held.observationId === alice1);
    expect(row).toMatchObject({ kind: "volumeMissing", proposal: null });
    expect((await prepare(t, alice1)) !== proposalId).toBe(true);
  });
});

describe("only placement.ts writes a placement", () => {
  it("refuses a hand-written placement in saveDraft, on any book, Series or ISBN", async () => {
    const t = makeT();
    const { alice1, aliceId, vagabondId, publisherId } = await held(t);
    const editionId = await t.run((ctx) => insertEdition(ctx, { publisherId }));
    const release = (tempId: string, seriesId: Id<"series">, isbn13: string) => ({
      kind: "create" as const,
      table: "releases",
      tempId,
      fields: {
        editionId,
        format: "physical",
        language: "en",
        isbn13,
        placement: { observationId: alice1, seriesId },
      },
    });
    for (const ops of [
      [release("forged", vagabondId, "9781974758746")],
      [release("a", aliceId, "9781974728374"), release("b", aliceId, "9781974799991")],
    ]) {
      await expect(
        signedIn(t, carol).mutation(api.proposals.saveDraft, {
          ops,
          evidence: [{ kind: "observation", observationId: alice1 }],
          comment: "A release.",
        }),
      ).rejects.toMatchObject({
        data: { code: "invalidCreate", message: expect.stringContaining("Prepare placement") },
      });
    }
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });

  it("refuses saveDraft over a placement Draft, so its author restates it only through setPlacement", async () => {
    const t = makeT();
    const { alice1, vagabondId } = await held(t);
    const proposalId = await prepare(t, alice1);
    const before = (await t.run((ctx) => ctx.db.get(proposalId)))!.draft;
    await expect(
      signedIn(t, carol).mutation(api.proposals.saveDraft, {
        proposalId,
        ops: [
          {
            kind: "create",
            table: "volumes",
            tempId: "v",
            fields: { seriesId: vagabondId, label: "99" },
          },
        ],
        evidence: [{ kind: "observation", observationId: alice1 }],
        comment: "Rewritten.",
      }),
    ).rejects.toMatchObject({ data: { code: "placementDraft" } });
    expect((await t.run((ctx) => ctx.db.get(proposalId)))!.draft).toEqual(before);
  });

  it("shows the Series the ops create under, not the one their placement names", async () => {
    const t = makeT();
    const { alice1, vagabondId } = await held(t);
    const proposalId = await prepare(t, alice1);
    await state(t, proposalId, "1");
    await t.run(async (ctx) => {
      const draft = (await ctx.db.get(proposalId))!.draft!;
      const ops = draft.ops.map((op) =>
        op.kind === "create" && op.table === "releases"
          ? {
              ...op,
              fields: { ...op.fields, placement: { observationId: alice1, seriesId: vagabondId } },
            }
          : op,
      );
      await ctx.db.patch(proposalId, { draft: { ...draft, ops } });
    });
    expect((await detail(t, proposalId))!.placement!.series).toEqual({
      publicId: 7,
      title: "Alice in Borderland",
    });
    await expect(submit(t, proposalId)).rejects.toMatchObject({ data: { code: "invalidCreate" } });
  });

  it("refuses a hand-written op marked to join an existing record in saveDraft", async () => {
    const t = makeT();
    const { alice1, aliceId } = await held(t);
    await t.run((ctx) =>
      insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1", status: "hidden" }),
    );
    await expect(
      signedIn(t, carol).mutation(api.proposals.saveDraft, {
        ops: [
          {
            kind: "create",
            table: "volumes",
            tempId: "v",
            fields: { seriesId: aliceId, label: "1", joinExisting: true },
          },
        ],
        evidence: [{ kind: "observation", observationId: alice1 }],
        comment: "Volume 1.",
      }),
    ).rejects.toMatchObject({
      data: {
        code: "invalidCreate",
        message: expect.stringContaining("reference the record by ID"),
      },
    });
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });

  it.each(["draft", "inReview", "rebased"] as const)(
    "refuses a placed Release naming a stored Edition (%s) at submission and approval, writing nothing",
    async (stage) => {
      const t = makeT();
      const { alice1, aliceId, vagabondId, publisherId } = await held(t);
      const proposalId = await prepare(t, alice1);
      await state(t, proposalId, "1");
      // Only the Release op, under a stored Edition of Vagabond's.
      const editionId = await t.run(async (ctx) => {
        const volumeId = await insertVolume(ctx, {
          seriesId: vagabondId,
          position: 12,
          label: "12",
        });
        const id = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId: id, volumeId });
        return id;
      });
      const forge = (ops: Doc<"proposalVersions">["ops"]) =>
        ops.flatMap((op) =>
          op.kind === "create" && op.table === "releases"
            ? [{ ...op, fields: { ...op.fields, editionId } }]
            : [],
        );
      if (stage === "draft") {
        await t.run(async (ctx) => {
          const draft = (await ctx.db.get(proposalId))!.draft!;
          await ctx.db.patch(proposalId, { draft: { ...draft, ops: forge(draft.ops) } });
        });
      } else {
        await submit(t, proposalId);
        await t.run(async (ctx) => {
          const version = (await ctx.db
            .query("proposalVersions")
            .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
            .unique())!;
          await ctx.db.patch(version._id, { ops: forge(version.ops) });
        });
        if (stage === "rebased")
          await signedIn(t, carol).mutation(api.proposals.rebaseProposal, { proposalId });
      }
      const refused = {
        data: { code: "invalidCreate", message: expect.stringContaining("names a stored Edition") },
      };
      if (stage === "inReview") await expect(approve(t, proposalId)).rejects.toMatchObject(refused);
      else await expect(submit(t, proposalId)).rejects.toMatchObject(refused);
      expect(await t.run((ctx) => ctx.db.query("releases").collect())).toEqual([]);
      expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
      expect(await linkOf(t, alice1)).toBeNull();
    },
  );

  it.each([
    [
      "a Volume under another Series",
      'Every record a placement creates is under "Alice in Borderland"',
    ],
    ["a second placed Release", "A Proposal places one held book, through one Release."],
  ])(
    "refuses at approval, writing nothing, a version whose ops carry %s",
    async (change, reason) => {
      const { t, alice1, aliceId, vagabondId, proposalId } = await submittedAlice();
      await t.run(async (ctx) => {
        const version = (await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
          .unique())!;
        const ops = version.ops.flatMap((op): Doc<"proposalVersions">["ops"] => {
          if (op.kind !== "create") return [op];
          if (change === "a Volume under another Series" && op.table === "volumes") {
            return [{ ...op, fields: { ...op.fields, seriesId: vagabondId } }];
          }
          if (change === "a second placed Release" && op.table === "releases") {
            return [
              op,
              { ...op, tempId: "release-2", fields: { ...op.fields, isbn13: "9781974799991" } },
            ];
          }
          return [op];
        });
        await ctx.db.patch(version._id, { ops });
      });
      await expect(approve(t, proposalId)).rejects.toMatchObject({
        data: { code: "invalidCreate", message: expect.stringContaining(reason) },
      });
      expect(await t.run((ctx) => ctx.db.query("releases").collect())).toEqual([]);
      expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
      expect(await volumeLabels(t, vagabondId)).toEqual(["10", "11"]);
      expect(await linkOf(t, alice1)).toBeNull();
    },
  );

  it("refuses a range that would carry more ops than a Proposal may", async () => {
    const t = makeT();
    const { alice1 } = await held(t);
    const proposalId = await prepare(t, alice1);
    await expect(state(t, proposalId, "1", "50")).rejects.toMatchObject({
      data: { code: "bulkCap" },
    });
    expect((await detail(t, proposalId))!.placement!.coverage).toEqual({ kind: "pending" });
  });
});

describe("approval after an import placed the same records", () => {
  it("joins the Volume and the sibling Edition an import created meanwhile, never a duplicate", async () => {
    const { t, alice1, aliceId, publisherId, proposalId } = await submittedAlice();
    // Another source creates Volume 1 with VIZ's digital Release of it.
    const editionId = await t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1" });
      const id = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId: id, volumeId });
      await insertRelease(ctx, {
        editionId: id,
        publisherId,
        seriesIds: [aliceId],
        format: "digital",
        isbn13: "9781974799991",
      });
      return id;
    });
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, aliceId)).toEqual(["1", "4"]);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("editions").collect()).toHaveLength(1);
      const releases = await ctx.db
        .query("releases")
        .withIndex("by_edition", (q) => q.eq("editionId", editionId))
        .collect();
      expect(releases.map((release) => release.format).sort()).toEqual(["digital", "physical"]);
    });
    expect(await linkOf(t, alice1)).toMatchObject({ type: "release" });
  });

  it("reuses a Volume of the range created meanwhile", async () => {
    const t = makeT();
    const { vagabond4, vagabondId } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    await state(t, proposalId, "10", "12", { name: "Definitive Edition", position: "4" });
    await submit(t, proposalId);
    await t.run((ctx) => insertVolume(ctx, { seriesId: vagabondId, position: 12, label: "12" }));
    expect((await approve(t, proposalId)).status).toBe("approved");
    expect(await volumeLabels(t, vagabondId)).toEqual(["10", "11", "12"]);
  });

  it("refuses when the ISBN was taken meanwhile, writing nothing, and a rejection returns the hold", async () => {
    const { t, alice1, aliceId, publisherId, proposalId } = await submittedAlice();
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId });
      await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [aliceId],
        isbn13: "9781974728374",
      });
    });
    await expect(approve(t, proposalId)).rejects.toMatchObject({ data: { code: "invalidCreate" } });
    expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
    expect(await t.run((ctx) => ctx.db.query("releases").collect())).toHaveLength(1);
    expect(await linkOf(t, alice1)).toBeNull();
    await signedIn(t, bob).mutation(api.proposals.rejectProposal, {
      proposalId,
      note: "Already placed.",
    });
    expect((await heldList(t)).page.find((row) => row.observationId === alice1)).toMatchObject({
      proposal: null,
    });
  });

  it("goes stale when the Series was locked or hidden meanwhile", async () => {
    for (const change of [{ locked: true }, { status: "hidden" as const }]) {
      const { t, alice1, aliceId, proposalId } = await submittedAlice();
      await t.run((ctx) => ctx.db.patch(aliceId, change));
      expect(await approve(t, proposalId)).toMatchObject({
        status: "stale",
        stale: [{ type: "series", id: aliceId, reason: "unavailable" }],
      });
      expect(await volumeLabels(t, aliceId)).toEqual(["4"]);
      expect(await linkOf(t, alice1)).toBeNull();
    }
  });

  it("goes stale, creating nothing, when the matching Edition is locked or hidden, Volume 1 is hidden or merged away, or the line is hidden", async () => {
    const cases = ["lockedEdition", "hiddenEdition", "hiddenVolume", "mergedVolume"] as const;
    for (const change of cases) {
      const { t, aliceId, publisherId, proposalId } = await submittedAlice();
      const unavailable = await t.run(async (ctx) => {
        if (change === "hiddenVolume")
          return await insertVolume(ctx, {
            seriesId: aliceId,
            position: 1,
            label: "1",
            status: "hidden",
          });
        if (change === "mergedVolume") {
          const survivor = await insertVolume(ctx, { seriesId: aliceId, position: 2, label: "2" });
          return await insertVolume(ctx, {
            seriesId: aliceId,
            position: 1,
            label: "1",
            status: "merged",
            mergedIntoId: survivor,
          });
        }
        const volumeId = await insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1" });
        const editionId = await insertEdition(ctx, {
          publisherId,
          ...(change === "lockedEdition" ? { locked: true } : { status: "hidden" as const }),
        });
        await insertCoverage(ctx, { editionId, volumeId });
        return editionId;
      });
      const counts = () =>
        t.run(async (ctx) => [
          (await ctx.db.query("volumes").collect()).length,
          (await ctx.db.query("editions").collect()).length,
        ]);
      const before = await counts();
      expect(await approve(t, proposalId)).toMatchObject({
        status: "stale",
        stale: [{ id: unavailable, reason: "unavailable" }],
      });
      expect(await counts()).toEqual(before);
    }

    const t = makeT();
    const { vagabond4, vagabondId, publisherId } = await held(t);
    const proposalId = await prepare(t, vagabond4);
    await state(t, proposalId, "10", "11", { name: "Definitive Edition", position: "4" });
    await submit(t, proposalId);
    const lineId = await t.run((ctx) =>
      ctx.db.insert("editionLines", {
        status: "hidden",
        seriesId: vagabondId,
        publisherId,
        name: "Definitive Edition",
      }),
    );
    expect(await approve(t, proposalId)).toMatchObject({
      status: "stale",
      stale: [{ type: "editionLine", id: lineId }],
    });
    expect(await t.run((ctx) => ctx.db.query("editionLines").collect())).toHaveLength(1);
  });
});

describe("approval after the book or its hold changed", () => {
  it.each([
    ["withdrawn by its source", "Its source no longer lists it."],
    ["held as a Series question now", "No single active, unlocked Series fits this book"],
    ["held under another Series now", 'held under "Vagabond" now'],
    ["given another ISBN by its source", "The Release's ISBN or format is not the book's"],
    ["given an ISBN-10 by its source", "The Release's ISBN or format is not the book's"],
    ["given another format by its source", "The Release's ISBN or format is not the book's"],
    ["linked meanwhile", "already linked"],
    [
      "its Edition's physical slot taken meanwhile",
      "slot for this publisher and format, is already taken",
    ],
  ])("refuses, writing nothing, when the book was %s", async (change, reason) => {
    const { t, alice1, aliceId, vagabondId, publisherId, proposalId } = await submittedAlice();
    await t.run(async (ctx) => {
      const observation = (await ctx.db.get(alice1))!;
      const rehold = (kind: "series" | "volumeMissing", seriesId: Id<"series">) =>
        recordUnplaced(ctx, observation, { kind, reason: "Held again.", seriesId }, Date.now());
      if (change === "withdrawn by its source") await ctx.db.patch(alice1, { withdrawn: true });
      if (change === "held as a Series question now") await rehold("series", aliceId);
      if (change === "held under another Series now") await rehold("volumeMissing", vagabondId);
      if (
        change === "given another ISBN by its source" &&
        observation.snapshot?.kind === "olEdition"
      ) {
        await ctx.db.patch(alice1, {
          snapshot: { ...observation.snapshot, isbn13: "9781974758746" },
        });
      }
      if (
        change === "given an ISBN-10 by its source" &&
        observation.snapshot?.kind === "olEdition"
      ) {
        await ctx.db.patch(alice1, { snapshot: { ...observation.snapshot, isbn10: "1974728374" } });
      }
      if (
        change === "given another format by its source" &&
        observation.snapshot?.kind === "olEdition"
      ) {
        await ctx.db.patch(alice1, {
          snapshot: { ...observation.snapshot, format: "digital", binding: undefined },
        });
      }
      if (change === "linked meanwhile") {
        const editionId = await insertEdition(ctx, { publisherId });
        const releaseId = await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [aliceId],
        });
        await ctx.db.patch(alice1, { recordRef: { type: "release", id: releaseId } });
      }
      if (change === "its Edition's physical slot taken meanwhile") {
        const volumeId = await insertVolume(ctx, { seriesId: aliceId, position: 1, label: "1" });
        const editionId = await insertEdition(ctx, { publisherId });
        await insertCoverage(ctx, { editionId, volumeId });
        await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [aliceId],
          isbn13: "9781974799991",
        });
      }
    });
    const releasesBefore = await t.run(
      async (ctx) => (await ctx.db.query("releases").collect()).length,
    );
    await expect(approve(t, proposalId)).rejects.toMatchObject({
      data: { code: "invalidCreate", message: expect.stringContaining(reason) },
    });
    expect(await t.run(async (ctx) => (await ctx.db.query("releases").collect()).length)).toBe(
      releasesBefore,
    );
    expect((await t.run((ctx) => ctx.db.get(proposalId)))?.state).toBe("inReview");
  });

  it("leaves a member's placement in review when its source links the book and queues a field conflict", async () => {
    const { t, alice1, aliceId, publisherId, proposalId } = await submittedAlice();
    await t.run(async (ctx) => {
      const editionId = await insertEdition(ctx, { publisherId });
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [aliceId],
        binding: "hardcover",
        overriddenFields: ["binding"],
      });
      await ctx.db.patch(alice1, { recordRef: { type: "release", id: releaseId } });
      const result = await reconcileFields(ctx, {
        sourceKey: "openlibrary",
        ref: { type: "release", id: releaseId },
        doc: (await ctx.db.get(releaseId))!,
        offered: { binding: "paperback" },
        observation: (await ctx.db.get(alice1))!,
        citation: { sourceName: "Open Library", url: "https://openlibrary.org/books/OL1M" },
        now: Date.now(),
      });
      expect(result.queued).toEqual(["binding"]);
    });
    expect((await t.run((ctx) => ctx.db.get(proposalId)))?.state).toBe("inReview");
  });
});
