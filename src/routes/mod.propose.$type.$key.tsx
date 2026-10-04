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
import { CLEAR_OVERRIDE_HINT, ModGate, writtenByLabel } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { convexClient } from "~/providers";

/**
 * The Editor update-proposal form (spec §5): edits become a
 * Draft Proposal; submission validates, requires a change comment (and
 * source evidence for factual changes), and lands the immutable Proposal
 * Version In Review in the shared queue. Each Human Override on an editable
 * field can be ticked for clearing, which adds a clearOverride op to the
 * same Proposal. Renders from the same registry the mutations validate
 * against. The server anchors every op on the base Revision current when
 * the draft is saved, so the form follows the live record until the first
 * edit or tick and pins its values then; a newer Revision arriving asks the
 * Editor to reload before saving. Auth-gated client-side for UX; the Convex
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
  const [clears, setClears] = useState<ReadonlySet<string>>(new Set());
  // The base Revision the pinned values and ticks were made against; unset
  // while the form still follows the live record.
  const [pinnedBase, setPinnedBase] = useState<{ id: string | null } | null>(null);
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
  const pin = () => {
    if (!pinnedBase) setPinnedBase({ id: form.baseRevisionId });
  };
  // Someone else changed the record after the values were pinned: a save
  // now would anchor the ops on a state the Editor has not seen.
  const stale = pinnedBase !== null && pinnedBase.id !== form.baseRevisionId;
  const setValue = (key: string, value: string) => {
    pin();
    setState({ ...values, [key]: value });
    setDirty(new Set([...dirty, key]));
    draft.clearSaved();
  };

  const editable = form.status === "active" && !form.locked;
  const toggleClear = (field: string, on: boolean) => {
    pin();
    const next = new Set(clears);
    if (on) next.add(field);
    else next.delete(field);
    setClears(next);
    draft.clearSaved();
  };
  // A ticked clear counts only while the override is still on the record:
  // once someone else clears it, its checkbox is gone and so is the op.
  const activeClears = form.overrides.filter((override) => clears.has(override.field));
  const changed = dirty.size > 0 || activeClears.length > 0;

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
        ...(changes.length > 0
          ? [{ kind: "update" as const, ref: form.ref as never, changes }]
          : []),
        ...activeClears.map(({ field }) => ({
          kind: "clearOverride" as const,
          ref: form.ref as never,
          field,
        })),
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
            if (!stale) void draft.submit(buildArgs);
          }}
        >
          {stale ? (
            <div className="notice" role="alert">
              <p>
                This record was changed by someone else after you started
                editing. Reload the latest version to continue; your unsaved
                edits and ticked clears will be discarded.
              </p>
              <button
                type="button"
                className="btn"
                disabled={draft.busy}
                onClick={() => {
                  setState(null);
                  setDirty(new Set());
                  setClears(new Set());
                  setPinnedBase(null);
                  draft.clearSaved();
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
              values={values}
              setValue={setValue}
            />
          ))}
          {form.overrides.map((override) => (
            <label key={override.field}>
              <span>
                <input
                  type="checkbox"
                  checked={clears.has(override.field)}
                  onChange={(event) => toggleClear(override.field, event.target.checked)}
                />{" "}
                Clear the Human Override on {override.label} (
                {writtenByLabel(override.writtenBy)})
              </span>
              <span className="field-help">{CLEAR_OVERRIDE_HINT}</span>
            </label>
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
              disabled={draft.busy || stale || !changed}
              onClick={() => void draft.saveDraft(buildArgs)}
            >
              Save draft
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={draft.busy || stale || !changed || comment.trim() === ""}
            >
              {draft.busy ? "Working…" : "Submit for review"}
            </button>
          </div>
          {draft.pendingWarnings ? (
            <ProposalWarnings
              warnings={draft.pendingWarnings}
              busy={draft.busy || stale}
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
