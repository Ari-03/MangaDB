import { ClerkProvider, UserButton, useAuth } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

// Client-side wiring (spec §9): <ClerkProvider> owns the session,
// ConvexProviderWithClerk feeds its "convex"-template JWT to the reactive
// Convex client so every mutation/query authorizes via
// ctx.auth.getUserIdentity(). Both are optional at runtime: without the
// publishable key or a Convex URL the public catalog still renders.

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
export const convexClient: ConvexReactClient | null = convexUrl
  ? new ConvexReactClient(convexUrl)
  : null;

// ClerkProvider resolves the key from VITE_CLERK_PUBLISHABLE_KEY itself; this
// flag only decides whether the Clerk tree is mounted at all.
export const clerkEnabled = Boolean(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

export function AppProviders({ children }: { children: ReactNode }) {
  if (!clerkEnabled) {
    return convexClient ? (
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    ) : (
      <>{children}</>
    );
  }
  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
      {convexClient ? (
        <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
          {children}
        </ConvexProviderWithClerk>
      ) : (
        children
      )}
    </ClerkProvider>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link to="/" className="site-name">
        MangaDB
      </Link>
      {clerkEnabled ? <AuthNav /> : null}
    </header>
  );
}

function AuthNav() {
  // Inside <ClerkProvider> whenever clerkEnabled; SSR state comes from
  // clerkMiddleware via the provider.
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <nav />;
  return (
    <nav>
      {isSignedIn ? (
        <>
          <Link to="/me">My library</Link>
          <UserButton />
        </>
      ) : (
        <a href="/sign-in">Sign in</a>
      )}
    </nav>
  );
}
