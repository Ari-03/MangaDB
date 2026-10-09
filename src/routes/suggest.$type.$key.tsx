import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { RecordType } from "../../convex/lib/moderationFields";
import { isRecordType } from "~/lib/editForm";
import { ProposeForm } from "~/lib/proposeForm";
import { useIsDataTeam, useViewerQuery } from "~/lib/viewer";

/**
 * A reader's Suggestion form: lib/proposeForm.tsx in its "suggest" mode,
 * in the site's ordinary page frame. Any signed-in User with a username
 * suggests field changes, covers included, to one record; a Moderator
 * reviews each before it changes the page (convex/proposals.ts). Signed
 * out, it asks for a sign-in that comes back here. `?draft=` resumes one
 * of the viewer's own Suggestions while it is a Draft, such as one sent
 * back for changes. Data Team members may use it too; their usual form is
 * /mod/propose, and a Draft they wrote on the Data Team is revised from
 * its proposal page, not here. Never indexed.
 */
export const Route = createFileRoute("/suggest/$type/$key")({
  validateSearch: (search: Record<string, unknown>): { draft?: string } =>
    typeof search.draft === "string" ? { draft: search.draft } : {},
  head: () => ({
    meta: [{ title: "Suggest a change — MangaDB" }, { name: "robots", content: "noindex" }],
  }),
  component: SuggestPage,
});

function SuggestPage() {
  const { type, key } = Route.useParams();
  const { draft } = Route.useSearch();
  const viewer = useViewerQuery(api.users.viewer);
  if (!isRecordType(type)) {
    return (
      <main className="mod-page suggest-page">
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing to suggest a change to lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  if (viewer === undefined) {
    return (
      <main className="mod-page suggest-page">
        <p className="notice">Loading…</p>
      </main>
    );
  }
  if (viewer === null) return <SignInFirst />;
  if (viewer.needsUsername) {
    return (
      <main className="mod-page suggest-page">
        <h1>Suggest a change</h1>
        <p className="notice">
          Your suggestions are signed with your username.{" "}
          <Link to="/claim-username">Claim a username</Link> first, then come back to this page.
        </p>
      </main>
    );
  }
  if (draft) return <ResumeDraft type={type} editKey={key} draftId={draft} />;
  return <ProposeForm type={type} editKey={key} mode="suggest" />;
}

/** Signed out: what this page is for, and a sign-in that returns here. */
function SignInFirst() {
  const here = useLocation().href;
  const back = `redirect_url=${encodeURIComponent(here)}`;
  return (
    <main className="mod-page suggest-page">
      <h1>Suggest a change</h1>
      <p className="section-hint">
        Spotted a wrong date, a missing cover or a better description? Sign in to suggest the fix. A
        Moderator reviews every suggestion before it changes the page.
      </p>
      <div className="mod-actions suggest-signin">
        <a className="btn btn-primary" href={`/sign-in?${back}`}>
          Sign in
        </a>
        <a className="btn" href={`/sign-up?${back}`}>
          Create an account
        </a>
      </div>
    </main>
  );
}

/** The form resuming one of the viewer's own Drafts, once it has loaded. */
function ResumeDraft({
  type,
  editKey,
  draftId,
}: {
  type: RecordType;
  editKey: string;
  draftId: string;
}) {
  const own = useQuery(api.suggestions.detail, { proposalId: draftId });
  const team = useIsDataTeam();
  if (own === undefined) {
    return (
      <main className="mod-page suggest-page">
        <p className="notice">Loading your draft…</p>
      </main>
    );
  }
  if (own === null || own.state !== "draft") {
    return (
      <main className="mod-page suggest-page">
        <h1>Suggest a change</h1>
        <p className="notice">
          {own === null
            ? "That draft is not one of your suggestions."
            : "That suggestion is no longer a draft, so it cannot be revised."}{" "}
          {own === null && team ? (
            <>
              A draft you wrote on the Data Team opens on{" "}
              <Link to="/mod/proposal/$id" params={{ id: draftId }}>
                its proposal page
              </Link>
              .{" "}
            </>
          ) : null}
          <Link to="/suggest/$type/$key" params={{ type, key: editKey }}>
            Start a new suggestion
          </Link>
          .
        </p>
      </main>
    );
  }
  return <ProposeForm type={type} editKey={editKey} mode="suggest" resume={own} />;
}
