// Comments UI (CONTEXT.md: Comment): the "Comments" section near the foot of
// a Series or Volume page, rendered only while FEATURES.comments is on (the
// page decides; convex/lib/features.ts). The first page of threads is
// server-rendered from the page loader, then follows the live query (which,
// signed in, adds the viewer's own held and hidden Comments); "More
// comments" asks for another page's worth, up to COMMENT_POLICY.maxThreads.
// Threads are newest first with replies nested one level, oldest first; past
// the first few, "N more replies" loads the rest of a thread
// (comments.replies). Plain text: the body renders with its line breaks,
// nothing is parsed. Every action is re-checked on the server
// (convex/comments.ts).

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { COMMENT_POLICY } from "../../convex/comments";
import { track } from "~/lib/analytics";
import { useIsModerator, useReadyViewer } from "~/lib/viewer";
import { writeErrorMessage } from "~/lib/ratings";

/** A Comments page as pages know it: a Series or a Volume, never an Edition. */
type CommentTarget = FunctionArgs<typeof api.comments.list>["target"];
/** One page of a target's Comments, as the loader and the live query return it. */
export type CommentPage = NonNullable<FunctionReturnType<typeof api.comments.list>>;
type Thread = CommentPage["items"][number];
type CommentData = Omit<Thread, "replies" | "moreReplies">;
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
 * "volume"); `initial` is the loader's first page (null when the target is
 * gone).
 */
export function CommentsSection({
  target,
  initial,
  noun,
}: {
  target: CommentTarget;
  initial: CommentPage | null;
  noun: string;
}) {
  return (
    <section className="section comments">
      <div className="section-head">
        <h2 className="section-title">Comments</h2>
        <p className="section-note">Newest first · be kind, and mark spoilers</p>
      </div>
      <LiveComments target={target} initial={initial} noun={noun} />
    </section>
  );
}

function LiveComments({
  target,
  initial,
  noun,
}: {
  target: CommentTarget;
  initial: CommentPage | null;
  noun: string;
}) {
  const [limit, setLimit] = useState<number>(COMMENT_POLICY.page);
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
          <CommentForm
            targetId={page.target}
            parentId={thread.commentId}
            onDone={close}
            onCancel={close}
          />
        )}
        renderMoreReplies={(thread, fallback) => (
          <AllReplies target={target} thread={thread} fallback={fallback} />
        )}
      />
      {page.hasMore && limit < COMMENT_POLICY.maxThreads ? (
        <p className="comments-more">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              setLimit(Math.min(limit + COMMENT_POLICY.page, COMMENT_POLICY.maxThreads))
            }
          >
            More comments
          </button>
        </p>
      ) : null}
    </>
  );
}

// ---------- the list ----------

type ListRenderers = {
  renderActions?: (item: CommentData, isReply: boolean, openReply: () => void) => ReactNode;
  renderReply?: (thread: Thread, close: () => void) => ReactNode;
  /** A thread's full reply list once "N more replies" is pressed; `fallback` renders a reply list. */
  renderMoreReplies?: (
    thread: Thread,
    fallback: (replies: Thread["replies"]) => ReactNode,
  ) => ReactNode;
};

function ThreadList({
  items,
  noun,
  ...renderers
}: { items: ReadonlyArray<Thread>; noun: string } & ListRenderers) {
  if (items.length === 0) {
    return <p className="comments-empty">No comments on this {noun} yet.</p>;
  }
  return (
    <ol className="comment-list">
      {items.map((thread) => (
        <ThreadItem key={thread.commentId} thread={thread} {...renderers} />
      ))}
    </ol>
  );
}

function ThreadItem({
  thread,
  renderActions,
  renderReply,
  renderMoreReplies,
}: { thread: Thread } & ListRenderers) {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const openReply = () => setReplying(true);
  const replyItems = (replies: Thread["replies"]) =>
    replies.map((reply) => (
      <li key={reply.commentId}>
        <CommentCard item={reply}>{renderActions?.(reply, true, openReply)}</CommentCard>
      </li>
    ));
  const canExpand = renderMoreReplies !== undefined && thread.moreReplies > 0;
  return (
    <li>
      <CommentCard item={thread}>{renderActions?.(thread, false, openReply)}</CommentCard>
      {thread.replies.length > 0 || canExpand || replying ? (
        <ol className="comment-replies">
          {expanded && renderMoreReplies
            ? renderMoreReplies(thread, replyItems)
            : replyItems(thread.replies)}
          {canExpand && !expanded ? (
            <li>
              <button type="button" className="comment-action" onClick={() => setExpanded(true)}>
                {thread.moreReplies} more {thread.moreReplies === 1 ? "reply" : "replies"}
              </button>
            </li>
          ) : null}
          {replying && renderReply ? (
            <li>{renderReply(thread, () => setReplying(false))}</li>
          ) : null}
        </ol>
      ) : null}
    </li>
  );
}

/** Every visible reply to one thread, live; the inline ones until they arrive. */
function AllReplies({
  target,
  thread,
  fallback,
}: {
  target: CommentTarget;
  thread: Thread;
  fallback: (replies: Thread["replies"]) => ReactNode;
}) {
  const all = useQuery(api.comments.replies, { target, commentId: thread.commentId });
  return <>{fallback(all ?? thread.replies)}</>;
}

/**
 * One Comment: author, time, "edited", the text (folded behind a button
 * when marked as a spoiler), and the author's notes on a held or hidden
 * one. A thread head kept for its replies is a bare "[removed]" or
 * "[hidden]" placeholder.
 */
function CommentCard({ item, children }: { item: CommentData; children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (item.state === "removed" || item.state === "withheld") {
    return (
      <article className="comment-card is-removed">
        <p className="comment-removed">{item.state === "removed" ? "[removed]" : "[hidden]"}</p>
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
        {item.state === "pending" ? (
          <span className="chip chip--pending">Awaiting review</span>
        ) : null}
      </header>
      {item.state === "hidden" ? (
        <p className="comment-note">Hidden by moderators. Only you can see that it is here.</p>
      ) : folded ? (
        <button
          type="button"
          className="btn btn-sm comment-reveal"
          onClick={() => setRevealed(true)}
        >
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
    const result = await post({
      target: targetId,
      body,
      spoiler,
      ...(parentId ? { parentId } : {}),
    });
    track("comment_posted", {
      target: targetId.kind,
      seriesId: result.seriesId,
      isReply: parentId !== undefined,
      held: result.held,
    });
    setBody("");
    setSpoiler(false);
  };

  const label = existing
    ? "Edit your comment"
    : parentId
      ? "Reply"
      : `Comment on this ${noun ?? "page"}`;
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
          maxLength={COMMENT_POLICY.maxLength}
          aria-label={label}
          placeholder={parentId ? "Write a reply" : "Plain text; line breaks are kept."}
        />
      </label>
      <div className="review-form-row">
        <label className="review-spoiler">
          <input
            type="checkbox"
            checked={spoiler}
            onChange={(event) => setSpoiler(event.target.checked)}
          />
          Contains spoilers
        </label>
        <span className="review-count">
          {length.toLocaleString("en-US")} / {COMMENT_POLICY.maxLength.toLocaleString("en-US")}
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
  const viewer = useReadyViewer();
  const isModerator = useIsModerator();
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = () => setPanel(null);
  if (!viewer || item.state === "removed" || item.state === "withheld") return null;

  const editable = item.own && (item.state === "approved" || item.state === "pending");
  const buttons = [
    !isReply && item.state === "approved"
      ? { key: "reply", label: "Reply", onClick: onReply }
      : null,
    editable ? { key: "edit", label: "Edit", onClick: () => setPanel("edit") } : null,
    item.own ? { key: "delete", label: "Delete", onClick: () => setPanel("delete") } : null,
    !item.own && item.state === "approved"
      ? { key: "report", label: "Report", onClick: () => setPanel("report") }
      : null,
    isModerator && !item.own && item.state === "approved"
      ? { key: "hide", label: "Hide", onClick: () => setPanel("hide") }
      : null,
    isModerator && !item.own
      ? { key: "remove", label: "Remove", onClick: () => setPanel("remove") }
      : null,
  ].filter((button) => button !== null);

  return (
    <div className="comment-actions">
      {panel === null ? (
        <div className="comment-buttons">
          {buttons.map((button) => (
            <button
              key={button.key}
              type="button"
              className="comment-action"
              onClick={button.onClick}
            >
              {button.label}
            </button>
          ))}
          {notice ? <span className="comment-notice">{notice}</span> : null}
        </div>
      ) : null}
      {panel === "edit" ? <CommentForm existing={item} onDone={close} onCancel={close} /> : null}
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
        maxLength={COMMENT_POLICY.noteMaxLength}
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
          moderate({ commentId, action, reason: reason.trim() || undefined }).catch(
            (err: unknown) => setError(writeErrorMessage(err)),
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
