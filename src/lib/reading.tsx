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
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convexClient } from "~/providers";
import { slugParams } from "~/lib/slug";

const STATUS_LABELS = {
  planToRead: "Plan to Read",
  reading: "Reading",
  paused: "Paused",
  dropped: "Dropped",
  completed: "Completed",
} as const;

type ReadingStatus = keyof typeof STATUS_LABELS;

const STATUS_ORDER: ReadingStatus[] = [
  "reading",
  "planToRead",
  "paused",
  "completed",
  "dropped",
];

type SeriesSuggestion = { seriesId: Id<"series">; title: string };

// ---------- Series Reading Status picker ----------

/**
 * The explicit Series Reading Status choice on the Series page. The select
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
    <div className="reading-status">
      <label>
        Reading status{" "}
        <select
          value={tracking.readingStatus ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value as ReadingStatus | "";
            void setStatus({
              seriesId: tracking.seriesId,
              status: value === "" ? undefined : value,
            });
          }}
        >
          <option value="">Not tracked</option>
          {STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ---------- per-Volume read counts ----------

/**
 * The Volume's durable, edition-independent read count with direct-edit
 * controls (CONTEXT.md: Volume Progress "may be updated directly or by
 * confirmed completion of a Release"). Renders nothing signed out.
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
  const setCount = useMutation(api.reading.setVolumeReadCount);
  if (!tracking) return null;
  const row = tracking.volumes.find((v) => v.volumePublicId === volumePublicId);
  if (!row) return null;
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
        onClick={() =>
          void setCount({ volumeId: row.volumeId, readCount: row.readCount + 1 })
        }
      >
        {row.readCount > 0 ? "+1 read" : "Mark read"}
      </button>
      {row.readCount > 0 ? (
        <button
          type="button"
          className="read-adjust"
          aria-label="Remove one completed read"
          onClick={() =>
            void setCount({ volumeId: row.volumeId, readCount: row.readCount - 1 })
          }
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
 * `releaseId` is the row's document id from the page queries.
 */
export function ReleasePassControls({ releaseId }: { releaseId: string }) {
  if (!convexClient) return null;
  // Release rows carry the Convex document id serialized through the SSR
  // loader; re-brand it for the typed function references.
  return <ReleasePassControlsInner releaseId={releaseId as Id<"releases">} />;
}

function ReleasePassControlsInner({ releaseId }: { releaseId: Id<"releases"> }) {
  const data = useQuery(api.reading.passForRelease, { releaseId });
  const startPass = useMutation(api.reading.startPass);
  const setPercent = useMutation(api.reading.setPassPercent);
  const completePass = useMutation(api.reading.completePass);
  const cancelPass = useMutation(api.reading.cancelPass);
  const undoCompletion = useMutation(api.reading.undoCompletion);
  const setStatus = useMutation(api.reading.setSeriesReadingStatus);

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
              <button type="button" onClick={() => void confirmComplete()}>
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
            onClick={() => {
              void undoCompletion({
                releaseId,
                completedAt: completion.completedAt,
              });
              setCompletion(null);
            }}
          >
            Undo
          </button>
          {completion.suggested.map((suggestion) => (
            <span key={suggestion.seriesId} className="prompt-line">
              You have now read every volume of “{suggestion.title}”. Mark the
              series Completed?{" "}
              <button
                type="button"
                onClick={() => {
                  void setStatus({
                    seriesId: suggestion.seriesId,
                    status: "completed",
                  });
                  setCompletion({ ...completion, suggested: [] });
                }}
              >
                Mark Completed
              </button>{" "}
              <button
                type="button"
                onClick={() => setCompletion({ ...completion, suggested: [] })}
              >
                Not now
              </button>
            </span>
          ))}
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
                  });
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

/** The Reading section of /me: chosen statuses and active passes. */
export function MyReading() {
  if (!convexClient) return null;
  return <MyReadingInner />;
}

function MyReadingInner() {
  const overview = useQuery(api.reading.myReading, {});
  if (overview === undefined) return <p className="placeholder">Loading…</p>;
  if (overview === null) return null;
  if (overview.statuses.length === 0 && overview.passes.length === 0) {
    return (
      <p className="placeholder">
        Pick a reading status on any series page, or start a reading pass on a
        release, and it will appear here.
      </p>
    );
  }

  const grouped = STATUS_ORDER.map((status) => ({
    status,
    entries: overview.statuses.filter((entry) => entry.readingStatus === status),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="my-reading">
      {overview.passes.length > 0 ? (
        <>
          <h3>Currently reading</h3>
          <ul className="my-reading-passes">
            {overview.passes.map((pass) => (
              <li key={pass.releaseId}>
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
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {grouped.map((group) => (
        <div key={group.status} className="my-reading-group">
          <h3>{STATUS_LABELS[group.status]}</h3>
          <ul>
            {group.entries.map((entry) => (
              <li key={entry.seriesPublicId}>
                <Link
                  to="/series/$publicId/$slug"
                  params={slugParams(entry.seriesPublicId, entry.title)}
                >
                  {entry.title}
                </Link>{" "}
                <span className="pass-facts">
                  {entry.volumesRead} of {entry.totalVolumes}{" "}
                  {entry.totalVolumes === 1 ? "volume" : "volumes"} read
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
