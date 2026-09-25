// PRH adapter tests (ticket #36): the overlay run against a stubbed
// Enhanced API — no network, no key. Covers the acceptance criterion: PRH
// values apply per the authority table on PRH-distributed records only —
// authoritative ISBN/date/price overlay onto records other sources created,
// equal-authority disagreement queueing, creation boundaries, and the
// unconfigured/graceful-skip behavior.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

type FixtureTitle = {
  isbn: string;
  title: string;
  /** PRH's own volume number for the book, as the live API carries it. */
  seriesNumber?: number;
  onsale?: string;
  format?: string;
  imprint?: string;
  priceUsd?: number;
};

const requestedUrls: string[] = [];

function stubApi(titles: FixtureTitle[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    requestedUrls.push(url);
    if (url.includes("api.penguinrandomhouse.com")) {
      const params = new URL(url).searchParams;
      const start = Number(params.get("start") ?? 0);
      const page = titles.slice(start, start + 200).map((t) => ({
        isbn: t.isbn,
        title: t.title,
        seriesNumber: t.seriesNumber,
        onsale: t.onsale,
        format: { code: "TR", description: t.format ?? "Trade Paperback" },
        imprint: { code: "IMPR", description: t.imprint ?? "Kodansha Comics" },
        priceUsd: t.priceUsd,
      }));
      return new Response(
        JSON.stringify({ recordCount: titles.length, data: { titles: page } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  requestedUrls.length = 0;
  vi.stubEnv("PRH_API_KEY", "test-key");
  vi.stubEnv("PRH_IMPRINT_CODES", "KODCM");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeT() {
  return convexTest(schema);
}
type TestT = ReturnType<typeof makeT>;

async function seedRegistry(t: TestT, bootstrap: boolean) {
  await t.mutation(internal.importSources.seedRegistry, {});
  await t.mutation(internal.importSources.setBootstrapModeInternal, {
    on: bootstrap,
  });
}

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.prh.sync, { politeDelayMs: 0, mode: "full", ...args });

describe("prh.sync — configuration", () => {
  it("skips as unconfigured without a key, logging no run", async () => {
    vi.stubEnv("PRH_API_KEY", "");
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    const result = await sync(t);
    expect(result).toEqual({ skipped: "unconfigured" });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("importRuns").collect()).toHaveLength(0);
    });
  });

  it("sweeps the imprint-scoped path, newest-first in future mode", async () => {
    // PRH ignores `imprint`/`onsaleFrom` on the flat /titles endpoint, so
    // the sync must use /imprints/{code}/titles and sort by onsale itself.
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    await sync(t, { mode: "future" });
    expect(requestedUrls.some((u) => u.includes("/imprints/KODCM/titles"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("dir=desc"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("imprint=") || u.includes("onsaleFrom="))).toBe(false);
    requestedUrls.length = 0;
    await sync(t, { mode: "full" });
    expect(requestedUrls.some((u) => u.includes("/imprints/KODCM/titles"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("sort=onsale") && u.includes("dir=asc"))).toBe(true);
  });

  it("future mode applies only future-dated titles and stops at the first past page", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    // Newest-first fixture: one future title, then a past one — the past
    // title must end the imprint without being applied.
    stubApi([
      { isbn: "9781646519811", title: "Future Manga 1", onsale: "2099-01-01" },
      { isbn: "9781646519828", title: "Past Manga 1", onsale: "2001-01-01" },
    ]);
    const result = await sync(t, { mode: "future" });
    expect(result).toMatchObject({ recordsSeen: 1 });
    await t.run(async (ctx) => {
      const observations = await ctx.db.query("sourceObservations").collect();
      expect(observations.map((o) => o.sourceRecordId)).toEqual(["9781646519811"]);
    });
  });

  it("an imprint override sweeps only those codes and never withdraws", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([]);
    const result = await sync(t, { mode: "full", imprints: ["XO"] });
    expect(requestedUrls.every((u) => u.includes("/imprints/XO/titles"))).toBe(true);
    expect(result).toMatchObject({ completeSweep: false });
  });

  it("never writes the api key into run errors", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 404 }));
    const result = await sync(t, { mode: "full" });
    expect(result).toMatchObject({ failed: true });
    await t.run(async (ctx) => {
      const [run] = await ctx.db.query("importRuns").collect();
      expect(run!.errors.join(" ")).toContain("api_key=…");
      expect(run!.errors.join(" ")).not.toContain("test-key");
    });
  });
});

describe("prh.sync — the authoritative overlay", () => {
  it("links a publisher-created release by full key, fills its ISBN/price, and queues an equal-authority date conflict", async () => {
    const t = makeT();
    await seedRegistry(t, true);

    // The skeleton record: a Kodansha-created release (authoritative date),
    // no ISBN — exactly what seeding stages ① leave behind.
    stubApi([]);
    await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("publishers", {
        status: "active",
        name: "Kodansha",
        slug: "kodansha",
      });
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Witch Hat Atelier",
        altTitles: [],
        searchText: "Witch Hat Atelier",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: 1,
        seriesId,
        position: 15,
        label: "15",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: 1,
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      const releaseId = await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        binding: "paperback",
        language: "en",
        pubDate: { year: 2026, month: 12, day: 1, sort: 20261201 },
        publisherId,
        seriesIds: [seriesId],
      });
      const proposalId = await ctx.db.insert("proposals", {
        author: { kind: "source", sourceKey: "kodansha" },
        state: "approved",
        currentVersionNo: 1,
      });
      await ctx.db.insert("revisions", {
        ref: { type: "release", id: releaseId } as never,
        seq: 1,
        proposalId,
        author: { kind: "source", sourceKey: "kodansha" },
        changes: [
          {
            field: "pubDate",
            after: { year: 2026, month: 12, day: 1, sort: 20261201 },
          },
        ],
        comment: "Imported from Kodansha.",
      });
    });

    vi.unstubAllGlobals();
    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        seriesNumber: 15,
        onsale: "2026-12-08", // disagrees with Kodansha's equally-auth date
        imprint: "Kodansha Comics", // resolves to the "Kodansha" row
        priceUsd: 12.99,
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 1, completeSweep: true });

    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      // Authoritative fills apply...
      expect(release.isbn13).toBe("9781646094356");
      expect(release.price).toEqual({ amountCents: 1299, currency: "USD" });
      // ...but the equal-authority date disagreement queues, never overwrites.
      expect(release.pubDate!.sort).toBe(20261201);
      const proposals = (await ctx.db.query("proposals").collect()).filter(
        (p) => p.state === "inReview",
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.author).toEqual({ kind: "source", sourceKey: "prh" });
      // The observation is linked (rung ③ full key) for future runs.
      const obs = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "prh").eq("sourceRecordId", "9781646094356"),
        )
        .unique();
      expect(obs!.recordRef).toEqual({ type: "release", id: release._id });
      // No duplicate structure was created.
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      expect(await ctx.db.query("editions").collect()).toHaveLength(1);
    });
  });

  it("creates records under the imprint's publisher in Bootstrap Mode and withdraws on a later full sweep", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      {
        isbn: "9781634429457",
        title: "Yotsuba&!, Vol. 16",
        onsale: "2026-10-20",
        imprint: "Denpa",
        priceUsd: 13.95,
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["denpa"]);
      const releases = await ctx.db.query("releases").collect();
      expect(releases).toHaveLength(1);
      expect(releases[0]!).toMatchObject({
        isbn13: "9781634429457",
        format: "physical",
        binding: "paperback",
      });
      const series = (await ctx.db.query("series").collect())[0]!;
      expect(series).toMatchObject({
        title: "Yotsuba&!",
        bootstrapUnreviewed: true,
      });
    });

    // The title disappears from a complete full sweep → withdrawn.
    vi.unstubAllGlobals();
    stubApi([]);
    await sync(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "9781634429457",
      )!;
      expect(obs.withdrawn).toBe(true);
    });
  });
});

describe("prh.sync — steady state", () => {
  it("queues a pre-filled proposal for a brand-new series, ensuring the company's publisher row", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    stubApi([
      {
        isbn: "9781646094356",
        title: "Witch Hat Atelier 15",
        seriesNumber: 15,
        onsale: "2026-12-08",
        imprint: "Kodansha Comics",
      },
    ]);
    await sync(t);
    await sync(t); // dedup: an open queue item never re-queues
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(0);
      const proposals = await ctx.db.query("proposals").collect();
      expect(proposals).toHaveLength(1);
      const versions = await ctx.db.query("proposalVersions").collect();
      const editionOp = versions[0]!.ops.find(
        (op) => op.kind === "create" && op.table === "editions",
      );
      expect(
        (editionOp as { fields: { publisherSlug: string } }).fields
          .publisherSlug,
      ).toBe("kodansha");
      // "Kodansha Comics" is Kodansha under another string: one company row,
      // which exists, so approving the guess is one click.
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug)).toEqual(["kodansha"]);
    });
  });
});

// Real PRH titles that used to become one Series per book (series-titles
// and volume-numbering audits); the ANN backbone Series has no Releases yet.
describe("prh.sync — packaging and title shapes (Bootstrap Mode)", () => {
  async function backbone(t: TestT, title: string, labels: string[]) {
    return await t.run(async (ctx) => {
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title,
        altTitles: [],
        searchText: title,
      });
      for (const label of labels) {
        await ctx.db.insert("volumes", {
          status: "active",
          publicId: Number(label),
          seriesId,
          position: Number(label),
          label,
        });
      }
      return seriesId;
    });
  }

  it("files an omnibus under the base Series as an Edition Line member covering its Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const seriesId = await backbone(t, "Noragami: Stray God", ["19", "20"]);
    await t.run((ctx) =>
      ctx.db.patch(seriesId, { altTitles: ["Noragami"], searchText: "Noragami: Stray God Noragami" }),
    );
    stubApi([
      { isbn: "9781646519026", title: "Noragami Omnibus 7 (Vol. 19-21)", seriesNumber: 7 },
      {
        isbn: "9781646519033",
        title: "Noragami Omnibus 7 (Vol. 19-21)",
        seriesNumber: 7,
        format: "Ebook",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(1);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label).sort()).toEqual(["19", "20", "21"]);
      const [line] = await ctx.db.query("editionLines").collect();
      expect(line).toMatchObject({ seriesId, name: "Omnibus" });
      const editions = await ctx.db.query("editions").collect();
      expect(editions).toHaveLength(1);
      expect(editions[0]).toMatchObject({ editionLineId: line!._id, linePosition: "7" });
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.format).sort()).toEqual(["digital", "physical"]);
    });
  });

  it("never turns an omnibus number into a Volume when coverage is unknown", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Negima!", ["4"]);
    stubApi([{ isbn: "9781612620015", title: "Negima! Omnibus 4", seriesNumber: 4 }]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(0);
      expect(await ctx.db.query("editions").collect()).toHaveLength(0);
      const obs = (await ctx.db.query("sourceObservations").collect())[0]!;
      expect(obs.recordRef).toBeUndefined();
      expect(obs.conflicts?.[0]).toMatchObject({ field: "placement" });
    });
  });

  it("gives a multi-volume title range coverage, never an unlabeled placeholder", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      {
        isbn: "9781645058472",
        title: "Tokyo Revengers (Omnibus) Vol. 11-12",
        imprint: "Seven Seas",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const series = await ctx.db.query("series").collect();
      expect(series.map((s) => s.title)).toEqual(["Tokyo Revengers"]);
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => [v.label, v.position])).toEqual([
        ["11", 11],
        ["12", 12],
      ]);
    });
  });

  it("splits Vol.N and (Manga) titles onto the existing backbone Series", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const alpi = await backbone(t, "Alpi the Soul Sender", ["5"]);
    const picnic = await backbone(t, "Otherside Picnic", ["5"]);
    stubApi([
      {
        isbn: "9781787741348",
        title: "Alpi the Soul Sender Vol.5",
        seriesNumber: 5,
        imprint: "Titan Manga",
      },
      {
        isbn: "9781646091300",
        title: "Otherside Picnic 05 (Manga)",
        seriesNumber: 5,
        imprint: "Square Enix Manga",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("series").collect()).toHaveLength(2);
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.seriesIds[0]).sort()).toEqual([alpi, picnic].sort());
      // "Square Enix Manga" is Square Enix under another string.
      const publishers = await ctx.db.query("publishers").collect();
      expect(publishers.map((p) => p.slug).sort()).toEqual(["square-enix", "titan-manga"]);
    });
  });

  it("keeps a trailing number that belongs to an existing Series' name", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    const omega = await backbone(t, "Omega 6", []);
    stubApi([
      {
        isbn: "9781506731780",
        title: "Omega 6",
        seriesNumber: 6,
        imprint: "Dark Horse Manga",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("series").collect()).map((s) => s._id)).toEqual([omega]);
    });
  });

  it("makes a box set a Release Bundle of the base Series' Releases", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await backbone(t, "Fire Force", []);
    stubApi([
      { isbn: "9781632364425", title: "Fire Force 1", seriesNumber: 1 },
      { isbn: "9798888772584", title: "Fire Force Manga Box Set 1 (Vol. 1-6)", seriesNumber: 1 },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const bundles = await ctx.db.query("releaseBundles").collect();
      expect(bundles).toMatchObject([
        { isbn13: "9798888772584", name: "Fire Force Manga Box Set 1 (Vol. 1-6)" },
      ]);
      expect(await ctx.db.query("bundleMemberships").collect()).toHaveLength(1);
      // The box is not a Release, and it made no Volume.
      const releases = await ctx.db.query("releases").collect();
      expect(releases.map((r) => r.isbn13)).toEqual(["9781632364425"]);
      expect((await ctx.db.query("volumes").collect()).map((v) => v.label)).toEqual(["1"]);
    });
  });

  it("creates an imprint's own row under its parent company", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    await t.run((ctx) =>
      ctx.db.insert("publishers", {
        status: "active",
        name: "Seven Seas Entertainment",
        slug: "seven-seas",
      }),
    );
    stubApi([
      {
        isbn: "9798891600836",
        title: "ENNEAD Vol. 4 [Mature Hardcover]",
        seriesNumber: 4,
        imprint: "Ghost Ship",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      const ghostShip = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "ghost-ship"))
        .unique();
      const sevenSeas = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", "seven-seas"))
        .unique();
      expect(ghostShip?.parentPublisherId).toBe(sevenSeas!._id);
      expect((await ctx.db.query("series").collect()).map((s) => s.title)).toEqual(["ENNEAD"]);
    });
  });

  it("never stores out-of-scope titles", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubApi([
      { isbn: "9781945054853", title: "The Seven Deadly Sins (Novel)", imprint: "Kodansha Comics" },
      { isbn: "9781935654100", title: "Number Place: Blue", imprint: "Vertical" },
      {
        isbn: "9781427880024",
        title: "Her Royal Highness Seems to Be Angry, Volume 1 (Light Novel)",
        imprint: "TOKYOPOP",
      },
    ]);
    const result = await sync(t);
    expect(result).toMatchObject({ recordsSeen: 0 });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("sourceObservations").collect()).toHaveLength(0);
    });
  });
});
