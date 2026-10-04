// The unmatched-placement tail through every source that runs it
// (lib/unmatched.ts): Seven Seas, Kodansha, PRH and Yen Press each apply
// the same book, one that matches no Release, in the same catalog, and the
// table records everything observable: the status returned, the hold and
// its note, the records created, the Proposal queued with its comment and
// ops, and what a second, unchanged run returns and writes. Where the
// sources differ the table says so; each difference is an option of the
// shared tail, or a value its adapter passes. A second table pins the
// documents some of those runs read, so the tail reads no more (Bootstrap
// Mode on a path that does not use it) and no less than its sources did.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { Packaging } from "./lib/bookTitle";
import { linkSeriesObservation } from "./lib/pipeline";
import { BOOK_PAGE_VERSION } from "./lib/sevenSeas";
import type { ApplyResult } from "./lib/unmatched";
import {
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { makeT, seedRegistry, tickingClock, type TestT } from "./test.helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCES = ["sevenSeas", "kodansha", "prh", "yenPress"] as const;
type Source = (typeof SOURCES)[number];

/** One book as every source would describe it. */
type Book = {
  title: string;
  seriesTitle: string;
  volumeLabel?: string;
  packaging?: Packaging;
  isBox?: true;
  isbn13: string;
  /** PRH and Yen Press only: the record names no imprint. */
  noImprint?: true;
};

const ISBN = "9781999000300";
const SERIES = "Gamma Quest";
const SLUG = "gamma-quest";
const releaseDate = { year: 2026, month: 5, day: 12 };

const volume3: Book = { title: "Gamma Quest Vol. 3", seriesTitle: SERIES, volumeLabel: "3", isbn13: ISBN };

const packaged = (title: string, packaging: Packaging): Book => ({ title, seriesTitle: SERIES, packaging, isbn13: ISBN });

/** One source's apply mutation, run at the top level (`t.mutation`) or nested (`ctx.runMutation`). */
type Run<M extends FunctionReference<"mutation", "internal">> = (
  ref: M,
  args: FunctionArgs<M>,
) => Promise<FunctionReturnType<M>>;
type Mutate = Run<typeof internal.sevenSeas.applyBook> &
  Run<typeof internal.kodansha.applyVolume> &
  Run<typeof internal.prh.applyTitle> &
  Run<typeof internal.yenPress.applyTitle>;

/** Each source's key, which its observations are stored under. */
const SOURCE_KEYS: Record<Source, string> = {
  sevenSeas: "sevenseas",
  kodansha: "kodansha",
  prh: "prh",
  yenPress: "yenpress",
};

/** Apply the book through one source's own mutation, as its sync would (`t.mutation`, or nested). */
async function apply(mutate: Mutate, source: Source, book: Book): Promise<ApplyResult> {
  const coverRange = book.packaging?.coverRange ?? null;
  const catalog = {
    url: `https://example.com/${source}/${ISBN}`,
    isbn13: book.isbn13,
    title: book.title,
    seriesTitle: book.seriesTitle,
    volumeLabel: book.volumeLabel,
    multiVolume: coverRange !== null && coverRange.from !== coverRange.to,
    packaging: book.packaging,
    isBox: book.isBox,
    onsale: releaseDate,
    format: "physical" as const,
    binding: "Paperback",
    priceCents: 1299,
  };
  switch (source) {
    case "sevenSeas":
      return await mutate(internal.sevenSeas.applyBook, {
        sourceRecordId: "9001",
        snapshot: {
          kind: "book",
          url: `https://sevenseasentertainment.com/books/${SLUG}-${ISBN}/`,
          title: book.title,
          modifiedGmt: "2026-08-01T00:00:00",
          seriesTitle: book.seriesTitle,
          seriesSlug: SLUG,
          seriesUrl: `https://sevenseasentertainment.com/series/${SLUG}/`,
          volumeLabel: book.volumeLabel,
          packaging: book.packaging,
          isBox: book.isBox,
          creators: [],
          category: "Manga",
          binding: "Paperback",
          releaseDate,
          priceCents: 1299,
          isbn13: book.isbn13,
          parserVersion: BOOK_PAGE_VERSION,
        },
      });
    case "kodansha":
      return await mutate(internal.kodansha.applyVolume, {
        sourceRecordId: `${SLUG}/${SLUG}-${ISBN}#physical`,
        snapshot: {
          kind: "kodanshaVolume",
          url: `https://kodansha.us/series/${SLUG}/${SLUG}-${ISBN}/`,
          title: book.title,
          seriesTitle: book.seriesTitle,
          seriesSlug: SLUG,
          seriesUrl: `https://kodansha.us/series/${SLUG}/`,
          volumeLabel: book.volumeLabel,
          packaging: book.packaging,
          format: "physical",
          creators: [],
          releaseDate,
          isbn13: book.isbn13,
          binding: "Paperback",
          priceCents: 1299,
        },
      });
    case "prh":
      return await mutate(internal.prh.applyTitle, {
        snapshot: { kind: "prhTitle", ...catalog, imprint: book.noImprint ? undefined : "Gamma Comics" },
      });
    case "yenPress":
      return await mutate(internal.yenPress.applyTitle, {
        snapshot: { kind: "yenTitle", ...catalog, imprint: book.noImprint ? undefined : "Yen Press", category: "manga" },
      });
  }
}

// ---------- reading the outcome ----------

const TABLES = [
  "publishers",
  "series",
  "volumes",
  "editionLines",
  "editions",
  "volumeCoverages",
  "releases",
  "releaseBundles",
  "bundleMemberships",
  "proposals",
  "proposalVersions",
  "revisions",
  "sourceObservations",
  "observationSnapshots",
  "placementHolds",
] as const satisfies TableNames[];

type Row = { _id: string } & Record<string, unknown>;
type Dump = Map<string, { table: string; row: Row }>;

async function dump(t: TestT): Promise<Dump> {
  const tables = await t.run(async (ctx) => {
    const found: Array<{ table: string; rows: Row[] }> = [];
    for (const table of TABLES) found.push({ table, rows: await ctx.db.query(table).collect() });
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      found.push({ table: `scheduled ${job.name}`, rows: [{ _id: job._id }] });
    }
    return found;
  });
  return new Map(tables.flatMap(({ table, rows }) => rows.map((row) => [row._id, { table, row }] as const)));
}

/** A row named by what it is, so ids never reach an expectation; `bare` leaves out its tags. */
function alias(rows: Dump, id: string, bare = false): string {
  const found = rows.get(id);
  if (found === undefined) return id;
  const { table, row } = found;
  const str = (field: string) => String(row[field]);
  const tags = bare
    ? ""
    : `${row.bootstrapUnreviewed ? " (unreviewed)" : ""}${row.coverageUnmapped ? " (unmapped)" : ""}`;
  switch (table) {
    case "publishers":
      return `publisher ${str("slug")}${tags}`;
    case "series":
      return `series "${str("title")}"${row.status !== "active" ? ` ${str("status")}` : ""}${tags}`;
    case "volumes":
      return `volume ${str("label")} of ${alias(rows, str("seriesId"), true)}${tags}`;
    case "editionLines":
      return `line "${str("name")}"${tags}`;
    case "editions":
      return `edition of ${alias(rows, str("publisherId"), true)}${row.editionLineId ? ` in ${alias(rows, str("editionLineId"), true)} ${str("linePosition")}` : ""}${tags}`;
    case "volumeCoverages":
      return `coverage of ${alias(rows, str("volumeId"), true)}`;
    case "releases":
      return `release ${str("isbn13")}${row.status !== "active" ? ` ${str("status")}` : ""}${tags}`;
    case "releaseBundles":
      return `bundle "${str("name")}"${tags}`;
    case "proposals":
      return `proposal ${str("state")}`;
    default:
      return table.replace(/s$/, "");
  }
}

/** Ids in a value replaced by their aliases. */
function named(rows: Dump, value: unknown): unknown {
  if (typeof value === "string") return rows.has(value) ? alias(rows, value) : value;
  if (Array.isArray(value)) return value.map((item) => named(rows, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, named(rows, item)]));
  }
  return value;
}

/** Equal aliases counted: ["revision ×5", "series …"]. */
function counted(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).sort();
}

/** What a run wrote: rows inserted and deleted, and the fields it changed on the rest. */
function writes(before: Dump, after: Dump): string[] {
  const out: string[] = [];
  for (const [id, { table, row }] of after) {
    const old = before.get(id);
    if (old === undefined) {
      out.push(`+ ${alias(after, id)}`);
      continue;
    }
    const keys = new Set([...Object.keys(row), ...Object.keys(old.row)]);
    const changed = [...keys].filter((key) => JSON.stringify(row[key]) !== JSON.stringify(old.row[key]));
    if (changed.length > 0) out.push(`~ ${table} ${changed.sort().join(", ")}`);
  }
  for (const id of before.keys()) if (!after.has(id)) out.push(`- ${alias(before, id)}`);
  return counted(out);
}

function result(r: ApplyResult): string {
  return [
    r.status,
    r.changed ? "changed" : "unchanged",
    ...(r.reason !== undefined ? [`reason "${r.reason}"`] : []),
    ...(r.releaseId !== undefined ? ["releaseId"] : []),
    ...(r.cover !== undefined ? ["cover"] : []),
  ].join(", ");
}

/** The book's observation, and the source's series link when it wrote one. */
async function observations(t: TestT, source: Source) {
  const all = await t.run((ctx) => ctx.db.query("sourceObservations").collect());
  const rows = all.filter((o) => o.sourceKey === SOURCE_KEYS[source]);
  const book = rows.filter((o) => !o.sourceRecordId.startsWith("series:"));
  const links = rows.filter((o) => o.sourceRecordId.startsWith("series:"));
  expect(book).toHaveLength(1);
  expect(links.length).toBeLessThanOrEqual(1);
  return { book: book[0]!, link: links[0] ?? null };
}

type Outcome = {
  result: string;
  hold: string | null;
  /** Rows the first run inserted, observations aside. */
  created: string[];
  /** What the source's own series link (Seven Seas, Kodansha) points at. */
  seriesLink: string | null;
  proposal: { comment: string; ops: string[] } | null;
  second: { result: string; writes: string[] };
};

type Case = {
  name: string;
  bootstrap: boolean;
  book: Book;
  /** Catalog rows present before the book arrives. */
  seed?: (ctx: MutationCtx) => Promise<unknown>;
  /** A change between the first run and the second. */
  between?: (ctx: MutationCtx) => Promise<unknown>;
};

/** Apply the case's book through one source, twice, and read what happened. */
async function outcome(c: Case, source: Source): Promise<Outcome> {
  const t = makeT();
  tickingClock();
  await seedRegistry(t, c.bootstrap);
  if (c.seed) await t.run(c.seed);
  const start = await dump(t);
  const first = await apply(t.mutation, source, c.book);
  const afterFirst = await dump(t);
  const { book: obs, link } = await observations(t, source);
  const note = obs.conflicts?.find((conflict) => conflict.field === "placement")?.reason;
  const row = await t.run((ctx) =>
    ctx.db
      .query("placementHolds")
      .withIndex("by_observation", (q) => q.eq("observationId", obs._id))
      .unique(),
  );
  const proposal =
    obs.queuedProposalId === undefined
      ? null
      : await t.run(async (ctx) => {
          const version = await ctx.db
            .query("proposalVersions")
            .withIndex("by_proposal", (q) => q.eq("proposalId", obs.queuedProposalId!))
            .unique();
          return {
            comment: version!.changeComment ?? "",
            ops: version!.ops.map((op) =>
              op.kind === "create"
                ? `${op.table} ${op.tempId} ${JSON.stringify(named(afterFirst, op.fields))}`
                : op.kind,
            ),
          };
        });
  if (c.between) await t.run(c.between);
  const beforeSecond = await dump(t);
  const second = await apply(t.mutation, source, c.book);
  return {
    result: result(first),
    hold:
      note === undefined && row === null
        ? null
        : `${row === null ? "not listed" : `${row.kind}${row.seriesId ? ` under ${alias(afterFirst, row.seriesId)}` : ""}`}: ${note ?? "(no note)"}`,
    created: counted(
      [...afterFirst.keys()]
        .filter((id) => !start.has(id) && afterFirst.get(id)?.table !== "sourceObservations")
        .map((id) => alias(afterFirst, id)),
    ),
    seriesLink: link?.recordRef ? alias(afterFirst, link.recordRef.id, true) : null,
    proposal,
    second: { result: result(second), writes: writes(beforeSecond, await dump(t)) },
  };
}

// ---------- the catalog each case starts from ----------

/** "Gamma Quest" with Volumes 1 and 2 and nothing else. */
async function gammaQuest(ctx: MutationCtx, fields: Partial<Doc<"series">> = {}): Promise<Id<"series">> {
  const seriesId = await insertSeries(ctx, { title: SERIES, publicId: 1, ...fields });
  await insertVolume(ctx, { seriesId, position: 1 });
  await insertVolume(ctx, { seriesId, position: 2 });
  return seriesId;
}

/** A Release holding the book's ISBN under its own Series and Edition. */
async function isbnHolder(ctx: MutationCtx, seriesTitle: string, status: "active" | "hidden") {
  const publisherId = await insertPublisher(ctx, { name: "Other House", slug: "other-house" });
  const seriesId = await insertSeries(ctx, { title: seriesTitle });
  const volumeId = await insertVolume(ctx, { seriesId, position: 3 });
  const editionId = await insertEdition(ctx, { publisherId });
  await insertCoverage(ctx, { editionId, volumeId });
  return await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], isbn13: ISBN, status });
}

const CASES: Case[] = [
  { name: "Series missing, Bootstrap Mode: ordinary creation", bootstrap: true, book: volume3 },
  { name: "Series missing, steady state: the queued Proposal", bootstrap: false, book: volume3 },
  {
    name: "Series hidden, steady state",
    bootstrap: false,
    book: volume3,
    seed: (ctx) => gammaQuest(ctx, { status: "hidden" }),
  },
  {
    name: "Series hidden, Bootstrap Mode",
    bootstrap: true,
    book: volume3,
    seed: (ctx) => gammaQuest(ctx, { status: "hidden" }),
  },
  {
    name: "Series merged into another",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      const survivor = await gammaQuest(ctx, { title: "Gamma Quest Saga", publicId: 2 });
      await insertSeries(ctx, { title: SERIES, publicId: 3, status: "merged", mergedIntoId: survivor });
    },
  },
  {
    name: "Series locked",
    bootstrap: false,
    book: volume3,
    seed: (ctx) => gammaQuest(ctx, { locked: true }),
  },
  {
    name: "ISBN on an active Release of another Series",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await isbnHolder(ctx, "Unrelated Work", "active");
    },
  },
  {
    name: "ISBN on two active Releases",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await isbnHolder(ctx, SERIES, "active");
      const publisherId = await insertPublisher(ctx, { name: "Third House", slug: "third-house" });
      const seriesId = await insertSeries(ctx, { title: "Gamma Quest Again" });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId], isbn13: ISBN });
    },
  },
  {
    name: "ISBN on a hidden Release",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await isbnHolder(ctx, SERIES, "hidden");
    },
  },
  {
    name: "ambiguous Series title, steady state",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await gammaQuest(ctx, { publicId: 2 });
    },
  },
  {
    name: "ambiguous Series title, Bootstrap Mode",
    bootstrap: true,
    book: volume3,
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await gammaQuest(ctx, { publicId: 2 });
    },
  },
  { name: "missing Volume, Bootstrap Mode", bootstrap: true, book: volume3, seed: (ctx) => gammaQuest(ctx) },
  { name: "missing Volume, steady state", bootstrap: false, book: volume3, seed: (ctx) => gammaQuest(ctx) },
  {
    name: "packaging with stated coverage, Bootstrap Mode",
    bootstrap: true,
    book: packaged("Gamma Quest Omnibus 1 (Vol. 1-3)", {
      lineName: "Omnibus",
      linePosition: "1",
      coverRange: { from: "1", to: "3" },
    }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with stated coverage, steady state",
    bootstrap: false,
    book: packaged("Gamma Quest Omnibus 1 (Vol. 1-3)", {
      lineName: "Omnibus",
      linePosition: "1",
      coverRange: { from: "1", to: "3" },
    }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with line-size coverage, Bootstrap Mode",
    bootstrap: true,
    book: packaged("Gamma Quest 3-in-1 Edition Vol. 2", {
      lineName: "3-in-1 Edition",
      linePosition: "2",
      coverRange: null,
    }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with line-size coverage, steady state",
    bootstrap: false,
    book: packaged("Gamma Quest 3-in-1 Edition Vol. 2", {
      lineName: "3-in-1 Edition",
      linePosition: "2",
      coverRange: null,
    }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with unknown coverage, Bootstrap Mode",
    bootstrap: true,
    book: packaged("Gamma Quest Deluxe Edition 2", { lineName: "Deluxe Edition", linePosition: "2", coverRange: null }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with unknown coverage, steady state",
    bootstrap: false,
    book: packaged("Gamma Quest Deluxe Edition 2", { lineName: "Deluxe Edition", linePosition: "2", coverRange: null }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with unknown coverage and no line name, Bootstrap Mode",
    bootstrap: true,
    book: packaged("Gamma Quest Collection", { lineName: null, linePosition: null, coverRange: null }),
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with unknown coverage, ambiguous Series, Bootstrap Mode",
    bootstrap: true,
    book: packaged("Gamma Quest Deluxe Edition 2", { lineName: "Deluxe Edition", linePosition: "2", coverRange: null }),
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await gammaQuest(ctx, { publicId: 2 });
    },
  },
  {
    name: "box set, Bootstrap Mode",
    bootstrap: true,
    book: {
      ...packaged("Gamma Quest Box Set 1", { lineName: "Box Set", linePosition: "1", coverRange: { from: "1", to: "2" } }),
      isBox: true,
    },
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "box set, steady state",
    bootstrap: false,
    book: {
      ...packaged("Gamma Quest Box Set 1", { lineName: "Box Set", linePosition: "1", coverRange: { from: "1", to: "2" } }),
      isBox: true,
    },
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    name: "packaging with unknown coverage on an ISBN a hidden Release holds",
    bootstrap: false,
    book: packaged("Gamma Quest Deluxe Edition 2", { lineName: "Deluxe Edition", linePosition: "2", coverRange: null }),
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await isbnHolder(ctx, SERIES, "hidden");
    },
  },
  {
    name: "ISBN on a hidden Release, ambiguous Series title",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await gammaQuest(ctx, { publicId: 2 });
      await isbnHolder(ctx, "Gamma Quest", "hidden");
    },
  },
  {
    name: "no imprint, ambiguous Series title",
    bootstrap: true,
    book: { ...volume3, noImprint: true },
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await gammaQuest(ctx, { publicId: 2 });
    },
  },
  {
    name: "no imprint, Series missing, Bootstrap Mode",
    bootstrap: true,
    book: { ...volume3, noImprint: true },
  },
  {
    name: "queued, then an Editor hides a Series of the work's title",
    bootstrap: false,
    book: volume3,
    between: (ctx) => insertSeries(ctx, { title: SERIES, status: "hidden" }),
  },
  {
    // The ladder's flag is answered before the missing publisher.
    name: "no imprint, ISBN on a hidden Release",
    bootstrap: false,
    book: { ...volume3, noImprint: true },
    seed: async (ctx) => {
      await gammaQuest(ctx);
      await isbnHolder(ctx, SERIES, "hidden");
    },
  },
  {
    // Unmapped Packaging needs a publisher to file the Edition under.
    name: "packaging with unknown coverage and no imprint, Bootstrap Mode",
    bootstrap: true,
    book: {
      ...packaged("Gamma Quest Deluxe Edition 2", { lineName: "Deluxe Edition", linePosition: "2", coverRange: null }),
      noImprint: true,
    },
    seed: (ctx) => gammaQuest(ctx),
  },
  {
    // The hidden work found by the source's series key, not by title.
    name: "Series hidden under another title, linked by the source's series key",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Old Name", publicId: 1, status: "hidden" });
      for (const sourceKey of ["sevenseas", "kodansha"]) {
        await linkSeriesObservation(ctx, { sourceKey, seriesKey: SLUG, title: SERIES, seriesId, now: Date.now() });
      }
    },
  },
  {
    // A hidden Series of the same title from another house is not this work.
    name: "Series of the work's title hidden, from another house",
    bootstrap: false,
    book: volume3,
    seed: async (ctx) => {
      await insertPublisher(ctx, { name: "Seven Seas Entertainment", slug: "seven-seas" });
      await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
      await insertPublisher(ctx, { name: "Gamma Comics", slug: "gamma-comics" });
      await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
      const publisherId = await insertPublisher(ctx, { name: "Other House", slug: "other-house" });
      const seriesId = await insertSeries(ctx, { title: SERIES, publicId: 1, status: "hidden" });
      const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
    },
  },
];

/** A book the ladder matches to a Release, which never reaches the tail. */
const MATCHED: Case = {
  name: "ISBN on an active Release of the book's Series",
  bootstrap: false,
  book: volume3,
  seed: (ctx) => isbnHolder(ctx, SERIES, "active"),
};

describe("the unmatched-placement tail, through every source", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const outcomes: Partial<Record<Source, Outcome>> = {};
      for (const source of SOURCES) outcomes[source] = await outcome(c, source);
      expect(outcomes).toEqual(EXPECTED[c.name]);
    });
  }
});

/** Documents the first and the second run of the case's book read, through one source. */
async function documentsRead(c: Case, source: Source): Promise<[number, number]> {
  const t = makeT();
  tickingClock();
  await seedRegistry(t, c.bootstrap);
  if (c.seed) await t.run(c.seed);
  // Nested, so the reads are the apply mutation's own.
  const run = () =>
    t.run(async (ctx) => {
      const used = async () => (await ctx.meta.getTransactionMetrics()).documentsRead.used;
      const before = await used();
      await apply(ctx.runMutation, source, c.book);
      return (await used()) - before;
    });
  const first = await run();
  if (c.between) await t.run(c.between);
  return [first, await run()];
}

/**
 * Documents read by the first and the second run, for the paths that hold
 * or queue before the tail's Bootstrap Mode check (Kodansha read it only at
 * its creation gate; Seven Seas and the catalog feeds for every unmatched
 * book, the catalog feeds for a matched one too), and for a matched book.
 */
const READS: Record<string, Record<Source, [number, number]>> = {
  "Series missing, steady state: the queued Proposal": {
    sevenSeas: [5, 5],
    kodansha: [5, 6],
    prh: [5, 7],
    yenPress: [5, 7],
  },
  "ISBN on an active Release of another Series": {
    sevenSeas: [15, 10],
    kodansha: [16, 12],
    prh: [12, 11],
    yenPress: [12, 10],
  },
  "ambiguous Series title, steady state": {
    sevenSeas: [17, 17],
    kodansha: [16, 17],
    prh: [17, 18],
    yenPress: [17, 18],
  },
  "packaging with unknown coverage, steady state": {
    sevenSeas: [11, 9],
    kodansha: [10, 9],
    prh: [7, 8],
    yenPress: [7, 8],
  },
  "packaging with unknown coverage, Bootstrap Mode": {
    sevenSeas: [17, 4],
    kodansha: [10, 9],
    prh: [12, 4],
    yenPress: [12, 4],
  },
  "ISBN on an active Release of the book's Series": {
    sevenSeas: [20, 4],
    kodansha: [24, 6],
    prh: [15, 4],
    yenPress: [15, 4],
  },
};

describe("documents the tail's runs read, through every source", () => {
  for (const [name, expected] of Object.entries(READS)) {
    it(name, async () => {
      const c = [...CASES, MATCHED].find((each) => each.name === name)!;
      const reads: Partial<Record<Source, [number, number]>> = {};
      for (const source of SOURCES) reads[source] = await documentsRead(c, source);
      expect(reads).toEqual(expected);
    });
  }
});

// ---------- what each case does today ----------

/** What a source is called, the publisher it files books under, and whether it keeps series links. */
type Identity = { name: string; publisher: string; linksSeries: boolean };

const IDENTITY: Record<Source, Identity> = {
  sevenSeas: { name: "Seven Seas Entertainment", publisher: "seven-seas", linksSeries: true },
  kodansha: { name: "Kodansha USA", publisher: "kodansha", linksSeries: true },
  prh: { name: "Penguin Random House API", publisher: "gamma-comics", linksSeries: false },
  yenPress: { name: "Yen Press", publisher: "yen-press", linksSeries: false },
};

/** One outcome for every source, with the fields a source changes overridden for it. */
function each(
  template: (s: Identity) => Outcome,
  overrides: Partial<Record<Source, (s: Identity) => Partial<Outcome>>> = {},
): Record<Source, Outcome> {
  const at = (source: Source) => ({ ...template(IDENTITY[source]), ...overrides[source]?.(IDENTITY[source]) });
  return { sevenSeas: at("sevenSeas"), kodansha: at("kodansha"), prh: at("prh"), yenPress: at("yenPress") };
}

/** The series link a Seven Seas or Kodansha run writes; the catalog-title feeds keep none. */
const link = (s: Identity, series: string) => (s.linksSeries ? series : null);

/** The queued Release op, the same book's in every case. */
const RELEASE_OP = `releases release ${JSON.stringify({
  binding: "Paperback",
  editionId: "edition",
  format: "physical",
  isbn13: ISBN,
  language: "en",
  price: { amountCents: 1299, currency: "USD" },
  pubDate: { day: 12, month: 5, sort: 20260512, year: 2026 },
})}`;

const EXPECTED: Record<string, Record<Source, Outcome>> = {
  "Series missing, Bootstrap Mode: ordinary creation": each((s) => ({
    result: "created, changed, releaseId",
    hold: null,
    created: [
      `coverage of volume 3 of series "Gamma Quest"`,
      `edition of publisher ${s.publisher} (unreviewed)`,
      "proposal approved",
      "proposalVersion",
      `publisher ${s.publisher}`,
      "release 9781999000300 (unreviewed)",
      "revision ×5",
      `series "Gamma Quest" (unreviewed)`,
      `volume 3 of series "Gamma Quest" (unreviewed)`,
    ],
    seriesLink: link(s, `series "Gamma Quest"`),
    proposal: null,
    second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
  "Series missing, steady state: the queued Proposal": each(
    (s) => ({
      result: "queued, changed",
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest Vol. 3" observed at ${s.name} needs a brand-new Series — steady-state creation gate.`,
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      prh: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
      yenPress: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
    },
  ),
  "Series hidden, steady state": each((s) => ({
    result: `recordOnly, unchanged, reason "hidden series"`,
    hold: `series: "Gamma Quest" is Series 1 ("Gamma Quest"), which an Editor hid — not recreated by an import.`,
    created: ["placementHold"],
    seriesLink: null,
    proposal: null,
    second: {
      result: `recordOnly, unchanged, reason "hidden series"`,
      writes: ["~ sourceObservations lastSeenAt"],
    },
  })),
  "Series hidden, Bootstrap Mode": each((s) => ({
    result: `recordOnly, unchanged, reason "hidden series"`,
    hold: `series: "Gamma Quest" is Series 1 ("Gamma Quest"), which an Editor hid — not recreated by an import.`,
    created: ["placementHold"],
    seriesLink: null,
    proposal: null,
    second: {
      result: `recordOnly, unchanged, reason "hidden series"`,
      writes: ["~ sourceObservations lastSeenAt"],
    },
  })),
  "Series merged into another": each((s) => ({
    result: "created, changed, releaseId",
    hold: null,
    created: [
      `coverage of volume 3 of series "Gamma Quest Saga"`,
      `edition of publisher ${s.publisher}`,
      "proposal approved",
      "proposalVersion",
      `publisher ${s.publisher}`,
      "release 9781999000300",
      "revision ×4",
      `volume 3 of series "Gamma Quest Saga"`,
    ],
    seriesLink: link(s, `series "Gamma Quest Saga"`),
    proposal: null,
    second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
  "Series locked": each((s) => ({
    result: "created, changed, releaseId",
    hold: null,
    created: [
      `coverage of volume 3 of series "Gamma Quest"`,
      `edition of publisher ${s.publisher}`,
      "proposal approved",
      "proposalVersion",
      `publisher ${s.publisher}`,
      "release 9781999000300",
      "revision ×4",
      `volume 3 of series "Gamma Quest"`,
    ],
    seriesLink: link(s, `series "Gamma Quest"`),
    proposal: null,
    second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
  "ISBN on an active Release of another Series": each(
    (s) => ({
      result: `needsReview, changed, reason "ISBN 9781999000300 matches an existing release with a dissimilar title"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: {
        comment: "Flagged by the matching ladder (rung 2): ISBN 9781999000300 matches an existing release with a dissimilar title. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.",
        ops: [
          `volumes volume-1 {"label":"3","seriesId":"series \\"Gamma Quest\\""}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "ISBN 9781999000300 matches an existing release with a dissimilar title"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
      yenPress: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
    },
  ),
  "ISBN on two active Releases": each(
    (s) => ({
      result: `needsReview, changed, reason "ISBN 9781999000300 matches 2 distinct active Releases"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: {
        comment: "Flagged by the matching ladder (rung 2): ISBN 9781999000300 matches 2 distinct active Releases. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.",
        ops: [
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume 3 of series \\"Gamma Quest\\""}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "ISBN 9781999000300 matches 2 distinct active Releases"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
      yenPress: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
    },
  ),
  "ISBN on a hidden Release": each(
    (s) => ({
      result: `needsReview, changed, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: "Flagged by the matching ladder (rung 2): ISBN 9781999000300 belongs to a Release an Editor hid. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.",
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
      yenPress: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
    },
  ),
  "ambiguous Series title, steady state": each(
    (s) => ({
      result: `needsReview, changed, reason "2 same-titled Series"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest" matches 2 same-titled Series — the importer never guesses.`,
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "2 same-titled Series"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({
        result: `needsReview, changed, reason "ambiguous series"`,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" matches 2 same-titled Series — the importer never guesses.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: {
          result: `alreadyQueued, unchanged, reason "ambiguous series"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
      yenPress: (s) => ({
        result: `needsReview, changed, reason "ambiguous series"`,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" matches 2 same-titled Series — the importer never guesses.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: {
          result: `alreadyQueued, unchanged, reason "ambiguous series"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "ambiguous Series title, Bootstrap Mode": each(
    (s) => ({
      result: `needsReview, changed, reason "2 same-titled Series"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest" matches 2 same-titled Series — the importer never guesses.`,
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "2 same-titled Series"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({
        result: `needsReview, changed, reason "ambiguous series"`,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" matches 2 same-titled Series — the importer never guesses.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: {
          result: `alreadyQueued, unchanged, reason "ambiguous series"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
      yenPress: (s) => ({
        result: `needsReview, changed, reason "ambiguous series"`,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" matches 2 same-titled Series — the importer never guesses.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: {
          result: `alreadyQueued, unchanged, reason "ambiguous series"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "missing Volume, Bootstrap Mode": each((s) => ({
    result: "created, changed, releaseId",
    hold: null,
    created: [
      `coverage of volume 3 of series "Gamma Quest"`,
      `edition of publisher ${s.publisher}`,
      "proposal approved",
      "proposalVersion",
      `publisher ${s.publisher}`,
      "release 9781999000300",
      "revision ×4",
      `volume 3 of series "Gamma Quest"`,
    ],
    seriesLink: link(s, `series "Gamma Quest"`),
    proposal: null,
    second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
  "missing Volume, steady state": each((s) => ({
    result: "created, changed, releaseId",
    hold: null,
    created: [
      `coverage of volume 3 of series "Gamma Quest"`,
      `edition of publisher ${s.publisher}`,
      "proposal approved",
      "proposalVersion",
      `publisher ${s.publisher}`,
      "release 9781999000300",
      "revision ×4",
      `volume 3 of series "Gamma Quest"`,
    ],
    seriesLink: link(s, `series "Gamma Quest"`),
    proposal: null,
    second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
  "packaging with stated coverage, Bootstrap Mode": each(
    (s) => ({
      result: "created, changed, releaseId",
      hold: null,
      created: [
        `coverage of volume 1 of series "Gamma Quest"`,
        `coverage of volume 2 of series "Gamma Quest"`,
        `coverage of volume 3 of series "Gamma Quest"`,
        `edition of publisher ${s.publisher} in line "Omnibus" 1 (unreviewed)`,
        `line "Omnibus" (unreviewed)`,
        "proposal approved",
        "proposalVersion",
        `publisher ${s.publisher}`,
        "release 9781999000300 (unreviewed)",
        "revision ×5",
        `volume 3 of series "Gamma Quest" (unreviewed)`,
      ],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      kodansha: () => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest Omnibus 1 (Vol. 1-3)" is Omnibus of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with stated coverage, steady state": each(
    (s) => ({
      result: "queued, changed",
      hold: null,
      created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest Omnibus 1 (Vol. 1-3)" observed at ${s.name} needs multi-Volume Coverage and an Edition Line (deluxe/omnibus/box-set packaging) — steady-state creation gate. Edition Line: Omnibus.`,
        ops: [
          `volumes volume-3 {"label":"3","seriesId":"series \\"Gamma Quest\\""}`,
          `editionLines edition-line {"joinExisting":true,"name":"Omnibus","publisherSlug":"${s.publisher}","seriesId":"series \\"Gamma Quest\\""}`,
          `editions edition {"editionLineId":"edition-line","linePosition":"1","publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume 1 of series \\"Gamma Quest\\""},{"extent":"complete","order":2,"volume":"volume 2 of series \\"Gamma Quest\\""},{"extent":"complete","order":3,"volume":"volume-3"}]}`,
          RELEASE_OP,
        ],
      },
      second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      sevenSeas: (s) => ({
        created: ["proposal inReview", "proposalVersion"],
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
      kodansha: (s) => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest Omnibus 1 (Vol. 1-3)" is Omnibus of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        seriesLink: link(s, `series "Gamma Quest"`),
        proposal: null,
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with line-size coverage, Bootstrap Mode": each(
    (s) => ({
      result: "created, changed, releaseId",
      hold: null,
      created: [
        `coverage of volume 4 of series "Gamma Quest"`,
        `coverage of volume 5 of series "Gamma Quest"`,
        `coverage of volume 6 of series "Gamma Quest"`,
        `edition of publisher ${s.publisher} in line "3-in-1 Edition" 2 (unreviewed)`,
        `line "3-in-1 Edition" (unreviewed)`,
        "proposal approved",
        "proposalVersion",
        `publisher ${s.publisher}`,
        "release 9781999000300 (unreviewed)",
        "revision ×7",
        `volume 4 of series "Gamma Quest" (unreviewed)`,
        `volume 5 of series "Gamma Quest" (unreviewed)`,
        `volume 6 of series "Gamma Quest" (unreviewed)`,
      ],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      kodansha: () => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest 3-in-1 Edition Vol. 2" is 3-in-1 Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with line-size coverage, steady state": each(
    (s) => ({
      result: "queued, changed",
      hold: null,
      created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest 3-in-1 Edition Vol. 2" observed at ${s.name} needs multi-Volume Coverage and an Edition Line (deluxe/omnibus/box-set packaging) — steady-state creation gate. Edition Line: 3-in-1 Edition.`,
        ops: [
          `volumes volume-1 {"label":"4","seriesId":"series \\"Gamma Quest\\""}`,
          `volumes volume-2 {"label":"5","seriesId":"series \\"Gamma Quest\\""}`,
          `volumes volume-3 {"label":"6","seriesId":"series \\"Gamma Quest\\""}`,
          `editionLines edition-line {"joinExisting":true,"name":"3-in-1 Edition","publisherSlug":"${s.publisher}","seriesId":"series \\"Gamma Quest\\""}`,
          `editions edition {"editionLineId":"edition-line","linePosition":"2","publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"},{"extent":"complete","order":2,"volume":"volume-2"},{"extent":"complete","order":3,"volume":"volume-3"}]}`,
          RELEASE_OP,
        ],
      },
      second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      sevenSeas: (s) => ({
        created: ["proposal inReview", "proposalVersion"],
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
      kodansha: (s) => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest 3-in-1 Edition Vol. 2" is 3-in-1 Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        seriesLink: link(s, `series "Gamma Quest"`),
        proposal: null,
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with unknown coverage, Bootstrap Mode": each(
    (s) => ({
      result: "created, changed, releaseId",
      hold: null,
      created: [
        `edition of publisher ${s.publisher} in line "Deluxe Edition" 2 (unreviewed) (unmapped)`,
        `line "Deluxe Edition" (unreviewed)`,
        "proposal approved",
        "proposalVersion",
        `publisher ${s.publisher}`,
        "release 9781999000300 (unreviewed)",
        "revision ×4",
      ],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      kodansha: () => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is Deluxe Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with unknown coverage, steady state": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "packaging without coverage"`,
      hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is packaging (Deluxe Edition) whose covered Volumes the title does not state — an Editor maps it.`,
      created: ["placementHold"],
      seriesLink: null,
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: (s) => ({
        hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
      kodansha: (s) => ({
        hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is Deluxe Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
    },
  ),
  "packaging with unknown coverage and no line name, Bootstrap Mode": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "packaging without coverage"`,
      hold: `packaging under series "Gamma Quest": "Gamma Quest Collection" is packaging (multi-volume) whose covered Volumes the title does not state — an Editor maps it.`,
      created: ["placementHold"],
      seriesLink: null,
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: (s) => ({
        hold: `packaging under series "Gamma Quest": "Gamma Quest Collection" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
      kodansha: (s) => ({
        hold: `packaging under series "Gamma Quest": "Gamma Quest Collection" is packaging of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
    },
  ),
  "packaging with unknown coverage, ambiguous Series, Bootstrap Mode": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "packaging without coverage"`,
      hold: `packaging: "Gamma Quest Deluxe Edition 2" is packaging (Deluxe Edition) whose covered Volumes the title does not state — an Editor maps it.`,
      created: ["placementHold"],
      seriesLink: null,
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: () => ({
        hold: `packaging: "Gamma Quest Deluxe Edition 2" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.`,
      }),
      kodansha: () => ({
        hold: `packaging: "Gamma Quest Deluxe Edition 2" is Deluxe Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
      }),
    },
  ),
  "box set, Bootstrap Mode": each(
    (s) => ({
      result: "created, changed",
      hold: null,
      created: [
        `bundle "Gamma Quest Box Set 1" (unreviewed)`,
        "proposal approved",
        "proposalVersion",
        `publisher ${s.publisher}`,
        "revision ×2",
      ],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      kodansha: () => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest Box Set 1" is Box Set of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        created: ["placementHold"],
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "box set, steady state": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "box set"`,
      hold: `packaging under series "Gamma Quest": Box set "Gamma Quest Box Set 1" is a Release Bundle — steady state leaves bundles to review.`,
      created: ["placementHold"],
      seriesLink: null,
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "box set"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: (s) => ({
        hold: `packaging under series "Gamma Quest": Box set "Gamma Quest Box Set 1" becomes a Release Bundle only in Bootstrap Mode, under one base Series, covering the Volumes its title or blurb states — otherwise an Editor places it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
      }),
      kodansha: (s) => ({
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        hold: `packaging under series "Gamma Quest": "Gamma Quest Box Set 1" is Box Set of "Gamma Quest" with no stated coverage — an Editor maps it.`,
        seriesLink: link(s, `series "Gamma Quest"`),
        second: {
          result: `recordOnly, unchanged, reason "packaging without coverage"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with unknown coverage on an ISBN a hidden Release holds": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "packaging without coverage"`,
      hold: `packaging: "Gamma Quest Deluxe Edition 2" is packaging (Deluxe Edition) whose covered Volumes the title does not state — an Editor maps it.`,
      created: ["placementHold"],
      seriesLink: null,
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: () => ({
        hold: `packaging: "Gamma Quest Deluxe Edition 2" is packaging whose covered Volumes neither the title, the blurb, nor the line name states — an Editor maps it.`,
      }),
      kodansha: () => ({
        hold: `packaging: "Gamma Quest Deluxe Edition 2" is Deluxe Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
      }),
    },
  ),
  "ISBN on a hidden Release, ambiguous Series title": each(
    (s) => ({
      result: `needsReview, changed, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: "Flagged by the matching ladder (rung 2): ISBN 9781999000300 belongs to a Release an Editor hid. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.",
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
      yenPress: (s) => ({ created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`] }),
    },
  ),
  "no imprint, ambiguous Series title": each(
    (s) => ({
      result: `needsReview, changed, reason "2 same-titled Series"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest" matches 2 same-titled Series — the importer never guesses.`,
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "2 same-titled Series"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: () => ({
        result: "recordOnly, unchanged",
        created: [],
        proposal: null,
        second: { result: "recordOnly, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
      yenPress: () => ({
        result: "recordOnly, unchanged",
        created: [],
        proposal: null,
        second: { result: "recordOnly, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
    },
  ),
  "no imprint, Series missing, Bootstrap Mode": each(
    (s) => ({
      result: "created, changed, releaseId",
      hold: null,
      created: [
        `coverage of volume 3 of series "Gamma Quest"`,
        `edition of publisher ${s.publisher} (unreviewed)`,
        "proposal approved",
        "proposalVersion",
        `publisher ${s.publisher}`,
        "release 9781999000300 (unreviewed)",
        "revision ×5",
        `series "Gamma Quest" (unreviewed)`,
        `volume 3 of series "Gamma Quest" (unreviewed)`,
      ],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      prh: () => ({
        result: "recordOnly, unchanged",
        created: [],
        second: { result: "recordOnly, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
      yenPress: () => ({
        result: "recordOnly, unchanged",
        created: [],
        second: { result: "recordOnly, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
    },
  ),
  "queued, then an Editor hides a Series of the work's title": each(
    (s) => ({
      result: "queued, changed",
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: `"Gamma Quest Vol. 3" observed at ${s.name} needs a brand-new Series — steady-state creation gate.`,
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
    }),
    {
      prh: (s) => ({
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        second: {
          result: `recordOnly, unchanged, reason "hidden series"`,
          writes: ["~ sourceObservations conflicts, lastSeenAt"],
        },
      }),
      yenPress: (s) => ({
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        second: {
          result: `recordOnly, unchanged, reason "hidden series"`,
          writes: ["~ sourceObservations conflicts, lastSeenAt"],
        },
      }),
    },
  ),
  "no imprint, ISBN on a hidden Release": each(
    (s) => ({
      result: `needsReview, changed, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
      hold: null,
      created: ["proposal inReview", "proposalVersion"],
      seriesLink: null,
      proposal: {
        comment: "Flagged by the matching ladder (rung 2): ISBN 9781999000300 belongs to a Release an Editor hid. Pre-filled creation guess — approve only if this is genuinely a distinct release; the importer never merges.",
        ops: [
          `series series {"altTitles":[],"title":"Gamma Quest"}`,
          `volumes volume-1 {"label":"3","seriesId":"series"}`,
          `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
          RELEASE_OP,
        ],
      },
      second: {
        result: `alreadyQueued, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: () => ({
        result: `needsReview, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
        created: [],
        proposal: null,
        second: {
          result: `needsReview, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
      yenPress: () => ({
        result: `needsReview, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
        created: [],
        proposal: null,
        second: {
          result: `needsReview, unchanged, reason "ISBN 9781999000300 belongs to a Release an Editor hid"`,
          writes: ["~ sourceObservations lastSeenAt"],
        },
      }),
    },
  ),
  "packaging with unknown coverage and no imprint, Bootstrap Mode": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "packaging without coverage"`,
      hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is packaging (Deluxe Edition) whose covered Volumes the title does not state — an Editor maps it.`,
      created: ["placementHold"],
      seriesLink: link(s, `series "Gamma Quest"`),
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "packaging without coverage"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      sevenSeas: (s) => ({
        result: "created, changed, releaseId",
        hold: null,
        created: [
          `edition of publisher ${s.publisher} in line "Deluxe Edition" 2 (unreviewed) (unmapped)`,
          `line "Deluxe Edition" (unreviewed)`,
          "proposal approved",
          "proposalVersion",
          `publisher ${s.publisher}`,
          "release 9781999000300 (unreviewed)",
          "revision ×4",
        ],
        second: { result: "unchanged, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
      kodansha: () => ({
        hold: `packaging under series "Gamma Quest": "Gamma Quest Deluxe Edition 2" is Deluxe Edition of "Gamma Quest" with no stated coverage — an Editor maps it.`,
      }),
    },
  ),
  "Series hidden under another title, linked by the source's series key": each(
    (s) => ({
      result: `recordOnly, unchanged, reason "hidden series"`,
      hold: `series: "Gamma Quest" is Series 1 ("Old Name"), which an Editor hid — not recreated by an import.`,
      created: ["placementHold"],
      seriesLink: link(s, `series "Old Name" hidden`),
      proposal: null,
      second: {
        result: `recordOnly, unchanged, reason "hidden series"`,
        writes: ["~ sourceObservations lastSeenAt"],
      },
    }),
    {
      prh: (s) => ({
        result: "queued, changed",
        hold: null,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" observed at ${s.name} needs a brand-new Series — steady-state creation gate.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
      yenPress: (s) => ({
        result: "queued, changed",
        hold: null,
        created: ["proposal inReview", "proposalVersion", `publisher ${s.publisher}`],
        proposal: {
          comment: `"Gamma Quest Vol. 3" observed at ${s.name} needs a brand-new Series — steady-state creation gate.`,
          ops: [
            `series series {"altTitles":[],"title":"Gamma Quest"}`,
            `volumes volume-1 {"label":"3","seriesId":"series"}`,
            `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
            RELEASE_OP,
          ],
        },
        second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
      }),
    },
  ),
  "Series of the work's title hidden, from another house": each((s) => ({
    result: "queued, changed",
    hold: null,
    created: ["proposal inReview", "proposalVersion"],
    seriesLink: null,
    proposal: {
      comment: `"Gamma Quest Vol. 3" observed at ${s.name} needs a brand-new Series — steady-state creation gate.`,
      ops: [
        `series series {"altTitles":[],"title":"Gamma Quest"}`,
        `volumes volume-1 {"label":"3","seriesId":"series"}`,
        `editions edition {"publisherSlug":"${s.publisher}","volumeCoverage":[{"extent":"complete","order":1,"volume":"volume-1"}]}`,
        RELEASE_OP,
      ],
    },
    second: { result: "alreadyQueued, unchanged", writes: ["~ sourceObservations lastSeenAt"] },
  })),
};
