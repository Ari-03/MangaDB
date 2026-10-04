// The Series page's signed-in overlay (collection.seriesEntries and
// reading.seriesTracking) against the implementations they replaced, kept
// below verbatim: the same answers in the same order on a catalog with
// every corner the overlay has to resolve (crossover Releases, merged
// Releases, Series and Bundles, hidden records, Edition Line members), and
// what each costs in documents read, database calls and round trips. Both
// read at most what the old ones read, only together instead of one after
// another; seriesEntries still scans the viewer's whole collection, so it
// fits Convex's transaction limits wherever the old scan did, which the
// long-Series fixtures from the reviews check.

import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { activeVolumes, resolveActiveSeries } from "./catalog";
import { seriesOverlay } from "./collection";
import { getActive } from "./lib/merges";
import { seriesStateRow } from "./lib/seriesStates";
import { seriesTrackingOf, volumeProgressRow } from "./reading";
import {
  insertBundle,
  insertBundleMember,
  insertCoverage,
  insertEdition,
  insertEditionLine,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
  seriesStatsRow,
} from "./test.factories";
import { makeT, withUser, type Accessor } from "./test.helpers";

const COLLECTOR = { subject: "user_2overlay", username: "overlay" };

// ---------- the replaced implementations ----------

/** collection.seriesEntries before its lookups went out together. */
async function legacySeriesEntries(ctx: QueryCtx, user: Doc<"users">, series: Doc<"series">) {
  const bundleReleases = async (bundleId: Id<"releaseBundles">) => {
    const memberships = await ctx.db
      .query("bundleMemberships")
      .withIndex("by_bundle", (q) => q.eq("bundleId", bundleId))
      .collect();
    const releases = [];
    for (const membership of memberships) {
      const release = await getActive(ctx, "releases", membership.releaseId);
      if (release) releases.push(release);
    }
    return releases;
  };
  const inSeries = async (release: Doc<"releases">) => {
    for (const rawId of release.seriesIds) {
      if (rawId === series._id) return true;
      const resolved = await getActive(ctx, "series", rawId);
      if (resolved && resolved._id === series._id) return true;
    }
    return false;
  };

  const rows = await ctx.db
    .query("collectionEntries")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const entries = [];
  const derivedOwned = new Set<Id<"releases">>();
  for (const row of rows) {
    if (row.releaseId) {
      const release = await getActive(ctx, "releases", row.releaseId);
      if (!release || !(await inSeries(release))) continue;
      entries.push({
        releaseId: release._id,
        state: row.state,
        variantId: row.variantId ?? null,
      });
    } else if (row.bundleId && row.state === "owned") {
      const bundle = await getActive(ctx, "releaseBundles", row.bundleId);
      if (!bundle) continue;
      for (const release of await bundleReleases(bundle._id)) {
        if (await inSeries(release)) derivedOwned.add(release._id);
      }
    }
  }
  return {
    seriesId: series._id,
    formatPreference: user.formatPreference,
    entries,
    derivedOwned: [...derivedOwned],
  };
}

/** reading.seriesTracking before its Volume lookups went out together. */
async function legacySeriesTracking(ctx: QueryCtx, userId: Id<"users">, seriesId: Id<"series">) {
  const state = await seriesStateRow(ctx, userId, seriesId);
  const volumes = [];
  for (const volume of await activeVolumes(ctx, seriesId)) {
    const progress = await volumeProgressRow(ctx, userId, volume._id);
    volumes.push({
      volumeId: volume._id,
      volumePublicId: volume.publicId,
      readCount: progress?.readCount ?? 0,
      lastCompletedAt: progress?.lastCompletedAt ?? null,
    });
  }
  const passes = (
    await ctx.db
      .query("releaseProgress")
      .withIndex("by_user_series", (q) => q.eq("userId", userId).eq("seriesId", seriesId))
      .collect()
  ).map((pass) => ({ releaseId: pass.releaseId, percent: pass.percent ?? null }));
  return { seriesId, readingStatus: state?.readingStatus ?? null, volumes, passes };
}

// ---------- cost ----------

type Cost = { docs: number; calls: number; rounds: number; tables: string[] };

/**
 * `ctx` with a db that tallies what a query costs: documents read, database
 * calls, and round trips, where calls issued together (Promise.all) share a
 * round and a call issued after another resolved takes the next. Rounds are
 * the longest chain of reads a cold query waits on one after another.
 * `tables` names the table of every query, a Convex value as t.run returns it.
 */
function costed(ctx: QueryCtx) {
  const cost: Cost = { docs: 0, calls: 0, rounds: 0, tables: [] };
  let waiting: Array<() => void> = [];
  const nextRound = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length > 1) return;
      setImmediate(() => {
        cost.rounds++;
        const batch = waiting;
        waiting = [];
        for (const release of batch) release();
      });
    });
  const count = (out: unknown) => {
    if (Array.isArray(out)) cost.docs += out.length;
    else if (out !== null && out !== undefined) cost.docs += 1;
    return out;
  };
  // Wraps every method, and every builder a method returns (query →
  // withIndex → …), so the call that finally reads is charged.
  const charged = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, prop) {
        const value: unknown = Reflect.get(on, prop, on);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (on === ctx.db && prop === "query") cost.tables.push(String(args[0]));
          const out: unknown = value.apply(on, args);
          if (out instanceof Promise) {
            cost.calls++;
            return nextRound().then(() => out.then(count));
          }
          return out !== null && typeof out === "object" ? charged(out) : out;
        };
      },
    });
  return { ctx: { ...ctx, db: charged(ctx.db) }, cost };
}

/** Run `read` on a costed ctx as the collector, against Series 1. */
async function measure<T>(
  as: Accessor,
  read: (ctx: QueryCtx, user: Doc<"users">, series: Doc<"series">) => Promise<T>,
) {
  return await as.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
      .unique();
    const series = await resolveActiveSeries(ctx, 1);
    if (!user || !series) throw new Error("fixture missing");
    const costing = costed(ctx);
    const result = await read(costing.ctx, user, series);
    return { result, cost: costing.cost };
  });
}

// ---------- the catalog ----------

/**
 * Series 1 with `volumes` Volumes, a print and a digital Release of each,
 * and every corner the overlay resolves:
 * - a crossover omnibus covering Volume 1 and Series 2's Volume, naming
 *   Series 2 first;
 * - a Release whose `seriesIds` still names Series 3, merged into Series 1;
 * - a book of a hidden Volume, and a member of a Series 1 Edition Line
 *   with no Coverage;
 * - a Release merged into Volume 2's print Release, and a hidden one;
 * - box sets: an Owned one holding Series 1, Series 2 and crossover
 *   Releases, a Wanted one, an Owned one merged into another, a hidden
 *   Owned one.
 * The collector's entries are made in an order unlike their Releases'.
 */
async function overlayCatalog(t: ReturnType<typeof makeT>, volumes = 3) {
  const as = await withUser(t, COLLECTOR);
  const ids = await t.run(async (ctx) => {
    const publisherId = await insertPublisher(ctx, { name: "Kodansha", slug: "kodansha" });
    const s1 = await insertSeries(ctx, { publicId: 1, title: "Blue Period" });
    const s2 = await insertSeries(ctx, { publicId: 2, title: "Blue Period Side Stories" });
    const s3 = await insertSeries(ctx, {
      publicId: 3,
      title: "Blue Period (dup)",
      status: "merged",
      mergedIntoId: s1,
    });
    const edition = async (
      covered: Array<Id<"volumes">>,
      fields: { editionLineId?: Id<"editionLines"> } = {},
    ) => {
      const editionId = await insertEdition(ctx, { publisherId, ...fields });
      for (const [order, volumeId] of covered.entries())
        await insertCoverage(ctx, { editionId, volumeId, order });
      return editionId;
    };
    const release = async (
      editionId: Id<"editions">,
      seriesIds: Array<Id<"series">>,
      fields: Partial<Doc<"releases">> = {},
    ) => await insertRelease(ctx, { editionId, publisherId, seriesIds, ...fields });

    const print: Array<Id<"releases">> = [];
    const digital: Array<Id<"releases">> = [];
    const vols: Array<Id<"volumes">> = [];
    const editions: Array<Id<"editions">> = [];
    for (let position = 1; position <= volumes; position++) {
      const volumeId = await insertVolume(ctx, { seriesId: s1, position });
      const editionId = await edition([volumeId]);
      vols.push(volumeId);
      editions.push(editionId);
      print.push(await release(editionId, [s1]));
      digital.push(await release(editionId, [s1], { format: "digital" }));
    }
    const sideVolume = await insertVolume(ctx, { seriesId: s2, position: 1 });
    const crossover = await release(await edition([vols[0]!, sideVolume]), [s2, s1]);
    const sideOnly = await release(await edition([sideVolume]), [s2]);
    const viaMergedSeries = await release(await edition([vols[1]!]), [s3]);
    const hiddenVolume = await insertVolume(ctx, { seriesId: s1, position: 99, status: "hidden" });
    const ofHiddenVolume = await release(await edition([hiddenVolume]), [s1]);
    const lineId = await insertEditionLine(ctx, { seriesId: s1, publisherId, name: "Deluxe" });
    const lineMember = await release(await edition([], { editionLineId: lineId }), [s1]);
    const merged = await release(editions[2]!, [s1], { status: "merged", mergedIntoId: print[1]! });
    const hidden = await release(editions[0]!, [s1], { status: "hidden" });

    const bundle = async (
      members: Array<Id<"releases">>,
      fields: Partial<Doc<"releaseBundles">> = {},
    ) => {
      const bundleId = await insertBundle(ctx, { publisherId, ...fields });
      for (const releaseId of members) await insertBundleMember(ctx, { bundleId, releaseId });
      return bundleId;
    };
    const ownedBox = await bundle([sideOnly, print[0]!, crossover]);
    const wantedBox = await bundle([print[1]!]);
    const survivorBox = await bundle([digital[0]!, sideOnly]);
    const loserBox = await bundle([], { status: "merged", mergedIntoId: survivorBox });
    const hiddenBox = await bundle([print[2]!], { status: "hidden" });

    return {
      s1,
      s2,
      print,
      digital,
      crossover,
      sideOnly,
      viaMergedSeries,
      ofHiddenVolume,
      lineMember,
      merged,
      hidden,
      ownedBox,
      wantedBox,
      loserBox,
      hiddenBox,
    };
  });
  return { as, ...ids };
}

/** The collector's entries on the catalog above, made out of Release order. */
async function collect(t: ReturnType<typeof makeT>, c: Awaited<ReturnType<typeof overlayCatalog>>) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
      .unique();
    if (!user) throw new Error("no collector");
    const userId = user._id;
    const entry = (
      fields: { releaseId?: Id<"releases">; bundleId?: Id<"releaseBundles"> },
      state: Doc<"collectionEntries">["state"],
    ) => ctx.db.insert("collectionEntries", { userId, state, ...fields });
    await entry({ bundleId: c.loserBox }, "owned");
    await entry({ releaseId: c.lineMember }, "wanted");
    await entry({ releaseId: c.crossover }, "owned");
    await entry({ releaseId: c.digital[1]! }, "wanted");
    await entry({ bundleId: c.ownedBox }, "owned");
    // An entry still on a merged-away Release, and one on its survivor.
    await entry({ releaseId: c.merged }, "ordered");
    await entry({ releaseId: c.print[1]! }, "owned");
    await entry({ releaseId: c.sideOnly }, "owned");
    await entry({ releaseId: c.hidden }, "owned");
    await entry({ bundleId: c.wantedBox }, "wanted");
    await entry({ bundleId: c.hiddenBox }, "owned");
    await entry({ releaseId: c.viaMergedSeries }, "owned");
    await entry({ releaseId: c.ofHiddenVolume }, "ordered");
    await entry({ releaseId: c.print[0]! }, "wanted");
  });
}

/**
 * `count` Owned entries on Releases of other Series (ten of them, one
 * Edition each), none of which the overlay of Series 1 concerns.
 */
async function unrelated(t: ReturnType<typeof makeT>, count: number) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
      .unique();
    if (!user) throw new Error("no collector");
    const publisherId = await insertPublisher(ctx, { name: "Yen Press", slug: "yen-press" });
    const shelves = [];
    for (let n = 0; n < 10; n++) {
      const seriesId = await insertSeries(ctx, { title: `Elsewhere ${n}` });
      const volumeId = await insertVolume(ctx, { seriesId });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { editionId, volumeId });
      shelves.push({ seriesId, editionId });
    }
    for (let n = 0; n < count; n++) {
      const { seriesId, editionId } = shelves[n % shelves.length]!;
      const releaseId = await insertRelease(ctx, { editionId, publisherId, seriesIds: [seriesId] });
      await ctx.db.insert("collectionEntries", { userId: user._id, releaseId, state: "owned" });
    }
  });
}

// ---------- collection.seriesEntries ----------

describe("collection.seriesEntries answers as before", () => {
  it("resolves every corner the same, in the same order", async () => {
    const t = makeT();
    const c = await overlayCatalog(t);
    await collect(t, c);
    const before = await measure(c.as, legacySeriesEntries);
    const after = await c.as.query(api.collection.seriesEntries, { seriesPublicId: 1 });
    expect(after).toEqual(before.result);
    // The corners themselves, so an agreement on nothing cannot pass.
    expect(after?.entries).toEqual([
      { releaseId: c.lineMember, state: "wanted", variantId: null },
      { releaseId: c.crossover, state: "owned", variantId: null },
      { releaseId: c.digital[1], state: "wanted", variantId: null },
      { releaseId: c.print[1], state: "ordered", variantId: null }, // the merged-away Release's entry
      { releaseId: c.print[1], state: "owned", variantId: null },
      { releaseId: c.viaMergedSeries, state: "owned", variantId: null },
      { releaseId: c.ofHiddenVolume, state: "ordered", variantId: null },
      { releaseId: c.print[0], state: "wanted", variantId: null },
    ]);
    // The merged box set's survivor, then the Owned box set's Series 1 and
    // crossover members; never the Wanted or hidden box set's.
    expect(after?.derivedOwned).toEqual([c.digital[0], c.print[0], c.crossover]);
  });

  it("is empty for an account with nothing in this Series", async () => {
    const t = makeT();
    const c = await overlayCatalog(t);
    await unrelated(t, 1000);
    expect(await c.as.query(api.collection.seriesEntries, { seriesPublicId: 1 })).toMatchObject({
      entries: [],
      derivedOwned: [],
    });
  });
});

describe("collection.seriesEntries cost", () => {
  /** Legacy and current cost of the overlay of a 20-Volume Series 1. */
  async function costs(
    setup: (
      t: ReturnType<typeof makeT>,
      c: Awaited<ReturnType<typeof overlayCatalog>>,
    ) => Promise<void>,
  ) {
    const t = makeT();
    const c = await overlayCatalog(t, 20);
    await setup(t, c);
    const before = await measure(c.as, legacySeriesEntries);
    const after = await measure(c.as, seriesOverlay);
    expect(after.result).toEqual(before.result);
    const counts = ({ docs, calls, rounds }: Cost) => ({ docs, calls, rounds });
    return { before: counts(before.cost), after: counts(after.cost) };
  }

  it("reads nothing past the index for an empty account", async () => {
    const { before, after } = await costs(async () => {});
    expect(before).toEqual({ docs: 0, calls: 1, rounds: 1 });
    expect(after).toEqual(before);
  });

  it("reads 1,000 entries on other Series in a few rounds, each Release's Series once", async () => {
    const { before, after } = await costs((t) => unrelated(t, 1000));
    // Each entry cost its row, its Release and its Series, one after another.
    expect(before).toEqual({ docs: 3000, calls: 2001, rounds: 2001 });
    // The rows, then every Release together (256 at a time), then each of
    // the ten Series they name, once.
    expect(after).toEqual({ docs: 2010, calls: 1011, rounds: 5 });
  });

  it("reads no more, in a few rounds, with entries in the Series and 1,000 elsewhere", async () => {
    const { before, after } = await costs(async (t, c) => {
      await unrelated(t, 1000);
      await collect(t, c);
    });
    expect(after.docs).toBeLessThan(before.docs);
    expect(after.calls).toBeLessThan(before.calls);
    // Merge chains (a merged Release, Series and box set) each add a round.
    expect(after.rounds).toBeLessThanOrEqual(8);
  });

  it("scans a small collection in a few rounds, reading no more", async () => {
    const { before, after } = await costs(collect);
    expect(after.docs).toBeLessThanOrEqual(before.docs);
    expect(after.calls).toBeLessThanOrEqual(before.calls);
    expect(before.rounds).toBeGreaterThanOrEqual(30);
    expect(after.rounds).toBeLessThanOrEqual(5);
  });
});

describe("collection.seriesEntries inside Convex's limits", () => {
  // The fixtures the reviews built against an earlier overlay that read
  // the Series' own Releases instead of the collection: long Series with
  // many Editions, hidden Releases and large descriptions, beside
  // collections of 101 to 2,000 entries elsewhere. Each runs under
  // Convex's transaction limits, and on each the overlay reads no more
  // documents, index ranges or bytes than the old scan, and answers alike.

  /** What `read` costs as Convex counts it: documents, index ranges and bytes read. */
  async function metered<T>(
    as: Accessor,
    read: (ctx: QueryCtx, user: Doc<"users">, series: Doc<"series">) => Promise<T>,
  ) {
    return await as.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
        .unique();
      const series = await resolveActiveSeries(ctx, 1);
      if (!user || !series) throw new Error("fixture missing");
      const start = await ctx.meta.getTransactionMetrics();
      const result = await read(ctx, user, series);
      const end = await ctx.meta.getTransactionMetrics();
      return {
        result,
        docs: end.documentsRead.used - start.documentsRead.used,
        ranges: end.databaseQueries.used - start.databaseQueries.used,
        bytes: end.bytesRead.used - start.bytesRead.used,
      };
    });
  }

  /** The overlay against the old scan on the collector's Series 1; both must fit. */
  async function asScanned(as: Accessor) {
    const before = await metered(as, legacySeriesEntries);
    const after = await metered(as, seriesOverlay);
    expect(after.result).toEqual(before.result);
    expect(after.docs).toBeLessThanOrEqual(before.docs);
    expect(after.ranges).toBeLessThanOrEqual(before.ranges);
    expect(after.bytes).toBeLessThanOrEqual(before.bytes);
    await expect(as.query(api.collection.seriesEntries, { seriesPublicId: 1 })).resolves.toEqual(
      before.result,
    );
    const counts = ({ docs, ranges, bytes }: { docs: number; ranges: number; bytes: number }) => ({
      docs,
      ranges,
      bytes,
    });
    if (process.env.OVERLAY_LOG)
      console.log(expect.getState().currentTestName, counts(before), counts(after));
    return { before: counts(before), after: counts(after) };
  }

  /**
   * A transaction-limited backend: the collector with `entries` Owned
   * entries on Releases of another Series, and an empty Series 1, seeded a
   * hundred entries per transaction so seeding stays inside the limits
   * under test.
   */
  async function limited(entries: number) {
    const t = makeT({ transactionLimits: true });
    const as = await withUser(t, COLLECTOR);
    const ids = await t.run(async (ctx) => {
      const publisherId = await insertPublisher(ctx, { name: "Viz", slug: "viz" });
      const seriesId = await insertSeries(ctx, { publicId: 1, title: "One Piece" });
      const elsewhere = await insertSeries(ctx, { publicId: 2, title: "Elsewhere" });
      const volumeId = await insertVolume(ctx, { seriesId: elsewhere });
      const editionId = await insertEdition(ctx, { publisherId });
      await insertCoverage(ctx, { volumeId, editionId });
      return { publisherId, seriesId, elsewhere, editionId };
    });
    for (let start = 0; start < entries; start += 100) {
      await t.run(async (ctx) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
          .unique();
        if (!user) throw new Error("no collector");
        for (let n = start; n < Math.min(start + 100, entries); n++) {
          const releaseId = await insertRelease(ctx, {
            editionId: ids.editionId,
            publisherId: ids.publisherId,
            seriesIds: [ids.elsewhere],
          });
          await ctx.db.insert("collectionEntries", { userId: user._id, releaseId, state: "owned" });
        }
      });
    }
    /**
     * `count` Volumes of Series 1, one per transaction, each with
     * `editions` Editions of it holding the Releases `releases(n)` lists
     * for the nth Edition. Returns the Editions.
     */
    const volumes = async (
      count: number,
      editions: number,
      releases: (n: number) => Array<Partial<Doc<"releases">>>,
    ) => {
      const editionIds: Array<Id<"editions">> = [];
      for (let position = 1; position <= count; position++) {
        await t.run(async (ctx) => {
          const volumeId = await insertVolume(ctx, { seriesId: ids.seriesId, position });
          for (let n = 0; n < editions; n++) {
            const editionId = await insertEdition(ctx, { publisherId: ids.publisherId });
            editionIds.push(editionId);
            await insertCoverage(ctx, { volumeId, editionId });
            for (const fields of releases(n)) {
              await insertRelease(ctx, {
                editionId,
                publisherId: ids.publisherId,
                seriesIds: [ids.seriesId],
                ...fields,
              });
            }
          }
        });
      }
      return editionIds;
    };
    /** Series 1's library row as a rebuild once wrote it. */
    const stats = (volumeCount: number, releaseCount: number) =>
      t.run(async (ctx) => {
        await ctx.db.insert(
          "seriesStats",
          seriesStatsRow({
            seriesId: ids.seriesId,
            publicId: 1,
            title: "One Piece",
            volumeCount,
            releaseCount,
          }),
        );
      });
    return { t, as, ...ids, volumes, stats };
  }

  const printAndDigital = () => [{ format: "physical" as const }, { format: "digital" as const }];

  it("101 entries elsewhere and a 110-Volume Series with every corner", async () => {
    const t = makeT({ transactionLimits: true });
    const c = await overlayCatalog(t, 110);
    await unrelated(t, 101);
    await asScanned(c.as);
  });

  it("101 entries elsewhere and 38 Releases per Edition", async () => {
    const t = makeT({ transactionLimits: true });
    const c = await overlayCatalog(t, 110);
    for (const releaseId of c.print) {
      await t.run(async (ctx) => {
        const release = await ctx.db.get(releaseId);
        if (!release) throw new Error("fixture missing");
        for (let n = 0; n < 36; n++) {
          await insertRelease(ctx, {
            editionId: release.editionId,
            publisherId: release.publisherId,
            seriesIds: release.seriesIds,
          });
        }
      });
    }
    await unrelated(t, 101);
    await asScanned(c.as);
  });

  it("101 entries elsewhere and 8 or 13 Editions per Volume, with and without a library row", async () => {
    for (const editions of [8, 13]) {
      const f = await limited(101);
      await f.volumes(110, editions, printAndDigital);
      await asScanned(f.as);
      await f.stats(110, 110 * editions * 2);
      await asScanned(f.as);
    }
  });

  it("300 entries elsewhere and 13 Editions per Volume under a stale library row", async () => {
    const f = await limited(300);
    await f.volumes(110, 13, printAndDigital);
    await f.stats(110, 0);
    await asScanned(f.as);
  });

  it("1,700 entries elsewhere and 2,800 Releases under a stale library row", async () => {
    const f = await limited(1700);
    await f.volumes(100, 28, () => [{}]);
    await f.stats(100, 749);
    const { before } = await asScanned(f.as);
    expect(before.ranges).toBe(3401);
  });

  it("1,700 entries elsewhere and 800 Releases with 22 KB descriptions", async () => {
    const f = await limited(1700);
    const editionId = (await f.volumes(1, 1, () => []))[0]!;
    for (let batch = 0; batch < 8; batch++) {
      await f.t.run(async (ctx) => {
        for (let n = 0; n < 100; n++) {
          await insertRelease(ctx, {
            editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            description: "x".repeat(22_000),
          });
        }
      });
    }
    await f.stats(1, 800);
    await asScanned(f.as);
  });

  it("2,000 entries elsewhere and 2,200 Editions, three in four with hidden Releases", async () => {
    const f = await limited(2000);
    await f.volumes(110, 20, (n) => [{ status: n < 5 ? "active" : "hidden" }]);
    await f.stats(110, 550);
    const { before } = await asScanned(f.as);
    expect(before.ranges).toBe(4001);
  }, 60_000);

  it("101 entries elsewhere and a Series with 33,000 hidden Releases", async () => {
    const f = await limited(101);
    const editionId = (await f.volumes(1, 1, () => [{}]))[0]!;
    await f.stats(1, 1);
    for (let start = 0; start < 33_000; start += 500) {
      await f.t.run(async (ctx) => {
        for (let n = 0; n < 500; n++) {
          await insertRelease(ctx, {
            editionId,
            publisherId: f.publisherId,
            seriesIds: [f.seriesId],
            status: "hidden",
          });
        }
      });
    }
    await asScanned(f.as);
  }, 120_000);
});

// ---------- reading.seriesTracking ----------

describe("reading.seriesTracking", () => {
  /** A 100-Volume Series 1 the collector has read every third Volume of, with one pass and a status. */
  async function longSeries() {
    const t = makeT();
    const as = await withUser(t, COLLECTOR);
    await t.run(async (ctx: MutationCtx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("usernameNormalized", COLLECTOR.username))
        .unique();
      if (!user) throw new Error("no collector");
      const publisherId = await insertPublisher(ctx, { name: "Viz", slug: "viz" });
      const seriesId = await insertSeries(ctx, { publicId: 1, title: "One Piece" });
      for (let position = 1; position <= 100; position++) {
        const volumeId = await insertVolume(ctx, { seriesId, position });
        if (position % 3 === 0) {
          await ctx.db.insert("volumeProgress", {
            userId: user._id,
            volumeId,
            readCount: position % 2 ? 1 : 2,
            lastCompletedAt: position,
          });
        }
        if (position === 50) {
          const editionId = await insertEdition(ctx, { publisherId });
          await insertCoverage(ctx, { editionId, volumeId });
          const releaseId = await insertRelease(ctx, {
            editionId,
            publisherId,
            seriesIds: [seriesId],
          });
          await ctx.db.insert("releaseProgress", {
            userId: user._id,
            releaseId,
            seriesId,
            percent: 40,
          });
        }
      }
      // A merged and a hidden Volume stay out of the overlay.
      await insertVolume(ctx, { seriesId, position: 101, status: "hidden" });
      await insertVolume(ctx, { seriesId, position: 102, status: "merged" });
      await ctx.db.insert("userSeriesStates", {
        userId: user._id,
        seriesId,
        readingStatus: "reading",
        following: false,
        followPromptDismissed: false,
      });
    });
    return as;
  }

  it("answers as before, every active Volume in order, in a few rounds", async () => {
    const as = await longSeries();
    const before = await measure(as, (ctx, user, series) =>
      legacySeriesTracking(ctx, user._id, series._id),
    );
    const after = await measure(as, (ctx, user, series) =>
      seriesTrackingOf(ctx, user._id, series._id),
    );
    expect(after.result).toEqual(before.result);
    expect(await as.query(api.reading.seriesTracking, { seriesPublicId: 1 })).toEqual(
      before.result,
    );
    expect(after.result.volumes).toHaveLength(100);
    expect(after.result.volumes.filter((volume) => volume.readCount > 0)).toHaveLength(33);
    expect(after.result).toMatchObject({ readingStatus: "reading", passes: [{ percent: 40 }] });
    // The same reads, issued together: one round for the Volume lookups.
    expect(after.cost.docs).toBe(before.cost.docs);
    expect(after.cost.calls).toBe(before.cost.calls);
    expect(before.cost.rounds).toBeGreaterThan(100);
    expect(after.cost.rounds).toBe(2);
  });
});
