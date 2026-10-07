import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { nameKey } from "../people";
import { declaredWorkNames } from "./declaredWork";
import { MAX_GUARD_BYTES, type Reader, reader, refuse } from "./heldBooks";
import { toIsbn13 } from "./isbn";
import { sameWorkTitle } from "./matching";
import { sha256Hex } from "./olDump";
import { linkSeriesObservation } from "./pipeline";
import { storedClaims } from "./releaseIsbns";
import { createAudit, resolveActor } from "./repair/audit";
import { scopeState } from "./scope";
import { utf8Bytes } from "./sourceFormat";
import { nonJsonPath, sameValue, valueHash } from "./values";

/*
 * G5: record a missing Kodansha source Series parent (`series:<slug>`) for a
 * reviewed canonical Series, so the held volumes under that slug resolve
 * their parent (lib/heldBooks.ts sourceSeries). The only write is the parent
 * observation, through lib/pipeline.ts linkSeriesObservation, with its
 * Proposal, a Series Revision and a heldRepairLedger receipt. Held volume
 * observations, their raw snapshots and every catalog record stay as they
 * are; this route never links, places or reshapes a book.
 *
 * The parent is proved by the slug's own Kodansha series page (its heading,
 * credit line, category and volume links), never by an ISBN owner or a
 * title alias. ISBN owners and the slug's whole volume closure only have to
 * agree with it. Binding disagreements between a volume and its ISBN owner
 * are reported for G4 and never decided here.
 *
 * Callers: heldSourceParents.previewInternal / executeInternal and
 * previewRestoreInternal / restoreInternal.
 */

export const SOURCE_PARENT_OPERATION = "linkSourceSeriesParent";
export const SOURCE_PARENT_RESTORE = "restoreSourceSeriesParent";
const SOURCE_KEY = "kodansha";
/** The slugs G5 of shared-unmapped-design-001 reviewed; no other slug takes this route. */
export const REVIEWED_SOURCE_PARENT_SLUGS: readonly string[] = [
  "cardcaptor-sakura-collectors-edition",
  "chobits-20th-anniversary-edition",
  "akira-35th-anniversary-box-set",
  "gachiakuta-manga-box",
];
const MAX_EXCERPT_BYTES = 4096;
const MAX_LINKS = 64;
const MAX_AUTHORS = 8;
const MAX_MEMBERS = 80;
const MERGE_HOPS = 8;
/** The category Kodansha's series pages print above the heading of a manga series. */
const MANGA_CATEGORY = "Manga";

/**
 * One captured kodansha.us series page. The server never fetches it, so
 * `sha256`, `capturedAt`, `excerpt` and `volumeLinks` are the reviewer's
 * attestation: the excerpt is one contiguous run of the page's visible text,
 * one line per text node, from the category label through the credit line
 * ("Manga / <heading> / <heading> / By CLAMP"), from a body hashing to
 * `sha256`; `volumeLinks` are the page's own volume hrefs. The server checks
 * that the excerpt has that exact shape and that its statements agree with
 * the stored records.
 */
const seriesPageCapture = v.object({
  url: v.string(),
  sha256: v.string(),
  capturedAt: v.number(),
  excerpt: v.string(),
  statesCategory: v.string(),
  statesHeading: v.string(),
  statesAuthors: v.array(v.string()),
  volumeLinks: v.array(v.string()),
});

/** The reviewer's parent identity. Every field is rechecked against stored records. */
export const sourceParentProof = v.object({
  seriesSlug: v.string(),
  seriesId: v.id("series"),
  /** The volumes' shared raw `seriesTitle`, verbatim. */
  sourceTitle: v.string(),
  /** The volumes' shared packaging Line name, verbatim; null when none states one. */
  lineName: v.union(v.string(), v.null()),
  /** Every Kodansha observation under the slug, in any state. */
  observationIds: v.array(v.id("sourceObservations")),
  capture: seriesPageCapture,
  reason: v.string(),
});
export type SourceParentProof = Infer<typeof sourceParentProof>;

export const sourceParentArgs = { proof: sourceParentProof };
export const sourceParentExecuteArgs = {
  ...sourceParentArgs,
  actor: v.string(),
  expected: v.string(),
};
export const sourceParentRestoreArgs = { ledgerId: v.id("heldRepairLedger") };
export const sourceParentRestoreExecuteArgs = {
  ...sourceParentRestoreArgs,
  actor: v.string(),
  reason: v.string(),
  expected: v.string(),
};
const executeArgs = v.object(sourceParentExecuteArgs);
const restoreExecuteArgs = v.object(sourceParentRestoreExecuteArgs);

export type SourceParentResult = {
  status: "linked" | "alreadyApplied" | "refused";
  reason?: string;
  parentId?: Id<"sourceObservations">;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
};
export type SourceParentRestoreResult = {
  status: "restored" | "alreadyRestored" | "refused";
  reason?: string;
  proposalId?: Id<"proposals">;
  ledgerId?: Id<"heldRepairLedger">;
};

/** A Kodansha volume snapshot, as kodansha.ts stores it. */
type KodanshaVolume = {
  kind?: string;
  title?: string;
  seriesSlug?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  url?: string;
  format?: string;
  binding?: string;
  isbn13?: string;
  creators?: string[];
  packaging?: { lineName?: string | null } | null;
};

export const seriesUrlOf = (slug: string) => `https://kodansha.us/series/${slug}/`;
const memberKey = (url: string, slug: string) =>
  url.startsWith(seriesUrlOf(slug))
    ? /^volume-(\d+)\/$/.exec(url.slice(seriesUrlOf(slug).length))
    : null;

/**
 * The series page's own address, exactly: https, the kodansha.us host
 * itself (no lookalike, subdomain, userinfo or port), no query or fragment.
 */
export function checkSeriesUrl(raw: string, slug: string) {
  const canonical = seriesUrlOf(slug);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("Series page URL is not a URL.");
  }
  if (
    raw !== canonical ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== "kodansha.us" ||
    url.search ||
    url.hash ||
    url.pathname !== `/series/${slug}/`
  )
    return refuse("Series page URL is not the slug's own kodansha.us page.");
  return canonical;
}

/** ISBN-shaped whole tokens: 10 or 13 characters once hyphens go. */
const hasIsbnToken = (text: string) =>
  [...text.matchAll(/(?<![0-9Xx-])(?:[0-9][- ]?){9,12}[0-9Xx](?![0-9Xx])/g)].some((match) => {
    const digits = match[0].replace(/[- ]/g, "");
    return digits.length === 10 || digits.length === 13;
  });

/** The page's credit line, split into the names it lists. */
const creditNames = (line: string) =>
  line
    .slice(3)
    .split(/\s*(?:,|&|\band\b)\s*/)
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * The captured page, read for what it states: the manga category, a heading
 * that is the volumes' own series title followed by their Line name, the
 * credited authors, and its volume links. The excerpt must be exactly the
 * page's category, heading and credit run, so a heading from another
 * product or a spliced ISBN cannot stand in.
 */
export function checkCapture(
  proof: Pick<SourceParentProof, "seriesSlug" | "sourceTitle" | "lineName" | "capture" | "reason">,
  now: number,
) {
  const c = proof.capture;
  if (!proof.reason.trim() || proof.reason.length > 4000)
    return refuse("Give a short reviewed source-parent reason.");
  const url = checkSeriesUrl(c.url, proof.seriesSlug);
  if (
    !/^[a-f0-9]{64}$/.test(c.sha256) ||
    !Number.isFinite(c.capturedAt) ||
    c.capturedAt <= 0 ||
    c.capturedAt > now
  )
    return refuse("Capture needs a SHA-256 and a capture time that is not in the future.");
  if (!c.excerpt.trim() || utf8Bytes(c.excerpt) > MAX_EXCERPT_BYTES)
    return refuse(`Capture excerpt must be 1-${MAX_EXCERPT_BYTES} bytes of page text.`);
  if (hasIsbnToken(c.excerpt))
    return refuse("A series page excerpt states no ISBN; product identity is not routed by ISBN.");
  const lines = c.excerpt.split("\n").map((line) => line.trim());
  const heading = c.statesHeading.trim();
  let at = 1;
  while (lines[at] === heading) at++;
  const byLine = lines[at] ?? "";
  if (
    c.statesCategory !== MANGA_CATEGORY ||
    lines[0] !== MANGA_CATEGORY ||
    !heading ||
    at === 1 ||
    !byLine.startsWith("By ")
  )
    return refuse(
      "Excerpt must run from the Manga category through the heading to its credit line.",
    );
  const authors = creditNames(byLine);
  if (
    !authors.length ||
    authors.length > MAX_AUTHORS ||
    !sameValue(
      authors,
      c.statesAuthors.map((name) => name.trim()),
    )
  )
    return refuse("Stated authors are not the page's credit line.");
  const expectedHeading = proof.lineName
    ? `${proof.sourceTitle} ${proof.lineName}`
    : proof.sourceTitle;
  if (!sameWorkTitle(heading, expectedHeading))
    return refuse("Page heading is not the volumes' series title and Line.");
  if (!c.volumeLinks.length || c.volumeLinks.length > MAX_LINKS)
    return refuse(`Supply the page's 1-${MAX_LINKS} volume links.`);
  const links = new Set<string>();
  for (const link of c.volumeLinks) {
    if (!memberKey(link, proof.seriesSlug))
      return refuse("A volume link is not one of the slug's own volume pages.");
    links.add(link);
  }
  return { url, heading, authors, links };
}

/** Where a Series' merge chain ends; a broken chain refuses. */
async function seriesSurvivor(r: Reader, id: Id<"series">) {
  let current = id;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MERGE_HOPS; hop++) {
    if (seen.has(current)) return refuse("A Series merge cycle.");
    seen.add(current);
    const doc = await r.read(current);
    if (!doc) return refuse("A Series an owner names is missing.");
    if (doc.status !== "merged") {
      if (doc.status !== "active") return refuse("An owner Series is not active.");
      return doc._id;
    }
    if (!doc.mergedIntoId) return refuse("A Series merge points nowhere.");
    current = doc.mergedIntoId;
  }
  return refuse("A Series merge chain exceeds eight hops.");
}

/** Every Series a Release names, aliases resolved, must be the reviewed one. */
async function sameSeriesOnly(r: Reader, release: Doc<"releases">, seriesId: Id<"series">) {
  if (!release.seriesIds.length) return false;
  for (const id of release.seriesIds) if ((await seriesSurvivor(r, id)) !== seriesId) return false;
  return true;
}

/**
 * The exact-ISBN namespace of one volume: every claim, merged aliases
 * included, must be a Release whose Series all resolve to the reviewed one.
 * A Bundle, an unresolved chain or an incomplete scan refuses.
 */
async function ownersAgree(ctx: QueryCtx, r: Reader, isbn13: string, seriesId: Id<"series">) {
  const scope = await scopeState(ctx, isbn13);
  r.facts.push(scope);
  if (scope.active) return refuse(`ISBN ${isbn13} has a scope decision.`);
  const claims = await storedClaims(ctx, isbn13, r.room);
  r.facts.push(claims);
  if (!claims?.complete) return refuse(`ISBN ${isbn13} claims are incomplete.`);
  const owners = new Map<Id<"releases">, Doc<"releases">>();
  for (const { claim } of claims.raw) {
    if (claim.on !== "release") return refuse(`ISBN ${isbn13} is a Bundle's; review the package.`);
    const owner = await releaseSurvivor(r, claim.storedId, seriesId);
    owners.set(owner._id, owner);
  }
  return [...owners.values()];
}

/** Every Release merge hop, including a printing's stored owner, is checked and pinned. */
async function releaseSurvivor(r: Reader, id: Id<"releases">, seriesId: Id<"series">) {
  const seen = new Set<string>();
  let current = id;
  for (let hop = 0; hop <= MERGE_HOPS; hop++) {
    if (seen.has(current)) return refuse("A Release merge cycle.");
    seen.add(current);
    const doc = await r.read(current);
    if (!doc) return refuse("An ISBN owner Release is missing.");
    if (!(await sameSeriesOnly(r, doc, seriesId)))
      return refuse("An ISBN owner Release is under another Series or has unknown Series.");
    if (doc.status !== "merged") return doc;
    if (!doc.mergedIntoId) return refuse("A Release merge points nowhere.");
    current = doc.mergedIntoId;
  }
  return refuse("A Release merge chain exceeds eight hops.");
}

/** What a parent's identity is, without its last-seen time. */
const parentFacts = (parent: Doc<"sourceObservations">) => ({
  _id: parent._id,
  sourceKey: parent.sourceKey,
  sourceRecordId: parent.sourceRecordId,
  snapshot: parent.snapshot,
  recordRef: parent.recordRef,
  withdrawn: parent.withdrawn,
  conflicts: parent.conflicts,
  queuedProposalId: parent.queuedProposalId,
  printingIsbn13: parent.printingIsbn13,
  reviewedSourceFormat: parent.reviewedSourceFormat,
});

/** What the ledger keeps from the apply: the guard hash and each member's link then. */
type Applied = {
  operation: typeof SOURCE_PARENT_OPERATION;
  seriesKey: string;
  seriesId: Id<"series">;
  expected: string;
  auditHash: string;
  members: { id: Id<"sourceObservations">; recordRef: Doc<"sourceObservations">["recordRef"] }[];
};
const appliedOf = (ledger: Doc<"heldRepairLedger">) => JSON.parse(ledger.before) as Applied;

const newestLedger = async (r: Reader, ctx: QueryCtx, observationId: Id<"sourceObservations">) =>
  (
    await r.many(
      ctx.db
        .query("heldRepairLedger")
        .withIndex("by_observation", (q) => q.eq("observationId", observationId)),
    )
  ).reduce<Doc<"heldRepairLedger"> | undefined>(
    (latest, one) => (!latest || one._creationTime > latest._creationTime ? one : latest),
    undefined,
  );

/**
 * Native records prove an earlier apply, never a caller's declaration: the
 * parent's newest receipt is this route's, its Proposal is approved with the
 * Series Revision, and the parent is exactly what the apply wrote.
 */
async function verifyReceipt(
  ctx: QueryCtx,
  r: Reader,
  parent: Doc<"sourceObservations">,
  seriesId: Id<"series">,
) {
  const receipt = await newestLedger(r, ctx, parent._id);
  if (receipt?.operation !== SOURCE_PARENT_OPERATION)
    return refuse(
      "A series:<slug> observation already exists; this route never overwrites a parent.",
    );
  const applied = appliedOf(receipt);
  if (
    applied.operation !== SOURCE_PARENT_OPERATION ||
    parent.sourceKey !== SOURCE_KEY ||
    parent.sourceRecordId !== `series:${applied.seriesKey}`
  )
    return refuse("Parent receipt identity disagrees.");
  await validateAudit(ctx, r, receipt, applied.seriesId, false, applied.auditHash);
  if (receipt.after !== valueHash(parentFacts(parent)) || applied.seriesId !== seriesId)
    return refuse("Parent changed since this route wrote it; it is never overwritten.");
  return receipt;
}

/** Receipts contain the original full guard. Pin every full read by SHA-256 so
 * repeated receipt reads cannot multiply that guard beyond the argument limit.
 */
const receiptFacts = (r: Reader) => r.facts.map((fact) => sha256Hex(valueHash(fact)));

/** Read the complete audit through the guard, for both initial receipts and retries. */
async function auditState(ctx: QueryCtx, r: Reader, proposalId: Id<"proposals">) {
  const proposal = await r.read(proposalId);
  const versions = await r.many(
    ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId)),
  );
  const revisions = await r.many(
    ctx.db.query("revisions").withIndex("by_proposal", (q) => q.eq("proposalId", proposalId)),
  );
  return { proposal, versions, revisions };
}

/** The ledger pins the approved Proposal, immutable version, evidence, operation and Revision. */
async function validateAudit(
  ctx: QueryCtx,
  r: Reader,
  receipt: Doc<"heldRepairLedger">,
  seriesId: Id<"series">,
  restoring: boolean,
  auditHash: string,
) {
  const audit = await auditState(ctx, r, receipt.proposalId);
  const { proposal, versions, revisions } = audit;
  const version = versions[0];
  const revision = revisions[0];
  const ref = { type: "series" as const, id: seriesId };
  const change = restoring
    ? {
        field: "sourceObservation",
        before: { observationId: receipt.observationId, operation: SOURCE_PARENT_OPERATION },
        after: null,
      }
    : {
        field: "sourceObservation",
        after: { observationId: receipt.observationId, operation: SOURCE_PARENT_OPERATION },
      };
  if (
    !auditHash ||
    sha256Hex(valueHash(audit)) !== auditHash ||
    proposal?.state !== "approved" ||
    proposal.currentVersionNo !== 1 ||
    proposal.stale ||
    versions.length !== 1 ||
    version?.versionNo !== 1 ||
    revisions.length !== 1 ||
    !revision ||
    !sameValue(version.ops, [{ kind: "update", ref, changes: [change] }]) ||
    !sameValue(revision.ref, ref) ||
    !sameValue(revision.changes, [change]) ||
    !sameValue(revision.author, proposal.author) ||
    revision.approvedBy !== proposal.decidedBy ||
    revision.comment !== version.changeComment ||
    !version.evidence.length
  )
    return refuse("Source-parent audit receipt is missing or changed.");
  return audit;
}

/** Scan every Series rather than certifying uniqueness from truncated search results.
 * Only matching candidates become guard facts; any newly matching declaration changes the set.
 * Transaction headroom bounds the full scan, and exhaustion refuses before any write.
 */
async function uniqueDeclaredWork(ctx: QueryCtx, r: Reader, title: string, seriesId: Id<"series">) {
  const candidates: Doc<"series">[] = [];
  let scanned = 0;
  await r.room();
  for await (const candidate of ctx.db.query("series")) {
    if (++scanned > 20000) return refuse("Canonical Series scan exceeds 20000; incomplete.");
    if (
      candidate.status === "active" &&
      declaredWorkNames(candidate).some((name) => sameWorkTitle(name, title))
    )
      candidates.push(candidate);
    await r.room();
  }
  r.facts.push({ canonicalCandidates: candidates, scanned });
  if (candidates.length !== 1 || candidates[0]?._id !== seriesId)
    return refuse("Canonical work declared-name resolution is absent or ambiguous.");
}

/**
 * Every Kodansha observation under the slug, in any state, read by index
 * range ("<slug>/..."), and the facts each must agree on.
 */
async function closureState(
  ctx: QueryCtx,
  r: Reader,
  proof: SourceParentProof,
  series: Doc<"series">,
) {
  const slug = proof.seriesSlug;
  const rows = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gte("sourceRecordId", `${slug}/`)
          .lt("sourceRecordId", `${slug}0`),
      ),
  );
  if (rows.length > MAX_MEMBERS) return refuse("Source closure is too large; incomplete.");
  const ids = rows.map((row) => row._id).sort();
  if (!sameValue(ids, [...proof.observationIds].sort()))
    return refuse("Source closure differs from the reviewed observations; preview again.");
  const canonical = seriesUrlOf(slug);
  const creators = new Set<string>();
  const urls = new Set<string>();
  const bindingDiscrepancies: {
    observationId: Id<"sourceObservations">;
    isbn13: string;
    sourceBinding: string;
    ownerReleaseId: Id<"releases">;
    ownerBinding: string;
  }[] = [];
  const held: Id<"sourceObservations">[] = [];
  let creatorList: string[] | null = null;
  for (const row of rows) {
    if (nonJsonPath(row.snapshot)) return refuse("A source volume snapshot is not JSON.");
    const s = row.snapshot as KodanshaVolume;
    const key = s.url ? memberKey(s.url, slug) : null;
    if (
      s.kind !== "kodanshaVolume" ||
      s.seriesSlug !== slug ||
      s.seriesUrl !== canonical ||
      s.seriesTitle !== proof.sourceTitle ||
      (s.packaging?.lineName ?? null) !== proof.lineName ||
      !key ||
      row.sourceRecordId !== `${slug}/volume-${key[1]}#${s.format}`
    )
      return refuse(`Source volume ${row.sourceRecordId} disagrees on its series identity.`);
    urls.add(s.url!);
    const names = [...(s.creators ?? [])].sort();
    if (creatorList && !sameValue(creatorList, names))
      return refuse("Source volumes disagree on their creators.");
    creatorList = names;
    for (const name of names) creators.add(name);
    const holds = await r.many(
      ctx.db
        .query("placementHolds")
        .withIndex("by_observation", (q) => q.eq("observationId", row._id)),
    );
    if (holds.length > 1)
      return refuse(`Held volume ${row.sourceRecordId} has multiple holds; ambiguous.`);
    const hold = holds[0];
    if (hold?.seriesId && hold.seriesId !== series._id)
      return refuse(`Held volume ${row.sourceRecordId} names another Series.`);
    if (hold) held.push(row._id);
    const queued = row.queuedProposalId ? await r.read(row.queuedProposalId) : null;
    if (queued?.state === "inReview" || queued?.state === "draft")
      return refuse(`Source volume ${row.sourceRecordId} has a Proposal in review or draft.`);
    if (row.recordRef) {
      if (row.recordRef.type !== "release")
        return refuse(`Source volume ${row.sourceRecordId} is linked to a non-Release.`);
      const linked = await r.read(row.recordRef.id);
      if (!linked || !(await releaseSurvivor(r, linked._id, series._id)))
        return refuse(`Source volume ${row.sourceRecordId} is linked under another Series.`);
    }
    if (s.isbn13 === undefined) continue;
    if (toIsbn13(s.isbn13) !== s.isbn13)
      return refuse(`Source volume ${row.sourceRecordId} states an invalid ISBN.`);
    for (const owner of await ownersAgree(ctx, r, s.isbn13, series._id)) {
      if (s.binding && owner.binding && s.binding !== owner.binding)
        bindingDiscrepancies.push({
          observationId: row._id,
          isbn13: s.isbn13,
          sourceBinding: s.binding,
          ownerReleaseId: owner._id,
          ownerBinding: owner.binding,
        });
    }
  }
  if (!rows.length || !held.length) return refuse("No held volume stands under this slug.");
  return { rows, creators: [...creators], urls, held, bindingDiscrepancies };
}

/** The canonical Series' credited people, by name key. */
async function creditedKeys(ctx: QueryCtx, r: Reader, seriesId: Id<"series">) {
  const credits = await r.many(
    ctx.db.query("seriesCredits").withIndex("by_series", (q) => q.eq("seriesId", seriesId)),
  );
  const keys = new Set<string>();
  for (const credit of credits) {
    const person = await r.read(credit.personId);
    if (person) keys.add(nameKey(person.name));
  }
  return keys;
}

/** Preview and apply share this guard; `expected` hashes every fact read. */
export async function sourceParentState(
  ctx: QueryCtx,
  args: { proof: SourceParentProof },
  now: number,
) {
  const { proof } = args;
  const slug = proof.seriesSlug;
  if (!REVIEWED_SOURCE_PARENT_SLUGS.includes(slug))
    return refuse("Slug is not one this campaign reviewed for a source parent.");
  const r = reader(ctx);
  const series = await r.active(proof.seriesId);
  if (series._id !== proof.seriesId)
    return refuse("Reviewed Series was merged; name its survivor.");
  const parents = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q.eq("sourceKey", SOURCE_KEY).eq("sourceRecordId", `series:${slug}`),
      ),
  );
  if (parents.length > 1) return refuse("Several series:<slug> observations exist.");
  if (parents.length === 1) {
    const parent = parents[0]!;
    const receipt = await verifyReceipt(ctx, r, parent, proof.seriesId);
    const expected = valueHash({
      operation: SOURCE_PARENT_OPERATION,
      already: receipt._id,
      after: receipt.after,
      facts: receiptFacts(r),
    });
    return { already: true as const, receipt, parent, expected, r };
  }
  // The page proves the parent; the stored records only have to agree with it.
  const page = checkCapture(proof, now);
  const names = declaredWorkNames(series);
  if (!names.some((name) => sameWorkTitle(name, proof.sourceTitle)))
    return refuse(
      `Source series title "${proof.sourceTitle}" is not a name of the reviewed Series.`,
    );
  await uniqueDeclaredWork(ctx, r, proof.sourceTitle, series._id);
  const closure = await closureState(ctx, r, proof, series);
  if (!sameValue([...closure.urls].sort(), [...page.links].sort()))
    return refuse("The page's volume links and the stored source volumes differ.");
  const credited = await creditedKeys(ctx, r, series._id);
  const pageKeys = page.authors.map(nameKey);
  const sourceKeys = closure.creators.map(nameKey);
  if (
    !sourceKeys.length ||
    !sameValue([...new Set(pageKeys)].sort(), [...new Set(sourceKeys)].sort()) ||
    pageKeys.some((key) => !credited.has(key))
  )
    return refuse("The page's and the volumes' authors are not the reviewed Series' credits.");
  const expected = valueHash({
    operation: SOURCE_PARENT_OPERATION,
    proof,
    facts: r.facts,
  });
  if (utf8Bytes(expected) > MAX_GUARD_BYTES) return refuse("Guard exceeds 256 KiB.");
  return {
    already: false as const,
    expected,
    r,
    series,
    page,
    closure,
  };
}

/** One nested transaction: parent, Revision, audit and ledger, or nothing. */
export async function applySourceParent(
  ctx: MutationCtx,
  args: Infer<typeof executeArgs>,
): Promise<SourceParentResult> {
  const now = Date.now();
  const state = await sourceParentState(ctx, args, now);
  const actor = await resolveActor(ctx, args.actor);
  if (state.already) {
    if (state.expected !== args.expected && appliedOf(state.receipt).expected !== args.expected)
      return refuse("Parent state changed; preview again.");
    return { status: "alreadyApplied", parentId: state.parent._id, ledgerId: state.receipt._id };
  }
  if (state.expected !== args.expected) return refuse("Parent state changed; preview again.");
  const { proof } = args;
  const { series, page, closure } = state;
  const note = valueHash({
    operation: SOURCE_PARENT_OPERATION,
    capture: proof.capture,
    heldVolumes: closure.held,
    bindingDiscrepancies: closure.bindingDiscrepancies,
  });
  if (utf8Bytes(note) > 64 * 1024) return refuse("Audit note exceeds 64 KiB.");
  const evidence: Parameters<typeof createAudit>[3] = [
    { kind: "url", url: page.url, note: `sha256 ${proof.capture.sha256}` },
    { kind: "note", text: note },
  ];
  const audit = createAudit(ctx, actor, proof.reason.trim(), evidence);
  const parentId = await linkSeriesObservation(ctx, {
    sourceKey: SOURCE_KEY,
    seriesKey: proof.seriesSlug,
    title: proof.sourceTitle,
    url: page.url,
    seriesId: series._id,
    now,
  });
  evidence.push({ kind: "observation", observationId: parentId });
  const changes = [
    {
      field: "sourceObservation",
      after: { observationId: parentId, operation: SOURCE_PARENT_OPERATION },
    },
  ];
  audit.op({ kind: "update", ref: { type: "series", id: series._id }, changes });
  await audit.revise({ type: "series", id: series._id }, changes);
  await audit.finish();
  const proposalId = (await audit.meta()).proposalId;
  // Postconditions: one new linked parent; every volume and the Series untouched.
  const parent = await ctx.db.get(parentId);
  const holds = await ctx.db
    .query("placementHolds")
    .withIndex("by_observation", (q) => q.eq("observationId", parentId))
    .take(1);
  const members = await Promise.all(closure.rows.map((row) => ctx.db.get(row._id)));
  if (
    !parent ||
    !sameValue(parent.snapshot, { kind: "series", title: proof.sourceTitle, url: page.url }) ||
    !sameValue(parent.recordRef, { type: "series", id: series._id }) ||
    parent.withdrawn ||
    holds.length ||
    !sameValue(members, closure.rows) ||
    !sameValue(await ctx.db.get(series._id), series)
  )
    throw new ConvexError("Parent postconditions failed; whole operation rolled back.");
  const applied: Applied = {
    operation: SOURCE_PARENT_OPERATION,
    seriesKey: proof.seriesSlug,
    seriesId: series._id,
    expected: args.expected,
    auditHash: sha256Hex(valueHash(await auditState(ctx, reader(ctx), proposalId))),
    members: closure.rows.map((row) => ({ id: row._id, recordRef: row.recordRef })),
  };
  const ledgerId = await ctx.db.insert("heldRepairLedger", {
    observationId: parentId,
    operation: SOURCE_PARENT_OPERATION,
    proposalId,
    before: valueHash(applied),
    after: valueHash(parentFacts(parent)),
  });
  return { status: "linked", parentId, proposalId, ledgerId };
}

/**
 * Whether the parent this route wrote can be removed again: it is still
 * exactly as written, with no later snapshot, hold or Proposal, and no
 * volume under the slug was linked since. Child observations are never
 * touched either way.
 */
export async function sourceParentRestoreState(
  ctx: QueryCtx,
  args: { ledgerId: Id<"heldRepairLedger"> },
) {
  const r = reader(ctx);
  const ledger = await r.read(args.ledgerId);
  if (ledger?.operation !== SOURCE_PARENT_OPERATION) return refuse("Not a source-parent receipt.");
  const applied = appliedOf(ledger);
  if (applied.operation !== SOURCE_PARENT_OPERATION) return refuse("Receipt operation disagrees.");
  await validateAudit(ctx, r, ledger, applied.seriesId, false, applied.auditHash);
  const newest = await newestLedger(r, ctx, ledger.observationId);
  if (newest?.operation === SOURCE_PARENT_RESTORE && newest.before === ledger.after) {
    const restored = JSON.parse(newest.after) as {
      expected: string;
      auditHash: string;
      applyLedgerId: string;
    };
    if (restored.applyLedgerId !== ledger._id || (await r.read(ledger.observationId)))
      return refuse("Restored parent receipt disagrees or parent reappeared.");
    await validateAudit(ctx, r, newest, applied.seriesId, true, restored.auditHash);
    const expected = valueHash({
      operation: SOURCE_PARENT_RESTORE,
      already: newest._id,
      facts: receiptFacts(r),
    });
    return { already: true as const, ledger, restore: newest, expected };
  }
  if (newest?._id !== ledger._id) return refuse("A later repair supersedes this receipt.");
  const parent = await r.read(ledger.observationId);
  if (!parent || valueHash(parentFacts(parent)) !== ledger.after)
    return refuse("Parent changed since it was written; restoration refuses.");
  const snapshots = await r.many(
    ctx.db
      .query("observationSnapshots")
      .withIndex("by_observation", (q) => q.eq("observationId", parent._id)),
  );
  const holds = await r.many(
    ctx.db
      .query("placementHolds")
      .withIndex("by_observation", (q) => q.eq("observationId", parent._id)),
  );
  if (snapshots.length || holds.length)
    return refuse("Parent has later history or a hold; restoration refuses.");
  const slug = applied.seriesKey;
  const rows = await r.many(
    ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", SOURCE_KEY)
          .gte("sourceRecordId", `${slug}/`)
          .lt("sourceRecordId", `${slug}0`),
      ),
  );
  const then = new Map(applied.members.map((one) => [one.id, one.recordRef]));
  for (const row of rows)
    if (row.recordRef && !sameValue(row.recordRef, then.get(row._id)))
      return refuse(
        `Volume ${row.sourceRecordId} was linked after the parent was written; restoration refuses.`,
      );
  const series = await r.read(applied.seriesId);
  const expected = valueHash({ operation: SOURCE_PARENT_RESTORE, facts: receiptFacts(r) });
  if (utf8Bytes(expected) > MAX_GUARD_BYTES) return refuse("Guard exceeds 256 KiB.");
  return { already: false as const, ledger, parent, series, expected };
}

/** Remove the parent this route wrote, with its own Proposal, Revision and receipt. */
export async function restoreSourceParent(
  ctx: MutationCtx,
  args: Infer<typeof restoreExecuteArgs>,
): Promise<SourceParentRestoreResult> {
  const state = await sourceParentRestoreState(ctx, args);
  const actor = await resolveActor(ctx, args.actor);
  if (!args.reason.trim() || args.reason.length > 4000)
    return refuse("Supply a short restoration reason.");
  if (state.already) {
    if (
      state.expected !== args.expected &&
      (JSON.parse(state.restore.after) as { expected: string }).expected !== args.expected
    )
      return refuse("Restore state changed; preview again.");
    return { status: "alreadyRestored", ledgerId: state.restore._id };
  }
  if (state.expected !== args.expected) return refuse("Restore state changed; preview again.");
  const { ledger, parent, series } = state;
  const applied = appliedOf(ledger);
  const audit = createAudit(ctx, actor, args.reason.trim(), [
    { kind: "note", text: valueHash({ restores: ledger._id, proposalId: ledger.proposalId }) },
  ]);
  const changes = [
    {
      field: "sourceObservation",
      before: { observationId: parent._id, operation: SOURCE_PARENT_OPERATION },
      after: null,
    },
  ];
  audit.op({ kind: "update", ref: { type: "series", id: applied.seriesId }, changes });
  await audit.revise({ type: "series", id: applied.seriesId }, changes);
  await audit.finish();
  const proposalId = (await audit.meta()).proposalId;
  // The parent was an insert of this route's; removing it restores the absence it filled.
  await ctx.db.delete(parent._id);
  if (!sameValue(await ctx.db.get(applied.seriesId), series))
    throw new ConvexError("Restore postconditions failed; whole operation rolled back.");
  const ledgerId = await ctx.db.insert("heldRepairLedger", {
    observationId: parent._id,
    operation: SOURCE_PARENT_RESTORE,
    proposalId,
    before: ledger.after,
    after: valueHash({
      expected: args.expected,
      applyLedgerId: ledger._id,
      auditHash: sha256Hex(valueHash(await auditState(ctx, reader(ctx), proposalId))),
    }),
  });
  return { status: "restored", proposalId, ledgerId };
}
