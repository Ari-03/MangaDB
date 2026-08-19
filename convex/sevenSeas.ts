// The Seven Seas adapter (ticket #34, spec §6/§7) — the import pipeline
// proven end to end on one source. The sync action pages through the WP
// REST catalog (`wp/v2/books`) using `modified_gmt` as the change signal,
// fetches the book page for new/changed records, normalizes it
// (lib/sevenSeas.ts), and hands each snapshot to `applyBook`:
//
//   observation upsert (latest snapshot + append-only history)
//     → matching ladder (① stored link · ② ISBN-13 + title sanity · ⑤ create)
//     → system-authored, immediately approved Proposal that creates
//       Series/Volume/Edition/Release, with public importer-authored
//       Revisions citing the source name + record URL
//     → in steady state, a brand-new Series or multi-Volume Coverage queues
//       an In-Review Proposal instead; in Bootstrap Mode those records are
//       created directly and tagged bootstrap-unreviewed (spec §7).
//
// Covers land in Convex file storage as {storageId, sourceUrl, attribution}.
// Rungs ③/④ of the matching ladder (publisher+title+label, title-only)
// become meaningful once a second source can observe records this source
// created; they arrive with the Kodansha adapter.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { getBootstrapMode, getSourceByKey } from "./importSources";
import { getObservation, upsertObservation } from "./lib/observations";
import { allocatePublicId } from "./lib/publicIds";
import {
  bookSnapshotValidator,
  isMangaBook,
  normalizeBook,
  parseBookListing,
  parseBookPage,
  type BookSnapshot,
} from "./lib/sevenSeas";
import { sameValue } from "./lib/values";

export const SOURCE_KEY = "sevenseas";
const BASE_URL = "https://sevenseasentertainment.com";
const PUBLISHER = { name: "Seven Seas Entertainment", slug: "seven-seas" };
const SOURCE_AUTHOR = { kind: "source" as const, sourceKey: SOURCE_KEY };
const IMPORT_COMMENT = "Imported from Seven Seas Entertainment.";

// ---------- the sync action ----------

const USER_AGENT =
  "MangaDB importer (+https://mangadb.org; data corrections welcome)";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Polite fetch: pause first, then up to 3 attempts with exponential backoff. */
async function politeFetch(url: string, delayMs: number): Promise<Response> {
  await sleep(delayMs);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      // Client errors won't heal on retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      completeSweep: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One Seven Seas import run. Defaults suit the daily cadence: a full
 * listing sweep (~65 pages of 100) with a bounded number of book-page
 * detail fetches, so the initial backfill converges over repeated runs
 * (modified-desc ordering surfaces new/changed books first) while a
 * steady-state run does the sweep plus a handful of detail fetches.
 *
 *   npx convex run sevenSeas:sync '{"maxDetailFetches":50}'
 */
export const sync = internalAction({
  args: {
    /** Cap listing pages (an uncapped sweep is what enables withdrawal). */
    maxListingPages: v.optional(v.number()),
    /** Cap book-page fetches per run; skipped books wait for the next run. */
    maxDetailFetches: v.optional(v.number()),
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** Re-fetch details even for observations whose modified_gmt is unchanged. */
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        'The approved-source registry has no "sevenseas" row. Run: npx convex run importSources:seedRegistry \'{}\'',
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const runId: Id<"importRuns"> = await ctx.runMutation(
      internal.imports.startRun,
      { sourceKey: SOURCE_KEY },
    );
    const runStartedAt = Date.now();
    const delay = args.politeDelayMs ?? 350;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;
    let completeSweep = true;

    try {
      let page = 1;
      let totalPages = 1;
      let detailBudget = args.maxDetailFetches ?? 200;

      while (page <= totalPages) {
        if (args.maxListingPages !== undefined && page > args.maxListingPages) {
          completeSweep = false;
          break;
        }
        const res = await politeFetch(
          `${BASE_URL}/wp-json/wp/v2/books?per_page=100&page=${page}&orderby=modified&order=desc`,
          delay,
        );
        totalPages = Number(res.headers.get("x-wp-totalpages")) || totalPages;
        const items = (await res.json()) as unknown[];

        for (const raw of items) {
          const listing = parseBookListing(raw);
          if (!listing) continue;
          // Cheap out-of-catalog filter (light novels, audiobooks) on the
          // title discriminator; the page's Format line is the backstop.
          if (!isMangaBook({ title: listing.title })) continue;
          seen++;

          const note = await ctx.runMutation(internal.sevenSeas.noteListing, {
            sourceRecordId: listing.sourceRecordId,
            modifiedGmt: listing.modifiedGmt,
            force: args.force ?? false,
          });
          if (!note.needsDetail) continue;
          if (detailBudget <= 0) {
            completeSweep = false;
            continue;
          }
          detailBudget--;

          try {
            const pageRes = await politeFetch(listing.url, delay);
            const details = parseBookPage(await pageRes.text());
            const snapshot = normalizeBook(listing, details);
            if (!isMangaBook({ category: snapshot.category, title: snapshot.title })) {
              continue;
            }

            const result = await ctx.runMutation(internal.sevenSeas.applyBook, {
              sourceRecordId: listing.sourceRecordId,
              snapshot,
            });
            if (result.changed) changed++;
            if (result.status === "needsReview") {
              errors.push(`review ${listing.slug}: ${result.reason ?? "conflict"}`);
            }

            if (result.coverNeeded && result.releaseId && snapshot.coverUrl) {
              try {
                const imgRes = await politeFetch(snapshot.coverUrl, delay);
                const storageId = await ctx.storage.store(await imgRes.blob());
                await ctx.runMutation(internal.sevenSeas.attachCover, {
                  releaseId: result.releaseId,
                  storageId,
                  sourceUrl: snapshot.coverUrl,
                  attribution: source.attribution ?? PUBLISHER.name,
                });
              } catch (e) {
                errors.push(`cover ${listing.slug}: ${errorMessage(e)}`);
              }
            }
          } catch (e) {
            errors.push(`book ${listing.slug}: ${errorMessage(e)}`);
          }
        }
        page++;
      }

      // Disappearance → withdrawn, only after a COMPLETE sweep (absence is
      // never evidence on a partial one). Failed individual books are safe:
      // noteListing already bumped their observations.
      if (completeSweep) {
        await ctx.runMutation(internal.imports.markWithdrawn, {
          sourceKey: SOURCE_KEY,
          notSeenSince: runStartedAt,
        });
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        completeSweep,
        errorCount: errors.length,
      };
    } catch (e) {
      errors.push(errorMessage(e));
      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: "failed",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        completeSweep: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- listing bookkeeping ----------

/**
 * Note one listing hit: presence in the listing bumps last-seen (unchanged
 * fetches bump last-seen ONLY — spec §6); the stored snapshot's
 * modified_gmt decides whether the book page is worth fetching.
 */
export const noteListing = internalMutation({
  args: {
    sourceRecordId: v.string(),
    modifiedGmt: v.string(),
    force: v.boolean(),
  },
  handler: async (ctx, { sourceRecordId, modifiedGmt, force }) => {
    const obs = await getObservation(ctx, SOURCE_KEY, sourceRecordId);
    if (!obs) return { needsDetail: true };
    await ctx.db.patch(obs._id, { lastSeenAt: Date.now(), withdrawn: false });
    const stored = (obs.snapshot as Partial<BookSnapshot> | null)?.modifiedGmt;
    return { needsDetail: force || stored !== modifiedGmt };
  },
});

// ---------- applying one book ----------

type ApplyResult = {
  status:
    | "unchanged"
    | "created"
    | "updated"
    | "linked"
    | "queued"
    | "alreadyQueued"
    | "needsReview"
    | "recordOnly";
  changed: boolean;
  releaseId?: Id<"releases">;
  coverNeeded?: boolean;
  reason?: string;
};

/** Full-precision partial date with its yyyymmdd sort key (spec §8). */
function toPartialDate(date: { year: number; month: number; day: number }) {
  return { ...date, sort: date.year * 10000 + date.month * 100 + date.day };
}

/** "1–3" → [1, 2, 3]; a plain or fractional label → itself alone. */
function coveredLabels(label: string | undefined): string[] {
  if (label === undefined) return [];
  const range = /^(\d+)–(\d+)$/.exec(label);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to > from && to - from < 20) {
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
    }
  }
  return [label];
}

/** Loose title-similarity sanity check for the ISBN rung (spec §6). */
export function titlesSimilar(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return true;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.5;
}

async function latestRevisionId(
  ctx: MutationCtx,
  type: "release",
  id: Id<"releases">,
): Promise<{ id: Id<"revisions"> | null; seq: number }> {
  const latest = await ctx.db
    .query("revisions")
    .withIndex("by_record", (q) => q.eq("ref.type", type).eq("ref.id", id as never))
    .order("desc")
    .first();
  return { id: latest?._id ?? null, seq: latest?.seq ?? 0 };
}

/** Is this observation already waiting in the review queue? */
async function hasQueuedProposal(
  ctx: MutationCtx,
  observationId: Id<"sourceObservations">,
): Promise<boolean> {
  const pending = await ctx.db
    .query("proposals")
    .withIndex("by_state", (q) => q.eq("state", "inReview"))
    .collect();
  for (const proposal of pending) {
    const version = await ctx.db
      .query("proposalVersions")
      .withIndex("by_proposal", (q) =>
        q.eq("proposalId", proposal._id).eq("versionNo", proposal.currentVersionNo),
      )
      .unique();
    const cited = version?.evidence.some(
      (e) => e.kind === "observation" && e.observationId === observationId,
    );
    if (cited) return true;
  }
  return false;
}

/**
 * Reconcile one normalized book snapshot into the canonical catalog. One
 * atomic mutation per record (spec §6): the observation write, the match,
 * and the proposal/revision/record writes commit together or not at all.
 */
export const applyBook = internalMutation({
  args: { sourceRecordId: v.string(), snapshot: bookSnapshotValidator },
  handler: async (ctx, { sourceRecordId, snapshot }): Promise<ApplyResult> => {
    const now = Date.now();
    const source = await getSourceByKey(ctx, SOURCE_KEY);
    const sourceName = source?.name ?? PUBLISHER.name;
    const citation = { sourceName, url: snapshot.url };

    const { observation, changed } = await upsertObservation(ctx, {
      sourceKey: SOURCE_KEY,
      sourceRecordId,
      snapshot,
      now,
    });

    // Rung ①: stored source-id link. A rename at the source is then a field
    // conflict on the linked record, never a failed match.
    if (observation.recordRef?.type === "release") {
      const release = await ctx.db.get(observation.recordRef.id);
      if (!release || release.status !== "active" || release.locked) {
        return { status: "recordOnly", changed: false };
      }
      if (!changed && release.coverImage) {
        return { status: "unchanged", changed: false };
      }
      return await applyLinkedUpdate(ctx, { release, snapshot, citation });
    }

    // Rung ②: ISBN-13 exact with a title-similarity sanity check. Ambiguity
    // or a failed check queues for humans — the importer never merges.
    if (snapshot.isbn13 !== undefined) {
      const byIsbn = await ctx.db
        .query("releases")
        .withIndex("by_isbn13", (q) => q.eq("isbn13", snapshot.isbn13))
        .first();
      if (byIsbn && byIsbn.status === "active") {
        const seriesTitles: string[] = [];
        for (const seriesId of byIsbn.seriesIds) {
          const series = await ctx.db.get(seriesId);
          if (series) seriesTitles.push(series.title);
        }
        if (seriesTitles.some((t) => titlesSimilar(t, snapshot.seriesTitle))) {
          await ctx.db.patch(observation._id, {
            recordRef: { type: "release", id: byIsbn._id },
          });
          const firstSeriesId = byIsbn.seriesIds[0];
          if (firstSeriesId !== undefined) {
            await linkSeriesObservation(ctx, snapshot, firstSeriesId, now);
          }
          return { status: "linked", changed: true, releaseId: byIsbn._id };
        }
        return {
          status: "needsReview",
          changed: false,
          reason: `ISBN ${snapshot.isbn13} matches an existing release with a dissimilar title`,
        };
      }
    }

    // Series link (rung ① for the series concept, keyed on the source's own
    // series slug); then the creation path (rung ⑤).
    const seriesObs = await getObservation(
      ctx,
      SOURCE_KEY,
      `series:${snapshot.seriesSlug}`,
    );
    let seriesId: Id<"series"> | null = null;
    if (seriesObs?.recordRef?.type === "series") {
      const series = await ctx.db.get(seriesObs.recordRef.id);
      if (series && series.status === "active") seriesId = series._id;
    }

    const labels = coveredLabels(snapshot.volumeLabel);
    const multiVolume = labels.length > 1;
    const bootstrap = await getBootstrapMode(ctx);

    // Steady-state creation boundaries (spec §6): a single-Volume Release
    // under an already-linked Series auto-creates; a brand-new Series or
    // multi-Volume Coverage always queues, pre-filled so a correct guess is
    // one click. Bootstrap Mode lifts both gates (spec §7).
    const wouldQueue = seriesId === null || multiVolume;
    if (wouldQueue && !bootstrap) {
      if (await hasQueuedProposal(ctx, observation._id)) {
        return { status: "alreadyQueued", changed: false };
      }
      await queueCreationProposal(ctx, {
        observationId: observation._id,
        snapshot,
        seriesId,
        labels,
        now,
      });
      return { status: "queued", changed: true };
    }

    return await createCanonicalRecords(ctx, {
      observation,
      snapshot,
      seriesId,
      labels,
      citation,
      // Tag exactly what steady state would have queued (spec §7).
      tagBootstrapUnreviewed: bootstrap && wouldQueue,
      now,
    });
  },
});

// ---------- the creation path ----------

async function ensurePublisher(
  ctx: MutationCtx,
): Promise<{ id: Id<"publishers">; created: boolean }> {
  const existing = await ctx.db
    .query("publishers")
    .withIndex("by_slug", (q) => q.eq("slug", PUBLISHER.slug))
    .unique();
  if (existing) return { id: existing._id, created: false };
  const id = await ctx.db.insert("publishers", {
    status: "active",
    name: PUBLISHER.name,
    slug: PUBLISHER.slug,
  });
  return { id, created: true };
}

async function linkSeriesObservation(
  ctx: MutationCtx,
  snapshot: BookSnapshot,
  seriesId: Id<"series">,
  now: number,
) {
  const { observation } = await upsertObservation(ctx, {
    sourceKey: SOURCE_KEY,
    sourceRecordId: `series:${snapshot.seriesSlug}`,
    snapshot: {
      kind: "series",
      title: snapshot.seriesTitle,
      url: snapshot.seriesUrl,
    },
    now,
  });
  if (!observation.recordRef) {
    await ctx.db.patch(observation._id, {
      recordRef: { type: "series", id: seriesId },
    });
  }
}

type CreatedRecord = {
  ref: { type: "publisher" | "series" | "volume" | "edition" | "release"; id: string };
  table: string;
  fields: Record<string, unknown>;
};

async function createCanonicalRecords(
  ctx: MutationCtx,
  args: {
    observation: Doc<"sourceObservations">;
    snapshot: BookSnapshot;
    seriesId: Id<"series"> | null;
    labels: string[];
    citation: { sourceName: string; url: string };
    tagBootstrapUnreviewed: boolean;
    now: number;
  },
): Promise<ApplyResult> {
  const { snapshot, labels, now } = args;
  const tag = args.tagBootstrapUnreviewed ? { bootstrapUnreviewed: true } : {};
  const created: CreatedRecord[] = [];

  const publisher = await ensurePublisher(ctx);
  if (publisher.created) {
    created.push({
      ref: { type: "publisher", id: publisher.id },
      table: "publishers",
      fields: { name: PUBLISHER.name, slug: PUBLISHER.slug },
    });
  }

  let seriesId = args.seriesId;
  if (seriesId === null) {
    const publicId = await allocatePublicId(ctx, "series");
    const fields = {
      title: snapshot.seriesTitle,
      altTitles: [] as string[],
    };
    seriesId = await ctx.db.insert("series", {
      status: "active",
      ...tag,
      publicId,
      ...fields,
      searchText: snapshot.seriesTitle,
    });
    created.push({ ref: { type: "series", id: seriesId }, table: "series", fields });
    await linkSeriesObservation(ctx, snapshot, seriesId, now);
  }

  // Volumes: reuse by exact Label (a second packaging of the same content
  // must not duplicate the Volume); new ones take the numeric label as
  // Position when it is a free integer, else append after the current end.
  const existingVolumes = await ctx.db
    .query("volumes")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId!))
    .collect();
  const taken = new Set(existingVolumes.map((vol) => vol.position));
  let nextAppend = Math.max(0, ...existingVolumes.map((vol) => vol.position)) + 1;
  const volumeIds: Id<"volumes">[] = [];
  const volumeLabels = labels.length > 0 ? labels : [undefined];
  for (const label of volumeLabels) {
    const existing = existingVolumes.find(
      (vol) => (vol.label ?? null) === (label ?? null),
    );
    if (existing) {
      volumeIds.push(existing._id);
      continue;
    }
    const numeric = label !== undefined ? Number(label) : NaN;
    let position: number;
    if (Number.isInteger(numeric) && numeric >= 1 && !taken.has(numeric)) {
      position = numeric;
    } else {
      position = nextAppend++;
      while (taken.has(position)) position = nextAppend++;
    }
    taken.add(position);
    const publicId = await allocatePublicId(ctx, "volume");
    const volumeId = await ctx.db.insert("volumes", {
      status: "active",
      ...tag,
      publicId,
      seriesId,
      position,
      label,
    });
    volumeIds.push(volumeId);
    created.push({
      ref: { type: "volume", id: volumeId },
      table: "volumes",
      fields: { label: label ?? undefined, position },
    });
  }

  const editionPublicId = await allocatePublicId(ctx, "edition");
  const editionId = await ctx.db.insert("editions", {
    status: "active",
    ...tag,
    publicId: editionPublicId,
    publisherId: publisher.id,
  });
  for (const [i, volumeId] of volumeIds.entries()) {
    await ctx.db.insert("volumeCoverages", {
      editionId,
      volumeId,
      order: i + 1,
      extent: "complete",
    });
  }
  created.push({
    ref: { type: "edition", id: editionId },
    table: "editions",
    fields: {
      volumeCoverage: volumeIds.map((id, i) => ({
        volumeId: id,
        order: i + 1,
        extent: "complete",
      })),
    },
  });

  const releaseFields = {
    format: "physical" as const,
    binding: snapshot.binding,
    language: "en",
    isbn13: snapshot.isbn13,
    pubDate: snapshot.releaseDate ? toPartialDate(snapshot.releaseDate) : undefined,
    price:
      snapshot.priceCents !== undefined
        ? { amountCents: snapshot.priceCents, currency: snapshot.currency ?? "USD" }
        : undefined,
  };
  const releaseId = await ctx.db.insert("releases", {
    status: "active",
    ...tag,
    editionId,
    ...releaseFields,
    publisherId: publisher.id,
    seriesIds: [seriesId],
  });
  created.push({
    ref: { type: "release", id: releaseId },
    table: "releases",
    fields: releaseFields,
  });

  // The system-authored, immediately approved Proposal (spec §5: imports
  // author Proposals too) and one public Revision per created record,
  // citing the source name + record URL (spec §6 attribution).
  const proposalId = await ctx.db.insert("proposals", {
    author: SOURCE_AUTHOR,
    state: "approved",
    currentVersionNo: 1,
    submittedAt: now,
    decidedAt: now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: created.map((record) => ({
      kind: "create" as const,
      table: record.table,
      tempId: record.ref.type,
      fields: record.fields,
    })),
    evidence: [{ kind: "observation" as const, observationId: args.observation._id }],
    changeComment: IMPORT_COMMENT,
  });
  for (const record of created) {
    await ctx.db.insert("revisions", {
      ref: record.ref as never,
      seq: 1,
      proposalId,
      author: SOURCE_AUTHOR,
      changes: Object.entries(record.fields)
        .filter(([, value]) => value !== undefined)
        .map(([field, after]) => ({ field, after })),
      comment: IMPORT_COMMENT,
      citation: args.citation,
    });
  }

  await ctx.db.patch(args.observation._id, {
    recordRef: { type: "release", id: releaseId },
  });

  return {
    status: "created",
    changed: true,
    releaseId,
    coverNeeded: snapshot.coverUrl !== undefined,
  };
}

// ---------- the steady-state review queue path ----------

/**
 * Queue an In-Review Proposal pre-filled with the parsed guess (spec §5/§6):
 * temp-ID create ops for whatever does not exist yet, evidence citing the
 * observation. The review-queue approval machinery that applies these ops
 * is the next moderation slice; until then the queue is the record.
 */
async function queueCreationProposal(
  ctx: MutationCtx,
  args: {
    observationId: Id<"sourceObservations">;
    snapshot: BookSnapshot;
    seriesId: Id<"series"> | null;
    labels: string[];
    now: number;
  },
): Promise<void> {
  const { snapshot, labels } = args;
  const ops: Array<{
    kind: "create";
    table: string;
    tempId: string;
    fields: unknown;
  }> = [];
  if (args.seriesId === null) {
    ops.push({
      kind: "create",
      table: "series",
      tempId: "series",
      fields: { title: snapshot.seriesTitle, altTitles: [] },
    });
  }
  const volumeTempIds: string[] = [];
  const volumeLabels = labels.length > 0 ? labels : [undefined];
  for (const [i, label] of volumeLabels.entries()) {
    const tempId = `volume-${i + 1}`;
    volumeTempIds.push(tempId);
    ops.push({
      kind: "create",
      table: "volumes",
      tempId,
      fields: { seriesId: args.seriesId ?? "series", label },
    });
  }
  ops.push({
    kind: "create",
    table: "editions",
    tempId: "edition",
    fields: {
      publisherSlug: PUBLISHER.slug,
      volumeCoverage: volumeTempIds.map((tempId, i) => ({
        volume: tempId,
        order: i + 1,
        extent: "complete",
      })),
    },
  });
  ops.push({
    kind: "create",
    table: "releases",
    tempId: "release",
    fields: {
      editionId: "edition",
      format: "physical",
      binding: snapshot.binding,
      language: "en",
      isbn13: snapshot.isbn13,
      pubDate: snapshot.releaseDate ? toPartialDate(snapshot.releaseDate) : undefined,
      price:
        snapshot.priceCents !== undefined
          ? { amountCents: snapshot.priceCents, currency: snapshot.currency ?? "USD" }
          : undefined,
    },
  });

  const proposalId = await ctx.db.insert("proposals", {
    author: SOURCE_AUTHOR,
    state: "inReview",
    currentVersionNo: 1,
    submittedAt: args.now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops,
    evidence: [{ kind: "observation", observationId: args.observationId }],
    changeComment:
      args.seriesId === null
        ? `New series "${snapshot.seriesTitle}" observed at Seven Seas — steady-state creation gate.`
        : `Multi-volume coverage "${snapshot.title}" observed at Seven Seas — steady-state creation gate.`,
  });
}

// ---------- the linked-update path ----------

/**
 * Auto-update the fields this source is authoritative for on its own
 * catalog (spec §6 authority table): date, ISBN, price. Human Overrides are
 * sticky — overridden fields are skipped; the observation itself already
 * records the conflicting value. Less precise data never replaces more
 * precise; this source only ever offers full-precision dates.
 */
async function applyLinkedUpdate(
  ctx: MutationCtx,
  args: {
    release: Doc<"releases">;
    snapshot: BookSnapshot;
    citation: { sourceName: string; url: string };
  },
): Promise<ApplyResult> {
  const { release, snapshot } = args;
  const coverNeeded = !release.coverImage && snapshot.coverUrl !== undefined;

  const offered: Record<string, unknown> = {};
  if (snapshot.isbn13 !== undefined) offered.isbn13 = snapshot.isbn13;
  if (snapshot.releaseDate) offered.pubDate = toPartialDate(snapshot.releaseDate);
  if (snapshot.priceCents !== undefined) {
    offered.price = {
      amountCents: snapshot.priceCents,
      currency: snapshot.currency ?? "USD",
    };
  }

  const overridden = new Set(release.overriddenFields ?? []);
  const changes = Object.entries(offered)
    .filter(([field]) => !overridden.has(field))
    .filter(
      ([field, after]) =>
        !sameValue((release as unknown as Record<string, unknown>)[field], after),
    )
    .map(([field, after]) => ({
      field,
      before: (release as unknown as Record<string, unknown>)[field],
      after,
    }));

  if (changes.length === 0) {
    return {
      status: "recordOnly",
      changed: false,
      releaseId: release._id,
      coverNeeded,
    };
  }

  const latest = await latestRevisionId(ctx, "release", release._id);
  const now = Date.now();
  const proposalId = await ctx.db.insert("proposals", {
    author: SOURCE_AUTHOR,
    state: "approved",
    currentVersionNo: 1,
    submittedAt: now,
    decidedAt: now,
  });
  await ctx.db.insert("proposalVersions", {
    proposalId,
    versionNo: 1,
    ops: [
      {
        kind: "update" as const,
        ref: { type: "release" as const, id: release._id },
        baseRevisionId: latest.id ?? undefined,
        changes,
      },
    ],
    evidence: [],
    changeComment: IMPORT_COMMENT,
  });

  const patch: Record<string, unknown> = {};
  for (const change of changes) patch[change.field] = change.after;
  await ctx.db.patch(release._id, patch as never);

  await ctx.db.insert("revisions", {
    ref: { type: "release", id: release._id } as never,
    seq: latest.seq + 1,
    proposalId,
    author: SOURCE_AUTHOR,
    changes,
    comment: IMPORT_COMMENT,
    citation: args.citation,
  });

  return { status: "updated", changed: true, releaseId: release._id, coverNeeded };
}

// ---------- covers ----------

/**
 * Attach a stored cover: {storageId, sourceUrl, attribution} per spec §6.
 * A racing duplicate or vanished release deletes the fresh blob instead of
 * orphaning it; replacing an outdated source cover deletes the old blob.
 */
export const attachCover = internalMutation({
  args: {
    releaseId: v.id("releases"),
    storageId: v.id("_storage"),
    sourceUrl: v.string(),
    attribution: v.string(),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.status !== "active") {
      await ctx.storage.delete(args.storageId);
      return { attached: false };
    }
    const current = release.coverImage;
    if (current?.sourceUrl === args.sourceUrl) {
      await ctx.storage.delete(args.storageId);
      return { attached: false };
    }
    if (current) await ctx.storage.delete(current.storageId);
    await ctx.db.patch(args.releaseId, {
      coverImage: {
        storageId: args.storageId,
        sourceUrl: args.sourceUrl,
        attribution: args.attribution,
      },
    });
    return { attached: true };
  },
});
