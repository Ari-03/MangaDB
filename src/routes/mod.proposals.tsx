import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { useIsDataTeam } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The viewer's own proposals (ticket #32): drafts to return to, In-Review
 * submissions to watch, and decisions. Data-Team-only; never indexed.
 */
export const Route = createFileRoute("/mod/proposals")({
  head: () => ({
    meta: [
      { title: "My proposals — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MyProposalsPage,
});

const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  inReview: "In Review",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

function MyProposalsPage() {
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Proposals need a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  return <Gate />;
}

function Gate() {
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
          Proposals are authored by Editors, Moderators, and Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <MyProposals />;
}

function MyProposals() {
  const rows = useQuery(api.proposals.myProposals, {});
  return (
    <main className="mod-queue-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>My proposals</span>
      </nav>
      <h1>My proposals</h1>
      <p className="section-hint">
        Newest first. <Link to="/mod/queue">Shared review queue</Link>
      </p>
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
            <li key={row.proposalId} className="queue-row">
              <Link to="/mod/proposal/$id" params={{ id: row.proposalId }}>
                {row.comment || "(no comment yet)"}
              </Link>
              <div className="queue-row-meta">
                <span>{STATE_LABELS[row.state] ?? row.state}</span>
                {row.stale ? <strong className="queue-stale">stale</strong> : null}
                <span>
                  {row.opCount} op{row.opCount === 1 ? "" : "s"} ·{" "}
                  {row.recordTypes.join(", ") || "—"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
