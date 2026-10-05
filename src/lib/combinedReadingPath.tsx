import { useRouter } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";

import { api } from "../../convex/_generated/api";
import { COMBINED_PUBLISHERS_CAP, previewCombinedPaths } from "../../convex/lib/editionGroups";
import { sameValue } from "../../convex/lib/values";
import { mutationErrorMessage } from "~/lib/errors";

type CombineForm = NonNullable<FunctionReturnType<typeof api.readingPaths.combineForm>>;
type Draft = {
  expected: CombineForm["currentPublisherIds"];
  publisherIds: CombineForm["selectedPublisherIds"];
};

/** The display choice follows live data until the moderator starts editing. */
export function CombinedReadingPathPanel({ seriesPublicId }: { seriesPublicId: number }) {
  const form = useQuery(api.readingPaths.combineForm, { seriesPublicId });
  if (form === undefined) return <p className="notice">Loading reading paths…</p>;
  if (form === null) return null;
  return <CombinedReadingPathForm form={form} />;
}

function CombinedReadingPathForm({ form }: { form: CombineForm }) {
  const sectionRef = useRef<HTMLElement>(null);
  // The moderator queries load after the router's initial hash scroll.
  useEffect(() => {
    if (window.location.hash === "#reading-paths") sectionRef.current?.scrollIntoView();
  }, []);
  const router = useRouter();
  const saveCombination = useMutation(api.readingPaths.setCombinedPath);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = draft ?? {
    expected: form.currentPublisherIds,
    publisherIds: form.selectedPublisherIds,
  };
  const stale = !sameValue(current.expected, form.currentPublisherIds);
  const changed = !sameValue(current.publisherIds, form.currentPublisherIds);
  const preview = previewCombinedPaths(form.runs, current.publisherIds, form.volumes);
  const valid =
    current.publisherIds.length >= 2 &&
    current.publisherIds.length <= COMBINED_PUBLISHERS_CAP &&
    preview.overlaps.length === 0;
  const setPublishers = (publisherIds: Draft["publisherIds"]) => {
    setDraft({ ...current, publisherIds });
    setConfirmed(false);
    setSaved(false);
    setError(null);
  };
  const save = async (publisherIds: Draft["publisherIds"]) => {
    setBusy(true);
    setError(null);
    try {
      await saveCombination({
        seriesId: form.seriesId,
        expected: current.expected,
        publisherIds,
        comment,
        confirmImpact: confirmed,
      });
      setDraft(null);
      setComment("");
      setConfirmed(false);
      setSaved(true);
      await router.invalidate();
    } catch (err) {
      setError(mutationErrorMessage(err, "The reading paths could not be saved."));
    } finally {
      setBusy(false);
    }
  };
  const labels = (volumes: typeof form.volumes) =>
    volumes.map((volume) => volume.label ?? `#${volume.position}`).join(", ");

  return (
    <section className="manage-action" id="reading-paths" ref={sectionRef}>
      <h2>Combine reading paths</h2>
      <p className="section-hint">
        Show standard runs from different publishers as one shelf for this series. Books keep their
        publisher details and tracking. Omnibus and deluxe lines stay separate.
      </p>
      {form.currentPublisherIds.length > 0 ? (
        <p className="notice">
          This series has a combined reading path. You can replace it or undo it below.
        </p>
      ) : null}
      <form
        className="mod-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(current.publisherIds);
        }}
      >
        <fieldset disabled={busy || !form.editable} className="combined-path-choices">
          <legend>Standard runs to combine</legend>
          {form.runs.map((run) => (
            <label key={run.publisher.id} className="combined-path-choice">
              <input
                type="checkbox"
                checked={current.publisherIds.includes(run.publisher.id)}
                onChange={(event) => {
                  setPublishers(
                    event.target.checked
                      ? [...current.publisherIds, run.publisher.id]
                      : current.publisherIds.filter((id) => id !== run.publisher.id),
                  );
                }}
              />
              <span>
                {run.publisher.name} <span className="field-help">{run.books.length} books</span>
              </span>
            </label>
          ))}
          {form.runs.length < 2 ? (
            <p className="field-help">
              At least two standard publisher runs are needed to combine paths.
            </p>
          ) : null}
        </fieldset>
        {current.publisherIds.length > 0 ? (
          <label>
            Lead publisher
            <select
              disabled={busy || !form.editable}
              value={current.publisherIds[0]}
              onChange={(event) => {
                const lead = current.publisherIds.find((id) => id === event.target.value);
                if (lead)
                  setPublishers([lead, ...current.publisherIds.filter((id) => id !== lead)]);
              }}
            >
              {form.runs
                .filter((run) => current.publisherIds.includes(run.publisher.id))
                .map((run) => (
                  <option key={run.publisher.id} value={run.publisher.id}>
                    {run.publisher.name}
                  </option>
                ))}
            </select>
            <span className="field-help">
              Its existing reading-path link becomes the combined shelf's main link. Links to the
              other selected runs still work.
            </span>
          </label>
        ) : null}
        <div className="impact-preview" aria-live="polite">
          <h3>Shelf preview</h3>
          <p>{preview.bookCount} books in reading order.</p>
          {preview.covered.length > 0 ? <p>Volumes: {labels(preview.covered)}</p> : null}
          <p>
            {preview.gaps.length > 0
              ? `Gaps still on file: ${labels(preview.gaps)}.`
              : "No gaps in the selected books."}
          </p>
          {preview.overlaps.length > 0 ? (
            <p className="form-error">
              These runs overlap at volumes {labels(preview.overlaps)}. Keep overlapping editions
              separate.
            </p>
          ) : null}
          {form.currentPublisherIds.length > 0 ? (
            <p>Undo restores the separate publisher shelves.</p>
          ) : null}
        </div>
        <label>
          Reason for the change
          <textarea
            required
            rows={3}
            disabled={busy || !form.editable}
            value={comment}
            onChange={(event) => {
              if (!draft) setDraft(current);
              setComment(event.target.value);
            }}
          />
        </label>
        <label className="manage-confirm combined-path-choice">
          <input
            type="checkbox"
            disabled={busy || !form.editable}
            checked={confirmed}
            onChange={(event) => {
              if (!draft) setDraft(current);
              setConfirmed(event.target.checked);
            }}
          />
          <span>I reviewed the shelf preview and want to save this change.</span>
        </label>
        {stale ? (
          <p className="form-error">
            The reading paths changed while you were editing. Reload the choices before saving.
          </p>
        ) : null}
        {!form.editable ? (
          <p className="form-error">Unlock the series before changing its reading paths.</p>
        ) : null}
        <div className="mod-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              busy || !form.editable || stale || !changed || !valid || !confirmed || !comment.trim()
            }
          >
            {busy ? "Saving…" : "Combine selected runs"}
          </button>
          {form.currentPublisherIds.length > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={busy || !form.editable || stale || !confirmed || !comment.trim()}
              onClick={() => void save([])}
            >
              Undo combination
            </button>
          ) : null}
          {draft ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setComment("");
                setConfirmed(false);
                setError(null);
                setSaved(false);
              }}
            >
              Reload choices
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="notice" role="status">
            Reading paths saved. The change is recorded in the series history.
          </p>
        ) : null}
      </form>
    </section>
  );
}
