// What a decided printing must be (printings.ts contentRefusal): one whole
// Volume of the Release's own work, read from each statement its record
// makes, with nothing saying packaging, prose or another language, and a
// Release whose Edition collects exactly that Volume. Every case goes through
// the real decision and checks what it wrote, or that a refusal wrote nothing.

import { describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { recordUnplaced } from "./lib/observations";
import { parseEditionJson } from "./lib/openLibrary";
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
import { makeT, seedRegistry, type TestT } from "./test.helpers";
import { catalogState, decide, holdFor, insertPrinting, OLDER } from "./test.printings";

const PUBLISHERS = {
  ann: { name: "VIZ Media", slug: "viz-media" },
  openlibrary: { name: "VIZ Media", slug: "viz-media" },
  sevenseas: { name: "Seven Seas Entertainment", slug: "seven-seas-entertainment" },
  yenpress: { name: "Yen Press", slug: "yen-press" },
  kodansha: { name: "Kodansha", slug: "kodansha" },
} as const;
type Source = keyof typeof PUBLISHERS;

/**
 * A Release of one Volume (or what `edition` says) of Series `title`, by the
 * source's publisher, and a record of `snapshot` held for it.
 */
async function setup(
  t: TestT,
  source: Source,
  snapshot: Record<string, unknown>,
  target: {
    title?: string;
    label?: string;
    edition?: (
      ctx: MutationCtx,
      ids: { seriesId: Id<"series">; publisherId: Id<"publishers"> },
    ) => Promise<Id<"editions">>;
  } = {},
) {
  await seedRegistry(t);
  return await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, PUBLISHERS[source]);
    const seriesId = await insertSeries(ctx, { title: target.title ?? "Vagabond" });
    let editionId: Id<"editions">;
    if (target.edition) editionId = await target.edition(ctx, { seriesId, publisherId });
    else {
      const volumeId = await insertVolume(ctx, {
        seriesId,
        position: 1,
        label: target.label ?? "1",
      });
      editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
    }
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: "9781421519111",
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: source,
      sourceRecordId: `${source}:1`,
      snapshot: { url: "https://example.com/book", isbn13: OLDER, format: "physical", ...snapshot },
    });
    await recordUnplaced(
      ctx,
      (await ctx.db.get(observationId))!,
      { kind: "isbn", reason: "Held.", seriesId },
      Date.now(),
    );
    return { releaseId, observationId, seriesId, publisherId };
  });
}

/** An ANN line with its page read, as the page pass stores it. */
const annLine = (
  title: string,
  label: string | undefined,
  page: Record<string, unknown> = {},
  line: Partial<Record<string, unknown>> = {},
) => ({
  kind: "annRelease",
  annId: "1",
  mangaId: "88",
  title,
  ...(label !== undefined ? { label } : {}),
  multi: false,
  editionLineHint: false,
  ...line,
  page: { status: "ok", fetchedAt: 1, distributor: "VIZ Media", isbn13: OLDER, ...page },
});

const olEdition = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: "olEdition",
  title,
  publishers: ["VIZ Media"],
  ...extra,
});

async function expectRefused(
  t: TestT,
  ids: { releaseId: Id<"releases">; observationId: Id<"sourceObservations"> },
  reason: RegExp,
) {
  const before = await catalogState(t);
  expect(await decide(t, ids.observationId, ids.releaseId)).toEqual({
    status: "refused",
    reason: expect.stringMatching(reason),
  });
  expect(await catalogState(t)).toEqual(before);
  expect(await holdFor(t, ids.observationId)).not.toBeNull();
}

async function expectRecorded(
  t: TestT,
  ids: { releaseId: Id<"releases">; observationId: Id<"sourceObservations"> },
) {
  expect(await decide(t, ids.observationId, ids.releaseId)).toEqual({
    status: "recorded",
    isbn13: OLDER,
  });
  expect(await t.run(async (ctx) => (await ctx.db.get(ids.observationId))?.printingIsbn13)).toBe(
    OLDER,
  );
}

describe("ANN lines are read statement by statement", () => {
  it("records a plain line whose designator, title and page agree", async () => {
    const t = makeT();
    await expectRecorded(
      t,
      await setup(
        t,
        "ann",
        annLine("Vagabond", "1", { volume: "GN 1", title: "Vagabond", mangaId: "88" }),
      ),
    );
  });

  it("records a line whose page states nothing more (missing statements are unknown)", async () => {
    const t = makeT();
    await expectRecorded(t, await setup(t, "ann", annLine("Vagabond", "01")));
  });

  it("refuses packaging whatever the stored flags say", async () => {
    for (const [line, reason] of [
      // A legacy snapshot: VIZBIG in the title, every stored flag false (the
      // line name is read from the title whatever the flags say).
      [
        annLine("Vagabond [VIZBIG Edition]", "1", { volume: "GN 1" }),
        /reads as packaging \(the line name VIZBIG Edition/,
      ],
      // A stored packaging flag today's reading does not repeat is not cleared:
      // the statements disagree. And with no page read at all.
      [
        annLine("Vagabond [VIZBIG Edition]", "1", { volume: "GN 1" }, { editionLineHint: true }),
        /cannot be read as one book: .*now reads packaging false, the stored line true/,
      ],
      [annLine("Vagabond [VIZBIG Edition]", "1"), /reads as packaging.*VIZBIG/],
      [
        annLine(
          "Vagabond",
          undefined,
          { volume: "GN 1-3" },
          { multi: true, coverRange: { from: "1", to: "3" } },
        ),
        /reads as packaging.*range/,
      ],
      [annLine("Vagabond [1st Ed]", "1", { volume: "GN 1" }), /reads as packaging.*bracketed/],
      // The page's own title states packaging the line's does not.
      [
        annLine("Vagabond", "1", { volume: "GN 1", title: "Vagabond [VIZBIG Edition]" }),
        /reads as packaging.*page title/,
      ],
    ] as const) {
      const t = makeT();
      await expectRefused(t, await setup(t, "ann", line), reason);
    }
  });

  it("refuses statements that disagree, or a designator that no longer reads", async () => {
    for (const [line, reason] of [
      [annLine("Vagabond", "1", { volume: "GN 1, 3" }), /designator "GN 1, 3" now reads/],
      [annLine("Vagabond", "1", { volume: "Junk" }), /designator "Junk" does not read as one book/],
      [annLine("Vagabond", "1", { volume: "GN 2" }), /now reads Volume 2, the stored line 1/],
      [
        annLine("Vagabond, Vol. 1", "2", { volume: "GN 2" }),
        /the stored line says Volume 2, its title "Vagabond, Vol. 1" Volume 1/,
      ],
      [
        annLine("Citrus", "1", { volume: "GN 1", title: "Citrus+" }),
        /page is titled "Citrus\+", the line "Citrus"/,
      ],
      [
        annLine("Vagabond", "1", { volume: "GN 1", mangaId: "99" }),
        /page belongs to manga 99, the line to 88/,
      ],
    ] as const) {
      const t = makeT();
      await expectRefused(
        t,
        await setup(t, "ann", line, { title: line.title === "Citrus" ? "Citrus" : "Vagabond" }),
        reason,
      );
    }
  });

  it("refuses another work, a novel, and another language", async () => {
    for (const [line, title, reason] of [
      [
        annLine("Citrus+", "1", { volume: "GN 1" }),
        "Citrus",
        /work "Citrus\+" is not the Release's Series \("Citrus"\)/,
      ],
      [
        annLine("Kingdom Hearts II", "1", { volume: "GN 1" }),
        "Kingdom Hearts",
        /work "Kingdom Hearts II" is not/,
      ],
      [
        annLine("Vagabond (Light Novel)", "1", { volume: "GN 1" }),
        "Vagabond",
        /outside the catalog: .*novel/,
      ],
    ] as const) {
      const t = makeT();
      await expectRefused(t, await setup(t, "ann", line, { title }), reason);
    }
  });

  it("records Kingdom Hearts II's own Volume 1 under Kingdom Hearts II", async () => {
    const t = makeT();
    await expectRecorded(
      t,
      await setup(t, "ann", annLine("Kingdom Hearts II", "1", { volume: "GN 1" }), {
        title: "Kingdom Hearts II",
      }),
    );
  });
});

describe("other sources' records", () => {
  it("refuses a trailing number with no Volume marker, and records an explicit one", async () => {
    const plain = makeT();
    await expectRefused(
      plain,
      await setup(plain, "openlibrary", olEdition("Kingdom Hearts II"), {
        title: "Kingdom Hearts",
        label: "2",
      }),
      /ends in a number that may be the work's own/,
    );
    for (const [title, series, label] of [
      ["Kingdom Hearts II, Vol. 1", "Kingdom Hearts II", "1"],
      ["Alpha 2, Vol. 1", "Alpha 2", "1"],
      ["Vagabond, Vol. 2", "Vagabond", "2"],
      ["21st Century Boys, Vol. 1", "21st Century Boys", "1"],
    ] as const) {
      const t = makeT();
      await expectRecorded(
        t,
        await setup(t, "openlibrary", olEdition(title), { title: series, label }),
      );
    }
  });

  it("refuses stored statements that disagree with the title, and stored packaging", async () => {
    for (const [extra, reason] of [
      [
        { volumeLabel: "2" },
        /its title "Vagabond, Vol. 1" says Volume 1, its stored reading Volume 2/,
      ],
      [{ multiVolume: true }, /stored multi-volume flag/],
      [
        { packaging: { lineName: "Omnibus", linePosition: "1", coverRange: null } },
        /stored packaging/,
      ],
    ] as const) {
      const t = makeT();
      await expectRefused(
        t,
        await setup(t, "openlibrary", olEdition("Vagabond, Vol. 1", extra)),
        reason,
      );
    }
  });

  it("refuses what a source files outside manga, whatever the title says", async () => {
    for (const [source, snapshot, reason] of [
      [
        "sevenseas",
        { title: "Vagabond Vol. 1", category: "Light Novel" },
        /Seven Seas files it as Light Novel/,
      ],
      [
        "yenpress",
        { title: "Vagabond, Vol. 1", category: "light-novels", imprint: "Yen Press" },
        /Yen Press files it as light-novels/,
      ],
      ["kodansha", { title: "Vagabond 1", outOfScope: "novel" }, /out of scope \(novel\)/],
    ] as const) {
      const t = makeT();
      await expectRefused(t, await setup(t, source, snapshot), reason);
    }
    const manga = makeT();
    await expectRecorded(
      manga,
      await setup(manga, "sevenseas", { title: "Vagabond Vol. 1", category: "Manga" }),
    );
  });

  it("refuses an existing printing's further record that contradicts it, leaving it held", async () => {
    const t = makeT();
    const ids = await setup(t, "sevenseas", { title: "Vagabond Vol. 1", category: "Light Novel" });
    await t.run((ctx) => insertPrinting(ctx, ids.releaseId, OLDER));
    await expectRefused(t, ids, /Seven Seas files it as Light Novel/);
  });
});

describe("the Release's own contents", () => {
  const lineMember =
    (labels: string[], extent: Doc<"volumeCoverages">["extent"] = "complete") =>
    async (
      ctx: MutationCtx,
      { seriesId, publisherId }: { seriesId: Id<"series">; publisherId: Id<"publishers"> },
    ) => {
      const editionLineId = await insertEditionLine(ctx, {
        seriesId,
        publisherId,
        name: "Collector's Edition",
      });
      const editionId = await insertEdition(ctx, { publisherId, editionLineId, linePosition: "1" });
      for (const [i, label] of labels.entries()) {
        const volumeId = await insertVolume(ctx, { seriesId, position: Number(label), label });
        await insertCoverage(ctx, { editionId, volumeId, order: i + 1, extent });
      }
      return editionId;
    };

  it("records a plain Volume against a line member holding that one Volume", async () => {
    const t = makeT();
    await expectRecorded(
      t,
      await setup(t, "openlibrary", olEdition("Vagabond, Vol. 3"), { edition: lineMember(["3"]) }),
    );
  });

  it("refuses another Volume, several Volumes, a part, an unmapped Edition, or another Series' Volume", async () => {
    for (const [edition, title, reason] of [
      [lineMember(["2"]), "Vagabond, Vol. 3", /is Volume 3; the Release is Volume 2/],
      [
        lineMember(["1", "2", "3"]),
        "Vagabond, Vol. 1",
        /does not collect exactly one whole Volume/,
      ],
      [
        lineMember(["1"], "partial"),
        "Vagabond, Vol. 1",
        /does not collect exactly one whole Volume/,
      ],
      [
        async (ctx: MutationCtx, { publisherId }: { publisherId: Id<"publishers"> }) =>
          await insertEdition(ctx, { publisherId, coverageUnmapped: true }),
        "Vagabond, Vol. 1",
        /does not say what it collects/,
      ],
      [
        async (ctx: MutationCtx, { publisherId }: { publisherId: Id<"publishers"> }) => {
          const other = await insertSeries(ctx, { title: "Vagabond Side Stories" });
          const volumeId = await insertVolume(ctx, { seriesId: other, position: 1 });
          const editionId = await insertEdition(ctx, { publisherId });
          await insertCoverage(ctx, { editionId, volumeId });
          return editionId;
        },
        "Vagabond, Vol. 1",
        /is not a Volume of the Release's own Series/,
      ],
    ] as const) {
      const t = makeT();
      await expectRefused(t, await setup(t, "openlibrary", olEdition(title), { edition }), reason);
    }
  });

  it("records nothing for a work named like packaging until packaged printings can be compared", async () => {
    const t = makeT();
    await expectRefused(
      t,
      await setup(t, "openlibrary", olEdition("Makunouchi Deluxe, Vol. 1"), {
        title: "Makunouchi Deluxe",
      }),
      /reads as packaging/,
    );
  });
});

describe("each statement, on both branches: recorded and linked (C67-06 to C67-09, C67-13)", () => {
  type Ids = Awaited<ReturnType<typeof setup>>;

  /**
   * The decision on `make`'s fixture with no row yet (`recorded`) and with
   * the row already recorded on the Release (`linked`): accepted on both,
   * or refused on both writing nothing.
   */
  async function eachBranch(make: (t: TestT) => Promise<Ids>, expected: RegExp | "accepted") {
    for (const existing of [false, true]) {
      const t = makeT();
      const ids = await make(t);
      if (existing) await t.run((ctx) => insertPrinting(ctx, ids.releaseId, OLDER));
      if (expected === "accepted") {
        expect(await decide(t, ids.observationId, ids.releaseId)).toMatchObject({
          status: existing ? "linked" : "recorded",
          isbn13: OLDER,
        });
        expect(await holdFor(t, ids.observationId)).toBeNull();
      } else await expectRefused(t, ids, expected);
    }
  }
  const volume2 = { label: "2" };

  it("refuses an ANN page title stating another Volume than the line, its designator and the Release (C67-06)", async () => {
    for (const title of ["Vagabond, Vol. 1", "Vagabond (GN 1)"]) {
      await eachBranch(
        (t) => setup(t, "ann", annLine("Vagabond", "2", { volume: "GN 2", title }), volume2),
        /says Volume 2, ANN's page title "Vagabond(, Vol\. 1| \(GN 1\))" Volume 1/,
      );
    }
  });

  it("records an ANN page title stating the same Volume, in any form (C67-06 control)", async () => {
    for (const title of ["Vagabond, Vol. 02", "Vagabond (GN 2)", "Vagabond"]) {
      await eachBranch(
        (t) => setup(t, "ann", annLine("Vagabond", "2", { volume: "GN 2", title }), volume2),
        "accepted",
      );
    }
  });

  it("refuses an ANN record that states no Volume anywhere (C67-08)", async () => {
    await eachBranch(
      (t) => setup(t, "ann", annLine("Vagabond", undefined)),
      /states no Volume anywhere/,
    );
  });

  it("records an ANN record whose Volume only its title or page title states (C67-08 control)", async () => {
    await eachBranch((t) => setup(t, "ann", annLine("Vagabond, Vol. 1", undefined)), "accepted");
    await eachBranch(
      (t) => setup(t, "ann", annLine("Vagabond", undefined, { title: "Vagabond, Vol. 1" })),
      "accepted",
    );
  });

  it("leaves a record of another source stating no Volume to the reviewer, as before", async () => {
    await eachBranch((t) => setup(t, "openlibrary", olEdition("Vagabond")), "accepted");
  });

  /** setup, with the Release's Binding `binding`. */
  const bound = async (t: TestT, snapshot: Record<string, unknown>, binding?: string) => {
    const ids = await setup(t, "openlibrary", snapshot);
    if (binding !== undefined) await t.run((ctx) => ctx.db.patch(ids.releaseId, { binding }));
    return ids;
  };

  it("refuses a record whose stated Binding is not the Release's, either way round (C67-09)", async () => {
    await eachBranch(
      (t) => bound(t, olEdition("Vagabond, Vol. 1", { binding: "hardcover" }), "paperback"),
      /is a hardcover book; the Release is paperback/,
    );
    await eachBranch(
      (t) => bound(t, olEdition("Vagabond, Vol. 1", { binding: "paperback" }), "Hardcover"),
      /is a paperback book; the Release is hardcover/,
    );
    const parsed = parseEditionJson({
      key: "/books/OL9M",
      title: "Vagabond, Vol. 1",
      isbn_13: [OLDER],
      publishers: ["VIZ Media"],
      physical_format: "Hardcover",
    })!;
    expect(parsed.binding).toBe("hardcover");
    await eachBranch((t) => bound(t, parsed, "paperback"), /is a hardcover book/);
  });

  it("records the same Binding, or one either side leaves unknown (C67-09 controls)", async () => {
    await eachBranch(
      (t) => bound(t, olEdition("Vagabond, Vol. 1", { binding: "hardcover" }), "hardcover"),
      "accepted",
    );
    await eachBranch(
      (t) => bound(t, olEdition("Vagabond, Vol. 1", { binding: "hardcover" })),
      "accepted",
    );
    await eachBranch((t) => bound(t, olEdition("Vagabond, Vol. 1"), "paperback"), "accepted");
  });

  /** An Open Library edition as its parser stores it. */
  const parsedEdition = (fields: Record<string, unknown>) =>
    parseEditionJson({
      key: "/books/OL8M",
      isbn_13: [OLDER],
      publishers: ["VIZ Media"],
      physical_format: "Paperback",
      ...fields,
    })!;

  it("records an Open Library book whose Volume its subtitle states, as the parser stored it (C67-13)", async () => {
    const snapshot = parsedEdition({ title: "Vagabond", subtitle: "Vol. 1" });
    expect(snapshot).toMatchObject({ title: "Vagabond", volumeLabel: "1" });
    await eachBranch((t) => setup(t, "openlibrary", snapshot), "accepted");
  });

  it("still checks that Volume against the Release, and refuses a title that says otherwise (C67-13)", async () => {
    const snapshot = parsedEdition({ title: "Vagabond", subtitle: "Vol. 1" });
    await eachBranch(
      (t) => setup(t, "openlibrary", snapshot, volume2),
      /is Volume 1; the Release is Volume 2/,
    );
    await eachBranch(
      (t) => setup(t, "openlibrary", olEdition("Vagabond, Vol. 2", { volumeLabel: "1" })),
      /its title "Vagabond, Vol. 2" says Volume 2, its stored reading Volume 1/,
    );
    await eachBranch(
      (t) => setup(t, "openlibrary", parsedEdition({ title: "Kingdom", subtitle: "Hearts II" })),
      /ends in a number that may be the work's own/,
    );
  });

  /** Series B, also titled "Vagabond", covering the Release's Edition instead of its own Volume 1. */
  const foreignVolume =
    (series: Partial<Doc<"series">>) =>
    async (ctx: MutationCtx, { publisherId }: { publisherId: Id<"publishers"> }) => {
      const other = await insertSeries(ctx, { title: "Vagabond", ...series });
      const volumeId = await insertVolume(ctx, { seriesId: other, position: 1 });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      return editionId;
    };

  it("refuses a Volume of another Series titled the same, active, hidden or merged into nothing (C67-07)", async () => {
    for (const series of [{}, { status: "hidden" as const }, { status: "merged" as const }]) {
      await eachBranch(
        (t) =>
          setup(t, "openlibrary", olEdition("Vagabond, Vol. 1"), {
            edition: foreignVolume(series),
          }),
        /The Release's Volume is not a Volume of the Release's own Series/,
      );
    }
  });

  it("refuses a Release whose own Series is hidden or cannot be followed (C67-07)", async () => {
    for (const [patch, reason] of [
      [{ status: "hidden" }, /The Release's Series "Vagabond" is hidden/],
      [{ status: "merged" }, /The Release's Series cannot be followed: .* is merged into nothing/],
    ] as const) {
      await eachBranch(async (t) => {
        const ids = await setup(t, "openlibrary", olEdition("Vagabond, Vol. 1"));
        await t.run((ctx) => ctx.db.patch(ids.seriesId, patch));
        return ids;
      }, reason);
    }
  });

  it("refuses a covered Volume whose merges loop (C67-07)", async () => {
    await eachBranch(
      (t) =>
        setup(t, "openlibrary", olEdition("Vagabond, Vol. 1"), {
          edition: async (ctx, { seriesId, publisherId }) => {
            const a = await insertVolume(ctx, { seriesId, position: 1, status: "merged" });
            const b = await insertVolume(ctx, { seriesId, position: 1, status: "merged" });
            await ctx.db.patch(a, { mergedIntoId: b });
            await ctx.db.patch(b, { mergedIntoId: a });
            const editionId = await insertEdition(ctx, { publisherId });
            await insertCoverage(ctx, { editionId, volumeId: a });
            return editionId;
          },
        }),
      /cannot be followed to an active Volume/,
    );
  });

  it("follows legitimate merges of the Release's Series and Volume to the same work (C67-07 control)", async () => {
    await eachBranch(async (t) => {
      const ids = await setup(t, "openlibrary", olEdition("Vagabond, Vol. 1"), {
        edition: async (ctx, { seriesId, publisherId }) => {
          // The covered Volume was merged into the Series' Volume 1, its own
          // Series into the Release's.
          const old = await insertSeries(ctx, {
            title: "Vagabond (VIZBIG)",
            status: "merged",
            mergedIntoId: seriesId,
          });
          const kept = await insertVolume(ctx, { seriesId, position: 1 });
          const merged = await insertVolume(ctx, {
            seriesId: old,
            position: 1,
            status: "merged",
            mergedIntoId: kept,
          });
          const editionId = await insertEdition(ctx, { publisherId });
          await insertCoverage(ctx, { editionId, volumeId: merged });
          return editionId;
        },
      });
      // The Release still names a Series merged into its own.
      await t.run(async (ctx) => {
        const merged = await insertSeries(ctx, {
          title: "Vagabond",
          status: "merged",
          mergedIntoId: ids.seriesId,
        });
        await ctx.db.patch(ids.releaseId, { seriesIds: [merged] });
      });
      return ids;
    }, "accepted");
  });
});
