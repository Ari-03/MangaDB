import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { mutationErrorMessage } from "~/lib/errors";
import { ProposalStateChip } from "~/lib/moderation";
import { Breadcrumbs, RecordPageLink } from "~/lib/pageScaffold";
import { ProposalWarnings, unacknowledgedWarnings } from "~/lib/proposalDraft";
import { VersionChanges } from "~/lib/proposalView";
import { day, decisionText } from "~/lib/suggestions";

/**
 * One of the viewer's own Suggestions (convex/suggestions.ts detail): its
 * state, the record it changes, the reviewer's reason when one stands,
 * the Draft and its newest submitted versions with before and after (only
 * the new values of a record no longer public; older versions without
 * their changes), and the author's actions.
 * A Draft, including one sent back for changes, can be edited on
 * /suggest, submitted, or withdrawn; one In Review withdrawn. Either is
 * rebased when a record it changes has moved (`stale`, from its working
 * ops), the way back for a Draft /suggest cannot open. Under the /me gate;
 * another person's Proposal reads as not found. Never indexed (the /me
 * layout).
 */
export const Route = createFileRoute("/me/suggestions/$id")({
  head: () => ({ meta: [{ title: "Your suggestion — MangaDB" }] }),
  component: SuggestionPage,
});

function SuggestionPage() {
  const { id } = Route.useParams();
  const detail = useQuery(api.suggestions.detail, { proposalId: id });
  const submitProposal = useMutation(api.proposals.submitProposal);
  const withdrawProposal = useMutation(api.proposals.withdrawProposal);
  const rebaseProposal = useMutation(api.proposals.rebaseProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const crumbs = [
    <Link key="library" to="/me" search={{ tab: "suggestions" }}>
      Suggestions
    </Link>,
    "Suggestion",
  ];
  if (detail === undefined) {
    return (
      <main className="mod-page suggest-page">
        <Breadcrumbs trail={crumbs} />
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="mod-page suggest-page">
        <Breadcrumbs trail={crumbs} />
        <h1>Suggestion not found</h1>
        <p className="notice">
          None of your suggestions lives at this address.{" "}
          <Link to="/me" search={{ tab: "suggestions" }}>
            See your suggestions
          </Link>
          .
        </p>
      </main>
    );
  }

  const proposalId = detail.proposalId;
  // Runs an author action; it answers with what to tell the reader.
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await action());
    } catch (err) {
      const warnings = unacknowledgedWarnings(err);
      if (warnings) setPendingWarnings(warnings);
      else setError(mutationErrorMessage(err, "That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const submit = (acknowledgeWarnings?: string[]) =>
    run(async () => {
      await submitProposal({ proposalId, acknowledgeWarnings });
      setPendingWarnings(null);
      return "Submitted for review.";
    });

  const open = detail.state === "draft" || detail.state === "inReview";
  const subject = detail.subject;
  return (
    <main className="mod-page suggest-page">
      <Breadcrumbs trail={crumbs} />
      <div className="mod-title-row">
        <h1>{subject?.title ?? "Suggestion"}</h1>
        <ProposalStateChip state={detail.state} />
        {detail.stale && open ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
      </div>
      <p className="section-hint">
        {subject?.page ? (
          <>
            A suggested change to{" "}
            <RecordPageLink page={subject.page} title={subject.title}>
              this {subject.recordType === "releaseBundle" ? "box set" : subject.recordType}
            </RecordPageLink>
            .{" "}
          </>
        ) : null}
        {detail.submittedAt ? `Submitted ${day(detail.submittedAt)}. ` : "Not submitted yet. "}
        {detail.decidedAt && !open ? `Closed ${day(detail.decidedAt)}.` : null}
      </p>

      {detail.decision ? (
        <p className="notice suggestion-decision" role="status">
          {decisionText(detail.decision)}
        </p>
      ) : null}
      {detail.stale && open ? (
        <p className="notice">
          The record changed since this was saved. Rebase it onto the current record, check it, and
          submit it again.
        </p>
      ) : null}

      {open ? (
        <section className="proposal-actions suggestion-actions">
          <div className="mod-actions">
            {detail.state === "draft" && detail.target ? (
              <Link
                className="btn btn-primary"
                to="/suggest/$type/$key"
                params={detail.target}
                search={{ draft: proposalId }}
              >
                Edit
              </Link>
            ) : null}
            {detail.state === "draft" ? (
              <button
                type="button"
                className="btn"
                disabled={busy || detail.stale}
                onClick={() => void submit()}
              >
                Submit for review
              </button>
            ) : null}
            {detail.stale ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { dropped } = await rebaseProposal({ proposalId });
                    const lost = dropped.length > 0 ? ` Dropped: ${dropped.join("; ")}.` : "";
                    return `Rebased onto the current record.${lost} Check it, then submit it again.`;
                  })
                }
              >
                Rebase
              </button>
            ) : null}
            {confirmWithdraw ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await withdrawProposal({ proposalId });
                      setConfirmWithdraw(false);
                      return "Withdrawn. Nothing changed.";
                    })
                  }
                >
                  Yes, withdraw it
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirmWithdraw(false)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmWithdraw(true)}
              >
                Withdraw…
              </button>
            )}
          </div>
          {pendingWarnings ? (
            <ProposalWarnings
              warnings={pendingWarnings}
              busy={busy}
              onAcknowledge={(warnings) => void submit(warnings)}
            />
          ) : null}
        </section>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {info ? <p className="notice">{info}</p> : null}

      {detail.draft ? (
        <section className="proposal-version">
          <h2>Draft</h2>
          <p className="revision-comment">{detail.draft.comment || "(no comment yet)"}</p>
          <VersionChanges
            content={detail.draft.content}
            opCount={detail.draft.opCount}
            art={detail.coverArt}
          />
        </section>
      ) : null}

      {[...detail.versions].reverse().map((version) => (
        <section key={version.versionNo} className="proposal-version">
          <h2>
            Version {version.versionNo}
            {version.current && detail.state !== "draft" ? " (reviewed version)" : ""}
          </h2>
          <p className="section-hint">Submitted {day(version.submittedAt)}.</p>
          <p className="revision-comment">{version.changeComment}</p>
          <VersionChanges
            content={version.content}
            opCount={version.opCount}
            art={detail.coverArt}
          />
          {detail.decisions
            .filter((decision) => decision.versionNo === version.versionNo)
            .map((decision) => (
              <p key={decision.at} className="notice suggestion-decision">
                {decisionText(decision)}
              </p>
            ))}
        </section>
      ))}
    </main>
  );
}
