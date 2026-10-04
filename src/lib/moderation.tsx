// Moderation affordances (spec §5). On catalog pages: the public per-record
// revision history — final diff, author, approver, timestamp, change
// comment, citation — and the moderator/administrator edit links. On the
// /mod pages: the access gate and the tool links. All of it fetches
// client-side through the reactive Convex client; role checks here are
// cosmetic (the moderation functions re-check authorization on every call).

import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import { FEATURES } from "../../convex/lib/features";
import type { WrittenBy } from "../../convex/moderation";
import { formatPartialDate, formatPrice } from "~/lib/format";
import { useIsDataTeam, useIsModerator } from "~/lib/viewer";

export type HistoryTargetType = "series" | "volume" | "edition" | "releaseBundle";

/** Render any stored field value for the history diff. */
export function renderFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(empty)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "(none)" : value.map(renderFieldValue).join(", ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.year === "number") {
      return (
        formatPartialDate(record as { year: number; month?: number; day?: number }) ??
        "(empty)"
      );
    }
    if (typeof record.amountCents === "number") {
      return (
        formatPrice(record as { amountCents: number; currency: string }) ?? "(empty)"
      );
    }
  }
  return JSON.stringify(value);
}

/**
 * What lifting a Human Override does, said beside every control that lifts
 * one: the flag goes, the value and its author stay, and the import rules
 * weigh that author (convex/lib/authority.ts decideField). It promises only
 * that an import never replaces a human-written value unreviewed: an offer
 * may also be skipped, or fill an empty field nobody wrote.
 */
export const CLEAR_OVERRIDE_HINT =
  "Clearing keeps the value and who wrote it; imports then follow the usual Field Authority rules, so replacing a human-written value still needs review, and a value a source wrote may update automatically.";

/** Who wrote a field's current value, as moderation.writtenBy reports it. */
export function writtenByLabel(author: WrittenBy): string {
  if (author.kind === "human") return "written by a person";
  if (author.kind === "source") return `imported from ${author.sourceKey}`;
  return "no recorded author";
}

/** A revision's change to `overriddenFields`, read as the overrides it set or cleared. */
function overrideChangeText(before: unknown, after: unknown): string {
  const names = (value: unknown) =>
    Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  const was = names(before);
  const now = names(after);
  const cleared = was.filter((name) => !now.includes(name));
  const set = now.filter((name) => !was.includes(name));
  return [
    cleared.length > 0 ? `Human Override cleared on ${cleared.join(", ")}` : null,
    set.length > 0 ? `Human Override set on ${set.join(", ")}` : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
}

const ROLE_LABELS = {
  editor: "Editor",
  moderator: "Moderator",
  administrator: "Administrator",
} as const;

// A Proposal's lifecycle state, with the tone it is drawn in on the queue and
// the proposal page: pending work is warm, a decision is green or red, and
// anything inert is grey.
const PROPOSAL_STATES = {
  draft: { label: "Draft", tone: "mute" },
  inReview: { label: "In Review", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
  withdrawn: { label: "Withdrawn", tone: "mute" },
} as const;

/** A Proposal's state, worn as a status chip. */
export function ProposalStateChip({ state }: { state: string }) {
  const known = PROPOSAL_STATES[state as keyof typeof PROPOSAL_STATES];
  return (
    <span className={`chip mod-chip mod-chip--${known?.tone ?? "mute"}`}>
      {known?.label ?? state}
    </span>
  );
}

/**
 * The public revision history of a record page, as a closed disclosure so it
 * sits quietly under the catalog content. Few readers open it and the query
 * reads every revision with its authors, so it subscribes the first time the
 * disclosure opens (and stays live from then on): "Loading…" until the
 * history arrives, the revision count in the summary after.
 */
export function RecordHistory({
  type,
  publicId,
}: {
  type: HistoryTargetType;
  publicId: number;
}) {
  const [opened, setOpened] = useState(false);
  const history = useQuery(api.moderation.recordHistory, opened ? { type, publicId } : "skip");
  const count = history?.revisions.length;
  return (
    <details
      className="record-history"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>
        History
        {count !== undefined ? (
          <span className="record-history-count">
            {count} revision{count === 1 ? "" : "s"}
          </span>
        ) : null}
      </summary>
      {opened ? <HistoryBody history={history} /> : null}
    </details>
  );
}

/** The opened history: loading, empty, or the revisions newest first. */
function HistoryBody({
  history,
}: {
  history: FunctionReturnType<typeof api.moderation.recordHistory> | undefined;
}) {
  if (history === undefined) return <p className="section-hint">Loading…</p>;
  if (history === null || history.revisions.length === 0) {
    return <p className="section-hint">No changes recorded yet.</p>;
  }
  return (
    <>
      <p className="section-hint">
        Every approved change to this record, newest first.
        {history.overriddenFields.length > 0 ? (
          <>
            {" "}
            Human-corrected fields (imports never overwrite these):{" "}
            {history.overriddenFields.join(", ")}.
          </>
        ) : null}
      </p>
      <ol className="revision-list">
        {history.revisions.map((revision) => (
          <li key={revision.seq} className="revision">
            <div className="revision-meta">
              <span className="revision-seq">#{revision.seq}</span>
              <span className="revision-author">
                {revision.author.kind === "user" ? (
                  <>
                    {revision.author.username
                      ? `@${revision.author.username}`
                      : "(deleted account)"}
                    {revision.author.role
                      ? ` (${ROLE_LABELS[revision.author.role]})`
                      : null}
                  </>
                ) : (
                  `Imported from ${revision.author.sourceKey}`
                )}
              </span>
              <span className="revision-approver">
                {revision.approver
                  ? `approved by @${revision.approver}`
                  : "approved automatically"}
              </span>
              <time dateTime={new Date(revision.at).toISOString()}>
                {new Date(revision.at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </div>
            <p className="revision-comment">{revision.comment}</p>
            <ul className="revision-changes">
              {revision.changes.map((change) =>
                change.field === "overriddenFields" ? (
                  <li key={change.field}>{overrideChangeText(change.before, change.after)}</li>
                ) : (
                  <li key={change.field}>
                    <code>{change.field}</code>:{" "}
                    <del>{renderFieldValue(change.before)}</del> →{" "}
                    <ins>{renderFieldValue(change.after)}</ins>
                  </li>
                ),
              )}
            </ul>
            {revision.citation ? (
              <p className="revision-citation">
                Source: <a href={revision.citation.url}>{revision.citation.sourceName}</a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}

/** A date and time in the viewer's locale, as the mod dashboards show them. */
export const timestamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The access gate in front of a mod page: "Checking your access…" while the
 * viewer loads, then the page for a viewer holding `role`, else a refusal
 * that says who the page is for (`refusal`) and links sign-in when signed
 * out. `children` only mounts once the viewer is let in. The Convex
 * functions re-check the role on every call.
 */
export function ModGate({
  role,
  refusal,
  children,
}: {
  role: "dataTeam" | "moderator";
  refusal: string;
  children: ReactNode;
}) {
  const viewer = useQuery(api.users.viewer, {});
  const isDataTeam = useIsDataTeam();
  const isModerator = useIsModerator();
  if (viewer === undefined) {
    return (
      <main className="mod-page">
        <p className="notice">Checking your access…</p>
      </main>
    );
  }
  if (!(role === "moderator" ? isModerator : isDataTeam)) {
    return (
      <main className="mod-page">
        <h1>{role === "moderator" ? "Moderators only" : "Data team only"}</h1>
        <p className="notice">
          {refusal} {viewer === null ? <a href="/sign-in">Sign in</a> : null}
        </p>
      </main>
    );
  }
  return children;
}

const MOD_TOOLS = [
  { to: "/mod/queue", label: "Review queue" },
  { to: "/mod/imports", label: "Imports" },
  { to: "/mod/launch", label: "Launch" },
  { to: "/mod/packaging", label: "Catalog gaps" },
] as const;

/**
 * The data team's tool links under a dashboard's heading, leaving out the
 * page they sit on, then the Comments queue.
 */
export function ModTools({ current }: { current?: (typeof MOD_TOOLS)[number]["to"] }) {
  return (
    <nav className="mod-tools" aria-label="Data team tools">
      {MOD_TOOLS.filter((tool) => tool.to !== current).map((tool) => (
        <Link key={tool.to} to={tool.to}>
          {tool.label}
        </Link>
      ))}
      <CommentsQueueLink />
    </nav>
  );
}

/**
 * The Comments queue link for the `.mod-tools` navs, with the number of
 * Comments awaiting review as a badge ("100+" past the query's cap).
 * Nothing while Comments are switched off (FEATURES.comments).
 */
export function CommentsQueueLink() {
  if (!FEATURES.comments) return null;
  return <CommentsQueueLinkInner />;
}

function CommentsQueueLinkInner() {
  const counts = useQuery(api.comments.queueCounts, {});
  const pending = counts?.pending ?? 0;
  return (
    <Link to="/mod/comments">
      Comments
      {pending > 0 ? (
        <span className="mod-badge" role="img" aria-label={`${pending} awaiting review`}>
          {pending >= 100 ? "100+" : pending}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The maintenance entry point on a record page: Moderators and
 * Administrators get the direct edit (`/mod/edit`); Editors get the update
 * proposal (`/mod/propose`) whose submission lands In Review.
 */
export function ModEditLink({ type, editKey }: { type: string; editKey: string }) {
  const isModerator = useIsModerator();
  const isDataTeam = useIsDataTeam();
  if (isModerator) {
    return (
      <p className="mod-edit-link">
        <Link to="/mod/edit/$type/$key" params={{ type, key: editKey }}>
          Edit this record
        </Link>
        {/* The sensitive-operations panel: hide/restore,
            merge/split, temporary locks. */}
        <Link to="/mod/manage/$type/$key" params={{ type, key: editKey }}>
          Manage (hide / merge / lock)
        </Link>
      </p>
    );
  }
  if (isDataTeam) {
    return (
      <p className="mod-edit-link">
        <Link to="/mod/propose/$type/$key" params={{ type, key: editKey }}>
          Propose a change
        </Link>
      </p>
    );
  }
  return null;
}

/**
 * The atomic multi-record proposal entry point on a Series page: any
 * data-team member can propose a new Volume + Edition + Release in one
 * temp-ID Proposal.
 */
export function ProposeNewRecordsLink({
  seriesPublicId,
}: {
  seriesPublicId: number;
}) {
  const isDataTeam = useIsDataTeam();
  if (!isDataTeam) return null;
  return (
    <p className="mod-edit-link">
      <Link
        to="/mod/propose-new/$seriesPublicId"
        params={{ seriesPublicId: String(seriesPublicId) }}
      >
        Propose a new volume + edition + release
      </Link>
    </p>
  );
}

/**
 * Moderator edit links for an Edition's Release rows. Releases have no page
 * of their own (spec §11), so their edit entry point lives on the Edition
 * page, one link per row keyed by the row's anchor.
 */
export function ModReleaseEditLinks({
  releases,
}: {
  releases: Array<{ id: string; anchor: string }>;
}) {
  const isModerator = useIsModerator();
  const isDataTeam = useIsDataTeam();
  if (!isDataTeam || releases.length === 0) return null;
  return (
    <p className="mod-edit-link">
      <span>{isModerator ? "Edit a release:" : "Propose a change to a release:"}</span>
      {releases.map((release) => (
        <Link
          key={release.id}
          to={isModerator ? "/mod/edit/$type/$key" : "/mod/propose/$type/$key"}
          params={{ type: "release", key: release.id }}
        >
          {release.anchor}
        </Link>
      ))}
    </p>
  );
}
