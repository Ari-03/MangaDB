import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { MyReading } from "~/lib/reading";
import { convexClient } from "~/providers";

export const Route = createFileRoute("/me/")({
  component: MePage,
});

function MePage() {
  const { viewerState } = Route.useRouteContext();

  if (viewerState.status !== "ready") {
    // Only "unconfigured" reaches the component; the /me gate redirects the
    // signed-out and username-pending states.
    return (
      <main>
        <p className="notice">
          Accounts are not configured. Set the Clerk and Convex environment
          variables (see the README) to enable sign-in and personal tracking.
        </p>
      </main>
    );
  }

  const { viewer } = viewerState;
  return (
    <main>
      <h1>@{viewer.username}</h1>
      <p className="tagline">Your library.</p>

      <section className="me-section">
        <h2>Collection</h2>
        <p className="placeholder">
          Volumes you own, want, or have ordered will appear here.
        </p>
      </section>
      <section className="me-section">
        <h2>Reading</h2>
        {/* Reading tracking (#28): chosen statuses and active passes. */}
        <MyReading />
      </section>
      <section className="me-section">
        <h2>Upcoming</h2>
        <p className="placeholder">
          Release dates for series you follow will appear here.
        </p>
      </section>

      <section className="me-section">
        <h2>Account</h2>
        <p>
          Username: <strong>@{viewer.username}</strong>{" "}
          <Link to="/claim-username">Change</Link>
        </p>
        <DeleteAccount />
      </section>
    </main>
  );
}

/**
 * MangaDB-initiated account deletion (spec §9): one Convex action removes the
 * Clerk identity and every MangaDB record, then the local session is dropped.
 */
function DeleteAccount() {
  const clerk = useClerk();
  const navigate = useNavigate();
  const deleteAccount = useAction(api.users.deleteAccount);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!convexClient) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount({});
      // The Clerk user is gone; clear the local session and leave.
      await clerk.signOut();
      await navigate({ to: "/" });
    } catch {
      setError("Account deletion failed. Nothing was removed — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="danger-zone">
      {confirming ? (
        <>
          <p>
            This permanently deletes your sign-in and everything MangaDB knows
            about you — collection, reading history, follows. There is no undo.
          </p>
          <button type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Deleting…" : "Yes, delete everything"}
          </button>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          Delete account…
        </button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
