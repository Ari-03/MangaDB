// What a Release row shows of its Other Printings (lib/releaseIsbns.ts
// otherPrintingsOf: the first recorded, said so when others may remain), and
// the operator's consistency check (printings.consistencyInternal): two
// paged passes that report violations, history and what they could not
// inspect, never a clean result they did not earn.

import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertBundle, insertObservation } from "./test.factories";
import { alice, bob, makeT, seedTeam, type TestT } from "./test.helpers";
import { mergeAs } from "./test.moderation";
import {
  another,
  CURRENT,
  insertPrinting,
  isbn13For,
  OLDER,
  OLDER_10,
  vagabond,
  type Vagabond,
  X,
  Y,
  Z,
} from "./test.printings";

const year = (y: number) => ({ year: y, sort: y * 10000 });

async function editionRow(t: TestT, book: Vagabond) {
  const publicId = (await t.run((ctx) => ctx.db.get(book.editionId)))!.publicId;
  const page = await t.query(api.catalogPages.editionPage, { publicId });
  return page!.releases.find((row) => row.id === book.releaseId)!;
}

describe("the Release row's Other Printings", () => {
  it("shows the first 20 recorded, sorted by date, and says a 21st may remain", async () => {
    const t = makeT();
    const book = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      for (let n = 0; n < 20; n++)
        await insertPrinting(ctx, book.releaseId, isbn13For(n), { pubDate: year(2010 + n) });
      // Recorded last, published first: not among the first 20 recorded.
      await insertPrinting(ctx, book.releaseId, isbn13For(20), { pubDate: year(1999) });
      return book;
    });
    const row = await editionRow(t, book);
    expect(row.otherPrintings.map((p) => p.year)).toEqual(
      Array.from({ length: 20 }, (_, n) => 2010 + n),
    );
    expect(row.morePrintings).toBe(true);
  });

  it("leaves the Release's own ISBNs out, in any spelling, without losing a printing", async () => {
    const t = makeT();
    const book = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      await ctx.db.patch(book.releaseId, { isbn10: "1421506556" });
      // Rows of its own ISBN-13 (hyphenated, as a legacy row) and ISBN-10.
      await insertPrinting(ctx, book.releaseId, "978-1-4215-1911-1");
      await insertPrinting(ctx, book.releaseId, X);
      for (let n = 0; n < 20; n++) await insertPrinting(ctx, book.releaseId, isbn13For(n));
      return book;
    });
    const row = await editionRow(t, book);
    expect(row.otherPrintings).toHaveLength(20);
    expect(row.otherPrintings.map((p) => p.isbn13)).not.toContain(X);
    // 22 rows read, none more: the list is whole.
    expect(row.morePrintings).toBe(false);
  });

  it("orders undated printings last, ties as recorded, and stays conservative over repeated own rows", async () => {
    const t = makeT();
    const book = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      await insertPrinting(ctx, book.releaseId, Y);
      await insertPrinting(ctx, book.releaseId, OLDER, { pubDate: year(2002) });
      await insertPrinting(ctx, book.releaseId, X, { pubDate: year(2002) });
      return book;
    });
    expect((await editionRow(t, book)).otherPrintings).toEqual([
      { isbn13: OLDER, year: 2002 },
      { isbn13: X, year: 2002 },
      { isbn13: Y, year: null },
    ]);
    // Three more rows of its own ISBN fill the extra rows read: it cannot
    // say the list is whole.
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) await insertPrinting(ctx, book.releaseId, CURRENT);
    });
    expect((await editionRow(t, book)).morePrintings).toBe(true);
  });

  it("shows a merge's combined list as the first 20 recorded", async () => {
    const t = makeT();
    await seedTeam(t, [alice, bob]);
    const { book, loser } = await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const loser = await another(ctx, book, { isbn13: "9781421599991" });
      for (let n = 0; n < 12; n++) await insertPrinting(ctx, book.releaseId, isbn13For(n));
      for (let n = 12; n < 25; n++) await insertPrinting(ctx, loser, isbn13For(n));
      return { book, loser };
    });
    await mergeAs(t, { type: "release", id: book.releaseId }, { type: "release", id: loser });
    const row = await editionRow(t, book);
    expect(row.otherPrintings).toHaveLength(20);
    expect(row.morePrintings).toBe(true);
  });
});

type Finding = { severity: string; message: string; isbn13?: string };
type Pass = "rows" | "observations" | "releases" | "bundles";

/** Walk one pass to the end, a page of `numItems` at a time. */
async function walk(t: TestT, pass: Pass, numItems = 1) {
  const findings: Finding[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 1000; pages++) {
    const page: { findings: Finding[]; isDone: boolean; continueCursor: string } = await t.query(
      internal.printings.consistencyInternal,
      { pass, paginationOpts: { numItems, cursor } },
    );
    findings.push(...page.findings);
    if (page.isDone) return findings;
    cursor = page.continueCursor;
  }
  throw new Error("the pass never finished");
}

const marked = (releaseId: Id<"releases"> | undefined, mark: string, id: string) => ({
  sourceKey: "openlibrary",
  sourceRecordId: id,
  ...(releaseId !== undefined ? { recordRef: { type: "release" as const, id: releaseId } } : {}),
  printingIsbn13: mark,
});

describe("the consistency check", () => {
  it("finds nothing wrong in a promoted printing, a sticky mark, or a link to a merged Release", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const record = await insertObservation(ctx, marked(book.releaseId, CURRENT, "/books/OL1M"));
      // A printing the Release took as its own keeps its row and its record's mark.
      await insertPrinting(ctx, book.releaseId, CURRENT, { observationId: record });
      // A record still linked to a Release merged into the owner.
      const merged = await another(ctx, book, { status: "merged", mergedIntoId: book.releaseId });
      await insertPrinting(ctx, book.releaseId, OLDER);
      await insertObservation(ctx, marked(merged, OLDER, "/books/OL2M"));
    });
    expect(await walk(t, "rows")).toEqual([]);
    expect(await walk(t, "observations")).toEqual([]);
  });

  it("reports each kind of broken ownership as a violation", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      const other = await another(ctx, book, { isbn13: Y });
      // Marked X on the Release, but X is another's printing.
      await insertPrinting(ctx, other, X);
      await insertObservation(ctx, marked(book.releaseId, X, "/books/OL1M"));
      // A Bundle claims a printing's ISBN.
      await insertPrinting(ctx, book.releaseId, OLDER);
      await insertBundle(ctx, { publisherId: book.publisherId, isbn13: OLDER });
      // A mark that is no ISBN; a link nobody can follow; two primaries, no row.
      await insertObservation(ctx, marked(book.releaseId, "978-junk", "/books/OL2M"));
      const gone = await another(ctx, book);
      await ctx.db.delete(gone);
      await insertObservation(ctx, marked(gone, OLDER, "/books/OL3M"));
      const pointerless = await another(ctx, book, { status: "merged" });
      await insertObservation(ctx, marked(pointerless, OLDER, "/books/OL4M"));
      await another(ctx, book, { isbn13: "9781974700011" });
      await another(ctx, book, { isbn13: "9781974700011" });
      await insertObservation(ctx, marked(book.releaseId, "9781974700011", "/books/OL5M"));
      // A printing of a digital Release.
      const digital = await another(ctx, book, { format: "digital" });
      await insertPrinting(ctx, digital, "9798888772584");
    });
    const rows = await walk(t, "rows");
    expect(rows).toEqual([
      expect.objectContaining({
        severity: "violation",
        isbn13: OLDER,
        message: expect.stringContaining("Release Bundle"),
      }),
      expect.objectContaining({
        severity: "violation",
        message: expect.stringContaining("is not physical"),
      }),
    ]);
    const marks = await walk(t, "observations");
    expect(marks.map((f) => [f.severity, f.message.replace(/\b[0-9a-z]{32}\b/g, "ID")])).toEqual([
      ["violation", `It is marked ISBN ${X}, which Release ID owns, but links Release ID.`],
      ["violation", 'Its mark "978-junk" is no valid ISBN.'],
      ["violation", expect.stringContaining("no longer exists")],
      ["violation", expect.stringContaining("merged into nothing")],
      ["violation", "ISBN 9781974700011 is claimed by 2 records: ID, ID."],
    ]);
  });

  it("reports history as diagnostics, and what it could not read as incomplete", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      // An orphan mark; a mark nobody claims; a row whose record moved on.
      await insertObservation(ctx, marked(undefined, OLDER, "/books/OL1M"));
      await insertObservation(ctx, marked(book.releaseId, Y, "/books/OL2M"));
      const elsewhere = await insertObservation(
        ctx,
        marked(await another(ctx, book), X, "/books/OL3M"),
      );
      await insertPrinting(ctx, book.releaseId, OLDER, { observationId: elsewhere });
      // More claims than one read takes, all of them the Release's own.
      for (let i = 0; i <= 20; i++) await insertPrinting(ctx, book.releaseId, X);
    });
    const rows = await walk(t, "rows", 5);
    expect(rows.filter((f) => f.severity === "diagnostic")).toEqual([
      expect.objectContaining({
        isbn13: OLDER,
        message: expect.stringContaining("now links Release"),
      }),
    ]);
    expect(rows.filter((f) => f.severity === "incomplete")).toHaveLength(21);
    const marks = await walk(t, "observations", 5);
    expect(marks.map((f) => [f.severity, f.isbn13])).toEqual([
      ["diagnostic", OLDER],
      ["diagnostic", Y],
      ["incomplete", X],
    ]);
  });

  it("refuses pages larger than it inspects or reads, before reading", async () => {
    const t = makeT({ transactionLimits: true });
    await expect(
      t.query(internal.printings.consistencyInternal, {
        pass: "rows",
        paginationOpts: { numItems: 101, cursor: null },
      }),
    ).rejects.toThrow(/A page inspects 1 to 100 items/);
    await expect(
      t.query(internal.printings.consistencyInternal, {
        pass: "observations",
        paginationOpts: { numItems: 10, cursor: null, maximumBytesRead: 8 * 1024 * 1024 },
      }),
    ).rejects.toThrow(/A page reads at most 4194304 bytes/);
  });
});

describe("the consistency check under the platform's own limits (C67-02, C67-04)", () => {
  // Default transaction limits: every page ends in an answer, never the
  // platform's abort, and nothing it read goes unaccounted.
  const big = (n: number) => "x".repeat(n);
  type Page = {
    findings: Array<Finding & { rowId?: string; observationId?: string }>;
    scanned: number;
    inspected: number;
    isDone: boolean;
    continueCursor: string;
  };
  const page = (
    t: TestT,
    pass: Pass,
    paginationOpts: {
      numItems: number;
      cursor: string | null;
      maximumBytesRead?: number;
      maximumRowsRead?: number;
    },
  ): Promise<Page> => t.query(internal.printings.consistencyInternal, { pass, paginationOpts });

  it("stops a page of large records early and goes on by its cursor, whatever numItems asks", async () => {
    const t = makeT({ transactionLimits: true });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++)
      ids.push(
        await t.run((ctx) =>
          insertObservation(ctx, {
            sourceKey: "ann",
            sourceRecordId: `root:${i}`,
            snapshot: { payload: big(850_000) },
          }),
        ),
      );
    for (const numItems of [100, 1]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 40; n++) {
        const result: Page = await page(t, "observations", { numItems, cursor });
        expect(result.findings).toEqual([]);
        expect(result.inspected).toBe(result.scanned);
        expect(result.scanned).toBeLessThanOrEqual(Math.min(numItems, 5));
        seen.push(
          ...Array(result.scanned)
            .fill(0)
            .map((_, k) => `${n}:${k}`),
        );
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
      expect(seen).toHaveLength(20);
    }
    // A caller's own limits are kept: a smaller byte budget, or a row budget.
    expect(
      (await page(t, "observations", { numItems: 100, cursor: null, maximumBytesRead: 1 })).scanned,
    ).toBe(1);
    expect(
      (await page(t, "observations", { numItems: 100, cursor: null, maximumRowsRead: 2 })).scanned,
    ).toBe(2);
  });

  it("does the same for large printing rows", async () => {
    const t = makeT({ transactionLimits: true });
    await t.run(vagabond);
    const book = await t.run(async (ctx) => (await ctx.db.query("releases").first())!);
    for (let i = 0; i < 20; i++)
      await t.run((ctx) => insertPrinting(ctx, book._id, isbn13For(i), { reason: big(850_000) }));
    expect(await walk(t, "rows", 100)).toEqual([]);
  });

  it("reports a row whose claims are too large to read as incomplete, by ID, never clean", async () => {
    const t = makeT({ transactionLimits: true });
    const book = await t.run(vagabond);
    const rowId = await t.run((ctx) => insertPrinting(ctx, book.releaseId, OLDER));
    for (let i = 0; i < 20; i++)
      await t.run((ctx) =>
        another(ctx, book, {
          isbn13: OLDER,
          status: "merged",
          mergedIntoId: book.releaseId,
          description: big(850_000),
        }),
      );
    const result = await page(t, "rows", { numItems: 1, cursor: null });
    expect(result.inspected).toBe(0);
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "incomplete",
        rowId,
        message: expect.stringContaining("Read but not inspected"),
      }),
    ]);
  });

  /** `keys` printing rows on the Release, each claimed by 20 merged Releases reaching it through `chain`. */
  async function chained(t: TestT, keys: number, shared: boolean, description?: string) {
    const book = await t.run(vagabond);
    const chainTo = async (): Promise<Id<"releases">> => {
      let chain = book.releaseId;
      for (let i = 0; i < 7; i++)
        chain = await t.run((ctx) =>
          another(ctx, book, {
            status: "merged",
            mergedIntoId: chain,
            ...(description ? { description } : {}),
          }),
        );
      return chain;
    };
    const sharedChain = shared ? await chainTo() : undefined;
    for (let k = 0; k < keys; k++) {
      const isbn = isbn13For(k);
      await t.run((ctx) => insertPrinting(ctx, book.releaseId, isbn));
      for (let i = 0; i < 20; i++) {
        const into = sharedChain ?? (await chainTo());
        await t.run((ctx) =>
          another(ctx, book, { isbn13: isbn, status: "merged", mergedIntoId: into }),
        );
      }
    }
    return book;
  }

  it("follows merge chains that share a tail once, and finds 24 rows of 20 eight-hop claims clean", async () => {
    const t = makeT({ transactionLimits: true });
    await chained(t, 24, true);
    const result = await page(t, "rows", { numItems: 100, cursor: null });
    expect(result).toMatchObject({ findings: [], scanned: 24, inspected: 24, isDone: true });
  });

  it("reports rows whose distinct chains the transaction cannot afford as incomplete", async () => {
    const t = makeT({ transactionLimits: true });
    await chained(t, 1, false, big(150_000));
    const result = await page(t, "rows", { numItems: 100, cursor: null });
    expect(result.inspected).toBe(0);
    expect(result.findings).toEqual([expect.objectContaining({ severity: "incomplete" })]);
  });
});

describe("a stored ISBN no exact read finds (C67-05, C67-14)", () => {
  it("counts a row stored in another spelling as a claim: two owners are a violation, never clean", async () => {
    for (const spelling of ["978-1-59116-034-2", OLDER_10, "1-59116-034-0"]) {
      const t = makeT();
      const rowId = await t.run(async (ctx) => {
        const book = await vagabond(ctx);
        await another(ctx, book, { isbn13: OLDER });
        return await insertPrinting(ctx, book.releaseId, spelling);
      });
      const rows = await walk(t, "rows");
      expect(
        rows.map((f) => [f.severity, f.message.replace(/\b[0-9a-zA-Z]{24,}\b/g, "ID")]),
      ).toEqual([
        [
          "violation",
          `Row ID stores its ISBN as "${spelling}", which no ownership check reads (they read ${OLDER}): store it so.`,
        ],
        ["violation", `ISBN ${OLDER} is claimed by 2 records: ID, ID.`],
      ]);
      expect(rows.every((f) => !("rowId" in f) || f.rowId === rowId)).toBe(true);
    }
  });

  it("still reports the spelling of a row with one owner, and nothing for a canonical one or an invalid one's owner", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      await insertPrinting(ctx, book.releaseId, "978-1-59116-034-2");
      await insertPrinting(ctx, book.releaseId, Y);
      await insertPrinting(ctx, book.releaseId, "9781591160343");
    });
    expect(
      (await walk(t, "rows")).map((f) => [
        f.severity,
        f.message.replace(/\b[0-9a-zA-Z]{24,}\b/g, "ID"),
      ]),
    ).toEqual([
      [
        "violation",
        `Row ID stores its ISBN as "978-1-59116-034-2", which no ownership check reads (they read ${OLDER}): store it so.`,
      ],
      ["violation", 'Row ID\'s ISBN "9781591160343" is no valid ISBN.'],
    ]);
  });

  it("finds every Release and Bundle ISBN stored where no exact read finds it", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const book = await vagabond(ctx);
      await another(ctx, book, { isbn13: "978-1-59116-034-2" });
      await another(ctx, book, { isbn13: OLDER_10 });
      await another(ctx, book, { isbn13: "9780804429573", isbn10: "080442957x" });
      await another(ctx, book, { isbn13: Y, isbn10: Y });
      await another(ctx, book, { isbn13: "9781591160343" });
      await insertBundle(ctx, { publisherId: book.publisherId, isbn13: "979 8888772584" });
      await insertBundle(ctx, {
        publisherId: book.publisherId,
        isbn13: Z,
        isbn10: "9798888772584",
      });
    });
    const releases = await walk(t, "releases");
    expect(
      releases.map((f) => [f.severity, f.isbn13, f.message.match(/stores its (\w+)/)?.[1]]),
    ).toEqual([
      ["violation", OLDER, "isbn13"],
      ["violation", OLDER, "isbn13"],
      ["violation", "9780804429573", "isbn10"],
      ["violation", Y, "isbn10"],
    ]);
    const bundles = await walk(t, "bundles", 5);
    expect(
      bundles.map((f) => [f.severity, f.isbn13, f.message.match(/stores its (\w+)/)?.[1]]),
    ).toEqual([
      ["violation", "9798888772584", "isbn13"],
      ["violation", "9798888772584", "isbn10"],
    ]);
    expect(bundles[1]?.message).toContain("no ISBN-10 for a 979 ISBN");
  });
});
