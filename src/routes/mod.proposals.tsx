import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { ProposalStateChip, useIsDataTeam } from "~/lib/moderation";
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

function MyProposalsPage() {
  if (!convexClient) {
    return (
      <main className="mod-page">
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
      <main className="mod-page">
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isDataTeam) {
    return (
      <main className="mod-page">
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
    <main className="mod-page mod-queue-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>My proposals</span>
      </nav>
      <h1>My proposals</h1>
      <p className="section-hint">
        Drafts to return to, submissions waiting on a Moderator, and
        decisions — newest first.
      </p>
      <nav className="mod-tools" aria-label="Data team tools">
        <Link to="/mod/queue">Shared review queue</Link>
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
