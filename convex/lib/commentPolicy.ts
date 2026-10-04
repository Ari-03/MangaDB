// The Comment hold rules and limits (CONTEXT.md: Comment), shared by the
// server (convex/comments.ts enforces them) and the browser (src/lib/
// comments.tsx sizes its pages and text boxes by them). Data only: the
// browser bundles this file, so it must not import server code
// (src/clientImports.test.ts checks).

const DAY = 24 * 60 * 60 * 1000;

/** Hold rules, the auto-hide threshold, and the size limits in one place. */
export const COMMENT_POLICY = {
  /** Accounts younger than this post into the queue. */
  minAccountAgeMs: 7 * DAY,
  /** Authors with fewer approved Comments than this post into the queue. */
  minApprovedComments: 3,
  /** Bodies with more `http(s)://` links than this go to the queue. */
  maxLinks: 2,
  /** Distinct reports that hide an approved Comment. */
  autoHideReports: 3,
  maxLength: 2000,
  noteMaxLength: 500,
  /** Top-level Comments per page; "more" asks for another page's worth. */
  page: 20,
  /** The most top-level Comments one `list` call returns; "More comments" stops there. */
  maxThreads: 60,
  /** Replies shown under a thread before "N more replies" (the `replies` query). */
  inlineReplies: 5,
} as const;
