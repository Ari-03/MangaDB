// Reading tracking UI (ticket #28, spec §3), rendered as a signed-in overlay
// on the public catalog pages: the Series Reading Status picker, per-Volume
// read counts, and Release Progress pass controls. Everything fetches through
// the reactive Convex client; signed-out viewers get null from the tracking
// queries, so the public pages render identically without the controls.
//
// The prompt rules from the glossary hold throughout: starting a pass or
// finishing everything only ever *suggests* a status change — the suggestion
// renders as a non-blocking inline prompt, and only its explicit confirm
// button calls setSeriesReadingStatus. Declining (or ignoring) changes
// nothing. Likewise the 100% slider only opens the completion prompt; the
// pass completes solely via the confirmed completePass mutation.

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { track } from "~/lib/analytics";
import { Cover } from "~/lib/cover";
import { useRunLock } from "~/lib/quickActions";
import { convexClient } from "~/providers";
import { slugParams } from "~/lib/slug";

export const STATUS_LABELS = {
  planToRead: "Plan to Read",
  reading: "Reading",
  paused: "Paused",
  dropped: "Dropped",
  completed: "Completed",
} as const;

export type ReadingStatus = keyof typeof STATUS_LABELS;

export const STATUS_ORDER: ReadingStatus[] = [
  "reading",
  "planToRead",
  "paused",
  "completed",
  "dropped",
];

/** A Series a reading write suggests a status for (reading.completePass and kin). */
export type SeriesSuggestion = FunctionReturnType<
  typeof api.reading.completePass
>["suggestCompleted"][number];

/**
 * The fully-read prompt (spec §3): a completion that leaves every Volume of
 * a Series read only *suggests* "Completed"; this renders the suggestion,
 * and only its confirm button writes the status. Shared by the pass
 * controls and the shelf quick actions.
 */
export function CompletedPrompt({
  suggestions,
  onDone,
}: {
  suggestions: SeriesSuggestion[];
  onDone: () => void;
}) {
  const setStatus = useMutation(api.reading.setSeriesReadingStatus);
  if (suggestions.length === 0) return null;
  return (
    <span className="prompt" role="status">
      {suggestions.map((suggestion) => (
        <span key={suggestion.seriesId} className="prompt-line">
          You have now read every volume of “{suggestion.title}”. Mark the
          series Completed?{" "}
          <button
            type="button"
            onClick={() => {
              void setStatus({ seriesId: suggestion.seriesId, status: "completed" }).then(() =>
                track("reading_status_changed", {
                  seriesId: suggestion.seriesId,
                  status: "completed",
                  source: "prompt",
                }),
              );
              onDone();
            }}
          >
            Mark Completed
          </button>{" "}
          <button type="button" onClick={onDone}>
            Not now
          </button>
        </span>
      ))}
    </span>
  );
}

// ---------- Series Reading Status picker ----------

/**
 * The explicit Series Reading Status choice on the Series page, with the
 * group's kicker and hint as bare siblings for the tracking bar. The select
 * is one of exactly two writers of the status (the other being a confirmed
 * prompt); nothing here changes it as a side effect of anything.
 */
export function SeriesReadingControls({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  if (!convexClient) return null;
  return <SeriesReadingControlsInner seriesPublicId={seriesPublicId} />;
}

function SeriesReadingControlsInner({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const tracking = useQuery(api.reading.seriesTracking, { seriesPublicId });
  const setStatus = useMutation(api.reading.setSeriesReadingStatus);
  if (!tracking) return null;
  return (
    <>
      <span className="track-kicker">Your reading</span>
      <select
        className="select"
        aria-label="Reading status"
        value={tracking.readingStatus ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value as ReadingStatus | "";
          const status = value === "" ? null : value;
          void setStatus({ seriesId: tracking.seriesId, status: status ?? undefined }).then(() =>
            track("reading_status_changed", {
              seriesId: tracking.seriesId,
              status,
              source: "series_page",
            }),
          );
        }}
      >
        <option value="">No status</option>
        {STATUS_ORDER.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      <span className="track-hint">
        Where you are in the story — separate from following.
      </span>
    </>
  );
}

// ---------- Series reading progress ----------

/**
 * How far through the Series the viewer has read, counted from the durable
 * per-Volume read counts the tracking query already returns — never from a
 * pass or a Collection Entry. Renders nothing signed out, and nothing for a
 * Series with no Volumes yet.
 */
export function SeriesReadingProgress({
  seriesPublicId,
  volumeCount,
}: {
  seriesPublicId: number;
  volumeCount: number;
}) {
  if (!convexClient || volumeCount === 0) return null;
  return (
    <SeriesReadingProgressInner
      seriesPublicId={seriesPublicId}
      volumeCount={volumeCount}
    />
  );
}

function SeriesReadingProgressInner({
  seriesPublicId,
  volumeCount,
}: {
  seriesPublicId: number;
  volumeCount: number;
}) {
  const tracking = useQuery(api.reading.seriesTracking, { seriesPublicId });
  if (!tracking) return null;
  const read = tracking.volumes.filter((volume) => volume.readCount > 0).length;
  const percent = Math.round((read / volumeCount) * 100);
  return (
    <div className="progress">
      <div className="progress-label">
        {read} of {volumeCount} {volumeCount === 1 ? "volume" : "volumes"} read
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Volumes read in this series"
        aria-valuenow={read}
        aria-valuemin={0}
        aria-valuemax={volumeCount}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// ---------- per-Volume read counts ----------

/**
 * The Volume's durable, edition-independent read count with direct-edit
 * controls (CONTEXT.md: Volume Progress "may be updated directly or by
 * confirmed completion of a Release"). The buttons send ±1 deltas rather
 * than a new total, so clicks made before the count refreshes all land.
 * Locked while a whole "Read all" run still has this Volume to mark
 * (useRunLock), so its later batch cannot undo a change made here.
 * Renders nothing signed out.
 */
export function VolumeReadCount({
  seriesPublicId,
  volumePublicId,
}: {
  seriesPublicId: number;
  volumePublicId: number;
}) {
  if (!convexClient) return null;
  return (
    <VolumeReadCountInner
      seriesPublicId={seriesPublicId}
      volumePublicId={volumePublicId}
    />
  );
}

function VolumeReadCountInner({
  seriesPublicId,
  volumePublicId,
}: {
  seriesPublicId: number;
  volumePublicId: number;
}) {
  const tracking = useQuery(api.reading.seriesTracking, { seriesPublicId });
  const adjustCount = useMutation(api.reading.adjustVolumeReadCount);
  const lock = useRunLock((claims) => claims.reads.has(volumePublicId));
  if (!tracking) return null;
  const row = tracking.volumes.find((v) => v.volumePublicId === volumePublicId);
  if (!row) return null;
  const adjust = (delta: number) => {
    if (!lock.held()) void adjustCount({ volumeId: row.volumeId, delta });
  };
  return (
    <span className="volume-read">
      {row.readCount > 0 ? (
        <span className="read-count" title="Completed reads of this volume">
          Read ×{row.readCount}
        </span>
      ) : null}
      <button
        type="button"
        className="read-adjust"
        disabled={lock.locked}
        onClick={() => adjust(1)}
      >
        {row.readCount > 0 ? "+1 read" : "Mark read"}
      </button>
      {row.readCount > 0 ? (
        <button
          type="button"
          className="read-adjust"
          aria-label="Remove one completed read"
          disabled={lock.locked}
          onClick={() => adjust(-1)}
        >
          −1
        </button>
      ) : null}
    </span>
  );
}

// ---------- Release Progress pass controls ----------

/**
 * The pass controls on a Release row: start a pass, move the optional
 * 0–100% slider, confirm completion (with undo), abandon the pass. Mounts
 * anywhere a Release row renders — Series, Volume, and Edition pages.
 * `releaseId` is the row's document id from the page queries. Completing
 * and undoing write the covered Volumes' Progress, which the client does
 * not know here, so both wait while any "Read all" run is still marking
 * (useRunLock): its later batch could otherwise re-mark an undone Volume.
 */
export function ReleasePassControls({ releaseId }: { releaseId: Id<"releases"> }) {
  if (!convexClient) return null;
  return <ReleasePassControlsInner releaseId={releaseId} />;
}

function ReleasePassControlsInner({ releaseId }: { releaseId: Id<"releases"> }) {
  const data = useQuery(api.reading.passForRelease, { releaseId });
  const startPass = useMutation(api.reading.startPass);
  const setPercent = useMutation(api.reading.setPassPercent);
  const completePass = useMutation(api.reading.completePass);
  const cancelPass = useMutation(api.reading.cancelPass);
  const undoCompletion = useMutation(api.reading.undoCompletion);
  const setStatus = useMutation(api.reading.setSeriesReadingStatus);
  const lock = useRunLock((claims) => claims.reads.size > 0);

  // Local slider value while dragging, ahead of the reactive round-trip.
  const [draft, setDraft] = useState<number | null>(null);
  // Open completion prompt — the only path to completePass.
  const [confirming, setConfirming] = useState(false);
  // Start-reading suggestions returned by startPass (never auto-applied).
  const [suggestReading, setSuggestReading] = useState<SeriesSuggestion[]>([]);
  // The just-confirmed completion: drives the undo affordance and the
  // completed-series suggestions.
  const [completion, setCompletion] = useState<{
    completedAt: number;
    suggested: SeriesSuggestion[];
  } | null>(null);

  if (!data) return null; // loading, signed out, or username pending
  const pass = data.pass;
  const percent = draft ?? pass?.percent ?? 0;

  const start = async () => {
    setCompletion(null);
    setDraft(null);
    const result = await startPass({ releaseId });
    setSuggestReading(result.suggestReading);
  };

  const confirmComplete = async () => {
    if (lock.held()) return;
    setConfirming(false);
    const result = await completePass({ releaseId });
    setDraft(null);
    setCompletion({
      completedAt: result.completedAt,
      suggested: result.suggestCompleted,
    });
  };

  return (
    <div className="pass-controls">
      {pass ? (
        <>
          <label className="pass-slider">
            <span>Reading</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              aria-label="Estimated progress through this release"
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                setDraft(value);
                void setPercent({ releaseId, percent: value });
                // Hitting 100% only prompts; "Not yet" leaves the pass open.
                if (value === 100) setConfirming(true);
              }}
            />
            <span className="pass-percent">{percent}%</span>
          </label>
          <button type="button" onClick={() => setConfirming(true)}>
            Finished…
          </button>
          <button
            type="button"
            className="pass-cancel"
            onClick={() => {
              setConfirming(false);
              setDraft(null);
              void cancelPass({ releaseId });
            }}
          >
            Stop without finishing
          </button>
          {confirming ? (
            <span className="prompt" role="status">
              Mark this pass complete? Every volume this release covers
              completely gets +1 read.{" "}
              <button
                type="button"
                disabled={lock.locked}
                onClick={() => void confirmComplete()}
              >
                Complete pass
              </button>{" "}
              <button type="button" onClick={() => setConfirming(false)}>
                Not yet
              </button>
            </span>
          ) : null}
        </>
      ) : completion ? (
        <span className="prompt pass-done" role="status">
          Pass completed — read counts updated.{" "}
          <button
            type="button"
            disabled={lock.locked}
            onClick={() => {
              if (lock.held()) return;
              void undoCompletion({
                releaseId,
                completedAt: completion.completedAt,
              });
              setCompletion(null);
            }}
          >
            Undo
          </button>
          <CompletedPrompt
            suggestions={completion.suggested}
            onDone={() => setCompletion({ ...completion, suggested: [] })}
          />
        </span>
      ) : (
        <button type="button" onClick={() => void start()}>
          Start reading
        </button>
      )}
      {suggestReading.length > 0 ? (
        <span className="prompt" role="status">
          {suggestReading.map((suggestion) => (
            <span key={suggestion.seriesId} className="prompt-line">
              Set your reading status for “{suggestion.title}” to Reading?{" "}
              <button
                type="button"
                onClick={() => {
                  void setStatus({
                    seriesId: suggestion.seriesId,
                    status: "reading",
                  }).then(() =>
                    track("reading_status_changed", {
                      seriesId: suggestion.seriesId,
                      status: "reading",
                      source: "prompt",
                    }),
                  );
                  setSuggestReading([]);
                }}
              >
                Set to Reading
              </button>{" "}
              <button type="button" onClick={() => setSuggestReading([])}>
                Not now
              </button>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

// ---------- /me reading overview ----------

type ReadingFilter = "all" | ReadingStatus;

/**
 * The Reading tab of the library: every Series the viewer reads, as a row
 * with its cover, status (changeable in place — the same explicit choice as
 * the Series page picker), volumes-read progress, and the active passes
 * through its books. Filter chips narrow to one status.
 */
export function LibraryReading() {
  if (!convexClient) return null;
  return <LibraryReadingInner />;
}

function LibraryReadingInner() {
  const overview = useQuery(api.reading.myReading, {});
  const setStatus = useMutation(api.reading.setSeriesReadingStatus);
  const [filter, setFilter] = useState<ReadingFilter>("all");
  if (overview === undefined) return <p className="placeholder">Loading…</p>;
  if (overview === null) return null;
  if (overview.series.length === 0) {
    return (
      <p className="placeholder">
        Pick a reading status on any series page, mark a book read from its
        cover, or start a reading pass on a release, and it will appear here.
      </p>
    );
  }

  const count = (status: ReadingStatus) =>
    overview.series.filter((row) => row.readingStatus === status).length;
  const rows =
    filter === "all"
      ? overview.series
      : overview.series.filter((row) => row.readingStatus === filter);

  return (
    <div className="lib-reading">
      <div className="lib-chips" role="group" aria-label="Filter by reading status">
        <button
          type="button"
          className="lib-chip"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All <span className="lib-chip-count">{overview.series.length}</span>
        </button>
        {STATUS_ORDER.map((status) =>
          count(status) > 0 ? (
            <button
              key={status}
              type="button"
              className="lib-chip"
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
            >
              {STATUS_LABELS[status]}{" "}
              <span className="lib-chip-count">{count(status)}</span>
            </button>
          ) : null,
        )}
      </div>
      <ul className="reading-list">
        {rows.map((row) => {
          const percent =
            row.totalVolumes === 0
              ? 0
              : Math.round((row.volumesRead / row.totalVolumes) * 100);
          return (
            <li key={row.seriesPublicId} className="reading-row">
              <Link
                className="reading-cover"
                to="/series/$publicId/$slug"
                params={slugParams(row.seriesPublicId, row.title)}
                aria-label={row.title}
              >
                <Cover src={row.coverUrl} isbn13={row.coverIsbn} title={row.title} />
              </Link>
              <div>
                <div className="reading-title">
                  <Link
                    to="/series/$publicId/$slug"
                    params={slugParams(row.seriesPublicId, row.title)}
                  >
                    {row.title}
                  </Link>
                </div>
                <div className="reading-meta">
                  <select
                    className="select select-sm"
                    aria-label={`Reading status for ${row.title}`}
                    value={row.readingStatus ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value as ReadingStatus | "";
                      const status = value === "" ? null : value;
                      void setStatus({ seriesId: row.seriesId, status: status ?? undefined }).then(
                        () =>
                          track("reading_status_changed", {
                            seriesId: row.seriesId,
                            status,
                            source: "library",
                          }),
                      );
                    }}
                  >
                    <option value="">No status</option>
                    {STATUS_ORDER.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                  <span>
                    {row.volumesRead} of {row.totalVolumes}{" "}
                    {row.totalVolumes === 1 ? "volume" : "volumes"} read
                  </span>
                </div>
                {row.totalVolumes > 0 ? (
                  <div className="reading-bar">
                    <div
                      className="reading-track"
                      role="progressbar"
                      aria-label={`Volumes of ${row.title} read`}
                      aria-valuenow={row.volumesRead}
                      aria-valuemin={0}
                      aria-valuemax={row.totalVolumes}
                    >
                      <div className="reading-fill" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                ) : null}
                {row.passes.length > 0 ? (
                  <ul className="profile-passes">
                    {row.passes.map((pass) => (
                      <li key={pass.releaseId} className="lib-pass">
                        <span className="lib-pass-cover">
                          <Cover
                            src={pass.coverUrl}
                            isbn13={pass.coverIsbns}
                            title={pass.editionTitle}
                          />
                        </span>
                        <span>
                          Reading{" "}
                          <Link
                            to="/edition/$publicId/$slug"
                            params={slugParams(pass.editionPublicId, pass.editionTitle)}
                            hash={pass.anchor}
                          >
                            {pass.editionTitle}
                          </Link>{" "}
                          <span className="pass-facts">
                            {pass.format === "physical"
                              ? `Physical${pass.binding ? ` · ${pass.binding}` : ""}`
                              : "Digital"}
                            {pass.percent !== null ? ` · ${pass.percent}%` : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
