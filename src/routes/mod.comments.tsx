import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { FEATURES } from "../../convex/lib/features";
import { plural } from "~/lib/format";
import { ModGate, ModTools } from "~/lib/moderation";
import { Breadcrumbs } from "~/lib/pageScaffold";
import { useIsModerator } from "~/lib/viewer";
import { writeErrorMessage } from "~/lib/ratings";
import { slugParams } from "~/lib/slug";

/**
 * The Comments queue (CONTEXT.md: Comment, Comment Report, Shadowed User):
 * held Comments awaiting approval, published ones with reports, hidden
 * ones (by a Moderator or three reports), and recently removed ones.
 * Data-Team-visible; Editors read it, Moderators act (convex/comments.ts).
 * Never indexed. While FEATURES.comments is off it only says so.
 */
export const Route = createFileRoute("/mod/comments")({
  head: () => ({ meta: [{ title: "Comments queue — MangaDB" }] }),
  component: CommentsQueuePage,
});

type Tab = FunctionArgs<typeof api.comments.queue>["tab"];
type Row = FunctionReturnType<typeof api.comments.queue>["rows"][number];
type Action = FunctionArgs<typeof api.comments.moderate>["action"];

const TABS: ReadonlyArray<{ tab: Tab; label: string; hint: string }> = [
  {
    tab: "pending",
    label: "Pending",
    hint: "Held by a hold rule, oldest first. Approve publishes; nobody else sees them yet.",
  },
  {
    tab: "reported",
    label: "Reported",
    hint: "Published with one or more reports, most reported first. Dismiss reports keeps it published.",
  },
  {
    tab: "hidden",
    label: "Hidden",
    hint: "Hidden by a Moderator or by three reports. Only the author sees that they are there.",
  },
  {
    tab: "removed",
    label: "Removed",
    hint: "Removed by a Moderator or deleted by the author, newest first. Only Moderator removals can be restored.",
  },
];

const REASON_LABELS: Record<keyof Row["reasons"], string> = {
  spam: "spam",
  harassment: "harassment",
  spoiler: "spoiler",
  offTopic: "off-topic",
  other: "other",
};

/** The buttons each status offers, in order. */
const ACTIONS: Record<Row["status"], ReadonlyArray<{ action: Action; label: string }>> = {
  pending: [
    { action: "approve", label: "Approve" },
    { action: "hide", label: "Hide" },
    { action: "remove", label: "Remove" },
  ],
  // Only the Reported tab lists published Comments; approving one dismisses its reports.
  approved: [
    { action: "approve", label: "Dismiss reports" },
    { action: "hide", label: "Hide" },
    { action: "remove", label: "Remove" },
  ],
  hidden: [
    { action: "unhide", label: "Unhide" },
    { action: "remove", label: "Remove" },
  ],
  removed: [{ action: "restore", label: "Restore" }],
  // No tab lists a Shadowed User's Comments; kept for completeness.
  shadowed: [
    { action: "hide", label: "Hide" },
    { action: "remove", label: "Remove" },
  ],
};

function CommentsQueuePage() {
  if (!FEATURES.comments) {
    return (
      <main className="mod-page">
        <Breadcrumbs trail={["Comments"]} />
        <h1>Comments</h1>
        <p className="notice">
          Comments are switched off. Nobody can post, and pages show none. The switch is{" "}
          <code>FEATURES.comments</code> in <code>convex/lib/features.ts</code>.
        </p>
      </main>
    );
  }
  return (
    <ModGate
      role="dataTeam"
      refusal="The Comments queue is visible to Editors, Moderators, and Administrators."
    >
      <CommentsQueue />
    </ModGate>
  );
}

/** Editors read the queue; Moderators act on it. */
function CommentsQueue() {
  const canAct = useIsModerator();
  const [tab, setTab] = useState<Tab>("pending");
  const queue = useQuery(api.comments.queue, { tab });
  const counts = useQuery(api.comments.queueCounts, {});
  const current = TABS.find((entry) => entry.tab === tab)!;
  return (
    <main className="mod-page">
      <Breadcrumbs trail={["Comments"]} />
      <h1>Comments</h1>
      <p className="section-hint">
        Comments publish at once unless a hold rule fires (a new account, fewer than three approved
        comments, or more than two links). Three reports hide one until you decide.
        {canAct ? null : " Editors can read this queue; Moderators act on it."}
      </p>
      <ModTools />

      <div className="comment-tabs" role="group" aria-label="Queue">
        {TABS.map((entry) => {
          const count = entry.tab === "removed" ? undefined : counts?.[entry.tab];
          return (
            <button
              key={entry.tab}
              type="button"
              className="btn btn-sm"
              aria-pressed={entry.tab === tab}
              onClick={() => setTab(entry.tab)}
            >
              {entry.label}
              {count ? ` · ${count >= 100 ? "100+" : count}` : ""}
            </button>
          );
        })}
      </div>
      <p className="section-hint">{current.hint}</p>

      {queue === undefined ? (
        <p className="notice">Loading…</p>
      ) : queue.rows.length === 0 ? (
        <p className="notice">Nothing here.</p>
      ) : (
        <>
          <ul className="comment-queue">
            {queue.rows.map((row) => (
              <QueueRow key={row.commentId} row={row} canAct={canAct} />
            ))}
          </ul>
          {queue.hasMore ? <p className="section-hint">More follow; clear these first.</p> : null}
        </>
      )}
    </main>
  );
}

function QueueRow({ row, canAct }: { row: Row; canAct: boolean }) {
  const moderate = useMutation(api.comments.moderate);
  const setShadowed = useMutation(api.comments.setShadowed);
  const [revealed, setRevealed] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: Promise<unknown>) => {
    setError(null);
    setBusy(true);
    work.catch((err: unknown) => setError(writeErrorMessage(err))).finally(() => setBusy(false));
  };
  const reasonArg = reason.trim() || undefined;
  const reasons = Object.entries(row.reasons) as Array<[keyof Row["reasons"], number]>;

  return (
    <li>
      <div className="comment-queue-meta">
        <TargetLink target={row.target} />
        <span>{row.isReply ? "reply" : "comment"}</span>
        <span>
          by{" "}
          {row.username ? (
            <Link to="/u/$username" params={{ username: row.username }}>
              @{row.username}
            </Link>
          ) : (
            "a deleted account"
          )}
        </span>
        {row.authorShadowed ? <span className="chip mod-chip mod-chip--warn">shadowed</span> : null}
        <span className="chip mod-chip">{row.status}</span>
        {row.reportCount > 0 ? (
          <span className="chip mod-chip mod-chip--bad">{plural(row.reportCount, "report")}</span>
        ) : null}
        <span>
          {new Date(row.createdAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {row.edited ? " · edited" : ""}
        </span>
      </div>
      {row.spoiler && !revealed ? (
        <button type="button" className="btn btn-sm" onClick={() => setRevealed(true)}>
          Show spoiler
        </button>
      ) : (
        <p className="comment-body">{row.body}</p>
      )}
      {reasons.length > 0 ? (
        <div className="comment-queue-reports">
          Reported as {reasons.map(([key, n]) => `${REASON_LABELS[key]} ×${n}`).join(", ")}
          {row.notes.length > 0 ? (
            <ul>
              {row.notes.map((note, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: each note is plain text with no state, so a key by position only re-renders in place
                  key={i}
                >
                  {REASON_LABELS[note.reason]}: {note.note}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {canAct ? (
        <div className="review-mod">
          <input
            className="review-mod-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional, kept in the audit log)"
            maxLength={500}
          />
          {ACTIONS[row.status].map(({ action, label }) => (
            <button
              key={action}
              type="button"
              className={`btn btn-sm${action === "remove" || action === "hide" ? " btn-danger" : ""}`}
              disabled={busy}
              onClick={() => run(moderate({ commentId: row.commentId, action, reason: reasonArg }))}
            >
              {label}
            </button>
          ))}
          {row.username ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                run(
                  setShadowed({
                    commentId: row.commentId,
                    shadowed: !row.authorShadowed,
                    reason: reasonArg,
                  }),
                )
              }
            >
              {row.authorShadowed ? "Unshadow user" : "Shadow user"}
            </button>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function TargetLink({ target }: { target: Row["target"] }) {
  return target.kind === "series" ? (
    <Link to="/series/$publicId/$slug" params={slugParams(target.publicId, target.title)}>
      {target.title}
    </Link>
  ) : (
    <Link to="/volume/$publicId/$slug" params={slugParams(target.publicId, target.title)}>
      {target.title}
    </Link>
  );
}
