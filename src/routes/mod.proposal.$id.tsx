import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { editorialField } from "../../convex/lib/moderationFields";
import { mutationErrorMessage } from "~/lib/errors";
import {
  FieldChangeItem,
  StatedSource,
  type CoverArt,
  CLEAR_OVERRIDE_HINT,
  ModGate,
  ProposalStateChip,
  renderFieldValue,
  writtenByLabel,
} from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { unacknowledgedWarnings, warningLabel } from "~/lib/proposalDraft";
import { slugParams } from "~/lib/slug";

/**
 * The proposal review page (spec §5). A Moderator reviews the
 * exact immutable version — grouped before/after per record, evidence beside
 * the changes, base Revisions, structural impacts of creates — and approves,
 * rejects, or requests changes. The author submits, withdraws, or rebases.
 * A Proposal that places a held book (convex/placement.ts) also shows what
 * its source says beside what approval creates, and its author states its
 * coverage and line here while it is a Draft. Data-Team-only; internal
 * discussion stays here, never public. Never indexed.
 */
export const Route = createFileRoute("/mod/proposal/$id")({
  head: () => ({ meta: [{ title: "Proposal — MangaDB" }] }),
  component: ProposalPage,
});

function ProposalPage() {
  const { id } = Route.useParams();
  return (
    <ModGate role="dataTeam" refusal="Pending proposals are Data-Team-only in v1.">
      <ProposalDetail id={id} />
    </ModGate>
  );
}

type Detail = NonNullable<FunctionReturnType<typeof api.proposals.proposalDetail>>;
type RenderedOps = Detail["versions"][number]["ops"];
type RenderedEvidence = Detail["versions"][number]["evidence"];
type Placement = NonNullable<Detail["placement"]>;

/** "2026-10-13", "2026-10" or "2026": a source date at the precision it gives. */
function partialDate(date: { year: number; month?: number; day?: number }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    String(date.year),
    ...(date.month !== undefined ? [pad(date.month)] : []),
    ...(date.day !== undefined ? [pad(date.day)] : []),
  ].join("-");
}

/** How the placed Edition's coverage reads. */
function coverageText(coverage: Placement["coverage"]): string {
  if (coverage.kind === "pending") return "not stated yet";
  if (coverage.kind === "unmapped") return "Unmapped Packaging: a Moderator maps its Volumes later";
  return coverage.volumes
    .map((volume) => `Volume ${volume.label ?? "(unlabeled)"}${volume.created ? " (new)" : ""}`)
    .join(", ");
}

/**
 * The placement form's inputs as the Draft states them: its coverage and
 * line, or, while its coverage is unstated, the line the Draft or its
 * source names.
 */
function placementForm({ coverage, line, book }: Placement) {
  const covered = coverage.kind === "volumes" ? coverage.volumes : [];
  const shown = coverage.kind === "pending" ? (line ?? book?.line ?? null) : line;
  return {
    from: covered[0]?.label ?? "",
    to: covered[covered.length - 1]?.label ?? "",
    unmapped: coverage.kind === "unmapped",
    lineName: shown?.name ?? "",
    linePosition: shown?.position ?? "",
  };
}

/**
 * A held book's placement: what its source says beside what approval
 * creates under the Series, a caution to check the book, and, for its
 * author while it is a Draft, the form that states its coverage (a range of
 * canonical Volumes, or Unmapped Packaging under its line), its line, and
 * the change comment, with the one Volume the page may suggest, saved only
 * when the author accepts it, which also fills the form with it. Saving
 * rebuilds the Draft's ops (placement.setPlacement).
 */
function PlacementPanel({
  placement,
  proposalId,
  editable,
  comment,
}: {
  placement: Placement;
  proposalId: Id<"proposals">;
  editable: boolean;
  comment: string;
}) {
  const setPlacement = useMutation(api.placement.setPlacement);
  const { book, coverage, suggestion } = placement;
  const [form, setForm] = useState(() => placementForm(placement));
  const { from, to, unmapped, lineName, linePosition } = form;
  const edit = (change: Partial<typeof form>) => setForm((current) => ({ ...current, ...change }));
  const [changeComment, setChangeComment] = useState(comment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (stated: { from: string; to: string } | null) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await setPlacement({
        proposalId,
        coverage: stated ?? (unmapped ? "unmapped" : { from, to: to.trim() === "" ? from : to }),
        line:
          stated === null && lineName.trim() !== ""
            ? { name: lineName, position: linePosition.trim() || null }
            : null,
        comment: changeComment,
      });
      // An accepted Volume is the coverage now, outside any line.
      if (stated !== null) setForm({ ...stated, unmapped: false, lineName: "", linePosition: "" });
      setSaved(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Saving the placement failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="proposal-version">
      <h2>Placement of a held book</h2>
      <h3>What the source says</h3>
      {book === null ? (
        <p className="section-hint">The source's record can no longer be read.</p>
      ) : (
        <ul className="revision-changes">
          <li>Title: {book.title}</li>
          <li>Volume label: {book.label ?? "none (a book number on a line is not a Volume)"}</li>
          <li>
            Edition Line:{" "}
            {book.line
              ? `${book.line.name}${book.line.position ? ` ${book.line.position}` : ""}`
              : "none"}
          </li>
          {book.statedRange ? (
            <li>
              Says it collects Volumes {book.statedRange.from}–{book.statedRange.to}
            </li>
          ) : null}
          <li>Publisher: {book.publisher ?? "none given"}</li>
          <li>ISBN-13: {book.isbn13 ?? "none"}</li>
          <li>Format: {book.format}</li>
          <li>Date: {book.pubDate ? partialDate(book.pubDate) : "none"}</li>
          <li>
            Source: {placement.sourceKey}
            {book.url ? (
              <>
                {" "}
                (
                <a href={book.url} rel="nofollow noreferrer">
                  record page
                </a>
                )
              </>
            ) : null}
          </li>
        </ul>
      )}
      <h3>What approval creates</h3>
      <ul className="revision-changes">
        <li>
          Series:{" "}
          {placement.series ? (
            <Link
              to="/series/$publicId/$slug"
              params={slugParams(placement.series.publicId, placement.series.title)}
            >
              {placement.series.title}
            </Link>
          ) : (
            "(missing)"
          )}{" "}
          (existing; never created here)
        </li>
        <li>
          Edition at {placement.publisherSlug ?? "(unknown publisher)"} covering:{" "}
          {coverageText(coverage)}
        </li>
        <li>
          Edition Line:{" "}
          {placement.line
            ? `${placement.line.name}${placement.line.position ? ` ${placement.line.position}` : ""}${placement.line.created ? " (new line)" : ""}`
            : "none"}
        </li>
        <li>
          Release: {placement.release.format ?? "?"}
          {placement.release.binding ? `, ${placement.release.binding}` : ""}
          {placement.release.isbn13 ? `, ISBN ${placement.release.isbn13}` : ""}; approval links the
          source's record to it
        </li>
      </ul>
      <p className="notice">
        Check that this book is the manga and not a novel of the same title, and that its number is
        its Volume number.
      </p>
      {coverage.kind === "pending" ? (
        <p className="notice">
          Its coverage is yours to state: the canonical Volumes it collects (one Volume is a range
          of one), or Unmapped Packaging under its line. A book number is a position in its line,
          not a Volume number. The Draft cannot be submitted until you state it.
        </p>
      ) : null}
      {editable && coverage.kind === "pending" && suggestion !== null ? (
        <div className="mod-actions">
          <span>The source's label suggests Volume {suggestion}, outside any line.</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void save({ from: suggestion, to: suggestion })}
          >
            Accept Volume {suggestion}
          </button>
        </div>
      ) : null}
      {editable ? (
        <form
          className="mod-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(null);
          }}
        >
          <fieldset className="date-fieldset">
            <legend>Covered Volumes</legend>
            <label>
              First
              <input
                value={from}
                disabled={unmapped}
                onChange={(event) => edit({ from: event.target.value })}
              />
            </label>
            <label>
              Last
              <input
                value={to}
                disabled={unmapped}
                onChange={(event) => edit({ to: event.target.value })}
              />
            </label>
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={unmapped}
              onChange={(event) => edit({ unmapped: event.target.checked })}
            />{" "}
            Unmapped Packaging (no source states which Volumes it collects)
          </label>
          <span className="field-help">
            Volumes of the range the Series lacks are created on approval; never size the range from
            the line's name.
          </span>
          <label>
            Edition Line
            <input value={lineName} onChange={(event) => edit({ lineName: event.target.value })} />
            <span className="field-help">Leave empty for an ordinary book outside any line.</span>
          </label>
          <label>
            Line position
            <input
              value={linePosition}
              onChange={(event) => edit({ linePosition: event.target.value })}
            />
          </label>
          <label>
            Change comment (required)
            <textarea
              value={changeComment}
              onChange={(event) => setChangeComment(event.target.value)}
              rows={2}
            />
          </label>
          <div className="mod-actions">
            <button type="submit" className="btn btn-sm" disabled={busy}>
              {busy ? "Saving…" : "Save placement"}
            </button>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {saved ? <p className="notice">Placement saved to the Draft.</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function OpsList({ ops, art }: { ops: RenderedOps; art: CoverArt }) {
  return (
    <ol className="proposal-ops">
      {ops.map((op, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: each op renders text with no state, so a key by position only re-renders in place
          key={i}
          className="proposal-op"
        >
          {op.kind === "create" ? (
            <>
              <p>
                <strong>{op.summary}</strong> <code className="temp-id">temp:{op.tempId}</code>
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
                {op.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
              </p>
              <ul className="revision-changes">
                {op.changes.map((change) => (
                  <FieldChangeItem key={change.field} change={change} art={art} />
                ))}
              </ul>
              {op.citation !== undefined ? (
                <StatedSource
                  field={editorialField(op.recordType)?.name ?? "text"}
                  citation={op.citation}
                />
              ) : null}
            </>
          ) : op.kind === "clearOverride" ? (
            <>
              <p>
                <strong>
                  Clear the Human Override on {op.fieldLabel} of {op.recordType}: {op.recordTitle}
                </strong>{" "}
                <span className="proposal-base">
                  (base: revision #{op.base.seq}
                  {op.base.comment ? ` — ${op.base.comment}` : ""})
                </span>{" "}
                {op.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
              </p>
              <ul className="revision-changes">
                {op.kept ? (
                  <li>
                    <code>{op.field}</code> keeps its value: {renderFieldValue(op.kept.value)} (
                    {writtenByLabel(op.kept.writtenBy)})
                  </li>
                ) : null}
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
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: known defect, left for its own fix: a row removed above a focused link moves that focus to the next row's link (docs/known-issues.md, Interface)
          key={i}
        >
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
  const run = async (action: () => Promise<unknown>, okMessage: string | null = null) => {
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
  // A placement whose coverage is unstated is refused at submission; say so first.
  const coveragePending = detail.placement?.coverage.kind === "pending";

  return (
    <main className="mod-page mod-proposal-page">
      <Breadcrumbs
        trail={[
          <Link key="queue" to="/mod/queue">
            Review queue
          </Link>,
          "Proposal",
        ]}
      />
      <div className="mod-title-row">
        <h1>Proposal</h1>
        <ProposalStateChip state={detail.state} />
        {detail.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
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
          A record this proposal touches changed since submission. Approval is blocked until the
          author explicitly rebases and resubmits — there is no silent rebase.
        </p>
      ) : null}

      {/* ---- author actions ---- */}
      {detail.viewer.isAuthor && (detail.state === "draft" || detail.state === "inReview") ? (
        <section className="proposal-actions">
          <h2>Your proposal</h2>
          <div className="mod-actions">
            {detail.state === "draft" ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || coveragePending}
                onClick={() => void onSubmitDraft()}
              >
                Submit for review
              </button>
            ) : null}
            <button
              type="button"
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
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => withdrawProposal({ proposalId }), "Withdrawn.")}
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
                type="button"
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
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => claimProposal({ proposalId }), "Claimed.")}
            >
              Claim
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => unclaimProposal({ proposalId }), "Unclaimed.")}
            >
              Unclaim
            </button>
            <button
              type="button"
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
                type="button"
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
              type="button"
              className="btn btn-sm"
              disabled={busy || decisionNote.trim() === ""}
              onClick={() =>
                void run(() => rejectProposal({ proposalId, note: decisionNote }), "Rejected.")
              }
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {info ? <p className="notice">{info}</p> : null}

      {detail.placement ? (
        <PlacementPanel
          placement={detail.placement}
          proposalId={proposalId}
          editable={detail.viewer.isAuthor && detail.state === "draft"}
          comment={detail.draft?.comment ?? ""}
        />
      ) : null}

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
          <OpsList ops={detail.draft.ops} art={detail.coverArt} />
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
          <OpsList ops={version.ops} art={detail.coverArt} />
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
          Data-Team-only. Public record history shows only the final diff, author, approver, and
          change comment.
        </p>
        {detail.notes.length === 0 ? (
          <p className="section-hint">No notes yet.</p>
        ) : (
          <ol>
            {detail.notes.map((note, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: each note is plain text with no state, so a key by position only re-renders in place
                key={i}
              >
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
          type="button"
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
