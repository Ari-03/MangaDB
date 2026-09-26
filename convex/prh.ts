// The PRH API adapter (ticket #36, spec §6/§7): overlays authoritative
// onsale dates and ISBNs on PRH-distributed records — Kodansha, Seven Seas,
// Dark Horse, Square Enix, Denpa, Vertical Comics, and the rest of PRH
// Publisher Services (VIZ is not PRH-distributed). The API only returns
// titles PRH distributes, so PRH values can only land on PRH-distributed
// records — but a distributed imprint can still publish prose or
// merchandise, so the parser gates scope per title (lib/prh.ts). Per the
// authority table its dates, ISBNs, and prices apply at authoritative rank,
// titles/creators/format and the flap-copy blurb (the Release Description,
// embedded via the list's content zoom) at standard. Titles resolve to
// their base Series through the shared parser: omnibus/deluxe books become
// Edition Line members covering real Volumes, box sets Release Bundles.
//
// Cadence (spec §6): daily future-dated + weekly full sweep. The registry
// row ticks daily; the adapter widens to a full sweep on UTC Sundays (or
// with {mode: "full"}). Withdrawal marks fire only after a complete,
// uncapped full sweep.
//
// Configuration (no live key exists in this repo — see README):
//   PRH_API_KEY        the Enhanced API key (manual activation by PRH)
//   PRH_IMPRINT_CODES  comma-separated imprint codes to mirror (verify the
//                      codes against /title/domains/PRH.US/imprints once a
//                      key is active)
// Without both, a run is skipped as "unconfigured" — never a failure.
//
// Only the imprint-scoped path filters: the flat /titles endpoint silently
// IGNORES its `imprint` and `onsaleFrom` params (re-verified live
// 2026-09-25: every "imprint=" query returns the whole ~313k-title domain,
// and sorting that set 504s). Future mode therefore pages an imprint
// newest-first and cuts off at today client-side.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { applyCatalogTitle, type ApplyResult } from "./lib/catalogTitle";
import { todaySortKey } from "./lib/dates";
import { errorMessage, politeFetch } from "./lib/http";
import { parseTitleList, prhTitleValidator } from "./lib/prh";

export const SOURCE_KEY = "prh";
const API_BASE = "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US";
const IMPORT_COMMENT = "Imported from the Penguin Random House API.";
const ROWS_PER_PAGE = 200;
/** The list endpoint's content zoom: each title embeds its flap copy (lib/prh.ts). */
const CONTENT_ZOOM = "https://api.penguinrandomhouse.com/title/titles/content/definition";

// ---------- the sync action ----------

/** An onsale date as a yyyymmdd number, comparable to `todaySortKey()`. */
function dateKey(date: { year: number; month: number; day: number }): number {
  return date.year * 10000 + date.month * 100 + date.day;
}

/** Masks the api_key query value in a message (fetch errors quote URLs). */
export function redactKey(message: string): string {
  return message.replace(/(api_key=)[^&\s]+/g, "$1…");
}

type SyncResult =
  | { skipped: "disabled" | "unconfigured" }
  | {
      runId: Id<"importRuns">;
      recordsSeen: number;
      recordsChanged: number;
      mode: "future" | "full";
      completeSweep: boolean;
      errorCount: number;
      failed?: boolean;
    };

/**
 * One PRH import run. Daily runs filter future-dated titles client-side;
 * UTC-Sunday runs (or {mode: "full"}) sweep each configured
 * imprint's whole catalog.
 *
 *   npx convex run prh:sync '{"mode":"full"}'
 */
export const sync = internalAction({
  args: {
    mode: v.optional(v.union(v.literal("future"), v.literal("full"))),
    /**
     * Operator override: sweep only these imprint codes (e.g. one at a time
     * to stay inside the action time limit). A subset sweep forfeits the
     * withdrawal pass, like a capped one.
     */
    imprints: v.optional(v.array(v.string())),
    /** Cap list pages per imprint (a cap forfeits the withdrawal pass). */
    maxPages: v.optional(v.number()),
    /** Pause before every request; tests pass 0. */
    politeDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    // Explicit annotations break the type cycle with imports.ts's adapter map.
    const source: Doc<"approvedSources"> | null = await ctx.runQuery(
      internal.importSources.getByKey,
      { key: SOURCE_KEY },
    );
    if (!source) {
      throw new Error(
        "The approved-source registry has no \"prh\" row. Run: npx convex run importSources:seedRegistry '{}'",
      );
    }
    if (!source.enabled) return { skipped: "disabled" as const };

    const apiKey = process.env.PRH_API_KEY;
    const configured = (process.env.PRH_IMPRINT_CODES ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code !== "");
    const imprints = args.imprints ?? configured;
    if (!apiKey || imprints.length === 0) {
      console.warn(
        "[imports] PRH adapter is unconfigured (set PRH_API_KEY and PRH_IMPRINT_CODES) — skipping",
      );
      return { skipped: "unconfigured" as const };
    }

    const mode: "future" | "full" = args.mode ?? (new Date().getUTCDay() === 0 ? "full" : "future");
    const runId: Id<"importRuns"> = await ctx.runMutation(internal.imports.startRun, {
      sourceKey: SOURCE_KEY,
    });
    const runStartedAt = Date.now();
    const delay = args.politeDelayMs ?? 350;
    const maxPages = args.maxPages ?? 50;
    const errors: string[] = [];
    let seen = 0;
    let changed = 0;
    let recordFailures = 0;
    // A subset sweep can't prove absence, so it never withdraws.
    let completeSweep = mode === "full" && args.imprints === undefined;
    const todayKey = todaySortKey();

    try {
      for (const imprint of imprints) {
        let start = 0;
        let pages = 0;
        for (;;) {
          if (pages >= maxPages) {
            completeSweep = false;
            break;
          }
          const params = new URLSearchParams({
            api_key: apiKey,
            rows: String(ROWS_PER_PAGE),
            start: String(start),
            sort: "onsale",
            dir: mode === "future" ? "desc" : "asc",
            // Embeds each title's flap copy: the blurb, with no extra request.
            zoom: CONTENT_ZOOM,
          });
          const res = await politeFetch(
            `${API_BASE}/imprints/${encodeURIComponent(imprint)}/titles?${params}`,
            delay,
          );
          const { titles, recordCount, rawCount } = parseTitleList(await res.json());
          pages++;
          if (rawCount === 0 && recordCount !== undefined && start < recordCount) {
            throw new Error("PRH returned an empty page before its reported record count");
          }

          // Newest-first, so the first title dated before today ends the
          // imprint; undated titles neither apply nor end it.
          const pastReached =
            mode === "future" &&
            titles.some((t) => t.onsale !== undefined && dateKey(t.onsale) < todayKey);
          const toApply =
            mode === "future"
              ? titles.filter((t) => t.onsale !== undefined && dateKey(t.onsale) >= todayKey)
              : titles;

          for (const snapshot of toApply) {
            seen++;
            try {
              const result = await ctx.runMutation(internal.prh.applyTitle, {
                snapshot,
              });
              if (result.changed) changed++;
              if (result.status === "needsReview") {
                errors.push(`review ${snapshot.isbn13}: ${result.reason ?? "conflict"}`);
              }
            } catch (e) {
              recordFailures++;
              completeSweep = false;
              errors.push(`title ${snapshot.isbn13}: ${redactKey(errorMessage(e))}`);
            }
          }

          start += ROWS_PER_PAGE;
          const exhausted =
            rawCount === 0 || (recordCount !== undefined && start >= recordCount) || pastReached;
          if (exhausted) break;
        }
      }

      // Disappearance → withdrawn, only after a COMPLETE full-catalog sweep
      // (absence is never evidence on a future-only or capped run).
      if (mode === "full" && completeSweep) {
        await ctx.runMutation(internal.imports.markWithdrawn, {
          sourceKey: SOURCE_KEY,
          notSeenSince: runStartedAt,
        });
      }

      await ctx.runMutation(internal.imports.finishRun, {
        runId,
        status: recordFailures > 0 ? "failed" : "succeeded",
        recordsSeen: seen,
        recordsChanged: changed,
        errors,
      });
      return {
        runId,
        recordsSeen: seen,
        recordsChanged: changed,
        mode,
        completeSweep: mode === "full" && completeSweep,
        errorCount: errors.length,
        ...(recordFailures > 0 ? { failed: true } : {}),
      };
    } catch (e) {
      // politeFetch errors quote the request URL, api_key included; run
      // errors are operator-visible, so the key never reaches them.
      errors.push(redactKey(errorMessage(e)));
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
        mode,
        completeSweep: false,
        errorCount: errors.length,
        failed: true,
      };
    }
  },
});

// ---------- applying one title ----------

/**
 * Reconcile one PRH title into the canonical catalog — the overlay: ISBN
 * matching links it to the existing skeleton record, then authoritative
 * dates/ISBNs/prices and standard titles/format reconcile in. Unmatched
 * titles follow the standard creation boundaries under the imprint's
 * publisher (lib/catalogTitle.ts). One atomic mutation per record (spec §6).
 */
export const applyTitle = internalMutation({
  args: { snapshot: prhTitleValidator },
  handler: async (ctx, { snapshot }): Promise<ApplyResult> =>
    await applyCatalogTitle(ctx, {
      sourceKey: SOURCE_KEY,
      defaultSourceName: "Penguin Random House API",
      importComment: IMPORT_COMMENT,
      snapshot,
    }),
});
