import { createFileRoute, Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { RecordType } from "../../convex/lib/moderationFields";
import {
  FieldInput,
  fieldValue,
  initialFormState,
  isRecordType,
  stateKeysOf,
  type FormState,
} from "~/lib/editForm";
import { ProposalWarnings, useProposalDraft, type DraftContent } from "~/lib/proposalDraft";
import { ModGate } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { convexClient } from "~/providers";

/**
 * The Editor update-proposal form (ticket #32, spec §5): edits become a
 * Draft Proposal; submission validates, requires a change comment (and
 * source evidence for factual changes), and lands the immutable Proposal
 * Version In Review in the shared queue. Renders from the same registry the
 * mutations validate against. Auth-gated client-side for UX; the Convex
 * functions re-check the role on every call. Never indexed.
 */
export const Route = createFileRoute("/mod/propose/$type/$key")({
  head: () => ({ meta: [{ title: "Propose a change — MangaDB" }] }),
  component: ModProposePage,
});

function ModProposePage() {
  const { type, key } = Route.useParams();
  if (!convexClient) {
    return (
      <main className="mod-page">
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  if (!isRecordType(type)) {
    return (
      <main className="mod-page">
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing proposable lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return (
    <ModGate
      role="dataTeam"
      refusal="Proposing changes needs an Editor (or stronger) role."
    >
      <ProposeForm type={type} editKey={key} />
    </ModGate>
  );
}

function ProposeForm({ type, editKey }: { type: RecordType; editKey: string }) {
  const form = useQuery(api.moderation.editForm, { type, key: editKey });
  const draft = useProposalDraft();
  const [state, setState] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [comment, setComment] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");

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

  const values = state ?? initialFormState(form.fields);
  const setValue = (key: string, value: string) => {
    setState({ ...values, [key]: value });
    setDirty(new Set([...dirty, key]));
    draft.clearSaved();
  };

  const editable = form.status === "active" && !form.locked;

  const buildArgs = (): DraftContent => {
    const changes: Array<{ field: string; value: unknown }> = [];
    for (const field of form.fields) {
      if (!stateKeysOf(field).some((k) => dirty.has(k))) continue;
      const result = fieldValue(field, values);
      if (!result.ok) throw new ConvexError({ message: result.message });
      changes.push({ field: field.name, value: result.value });
    }
    const evidence: Array<
      { kind: "url"; url: string; note?: string } | { kind: "note"; text: string }
    > = [];
    if (evidenceUrl.trim() !== "") {
      evidence.push({ kind: "url", url: evidenceUrl.trim() });
    }
    if (evidenceNote.trim() !== "") {
      evidence.push({ kind: "note", text: evidenceNote.trim() });
    }
    return {
      ops: [
        {
          kind: "update" as const,
          ref: form.ref as never,
          changes,
        },
      ],
      evidence,
      comment,
    };
  };

  return (
    <main className="mod-page mod-edit-page">
      <Breadcrumbs trail={["Propose"]} />
      <h1>Propose a change: {form.title}</h1>
      <p className="section-hint">
        Your submission goes to the shared review queue; a Moderator approves
        it into the record's public history. Factual changes need source
        evidence.
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
          changed by ordinary proposals.
        </p>
      ) : (
        <form
          className="mod-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void draft.submit(buildArgs);
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
          <label>
            Source evidence URL
            <input
              type="url"
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value)}
              placeholder="https://publisher.example/the-page-showing-the-fact"
            />
            <span className="field-help">
              Required for factual changes (dates, ISBNs, titles…) — link the
              page that shows the fact.
            </span>
          </label>
          <label>
            Evidence note
            <textarea
              value={evidenceNote}
              onChange={(event) => setEvidenceNote(event.target.value)}
              rows={2}
            />
          </label>
          <div className="mod-actions">
            <button
              type="button"
              className="btn"
              disabled={draft.busy || dirty.size === 0}
              onClick={() => void draft.saveDraft(buildArgs)}
            >
              Save draft
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={draft.busy || dirty.size === 0 || comment.trim() === ""}
            >
              {draft.busy ? "Working…" : "Submit for review"}
            </button>
          </div>
          {draft.pendingWarnings ? (
            <ProposalWarnings
              warnings={draft.pendingWarnings}
              busy={draft.busy}
              onAcknowledge={(warnings) => void draft.submit(buildArgs, warnings)}
            />
          ) : null}
          {draft.error ? <p className="form-error">{draft.error}</p> : null}
          {draft.savedDraft && draft.draftId ? (
            <p className="notice">
              Draft saved.{" "}
              <Link to="/mod/proposal/$id" params={{ id: draft.draftId as string }}>
                View it
              </Link>
              .
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}
