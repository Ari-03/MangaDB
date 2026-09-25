import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { useIsDataTeam } from "~/lib/moderation";
import { convexClient } from "~/providers";

/**
 * The Data Team imports dashboard (ticket #37, spec §6): every Approved
 * Source with its cadence and health flag — an unhealthy source (three
 * consecutive failed runs) is flagged loudly — plus inspectable Import Run
 * history: source, timing, records seen/changed, and errors. Never indexed.
 */
export const Route = createFileRoute("/mod/imports")({
  head: () => ({
    meta: [
      { title: "Imports — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ImportsPage,
});

function ImportsPage() {
  if (!convexClient) {
    return (
      <main className="mod-page">
        <p className="notice">
          The imports dashboard needs a configured Convex deployment (see the
          README).
        </p>
      </main>
    );
  }
  return <ImportsGate />;
}

function ImportsGate() {
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
          The imports dashboard is visible to Editors, Moderators, and
          Administrators. {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return <Imports />;
}

const timestamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function duration(startedAt: number, finishedAt: number | null): string {
  if (finishedAt === null) return "running";
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Imports() {
  const sources = useQuery(api.imports.dashboard, {});
  const [sourceKey, setSourceKey] = useState("");
  const runs = useQuery(api.imports.recentRuns, {
    sourceKey: sourceKey || undefined,
    limit: 30,
  });

  return (
    <main className="mod-page imports-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">MangaDB</Link> <span aria-hidden="true">/</span>{" "}
        <span>Imports</span>
      </nav>
      <h1>Imports</h1>
      <p className="section-hint">
        Every Approved Source runs unattended on its registry cadence; three
        consecutive failed runs flag it unhealthy here (and email the
        Administrator once per transition).
      </p>
      <nav className="mod-tools" aria-label="Data team tools">
        <Link to="/mod/queue">Review queue</Link>
        <Link to="/mod/launch">Launch</Link>
      </nav>

      <h2>Sources</h2>
      {sources === undefined ? (
        <p className="notice">Loading…</p>
      ) : (
        <ul className="import-sources">
          {sources.map((source) => (
            <li
              key={source.key}
              className={
                source.healthState === "unhealthy"
                  ? "import-source import-source-unhealthy"
                  : "import-source"
              }
            >
              <div className="import-source-head">
                <strong>{source.name}</strong>
                {source.healthState === "unhealthy" ? (
                  <>
                    <span className="chip mod-chip mod-chip--bad">
                      Unhealthy
                    </span>
                    <strong className="import-flag">
                      {source.consecutiveFailures} consecutive failed runs
                    </strong>
                  </>
                ) : (
                  <span className="chip mod-chip mod-chip--ok">Healthy</span>
                )}
                {source.enabled ? null : (
                  <span className="chip mod-chip mod-chip--mute">Disabled</span>
                )}
              </div>
              <div className="import-source-meta">
                <span>
                  <code>{source.key}</code>
                </span>
                <span>{source.cadence}</span>
                <span>
                  {source.lastRun
                    ? `last run ${source.lastRun.status} ${timestamp(source.lastRun.startedAt)} — ${source.lastRun.recordsSeen} seen, ${source.lastRun.recordsChanged} changed${source.lastRun.errorCount > 0 ? `, ${source.lastRun.errorCount} error${source.lastRun.errorCount === 1 ? "" : "s"}` : ""}`
                    : "never run"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Run history</h2>
      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Source
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">all sources</option>
            {(sources ?? []).map((source) => (
              <option key={source.key} value={source.key}>
                {source.key}
              </option>
            ))}
          </select>
        </label>
      </form>
      {runs === undefined ? (
        <p className="notice">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="notice">No runs yet for this selection.</p>
      ) : (
        <ol className="import-runs">
          {runs.map((run) => (
            <li
              key={run._id}
              className={
                run.status === "failed"
                  ? "import-run mod-flagged"
                  : "import-run"
              }
            >
              <div className="import-run-head">
                <strong>{run.sourceKey}</strong>
                <span
                  className={`chip mod-chip mod-chip--${
                    run.status === "failed"
                      ? "bad"
                      : run.status === "running"
                        ? "info"
                        : run.status === "stopped"
                          ? "warn"
                          : "ok"
                  }`}
                >
                  {run.status}
                </span>
                <span>{timestamp(run._creationTime)}</span>
                <span>{duration(run._creationTime, run.finishedAt ?? null)}</span>
                <span>
                  {run.recordsSeen} seen · {run.recordsChanged} changed
                </span>
              </div>
              {run.errors.length > 0 ? (
                <details className="import-run-errors">
                  <summary>
                    {run.errors.length} error{run.errors.length === 1 ? "" : "s"}
                  </summary>
                  <ul>
                    {run.errors.map((error, i) => (
                      <li key={i}>
                        <code>{error}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
