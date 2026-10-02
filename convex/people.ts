// Authors: who made each Series, and every Series an author made. Credits
// come first from the Anime News Network Encyclopedia's staff rows (task +
// a stable person id), which the ANN importer stores on its manga
// observations (lib/ann.ts `credits`). ANN skips entries with no English
// release line, so digital-only and newer Series often have no ANN entry;
// for those, the creator names publishers print on their release
// observations stand in: PRH's free-text `author` line (lib/prh.ts
// parseAuthorCredits, roles where it states them) and, for a Series PRH
// does not credit either, Kodansha's and Seven Seas' `creators` (names
// only, a role-less "author" credit; Kodansha lists the original creator
// first, so PRH's roles are the better publisher source).
//
// `rebuild` derives `people` and `seriesCredits` from the stored
// observations on a schedule, like the Series library's stats, with no
// network, so it works where the importers are disabled: the importers'
// write paths stay untouched, and a Series merge or split carries its
// credits along because it relinks the observations. A Series ANN credits
// takes only ANN's credits, though the source registry ranks Kodansha's
// creators above ANN's: ANN gives every credit a role and a stable person
// id, where Kodansha names only the first creator and no role. When ANN
// starts crediting a Series, the ANN pass deletes its publisher rows; a
// publisher-named person keeps their row (and public id), which ANN adopts
// on matching `nameKey`. Rows from publishers never count as evidence for
// linking ANN entries (lib/matching.ts workMatch). ANN's terms ask for
// credit and a link to its Encyclopedia page wherever its person details
// show (`annPersonUrl`).

import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { annCreditValidator, parseApiResponse, type AnnCredit } from "./lib/ann";
import { politeFetch } from "./lib/http";
import { survivorOf } from "./lib/matching";
import { listed, showMatureArg, visibleTo } from "./lib/mature";
import { isPersonName, parseAuthorCredits, type AuthorCredit } from "./lib/prh";
import { allocatePublicId } from "./lib/publicIds";
import { withExceptionCapture } from "./lib/posthog";

export type CreditRole = Doc<"seriesCredits">["role"];

/**
 * Display order of roles on a Series: the makers first (the role-less
 * "author" a publisher gives after the specific ones), the source after.
 */
export const ROLE_ORDER: ReadonlyArray<CreditRole> = [
  "story_art",
  "story",
  "art",
  "author",
  "original",
];

/**
 * Whether a credit makes someone the Series' maker: they wrote or drew it,
 * or a publisher named them its author. An original creator of a spinoff
 * (Hajime Yatate across Gundam) did neither, so those Series don't count
 * toward how prolific they are.
 */
export const isMaker = (role: CreditRole) => role !== "original";

/**
 * One role for everything sources credit a person with on a Series:
 * writing and drawing together are Story & Art, making it beats only
 * originating it, and the role-less "author" stands only when nothing more
 * specific does.
 */
export function mergeRoles(roles: ReadonlyArray<CreditRole>): CreditRole {
  const has = (role: CreditRole) => roles.includes(role);
  if (has("story_art") || (has("story") && has("art"))) return "story_art";
  if (has("story")) return "story";
  if (has("art")) return "art";
  if (has("original")) return "original";
  return "author";
}

/**
 * A person's name as an identity key (`people.nameKey`): lowercased, Latin
 * accents and punctuation stripped, and its words sorted, so "Eiichirō
 * Oda" is "Eiichiro Oda", "In-Wan Youn" is "Inwan Youn", and "Masamune
 * Shirow" is "Shirow Masamune" (sources disagree on Japanese name order).
 * Punctuation is removed, not spaced, so a hyphenated given name stays one
 * word. Kana keep their voicing marks.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

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
/**
 * Publisher release observations per mutation; each reads its Release and
 * that Release's Series, and the Series' credits once per batch.
 */
const PUBLISHER_BATCH = 200;
/**
 * The sources whose release snapshots name creators, and the `source`
 * marker their credit rows carry. PRH goes first: its parsed line has
 * roles, so a Series it credits in a run takes no role-less `creators`
 * names from Seven Seas or Kodansha (Kodansha print books are
 * PRH-distributed and usually have a PRH line). Literal keys (prh.ts,
 * sevenSeas.ts, kodansha.ts SOURCE_KEY).
 */
const PUBLISHER_SOURCES = [
  { sourceKey: "prh", marker: "prh" },
  { sourceKey: "sevenseas", marker: "creators" },
  { sourceKey: "kodansha", marker: "creators" },
] as const;

/** Which publisher kind wrote a credit row (`seriesCredits.source`); absent for ANN's rows. */
type PublisherMarker = NonNullable<Doc<"seriesCredits">["source"]>;
/** People rows read per name key: two already make a name ambiguous. */
const NAME_MATCHES = 2;
/** People per stats mutation; each reads its credits, Series, and stats. */
const STATS_BATCH = 100;
/** Stale credit rows deleted per sweep mutation. */
const SWEEP_BATCH = 500;
/** Credits read per author: far past the most prolific author's count. */
const CREDITS_PER_PERSON = 1000;
/** Credits read per Series: a handful in practice. */
const CREDITS_PER_SERIES = 50;

/**
 * Rebuild every Series credit from the stored ANN manga observations, then
 * credit the Series ANN did not from the publishers' release observations,
 * sweep credits no observation still gives, then refresh each author's
 * derived counts and jacket. Idempotent and safe beside an overlapping run
 * (stamps only move forward). A failed publisher pass still lets ANN's
 * stale rows be swept and the stats refresh, keeping every publisher row
 * (the pass may not have reached them to restamp), then rethrows. Runs
 * every six hours (crons.ts); by hand: `npx convex run people:rebuild`.
 */
export const rebuild = internalAction({
  args: {},
  handler: async (ctx) =>
    withExceptionCapture("people.rebuild", ctx, async () => {
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
      // After the ANN pass: it decides which Series are ANN's and gives
      // every ANN person a name key for publisher names to match.
      let publisherCredits = 0;
      let publisherError: unknown = null;
      try {
        for (const { sourceKey } of PUBLISHER_SOURCES) {
          let cursor: string | null = null;
          for (;;) {
            const batch: { next: string | null; credits: number } = await ctx.runMutation(
              internal.people.publisherBatch,
              { sourceKey, after: cursor, rebuiltAt: startedAt },
            );
            publisherCredits += batch.credits;
            if (batch.next === null) break;
            cursor = batch.next;
          }
        }
      } catch (error) {
        publisherError = error;
      }
      const annOnly = publisherError !== null;
      let swept = 0;
      for (;;) {
        const n: number = await ctx.runMutation(internal.people.sweepCredits, {
          before: startedAt,
          annOnly,
        });
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
      if (publisherError !== null) throw publisherError;
      return { credits, publisherCredits, swept, people, ms: Date.now() - startedAt };
    }),
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
 * merge to the survivor), and delete the Series' publisher rows once ANN
 * credits it. Snapshots stored before the importer kept credits give none
 * until ANN's next sync rewrites them.
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
    // ANN's own rows only: publisher rows are deleted below.
    const row = existing.find(
      (c) => c.personId === personId && c.role === role && c.source === undefined,
    );
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
  // ANN credits the Series now: its publisher rows go here rather than at
  // the sweep, so no byline shows both meanwhile, and a failed publisher
  // pass (which skips the sweep of publisher rows) can't keep them.
  if (count > 0) {
    for (const row of existing) {
      if (row.source !== undefined) await ctx.db.delete(row._id);
    }
  }
  return count;
}

/**
 * The author row for an ANN person id, renamed to ANN's spelling (and its
 * name key set, which rows from before the key existed lack). A person
 * with no row for the id yet adopts the publisher-named row of the same
 * name key, so their public id stays; otherwise a new row.
 *
 * Adoption goes by name alone, so a different person ANN knows by the same
 * name (a "Kei", a "Fly") inherits the publisher-named person's id and
 * their publisher-credited Series. Publisher names already join ANN people
 * by name the same way (`personNamed`); name matching can't tell
 * namesakes apart, and the risk is highest for short single-word names.
 */
async function upsertPerson(ctx: MutationCtx, credit: AnnCredit): Promise<Id<"people">> {
  const key = nameKey(credit.name);
  const person = await ctx.db
    .query("people")
    .withIndex("by_annId", (q) => q.eq("annId", credit.personId))
    .unique();
  if (person) {
    if (person.name !== credit.name || person.nameKey !== key) {
      await ctx.db.patch(person._id, { name: credit.name, nameKey: key });
    }
    return person._id;
  }
  const named = await ctx.db
    .query("people")
    .withIndex("by_nameKey", (q) => q.eq("nameKey", key))
    .take(NAME_MATCHES);
  const nameOnly = named.find((p) => p.annId === undefined);
  if (nameOnly) {
    await ctx.db.patch(nameOnly._id, { name: credit.name, annId: credit.personId });
    return nameOnly._id;
  }
  return await ctx.db.insert("people", {
    publicId: await allocatePublicId(ctx, "person"),
    name: credit.name,
    annId: credit.personId,
    nameKey: key,
    seriesCount: 0,
    originalCount: 0,
    coverUrl: null,
    coverIsbn: null,
  });
}

/** Per-batch memory, so a Series' many observations cost one look each. */
type PublisherMemo = {
  /** A linked Series id → its active survivor, or null when the merge chain dead-ends or ends hidden. */
  survivors: Map<Id<"series">, Id<"series"> | null>;
  /**
   * An active Series → its credit rows (kept current), or null when it is
   * settled for this source: ANN credited it this run or, for `creators`
   * names, PRH did.
   */
  credits: Map<Id<"series">, Doc<"seriesCredits">[] | null>;
  /** A name key → its person, or null when the name is ambiguous. */
  people: Map<string, Id<"people"> | null>;
};

/**
 * Credit a batch of one publisher's observations, by source record id, to
 * the Series ANN did not credit in this run (`rebuiltAt`).
 */
export const publisherBatch = internalMutation({
  args: { sourceKey: v.string(), after: v.union(v.string(), v.null()), rebuiltAt: v.number() },
  handler: async (ctx, { sourceKey, after, rebuiltAt }) => {
    const source = PUBLISHER_SOURCES.find((s) => s.sourceKey === sourceKey);
    if (!source) throw new Error(`people.publisherBatch: no publisher source "${sourceKey}"`);
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        after === null
          ? q.eq("sourceKey", sourceKey)
          : q.eq("sourceKey", sourceKey).gt("sourceRecordId", after),
      )
      .take(PUBLISHER_BATCH);
    const memo: PublisherMemo = { survivors: new Map(), credits: new Map(), people: new Map() };
    let credits = 0;
    for (const observation of docs) {
      credits += await creditFromPublisher(ctx, observation, source.marker, rebuiltAt, memo);
    }
    const last = docs.at(-1);
    return { next: docs.length < PUBLISHER_BATCH || !last ? null : last.sourceRecordId, credits };
  },
});

/**
 * The credits a publisher's release snapshot names: Kodansha's and Seven
 * Seas' `creators` as role-less authors (only plain person names: not
 * "Various", not an organisation; lib/prh.ts isPersonName), PRH's `author`
 * line parsed. Nothing for any other snapshot (Kodansha's series links,
 * crawl state).
 */
function publisherCredits(snapshot: unknown): AuthorCredit[] {
  const s = snapshot as { kind?: unknown; creators?: unknown; author?: unknown } | null;
  if (s?.kind === "prhTitle") {
    return typeof s.author === "string" ? parseAuthorCredits(s.author) : [];
  }
  if ((s?.kind === "kodanshaVolume" || s?.kind === "book") && Array.isArray(s.creators)) {
    return s.creators
      .filter((name): name is string => typeof name === "string" && isPersonName(name))
      .map((name) => ({ name: name.trim(), role: "author" as const }));
  }
  return [];
}

/**
 * Stamp the credits one publisher observation gives the one active Series
 * its Release belongs to, unless ANN credited that Series in this run (or,
 * for role-less `creators` names, PRH did). Each person keeps one row per
 * Series and marker, its role merged (`mergeRoles`) with what earlier
 * observations of the run stamped, so names union across a Series'
 * volumes. Returns the credits stamped.
 */
async function creditFromPublisher(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  marker: PublisherMarker,
  rebuiltAt: number,
  memo: PublisherMemo,
): Promise<number> {
  if (observation.withdrawn || observation.recordRef?.type !== "release") return 0;
  const named = publisherCredits(observation.snapshot);
  if (named.length === 0) return 0;
  const seriesId = await soleSeriesOf(ctx, observation.recordRef.id, memo);
  if (!seriesId) return 0;
  let rows = memo.credits.get(seriesId);
  if (rows === undefined) {
    const existing = await ctx.db
      .query("seriesCredits")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .take(CREDITS_PER_SERIES);
    const stampedBy = (source: PublisherMarker | undefined) =>
      existing.some((c) => c.source === source && c.rebuiltAt >= rebuiltAt);
    const settled = stampedBy(undefined) || (marker === "creators" && stampedBy("prh"));
    rows = settled ? null : existing;
    memo.credits.set(seriesId, rows);
  }
  if (rows === null) return 0;

  const incoming = new Map<Id<"people">, CreditRole[]>();
  for (const credit of named) {
    const personId = await personNamed(ctx, credit.name, memo);
    if (personId) incoming.set(personId, [...(incoming.get(personId) ?? []), credit.role]);
  }
  let count = 0;
  for (const [personId, roles] of incoming) {
    const mine = rows.filter((c) => c.source === marker && c.personId === personId);
    const stamped = mine.filter((c) => c.rebuiltAt >= rebuiltAt);
    const role = mergeRoles([...roles, ...stamped.map((c) => c.role)]);
    // A role this run stamped earlier that the merge now replaces ("author"
    // from one PRH line beside "story" from another).
    for (const row of stamped.filter((c) => c.role !== role)) {
      await ctx.db.delete(row._id);
      rows.splice(rows.indexOf(row), 1);
    }
    // With nothing stamped yet this run, a row the person already has whose
    // role covers this one (story over author, story_art over story) keeps
    // its id, instead of a lesser row going in now only to be replaced when
    // the observation with the fuller role comes, a batch or more later.
    const row =
      mine.find((c) => c.role === role) ??
      (stamped.length === 0 ? mine.find((c) => mergeRoles([c.role, role]) === c.role) : undefined);
    if (row) {
      if (row.rebuiltAt < rebuiltAt) {
        await ctx.db.patch(row._id, { rebuiltAt });
        row.rebuiltAt = rebuiltAt;
      }
    } else {
      const fields = { seriesId, personId, role, source: marker, rebuiltAt };
      rows.push({ _id: await ctx.db.insert("seriesCredits", fields), _creationTime: 0, ...fields });
    }
    count++;
  }
  return count;
}

/**
 * The one active Series a Release belongs to (both followed through
 * merges), or null when the Release is not active or its Series resolve to
 * none, to a hidden one, or to more than one.
 */
async function soleSeriesOf(
  ctx: MutationCtx,
  releaseId: Id<"releases">,
  memo: PublisherMemo,
): Promise<Id<"series"> | null> {
  const release = await survivorOf<"releases">(ctx, await ctx.db.get(releaseId));
  if (!release || release.status !== "active") return null;
  const found = new Set<Id<"series"> | null>();
  for (const id of release.seriesIds) {
    let survivor = memo.survivors.get(id);
    if (survivor === undefined) {
      const series = await survivorOf<"series">(ctx, await ctx.db.get(id));
      survivor = series?.status === "active" ? series._id : null;
      memo.survivors.set(id, survivor);
    }
    found.add(survivor);
  }
  const [only] = found;
  return found.size === 1 && only ? only : null;
}

/**
 * The person a publisher's name means: the one row with its name key (an
 * ANN person or an earlier publisher name), else a new row without an ANN
 * id. Null when two rows share the key, since the name alone can't say
 * which person it is.
 */
async function personNamed(
  ctx: MutationCtx,
  name: string,
  memo: PublisherMemo,
): Promise<Id<"people"> | null> {
  const key = nameKey(name);
  if (key === "") return null;
  const known = memo.people.get(key);
  if (known !== undefined) return known;
  const rows = await ctx.db
    .query("people")
    .withIndex("by_nameKey", (q) => q.eq("nameKey", key))
    .take(NAME_MATCHES);
  let personId = rows.length === 1 ? rows[0]!._id : null;
  if (rows.length === 0) {
    personId = await ctx.db.insert("people", {
      publicId: await allocatePublicId(ctx, "person"),
      name,
      nameKey: key,
      seriesCount: 0,
      originalCount: 0,
      coverUrl: null,
      coverIsbn: null,
    });
  }
  memo.people.set(key, personId);
  return personId;
}

/**
 * Credits this run did not stamp: no observation gives them any more. Only
 * ANN's rows when `annOnly` (the run's publisher pass failed part-way).
 */
export const sweepCredits = internalMutation({
  args: { before: v.number(), annOnly: v.optional(v.boolean()) },
  handler: async (ctx, { before, annOnly }) => {
    const stale = annOnly
      ? await ctx.db
          .query("seriesCredits")
          .withIndex("by_source_and_rebuiltAt", (q) =>
            q.eq("source", undefined).lt("rebuiltAt", before),
          )
          .take(SWEEP_BATCH)
      : await ctx.db
          .query("seriesCredits")
          .withIndex("by_rebuiltAt", (q) => q.lt("rebuiltAt", before))
          .take(SWEEP_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

/**
 * Refresh a batch of authors' derived facts: how many visible Series they
 * wrote or drew (`isMaker`), how many more they are only the original
 * creator of, the jacket of their biggest (most Volumes), preferring first
 * one that is not a Mature Series and then one they made, and whether every
 * Series they are credited on is mature (`matureOnly`, lib/mature.ts).
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
      const shelf = await visibleSeriesOf(ctx, person._id, true);
      const made = shelf.filter((entry) => entry.roles.some(isMaker));
      const general = (entries: typeof shelf) => entries.filter((entry) => !entry.series.mature);
      // General before made: the general directory lists a mixed-credit
      // author, so a Series they only originated beats a mature one they made.
      const pool = [general(made), general(shelf), made, shelf].find((entries) => entries.length > 0) ?? [];
      const biggest = pool.reduce<(typeof shelf)[number] | null>(
        (best, entry) =>
          (entry.stats?.volumeCount ?? 0) > (best?.stats?.volumeCount ?? -1) ? entry : best,
        null,
      );
      const matureOnly = shelf.length > 0 && general(shelf).length === 0;
      const facts = {
        seriesCount: made.length,
        originalCount: shelf.length - made.length,
        coverUrl: biggest?.stats?.coverUrl ?? null,
        coverIsbn: biggest?.stats?.coverIsbn ?? null,
        matureOnly: matureOnly ? (true as const) : undefined,
      };
      if (
        facts.seriesCount !== person.seriesCount ||
        facts.originalCount !== person.originalCount ||
        facts.coverUrl !== person.coverUrl ||
        facts.coverIsbn !== person.coverIsbn ||
        facts.matureOnly !== person.matureOnly
      ) {
        await ctx.db.patch(person._id, facts);
      }
    }
    const last = docs.at(-1);
    return { next: docs.length < STATS_BATCH || !last ? null : last.publicId, count: docs.length };
  },
});

// ---------- Backfill (one-time) ----------

const ANN_API = "https://cdn.animenewsnetwork.com/encyclopedia/api.xml";
/** ANN manga ids per detail request (ANN's documented maximum). */
const ANN_BATCH = 50;
/** ANN allows one request a second. */
const ANN_DELAY_MS = 1100;
/** Observations scanned per lookup for ones still missing credits. */
const BACKFILL_SCAN = 400;
/** Work per action before it continues in a fresh one (actions run ≤10 min). */
const BACKFILL_BUDGET_MS = 6 * 60 * 1000;

/**
 * Give ANN manga observations stored before the importer kept credits their
 * staff credits now, instead of waiting for ANN's weekly sync: fetch the
 * entries' detail records (50 per request, at ANN's rate) and set only
 * `snapshot.credits` on each; nothing else is reconciled. Then rebuild
 * people. Continues itself until done; safe to rerun:
 * `npx convex run people:backfillAnnCredits`.
 */
export const backfillAnnCredits = internalAction({
  args: { after: v.optional(v.string()) },
  handler: async (ctx, { after }) => {
    const started = Date.now();
    let cursor = after ?? null;
    let updated = 0;
    for (;;) {
      const batch: { ids: string[]; next: string | null } = await ctx.runQuery(
        internal.people.creditlessManga,
        { after: cursor },
      );
      if (batch.ids.length > 0) {
        const res = await politeFetch(`${ANN_API}?manga=${batch.ids.join("/")}`, ANN_DELAY_MS);
        const records = parseApiResponse(await res.text());
        const returned = new Set(records.map((record) => record.id));
        updated += await ctx.runMutation(internal.people.setCredits, {
          entries: [
            ...records.map((record) => ({ mangaId: record.id, credits: record.credits })),
            // ANN has no record for these: mark them credited-with-nothing so
            // a rerun doesn't ask again.
            ...batch.ids
              .filter((id) => !returned.has(id))
              .map((id) => ({ mangaId: id, credits: [] })),
          ],
        });
      }
      cursor = batch.next;
      if (cursor === null) break;
      if (Date.now() - started > BACKFILL_BUDGET_MS) {
        await ctx.scheduler.runAfter(0, internal.people.backfillAnnCredits, { after: cursor });
        return { updated, continued: true };
      }
    }
    await ctx.scheduler.runAfter(0, internal.people.rebuild, {});
    return { updated, continued: false };
  },
});

/**
 * Up to ANN_BATCH linked, unwithdrawn ANN manga observations after `after`
 * whose snapshot has no credits yet, by ANN id, and where to look next.
 */
export const creditlessManga = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        q
          .eq("sourceKey", "ann")
          .gt("sourceRecordId", after ?? "manga:")
          .lt("sourceRecordId", "manga;"),
      )
      .take(BACKFILL_SCAN);
    const ids: string[] = [];
    let next: string | null = null;
    for (const doc of docs) {
      next = doc.sourceRecordId;
      const snapshot = doc.snapshot as { credits?: unknown } | null;
      if (doc.withdrawn || doc.recordRef?.type !== "series" || snapshot?.credits) continue;
      ids.push(doc.sourceRecordId.slice("manga:".length));
      if (ids.length === ANN_BATCH) break;
    }
    const exhausted = docs.length < BACKFILL_SCAN && next === docs.at(-1)?.sourceRecordId;
    return { ids, next: exhausted ? null : next };
  },
});

/** Set the credits ANN returned on each entry's stored snapshot. */
export const setCredits = internalMutation({
  args: {
    entries: v.array(v.object({ mangaId: v.string(), credits: v.array(annCreditValidator) })),
  },
  handler: async (ctx, { entries }) => {
    let updated = 0;
    for (const { mangaId, credits } of entries) {
      const doc = await ctx.db
        .query("sourceObservations")
        .withIndex("by_source_record", (q) =>
          q.eq("sourceKey", "ann").eq("sourceRecordId", `manga:${mangaId}`),
        )
        .unique();
      if (!doc) continue;
      await ctx.db.patch(doc._id, { snapshot: { ...(doc.snapshot as object), credits } });
      updated++;
    }
    return updated;
  },
});

// ---------- Reads ----------

/**
 * The Series an author is credited on that public pages show (active, not
 * bookless, and not mature unless `showMature`: `listed`), each with its
 * roles and Series library row (null until the library rebuild has seen it).
 */
async function visibleSeriesOf(
  ctx: QueryCtx,
  personId: Id<"people">,
  showMature: boolean | undefined,
) {
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
      if (!series || !listed(series, showMature)) return null;
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
 * Encyclopedia page (null for a person only publishers name), and every
 * Series they are credited on, latest release first, each with its roles
 * and library card facts. Null for an unknown id.
 */
export const authorPage = query({
  args: { publicId: v.number(), ...showMatureArg },
  handler: async (ctx, { publicId, showMature }) => {
    const person = await ctx.db
      .query("people")
      .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
      .unique();
    if (!person) return null;
    const shelf = await visibleSeriesOf(ctx, person._id, showMature);
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
      author: {
        publicId: person.publicId,
        name: person.name,
        annUrl: person.annId === undefined ? null : annPersonUrl(person.annId),
      },
      series,
      /** Every Series they are credited on is a Mature Series (the shelf may be empty). */
      matureOnly: person.matureOnly === true,
    };
  },
});

/**
 * The Authors tab (`/authors`): authors who wrote or drew at least one
 * visible Series, the most prolific first, a page at a time. Authors of
 * nothing but Mature Series are skipped unless `showMature`, so a page can
 * run short of `numItems`.
 */
export const authors = query({
  args: { paginationOpts: paginationOptsValidator, ...showMatureArg },
  handler: async (ctx, { paginationOpts, showMature }) => {
    const page = await ctx.db
      .query("people")
      .withIndex("by_seriesCount", (q) => q.gt("seriesCount", 0))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.filter((person) => visibleTo(showMature, person.matureOnly)).map((person) => ({
        publicId: person.publicId,
        name: person.name,
        seriesCount: person.seriesCount,
        coverUrl: person.coverUrl,
        coverIsbn: person.coverIsbn,
      })),
    };
  },
});
