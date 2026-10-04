import { createFileRoute, Link } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { ModGate, ModTools, timestamp } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { slugParams } from "~/lib/slug";
import { convexClient } from "~/providers";

/**
 * The Data Team imports dashboard (spec §6): every Approved
 * Source with its cadence and health flag — an unhealthy source (three
 * consecutive failed runs) is flagged loudly — plus inspectable Import Run
 * history: source, timing, records seen/changed, and errors, and the Held
 * Books imports could not place (convex/imports.ts heldBooks). Never
 * indexed.
 */
export const Route = createFileRoute("/mod/imports")({
  head: () => ({ meta: [{ title: "Imports — MangaDB" }] }),
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
  return (
    <ModGate
      role="dataTeam"
      refusal="The imports dashboard is visible to Editors, Moderators, and Administrators."
    >
      <Imports />
    </ModGate>
  );
}

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
      <Breadcrumbs trail={["Imports"]} />
      <h1>Imports</h1>
      <p className="section-hint">
        Every Approved Source runs unattended on its registry cadence; three
        consecutive failed runs flag it unhealthy here (and email the
        Administrator once per transition).
      </p>
      <ModTools current="/mod/imports" />

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

      <HeldBooks sources={sources ?? []} />

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

type HoldKind = NonNullable<FunctionArgs<typeof api.imports.heldBooks>["kind"]>;

const HOLD_KINDS = {
  volumeMissing: "Volume missing",
  packaging: "Packaging",
  series: "No single Series",
  isbn: "ISBN or slot taken",
  other: "Other",
} satisfies Record<HoldKind, string>;

function isHoldKind(value: string): value is HoldKind {
  return value in HOLD_KINDS;
}

const HELD_PAGE = 25;

/**
 * Held Books (CONTEXT.md), most recently held first: what an import
 * observed but could not place, with the source's own facts and the reason.
 * Filters by kind and source; pages through the list on demand.
 */
function HeldBooks({ sources }: { sources: Array<{ key: string; name: string }> }) {
  const [kind, setKind] = useState<HoldKind | "">("");
  const [sourceKey, setSourceKey] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.imports.heldBooks,
    {
      ...(kind !== "" ? { kind } : {}),
      ...(sourceKey !== "" ? { sourceKey } : {}),
    },
    { initialNumItems: HELD_PAGE },
  );
  const sourceName = (key: string) => sources.find((source) => source.key === key)?.name ?? key;

  return (
    <section>
      <h2>Held books</h2>
      <p className="section-hint">
        Books a source lists that its import could not place: the Volume they name is missing,
        their packaging cannot be mapped, no single Series fits, or their ISBN or slot is taken.
        A book leaves this list once it is linked, a creation Proposal is queued for it, or its
        source stops listing it.
      </p>
      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(isHoldKind(e.target.value) ? e.target.value : "")}
          >
            <option value="">all kinds</option>
            {Object.entries(HOLD_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">all sources</option>
            {sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.key}
              </option>
            ))}
          </select>
        </label>
      </form>
      {status === "LoadingFirstPage" ? (
        <p className="notice">Loading…</p>
      ) : results.length === 0 ? (
        <p className="notice">No held books for this selection.</p>
      ) : (
        <ol className="import-runs">
          {results.map((row) => (
            <li key={row.holdId} className="import-run">
              <div className="import-run-head">
                <strong>{row.title ?? row.sourceRecordId}</strong>
                <span className="chip mod-chip mod-chip--warn">{HOLD_KINDS[row.kind]}</span>
                <span>{sourceName(row.sourceKey)}</span>
                <span>held {timestamp(row.heldAt)}</span>
                {row.lastSeenAt !== null ? <span>last listed {timestamp(row.lastSeenAt)}</span> : null}
              </div>
              <div className="import-source-meta">
                {row.isbn13 !== null ? <span>ISBN {row.isbn13}</span> : null}
                {row.seriesTitle !== null || row.volumeLabel !== null ? (
                  <span>
                    proposes {row.seriesTitle ?? "a Series"}
                    {row.volumeLabel !== null ? `, vol. ${row.volumeLabel}` : ""}
                  </span>
                ) : null}
                {row.series !== null ? (
                  <Link to="/series/$publicId/$slug" params={slugParams(row.series.publicId, row.series.title)}>
                    {row.series.title}
                  </Link>
                ) : null}
                {row.url !== null ? (
                  <a href={row.url} target="_blank" rel="noreferrer">
                    Source record
                  </a>
                ) : null}
              </div>
              {row.reason !== null ? <p className="import-hold-reason">{row.reason}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <button
          className="btn btn-sm import-holds-more"
          type="button"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(HELD_PAGE)}
        >
          {status === "LoadingMore" ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
