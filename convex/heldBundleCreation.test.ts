import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { insertBook } from "./test.moderation";
import {
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, makeT, seedTeam } from "./test.helpers";

async function fixture() {
  const t = makeT();
  await seedTeam(t, [alice]);
  const args = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
    const seriesId = await insertSeries(ctx, { title: "Naruto" });
    const volumeIds = [],
      memberIds = [];
    const memberIsbn13s = ["9781569319000", "9781591161783"];
    for (const [i, isbn13] of memberIsbn13s.entries()) {
      const volumeId = await insertVolume(ctx, { seriesId, label: String(i + 1), position: i + 1 });
      const book = await insertBook(ctx, {
        seriesId,
        publisherId,
        volumeId,
        release: { isbn13, format: "physical", binding: "paperback" },
      });
      volumeIds.push(volumeId);
      memberIds.push(book.releaseId);
    }
    await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "manga:11",
      snapshot: { kind: "annManga", id: "11", title: "Naruto" },
      recordRef: { type: "series", id: seriesId },
    });
    const observationId = await insertObservation(ctx, {
      sourceKey: "ann",
      sourceRecordId: "release:22",
      snapshot: {
        kind: "annRelease",
        annId: "22",
        mangaId: "11",
        title: "Naruto Box Set 1",
        isbn13: "9781421525822",
        format: "physical",
        multi: true,
        editionLineHint: true,
        coverRange: { from: "1", to: "2" },
        page: {
          status: "ok",
          title: "Naruto Box Set 1",
          isbn13: "9781421525822",
          mangaId: "11",
          volume: "GN 1-2",
          distributor: "VIZ Media",
        },
      },
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: "ann",
      kind: "packaging",
      seriesId,
      heldAt: 1,
    });
    return {
      observationId,
      publisherId,
      seriesId,
      memberIds,
      memberIsbn13s,
      volumeIds,
      name: "Naruto Box Set 1",
      isbn13: "9781421525822",
      evidenceUrls: ["https://www.viz.com/naruto-box-set"],
    };
  });
  return { t, args };
}

it("dry runs roll back bundle, memberships, allocator and audit; stale dependencies refuse", async () => {
  const { t, args } = await fixture();
  const before = await t.run(async (ctx) => ({
    bundles: await ctx.db.query("releaseBundles").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    ids: await ctx.db.query("counters").collect(),
  }));
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  const execution = {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Reviewed exact ordered print members",
    dryRun: true,
  };
  expect(await t.mutation(internal.heldBundleCreation.createInternal, execution)).toEqual({
    status: "dryRun",
  });
  const after = await t.run(async (ctx) => ({
    bundles: await ctx.db.query("releaseBundles").collect(),
    proposals: await ctx.db.query("proposals").collect(),
    ids: await ctx.db.query("counters").collect(),
  }));
  expect(after).toEqual(before);
  expect(await t.run((ctx) => ctx.db.query("bundleMemberships").collect())).toEqual([]);
  await t.run((ctx) => ctx.db.patch(args.memberIds[0]!, { binding: "hardcover" }));
  const drift = await t.mutation(internal.heldBundleCreation.createInternal, {
    ...execution,
    dryRun: false,
  });
  expect(drift).toMatchObject({ status: "refused" });
  expect(await t.run((ctx) => ctx.db.query("releaseBundles").collect())).toEqual([]);
});

it("rejects duplicate members, incomplete contents and claimed package ISBNs", async () => {
  const { t, args } = await fixture();
  expect(
    (
      await t.query(internal.heldBundleCreation.previewInternal, {
        ...args,
        memberIds: [args.memberIds[0]!, args.memberIds[0]!],
      })
    ).refusal,
  ).toMatch(/distinct/);
  await t.run(async (ctx) => {
    const release = await ctx.db.get(args.memberIds[0]!);
    await ctx.db.patch(release!.editionId, { coverageUnmapped: true });
  });
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toMatch(
    /unmapped/,
  );
});

it("bounds repeated large work facts while refusing a changed dependency", async () => {
  const { t, args } = await fixture();
  await t.run((ctx) => ctx.db.patch(args.seriesId, { synopsis: "a".repeat(40_000) }));
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  expect(new TextEncoder().encode(preview.expected!).length).toBeLessThan(256 * 1024);
  const execution = {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Reviewed large work dependencies",
    dryRun: true,
  };
  expect(await t.mutation(internal.heldBundleCreation.createInternal, execution)).toEqual({
    status: "dryRun",
  });
  await t.run((ctx) => ctx.db.patch(args.seriesId, { synopsis: "b".repeat(40_000) }));
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, { ...execution, dryRun: false }),
  ).toMatchObject({ status: "refused", reason: expect.stringMatching(/dependencies changed/) });
  expect(await t.run((ctx) => ctx.db.query("releaseBundles").collect())).toEqual([]);
});

it("creates audited ordered members without clearing the hold, then refuses the occupied package ISBN", async () => {
  const { t, args } = await fixture();
  const preview = await t.query(internal.heldBundleCreation.previewInternal, args);
  expect(preview.refusal).toBeNull();
  const result = await t.mutation(internal.heldBundleCreation.createInternal, {
    ...args,
    expected: preview.expected!,
    actor: "alice",
    reason: "Primary exact package and member ISBN review",
    dryRun: false,
  });
  expect(result.status).toBe("created");
  const members = await t.run((ctx) => ctx.db.query("bundleMemberships").collect());
  expect(members.map((m) => ({ releaseId: m.releaseId, order: m.order }))).toEqual(
    args.memberIds.map((releaseId, i) => ({ releaseId, order: i + 1 })),
  );
  expect(await t.run((ctx) => ctx.db.query("placementHolds").collect())).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(1);
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toMatch(
    /unowned/,
  );
});

it("compares a new box position with the package, not the individual member Edition Lines", async () => {
  const { t, args } = await fixture();
  expect((await t.query(internal.heldBundleCreation.previewInternal, args)).refusal).toBeNull();
  expect(
    (
      await t.query(internal.heldBundleCreation.previewInternal, {
        ...args,
        name: "Naruto Box Set 2",
      })
    ).refusal,
  ).toMatch(/position differs/);
});

it("reviews a Complete Box Set qualifier only with resolved source work and full member contents", async () => {
  const { t, args } = await fixture();
  const snapshot = {
    kind: "olEdition",
    key: "/books/OL1M",
    url: "https://openlibrary.org/books/OL1M",
    title: "Naruto Complete Box Set",
    seriesTitle: "Naruto",
    isbn13: args.isbn13,
    format: "physical",
    multiVolume: false,
    publishers: ["VIZ Media"],
    packaging: { lineName: "Box Set", linePosition: null, coverRange: null },
  };
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      sourceKey: "openlibrary",
      sourceRecordId: snapshot.key,
      snapshot,
    }),
  );
  const product = { ...args, name: "Naruto Complete Box Set" };
  const preview = await t.query(internal.heldBundleCreation.previewInternal, product);
  expect(preview.refusal).toBeNull();
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, {
      ...product,
      expected: preview.expected!,
      actor: "alice",
      reason: "Publisher exact package and complete member review",
      dryRun: true,
    }),
  ).toEqual({ status: "dryRun" });
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      snapshot: { ...snapshot, title: "Bleach Complete Box Set" },
    }),
  );
  expect((await t.query(internal.heldBundleCreation.previewInternal, product)).refusal).toMatch(
    /contradict/,
  );
});

it("pins the exact Open Library title when a box's work differs only by a leading article", async () => {
  const { t, args } = await fixture();
  const title = "The Naruto Complete Box Set";
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      sourceKey: "openlibrary",
      sourceRecordId: "/books/OL1M",
      snapshot: {
        kind: "olEdition",
        key: "/books/OL1M",
        url: "https://openlibrary.org/books/OL1M",
        title,
        seriesTitle: "Naruto",
        isbn13: args.isbn13,
        format: "physical",
        multiVolume: false,
        publishers: ["VIZ Media"],
        packaging: { lineName: "Box Set", linePosition: null, coverRange: null },
      },
    }),
  );
  // The publisher's own name needs the reviewer's exact source title beside it.
  const named = { ...args, name: "Naruto Complete Box Set" };
  expect((await t.query(internal.heldBundleCreation.previewInternal, named)).refusal).toMatch(
    /Known source work/,
  );
  const reviewed = { ...named, sourceTitle: title };
  const preview = await t.query(internal.heldBundleCreation.previewInternal, reviewed);
  expect(preview.refusal).toBeNull();
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, {
      ...reviewed,
      expected: preview.expected!,
      actor: "alice",
      reason: "VIZ product name; Open Library title reviewed",
      dryRun: true,
    }),
  ).toEqual({ status: "dryRun" });
});

it.each(["The Naruto Complete Box Set", "Naruto Manga Box Set 1"])(
  "reviews %s without changing raw source facts or accepting another work",
  async (title) => {
    const { t, args } = await fixture();
    const snapshot = {
      kind: "olEdition",
      key: "/books/OL1M",
      url: "https://openlibrary.org/books/OL1M",
      title,
      seriesTitle: "Naruto",
      isbn13: args.isbn13,
      format: "physical",
      multiVolume: false,
      publishers: ["VIZ Media"],
      packaging: {
        lineName: "Box Set",
        linePosition: title.endsWith("1") ? "1" : null,
        coverRange: null,
      },
    };
    await t.run((ctx) =>
      ctx.db.patch(args.observationId, {
        sourceKey: "openlibrary",
        sourceRecordId: snapshot.key,
        snapshot,
      }),
    );
    const product = { ...args, name: title };
    const preview = await t.query(internal.heldBundleCreation.previewInternal, product);
    expect(preview.refusal).toBeNull();
    expect(
      await t.mutation(internal.heldBundleCreation.createInternal, {
        ...product,
        expected: preview.expected!,
        actor: "alice",
        reason: "Reviewed exact box and ordered contents",
        dryRun: true,
      }),
    ).toEqual({ status: "dryRun" });
    expect((await t.run((ctx) => ctx.db.get(args.observationId)))!.snapshot).toEqual(snapshot);
    for (const changed of [
      { ...snapshot, seriesTitle: "Bleach" },
      { ...snapshot, title: title.replace("Naruto", "Bleach") },
      { ...snapshot, title: title.replace("Naruto", "Naruto Novel") },
      { ...snapshot, coverageGapped: true },
    ]) {
      await t.run((ctx) => ctx.db.patch(args.observationId, { snapshot: changed }));
      expect(
        (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
        JSON.stringify(changed),
      ).not.toBeNull();
    }
  },
);

/** The fixture's ANN line retitled as a qualified box stating its own range. */
async function annBox(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  args: Awaited<ReturnType<typeof fixture>>["args"],
  title: string,
  range = { from: "1", to: "2" },
) {
  await t.run(async (ctx) => {
    const observation = (await ctx.db.get(args.observationId))!;
    const snapshot = observation.snapshot as { page: Record<string, unknown> };
    await ctx.db.patch(args.observationId, {
      snapshot: {
        ...snapshot,
        title,
        coverRange: range,
        page: { ...snapshot.page, title, volume: `GN ${range.from}-${range.to}` },
      },
    });
  });
  return { ...args, name: title };
}

it("reviews an ANN Complete Box Set only when every active Volume is its stated range", async () => {
  const { t, args } = await fixture();
  const product = await annBox(t, args, "Naruto - Complete Box Set");
  const preview = await t.query(internal.heldBundleCreation.previewInternal, product);
  expect(preview.refusal).toBeNull();
  const created = await t.mutation(internal.heldBundleCreation.createInternal, {
    ...product,
    expected: preview.expected!,
    actor: "alice",
    reason: "VIZ states Naruto Complete Box Set collects Vols. 1-2",
    dryRun: false,
  });
  expect(created.status).toBe("created");
  const bundleId = "bundleId" in created ? created.bundleId : null;
  // The existing bundle links from a fresh reviewed preview; the hold is still there.
  const link = {
    observationId: args.observationId,
    target: { type: "bundle" as const, id: bundleId! },
    reviewed: {
      isbn13: args.isbn13,
      seriesId: args.seriesId,
      publisherId: args.publisherId,
      volumeIds: args.volumeIds,
      sourceTitle: product.name,
      evidenceUrls: args.evidenceUrls,
    },
  };
  expect((await t.query(internal.heldBooks.previewInternal, link)).refusal).toBeNull();
  expect(
    (await t.query(internal.heldBooks.previewInternal, { ...link, reviewed: undefined })).refusal,
  ).toBeTruthy();
  // The package ISBN is now occupied: a second creation refuses.
  expect((await t.query(internal.heldBundleCreation.previewInternal, product)).refusal).toMatch(
    /unowned/,
  );
  // A Volume the box does not hold makes "Complete" false for the link too.
  await t.run((ctx) => insertVolume(ctx, { seriesId: args.seriesId, label: "3", position: 3 }));
  expect((await t.query(internal.heldBooks.previewInternal, link)).refusal).toMatch(
    /Known ANN work/,
  );
});

it("refuses a qualified ANN box whose range, work or qualifier does not agree", async () => {
  for (const [title, range, extra] of [
    // ANN's own range is spoofed past the members.
    ["Naruto - Complete Box Set", { from: "1", to: "3" }, null],
    ["Naruto - Complete Box Set", { from: "2", to: "3" }, null],
    // Another work, a sequel or spin-off named as the qualifier, or a variant package.
    ["Boruto - Complete Box Set", undefined, null],
    ["Naruto - Boruto Box Set", undefined, "Boruto: Naruto Next Generations"],
    ["Naruto - Shippuden Box Set", undefined, "Naruto: Shippuden"],
    ["Naruto - Premium Box Set", undefined, null],
    ["Naruto - Part 1 Box Set", undefined, null],
    ["Naruto - Novel Box Set", undefined, null],
  ] as const) {
    const { t, args } = await fixture();
    if (extra) await t.run((ctx) => insertSeries(ctx, { title: extra }));
    const product = await annBox(t, args, title, range);
    expect(
      (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
      `${title} ${JSON.stringify(range)}`,
    ).toBeTruthy();
  }
});

it("reviews an ANN arc or anniversary box without renaming the work or its source", async () => {
  for (const title of ["Naruto - Land of Waves Box Set", "Naruto - 20th Anniversary Box Set"]) {
    const { t, args } = await fixture();
    const product = await annBox(t, args, title);
    const before = await t.run(async (ctx) => (await ctx.db.get(args.observationId))!.snapshot);
    expect(
      (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
    ).toBeNull();
    // The creation packet's name must be ANN's exact title.
    expect(
      (
        await t.query(internal.heldBundleCreation.previewInternal, {
          ...product,
          name: "Naruto Box Set",
        })
      ).refusal,
    ).toBeTruthy();
    // A third member past ANN's range is not the reviewed package.
    await t.run(async (ctx) => {
      expect((await ctx.db.get(args.observationId))!.snapshot).toEqual(before);
      expect((await ctx.db.get(args.seriesId))!.title).toBe("Naruto");
    });
  }
});

it("pins a creation's exact ANN title in sourceTitle while the Bundle keeps the publisher's name", async () => {
  const { t, args } = await fixture();
  const product = await annBox(t, args, "Naruto - Complete Box Set");
  const named = { ...product, name: "Naruto Complete Box Set" };
  expect((await t.query(internal.heldBundleCreation.previewInternal, named)).refusal).toBeTruthy();
  const reviewed = { ...named, sourceTitle: "Naruto - Complete Box Set" };
  const preview = await t.query(internal.heldBundleCreation.previewInternal, reviewed);
  expect(preview.refusal).toBeNull();
  expect(
    await t.mutation(internal.heldBundleCreation.createInternal, {
      ...reviewed,
      expected: preview.expected!,
      actor: "alice",
      reason: "VIZ product name; ANN title reviewed",
      dryRun: true,
    }),
  ).toEqual({ status: "dryRun" });
  for (const sourceTitle of ["Naruto - Complete Box Set 2", "Naruto Complete Box Set", " "]) {
    expect(
      (await t.query(internal.heldBundleCreation.previewInternal, { ...named, sourceTitle }))
        .refusal,
      sourceTitle,
    ).toBeTruthy();
  }
});

it("refuses a member whose Volume has another current printing that could be the packed copy", async () => {
  const rival = async (binding: string | undefined, line: boolean) => {
    const { t, args } = await fixture();
    await t.run(async (ctx) => {
      // A second same-publisher single printing of Volume 2 (Vampire Knight 19's limited printing).
      const book = await insertBook(ctx, {
        seriesId: args.seriesId,
        publisherId: args.publisherId,
        volumeId: args.volumeIds[1]!,
        release: { isbn13: "9781421576053", format: "physical", ...(binding ? { binding } : {}) },
      });
      if (line) {
        const lineId = await insertEditionLine(ctx, {
          seriesId: args.seriesId,
          publisherId: args.publisherId,
          name: "Library Edition",
        });
        await ctx.db.patch(book.editionId, { editionLineId: lineId, linePosition: "2" });
      }
    });
    return (await t.query(internal.heldBundleCreation.previewInternal, args)).refusal;
  };
  expect(await rival("paperback", false)).toMatch(/could be the packed copy/);
  expect(await rival(undefined, false)).toMatch(/could be the packed copy/);
  // Another Binding or Edition Line is another product, never a rival member.
  expect(await rival("hardcover", false)).toBeNull();
  expect(await rival("paperback", true)).toBeNull();
});

it("refuses a member whose own Edition has another compatible physical printing", async () => {
  const sameEdition = async (
    member: string | undefined,
    other: string | undefined,
    isbn13: string | undefined = "9781421576053",
  ) => {
    const { t, args } = await fixture();
    await t.run(async (ctx) => {
      const release = (await ctx.db.get(args.memberIds[1]!))!;
      await ctx.db.patch(release._id, { binding: member });
      await insertRelease(ctx, {
        editionId: release.editionId,
        publisherId: args.publisherId,
        seriesIds: [args.seriesId],
        format: "physical",
        ...(isbn13 ? { isbn13 } : {}),
        ...(other ? { binding: other } : {}),
      });
    });
    return (await t.query(internal.heldBundleCreation.previewInternal, args)).refusal;
  };
  expect(await sameEdition("paperback", "paperback")).toMatch(/could be the packed copy/);
  // An unknown Binding on either side, or a duplicate row with no ISBN, is just as ambiguous.
  expect(await sameEdition("paperback", undefined)).toMatch(/could be the packed copy/);
  expect(await sameEdition(undefined, "paperback")).toMatch(/could be the packed copy/);
  expect(await sameEdition("paperback", "paperback", undefined)).toMatch(
    /could be the packed copy/,
  );
  // A hardcover beside the paperback is another product, not the packed copy.
  expect(await sameEdition("paperback", "hardcover")).toBeNull();
});

it("compares a rival's Publisher and Edition Line through their merges", async () => {
  type Args = Awaited<ReturnType<typeof fixture>>["args"];
  const rival = async (
    point: (
      ctx: MutationCtx,
      args: Args,
      lineId: Id<"editionLines">,
    ) => Promise<{ publisherId: Id<"publishers">; editionLineId: Id<"editionLines"> }>,
  ) => {
    const { t, args } = await fixture();
    await t.run(async (ctx) => {
      // The member sits in a Line; the rival Edition's references may be stale duplicates.
      const lineId = await insertEditionLine(ctx, {
        seriesId: args.seriesId,
        publisherId: args.publisherId,
        name: "3-in-1 Edition",
      });
      const member = (await ctx.db.get(args.memberIds[1]!))!;
      await ctx.db.patch(member.editionId, { editionLineId: lineId, linePosition: "2" });
      const refs = await point(ctx, args, lineId);
      await insertBook(ctx, {
        seriesId: args.seriesId,
        publisherId: refs.publisherId,
        volumeId: args.volumeIds[1]!,
        edition: { editionLineId: refs.editionLineId, linePosition: "2" },
        release: { isbn13: "9781421576053", format: "physical", binding: "paperback" },
      });
    });
    return (await t.query(internal.heldBundleCreation.previewInternal, args)).refusal;
  };
  // A duplicate Publisher and Line merged into the member's still name the same product.
  expect(
    await rival(async (ctx, args, lineId) => {
      const publisherId = await insertPublisher(ctx, {
        name: "Viz",
        slug: "viz",
        status: "merged",
        mergedIntoId: args.publisherId,
      });
      const editionLineId = await insertEditionLine(ctx, {
        seriesId: args.seriesId,
        publisherId,
        name: "3-in-1",
        status: "merged",
        mergedIntoId: lineId,
      });
      return { publisherId, editionLineId };
    }),
  ).toMatch(/could be the packed copy/);
  // A merge chain that cannot be followed refuses rather than skipping the rival.
  expect(
    await rival(async (ctx, _args, lineId) => {
      const publisherId = await insertPublisher(ctx, { name: "Viz", slug: "viz" });
      await ctx.db.patch(publisherId, { status: "merged" });
      return { publisherId, editionLineId: lineId };
    }),
  ).toMatch(/merge chain cannot be followed/);
  // Another, unmerged Line of the same publisher is another product.
  expect(
    await rival(async (ctx, args) => ({
      publisherId: args.publisherId,
      editionLineId: await insertEditionLine(ctx, {
        seriesId: args.seriesId,
        publisherId: args.publisherId,
        name: "Library Edition",
      }),
    })),
  ).toBeNull();
});

it("refuses an ANN box qualifier naming a companion book or media product", async () => {
  for (const title of [
    "Naruto - Artbook Box Set",
    "Naruto - Art Book Box Set",
    "Naruto - Illustrations Box Set",
    "Naruto - Poster Box Set",
    "Naruto - Fanbook Box Set",
    "Naruto - Guidebook Box Set",
    "Naruto - Databook Box Set",
    "Naruto - Character Book Box Set",
    "Naruto - Anime Box Set",
    "Naruto - DVD Box Set",
    "Naruto - Blu-ray Box Set",
    "Naruto - Soundtrack Box Set",
    "Naruto - Sticker Box Set",
    "Naruto - Figure Box Set",
    "Naruto - Bonus Box Set",
    "Naruto - Exclusive Box Set",
    "Naruto - Gift Box Set",
  ]) {
    const { t, args } = await fixture();
    const product = await annBox(t, args, title);
    expect(
      (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
      title,
    ).toBeTruthy();
  }
});

it("refuses a qualified ANN box with no stated range or another ANN parent", async () => {
  const { t, args } = await fixture();
  const product = await annBox(t, args, "Naruto - Complete Box Set");
  expect((await t.query(internal.heldBundleCreation.previewInternal, product)).refusal).toBeNull();
  const stored = await t.run(async (ctx) => (await ctx.db.get(args.observationId))!.snapshot);
  const { coverRange: _range, ...unranged } = stored as Record<string, unknown>;
  await t.run((ctx) =>
    ctx.db.patch(args.observationId, {
      snapshot: { ...unranged, page: { ...(stored as { page: object }).page, volume: "GN" } },
    }),
  );
  expect(
    (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
  ).toBeTruthy();
  await t.run((ctx) => ctx.db.patch(args.observationId, { snapshot: stored }));
  await t.run(async (ctx) => {
    const [parent] = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "ann").eq("sourceRecordId", "manga:11"),
      )
      .collect();
    await ctx.db.patch(parent!._id, { snapshot: { kind: "annManga", id: "11", title: "Boruto" } });
  });
  expect(
    (await t.query(internal.heldBundleCreation.previewInternal, product)).refusal,
  ).toBeTruthy();
});
