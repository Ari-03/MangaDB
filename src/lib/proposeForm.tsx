// The update-proposal form two pages share: the Editor's /mod/propose and
// the reader's /suggest. Edits become a Draft Proposal; submission
// validates, requires a change comment (and source evidence for factual
// changes), and lands the immutable Proposal Version In Review in the
// shared queue. Renders from the same registry the mutations validate
// against. The server anchors every op on the base Revision current when
// the draft is saved, so the form follows the live record until the first
// edit or tick and pins its values then; a newer Revision arriving asks
// the person to reload before saving. The Cover and Description sections
// are the edit form's (lib/coverField.tsx, lib/descriptionField.tsx): a
// staged cover upload is held by the Draft once saved, and a blurb used
// from a source goes in as evidence.
//
// On /mod/propose each Human Override on an editable field can be ticked
// for clearing, which adds a clearOverride op to the same Proposal. A
// reader's Suggestion changes fields only (convex/proposals.ts
// checkSuggestionOps), so /suggest offers no clears, and it can resume one
// of the reader's own Drafts (`resume`), such as one sent back for changes,
// when it can show the whole Draft: one update of this form's record. It
// keeps the Draft's evidence as saved, apart from the source controls,
// until the reader removes a row.

import { Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { editorialField, type RecordType } from "../../convex/lib/moderationFields";
import { CoverField } from "~/lib/coverField";
import { DescriptionField } from "~/lib/descriptionField";
import { ConcealArt } from "~/lib/mature";
import { useIsDataTeam } from "~/lib/viewer";
import {
  draftCitation,
  FieldInput,
  fieldValue,
  initialFormState,
  resumedFormState,
  sourceKeys,
  stateKeysOf,
  type FormState,
} from "~/lib/editForm";
import { CLEAR_OVERRIDE_HINT, writtenByLabel } from "~/lib/moderation";
import { Breadcrumbs, RecordPageLink } from "~/lib/pageScaffold";
import { ProposalWarnings, useProposalDraft, type DraftContent } from "~/lib/proposalDraft";
import { EvidenceList } from "~/lib/proposalView";

/** Which page the form is on: the Editor's proposal, or a reader's Suggestion. */
export type FormMode = "propose" | "suggest";

/** One of the viewer's own Proposals (convex/suggestions.ts detail). */
export type OwnProposal = NonNullable<FunctionReturnType<typeof api.suggestions.detail>>;

type EditForm = NonNullable<FunctionReturnType<typeof api.moderation.editForm>>;

/** A Draft's ops and evidence as its page shows them (when it loaded them). */
type SavedContent = Exclude<NonNullable<OwnProposal["draft"]>["content"], "notLoaded">;

/** A Draft's evidence rows as its page shows them. */
type SavedEvidence = SavedContent["evidence"];

/** A Draft being revised: its id, the form state it resumes, and its evidence. */
type Resumed = {
  proposalId: Id<"proposals">;
  values: FormState;
  dirty: Set<string>;
  comment: string;
  evidence: SavedEvidence;
};

/**
 * The working copy of `draft`, one of the viewer's own Drafts, when this
 * form can show all of it on `form`'s record: at most one op, an update of
 * that record. Saving from the form rewrites the whole Draft, so anything
 * more would be dropped. Null otherwise, and when its page could not load
 * the Draft's changes.
 */
function wholeDraftOn(form: EditForm, draft: OwnProposal) {
  const working = draft.draft;
  if (draft.state !== "draft" || !working || typeof working.content === "string") return null;
  const { ops, evidence } = working.content;
  if (ops.length > 1) return null;
  const [update] = ops;
  if (
    update &&
    (update.kind !== "update" ||
      update.recordId !== form.ref.id ||
      update.recordType !== form.ref.type)
  ) {
    return null;
  }
  return { comment: working.comment, evidence, update };
}

/**
 * The form state `draft` resumes on `form`'s record (wholeDraftOn): its
 * update over the live values, its comment, and its evidence, kept as
 * saved. A blurb used from a source comes back as that choice.
 */
function resumeOn(form: EditForm, draft: OwnProposal): Resumed | null {
  const working = wholeDraftOn(form, draft);
  if (!working) return null;
  const { update } = working;
  const observation = working.evidence.find((row) => row.kind === "observation");
  const { values, dirty } = update
    ? resumedFormState(
        form.fields,
        update,
        observation?.kind === "observation" ? observation.observationId : null,
        form.attribution,
      )
    : { values: initialFormState(form.fields), dirty: new Set<string>() };
  return {
    proposalId: draft.proposalId,
    values,
    dirty,
    comment: working.comment,
    evidence: working.evidence,
  };
}

type Evidence = DraftContent["evidence"][number];

/** Evidence as saveDraft takes it, from a Draft's rows as its page shows them. */
function storedEvidence(rows: SavedEvidence): Evidence[] {
  return rows.map((row) => {
    if (row.kind === "observation") return { kind: row.kind, observationId: row.observationId };
    if (row.kind === "note") return { kind: row.kind, text: row.text };
    return row.note
      ? { kind: row.kind, url: row.url, note: row.note }
      : { kind: row.kind, url: row.url };
  });
}

/** `rows` with each repeat after the first left out. */
function distinct(rows: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const COPY = {
  propose: {
    title: "Propose a change",
    hint: "Your submission goes to the shared review queue; a Moderator approves it into the record's public history. Factual changes need source evidence.",
  },
  suggest: {
    title: "Suggest a change",
    hint: "A Moderator reviews your suggestion before it changes the page, and it then shows in the record's public history under your username. Dates, ISBNs, titles and other facts need a link to a page that shows them; descriptions and covers do not.",
  },
} as const;

/**
 * The form for `type` at `editKey`, loading its record (moderation.editForm).
 * `resume` is a Draft of the viewer's to revise instead of starting one.
 */
export function ProposeForm({
  type,
  editKey,
  mode,
  resume,
}: {
  type: RecordType;
  editKey: string;
  mode: FormMode;
  resume?: OwnProposal;
}) {
  const form = useQuery(api.moderation.editForm, { type, key: editKey });
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
  // Reopening pins the Draft to the record as it is now, so an out-of-date
  // one would skip the Rebase that shows what changed since.
  if (resume?.stale) {
    return (
      <main className="mod-page suggest-page">
        <h1>{COPY[mode].title}</h1>
        <p className="notice">
          The record changed since this draft was saved.{" "}
          <Link to="/me/suggestions/$id" params={{ id: resume.proposalId }}>
            Open the draft
          </Link>{" "}
          to rebase it, then edit it here.
        </p>
      </main>
    );
  }
  if (resume && !wholeDraftOn(form, resume)) {
    return (
      <main className="mod-page suggest-page">
        <h1>{COPY[mode].title}</h1>
        <p className="notice">
          That draft changes more than this form can show, and saving here would drop the rest.{" "}
          <Link to="/me/suggestions/$id" params={{ id: resume.proposalId }}>
            Open the draft
          </Link>{" "}
          to submit or withdraw it.
        </p>
      </main>
    );
  }
  return <ProposeFormBody type={type} form={form} mode={mode} resume={resume} />;
}

function ProposeFormBody({
  type,
  form,
  mode,
  resume,
}: {
  type: RecordType;
  form: EditForm;
  mode: FormMode;
  resume?: OwnProposal;
}) {
  // A resumed Draft starts pinned to the record as it loaded.
  const [resumed] = useState(() => (resume ? resumeOn(form, resume) : null));
  const suggest = mode === "suggest";
  const isDataTeam = useIsDataTeam();
  // Where a saved Draft lives follows what it becomes: a Data Team member's
  // new Draft from /suggest is an ordinary Proposal, while a resumed Draft is
  // always the viewer's own Suggestion.
  const ownSuggestion = suggest && (resumed !== null || !isDataTeam);
  const draft = useProposalDraft({ resume: resumed?.proposalId, suggest: ownSuggestion });
  const [state, setState] = useState<FormState | null>(resumed?.values ?? null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(resumed?.dirty ?? new Set());
  const [clears, setClears] = useState<ReadonlySet<string>>(new Set());
  // The base Revision the pinned values and ticks were made against; unset
  // while the form still follows the live record.
  const [pinnedBase, setPinnedBase] = useState<{ id: string | null } | null>(
    resumed ? { id: form.baseRevisionId } : null,
  );
  const [comment, setComment] = useState(resumed?.comment ?? "");
  // A resumed Draft's evidence, saved again as it is until a row is removed.
  const [keptEvidence, setKeptEvidence] = useState(resumed?.evidence ?? []);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [uploading, setUploading] = useState(false);

  const values = state ?? initialFormState(form.fields);
  const pin = () => {
    if (!pinnedBase) setPinnedBase({ id: form.baseRevisionId });
  };
  // Someone else changed the record after the values were pinned: a save
  // now would anchor the ops on a state the person has not seen.
  const stale = pinnedBase !== null && pinnedBase.id !== form.baseRevisionId;
  const setValues = (patch: FormState) => {
    pin();
    setState({ ...values, ...patch });
    setDirty(new Set([...dirty, ...Object.keys(patch)]));
    draft.clearSaved();
  };
  const setValue = (key: string, value: string) => setValues({ [key]: value });
  const initial = initialFormState(form.fields);
  const coverField = form.fields.find((field) => field.kind === "image");
  const textName = editorialField(type)?.name;
  const textField = form.fields.find((field) => field.name === textName);
  const plainFields = form.fields.filter((field) => field !== coverField && field !== textField);

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
  // A Suggestion clears nothing.
  const activeClears = suggest ? [] : form.overrides.filter(({ field }) => clears.has(field));
  const changed =
    dirty.size > 0 ||
    activeClears.length > 0 ||
    keptEvidence.length !== (resumed?.evidence.length ?? 0);

  const buildArgs = (): DraftContent => {
    const changes: Array<{ field: string; value: unknown }> = [];
    for (const field of form.fields) {
      if (!stateKeysOf(field).some((k) => dirty.has(k))) continue;
      const result = fieldValue(field, values);
      if (!result.ok) throw new ConvexError({ message: result.message });
      changes.push({ field: field.name, value: result.value });
    }
    const cited = draftCitation(textField ?? null, values, dirty, form.attribution);
    if (!cited.ok) throw new ConvexError({ message: cited.message });
    const evidence = [...storedEvidence(keptEvidence), ...cited.evidence];
    if (evidenceUrl.trim() !== "") {
      evidence.push({ kind: "url", url: evidenceUrl.trim() });
    }
    if (evidenceNote.trim() !== "") {
      evidence.push({ kind: "note", text: evidenceNote.trim() });
    }
    return {
      ops: [
        ...(changes.length > 0 || cited.citation !== undefined
          ? [
              {
                kind: "update" as const,
                ref: form.ref as never,
                changes,
                citation: cited.citation,
              },
            ]
          : []),
        ...activeClears.map(({ field }) => ({
          kind: "clearOverride" as const,
          ref: form.ref as never,
          field,
        })),
      ],
      evidence: distinct(evidence),
      comment,
    };
  };

  const copy = COPY[mode];
  return (
    <main className={suggest ? "mod-page suggest-page" : "mod-page mod-edit-page"}>
      <Breadcrumbs
        trail={
          suggest && form.backLink
            ? [
                <RecordPageLink key="record" page={form.backLink} title={form.backLink.title}>
                  {form.backLink.title}
                </RecordPageLink>,
                copy.title,
              ]
            : [suggest ? copy.title : "Propose"]
        }
      />
      <h1>
        {copy.title}: {form.title}
      </h1>
      <p className="section-hint">{copy.hint}</p>
      {resumed ? (
        <p className="notice">
          You are revising a saved draft.{" "}
          <Link to="/me/suggestions/$id" params={{ id: resumed.proposalId }}>
            See it
          </Link>
          .
        </p>
      ) : null}
      {!suggest && form.overriddenFields.length > 0 ? (
        <p className="notice">
          Human-corrected fields (imports never overwrite these): {form.overriddenFields.join(", ")}
          .
        </p>
      ) : null}
      {!editable ? (
        <p className="notice">
          This record is {form.locked ? "locked" : form.status} and cannot be changed by ordinary
          proposals.
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
                This record was changed by someone else after you started editing. Reload the latest
                version to continue; your unsaved edits and ticked clears will be discarded.
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
          {form.cover && coverField ? (
            // A reader who has not opted in to 18+ art sees cloth for a
            // Mature Series' covers here too, as on its public pages.
            <ConcealArt mature={ownSuggestion && form.cover.mature} notice={false}>
              <CoverField
                cover={form.cover}
                boxSet={type === "releaseBundle"}
                title={form.title}
                value={values[coverField.name] ?? ""}
                initial={initial[coverField.name] ?? ""}
                setValue={(value) => setValue(coverField.name, value)}
                revert={() => {
                  setState({ ...values, [coverField.name]: initial[coverField.name] ?? "" });
                  setDirty(new Set([...dirty].filter((key) => key !== coverField.name)));
                  draft.clearSaved();
                }}
                onUploading={setUploading}
                overridden={form.overriddenFields.includes(coverField.name)}
                disabled={draft.busy}
                formRoute={suggest ? "/suggest/$type/$key" : "/mod/propose/$type/$key"}
                knownArt={resume?.coverArt}
              />
            </ConcealArt>
          ) : null}
          {plainFields.map((field) => (
            <FieldInput key={field.name} field={field} values={values} setValue={setValue} />
          ))}
          {textField ? (
            <DescriptionField
              type={type}
              recordId={form.ref.id}
              field={textField}
              attribution={form.attribution}
              values={values}
              dirty={dirty}
              initialText={initial[textField.name] ?? ""}
              setValues={setValues}
              disabled={draft.busy}
            />
          ) : null}
          {suggest
            ? null
            : form.overrides.map((override) => (
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
          {keptEvidence.length > 0 ? (
            <div className="kept-evidence">
              <p className="k">Evidence saved with this draft</p>
              <EvidenceList
                evidence={keptEvidence}
                onRemove={(index) => {
                  const row = keptEvidence[index];
                  setKeptEvidence(keptEvidence.filter((_, i) => i !== index));
                  draft.clearSaved();
                  // A blurb used from this source would add it back on save;
                  // keep its name and page as a cited page instead.
                  const keys = textField ? sourceKeys(textField.name) : null;
                  if (
                    keys &&
                    row?.kind === "observation" &&
                    values[keys.observation] === row.observationId
                  ) {
                    setValues({ [keys.mode]: "custom", [keys.observation]: "" });
                  }
                }}
              />
            </div>
          ) : null}
          <label>
            {keptEvidence.length > 0 ? "Another source evidence URL" : "Source evidence URL"}
            <input
              type="url"
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value)}
              placeholder="https://publisher.example/the-page-showing-the-fact"
            />
            <span className="field-help">
              Required for factual changes (dates, ISBNs, titles…) — link the page that shows the
              fact.
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
              disabled={draft.busy || uploading || stale || !changed}
              onClick={() => void draft.saveDraft(buildArgs)}
            >
              Save draft
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={draft.busy || uploading || stale || !changed || comment.trim() === ""}
            >
              {draft.busy ? "Working…" : uploading ? "Uploading…" : "Submit for review"}
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
              {ownSuggestion ? (
                <Link to="/me/suggestions/$id" params={{ id: draft.draftId }}>
                  View it
                </Link>
              ) : (
                <Link to="/mod/proposal/$id" params={{ id: draft.draftId }}>
                  View it
                </Link>
              )}
              .
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}
