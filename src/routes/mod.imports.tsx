import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { mutationErrorMessage } from "~/lib/errors";
import { ModGate, timestamp } from "~/lib/moderation";
import {
  Explainer,
  Jacket,
  ModSubtabs,
  ModWorkroom,
  WorklistSkeleton,
  countLabel,
} from "~/lib/modShell";
import { slugParams } from "~/lib/slug";

/**
 * The Data Team imports dashboard (spec §6), as three panels kept in the
 * URL: Sources, every Approved Source with its health and its schedule as
 * separate facts (an unhealthy source, three consecutive failed runs, is
 * flagged loudly; a paused one is only muted); Held books, what imports
 * could not place (convex/imports.ts heldBooks), each with "Prepare
 * placement" (convex/placement.ts); and Run history, inspectable Import
 * Runs with timing, records seen and changed, and errors. Never indexed.
 */
export const Route = createFileRoute("/mod/imports")({
  head: () => ({ meta: [{ title: "Imports — MangaDB" }] }),
  validateSearch: importsSearch,
  component: ImportsPage,
});

const PANELS = ["sources", "held", "runs"] as const;
type Panel = (typeof PANELS)[number];

type ImportsSearch = {
  panel?: Exclude<Panel, "sources">;
  kind?: HoldKind;
  source?: string;
  runSource?: string;
};

/** The page's panel and filters from its URL; anything unknown is dropped. */
function importsSearch(search: Record<string, unknown>): ImportsSearch {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  return {
    panel: search.panel === "held" || search.panel === "runs" ? search.panel : undefined,
    kind: typeof search.kind === "string" && isHoldKind(search.kind) ? search.kind : undefined,
    source: text(search.source),
    runSource: text(search.runSource),
  };
}

function ImportsPage() {
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

const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

/** A run's outcome, as a chip tone. */
function runTone(status: string): string {
  if (status === "failed") return "bad";
  if (status === "running") return "info";
  if (status === "stopped") return "warn";
  return "ok";
}

type Source = FunctionReturnType<typeof api.imports.dashboardPage>["sources"][number];

function Imports() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/mod/imports" });
  const dashboard = useQuery(api.imports.dashboardPage, {});
  const counts = useQuery(api.workroom.counts, {});
  const sources = dashboard?.sources ?? [];
  const panel: Panel = search.panel ?? "sources";
  const show = (next: ImportsSearch) =>
    void navigate({
      search: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
      replace: true,
    });

  return (
    <ModWorkroom
      current="imports"
      title="Imports"
      className="imports-page"
      hint="Each source runs on its own cadence. Health is about failures; schedule is about whether it runs at all."
    >
      <ModSubtabs
        label="Imports panels"
        value={panel}
        onChange={(next) => show({ ...search, panel: next === "sources" ? undefined : next })}
        panels={[
          { value: "sources", label: "Sources" },
          {
            value: "held",
            label: "Held books",
            count: counts && counts.heldBooks > 0 ? countLabel(counts.heldBooks) : null,
          },
          { value: "runs", label: "Run history" },
        ]}
      />
      {panel === "sources" ? (
        <SourcesPanel
          sources={dashboard === undefined ? undefined : sources}
          hasMore={dashboard?.hasMore ?? false}
        />
      ) : panel === "held" ? (
        <HeldBooks
          sources={sources}
          kind={search.kind}
          sourceKey={search.source}
          onFilter={(kind, source) => show({ ...search, kind, source })}
        />
      ) : (
        <RunHistory
          sources={sources}
          sourceKey={search.runSource}
          onFilter={(runSource) => show({ ...search, runSource })}
        />
      )}
    </ModWorkroom>
  );
}

/**
 * The sources ledger: health and schedule in their own columns, so a
 * paused healthy source reads calm and an unhealthy one reads red whether
 * or not it runs. Unhealthy sources come first (imports.dashboardPage).
 */
function SourcesPanel({ sources, hasMore }: { sources: Source[] | undefined; hasMore: boolean }) {
  return (
    <section className="mod-section" aria-labelledby="sources-title">
      <h2 id="sources-title" className="visually-hidden">
        Sources
      </h2>
      <Explainer>
        <p>
          Every Approved Source runs unattended on its registry cadence. Three consecutive failed
          runs flag it unhealthy here and email the Administrator once per transition; one success
          clears it. A paused source keeps its health; it simply does not run. Pausing is an
          Administrator action from the CLI (<code>importSources.upsert</code>).
        </p>
      </Explainer>
      {sources === undefined ? (
        <WorklistSkeleton />
      ) : (
        <ol className="sources">
          <li className="source-row is-head" aria-hidden="true">
            <span>Source</span>
            <span>Health</span>
            <span>Schedule</span>
            <span>Last run</span>
          </li>
          {sources.map((source) => (
            <li
              key={source.key}
              className={
                source.healthState === "unhealthy" ? "source-row is-unhealthy" : "source-row"
              }
            >
              <div className="source-name">
                <strong>{source.name}</strong>
                <code>{source.key}</code>
              </div>
              <div className="source-cell">
                <span className="source-col">Health</span>
                {source.healthState === "unhealthy" ? (
                  <>
                    <span className="chip mod-chip mod-chip--bad">Unhealthy</span>
                    <strong className="import-flag">
                      {plural(source.consecutiveFailures, "failed run")}
                    </strong>
                  </>
                ) : (
                  <span className="chip mod-chip mod-chip--ok">Healthy</span>
                )}
              </div>
              <div className="source-cell">
                <span className="source-col">Schedule</span>
                {source.enabled ? (
                  <span>Runs {source.cadence}</span>
                ) : (
                  <span className="chip mod-chip mod-chip--mute">Paused</span>
                )}
              </div>
              <div className="source-cell">
                <span className="source-col">Last run</span>
                {source.lastRun ? (
                  <>
                    <span className={`chip mod-chip mod-chip--${runTone(source.lastRun.status)}`}>
                      {source.lastRun.status}
                    </span>
                    <time dateTime={new Date(source.lastRun.startedAt).toISOString()}>
                      {timestamp(source.lastRun.startedAt)}
                    </time>
                    <span className="n">
                      {source.lastRun.recordsSeen.toLocaleString()} seen ·{" "}
                      {source.lastRun.recordsChanged.toLocaleString()} changed
                      {source.lastRun.errorCount > 0
                        ? ` · ${plural(source.lastRun.errorCount, "error")}`
                        : ""}
                    </span>
                  </>
                ) : (
                  <span className="n">Never run</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasMore ? (
        <p className="section-hint">
          The registry holds more sources than this list shows; the rest are left out.
        </p>
      ) : null}
    </section>
  );
}

/** The last Import Runs, newest first, of every source or one. */
function RunHistory({
  sources,
  sourceKey,
  onFilter,
}: {
  sources: Source[];
  sourceKey: string | undefined;
  onFilter: (sourceKey: string | undefined) => void;
}) {
  const runs = useQuery(api.imports.recentRuns, { sourceKey, limit: 30 });
  const sourceName = (key: string) => sources.find((source) => source.key === key)?.name ?? key;
  return (
    <section className="mod-section" aria-labelledby="runs-title">
      <h2 id="runs-title" className="visually-hidden">
        Run history
      </h2>
      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Source
          <select value={sourceKey ?? ""} onChange={(e) => onFilter(e.target.value || undefined)}>
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
      </form>
      {runs === undefined ? (
        <WorklistSkeleton />
      ) : runs.length === 0 ? (
        <p className="notice">No runs yet for this selection.</p>
      ) : (
        <ol className="import-runs">
          {runs.map((run) => (
            <li
              key={run._id}
              className={run.status === "failed" ? "import-run mod-flagged" : "import-run"}
            >
              <div className="import-run-head">
                <strong>{sourceName(run.sourceKey)}</strong>
                <span className={`chip mod-chip mod-chip--${runTone(run.status)}`}>
                  {run.status}
                </span>
                <span>{timestamp(run._creationTime)}</span>
                <span>{duration(run._creationTime, run.finishedAt ?? null)}</span>
                <span>
                  {run.recordsSeen.toLocaleString()} seen · {run.recordsChanged.toLocaleString()}{" "}
                  changed
                </span>
              </div>
              {run.errors.length > 0 ? (
                <details className="import-run-errors">
                  <summary>{plural(run.errors.length, "error")}</summary>
                  <ul>
                    {run.errors.map((error, i) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: each error is a plain string, so a key by position only re-renders in place
                        key={i}
                      >
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
    </section>
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

type HeldBook = FunctionReturnType<typeof api.imports.heldBooks>["page"][number];

/**
 * A held book's placement: a link to its open placement Proposal, marked
 * Draft or awaiting review, and "Prepare placement" unless that Proposal is
 * in review or the viewer's own Draft. Preparing opens the Draft it writes
 * (withdrawing another member's unsubmitted Draft) or says why the book
 * cannot be prepared.
 */
function Placement({ book }: { book: HeldBook }) {
  const prepare = useMutation(api.placement.preparePlacement);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const open = book.proposal;
  const marked =
    open === null ? null : (
      <>
        <span className="chip mod-chip mod-chip--info">
          {open.state === "draft" ? "Placement Draft" : "Placement awaiting review"}
        </span>
        <Link to="/mod/proposal/$id" params={{ id: open.id }}>
          Open the Proposal
        </Link>
      </>
    );
  if (open !== null && (open.state === "inReview" || open.mine)) {
    return <div className="mod-actions">{marked}</div>;
  }
  const onPrepare = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await prepare({ observationId: book.observationId });
      if (result.status === "unavailable") setRefusal(result.reason);
      else await navigate({ to: "/mod/proposal/$id", params: { id: result.proposalId } });
    } catch (err) {
      setRefusal(mutationErrorMessage(err, "Preparing the placement failed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mod-actions">
      {marked}
      <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void onPrepare()}>
        {busy ? "Preparing…" : "Prepare placement"}
      </button>
      {refusal !== null ? <p className="form-error">Cannot prepare: {refusal}</p> : null}
    </div>
  );
}

/**
 * Held Books (CONTEXT.md), most recently held first: what an import
 * observed but could not place, with the source's own facts, the reason,
 * and its placement (Placement). Filters by kind and source (kept in the
 * URL); pages through the list on demand.
 */
function HeldBooks({
  sources,
  kind,
  sourceKey,
  onFilter,
}: {
  sources: Source[];
  kind: HoldKind | undefined;
  sourceKey: string | undefined;
  onFilter: (kind: HoldKind | undefined, sourceKey: string | undefined) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.imports.heldBooks,
    { kind, sourceKey },
    { initialNumItems: HELD_PAGE },
  );
  const sourceName = (key: string) => sources.find((source) => source.key === key)?.name ?? key;

  return (
    <section className="mod-section" aria-labelledby="held-title">
      <h2 id="held-title" className="visually-hidden">
        Held books
      </h2>
      <p className="section-hint">
        Books a source lists that an import could not place. Prepare placement drafts the proposal
        that places one.
      </p>
      <Explainer>
        <p>
          A book is held when the Volume it names is missing, its packaging cannot be mapped, no
          single Series fits, or its ISBN or slot is taken. It leaves this list once it is linked,
          an import queues a creation Proposal for it, or its source stops listing it.
        </p>
        <p>
          Prepare placement drafts a Proposal of your own that creates what a missing-Volume or
          packaging book needs under its Series; the book stays here, marked, until that Proposal is
          approved. Preparing a book another member has an unsubmitted Draft for withdraws their
          Draft.
        </p>
      </Explainer>
      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Kind
          <select
            value={kind ?? ""}
            onChange={(e) =>
              onFilter(isHoldKind(e.target.value) ? e.target.value : undefined, sourceKey)
            }
          >
            <option value="">All kinds</option>
            {Object.entries(HOLD_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            value={sourceKey ?? ""}
            onChange={(e) => onFilter(kind, e.target.value || undefined)}
          >
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
      </form>
      {status === "LoadingFirstPage" ? (
        <WorklistSkeleton />
      ) : results.length === 0 ? (
        <p className="notice">No held books for this selection.</p>
      ) : (
        <ol className="worklist">
          {results.map((row) => {
            const title = row.title ?? row.sourceRecordId ?? "Untitled book";
            return (
              <li key={row.holdId} className="work-row">
                <Jacket title={title} isbn13={row.isbn13} mature={row.mature} />
                <div className="work-body">
                  <div className="work-head">
                    <strong className="work-title">{title}</strong>
                    <span className="work-chips">
                      <span className="chip mod-chip mod-chip--warn">{HOLD_KINDS[row.kind]}</span>
                      <span className="chip mod-chip">{sourceName(row.sourceKey)}</span>
                    </span>
                  </div>
                  <p className="work-change">
                    {row.seriesTitle !== null || row.volumeLabel !== null ? (
                      <span>
                        proposes {row.seriesTitle ?? "a Series"}
                        {row.volumeLabel !== null ? `, vol. ${row.volumeLabel}` : ""}
                        {row.series !== null ? (
                          <>
                            {" → "}
                            <Link
                              to="/series/$publicId/$slug"
                              params={slugParams(row.series.publicId, row.series.title)}
                            >
                              {row.series.title}
                            </Link>
                          </>
                        ) : null}
                      </span>
                    ) : row.series !== null ? (
                      <Link
                        to="/series/$publicId/$slug"
                        params={slugParams(row.series.publicId, row.series.title)}
                      >
                        {row.series.title}
                      </Link>
                    ) : null}
                    {row.isbn13 !== null ? <span>ISBN {row.isbn13}</span> : null}
                    {row.url !== null ? (
                      <a href={row.url} target="_blank" rel="noreferrer">
                        Source record
                      </a>
                    ) : null}
                  </p>
                  {row.reason !== null ? <p className="work-reason">{row.reason}</p> : null}
                  <div className="work-meta">
                    <span>held {timestamp(row.heldAt)}</span>
                    {row.lastSeenAt !== null ? (
                      <span>last listed {timestamp(row.lastSeenAt)}</span>
                    ) : null}
                  </div>
                  <Placement book={row} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="panel-foot">
          <button
            className="btn btn-sm import-holds-more"
            type="button"
            disabled={status === "LoadingMore"}
            onClick={() => loadMore(HELD_PAGE)}
          >
            {status === "LoadingMore" ? "Loading…" : "Load more"}
          </button>
          <span>{HELD_PAGE} per page, most recently held first.</span>
        </div>
      ) : null}
    </section>
  );
}
