import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { clerkEnabled } from "~/providers";

// See sign-in.$.tsx; email addresses are verified by Clerk before the session
// exists (spec §9: verified email/password). /me then forces the username claim.
export const Route = createFileRoute("/sign-up/$")({
  head: () => ({
    meta: [
      { title: "Sign up — MangaDB" },
      // Auth pages are never indexed (spec §11).
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  if (!clerkEnabled) {
    return (
      <main>
        <p className="notice">
          Sign-up is not configured. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code>{" "}
          and <code>CLERK_SECRET_KEY</code> (see the README) to enable Clerk.
        </p>
      </main>
    );
  }
  return (
    <main className="auth-page">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/me"
      />
    </main>
  );
}
