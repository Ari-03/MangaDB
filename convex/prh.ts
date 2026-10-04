// The PRH API adapter (spec §6/§7): overlays authoritative
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
// uncapped full sweep; a listed entry the parser drops still counts as
// present (notePresent), and one with no readable ISBN voids completeness.
//
// Configuration (no live key exists in this repo — see docs/imports.md):
//   PRH_API_KEY        the Enhanced API key (manual activation by PRH)
//   PRH_IMPRINT_CODES  comma-separated imprint codes to mirror (verify the
//                      codes against /title/domains/PRH.US/imprints once a
//                      key is active)
// Without a key and a non-empty imprint list (PRH_IMPRINT_CODES or the
// `imprints` argument), a fresh call skips as "unconfigured" and opens no
// run. A link the sync hands off carries its imprint list in its arguments,
// so removing PRH_IMPRINT_CODES mid-run has no effect on it. A link that
// finds PRH_API_KEY gone closes its run as failed, except an automatic run
// on a disabled source, which the gate stops first (as "stopped").
//
// Disabling the source follows the shared rule (lib/importRuns.ts): the gate
// is checked at each link, before each list page and before the withdrawal
// pass, so a scheduled run stops as "stopped" and withdraws nothing, while a
// forced run imports and withdraws only after a complete full sweep.
//
// The API cannot filter by date (lib/prh.ts), so future mode pages an
// imprint newest-first and cuts off at today client-side.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { applyCatalogTitle } from "./lib/catalogTitle";
import type { ApplyResult } from "./lib/unmatched";
import { todaySortKey } from "./lib/dates";
import { errorMessage, politeFetch } from "./lib/http";
import { closeRun, registryRow, runToContinue, stampHandOff, stopAtGate } from "./lib/importRuns";
import { getObservation, markSeen } from "./lib/observations";
import { applyRetrying } from "./lib/occ";
import { toPartialDate } from "./lib/pipeline";
import { parseTitleList, prhTitleValidator } from "./lib/prh";
import { withExceptionCapture } from "./lib/posthog";

export const SOURCE_KEY = "prh";
const API_BASE = "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US";
const IMPORT_COMMENT = "Imported from the Penguin Random House API.";
const ROWS_PER_PAGE = 200;
/** Per-link wall-clock budget, well inside Convex's 30-minute action limit. */
const LINK_BUDGET_MS = 4 * 60 * 1000;
/** The list endpoint's content zoom: each title embeds its flap copy (lib/prh.ts). */
const CONTENT_ZOOM = "https://api.penguinrandomhouse.com/title/titles/content/definition";

// ---------- the sync action ----------

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
      /** This link ran out of time budget and scheduled the next one. */
      continued?: true;
      stopped?: true;
    };

/**
 * One link of a PRH import run. Daily runs filter future-dated titles
 * client-side; UTC-Sunday runs (or {mode: "full"}) sweep each configured
 * imprint's whole catalog. A full sweep is far longer than one action may
 * run (14 imprints, up to 50 pages of 200 titles each), so a link hands off
 * to the next through the scheduler at a page boundary once it has used its
 * time budget; continuation links carry the run state.
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
    /** Wall-clock budget per link before handing off; tests pass 0 to force a hand-off. */
    linkBudgetMs: v.optional(v.number()),
    // ----- continuation state (never passed by callers) -----
    runId: v.optional(v.id("importRuns")),
    runStartedAt: v.optional(v.number()),
    imprintIndex: v.optional(v.number()),
    start: v.optional(v.number()),
    pages: v.optional(v.number()),
    seen: v.optional(v.number()),
    changed: v.optional(v.number()),
    recordFailures: v.optional(v.number()),
    completeSweep: v.optional(v.boolean()),
    errors: v.optional(v.array(v.string())),
    /**
     * Set on every link this sync hands off. A continuation without it was
     * scheduled by an older sync whose applies refused writes once the
     * source was disabled, so a title its earlier pages listed may never
     * have been observed: such a chain finishes, but its sweep counts as
     * incomplete and never withdraws. The marker can go once no chain
     * scheduled before it can still be queued.
     */
    observedEveryPage: v.optional(v.literal(true)),
  },
  handler: async (ctx, args): Promise<SyncResult> =>
    withExceptionCapture("prh.sync", ctx, async () => {
      const linkStartedAt = Date.now();
      const source = await registryRow(ctx, SOURCE_KEY);
      const apiKey = process.env.PRH_API_KEY;
      const configured = (process.env.PRH_IMPRINT_CODES ?? "")
        .split(",")
        .map((code) => code.trim())
        .filter((code) => code !== "");
      const imprints = args.imprints ?? configured;
      const unconfigured = !apiKey || imprints.length === 0;
      if (unconfigured) {
        console.warn(
          "[imports] PRH adapter is unconfigured (set PRH_API_KEY and PRH_IMPRINT_CODES) — skipping",
        );
        if (args.runId === undefined) return { skipped: "unconfigured" as const };
      }
      // A continuation's gate comes before its configuration. An automatic
      // run on a disabled source stops here, so an operator who disabled the
      // source gets no failure alert for it. Every other run that lost its
      // configuration fails below: a forced run on a disabled source, or any
      // run on an enabled one.
      const runId = await runToContinue(ctx, source, args);
      if (runId === null) return { skipped: "disabled" as const };
      // A run that lost its configuration between links must not stay open
      // forever: it closes as failed, saying why.
      if (unconfigured) {
        await closeRun(ctx, runId, "failed", {
          seen: args.seen ?? 0,
          changed: args.changed ?? 0,
          errors: [
            ...(args.errors ?? []),
            "Stopped mid-run: PRH_API_KEY / PRH_IMPRINT_CODES were removed.",
          ],
        });
        return { skipped: "unconfigured" as const };
      }
      const mode: "future" | "full" =
        args.mode ?? (new Date().getUTCDay() === 0 ? "full" : "future");
      const runStartedAt = args.runStartedAt ?? linkStartedAt;
      const delay = args.politeDelayMs ?? 350;
      const maxPages = args.maxPages ?? 50;
      const linkBudgetMs = args.linkBudgetMs ?? LINK_BUDGET_MS;
      const errors: string[] = [...(args.errors ?? [])];
      let seen = args.seen ?? 0;
      let changed = args.changed ?? 0;
      let recordFailures = args.recordFailures ?? 0;
      // A subset sweep can't prove absence, so it never withdraws; nor can a
      // continuation without `observedEveryPage` (every continuation carries
      // runStartedAt).
      const unmarkedContinuation =
        args.runStartedAt !== undefined && args.observedEveryPage !== true;
      let completeSweep =
        !unmarkedContinuation &&
        (args.completeSweep ?? (mode === "full" && args.imprints === undefined));
      const todayKey = todaySortKey();
      const firstImprint = args.imprintIndex ?? 0;
      // Schedule the next link with the run state. The EFFECTIVE imprint list
      // travels with it: a configured list re-read from the environment could
      // change between links and shift imprintIndex onto another imprint.
      const handOff = async (
        imprintIndex: number,
        start: number,
        pages: number,
      ): Promise<SyncResult> => {
        await stampHandOff(ctx, runId, { seen, changed, errors });
        await ctx.scheduler.runAfter(0, internal.prh.sync, {
          mode,
          imprints,
          maxPages: args.maxPages,
          politeDelayMs: args.politeDelayMs,
          linkBudgetMs: args.linkBudgetMs,
          runId,
          runStartedAt,
          imprintIndex,
          start,
          pages,
          seen,
          changed,
          recordFailures,
          completeSweep,
          errors,
          observedEveryPage: true,
        });
        return {
          runId,
          recordsSeen: seen,
          recordsChanged: changed,
          mode,
          completeSweep: false,
          errorCount: errors.length,
          continued: true,
        };
      };

      try {
        for (let index = firstImprint; index < imprints.length; index++) {
          const imprint = imprints[index]!;
          // A continuation link resumes its imprint mid-listing.
          let start = index === firstImprint ? (args.start ?? 0) : 0;
          let pages = index === firstImprint ? (args.pages ?? 0) : 0;
          for (;;) {
            if (pages >= maxPages) {
              completeSweep = false;
              break;
            }
            const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
            if (stopped) return { ...stopped, mode, completeSweep: false };
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
            const { titles, dropped, recordCount, rawCount } = parseTitleList(await res.json());
            pages++;
            if (rawCount === 0 && recordCount !== undefined && start < recordCount) {
              throw new Error("PRH returned an empty page before its reported record count");
            }

            // A listed entry is present whether or not it parsed: bump
            // its observation's last-seen so a full sweep never withdraws a
            // record PRH still lists. An entry with no readable ISBN could be
            // any record, so the sweep can no longer prove absence.
            const presentIsbns = dropped.flatMap((d) => (d.isbn13 !== undefined ? [d.isbn13] : []));
            if (presentIsbns.length > 0) {
              await ctx.runMutation(internal.prh.notePresent, { isbns: presentIsbns });
            }
            for (const d of dropped) {
              if (d.isbn13 === undefined) completeSweep = false;
              if (d.reason === "malformed") {
                errors.push(
                  `malformed ${d.isbn13 ?? "record without an ISBN"}: dropped by the parser`,
                );
              }
            }

            // Newest-first, so the first title dated before today ends the
            // imprint; undated titles neither apply nor end it.
            const pastReached =
              mode === "future" &&
              titles.some((t) => t.onsale !== undefined && toPartialDate(t.onsale).sort < todayKey);
            const toApply =
              mode === "future"
                ? titles.filter(
                    (t) => t.onsale !== undefined && toPartialDate(t.onsale).sort >= todayKey,
                  )
                : titles;

            for (const snapshot of toApply) {
              seen++;
              try {
                const result = await applyRetrying(ctx, internal.prh.applyTitle, {
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
            if (Date.now() - linkStartedAt >= linkBudgetMs)
              return await handOff(index, start, pages);
          }
          // An imprint that fits on one page never reaches the check above; a
          // sweep of many small imprints would run past the action limit.
          if (index + 1 < imprints.length && Date.now() - linkStartedAt >= linkBudgetMs) {
            return await handOff(index + 1, 0, 0);
          }
        }
        // Disappearance → withdrawn, only after a COMPLETE full-catalog sweep
        // (absence is never evidence on a future-only or capped run) by a run
        // the gate still lets go on.
        if (mode === "full" && completeSweep) {
          const stopped = await stopAtGate(ctx, runId, source.key, { seen, changed, errors });
          if (stopped) return { ...stopped, mode, completeSweep: false };
          await ctx.runMutation(internal.imports.markWithdrawn, {
            sourceKey: SOURCE_KEY,
            notSeenSince: runStartedAt,
          });
        }

        const status = recordFailures > 0 ? "failed" : "succeeded";
        return {
          ...(await closeRun(ctx, runId, status, { seen, changed, errors })),
          mode,
          completeSweep: mode === "full" && completeSweep,
        };
      } catch (e) {
        // politeFetch errors quote the request URL, api_key included; run
        // errors are operator-visible, so the key never reaches them.
        errors.push(redactKey(errorMessage(e)));
        return {
          ...(await closeRun(ctx, runId, "failed", { seen, changed, errors })),
          mode,
          completeSweep: false,
        };
      }
    }),
});

// ---------- listing presence ----------

/**
 * Note listed ISBNs that produced no snapshot (malformed or out of scope):
 * presence bumps last-seen, clears a withdrawn mark and retires the
 * possible-cancellation review that withdrawal queued, exactly as an
 * unchanged fetch does (lib/observations.ts). ISBNs never imported are
 * ignored.
 */
export const notePresent = internalMutation({
  args: { isbns: v.array(v.string()) },
  handler: async (ctx, { isbns }) => {
    const now = Date.now();
    for (const isbn of isbns) {
      const obs = await getObservation(ctx, SOURCE_KEY, isbn);
      if (!obs) continue;
      await markSeen(ctx, obs, now);
    }
    return null;
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
