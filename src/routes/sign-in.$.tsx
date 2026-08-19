import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { clerkEnabled } from "~/providers";

// Clerk-hosted UI with path routing; the splat also matches bare /sign-in.
// Google OAuth and email/password are enabled per-instance in the Clerk
// dashboard (spec §9). New accounts land on /me, which forces the username
// claim before anything personal renders.
export const Route = createFileRoute("/sign-in/$")({
  head: () => ({
    meta: [
      { title: "Sign in — MangaDB" },
      // Auth pages are never indexed (spec §11).
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SignInPage,
});

function SignInPage() {
  if (!clerkEnabled) {
    return (
      <main>
        <p className="notice">
          Sign-in is not configured. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code>{" "}
          and <code>CLERK_SECRET_KEY</code> (see the README) to enable Clerk.
        </p>
      </main>
    );
  }
  return (
    <main className="auth-page">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/me"
      />
    </main>
  );
}
