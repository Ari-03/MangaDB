// ANN packaging's boundary through the real mutations (PR #66, review
// rounds 3 and 4): the mirror reads every line under its Series' own title before it
// builds the backbone or takes a Release slot; the page pass reads the
// line's current release page beside it before it creates anything; a
// marker's unread number is never a position; a packaged book reads its
// Edition Line, the line's members and the Release slot as they stand, in
// the same mutation; and the Editor's Draft and approval read the same
// facts. Every refusal asserts that no canonical row changed and where the
// book is held, beside a positive counterpart that creates or links.

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { parseApiResponse, parseReleasePage, splitReleaseTitle, toSnapshot } from "./lib/ann";
import { recordUnplaced } from "./lib/observations";
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
import {
  alice,
  bob,
  carol,
  makeT,
  seedRegistry,
  seedTeam,
  signedIn,
  type TestT,
} from "./test.helpers";

/** The held book's ISBN, on no Release. */
const ISBN = "9781421599991";
/** Another printing's ISBN, already on a Release. */
const OTHER_ISBN = "9781974700400";

/** Every canonical row, and the holds, as comparable values. */
async function graph(t: TestT) {
  return await t.run(async (ctx) => {
    const volumes = await ctx.db.query("volumes").collect();
    const label = new Map(volumes.map((vol) => [vol._id, vol.label]));
    return {
      volumes: volumes.map((vol) => `${vol.label}:${vol.status}`),
      lines: (await ctx.db.query("editionLines").collect()).map(
        (line) => `${line._id}:${line.name}:${line.status}${line.locked ? ":locked" : ""}`,
      ),
      editions: (await ctx.db.query("editions").collect()).map(
        (edition) =>
          `${edition._id}:${edition.editionLineId ?? "-"}:${edition.linePosition ?? "-"}:${edition.coverageUnmapped === true}`,
      ),
      coverage: (await ctx.db.query("volumeCoverages").collect())
        .map((row) => `${row.editionId}:${label.get(row.volumeId)}:${row.order}`)
        .sort(),
      releases: (await ctx.db.query("releases").collect()).map(
        (release) =>
          `${release._id}:${release.editionId}:${release.format}:${release.isbn13 ?? "-"}:${release.isbn10 ?? "-"}:${release.language}:${release.binding ?? "-"}:${release.status}`,
      ),
      holds: (await ctx.db.query("placementHolds").collect()).map((hold) => ({
        kind: hold.kind,
        seriesId: hold.seriesId,
      })),
    };
  });
}

type Graph = Awaited<ReturnType<typeof graph>>;
const canonical = ({ holds: _holds, ...rows }: Graph) => rows;

/** What `arrange` may build on: the fixture's Series, VIZ, and its Volumes by label. */
type Seeded = {
  seriesId: Id<"series">;
  publisherId: Id<"publishers">;
  volume: (label: string) => Id<"volumes">;
};

/** A VIZBIG-style member of `lineId` at `position` covering `labels` (none: Unmapped). */
async function member(
  ctx: MutationCtx,
  at: Seeded,
  lineId: Id<"editionLines">,
  position: string | undefined,
  labels: string[],
  release?: { format?: "physical" | "digital"; isbn13?: string },
) {
  const editionId = await insertEdition(ctx, {
    publisherId: at.publisherId,
    editionLineId: lineId,
    linePosition: position,
    ...(labels.length === 0 ? { coverageUnmapped: true as const } : {}),
  });
  for (const [i, label] of labels.entries()) {
    await insertCoverage(ctx, { editionId, volumeId: at.volume(label), order: i + 1 });
  }
  if (release !== undefined) {
    await insertRelease(ctx, {
      editionId,
      publisherId: at.publisherId,
      seriesIds: [at.seriesId],
      format: release.format ?? "physical",
      ...(release.isbn13 !== undefined ? { isbn13: release.isbn13 } : {}),
    });
  }
  return editionId;
}

type Book = {
  /** The Series the entry is linked to; "Alpha" by default. */
  series?: string;
  /** The manga entry's title; the Series' by default. */
  entry?: string;
  /** The release line's title, without its designator. */
  title: string;
  designator?: string;
  /** Active Volumes 1 to `volumes` under the Series (12). */
  volumes?: number;
  bootstrap?: boolean;
  /**
   * The stored snapshot: the mirror's own reading (`fresh`), one written
   * before titles' statements were read (`stale`: the designator's facts
   * only), or one an older reader flagged as no packaging at all
   * (`legacy`: the designator's facts, no title hint).
   */
  snapshot?: "fresh" | "stale" | "legacy";
  storedGap?: boolean;
  /**
   * The release page fetched now: its Title and Volume fields (by default
   * the line's own), parsed by the real page parser. `false`: no fetch, the
   * stored page alone, which carries no Title or Volume.
   */
  page?: { title?: string; volume?: string } | false;
  /** The book's ISBN-13, on its stored and fetched page (`ISBN`). */
  isbn?: string;
  arrange?: (ctx: MutationCtx, at: Seeded) => Promise<unknown>;
  /** What a Moderator does after `arrange`, through the real mutations (bob is one). */
  moderate?: (moderator: ReturnType<typeof signedIn>, t: TestT) => Promise<unknown>;
};

/** A release page fetched now, read by the real page parser. */
function fetchedPage(title: string, volume: string, isbn = ISBN) {
  const parsed = parseReleasePage(
    `<b>Title:</b> ${title}<br><b>Volume:</b> ${volume}<br><b>Distributor:</b> VIZ Media<br><b>ISBN-13:</b> ${isbn}<br>`,
  );
  if (parsed === null) throw new Error("The page fixture does not parse");
  return { status: "ok" as const, fetchedAt: 2, ...parsed };
}

/**
 * One ANN line held as packaging under its Series (as staging holds it),
 * then placed by the real page pass with a freshly parsed release page.
 */
async function pagePass(book: Book) {
  const t = makeT({ transactionLimits: true });
  await seedRegistry(t, book.bootstrap ?? true);
  const series = book.series ?? "Alpha";
  const entry = book.entry ?? series;
  const designator = book.designator ?? "GN 1";
  const split = splitReleaseTitle(`${book.title} (${designator})`, entry);
  // The designator read alone: what a snapshot stored before titles' own
  // statements were read carries.
  const designated = splitReleaseTitle(`${entry} (${designator})`, entry);
  if (split === null || designated === null) throw new Error(`No designator in ${book.title}`);
  const snapshot =
    book.snapshot === "stale"
      ? { ...designated, title: book.title, editionLineHint: split.editionLineHint }
      : book.snapshot === "legacy"
        ? { ...designated, title: book.title, editionLineHint: false }
        : split;
  const ids = await t.run(async (ctx) => {
    const seriesId = await insertSeries(ctx, { title: series });
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const volumes = new Map<string, Id<"volumes">>();
    for (let i = 1; i <= (book.volumes ?? 12); i++) {
      volumes.set(String(i), await insertVolume(ctx, { seriesId, label: String(i), position: i }));
    }
    await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:88",
      recordRef: { type: "series", id: seriesId },
      snapshot: { title: entry },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:5000",
      snapshot: {
        kind: "annRelease",
        annId: "5000",
        mangaId: "88",
        url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5000",
        ...snapshot,
        ...(book.storedGap ? { coverageGapped: true } : {}),
        page: { status: "ok", fetchedAt: 1, isbn13: book.isbn ?? ISBN, distributor: "VIZ Media" },
      },
    });
    await recordUnplaced(
      ctx,
      (await ctx.db.get(observationId))!,
      { kind: "packaging", reason: "Packaging needs verified coverage.", seriesId },
      1,
    );
    const at = { seriesId, publisherId, volume: (label: string) => volumes.get(label)! };
    await book.arrange?.(ctx, at);
    return { seriesId, publisherId, observationId };
  });
  if (book.moderate !== undefined) {
    await seedTeam(t, [alice, bob, carol]);
    await book.moderate(signedIn(t, bob), t);
  }
  const before = await graph(t);
  const page =
    book.page === false
      ? undefined
      : fetchedPage(book.page?.title ?? book.title, book.page?.volume ?? designator, book.isbn);
  const result = await t.mutation(internal.ann.applyReleasePage, { annId: "5000", page });
  const after = await graph(t);
  const observation = (await t.run((ctx) => ctx.db.get(ids.observationId)))!;
  const reason = observation.conflicts?.find((c) => c.field === "placement")?.reason;
  return { t, ids, before, result, after, observation, reason };
}

type Placed = Awaited<ReturnType<typeof pagePass>>;

/** Nothing canonical changed, the line is unlinked, and held as `kind` (null: noted only) under the Series. */
function expectRefused(placed: Placed, kind: "packaging" | "isbn" | null, why?: RegExp) {
  expect(placed.result.status).toBe("recordOnly");
  expect(canonical(placed.after)).toEqual(canonical(placed.before));
  expect(placed.observation.recordRef).toBeUndefined();
  expect(placed.after.holds).toEqual(
    kind === null ? [] : [{ kind, seriesId: placed.ids.seriesId }],
  );
  if (why !== undefined) expect(placed.reason).toMatch(why);
}

/** The labels each Edition covers, by Edition id. */
async function coverageOf(t: TestT) {
  return await t.run(async (ctx) => {
    const label = new Map((await ctx.db.query("volumes").collect()).map((v) => [v._id, v.label]));
    const byEdition: Record<string, string[]> = {};
    const rows = (await ctx.db.query("volumeCoverages").collect()).sort(
      (a, b) => a.order - b.order,
    );
    for (const row of rows) {
      byEdition[row.editionId] = [...(byEdition[row.editionId] ?? []), label.get(row.volumeId)!];
    }
    return byEdition;
  });
}

/** One new Release linked to the book, in a member of `line` at `position` covering `covered`. */
async function expectCreated(
  placed: Placed,
  line: string,
  covered: string[] | "unmapped",
  position: string | null,
) {
  expect(placed.result.status).toBe("created");
  expect(placed.after.holds).toEqual([]);
  expect(placed.after.volumes).toEqual(placed.before.volumes);
  const release = await placed.t.run(async (ctx) =>
    ctx.db.get(placed.observation.recordRef!.id as Id<"releases">),
  );
  expect(release).toMatchObject({ isbn13: ISBN, status: "active" });
  const edition = (await placed.t.run((ctx) => ctx.db.get(release!.editionId)))!;
  const lineDoc = (await placed.t.run((ctx) => ctx.db.get(edition.editionLineId!)))!;
  expect(lineDoc).toMatchObject({ name: line, status: "active" });
  expect(edition.linePosition ?? null).toBe(position);
  const rows = (await coverageOf(placed.t))[edition._id] ?? [];
  if (covered === "unmapped") {
    expect(edition.coverageUnmapped).toBe(true);
    expect(rows).toEqual([]);
  } else {
    expect(edition.coverageUnmapped).toBeUndefined();
    expect(rows).toEqual(covered);
  }
  return { release: release!, edition, line: lineDoc };
}

describe("the mirror reads a line under its Series' own title (C66-R3-01)", () => {
  /**
   * An entry linked to Series `series`, whose ordinary Volume 1 has one
   * physical VIZ Release with no ISBN: the slot a single Volume 1 line
   * links. The entry lists `lines` ("title (designator)"), the first with
   * the book's ISBN. `page` is a page the first line's observation stored
   * earlier.
   */
  async function mirror(args: {
    series: string;
    entry: string;
    lines: string[];
    page?: { title?: string; volume?: string };
  }) {
    const t = makeT();
    await seedRegistry(t, true);
    const ids = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: args.series });
      const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
      const volumeId = await insertVolume(ctx, { seriesId, label: "1", position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      const slotId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "manga:88",
        recordRef: { type: "series", id: seriesId },
        snapshot: { kind: "annManga", title: args.entry },
      });
      if (args.page !== undefined) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: "release:5000",
          snapshot: {
            kind: "annRelease",
            annId: "5000",
            mangaId: "88",
            title: args.entry,
            multi: false,
            format: "physical",
            editionLineHint: false,
            page: { status: "ok", fetchedAt: 1, ...args.page },
          },
        });
      }
      return { seriesId, slotId };
    });
    const releases = args.lines
      .map(
        (line, i) =>
          `<release date="2020-01-0${i + 1}" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=${5000 + i}"${i === 0 ? ` ean="${ISBN}"` : ""}>${line}</release>`,
      )
      .join("");
    const [manga] = parseApiResponse(
      `<ann><manga id="88" name="${args.entry}"><info type="Main title" lang="EN">${args.entry}</info>${releases}</manga></ann>`,
    );
    const before = await graph(t);
    const result = await t.mutation(internal.ann.applyManga, { snapshot: toSnapshot(manga!) });
    const after = await graph(t);
    const state = await t.run(async (ctx) => ({
      slot: (await ctx.db.get(ids.slotId))!,
      line: (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", "release:5000"),
        )
        .unique())!,
    }));
    return { t, ids, manga: manga!, result, before, after, ...state };
  }

  /** The first line took neither a backbone Volume nor the Volume 1 slot, nor wrote its ISBN anywhere. */
  function expectNoSingle(run: Awaited<ReturnType<typeof mirror>>) {
    expect(canonical(run.after)).toEqual(canonical(run.before));
    expect(run.line.recordRef).toBeUndefined();
    expect(run.slot.isbn13).toBeUndefined();
    expect(run.result.releasesLinked).toBe(0);
  }

  it.each([
    { series: "Makunouchi Deluxe", entry: "Makunouchi Deluxe", line: "Alpha [Deluxe] (GN 13)" },
    { series: "Makunouchi Deluxe", entry: "Makunouchi Deluxe", line: "Alpha [Deluxe] (GN 1)" },
    { series: "The Omnibus Club", entry: "The Omnibus Club", line: "Alpha [Omnibus] (GN 1)" },
    { series: "Alpha", entry: "Beta VIZBIG Edition", line: "Alpha [VIZBIG Edition] (GN 13)" },
    { series: "Alpha", entry: "Beta VIZBIG Edition", line: "Alpha [VIZBIG Edition] (GN 1)" },
    { series: "Alpha", entry: "The Omnibus Club", line: "Alpha [Omnibus] (GN 1)" },
    // The entry's name owns "Deluxe Edition"; the Series' title does not.
    { series: "Alpha", entry: "Alpha Deluxe Edition", line: "Alpha Deluxe Edition (GN 1)" },
    // A real added line beside the work's own line word.
    {
      series: "Makunouchi Deluxe",
      entry: "Makunouchi Deluxe",
      line: "Makunouchi Deluxe [VIZBIG Edition] (GN 1)",
    },
  ])("$line in entry $entry under $series is packaging", async (c) => {
    const run = await mirror({ series: c.series, entry: c.entry, lines: [c.line] });
    expectNoSingle(run);
    expect(run.line.snapshot.isbn13).toBe(ISBN);
  });

  it("reads the line's stored page too: a page titling it as a line keeps it off the backbone", async () => {
    const run = await mirror({
      series: "Alpha",
      entry: "Alpha",
      lines: ["Alpha (GN 1)"],
      page: { title: "Alpha [VIZBIG Edition]", volume: "GN 1" },
    });
    expectNoSingle(run);
    // The page the mirror read is kept on the line for the page pass.
    expect(run.line.snapshot.page).toMatchObject({ title: "Alpha [VIZBIG Edition]" });
  });

  it.each([
    { series: "Makunouchi Deluxe", line: "Makunouchi Deluxe (GN 1)" },
    { series: "The Omnibus Club", line: "The Omnibus Club (GN 1)" },
    { series: "Alpha Deluxe Edition", line: "Alpha Deluxe Edition (GN 1)" },
    { series: "Alpha", line: "Alpha [2nd Edition] (GN 1)" },
  ])("$line under $series is its Volume 1: it links the slot and fills its ISBN", async (c) => {
    const run = await mirror({ series: c.series, entry: c.series, lines: [c.line] });
    expect(run.result.releasesLinked).toBe(1);
    expect(run.line.recordRef).toEqual({ type: "release", id: run.ids.slotId });
    expect(run.slot.isbn13).toBe(ISBN);
  });

  it("builds the backbone from a work's own line word, never from another work's", async () => {
    const run = await mirror({
      series: "Makunouchi Deluxe",
      entry: "Makunouchi Deluxe",
      lines: ["Alpha [Deluxe] (GN 13)", "Makunouchi Deluxe (GN 2)", "Alpha [Omnibus] (GN 14)"],
    });
    expect(run.after.volumes).toEqual(["1:active", "2:active"]);
  });

  it("then holds the other work's book in the page pass, writing nothing", async () => {
    const run = await mirror({
      series: "Makunouchi Deluxe",
      entry: "Makunouchi Deluxe",
      lines: ["Alpha [Deluxe] (GN 13)"],
    });
    const before = await graph(run.t);
    const result = await run.t.mutation(internal.ann.applyReleasePage, {
      annId: "5000",
      page: fetchedPage("Alpha [Deluxe]", "GN 13"),
    });
    expect(result.status).toBe("recordOnly");
    const after = await graph(run.t);
    expect(canonical(after)).toEqual(canonical(before));
    expect(after.holds).toEqual([{ kind: "packaging", seriesId: run.ids.seriesId }]);
    expect(result.reason).toMatch(/titled for another work/);
  });
});

describe("a stored false never restores the ordinary path (C66-R3-01)", () => {
  /** Makunouchi Deluxe's Volume 13 with an ordinary VIZ physical Release and no ISBN: a slot. */
  const slot = async (ctx: MutationCtx, at: Seeded) => {
    const editionId = await insertEdition(ctx, { publisherId: at.publisherId });
    await insertCoverage(ctx, { editionId, volumeId: at.volume("13") });
    await insertRelease(ctx, { editionId, publisherId: at.publisherId, seriesIds: [at.seriesId] });
  };

  it.each(["fresh", "stale", "legacy"] as const)(
    "holds another work's Deluxe book under Makunouchi Deluxe (%s snapshot)",
    async (snapshot) => {
      const placed = await pagePass({
        series: "Makunouchi Deluxe",
        title: "Alpha [Deluxe]",
        designator: "GN 13",
        volumes: 13,
        snapshot,
        arrange: slot,
      });
      expectRefused(placed, "packaging", /titled for another work/);
    },
  );

  it("places the work's own VIZBIG book from a legacy snapshot as packaging", async () => {
    const placed = await pagePass({
      series: "Makunouchi Deluxe",
      title: "Makunouchi Deluxe [VIZBIG Edition]",
      snapshot: "legacy",
    });
    await expectCreated(placed, "VIZBIG Edition", ["1", "2", "3"], "1");
  });

  it("keeps the work's plain Volume an ordinary Release", async () => {
    const placed = await pagePass({
      series: "Makunouchi Deluxe",
      title: "Makunouchi Deluxe",
      designator: "GN 2",
      snapshot: "legacy",
    });
    expect(placed.result.status).toBe("created");
    const edition = await placed.t.run(async (ctx) => {
      const release = (await ctx.db.get(placed.observation.recordRef!.id as Id<"releases">))!;
      return (await ctx.db.get(release.editionId))!;
    });
    expect(edition.editionLineId).toBeUndefined();
    expect(Object.values(await coverageOf(placed.t))).toEqual([["2"]]);
  });
});

describe("the page pass reads the current release page with the line (C66-R3-02)", () => {
  it.each([
    { designator: "GN 1", page: { volume: "GN 2" }, why: /different line positions/ },
    { designator: "GN 1", page: { volume: "GN 2 / 2" }, why: /different line positions/ },
    { designator: "GN 1-3", page: { volume: "GN 4-6" }, why: /two ways/ },
    { designator: "GN 1-3", page: { volume: "GN 1, 3" }, why: /two ways/ },
    { designator: "GN 1-3", page: { volume: "GN 1-3-5" }, why: /two ways/ },
    { designator: "GN 1", page: { volume: "Vol. two" }, why: /two ways/ },
    { designator: "GN 1", page: { title: "Alpha+ [VIZBIG Edition]" }, why: /titled otherwise/ },
    { designator: "GN 1", page: { title: "Alpha [Omnibus]" }, why: /titled otherwise/ },
    {
      designator: "GN 1",
      page: { title: "Alpha [VIZBIG Edition Vol. 2]" },
      why: /different line positions/,
    },
    {
      designator: "GN 1-3",
      page: { title: "Alpha [VIZBIG Edition Vols. 4-6]" },
      why: /two ways/,
    },
    { designator: "GN 1", page: { volume: "eBook 1" }, why: /another format/ },
  ])("holds GN $designator against page $page.volume$page.title", async (c) => {
    for (const snapshot of ["fresh", "stale"] as const) {
      const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", ...c, snapshot });
      expectRefused(placed, "packaging", c.why);
    }
  });

  it("notes packaging its page marks a novel, out of scope, with no hold", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      page: { title: "Alpha (Light Novel) [VIZBIG Edition]" },
    });
    expectRefused(placed, null, /marks a novel/);
  });

  it("keeps a stored rejection against a page that reads well", async () => {
    const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", storedGap: true });
    expectRefused(placed, "packaging");
  });

  it.each([
    { designator: "GN 1", page: {}, covered: ["1", "2", "3"], position: "1" },
    { designator: "GN 1", page: { volume: "GN 1 / 4" }, covered: ["1", "2", "3"], position: "1" },
    { designator: "GN 2", page: { volume: "GN 2 / 4" }, covered: ["4", "5", "6"], position: "2" },
    { designator: "GN 1-3", page: {}, covered: ["1", "2", "3"], position: null },
    { designator: "GN 1", page: false as const, covered: ["1", "2", "3"], position: "1" },
  ])("creates from a page restating GN $designator ($page.volume)", async (c) => {
    for (const snapshot of ["fresh", "stale"] as const) {
      const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", ...c, snapshot });
      await expectCreated(placed, "VIZBIG Edition", c.covered, c.position);
    }
  });

  it("refetches a stored page that no longer restates its line", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const snapshot = (volume: string) => ({
        kind: "annRelease",
        annId: "5000",
        mangaId: "88",
        url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5000",
        ...splitReleaseTitle("Alpha [VIZBIG Edition] (GN 1-3)", "Alpha")!,
        page: { status: "ok", fetchedAt: 1, volume, title: "Alpha [VIZBIG Edition]" },
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:5000",
        snapshot: snapshot("GN 1, 3"),
      });
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:5001",
        snapshot: { ...snapshot("GN 1-3 / 9"), annId: "5001" },
      });
    });
    const page = await t.query(internal.ann.releasePageCandidates, {
      cursor: null,
      numItems: 10,
      now: Date.now(),
      refetches: false,
    });
    expect(page.candidates).toMatchObject([
      { annId: "5000", fetch: true },
      { annId: "5001", fetch: false },
    ]);
  });
});

describe("a marker's unread number never becomes a position (C66-R3-03)", () => {
  it.each([
    "Alpha [VIZBIG Edition] (Vol. thirty)",
    "Alpha [VIZBIG Edition] (Book Thirty)",
    "Alpha [VIZBIG Edition Vol. thirty]",
    "Alpha [VIZBIG Edition] (Vol. ２)",
    "Alpha [VIZBIG Edition Vol. ２]",
    "Alpha [VIZBIG Edition] (Vol. n/a)",
    "Alpha [VIZBIG Edition] (Vol. unknown)",
    "Alpha [VIZBIG Edition] (Vol. M)",
    "Alpha [VIZBIG Edition] (Part Two)",
    "Alpha [VIZBIG Edition] (Part 2)",
    "Alpha VIZBIG Edition ２",
  ])("holds %s at GN 1", async (title) => {
    for (const snapshot of ["fresh", "stale"] as const) {
      expectRefused(await pagePass({ title, snapshot }), "packaging");
    }
  });

  it.each([
    { title: "Alpha [VIZBIG Edition] (Vol. II)", designator: "GN 2", line: "VIZBIG Edition" },
    { title: "Alpha [VIZBIG Edition Vol. 2]", designator: "GN 2", line: "VIZBIG Edition" },
    { title: "Alpha [VIZBIG Edition] (Hardcover)", designator: "GN 2", line: "VIZBIG Edition" },
    {
      title: "Alpha [Side Story VIZBIG Edition]",
      designator: "GN 2",
      line: "Side Story VIZBIG Edition",
    },
  ])("creates $title at $designator on Volumes 4-6", async (c) => {
    await expectCreated(await pagePass(c), c.line, ["4", "5", "6"], "2");
  });
});

describe("a packaged book reads its line's member and Release slot first (C66-R3-04)", () => {
  /** Alpha's active VIZBIG Edition line, and `members` built under it. */
  const vizbig =
    (...members: Array<(ctx: MutationCtx, at: Seeded, lineId: Id<"editionLines">) => unknown>) =>
    async (ctx: MutationCtx, at: Seeded) => {
      const lineId = await insertEditionLine(ctx, {
        seriesId: at.seriesId,
        publisherId: at.publisherId,
        name: "VIZBIG Edition",
      });
      for (const build of members) await build(ctx, at, lineId);
    };

  it("holds another printing of the exact member as `isbn`, never a second Release", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: vizbig((ctx, at, line) =>
        member(ctx, at, line, "1", ["1", "2", "3"], { isbn13: OTHER_ISBN }),
      ),
    });
    expectRefused(
      placed,
      "isbn",
      /already has a physical VIZ Media Release \(ISBN 9781974700400\)/,
    );
  });

  it("links the exact member's empty physical slot and fills its ISBN", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: vizbig((ctx, at, line) => member(ctx, at, line, "1", ["1", "2", "3"], {})),
    });
    expect(placed.result.status).toBe("linked");
    expect(placed.after.holds).toEqual([]);
    expect(placed.after.releases).toHaveLength(1);
    expect(placed.after.editions).toEqual(placed.before.editions);
    expect(placed.after.lines).toEqual(placed.before.lines);
    const release = await placed.t.run((ctx) =>
      ctx.db.get(placed.observation.recordRef!.id as Id<"releases">),
    );
    expect(release?.isbn13).toBe(ISBN);
  });

  it("links an empty slot in steady state too, creating nothing", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      bootstrap: false,
      arrange: vizbig((ctx, at, line) => member(ctx, at, line, "1", ["1", "2", "3"], {})),
    });
    expect(placed.result.status).toBe("linked");
    expect(placed.after.releases).toHaveLength(1);
  });

  it("joins the exact member beside its digital Release", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: vizbig((ctx, at, line) =>
        member(ctx, at, line, "1", ["1", "2", "3"], { format: "digital", isbn13: OTHER_ISBN }),
      ),
    });
    const { edition } = await expectCreated(placed, "VIZBIG Edition", ["1", "2", "3"], "1");
    expect(placed.after.editions).toEqual(placed.before.editions);
    expect(placed.after.lines).toEqual(placed.before.lines);
    expect(placed.after.releases).toHaveLength(2);
    expect(placed.before.editions[0]).toContain(edition._id);
  });

  it("joins the member a stated range names, at its position", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition] [4-6]",
      designator: "GN 2",
      arrange: vizbig((ctx, at, line) =>
        member(ctx, at, line, "2", ["4", "5", "6"], { format: "digital" }),
      ),
    });
    await expectCreated(placed, "VIZBIG Edition", ["4", "5", "6"], "2");
    expect(placed.after.editions).toEqual(placed.before.editions);
  });

  it.each([
    { why: "another book at that position", at: "1", labels: ["4", "5", "6"] },
    { why: "these Volumes at another position", at: "2", labels: ["1", "2", "3"] },
    { why: "Volumes overlapping these", at: "3", labels: ["3", "4", "5"] },
    { why: "Unmapped Packaging at that position", at: "1", labels: [] },
  ])("holds a mapped book beside $why", async (c) => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: vizbig((ctx, at, line) => member(ctx, at, line, c.at, c.labels, {})),
    });
    expectRefused(placed, "packaging", /already holds another book/);
  });

  it("holds a book stated with no position beside the member with its Volumes", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      designator: "GN 1-3",
      arrange: vizbig((ctx, at, line) => member(ctx, at, line, "1", ["1", "2", "3"], {})),
    });
    expectRefused(placed, "packaging", /already holds another book/);
  });

  describe("Unmapped Packaging: only a known position names its member", () => {
    const library =
      (...members: Array<{ at?: string; labels: string[]; isbn13?: string }>) =>
      async (ctx: MutationCtx, at: Seeded) => {
        const lineId = await insertEditionLine(ctx, {
          seriesId: at.seriesId,
          publisherId: at.publisherId,
          name: "Library Edition",
        });
        for (const m of members) {
          await member(ctx, at, lineId, m.at, m.labels, { isbn13: m.isbn13 });
        }
      };

    it("links the empty slot of the Unmapped member at its position", async () => {
      const placed = await pagePass({
        title: "Alpha [Library Edition]",
        arrange: library({ at: "1", labels: [] }),
      });
      expect(placed.result.status).toBe("linked");
      expect(placed.after.releases).toHaveLength(1);
    });

    it("holds another printing of it as `isbn`", async () => {
      const placed = await pagePass({
        title: "Alpha [Library Edition]",
        arrange: library({ at: "1", labels: [], isbn13: OTHER_ISBN }),
      });
      expectRefused(placed, "isbn");
    });

    it("holds it beside a mapped member at its position", async () => {
      const placed = await pagePass({
        title: "Alpha [Library Edition]",
        arrange: library({ at: "1", labels: ["1", "2"] }),
      });
      expectRefused(placed, "packaging");
    });

    it("holds an unnumbered book beside any member, and creates it in an empty line", async () => {
      expectRefused(
        await pagePass({
          title: "Alpha [Library Edition]",
          designator: "GN",
          arrange: library({ at: "4", labels: [] }),
        }),
        "packaging",
      );
      await expectCreated(
        await pagePass({ title: "Alpha [Library Edition]", designator: "GN", arrange: library() }),
        "Library Edition",
        "unmapped",
        null,
      );
    });

    it("creates a new member at a free position", async () => {
      const placed = await pagePass({
        title: "Alpha [Library Edition]",
        designator: "GN 2",
        arrange: library({ at: "1", labels: [], isbn13: OTHER_ISBN }),
      });
      await expectCreated(placed, "Library Edition", "unmapped", "2");
      expect(placed.after.lines).toEqual(placed.before.lines);
    });
  });

  it("holds when the member is hidden or locked", async () => {
    for (const fields of [{ status: "hidden" as const }, { locked: true }]) {
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition]",
        arrange: vizbig(async (ctx, at, line) => {
          const editionId = await member(ctx, at, line, "1", ["1", "2", "3"]);
          await ctx.db.patch(editionId, fields);
        }),
      });
      expectRefused(placed, "packaging");
    }
  });
});

describe("a packaged book never recreates a line a Moderator closed (C66-R3-05)", () => {
  /** Alpha's VIZ line `name` with `fields`; returns its id. */
  const line = (
    ctx: MutationCtx,
    at: Seeded,
    fields: Partial<{ name: string; status: "active" | "hidden" | "merged"; locked: boolean }> = {},
  ) =>
    insertEditionLine(ctx, {
      seriesId: at.seriesId,
      publisherId: at.publisherId,
      name: "VIZBIG Edition",
      ...fields,
    });

  it.each([
    { why: "known coverage", title: "Alpha [VIZBIG Edition]", name: "VIZBIG Edition" },
    { why: "unknown coverage", title: "Alpha [Library Edition]", name: "Library Edition" },
  ])("holds a book of a hidden line, $why, and leaves the line hidden", async (c) => {
    const placed = await pagePass({
      title: c.title,
      arrange: (ctx, at) => line(ctx, at, { name: c.name, status: "hidden" }),
    });
    expectRefused(placed, "packaging", /hidden .* line: a Moderator restores the line/);
    expect(placed.after.lines).toEqual([expect.stringMatching(/:hidden$/)]);
  });

  it("holds a book of a locked line", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: (ctx, at) => line(ctx, at, { locked: true }),
    });
    expectRefused(placed, "packaging", /locked VIZBIG Edition line/);
  });

  it("joins the one active line a merged one survives in", async () => {
    let survivor: Id<"editionLines"> | undefined;
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: async (ctx, at) => {
        survivor = await line(ctx, at, { name: "VIZBIG" });
        await ctx.db.patch(await line(ctx, at, { status: "merged" }), { mergedIntoId: survivor });
      },
    });
    const { line: joined } = await expectCreated(placed, "VIZBIG", ["1", "2", "3"], "1");
    expect(joined._id).toBe(survivor);
    expect(placed.after.lines).toEqual(placed.before.lines);
  });

  it.each([
    {
      why: "a hidden survivor",
      arrange: async (ctx: MutationCtx, at: Seeded) => {
        const survivor = await line(ctx, at, { name: "VIZBIG", status: "hidden" });
        await ctx.db.patch(await line(ctx, at, { status: "merged" }), { mergedIntoId: survivor });
      },
    },
    {
      why: "no survivor",
      arrange: (ctx: MutationCtx, at: Seeded) => line(ctx, at, { status: "merged" }),
    },
    {
      why: "a loop",
      arrange: async (ctx: MutationCtx, at: Seeded) => {
        const a = await line(ctx, at, { status: "merged" });
        const b = await line(ctx, at, { name: "VIZBIG", status: "merged" });
        await ctx.db.patch(a, { mergedIntoId: b });
        await ctx.db.patch(b, { mergedIntoId: a });
      },
    },
    {
      why: "another Series' line",
      arrange: async (ctx: MutationCtx, at: Seeded) => {
        const beta = await insertSeries(ctx, { title: "Beta" });
        const survivor = await insertEditionLine(ctx, {
          seriesId: beta,
          publisherId: at.publisherId,
          name: "VIZBIG Edition",
        });
        await ctx.db.patch(await line(ctx, at, { status: "merged" }), { mergedIntoId: survivor });
      },
    },
  ])("holds a book of a merged line with $why", async (c) => {
    const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", arrange: c.arrange });
    expectRefused(placed, "packaging", /merged into no one active line/);
  });

  it("joins the active line, and creates a line of another name beside it", async () => {
    const joined = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: (ctx, at) => line(ctx, at),
    });
    await expectCreated(joined, "VIZBIG Edition", ["1", "2", "3"], "1");
    expect(joined.after.lines).toEqual(joined.before.lines);
    const beside = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: (ctx, at) => line(ctx, at, { name: "Colossal Edition", status: "hidden" }),
    });
    await expectCreated(beside, "VIZBIG Edition", ["1", "2", "3"], "1");
    expect(beside.after.lines).toHaveLength(2);
  });
});

describe("the Editor's Draft and approval read the same facts", () => {
  /** A held book prepared by a member (carol); bob moderates. */
  async function prepared(book: Book) {
    const placed = await pagePass({ ...book, bootstrap: false });
    const { t } = placed;
    // The steady-state page pass held it as packaging under the Series.
    expect(placed.after.holds).toEqual([{ kind: "packaging", seriesId: placed.ids.seriesId }]);
    await seedTeam(t, [alice, bob, carol]);
    const member = signedIn(t, carol);
    const moderator = signedIn(t, bob);
    const prepare = await member.mutation(api.placement.preparePlacement, {
      observationId: placed.ids.observationId,
    });
    const detail = async () =>
      prepare.status === "unavailable"
        ? null
        : (await member.query(api.proposals.proposalDetail, { proposalId: prepare.proposalId }))
            ?.placement;
    return { ...placed, member, moderator, prepare, detail };
  }

  it.each([
    { title: "Alpha [VIZBIG Edition Vol. 2]", page: {} },
    { title: "Alpha [VIZBIG Edition] (Vol. II)", page: {} },
    { title: "Alpha [VIZBIG Edition] (Vol. thirty)", page: {} },
    { title: "Alpha [VIZBIG Edition] (Vol. ２)", page: {} },
    { title: "Alpha [VIZBIG Edition]", page: { volume: "GN 2" } },
    { title: "Alpha [VIZBIG Edition]", page: { title: "Alpha [VIZBIG Edition Vol. 2]" } },
  ])("names the line with no position for $title against page $page", async (book) => {
    const run = await prepared(book);
    expect(await run.detail()).toMatchObject({
      book: { label: null, line: { name: "VIZBIG Edition", position: null } },
      line: { name: "VIZBIG Edition", position: null },
      coverage: { kind: "pending" },
      suggestion: null,
    });
  });

  it("shows no range where the page states another one", async () => {
    const run = await prepared({
      title: "Alpha [VIZBIG Edition]",
      designator: "GN 1-3",
      page: { volume: "GN 4-6" },
    });
    expect((await run.detail())?.book?.statedRange).toBeNull();
  });

  it.each([
    { page: { volume: "eBook 1" }, why: /names another format/ },
    { page: { title: "Alpha (Light Novel) [VIZBIG Edition]" }, why: null },
  ])("refuses to prepare a book its page contradicts: $page", async (c) => {
    if (c.why === null) {
      // A novel is out of scope: the page pass notes it and holds nothing.
      const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", page: c.page });
      expectRefused(placed, null, /marks a novel/);
      return;
    }
    const run = await prepared({ title: "Alpha [VIZBIG Edition]", page: c.page });
    expect(run.prepare).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(c.why),
    });
  });

  it("approves an explicit reviewed position and coverage, never the designator's", async () => {
    const run = await prepared({ title: "Alpha [VIZBIG Edition Vol. 2]" });
    if (run.prepare.status === "unavailable") throw new Error(run.prepare.reason);
    const { proposalId } = run.prepare;
    await expect(
      run.member.mutation(api.proposals.submitProposal, { proposalId }),
    ).rejects.toThrow();
    await run.member.mutation(api.placement.setPlacement, {
      proposalId,
      coverage: { from: "4", to: "6" },
      line: { name: "VIZBIG Edition", position: "2" },
      comment: "The title states position 2; checked Volumes 4-6.",
    });
    await run.member.mutation(api.proposals.submitProposal, { proposalId });
    // The page now restates the source's own GN 1: the reviewed choice stands.
    await run.t.run(async (ctx) => {
      const observation = (await ctx.db.get(run.ids.observationId))!;
      await ctx.db.patch(observation._id, {
        snapshot: {
          ...observation.snapshot,
          page: { ...observation.snapshot.page, volume: "GN 1" },
        },
      });
    });
    const approved = await run.moderator.mutation(api.proposals.approveProposal, { proposalId });
    expect(approved.status).toBe("approved");
    const after = await graph(run.t);
    expect(after.holds).toEqual([]);
    expect(after.volumes).toEqual(run.before.volumes);
    expect(Object.values(await coverageOf(run.t))).toEqual([["4", "5", "6"]]);
  });

  it("approves an explicit Unmapped choice with no position and no Volume", async () => {
    const run = await prepared({ title: "Alpha [VIZBIG Edition] (Vol. thirty)" });
    if (run.prepare.status === "unavailable") throw new Error(run.prepare.reason);
    const { proposalId } = run.prepare;
    await run.member.mutation(api.placement.setPlacement, {
      proposalId,
      coverage: "unmapped",
      line: { name: "VIZBIG Edition", position: null },
      comment: "The title's number is unreadable; a Moderator maps it.",
    });
    await run.member.mutation(api.proposals.submitProposal, { proposalId });
    await run.moderator.mutation(api.proposals.approveProposal, { proposalId });
    const editions = await run.t.run((ctx) => ctx.db.query("editions").collect());
    expect(editions).toMatchObject([{ coverageUnmapped: true }]);
    expect(editions[0]?.linePosition).toBeUndefined();
    expect((await graph(run.t)).volumes).toEqual(run.before.volumes);
  });

  it("refuses approval once the page marks the book a novel or names another ISBN", async () => {
    for (const page of [
      { title: "Alpha (Light Novel) [VIZBIG Edition]" },
      { isbn13: "9781974728374" },
    ]) {
      const run = await prepared({ title: "Alpha [VIZBIG Edition]" });
      if (run.prepare.status === "unavailable") throw new Error(run.prepare.reason);
      const { proposalId } = run.prepare;
      await run.member.mutation(api.placement.setPlacement, {
        proposalId,
        coverage: { from: "1", to: "3" },
        line: { name: "VIZBIG Edition", position: "1" },
        comment: "Checked.",
      });
      await run.member.mutation(api.proposals.submitProposal, { proposalId });
      await run.t.run(async (ctx) => {
        const observation = (await ctx.db.get(run.ids.observationId))!;
        await ctx.db.patch(observation._id, {
          snapshot: { ...observation.snapshot, page: { ...observation.snapshot.page, ...page } },
        });
      });
      await expect(
        run.moderator.mutation(api.proposals.approveProposal, { proposalId }),
      ).rejects.toThrow();
      expect(canonical(await graph(run.t))).toEqual(canonical(run.before));
    }
  });
});

// ---------- review round 4 ----------

/** Alpha's active VIZ `name` line (VIZBIG Edition), with `fields`; returns its id. */
const vizLine = (
  ctx: MutationCtx,
  at: Seeded,
  fields: Partial<{ name: string; status: "active" | "hidden" | "merged"; locked: boolean }> = {},
) =>
  insertEditionLine(ctx, {
    seriesId: at.seriesId,
    publisherId: at.publisherId,
    name: "VIZBIG Edition",
    ...fields,
  });

/** The exact VIZBIG 1 member on Alpha 1–3, with `releases` (each a Release's fields) in it. */
const exactMember =
  (
    ...releases: Array<
      Partial<{
        format: "physical" | "digital";
        isbn13: string;
        isbn10: string;
        language: string;
        binding: string;
        status: "active" | "hidden";
        locked: boolean;
      }>
    >
  ) =>
  async (ctx: MutationCtx, at: Seeded) => {
    const editionId = await member(ctx, at, await vizLine(ctx, at), "1", ["1", "2", "3"]);
    for (const fields of releases) {
      await insertRelease(ctx, {
        editionId,
        publisherId: at.publisherId,
        seriesIds: [at.seriesId],
        ...fields,
      });
    }
    return editionId;
  };

/** The one Release the arranged graph holds. */
const onlyRelease = async (t: TestT) => {
  const [release, ...more] = await t.run((ctx) => ctx.db.query("releases").collect());
  if (release === undefined || more.length > 0) throw new Error("Expected one Release");
  return release;
};

describe("a designator's unread number holds the book (C66-R4-01)", () => {
  it.each(["GN thirty", "GN unknown", "GN n/a", "GN II", "GN M", "GN -", "GN Vol. two"])(
    "holds a page saying %s beside the line's GN 1, writing nothing",
    async (volume) => {
      const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", page: { volume } });
      expectRefused(placed, "packaging");
    },
  );

  it.each([
    ["GN thirty", "fresh"],
    ["GN II", "fresh"],
    ["GN M", "stale"],
    ["GN thirty", "legacy"],
  ] as const)(
    "holds an XML %s (%s snapshot) whatever position the title states",
    async (designator, snapshot) => {
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition Vol. 1]",
        designator,
        snapshot,
      });
      expectRefused(placed, "packaging", /states its number in a way no reading holds/);
    },
  );

  it("keeps GN A unnumbered (Unmapped) and a page restating GN 1 placed", async () => {
    await expectCreated(
      await pagePass({ title: "Alpha [Library Edition]", designator: "GN A" }),
      "Library Edition",
      "unmapped",
      null,
    );
    await expectCreated(
      await pagePass({ title: "Alpha [VIZBIG Edition]", page: { volume: "GN 1 / 9" } }),
      "VIZBIG Edition",
      ["1", "2", "3"],
      "1",
    );
  });
});

describe("a page's store-exclusive or variant Title is out of scope (C66-R4-03)", () => {
  it.each([
    ["Alpha [VIZBIG Edition] (Store Exclusive)", true],
    ["Alpha [VIZBIG Edition] - [Walmart Exclusive Cover]", false],
    ["Alpha [VIZBIG Edition] (Variant Cover)", true],
  ] as const)("notes %s (Bootstrap %s) with no hold and no write", async (title, bootstrap) => {
    const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", bootstrap, page: { title } });
    expectRefused(placed, null, /store-exclusive or variant cover/);
  });
});

describe("a hidden or unresolved Release of the book is never recreated (C66-R4-04)", () => {
  it.each([OTHER_ISBN, undefined])(
    "holds a book whose physical Release (ISBN %s) a Moderator hid",
    async (isbn13) => {
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition]",
        arrange: exactMember(isbn13 !== undefined ? { isbn13 } : {}),
        moderate: async (moderator, t) =>
          await moderator.mutation(api.sensitiveOps.hideRecord, {
            ref: { type: "release", id: (await onlyRelease(t))._id },
            reason: "Suppress this incorrect release.",
            confirmImpact: true,
          }),
      });
      expect(placed.before.releases[0]).toMatch(/:hidden$/);
      expectRefused(placed, "isbn", /an Editor hid: a Moderator restores it/);
    },
  );

  it.each([
    { why: "a hidden survivor", survivor: "hidden" as const, reason: /an Editor hid/ },
    { why: "no survivor", survivor: null, reason: /merged into no active Release/ },
  ])("holds a book whose Release is merged into $why", async (c) => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: async (ctx, at) => {
        const editionId = await exactMember()(ctx, at);
        const base = { editionId, publisherId: at.publisherId, seriesIds: [at.seriesId] };
        const survivor =
          c.survivor !== null
            ? await insertRelease(ctx, { ...base, status: c.survivor, isbn13: OTHER_ISBN })
            : undefined;
        await insertRelease(ctx, {
          ...base,
          status: "merged",
          ...(survivor !== undefined ? { mergedIntoId: survivor } : {}),
        });
      },
    });
    expectRefused(placed, "isbn", c.reason);
  });

  it("links the active Release a merged twin survives in, and ignores another format's hidden one", async () => {
    let survivor: Id<"releases"> | undefined;
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: async (ctx, at) => {
        const editionId = await exactMember({ format: "digital", status: "hidden" })(ctx, at);
        const base = { editionId, publisherId: at.publisherId, seriesIds: [at.seriesId] };
        survivor = await insertRelease(ctx, base);
        await insertRelease(ctx, { ...base, status: "merged", mergedIntoId: survivor });
      },
    });
    expect(placed.result).toMatchObject({ status: "linked", releaseId: survivor });
    expect(placed.after.releases).toHaveLength(3);
  });
});

describe("an ISBN-10 is the Release's barcode (C66-R4-05)", () => {
  it.each(["1974700402", "1974700403"])(
    "holds a book beside a Release carrying ISBN-10 %s of another book, both barcodes kept",
    async (isbn10) => {
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition]",
        arrange: exactMember({ isbn10 }),
      });
      expectRefused(placed, "isbn", new RegExp(`ISBN ${isbn10}\\) carrying another barcode`));
    },
  );

  it("links the Release whose ISBN-10 is this book's, filling its ISBN-13", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember({ isbn10: "1421599996" }),
    });
    expect(placed.result.status).toBe("linked");
    expect(await onlyRelease(placed.t)).toMatchObject({ isbn10: "1421599996", isbn13: ISBN });
  });

  it("links an ISBN-10-only Release to the ISBN-13 it equals", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      isbn: OTHER_ISBN,
      arrange: exactMember({ isbn10: "1974700402" }),
    });
    expect(placed.result.status).toBe("linked");
    expect(await onlyRelease(placed.t)).toMatchObject({
      isbn10: "1974700402",
      isbn13: OTHER_ISBN,
    });
  });
});

describe("every Release that could be the book is read before one is chosen (C66-R4-06)", () => {
  it.each([
    { why: "an empty Release before an occupied one", rows: [{}, { isbn13: OTHER_ISBN }] },
    { why: "an occupied Release before an empty one", rows: [{ isbn13: OTHER_ISBN }, {}] },
  ])("holds $why", async ({ rows }) => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember(...rows),
    });
    expectRefused(placed, "isbn", /carrying another barcode/);
  });

  it.each([
    [{ binding: "paperback" }, { binding: "hardcover" }],
    [{ binding: "hardcover" }, { binding: "paperback" }],
    [{}, { locked: true }],
    [{ locked: true }, {}],
  ])("holds two empty Releases %o and %o, choosing neither", async (first, second) => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember(first, second),
    });
    expectRefused(placed, "isbn", /ANN states no Binding, so none is chosen/);
  });

  it("links the one empty Release, its Binding kept, beside another format's", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember({ binding: "hardcover" }, { format: "digital", isbn13: OTHER_ISBN }),
    });
    expect(placed.result.status).toBe("linked");
    const release = await placed.t.run((ctx) =>
      ctx.db.get(placed.observation.recordRef!.id as Id<"releases">),
    );
    expect(release).toMatchObject({ format: "physical", binding: "hardcover", isbn13: ISBN });
    expect(placed.after.editions).toEqual(placed.before.editions);
  });
});

describe("a Release in another language never takes this book's ISBN (C66-R4-07)", () => {
  it("holds a book beside an empty French Release, which stays as it is", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember({ language: "fr" }),
    });
    expectRefused(placed, "isbn", /in language "fr": another language's book/);
  });

  it("links an empty English Release", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: exactMember({ language: "en" }),
    });
    expect(placed.result.status).toBe("linked");
    expect(await onlyRelease(placed.t)).toMatchObject({ language: "en", isbn13: ISBN });
  });
});

describe("every line of the book's name resolves to one before it joins (C66-R4-08)", () => {
  /** Lines built in this order, then the book: the first is the exact member's. */
  const lines =
    (...rest: Array<(ctx: MutationCtx, at: Seeded) => Promise<unknown>>) =>
    async (ctx: MutationCtx, at: Seeded) => {
      for (const build of rest) await build(ctx, at);
    };
  const hidden = (ctx: MutationCtx, at: Seeded) =>
    vizLine(ctx, at, { name: "vizbig edition", status: "hidden" });
  const locked = (ctx: MutationCtx, at: Seeded) =>
    vizLine(ctx, at, { name: "vizbig edition", locked: true });
  const active = (ctx: MutationCtx, at: Seeded) => vizLine(ctx, at);
  /** An independent active twin whose exact member already has this book's physical Release. */
  const occupiedTwin = async (ctx: MutationCtx, at: Seeded) =>
    member(ctx, at, await vizLine(ctx, at, { name: "vizbig edition" }), "1", ["1", "2", "3"], {
      isbn13: OTHER_ISBN,
    });

  it.each([
    { why: "an active line, then a hidden one", build: lines(active, hidden), reason: /hidden/ },
    { why: "a hidden line, then an active one", build: lines(hidden, active), reason: /hidden/ },
    {
      why: "an active line, then a locked one",
      build: lines(active, locked),
      reason: /2 independent/,
    },
    {
      why: "a locked line, then an active one",
      build: lines(locked, active),
      reason: /2 independent/,
    },
    {
      why: "an active line, then an occupied twin",
      build: lines(active, occupiedTwin),
      reason: /2 independent/,
    },
    {
      why: "an occupied twin, then an active line",
      build: lines(occupiedTwin, active),
      reason: /2 independent/,
    },
  ])("holds a book beside $why, writing nothing", async (c) => {
    const placed = await pagePass({ title: "Alpha [VIZBIG Edition]", arrange: c.build });
    expectRefused(placed, "packaging", c.reason);
  });

  it.each(["merged first", "active first"])(
    "joins the active line a same-name merged one resolves to (%s)",
    async (order) => {
      let survivor: Id<"editionLines"> | undefined;
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition]",
        arrange: async (ctx, at) => {
          const merged =
            order === "merged first" ? await vizLine(ctx, at, { status: "merged" }) : null;
          survivor = await vizLine(ctx, at, { name: "VIZBIG EDITION" });
          const later = merged ?? (await vizLine(ctx, at, { status: "merged" }));
          await ctx.db.patch(later, { mergedIntoId: survivor });
        },
      });
      const { line } = await expectCreated(placed, "VIZBIG EDITION", ["1", "2", "3"], "1");
      expect(line._id).toBe(survivor);
      expect(placed.after.lines).toEqual(placed.before.lines);
    },
  );

  it("creates in the line it proved, never the survivor name's first active line", async () => {
    let survivor: Id<"editionLines"> | undefined;
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: async (ctx, at) => {
        // An unrelated active line spelled like the survivor, inserted first.
        await vizLine(ctx, at, { name: "vizbig" });
        survivor = await vizLine(ctx, at, { name: "VIZBIG" });
        await ctx.db.patch(await vizLine(ctx, at, { status: "merged" }), {
          mergedIntoId: survivor,
        });
      },
    });
    const { line } = await expectCreated(placed, "VIZBIG", ["1", "2", "3"], "1");
    expect(line._id).toBe(survivor);
  });
});

/** What a member states for a held book's placement (setPlacement's arguments). */
type Statement = {
  coverage: { from: string; to: string } | "unmapped";
  line: { name: string; position: string | null } | null;
};

/**
 * A steady-state held Alpha book titled `title`, prepared by carol and
 * stated (VIZBIG 1 on 1–3 unless `statement` says otherwise) through the
 * real mutations; bob moderates. `arrange` builds records before the page
 * pass holds it.
 */
async function stated(
  arrange?: Book["arrange"],
  { title = "Alpha [VIZBIG Edition]", statement }: { title?: string; statement?: Statement } = {},
) {
  const placed = await pagePass({ title, bootstrap: false, arrange });
  expect(placed.after.holds).toEqual([{ kind: "packaging", seriesId: placed.ids.seriesId }]);
  const { t } = placed;
  await seedTeam(t, [alice, bob, carol]);
  const member = signedIn(t, carol);
  const moderator = signedIn(t, bob);
  const prepare = await member.mutation(api.placement.preparePlacement, {
    observationId: placed.ids.observationId,
  });
  if (prepare.status === "unavailable") throw new Error(prepare.reason);
  const { proposalId } = prepare;
  const state = () =>
    member.mutation(api.placement.setPlacement, {
      proposalId,
      ...(statement ?? {
        coverage: { from: "1", to: "3" },
        line: { name: "VIZBIG Edition", position: "1" },
      }),
      comment: "Checked which Alpha Volumes this book collects, and its line and position.",
    });
  const submit = () => member.mutation(api.proposals.submitProposal, { proposalId });
  const approve = () => moderator.mutation(api.proposals.approveProposal, { proposalId });
  const stale = async () =>
    (await moderator.query(api.proposals.proposalDetail, { proposalId }))?.stale;
  const draftState = async () => (await t.run((ctx) => ctx.db.get(proposalId)))?.state;
  const run = {
    ...placed,
    member,
    moderator,
    proposalId,
    state,
    submit,
    approve,
    stale,
    draftState,
  };
  await state();
  return run;
}

type Stated = Awaited<ReturnType<typeof stated>>;

/** The source refreshed by the real page pass, its page titled `title`. */
const pageRefresh = (run: Stated, title: string) =>
  run.t.mutation(internal.ann.applyReleasePage, {
    annId: "5000",
    page: { ...fetchedPage(title, "GN 1"), fetchedAt: 3 },
  });
/** The source refreshed by the real mirror, its line titled `title`. */
const xmlRefresh = (run: Stated, title: string) => {
  const [manga] = parseApiResponse(
    `<ann><manga id="88" name="Alpha"><info type="Main title" lang="EN">Alpha</info><release date="2020-01-01" href="https://www.animenewsnetwork.com/encyclopedia/releases.php?id=5000" ean="${ISBN}">${title} (GN 1)</release></manga></ann>`,
  );
  return run.t.mutation(internal.ann.applyManga, { snapshot: toSnapshot(manga!) });
};

describe("an Editor's placement is bound to the book they reviewed (C66-R4-02)", () => {
  it.each([
    ["page", pageRefresh],
    ["XML", xmlRefresh],
  ] as const)("refuses approval once a %s refresh names another work", async (_, refresh) => {
    const run = await stated();
    await run.submit();
    expect(await run.stale()).toBe(false);
    await refresh(run, "Alpha+ [VIZBIG Edition]");
    const before = await graph(run.t);
    expect(await run.stale()).toBe(true);
    await expect(run.approve()).rejects.toThrow(/names the book otherwise/);
    expect(canonical(await graph(run.t))).toEqual(canonical(before));
  });

  it.each([
    ["page", pageRefresh],
    ["XML", xmlRefresh],
  ] as const)("refuses submission once a %s refresh names another work", async (_, refresh) => {
    const run = await stated();
    await refresh(run, "Alpha+ [VIZBIG Edition]");
    await expect(run.submit()).rejects.toThrow(/names the book otherwise/);
  });

  it("approves once the placement is stated again against the source as it stands", async () => {
    const run = await stated();
    await run.submit();
    await pageRefresh(run, "Alpha+ [VIZBIG Edition]");
    await expect(run.approve()).rejects.toThrow(/names the book otherwise/);
    await run.moderator.mutation(api.proposals.requestChanges, {
      proposalId: run.proposalId,
      note: "The page now titles it Alpha+; check which work it is.",
    });
    await run.state();
    await run.submit();
    expect(await run.stale()).toBe(false);
    expect((await run.approve()).status).toBe("approved");
    expect(Object.values(await coverageOf(run.t))).toEqual([["1", "2", "3"]]);
  });

  it("approves when only the page's Volume field changed after review", async () => {
    const run = await stated();
    await run.submit();
    await run.t.run(async (ctx) => {
      const observation = (await ctx.db.get(run.ids.observationId))!;
      await ctx.db.patch(observation._id, {
        snapshot: {
          ...observation.snapshot,
          page: { ...observation.snapshot.page, volume: "GN 2" },
        },
      });
    });
    expect(await run.stale()).toBe(false);
    expect((await run.approve()).status).toBe("approved");
  });

  it("refuses a placement that carries no reviewed source, as one written before it was recorded", async () => {
    const run = await stated();
    await run.submit();
    await run.t.run(async (ctx) => {
      for (const version of await ctx.db.query("proposalVersions").collect()) {
        await ctx.db.patch(version._id, {
          ops: version.ops.map((op) =>
            op.kind === "create" && op.table === "releases"
              ? {
                  ...op,
                  fields: {
                    ...op.fields,
                    placement: {
                      observationId: op.fields.placement.observationId,
                      seriesId: op.fields.placement.seriesId,
                    },
                  },
                }
              : op,
          ),
        });
      }
    });
    expect(await run.stale()).toBe(true);
    await expect(run.approve()).rejects.toThrow(/names the book otherwise/);
  });

  it("refuses approval once the page marks the book a store-exclusive variant", async () => {
    // Through the page pass, which notes it out of scope and releases the hold.
    const refreshed = await stated();
    await refreshed.submit();
    await pageRefresh(refreshed, "Alpha [VIZBIG Edition] (Store Exclusive)");
    expect((await graph(refreshed.t)).holds).toEqual([]);
    await expect(refreshed.approve()).rejects.toThrow(/It is not a Held Book/);
    // The stored page alone, before any page pass: the Editor's own scope check.
    const run = await stated();
    await run.submit();
    await run.t.run(async (ctx) => {
      const observation = (await ctx.db.get(run.ids.observationId))!;
      await ctx.db.patch(observation._id, {
        snapshot: {
          ...observation.snapshot,
          page: { ...observation.snapshot.page, title: "Alpha [VIZBIG Edition] (Store Exclusive)" },
        },
      });
    });
    await expect(run.approve()).rejects.toThrow(/store-exclusive or variant cover/);
    expect(canonical(await graph(run.t))).toEqual(canonical(run.before));
  });

  it("refuses approval once its joined Edition holds a hidden Release of the format", async () => {
    let editionId: Id<"editions"> | undefined;
    const run = await stated(async (ctx, at) => {
      editionId = await member(ctx, at, await vizLine(ctx, at), "1", ["1", "2", "3"]);
    });
    await run.submit();
    await run.t.run((ctx) =>
      insertRelease(ctx, {
        editionId: editionId!,
        publisherId: run.ids.publisherId,
        seriesIds: [run.ids.seriesId],
        status: "hidden",
      }),
    );
    await expect(run.approve()).rejects.toThrow(/slot for this publisher and format/);
  });

  it("refuses to join the first active line beside an independent twin", async () => {
    const run = await stated(async (ctx, at) => {
      await vizLine(ctx, at);
    });
    await run.t.run((ctx) =>
      vizLine(
        ctx,
        {
          ...run.ids,
          volume: () => {
            throw new Error("unused");
          },
        },
        { name: "vizbig edition" },
      ),
    );
    await expect(run.state()).rejects.toThrow(/not the one open line of its name/);
  });
});

// ---------- review round 5 ----------

/** `Seeded` for records built after the page pass: the fixture's Series, VIZ and Volumes by label. */
async function seededIn(
  ctx: MutationCtx,
  { seriesId, publisherId }: { seriesId: Id<"series">; publisherId: Id<"publishers"> },
): Promise<Seeded> {
  const volumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .collect();
  return {
    seriesId,
    publisherId,
    volume: (label) => volumes.find((volume) => volume.label === label)!._id,
  };
}

/** Records built through `build` inside one transaction of `run`'s graph. */
const buildIn = <T>(run: Stated, build: (ctx: MutationCtx, at: Seeded) => Promise<T>) =>
  run.t.run(async (ctx) => await build(ctx, await seededIn(ctx, run.ids)));

/** A Moderator hides or locks `ref` through the real sensitive ops. */
async function closeRecord(
  run: Stated,
  how: "hidden" | "locked",
  ref: { type: "editionLine"; id: Id<"editionLines"> } | { type: "edition"; id: Id<"editions"> },
) {
  if (how === "hidden") {
    await run.moderator.mutation(api.sensitiveOps.hideRecord, {
      ref,
      reason: "Hide the duplicate pending reconciliation.",
      confirmImpact: true,
    });
  } else {
    await run.moderator.mutation(api.sensitiveOps.lockRecord, {
      ref,
      reason: "Lock the disputed record while resolving its identity.",
      confirmImpact: true,
    });
  }
}

/** Approval refused as stale or by its checks, with nothing canonical written and the book still held. */
async function expectNotApproved(run: Stated) {
  const before = await graph(run.t);
  const result = await run.approve().catch((error: unknown) => String(error));
  expect(result).not.toMatchObject({ status: "approved" });
  expect(await run.stale()).toBe(true);
  const after = await graph(run.t);
  expect(canonical(after)).toEqual(canonical(before));
  expect(after.holds).toEqual([{ kind: "packaging", seriesId: run.ids.seriesId }]);
}

/** Submission refused, the Proposal still a Draft, nothing canonical written. */
async function expectNotSubmitted(run: Stated, why: RegExp) {
  const before = await graph(run.t);
  await expect(run.submit()).rejects.toThrow(why);
  expect(await run.draftState()).toBe("draft");
  expect(canonical(await graph(run.t))).toEqual(canonical(before));
}

/** Titles no segmentation reads, each beside another work's title that is unclear the same way. */
const UNCLEAR = [
  ["Alpha [Deluxe] [VIZBIG Edition]", "Beta [Deluxe] [VIZBIG Edition]"],
  ["Alpha VIZBIG Edition Club", "Beta VIZBIG Edition Club"],
  ["Alpha [VIZBIG Edition", "Beta [VIZBIG Edition"],
] as const;

describe("an unclear title is reviewed as itself, never as its kind of unclear (C66-R5-01)", () => {
  const retitled = UNCLEAR.flatMap(([title, other]) =>
    (
      [
        ["page", pageRefresh],
        ["XML", xmlRefresh],
      ] as const
    ).map(([where, refresh]) => ({ title, other, where, refresh })),
  );

  it.each(retitled)(
    "refuses approval once a $where refresh retitles $title as $other",
    async ({ title, other, refresh }) => {
      const run = await stated(undefined, { title });
      await run.submit();
      expect(await run.stale()).toBe(false);
      await refresh(run, other);
      await expect(run.approve()).rejects.toThrow(/names the book otherwise/);
      await expectNotApproved(run);
    },
  );

  it.each(retitled)(
    "refuses submission once a $where refresh retitles $title as $other",
    async ({ title, other, refresh }) => {
      const run = await stated(undefined, { title });
      await refresh(run, other);
      await expectNotSubmitted(run, /names the book otherwise/);
    },
  );

  it.each(UNCLEAR.map(([title]) => title))(
    "approves %s placed by hand while its source is unchanged, or only respaced or recased",
    async (title) => {
      const run = await stated(undefined, { title });
      await run.submit();
      await pageRefresh(run, title.toUpperCase().replace(" ", "  "));
      expect(await run.stale()).toBe(false);
      expect((await run.approve()).status).toBe("approved");
      expect(Object.values(await coverageOf(run.t))).toEqual([["1", "2", "3"]]);
    },
  );

  it("approves a retitled unclear source once its placement is stated again", async () => {
    const [title, other] = UNCLEAR[0];
    const run = await stated(undefined, { title });
    await run.submit();
    await pageRefresh(run, other);
    await run.moderator.mutation(api.proposals.requestChanges, {
      proposalId: run.proposalId,
      note: "The page now names Beta; check which work this book is.",
    });
    await run.state();
    await run.submit();
    expect(await run.stale()).toBe(false);
    expect((await run.approve()).status).toBe("approved");
    expect(Object.values(await coverageOf(run.t))).toEqual([["1", "2", "3"]]);
  });
});

describe("a placement's line is the one its name resolves to, however the ops name it (C66-R5-02)", () => {
  type Twin = "hidden" | "locked" | "independent";
  const cases = (["hidden", "locked", "independent"] as const).flatMap((twin) =>
    (["line first", "twin first"] as const).map((order) => ({ twin, order })),
  );

  /**
   * After the placement was stated with no line to join (its ops create
   * one), an open VIZBIG Edition line appears beside a case-folded twin:
   * hidden or locked by a Moderator, or independent with the exact
   * member's physical book.
   */
  async function lineAndTwin(run: Stated, twin: Twin, order: "line first" | "twin first") {
    const twinId = await buildIn(run, async (ctx, at) => {
      const makeTwin = async () => {
        const id = await vizLine(ctx, at, { name: "vizbig edition" });
        if (twin === "independent") {
          await member(ctx, at, id, "1", ["1", "2", "3"], { isbn13: OTHER_ISBN });
        }
        return id;
      };
      if (order === "twin first") {
        const id = await makeTwin();
        await vizLine(ctx, at);
        return id;
      }
      await vizLine(ctx, at);
      return await makeTwin();
    });
    if (twin !== "independent") await closeRecord(run, twin, { type: "editionLine", id: twinId });
  }

  /** The ops create the line: the Draft's Edition names it by temp-ID. */
  async function expectNewLine(run: Stated) {
    const proposal = await run.t.run((ctx) => ctx.db.get(run.proposalId));
    expect(proposal?.draft?.ops).toContainEqual(
      expect.objectContaining({ table: "editionLines", tempId: "edition-line" }),
    );
  }

  it.each(cases)("refuses submission beside a $twin twin ($order)", async ({ twin, order }) => {
    const run = await stated();
    await expectNewLine(run);
    await lineAndTwin(run, twin, order);
    await expectNotSubmitted(run, /Records changed/);
  });

  it.each(cases)("refuses approval beside a $twin twin ($order)", async ({ twin, order }) => {
    const run = await stated();
    await run.submit();
    await lineAndTwin(run, twin, order);
    await expectNotApproved(run);
  });

  it("refuses to state a placement whose line exists only hidden", async () => {
    await expect(
      stated(async (ctx, at) => {
        await vizLine(ctx, at, { status: "hidden" });
      }),
    ).rejects.toThrow(/hidden VIZBIG Edition line/);
  });

  it("joins one open line that appeared after the placement was stated", async () => {
    const run = await stated();
    await run.submit();
    const lineId = await buildIn(run, (ctx, at) => vizLine(ctx, at));
    expect((await run.approve()).status).toBe("approved");
    const after = await graph(run.t);
    expect(after.lines).toEqual([`${lineId}:VIZBIG Edition:active`]);
    expect(after.holds).toEqual([]);
    const [edition] = await run.t.run((ctx) => ctx.db.query("editions").collect());
    expect(edition).toMatchObject({ editionLineId: lineId, linePosition: "1" });
    expect(Object.values(await coverageOf(run.t))).toEqual([["1", "2", "3"]]);
  });

  it("joins a late open line's exact member beside its digital Release", async () => {
    const run = await stated();
    await run.submit();
    const editionId = await buildIn(run, async (ctx, at) =>
      member(ctx, at, await vizLine(ctx, at), "1", ["1", "2", "3"], {
        format: "digital",
        isbn13: OTHER_ISBN,
      }),
    );
    const before = await graph(run.t);
    expect((await run.approve()).status).toBe("approved");
    const after = await graph(run.t);
    expect(after.lines).toEqual(before.lines);
    expect(after.editions).toEqual(before.editions);
    expect(after.coverage).toEqual(before.coverage);
    const placed = await run.t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).find((release) => release.isbn13 === ISBN),
    );
    expect(placed).toMatchObject({ editionId, format: "physical", status: "active" });
  });

  it("joins the open line a late same-name merged line resolves to", async () => {
    const run = await stated();
    await run.submit();
    const survivor = await buildIn(run, async (ctx, at) => {
      const id = await vizLine(ctx, at, { name: "VIZBIG EDITION" });
      await vizLine(ctx, at, { status: "merged" }).then((merged) =>
        ctx.db.patch(merged, { mergedIntoId: id }),
      );
      return id;
    });
    const before = await graph(run.t);
    expect((await run.approve()).status).toBe("approved");
    expect((await graph(run.t)).lines).toEqual(before.lines);
    const [edition] = await run.t.run((ctx) => ctx.db.query("editions").collect());
    expect(edition?.editionLineId).toBe(survivor);
  });

  it("joins the proved survivor after a real line merge, despite an unrelated first namesake", async () => {
    const run = await stated();
    await run.submit();
    const { survivor, loser } = await buildIn(run, async (ctx, at) => {
      await vizLine(ctx, at, { name: "vizbig" });
      return {
        survivor: await vizLine(ctx, at, { name: "VIZBIG" }),
        loser: await vizLine(ctx, at),
      };
    });
    await run.moderator.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "editionLine", id: survivor },
      loser: { type: "editionLine", id: loser },
      reason: "Confirm the VIZBIG Edition line is the survivor under its corrected name.",
      confirmImpact: true,
    });
    const before = await graph(run.t);
    expect((await run.approve()).status).toBe("approved");
    expect((await graph(run.t)).lines).toEqual(before.lines);
    const [edition] = await run.t.run((ctx) => ctx.db.query("editions").collect());
    expect(edition?.editionLineId).toBe(survivor);
  });
});

describe("a merged Release answers for the book by its survivor's whole identity (C66-R5-03)", () => {
  /**
   * The exact VIZBIG 1 member with an empty `loser` Release and an empty
   * `survivor` (in `elsewhere`, another Edition of the publisher, when
   * set), which a Moderator merges the loser into through the real merge.
   */
  const merged =
    (
      loser: "physical" | "digital",
      survivor: "physical" | "digital",
      opts: { language?: string; elsewhere?: boolean } = {},
    ) =>
    async (ctx: MutationCtx, at: Seeded) => {
      const editionId = await exactMember()(ctx, at);
      const base = { publisherId: at.publisherId, seriesIds: [at.seriesId] };
      const survivorId = await insertRelease(ctx, {
        ...base,
        editionId: opts.elsewhere
          ? await insertEdition(ctx, { publisherId: at.publisherId })
          : editionId,
        format: survivor,
        ...(opts.language !== undefined ? { language: opts.language } : {}),
      });
      const loserId = await insertRelease(ctx, { ...base, editionId, format: loser });
      return { survivorId, loserId };
    };
  const mergeThem = async (moderator: ReturnType<typeof signedIn>, t: TestT) => {
    const [survivor, loser] = await t.run((ctx) => ctx.db.query("releases").collect());
    await moderator.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "release", id: survivor!._id },
      loser: { type: "release", id: loser!._id },
      reason: "Correct a mis-keyed duplicate into its reviewed identity.",
      confirmImpact: true,
    });
  };

  it("holds a physical book whose physical Release a Moderator merged into the digital one", async () => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: merged("physical", "digital"),
      moderate: mergeThem,
    });
    expect(placed.before.releases[1]).toMatch(/:physical:-:-:en:-:merged$/);
    expectRefused(placed, "isbn", /merged into its digital Release/);
    expect(placed.after.releases[0]).toMatch(/:digital:-:-:en:-:active$/);
  });

  it.each([
    { loser: "digital" as const, why: "a digital Release merged into the physical one" },
    { loser: "physical" as const, why: "a physical twin merged into it" },
  ])("links the empty physical survivor of $why", async ({ loser }) => {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      arrange: merged(loser, "physical"),
      moderate: mergeThem,
    });
    const [survivor] = await placed.t.run((ctx) => ctx.db.query("releases").collect());
    expect(placed.result).toMatchObject({ status: "linked", releaseId: survivor!._id });
    expect(survivor).toMatchObject({ format: "physical", isbn13: ISBN, status: "active" });
    expect(placed.after.editions).toEqual(placed.before.editions);
  });

  it.each(
    [
      { opts: { elsewhere: true }, reason: /merged into no active Release of this book/ },
      { opts: { language: "fr" }, reason: /in language "fr"/ },
    ].flatMap((test) => (["physical", "digital"] as const).map((loser) => ({ ...test, loser }))),
  )(
    "holds a book whose $loser Release was merged into one $opts",
    async ({ opts, reason, loser }) => {
      const placed = await pagePass({
        title: "Alpha [VIZBIG Edition]",
        arrange: merged(loser, "physical", opts),
        moderate: mergeThem,
      });
      expectRefused(placed, "isbn", reason);
    },
  );
});

describe("a placement joins the one member its exact siblings resolve to (C66-R5-04)", () => {
  type Other = "hidden" | "locked" | "occupied";
  const cases = (["hidden", "locked", "occupied"] as const).flatMap((other) =>
    (["open first", "other first"] as const).map((order) => ({ other, order })),
  );

  /**
   * In the line (the existing one, or a new VIZBIG Edition line), two exact
   * VIZBIG 1 members on Alpha 1–3: an open one with only a digital Release
   * and another one hidden or locked by a Moderator, or holding a physical
   * Release of another ISBN, inserted in `order`.
   */
  async function twoMembers(run: Stated, other: Other, order: "open first" | "other first") {
    const otherId = await buildIn(run, async (ctx, at) => {
      const lines = await ctx.db.query("editionLines").collect();
      const lineId = lines[0]?._id ?? (await vizLine(ctx, at));
      const open = () =>
        member(ctx, at, lineId, "1", ["1", "2", "3"], { format: "digital", isbn13: OTHER_ISBN });
      const second = () =>
        member(
          ctx,
          at,
          lineId,
          "1",
          ["1", "2", "3"],
          other === "occupied" ? { isbn13: "9781421540009" } : undefined,
        );
      if (order === "other first") {
        const id = await second();
        await open();
        return id;
      }
      await open();
      return await second();
    });
    if (other !== "occupied") await closeRecord(run, other, { type: "edition", id: otherId });
  }

  it.each(cases)(
    "refuses approval of a new line's book beside a $other exact member ($order)",
    async ({ other, order }) => {
      const run = await stated();
      await run.submit();
      await twoMembers(run, other, order);
      await expectNotApproved(run);
    },
  );

  it.each(cases)(
    "refuses approval in a stored line beside a $other exact member ($order)",
    async ({ other, order }) => {
      const run = await stated(async (ctx, at) => {
        await vizLine(ctx, at);
      });
      await run.submit();
      await twoMembers(run, other, order);
      await expectNotApproved(run);
    },
  );

  it("refuses to state a placement beside two open exact members", async () => {
    const run = await stated(async (ctx, at) => {
      await vizLine(ctx, at);
    });
    await twoMembers(run, "occupied", "open first");
    await expect(run.state()).rejects.toThrow(/one of two/);
  });

  it("joins the one open exact member beside its digital Release, in a stored line", async () => {
    const run = await stated(async (ctx, at) => {
      await vizLine(ctx, at);
    });
    await run.submit();
    const editionId = await buildIn(run, async (ctx, at) =>
      member(
        ctx,
        at,
        (await ctx.db.query("editionLines").collect())[0]!._id,
        "1",
        ["1", "2", "3"],
        {
          format: "digital",
          isbn13: OTHER_ISBN,
        },
      ),
    );
    expect((await run.approve()).status).toBe("approved");
    const placed = await run.t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).find((release) => release.isbn13 === ISBN),
    );
    expect(placed).toMatchObject({ editionId, format: "physical" });
  });

  it.each(cases)(
    "refuses submission beside a $other exact member ($order)",
    async ({ other, order }) => {
      const run = await stated();
      await twoMembers(run, other, order);
      await expectNotSubmitted(run, /Records changed/);
    },
  );

  it.each(["missing", "cycle", "other contents"] as const)(
    "refuses an exact member whose merge resolves to %s",
    async (resolution) => {
      const run = await stated();
      await run.submit();
      await buildIn(run, async (ctx, at) => {
        const lineId = await vizLine(ctx, at);
        const exact = await member(ctx, at, lineId, "1", ["1", "2", "3"]);
        if (resolution === "missing") {
          await ctx.db.patch(exact, { status: "merged" });
        } else if (resolution === "cycle") {
          const twin = await member(ctx, at, lineId, "1", ["1", "2", "3"]);
          await ctx.db.patch(exact, { status: "merged", mergedIntoId: twin });
          await ctx.db.patch(twin, { status: "merged", mergedIntoId: exact });
        } else {
          const other = await member(ctx, at, lineId, "2", ["4", "5", "6"]);
          await ctx.db.patch(exact, { status: "merged", mergedIntoId: other });
        }
      });
      await expectNotApproved(run);
    },
  );

  it("joins the member an exact twin was merged into by a Moderator", async () => {
    const run = await stated();
    await run.submit();
    const [open, twin] = await buildIn(run, async (ctx, at) => {
      const lineId = await vizLine(ctx, at);
      return [
        await member(ctx, at, lineId, "1", ["1", "2", "3"], {
          format: "digital",
          isbn13: OTHER_ISBN,
        }),
        await member(ctx, at, lineId, "1", ["1", "2", "3"]),
      ];
    });
    await run.moderator.mutation(api.sensitiveOps.mergeRecords, {
      survivor: { type: "edition", id: open! },
      loser: { type: "edition", id: twin! },
      reason: "The same VIZBIG book entered twice.",
      confirmImpact: true,
    });
    expect((await run.approve()).status).toBe("approved");
    const placed = await run.t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).find((release) => release.isbn13 === ISBN),
    );
    expect(placed).toMatchObject({ editionId: open, format: "physical" });
  });

  const unmapped = (position: string | null): Statement => ({
    coverage: "unmapped",
    line: { name: "VIZBIG Edition", position },
  });

  it.each([
    { why: "two Unmapped members at its position", position: "4", members: ["4", "4"] },
    { why: "an Unmapped member at no known position", position: null, members: [undefined] },
  ])("refuses an Unmapped placement beside $why", async ({ position, members }) => {
    const run = await stated(
      async (ctx, at) => {
        await vizLine(ctx, at);
      },
      { statement: unmapped(position) },
    );
    await run.submit();
    await buildIn(run, async (ctx, at) => {
      const lineId = (await ctx.db.query("editionLines").collect())[0]!._id;
      for (const at4 of members) await member(ctx, at, lineId, at4, []);
    });
    await expectNotApproved(run);
  });

  it("joins the one Unmapped member at its known position", async () => {
    const run = await stated(
      async (ctx, at) => {
        await vizLine(ctx, at);
      },
      { statement: unmapped("4") },
    );
    await run.submit();
    const editionId = await buildIn(run, async (ctx, at) =>
      member(ctx, at, (await ctx.db.query("editionLines").collect())[0]!._id, "4", [], {
        format: "digital",
      }),
    );
    expect((await run.approve()).status).toBe("approved");
    const placed = await run.t.run(async (ctx) =>
      (await ctx.db.query("releases").collect()).find((release) => release.isbn13 === ISBN),
    );
    expect(placed).toMatchObject({ editionId, format: "physical" });
  });
});

describe("a page pass out of time still reaches every line (C66-R5-05)", () => {
  /**
   * Three held lines, 5000 to 5002, each Alpha [VIZBIG Edition] GN 1 with a
   * stored page saying GN 2, and an ANN answering every request after three
   * minutes with a page whose Volume field is `volume`: the second request
   * passes the link's five-minute budget.
   */
  async function slowPass(volume: string, unparsed?: string) {
    const placed = await pagePass({
      title: "Alpha [VIZBIG Edition]",
      bootstrap: false,
      page: { volume: "GN 2" },
    });
    expect(placed.reason).toMatch(/position/);
    await placed.t.run(async (ctx) => {
      const stored = (await ctx.db.get(placed.ids.observationId))!;
      for (const annId of ["5001", "5002"]) {
        const observationId = await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${annId}`,
          snapshot: { ...stored.snapshot, annId },
        });
        await recordUnplaced(
          ctx,
          (await ctx.db.get(observationId))!,
          {
            kind: "packaging",
            reason: "Packaging needs verified coverage.",
            seriesId: placed.ids.seriesId,
          },
          1,
        );
      }
    });
    const requests: string[] = [];
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "object" && "url" in input ? input.url : String(input);
      const annId = new URL(url).searchParams.get("id") ?? "";
      requests.push(annId);
      clock += 180_001;
      return new Response(
        annId === unparsed
          ? "Unrecognized page"
          : `<b>Title:</b> Alpha [VIZBIG Edition]<br><b>Volume:</b> ${volume}<br><b>Distributor:</b> VIZ Media<br><b>ISBN-13:</b> ${ISBN}<br>`,
      );
    });
    /** The continuation the last link scheduled, run with exactly its arguments. */
    const continueRun = async () => {
      const jobs = await placed.t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const job = jobs.filter((row) => row.name === "ann:syncReleasePages").at(-1);
      if (job === undefined) throw new Error("No continuation was scheduled");
      return await placed.t.action(internal.ann.syncReleasePages, job.args[0]);
    };
    return { ...placed, requests, continueRun };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { volume: "GN 2", persists: true },
    { volume: "GN 1", persists: false },
  ])(
    "fetches each line once, in order, across its continuation (page $volume)",
    async ({ volume, persists }) => {
      const run = await slowPass(volume);
      const first = await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
      expect(first).toMatchObject({ continued: true, fetched: 2, errorCount: 0 });
      expect(run.requests).toEqual(["5000", "5001"]);
      const second = await run.continueRun();
      expect(second).toMatchObject({ continued: false, fetched: 3, recordsSeen: 3, errorCount: 0 });
      expect(run.requests).toEqual(["5000", "5001", "5002"]);
      const after = await graph(run.t);
      expect(canonical(after)).toEqual(canonical(run.after));
      // A page that still disagrees holds its line; one that agrees leaves it held as plain packaging.
      expect(after.holds).toHaveLength(3);
      if (persists) {
        for (const annId of ["5000", "5001", "5002"]) {
          const observation = await run.t.run((ctx) =>
            ctx.db
              .query("sourceObservations")
              .withIndex("by_source_record", (q) =>
                q.eq("sourceKey", "ann").eq("sourceRecordId", `release:${annId}`),
              )
              .unique(),
          );
          expect(observation?.snapshot.page.volume).toBe("GN 2");
          expect(observation?.recordRef).toBeUndefined();
        }
      }
    },
  );

  it("finishes without refetching when the line it stopped before is withdrawn", async () => {
    const run = await slowPass("GN 2");
    await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    // 5001 was fetched already; 5002, not yet, is withdrawn.
    await run.t.run(async (ctx) => {
      const withdrawn = (await ctx.db.query("sourceObservations").collect()).find(
        (row) => row.sourceRecordId === "release:5002",
      )!;
      await ctx.db.patch(withdrawn._id, { withdrawn: true });
    });
    expect(await run.continueRun()).toMatchObject({ continued: false, errorCount: 0 });
    expect(run.requests).toEqual(["5000", "5001"]);
  });

  it("reaches a line listed after the hand-off, in its order", async () => {
    const run = await slowPass("GN 2");
    await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    await run.t.run(async (ctx) => {
      // A new line: listed by the mirror, its page never fetched.
      const { page: _page, ...listed } = (await ctx.db.get(run.ids.observationId))!.snapshot;
      await insertObservation(ctx, {
        sourceKey: "ann",
        sourceRecordId: "release:5003",
        snapshot: { ...listed, annId: "5003" },
      });
    });
    expect(await run.continueRun()).toMatchObject({ continued: false, errorCount: 0 });
    expect(run.requests).toEqual(["5000", "5001", "5002", "5003"]);
  });

  it("rereads an unprocessed line linked by another source during hand-off", async () => {
    const run = await slowPass("GN 2");
    await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    await run.t.run(async (ctx) => {
      const publisherId = (await ctx.db.query("publishers").collect())[0]!._id;
      const editionId = await insertEdition(ctx, { publisherId });
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId,
        seriesIds: [run.ids.seriesId],
        description: "Already described by another source.",
      });
      const linked = (await ctx.db.query("sourceObservations").collect()).find(
        (row) => row.sourceRecordId === "release:5002",
      )!;
      await ctx.db.patch(linked._id, { recordRef: { type: "release", id: releaseId } });
    });
    const before = canonical(await graph(run.t));
    expect(await run.continueRun()).toMatchObject({
      continued: false,
      fetched: 2,
      recordsSeen: 2,
      errorCount: 0,
    });
    expect(run.requests).toEqual(["5000", "5001"]);
    expect(canonical(await graph(run.t))).toEqual(before);
  });

  it("carries parse errors without retrying processed lines or losing remaining lines", async () => {
    const run = await slowPass("GN 2", "5000");
    expect(await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 })).toMatchObject({
      continued: true,
      fetched: 2,
      errorCount: 1,
    });
    expect(await run.continueRun()).toMatchObject({
      continued: false,
      failed: true,
      fetched: 3,
      recordsSeen: 3,
      errorCount: 2,
    });
    expect(run.requests).toEqual(["5000", "5001", "5002"]);
    expect(canonical(await graph(run.t))).toEqual(canonical(run.after));
  });

  it("honors the disabled-source gate before resuming a partial page", async () => {
    const run = await slowPass("GN 2");
    const first = await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    if ("skipped" in first) throw new Error("The fixture source is disabled");
    await run.t.run(async (ctx) => {
      const source = (await ctx.db.query("approvedSources").collect()).find(
        (row) => row.key === "ann",
      )!;
      await ctx.db.patch(source._id, { enabled: false });
    });
    expect(await run.continueRun()).toEqual({ skipped: "disabled" });
    expect(await run.t.run((ctx) => ctx.db.get(first.runId))).toMatchObject({
      status: "stopped",
      recordsSeen: 2,
    });
    expect(run.requests).toEqual(["5000", "5001"]);
    expect(canonical(await graph(run.t))).toEqual(canonical(run.after));
  });

  it("clears bounded progress at the page boundary without losing the next page", async () => {
    const run = await slowPass("GN 2");
    vi.restoreAllMocks();
    await run.t.run(async (ctx) => {
      const stored = (await ctx.db.get(run.ids.observationId))!;
      for (let i = 3; i < 26; i++) {
        const annId = String(5000 + i);
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${annId}`,
          snapshot: { ...stored.snapshot, annId },
        });
      }
    });
    expect(
      await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0, maxFetches: 24 }),
    ).toMatchObject({ continued: true, fetched: 24, recordsSeen: 24 });
    const jobs = await run.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const job = jobs.filter((row) => row.name === "ann:syncReleasePages").at(-1)!;
    expect(job.args[0].completed).toHaveLength(24);
    expect(await run.continueRun()).toMatchObject({
      continued: false,
      fetched: 26,
      recordsSeen: 26,
      errorCount: 0,
    });
    expect(run.requests).toEqual(Array.from({ length: 26 }, (_, i) => String(5000 + i)));
    expect(canonical(await graph(run.t))).toEqual(canonical(run.after));
  });

  it("fetches a lasting disagreement again on the next pass", async () => {
    const run = await slowPass("GN 2");
    await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    await run.continueRun();
    const next = await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    expect(next).toMatchObject({ continued: true, errorCount: 0 });
    expect(run.requests).toEqual(["5000", "5001", "5002", "5000", "5001"]);
    expect(canonical(await graph(run.t))).toEqual(canonical(run.after));
  });

  it("finishes five persistent disagreements through two resumptions", async () => {
    const run = await slowPass("GN 2");
    await run.t.run(async (ctx) => {
      const stored = (await ctx.db.get(run.ids.observationId))!;
      for (const annId of ["5003", "5004"]) {
        await insertObservation(ctx, {
          sourceKey: "ann",
          sourceRecordId: `release:${annId}`,
          snapshot: { ...stored.snapshot, annId },
        });
      }
    });
    expect(await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 })).toMatchObject({
      continued: true,
      fetched: 2,
      recordsSeen: 2,
    });
    expect(await run.continueRun()).toMatchObject({ continued: true, fetched: 4, recordsSeen: 4 });
    expect(await run.continueRun()).toMatchObject({ continued: false, fetched: 5, recordsSeen: 5 });
    expect(run.requests).toEqual(["5000", "5001", "5002", "5003", "5004"]);
    expect(canonical(await graph(run.t))).toEqual(canonical(run.after));
  });

  it("respects maxFetches inside a partial page", async () => {
    const run = await slowPass("GN 2");
    expect(
      await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0, maxFetches: 1 }),
    ).toMatchObject({ continued: true, fetched: 1, recordsSeen: 1 });
    expect(await run.continueRun()).toMatchObject({ continued: true, fetched: 2, recordsSeen: 2 });
    expect(await run.continueRun()).toMatchObject({ continued: false, fetched: 3, recordsSeen: 3 });
    expect(run.requests).toEqual(["5000", "5001", "5002"]);
  });

  it("accepts an old queued continuation without page progress and then carries progress", async () => {
    const run = await slowPass("GN 2");
    const first = await run.t.action(internal.ann.syncReleasePages, { politeDelayMs: 0 });
    if ("skipped" in first) throw new Error("The fixture source is disabled");
    const oldShape = await run.t.action(internal.ann.syncReleasePages, {
      politeDelayMs: 0,
      runId: first.runId,
      cursor: null,
      seen: first.recordsSeen,
      changed: first.recordsChanged,
      fetched: first.fetched,
    });
    expect(oldShape).toMatchObject({ continued: true, fetched: 4 });
    expect(await run.continueRun()).toMatchObject({ continued: false, fetched: 5 });
    expect(run.requests).toEqual(["5000", "5001", "5000", "5001", "5002"]);
  });

  it("uses explicit page progress, including when page timestamps equal the current clock", async () => {
    const run = await slowPass("GN 2");
    const now = Date.now();
    const read = (args: { completed?: Id<"sourceObservations">[] }) =>
      run.t.query(internal.ann.releasePageCandidates, {
        cursor: null,
        numItems: 25,
        now,
        refetches: true,
        ...args,
      });
    const fetches = async (args: { completed?: Id<"sourceObservations">[] }) =>
      (await read(args)).candidates.map((candidate) => candidate.fetch);
    expect(await fetches({})).toEqual([true, true, true]);
    await run.t.mutation(internal.ann.applyReleasePage, {
      annId: "5000",
      page: { ...fetchedPage("Alpha [VIZBIG Edition]", "GN 2"), fetchedAt: Date.now() },
    });
    // A recent timestamp does not prove this invocation processed it.
    expect(await fetches({})).toEqual([true, true, true]);
    expect(await fetches({ completed: [run.ids.observationId] })).toEqual([true, true]);
  });
});
