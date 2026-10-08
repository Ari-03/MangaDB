import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { makeT, type TestT } from "./test.helpers";
import {
  insertBundle,
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { checkEvidence, type UnmappedLinkProof } from "./lib/unmappedLink";
import * as observations from "./lib/observations";
import { valueHash } from "./lib/values";

// Source snapshots are the live staging records (2026-10-07) of three ready books:
// one Open Library, one Kodansha and one ANN source, each with its own adapter path.
const OL_YUGIOH_5 = {
  format: "physical",
  isbn13: "9781421579283",
  key: "/books/OL29283413M",
  kind: "olEdition",
  multiVolume: false,
  publishDate: { year: 2016 },
  publishers: ["Viz Media"],
  seriesTitle: "Yu-Gi-Oh!",
  title: "Yu-Gi-Oh! , Vol. 5",
  url: "https://openlibrary.org/books/OL29283413M",
  volumeLabel: "5",
};
const KODANSHA_SAILOR_V_2 = {
  binding: "paperback",
  creators: ["Naoko Takeuchi"],
  format: "physical",
  isbn13: "9781646511440",
  kind: "kodanshaVolume",
  packaging: { coverRange: null, lineName: "Eternal Edition", linePosition: "2" },
  priceCents: 2799,
  releaseDate: { day: 9, month: 11, year: 2021 },
  seriesSlug: "codename-sailor-v-eternal-edition",
  seriesTitle: "Codename: Sailor V",
  seriesUrl: "https://kodansha.us/series/codename-sailor-v-eternal-edition/",
  title: "Codename: Sailor V Eternal Edition Volume 2",
  url: "https://kodansha.us/series/codename-sailor-v-eternal-edition/volume-2/",
};
const ANN_GUNSMITH_2 = {
  annId: "8139",
  date: { day: 30, month: 5, year: 2007 },
  editionLineHint: false,
  format: "physical",
  isbn13: "9781593077686",
  kind: "annRelease",
  label: "2",
  mangaId: "2916",
  multi: false,
  page: {
    date: { day: 30, month: 5, year: 2007 },
    distributor: "Dark Horse Comics",
    distributorId: "26",
    fetchedAt: 1790506987372,
    isbn10: "1593077688",
    isbn13: "9781593077686",
    mangaId: "2916",
    priceCents: 1695,
    status: "ok",
    title: "Gunsmith Cats [Revised Edition]",
    volume: "GN 2 / 4",
  },
  title: "Gunsmith Cats [Revised Edition]",
  url: "https://www.animenewsnetwork.com/encyclopedia/releases.php?id=8139",
};

type Kind = "ol" | "kodansha" | "ann";
const SHA = "a".repeat(64);
const SPEC = {
  ol: {
    publisher: { name: "VIZ Media", slug: "viz-media" },
    series: { title: "Yu-Gi-Oh!", altTitles: ["Game King"] },
    line: "3-in-1 Edition",
    position: "5",
    binding: undefined,
    isbn13: "9781421579283",
    snapshot: OL_YUGIOH_5,
    source: { sourceKey: "openlibrary", sourceRecordId: "/books/OL29283413M" },
    parent: null,
    hold: "isbn",
    sourceLabel: "linePosition",
    title: "Yu-Gi-Oh! (3-in-1 Edition), Vol. 5",
    excerpt: "Yu-Gi-Oh! (3-in-1 Edition), Vol. 5. ISBN 9781421579283. Paperback, 576 pages.",
    statesPublisher: undefined,
    url: "https://www.simonandschuster.com/books/Yu-Gi-Oh-3-in-1-Edition-Vol-5/Kazuki-Takahashi/9781421579283",
  },
  kodansha: {
    publisher: { name: "Kodansha", slug: "kodansha" },
    series: { title: "Codename: Sailor V", altTitles: ["Sailor V"] },
    line: "Eternal Edition",
    position: "2",
    binding: "paperback",
    isbn13: "9781646511440",
    snapshot: KODANSHA_SAILOR_V_2,
    source: {
      sourceKey: "kodansha",
      sourceRecordId: "codename-sailor-v-eternal-edition/volume-2#physical",
    },
    parent: {
      sourceKey: "kodansha",
      sourceRecordId: "series:codename-sailor-v-eternal-edition",
      snapshot: {
        kind: "series",
        slug: "codename-sailor-v-eternal-edition",
        title: "Codename: Sailor V",
        url: "https://kodansha.us/series/codename-sailor-v-eternal-edition/",
      },
    },
    hold: "packaging",
    sourceLabel: "none",
    title: "Codename: Sailor V Eternal Edition 2",
    // kodansha.us names no publisher, so a publisher-side page must.
    excerpt:
      "Codename: Sailor V Eternal Edition 2. ISBN 9781646511440. Paperback. Published by Kodansha Comics",
    statesPublisher: "Kodansha Comics",
    url: "https://www.penguinrandomhouse.com/books/9781646511440",
  },
  ann: {
    publisher: { name: "Dark Horse", slug: "dark-horse" },
    series: { title: "Gunsmith Cats", altTitles: [] },
    line: "Revised Edition",
    position: "2",
    binding: "paperback",
    isbn13: "9781593077686",
    snapshot: ANN_GUNSMITH_2,
    source: { sourceKey: "ann", sourceRecordId: "release:8139" },
    parent: {
      sourceKey: "ann",
      sourceRecordId: "manga:2916",
      snapshot: { kind: "annManga", id: "2916", title: "Gunsmith Cats" },
    },
    hold: "isbn",
    sourceLabel: "linePosition",
    title: "Gunsmith Cats Revised Edition Volume 2",
    excerpt: "Gunsmith Cats Revised Edition Volume 2. ISBN-13: 978-1-59307-768-6. Paperback.",
    statesPublisher: undefined,
    url: "https://www.darkhorse.com/Books/12-345/Gunsmith-Cats-Revised-Edition-Volume-2-TPB",
  },
} as const;

async function fixture(kind: Kind, t = makeT()) {
  const spec = SPEC[kind];
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "admin",
      username: "ari",
      usernameNormalized: "ari",
      role: "administrator",
      formatPreference: "both",
      ownershipVisibility: "private",
      readingVisibility: "private",
    });
    const publisherId = await insertPublisher(ctx, spec.publisher);
    const seriesId = await insertSeries(ctx, {
      ...spec.series,
      altTitles: [...spec.series.altTitles],
    });
    const parentId = spec.parent
      ? await insertObservation(ctx, {
          ...spec.parent,
          recordRef: { type: "series", id: seriesId },
        })
      : null;
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: spec.line });
    // A neighbouring numbered member: the Line is a real numbered family.
    const neighbourId = await insertEdition(ctx, {
      publisherId,
      editionLineId: lineId,
      linePosition: "1",
      coverageUnmapped: true,
    });
    const editionId = await insertEdition(ctx, {
      publisherId,
      editionLineId: lineId,
      linePosition: spec.position,
      coverageUnmapped: true,
    });
    const releaseId = await insertRelease(ctx, {
      editionId,
      publisherId,
      seriesIds: [seriesId],
      isbn13: spec.isbn13,
      ...(spec.binding ? { binding: spec.binding } : {}),
    });
    const observationId = await insertObservation(ctx, {
      ...spec.source,
      snapshot: spec.snapshot,
      conflicts: [
        { field: "placement", at: 1, reason: "ISBN owned by unmapped Edition", offered: null },
      ],
    });
    await ctx.db.insert("placementHolds", {
      observationId,
      sourceKey: spec.source.sourceKey,
      kind: spec.hold,
      heldAt: 1,
      ...(spec.parent ? {} : { seriesId }),
    });
    return {
      publisherId,
      seriesId,
      parentId,
      lineId,
      neighbourId,
      editionId,
      releaseId,
      observationId,
    };
  });
  return { t, kind, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function proof(f: Fixture, overrides: Partial<UnmappedLinkProof> = {}): UnmappedLinkProof {
  const spec = SPEC[f.kind];
  return {
    isbn13: spec.isbn13,
    seriesId: f.seriesId,
    publisherId: f.publisherId,
    editionLineId: f.lineId,
    lineName: spec.line,
    linePosition: spec.position,
    format: "physical",
    binding: spec.binding ?? null,
    sourceTitle: spec.snapshot.title,
    sourceLabel: spec.sourceLabel,
    evidence: [
      {
        url: spec.url,
        sha256: SHA,
        capturedAt: 1791400000000,
        excerpt: spec.excerpt,
        statesProductTitle: spec.title,
        statesIsbn13: spec.isbn13,
        statesLineName: spec.line,
        statesLinePosition: spec.position,
        ...(spec.binding ? { statesBinding: spec.binding } : {}),
        ...(spec.statesPublisher ? { statesPublisher: spec.statesPublisher } : {}),
      },
    ],
    reason:
      "Publisher own-ISBN page names this exact Line product; original coverage stays unmapped.",
    ...overrides,
  };
}
const args = (f: Fixture, overrides: Partial<UnmappedLinkProof> = {}) => ({
  observationId: f.observationId,
  releaseId: f.releaseId,
  proof: proof(f, overrides),
});
const preview = (f: Fixture, overrides: Partial<UnmappedLinkProof> = {}) =>
  f.t.query(internal.heldRepair.previewUnmappedLinkInternal, args(f, overrides));
const execute = (f: Fixture, expected: string, overrides: Partial<UnmappedLinkProof> = {}) =>
  f.t.mutation(internal.heldRepair.linkUnmappedProductInternal, {
    ...args(f, overrides),
    actor: "ari",
    expected,
  });

async function dump(t: TestT) {
  return await t.run(async (ctx) => {
    const tables = [
      "sourceObservations",
      "placementHolds",
      "editionLines",
      "editions",
      "volumeCoverages",
      "releases",
      "releaseIsbns",
      "proposals",
      "proposalVersions",
      "revisions",
      "heldRepairLedger",
      "series",
    ] as const;
    return valueHash(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
  });
}
/** The preview refuses with `reason`, and so does an execute with any guard, writing nothing. */
async function refuses(f: Fixture, reason: string, overrides: Partial<UnmappedLinkProof> = {}) {
  const before = await dump(f.t);
  const p = await preview(f, overrides);
  expect(p.expected).toBeNull();
  expect(p.refusal).toContain(reason);
  const result = await execute(f, "stale", overrides);
  expect(result.status).toBe("refused");
  expect(await dump(f.t)).toBe(before);
}
async function product(f: Fixture) {
  return await f.t.run(async (ctx) => ({
    release: await ctx.db.get(f.releaseId),
    edition: await ctx.db.get(f.editionId),
    line: await ctx.db.get(f.lineId),
    coverage: await ctx.db.query("volumeCoverages").collect(),
  }));
}

describe("G1 identity-only link to an unmapped exact-ISBN owner", () => {
  for (const kind of ["ol", "kodansha", "ann"] as const) {
    it(`${kind}: links, keeps the product and its unknown contents, verifies retries, restores`, async () => {
      const f = await fixture(kind);
      const before = await product(f);
      const p = await preview(f);
      expect(p.refusal).toBeNull();
      expect(p.action).toBe("link");
      const result = await execute(f, p.expected!);
      expect(result.status).toBe("linked");
      const after = await f.t.run(async (ctx) => ({
        observation: await ctx.db.get(f.observationId),
        holds: await ctx.db.query("placementHolds").collect(),
        ledger: await ctx.db.query("heldRepairLedger").collect(),
        revisions: await ctx.db.query("revisions").collect(),
        proposal: await ctx.db.get(result.proposalId!),
      }));
      expect(after.observation?.recordRef).toEqual({ type: "release", id: f.releaseId });
      expect(after.observation?.conflicts).toEqual([]);
      expect(after.holds).toEqual([]);
      // No coverage, Release, Edition or Line write; only the source link's revision.
      expect(await product(f)).toEqual(before);
      expect(before.edition?.coverageUnmapped).toBe(true);
      expect(after.revisions.map((r) => [r.ref, r.changes.map((c) => c.field)])).toEqual([
        [{ type: "release", id: f.releaseId }, ["sourceObservation"]],
      ]);
      expect(after.proposal?.state).toBe("approved");
      expect(after.ledger).toHaveLength(1);
      expect(after.ledger[0]).toMatchObject({
        operation: "linkUnmappedProduct",
        target: { type: "release", id: f.releaseId },
      });
      // A verified receipt answers a retry, with no second write.
      const snapshot = await dump(f.t);
      const again = await preview(f);
      expect(again.action).toBe("alreadyApplied");
      expect(await execute(f, again.expected!)).toMatchObject({
        status: "alreadyApplied",
        ledgerId: after.ledger[0]!._id,
      });
      expect(await dump(f.t)).toBe(snapshot);
      // heldBooks' metadata restore reads this ledger and returns the hold.
      await f.t.mutation(internal.heldBooks.restoreInternal, {
        actor: "ari",
        ledgerId: after.ledger[0]!._id,
        expectedAfter: after.ledger[0]!.after,
        reason: "Test restore.",
      });
      const restored = await f.t.run(async (ctx) => ({
        observation: await ctx.db.get(f.observationId),
        holds: await ctx.db.query("placementHolds").collect(),
      }));
      expect(restored.observation?.recordRef).toBeUndefined();
      expect(restored.holds).toHaveLength(1);
      expect(await product(f)).toEqual(before);
    });
  }

  it("records a stated range as a source fact, never as coverage", async () => {
    const f = await fixture("ol");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.observationId, {
        snapshot: { ...OL_YUGIOH_5, coverRange: { from: "13", to: "15" } },
      });
    });
    const p = await preview(f);
    expect(p.refusal).toBeNull();
    expect(p.sourceFacts?.statedRanges).toEqual([{ from: "13", to: "15" }]);
    expect((await execute(f, p.expected!)).status).toBe("linked");
    expect((await product(f)).coverage).toEqual([]);
  });

  it("refuses a mapped owner, with coverage rows or without the unmapped flag", async () => {
    const f = await fixture("ol");
    await f.t.run(async (ctx) => {
      const volumeId = await insertVolume(ctx, { seriesId: f.seriesId, position: 13 });
      await insertCoverage(ctx, { editionId: f.editionId, volumeId });
    });
    await refuses(f, "coverage rows");
    const g = await fixture("ol");
    await g.t.run(async (ctx) => ctx.db.patch(g.editionId, { coverageUnmapped: undefined }));
    await refuses(g, "contents are mapped");
  });

  for (const claim of ["release", "bundle", "printing"] as const) {
    it(`refuses an occupied ISBN namespace (${claim} claim)`, async () => {
      const f = await fixture("ol");
      await f.t.run(async (ctx) => {
        const editionId = await insertEdition(ctx, { publisherId: f.publisherId });
        if (claim === "release")
          await insertRelease(ctx, {
            editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            isbn10: "1421579286",
            status: "hidden",
          });
        else if (claim === "bundle")
          await insertBundle(ctx, { publisherId: f.publisherId, isbn13: SPEC.ol.isbn13 });
        else {
          const otherId = await insertRelease(ctx, {
            editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            isbn13: "9781421579290",
          });
          await ctx.db.insert("releaseIsbns", {
            releaseId: otherId,
            isbn13: SPEC.ol.isbn13,
            reason: "Recorded other printing.",
            sourceKey: "openlibrary",
          });
        }
      });
      await refuses(f, "sole owner");
    });
  }

  it("refuses an ISBN scope decision", async () => {
    const f = await fixture("ol");
    await f.t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      const proposalId = await ctx.db.insert("proposals", {
        state: "approved",
        currentVersionNo: 1,
        author: { kind: "user", userId, roleAtAuthorship: "administrator" },
      });
      await ctx.db.insert("scopeDecisions", {
        isbn13: SPEC.ol.isbn13,
        reason: "novel",
        evidenceUrls: ["https://example.com/novel"],
        decidedBy: userId,
        proposalId,
        decidedAt: 1,
      });
    });
    await refuses(f, "novel");
  });

  it("refuses an owner under another Series than the source parent (Tsubasa)", async () => {
    const f = await fixture("ann");
    await f.t.run(async (ctx) => {
      const otherId = await insertSeries(ctx, { title: "Gunsmith Cats Burst" });
      await ctx.db.patch(f.releaseId, { seriesIds: [otherId] });
      await ctx.db.patch(f.lineId, { seriesId: otherId });
    });
    await refuses(f, "differs from the reviewed product");
    // Naming the owner's Series instead disagrees with the source parent.
    const owner = await f.t.run(async (ctx) => (await ctx.db.get(f.releaseId))!.seriesIds[0]!);
    await refuses(f, "names another Series", { seriesId: owner });
  });

  it("refuses an absent source parent (Cardcaptor Sakura Collector's Edition)", async () => {
    const f = await fixture("kodansha");
    await f.t.run(async (ctx) => ctx.db.delete(f.parentId!));
    await refuses(f, "parent is absent");
  });

  it("refuses a corporate-family publisher (Kodansha source, Vertical owner)", async () => {
    const f = await fixture("kodansha");
    const verticalId = await f.t.run(async (ctx) => {
      const id = await insertPublisher(ctx, {
        name: "Vertical",
        slug: "vertical",
        parentPublisherId: f.publisherId,
      });
      await ctx.db.patch(f.releaseId, { publisherId: id });
      await ctx.db.patch(f.editionId, { publisherId: id });
      await ctx.db.patch(f.lineId, { publisherId: id });
      return id;
    });
    await refuses(f, "corporate-family", { publisherId: verticalId });
  });

  it("refuses a raw Binding that contradicts the owner (paperback source, hardcover owner)", async () => {
    const f = await fixture("kodansha");
    await f.t.run(async (ctx) => ctx.db.patch(f.releaseId, { binding: "hardcover" }));
    await refuses(f, "Binding contradicts", {
      binding: "hardcover",
      evidence: [
        {
          ...proof(f).evidence[0]!,
          statesBinding: "hardcover",
          excerpt:
            "Codename: Sailor V Eternal Edition 2. ISBN 9781646511440. Hardcover. Published by Kodansha Comics",
        },
      ],
    });
  });

  it("refuses a label that is not the owner's position, or a label the review ignores", async () => {
    const f = await fixture("ol");
    await f.t.run(async (ctx) => ctx.db.patch(f.editionId, { linePosition: "6" }));
    await refuses(f, "not the owner's Line position", { linePosition: "6" });
    const g = await fixture("ol");
    await refuses(g, "how the source's label reads", { sourceLabel: "none" });
  });

  it("refuses a different source Line name unless an exact equivalence is reviewed (Alita)", async () => {
    const f = await fixture("kodansha");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.observationId, {
        snapshot: {
          ...KODANSHA_SAILOR_V_2,
          packaging: { coverRange: null, lineName: "Eternal", linePosition: "2" },
        },
      });
    });
    await refuses(f, "Line name differs");
    await refuses(f, "Line name differs", {
      lineNameEquivalence: { sourceLineName: "Eternal Ed.", lineName: "Eternal Edition" },
    });
    const p = await preview(f, {
      lineNameEquivalence: { sourceLineName: "Eternal", lineName: "Eternal Edition" },
    });
    expect(p.refusal).toBeNull();
    const result = await execute(f, p.expected!, {
      lineNameEquivalence: { sourceLineName: "Eternal", lineName: "Eternal Edition" },
    });
    expect(result.status).toBe("linked");
  });

  const rivals = {
    hiddenPosition: "Another Edition occupies this Line position",
    mergedAlias: "merged aliases",
    bundleMember: "Bundle member",
    lockedRelease: "active and unlocked",
    sameFormatSibling: "another Release of this format",
  } as const;
  for (const rival of Object.keys(rivals) as (keyof typeof rivals)[]) {
    it(`refuses a rival or closed product (${rival})`, async () => {
      const f = await fixture("ol");
      await f.t.run(async (ctx) => {
        if (rival === "hiddenPosition")
          await insertEdition(ctx, {
            publisherId: f.publisherId,
            editionLineId: f.lineId,
            linePosition: "5",
            status: "hidden",
          });
        else if (rival === "mergedAlias") {
          const editionId = await insertEdition(ctx, { publisherId: f.publisherId });
          await insertRelease(ctx, {
            editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            status: "merged",
            mergedIntoId: f.releaseId,
          });
        } else if (rival === "bundleMember") {
          const bundleId = await insertBundle(ctx, { publisherId: f.publisherId });
          await insertBundleMember(ctx, { bundleId, releaseId: f.releaseId, order: 1 });
        } else if (rival === "lockedRelease") await ctx.db.patch(f.releaseId, { locked: true });
        else
          await insertRelease(ctx, {
            editionId: f.editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
          });
      });
      await refuses(f, rivals[rival]);
    });
  }

  it("refuses evidence for another ISBN, Line or position", async () => {
    const f = await fixture("ol");
    const item = proof(f).evidence[0]!;
    await refuses(f, "exact ISBN", {
      evidence: [{ ...item, excerpt: "Yu-Gi-Oh! (3-in-1 Edition), Vol. 6. ISBN 9781421579290." }],
    });
    await refuses(f, "exact ISBN", { evidence: [{ ...item, statesIsbn13: "9781421579290" }] });
    await refuses(f, "Edition Line", {
      evidence: [
        { ...item, statesLineName: "VIZBIG Edition", excerpt: `${item.excerpt} VIZBIG Edition` },
      ],
    });
    await refuses(f, "Line position", {
      evidence: [
        {
          ...item,
          statesProductTitle: "Yu-Gi-Oh! (3-in-1 Edition)",
          excerpt: "Yu-Gi-Oh! (3-in-1 Edition). ISBN 9781421579283.",
        },
      ],
    });
    await refuses(f, "hashed capture", { evidence: [{ ...item, sha256: "not-a-hash" }] });
  });

  it("does not invent a position for an unnumbered product", async () => {
    const f = await fixture("kodansha");
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.neighbourId);
      await ctx.db.patch(f.editionId, { linePosition: undefined });
      await ctx.db.patch(f.observationId, {
        snapshot: {
          ...KODANSHA_SAILOR_V_2,
          title: "Codename: Sailor V Eternal Edition",
          packaging: { coverRange: null, lineName: "Eternal Edition", linePosition: null },
        },
      });
    });
    const unnumbered = (position: string | null) => ({
      sourceTitle: "Codename: Sailor V Eternal Edition",
      linePosition: position,
      evidence: [
        {
          ...proof(f).evidence[0]!,
          statesProductTitle: "Codename: Sailor V Eternal Edition",
          excerpt:
            "Codename: Sailor V Eternal Edition. ISBN 9781646511440. Paperback. Published by Kodansha Comics",
          statesLinePosition: position,
        },
      ],
    });
    // A fabricated position 1 refuses; the stored null position links.
    await refuses(f, "position differs", unnumbered("1"));
    const p = await preview(f, unnumbered(null));
    expect(p.refusal).toBeNull();
    // A second Edition makes the Line a family; an unnumbered member is then ambiguous.
    await f.t.run(async (ctx) =>
      insertEdition(ctx, {
        publisherId: f.publisherId,
        editionLineId: f.lineId,
        linePosition: "1",
      }),
    );
    await refuses(f, "only Edition", unnumbered(null));
  });

  it("refuses drift between preview and execute, writing nothing", async () => {
    for (const drift of ["binding", "rival", "hold"] as const) {
      const f = await fixture("ol");
      const p = await preview(f);
      expect(p.refusal).toBeNull();
      await f.t.run(async (ctx: MutationCtx) => {
        if (drift === "binding") await ctx.db.patch(f.releaseId, { binding: "paperback" });
        else if (drift === "rival")
          await insertEdition(ctx, {
            publisherId: f.publisherId,
            editionLineId: f.lineId,
            linePosition: "5",
          });
        else {
          const hold = (await ctx.db.query("placementHolds").first())!;
          await ctx.db.patch(hold._id, { heldAt: 2 });
        }
      });
      const before = await dump(f.t);
      const result = await execute(f, p.expected!);
      expect(result.status).toBe("refused");
      expect(await dump(f.t)).toBe(before);
    }
  });

  it("refuses a forged receipt: a link without its native audit is not alreadyApplied", async () => {
    const f = await fixture("ol");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.observationId, { recordRef: { type: "release", id: f.releaseId } });
      const hold = (await ctx.db.query("placementHolds").first())!;
      await ctx.db.delete(hold._id);
    });
    await refuses(f, "receipt");
  });

  it("rolls the whole link back on a failure after native linking", async () => {
    const f = await fixture("ol");
    const p = await preview(f);
    const before = await dump(f.t);
    const original = observations.linkObservation;
    const spy = vi
      .spyOn(observations, "linkObservation")
      .mockImplementation(async (...callArgs) => {
        await original(...callArgs);
        // A side effect on the product breaks the postcondition.
        await callArgs[0].db.patch(f.releaseId, { binding: "paperback" });
      });
    try {
      const result = await execute(f, p.expected!);
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("postconditions");
      expect(await dump(f.t)).toBe(before);
    } finally {
      spy.mockRestore();
    }
    expect((await execute(f, p.expected!)).status).toBe("linked");
  });
  // Review shared-unmapped-link-review-001 (B1-B4, N1): each case linked on
  // the round-1 module and must refuse now.
  it("refuses an unresolved publisher name beside a resolved one (Ajin shape)", async () => {
    for (const publishers of [
      ["Viz Media", "Unlisted Rival Press"],
      ["Vertical Comics", "VIZ Media LLC"],
    ]) {
      const f = await fixture("ol");
      await f.t.run(async (ctx) =>
        ctx.db.patch(f.observationId, { snapshot: { ...OL_YUGIOH_5, publishers } }),
      );
      await refuses(f, "is unresolved");
    }
    const g = await fixture("ol");
    await g.t.run(async (ctx) =>
      ctx.db.patch(g.observationId, {
        snapshot: { ...OL_YUGIOH_5, publishers: ["Viz", "VIZ", "Viz Media", "VIZ Media", "Viz"] },
      }),
    );
    await refuses(g, "too many publishers");
  });

  it("reads the Kodansha source's publisher like heldBooks: a publisher-side page must name it", async () => {
    const f = await fixture("kodansha");
    const item = proof(f).evidence[0]!;
    const { statesPublisher: _, ...unnamed } = item;
    await refuses(f, "evidence must name the publisher", { evidence: [unnamed] });
    await refuses(f, "verbatim page text", {
      evidence: [{ ...item, statesPublisher: "Kodansha USA" }],
    });
    await refuses(f, "a publisher-side page must name it", {
      evidence: [{ ...item, url: "https://www.example-retailer.com/9781646511440" }],
    });
  });

  it("does not let an ISBN's hyphenated digit stand in for the Line position (Bleach shape)", async () => {
    const f = await fixture("ann");
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.neighbourId);
      await ctx.db.patch(f.lineId, { name: "20th Anniversary Edition" });
      await ctx.db.patch(f.editionId, { linePosition: "1" });
      await ctx.db.patch(f.observationId, {
        snapshot: {
          ...ANN_GUNSMITH_2,
          label: "1",
          title: "Gunsmith Cats - 20th Anniversary Edition",
          page: {
            ...ANN_GUNSMITH_2.page,
            volume: "GN 1 / 74",
            title: "Gunsmith Cats - 20th Anniversary Edition",
          },
        },
      });
    });
    const shape = (title: string, excerpt: string, url: string = SPEC.ann.url) => ({
      lineName: "20th Anniversary Edition",
      linePosition: "1",
      sourceTitle: "Gunsmith Cats - 20th Anniversary Edition",
      evidence: [
        {
          ...proof(f).evidence[0]!,
          url,
          excerpt,
          statesProductTitle: title,
          statesLineName: "20th Anniversary Edition",
          statesLinePosition: "1",
        },
      ],
    });
    await refuses(
      f,
      "Line position",
      shape(
        "Gunsmith Cats 20th Anniversary Edition",
        "Gunsmith Cats 20th Anniversary Edition ISBN-13 978-1-59307-768-6",
      ),
    );
    // ANN's run designator read as a Line position needs the publisher's own page.
    const stated = "Gunsmith Cats 20th Anniversary Edition, Vol. 1";
    await refuses(
      f,
      "own SKU page",
      shape(stated, `${stated} ISBN-13 978-1-59307-768-6`, "https://example.com/retailer"),
    );
    const p = await preview(f, shape(stated, `${stated} ISBN-13 978-1-59307-768-6`));
    expect(p.refusal).toBeNull();
  });

  it("reads ISBN tokens, not digits joined across a page, and no other product's ISBN", async () => {
    const f = await fixture("ol");
    const item = proof(f).evidence[0]!;
    await refuses(f, "exact ISBN", {
      evidence: [
        { ...item, excerpt: "Yu-Gi-Oh! (3-in-1 Edition), Vol. 5. 978 pages. Item 1421579283." },
      ],
    });
    await refuses(f, "exact ISBN", {
      evidence: [{ ...item, excerpt: `${item.excerpt} Vol. 6: ISBN 9781421579290.` }],
    });
    // The ISBN must follow the product's own title, not precede it.
    await refuses(f, "followed by this ISBN", {
      evidence: [
        { ...item, excerpt: "ISBN 9781421579283. Related: Yu-Gi-Oh! (3-in-1 Edition), Vol. 5" },
      ],
    });
  });

  it("needs a publisher-side page when a bare source label is read as a Line position", async () => {
    const f = await fixture("ol");
    await refuses(f, "own SKU page", {
      evidence: [{ ...proof(f).evidence[0]!, url: "https://example.com/yugioh-5" }],
    });
  });

  it("answers a retry after restore and relink from the newest receipt only", async () => {
    const f = await fixture("ol");
    const first = await execute(f, (await preview(f)).expected!);
    const ledger = await f.t.run(async (ctx) => (await ctx.db.get(first.ledgerId!))!);
    await f.t.mutation(internal.heldBooks.restoreInternal, {
      actor: "ari",
      ledgerId: ledger._id,
      expectedAfter: ledger.after,
      reason: "Test restore.",
    });
    const second = await execute(f, (await preview(f)).expected!);
    expect(second.status).toBe("linked");
    const again = await preview(f);
    expect(again.action).toBe("alreadyApplied");
    expect(await execute(f, again.expected!)).toMatchObject({
      status: "alreadyApplied",
      ledgerId: second.ledgerId,
    });
    // The first receipt still verifies on its own, but it never stands in
    // for the newest one: a newest receipt that no longer verifies refuses.
    await f.t.run(async (ctx) => ctx.db.patch(second.proposalId!, { state: "rejected" }));
    await refuses(f, "no longer matches");
    // Nor does a G1 receipt speak for a newer repair of the same source.
    await f.t.run(async (ctx) => {
      await ctx.db.patch(second.proposalId!, { state: "approved" });
      await ctx.db.insert("heldRepairLedger", {
        observationId: f.observationId,
        operation: "refreshOlSubtitle",
        proposalId: second.proposalId!,
        before: "x",
        after: "y",
      });
    });
    await refuses(f, "not the newest repair");
  });
});

// Real captured page text (results/shared-unmapped-link-evidence-001-captures),
// each a contiguous run of extract(body); the round-2 evidence rules bind the
// Line and position to the page's own product title.
const REAL = {
  yu5: "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 5 Paperback Stores $16.99* Amazon Amazon Amazon Amazon Amazon Amazon Barnes & Noble Books-A-Million Bookshop.org Booktopia Dymocks Indigo Kinokuniya Manga Books Mighty Ape QBD Books Waterstones Bookshop.org Find Your Comic Store *Actual prices may vary +28 While Kaiba, the world\u2019s second greatest gamer, duels Pegasus, Yugi and his friends explore Pegasus\u2019s castle. But they\u2019re not alone! Bandit Keith, the unscrupulous American card shark, prowls the dark castle with his own evil plans. Then, Mai Kujaku finally gets her chance to fight Yugi, and Jonouchi duels it out with Bandit Keith. Jonouchi\u2019s deck is loaded with warrior monsters, but Keith\u2019s machine deck deals death with six-guns and slot machines\u2026American-style! Story and Art by Kazuki Takahashi Release February 2, 2016 ISBN-13 978-1-4215-7928-3",
  yu4WithRelated:
    "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 4 Paperback Stores $16.99* Amazon Amazon Amazon Amazon Amazon Amazon Barnes & Noble Books-A-Million Bookshop.org Booktopia Dymocks Indigo Kinokuniya Manga Books Mighty Ape QBD Books Waterstones Bookshop.org Find Your Comic Store *Actual prices may vary +31 The diabolical Player Killer, Pegasus\u2019s second gaming assassin, challenges Yugi to a Shadow Game! In the shadow of the Castle of Dark Illusions card, an army of lurking monsters hungers to steal Yugi\u2019s life points\u2014and if he loses, his actual life! Then the action moves into underground tunnels beneath Duelist Kingdom. There Yugi and Jonouchi must conquer the maze of the Meikyu Brothers in a two-on-two duel. Waiting in the Brothers\u2019 deck is the Gate Guardian, lord of the underworld and one of the most powerful monsters of all. Story and Art by Kazuki Takahashi Release November 3, 2015 ISBN-13 978-1-4215-7927-6 Trim Size 5 \u00d7 7 1/2 Imprint SHONEN JUMP Length 624 pages Series Yu-Gi-Oh! Category Manga Age Rating Teen Get the whole series See all > +28 Manga Yu-Gi-Oh! (3-in-1 Edition), Vol. 5",
  yu13: "Yu-Gi-Oh! (3-in-1 Edition) Yu-Gi-Oh! (2-in-1 Edition), Vol. 13 Paperback Stores $16.99* Amazon Amazon Amazon Amazon Amazon Amazon Barnes & Noble Books-A-Million Bookshop.org Booktopia Dymocks Indigo Kinokuniya Manga Books Mighty Ape QBD Books Waterstones Bookshop.org Find Your Comic Store *Actual prices may vary +52 In a life-or-death match of Duel Monsters, Yugi fights for the most powerful magic of all\u2014his forgotten Egyptian name! And in the 3,000-year-old Millennium World, forces of good and evil clash in a final battle. What will Yu-Gi-Oh face at his final destination in present-day Egypt? Will the bonds that hold the pharaoh\u2019s soul be broken at last? Find out in this final volume! Story and Art by Kazuki Takahashi Release February 6, 2018 ISBN-13 978-1-4215-7936-8",
  bleach:
    "Bleach 20th Anniversary Edition, Vol. 1 Paperback Stores $9.99* Amazon Amazon Amazon Amazon Amazon Amazon Barnes & Noble Books-A-Million Bookshop.org Booktopia Dymocks Indigo Kinokuniya Manga Books Mighty Ape QBD Books Waterstones Bookshop.org Find Your Comic Store *Actual prices may vary +181 Celebrate 20 years of Bleach with this exclusive volume featuring cover art from the series launch on August 20, 2001 in Weekly Shonen Jump magazine! Ichigo Kurosaki has always been able to see ghosts, but this ability doesn\u2019t change his life nearly as much as his close encounter with Rukia Kuchiki, a Soul Reaper and member of the mysterious Soul Society. While fighting a Hollow, an evil spirit that preys on humans who display psychic energy, Rukia attempts to lend Ichigo some of her powers so that he can save his family; but much to her surprise, Ichigo absorbs every last drop of her energy. Now a full-fledged Soul Reaper himself, Ichigo quickly learns that the world he inhabits is one full of dangerous spirits and, along with Rukia\u2014who is slowly regaining her powers\u2014it\u2019s Ichigo\u2019s job to protect the innocent from Hollows and help the spirits themselves find peace. Story and Art by Tite Kubo Release August 2, 2022 ISBN-13 978-1-9747-3598-3",
  sailorPrh:
    "Codename: Sailor V Eternal Edition 2 (Sailor Moon Eternal Edition 12) By Naoko Takeuchi Paperback $27.99 Published on Nov 09, 2021 | 304 Pages Add to Cart Buy from Other Retailers: Paperback \u2013 Paperback $27.99 Published on Nov 09, 2021 | 304 Pages Add to Cart Buy from Other Retailers: Book Description Before Sailor Moon, there was Sailor V! Minako Aino is 13 years old when she meets a talking white cat named Artemis, who tells her something unbelievable: With a magic pen, she has the power to transform into the elegant, masked hero Sailor V. Experience Minako\u2019s adventures, before she became Sailor Venus, featuring a new, glittering cover, a fresh translation, and remastered interior art! A year before meeting Sailor Moon\u2013and her destiny as a member of the Sailor Guardians\u2013Minako was the first hero to find her calling. At age 13, all this teen can talk about is finding a boyfriend, but her dreams change when a talking cat with a crescent moon on his forehead reveals her true identity as the Soldier of Justice, Sailor V! Miracles have returned to modern Tokyo, and she must use her powers to stop the Dark Agency, which is trying to manipulate Japan\u2019s entertainment industry and enslave the population. This definitive, two-volume \u201cEternal Edition\u201d of the Codename: Sailor V manga follows the ten-volume Sailor Moon Eternal Edition . They feature new cover illustrations by Sailor V and Sailor Moon creator Naoko Takeuchi, a new translation, entirely redesigned lettering, and, for the first time, all the color pages from the original magazine run in the 1990s, at the largest size available anywhere in the world! In the name of Sailor V, don\u2019t miss this chance to complete your collection! See More Related Genres Manga Fiction Graphic Novels Product Details ISBN 9781646511440 Published on Nov 09, 2021 Published by Kodansha Comics",
  spriggan:
    "Book : SPRIGGAN: Deluxe Edition 1 Series: SPRIGGAN: Deluxe Edition Story & Art by: Hiroshi Takashige Ryouji Minagawa Release Date: August 30, 2022 Early Digital: June 16, 2022 Price: $29.99 Format: Manga Trim: 5.875 x 8.25in Page Count: 636 ISBN: 978-1-63858-579-4",
  girlFriends:
    "Book : Girl Friends: The Complete Collection 1 girls' love Series: Girl Friends Story & Art by: Milk Morinaga Release Date: October 12, 2012 Price: $17.99 Format: Manga Trim: 5 x 7.125in Page Count: 448 ISBN: 978-1-935934-89-9",
};
const page = (
  excerpt: string,
  statesProductTitle: string,
  statesIsbn13: string,
  statesLineName: string,
  statesLinePosition: string | null,
  extra: { statesPublisher?: string } = {},
) => ({
  url: "https://www.viz.com/manga-books/manga/product",
  sha256: SHA,
  capturedAt: 1791390539210,
  excerpt,
  statesProductTitle,
  statesIsbn13,
  statesLineName,
  statesLinePosition,
  ...extra,
});
const check = (
  isbn13: string,
  linePosition: string | null,
  evidence: ReturnType<typeof page>[],
  owner: { line: string; slug: string; works: string[] },
) =>
  checkEvidence(
    {
      isbn13,
      linePosition,
      format: "physical",
      binding: null,
      evidence,
      reason: "Real capture.",
    },
    { line: { name: owner.line }, publisher: { slug: owner.slug }, workNames: owner.works },
  );
const YUGIOH = { line: "3-in-1 Edition", slug: "viz-media", works: ["Yu-Gi-Oh!", "Game King"] };

describe("G1 evidence binds the Line and position to the page's own product title", () => {
  it("accepts the real VIZ, Seven Seas and PRH product titles", () => {
    expect(
      check(
        "9781421579283",
        "5",
        [
          page(
            REAL.yu5,
            "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 5",
            "9781421579283",
            "3-in-1 Edition",
            "5",
          ),
        ],
        YUGIOH,
      ).publisherSide,
    ).toBe(true);
    const bleach = { line: "20th Anniversary Edition", slug: "viz-media", works: ["Bleach"] };
    expect(() =>
      check(
        "9781974735983",
        "1",
        [
          page(
            REAL.bleach,
            "Bleach 20th Anniversary Edition, Vol. 1",
            "9781974735983",
            "20th Anniversary Edition",
            "1",
          ),
        ],
        bleach,
      ),
    ).not.toThrow();
    // "Book : " precedes Seven Seas' heading; the title itself starts with the Series.
    expect(() =>
      check(
        "9781935934899",
        "1",
        [
          {
            ...page(
              REAL.girlFriends,
              "Girl Friends: The Complete Collection 1",
              "9781935934899",
              "Complete Collection",
              "1",
            ),
            url: "https://sevenseasentertainment.com/books/girl-friends-the-complete-collection-1/",
          },
        ],
        { line: "Complete Collection", slug: "seven-seas", works: ["Girlfriends", "Girl Friends"] },
      ),
    ).not.toThrow();
    // An unnumbered series label between the title and the ISBN says nothing about position.
    expect(() =>
      check(
        "9781638585794",
        "1",
        [
          {
            ...page(
              REAL.spriggan,
              "SPRIGGAN: Deluxe Edition 1",
              "9781638585794",
              "Deluxe Edition",
              "1",
            ),
            url: "https://sevenseasentertainment.com/books/spriggan-deluxe-edition-1/",
          },
        ],
        { line: "Deluxe Edition", slug: "seven-seas", works: ["Striker", "Spriggan"] },
      ),
    ).not.toThrow();
    // PRH's dual numbering names another work's Line ("Sailor Moon Eternal Edition 12").
    const sailor = check(
      "9781646511440",
      "2",
      [
        {
          ...page(
            REAL.sailorPrh,
            "Codename: Sailor V Eternal Edition 2 (Sailor Moon Eternal Edition 12)",
            "9781646511440",
            "Eternal Edition",
            "2",
            { statesPublisher: "Kodansha Comics" },
          ),
          url: "https://www.penguinrandomhouse.com/books/653445/x/9781646511440/",
        },
      ],
      { line: "Eternal Edition", slug: "kodansha", works: ["Codename: Sailor V", "Sailor V"] },
    );
    expect(sailor.publishers).toEqual([{ name: "Kodansha Comics", publisherSide: true }]);
  });

  it("refuses VIZ's Yu-Gi-Oh! 13, titled 2-in-1 Edition under a 3-in-1 breadcrumb", () => {
    const yu13 = (title: string) =>
      check(
        "9781421579368",
        "13",
        [page(REAL.yu13, title, "9781421579368", "3-in-1 Edition", "13")],
        YUGIOH,
      );
    // The page's own heading names another Line.
    expect(() => yu13("Yu-Gi-Oh! (2-in-1 Edition), Vol. 13")).toThrow(
      "Series and the owner's Edition Line",
    );
    // The breadcrumb names the Line but no position; joined to the heading it still does not.
    expect(() => yu13("Yu-Gi-Oh! (3-in-1 Edition)")).toThrow("Line position");
    expect(() => yu13("Yu-Gi-Oh! (3-in-1 Edition) Yu-Gi-Oh! (2-in-1 Edition), Vol. 13")).toThrow(
      "Line position",
    );
  });

  it("never reads a position from a date, a related product or an ISBN's digits", () => {
    // "Release February 2, 2016" on the Vol. 5 page does not state position 2.
    expect(() =>
      check(
        "9781421579283",
        "2",
        [
          page(
            REAL.yu5,
            "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 5",
            "9781421579283",
            "3-in-1 Edition",
            "2",
          ),
        ],
        YUGIOH,
      ),
    ).toThrow("Line position");
    // Vol. 4's page lists Vol. 5 among related products after its ISBN.
    const yu4 = (position: string, title: string) =>
      check(
        "9781421579276",
        position,
        [page(REAL.yu4WithRelated, title, "9781421579276", "3-in-1 Edition", position)],
        YUGIOH,
      );
    expect(() => yu4("5", "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 4")).toThrow("Line position");
    expect(() => yu4("5", "Yu-Gi-Oh! (3-in-1 Edition), Vol. 5")).toThrow("followed by this ISBN");
    // A numbered statement of another position before the ISBN refuses.
    const yu5Related = REAL.yu5.replace(
      "Release February 2",
      "Also in this line: Yu-Gi-Oh! (3-in-1 Edition), Vol. 4. Release February 2",
    );
    expect(() =>
      check(
        "9781421579283",
        "5",
        [
          page(
            yu5Related,
            "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 5",
            "9781421579283",
            "3-in-1 Edition",
            "5",
          ),
        ],
        YUGIOH,
      ),
    ).toThrow("Line position");
    // Related products after the ISBN are not a reason to refuse the page's own product.
    expect(() => yu4("4", "Yu-Gi-Oh! (3-in-1 Edition) , Vol. 4")).not.toThrow();
    // "978-1-9747-…" holds a "1", but the title states no position.
    const bleach = { line: "20th Anniversary Edition", slug: "viz-media", works: ["Bleach"] };
    expect(() =>
      check(
        "9781974735983",
        "1",
        [
          page(
            REAL.bleach.replace(", Vol. 1", ""),
            "Bleach 20th Anniversary Edition",
            "9781974735983",
            "20th Anniversary Edition",
            "1",
          ),
        ],
        bleach,
      ),
    ).toThrow("Line position");
  });
});
