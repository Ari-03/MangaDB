import {
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState, type FormEvent } from "react";

import { api } from "../../convex/_generated/api";
import { clerkEnabled, convexClient } from "~/providers";

/**
 * The forced first-sign-in step (ticket #26) and the username-change screen.
 * Claiming atomically creates the Convex User just in time (convex/users.ts);
 * changing releases the old name immediately. All policy — format, reserved
 * list, case-insensitive uniqueness — is enforced in the mutation; this form
 * just relays its ConvexError messages.
 */
export const Route = createFileRoute("/claim-username")({
  beforeLoad: ({ context }) => {
    if (clerkEnabled && !context.userId) throw redirect({ href: "/sign-in" });
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
  const viewer = useQuery(api.users.viewer);
  const claimUsername = useMutation(api.users.claimUsername);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changing = viewer != null && !viewer.needsUsername;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await claimUsername({ username });
      await navigate({ to: "/me" });
    } catch (err) {
      setError(
        err instanceof ConvexError && typeof err.data?.message === "string"
          ? err.data.message
          : "Could not claim that username. Try another.",
      );
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>{changing ? "Change your username" : "Choose a username"}</h1>
      <p className="tagline">
        {changing ? (
          <>
            You are currently <strong>@{viewer.username}</strong>. Your old
            name is released the moment the new one is claimed.
          </>
        ) : (
          "One last step: your public name on MangaDB. 3–20 characters — letters, digits, underscores."
        )}
      </p>
      <form className="username-form" onSubmit={(e) => void submit(e)}>
        <label>
          Username
          <input
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            autoFocus
            required
          />
        </label>
        <button type="submit" disabled={busy || username.trim().length === 0}>
          {busy ? "Claiming…" : changing ? "Change username" : "Claim username"}
        </button>
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </main>
  );
}
