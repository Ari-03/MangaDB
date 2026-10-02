import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AnnCredit } from "./lib/ann";
import { workMatch } from "./lib/matching";
import { mergeRoles, nameKey, roleFor } from "./people";
import schema from "./schema";

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

describe("roleFor", () => {
  it("keeps the makers and the source, drops other tasks", () => {
    expect(roleFor("Story & Art")).toBe("story_art");
    expect(roleFor("Story")).toBe("story");
    expect(roleFor("Art")).toBe("art");
    expect(roleFor("Original creator")).toBe("original");
    expect(roleFor("Original Concept")).toBe("original");
    expect(roleFor("Original Character Design")).toBeNull();
  });
});

// Isayama writes and draws Attack on Titan and created No Regrets, which
// Gan Sunaaku writes and Hikaru Suruga draws; Suruga's credit comes from a
// second ANN entry on a Series later merged into No Regrets.
async function catalog() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    let publicId = 0;
    const series = (title: string, extra: { bookless?: true } = {}) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: ++publicId,
        title,
        altTitles: [],
        searchText: title,
        ...extra,
      });
    const aot = await series("Attack on Titan");
    const regrets = await series("Attack on Titan: No Regrets");
    const duplicate = await series("No Regrets (duplicate)");
    await ctx.db.patch(duplicate, { status: "merged", mergedIntoId: regrets });
    const bookless = await series("Attack on Titan: Lost Girls", { bookless: true });
    const observe = (mangaId: string, seriesId: Id<"series">, credits?: AnnCredit[]) =>
      ctx.db.insert("sourceObservations", {
        sourceKey: "ann",
        sourceRecordId: `manga:${mangaId}`,
        recordRef: { type: "series", id: seriesId },
        snapshot: { kind: "annManga", id: mangaId, staff: [], ...(credits ? { credits } : {}) },
        lastSeenAt: 0,
        withdrawn: false,
      });
    const isayama = { personId: "97559", name: "Hajime Isayama" };
    await observe("12308", aot, [{ ...isayama, task: "Story & Art" }]);
    await observe("15904", regrets, [
      { personId: "127179", name: "Gan Sunaaku", task: "Story" },
      { ...isayama, task: "Original creator" },
      { personId: "1", name: "Designer", task: "Original Character Design" },
      // Credited only for the idea: listed on pages, not ranked.
      { personId: "555", name: "Idea Person", task: "Original Concept" },
    ]);
    await observe("99999", duplicate, [{ personId: "127178", name: "Hikaru Suruga", task: "Art" }]);
    await observe("20000", bookless, [{ ...isayama, task: "Original creator" }]);
    // Stored before the importer kept credits: names only, nothing to credit.
    await observe("30000", aot);
    await ctx.db.insert("seriesStats", {
      seriesId: aot,
      publicId: 1,
      title: "Attack on Titan",
      titleSort: "attack on titan",
      letter: "a",
      sourceStatus: "completed",
      publishers: [{ name: "Kodansha", slug: "kodansha" }],
      hasPhysical: true,
      hasDigital: true,
      volumeCount: 34,
      releaseCount: 68,
      firstReleaseSort: 20120619,
      latestReleaseSort: 20210000,
      nextReleaseSort: 0,
      followers: 0,
      collectors: 0,
      coverUrl: null,
      coverIsbn: "9781612620244",
      rebuiltAt: 0,
    });
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

  // B32: the general directory shows a mixed-credit author, so their jacket
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
    await t.run(async (ctx) => {
      const observation = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:12308"))
        .unique();
      await ctx.db.patch(observation!._id, { withdrawn: true });
    });
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
async function publisherCatalog() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    let publicId = 100;
    const series = (title: string) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: ++publicId,
        title,
        altTitles: [],
        searchText: title,
      });
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Kodansha",
      slug: "kodansha",
    });
    const release = async (seriesIds: Id<"series">[]) => {
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: ++publicId,
        publisherId,
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds,
      });
    };
    const observe = (
      sourceKey: string,
      sourceRecordId: string,
      releaseId: Id<"releases">,
      snapshot: object,
      withdrawn = false,
    ) =>
      ctx.db.insert("sourceObservations", {
        sourceKey,
        sourceRecordId,
        recordRef: { type: "release", id: releaseId },
        snapshot,
        lastSeenAt: 0,
        withdrawn,
      });
    const kodansha = (creators: string[]) => ({ kind: "kodanshaVolume", creators });
    const prh = (author: string) => ({ kind: "prhTitle", author });
    const annCredits = (seriesId: Id<"series">, mangaId: string, credits: AnnCredit[]) =>
      ctx.db.insert("sourceObservations", {
        sourceKey: "ann",
        sourceRecordId: `manga:${mangaId}`,
        recordRef: { type: "series", id: seriesId },
        snapshot: { kind: "annManga", id: mangaId, staff: [], credits },
        lastSeenAt: 0,
        withdrawn: false,
      });

    const marriage = await series("1122: For a Happy Marriage");
    await observe("kodansha", "1122/v1#physical", await release([marriage]), kodansha(["Peko Watanabe"]));
    await observe("kodansha", "1122/v2#physical", await release([marriage]), kodansha(["Co Author"]));
    // PRH's line has roles, so Kodansha's list (which adds the character
    // designer) is not used.
    const ruin = await series("Kingdom of Ruin");
    const ruinBook = await release([ruin]);
    await observe("prh", "9781646516650", ruinBook, prh("Story by Muneyuki Kaneshiro; Art by Yusuke Nomura"));
    await observe("kodansha", "ruin/v1#physical", ruinBook, kodansha(["Yusuke Nomura", "Kota Sannomiya"]));
    // One volume naming two people; "Various" names nobody.
    const anthology = await series("Anthology");
    await observe("kodansha", "anth/v1#physical", await release([anthology]), kodansha(["Ann Thology", "Various"]));
    await observe("kodansha", "anth/v2#physical", await release([anthology]), kodansha(["Various"]));

    const onePiece = await series("One Piece");
    await annCredits(onePiece, "1", [{ personId: "1", name: "Eiichirō Oda", task: "Story & Art" }]);
    await observe("kodansha", "op/v1#physical", await release([onePiece]), kodansha(["Someone Else"]));
    const oneShot = await series("Oda One-Shot");
    await observe("kodansha", "oda/v1#physical", await release([oneShot]), kodansha(["Eiichiro Oda"]));
    const ghost = await series("Ghost in the Shell");
    await annCredits(ghost, "2", [{ personId: "2", name: "Masamune Shirow", task: "Story & Art" }]);
    const shirowShort = await series("Shirow Short");
    await observe("kodansha", "shirow/v1#physical", await release([shirowShort]), kodansha(["Shirow Masamune"]));
    // ANN knows two people named Kei Sato; the name alone means neither.
    const keiOne = await series("Kei Sato One");
    await annCredits(keiOne, "3", [{ personId: "3", name: "Kei Sato", task: "Story & Art" }]);
    const keiTwo = await series("Kei Sato Two");
    await annCredits(keiTwo, "4", [{ personId: "4", name: "Kei Satō", task: "Art" }]);
    const keiShort = await series("Kei Short");
    await observe("kodansha", "kei/v1#physical", await release([keiShort]), kodansha(["Kei Sato"]));

    // Nothing to credit: a withdrawn observation, a hidden Series, and a
    // Release in two Series. A merged Series credits its survivor.
    const withdrawn = await series("Withdrawn");
    await observe("kodansha", "w/v1#physical", await release([withdrawn]), kodansha(["Gone Person"]), true);
    const hidden = await series("Hidden");
    await ctx.db.patch(hidden, { status: "hidden" });
    await observe("kodansha", "h/v1#physical", await release([hidden]), kodansha(["Hidden Person"]));
    const twoSeries = await release([withdrawn, oneShot]);
    await observe("prh", "9780000000002", twoSeries, prh("Two Series Person"));
    const survivor = await series("Survivor");
    const merged = await series("Merged");
    await ctx.db.patch(merged, { status: "merged", mergedIntoId: survivor });
    await observe("prh", "9780000000003", await release([merged]), prh("Merge Person"));
    return {
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
  await t.action(internal.people.rebuild, {});
  return { t, ids };
}

type TestT = Awaited<ReturnType<typeof publisherCatalog>>["t"];

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

const personNamed = (t: TestT, name: string) =>
  t.run(async (ctx) => (await ctx.db.query("people").collect()).filter((p) => p.name === name));

/** ANN's manga observation crediting a Series, as the importer stores it. */
const annObservation = (seriesId: Id<"series">, mangaId: string, credits: AnnCredit[]) => ({
  sourceKey: "ann",
  sourceRecordId: `manga:${mangaId}`,
  recordRef: { type: "series" as const, id: seriesId },
  snapshot: { kind: "annManga", id: mangaId, staff: [], credits },
  lastSeenAt: 0,
  withdrawn: false,
});

describe("people.rebuild publisher credits", () => {
  it("credits a Kodansha-only Series with the names of all its volumes", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.marriage)).toEqual([
      "Co Author: author (creators)",
      "Peko Watanabe: author (creators)",
    ]);
    const [peko] = await personNamed(t, "Peko Watanabe");
    // A role-less author made the Series, so it counts toward the Authors tab.
    expect(peko).toMatchObject({ nameKey: "peko watanabe", seriesCount: 1, originalCount: 0 });
    expect(peko?.annId).toBeUndefined();
  });

  it("credits every plain name in a creator list, and nobody for \"Various\"", async () => {
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

  it("credits nobody for a name two people share", async () => {
    const { t, ids } = await publisherCatalog();
    expect(await creditLines(t, ids.keiShort)).toEqual([]);
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
      ctx.db.insert(
        "sourceObservations",
        annObservation(ids.marriage, "200", [
          { personId: "300", name: "Peko Watanabe", task: "Story & Art" },
        ]),
      ),
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
      ctx.db.insert(
        "sourceObservations",
        annObservation(ids.marriage, "200", [
          { personId: "300", name: "Peko Watanabe", task: "Story & Art" },
        ]),
      ),
    );
    await t.mutation(internal.people.creditBatch, { after: null, rebuiltAt: Date.now() + 1000 });
    expect(await creditLines(t, ids.marriage)).toEqual(["Peko Watanabe: story_art"]);
  });

  it("falls back to publisher credits when ANN stops crediting a Series", async () => {
    const { t, ids } = await publisherCatalog();
    await t.run(async (ctx) => {
      const ann = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:1"))
        .unique();
      await ctx.db.patch(ann!._id, { withdrawn: true });
    });
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

  it("shows no ANN link on the page of a person only publishers name", async () => {
    const { t } = await publisherCatalog();
    const [peko] = await personNamed(t, "Peko Watanabe");
    const page = await t.query(api.people.authorPage, { publicId: peko!.publicId });
    expect(page?.author).toEqual({ publicId: peko!.publicId, name: "Peko Watanabe", annUrl: null });
  });
});

// One PRH Series whose author lines give Gou Tanabe a role-less credit on
// one book and "art" on another, with a batch boundary between them, in
// both orders. Filler observations (withdrawn) push the second book into
// the next batch.
async function twoBatchCatalog() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("publishers", {
      status: "active",
      name: "Dark Horse",
      slug: "dark-horse",
    });
    let publicId = 0;
    const series = (title: string) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: ++publicId,
        title,
        altTitles: [],
        searchText: title,
      });
    const book = async (seriesId: Id<"series">, isbn: string, author: string) => {
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: ++publicId,
        publisherId,
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("sourceObservations", {
        sourceKey: "prh",
        sourceRecordId: isbn,
        recordRef: { type: "release", id: releaseId },
        snapshot: { kind: "prhTitle", author },
        lastSeenAt: 0,
        withdrawn: false,
      });
    };
    const authorFirst = await series("At the Mountains of Madness");
    const artFirst = await series("The Hound");
    await book(authorFirst, "9780000000001", "Gou Tanabe");
    await book(artFirst, "9780000000002", "Adaptation and Artwork by Gou Tanabe");
    for (let i = 0; i < 200; i++) {
      await ctx.db.insert("sourceObservations", {
        sourceKey: "prh",
        sourceRecordId: `9785${String(i).padStart(9, "0")}`,
        snapshot: { kind: "prhTitle" },
        lastSeenAt: 0,
        withdrawn: true,
      });
    }
    await book(authorFirst, "9789999999998", "Adaptation and Artwork by Gou Tanabe");
    await book(artFirst, "9789999999999", "Gou Tanabe");
    return { authorFirst, artFirst };
  });
  await t.action(internal.people.rebuild, {});
  return { t, ids };
}

describe("people.rebuild when the publisher pass fails", () => {
  it("still sweeps ANN's stale rows and refreshes stats, keeping publisher rows, then throws", async () => {
    const { t, ids } = await publisherCatalog();
    await t.run(async (ctx) => {
      // ANN no longer credits One Piece; a PRH line now breaks the pass.
      const ann = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:1"))
        .unique();
      await ctx.db.patch(ann!._id, { withdrawn: true });
      const ruin = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "prh").eq("sourceRecordId", "9781646516650"))
        .unique();
      await ctx.db.patch(ruin!._id, { snapshot: { kind: "prhTitle", author: "THROW" } });
    });
    await expect(t.action(internal.people.rebuild, {})).rejects.toThrow("publisher pass failed");
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

describe("people.rebuild across publisher batches", () => {
  it("keeps one row per person through a run, whichever role comes first", async () => {
    const { t, ids } = await twoBatchCatalog();
    const rows = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("seriesCredits").collect()).map((row) => `${row._id} ${row.role}`).sort(),
      );
    expect(await creditLines(t, ids.authorFirst)).toEqual(["Gou Tanabe: art (prh)"]);
    expect(await creditLines(t, ids.artFirst)).toEqual(["Gou Tanabe: art (prh)"]);
    const before = await rows();
    // A later run, batch by batch: no row is added or replaced in between.
    const rebuiltAt = Date.now() + 1000;
    let after: string | null = null;
    let batches = 0;
    for (;;) {
      const batch: { next: string | null } = await t.mutation(internal.people.publisherBatch, {
        sourceKey: "prh",
        after,
        rebuiltAt,
      });
      batches++;
      expect(await rows()).toEqual(before);
      if (batch.next === null) break;
      after = batch.next;
    }
    expect(batches).toBe(2);
  });
});

describe("mergeRoles and nameKey", () => {
  it("merges a person's roles on a Series into one", () => {
    expect(mergeRoles(["story", "art"])).toBe("story_art");
    expect(mergeRoles(["author", "story"])).toBe("story");
    expect(mergeRoles(["author", "original"])).toBe("original");
    expect(mergeRoles(["original", "art"])).toBe("art");
    expect(mergeRoles(["author"])).toBe("author");
  });

  it("folds case, accents, spacing, punctuation, and name order", () => {
    expect(nameKey("  Eiichirō   Oda ")).toBe(nameKey("eiichiro oda"));
    expect(nameKey("Masamune Shirow")).toBe(nameKey("Shirow Masamune"));
    expect(nameKey("In-Wan Youn")).toBe(nameKey("Inwan Youn"));
    expect(nameKey("Dr. Pepperco")).toBe(nameKey("Dr pepperco"));
    expect(nameKey("Tetsuya Chiba")).not.toBe(nameKey("Tetsuya Chiba Jr"));
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
    expect(requested).toEqual(["https://cdn.animenewsnetwork.com/encyclopedia/api.xml?manga=30000"]);
    const snapshot = await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) => q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:30000"))
        .unique();
      return doc?.snapshot;
    });
    expect(snapshot).toMatchObject({
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
