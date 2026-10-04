// Authors: who made each Series, and every Series an author made
// (docs/imports.md "Author credits"). `rebuild` derives `people` and
// `seriesCredits` from stored observations, never the network, so a Series
// merge or split carries its credits along with the observations it
// relinks. ANN's staff rows come first, then PRH's `author` line, then
// Kodansha's and Seven Seas' `creators`. A Series ANN credits takes only
// ANN's credits, though the registry ranks Kodansha's creators above ANN's:
// ANN gives every credit a role and a stable person id, where Kodansha
// names only the first creator and no role. ANN's terms ask for a link to
// its Encyclopedia page wherever its person details show (`annPersonUrl`).

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
import { statsCoverIsbns } from "./lib/covers";
import { politeFetch } from "./lib/http";
import { survivorOf } from "./lib/matching";
import { listed, showMatureArg, visibleTo } from "./lib/mature";
import { getActive } from "./lib/merges";
import { applyRetrying } from "./lib/occ";
import { isPersonName, parseAuthorCredits, type AuthorCredit } from "./lib/prh";
import { allocatePublicId } from "./lib/publicIds";
import { withExceptionCapture } from "./lib/posthog";

export type CreditRole = Doc<"seriesCredits">["role"];

/**
 * Display order of roles on a Series: the makers first (the role-less
 * "author" a publisher gives after the specific ones), the source after.
 */
const ROLE_ORDER: ReadonlyArray<CreditRole> = [
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
 * more namesakes, so it only finds candidates: `matchPerson` prefers an
 * exact spelling (`strictNameKey`) and keeps a name its own person when
 * ANN namesakes share the key.
 */
export function nameKey(name: string): string {
  return nameWords(name)
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
 * A name's exact spelling as a key: case, Latin accents, punctuation and
 * word order folded, nothing else ("Ayumi Kanou" stays apart from "Ayumi
 * Kano"). `matchPerson` prefers a person whose spelling matches this way
 * over one only the looser `nameKey` finds.
 */
function strictNameKey(name: string): string {
  return nameWords(name).sort().join(" ");
}

/** A name's words, lower-cased, with Latin accents and punctuation removed. */
function nameWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether two name keys are near spellings of one name: within edit
 * distance 1, or 2 when both keys have at least 6 characters ("choegyuseok"
 * and "choigyuseok"). Equal keys are not near; they are the same key.
 */
export function nearKeys(a: string, b: string): boolean {
  if (a === b) return false;
  const limit = Math.min(a.length, b.length) >= 6 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]! <= limit;
}

/**
 * Which of the people sharing a name's `nameKey` the name means, or null
 * for a new name-only person. In order:
 *
 * 1. the one ANN person spelled exactly so (`strictNameKey`);
 * 2. failing an exact ANN spelling, the one ANN person the key finds
 *    ("Kouji Kumeta" is ANN's "Kōji Kumeta");
 * 3. with no ANN person at the key, the earliest name-only person
 *    ("Indo So" joins "Indoso");
 * 4. when several ANN people share the key (or the exact spelling) and
 *    the name can't choose, its own name-only person, spelled exactly so,
 *    or a new one: the credit stays, on a person of its own.
 */
export function matchPerson(
  name: string,
  candidates: ReadonlyArray<Doc<"people">>,
): Doc<"people"> | null {
  const strict = strictNameKey(name);
  const ann = candidates.filter((person) => person.annId !== undefined);
  const exactAnn = ann.filter((person) => strictNameKey(person.name) === strict);
  if (exactAnn.length === 1) return exactAnn[0]!;
  if (exactAnn.length === 0 && ann.length === 1) return ann[0]!;
  const nameOnly = candidates
    .filter((person) => person.annId === undefined)
    .sort((a, b) => a.publicId - b.publicId);
  if (ann.length === 0) return nameOnly[0] ?? null;
  return nameOnly.find((person) => strictNameKey(person.name) === strict) ?? null;
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
function annPersonUrl(annId: string): string {
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
 * PRH-distributed and usually have a PRH line, and Kodansha lists the
 * original creator first). Literal keys (prh.ts, sevenSeas.ts, kodansha.ts
 * SOURCE_KEY).
 */
const PUBLISHER_SOURCES = [
  { sourceKey: "prh", marker: "prh" },
  { sourceKey: "sevenseas", marker: "creators" },
  { sourceKey: "kodansha", marker: "creators" },
] as const;

/** Which publisher kind wrote a credit row (`seriesCredits.source`); absent for ANN's rows. */
type PublisherMarker = NonNullable<Doc<"seriesCredits">["source"]>;
/** People rows read per name key: far past the namesakes any key has. */
const NAME_ROWS = 10;
/** People per rekey or prune mutation. */
const PEOPLE_BATCH = 500;
/** Name-only people one rebuild may delete, so a bad run can't empty the table. */
const PRUNE_CAP = 100;
/** People per stats mutation; each reads its credits, Series, and stats. */
const STATS_BATCH = 100;
/** Stale credit rows deleted per sweep mutation. */
const SWEEP_BATCH = 500;
/** Credits read per author: far past the most prolific author's count. */
const CREDITS_PER_PERSON = 1000;
/** Credits read per Series: a handful in practice. */
const CREDITS_PER_SERIES = 50;

/** Work per rebuild action before it continues in a fresh one (actions run ≤30 min). */
const REBUILD_BUDGET_MS = 5 * 60 * 1000;
/** Rows per settling mutation; a PRH row settles its whole Series. */
const SETTLE_BATCH = 100;

/**
 * Where a rebuild is, carried from one action to the next: the phase, its
 * cursors (`cursor` for observation and row walks, `afterPublicId` for
 * people, `source` for PUBLISHER_SOURCES), the run's stamp, the running
 * counts, and the publisher pass's error message once it failed. Its size
 * does not grow with the catalog: what the passes tally lives on the
 * credits' run rows (`seriesCreditRuns`). `version` is REBUILD_VERSION
 * when the state was made; a continuation scheduled before the run fields
 * left `seriesCredits` has none.
 */
const rebuildStateValidator = v.object({
  version: v.optional(v.number()),
  startedAt: v.number(),
  phase: v.union(
    v.literal("rekey"),
    v.literal("ann"),
    v.literal("publisher"),
    v.literal("sweep"),
    v.literal("settle"),
    v.literal("prune"),
    v.literal("stats"),
  ),
  source: v.number(),
  cursor: v.union(v.string(), v.null()),
  afterPublicId: v.union(v.number(), v.null()),
  publisherError: v.union(v.string(), v.null()),
  credits: v.number(),
  publisherCredits: v.number(),
  swept: v.number(),
  pruned: v.number(),
  people: v.number(),
});
type RebuildState = Infer<typeof rebuildStateValidator>;

/**
 * Where a run keeps its stamps and tallies, carried in its state. 1: in
 * `seriesCreditRuns`. A continuation of an older layout (no `version`)
 * starts the rebuild over with a newer stamp instead of resuming. The
 * credits it stamped hold their tallies on the credit, where settle never
 * looks, and its settle cursor pages another table. Starting over, every
 * credit the run stamps gets a run row, and every legacy row is older
 * than the stamp: restamped (moving its fields off) or swept before settle.
 */
export const REBUILD_VERSION = 1;

/**
 * Rebuild every Series credit, in phases that each run only after the one
 * before finished for the same `startedAt` stamp:
 *
 * 1. rekey: give every person the current `nameKey`, so names find them;
 * 2. ann: credit Series from the stored ANN manga observations;
 * 3. publisher: credit the Series ANN did not from PRH's author lines,
 *    then the Series neither did from Seven Seas' and Kodansha's creator
 *    lists, each the union of what the Series' observations name;
 * 4. sweep credits no observation still gives, settle publisher rows (the
 *    roles this run gave them, and the most named of a name's near
 *    spellings), and prune name-only people uncredited two runs running;
 * 5. stats: refresh each author's derived counts and jacket.
 *
 * Idempotent and safe beside an overlapping run (stamps only move
 * forward). The stamps and tallies live in `seriesCreditRuns`, so a run
 * that changes nothing writes no credit or person a page reads. After
 * `budgetMs` (default REBUILD_BUDGET_MS) an action hands its state to a
 * fresh one. A failed publisher pass still lets ANN's stale rows
 * be swept and the stats refresh, keeping every publisher row (the pass may
 * not have reached them to restamp), their roles, and every person, then
 * throws its error. Runs every six hours (crons.ts); by hand:
 * `npx convex run people:rebuild`.
 */
export const rebuild = internalAction({
  args: { state: v.optional(rebuildStateValidator), budgetMs: v.optional(v.number()) },
  handler: async (ctx, { state: resumed, budgetMs }) =>
    withExceptionCapture("people.rebuild", ctx, async () => {
      const began = Date.now();
      const state: RebuildState = resumed?.version === REBUILD_VERSION ? resumed : {
        version: REBUILD_VERSION,
        // Past an older-layout run's stamp, whatever the clock says.
        startedAt: Math.max(began, (resumed?.startedAt ?? 0) + 1),
        phase: "rekey",
        source: 0,
        cursor: null,
        afterPublicId: null,
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
  state.source = 0;
  state.cursor = null;
  state.afterPublicId = null;
}

/**
 * Run one function of a rebuild and move `state` past it. True once the
 * rebuild is done. Batches retry write conflicts (`applyRetrying`), as the
 * importers' writes do: they read the observations and records running
 * imports write, and one conflict must not end the run. A publisher batch
 * that still throws records its message and skips to the sweep of ANN's
 * rows.
 */
async function rebuildStep(ctx: ActionCtx, state: RebuildState): Promise<boolean> {
  const rebuiltAt = state.startedAt;
  switch (state.phase) {
    case "rekey": {
      const next: number | null = await applyRetrying(ctx, internal.people.rekeyPeople, {
        afterPublicId: state.afterPublicId,
      });
      state.afterPublicId = next;
      if (next === null) enter(state, "ann");
      return false;
    }
    case "ann": {
      const batch: { next: string | null; credits: number } = await applyRetrying(
        ctx,
        internal.people.creditBatch,
        { after: state.cursor, rebuiltAt },
      );
      state.credits += batch.credits;
      state.cursor = batch.next;
      // Next the publishers: the ANN pass decided which Series are ANN's.
      if (batch.next === null) enter(state, "publisher");
      return false;
    }
    case "publisher": {
      const source = PUBLISHER_SOURCES[state.source];
      if (!source) {
        enter(state, "sweep");
        return false;
      }
      try {
        const batch: { next: string | null; credits: number } = await applyRetrying(
          ctx,
          internal.people.publisherBatch,
          { sourceKey: source.sourceKey, after: state.cursor, rebuiltAt },
        );
        state.publisherCredits += batch.credits;
        state.cursor = batch.next;
        if (batch.next === null) state.source++;
      } catch (error) {
        state.publisherError = error instanceof Error ? error.message : String(error);
        enter(state, "sweep");
      }
      return false;
    }
    case "sweep": {
      const n: number = await applyRetrying(ctx, internal.people.sweepCredits, {
        before: rebuiltAt,
        annOnly: state.publisherError !== null,
      });
      state.swept += n;
      if (n < SWEEP_BATCH) enter(state, state.publisherError === null ? "settle" : "stats");
      return false;
    }
    case "settle": {
      const next: string | null = await applyRetrying(ctx, internal.people.settleRoles, {
        rebuiltAt,
        cursor: state.cursor,
      });
      state.cursor = next;
      if (next === null) enter(state, "prune");
      return false;
    }
    case "prune": {
      const batch: { next: number | null; deleted: number } = await applyRetrying(
        ctx,
        internal.people.pruneOrphans,
        {
          afterPublicId: state.afterPublicId,
          rebuiltAt,
          limit: Math.max(0, PRUNE_CAP - state.pruned),
        },
      );
      state.pruned += batch.deleted;
      state.afterPublicId = batch.next;
      if (batch.next === null) enter(state, "stats");
      return false;
    }
    case "stats": {
      const batch: { next: number | null; count: number } = await applyRetrying(
        ctx,
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
 * differs (rows keyed by an older rule), so the publisher pass finds them
 * by it. The next cursor, or null when done.
 */
export const rekeyPeople = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()) },
  handler: async (ctx, { afterPublicId }) => {
    const { docs, next } = await peopleAfter(ctx, afterPublicId, PEOPLE_BATCH);
    for (const person of docs) {
      const key = nameKey(person.name);
      if (person.nameKey !== key) await ctx.db.patch(person._id, { nameKey: key });
    }
    return next;
  },
});

/** Up to `size` people after `afterPublicId` by public id, and the cursor past them (null when done). */
async function peopleAfter(ctx: QueryCtx, afterPublicId: number | null, size: number) {
  const docs = await ctx.db
    .query("people")
    .withIndex("by_publicId", (q) => (afterPublicId === null ? q : q.gt("publicId", afterPublicId)))
    .take(size);
  const last = docs.at(-1);
  return { docs, next: docs.length < size || !last ? null : last.publicId };
}

/**
 * A page of people only publishers named (no `annId`), at the end of a
 * rebuild whose publisher pass completed: one credited nowhere is marked
 * (`creditlessSince`), deleted if an earlier successful rebuild had
 * already marked them (their author page lists nothing, and a single run's
 * loss, such as a near spelling losing a tie, is never final), and
 * unmarked once credited again. At most `limit` deletions. Nothing but
 * `seriesCredits` refers to a person, so nothing else needs cleaning. ANN
 * people stay whatever their credits.
 */
export const pruneOrphans = internalMutation({
  args: { afterPublicId: v.union(v.number(), v.null()), rebuiltAt: v.number(), limit: v.number() },
  handler: async (ctx, { afterPublicId, rebuiltAt, limit }) => {
    const { docs, next } = await peopleAfter(ctx, afterPublicId, PEOPLE_BATCH);
    let deleted = 0;
    for (const person of docs) {
      if (person.annId !== undefined) continue;
      const credit = await ctx.db
        .query("seriesCredits")
        .withIndex("by_person", (q) => q.eq("personId", person._id))
        .first();
      if (credit) {
        if (person.creditlessSince !== undefined) {
          await ctx.db.patch(person._id, { creditlessSince: undefined });
        }
      } else if (person.creditlessSince === undefined) {
        await ctx.db.patch(person._id, { creditlessSince: rebuiltAt });
      } else if (person.creditlessSince < rebuiltAt && deleted < limit) {
        await ctx.db.delete(person._id);
        deleted++;
      }
    }
    return { next, deleted };
  },
});

/**
 * Settle the publisher rows a run stamped, once its whole publisher pass
 * is done. A `creators` row shows the role this run's observations gave it
 * (`runRole`); a correction that lowers a role lands here. A Series' PRH
 * rows are decided together (`settlePrhSeries`). A page of the run's
 * `seriesCreditRuns` rows at a time; the next cursor, or null when done.
 */
export const settleRoles = internalMutation({
  args: { rebuiltAt: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { rebuiltAt, cursor }) => {
    const page = await ctx.db
      .query("seriesCreditRuns")
      .withIndex("by_rebuiltAt", (q) => q.eq("rebuiltAt", rebuiltAt))
      .paginate({ cursor, numItems: SETTLE_BATCH });
    const memo = newMemo();
    const settled = new Set<Id<"series">>();
    for (const run of page.page) {
      if (run.source === "prh") {
        if (settled.has(run.seriesId)) continue;
        settled.add(run.seriesId);
        await settlePrhSeries(ctx, run.seriesId, rebuiltAt, memo);
      } else if (run.source === "creators" && run.runRole !== undefined) {
        const credit = await ctx.db.get(run.creditId);
        if (credit && credit.role !== run.runRole) await ctx.db.patch(credit._id, { role: run.runRole });
      }
    }
    return page.isDone ? null : page.continueCursor;
  },
});

/**
 * Decide a Series' PRH credits from the names its rows tallied this run
 * (`runNames`). Spellings sharing a `nameKey` are one name. Taking the
 * names most used first (then the one seen most recently, then code-point
 * order), each joins the first person holding a near spelling (`nearKeys`)
 * and no name a line named it beside (`runApart`), else starts a person of
 * its own; a person shows their first, most used spelling, resolved to a
 * person only now (`personNamed`), with the roles all its spellings gave.
 * Each person keeps one row (the one already showing them, else the one
 * that tallied most of their names, else a new one) and the rest are
 * deleted. Each kept row is given the person's whole tally, so settling
 * the Series again (it can span two settle pages) changes nothing.
 */
async function settlePrhSeries(
  ctx: MutationCtx,
  seriesId: Id<"series">,
  rebuiltAt: number,
  memo: PublisherMemo,
) {
  const rows = (await creditRows(ctx, seriesId)).filter(
    (c) => c.source === "prh" && c.rebuiltAt === rebuiltAt,
  );
  type Name = NonNullable<RunFields["runNames"]>[number] & { key: string; best: number };
  const names = new Map<string, Name>();
  for (const row of rows) {
    for (const n of row.runNames ?? []) {
      const key = nameKey(n.name);
      const s = names.get(key) ?? { ...n, key, best: 0, count: 0, seenAt: 0 };
      if (n.count > s.best) Object.assign(s, { best: n.count, name: n.name });
      Object.assign(s, {
        role: mergeRoles([s.role, n.role]),
        count: s.count + n.count,
        seenAt: Math.max(s.seenAt, n.seenAt),
      });
      names.set(key, s);
    }
  }
  const runApart = [...new Set(rows.flatMap((row) => row.runApart ?? []))].sort();
  const apart = (a: Name, b: Name) => runApart.includes([a.key, b.key].sort().join("|"));
  const order = (a: Name, b: Name) =>
    b.count - a.count || b.seenAt - a.seenAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const people: Name[][] = [];
  for (const n of [...names.values()].sort(order)) {
    const person = people.find(
      (group) => group.some((m) => nearKeys(n.key, m.key)) && !group.some((m) => apart(n, m)),
    );
    if (person) person.push(n);
    else people.push([n]);
  }
  const total = (group: Name[]) => group.reduce((sum, n) => sum + n.count, 0);
  const used = new Set<Id<"seriesCredits">>();
  for (const group of people.sort((a, b) => total(b) - total(a) || order(a[0]!, b[0]!))) {
    const personId = await personNamed(ctx, group[0]!.name, memo);
    const role = mergeRoles(group.map((n) => n.role));
    const keys = new Set(group.map((n) => n.key));
    const onRow = (row: CreditRow) =>
      (row.runNames ?? []).reduce((sum, n) => sum + (keys.has(nameKey(n.name)) ? n.count : 0), 0);
    const row = rows
      .filter((c) => !used.has(c._id) && onRow(c) > 0)
      .sort(
        (a, b) =>
          Number(b.personId === personId) - Number(a.personId === personId) ||
          onRow(b) - onRow(a) ||
          a._creationTime - b._creationTime,
      )[0];
    const fields = {
      personId,
      role,
      runRole: role,
      runNames: group.map(({ name, role, count, seenAt }) => ({ name, role, count, seenAt })),
      runApart,
    };
    if (!row) {
      used.add((await insertCredit(ctx, rows, { ...fields, seriesId, source: "prh", rebuiltAt }))._id);
      continue;
    }
    used.add(row._id);
    await updateRow(ctx, row, fields);
  }
  for (const row of rows) if (!used.has(row._id)) await deleteRow(ctx, row);
}

/** Credit a batch of ANN manga observations, by source record id. */
export const creditBatch = internalMutation({
  args: { after: v.union(v.string(), v.null()), rebuiltAt: v.number() },
  handler: async (ctx, { after, rebuiltAt }) => {
    const docs = await annMangaAfter(ctx, after, CREDIT_BATCH);
    let credits = 0;
    for (const observation of docs) {
      credits += await creditObservation(ctx, observation, rebuiltAt);
    }
    const last = docs.at(-1);
    return { next: docs.length < CREDIT_BATCH || !last ? null : last.sourceRecordId, credits };
  },
});

/** Up to `size` ANN manga observations after `after` (a source record id), in id order. */
async function annMangaAfter(ctx: QueryCtx, after: string | null, size: number) {
  return await ctx.db
    .query("sourceObservations")
    .withIndex("by_source_record", (q) =>
      q
        .eq("sourceKey", "ann")
        .gt("sourceRecordId", after ?? "manga:")
        .lt("sourceRecordId", "manga;"),
    )
    .take(size);
}

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
  const series = await getActive(ctx, "series", observation.recordRef.id);
  if (!series) return 0;
  const existing = await creditRows(ctx, series._id);
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
      // The stamp only: the credit itself is unchanged.
      if (row.rebuiltAt < rebuiltAt) await updateRow(ctx, row, { rebuiltAt });
    } else {
      await insertCredit(ctx, existing, { seriesId: series._id, personId, role, rebuiltAt });
    }
    count++;
  }
  // ANN credits the Series now: its publisher rows go here rather than at
  // the sweep, so no byline shows both meanwhile, and a failed publisher
  // pass (which skips the sweep of publisher rows) can't keep them.
  if (count > 0) {
    for (const row of existing) {
      if (row.source !== undefined) await deleteRow(ctx, row);
    }
  }
  return count;
}

/**
 * The author row for an ANN person id, renamed to ANN's spelling (and its
 * name key set to the current rule). A person with no row for the id yet
 * adopts a publisher-named row of the same `nameKey` when no ANN person has
 * that key (the one spelled exactly so, else the earliest), so their
 * public id stays; otherwise a new row. Beside an ANN namesake, which
 * person a publisher meant by the name can't be known, so nothing is
 * adopted.
 *
 * Adoption goes by name alone, so a different person ANN knows by the same
 * name (a "Kei", a "Fly") inherits the publisher-named person's id and
 * their publisher-credited Series. Publisher names already join ANN people
 * by name the same way (`matchPerson`); name matching can't tell
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
  const nameOnly = named.some((p) => p.annId !== undefined)
    ? null
    : (named.find((p) => strictNameKey(p.name) === strictNameKey(credit.name)) ??
      matchPerson(credit.name, named));
  if (nameOnly) {
    await ctx.db.patch(nameOnly._id, {
      name: credit.name,
      annId: credit.personId,
      creditlessSince: undefined,
    });
    return nameOnly._id;
  }
  return await insertPerson(ctx, credit.name, key, credit.personId);
}

/** A new person, credited nowhere yet; `annId` absent for a name only publishers give. */
async function insertPerson(ctx: MutationCtx, name: string, key: string, annId?: string) {
  return await ctx.db.insert("people", {
    publicId: await allocatePublicId(ctx, "person"),
    name,
    ...(annId !== undefined ? { annId } : {}),
    nameKey: key,
    seriesCount: 0,
    originalCount: 0,
    coverUrl: null,
    coverIsbn: null,
  });
}

// ---------- Credit rows and their run bookkeeping ----------
//
// A run stamps every credit its observations give, and the sweep deletes
// the ones it did not. The stamps and the tallies settle reads live in
// `seriesCreditRuns`, never on the credit: every Series page reads its
// credits, so a write there would invalidate every credited Series page's
// cached query on every run. The helpers below join the two, and write a
// credit only when what it shows changes.

/** The fields of a credit's `seriesCreditRuns` row the rebuild works with. */
type RunFields = Pick<Doc<"seriesCreditRuns">, "rebuiltAt" | "runRole" | "runNames" | "runApart">;
/** The legacy run fields a credit row may still carry (schema.ts seriesCredits), cleared. */
const NO_LEGACY = {
  rebuiltAt: undefined,
  runRole: undefined,
  runNames: undefined,
  runApart: undefined,
  runVariants: undefined,
};
/** What a credit shows: a write to these is a write the Series page sees. */
type Shown = Pick<Doc<"seriesCredits">, "personId" | "role">;
/**
 * A credit row as the rebuild sees it: what it shows, with its run fields
 * joined in (`runId` null for a legacy row whose fields are still its own).
 */
type CreditRow = Omit<Doc<"seriesCredits">, keyof typeof NO_LEGACY> &
  RunFields & { runId: Id<"seriesCreditRuns"> | null; legacy: boolean };

/** A Series' credit rows (up to CREDITS_PER_SERIES), each with its run fields. */
async function creditRows(ctx: QueryCtx, seriesId: Id<"series">): Promise<CreditRow[]> {
  const [credits, runs] = await Promise.all([
    ctx.db
      .query("seriesCredits")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .take(CREDITS_PER_SERIES),
    ctx.db
      .query("seriesCreditRuns")
      .withIndex("by_series", (q) => q.eq("seriesId", seriesId))
      .take(CREDITS_PER_SERIES),
  ]);
  const runOf = new Map(runs.map((run) => [run.creditId, run]));
  return credits.map((credit) => {
    const { rebuiltAt, runRole, runNames, runApart, runVariants, ...shown } = credit;
    const legacy = [rebuiltAt, runRole, runNames, runApart, runVariants].some((f) => f !== undefined);
    const run = runOf.get(credit._id);
    if (run) {
      const { rebuiltAt, runRole, runNames, runApart } = run;
      return { ...shown, rebuiltAt, runRole, runNames, runApart, runId: run._id, legacy };
    }
    return { ...shown, rebuiltAt: rebuiltAt ?? 0, runRole, runNames, runApart, runId: null, legacy };
  });
}

/** Whether two field values are the same (they are Convex values: JSON is exact). */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply `patch` to a credit row and the caller's copy of it: the shown
 * fields to `seriesCredits` only where they change, the run fields to its
 * `seriesCreditRuns` row. A legacy row gets its run row here, and its own
 * run fields cleared: one write to the credit, once.
 */
async function updateRow(ctx: MutationCtx, row: CreditRow, patch: Partial<Shown & RunFields>) {
  const shown: Partial<Shown> = {};
  if (patch.personId !== undefined && patch.personId !== row.personId) shown.personId = patch.personId;
  if (patch.role !== undefined && patch.role !== row.role) shown.role = patch.role;
  const run: Partial<RunFields> = {};
  for (const key of ["rebuiltAt", "runRole", "runNames", "runApart"] as const) {
    if (key in patch && !same(patch[key], row[key])) Object.assign(run, { [key]: patch[key] });
  }
  Object.assign(row, patch);
  if (row.runId === null) {
    const { _id: creditId, seriesId, source, rebuiltAt, runRole, runNames, runApart } = row;
    row.runId = await ctx.db.insert("seriesCreditRuns", {
      creditId,
      seriesId,
      source,
      rebuiltAt,
      runRole,
      runNames,
      runApart,
    });
  } else if (Object.keys(run).length > 0) {
    await ctx.db.patch(row.runId, run);
  }
  const write = row.legacy ? { ...shown, ...NO_LEGACY } : shown;
  row.legacy = false;
  if (Object.keys(write).length > 0) await ctx.db.patch(row._id, write);
}

/** Insert a credit and its run row, and add it to `rows`, the caller's current view of its Series' credits. */
async function insertCredit(
  ctx: MutationCtx,
  rows: CreditRow[],
  fields: Shown & RunFields & Pick<Doc<"seriesCredits">, "seriesId" | "source">,
) {
  const { seriesId, personId, role, source, ...runFields } = fields;
  const creditId = await ctx.db.insert("seriesCredits", { seriesId, personId, role, source });
  const runId = await ctx.db.insert("seriesCreditRuns", { creditId, seriesId, source, ...runFields });
  const row: CreditRow = { ...fields, _id: creditId, _creationTime: 0, runId, legacy: false };
  rows.push(row);
  return row;
}

/** Delete a credit row and its run row. */
async function deleteRow(ctx: MutationCtx, row: CreditRow) {
  await ctx.db.delete(row._id);
  if (row.runId !== null) await ctx.db.delete(row.runId);
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
  credits: Map<Id<"series">, CreditRow[] | null>;
  /** A name's exact spelling → its person. */
  people: Map<string, Id<"people">>;
  /** A person → their `nameKey`, for near-spelling checks. */
  keys: Map<Id<"people">, string>;
};

function newMemo(): PublisherMemo {
  return { survivors: new Map(), credits: new Map(), people: new Map(), keys: new Map() };
}

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
    const memo = newMemo();
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
 * for role-less `creators` names, PRH did). A Series' credits are the
 * union of what its observations name: each person keeps one row per
 * Series and marker (its id kept across runs), its `runRole` merged
 * (`mergeRoles`) with what earlier observations of the run gave, and
 * `settleRoles` shows that role once the pass is done.
 *
 * PRH names are tallied by spelling (`stampPrh`) and settled per Series:
 * PRH's volumes carry typos and variant romanisations ("Choe Gyu-Seok" /
 * "Choi Gyu-Seok") that settle collapses to the most used. Kodansha's and
 * Seven Seas' lists stay a plain union (`stampCreators`). PRH crediting a
 * Series deletes its `creators` rows at once, as the ANN pass deletes
 * publisher rows. Returns the credits stamped.
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
  const seriesId = await soleSeriesOf(ctx, observation.recordRef.id, memo.survivors);
  if (!seriesId) return 0;
  let rows = memo.credits.get(seriesId);
  if (rows === undefined) {
    const existing = await creditRows(ctx, seriesId);
    const stampedBy = (source: PublisherMarker | undefined) =>
      existing.some((c) => c.source === source && c.rebuiltAt >= rebuiltAt);
    const settled = stampedBy(undefined) || (marker === "creators" && stampedBy("prh"));
    rows = settled ? null : existing;
    memo.credits.set(seriesId, rows);
  }
  if (rows === null) return 0;

  const args = { seriesId, rows, named, rebuiltAt };
  if (marker === "creators") return await stampCreators(ctx, args, memo);
  const count = await stampPrh(ctx, { ...args, seenAt: observation.lastSeenAt }, memo);
  // PRH credits the Series now: its role-less `creators` rows go here, not
  // at the sweep, so no byline shows both meanwhile.
  if (count > 0) {
    for (const row of rows.filter((c) => c.source === "creators")) {
      await deleteRow(ctx, row);
      rows.splice(rows.indexOf(row), 1);
    }
  }
  return count;
}

/** A person's `nameKey`, remembered for the batch. */
async function personKey(ctx: QueryCtx, memo: PublisherMemo, personId: Id<"people">) {
  let key = memo.keys.get(personId);
  if (key === undefined) {
    const person = await ctx.db.get(personId);
    key = person ? (person.nameKey ?? nameKey(person.name)) : "";
    memo.keys.set(personId, key);
  }
  return key;
}

/** The first of `items` that `test` passes, tested in order. */
async function findFirst<T>(items: ReadonlyArray<T>, test: (item: T) => Promise<boolean>) {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}

/** What one observation gives a Series' credits, for the stamp helpers. */
type StampArgs = {
  seriesId: Id<"series">;
  /** The Series' credit rows, kept current. */
  rows: CreditRow[];
  named: ReadonlyArray<AuthorCredit>;
  rebuiltAt: number;
};

/**
 * Stamp a Kodansha or Seven Seas creator list: a plain union, one row per
 * person (its id kept across runs), its `runRole` merged (`mergeRoles`)
 * with what earlier observations of the run gave. A row of another person
 * whose `nameKey` the name shares (a duplicate the key merged) passes to
 * the person the name now means. Returns the credits stamped.
 */
async function stampCreators(ctx: MutationCtx, args: StampArgs, memo: PublisherMemo) {
  const { seriesId, rows, rebuiltAt } = args;
  const incoming = new Map<Id<"people">, CreditRole[]>();
  for (const credit of args.named) {
    const personId = await personNamed(ctx, credit.name, memo);
    incoming.set(personId, [...(incoming.get(personId) ?? []), credit.role]);
  }
  const isStamped = (c: CreditRow) => c.rebuiltAt >= rebuiltAt;
  let count = 0;
  for (const [personId, roles] of incoming) {
    const key = await personKey(ctx, memo, personId);
    const mine: CreditRow[] = [];
    for (const c of rows) {
      if (c.source !== "creators") continue;
      if (c.personId === personId || (await personKey(ctx, memo, c.personId)) === key) mine.push(c);
    }
    const stamped =
      mine.find((c) => isStamped(c) && c.personId === personId) ?? mine.find(isStamped);
    const runRole = mergeRoles([...roles, ...(stamped ? [stamped.runRole ?? stamped.role] : [])]);
    const covers = (c: CreditRow) => mergeRoles([c.role, runRole]) === c.role;
    const row =
      stamped ??
      mine.find((c) => c.personId === personId) ??
      mine.find((c) => c.role === runRole) ??
      mine.find(covers) ??
      mine[0];
    if (row) {
      // Shown: a covering role stays until the run settles, so the row
      // doesn't drop to "author" between the batches of "author" and "art".
      const role = covers(row) ? row.role : runRole;
      await updateRow(ctx, row, { personId, rebuiltAt: Math.max(row.rebuiltAt, rebuiltAt), role, runRole });
    } else {
      await insertCredit(ctx, rows, { seriesId, personId, role: runRole, runRole, source: "creators", rebuiltAt });
    }
    count++;
  }
  return count;
}

/**
 * Stamp a PRH author line: the run's credits are the union of the Series'
 * lines, tallied on its run rows by name (`runNames`: roles, observations,
 * latest lastSeenAt per spelling key), never by person, so a spelling that
 * loses needs no person. A name goes on the row that already tallies its
 * spelling this run, else the row of the person its key names, else a row
 * whose person or tallied names are a near spelling (`nearKeys`); only a
 * name with none of these looks up (or creates) its person for a new row.
 * Two names on this line are never put on one row, and every pair of
 * them is remembered (`runApart`), so `settleRoles` keeps them two people
 * when it decides the Series' people and roles. Returns the credits
 * stamped.
 */
async function stampPrh(
  ctx: MutationCtx,
  args: StampArgs & { seenAt: number },
  memo: PublisherMemo,
) {
  const { seriesId, rows, rebuiltAt, seenAt } = args;
  const names = new Map<string, { name: string; roles: CreditRole[] }>();
  for (const credit of args.named) {
    const key = nameKey(credit.name);
    if (key === "") continue;
    const entry = names.get(key);
    if (entry) entry.roles.push(credit.role);
    else names.set(key, { name: credit.name, roles: [credit.role] });
  }
  const isStamped = (c: CreditRow) => c.rebuiltAt >= rebuiltAt;
  const tallied = (c: CreditRow) => (isStamped(c) ? (c.runNames ?? []) : []);
  const placed = new Map<string, CreditRow>();
  for (const [key, entry] of names) {
    const role = mergeRoles(entry.roles);
    const taken = new Set([...placed.values()].map((c) => c._id));
    const free = rows.filter((c) => c.source === "prh" && !taken.has(c._id));
    const row =
      free.find((c) => tallied(c).some((n) => nameKey(n.name) === key)) ??
      (await findFirst(free, async (c) => (await personKey(ctx, memo, c.personId)) === key)) ??
      (await findFirst(
        free,
        async (c) =>
          nearKeys(key, await personKey(ctx, memo, c.personId)) ||
          tallied(c).some((n) => nearKeys(key, nameKey(n.name))),
      ));
    if (row) {
      const tally = [...tallied(row)];
      const at = tally.findIndex((n) => nameKey(n.name) === key);
      const prior = tally[at];
      if (prior) {
        tally[at] = {
          name: prior.name,
          role: mergeRoles([prior.role, role]),
          count: prior.count + 1,
          seenAt: Math.max(prior.seenAt, seenAt),
        };
      } else {
        tally.push({ name: entry.name, role, count: 1, seenAt });
      }
      const runRole = mergeRoles(tally.map((n) => n.role));
      await updateRow(ctx, row, {
        rebuiltAt: Math.max(row.rebuiltAt, rebuiltAt),
        // Shown: a covering role stays until the run settles.
        role: mergeRoles([row.role, runRole]) === row.role ? row.role : runRole,
        runRole,
        runNames: tally,
        runApart: isStamped(row) ? (row.runApart ?? []) : [],
      });
      placed.set(key, row);
    } else {
      const doc = await insertCredit(ctx, rows, {
        seriesId,
        personId: await personNamed(ctx, entry.name, memo),
        role,
        runRole: role,
        source: "prh",
        rebuiltAt,
        runNames: [{ name: entry.name, role, count: 1, seenAt }],
        runApart: [],
      });
      placed.set(key, doc);
    }
  }
  // Names on one line are two people, near or not: a spelling near both
  // must not join them at settle.
  const keys = [...names.keys()];
  for (const [i, a] of keys.entries()) {
    for (const b of keys.slice(i + 1)) {
      const pair = [a, b].sort().join("|");
      for (const row of [placed.get(a), placed.get(b)]) {
        if (!row || (row.runApart ?? []).includes(pair)) continue;
        await updateRow(ctx, row, { runApart: [...(row.runApart ?? []), pair] });
      }
    }
  }
  return names.size;
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
 * The person a publisher's name means (`matchPerson` over the people its
 * `nameKey` finds), else a new row without an ANN id. Every name gets a
 * person: when ANN namesakes make it ambiguous, its own name-only one.
 */
async function personNamed(
  ctx: MutationCtx,
  name: string,
  memo: PublisherMemo,
): Promise<Id<"people">> {
  const exact = strictNameKey(name);
  const known = memo.people.get(exact);
  if (known !== undefined) return known;
  const key = nameKey(name);
  const rows = await ctx.db
    .query("people")
    .withIndex("by_nameKey", (q) => q.eq("nameKey", key))
    .take(NAME_ROWS);
  const match = matchPerson(name, rows);
  const personId = match?._id ?? (await insertPerson(ctx, name, key));
  memo.people.set(exact, personId);
  memo.keys.set(personId, key);
  return personId;
}

/**
 * Delete up to SWEEP_BATCH credits this run did not stamp: no observation
 * gives them any more. Only ANN's rows when `annOnly` (the run's publisher
 * pass failed part-way). A credit's stamp is its `seriesCreditRuns` row's;
 * a legacy credit with none still carries its own (schema.ts), and one
 * this run saw has lost it, so the legacy rows left carrying one are the
 * ones no run since has seen. Returns how many credits went.
 */
export const sweepCredits = internalMutation({
  args: { before: v.number(), annOnly: v.optional(v.boolean()) },
  handler: async (ctx, { before, annOnly }) => {
    const runs = annOnly
      ? await ctx.db
          .query("seriesCreditRuns")
          .withIndex("by_source_and_rebuiltAt", (q) =>
            q.eq("source", undefined).lt("rebuiltAt", before),
          )
          .take(SWEEP_BATCH)
      : await ctx.db
          .query("seriesCreditRuns")
          .withIndex("by_rebuiltAt", (q) => q.lt("rebuiltAt", before))
          .take(SWEEP_BATCH);
    for (const run of runs) {
      if (await ctx.db.get(run.creditId)) await ctx.db.delete(run.creditId);
      await ctx.db.delete(run._id);
    }
    const room = SWEEP_BATCH - runs.length;
    // `gte(0)`: a row without the field (every row since) sorts first.
    const legacy =
      room === 0
        ? []
        : annOnly
          ? await ctx.db
              .query("seriesCredits")
              .withIndex("by_source_and_rebuiltAt", (q) =>
                q.eq("source", undefined).gte("rebuiltAt", 0).lt("rebuiltAt", before),
              )
              .take(room)
          : await ctx.db
              .query("seriesCredits")
              .withIndex("by_rebuiltAt", (q) => q.gte("rebuiltAt", 0).lt("rebuiltAt", before))
              .take(room);
    for (const row of legacy) await ctx.db.delete(row._id);
    return runs.length + legacy.length;
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
    const { docs, next } = await peopleAfter(ctx, afterPublicId, STATS_BATCH);
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
    return { next, count: docs.length };
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
/** Work per action before it continues in a fresh one (actions run ≤30 min). */
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
    const docs = await annMangaAfter(ctx, after, BACKFILL_SCAN);
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
        coverIsbn: statsCoverIsbns(stats),
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
