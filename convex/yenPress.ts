// The Yen Press adapter: Yen's own catalog (Yen Press + Ize Press) from
// yenpress.com's public sitemap and title pages (lib/yenPress.ts). Yen is
// Hachette-distributed, so neither PRH nor any other source here carried
// it; before this adapter its books reached the catalog only through
// OpenLibrary's patchy records.
//
// One run: fetch the sitemap, plan title URLs by ISBN (some print and
// digital ISBNs share one page), skip slugs that name prose/audio, and
// fetch each remaining page that is new or due — at most one request per
// second. A page yields one snapshot per format; every snapshot is
// observed (keyed on its ISBN — the fetch state), and in-scope ones go
// through the shared catalog-title placement (lib/catalogTitle.ts): the
// matching ladder, authority reconciliation at Yen's own-catalog
// authority, or the creation boundaries under the imprint's publisher row.
//
// Incremental: a book whose ISBNs are all observed is re-fetched only when
// due — weekly while its date is upcoming or recent (dates move), every
// ~6 months otherwise. A run spends a bounded number of fetches per
// action invocation and chains itself (cursor = the last slug/ISBN handled).
// The sitemap has no lastmod and pages are skipped when fresh, so absence
// proves nothing: this adapter never marks observations withdrawn.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { applyCatalogTitle, type ApplyResult } from "./lib/catalogTitle";
import { errorMessage, politeFetch } from "./lib/http";
import { runToContinue } from "./lib/importRuns";
import { getObservation, upsertObservation } from "./lib/observations";
import {
  skipsWithoutFetch,
  parseSitemap,
  parseTitlePage,
  toSnapshots,
  yenTitleValidator,
  type YenTitleSnapshot,
} from "./lib/yenPress";

export const SOURCE_KEY = "yenpress";
const SITEMAP_URL = "https://yenpress.com/sitemap.xml";
const IMPORT_COMMENT = "Imported from Yen Press (yenpress.com).";

/** One request per second, like ANN — a publisher's own web server. */
const YEN_DELAY_MS = 1100;
/** Page fetches per action invocation before it hands off (~1.1 s each). */
const DEFAULT_MAX_FETCHES = 300;
/** ISBNs whose freshness one planning query checks. */
const PLAN_CHUNK = 100;
/** Errors carried across continuation links. */
const MAX_CARRIED_ERRORS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upcoming or recent books: dates still move, so re-check weekly. */
const RECENT_REFRESH_MS = 7 * DAY_MS;
/** How far back "recent" reaches. */
const RECENT_WINDOW_MS = 60 * DAY_MS;
/** Backlist books: a slow rolling refresh. */
const BACKLIST_REFRESH_MS = 180 * DAY_MS;

// ---------- planning ----------

/** Is this stored snapshot's page due for another fetch? */
function isDue(snapshot: YenTitleSnapshot, lastSeenAt: number, now: number): boolean {
  const onsale = snapshot.onsale;
  const recent =
    onsale === undefined ||
    Date.UTC(onsale.year, onsale.month - 1, onsale.day) >= now - RECENT_WINDOW_MS;
  return now - lastSeenAt > (recent ? RECENT_REFRESH_MS : BACKLIST_REFRESH_MS);
}

/**
 * Which of these books (ISBN groups, one per slug) need a page fetch: a book
 * any of whose ISBNs is unobserved or due. Print and digital share a page, so
 * a format listed after the other was observed is fetched straight away
 * rather than waiting for the older observation to expire.
 */
export const booksToFetch = internalQuery({
  args: { books: v.array(v.array(v.string())), now: v.number() },
  handler: async (ctx, { books, now }) => {
    const due: number[] = [];
    for (const [i, isbns] of books.entries()) {
      for (const isbn of isbns) {
        const obs = await getObservation(ctx, SOURCE_KEY, isbn);
        if (!obs || isDue(obs.snapshot as YenTitleSnapshot, obs.lastSeenAt, now)) {
          due.push(i);
          break;
        }
      }
    }
    return due;
  },
});

// ---------- the sync action ----------

type SyncResult =
  | { skipped: "disabled" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      fetched: number;
      continued: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One link of a Yen Press run. Called with no args by the cadence
 * dispatcher; continuation links carry the run state.
 *
 *   npx convex run yenPress:sync '{}'
 */
export const sync = internalAction({
  args: {
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
    /** Page fetches per invocation before continuing. */
    maxFetches: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    afterSlug: v.optional(v.string()),
    runId: v.optional(v.id("importRuns")),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    fetched: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    pageFailed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        "The approved-source registry has no \"yenpress\" row. Run: npx convex run importSources:seedRegistry '{}'",
      );
    }
    const runId = await runToContinue(ctx, source, args);
    if (runId === null) return { skipped: "disabled" as const };
    const delay = args.politeDelayMs ?? YEN_DELAY_MS;
    const maxFetches = args.maxFetches ?? DEFAULT_MAX_FETCHES;
    const errors = [...(args.errors ?? [])];
    let pageFailed = args.pageFailed ?? false;
    let seen = args.seen ?? 0;
    let changed = args.changed ?? 0;
    let fetchedTotal = args.fetched ?? 0;
    let fetchedHere = 0;
    let lastSlug = args.afterSlug;

    try {
      const sitemap = await (await politeFetch(SITEMAP_URL, delay)).text();
      // A shared slug does not guarantee a shared page: older titles can
      // expose print and digital separately. Plan every ISBN, and suppress
      // another fetch only after that ISBN was actually observed.
      const books = new Map(
        parseSitemap(sitemap)
          .filter((entry) => !skipsWithoutFetch(entry.slug))
          .map((entry) => [`${entry.slug}/${entry.isbn13}`, entry] as const),
      );
      if (books.size === 0) throw new Error("Yen sitemap contained no eligible title URLs");
      const slugs = [...books.keys()]
        .sort()
        .filter((key) => args.afterSlug === undefined || key > args.afterSlug);
      const observedHere = new Set<string>();

      let budgetSpent = false;
      for (let offset = 0; offset < slugs.length && !budgetSpent; offset += PLAN_CHUNK) {
        const chunk = slugs.slice(offset, offset + PLAN_CHUNK);
        const due: number[] = await ctx.runQuery(internal.yenPress.booksToFetch, {
          books: chunk.map((slug) => [books.get(slug)!.isbn13]),
          now: Date.now(),
        });
        const dueSet = new Set(due);
        for (const [i, slug] of chunk.entries()) {
          if (!dueSet.has(i) || observedHere.has(books.get(slug)!.isbn13)) {
            lastSlug = slug;
            continue;
          }
          if (fetchedHere >= maxFetches) {
            budgetSpent = true;
            break;
          }
          const book = books.get(slug)!;
          fetchedHere++;
          fetchedTotal++;
          try {
            const res = await politeFetch(book.url, delay);
            const page = parseTitlePage(await res.text());
            if (!page) {
              pageFailed = true;
              errors.push(`page ${book.url}: not a title page`);
            } else {
              const snapshots = toSnapshots(page, book.url);
              if (snapshots.length === 0) {
                pageFailed = true;
                errors.push(`page ${book.url}: no usable ISBNs`);
              }
              for (const snapshot of snapshots) {
                seen++;
                const result = await ctx.runMutation(internal.yenPress.applyTitle, { snapshot });
                observedHere.add(snapshot.isbn13);
                if (result.changed) changed++;
                if (result.status === "needsReview") {
                  errors.push(`review ${snapshot.isbn13}: ${result.reason ?? "conflict"}`);
                }
              }
            }
          } catch (e) {
            // A removed title (404) or a transient failure: the book stays
            // unobserved/due and is retried next run.
            pageFailed = true;
            errors.push(`page ${book.url}: ${errorMessage(e)}`);
          }
          lastSlug = slug;
        }
      }

      if (budgetSpent) {
        await ctx.scheduler.runAfter(0, internal.yenPress.sync, {
          politeDelayMs: args.politeDelayMs,
          maxFetches: args.maxFetches,
          afterSlug: lastSlug,
          runId,
          seen,
          changed,
          fetched: fetchedTotal,
          errors: errors.slice(0, MAX_CARRIED_ERRORS),
          pageFailed,
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          fetched: fetchedTotal,
          continued: true,
          errorCount: errors.length,
        };
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: pageFailed ? "failed" : "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        fetched: fetchedTotal,
        continued: false,
        failed: pageFailed || undefined,
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
        fetched: fetchedTotal,
        continued: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one title ----------

/**
 * Observe one Yen title (per format) and, when in scope, place it through
 * the shared catalog-title pipeline. Out-of-scope books (light novels,
 * audio, western comics) are observed only — the record of having fetched
 * them. One atomic mutation per record (spec §6).
 */
export const applyTitle = internalMutation({
  args: { snapshot: yenTitleValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> => {
    if (snapshot.outOfScope !== undefined) {
      const { changed } = await upsertObservation(ctx, {
        sourceKey: SOURCE_KEY,
        sourceRecordId: snapshot.isbn13,
        snapshot,
        now: Date.now(),
      });
      return { status: "recordOnly", changed, reason: snapshot.outOfScope };
    }
    return await applyCatalogTitle(ctx, {
      sourceKey: SOURCE_KEY,
      defaultSourceName: "Yen Press",
      importComment: IMPORT_COMMENT,
      snapshot,
    });
  },
});
