// Shared setup for the Other Printings suites (printings*.test.ts): VIZ's
// Vagabond vol 1 with its Release, more Releases of the same Volume, held
// records of other printings, the decision, and what a refusal must leave as
// it was. Stored state is read directly, never through lib/releaseIsbns.ts.

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { holdOf, recordUnplaced } from "./lib/observations";
import {
  insertCoverage,
  insertEdition,
  insertObservation,
  insertPublisher,
  insertRelease,
  insertSeries,
  insertVolume,
} from "./test.factories";
import { alice, bob, signedIn, type TestT } from "./test.helpers";

// The 2007 printing is the Release; the 2002 one another printing of it.
export const CURRENT = "9781421519111";
export const OLDER = "9781591160342";
export const OLDER_10 = "1591160340";
// More valid ISBN-13s, each with its ISBN-10.
export const X = "9781421506555";
export const X_10 = "1421506556";
export const Y = "9781569318546";
export const Z = "9781974700011";
export const W979 = "9798888772584";

export const VIZ_URL = "https://www.viz.com/vagabond";

/** VIZ, the Series "Vagabond", its Volume 1, and an Edition with the 2007 Release. */
export async function vagabond(ctx: MutationCtx) {
  const publisherId = await insertPublisher(ctx, { name: "VIZ Media", slug: "viz-media" });
  const seriesId = await insertSeries(ctx, { title: "Vagabond" });
  const volumeId = await insertVolume(ctx, { seriesId, position: 1 });
  const editionId = await insertEdition(ctx, { publisherId });
  await insertCoverage(ctx, { editionId, volumeId });
  const releaseId = await insertRelease(ctx, {
    editionId,
    publisherId,
    seriesIds: [seriesId],
    isbn13: CURRENT,
  });
  return { publisherId, seriesId, volumeId, editionId, releaseId };
}
export type Vagabond = Awaited<ReturnType<typeof vagabond>>;

/** Another Release of Vagabond vol 1, in an Edition of its own. */
export async function another(
  ctx: MutationCtx,
  book: Vagabond,
  fields: Partial<Doc<"releases">> = {},
) {
  const editionId = await insertEdition(ctx, { publisherId: book.publisherId });
  await insertCoverage(ctx, { editionId, volumeId: book.volumeId });
  return await insertRelease(ctx, {
    editionId,
    publisherId: book.publisherId,
    seriesIds: [book.seriesId],
    ...fields,
  });
}

/** A `releaseIsbns` row, as recordPrinting leaves one. */
export async function insertPrinting(
  ctx: MutationCtx,
  releaseId: Id<"releases">,
  isbn13: string,
  fields: Partial<Doc<"releaseIsbns">> = {},
) {
  return await ctx.db.insert("releaseIsbns", {
    releaseId,
    isbn13,
    reason: "Another printing: same contents, another year.",
    sourceKey: "openlibrary",
    ...fields,
  });
}

/**
 * An Open Library record of a Vagabond printing, held for an Editor under
 * `seriesId` as the import holds one whose Volume already has a Release.
 */
export async function heldRecord(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  isbn13: string,
  snapshot: Record<string, unknown> = {},
  sourceRecordId = `/books/OL${isbn13}M`,
) {
  const observationId = await insertObservation(ctx, {
    sourceKey: "openlibrary",
    sourceRecordId,
    snapshot: {
      kind: "olEdition",
      url: `https://openlibrary.org${sourceRecordId}`,
      title: "Vagabond, Vol. 1",
      publishers: ["VIZ Media"],
      format: "physical",
      isbn13,
      ...snapshot,
    },
  });
  await recordUnplaced(
    ctx,
    (await ctx.db.get(observationId))!,
    { kind: "isbn", reason: "Volume 1 already has a physical VIZ Media Release.", seriesId },
    Date.now(),
  );
  return observationId;
}

/** The reviewed decision to record (or link) `observationId` on `releaseId`. */
export const decide = (
  t: TestT,
  observationId: Id<"sourceObservations">,
  releaseId: Id<"releases">,
  reason = "Same contents as the Release; another printing year.",
) =>
  t.mutation(internal.printings.recordDecidedInternal, {
    observationId,
    releaseId,
    reason,
    evidenceUrl: VIZ_URL,
  });

/**
 * An approved Proposal setting a Release's own ISBN (alice drafts, bob
 * approves): a printing promoted to the primary, or a primary corrected.
 * Needs seedTeam(t, [alice, bob]).
 */
export async function promote(
  t: TestT,
  releaseId: Id<"releases">,
  field: "isbn13" | "isbn10",
  value: string,
) {
  const { proposalId } = await signedIn(t, alice).mutation(api.proposals.saveDraft, {
    ops: [{ kind: "update", ref: { type: "release", id: releaseId }, changes: [{ field, value }] }],
    evidence: [{ kind: "url", url: VIZ_URL }],
    comment: "Use this ISBN as the Release's own.",
  });
  await signedIn(t, alice).mutation(api.proposals.submitProposal, { proposalId });
  await signedIn(t, bob).mutation(api.proposals.approveProposal, { proposalId });
}

/** Everything a refused or rolled-back operation must leave as it was. */
export const catalogState = (t: TestT) =>
  t.run(async (ctx) => ({
    releases: await ctx.db.query("releases").collect(),
    rows: await ctx.db.query("releaseIsbns").collect(),
    observations: await ctx.db.query("sourceObservations").collect(),
    holds: await ctx.db.query("placementHolds").collect(),
    proposals: (await ctx.db.query("proposals").collect()).length,
    revisions: (await ctx.db.query("revisions").collect()).length,
    manifests: await ctx.db.query("mergeManifests").collect(),
  }));

/** A held record's hold, read directly. */
export const holdFor = (t: TestT, observationId: Id<"sourceObservations">) =>
  t.run((ctx) => holdOf(ctx, observationId));

/** Where /isbn sends an ISBN. */
export const lookup = (t: TestT, isbn: string) => t.query(api.catalogPages.isbnLookup, { isbn });

/** The ISBNs stored as printing rows of `releaseId`, sorted. */
export const rowsOf = (t: TestT, releaseId: Id<"releases">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("releaseIsbns")
        .withIndex("by_release", (q) => q.eq("releaseId", releaseId))
        .collect()
    )
      .map((row) => row.isbn13)
      .sort(),
  );

/** A valid 979-8 ISBN-13 numbered `n` (0 to 99999), for tests needing many. */
export function isbn13For(n: number): string {
  const core = `979888${String(n).padStart(6, "0")}`;
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}
