// Comments UI (CONTEXT.md: Comment): the "Comments" section under Reviews on
// a Series or Volume page. The first page of threads is server-rendered from
// the page loader, then follows the live query (which, signed in, adds the
// viewer's own held and hidden Comments); "More comments" asks for another
// page's worth. Threads are newest first with replies nested one level,
// oldest first. Plain text: the body renders with its line breaks, nothing
// is parsed. Every action is re-checked on the server (convex/comments.ts).

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { track } from "~/lib/analytics";
import { useIsModerator } from "~/lib/moderation";
import { writeErrorMessage, type RatingTarget } from "~/lib/ratings";
import { convexClient } from "~/providers";

// Mirrors COMMENT_POLICY.maxLength / .noteMaxLength / .page in convex/comments.ts.
const MAX_LENGTH = 2000;
const NOTE_MAX = 500;
const PAGE = 20;

/** One page of a target's Comments, as the loader and the live query return it. */
export type CommentPage = NonNullable<FunctionReturnType<typeof api.comments.list>>;
type Thread = CommentPage["items"][number];
type CommentData = Omit<Thread, "replies">;
type TargetId = CommentPage["target"];

const REPORT_REASONS = [
  ["spam", "Spam or advertising"],
  ["harassment", "Harassment or abuse"],
  ["spoiler", "Unmarked spoiler"],
  ["offTopic", "Off-topic"],
  ["other", "Something else"],
] as const;
type ReportReason = (typeof REPORT_REASONS)[number][0];

const dateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
function relativeTime(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateFormat.format(then);
}

/**
 * The time since a Comment, relative once hydrated. The server renders the
 * date, so the first client render matches it.
 */
function When({ at }: { at: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return (
    <time dateTime={new Date(at).toISOString()} title={dateFormat.format(at)}>
      {now === null ? dateFormat.format(at) : relativeTime(at, now)}
    </time>
  );
}

/**
 * The Comments section. `noun` names the target in prompts ("series",
 * "volume"); `initial` is the loader's first page (null when Convex is not
 * configured or the target is gone).
 */
export function CommentsSection({
  target,
  initial,
  noun,
}: {
  target: RatingTarget;
  initial: CommentPage | null;
  noun: string;
}) {
  return (
    <section className="section comments">
      <div className="section-head">
        <h2 className="section-title">Comments</h2>
        <p className="section-note">Newest first · be kind, and mark spoilers</p>
      </div>
      {convexClient ? (
        <LiveComments target={target} initial={initial} noun={noun} />
      ) : (
        <ThreadList items={initial?.items ?? []} noun={noun} />
      )}
    </section>
  );
}

function LiveComments({
  target,
  initial,
  noun,
}: {
  target: RatingTarget;
  initial: CommentPage | null;
  noun: string;
}) {
  const [limit, setLimit] = useState(PAGE);
  const live = useQuery(api.comments.list, { target, limit });
  // While a bigger page loads, keep showing the last one rather than blinking.
  const last = useRef(initial);
  if (live !== undefined) last.current = live;
  const page = live ?? last.current;
  if (!page) return null;

  return (
    <>
      <Composer targetId={page.target} noun={noun} />
      <ThreadList
        items={page.items}
        noun={noun}
        renderActions={(item, isReply, openReply) => (
          <CommentActions item={item} isReply={isReply} onReply={openReply} />
        )}
        renderReply={(thread, close) => (
          <CommentForm targetId={page.target} parentId={thread.commentId} onDone={close} onCancel={close} />
        )}
      />
      {page.hasMore ? (
        <p className="comments-more">
          <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + PAGE)}>
            More comments
          </button>
        </p>
      ) : null}
    </>
  );
}

// ---------- the list ----------

function ThreadList({
  items,
  noun,
  renderActions,
  renderReply,
}: {
  items: ReadonlyArray<Thread>;
  noun: string;
  renderActions?: (item: CommentData, isReply: boolean, openReply: () => void) => ReactNode;
  renderReply?: (thread: Thread, close: () => void) => ReactNode;
}) {
  if (items.length === 0) {
    return <p className="comments-empty">No comments on this {noun} yet.</p>;
  }
  return (
    <ol className="comment-list">
      {items.map((thread) => (
        <ThreadItem key={thread.commentId} thread={thread} renderActions={renderActions} renderReply={renderReply} />
      ))}
    </ol>
  );
}

function ThreadItem({
  thread,
  renderActions,
  renderReply,
}: {
  thread: Thread;
  renderActions?: (item: CommentData, isReply: boolean, openReply: () => void) => ReactNode;
  renderReply?: (thread: Thread, close: () => void) => ReactNode;
}) {
  const [replying, setReplying] = useState(false);
  const openReply = () => setReplying(true);
  return (
    <li>
      <CommentCard item={thread}>{renderActions?.(thread, false, openReply)}</CommentCard>
      {thread.replies.length > 0 || replying ? (
        <ol className="comment-replies">
          {thread.replies.map((reply) => (
            <li key={reply.commentId}>
              <CommentCard item={reply}>{renderActions?.(reply, true, openReply)}</CommentCard>
            </li>
          ))}
          {replying && renderReply ? <li>{renderReply(thread, () => setReplying(false))}</li> : null}
        </ol>
      ) : null}
    </li>
  );
}

/**
 * One Comment: author, time, "edited", the text (folded behind a button
 * when marked as a spoiler), and the author's notes on a held or hidden
 * one. A removed thread head is a bare "[removed]" placeholder.
 */
function CommentCard({ item, children }: { item: CommentData; children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (item.state === "removed") {
    return (
      <article className="comment-card is-removed">
        <p className="comment-removed">[removed]</p>
      </article>
    );
  }
  const folded = item.spoiler && !revealed && !item.own;
  return (
    <article className={`comment-card is-${item.state}${item.own ? " is-own" : ""}`}>
      <header className="comment-head">
        {item.username ? (
          <Link className="comment-author" to="/u/$username" params={{ username: item.username }}>
            @{item.username}
          </Link>
        ) : (
          <span className="comment-author">A former reader</span>
        )}
        <span className="comment-date">
          <When at={item.createdAt} />
          {item.edited ? " · edited" : ""}
        </span>
        {item.spoiler ? <span className="chip chip--spoiler">Spoilers</span> : null}
        {item.state === "pending" ? <span className="chip chip--pending">Awaiting review</span> : null}
      </header>
      {item.state === "hidden" ? (
        <p className="comment-note">Hidden by moderators. Only you can see that it is here.</p>
      ) : folded ? (
        <button type="button" className="btn btn-sm comment-reveal" onClick={() => setRevealed(true)}>
          Show spoiler
        </button>
      ) : (
        <p className="comment-body">{item.body}</p>
      )}
      {item.state === "pending" ? (
        <p className="comment-note">Only you can see this until a moderator approves it.</p>
      ) : null}
      {children}
    </article>
  );
}

// ---------- writing ----------

/** The new-comment form, or the prompt that stands in for it. */
function Composer({ targetId, noun }: { targetId: TargetId; noun: string }) {
  const viewer = useQuery(api.users.viewer, {});
  if (viewer === undefined) return null;
  if (viewer === null) {
    return (
      <p className="comment-prompt">
        <a href="/sign-in">Sign in to comment</a> on this {noun}.
      </p>
    );
  }
  if (viewer.needsUsername) {
    return (
      <p className="comment-prompt">
        <a href="/claim-username">Claim a username</a> to comment.
      </p>
    );
  }
  return <CommentForm targetId={targetId} noun={noun} />;
}

/**
 * Post a Comment (or a reply, with `parentId`), or edit one (`existing`).
 * A new post is tracked; a held one then shows in the list as awaiting
 * review.
 */
function CommentForm({
  targetId,
  parentId,
  existing,
  noun,
  onDone,
  onCancel,
}: (
  | { targetId: TargetId; parentId?: Id<"comments">; existing?: never }
  | { existing: CommentData; targetId?: never; parentId?: never }
) & {
  noun?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const post = useMutation(api.comments.post);
  const edit = useMutation(api.comments.edit);
  const [body, setBody] = useState(existing?.body ?? "");
  const [spoiler, setSpoiler] = useState(existing?.spoiler ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = body.trim().length;

  const submit = async () => {
    if (!targetId) {
      await edit({ commentId: existing.commentId, body, spoiler });
      return;
    }
    const result = await post({ target: targetId, body, spoiler, ...(parentId ? { parentId } : {}) });
    track("comment_posted", {
      target: targetId.kind,
      seriesId: result.seriesId,
      isReply: parentId !== undefined,
      held: result.held,
    });
    setBody("");
    setSpoiler(false);
  };

  const label = existing ? "Edit your comment" : parentId ? "Reply" : `Comment on this ${noun ?? "page"}`;
  return (
    <form
      className={`comment-form${parentId || existing ? " is-inline" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaving(true);
        submit()
          .then(() => onDone?.())
          .catch((err: unknown) => setError(writeErrorMessage(err)))
          .finally(() => setSaving(false));
      }}
    >
      <label className="review-field">
        <span className={parentId || existing ? "visually-hidden" : undefined}>{label}</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={parentId || existing ? 2 : 3}
          maxLength={MAX_LENGTH}
          aria-label={label}
          placeholder={parentId ? "Write a reply" : "Plain text; line breaks are kept."}
        />
      </label>
      <div className="review-form-row">
        <label className="review-spoiler">
          <input type="checkbox" checked={spoiler} onChange={(event) => setSpoiler(event.target.checked)} />
          Contains spoilers
        </label>
        <span className="review-count">
          {length.toLocaleString("en-US")} / {MAX_LENGTH.toLocaleString("en-US")}
        </span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="review-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={length === 0 || saving}>
          {existing ? "Save changes" : parentId ? "Post reply" : "Post comment"}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------- per-comment actions ----------

type Panel = "edit" | "delete" | "report" | "hide" | "remove" | null;

/**
 * What the viewer may do with one Comment: Reply (thread heads), Edit and
 * Delete (its author), Report (anyone else signed in), and Hide / Remove
 * (Moderators). One panel opens at a time under the Comment.
 */
function CommentActions({
  item,
  isReply,
  onReply,
}: {
  item: CommentData;
  isReply: boolean;
  onReply: () => void;
}) {
  const viewer = useQuery(api.users.viewer, {});
  const isModerator = useIsModerator();
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = () => setPanel(null);
  if (!viewer || viewer.needsUsername || item.state === "removed") return null;

  const editable = item.own && (item.state === "approved" || item.state === "pending");
  const buttons = [
    !isReply && item.state === "approved" ? { key: "reply", label: "Reply", onClick: onReply } : null,
    editable ? { key: "edit", label: "Edit", onClick: () => setPanel("edit") } : null,
    item.own ? { key: "delete", label: "Delete", onClick: () => setPanel("delete") } : null,
    !item.own && item.state === "approved" ? { key: "report", label: "Report", onClick: () => setPanel("report") } : null,
    isModerator && !item.own && item.state === "approved"
      ? { key: "hide", label: "Hide", onClick: () => setPanel("hide") }
      : null,
    isModerator && !item.own ? { key: "remove", label: "Remove", onClick: () => setPanel("remove") } : null,
  ].filter((button) => button !== null);

  return (
    <div className="comment-actions">
      {panel === null ? (
        <div className="comment-buttons">
          {buttons.map((button) => (
            <button key={button.key} type="button" className="comment-action" onClick={button.onClick}>
              {button.label}
            </button>
          ))}
          {notice ? <span className="comment-notice">{notice}</span> : null}
        </div>
      ) : null}
      {panel === "edit" ? (
        <CommentForm existing={item} onDone={close} onCancel={close} />
      ) : null}
      {panel === "delete" ? <DeleteOwn commentId={item.commentId} onCancel={close} /> : null}
      {panel === "report" ? (
        <ReportForm
          commentId={item.commentId}
          onCancel={close}
          onDone={() => {
            close();
            setNotice("Reported. Thanks, a moderator will look.");
          }}
        />
      ) : null}
      {panel === "hide" || panel === "remove" ? (
        <ModerateComment commentId={item.commentId} action={panel} onCancel={close} />
      ) : null}
    </div>
  );
}

function DeleteOwn({ commentId, onCancel }: { commentId: Id<"comments">; onCancel: () => void }) {
  const remove = useMutation(api.comments.remove);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="review-actions">
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={() => {
          setError(null);
          remove({ commentId }).catch((err: unknown) => setError(writeErrorMessage(err)));
        }}
      >
        Delete comment
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Keep it
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function ReportForm({
  commentId,
  onDone,
  onCancel,
}: {
  commentId: Id<"comments">;
  onDone: () => void;
  onCancel: () => void;
}) {
  const report = useMutation(api.comments.report);
  const [reason, setReason] = useState<ReportReason>("spam");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="comment-report"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        report({ commentId, reason, note: note.trim() || undefined })
          .then(onDone)
          .catch((err: unknown) => setError(writeErrorMessage(err)));
      }}
    >
      <label>
        <span className="visually-hidden">Reason</span>
        <select
          className="select"
          value={reason}
          onChange={(event) => setReason(event.target.value as ReportReason)}
        >
          {REPORT_REASONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <input
        className="review-mod-reason"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Anything the moderators should know (optional)"
        maxLength={NOTE_MAX}
      />
      <button type="submit" className="btn btn-sm btn-danger">
        Send report
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Cancel
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}

/** A Moderator's Hide or Remove, with an optional reason for the audit log. */
function ModerateComment({
  commentId,
  action,
  onCancel,
}: {
  commentId: Id<"comments">;
  action: "hide" | "remove";
  onCancel: () => void;
}) {
  const moderate = useMutation(api.comments.moderate);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="review-mod">
      <input
        className="review-mod-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional, kept in the audit log)"
        maxLength={500}
      />
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={() => {
          setError(null);
          moderate({ commentId, action, reason: reason.trim() || undefined }).catch((err: unknown) =>
            setError(writeErrorMessage(err)),
          );
        }}
      >
        {action === "hide" ? "Hide comment" : "Remove comment"}
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Cancel
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
