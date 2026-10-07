// Alternate Ebook ISBNs (CONTEXT.md): another ISBN under which the same
// ebook of a digital Release is listed, such as the second ebook ISBN ANN
// lists for many Yen Press volumes or a retired retailer-store (NOOK) ISBN
// Hachette Digital assigned from Yen Press's block. Like an Other Printing it
// is a `releaseIsbns` row (kind `alternateEbook`) that finds the Release and
// never changes the Release's own ISBN, date, price, blurb or cover; unlike
// one, its owner is digital. A reviewed decision records it from a held
// book, never an import, and a refusal writes nothing.
//
//   npx convex run alternateEbooks:previewInternal '{"observationId": "…",
//     "releaseId": "…", "evidence": {"kind": "annListing"}}'
//   npx convex run alternateEbooks:recordInternal '{…the same args…}'

import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { getSourceByKey } from "./importSources";
import { nestedLimits, platformStop } from "./lib/bounded";
import { fileFormatFact } from "./lib/bookFacts";
import { mergeSurvivor } from "./lib/merges";
import { linkRecordedPrinting, recordPrinting } from "./lib/printings";
import { inPublisherBlock } from "./lib/publisherIsbnBlocks";
import { claimResolver, isbnClaims, primaryIsbnsOf, printedClaimRefusal } from "./lib/releaseIsbns";
import { isbnScope } from "./lib/scope";
import { projectSourceFormat } from "./lib/sourceFormat";
import {
  contentRefusal,
  decidedCitationUrl,
  decidedIsbn13,
  httpUrl,
  releaseSeries,
  slotRefusal,
} from "./printings";

/**
 * What says the held ISBN is the Release's ebook: ANN's own line listing it
 * as digital (the held record itself), or a cited retailer or store listing
 * that labels it an ebook (B&N NOOK, Kindle, BookWalker). A retailer listing
 * may stand against a held record that calls the book physical (Open
 * Library); it is a citation, never fetched here.
 */
const evidenceValidator = v.union(
  v.object({ kind: v.literal("annListing") }),
  v.object({ kind: v.literal("retailerListing"), sourceName: v.string(), url: v.string() }),
);

const decisionArgs = v.object({
  observationId: v.id("sourceObservations"),
  releaseId: v.id("releases"),
  evidence: evidenceValidator,
});
type DecisionArgs = Infer<typeof decisionArgs>;

/** The row's provenance for an ANN listing, kept as its reason. */
export const ANN_LISTED = "ANN-listed alternate ebook ISBN";

type PartialDate = NonNullable<Doc<"releaseIsbns">["pubDate"]>;

type Plan = {
  release: Doc<"releases">;
  isbn13: string;
  reason: string;
  sourceKey: string;
  observationId: Id<"sourceObservations">;
  citation: { sourceName: string; url: string };
  pubDate?: PartialDate;
  /** The Release already has the ISBN as an alternate: the record is only linked. */
  linkOnly: boolean;
};

/** The date a record gives the book (an ANN page's first), as an ISBN row stores it. */
function observedDate(snapshot: unknown): PartialDate | undefined {
  type Parts = { year?: unknown; month?: unknown; day?: unknown };
  const s = snapshot as { page?: { date?: Parts }; date?: Parts } | null;
  const parts = [s?.page?.date, s?.date].find((d) => typeof d?.year === "number");
  if (parts === undefined) return undefined;
  const year = parts.year as number;
  const month = typeof parts.month === "number" ? parts.month : undefined;
  const day = typeof parts.day === "number" ? parts.day : undefined;
  return {
    year,
    ...(month !== undefined ? { month } : {}),
    ...(day !== undefined ? { day } : {}),
    sort: year * 10000 + (month ?? 0) * 100 + (day ?? 0),
  };
}

/**
 * Every check a decision passes, read-only, in order; the plan to write, or
 * why not:
 *
 * - the record: unlinked, not withdrawn, no Proposal in review, one valid
 *   ISBN-13 with no scope decision, its reviewed format not stale;
 *   `annListing` only for an ANN line that lists the book as digital; a
 *   `retailerListing` names its source and cites an absolute http(s) URL;
 * - the Release: active, unlocked, digital, with its own ISBN-13, and the
 *   only active digital Release of its Edition (beside a PDF and an EPUB
 *   Release, which one the ISBN names is unknown); a file format the record
 *   states must be the Release's;
 * - the publisher: the held ISBN and the Release's own both sit in the
 *   Release publisher's own ISBN blocks (lib/publisherIsbnBlocks.ts);
 * - the slot and contents (printings.ts slotRefusal, contentRefusal): held
 *   under one of the Release's Series, any publisher it names the Release's,
 *   and the Release's one whole Volume;
 * - ownership: nobody claims the ISBN, or only this Release, as its
 *   alternate ebook ISBN already (then the record is only linked).
 */
async function planAlternate(
  ctx: QueryCtx,
  { observationId, releaseId, evidence }: DecisionArgs,
): Promise<Plan | { refusal: string }> {
  const refuse = (refusal: string) => ({ refusal });
  const observation = await ctx.db.get(observationId);
  if (observation === null) return refuse("No such source record.");
  const projection = projectSourceFormat(observation);
  if (projection.status === "stale") return refuse(projection.reason);
  if (observation.withdrawn) return refuse("Its source no longer lists the book.");
  if (observation.recordRef !== undefined) return refuse("The book's record is already linked.");
  if (
    observation.queuedProposalId &&
    (await ctx.db.get(observation.queuedProposalId))?.state === "inReview"
  )
    return refuse("A Proposal of the book is in review.");
  const snapshot = projection.snapshot as {
    kind?: unknown;
    format?: unknown;
    url?: unknown;
    digitalFileFormat?: unknown;
  } | null;
  const decided = decidedIsbn13(observation.snapshot);
  if ("refusal" in decided) return refuse(decided.refusal);
  const { isbn13 } = decided;
  const scope = await isbnScope(ctx, isbn13);
  if (scope) return refuse(scope);

  let reason: string;
  let citation: Plan["citation"];
  if (evidence.kind === "annListing") {
    if (observation.sourceKey !== "ann" || snapshot?.kind !== "annRelease")
      return refuse("Only an ANN release line is an ANN listing.");
    if (snapshot.format !== "digital") return refuse("ANN does not list the book as digital.");
    const url = decidedCitationUrl(undefined, snapshot);
    if ("refusal" in url) return refuse(url.refusal);
    reason = ANN_LISTED;
    citation = { sourceName: `Anime News Network (${ANN_LISTED})`, url: url.url };
  } else {
    const sourceName = evidence.sourceName.trim();
    if (sourceName === "" || sourceName.length > 200)
      return refuse("Name the retailer or store whose listing labels the ISBN an ebook.");
    const url = httpUrl(evidence.url.trim());
    if (url === undefined)
      return refuse(`The evidence URL (${evidence.url}) is not an absolute http(s) URL.`);
    reason = `Alternate ebook ISBN listed by ${sourceName}`;
    citation = { sourceName: `${sourceName} (alternate ebook ISBN)`, url };
  }

  const release = await ctx.db.get(releaseId);
  if (release === null) return refuse("No such Release.");
  if (release.status !== "active") return refuse(`The Release is ${release.status}.`);
  if (release.locked) return refuse("The Release is locked.");
  if (release.format !== "digital") return refuse("The Release is not digital.");
  const own = release.isbn13;
  if (own === undefined) return refuse("The Release has no ISBN-13 of its own.");
  if (primaryIsbnsOf(release).has(isbn13))
    return refuse(`ISBN ${isbn13} is the Release's own: link the record with heldBooks instead.`);
  const stated = fileFormatFact(snapshot?.digitalFileFormat);
  if (stated !== null && stated !== release.digitalFileFormat)
    return refuse(
      `The record states a ${stated.toUpperCase()} file; the Release's is ${release.digitalFileFormat ?? "unknown"}.`,
    );
  const siblings = await ctx.db
    .query("releases")
    .withIndex("by_edition", (q) => q.eq("editionId", release.editionId))
    .take(50);
  if (
    siblings.some(
      (one) => one._id !== release._id && one.status === "active" && one.format === "digital",
    )
  )
    return refuse(
      "The Edition has another active digital Release: which ebook the ISBN names is unknown.",
    );

  const publisher = await mergeSurvivor(ctx, "publishers", await ctx.db.get(release.publisherId));
  if (publisher === null) return refuse("The Release's publisher cannot be followed.");
  if (!inPublisherBlock(publisher, isbn13) || !inPublisherBlock(publisher, own))
    return refuse(
      `ISBN ${isbn13} and the Release's own ISBN ${own} are not both in ${publisher.name}'s own ISBN blocks.`,
    );

  const work = await releaseSeries(ctx, release);
  if ("refusal" in work) return refuse(work.refusal);
  const slot = await slotRefusal(
    ctx,
    observation,
    release,
    work.series,
    projection.snapshot as Parameters<typeof slotRefusal>[4],
  );
  if (slot !== null) return refuse(slot);
  const content = await contentRefusal(ctx, observation, release, work.series);
  if (content !== null) return refuse(content);

  const claims = await isbnClaims(ctx, isbn13, { resolver: claimResolver(ctx) });
  if (claims === null) return refuse(`ISBN ${isbn13} is not an ISBN.`);
  const ownership = printedClaimRefusal(claims, release._id);
  if (ownership !== null) return refuse(ownership);
  const held = claims.owners.get(release._id)?.claims ?? [];
  let linkOnly = false;
  if (held.length > 0) {
    // Only this Release's own alternate row may hold it already.
    const rows = await ctx.db
      .query("releaseIsbns")
      .withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13))
      .take(2);
    const [row] = rows;
    if (
      rows.length !== 1 ||
      row?.releaseId !== release._id ||
      row.kind !== "alternateEbook" ||
      held.some((claim) => claim.on !== "release" || claim.via !== "printing")
    )
      return refuse(
        `ISBN ${isbn13} is already claimed, and not as this Release's alternate ebook.`,
      );
    linkOnly = true;
  }

  const source = await getSourceByKey(ctx, observation.sourceKey);
  const pubDate = observedDate(projection.snapshot);
  return {
    release,
    isbn13,
    reason,
    sourceKey: observation.sourceKey,
    observationId,
    citation: {
      sourceName: `${citation.sourceName}, from ${source?.name ?? observation.sourceKey}`,
      url: citation.url,
    },
    ...(pubDate !== undefined ? { pubDate } : {}),
    linkOnly,
  };
}

type Outcome =
  | { status: "ready" | "recorded" | "linked"; isbn13: string; reason: string }
  | { status: "refused"; reason: string };

/** Whether the decision would be recorded (or only linked), and with what reason; writes nothing. */
export const previewInternal = internalQuery({
  args: decisionArgs.fields,
  handler: async (ctx, input): Promise<Outcome> => {
    const plan = await planAlternate(ctx, input);
    if ("refusal" in plan) return { status: "refused", reason: plan.refusal };
    return { status: "ready", isbn13: plan.isbn13, reason: plan.reason };
  },
});

/**
 * Record the held ISBN as an alternate ebook ISBN of the digital Release
 * (lib/printings.ts recordPrinting: the row, the record's mark and link,
 * which clears its hold, and an approved Proposal with an
 * `alternateEbookIsbn` Revision), or link one more record of an alternate
 * the Release already has. Runs as a nested mutation capped at what the
 * transaction has left; a refusal, or a decision too large, writes nothing.
 */
export const recordInternal = internalMutation({
  args: decisionArgs.fields,
  handler: async (ctx, input): Promise<Outcome> => {
    const transactionLimits = await nestedLimits(ctx);
    try {
      return await ctx.runMutation(internal.alternateEbooks.applyInternal, input, {
        transactionLimits,
      });
    } catch (error) {
      return {
        status: "refused",
        reason: `The decision needs more than one transaction can read or write (${platformStop(error)}); nothing was recorded, and the book stays held.`,
      };
    }
  },
});

/** The decision itself (recordInternal), run only as its nested mutation. */
export const applyInternal = internalMutation({
  args: decisionArgs.fields,
  handler: async (ctx, input): Promise<Outcome> => {
    const plan = await planAlternate(ctx, input);
    if ("refusal" in plan) return { status: "refused", reason: plan.refusal };
    const { linkOnly, pubDate, ...decision } = plan;
    const now = Date.now();
    if (linkOnly) {
      await linkRecordedPrinting(ctx, { ...decision, now });
      return { status: "linked", isbn13: plan.isbn13, reason: plan.reason };
    }
    await recordPrinting(ctx, {
      ...decision,
      kind: "alternateEbook",
      now,
      ...(pubDate !== undefined ? { pubDate } : {}),
    });
    return { status: "recorded", isbn13: plan.isbn13, reason: plan.reason };
  },
});
