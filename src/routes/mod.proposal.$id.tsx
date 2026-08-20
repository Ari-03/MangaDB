import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PROPOSAL_WARNINGS } from "../../convex/proposals";
import { mutationErrorMessage } from "~/lib/editForm";
import { renderFieldValue, useIsDataTeam } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The proposal review page (ticket #32, spec §5). A Moderator reviews the
 * exact immutable version — grouped before/after per record, evidence beside
 * the changes, base Revisions, structural impacts of creates — and approves,
 * rejects, or requests changes. The author submits, withdraws, or rebases.
 * Data-Team-only; internal discussion stays here, never public. Never
 * indexed.
 */
export const Route = createFileRoute("/mod/proposal/$id")({
  head: () => ({
    meta: [
      { title: "Proposal — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ProposalPage,
});

function ProposalPage() {
  const { id } = Route.useParams();
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  return <ProposalGate id={id} />;
}

function ProposalGate({ id }: { id: string }) {
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
          Pending proposals are Data-Team-only in v1.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ProposalDetail id={id} />;
}

const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  inReview: "In Review",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

function warningLabel(warning: string): string {
  return (
    PROPOSAL_WARNINGS[warning as keyof typeof PROPOSAL_WARNINGS] ?? warning
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
                {op.stale ? <strong className="queue-stale">stale</strong> : null}
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
          ) : (
            <p>
              {/* Sensitive catalog operations (ticket #33) render as a
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
      <main>
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main>
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
        const data = (err as { data?: unknown })?.data as
          | { code?: string; warnings?: string[] }
          | undefined;
        if (data?.code === "warningsUnacknowledged" && data.warnings) {
          setPendingWarnings(data.warnings);
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
    <main className="mod-proposal-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <Link to="/mod/queue">Review queue</Link> <span aria-hidden="true">/</span>{" "}
        <span>Proposal</span>
      </nav>
      <h1>
        Proposal: {STATE_LABELS[detail.state] ?? detail.state}
        {detail.stale ? <span className="queue-stale"> · stale</span> : null}
      </h1>
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
          {detail.state === "draft" ? (
            <button disabled={busy} onClick={() => void onSubmitDraft()}>
              Submit for review
            </button>
          ) : null}{" "}
          <button
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
          </button>{" "}
          <button
            disabled={busy}
            onClick={() =>
              void run(() => withdrawProposal({ proposalId }), "Withdrawn.")
            }
          >
            Withdraw
          </button>
          {pendingWarnings ? (
            <div className="notice">
              <p>This submission carries warnings:</p>
              <ul>
                {pendingWarnings.map((warning) => (
                  <li key={warning}>{warningLabel(warning)}</li>
                ))}
              </ul>
              <button
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
          <button
            disabled={busy}
            onClick={() =>
              void run(() => claimProposal({ proposalId }), "Claimed.")
            }
          >
            Claim
          </button>{" "}
          <button
            disabled={busy}
            onClick={() =>
              void run(() => unclaimProposal({ proposalId }), "Unclaimed.")
            }
          >
            Unclaim
          </button>{" "}
          <button disabled={busy || detail.stale} onClick={() => void onApprove()}>
            Approve this version
          </button>
          <label>
            Decision note (required to reject or request changes)
            <textarea
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              rows={2}
            />
          </label>
          <button
            disabled={busy || decisionNote.trim() === ""}
            onClick={() =>
              void run(
                () => requestChanges({ proposalId, note: decisionNote }),
                "Returned to Draft — the author can revise and resubmit.",
              )
            }
          >
            Request changes
          </button>{" "}
          <button
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
