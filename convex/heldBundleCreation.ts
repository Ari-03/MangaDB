import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { money, partialDate } from "./schema";
import { bindingFacts } from "./lib/bookFacts";
import { nestedLimits } from "./lib/bounded";
import {
  bundleEnvelope,
  type Contents,
  guardedResolverContext,
  heldState,
  MAX_GUARD_BYTES,
  type Reader,
  refuse,
  releaseContents,
  reviewedMatch,
} from "./lib/heldBooks";
import { isbn13To10, toIsbn13 } from "./lib/isbn";
import { allocatePublicId } from "./lib/publicIds";
import { claimResolver, isbnClaims } from "./lib/releaseIsbns";
import { createAudit, resolveActor } from "./lib/repair/audit";
import { evidenceUrls, isbnScope, scopeState } from "./lib/scope";
import { distinctGuardFacts, valueHash } from "./lib/values";

const packet = v.object({
  observationId: v.id("sourceObservations"),
  name: v.string(),
  isbn13: v.string(),
  publisherId: v.id("publishers"),
  seriesId: v.id("series"),
  memberIds: v.array(v.id("releases")),
  memberIsbn13s: v.array(v.string()),
  volumeIds: v.array(v.id("volumes")),
  evidenceUrls: v.array(v.string()),
  /** The source's exact title when the Bundle's name is the publisher's ("Claymore - Complete Box Set"). */
  sourceTitle: v.optional(v.string()),
  pubDate: v.optional(partialDate),
  price: v.optional(money),
});
type Packet = Infer<typeof packet>;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** A complete creation read set. Unknown or partial member coverage cannot certify a new bundle. */
async function creationState(ctx: QueryCtx, args: Packet) {
  if (!args.name.trim() || args.name.length > 500 || toIsbn13(args.isbn13) !== args.isbn13)
    return refuse("Supply a bounded name and normalized valid package ISBN-13.");
  if (
    !args.memberIds.length ||
    args.memberIds.length > 40 ||
    new Set(args.memberIds).size !== args.memberIds.length
  )
    return refuse("Supply at most forty distinct ordered members.");
  if (
    args.memberIsbn13s.length !== args.memberIds.length ||
    new Set(args.memberIsbn13s).size !== args.memberIds.length
  )
    return refuse("Each member needs its distinct reviewed printing ISBN.");
  if (!args.volumeIds.length || new Set(args.volumeIds).size !== args.volumeIds.length)
    return refuse("Reviewed complete contents must be nonempty and distinct.");
  if (args.sourceTitle !== undefined && (!args.sourceTitle.trim() || args.sourceTitle.length > 500))
    return refuse("Supply a bounded exact source title.");
  const urls = evidenceUrls(args.evidenceUrls);
  if (!urls.length || urls.length > 40)
    return refuse("Supply bounded primary product/member evidence.");
  const reviewed = {
    isbn13: args.isbn13,
    seriesId: args.seriesId,
    publisherId: args.publisherId,
    volumeIds: args.volumeIds,
    evidenceUrls: urls,
    ...(args.sourceTitle !== undefined ? { sourceTitle: args.sourceTitle } : {}),
  };
  const state = await heldState(ctx, args.observationId, undefined, reviewed);
  if (!state.eligible || state.scopeReason || state.isbn13 !== args.isbn13)
    return refuse(
      state.scopeReason ?? "Product must remain held, unlinked and eligible with this exact ISBN.",
    );
  if (!state.claims.complete || state.claims.unresolved.length || state.claims.owners.size)
    return refuse("Package ISBN namespace must be complete, resolved and unowned.");
  if ((state.effective.snapshot as { format?: string }).format !== "physical")
    return refuse("Only reviewed physical packages are supported.");
  const publisher = await state.r.active(args.publisherId);
  if (publisher._id !== args.publisherId)
    return refuse("Review the current canonical publisher ID.");
  const memberContents = [];
  const resolver = claimResolver(guardedResolverContext(ctx, state.r));
  const ends: MergeEnds = new Map();
  for (const [index, memberId] of args.memberIds.entries()) {
    const content = await releaseContents(ctx, memberId, state.r);
    if (
      content.release._id !== memberId ||
      content.release.editionId !== content.edition._id ||
      content.release.format !== "physical" ||
      content.release.language !== "en" ||
      content.publisher._id !== args.publisherId
    )
      return refuse("Members must be current English physical printings of the same publisher.");
    const isbn = args.memberIsbn13s[index]!;
    if (
      toIsbn13(isbn) !== isbn ||
      toIsbn13(content.release.isbn13) !== isbn ||
      (content.release.isbn10 !== undefined && toIsbn13(content.release.isbn10) !== isbn)
    )
      return refuse("Reviewed member printing ISBN differs.");
    const scope = await scopeState(ctx, isbn);
    state.r.facts.push(scope);
    if (await isbnScope(ctx, isbn)) return refuse("Member ISBN has an active scope exclusion.");
    const claims = await isbnClaims(ctx, isbn, { resolver, room: state.r.room });
    state.r.facts.push(
      claims
        ? {
            isbn,
            complete: claims.complete,
            unresolved: claims.unresolved,
            owners: [...claims.owners.values()],
          }
        : null,
    );
    if (
      !claims?.complete ||
      claims.unresolved.length ||
      claims.owners.size !== 1 ||
      [...claims.owners.values()][0]?.doc._id !== memberId
    )
      return refuse("Member printing ownership is incomplete or differs.");
    if (await rivalPrinting(ctx, state.r, content, ends))
      return refuse(
        "Another current printing of a member's Volume could be the packed copy; the exact member is unknown.",
      );
    memberContents.push(content);
  }
  await reviewedMatch(ctx, state, memberContents, args.name);
  // The reader includes the original held-state facts plus every member read.
  // Retain held metadata and all distinct facts without embedding the same read set twice.
  const held: Record<string, unknown> = JSON.parse(state.expected);
  delete held.facts;
  const expected = valueHash({ args, held, facts: distinctGuardFacts(state.r.facts) });
  if (bytes(expected) > MAX_GUARD_BYTES) return refuse("Creation guard exceeds 256 KiB.");
  return { expected, state, memberContents, urls };
}

/** Bindings agree unless both are stated and differ ("hardcover" vs "paperback"). */
function compatibleBinding(a: string | undefined, b: string | undefined) {
  const left = bindingFacts(a);
  const right = bindingFacts(b);
  return !left.length || !right.length || left.some((one) => right.includes(one));
}

/**
 * Whether another printing could stand at a single-Volume member's position:
 * an active same-publisher English physical Release (locked or not) of an Edition
 * collecting only that whole Volume, in the member's Edition Line, whose
 * Binding is the member's or unknown (Vampire Knight 19 and its limited
 * printing). The member's own Edition counts too: a second compatible Release
 * there is just as ambiguous. Publisher and Line references are compared
 * through their merge chains, so a rival still pointing at a merged-away
 * duplicate is not missed; a chain that cannot be followed refuses. A
 * publisher's ordered range then names no exact member. Every read is a
 * guard fact; a multi-Volume member is not compared here.
 */
async function rivalPrinting(ctx: QueryCtx, r: Reader, member: Contents, ends: MergeEnds) {
  if (member.contents.length !== 1) return false;
  const volumeId = member.contents[0]!.volume._id;
  const publisherId = member.publisher._id;
  const lineId = member.line?._id;
  const samePublisher = async (id: Id<"publishers">) =>
    id === publisherId || (await mergeEnd(r, ends, id)) === publisherId;
  const coverages = await r.many(
    ctx.db.query("volumeCoverages").withIndex("by_volume", (q) => q.eq("volumeId", volumeId)),
  );
  for (const coverage of coverages) {
    if (coverage.extent !== "complete") continue;
    const edition = await r.read(coverage.editionId);
    if (
      !edition ||
      edition.status !== "active" ||
      edition.coverageUnmapped ||
      !(await samePublisher(edition.publisherId)) ||
      (edition.editionLineId === undefined
        ? lineId !== undefined
        : edition.editionLineId !== member.edition.editionLineId &&
          (await mergeEnd(r, ends, edition.editionLineId)) !== lineId)
    )
      continue;
    const rows = await r.many(
      ctx.db
        .query("volumeCoverages")
        .withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    if (rows.length !== 1) continue;
    const releases = await r.many(
      ctx.db.query("releases").withIndex("by_edition", (q) => q.eq("editionId", edition._id)),
    );
    for (const release of releases)
      if (
        release._id !== member.release._id &&
        release.status === "active" &&
        release.format === "physical" &&
        release.language === "en" &&
        compatibleBinding(release.binding, member.release.binding) &&
        (await samePublisher(release.publisherId))
      )
        return true;
  }
  return false;
}

/** Merge-chain survivors already followed while comparing rivals, keyed by starting ID. */
type MergeEnds = Map<string, Promise<string>>;

/**
 * The record a Publisher or Edition Line reference ends at after its merges,
 * whatever that record's status (a locked or hidden survivor is still the
 * same identity). A missing record, a cycle or more than eight hops refuses:
 * the guard cannot say whose printing the rival is.
 */
function mergeEnd(r: Reader, ends: MergeEnds, id: Id<"publishers"> | Id<"editionLines">) {
  let end = ends.get(id);
  if (!end) {
    end = (async () => {
      let current: Id<"publishers"> | Id<"editionLines"> = id;
      for (let hop = 0; hop <= 8; hop++) {
        const doc = await r.read(current);
        if (!doc) break;
        if (doc.status !== "merged") return doc._id;
        if (!doc.mergedIntoId) break;
        current = doc.mergedIntoId;
      }
      return refuse("A rival printing's publisher or line merge chain cannot be followed.");
    })();
    ends.set(id, end);
  }
  return end;
}

function errorReason(error: unknown) {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data &&
    "held" in error.data
  )
    return String(error.data.held);
  return error instanceof Error ? error.message : String(error);
}

export const previewInternal = internalQuery({
  args: packet.fields,
  handler: async (ctx, args) => {
    try {
      const state = await creationState(ctx, args);
      return { expected: state.expected, refusal: null };
    } catch (error) {
      return { expected: null, refusal: errorReason(error) };
    }
  },
});
const execution = packet.extend({
  expected: v.string(),
  actor: v.string(),
  reason: v.string(),
  dryRun: v.boolean(),
});
type Result =
  | { status: "created"; bundleId: Id<"releaseBundles">; proposalId: Id<"proposals"> }
  | { status: "dryRun" }
  | { status: "refused"; reason: string };

/** Atomic catalog and audit creation; dry runs roll back all writes. Source linking remains a fresh separate review. */
export const createInternal = internalMutation({
  args: execution.fields,
  handler: async (ctx, args): Promise<Result> => {
    try {
      return await ctx.runMutation(internal.heldBundleCreation.createOneInternal, args, {
        transactionLimits: await nestedLimits(ctx),
      });
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data &&
        "bundleCreationDryRun" in error.data
      )
        return { status: "dryRun" };
      return { status: "refused", reason: errorReason(error) };
    }
  },
});
export const createOneInternal = internalMutation({
  args: execution.fields,
  handler: async (ctx, args): Promise<Result> => {
    const { expected, actor, reason, dryRun, ...product } = args;
    if (bytes(expected) > MAX_GUARD_BYTES || !reason.trim() || reason.length > 4000)
      return refuse("Invalid guard or review reason.");
    const state = await creationState(ctx, product);
    if (state.expected !== expected) return refuse("Product dependencies changed; preview again.");
    const audit = createAudit(ctx, await resolveActor(ctx, actor), reason, [
      { kind: "observation", observationId: product.observationId },
      ...state.urls.map((url) => ({ kind: "url" as const, url })),
    ]);
    await state.state.r.room();
    const fields = {
      status: "active" as const,
      publicId: await allocatePublicId(ctx, "bundle"),
      name: product.name,
      format: "physical" as const,
      publisherId: product.publisherId,
      isbn13: product.isbn13,
      isbn10: isbn13To10(product.isbn13),
      ...(product.pubDate ? { pubDate: product.pubDate } : {}),
      ...(product.price ? { price: product.price } : {}),
    };
    const bundleId = await ctx.db.insert("releaseBundles", fields);
    for (const [index, releaseId] of product.memberIds.entries())
      await ctx.db.insert("bundleMemberships", { bundleId, releaseId, order: index + 1 });
    // Reuse source/package checks after insertion inside this same rollback boundary.
    const after = await heldState(
      ctx,
      product.observationId,
      { type: "bundle", id: bundleId },
      state.state.reviewed,
    );
    await bundleEnvelope(ctx, after);
    await reviewedMatch(ctx, after, after.memberContents);
    const changes = Object.entries({ ...fields, members: product.memberIds }).map(
      ([field, after]) => ({ field, after }),
    );
    const ref = { type: "releaseBundle" as const, id: bundleId };
    audit.op({ kind: "update", ref, changes });
    await audit.revise(ref, changes);
    await audit.finish();
    if (dryRun) throw new ConvexError({ bundleCreationDryRun: true });
    return { status: "created", bundleId, proposalId: (await audit.meta()).proposalId };
  },
});
