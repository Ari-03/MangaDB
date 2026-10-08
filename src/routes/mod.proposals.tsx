import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { ModGate, ProposalStateChip, timestamp } from "~/lib/moderation";
import { ChangeSummary, ModWorkroom, WorklistSkeleton, recordLabel } from "~/lib/modShell";

/**
 * The viewer's own proposals: drafts to return to, In-Review
 * submissions to watch, and decisions. Data-Team-only; never indexed.
 * A row is titled by its change comment (the list reads no records) and
 * says what changes as the review queue does.
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
    <ModWorkroom
      current="proposals"
      title="My proposals"
      className="mod-queue-page"
      hint="Drafts to return to, submissions waiting on a Moderator, and decisions, newest first."
    >
      {rows === undefined ? (
        <WorklistSkeleton />
      ) : rows.length === 0 ? (
        <p className="notice">
          You have no proposals yet. Find a record and use its "Propose a change" link.
        </p>
      ) : (
        <ol className="worklist">
          {rows.map((row) => (
            <li
              key={row.proposalId}
              className={
                row.stale ? "work-row work-row--plain mod-flagged" : "work-row work-row--plain"
              }
            >
              <div className="work-body">
                <div className="work-head">
                  <Link
                    className="work-title"
                    to="/mod/proposal/$id"
                    params={{ id: row.proposalId }}
                  >
                    {row.comment || "(no comment yet)"}
                  </Link>
                </div>
                <ChangeSummary summary={row.summary} />
                <div className="work-meta">
                  <span>{row.recordTypes.map(recordLabel).join(", ") || "no records yet"}</span>
                  <span>
                    {row.opCount} change{row.opCount === 1 ? "" : "s"}
                  </span>
                  <time dateTime={new Date(row.updatedAt).toISOString()}>
                    {timestamp(row.updatedAt)}
                  </time>
                  <span className="work-chips">
                    <ProposalStateChip state={row.state} />
                    {row.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </ModWorkroom>
  );
}
