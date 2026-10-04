import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mutationErrorMessage } from "~/lib/errors";
import {
  CLEAR_OVERRIDE_HINT,
  ModGate,
  ProposalStateChip,
  renderFieldValue,
  writtenByLabel,
} from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { unacknowledgedWarnings, warningLabel } from "~/lib/proposalDraft";
import { convexClient } from "~/providers";

/**
 * The proposal review page (spec §5). A Moderator reviews the
 * exact immutable version — grouped before/after per record, evidence beside
 * the changes, base Revisions, structural impacts of creates — and approves,
 * rejects, or requests changes. The author submits, withdraws, or rebases.
 * Data-Team-only; internal discussion stays here, never public. Never
 * indexed.
 */
export const Route = createFileRoute("/mod/proposal/$id")({
  head: () => ({ meta: [{ title: "Proposal — MangaDB" }] }),
  component: ProposalPage,
});

function ProposalPage() {
  const { id } = Route.useParams();
  if (!convexClient) {
    return (
      <main className="mod-page">
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  return (
    <ModGate
      role="dataTeam"
      refusal="Pending proposals are Data-Team-only in v1."
    >
      <ProposalDetail id={id} />
    </ModGate>
  );
}

type Detail = NonNullable<
  FunctionReturnType<typeof api.proposals.proposalDetail>
>;
type RenderedOps = Detail["versions"][number]["ops"];
type RenderedEvidence = Detail["versions"][number]["evidence"];

function OpsList({ ops }: { ops: RenderedOps }) {
  return (
    <ol className="proposal-ops">
      {ops.map((op, i) => (
        <li key={i} className="proposal-op">
          {op.kind === "create" ? (
            <>
              <p>
                <strong>{op.summary}</strong>{" "}
                <code className="temp-id">temp:{op.tempId}</code>
              </p>
              <ul className="revision-changes">
                {Object.entries(op.fields ?? {}).map(([field, value]) =>
                  value === undefined ? null : (
                    <li key={field}>
                      <code>{field}</code>: <ins>{renderFieldValue(value)}</ins>
                    </li>
                  ),
                )}
              </ul>
            </>
          ) : op.kind === "update" ? (
            <>
              <p>
                <strong>
                  Update {op.recordType}: {op.recordTitle}
                </strong>{" "}
                <span className="proposal-base">
                  (base: revision #{op.base.seq}
                  {op.base.comment ? ` — ${op.base.comment}` : ""})
                </span>{" "}
                {op.stale ? (
                  <span className="chip mod-chip mod-chip--bad">stale</span>
                ) : null}
              </p>
              <ul className="revision-changes">
                {op.changes.map((change) => (
                  <li key={change.field}>
                    <code>{change.field}</code>:{" "}
                    <del>{renderFieldValue(change.before)}</del> →{" "}
                    <ins>{renderFieldValue(change.after)}</ins>
                  </li>
                ))}
              </ul>
            </>
          ) : op.kind === "clearOverride" ? (
            <>
              <p>
                <strong>
                  Clear the Human Override on {op.fieldLabel} of {op.recordType}:{" "}
                  {op.recordTitle}
                </strong>{" "}
                <span className="proposal-base">
                  (base: revision #{op.base.seq}
                  {op.base.comment ? ` — ${op.base.comment}` : ""})
                </span>{" "}
                {op.stale ? (
                  <span className="chip mod-chip mod-chip--bad">stale</span>
                ) : null}
              </p>
              <ul className="revision-changes">
                <li>
                  <code>{op.field}</code> keeps its value:{" "}
                  {renderFieldValue(op.value)} ({writtenByLabel(op.writtenBy)})
                </li>
                <li>{CLEAR_OVERRIDE_HINT}</li>
              </ul>
            </>
          ) : (
            <p>
              {/* Sensitive catalog operations render as a
                  one-line summary; their full impact preview lives on the
                  record's manage panel. */}
              <strong>{op.summary}</strong>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function EvidenceList({ evidence }: { evidence: RenderedEvidence }) {
  if (evidence.length === 0) {
    return <p className="section-hint">No evidence attached.</p>;
  }
  return (
    <ul className="proposal-evidence">
      {evidence.map((row, i) => (
        <li key={i}>
          {row.kind === "url" ? (
            <>
              <a href={row.url} rel="nofollow noreferrer">
                {row.url}
              </a>
              {row.note ? ` — ${row.note}` : null}
            </>
          ) : row.kind === "observation" ? (
            <>
              Source observation: {row.sourceKey}
              {row.url ? (
                <>
                  {" "}
                  (
                  <a href={row.url} rel="nofollow noreferrer">
                    record page
                  </a>
                  )
                </>
              ) : null}
            </>
          ) : (
            <>Note: {row.text}</>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProposalDetail({ id }: { id: string }) {
  const detail = useQuery(api.proposals.proposalDetail, {
    proposalId: id as Id<"proposals">,
  });
  const submitProposal = useMutation(api.proposals.submitProposal);
  const withdrawProposal = useMutation(api.proposals.withdrawProposal);
  const rebaseProposal = useMutation(api.proposals.rebaseProposal);
  const claimProposal = useMutation(api.proposals.claimProposal);
  const unclaimProposal = useMutation(api.proposals.unclaimProposal);
  const approveProposal = useMutation(api.proposals.approveProposal);
  const rejectProposal = useMutation(api.proposals.rejectProposal);
  const requestChanges = useMutation(api.proposals.requestChanges);
  const addNote = useMutation(api.proposals.addNote);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [discussionNote, setDiscussionNote] = useState("");
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);

  if (detail === undefined) {
    return (
      <main className="mod-page">
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="mod-page">
        <h1>Proposal not found</h1>
        <p className="notice">
          No proposal lives at this address. <Link to="/mod/queue">Back to the queue</Link>.
        </p>
      </main>
    );
  }

  const proposalId = detail.proposalId as Id<"proposals">;
  const run = async (
    action: () => Promise<unknown>,
    okMessage: string | null = null,
  ) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
      if (okMessage) setInfo(okMessage);
    } catch (err) {
      setError(mutationErrorMessage(err, "The action failed."));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitDraft = (acknowledgeWarnings?: string[]) =>
    run(async () => {
      try {
        await submitProposal({ proposalId, acknowledgeWarnings });
        setPendingWarnings(null);
      } catch (err) {
        const warnings = unacknowledgedWarnings(err);
        if (warnings) {
          setPendingWarnings(warnings);
          return;
        }
        throw err;
      }
    }, "Submitted for review.");

  const onApprove = () =>
    run(async () => {
      const result = await approveProposal({ proposalId });
      if (result.status === "stale") {
        setInfo(
          "Approval blocked: records changed since this version was submitted. The proposal is flagged stale — the author must rebase and resubmit.",
        );
      } else {
        setInfo("Approved — public revisions created.");
      }
    });

  const currentVersion = detail.versions.find((version) => version.current);

  return (
    <main className="mod-page mod-proposal-page">
      <Breadcrumbs trail={[<Link to="/mod/queue">Review queue</Link>, "Proposal"]} />
      <div className="mod-title-row">
        <h1>Proposal</h1>
        <ProposalStateChip state={detail.state} />
        {detail.stale ? (
          <span className="chip mod-chip mod-chip--bad">stale</span>
        ) : null}
      </div>
      <p className="section-hint">
        By{" "}
        {detail.author.kind === "user"
          ? `@${detail.author.username ?? "deleted"}${detail.author.role ? ` (${detail.author.role})` : ""}`
          : `import source "${detail.author.sourceKey}"`}
        {detail.claimedBy
          ? ` · claimed by @${detail.claimedBy} (claims coordinate — any Moderator can still decide)`
          : null}
        {detail.decidedBy ? ` · decided by @${detail.decidedBy}` : null}
      </p>

      {detail.stale && detail.state === "inReview" ? (
        <p className="notice">
          A record this proposal touches changed since submission. Approval is
          blocked until the author explicitly rebases and resubmits — there is
          no silent rebase.
        </p>
      ) : null}

      {/* ---- author actions ---- */}
      {detail.viewer.isAuthor &&
      (detail.state === "draft" || detail.state === "inReview") ? (
        <section className="proposal-actions">
          <h2>Your proposal</h2>
          <div className="mod-actions">
          {detail.state === "draft" ? (
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void onSubmitDraft()}
            >
              Submit for review
            </button>
          ) : null}
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { dropped } = await rebaseProposal({ proposalId });
                setInfo(
                  dropped.length > 0
                    ? `Rebased to Draft. Dropped: ${dropped.join("; ")}.`
                    : "Rebased to Draft against the current records.",
                );
              })
            }
          >
            Rebase onto current records
          </button>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(() => withdrawProposal({ proposalId }), "Withdrawn.")
            }
          >
            Withdraw
          </button>
          </div>
          {pendingWarnings ? (
            <div className="notice">
              <p>This submission carries warnings:</p>
              <ul>
                {pendingWarnings.map((warning) => (
                  <li key={warning}>{warningLabel(warning)}</li>
                ))}
              </ul>
              <button
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void onSubmitDraft(pendingWarnings)}
              >
                Acknowledge and submit
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---- moderator actions ---- */}
      {detail.viewer.canReview && detail.state === "inReview" ? (
        <section className="proposal-actions">
          <h2>Review</h2>
          <div className="mod-actions">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void run(() => claimProposal({ proposalId }), "Claimed.")
              }
            >
              Claim
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void run(() => unclaimProposal({ proposalId }), "Unclaimed.")
              }
            >
              Unclaim
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || detail.stale}
              onClick={() => void onApprove()}
            >
              Approve this version
            </button>
          </div>
          <label>
            {detail.author.kind === "user"
              ? "Decision note (required to reject or request changes)"
              : "Decision note (required to reject)"}
            <textarea
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              rows={2}
            />
          </label>
          <div className="mod-actions">
            {/* An import cannot revise a Draft (proposals.requestChanges). */}
            {detail.author.kind === "user" ? (
              <button
                className="btn btn-sm"
                disabled={busy || decisionNote.trim() === ""}
                onClick={() =>
                  void run(
                    () => requestChanges({ proposalId, note: decisionNote }),
                    "Returned to Draft — the author can revise and resubmit.",
                  )
                }
              >
                Request changes
              </button>
            ) : null}
            <button
              className="btn btn-sm"
              disabled={busy || decisionNote.trim() === ""}
              onClick={() =>
                void run(
                  () => rejectProposal({ proposalId, note: decisionNote }),
                  "Rejected.",
                )
              }
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {info ? <p className="notice">{info}</p> : null}

      {/* ---- draft working copy ---- */}
      {detail.draft ? (
        <section className="proposal-version">
          <h2>Draft (mutable working copy)</h2>
          <p className="revision-comment">{detail.draft.comment || "(no comment yet)"}</p>
          {detail.draft.warnings.length > 0 ? (
            <p className="section-hint">
              Will warn on submit: {detail.draft.warnings.map(warningLabel).join("; ")}
            </p>
          ) : null}
          <OpsList ops={detail.draft.ops} />
          <h3>Evidence</h3>
          <EvidenceList evidence={detail.draft.evidence} />
        </section>
      ) : null}

      {/* ---- immutable versions, newest first ---- */}
      {[...detail.versions].reverse().map((version) => (
        <section key={version.versionNo} className="proposal-version">
          <h2>
            Version {version.versionNo}
            {version.current ? " (reviewed version)" : ""}
          </h2>
          <p className="revision-comment">{version.changeComment}</p>
          {version.warnings.length > 0 ? (
            <p className="section-hint">
              Acknowledged warnings: {version.warnings.map(warningLabel).join("; ")}
            </p>
          ) : null}
          <OpsList ops={version.ops} />
          <h3>Evidence</h3>
          <EvidenceList evidence={version.evidence} />
        </section>
      ))}
      {currentVersion === undefined && !detail.draft ? (
        <p className="notice">This proposal has no content yet.</p>
      ) : null}

      {/* ---- internal discussion ---- */}
      <section className="proposal-notes">
        <h2>Internal discussion</h2>
        <p className="section-hint">
          Data-Team-only. Public record history shows only the final diff,
          author, approver, and change comment.
        </p>
        {detail.notes.length === 0 ? (
          <p className="section-hint">No notes yet.</p>
        ) : (
          <ol>
            {detail.notes.map((note, i) => (
              <li key={i}>
                <strong>
                  {note.kind === "requestChanges"
                    ? "Changes requested"
                    : note.kind === "reject"
                      ? "Rejected"
                      : "Note"}
                </strong>{" "}
                by @{note.author ?? "deleted"} (v{note.versionNo}): {note.text}
              </li>
            ))}
          </ol>
        )}
        <label>
          Add a note
          <textarea
            value={discussionNote}
            onChange={(event) => setDiscussionNote(event.target.value)}
            rows={2}
          />
        </label>
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || discussionNote.trim() === ""}
          onClick={() =>
            void run(async () => {
              await addNote({ proposalId, text: discussionNote });
              setDiscussionNote("");
            })
          }
        >
          Add note
        </button>
      </section>
    </main>
  );
}
