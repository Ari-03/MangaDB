// The Suggestions tab of /me: the viewer's own Proposals, newest first
// (convex/suggestions.ts mine), each with its state, the record it
// changes, what it changes, and the reviewer's reason when one stands. A
// row opens the Suggestion on /me/suggestions/{id}.

import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { ProposalStateChip } from "~/lib/moderation";
import { ChangeSummary, recordLabel } from "~/lib/modShell";

/** A reviewer's standing word on a Suggestion, as its row and page say it. */
export function decisionText(decision: { kind: "reject" | "requestChanges"; text: string }) {
  return decision.kind === "reject"
    ? `Rejected: ${decision.text}`
    : `Changes requested: ${decision.text}`;
}

/** A day in the viewer's locale. */
export const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function LibrarySuggestions() {
  const rows = useQuery(api.suggestions.mine, {});
  if (rows === undefined) return <p className="notice">Loading…</p>;
  if (rows === null || rows.length === 0) {
    return (
      <p className="notice">
        You have not suggested any changes yet. A series, volume or edition page has a "Suggest an
        edit" link for a wrong date, a missing cover or a better description.
      </p>
    );
  }
  return (
    <ul className="worklist suggestion-list">
      {rows.map((row) => (
        <li key={row.proposalId} className="work-row work-row--plain">
          <div className="work-body">
            <div className="work-head">
              <Link className="work-title" to="/me/suggestions/$id" params={{ id: row.proposalId }}>
                {row.subject?.title ?? (row.comment || "Suggestion")}
              </Link>
              <ProposalStateChip state={row.state} />
            </div>
            <ChangeSummary summary={row.summary} />
            {row.decision ? <p className="work-reason">{decisionText(row.decision)}</p> : null}
            <p className="work-meta">
              {row.subject ? <span>{recordLabel(row.subject.recordType)}</span> : null}
              <span>{day(row.updatedAt)}</span>
              {row.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
