import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { heldState } from "./lib/heldBooks";
import * as repairAudit from "./lib/repair/audit";
import {
  type SourceParentProof,
  type SourceParentRestoreResult,
  type SourceParentResult,
  seriesUrlOf,
} from "./lib/sourceSeriesParentRepair";
import { valueHash } from "./lib/values";
import {
  insertBundle,
  insertEdition,
  insertEditionLine,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
} from "./test.factories";
import { makeT, type TestT } from "./test.helpers";

// The fixture copies the live staging records of 2026-10-07 for the first
// three Cardcaptor Sakura Collector's Edition volumes: each has a held
// physical and digital Kodansha observation, the physical ISBN is owned by a
// hardcover Release under "Cardcaptor Sakura", and no series:<slug> parent
// exists. The excerpt is the kodansha.us series page's text run.
const SLUG = "cardcaptor-sakura-collectors-edition";
const SERIES_URL = seriesUrlOf(SLUG);
const TITLE = "Cardcaptor Sakura";
const LINE = "Collector's Edition";
const HEADING = "Cardcaptor Sakura Collector's Edition";
const EXCERPT = [
  "Manga",
  HEADING,
  HEADING,
  "By CLAMP",
  "Cardcaptor Sakura brought a generation of readers to manga, and now it’s back in a definitive collector’s edition!",
].join("\n");
const VOLUMES = [
  { n: 1, physical: "9781632367518", digital: "9781642129793" },
  { n: 2, physical: "9781632368652", digital: "9781646590711" },
  { n: 3, physical: "9781632368669", digital: "9781646597208" },
];
const CAPTURED_AT = 1791300000000;

const preview = makeFunctionReference<"query">("heldSourceParents:previewInternal");
const execute = makeFunctionReference<"mutation", Record<string, unknown>, SourceParentResult>(
  "heldSourceParents:executeInternal",
);
const previewRestore = makeFunctionReference<"query">("heldSourceParents:previewRestoreInternal");
const restore = makeFunctionReference<
  "mutation",
  Record<string, unknown>,
  SourceParentRestoreResult
>("heldSourceParents:restoreInternal");

const volumeSnapshot = (n: number, format: "physical" | "digital", isbn13: string) => ({
  ...(format === "physical" ? { binding: "paperback" } : {}),
  creators: ["CLAMP"],
  format,
  isbn13,
  kind: "kodanshaVolume",
  packaging: { coverRange: null, lineName: LINE, linePosition: String(n) },
  seriesSlug: SLUG,
  seriesTitle: TITLE,
  seriesUrl: SERIES_URL,
  title: `${HEADING} Volume ${n}`,
  url: `${SERIES_URL}volume-${n}/`,
});

async function fixture(t: TestT = makeT()) {
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
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const seriesId = await insertSeries(ctx, { title: TITLE, altTitles: ["Cardcaptors"] });
    const personId = await ctx.db.insert("people", {
      publicId: 1,
      name: "CLAMP",
      nameKey: "clamp",
      seriesCount: 1,
      coverUrl: null,
      coverIsbn: null,
    });
    for (const role of ["story", "art"] as const)
      await ctx.db.insert("seriesCredits", { seriesId, personId, role });
    const lineId = await insertEditionLine(ctx, { seriesId, publisherId, name: LINE });
    const observationIds: Id<"sourceObservations">[] = [];
    const releaseIds: Id<"releases">[] = [];
    for (const volume of VOLUMES) {
      const editionId = await insertEdition(ctx, {
        publisherId,
        editionLineId: lineId,
        linePosition: String(volume.n),
        coverageUnmapped: true,
      });
      releaseIds.push(
        await insertRelease(ctx, {
          editionId,
          publisherId,
          seriesIds: [seriesId],
          isbn13: volume.physical,
          binding: "hardcover",
        }),
      );
      for (const format of ["physical", "digital"] as const) {
        const observationId = await insertObservation(ctx, {
          sourceKey: "kodansha",
          sourceRecordId: `${SLUG}/volume-${volume.n}#${format}`,
          snapshot: volumeSnapshot(volume.n, format, volume[format]),
          conflicts: [{ field: "placement", at: 1, reason: "no stated coverage", offered: null }],
        });
        await ctx.db.insert("placementHolds", {
          observationId,
          sourceKey: "kodansha",
          kind: "packaging",
          heldAt: 1,
        });
        observationIds.push(observationId);
      }
    }
    return { publisherId, seriesId, personId, lineId, observationIds, releaseIds };
  });
  return { t, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function proof(f: Fixture, overrides: Partial<SourceParentProof> = {}): SourceParentProof {
  return {
    seriesSlug: SLUG,
    seriesId: f.seriesId,
    sourceTitle: TITLE,
    lineName: LINE,
    observationIds: f.observationIds,
    capture: {
      url: SERIES_URL,
      sha256: "a".repeat(64),
      capturedAt: CAPTURED_AT,
      excerpt: EXCERPT,
      statesCategory: "Manga",
      statesHeading: HEADING,
      statesAuthors: ["CLAMP"],
      volumeLinks: VOLUMES.map((v) => `${SERIES_URL}volume-${v.n}/`),
    },
    reason: "The slug's own kodansha.us series page names this Series, its Line and its author.",
    ...overrides,
  };
}
const capture = (f: Fixture, overrides: Partial<SourceParentProof["capture"]>) => ({
  capture: { ...proof(f).capture, ...overrides },
});
type Preview = {
  expected: string | null;
  refusal: string | null;
  action: string | null;
  bindingDiscrepancies: unknown[] | null;
  heldVolumes: unknown[] | null;
};
const look = (f: Fixture, overrides: Partial<SourceParentProof> = {}) =>
  f.t.query(preview, { proof: proof(f, overrides) }) as Promise<Preview>;
const apply = (f: Fixture, expected: string, overrides: Partial<SourceParentProof> = {}) =>
  f.t.mutation(execute, { proof: proof(f, overrides), actor: "ari", expected });

async function dump(t: TestT) {
  return await t.run(async (ctx) => {
    const tables = [
      "sourceObservations",
      "observationSnapshots",
      "placementHolds",
      "releases",
      "editions",
      "editionLines",
      "proposals",
      "proposalVersions",
      "revisions",
      "heldRepairLedger",
      "series",
    ] as const;
    return valueHash(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
  });
}
async function parentOf(t: TestT) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", "kodansha").eq("sourceRecordId", `series:${SLUG}`),
      )
      .collect(),
  );
}
/** The preview refuses with `reason`, and an execute with any guard writes nothing. */
async function refuses(f: Fixture, reason: string, overrides: Partial<SourceParentProof> = {}) {
  const before = await dump(f.t);
  const p = await look(f, overrides);
  expect(p.refusal).toContain(reason);
  expect(p.expected).toBeNull();
  const result = await apply(f, "stale", overrides);
  expect(result.status).toBe("refused");
  expect(await dump(f.t)).toBe(before);
}
const children = (f: Fixture) =>
  f.t.run(async (ctx) => ({
    observations: await Promise.all(f.observationIds.map((id) => ctx.db.get(id))),
    holds: await ctx.db.query("placementHolds").collect(),
    releases: await ctx.db.query("releases").collect(),
  }));

describe("G5 reviewed Kodansha source Series parent", () => {
  it("records the parent, keeps every volume, reports Bindings for G4, retries and restores", async () => {
    const f = await fixture();
    const kept = await children(f);
    const p = await look(f);
    expect(p.refusal).toBeNull();
    expect(p.action).toBe("link");
    expect(p.heldVolumes).toHaveLength(6);
    // The raw paperback against the hardcover owner is G4's, never settled here.
    expect(p.bindingDiscrepancies).toHaveLength(3);
    // Held routes refuse while the parent is absent.
    const absent = await f.t.run(async (ctx) =>
      heldState(ctx, f.observationIds[0]!).then(
        () => null,
        (error: unknown) => (error instanceof ConvexError ? JSON.stringify(error.data) : ""),
      ),
    );
    expect(absent).toContain("Source parent is absent");

    const result = await apply(f, p.expected!);
    expect(result.status).toBe("linked");
    const [parent] = await parentOf(f.t);
    expect(parent?._id).toBe(result.parentId);
    expect(parent?.snapshot).toEqual({ kind: "series", title: TITLE, url: SERIES_URL });
    expect(parent?.recordRef).toEqual({ type: "series", id: f.seriesId });
    expect(await children(f)).toEqual(kept);
    const audit = await f.t.run(async (ctx) => ({
      proposal: await ctx.db.get(result.proposalId!),
      revisions: await ctx.db.query("revisions").collect(),
      ledger: await ctx.db.get(result.ledgerId!),
    }));
    expect(audit.proposal?.state).toBe("approved");
    expect(audit.revisions).toHaveLength(1);
    expect(audit.revisions[0]?.ref).toEqual({ type: "series", id: f.seriesId });
    expect(audit.ledger?.observationId).toBe(result.parentId);

    // The held volumes now resolve their parent.
    const resolved = await f.t.run(async (ctx) => {
      const state = await heldState(ctx, f.observationIds[0]!);
      return state.source.series?._id;
    });
    expect(resolved).toBe(f.seriesId);

    // A retry with the applied guard, or a fresh preview's, writes nothing.
    const applied = await dump(f.t);
    expect((await apply(f, p.expected!)).status).toBe("alreadyApplied");
    const again = await look(f);
    expect(again.action).toBe("alreadyApplied");
    expect((await apply(f, again.expected!)).status).toBe("alreadyApplied");
    expect(await dump(f.t)).toBe(applied);

    // Restore removes the parent alone; a retry is a no-op.
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    expect(r.action).toBe("restore");
    const restored = await f.t.mutation(restore, {
      ledgerId: result.ledgerId!,
      actor: "ari",
      reason: "Undo for review.",
      expected: r.expected!,
    });
    expect(restored.status).toBe("restored");
    expect(await parentOf(f.t)).toEqual([]);
    expect(await children(f)).toEqual(kept);
    const undone = await dump(f.t);
    const retry = await f.t.mutation(restore, {
      ledgerId: result.ledgerId!,
      actor: "ari",
      reason: "Undo for review.",
      expected: r.expected!,
    });
    expect(retry.status).toBe("alreadyRestored");
    expect(await dump(f.t)).toBe(undone);
    // The route can record the parent again afterwards.
    const fresh = await look(f);
    expect(fresh.action).toBe("link");
  });

  it("an execute pinned to an older preview refuses after the closure drifts", async () => {
    const f = await fixture();
    const p = await look(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.observationIds[0]!, { lastSeenAt: 99 });
    });
    const before = await dump(f.t);
    const result = await apply(f, p.expected!);
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("preview") });
    expect(await dump(f.t)).toBe(before);
  });

  describe("never overwrites an existing parent, in any state", () => {
    const parentCases: [string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>][] = [
      ["linked", async (_ctx, f) => ({ recordRef: { type: "series", id: f.seriesId } })],
      ["unlinked", async () => ({})],
      [
        "withdrawn",
        async (_ctx, f) => ({ withdrawn: true, recordRef: { type: "series", id: f.seriesId } }),
      ],
      [
        "linked to a hidden Series",
        async (ctx) => ({
          recordRef: {
            type: "series",
            id: await insertSeries(ctx, { title: TITLE, status: "hidden" }),
          },
        }),
      ],
      [
        "with a draft Proposal",
        async (ctx) => ({
          queuedProposalId: await ctx.db.insert("proposals", {
            author: { kind: "source", sourceKey: "kodansha" },
            state: "draft",
            currentVersionNo: 0,
          }),
        }),
      ],
    ];
    for (const [name, fields] of parentCases)
      it(name, async () => {
        const f = await fixture();
        await f.t.run(async (ctx) => {
          await insertObservation(ctx, {
            sourceKey: "kodansha",
            sourceRecordId: `series:${SLUG}`,
            snapshot: { kind: "series", title: "Something Else", url: SERIES_URL },
            ...((await fields(ctx, f)) as object),
          });
        });
        await refuses(f, "never overwrites a parent");
      });
  });

  describe("ISBN owners and the canonical Series must agree", () => {
    it("refuses an owner Release under another Series", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const other = await insertSeries(ctx, { title: "Cardcaptor Sakura: Clear Card" });
        await ctx.db.patch(f.releaseIds[1]!, { seriesIds: [other] });
      });
      await refuses(f, "under another Series");
    });
    it("refuses an owner that also names another Series", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const other = await insertSeries(ctx, { title: "Tsubasa" });
        await ctx.db.patch(f.releaseIds[0]!, { seriesIds: [f.seriesId, other] });
      });
      await refuses(f, "under another Series");
    });
    it("refuses a merged alias Release whose own Series is contrary", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const other = await insertSeries(ctx, { title: "Tsubasa" });
        const release = (await ctx.db.get(f.releaseIds[0]!))!;
        await insertRelease(ctx, {
          editionId: release.editionId,
          publisherId: f.publisherId,
          seriesIds: [other],
          isbn13: release.isbn13,
          status: "merged",
          mergedIntoId: release._id,
        });
      });
      await refuses(f, "under another Series");
    });
    it("accepts an owner naming a merged alias of the reviewed Series", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const alias = await insertSeries(ctx, {
          title: "Cardcaptor Sakura (old)",
          status: "merged",
          mergedIntoId: f.seriesId,
        });
        await ctx.db.patch(f.releaseIds[0]!, { seriesIds: [alias] });
      });
      const p = await look(f);
      expect(p.refusal).toBeNull();
    });
    it("refuses an ISBN a Bundle claims", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        await insertBundle(ctx, { publisherId: f.publisherId, isbn13: VOLUMES[2]!.digital });
      });
      await refuses(f, "Bundle");
    });
    it("refuses a canonical Series the volumes do not name", async () => {
      const f = await fixture();
      const other = await f.t.run((ctx) =>
        insertSeries(ctx, { title: "Cardcaptor Sakura: Clear Card" }),
      );
      await refuses(f, "not a name of the reviewed Series", { seriesId: other });
    });
    it("refuses a locked or merged canonical Series", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        await ctx.db.patch(f.seriesId, { locked: true });
      });
      await refuses(f, "active and unlocked");
      const g = await fixture();
      await g.t.run(async (ctx) => {
        const survivor = await insertSeries(ctx, { title: TITLE });
        await ctx.db.patch(g.seriesId, { status: "merged", mergedIntoId: survivor });
      });
      await refuses(g, "merged");
    });
    it("refuses authors the Series does not credit", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        for (const credit of await ctx.db.query("seriesCredits").collect())
          await ctx.db.delete(credit._id);
      });
      await refuses(f, "authors");
      const g = await fixture();
      await refuses(g, "credit line", capture(g, { statesAuthors: ["Someone Else"] }));
    });
  });

  describe("the source closure must be complete and agree", () => {
    it("refuses a reviewed closure missing a volume", async () => {
      const f = await fixture();
      await refuses(f, "Source closure differs", { observationIds: f.observationIds.slice(1) });
    });
    it("refuses a volume naming another series page, including a userinfo URL", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const doc = (await ctx.db.get(f.observationIds[2]!))!;
        await ctx.db.patch(doc._id, {
          snapshot: {
            ...doc.snapshot,
            seriesUrl: `https://kodansha.us@evil.example/series/${SLUG}/`,
          },
        });
      });
      await refuses(f, "disagrees on its series identity");
    });
    it("refuses a volume under another series title", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const doc = (await ctx.db.get(f.observationIds[3]!))!;
        await ctx.db.patch(doc._id, { snapshot: { ...doc.snapshot, seriesTitle: "Cardcaptors" } });
      });
      await refuses(f, "disagrees on its series identity");
    });
    it("refuses a page listing a volume the closure lacks", async () => {
      const f = await fixture();
      await refuses(
        f,
        "volume links",
        capture(f, { volumeLinks: [1, 2, 3, 4].map((n) => `${SERIES_URL}volume-${n}/`) }),
      );
    });
    it("refuses a held volume whose hold names another Series", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const other = await insertSeries(ctx, { title: "Tsubasa" });
        const hold = await ctx.db.query("placementHolds").first();
        await ctx.db.patch(hold!._id, { seriesId: other });
      });
      await refuses(f, "names another Series");
    });
    it("refuses a volume with a Proposal in review", async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const proposal = await ctx.db.insert("proposals", {
          author: { kind: "source", sourceKey: "kodansha" },
          state: "inReview",
          currentVersionNo: 1,
        });
        await ctx.db.patch(f.observationIds[1]!, { queuedProposalId: proposal });
      });
      await refuses(f, "in review or draft");
    });
  });

  describe("the page itself must prove the parent", () => {
    const urls: [string, string][] = [
      ["userinfo", `https://kodansha.us@evil.example/series/${SLUG}/`],
      ["lookalike host", `https://kodansha.us.evil.example/series/${SLUG}/`],
      ["subdomain", `https://www.kodansha.us/series/${SLUG}/`],
      ["plain http", `http://kodansha.us/series/${SLUG}/`],
      ["query", `${SERIES_URL}?ref=1`],
      ["another slug", seriesUrlOf("cardcaptor-sakura")],
    ];
    for (const [name, url] of urls)
      it(`refuses a ${name} page URL`, async () => {
        const f = await fixture();
        await refuses(f, "Series page URL", capture(f, { url }));
      });
    it("refuses a lookalike volume link", async () => {
      const f = await fixture();
      await refuses(
        f,
        "volume link",
        capture(f, {
          volumeLinks: [
            `${SERIES_URL}volume-1/`,
            `${SERIES_URL}volume-2/`,
            `https://kodansha.us.evil.example/series/${SLUG}/volume-3/`,
          ],
        }),
      );
    });
    it("refuses an excerpt with a spliced ISBN", async () => {
      const f = await fixture();
      await refuses(
        f,
        "states no ISBN",
        capture(f, { excerpt: `${EXCERPT}\nISBN 978-1-63236-751-8` }),
      );
    });
    it("refuses a heading of another work or a bare title alias", async () => {
      const f = await fixture();
      const heading = "Cardcaptor Sakura: Clear Card";
      await refuses(
        f,
        "Page heading",
        capture(f, {
          statesHeading: heading,
          excerpt: ["Manga", heading, "By CLAMP"].join("\n"),
        }),
      );
      await refuses(
        f,
        "Page heading",
        capture(f, { statesHeading: TITLE, excerpt: ["Manga", TITLE, "By CLAMP"].join("\n") }),
      );
    });
    it("refuses an excerpt that is not the page's category, heading and credit run", async () => {
      const f = await fixture();
      await refuses(
        f,
        "Manga category",
        capture(f, { excerpt: EXCERPT.replace("Manga\n", "Novels\n"), statesCategory: "Novels" }),
      );
      await refuses(
        f,
        "Manga category",
        capture(f, { excerpt: ["Manga", HEADING, "Volume 1", "By CLAMP"].join("\n") }),
      );
    });
    it("refuses a future or unhashed capture", async () => {
      const f = await fixture();
      await refuses(f, "future", capture(f, { capturedAt: Date.now() + 60 * 60 * 1000 }));
      await refuses(f, "SHA-256", capture(f, { sha256: "not-a-hash" }));
    });
    it("refuses an unreviewed slug", async () => {
      const f = await fixture();
      await refuses(f, "not one this campaign reviewed", { seriesSlug: "cardcaptor-sakura" });
    });
  });

  it("a source title alias alone never proves the work (Gachiakuta Dumpster)", async () => {
    const t = makeT();
    const f = await fixture(t);
    const slug = "gachiakuta-manga-box";
    const url = seriesUrlOf(slug);
    const ids = await t.run(async (ctx) => {
      const seriesId = await insertSeries(ctx, { title: "Gachiakuta", altTitles: [] });
      const personId = await ctx.db.insert("people", {
        publicId: 2,
        name: "Kei Urana",
        nameKey: "keiurana",
        seriesCount: 1,
        coverUrl: null,
        coverIsbn: null,
      });
      await ctx.db.insert("seriesCredits", { seriesId, personId, role: "story_art" });
      const observationId = await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: `${slug}/volume-1#physical`,
        snapshot: {
          creators: ["Kei Urana", "Hideyoshi Andou"],
          format: "physical",
          kind: "kodanshaVolume",
          packaging: { coverRange: null, lineName: "Box Set", linePosition: "1" },
          seriesSlug: slug,
          seriesTitle: "Gachiakuta Dumpster",
          seriesUrl: url,
          title: "Gachiakuta Dumpster Manga Box Set Volume 1",
          url: `${url}volume-1/`,
        },
      });
      await ctx.db.insert("placementHolds", {
        observationId,
        sourceKey: "kodansha",
        kind: "packaging",
        heldAt: 1,
      });
      return { seriesId, observationId };
    });
    const gachiakuta = (heading: string) =>
      t.query(preview, {
        proof: {
          ...proof(f),
          seriesSlug: slug,
          seriesId: ids.seriesId,
          sourceTitle: "Gachiakuta Dumpster",
          lineName: "Box Set",
          observationIds: [ids.observationId],
          capture: {
            ...proof(f).capture,
            url,
            excerpt: ["Manga", heading, heading, "By Kei Urana"].join("\n"),
            statesHeading: heading,
            statesAuthors: ["Kei Urana"],
            volumeLinks: [`${url}volume-1/`],
          },
        },
      }) as Promise<Preview>;
    // The live heading ("... Manga Box Set") is not the volumes' title and Line.
    expect((await gachiakuta("Gachiakuta Dumpster Manga Box Set")).refusal).toContain(
      "Page heading",
    );
    // Even a heading that matched would leave "Gachiakuta Dumpster" no name of "Gachiakuta".
    expect((await gachiakuta("Gachiakuta Dumpster Box Set")).refusal).toContain(
      "not a name of the reviewed Series",
    );
  });

  describe("restore refuses once anything builds on the parent", () => {
    async function applied() {
      const f = await fixture();
      const p = await look(f);
      const result = await apply(f, p.expected!);
      expect(result.status).toBe("linked");
      return { f, result };
    }
    it("a later snapshot of the parent", async () => {
      const { f, result } = await applied();
      await f.t.run(async (ctx) => {
        const parent = (await ctx.db.get(result.parentId!))!;
        await ctx.db.insert("observationSnapshots", {
          observationId: parent._id,
          snapshot: parent.snapshot,
          supersededAt: 5,
        });
        await ctx.db.patch(parent._id, { snapshot: { ...parent.snapshot, mature: false } });
      });
      const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
      expect(r.refusal).toContain("Parent changed");
    });
    it("a volume linked after the parent was written", async () => {
      const { f, result } = await applied();
      await f.t.run(async (ctx) => {
        await ctx.db.patch(f.observationIds[0]!, {
          recordRef: { type: "release", id: f.releaseIds[0]! },
        });
      });
      const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
      expect(r.refusal).toContain("linked after the parent");
      const before = await dump(f.t);
      const done = await f.t.mutation(restore, {
        ledgerId: result.ledgerId!,
        actor: "ari",
        reason: "Undo.",
        expected: "stale",
      });
      expect(done.status).toBe("refused");
      expect(await dump(f.t)).toBe(before);
    });
  });
});

describe("Independent G5 adversarial review", () => {
  it("B1 printing alias contrary Series is refused", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const other = await insertSeries(ctx, { title: "Tsubasa" });
      const target = (await ctx.db.get(f.releaseIds[0]!))!;
      const alias = await insertRelease(ctx, {
        editionId: target.editionId,
        publisherId: f.publisherId,
        seriesIds: [other],
        status: "merged",
        mergedIntoId: target._id,
      });
      await ctx.db.insert("releaseIsbns", {
        releaseId: alias,
        isbn13: VOLUMES[0]!.digital,
        reason: "Review printing alias",
        sourceKey: "kodansha",
      });
    });
    const p = await look(f);
    expect(p.refusal).toBeTruthy();
    expect((await apply(f, "stale")).status).toBe("refused");
  });
  it("B1 intermediate contrary Release and its drift are refused", async () => {
    const f = await fixture();
    const middle = await f.t.run(async (ctx) => {
      const target = (await ctx.db.get(f.releaseIds[0]!))!;
      const mid = await insertRelease(ctx, {
        editionId: target.editionId,
        publisherId: f.publisherId,
        seriesIds: [f.seriesId],
        status: "merged",
        mergedIntoId: target._id,
      });
      await insertRelease(ctx, {
        editionId: target.editionId,
        publisherId: f.publisherId,
        seriesIds: [f.seriesId],
        isbn13: VOLUMES[0]!.digital,
        status: "merged",
        mergedIntoId: mid,
      });
      return mid;
    });
    const p = await look(f);
    expect(p.refusal).toBeNull();
    await f.t.run(async (ctx) => {
      const other = await insertSeries(ctx, { title: "Tsubasa" });
      await ctx.db.patch(middle, { seriesIds: [other] });
    });
    const next = await look(f);
    expect(next.refusal).toBeTruthy();
    expect(next.expected).not.toBe(p.expected);
    expect((await apply(f, p.expected!)).status).toBe("refused");
  });
  it("B2 second contrary placementHold is refused", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const other = await insertSeries(ctx, { title: "Tsubasa" });
      await ctx.db.insert("placementHolds", {
        observationId: f.observationIds[0]!,
        sourceKey: "kodansha",
        kind: "packaging",
        heldAt: 2,
        seriesId: other,
      });
    });
    const p = await look(f);
    expect(p.refusal).toBeTruthy();
    expect((await apply(f, "stale")).status).toBe("refused");
  });
  it("B3 restore refuses after its audit Proposal and Revision are deleted", async () => {
    const f = await fixture();
    const p = await look(f);
    const result = await apply(f, p.expected!);
    await f.t.run(async (ctx) => {
      await ctx.db.delete(result.proposalId!);
      for (const rev of await ctx.db.query("revisions").collect()) await ctx.db.delete(rev._id);
    });
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    expect(r.refusal).toBeTruthy();
    expect(
      (
        await f.t.mutation(restore, {
          ledgerId: result.ledgerId!,
          actor: "ari",
          reason: "Review",
          expected: r.expected ?? "stale",
        })
      ).status,
    ).toBe("refused");
  });
  it("B3 audit deletion after restore preview invalidates expected", async () => {
    const f = await fixture();
    const p = await look(f);
    const result = await apply(f, p.expected!);
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    await f.t.run(async (ctx) => {
      await ctx.db.patch(result.proposalId!, { state: "withdrawn" });
    });
    const next = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    expect(next.expected).not.toBe(r.expected);
    expect(
      (
        await f.t.mutation(restore, {
          ledgerId: result.ledgerId!,
          actor: "ari",
          reason: "Review",
          expected: r.expected ?? "stale",
        })
      ).status,
    ).toBe("refused");
  });
  it("control restore refuses newly added linked volume", async () => {
    const f = await fixture();
    const p = await look(f);
    const result = await apply(f, p.expected!);
    await f.t.run(async (ctx) => {
      await insertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: `${SLUG}/volume-4#physical`,
        snapshot: volumeSnapshot(4, "physical", VOLUMES[0]!.physical),
        recordRef: { type: "release", id: f.releaseIds[0]! },
      });
    });
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    expect(r.refusal).toContain("linked after");
  });
  it("control restore refuses stale preview after later child changes", async () => {
    const f = await fixture();
    const p = await look(f);
    const result = await apply(f, p.expected!);
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.observationIds[0]!, { lastSeenAt: 999 });
    });
    const before = await dump(f.t);
    expect(
      (
        await f.t.mutation(restore, {
          ledgerId: result.ledgerId!,
          actor: "ari",
          reason: "Review",
          expected: r.expected!,
        })
      ).status,
    ).toBe("refused");
    expect(await dump(f.t)).toBe(before);
  });
  it("control exceeds complete closure bound with no writes", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let n = 4; n < 80; n++)
        await insertObservation(ctx, {
          sourceKey: "kodansha",
          sourceRecordId: `${SLUG}/volume-${n}#physical`,
          snapshot: volumeSnapshot(n, "physical", VOLUMES[0]!.physical),
        });
    });
    await refuses(f, "incomplete");
  });
});

describe("Independent G5 further controls", () => {
  it("B3 retry refuses an approved Proposal with no immutable audit version", async () => {
    const f = await fixture();
    const p = await look(f);
    expect((await apply(f, p.expected!)).status).toBe("linked");
    await f.t.run(async (ctx) => {
      for (const version of await ctx.db.query("proposalVersions").collect())
        await ctx.db.delete(version._id);
    });
    expect((await apply(f, p.expected!)).status).toBe("refused");
  });
  it("B4 duplicate declared-name and author Series remains ambiguous when ISBNs unowned", async () => {
    const f = await fixture();
    const other = await f.t.run(async (ctx) => {
      for (const id of f.releaseIds) await ctx.db.delete(id);
      const other = await insertSeries(ctx, { title: TITLE });
      await ctx.db.insert("seriesCredits", {
        seriesId: other,
        personId: f.personId,
        role: "story_art",
      });
      return other;
    });
    expect((await look(f)).refusal).toContain("ambiguous");
    expect((await look(f, { seriesId: other })).refusal).toContain("ambiguous");
  });
  it("control low transaction budget refuses with unchanged database", async () => {
    const f = await fixture(makeT({ transactionLimits: { documentsWritten: 120 } }));
    const p = await look(f);
    if (p.expected) {
      const before = await dump(f.t);
      const result = await apply(f, p.expected);
      expect(result.status).toBe("refused");
      expect(await dump(f.t)).toBe(before);
    } else expect(p.refusal).toBeTruthy();
  });
});

describe("Independent transaction rollback controls", () => {
  it("apply audit failure after parent insertion rolls back every write", async () => {
    const f = await fixture();
    const p = await look(f);
    const before = await dump(f.t);
    const create = repairAudit.createAudit;
    const spy = vi.spyOn(repairAudit, "createAudit").mockImplementation((...args) => {
      const audit = create(...args);
      const finish = audit.finish;
      audit.finish = async () => {
        await finish.call(audit);
        throw new ConvexError("Independent forced audit failure");
      };
      return audit;
    });
    try {
      const result = await apply(f, p.expected!);
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("forced audit failure");
      expect(await dump(f.t)).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
  it("restore audit failure after Revision insertion rolls back every write", async () => {
    const f = await fixture();
    const p = await look(f);
    const result = await apply(f, p.expected!);
    const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
    const before = await dump(f.t);
    const create = repairAudit.createAudit;
    const spy = vi.spyOn(repairAudit, "createAudit").mockImplementation((...args) => {
      const audit = create(...args);
      const finish = audit.finish;
      audit.finish = async () => {
        await finish.call(audit);
        throw new ConvexError("Independent forced audit failure");
      };
      return audit;
    });
    try {
      const done = await f.t.mutation(restore, {
        ledgerId: result.ledgerId!,
        actor: "ari",
        reason: "Review",
        expected: r.expected!,
      });
      expect(done.status).toBe("refused");
      expect(done.reason).toContain("forced audit failure");
      expect(await dump(f.t)).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});

// Additional revision2 regressions exercise every audited retry and merge hop.
describe("G5 revision2 complete guards", () => {
  async function printingChain(f: Fixture, count = 2) {
    return await f.t.run(async (ctx) => {
      const target = (await ctx.db.get(f.releaseIds[0]!))!;
      const ids: Id<"releases">[] = [];
      let next = target._id;
      for (let n = 0; n < count; n++) {
        next = await insertRelease(ctx, {
          editionId: target.editionId,
          publisherId: f.publisherId,
          seriesIds: [f.seriesId],
          status: "merged",
          mergedIntoId: next,
        });
        ids.push(next);
      }
      const claimId = await ctx.db.insert("releaseIsbns", {
        releaseId: next,
        isbn13: VOLUMES[0]!.digital,
        reason: "Reviewed printing",
        sourceKey: "kodansha",
      });
      return { ids, claimId };
    });
  }
  it("accepts printing aliases with valid Series aliases on every hop", async () => {
    const f = await fixture();
    const chain = await printingChain(f);
    await f.t.run(async (ctx) => {
      const alias = await insertSeries(ctx, {
        title: "Old CCS",
        status: "merged",
        mergedIntoId: f.seriesId,
      });
      for (const id of chain.ids) await ctx.db.patch(id, { seriesIds: [alias] });
    });
    const p = await look(f);
    expect(p.refusal).toBeNull();
    expect((await apply(f, p.expected!)).status).toBe("linked");
    expect((await apply(f, p.expected!)).status).toBe("alreadyApplied");
  });
  it("pins a printing's intermediate Release even when identity still agrees", async () => {
    const f = await fixture();
    const chain = await printingChain(f);
    const p = await look(f);
    await f.t.run((ctx) => ctx.db.patch(chain.ids[0]!, { binding: "hardcover" }));
    expect((await look(f)).expected).not.toBe(p.expected);
    const before = await dump(f.t);
    expect((await apply(f, p.expected!)).status).toBe("refused");
    expect(await dump(f.t)).toBe(before);
  });
  for (const fault of ["missing", "unknown", "cycle", "overlong"] as const) {
    it(`refuses ${fault} printing Release chains`, async () => {
      const f = await fixture();
      const chain = await printingChain(f, fault === "overlong" ? 9 : 2);
      await f.t.run(async (ctx) => {
        if (fault === "missing") await ctx.db.delete(chain.ids[0]!);
        if (fault === "unknown") await ctx.db.patch(chain.ids[0]!, { seriesIds: [] });
        if (fault === "cycle") await ctx.db.patch(chain.ids[0]!, { mergedIntoId: chain.ids[1]! });
      });
      await refuses(
        f,
        fault === "overlong" ? "eight hops" : fault === "unknown" ? "unknown Series" : fault,
      );
    });
  }
  for (const fault of ["missing", "cycle", "overlong"] as const) {
    it(`refuses ${fault} owner Series merge chains`, async () => {
      const f = await fixture();
      await f.t.run(async (ctx) => {
        const aliases: Id<"series">[] = [];
        let next = f.seriesId;
        for (let n = 0; n < (fault === "overlong" ? 9 : 2); n++) {
          next = await insertSeries(ctx, {
            title: `Old ${n}`,
            status: "merged",
            mergedIntoId: next,
          });
          aliases.push(next);
        }
        await ctx.db.patch(f.releaseIds[0]!, { seriesIds: [next] });
        if (fault === "missing") await ctx.db.delete(aliases[0]!);
        if (fault === "cycle") await ctx.db.patch(aliases[0]!, { mergedIntoId: aliases[1]! });
      });
      await refuses(f, fault === "overlong" ? "eight hops" : fault);
    });
  }
  it("pins each Series merge hop", async () => {
    const f = await fixture();
    const middle = await f.t.run(async (ctx) => {
      const middle = await insertSeries(ctx, {
        title: "Old CCS",
        status: "merged",
        mergedIntoId: f.seriesId,
      });
      const start = await insertSeries(ctx, {
        title: "Older CCS",
        status: "merged",
        mergedIntoId: middle,
      });
      await ctx.db.patch(f.releaseIds[0]!, { seriesIds: [start] });
      return middle;
    });
    const p = await look(f);
    expect(p.refusal).toBeNull();
    await f.t.run((ctx) => ctx.db.patch(middle, { synopsis: "Changed alias" }));
    expect((await look(f)).expected).not.toBe(p.expected);
    expect((await apply(f, p.expected!)).status).toBe("refused");
  });
  it("refuses duplicate unscoped holds too and leaves no writes", async () => {
    const f = await fixture();
    const p = await look(f);
    await f.t.run((ctx) =>
      ctx.db.insert("placementHolds", {
        observationId: f.observationIds[0]!,
        sourceKey: "kodansha",
        kind: "packaging",
        heldAt: 3,
      }),
    );
    await refuses(f, "multiple holds");
    expect((await apply(f, p.expected!)).status).toBe("refused");
  });
  it("finds duplicates by altTitle even when searchText omits that declaration", async () => {
    const f = await fixture();
    const p = await look(f);
    await f.t.run(async (ctx) => {
      for (let n = 0; n < 90; n++) await insertSeries(ctx, { title: `Unrelated ${n}` });
      await insertSeries(ctx, {
        title: "Unindexed duplicate",
        altTitles: [TITLE],
        searchText: "unrelated",
      });
    });
    await refuses(f, "ambiguous");
    expect((await apply(f, p.expected!)).status).toBe("refused");
  });
  it("refuses a partial full-table scan when read headroom runs out", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let n = 0; n < 90; n++) await insertSeries(ctx, { title: `Unrelated ${n}` });
    });
    const metrics = await f.t.run((ctx) => ctx.meta.getTransactionMetrics());
    const spy = vi.spyOn(repairAudit, "createAudit");
    try {
      // A separate query receives a deliberately smaller document read budget.
      const result = (await f.t.run(async (ctx) => {
        return await ctx.runQuery(
          preview,
          { proof: proof(f) },
          {
            transactionLimits: { documentsRead: Math.min(80, metrics.documentsRead.remaining) },
          },
        );
      })) as Preview;
      expect(result.refusal).toContain("incomplete");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  for (const fault of [
    "versionDeleted",
    "versionOperation",
    "versionEvidence",
    "revision",
    "proposalVersion",
  ] as const) {
    it(`refuses ${fault} apply receipts on both retry and restore`, async () => {
      const f = await fixture();
      const p = await look(f);
      const result = await apply(f, p.expected!);
      const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
      await f.t.run(async (ctx) => {
        const versions = await ctx.db.query("proposalVersions").collect();
        const revisions = await ctx.db.query("revisions").collect();
        if (fault === "versionDeleted") await ctx.db.delete(versions[0]!._id);
        if (fault === "versionOperation") await ctx.db.patch(versions[0]!._id, { ops: [] });
        if (fault === "versionEvidence")
          await ctx.db.patch(versions[0]!._id, { evidence: [{ kind: "note", text: "Forged" }] });
        if (fault === "revision") await ctx.db.patch(revisions[0]!._id, { changes: [] });
        if (fault === "proposalVersion")
          await ctx.db.patch(result.proposalId!, { currentVersionNo: 2 });
      });
      const before = await dump(f.t);
      expect((await apply(f, p.expected!)).status).toBe("refused");
      expect(
        ((await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview).refusal,
      ).toContain("audit receipt");
      expect(
        (
          await f.t.mutation(restore, {
            ledgerId: result.ledgerId!,
            actor: "ari",
            reason: "Undo",
            expected: r.expected!,
          })
        ).status,
      ).toBe("refused");
      expect(await dump(f.t)).toBe(before);
    });
    it(`refuses ${fault} restore receipts before alreadyRestored`, async () => {
      const f = await fixture();
      const p = await look(f);
      const result = await apply(f, p.expected!);
      const r = (await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview;
      const undone = await f.t.mutation(restore, {
        ledgerId: result.ledgerId!,
        actor: "ari",
        reason: "Undo",
        expected: r.expected!,
      });
      expect(undone.status).toBe("restored");
      await f.t.run(async (ctx) => {
        const versions = await ctx.db
          .query("proposalVersions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", undone.proposalId!))
          .collect();
        const revisions = await ctx.db
          .query("revisions")
          .withIndex("by_proposal", (q) => q.eq("proposalId", undone.proposalId!))
          .collect();
        if (fault === "versionDeleted") await ctx.db.delete(versions[0]!._id);
        if (fault === "versionOperation") await ctx.db.patch(versions[0]!._id, { ops: [] });
        if (fault === "versionEvidence")
          await ctx.db.patch(versions[0]!._id, { evidence: [{ kind: "note", text: "Forged" }] });
        if (fault === "revision") await ctx.db.patch(revisions[0]!._id, { changes: [] });
        if (fault === "proposalVersion")
          await ctx.db.patch(undone.proposalId!, { currentVersionNo: 2 });
      });
      const before = await dump(f.t);
      expect(
        ((await f.t.query(previewRestore, { ledgerId: result.ledgerId! })) as Preview).refusal,
      ).toContain("audit receipt");
      expect(
        (
          await f.t.mutation(restore, {
            ledgerId: result.ledgerId!,
            actor: "ari",
            reason: "Undo",
            expected: r.expected!,
          })
        ).status,
      ).toBe("refused");
      expect(await dump(f.t)).toBe(before);
    });
  }
});
