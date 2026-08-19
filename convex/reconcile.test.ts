// Import reconciliation (ticket #35, spec §6), end to end through the Seven
// Seas pipeline against a stubbed site: the authority conflict rules on
// linked records (auto-update / queue / record-on-observation, date
// precision refinement, sticky Human Overrides), suppression of rejected
// conflicts, rungs ③/④ of the matching ladder in the live apply path, the
// Edition-Line steady-state creation gate, and suppression lift on
// withdrawal.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const BASE = "https://sevenseasentertainment.com";

type FixtureBook = {
  id: number;
  slug: string;
  title: string;
  modified?: string;
  seriesSlug?: string;
  seriesTitle?: string;
  date?: string;
  price?: string;
  isbn?: string;
};

function bookPageHtml(b: FixtureBook): string {
  const series = b.seriesSlug
    ? `<b>Series: </b><span> <a href="${BASE}/series/${b.seriesSlug}/">${b.seriesTitle ?? b.title}</a></span>`
    : "";
  return `<html><body><div id="volume-module"><img src="${BASE}/wp-content/uploads/covers/${b.slug}.jpg" alt="${b.title}"></div><div id="volume-meta"> ${series}<p><b>Story & Art by:</b> <span class="creator"><a href="${BASE}/creator/someone/">Someone</a></span></p>${
    b.date ? `<p><b>Release Date:</b> ${b.date}</p>` : ""
  }${b.price ? `<p><b>Price:</b> ${b.price}</p>` : ""}<p><b>Format:</b> Manga</p>${
    b.isbn ? `<p><b>ISBN:</b> ${b.isbn}</p>` : ""
  }</div></body></html>`;
}

function stubSite(books: FixtureBook[]) {
  const listing = books.map((b) => ({
    id: b.id,
    status: "publish",
    slug: b.slug,
    link: `${BASE}/books/${b.slug}/`,
    title: { rendered: b.title },
    modified_gmt: b.modified ?? "2026-08-01T00:00:00",
    content: { rendered: "" },
  }));
  const pages = new Map(
    books.map((b) => [`${BASE}/books/${b.slug}/`, bookPageHtml(b)]),
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    if (url.startsWith(`${BASE}/wp-json/wp/v2/books`)) {
      return new Response(JSON.stringify(listing), {
        headers: { "x-wp-totalpages": "1", "content-type": "application/json" },
      });
    }
    const page = pages.get(url);
    if (page !== undefined) {
      return new Response(page, { headers: { "content-type": "text/html" } });
    }
    if (url.includes("/wp-content/uploads/")) {
      return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALPHA_1: FixtureBook = {
  id: 101,
  slug: "alpha-manga-vol-1",
  title: "Alpha Adventures (Manga) Vol. 1",
  modified: "2026-08-01T00:00:00",
  seriesSlug: "alpha-manga",
  seriesTitle: "Alpha Adventures (Manga)",
  date: "January 6, 2026",
  price: "$14.99",
  isbn: "978-1-9990001-0-3",
};

const ADMIN = "user_admin";
const MOD = "user_mod";

function makeT() {
  const t = convexTest(schema);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type TestT = ReturnType<typeof makeT>;

async function seedRegistry(t: TestT, bootstrap: boolean) {
  await t.mutation(internal.importSources.seedRegistry, {});
  await t.mutation(internal.importSources.setBootstrapModeInternal, {
    on: bootstrap,
  });
}

async function setupModerator(t: TestT) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: MOD })
    .mutation(api.users.claimUsername, { username: "bob" });
  await t.mutation(internal.roles.bootstrapAdministrator, { username: "alice" });
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.roles.appoint, { username: "bob", role: "moderator" });
  return t.withIdentity({ subject: MOD });
}

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.sevenSeas.sync, { politeDelayMs: 0, ...args });

const theRelease = async (t: TestT) =>
  await t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!);

const inReviewProposals = async (t: TestT) =>
  await t.run(async (ctx) =>
    (await ctx.db.query("proposals").collect()).filter(
      (p) => p.state === "inReview",
    ),
  );

const versionOf = async (
  t: TestT,
  proposal: Doc<"proposals">,
) =>
  await t.run(async (ctx) =>
    (await ctx.db.query("proposalVersions").collect()).find(
      (v) => v.proposalId === proposal._id && v.versionNo === proposal.currentVersionNo,
    ),
  );

/** Fabricate provenance: the release's pubDate was last set by `sourceKey`. */
async function fabricateIncumbent(
  t: TestT,
  sourceKey: string,
  pubDate: { year: number; month?: number; day?: number; sort: number },
) {
  await t.run(async (ctx) => {
    const release = (await ctx.db.query("releases").collect())[0]!;
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "source", sourceKey },
      state: "approved",
      currentVersionNo: 1,
    });
    await ctx.db.insert("revisions", {
      ref: { type: "release", id: release._id } as never,
      seq: 2,
      proposalId,
      author: { kind: "source", sourceKey },
      changes: [{ field: "pubDate", before: release.pubDate, after: pubDate }],
      comment: `Imported from ${sourceKey}.`,
    });
    await ctx.db.patch(release._id, { pubDate });
  });
}

describe("authority rules — sticky Human Overrides and suppression", () => {
  it("queues on an overridden field, never overwrites; rejection suppresses that exact offer; a new value re-queues", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);

    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.patch(release._id, { overriddenFields: ["pubDate"] });
    });

    // The source moves the date: the override holds, the conflict queues.
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" }]);
    await sync(t);
    let release = await theRelease(t);
    expect(release.pubDate?.sort).toBe(20260106);
    let open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    expect(open[0]!.author).toEqual({ kind: "source", sourceKey: "sevenseas" });
    const version = await versionOf(t, open[0]!);
    expect(version?.ops[0]).toMatchObject({
      kind: "update",
      changes: [
        { field: "pubDate", after: { year: 2026, month: 2, day: 3, sort: 20260203 } },
      ],
    });
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.queuedProposalId).toBe(open[0]!._id);
    });

    // A later run auto-updates unrelated fields (price is this source's own
    // fact) and replaces the now-stale open conflict — still exactly one.
    stubSite([
      {
        ...ALPHA_1,
        modified: "2026-08-11T00:00:00",
        date: "February 3, 2026",
        price: "$16.99",
      },
    ]);
    await sync(t);
    release = await theRelease(t);
    expect(release.price).toEqual({ amountCents: 1699, currency: "USD" });
    expect(release.pubDate?.sort).toBe(20260106);
    open = await inReviewProposals(t);
    expect(open).toHaveLength(1);

    // Rejecting the conflict suppresses this exact offer (record, field,
    // source, value)…
    const asMod = await setupModerator(t);
    await asMod.mutation(api.proposals.rejectProposal, {
      proposalId: open[0]!._id,
      note: "The publisher page is wrong; our override stands.",
    });
    await t.run(async (ctx) => {
      const suppressions = await ctx.db.query("conflictSuppressions").collect();
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]).toMatchObject({
        field: "pubDate",
        sourceKey: "sevenseas",
      });
    });

    // …so the identical conflict never re-queues, even as other fields flow.
    stubSite([
      {
        ...ALPHA_1,
        modified: "2026-08-12T00:00:00",
        date: "February 3, 2026",
        price: "$17.99",
      },
    ]);
    await sync(t);
    release = await theRelease(t);
    expect(release.price?.amountCents).toBe(1799);
    expect(await inReviewProposals(t)).toHaveLength(0);

    // A DIFFERENT offered value passes the suppression and queues again.
    stubSite([
      {
        ...ALPHA_1,
        modified: "2026-08-13T00:00:00",
        date: "March 1, 2026",
        price: "$17.99",
      },
    ]);
    await sync(t);
    open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    const requeued = await versionOf(t, open[0]!);
    expect(requeued?.ops[0]).toMatchObject({
      changes: [
        { field: "pubDate", after: { year: 2026, month: 3, day: 1, sort: 20260301 } },
      ],
    });
    expect(release.pubDate?.sort).toBe(20260106);
  });
});

describe("authority rules — the conflict table between sources", () => {
  it("equal authority queues a Proposal instead of overwriting", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    // Kodansha (equal: authoritative for dates) set the current date.
    await fabricateIncumbent(t, "kodansha", {
      year: 2026,
      month: 5,
      day: 1,
      sort: 20260501,
    });

    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "June 2, 2026" }]);
    await sync(t);
    const release = await theRelease(t);
    expect(release.pubDate?.sort).toBe(20260501); // untouched
    const open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    expect((await versionOf(t, open[0]!))?.changeComment).toContain(
      "equal authority",
    );
  });

  it("lower authority records the disagreement on the observation only", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await fabricateIncumbent(t, "kodansha", {
      year: 2026,
      month: 5,
      day: 1,
      sort: 20260501,
    });
    // Registry rules are data: demote Seven Seas' date authority to weak.
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "sevenseas"))
        .unique())!;
      await ctx.db.patch(row._id, {
        fieldAuthority: { ...row.fieldAuthority, date: "weak" },
      });
    });

    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "June 2, 2026" }]);
    await sync(t);
    const release = await theRelease(t);
    expect(release.pubDate?.sort).toBe(20260501);
    expect(await inReviewProposals(t)).toHaveLength(0);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.conflicts).toHaveLength(1);
      expect(obs.conflicts![0]).toMatchObject({
        field: "pubDate",
        offered: { year: 2026, month: 6, day: 2, sort: 20260602 },
      });
    });
  });

  it("strictly higher authority auto-updates — and a registry edit re-routes with no code change", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await fabricateIncumbent(t, "kodansha", {
      year: 2026,
      month: 5,
      day: 1,
      sort: 20260501,
    });
    // Rules change (data only): the incumbent's date authority drops.
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query("approvedSources")
        .withIndex("by_key", (q) => q.eq("key", "kodansha"))
        .unique())!;
      await ctx.db.patch(row._id, {
        fieldAuthority: { ...row.fieldAuthority, date: "standard" },
      });
    });

    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "June 2, 2026" }]);
    await sync(t);
    const release = await theRelease(t);
    expect(release.pubDate?.sort).toBe(20260602); // auto-updated
    expect(await inReviewProposals(t)).toHaveLength(0);
  });

  it("a consistent more-precise date auto-refines at equal authority", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    // Kodansha knows only "January 2026".
    await fabricateIncumbent(t, "kodansha", { year: 2026, month: 1, sort: 20260100 });

    // Seven Seas offers the consistent full date → refines, no queue.
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00" }]);
    await sync(t);
    const release = await theRelease(t);
    expect(release.pubDate).toMatchObject({ month: 1, day: 6, sort: 20260106 });
    expect(await inReviewProposals(t)).toHaveLength(0);
  });
});

describe("matching ladder rungs ③/④ in the apply path", () => {
  // A human-built catalog entry with no ISBN and no source link.
  async function prebuildCatalog(
    t: TestT,
    publisherSlug = "seven-seas",
  ) {
    return await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("publishers")
        .withIndex("by_slug", (q) => q.eq("slug", publisherSlug))
        .unique();
      const publisherId =
        existing?._id ??
        (await ctx.db.insert("publishers", {
          status: "active",
          name: publisherSlug,
          slug: publisherSlug,
        }));
      const seriesId = await ctx.db.insert("series", {
        status: "active",
        publicId: Math.floor(Math.random() * 1e9),
        title: "Alpha Adventures",
        altTitles: [],
        searchText: "Alpha Adventures",
      });
      const volumeId = await ctx.db.insert("volumes", {
        status: "active",
        publicId: Math.floor(Math.random() * 1e9),
        seriesId,
        position: 1,
        label: "1",
      });
      const editionId = await ctx.db.insert("editions", {
        status: "active",
        publicId: Math.floor(Math.random() * 1e9),
        publisherId,
      });
      await ctx.db.insert("volumeCoverages", {
        editionId,
        volumeId,
        order: 1,
        extent: "complete",
      });
      return await ctx.db.insert("releases", {
        status: "active",
        editionId,
        format: "physical",
        language: "en",
        publisherId,
        seriesIds: [seriesId],
      });
    });
  }

  it("rung ③: links the one publisher+title+label+format candidate and fills its fields", async () => {
    const t = makeT();
    await seedRegistry(t, false); // steady state
    const releaseId = await prebuildCatalog(t);
    stubSite([ALPHA_1]);
    await sync(t);

    await t.run(async (ctx) => {
      // Linked, not duplicated.
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.recordRef).toEqual({ type: "release", id: releaseId });
      // Empty fields filled through the authority rules, with a citation.
      const release = (await ctx.db.get(releaseId))!;
      expect(release.isbn13).toBe("9781999000103");
      expect(release.pubDate?.sort).toBe(20260106);
      const revisions = await ctx.db.query("revisions").collect();
      const fill = revisions.find((r) => r.ref.id === releaseId)!;
      expect(fill.author).toEqual({ kind: "source", sourceKey: "sevenseas" });
      expect(fill.citation?.url).toBe(`${BASE}/books/alpha-manga-vol-1/`);
    });
  });

  it("rung ③: two plausible candidates queue flagged — the importer never merges", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    await prebuildCatalog(t);
    await prebuildCatalog(t);
    stubSite([ALPHA_1]);
    const result = (await sync(t)) as { errorCount: number };
    expect(result.errorCount).toBe(1); // surfaced in the run log

    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(2); // no merge, no create
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.recordRef).toBeUndefined();
    });
    const open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    expect((await versionOf(t, open[0]!))?.changeComment).toContain(
      "plausible candidates",
    );
  });

  it("rung ④: a title-only candidate always reviews", async () => {
    const t = makeT();
    await seedRegistry(t, false);
    await prebuildCatalog(t, "other-pub"); // same title+label, wrong publisher
    stubSite([ALPHA_1]);
    await sync(t);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
    const open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    expect((await versionOf(t, open[0]!))?.changeComment).toContain("title-only");
  });
});

describe("steady-state creation boundaries", () => {
  it("an Edition-Line-shaped single volume queues a pre-filled Proposal", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t); // bootstrap links the series
    await t.mutation(internal.importSources.setBootstrapModeInternal, { on: false });

    stubSite([
      ALPHA_1,
      {
        id: 501,
        slug: "alpha-deluxe-vol-5",
        title: "Alpha Adventures (Manga) Deluxe Edition Vol. 5",
        seriesSlug: "alpha-manga",
        seriesTitle: "Alpha Adventures (Manga)",
        date: "July 7, 2026",
        isbn: "978-1-9990001-5-8",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("releases").collect()).toHaveLength(1);
    });
    const open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    const version = await versionOf(t, open[0]!);
    expect(version?.changeComment).toContain("Edition Line");
    // Pre-filled: approving creates volume + edition + release in one click.
    expect(version?.ops.map((op) => op.kind)).toEqual(["create", "create", "create"]);
  });
});

describe("withdrawal lifts suppressions", () => {
  it("a record disappearing from a complete sweep clears its suppressions from that source", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.insert("conflictSuppressions", {
        ref: { type: "release", id: release._id } as never,
        field: "pubDate",
        sourceKey: "sevenseas",
        valueHash: "whatever",
      });
    });
    await new Promise((r) => setTimeout(r, 5));

    stubSite([]); // the book disappears; the sweep is still complete
    await sync(t);
    await t.run(async (ctx) => {
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "101",
      )!;
      expect(obs.withdrawn).toBe(true);
      expect(await ctx.db.query("conflictSuppressions").collect()).toHaveLength(0);
    });
  });
});
