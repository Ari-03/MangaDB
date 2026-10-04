import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { CommentsQueueLink, ModGate, ProposalStateChip } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";

/**
 * The viewer's own proposals: drafts to return to, In-Review
 * submissions to watch, and decisions. Data-Team-only; never indexed.
 */
export const Route = createFileRoute("/mod/proposals")({
  head: () => ({ meta: [{ title: "My proposals — MangaDB" }] }),
  component: MyProposalsPage,
});

function MyProposalsPage() {
  return (
    <ModGate
      role="dataTeam"
      refusal="Proposals are authored by Editors, Moderators, and Administrators."
    >
      <MyProposals />
    </ModGate>
  );
}

function MyProposals() {
  const rows = useQuery(api.proposals.myProposals, {});
  return (
    <main className="mod-page mod-queue-page">
      <Breadcrumbs trail={["My proposals"]} />
      <h1>My proposals</h1>
      <p className="section-hint">
        Drafts to return to, submissions waiting on a Moderator, and
        decisions — newest first.
      </p>
      <nav className="mod-tools" aria-label="Data team tools">
        <Link to="/mod/queue">Shared review queue</Link>
        <CommentsQueueLink />
      </nav>
      {rows === undefined ? (
        <p className="notice">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="notice">
          You have no proposals yet. Find a record and use its "Propose a
          change" link.
        </p>
      ) : (
        <ol className="queue-list">
          {rows.map((row) => (
            <li
              key={row.proposalId}
              className={row.stale ? "queue-row mod-flagged" : "queue-row"}
            >
              <Link to="/mod/proposal/$id" params={{ id: row.proposalId }}>
                {row.comment || "(no comment yet)"}
              </Link>
              <div className="queue-row-meta">
                <ProposalStateChip state={row.state} />
                <span>
                  {row.opCount} op{row.opCount === 1 ? "" : "s"}
                </span>
                <span>{row.recordTypes.join(", ") || "no records yet"}</span>
                {row.stale ? (
                  <span className="chip mod-chip mod-chip--bad">stale</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
