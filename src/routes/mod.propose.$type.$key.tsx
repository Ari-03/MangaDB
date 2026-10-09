import { createFileRoute, Link } from "@tanstack/react-router";

import { isRecordType } from "~/lib/editForm";
import { ModGate } from "~/lib/moderation";
import { ProposeForm } from "~/lib/proposeForm";

/**
 * The Editor update-proposal form (spec §5), lib/proposeForm.tsx in its
 * "propose" mode: field changes and Human Override clears become a Draft
 * Proposal that a Moderator reviews. Auth-gated client-side for UX; the
 * Convex functions re-check the role on every call. Never indexed.
 */
export const Route = createFileRoute("/mod/propose/$type/$key")({
  head: () => ({ meta: [{ title: "Propose a change — MangaDB" }] }),
  component: ModProposePage,
});

function ModProposePage() {
  const { type, key } = Route.useParams();
  if (!isRecordType(type)) {
    return (
      <main className="mod-page">
        <h1>Unknown record type</h1>
        <p className="notice">
          Nothing proposable lives at this address. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }
  return (
    <ModGate role="dataTeam" refusal="Proposing changes needs an Editor (or stronger) role.">
      <ProposeForm type={type} editKey={key} mode="propose" />
    </ModGate>
  );
}
