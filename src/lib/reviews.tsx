// Reviews UI (CONTEXT.md: Review), in two places:
// - `OwnReview`, the viewer's own Review in the page's `TakePanel` (below),
//   under their Rating: "Write a review" (or "Edit your review") opens the
//   form in place, and a saved Review sits folded beneath it. Always on.
// - `ReviewsSection`, the public "Reviews" section of a Series or Volume
//   page, rendered only while FEATURES.publicReviews is on (the page decides;
//   convex/lib/features.ts). The visible list is server-rendered from the
//   page loader and then follows the live query; "More reviews" asks for
//   another page's worth. The viewer's own Review stays in the panel, not
//   the list. Moderators get Hide / Unhide on every Review and a list of hidden
//   ones.
// Reviews are plain text: the body renders with its line breaks, nothing
// is parsed.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { FEATURES } from "../../convex/lib/features";
import { useIsModerator } from "~/lib/viewer";
import { RatingControl, ScoreText, writeErrorMessage, type RatingTarget } from "~/lib/ratings";

// Mirrors REVIEW_MIN_LENGTH / REVIEW_MAX_LENGTH / REVIEW_PAGE in convex/reviews.ts.
const MIN_LENGTH = 20;
const MAX_LENGTH = 5000;
const PAGE = 20;

/** One page of a target's visible Reviews, as the loader and the live query return it. */
export type ReviewPage = NonNullable<FunctionReturnType<typeof api.reviews.list>>;
type ReviewCardData = ReviewPage["items"][number];

const dateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The Reviews section. `noun` names the target in prompts ("series",
 * "volume"); `initial` is the loader's first page (null when the target is
 * gone).
 */
export function ReviewsSection({
  target,
  initial,
  noun,
}: {
  target: RatingTarget;
  initial: ReviewPage | null;
  noun: string;
}) {
  return (
    <section className="section reviews">
      <div className="section-head">
        <h2 className="section-title">Reviews</h2>
        <p className="section-note">Newest first · written by readers, in their own words</p>
      </div>
      <LiveReviews target={target} initial={initial} noun={noun} />
    </section>
  );
}

function LiveReviews({
  target,
  initial,
  noun,
}: {
  target: RatingTarget;
  initial: ReviewPage | null;
  noun: string;
}) {
  const [limit, setLimit] = useState(PAGE);
  const mine = useQuery(api.reviews.mine, { target });
  const ownId = mine?.review?.reviewId ?? null;
  // The viewer's own Review shows above the list, not in it: ask for one
  // extra row so dropping it still leaves a full page.
  const live = useQuery(api.reviews.list, { target, limit: ownId ? limit + 1 : limit });
  // While a bigger page loads, keep showing the last one rather than blinking.
  const last = useRef(initial);
  if (live !== undefined) last.current = live;
  const page = live ?? last.current;
  const others = (page?.items ?? []).filter((item) => item.reviewId !== ownId);
  const items = others.slice(0, limit);
  const hasMore = Boolean(page?.hasMore) || others.length > limit;

  return (
    <>
      <ReviewPrompt noun={noun} />
      <ReviewList items={items} noun={noun} moderated />
      {hasMore ? (
        <p className="reviews-more">
          <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + PAGE)}>
            More reviews
          </button>
        </p>
      ) : null}
      <HiddenReviews target={target} />
    </>
  );
}

function ReviewList({
  items,
  noun,
  moderated = false,
}: {
  items: ReadonlyArray<ReviewCardData>;
  noun: string;
  moderated?: boolean;
}) {
  if (items.length === 0) {
    return <p className="reviews-empty">No reviews of this {noun} yet.</p>;
  }
  return (
    <ol className="review-list">
      {items.map((item) => (
        <li key={item.reviewId}>
          <ReviewCard item={item} moderated={moderated} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One Review: author, their rating, date, "edited", and the text, which a
 * spoiler flag folds behind a button. `moderated` adds the Moderators'
 * Hide / Unhide (the button only shows for them; the server checks again).
 */
function ReviewCard({ item, moderated = false }: { item: ReviewCardData; moderated?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const folded = item.spoiler && !revealed;
  return (
    <article className={`review-card${item.hidden ? " is-hidden" : ""}`}>
      <header className="review-head">
        {item.username ? (
          <Link className="review-author" to="/u/$username" params={{ username: item.username }}>
            @{item.username}
          </Link>
        ) : (
          <span className="review-author">A former reader</span>
        )}
        {item.score !== null ? <ScoreText score={item.score} /> : null}
        <span className="review-date">
          {dateFormat.format(item.createdAt)}
          {item.edited ? " · edited" : ""}
        </span>
        {item.spoiler ? <span className="chip chip--spoiler">Spoilers</span> : null}
        {item.hidden ? <span className="chip chip--hidden">Hidden</span> : null}
      </header>
      {folded ? (
        <button
          type="button"
          className="btn btn-sm review-reveal"
          onClick={() => setRevealed(true)}
        >
          Show spoiler
        </button>
      ) : (
        <p className="review-body">{item.body}</p>
      )}
      {moderated ? <ModerateReview reviewId={item.reviewId} hidden={item.hidden} /> : null}
    </article>
  );
}

// ---------- the viewer's own Review ----------

/**
 * The viewer's take on a target, under the cover of its page (Series,
 * Volume, Edition: a single-volume book's Volume or an omnibus itself):
 * their Rating, their own Review, then a row of the page's private toggles
 * (`children`: Follow, Favorite). `note` is a line above the rating (the
 * Edition page says what it rates).
 * Every control renders nothing signed out and CSS hides the panel then; the
 * note alone never keeps it up (styles/ratings.css). While the review form
 * is open, each hero moves the panel to a full-width row under the cover and
 * body (styles/catalog-series.css, catalog-edition.css).
 */
export function TakePanel({
  target,
  noun,
  note,
  children,
}: {
  target: RatingTarget;
  noun: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="take-panel">
      {note ? <p className="take-note">{note}</p> : null}
      <div className="take-rating">
        <RatingControl target={target} />
      </div>
      <OwnReview target={target} noun={noun} />
      <div className="take-actions">{children}</div>
    </div>
  );
}

/** Signed out or without a username, the Reviews section says how to join in. */
function ReviewPrompt({ noun }: { noun: string }) {
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) return null;
  if (viewer === null) {
    return (
      <p className="review-prompt">
        <a href="/sign-in">Sign in</a> to rate and review this {noun}.
      </p>
    );
  }
  if (viewer.needsUsername) {
    return (
      <p className="review-prompt">
        <a href="/claim-username">Claim a username</a> to write reviews.
      </p>
    );
  }
  return null;
}

/**
 * The viewer's own Review of a target, for the TakePanel under their
 * Rating: a button that opens the form in place, a one-line note on who can
 * read it, and the saved Review folded beneath (with Edit / Delete when
 * unfolded). Renders nothing signed out or before a username is claimed, so
 * the panel can hide itself.
 */
function OwnReview({ target, noun }: { target: RatingTarget; noun: string }) {
  const mine = useQuery(api.reviews.mine, { target });
  const [editing, setEditing] = useState(false);
  if (!mine) return null; // loading, signed out, or username pending
  const review = mine.review;
  return (
    <div className="own-review">
      {editing ? (
        <ReviewForm
          targetId={mine.target}
          existing={review}
          noun={noun}
          onDone={() => setEditing(false)}
          canCancel
        />
      ) : (
        <div className="own-review-row">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            {review ? "Edit your review" : "Write a review"}
          </button>
          <span className="track-hint">
            {FEATURES.publicReviews
              ? "Shown on this page under your username."
              : "Only you can see this for now."}
          </span>
        </div>
      )}
      {review && !editing ? (
        <details className="own-review-saved">
          <summary>
            Your review
            {review.spoiler ? " · spoilers" : ""}
            {review.edited ? " · edited" : ""}
          </summary>
          {review.hidden ? (
            <p className="notice review-hidden-note">
              Hidden by moderators. Only you and the moderators can see it.
            </p>
          ) : null}
          <p className="review-body">{review.body}</p>
          <DeleteOwnReview reviewId={review.reviewId} onEdit={() => setEditing(true)} />
        </details>
      ) : null}
    </div>
  );
}

function DeleteOwnReview({ reviewId, onEdit }: { reviewId: Id<"reviews">; onEdit: () => void }) {
  const remove = useMutation(api.reviews.remove);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="review-actions">
      <button type="button" className="btn btn-sm" onClick={onEdit}>
        Edit
      </button>
      {confirming ? (
        <>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => {
              setError(null);
              remove({ reviewId }).catch((err: unknown) => setError(writeErrorMessage(err)));
            }}
          >
            Delete for good
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

type TargetId = NonNullable<FunctionReturnType<typeof api.reviews.mine>>["target"];

function ReviewForm({
  targetId,
  existing,
  noun,
  onDone,
  canCancel,
}: {
  targetId: TargetId;
  existing: ReviewCardData | null;
  noun: string;
  onDone: () => void;
  canCancel: boolean;
}) {
  const save = useMutation(api.reviews.save);
  const [body, setBody] = useState(existing?.body ?? "");
  const [spoiler, setSpoiler] = useState(existing?.spoiler ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = body.trim().length;
  const short = length < MIN_LENGTH;
  // The form replaces the button that opened it and may open in a row further
  // down the page: take focus, which also scrolls it into view.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  return (
    <form
      className="review-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaving(true);
        save({ target: targetId, body, spoiler })
          .then(onDone)
          .catch((err: unknown) => setError(writeErrorMessage(err)))
          .finally(() => setSaving(false));
      }}
    >
      <label className="review-field">
        <span>{existing ? "Edit your review" : `Review this ${noun}`}</span>
        <textarea
          ref={field}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          maxLength={MAX_LENGTH}
          placeholder="What worked, what didn't, who it's for. Plain text; line breaks are kept."
        />
      </label>
      <div className="review-form-row">
        <label className="review-spoiler">
          <input
            type="checkbox"
            checked={spoiler}
            onChange={(event) => setSpoiler(event.target.checked)}
          />
          Contains spoilers
        </label>
        <span className={`review-count${short && length > 0 ? " is-short" : ""}`}>
          {short
            ? `${MIN_LENGTH - length} more ${MIN_LENGTH - length === 1 ? "character" : "characters"} to go`
            : `${length.toLocaleString("en-US")} / ${MAX_LENGTH.toLocaleString("en-US")}`}
        </span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="review-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={short || saving}>
          {existing ? "Save changes" : "Post review"}
        </button>
        {canCancel ? (
          <button type="button" className="btn btn-sm" onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------- moderation ----------

/** Hide (with an optional reason) or Unhide one Review; renders for Moderators only. */
function ModerateReview({ reviewId, hidden }: { reviewId: Id<"reviews">; hidden: boolean }) {
  const isModerator = useIsModerator();
  const setHidden = useMutation(api.reviews.setHidden);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!isModerator) return null;

  const apply = (hide: boolean) => {
    setError(null);
    setHidden({ reviewId, hidden: hide, reason: reason.trim() || undefined })
      .then(() => {
        setAsking(false);
        setReason("");
      })
      .catch((err: unknown) => setError(writeErrorMessage(err)));
  };

  if (hidden) {
    return (
      <div className="review-mod">
        <button type="button" className="btn btn-sm" onClick={() => apply(false)}>
          Unhide
        </button>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="review-mod">
      {asking ? (
        <>
          <input
            className="review-mod-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional, kept in the audit log)"
            maxLength={500}
          />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => apply(true)}>
            Hide review
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setAsking(true)}>
          Hide
        </button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

/** The target's hidden Reviews, for Moderators; nothing for anyone else. */
function HiddenReviews({ target }: { target: RatingTarget }) {
  const hidden = useQuery(api.reviews.hiddenList, { target });
  if (!hidden || hidden.length === 0) return null;
  return (
    <div className="reviews-hidden">
      <p className="review-mine-kicker">Hidden by moderators · only the data team sees these</p>
      <ol className="review-list">
        {hidden.map((item) => (
          <li key={item.reviewId}>
            <ReviewCard item={item} moderated />
          </li>
        ))}
      </ol>
    </div>
  );
}
