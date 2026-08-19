import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import {
  EDITABLE_FIELDS,
  type RecordType,
} from "../../convex/lib/moderationFields";
import {
  FieldInput,
  fieldValue,
  initialFormState,
  stateKeysOf,
  type FormState,
} from "~/lib/editForm";
import { slugParams } from "~/lib/slug";
import { useIsModerator } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The Administrator/Moderator direct-edit form (ticket #31, spec §5): the
 * save is an immediately approved Proposal Version — the single write path —
 * producing one immutable public Revision on the record. The form renders
 * from the same field registry the mutation validates against
 * (convex/lib/moderationFields.ts), requires a change comment, and carries
 * the record's base Revision so a concurrent change is refused as stale, not
 * silently rebased.
 *
 * Auth-gated client-side for UX; the Convex functions re-check the role on
 * every call. Never indexed.
 */
export const Route = createFileRoute("/mod/edit/$type/$key")({
  head: () => ({
    meta: [
      { title: "Edit record — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ModEditPage,
});

function isRecordType(raw: string): raw is RecordType {
  return raw in EDITABLE_FIELDS;
}

function ModEditPage() {
  const { type, key } = Route.useParams();

  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Moderation needs a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  if (!isRecordType(type)) {
    return (
      <main>
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
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isModerator) {
    return (
      <main>
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
  const [state, setState] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSeq, setSavedSeq] = useState<number | null>(null);

  if (form === undefined) {
    return (
      <main>
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (form === null) {
    return (
      <main>
        <h1>Record not found</h1>
        <p className="notice">
          No {type} matches this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }

  const values = state ?? initialFormState(form.fields);
  const setValue = (key: string, value: string) => {
    setState({ ...values, [key]: value });
    setDirty(new Set([...dirty, key]));
  };

  const editable = form.status === "active" && !form.locked;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const changes: Array<{ field: string; value: unknown }> = [];
      for (const field of form.fields) {
        if (!stateKeysOf(field).some((k) => dirty.has(k))) continue;
        const result = fieldValue(field, values);
        if (!result.ok) throw new ConvexError({ message: result.message });
        changes.push({ field: field.name, value: result.value });
      }
      const { seq } = await submitDirectEdit({
        ref: form.ref as never,
        baseRevisionId:
          (form.baseRevisionId as never) ?? undefined,
        changes,
        comment,
      });
      setSavedSeq(seq);
      setDirty(new Set());
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
      const message =
        err instanceof ConvexError && typeof err.data === "object" && err.data !== null
          ? String((err.data as { message?: string }).message ?? "Save failed.")
          : err instanceof ConvexError
            ? String(err.data)
            : "Save failed. Nothing was changed — try again.";
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mod-edit-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Edit</span>
      </nav>
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
          {form.fields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              values={values}
              setValue={setValue}
            />
          ))}
          <label>
            Change comment (required)
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={2}
              placeholder="Why is this change correct?"
              required
            />
          </label>
          <div>
            <button type="submit" disabled={busy || dirty.size === 0 || comment.trim() === ""}>
              {busy ? "Saving…" : "Save as approved change"}
            </button>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {savedSeq !== null ? (
            <p className="notice">Saved — revision #{savedSeq} recorded.</p>
          ) : null}
        </form>
      )}
    </main>
  );
}
