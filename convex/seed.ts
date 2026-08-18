// Hand-authored dev seed (ticket #22): a small representative catalog that
// exercises the domain model's corners from spec §2 — a Series Family with a
// typed relationship, Volumes whose Position and Label diverge, an Edition
// Line, an omnibus Edition covering three Volumes, a split Edition with
// partial Coverage, Releases, a Release Variant, and a Release Bundle that
// pins a member's Variant — plus a deliberately simple Series and a oneshot
// that touch none of those concepts. Public IDs come from the counters table
// like every real write. Publication facts are fake; only for dev.
//
// Run against a dev deployment:
//   npx convex run seed:run '{}'            # only when the catalog is empty
//   npx convex run seed:run '{"wipe":true}' # wipe catalog tables and reseed

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { allocatePublicId } from "./lib/publicIds";

// ---------- small builders ----------

const active = { status: "active" as const };

/** Full-precision partial date with its yyyymmdd sort key. */
const on = (year: number, month: number, day: number) => ({
  year,
  month,
  day,
  sort: year * 10000 + month * 100 + day,
});

const usd = (amountCents: number) => ({ amountCents, currency: "USD" });

async function addSeries(
  ctx: MutationCtx,
  args: {
    title: string;
    altTitles?: string[];
    familyId?: Id<"seriesFamilies">;
    sourceStatus?: "ongoing" | "completed" | "hiatus" | "cancelled";
  },
) {
  const publicId = await allocatePublicId(ctx, "series");
  const altTitles = args.altTitles ?? [];
  const id = await ctx.db.insert("series", {
    ...active,
    publicId,
    title: args.title,
    altTitles,
    searchText: [args.title, ...altTitles].join(" "),
    familyId: args.familyId,
    sourceStatus: args.sourceStatus,
  });
  return { id, publicId };
}

async function addVolume(
  ctx: MutationCtx,
  args: {
    seriesId: Id<"series">;
    position: number;
    label?: string;
    synopsis?: string;
  },
) {
  const publicId = await allocatePublicId(ctx, "volume");
  const id = await ctx.db.insert("volumes", {
    ...active,
    publicId,
    seriesId: args.seriesId,
    position: args.position,
    label: args.label,
    synopsis: args.synopsis,
  });
  return { id, publicId };
}

async function addEdition(
  ctx: MutationCtx,
  args: {
    publisherId: Id<"publishers">;
    editionLineId?: Id<"editionLines">;
    linePosition?: string;
    coverage: Array<{
      volumeId: Id<"volumes">;
      extent: "complete" | "partial";
      note?: string;
    }>;
  },
) {
  const publicId = await allocatePublicId(ctx, "edition");
  const id = await ctx.db.insert("editions", {
    ...active,
    publicId,
    publisherId: args.publisherId,
    editionLineId: args.editionLineId,
    linePosition: args.linePosition,
  });
  let order = 1;
  for (const cov of args.coverage) {
    await ctx.db.insert("volumeCoverages", {
      editionId: id,
      volumeId: cov.volumeId,
      order: order++,
      extent: cov.extent,
      note: cov.note,
    });
  }
  return { id, publicId };
}

async function addRelease(
  ctx: MutationCtx,
  args: {
    editionId: Id<"editions">;
    format: "physical" | "digital";
    binding?: string;
    isbn13?: string;
    pubDate?: { year: number; month?: number; day?: number; sort: number };
    price?: { amountCents: number; currency: string };
    description?: string;
    // Denorms normally maintained by the shared edition/coverage write
    // helpers (spec §8); the seed supplies them directly.
    publisherId: Id<"publishers">;
    seriesIds: Array<Id<"series">>;
  },
) {
  return await ctx.db.insert("releases", {
    ...active,
    editionId: args.editionId,
    format: args.format,
    binding: args.binding,
    language: "en",
    isbn13: args.isbn13,
    pubDate: args.pubDate,
    price: args.price,
    description: args.description,
    publisherId: args.publisherId,
    seriesIds: args.seriesIds,
  });
}

/** Catalog tables the seed owns; wiped in reverse-dependency order. */
const CATALOG_TABLES = [
  "bundleMemberships",
  "releaseBundles",
  "releaseVariants",
  "releases",
  "volumeCoverages",
  "editions",
  "editionLines",
  "volumes",
  "seriesRelationships",
  "series",
  "seriesFamilies",
  "publisherSlugRedirects",
  "publishers",
  "counters",
] as const;

// ---------- the seed ----------

export const run = internalMutation({
  args: { wipe: v.optional(v.boolean()) },
  handler: async (ctx, { wipe }) => {
    if (wipe) {
      for (const table of CATALOG_TABLES) {
        for (const doc of await ctx.db.query(table).collect()) {
          await ctx.db.delete(doc._id);
        }
      }
    } else if ((await ctx.db.query("series").take(1)).length > 0) {
      throw new Error(
        'The catalog already has data. Run with {"wipe":true} to wipe catalog tables and reseed.',
      );
    }

    // -- Publishers --
    const viz = await ctx.db.insert("publishers", {
      ...active,
      name: "VIZ Media",
      slug: "viz-media",
    });
    const sevenSeas = await ctx.db.insert("publishers", {
      ...active,
      name: "Seven Seas Entertainment",
      slug: "seven-seas",
    });

    // -- Series Family: Tokyo Ghoul + Tokyo Ghoul:re, typed sequel edge --
    const familyId = await ctx.db.insert("seriesFamilies", {
      ...active,
      name: "Tokyo Ghoul",
    });

    const tokyoGhoul = await addSeries(ctx, {
      title: "Tokyo Ghoul",
      altTitles: ["Toukyou Kushu"],
      familyId,
      sourceStatus: "completed",
    });
    const tokyoGhoulRe = await addSeries(ctx, {
      title: "Tokyo Ghoul:re",
      familyId,
      sourceStatus: "completed",
    });
    // Stored once as "from is a {type} of to" (spec §2); reverse is rendered.
    await ctx.db.insert("seriesRelationships", {
      fromSeriesId: tokyoGhoulRe.id,
      toSeriesId: tokyoGhoul.id,
      type: "sequel",
    });

    // -- Tokyo Ghoul volumes: Position is identity/sort, Label is display.
    //    Position 4 carries the side-story label "3.5". --
    const tgVol1 = await addVolume(ctx, {
      seriesId: tokyoGhoul.id,
      position: 1,
      label: "1",
      synopsis:
        "Ken Kaneki survives an encounter that leaves him half-ghoul, caught between two worlds.",
    });
    const tgVol2 = await addVolume(ctx, {
      seriesId: tokyoGhoul.id,
      position: 2,
      label: "2",
    });
    const tgVol3 = await addVolume(ctx, {
      seriesId: tokyoGhoul.id,
      position: 3,
      label: "3",
    });
    const tgVol35 = await addVolume(ctx, {
      seriesId: tokyoGhoul.id,
      position: 4,
      label: "3.5",
      synopsis:
        "Side stories set between the third and fourth arcs; published out of the main numbering.",
    });
    const tgVolumes = [tgVol1, tgVol2, tgVol3, tgVol35];

    // -- Edition Line: VIZ "Monster Edition" omnibus line --
    const monsterLine = await ctx.db.insert("editionLines", {
      ...active,
      seriesId: tokyoGhoul.id,
      publisherId: viz,
      name: "Monster Edition",
    });

    // Standard single-volume Editions, each realized by a physical paperback
    // and a digital Release.
    const tgStandardReleases: Array<Id<"releases">> = [];
    for (const [i, vol] of tgVolumes.entries()) {
      const edition = await addEdition(ctx, {
        publisherId: viz,
        coverage: [{ volumeId: vol.id, extent: "complete" }],
      });
      const physical = await addRelease(ctx, {
        editionId: edition.id,
        format: "physical",
        binding: "paperback",
        isbn13: `978199900001${i}`,
        pubDate: on(2015, 6 + i, 16),
        price: usd(1299),
        description:
          "Back-cover blurb for the standard paperback. Fake seed data.",
        publisherId: viz,
        seriesIds: [tokyoGhoul.id],
      });
      await addRelease(ctx, {
        editionId: edition.id,
        format: "digital",
        pubDate: on(2015, 6 + i, 16),
        price: usd(899),
        publisherId: viz,
        seriesIds: [tokyoGhoul.id],
      });
      tgStandardReleases.push(physical);
    }

    // Omnibus Edition: Monster Edition 1 covers canonical Volumes 1–3
    // completely; its Edition Line Position is independent of those numbers.
    const monster1 = await addEdition(ctx, {
      publisherId: viz,
      editionLineId: monsterLine,
      linePosition: "1",
      coverage: [
        { volumeId: tgVol1.id, extent: "complete" },
        { volumeId: tgVol2.id, extent: "complete" },
        { volumeId: tgVol3.id, extent: "complete" },
      ],
    });
    await addRelease(ctx, {
      editionId: monster1.id,
      format: "physical",
      binding: "hardcover",
      isbn13: "9781999000107",
      pubDate: on(2022, 10, 25),
      price: usd(4999),
      description: "Oversized omnibus hardcover collecting the opening arc.",
      publisherId: viz,
      seriesIds: [tokyoGhoul.id],
    });

    // Split digital Edition with partial Coverage of Volume 3.5.
    const split = await addEdition(ctx, {
      publisherId: viz,
      coverage: [
        {
          volumeId: tgVol35.id,
          extent: "partial",
          note: "First half of the side-story chapters.",
        },
      ],
    });
    await addRelease(ctx, {
      editionId: split.id,
      format: "digital",
      pubDate: on(2016, 3, 1),
      price: usd(399),
      publisherId: viz,
      seriesIds: [tokyoGhoul.id],
    });

    // Release Variant: box-set-exclusive cover of the Volume 1 paperback.
    const firstStandard = tgStandardReleases[0];
    if (!firstStandard) throw new Error("seed bug: no standard releases");
    const exclusiveCover = await ctx.db.insert("releaseVariants", {
      ...active,
      releaseId: firstStandard,
      name: "Box-set exclusive cover",
    });

    // Release Bundle: box set of the four standard paperbacks, pinning the
    // Volume 1 member to its exclusive Variant.
    const boxSet = await ctx.db.insert("releaseBundles", {
      ...active,
      publicId: await allocatePublicId(ctx, "bundle"),
      name: "Tokyo Ghoul Complete Box Set",
      publisherId: viz,
      format: "physical",
      isbn13: "9781999000404",
      pubDate: on(2023, 9, 19),
      price: usd(5999),
      description: "All four standard paperbacks with an exclusive cover.",
    });
    for (const [i, releaseId] of tgStandardReleases.entries()) {
      await ctx.db.insert("bundleMemberships", {
        bundleId: boxSet,
        releaseId,
        variantId: i === 0 ? exclusiveCover : undefined,
        order: i + 1,
      });
    }

    // -- Tokyo Ghoul:re: two plain volumes so the family has real siblings --
    for (const position of [1, 2]) {
      const vol = await addVolume(ctx, {
        seriesId: tokyoGhoulRe.id,
        position,
        label: String(position),
      });
      const edition = await addEdition(ctx, {
        publisherId: viz,
        coverage: [{ volumeId: vol.id, extent: "complete" }],
      });
      await addRelease(ctx, {
        editionId: edition.id,
        format: "physical",
        binding: "paperback",
        isbn13: `978199900020${position}`,
        pubDate: on(2017, 9 + position, 17),
        price: usd(1299),
        publisherId: viz,
        seriesIds: [tokyoGhoulRe.id],
      });
    }

    // -- A simple Series: no family, no line, no variants, no bundles --
    const quiet = await addSeries(ctx, {
      title: "The Quiet Cartographer",
      sourceStatus: "ongoing",
    });
    for (const position of [1, 2, 3]) {
      const vol = await addVolume(ctx, {
        seriesId: quiet.id,
        position,
        label: String(position),
      });
      const edition = await addEdition(ctx, {
        publisherId: sevenSeas,
        coverage: [{ volumeId: vol.id, extent: "complete" }],
      });
      await addRelease(ctx, {
        editionId: edition.id,
        format: "physical",
        binding: "paperback",
        isbn13: `978199900030${position}`,
        pubDate: on(2026, 2 + position, 10),
        price: usd(1499),
        publisherId: sevenSeas,
        seriesIds: [quiet.id],
      });
    }

    // -- A oneshot: one unnumbered Volume (spec §2) --
    const oneshot = await addSeries(ctx, {
      title: "One Rainy Evening",
      sourceStatus: "completed",
    });
    const oneshotVol = await addVolume(ctx, {
      seriesId: oneshot.id,
      position: 1,
    });
    const oneshotEdition = await addEdition(ctx, {
      publisherId: sevenSeas,
      coverage: [{ volumeId: oneshotVol.id, extent: "complete" }],
    });
    await addRelease(ctx, {
      editionId: oneshotEdition.id,
      format: "physical",
      binding: "paperback",
      isbn13: "9781999000503",
      pubDate: on(2025, 11, 4),
      price: usd(1599),
      publisherId: sevenSeas,
      seriesIds: [oneshot.id],
    });

    // Handy for tests and for the CLI output when run against a dev deployment.
    return {
      seriesPublicIds: {
        tokyoGhoul: tokyoGhoul.publicId,
        tokyoGhoulRe: tokyoGhoulRe.publicId,
        quietCartographer: quiet.publicId,
        oneRainyEvening: oneshot.publicId,
      },
    };
  },
});
