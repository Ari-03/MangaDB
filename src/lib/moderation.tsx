// Moderation affordances on catalog pages (ticket #31, spec §5): the public
// per-record revision history — final diff, author, approver, timestamp,
// change comment, citation — and the moderator/administrator edit link.
// Both fetch client-side through the reactive Convex client: history is
// public data; the edit link is cosmetic gating on the viewer's role (the
// moderation functions re-check authorization on every call).

import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { convexClient } from "~/providers";
import { formatPartialDate, formatPrice } from "~/lib/format";

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

const ROLE_LABELS = {
  editor: "Editor",
  moderator: "Moderator",
  administrator: "Administrator",
} as const;

/**
 * The public revision history section of a record page. Renders nothing
 * until the client has data (history is reactive, not SSR'd) and nothing at
 * all when the record has no history yet.
 */
export function RecordHistory(props: {
  type: HistoryTargetType;
  publicId: number;
}) {
  if (!convexClient) return null;
  return <RecordHistoryInner {...props} />;
}

function RecordHistoryInner({
  type,
  publicId,
}: {
  type: HistoryTargetType;
  publicId: number;
}) {
  const history = useQuery(api.moderation.recordHistory, { type, publicId });
  if (!history || history.revisions.length === 0) return null;
  return (
    <section className="record-history">
      <h2>History</h2>
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
              {revision.changes.map((change) => (
                <li key={change.field}>
                  <code>{change.field}</code>:{" "}
                  <del>{renderFieldValue(change.before)}</del> →{" "}
                  <ins>{renderFieldValue(change.after)}</ins>
                </li>
              ))}
            </ul>
            {revision.citation ? (
              <p className="revision-citation">
                Source: <a href={revision.citation.url}>{revision.citation.sourceName}</a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** True when the viewer holds the Moderator or Administrator role. */
export function useIsModerator(): boolean {
  const viewer = useQuery(api.users.viewer, {});
  return Boolean(
    viewer &&
      !viewer.needsUsername &&
      (viewer.role === "moderator" || viewer.role === "administrator"),
  );
}

/** True when the viewer holds any data-team role (Editor and up). */
export function useIsDataTeam(): boolean {
  const viewer = useQuery(api.users.viewer, {});
  return Boolean(
    viewer &&
      !viewer.needsUsername &&
      (viewer.role === "editor" ||
        viewer.role === "moderator" ||
        viewer.role === "administrator"),
  );
}

/**
 * The maintenance entry point on a record page: Moderators and
 * Administrators get the direct edit (`/mod/edit`); Editors get the update
 * proposal (`/mod/propose`, ticket #32) whose submission lands In Review.
 */
export function ModEditLink(props: { type: string; editKey: string }) {
  if (!convexClient) return null;
  return <ModEditLinkInner {...props} />;
}

function ModEditLinkInner({ type, editKey }: { type: string; editKey: string }) {
  const isModerator = useIsModerator();
  const isDataTeam = useIsDataTeam();
  if (isModerator) {
    return (
      <p className="mod-edit-link">
        <Link to="/mod/edit/$type/$key" params={{ type, key: editKey }}>
          Edit this record
        </Link>{" "}
        <span aria-hidden="true">·</span>{" "}
        {/* The sensitive-operations panel (ticket #33): hide/restore,
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
 * The atomic multi-record proposal entry point on a Series page (ticket
 * #32): any data-team member can propose a new Volume + Edition + Release
 * in one temp-ID Proposal.
 */
export function ProposeNewRecordsLink(props: { seriesPublicId: number }) {
  if (!convexClient) return null;
  return <ProposeNewRecordsLinkInner {...props} />;
}

function ProposeNewRecordsLinkInner({
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
export function ModReleaseEditLinks(props: {
  releases: Array<{ id: string; anchor: string }>;
}) {
  if (!convexClient) return null;
  return <ModReleaseEditLinksInner {...props} />;
}

function ModReleaseEditLinksInner({
  releases,
}: {
  releases: Array<{ id: string; anchor: string }>;
}) {
  const isModerator = useIsModerator();
  const isDataTeam = useIsDataTeam();
  if (!isDataTeam || releases.length === 0) return null;
  return (
    <p className="mod-edit-link">
      {isModerator ? "Edit a release:" : "Propose a change to a release:"}{" "}
      {releases.map((release, i) => (
        <span key={release.id}>
          {i > 0 ? " · " : ""}
          <Link
            to={isModerator ? "/mod/edit/$type/$key" : "/mod/propose/$type/$key"}
            params={{ type: "release", key: release.id }}
          >
            {release.anchor}
          </Link>
        </span>
      ))}
    </p>
  );
}
