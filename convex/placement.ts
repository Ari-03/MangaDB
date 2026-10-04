// "Prepare placement" (docs/moderation.md): a Data Team member turns a Held
// Book into a Draft creation Proposal of their own, prefilled from its
// observation, which they check, correct and submit through the ordinary
// Proposal flow (proposals.ts). Nothing here writes a canonical record: an
// Editor's Proposal waits for a Moderator, and approval creates the records
// and links the observation to the new Release (proposals.approveProposal).
//
// The ops come from the importers' own builder (lib/pipeline.ts
// creationOps), marked as a placement: under the hold's existing, unlocked
// Series, with a known Publisher, never a new Series or Publisher. Only this
// module writes a placement's ops (proposals.ts refuses `placement` in a
// member's own ops and their saveDraft over such a Draft). Coverage is
// always the member's to state: a Draft starts with none (a range of
// canonical Volumes, one Volume, or Unmapped Packaging under its line), and
// cannot be submitted until they state it. The page may suggest one Volume
// for an ordinary book (suggestedVolume), which the member must accept. A
// book number is a position in its line, never a Volume number.
//
// One rule decides whether a book can be placed (`placeable`): when the
// Draft is prepared, when its coverage is stated, at submission and at
// approval (checkPlacement), where it also holds the ops to the book: its
// ISBNs, format and Series, the Proposal it points at, and the slot.
//
// The observation points at the Draft (`queuedProposalId`, the importers'
// dedup pointer), so a second "Prepare placement" by its author, or by
// anyone while it is in review, opens it; another member's click withdraws
// an unsubmitted Draft and writes their own. The hold stays listed, marked
// by that Proposal's state, until approval links the book; a rejected or
// withdrawn Proposal leaves it held.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { lineOutOfScope, packagingOf, pageDescriptionText, type AnnReleaseSnapshot } from "./ann";
import { PUBLISHER as KODANSHA } from "./kodansha";
import { outOfScopeElsewhere, REBINDER } from "./openLibrary";
import { PUBLISHER as SEVEN_SEAS } from "./sevenSeas";
import { canonicalLabel, parseBookTitle, rangeLabels, type Packaging } from "./lib/bookTitle";
import { resolveBaseSeries } from "./lib/catalogTitle";
import type { DateParts } from "./lib/dates";
import { fail } from "./lib/errors";
import type { KodanshaSnapshot } from "./lib/kodansha";
import { holdOf, type HoldKind } from "./lib/observations";
import type { OlEditionSnapshot } from "./lib/openLibrary";
import {
  creationOps,
  findPublisherByName,
  needsEditionLine,
  toPartialDate,
  type CreateOp,
  type CreationOpsArgs,
} from "./lib/pipeline";
import type { PrhTitleSnapshot } from "./lib/prh";
import { checkOpCount, planCreateOps, unjoinable, type CreatePlan } from "./lib/proposalCreates";
import { requireDataTeam } from "./lib/roles";
import { isMangaBook, type BookSnapshot } from "./lib/sevenSeas";
import type { YenTitleSnapshot } from "./lib/yenPress";

/** The snapshot shapes of the sources whose books can be held. */
type HeldSnapshot =
  | OlEditionSnapshot
  | AnnReleaseSnapshot
  | PrhTitleSnapshot
  | YenTitleSnapshot
  | BookSnapshot
  | KodanshaSnapshot;

type Line = { name: string; position: string | null };

/** What the observation says about the book, read the way its adapter reads it. */
type BookFacts = {
  title: string;
  url: string | null;
  isbn13?: string;
  isbn10?: string;
  /** The single Volume label the adapter parsed; null for packaging or none. */
  label: string | null;
  /** Packaging by the stored signals or today's parser (titleReading): several Volumes, a line shape, a line word. */
  packaged: boolean;
  line: Line | null;
  /** The Volumes the source says it collects: shown to the member, never applied. */
  statedRange: { from: string; to: string } | null;
  isBox: boolean;
  /** Today's parser reads the title as a prose or light novel. */
  novel: boolean;
  /** The publisher names the source gives, in its order. */
  publisherNames: string[];
  format: "physical" | "digital";
  binding?: string;
  pubDate?: DateParts;
  priceCents?: number;
  description?: string;
  /** Why the adapter's own checks leave the book out of the catalog: prose, a rebinder, a variant. */
  outOfScope: string | null;
};

const lineOf = (packaging: Packaging | null | undefined): Line | null =>
  packaging?.lineName ? { name: packaging.lineName, position: packaging.linePosition } : null;

/**
 * The book's shape read two ways: the flags its snapshot stored when it was
 * first parsed, and today's title parser over the stored title. Either
 * one's packaging or line counts, so a snapshot parsed before the parser
 * knew a line word ("Vagabond Definitive Edition, Vol. 4") reads as the
 * line book it is.
 */
function titleReading(title: string, stored: { packaging?: Packaging; multi?: boolean; isBox?: boolean }) {
  const parsed = parseBookTitle(title);
  return {
    packaged:
      stored.multi === true || stored.packaging !== undefined || parsed.packaging !== null || needsEditionLine(title),
    line: lineOf(stored.packaging) ?? lineOf(parsed.packaging),
    statedRange: stored.packaging?.coverRange ?? parsed.packaging?.coverRange ?? null,
    isBox: stored.isBox === true || parsed.isBox,
    novel: parsed.isNovel,
  };
}

/** A label that names one numbered Volume ("4", "7.5"): no words, no range. */
const PLAIN_LABEL = /^\d+(?:\.\d+)?$/;

/** Read the observation's snapshot, or null for a shape no adapter here writes. */
async function bookFacts(ctx: QueryCtx, observation: Doc<"sourceObservations">): Promise<BookFacts | null> {
  const snapshot: HeldSnapshot | null = observation.snapshot ?? null;
  switch (snapshot?.kind) {
    case "olEdition": {
      const read = titleReading(snapshot.title, { packaging: snapshot.packaging, multi: snapshot.multiVolume });
      const elsewhere =
        snapshot.isbn13 !== undefined ? await outOfScopeElsewhere(ctx, snapshot.isbn13) : null;
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        label: read.packaged ? null : (await resolveBaseSeries(ctx, snapshot)).volumeLabel,
        ...read,
        publisherNames: snapshot.publishers,
        format: snapshot.format,
        binding: snapshot.binding,
        pubDate: snapshot.publishDate,
        description: snapshot.description,
        outOfScope: snapshot.publishers.some((name) => REBINDER.test(name))
          ? "It is a library rebinder's copy: another book, never the publisher's edition."
          : elsewhere !== null
            ? `${elsewhere} holds it out of scope.`
            : null,
      };
    }
    case "annRelease": {
      const page = snapshot.page?.status === "ok" ? snapshot.page : undefined;
      const read = titleReading(snapshot.title, { multi: snapshot.multi || snapshot.editionLineHint });
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: page?.isbn13 ?? snapshot.isbn13,
        isbn10: page?.isbn10,
        label: read.packaged ? null : (snapshot.label ?? null),
        ...read,
        line: read.packaged ? packagingOf(snapshot) : null,
        statedRange: snapshot.coverRange ?? read.statedRange,
        publisherNames: page?.distributor !== undefined ? [page.distributor] : [],
        format: snapshot.format,
        pubDate: page?.date ?? snapshot.date,
        priceCents: page?.priceCents,
        description: pageDescriptionText(page),
        outOfScope: lineOutOfScope(snapshot),
      };
    }
    case "prhTitle":
    case "yenTitle": {
      const read = titleReading(snapshot.title, {
        packaging: snapshot.packaging,
        multi: snapshot.multiVolume,
        isBox: snapshot.isBox,
      });
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        label: read.packaged ? null : (await resolveBaseSeries(ctx, snapshot)).volumeLabel,
        ...read,
        publisherNames: snapshot.imprint !== undefined ? [snapshot.imprint] : [],
        format: snapshot.format,
        binding: snapshot.binding,
        pubDate: snapshot.onsale,
        priceCents: snapshot.priceCents,
        description: snapshot.description,
        outOfScope:
          snapshot.kind === "yenTitle" && snapshot.outOfScope !== undefined
            ? `Yen Press holds it out of scope (${snapshot.outOfScope}).`
            : null,
      };
    }
    case "book": {
      const read = titleReading(snapshot.title, { packaging: snapshot.packaging, isBox: snapshot.isBox });
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        label: read.packaged ? null : (snapshot.volumeLabel ?? null),
        ...read,
        publisherNames: [SEVEN_SEAS.name],
        format: "physical",
        binding: snapshot.binding,
        pubDate: snapshot.releaseDate,
        priceCents: snapshot.priceCents,
        description: snapshot.description,
        outOfScope: isMangaBook(snapshot) ? null : "Seven Seas files it outside manga.",
      };
    }
    case "kodanshaVolume": {
      const read = titleReading(snapshot.title, { packaging: snapshot.packaging });
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        label: read.packaged ? null : (snapshot.volumeLabel ?? null),
        ...read,
        publisherNames: [KODANSHA.name],
        format: snapshot.format,
        binding: snapshot.binding,
        pubDate: snapshot.releaseDate,
        priceCents: snapshot.priceCents,
        outOfScope:
          snapshot.outOfScope !== undefined ? `Kodansha's page is out of scope (${snapshot.outOfScope}).` : null,
      };
    }
    default:
      return null;
  }
}

/** Why a hold of these kinds is never prepared, and what to do instead. */
const KEPT_HOLDS: Record<Exclude<HoldKind, "volumeMissing" | "packaging">, string> = {
  series:
    "No single active, unlocked Series fits this book. Prepare placement never chooses or creates a Series: link, unlock or merge the Series first.",
  isbn: "Its ISBN, or its Volume's slot for this publisher and format, is already taken: correct or merge the Release that holds it instead of adding another.",
  other: "Its publisher is missing or has no Publisher row. Prepare placement never creates a Publisher.",
};

type Preparable = {
  observation: Doc<"sourceObservations">;
  series: Doc<"series">;
  publisher: Doc<"publishers">;
  facts: BookFacts;
};

type ReleasePlan = Extract<CreatePlan, { table: "releases" }>;

/** A Proposal's planned ops (planCreateOps) and the one Release among them that places the book. */
type Placing = { proposalId: Id<"proposals">; plans: CreatePlan[]; release: ReleasePlan };

/**
 * Whether the held book can be placed: the one rule asked when its Draft
 * is prepared, when its coverage is stated, at submission and at approval.
 * The book: unlinked, still listed by its source, a `volumeMissing` or
 * `packaging` hold naming an active, unlocked Series, a snapshot this
 * module reads, in scope by its adapter's checks, not a box set, an ISBN no
 * active Release holds, and a publisher that resolves to a Publisher row.
 * Given a Proposal's plans (`placing`), the ops too: the observation points
 * at that Proposal, its placed Release carries the book's ISBN-13, ISBN-10
 * and format under the hold's Series, every Volume and line it creates or
 * covers is in that Series, nothing it joins is hidden, locked or merged
 * away, and the Edition it joins has no Release of that format yet (the
 * slot an `isbn` hold guards).
 */
async function placeable(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  placing?: Placing,
): Promise<{ ok: true; book: Preparable } | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (placing !== undefined && observation.queuedProposalId !== placing.proposalId) {
    return no("The book's placement is another Proposal's now: open it from Held Books.");
  }
  if (observation.recordRef !== undefined) return no("The book is already linked to a record.");
  if (observation.withdrawn) return no("Its source no longer lists it.");
  const hold = await holdOf(ctx, observation._id);
  if (hold === null) return no("It is not a Held Book.");
  if (hold.kind !== "volumeMissing" && hold.kind !== "packaging") return no(KEPT_HOLDS[hold.kind]);
  const series = hold.seriesId !== undefined ? await ctx.db.get(hold.seriesId) : null;
  if (series === null) return no(KEPT_HOLDS.series);
  if (series.status !== "active") return no(`The Series it names, "${series.title}", is ${series.status}.`);
  if (series.locked) return no(`The Series it names, "${series.title}", is locked.`);
  const facts = await bookFacts(ctx, observation);
  if (facts === null) return no("Prepare placement cannot read this source's records.");
  if (facts.outOfScope !== null) return no(facts.outOfScope);
  if (facts.isBox) {
    return no("A box set is a Release Bundle, which a Proposal cannot create.");
  }
  const { isbn13, isbn10 } = facts;
  const holders = [
    ...(isbn13 !== undefined
      ? await ctx.db.query("releases").withIndex("by_isbn13", (q) => q.eq("isbn13", isbn13)).collect()
      : []),
    ...(isbn10 !== undefined
      ? await ctx.db.query("releases").withIndex("by_isbn10", (q) => q.eq("isbn10", isbn10)).collect()
      : []),
  ];
  if (holders.some((release) => release.status === "active")) {
    return no(`ISBN ${isbn13 ?? isbn10} is already on an active Release: link or correct that Release instead.`);
  }
  if (placing !== undefined) {
    const wrong = await placedOtherwise(ctx, facts, series, placing);
    if (wrong !== null) return no(wrong);
  }
  for (const name of facts.publisherNames) {
    const publisher = await findPublisherByName(ctx, name);
    if (publisher !== null) return { ok: true, book: { observation, series, publisher, facts } };
  }
  return no(
    facts.publisherNames.length === 0
      ? "The source names no publisher. Prepare placement never guesses one."
      : `No Publisher row matches ${facts.publisherNames.map((name) => `"${name}"`).join(", ")}. Prepare placement never creates a Publisher.`,
  );
}

/** How a Proposal's planned placement differs from the book and its hold today, or null when it does not. */
async function placedOtherwise(
  ctx: MutationCtx,
  facts: BookFacts,
  series: Doc<"series">,
  { plans, release }: Placing,
): Promise<string | null> {
  const { isbn13, isbn10, format } = release.fields;
  if (isbn13 !== facts.isbn13 || isbn10 !== facts.isbn10 || format !== facts.format) {
    return "The Release's ISBN or format is not the book's: its source changed it since the Proposal was written.";
  }
  if (release.placement?.seriesId !== series._id) {
    return `The book is held under "${series.title}" now, not the Series this Proposal places it under.`;
  }
  const blocked = unjoinable(plans)[0];
  if (blocked !== undefined) {
    return `A ${blocked.type} this placement would join is hidden, locked or merged away: a Moderator restores it, or the coverage is restated.`;
  }
  for (const plan of plans) {
    const under: Array<Id<"series"> | null> = [];
    if (plan.table === "series") under.push(null);
    if (plan.table === "volumes" || plan.table === "editionLines") {
      under.push(plan.series.kind === "id" ? plan.series.id : null);
    }
    if (plan.table === "editions") {
      for (const row of plan.coverage) {
        if (row.volume.kind === "id") under.push((await ctx.db.get(row.volume.id))?.seriesId ?? null);
      }
      if (plan.editionLine?.kind === "id") under.push((await ctx.db.get(plan.editionLine.id))?.seriesId ?? null);
      // The slot an `isbn` hold guards: one Release per format in an Edition.
      const joined = plan.existingId !== undefined ? await ctx.db.get(plan.existingId) : null;
      const taken =
        joined !== null &&
        (
          await ctx.db
            .query("releases")
            .withIndex("by_edition", (q) => q.eq("editionId", joined._id))
            .collect()
        ).some((other) => other.status === "active" && other.format === format);
      if (taken) return KEPT_HOLDS.isbn;
    }
    if (under.some((id) => id !== series._id)) return `Every record a placement creates is under "${series.title}".`;
  }
  return null;
}

type Coverage = { labels: string[] } | "unmapped" | "pending";

/** The creation ops that place the book under its Series, built by the importers' builder. */
async function placementOps(
  ctx: MutationCtx,
  { observation, series, publisher, facts }: Preparable,
  coverage: Coverage,
  line: Line | null,
): Promise<CreateOp[]> {
  const args: CreationOpsArgs = {
    seriesId: series._id,
    seriesTitle: series.title,
    labels: typeof coverage === "string" ? [] : coverage.labels,
    ...(line !== null ? { editionLine: line } : {}),
    release: {
      format: facts.format,
      binding: facts.format === "physical" ? facts.binding : undefined,
      isbn13: facts.isbn13,
      isbn10: facts.isbn10,
      pubDate: facts.pubDate !== undefined ? toPartialDate(facts.pubDate) : undefined,
      price: facts.priceCents !== undefined ? { amountCents: facts.priceCents, currency: "USD" } : undefined,
      description: facts.description,
      publisherSlug: publisher.slug,
    },
    placement: {
      observationId: observation._id,
      seriesId: series._id,
      coverage: typeof coverage === "string" ? coverage : "labels",
    },
  };
  return await creationOps(ctx, args);
}

/**
 * At submission and approval (proposals.ts): when the planned ops place a
 * held book, refuse them (`invalidCreate`, nothing written) unless they
 * place one book, through one Release, and `placeable` still holds for it.
 */
export async function checkPlacement(
  ctx: MutationCtx,
  proposalId: Id<"proposals">,
  plans: CreatePlan[],
): Promise<void> {
  const [first, ...more] = plans.flatMap((plan) =>
    plan.table === "releases" && plan.placement !== undefined ? [{ release: plan, placement: plan.placement }] : [],
  );
  if (first === undefined) return;
  if (more.length > 0) return fail("invalidCreate", "A Proposal places one held book, through one Release.");
  const { release, placement } = first;
  const observation = await ctx.db.get(placement.observationId);
  if (observation === null) return fail("invalidCreate", "The observation this release places no longer exists.");
  const check = await placeable(ctx, observation, { proposalId, plans, release });
  if (!check.ok) return fail("invalidCreate", `This book can no longer be placed by this Proposal. ${check.reason}`);
}

/**
 * "Prepare placement" on a Held Book (Data Team): open the book's Proposal
 * in review, or the caller's own Draft of it; else say why the book cannot
 * be prepared; else write a Draft authored by the member, citing the
 * observation, with its coverage unstated and the source's line prefilled.
 * Another member's unsubmitted Draft of the book is withdrawn, with a note
 * saying why, and the observation points at the new one. A repeat or a
 * replay opens the same Draft.
 */
export const preparePlacement = mutation({
  args: { observationId: v.id("sourceObservations") },
  handler: async (ctx, { observationId }) => {
    const user = await requireDataTeam(ctx);
    const observation = await ctx.db.get(observationId);
    if (observation === null) return fail("notFound", "No such observation.");
    const queued = observation.queuedProposalId !== undefined ? await ctx.db.get(observation.queuedProposalId) : null;
    const mine = queued?.author.kind === "user" && queued.author.userId === user._id;
    if (queued !== null && (queued.state === "inReview" || (queued.state === "draft" && mine))) {
      return { status: "existing" as const, proposalId: queued._id };
    }
    const check = await placeable(ctx, observation);
    if (!check.ok) return { status: "unavailable" as const, reason: check.reason };
    if (queued?.state === "draft") {
      await ctx.db.patch(queued._id, { state: "withdrawn", decidedAt: Date.now() });
      await ctx.db.insert("proposalNotes", {
        proposalId: queued._id,
        versionNo: queued.currentVersionNo,
        authorId: user._id,
        kind: "comment",
        text: `Withdrawn: @${user.username} prepared this book's placement again while this was a Draft.`,
      });
    }
    const { series, facts } = check.book;
    const ops = await placementOps(ctx, check.book, "pending", facts.line);
    const proposalId = await ctx.db.insert("proposals", {
      author: { kind: "user", userId: user._id, roleAtAuthorship: user.role },
      state: "draft",
      currentVersionNo: 0,
      draft: {
        ops,
        evidence: [{ kind: "observation", observationId }],
        comment: `Place the held book "${facts.title}"${facts.isbn13 !== undefined ? ` (ISBN ${facts.isbn13})` : ""} under "${series.title}".`,
      },
    });
    await ctx.db.patch(observationId, { queuedProposalId: proposalId });
    return { status: "prepared" as const, proposalId };
  },
});

type Placed = { observationId: Id<"sourceObservations">; seriesId: Id<"series"> };

/** The book a Proposal's ops place, and under which Series: the Release create op's `placement`. */
export function placedBy(ops: Doc<"proposalVersions">["ops"]): Placed | null {
  for (const op of ops) {
    if (op.kind !== "create" || op.table !== "releases") continue;
    const placement: Partial<Placed> | undefined = op.fields?.placement;
    if (placement?.observationId !== undefined && placement.seriesId !== undefined) {
      return { observationId: placement.observationId, seriesId: placement.seriesId };
    }
  }
  return null;
}

/**
 * The author states a placement Draft's coverage (a range of canonical
 * Volumes, first to last, one Volume as a range of one, or Unmapped
 * Packaging under its line), its Edition Line, and its comment. The ops
 * are rebuilt from the observation against today's records, so this also
 * brings a Draft whose Volumes moved up to date; any Volume of the range
 * the Series lacks is created on approval. The rebuilt ops must pass
 * `placeable` and the per-Proposal op cap.
 */
export const setPlacement = mutation({
  args: {
    proposalId: v.id("proposals"),
    coverage: v.union(v.object({ from: v.string(), to: v.string() }), v.literal("unmapped")),
    line: v.union(v.null(), v.object({ name: v.string(), position: v.union(v.string(), v.null()) })),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireDataTeam(ctx);
    const proposal = await ctx.db.get(args.proposalId);
    if (proposal === null) return fail("notFound", "No such proposal.");
    if (proposal.author.kind !== "user" || proposal.author.userId !== user._id) {
      return fail("forbidden", "Only the proposal's author may do this.");
    }
    if (proposal.state !== "draft" || proposal.draft === undefined) {
      return fail("badState", "Only Draft proposals can be edited.");
    }
    const placed = placedBy(proposal.draft.ops);
    if (placed === null) return fail("notPlacement", "This proposal places no held book.");
    const observation = await ctx.db.get(placed.observationId);
    if (observation === null) return fail("notFound", "The held book's observation is gone.");
    const check = await placeable(ctx, observation);
    if (!check.ok) return fail("placementUnavailable", check.reason);

    const name = args.line?.name.trim() ?? "";
    const position = args.line?.position?.trim() || null;
    const line = name !== "" ? { name, position } : null;
    let coverage: Coverage;
    if (args.coverage === "unmapped") {
      if (line === null) return fail("invalidCoverage", "Unmapped Packaging is a member of an Edition Line: name its line.");
      coverage = "unmapped";
    } else {
      const from = canonicalLabel(args.coverage.from.trim());
      const to = canonicalLabel(args.coverage.to.trim());
      const labels = !PLAIN_LABEL.test(from) || !PLAIN_LABEL.test(to) ? [] : from === to ? [from] : rangeLabels({ from, to });
      if (labels.length === 0) {
        return fail("invalidCoverage", "State the covered Volumes as numbers, first to last (10 to 12), or one Volume (4).");
      }
      coverage = { labels };
    }
    const ops = await placementOps(ctx, check.book, coverage, line);
    checkOpCount(ops.length);
    const plans = await planCreateOps(ctx, ops);
    const release = plans.find((plan): plan is ReleasePlan => plan.table === "releases");
    if (release === undefined) return fail("notPlacement", "This proposal places no held book.");
    const placing = await placeable(ctx, observation, { proposalId: proposal._id, plans, release });
    if (!placing.ok) return fail("placementUnavailable", placing.reason);
    await ctx.db.patch(proposal._id, {
      draft: { ops, evidence: proposal.draft.evidence, comment: args.comment.trim() },
    });
    return null;
  },
});

/**
 * The one Volume the page may suggest for a book, which the member must
 * accept and preparing never saves: only when today's parser reads the
 * title as an ordinary single book (no line, no packaging or multi-volume
 * signal, not a novel or a box set), its label is a plain Volume number,
 * and that number is at most one above the Series' highest numbered active
 * Volume or fills a gap below it. A light novel or a line book sharing a
 * manga's title carries numbers far past the manga's last Volume.
 */
async function suggestedVolume(ctx: QueryCtx, facts: BookFacts, seriesId: Id<"series">): Promise<string | null> {
  if (facts.packaged || facts.line !== null || facts.novel || facts.isBox || facts.label === null) return null;
  const label = canonicalLabel(facts.label);
  if (!PLAIN_LABEL.test(label)) return null;
  const numbers = (await ctx.db.query("volumes").withIndex("by_series", (q) => q.eq("seriesId", seriesId)).collect())
    .flatMap((volume) =>
      volume.status === "active" && volume.label !== undefined && PLAIN_LABEL.test(volume.label) ? [Number(volume.label)] : [],
    );
  const wanted = Number(label);
  return wanted <= Math.max(0, ...numbers) + 1 && !numbers.includes(wanted) ? label : null;
}

/**
 * The placement part of the Proposal page, for ops that place a held book:
 * what the observation says beside what the ops create, under the Series
 * they create it under: the Volumes covered (those approval creates
 * marked), the Edition's line and coverage (`pending` while unstated), the
 * Release, and the one Volume the page may suggest (suggestedVolume).
 */
export async function placementView(ctx: QueryCtx, ops: Doc<"proposalVersions">["ops"]) {
  const placed = placedBy(ops);
  if (placed === null) return null;
  const observation = await ctx.db.get(placed.observationId);
  const facts = observation !== null ? await bookFacts(ctx, observation) : null;
  const created = new Map<string, string | null>();
  // The Series the ops create under: their Volumes' and line's.
  const under: unknown[] = [];
  let edition: Record<string, unknown> = {};
  let release: Record<string, unknown> = {};
  let newLine: string | null = null;
  for (const op of ops) {
    if (op.kind !== "create") continue;
    if (op.table === "volumes") created.set(op.tempId, op.fields?.label ?? null);
    if (op.table === "volumes" || op.table === "editionLines") under.push(op.fields?.seriesId);
    if (op.table === "editionLines") newLine = op.fields?.name ?? null;
    if (op.table === "editions") edition = op.fields ?? {};
    if (op.table === "releases") release = op.fields ?? {};
  }
  const volumes = [];
  const rows: Array<{ volume?: unknown; volumeId?: unknown }> = Array.isArray(edition.volumeCoverage)
    ? edition.volumeCoverage
    : [];
  for (const row of rows) {
    const ref = row.volume ?? row.volumeId;
    if (typeof ref !== "string") continue;
    if (created.has(ref)) {
      volumes.push({ label: created.get(ref) ?? null, created: true });
      continue;
    }
    const id = ctx.db.normalizeId("volumes", ref);
    const volume = id !== null ? await ctx.db.get(id) : null;
    under.push(volume?.seriesId);
    volumes.push({ label: volume?.label ?? null, created: false });
  }
  // The Edition's line: a stored one by ID, or the one these ops create.
  const lineId =
    typeof edition.editionLineId === "string" ? ctx.db.normalizeId("editionLines", edition.editionLineId) : null;
  const storedLine = lineId !== null ? await ctx.db.get(lineId) : null;
  under.push(storedLine?.seriesId);
  const lineName = lineId !== null ? (storedLine?.name ?? null) : edition.editionLineId !== undefined ? newLine : null;
  const seriesRef = under.find((ref) => typeof ref === "string") ?? placed.seriesId;
  const seriesId = typeof seriesRef === "string" ? ctx.db.normalizeId("series", seriesRef) : null;
  const series = seriesId !== null ? await ctx.db.get(seriesId) : null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    observationId: placed.observationId,
    sourceKey: observation?.sourceKey ?? null,
    book:
      facts === null
        ? null
        : {
            title: facts.title,
            url: facts.url,
            label: facts.label,
            line: facts.line,
            statedRange: facts.statedRange,
            publisher: facts.publisherNames.join(" / ") || null,
            isbn13: facts.isbn13 ?? null,
            format: facts.format,
            pubDate: facts.pubDate ?? null,
          },
    series: series !== null ? { publicId: series.publicId, title: series.title } : null,
    suggestion: facts !== null && series !== null ? await suggestedVolume(ctx, facts, series._id) : null,
    coverage:
      edition.coverageUnmapped === true
        ? { kind: "unmapped" as const }
        : volumes.length === 0
          ? { kind: "pending" as const }
          : { kind: "volumes" as const, volumes },
    line: lineName !== null ? { name: lineName, position: text(edition.linePosition), created: lineId === null } : null,
    publisherSlug: text(edition.publisherSlug),
    release: {
      format: text(release.format),
      binding: text(release.binding),
      isbn13: text(release.isbn13),
    },
  };
}
