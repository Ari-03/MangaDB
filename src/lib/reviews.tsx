// Reviews UI (CONTEXT.md: Review): the "Reviews" section of a Series or
// Volume page. The visible list is server-rendered from the page loader and
// then follows the live query; "More reviews" asks for another page's
// worth. Signed in, the viewer's own Review sits above the list with its
// edit and delete buttons (and, when a Moderator hid it, says so);
// Moderators get Hide / Unhide on every Review and a list of hidden ones.
// Reviews are plain text: the body renders with its line breaks, nothing
// is parsed.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useIsModerator } from "~/lib/moderation";
import { writeErrorMessage, type RatingTarget } from "~/lib/ratings";
import { convexClient } from "~/providers";

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
 * "volume"); `initial` is the loader's first page (null when Convex is not
 * configured or the target is gone).
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
      {convexClient ? (
        <LiveReviews target={target} initial={initial} noun={noun} />
      ) : (
        <ReviewList items={initial?.items ?? []} noun={noun} />
      )}
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
  const live = useQuery(api.reviews.list, { target, limit });
  // While a bigger page loads, keep showing the last one rather than blinking.
  const last = useRef(initial);
  if (live !== undefined) last.current = live;
  const page = live ?? last.current;
  const mine = useQuery(api.reviews.mine, { target });
  const ownId = mine?.review?.reviewId ?? null;
  const items = (page?.items ?? []).filter((item) => item.reviewId !== ownId);

  return (
    <>
      <MyReview target={target} mine={mine} noun={noun} />
      <ReviewList items={items} noun={noun} moderated />
      {page?.hasMore ? (
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
function ReviewCard({
  item,
  moderated = false,
  own = false,
}: {
  item: ReviewCardData;
  moderated?: boolean;
  own?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const folded = item.spoiler && !revealed && !own;
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
        {item.rating !== null ? (
          <span className="review-score" title="The author's rating">
            {item.rating}
            <span className="review-score-of">/10</span>
          </span>
        ) : null}
        <span className="review-date">
          {dateFormat.format(item.createdAt)}
          {item.edited ? " · edited" : ""}
        </span>
        {item.spoiler ? <span className="chip chip--spoiler">Spoilers</span> : null}
        {item.hidden ? <span className="chip chip--hidden">Hidden</span> : null}
      </header>
      {folded ? (
        <button type="button" className="btn btn-sm review-reveal" onClick={() => setRevealed(true)}>
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

type Mine = FunctionReturnType<typeof api.reviews.mine> | undefined;

function MyReview({ target, mine, noun }: { target: RatingTarget; mine: Mine; noun: string }) {
  const viewer = useQuery(api.users.viewer, {});
  const [editing, setEditing] = useState(false);
  if (viewer === undefined || mine === undefined) return null;
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
  if (!mine) return null;
  const review = mine.review;
  if (!review || editing) {
    return (
      <ReviewForm
        targetId={mine.target}
        existing={review}
        noun={noun}
        onDone={() => setEditing(false)}
        canCancel={review !== null}
      />
    );
  }
  return (
    <div className="review-mine">
      <p className="review-mine-kicker">Your review</p>
      {review.hidden ? (
        <p className="notice review-hidden-note">
          Your review is hidden by moderators. Only you and the moderators can see it.
        </p>
      ) : null}
      <ReviewCard item={review} own />
      <DeleteOwnReview reviewId={review.reviewId} onEdit={() => setEditing(true)} />
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
