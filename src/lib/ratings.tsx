// Ratings UI (CONTEXT.md: Rating, Rating Format): the public aggregate
// ("8.4 · 12 ratings"), single scores beside Reviews and on profiles, the
// viewer's own rating control, and the Rating Format choice on /me. Scores
// are stored as 1-100 (convex/lib/scoreFormat.ts) and read here in the
// viewer's format: point10 buttons, five stars, a 1-100 number, or three
// smileys. The aggregate is server-rendered from the page loader in the
// point10 form and then follows the live queries, so a rating or a format
// change shows at once; the control is a signed-in overlay that renders
// nothing signed out, like the other tracking controls.

import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useEffect, useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import {
  FORMAT_STEPS,
  SCORE_MAX,
  SCORE_MIN,
  SMILEY_LABELS,
  SMILEYS,
  formatAverage,
  formatScore,
  fromFormat,
  smileyOf,
  toFormat,
  type ScoreFormat,
  type Smiley,
} from "../../convex/lib/scoreFormat";
import { convexClient } from "~/providers";

/** A rating target as pages know it: `{ kind: "series" | "volume", publicId }`. */
export type RatingTarget = FunctionArgs<typeof api.ratings.summary>["target"];
/** A target's public aggregate: unrounded 1-100 average (null when unrated) and count. */
export type RatingSummary = NonNullable<FunctionReturnType<typeof api.ratings.summary>>;

/**
 * "8.4 · 12 ratings" in the viewer's format (point10 when null), or null
 * with no ratings: an average is never shown without one.
 */
export function ratingLine(
  summary: { average: number | null; count: number },
  format: ScoreFormat | null,
): string | null {
  if (summary.average === null || summary.count < 1) return null;
  const noun = summary.count === 1 ? "rating" : "ratings";
  return `${formatAverage(summary.average, format)} · ${summary.count.toLocaleString("en-US")} ${noun}`;
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

/**
 * The signed-in viewer's Rating Format; null while loading, signed out, or
 * username pending. Only for components rendered under the Convex provider.
 */
function useViewerFormat(): ScoreFormat | null {
  const viewer = useQuery(api.users.viewer, {});
  return viewer && !viewer.needsUsername ? viewer.scoreFormat : null;
}

// ---------- the public aggregate ----------

const AVERAGE_TITLES: Record<ScoreFormat, string> = {
  point10: "Average reader rating, out of 10",
  star5: "Average reader rating, out of 5 stars",
  point100: "Average reader rating, out of 100",
  smiley3: "Average reader rating, out of 10",
};

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
  if (!convexClient) return <AggregateChip summary={initial} format={null} />;
  return <LiveAggregate target={target} initial={initial} />;
}

function LiveAggregate({ target, initial }: { target: RatingTarget; initial: RatingSummary | null }) {
  const live = useQuery(api.ratings.summary, { target });
  const format = useViewerFormat();
  return <AggregateChip summary={live === undefined ? initial : live} format={format} />;
}

function AggregateChip({ summary, format }: { summary: RatingSummary | null; format: ScoreFormat | null }) {
  const line = summary ? ratingLine(summary, format) : null;
  if (!line) return null;
  return (
    <span className="chip chip--rating" title={AVERAGE_TITLES[format ?? "point10"]}>
      {/* The star5 form carries its own star. */}
      {format === "star5" ? null : <StarGlyph />}
      {line}
    </span>
  );
}

/**
 * An aggregate as plain text in the viewer's format ("8.4 · 12 ratings"), or
 * `fallback` while unrated. For lists that carry the summary themselves
 * (the Series library's "Top rated").
 */
export function RatingLine({
  summary,
  fallback = null,
}: {
  summary: { average: number | null; count: number };
  fallback?: ReactNode;
}) {
  if (!convexClient) return <>{ratingLine(summary, null) ?? fallback}</>;
  return <LiveRatingLine summary={summary} fallback={fallback} />;
}

function LiveRatingLine({
  summary,
  fallback,
}: {
  summary: { average: number | null; count: number };
  fallback: ReactNode;
}) {
  return <>{ratingLine(summary, useViewerFormat()) ?? fallback}</>;
}

// ---------- one score ----------

/**
 * One stored score (a Review author's, a profile's) in the viewer's format,
 * point10 for signed-out viewers: "8/10", "4 ★", "84/100", or a smiley.
 */
export function ScoreText({ score }: { score: number }) {
  if (!convexClient) return <ScoreParts score={score} format="point10" />;
  return <LiveScoreText score={score} />;
}

function LiveScoreText({ score }: { score: number }) {
  return <ScoreParts score={score} format={useViewerFormat() ?? "point10"} />;
}

function ScoreParts({ score, format }: { score: number; format: ScoreFormat }) {
  const label = formatScore(score, format);
  switch (format) {
    case "point10":
      return (
        <span className="review-score" title={label}>
          {toFormat(score, format)}
          <span className="review-score-of">/10</span>
        </span>
      );
    case "star5":
      return (
        <span className="review-score" title={`${toFormat(score, format)} of 5 stars`}>
          {toFormat(score, format)}
          <span className="review-score-of"> ★</span>
        </span>
      );
    case "point100":
      return (
        <span className="review-score" title={label}>
          {score}
          <span className="review-score-of">/100</span>
        </span>
      );
    case "smiley3":
      return (
        <span className="review-score review-score--smiley" title={label}>
          <SmileyGlyph smiley={smileyOf(score)} />
          <span className="review-score-of">{label}</span>
        </span>
      );
  }
}

// ---------- glyphs ----------

function StarGlyph({ className = "rating-star" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.4 10 5.7l4.6.5-3.4 3.1 1 4.6L8 11.6 3.8 13.9l1-4.6L1.4 6.2 6 5.7Z" />
    </svg>
  );
}

const MOUTHS: Record<Smiley, string> = {
  negative: "M5.2 11.4c1.6-1.5 4-1.5 5.6 0",
  neutral: "M5.3 10.6h5.4",
  positive: "M5.2 9.6c1.6 1.6 4 1.6 5.6 0",
};

/** A line-drawn face (no emoji fonts): frown, flat, or smile. */
function SmileyGlyph({ smiley }: { smiley: Smiley }) {
  return (
    <svg
      className="rating-smiley"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.3" />
      <circle cx="5.9" cy="6.4" r="0.5" fill="currentColor" />
      <circle cx="10.1" cy="6.4" r="0.5" fill="currentColor" />
      <path d={MOUTHS[smiley]} />
    </svg>
  );
}

// ---------- the viewer's control ----------

/**
 * The viewer's own Rating of a target, in their Rating Format: its kicker
 * (with Clear), control, and a one-line hint as bare siblings, so the
 * container (the TakePanel's rating block, lib/reviews.tsx) lays them out.
 * Nothing at all signed out, so the container can hide itself.
 */
export function RatingControl({ target }: { target: RatingTarget }) {
  if (!convexClient) return null;
  return <RatingControlInner target={target} />;
}

function RatingControlInner({ target }: { target: RatingTarget }) {
  const mine = useQuery(api.ratings.mine, { target });
  const format = useViewerFormat();
  const setScore = useMutation(api.ratings.set);
  // The score just picked, shown until the query catches up.
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  if (!mine || !format) return null; // loading, signed out, or username pending
  const current = pending === undefined ? mine.score : pending;

  const save = (score: number | null) => {
    if (score === current) return;
    setError(null);
    setPending(score);
    setScore({ target: mine.target, score })
      .catch((err: unknown) => setError(writeErrorMessage(err)))
      .finally(() => setPending(undefined));
  };

  return (
    <>
      <span className="track-kicker">
        Your rating
        {current !== null ? (
          <button type="button" className="rating-clear" onClick={() => save(null)}>
            Clear
          </button>
        ) : null}
      </span>
      {format === "point100" ? (
        <HundredPointInput current={current} onSave={save} />
      ) : format === "smiley3" ? (
        <SmileyScale current={current} onSave={save} />
      ) : (
        <StepScale format={format} current={current} onSave={save} />
      )}
      {error ? <span className="form-error">{error}</span> : null}
      <span className="track-hint">Only the average is public.</span>
    </>
  );
}

type ScaleProps = { current: number | null; onSave: (score: number) => void };

/** point10's numbered steps or star5's stars, filling up to the chosen one. */
function StepScale({ format, current, onSave }: ScaleProps & { format: "point10" | "star5" }) {
  const steps = FORMAT_STEPS[format];
  const chosen = current === null ? null : toFormat(current, format);
  const stars = format === "star5";
  return (
    <div
      className={`rating-scale${stars ? " rating-scale--stars" : ""}`}
      role="group"
      aria-label={stars ? "Your rating, 1 to 5 stars" : "Your rating, 1 to 10"}
    >
      {Array.from({ length: steps }, (_, i) => i + 1).map((step) => (
        <button
          key={step}
          type="button"
          aria-pressed={chosen === step}
          aria-label={stars ? `${step} of 5 stars` : `${step} out of 10`}
          className={`rating-step${chosen !== null && step <= chosen ? " is-on" : ""}`}
          onClick={() => onSave(fromFormat(step, format))}
        >
          {stars ? <StarGlyph className="rating-step-star" /> : step}
        </button>
      ))}
    </div>
  );
}

/** smiley3: three labelled faces; only the chosen one is pressed. */
function SmileyScale({ current, onSave }: ScaleProps) {
  const chosen = current === null ? null : smileyOf(current);
  return (
    <div className="rating-smileys" role="group" aria-label="Your rating">
      {SMILEYS.map((smiley, i) => (
        <button
          key={smiley}
          type="button"
          aria-pressed={chosen === smiley}
          className={`rating-smiley-btn rating-smiley-btn--${smiley}`}
          onClick={() => onSave(fromFormat(i + 1, "smiley3"))}
        >
          <SmileyGlyph smiley={smiley} />
          {SMILEY_LABELS[smiley]}
        </button>
      ))}
    </div>
  );
}

/**
 * point100: a number field with -1 / +1 steppers. Typing saves on Enter or
 * when the field loses focus; each stepper click saves at once, so nothing
 * is left waiting in a timer when the user clears the rating or leaves.
 */
function HundredPointInput({ current, onSave }: ScaleProps) {
  const [draft, setDraft] = useState(current === null ? "" : String(current));
  // Follow the stored value when it changes elsewhere (another tab, a clear).
  useEffect(() => setDraft(current === null ? "" : String(current)), [current]);

  const commit = (raw: string) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value)) {
      setDraft(current === null ? "" : String(current));
      return;
    }
    const score = Math.min(SCORE_MAX, Math.max(SCORE_MIN, value));
    setDraft(String(score));
    onSave(score);
  };
  const step = (delta: number) => {
    const base = Number(draft) || (current ?? 50);
    const next = String(Math.min(SCORE_MAX, Math.max(SCORE_MIN, base + delta)));
    commit(next);
  };

  return (
    <form
      className="rating-hundred"
      onSubmit={(event) => {
        event.preventDefault();
        commit(draft);
      }}
    >
      <button type="button" className="rating-hundred-step" aria-label="One point lower" onClick={() => step(-1)}>
        −
      </button>
      <input
        className="rating-hundred-input"
        type="number"
        inputMode="numeric"
        min={SCORE_MIN}
        max={SCORE_MAX}
        step={1}
        value={draft}
        placeholder="–"
        aria-label="Your rating, 1 to 100"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => commit(draft)}
      />
      <span className="rating-hundred-of" aria-hidden="true">
        /100
      </span>
      <button type="button" className="rating-hundred-step" aria-label="One point higher" onClick={() => step(1)}>
        +
      </button>
    </form>
  );
}

// ---------- /me: the Rating Format ----------

const FORMAT_OPTIONS: ReadonlyArray<{ value: ScoreFormat; label: string }> = [
  { value: "point10", label: "10 point" },
  { value: "star5", label: "5 stars" },
  { value: "point100", label: "100 point" },
  { value: "smiley3", label: "3 smileys" },
];

/**
 * The Rating format section of /me: how the viewer rates and how scores
 * read back to them, in the same segmented pill as the Sharing defaults.
 * Stored ratings never change; only the display does.
 */
export function ScoreFormatSettings() {
  if (!convexClient) return null;
  return <ScoreFormatSettingsInner />;
}

function ScoreFormatSettingsInner() {
  const format = useViewerFormat();
  const setFormat = useMutation(api.users.setScoreFormat);
  if (!format) return null;
  return (
    <div className="sharing-settings">
      <p className="sharing-lede">
        How you rate series and volumes, and how scores read to you. Switching keeps every rating
        you have made; it only changes how they show.
      </p>
      <div className="vis-field">
        <span className="vis-legend" id="score-format-label">
          Rating format
        </span>
        <span className="seg-pill" role="radiogroup" aria-labelledby="score-format-label">
          {FORMAT_OPTIONS.map((option) => (
            <label className="seg-opt" key={option.value}>
              <input
                type="radio"
                name="score-format"
                value={option.value}
                checked={format === option.value}
                onChange={() => void setFormat({ format: option.value })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </span>
        <p className="vis-hint">
          Averages show as 8.4, 4.2 ★, or 84 to match; with smileys they show out of 10.
        </p>
      </div>
    </div>
  );
}
