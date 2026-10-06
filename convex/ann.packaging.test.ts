// ANN packaging's boundary through the real mutations (PR #66, review round
// 3): the mirror reads every line under its Series' own title before it
// builds the backbone or takes a Release slot; the page pass reads the
// line's current release page beside it before it creates anything; a
// marker's unread number is never a position; a packaged book reads its
// Edition Line, the line's members and the Release slot as they stand, in
// the same mutation; and the Editor's Draft and approval read the same
// facts. Every refusal asserts that no canonical row changed and where the
// book is held, beside a positive counterpart that creates or links.

import { describe, expect, it } from "vitest";

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
        (line) => `${line._id}:${line.name}:${line.status}`,
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
          `${release._id}:${release.editionId}:${release.format}:${release.isbn13 ?? "-"}`,
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
  arrange?: (ctx: MutationCtx, at: Seeded) => Promise<unknown>;
};

/** A release page fetched now, read by the real page parser. */
function fetchedPage(title: string, volume: string) {
  const parsed = parseReleasePage(
    `<b>Title:</b> ${title}<br><b>Volume:</b> ${volume}<br><b>Distributor:</b> VIZ Media<br><b>ISBN-13:</b> ${ISBN}<br>`,
  );
  if (parsed === null) throw new Error("The page fixture does not parse");
  return { status: "ok" as const, fetchedAt: 2, ...parsed };
}

/**
 * One ANN line held as packaging under its Series (as staging holds it),
 * then placed by the real page pass with a freshly parsed release page.
 */
async function pagePass(book: Book) {
  const t = makeT();
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
        page: { status: "ok", fetchedAt: 1, isbn13: ISBN, distributor: "VIZ Media" },
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
  const before = await graph(t);
  const page =
    book.page === false
      ? undefined
      : fetchedPage(book.page?.title ?? book.title, book.page?.volume ?? designator);
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
    expect(page.candidates).toEqual([
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
