import { createFileRoute, Link } from "@tanstack/react-router";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { useIsModerator } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * Role governance (ticket #31, spec §4/§5): the data-team roster, the
 * appoint/revoke/suspend/reinstate actions, and the permanent audit trail.
 * Administrators appoint Moderators; Moderators appoint Editors; every
 * change lands in the append-only roleAudit table. The initial Administrator
 * is appointed by the operator (see the README). Never indexed.
 */
export const Route = createFileRoute("/mod/roles")({
  head: () => ({
    meta: [
      { title: "Roles — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ModRolesPage,
});

function ModRolesPage() {
  if (!convexClient) {
    return (
      <main>
        <p className="notice">
          Moderation needs a configured Convex deployment (see the README).
        </p>
      </main>
    );
  }
  return <ModRolesGate />;
}

function ModRolesGate() {
  const isModerator = useIsModerator();
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) {
    return (
      <main>
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!isModerator) {
    return (
      <main>
        <h1>Moderators only</h1>
        <p className="notice">
          Role governance is for Moderators and Administrators.{" "}
          {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <ModRolesContent />;
}

const ROLE_LABELS = {
  editor: "Editor",
  moderator: "Moderator",
  administrator: "Administrator",
} as const;

const ACTION_LABELS = {
  appointed: "appointed",
  revoked: "revoked",
  suspended: "suspended",
  reinstated: "reinstated",
} as const;

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === "object" && err.data !== null) {
    return String((err.data as { message?: string }).message ?? "Action failed.");
  }
  return "Action failed.";
}

function ModRolesContent() {
  const roster = useQuery(api.roles.roster, {});
  const auditLog = useQuery(api.roles.auditLog, {});
  const appoint = useMutation(api.roles.appoint);
  const revoke = useMutation(api.roles.revoke);
  const suspend = useMutation(api.roles.suspend);
  const reinstate = useMutation(api.roles.reinstate);

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "moderator" | "administrator">("editor");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Roles</span>
      </nav>
      <h1>Data-team roles</h1>
      <p className="section-hint">
        Administrators appoint Moderators; Moderators appoint Editors. Every
        change is audited permanently, and revoking a role never rewrites past
        attribution.
      </p>

      <section className="me-section">
        <h2>Appoint</h2>
        <form
          className="username-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await appoint({
                username,
                role,
                reason: reason.trim() === "" ? undefined : reason.trim(),
              });
              setUsername("");
              setReason("");
            });
          }}
        >
          <label>
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as typeof role)
              }
            >
              <option value="editor">Editor</option>
              <option value="moderator">Moderator</option>
              <option value="administrator">Administrator</option>
            </select>
          </label>
          <label>
            Reason (optional)
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div>
            <button type="submit" disabled={busy}>
              Appoint
            </button>
          </div>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
      </section>

      <section className="me-section">
        <h2>Roster</h2>
        {roster === undefined ? (
          <p className="placeholder">Loading…</p>
        ) : roster.length === 0 ? (
          <p className="placeholder">Nobody holds a role yet.</p>
        ) : (
          <ul className="roster-list">
            {roster.map((member) => (
              <li key={member.username} className="roster-row">
                <span>
                  @{member.username} — {ROLE_LABELS[member.role]}
                  {member.suspended ? " (suspended)" : ""}
                </span>{" "}
                <span className="roster-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => revoke({ username: member.username }))
                    }
                  >
                    Revoke
                  </button>{" "}
                  {member.suspended ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() => reinstate({ username: member.username }))
                      }
                    >
                      Reinstate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const why = window.prompt(
                          `Reason for suspending @${member.username}?`,
                        );
                        if (why === null || why.trim() === "") return;
                        void run(() =>
                          suspend({ username: member.username, reason: why.trim() }),
                        );
                      }}
                    >
                      Suspend
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="me-section">
        <h2>Audit trail</h2>
        <p className="section-hint">
          Append-only; entries survive even account deletion.
        </p>
        {auditLog === undefined ? (
          <p className="placeholder">Loading…</p>
        ) : auditLog.length === 0 ? (
          <p className="placeholder">No role changes recorded yet.</p>
        ) : (
          <ul className="audit-list">
            {auditLog.map((entry, i) => (
              <li key={i}>
                <time dateTime={new Date(entry.at).toISOString()}>
                  {new Date(entry.at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </time>{" "}
                — {entry.username ? `@${entry.username}` : "(deleted account)"}{" "}
                {ACTION_LABELS[entry.action]} as {ROLE_LABELS[entry.role]} by{" "}
                {entry.actor.kind === "system"
                  ? "the system (operator bootstrap)"
                  : entry.actor.username
                    ? `@${entry.actor.username}`
                    : "(deleted account)"}
                {entry.reason ? ` — ${entry.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
