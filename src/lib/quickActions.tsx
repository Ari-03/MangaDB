// Quick actions on a cover: Want / Ordered / Own and Mark read, revealed on
// hover over any shelved book (Series page reading paths, the library's path
// shelves), so a whole run can be marked without opening each Edition page.
// The badges the cover wears come from the same picture. Everything reads
// the signed-in overlay (collection.seriesEntries + reading.seriesTracking)
// and writes through the existing single-entry mutations, so the rules are
// exactly those of the Edition page: one state per entry, clicking the
// current state removes it, and reading never changes a Series status —
// a first entry or a fully read Series only *prompts*, in the shelf's
// prompt area.

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
  const setEntry = useMutation(api.collection.setReleaseEntry);
  const setRead = useMutation(api.reading.setEditionRead);
  const pick = (state: EntryState) => {
    if (!book.targetReleaseId) return;
    void setEntry({
      releaseId: book.targetReleaseId,
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
 * Whole-run marking above a shelf: Want / Order / Own every book here, or
 * mark every book read, in one click — collection.setManyReleaseEntries and
 * reading.setEditionsRead, the same rules as one click each. A button whose
 * state every book already holds reads as done and does nothing; nothing
 * here ever removes entries in bulk. Signed-in only (needs the overlay).
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
  const [busy, setBusy] = useState<EntryState | "read" | null>(null);
  const quick = books.map((book) => quickBookFor(book, overlay));
  const pendingFor = (state: EntryState) =>
    quick.filter((book) => book.state !== state && book.targetReleaseId !== null);
  const unread = quick.filter((book) => book.read === false);
  const total = quick.filter((book) => book.targetReleaseId !== null).length;
  if (total === 0) return null;

  const run = (state: EntryState) => {
    const pending = pendingFor(state);
    if (pending.length === 0 || busy) return;
    setBusy(state);
    void setMany({
      releaseIds: pending.map((book) => book.targetReleaseId!),
      state,
    })
      .then((result) => {
        if (result.suggestFollow.length > 0) onPrompt({ follow: result.suggestFollow });
      })
      .finally(() => setBusy(null));
  };
  const readAll = () => {
    if (unread.length === 0 || busy) return;
    setBusy("read");
    void setRead({
      editionPublicIds: unread.map((book) => book.editionPublicId),
      read: true,
    })
      .then((result) => {
        if (result.suggestCompleted.length > 0) {
          onPrompt({ completed: result.suggestCompleted });
        }
      })
      .finally(() => setBusy(null));
  };

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
            {busy === state ? "Marking…" : pending === 0 ? `All ${ENTRY_LABELS[state].toLowerCase()}` : `${QUICK_LABELS[state]} all`}
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
        {busy === "read" ? "Marking…" : unread.length === 0 ? "All read" : "Read all"}
      </button>
    </div>
  );
}
