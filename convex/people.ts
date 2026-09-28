// Authors: who made each Series, and every Series an author made. Credits
// come from the Anime News Network Encyclopedia's staff rows (task + a
// stable person id), which the ANN importer stores on its manga
// observations (lib/ann.ts `credits`). `rebuild` derives `people` and
// `seriesCredits` from those observations on a schedule, like the Series
// library's stats: the importers' write paths stay untouched, and a Series
// merge or split carries its credits along because it relinks the
// observation. ANN's terms ask for credit and a link to its Encyclopedia
// page wherever person details show (`annPersonUrl`).

import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { AnnCredit } from "./lib/ann";
import { allocatePublicId } from "./lib/publicIds";

export type CreditRole = Doc<"seriesCredits">["role"];

/** Display order of roles on a Series: the makers first, the source after. */
export const ROLE_ORDER: ReadonlyArray<CreditRole> = ["story_art", "story", "art", "original"];

/**
 * The role an ANN staff task credits, or null for tasks that don't make
 * someone an author of the Series here (character design, concept art).
 * ANN's manga staff lists no translators or letterers.
 */
export function roleFor(task: string): CreditRole | null {
  const t = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (t === "story & art" || t === "story and art") return "story_art";
  if (t === "story") return "story";
  if (t === "art") return "art";
  if (/^original (creator|story|work|concept)$/.test(t)) return "original";
  return null;
}

/** An author's Encyclopedia page, which author pages credit and link. */
export function annPersonUrl(annId: string): string {
  return `https://www.animenewsnetwork.com/encyclopedia/people.php?id=${annId}`;
}

// ---------- Rebuild (scheduled) ----------

/** ANN manga observations per mutation; each credits a few people. */
const CREDIT_BATCH = 100;
/** People per stats mutation; each reads its credits, Series, and stats. */
const STATS_BATCH = 100;
/** Stale credit rows deleted per sweep mutation. */
const SWEEP_BATCH = 500;
/** Credits read per author: far past the most prolific author's count. */
const CREDITS_PER_PERSON = 1000;
/** Credits read per Series: a handful in practice. */
const CREDITS_PER_SERIES = 50;

/**
 * Rebuild every Series credit from the stored ANN manga observations, sweep
 * credits no observation still gives, then refresh each author's derived
 * counts and jacket. Idempotent and safe beside an overlapping run (stamps
 * only move forward). Runs every six hours (crons.ts); by hand:
 * `npx convex run people:rebuild`.
 */
export const rebuild = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    let after: string | null = null;
    let credits = 0;
    for (;;) {
      const batch: { next: string | null; credits: number } = await ctx.runMutation(
        internal.people.creditBatch,
        { after, rebuiltAt: startedAt },
      );
      credits += batch.credits;
      if (batch.next === null) break;
      after = batch.next;
    }
    let swept = 0;
    for (;;) {
      const n: number = await ctx.runMutation(internal.people.sweepCredits, { before: startedAt });
      swept += n;
      if (n < SWEEP_BATCH) break;
    }
    let people = 0;
    let afterPublicId: number | null = null;
    for (;;) {
      const batch: { next: number | null; count: number } = await ctx.runMutation(
        internal.people.statsBatch,
        { afterPublicId },
      );
      people += batch.count;
      if (batch.next === null) break;
      afterPublicId = batch.next;
    }
    return { credits, swept, people, ms: Date.now() - startedAt };
  },
});

/** Credit a batch of ANN manga observations, by source record id. */
export const creditBatch = internalMutation({
  args: { after: v.union(v.string(), v.null()), rebuiltAt: v.number() },
  handler: async (ctx, { after, rebuiltAt }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", "ann")
          .gt("sourceRecordId", after ?? "manga:")
          .lt("sourceRecordId", "manga;"),
      )
      .take(CREDIT_BATCH);
    let credits = 0;
    for (const observation of docs) {
      credits += await creditObservation(ctx, observation, rebuiltAt);
    }
    const last = docs.at(-1);
    return { next: docs.length < CREDIT_BATCH || !last ? null : last.sourceRecordId, credits };
  },
});

/**
 * Stamp the credits one observation gives its Series (followed through any
 * merge to the survivor). Snapshots stored before the importer kept credits
 * give none until ANN's next sync rewrites them.
 */
async function creditObservation(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  rebuiltAt: number,
): Promise<number> {
  const snapshot = observation.snapshot as { credits?: AnnCredit[] } | null;
  if (observation.withdrawn || observation.recordRef?.type !== "series" || !snapshot?.credits) {
    return 0;
  }
  // Follow a merged Series to its survivor (cycle-guarded).
  let series = await ctx.db.get(observation.recordRef.id as Id<"series">);
  const seen = new Set<Id<"series">>();
  while (series?.status === "merged" && series.mergedIntoId && !seen.has(series._id)) {
    seen.add(series._id);
    series = await ctx.db.get(series.mergedIntoId);
  }
  if (!series || series.status !== "active") return 0;
  const existing = await ctx.db
    .query("seriesCredits")
    .withIndex("by_series", (q) => q.eq("seriesId", series._id))
    .take(CREDITS_PER_SERIES);
  let count = 0;
  for (const credit of snapshot.credits) {
    const role = roleFor(credit.task);
    if (!role) continue;
    const personId = await upsertPerson(ctx, credit);
    const row = existing.find((c) => c.personId === personId && c.role === role);
    if (row) {
      if (row.rebuiltAt < rebuiltAt) await ctx.db.patch(row._id, { rebuiltAt });
    } else {
      const id = await ctx.db.insert("seriesCredits", {
        seriesId: series._id,
        personId,
        role,
        rebuiltAt,
      });
      existing.push({ _id: id, _creationTime: 0, seriesId: series._id, personId, role, rebuiltAt });
    }
    count++;
  }
  return count;
}

/** The author row for an ANN person id, created or renamed to ANN's spelling. */
async function upsertPerson(ctx: MutationCtx, credit: AnnCredit): Promise<Id<"people">> {
  const person = await ctx.db
    .query("people")
    .withIndex("by_annId", (q) => q.eq("annId", credit.personId))
    .unique();
  if (person) {
    if (person.name !== credit.name) await ctx.db.patch(person._id, { name: credit.name });
    return person._id;
  }
  return await ctx.db.insert("people", {
    publicId: await allocatePublicId(ctx, "person"),
    name: credit.name,
    annId: credit.personId,
    seriesCount: 0,
    coverUrl: null,
    coverIsbn: null,
  });
}

/** Credits this run did not stamp: no observation gives them any more. */
export const sweepCredits = internalMutation({
  args: { before: v.number() },
  handler: async (ctx, { before }) => {
    const stale = await ctx.db
      .query("seriesCredits")
      .withIndex("by_rebuiltAt", (q) => q.lt("rebuiltAt", before))
      .take(SWEEP_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

/**
 * Refresh a batch of authors' derived facts: how many visible Series they
 * are credited on, and the jacket of the biggest one (most Volumes).
 */
export const statsBatch = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()) },
  handler: async (ctx, { afterPublicId }) => {
    const docs = await ctx.db
      .query("people")
      .withIndex("by_publicId", (q) =>
        afterPublicId === null ? q : q.gt("publicId", afterPublicId),
      )
      .take(STATS_BATCH);
    for (const person of docs) {
      const shelf = await visibleSeriesOf(ctx, person._id);
      const biggest = shelf.reduce<(typeof shelf)[number] | null>(
        (best, entry) =>
          (entry.stats?.volumeCount ?? 0) > (best?.stats?.volumeCount ?? -1) ? entry : best,
        null,
      );
      const facts = {
        seriesCount: shelf.length,
        coverUrl: biggest?.stats?.coverUrl ?? null,
        coverIsbn: biggest?.stats?.coverIsbn ?? null,
      };
      if (
        facts.seriesCount !== person.seriesCount ||
        facts.coverUrl !== person.coverUrl ||
        facts.coverIsbn !== person.coverIsbn
      ) {
        await ctx.db.patch(person._id, facts);
      }
    }
    const last = docs.at(-1);
    return { next: docs.length < STATS_BATCH || !last ? null : last.publicId, count: docs.length };
  },
});

// ---------- Reads ----------

/**
 * The Series an author is credited on that public pages show (active, not
 * bookless), each with its roles and Series library row (null until the
 * library rebuild has seen it).
 */
async function visibleSeriesOf(ctx: QueryCtx, personId: Id<"people">) {
  const credits = await ctx.db
    .query("seriesCredits")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(CREDITS_PER_PERSON);
  const roles = new Map<Id<"series">, CreditRole[]>();
  for (const credit of credits) {
    roles.set(credit.seriesId, [...(roles.get(credit.seriesId) ?? []), credit.role]);
  }
  const shelf = await Promise.all(
    [...roles].map(async ([seriesId, seriesRoles]) => {
      const series = await ctx.db.get(seriesId);
      if (!series || series.status !== "active" || series.bookless) return null;
      const stats = await ctx.db
        .query("seriesStats")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .first();
      const ordered = ROLE_ORDER.filter((role) => seriesRoles.includes(role));
      return { series, stats, roles: ordered };
    }),
  );
  return shelf.flatMap((entry) => (entry ? [entry] : []));
}

/**
 * A Series' authors for its byline, makers first: `{ publicId, name, role }`
 * per credit. Shared by the Series, Volume, and Edition pages.
 */
export async function creditsFor(ctx: QueryCtx, seriesId: Id<"series">) {
  const credits = await ctx.db
    .query("seriesCredits")
    .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
    .take(CREDITS_PER_SERIES);
  const rows = await Promise.all(
    credits.map(async (credit) => {
      const person = await ctx.db.get(credit.personId);
      return person ? { publicId: person.publicId, name: person.name, role: credit.role } : null;
    }),
  );
  return rows
    .flatMap((row) => (row ? [row] : []))
    .sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name),
    );
}

/**
 * The author page (`/author/{id}/{slug}`): the author, a link to their ANN
 * Encyclopedia page, and every Series they are credited on, latest release
 * first, each with its roles and library card facts. Null for an unknown id.
 */
export const authorPage = query({
  args: { publicId: v.number() },
  handler: async (ctx, { publicId }) => {
    const person = await ctx.db
      .query("people")
      .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
      .unique();
    if (!person) return null;
    const shelf = await visibleSeriesOf(ctx, person._id);
    const series = shelf
      .map(({ series, stats, roles }) => ({
        publicId: series.publicId,
        title: series.title,
        roles,
        sourceStatus: series.sourceStatus ?? null,
        coverUrl: stats?.coverUrl ?? null,
        coverIsbn: stats?.coverIsbn ?? null,
        volumeCount: stats?.volumeCount ?? 0,
        publishers: stats?.publishers ?? [],
        firstReleaseSort: stats?.firstReleaseSort ?? 0,
        latestReleaseSort: stats?.latestReleaseSort ?? 0,
      }))
      .sort((a, b) => b.latestReleaseSort - a.latestReleaseSort || a.title.localeCompare(b.title));
    return {
      author: { publicId: person.publicId, name: person.name, annUrl: annPersonUrl(person.annId) },
      series,
    };
  },
});

/**
 * The Authors tab (`/authors`): authors with at least one visible Series,
 * the most prolific first, a page at a time.
 */
export const authors = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db
      .query("people")
      .withIndex("by_seriesCount", (q) => q.gt("seriesCount", 0))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((person) => ({
        publicId: person.publicId,
        name: person.name,
        seriesCount: person.seriesCount,
        coverUrl: person.coverUrl,
        coverIsbn: person.coverIsbn,
      })),
    };
  },
});
