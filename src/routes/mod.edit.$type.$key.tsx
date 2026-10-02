import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { RecordType } from "../../convex/lib/moderationFields";
import {
  draftChanges,
  draftIsStale,
  editDraft,
  FieldInput,
  freshDraft,
  isRecordType,
  type EditDraft,
} from "~/lib/editForm";
import { mutationErrorMessage } from "~/lib/errors";
import { slugParams } from "~/lib/slug";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { useIsModerator } from "~/lib/viewer";
import { convexClient } from "~/providers";

/**
 * The Administrator/Moderator direct-edit form (ticket #31, spec §5): the
 * save is an immediately approved Proposal Version — the single write path —
 * producing one immutable public Revision on the record. The form renders
 * from the same field registry the mutation validates against
 * (convex/lib/moderationFields.ts), requires a change comment, and carries
 * the base Revision its values were loaded from so a concurrent change is
 * refused as stale, not silently rebased. Until the first keystroke the form
 * follows the live record; after it, values and base are pinned together,
 * and a newer Revision arriving asks the Moderator to reload before saving.
 * The inputs lock while a save is in flight, since its success resets the
 * form to the live record.
 *
 * Auth-gated client-side for UX; the Convex functions re-check the role on
 * every call. Never indexed.
 */
export const Route = createFileRoute("/mod/edit/$type/$key")({
  head: () => ({ meta: [{ title: "Edit record — MangaDB" }] }),
  component: ModEditPage,
});

function ModEditPage() {
  const { type, key } = Route.useParams();

  if (!convexClient) {
    return (
      <main className="mod-page">
        <p className="notice">
          Moderation needs a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  if (!isRecordType(type)) {
    return (
      <main className="mod-page">
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing editable lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return <ModEditGate type={type} editKey={key} />;
}

function ModEditGate({ type, editKey }: { type: RecordType; editKey: string }) {
  const isModerator = useIsModerator();
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) {
    return (
      <main className="mod-page">
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isModerator) {
    return (
      <main className="mod-page">
        <h1>Moderators only</h1>
        <p className="notice">
          Direct edits are for Moderators and Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ModEditForm type={type} editKey={editKey} />;
}

function ModEditForm({ type, editKey }: { type: RecordType; editKey: string }) {
  const navigate = useNavigate();
  const form = useQuery(api.moderation.editForm, { type, key: editKey });
  const submitDirectEdit = useMutation(api.moderation.submitDirectEdit);
  const [draft, setDraft] = useState<EditDraft<Id<"revisions"> | null> | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSeq, setSavedSeq] = useState<number | null>(null);

  if (form === undefined) {
    return (
      <main className="mod-page">
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (form === null) {
    return (
      <main className="mod-page">
        <h1>Record not found</h1>
        <p className="notice">
          No {type} matches this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }

  const current = draft ?? freshDraft(form);
  // While a save is in flight the form is locked: success resets the draft
  // to the live record, which would silently drop anything typed meanwhile.
  const setValue = (key: string, value: string) => {
    if (!busy) setDraft(editDraft(current, key, value));
  };
  // Someone else saved this record after the draft's values were loaded.
  const stale = draftIsStale(current, form.baseRevisionId);

  const editable = form.status === "active" && !form.locked;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const built = draftChanges(form.fields, current);
      if (!built.ok) throw new ConvexError({ message: built.message });
      const { seq } = await submitDirectEdit({
        ref: form.ref as never,
        baseRevisionId: current.baseRevisionId ?? undefined,
        changes: built.changes,
        comment,
      });
      setSavedSeq(seq);
      // Follow the live record again, which now includes this Revision.
      setDraft(null);
      setComment("");
      if (form.backLink) {
        const { entity, publicId, title } = form.backLink;
        const to =
          entity === "series"
            ? "/series/$publicId/$slug"
            : entity === "volume"
              ? "/volume/$publicId/$slug"
              : entity === "edition"
                ? "/edition/$publicId/$slug"
                : "/bundle/$publicId/$slug";
        await navigate({ to, params: slugParams(publicId, title) });
      }
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? mutationErrorMessage(err, "Save failed.")
          : "Save failed. Nothing was changed — try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mod-page mod-edit-page">
      <Breadcrumbs trail={["Edit"]} />
      <h1>Edit: {form.title}</h1>
      <p className="section-hint">
        Saving applies immediately as an approved proposal and adds a public
        revision to this record's history.
      </p>
      {form.overriddenFields.length > 0 ? (
        <p className="notice">
          Human-corrected fields (imports never overwrite these):{" "}
          {form.overriddenFields.join(", ")}.
        </p>
      ) : null}
      {!editable ? (
        <p className="notice">
          This record is {form.locked ? "locked" : form.status} and cannot be
          edited directly.
        </p>
      ) : (
        <form
          className="mod-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {stale ? (
            <div className="notice" role="alert">
              <p>
                This record was changed by someone else after you started
                editing. Reload the latest version to continue; your unsaved
                edits will be discarded.
              </p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                Reload latest
              </button>
            </div>
          ) : null}
          {form.fields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              values={current.values}
              setValue={setValue}
              disabled={busy}
            />
          ))}
          <label>
            Change comment (required)
            <textarea
              value={comment}
              onChange={(event) => {
                if (!busy) setComment(event.target.value);
              }}
              disabled={busy}
              rows={2}
              placeholder="Why is this change correct?"
              required
            />
          </label>
          <div className="mod-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                busy || stale || current.dirty.size === 0 || comment.trim() === ""
              }
            >
              {busy ? "Saving…" : "Save as approved change"}
            </button>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {savedSeq !== null ? (
            <p className="notice">Saved — revision #{savedSeq} recorded.</p>
          ) : null}
        </form>
      )}
      {type === "release" || type === "series" ? (
        <SourceDescriptions recordRef={{ type, id: form.ref.id }} />
      ) : null}
    </main>
  );
}

/**
 * Every blurb the sources offered for this Release (description) or Series
 * (synopsis), beside the canonical one, so a reviewer can compare them and
 * copy a better text into the form above. Imports pick by authority: the
 * publisher's own text, then the distributor's, then aggregators'.
 */
function SourceDescriptions({
  recordRef,
}: {
  recordRef: { type: "release" | "series"; id: string };
}) {
  const result = useQuery(api.moderation.sourceBlurbs, { ref: recordRef });
  if (result === undefined) {
    return (
      <section className="mod-panel">
        <h2>Source descriptions</h2>
        <p className="mod-empty">Loading…</p>
      </section>
    );
  }
  if (result === null) return null;

  const { canonical, blurbs } = result;
  const noun = result.field === "description" ? "description" : "synopsis";
  const authorship =
    canonical.author === null
      ? "predates revision history"
      : canonical.author.kind === "user"
        ? `was written by ${
            canonical.author.username ? `@${canonical.author.username}` : "a deleted account"
          }`
        : `was imported from ${canonical.author.sourceKey}`;

  return (
    <section className="mod-panel">
      <h2>Source descriptions</h2>
      <p className="section-hint">
        {canonical.text === null
          ? `No ${noun} yet: the first source to offer one fills it, or write one above.`
          : `The current ${noun} ${authorship}.`}
        {canonical.overridden ? " It is a Human Override: imports never replace it." : null}
        {result.truncated ? " Showing the first 50 linked source records." : null}
      </p>
      {blurbs.length === 0 ? (
        <p className="mod-empty">No source has offered a {noun} for this record.</p>
      ) : (
        <div>
          <ol className="revision-list">
            {blurbs.map((blurb) => (
              <li key={`${blurb.observationId}:${blurb.text}`} className="revision">
                <div className="revision-meta">
                  <span className="revision-author">{blurb.sourceName}</span>
                  {blurb.current ? (
                    <span className="chip mod-chip mod-chip--ok">current</span>
                  ) : null}
                  {blurb.recordedOnly ? (
                    <span className="chip mod-chip mod-chip--mute">
                      recorded only ({blurb.recordedOnly.reason})
                    </span>
                  ) : null}
                  {blurb.withdrawn ? (
                    <span className="chip mod-chip mod-chip--warn">withdrawn at source</span>
                  ) : null}
                  <time dateTime={new Date(blurb.lastSeenAt).toISOString()}>
                    seen{" "}
                    {new Date(blurb.lastSeenAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
                <p className="revision-comment">{blurb.text}</p>
                {blurb.url ? (
                  <p className="revision-citation">
                    <a href={blurb.url} target="_blank" rel="noreferrer">
                      View at {blurb.sourceName}
                    </a>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
