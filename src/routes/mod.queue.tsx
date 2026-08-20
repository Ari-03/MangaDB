import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { PROPOSAL_WARNINGS } from "../../convex/proposals";
import { useIsDataTeam } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The shared review queue (ticket #32, spec §5): every In-Review Proposal,
 * oldest first, Data-Team-visible only. Filterable by operation, record
 * type, author/source, age, warnings, and staleness; claims are shown so
 * reviewers coordinate without exclusive authority. Never indexed.
 */
export const Route = createFileRoute("/mod/queue")({
  head: () => ({
    meta: [
      { title: "Review queue — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: QueuePage,
});

const RECORD_TYPES = [
  "publisher",
  "seriesFamily",
  "series",
  "volume",
  "editionLine",
  "edition",
  "release",
  "releaseVariant",
  "releaseBundle",
] as const;

function QueuePage() {
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          The review queue needs a configured Convex deployment (see the
          README).
        </p>
      </main>
    );
  }
  return <QueueGate />;
}

function QueueGate() {
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
          The review queue is visible to Editors, Moderators, and
          Administrators. {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <Queue />;
}

function formatAge(ageMs: number): string {
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Queue() {
  const [operation, setOperation] = useState("");
  const [recordType, setRecordType] = useState("");
  const [authorKind, setAuthorKind] = useState("");
  const [author, setAuthor] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [minAgeHours, setMinAgeHours] = useState("");

  const rows = useQuery(api.proposals.reviewQueue, {
    operation: operation || undefined,
    recordType: recordType || undefined,
    authorKind:
      authorKind === "imports" || authorKind === "humans"
        ? authorKind
        : undefined,
    author: author.trim() || undefined,
    staleOnly: staleOnly || undefined,
    warningsOnly: warningsOnly || undefined,
    minAgeHours:
      minAgeHours.trim() !== "" && Number.isFinite(Number(minAgeHours))
        ? Number(minAgeHours)
        : undefined,
  });

  return (
    <main className="mod-queue-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Review queue</span>
      </nav>
      <h1>Review queue</h1>
      <p className="section-hint">
        In-Review proposals, oldest first. Claiming signals who is looking; it
        never locks — any Moderator can decide.{" "}
        <Link to="/mod/proposals">My proposals</Link> ·{" "}
        <Link to="/mod/imports">Imports</Link>
      </p>

      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Operation
          <select value={operation} onChange={(e) => setOperation(e.target.value)}>
            <option value="">any</option>
            <option value="create">create</option>
            <option value="update">update</option>
          </select>
        </label>
        <label>
          Record type
          <select value={recordType} onChange={(e) => setRecordType(e.target.value)}>
            <option value="">any</option>
            {RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Author kind
          <select value={authorKind} onChange={(e) => setAuthorKind(e.target.value)}>
            <option value="">any</option>
            <option value="humans">humans</option>
            <option value="imports">imports</option>
          </select>
        </label>
        <label>
          Author / source
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="username or source key"
          />
        </label>
        <label>
          Min age (hours)
          <input
            inputMode="numeric"
            value={minAgeHours}
            onChange={(e) => setMinAgeHours(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />{" "}
          Stale only
        </label>
        <label>
          <input
            type="checkbox"
            checked={warningsOnly}
            onChange={(e) => setWarningsOnly(e.target.checked)}
          />{" "}
          With warnings only
        </label>
      </form>

      {rows === undefined ? (
        <p className="notice">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="notice">Nothing in review matches these filters.</p>
      ) : (
        <ol className="queue-list">
          {rows.map((row) => (
            <li key={row.proposalId} className="queue-row">
              <Link to="/mod/proposal/$id" params={{ id: row.proposalId }}>
                {row.comment || "(no comment)"}
              </Link>
              <div className="queue-row-meta">
                <span>
                  {row.author.kind === "user"
                    ? `@${row.author.username ?? "deleted"}${row.author.role ? ` (${row.author.role})` : ""}`
                    : `import: ${row.author.sourceKey}`}
                </span>
                <span>
                  v{row.versionNo} · {row.opCount} op{row.opCount === 1 ? "" : "s"} (
                  {row.opKinds.join(", ")}) · {row.recordTypes.join(", ")}
                </span>
                <span>waiting {formatAge(row.ageMs)}</span>
                {row.stale ? <strong className="queue-stale">stale</strong> : null}
                {row.warnings.length > 0 ? (
                  <span className="queue-warnings">
                    warnings:{" "}
                    {row.warnings
                      .map(
                        (warning) =>
                          PROPOSAL_WARNINGS[
                            warning as keyof typeof PROPOSAL_WARNINGS
                          ] ?? warning,
                      )
                      .join("; ")}
                  </span>
                ) : null}
                {row.claimedBy ? <span>claimed by @{row.claimedBy}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
