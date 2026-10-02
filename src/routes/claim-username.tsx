import {
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMutation } from "convex/react";
import { useState, type FormEvent } from "react";

import { api } from "../../convex/_generated/api";
import { mutationErrorMessage } from "~/lib/errors";
import { useReadyViewer } from "~/lib/viewer";
import { clerkEnabled, convexClient } from "~/providers";
import { ssrAuth } from "~/server/auth";

// Runs on the server for SSR and as an RPC on client navigations, so the
// gate holds both ways (spec §9).
const fetchSignedIn = createServerFn({ method: "GET" }).handler(
  async () => (await ssrAuth()).userId !== null,
);

/**
 * The forced first-sign-in step (ticket #26) and the username-change screen.
 * Claiming atomically creates the Convex User just in time (convex/users.ts);
 * changing releases the old name immediately. All policy — format, reserved
 * list, case-insensitive uniqueness — is enforced in the mutation; this form
 * just relays its ConvexError messages.
 */
export const Route = createFileRoute("/claim-username")({
  beforeLoad: async () => {
    if (clerkEnabled && !(await fetchSignedIn())) throw redirect({ href: "/sign-in" });
  },
  head: () => ({
    meta: [
      { title: "Choose a username — MangaDB" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ClaimUsernamePage,
});

function ClaimUsernamePage() {
  if (!clerkEnabled || !convexClient) {
    return (
      <main>
        <p className="notice">
          Accounts are not configured. Set the Clerk and Convex environment
          variables (see the README) to enable sign-in.
        </p>
      </main>
    );
  }
  return <ClaimForm />;
}

function ClaimForm() {
  const navigate = useNavigate();
  const viewer = useReadyViewer();
  const claimUsername = useMutation(api.users.claimUsername);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changing = viewer !== null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await claimUsername({ username });
      await navigate({ to: "/me" });
    } catch (err) {
      setError(mutationErrorMessage(err, "Could not claim that username. Try another."));
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-head">
          <h1>{changing ? "Change your username" : "Choose a username"}</h1>
          <p>
            {changing ? (
              <>
                You are currently <strong>@{viewer.username}</strong>. Your old
                name is released the moment the new one is claimed.
              </>
            ) : (
              "One last step. This is your name on MangaDB — it is how your public shelf is addressed."
            )}
          </p>
        </div>
        <div className="auth-panel">
          <form className="username-form" onSubmit={(e) => void submit(e)}>
            <label>
              Username
              <span className="at-field">
                <span aria-hidden="true">@</span>
                <input
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  autoFocus
                  required
                />
              </span>
              <span className="username-hint">
                3–20 characters: letters, digits and underscores.
              </span>
            </label>
            <button type="submit" disabled={busy || username.trim().length === 0}>
              {busy ? "Claiming…" : changing ? "Change username" : "Claim username"}
            </button>
            {error ? <p className="form-error">{error}</p> : null}
          </form>
        </div>
      </div>
    </main>
  );
}
