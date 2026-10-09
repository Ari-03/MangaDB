// The data team's workroom frame (styles/mod.css "workroom"): every /mod
// tool page renders inside <ModWorkroom>, which draws the breadcrumb, the
// tab strip of tools with their counts (convex/workroom.ts), the help group
// (Discord, Report a bug), the page title and its one-line hint, and an
// error boundary around the page body so a failing query keeps the
// navigation. The pieces the tool pages share live here too: the panel
// switch, the "How this works" explainer, and the work row with its jacket.
// Edit and propose forms keep their own frame.

import { CatchBoundary, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { api } from "../../convex/_generated/api";
import { FEATURES } from "../../convex/lib/features";
import type { RecordType } from "../../convex/lib/moderationFields";
import type { QueueKind, QueueSummary } from "../../convex/lib/queueSummary";
import { COUNT_CAP } from "../../convex/lib/workroom";
import { BugReportButton, DISCORD_INVITE_URL } from "~/lib/community";
import { Cover } from "~/lib/cover";
import { ConcealArt } from "~/lib/mature";
import { renderFieldValue } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { useIsModerator, useReadyViewer } from "~/lib/viewer";

/** A capped count as a tab shows it: past COUNT_CAP, "100+". */
export function countLabel(count: number): string {
  return count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
}

/** The workroom's tools, in tab order. */
const TOOLS = [
  { id: "queue", to: "/mod/queue", label: "Review queue" },
  { id: "imports", to: "/mod/imports", label: "Imports" },
  { id: "packaging", to: "/mod/packaging", label: "Catalog gaps" },
  { id: "proposals", to: "/mod/proposals", label: "My proposals" },
  { id: "comments", to: "/mod/comments", label: "Comments" },
  { id: "launch", to: "/mod/launch", label: "Launch" },
  { id: "roles", to: "/mod/roles", label: "Roles" },
] as const;

export type ModTool = (typeof TOOLS)[number]["id"];

/** The badge beside a tab: a count, a dot, or nothing. */
function TabBadge({ count, label }: { count: number | undefined; label: string }) {
  if (count === undefined || count === 0) return null;
  return (
    <span className="mod-tab-count" role="img" aria-label={`${count} ${label}`}>
      {countLabel(count)}
    </span>
  );
}

/**
 * The tool tabs: links, the current one marked `aria-current`, Roles for
 * Moderators only, Comments only while FEATURES.comments is on. Counts
 * fill in when they arrive; `withCounts={false}` (the error page) draws
 * the tabs alone. On a narrow screen the strip scrolls with the current
 * tab brought into view.
 */
export function ModNav({
  current,
  withCounts = true,
}: {
  current?: ModTool;
  withCounts?: boolean;
}) {
  const isModerator = useIsModerator();
  const viewer = useReadyViewer();
  const counts = useQuery(api.workroom.counts, withCounts ? {} : "skip");
  const comments = useQuery(
    api.comments.queueCounts,
    withCounts && FEATURES.comments ? {} : "skip",
  );
  const strip = useRef<HTMLElement>(null);
  const active = useRef<HTMLAnchorElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the current tab is all that decides where the strip scrolls
  useEffect(() => {
    const nav = strip.current;
    const tab = active.current;
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2;
  }, [current]);

  const tools = TOOLS.filter(
    (tool) => (tool.id !== "roles" || isModerator) && (tool.id !== "comments" || FEATURES.comments),
  );
  const badge = (id: ModTool) => {
    if (id === "queue") return <TabBadge count={counts?.inReview} label="in review" />;
    if (id === "comments") return <TabBadge count={comments?.pending} label="awaiting review" />;
    if (id === "imports" && (counts?.unhealthySources ?? 0) > 0) {
      return (
        <span
          className="mod-tab-dot"
          role="img"
          aria-label={`${counts?.unhealthySources} unhealthy source${counts?.unhealthySources === 1 ? "" : "s"}`}
        />
      );
    }
    return null;
  };

  return (
    <div className="mod-nav-row">
      <nav className="mod-nav" aria-label="Data team tools" ref={strip}>
        {tools.map((tool) => (
          <Link
            key={tool.id}
            to={tool.to}
            className="mod-tab"
            aria-current={tool.id === current ? "page" : undefined}
            ref={tool.id === current ? active : undefined}
          >
            {tool.label}
            {badge(tool.id)}
          </Link>
        ))}
      </nav>
      <div className="mod-help">
        <a className="mod-help-link" href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">
          Discord
        </a>
        <BugReportButton role={viewer?.role ?? "reader"} />
      </div>
    </div>
  );
}

/** A page body that failed to render: what failed, and a way to try again. */
function WorkroomError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="notice mod-error" role="alert">
      <p>This page could not load. {error.message ? <code>{error.message}</code> : null}</p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Reload
      </button>
    </div>
  );
}

/**
 * The frame of a workroom page. `current` marks its tab; `crumbs` replaces
 * the last breadcrumb for a page under a tool (a proposal under the
 * queue); `titleAside` sits beside the title (state chips); `hint` is the
 * one line under it. The body renders inside an error boundary.
 */
export function ModWorkroom({
  current,
  title,
  titleAside,
  hint,
  crumbs,
  className,
  children,
}: {
  current?: ModTool;
  title: ReactNode;
  titleAside?: ReactNode;
  hint?: ReactNode;
  crumbs?: Array<string | ReactElement>;
  className?: string;
  children: ReactNode;
}) {
  const tool = TOOLS.find((entry) => entry.id === current);
  const router = useRouter();
  return (
    <main className={`mod-page mod-workroom${className ? ` ${className}` : ""}`}>
      <Breadcrumbs
        trail={[
          <Link key="workroom" to="/mod/queue">
            Workroom
          </Link>,
          ...(crumbs ?? (tool ? [tool.label] : [])),
        ]}
      />
      <ModNav current={current} />
      <div className="mod-title-row">
        <h1>{title}</h1>
        {titleAside}
      </div>
      {hint ? <p className="section-hint">{hint}</p> : null}
      {/* A new address (another proposal, another view) clears a caught error. */}
      <CatchBoundary getResetKey={() => router.state.location.href} errorComponent={WorkroomError}>
        {children}
      </CatchBoundary>
    </main>
  );
}

/**
 * The /mod layout's error page, for a failure outside a page body (the
 * access check, a route that would not load): the frame without counts,
 * and a reload.
 */
export function WorkroomErrorPage(props: ErrorComponentProps) {
  return (
    <main className="mod-page mod-workroom">
      <Breadcrumbs trail={["Workroom"]} />
      <ModNav withCounts={false} />
      <h1 className="mod-error-title">Something went wrong</h1>
      <WorkroomError {...props} />
    </main>
  );
}

/**
 * A switch between a page's panels: buttons with `aria-pressed`, each
 * with an optional count. The page keeps the choice in its URL.
 */
export function ModSubtabs<Panel extends string>({
  label,
  panels,
  value,
  onChange,
}: {
  label: string;
  panels: ReadonlyArray<{ value: Panel; label: string; count?: string | null }>;
  value: Panel;
  onChange: (panel: Panel) => void;
}) {
  return (
    <div className="mod-subtabs" role="group" aria-label={label}>
      {panels.map((panel) => (
        <button
          key={panel.value}
          type="button"
          className="mod-subtab"
          aria-pressed={panel.value === value}
          onClick={() => onChange(panel.value)}
        >
          {panel.label}
          {panel.count ? <span className="mod-tab-count">{panel.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** The standing explanation of a panel's mechanism, closed until asked for. */
export function Explainer({
  summary = "How this works",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="mod-explainer">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * A row's small book: stored art, else the ISBN's jacket, else cloth with
 * the title; concealed (cloth, 18+) for a Mature Series the viewer has not
 * opted in to. Decorative: the row's title names it.
 */
export function Jacket({
  title,
  src,
  isbn13,
  mature,
}: {
  title: string;
  src?: string | null;
  isbn13?: string | null;
  mature: boolean;
}) {
  return (
    <span className="work-jacket" aria-hidden="true">
      <ConcealArt mature={mature} notice={false}>
        <Cover src={src} isbn13={isbn13} title={title} />
      </ConcealArt>
    </span>
  );
}

/** Placeholder rows while a worklist loads. */
export function WorklistSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ol className="worklist worklist-skeleton" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders
          key={i}
          className="work-row"
        >
          <span className="work-jacket" />
          <span className="work-body">
            <span className="skeleton-bar" />
            <span className="skeleton-bar skeleton-bar--short" />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Record types as the workroom names them. */
export const RECORD_LABELS = {
  publisher: "Publisher",
  seriesFamily: "Series family",
  series: "Series",
  volume: "Volume",
  editionLine: "Edition line",
  edition: "Edition",
  release: "Release",
  releaseVariant: "Release variant",
  releaseBundle: "Bundle",
} satisfies Record<RecordType, string>;

/** A stored record type's name, or the type itself for one the workroom does not know. */
export function recordLabel(type: string): string {
  const labels: Record<string, string> = RECORD_LABELS;
  return labels[type] ?? type;
}

/** Queue kinds (convex/lib/queueSummary.ts), in the Kind filter's order. */
export const KIND_LABELS = {
  importOffer: "Import offer",
  importCreation: "Import creation",
  fieldChange: "Field change",
  newRecords: "New records",
  sensitive: "Merge, hide or lock",
  report: "Report",
  suggestion: "Suggestion",
} satisfies Record<QueueKind, string>;

/** How a summary names a sensitive op. */
const ACTION_LABELS: Record<string, string> = {
  merge: "Merge",
  split: "Split",
  hide: "Hide",
  restore: "Restore",
  lock: "Lock",
  unlock: "Unlock",
};

/**
 * A Proposal's change in one line: the first fields with before and after,
 * what it creates, the overrides it clears, the sensitive ops; a report's
 * message instead. Nothing when the summary is empty.
 */
export function ChangeSummary({ summary }: { summary: QueueSummary }) {
  if (summary.report !== null) {
    return <p className="work-change work-report">{summary.report}</p>;
  }
  const parts: ReactNode[] = summary.fields.map((change) => (
    <span key={change.field}>
      <span className="k">{change.label}:</span> <del>{renderFieldValue(change.before)}</del> →{" "}
      <ins>{renderFieldValue(change.after)}</ins>
    </span>
  ));
  if (summary.moreFields > 0) parts.push(<span key="more">and {summary.moreFields} more</span>);
  if (summary.creates.length > 0) {
    parts.push(
      <span key="creates">
        Creates {summary.creates.map((type) => RECORD_LABELS[type]).join(", ")}
      </span>,
    );
  }
  if (summary.clears.length > 0) {
    parts.push(<span key="clears">Clears a Human Override on {summary.clears.join(", ")}</span>);
  }
  if (summary.actions.length > 0) {
    parts.push(
      <span key="actions">
        {summary.actions.map((action) => ACTION_LABELS[action] ?? action).join(", ")}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <p className="work-change">{parts}</p>;
}

/**
 * A text field that keeps its own draft and hands it on (`onCommit`) when
 * the person leaves it or presses Enter, for filters kept in the URL: the
 * URL changes once per value, not per keystroke. A new `value` from
 * outside (a view, Clear filters) replaces the draft.
 */
export function DraftInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
