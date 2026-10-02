// Authors: who made each Series, and every Series an author made. Credits
// come first from the Anime News Network Encyclopedia's staff rows (task +
// a stable person id), which the ANN importer stores on its manga
// observations (lib/ann.ts `credits`). ANN skips entries with no English
// release line, so digital-only and newer Series often have no ANN entry;
// for those, the creator names publishers print on their release
// observations stand in: PRH's free-text `author` line (lib/prh.ts
// parseAuthorCredits, roles where it states them; the line most of a
// Series' volumes carry, since PRH prints it whole on each and the others
// add only typos) and, for a Series PRH does not credit either, Kodansha's
// and Seven Seas' `creators` (names only, a role-less "author" credit,
// unioned across volumes; Kodansha lists the original creator first, so
// PRH's roles are the better publisher source). Publisher names find their
// person by `nameKey`; a name-only person left with no credit is pruned.
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
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
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
 * A person's name as an identity key (`people.nameKey`), folding the ways
 * sources spell one name:
 *
 * - case, Latin accents, and punctuation ("Eiichirō" = "Eiichiro",
 *   "In-Wan" = "Inwan": punctuation is removed, not spaced);
 * - long vowels, which romanisations write as ō, ou, oo, oh, ū or uu
 *   ("Kōji" = "Kouji", "Tohru" = "Toru", "Ryūō" = "Ryuuou");
 * - Kunrei and Hepburn spellings: shi = si, nn = n, jy = j
 *   ("Shingyougaku" = "Singyougaku", "coolkyousinnjya" = "Coolkyoushinja");
 * - word order and spacing: the words are sorted and joined without spaces,
 *   so "Masamune Shirow" = "Shirow Masamune", "Indo So" = "Indoso", and
 *   "Natsu Hyuuga" = "Hyūganatsu".
 *
 * Kana keep their voicing marks. A looser key joins more spellings and
 * more namesakes: two ANN people sharing one key make the name ambiguous
 * for publisher matching (`personByKey`).
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
    .map((word) =>
      word
        .replace(/uu/g, "u")
        .replace(/o[uo]/g, "o")
        .replace(/oh(?![aeiouy])/g, "o")
        .replace(/shi/g, "si")
        .replace(/nn/g, "n")
        .replace(/jy/g, "j"),
    )
    .sort()
    .join("");
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
 * Publisher release observations per batch; each reads its Release and
 * that Release's Series (and, for `creators`, the Series' credits once per
 * batch).
 */
const PUBLISHER_BATCH = 200;
/** PRH's source key (prh.ts SOURCE_KEY). */
const PRH_SOURCE = "prh";
/**
 * The sources whose release snapshots list creator names without roles
 * (sevenSeas.ts, kodansha.ts SOURCE_KEY). They credit only Series PRH's
 * line does not: Kodansha print books are PRH-distributed and usually have
 * a PRH line, and Kodansha lists the original creator first.
 */
const CREATOR_SOURCES = ["sevenseas", "kodansha"] as const;
/** Series per PRH-crediting mutation; each reads the Series' credits and its people. */
const PRH_APPLY_BATCH = 100;

/** Which publisher kind wrote a credit row (`seriesCredits.source`); absent for ANN's rows. */
type PublisherMarker = NonNullable<Doc<"seriesCredits">["source"]>;
/** People rows read per name key: far past the namesakes any key has. */
const NAME_ROWS = 10;
/** People per rekey or prune mutation. */
const PEOPLE_BATCH = 500;
/** People per stats mutation; each reads its credits, Series, and stats. */
const STATS_BATCH = 100;
/** Stale credit rows deleted per sweep mutation. */
const SWEEP_BATCH = 500;
/** Credits read per author: far past the most prolific author's count. */
const CREDITS_PER_PERSON = 1000;
/** Credits read per Series: a handful in practice. */
const CREDITS_PER_SERIES = 50;

/** Work per rebuild action before it continues in a fresh one (actions run ≤10 min). */
const REBUILD_BUDGET_MS = 5 * 60 * 1000;
/** Rows per role-settling mutation. */
const SETTLE_BATCH = 500;

/**
 * How many of a Series' PRH observations carry one author line, and the
 * newest of them (`lastSeenAt`, then creation time): `prhLinesBatch`
 * counts them, `prhMajority` picks the line.
 */
const prhLineValidator = v.object({
  seriesId: v.id("series"),
  line: v.string(),
  count: v.number(),
  lastSeenAt: v.number(),
  createdAt: v.number(),
});
type PrhLine = Infer<typeof prhLineValidator>;

/**
 * Where a rebuild is, carried from one action to the next: the phase, its
 * cursors (`cursor` for observation and row walks, `afterPublicId` for
 * people, `index` for the PRH Series and the creator sources), the run's
 * stamp, PRH's line counts so far, the running counts, and the publisher
 * pass's error message once it failed.
 */
const rebuildStateValidator = v.object({
  startedAt: v.number(),
  phase: v.union(
    v.literal("rekey"),
    v.literal("ann"),
    v.literal("prhLines"),
    v.literal("prhApply"),
    v.literal("creators"),
    v.literal("sweep"),
    v.literal("settle"),
    v.literal("prune"),
    v.literal("stats"),
  ),
  index: v.number(),
  cursor: v.union(v.string(), v.null()),
  afterPublicId: v.union(v.number(), v.null()),
  prhLines: v.array(prhLineValidator),
  publisherError: v.union(v.string(), v.null()),
  credits: v.number(),
  publisherCredits: v.number(),
  swept: v.number(),
  pruned: v.number(),
  people: v.number(),
});
type RebuildState = Infer<typeof rebuildStateValidator>;

/**
 * Rebuild every Series credit, in phases that each run only after the one
 * before finished for the same `startedAt` stamp:
 *
 * 1. rekey: give every person the current `nameKey`, so names match by it;
 * 2. ann: credit Series from the stored ANN manga observations;
 * 3. prhLines, prhApply: count each Series' PRH author lines, then credit
 *    the Series ANN did not from its most common line (`prhMajority`);
 * 4. creators: credit the Series neither did from Seven Seas' and
 *    Kodansha's creator lists, unioned across volumes;
 * 5. sweep credits no observation still gives, settle publisher rows on the
 *    roles this run gave them, and prune name-only people left with no
 *    credit (their author page would list nothing);
 * 6. stats: refresh each author's derived counts and jacket.
 *
 * Idempotent and safe beside an overlapping run (stamps only move
 * forward). After `budgetMs` (default REBUILD_BUDGET_MS) an action hands its
 * state to a fresh one. A failed publisher phase still lets ANN's stale
 * rows be swept and the stats refresh, keeping every publisher row (the
 * pass may not have reached them to restamp), their roles, and every
 * person, then throws its error. Runs every six hours (crons.ts); by hand:
 * `npx convex run people:rebuild`.
 */
export const rebuild = internalAction({
  args: { state: v.optional(rebuildStateValidator), budgetMs: v.optional(v.number()) },
  handler: async (ctx, { state: resumed, budgetMs }) =>
    withExceptionCapture("people.rebuild", ctx, async () => {
      const began = Date.now();
      const state: RebuildState = resumed ?? {
        startedAt: began,
        phase: "rekey",
        index: 0,
        cursor: null,
        afterPublicId: null,
        prhLines: [],
        publisherError: null,
        credits: 0,
        publisherCredits: 0,
        swept: 0,
        pruned: 0,
        people: 0,
      };
      const counts = () => ({
        credits: state.credits,
        publisherCredits: state.publisherCredits,
        swept: state.swept,
        pruned: state.pruned,
        people: state.people,
      });
      for (let steps = 0; ; steps++) {
        if (steps > 0 && Date.now() - began >= (budgetMs ?? REBUILD_BUDGET_MS)) {
          await ctx.scheduler.runAfter(0, internal.people.rebuild, { state, budgetMs });
          return { ...counts(), continued: true as const, phase: state.phase };
        }
        if (await rebuildStep(ctx, state)) break;
      }
      if (state.publisherError !== null) throw new Error(state.publisherError);
      return { ...counts(), continued: false as const, ms: Date.now() - state.startedAt };
    }),
});

/** Enter a phase with its cursors reset. */
function enter(state: RebuildState, phase: RebuildState["phase"]) {
  state.phase = phase;
  state.index = 0;
  state.cursor = null;
  state.afterPublicId = null;
}

/** The PRH line counts grouped by Series, in a stable order for `index` to walk. */
function prhSeries(lines: ReadonlyArray<PrhLine>): Array<{ seriesId: Id<"series">; lines: PrhLine[] }> {
  const bySeries = new Map<Id<"series">, PrhLine[]>();
  for (const line of lines) bySeries.set(line.seriesId, [...(bySeries.get(line.seriesId) ?? []), line]);
  return [...bySeries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([seriesId, seriesLines]) => ({ seriesId, lines: seriesLines }));
}

/**
 * Run one function of a rebuild and move `state` past it. True once the
 * rebuild is done. A publisher phase that throws records its message and
 * skips to the sweep of ANN's rows.
 */
async function rebuildStep(ctx: ActionCtx, state: RebuildState): Promise<boolean> {
  const rebuiltAt = state.startedAt;
  const publisherPhase = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      state.publisherError = error instanceof Error ? error.message : String(error);
      state.prhLines = [];
      enter(state, "sweep");
    }
  };
  switch (state.phase) {
    case "rekey": {
      const next: number | null = await ctx.runMutation(internal.people.rekeyPeople, {
        afterPublicId: state.afterPublicId,
      });
      state.afterPublicId = next;
      if (next === null) enter(state, "ann");
      return false;
    }
    case "ann": {
      const batch: { next: string | null; credits: number } = await ctx.runMutation(
        internal.people.creditBatch,
        { after: state.cursor, rebuiltAt },
      );
      state.credits += batch.credits;
      state.cursor = batch.next;
      // Next the publishers: the ANN pass decided which Series are ANN's.
      if (batch.next === null) enter(state, "prhLines");
      return false;
    }
    case "prhLines": {
      await publisherPhase(async () => {
        const batch: { next: string | null; lines: PrhLine[] } = await ctx.runQuery(
          internal.people.prhLinesBatch,
          { after: state.cursor },
        );
        const key = (line: PrhLine) => `${line.seriesId} ${line.line}`;
        const known = new Map(state.prhLines.map((line) => [key(line), line]));
        for (const line of batch.lines) {
          const seen = known.get(key(line));
          if (!seen) {
            state.prhLines.push(line);
            continue;
          }
          seen.count += line.count;
          seen.lastSeenAt = Math.max(seen.lastSeenAt, line.lastSeenAt);
          seen.createdAt = Math.max(seen.createdAt, line.createdAt);
        }
        state.cursor = batch.next;
        if (batch.next === null) enter(state, "prhApply");
      });
      return false;
    }
    case "prhApply": {
      await publisherPhase(async () => {
        const series = prhSeries(state.prhLines);
        const chunk = series.slice(state.index, state.index + PRH_APPLY_BATCH);
        if (chunk.length > 0) {
          const credited: number = await ctx.runMutation(internal.people.applyPrhLines, {
            rebuiltAt,
            series: chunk,
          });
          state.publisherCredits += credited;
        }
        state.index += PRH_APPLY_BATCH;
        if (state.index >= series.length) {
          state.prhLines = [];
          enter(state, "creators");
        }
      });
      return false;
    }
    case "creators": {
      const sourceKey = CREATOR_SOURCES[state.index];
      if (!sourceKey) {
        enter(state, "sweep");
        return false;
      }
      await publisherPhase(async () => {
        const batch: { next: string | null; credits: number } = await ctx.runMutation(
          internal.people.creatorsBatch,
          { sourceKey, after: state.cursor, rebuiltAt },
        );
        state.publisherCredits += batch.credits;
        state.cursor = batch.next;
        if (batch.next === null) {
          state.index++;
          state.cursor = null;
        }
      });
      return false;
    }
    case "sweep": {
      const n: number = await ctx.runMutation(internal.people.sweepCredits, {
        before: rebuiltAt,
        annOnly: state.publisherError !== null,
      });
      state.swept += n;
      if (n < SWEEP_BATCH) enter(state, state.publisherError === null ? "settle" : "stats");
      return false;
    }
    case "settle": {
      const next: string | null = await ctx.runMutation(internal.people.settleRoles, {
        rebuiltAt,
        cursor: state.cursor,
      });
      state.cursor = next;
      if (next === null) enter(state, "prune");
      return false;
    }
    case "prune": {
      const batch: { next: number | null; deleted: number } = await ctx.runMutation(
        internal.people.pruneOrphans,
        { afterPublicId: state.afterPublicId },
      );
      state.pruned += batch.deleted;
      state.afterPublicId = batch.next;
      if (batch.next === null) enter(state, "stats");
      return false;
    }
    case "stats": {
      const batch: { next: number | null; count: number } = await ctx.runMutation(
        internal.people.statsBatch,
        { afterPublicId: state.afterPublicId },
      );
      state.people += batch.count;
      state.afterPublicId = batch.next;
      return batch.next === null;
    }
  }
}

/**
 * Give a page of people the current `nameKey` rule's key where theirs
 * differs (rows keyed by an older rule), so the publisher passes match
 * names by it. The next cursor, or null when done.
 */
export const rekeyPeople = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()) },
  handler: async (ctx, { afterPublicId }) => {
    const docs = await ctx.db
      .query("people")
      .withIndex("by_publicId", (q) =>
        afterPublicId === null ? q : q.gt("publicId", afterPublicId),
      )
      .take(PEOPLE_BATCH);
    for (const person of docs) {
      const key = nameKey(person.name);
      if (person.nameKey !== key) await ctx.db.patch(person._id, { nameKey: key });
    }
    const last = docs.at(-1);
    return docs.length < PEOPLE_BATCH || !last ? null : last.publicId;
  },
});

/**
 * Delete a page of people only publishers named (no `annId`) who have no
 * credit left: their author page would list nothing. Run only at the end of
 * a rebuild whose publisher pass completed. Nothing but `seriesCredits`
 * refers to a person, so nothing else needs cleaning. ANN people stay
 * whatever their credits.
 */
export const pruneOrphans = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()) },
  handler: async (ctx, { afterPublicId }) => {
    const docs = await ctx.db
      .query("people")
      .withIndex("by_publicId", (q) =>
        afterPublicId === null ? q : q.gt("publicId", afterPublicId),
      )
      .take(PEOPLE_BATCH);
    let deleted = 0;
    for (const person of docs) {
      if (person.annId !== undefined) continue;
      const credit = await ctx.db
        .query("seriesCredits")
        .withIndex("by_person", (q) => q.eq("personId", person._id))
        .first();
      if (credit) continue;
      await ctx.db.delete(person._id);
      deleted++;
    }
    const last = docs.at(-1);
    return { next: docs.length < PEOPLE_BATCH || !last ? null : last.publicId, deleted };
  },
});

/**
 * Show the role this run's observations gave each publisher row it stamped
 * (`runRole`), once the whole publisher pass is done: a correction that
 * lowers a role ("Story and Art by A" → "Story by A; Art by B") lands here.
 * A page of the run's rows at a time; the next cursor, or null when done.
 */
export const settleRoles = internalMutation({
  args: { rebuiltAt: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { rebuiltAt, cursor }) => {
    const page = await ctx.db
      .query("seriesCredits")
      .withIndex("by_rebuiltAt", (q) => q.eq("rebuiltAt", rebuiltAt))
      .paginate({ cursor, numItems: SETTLE_BATCH });
    for (const row of page.page) {
      if (row.runRole !== undefined && row.runRole !== row.role) {
        await ctx.db.patch(row._id, { role: row.runRole });
      }
    }
    return page.isDone ? null : page.continueCursor;
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
 * Among the people sharing a name key, the one a name means: the one ANN
 * knows when exactly one does (other rows of the key are name-only
 * duplicates the next prune clears), null when several ANN people share
 * it (namesakes the name alone can't tell apart), else the earliest
 * name-only row; undefined when there is none.
 */
function personByKey(rows: ReadonlyArray<Doc<"people">>): Doc<"people"> | null | undefined {
  const known = rows.filter((person) => person.annId !== undefined);
  if (known.length > 1) return null;
  if (known.length === 1) return known[0];
  return rows.reduce<Doc<"people"> | undefined>(
    (first, person) => (!first || person.publicId < first.publicId ? person : first),
    undefined,
  );
}

/**
 * The author row for an ANN person id, renamed to ANN's spelling (and its
 * name key set to the current rule). A person with no row for the id yet
 * adopts the publisher-named row of the same name key when no ANN person
 * has that key (the earliest, if publishers named several), so their public
 * id stays; otherwise a new row. Beside an ANN namesake, which person a
 * publisher meant by the name can't be known, so nothing is adopted.
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
    .take(NAME_ROWS);
  const nameOnly = named.some((p) => p.annId !== undefined) ? undefined : personByKey(named);
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

const newMemo = (): PublisherMemo => ({
  survivors: new Map(),
  credits: new Map(),
  people: new Map(),
});

/**
 * A batch of PRH observations, by source record id, counted by Series and
 * author line: each linked, unwithdrawn observation whose line parses to
 * credits (`parseAuthorCredits`) adds one to its Series' count for that
 * line. Reads only; the action adds the batches up for `applyPrhLines`.
 */
export const prhLinesBatch = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        after === null
          ? q.eq("sourceKey", PRH_SOURCE)
          : q.eq("sourceKey", PRH_SOURCE).gt("sourceRecordId", after),
      )
      .take(PUBLISHER_BATCH);
    const survivors = new Map<Id<"series">, Id<"series"> | null>();
    const lines = new Map<string, PrhLine>();
    for (const observation of docs) {
      if (observation.withdrawn || observation.recordRef?.type !== "release") continue;
      const snapshot = observation.snapshot as { kind?: unknown; author?: unknown } | null;
      if (snapshot?.kind !== "prhTitle" || typeof snapshot.author !== "string") continue;
      const line = snapshot.author;
      if (parseAuthorCredits(line).length === 0) continue;
      const seriesId = await soleSeriesOf(ctx, observation.recordRef.id, survivors);
      if (!seriesId) continue;
      const key = `${seriesId} ${line}`;
      const seen = lines.get(key);
      lines.set(key, {
        seriesId,
        line,
        count: (seen?.count ?? 0) + 1,
        lastSeenAt: Math.max(seen?.lastSeenAt ?? 0, observation.lastSeenAt),
        createdAt: Math.max(seen?.createdAt ?? 0, observation._creationTime),
      });
    }
    const last = docs.at(-1);
    return {
      next: docs.length < PUBLISHER_BATCH || !last ? null : last.sourceRecordId,
      lines: [...lines.values()],
    };
  },
});

/**
 * The credits a Series takes from its PRH author lines: those of the line
 * most of its observations carry. Lines that parse to the same people and
 * roles count together ("Illustrated by Maam" and "by MAAM"), shown in
 * their most common spelling. Ties go to the line on the most recently
 * seen observation (then the newest, then the line itself). PRH prints the
 * whole line on every volume, so a union across volumes would only add the
 * typos and variant romanisations some volumes carry ("Choe Gyu-Seok" /
 * "Choi Gyu-Seok").
 */
export function prhMajority(
  lines: ReadonlyArray<Pick<PrhLine, "line" | "count" | "lastSeenAt" | "createdAt">>,
): AuthorCredit[] {
  type Line = (typeof lines)[number];
  const later = (a: Line, b: Line) =>
    a.count !== b.count
      ? a.count > b.count
      : a.lastSeenAt !== b.lastSeenAt
        ? a.lastSeenAt > b.lastSeenAt
        : a.createdAt !== b.createdAt
          ? a.createdAt > b.createdAt
          : a.line < b.line;
  const groups = new Map<string, { total: Line; best: Line; credits: AuthorCredit[] }>();
  for (const line of lines) {
    const credits = parseAuthorCredits(line.line);
    if (credits.length === 0) continue;
    const signature = credits
      .map((credit) => `${nameKey(credit.name)}:${credit.role}`)
      .sort()
      .join("|");
    const group = groups.get(signature);
    if (!group) {
      groups.set(signature, { total: { ...line }, best: line, credits });
      continue;
    }
    group.total = {
      line: group.total.line < line.line ? group.total.line : line.line,
      count: group.total.count + line.count,
      lastSeenAt: Math.max(group.total.lastSeenAt, line.lastSeenAt),
      createdAt: Math.max(group.total.createdAt, line.createdAt),
    };
    if (later(line, group.best)) {
      group.best = line;
      group.credits = credits;
    }
  }
  let winner: { total: Line; credits: AuthorCredit[] } | undefined;
  for (const group of groups.values()) {
    if (!winner || later(group.total, winner.total)) winner = group;
  }
  return winner?.credits ?? [];
}

/**
 * Credit each Series from its PRH author lines (`prhMajority`), unless ANN
 * credited it this run. PRH crediting a Series deletes its `creators` rows
 * at once, as the ANN pass deletes publisher rows. Returns the credits
 * stamped.
 */
export const applyPrhLines = internalMutation({
  args: {
    rebuiltAt: v.number(),
    series: v.array(v.object({ seriesId: v.id("series"), lines: v.array(prhLineValidator) })),
  },
  handler: async (ctx, { rebuiltAt, series }) => {
    const memo = newMemo();
    let count = 0;
    for (const { seriesId, lines } of series) {
      const rows = await ctx.db
        .query("seriesCredits")
        .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
        .take(CREDITS_PER_SERIES);
      if (rows.some((c) => c.source === undefined && c.rebuiltAt >= rebuiltAt)) continue;
      const credited = await stampPublisherCredits(
        ctx,
        { seriesId, rows, named: prhMajority(lines), marker: "prh", rebuiltAt },
        memo,
      );
      if (credited > 0) {
        for (const row of rows.filter((c) => c.source === "creators")) {
          await ctx.db.delete(row._id);
        }
      }
      count += credited;
    }
    return count;
  },
});

/**
 * Credit a batch of one creator-list source's observations (Seven Seas,
 * Kodansha), by source record id, to the Series neither ANN nor PRH
 * credited in this run (`rebuiltAt`).
 */
export const creatorsBatch = internalMutation({
  args: { sourceKey: v.string(), after: v.union(v.string(), v.null()), rebuiltAt: v.number() },
  handler: async (ctx, { sourceKey, after, rebuiltAt }) => {
    const docs = await ctx.db
      .query("sourceObservations")
      .withIndex("by_source_record", (q) =>
        after === null
          ? q.eq("sourceKey", sourceKey)
          : q.eq("sourceKey", sourceKey).gt("sourceRecordId", after),
      )
      .take(PUBLISHER_BATCH);
    const memo = newMemo();
    let credits = 0;
    for (const observation of docs) {
      credits += await creditFromCreators(ctx, observation, rebuiltAt, memo);
    }
    const last = docs.at(-1);
    return { next: docs.length < PUBLISHER_BATCH || !last ? null : last.sourceRecordId, credits };
  },
});

/**
 * The names a Kodansha or Seven Seas release snapshot lists in `creators`,
 * as role-less authors: only plain person names, not "Various" or an
 * organisation (lib/prh.ts isPersonName). Nothing for any other snapshot
 * (Kodansha's series links, crawl state).
 */
function creatorNames(snapshot: unknown): AuthorCredit[] {
  const s = snapshot as { kind?: unknown; creators?: unknown } | null;
  if ((s?.kind !== "kodanshaVolume" && s?.kind !== "book") || !Array.isArray(s.creators)) return [];
  return s.creators
    .filter((name): name is string => typeof name === "string" && isPersonName(name))
    .map((name) => ({ name: name.trim(), role: "author" as const }));
}

/**
 * Stamp the names one creator-list observation gives the one active Series
 * its Release belongs to, unless ANN or PRH credited that Series in this
 * run. Names union across a Series' volumes, since a Kodansha volume page
 * lists only its first creator. Returns the credits stamped.
 */
async function creditFromCreators(
  ctx: MutationCtx,
  observation: Doc<"sourceObservations">,
  rebuiltAt: number,
  memo: PublisherMemo,
): Promise<number> {
  if (observation.withdrawn || observation.recordRef?.type !== "release") return 0;
  const named = creatorNames(observation.snapshot);
  if (named.length === 0) return 0;
  const seriesId = await soleSeriesOf(ctx, observation.recordRef.id, memo.survivors);
  if (!seriesId) return 0;
  let rows = memo.credits.get(seriesId);
  if (rows === undefined) {
    const existing = await ctx.db
      .query("seriesCredits")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .take(CREDITS_PER_SERIES);
    const settled = existing.some(
      (c) => (c.source === undefined || c.source === "prh") && c.rebuiltAt >= rebuiltAt,
    );
    rows = settled ? null : existing;
    memo.credits.set(seriesId, rows);
  }
  if (rows === null) return 0;
  return await stampPublisherCredits(
    ctx,
    { seriesId, rows, named, marker: "creators", rebuiltAt },
    memo,
  );
}

/**
 * Stamp publisher credits on a Series. Each person keeps one row per Series
 * and marker (its id kept across runs), its `runRole` merged (`mergeRoles`)
 * with what earlier stamps of the run gave; `settleRoles` makes that the
 * shown role once the pass is done. `rows` (the Series' credit rows) is
 * kept current. Returns the credits stamped.
 */
async function stampPublisherCredits(
  ctx: MutationCtx,
  args: {
    seriesId: Id<"series">;
    rows: Doc<"seriesCredits">[];
    named: ReadonlyArray<AuthorCredit>;
    marker: PublisherMarker;
    rebuiltAt: number;
  },
  memo: PublisherMemo,
): Promise<number> {
  const { seriesId, rows, marker, rebuiltAt } = args;
  const incoming = new Map<Id<"people">, CreditRole[]>();
  for (const credit of args.named) {
    const personId = await personNamed(ctx, credit.name, memo);
    if (personId) incoming.set(personId, [...(incoming.get(personId) ?? []), credit.role]);
  }
  let count = 0;
  for (const [personId, roles] of incoming) {
    const mine = rows.filter((c) => c.source === marker && c.personId === personId);
    const stamped = mine.find((c) => c.rebuiltAt >= rebuiltAt);
    const runRole = mergeRoles([...roles, ...(stamped ? [stamped.runRole ?? stamped.role] : [])]);
    const covers = (c: Doc<"seriesCredits">) => mergeRoles([c.role, runRole]) === c.role;
    // One row per person, keeping its id across runs: the one this run
    // stamped, else one already in the run's role, else one whose role
    // covers it (story_art over story), else any.
    const row =
      stamped ?? mine.find((c) => c.role === runRole) ?? mine.find(covers) ?? mine[0];
    if (row) {
      // Shown: a covering role stays until the run settles, so the row
      // doesn't drop to "author" between the batches of "author" and "art".
      const role = covers(row) ? row.role : runRole;
      if (row.rebuiltAt < rebuiltAt || row.role !== role || row.runRole !== runRole) {
        const patch = { rebuiltAt: Math.max(row.rebuiltAt, rebuiltAt), role, runRole };
        await ctx.db.patch(row._id, patch);
        Object.assign(row, patch);
      }
    } else {
      const fields = { seriesId, personId, role: runRole, runRole, source: marker, rebuiltAt };
      rows.push({ _id: await ctx.db.insert("seriesCredits", fields), _creationTime: 0, ...fields });
    }
    count++;
  }
  return count;
}

/**
 * The one active Series a Release belongs to (both followed through
 * merges), or null when the Release is not active or its Series resolve to
 * none, to a hidden one, or to more than one. `survivors` remembers Series
 * lookups within a batch.
 */
async function soleSeriesOf(
  ctx: QueryCtx,
  releaseId: Id<"releases">,
  survivors: Map<Id<"series">, Id<"series"> | null>,
): Promise<Id<"series"> | null> {
  const release = await survivorOf<"releases">(ctx, await ctx.db.get(releaseId));
  if (!release || release.status !== "active") return null;
  const found = new Set<Id<"series"> | null>();
  for (const id of release.seriesIds) {
    let survivor = survivors.get(id);
    if (survivor === undefined) {
      const series = await survivorOf<"series">(ctx, await ctx.db.get(id));
      survivor = series?.status === "active" ? series._id : null;
      survivors.set(id, survivor);
    }
    found.add(survivor);
  }
  const [only] = found;
  return found.size === 1 && only ? only : null;
}

/**
 * The person a publisher's name means (`personByKey` over the rows with its
 * name key), else a new row without an ANN id. Null when several ANN people
 * share the key, since the name alone can't say which one it is.
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
    .take(NAME_ROWS);
  const match = personByKey(rows);
  const personId =
    match === undefined
      ? await ctx.db.insert("people", {
          publicId: await allocatePublicId(ctx, "person"),
          name,
          nameKey: key,
          seriesCount: 0,
          originalCount: 0,
          coverUrl: null,
          coverIsbn: null,
        })
      : (match?._id ?? null);
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
