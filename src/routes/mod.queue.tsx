import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import type { RecordType } from "../../convex/lib/moderationFields";
import type { QueueKind } from "../../convex/lib/queueSummary";
import { ModGate } from "~/lib/moderation";
import {
  ChangeSummary,
  DraftInput,
  Jacket,
  KIND_LABELS,
  ModWorkroom,
  RECORD_LABELS,
  WorklistSkeleton,
  countLabel,
} from "~/lib/modShell";
import { warningLabel } from "~/lib/proposalDraft";

/**
 * The shared review queue (spec §5): In-Review Proposals, oldest first,
 * Data-Team-visible only. Each row names the record it changes and what
 * changes; filters (operation, record type, kind, author or source, age,
 * warnings, staleness) and the preset views live in the URL, so a view is
 * a link. The queue pages through Proposals and says how many it has
 * checked (convex/proposals.ts reviewQueuePage). Claims are shown so reviewers
 * coordinate without exclusive authority. Never indexed.
 */
export const Route = createFileRoute("/mod/queue")({
  head: () => ({ meta: [{ title: "Review queue — MangaDB" }] }),
  validateSearch: queueSearch,
  component: QueuePage,
});

const OPERATIONS = {
  create: "Create records",
  update: "Update fields",
  clearOverride: "Clear a Human Override",
} as const;

const AUTHOR_KINDS = { humans: "People", imports: "Import sources" } as const;

type QueueSearch = {
  op?: keyof typeof OPERATIONS;
  record?: RecordType;
  kind?: QueueKind;
  from?: keyof typeof AUTHOR_KINDS;
  name?: string;
  minAge?: number;
  stale?: true;
  warnings?: true;
};

/** `value` when it is one of `options`' keys. */
function keyOf<Options extends object>(options: Options, value: unknown) {
  return typeof value === "string" && value in options ? (value as keyof Options) : undefined;
}

/** The queue's view from its URL; anything unknown is dropped. */
function queueSearch(search: Record<string, unknown>): QueueSearch {
  const minAge = Number(search.minAge);
  const name = typeof search.name === "string" ? search.name.trim() : "";
  return {
    op: keyOf(OPERATIONS, search.op),
    record: keyOf(RECORD_LABELS, search.record),
    kind: keyOf(KIND_LABELS, search.kind),
    from: keyOf(AUTHOR_KINDS, search.from),
    name: name === "" ? undefined : name,
    minAge:
      search.minAge !== undefined && Number.isFinite(minAge) && minAge > 0 ? minAge : undefined,
    stale: search.stale === true || search.stale === "true" ? true : undefined,
    warnings: search.warnings === true || search.warnings === "true" ? true : undefined,
  };
}

/** The set filters only, so two views compare by what they show. */
function setFilters(search: QueueSearch): Partial<QueueSearch> {
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));
}

const IMPORT_HINT =
  "The importer never overwrites: approve to accept the source's value, reject to suppress this exact offer.";

/** Preset views: filter bundles, shown in the filters once chosen. */
const VIEWS: ReadonlyArray<{ label: string; search: QueueSearch; hint?: string }> = [
  { label: "All", search: {} },
  { label: "Import offers", search: { from: "imports", op: "update" }, hint: IMPORT_HINT },
  { label: "People", search: { from: "humans" } },
  { label: "Suggestions", search: { kind: "suggestion" } },
  { label: "Reports", search: { kind: "report" } },
  { label: "Stale", search: { stale: true } },
];

const sameView = (a: QueueSearch, b: QueueSearch) =>
  JSON.stringify(Object.entries(setFilters(a)).sort()) ===
  JSON.stringify(Object.entries(setFilters(b)).sort());

/** Proposals per page of the queue. */
const QUEUE_PAGE = 25;

function QueuePage() {
  return (
    <ModGate
      role="dataTeam"
      refusal="The review queue is visible to Editors, Moderators, and Administrators."
    >
      <Queue />
    </ModGate>
  );
}

function formatAge(ageMs: number): string {
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

type Page = FunctionReturnType<typeof api.proposals.reviewQueuePage>["page"];
type QueueRowData = Extract<Page[number], { matches: true }>;

function Queue() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/mod/queue" });
  // The client's clock, for "waiting" and the age filter (queries never read
  // it). Fixed while the page is open, so the queue's pages stay put.
  const [now] = useState(() => Date.now());
  const counts = useQuery(api.workroom.counts, {});
  const dashboard = useQuery(api.imports.dashboardPage, {});
  const sourceName = (key: string) =>
    dashboard?.sources.find((source) => source.key === key)?.name ?? key;

  const { results, status, loadMore } = usePaginatedQuery(
    api.proposals.reviewQueuePage,
    {
      operation: search.op,
      recordType: search.record,
      kind: search.kind,
      authorKind: search.from,
      author: search.name,
      staleOnly: search.stale,
      warningsOnly: search.warnings,
      ...(search.minAge !== undefined ? { minAgeHours: search.minAge, now } : {}),
    },
    { initialNumItems: QUEUE_PAGE },
  );
  const rows = results.filter((row): row is QueueRowData => row.matches);
  const filtered = Object.keys(setFilters(search)).length > 0;
  const view = VIEWS.find((entry) => sameView(entry.search, search));

  const show = (next: QueueSearch) => void navigate({ search: setFilters(next), replace: true });
  const set = <Key extends keyof QueueSearch>(key: Key, value: QueueSearch[Key]) =>
    show({ ...search, [key]: value });

  return (
    <ModWorkroom
      current="queue"
      title="Review queue"
      className="mod-queue-page"
      hint={
        view?.hint ??
        "In Review proposals, oldest first. Claiming shows who is looking and never locks; any Moderator can decide."
      }
    >
      <div className="mod-views" role="group" aria-label="Views">
        {VIEWS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            className="btn btn-sm"
            aria-pressed={entry === view}
            onClick={() => show(entry.search)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <form className="queue-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Change kind
          <select
            value={search.op ?? ""}
            onChange={(e) => set("op", keyOf(OPERATIONS, e.target.value))}
          >
            <option value="">Any</option>
            {Object.entries(OPERATIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Record
          <select
            value={search.record ?? ""}
            onChange={(e) => set("record", keyOf(RECORD_LABELS, e.target.value))}
          >
            <option value="">Any</option>
            {Object.entries(RECORD_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select
            value={search.kind ?? ""}
            onChange={(e) => set("kind", keyOf(KIND_LABELS, e.target.value))}
          >
            <option value="">Any</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <select
            value={search.from ?? ""}
            onChange={(e) => set("from", keyOf(AUTHOR_KINDS, e.target.value))}
          >
            <option value="">Anyone</option>
            {Object.entries(AUTHOR_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="queue-name">
          Name
          <DraftInput
            id="queue-name"
            value={search.name ?? ""}
            onCommit={(value) => set("name", value.trim() || undefined)}
            placeholder="username or source key"
          />
        </label>
        <label htmlFor="queue-min-age">
          Waiting at least
          <span className="filter-suffix">
            <DraftInput
              id="queue-min-age"
              inputMode="numeric"
              value={search.minAge === undefined ? "" : String(search.minAge)}
              onCommit={(value) => {
                const hours = Number(value);
                set("minAge", value.trim() !== "" && hours > 0 ? hours : undefined);
              }}
            />
            hours
          </span>
        </label>
        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={search.stale === true}
            onChange={(e) => set("stale", e.target.checked || undefined)}
          />
          Stale only
        </label>
        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={search.warnings === true}
            onChange={(e) => set("warnings", e.target.checked || undefined)}
          />
          With warnings
        </label>
        {filtered ? (
          <button type="button" className="filter-clear" onClick={() => show({})}>
            Clear filters
          </button>
        ) : null}
      </form>

      {status === "LoadingFirstPage" ? (
        <WorklistSkeleton />
      ) : (
        <>
          <p className="worklist-status" aria-live="polite">
            {queueStatus(results.length, rows.length, counts?.inReview, filtered, status)}
          </p>
          {rows.length === 0 ? (
            <p className="notice">
              {status === "Exhausted" ? (
                filtered ? (
                  <>
                    Nothing in review matches this view.{" "}
                    <button type="button" className="link-button" onClick={() => show({})}>
                      Clear filters
                    </button>
                  </>
                ) : (
                  "Nothing is waiting for review."
                )
              ) : (
                "None of the proposals checked so far match this view. Load more to check older ones."
              )}
            </p>
          ) : (
            <ol className="worklist">
              {rows.map((row) => (
                <QueueRow
                  key={row.proposalId}
                  row={row}
                  now={now}
                  sourceName={sourceName}
                  hideKind={search.kind === row.kind}
                />
              ))}
            </ol>
          )}
          {status === "CanLoadMore" || status === "LoadingMore" ? (
            <button
              type="button"
              className="btn btn-sm worklist-more"
              disabled={status === "LoadingMore"}
              onClick={() => loadMore(QUEUE_PAGE)}
            >
              {status === "LoadingMore" ? "Loading…" : `Check the next ${QUEUE_PAGE}`}
            </button>
          ) : null}
        </>
      )}
    </ModWorkroom>
  );
}

/**
 * What the list holds, truthfully: how many In-Review proposals it has
 * checked of how many there are, and how many of those match the filters.
 */
function queueStatus(
  checked: number,
  matching: number,
  inReview: number | undefined,
  filtered: boolean,
  status: string,
): string {
  const total = inReview === undefined ? "" : ` of ${countLabel(inReview)} in review`;
  if (!filtered) {
    return status === "Exhausted"
      ? `${checked} in review, oldest first.`
      : `The oldest ${checked}${total}, oldest first.`;
  }
  return status === "Exhausted"
    ? `${matching} of ${checked} in review match this view.`
    : `${matching} match among the oldest ${checked}${total} checked so far.`;
}

/**
 * One proposal: the record it changes (jacket, title, type), what changes,
 * a person's comment, then who, how long it has waited, its version and
 * claim, and its state chips. The title links to the proposal.
 */
function QueueRow({
  row,
  now,
  sourceName,
  hideKind,
}: {
  row: QueueRowData;
  now: number;
  sourceName: (key: string) => string;
  hideKind: boolean;
}) {
  const subject = row.subject;
  const title = subject?.title ?? (row.comment || "(untitled proposal)");
  return (
    <li className={row.stale ? "work-row mod-flagged" : "work-row"}>
      <Jacket
        title={title}
        src={subject?.coverUrl}
        isbn13={subject?.isbn13}
        mature={subject?.mature ?? false}
      />
      <div className="work-body">
        <div className="work-head">
          <Link className="work-title" to="/mod/proposal/$id" params={{ id: row.proposalId }}>
            {title}
          </Link>
          {subject ? (
            <span className="chip mod-chip">{RECORD_LABELS[subject.recordType]}</span>
          ) : null}
        </div>
        <ChangeSummary summary={row.summary} />
        {row.author.kind === "user" && row.kind !== "report" && row.comment ? (
          <p className="work-comment">{row.comment}</p>
        ) : null}
        <div className="work-meta">
          <span>
            {row.author.kind === "user"
              ? `@${row.author.username ?? "deleted"} (${row.author.role ?? "reader"})`
              : sourceName(row.author.sourceKey)}
          </span>
          <span>waiting {formatAge(now - row.submittedAt)}</span>
          <span>v{row.versionNo}</span>
          {row.claimedBy ? <span>claimed by @{row.claimedBy}</span> : null}
          <span className="work-chips">
            {row.stale ? <span className="chip mod-chip mod-chip--bad">stale</span> : null}
            {row.warnings.length > 0 ? (
              <span className="chip mod-chip mod-chip--warn">
                {row.warnings.length} warning{row.warnings.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {hideKind ? null : (
              <span className="chip mod-chip mod-chip--mute">{KIND_LABELS[row.kind]}</span>
            )}
          </span>
        </div>
        {row.warnings.length > 0 ? (
          <p className="work-warnings">{row.warnings.map(warningLabel).join("; ")}</p>
        ) : null}
      </div>
    </li>
  );
}
