// Quick actions on a cover: Want / Ordered / Own and Mark read, revealed on
// hover over any shelved book (Series page reading paths, the library's path
// shelves), so a whole run can be marked without opening each Edition page.
// The badges the cover wears come from the same picture. Everything reads
// the signed-in overlay (collection.seriesEntries + reading.seriesTracking)
// and writes through the existing entry and read mutations, so the rules are
// exactly those of the Edition page: one state per entry, clicking the
// current state removes it, a state change keeps the entry's pinned Variant,
// and reading never changes a Series status — a first entry or a fully read
// Series only *prompts*, in the shelf's prompt area.

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CoverBadge } from "~/lib/cover";
import { FollowPrompt, type FollowSuggestion } from "~/lib/follows";
import { CompletedPrompt, type SeriesSuggestion } from "~/lib/reading";

export type EntryState = "wanted" | "ordered" | "owned";

export const ENTRY_STATES: EntryState[] = ["wanted", "ordered", "owned"];

export const ENTRY_LABELS: Record<EntryState, string> = {
  wanted: "Wanted",
  ordered: "Ordered",
  owned: "Owned",
};

// Verb forms for the buttons themselves.
const QUICK_LABELS: Record<EntryState, string> = {
  wanted: "Want",
  ordered: "Order",
  owned: "Own",
};

/** What the quick actions and badges need to know about one shelved book. */
export type QuickBook = {
  editionPublicId: number;
  /** The Release the state buttons write to; null when the book has none. */
  targetReleaseId: Id<"releases"> | null;
  /** The direct Collection Entry's state, if any. */
  state: EntryState | null;
  /** Owned through an Owned box set (Derived Ownership). */
  derivedOwned: boolean;
  /** Whether every completely covered Volume is read; null when none is. */
  read: boolean | null;
};

/**
 * The signed-in overlay for one Series: collection entries by Release plus
 * the per-Volume read counts. Null while loading, signed out, or when the
 * Series is unknown — the shelf then renders without badges or actions.
 * Both queries dedupe across the shelf's items in the Convex client, so
 * every book subscribing costs one subscription each.
 */
export type SeriesOverlay = NonNullable<
  FunctionReturnType<typeof api.collection.seriesEntries>
> & { volumesRead: ReadonlyMap<number, number> };

export function useSeriesOverlay(seriesPublicId: number): SeriesOverlay | null {
  const entries = useQuery(api.collection.seriesEntries, { seriesPublicId });
  const tracking = useQuery(api.reading.seriesTracking, { seriesPublicId });
  if (!entries || !tracking) return null;
  return {
    ...entries,
    volumesRead: new Map(
      tracking.volumes.map((volume) => [volume.volumePublicId, volume.readCount]),
    ),
  };
}

/** The Series-page book shape the overlay is read against. */
export type OverlayBook = {
  publicId: number;
  releases: ReadonlyArray<{ id: string; format: "physical" | "digital" }>;
  coverage: ReadonlyArray<{ volumePublicId: number; extent: "complete" | "partial" }>;
};

/**
 * Read one book's picture off the overlay. A book with several Releases
 * (print and digital) addresses the one that already has an entry, else the
 * viewer's preferred format (print when the preference is "both"), else the
 * first — so a quick click lands where the Edition page's controls would.
 */
export function quickBookFor(book: OverlayBook, overlay: SeriesOverlay): QuickBook {
  const ids = book.releases.map((release) => release.id as Id<"releases">);
  const entry = overlay.entries.find((row) => ids.includes(row.releaseId)) ?? null;
  const preferred =
    overlay.formatPreference === "both" ? "physical" : overlay.formatPreference;
  const target =
    entry?.releaseId ??
    (book.releases.find((release) => release.format === preferred)?.id as
      | Id<"releases">
      | undefined) ??
    ids[0] ??
    null;
  const complete = book.coverage.filter((cov) => cov.extent === "complete");
  return {
    editionPublicId: book.publicId,
    targetReleaseId: target,
    state: entry?.state ?? null,
    derivedOwned: ids.some((id) => overlay.derivedOwned.includes(id)),
    read:
      complete.length === 0
        ? null
        : complete.every((cov) => (overlay.volumesRead.get(cov.volumePublicId) ?? 0) > 0),
  };
}

/** The badges a cover wears for this picture, or undefined for none. */
export function bookBadges(book: QuickBook): ReactNode | undefined {
  const state = book.state ?? (book.derivedOwned ? "owned" : null);
  if (!state && !book.read) return undefined;
  return (
    <>
      {state ? (
        <CoverBadge
          state={state}
          label={!book.state && book.derivedOwned ? "In box set" : undefined}
        />
      ) : null}
      {book.read ? <CoverBadge state="read" /> : null}
    </>
  );
}

/** The prompts a shelf's quick actions can raise; rendered by ShelfPrompts. */
export type ShelfPromptState = {
  follow: FollowSuggestion[];
  completed: SeriesSuggestion[];
};

export const NO_PROMPTS: ShelfPromptState = { follow: [], completed: [] };

/**
 * The shelf's prompt area: the post-first-entry follow prompt and the
 * fully-read "mark Completed?" prompt, both non-blocking and both acting
 * only through their own confirm buttons.
 */
export function ShelfPrompts({
  prompts,
  onChange,
}: {
  prompts: ShelfPromptState;
  onChange: (next: ShelfPromptState) => void;
}) {
  if (prompts.follow.length === 0 && prompts.completed.length === 0) return null;
  return (
    <div className="shelf-prompts">
      <FollowPrompt
        suggestions={prompts.follow}
        onDone={() => onChange({ ...prompts, follow: [] })}
      />
      <CompletedPrompt
        suggestions={prompts.completed}
        onDone={() => onChange({ ...prompts, completed: [] })}
      />
    </div>
  );
}

/**
 * The hover controls on one cover: the three collection states (the active
 * one pressed; pressing it again removes the entry) and the read toggle for
 * books with completely covered Volumes. Sits inside `.cover-wrap`, after
 * the cover link, so the shelf's hover reveals it.
 */
export function BookQuickActions({
  book,
  onPrompt,
}: {
  book: QuickBook;
  onPrompt: (prompts: Partial<ShelfPromptState>) => void;
}) {
  // The batch write with one Release: unlike setReleaseEntry (where an
  // omitted variantId clears the pin), it changes only the state and keeps
  // a pinned Variant, read inside the same transaction.
  const setEntries = useMutation(api.collection.setManyReleaseEntries);
  const setRead = useMutation(api.reading.setEditionRead);
  const pick = (state: EntryState) => {
    if (!book.targetReleaseId) return;
    void setEntries({
      releaseIds: [book.targetReleaseId],
      state: book.state === state ? undefined : state,
    }).then((result) => {
      if (result.suggestFollow.length > 0) onPrompt({ follow: result.suggestFollow });
    });
  };
  return (
    <div className="cover-actions" role="group" aria-label="Quick actions">
      <div className="cover-actions-row">
        {ENTRY_STATES.map((state) => (
          <button
            key={state}
            type="button"
            className="quick-btn"
            aria-pressed={book.state === state}
            disabled={book.targetReleaseId === null}
            title={
              book.state === state
                ? "Remove from your collection"
                : `Mark as ${ENTRY_LABELS[state].toLowerCase()}`
            }
            onClick={() => pick(state)}
          >
            {QUICK_LABELS[state]}
          </button>
        ))}
      </div>
      {book.read !== null ? (
        <div className="cover-actions-row">
          <button
            type="button"
            className="quick-btn"
            aria-pressed={book.read}
            title={book.read ? "Mark as not read" : "Mark every volume in this book read"}
            onClick={() =>
              void setRead({
                editionPublicId: book.editionPublicId,
                read: !book.read,
              }).then((result) => {
                if (result.suggestCompleted.length > 0) {
                  onPrompt({ completed: result.suggestCompleted });
                }
              })
            }
          >
            {book.read ? "Read ✓" : "Mark read"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whole-run writes go to the backend in sequential batches of this many —
 * collection.MANY_ENTRIES_CAP and reading.MANY_EDITIONS_CAP, the most either
 * mutation accepts in one call (kept equal by quickActions.test.ts).
 */
export const RUN_BATCH = 200;

type RunAction = EntryState | "read";

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data !== null) {
    const message = (err.data as { message?: string }).message;
    if (message) return message;
  }
  return "That didn't go through. Try again.";
}

/**
 * Whole-run marking above a shelf: Want / Order / Own every book here, or
 * mark every book read, in one click — collection.setManyReleaseEntries and
 * reading.setEditionsRead, the same rules as one click each. A run longer
 * than RUN_BATCH goes out batch by batch with the count shown; a rejected
 * batch stops the run and says how many books were marked before it. A
 * button whose state every book already holds reads as done and does
 * nothing; nothing here ever removes entries in bulk. Signed-in only (needs
 * the overlay).
 */
export function RunActions({
  books,
  overlay,
  onPrompt,
}: {
  books: ReadonlyArray<OverlayBook>;
  overlay: SeriesOverlay;
  onPrompt: (prompts: Partial<ShelfPromptState>) => void;
}) {
  const setMany = useMutation(api.collection.setManyReleaseEntries);
  const setRead = useMutation(api.reading.setEditionsRead);
  const [busy, setBusy] = useState<{ action: RunAction; done: number; total: number } | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const quick = books.map((book) => quickBookFor(book, overlay));
  const pendingFor = (state: EntryState) =>
    quick.filter((book) => book.state !== state && book.targetReleaseId !== null);
  const unread = quick.filter((book) => book.read === false);
  const total = quick.filter((book) => book.targetReleaseId !== null).length;
  if (total === 0) return null;

  // Write `items` in RUN_BATCH slices, one after another, merging each
  // batch's prompt suggestions by Series and raising them once at the end —
  // also after a failure, for the batches that did land.
  const inBatches = async <T, S extends SeriesSuggestion>(
    action: RunAction,
    items: T[],
    write: (batch: T[]) => Promise<S[]>,
    prompt: (suggestions: S[]) => void,
  ) => {
    if (items.length === 0 || busy) return;
    setFailure(null);
    const suggestions = new Map<Id<"series">, S>();
    let done = 0;
    setBusy({ action, done, total: items.length });
    try {
      for (let start = 0; start < items.length; start += RUN_BATCH) {
        const batch = items.slice(start, start + RUN_BATCH);
        for (const suggestion of await write(batch)) {
          suggestions.set(suggestion.seriesId, suggestion);
        }
        done += batch.length;
        setBusy({ action, done, total: items.length });
      }
    } catch (err) {
      setFailure(
        `Marked ${done} of ${items.length} ${items.length === 1 ? "book" : "books"}, then stopped: ${errorMessage(err)}`,
      );
    } finally {
      if (suggestions.size > 0) prompt([...suggestions.values()]);
      setBusy(null);
    }
  };

  const run = (state: EntryState) =>
    void inBatches(
      state,
      pendingFor(state).flatMap((book) => book.targetReleaseId ?? []),
      async (releaseIds) => (await setMany({ releaseIds, state })).suggestFollow,
      (follow) => onPrompt({ follow }),
    );
  const readAll = () =>
    void inBatches(
      "read",
      unread.map((book) => book.editionPublicId),
      async (editionPublicIds) =>
        (await setRead({ editionPublicIds, read: true })).suggestCompleted,
      (completed) => onPrompt({ completed }),
    );
  // "Marking…", with the running count once the run spans several batches.
  const marking = (action: RunAction) =>
    busy?.action !== action
      ? null
      : busy.total > RUN_BATCH
        ? `Marking ${busy.done} of ${busy.total}…`
        : "Marking…";

  return (
    <div className="run-actions" role="group" aria-label="Every book in this run">
      <span className="run-actions-label">
        {total === 1 ? "This book:" : `All ${total} books:`}
      </span>
      {ENTRY_STATES.map((state) => {
        const pending = pendingFor(state).length;
        return (
          <button
            key={state}
            type="button"
            className="run-btn"
            aria-pressed={pending === 0}
            disabled={pending === 0 || busy !== null}
            title={
              pending === 0
                ? `Every book here is ${ENTRY_LABELS[state].toLowerCase()}`
                : `Mark ${pending} more ${pending === 1 ? "book" : "books"} ${ENTRY_LABELS[state].toLowerCase()}`
            }
            onClick={() => run(state)}
          >
            {marking(state) ?? (pending === 0 ? `All ${ENTRY_LABELS[state].toLowerCase()}` : `${QUICK_LABELS[state]} all`)}
          </button>
        );
      })}
      <button
        type="button"
        className="run-btn"
        aria-pressed={unread.length === 0}
        disabled={unread.length === 0 || busy !== null}
        title={
          unread.length === 0
            ? "Every book here is read"
            : `Mark ${unread.length} more ${unread.length === 1 ? "book" : "books"} read`
        }
        onClick={readAll}
      >
        {marking("read") ?? (unread.length === 0 ? "All read" : "Read all")}
      </button>
      {failure ? (
        <span className="form-error" role="alert">
          {failure}
        </span>
      ) : null}
    </div>
  );
}
