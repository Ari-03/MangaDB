import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { AnnCredit } from "./lib/ann";
import { workMatch } from "./lib/matching";
import { matchPerson, mergeRoles, nameKey, nearKeys, roleFor } from "./people";
import {
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  seriesStatsRow,
  type Overrides,
} from "./test.factories";
import { drain, makeT, type TestT } from "./test.helpers";

// A PRH line that makes the parser throw, standing in for any failure of
// the publisher pass (a transaction limit, a bad snapshot).
vi.mock("./lib/prh", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/prh")>();
  return {
    ...real,
    parseAuthorCredits: (author: string | undefined) => {
      if (author === "THROW") throw new Error("publisher pass failed");
      return real.parseAuthorCredits(author);
    },
  };
});

/** ANN's manga observation crediting a Series, as the importer stores it; no `credits` when omitted. */
const insertAnnManga = (
  ctx: MutationCtx,
  seriesId: Id<"series">,
  mangaId: string,
  credits?: AnnCredit[],
) =>
  insertObservation(ctx, {
    sourceKey: "ann",
    sourceRecordId: `manga:${mangaId}`,
    recordRef: { type: "series", id: seriesId },
    snapshot: { kind: "annManga", id: mangaId, staff: [], ...(credits ? { credits } : {}) },
  });

/** A Release of `seriesIds` from `publisherId`, on an Edition of its own. */
async function insertBook(
  ctx: MutationCtx,
  publisherId: Id<"publishers">,
  seriesIds: Id<"series">[],
) {
  const editionId = await insertEdition(ctx, { publisherId });
  return await insertRelease(ctx, { editionId, publisherId, seriesIds });
}

/** A publisher's release observation of `releaseId`. */
const insertReleaseObservation = (
  ctx: MutationCtx,
  fields: Overrides<"sourceObservations", "sourceKey" | "sourceRecordId"> & {
    releaseId: Id<"releases">;
  },
) => {
  const { releaseId, ...rest } = fields;
  return insertObservation(ctx, { recordRef: { type: "release", id: releaseId }, ...rest });
};

/** A people row: `nameKey` from the name and an uncredited author's counts unless given. */
const insertPersonRow = (ctx: MutationCtx, fields: Overrides<"people", "publicId" | "name">) =>
  ctx.db.insert("people", {
    nameKey: nameKey(fields.name),
    seriesCount: 0,
    originalCount: 0,
    coverUrl: null,
    coverIsbn: null,
    ...fields,
  });

/** The observation a source keeps under a record id. */
const observationOf = (t: TestT, sourceKey: string, sourceRecordId: string) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", sourceKey).eq("sourceRecordId", sourceRecordId),
        )
        .unique())!,
  );

const withdraw = (t: TestT, observation: Doc<"sourceObservations">) =>
  t.run((ctx) => ctx.db.patch(observation._id, { withdrawn: true }));

describe("roleFor", () => {
  it.each([
    ["Story & Art", "story_art"],
    ["Story", "story"],
    ["Art", "art"],
    ["Original creator", "original"],
    ["Original Concept", "original"],
    ["Original Character Design", null],
  ])("credits ANN's task %j as %j", (task, role) => {
    expect(roleFor(task)).toBe(role);
  });
});

// Isayama writes and draws Attack on Titan and created No Regrets, which
// Gan Sunaaku writes and Hikaru Suruga draws; Suruga's credit comes from a
// second ANN entry on a Series later merged into No Regrets.
async function catalog() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const aot = await insertSeries(ctx, { publicId: 1, title: "Attack on Titan" });
    const regrets = await insertSeries(ctx, { publicId: 2, title: "Attack on Titan: No Regrets" });
    const duplicate = await insertSeries(ctx, {
      publicId: 3,
      title: "No Regrets (duplicate)",
      status: "merged",
      mergedIntoId: regrets,
    });
    const bookless = await insertSeries(ctx, {
      publicId: 4,
      title: "Attack on Titan: Lost Girls",
      bookless: true,
    });
    const isayama = { personId: "97559", name: "Hajime Isayama" };
    await insertAnnManga(ctx, aot, "12308", [{ ...isayama, task: "Story & Art" }]);
    await insertAnnManga(ctx, regrets, "15904", [
      { personId: "127179", name: "Gan Sunaaku", task: "Story" },
      { ...isayama, task: "Original creator" },
      { personId: "1", name: "Designer", task: "Original Character Design" },
      // Credited only for the idea: listed on pages, not ranked.
      { personId: "555", name: "Idea Person", task: "Original Concept" },
    ]);
    await insertAnnManga(ctx, duplicate, "99999", [
      { personId: "127178", name: "Hikaru Suruga", task: "Art" },
    ]);
    await insertAnnManga(ctx, bookless, "20000", [{ ...isayama, task: "Original creator" }]);
    // Stored before the importer kept credits: names only, nothing to credit.
    await insertAnnManga(ctx, aot, "30000");
    await ctx.db.insert(
      "seriesStats",
      seriesStatsRow({
        seriesId: aot,
        publicId: 1,
        title: "Attack on Titan",
        sourceStatus: "completed",
        publishers: [{ name: "Kodansha", slug: "kodansha" }],
        hasPhysical: true,
        hasDigital: true,
        volumeCount: 34,
        releaseCount: 68,
        firstReleaseSort: 20120619,
        latestReleaseSort: 20210000,
        coverIsbn: "9781612620244",
      }),
    );
    return { aot, regrets, bookless };
  });
  await t.action(internal.people.rebuild, {});
  return { t, ids };
}

describe("people.rebuild", () => {
  it("credits each Series from ANN staff, merged Series via their survivor", async () => {
    const { t, ids } = await catalog();
    const page = await t.query(api.catalog.seriesPage, { publicId: 2 });
    expect(page?.credits.map((c) => [c.name, c.role])).toEqual([
      ["Gan Sunaaku", "story"],
      ["Hikaru Suruga", "art"],
      ["Hajime Isayama", "original"],
      ["Idea Person", "original"],
    ]);
    const people = await t.run((ctx) => ctx.db.query("people").collect());
    // One row per ANN person; character design credits no one.
    expect(people.map((p) => p.name).sort()).toEqual([
      "Gan Sunaaku",
      "Hajime Isayama",
      "Hikaru Suruga",
      "Idea Person",
    ]);
    const isayama = people.find((p) => p.name === "Hajime Isayama")!;
    // He made Attack on Titan and originated No Regrets; the bookless
    // Series is credited but neither counted nor shown.
    expect(isayama).toMatchObject({
      seriesCount: 1,
      originalCount: 1,
      coverIsbn: "9781612620244",
    });
    expect(people.find((p) => p.name === "Idea Person")).toMatchObject({
      seriesCount: 0,
      originalCount: 1,
    });
    const credits = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.bookless))
        .collect(),
    );
    expect(credits).toHaveLength(1);
  });

  // The general directory shows a mixed-credit author, so their jacket
  // must be a general Series' even when only their originals are general.
  it("prefers a general Series he only originated to a mature one he made for the cover", async () => {
    const { t, ids } = await catalog();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.aot, { mature: true });
      const aot = await ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.aot))
        .unique();
      const { _id, _creationTime, ...stats } = aot!;
      await ctx.db.insert("seriesStats", {
        ...stats,
        seriesId: ids.regrets,
        publicId: 2,
        title: "Attack on Titan: No Regrets",
        volumeCount: 2,
        coverIsbn: "9781612629421",
      });
    });
    await t.mutation(internal.people.statsBatch, { afterPublicId: null });
    const isayama = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_annId", (q) => q.eq("annId", "97559"))
        .unique(),
    );
    expect(isayama).toMatchObject({ seriesCount: 1, originalCount: 1, coverIsbn: "9781612629421" });
    expect(isayama?.matureOnly).toBeUndefined();
  });

  it("drops credits no observation gives any more", async () => {
    const { t, ids } = await catalog();
    await withdraw(t, await observationOf(t, "ann", "manga:12308"));
    await t.action(internal.people.rebuild, {});
    const credits = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.aot))
        .collect(),
    );
    expect(credits).toEqual([]);
  });
});

// Series no ANN entry credits, credited from their publishers' release
// observations: "1122: For a Happy Marriage" from Kodansha volume pages
// (each names one creator), Kingdom of Ruin from PRH's author line (its
// Kodansha page names a character designer too, unused), and one-shots
// Kodansha credits to Eiichiro Oda and Shirow Masamune, whom ANN knows as
// "Eiichirō Oda" and "Masamune Shirow". ANN credits One Piece, so
// Kodansha's name there is unused.
async function publisherCatalog(options: { budgetMs?: number } = {}) {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const series = (title: string) => insertSeries(ctx, { title });
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const release = (seriesIds: Id<"series">[]) => insertBook(ctx, publisherId, seriesIds);
    const observe = (
      sourceKey: string,
      sourceRecordId: string,
      releaseId: Id<"releases">,
      snapshot: object,
      withdrawn = false,
    ) =>
      insertReleaseObservation(ctx, { sourceKey, sourceRecordId, releaseId, snapshot, withdrawn });
    const kodansha = (creators: string[]) => ({ kind: "kodanshaVolume", creators });
    const prh = (author: string) => ({ kind: "prhTitle", author });

    const marriage = await series("1122: For a Happy Marriage");
    await observe(
      "kodansha",
      "1122/v1#physical",
      await release([marriage]),
      kodansha(["Peko Watanabe"]),
    );
    await observe(
      "kodansha",
      "1122/v2#physical",
      await release([marriage]),
      kodansha(["Co Author"]),
    );
    // PRH's line has roles, so Kodansha's list (which adds the character
    // designer) is not used.
    const ruin = await series("Kingdom of Ruin");
    const ruinBook = await release([ruin]);
    await observe(
      "prh",
      "9781646516650",
      ruinBook,
      prh("Story by Muneyuki Kaneshiro; Art by Yusuke Nomura"),
    );
    await observe(
      "kodansha",
      "ruin/v1#physical",
      ruinBook,
      kodansha(["Yusuke Nomura", "Kota Sannomiya"]),
    );
    // One volume naming two people; "Various" names nobody.
    const anthology = await series("Anthology");
    await observe(
      "kodansha",
      "anth/v1#physical",
      await release([anthology]),
      kodansha(["Ann Thology", "Various"]),
    );
    await observe(
      "kodansha",
      "anth/v2#physical",
      await release([anthology]),
      kodansha(["Various"]),
    );

    const onePiece = await series("One Piece");
    await insertAnnManga(ctx, onePiece, "1", [
      { personId: "1", name: "Eiichirō Oda", task: "Story & Art" },
    ]);
    await observe(
      "kodansha",
      "op/v1#physical",
      await release([onePiece]),
      kodansha(["Someone Else"]),
    );
    const oneShot = await series("Oda One-Shot");
    await observe(
      "kodansha",
      "oda/v1#physical",
      await release([oneShot]),
      kodansha(["Eiichiro Oda"]),
    );
    const ghost = await series("Ghost in the Shell");
    await insertAnnManga(ctx, ghost, "2", [
      { personId: "2", name: "Masamune Shirow", task: "Story & Art" },
    ]);
    const shirowShort = await series("Shirow Short");
    await observe(
      "kodansha",
      "shirow/v1#physical",
      await release([shirowShort]),
      kodansha(["Shirow Masamune"]),
    );
    // ANN knows two people named Kei Sato; the name alone means neither.
    const keiOne = await series("Kei Sato One");
    await insertAnnManga(ctx, keiOne, "3", [
      { personId: "3", name: "Kei Sato", task: "Story & Art" },
    ]);
    const keiTwo = await series("Kei Sato Two");
    await insertAnnManga(ctx, keiTwo, "4", [{ personId: "4", name: "Kei Satō", task: "Art" }]);
    const keiShort = await series("Kei Short");
    await observe("kodansha", "kei/v1#physical", await release([keiShort]), kodansha(["Kei Sato"]));

    // Nothing to credit: a withdrawn observation, a hidden Series, and a
    // Release in two Series. A merged Series credits its survivor.
    const withdrawn = await series("Withdrawn");
    await observe(
      "kodansha",
      "w/v1#physical",
      await release([withdrawn]),
      kodansha(["Gone Person"]),
      true,
    );
    const hidden = await insertSeries(ctx, { title: "Hidden", status: "hidden" });
    await observe(
      "kodansha",
      "h/v1#physical",
      await release([hidden]),
      kodansha(["Hidden Person"]),
    );
    const twoSeries = await release([withdrawn, oneShot]);
    await observe("prh", "9780000000002", twoSeries, prh("Two Series Person"));
    const survivor = await series("Survivor");
    const merged = await insertSeries(ctx, {
      title: "Merged",
      status: "merged",
      mergedIntoId: survivor,
    });
    await observe("prh", "9780000000003", await release([merged]), prh("Merge Person"));
    return {
      publisherId,
      marriage,
      ruin,
      anthology,
      onePiece,
      oneShot,
      ghost,
      shirowShort,
      keiShort,
      withdrawn,
      hidden,
      survivor,
      merged,
    };
  });
  if (options.budgetMs === undefined) {
    await t.action(internal.people.rebuild, {});
  } else {
    // Each action hands on to a scheduled one once its budget is spent.
    const first = await t.action(internal.people.rebuild, { budgetMs: options.budgetMs });
    expect(first).toMatchObject({ continued: true });
    await drain(t);
  }
  return { t, ids };
}

/** A Series' credits as "name: role" lines, ANN rows unmarked, publisher rows "(prh)" or "(creators)". */
async function creditLines(t: TestT, seriesId: Id<"series">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("seriesCredits")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .collect();
    const lines = await Promise.all(
      rows.map(async (row) => {
        const person = await ctx.db.get(row.personId);
        return `${person?.name}: ${row.role}${row.source ? ` (${row.source})` : ""}`;
      }),
    );
    return lines.sort();
  });
}

/** Every credit row and person, by name and title, for comparing two catalogs. */
async function catalogState(t: TestT) {
  return await t.run(async (ctx) => {
    const credits = await Promise.all(
      (await ctx.db.query("seriesCredits").collect()).map(async (row) => {
        const series = await ctx.db.get(row.seriesId);
        const person = await ctx.db.get(row.personId);
        return `${series?.title} | ${person?.name}: ${row.role} ${row.source ?? "ann"}`;
      }),
    );
    const people = (await ctx.db.query("people").collect()).map(
      (p) => `${p.name} ${p.annId ?? "-"} ${p.seriesCount} ${p.originalCount}`,
    );
    return { credits: credits.sort(), people: people.sort() };
  });
}

const personNamed = (t: TestT, name: string) =>
  t.run(async (ctx) => (await ctx.db.query("people").collect()).filter((p) => p.name === name));

describe("people.rebuild publisher credits", () => {
  it("credits a Kodansha-only Series with the names of all its volumes", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.marriage)).toEqual([
      "Co Author: author (creators)",
      "Peko Watanabe: author (creators)",
    ]);
    const [peko] = await personNamed(t, "Peko Watanabe");
    // A role-less author made the Series, so it counts toward the Authors tab.
    expect(peko).toMatchObject({
      nameKey: nameKey("Peko Watanabe"),
      seriesCount: 1,
      originalCount: 0,
    });
    expect(peko?.annId).toBeUndefined();
  });

  it("credits a person two volumes in one batch name once", async () => {
    const { t, ids } = await publisherCatalog();
    const twice = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Twice Named" });
      for (const volume of ["v1", "v2"]) {
        await insertReleaseObservation(ctx, {
          sourceKey: "kodansha",
          sourceRecordId: `twice/${volume}#physical`,
          releaseId: await insertBook(ctx, ids.publisherId, [seriesId]),
          snapshot: { kind: "kodanshaVolume", creators: ["Repeat Person"] },
        });
      }
      return seriesId;
    });
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, twice)).toEqual(["Repeat Person: author (creators)"]);
  });

  it('credits every plain name in a creator list, and nobody for "Various"', async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.anthology)).toEqual(["Ann Thology: author (creators)"]);
    expect(await personNamed(t, "Various")).toEqual([]);
  });

  it("credits PRH's roles and leaves Kodansha's list unused for that Series", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.ruin)).toEqual([
      "Muneyuki Kaneshiro: story (prh)",
      "Yusuke Nomura: art (prh)",
    ]);
    expect(await personNamed(t, "Kota Sannomiya")).toEqual([]);
  });

  it("joins a publisher name to the ANN person of the same name, macron or order aside", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.oneShot)).toEqual(["Eiichirō Oda: author (creators)"]);
    expect(await personNamed(t, "Eiichiro Oda")).toEqual([]);
    expect(await creditLines(t, ids.shirowShort)).toEqual(["Masamune Shirow: author (creators)"]);
    expect(await personNamed(t, "Shirow Masamune")).toEqual([]);
    // ANN credits One Piece, so Kodansha's name there is not used.
    expect(await creditLines(t, ids.onePiece)).toEqual(["Eiichirō Oda: story_art"]);
    expect(await personNamed(t, "Someone Else")).toEqual([]);
  });

  it("keeps a name two ANN people share on a name-only person of its own", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.keiShort)).toEqual(["Kei Sato: author (creators)"]);
    const keis = await t.run(async (ctx) =>
      (await ctx.db.query("people").collect()).filter((p) => p.nameKey === nameKey("Kei Sato")),
    );
    expect(keis.map((p) => p.annId ?? null).sort()).toEqual(["3", "4", null]);
  });

  it("gives nothing for withdrawn observations, hidden Series, or a Release in two Series", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.withdrawn)).toEqual([]);
    expect(await creditLines(t, ids.hidden)).toEqual([]);
    expect(await personNamed(t, "Two Series Person")).toEqual([]);
    // A merged Series' Release credits the survivor, never the merged row.
    expect(await creditLines(t, ids.merged)).toEqual([]);
    expect(await creditLines(t, ids.survivor)).toEqual(["Merge Person: author (prh)"]);
  });

  it("gives way to ANN's credits, ANN adopting the publisher's person row", async () => {
    const { t, ids } = await publisherCatalog();
    const [before] = await personNamed(t, "Peko Watanabe");
    await t.run((ctx) =>
      insertAnnManga(ctx, ids.marriage, "200", [
        { personId: "300", name: "Peko Watanabe", task: "Story & Art" },
      ]),
    );
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.marriage)).toEqual(["Peko Watanabe: story_art"]);
    const after = await personNamed(t, "Peko Watanabe");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: before!._id, publicId: before!.publicId, annId: "300" });
  });

  it("deletes a Series' publisher rows as soon as ANN credits it, before any sweep", async () => {
    const { t, ids } = await publisherCatalog();
    await t.run((ctx) =>
      insertAnnManga(ctx, ids.marriage, "200", [
        { personId: "300", name: "Peko Watanabe", task: "Story & Art" },
      ]),
    );
    await t.mutation(internal.people.creditBatch, { after: null, rebuiltAt: Date.now() + 1000 });
    expect(await creditLines(t, ids.marriage)).toEqual(["Peko Watanabe: story_art"]);
  });

  it("falls back to publisher credits when ANN stops crediting a Series", async () => {
    const { t, ids } = await publisherCatalog();
    await withdraw(t, await observationOf(t, "ann", "manga:1"));
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.onePiece)).toEqual(["Someone Else: author (creators)"]);
  });

  it("never lets a publisher's name veto linking an ANN entry", async () => {
    const { t, ids } = await publisherCatalog();
    // The one-shot's only credit is Kodansha's name, matched to ANN's Oda (id 1).
    const verdict = await t.run((ctx) =>
      workMatch(ctx, ids.oneShot, { books: [], annPersonIds: ["999"] }),
    );
    expect(verdict).toBe("unknown");
  });

  it("lowers a role when PRH's line does, keeping the row", async () => {
    const { t, ids } = await publisherCatalog();
    const ruin = await observationOf(t, "prh", "9781646516650");
    const setLine = (author: string) =>
      t.run((ctx) => ctx.db.patch(ruin._id, { snapshot: { kind: "prhTitle", author } }));
    await setLine("Story and Art by Muneyuki Kaneshiro");
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.ruin)).toEqual(["Muneyuki Kaneshiro: story_art (prh)"]);
    const rowId = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query("seriesCredits")
            .withIndex("by_series", (q) => q.eq("seriesId", ids.ruin))
            .collect(),
        )
      ).find((row) => row.role !== "art")?._id;
    const before = await rowId();
    await setLine("Story by Muneyuki Kaneshiro; Art by Yusuke Nomura");
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.ruin)).toEqual([
      "Muneyuki Kaneshiro: story (prh)",
      "Yusuke Nomura: art (prh)",
    ]);
    expect(await rowId()).toBe(before);
  });

  it("deletes a Series' creators rows as soon as PRH credits it, before any sweep", async () => {
    const { t, ids } = await publisherCatalog();
    const volume = await observationOf(t, "kodansha", "1122/v1#physical");
    await t.run((ctx) =>
      insertObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: "9781111111111",
        recordRef: volume.recordRef,
        snapshot: { kind: "prhTitle", author: "Peko Watanabe" },
      }),
    );
    await t.mutation(internal.people.publisherBatch, {
      sourceKey: "prh",
      after: null,
      rebuiltAt: Date.now() + 1000,
    });
    expect(await creditLines(t, ids.marriage)).toEqual(["Peko Watanabe: author (prh)"]);
  });

  it("adopts a publisher-named person only when no ANN namesake shares the key", async () => {
    const { t, ids } = await publisherCatalog();
    const nameOnly = await t.run(async (ctx) => {
      // ANN's Kei Tanaka (id 50) and a publisher's Kei Tanaka, who may be
      // either him or someone else.
      await insertPersonRow(ctx, { publicId: 9050, name: "Kei Tanaka", annId: "50" });
      const id = await insertPersonRow(ctx, { publicId: 9000, name: "Kei Tanaka" });
      await insertAnnManga(ctx, ids.anthology, "500", [
        { personId: "51", name: "Kei Tanaka", task: "Art" },
      ]);
      return id;
    });
    await t.action(internal.people.rebuild, {});
    // ANN's id 51 got a row of its own; the name-only row was not adopted.
    const keis = await personNamed(t, "Kei Tanaka");
    expect(keis.map((p) => p.annId ?? null).sort()).toEqual(["50", "51", null]);
    expect(keis.find((p) => p._id === nameOnly)?.annId).toBeUndefined();
  });

  it("shows no ANN link on the page of a person only publishers name", async () => {
    const { t } = await publisherCatalog();
    const [peko] = await personNamed(t, "Peko Watanabe");
    const page = await t.query(api.people.authorPage, { publicId: peko!.publicId });
    expect(page?.author).toEqual({ publicId: peko!.publicId, name: "Peko Watanabe", annUrl: null });
  });
});

// PRH Series whose volumes spell a name two ways, from the production
// check, with a batch boundary inside each Series' observations: filler
// observations (withdrawn) push the later books into the next batch.
// `seen` is the observation's lastSeenAt.
async function variantCatalog() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Dark Horse", slug: "dark-horse" });
    let isbn = 0;
    const series = (title: string) => insertSeries(ctx, { title });
    const book = async (seriesId: Id<"series">, author: string, seen: number, late = false) => {
      await insertReleaseObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: `${late ? "9789" : "9780"}${String(++isbn).padStart(9, "0")}`,
        releaseId: await insertBook(ctx, publisherId, [seriesId]),
        snapshot: { kind: "prhTitle", author },
        lastSeenAt: seen,
      });
    };
    const hellbound = await series("The Hellbound");
    const nomiya = await series("How My Cute Girlfriend and I Started a Love Story");
    const sirius = await series("Sirius: Twin Stars");
    const dumbbells = await series("How Heavy are the Dumbbells You Lift?");
    const kurosagi = await series("The Kurosagi Corpse Delivery Service");
    const berserk = await series("Berserk");
    const twins = await series("Twin Pens");
    // Near spellings of one name: a tie goes to the one seen most recently.
    await book(hellbound, "Written by Yeon Sang-Ho. Illustrated by Choi Gyu-Seok.", 1);
    await book(hellbound, "Written by Yeon Sang-Ho. Illustrated by Choe Gyu-Seok.", 2, true);
    await book(sirius, "Ana C. Sánchez", 2);
    await book(sirius, "Aaa Sánchez", 1, true);
    // The more common spelling wins, however recent the other.
    await book(nomiya, "Rion Nomiya", 1);
    await book(nomiya, "Rion Nomiya", 1, true);
    await book(nomiya, "Reon Nomiya", 9, true);
    // Spellings of one key are one person; a role beats role-less.
    await book(dumbbells, "Yabako Sandrovich; Illustrated by Maam", 1);
    await book(dumbbells, "Yabako Sandrovich", 5);
    await book(dumbbells, "Yabako Sandrovich; Illustrated by MAAM", 2, true);
    // Volumes that leave out a co-creator or a role don't take them away.
    await book(kurosagi, "Eiji Otsuka", 3);
    await book(kurosagi, "Eiji Otsuka", 3, true);
    await book(kurosagi, "Written by Eiji Otsuka. Illustrated by Housui Yamazaki.", 1, true);
    await book(berserk, "Kentaro Miura", 3);
    await book(berserk, "Kentaro Miura", 3, true);
    await book(berserk, "Written and Illustrated by Kentaro Miura.", 1, true);
    // Near names on one line are two people.
    await book(twins, "Art by Yuka Sato; Story by Yuki Sato", 1);
    await book(twins, "Story by Yuki Sato; Art by Yuka Sato", 1, true);
    // Near names a later line shows to be two people: Yuka alone on three
    // volumes, then beside Yuki.
    const pair = await series("Pair Pens");
    await book(pair, "Story by Yuki Sato", 1);
    await book(pair, "Art by Yuka Sato", 1);
    await book(pair, "Art by Yuka Sato", 1);
    await book(pair, "Art by Yuka Sato", 1);
    await book(pair, "Story by Yuki Sato; Art by Yuka Sato", 1, true);
    // Two people one line names together, and a spelling near both.
    const bridge = await series("Bridge Pens");
    await book(bridge, "Story by Kenta Mori; Art by Kenji Mari", 1);
    await book(bridge, "Kenta Mari", 1, true);
    for (let i = 0; i < 200; i++) {
      await insertObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: `9785${String(i).padStart(9, "0")}`,
        snapshot: { kind: "prhTitle" },
        withdrawn: true,
      });
    }
    return {
      publisherId,
      hellbound,
      nomiya,
      sirius,
      dumbbells,
      kurosagi,
      berserk,
      twins,
      pair,
      bridge,
    };
  });
  await t.action(internal.people.rebuild, {});
  return { t, ids };
}

describe("people.rebuild when the publisher pass fails", () => {
  it("still sweeps ANN's stale rows and refreshes stats, keeping publisher rows, then throws", async () => {
    const { t, ids } = await publisherCatalog();
    // ANN no longer credits One Piece; a PRH line now breaks the pass.
    await withdraw(t, await observationOf(t, "ann", "manga:1"));
    const ruin = await observationOf(t, "prh", "9781646516650");
    await t.run((ctx) =>
      ctx.db.patch(ruin._id, { snapshot: { kind: "prhTitle", author: "THROW" } }),
    );
    // A name-only person marked uncredited by an earlier run: prunable, but
    // only by a rebuild whose publisher pass completed.
    const marked = await t.run((ctx) =>
      insertPersonRow(ctx, { publicId: 30000, name: "Marked Earlier", creditlessSince: 1 }),
    );
    await expect(t.action(internal.people.rebuild, {})).rejects.toThrow("publisher pass failed");
    expect(await t.run((ctx) => ctx.db.get(marked))).toMatchObject({
      name: "Marked Earlier",
      creditlessSince: 1,
    });
    // ANN's stale row is gone and the stats saw it; Kodansha's rows, which the
    // failed pass never reached to restamp, stay.
    expect(await creditLines(t, ids.onePiece)).toEqual([]);
    expect(await creditLines(t, ids.marriage)).toEqual([
      "Co Author: author (creators)",
      "Peko Watanabe: author (creators)",
    ]);
    const [oda] = await personNamed(t, "Eiichirō Oda");
    // Only the one-shot's publisher credit is left to count.
    expect(oda).toMatchObject({ seriesCount: 1 });
  });
});

describe("people.rebuild across actions", () => {
  it("gives the same rows when split across continuations as in one action", async () => {
    const whole = await publisherCatalog();
    const split = await publisherCatalog({ budgetMs: 0 });
    expect(await catalogState(split.t)).toEqual(await catalogState(whole.t));
  });
});

describe("people.rebuild PRH lines", () => {
  it("credits the union of a Series' PRH lines, near spellings collapsed to the most used", async () => {
    const { t, ids } = await variantCatalog();
    expect(await creditLines(t, ids.hellbound)).toEqual([
      "Choe Gyu-Seok: art (prh)",
      "Yeon Sang-Ho: story (prh)",
    ]);
    expect(await creditLines(t, ids.sirius)).toEqual(["Ana C. Sánchez: author (prh)"]);
    expect(await creditLines(t, ids.nomiya)).toEqual(["Rion Nomiya: author (prh)"]);
    expect(await creditLines(t, ids.dumbbells)).toEqual([
      "Maam: art (prh)",
      "Yabako Sandrovich: story (prh)",
    ]);
    expect(await creditLines(t, ids.kurosagi)).toEqual([
      "Eiji Otsuka: story (prh)",
      "Housui Yamazaki: art (prh)",
    ]);
    expect(await creditLines(t, ids.berserk)).toEqual(["Kentaro Miura: story_art (prh)"]);
    expect(await creditLines(t, ids.twins)).toEqual([
      "Yuka Sato: art (prh)",
      "Yuki Sato: story (prh)",
    ]);
    expect(await creditLines(t, ids.pair)).toEqual([
      "Yuka Sato: art (prh)",
      "Yuki Sato: story (prh)",
    ]);
    // Kenta Mari is near both, but can't join them into one person.
    expect(await creditLines(t, ids.bridge)).toEqual([
      "Kenji Mari: art (prh)",
      "Kenta Mori: story (prh)",
    ]);
  });

  it("keeps the losing spelling's person until a second run finds them still uncredited", async () => {
    const { t } = await variantCatalog();
    const [choi] = await personNamed(t, "Choi Gyu-Seok");
    expect(choi?.creditlessSince).toEqual(expect.any(Number));
    await t.action(internal.people.rebuild, {});
    expect(await personNamed(t, "Choi Gyu-Seok")).toEqual([]);
  });

  it("settles from the second run on: same people, public ids, and credit rows", async () => {
    const { t } = await variantCatalog();
    const snapshot = () =>
      t.run(async (ctx) => ({
        people: (await ctx.db.query("people").collect())
          .map((p) => `${p.publicId} ${p.name}`)
          .sort(),
        rows: (await ctx.db.query("seriesCredits").collect())
          .map((row) => `${row._id} ${row.personId} ${row.role}`)
          .sort(),
      }));
    await t.action(internal.people.rebuild, {});
    const second = await snapshot();
    for (let run = 3; run <= 4; run++) {
      await t.action(internal.people.rebuild, {});
      expect(await snapshot()).toEqual(second);
    }
    // The losing spellings' people are gone and stay gone.
    expect(second.people.some((p) => p.endsWith("Choi Gyu-Seok"))).toBe(false);
  });

  it("never puts two names from one line on one row, even mid-run", async () => {
    const { t, ids } = await variantCatalog();
    // A Series credited for the first time, its one book naming both.
    const fresh = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Fresh Pens" });
      await insertReleaseObservation(ctx, {
        sourceKey: "prh",
        sourceRecordId: "9780999999999",
        releaseId: await insertBook(ctx, ids.publisherId, [seriesId]),
        snapshot: { kind: "prhTitle", author: "Story by Yuki Sato; Art by Yuka Sato" },
        lastSeenAt: 1,
      });
      return seriesId;
    });
    // A run's first batch, before any settling: each twin holds a row.
    await t.mutation(internal.people.publisherBatch, {
      sourceKey: "prh",
      after: null,
      rebuiltAt: Date.now() + 1000,
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", fresh))
        .collect(),
    );
    expect(rows.map((row) => (row.runNames ?? []).map((n) => n.name)).sort()).toEqual([
      ["Yuka Sato"],
      ["Yuki Sato"],
    ]);
  });

  it("folds two rows production holds for near spellings into one", async () => {
    const { t, ids } = await variantCatalog();
    // As the previous rule left The Hellbound: a row for each spelling.
    await t.run(async (ctx) => {
      const personId = await insertPersonRow(ctx, {
        publicId: 4318,
        name: "Choi Gyu-Seok",
        seriesCount: 1,
      });
      await ctx.db.insert("seriesCredits", {
        seriesId: ids.hellbound,
        personId,
        role: "art",
        source: "prh",
        rebuiltAt: 0,
      });
    });
    expect(await creditLines(t, ids.hellbound)).toHaveLength(3);
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.hellbound)).toEqual([
      "Choe Gyu-Seok: art (prh)",
      "Yeon Sang-Ho: story (prh)",
    ]);
  });

  it("settles a Series split across settle pages as if settled once", async () => {
    const { t, ids } = await variantCatalog();
    const rebuiltAt = Date.now() + 1000;
    // Two PRH rows on The Hellbound, a page apart: the first tallies the
    // winning spelling twice; the second shows the winner's person but
    // tallies the other spelling, so its own tally alone would pick Choe.
    const { choi } = await t.run(async (ctx) => {
      // The first run left Choi's person (the spelling seen first) in place.
      const choi = (await ctx.db.query("people").collect()).find(
        (p) => p.name === "Choi Gyu-Seok",
      )!._id;
      const other = await insertPersonRow(ctx, { publicId: 7022, name: "Somebody Else Entirely" });
      for (const row of await ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.hellbound))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      const prh = (personId: Id<"people">, runNames: { name: string; count: number }[]) =>
        ctx.db.insert("seriesCredits", {
          seriesId: ids.hellbound,
          personId,
          role: "art",
          runRole: "art",
          source: "prh",
          rebuiltAt,
          runNames: runNames.map((n) => ({ ...n, role: "art" as const, seenAt: 1 })),
          runApart: [],
        });
      await prh(other, [{ name: "Choi Gyu-Seok", count: 2 }]);
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("seriesCredits", {
          seriesId: ids.berserk,
          personId: other,
          role: "author",
          source: "creators",
          rebuiltAt,
        });
      }
      await prh(choi, [{ name: "Choe Gyu-Seok", count: 1 }]);
      return { choi };
    });
    let cursor: string | null = null;
    let pages = 0;
    do {
      cursor = await t.mutation(internal.people.settleRoles, { rebuiltAt, cursor });
      pages++;
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", ids.hellbound))
        .collect(),
    );
    expect(rows.map((row) => row.personId)).toEqual([choi]);
  });

  it("keeps every row id across rebuilds", async () => {
    const { t } = await variantCatalog();
    const rows = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("seriesCredits").collect())
          .map((row) => `${row._id} ${row.role}`)
          .sort(),
      );
    const before = await rows();
    await t.action(internal.people.rebuild, {});
    expect(await rows()).toEqual(before);
  });
});

describe("people.rebuild name keys", () => {
  /** A people row as an older rebuild left it, with whatever key it stored. */
  const legacyPerson = (
    t: TestT,
    fields: { publicId: number; name: string; nameKey: string; annId?: string },
  ) => t.run((ctx) => insertPersonRow(ctx, { ...fields, seriesCount: 1 }));
  /** Make Kodansha's Shirow Short volume list these creators. */
  const listOnShirowShort = async (t: TestT, creators: string[]) => {
    const volume = await observationOf(t, "kodansha", "shirow/v1#physical");
    await t.run((ctx) =>
      ctx.db.patch(volume._id, { snapshot: { kind: "kodanshaVolume", creators } }),
    );
  };
  /** Who a Series' rows credit, by person id. */
  const creditedIds = (t: TestT, seriesId: Id<"series">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("seriesCredits")
          .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
          .collect()
      ).map((row) => row.personId),
    );

  it("rekeys a legacy name-only row, so its name finds it again", async () => {
    const { t, ids } = await publisherCatalog();
    // Stored under the old rule, which spaced and kept long vowels; no ANN
    // pass touches a name-only row.
    const kumeta = await legacyPerson(t, {
      publicId: 4646,
      name: "Kouji Kumeta",
      nameKey: "kouji kumeta",
    });
    await listOnShirowShort(t, ["Kouji Kumeta"]);
    await t.action(internal.people.rebuild, {});
    expect(await creditedIds(t, ids.shirowShort)).toEqual([kumeta]);
    expect(await t.run((ctx) => ctx.db.get(kumeta))).toMatchObject({
      nameKey: nameKey("Kouji Kumeta"),
    });
  });

  it("gives a duplicate's credits to the ANN person, though the duplicate is older, and prunes it a run later", async () => {
    const { t, ids } = await publisherCatalog();
    const duplicate = await legacyPerson(t, {
      publicId: 4646,
      name: "Kouji Kumeta",
      nameKey: "kouji kumeta",
    });
    const ann = await legacyPerson(t, {
      publicId: 5000,
      name: "Kōji Kumeta",
      nameKey: "koji kumeta",
      annId: "22407",
    });
    await t.run((ctx) =>
      ctx.db.insert("seriesCredits", {
        seriesId: ids.shirowShort,
        personId: duplicate,
        role: "author",
        source: "creators",
        rebuiltAt: 0,
      }),
    );
    await listOnShirowShort(t, ["Kouji Kumeta"]);
    await t.action(internal.people.rebuild, {});
    expect(await creditedIds(t, ids.shirowShort)).toEqual([ann]);
    // Uncredited once: marked, not deleted.
    expect(await t.run((ctx) => ctx.db.get(duplicate))).toMatchObject({
      creditlessSince: expect.any(Number),
    });
    await t.action(internal.people.rebuild, {});
    expect(await t.run((ctx) => ctx.db.get(duplicate))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ann))).toMatchObject({ publicId: 5000 });
  });

  it("merges two name-only spellings into the earlier person", async () => {
    const { t, ids } = await publisherCatalog();
    // Both stored under the old rule; only the rekey makes them one key.
    const sekine = await legacyPerson(t, {
      publicId: 4637,
      name: "Koutarou Sekine",
      nameKey: "koutarou sekine",
    });
    await legacyPerson(t, { publicId: 4700, name: "Kotaro Sekine", nameKey: "kotaro sekine" });
    await listOnShirowShort(t, ["Kotaro Sekine"]);
    await t.action(internal.people.rebuild, {});
    expect(await creditedIds(t, ids.shirowShort)).toEqual([sekine]);
  });

  it("prefers the exact spelling's ANN person over a folded namesake", async () => {
    const { t, ids } = await publisherCatalog();
    await t.run(async (ctx) => {
      await insertAnnManga(ctx, ids.ghost, "12", [
        { personId: "105703", name: "Ayumi Kanou", task: "Art" },
      ]);
      await insertAnnManga(ctx, ids.keiShort, "13", [
        { personId: "999", name: "Ayumi Kano", task: "Art" },
      ]);
    });
    await listOnShirowShort(t, ["Ayumi Kanou"]);
    await t.action(internal.people.rebuild, {});
    const kanou = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_annId", (q) => q.eq("annId", "105703"))
        .unique(),
    );
    expect(await creditedIds(t, ids.shirowShort)).toEqual([kanou!._id]);
    expect(await personNamed(t, "Ayumi Kanou")).toHaveLength(1);
  });

  it("keeps a name its own credit when ANN namesakes share its folded key", async () => {
    const { t, ids } = await publisherCatalog();
    // Production: ANN has two Johji Manabe; Kodansha's Joji Manabe already
    // has a name-only person of their own, who keeps the credit and id.
    await legacyPerson(t, {
      publicId: 287,
      name: "Johji Manabe",
      nameKey: "johji manabe",
      annId: "287",
    });
    await legacyPerson(t, {
      publicId: 1123,
      name: "Johji Manabe",
      nameKey: "johji manabe",
      annId: "1123",
    });
    const joji = await legacyPerson(t, {
      publicId: 4374,
      name: "Joji Manabe",
      nameKey: "joji manabe",
    });
    await t.run(async (ctx) => {
      await insertAnnManga(ctx, ids.ghost, "10", [
        { personId: "1123", name: "Johji Manabe", task: "Art" },
      ]);
      await insertAnnManga(ctx, ids.keiShort, "11", [
        { personId: "287", name: "Johji Manabe", task: "Art" },
      ]);
    });
    await listOnShirowShort(t, ["Joji Manabe", "Yuuki Kodama"]);
    await t.action(internal.people.rebuild, {});
    const credited = await creditedIds(t, ids.shirowShort);
    expect(credited).toContain(joji);
    expect(await creditLines(t, ids.shirowShort)).toEqual([
      "Joji Manabe: author (creators)",
      "Yuuki Kodama: author (creators)",
    ]);
  });

  it("keeps an ANN person with no credits, and prunes name-only ones only a run later", async () => {
    const { t, ids } = await publisherCatalog();
    // Nothing credits ANN's Masamune Shirow or Kodansha's Co Author any more.
    for (const [sourceKey, sourceRecordId] of [
      ["ann", "manga:2"],
      ["kodansha", "shirow/v1#physical"],
      ["kodansha", "1122/v2#physical"],
    ] as const) {
      await withdraw(t, await observationOf(t, sourceKey, sourceRecordId));
    }
    await t.action(internal.people.rebuild, {});
    expect(await creditLines(t, ids.ghost)).toEqual([]);
    expect(await creditLines(t, ids.shirowShort)).toEqual([]);
    expect(await personNamed(t, "Co Author")).toMatchObject([
      { creditlessSince: expect.any(Number) },
    ]);
    await t.action(internal.people.rebuild, {});
    expect(await personNamed(t, "Masamune Shirow")).toMatchObject([{ annId: "2", seriesCount: 0 }]);
    expect(await personNamed(t, "Co Author")).toEqual([]);
  });

  it("unmarks a person credited again before the second run, keeping their id", async () => {
    const { t } = await publisherCatalog();
    const volume = await observationOf(t, "kodansha", "1122/v2#physical");
    const [coAuthor] = await personNamed(t, "Co Author");
    await withdraw(t, volume);
    await t.action(internal.people.rebuild, {});
    await t.run((ctx) => ctx.db.patch(volume._id, { withdrawn: false }));
    await t.action(internal.people.rebuild, {});
    await t.action(internal.people.rebuild, {});
    const [again] = await personNamed(t, "Co Author");
    expect(again?._id).toBe(coAuthor!._id);
    expect(again?.creditlessSince).toBeUndefined();
  });

  it("deletes at most 100 people a run", async () => {
    const { t } = await publisherCatalog();
    await t.run(async (ctx) => {
      for (let i = 0; i < 105; i++) {
        await insertPersonRow(ctx, { publicId: 20000 + i, name: `Gone ${i}`, creditlessSince: 1 });
      }
    });
    await t.action(internal.people.rebuild, {});
    const left = await t.run(async (ctx) =>
      (await ctx.db.query("people").collect()).filter((p) => p.name.startsWith("Gone ")),
    );
    expect(left).toHaveLength(5);
  });
});

describe("mergeRoles and nameKey", () => {
  it.each([
    [["story", "art"], "story_art"],
    [["author", "story"], "story"],
    [["author", "original"], "original"],
    [["original", "art"], "art"],
    [["author"], "author"],
  ] as const)("merges a person's roles %j on a Series into %j", (roles, merged) => {
    expect(mergeRoles(roles)).toBe(merged);
  });

  it.each([
    ["  Eiichirō   Oda ", "eiichiro oda"],
    ["Masamune Shirow", "Shirow Masamune"],
    ["In-Wan Youn", "Inwan Youn"],
    ["Dr. Pepperco", "Dr pepperco"],
  ])("folds case, accents, spacing, punctuation and name order: %j = %j", (a, b) => {
    expect(nameKey(a)).toBe(nameKey(b));
  });

  // Pairs from the production check: a publisher's spelling, then ANN's.
  it.each([
    ["Kouji Kumeta", "Kōji Kumeta"],
    ["Toru Fujisawa", "Tohru Fujisawa"],
    ["Koutarou Sekine", "Kōtarō Sekine"],
    ["Kyouta Shibano", "Kyōta Shibano"],
    ["Koala Omugi", "Koala Ohmugi"],
    ["Ryuuou", "Ryūō"],
    ["Natsu Hyuuga", "Hyūganatsu"],
    ["Touko Amekawa", "Tōko Amekawa"],
    ["Youhei Yasumura", "Yōhei Yasumura"],
    ["Touki Yanagimi", "Tōki Yanagimi"],
    ["Tohru Tagura", "Tōru Tagura"],
    ["Singyougaku", "Shingyougaku"],
    ["Rampei Asio", "Rampei Ashio"],
    ["coolkyousinnjya", "Coolkyoushinja"],
    ["Indo So", "Indoso"],
  ])("folds long vowels, Kunrei spellings and spacing: %j = %j", (publisher, ann) => {
    expect(nameKey(publisher)).toBe(nameKey(ann));
  });

  it.each([
    ["Tetsuya Chiba", "Tetsuya Chiba Jr"],
    // "oh" before a vowel is not a long o.
    ["Mika Ohara", "Mika Oara"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(nameKey(a)).not.toBe(nameKey(b));
  });

  it.each([
    ["Choe Gyu-Seok", "Choi Gyu-Seok", true],
    ["Ana C. Sánchez", "Aaa Sánchez", true],
    ["Kai", "Kei", true],
    ["Kai", "Kou", false],
    // Equal keys are the same key, not near ones.
    ["Yuki Sato", "Yuki Sato", false],
  ])("near spellings within one or two edits: %j and %j → %j", (a, b, near) => {
    expect(nearKeys(nameKey(a), nameKey(b))).toBe(near);
  });
});

describe("matchPerson", () => {
  let publicId = 0;
  const person = (name: string, annId?: string) =>
    ({ publicId: ++publicId, name, ...(annId ? { annId } : {}) }) as Doc<"people">;

  it("takes the exact spelling's ANN person, else the one ANN person the key finds", () => {
    const kanou = person("Ayumi Kanou", "1");
    const kano = person("Ayumi Kano", "2");
    expect(matchPerson("Ayumi Kanou", [kano, kanou])).toBe(kanou);
    const koji = person("Kōji Kumeta", "3");
    const kouji = person("Kouji Kumeta");
    expect(matchPerson("Kouji Kumeta", [kouji, koji])).toBe(koji);
  });

  it("takes the earliest name-only person when ANN has none", () => {
    const indoso = person("Indoso");
    const indoSo = person("Indo So");
    expect(matchPerson("Indo So", [indoSo, indoso])).toBe(indoso);
    expect(matchPerson("Indo So", [])).toBeNull();
  });

  it("keeps a name ANN namesakes share on its own name-only person", () => {
    const a = person("Johji Manabe", "4");
    const b = person("Johji Manabe", "5");
    const joji = person("Joji Manabe");
    expect(matchPerson("Joji Manabe", [a, b, joji])).toBe(joji);
    expect(matchPerson("Joji Manabe", [a, b])).toBeNull();
    expect(matchPerson("Johji Manabe", [a, b])).toBeNull();
  });
});

describe("people.authorPage and people.authors", () => {
  it("lists an author's visible Series with roles, latest release first", async () => {
    const { t } = await catalog();
    const isayama = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_annId", (q) => q.eq("annId", "97559"))
        .unique(),
    );
    const page = await t.query(api.people.authorPage, { publicId: isayama!.publicId });
    expect(page?.author).toMatchObject({
      name: "Hajime Isayama",
      annUrl: "https://www.animenewsnetwork.com/encyclopedia/people.php?id=97559",
    });
    expect(page?.series.map((s) => [s.title, s.roles])).toEqual([
      ["Attack on Titan", ["story_art"]],
      ["Attack on Titan: No Regrets", ["original"]],
    ]);
    expect(await t.query(api.people.authorPage, { publicId: 999 })).toBeNull();
  });

  it("pages authors who wrote or drew something, most prolific first", async () => {
    const { t } = await catalog();
    const first = await t.query(api.people.authors, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    const rest = await t.query(api.people.authors, {
      paginationOpts: { numItems: 10, cursor: first.continueCursor },
    });
    // Idea Person only originated a Series, so isn't ranked.
    expect([...first.page, ...rest.page].map((a) => a.name).sort()).toEqual([
      "Gan Sunaaku",
      "Hajime Isayama",
      "Hikaru Suruga",
    ]);
  });
});

describe("author search", () => {
  it("finds authors by name in search and suggestions", async () => {
    const { t } = await catalog();
    const search = await t.query(api.catalog.search, { query: "isayama" });
    expect(search.authors.map((a) => [a.name, a.seriesCount])).toEqual([["Hajime Isayama", 1]]);
    // An original creator is still findable.
    const idea = await t.query(api.catalog.search, { query: "idea person" });
    expect(idea.authors).toMatchObject([{ name: "Idea Person", seriesCount: 0, originalCount: 1 }]);
    const suggest = await t.query(api.catalog.suggest, { query: "hajime isa" });
    expect(suggest.authors.map((a) => a.name)).toEqual(["Hajime Isayama"]);
  });
});

describe("people.backfillAnnCredits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches staff only for entries stored without credits, and sets just those", async () => {
    const { t } = await catalog();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        `<ann><manga id="30000" name="Attack on Titan"><info type="Main title" lang="EN">Attack on Titan</info>` +
          `<staff gid="1"><task>Story &amp; Art</task><person id="97559">Hajime Isayama</person></staff></manga></ann>`,
      );
    });
    const result = await t.action(internal.people.backfillAnnCredits, {});
    expect(result).toEqual({ updated: 1, continued: false });
    // Every other entry already had credits: one request, for one id.
    expect(requested).toEqual([
      "https://cdn.animenewsnetwork.com/encyclopedia/api.xml?manga=30000",
    ]);
    const observation = await observationOf(t, "ann", "manga:30000");
    expect(observation.snapshot).toMatchObject({
      kind: "annManga",
      id: "30000",
      credits: [{ personId: "97559", name: "Hajime Isayama", task: "Story & Art" }],
    });
  });

  it("marks an entry ANN has no record for, so a rerun doesn't ask again", async () => {
    const { t } = await catalog();
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response(`<ann><warning>no result for manga=30000</warning></ann>`);
    });
    expect(await t.action(internal.people.backfillAnnCredits, {})).toEqual({
      updated: 1,
      continued: false,
    });
    await t.action(internal.people.backfillAnnCredits, {});
    expect(requests).toBe(1);
  });
});
