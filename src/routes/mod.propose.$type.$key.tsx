import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EDITABLE_FIELDS,
  type RecordType,
} from "../../convex/lib/moderationFields";
import { PROPOSAL_WARNINGS } from "../../convex/proposals";
import {
  FieldInput,
  fieldValue,
  initialFormState,
  mutationErrorMessage,
  stateKeysOf,
  type FormState,
} from "~/lib/editForm";
import { useIsDataTeam } from "~/lib/moderation";
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
  head: () => ({
    meta: [
      { title: "Propose a change — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ModProposePage,
});

function isRecordType(raw: string): raw is RecordType {
  return raw in EDITABLE_FIELDS;
}

function ModProposePage() {
  const { type, key } = Route.useParams();
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  if (!isRecordType(type)) {
    return (
      <main>
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing proposable lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return <ProposeGate type={type} editKey={key} />;
}

function ProposeGate({ type, editKey }: { type: RecordType; editKey: string }) {
  const isDataTeam = useIsDataTeam();
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) {
    return (
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isDataTeam) {
    return (
      <main>
        <h1>Data team only</h1>
        <p className="notice">
          Proposing changes needs an Editor (or stronger) role.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ProposeForm type={type} editKey={editKey} />;
}

function ProposeForm({ type, editKey }: { type: RecordType; editKey: string }) {
  const navigate = useNavigate();
  const form = useQuery(api.moderation.editForm, { type, key: editKey });
  const saveDraft = useMutation(api.proposals.saveDraft);
  const submitProposal = useMutation(api.proposals.submitProposal);
  const [state, setState] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [comment, setComment] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [draftId, setDraftId] = useState<Id<"proposals"> | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState(false);

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
    setSavedDraft(false);
  };

  const editable = form.status === "active" && !form.locked;

  const buildArgs = () => {
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
      proposalId: draftId ?? undefined,
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

  const save = async (): Promise<Id<"proposals">> => {
    const { proposalId } = await saveDraft(buildArgs());
    setDraftId(proposalId);
    return proposalId;
  };

  const onSaveDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
      setSavedDraft(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Saving the draft failed."));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (acknowledgeWarnings?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const proposalId = await save();
      await submitProposal({ proposalId, acknowledgeWarnings });
      await navigate({
        to: "/mod/proposal/$id",
        params: { id: proposalId as string },
      });
    } catch (err) {
      const data = (err as { data?: unknown })?.data as
        | { code?: string; warnings?: string[] }
        | undefined;
      if (data?.code === "warningsUnacknowledged" && data.warnings) {
        setPendingWarnings(data.warnings);
      } else {
        setError(mutationErrorMessage(err, "Submitting the proposal failed."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mod-edit-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Propose</span>
      </nav>
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
            void onSubmit();
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
          <div>
            <button
              type="button"
              disabled={busy || dirty.size === 0}
              onClick={() => void onSaveDraft()}
            >
              Save draft
            </button>{" "}
            <button
              type="submit"
              disabled={busy || dirty.size === 0 || comment.trim() === ""}
            >
              {busy ? "Working…" : "Submit for review"}
            </button>
          </div>
          {pendingWarnings ? (
            <div className="notice">
              <p>This proposal carries warnings:</p>
              <ul>
                {pendingWarnings.map((warning) => (
                  <li key={warning}>
                    {PROPOSAL_WARNINGS[
                      warning as keyof typeof PROPOSAL_WARNINGS
                    ] ?? warning}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onSubmit(pendingWarnings)}
              >
                Acknowledge and submit
              </button>
            </div>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          {savedDraft && draftId ? (
            <p className="notice">
              Draft saved.{" "}
              <Link to="/mod/proposal/$id" params={{ id: draftId as string }}>
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
