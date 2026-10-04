// "Prepare placement" (docs/moderation.md): a Data Team member turns a Held
// Book into a Draft creation Proposal of their own, prefilled from its
// observation, which they check, correct and submit through the ordinary
// Proposal flow (proposals.ts). Nothing here writes a canonical record: an
// Editor's Proposal waits for a Moderator, and approval creates the records
// and links the observation to the new Release (proposals.approveProposal).
//
// The ops come from the importers' own builder (lib/pipeline.ts
// creationOps), marked as a placement: under the hold's existing, unlocked
// Series, with a known Publisher, never a new Series or Publisher. Only an
// ordinary single book with a plain Volume label is prefilled with that one
// Volume; a book on a line or covering several Volumes leaves its coverage
// for the member to state (a range of canonical Volumes, or Unmapped
// Packaging), and its Draft cannot be submitted until they have. A book
// number is a position in its line, never a Volume number.
//
// The observation points at the Draft (`queuedProposalId`, the importers'
// dedup pointer), so a second "Prepare placement" opens it instead of making
// another. The hold stays listed, marked by that Proposal's state, until
// approval links the book; a rejected or withdrawn Proposal leaves it held.

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
import { planCreateOps } from "./lib/proposalCreates";
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
  /** Packaging by the adapter's own signals: several Volumes, a line shape, a line word. */
  packaged: boolean;
  line: Line | null;
  /** The Volumes the source says it collects: shown to the member, never applied. */
  statedRange: { from: string; to: string } | null;
  isBox: boolean;
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

const lineOf = (packaging: Packaging | undefined): Line | null =>
  packaging?.lineName ? { name: packaging.lineName, position: packaging.linePosition } : null;

/** A label that names one numbered Volume ("4", "7.5"): no words, no range. */
const PLAIN_LABEL = /^\d+(?:\.\d+)?$/;

/** Read the observation's snapshot, or null for a shape no adapter here writes. */
async function bookFacts(ctx: QueryCtx, observation: Doc<"sourceObservations">): Promise<BookFacts | null> {
  const snapshot: HeldSnapshot | null = observation.snapshot ?? null;
  switch (snapshot?.kind) {
    case "olEdition": {
      const packaged =
        snapshot.multiVolume || snapshot.packaging !== undefined || needsEditionLine(snapshot.title);
      const elsewhere =
        snapshot.isbn13 !== undefined ? await outOfScopeElsewhere(ctx, snapshot.isbn13) : null;
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        label: packaged ? null : (await resolveBaseSeries(ctx, snapshot)).volumeLabel,
        packaged,
        line: lineOf(snapshot.packaging),
        statedRange: snapshot.packaging?.coverRange ?? null,
        isBox: parseBookTitle(snapshot.title).isBox,
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
      const packaged = snapshot.multi || snapshot.editionLineHint;
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: page?.isbn13 ?? snapshot.isbn13,
        isbn10: page?.isbn10,
        label: packaged ? null : (snapshot.label ?? null),
        packaged,
        line: packaged ? packagingOf(snapshot) : null,
        statedRange: snapshot.coverRange ?? null,
        isBox: parseBookTitle(snapshot.title).isBox,
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
      const packaged =
        snapshot.multiVolume || snapshot.packaging !== undefined || needsEditionLine(snapshot.title);
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        isbn10: snapshot.isbn10,
        label: packaged ? null : (await resolveBaseSeries(ctx, snapshot)).volumeLabel,
        packaged,
        line: lineOf(snapshot.packaging),
        statedRange: snapshot.packaging?.coverRange ?? null,
        isBox: snapshot.isBox === true,
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
      const packaged = snapshot.packaging !== undefined || needsEditionLine(snapshot.title);
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        label: packaged ? null : (snapshot.volumeLabel ?? null),
        packaged,
        line: lineOf(snapshot.packaging),
        statedRange: snapshot.packaging?.coverRange ?? null,
        isBox: snapshot.isBox === true,
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
      const packaged = snapshot.packaging !== undefined || needsEditionLine(snapshot.title);
      return {
        title: snapshot.title,
        url: snapshot.url,
        isbn13: snapshot.isbn13,
        label: packaged ? null : (snapshot.volumeLabel ?? null),
        packaged,
        line: lineOf(snapshot.packaging),
        statedRange: snapshot.packaging?.coverRange ?? null,
        isBox: false,
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

/**
 * Whether the held book can be prepared: a `volumeMissing` or `packaging`
 * hold naming an active, unlocked Series, a snapshot this module reads, in
 * scope by its adapter's checks, not a box set, an ISBN no active Release
 * holds, and a publisher that resolves to a Publisher row.
 */
async function preparable(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
): Promise<{ ok: true; book: Preparable } | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason });
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

/** The single Volume an ordinary book covers, or null when the member must state its coverage. */
function singleVolume(facts: BookFacts): string | null {
  if (facts.packaged || facts.line !== null || facts.label === null) return null;
  const label = canonicalLabel(facts.label);
  return PLAIN_LABEL.test(label) ? label : null;
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

/** The observation's Proposal while it is still a Draft or in review. */
async function openProposal(
  ctx: QueryCtx,
  observation: Doc<"sourceObservations">,
): Promise<Doc<"proposals"> | null> {
  if (observation.queuedProposalId === undefined) return null;
  const proposal = await ctx.db.get(observation.queuedProposalId);
  return proposal?.state === "draft" || proposal?.state === "inReview" ? proposal : null;
}

/**
 * "Prepare placement" on a Held Book (Data Team): open the book's Draft or
 * Proposal when one exists, else say why the book cannot be prepared, else
 * write a Draft authored by the member, citing the observation, prefilled
 * as the module comment says. A repeat or a replay opens the same Draft.
 */
export const preparePlacement = mutation({
  args: { observationId: v.id("sourceObservations") },
  handler: async (ctx, { observationId }) => {
    const user = await requireDataTeam(ctx);
    const observation = await ctx.db.get(observationId);
    if (observation === null) return fail("notFound", "No such observation.");
    const open = await openProposal(ctx, observation);
    if (open !== null) return { status: "existing" as const, proposalId: open._id };
    const check = await preparable(ctx, observation);
    if (!check.ok) return { status: "unavailable" as const, reason: check.reason };
    const { series, facts } = check.book;
    const single = singleVolume(facts);
    const ops = await placementOps(ctx, check.book, single !== null ? { labels: [single] } : "pending", facts.line);
    // A stated coverage is checked now; an unstated one is refused at submission.
    if (single !== null) await planCreateOps(ctx, ops);
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
function placedBy(ops: Doc<"proposalVersions">["ops"]): Placed | null {
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
 * Volumes, first to last, or Unmapped Packaging under its line), its Edition
 * Line, and its comment. The ops are rebuilt from the observation against
 * today's records, so this also brings a Draft whose Volumes moved up to
 * date; any Volume of the range the Series lacks is created on approval.
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
    const check = await preparable(ctx, observation);
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
    await planCreateOps(ctx, ops);
    await ctx.db.patch(proposal._id, {
      draft: { ops, evidence: proposal.draft.evidence, comment: args.comment.trim() },
    });
    return null;
  },
});

/**
 * The placement part of the Proposal page, for ops that place a held book:
 * what the observation says beside what the ops create under the Series —
 * the Volumes covered (those approval creates marked), the Edition's line
 * and coverage (`pending` while unstated), and the Release.
 */
export async function placementView(ctx: QueryCtx, ops: Doc<"proposalVersions">["ops"]) {
  const placed = placedBy(ops);
  if (placed === null) return null;
  const observation = await ctx.db.get(placed.observationId);
  const facts = observation !== null ? await bookFacts(ctx, observation) : null;
  const created = new Map<string, string | null>();
  let edition: Record<string, unknown> = {};
  let release: Record<string, unknown> = {};
  let newLine: string | null = null;
  for (const op of ops) {
    if (op.kind !== "create") continue;
    if (op.table === "volumes") created.set(op.tempId, op.fields?.label ?? null);
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
    volumes.push({ label: volume?.label ?? null, created: false });
  }
  // The Edition's line: a stored one by ID, or the one these ops create.
  const lineId =
    typeof edition.editionLineId === "string" ? ctx.db.normalizeId("editionLines", edition.editionLineId) : null;
  const lineName =
    lineId !== null ? ((await ctx.db.get(lineId))?.name ?? null) : edition.editionLineId !== undefined ? newLine : null;
  const series = await ctx.db.get(placed.seriesId);
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
            ordinary: singleVolume(facts) !== null,
          },
    series: series !== null ? { publicId: series.publicId, title: series.title } : null,
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
