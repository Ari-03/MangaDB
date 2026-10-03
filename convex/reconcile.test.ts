// Import reconciliation (ticket #35, spec §6), end to end through the Seven
// Seas pipeline against a stubbed site: the authority conflict rules on
// linked records (auto-update / queue / record-on-observation, date
// precision refinement, sticky Human Overrides), suppression of rejected
// conflicts, rungs ③/④ of the matching ladder in the live apply path, the
// Edition-Line steady-state creation gate, and suppression lift on
// withdrawal.

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { insertSourceRevision, seedCatalog } from "./test.factories";
import { alice, bob, makeT, seedRegistry, seedTeam, signedIn, type TestT } from "./test.helpers";
import { ALPHA_1 as LISTED_ALPHA_1, type FixtureBook, SEVEN_SEAS as BASE, stubSite } from "./test.imports";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Volume 1 without its listing blurb: the description tests start from a blank field. */
const ALPHA_1: FixtureBook = { ...LISTED_ALPHA_1, blurb: undefined };

/** The Moderator (bob) who reviews queued conflicts; alice is the Administrator who appointed him. */
async function setupModerator(t: TestT) {
  await seedTeam(t, [alice, bob]);
  return signedIn(t, bob);
}

const sync = (t: TestT, args: object = {}) =>
  t.action(internal.sevenSeas.sync, { politeDelayMs: 0, ...args });

const theRelease = async (t: TestT) =>
  await t.run(async (ctx) => (await ctx.db.query("releases").collect())[0]!);

const inReviewProposals = async (t: TestT) =>
  await t.run(async (ctx) =>
    (await ctx.db.query("proposals").collect()).filter((p) => p.state === "inReview"),
  );

const versionOf = async (t: TestT, proposal: Doc<"proposals">) =>
  await t.run(async (ctx) =>
    (await ctx.db.query("proposalVersions").collect()).find(
      (v) => v.proposalId === proposal._id && v.versionNo === proposal.currentVersionNo,
    ),
  );

/** Fabricate provenance: the release's field was last set by `sourceKey`, from the value it holds now. */
async function fabricateRevision(
  t: TestT,
  sourceKey: string,
  patch:
    | { pubDate: { year: number; month?: number; day?: number; sort: number } }
    | { description: string },
) {
  await t.run(async (ctx) => {
    const release = (await ctx.db.query("releases").collect())[0]!;
    const [field, after] = Object.entries(patch)[0]!;
    const before = "pubDate" in patch ? release.pubDate : release.description;
    await insertSourceRevision(ctx, {
      ref: { type: "release", id: release._id },
      sourceKey,
      changes: [{ field, before, after }],
    });
    await ctx.db.patch(release._id, patch);
  });
}

const fabricateIncumbent = (
  t: TestT,
  sourceKey: string,
  pubDate: { year: number; month?: number; day?: number; sort: number },
) => fabricateRevision(t, sourceKey, { pubDate });

describe("authority rules — sticky Human Overrides and suppression", () => {
  it("withdraws a stale conflict when the source returns to the approved value", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.patch(release._id, { overriddenFields: ["pubDate"] });
    });
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", date: "February 3, 2026" }]);
    await sync(t);
    const [conflict] = await inReviewProposals(t);
    expect(conflict).toBeDefined();

    stubSite([{ ...ALPHA_1, modified: "2026-08-11T00:00:00" }]);
    await sync(t);
    expect(await inReviewProposals(t)).toHaveLength(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(conflict!._id))?.state).toBe("withdrawn");
    });
    expect((await theRelease(t)).pubDate?.sort).toBe(20260106);
  });

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
        {
          field: "pubDate",
          after: { year: 2026, month: 2, day: 3, sort: 20260203 },
        },
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
        {
          field: "pubDate",
          after: { year: 2026, month: 3, day: 1, sort: 20260301 },
        },
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
    expect((await versionOf(t, open[0]!))?.changeComment).toContain("equal authority");
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
    await fabricateIncumbent(t, "kodansha", {
      year: 2026,
      month: 1,
      sort: 20260100,
    });

    // Seven Seas offers the consistent full date → refines, no queue.
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00" }]);
    await sync(t);
    const release = await theRelease(t);
    expect(release.pubDate).toMatchObject({ month: 1, day: 6, sort: 20260106 });
    expect(await inReviewProposals(t)).toHaveLength(0);
  });
});

describe("publisher blurbs — the Release Description", () => {
  it("fills a blank, follows the same book's new text, and queues against a human edit", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    expect((await theRelease(t)).description).toBeUndefined();

    // The book gains a blurb: filling a blank field is not a disagreement.
    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", blurb: "<p>First &amp; best.</p>" }]);
    await sync(t);
    expect((await theRelease(t)).description).toBe("First & best.");

    // Seven Seas rewrites it: the same record revising its own fact.
    stubSite([{ ...ALPHA_1, modified: "2026-08-11T00:00:00", blurb: "<p>Rewritten.</p>" }]);
    await sync(t);
    expect((await theRelease(t)).description).toBe("Rewritten.");
    expect(await inReviewProposals(t)).toHaveLength(0);

    // An Editor's text is a sticky Human Override: a new blurb queues.
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("releases").collect())[0]!;
      await ctx.db.patch(release._id, {
        description: "Editor's text.",
        overriddenFields: ["description"],
      });
    });
    stubSite([{ ...ALPHA_1, modified: "2026-08-12T00:00:00", blurb: "<p>Third take.</p>" }]);
    await sync(t);
    expect((await theRelease(t)).description).toBe("Editor's text.");
    const open = await inReviewProposals(t);
    expect(open).toHaveLength(1);
    expect((await versionOf(t, open[0]!))?.ops[0]).toMatchObject({
      kind: "update",
      changes: [{ field: "description", after: "Third take." }],
    });
  });

  it("the publisher's own text replaces a distributor's; the distributor never replaces it", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t);
    // PRH (standard for descriptions) filled the blurb first.
    await fabricateRevision(t, "prh", { description: "Distributor flap copy." });

    stubSite([{ ...ALPHA_1, modified: "2026-08-10T00:00:00", blurb: "<p>Publisher copy.</p>" }]);
    await sync(t);
    expect((await theRelease(t)).description).toBe("Publisher copy.");
    expect(await inReviewProposals(t)).toHaveLength(0);
  });
});

describe("matching ladder rungs ③/④ in the apply path", () => {
  // A human-built catalog entry with no ISBN and no source link.
  // A second call with the same slug reuses the publisher (seedCatalog).
  async function prebuildCatalog(t: TestT, publisherSlug = "seven-seas") {
    const { releaseId } = await t.run((ctx) =>
      seedCatalog(ctx, {
        publisher: { name: publisherSlug, slug: publisherSlug },
        series: { title: "Alpha Adventures" },
      }),
    );
    return releaseId;
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
    expect((await versionOf(t, open[0]!))?.changeComment).toContain("plausible candidates");
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
  it("an Edition Line book queues a pre-filled Proposal covering the real Volumes", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([ALPHA_1]);
    await sync(t); // bootstrap links the series
    await t.mutation(internal.importSources.setBootstrapModeInternal, {
      on: false,
    });

    stubSite([
      ALPHA_1,
      {
        id: 501,
        slug: "alpha-deluxe-2",
        title: "Alpha Adventures (Manga) Deluxe Edition 2 (Vol. 4-6 Hardcover Omnibus)",
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
    expect(version?.changeComment).toContain("Edition Line: Deluxe Edition");
    // Pre-filled: volumes 4-6 + the Edition Line + the Edition covering
    // them in that line + the Release; the Deluxe number is the line
    // position, never a Volume.
    const tables = version?.ops.map((op) => (op.kind === "create" ? op.table : op.kind));
    expect(tables).toEqual([
      "volumes",
      "volumes",
      "volumes",
      "editionLines",
      "editions",
      "releases",
    ]);
    const line = version?.ops.find((op) => op.kind === "create" && op.table === "editionLines");
    expect(line).toMatchObject({ tempId: "edition-line", fields: { name: "Deluxe Edition" } });
    const labels = version?.ops.flatMap((op) =>
      op.kind === "create" && op.table === "volumes"
        ? [(op.fields as { label?: string }).label]
        : [],
    );
    expect(labels).toEqual(["4", "5", "6"]);
    const edition = version?.ops.find((op) => op.kind === "create" && op.table === "editions");
    expect(edition).toMatchObject({
      fields: { editionLineId: "edition-line", linePosition: "2" },
    });
  });

  // In Bootstrap Mode a named line's member with no coverage signal becomes
  // Unmapped Packaging under its line (CONTEXT.md); outside Bootstrap Mode
  // it stays on its observation (sevenSeas.test.ts covers that case).
  it("packaging whose coverage the title never states is never a Volume", async () => {
    const t = makeT();
    await seedRegistry(t, true);
    stubSite([
      ALPHA_1,
      {
        id: 502,
        slug: "alpha-deluxe-vol-5",
        title: "Alpha Adventures (Manga) Deluxe Edition Vol. 5",
        seriesSlug: "alpha-manga",
        seriesTitle: "Alpha Adventures (Manga)",
        date: "July 7, 2026",
        isbn: "978-1-9990001-6-5",
      },
    ]);
    await sync(t);
    await t.run(async (ctx) => {
      // Only volume 1 exists: "Deluxe Edition Vol. 5" never became Volume 5.
      const volumes = await ctx.db.query("volumes").collect();
      expect(volumes.map((v) => v.label)).toEqual(["1"]);
      const obs = (await ctx.db.query("sourceObservations").collect()).find(
        (o) => o.sourceRecordId === "502",
      );
      expect(obs?.recordRef?.type).toBe("release");
      expect(obs?.conflicts ?? []).toHaveLength(0);
      const release = await ctx.db.get(obs!.recordRef!.id as Id<"releases">);
      const edition = await ctx.db.get(release!.editionId);
      expect(edition).toMatchObject({ coverageUnmapped: true, linePosition: "5" });
      expect(await ctx.db.get(edition!.editionLineId!)).toMatchObject({ name: "Deluxe Edition" });
    });
    expect(await inReviewProposals(t)).toHaveLength(0);
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

    // Volume 1 disappears while another book keeps the listing non-empty
    // (an empty listing is rejected, never treated as a complete sweep).
    stubSite([
      {
        ...ALPHA_1,
        id: 102,
        slug: "alpha-manga-vol-2",
        title: "Alpha Adventures (Manga) Vol. 2",
        isbn: "978-1-9990001-1-0",
      },
    ]);
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
