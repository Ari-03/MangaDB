// The shared import pipeline (lib/pipeline.ts) below the adapters: Volume
// Position rules, publisher resolution (duplicates, imprints, merges), and
// the packaging creation paths — Edition Line members covering real
// Volumes and box sets as Release Bundles.

import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "../test.factories";
import { makeT } from "../test.helpers";
import { holdOf, upsertObservation } from "./observations";
import {
  type CreationArgs,
  createCanonicalRecords,
  createReleaseBundle as createOrHoldBundle,
  ensurePublisher,
  findPublisherByName,
  queueCreationProposal,
  reconcileLinkedSeries,
  volumePositionFor,
} from "./pipeline";
import { applyCreatePlan, planCreateOps } from "./proposalCreates";

const CITATION = {
  sourceName: "Test Source",
  url: "https://example.org/record",
};

/** The fields every creation case shares: PRH as the source, the test citation, untagged, at time 1. */
type Shared = "sourceKey" | "citation" | "importComment" | "tagBootstrapUnreviewed" | "now";

/**
 * createCanonicalRecords with the shared fields defaulted; a case overrides
 * the source or the tag. These cases always create (or find a hidden Series).
 */
const create = async (
  ctx: MutationCtx,
  args: Omit<CreationArgs, Shared> & Partial<Pick<CreationArgs, Shared>>,
) => {
  const result = await createCanonicalRecords(ctx, {
    sourceKey: "prh",
    citation: CITATION,
    importComment: "test",
    tagBootstrapUnreviewed: false,
    now: 1,
    ...args,
  });
  if (result.seriesId === null) throw new Error(`not created: ${result.blocked}`);
  return { ...result, seriesId: result.seriesId };
};

/** createReleaseBundle for the cases below, none of which is held. */
const createReleaseBundle = async (...args: Parameters<typeof createOrHoldBundle>) => {
  const result = await createOrHoldBundle(...args);
  if ("held" in result) throw new Error(`held: ${result.held}`);
  return result;
};

async function observation(ctx: MutationCtx, sourceRecordId: string) {
  const { observation } = await upsertObservation(ctx, {
    sourceKey: "prh",
    sourceRecordId,
    snapshot: { kind: "test", id: sourceRecordId },
    now: 1,
  });
  return observation;
}

async function publisher(
  ctx: MutationCtx,
  name: string,
  slug: string,
  extra: Pick<Partial<Doc<"publishers">>, "status" | "mergedIntoId"> = {},
) {
  return await insertPublisher(ctx, { name, slug, ...extra });
}

/** An active Series with Volumes at the given (numeric) labels. */
async function series(ctx: MutationCtx, title: string, labels: string[]) {
  const seriesId = await insertSeries(ctx, { title });
  for (const label of labels) await insertVolume(ctx, { seriesId, position: Number(label) });
  return seriesId;
}

describe("volumePositionFor", () => {
  it("uses the volume number itself, so gaps show missing volumes", () => {
    expect(volumePositionFor("7", new Set([1, 2]))).toBe(7);
    expect(volumePositionFor("0", new Set([1, 2]))).toBe(0);
    expect(volumePositionFor("7.5", new Set([7, 8]))).toBe(7.5);
  });

  it("sorts an unnumbered volume after the last whole number, never on the next one", () => {
    expect(volumePositionFor(undefined, new Set())).toBe(1);
    expect(volumePositionFor(undefined, new Set([1, 2, 5]))).toBe(5.5);
    expect(volumePositionFor("Side Story", new Set([1, 2, 5, 5.5]))).toBe(5.75);
    // A taken number lands just after itself.
    expect(volumePositionFor("3", new Set([3]))).toBe(3.5);
  });
});

describe("createCanonicalRecords — Volumes", () => {
  it("stores canonical labels at their number and dedupes within one call", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const obs = await observation(ctx, "a");
      const result = await create(ctx, {
        observation: obs,
        seriesId: null,
        seriesTitle: "Otherside Picnic",
        labels: ["05", "0", "5", "7.5"],
      });
      const volumes = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", result.seriesId))
        .collect();
      expect(volumes.map((v) => [v.label, v.position])).toEqual([
        ["0", 0],
        ["5", 5],
        ["7.5", 7.5],
      ]);
      // "05" and "5" are one Volume.
      expect(result.volumeIds[0]).toBe(result.volumeIds[2]);
    });
  });

  it("creates a Series with no placeholder Volume when asked for the Series only", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const result = await create(ctx, {
        sourceKey: "ann",
        observation: await observation(ctx, "omnibus-only"),
        seriesId: null,
        seriesTitle: "Homunculus",
        labels: [],
        seriesOnly: true,
        tagBootstrapUnreviewed: true,
      });
      expect(result.volumeIds).toEqual([]);
      expect(await ctx.db.query("volumes").collect()).toHaveLength(0);
    });
  });
});

describe("queueCreationProposal", () => {
  it("reuses the survivor of a merged unnumbered Volume", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const seriesId = await series(ctx, "One shot", ["1"]);
      const survivor = (await ctx.db.query("volumes").collect())[0]!;
      await insertVolume(ctx, {
        status: "merged",
        seriesId,
        position: 0.5,
        label: undefined,
        mergedIntoId: survivor._id,
      });
      const proposalId = await queueCreationProposal(ctx, {
        sourceKey: "prh",
        observation: await observation(ctx, "one-shot"),
        seriesId,
        seriesTitle: "One shot",
        labels: [],
        release: { format: "physical", publisherSlug: "kodansha" },
        comment: "Review release",
        now: 1,
      });
      const version = (await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique())!;
      expect(version.ops.filter((op) => op.kind === "create" && op.table === "volumes")).toEqual(
        [],
      );
      expect(
        version.ops.find((op) => op.kind === "create" && op.table === "editions"),
      ).toMatchObject({
        fields: {
          volumeCoverage: [{ volume: survivor._id, order: 1, extent: "complete" }],
        },
      });
    });
  });

  it("approves new packaging using existing Volumes and creates only missing labels", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Noragami", ["1", "2"]);
      const before = await ctx.db.query("volumes").collect();
      const proposalId = await queueCreationProposal(ctx, {
        sourceKey: "prh",
        observation: await observation(ctx, "omnibus"),
        seriesId,
        seriesTitle: "Noragami",
        labels: ["01", "2", "3", "03"],
        release: { format: "physical", publisherSlug: "kodansha" },
        comment: "Review omnibus coverage",
        now: 1,
      });
      const version = (await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique())!;
      expect(
        version.ops.filter((op) => op.kind === "create" && op.table === "volumes"),
      ).toHaveLength(1);
      const createOps = version.ops.filter((op) => op.kind === "create");
      const plans = await planCreateOps(ctx, createOps);
      const temp = new Map<string, string>();
      for (const plan of plans) await applyCreatePlan(ctx, plan, temp);
      const after = await ctx.db.query("volumes").collect();
      expect(after.map((volume) => volume.label)).toEqual(["1", "2", "3"]);
      const coverage = await ctx.db.query("volumeCoverages").collect();
      expect(coverage.map((row) => row.volumeId)).toEqual([
        before.find((volume) => volume.label === "1")!._id,
        before.find((volume) => volume.label === "2")!._id,
        after.find((volume) => volume.label === "3")!._id,
      ]);
    });
  });

  it("queues no placement marks: an import's Volume and Edition never join records created meanwhile", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Noragami", ["1"]);
      const volume1 = (await ctx.db.query("volumes").collect())[0]!._id;
      const proposalId = await queueCreationProposal(ctx, {
        sourceKey: "prh",
        observation: await observation(ctx, "omnibus"),
        seriesId,
        seriesTitle: "Noragami",
        labels: ["1", "2"],
        editionLine: { name: "Omnibus", position: "1" },
        release: { format: "physical", publisherSlug: "kodansha", isbn13: "9781646510001" },
        comment: "Review omnibus coverage",
        now: 1,
      });
      const version = (await ctx.db
        .query("proposalVersions")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .unique())!;
      expect(version.ops).toEqual([
        { kind: "create", table: "volumes", tempId: "volume-2", fields: { seriesId, label: "2" } },
        {
          kind: "create",
          table: "editionLines",
          tempId: "edition-line",
          fields: { seriesId, publisherSlug: "kodansha", name: "Omnibus", joinExisting: true },
        },
        {
          kind: "create",
          table: "editions",
          tempId: "edition",
          fields: {
            publisherSlug: "kodansha",
            editionLineId: "edition-line",
            linePosition: "1",
            volumeCoverage: [
              { volume: volume1, order: 1, extent: "complete" },
              { volume: "volume-2", order: 2, extent: "complete" },
            ],
          },
        },
        {
          kind: "create",
          table: "releases",
          tempId: "release",
          fields: {
            editionId: "edition",
            format: "physical",
            language: "en",
            isbn13: "9781646510001",
          },
        },
      ]);
    });
  });
});

describe("publisher resolution", () => {
  it("resolves duplicates exactly before any prefix, and imprints to their own row", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      // The historical PRH duplicate row, not yet merged.
      await publisher(ctx, "Kodansha Comics", "kodansha-comics");
      const sevenSeas = await publisher(ctx, "Seven Seas Entertainment", "seven-seas");
      const ghostShip = await publisher(ctx, "Ghost Ship", "ghost-ship");
      const squareEnix = await publisher(ctx, "Square Enix", "square-enix");
      await publisher(ctx, "Square Enix Manga", "square-enix-manga");

      expect((await findPublisherByName(ctx, "Kodansha Comics"))?._id).toBe(kodansha);
      expect((await findPublisherByName(ctx, "Kodansha"))?._id).toBe(kodansha);
      expect((await findPublisherByName(ctx, "Square Enix Manga"))?._id).toBe(squareEnix);
      expect((await findPublisherByName(ctx, "Ghost Ship"))?._id).toBe(ghostShip);
      expect((await findPublisherByName(ctx, "Seven Seas"))?._id).toBe(sevenSeas);
      expect((await findPublisherByName(ctx, "Seven Seas Entertainment, LLC"))?._id).toBe(
        sevenSeas,
      );
      expect((await findPublisherByName(ctx, "Kodansha USA Publishing"))?._id).toBe(kodansha);
      expect(await findPublisherByName(ctx, "NASA")).toBeNull();
    });
  });

  it("follows a merged row to its survivor", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const darkHorse = await publisher(ctx, "Dark Horse", "dark-horse");
      await publisher(ctx, "Dark Horse Manga", "dark-horse-manga", {
        status: "merged",
        mergedIntoId: darkHorse,
      });
      const oddball = await publisher(ctx, "Oddball", "oddball");
      await publisher(ctx, "Oddball Press", "oddball-press", {
        status: "merged",
        mergedIntoId: oddball,
      });
      expect((await findPublisherByName(ctx, "Dark Horse Manga"))?._id).toBe(darkHorse);
      expect((await findPublisherByName(ctx, "Oddball Press"))?._id).toBe(oddball);
      // Creation never lands on the merged row either.
      expect(
        (
          await ensurePublisher(ctx, {
            name: "Oddball Press",
            slug: "oddball-press",
          })
        ).id,
      ).toBe(oddball);
      expect(
        (
          await ensurePublisher(ctx, {
            name: "Dark Horse Manga",
            slug: "dark-horse-manga",
          })
        ).id,
      ).toBe(darkHorse);
    });
  });

  it("creates an imprint row under its existing parent", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const tokyopop = await publisher(ctx, "Tokyopop", "tokyopop");
      const created = await ensurePublisher(ctx, {
        name: "TOKYOPOP LoveLove",
        slug: "tokyopop-lovelove",
        parentSlug: "tokyopop",
      });
      expect(created.created).toBe(true);
      expect((await ctx.db.get(created.id))?.parentPublisherId).toBe(tokyopop);
    });
  });
});

describe("createCanonicalRecords — Edition Lines", () => {
  it("puts an omnibus in the base Series' line, covering the real Volumes", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Noragami", ["19", "20"]);
      const physical = await create(ctx, {
        observation: await observation(ctx, "9781646519026"),
        seriesId,
        seriesTitle: "Noragami",
        labels: ["19", "20", "21"],
        editionLine: { name: "Omnibus", position: "7" },
        release: {
          format: "physical",
          isbn13: "9781646519026",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
        tagBootstrapUnreviewed: true,
      });
      // The digital release of the same omnibus joins its Edition.
      const digital = await create(ctx, {
        observation: await observation(ctx, "9781646519033"),
        seriesId,
        seriesTitle: "Noragami",
        labels: ["19", "20", "21"],
        editionLine: { name: "Omnibus", position: "7" },
        release: {
          format: "digital",
          isbn13: "9781646519033",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
        tagBootstrapUnreviewed: true,
      });
      const lines = await ctx.db.query("editionLines").collect();
      expect(lines).toMatchObject([{ seriesId, name: "Omnibus" }]);
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      expect(editions[0]).toMatchObject({
        editionLineId: lines[0]!._id,
        linePosition: "7",
      });
      const coverage = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", editions[0]!._id))
        .collect();
      const labels = await Promise.all(
        coverage.map(async (row) => (await ctx.db.get(row.volumeId))?.label),
      );
      expect(labels).toEqual(["19", "20", "21"]);
      // Only Volume 21 was missing; the omnibus never became a Volume "7".
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["19", "20", "21"]);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.editionId)).toEqual([editions[0]!._id, editions[0]!._id]);
      expect(physical.releaseId).not.toBe(digital.releaseId);
    });
  });

  it("never files a single volume and an omnibus under one Edition", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Ichi the Killer", []);
      const release = (isbn13: string) => ({
        format: "physical" as const,
        isbn13,
        publisher: { name: "Kodansha", slug: "kodansha" },
      });
      const base = { seriesId, seriesTitle: "Ichi the Killer" };
      await create(ctx, {
        ...base,
        observation: await observation(ctx, "single"),
        labels: ["1"],
        release: release("9780000000002"),
      });
      await create(ctx, {
        ...base,
        observation: await observation(ctx, "omnibus"),
        labels: ["1", "2"],
        editionLine: { name: "Omnibus", position: "1" },
        release: release("9780000000019"),
      });
      expect(await ctx.db.query("editions").collect()).toHaveLength(2);
    });
  });

  it("refuses packaging without covered Volumes", async () => {
    const t = makeT();
    await expect(
      t.run(async (ctx) => {
        await create(ctx, {
          observation: await observation(ctx, "negima-omnibus-4"),
          seriesId: null,
          seriesTitle: "Negima!",
          labels: [],
          editionLine: { name: "Omnibus", position: "4" },
          tagBootstrapUnreviewed: true,
        });
      }),
    ).rejects.toThrow(/packaging never becomes a Volume/);
  });
});

/** A creator of single-Volume Kodansha Releases in one Series; returns the Release. */
function volumeCreator(ctx: MutationCtx, seriesId: Id<"series">) {
  return async (label: string, isbn13: string, format: "physical" | "digital" = "physical") =>
    (
      await create(ctx, {
        observation: await observation(ctx, `vol-${isbn13}`),
        seriesId,
        seriesTitle: "Fire Force",
        labels: [label],
        release: { format, isbn13, publisher: { name: "Kodansha", slug: "kodansha" } },
      })
    ).releaseId!;
}

/** A Kodansha physical box of these Volume labels, as PRH lists it in Bootstrap Mode. */
const fireForceBox = (seriesId: Id<"series">, labels: string[]) => ({
  sourceKey: "prh",
  citation: CITATION,
  importComment: "test",
  seriesId,
  name: `Fire Force Box Set 1 (Vol. ${labels[0]}-${labels.at(-1)})`,
  labels,
  publisher: { name: "Kodansha", slug: "kodansha" },
  release: { format: "physical" as const, isbn13: "9798888772584" },
  tagBootstrapUnreviewed: true,
  now: 1,
});

/** A bundle's memberships in page order (by order, then creation). */
const membershipsOf = (ctx: MutationCtx, bundleId: Id<"releaseBundles">) =>
  ctx.db
    .query("bundleMemberships")
    .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
    .collect();

describe("createReleaseBundle", () => {
  it("bundles the existing member Releases and is idempotent by ISBN", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      for (const label of ["1", "2"]) {
        await create(ctx, {
          observation: await observation(ctx, `vol-${label}`),
          seriesId,
          seriesTitle: "Fire Force",
          labels: [label],
          release: {
            format: "physical",
            isbn13: `97800000000${label === "1" ? "02" : "19"}`,
            publisher: { name: "Kodansha", slug: "kodansha" },
          },
        });
      }
      const box = fireForceBox(seriesId, ["1", "2", "3", "4", "5", "6"]);
      const first = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "9798888772584"),
      });
      expect(first).toMatchObject({ created: true, members: 2 });
      const bundle = await ctx.db.get(first.bundleId);
      expect(bundle).toMatchObject({
        publisherId: kodansha,
        isbn13: "9798888772584",
      });
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(2);
      // The box never became a Release, a Volume, or a Series.
      expect(await ctx.db.query("releases").collect()).toHaveLength(2);
      expect(await ctx.db.query("series").collect()).toHaveLength(1);

      const again = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "9798888772584"),
      });
      expect(again).toMatchObject({ created: false, bundleId: first.bundleId });
      expect(await ctx.db.query("releaseBundles").collect()).toHaveLength(1);
    });
  });
});

describe("createReleaseBundle — a printing's ISBN", () => {
  it("holds a box whose ISBN is a Release's other printing, creating nothing", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", ["1"]);
      const editionId = await insertEdition(ctx, { publisherId: kodansha });
      const releaseId = await insertRelease(ctx, {
        editionId,
        publisherId: kodansha,
        seriesIds: [seriesId],
      });
      await ctx.db.insert("releaseIsbns", {
        releaseId,
        isbn13: "9798888772584",
        reason: "Another printing.",
        sourceKey: "ann",
      });
      const obs = await observation(ctx, "box");
      expect(
        await createOrHoldBundle(ctx, { ...fireForceBox(seriesId, ["1"]), observation: obs }),
      ).toEqual({
        held: expect.stringContaining("Bundle ISBN is reserved by a Release"),
      });
      expect(await ctx.db.query("releaseBundles").collect()).toEqual([]);
      expect(await holdOf(ctx, obs._id)).toMatchObject({ kind: "isbn", seriesId });
    });
  });
});

describe("createReleaseBundle — members that arrive later (B15)", () => {
  it("a box imported before its books picks them up when retried", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const box = fireForceBox(seriesId, ["1", "2", "3"]);
      const early = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      expect(early).toMatchObject({ created: true, members: 0 });

      // The books arrive after the box, volume 2 and 3 out of order.
      const releaseIds: Record<string, Id<"releases">> = {};
      for (const [label, isbn13] of [
        ["3", "9780000000033"],
        ["2", "9780000000026"],
      ] as const) {
        const result = await create(ctx, {
          observation: await observation(ctx, `vol-${label}`),
          seriesId,
          seriesTitle: "Fire Force",
          labels: [label],
          release: {
            format: "physical",
            isbn13,
            publisher: { name: "Kodansha", slug: "kodansha" },
          },
        });
        releaseIds[label] = result.releaseId!;
      }

      const retry = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      expect(retry).toMatchObject({ created: false, bundleId: early.bundleId, members: 2 });
      const memberships = await ctx.db
        .query("bundleMemberships")
        .withIndex("by_bundle", (q) => q.eq("bundleId", early.bundleId))
        .collect();
      // Ordered by the box's own volume sequence, not by arrival.
      expect(memberships.map((m) => [m.releaseId, m.order])).toEqual([
        [releaseIds["2"], 2],
        [releaseIds["3"], 3],
      ]);
      // The added members are public history on the bundle.
      const revisions = await ctx.db
        .query("revisions")
        .withIndex("by_record", (q) =>
          q.eq("ref.type", "releaseBundle").eq("ref.id", early.bundleId),
        )
        .collect();
      expect(revisions.map((r) => r.seq)).toEqual([1, 2]);
      expect(revisions[1]!.changes).toEqual([
        { field: "members", before: [], after: [releaseIds["2"], releaseIds["3"]] },
      ]);

      // A second retry with nothing new writes nothing.
      await createReleaseBundle(ctx, { ...box, observation: await observation(ctx, "box") });
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(2);
      expect(
        await ctx.db
          .query("revisions")
          .withIndex("by_record", (q) =>
            q.eq("ref.type", "releaseBundle").eq("ref.id", early.bundleId),
          )
          .collect(),
      ).toHaveLength(2);
    });
  });

  it("never edits a hidden or locked bundle's membership", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const box = fireForceBox(seriesId, ["1"]);
      const early = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      await create(ctx, {
        observation: await observation(ctx, "vol-1"),
        seriesId,
        seriesTitle: "Fire Force",
        labels: ["1"],
        release: {
          format: "physical",
          isbn13: "9780000000019",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
      });
      for (const patch of [
        { status: "hidden" as const },
        { status: "active" as const, locked: true },
      ]) {
        await ctx.db.patch(early.bundleId, patch);
        expect(
          await createOrHoldBundle(ctx, { ...box, observation: await observation(ctx, "box") }),
        ).toMatchObject({ held: expect.any(String) });
        expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(0);
      }
    });
  });

  // W09: the original importer ordered a bundle's members compactly (1, 2,
  // …) over whichever books existed, so a Vol. 1–3 box made with only
  // Vol. 2 stored it at order 1. Filling the late Volumes renumbers such
  // generated orders by label position instead of colliding with them.
  it("renumbers a legacy bundle's compact order when late members arrive", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const vol = volumeCreator(ctx, seriesId);
      const two = await vol("2", "9780000000026");
      const box = fireForceBox(seriesId, ["1", "2", "3"]);
      const early = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      // The baseline importer's compact order for its sole member.
      const [legacy] = await membershipsOf(ctx, early.bundleId);
      await ctx.db.patch(legacy!._id, { order: 1 });

      const one = await vol("1", "9780000000019");
      const three = await vol("3", "9780000000033");
      await createReleaseBundle(ctx, { ...box, observation: await observation(ctx, "box") });
      expect((await membershipsOf(ctx, early.bundleId)).map((m) => [m.releaseId, m.order])).toEqual(
        [
          [one, 1],
          [two, 2],
          [three, 3],
        ],
      );
    });
  });

  it("never seats a book that holds only part of a Volume as the box's member", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const vol = volumeCreator(ctx, seriesId);
      const one = await vol("1", "9780000000019");
      const two = await vol("2", "9780000000026");
      // Volume 2's only book is a split one: it holds part of the Volume.
      const split = (await ctx.db.get(two))!;
      const [coverage] = await ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", split.editionId))
        .collect();
      await ctx.db.patch(coverage!._id, { extent: "partial" });

      const made = await createReleaseBundle(ctx, {
        ...fireForceBox(seriesId, ["1", "2"]),
        observation: await observation(ctx, "box"),
      });
      expect((await membershipsOf(ctx, made.bundleId)).map((m) => m.releaseId)).toEqual([one]);
    });
  });

  it("keeps a deliberately reordered bundle's order, appending late members", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const vol = volumeCreator(ctx, seriesId);
      const two = await vol("2", "9780000000026");
      const three = await vol("3", "9780000000033");
      const box = fireForceBox(seriesId, ["1", "2", "3"]);
      const early = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      // An Editor put Vol. 3 before Vol. 2.
      const rows = await membershipsOf(ctx, early.bundleId);
      await ctx.db.patch(rows.find((m) => m.releaseId === three)!._id, { order: 1 });
      await ctx.db.patch(rows.find((m) => m.releaseId === two)!._id, { order: 2 });

      const one = await vol("1", "9780000000019");
      await createReleaseBundle(ctx, { ...box, observation: await observation(ctx, "box") });
      expect((await membershipsOf(ctx, early.bundleId)).map((m) => [m.releaseId, m.order])).toEqual(
        [
          [three, 1],
          [two, 2],
          [one, 3],
        ],
      );
    });
  });

  it("keeps a member an Editor added outside the box's Volumes", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Fire Force", []);
      const vol = volumeCreator(ctx, seriesId);
      const two = await vol("2", "9780000000026");
      const box = fireForceBox(seriesId, ["1", "2"]);
      const early = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      // An Editor added a bonus book (outside the box's Volumes) first.
      const bonus = await insertRelease(ctx, {
        editionId: (await ctx.db.get(two))!.editionId,
        publisherId: kodansha,
        seriesIds: [seriesId],
      });
      const [member] = await membershipsOf(ctx, early.bundleId);
      await ctx.db.patch(member!._id, { order: 2 });
      await insertBundleMember(ctx, { bundleId: early.bundleId, releaseId: bonus, order: 1 });

      const one = await vol("1", "9780000000019");
      await createReleaseBundle(ctx, { ...box, observation: await observation(ctx, "box") });
      expect((await membershipsOf(ctx, early.bundleId)).map((m) => [m.releaseId, m.order])).toEqual(
        [
          [bonus, 1],
          [two, 2],
          [one, 3],
        ],
      );
    });
  });
});

// W08: a bundle is filled only from its own canonical identity — its
// Format and the Series its members already belong to. Another source's
// observation of the same box ISBN that places it elsewhere adds nothing
// and leaves the conflict on the observation for review.
describe("createReleaseBundle — an existing bundle keeps its identity (W08)", () => {
  it.each([
    ["another Series", "series"],
    ["another Format", "format"],
  ] as const)("holds without linking when the box names %s", async (_, change) => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const alpha = await series(ctx, "Alpha", []);
      const beta = await series(ctx, "Beta", []);
      const alphaOne = await volumeCreator(ctx, alpha)("1", "9780000000019");
      await volumeCreator(ctx, alpha)("2", "9780000000026", "digital");
      await volumeCreator(ctx, beta)("2", "9780000000033");
      const box = fireForceBox(alpha, ["1", "2"]);
      const first = await createReleaseBundle(ctx, {
        ...box,
        observation: await observation(ctx, "box"),
      });
      expect(first).toMatchObject({ created: true, members: 1 });

      const other = await createOrHoldBundle(ctx, {
        ...box,
        ...(change === "series"
          ? { seriesId: beta }
          : { release: { ...box.release, format: "digital" as const } }),
        observation: await observation(ctx, "other-source-box"),
      });
      expect(other).toMatchObject({ held: expect.any(String) });
      expect((await membershipsOf(ctx, first.bundleId)).map((m) => m.releaseId)).toEqual([
        alphaOne,
      ]);
      const obs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "prh").eq("sourceRecordId", "other-source-box"),
        )
        .unique();
      expect(obs!.recordRef).toBeUndefined();
      expect(obs!.conflicts?.map((c) => c.field)).toEqual(["placement"]);
    });
  });
});

// Catalog repairs hide and merge records; the next sync must not undo them.
describe("createCanonicalRecords — repairs stand", () => {
  /** A Series with one Volume "1" and a Kodansha Edition + Release on it. */
  async function publishedSeries(ctx: MutationCtx, title: string, publisherId: Id<"publishers">) {
    const seriesId = await series(ctx, title, ["1"]);
    const volume = (await ctx.db.query("volumes").collect()).find((v) => v.seriesId === seriesId)!;
    const editionId = await insertEdition(ctx, { status: "hidden", publisherId });
    await insertCoverage(ctx, { editionId, volumeId: volume._id });
    return seriesId;
  }

  const bookArgs = (obs: Awaited<ReturnType<typeof observation>>, slug: string) => ({
    observation: obs,
    seriesId: null,
    seriesTitle: "Cells at Work! Picture Book",
    labels: ["5"],
    release: {
      format: "physical" as const,
      isbn13: "9798888778449",
      publisher: { name: slug, slug },
    },
    tagBootstrapUnreviewed: true,
  });

  it("never recreates a Series an Editor hid; the record stays on its observation", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const kodansha = await publisher(ctx, "Kodansha", "kodansha");
      const hidden = await publishedSeries(ctx, "Cells at Work! Picture Book", kodansha);
      await ctx.db.patch(hidden, { status: "hidden" });
      const obs = await observation(ctx, "9798888778449");

      const result = await create(ctx, bookArgs(obs, "kodansha"));
      expect(result).toMatchObject({ seriesId: hidden, changed: false });
      expect(result.releaseId).toBeUndefined();
      expect(result.blocked).toContain("an Editor hid");
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      const after = (await ctx.db.get(obs._id))!;
      expect(after.conflicts?.find((c) => c.field === "placement")?.reason).toContain(
        "an Editor hid",
      );
    });
  });

  it("lets another house's namesake of a hidden Series through", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const vertical = await publisher(ctx, "Vertical", "vertical");
      await publisher(ctx, "Kodansha", "kodansha");
      const hidden = await publishedSeries(ctx, "Cells at Work! Picture Book", vertical);
      await ctx.db.patch(hidden, { status: "hidden" });

      const result = await create(
        ctx,
        bookArgs(await observation(ctx, "9798888778449"), "kodansha"),
      );
      expect(result.blocked).toBeUndefined();
      expect(result.seriesId).not.toBe(hidden);
      expect(result.releaseId).toBeDefined();
    });
  });

  it("follows a merged series link to the survivor instead of creating", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const survivor = await series(ctx, "Summer Ghost", ["1", "2"]);
      const loser = await series(ctx, "Summer Ghost (old)", []);
      await ctx.db.patch(loser, { status: "merged", mergedIntoId: survivor });
      const { observation: link } = await upsertObservation(ctx, {
        sourceKey: "kodansha",
        sourceRecordId: "series:summer-ghost",
        snapshot: { kind: "series", title: "Summer Ghost" },
        now: 1,
      });
      await ctx.db.patch(link._id, {
        recordRef: { type: "series", id: loser },
      });

      // The adapter's rung-① read repoints the link.
      const linked = await reconcileLinkedSeries(ctx, {
        sourceKey: "kodansha",
        seriesKey: "summer-ghost",
        offeredTitle: "Summer Ghost",
        citation: CITATION,
        now: 1,
      });
      expect(linked.seriesId).toBe(survivor);
      expect((await ctx.db.get(link._id))!.recordRef?.id).toBe(survivor);

      // The creation path alone (an adapter that skipped rung ①) also lands
      // on the survivor.
      await ctx.db.patch(link._id, {
        recordRef: { type: "series", id: loser },
      });
      const result = await create(ctx, {
        sourceKey: "kodansha",
        observation: await observation(ctx, "9798888431900"),
        seriesId: null,
        seriesTitle: "Summer Ghost",
        seriesKey: "summer-ghost",
        labels: ["2"],
        release: {
          format: "digital",
          isbn13: "9798888431900",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
      });
      expect(result.seriesId).toBe(survivor);
      expect(await ctx.db.query("series").collect()).toHaveLength(2);
    });
  });

  it("covers a merged Volume's survivor and never re-creates removed backbone Volumes", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await publisher(ctx, "Kodansha", "kodansha");
      const seriesId = await series(ctx, "Qualia the Purple", ["1", "2"]);
      const volumes = await ctx.db.query("volumes").collect();
      const one = volumes.find((v) => v.label === "1")!;
      const two = volumes.find((v) => v.label === "2")!;
      // Stage 8: the unlabeled placeholder was merged into Volume 1; a
      // stray Volume 2 was hidden.
      await insertVolume(ctx, {
        status: "merged",
        mergedIntoId: one._id,
        seriesId,
        position: 0.5,
        label: undefined,
      });
      await ctx.db.patch(two._id, { status: "hidden" });

      const book = await create(ctx, {
        observation: await observation(ctx, "9781638585619"),
        seriesId,
        seriesTitle: "Qualia the Purple",
        labels: [],
        release: {
          format: "physical",
          isbn13: "9781638585619",
          publisher: { name: "Kodansha", slug: "kodansha" },
        },
      });
      expect(book.volumeIds).toEqual([one._id]);

      const backbone = await create(ctx, {
        sourceKey: "ann",
        observation: await observation(ctx, "manga:25348"),
        seriesId,
        seriesTitle: "Qualia the Purple",
        labels: ["2", "3"],
      });
      const after = await ctx.db
        .query("volumes")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .collect();
      expect(
        after
          .filter((v) => v.status === "active")
          .map((v) => v.label)
          .sort(),
      ).toEqual(["1", "3"]);
      expect(backbone.volumeIds).toHaveLength(1);
    });
  });
});
