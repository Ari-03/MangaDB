// Ratings UI (CONTEXT.md: Rating): the public aggregate line ("8.4 · 12
// ratings") and the viewer's own 1-10 control. The aggregate is server-
// rendered from the page loader and then follows the live query, so a
// rating shows in it at once; the control is a signed-in overlay that
// renders nothing signed out, like the other tracking controls.

import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";

/** A rating target as pages know it: `{ kind: "series" | "volume", publicId }`. */
export type RatingTarget = FunctionArgs<typeof api.ratings.summary>["target"];
/** A target's public aggregate: unrounded average (null when unrated) and count. */
export type RatingSummary = NonNullable<FunctionReturnType<typeof api.ratings.summary>>;

const SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** "8.4 · 12 ratings", or null with no ratings: an average is never shown without one. */
export function ratingLine(summary: { average: number | null; count: number }): string | null {
  if (summary.average === null || summary.count < 1) return null;
  const noun = summary.count === 1 ? "rating" : "ratings";
  return `${summary.average.toFixed(1)} · ${summary.count.toLocaleString("en-US")} ${noun}`;
}

/** The message a failed rating or review write shows, rate limits included. */
export function writeErrorMessage(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data !== null) {
    const data = err.data as { message?: string; kind?: string };
    if (data.kind === "RateLimited") return "That's a lot in a short time. Try again in a few minutes.";
    if (data.message) return data.message;
  }
  return "That didn't go through. Try again.";
}

// ---------- the public aggregate ----------

/**
 * The target's aggregate as a chip, live when Convex is configured and the
 * loader's copy until then. Renders nothing while the target is unrated.
 */
export function RatingAggregate({
  target,
  initial,
}: {
  target: RatingTarget;
  initial: RatingSummary | null;
}) {
  if (!convexClient) return <AggregateChip summary={initial} />;
  return <LiveAggregate target={target} initial={initial} />;
}

function LiveAggregate({ target, initial }: { target: RatingTarget; initial: RatingSummary | null }) {
  const live = useQuery(api.ratings.summary, { target });
  return <AggregateChip summary={live === undefined ? initial : live} />;
}

function AggregateChip({ summary }: { summary: RatingSummary | null }) {
  const line = summary ? ratingLine(summary) : null;
  if (!line) return null;
  return (
    <span className="chip chip--rating" title="Average reader rating, out of 10">
      <StarGlyph />
      {line}
    </span>
  );
}

function StarGlyph() {
  return (
    <svg className="rating-star" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.4 10 5.7l4.6.5-3.4 3.1 1 4.6L8 11.6 3.8 13.9l1-4.6L1.4 6.2 6 5.7Z" />
    </svg>
  );
}

// ---------- the viewer's control ----------

/**
 * The viewer's own Rating of a target: ten steps and a clear. Returns its
 * kicker, scale and hint as bare siblings so the Series page's tracking bar
 * lays them out as one group, or inside a `<div className={wrapperClass}>`
 * where the container wants one child (the Volume page's tracking card);
 * nothing at all signed out, so either container can hide itself.
 */
export function RatingControl({ target, wrapperClass }: { target: RatingTarget; wrapperClass?: string }) {
  if (!convexClient) return null;
  return <RatingControlInner target={target} wrapperClass={wrapperClass} />;
}

function RatingControlInner({ target, wrapperClass }: { target: RatingTarget; wrapperClass?: string }) {
  const mine = useQuery(api.ratings.mine, { target });
  const setRating = useMutation(api.ratings.set);
  // The value just picked, shown until the query catches up.
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  if (!mine) return null; // loading, signed out, or username pending
  const current = pending === undefined ? mine.rating : pending;

  const pick = (rating: number | null) => {
    setError(null);
    setPending(rating);
    setRating({ target: mine.target, rating })
      .catch((err: unknown) => setError(writeErrorMessage(err)))
      .finally(() => setPending(undefined));
  };

  const controls = (
    <>
      <span className="track-kicker">Your rating</span>
      <div className="rating-scale" role="group" aria-label="Your rating, 1 to 10">
        {SCALE.map((step) => (
          <button
            key={step}
            type="button"
            aria-pressed={current === step}
            aria-label={`${step} out of 10`}
            className={`rating-step${current !== null && step <= current ? " is-on" : ""}`}
            onClick={() => pick(step)}
          >
            {step}
          </button>
        ))}
      </div>
      {current !== null ? (
        <button type="button" className="rating-clear" onClick={() => pick(null)}>
          Clear
        </button>
      ) : null}
      {error ? <span className="form-error">{error}</span> : null}
      <span className="track-hint">
        {current !== null ? `You rated it ${current}/10. ` : ""}
        Your number stays private; only the average is public, and your review shows it.
      </span>
    </>
  );
  return wrapperClass ? <div className={wrapperClass}>{controls}</div> : controls;
}
