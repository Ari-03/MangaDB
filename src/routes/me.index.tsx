import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useState } from "react";

import { api } from "../../convex/_generated/api";
import { MyCollection } from "~/lib/collection";
import { MyUpcoming } from "~/lib/follows";
import { MyReading } from "~/lib/reading";
import { SharingSettings } from "~/lib/sharing";
import { convexClient } from "~/providers";

export const Route = createFileRoute("/me/")({
  component: MePage,
});

/**
 * /me — the viewer's own shelf. Five sections in the order the shelf is
 * used: what you have, what you are reading, what is coming, who can see it,
 * and the account itself. Each section mounts the slice that owns it; this
 * page only frames them.
 */
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
    <main className="me-page">
      <div className="acct-head">
        <h1 className="acct-title">Your library</h1>
        <p className="acct-kicker">
          Everything @{viewer.username} owns, is reading, and is waiting for.
          Private until you choose to share it.
        </p>
      </div>

      <section className="me-section">
        <div className="section-head">
          <h2 className="section-title">Collection</h2>
          <p className="section-note">Wanted, ordered and owned</p>
        </div>
        {/* Personal collection (#27): entries grouped by state. */}
        <MyCollection />
      </section>

      <section className="me-section">
        <div className="section-head">
          <h2 className="section-title">Reading</h2>
          <p className="section-note">Series statuses and active passes</p>
        </div>
        {/* Reading tracking (#28): chosen statuses and active passes. */}
        <MyReading />
      </section>

      <section className="me-section">
        <div className="section-head">
          <h2 className="section-title">Upcoming</h2>
          <p className="section-note">Announced releases, nearest first</p>
        </div>
        {/* My Upcoming Releases (#29): followed Series matching the format
            preference + every future Wanted/Ordered Release and Bundle,
            deduplicated, Owned excluded, computed live. */}
        <MyUpcoming />
      </section>

      <section className="me-section">
        <div className="section-head">
          <h2 className="section-title">Sharing</h2>
        </div>
        <div className="acct-panel">
          {/* Tracking visibility (#30): separate Ownership/Reading defaults,
              private until explicitly opened, plus the public-profile link. */}
          <SharingSettings />
        </div>
      </section>

      <section className="me-section">
        <div className="section-head">
          <h2 className="section-title">Account</h2>
        </div>
        <div className="acct-panel">
          <p className="acct-account-row">
            Signed in as{" "}
            <span className="acct-handle">@{viewer.username}</span>
            <Link to="/claim-username">Change username</Link>
          </p>
          <DeleteAccount />
        </div>
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
          <div className="danger-actions">
            <button type="button" disabled={busy} onClick={() => void run()}>
              {busy ? "Deleting…" : "Yes, delete everything"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep my account
            </button>
          </div>
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
